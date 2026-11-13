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
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
#include <libavutil/pixfmt.h>
#include <libavutil/samplefmt.h>
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>

#include <math.h>
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
#else
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
static int as_video_sk_cs(const AVFrame* f) {
  int full = (f->color_range == AVCOL_RANGE_JPEG);
  switch (f->colorspace) {
    case AVCOL_SPC_BT709:
      return full ? 2 /*kRec709_Full*/ : 3 /*kRec709_Limited*/;
    case AVCOL_SPC_BT2020_NCL:
    case AVCOL_SPC_BT2020_CL:
      // 10-bit sources pick the 10-bit pair; the 8-bit one is the common case.
      if (f->format == AV_PIX_FMT_YUV420P10LE || f->format == AV_PIX_FMT_YUV420P10BE)
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
static void as_video_drop_image(as_video* v) {
  if (v->image != NULL) { sk_image_delete(v->image); v->image = NULL; }
}

// Returns 1 when a new image was produced. `grctx` is the backend's
// GrRecordingContext (NULL on a pure-CPU raster build).
static int as_video_present(as_video* v, AVFrame* f, void* grctx, double now_ms) {
  const int w = f->width, h = f->height;
  if (w <= 0 || h <= 0) return 0;
  const int direct = (f->format == AV_PIX_FMT_YUV420P || f->format == AV_PIX_FMT_YUVJ420P);
  const int cv = as_video_sk_cs(f);
  void* img = NULL;
  {
    // Try the GPU entry first even with a NULL context: sk_image_from_yuv_strided
    // returns NULL then, and the fallback below decides.
    if (direct) {
      img = sk_image_from_yuv_strided(grctx, f->data[0], f->linesize[0], f->data[1],
                                      f->linesize[1], f->data[2], f->linesize[2], w, h, cv);
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
      img = sk_image_from_yuv_strided(grctx, v->i420, w, v->i420 + (size_t)w * h, w / 2,
                                      v->i420 + (size_t)w * h * 5 / 4, w / 2, w, h, cv);
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
    img = sk_image_from_argb(v->bgra, w, h);   // copies; BGRA-ordered words as-is
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
// Opening
// ---------------------------------------------------------------------------
static void as_video_free_state(as_video* v) {
  if (getenv("AS_VIDEO_STATS") != NULL && (v->n_vframes > 0 || v->n_aframes > 0)) {
    fprintf(stderr, "[video] %s video_frames=%lld audio_frames=%lld w=%d h=%d pts=%.3f\n",
            v->url[0] ? v->url : "?", v->n_vframes, v->n_aframes, v->w, v->h, v->frame_pts);
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
    int rc = avcodec_receive_frame(v->vc, v->frame);
    if (rc == AVERROR(EAGAIN) || rc == AVERROR_EOF) break;
    if (rc < 0) { as_vs_error(v, "video decode", rc); v->failed = 1; break; }
    if (as_video_present(v, v->frame, grctx, now_ms)) got++;
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
  if (v->seek_to >= 0) {
    int64_t ts = (int64_t)(v->seek_to * (double)AV_TIME_BASE);
    if (av_seek_frame(v->fc, -1, ts, AVSEEK_FLAG_BACKWARD) < 0) v->seek_to = -1;
    else {
      if (v->vc != NULL) avcodec_flush_buffers(v->vc);
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
    if ((rc = avcodec_open2(v->vc, dec, NULL)) < 0) {
      as_vs_error(v, dec->name, rc);
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
  // Prime: one frame in hand, so play() -> draw is not a black beat.
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
