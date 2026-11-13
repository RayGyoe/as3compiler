// Video HDR -> SDR tone mapping (docs/zh-cn/video.md §16.10 / §16.11).
//
// Why this file exists: a 10-bit HDR10/HDR10+/Dolby Vision file carries PQ-encoded
// (SMPTE ST 2084) BT.2020 samples whose 1.0 means 10000 nits. Painting those code
// values into an 8-bit sRGB surface -- which is what every backend of this runtime has --
// is not "HDR with a small error": the transfer function is never decoded, so mid-tones
// land in the wrong place, everything above the sRGB ceiling is clipped flat, and
// out-of-gamut colours are crushed instead of mapped. AIR has no HDR surface either and
// paints the code values as-is, so this is an ENHANCEMENT (AGENTS.md §1.5): opt-in,
// default off.
//
//   code --[decode transfer (+ OOTF for HLG)]--> linear x   (1.0 = HDR_REF_WHITE)
//        --[optional local gain map]--> linear x'
//        --[BT.2020 -> BT.709 3x3, linear light]--> linear sRGB
//        --[per-scene shoulder]--> display-referred y in [0,1]
//        --[sRGB OETF]--> 8 bytes
//
// Reference white is 100 nits (video diffuse white), NOT BT.2408's 203 nit graphics
// white: at 203 a dark HDR scene came out at a mean of 8.8 against the pass-through
// path's 16.8 -- dark enough that shadow detail was gone. 203 is the right number when
// HDR and SDR graphics share one screen; 100 plus the mid-tone lift in the output table
// is the right number for film content on an SDR display.
//
// Three things are opt-in and each answers a measured failure of the plain mapping:
//
//  * F1 -- per-scene shoulder (as_hdr_set_meta). A title whose scenes peak at 150 nits
//    and one whose scenes peak at 4000 nits were sharing one curve, so the first lost
//    contrast to a shoulder no pixel ever reached. The shoulder now follows the scene
//    peak reported by HDR10+ / Dolby Vision dynamic metadata.
//  * F2 -- HLG OOTF (as_hdr_set_hlg_peak). The BT.2100 OOTF has a cross-channel term
//    (each channel scaled by Y^(gamma-1)), not a per-channel gamma; ignoring it shifted
//    saturated colours towards white. Now applied exactly, via a luminance-indexed table.
//  * F3 -- local tone mapping (as_hdr_set_local). A global curve cannot brighten a face
//    in a dark room while keeping the window from clipping. A blurred block-luminance
//    gain map does exactly that, at one extra pass over the frame.
//
// What is still NOT done (documented, not silently skipped): Dolby Vision profile 5
// reshaping (its base layer is IPTPQc2, not PQ -- the caller refuses to tone map it and
// says so), DV trim passes (L2/L8) and Dolby's own DM algorithm, the HDR10+ bezier tone
// curve (we use its scene peak, not its curve), and local mapping is single-scale, so a
// very large bright region gets a soft halo instead of a perfectly guided one.

#include "video_hdr.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

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
#define HDR_OUT_N 16385
#define HDR_OUT_MAX 8.0f
// Shadow lift (see hdr_rebuild_out): display-referred value ^ gamma.
#define HDR_GAMMA 0.8

// Reference white in nits (measured, see the header comment).
#define HDR_REF_WHITE 100.0f
// Shoulder shape. HDR_TAU_DEFAULT is the measured value for a high-peak scene; a scene
// with metadata gets its own tau so its peak lands at HDR_PEAK_TARGET instead.
#define HDR_KNEE 0.75
#define HDR_TAU_DEFAULT 4.0
#define HDR_PEAK_TARGET 0.97
#define HDR_TAU_MIN 0.35
#define HDR_TAU_MAX 8.0

// HLG nominal display peak. HLG is display-referred by construction, so this anchors
// its 0..1 signal; it also sets the OOTF system gamma.
#define HDR_HLG_PEAK_DEFAULT 1000.0f
#define HDR_HLG_N 4096

// log2 lookup for the local gain map. Luminance is clamped to [0, HDR_LOG_MAX] and its
// log to [HDR_LOG_MIN, log2(HDR_LOG_MAX)].
#define HDR_LOG_N 4096
#define HDR_LOG_MAX 8.0f
#define HDR_LOG_MIN (-10.0f)

// Local gain table: exp2(d) for d in [-8, +8], clamped to the gain limits. One shared
// table for every stream because the strength is applied at index time.
#define HDR_GAIN_N 2049
#define HDR_GAIN_LIMIT_LO 0.55f
#define HDR_GAIN_LIMIT_HI 1.80f
// Block size of the local luminance grid, and how fast the anchor follows a cut.
#define HDR_BLOCK 16
#define HDR_ANCHOR_RATE 0.15f

struct as_hdr {
  int kind;
  int src_2020;
  float gain;

  // F1: per-scene shoulder.
  float knee;
  float tau;
  float scene_peak;     // nits, 0 = unknown
  float scene_avg;      // nits, 0 = unknown
  int meta_kind;

  // F2: HLG OOTF.
  float hlg_peak;
  float hlg_gamma;
  float* hlg_gain;      // [HDR_HLG_N + 1]: luminance -> alpha * Y^(gamma-1)

  // F3: local tone mapping.
  float local_k;        // 0 = off
  int local_lift_only;  // 1 = shadow lift only (default), 0 = two-sided
  float anchor_log;     // smoothed log2 of the frame's mean luminance
  int anchor_frames;
  float last_gain;
  float* grid;          // per-block mean log2 luminance
  float* gtmp;          // blur scratch
  int* gcount;          // per-block sample count
  int gw, gh, gcap;

  unsigned char out8[HDR_OUT_N];
};

// Shared, build-once, read-only after initialisation. All three are functions of nothing
// but the transfer function or a table index, so any thread may read them.
static float* g_lin[3];        // [1] = PQ, [2] = HLG
static float g_log2[HDR_LOG_N + 1];
static float g_lgain[HDR_GAIN_N];
static int g_tables_ready;

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

// BT.2100 HLG inverse OETF: signal (0..1) -> scene light (0..1).
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
// towards 1.0 above it. Chosen over Reinhard/Hable because those move mid-tones (a 1.0
// input lands near 0.5, i.e. graphics white becomes grey), and over a hard clip because
// clipping is what the un-mapped path already does wrong.
static double hdr_shoulder(double x, double knee, double tau) {
  if (!(x > 0.0)) return 0.0;
  if (x <= knee) return x;
  const double k = 1.0 - knee;
  return knee + k * (1.0 - exp(-(x - knee) / tau));
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

static void hdr_shared_tables(void) {
  if (g_tables_ready) return;
  for (int i = 0; i <= HDR_LOG_N; ++i) {
    const double y = (double)HDR_LOG_MAX * (double)i / (double)HDR_LOG_N;
    double l = (y > 0.0) ? log2(y) : HDR_LOG_MIN;
    if (l < HDR_LOG_MIN) l = HDR_LOG_MIN;
    g_log2[i] = (float)l;
  }
  for (int i = 0; i < HDR_GAIN_N; ++i) {
    const double d = -8.0 + 16.0 * (double)i / (double)(HDR_GAIN_N - 1);
    double g = pow(2.0, d);
    if (g < HDR_GAIN_LIMIT_LO) g = HDR_GAIN_LIMIT_LO;
    if (g > HDR_GAIN_LIMIT_HI) g = HDR_GAIN_LIMIT_HI;
    g_lgain[i] = (float)g;
  }
  g_tables_ready = 1;
}

// Linearisation table: 16-bit code -> linear.
//  PQ keeps the reference-white scale folded in (1.0 == HDR_REF_WHITE) because its EOTF
//  is the whole transfer and the OOTF is identity for PQ.
//  HLG stores raw scene light (0..1) instead: its OOTF is NOT per channel (F2), so the
//  gamma term cannot be folded into a per-code table -- it depends on the pixel's
//  luminance, which is only known after all three channels are read.
static const float* hdr_lin_table(int kind) {
  if (kind != 1 && kind != 2) return NULL;
  if (g_lin[kind] != NULL) return g_lin[kind];
  float* t = (float*)malloc(sizeof(float) * 65536u);
  if (t == NULL) return NULL;
  for (int i = 0; i < 65536; ++i) {
    const double n = (double)i / 65535.0;
    double lin;
    if (kind == 1) lin = hdr_pq_eotf(n) * 10000.0 / HDR_REF_WHITE;
    else lin = hdr_hlg_inv_oetf(n);
    t[i] = (float)lin;
  }
  g_lin[kind] = t;
  return t;
}

// F2: BT.2100 OOTF system gamma for a nominal display peak,
//   gamma = 1.2 + 0.42 * log10(Lw / 1000)
// i.e. 1.2 at 1000 nits, 1.033 at 400 nits, 0.78 at 100 nits: a dimmer display gets a
// flatter transfer. The table is alpha * Y^(gamma-1) so the per-pixel work is one
// lookup and three multiplies.
static void hdr_hlg_table(as_hdr* h) {
  const double lw = (double)h->hlg_peak;
  double gamma = 1.2 + 0.42 * log10(lw / 1000.0);
  if (!(gamma > 0.2)) gamma = 0.2;
  if (gamma > 2.0) gamma = 2.0;
  h->hlg_gamma = (float)gamma;
  const double alpha = lw / (double)HDR_REF_WHITE;
  for (int i = 0; i <= HDR_HLG_N; ++i) {
    double y = (double)i / (double)HDR_HLG_N;
    // A gamma below 1 would make the term infinite at black; the floor keeps the first
    // entry finite, and at alpha * 1e-4^(gamma-1) it is still effectively black.
    if (y < 1e-4) y = 1e-4;
    h->hlg_gain[i] = (float)(alpha * pow(y, gamma - 1.0));
  }
}

static void hdr_rebuild_out(as_hdr* h) {
  for (int i = 0; i < HDR_OUT_N; ++i) {
    const double x = (double)HDR_OUT_MAX * (double)i / (double)(HDR_OUT_N - 1);
    // Mid-tone lift, folded into the table so it costs nothing per pixel. Without it a
    // physically straight mapping made a dark HDR scene come out at a mean of 6-14
    // against the pass-through path's 8-17: correct photometrically, and far too dark
    // to watch, because an SDR grade of the same film lifts its shadows. 0.8 is the
    // compromise -- shadows come up ~1.6x, a 100 nit white stays at 227, and highlights
    // keep the roll-off.
    const double y = pow(x, HDR_GAMMA);
    double s = hdr_srgb_oetf(hdr_shoulder(y, (double)h->knee, (double)h->tau));
    if (s < 0.0) s = 0.0;
    if (s > 1.0) s = 1.0;
    h->out8[i] = (unsigned char)(s * 255.0 + 0.5);
  }
}

static float hdr_log2_of(float y) {
  if (!(y > 0.0f)) return HDR_LOG_MIN;
  float v = y * (float)HDR_LOG_N / HDR_LOG_MAX;
  int i = (int)(v + 0.5f);
  if (i < 0) i = 0;
  if (i > HDR_LOG_N) i = HDR_LOG_N;
  return g_log2[i];
}

static unsigned char hdr_out8(const as_hdr* h, float x, float gain) {
  if (!(x > 0.0f)) return 0;                    // includes NaN and matrix negatives
  float v = x * gain * (float)(HDR_OUT_N - 1) / HDR_OUT_MAX;
  int idx = (int)(v + 0.5f);
  if (idx < 0) return 0;
  if (idx >= HDR_OUT_N) idx = HDR_OUT_N - 1;
  return h->out8[idx];
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

// Luminance weights of the transfer-function output. Used only for the HLG OOTF and the
// local gain map -- never to change the colour in any other way.
static const float k_lum_2020[3] = {0.2627f, 0.6780f, 0.0593f};
static const float k_lum_709[3] = {0.2126f, 0.7152f, 0.0722f};

typedef struct {
  const as_hdr* own;
  const float* lin;
  const float* hg;      // HLG OOTF gain table, NULL for PQ
  const float* m;       // gamut matrix
  const float* lw;      // luminance weights
  float gain;
  const unsigned char* src;
  unsigned char* dst;
  int sstride, dstride, w;
  // Local map (unused when local_k == 0).
  const float* grid;
  float* gsum;          // block accumulator (pass 1 only)
  int* gcnt;
  int gw, gh;
  float anchor_log;
  float local_k;
  int local_lift_only;
} hdr_job;

// ---------------------------------------------------------------------------
// Per-pixel core
// ---------------------------------------------------------------------------

// Reads one pixel and leaves it display-referred in reference-white units. For HLG this
// is where F2 lives: the OOTF scales all three channels by the *frame's* luminance term,
// which is why it cannot be a per-channel table.
static inline float hdr_linear(const hdr_job* j, const unsigned char* s,
                               float* out_r, float* out_g, float* out_b) {
  const float r0 = j->lin[(unsigned)(s[0] | (s[1] << 8))];
  const float g0 = j->lin[(unsigned)(s[2] | (s[3] << 8))];
  const float b0 = j->lin[(unsigned)(s[4] | (s[5] << 8))];
  float r = r0, g = g0, b = b0;
  if (j->hg != NULL) {
    const float y = j->lw[0] * r0 + j->lw[1] * g0 + j->lw[2] * b0;
    int i = (int)(y * (float)HDR_HLG_N + 0.5f);
    if (i < 0) i = 0;
    if (i > HDR_HLG_N) i = HDR_HLG_N;
    const float t = j->hg[i];
    r *= t; g *= t; b *= t;
  }
  *out_r = r; *out_g = g; *out_b = b;
  return j->lw[0] * r + j->lw[1] * g + j->lw[2] * b;
}

// Bilinear sample of the blurred block-luminance grid, in log2 units.
static inline float hdr_grid_at(const hdr_job* j, int x, int y) {
  const float inv = 1.0f / (float)HDR_BLOCK;
  float gx = (float)x * inv - 0.5f;
  float gy = (float)y * inv - 0.5f;
  if (gx < 0.0f) gx = 0.0f;
  if (gy < 0.0f) gy = 0.0f;
  int x0 = (int)gx, y0 = (int)gy;
  if (x0 >= j->gw) x0 = j->gw - 1;
  if (y0 >= j->gh) y0 = j->gh - 1;
  const int x1 = (x0 + 1 < j->gw) ? x0 + 1 : x0;
  const int y1 = (y0 + 1 < j->gh) ? y0 + 1 : y0;
  const float fx = gx - (float)x0, fy = gy - (float)y0;
  const float* r0 = j->grid + (size_t)y0 * (size_t)j->gw;
  const float* r1 = j->grid + (size_t)y1 * (size_t)j->gw;
  const float a = r0[x0] + (r0[x1] - r0[x0]) * fx;
  const float b = r1[x0] + (r1[x1] - r1[x0]) * fx;
  return a + (b - a) * fy;
}

// The local gain: bright neighbourhoods are pulled down, dark ones lifted, and the
// anchor (the frame's own mean luminance, low-passed in time) is a fixed point, so the
// overall exposure does not move. F3's whole point is that this multiplier depends on
// the neighbourhood rather than the pixel, which is why local contrast inside a block
// survives untouched.
//
// `mode` decides whether the bright side is touched at all. Measured on the 4K sample
// (a dark frame whose highlights peak at 347 nits): the two-sided operator pulled the
// frame max from 138 down to 111, i.e. it dimmed the one thing HDR has that SDR does
// not, while a one-sided lift raised p50 1->3 and p90 33->36 and left the top alone.
// Lift-only is therefore the default; two-sided stays available because it is the
// textbook operator and the right one for a flat, low-contrast frame.
static inline float hdr_local_gain(const hdr_job* j, float dlog) {
  float d = j->local_k * dlog;
  if (j->local_lift_only && d < 0.0f) return 1.0f;
  float v = (d + 8.0f) * (float)(HDR_GAIN_N - 1) / 16.0f;
  int i = (int)(v + 0.5f);
  if (i < 0) i = 0;
  if (i >= HDR_GAIN_N) i = HDR_GAIN_N - 1;
  return g_lgain[i];
}

// ---------------------------------------------------------------------------
// Row kernels
// ---------------------------------------------------------------------------

// Single pass (local mapping off): the measured default path.
static void hdr_map_rows(const hdr_job* j, int y0, int y1) {
  for (int y = y0; y < y1; ++y) {
    const unsigned char* s = j->src + (size_t)y * (size_t)j->sstride;
    unsigned char* d = j->dst + (size_t)y * (size_t)j->dstride;
    for (int x = 0; x < j->w; ++x, s += 6, d += 4) {
      float r, g, b;
      hdr_linear(j, s, &r, &g, &b);
      const float R = j->m[0] * r + j->m[1] * g + j->m[2] * b;
      const float G = j->m[3] * r + j->m[4] * g + j->m[5] * b;
      const float B = j->m[6] * r + j->m[7] * g + j->m[8] * b;
      d[0] = hdr_out8(j->own, B, j->gain);
      d[1] = hdr_out8(j->own, G, j->gain);
      d[2] = hdr_out8(j->own, R, j->gain);
      d[3] = 255;
    }
  }
}

// Pass 1 of the local path: block sums of log2 luminance.
static void hdr_accum_rows(const hdr_job* j, int y0, int y1) {
  for (int y = y0; y < y1; ++y) {
    const unsigned char* s = j->src + (size_t)y * (size_t)j->sstride;
    const size_t base = (size_t)(y / HDR_BLOCK) * (size_t)j->gw;
    float* row = j->gsum + base;
    int* crow = j->gcnt + base;
    for (int x = 0; x < j->w; ++x, s += 6) {
      float r, g, b;
      const float yv = hdr_linear(j, s, &r, &g, &b);
      const int bx = x / HDR_BLOCK;
      row[bx] += hdr_log2_of(yv);
      crow[bx] += 1;
    }
  }
}

// Pass 2: the same math as the single-pass kernel plus the neighbourhood gain.
static void hdr_map_rows_local(const hdr_job* j, int y0, int y1, float* gsum) {
  float acc = 0.0f;
  for (int y = y0; y < y1; ++y) {
    const unsigned char* s = j->src + (size_t)y * (size_t)j->sstride;
    unsigned char* d = j->dst + (size_t)y * (size_t)j->dstride;
    for (int x = 0; x < j->w; ++x, s += 6, d += 4) {
      float r, g, b;
      hdr_linear(j, s, &r, &g, &b);
      const float gl = hdr_local_gain(j, j->anchor_log - hdr_grid_at(j, x, y));
      acc += gl;
      r *= gl; g *= gl; b *= gl;
      const float R = j->m[0] * r + j->m[1] * g + j->m[2] * b;
      const float G = j->m[3] * r + j->m[4] * g + j->m[5] * b;
      const float B = j->m[6] * r + j->m[7] * g + j->m[8] * b;
      d[0] = hdr_out8(j->own, B, j->gain);
      d[1] = hdr_out8(j->own, G, j->gain);
      d[2] = hdr_out8(j->own, R, j->gain);
      d[3] = 255;
    }
  }
  if (gsum != NULL) *gsum += acc;
}

// ---------------------------------------------------------------------------
// Threading
// ---------------------------------------------------------------------------

enum { kJobMap, kJobAccum, kJobMapLocal };

typedef struct {
  int kind;
  const hdr_job* job;
  int y0, y1;
  float gain_sum;
} hdr_slice;

static void hdr_slice_run(hdr_slice* s) {
  if (s->kind == kJobMap) hdr_map_rows(s->job, s->y0, s->y1);
  else if (s->kind == kJobAccum) hdr_accum_rows(s->job, s->y0, s->y1);
  else hdr_map_rows_local(s->job, s->y0, s->y1, &s->gain_sum);
}

#if HDR_HAVE_THREADS
#if defined(_WIN32)
static DWORD WINAPI hdr_thread_body(LPVOID p) { hdr_slice_run((hdr_slice*)p); return 0; }
#else
static void* hdr_thread_body(void* p) { hdr_slice_run((hdr_slice*)p); return NULL; }
#endif
#endif

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

// Runs one pass over the frame. Slice boundaries are snapped to HDR_BLOCK rows for the
// passes that write the block grid, because two threads inside one block row would race
// on the same accumulator.
static float hdr_run_pass(int kind, const hdr_job* job, int rows) {
  float total = 0.0f;
  const int n = hdr_thread_count(rows);
#if HDR_HAVE_THREADS
  if (n > 1) {
    hdr_slice sl[HDR_MAX_THREADS];
#if defined(_WIN32)
    HANDLE th[HDR_MAX_THREADS];
#else
    pthread_t th[HDR_MAX_THREADS];
#endif
    for (int i = 0; i < n; ++i) {
      sl[i].kind = kind;
      sl[i].job = job;
      sl[i].y0 = rows * i / n;
      sl[i].y1 = rows * (i + 1) / n;
      sl[i].gain_sum = 0.0f;
      if (kind != kJobMap) {
        sl[i].y0 = (sl[i].y0 / HDR_BLOCK) * HDR_BLOCK;
        sl[i].y1 = (sl[i].y1 + HDR_BLOCK - 1) / HDR_BLOCK * HDR_BLOCK;
        if (sl[i].y1 > rows) sl[i].y1 = rows;
      }
      th[i] = 0;
      if (sl[i].y1 <= sl[i].y0) continue;
#if defined(_WIN32)
      th[i] = CreateThread(NULL, 0, hdr_thread_body, &sl[i], 0, NULL);
      if (th[i] == NULL) hdr_slice_run(&sl[i]);
#else
      if (pthread_create(&th[i], NULL, hdr_thread_body, &sl[i]) != 0) hdr_slice_run(&sl[i]);
#endif
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
    for (int i = 0; i < n; ++i) total += sl[i].gain_sum;
    return total;
  }
#endif
  hdr_slice one;
  one.kind = kind;
  one.job = job;
  one.y0 = 0;
  one.y1 = rows;
  one.gain_sum = 0.0f;
  hdr_slice_run(&one);
  return one.gain_sum;
}

// 3-tap box blur, twice, on the block grid. This is the low-pass the local operator
// needs; it is deliberately computed on the ~24k-cell grid rather than the frame, so the
// whole neighbourhood analysis costs a fraction of one pixel pass.
static void hdr_blur_grid(float* g, float* tmp, int gw, int gh) {
  for (int pass = 0; pass < 2; ++pass) {
    for (int y = 0; y < gh; ++y) {
      float* row = g + (size_t)y * (size_t)gw;
      float* out = tmp + (size_t)y * (size_t)gw;
      for (int x = 0; x < gw; ++x) {
        const float a = row[x > 0 ? x - 1 : x];
        const float b = row[x];
        const float c = row[x + 1 < gw ? x + 1 : x];
        out[x] = (a + 2.0f * b + c) * 0.25f;
      }
    }
    for (int x = 0; x < gw; ++x) {
      for (int y = 0; y < gh; ++y) {
        const float a = tmp[(size_t)(y > 0 ? y - 1 : y) * (size_t)gw + (size_t)x];
        const float b = tmp[(size_t)y * (size_t)gw + (size_t)x];
        const float c = tmp[(size_t)(y + 1 < gh ? y + 1 : y) * (size_t)gw + (size_t)x];
        g[(size_t)y * (size_t)gw + (size_t)x] = (a + 2.0f * b + c) * 0.25f;
      }
    }
  }
}

// Mean log2 luminance of the frame, weighted by the actual sample count of each block
// (edge blocks are partial, and weighting them equally would bias the anchor).
static float hdr_anchor_of(const float* grid, const int* cnt, int cells) {
  double sum = 0.0;
  long long n = 0;
  for (int i = 0; i < cells; ++i) {
    const int c = cnt[i];
    if (c <= 0) continue;
    sum += (double)grid[i] * (double)c;
    n += c;
  }
  if (n <= 0) return HDR_LOG_MIN;
  return (float)(sum / (double)n);
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

as_hdr* as_hdr_create(int kind, int src_2020) {
  if (kind != 1 && kind != 2) return NULL;
  hdr_shared_tables();
  if (hdr_lin_table(kind) == NULL) return NULL;
  as_hdr* h = (as_hdr*)calloc(1, sizeof(as_hdr));
  if (h == NULL) return NULL;
  h->kind = kind;
  h->src_2020 = src_2020 ? 1 : 0;
  h->gain = 1.0f;
  h->knee = (float)HDR_KNEE;
  h->tau = (float)HDR_TAU_DEFAULT;
  h->hlg_peak = HDR_HLG_PEAK_DEFAULT;
  h->local_lift_only = 1;   // measured default, see hdr_local_gain
  h->anchor_log = 0.0f;
  h->last_gain = 1.0f;
  if (kind == 2) {
    h->hlg_gain = (float*)malloc(sizeof(float) * (HDR_HLG_N + 1));
    if (h->hlg_gain == NULL) { free(h); return NULL; }
    hdr_hlg_table(h);
  }
  hdr_rebuild_out(h);
  return h;
}

void as_hdr_set_gain(as_hdr* h, float gain) {
  if (h == NULL) return;
  // A non-positive or non-finite gain would black out the picture silently, so it is
  // rejected instead of clamped: the caller (env var) can then stay at 1.0.
  if (!(gain > 0.0f) || gain > 32.0f) return;
  h->gain = gain;
}

void as_hdr_set_hlg_peak(as_hdr* h, float nits) {
  if (h == NULL || h->hlg_gain == NULL) return;
  if (!(nits >= 100.0f) || nits > 10000.0f) return;
  h->hlg_peak = nits;
  hdr_hlg_table(h);
}

// F1: the shoulder follows the scene peak. tau is solved so the scene's brightest pixel
// lands at HDR_PEAK_TARGET instead of wherever a fixed tau happened to put it:
//   shoulder(x_p) = knee + (1-knee)(1 - exp(-(x_p-knee)/tau)) = target
//   => tau = (x_p - knee) / ln((1-knee)/(1-target))
// A scene that never exceeds reference white keeps mid-tones linear; a 10000-nit scene
// clamps at HDR_TAU_MAX so its top end stays distinguishable instead of flattening.
void as_hdr_set_meta(as_hdr* h, const as_hdr_meta* m) {
  if (h == NULL || m == NULL) return;
  if (m->kind == 0 && !(m->peak_nits > 0.0f)) return;
  h->meta_kind = m->kind;
  h->scene_peak = m->peak_nits;
  h->scene_avg = m->avg_nits;
  if (!(m->peak_nits > 0.0f)) return;
  const double xp = (double)m->peak_nits / (double)HDR_REF_WHITE;
  const double knee = HDR_KNEE;
  double tau;
  if (xp > knee && HDR_PEAK_TARGET < 1.0) {
    tau = (xp - knee) / log((1.0 - knee) / (1.0 - HDR_PEAK_TARGET));
    if (tau < HDR_TAU_MIN) tau = HDR_TAU_MIN;
    if (tau > HDR_TAU_MAX) tau = HDR_TAU_MAX;
  } else {
    tau = HDR_TAU_MIN;   // nothing reaches the knee: keep the response linear
  }
  // The output table is 16385 entries and takes 0.8 ms to rebuild (measured), which is far
  // too much to do per frame: HDR10+ metadata changes on almost every frame, and a 1-nit
  // peak change would already move tau by 0.007. Quantising to 0.05 tau (~7 nits of scene
  // peak) keeps the pop invisible -- at a 367-nit peak the shoulder moves by <1 output code --
  // and turns a per-frame rebuild into one per real scene change.
  if (fabs(tau - (double)h->tau) > 0.05) {
    h->tau = (float)tau;
    hdr_rebuild_out(h);
  }
}

int as_hdr_set_local(as_hdr* h, float strength) {
  if (h == NULL) return 0;
  if (!(strength > 0.0f) || strength > 1.0f) { h->local_k = 0.0f; return 0; }
  h->local_k = strength;
  return 1;
}

int as_hdr_set_local_mode(as_hdr* h, int two_sided) {
  if (h == NULL) return 0;
  // Returns the mode actually set: 1 = two-sided, 0 = lift only.
  h->local_lift_only = two_sided ? 0 : 1;
  return two_sided ? 1 : 0;
}

int as_hdr_local_mode(const as_hdr* h) { return h ? (h->local_lift_only ? 0 : 1) : 0; }

void as_hdr_destroy(as_hdr* h) {
  if (h == NULL) return;
  free(h->hlg_gain);
  free(h->grid);
  free(h->gtmp);
  free(h->gcount);
  free(h);
}

int as_hdr_map8(const as_hdr* h, int code) {
  if (h == NULL) return 0;
  const float* lin = hdr_lin_table(h->kind);
  if (lin == NULL) return 0;
  if (code < 0) code = 0;
  if (code > 65535) code = 65535;
  // Diagnostics only: one code through the same path the loop takes. For HLG this is
  // the neutral-grey value -- at R=G=B the OOTF's cross-channel term equals the
  // per-channel one, because the luminance of a grey IS that grey.
  float x = lin[code];
  if (h->kind == 2 && h->hlg_gain != NULL) {
    int i = (int)(x * (float)HDR_HLG_N + 0.5f);
    if (i < 0) i = 0;
    if (i > HDR_HLG_N) i = HDR_HLG_N;
    x *= h->hlg_gain[i];
  }
  return (int)hdr_out8(h, x, h->gain);
}

float as_hdr_curve_knee(const as_hdr* h) { return h ? h->knee : 0.0f; }
float as_hdr_curve_tau(const as_hdr* h) { return h ? h->tau : 0.0f; }
float as_hdr_scene_peak(const as_hdr* h) { return h ? h->scene_peak : 0.0f; }
float as_hdr_scene_avg(const as_hdr* h) { return h ? h->scene_avg : 0.0f; }
int as_hdr_meta_kind(const as_hdr* h) { return h ? h->meta_kind : 0; }
int as_hdr_local_strength(const as_hdr* h) { return h ? (int)(h->local_k * 1000.0f + 0.5f) : 0; }
float as_hdr_last_gain(const as_hdr* h) { return h ? h->last_gain : 1.0f; }

int as_hdr_tonemap_rgb48(as_hdr* h, const unsigned char* src, int sstride,
                         unsigned char* dst, int dstride, int w, int rows) {
  if (h == NULL || src == NULL || dst == NULL) return 0;
  if (w <= 0 || rows <= 0) return 0;
  const float* lin = hdr_lin_table(h->kind);
  if (lin == NULL) return 0;

  hdr_job job;
  memset(&job, 0, sizeof(job));
  job.own = h;
  job.lin = lin;
  job.hg = (h->kind == 2) ? h->hlg_gain : NULL;
  job.m = h->src_2020 ? k_2020_to_709 : k_identity;
  job.lw = h->src_2020 ? k_lum_2020 : k_lum_709;
  job.gain = h->gain;
  job.src = src;
  job.dst = dst;
  job.sstride = sstride;
  job.dstride = dstride;
  job.w = w;

  if (!(h->local_k > 0.0f)) {
    h->last_gain = 1.0f;
    hdr_run_pass(kJobMap, &job, rows);
    return 1;
  }

  // Local path: size the block grid for this geometry (once per stream in practice).
  const int bw = (w + HDR_BLOCK - 1) / HDR_BLOCK;
  const int bh = (rows + HDR_BLOCK - 1) / HDR_BLOCK;
  const int cells = bw * bh;
  if (cells > h->gcap) {
    float* g = (float*)realloc(h->grid, sizeof(float) * (size_t)cells);
    if (g == NULL) { h->local_k = 0.0f; hdr_run_pass(kJobMap, &job, rows); return 1; }
    h->grid = g;
    float* t = (float*)realloc(h->gtmp, sizeof(float) * (size_t)cells);
    if (t == NULL) { h->local_k = 0.0f; hdr_run_pass(kJobMap, &job, rows); return 1; }
    h->gtmp = t;
    int* c = (int*)realloc(h->gcount, sizeof(int) * (size_t)cells);
    if (c == NULL) { h->local_k = 0.0f; hdr_run_pass(kJobMap, &job, rows); return 1; }
    h->gcount = c;
    h->gcap = cells;
  }
  h->gw = bw;
  h->gh = bh;
  memset(h->grid, 0, sizeof(float) * (size_t)cells);
  memset(h->gcount, 0, sizeof(int) * (size_t)cells);

  job.grid = h->grid;
  job.gsum = h->grid;
  job.gcnt = h->gcount;
  job.gw = bw;
  job.gh = bh;
  hdr_run_pass(kJobAccum, &job, rows);

  for (int i = 0; i < cells; ++i) {
    const int n = h->gcount[i];
    h->grid[i] = (n > 0) ? h->grid[i] / (float)n : 0.0f;
  }

  // The anchor is the frame's own mean log2 luminance, low-passed in time so a cut does
  // not snap the exposure. Without that smoothing the mapping pumped visibly on the
  // cut-heavy opening of the 4K sample.
  const float frame_log = hdr_anchor_of(h->grid, h->gcount, cells);
  if (h->anchor_frames == 0) h->anchor_log = frame_log;
  else h->anchor_log += HDR_ANCHOR_RATE * (frame_log - h->anchor_log);
  h->anchor_frames++;
  job.anchor_log = h->anchor_log;
  job.local_k = h->local_k;
  job.local_lift_only = h->local_lift_only;

  hdr_blur_grid(h->grid, h->gtmp, bw, bh);

  const float gain_sum = hdr_run_pass(kJobMapLocal, &job, rows);
  h->last_gain = gain_sum / (float)(w * rows);
  return 1;
}