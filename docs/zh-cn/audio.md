# 音频播放（`flash.media`）调研与方案

> 本文回答一个问题：**AS3 的 `flash.media.Sound` 家族现在处于什么状态，要让它真的出声需要做什么**。
> 结论先行：**目前是零支持**——`Sound`/`SoundChannel`/`SoundTransform` 只是**阶段九十三留下的空壳**
> （`play()` 返回一个新的空 `SoundChannel`，`loadCompressedDataFromByteArray()` 与 `stop()` 是 no-op），
> 全仓没有任何音频后端、也没有任何解码器。而**重活不在 AS3 侧，在后端**：本仓库 vendored 的
> SDL2 **根本没编 CoreAudio 后端**（§4 实测），所以「顺手用 SDL2 放音」这条路是断的。
>
> **状态横幅（2026-10-06，v0.4.69）**：本文原是**调研**文档；**阶段九十六已落地实现**（A~D 全量），
> 后端 = `vendor/audio_glue.c`（miniaudio v0.11.25），`flash.media` 的
> `Sound`/`SoundChannel`/`SoundTransform`/`SoundMixer`/`SoundLoaderContext`/`ID3Info` 已是真实 API。
> **实测口径与对齐结论见 §13，与 AIR 的差异清单见 §14**（每条都附 adl 51.4.1 的可复现证据）。
> 验收：`temp/audioprobe/diffall.sh` → **14 轮 PASS / 0 轮 DIFF / 5 轮 N/A**（N/A 的原因逐条写在脚本表内）。
> 示例：`examples/audio.as`（+ `examples/audio.build.json`，自带 44100 帧 PCM 音源、无需素材文件）。
> §1~§12 是**立项时的调研快照**，其中「零支持」「尚未立项」等描述已被本阶段取代，保留作历史记录。

---

## 1. 现状：`Sound` 是空壳，且没有任何音频后端

三处事实（可 `grep` 复现）：

| 位置 | 现状 |
|---|---|
| `src/emit.ts:6716-6728` | 只有 5 个实现：`SoundTransform_ctor/new`、`Sound_ctor/new`、`SoundChannel_ctor/new`；`Sound_play` 恒 `return SoundChannel_new()`（丢弃 `startTime`/`loops`/`transform`）、`Sound_loadCompressedDataFromByteArray` 与 `SoundChannel_stop` 是 `(void)...` 空操作 |
| `src/symbols.ts:1387-1450` | 三个类只声明了**极小的面**：`SoundTransform{volume,pan}`、`Sound{play, loadCompressedDataFromByteArray}`、`SoundChannel{stop}`；**没有** `position`/`soundTransform`/`length`/`bytesTotal`/`SoundMixer`/`SoundLoaderContext`/`ID3Info` |
| 全仓 | `grep -iE "SDL_OpenAudioDevice\|CoreAudio\|AVAudio\|AudioToolbox\|webaudio\|miniaudio\|minimp3\|mp3" src/ vendor/*.cc` **零命中**（除注释） |

阶段六十三（`flash.media`）当时就把它标为**延后**（依赖音频解码后端），阶段九十三只补了个「让 Starling
能编译通过」的空壳。**所以：能编译、能拿到 `SoundChannel` 对象，但一个字节的声音都发不出来。**

---

## 2. AS3 侧的真实 API 面（权威 = AIR 语言参考）

实现任何一项前必须先核对官方文档（`AGENTS.md` §2.4）。四类 + 两个辅助类：

**`flash.media.Sound`**（继承 `EventDispatcher`，**非 final**）

- 构造器 `Sound(stream:URLRequest = null, context:SoundLoaderContext = null)`（传 URL 即自动 `load()`）
- 方法：`load(stream, context=null)`、`loadCompressedDataFromByteArray(bytes, bytesLength)`（**AIR 3**）、
  `loadPCMFromByteArray(bytes, samples, format="float", stereo=true, sampleRate=44100)`、`play(startTime=0, loops=0, sndTransform=null):SoundChannel`、`close()`、`extract(target, length, startPosition=-1)`
- 只读属性：`bytesLoaded:uint`、`bytesTotal:int`、`id3:ID3Info`、`isBuffering`、`isURLInaccessible`、`length:Number`（毫秒）、`url:String`
- 事件：`complete`、`id3`、`ioError`、`open`、`progress`、`sampleData`

**`flash.media.SoundChannel`**（**final**，继承 `EventDispatcher`）

- 方法：`stop()`
- 只读：`position:Number`（毫秒；停止后**保留**最后位置；循环开始时**归零**）、`leftPeak`、`rightPeak`
- 读写：`soundTransform:SoundTransform`
- 事件：`soundComplete`

**`flash.media.SoundTransform`**（继承 `Object`）

- `volume:Number`（默认 1）、`pan:Number`（默认 0）、`leftToLeft`、`leftToRight`、`rightToLeft`、`rightToRight`
- 构造器 `SoundTransform(volume=1, pan=0)`

**`flash.media.SoundMixer`**（**final**，纯静态）

- 静态属性：`soundTransform`（全局最终增益）、`bufferTime`、`audioPlaybackMode`、`useSpeakerphoneForVoice`
- 静态方法：`stopAll()`、`computeSpectrum(outputArray, FFTMode=false, stretchFactor=0)`、`areSoundsInaccessible()`

**辅助**：`SoundLoaderContext(bufferTime=1000, checkPolicyFile=false)`、`ID3Info`（`songName`/`artist`/`album`/
`genre`/`track`/`year`/`comment`，以及 `TXXX` 形式的其它帧）、`SampleDataEvent`/`AudioPlaybackMode` 常量类。

---

## 3. 本仓库真正需要的那一小片（demo 实测）

不看文档全集，只看**仓库里真实跑的应用**要什么：

| demo | 音频用法 | 路径 |
|---|---|---|
| `examples/Flappy-Starling`（native + web 两端都用 `--main-class FlappyStarlingMobile`） | `assets.playSound("flap"/"pass"/"crash")` → `Sound.play(0, 0, null)` | 启动时 `assets.enqueue(appDir.resolvePath("assets/sounds"))` → `AssetManager` 走 `File` 枚举 → `SoundFactory.create` → **`new Sound(); sound.loadCompressedDataFromByteArray(bytes, bytes.length)`** |
| Starling `MovieClip` 帧音效（`display/MovieClip.as`） | `frame.playSound(transform)` → `if (sound) sound.play(0, 0, transform)` | 用到了 `SoundTransform` |
| `examples/air-starling-demo` | `MovieScene` 的帧音效：`MovieClip.setFrameSound(2, wing_flap)` → `frame.playSound(transform)` → `Sound.play(0,0,transform)`；音频经 `AssetManager` 的 **`SoundFactory`** 装载 | **已启用**（2026-10-06）：`scenes/MovieScene.as:20` 已放开；**同时必须放开** `starling/assets/AssetManager.as` 的 `registerFactory(new SoundFactory())`——该行此前被注释时，`wing_flap.mp3` 会被兜底的 `ByteArrayFactory` 当**裸字节**收下，`getSound("wing_flap")` 恒为 `null`，帧音效**静默失效**（无任何报错）。定位全过程见 §13.4 |

素材实测：

| 文件 | 大小 | 形态 |
|---|---|---|
| `pass.mp3` | 5,432 B | `MPEG ADTS, layer III, v1, 128 kbps, 44.1 kHz, Monaural` |
| `flap.mp3` | 6,686 B | 同上 |
| `crash.mp3` | 7,522 B | 同上 |

三个文件合计 **19.2 KB**，时长各约 0.34~0.47 s（≈1.2 s 总计）。解码成 s16 mono PCM 约 **108 KB**——
**体积极小，不构成任何内存/体积顾虑**。

**因此最小可用面**（不放任何声音就演示不了的）是：

```
new Sound()                              // 构造
sound.loadCompressedDataFromByteArray(bytes, bytes.length)   // 同步解 MP3
sound.play(startTime, loops, transform) -> SoundChannel       // 起播
channel.stop()                                                 // 停
new SoundTransform(volume, pan)                                // 音量/声道
```

外加（可观测、Starling 会读）：`SoundChannel.position`、`Event.SOUND_COMPLETE`、`Sound.length`/`bytesTotal`。

**两个「不需要」**（避免范围蔓延）：

1. **`[Embed]` 的 mp3 不是当前 demo 的必要条件**——web 构建也用 `FlappyStarlingMobile`（走文件系统），
   不经过 `FlappyStarlingWeb` 的 `enqueue(EmbeddedAssets)`。且实测生成的 C 里
   **`EmbeddedAssets_flap = NULL`**（`[Embed]` 元数据**无任何消费者**，mp3 字节根本没嵌进去，§10）——
   那是**另一条独立的「Embed 资源」缺口**，不属于本方案。
2. `Video`、`Microphone`/`Camera`、`NetStream`/RTMP 各自是独立解码域，不在本文范围（§10）。

---

## 4. 后端选型：先说一个**会让人踩空**的实测

「仓库已经 vendored 了 SDL2（`vendor/sdl2/arm64/`），SDL2 自带 `SDL_OpenAudioDevice`，所以直接用它放音就行」
——**这条路是断的**。三重证据（均可复现）：

```
$ ar t vendor/sdl2/arm64/lib/libSDL2.a | grep -iE "coreaudio|audio"
SDL_audio.o  SDL_audiocvt.o  SDL_audiodev.o  SDL_audiotypecvt.o  SDL_dummyaudio.o
$ nm -gU vendor/sdl2/arm64/lib/libSDL2.a | grep -icE "COREAUDIO|AudioUnit|kAudioUnit"
0
$ strings vendor/sdl2/arm64/lib/libSDL2.a | grep -i coreaudio
(空)
```

即：这份 SDL2 **只编进了 `SDL_dummyaudio`（哑驱动）**，`SDL_AUDIO_DRIVER_COREAUDIO` 未定义，
`frameworks` 清单里也没有 `AudioToolbox`/`CoreAudio`。`SDL_OpenAudioDevice` 会**成功返回但永不发声**
（dummy 会照常消费队列）。**这比「没实现」更危险——它看起来一切正常。**

| 候选方案 | native | web | WASI | 新增依赖 | 评价 |
|---|---|---|---|---|---|
| **A. miniaudio**（单头文件） | ✅ Core Audio | ✅ Web Audio（Emscripten） | ❌ | 1 个头文件（+`dr_mp3.h`） | 零外部依赖、纯 C89、**一处实现覆盖 native+web**；内置 MP3/WAV/FLAC/Vorbis 解码。最贴合 §2.9「链接成熟库、不自研」 |
| **B. 各端自研 glue** | ✅ AudioToolbox `AudioQueue`（纯 C 系统框架，~150 行） | ✅ `emscripten/webaudio.h`（AudioWorklet） | ❌ | 无 | 沿用 `window_glue.cc`（native）/`web_glue.cc`（web）既有分端模式；但**要写两份**，且与 §2.9 精神相悖 |
| **C. 重编 SDL2 打开 CoreAudio** | ✅ | ✅（`-sUSE_SDL=2`，**代价见 §4.1**） | ❌ | 需引入 SDL2 **源码**构建流程 | 复用现有 SDL2 语义，但要新建 `build-tools/sdl2-src` 并替换 vendor 产物；成本最高、收益最小（native/web 具体差异见 §4.1） |

**解码器候选**：

| 候选 | 覆盖 | 说明 |
|---|---|---|
| `dr_mp3.h`（单头文件，公有领域/MIT-0） | MP3 | 同理 `minimp3.h`；两者都 ~1.7K 行纯 C，**native + wasm 通用** |
| miniaudio 内置解码 | MP3/WAV/FLAC/Vorbis | 若选方案 A，则解码器**随后端一起进来**，无需额外文件 |
| 平台解码器（AudioToolbox `AudioFile` / web `decodeAudioData`） | 各平台 | 无需 vendored 库，但**两端两份**、不可移植到 Linux/Windows/WASI，与「同一份代码同一行为」相悖 |
| 编译期解码（Node 里解成 PCM 烘焙进 `.c`） | 仅编译期已知资源 | 覆盖不了 Flappy 的**运行时读文件**路径（`loadCompressedDataFromByteArray` 拿的是运行时字节）⇒ 只能作补充，不能当主方案 |

### 4.1 A（miniaudio）与 C（重编 SDL2）在 native / web 上的具体差异

两条路都「能出声」，但**代价落在完全不同的地方**。下表均为本机实测：

| 维度 | A. miniaudio | C. 重编 SDL2 |
|---|---|---|
| **native 出声** | 编 `miniaudio.h` 即得 CoreAudio 后端，无需任何外部库 | 须从源码重建 `vendor/sdl2/arm64/`（今天只有 arm64 macOS 的**预编译产物**，`vendor/` 内无源码） |
| **native 波及面** | 新增 1 个头文件，**完全不碰窗口后端** | 重建的 SDL2 **同时服务窗口** ⇒ 改 SDL2 = 动窗口，回归面从「音频」扩到「窗口/事件/光标」 |
| **web 出声** | 用 emsdk **自带**的 `emscripten/webaudio.h`（AudioWorklet）——**在树内、离线可用** | `-sUSE_SDL=2` 会**联网下载** `SDL-release-2.24.2.zip`（本机 emsdk **未装**该 port：`cache/ports/` 只有 `zlib`） |
| **native / web 版本一致性** | 同一份 `miniaudio.h`，两端同版本 | native 已 vendored **SDL 2.32**，而 emscripten port 是 **2.24.2** ⇒ **两端 SDL 版本错配** |
| **web 侵入性** | 纯音频库，与现有自研 `web_glue.cc`（canvas + `emscripten_set_main_loop`）**零冲突** | 会把 SDL2 的 video/event/`SDL_main` 一并拉进一个**刻意不使用 SDL2** 的 web 构建 ⇒ 双窗口栈，主循环/初始化易磨擦。（此「刻意」是仓库自己的不变式：`src/air-app.ts:257-266` 的 web 分支注释明写「no SDL2/objc/Cocoa — those are native-only」，`SDL2` 只出现在 `"target":"native"` 的清单里；实测 `Starling-Demo.wasm` 里 SDL 符号数 = **0**） |
| **MP3 解码** | **内置**（dr_mp3 血统），随库而来 | **不含**，仍须另配 `dr_mp3.h`/`minimp3.h` |
| **跳平台 native** | 一份文件覆盖 macOS/Linux/Windows/WASI(null) | 现只有 macOS arm64 产物；Linux/Windows 各需重建 |
| **授权** | 公有领域 / MIT-0 | zlib（两者都无顾虑） |
| **需长期维护的东西** | 1 个头文件 | 一棵 SDL2 源码树 + 构建配方 + 版本跟踪 + 与窗口后端的耦合 |

**两者共同的点（因此不构成区分）**：都暴露 C API；音频回调都在**独立线程**上跑，故都必须遵守
「音频线程不触碰 GC 堆」的既有约束；web 上都必须等**用户手势**后 resume `AudioContext`；
WASI 两端都**无后端**（miniaudio 会落到 null 后端，等价于静音 ⇒ 必须**如实报明**，不静默假装成功）。

**唯一支持 C 的理由**：若将来打算把 **web 窗口/事件也统一到 SDL2**（放弃现有自研 canvas glue），
那重建 SDL2 顺带把音频带上才是划算的。那是比音频大得多的重构；**只为音频不值得**。

**结论：选 A（2026-10-06 已裁决）。**

**第一颗钉子已钉（2026-10-06 实测，证据台 `temp/audiomini/`）**：唯一未知数是「miniaudio 的 Emscripten 后端
在本机 emscripten 3.1.44 上能否**零额外开关**编译、并在 runtime 选中 Web Audio」——已用 30 行探针
（`ma_context_init` + `ma_device_init` + `ma_device_start` + 播 440 Hz 正弦）在**两端实测通过**：

| 端 | 编译命令（零额外开关） | runtime 后端 | 结果 |
|---|---|---|---|
| **native** | `clang -O2 -o probe-native probe.c -lpthread -framework CoreFoundation -framework CoreAudio -framework AudioToolbox` | **`Core Audio`**（4 个播放设备，默认 `MacBook Pro扬声器`） | `context_init`/`device_init`/`device_start` 全 `0 (No error)` + `PROBE_OK` |
| **web** | `emcc -O2 -o probe-wasm.html probe.c`（**零 `-s` 开关**，4.6 s） | **`Web Audio`**（1 个 `Default Playback Device`） | 同上 + `PROBE_OK` |

⇒ 两端都拿到**真实后端**（不是 null/dummy），与 §4 的 SDL2 哑驱动陷阱形成对照；miniaudio 可直接进入 A 步。
（探针产物：`temp/audiomini/probe.c` + `probe-native` + `probe-wasm.{html,js,wasm}` + 两份 stdout 存档；
miniaudio **v0.11.25**，4,108,168 B / 95,864 行。）

---

## 5. AIR 语义要点（实现时必须对齐，不能只求「能出声」）

这些是**容易「能跑但语义错」**的点，来自官方文档（`adl` 有对应行为，实现时应逐条实测）：

| 语义 | 正确行为（AIR） | 常见错法 |
|---|---|---|
| `play()` 的返回 | **每次返回一个新的 `SoundChannel`**；同一个 `Sound` 可同时多路播放 | 给每个 `Sound` 复用单一 channel ⇒ 第二路吞掉第一路 |
| `loops` | 「循环回 `startTime` 的次数」：`loops=1` ⇒ 播**两遍**；`loops=0` ⇒ 一遍 | 写成「播放次数」 |
| 声道上限 | 同时最多 **32** 个；超了 `play()` 返回 **`null`** | 无上限、或抛异常 |
| `startTime` / `position` | 毫秒；`position` 停止后**保留**最后值、循环开始时**归零** | `position` 恒 0 或单位搞成秒 |
| `SOUND_COMPLETE` | 在**播完**（循环也终止）时于 `SoundChannel` 上派发 | 永远不派；或在 `Sound` 上派 |
| `SoundTransform` | channel 级 → `SoundMixer.soundTransform` 全局**再叠一层** | 只存字段、不影响输出 |
| `loadCompressedDataFromByteArray` | **同步解码**（AIR 3）；数据不足**抛异常**；含 ID3 会派 `Event.ID3` | 异步、静默吞错 |
| `SoundMixer.stopAll()` | 停掉所有在播声道 | 缺失 |
| 无音频设备时 | `play()` 返回 `null`（官方：「没有声卡或用尽声道时返回 null」） | 崩溃或静默返回空 channel |

---

## 6. 与 AIR 对齐 / 增强的边界（§1.5 硬判据）

- **这是「补遗留」，不是「增强」**：`Sound`/`SoundChannel`/`SoundMixer` 在 AIR 里**当然存在**且能出声。
  所以**不需要** `--features` 具名开关、不需要「默认拒绝」——默认就该有声音。
- **WASI 无音频**（无 SDL/无 CoreAudio/无 Web Audio/无 miniaudio 后端）⇒ 属**平台硬边界**，
  必须**如实报明「本后端不支持音频」**（`play()` 返回 `null` 或响亮报明），**绝不静默假装成功**。
- **浏览器自动播放策略**（`AudioContext` 须在用户手势后 `resume()`）⇒ 同样是平台硬边界。
  本仓库的窗口 harness 已有合成点击能力（`temp/nwtest/`、Flappy 的驱动脚本），可据此处理；web 端需
  在首次用户手势时 `resume()`。**如实处理，不静默。**

---

## 7. 实现落点（对齐 `AGENTS.md` 分层）

| 层 | 落点 |
|---|---|
| `symbols.ts` | 补全 `Sound`/`SoundChannel`/`SoundTransform`/`SoundMixer`/`SoundLoaderContext`/`ID3Info` 的字段、getter/setter、静态、常量（替换阶段九十三的极小子集） |
| `emit.ts` | 用真实现替换 5 个 stub：对象持已解码 PCM 句柄 + 全局声道注册表；`play()` 建声道、`stop()` 摘声道 |
| `runtime.ts` | **声道表**（含 GC 追踪：在播声道是永久根，播完由帧边界回收）+ `as_audio_tick()`（每帧回收 + 派 `SOUND_COMPLETE`）+ 平台耦合隔离（如既有的 `as_now_ms`） |
| `vendor/` | **新增音频 glue**：方案 A ⇒ `vendor/miniaudio_glue.c`（`#define MINIAUDIO_IMPLEMENTATION` + `DR_MP3_IMPLEMENTATION`），对外暴露与后端无关的 `as_audio_*` C 接口；方案 B ⇒ `audio_glue.cc`(native) + `audio_glue_web.cc` |
| `build.ts` | 构建清单新增 `link-libs`/`defines`（如 `ASC_HAVE_AUDIO`）与 glue 的 `sources`；WASI 分支不编音频 glue |
| 帧循环 | 与 `as_timer_tick`/事件派发同层，在帧边界推进 |

**GC 红线**：声道对象须为 GC 追踪对象，且在播期间作为**永久根**（同 `as_async_mark_roots` 的异步 IO 目标），
否则增量标记会把在播声道回收掉。PCM 缓冲若走 arena 则程序生命周期不回收（短音效可接受），
但须在文档记明口径。

---

## 8. 分阶段计划（2026-10-06 已裁决：**A~D 全量**，立项为**阶段九十六** v0.4.66 →）

| 步 | 内容 | 验收 |
|---|---|---|
| **A** | 后端 + 解码骨架：`new Sound()`、`loadCompressedDataFromByteArray`、`play→SoundChannel`、`stop`、`SoundTransform(volume,pan)` | `examples/stage96.as`（离屏，断言对象/属性/声道计数）+ Flappy 三音效**可听** |
| **B** | 语义补齐：`startTime`/`loops`/`position`/`SOUND_COMPLETE`/`SoundMixer.stopAll()`/32 声道上限 | 断言 `loops=1` 播两遍、`position` 递增与归零、`stop` 后 `position` 保留 |
| **C** | 元数据面：`length`/`bytesTotal`/`bytesLoaded`/`id3` + `Event.ID3`/`OPEN`/`COMPLETE`/`PROGRESS`/`IO_ERROR` + `SoundLoaderContext` | 断言对 3 个 mp3 的 `length` 与 `bytesTotal`、ID3（若素材带）|
| **D** | 高级：`SoundMixer.computeSpectrum`/`Sound.extract`/`sampleData`/`loadPCMFromByteArray`/`Sound.load(URLRequest)` 流式 | 逐项离屏断言；`computeSpectrum` 填 512 个 float |

每步按 DoD 配 `examples/*.as` + 回归 + 版本号递增。**2026-10-06 用户裁决：A~D 全量**
（四步都做，分四个子阶段落地；A+B 仍是前置——只做 A 会「有声音但语义错」）。

---

## 9. 明确延后 / 限制

| 项 | 原因 |
|---|---|
| `Video` 播放 | 视频解码，独立域 |
| `Microphone` / `Camera` 采集 | 设备采集，独立域 |
| `NetStream` / RTMP | 流媒体协议栈，独立域 |
| `[Embed]` 的 mp3 / 图片 | `Embed` 元数据**整体无消费者**（`EmbeddedAssets_flap = NULL`），是另一条独立缺口 |
| SWC 里的 `DefineSound` | 实测 `temp/skin.swc` **0 个**；若遇到属独立解码域（同 `swc.md` §10 口径） |
| WASI 音频 | 平台硬边界，如实报明「本后端不支持」 |

---

## 10. 一个连带发现（值得知道，不需决定）

**`[Embed]` 元数据目前完全没有消费者。** 实测 `examples/Flappy-Starling/Flappy-Starling.c`：
`static as_class* EmbeddedAssets_flap = NULL;`——即 `[Embed(source="...mp3")]` 声明的静态常量
**恒为 NULL**，mp3 字节**未嵌入**（`grep -cE "0x49, 0x44, 0x33|0xff, 0xfb"` = 0）。
`EmbeddedAssets` 类本身被注册（39 处引用）且 `AssetManager` 会用 `describeType` 去读 `Embed` 元数据，
但编译器**从不产出该元数据**，也从不填充这些静态字段。

- 当前 Flappy 之所以能跑，是因为**两端都走 `FlappyStarlingMobile`**（`File.applicationDirectory` + `preload-paths`），
  根本没走 `enqueue(EmbeddedAssets)` 那条路。
- 一旦有人用 `FlappyStarlingWeb`（真正的 `[Embed]` 路径），**图片/字体/音效会全部是 NULL**。
- 这与音频是**两件事**，但会一起影响「Starling 资源管线」的完整性，故在此报明；是否立项由你定。

---

## 11. 待拍板项（供用户裁决）

**全部已定（2026-10-06 最终裁决）**

1. **后端 = A（miniaudio）**（评估见 §4.1）。
2. **范围 = A~D 全量**（§8）。
3. **阶段编号 = 阶段九十六**（新顶层；不重开已标 ✅ 的阶段六十三，条目里点名「补齐阶段六十三 延后的 `flash.media`」）。
4. **`[Embed]` 缺口**（§10）**独立延后**，不并入音频。

⇒ 计划已完整、已立项为 **阶段九十六**（见 `TODO.md`），待开工。

---

## 12. 附：实测方法与数据（可复现）

```bash
cd as3compiler

# 1) 现状：Sound 只到 stub，无任何后端
sed -n '6716,6728p' src/emit.ts
sed -n '1387,1450p' src/symbols.ts
grep -rniE "SDL_OpenAudioDevice|CoreAudio|AudioToolbox|webaudio|miniaudio|minimp3" src/ vendor/*.cc   # 除注释外零命中

# 2) vendored SDL2 没有 CoreAudio 后端（关键结论）
ar t vendor/sdl2/arm64/lib/libSDL2.a | grep -iE "coreaudio|audio"
nm -gU vendor/sdl2/arm64/lib/libSDL2.a | grep -icE "COREAUDIO|AudioUnit|kAudioUnit"    # 0
strings vendor/sdl2/arm64/lib/libSDL2.a | grep -i coreaudio                            # 空
grep -nE "SDL_AUDIO_DRIVER_COREAUDIO" vendor/sdl2/arm64/include/SDL2/SDL_config.h      # undef

# 3) web 后端的可用通道（emscripten 自带）
ls build-tools/emsdk/upstream/emscripten/system/include/emscripten/webaudio.h

# 4) demo 的真实用法与素材
grep -rniE "playSound|loadCompressedDataFromByteArray|SoundFactory" examples/Flappy-Starling/src/starling/assets/
file examples/Flappy-Starling/assets/sounds/*.mp3
ls -la examples/Flappy-Starling/assets/sounds/

# 5) [Embed] 无消费者（连带发现）
grep -nE "EmbeddedAssets_(flap|pass|crash) =" examples/Flappy-Starling/Flappy-Starling.c   # = NULL
grep -cE "0x49, 0x44, 0x33|0xff, 0xfb" examples/Flappy-Starling/Flappy-Starling.c          # 0

# 6) emscripten 的 SDL2 port 不在本地（-sUSE_SDL=2 需联网下载 SDL 2.24.2）
ls build-tools/emsdk/upstream/emscripten/cache/ports/                                        # 只有 zlib
ls build-tools/emsdk/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten/ | grep -i sdl  # 空
grep -nE "^TAG|fetch_project" build-tools/emsdk/upstream/emscripten/tools/ports/sdl2.py      # release-2.24.2, 从 GitHub 拉
grep -hE "define SDL_(MAJOR|MINOR)_VERSION" vendor/sdl2/arm64/include/SDL2/SDL_version.h     # 2.32 ⇒ 两端错配

# 7) 只有 native 清单链接 SDL2；web 侧是仓库刻意排除的
grep -rn '"SDL2"' examples/ --include=*.build.json          # 全部落在 "target":"native" 的清单
grep -nE "no SDL2|native-only" src/air-app.ts                 # web 分支注释：显式排除 SDL2/objc/Cocoa
strings examples/air-starling-demo/Starling-Demo.wasm | grep -icE "SDL_"   # 0 ⇒ web 产物不含 SDL2

# 8) miniaudio 探针（阶段九十六 第一颗钉子）：两端零额外开关 → 真实后端
cd temp/audiomini
curl -sSL -o miniaudio.h https://raw.githubusercontent.com/mackron/miniaudio/master/miniaudio.h
clang -O2 -o probe-native probe.c -lpthread \
  -framework CoreFoundation -framework CoreAudio -framework AudioToolbox
./probe-native                       # context backend : Core Audio；4 个播放设备；PROBE_OK
../../build-tools/emsdk/upstream/emscripten/emcc -O2 -o probe-wasm.html probe.c   # 4.6 s，零 -s 开关
python3 -m http.server 8137          # 之后开 http://127.0.0.1:8137/probe-wasm.html
#   → context backend : Web Audio；1 个 Default Playback Device；PROBE_OK
```
---

## 13. 阶段九十六实测口径（adl 51.4.1）

本节是**实现口径**表：每一行都是先在 adl 上量出来的，再照着写代码；证据是可复现的探针输出
（`temp/audioprobe/adlref/adl*.txt`，全部由 `temp/audioprobe/gen*.ts` 生成、在 AIR SDK 51.4.1 上跑出）。

### 13.1 落点

| 层 | 位置 | 职责 |
|---|---|---|
| 语义层 | `src/symbols.ts`（`Sound`/`SoundChannel`/`SoundTransform`/`SoundMixer`/`SoundLoaderContext`/`ID3Info` 的字段与方法签名、`SoundTransform.pan` 的**派生**形状） | 类型与 API 形状 |
| 生成层 | `src/emit.ts`（`Sound_*`/`SoundChannel_*`/`SoundMixer_*`/`Sound__finish`/`Sound__applyID3`） | 语义 + 生成 C，唯一接触 `as_audio_*` 的地方 |
| 接缝 | `src/runtime.ts` 的 `ASC_HAVE_AUDIO` 声明块（+ 无后端时的 no-op 桩） | 与后端解耦；**生成的 C 逐字节相同**，有无后端的区别只在链接清单 |
| 后端 | `vendor/audio_glue.c`（miniaudio，含 `MINIAUDIO_IMPLEMENTATION`，独立 TU） | CoreAudio / (web: Web Audio)；解码 + 混音 + 采集环 |
| 构建 | `src/build.ts`（`fpFlags`：`-ffp-contract=off`）、`src/air-app.ts`（`detectAudio` → 链接 glue + `ASC_HAVE_AUDIO`） | 目标/清单编排 |

### 13.2 语义对照表

| 主题 | adl 51.4.1 实测 | 我们的实现 |
|---|---|---|
| `SoundTransform` 存储 | 只存四个声道增益，`pan` 是**派生量**：`leftToRight==0 && rightToLeft==0` 时 `pan = 1 - leftToLeft²`，否则 `0` | 同形状；`pan` setter 写 `ltl=sqrt(1-p)、rtr=sqrt(1+p)、ltr=rtl=0`，**不夹取** |
| `pan` 的 1-ULP 漂移 | `new SoundTransform(0.5,0.25).pan` = `0.2500000000000001`（不是 0.25） | 逐位复现。**前提**：生成的 C 必须用 `-ffp-contract=off` 编译——`1.0 - ltl*ltl` 若被 FMA 融合会少一次舍入，得到 `0.2604` 而非 `0.2604000000000001` |
| channel 增益量化 | `play(0,0,new SoundTransform(1,0.6))` 读回 `leftToLeft=0.63` | `SoundTransform__q(v) = trunc(v*100)/100`（**向零截断**），只作用在 `play()`/`soundTransform=` 路径 |
| `soundTransform` getter | 每次返回**新对象**（`c.soundTransform == c.soundTransform` 为 false） | 由 channel 上五个增益重建 |
| `Sound.length` | **标称 MPEG 帧数**（每个帧头算 1152 样本，含 Xing/Info 帧）；切片内帧尾越界的帧头**也算** | `as_mp3_nominal_frames` 帧游走（RESYNC 逐字节找下一个合法头），切片越界帧在 break 之前 `samples += 1152` |
| `Sound.url` | `load()` 后立刻读 = `null`；**open 事件派发时已有值**（最终/绝对 URL，`file:///…`）；**失败**的 load（缺失文件/不可解码）也读到非 null，尽管此时**没有** open 事件 | `Sound_load` 记 `_snd_requrl`；OPEN 在帧预处理里派发，故 `as_net_pre_events` 先填 `_snd_url`（HTTP 用 `as_job_eff_url`，本地回退请求 URL） |
| `load()` 事件序列 | `open; progress(0/bytesTotal); progress(bytesTotal/bytesTotal); complete;`，`bytesTotal` 在 `load()` 后为 0 | 逐条对齐 |
| `isBuffering` | `load()` 后**永远**保持 true（AIR 的实现缺陷） | 照抄：complete 也不清零 |
| `close()` | 未在飞的传输抛 `Error #2029: This URLStream object does not have a stream opened.` | 同文案 |
| `Sound.load` 失败 | 缺失文件与**不可解码的负载**都派 `ioError`（`errorID = 2032`、文案 `Error #2032: Stream Error. URL: <url>`），**不派** COMPLETE；失败的 load 也**没有** OPEN，但 `url` 读回**非 null**、`bytesTotal` 保留（不可解码时 = 取回字节数） | 同（探针轮 10）：`Sound__finish` 先查 `as_job_failed`（HTTP/本地读失败）再查**解码失败**，两条路径都带 2032；`_snd_url` 在预处理的 OPEN 之前填好，失败路径也照填 |
| `Sound(stream, context)` | 构造器**自动** `load()` | `Sound_ctor` 里调 `Sound_load` |
| ID3 | ID3v2 与 ID3v1(.1) **逐字段合并，v2 胜**；缺失字段 = `null`，存在但空 = `""`；v1 genre 是**原始十进制数**（255 → `"255"`） | `as_id3_parse`（v2.3/v2.4）+ `as_id3_parse_v1` 只填 NULL 字段 |
| `id3` 事件 | 在 `loadCompressedDataFromByteArray()` **内同步**派发（探针日志 `before\|id3@after`） | 同 |
| `loadCompressedDataFromByteArray` | 从 `bytes.position` 读、读后 `position += n`；数据不足抛 `ArgumentError #2084`；解码失败抛 `#2068` | 同；`#2084` 的文案照抄（`"Error #2084: The AMF encoding of the arguments cannot exceed 40K."`） |
| `loadPCMFromByteArray` | 校验顺序：format（非 `"float"`/`"short"` → `#2005`）→ **1800 秒上限**（`#3767`，文案照抄）→ 数据不足（`#2084`）→ 注册失败（`#2068`）；position 前进 `samples × channels × (4 或 2)`；`"short"` **是**合法 format | 同顺序、同文案；`as_ba_get_u32/get_u16` 遵守 ByteArray 字节序 |
| `extract()` | 输出**恒为 44100 Hz 立体声**（"a sample contains both the left and right channels — that is, two 32-bit floating-point values"），单声道源写两遍；返回**样本(帧)数**；写到目标 ByteArray **当前位置**并前进；默认 `startPosition=-1` 表示「续上次游标」（游标在 Sound 上） | 同（`_snd_xpos`）；大端写入 `as_ba_put_u32` |
| `play()` | 无数据抛 `Error #2068: Invalid sound.`；无后端返回 `null`；每次返回新 channel；32 声道上限；`loops=1` 播两遍 | 同（`#2068` 检查在设备检查之前） |
| `stop()` / `stopAll()` | 显式 `stop()` **不**派 `SOUND_COMPLETE`、`position` 保留；`stopAll()` 也**不**派、`position` 归零 | 同 |
| peak | 按块统计：播放中 0.5029 → COMPLETE 后 0.0065；`play()` 后立即读 = 0 | 同（设备块口径） |
| `computeSpectrum` | 恒写 2048 字节（512 float32，256 左 + 256 右）；`fftMode=false` 是波形、true 是 FFT；无后端时**数组原样不动**（"outputArray is left unchanged"） | 同；设备检查放在改长度之前，故无后端时数组真的不动 |
| `SoundMixer` | `bufferTime=5`、`audioPlaybackMode="media"`、`areSoundsInaccessible()=false`（有设备时） | 同；`areSoundsInaccessible() = !as_audio_ready()` |
| `SoundLoaderContext` | `bufferTime=1000`、`checkPolicyFile=false` | 同 |
| 线程/GC 红线 | — | 混音回调只读固定声道槽 + malloc 的 PCM，**绝不碰 GC 堆**；跨线程标量用 C11 原子；采集环给 `computeSpectrum` 读；`SOUND_COMPLETE` 只在 AS3 线程的帧边界派发 |

### 13.3 复现

```bash
cd as3compiler
# 逐轮对齐（默认全部轮次；每轮重生成场景 → 编译运行我们自己 → 与 adl 参考对比）
temp/audioprobe/diffall.sh
temp/audioprobe/diffall.sh 3 8 9k2          # 挑选轮次

# adl 参考怎么来的（每轮 gen*.ts 会同时写出 AdlScene.as 与 ours.as）
temp/audioprobe/run_adl.sh adl3.txt         # 需 AIRSDK_51.4.1 + temp/skin.swc，看门狗 120s

# 后端级（不经 AS3 层）的定点验证
cd temp/audiomini && cc -O2 -o dectest dectest.c -lm && ./dectest   # 标称帧数逐文件对齐
cc -O2 -o id3test id3test.c -lm && ./id3test                        # ID3 逐字段对齐
cc -O2 -o specprobe specprobe.c ../audioprobe/sounds/bin20.mp3 -lm  # 波形/FFT 峰值
```

### 13.4 demo 帧音效「静默失效」的定位记（2026-10-06）

**现象**：`examples/air-starling-demo` 放开 `Sound` 后，`adl` 参考与 AOT 产物**都没有声音**，且控制台干净、无任何异常。

**定位**（`temp/soundprobe/DemoProbe.as`：子类化 demo 自己的 `Demo`，免手点入 `MovieScene` 后读 `SoundMixer.computeSpectrum`）：

| 探针输出 | 说明 |
|---|---|
| `getSound('wing_flap') = null`、`soundNames = []` | 音频**根本没注册**为 Sound |
| `byteArrayNames = [wing_flap;]` | 音频被**兜底工厂**当成裸 `ByteArray` 收下了 |
| `textureNames = [atlas; background; flight_00…]` | 纹理正常 ⇒ 加载链本身没问题 |
| `MovieClip frames=14 isPlaying=true frameSound2=null` | 影片剪辑在跑，只是**帧音效是 null** |

**根因**：`starling/assets/AssetManager.as` 构造器里 `registerFactory(new SoundFactory())` 被注释掉，而
`registerFactory(new ByteArrayFactory(), -100)` 是**兜底工厂**（`canHandle` 对任何 `ByteArray` 恒真、优先级 -100 排最后）。
于是 mp3 无人认领、落到兜底工厂 → 注册成 `ByteArray` 而非 Sound ⇒ `MovieScene` 的 `setFrameSound(2, null)` 静默无效。

**修复**：放开该行注册（一行）。复验：

| | adl 51.4.1 | 我方 AOT |
|---|---|---|
| `getSound('wing_flap')` | `[object Sound]` | `Sound` |
| `getSoundNames()` | `[wing_flap;]` | `len = 1` |
| `byteArrayNames` | `[]` | `[]` |
| `frameSound2` | `[object Sound]` | （同源 AS3，见下） |
| `areSoundsInaccessible()` | `false` | `false` |
| mixer `computeSpectrum` 峰值 | 0.74 → 1.46 | 0 → 0.65（**仅来自影片剪辑帧音效**，探针未直接 `playSound`） |

两侧**都实测到 mixer 有输出**，即 demo 的帧音效路径真正跑通。注：`computeSpectrum` 的峰值数值本身不可逐位对比（§14.4 的窗口相位 / FFT 整形差异）。

**AOT 侧复验入口**：`temp/demosound/`（demo `src/` 的副本 + `DemoSoundProbe.as` + 指向真 `assets/` 的符号链接）：

```bash
node src/index.ts --air-app temp/demosound/probe.xml --main-class DemoSoundProbe -o temp/demosound/Probe
cd temp/demosound && ./Probe
```

**附带结论**：`--air-app` 会因 demo 用到 `flash.media` 而**自动**把 `vendor/audio_glue.c` / `ASC_HAVE_AUDIO=1` /
`CoreAudio`+`AudioToolbox` 写进生成的 `Starling-Demo.build.json`，无需手工维护清单。

---

## 14. 与 AIR 的差异清单（阶段九十六）

**只有下表中的条目允许不同**；`diffall.sh` 的 `divergences.sed` 逐条把这些字段归一化，除此之外
任何差异都会作为残留打印出来（当前 **14 轮 PASS** 无残留）。每条都给出「adl 怎么做 / 我们怎么做 / 为什么」。

| # | 差异 | adl 侧 | 我们侧 | 处置与理由 |
|---|---|---|---|---|
| 14.1 | **类实例的隐式字符串转换**（非音频问题，探针中被放大） | `"x" + new Plain()` → 类自己的 `toString()`（`PLAIN-TOSTR`）、`[object Bare]`、`Error: boom` | 输出裸类名（`Plain`/`Bare`/`Error`）；`Error.name` 字段也缺 | **语言级既有缺口**，已登记 `TODO.md` 遗留待开发；本阶段不改（越界）。显式 `p.toString()` 两端一致 |
| 14.2 | **adl 的 PCM 搬运路径在本平台取不到样本** | `extract()`/原始样本转储**恒为 `0.000000`** | 真解码出样本 | 不复刻 adl 的坏路径（§1.5：AIR 能跑对而我们跑不出才算遗留缺陷；此处是 adl 自己读不出来）。返回字节数/游标/channel 布局/`#2084` 文案**全部一致**（round 9b/9c/9d/9k2） |
| 14.3 | **解码器预热偏移** | `extract(ts,100,20000)` 首样本 `L=0.0838623046875` | 同调用 `L=-0.1396608203649521` | 同一份 PCM、起点差**几个样本**（我们的 index 0 = ffmpeg 的 sample 0，adl 略微超前）。字节数/返回值/游标/声道数一致，属解码器级差异 |
| 14.4 | **`computeSpectrum` 的窗口相位与 FFT 整形** | 波形峰值索引随块边界跳动、幅值与我们差 **1 个 int16 LSB**（0.112762451171875 vs 0.11279296875）；FFT 是 AIR 自己的整形：20 号 bin 的音调峰值落在 **9 号/21 号 bin**，幅值 ≈ 音调幅值 × 6.49（stretch=0）/ 6.87（stretch≥1）；`stretchFactor` 只有「0 vs 非 0」可观测（`F1 ≡ F2` 逐位相同） | 波形同为**同一段采集环**，仅窗口起点不同；FFT 是标准 2048 点 Hann FFT（音调落在真实的 20 号 bin，幅值 ≈ 音调幅值归一化） | **实现文档化的标准变换并如实记录**。AIR 的 FFT 形状无法从外部反推（无 `DoABC`/无源码），且**没有任何 demo/示例用 `computeSpectrum`**（全仓 grep 只命中探针）。波形路径可定量比较（2 位小数口径，见 `divergences.sed`） |
| 14.5 | **VBR/Xing 的 MP3** | `vbr.mp3`（LAME VBR，Xing 声明 78 帧、物理 79 帧）在 adl 上**永不派发 open/complete**（120 s 看门狗内只有 `START`），即卡死 | 走**物理帧游走**：79 帧 → `2063.6734693878 ms`（ffprobe 依 Xing 得 2038.37 ms） | 不复刻卡死（卡死不是可对齐的行为）；与我们 10 个 CBR 素材在 adl 上**逐位一致**的口径保持一致。Xing 时长与物理帧数是两件事，取后者 |
| 14.6 | **`play(startTime ≥ length)`** | **卡死**（实测） | 夹取到 `frames`（首块即结束） | 同上：不复刻卡死 |
| 14.7 | **`app:/` URL 文本** | `File.applicationDirectory` 相对路径解析成 `app:/…`（文件缺失与负载不可解码两种 `Sound.load` 失败的 `ioError.text` 亦然） | 绝对路径文本；**`errorID`（2032）、`len=0`、`buffering=true`、`url` 非 null 全部一致**（轮 10） | 属 `flash.filesystem` 的 URL 文本口径（非音频），已由 §13.2 的 `url` 语义覆盖「null vs 非 null」 |
| 14.8 | **动态音频（`SampleDataEvent`）与 WASI/web 后端** | `play()` 派发 `sampleData` 让我们自己喂 PCM；`Sound` 加上 `SampleDataEvent.SAMPLE_DATA` 监听器后 `play()` 返回**真实 channel**（实测 `F dyn play=true len=0`） | 未实现 `SampleDataEvent`（录制到遗留）；WASI 无后端（`areSoundsInaccessible()=true`，`play()` 返回 `null`）；web 端当前清单**不接** glue，构建期**会警告**「this app uses flash.media, but the web build has no audio backend yet」 | 均**如实报明**，不静默假成功（§1.5）。`SampleDataEvent` 已入 `TODO.md` 遗留待开发 |
