# Video playback (`flash.net.NetStream` / `flash.media.Video`) — research and design

> This document answers one question: **what is the current state of AS3 video playback, and what does it take
> to actually get pixels on screen — and with which open-source stack.**
> Bottom line: **there is zero support, and it fails loudly** — `NetStream.play()` throws
> `flash.net.NetStream.play: media transport and FLV decoding are not supported by this subset`
> (`src/emit.ts:16607`), and `Video.attachNetStream()` is a no-op (`src/emit.ts:16630`). The repository has
> no demuxer, no video decoder, and no video clock.
>
> **Status: design settled (all nine items in §14 were decided on 2026-11-12); implementation not scheduled.**
> **Final plan**: trimmed FFmpeg (**latest stable tag, currently `n9.0.2`**) as the **single implementation** (§4),
> with hardware decode as one of its decode backends (macOS `-hwaccel videotoolbox`, Windows `-hwaccel d3d11va`) —
> not a separate route requiring hand-written platform code. **The decode backend has exactly one setting: `auto`**
> — it probes for hardware and falls back to software on its own, with no hand-picked `hw` setting (§5.3).
> **The format surface is opened up, not trimmed**: once FFmpeg is linked anyway, fill in its decoders and
> demuxers — measured, "everything" (8.28 MB) costs 1.86× "H.264 only" (4.45 MB), not 10× (§3).
> **Playback and publishing are both in scope**: `NetStream.publish()` is AIR-defined behaviour, so the trim is
> not "cut encode/streaming" but "fill the decode surface, keep the write direction down to the publish
> minimum", measured at a flat +0.20 MB (§3/§6.1). **Web does not compile FFmpeg** (`<video>`/WebCodecs), and
> iOS / Android keep a reserved interface slot (§5.4/§9).
> **Whether FFmpeg is carried at all is decided at build time from the program's own sources** (§5), so an
> artifact that never touches video does not grow by a single byte.
>
> This document deliberately separates three things that are easy to conflate:
> ① **decoding/encoding** (H.264/AAC ↔ YUV/PCM), ② **container and transport** (MP4/FLV/HLS/RTMP),
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
have over projects writing a player from scratch (§10).

---

## 2. The real AS3 API surface

Authoritative source: the [AIR 3.0 language reference](https://airsdk.dev/reference/actionscript/3.0/).
Playing a clip needs more than `NetStream`:

| Class | Role in the playback path | Our state |
|---|---|---|
| `NetConnection` | connect (`connect(null)` for local/HTTP, `connect("rtmp://…")` for RTMP) | stub, `#2126` |
| `NetStream` | read: `play()` / `pause()` / `resume()` / `seek()` / `time` / `bufferTime` / `client` callbacks (`onMetaData`, `onCuePoint`) | throwing stub |
| `NetStream` | write: `publish()` / `attachCamera()` / `attachAudio()` / `appendBytes()` (**AIR-defined**, not a side API) | throwing stub; build side already in place (§6.1) |
| `Camera` / `Microphone` | the frame source for publish (capture) | stub: `getCamera()` returns NULL, `names` is empty (`src/symbols.ts:2756`) |
| `Video` | display carrier: `attachNetStream()` / `videoWidth` / `videoHeight` / `smoothing` | shell |
| `VideoCodec` | `H264Avc` / `SorensonSpark` / `VP6` constants | missing |
| `NetStreamInfo` / `NetStreamPlayOptions` | stats and playlist switching | missing |
| `StageVideo` | hardware compositing layer (bypasses the display list) | missing, see §13 |

**`client` callbacks are mandatory semantics**: `onMetaData`'s `width`/`height`/`duration`/`framerate` drive
`Video.videoWidth/Height` and the scrubber. In AIR this is the first thing any player code depends on.

**The write direction is inside AIR's defined surface too**: `publish()` + `attachCamera()`/`attachAudio()` is
the canonical live-streaming shape, and `appendBytes()` lets a program feed already-encoded data without any
capture device (which is why V5 can verify publish before a `Camera` backend exists). Both are AIR-defined, so
the §1.5 criterion applies: failing to run them is a **deferred defect**, not an "unsupported feature".

---

## 3. The format surface: widening it is cheap (measured), so we do not trim

First, the AIR baseline that **must** be matched:

| Dimension | AIR desktop facts |
|---|---|
| Containers | **FLV** (native), **MP4/M4A/MOV** (H.264/AAC), MP3 (audio only); some platforms add HLS |
| Video codecs | **H.264 (AVC)**, **Sorenson Spark (H.263)**, **VP6** |
| Audio codecs | **AAC**, **MP3**, ADPCM, Nellymoser, Speex |
| Transports | `file:` / `http:` / `rtmp:` / `rtmpt:` / `rtmps:` |
| **Not supported** | HEVC, AV1, VP9, WebM, MKV, DASH |

The first draft concluded "narrow it: H.264 + AAC + FLV/MP4 only". **That conclusion was wrong** — it assumed
"more formats = another engine". Measurement kills that assumption (same machine, same `cc -O2` link,
`strip -x`, sizes via `stat`; MB = 1024 KB; reproduce with §15):

| Profile | Coverage | Decode only | With publish (default) |
|---|---|---|---|
| Baseline (no video) | — | **16 KB** | 16 KB |
| `air` | H.264 + AAC/MP3 + FLV/MP4/MOV | 4.25 MB | **4.45 MB** |
| `mid` (comparison only, not shipped) | + HEVC/VP8/VP9/Opus/Vorbis/FLAC/ALAC + MKV/TS/OGG/WAV | 6.46 MB | 6.67 MB |
| **`broad` (default, incl. 8 VT hwaccels)** | + AV1/MPEG-1/2/4/VP6/Theora/VC1/WMV3/MJPEG/ProRes + AC3/EAC3/DTS/TrueHD/WMA + AVI/ASF/RM/AIFF/CAF/IVF + RTMP/RTSP/UDP + HLS | 8.09 MB | **8.28 MB** |

"With publish" = the `NetStream.publish()` write direction is kept (`flv` muxer + hardware H.264 encoder +
AAC encoder + `rtmps`/`rtmpt` tunnelling), measured at a flat **+0.20 MB** (air 204 KB / mid 220 KB /
broad 203 KB). Breakdown (n7.1 shape): `flv` muxer +51 KB / H.264 hw encoder + AAC encoder +170 KB /
tunnelling +16 KB. **It does not scale with the format surface** — the encoder list is independent of the
decoder list.

- `broad` minus the 8 hardware backends (same publish shape) is **8.26 MB** — **all eight cost 19 KB**.
- **Version-sensitive**: the same flags are 3.82 / 6.03 / 7.46 / 7.68 MB on n7.1 and the values above on
  n9.0.2 (+0.4–0.6 MB). Sizes are tied to a tag — **re-measure after any tag change**, never reuse an old table.
- Why publish is on by default: `NetStream.publish()` is AIR-defined, so an `air` profile without it is not an
  AIR superset but an AIR **subset**. Configuration in §6.1; the remaining gap is capture, §13.

Three conclusions:

1. **Fixed cost dominates.** The entry ticket is 4.45 MB (with publish); each further rung costs only 1.6–2.2 MB.
   **"Everything" is 1.86× "H.264 only", not 10×** — demuxing, bitstream parsing, DSP tables and the hwaccel
   framework are one shared copy.
2. **On FFmpeg the format surface is a few `--enable-decoder` lines.** No second engine, no extra library, no
   extra fallback path: past `avcodec_find_decoder` the road is identical. The cost of "adapting to many
   formats" was already paid the moment FFmpeg was chosen.
3. **Hardware decode is nearly free** (+19 KB). Measured VT coverage: h264/hevc/mpeg1/2/4/h263/prores/vp9;
   D3D11VA: h264/hevc/mpeg2/vc1/vp9/av1/wmv3 — so **most of `broad`'s video codecs have a GPU path**.

**Format-surface decision (2026-11-12, user)**: default `broad`; do not drop HEVC/VP9/AV1/MKV to save 3.8 MB.
One of AOT's selling points is a self-contained, offline-playable artifact — an artifact that only plays H.264
gives up half of that.

On AGENTS.md §1.5 (enhancements must be opt-in, default artifact stays AIR-isomorphic): **the format surface is
a capability superset that rewrites no AIR-defined semantics** — files AIR rejects now play, which is the "we
succeed where AIR errors" direction of enhancement; nothing AIR can run today runs differently (error numbers,
event order and boundary values are unchanged). Artifacts that need strict isomorphism can still be built with
`video-formats: air` (§5.3).

---

## 4. Selection

### 4.1 The real shape of the choice: FFmpeg is the demux layer, hardware decode is one of its backends

The original "pick one of three" (A software decode / B hand-written platform decode / C small libraries) missed
the cell that actually matters: **switching the decoder inside the same FFmpeg stack to the system's hardware
codec**. It is not a new route, it is a switch on A — measured on this machine, it runs on the `h264` decoder plus
the `videotoolbox` hwaccel (§4.3).

| | A software only | **A′ FFmpeg + hwaccel** (default) | B hand-written VT/MF | C small libraries |
|---|---|---|---|---|
| Where decoding runs | CPU | **GPU (system decoder)** | GPU (system decoder) | CPU |
| Demux / bitstream parsing | FFmpeg | **FFmpeg** | hand-written or another lib | hand-written |
| 1080p decode CPU (measured, §4.3) | ~4.3 ms/frame | **~1.0 ms/frame** | ~1.0 ms/frame | same as A |
| Where frames live | CPU (1080p 93 MB/s upload @30fps) | **GPU side** | GPU side | CPU |
| Platform decode API boilerplate | 0 | **0 (FFmpeg already wrote it)** | 250–400 lines ×2 | 0 |
| GPU-side texture bridge | not needed | ~30–80 lines ×2 | ~30–80 lines ×2 | not needed |
| Links FFmpeg / LGPL | yes | **yes** | no | no |
| Size (measured after link, §7) | 4.25 MB (4.45 with publish) | **4.45 MB (hardware decode +19 KB)** | ~0.3 MB (platform glue only) | ~1.2 MB (unmeasured) |
| H.264/AAC patents | ours | **borne by the platform** | borne by the platform | ours |
| Format growth (HEVC/VP9/AV1/MKV/HLS) | a few configure lines | **a few configure lines (§3/§6)** | one stack per format | one library per format |

**Final decision (filed 2026-11-11, finalised 2026-11-12)**: FFmpeg is the **single implementation** carrying
demuxing, bitstream parsing, audio decoding and software video decode; **hardware decode is enabled through its
hwaccel backends** (macOS `-hwaccel videotoolbox`, Windows `-hwaccel d3d11va`) with automatic fallback to
software. Both desktop targets default to hwaccel; Linux defaults to software (VAAPI/NVDEC as optional
backends); web uses the browser natively; WASI fails loudly.

**This is the final shape, not a stepping stone**: there is no scheduled "replace FFmpeg later" track. The video
stack *is* this — FFmpeg owns the container, parsing, audio and software decode; the system decoder owns hardware
decode; both sit behind the same `as_video_*` seam and are resolved per target (§5.4).

**The only real cost is linking FFmpeg itself** (size + §8 compliance), and that is orthogonal to "hardware or
not": in A′ hardware decode is free. Hand-written platform decode (B) is worth it only when the LGPL dependency
must go or the artifact must fit inside a few hundred KB — and then it belongs to an **opt-in build variant**, not
the default path (§4.2).

### 4.2 The two rejected routes (kept for the record)

- **B (hand-written VideoToolbox / Media Foundation)**: versus A′ it saves only "linking FFmpeg's 3.8–7.5 MB and
  the LGPL obligation", and it costs two sets of platform boilerplate (250–400 lines each), two sets of
  init-order traps (MF's `MFStartup` → `MFTEnumEx` → `SetInputType`), two sets of capability probing and
  fallback, and it **gives up format growth** (HLS/RTMP/HEVC would each need another stack). A′ collects every
  benefit of B (GPU-side frames, patents on the platform, near-zero CPU) without writing any of that.
  **Not scheduled**: this plan has no "switch to a hand-written decoder later" step; it would only be
  re-evaluated as an **opt-in build variant** if the LGPL or size constraints changed fundamentally.
- **C (small libraries)**: `minih264` is an **encoder** (the author's words: "Minimalistic H264/SVC **encoder**
  single header library. Decoder can be popped up in future") — unusable as a decoder. `OpenH264` officially
  supports only **Constrained Baseline**, has no threading, and **Cisco pays MPEG-LA royalties only for its own
  prebuilt binaries; building from source puts the royalty obligation back on you**. `h264bsd` is
  baseline-only and unmaintained. AAC is worse: `FAAD2` is **GPL-2** (incompatible with our MIT), `fdk-aac`
  explicitly **grants no patent license**. Conclusion: **the small-library combo cannot actually assemble
  H.264 + AAC** — this is not a matter of preference.

### 4.3 Hardware decode: what hwaccel buys, and what it costs (measured)

**First, a factual correction: FFmpeg does support hardware decoding.** This is not a guess — measured here on
macOS arm64 with ffmpeg 7.1.1:

```text
$ ffmpeg -hwaccels
Hardware acceleration methods:
videotoolbox

$ ffmpeg -v verbose -hwaccel videotoolbox -i t.mp4 -f null -
Selecting decoder 'h264' because of requested hwaccel method videotoolbox
[h264] Reinit context to 1280x720, pix_fmt: videotoolbox_vld    ← frames are CVPixelBuffers
```

Same source (1080p / 300 frames / x264 high / yuv420p), three runs, stable values:

| Path | user CPU | Per frame |
|---|---|---|
| software | 1.30 s | ~4.3 ms |
| `-hwaccel videotoolbox` | 0.30 s | ~1.0 ms |

**Do not read the wall clock as the result**: with `-f null`, hwaccel is actually *slower* (1.2 s) because every
frame is `hwdownload`-ed back into CPU memory — that is the cost of wiring the output to the wrong exit, not the
cost of hardware decode. A real pipeline keeps frames on the GPU side and feeds them straight into a texture.

Of the three reasons in the previous version of §4.3, two hold and one was mis-attributed:

1. **Zero copy (holds, and only with hwaccel)**: software decode leaves frames in CPU memory — 1080p NV12 =
   3.11 MB/frame × 30 fps = **93 MB/s** (41 MB/s at 720p), serialised on the render thread. hwaccel hands back
   `CVPixelBuffer` / `ID3D11Texture2D` directly. This is **not** the same thing as YUV direct render: direct
   render removes the YUV→RGBA CPU conversion (0.16 ms/frame), not the upload.
2. **Who carries the patent (holds, but the criterion is not "do we use FFmpeg")**: the criterion is **who
   executes the decode**. Under hwaccel the actual decoding is done by Apple's/Microsoft's system decoder, so the
   licence travels with the platform; only software decoding puts it back on us. **Patent pressure therefore
   argues for "default to hwaccel", not for "drop FFmpeg".**
3. **CPU / power (holds)**: measured 4.3 → 1.0 ms/frame.

**What does not hold is the size argument**: linking FFmpeg costs 4.45 MB and up (§3, measured) whether or not
hwaccel is on — all eight hwaccels together are 19 KB. That is
the "do we use FFmpeg at all" question (answered yes in §4.1), not the "do we use hardware decode" question.

**The piece A′ must still write itself (missing from the original accounting)**: the GPU-side texture bridge,
shared by A′ and B —

- macOS: `CVMetalTextureCacheCreateTextureFromImage` → `GrBackendTexture` (system API, ~30–50 lines)
- Windows: `av_hwframe_map` yields `ID3D11Texture2D` + index → D3D11 `GrBackendTexture` (~30–50 lines)

These 60–100 lines are the only cost the original document charged to B alone while A′ also pays it.

**Fallback is far cheaper than under hand-written platform decode**: on macOS FFmpeg has no standalone
`h264_videotoolbox` decoder (`-decoders` here lists only `h264`); VT decoding is `h264` plus the `videotoolbox`
hwaccel, so **the software decoder is already in the binary**. Windows `d3d11va` likewise reuses `h264`. So
"probe failed → switch back to software" is one backend swap with the demux and parsing code untouched. Doing the
same fallback with hand-written VT/MF means maintaining two state machines.

**The real pitfalls (the original list, nothing removed)**: High profile is not universally decodable
(10-bit / 4:4:4 will fail — a fallback path is mandatory); parsing `AVCDecoderConfigurationRecord` (SPS/PPS) is
unavoidable (software decode needs it too, so it is not extra cost); hwaccel `get_format` negotiation **silently
falls back** on some drivers, so assert both at `av_hwdevice_ctx_create` and on the first frame's `AV_PIX_FMT_*`,
otherwise the symptom is "we think we are hardware-decoding but we are not" (performance gets blamed, cause stays
hidden); old GPUs and VMs fail intermittently, so probe and fall back — otherwise it is a black screen.

**The divide is whether the format surface will grow**: inside AIR's small set (H.264+AAC+FLV/MP4) hwaccel is
sufficient. For HLS, multi-stream RTMP, or HEVC/AV1 outside AIR, **hwaccel does not become useless** — FFmpeg's
demuxers and hwaccel framework already cover `mpegts`+`hls` and `hevc_videotoolbox`/`d3d11va`; you enable the
corresponding demuxer/hwaccel components. The real cost is the size those format components add, not writing
another decoder — and measured, that growth is small (§3: `air`→`broad` is +3.8 MB, eight hardware backends
are 19 KB), so the decision is to fill the surface in.

---

## 5. Build-time injection (feature gate)

> This is where "small artifacts" is enforced: **a program that never touches video does not grow by a byte**.

### 5.1 Why this is a build-time decision, not "let the user write the manifest"

FFmpeg's static delta is 3.8–7.5 MB (measured, §3), while our artifact baseline is a few tens of KB (`hello.as`; AGENTS.md §2.6
tree-shakes 165 KB down to 34 KB). Linking FFmpeg into every artifact unconditionally would undo that work. But
the opposite — "video is always a manual opt-in" — is just as wrong: nobody writing `new NetStream(...)` should
have to know FFmpeg exists.

This is not a new mechanism — the repository already has two gates of exactly this shape:

| Precedent | Signal (source text) | Injection | Behaviour when absent |
|---|---|---|---|
| `flash.data` (`usesFlashData`, `src/index.ts`) | `flash.data.` / `SQL*` class names | `vendor/sqlite_glue.c` + `vendor/sqlite/sqlite3.c` + `ASC_HAVE_SQLITE` | opening a connection throws "SQLite backend not linked into this build" |
| `flash.text` (`usesTextEngine`, `src/index.ts`) | `flash.text.` / `TextField` etc. | `vendor/skia_text_glue.cc` + `ASC_HAVE_TEXT` | one stderr warning on first layout (`as_text_engine_absent`) |
| **Video (`usesVideoCodec`, new in this section)** | `NetStream` / `flash.media.Video` etc., see §5.2 | `vendor/video_glue.c` + `ASC_HAVE_VIDEO` + the FFmpeg static libs | `play()` reports loudly that this build has no video backend (§5.7) |

All three share one invariant: **the generated C is byte-identical**; only the link set and the defines differ.
That is the same contract `ASC_HAVE_AUDIO` / `ASC_HAVE_CURL` / `ASC_HAVE_SQLITE` / `ASC_HAVE_TEXT` already use,
and it is what lets one source tree produce different backends per target (§5.4).

### 5.2 Detection signal

```ts
// `flash.media.` cannot be the signal: Sound lives there too (the existing detectAudio already has this
// cross-false-positive, see §5.6). Use tokens that only the video path contains, and catch both the
// fully-qualified spelling and the bare class name.
const re = /flash\.net\.NetStream|flash\.media\.Video\b|(?:^|[^A-Za-z0-9_.$])(?:NetStream|VideoCodec|StageVideo|attachNetStream)(?![A-Za-z0-9_])/;
```

- `NetStream` is the mandatory entry point (`Video.attachNetStream` takes one) — nothing plays without it;
- `VideoCodec` / `StageVideo` only appear in the video path;
- bare class names are matched too, so `getDefinitionByName("flash.net.NetStream")` and un-imported
  fully-qualified uses are caught (same reason as `usesTextEngine`);
- **bare `Video` is deliberately not matched**: far too generic (user classes, `VideoEvent`) and would drag
  audio-only or business-only programs in.

The bias is the same as both precedents: **over-inclusive**. A false positive costs "3.8–7.5 MB linked for
nothing"; a false negative costs a runtime error — and §5.3's explicit off switch covers the false positive.

### 5.3 Resolution order

| # | Input | Result |
|---|---|---|
| 1 | manifest `video: "off"` / CLI `--no-video` | **never inject** (the escape hatch for size-sensitive builds) |
| 2 | manifest `video: "on"` / CLI `--video` | **always inject** (a missed detection does not matter) |
| 3 | manifest already lists FFmpeg in `link-libs` or defines `ASC_HAVE_VIDEO` | treated as `on` (hand-written manifests stay compatible) |
| 4 | none of the above (default `auto`) | detect per §5.2 |

**Detection only ever adds**: it fills in missing `sources`/`defines`/`link-libs` entries and never removes one
the manifest already has — a hand-written manifest always wins, matching `usesTextEngine`'s "manifest wins when
it speaks" rule.

> `video` (whether to carry the backend) and `video-backend` (which decoder to use) are **two orthogonal switches**:
> the first shapes the build set, the second is a runtime choice. **`video-backend`'s default and only recommended
> value is `auto`**: probe what hardware decoding this machine offers → use it; if that fails → fall back to
> software inside the same session (the software decoders are linked in anyway, §4.3). Because it can fall back
> on its own, there is no point in offering a hand-picked `hw` setting — it would only ever pick what `auto`
> already picks. One value remains, for troubleshooting: `soft` (force the downgrade to confirm whether a symptom
> comes from hardware decoding). `video-backend` is meaningless under `video: off`.
>
> The third switch is the **format surface**: `video-formats: air | broad | all`, **default `broad`** (§3 measured:
> everything costs 1.9×, not 10×). `air` serves artifacts that must be strictly AIR-isomorphic or are size-capped;
> `all` adds VVC/dav1d/DASH (unmeasured). All three are "swap the `--enable-decoder` list" — same sources, same
> seam (§6.2) — and **the container is not a dimension to choose from**: `broad` carries MP4/FLV/MKV/TS/HLS at
> once, so there is no "MP4 or FLV" decision to make.

**Detection hit but the FFmpeg prebuilts are missing for this host** ⇒ **the build fails**, pointing at
`vendor/provision/ffmpeg-static.sh` (§5.5). Not a silent skip: if the sources want video, the artifact must
actually play it (AGENTS.md §1.5). To accept "builds but cannot play", write `video: "off"` explicitly — then
`play()` takes the loud path in §5.7.

### 5.4 Multi-target resolution (one signal, seven injection outcomes)

| Target / package | Injected when detection hits | Notes |
|---|---|---|
| macOS native | `video_glue.c` + `ASC_HAVE_VIDEO=1` + `-lavformat -lavcodec -lavutil -lswscale -lswresample` + `frameworks: VideoToolbox, CoreVideo, CoreMedia, CoreFoundation, Metal, Security` (the last one serves https via `--enable-securetransport`) | hwaccel on by default, falls back to software (§4.3); publish uses `h264_videotoolbox` |
| Windows native | same + `-lole32 -lmfplat -lmfuuid -ld3d11 -ldxgi` | D3D11VA by default, DXVA2 as backup; publish uses `h264_mf` |
| Linux native | same (no Apple/MS frameworks); VAAPI optional | software by default; publish needs VAAPI, and **`publish()` errors without a render node** (never silent) |
| wasm + `--package web` | `ASC_VIDEO_BROWSER=1`, **no FFmpeg** | `<video>` / WebCodecs bridge; FFmpeg-in-wasm is 4–8 MB and eats a full core. Publish goes through the browser too (`MediaRecorder`/WebCodecs), and **that divergence must be recorded explicitly** |
| wasm (WASI, no web package) | **nothing** | both `play()` and `publish()` report loudly that this backend does not support video; never degrades silently |
| **iOS (reserved)** | same as macOS (**the same `video_glue.c`**, framework list swapped for the ones iOS allows) | no iOS target yet; the interface must be left open (§9) |
| **Android (reserved)** | Linux link shape (no Apple/MS frameworks) + NDK artifacts | MediaCodec is not a hwaccel but a per-frame surface, so the texture bridge is separate work; **not implemented now** |

`targets.<target>`'s **replace** semantics carry this exactly (see the field comments in `src/build.ts`): the
top-level `link-libs` serves native, `targets.wasm.link-libs: []` drops FFmpeg — identical to how curl is
handled for web. **One manifest plus one detection pass covers seven targets** (including the two reserved mobile
slots); no second manifest per target. The **observation set** of that one pass (`featureScanTexts`) is
platform-agnostic, and every platform difference lives in "what gets injected" — which is why adding
iOS/Android later does not touch the detection logic.

### 5.5 Where the prebuilts live

Same shape as curl / sqlite / sdl2 / skia — FFmpeg sources are not vendored into `vendor/`:

```text
build-tools/ffmpeg-src/           # sources (clean clone, not in git)
build-tools/ffmpeg-out/<profile>/ # staging: *.a + include/ + COPYING.LGPLv2.1
vendor/provision/ffmpeg-static.sh # ★ the build recipe (§6's flags), IN git
vendor/ffmpeg/
├── include/                      # libav*.h
├── lib/<platform>/               # libavformat.a libavcodec.a libavutil.a libswscale.a libswresample.a
└── LICENSE.LGPLv2.1              # the distribution obligation from §8
```

**The recipe is tracked; the sources and staging output are not** — the one place this differs from curl.
The reason: that `--enable-*` list **is** the design recorded in §3/§6 (which decoders, which three publish
pieces survive), and the size table only stays reproducible while the recipe is versioned. curl's recipe living
in an untracked `build-tools/` tree is inherited debt, not a precedent to copy.

Two layers, same as curl (`build_curl()` in `vendor/provision/macos.sh:221-240` has the identical shape):

| Who | What |
|---|---|
| `vendor/provision/ffmpeg-static.sh broad` | runs `configure`/`make`, measures size, installs into `build-tools/ffmpeg-out/broad/` |
| `vendor/provision/macos.sh --only video` | validates the five `.a` files and the include tree → copies into `vendor/ffmpeg/{lib/macos-arm64,include}` + `LICENSE.LGPLv2.1` |

Profile via `ASC_FFMPEG_PROFILE` (default `broad`); source tree via `ASC_FFMPEG_SRC` (default
`build-tools/ffmpeg-src`, cloned at `ASC_FFMPEG_TAG`, default `n9.0.2`, when absent).
**There is no Windows entry point**: `windows.ps1` is clang-cl + MSVC ABI and FFmpeg has no build system for
that — it needs an MSYS2/MinGW shell. Do not assume `-Only video` would work.

`checks.ts` gains a `vendor.video` row (`kind: "warn"`, same shape as `vendor.audio`: linked → ok; should be
linked but is not → name which of the three reasons applies — glue missing, host unsupported, or the manifest
never named it); `doctor.ts`'s config summary gains a `video` bit.

### 5.6 A cross-false-positive to fix while we are here

The existing `detectAudio` (`src/air-app.ts`) signals on `text.includes('flash.media')`, and **`Video` lives in
`flash.media` too** — a program that only imports `flash.media.Video` drags miniaudio into the link set. When the
video gate lands it should narrow that to audio class names (`Sound|SoundChannel|SoundMixer|SoundTransform|Microphone`),
otherwise a video app's size accounting pays for an audio backend it never uses.

### 5.7 Runtime semantics when not injected

Not injecting is **not** a silent degradation — it is an explicit "this build lacks the capability":

- `NetStream.play()` throws `[as3-aot] not implemented by this build: video playback requires an FFmpeg-linked build`
  (through the existing `as_shell_unsupported()` channel, `src/runtime.ts`);
- `Video.attachNetStream()` stays a shell (it does not depend on the backend);
- `Sound` behaviour is unaffected (the audio gate is a separate matter, §5.6).

### 5.8 Size accounting (must be measured in V0, not estimated)

| Program | vs baseline | Notes |
|---|---|---|
| `hello.as` (no `flash.net` / `flash.media`) | **0** | detection misses, link set unchanged |
| audio only (`flash.media.Sound`) | baseline + miniaudio, video **+0** | detection deliberately misses (§5.2) |
| video only (`NetStream` + `Video`), `video-formats: air` | **+4.45 MB** | H.264+AAC/MP3+FLV/MP4, **publish included** |
| video only, **default `broad`** | **+8.28 MB** | §6.1's full set; the 8 hwaccels are included (19 KB total) |
| video only, `video-formats: all` | unmeasured, est. +10–12 MB | adds VVC/dav1d/DASH |
| video + animation + networking | still only the FFmpeg delta | no overlap with curl/skia |

Two key points:

- **Size is decided by `video-formats`, not by whether hardware decode is on.** Write `air` when it must be
  small, take the default when it must be complete. No re-planning, no swapping libraries.
- **Publish is a flat +0.20 MB, independent of `video-formats`.** So the smallest useful artifact (a small app
  that pushes a stream) is `air` at 4.45 MB — not "`air` plus one more publish profile".

### 5.9 Pins

- `unit: build/VideoGate`: a snippet using `NetStream` must **not** produce `ASC_HAVE_VIDEO` under `video: off`;
  under `auto` it must, together with `vendor/video_glue.c`; detection only adds, never removes what the
  manifest already named.
- **Byte-for-byte generated C**: the same source built with and without `ASC_HAVE_VIDEO` must emit the same `.c`
  — the executable proof that injection touches only the link set, same shape as the existing `ASC_HAVE_AUDIO` pin.
- `unit: checks/vendor-video`: a missing prebuilt must surface as "build fails + how to fix", never as a silent pass.

---

## 6. FFmpeg trim list

Goal: **disable filters, devices and programs**; keep the **read** direction ("demux containers + decode
audio/video") plus the minimum **write** direction `NetStream.publish()` needs. We do not trim formats (§3
measured that trimming saves nothing) — we trim what AIR never had in the first place (transcode filters,
streaming-server features, image sequences).

The write direction needs exactly three components: the `flv` muxer, one H.264 encoder and the AAC encoder —
measured at **+0.20 MB** (§3).

> **Correction to the first draft's wording**: it said "trim encoding/publishing", which reads as "RTMP is
> unsupported". In fact **the RTMP protocol was never cut** (`--enable-protocol=…,rtmp,…` has been there since
> the first version); what `--disable-encoders --disable-muxers` removed is the **publish output surface**.
> Playback (`play()`) was always complete.

### 6.1 Baseline configuration (`broad`, verified by an actual build)

```bash
../ffmpeg-src/configure \
  --disable-everything --disable-autodetect \
  --disable-programs --disable-doc --disable-debug \
  --disable-avdevice --disable-postproc --disable-avfilter \
  --disable-encoders --disable-muxers --disable-filters \
  --enable-avformat --enable-avcodec --enable-avutil \
  --enable-swscale --enable-swresample \
  --enable-securetransport \
  --enable-protocol=file,http,https,tcp,tls,udp,crypto,rtmp,rtmps,rtmpt,rtsp \
  --enable-demuxer=mov,flv,matroska,mpegts,mp3,aac,ogg,wav,avi,asf,mpegps,rm,aiff,caf,w64,ivf,hls,rtsp,sdp \
  --enable-decoder=h264,hevc,mpeg4,mpeg2video,mpeg1video,vp8,vp9,vp6f,vp6a,flv,h263,prores,theora,vc1,wmv3,mjpeg,av1 \
  --enable-decoder=aac,aac_fixed,mp3,mp3float,opus,vorbis,flac,alac,ac3,eac3,dca,truehd,wmav2,nellymoser,adpcm_swf,speex \
  --enable-decoder=pcm_s16le,pcm_s24le,pcm_f32le,pcm_mulaw,pcm_alaw \
  --enable-parser=h264,hevc,mpeg4video,mpegvideo,vp8,vp9,av1,aac,aac_latm,mpegaudio,flac,opus,vorbis,ac3,dca,h263 \
  # --- publish write direction: just these three lines ---
  --enable-muxer=flv \
  --enable-encoder=h264_videotoolbox,aac \
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc
```

Encoders per target (**hardware only — no GPL or patent-ambiguous software encoder**):

| Target | Encoder | Extra flags |
|---|---|---|
| macOS | `h264_videotoolbox` | `--enable-videotoolbox` (already in the hwaccel group) |
| Windows | `h264_mf` | `--enable-mediafoundation` (mandatory under `--disable-autodetect`, otherwise it vanishes silently) |
| Linux | `h264_vaapi` | `--enable-vaapi`; **needs a usable render node** — build hosts without a GPU use `--no-publish` |

The write direction enables **only H.264 + AAC**. AIR can also publish Sorenson Spark (`H263`/`flv1`) and
Nellymoser; FFmpeg has LGPL encoders for both (not GPL), but they drag in the mpegvideo encoding framework and
their size is unmeasured, so they are **not wired** (§13). VP6 has a decoder only in FFmpeg — it cannot publish.

Hardware backends (append per target; **the software decoders are always kept for fallback**):

```bash
# macOS (measured: all 8 hwaccels work, +19 KB total)
  --enable-videotoolbox \
  --enable-hwaccel=h264_videotoolbox,hevc_videotoolbox,mpeg4_videotoolbox,mpeg2_videotoolbox,mpeg1_videotoolbox,prores_videotoolbox,vp9_videotoolbox,h263_videotoolbox
# Windows (not verified on real hardware; confirm names with configure --list-hwaccels)
  --enable-d3d11va --enable-dxva2 \
  --enable-hwaccel=h264_d3d11va,hevc_d3d11va,mpeg2_d3d11va,vc1_d3d11va,vp9_d3d11va,av1_d3d11va,wmv3_d3d11va
# Linux (optional, unverified)
  --enable-vaapi --enable-hwaccel=h264_vaapi,hevc_vaapi,vp9_vaapi,av1_vaapi
```

### 6.2 Profiles are line deletions, not separate builds

| Profile | Difference from `broad` | Decode only | With publish |
|---|---|---|---|
| `air` | only `mov,flv,mp3,aac` demuxers; `h264,aac,mp3,flv,vp6f` decoders; `h264,aac,mpegaudio,flv` parsers; hwaccels shrink to `h264_videotoolbox` | 4.25 MB | **4.45 MB** |
| `broad` (default) | everything in 6.1 | 8.09 MB | **8.28 MB** |
| `all` | `broad` + VVC decoder + `--enable-libdav1d` (faster, smaller AV1) + `--enable-libxml2` (DASH) + image sequences | unmeasured, est. +2–4 MB | — |

All three share one `ffmpeg-static.sh`, swapping only the decoder/demuxer lists — so the size table is
re-measurable at any time. **Publish is on by default** in all three; pass `--no-publish` for the old decode-only
shape.

### 6.3 Traps (all of them hit during a real build)

| Item | Notes |
|---|---|
| **`--disable-everything` also kills hwaccels** | `--enable-videotoolbox` alone is not enough: measured, `config_components.h` still had `CONFIG_H264_VIDEOTOOLBOX_HWACCEL 0`. Every hwaccel must be listed with `--enable-hwaccel=…`, or hardware decode silently does not exist |
| **`--enable-shared=no` is not a valid flag** | configure exits with `Unknown option`. Static is the default; if you want it explicit, write `--disable-shared` (the first draft of this document had this wrong — fixed) |
| TLS backend | `https:` needs a TLS implementation. macOS: `--enable-securetransport`; Windows: `--enable-schannel`. Do **not** build OpenSSL (+2–3 MB). Omitting it fails silently — https just stops working |
| `dash` demuxer | depends on libxml2; measured, configure skips it with `Disabled dash_demuxer because not all dependencies are satisfied`. DASH belongs to the `all` profile |
| `--disable-network` | **Do not pass it.** Even local playback often uses `http:` (CDN-hosted mp4); it leaves only `file:` |
| RTMP | FFmpeg ships its **own** rtmp protocol; librtmp is only an optional backend. `rtmp`/`rtmps`/`rtmpt` all work as measured |
| `rtmpe` / `rtmpte` | need `ffrtmpcrypt` → GMP, **measured off** (`CONFIG_RTMPE_PROTOCOL=0`). Adobe retired RTMPE; not worth chasing |
| `rtmps` | works as measured, but it rides on the TLS backend: on a Linux host without gnutls/openssl it is silently unavailable (same trap as `https:`) |
| **`--enable-encoder=X` only warns on unmet deps** | The component is silently disabled (`CONFIG_X_ENCODER 0`), producing a library that "builds fine but cannot publish". The script now greps `config_components.h` and asserts the three publish pieces (`flv` muxer / `aac` / platform H.264), exiting 3 if any is missing |
| **There is no LGPL software H.264 encoder** | FFmpeg has no native H.264 encoder; `libx264` is GPL (infects the whole artifact), `libopenh264` is BSD but **its patent cover only applies to Cisco's own binaries**. So: hardware only, and fail loudly when absent |
| `h264_mf` | Windows' MediaFoundation encoder. Under `--disable-autodetect` you must pass `--enable-mediafoundation`, or dependency resolution fails and the component vanishes silently |
| `--disable-encoders` then `--enable-encoder=` | configure processes options in order and **the later one wins**; that is how the script keeps the minimal set without a second config |
| `h264` decoder | The hardware path is **the `h264` decoder + the `videotoolbox` hwaccel** — there is **no** `h264_videotoolbox` **decoder** (that is the encoder name; do not copy `-c:v h264_videotoolbox`) |
| `aac` vs `aac_fixed` | float is higher quality, fixed uses less power; miniaudio's mix pipeline is f32, so the float decoder saves a conversion |
| `--disable-avfilter` | no filters needed; scaling is done by `swscale` (YUV420P → NV12, or straight to Skia) |
| `bsf=*_mp4toannexb` | **required when hardware decode is the default** (VT / D3D11VA both want Annex B start codes); only software-only builds can drop it |
| `--disable-autodetect` | do not pick up system libraries (zlib, iconv, sdl…) — keeps builds reproducible |
| Version | **take the latest stable tag** (currently `n9.0.2`), not master. **Sizes are tied to the tag**: the same flags grow 0.4–0.6 MB from n7.1 to n9.0.2, so re-measure after any tag change |
| **`--disable-postproc` is gone in n8+** | libpostproc was removed, so older scripts abort with `Unknown option`. `ffmpeg-static.sh` now probes `--help` for the flag (`--disable-everything` already turns that library off) |
| **accel flags changed spelling in n9** | n7's help lists only `--enable-videotoolbox`, n9's only `--disable-videotoolbox`. `--enable-X` still works on both, and **it must be passed explicitly**: measured, `--disable-autodetect` leaves `CONFIG_VIDEOTOOLBOX` at `0`, and only `--enable-videotoolbox` turns it back on. **Branching on `--help` will silently miss this** |
| GPL | **never** `--enable-gpl` / `--enable-nonfree` in the build script (drags in x264/x265/libfdk and breaks §8) |

**Build placement**: per AGENTS.md §2.9, FFmpeg is a **linked library**, not text pasted into the generated `.c`.
It goes through manifest `link-libs` / `include-paths`; the output remains "readable C + third-party static libs".
**Users normally do not write those fields by hand**: §5 fills them in when detection hits; a hand-written
manifest is only the opening left for builds that need to bypass detection.

---

## 7. Size and performance (measured; macOS arm64 / FFmpeg n9.0.2 / `cc -O2`)

| Item | Measured | Notes |
|---|---|---|
| Baseline, no video | **16 KB** | empty `main`, for comparison |
| `air` profile (H.264+AAC/MP3+FLV/MP4 only) | **4.25 MB** | the original "1.5–3 MB" guess was **too low**; measured wins |
| `air` + publish | **4.45 MB** | +204 KB: `flv` muxer 51 / encoders 170 / tunnelling 16 (n7.1 breakdown) |
| `mid` profile (comparison) | **6.46 MB** | not shipped; only measures "what one more rung costs" |
| `mid` + publish | **6.67 MB** | +220 KB |
| **`broad` profile (default, incl. 8 hwaccels)** | **8.09 MB** | §6.1's full set |
| **`broad` + publish (the actual default artifact)** | **8.28 MB** | +203 KB |
| `broad` + publish minus hwaccel | **8.26 MB** | eight hardware backends total **19 KB** |
| Software H.264 1080p | **4.3 ms/frame** (300 frames, 1.30 s user) | system ffmpeg 7.1.1 (homebrew), same source |
| Hardware H.264 1080p (VT) | **1.0 ms/frame** (300 frames, 0.30 s user) | same binary, A/B; 3.4× less CPU; **ignore wall clock** (`-f null` `hwdownloads` every frame) |
| Decoded frame → texture | **0.16 ms/frame @720p** via YUV direct render | see `yuv-direct-render.md` §8.4; hwaccel replaces this with a texture bridge of similar order |
| First-frame latency | target **< 100 ms** (local file) | VT/D3D11 device creation adds cost; **not measured** |

How to read these numbers:

- Sizes are `stat` of **a probe binary linked by one `cc`**, after `strip -x`; no LTO, no `-Os` (the latter would
  shrink further — unmeasured).
- The probe shape **covers both directions**: `avformat_open_input` + `avcodec_find_decoder` + `sws_getContext`
  + `swr_alloc`, plus the publish side's `avformat_alloc_output_context2("flv")` +
  `avcodec_find_encoder(H264/AAC)` + `avformat_write_header`. Static archives only pull referenced members, so
  **if the shape is not fixed, two tables measure two different programs** — the "decode only" and "with publish"
  columns are the same probe under two configurations and can be subtracted directly.
- **There is no accidental tree-shaking**: FFmpeg registers codecs through a static table, so **every enabled
  decoder is linked** — the `--enable-decoder` list *is* the size table, predictable by construction.
- **The version moves these numbers**: n7.1 → n9.0.2 grows the same flag set by 0.38 / 0.41 / 0.60 MB
  (air/mid/broad) — n9 gained a `prores_raw` videotoolbox hwaccel and larger demux/DSP code. **Re-measure after
  any tag change.**

**To re-measure, rerun §15's script** — all profiles share one source, just a different `--enable-*` list. If the
numbers move, update this table. **Per-program accounting for the injection gate is §5.8.**

---

## 8. LGPL compliance (mandatory; the risk is larger than the size)

Without `--enable-gpl`, FFmpeg is **LGPL-2.1-or-later**. Our project is **MIT**; statically linking an LGPL
library and distributing the result triggers LGPL-2.1 §7 obligations:

| Required | How |
|---|---|
| ① No GPL components | The build script **must not** contain `--enable-gpl` / `--enable-nonfree` (they pull in x264/x265/faac/libfdk) |
| ② Keep attribution and version | Version queryable at runtime (`av_version_info()`); show "Powered by FFmpeg (LGPL-2.1+)" |
| ③ Enable relinking | We ship **generated C + build manifest + a public repo**, so users can swap FFmpeg and rebuild — exactly the "ability to relink" §7 asks for. **If pure binary commercial distribution is ever added, ship the FFmpeg `.a`/objects too, or switch to dynamic linking** |
| ④ Include the license | Distribute FFmpeg's `COPYING.LGPLv2.1` plus a source URL |
| ⑤ Never link a GPL decoder | `FAAD2` (GPL-2) and `x264` (GPL-2) are off the table even if AAC/encoding is requested |

> **One fact that must be recorded honestly: LGPL grants no patent license.** But **the criterion for patent
> exposure is "who executes the decode", not "do we use FFmpeg"**: under hwaccel the decode is performed by the
> system decoder and the risk travels with the platform (§4.3); only the **software fallback path** puts it back
> on us. §4's decision (default to hwaccel) is therefore also the best patent position.

Once the format surface is wide, the risk is not uniform — three buckets (engineering judgement; legal still
needs to sign off):

| Bucket | Codecs | Conclusion |
|---|---|---|
| **Royalty-free** | VP8, VP9, AV1 (AOMedia), Theora, FLAC, Opus, Vorbis, all PCM | safe even as software decode; no pool |
| **Expired / essentially expired** | MPEG-1, MPEG-2 Video, MPEG-4 Part 2 (DivX/Xvid), H.263, AC-3 | legacy support, low risk |
| **Needs review** | **H.264** (residual obligations), **HEVC** (three overlapping pools — Access Advance / Via LA / MPEG LA — the most expensive), DTS (`dca`), TrueHD | **default to hardware; fall back to software when hardware is unavailable** (decision 2026-11-12). That puts the licensing risk for these three **on us**, not on the platform |
| **Undetermined** | VC-1 / WMV3 (Microsoft, legacy) | keep the decoder, do not advertise it |

Concretely for our default: the heaviest items in `broad` (HEVC/DTS/TrueHD) all have hardware paths, **yet they
still fall back to software when hardware is missing** (§14 items 4/6) — "it plays" outranks "zero licensing
exposure", because AIR decodes in pure software anyway and erroring out would be *below* AIR. To shrink the risk,
drop `video-formats` to `air` (which excludes HEVC/DTS/TrueHD); no code change needed.

---

## 9. Multi-target matrix

| Target | Demux | Decode | Encode (publish) | Output | Notes |
|---|---|---|---|---|---|
| macOS arm64 | FFmpeg | **VideoToolbox (default)**: h264, hevc, mpeg1/2/4, h263, prores, vp9; the rest software | `h264_videotoolbox` + `aac` (system hardware) | `CVPixelBuffer` → `CVMetalTextureCache` → `GrBackendTexture` | arm64 software decode uses NEON, no extra assembler needed |
| Windows x64 | FFmpeg | **D3D11VA (default)**: h264, hevc, mpeg2, vc1, vp9, av1, wmv3; the rest software (DXVA2 for older systems) | `h264_mf` + `aac` (MediaFoundation, **not verified on hardware**) | `ID3D11Texture2D` → `GrBackendTexture` | software SIMD needs nasm/yasm (see `checks.ts`) |
| Linux | FFmpeg | software; VAAPI optional (h264/hevc/vp9/av1, **unverified**) | `h264_vaapi` (**needs a GPU**; no software fallback → `publish()` errors without a render node) | `AV_PIX_FMT_YUV420P` → Skia YUV direct render | builds via the ELF target |
| Web (`--target wasm --package web`) | browser | **browser-native** (`<video>` / WebCodecs) | browser (`MediaRecorder` / WebCodecs); needs `NetStream.appendBytes` to produce its own bitstream | canvas → WebGL/WebGPU | **do not compile FFmpeg into wasm** |
| WASI (`--target wasm`) | none | none | none | — | **fail loudly** ("this backend does not support video"), never silently degrade |
| **iOS (reserved, no target yet)** | FFmpeg | **VideoToolbox** (same lineage as macOS, same `videotoolbox` hwaccels) | `h264_videotoolbox` + `aac` | `CVPixelBuffer` → `CVMetalTextureCache` → `GrBackendTexture` | **shares one glue with macOS**; the difference is devices/permissions. Note iOS forbids shipping executable code, so this path only holds when everything is fixed at build time |
| **Android (reserved, no target yet)** | FFmpeg | **MediaCodec** (FFmpeg only wraps it as a codec, **there is no unified hwaccel framework**); otherwise software | `h264_mediacodec` (unverified) | `AHardwareBuffer` → `EGLImage` → `GrBackendTexture` | needs an NDK build; **the one target that needs a bespoke hardware bridge** — do not assume it is shaped like the desktop ones |

**The format surface is asymmetric across targets** (recorded explicitly — we must not claim "identical on all
targets"):

| Format | macOS | Windows | Web |
|---|---|---|---|
| MP4/FLV/HLS + H.264/AAC/MP3 | ✅ | ✅ | ✅ (all browsers) |
| MKV/TS/AVI/ASF/RM containers | ✅ | ✅ | ⚠️ `<video>` only takes MP4/WebM; full support would need JS demuxing (not doing it) |
| HEVC | ✅ hardware | ✅ hardware | ⚠️ Safari / some Chrome platforms hardware-decode it; Firefox does not |
| VP9 / AV1 | ✅ (VP9 can be hardware, AV1 software) | ✅ hardware | ✅ |
| DTS / TrueHD / WMA | ✅ software | ✅ software | ❌ no browser counterpart |

So: **the native desktop targets get "every format"; web gets whatever the browser is willing to give.** That is a
hard platform boundary (AGENTS.md §1.5), stated as such rather than papered over. Getting every format on web has
exactly one route — compile FFmpeg to wasm — at 4–8 MB and a saturated core, and that has been ruled out
(2026-11-12).

> **Mobile is the sixth/seventh target to plan around** (user, 2026-11-12): nothing is implemented now, but the
> interface must not be painted into a corner. The cost is lopsided — iOS is nearly free (VT is the same backend as
> macOS, plus permission/lifecycle plumbing), Android is the hard one (MediaCodec is per-frame surfaces, not a
> hwaccel) — so the `backend` parameter of `as_video_*` has to stay abstract enough that "a hwaccel context" is not
> assumed to be the shape every backend has.

**Web specifics**: compiling FFmpeg to wasm grows the artifact from hundreds of KB to **4–8 MB** and saturates a
core for 720p. Browsers already provide `<video>` and `WebCodecs` — **use those by default**, compile FFmpeg only
for native targets. This is exactly what the manifest's `targets.<target>` layering (**replace**, not append) is for:
the native manifest carries the FFmpeg `link-libs`, the web manifest does not. The exact injection rules are §5.4.

---

## 10. How this connects to existing assets (our real cost advantage)

| Existing asset | Use in video playback |
|---|---|
| **YUV direct render** (`yuv-direct-render.md`; all four Skia targets have `TextureFromYUVAPixmaps`) | Software path: FFmpeg outputs `YUV420P` **straight into a texture**, skipping one YUV→RGBA CPU pass (~1 ms/frame at 720p). hwaccel path: frames are already on the GPU, so this step degrades to a texture bridge (`CVPixelBuffer`/`ID3D11Texture2D` → `GrBackendTexture`), which also removes the upload |
| `BitmapData` pixel contract (internal `0xAARRGGBB`) | Route pixel-level access through "decode → YUV → materialize on demand"; never materialize by default |
| `vendor/audio_glue.c` (miniaudio) | **MP3/FLAC/WAV/Vorbis already decode**; AAC is decoded by FFmpeg into PCM and fed to miniaudio's f32 mix pipeline — no separate audio device layer |
| ANE video frame path (`getVideoBitmapData`) | File playback and RTC frames share the same "upload texture" exit; only the upstream differs |
| Async job table (`as_job_*`, stage 89·45) | Demux/decode belongs on the same background jobs; decoder contexts are **long-lived**, never rebuilt per frame |

---

## 11. Implementation placement (per AGENTS.md layering)

| Layer | Placement | Forbidden |
|---|---|---|
| C glue | new `vendor/video_glue.c`: `as_video_open/read_frame/decode/close` over `AVFormatContext`/`AVCodecContext`, with `backend` (`auto`/`soft`) and `formats` (`air`/`broad`/`all`) parameters; `auto` does its own probing and fallback | AS3 semantics inside it (`NetStream` state machine belongs to codegen); platform window/device glue inside the glue layer |
| Runtime | `src/runtime.ts` declarations + no-op stubs (builds without FFmpeg must fail loudly, never return empty frames) | `avformat.h` appearing in generated C |
| AS3 semantics | `NetStream`/`Video` in `src/emit.ts`: `play/pause/seek/time/client` callbacks, `#2126`-style error codes | decoding logic in `emit.ts` |
| Build | `src/build.ts` manifest fields (`link-libs`/`include-paths`/`sources`) + one `checks.ts` row for FFmpeg presence | a second, drifting check set in the CLI |

**Error semantics**: `play()` cannot open → `IOErrorEvent`; unsupported container/codec → `NetStream.Play.Failed`
(exact text must be taken from `adl`, not guessed); **"compiles, runs, black screen" is never acceptable**.

---

## 12. Phased plan (not scheduled)

| Phase | Content | Acceptance |
|---|---|---|
| V0 | **Settle this document + trim measurement**: build each profile, measure linked size, the hwaccel marginal cost, and 1080p throughput for both decode paths | **done 2026-11-12**: numbers in §3/§7; reproducible via `vendor/provision/ffmpeg-static.sh` (tracked) |
| V1 | **Decode seam + software + the injection gate + three format profiles**: `as_video_*` takes `backend` and `formats`; land `usesVideoCodec` / `video` / `video-formats`; containers `mov,flv,matroska,mpegts,mp3,aac,ogg,wav`, video `h264,hevc,vp9,av1` software, audio `aac,mp3,opus,vorbis,flac`; `onMetaData` + audible audio | `examples/video.as` plays a bundled sample; item-by-item parity with `adl` (`videoWidth/Height`, `time`, `onMetaData`); **format matrix self-test**: at least one clip per container×codec yields both sound and picture; examples that do not touch video keep their size (§5.8) |
| V2 | **macOS hardware decode + zero-copy presentation**: `videotoolbox` backend covering all 8 hwaccels (h264/hevc/mpeg1/2/4/h263/prores/vp9) + `CVMetalTextureCache` bridge; probe failure falls back silently | A/B on the same source: user CPU, wall clock, bridge cost; forcing VT off must fall back silently rather than produce a black screen; HEVC 1080p run both ways |
| V3 | **Windows D3D11VA backend** (7 hwaccels) + `pause/seek` + buffering states + the `NetStream.Play.*` event sequence | parity with `adl`; identical behaviour from one `.as` on all three targets (backend differences confined to pixel formats) |
| V4 | Transport (**read**): `http:` progressive → **HLS** (`hls`+`mpegts`+`crypto`, already in `broad`) → RTMP/RTSP (FFmpeg's native protocols, **no librtmp**) | AIR's `NetStream.Play.*` sequence; HLS live latency/catch-up policy captured as a reproducible test |
| V5 | **publish output surface (write)**: `NetStream.publish()` + `appendBytes()` (a native AIR API that feeds already-encoded data, bypassing capture devices) + `flv` muxing + hardware H.264/AAC + `rtmp`/`rtmps` pushing; the build side was already paid in V0 (§6.1) | verify against `ffmpeg -listen 1 -i rtmp://127.0.0.1:1935/live/x` as the receiving end; the `appendBytes` path needs no capture device; a machine without a hardware encoder must fail with a clear error, never silently |
| V6 (enhancement, opt-in) | `all` profile (VVC, `libdav1d`, DASH via `libxml2`), multi-audio/subtitle track selection, `StageVideo` | explicitly labelled enhancement, off by default |

---

## 13. Explicitly unsupported / deferred

| Item | Reason |
|---|---|
| **`Camera` / `Microphone` capture backends** (the only remaining publish gap) | Currently stubs: `Camera.getCamera()` returns NULL (`src/symbols.ts:2756`) and `Microphone` is a shell too. Wiring AVFoundation / MediaFoundation / V4L2 capture plus permission prompts is work **independent of FFmpeg**. The mux/encode/push side is fully in place (V5); what is missing is "who produces the frames". **Decision (2026-11-12): not scheduled**; acceptance goes through `appendBytes()` |
| `rtmpe` / `rtmpte` | need `ffrtmpcrypt` → GMP, measured off; Adobe retired RTMPE |
| Software H.264 encoding | no LGPL option: `libx264` is GPL, `libopenh264`'s patent cover only applies to Cisco's own binaries. **Decision (2026-11-12)**: hardware only, fail loudly when absent, never pull in GPL |
| Sorenson Spark / Nellymoser publishing | AIR's `publish()` can push both by default. FFmpeg has LGPL `flv`(flv1) and `nellymoser` encoders, but we enable only H.264+AAC; wiring them drags in the mpegvideo encoding framework and the size is unmeasured. VP6 has a decoder only |
| `StageVideo` | needs a compositing layer outside the display list — same order of work as `Stage3D`; start with `Video` + display list (planned for V6) |
| Hand-written VideoToolbox / Media Foundation decoders | §4.2 rules this **not scheduled**; re-evaluate only if the LGPL or artifact-size constraints change fundamentally |
| VVC (H.266) | FFmpeg's decoder is still experimental (`--enable-decoder=vvc`); belongs to the `all` profile |
| DASH | the demuxer needs libxml2 (measured: configure skips it); HLS covers the common case — DASH joins the `all` profile and drags libxml2 in |
| Playing image sequences as video | AIR handles stills through `Loader`/`BitmapData`; routing them through the video path is the wrong model |
| DRM (`DRMContentData`) | AIR itself no longer supports it on most platforms |
| Video on WASI | no window, no audio device — unverifiable |

---

## 14. Decisions (settled 2026-11-12)

| # | Question | Decision | Where it lands |
|---|---|---|---|
| 1 | First container: MP4 or FLV | **Not an either/or**: default `broad` + publish carries everything (MP4/MOV/FLV/MKV/TS/HLS/RTMP). `air` is only for size-capped artifacts | §3, §6.2 |
| 2 | Compile FFmpeg for web too | **No** — use `<video>` / WebCodecs, record the divergence explicitly. **Also: iOS and Android are coming later**; leave the interface open (iOS shares the macOS VT backend; Android's MediaCodec is not a hwaccel and needs its own texture bridge) | §5.4, §9 |
| 3 | Granularity of the decode-backend switch | **`video-backend: auto` (default, the only recommended value)**: it probes for hardware decoding and falls back to software on its own. There is no hand-picked `hw` setting — it would only pick what `auto` already picks. Keep `soft` for troubleshooting only | §5.3 |
| 4 | Exposure of the software fallback | **Accepted**: fall back to software instead of erroring out when hardware is unavailable, so old GPUs and VMs still play. Risk discussion in §8 | §4.3, §8 |
| 5 | FFmpeg version | **Take the latest stable tag** (currently `n9.0.2`), do not pin an old one. Cost: sizes move with the tag, so re-measure after any change (n7.1 → n9.0.2 grows 0.38–0.60 MB) | §6.3, §7 |
| 6 | Software fallback for HEVC / DTS / TrueHD | **On**: software decode costs nothing extra (the decoders are already in `broad`'s list), and it is used whenever hardware is missing. **We carry the licensing risk for these three ourselves** (§8 is written to that position) | §8 |
| 7 | `Camera` / `Microphone` capture | **Not scheduled**. The mux/encode/push side of publish is in place; acceptance goes through `appendBytes()` (no capture device needed) | §13 |
| 8 | Does the `air` profile carry publish | **Yes** (`NetStream.publish()` is AIR-defined; without it the profile is a subset), measured at +0.20 MB | §3, §6.1 |
| 9 | Pure software H.264 encoding | **No**: hardware only (VT / MF / VAAPI), a clear error when no encoder exists. Neither GPL `libx264` nor a bet on `libopenh264`'s patent boundary | §6.1, §13 |

**Still open** (non-blocking):

1. **Whether to add the `all` profile**: VVC + `libdav1d` + DASH (`libxml2`). `broad` already covers real-world use;
   `all` only makes it "more complete".
2. **The Windows entry point for video**: `macos.sh --only video` exists, `windows.ps1` has none — FFmpeg needs an
   MSYS2/MinGW shell while that script is entirely clang-cl + MSVC ABI. Whether and how to add it is deferred to
   the Windows acceptance for V5 (publish).

---

## 15. Reproduction (what can be done today)

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

# 3) Trim measurement (V0 done; reproducible in one command)
cd /path/to/repo-root                       # repository root, one level above build-tools/
[ -d build-tools/ffmpeg-src ] || git clone --depth 1 -b n9.0.2 https://git.ffmpeg.org/ffmpeg.git build-tools/ffmpeg-src
# latest stable: git ls-remote --tags origin | grep -oE 'n[0-9]+\.[0-9]+(\.[0-9]+)?$' | sort -V | tail -1
# every size number above is an n9.0.2 measurement (n7.1 is 0.4-0.6 MB smaller with identical flags)
bash vendor/provision/ffmpeg-static.sh air     # 4.45 MB (publish included)
bash vendor/provision/ffmpeg-static.sh mid     # 6.67 MB (comparison only)
bash vendor/provision/ffmpeg-static.sh broad   # 8.28 MB (default profile)
bash vendor/provision/ffmpeg-static.sh air --no-publish   # 4.25 MB (decode-only column in §3)
# first run clones the sources: ASC_FFMPEG_TAG defaults to n9.0.2 (latest stable) into build-tools/ffmpeg-src
# deploy into vendor/ (same pipeline as curl/skia, LGPL license included):
bash vendor/provision/macos.sh --only video    # = ffmpeg-static.sh broad + copy into vendor/ffmpeg/
# the script prints profile=… publish=… linked=… stripped=…; artifacts land in build-tools/ffmpeg-out/<profile>/
# on Windows/Linux hosts it swaps in --enable-d3d11va / --enable-vaapi and h264_mf / h264_vaapi
# a failed publish assertion exits 3 instead of silently producing a library that cannot stream

# 4) Confirm the hardware backend is really in use (system ffmpeg is enough; no need to build first)
ffmpeg -hwaccels                                   # should list videotoolbox on macOS
ffmpeg -v verbose -hwaccel videotoolbox -i t.mp4 -f null - 2>&1 | grep -E "Selecting decoder|pix_fmt"
#   expect: Selecting decoder 'h264' because of requested hwaccel method videotoolbox
#           Reinit context to WxH, pix_fmt: videotoolbox_vld
# 5) Compare CPU of both paths (same source, three runs, stable values; wall clock is not the metric)
/usr/bin/time -p ffmpeg -hide_banner -loglevel error -i t.mp4 -f null -
/usr/bin/time -p ffmpeg -hide_banner -loglevel error -hwaccel videotoolbox -i t.mp4 -f null -
```

---

## 16. Reference anchors

- AS3 reference: [`flash.net.NetStream`](https://airsdk.dev/reference/actionscript/3.0/flash/net/NetStream.html),
  [`flash.media.Video`](https://airsdk.dev/reference/actionscript/3.0/flash/media/Video.html),
  [`flash.media.VideoCodec`](https://airsdk.dev/reference/actionscript/3.0/flash/media/VideoCodec.html)
- FFmpeg trimming and licensing: [ffmpeg-all](https://ffmpeg.org/ffmpeg-all.html), [legal](https://ffmpeg.org/legal.html)
- In-repo docs: [`yuv-direct-render.md`](yuv-direct-render.md) (YUV direct render, implemented),
  [`audio.md`](audio.md) (miniaudio backend and audio parity),
  [`flash-net.md`](flash-net.md) (`NetConnection`/`URLLoader` state)
- Repo-root analyses: [`video-frame-copy-chain-analysis.md`](../../../video-frame-copy-chain-analysis.md),
  [`yuv-video-direct-draw-analysis.md`](../../../yuv-video-direct-draw-analysis.md)
