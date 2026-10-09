# Audio Playback (`flash.media`) — Investigation and Plan

> This document answers one question: **where does AS3's `flash.media.Sound` family stand today, and what is
> required to make it actually produce sound**.
> Conclusion first: **there is zero support today** — `Sound`/`SoundChannel`/`SoundTransform` are just the
> **empty shells left behind by stage 93** (`play()` returns a fresh empty `SoundChannel`;
> `loadCompressedDataFromByteArray()` and `stop()` are no-ops), and the repository has **no audio backend and no
> decoder at all**. The hard part is **not** the AS3 surface but the backend: the SDL2 vendored here **was never
> built with the CoreAudio backend** (§4), so "just use SDL2 to make a sound" is a dead end.
>
> **Status banner (2026-10-06, v0.4.69)**: this document started as **research**; **stage 96 implemented it**
> (scope A-D), backend = `vendor/audio_glue.c` (miniaudio v0.11.25), so `Sound`, `SoundChannel`,
> `SoundTransform`, `SoundMixer`, `SoundLoaderContext` and `ID3Info` are real APIs now.
> **The measured AIR contract is §13 and the divergence list is §14** (both cite reproducible adl 51.4.1
> evidence). Acceptance: `temp/audioprobe/diffall.sh` -> **14 rounds PASS / 0 DIFF / 5 N/A**, each N/A with its
> reason recorded in the script's round table. Example: `examples/audio.as` (+ `examples/audio.build.json`,
> which synthesises its own PCM tone, so no asset file is needed).
> §1-§12 are the **pre-implementation research snapshot** and are kept for the record; their "zero support" /
> "not yet approved" statements are superseded by this stage.

---

## 1. Current State: `Sound` Is an Empty Shell, and There Is No Audio Backend

Three reproducible facts:

| Location | State |
|---|---|
| `src/emit.ts:6716-6728` | Only 5 implementations exist: `SoundTransform_ctor/new`, `Sound_ctor/new`, `SoundChannel_ctor/new`; `Sound_play` always `return SoundChannel_new()` (discarding `startTime`/`loops`/`transform`), and `Sound_loadCompressedDataFromByteArray` / `SoundChannel_stop` are `(void)...` no-ops |
| `src/symbols.ts:1387-1450` | The three classes declare only a **minimal surface**: `SoundTransform{volume,pan}`, `Sound{play, loadCompressedDataFromByteArray}`, `SoundChannel{stop}`; there is **no** `position`/`soundTransform`/`length`/`bytesTotal`/`SoundMixer`/`SoundLoaderContext`/`ID3Info` |
| Whole repo | `grep -iE "SDL_OpenAudioDevice\|CoreAudio\|AVAudio\|AudioToolbox\|webaudio\|miniaudio\|minimp3\|mp3" src/ vendor/*.cc` — **zero hits** (outside comments) |

Stage 63 (`flash.media`) explicitly deferred this ("depends on an audio decode backend") and stage 93 only
added a shell so Starling would compile. **So: it compiles, you get a `SoundChannel` object, but not a single
byte of sound comes out.**

---

## 2. The Real AS3 API Surface (authority = AIR Language Reference)

Every item must be checked against the official docs before implementation (`AGENTS.md` §2.4). Four classes plus
two helpers:

**`flash.media.Sound`** (extends `EventDispatcher`, **not final**)

- Constructor `Sound(stream:URLRequest = null, context:SoundLoaderContext = null)` (passing a URL auto-calls `load()`)
- Methods: `load(stream, context=null)`, `loadCompressedDataFromByteArray(bytes, bytesLength)` (**AIR 3**),
  `loadPCMFromByteArray(bytes, samples, format="float", stereo=true, sampleRate=44100)`, `play(startTime=0, loops=0, sndTransform=null):SoundChannel`, `close()`, `extract(target, length, startPosition=-1)`
- Read-only: `bytesLoaded:uint`, `bytesTotal:int`, `id3:ID3Info`, `isBuffering`, `isURLInaccessible`, `length:Number` (ms), `url:String`
- Events: `complete`, `id3`, `ioError`, `open`, `progress`, `sampleData`

**`flash.media.SoundChannel`** (**final**, extends `EventDispatcher`)

- Method: `stop()`
- Read-only: `position:Number` (ms; **retained** after stop; **reset to 0** at the start of each loop), `leftPeak`, `rightPeak`
- Read-write: `soundTransform:SoundTransform`
- Event: `soundComplete`

**`flash.media.SoundTransform`** (extends `Object`)

- `volume:Number` (default 1), `pan:Number` (default 0), `leftToLeft`, `leftToRight`, `rightToLeft`, `rightToRight`
- Constructor `SoundTransform(volume=1, pan=0)`

**`flash.media.SoundMixer`** (**final**, all-static)

- Static properties: `soundTransform` (global final gain), `bufferTime`, `audioPlaybackMode`, `useSpeakerphoneForVoice`
- Static methods: `stopAll()`, `computeSpectrum(outputArray, FFTMode=false, stretchFactor=0)`, `areSoundsInaccessible()`

**Helpers**: `SoundLoaderContext(bufferTime=1000, checkPolicyFile=false)`, `ID3Info` (`songName`/`artist`/`album`/
`genre`/`track`/`year`/`comment` plus `TXXX`-style frames), `SampleDataEvent`/`AudioPlaybackMode` constant classes.

---

## 3. The Small Slice This Repository Actually Needs (measured from the demos)

Ignore the full API for a moment and look only at what the **apps actually running in this repo** need:

| Demo | Audio usage | Path |
|---|---|---|
| `examples/Flappy-Starling` (both native and web run `--main-class FlappyStarlingMobile`) | `assets.playSound("flap"/"pass"/"crash")` → `Sound.play(0, 0, null)` | At startup `assets.enqueue(appDir.resolvePath("assets/sounds"))` → `AssetManager` enumerates via `File` → `SoundFactory.create` → **`new Sound(); sound.loadCompressedDataFromByteArray(bytes, bytes.length)`** |
| Starling `MovieClip` frame sounds (`display/MovieClip.as`) | `frame.playSound(transform)` → `if (sound) sound.play(0, 0, transform)` | Uses `SoundTransform` |
| `examples/air-starling-demo` | `MovieScene` frame sound: `MovieClip.setFrameSound(2, wing_flap)` → `frame.playSound(transform)` → `Sound.play(0,0,transform)`; the audio is loaded by the `AssetManager`'s **`SoundFactory`** | **Enabled** (2026-10-06): `scenes/MovieScene.as:20` is uncommented, and `registerFactory(new SoundFactory())` in `starling/assets/AssetManager.as` **must be uncommented too** — while it was commented out, `wing_flap.mp3` was swallowed by the fallback `ByteArrayFactory` as **raw bytes**, so `getSound("wing_flap")` was always `null` and the frame sound **failed silently** (no error at all). Full investigation in §13.4 |

Asset measurements:

| File | Size | Form |
|---|---|---|
| `pass.mp3` | 5,432 B | `MPEG ADTS, layer III, v1, 128 kbps, 44.1 kHz, Monaural` |
| `flap.mp3` | 6,686 B | same |
| `crash.mp3` | 7,522 B | same |

The three files total **19.2 KB**, each roughly 0.34–0.47 s (≈1.2 s total). Decoded to s16 mono PCM that is about
**108 KB** — **tiny, so there is no memory or size concern whatsoever**.

**Therefore the minimal usable surface** (without which the demo cannot play any sound) is:

```
new Sound()                                                  // construct
sound.loadCompressedDataFromByteArray(bytes, bytes.length)   // synchronous MP3 decode
sound.play(startTime, loops, transform) -> SoundChannel      // start
channel.stop()                                               // stop
new SoundTransform(volume, pan)                              // volume / pan
```

Plus (observable, and read by Starling): `SoundChannel.position`, `Event.SOUND_COMPLETE`, `Sound.length`/`bytesTotal`.

**Two things NOT needed** (to avoid scope creep):

1. **`[Embed]`ed mp3 is not required by the current demo** — the web build also uses `FlappyStarlingMobile`
   (filesystem path), never `FlappyStarlingWeb`'s `enqueue(EmbeddedAssets)`. And measured in the generated C,
   **`EmbeddedAssets_flap = NULL`** (`[Embed]` metadata has **no consumer** at all; the mp3 bytes are not embedded
   — see §10). That is a **separate "Embed assets" gap**, not part of this plan.
2. `Video`, `Microphone`/`Camera`, and `NetStream`/RTMP are each independent decode domains and out of scope here (§10).

---

## 4. Backend Choice: First, an Empirical Trap That Will Catch You

"The repo already vendors SDL2 (`vendor/sdl2/arm64/`), SDL2 ships `SDL_OpenAudioDevice`, so just use it" —
**that road is closed.** Three pieces of evidence (all reproducible):

```
$ ar t vendor/sdl2/arm64/lib/libSDL2.a | grep -iE "coreaudio|audio"
SDL_audio.o  SDL_audiocvt.o  SDL_audiodev.o  SDL_audiotypecvt.o  SDL_dummyaudio.o
$ nm -gU vendor/sdl2/arm64/lib/libSDL2.a | grep -icE "COREAUDIO|AudioUnit|kAudioUnit"
0
$ strings vendor/sdl2/arm64/lib/libSDL2.a | grep -i coreaudio
(empty)
```

That is: this SDL2 was compiled with **only `SDL_dummyaudio` (the dummy driver)**;
`SDL_AUDIO_DRIVER_COREAUDIO` is undefined and the `frameworks` list has no `AudioToolbox`/`CoreAudio`.
`SDL_OpenAudioDevice` will **succeed but never make a sound** (the dummy driver happily consumes the queue).
**That is more dangerous than "not implemented" — it looks like it works.**

| Candidate | native | web | WASI | New dependency | Assessment |
|---|---|---|---|---|---|
| **A. miniaudio** (single header) | ✅ Core Audio | ✅ Web Audio (Emscripten) | ❌ | 1 header (`+dr_mp3.h`) | Zero external deps, pure C89, **one implementation covers native+web**; built-in MP3/WAV/FLAC/Vorbis decode. Fits §2.9 "link a mature library, don't self-roll" best |
| **B. Per-target bespoke glue** | ✅ AudioToolbox `AudioQueue` (plain C system framework, ~150 lines) | ✅ `emscripten/webaudio.h` (AudioWorklet) | ❌ | none | Follows the existing split (`window_glue.cc` native / `web_glue.cc` web); but **two implementations to write**, and against the spirit of §2.9 |
| **C. Rebuild SDL2 with CoreAudio** | ✅ | ✅ (`-sUSE_SDL=2`, **cost in §4.1**) | ❌ | requires SDL2 **source** build | Reuses the existing SDL2 semantics, but needs a new `build-tools/sdl2-src` and replacement vendor artifacts; highest cost, least gain (native/web specifics in §4.1) |

**Decoder candidates**:

| Candidate | Covers | Notes |
|---|---|---|
| `dr_mp3.h` (single header, public domain/MIT-0) | MP3 | Likewise `minimp3.h`; both ~1.7K lines of plain C, **portable across native + wasm** |
| miniaudio's built-in decoders | MP3/WAV/FLAC/Vorbis | If option A is chosen, the decoder **comes with the backend** — no extra file |
| Platform decoders (AudioToolbox `AudioFile` / web `decodeAudioData`) | per platform | No vendored lib, but **two implementations**, not portable to Linux/Windows/WASI, contradicts "one codebase, one behaviour" |
| Compile-time decode (decode in Node, bake PCM into `.c`) | compile-time-known assets only | Cannot cover Flappy's **runtime file read** path (`loadCompressedDataFromByteArray` receives runtime bytes) ⇒ supplementary at best, never the main plan |

### 4.1 Concrete native / web Differences Between A (miniaudio) and C (Rebuild SDL2)

Both routes can make a sound, but the **cost lands in completely different places**. All rows below are
measured on this machine:

| Dimension | A. miniaudio | C. Rebuild SDL2 |
|---|---|---|
| **native output** | Compile `miniaudio.h` → CoreAudio backend, no external library | Must rebuild `vendor/sdl2/arm64/` from source (today it holds only **prebuilt arm64 macOS artifacts**; no source under `vendor/`) |
| **native blast radius** | One new header; **never touches the window backend** | The rebuilt SDL2 **also serves the window** ⇒ touching SDL2 touches the window; regression surface grows from "audio" to "window/events/cursor" |
| **web output** | Uses emsdks's **bundled** `emscripten/webaudio.h` (AudioWorklet) — **in-tree, offline-usable** | `-sUSE_SDL=2` **downloads** `SDL-release-2.24.2.zip` over the network (this emsdk has **no** such port installed: `cache/ports/` holds only `zlib`) |
| **native/web version parity** | One `miniaudio.h`, same version on both ends | native vendors **SDL 2.32**, while the emscripten port is **2.24.2** ⇒ **version skew between the two ends** |
| **web invasiveness** | A pure audio library; **zero conflict** with the existing bespoke `web_glue.cc` (canvas + `emscripten_set_main_loop`) | Drags SDL2's video/event/`SDL_main` into a web build that **deliberately avoids SDL2** ⇒ a second windowing stack; main-loop/init friction. (That "deliberately" is the repo's own invariant: the web branch in `src/air-app.ts:257-266` states "no SDL2/objc/Cocoa — those are native-only", `SDL2` appears only in `"target":"native"` manifests, and the built `Starling-Demo.wasm` contains **0** SDL symbols) |
| **MP3 decode** | **Built in** (dr_mp3 lineage), comes with the library | **Not included**; still needs `dr_mp3.h`/`minimp3.h` |
| **Cross-platform native** | One file covers macOS/Linux/Windows/WASI(null) | Only arm64 macOS artifacts today; Linux/Windows each need their own rebuild |
| **Licence** | Public domain / MIT-0 | zlib (neither is a concern) |
| **Long-term upkeep** | 1 header | An SDL2 source tree + build recipe + version tracking + coupling to the window backend |

**What they share (hence not a differentiator)**: both expose a C API; the audio callback runs on a
**separate thread**, so both must respect the existing "audio thread never touches the GC heap" constraint;
on web both must resume `AudioContext` after a **user gesture**; on WASI neither has a backend
(miniaudio falls back to its null backend, i.e. silence ⇒ must be **honestly reported**, never silently faked
as success).

**The only argument for C**: if you later intend to unify **web windowing/events onto SDL2 as well**
(dropping the bespoke canvas glue), then rebuilding SDL2 and getting audio along the way pays off. That is a
much larger refactor than audio; **for audio alone it is not worth it**.

**Verdict: pick A (decided 2026-10-06).**

**The first nail is already driven (measured 2026-10-06, evidence in `temp/audiomini/`)**: the only unknown was
whether miniaudio's Emscripten backend compiles on this machine's emscripten 3.1.44 with **zero extra flags** and
selects Web Audio at runtime — a 30-line probe (`ma_context_init` + `ma_device_init` + `ma_device_start` + a
440 Hz sine) now passes on **both ends**:

| End | Build command (zero extra flags) | Runtime backend | Result |
|---|---|---|---|
| **native** | `clang -O2 -o probe-native probe.c -lpthread -framework CoreFoundation -framework CoreAudio -framework AudioToolbox` | **`Core Audio`** (4 playback devices, default `MacBook Pro扬声器`) | `context_init`/`device_init`/`device_start` all `0 (No error)` + `PROBE_OK` |
| **web** | `emcc -O2 -o probe-wasm.html probe.c` (**zero `-s` flags**, 4.6 s) | **`Web Audio`** (1 `Default Playback Device`) | same + `PROBE_OK` |

⇒ Both ends pick up a **real backend** (not null/dummy), the exact opposite of the SDL2 dummy-driver trap in §4;
miniaudio can go straight into step A. (Probe artifacts: `temp/audiomini/probe.c` + `probe-native` +
`probe-wasm.{html,js,wasm}` + two stdout captures; miniaudio **v0.11.25**, 4,108,168 B / 95,864 lines.)

---

## 5. AIR Semantics That Must Be Matched (not merely "it makes a sound")

These are the **"runs but semantically wrong"** traps, taken from the official docs (with corresponding `adl`
behaviour to be measured per item during implementation):

| Semantics | Correct behaviour (AIR) | Common mistake |
|---|---|---|
| `play()` return | **Each call returns a new `SoundChannel`**; a single `Sound` can play several channels at once | Reusing one channel per `Sound` ⇒ the second playback swallows the first |
| `loops` | "times to loop back to `startTime`": `loops=1` ⇒ plays **twice**; `loops=0` ⇒ once | Treating it as "number of plays" |
| Channel cap | At most **32** concurrent; beyond that `play()` returns **`null`** | No cap, or throwing |
| `startTime` / `position` | Milliseconds; `position` **retains** its last value after stop and **resets to 0** at each loop start | `position` stuck at 0, or measured in seconds |
| `SOUND_COMPLETE` | Dispatched on the `SoundChannel` when playback **finishes** (loops exhausted too) | Never dispatched; or dispatched on `Sound` |
| `SoundTransform` | Channel-level, then `SoundMixer.soundTransform` applies a **further global layer** | Storing the fields without affecting output |
| `loadCompressedDataFromByteArray` | **Synchronous** decode (AIR 3); throws if the data is insufficient; dispatches `Event.ID3` when ID3 is present | Async, or silently swallowing errors |
| `SoundMixer.stopAll()` | Stops every playing channel | Missing |
| No audio device | `play()` returns `null` (official: "returns null if you have no sound card or run out of channels") | Crashing, or silently returning an empty channel |

---

## 6. Boundary Between AIR Fidelity and Enhancement (§1.5)

- **This is closing a gap, not an enhancement**: `Sound`/`SoundChannel`/`SoundMixer` obviously **exist in AIR**
  and do produce sound. So **no `--features` flag and no "deny by default"** — sound should simply work.
- **WASI has no audio** (no SDL, no CoreAudio, no Web Audio, no miniaudio backend) ⇒ a **platform hard boundary**;
  it must **honestly report "this backend does not support audio"** (`play()` returns `null`, or a loud error),
  and **must never silently pretend success**.
- **Browser autoplay policy** (an `AudioContext` must be `resume()`d after a user gesture) ⇒ likewise a platform
  hard boundary. The window harness already has synthetic-click capability (`temp/nwtest/`, the Flappy driver
  scripts), so this is addressable; the web end should `resume()` on the first user gesture. **Handle it
  honestly, never silently.**

---

## 7. Implementation Landing Spots (aligned with `AGENTS.md` layering)

| Layer | Landing spot |
|---|---|
| `symbols.ts` | Complete `Sound`/`SoundChannel`/`SoundTransform`/`SoundMixer`/`SoundLoaderContext`/`ID3Info` fields, getters/setters, statics, constants (replacing the stage-93 minimal subset) |
| `emit.ts` | Replace the 5 stubs with real implementations: the object holds a decoded-PCM handle + a global channel registry; `play()` creates a channel, `stop()` removes it |
| `runtime.ts` | A **channel table** (GC-tracked: a playing channel is a permanent root, reclaimed at a frame boundary once finished) + `as_audio_tick()` (per-frame reclaim + `SOUND_COMPLETE` dispatch) + platform coupling isolation (like the existing `as_now_ms`) |
| `vendor/` | **New audio glue**: option A ⇒ `vendor/miniaudio_glue.c` (`#define MINIAUDIO_IMPLEMENTATION` + `DR_MP3_IMPLEMENTATION`) exposing a backend-agnostic `as_audio_*` C interface; option B ⇒ `audio_glue.cc` (native) + `audio_glue_web.cc` |
| `build.ts` | Manifest gains `link-libs`/`defines` (e.g. `ASC_HAVE_AUDIO`) and the glue's `sources`; the WASI branch compiles no audio glue |
| Frame loop | Same layer as `as_timer_tick` / event dispatch; advanced at frame boundaries |

**GC red line**: channel objects must be GC-tracked and, while playing, act as **permanent roots** (like the
in-flight async-IO targets in `as_async_mark_roots`), otherwise incremental marking will collect a playing
channel. If the PCM buffer lives in the arena it is never reclaimed (acceptable for short SFX), but the choice
must be documented.

---

## 8. Phased Plan (2026-10-06 decision: **all of A–D**, registered as **stage 96** v0.4.66 →)

| Step | Content | Acceptance |
|---|---|---|
| **A** | Backend + decode skeleton: `new Sound()`, `loadCompressedDataFromByteArray`, `play→SoundChannel`, `stop`, `SoundTransform(volume,pan)` | `examples/stage96.as` (offscreen, asserting objects/properties/channel count) + the three Flappy SFX **audibly play** |
| **B** | Semantics: `startTime`/`loops`/`position`/`SOUND_COMPLETE`/`SoundMixer.stopAll()`/32-channel cap | Assert `loops=1` plays twice, `position` advances and resets, `position` is retained after `stop` |
| **C** | Metadata surface: `length`/`bytesTotal`/`bytesLoaded`/`id3` + `Event.ID3`/`OPEN`/`COMPLETE`/`PROGRESS`/`IO_ERROR` + `SoundLoaderContext` | Assert `length`/`bytesTotal` for the three mp3s and ID3 (if present) |
| **D** | Advanced: `SoundMixer.computeSpectrum`/`Sound.extract`/`sampleData`/`loadPCMFromByteArray`/streaming `Sound.load(URLRequest)` | Per-item offscreen assertions; `computeSpectrum` fills 512 floats |

Each step follows the DoD: an `examples/*.as` plus regression plus a version bump. **2026-10-06 user
decision: all of A–D** (all four steps ship, as four sub-stages; A+B remains the prerequisite — A alone yields
"sound, but wrong semantics").

---

## 9. Explicit Deferrals / Limitations

| Item | Reason |
|---|---|
| `Video` playback | Video decoding, a separate domain |
| `Microphone` / `Camera` capture | Device capture, a separate domain |
| `NetStream` / RTMP | Streaming protocol stack, a separate domain |
| `[Embed]`ed mp3 / images | `Embed` metadata has **no consumer at all** (`EmbeddedAssets_flap = NULL`) — a separate gap |
| `DefineSound` inside SWC | Measured `temp/skin.swc` has **zero**; if encountered it is a separate decode domain (same stance as `swc.md` §10) |
| WASI audio | Platform hard boundary; honestly report "this backend does not support it" |

---

## 10. An Incidental Finding (worth knowing; no decision needed)

**`[Embed]` metadata currently has no consumer whatsoever.** Measured in
`examples/Flappy-Starling/Flappy-Starling.c`:
`static as_class* EmbeddedAssets_flap = NULL;` — i.e. a static constant declared with
`[Embed(source="...mp3")]` is **always NULL**, and the mp3 bytes are **not embedded**
(`grep -cE "0x49, 0x44, 0x33|0xff, 0xfb"` = 0). The `EmbeddedAssets` class itself is registered (39 references)
and `AssetManager` does try to read `Embed` metadata via `describeType`, but the compiler **never emits that
metadata** and never populates these static fields.

- Today's Flappy works because **both ends use `FlappyStarlingMobile`** (`File.applicationDirectory` +
  `preload-paths`) and never take the `enqueue(EmbeddedAssets)` route.
- The moment someone uses `FlappyStarlingWeb` (the true `[Embed]` route), **images/fonts/SFX would all be NULL**.
- This is **separate** from audio, but both affect the completeness of the "Starling asset pipeline", so it is
  reported here; whether to approve it is your call.

---

## 11. Decision Points (for the user)

**All settled (2026-10-06 final decision)**

1. **Backend = A (miniaudio)** (evaluation in §4.1).
2. **Scope = all of A–D** (§8).
3. **Stage number = stage 96** (new top-level; stage 63 is *not* reopened — it is already marked ✅ done — and the
   entry names it as "completing the `flash.media` deferred by stage 63").
4. **The `[Embed]` gap** (§10) is **deferred independently**, not bundled with audio.

⇒ The plan is complete and registered as **stage 96** (see `TODO.md`); ready to start.

---

## 12. Appendix: Reproduction Commands

```bash
cd as3compiler

# 1) Current state: Sound is only a stub, no backend at all
sed -n '6716,6728p' src/emit.ts
sed -n '1387,1450p' src/symbols.ts
grep -rniE "SDL_OpenAudioDevice|CoreAudio|AudioToolbox|webaudio|miniaudio|minimp3" src/ vendor/*.cc   # zero outside comments

# 2) The vendored SDL2 has no CoreAudio backend (the key finding)
ar t vendor/sdl2/arm64/lib/libSDL2.a | grep -iE "coreaudio|audio"
nm -gU vendor/sdl2/arm64/lib/libSDL2.a | grep -icE "COREAUDIO|AudioUnit|kAudioUnit"    # 0
strings vendor/sdl2/arm64/lib/libSDL2.a | grep -i coreaudio                            # empty
grep -nE "SDL_AUDIO_DRIVER_COREAUDIO" vendor/sdl2/arm64/include/SDL2/SDL_config.h      # undef

# 3) The available web channel (ships with emscripten)
ls build-tools/emsdk/upstream/emscripten/system/include/emscripten/webaudio.h

# 4) The demos' real usage and assets
grep -rniE "playSound|loadCompressedDataFromByteArray|SoundFactory" examples/Flappy-Starling/src/starling/assets/
file examples/Flappy-Starling/assets/sounds/*.mp3
ls -la examples/Flappy-Starling/assets/sounds/

# 5) [Embed] has no consumer (incidental finding)
grep -nE "EmbeddedAssets_(flap|pass|crash) =" examples/Flappy-Starling/Flappy-Starling.c   # = NULL
grep -cE "0x49, 0x44, 0x33|0xff, 0xfb" examples/Flappy-Starling/Flappy-Starling.c          # 0

# 6) emscripten's SDL2 port is not installed locally (-sUSE_SDL=2 downloads SDL 2.24.2)
ls build-tools/emsdk/upstream/emscripten/cache/ports/                                        # only zlib
ls build-tools/emsdk/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten/ | grep -i sdl  # empty
grep -nE "^TAG|fetch_project" build-tools/emsdk/upstream/emscripten/tools/ports/sdl2.py      # release-2.24.2, pulled from GitHub
grep -hE "define SDL_(MAJOR|MINOR)_VERSION" vendor/sdl2/arm64/include/SDL2/SDL_version.h     # 2.32 ⇒ skew

# 7) Only native manifests link SDL2; the web side deliberately excludes it
grep -rn '"SDL2"' examples/ --include=*.build.json          # all land in "target":"native" manifests
grep -nE "no SDL2|native-only" src/air-app.ts                 # web branch comment: explicitly excludes SDL2/objc/Cocoa
strings examples/air-starling-demo/Starling-Demo.wasm | grep -icE "SDL_"   # 0 ⇒ no SDL2 in the web artifact

# 8) The miniaudio probe (stage 96, first nail): zero extra flags on both ends -> real backends
cd temp/audiomini
curl -sSL -o miniaudio.h https://raw.githubusercontent.com/mackron/miniaudio/master/miniaudio.h
clang -O2 -o probe-native probe.c -lpthread \
  -framework CoreFoundation -framework CoreAudio -framework AudioToolbox
./probe-native                       # context backend : Core Audio; 4 playback devices; PROBE_OK
../../build-tools/emsdk/upstream/emscripten/emcc -O2 -o probe-wasm.html probe.c   # 4.6 s, zero -s flags
python3 -m http.server 8137          # then open http://127.0.0.1:8137/probe-wasm.html
#   -> context backend : Web Audio; 1 Default Playback Device; PROBE_OK
```
---

## 13. Measured contract (stage 96, adl 51.4.1)

Every row below was measured on `adl` first and only then implemented; the evidence is the probe output in
`temp/audioprobe/adlref/adl*.txt`, produced by `temp/audioprobe/gen*.ts` against the AIR SDK 51.4.1.

### 13.1 Where the code lives

| Layer | Location | Job |
|---|---|---|
| Semantics | `src/symbols.ts` (the six classes' fields/signatures, and `SoundTransform.pan` as a **derived** value) | API shape |
| Emitter | `src/emit.ts` (`Sound_*` / `SoundChannel_*` / `SoundMixer_*` / `Sound__finish` / `Sound__applyID3`) | semantics + C, the only place that touches `as_audio_*` |
| Seam | `src/runtime.ts` `ASC_HAVE_AUDIO` declarations (+ no-op stubs without a backend) | decouples the backend; the **generated C is byte-identical either way**, the choice lives in the build manifest |
| Backend | `vendor/audio_glue.c` (miniaudio, own TU with `MINIAUDIO_IMPLEMENTATION`) | CoreAudio / (web) Web Audio; decode + mix + capture ring |
| Build | `src/build.ts` (`fpFlags`: `-ffp-contract=off`), `src/air-app.ts` (`detectAudio` -> link the glue + `ASC_HAVE_AUDIO`) | target/manifest orchestration |

### 13.2 The contract, item by item

| Topic | adl 51.4.1 | Ours |
|---|---|---|
| `SoundTransform` storage | four channel gains only; `pan` is **derived**: `pan = 1 - leftToLeft^2` when both cross gains are 0, else `0` | same shape; the `pan` setter writes `ltl=sqrt(1-p)`, `rtr=sqrt(1+p)`, `ltr=rtl=0`, **no clamping** |
| the 1-ULP pan drift | `new SoundTransform(0.5,0.25).pan` reads `0.2500000000000001`, not `0.25` | reproduced bit-for-bit. It requires building the generated C with **`-ffp-contract=off`**: contracting `1.0 - ltl*ltl` into an FMA drops one rounding and yields `0.2604` instead of `0.2604000000000001` |
| channel gain quantization | `play(0,0,new SoundTransform(1,0.6))` reads back `leftToLeft=0.63` | `SoundTransform__q(v) = trunc(v*100)/100` (truncation toward zero), applied only on the `play()` / `soundTransform=` path |
| `soundTransform` getter | a **fresh object** per call (`c.soundTransform == c.soundTransform` is false) | rebuilt from the channel's five gains |
| `Sound.length` | the **nominal MPEG frame count** (1152 samples per frame header, Xing/Info included); a header whose frame runs past a slice **still counts** | `as_mp3_nominal_frames` walks headers with a byte-wise RESYNC; an out-of-range slice frame adds `samples += 1152` before the `break` |
| `Sound.url` | `null` right after `load()`; **non-null inside an OPEN listener** (final absolute URL, `file:///...`); a **failed** load (missing file / undecodable payload) also reads back non-null even though **no** OPEN fires | `Sound_load` stashes `_snd_requrl`; OPEN is raised in the frame pre-pass, so `as_net_pre_events` fills `_snd_url` first (`as_job_eff_url` for HTTP, the request URL for a local read) |
| `load()` event order | `open; progress(0/bytesTotal); progress(bytesTotal/bytesTotal); complete;`, `bytesTotal` is 0 right after `load()` | matched exactly |
| `isBuffering` | stays `true` **forever** after `load()` (an AIR defect) | reproduced: completion does not clear it |
| `close()` | without a transfer in flight: `Error #2029: This URLStream object does not have a stream opened.` | same text |
| a failed `Sound.load` | a missing file AND an **undecodable** payload both raise `ioError` (`errorID = 2032`, text `Error #2032: Stream Error. URL: <url>`) and dispatch **no** COMPLETE; no OPEN either, yet `url` reads back non-null and `bytesTotal` keeps the fetched size | same (probe round 10): `Sound__finish` checks `as_job_failed` and then a **decode failure**, both carrying 2032 |
| `Sound(stream, context)` | the constructor **auto-loads** | `Sound_ctor` calls `Sound_load` |
| ID3 | ID3v2 and ID3v1(.1) merge **field by field, v2 winning**; an absent field is `null`, a present-but-empty one `""`; the v1 genre is the raw decimal byte (255 -> `"255"`) | `as_id3_parse` (v2.3/v2.4) + `as_id3_parse_v1`, which only fills NULL fields |
| `id3` event | dispatched **synchronously** inside `loadCompressedDataFromByteArray()` (probe log: `before\|id3@after`) | same |
| `loadCompressedDataFromByteArray` | reads at `bytes.position`, leaves it at `position + n`; too little data throws `ArgumentError #2084`; a failed decode throws `#2068` | same, `#2084` text copied verbatim |
| `loadPCMFromByteArray` | check order: format (`#2005` unless `"float"`/`"short"`) -> the **1800 second limit** (`#3767`) -> insufficient data (`#2084`) -> registration failure (`#2068`); position advances by `samples x channels x (4 or 2)`; `"short"` **is** valid | same order and messages; `as_ba_get_u32/get_u16` honour the ByteArray's endianness |
| `extract()` | output is **always 44100 Hz stereo** ("a sample contains both the left and right channels -- that is, two 32-bit floating-point values"), so mono is written twice; returns the number of **samples (frames)**; writes at the target's **current position** and advances it; the default `startPosition=-1` means "continue the cursor" (the cursor lives on the Sound) | same (`_snd_xpos`); big-endian `as_ba_put_u32` |
| `play()` | no data throws `Error #2068: Invalid sound.`; no backend returns `null`; a fresh channel each call; 32-voice cap; `loops=1` plays twice | same (the `#2068` check precedes the device check) |
| `stop()` / `stopAll()` | an explicit `stop()` fires **no** `SOUND_COMPLETE` and keeps `position`; `stopAll()` fires none either and resets `position` to 0 | same |
| peaks | per device block: 0.5029 mid-play -> 0.0065 after COMPLETE; 0 immediately after `play()` | same |
| `computeSpectrum` | always 2048 bytes (512 float32, 256 left then 256 right); `fftMode=false` is the waveform, `true` is the FFT; with no backend the **array is left untouched** | same; the device check precedes the length write, so a backend-less build really leaves it alone |
| `SoundMixer` | `bufferTime=5`, `audioPlaybackMode="media"`, `areSoundsInaccessible()=false` with a device | same; `areSoundsInaccessible() = !as_audio_ready()` |
| `SoundLoaderContext` | `bufferTime=1000`, `checkPolicyFile=false` | same |
| threading / GC | — | the mix callback reads only fixed voice slots and malloc'd PCM, **never the GC heap**; cross-thread scalars are C11 atomics; `computeSpectrum` reads a capture ring; `SOUND_COMPLETE` is dispatched on the AS3 thread at a frame boundary |

### 13.3 Reproducing it

```bash
cd as3compiler
temp/audioprobe/diffall.sh                  # every round: regenerate, build+run ours, diff vs adl
temp/audioprobe/diffall.sh 3 8 9k2          # selected rounds
temp/audioprobe/run_adl.sh adl3.txt         # how the references were captured (120s watchdog)

cd temp/audiomini && cc -O2 -o dectest dectest.c -lm && ./dectest   # nominal frames per fixture
cc -O2 -o id3test id3test.c -lm && ./id3test                        # ID3 field by field
cc -O2 -o specprobe specprobe.c ../audioprobe/sounds/bin20.mp3 -lm  # waveform/FFT peaks
```

### 13.4 Localising the demo's silent frame sound (2026-10-06)

**Symptom**: after enabling `Sound` in `examples/air-starling-demo`, neither the `adl` reference nor the AOT
build made any noise — and the console stayed clean, with no exception.

**Method** (`temp/soundprobe/DemoProbe.as`: subclasses the demo's own `Demo`, drives its way into
`MovieScene` hands-free, then reads `SoundMixer.computeSpectrum`):

| Probe output | Meaning |
|---|---|
| `getSound('wing_flap') = null`, `soundNames = []` | the audio was **never registered as a Sound** |
| `byteArrayNames = [wing_flap;]` | it was swallowed as a raw `ByteArray` by the **fallback factory** |
| `textureNames = [atlas; background; flight_00…]` | textures were fine ⇒ the loading chain itself is OK |
| `MovieClip frames=14 isPlaying=true frameSound2=null` | the clip runs; only the **frame sound is null** |

**Root cause**: `registerFactory(new SoundFactory())` is commented out in the `starling/assets/AssetManager.as`
constructor, while `registerFactory(new ByteArrayFactory(), -100)` is the **fallback factory** (its `canHandle`
is true for any `ByteArray`; priority -100 sorts it last). So the mp3 had no claimant, fell through to the
fallback and was stored as a `ByteArray` — hence `setFrameSound(2, null)` in `MovieScene` was a silent no-op.

**Fix**: uncomment that one registration. Re-verification:

| | adl 51.4.1 | our AOT |
|---|---|---|
| `getSound('wing_flap')` | `[object Sound]` | `Sound` |
| `getSoundNames()` | `[wing_flap;]` | `len = 1` |
| `byteArrayNames` | `[]` | `[]` |
| `frameSound2` | `[object Sound]` | (same AS3; see below) |
| `areSoundsInaccessible()` | `false` | `false` |
| mixer `computeSpectrum` peak | 0.74 → 1.46 | 0 → 0.65 (**frame sound only** — the probe never calls `playSound` directly) |

Both sides were measured to actually push audio into the mixer, i.e. the demo's frame-sound path works.
The peak *values* are not bit-comparable (window phase / FFT shaping, §14.4).

**AOT-side entry point**: `temp/demosound/` (a copy of the demo `src/` + `DemoSoundProbe.as` + a symlink to
the real `assets/`):

```bash
node src/index.ts --air-app temp/demosound/probe.xml --main-class DemoSoundProbe -o temp/demosound/Probe
cd temp/demosound && ./Probe
```

**Side finding**: because the demo uses `flash.media`, `--air-app` **automatically** writes
`vendor/audio_glue.c` / `ASC_HAVE_AUDIO=1` / `CoreAudio`+`AudioToolbox` into the generated
`Starling-Demo.build.json` — no hand-maintained manifest is needed.

---

## 14. Divergences from AIR (stage 96)

**Only the rows below may differ**; `diffall.sh` normalises exactly these fields (`divergences.sed`) and prints
anything else as a residual (currently 14 rounds PASS with no residual). Each row gives "what adl does / what we
do / why".

| # | Divergence | adl | Ours | Disposition |
|---|---|---|---|---|
| 14.1 | **implicit string conversion of a class instance** (not an audio issue; the probes surface it) | `"x" + new Plain()` uses the class's own `toString()` (`PLAIN-TOSTR`); `[object Bare]`; `Error: boom` | prints the bare class name (`Plain`/`Bare`/`Error`); `Error.name` is missing too | a **pre-existing language gap**, recorded in `TODO.md` (遗留待开发); out of scope here. An explicit `p.toString()` agrees on both sides |
| 14.2 | **adl's PCM transfer path yields no samples on this platform** | every `extract()`/raw-sample dump reads `0.000000` | we decode real samples | we do not copy adl's broken path (§1.5). Byte counts, return values, cursor and channel layout are identical (rounds 9b/9c/9d/9k2) |
| 14.3 | **decoder priming offset** | `extract(ts,100,20000)` first sample `L=0.0838623046875` | `L=-0.1396608203649521` | the same PCM, a few samples apart (our index 0 == ffmpeg sample 0; adl is slightly ahead). Sizes/returns/cursor/channels agree; a decoder-level difference |
| 14.4 | **`computeSpectrum` window phase and FFT shaping** | the waveform peak index moves with the block boundary and its magnitude differs from ours by **1 int16 LSB** (0.112762451171875 vs 0.11279296875); the FFT is AIR's own shaping: a bin-20 tone peaks at **bin 9/21** with ~6.49x (stretch 0) / 6.87x (stretch >= 1) the tone amplitude; `stretchFactor` is only observable as "0 vs non-zero" (`F1 == F2` bit-exactly) | the same capture ring, a different window start; a standard 2048-point Hann FFT (the tone lands at its true bin 20, amplitude-normalized) | **implement the documented transform and record the difference**: AIR's shaping cannot be inferred from outside, and **no demo or example uses `computeSpectrum`** (a repo-wide grep matches only the probes). The waveform path is compared quantitatively (2-decimal shared precision) |
| 14.5 | **VBR/Xing MP3s** | `vbr.mp3` (LAME VBR: Xing declares 78 frames, 79 physical) **never dispatches open/complete** on adl (only `START` within a 120 s watchdog) -- it hangs | we follow the **physical frame walk**: 79 frames -> `2063.6734693878 ms` (ffprobe reads the Xing count, 2038.37 ms) | a hang is not a behaviour to copy. Our walk matches adl bit-exactly for all 10 CBR fixtures; the Xing duration and the physical frame count are two different things, and we take the latter |
| 14.6 | **`play(startTime >= length)`** | **hangs** (measured) | clamps to `frames` (the voice ends on the first block) | as above: no hangs |
| 14.7 | **`app:/` URL text** | a `File.applicationDirectory` relative path resolves to `app:/...` | the absolute path text; `ioError`, `len=0` and `buffering=true` agree | a `flash.filesystem` URL-text convention (not audio); the audio contract (`null` vs non-null) is covered in §13.2 |
| 14.8 | **dynamic audio (`SampleDataEvent`) and the WASI/web backends** | `play()` dispatches `sampleData` for the app to feed PCM; with a `SAMPLE_DATA` listener `play()` returns a **real channel** (measured `F dyn play=true len=0`) | `SampleDataEvent` is unimplemented (recorded as a gap); WASI has no backend (`areSoundsInaccessible()=true`, `play()` returns `null`); the web manifest does not link the glue and a build-time **warning** says so | all of it is **reported, never faked** (§1.5). `SampleDataEvent` is recorded in `TODO.md` |
