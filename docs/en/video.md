# Video playback (`flash.net.NetStream` / `flash.media.Video`) — research and design

> This document answers one question: **what is the current state of AS3 video playback, and what does it take
> to actually get pixels on screen — and with which open-source stack.**
> Bottom line: **there is zero support, and it fails loudly** — `NetStream.play()` throws
> `flash.net.NetStream.play: media transport and FLV decoding are not supported by this subset`
> (`src/emit.ts:16607`), and `Video.attachNetStream()` is a no-op (`src/emit.ts:16630`). The repository has
> no demuxer, no video decoder, and no video clock.
>
> **Status: V1 is implemented and verified (2026-11-13, see §16); V3 hardware decode and its zero-copy path are
> wired up and measured on Windows (2026-11-14, see §16.8/§16.9) and on macOS/VideoToolbox (2026-11-19, see §16.13);
> HDR10+/HLG tone mapping exists but is off by default (§16.10); V2 and the transport surface are not scheduled.** §1 is the **pre-implementation** snapshot (2026-11-12), kept because the starting
> point is what motivated every trade-off below; §16 is the authoritative description of the code as it stands:
> `NetStream` / `Video` / `NetConnection` follow AIR semantics, decode goes through FFmpeg (software), and the
> 31 assertions in `examples/video/` all pass in a real window.
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

## 1. Current state: `NetStream` is a throwing stub, `Video` is a shell (2026-11-12 snapshot)

> **This section is a historical snapshot.** Since 2026-11-13 both statements are obsolete: `NetStream` and
> `Video` are implemented on top of FFmpeg (§16). The text is kept so the "why link FFmpeg instead of writing
> a decoder" decision has a starting point to compare against.

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

> **Where the implementation stands (written 2026-11-13, updated 2026-11-19)**: V1 is **software only** —
> `video-backend` accepts `auto`/`soft` and they are identical; at the time `auto` had no hardware backend to probe
> (V2 = macOS VT + `CVMetalTextureCache` zero copy, V3 = Windows D3D11VA). **Both have since landed and been
> measured** (Windows §16.8/§16.9, macOS §16.13), and `auto` now means "go hardware only when zero copy works". That does not mean "4K cannot play": software 4K
> 10-bit HEVC measures 8.8 ms/frame on one thread and is fully hidden with 8 threads. The reported "4K stutters
> to the point of being unwatchable" traced to converting twice + single-threaded decode + a 24 Hz frame clock +
> CPU raster, measured and fixed item by item in §16.7. What hwaccel buys here is the 6 ms of `conv` and the CPU
> time, not whether it plays at all.

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
| `vendor/provision/windows.ps1 -Only video -Arch both` | runs the recipe once per arch (`--arch=x64|x86`); artifacts land in `build-tools/ffmpeg-out/broad-win-<arch>/` → `vendor/ffmpeg/lib/windows-<arch>/*.lib` |

**The artifacts are committed (macOS + Windows)**: as of 2026-11-12 the whole `vendor/ffmpeg/` tree is in git
(the five macOS arm64 `.a` files and the ten Windows `.lib` files, ~62 MB total). The cost is repository size;
the gain is "clone and build" — no need to assemble MSYS2/nasm/vcvars before linking a video program.
Rebuilding is still one command: `macos.sh --only video` / `windows.ps1 -Only video -Arch both` (the latter
rewrites both widths).

Profile via `ASC_FFMPEG_PROFILE` (default `broad`); source tree via `ASC_FFMPEG_SRC` (default
`build-tools/ffmpeg-src`, cloned at `ASC_FFMPEG_TAG`, default `n9.0.2`, when absent).

**On Windows (both x86 and x64)**: the entry point is `windows.ps1 -Only video` (not in the default package
set — it needs two tools the other three packages do not). Artifact names differ from macOS: the msvc
toolchain sets `LIBPREF` empty, so the archives are `avformat.lib`/`avcodec.lib` with no `lib` prefix. Three
constraints, all measured (the recipe header carries the full evidence):

1. **MSVC ABI, not MinGW**, matching `src/build.ts::windowsTargetTriple`'s
   `--target={x86_64,i686}-pc-windows-msvc`. A MinGW `libav*.a` is GNU ABI (`___chkstk_ms`, the mingw CRT)
   and does not link — the failure surfaces in the *application* link, far from the cause.
2. **clang-cl is the compiler**: MSVC 19.43 no longer honours `-o` (D9035) while configure compiles every
   test as `-c -o obj src`, so a real `cl.exe` drops the object into the CWD and the first link test dies
   with `LNK1136`. configure's msvc version gate still probes `cl.exe`, so both must be on PATH —
   `windows.ps1` arranges that.
3. **x86 needs the x86 vcvars environment** (`INCLUDE`/`LIB` are per-arch); with the x64 environment the
   link test dies with `LNK4272` (x64 `libcmt.lib` against an x86 target). `windows.ps1` already imports
   per arch, and `Build-Video` reuses that.

External dependencies: a POSIX shell (MSYS2 or Cygwin) + GNU `make` + `nasm` (x86 SIMD kernels). Git for
Windows' bundled bash is MSYS2-derived but has **no make**; the script names whichever piece is missing
instead of failing mysteriously at `make`.
**Omitting `--arch` builds both widths**: the recipe runs x64 then x86, and each pass imports that width's
vcvars environment into the current shell itself (`vswhere` → `vcvarsall` → env dump → `cygpath`), so a single
`ffmpeg-static.sh broad` produces both trees. A half import (no System32 on PATH, hence the SDK silently
missing) is rejected outright instead of surfacing later as `windows.h` not found.
**Windows sizes are measured** (§7's closing paragraph: probes 10.6 MB x64 / 9.4 MB x86, archives 20.4 / 16.9 MB).

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

**Windows (MSVC ABI, same probe, same `broad`+publish profile)**: probe **10.6 MB** on x64 / **9.4 MB** on x86;
the five archives total **20.4 MB** (x64) / **16.9 MB** (x86). That is ~2 MB more than macOS arm64: the MSVC
target carries its own CRT/SEH, and Windows has **14** hardware backends (7 codecs × d3d11va/dxva2). The
`linked` and `stripped` columns are **identical** here — PE gives no `strip -x` win because nothing ever carried
debug info; it is not that `llvm-strip` was skipped.

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
| macOS arm64 | FFmpeg | **VideoToolbox (default, implemented)**: h264, hevc, mpeg1/2/4, h263, prores, vp9; the rest software | `h264_videotoolbox` + `aac` (system hardware) | **`CVPixelBuffer` (IOSurface) → `CVMetalTextureCache` planes → `MTLTexture` ×2 → `GrBackendTexture[2]` → `SkImages::TextureFromYUVATextures` (zero copy, §16.13)** | arm64 software decode uses NEON, no extra assembler needed |
| Windows x64 | FFmpeg | **D3D11VA (default)**: h264, hevc, mpeg2, vc1, vp9, av1, wmv3; the rest software (DXVA2 for older systems) | `h264_mf` + `aac` (MediaFoundation, **not verified on hardware**) | `ID3D11Texture2D` → `GrBackendTexture` | software SIMD needs nasm/yasm (see `checks.ts`) |
| Linux | FFmpeg | software; VAAPI optional (h264/hevc/vp9/av1, **unverified**) | `h264_vaapi` (**needs a GPU**; no software fallback → `publish()` errors without a render node) | `AV_PIX_FMT_YUV420P` → Skia YUV direct render | builds via the ELF target |
| Web (`--target wasm --package web`) | browser | **browser-native** (`<video>` / WebCodecs) | browser (`MediaRecorder` / WebCodecs); needs `NetStream.appendBytes` to produce its own bitstream | canvas → WebGL/WebGPU | **do not compile FFmpeg into wasm** |
| WASI (`--target wasm`) | none | none | none | — | **fail loudly** ("this backend does not support video"), never silently degrade |
| **iOS (reserved, no target yet)** | FFmpeg | **VideoToolbox** (same lineage as macOS, same `videotoolbox` hwaccels) | `h264_videotoolbox` + `aac` | `CVPixelBuffer` → `CVMetalTextureCache` → `GrBackendTexture` | **shares one glue with macOS**; the difference is devices/permissions. Note iOS forbids shipping executable code, so this path only holds when everything is fixed at build time |
| **Android (reserved, no target yet)** | FFmpeg | **MediaCodec** (FFmpeg only wraps it as a codec, **there is no unified hwaccel framework**); otherwise software | `h264_mediacodec` (unverified) | `AHardwareBuffer` → `EGLImage` → `GrBackendTexture` | needs an NDK build; **the one target that needs a bespoke hardware bridge** — do not assume it is shaped like the desktop ones |

**Implementation status (checked against code and measurements, 2026-11-19)**: the Decode and Output columns describe the
**target shape**, not what each target already does. As of v0.4.421 **Windows x64 has D3D11VA hardware decode plus zero
copy** landed and measured on hardware (§16.8, §16.9; 4K HDR10+ at 60 Hz in a real window, 0.27 ms/frame), and so does
**macOS arm64 with VideoToolbox** (§16.13; same machine class, 4K 10-bit at 60 Hz in a real window, 0.13 ms/frame).
macOS's seam is `vendor/video_metal.mm`, the parallel of `vendor/video_d3d.cc`: both turn a decoded GPU picture into
Skia YUVA textures, but the Apple side's carrier is a `CVPixelBuffer` (already an IOSurface, so no blit at all) while
the Windows side has to split plane slices across D3D11/D3D12. iOS / Android / Linux-VAAPI are still target shapes (the
two mobile targets are not even supported as `--target` values; iOS shares the macOS seam, differing only in permissions
and target). §4's "implementation status" note says the same thing: do not read the table alone and assume it is all
landed.

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
| V1 | **Decode seam + software + the injection gate + three format profiles**: `as_video_*` takes `backend` and `formats`; land `usesVideoCodec` / `video` / `video-formats`; containers `mov,flv,matroska,mpegts,mp3,aac,ogg,wav`, video `h264,hevc,vp9,av1` software, audio `aac,mp3,opus,vorbis,flac`; `onMetaData` + audible audio | `examples/video.as` plays a bundled sample; item-by-item parity with `adl` (`videoWidth/Height`, `time`, `onMetaData`); **format matrix self-test**: at least one clip per container×codec yields both sound and picture; examples that do not touch video keep their size (§5.8)  **Completed 2026-11-13** (implementation status, measured numbers and reproduction: §16; the cost split of a real 4K source: §16.7) |
| V2 | **macOS hardware decode + zero-copy presentation**: `videotoolbox` backend covering all 8 hwaccels (h264/hevc/mpeg1/2/4/h263/prores/vp9) + `CVMetalTextureCache` bridge; probe failure falls back silently  **Completed 2026-11-19** (`vendor/video_metal.mm`; the three-route A/B, the colour comparison and the `AS_VIDEO_ZC=0` readback control are in §16.13) | A/B on the same source: user CPU, wall clock, bridge cost; forcing VT off must fall back silently rather than produce a black screen; HEVC 1080p run both ways; **zero-copy proof**: either a source swap (`TextureFromYUVAPixmaps`) or the `AS_VIDEO_ZC=0` readback route must show a measurable difference (no difference = zero copy was not really happening) — this round used the latter: 10.7 → 0.13 ms/frame, process CPU 8.76 → 0.56 s (§16.13.1) |
| V3 | **Hardware decode + zero-copy presentation + an adaptive default**: a Windows D3D11VA backend (7 hwaccels, §16.8/§16.9) and a macOS VideoToolbox one (8 hwaccels, §16.13), each with its own zero-copy seam and with the "hardware only when zero copy works" default; plus `pause/seek`, buffering states and the `NetStream.Play.*` event sequence | parity with `adl`; identical behaviour from one `.as` on all three targets (backend differences confined to pixel formats) |
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
2. **The Windows entry point for video**: **landed** (2026-11-12). `windows.ps1 -Only video` runs
   `ffmpeg-static.sh --arch=x64|x86` once per arch through `--toolchain=msvc` + clang-cl, producing
   `vendor/ffmpeg/lib/windows-<arch>/*.lib`. The only unverified part is the final step: this host has no
   MSYS2/`make`/`nasm`, so **the `make` stage and the size numbers are unmeasured**; the `configure` stage
   (every component assertion plus the `ARCH_X86_32/64` check, both arches) passed on MSVC 14.43 + LLVM 23.1.

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

## 16. V1 implementation status and measurements (2026-11-13)

**V1 is in place**: software decode, the injection gate, the `broad` format surface, `onMetaData` and
audible audio — all measured. This section describes **what the code does now**, not a plan; the
"throwing stub" in §1 is the 2026-11-12 snapshot, kept so the starting point stays visible.

### 16.1 Where it lives

| Layer | File | Contents |
|---|---|---|
| C glue | `vendor/video_glue.c` | `as_video_open/close/tick/state/time/info/frame/seek/pause/resume`; integer handles over a static pool (`AS_VIDEO_MAX` 8 concurrent streams); **knows nothing about the GC or AS3 events**, it is pure FFmpeg |
| AS3 semantics | `src/emit.ts` | the bodies of `NetConnection`/`NetStream`/`Video`, `netStatus` dispatch, `onMetaData`, `_ns_tpos`/`_ns_vw`/`_ns_vht`, error ids `#2126`/`#2007` |
| Runtime | `src/runtime.ts` | the `AS_VIDEO_ST_*` bits and the no-FFmpeg stub (`as_video_open` returns `-2` instead of empty frames) |
| Build | `src/index.ts` + `src/build.ts` | detect whether the program uses `NetStream`/`Video` → decide whether FFmpeg is linked; the `video` / `video-formats` / `video-backend` manifest fields override it |
| Example | `examples/video/` | `VideoPlayer.as` (windowed, 31 assertions) plus `media/`, seven fixtures of our own (no third-party material) |

**The gate is a build-time decision**, and `NetStream.play()` failure has two entirely different meanings:

- The program uses `NetStream` but this artifact was built without FFmpeg (`video: "off"` or a missed
  detection): `as_video_open` returns `-2` and `play()` **throws synchronously**
  `[as3-aot] not implemented by this build: video playback requires an FFmpeg-linked build`.
  That is a missing capability, not a bad file, so it must be loud.
- FFmpeg is linked but the file cannot be opened / the container is unsupported: an **asynchronous**
  `NetStatusEvent` `NetStream.Play.Failed` (`level="error"`, `info.description` carries FFmpeg's reason).
  This matches `adl`: `play()` returns `void` and never throws on that path.

### 16.2 State machine and frame clock

`NetStream.play()` dispatches `NetStream.Play.Start` + `NetStream.Buffer.Full` synchronously (a local file
needs no buffering) and **decodes the first frame in `as_video_open`**, so `videoWidth`/`videoHeight` and a
picture exist immediately after `play()` rather than after a black beat. Everything after that hangs off the
**frame boundary**: `as_ns_tick()` at the top of `Stage_dispatchFrame()`, the same safe point as timers and
MovieClips (live NetStreams are GC roots and are advanced one by one there).

`onMetaData` is **asynchronous** (AIR semantics, and what we implement): it reaches the client on the first
frame boundary after `play()`, not inside the call. The example used to assert it synchronously right after
`play()` and went red in a real window for that reason — moving the assertions after the first `setTimeout`
is the honest form (§16.5 records the lesson).

### 16.3 Presentation pacing: a FIFO, not a single slot

Decoding runs at most **80 ms ahead of the clock** (`AS_VIDEO_LEAD_S`), with a budget of 24 packets per frame
boundary (`AS_VIDEO_TICK_PACKETS`). That alone is not enough; two traps were found by measurement:

1. **The pacing check must come before the read.** Written as "read a packet → decode → break if ahead", every
   frame boundary still pulled one extra frame. Invisible at 60 fps, but a hand-pumped frame loop (hundreds of
   ticks per millisecond) consumed a 1.2 s clip in its first dozen ticks.
2. **Ahead-of-clock frames need more than one slot.** `advance()` keeps demuxing so audio never starves, and
   **interleaving drags video frames along** (~2 frames per tick on an interleaved clip). A single slot therefore
   always held the newest frame (~80 ms ahead of the clock) and **never came due**: measured as
   `NetStream.time` stuck at `0.000` for a whole 0.4 s pump while the slot chased the decoder. An 8-entry FIFO
   (`AS_VIDEO_QUEUE`) lets the clock pick the frame that belongs there; on overflow the **oldest** frame is
   dropped (when you are behind real time, the frame the viewer missed is the old one, not the newest).

`as_video_tick` dequeues every frame that has come due and **keeps the last one** — that is what the clock is
showing.

### 16.4 Container differences (measured)

| Symptom | Root cause | Fix |
|---|---|---|
| `clip.ts` decoded one frame, `video_frames=1 audio_frames=0`, `time` stuck at 0 | An MPEG-TS `start_time` is a broadcast epoch: `clip.ts` starts at **1.533 s**, so raw pts compared against the 0-based play clock looked "ahead" on the first frame and decoding stopped immediately | Record `v_start` (`st->start_time × time_base`) and subtract it from pts; `NetStream.time` counts from the first frame, not from the timebase epoch |
| An audio-only stream (`tone.mp3`) segfaulted on its first `play()` | `as_video_drain_video` called `avcodec_receive_frame` with `vc == NULL` | Added a `vc == NULL` guard (an audio stream has no video decoder — the normal path, not an error) |
| `Play.Stop` never fired (`clip.mp4`) | The end test was "`frame_pts` reaches the container duration", but the last frame sits at 1.133 s in a 1.2 s file — always one frame short | End once the last frame has been on screen for one frame period (`1/fps`, capped at 200 ms) — which is what AIR does (playback ends when the picture has finished) |
| `endMs=0` in the window (`getTimer()` returned 0 at 1.2 s) | `as_start_ms` was lazily initialised on the **first call**, and this player's first clock read was the end-of-playback stamp, so the difference was always 0 | New `as_clock_init()` at the top of `main()` anchors the epoch at process start; `getTimer()` means "ms since the process started" |
| `examples/builtin-arity.as` failed to link: `undefined symbol: as_audio_live_open` / `sk_image_delete` | the gate is a **source probe** (deliberately over-inclusive): that example merely names `NetStream`/`Video` as **parameter types**, so it gets the FFmpeg archives while having neither the audio glue nor the Skia glue | `video_glue.c` now carries a compile-time fallback for each (`ASC_HAVE_AUDIO` / `ASC_USE_SKIA`). No audio = the same contract every other `flash.media` build has (the compiler already warned); **no Skia = `as_video_open` refuses** with a real reason (`NetStream.Play.Failed`) instead of decoding into a void and painting black |
| `--no-video` still printed `+ video: FFmpeg linked` | all four video switches were parsed into `opts.overrides` and then **never copied into `cfg`** (the same dropped-override shape the file already documents for `--ane-platform`) | the CLI override block now copies `video`/`video-formats`/`video-backend`; pinned by `unit: video` |
| `examples/with-fn-class-regexp.as` did not compile on windows-x64: `error: expected identifier or '('` (its 65th `with` temp, `__w64`) | `cIdent`'s underscore escape can land exactly on an **MS-compat keyword** `__w64` (clang treats it as a keyword; on macOS it is an ordinary identifier — hence a Windows-only red) | a candidate in `C_MS_COMPAT_KEYWORDS` takes a `_` **suffix** instead (`__w64_`); the rule and evidence live in `docs/en/c-naming.md` §7, pinned by `unit: emit/GeneratedNameReservation` |

Audio: decode → `swr` resample to 44.1 kHz mono/stereo → the mixer's live buffer (the same chain `Sound` uses).
For an **audio-only stream, `NetStream.time` is derived from the samples already written to the mixer** — no
video frame can fake that number, so "a 1.0 s `tone.mp3` reaches 1.000" is by itself proof that decode +
resample + mixer write all work.

### 16.5 Measured evidence (Windows x64 / software decode / 2026-11-13)

Headless probe (`temp/video-selftest.as`, pumping `Stage.dispatchFrame()` by hand):

```
after play: time=0 vw=320 vh=240 codes=NetStream.Play.Start,NetStream.Buffer.Full
t=0.4s: time=0.400            pixels lit=175 distinct=52
paused: t0=0.400 t1=0.400
after resume: time=1.200      codes=...,NetStream.Play.Stop
flv: time=1.023  video_frames=15 audio_frames=46080 w=320 h=240
ts : time=1.023  video_frames=15 audio_frames=46080
mkv: time=1.008  video_frames=15 audio_frames=44084   (VP9 + Opus, 48 kHz to 44.1 kHz)
mp3: time=1.000  video_frames=0  audio_frames=44100   Play.Stop
```

Windowed example (`examples/video/VideoPlayer.as`): **all 31 assertions pass**, covering `onMetaData`,
`pause()` freezing the clock, `Play.Stop`, `time` pinned to the duration, all four containers playing to their
end state, and the audio-only stream reaching `Play.Stop` with `Video.videoWidth == 0`.

**Regression surface (corrected in phase 399)**: the assertions the suite runs automatically live in
`examples/video-headless.as` (24 of them; it pumps `Stage.dispatchFrame()` itself, opens no window, and settles
its exit code). `examples/video/VideoPlayer.as` is a **player for humans** — it keeps its window open after the
scripted checks (the Open-file button belongs to the user), so in the suite it is compile+link only
(`SKIP_DIRS` in `test/examples.ts` contains `video`). This is not tidiness: before that, the suite was
effectively building it **without its manifest** — the window could not open, `showWindow()` returned
immediately, the run printed `8 passed, 5 failed` and still reported `PASS video/` because the exit status was
0. The video surface had no automated coverage at all.

Two diagnostics (troubleshooting only; neither changes control flow):

- `AS_VIDEO_STATS=1` → one `[video] <url> video_frames= audio_frames= w= h= pts=` line per stream on close.
  The reason is concrete: "did audio actually reach the mixer?" is **not observable from AS3** (AIR has no API
  for it), so without counters a regression that silently stops writing audio is only catchable by ear.
- `AS_VIDEO_DEBUG=1` → one `[tick] now= target= cur= qn= q0= eof=` line per frame boundary; both traps in
  §16.3 were located with it.

Reproduction:

```bash
# windowed example (run from the repository root; fixture paths are relative to the cwd)
node src/index.ts examples/video/VideoPlayer.as --manifest examples/video/video.build.json --run

# headless self-test (no window; the frame boundary is pumped by hand)
node src/index.ts temp/video-selftest.as --manifest examples/video/video.build.json -o temp/video-out/selftest.exe
AS_VIDEO_STATS=1 ./temp/video-out/selftest.exe

# headless **assertions** (this is the unit the suite runs: 24 checks, exit 1 on failure)
node src/index.ts examples/video-headless.as --manifest examples/video/video.build.json --run
```

### 16.6 Not done yet (V2 onward)

Hardware decode (`videotoolbox` / `d3d11va`) and the zero-copy texture bridge, buffering states
(`Buffer.Empty`/`Buffer.Flush`), the transport surface (`http` progressive → HLS → RTMP), and the `publish`
output side. **Today it is software decode of local files**: `NetStream.play()` accepts `http(s)://` (FFmpeg
opens it), but there is no HLS live-edge policy or catch-up logic.

### 16.7 A real 4K / 10-bit HDR10+ source: the actual costs and four fixes (measured 2026-11-13)

Source: `The.Furious.2026.2160p...HDR10+.H.265` — 3832x1592 HEVC Main10 (HDR10+), DDP 5.1 Atmos, 20.9 GB,
23.976 fps. A user reported that picking this file "stutters to the point of being unwatchable", and the
measurement landed on **four independent costs, none of which was "missing hardware decode"**:

| # | Defect | Measured cost (3832x1592 10-bit) | Fix |
|---|---|---|---|
| 1 | `AVCodecContext.thread_count` left at FFmpeg's default **1** (single-threaded decode) | 8.8 ms/frame, spent inside the frame boundary | size frame+slice threads from `av_cpu_count()`, **capped at 8** (frame threading holds one frame per thread ≈18 MB; 32 threads would pin ~580 MB) |
| 2 | The CPU fallback converted **twice**: sws→I420 to feed a GPU upload that cannot happen, then sws→BGRA | 12 ms + 6 ms/frame | `want_gpu = (grctx != NULL)` selects a **single** route; with no GPU context go straight to BGRA |
| 3 | The example used AIR's default `Stage.frameRate = 24` while the picture advances at the frame boundary | a 23.976 source gets one film frame per app frame, so any late tick shows the same frame twice → constant judder | `stage.frameRate = 60` in the example; on this source the window loop went **16.5 → 56 fps** |
| 4 | The window was CPU raster (the manifest never asked for `ASC_RENDER_WINGPU`), so 4K frames were scaled on the CPU and copied whole into the SDL texture | 3.0 ms/frame upload (24 MB BGRA copy) | manifest adds `${win:ASC_RENDER_WINGPU=1}` + `${win:ASC_RENDER_D3D=1}` + `d3d_glue.cc`: the three YUV planes go straight into D3D12 textures, upload **0.56 ms/frame** |

After the fixes (real window, `Stage.frameRate = 60`, 20 s continuous):

```text
wall=20130ms  time=20.020  appFrames=1179 (58.5 fps)  worst=46ms
video_frames=484 (24.2 fps)  audio_frames=913030   threads=8
cost/frame: dec≈0.00ms  conv=6.13ms  upload=0.56ms
```

`time` tracks the wall clock to within 0.5% (no drift) and `video_frames` matches the source rate (no dropped
or duplicated frames).

Points, most important first:

- **Software decode was never the slow part**: one thread already does 4K 10-bit HEVC in 8.8 ms/frame
  (≈114 fps of decode capability) and with 8 threads the visible time inside `receive_frame` drops to zero.
  The real bottlenecks were "converted twice", "single-threaded inside the frame loop", "24 Hz frame
  clock" and "CPU raster". So **not shipping hwaccel in V1 does not mean "4K cannot play"** — which also
  answers "is §12 still at V1?": yes, V1 is complete, hardware decode is V2/V3, and this stutter was not
  caused by its absence.
- `conv=6.13 ms` is the sws cost of 10-bit→8-bit I420 (Skia m124's YUV entry takes 8-bit 4:2:0 only;
  `SkYUVAPixmaps` has no 10-bit plane type). It only disappears with hardware decode / zero-copy (V2/V3)
  or a 10-bit texture entry. At 23.976 fps that is 15% of one core, which is acceptable today; 4K60 sources
  would push it to 37%, and the answer there is moving decode+convert to a worker thread.
- **Frame threading buffers a whole queue before it emits anything**, so the first frame must not be limited
  by one tick's packet budget or `videoWidth` stays 0 right after `play()`. `AS_VIDEO_PRIME_PACKETS = 240`
  applies only when `n_vframes == 0` **and** a video stream exists (an audio-only stream stays at
  `n_vframes == 0` forever and must not spend 240 packets per tick). Measured: the 1.2 s fixture with 8
  threads printed `after play: vw=0` under the old budget.
- Memo for windowed programs: **raise `Stage.frameRate` to 60 when playing video**, and give the window a GPU
  backend. Both only change smoothness, but a 24 Hz frame clock against 23.976 fps content is *structural*
  judder, not an occasional hitch.
- Not done: moving sws+upload to a worker thread. `sk_image_from_yuv_strided` needs the GrDirectContext and
  can only be called on the thread that owns the frame boundary; a real split would have the worker produce
  I420 into a ring buffer. The current 6.7 ms/frame headroom covers 4K@24, so this waits until 4K@60 sources
  are the normal case rather than adding a synchronisation layer for a hypothetical future.

### 16.8 V3 step one: D3D11VA is wired up, and the default stays software (measured 2026-11-14)

Two different questions: **"hardware decode works"** and **"hardware decode is faster"**. This section makes
the first one work, verifiable and reversible, then measures the second on the same 4K source — and it does
not hold on this host, so the default stays on the software path.

**Two configure names, both required.** In `n9.0.2` they register the opposite pixel formats of what the names
suggest (`libavcodec/hwconfig.h`):

```c
#define HWACCEL_D3D11VA2(codec) HW_CONFIG_HWACCEL(1, 1, 0, D3D11,       D3D11VA, ff_..._d3d11va2_hwaccel)
#define HWACCEL_D3D11VA(codec)  HW_CONFIG_HWACCEL(0, 0, 1, D3D11VA_VLD, NONE,    ff_..._d3d11va_hwaccel)
```

`h264_d3d11va2` is the implementation that handles `AV_PIX_FMT_D3D11`; `h264_d3d11va` is the legacy
`AV_PIX_FMT_D3D11VA_VLD` one. But the decoders add `AV_PIX_FMT_D3D11` to their candidate list under the
**legacy** macro (`h264_slice.c:108-111`, `hevc/hevcdec.c:613`, `av1dec.c:587`, `mpeg12dec.c:811`,
`vc1dec.c:59`). Enabling only one of them fails in two different ways, both measured:

| Enabled | Result |
|---|---|
| `d3d11va` only (the V1 list) | `avcodec_get_hw_config()` reports `dxva2_vld` + `d3d11va_vld` only; `avctx->hwaccel` stays NULL and the first `get_buffer` fails |
| `d3d11va2` only (first attempt) | hw_config has `pix_fmt=d3d11`, but `get_format` receives `yuv420p` — the format never reaches the list, decode silently stays software |
| **both** (current) | `get_format -> d3d11`, `decode=d3d11va` |

So the Windows branch of `vendor/provision/ffmpeg-static.sh` requests `d3d11va` **and** `d3d11va2` (plus
`dxva2`). Always verify a rebuild with `avcodec_get_hw_config()` plus a real `av_hwdevice_ctx_create()`
instead of trusting the flags: the rebuilt tree now reports `[0] dxva2/dxva2_vld`, `[1] (null)/d3d11va_vld`,
`[2] d3d11va/d3d11` with `methods=0x3`, and device creation returns 0. `vendor/ffmpeg/lib/windows-x64/*.lib`
was refreshed (avcodec 13.5 MB, within 28 bytes of the old one), and `windows-x86` was rebuilt the same way
(avcodec 11.0 MB); the script asserts `ARCH_X86_32`/`ARCH_X86_64` itself so the two trees cannot be silently
mixed up.

**Runtime, in `vendor/video_glue.c`.** `as_video_hw_setup()` attaches a D3D11 device only when the codec
itself advertises `AV_HWDEVICE_TYPE_D3D11VA` with `HW_DEVICE_CTX`, and gives up quietly when device creation
fails. `as_video_get_format()` prefers `AV_PIX_FMT_D3D11` and otherwise takes the first **non-hwaccel**
format — returning `list[0]` yields `dxva2_vld` against a D3D11 device and FFmpeg rejects it with
`Invalid setup for format dxva2_vld: does not match the type of the provided device context`. Each frame is
then transferred back with `av_hwframe_transfer_data()` followed by `av_frame_copy_props()`; the second call
is mandatory because the transfer allocates a buffer but does not carry props (`libavutil/hwcontext.c:448`),
and pts/colorspace/color_range live there — without it every frame reports pts 0 and `NetStream.time` freezes.
Hardware decode is opt-in: `AS_VIDEO_DECODE=hw|d3d11va|auto`; unset or `soft` keeps the CPU path.
`AS_VIDEO_STATS=1` now prints `decode=soft|d3d11va` and a `hw=…ms` column next to `dec/conv/upload`.

**Why the default stays software** — same 4K source, same binary, real window, `stage.frameRate = 60`,
20 s continuous, 32-core host:

| | `decode` | Cost per frame | App frames | Worst frame interval | `ns.time` / wall clock |
|---|---|---|---|---|---|
| software (default) | soft, `threads=8` | `dec≈0` + `conv=6.49` + `upload=0.56` ≈ **7.0 ms** | 1121 / 19.1 s ≈ **58.7 fps** | **44 ms** | 19.019 / 19.107 |
| hardware | d3d11va | `hw=11.17` + `conv=3.33` + `upload=0.40` ≈ **14.9 ms** | 1130 / 19.3 s ≈ 58.5 fps | **103 ms** | 19.102 / 19.336 |

Hardware decode plus readback is **twice as slow as the 8-thread software decoder here**, with worse pacing,
and the cost is entirely the `AV_PIX_FMT_D3D11 → system memory` step (~12 MB per 4K P010 frame, driver
synchronisation included). Software decode is not spending that 7 ms on decoding at all — the threads hide it.

The only way hardware wins is **not reading back**, which is exactly the hard part of the Windows row in
§10.2: a `DXGI_FORMAT_NV12` texture keeps Y and UV as two *plane slices* of one resource while
`GrBackendTexture` takes a whole 2D texture. **That chain is now built** in the shape §16.9.2 describes
(zero copy measures 0.24 ms/frame with a 20 ms worst frame interval), so "software is the default" is no
longer a conclusion — only a deliberate step that has not been flipped yet (§16.9.6).
`examples/video-headless.as` passes its 24 assertions on both paths.

**Build trap worth knowing:** MSYS2's `make` eats one level of backslash from single-quoted recipe text, so
FFmpeg's dependency `awk '/including/ { … gsub(/\\/, "/") … }'` reaches awk as an invalid `/\/` and every
`.o` fails with `syntax error`. The workaround is to write that rule as `gsub(/\\\\/, "/")` (four
backslashes) in `config.mak` after `configure` — it is generated, so it has to be re-applied on every rebuild.
Three tools also have to come from three places: `awk`/`sh` from Git for Windows, `make`/`nasm` from
`/c/msys64/usr/bin`, `lib.exe` from the imported vcvars environment.

### 16.9 V3 step two: zero copy lands, and hardware decode finally beats software (measured 2026-11-14)

§16.8's conclusion was that hardware plus readback costs twice what software costs, and the entire cost is the
`AV_PIX_FMT_D3D11 → system memory` hop. This step removes the hop: the decoded slice is split, inside the GPU,
into one whole Y texture and one whole UV texture, and handed straight to Skia's YUV shader.

#### 16.9.1 Same 4K HDR10+ source, same binary, real window at 60 Hz, 20 s continuous

Source: `The.Furious.2026 … HDR10+ H.265` (3832×1592, P010, 23.976 fps).

| Route | CPU cost per frame | App frames | Worst frame interval | Frames shown |
|---|---|---|---|---|
| software (8 threads, default) | `conv=5.91` + `upload=0.67` ≈ **6.6 ms** | 1181 / 20.1 s ≈ 58.8 fps | **44 ms** | 484 |
| hardware + readback | `hw=9.59` + `conv=3.37` + `upload=0.42` ≈ **13.4 ms** | 1189 ≈ 59.4 fps | **98 ms** | 487 |
| **hardware + zero copy** | `copy=0.24` + `conv=0.02` ≈ **0.27 ms** | 1198 ≈ 59.9 fps | **20 ms** | 484 |

`copy` is CPU-side submission only (D3D11 blit, fence, command recording); the real GPU work (two plane
copies over ~9 MB) is asynchronous and does not appear in that number. A 20 ms worst interval at 60 Hz means
every frame finished before the next one was due.

#### 16.9.2 The chain: four stages, each with a reason

Implemented in `vendor/video_d3d.cc` (Windows/D3D12 only). `vendor/video_glue.c` sees only
`sk_video_d3d_image()` / `sk_video_d3d_stats()` / `sk_video_d3d_forget()` — integer and pointer handles, so the
FFmpeg seam still knows nothing about Skia.

**Build injection (stage 462):** `video_glue.c`'s references to `sk_video_d3d_*` compile only under
`ASC_RENDER_D3D`; the WGL (`gl`) backend guards them out and never needs the file. So on Windows the video
probe **auto-adds `video_d3d.cc` to sources when it sees `ASC_RENDER_D3D`** (symmetric with the macOS
`video_metal.mm` injection), and a D3D12 + video app manifest no longer has to name it by hand. Previously
only the macOS injection existed, so a Windows D3D12 + video build failed to link on exactly those four
symbols (measured: the real meeting app switching `gl` -> `d3d12`).

1. **Decoded slice → our own shared staging texture (D3D11 `CopySubresourceRegion`).** Handing the decoder's
texture to D3D12 directly is not an option: `hwcontext_d3d11va.c` allocates a `D3D11_BIND_DECODER` array with
no sharing flags, and DXVA does not promise a shareable decode surface. Copying to a same-format (NV12/P010)
shared texture is a VRAM blit — about 9 MB at 4K.
2. **Ordering by a shared fence** (`ID3D11Device5::CreateFence(D3D11_FENCE_FLAG_SHARED)` → `ID3D12Fence::Wait`).
`Flush()` plus polling would either stall the CPU or let D3D12 sample an unfinished picture.
3. **Split the two planes into whole textures on the D3D12 side** (`CopyTextureRegion`, source subresource 0 for
the plane index and `SubresourceIndex 1` for chroma; R8 / R8G8, or R16 / R16G16 for 10-bit). This is the direct
consequence of `GrBackendTexture` wrapping a whole 2D texture, and the whole reason `video_d3d.cc` exists.
P010 stores its 10 bits left-justified in 16, so `R16_UNORM` normalises to exactly value/1023 — no shift and no
swscale.
4. **Hand it to Skia**: `SkImages::TextureFromYUVATextures(ctx, GrYUVABackendTextures(SkYUVAInfo(kY_UV, k420, cs)), …)`,
with the textures reported in `D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE` — the same contract as
`sk_gpu_draw_texture`: Skia tracks texture state itself, so both sides must agree on it.

#### 16.9.3 Colour: two independent pieces of evidence, not "it looks right"

| Source | software (reference) | hardware + readback | **hardware + zero copy** |
|---|---|---|---|
| `clip.mp4` (8-bit) meanR/G/B | 120.9 / 126.14 / 130.13 (distinct 764) | **identical** | **identical** |
| `clip10.mp4` (P010, BT.2020 PQ) meanR/G/B | 20.79 / 22.82 / 25.81 | 20.79 / 22.82 / 25.81 | 20.06 / 23.19 / 24.54 |
| the same content transcoded to 8-bit (`clip8.mp4`, software) | 20.18 / 22.97 / 24.63 | — | — |

On 8-bit the three routes agree sample for sample (same mean *and* same distinct-colour count). On 10-bit,
zero copy is 0.12 / 0.22 / 0.09 away from the 8-bit transcode of the same content while the readback route is
0.61 / 0.15 / 1.18 away — **zero copy is closer to the truth**, because the reference path first swscales P010
down to 8-bit I420 and then still interprets it with the 10-bit matrix (`kBT2020_10bit_Limited`); matrix and
bit depth already disagreed there. (`temp/probe-color.as` is the tool: play to the end so the last frame
holds, then `BitmapData.draw` + `getPixel32` sampling.)

#### 16.9.4 Four traps, all found by measurement

1. **`D3D11_RESOURCE_MISC_SHARED_NTHANDLE` must be paired with `D3D11_RESOURCE_MISC_SHARED`.** Alone it makes
`CreateTexture2D` return `E_INVALIDARG` for both NV12 (0x67) and P010 (0x68). The first failure looks like
"video formats cannot be shared" — they can; the flag combination was wrong.
2. **The texture ring must match the decode queue, not "two frames in flight".** `AS_VIDEO_QUEUE = 8` keeps
decoded frames that are ahead of the clock, each holding an SkImage. A two-slot ring starved 14 of 31 frames
and fell back to readback, which made the whole exercise pointless. It is 10 slots now, created on demand
(0.1 MB per slot at 320×240).
3. **`TextureReleaseProc` needs an epoch.** Skia may call it after the stream closed (the display list still
holds the image); by then the table entry can belong to another device, and clearing `in_use` would let a
texture be rewritten under Skia. The callback carries the `Stream::epoch` it was issued under and does nothing
when they disagree.
4. **Forget the table entry before the D3D11 device is released.** The table is keyed by device pointer; once
FFmpeg frees the device the address can be reused, and a stale entry means a dead immediate context.
`as_video_free_state` drops images first, then calls `sk_video_d3d_forget(v->hw_dev11)`, then
`av_buffer_unref(&v->hw_device)`.

#### 16.9.5 Switches and defaults

- Zero copy is compiled in only for builds with a GPU window and `ASC_USE_SKIA`: on Windows that is D3D
(`video_d3d.cc`, a `${win:…}` source in `examples/video/video.build.json`), on macOS it needs
`ASC_RENDER_METAL=1` and `video_metal.mm` injected (the `${mac:…}` entries of the same manifest, §16.13). Every
other build gets a static stub returning NULL, so nothing changes for it.
- `AS_VIDEO_ZC=0|off` turns it off at runtime (for A/B); it is on by default.
- **The default decoder is adaptive** (`AS_VIDEO_DECODE` unset = `auto`): hardware when zero copy works,
software when it does not — see §16.9.6 for the test and the moment it runs. `soft`/`cpu` force the CPU;
`hw`/`d3d11va`/`videotoolbox` force the GPU (and do not require zero copy).
- `AS_VIDEO_STATS=1` reports three decode states — `soft`, `<backend>-readback`, `<backend>-zero-copy`
(`<backend>` is `d3d11va` on Windows and `videotoolbox` on macOS) — plus
`zc=<frames>` and `starved=<count>`.

#### 16.9.6 The adaptive default: start in software, decide at the first frame boundary

The difficulty is that the two answers arrive at different times: whether to use the GPU is known at `open`,
while whether ZERO COPY works depends on a `GrRecordingContext`, which does not exist yet at `open`. Hence:

1. **`open` always starts in software** and **primes one frame**. The prime is not optional: right after
`play()`, `BitmapData.draw` must not be black (a pinned regression), and there is no renderer yet to decide
with.
2. **At the first frame boundary** (`as_video_tick` receives a non-NULL `grctx`) the question is answered:
create the D3D11 device → create the shared staging texture plus one plane pair (`sk_video_d3d_probe`) →
only if all of that succeeds is the decoder **re-opened** as D3D11VA. One `av_seek_frame` returns to the
head of the file through the normal seek path (drop image, clear queue, `as_audio_live_rewind`), so the
only repeated work is that single primed frame — **the stream is never restarted**, and the
`NetStatus`/`onMetaData` sequence is untouched.
3. Probe fails, device cannot be created, or the decoder refuses the stream (a profile the driver will not
take) ⇒ stay in software with `hw_refused=1` (`AS_VIDEO_DEBUG` prints which one). Asked once per stream;
a program with no renderer (the headless example) never asks.

Two counter-examples shaped this:

- **Committing to the GPU at `open` is wrong**: on a machine without a renderer it lands on "hardware works,
zero copy does not", i.e. readback — measured 13.4 ms/frame against software's 6.6 ms, an optimisation that
makes things twice as slow.
- **One device per stream, not two**: the device created by the probe must be the one the decoder uses. An
earlier version released it, re-opened, and created a second one — which cost **two zero-copy table entries
per stream**, so the 4-entry table filled up on the third `NetStream` (measured: `[zc] no free stream
entry`, and that stream silently fell back to readback).

Three routes with one binary ("default" = no `AS_VIDEO_*` set):

| | CPU cost per frame | App frames | Worst frame interval | Frames shown |
|---|---|---|---|---|
| 4K HDR10+ default (= zero copy) | `copy=0.26` + `conv=0.02` ≈ **0.28 ms** | 1180 / 20.1 s ≈ 58.7 fps | 32 ms | 475 |
| 4K HDR10+ `AS_VIDEO_DECODE=soft` | ≈ 6.6 ms | ≈ 58.8 fps | 44 ms | 484 |
| `examples/video-headless.as` default (no window ⇒ software) | — | — | — | 24 assertions green |

With no window there is no D3D11 device at all: `grctx == NULL` leaves the decision undecided (not
"software"), so a headless program pays nothing and a windowed app that paints later still gets the GPU.

**macOS runs the same state machine**: only "create a D3D11 device + shared staging + probe" becomes
"take the `MTLDevice` + create a `CVMetalTextureCache` + try to wrap one frame"; the test, the moment and the
fallback after a failure are unchanged (measured in §16.13.4).

### 16.10 HDR10+ / HLG on an SDR screen: supported, and off by default (measured 2026-11-14)

Same 4K HDR10+ sample (`color_trc=smpte2084`, `colorspace=bt2020nc`, P010). The problem
is concrete: **AIR has no HDR presentation surface**. `Video` receives YUV, and Skia's
YUV shader only applies the matrix and range -- **it carries no transfer function** -- so
the PQ code values are painted as if they were sRGB: shadows flatten, highlights pile up
against 255, and the picture looks both grey and muddy. This is not something we added;
it is what "match AIR" necessarily produces.

So this layer follows AGENTS.md §1.5 and is an **enhancement**: `AS_VIDEO_HDR=1` turns it
on, and the default is **off** (the default still paints exactly what AIR paints, not one
pixel moved). While it is off, `vendor/video_hdr.c` never enters the hot path and SDR
streams behave exactly as described in §16.7/§16.9.

**Pipeline** (`vendor/video_hdr.c` + `vendor/video_hdr.h`, plain C, `libm` only, called
from `video_glue.c`):

```text
P010/NV12 --sws--> RGB48LE (16-bit per channel) --per-channel linearise--> linear
          --[BT.2020 -> BT.709, linear light]--> display-referred
          --[shoulder + gamma 0.8]--> 8-bit BGRA --sk_image_from_argb--> Skia
```

Four decisions, each with a measured counter-example:

1. **The verdict reads the transfer function, never the bit depth** (`AVFrame.color_trc`
   / `codecpar.color_trc`). 10-bit SDR is common (ProRes 422 HQ among others), and
   deciding by bit depth would darken it for nothing.
2. **The intermediate format is 16-bit RGB (`AV_PIX_FMT_RGB48LE`), not 8-bit**: PQ code
   values crowd into 0.3-0.5 in the shadows, and quantising to 8 bits before linearising
   produces banding. The cost is 6 bytes per pixel through sws and memory (see below).
3. **Reference white is 100 nits (video diffuse white), not BT.2408's 203 nits (graphics
   white)**. 203 is the right number when HDR and SDR graphics share one screen; applied
   to a whole film it is visibly dark -- on the same frame (t≈10 s) the 203 white point
   gave means of `8.83/3.49/2.20` against the pass-through path's `16.83/12.15/8.31`,
   i.e. the shadow detail was gone. At 100 nits, plus a **mid-tone lift (gamma 0.8, folded
   into the output table, zero per-pixel cost)**, the numbers become the table below.
4. **It is mutually exclusive with zero copy, and takes precedence over it**: Skia's YUVA
   textures have nowhere to decode a transfer function, so while HDR is on the path does
   **not** try `sk_video_d3d_image()` and does not upgrade to hardware decode (that would
   stack a mapping on top of a readback). The verdict is made in `open()` from the
   container parameters so no frame ever takes the wrong route; the tables and the two
   buffers are also built there (doing it on the first frame showed up as a ~100 ms frame
   interval).

Same binary, same sample (20 s, 3832x1592, 23.976 fps):

| Route | Per-frame CPU cost | App frames | Worst frame interval |
|---|---|---|---|
| pass-through (default, AIR-shaped: PQ as sRGB) | `conv=5.91` + `upload=0.67` ≈ **6.6 ms** | 1195 / 20.2 s ≈ 59 fps | 44 ms |
| `AS_VIDEO_HDR=1` (software decode + mapping) | `sws=12.23` + `map=4.16` + `upload=3.07` ≈ **19.5 ms** | 1156 / 20.2 s ≈ 57 fps | 94 ms |
| zero copy (§16.9, only reachable with HDR off) | `copy≈0.26` ≈ **0.3 ms** | 1180 / 20.1 s ≈ 59 fps | 20 ms |

The mapping started at **19.5 ms single-threaded** (4K, 6.1 M pixels, three table lookups
plus a 3x3 matrix per pixel) -- half of a 41 ms frame budget. `video_hdr.c` now splits it
by row across up to 8 threads (blocks share nothing; below 64 rows per thread it stays
serial), measured down to **4.2 ms**. The sws half (12.2 ms) was left alone: it is
FFmpeg's own SIMD conversion, 1:1, doing only YUV -> RGB48.

**Picture statistics before and after** (`temp/probe-hdr.as`, 6000 samples at the same
point in the file, BT.709 luma):

| | meanR/G/B | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| pass-through (default) | 16.83 / 12.15 / 8.31 | 7 | 34 | 65 | 108 |
| `AS_VIDEO_HDR=1` | 22.39 / 11.00 / 7.34 | 2 | 39 | 93 | 175 |

The direction is "highlights opened up, shadows pushed down", which is the contrast an
HDR master is supposed to have on an SDR display: max goes from 108 to 175 and p99 from
65 to 93 while the overall mean stays in the same range. **The costs, stated plainly**:
this version is a per-channel curve with no content adaptation, so very saturated
highlights shift hue slightly (it is not a whole-gamut clip), and HLG uses a simplified
OOTF (the cross-channel luminance term is ignored). HDR10+ **dynamic** metadata, Dolby
Vision and local (spatially varying) tone mapping were not implemented at this point.
**All three gaps were closed in §16.11** (phase 404); 16.10 stays as the record of what
was measured then.

The curve itself has an executable assertion: `test/unit/video.ts` **compiles the real
`vendor/video_hdr.c` with the machine's C compiler** and runs a driver, pinning "PQ black
maps to 0", "monotonic", "100 nits lands in 200-245", "1000 nits is no brighter than 255
and no darker than 100 nits", "18 nits lands in 100-165 (shadows are not crushed)",
"gain applies and an invalid gain is rejected" -- a source-level grep cannot pin a curve.

Reproduce:

```bash
AS_VIDEO_HDR=1 AS_VIDEO_STATS=1 ./temp/probe-4k.exe      # per-frame cost + hdr=pq
AS_VIDEO_HDR_GAIN=1.3 ./temp/probe-4k.exe                # brighter, if a title needs it
node --test --test-name-pattern='video' test/unit/*.ts   # the curve assertions
```


### 16.11 Closing §16.10's three gaps: dynamic metadata, Dolby Vision, local mapping, full HLG OOTF (measured 2026-11-14)

§16.10 shipped "one fixed-shoulder per-channel curve". This section turns it into a real
HDR-to-SDR mapping: **HDR10+ dynamic metadata drives the shoulder**, **Dolby Vision
metadata is consumed (profile 5 explicitly refused)**, **the full BT.2100 OOTF with its
cross-channel luminance term**, and **local (spatially varying) tone mapping**. It still
only enters the hot path with `AS_VIDEO_HDR=1`, and it is still mutually exclusive with
zero copy (§16.10 item 4).

**Why dynamic metadata is needed at all**: HDR10 carries a single static MaxCLL (this
sample is a 1000-nit master with a 458-nit CLL), but real shots peak anywhere from 100 to
800 nits. A fixed shoulder has only two outcomes -- set it for the brightest shot and the
dark shots flatten; set it for the average and the bright ones clip. HDR10+ reports each
scene's real peak, so the shoulder can follow the scene.

#### 16.11.1 Reading metadata: priority order and two traps

`as_video_meta_read()` (`video_glue.c`) tries **Dolby Vision -> HDR10+ -> static MaxCLL ->
mastering `max_luminance`** and stops at the first hit, handing the result over as
`as_hdr_meta` (**plain numbers; no FFmpeg struct leaks into `video_hdr.c`**).

Trap one: **HDR10+'s `maxscl` must be multiplied by 10000 to get nits**, it is not a
ratio against `targeted_system_display_maximum_luminance`. On this sample `maxscl≈0.030`
with `tsdl=500`; scaling by `tsdl` gives 15 nits (absurd), by 10000 gives 366 nits (which
matches the shot's visible highlights). `average_maxrgb` works the same way and gives
3.7 nits.

Trap two: **Dolby Vision profile 5 is not PQ and cannot be decoded as PQ**. Its base layer
is IPTPQc2 (IPT primaries plus PQ), so running it through the BT.2020/PQ matrix shifts
colours systematically. `as_video_hdr_make()` therefore **refuses to build a mapper** for
profile 5 and falls back to pass-through (explaining itself under `AS_VIDEO_DEBUG`); the
profile 8.x BL-compatibility field (`dv_bl_compat`) is diagnostic only. Better an explicit
non-result than a wrong picture.

Dolby Vision level-1 metadata is **PQ code values**, so it is converted back to nits
before reaching the shoulder (`as_video_pq12_nits()`).

#### 16.11.2 The shoulder follows the scene: highlights move, mid-tones never do

The shoulder is parametrised by `tau` (soft-knee width, in 100-nit reference-white
units), solved so the **scene peak lands at output 0.97**: a low peak gives a small `tau`
(highlights keep their level), a high peak gives a large one (soft compression).

The output table has 16385 entries and takes **0.79 ms** to rebuild (measured), which is
far too much per frame -- and HDR10+ peaks move on almost every frame (a 1-nit peak change
already moves `tau` by 0.007). So `tau` is quantised to **0.05** before rebuilding: at a
367-nit peak the shoulder moves by less than one output code (invisible), while a
per-frame rebuild becomes one per real scene change. Measured `meta` cost is
`0.001-0.002 ms/frame` (one rebuild in 20 s).

| Scene peak | `tau` | 367 nits lands at |
|---|---|---|
| 143 nits | `0.350` | -- |
| 367 nits (the measured shot) | `1.377` | 249 (fixed shoulder: 238) |
| 4000 nits | `8.000` (clamp) | -- |
| 10000 nits (bad metadata) | `8.000` (clamp) | -- |

**Mid-tones must not move at all**: 18 nits maps to 138 with and without metadata. Moving
them makes brightness jump between adjacent shots (it reads as auto-exposure pumping),
which is the classic failure of an adaptive shoulder -- so it has its own assertion.

#### 16.11.3 Local tone mapping: lift-only by default, because two-sided measured wrong

The implementation is a 16x16-block **log-luminance gain map**: per-block mean log2
luminance -> frame-mean anchor (low-passed in time to stop flicker) -> 3x3 blur ->
bilinear lookup. The per-pixel gain is `(anchor/Y_block)^k` where `k` is
`AS_VIDEO_HDR_LOCAL` (0.25 by default). Because the gain depends on the **neighbourhood**
only, contrast inside a block survives untouched.

The default is **lift-only** (`AS_VIDEO_HDR_LOCAL_MODE=both` enables two-sided). Reason,
measured on the 4K sample: most shots are "large dark area plus one small bright area",
and the two-sided operator **dimmed the brightest thing in frame** -- on the same segment
max fell from 138 to 111 and p99 from 74 to 62, i.e. it removed exactly what HDR has and
SDR does not. Lift-only leaves the top alone and raises the shadows. Same-frame
comparison on the synthetic image in the `test/unit/video.ts` driver (256x128, left 32
columns 8 nits, rest 300 nits):

| | dark block | bright block | flat field |
|---|---|---|---|
| global (local off) | 102 | 236 | 236 |
| lift-only (default) | **127** | 236 | 236 (gain 1.000) |
| two-sided `both` | 127 | 234 | -- |

A flat field must match the global path **exactly** (gain 1.0): with no neighbourhood
difference, any shift is exposure drift.

Cost (4K 3832x1592, software decode, same binary):

| Route | Per-frame CPU | App frames |
|---|---|---|
| `AS_VIDEO_HDR=1` (global) | `sws=12.29` + `map=4.27` + `upload=2.98` ≈ **19.5 ms** | 488 / 20.19 s ≈ 24 fps |
| `+ AS_VIDEO_HDR_LOCAL=1` | `sws=12.25` + `map=12.80` + `upload=2.98` ≈ **28.0 ms** | 494 / 20.44 s ≈ 24 fps |

The extra ~8.5 ms is "read the whole frame a second time and interpolate the gain map". It
still fits inside the 41 ms budget of 23.976 fps, but it is a **second full-frame pass**,
so it is off by default -- a default should not quietly spend 30% of the frame budget.

#### 16.11.4 HLG: adding the cross-channel luminance term (BT.2100 OOTF)

§16.10's HLG was plain per-channel `alpha*E^1.2`, which **drops the OOTF's luminance term**.
BT.2100's scene-to-display transform is:

```text
Y_S = 0.2627 R + 0.6780 G + 0.0593 B      (BT.2020 luma weights, scene light)
F_D = alpha * Y_S^(gamma-1) * E_S         gamma = 1.2 + 0.42*log10(Lw/1000)
alpha = Lw / 100                            (100-nit reference white, as in §16.10 item 3)
```

The point is that `Y_S` is a **mix of all three channels**: a pure-red pixel has only 26%
of red's value as luma, so its gain is far below what the per-channel form gives.
`AS_VIDEO_HLG_PEAK` (1000 nits by default) sets `Lw`. Measured (10-bit code 32768, with
the per-channel answer as a control):

| | output R | note |
|---|---|---|
| neutral grey (R=G=B) | 200 | identical to `as_hdr_map8()` (a grey's luma is itself) |
| pure red, full OOTF + matrix | **218** | this implementation |
| pure red, per-channel gamma (old) | 225 | no `Y_S` term; the more saturated, the further off |
| pure red, OOTF without BT.2020->709 | 190 | one gamut step missing |

So the curve cannot be pinned by "monotonic" alone: the neutral axis must match the
per-channel table **value for value** (otherwise the OOTF is wrong) while a saturated
primary must land on 218, not 225 (otherwise the luminance term is missing). Both are
assertions in the unit test.

**When comparing against ffmpeg, remember it uses the per-channel approximation**: on the
same HLG transcode (`zscale=t=arib-std-b67` of the same frames) our G/B are within 6% of
ffmpeg's `zscale+tonemap=mobius`, and R is ~30% higher (14.07 vs 10.51) -- exactly the
difference that term makes. **We are not the outlier here; zscale is missing the term.**
On top of that, absolute HLG levels depend on the encoder's `Lw`, which is unknowable
from the transcode chain, so HLG is pinned by structural facts (neutral axis, saturated
primary) rather than absolute levels.

#### 16.11.5 Cross-check: what this curve actually computes

One frame of the 4K sample at 2.6 s, against three standard ffmpeg operators (same
frame, BT.709 output):

| Operator | meanR / G / B |
|---|---|
| pass-through (AIR-shaped: PQ as sRGB) | 19.87 / 23.77 / 29.55 |
| `hable` | 9.31 / 23.81 / 34.06 |
| `mobius` | 12.14 / 31.45 / 45.12 |
| `reinhard` | 12.84 / 32.53 / 46.69 |
| **this implementation** (`AS_VIDEO_HDR=1`) | **11.11 / 35.22 / 49.75** |

It lands between `mobius` and `reinhard`, ~10% brighter than `mobius`, so the curve belongs
to the same family rather than inventing its own normalisation. The pass-through row
differs from all three (R 1.6-2.1x higher, B 13-35% lower) -- the direct fingerprint of
painting PQ as sRGB: shadows flattened, variance reduced, white point pulled blue.

#### 16.11.6 Switches and assertions

| Variable | Default | Effect |
|---|---|---|
| `AS_VIDEO_HDR` | off | master switch (§16.10) |
| `AS_VIDEO_HDR_GAIN` | 1.0 | exposure gain |
| `AS_VIDEO_HDR_META` | on (while HDR is active) | turn off to return to the fixed shoulder |
| `AS_VIDEO_HLG_PEAK` | 1000 | HLG `Lw` in nits |
| `AS_VIDEO_HDR_LOCAL` | off | local strength (0-1); 0.25 when enabled |
| `AS_VIDEO_HDR_LOCAL_MODE` | `lift` | `both` for two-sided |
| `AS_VIDEO_STATS` | -- | prints `dtm=` (hdr10+/dovi/static/none), `local=`, scene peak/avg/`tau`, `meta` cost |
| `AS_VIDEO_DEBUG` | -- | prints the route and metadata detail once (`dv=8.4`, `tsdl=500`) |

The unit test (`test/unit/video.ts`, compiling the real `vendor/video_hdr.c`, 90 checks)
pins: default shoulder 4.0, 367 nits -> 1.0-2.0, 143 -> 0.2-0.6, 4000/10000 -> 8.0 clamp,
metadata is recorded, the dynamic shoulder lifts 367 nits and **leaves 18 nits exactly
where it was**; HLG matches the per-channel table value for value on the neutral axis, the
saturated primary lands in 210-222, a primary carries no chroma, `Lw` applies and an
absurd value is rejected; local mapping lifts the dark block by >=15 codes, lift-only
leaves the bright block alone, two-sided does compress it, a flat field has gain 1.000,
and strength 0 turns the pass off.

#### 16.11.7 Still not done

- **Native HDR presentation**: this section's swap chain is still 8-bit SDR. Real HDR
  presentation is §16.12 (scRGB F16), and it is **not** a continuation of this SDR
  mapping path -- that path's entire curve is absent on the present side.
- **DV profile 5 / profile 7 MEL-FEL reconstruction**: profile 5 is refused outright, and
  profile 7's enhancement layer is not merged.
- **The full ST 2094-40 adaptive curve of HDR10+** (Bezier plus per-frame tone-mapping
  parameters): only the derived "scene peak / scene average" pair is used, to drive the
  local shoulder; the reference per-frame mapping is not replicated.
- **Local metadata (ST 2094-10), dynamic MaxCLL, percentile statistics.**

Reproduce:

```bash
AS_VIDEO_HDR=1 AS_VIDEO_STATS=1 AS_VIDEO_DEBUG=1 ./temp/probe-4k.exe   # dtm=hdr10+ ... tau=1.28
AS_VIDEO_HDR=1 AS_VIDEO_HDR_LOCAL=1 AS_VIDEO_STATS=1 ./temp/probe-4k.exe
AS_VIDEO_HDR=1 AS_VIDEO_HDR_LOCAL_MODE=both ./temp/probe-4k.exe
node --test --test-name-pattern='video' test/unit/*.ts
```

### 16.12 Native HDR presentation: scRGB F16 swap chain + a linear-light pipeline (measured 2026-11-14)

§16.10/§16.11 are "HDR material as correct as possible on an SDR screen". This section is
**real HDR display**: the window presents through a `DXGI_FORMAT_R16G16B16A16_FLOAT` swap
chain with `DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709` (scRGB), the picture is written as
**linear light**, our SDR white point is lifted to a chosen number of nits, and HDR video
frames **skip the shoulder/OETF entirely** -- the display does its own mapping. It is
**off by default**; `ASC_HDR=1` turns it on.

#### 16.12.1 Why scRGB F16 and not HDR10/PQ

Measured on this machine (RTX 4090 D, `\.\DISPLAY1`, `maxLum=496.8` nits, 8 bpc), per
swap-chain format:

| Format | SDR G22/P709 | scRGB G10/P709 | HDR10 G2084/P2020 | G22/P2020 |
|---|---|---|---|---|
| `R8G8B8A8_UNORM` (28) | yes | `SetColorSpace1` fails | yes | yes |
| `R10G10B10A2_UNORM` (24) | yes | fails | yes | yes |
| `R16G16B16A16_FLOAT` (10) | fails | yes | fails | fails |

So **F16 accepts only scRGB and 10-bit only accepts PQ** -- the two are mutually exclusive;
"10-bit + scRGB" does not exist. scRGB was chosen not because it is brighter but because
**it speaks the same language as Skia's colour management**: scRGB is linear light where
`1.0 == 80 nits`, a decoded HDR frame is already linear, and a Skia F16 surface is linear,
so no conversion is needed anywhere. A PQ destination would instead mean "1.0 == 10000
nits", SDR white would sit near 0.58 in the buffer, the whole 2D display list would have to
move with it, and any single untagged draw would wash out or blow out the frame.

#### 16.12.2 The present structure: draw into an offscreen F16, then multiply once

Per-frame path for an HDR window (`vendor/d3d_glue.cc`):

1. `sk_gpu_begin_frame()` returns the canvas of the **offscreen F16 surface**
   (`SkColorSpace::MakeSRGBLinear()`), not the back buffer's. The generated C still clears
   and draws the whole display list (`ASC_window_render`).
2. `sk_gpu_flush()` blits that surface into the back buffer with `kSrc`, then multiplies it
   by a constant colour with `kModulate`: `gain = hdr_white / 80`. With the default
   `ASC_HDR_WHITE=203`, SDR white is **2.5375** in the buffer.
3. `Present(1, 0)`.

**A trap worth remembering:** the first version used an `SkColorFilters::Matrix` gain, and
it **clamps its output to `[0,1]`**. 203-nit white therefore landed at **1.0 (= 80 nits)**
and every highlight above SDR white was cut -- exactly the silent "looks HDR, is SDR"
degradation. Measured side by side (`temp/hdrgain.cc`, F16 linear destination):

| Primitive | white | grey (sRGB 0.5) |
|---|---|---|
| no gain (control) | 1.0000 | 0.2157 |
| `SkColorFilters::Matrix` | **1.0000** (clamped) | 0.5474 |
| `kModulate` + **linearly tagged** colour | **2.5371** | 0.5474 |
| `SkRuntimeEffect` shader | 2.5371 | 0.5474 |

`kModulate` was chosen (one full-screen fill, no shader). Second trap: the constant colour
**must** be tagged `SkColorSpace::MakeSRGBLinear()`, because an untagged `SkColor4f{2.5375,…}`
is read as sRGB-encoded and 2.5375 arrives as **8.65**.

#### 16.12.3 The video side: linear F16, no highlight compression

HDR video in an HDR window does **not** go through `as_hdr_tonemap_rgb48()` (the SDR map).
It goes through `as_hdr_tonemap_rgb48_f16()` (`vendor/video_hdr.c`), which only does
"decode the transfer function + BT.2020 -> BT.709 + divide by the white point": **no
shoulder, no local map, no sRGB OETF, no clamp**. What it stores is `nits / white`, so
`1.0 == the configured SDR white` and highlights above it survive (the display maps them).

That is a deliberate "do not compress twice": the SDR curve exists because the target has
~250 codes, while an HDR present targets the **display's own peak**. Hence the "HDR and
zero-copy are mutually exclusive" rule extends to the present side: Skia's YUVA path has
nowhere to put a transfer function, so in an HDR window the zero-copy probe answers 0 and
the decode stays on the CPU (`as_video_maybe_upgrade` is gated the same way).

**Which output form** is asked of the window **every frame** (`sk_gpu_hdr_active()`), not of
an env var: a window can fall back to SDR by itself (unsupported format, device-lost
rebuild), and the video must then fall back to the 8-bit mapped picture -- otherwise linear
values would be shown as if they were sRGB and the frame would be dark.

#### 16.12.4 Measurements (this machine; read from the `ASC_GPU_DUMP` presented back buffer)

**2D probe** (320x240 window, three horizontal bands `#FFFFFF` / `#808080` / `#000000`):

```text
d3d_glue: window 0 bound to 320x240 R16G16B16A16_FLOAT scRGB swapchain (SDR white lifted at present)
d3d_glue: HDR linear mean=1.5853 (126.8 nits) max=2.5371 (203.0 nits) white=203
```

`max = 2.5371` is exactly `203 / 80`: SDR white lands on the designed value, and the grey
band reads `0.5474 = 0.2157 x 2.5375`. The same program without `ASC_HDR` still produces
`255 / 128 / 0` -- **code-identical**.

**Video probe**: a purpose-built 10-bit PQ test clip (640x360, 25 frames, three bands =
100 / 203 / 1000 nits, HEVC `lossless=1`, `temp/pqbands.mkv`) played into an HDR window:

```text
HDR band0 mean=1.2246 ( 98.0 nits)   <- source 100 nits
HDR band1 mean=2.4922 (199.4 nits)   <- source 203 nits
HDR band2 mean=12.2188 (977.5 nits)  <- source 1000 nits
```

The band ratios 2.035 / 4.902 match the source's 2.03 / 4.926 to within 0.5%, and the
**1000-nit band is far above 1.0** (12.2 stored into F16) -- exactly what the SDR mapping
path cannot produce.

The absolute values being ~2% low is **not our kernel**: `temp/pqprobe.c` feeds the same
PQ codes straight into `as_hdr_tonemap_rgb48_f16()` and gets
`0.49268 / 1.00000 / 4.92578` (= 100/203/1000 divided by 203, error < 0.02%). The gap comes
from **swscale's 10-bit limited->full stretch**: for the same frame sws gives
`33163 / 37932 / 49111` (codes 0.506035 / 0.578805 / 0.749386), zscale gives
`33280 / 38016 / 49280` (0.507820 / 0.580087 / 0.751965), and the source codes are
`0.508078 / 0.580689 / 0.751827`. **sws is 0.4% short in code value, zscale 0.03%** -- PQ's
slope amplifies that to ~2% in nits. 0.4% of a code is invisible on screen, but it means
absolute nits readouts from the video chain are not a reference: compare **ratios** of test
bands, or treat zscale as the reference.

The other property that had to be verified is **white-point invariance**: changing
`ASC_HDR_WHITE` from 100 to 400 must leave the video bands' absolute nits readout
**unchanged** (the stored `nits/white` and the present gain `white/80` cancel):

| `ASC_HDR_WHITE` | band0 | band1 | band2 |
|---|---|---|---|
| 100 | 97.9 | 199.2 | 977.5 |
| 203 | 98.0 | 199.4 | 977.5 |
| 400 | 97.9 | 199.2 | 977.5 |

(The differences are half-float quantisation. Only the brightness of SDR 2D content changes,
which is what the parameter is for.)

#### 16.12.5 Boundaries and open items

- **Visible HDR needs Windows in HDR mode.** This machine's `DXGI_OUTPUT_DESC1` currently
  reports `colorSpace=SDR G22/P709`, `bpc=8`: the F16 scRGB swap chain can be created, but
  the display still interprets it as SDR. The pixel-level verification above does not depend
  on that; the *perceived* "highlights are really brighter" does, and that is the user's
  Windows HDR switch -- **never changed automatically**.
- **HDR is a process-wide mode**: `sk_gpu_hdr_active()` means "some window in this process is
  HDR". In a multi-window app where one window gets scRGB and another falls back to SDR, a
  video frame can only have one encoding, so it would be "linear shown as sRGB" (dark) in
  the SDR window. Single-window apps are unaffected; producing two encodings per frame for
  mixed-monitor setups is **not** implemented and is on the open list.
- **The SDR fallback branch is unreachable here**: `CheckColorSpaceSupport`/`SetColorSpace1`
  both succeed on this adapter, so "fall back to SDR if scRGB cannot be negotiated" is
  covered only by code review plus the equivalence of the SDR path when `ASC_HDR` is unset;
  it needs a machine without scRGB support to be measured.
- `as_hdr_tonemap_rgb48_f16()` still runs on the CPU (sws to RGB48 + per-pixel half encode).
  On a 4K source it is slightly cheaper than the SDR map (no shoulder lookup, no OETF, but
  half-float packing), **no per-frame table was measured**, so it carries no performance claim.

Reproduce:

```bash
# 2D: does SDR white land on 203 nits (max should be 2.5371)?
ASC_HDR=1 ASC_GPU_DUMP_AT=0 ASC_GPU_DUMP=temp/hdr.bmp ./temp/hdrwin.exe
# video: the PQ three-band clip, band0/1/2 nits and ">1.0 highlights survive"
ASC_HDR=1 ASC_GPU_DUMP_AT=1 ASC_GPU_DUMP=temp/pq.bmp ./temp/hdrvid.exe
# white-point invariance: change ASC_HDR_WHITE, in-frame absolute nits stay the same
ASC_HDR=1 ASC_HDR_WHITE=100 ASC_GPU_DUMP_AT=1 ./temp/hdrvid.exe
# the kernel itself, without sws
clang -O0 -I vendor -o temp/pqprobe.exe temp/pqprobe.c vendor/video_hdr.c && ./temp/pqprobe.exe
node --test --test-name-pattern='video' test/unit/*.ts      # 115 checks
```

### 16.13 Zero copy on macOS: VideoToolbox → CVMetalTextureCache (measured 2026-11-19)

§16.9 removed the Windows step `AV_PIX_FMT_D3D11 → system memory`. On macOS the **same wall has a different
shape**: a hardware frame is a `CVPixelBuffer`, which is itself an `IOSurface`, and FFmpeg's readback still runs
`av_hwframe_transfer_data` to move it into system memory before `sws` turns it into planes Skia can sample. So
"does hardware decode win on this host" is the **same question** on both platforms, and the same ruler answers it.

#### 16.13.1 Three routes: one binary, one 4K 10-bit source, real window at 60 Hz, 12 s continuous

The source (built locally with `ffmpeg` from `testsrc2`, not third-party): 3840×2160 HEVC `yuv420p10le`, 30 fps,
360 frames, 20 MB. Window 1600×900, `stage.frameRate = 60`.

| Route | Per-frame CPU cost | App frames | Worst frame gap | Process CPU (12 s wall) |
|---|---|---|---|---|
| Software (default, `threads=8`) | `conv=4.08` + `upload=1.30` ≈ **5.4 ms** | 706 ≈ **60.0 fps** | **63 ms** | 8.76 s (7.64 user + 1.12 sys) |
| Hardware + readback (`AS_VIDEO_DECODE=hw AS_VIDEO_ZC=0`) | `hw=0.68` + `conv=8.5…8.9` + `upload=1.3…1.85` ≈ **10.7 ms** | 702 ≈ 59.9 fps | 34 ms | — |
| **Hardware + zero copy (default `auto`)** | `dec=0.01` + `conv=0.05` + `upload=0.01` + `copy=0.06` ≈ **0.13 ms** | 707 ≈ **60.0 fps** | **24 ms** | **0.56 s** (0.39 + 0.17) |

Each route ran three interleaved rounds; the table is the **median** (per-frame cost varies ≤ 5 % between rounds,
frame counts by ±3). `copy` is submission cost (`CVMetalTextureCacheCreateTextureFromImage` ×2 +
`TextureFromYUVATextures`); the GPU work is asynchronous and does not appear there.

How to read it:

- **The readback costs only 0.68 ms here** (11.25 ms for the same kind of source on Windows), and hardware decode
  *still* loses to software by 2×: the money moved into `conv` — `8.5` against `4.08`. Both routes make one `sws`
  pass to I420 (Skia's YUV shader only takes 8-bit 4:2:0), and **semi-planar P010 → I420 measures about twice
  planar yuv420p10le → I420**. That is a measured number, not an instruction-level explanation, but the conclusion
  does not depend on the mechanism: **moving only the decode onto the GPU and leaving the conversion on the CPU
  still loses.**
- Zero copy removes the readback **and** that conversion, so which of the two was more expensive stops mattering:
  0.13 ms/frame, process CPU down to 0.56 s out of 12 s (1.4 % of a core) against software's 8.76 s (73 %). The
  worst frame gap drops from 63 ms to 24 ms — at 60 Hz that is "every frame is painted before the next one lands".
- 8-bit sources behave the same (same binary, 3840×2160 H.264, 30 fps): software `conv=1.56 + upload=1.56` ≈ 3.1 ms,
  readback `hw=1.06 + conv=0.95 + upload=2.54` ≈ 4.6 ms, zero copy **0.06 ms**.

#### 16.13.2 The chain: four stages on Windows, one here

The implementation is `vendor/video_metal.mm` (Objective-C++, Apple only) and it exposes four C entry points to
`vendor/video_glue.c`, parallel to `vendor/video_d3d.cc`: `sk_video_mtl_image()` / `sk_video_mtl_probe()` /
`sk_video_mtl_stats()` / `sk_video_mtl_forget()`. The rule "the FFmpeg C seam knows nothing about Skia" is unchanged.

Of §16.9.2's four stages only one survives, because the carrier is different:

1. **Decoded slice → own shared staging: not needed.** A D3D11 slice is one subresource of a Texture2DArray and has
   to be `CopySubresourceRegion`'d into a staging texture that can be shared; a `CVPixelBuffer`'s IOSurface **is**
   the `MTLTexture`'s storage, so `CVMetalTextureCacheCreateTextureFromImage` only wraps that memory — **zero blit**.
2. **GPU-side sync: not needed.** Windows needs a shared fence because the D3D11 decoder and the D3D12 renderer are
   two devices; here the decoder and Skia are on the same `MTLDevice` (`sk_mtl_device_ptr()` returns metal_glue's
   `g_device`), so Metal's own hazard tracking covers it.
3. **Plane split: the CV cache hands it over.** Plane 0 is Y, plane 1 is UV, one texture each — no
   `CopyTextureRegion` and no barrier.
4. **Wrap into an SkImage**: `GrBackendTexture[2]` + `SkYUVAInfo(kY_UV, 420/422, yuv_cs)` →
   `SkImages::TextureFromYUVATextures`, the same line of code and the same colour enum as Windows.

#### 16.13.3 Four things that must be handled explicitly (all found by testing, not guessed)

1. **The plane layout comes from the `CVPixelBuffer`'s format, not from the caller's `ten_bit`.** `x420` (10-bit
   4:2:0) stores its ten significant bits in the **high** half of a 16-bit word (the P010 packing), so
   `R16Unorm`/`RG16Unorm` sample a normalised 0..1 value and the BT.2020 10-bit matrix applies unchanged; `x422` is
   4:2:2 (the ProRes path, no vertical chroma decimation); `420v`/`420f` are 8-bit. **The evidence is a measurement,
   not the documentation**: `AS_VIDEO_DEBUG=1` prints the max Y-plane sample of the first frame, and this host reads
   `max=55296` (0xD800) — far above 1023, so the ten bits really are high-aligned. A reading of ≤ 1023 would mean
   low-aligned, and `R16Unorm` would then paint a picture ~60× too dark ("runs, but the colour is wrong").
2. **The `CVPixelBuffer`'s lifetime follows the SkImage.** Both `MTLTexture`s are **views** into its IOSurface, and
   the `SkImage` can live in the display list for many frames; the token `CFRetain`s the pixel buffer and Skia's
   release callback is the only `CFRelease`. Without it nothing crashes — it **paints a frame that has been
   overwritten**, which is the worst kind of bug.
3. **Plane geometry must equal picture geometry.** Row padding is carried by `bytesPerRow` (the CV cache hands it to
   the texture), but a plane **height** aligned upwards would be stretched by an `w×h` YUVAInfo. The code compares
   `CVPixelBufferGetWidthOfPlane/HeightOfPlane` and returns NULL (readback route) on a mismatch instead of betting on
   "close enough".
4. **Zero copy only exists in a GPU window.** Under `ASC_RENDER_METAL`, `as_skia_gr_context()` returns
   `sk_metal_get_context()`, which `sk_mtl_init()` creates with the window; a manifest therefore needs
   `ASC_RENDER_WINGPU=1` + `ASC_RENDER_METAL=1` + `metal_glue.mm`. A pure CPU-raster window has a NULL `grctx` and
   video stays on `sws → BGRA` — where 4K 10-bit costs `conv=16.6 ms/frame` (measured here). Unrelated to this
   section, but worth stating plainly: that is "the GPU window is not on", not "zero copy is unavailable".

#### 16.13.4 The adaptive default shares one ruler with Windows

`as_video_maybe_upgrade()` (§16.9.6) was not duplicated for macOS: `AS_VIDEO_DECODE` unset means `auto`, which asks
`as_video_zc_available()` once at the **first frame boundary** and only then reopens on the GPU and seeks back to 0;
otherwise it stays software (measured here: `auto` prints
`[video] auto: upgraded to GPU decode (3840x2160, P010)` and later `decode=videotoolbox-zero-copy zc=357`). The two
platforms differ in exactly one place, and it is a **data**-shaped one: `AS_VIDEO_ZC_DEVICE` is 1 on Windows (the
seam keys its table by the ID3D11Device) and 0 on Apple (one MTLDevice per process, no identity to pass), so
`hw_dev11` is always NULL on Apple and the Apple build never references `AVD3D11VADeviceContext`.

HDR keeps the CPU decode for the same reason as §16.9.6: `sk_gpu_hdr_active()` is 0 on every non-D3D backend, and
with `AS_VIDEO_HDR=1` `as_video_hdr_wanted()` is 1, so `as_video_maybe_upgrade()` marks the question decided and
never upgrades.

#### 16.13.5 Colour: two independent routes draw the same frame, within 3

Zero copy being fast proves nothing about being right (a wrong picture is fast too), so the colour is compared
separately. `BitmapData.draw(video)` uses the same content branch as presentation, so 66 fixed sample points from
each route (320×180 thumbnail, fixed grid) can be compared directly:

| | Mean R/G/B | Colour-bar readings (red/green/yellow/blue/magenta/cyan) |
|---|---|---|
| Software (`sws` → I420 → Skia YUV) | 113.6 / 118.5 / 137.4 | `255/0/0`, `0/255/0`, `254/254/0`, `0/0/254`, `254/0/253`, `0/255/255` |
| Zero copy (Skia samples R16/RG16) | 113.3 / 117.3 / 137.4 | `252/0/0`, `0/255/0`, `252/255/0`, `0/1/253`, `254/0/252`, `0/255/253` |

Mean difference < 1.5, saturated bars within 3 (10-bit → 8-bit rounding differs: sws and Skia do not share a dither).
A wrong matrix or range (limited read as full, BT.2020 as BT.709) would shift the whole frame by tens and blow this
table up immediately. The 8-bit route was compared the same way (`420v` → R8/RG8): 112.7/118.7/137.2 against
113.6/117.9/138.7.

#### 16.13.6 Reproduce

```bash
# Fixture (built locally, not committed)
ffmpeg -f lavfi -i "testsrc2=size=3840x2160:rate=30:duration=12" \
       -c:v libx265 -pix_fmt yuv420p10le -preset ultrafast -tag:v hvc1 temp/vt/sdr4k10.mp4
# Probe (real window, 60 Hz, 12 s, enterFrame records the worst gap) -> temp/vt/bench10g
node src/index.ts temp/vt/bench10.as --manifest temp/vt/play.build.json -o temp/vt/bench10g

AS_VIDEO_STATS=1 AS_VIDEO_DECODE=soft ./temp/vt/bench10g                    # software
AS_VIDEO_STATS=1 AS_VIDEO_DECODE=hw AS_VIDEO_ZC=0 ./temp/vt/bench10g       # hardware + readback
AS_VIDEO_STATS=1 ./temp/vt/bench10g                                        # adaptive (zero copy)
/usr/bin/time -l env AS_VIDEO_DECODE=soft ./temp/vt/bench10g               # process CPU

node --test --test-name-pattern='video' test/unit/video.ts                 # 115 checks
```

`temp/vt/play.build.json` is the same shape as the macOS branch of `examples/video/video.build.json`
(`ASC_RENDER_WINGPU=1` + `ASC_RENDER_METAL=1` + `metal_glue.mm` + `video_metal.mm`).

#### 16.13.7 Not done, and the boundaries

- **iOS is not measured**: the seam is the same lineage (same `AV_PIX_FMT_VIDEOTOOLBOX`), but whether
  `MTLPixelFormatR16Unorm` is filterable there, and the fact that iOS forbids shipping executable code, are both
  unverified — **not claimed to work**.
- **`AS_VIDEO_ZC=0` is the only shared off switch**: `AS_VIDEO_DECODE=hw` ignores it (forced hardware still tries
  zero copy), so an A/B needs both.
- **All streams share one texture cache**: `sk_video_mtl_forget()` drops the whole `CVMetalTextureCache` when any
  stream closes and the next frame rebuilds it (microseconds). In-flight `SkImage`s each hold their own `MTLTexture`
  reference, so they are unaffected; this is "for simplicity", not "optimal", and it becomes refcounting if
  many-stream, high-rate open/close ever shows up.
- **HDR output is still Windows-only**: macOS has no scRGB swap-chain step (§16.12 is the D3D side), so on macOS
  `AS_VIDEO_HDR=1` means CPU tone map + BGRA, mutually exclusive with zero copy — the two routes never coexist.

---

## 17. Reference anchors

- AS3 reference: [`flash.net.NetStream`](https://airsdk.dev/reference/actionscript/3.0/flash/net/NetStream.html),
  [`flash.media.Video`](https://airsdk.dev/reference/actionscript/3.0/flash/media/Video.html),
  [`flash.media.VideoCodec`](https://airsdk.dev/reference/actionscript/3.0/flash/media/VideoCodec.html)
- FFmpeg trimming and licensing: [ffmpeg-all](https://ffmpeg.org/ffmpeg-all.html), [legal](https://ffmpeg.org/legal.html)
- In-repo docs: [`yuv-direct-render.md`](yuv-direct-render.md) (YUV direct render, implemented),
  [`audio.md`](audio.md) (miniaudio backend and audio parity),
  [`flash-net.md`](flash-net.md) (`NetConnection`/`URLLoader` state)
- Repo-root analyses: [`video-frame-copy-chain-analysis.md`](../../../video-frame-copy-chain-analysis.md),
  [`yuv-video-direct-draw-analysis.md`](../../../yuv-video-direct-draw-analysis.md)
