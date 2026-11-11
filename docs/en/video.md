# Video playback (`flash.net.NetStream` / `flash.media.Video`) — research and design

> This document answers one question: **what is the current state of AS3 video playback, and what does it take
> to actually get pixels on screen — and with which open-source stack.**
> Bottom line: **there is zero support, and it fails loudly** — `NetStream.play()` throws
> `flash.net.NetStream.play: media transport and FLV decoding are not supported by this subset`
> (`src/emit.ts:16607`), and `Video.attachNetStream()` is a no-op (`src/emit.ts:16630`). The repository has
> no demuxer, no video decoder, and no video clock.
>
> **Status: research and scoping only, not scheduled** (user decision, 2026-11-11). The stack is chosen:
> **trimmed FFmpeg** (§4).
>
> This document deliberately separates three things that are easy to conflate:
> ① **decoding** (H.264/AAC → YUV/PCM), ② **container and transport** (MP4/FLV/HLS/RTMP),
> ③ **getting it on screen**. ③ **is already done** (YUV direct render, see
> [`yuv-direct-render.md`](yuv-direct-render.md)); only ① and ② remain.

---

## 1. Current state: `NetStream` is a throwing stub, `Video` is a shell

Three reproducible facts:

| Location | State |
|---|---|
| `src/emit.ts:16607` | `NetStream_play()` calls `as_throw(...)` with "media transport and FLV decoding are not supported" |
| `src/emit.ts:16630` | `Video_attachNetStream()` is `{ (void)_this; (void)netStream; }` — holds no reference, creates no texture |
| `src/emit.ts:16583`, `src/air-app.ts:160` | `NetConnection` only reports `#2126` while "connecting"; no RTMP backend |
| `src/emit.ts:16608-16619` | `pause`/`resume`/`togglePause`/`seek`/`close` are empty; `time` is always `0.0` |
| `vendor/*.cc` | No demuxer, no decoder: `grep -iE "avcodec\|avformat\|h264\|aac\|flv"` hits only comments |

**This does not contradict "video frames already run"**: in the meeting app, video arrives as raw YUV/NV12
handed over by **TRTC via an ANE callback** (`getVideoBitmapData` → `BitmapData` → YUV texture). That path uses
an **external** decoder. This document is about **decoding the bitstream ourselves** — a different problem that
happens to share the same final exit (`BitmapData` / `SkImage` texture), which is the one real cost advantage we
have over projects writing a player from scratch (§9).

---

## 2. The real AS3 API surface

Authoritative source: the [AIR 3.0 language reference](https://airsdk.dev/reference/actionscript/3.0/).
Playing a clip needs more than `NetStream`:

| Class | Role in the playback path | Our state |
|---|---|---|
| `NetConnection` | connect (`connect(null)` for local/HTTP, `connect("rtmp://…")` for RTMP) | stub, `#2126` |
| `NetStream` | `play()` / `pause()` / `resume()` / `seek()` / `time` / `bufferTime` / `client` callbacks (`onMetaData`, `onCuePoint`) | throwing stub |
| `Video` | display carrier: `attachNetStream()` / `videoWidth` / `videoHeight` / `smoothing` | shell |
| `VideoCodec` | `H264Avc` / `SorensonSpark` / `VP6` constants | missing |
| `NetStreamInfo` / `NetStreamPlayOptions` | stats and playlist switching | missing |
| `StageVideo` | hardware compositing layer (bypasses the display list) | missing, see §12 |

**`client` callbacks are mandatory semantics**: `onMetaData`'s `width`/`height`/`duration`/`framerate` drive
`Video.videoWidth/Height` and the scrubber. In AIR this is the first thing any player code depends on.

---

## 3. Why "support every format" should be narrowed first

Our baseline is AIR, and AIR's `NetStream` format surface is **narrow**:

| Dimension | AIR desktop facts |
|---|---|
| Containers | **FLV** (native), **MP4/M4A/MOV** (H.264/AAC), MP3 (audio only); some platforms add HLS |
| Video codecs | **H.264 (AVC)**, **Sorenson Spark (H.263)**, **VP6** |
| Audio codecs | **AAC**, **MP3**, ADPCM, Nellymoser, Speex |
| Transports | `file:` / `http:` / `rtmp:` / `rtmpt:` / `rtmps:` |
| **Not supported** | HEVC, AV1, VP9, DASH, WebM |

So "support every format" *in AIR terms* means **H.264 + AAC + FLV/MP4**. HEVC/AV1/VP9 have **no AIR
counterpart**; under AGENTS.md §1.5 they are **enhancements** — not needed by the default product, and each one
is another library.

That directly bounds the size: **we do not need an engine that decodes everything, only a small one that decodes
H.264 + AAC.**

---

## 4. Selection

### 4.1 Three candidates

| | A. **Trimmed FFmpeg** (chosen) | B. Platform hardware decode | C. Small-library combo |
|---|---|---|---|
| Coverage | everything, a superset of AIR | H.264/HEVC/AV1/VP9 per platform | H.264 baseline + AAC |
| Size (static, order of magnitude) | **1.5–3 MB** trimmed | 0 (system frameworks) | ~1.2 MB |
| License | **LGPL-2.1+** (no `--enable-gpl`) | system APIs, no extra obligation | BSD/Apache |
| Patents | **our own risk** (LGPL grants no H.264/AAC patent license) | borne by OS/chip vendors | same as A |
| Cross-platform code | **one implementation** | **two** (VideoToolbox / Media Foundation; web uses the browser, WASI fails — see §4.3) | one, WASM excluded |
| 4K / power | CPU decode, 1080p30 ≈ 30–60% of one core | near zero | same as A |
| Effort | one-time FFmpeg build + thin C glue | 250–400 lines per platform, MF/VT init is error-prone | medium |

**Decision (2026-11-11): A (trimmed FFmpeg)**, chosen for "one implementation across three targets, format surface
covered in one shot", accepting the size and the §7 compliance work. Hardware decode (B) remains a **later
opt-in optimization** and does not conflict — the same `as_video_decode_*` seam can swap implementations.

### 4.2 Why not the other two

- **B (hardware decode)**: the best long-term trade overall (§4.3 gives three reasons), but it means platform
  code, and our scarcest resource is *cross-target consistency* — every extra implementation adds behaviour
  differences and bug surface. It fits better as a **per-platform replacement after A**, not as the starting point
  (note: **two platform implementations, not three** — see §4.3).
- **C (small libraries)**: `minih264` is an **encoder** (the author's words: "Minimalistic H264/SVC **encoder**
  single header library. Decoder can be popped up in future") — unusable as a decoder. `OpenH264` officially
  supports only **Constrained Baseline**, has no threading, and **Cisco pays MPEG-LA royalties only for its own
  prebuilt binaries; building from source puts the royalty obligation back on you**. `h264bsd` is
  baseline-only and unmaintained. AAC is worse: `FAAD2` is **GPL-2** (incompatible with our MIT), `fdk-aac`
  explicitly **grants no patent license**. Conclusion: **the small-library combo cannot actually assemble
  H.264 + AAC** — this is not a matter of preference.

### 4.3 Why hardware decode is still better long-term, and where it really stops

The decision is "ship FFmpeg first", but **the two desktop targets should eventually be switched to hardware
decode**. Three reasons, the third is the one most often missed:

1. **Size multiple**: 1.5–3 MB is small next to `skia.lib`, but it is fatal for our product definition — a 34 KB
   `hello.as` executable would grow **50–90×**. Section §2.6 spends a whole page on tree-shaking 165 KB down to
   34 KB; adding 2 MB of FFmpeg undoes all of it.
2. **Who carries the patent**: with hardware decode the H.264/AAC royalties were already paid by the OS and chip
   vendor — we only call an API. With software decode it comes back to us (§7), and "we used an open-source
   library" does not dissolve it.
3. **Zero copy**: software decode leaves YUV in **CPU memory**, so every frame must be uploaded to the GPU —
   720p NV12 = 1.38 MB/frame × 30 fps = **41 MB/s**, and that upload is serialised on the render thread.
   Hardware decode produces GPU-side resources directly (macOS `CVPixelBuffer` can be wrapped as a Metal texture,
   Windows `ID3D11Texture2D` can be shared with D3D12), so **not a single frame is transferred**.
   This is **not** the same as YUV direct render: direct render removes the YUV→RGBA CPU conversion
   (0.16 ms/frame), not the upload.

**Two platform implementations, not three**: WASM goes through the browser (`<video>`/WebCodecs) and WASI fails
loudly — neither needs codec code. Only **VideoToolbox (macOS) + Media Foundation (Windows)** remain, 250–400
lines of boilerplate each. The real comparison is therefore "two platform implementations + 0 bytes" versus
"one implementation + 1.5–3 MB + LGPL obligations".

**The divide is whether the format surface will grow**: while it stays inside AIR's small set
(H.264+AAC+FLV/MP4), hardware decode is sufficient and better on every axis. The moment HLS, multi-stream RTMP,
or HEVC/AV1 outside AIR is required, hardware decode cannot help and FFmpeg is the only realistic path — and once
it is in, the size and the LGPL obligations come with it.

**The real pitfalls of hardware decode** (a recommendation that hides these is a dishonest one): High profile is
not universally decodable (10-bit / 4:4:4 will fail — a fallback path is mandatory); parsing
`AVCDecoderConfigurationRecord` (SPS/PPS) is unavoidable (software decode needs it too, so it is not extra cost);
Media Foundation's `MFStartup` → `MFTEnumEx` → `SetInputType`/`SetOutputType` order, if wrong, **silently
returns empty frames** with unreadable error codes; old GPUs and VMs fail intermittently, so capability probing
and fallback are required — otherwise the symptom is a black screen.

---

## 5. FFmpeg trim list

Goal: keep only "demux FLV/MP4 with H.264+AAC+MP3, output YUV420P/NV12 and S16/F32 PCM". **Disable every
encoder, muxer, filter, device and program.**

```bash
./configure \
  --disable-everything \
  --disable-programs --disable-doc --disable-debug \
  --disable-avdevice --disable-postproc --disable-avfilter \
  --disable-autodetect --disable-iconv \
  --enable-avformat --enable-avcodec --enable-avutil \
  --enable-swscale --enable-swresample \
  --enable-protocol=file,http,https,tcp,tls \
  --enable-demuxer=mov,flv,mp3,aac,mpegts \
  --enable-decoder=h264,aac,mp3,flv,vp6f \
  --enable-parser=h264,aac,mpegaudio,flv \
  --enable-bsf=h264_mp4toannexb \
  --disable-encoders --disable-muxers --disable-filters \
  --enable-shared=no
```

Notes and traps:

| Item | Notes |
|---|---|
| `--disable-network` | **Do not pass it.** Even local playback often uses `http:` (CDN-hosted mp4); it also kills every protocol except `file:`. RTMP additionally needs `--enable-protocol=rtmp` plus `librtmp` (separate, see §11) |
| `h264` decoder | around **500 KB** unstripped — the single biggest item; **never** add `--enable-gpl` or x264-family code comes in |
| `aac` vs `aac_fixed` | float is higher quality, fixed uses less power; `miniaudio`'s mix pipeline is f32, so the float decoder saves a conversion |
| `--disable-avfilter` | no filters needed; scaling is done by `swscale` (YUV420P → NV12, or YUV420P straight to Skia) |
| `bsf=h264_mp4toannexb` | **only required for hardware decode** (Annex B start codes). Pure software decode + `swscale` can drop it |
| HLS | needs `--enable-demuxer=hls` + `--enable-protocol=crypto` (AES-128) + `mpegts`; **not in phase one** (§11) |
| Version | pin a tag (e.g. `n7.1`); FFmpeg's API still shifts between minors |

**Build placement**: per AGENTS.md §2.9, FFmpeg is a **linked library**, not text pasted into the generated `.c`.
It goes through manifest `link-libs` / `include-paths`; the output remains "readable C + third-party static libs".

---

## 6. Size and performance expectations (order of magnitude, must be measured)

| Item | Expectation | Notes |
|---|---|---|
| Static delta from `libavformat`+`libavcodec`+`libavutil`+`libswscale`+`libswresample` | **1.5–3 MB** stripped, depending on trim precision | small next to `skia.lib`, huge next to a 30 KB `hello.as` |
| H.264 decode | 1080p30 ≈ **30–60%** of one core; 720p30 ≈ 15–25% | noticeably worse without SIMD (`--enable-asm` on x86) |
| Decoded frame → `BitmapData`/texture | **0.16 ms/frame @720p**, already measured on the I420 path | see `video-frame-copy-chain-analysis.md` §8.4 |
| First-frame latency | target **< 100 ms** (local file, incl. probing + first keyframe) | |

**These must be measured, not assumed**: after trimming, use `llvm-size` for section sizes and `time` for decode
throughput, then write the numbers back into this section.

---

## 7. LGPL compliance (mandatory; the risk is larger than the size)

Without `--enable-gpl`, FFmpeg is **LGPL-2.1-or-later**. Our project is **MIT**; statically linking an LGPL
library and distributing the result triggers LGPL-2.1 §6 obligations:

| Required | How |
|---|---|
| ① No GPL components | The build script **must not** contain `--enable-gpl` / `--enable-nonfree` (they pull in x264/x265/faac/libfdk) |
| ② Keep attribution and version | Version queryable at runtime (`av_version_info()`); show "Powered by FFmpeg (LGPL-2.1+)" |
| ③ Enable relinking | We ship **generated C + build manifest + a public repo**, so users can swap FFmpeg and rebuild — exactly the "ability to relink" §6 asks for. **If pure binary commercial distribution is ever added, ship the FFmpeg `.a`/objects too, or switch to dynamic linking** |
| ④ Include the license | Distribute FFmpeg's `COPYING.LGPLv2.1` plus a source URL |
| ⑤ Never link a GPL decoder | `FAAD2` (GPL-2) and `x264` (GPL-2) are off the table even if AAC/encoding is requested |

> **One fact that must be recorded honestly: LGPL grants no patent license.** H.264 and AAC patent pools
> (MPEG-LA / Via LA) are independent of the open-source license. With hardware decode that risk sits with the
> OS/chip vendor; **with FFmpeg software decode it lands back on us.** "We used an open-source library" does not
> dissolve it; business side must be aware. The only clean escape is switching to B (§4.1).

---

## 8. Multi-target matrix

| Target | Demux/decode | Output | Notes |
|---|---|---|---|
| macOS arm64 | FFmpeg (software) | `AV_PIX_FMT_YUV420P` → Skia | `--enable-asm` (arm64 NEON) usable |
| Windows x64 | FFmpeg (software) | same | `--enable-asm` needs nasm/yasm in the build env (see `checks.ts`) |
| Web (`--target wasm --package web`) | **two modes** (below) | `YUV420P` → WebGL/WebGPU | **default is the browser's own decoder; do not compile FFmpeg into wasm** |
| WASI (`--target wasm`) | none | — | **fail loudly** ("this backend does not support video"), never silently degrade |
| Linux | FFmpeg (software) | same | builds via the ELF target; not yet verified on hardware |

**Web specifics**: compiling FFmpeg to wasm grows the artifact from hundreds of KB to **4–8 MB** and saturates a
core for 720p. Browsers already provide `<video>` and `WebCodecs` — **use those by default**, compile FFmpeg only
for native targets. This is exactly what the manifest's `targets.<target>` layering (**replace**, not append) is for:
the native manifest carries the FFmpeg `link-libs`, the web manifest does not.

---

## 9. How this connects to existing assets (our real cost advantage)

| Existing asset | Use in video playback |
|---|---|
| **YUV direct render** (`yuv-direct-render.md`; all four Skia targets have `TextureFromYUVAPixmaps`) | FFmpeg outputs `YUV420P` **straight into a texture**, skipping one YUV→RGBA CPU pass (~1 ms/frame at 720p) |
| `BitmapData` pixel contract (internal `0xAARRGGBB`) | Route pixel-level access through "decode → YUV → materialize on demand"; never materialize by default |
| `vendor/audio_glue.c` (miniaudio) | **MP3/FLAC/WAV/Vorbis already decode**; AAC is decoded by FFmpeg into PCM and fed to miniaudio's f32 mix pipeline — no separate audio device layer |
| ANE video frame path (`getVideoBitmapData`) | File playback and RTC frames share the same "upload texture" exit; only the upstream differs |
| Async job table (`as_job_*`, stage 89·45) | Demux/decode belongs on the same background jobs; decoder contexts are **long-lived**, never rebuilt per frame |

---

## 10. Implementation placement (per AGENTS.md layering)

| Layer | Placement | Forbidden |
|---|---|---|
| C glue | new `vendor/video_glue.c`: `as_video_open/read_frame/decode/close` over `AVFormatContext`/`AVCodecContext` | AS3 semantics inside it (`NetStream` state machine belongs to codegen) |
| Runtime | `src/runtime.ts` declarations + no-op stubs (builds without FFmpeg must fail loudly, never return empty frames) | `avformat.h` appearing in generated C |
| AS3 semantics | `NetStream`/`Video` in `src/emit.ts`: `play/pause/seek/time/client` callbacks, `#2126`-style error codes | decoding logic in `emit.ts` |
| Build | `src/build.ts` manifest fields (`link-libs`/`include-paths`/`sources`) + one `checks.ts` row for FFmpeg presence | a second, drifting check set in the CLI |

**Error semantics**: `play()` cannot open → `IOErrorEvent`; unsupported container/codec → `NetStream.Play.Failed`
(exact text must be taken from `adl`, not guessed); **"compiles, runs, black screen" is never acceptable**.

---

## 11. Phased plan (not scheduled)

| Phase | Content | Acceptance |
|---|---|---|
| V0 | **Trim FFmpeg and measure**: build the static libs, record size, record 1080p decode throughput, get "mp4 → YUV420P frames" working in a CLI probe | numbers written back into §6; probe reproducible |
| V1 | **MP4 (H.264+AAC) local/HTTP playback**: `NetConnection.connect(null)` + `NetStream.play("file.mp4")` + `Video.attachNetStream` + `onMetaData` + audible audio | `examples/video.as` plays a bundled sample; item-by-item parity with `adl` (`videoWidth/Height`, `time`, `onMetaData`) |
| V2 | **FLV** (AIR's native container) + `pause/seek` + buffering states | parity with `adl` |
| V3 | Transport: `http:` progressive → RTMP (hand-rolled handshake/chunks, **no librtmp** — avoid yet another LGPL dependency) | AIR's `NetStream.Play.*` event sequence |
| V4 | **Switch both desktop targets to hardware decode** (swap the implementation behind `as_video_decode_*`; not one line of AS3 changes); FFmpeg becomes an **opt-in** dependency for Linux / format-extended builds | A/B on the same source: frame time, upload bandwidth, artifact size; hardware failure must fall back to software |
| V5 (enhancement, opt-in) | HLS (`mpegts`+`hls` demuxers), HEVC/AV1 | explicitly labelled enhancement, off by default |

---

## 12. Explicitly unsupported / deferred

| Item | Reason |
|---|---|
| `NetStream.publish()` (encoding) | needs an H.264 encoder (x264 is GPL; OpenH264's encoder has patent issues), and the meeting app uses TRTC |
| `StageVideo` | needs a compositing layer outside the display list — same order of work as `Stage3D`; start with `Video` + display list |
| HEVC / AV1 / VP9 / WebM | no AIR counterpart, therefore enhancements; each is another library (libde265 LGPL-3 / dav1d BSD / libvpx BSD) |
| DRM (`DRMContentData`) | AIR itself no longer supports it on most platforms |
| Video on WASI | no window, no audio device — unverifiable |

---

## 13. Open decisions

1. **First container**: MP4 or FLV? Depends on target content (samples and user uploads are mostly MP4; legacy AIR assets are mostly FLV).
2. **Whether to compile FFmpeg for web too**: recommended **no** (`<video>`/WebCodecs instead), but that introduces the first real divergence in "one `.as`, identical behaviour on three targets" and must be documented.
3. **Patent risk ownership**: who owns §7's point (LGPL grants no patent license), and is that accepted.
4. **FFmpeg version pin**: `n7.1` recommended; does it need to track upstream?

---

## 14. Reproduction (what can be done today)

```bash
# 1) Confirm the stub throws (no assets, no example needed)
cd as3compiler
grep -n "media transport and FLV decoding" src/emit.ts
# To actually run it, three lines of .as are enough (AIR fails the same way, so this is a
# snapshot of the status quo, not a negative case):
#   var nc:NetConnection = new NetConnection(); nc.connect(null);
#   var ns:NetStream = new NetStream(nc);
#   ns.play("x.mp4");   // expect: Error ... not supported by this subset

# 2) Confirm there is no decoding backend (expect no output)
grep -rniE "avcodec|avformat|libavcodec|h264_decode" src/ vendor/*.cc vendor/*.c

# 3) Trim measurement (phase V0, needs the FFmpeg source)
git clone --depth 1 -b n7.1 https://git.ffmpeg.org/ffmpeg.git build-tools/ffmpeg-src
cd build-tools/ffmpeg-src && ./configure <flags from §5> && make -j
llvm-size libavcodec/libavcodec.a
```

---

## 15. Reference anchors

- AS3 reference: [`flash.net.NetStream`](https://airsdk.dev/reference/actionscript/3.0/flash/net/NetStream.html),
  [`flash.media.Video`](https://airsdk.dev/reference/actionscript/3.0/flash/media/Video.html),
  [`flash.media.VideoCodec`](https://airsdk.dev/reference/actionscript/3.0/flash/media/VideoCodec.html)
- FFmpeg trimming and licensing: [ffmpeg-all](https://ffmpeg.org/ffmpeg-all.html), [legal](https://ffmpeg.org/legal.html)
- In-repo docs: [`yuv-direct-render.md`](yuv-direct-render.md) (YUV direct render, implemented),
  [`audio.md`](audio.md) (miniaudio backend and audio parity),
  [`flash-net.md`](flash-net.md) (`NetConnection`/`URLLoader` state)
- Repo-root analyses: [`video-frame-copy-chain-analysis.md`](../../../video-frame-copy-chain-analysis.md),
  [`yuv-video-direct-draw-analysis.md`](../../../yuv-video-direct-draw-analysis.md)
