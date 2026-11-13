// video_glue: the FFmpeg seam behind flash.net.NetStream / flash.media.Video.
//
// WHAT IS HERE: demuxing, video decoding, audio decoding + resampling to the
// mixer's f32 device format, and turning a decoded frame into an SkImage. All of it
// is C because FFmpeg is C and because none of it is AS3 semantics (the NetStream
// state machine -- play/pause/seek/time/client callbacks -- is emitted by
// src/emit.ts, per docs/zh-cn/video.md §11).
//
// WHAT IS NOT HERE: any AS3 object, any GC allocation, any event. This file owns
// plain malloc'd decoder state and hands out integer handles; the generated code
// decides what an event means.
//
// TWO DECISIONS WORTH THE COMMENTS:
//
// 1. There is no decoder thread. A worker thread must never touch the GC heap and
//    would need its own hand-off for frames; instead `as_video_tick` is called once
//    per frame from Stage_dispatchFrame and decodes ahead of the presentation
//    clock by a bounded amount (AS_VIDEO_TICK_PACKETS packets, AS_VIDEO_LEAD_S of
//    video). A local 1080p H.264 stream costs ~4.3 ms/frame to decode in software
//    (video.md §7), so a 30 fps program spends ~13% of a core on it -- measured,
//    not estimated. Hardware decode is V2/V3 in the plan; the seam already carries
//    the `backend` parameter so the choice stays a runtime one.
//
// 2. Audio and video are decoded from the SAME demuxer loop in timestamp order.
//    Audio is written into the mixer's live PCM buffer (vendor/audio_glue.c
//    as_audio_live_*), which the device thread drains in real time; video keeps the
//    most recent frame whose pts has come due. That is why audio cannot starve:
//    every packet we advance over is decoded, not skipped.
//
// FRAME LIFETIME (the one thing that produces torn/black frames when wrong): the
// SkImage built here is a GPU texture uploaded at creation time
// (SkImages::TextureFromYUVAPixmaps copies), so the decoded AVFrame is unreffed
// immediately and the CPU planes never outlive the call. The image itself is
// refcounted and released when the next frame replaces it or the stream closes.
#define _CRT_SECURE_NO_WARNINGS   // getenv() for AS_VIDEO_STATS/DEBUG (see below)
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
#include <libavutil/cpu.h>   // av_cpu_count: decoder thread sizing (see as_video_open)
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
#include <libavutil/pixfmt.h>
#include <libavutil/samplefmt.h>
#include <libavutil/time.h>   // av_gettime_relative: monotonic, for the cost counters
#include <libavutil/hwcontext.h>   // AVBufferRef/hw_device_ctx: GPU decode (see as_video_hw_setup)
#if defined(_WIN32)
#include <libavutil/hwcontext_d3d11va.h>   // the ID3D11Device behind a d3d11va frame (zero copy)
#endif
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>

#include <math.h>
#include <stdint.h>   // intptr_t: a hw frame carries its slice index in data[1]
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// ---------------------------------------------------------------------------
// Dependencies that are OPTIONAL at the artefact level
// ---------------------------------------------------------------------------
// Whether FFmpeg is linked is decided by a SOURCE probe (docs/zh-cn/video.md §5.2),
// which deliberately over-includes: it fires for a program that only NAMES
// NetStream/Video (examples/builtin-arity.as passes them as parameter types) just as
// it does for one that plays a file. Such a build has the FFmpeg archives but
// neither the Skia glue nor the audio glue -- and it still has to LINK. So both
// dependencies fall back here instead of leaving undefined symbols behind.
//
// What the fallbacks mean, stated plainly:
//   * no ASC_HAVE_AUDIO  -> the mixer calls do nothing and has_audio stays false.
//     That is the same contract the rest of the runtime has for this build (the
//     compiler already warns that flash.media has no backend and play() returns
//     null), and it is not silent at build time.
//   * no ASC_USE_SKIA    -> there is no renderer at all, so as_video_open() refuses
//     the stream with a REAL reason instead of pretending to play. NetStream.play()
//     turns that into NetStream.Play.Failed (an event, not a throw: the file is
//     fine, the build cannot show it).
#ifdef ASC_USE_SKIA
// Declared by hand on purpose: including Skia headers here would drag Skia's C++ ABI
// into a .c translation unit, and the whole point of the seam is that this file knows
// nothing about Skia beyond "pointer in, pointer out".
extern void* sk_image_from_yuv_strided(void* ctx, const void* y, int sy, const void* u,
                                       int su, const void* v, int sv, int w, int h, int yuvCs);
extern void* sk_image_from_argb(const void* px, int w, int h);
// Refcount release without a Skia header: sk_image_delete is the C wrapper that
// exists for exactly this caller (skia_glue.cc).
extern void sk_image_delete(void* image);
#endif

// Zero copy (V3 step 2, video.md §16.9): hand the D3D11 decoder slice straight to
// the renderer's D3D12 device instead of reading it back. Only the Windows D3D12
// backend has an implementation (vendor/video_d3d.cc); everywhere else the compile
// silently has no such symbol and the measured CPU route stays the only route.
#if defined(ASC_RENDER_D3D) && ASC_RENDER_D3D && defined(ASC_USE_SKIA)
#define AS_VIDEO_ZC 1
extern void* sk_video_d3d_image(void* ctx, void* tex, int slice, int w, int h,
                                int ten_bit, int yuv_cs);
extern int sk_video_d3d_probe(void* ctx, void* dev11, int w, int h, int ten_bit);
extern void sk_video_d3d_stats(long long* frames, long long* starved);
extern void sk_video_d3d_forget(void* d3d11_device);
#else
#define AS_VIDEO_ZC 0
static void* sk_video_d3d_image(void* ctx, void* tex, int slice, int w, int h,
                                int ten_bit, int yuv_cs) {
  (void)ctx; (void)tex; (void)slice; (void)w; (void)h; (void)ten_bit; (void)yuv_cs;
  return NULL;
}
static int sk_video_d3d_probe(void* ctx, void* dev11, int w, int h, int ten_bit) {
  (void)ctx; (void)dev11; (void)w; (void)h; (void)ten_bit;
  return 0;
}
static void sk_video_d3d_stats(long long* frames, long long* starved) {
  if (frames != NULL) *frames = 0;
  if (starved != NULL) *starved = 0;
}
static void sk_video_d3d_forget(void* d3d11_device) { (void)d3d11_device; }
#endif

#if !defined(ASC_USE_SKIA)
static void* sk_image_from_yuv_strided(void* ctx, const void* y, int sy, const void* u,
                                       int su, const void* v, int sv, int w, int h, int yuvCs) {
  (void)ctx; (void)y; (void)sy; (void)u; (void)su; (void)v; (void)sv; (void)w; (void)h; (void)yuvCs;
  return NULL;
}
static void* sk_image_from_argb(const void* px, int w, int h) { (void)px; (void)w; (void)h; return NULL; }
static void sk_image_delete(void* image) { (void)image; }
#endif

#ifdef ASC_HAVE_AUDIO
// The mixer (vendor/audio_glue.c). Same hand-declaration rule.
extern int as_audio_live_open(int channels, int rate);
extern int as_audio_live_write(int buf, const float* pcm, long long frames);
extern void as_audio_live_rewind(int buf);
extern void as_audio_live_close(int buf);
extern int as_audio_play(int buf, double startMs, int loops, double vol,
                         double ltl, double ltr, double rtl, double rtr);
extern void as_audio_voice_stop(int v);
#else
static int as_audio_live_open(int channels, int rate) { (void)channels; (void)rate; return -1; }
static int as_audio_live_write(int buf, const float* pcm, long long frames) {
  (void)buf; (void)pcm; (void)frames; return 0;
}
static void as_audio_live_rewind(int buf) { (void)buf; }
static void as_audio_live_close(int buf) { (void)buf; }
static int as_audio_play(int buf, double startMs, int loops, double vol,
                         double ltl, double ltr, double rtl, double rtr) {
  (void)buf; (void)startMs; (void)loops; (void)vol;
  (void)ltl; (void)ltr; (void)rtl; (void)rtr; return -1;
}
static void as_audio_voice_stop(int v) { (void)v; }
#endif

#define AS_VIDEO_MAX 8          // concurrent streams across the whole program
#define AS_VIDEO_TICK_PACKETS 24  // demuxed packets per frame boundary
#define AS_VIDEO_PRIME_PACKETS 240  // ... unless no frame has come out yet (see advance)
#define AS_VIDEO_LEAD_S 0.08    // decode video this far ahead of the clock
#define AS_VIDEO_QUEUE 8        // decoded-but-not-due frames kept for the clock
#define AS_VIDEO_AUDIO_RATE 44100
#define AS_VIDEO_AUDIO_CH 2

// State bits returned by as_video_state (the AS3 side maps them to status events).
enum {
  AS_VIDEO_ST_OPEN = 1,     // opened and decoding
  AS_VIDEO_ST_PLAYING = 2,
  AS_VIDEO_ST_PAUSED = 4,
  AS_VIDEO_ST_ENDED = 8,    // every packet consumed and drained
  AS_VIDEO_ST_FAILED = 16,
};

typedef struct {
  int used;
  AVFormatContext* fc;
  AVCodecContext* vc;
  AVCodecContext* ac;
  int vs;                   // video stream index, -1 when the file has none
  int as;                   // audio stream index, -1 when the file has none
  AVPacket* pkt;
  AVFrame* frame;
  AVFrame* aframe;
  // Hardware decode (V3 step 1, video.md §16.8). With a hw_device_ctx the decoder
  // writes into ID3D11Texture2D slices, and `sw_frame` is where such a frame lands
  // after av_hwframe_transfer_data -- colour mapping, pts and pacing below stay
  // unchanged because they keep seeing a system-memory frame. Zero-copy into Skia is
  // deliberately NOT here: a DXGI_FORMAT_NV12 texture keeps Y and UV as two *plane
  // slices* of one resource while GrBackendTexture takes a whole 2D texture, so that
  // route needs the plane split §10.2 describes.
  // Deferred decoder open (video.md §16.9.6). The decoder is NOT opened by
  // as_video_open(): whether hardware pays off depends on whether ZERO COPY works, and
  // that answer needs a GrRecordingContext, which does not exist until the frame loop
  // hands one in. Opening at the first tick instead makes the decision once, before any
  // packet is consumed -- no stream restart, no duplicated NetStatus events, no lost
  // first frames. `vdec` is the build's decoder; `vc_open` says the context was opened.
  const AVCodec* vdec;
  int vc_open;              // the decoder context is open
  int decided;              // the software/hardware question has been answered (or skipped)
  int src_10bit;            // codecpar says 10-bit: the probe's staging format
  int hw_refused;           // AUTO asked for the GPU and fell back to software
  int zc_traced;            // AS_VIDEO_DEBUG: the per-stream zero-copy trace was printed
  AVBufferRef* hw_device;
  AVFrame* sw_frame;
  int hw_used;              // 1 once a frame actually came back from the GPU
  // Zero copy (V3 step 2): a hardware frame that went decoder -> D3D12 textures ->
  // SkImage without ever touching system memory. `zc_used` is what AS_VIDEO_STATS
  // reports as `zc=`, so a stream that quietly fell back to the readback route is
  // visible as such instead of looking like a win.
  int zc_used;
  long long n_zc;
  double t_zc_ms;
  void* hw_dev11;           // identity of the D3D11 device behind hw_device (see below)
  struct SwsContext* sws;   // -> packed I420 (only when the source is not 420p)
  struct SwsContext* sws_bgra;  // -> packed BGRA (only on a build with no GPU ctx)
  struct SwrContext* swr;
  unsigned char* i420;      // converted planes buffer (w*h*3/2), NULL when direct
  unsigned char* bgra;
  void* image;              // SkImage* of the current frame (owned ref)
  int w, h;
  int got_meta;             // width/height/duration known (first video frame)
  double duration_ms;
  double fps;
  double frame_pts;         // pts (s) of the image currently held
  double v_tb;              // video stream time_base (seconds per tick), 0 = unknown
  double v_start;           // seconds of the video stream's start_time (MPEG-TS is
                            // NOT 0-based: clip.ts starts at 1.533 s, and comparing
                            // that raw pts against the 0-based play clock made the
                            // decoder stop after one frame and never show it)
  double clock0_ms;         // wall clock that corresponds to pts 0 of this pass
  double paused_at_ms;      // 0 while playing
  double seek_to;           // seconds, <0 when nothing is pending
  double audio_ms;          // decoded audio written since the last rewind
  long long audio_written;  // frames written to the live buffer
  long long audio_played0;  // value of 'audio_ms' at the last rewind
  int audio_buf;
  int audio_voice;
  double vol;               // from NetStream.soundTransform at play() time
  int eof;                  // demuxer exhausted
  int drained;              // decoder flushed
  int at_end;               // the last frame's display slot has elapsed (see tick)
  int failed;
  int has_video;
  int has_audio;
  // The frame that is DUE on screen as `image`, plus the queue of frames decoded but
  // not yet due. Keeping them apart is what makes playback follow the wall clock
  // instead of the decoder: without the queue, every decoded frame became the visible
  // one, so a 15-packet tick painted the whole 1.2 s clip in the first frame and
  // NetStream.time jumped to the end (measured: time=1.133 after 0.4 s of playback).
  //
  // Decoded but not yet due, oldest first. ONE slot was not enough: advance() keeps
  // demuxing for AUDIO continuity, which drags video frames along (an interleaved clip
  // decodes ~2 frames per tick), so a single slot always held the NEWEST frame -- ~80 ms
  // ahead of the clock -- and never came due. Measured as NetStream.time frozen at 0.000
  // for a whole 0.4 s pump while the slot chased the decoder. A short FIFO lets the
  // clock pick the frame that belongs there; on overflow the OLDEST is dropped, which is
  // what a player behind real time must do (video.md §10.2).
  void* qimg[AS_VIDEO_QUEUE];
  double qpts[AS_VIDEO_QUEUE];
  int qn;
  double decoded_pts;       // pts of the newest DECODED frame (pacing, see advance)
  // Verification counters (AS_VIDEO_STATS=1 prints them when the stream closes).
  // They exist because "did audio actually reach the mixer?" is not observable from
  // AS3 -- AIR has no API for it -- and a regression that silently stops writing
  // audio would otherwise only be catchable by ear. Counters are diagnostics: they
  // never change control flow.
  long long n_vframes;
  long long n_aframes;
  // Where the per-frame time actually goes. Printed by AS_VIDEO_STATS=1 next to the
  // counters: "playback stutters" is not diagnosable from AS3, and the split between
  // decode / colour conversion / GPU upload decides which of the three fixes applies
  // (more threads, a cheaper sws flag, or moving the work off the frame loop).
  double t_dec_ms;          // avcodec_receive_frame
  double t_conv_ms;         // sws_scale to packed I420 (or BGRA on a CPU build)
  double t_upload_ms;       // sk_image_from_* (CPU planes -> GPU textures)
  double t_hw_ms;           // av_hwframe_transfer_data (GPU -> system memory)
  char url[512];
  char err[256];
} as_video;

static as_video g_videos[AS_VIDEO_MAX];

// ---------------------------------------------------------------------------
// Colour space (video.md §10.3) -- the matrix/range must follow the BITSTREAM.
// ---------------------------------------------------------------------------
// AVFrame.colorspace tells us the matrix, color_range the range. Skia's enum puts
// Full before Limited for each matrix, and the *_Limited_* names are the ones a
// broadcast file actually carries. Unknown + unspecified falls back to the same
// BT.601 limited pair the ANE path uses, which is what an untagged SD file means.
// 10-bit detection that works for BOTH frame kinds. A system-memory frame says so in
// f->format; a hardware frame's format is AV_PIX_FMT_D3D11 and the real pixel layout
// lives in its frames context (sw_format). Looking only at f->format classified a
// P010 hardware frame as 8-bit, which chose the 8-bit BT.2020 matrix -- a colour
// error, not a performance one.
static int as_video_ten_bit(const AVFrame* f) {
  if (f->format == AV_PIX_FMT_YUV420P10LE || f->format == AV_PIX_FMT_YUV420P10BE ||
      f->format == AV_PIX_FMT_P010LE || f->format == AV_PIX_FMT_P010BE)
    return 1;
  if (f->hw_frames_ctx != NULL) {
    const AVHWFramesContext* hf = (const AVHWFramesContext*)f->hw_frames_ctx->data;
    if (hf != NULL && (hf->sw_format == AV_PIX_FMT_P010LE || hf->sw_format == AV_PIX_FMT_P010BE ||
                       hf->sw_format == AV_PIX_FMT_YUV420P10LE))
      return 1;
  }
  return 0;
}

// The same question asked of a codecpar format, i.e. before any frame exists: the
// zero-copy probe has to pick NV12 or P010 for its staging texture at the first tick,
// and guessing 8-bit for a 10-bit stream would build the wrong plane formats.
// Descriptor depth (not a format list) so a 12-bit format answers truthfully too.
static int as_pix_fmt_10bit(int fmt) {
  if (fmt == AV_PIX_FMT_NONE) return 0;
  const AVPixFmtDescriptor* d = av_pix_fmt_desc_get((enum AVPixelFormat)fmt);
  if (d == NULL) return 0;
  return d->comp[0].depth > 8 ? 1 : 0;
}

static int as_video_sk_cs(const AVFrame* f) {
  int full = (f->color_range == AVCOL_RANGE_JPEG);
  switch (f->colorspace) {
    case AVCOL_SPC_BT709:
      return full ? 2 /*kRec709_Full*/ : 3 /*kRec709_Limited*/;
    case AVCOL_SPC_BT2020_NCL:
    case AVCOL_SPC_BT2020_CL:
      // 10-bit sources pick the 10-bit pair; the 8-bit one is the common case.
      if (as_video_ten_bit(f))
        return full ? 6 : 7;
      return full ? 4 : 5;
    case AVCOL_SPC_SMPTE170M:
    case AVCOL_SPC_BT470BG:
    case AVCOL_SPC_SMPTE240M:
      return full ? 0 /*kJPEG_Full*/ : 1 /*kRec601_Limited*/;
    default:
      return full ? 0 : 1;
  }
}

static void as_vs_error(as_video* v, const char* what, int rc) {
  char buf[AV_ERROR_MAX_STRING_SIZE] = {0};
  av_strerror(rc, buf, sizeof(buf));
  snprintf(v->err, sizeof(v->err), "%s: %s", what, buf);
}

// ---------------------------------------------------------------------------
// Frame -> SkImage (video.md §10.1 route ②: CPU YUV planes for software decode)
// ---------------------------------------------------------------------------
// Wall-clock helper for the per-frame cost counters (see as_video).
// av_gettime_relative is monotonic and microseconds: gettimeofday on Windows has
// a 15.6 ms floor, which would make a 6 ms conversion look free.
static double as_video_ms(void) { return (double)av_gettime_relative() / 1000.0; }

static void as_video_drop_image(as_video* v) {
  if (v->image != NULL) { sk_image_delete(v->image); v->image = NULL; }
}

// Zero copy on/off. On by default *when the build and the device support it*, because
// the seam already returned NULL when they do not -- so the only thing this switch has
// to express is a deliberate opt-OUT (AS_VIDEO_ZC=0), which is what an A/B measurement
// needs.
static int as_video_zc_wanted(void) {
  static int cached = -1;
  if (cached < 0) {
    const char* e = getenv("AS_VIDEO_ZC");
    cached = (e == NULL) ? 1 : !(e[0] == '0' || e[0] == 'o' || e[0] == 'O' || e[0] == 'f');
  }
  return cached;
}

// Returns 1 when a new image was produced. `grctx` is the backend's
// GrRecordingContext (NULL on a pure-CPU raster build). `pre_img` is a frame that some
// other route already produced as a GPU texture (the zero-copy seam): when it is set,
// no conversion happens here at all -- this function only timestamps and queues it.
static int as_video_present(as_video* v, AVFrame* f, void* grctx, double now_ms,
                            void* pre_img) {
  const int w = f->width, h = f->height;
  if (w <= 0 || h <= 0) return 0;
  const int direct = (f->format == AV_PIX_FMT_YUV420P || f->format == AV_PIX_FMT_YUVJ420P);
  const int cv = as_video_sk_cs(f);
  void* img = pre_img;
  // Two routes, decided by whether a GPU context exists -- never both. The I420 pass
  // exists only to feed sk_image_from_yuv_strided, so on a CPU-raster build (grctx
  // NULL) running it first converted every 4K frame TWICE: once to I420 and then to
  // BGRA, 6 ms + 12 ms per frame on a 3832x1592 10-bit source. Measured as the whole
  // reason a 4K file played at ~20 fps in a window with no GPU backend.
  const int want_gpu = (grctx != NULL) && (img == NULL);
  const double t_conv0 = as_video_ms();
  if (want_gpu) {
    // Try the GPU entry first even with a NULL context: sk_image_from_yuv_strided
    // returns NULL then, and the fallback below decides.
    if (direct) {
      const double t_up0 = as_video_ms();
      img = sk_image_from_yuv_strided(grctx, f->data[0], f->linesize[0], f->data[1],
                                      f->linesize[1], f->data[2], f->linesize[2], w, h, cv);
      v->t_upload_ms += as_video_ms() - t_up0;
      v->t_conv_ms += as_video_ms() - t_conv0;
    } else {
      // NV12 / 422 / 10-bit and friends: one sws pass to I420, then the same
      // entry. Kept as a CPU conversion (not a wrong-colour direct wrap) because
      // Skia's YUV shader takes 8-bit 4:2:0 only.
      if (v->i420 == NULL) v->i420 = (unsigned char*)malloc((size_t)w * (size_t)h * 3 / 2);
      if (v->i420 == NULL) return 0;
      unsigned char* dst[4] = {v->i420, v->i420 + (size_t)w * h, v->i420 + (size_t)w * h * 5 / 4, NULL};
      int dstride[4] = {w, w / 2, w / 2, 0};
      if (v->sws == NULL) {
        v->sws = sws_getContext(w, h, (enum AVPixelFormat)f->format, w, h, AV_PIX_FMT_YUV420P,
                                SWS_BILINEAR, NULL, NULL, NULL);
        if (v->sws == NULL) return 0;
      }
      sws_scale(v->sws, (const uint8_t* const*)f->data, f->linesize, 0, h, dst, dstride);
      v->t_conv_ms += as_video_ms() - t_conv0;
      const double t_up0 = as_video_ms();
      img = sk_image_from_yuv_strided(grctx, v->i420, w, v->i420 + (size_t)w * h, w / 2,
                                      v->i420 + (size_t)w * h * 5 / 4, w / 2, w, h, cv);
      v->t_upload_ms += as_video_ms() - t_up0;
    }
  }
  if (img == NULL) {
    // No GPU context (ASC_RENDER_CPU / pure C): there is no texture to upload to,
    // so convert to BGRA once and hand Skia a raster image. This is route ① by
    // necessity, not by preference -- §10.1's rule is about not wasting a GPU copy
    // when one EXISTS. Stated here instead of silently painting black.
    if (v->bgra == NULL) v->bgra = (unsigned char*)malloc((size_t)w * (size_t)h * 4);
    if (v->bgra == NULL) return 0;
    if (v->sws_bgra == NULL) {
      v->sws_bgra = sws_getContext(w, h, (enum AVPixelFormat)f->format, w, h, AV_PIX_FMT_BGRA,
                                   SWS_BILINEAR, NULL, NULL, NULL);
      if (v->sws_bgra == NULL) return 0;
    }
    unsigned char* dst[4] = {v->bgra, NULL, NULL, NULL};
    int dstride[4] = {w * 4, 0, 0, 0};
    sws_scale(v->sws_bgra, (const uint8_t* const*)f->data, f->linesize, 0, h, dst, dstride);
    v->t_conv_ms += as_video_ms() - t_conv0;
    const double t_up0 = as_video_ms();
    img = sk_image_from_argb(v->bgra, w, h);   // copies; BGRA-ordered words as-is
    v->t_upload_ms += as_video_ms() - t_up0;
  }
  if (img == NULL) return 0;
  v->w = w;
  v->h = h;
  // Timestamp of this picture. best_effort_timestamp is what the decoder filled in
  // when the container's pts was missing (B-frames, raw H.264 in TS), and it is what
  // AIR's NetStream.time has to follow. The time_base comes from the STREAM, not from
  // AVFrame: a decoder that does not populate frame->time_base leaves {0,1} there, and
  // multiplying by that yields a permanent 0 -- which is exactly how this read 0.000
  // for every frame of a fully decoded clip before the fix. Last resort is the frame
  // index over fps, never a zero.
  double pts = 0.0;
  {
    int64_t ts = f->best_effort_timestamp;
    if (ts == AV_NOPTS_VALUE) ts = f->pts;
    double tb = v->v_tb > 0.0 ? v->v_tb : (v->fps > 0.0 ? 1.0 / v->fps : 0.0);
    if (ts != AV_NOPTS_VALUE && tb > 0.0) pts = (double)ts * tb - v->v_start;
    else pts = v->fps > 0.0 ? (double)v->n_vframes / v->fps : 0.0;
    if (!(pts == pts) || pts < 0) pts = 0;  // NaN/negative pts, or a pre-roll before start_time
  }
  v->n_vframes++;
  v->decoded_pts = pts;
  // Present vs. queue. A frame whose pts has come due replaces what is on screen;
  // anything ahead of the clock waits in the FIFO and as_video_tick promotes it once
  // the clock reaches it (see the queue note in as_video).
  double now_s = (now_ms >= 0.0 && v->clock0_ms >= 0.0) ? (now_ms - v->clock0_ms) / 1000.0
                                                 : (now_ms >= 0.0 ? now_ms : 0.0);
  if (v->paused_at_ms != 0) now_s = v->frame_pts;   // a paused stream holds its frame
  if (pts <= now_s + 0.001) {
    as_video_drop_image(v);
    v->image = img;
    v->frame_pts = pts;
  } else {
    if (v->qn >= AS_VIDEO_QUEUE) {
      sk_image_delete((void*)v->qimg[0]);
      for (int i = 1; i < v->qn; i++) { v->qimg[i - 1] = v->qimg[i]; v->qpts[i - 1] = v->qpts[i]; }
      v->qn--;
    }
    v->qimg[v->qn] = img;
    v->qpts[v->qn] = pts;
    v->qn++;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Audio: decode -> f32 stereo 44100 -> the mixer's live buffer
// ---------------------------------------------------------------------------
static void as_video_audio_out(as_video* v, AVFrame* f) {
  if (v->audio_buf < 0) return;
  if (v->swr == NULL) {
    AVChannelLayout in;
    if (f->ch_layout.nb_channels > 0) {
      av_channel_layout_copy(&in, &f->ch_layout);
    } else {
      av_channel_layout_default(&in, 2);
    }
    AVChannelLayout out;
    av_channel_layout_default(&out, AS_VIDEO_AUDIO_CH);
    int rc = swr_alloc_set_opts2(&v->swr, &out, AV_SAMPLE_FMT_FLT, AS_VIDEO_AUDIO_RATE,
                                 &in, (enum AVSampleFormat)f->format, f->sample_rate, 0, NULL);
    av_channel_layout_uninit(&in);
    av_channel_layout_uninit(&out);
    if (rc < 0 || v->swr == NULL) { as_vs_error(v, "resampler", rc); return; }
    if (swr_init(v->swr) < 0) { as_vs_error(v, "resampler init", 0); return; }
  }
  // One output buffer per decoded frame. The ratio can exceed 2x (8 kHz -> 44.1 kHz)
  // and swr wants the room before it converts.
  int max_out = (int)av_rescale_rnd(swr_get_delay(v->swr, f->sample_rate) + f->nb_samples,
                                    AS_VIDEO_AUDIO_RATE, f->sample_rate, AV_ROUND_UP);
  if (max_out <= 0) return;
  float* out = (float*)malloc((size_t)max_out * AS_VIDEO_AUDIO_CH * sizeof(float));
  if (out == NULL) return;
  int got = swr_convert(v->swr, (uint8_t* const*)&out, max_out,
                        (const uint8_t**)f->extended_data, f->nb_samples);
  if (got > 0) {
    as_audio_live_write(v->audio_buf, out, got);
    v->audio_written += got;
    v->n_aframes += got;
  }
  free(out);
}

// ---------------------------------------------------------------------------
// Hardware decode: D3D11VA (video.md §12 V3, §16.8)
// ---------------------------------------------------------------------------
// What this does and does not buy: the decode moves off the CPU, but every frame is
// still transferred back to system memory before the colour conversion, so the
// textures Skia sees are the same as on the software path. Zero-copy needs the plane
// split described in §10.2 and is a separate step.
//
// AS_VIDEO_DECODE=soft forces the software path (A/B diagnosis); unset or "auto"
// tries the GPU and falls back without failing the stream -- a machine without a
// usable D3D11 device has to keep playing the file.
// AS_VIDEO_DECODE=hw|d3d11va|auto opts INTO the GPU decoder; unset or "soft" keeps the
// software one. The default is software on purpose, and it is a measurement, not a
// preference: on this host (32 cores, d3d11va live) the 4K HEVC HDR10+ file costs
// hw=11.25 ms + conv=3.36 ms per frame for the GPU->system-memory transfer and the
// colour pass, against dec+conv+upload = 6.7 ms per frame for the 8-thread software
// decoder. The readback is what makes hardware lose -- it exists because zero-copy
// is not implemented yet (§16.8), and once it is, this default flips.
// 0 = software, 1 = hardware forced, 2 = decide from what this machine can do.
// Unset is AUTO, not software: §16.9 made software-vs-hardware a question with a
// measured answer, so the default has to be "answer it", not "always software".
static int as_video_decode_mode(void) {
  const char* want = getenv("AS_VIDEO_DECODE");
  if (want != NULL && (strcmp(want, "soft") == 0 || strcmp(want, "cpu") == 0)) return 0;
  if (want != NULL && want[0] != 0 && strcmp(want, "auto") != 0) return 1;   // hw/d3d11va
  return 2;
}

static enum AVPixelFormat as_video_get_format(AVCodecContext* ctx,
                                             const enum AVPixelFormat* list) {
  (void)ctx;
  enum AVPixelFormat pick = AV_PIX_FMT_NONE;
  for (const enum AVPixelFormat* p = list; *p != AV_PIX_FMT_NONE; p++) {
    if (*p == AV_PIX_FMT_D3D11) { pick = *p; break; }
  }
  // No D3D11 surface offered (unsupported profile, or a build without the hwaccel):
  // fall back to the first SOFTWARE format, never to another hardware one. Returning
  // dxva2_vld here is what produced "Invalid setup for format dxva2_vld: does not
  // match the type of the provided device context" -- the device we attached is
  // D3D11, and a D3D9 surface cannot come out of it.
  if (pick == AV_PIX_FMT_NONE) {
    for (const enum AVPixelFormat* p = list; *p != AV_PIX_FMT_NONE; p++) {
      const AVPixFmtDescriptor* d = av_pix_fmt_desc_get(*p);
      if (d == NULL || (d->flags & AV_PIX_FMT_FLAG_HWACCEL) != 0) continue;
      pick = *p;
      break;
    }
  }
  if (pick == AV_PIX_FMT_NONE) pick = list[0];
  if (getenv("AS_VIDEO_DEBUG") != NULL) {
    fprintf(stderr, "[video] get_format -> %s (device=%s)\n",
            av_get_pix_fmt_name(pick),
            ctx->hw_device_ctx != NULL
                ? av_hwdevice_get_type_name(
                      ((AVHWDeviceContext*)ctx->hw_device_ctx->data)->type)
                : "none");
  }
  return pick;
}

// Create the D3D11 device this stream would decode into, and report the ID3D11Device
// behind it (the zero-copy probe needs that identity). Returns NULL when the build or
// the driver cannot provide one -- such a machine must still play video, in software.
static AVBufferRef* as_video_hw_create(const AVCodec* dec, void** dev11_out) {
  if (dev11_out != NULL) *dev11_out = NULL;
  int have_d3d11 = 0;
  // Ask the BUILD what it registered instead of assuming: an "--enable-hwaccel=h264_d3d11va"
  // list produced a build whose only d3d11 entry was the legacy D3D11VA_VLD one, and
  // nothing but this probe tells them apart (§16.8).
  for (int i = 0;; i++) {
    const AVCodecHWConfig* cfg = avcodec_get_hw_config(dec, i);
    if (cfg == NULL) break;
    if (cfg->device_type == AV_HWDEVICE_TYPE_D3D11VA &&
        (cfg->methods & AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX) != 0) {
      have_d3d11 = 1;
      break;
    }
  }
  if (!have_d3d11) return NULL;
  AVBufferRef* dev = NULL;
  if (av_hwdevice_ctx_create(&dev, AV_HWDEVICE_TYPE_D3D11VA, NULL, NULL, 0) < 0) return NULL;
  // The ID3D11Device behind it, kept as an identity for the zero-copy seam's table
  // (video_d3d.cc). It is NOT retained here: FFmpeg owns the device, and the entry is
  // dropped BEFORE this stream releases it (see as_video_free_state) so the two sides
  // never disagree about its lifetime.
#if AS_VIDEO_ZC
  {
    const AVHWDeviceContext* hwc = (const AVHWDeviceContext*)dev->data;
    if (hwc != NULL && hwc->type == AV_HWDEVICE_TYPE_D3D11VA) {
      const AVD3D11VADeviceContext* d3d = (const AVD3D11VADeviceContext*)hwc->hwctx;
      if (d3d != NULL && dev11_out != NULL) *dev11_out = (void*)d3d->device;
    }
  }
#endif
  return dev;
}

// ---------------------------------------------------------------------------
// Deferred decoder open: the software/hardware decision (video.md §16.9.6)
// ---------------------------------------------------------------------------

// Is a hardware frame going to reach the screen WITHOUT a readback? That is the only
// shape in which the GPU wins: hardware plus av_hwframe_transfer_data measured
// 13.4 ms/frame against software's 6.6 ms on the same 4K HDR10+ file (§16.8.3).
static int as_video_zc_available(void* grctx, void* dev11, int w, int h, int ten_bit) {
#if AS_VIDEO_ZC
  if (grctx == NULL || dev11 == NULL) return 0;
  if (!as_video_zc_wanted()) return 0;
  return sk_video_d3d_probe(grctx, dev11, w > 0 ? w : 16, h > 0 ? h : 16, ten_bit);
#else
  (void)grctx; (void)dev11; (void)w; (void)h; (void)ten_bit;
  return 0;
#endif
}

// Release whatever as_video_open_vdec() attached, in the order close uses: forget the
// zero-copy entry (it names the device), then drop our reference to the device.
static void as_video_hw_detach(as_video* v) {
  if (v->vc != NULL) { av_buffer_unref(&v->vc->hw_device_ctx); v->vc->get_format = NULL; }
  if (v->hw_dev11 != NULL) { sk_video_d3d_forget(v->hw_dev11); v->hw_dev11 = NULL; }
  if (v->hw_device != NULL) av_buffer_unref(&v->hw_device);
}

// (Re)build and open the video decoder. `want_hw` is a REQUEST: a device that cannot be
// created, or a decoder that refuses the stream, falls back to software. Returns 1 when
// the context is open, 0 when the stream is undecodable (v->err says why).
//
// Every open goes through here, including the one at the first frame boundary that
// turns AUTO's software start into a GPU stream: the software-vs-hardware question
// needs a GrRecordingContext (§16.9.6) and open() does not have one yet.
static int as_video_open_vdec(as_video* v, int want_hw) {
  avcodec_free_context(&v->vc);
  v->vc = avcodec_alloc_context3(v->vdec);
  if (v->vc == NULL) { v->failed = 1; snprintf(v->err, sizeof(v->err), "out of memory"); return 0; }
  AVStream* st = v->fc->streams[v->vs];
  avcodec_parameters_to_context(v->vc, st->codecpar);
  v->vc->pkt_timebase = st->time_base;
  int hw = 0;
  if (want_hw) {
    // Reuse the device the caller already created (the AUTO probe makes one before it
    // commits, and two devices per stream would mean two zero-copy table entries per
    // stream -- measured: the 4-entry table ran out on the third NetStream).
    AVBufferRef* dev = v->hw_device;
    if (dev == NULL) dev = as_video_hw_create(v->vdec, &v->hw_dev11);
    if (dev != NULL) {
      v->hw_device = dev;
      v->vc->hw_device_ctx = av_buffer_ref(dev);
      v->vc->get_format = as_video_get_format;
      // A GPU decoder ignores thread_count; frame threading would only add latency
      // before the first frame.
      v->vc->thread_count = 1;
      hw = 1;
    }
  }
  if (!hw) {
    // av_cpu_count is libavutil's own probe (what thread_count = 0 would use), so this
    // file needs no platform headers for it. Capped because frame threading keeps one
    // 4K 10-bit frame (~18 MB) alive per thread.
    int ncpu = av_cpu_count();
    if (ncpu < 1) ncpu = 1;
    if (ncpu > 8) ncpu = 8;
    v->vc->thread_count = ncpu;
    v->vc->thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE;
  }
  int rc = avcodec_open2(v->vc, v->vdec, NULL);
  if (rc < 0) {
    if (!hw) {
      as_vs_error(v, v->vdec->name, rc);
      return 0;
    }
    // A GPU decoder can refuse the stream (a profile the driver will not take). That
    // is not a reason to lose the file: rebuild the context and open it in software.
    as_video_hw_detach(v);
    v->hw_refused = 1;
    return as_video_open_vdec(v, 0);
  }
  v->vc_open = 1;
  return 1;
}

// Turn AUTO's software start into a GPU stream at the first frame boundary, when (and
// only when) the frame can reach the screen without a readback.
//
// Why there IS a software start: as_video_open() primes one frame so that play() ->
// BitmapData.draw is not a black beat, and it cannot ask the GPU question there (no
// renderer exists yet). So the prime happens in software, and this function -- running
// before the frame loop has painted anything -- re-opens the decoder on the GPU and
// asks the normal seek path to rewind to the start. One decode is redone, the stream is
// never restarted, and NetStatus/onMetaData are untouched.
static void as_video_maybe_upgrade(as_video* v, void* grctx) {
  if (v->decided || v->failed) return;
  if (v->vc == NULL || v->vdec == NULL || v->vs < 0) return;
  const int mode = as_video_decode_mode();
  if (mode == 0) { v->decided = 1; return; }
  // Without a renderer there is no question to answer yet: stay undecided, so a
  // windowed app that paints its first frame later can still take the GPU. A headless
  // program simply never upgrades (and never pays for a device).
  if (grctx == NULL) return;
  v->decided = 1;

  if (mode == 2) {
    // Ask before committing: without zero-copy the GPU route costs twice what the
    // 8-thread CPU decoder costs, so "hardware" on its own is not an improvement.
    // The device created here is KEPT for the reopen below -- creating a throwaway
    // one would leave a second zero-copy table entry per stream behind.
    v->hw_device = as_video_hw_create(v->vdec, &v->hw_dev11);
    if (v->hw_device == NULL) {
      v->hw_refused = 1;
      if (getenv("AS_VIDEO_DEBUG") != NULL)
        fprintf(stderr, "[video] auto: no usable D3D11VA device, staying in software\n");
      return;
    }
    const int ok = as_video_zc_available(grctx, v->hw_dev11, v->w, v->h, v->src_10bit);
    if (!ok) {
      v->hw_refused = 1;
      as_video_hw_detach(v);   // drops the device AND its table entry
      if (getenv("AS_VIDEO_DEBUG") != NULL)
        fprintf(stderr, "[video] auto: zero-copy unavailable, staying in software\n");
      return;
    }
  }
  if (!as_video_open_vdec(v, 1)) return;    // open_vdec already fell back or failed
  if (v->hw_device == NULL) { v->hw_refused = 1; return; }
  // The primed frame came from the software decoder, and so did the audio already in
  // the live buffer: rewind through the normal seek path so nothing is decoded twice.
  v->seek_to = 0.0;
  if (getenv("AS_VIDEO_DEBUG") != NULL)
    fprintf(stderr, "[video] auto: upgraded to GPU decode (%dx%d, %s)\n", v->w, v->h,
            v->src_10bit ? "P010" : "NV12");
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------
static void as_video_free_state(as_video* v) {
  if (getenv("AS_VIDEO_STATS") != NULL && (v->n_vframes > 0 || v->n_aframes > 0)) {
    long long zc_frames = 0, zc_starved = 0;
    sk_video_d3d_stats(&zc_frames, &zc_starved);
    fprintf(stderr,
            "[video] %s video_frames=%lld audio_frames=%lld w=%d h=%d pts=%.3f "
            "threads=%d decode=%s zc=%lld starved=%lld cost/frame: dec=%.2fms conv=%.2fms "
            "upload=%.2fms hw=%.2fms copy=%.2fms\n",
            v->url[0] ? v->url : "?", v->n_vframes, v->n_aframes, v->w, v->h, v->frame_pts,
            v->vc != NULL ? v->vc->thread_count : 0,
            v->zc_used ? "d3d11va-zero-copy" : (v->hw_used ? "d3d11va-readback" : "soft"),
            zc_frames, zc_starved,
            v->n_vframes > 0 ? v->t_dec_ms / (double)v->n_vframes : 0.0,
            v->n_vframes > 0 ? v->t_conv_ms / (double)v->n_vframes : 0.0,
            v->n_vframes > 0 ? v->t_upload_ms / (double)v->n_vframes : 0.0,
            v->n_vframes > 0 ? v->t_hw_ms / (double)v->n_vframes : 0.0,
            v->n_vframes > 0 ? v->t_zc_ms / (double)v->n_vframes : 0.0);
  }
  as_video_drop_image(v);
  while (v->qn > 0) { v->qn--; sk_image_delete((void*)v->qimg[v->qn]); }
  // ORDER MATTERS: the voice reads the live buffer on the mixer thread, so it must
  // stop BEFORE the buffer goes away. Closing the buffer first left the mixer
  // reading freed memory and segfaulted on the fourth stream of a probe loop.
  if (v->audio_voice >= 0) { as_audio_voice_stop(v->audio_voice); v->audio_voice = -1; }
  if (v->audio_buf >= 0) { as_audio_live_close(v->audio_buf); v->audio_buf = -1; }
  if (v->swr != NULL) swr_free(&v->swr);
  if (v->sws != NULL) { sws_freeContext(v->sws); v->sws = NULL; }
  if (v->sws_bgra != NULL) { sws_freeContext(v->sws_bgra); v->sws_bgra = NULL; }
  if (v->frame != NULL) av_frame_free(&v->frame);
  if (v->aframe != NULL) av_frame_free(&v->aframe);
  if (v->sw_frame != NULL) av_frame_free(&v->sw_frame);
  // Drop the zero-copy table entry BEFORE FFmpeg releases the device it names: every
  // image of this stream is already gone (drop_image and the queue above), so Skia's
  // release callbacks have run, and a device that is later re-created at the same
  // address must not inherit this entry's command context and textures.
  if (v->hw_dev11 != NULL) { sk_video_d3d_forget(v->hw_dev11); v->hw_dev11 = NULL; }
  // Our own reference only: the decoder context holds its own, and it is released
  // below by avcodec_free_context.
  if (v->hw_device != NULL) av_buffer_unref(&v->hw_device);
  if (v->pkt != NULL) av_packet_free(&v->pkt);
  if (v->vc != NULL) avcodec_free_context(&v->vc);
  if (v->ac != NULL) avcodec_free_context(&v->ac);
  if (v->i420 != NULL) { free(v->i420); v->i420 = NULL; }
  if (v->bgra != NULL) { free(v->bgra); v->bgra = NULL; }
  if (v->fc != NULL) avformat_close_input(&v->fc);
}

// Decode every frame currently available from one decoder. `emit` is called per
// frame; 'eagain' ending is the normal path, not an error.
static int as_video_drain_video(as_video* v, void* grctx, int* frames_out, double now_ms) {
  int got = 0;
  // An audio-only stream (mp3/ogg/wav) has no video decoder at all: without this the
  // receive call runs NULL and the FIRST demuxed packet segfaults (measured on
  // tone.mp3 in a NetStream with no picture).
  if (v->vc == NULL) { if (frames_out != NULL) *frames_out = 0; return 0; }
  for (;;) {
    const double t_dec0 = as_video_ms();
    int rc = avcodec_receive_frame(v->vc, v->frame);
    v->t_dec_ms += as_video_ms() - t_dec0;
    if (rc == AVERROR(EAGAIN) || rc == AVERROR_EOF) break;
    if (rc < 0) { as_vs_error(v, "video decode", rc); v->failed = 1; break; }
    if (v->frame->format == AV_PIX_FMT_D3D11) {
      // Zero copy first (V3 step 2, video.md §16.9): decoder texture -> D3D12 plane
      // textures -> SkImage, never through system memory. NULL is a normal answer and
      // the readback below is the fallback -- no GPU backend, both texture slots still
      // referenced by Skia, a driver that refused the shared staging texture.
      void* zc_img = NULL;
      if (getenv("AS_VIDEO_DEBUG") != NULL && !v->zc_traced) {
        v->zc_traced = 1;
        fprintf(stderr, "[zc] %s build=%d grctx=%p data0=%p want=%d w=%d h=%d ten=%d\n",
                v->url, AS_VIDEO_ZC, grctx, v->frame->data[0], as_video_zc_wanted(),
                v->frame->width, v->frame->height, as_video_ten_bit(v->frame));
      }
      if (grctx != NULL && v->frame->data[0] != NULL && as_video_zc_wanted()) {
        const double t_z0 = as_video_ms();
        zc_img = sk_video_d3d_image(grctx, (void*)v->frame->data[0],
                                    (int)(intptr_t)v->frame->data[1],
                                    v->frame->width, v->frame->height,
                                    as_video_ten_bit(v->frame), as_video_sk_cs(v->frame));
        v->t_zc_ms += as_video_ms() - t_z0;
        if (zc_img != NULL) {
          v->n_zc++;
          v->zc_used = 1;
          v->hw_used = 1;
          if (as_video_present(v, v->frame, grctx, now_ms, zc_img)) got++;
          av_frame_unref(v->frame);
          continue;
        }
      }
      // GPU -> system memory. Counted apart from `dec` because it is the price of
      // NOT doing zero-copy: measured as the `hw=` column of AS_VIDEO_STATS.
      const double t_hw0 = as_video_ms();
      if (v->sw_frame == NULL) v->sw_frame = av_frame_alloc();
      if (v->sw_frame == NULL) { as_vs_error(v, "hwframe", AVERROR(ENOMEM)); v->failed = 1; break; }
      av_frame_unref(v->sw_frame);
      rc = av_hwframe_transfer_data(v->sw_frame, v->frame, 0);
      v->t_hw_ms += as_video_ms() - t_hw0;
      if (rc < 0) { as_vs_error(v, "hwframe transfer", rc); v->failed = 1; break; }
      // av_hwframe_transfer_data does NOT copy props (hwcontext.c allocates a plain
      // buffer and moves it), and pts/colorspace/color_range live there: skip this
      // and every frame reports pts 0, so NetStream.time freezes at 0.000.
      av_frame_copy_props(v->sw_frame, v->frame);
      v->hw_used = 1;
      if (as_video_present(v, v->sw_frame, grctx, now_ms, NULL)) got++;
    } else if (as_video_present(v, v->frame, grctx, now_ms, NULL)) {
      got++;
    }
    av_frame_unref(v->frame);
  }
  if (frames_out != NULL) *frames_out = got;
  return got;
}

static int as_video_drain_audio(as_video* v) {
  if (v->ac == NULL) return 0;
  for (;;) {
    int rc = avcodec_receive_frame(v->ac, v->aframe);
    if (rc == AVERROR(EAGAIN) || rc == AVERROR_EOF) break;
    if (rc < 0) { as_vs_error(v, "audio decode", rc); break; }
    as_video_audio_out(v, v->aframe);
    av_frame_unref(v->aframe);
  }
  return 0;
}

// Demux one packet and route it to its decoder. Returns 1 when a packet was read,
// 0 at end of file, -1 on a hard error.
static int as_video_next_packet(as_video* v) {
  int rc = av_read_frame(v->fc, v->pkt);
  if (rc == AVERROR_EOF) return 0;
  if (rc < 0) { as_vs_error(v, "read", rc); v->failed = 1; return -1; }
  if (v->pkt->stream_index == v->vs && v->vc != NULL) {
    avcodec_send_packet(v->vc, v->pkt);
    av_packet_unref(v->pkt);
    return 1;
  }
  if (v->pkt->stream_index == v->as && v->ac != NULL) {
    avcodec_send_packet(v->ac, v->pkt);
    av_packet_unref(v->pkt);
    return 1;
  }
  av_packet_unref(v->pkt);   // a stream we do not play (subtitles, data)
  return 1;
}

// Decode until the newest decoded video frame is at least `target_s` (bounded by
// AS_VIDEO_TICK_PACKETS) or the file ends. Called from open (target 0) and tick.
static void as_video_advance(as_video* v, void* grctx, double target_s, double now_ms) {
  if (v->failed) return;
  if (v->vs >= 0 && !v->vc_open) return;   // undecodable stream: open_vdec set the reason
  if (v->seek_to >= 0) {
    int64_t ts = (int64_t)(v->seek_to * (double)AV_TIME_BASE);
    if (av_seek_frame(v->fc, -1, ts, AVSEEK_FLAG_BACKWARD) < 0) v->seek_to = -1;
    else {
      if (v->vc_open && v->vc != NULL) avcodec_flush_buffers(v->vc);
      if (v->ac != NULL) avcodec_flush_buffers(v->ac);
      as_video_drop_image(v);
      while (v->qn > 0) { v->qn--; sk_image_delete((void*)v->qimg[v->qn]); }
      v->has_video = 0;
      v->n_vframes = 0;
      v->decoded_pts = v->seek_to;
      v->frame_pts = v->seek_to;
      v->audio_written = 0;
      if (v->audio_buf >= 0) as_audio_live_rewind(v->audio_buf);
      v->clock0_ms = -1;   // the caller re-anchors on the next tick
      v->eof = 0;
      v->drained = 0;
      v->at_end = 0;
    }
    v->seek_to = -1;
  }
  int budget = AS_VIDEO_TICK_PACKETS;
  // Priming is exempt from the per-tick budget. A frame-threaded decoder emits
  // NOTHING until it has been fed a whole thread queue of frames, and interleaved
  // audio packets eat half the budget, so 24 packets can leave n_vframes at 0 and
  // videoWidth/Height at 0 right after play() -- measured with 8 threads on
  // clip.mp4, whose 1.2 s is short enough that the old budget never filled the
  // pipe. Only the video-having, nothing-decoded-yet case gets the bigger budget;
  // an audio-only stream must not spend it every tick (it would never be spent:
  // vs < 0), and steady state stays at one tick's worth.
  if (v->vs >= 0 && v->n_vframes == 0) budget = AS_VIDEO_PRIME_PACKETS;
  while (budget-- > 0) {
    // PACING IS CHECKED BEFORE THE READ, not after it. A video stream stops feeding
    // as soon as the newest decoded frame is at/past the clock plus the lead:
    // decoding the whole file into the frame pool is exactly the mistake video.md
    // §10.2 warns about. Checking after the read still pulled one frame per tick --
    // harmless at 60 fps, but it ate a 1.2 s clip in a handful of ticks on any
    // tighter frame loop (measured while pumping Stage.dispatchFrame by hand).
    // `n_vframes > 0` keeps the FIRST frame coming: its pts IS 0, so a bare
    // 'decoded_pts >= target_s' would never even open the file.
    if (v->vs >= 0 && v->n_vframes > 0 && v->decoded_pts >= target_s) break;
    if (v->eof) {
      if (!v->drained) {
        if (v->vc != NULL) avcodec_send_packet(v->vc, NULL);
        if (v->ac != NULL) avcodec_send_packet(v->ac, NULL);
        v->drained = 1;
      }
      int n = 0;
      as_video_drain_video(v, grctx, &n, now_ms);
      as_video_drain_audio(v);
      break;
    }
    int got = as_video_next_packet(v);
    if (got == 0) { v->eof = 1; continue; }
    if (got < 0) break;
    as_video_drain_audio(v);
    int n = 0;
    as_video_drain_video(v, grctx, &n, now_ms);
    if (n > 0) v->has_video = 1;
  }
}
// Public seam
// se
// ---------------------------------------------------------------------------
// Opens 'url' and decodes the first video frame so videoWidth/videoHeight and the
// first paint are available immediately. Returns a handle >= 0, or -1 with the
// reason in errbuf. `backend` is "auto" or "soft" (video.md §5.3: no manual
// hwaccel picking); this build has software decode only, so both are accepted and
// identical -- 'auto' simply has nothing to probe yet (V2/V3 add the hwaccel).
int as_video_open(const char* url, const char* backend, const char* formats, char* errbuf, int errlen) {
  (void)formats;   // which codecs exist is a BUILD decision (ffmpeg-static.sh)
  if (url == NULL || url[0] == 0) {
    if (errbuf != NULL) snprintf(errbuf, (size_t)errlen, "empty url");
    return -1;
  }
  int slot = -1;
  for (int i = 0; i < AS_VIDEO_MAX; i++) if (!g_videos[i].used) { slot = i; break; }
  if (slot < 0) {
    if (errbuf != NULL) snprintf(errbuf, (size_t)errlen, "too many concurrent NetStreams (max %d)", AS_VIDEO_MAX);
    return -1;
  }
#ifndef ASC_USE_SKIA
  // Decoding without a renderer would advance NetStream.time and never paint; that
  // is the "compiles, runs, black screen" failure AGENTS.md §1.5 forbids. Refuse the
  // stream instead, with the reason the caller reports verbatim.
  if (errbuf != NULL)
    snprintf(errbuf, (size_t)errlen,
             "this build has no Skia renderer: video frames cannot be shown "
             "(link vendor/skia_glue.cc and define ASC_USE_SKIA)");
  return -1;
#endif
  as_video* v = &g_videos[slot];
  memset(v, 0, sizeof(*v));
  v->vs = -1;
  v->as = -1;
  v->audio_buf = -1;
  v->audio_voice = -1;
  v->seek_to = -1;
  v->clock0_ms = -1;
  snprintf(v->url, sizeof(v->url), "%s", url);

  int rc = avformat_open_input(&v->fc, url, NULL, NULL);
  if (rc < 0) {
    as_vs_error(v, url, rc);
    if (errbuf != NULL) snprintf(errbuf, (size_t)errlen, "%s", v->err);
    return -1;
  }
  rc = avformat_find_stream_info(v->fc, NULL);
  if (rc < 0) {
    as_vs_error(v, "stream info", rc);
    if (errbuf != NULL) snprintf(errbuf, (size_t)errlen, "%s", v->err);
    as_video_free_state(v);
    return -1;
  }
  v->duration_ms = (v->fc->duration > 0 && v->fc->duration != AV_NOPTS_VALUE)
      ? (double)v->fc->duration / 1000.0 : 0.0;

  v->vs = av_find_best_stream(v->fc, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
  if (v->vs < 0) v->vs = -1;
  v->as = av_find_best_stream(v->fc, AVMEDIA_TYPE_AUDIO, -1, -1, NULL, 0);
  if (v->as < 0) v->as = -1;
  if (v->vs < 0 && v->as < 0) {
    snprintf(v->err, sizeof(v->err), "no audio or video stream");
    if (errbuf != NULL) snprintf(errbuf, (size_t)errlen, "%s", v->err);
    as_video_free_state(v);
    return -1;
  }

  if (v->vs >= 0) {
    AVStream* st = v->fc->streams[v->vs];
    const AVCodec* dec = avcodec_find_decoder(st->codecpar->codec_id);
    if (dec == NULL) {
      snprintf(v->err, sizeof(v->err), "no decoder for %s (this build's video-formats may exclude it)",
               avcodec_get_name(st->codecpar->codec_id));
      if (errbuf != NULL) snprintf(errbuf, (size_t)errlen, "%s", v->err);
      as_video_free_state(v);
      return -1;
    }
    v->vc = avcodec_alloc_context3(dec);
    if (v->vc == NULL) { as_video_free_state(v); if (errbuf) snprintf(errbuf, (size_t)errlen, "out of memory"); return -1; }
    avcodec_parameters_to_context(v->vc, st->codecpar);
    v->vc->pkt_timebase = st->time_base;
    // Opened in SOFTWARE here even when the user asked for nothing in particular:
    // the prime below is what makes play() -> BitmapData.draw show a picture, and it
    // happens before any renderer exists. AUTO upgrades at the first frame boundary
    // once it can ask the zero-copy question (as_video_maybe_upgrade). A forced "hw"
    // starts on the GPU right away -- that is an explicit request, not a guess.
    v->vdec = dec;
    // What CAN be known without decoding is the geometry, and it must be reported now:
    // NetStream.videoWidth is expected right after play(), and AIR answers it from the
    // stream parameters, not from a decoded frame.
    if (st->codecpar->width > 0 && st->codecpar->height > 0) {
      v->w = st->codecpar->width;
      v->h = st->codecpar->height;
      v->got_meta = 1;
      v->has_video = 1;
    }
    v->src_10bit = as_pix_fmt_10bit(st->codecpar->format);
    if (!as_video_open_vdec(v, as_video_decode_mode() == 1)) {
      if (errbuf != NULL) snprintf(errbuf, (size_t)errlen, "%s", v->err);
      as_video_free_state(v);
      return -1;
    }
    if (st->avg_frame_rate.num > 0 && st->avg_frame_rate.den > 0)
      v->fps = (double)st->avg_frame_rate.num / (double)st->avg_frame_rate.den;
    if (st->time_base.num > 0 && st->time_base.den > 0)
      v->v_tb = (double)st->time_base.num / (double)st->time_base.den;
    // Normalise to a 0-based presentation timeline: containers with a broadcast
    // epoch (MPEG-TS) carry start_time far from zero, and NetStream.time counts from
    // the first frame, not from the epoch.
    if (st->start_time != AV_NOPTS_VALUE && v->v_tb > 0.0)
      v->v_start = (double)st->start_time * v->v_tb;
  }
  if (v->as >= 0) {
    AVStream* st = v->fc->streams[v->as];
    const AVCodec* dec = avcodec_find_decoder(st->codecpar->codec_id);
    if (dec != NULL) {
      v->ac = avcodec_alloc_context3(dec);
      if (v->ac != NULL) {
        avcodec_parameters_to_context(v->ac, st->codecpar);
        v->ac->pkt_timebase = st->time_base;
        if (avcodec_open2(v->ac, dec, NULL) < 0) { avcodec_free_context(&v->ac); }
      }
    }
    if (v->ac != NULL) {
      v->audio_buf = as_audio_live_open(AS_VIDEO_AUDIO_CH, AS_VIDEO_AUDIO_RATE);
      v->has_audio = (v->audio_buf >= 0);
    }
  }
  v->frame = av_frame_alloc();
  v->aframe = av_frame_alloc();
  v->pkt = av_packet_alloc();
  if (v->frame == NULL || v->aframe == NULL || v->pkt == NULL) {
    if (errbuf != NULL) snprintf(errbuf, (size_t)errlen, "out of memory");
    as_video_free_state(v);
    return -1;
  }
  v->used = 1;
  // Prime: one frame in hand, so play() -> draw is not a black beat. This is a
  // SOFTWARE decode even under AUTO; if the first frame boundary then finds a usable
  // zero-copy route, as_video_maybe_upgrade() re-opens the decoder on the GPU and
  // rewinds through the seek path, so exactly this one decode is repeated.
  as_video_advance(v, NULL, 0.0, -1.0);
  if (v->image != NULL) {
    v->got_meta = 1;
    v->has_video = 1;
  }
  if (errbuf != NULL) errbuf[0] = 0;
  return slot;
}

// ---------------------------------------------------------------------------
// Geometry / metadata (0 until the first frame is decoded)
// ---------------------------------------------------------------------------
void as_video_info(int id, int* w, int* h, double* duration_ms, double* fps, int* has_audio) {
  if (w) *w = 0;
  if (h) *h = 0;
  if (duration_ms) *duration_ms = 0;
  if (fps) *fps = 0;
  if (has_audio) *has_audio = 0;
  if (id < 0 || id >= AS_VIDEO_MAX || !g_videos[id].used) return;
  as_video* v = &g_videos[id];
  if (w) *w = v->w;
  if (h) *h = v->h;
  if (duration_ms) *duration_ms = v->duration_ms;
  if (fps) *fps = v->fps;
  if (has_audio) *has_audio = v->has_audio ? 1 : 0;
}

// Start (or restart) playback. 'vol' comes from NetStream.soundTransform.
// The audio buffer already holds the primed frames, so the mixer starts from 0
// exactly when the video clock starts from 0.
void as_video_play(int id, double now_ms, double vol) {
  if (id < 0 || id >= AS_VIDEO_MAX || !g_videos[id].used) return;
  as_video* v = &g_videos[id];
  v->clock0_ms = now_ms;
  v->paused_at_ms = 0;
  v->vol = vol;
  if (v->has_audio && v->audio_buf >= 0) {
    if (v->audio_voice >= 0) as_audio_voice_stop(v->audio_voice);
    v->audio_voice = as_audio_play(v->audio_buf, 0.0, 0, vol, vol, vol, vol, vol);
  }
}

void as_video_set_paused(int id, int paused, double now_ms) {
  if (id < 0 || id >= AS_VIDEO_MAX || !g_videos[id].used) return;
  as_video* v = &g_videos[id];
  if (paused) {
    if (v->paused_at_ms == 0) v->paused_at_ms = now_ms;
    if (v->audio_voice >= 0) { as_audio_voice_stop(v->audio_voice); v->audio_voice = -1; }
  } else {
    // Shift the clock by the time spent paused: play time must not advance while
    // paused (AIR's 'time' is media position, not wall time since play()).
    if (v->paused_at_ms != 0 && v->clock0_ms >= 0) v->clock0_ms += now_ms - v->paused_at_ms;
    v->paused_at_ms = 0;
    if (v->has_audio && v->audio_buf >= 0 && v->audio_voice < 0) {
      // There is no "resume this voice" in the mixer: a paused voice is stopped and
      // the live buffer is a stream from frame 0, so resuming means starting a new
      // voice at the media position the picture is showing. Nothing was decoded
      // while paused, so the buffer already sits exactly there.
      double at = v->has_video ? v->frame_pts : (double)v->audio_written / (double)AS_VIDEO_AUDIO_RATE;
      v->audio_voice = as_audio_play(v->audio_buf, at * 1000.0, 0, v->vol, v->vol, v->vol, v->vol, v->vol);
    }
  }
}

// Media position in seconds: the pts of the frame on screen. A video-less stream
// reports the audio the mixer has consumed (frames written minus what is still
// ahead of the playhead is not tracked; the demux position IS the playhead once
// the buffer stays small, which is what a bounded decode lead guarantees).
double as_video_time(int id) {
  if (id < 0 || id >= AS_VIDEO_MAX || !g_videos[id].used) return 0.0;
  as_video* v = &g_videos[id];
  if (v->has_video) return v->frame_pts;
  return v->audio_written > 0 ? (double)v->audio_written / (double)AS_VIDEO_AUDIO_RATE : 0.0;
}

int as_video_state(int id) {
  if (id < 0 || id >= AS_VIDEO_MAX || !g_videos[id].used) return AS_VIDEO_ST_FAILED;
  as_video* v = &g_videos[id];
  if (v->failed) return AS_VIDEO_ST_FAILED;
  int s = AS_VIDEO_ST_OPEN;
  if (v->paused_at_ms != 0) s |= AS_VIDEO_ST_PAUSED; else s |= AS_VIDEO_ST_PLAYING;
  if (v->at_end) {
    // Everything consumed. A video stream is done one FRAME PERIOD after the last
    // frame came on screen, not when frame_pts reaches the container duration: the
    // last frame of clip.mp4 sits at 1.133 s in a 1.2 s file, so the old
    // `frame_pts >= duration` test never fired and Play.Stop was never sent. An
    // audio-only file ends when the demuxer is drained and the mixer has the rest.
    s |= AS_VIDEO_ST_ENDED;
    s &= ~AS_VIDEO_ST_PLAYING;
  }
  return s;
}

const char* as_video_error(int id) {
  if (id < 0 || id >= AS_VIDEO_MAX || !g_videos[id].used) return "no such stream";
  return g_videos[id].err[0] ? g_videos[id].err : "";
}

// One frame-boundary step: decode ahead of the presentation clock, then hand back
// the frame that is due. Returns the state bits (as_video_state).
int as_video_tick(int id, void* grctx, double now_ms) {
  if (id < 0 || id >= AS_VIDEO_MAX || !g_videos[id].used) return AS_VIDEO_ST_FAILED;
  as_video* v = &g_videos[id];
  if (v->failed) return AS_VIDEO_ST_FAILED;
  if (v->paused_at_ms != 0) return as_video_state(id);
  // First frame boundary: this is where AUTO can finally answer its one question.
  // Runs before the clock re-anchor so the seek it may trigger is not chased.
  as_video_maybe_upgrade(v, grctx);
  if (v->clock0_ms < 0) v->clock0_ms = now_ms;   // re-anchor after a seek
  double target = (now_ms - v->clock0_ms) / 1000.0;
  if (v->duration_ms > 0 && target > v->duration_ms / 1000.0 + 0.25)
    target = v->duration_ms / 1000.0 + 0.25;    // never chase past the file
  if (!(v->eof && v->drained)) as_video_advance(v, grctx, target + AS_VIDEO_LEAD_S, now_ms);
  // Promote every queued frame whose pts has come due, keeping the LAST one: that is
  // the frame the clock is actually showing. Dropping the rest is the same "behind
  // real time means drop" rule as the queue overflow in as_video_present.
  if (getenv("AS_VIDEO_DEBUG") != NULL)
    fprintf(stderr, "[tick] now=%.1f c0=%.1f target=%.3f cur=%.3f qn=%d q0=%.3f eof=%d\n",
            now_ms, v->clock0_ms, target, v->frame_pts, v->qn, v->qn > 0 ? v->qpts[0] : -1.0, v->eof);
  while (v->qn > 0 && v->qpts[0] <= target + 0.001) {
    as_video_drop_image(v);
    v->image = (void*)v->qimg[0];
    v->frame_pts = v->qpts[0];
    for (int i = 1; i < v->qn; i++) { v->qimg[i - 1] = v->qimg[i]; v->qpts[i - 1] = v->qpts[i]; }
    v->qn--;
  }
  // Audio side: the live buffer must not run dry, but it also must not run minutes
  // ahead of the picture. The demux loop above already keeps them within a packet;
  // this only tops up when the file is decoded far faster than real time (an
  // all-audio stream consumes the whole budget every tick otherwise). Closing it
  // means "no more will be written", so the handle must be dropped at the same
  // time -- leaving it set made as_video_close() close it a SECOND time, a
  // double free that segfaulted the audio-only probe at the end of its loop.
  // End of stream: the last frame is on screen and its display slot has run out.
  // One frame period of tolerance (capped at 200 ms for odd timestamps) is what
  // AIR's NetStream.Play.Stop behaves like -- it fires when the picture has finished
  // showing, not when the file's declared duration is reached.
  if (v->eof && v->drained && v->qn == 0 && !v->at_end) {
    double period = v->fps > 0.0 ? 1.0 / v->fps : 0.2;
    if (period > 0.2) period = 0.2;
    if (!v->has_video || target >= v->decoded_pts + period) v->at_end = 1;
  }
  if (v->has_audio && v->audio_buf >= 0 && v->eof && v->drained) {
    as_audio_live_close(v->audio_buf);
    v->audio_buf = -1;
  }
  return as_video_state(id);
}

// The image to paint now, or NULL before the first frame. NOT a new reference:
// the caller must draw it before the next tick drops it (video.md §10.2 -- the
// owner releases per frame, never holds a pool buffer across frames).
void* as_video_frame(int id) {
  if (id < 0 || id >= AS_VIDEO_MAX || !g_videos[id].used) return NULL;
  return g_videos[id].image;
}

void as_video_seek(int id, double seconds, double now_ms) {
  if (id < 0 || id >= AS_VIDEO_MAX || !g_videos[id].used) return;
  as_video* v = &g_videos[id];
  if (seconds < 0) seconds = 0;
  v->seek_to = seconds;
  v->clock0_ms = now_ms;
  v->paused_at_ms = 0;
  // Drop the audio already buffered past the seek point before the demuxer moves;
  // otherwise the mixer keeps playing the old position for a whole buffer.
  if (v->audio_voice >= 0) { as_audio_voice_stop(v->audio_voice); v->audio_voice = -1; }
  if (v->audio_buf >= 0) as_audio_live_rewind(v->audio_buf);
  v->audio_written = 0;
  as_video_advance(v, NULL, seconds + 0.001, now_ms);
  if (v->has_audio && v->audio_buf >= 0) {
    v->audio_voice = as_audio_play(v->audio_buf, 0.0, 1, v->vol, v->vol, v->vol, v->vol, v->vol);
  }
}

void as_video_close(int id) {
  if (id < 0 || id >= AS_VIDEO_MAX || !g_videos[id].used) return;
  as_video* v = &g_videos[id];
  as_video_free_state(v);
  memset(v, 0, sizeof(*v));
  v->audio_buf = -1;
  v->audio_voice = -1;
  v->vs = -1;
  v->as = -1;
}
