// vendor/audio_glue.c — the audio playback backend for flash.media (阶段九十六).
//
// Why this is a SEPARATE translation unit: miniaudio is a 4.1 MB single header
// whose implementation must be compiled exactly once, and it drags in platform
// audio headers (CoreAudio / ALSA / <emscripten/webaudio.h>) that have no place
// in the generated .c — which stays header-free and readable (AGENTS.md §1.3).
// The generated code only sees the plain-C prototypes in src/runtime.ts.
//
// Backend = miniaudio v0.11.25 (public domain / MIT-0), the decision recorded in
// docs/zh-cn/audio.md §4. It is the ONE implementation that covers native
// (Core Audio) and web (Web Audio / AudioWorklet) and carries its own decoders
// (dr_wav/dr_flac/dr_mp3 are embedded in the single header). Build: add
// `"sources": ["<vendor>/audio_glue.c"]` + the frameworks miniaudio's CoreAudio
// backend needs, plus the define ASC_HAVE_AUDIO.
//
// NOT the vendored SDL2: `vendor/sdl2/arm64/lib/libSDL2.a` contains only
// SDL_dummyaudio.o (measured: zero AudioUnit symbols), so SDL_OpenAudioDevice
// SUCCEEDS and never makes a sound. That silent-success trap is exactly why the
// backend list below is explicit (see as_audio_pick_backends) and why a build
// without ASC_HAVE_AUDIO reports "no backend" instead of pretending.
//
// Threading: the mix callback runs on miniaudio's own audio thread, so it must
// never touch the GC heap (AGENTS.md §2.4 memory red lines). Everything it reads
// lives here: fixed-size voice slots, and PCM buffers that are malloc'd once at
// decode time and never moved or freed (short sound effects; the same
// program-lifetime rule the arena uses — see docs/zh-cn/audio.md §7). Cross-thread
// scalars are C11 atomics; the AS3 runtime polls voice state at frame boundaries
// and is the only place a SOUND_COMPLETE event is dispatched.

#define MINIAUDIO_IMPLEMENTATION
// No capture, no encoding, no resource manager, no custom backends: the smaller
// the compiled surface, the shorter every audio-enabled build. Decoding stays ON
// (that is the whole point of using miniaudio rather than a bare device API).
#define MA_NO_ENCODING
#define MA_NO_CAPTURE
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
#define MA_NO_GENERATION
// MP3 decoding in the float pipeline. miniaudio's bundled dr_mp3 decodes to
// int16 internally unless this is set, which shows up as PCM whose mantissa has
// only ~16 significant bits (measured: the first sample of stereo.mp3 decoded to
// 0x3b660000 where the real value is 0x3b660807). AIR decodes at full float
// precision, extract() is documented to hand out 32-bit floats, and the one
// define costs nothing. It lives here rather than in the generated C because
// this is the only translation unit that includes miniaudio.h.
#define MA_DR_MP3_FLOAT_OUTPUT
#include "miniaudio.h"

#include <math.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// AIR's simultaneous-channel ceiling. play() returns null beyond it (audio.md §5).
#define AS_AUDIO_MAX_VOICES 32
// The mixing rate. miniaudio asks CoreAudio / Web Audio for this rate and both
// resample internally, so the mixer always runs at one known rate and a decoded
// buffer only needs a ratio (see as_voice.step).
#define AS_AUDIO_DEVICE_RATE 44100
// How much mixed output is retained for SoundMixer.computeSpectrum. 4096 frames
// of stereo is ~93 ms at 44.1 kHz, comfortably more than the 512-sample window
// AIR's spectrum needs and small enough to live in static storage.
#define AS_AUDIO_RING_FRAMES 4096
#define AS_AUDIO_RING_MASK (AS_AUDIO_RING_FRAMES - 1)

// ---------------------------------------------------------------------------
// PCM buffer registry
// ---------------------------------------------------------------------------

// ID3v2 tag fields AIR exposes through Sound.id3 / ID3Info. A field is NULL when
// the tag has no such frame and "" when the frame is present but empty -- that
// difference is measured (ffmpeg's ID3v2.3 file reads year=null, lame's ID3v2.4
// file reads year=""), and it is the difference between an absent frame and an
// empty one, so the parse keeps it.
typedef struct {
    char* songName;
    char* artist;
    char* album;
    char* track;
    char* genre;
    char* year;
    char* comment;
} as_id3;

typedef struct {
    float* data;      // interleaved float32, malloc'd at decode time, never freed
    long long frames; // nominal length for MPEG audio (see as_mp3_nominal_frames)
    int channels;
    int rate;
    int used;
    as_id3 id3;
} as_pcm_buf;

static as_pcm_buf g_bufs[64];
static int g_buf_count = 0;

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

typedef struct {
    int buf;                    // -1 = free
    int state;                  // AS_AUDIO_VOICE_*
    _Atomic long long cursor;   // source frame within the current pass (fixed point)
    long long start_frame;      // startTime in source frames
    long long end_frame;        // total frames of the buffer
    int pass;                   // 0-based pass index (passes = loops + 1)
    int loops;
    double step;                // source frames per output frame
    double vol;
    double ltl, ltr, rtl, rtr;  // SoundTransform's 4 gains (AIR's pan is a shorthand)
    _Atomic double peak_l, peak_r;
    int had_peak;
} as_voice;

// Voice lifetime states. The audio thread only ever moves PLAYING -> FINISHED;
// START/STOP/REAP belong to the AS3 frame boundary, which is what keeps the
// "dispatch an event" side single-threaded.
enum { AS_AUDIO_VOICE_FREE = 0, AS_AUDIO_VOICE_PLAYING = 1, AS_AUDIO_VOICE_FINISHED = 2, AS_AUDIO_VOICE_STOPPED = 3 };

static as_voice g_voices[AS_AUDIO_MAX_VOICES];

// ---------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------

static ma_context g_ctx;
static ma_device g_dev;
static int g_ctx_ok = 0;
static int g_dev_ok = 0;
static int g_attempted = 0;
static char g_backend[64] = "none";
static char g_error[256] = "";

static float g_ring[AS_AUDIO_RING_FRAMES * 2];
static _Atomic long long g_ring_write = 0;   // frames written, monotonic

// A plain scalar master gain would lose the pan / leftToRight legs of
// SoundMixer.soundTransform, which are observable through the getter, so the
// mixer keeps the full 2x2 matrix.
static _Atomic double g_mix_vol = 1.0;
static _Atomic double g_mix_ltl = 1.0;
static _Atomic double g_mix_ltr = 0.0;
static _Atomic double g_mix_rtl = 0.0;
static _Atomic double g_mix_rtr = 1.0;

// The backend list. NULL (miniaudio's dummy backend) is deliberately NOT in the
// default set: it makes ma_device_start() succeed while producing no sound, which
// would be a silent lie. It is selectable only through ASC_AUDIO_NULL=1, which the
// regression harness sets to get deterministic, hardware-free timing.
static const ma_backend* as_audio_pick_backends(ma_uint32* count) {
    static const ma_backend real[] = {
#if defined(__APPLE__)
        ma_backend_coreaudio,
#elif defined(__EMSCRIPTEN__)
        ma_backend_webaudio,
#elif defined(_WIN32)
        ma_backend_wasapi, ma_backend_dsound, ma_backend_winmm,
#else
        ma_backend_pulseaudio, ma_backend_alsa, ma_backend_jack,
#endif
    };
    static const ma_backend dummy[] = { ma_backend_null };
    const char* force = getenv("ASC_AUDIO_NULL");
    if (force != NULL && force[0] == '1') {
        *count = (ma_uint32)(sizeof(dummy) / sizeof(dummy[0]));
        return dummy;
    }
    *count = (ma_uint32)(sizeof(real) / sizeof(real[0]));
    return real;
}

static void as_audio_mix(ma_device* dev, void* out, const void* in, ma_uint32 frames);

// Open the playback device. Idempotent: the first caller pays for it, later ones
// get the cached result. Returns 1 when a real device is running. Failure is
// recorded in g_error so the AS3 side can report it verbatim rather than
// pretending the sound played (AGENTS.md §1.5).
static int as_audio_ensure(void) {
    if (g_attempted) return g_dev_ok;
    g_attempted = 1;
    ma_uint32 nbe = 0;
    const ma_backend* bes = as_audio_pick_backends(&nbe);
    ma_context_config ccfg = ma_context_config_init();
    ma_result r = ma_context_init(bes, nbe, &ccfg, &g_ctx);
    if (r != MA_SUCCESS) {
        snprintf(g_error, sizeof(g_error), "ma_context_init failed (%d: %s)", (int)r, ma_result_description(r));
        strcpy(g_backend, "none");
        return 0;
    }
    g_ctx_ok = 1;
    snprintf(g_backend, sizeof(g_backend), "%s", ma_get_backend_name(g_ctx.backend));
    ma_device_config dcfg = ma_device_config_init(ma_device_type_playback);
    dcfg.playback.format = ma_format_f32;
    dcfg.playback.channels = 2;
    dcfg.periodSizeInFrames = 1024;
    dcfg.sampleRate = AS_AUDIO_DEVICE_RATE;
    dcfg.dataCallback = as_audio_mix;
    dcfg.pUserData = NULL;
    r = ma_device_init(&g_ctx, &dcfg, &g_dev);
    if (r != MA_SUCCESS) {
        snprintf(g_error, sizeof(g_error), "ma_device_init failed (%d: %s)", (int)r, ma_result_description(r));
        return 0;
    }
    g_dev_ok = 1;
    r = ma_device_start(&g_dev);
    if (r != MA_SUCCESS) {
        snprintf(g_error, sizeof(g_error), "ma_device_start failed (%d: %s)", (int)r, ma_result_description(r));
        g_dev_ok = 0;
        return 0;
    }
    return 1;
}

void as_audio_shutdown(void) {
    if (g_dev_ok) ma_device_uninit(&g_dev);
    if (g_ctx_ok) ma_context_uninit(&g_ctx);
    g_dev_ok = 0;
    g_ctx_ok = 0;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

// --- MPEG audio nominal length ---------------------------------------------
// AIR's Sound.length is the NOMINAL duration of an MPEG stream: every MPEG frame
// counts as its full sample count (1152 for MPEG-1 layer III, 576 for MPEG-2/2.5)
// INCLUDING the Xing/Info frame that carries only metadata. Measured on
// adl 51.4.1: flap.mp3 has 16 frames (15 audio + 1 Info) -> 18432 samples ->
// 417.9591836734694 ms, while the gapless-trimmed decode is 15105 samples
// (342.5 ms). Nominal is what `length` reports, what `extract` copies out
// (measured: the whole file -> 147456 bytes = 18432 stereo frames) and what AIR
// plays to (446 ms to soundComplete for that 417.96 ms sound), so a decoded MPEG
// stream is padded with silence up to its nominal length.
static const int as_mp3_br_v1l3[16] = {0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,-1};
static const int as_mp3_br_v2l3[16] = {0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,-1};
static const int as_mp3_sr_v1[4] = {44100,48000,32000,0};
static const int as_mp3_sr_v2[4] = {22050,24000,16000,0};

// Total sample count of the MPEG audio frames in an image, or 0 when the bytes
// are not MPEG audio (a WAV/FLAC image reports its real decoded length instead).
static long long as_mp3_nominal_frames(const unsigned char* b, unsigned size) {
    long long off = 0;
    if (size > 10 && b[0] == 'I' && b[1] == 'D' && b[2] == '3') {
        off = 10 + (((long long)(b[6] & 0x7F) << 21) | ((long long)(b[7] & 0x7F) << 14) |
                    ((long long)(b[8] & 0x7F) << 7) | (long long)(b[9] & 0x7F));
    }
    long long samples = 0;
    // Walk frame header to frame header. A slice that starts mid-frame (a Sound
    // built from a ByteArray offset, measured on adl: bytes 1000..4000 of a
    // 6686-byte file reads 182.857 ms = 7 frames) has to RESYNC byte by byte,
    // otherwise the walk either stops at once or loses every frame up to the
    // first byte where the next header happens to line up.
    while (off + 4 <= (long long)size) {
        const unsigned char* p = b + off;
        if (p[0] != 0xFF || (p[1] & 0xE0) != 0xE0) { off++; continue; }
        int ver = (p[1] >> 3) & 3;    // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
        int layer = (p[1] >> 1) & 3;  // 1 = layer III
        int brIdx = (p[2] >> 4) & 0xF;
        int srIdx = (p[2] >> 2) & 3;
        int pad = (p[2] >> 1) & 1;
        if (layer != 1 || brIdx == 0 || brIdx == 15 || srIdx == 3) { off++; continue; }
        int len;
        if (ver == 3) {
            int bitrate = as_mp3_br_v1l3[brIdx];
            len = (144000 * bitrate) / as_mp3_sr_v1[srIdx] + pad;
            if (len <= 4) { off++; continue; }
            // A header whose frame runs past the end still counts, then the walk
            // stops: measured on adl, bytes 1000..4000 of the 16-frame pass.mp3
            // read 182.857 ms, i.e. 7 frames -- the 7th header sits inside the
            // slice but its frame ends past it.
            samples += 1152;
            if (off + len > (long long)size) break;
        } else {
            int bitrate = as_mp3_br_v2l3[brIdx];
            len = (72000 * bitrate) / as_mp3_sr_v2[srIdx] + pad;
            if (len <= 4) { off++; continue; }
            samples += 576;
            if (off + len > (long long)size) break;
        }
        off += len;
    }
    return samples;
}

// --- ID3v2 ------------------------------------------------------------------
// Enough of ID3v2.3/v2.4 to fill ID3Info the way AIR does. The strings land in
// long-lived malloc'd UTF-8 because the runtime's strings are UTF-8 while a tag
// may be latin-1 or UTF-16.
static long long as_id3_synchsafe(const unsigned char* p) {
    return ((long long)(p[0] & 0x7F) << 21) | ((long long)(p[1] & 0x7F) << 14) |
           ((long long)(p[2] & 0x7F) << 7) | (long long)(p[3] & 0x7F);
}

// Decode `len` bytes of an ID3 text payload (the encoding byte is already
// consumed) into a fresh UTF-8 string. Trailing NULs are dropped; interior NULs
// end the string, which is how a COMM frame's description separator is handled.
static char* as_id3_text_utf8(int enc, const unsigned char* p, long len) {
    // Worst case: every UTF-16 unit becomes 3 UTF-8 bytes.
    char* out = (char*)malloc((size_t)len * 3 + 4);
    if (out == NULL) return NULL;
    long n = 0;
    if (enc == 0 || enc == 3) {
        for (long i = 0; i < len; i++) {
            unsigned char c = p[i];
            if (c == 0) break;
            if (enc == 0 && c >= 0x80) {  // latin-1 -> UTF-8
                out[n++] = (char)(0xC0 | (c >> 6));
                out[n++] = (char)(0x80 | (c & 0x3F));
            } else {
                out[n++] = (char)c;
            }
        }
    } else {
        long i = 0;
        if (len >= 2 && ((p[0] == 0xFF && p[1] == 0xFE) || (p[0] == 0xFE && p[1] == 0xFF))) {
            int be = (p[0] == 0xFE);
            for (i = 2; i + 1 < len; i += 2) {
                unsigned int u = be ? (((unsigned)p[i] << 8) | p[i + 1]) : (((unsigned)p[i + 1] << 8) | p[i]);
                if (u == 0) break;
                if (u < 0x80) { out[n++] = (char)u; }
                else if (u < 0x800) { out[n++] = (char)(0xC0 | (u >> 6)); out[n++] = (char)(0x80 | (u & 0x3F)); }
                else { out[n++] = (char)(0xE0 | (u >> 12)); out[n++] = (char)(0x80 | ((u >> 6) & 0x3F)); out[n++] = (char)(0x80 | (u & 0x3F)); }
            }
        } else {
            int be = (enc == 2);
            for (i = 0; i + 1 < len; i += 2) {
                unsigned int u = be ? (((unsigned)p[i] << 8) | p[i + 1]) : (((unsigned)p[i + 1] << 8) | p[i]);
                if (u == 0) break;
                if (u < 0x80) { out[n++] = (char)u; }
                else if (u < 0x800) { out[n++] = (char)(0xC0 | (u >> 6)); out[n++] = (char)(0x80 | (u & 0x3F)); }
                else { out[n++] = (char)(0xE0 | (u >> 12)); out[n++] = (char)(0x80 | ((u >> 6) & 0x3F)); out[n++] = (char)(0x80 | (u & 0x3F)); }
            }
        }
    }
    out[n] = 0;
    return out;
}

// ID3v1(.1): the 128-byte block at the END of the file. AIR merges it with the
// ID3v2 tag FIELD BY FIELD, ID3v2 winning (measured with a hand-built file that
// carries both: the ID3v2 TIT2 provided songName while artist/album/track/genre
// came from the ID3v1 block).
static char* as_id3_v1_field(const unsigned char* p, int len) {
    while (len > 0 && (p[len - 1] == 0 || p[len - 1] == ' ')) len--;
    char* out = (char*)malloc((size_t)len * 2 + 1);
    if (out == NULL) return NULL;
    long n = 0;
    for (int i = 0; i < len; i++) {
        unsigned char c = p[i];
        if (c >= 0x80) {  // latin-1 -> UTF-8
            out[n++] = (char)(0xC0 | (c >> 6));
            out[n++] = (char)(0x80 | (c & 0x3F));
        } else {
            out[n++] = (char)c;
        }
    }
    out[n] = 0;
    return out;
}

static void as_id3_parse_v1(const unsigned char* b, unsigned size, as_id3* out) {
    if (size < 128) return;
    const unsigned char* p = b + size - 128;
    if (p[0] != 'T' || p[1] != 'A' || p[2] != 'G') return;
    char* v;
    if (out->songName == NULL && (v = as_id3_v1_field(p + 3, 30)) != NULL) out->songName = v;
    if (out->artist == NULL && (v = as_id3_v1_field(p + 33, 30)) != NULL) out->artist = v;
    if (out->album == NULL && (v = as_id3_v1_field(p + 63, 30)) != NULL) out->album = v;
    if (out->year == NULL && (v = as_id3_v1_field(p + 93, 4)) != NULL) out->year = v;
    // ID3v1.1 splits the comment: 28 bytes + NUL + the track number.
    int commentLen = 30;
    if (p[125] == 0 && p[126] != 0) {
        commentLen = 28;
        if (out->track == NULL) {
            char* t = (char*)malloc(8);
            if (t != NULL) {
                snprintf(t, 8, "%d", (int)p[126]);
                out->track = t;
            }
        }
    }
    if (out->comment == NULL && (v = as_id3_v1_field(p + 97, commentLen)) != NULL) out->comment = v;
    // The genre is a NUMBER, not a name: AIR reports the raw index as a string
    // (measured: the byte 255 of an untagged-genre file reads "255").
    if (out->genre == NULL) {
        char* g = (char*)malloc(8);
        if (g != NULL) {
            snprintf(g, 8, "%d", (int)p[127]);
            out->genre = g;
        }
    }
}

static void as_id3_parse(const unsigned char* b, unsigned size, as_id3* out) {
    memset(out, 0, sizeof(*out));
    if (size < 10 || b[0] != 'I' || b[1] != 'D' || b[2] != '3') {
        as_id3_parse_v1(b, size, out);
        return;
    }
    int major = b[3];
    long long tagSize = as_id3_synchsafe(b + 6);
    long long end = 10 + tagSize;
    if (end > (long long)size) end = (long long)size;
    long long p = 10;
    // Flags bit 0x40 = extended header. v2.3 counts the extended header WITHOUT
    // its own size field, v2.4 counts it WITH, so skip it explicitly.
    if ((b[5] & 0x40) != 0 && p + 4 <= end) {
        long long ext = (major >= 4) ? as_id3_synchsafe(b + p) : ((long long)b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]);
        p += (major >= 4) ? ext : ext + 4;
    }
    while (p + 10 <= end) {
        if (b[p] == 0) break;  // padding
        char id[5] = {(char)b[p], (char)b[p + 1], (char)b[p + 2], (char)b[p + 3], 0};
        long long fsize = (major >= 4) ? as_id3_synchsafe(b + p + 4)
                                       : ((long long)b[p + 4] << 24 | b[p + 5] << 16 | b[p + 6] << 8 | b[p + 7]);
        long long d = p + 10;
        if (fsize <= 0 || d + fsize > (long long)size) break;
        char** slot = NULL;
        if (strcmp(id, "TIT2") == 0) slot = &out->songName;
        else if (strcmp(id, "TPE1") == 0) slot = &out->artist;
        else if (strcmp(id, "TALB") == 0) slot = &out->album;
        else if (strcmp(id, "TRCK") == 0) slot = &out->track;
        else if (strcmp(id, "TCON") == 0) slot = &out->genre;
        else if (strcmp(id, "TYER") == 0 || strcmp(id, "TDRC") == 0) slot = &out->year;
        else if (strcmp(id, "COMM") == 0) slot = &out->comment;
        if (slot != NULL && *slot == NULL) {
            int enc = b[d];
            long long body = d + 1;
            if (strcmp(id, "COMM") == 0) {
                // encoding + 3-byte language + a NUL-terminated short description,
                // then the actual comment.
                body += 3;
                if (enc == 0 || enc == 3) {
                    while (body < d + fsize && b[body] != 0) body++;
                    body += 1;
                } else {
                    while (body + 1 < d + fsize && !(b[body] == 0 && b[body + 1] == 0)) body += 2;
                    body += 2;
                }
            }
            if (body <= d + fsize) *slot = as_id3_text_utf8(enc, b + body, (long)(d + fsize - body));
        }
        p = d + fsize;
    }
    // ID3v1 fills whatever the ID3v2 tag did not define.
    as_id3_parse_v1(b, size, out);
}

// Decode a compressed file image (MP3/WAV/FLAC) held in memory into float32 PCM.
// Synchronous, exactly like Sound.loadCompressedDataFromByteArray (audio.md §5):
// the caller gets a buffer id, or -1 with the reason in as_audio_last_error().
int as_audio_decode(const void* data, unsigned int size) {
    if (g_buf_count >= (int)(sizeof(g_bufs) / sizeof(g_bufs[0]))) return -1;
    if (data == NULL || size == 0) return -1;
    ma_decoder dec;
    ma_decoder_config cfg = ma_decoder_config_init(ma_format_f32, 0, 0);
    ma_result r = ma_decoder_init_memory(data, (size_t)size, &cfg, &dec);
    if (r != MA_SUCCESS && r != MA_AT_END) {
        snprintf(g_error, sizeof(g_error), "decode failed (%d: %s)", (int)r, ma_result_description(r));
        return -1;
    }
    ma_uint64 total = 0;
    if (ma_decoder_get_length_in_pcm_frames(&dec, &total) != MA_SUCCESS) total = 0;
    // Some MP3 streams report no length (no Xing header and an inconclusive
    // bitrate scan). Grow into a reasonable estimate, then decode for real.
    long long cap = (long long)total;
    if (cap <= 0) cap = (long long)dec.outputSampleRate * 60;  // up to a minute
    int channels = (int)dec.outputChannels > 0 ? (int)dec.outputChannels : 1;
    float* pcm = (float*)malloc((size_t)cap * (size_t)channels * sizeof(float));
    if (pcm == NULL) {
        ma_decoder_uninit(&dec);
        snprintf(g_error, sizeof(g_error), "out of memory for %lld frames", cap);
        return -1;
    }
    long long got = 0;
    for (;;) {
        if (got >= cap) {
            cap = cap * 2;
            float* grown = (float*)realloc(pcm, (size_t)cap * (size_t)channels * sizeof(float));
            if (grown == NULL) break;
            pcm = grown;
        }
        ma_uint64 n = 0;
        ma_result rr = ma_decoder_read_pcm_frames(&dec, pcm + (size_t)got * (size_t)channels,
                                                  (ma_uint64)(cap - got), &n);
        got += (long long)n;
        if (rr != MA_SUCCESS && rr != MA_AT_END) break;
        if (n == 0) break;
    }
    ma_decoder_uninit(&dec);
    if (got <= 0) {
        free(pcm);
        snprintf(g_error, sizeof(g_error), "decoder produced no frames");
        return -1;
    }
    // Pad an MPEG stream up to its nominal length (see as_mp3_nominal_frames).
    // The guard keeps a bogus walk from allocating wildly: the difference has to
    // stay under ten seconds of audio.
    long long nominal = as_mp3_nominal_frames((const unsigned char*)data, size);
    if (nominal > got && nominal - got < (long long)dec.outputSampleRate * 10) {
        float* padded = (float*)realloc(pcm, (size_t)nominal * (size_t)channels * sizeof(float));
        if (padded != NULL) {
            memset(padded + (size_t)got * (size_t)channels, 0, (size_t)(nominal - got) * (size_t)channels * sizeof(float));
            pcm = padded;
            got = nominal;
        }
    }
    int id = g_buf_count++;
    g_bufs[id].data = pcm;
    g_bufs[id].frames = got;
    g_bufs[id].channels = channels;
    g_bufs[id].rate = (int)dec.outputSampleRate > 0 ? (int)dec.outputSampleRate : 44100;
    g_bufs[id].used = 1;
    as_id3_parse((const unsigned char*)data, size, &g_bufs[id].id3);
    return id;
}

int as_audio_buf_valid(int buf);

// One ID3Info field of a decoded buffer: 0 songName, 1 artist, 2 album, 3 track,
// 4 genre, 5 year, 6 comment. NULL when the tag has no such frame.
const char* as_audio_id3_field(int buf, int which) {
    if (!as_audio_buf_valid(buf)) return NULL;
    switch (which) {
        case 0: return g_bufs[buf].id3.songName;
        case 1: return g_bufs[buf].id3.artist;
        case 2: return g_bufs[buf].id3.album;
        case 3: return g_bufs[buf].id3.track;
        case 4: return g_bufs[buf].id3.genre;
        case 5: return g_bufs[buf].id3.year;
        case 6: return g_bufs[buf].id3.comment;
        default: return NULL;
    }
}

// Register an already-decoded PCM image (Sound.loadPCMFromByteArray, phase D).
// The samples are copied into the same never-freed shape as a decoded file.
int as_audio_register_pcm(const float* pcm, long long frames, int channels, int rate) {
    if (pcm == NULL || frames <= 0 || channels <= 0 || rate <= 0) return -1;
    if (g_buf_count >= (int)(sizeof(g_bufs) / sizeof(g_bufs[0]))) return -1;
    float* copy = (float*)malloc((size_t)frames * (size_t)channels * sizeof(float));
    if (copy == NULL) return -1;
    memcpy(copy, pcm, (size_t)frames * (size_t)channels * sizeof(float));
    int id = g_buf_count++;
    g_bufs[id].data = copy;
    g_bufs[id].frames = frames;
    g_bufs[id].channels = channels;
    g_bufs[id].rate = rate;
    g_bufs[id].used = 1;
    return id;
}

int as_audio_buf_valid(int buf) { return buf >= 0 && buf < g_buf_count && g_bufs[buf].used; }
long long as_audio_buf_frames(int buf) { return as_audio_buf_valid(buf) ? g_bufs[buf].frames : 0; }
int as_audio_buf_channels(int buf) { return as_audio_buf_valid(buf) ? g_bufs[buf].channels : 0; }
int as_audio_buf_rate(int buf) { return as_audio_buf_valid(buf) ? g_bufs[buf].rate : 0; }
const float* as_audio_buf_data(int buf) { return as_audio_buf_valid(buf) ? g_bufs[buf].data : NULL; }
// Duration in milliseconds (Sound.length). Float math: AIR reports a fractional
// millisecond value, not a rounded one.
double as_audio_buf_ms(int buf) {
    if (!as_audio_buf_valid(buf) || g_bufs[buf].rate <= 0) return 0.0;
    return (double)g_bufs[buf].frames * 1000.0 / (double)g_bufs[buf].rate;
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

// Start a voice. `startMs` is skipped by seeking; `loops` is AIR's "number of
// times to loop back to startTime" (so loops=0 plays once). The four gains come
// from SoundTransform verbatim (AIR's `pan` is only a shorthand that writes
// leftToLeft = sqrt(1-pan) / rightToRight = sqrt(1+pan)); the runtime quantizes
// them the way AIR's mixer does before calling here, so the mixer never has to
// re-derive anything. Returns the voice id, or -1 when every channel is busy.
int as_audio_play(int buf, double startMs, int loops, double vol, double ltl, double ltr, double rtl, double rtr) {
    if (!as_audio_ensure()) return -1;
    if (!as_audio_buf_valid(buf)) return -1;
    int v = -1;
    for (int i = 0; i < AS_AUDIO_MAX_VOICES; i++) {
        if (g_voices[i].state == AS_AUDIO_VOICE_FREE) { v = i; break; }
    }
    if (v < 0) return -1;
    as_voice* vo = &g_voices[v];
    long long start_frame = (long long)(startMs / 1000.0 * (double)g_bufs[buf].rate);
    if (start_frame < 0) start_frame = 0;
    // startTime at or past the end: the voice is already over, so it finishes on
    // the first mix block instead of playing. (adl 51.4.1 HANGS on
    // play(length) -- measured -- and reproducing a hang is not an option.)
    if (start_frame > g_bufs[buf].frames) start_frame = g_bufs[buf].frames;
    vo->buf = buf;
    vo->start_frame = start_frame;
    vo->end_frame = g_bufs[buf].frames;
    vo->pass = 0;
    vo->loops = loops < 0 ? 0 : loops;
    vo->step = (double)g_bufs[buf].rate / (double)AS_AUDIO_DEVICE_RATE;
    vo->vol = vol;
    vo->ltl = ltl;
    vo->ltr = ltr;
    vo->rtl = rtl;
    vo->rtr = rtr;
    vo->had_peak = 0;
    atomic_store(&vo->cursor, start_frame);
    atomic_store(&vo->peak_l, 0.0);
    atomic_store(&vo->peak_r, 0.0);
    vo->state = AS_AUDIO_VOICE_PLAYING;
    return v;
}

void as_audio_voice_stop(int v) {
    if (v < 0 || v >= AS_AUDIO_MAX_VOICES) return;
    if (g_voices[v].state == AS_AUDIO_VOICE_PLAYING || g_voices[v].state == AS_AUDIO_VOICE_FINISHED) {
        g_voices[v].state = AS_AUDIO_VOICE_STOPPED;
    }
}

// Frame-boundary reap: release a slot whose SOUND_COMPLETE has been dispatched.
void as_audio_voice_reap(int v) {
    if (v < 0 || v >= AS_AUDIO_MAX_VOICES) return;
    if (g_voices[v].state != AS_AUDIO_VOICE_PLAYING) {
        g_voices[v].state = AS_AUDIO_VOICE_FREE;
        g_voices[v].buf = -1;
    }
}

// The buffer a voice plays: SoundChannel__voiceDone uses it to leave `position`
// at the END of the sound, which is what AIR reports after soundComplete
// (measured: 417.96 == Sound.length for a 417.96 ms sound).
int as_audio_voice_buf(int v) {
    if (v < 0 || v >= AS_AUDIO_MAX_VOICES) return -1;
    return g_voices[v].buf;
}

int as_audio_voice_state(int v) {
    if (v < 0 || v >= AS_AUDIO_MAX_VOICES) return AS_AUDIO_VOICE_FREE;
    return g_voices[v].state;
}

// Position in milliseconds within the current pass. Meaningful while playing;
// after a stop the AS3 side keeps the last value it read (audio.md §5), so this
// is only consulted for a live voice.
double as_audio_voice_pos_ms(int v) {
    if (v < 0 || v >= AS_AUDIO_MAX_VOICES) return 0.0;
    as_voice* vo = &g_voices[v];
    if (vo->buf < 0 || !as_audio_buf_valid(vo->buf)) return 0.0;
    // Absolute within the sound, NOT relative to startTime: measured
    // play(100).position == 100 on the first read. A looping voice reports the
    // position inside the current pass because the cursor restarts at
    // start_frame on every pass.
    long long c = atomic_load(&vo->cursor);
    double ms = (double)c * 1000.0 / (double)g_bufs[vo->buf].rate;
    return ms < 0.0 ? 0.0 : ms;
}

void as_audio_voice_transform(int v, double vol, double ltl, double ltr, double rtl, double rtr) {
    if (v < 0 || v >= AS_AUDIO_MAX_VOICES) return;
    as_voice* vo = &g_voices[v];
    vo->vol = vol;
    vo->ltl = ltl;
    vo->ltr = ltr;
    vo->rtl = rtl;
    vo->rtr = rtr;
}

double as_audio_voice_left_peak(int v) {
    if (v < 0 || v >= AS_AUDIO_MAX_VOICES) return 0.0;
    return atomic_load(&g_voices[v].peak_l);
}
double as_audio_voice_right_peak(int v) {
    if (v < 0 || v >= AS_AUDIO_MAX_VOICES) return 0.0;
    return atomic_load(&g_voices[v].peak_r);
}

int as_audio_active(void) {
    int n = 0;
    for (int i = 0; i < AS_AUDIO_MAX_VOICES; i++) {
        if (g_voices[i].state == AS_AUDIO_VOICE_PLAYING) n++;
    }
    return n;
}

void as_audio_stop_all(void) {
    for (int i = 0; i < AS_AUDIO_MAX_VOICES; i++) {
        if (g_voices[i].state == AS_AUDIO_VOICE_PLAYING || g_voices[i].state == AS_AUDIO_VOICE_FINISHED) {
            g_voices[i].state = AS_AUDIO_VOICE_STOPPED;
        }
    }
}

// SoundMixer.soundTransform setter. All five values arrive already quantized
// (the AS3 side does that once, on the main thread), so the audio thread only has
// to load them.
void as_audio_set_mix(double vol, double ltl, double ltr, double rtl, double rtr) {
    atomic_store(&g_mix_vol, vol);
    atomic_store(&g_mix_ltl, ltl);
    atomic_store(&g_mix_ltr, ltr);
    atomic_store(&g_mix_rtl, rtl);
    atomic_store(&g_mix_rtr, rtr);
}

// Readiness OPENS the device on first ask (idempotent, cached): the AS3 side
// asks exactly when it is about to play, and a `g_dev_ok` that stayed 0 until
// as_audio_play() would make the very first play() return null on a machine with
// a perfectly good sound card.
int as_audio_ready(void) { return as_audio_ensure(); }
const char* as_audio_backend(void) { return g_backend; }
const char* as_audio_last_error(void) { return g_error[0] ? g_error : NULL; }

// ---------------------------------------------------------------------------
// Mix callback (miniaudio's audio thread)
// ---------------------------------------------------------------------------

static double as_audio_buf_sample(const as_pcm_buf* b, long long frame, int ch) {
    if (frame < 0) frame = 0;
    if (frame >= b->frames) frame = b->frames - 1;
    if (b->channels == 1) return (double)b->data[frame];
    if (ch >= b->channels) ch = b->channels - 1;
    return (double)b->data[frame * (long long)b->channels + ch];
}

static void as_audio_mix(ma_device* dev, void* out, const void* in, ma_uint32 frames) {
    (void)dev;
    (void)in;
    float* o = (float*)out;
    memset(o, 0, (size_t)frames * 2 * sizeof(float));
    // Peaks are per block (see the voice loop), so each voice resets its own.
    double mix_ltl = atomic_load(&g_mix_ltl), mix_ltr = atomic_load(&g_mix_ltr);
    double mix_rtl = atomic_load(&g_mix_rtl), mix_rtr = atomic_load(&g_mix_rtr);
    for (int vi = 0; vi < AS_AUDIO_MAX_VOICES; vi++) {
        as_voice* vo = &g_voices[vi];
        if (vo->state != AS_AUDIO_VOICE_PLAYING) continue;
        if (vo->buf < 0 || !as_audio_buf_valid(vo->buf)) { vo->state = AS_AUDIO_VOICE_FINISHED; continue; }
        const as_pcm_buf* b = &g_bufs[vo->buf];
        double cursor = (double)atomic_load(&vo->cursor);
        // Peaks are the maxima of the block being mixed, NOT a running maximum:
        // measured on adl, a sound whose mid-play leftPeak was 0.5029 reported
        // 0.0065 (the last block's peak) after soundComplete.
        double peak_l = 0.0;
        double peak_r = 0.0;
        int finished = 0;
        for (ma_uint32 i = 0; i < frames; i++) {
            if (cursor >= (double)vo->end_frame) {
                if (vo->pass < vo->loops) {
                    vo->pass++;
                    cursor = (double)vo->start_frame;
                } else {
                    finished = 1;
                    break;
                }
            }
            long long f0 = (long long)cursor;
            double frac = cursor - (double)f0;
            double sl = as_audio_buf_sample(b, f0, 0);
            double sr = as_audio_buf_sample(b, f0, 1);
            if (b->channels == 1) {
                sl = sr = as_audio_buf_sample(b, f0, 0);
            } else {
                double sl2 = as_audio_buf_sample(b, f0 + 1, 0);
                double sr2 = as_audio_buf_sample(b, f0 + 1, 1);
                sl += (sl2 - sl) * frac;
                sr += (sr2 - sr) * frac;
            }
            double l = (sl * vo->ltl + sr * vo->rtl) * vo->vol;
            double r = (sr * vo->rtr + sl * vo->ltr) * vo->vol;
            double pl = l < 0.0 ? -l : l;
            double pr = r < 0.0 ? -r : r;
            if (pl > peak_l) peak_l = pl;
            if (pr > peak_r) peak_r = pr;
            o[(size_t)i * 2] += (float)l;
            o[(size_t)i * 2 + 1] += (float)r;
            cursor += vo->step;
        }
        atomic_store(&vo->cursor, (long long)cursor);
        if (peak_l > 1.0) peak_l = 1.0;
        if (peak_r > 1.0) peak_r = 1.0;
        atomic_store(&vo->peak_l, peak_l);
        atomic_store(&vo->peak_r, peak_r);
        if (finished) vo->state = AS_AUDIO_VOICE_FINISHED;
    }
    // Apply SoundMixer.soundTransform to the mixed programme, then clip and
    // publish into the spectrum ring buffer (computeSpectrum reads the programme
    // as it is sent to the device, so the ring stores the post-mixer signal).
    double mix_vol = atomic_load(&g_mix_vol);
    long long w = atomic_load(&g_ring_write);
    for (ma_uint32 i = 0; i < frames; i++) {
        double sl = o[i * 2], sr = o[i * 2 + 1];
        double ml = (sl * mix_ltl + sr * mix_rtl) * mix_vol;
        double mr = (sr * mix_rtr + sl * mix_ltr) * mix_vol;
        float l = (float)ml, r = (float)mr;
        if (l > 1.0f) l = 1.0f; else if (l < -1.0f) l = -1.0f;
        if (r > 1.0f) r = 1.0f; else if (r < -1.0f) r = -1.0f;
        o[i * 2] = l;
        o[i * 2 + 1] = r;
        g_ring[(size_t)((w + i) & AS_AUDIO_RING_MASK) * 2] = l;
        g_ring[(size_t)((w + i) & AS_AUDIO_RING_MASK) * 2 + 1] = r;
    }
    atomic_store(&g_ring_write, w + (long long)frames);
}

// ---------------------------------------------------------------------------
// Spectrum (SoundMixer.computeSpectrum, phase D)
// ---------------------------------------------------------------------------

// Copy the most recent `frames` stereo frames out of the ring. Returns how many
// were actually available. Called on the main thread; the ring is only written by
// the audio thread, so a torn read at the boundary is possible but harmless (a
// spectrum is a sampled view of a continuous signal).
long long as_audio_ring_read(float* dst, long long frames) {
    long long w = atomic_load(&g_ring_write);
    long long avail = w < AS_AUDIO_RING_FRAMES ? w : AS_AUDIO_RING_FRAMES;
    if (frames > avail) frames = avail;
    for (long long i = 0; i < frames; i++) {
        long long idx = (w - frames + i) & AS_AUDIO_RING_MASK;
        dst[i * 2] = g_ring[(size_t)idx * 2];
        dst[i * 2 + 1] = g_ring[(size_t)idx * 2 + 1];
    }
    return frames;
}

// ---------------------------------------------------------------------------
// SoundMixer.computeSpectrum
// ---------------------------------------------------------------------------
// AIR writes 512 float32 values (2048 bytes) for every argument combination
// (measured), laid out as 256 values for the left channel followed by 256 for the
// right, and zero-fills when nothing is playing. Which values depends on fftMode:
//
//   fftMode == false  the WAVEFORM of the most recent 256 frames. Measured with
//                     440 Hz in the left channel and 880 Hz in the right: the two
//                     halves are the two channels of one window (their near-zero
//                     slopes are exactly 2:1) and a 0.5-amplitude sine reports
//                     0.4849853515625 = 15892/32768, i.e. a 16-bit sample read.
//   fftMode == true   256 magnitude bins per channel of a 2048-point FFT over a
//                     Hann window (measured: the 440 Hz tone peaks at bin 19-20,
//                     and 2048 points at 44.1 kHz give 20.4). AIR's magnitude
//                     SCALE also depends on stretchFactor -- 1.1964 for that
//                     0.485-amplitude sine with stretchFactor 2 -- which this
//                     does not reproduce: the magnitudes here are linear and
//                     normalized so a full-scale sine reads 1.0. Documented as a
//                     divergence in docs/zh-cn/audio.md §9.
#define AS_SPEC_BINS 256
#define AS_SPEC_FFT 2048

static void as_spectrum_fft(float* re, float* im, int n) {
    // Bit-reversal permutation, then iterative radix-2 Cooley-Tukey. In-place.
    for (int i = 1, j = 0; i < n; i++) {
        int bit = n >> 1;
        for (; (j & bit) != 0; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            float t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    for (int len = 2; len <= n; len <<= 1) {
        double ang = -2.0 * 3.14159265358979323846 / (double)len;
        double wr = cos(ang), wi = sin(ang);
        for (int i = 0; i < n; i += len) {
            double cr = 1.0, ci = 0.0;
            for (int k = 0; k < len / 2; k++) {
                int a = i + k, b = a + len / 2;
                double xr = (double)re[b] * cr - (double)im[b] * ci;
                double xi = (double)re[b] * ci + (double)im[b] * cr;
                re[b] = re[a] - (float)xr;
                im[b] = im[a] - (float)xi;
                re[a] = re[a] + (float)xr;
                im[a] = im[a] + (float)xi;
                double ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
    }
}

// Fill 512 floats (AIR's payload). Returns the number of values written.
int as_audio_spectrum(float* out, int fftMode, int stretchFactor) {
    (void)stretchFactor;
    if (out == NULL) return 0;
    for (int i = 0; i < AS_SPEC_BINS * 2; i++) out[i] = 0.0f;
    float window[AS_SPEC_FFT * 2];
    int want = fftMode ? AS_SPEC_FFT : AS_SPEC_BINS;
    long long got = as_audio_ring_read(window, want);
    if (got <= 0) return AS_SPEC_BINS * 2;
    if (!fftMode) {
        // Waveform: the most recent 256 frames, left channel then right, read as
        // 16-bit samples (AIR's own quantization: 15892/32768 for a 0.5 sine).
        for (long long i = 0; i < got && i < AS_SPEC_BINS; i++) {
            for (int c = 0; c < 2; c++) {
                float v = window[i * 2 + c];
                if (v > 1.0f) v = 1.0f; else if (v < -1.0f) v = -1.0f;
                short s = (short)(v * 32767.0f);
                out[c * AS_SPEC_BINS + i] = (float)((double)s / 32768.0);
            }
        }
        return AS_SPEC_BINS * 2;
    }
    // FFT: a Hann window per channel, then the first 256 magnitude bins.
    float re[AS_SPEC_FFT], im[AS_SPEC_FFT];
    for (int c = 0; c < 2; c++) {
        for (int i = 0; i < AS_SPEC_FFT; i++) {
            float v = (i < got) ? window[i * 2 + c] : 0.0f;
            double w = 0.5 - 0.5 * cos(2.0 * 3.14159265358979323846 * (double)i / (double)AS_SPEC_FFT);
            re[i] = (float)((double)v * w);
            im[i] = 0.0f;
        }
        as_spectrum_fft(re, im, AS_SPEC_FFT);
        // Normalize so a full-scale sine (amplitude 1.0) reads 1.0: a Hann window
        // halves the coherent gain, and a real DFT splits the amplitude over the
        // positive and negative frequencies, hence N/4.
        for (int k = 0; k < AS_SPEC_BINS; k++) {
            double mag = sqrt((double)re[k] * (double)re[k] + (double)im[k] * (double)im[k]);
            double norm = mag / ((double)AS_SPEC_FFT / 4.0);
            out[c * AS_SPEC_BINS + k] = (float)norm;
        }
    }
    return AS_SPEC_BINS * 2;
}