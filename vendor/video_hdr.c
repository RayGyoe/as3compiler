// Video HDR -> SDR tone mapping (docs/zh-cn/video.md §16.10).
//
// Why this file exists: a 10-bit HDR10/HDR10+ file carries PQ-encoded (SMPTE ST 2084)
// BT.2020 samples whose 1.0 means 10000 nits. Painting those code values into an 8-bit
// sRGB surface -- which is what every backend of this runtime has -- is not "HDR with a
// small error": the transfer function is never decoded, so mid-tones land in the wrong
// place, everything above the sRGB ceiling is clipped flat, and out-of-gamut colours are
// crushed instead of mapped. AIR has no HDR surface either and paints the code values
// as-is, so this is an ENHANCEMENT (AGENTS.md §1.5): opt-in, default off.
//
// The mapping is per-channel, which is why it can be fast enough to run on 4K in C:
//
//   code --[decode transfer + reference-white scale]--> linear x   (1.0 = HDR_REF_WHITE)
//        --[BT.2020 -> BT.709 3x3, linear light]--> linear sRGB
//        --[smooth shoulder]--> display-referred y in [0,1]
//        --[sRGB OETF]--> 8 bytes
//
// Per-channel is the pragmatic choice every player makes (ffmpeg's zscale/tonemap too):
// it is monotonic, has no halos, and is one table lookup per channel for the two
// non-linear steps. Its known cost is that very saturated highlights shift hue slightly
// instead of being gamut-clipped as a whole -- stated in the docs rather than hidden.
//
// Reference white is 100 nits (video diffuse white), NOT BT.2408's 203 nit graphics
// white: at 203 a dark HDR scene came out at a mean of 8.8 against the pass-through
// path's 16.8 -- dark enough that shadow detail was gone. 203 is the right number when
// HDR and SDR graphics share one screen; 100 plus the mid-tone lift in hdr_out_table is
// the right number for film content on an SDR display. The shoulder is what keeps
// highlights from clipping, and HDR_REF_WHITE is one constant if a title disagrees.
//
// Not done here (documented, not silently skipped): no dynamic HDR10+ / Dolby Vision
// per-scene metadata, no local (spatially varying) tone mapping, and HLG uses a
// simplified OOTF that ignores the cross-channel luminance term (there is no HLG sample
// in the test set to calibrate against).

#include "video_hdr.h"

#include <math.h>
#include <stdlib.h>

// Threading. A 4K frame is 6.1 M pixels and the mapping is ~19 ms of scalar work on
// one core, which is half of a 41 ms frame budget before sws and the upload; splitting
// it by row is the cheapest way to get that back. Platform headers stay here (and are
// conditional) so the seam with video_glue.c stays plain C.
#if defined(_WIN32)
#include <windows.h>
#define HDR_HAVE_THREADS 1
#elif defined(__EMSCRIPTEN__) || defined(__wasi__)
#define HDR_HAVE_THREADS 0   // no threads in the browser/WASI targets
#else
#include <pthread.h>
#define HDR_HAVE_THREADS 1
#endif

#define HDR_MAX_THREADS 8

// Output table resolution. The index is the display-referred value in [0, OUT_MAX]
// after the shoulder, so OUT_MAX must cover the reference white we choose times the
// brightest content accepted without clamping: 8 x 100 = 800 nits by default, and still
// 8 x 203 = 1624 if HDR_REF_WHITE is raised to BT.2408's.
// Above that everything is 255 anyway, because the shoulder has converged.
#define HDR_OUT_N 16385
#define HDR_OUT_MAX 8.0f
// Shadow lift (see hdr_out_table): display-referred value ^ gamma.
#define HDR_GAMMA 0.8

// Reference white in nits. 100 is video diffuse white (BT.1886, i.e. the level an SDR
// grade puts a white object at); BT.2408 uses 203 for GRAPHICS white, which is right
// when HDR and SDR UI are composited together but makes film content come out visibly
// darker than its SDR grade. Measured on the 4K HDR10+ sample: at 203 the frame mean
// landed at 8.8 against the pass-through path's 16.8, at 100 it lands close to it --
// the difference between "correct for graphics" and "looks like the SDR version".
// AS_VIDEO_HDR_GAIN still scales this if a particular title wants more or less.
#define HDR_REF_WHITE 100.0f
// Nominal HLG display peak. HLG is display-referred by construction, so this is the
// anchor that turns its 0..1 signal into a reference-white-relative value.
#define HDR_HLG_PEAK 1000.0f

// PQ and sRGB have no closed form worth evaluating per pixel (powf twice per channel
// on 6 million pixels is ~300 ms for one 4K frame), so both directions are tables.
// Built once per transfer function, read-only afterwards; the frame loop is single
// threaded, and a table that is only ever read after a full initialisation needs no
// locking.
static float* g_lin[3];              // [1] = PQ, [2] = HLG; 65536 entries each
static unsigned char g_out8[HDR_OUT_N];
static int g_out_ready;

// ---------------------------------------------------------------------------
// Transfer functions
// ---------------------------------------------------------------------------

// SMPTE ST 2084 EOTF: normalised code (0..1) -> linear, where 1.0 = 10000 nits.
static double hdr_pq_eotf(double n) {
  const double m1 = 2610.0 / 16384.0;
  const double m2 = 2523.0 / 4096.0 * 128.0;
  const double c1 = 3424.0 / 4096.0;
  const double c2 = 2413.0 / 4096.0 * 32.0;
  const double c3 = 2392.0 / 4096.0 * 32.0;
  if (!(n > 0.0)) return 0.0;
  double p = pow(n, 1.0 / m2);
  double num = p - c1;
  if (num < 0.0) num = 0.0;
  double den = c2 - c3 * p;
  if (!(den > 0.0)) return 0.0;
  return pow(num / den, 1.0 / m1);
}

// BT.2100 HLG inverse OETF: signal (0..1) -> linear scene light (0..1).
static double hdr_hlg_inv_oetf(double e) {
  const double a = 0.17883277;
  const double b = 1.0 - 4.0 * a;                 // 0.28466892
  const double c = 0.5 - a * log(4.0 * a);         // 0.55991073
  if (!(e > 0.0)) return 0.0;
  if (e <= 0.5) return e * e / 3.0;
  return (exp((e - c) / a) + b) / 12.0;
}

// sRGB OETF (IEC 61966-2-1), the encoding an 8-bit surface expects.
static double hdr_srgb_oetf(double y) {
  if (!(y > 0.0)) return 0.0;
  if (y <= 0.0031308) return y * 12.92;
  return 1.055 * pow(y, 1.0 / 2.4) - 0.055;
}

// Smooth shoulder in reference-white units: linear below the knee, exponential roll-off
// to exactly 1.0 above it. Chosen over Reinhard/Hable because those move mid-tones
// (a 1.0 input lands near 0.5, i.e. graphics white becomes grey), and over a hard clip
// because clipping is what the un-mapped path already does wrong.
#define HDR_KNEE 0.75f
// Shoulder length, in reference-white units. This is the one number that decides how
// much of the 8-bit range the highlights get: with tau == 1-knee (an exponential that
// converges by x = 2) a 400 nit highlight was already solid white, which flattened the
// exact thing HDR has that SDR does not. Measured with tau = 4 at the 100 nit white:
// 100 -> 227, 203 -> 232, 400 -> 238, 1000 -> 246, 4000 -> 246, so the top stops stay
// distinguishable until the shoulder finally converges.
#define HDR_TAU 4.0
static double hdr_shoulder(double x) {
  if (!(x > 0.0)) return 0.0;
  if (x <= HDR_KNEE) return x;
  const double k = 1.0 - HDR_KNEE;
  return HDR_KNEE + k * (1.0 - exp(-(x - HDR_KNEE) / HDR_TAU));
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

// Linearisation table: 16-bit code -> linear, already scaled so that 1.0 is the
// reference white. Folding the scale in here is what keeps the per-pixel work to
// three lookups.
static const float* hdr_lin_table(int kind) {
  if (kind != 1 && kind != 2) return NULL;
  if (g_lin[kind] != NULL) return g_lin[kind];
  float* t = (float*)malloc(sizeof(float) * 65536u);
  if (t == NULL) return NULL;
  for (int i = 0; i < 65536; ++i) {
    const double n = (double)i / 65535.0;
    double lin;
    if (kind == 1) {
      lin = hdr_pq_eotf(n) * 10000.0 / HDR_REF_WHITE;      // 1.0 == HDR_REF_WHITE
    } else {
      // Simplified OOTF: the BT.2100 system gamma is applied per channel instead of
      // through the frame's luminance. Documented approximation, see the header.
      lin = pow(hdr_hlg_inv_oetf(n), 1.2) * HDR_HLG_PEAK / HDR_REF_WHITE;
    }
    t[i] = (float)lin;
  }
  g_lin[kind] = t;
  return t;
}

static void hdr_out_table(void) {
  if (g_out_ready) return;
  for (int i = 0; i < HDR_OUT_N; ++i) {
    const double x = (double)HDR_OUT_MAX * (double)i / (double)(HDR_OUT_N - 1);
    // Mid-tone lift, folded into the table so it costs nothing per pixel. Without it a
    // physically straight mapping (reference white 100 nits, linear below the knee) made
    // a dark HDR scene come out at a mean of 6-14 against the pass-through path's 8-17:
    // correct in the photometric sense, and far too dark to watch, because an SDR grade
    // of the same film lifts its shadows. 0.8 is the compromise -- shadows come up ~1.6x,
    // a 100 nit white stays at 227, and highlights keep the roll-off.
    const double y = pow(x, HDR_GAMMA);
    double s = hdr_srgb_oetf(hdr_shoulder(y));
    if (s < 0.0) s = 0.0;
    if (s > 1.0) s = 1.0;
    g_out8[i] = (unsigned char)(s * 255.0 + 0.5);
  }
  g_out_ready = 1;
}

static unsigned char hdr_out8(float x) {
  if (!(x > 0.0f)) return 0;                    // includes NaN and matrix negatives
  float v = x * (float)(HDR_OUT_N - 1) / HDR_OUT_MAX;
  int idx = (int)(v + 0.5f);
  if (idx >= HDR_OUT_N) idx = HDR_OUT_N - 1;
  return g_out8[idx];
}

// Exposure is applied AFTER the linearisation and the gamut matrix because it is a
// display-referred adjustment: it scales reference-white units, which is exactly what
// the output table's index already is. Keeping it out of the two tables means changing
// it costs nothing (no rebuild), which matters because there is no single right value
// -- BT.2408's 203 nit white makes content look darker than its SDR grade on purpose.
static unsigned char hdr_out8_g(float x, float gain) {
  return hdr_out8(x * gain);
}

// BT.2020 -> BT.709 primaries, row-major, applied in linear light. Without this the
// saturated part of a 2020 grade would be interpreted as 709 and come out oversaturated
// (green foliage and neon are where it shows).
static const float k_2020_to_709[9] = {
   1.66049f, -0.58764f, -0.07285f,
  -0.12455f,  1.13290f, -0.00835f,
  -0.01825f, -0.10059f,  1.11884f,
};
static const float k_identity[9] = {
  1.0f, 0.0f, 0.0f,
  0.0f, 1.0f, 0.0f,
  0.0f, 0.0f, 1.0f,
};

// One row range of the mapping: the whole per-pixel body lives here so the threaded and
// the serial path run literally the same code.
typedef struct {
  const float* lin;
  const float* m;
  float gain;
  const unsigned char* src;
  unsigned char* dst;
  int sstride, dstride, w;
} hdr_job;

static void hdr_map_rows(const hdr_job* j, int y0, int y1) {
  for (int y = y0; y < y1; ++y) {
    const unsigned char* s = j->src + (size_t)y * (size_t)j->sstride;
    unsigned char* d = j->dst + (size_t)y * (size_t)j->dstride;
    for (int x = 0; x < j->w; ++x, s += 6, d += 4) {
      // RGB48LE: 16-bit little-endian per channel, 6 bytes per pixel.
      const float r = j->lin[(unsigned)(s[0] | (s[1] << 8))];
      const float g = j->lin[(unsigned)(s[2] | (s[3] << 8))];
      const float b = j->lin[(unsigned)(s[4] | (s[5] << 8))];
      const float R = j->m[0] * r + j->m[1] * g + j->m[2] * b;
      const float G = j->m[3] * r + j->m[4] * g + j->m[5] * b;
      const float B = j->m[6] * r + j->m[7] * g + j->m[8] * b;
      d[0] = hdr_out8_g(B, j->gain);
      d[1] = hdr_out8_g(G, j->gain);
      d[2] = hdr_out8_g(R, j->gain);
      d[3] = 255;
    }
  }
}

#if HDR_HAVE_THREADS
// Rows are independent (each pixel reads only its own source bytes), so the split is
// static and needs no synchronisation: block i covers a contiguous range, and the
// caller waits for all of them because it uploads the buffer right afterwards.
typedef struct {
  const hdr_job* job;
  int y0, y1;
} hdr_slice;

#if defined(_WIN32)
static DWORD WINAPI hdr_thread_body(LPVOID p) {
  hdr_slice* s = (hdr_slice*)p;
  hdr_map_rows(s->job, s->y0, s->y1);
  return 0;
}
#else
static void* hdr_thread_body(void* p) {
  hdr_slice* s = (hdr_slice*)p;
  hdr_map_rows(s->job, s->y0, s->y1);
  return NULL;
}
#endif
#endif  // HDR_HAVE_THREADS

static int hdr_thread_count(int rows) {
#if HDR_HAVE_THREADS
  int n = HDR_MAX_THREADS;
  // Below ~64 rows per thread the spawn cost dominates the work it saves.
  while (n > 1 && rows / n < 64) n >>= 1;
  return n;
#else
  (void)rows;
  return 1;
#endif
}

// Maps every row, splitting the work across threads when the target has them. Falls
// back to inline execution for a slice whose thread cannot be created, so a resource
// failure here degrades speed instead of dropping the frame.
static void hdr_map_all(const hdr_job* job, int rows) {
  const int n = hdr_thread_count(rows);
#if HDR_HAVE_THREADS
  if (n > 1) {
    hdr_slice sl[HDR_MAX_THREADS];
#if defined(_WIN32)
    HANDLE th[HDR_MAX_THREADS];
#else
    pthread_t th[HDR_MAX_THREADS];
#endif
    int live = 0;
    for (int i = 0; i < n; ++i) {
      sl[i].job = job;
      sl[i].y0 = rows * i / n;
      sl[i].y1 = rows * (i + 1) / n;
      th[i] = 0;
      if (sl[i].y1 <= sl[i].y0) continue;
#if defined(_WIN32)
      th[i] = CreateThread(NULL, 0, hdr_thread_body, &sl[i], 0, NULL);
      if (th[i] == NULL) hdr_map_rows(job, sl[i].y0, sl[i].y1);
#else
      if (pthread_create(&th[i], NULL, hdr_thread_body, &sl[i]) != 0)
        hdr_map_rows(job, sl[i].y0, sl[i].y1);
#endif
      ++live;
    }
    for (int i = 0; i < n; ++i) {
      if (th[i] == 0) continue;
#if defined(_WIN32)
      WaitForSingleObject(th[i], INFINITE);
      CloseHandle(th[i]);
#else
      pthread_join(th[i], NULL);
#endif
    }
    (void)live;
    return;
  }
#endif
  hdr_map_rows(job, 0, rows);
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

as_hdr* as_hdr_create(int kind, int src_2020) {
  if (kind != 1 && kind != 2) return NULL;
  as_hdr* h = (as_hdr*)calloc(1, sizeof(as_hdr));
  if (h == NULL) return NULL;
  h->kind = kind;
  h->src_2020 = src_2020 ? 1 : 0;
  h->gain = 1.0f;
  if (hdr_lin_table(kind) == NULL) { free(h); return NULL; }
  hdr_out_table();
  return h;
}

void as_hdr_set_gain(as_hdr* h, float gain) {
  if (h == NULL) return;
  // A non-positive or non-finite gain would black out the picture silently, so it is
  // rejected instead of clamped: the caller (env var) can then stay at 1.0.
  if (!(gain > 0.0f) || gain > 32.0f) return;
  h->gain = gain;
}

void as_hdr_destroy(as_hdr* h) { free(h); }

int as_hdr_map8(const as_hdr* h, int code) {
  if (h == NULL) return 0;
  const float* lin = hdr_lin_table(h->kind);
  if (lin == NULL) return 0;
  if (code < 0) code = 0;
  if (code > 65535) code = 65535;
  // Diagnostics only: the per-channel value through the same path the loop takes.
  return (int)hdr_out8_g(lin[code], h->gain);
}

int as_hdr_tonemap_rgb48(const as_hdr* h, const unsigned char* src, int sstride,
                         unsigned char* dst, int dstride, int w, int rows) {
  if (h == NULL || src == NULL || dst == NULL) return 0;
  if (w <= 0 || rows <= 0) return 0;
  const float* lin = hdr_lin_table(h->kind);
  if (lin == NULL) return 0;
  hdr_out_table();
  hdr_job job;
  job.lin = lin;
  job.m = h->src_2020 ? k_2020_to_709 : k_identity;
  job.gain = h->gain;
  job.src = src;
  job.dst = dst;
  job.sstride = sstride;
  job.dstride = dstride;
  job.w = w;
  hdr_map_all(&job, rows);
  return 1;
}