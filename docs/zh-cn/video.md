# 视频播放（`flash.net.NetStream` / `flash.media.Video`）调研与方案

> 本文回答一个问题：**AS3 的视频播放现在处于什么状态，要让它真的出画面需要做什么、用哪个开源方案**。
> 结论先行：**目前是零支持，而且是「响亮地零支持」**——`NetStream.play()` 直接抛
> `flash.net.NetStream.play: media transport and FLV decoding are not supported by this subset`
> （`src/emit.ts:16607`），`Video.attachNetStream()` 是空函数（`src/emit.ts:16630`）。全仓没有解复用器、
> 没有视频解码器、没有视频时钟。
>
> **本文状态：V1 已落地并实测通过（2026-11-13，见 §16）；V3 硬解 + 零拷贝已接通（2026-11-14，见 §16.8/§16.9）；HDR10+/HLG 的 SDR 上色已实现但默认关（见 §16.10）；V2 与传输面未排期。**
> §1 是**实现前**的快照（2026-11-12），保留它是因为「起点是什么」决定了后面每条取舍；
> 现在的代码状态以 §16 为准：`NetStream` / `Video` / `NetConnection` 已按 AIR 语义实现，
> 解码走 FFmpeg 软解，`examples/video/` 的 31 条断言在真窗口里全绿。
> **最终方案**：FFmpeg（**最新稳定 tag，现 `n9.0.2`**）裁剪为**唯一实现**（§4），硬件解码是它的一个解码后端
> （macOS `-hwaccel videotoolbox`、Windows `-hwaccel d3d11va`），不是另一条需要另写平台代码的路线；
> **解码后端只有一个设置：`auto`**——自己探测硬解、失败自己回退软解，不给人「手选 hw」的档位（§5.3）；
> **格式面放开**：既然已经决定链接 FFmpeg，就把它的解码器/容器面铺满而不是砍小——
> 实测全格式（8.28 MB）只比「只做 H.264」（4.45 MB）贵 1.86 倍，不是 10 倍（§3）；
> **播放与推流双向**：`NetStream.publish()` 是 AIR 已定义行为，所以裁剪不是「只砍掉编码/推流」，而是
> 「解码面铺满 + 写方向只留 publish 最小集」，实测 publish 固定 +0.20 MB（§3/§6.1）；
> **是否携带 FFmpeg 由构建期按源码探测自动决定**（§5），不碰视频的产物一个字节都不变大；
> **web 不编 FFmpeg**（走 `<video>`/WebCodecs），iOS / Android 两端预留接口（§5.4/§9）。
>
> 这份文档刻意区分了三件容易混为一谈的事：
> ① **解码/编码**（H.264/AAC ↔ YUV/PCM）、② **容器与传输**（MP4/FLV/HLS/RTMP）、③ **画到屏幕上**。
> 第 ③ 件**我们已经做完了**（YUV 直通，见 [`yuv-direct-render.md`](yuv-direct-render.md)），
> 真正要补的是 ① 和 ②。

---

## 1. 现状：`NetStream` 是抛错桩，`Video` 是空壳（2026-11-12 快照）

> **这一节是历史快照。** 2026-11-13 起这两行描述已经失效：`NetStream` / `Video` 已实现，
> 解码走 FFmpeg（见 §16）。下面保留原文，是为了让「为什么必须链接 FFmpeg 而不是自研解码器」
> 这条判断有可对照的起点。

三处事实（可 `grep` 复现）：

| 位置 | 现状 |
|---|---|
| `src/emit.ts:16607` | `NetStream_play()` 当场 `as_throw(...)`，文案明说「media transport and FLV decoding are not supported」 |
| `src/emit.ts:16630` | `Video_attachNetStream()` 是 `{ (void)_this; (void)netStream; }`，不持有引用、不建纹理 |
| `src/emit.ts:16583` / `src/air-app.ts:160` | `NetConnection` 只做到「连接中报 `#2126`」，RTMP 无任何后端 |
| `src/emit.ts:16608-16619` | `pause`/`resume`/`togglePause`/`seek`/`close` 全是空函数；`time` 恒 `0.0` |
| `vendor/*.cc` | 零解复用、零解码：`grep -iE "avcodec\|avformat\|h264\|aac\|flv"` 除注释外零命中 |

**注意这与「视频帧已经在跑」不矛盾**：会议应用里的视频是 **TRTC 通过 ANE 回调**送进来的裸 YUV/NV12
（`getVideoBitmapData` → `BitmapData` → YUV 直通纹理），那条链路是**外部解码器**解好的。
本文讲的是**我们自己解码容器里的码流**——完全是另一件事。两条路最终共用同一个出口
（`BitmapData` / `SkImage` 纹理），这也是我们相对那些从零写播放器的项目唯一的成本优势（§10）。

---

## 2. AS3 侧真实 API 面

权威来源是 [AIR 3.0 语言参考](https://airsdk.dev/reference/actionscript/3.0/)。要真正「播放一段视频」，
需要的不止 `NetStream` 一个类：

| 类 | 在播放路径上的作用 | 我们的现状 |
|---|---|---|
| `NetConnection` | 建连（`connect(null)` 用于本地/HTTP，`connect("rtmp://…")` 用于 RTMP） | 桩，`#2126` |
| `NetStream` | 读：`play()` / `pause()` / `resume()` / `seek()` / `time` / `bufferTime` / `client` 回调（`onMetaData`、`onCuePoint`） | 抛错桩 |
| `NetStream` | 写：`publish()` / `attachCamera()` / `attachAudio()` / `appendBytes()`（**AIR 已定义**，不是旁路 API） | 抛错桩；构建侧已就位（§6.1） |
| `Camera` / `Microphone` | publish 的帧源（采集） | 桩：`getCamera()` 返 NULL、`names` 为空（`src/symbols.ts:2756`） |
| `Video` | 显示载体：`attachNetStream()` / `videoWidth` / `videoHeight` / `smoothing` | 空壳 |
| `VideoCodec` | `H264Avc` / `SorensonSpark` / `VP6` 常量 | 缺 |
| `NetStreamInfo` / `NetStreamPlayOptions` | 统计与切流 | 缺 |
| `StageVideo` | 硬件合成层（绕过显示列表） | 缺，见 §13 |

**`client` 回调是硬性语义**：`onMetaData` 里的 `width`/`height`/`duration`/`framerate` 决定
`Video.videoWidth/Height` 与进度条，AIR 里这是**播放器代码的第一依赖**。

**写方向也在 AIR 的定义面里**：`publish()` + `attachCamera()`/`attachAudio()` 是典型直播用法；
`appendBytes()` 则允许不接采集设备直接堆已编码数据（这是 V5 能在没有 `Camera` 后端时验收 publish 的原因）。
两条都是 AIR 已定义行为，所以 §1.5 的判据适用：我们跑不出它是遗留缺陷，不是「不支持的功能」。

---

## 3. 格式面：放开很便宜（实测），所以不砍

先算清 AIR 的基准面——这部分是**必须对齐**的，不是可选项：

| 维度 | AIR 桌面版事实 |
|---|---|
| 容器 | **FLV**（原生）、**MP4/M4A/MOV**（H.264/AAC）、MP3（纯音频）；部分平台支持 HLS |
| 视频编码 | **H.264 (AVC)**、**Sorenson Spark (H.263)**、**VP6** |
| 音频编码 | **AAC**、**MP3**、ADPCM、Nellymoser、Speex |
| 传输 | `file:` / `http:` / `rtmp:` / `rtmpt:` / `rtmps:` |
| **不支持** | HEVC、AV1、VP9、WebM、MKV、DASH |

原稿由此得出「砍小：只做 H.264+AAC+FLV/MP4 三件套」。**这个结论是错的**，它把「格式多 =
另起一套引擎」当成了前提。实测把这个前提推翻了（同一台机器、同一个 `cc -O2` 链接、`strip -x`
后量 `stat`；单位 MB = 1024 KB，复现见 §15）：

| 档 | 覆盖 | 只解码 | 含 publish（默认） |
|---|---|---|---|
| 基线（无视频） | — | **16 KB** | 16 KB |
| `air` | H.264 + AAC/MP3 + FLV/MP4/MOV | 4.25 MB | **4.45 MB** |
| `mid`（仅供对照，非发布档） | + HEVC/VP8/VP9/Opus/Vorbis/FLAC/ALAC + MKV/TS/OGG/WAV | 6.46 MB | 6.67 MB |
| **`broad`（默认，含 8 个 VT hwaccel）** | + AV1/MPEG-1/2/4/VP6/Theora/VC1/WMV3/MJPEG/ProRes + AC3/EAC3/DTS/TrueHD/WMA + AVI/ASF/RM/AIFF/CAF/IVF + RTMP/RTSP/UDP + HLS | 8.09 MB | **8.28 MB** |

「含 publish」= 保留 `NetStream.publish()` 输出方向的组件（`flv` 复用器 + H.264 硬编 + AAC 编码器 +
`rtmps`/`rtmpt` 隧道），实测固定 **+0.20 MB**（air 204 KB / mid 220 KB / broad 203 KB）。拆解（n7.1 口径）：
`flv` 复用器 +51 KB / H.264 硬编 + AAC 编码器 +170 KB / 隧道 +16 KB。**它不随格式面增长**——因为编码器列表
与解码器列表无关。

- `broad` 去掉 8 个硬解后端（同一 publish 口径）是 **8.26 MB**——**8 个硬解后端合计 19 KB**。
- **版本敏感**：同一套旗标在 n7.1 上是 3.82 / 6.03 / 7.46 / 7.68 MB，在 n9.0.2 上是上表的值
  （+0.4~0.6 MB）。体积与 tag 绑定，**换 tag 必须重量**，不能拿旧表当基线。
- 为什么默认带 publish：`NetStream.publish()` 是 AIR 已定义行为，`air` 档缺它就不是 AIR 超集而是
  AIR **子集**。配置见 §6.1，判据与采集侧的缺口见 §13。

三个结论：

1. **固定成本占大头**。门槛是 4.45 MB（含 publish），之后每加一档只多 1.6~2.2 MB。**「全格式」是
   「只做 H.264」的 1.86 倍，不是 10 倍**——解复用、码流解析、DSP 表、hwaccel 框架都是共用的一份。
2. **在 FFmpeg 上，格式面就是几行 `--enable-decoder`**。不用另写引擎、不用另找库、不用另做 fallback：
   `avcodec_find_decoder` 之后的路完全一样。所谓「适配各种格式的成本」在选定 FFmpeg 那一刻就已经付掉了。
3. **硬解几乎白送**（+19 KB）。实测 VT 覆盖 h264/hevc/mpeg1/2/4/h263/prores/vp9；D3D11VA 覆盖
   h264/hevc/mpeg2/vc1/vp9/av1/wmv3。也就是说 `broad` 里的视频编码**绝大多数都有 GPU 通路**。

**格式面的裁决（2026-11-12，用户）**：默认 `broad`，不为省 3.8 MB 砍掉 HEVC/VP9/AV1/MKV。
AOT 的价值之一是产物独立、离线可播，只能播 H.264 的产物等于把这个价值削掉一半。

关于 AGENTS.md §1.5（增强须 opt-in、默认产物保持 AIR 同构）：**格式面是能力超集，不改写任何 AIR
已定义语义**——AIR 会拒的文件变成本机能播，是「AIR 报错而我们成功」的增强方向，不会让 AIR 能跑的东西
跑错（错误号、事件顺序、边界值一律不变）。需要严格同构的产物仍可用 `video-formats: air` 单独产出（§5.3）。

---

## 4. 方案选型

### 4.1 路线的真实形状：FFmpeg 是解复用层，硬解是它的一个后端

原先的「三选一」（A 软解 / B 自写平台解码 / C 小库）漏掉了真正该比较的那一格：**同一套 FFmpeg 里
把解码器切到系统硬解**。它不是新路线，是 A 的一个开关——本机实测它就工作在 `h264` 解码器 +
`videotoolbox` hwaccel 上（§4.3）。

| | A 纯软解 | **A′ FFmpeg + hwaccel**（默认） | B 自写 VT/MF | C 小库组合 |
|---|---|---|---|---|
| 解码在哪跑 | CPU | **GPU（系统解码器）** | GPU（系统解码器） | CPU |
| 解复用 / 码流解析 | FFmpeg | **FFmpeg** | 自写或另找 | 自写 |
| 1080p 解码 CPU（实测，§4.3） | ~4.3 ms/帧 | **~1.0 ms/帧** | ~1.0 ms/帧 | 同 A |
| 帧落在 | CPU（1080p 93 MB/s 上传 @30fps） | **GPU 侧** | GPU 侧 | CPU |
| 平台解码 API 样板 | 0 | **0（FFmpeg 已写好）** | 250–400 行 ×2 | 0 |
| GPU 侧纹理桥 | 不需要 | ~30–80 行 ×2 | ~30–80 行 ×2 | 不需要 |
| 链接 FFmpeg / LGPL | 是 | **是** | 否 | 否 |
| 体积（链接后实测，§7） | 4.25 MB（+publish 4.45） | **4.45 MB（硬解 +19 KB）** | ~0.3 MB（仅平台样板） | ~1.2 MB（未实测） |
| H.264/AAC 专利 | 自己承担 | **平台方覆盖** | 平台方覆盖 | 自己承担 |
| 格式面扩张（HEVC/VP9/AV1/MKV/HLS） | 几行 configure | **几行 configure（§3/§6）** | 每个格式另写一套 | 每个格式另找库 |

**最终裁决（2026-11-11 立项，2026-11-12 定稿）**：FFmpeg 作为**唯一实现**承载解复用、码流解析、
音频解码与软件视频解码；**硬件解码通过它的 hwaccel 后端启用**（macOS `-hwaccel videotoolbox`、
Windows `-hwaccel d3d11va`），探测失败回退软解。桌面两端默认开 hwaccel，Linux 默认软解
（VAAPI/NVDEC 作为可选后端），web 走浏览器原生，WASI 响亮报错。

**这是最终形态，不是过渡路线**：不排期「以后把 FFmpeg 换掉」。视频栈就是这一套——FFmpeg 管容器、
解析、音频与软解，系统解码器管硬解；两者共用同一个 `as_video_*` seam，按端解析（§5.4）。

**唯一的真实代价是链接 FFmpeg 本身**（体积 + §8 合规），而这与「要不要硬解」无关：硬解在 A′ 里是白送的。
自写平台解码（B）只在两种情况下值得——必须去掉 LGPL 依赖，或必须把产物压进 MB 以内——那时它该是
**opt-in 构建变体**，不是默认路径（§4.2）。

### 4.2 不采纳的两条（备查）

- **B（自写 VideoToolbox / Media Foundation）**：它相对 A′ 省掉的只有「链接 FFmpeg 的 3.8–7.5 MB 与
  LGPL 义务」，代价是两套平台样板（各 250–400 行）、两套初始化顺序坑（MF 的 `MFStartup`→`MFTEnumEx`→
  `SetInputType`）、两套能力探测与回退，以及**失去格式面扩张能力**（HLS/RTMP/HEVC 都要另起一套）。
  A′ 能拿到 B 的全部收益（GPU 侧帧、专利随平台、CPU 近零）而不写这些样板。
  **不排期**：本方案没有「以后换成自写解码」的台阶；只有当 LGPL 或体积约束发生根本变化时，
  才把它当作 **opt-in 构建变体**重新评估。
- **C（小库组合）**：`minih264` 其实是**编码器**（作者原话 "Minimalistic H264/SVC **encoder**
  single header library. Decoder can be popped up in future"），不能当解码器用；
  `OpenH264` 官方能力是 **Constrained Baseline**、无多线程，且 **Cisco 只为其发布的预编译二进制
  承担 MPEG-LA 专利费，自己从源码编译则专利责任落回自己**；`h264bsd` 只支持 baseline 且停更。
  AAC 更糟：`FAAD2` 是 **GPL-2**（与我们的 MIT 不兼容），`fdk-aac` 明确**不授予专利许可**。
  结论：**小库组合在 H.264/AAC 上根本凑不齐**，这不是偏好问题。

### 4.3 硬件解码：hwaccel 能拿到什么，代价是什么（含实测）

**先纠一处事实：FFmpeg 支持硬件解码**，这不是推测。本机 macOS arm64 / ffmpeg 7.1.1 实测：

```text
$ ffmpeg -hwaccels
Hardware acceleration methods:
videotoolbox

$ ffmpeg -v verbose -hwaccel videotoolbox -i t.mp4 -f null -
Selecting decoder 'h264' because of requested hwaccel method videotoolbox
[h264] Reinit context to 1280x720, pix_fmt: videotoolbox_vld    ← 帧已是 CVPixelBuffer
```

同片源（1080p / 300 帧 / x264 high / yuv420p），三次取稳定值：

| 路径 | user CPU | 折算 |
|---|---|---|
| 软解 | 1.30 s | ~4.3 ms/帧 |
| `-hwaccel videotoolbox` | 0.30 s | ~1.0 ms/帧 |

**别把 wall clock 当结论**：带 `-f null` 时 hwaccel 反而更慢（1.2 s），因为每帧都被 `hwdownload` 抓回
CPU 内存——那是「出口接错」的开销，不是硬解的开销。真实管线必须保持帧在 GPU 侧直接进纹理。

原 §4.3 列的三条理由，两条成立、一条归属错了：

1. **零拷贝（成立，且只有 hwaccel 成立）**：软解输出在 CPU 内存，1080p NV12 = 3.11 MB/帧 × 30 fps =
   **93 MB/s**（720p 为 41 MB/s），且串行在渲染线程上。hwaccel 直接给 `CVPixelBuffer` /
   `ID3D11Texture2D`。注意这与 YUV 直通**不是**一回事：直通省的是 YUV→RGBA 的 CPU 转换（0.16 ms/帧），
   不是上传。
2. **专利归属（成立，但判据不是「用不用 FFmpeg」）**：判据是**谁在执行解码**。hwaccel 下真正的解码
   由 Apple/微软的系统解码器完成，专利随平台走；软解才落回我们自己。**所以专利压力指向「默认开
   hwaccel」，而不是「放弃 FFmpeg」。**
3. **CPU / 电量（成立）**：实测 4.3 → 1.0 ms/帧。

**不成立的那一条是「体积」**：链接 FFmpeg 就得付 3.8 MB 起（§3 实测），开不开 hwaccel 都一样——
8 个 hwaccel 合计 19 KB。这是「要不要用 FFmpeg」的选择题（§4.1 裁决：要），不是「要不要硬解」的选择题。

**A′ 也要自己写的那一笔（原账漏算）**：GPU 侧纹理桥，A′ 与 B 共担——

- macOS：`CVMetalTextureCacheCreateTextureFromImage` → `GrBackendTexture`（系统 API，约 30–50 行）
- Windows：`av_hwframe_map` 拿 `ID3D11Texture2D` + index → D3D11 `GrBackendTexture`（约 30–50 行）

这 60–100 行是唯一「A′ 也要付、而原文只算在 B 头上」的钱。

**回退比自写平台解码便宜得多**：macOS 上 FFmpeg 没有独立的 `h264_videotoolbox` 解码器（本机
`-decoders` 只有 `h264`），VT 解码走的是 `h264` + `videotoolbox` hwaccel，**软解器本来就在包里**；
Windows 的 `d3d11va` 同样复用 `h264`。所以「探测失败 → 换回软解」是一次后端切换，demux 与解析代码
一行不动。自写 VT/MF 要做同样的回退，得自己维护两套状态机。

> **实现现状（2026-11-13）**：V1 是**纯软解**——`video-backend` 只接受 `auto`/`soft`，两者等价，
> `auto` 目前没有可探测的硬解后端（V2 = macOS VT + `CVMetalTextureCache` 零拷贝，V3 = Windows D3D11VA）。
> 这不等于「4K 播不动」：软解 4K 10-bit HEVC 实测 8.8 ms/帧（单线程）、8 线程下被完全隐藏，
> 用户报的「4K 卡到不行」的真实根因是转换两次 + 单线程 + 24 Hz 帧时钟 + CPU 光栅，逐条实测与
> 修复见 §16.7。硬解在这里买到的是 `conv` 那 6 ms 与 CPU 占用，不是「能不能播」。

**真实坑（原清单保留，一条都不能省）**：High profile 不是到处能解（10-bit / 4:4:4 会失败，必须回退）；
`AVCDecoderConfigurationRecord`（SPS/PPS）解析绕不开（软解也一样要写，不是硬解独有的成本）；hwaccel 的
`get_format` 协商失败在部分驱动上是**静默回退**，必须在 `av_hwdevice_ctx_create` 与首帧 `AV_PIX_FMT_*`
上双向断言，否则表现为「以为在硬解其实在软解」（性能背锅但查不出原因）；老显卡/虚拟机会失败，必须
探测并回退，否则是黑屏。

**分水岭是格式面会不会扩张**：停在 AIR 那一小片（H.264+AAC+FLV/MP4）时 hwaccel 够用；要 HLS、多路
RTMP、或 AIR 之外的 HEVC/AV1 时，**hwaccel 并非帮不上忙**——FFmpeg 的 demux 与 hwaccel 框架本来
就支持 `mpegts`+`hls` 与 `hevc_videotoolbox`/`d3d11va`，只需打开对应的 demuxer/hwaccel 组件。真正的
代价是格式组件带来的体积增长，而不是要另写一套解码器；而这个增长实测很小（§3：`air`→`broad` 只多
3.8 MB，8 个硬解后端 19 KB），所以已裁定直接铺满。

---

## 5. 编译期按需注入（feature gate）

> 这一节是「小体积」的落点：**不碰视频的程序，产物一个字节都不变大**。

### 5.1 为什么是构建期决策，而不是「让用户自己写清单」

FFmpeg 的静态增量是 3.8–7.5 MB（实测，§3），而本项目的产物基线是 `hello.as` 那种几十 KB（AGENTS.md §2.6 用
`static` 化 + `-O2` tree-shake 把 165 KB 压到 34 KB）。无条件链进每个产物，等于把那条路白走一遍。
但反过来「视频永远手动 opt-in」也不行：用户写 `new NetStream(...)` 时不该先知道 FFmpeg 的存在。

这不是新机制——本仓已经有两个同形的门，照它们的形状做：

| 先例 | 信号（源码文本） | 注入 | 未注入时的行为 |
|---|---|---|---|
| `flash.data`（`usesFlashData`，`src/index.ts`） | `flash.data.` / `SQL*` 类名 | `vendor/sqlite_glue.c` + `vendor/sqlite/sqlite3.c` + `ASC_HAVE_SQLITE` | 打开连接时抛「SQLite backend not linked into this build」 |
| `flash.text`（`usesTextEngine`，`src/index.ts`） | `flash.text.` / `TextField` 等 | `vendor/skia_text_glue.cc` + `ASC_HAVE_TEXT` | 首次排版在 stderr 警告一次（`as_text_engine_absent`） |
| **视频（`usesVideoCodec`，本节新增）** | `NetStream` / `flash.media.Video` 等，见 §5.2 | `vendor/video_glue.c` + `ASC_HAVE_VIDEO` + FFmpeg 静态库 | `play()` 响亮报「本构建未链接视频后端」（§5.7） |

三条共用同一条不变量：**生成的 C 逐字节相同**，差别只在链接集与 define。这与
`ASC_HAVE_AUDIO` / `ASC_HAVE_CURL` / `ASC_HAVE_SQLITE` / `ASC_HAVE_TEXT` 的现行口径一致，
也是能用同一份源码给不同目标切后端的前提（§5.4）。

### 5.2 探测信号

```ts
// 不能用 `flash.media.` 作信号：Sound 也在它下面（现有 detectAudio 已经踩了这个交叉误报，
// 见 §5.6）。用视频路径上必然出现的 token，并同时接住全限定写法与裸类名。
const re = /flash\.net\.NetStream|flash\.media\.Video\b|(?:^|[^A-Za-z0-9_.$])(?:NetStream|VideoCodec|StageVideo|attachNetStream)(?![A-Za-z0-9_])/;
```

- `NetStream` 是必经入口（`Video.attachNetStream` 收的就是它），没有它就播不了；
- `VideoCodec` / `StageVideo` 只在视频路径出现；
- 裸类名一并匹配，为的是接住 `getDefinitionByName("flash.net.NetStream")` 与未 import 的
  全限定写法（与 `usesTextEngine` 同一理由）；
- **不用裸 `Video`**：太通用（用户类、`VideoEvent`），会把纯音频/纯业务程序也拖进来。

方向性取舍与两个先例一致：**过度近似**。误报的代价是「白链 3.8–7.5 MB」，漏报的代价是运行时抛错；
而误报还有 §5.3 的强制关闭开关兜底。

### 5.3 解析优先级

| 顺序 | 输入 | 结果 |
|---|---|---|
| 1 | 清单 `video: "off"` / CLI `--no-video` | **强制不注入**（体积敏感构建的逃生口） |
| 2 | 清单 `video: "on"` / CLI `--video` | **强制注入**（探测漏了也不影响） |
| 3 | 清单已显式列出 FFmpeg 的 `link-libs` 或 `ASC_HAVE_VIDEO` | 视为 `on`（手写清单向后兼容） |
| 4 | 以上皆无（默认 `auto`） | 按 §5.2 探测 |

**探测只做加法**：只往 `sources`/`defines`/`link-libs` 里补缺的项，绝不删除清单已有的项——手写清单
永远赢，与 `usesTextEngine` 那段「manifest wins when it speaks」一致。

> `video`（要不要带后端）与 `video-backend`（带哪个解码后端）是**两个正交开关**：前者是构建集，后者是
> 运行时选择。**`video-backend` 的默认且唯一推荐值是 `auto`**：探测本机能用的硬解 → 用；失败 → 同一次
> 会话内回退软解（软解器本来就链在包里，§4.3）。既然能自己回退，就不需要给人一个「手选 hw」的档位——
> 选了也只会选到 auto 会选的那个。只剩一个排障用的值：`soft`（强制降级，用来确认某个现象是不是硬解引起）。
> `video: off` 时 `video-backend` 无意义。
>
> 第三个开关是**格式面**：`video-formats: air | broad | all`，**默认 `broad`**（§3 实测：全格式只贵 1.9 倍）。
> `air` 给「必须与 AIR 严格同构 / 体积卡死」的产物，`all` 加 VVC/dav1d/DASH（未实测）。
> 三者都是「换 `--enable-decoder` 列表」，共用同一份源码与同一个 seam（§6.2）
> ——**容器不是一个需要选的维度**：`broad` 同时含 MP4/FLV/MKV/TS/HLS，首期不存在「MP4 还是 FLV」二选一。

**探测命中但本机没有 FFmpeg 预编译产物** ⇒ **构建失败**，提示跑
`vendor/provision/ffmpeg-static.sh`（§5.5），不是静默跳过：源码要用视频，产物就必须真能播（AGENTS.md §1.5）。
真要「链不上也照编」，就显式写 `video: "off"`，那时 `play()` 走 §5.7 的响亮报错。

### 5.4 多端解析（同一探测信号，七种注入结果）

| 目标 / 打包 | 探测命中后注入 | 说明 |
|---|---|---|
| macOS native | `video_glue.c` + `ASC_HAVE_VIDEO=1` + `-lavformat -lavcodec -lavutil -lswscale -lswresample` + `frameworks: VideoToolbox, CoreVideo, CoreMedia, CoreFoundation, Metal, Security`（最后一个给 `--enable-securetransport` 的 https） | hwaccel 默认开，失败回落软解（§4.3）；publish 走 `h264_videotoolbox` |
| Windows native | 同上 + `-lole32 -lmfplat -lmfuuid -ld3d11 -ldxgi` | D3D11VA 默认，DXVA2 备用；publish 走 `h264_mf` |
| Linux native | 同上（无 Apple/MS 框架）；VAAPI 可选 | 默认软解；publish 需 VAAPI，**无 render node 时 `publish()` 报错**（不静默） |
| wasm + `--package web` | 注入 `ASC_VIDEO_BROWSER=1`，**不注入 FFmpeg** | `<video>` / WebCodecs 桥；编 FFmpeg 进 wasm 是 4–8 MB 且吃满一核。publish 侧同理走浏览器（`MediaRecorder`/WebCodecs），**行为差异必须显式记录** |
| wasm（WASI，无 web 包） | **什么都不注入** | `play()` / `publish()` 均响亮报错「本后端不支持视频」，不静默降级 |
| **iOS（预留）** | 同 macOS（**同一份 `video_glue.c`**，框架清单换成 iOS 可用的那几个） | 目前无 iOS target；接口面必须先留好（§9） |
| **Android（预留）** | 同 Linux 的链接形状（无 Apple/MS 框架）+ NDK 产物 | MediaCodec 不是 hwaccel 而是逐帧 surface，纹理桥要另写；**现在不实现** |

`targets.<target>` 的**替换**语义正好承载这件事（见 `src/build.ts` 的字段注释）：顶层 `link-libs` 给
native，`targets.wasm.link-libs: []` 把 FFmpeg 摘掉——与 curl 在 web 上的处理完全一致。
**一份清单 + 一次探测覆盖七端**（含两个移动端的预留位），不需要为 web 维护第二份清单。
一次探测的**观测集**（`featureScanTexts`）与端无关，端差异全部落在「注入什么」这一步——
这也是为什么后面加 iOS/Android 不会改动探测逻辑。

### 5.5 预编译产物的落点

与 curl / sqlite / sdl2 / skia 同一形状，不把 FFmpeg 源码放进 `vendor/`：

```text
build-tools/ffmpeg-src/           # 源码（干净克隆，不在 git 里）
build-tools/ffmpeg-out/<profile>/ # 产物暂存：*.a + include/ + COPYING.LGPLv2.1
vendor/provision/ffmpeg-static.sh # ★ 构建配方（§6 的旗标），在 git 里
vendor/ffmpeg/
├── include/                      # libav*.h
├── lib/<platform>/               # libavformat.a libavcodec.a libavutil.a libswscale.a libswresample.a
└── LICENSE.LGPLv2.1              # §8 的随包义务
```

**配方入 git，源码与中间产物不入**——这是与 curl 唯一的不同。原因是那份 `--enable-*` 列表**本身就是
本文 §3/§6 的设计**（带哪些解码器、publish 留哪三件），体积表只有在配方被版本化时才可复现；curl 的配方
留在未跟踪的 `build-tools/` 里属于历史包袱，不是可以照抄的理由。

分层与 curl 相同（`vendor/provision/macos.sh:221-240` 的 `build_curl()` 是同一形状）：

| 谁 | 做什么 |
|---|---|
| `vendor/provision/ffmpeg-static.sh broad` | 跑 `configure`/`make`，量体积，装到 `build-tools/ffmpeg-out/broad/` |
| `vendor/provision/macos.sh --only video` | 校验 5 个 `.a` 与 include 树 → 拷进 `vendor/ffmpeg/{lib/macos-arm64,include}` + `LICENSE.LGPLv2.1` |
| `vendor/provision/windows.ps1 -Only video -Arch both` | 按位宽各跑一次配方（`--arch=x64|x86`），产物落 `build-tools/ffmpeg-out/broad-win-<arch>/` → `vendor/ffmpeg/lib/windows-<arch>/*.lib` |

**产物已入库（macOS + Windows）**：2026-11-12 决定把 `vendor/ffmpeg/` 整体提交（macOS arm64 的 5 个 `.a`
与 Windows 的 10 个 `.lib`，合计 ~62 MB）。代价是仓库体积，换来的是「clone 下来就能编」——不必先凑齐
MSYS2/nasm/vcvars 才能连一个视频程序。重建仍然只是一条命令：`macos.sh --only video` /
`windows.ps1 -Only video -Arch both`（后者会同时重写两位宽）。

档位用 `ASC_FFMPEG_PROFILE` 覆盖（默认 `broad`），源码位置用 `ASC_FFMPEG_SRC` 覆盖（缺省
`build-tools/ffmpeg-src`，不存在时按 `ASC_FFMPEG_TAG`（默认 `n9.0.2`）`git clone --depth 1`）。

**Windows 侧（x86 与 x64 都要）**：入口是 `windows.ps1 -Only video`（缺省不包含，因为它比另外三个包多要
两个工具）。产物名与 macOS 不同——msvc 工具链的 `LIBPREF` 为空，归档是 `avformat.lib`/`avcodec.lib`，
没有 `lib` 前缀。三条实测出的约束（配方文件头有完整出处）：

1. **必须 MSVC ABI**，与 `src/build.ts::windowsTargetTriple` 的 `--target={x86_64,i686}-pc-windows-msvc`
   一致。MinGW 编出来的 `libav*.a` 是 GNU ABI（`___chkstk_ms`、mingw CRT），链不上——失败会出现在
   应用链接期，离原因很远，所以不能“试试看”。
2. **真正的编译器是 clang-cl**：MSVC 19.43 已不认 `-o`（D9035），而 configure 每个测试都用
   `-c -o obj src`，真 `cl.exe` 会把 obj 丢到 cwd，首个链接测试就死在 `LNK1136`。但 configure 的 msvc
   版本门仍要探 `cl.exe`，所以两者都得在 PATH 上——`windows.ps1` 已经把这件事做掉了。
3. **x86 必须导入 x86 的 vcvars 环境**（`INCLUDE`/`LIB` 逐位宽），否则 `LNK4272`（x64 的 `libcmt.lib`
   撞 x86 目标）。`windows.ps1` 本来就是按位宽分层导入的，`Build-Video` 复用了这一点。

外部依赖：POSIX shell（MSYS2 或 Cygwin）+ GNU `make` + `nasm`（x86 SIMD 内核）。Git for Windows 自带的
bash 是 MSYS2 血统但**不含 make**，脚本会点名缺哪个而不是让它在 `make` 处神秘失败。
**`--arch` 不传就是两位宽都编**：配方先 x64 再 x86，每一轮自己把对应位宽的 vcvars 环境导入当前
shell（`vswhere` → `vcvarsall` → 环境快照 → `cygpath`），所以单跑一条 `ffmpeg-static.sh broad` 也能出
两套；半导入（PATH 上没 System32 而 SDK 静默缺失）会被硬拒，而不是拖到 `windows.h` 报错。
**Windows 的体积已实测**（§7 末段：探针 x64 10.6 MB / x86 9.4 MB，归档合计 20.4 / 16.9 MB）。

`checks.ts` 增一行 `vendor.video`（`kind: "warn"`，与 `vendor.audio` 同形：链接了→ok；没链但该链→
给出「glue 缺失」「本机不支持」「清单没写」三种原因之一）；`doctor.ts` 的配置摘要加一位 `video`。

### 5.6 顺手要修的交叉误报

现有 `detectAudio`（`src/air-app.ts`）用 `text.includes('flash.media')` 作信号，而 **`Video` 也在
`flash.media` 下**——只 `import flash.media.Video` 的程序会把 miniaudio 一起拉进链接集。加视频门时
应当把它收窄到音频类名（`Sound|SoundChannel|SoundMixer|SoundTransform|Microphone`），否则视频应用的
体积账会同时多算一笔音频后端。

### 5.7 未注入时的运行时语义

不注入不是「静默降级」，是**明确报缺能力**：

- `NetStream.play()` 抛 `[as3-aot] not implemented by this build: video playback requires an FFmpeg-linked build`
  （走现有的 `as_shell_unsupported()` 文案通道，`src/runtime.ts`）；
- `Video.attachNetStream()` 保持空壳（它不依赖后端）；
- `Sound` 的行为不受影响（音频门是另一件，§5.6）。

### 5.8 体积账（V0 必须实测，不估算）

| 程序 | 相对基线 | 说明 |
|---|---|---|
| `hello.as`（无 `flash.net` / `flash.media`） | **0** | 探测不命中，链接集不变 |
| 纯音频（`flash.media.Sound`） | 基线 + miniaudio，视频 **+0** | 探测刻意不命中（§5.2） |
| 纯视频（`NetStream` + `Video`），`video-formats: air` | **+4.45 MB** | H.264+AAC/MP3+FLV/MP4，**含 publish** |
| 纯视频，**默认 `broad`** | **+8.28 MB** | §6.1 全量；8 个 hwaccel 已含在内（合计 +19 KB） |
| 纯视频，`video-formats: all` | 未实测，估 +10–12 MB | 加 VVC/dav1d/DASH |
| 视频 + 动画 + 网络 | 仍只多 FFmpeg 那一份 | 与 curl/skia 无重叠 |

关键口径两条：

- **体积由 `video-formats` 决定，不由「用不用硬解」决定**。要小就写 `air`，要全就默认；不用重编方案、不用换库。
- **publish 是固定 +0.20 MB，与 `video-formats` 无关**。所以最小可用产物（要推流的小程序）就是 `air` 档 4.45 MB，
  而不是「`air` 4.07 + 推流额外一档」。

关键口径：**体积由 `video-formats` 决定，不由「用不用硬解」决定**。也就意味着这是一个产品开关——
要小就写 `air`，要全就默认；不用重编方案、不用换库。

### 5.9 钉子

- `unit: build/VideoGate`：同一段 `NetStream` 源码在 `video: off` 下**不**出现 `ASC_HAVE_VIDEO`；
  在 `auto` 下出现且伴随 `vendor/video_glue.c`；探测只加不减（清单已有项不被移除）。
- **生成 C 逐字节比较**：同一份源码在带/不带 `ASC_HAVE_VIDEO` 两种配置下产出的 `.c` 必须相同——这是
  「按需注入只动链接集」的可执行证明，与 `ASC_HAVE_AUDIO` 的现行钉子同形。
- `unit: checks/vendor-video`：预编译产物缺失时给的是「构建失败 + 修复指引」，不是静默通过。

---

## 6. FFmpeg 裁剪清单

目标：**禁用滤镜、设备、程序**，只留「解容器 + 解声画」的**读**方向，加上 `NetStream.publish()` 需要的
最小**写**方向。不砍格式（§3 已实测收窄省不下钱），只砍那些 AIR 本来就没有的东西（转码滤镜、推流服务器
能力、图像序列）。

写方向只要三件：`flv` 复用器 + 一个 H.264 编码器 + AAC 编码器，实测 **+0.20 MB**（§3）。

> **更正一处原稿措辞**：之前写「只砍编码/推流」，容易读成「RTMP 没支持」。实际 **RTMP 协议从第一版就在**
> （`--enable-protocol=…,rtmp,…`），被 `--disable-encoders --disable-muxers` 关掉的是 **publish 输出面**。
> 拉流（`play()`）一直是完整的。

### 6.1 基线配置（`broad`，实测可用）

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
  # --- publish 写方向：只有这三行 ---
  --enable-muxer=flv \
  --enable-encoder=h264_videotoolbox,aac \
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc
```

编码器按目标换（**一律硬件编码，不引 GPL/专利尚不明的软件编码器**）：

| 目标 | 编码器 | 额外旗标 |
|---|---|---|
| macOS | `h264_videotoolbox` | `--enable-videotoolbox`（已在硬解那组里） |
| Windows | `h264_mf` | `--enable-mediafoundation`（`--disable-autodetect` 下必须显式给，否则静默消失） |
| Linux | `h264_vaapi` | `--enable-vaapi`；**需可用 render node**，无 GPU 的构建机请用 `--no-publish` |

写方向**只开 H.264 + AAC**。AIR 还能推 Sorenson Spark（`H263`/`flv1`）与 Nellymoser，FFmpeg 侧这两者都是
LGPL（不是 GPL），但会拖进 mpegvideo 编码框架，体积未测，所以**未接线**（§13）。VP6 在 FFmpeg 里只有解码器，
推不了。

硬解后端（按目标追加，**软解器一律保留作回退**）：

```bash
# macOS（实测：8 个 hwaccel 全部可用，体积 +19 KB）
  --enable-videotoolbox \
  --enable-hwaccel=h264_videotoolbox,hevc_videotoolbox,mpeg4_videotoolbox,mpeg2_videotoolbox,mpeg1_videotoolbox,prores_videotoolbox,vp9_videotoolbox,h263_videotoolbox
# Windows（未实机验；组件名以 configure --list-hwaccels 为准）
  --enable-d3d11va --enable-dxva2 \
  --enable-hwaccel=h264_d3d11va,hevc_d3d11va,mpeg2_d3d11va,vc1_d3d11va,vp9_d3d11va,av1_d3d11va,wmv3_d3d11va
# Linux（可选，未验证）
  --enable-vaapi --enable-hwaccel=h264_vaapi,hevc_vaapi,vp9_vaapi,av1_vaapi
```

### 6.2 档位只是「删行」，不是另一套构建

| 档 | 与 `broad` 的差别 | 只解码 | 含 publish |
|---|---|---|---|
| `air` | 只留 `mov,flv,mp3,aac` demuxer；`h264,aac,mp3,flv,vp6f` decoder；`h264,aac,mpegaudio,flv` parser；hwaccel 自动缩到 `h264_videotoolbox` | 4.25 MB | **4.45 MB** |
| `broad`（默认） | 6.1 的全部 | 8.09 MB | **8.28 MB** |
| `all` | `broad` + VVC 解码器 + `--enable-libdav1d`（AV1 更快更小）+ `--enable-libxml2`（DASH）+ 图像序列 | 未实测，估 +2–4 MB | — |

三档共用同一个 `ffmpeg-static.sh`，只是把 decoder/demuxer 列表替换掉——体积表可随时重测。
**publish 默认开启**（三档都是），要回旧的纯解码口径加 `--no-publish`。

### 6.3 要点与坑（都是实测踩出来的）

| 项 | 说明 |
|---|---|
| **`--disable-everything` 连 hwaccel 一起关** | 只写 `--enable-videotoolbox` 不够：实测 `config_components.h` 里 `CONFIG_H264_VIDEOTOOLBOX_HWACCEL` 仍是 `0`，必须逐项 `--enable-hwaccel=…`，否则硬解静默不存在 |
| **`--enable-shared=no` 不是有效旗标** | configure 直接报 `Unknown option` 退出。默认就是静态；要显式写就用 `--disable-shared`（原稿写错，已修正） |
| TLS 后端 | `https:` 必须有 TLS 实现。macOS 用 `--enable-securetransport`、Windows 用 `--enable-schannel`，**不要**编 OpenSSL（+2–3 MB）。漏了不报错，只是 https 静默不可用 |
| `dash` demuxer | 依赖 libxml2，实测 configure 直接跳过并告警（`Disabled dash_demuxer because not all dependencies are satisfied`）。DASH 归 `all` 档 |
| `--disable-network` | **不要传**。本地播放也常用 `http:`（CDN 上的 mp4），传了会只剩 `file:` |
| RTMP | FFmpeg **自带** rtmp 协议实现，不需要 librtmp（它只是个可选后端）。`rtmp`/`rtmps`/`rtmpt` 实测均可用 |
| `rtmpe` / `rtmpte` | 需要 `ffrtmpcrypt` → GMP，**实测被关**（`CONFIG_RTMPE_PROTOCOL=0`）。Adobe 已退役 RTMPE，不补 |
| `rtmps` | 实测可用，但它骑在 TLS 后端上：Linux 无 gnutls/openssl 时静默不可用（与 `https:` 同一个坑） |
| **`--enable-encoder=X` 依赖不满足时只警告** | 组件会被静默关掉（`CONFIG_X_ENCODER 0`），结果是「构建成功但推不了流」。脚本现在 `grep config_components.h` 断言 publish 三件（`flv` 复用器 / `aac` / 平台 H.264），缺一即 `exit 3` |
| **没有 LGPL 的软件 H.264 编码器** | FFmpeg 原生不提供 H.264 编码器；`libx264` 是 GPL（传染整个产物），`libopenh264` 是 BSD 但**专利覆盖只适用于 Cisco 自家分发的二进制**。所以只上硬编，缺则明确报错 |
| `h264_mf` | Windows 的 MediaFoundation 编码器。`--disable-autodetect` 下必须显式 `--enable-mediafoundation`，否则依赖判定失败、组件静默消失 |
| `--disable-encoders` 之后仍可 `--enable-encoder=` | configure 按出现顺序处理，**后写的赢**；脚本正是靠这个只开最小集，不用另写一份配置 |
| `h264` 解码器 | 硬解路径是 **`h264` 解码器 + `videotoolbox` hwaccel**，**不存在** `h264_videotoolbox` **解码器**（那是编码器名，别照拄 `-c:v h264_videotoolbox`） |
| `aac` vs `aac_fixed` | 浮点版质量好、定点版省电；miniaudio 的混音管线是 f32，用浮点版可少一次转换 |
| `--disable-avfilter` | 不需要滤镜；缩放由 `swscale` 直接做（YUV420P → NV12 或直通给 Skia） |
| `bsf=*_mp4toannexb` | **走硬解时必需**（VT / D3D11VA 都吃 Annex B 起始码），只保留软解的构建才可以去掉 |
| `--disable-autodetect` | 不自动抓系统库（zlib、iconv、sdl…），保证产物可复现 |
| 版本 | **取最新稳定 tag**（当前 `n9.0.2`），不跟 master。**体积与 tag 绑定**：同一套旗标 n7.1 → n9.0.2 涨 0.4~0.6 MB，换 tag 必须重量 |
| **`--disable-postproc` 在 n8+ 已不存在** | libpostproc 被移除，旧版本脚本会直接 `Unknown option` 退出。`ffmpeg-static.sh` 现在用 `--help` 探测该旗标是否存在（`--disable-everything` 本来就已经关掉这个库） |
| **accel 旗标在 n9 改了拼法** | n7 的 help 只列 `--enable-videotoolbox`，n9 只列 `--disable-videotoolbox`。但 `--enable-X` 在两边都能用，而且**必须显式给**：实测 `--disable-autodetect` 会让 `CONFIG_VIDEOTOOLBOX` 停在 `0`，必须靠 `--enable-videotoolbox` 把它拉回 `1`。**以 `--help` 为准写条件分支会踩空** |
| GPL | 构建脚本里**禁止** `--enable-gpl` / `--enable-nonfree`（会拉进 x264/x265/libfdk，且违反 §8） |

**构建落点**：按 AGENTS.md §2.9，FFmpeg 是**链接进来的库**，不是塞进生成的 `.c`。
清单里走 `link-libs` / `include-paths`，产物仍是「可读的 C + 第三方静态库」。
**用户一般不需要手写这些字段**：探测命中后由 §5 自动补齐；手写清单只是给需要绕开探测的构建留的口子。

---

## 7. 体积与性能（实测，macOS arm64 / FFmpeg n9.0.2 / `cc -O2`）

| 项 | 实测 | 备注 |
|---|---|---|
| 无视频基线 | **16 KB** | 空 `main`，作对照 |
| `air` 档（只做 H.264+AAC/MP3+FLV/MP4） | **4.25 MB** | 原稿估的「1.5–3 MB」**偏低**，以实测为准 |
| `air` + publish | **4.45 MB** | +204 KB：`flv` 复用器 51 / 编码器 170 / 隧道 16（n7.1 拆解） |
| `mid` 档（对照） | **6.46 MB** | 非发布档，只用来量「每加一档多贵」 |
| `mid` + publish | **6.67 MB** | +220 KB |
| **`broad` 档（默认，含 8 个 hwaccel）** | **8.09 MB** | §6.1 的完整配置 |
| **`broad` + publish（实际默认产物）** | **8.28 MB** | +203 KB |
| `broad` + publish 但去掉 hwaccel | **8.26 MB** | 8 个硬件后端合计 **19 KB** |
| 软解 H.264 1080p | **4.3 ms/帧**（300 帧 1.30 s user） | 系统 ffmpeg 7.1.1（homebrew），同片源 |
| 硬解 H.264 1080p（VT） | **1.0 ms/帧**（300 帧 0.30 s user） | 同一二进制的 A/B，3.4× CPU 降幅；**不看 wall clock**（`-f null` 每帧 `hwdownload`） |
| 解码帧 → 纹理 | 软解（CPU 平面，§10.1 ②）YUV 直通 **0.16 ms/帧 @720p**；硬解（§10.1 ③）无上传，只余一次包裹开销 | 见 `yuv-direct-render.md` §8.4。硬解这一档的数字 **V2 才实测**——不能拿 0.16 ms 当硬解值 |
| 首帧延迟 | 目标 **< 100 ms**（本地文件） | VT/D3D11 设备创建有首帧开销，**未测** |

口径说明（重要，避免把数字用错）：

- 体积是**一个 `cc` 链接出的探针程序**的 `stat` 大小，`strip -x` 后；未开 LTO、未用 `-Os`（后者能再降，未测）。
- 探针形状**同时覆盖读与写两个方向**（`avformat_open_input` + `avcodec_find_decoder` + `sws_getContext`
  + `swr_alloc`，加 publish 侧的 `avformat_alloc_output_context2("flv")` + `avcodec_find_encoder(H264/AAC)`
  + `avformat_write_header`）。静态库只拉被引用的对象，**形状不固定两张表就量的不是同一件事**——
  所以「只解码」与「含 publish」两列是同一探针下的两个配置，可直接相减。
- **没有意外 tree-shake**：FFmpeg 通过静态 codec 表注册，**启用的解码器都会被链接进来**——
  所以 `--enable-decoder` 列表就是体积表，可预测。
- **版本会改变这些数字**：n7.1 → n9.0.2 同一套旗标涨了 0.38 / 0.41 / 0.60 MB（air/mid/broad）。
  n9 的 `videotoolbox` 系 hwaccel 多了一个 `prores_raw`，解复用与 DSP 也变大了。**换 tag 必须重量。**

**要重测就重跑 §15 的脚本**：三档配置共用一份源，换 `--enable-*` 列表即可；数字变了就改回本节。

**Windows（MSVC ABI，同一探针、同一 `broad`+publish 档位）**：探针 x64 **10.6 MB** / x86 **9.4 MB**；
五个归档合计 x64 **20.4 MB** / x86 **16.9 MB**。比 macOS arm64 大 2 MB 左右：MSVC 目标把自己的 CRT/SEH
带进来，且 Windows 侧硬解是 **14 个**（7 个编解码器 × d3d11va/dxva2）。这里的 `linked` 与 `stripped`
两列**相同**——PE 上没有 `strip -x` 那种收益（本来就没带调试信息），不是没跑 `llvm-strip`。
**按需注入时的分程序体积账见 §5.8**。

---

## 8. LGPL 合规动作（硬性，不做的风险比体积更大）

FFmpeg 不带 `--enable-gpl` 时是 **LGPL-2.1-or-later**。我们的项目是 **MIT**，静态链接 LGPL 库
在分发给第三方时触发 LGPL-2.1 §7（"Combined Work"）的义务：

| 必须做 | 具体做法 |
|---|---|
| ① 不启用 GPL 组件 | 构建脚本里**禁止**出现 `--enable-gpl` / `--enable-nonfree`（会拉进 x264/x265/faac/libfdk 等） |
| ② 保留声明与版本 | 产物内可查 FFmpeg 版本（`av_version_info()`），`--version` 或关于页显示「Powered by FFmpeg (LGPL-2.1+)」 |
| ③ 满足「可重新链接」 | 我们交付的是**生成的 C 源码 + 构建清单 + 公开仓库**，用户可自行替换 FFmpeg 版本并重编——这正是 §7 要的「重新链接的能力」。**但如果将来做纯二进制商业分发，必须额外随包提供 FFmpeg 的 `.a`/目标文件，或改动态链接** |
| ④ 附许可证全文 | 分发产物附带 FFmpeg `COPYING.LGPLv2.1` 与源码获取地址 |
| ⑤ 不静态链接 GPL 解码器 | `FAAD2`（GPL-2）、`x264`（GPL-2）**一律不用**，即使用户要求 AAC 也不换 |

> **必须如实记录的一件事实：LGPL 不授予专利许可。** 但**专利归属的判据是「谁在执行解码」，不是
> 「有没有用 FFmpeg」**：走 hwaccel 时解码由系统解码器完成，这笔风险随平台走（§4.3）；只有**软解回落
> 路径**才落回我们自己。因此 §4 的裁决（默认开 hwaccel）同时也是专利侧的最优解。

格式铺开后，风险不是均匀的——按专利状态分三堆（工程判断，正式法务仍需过一遍）：

| 档 | 编码 | 结论 |
|---|---|---|
| **免版税** | VP8、VP9、AV1（AOMedia）、Theora、FLAC、Opus、Vorbis，以及所有 PCM | 软解也放心用，无池 |
| **已过期 / 基本过期** | MPEG-1、MPEG-2 Video、MPEG-4 Part 2（DivX/Xvid）、H.263、AC-3 | 老素材支持，风险低 |
| **需评估** | **H.264**（残余许可义务）、**HEVC**（Access Advance / Via LA / MPEG LA 三池重叠，是最贵的一个）、DTS（`dca`）、TrueHD | **默认走硬解；硬解不可用时降级软解**（2026-11-12 裁定）。这意味着这三项的许可风险**由我们自己承担**，不在平台身上 |
| **无法定论** | VC-1 / WMV3（Microsoft，遗留格式） | 保留解码器，不主动宣传 |

具体到我们的默认：`broad` 里最重的一堆（HEVC/DTS/TrueHD）恰好都有硬件通路，**但硬解缺失时仍然降级软解**
（裁定见 §14 第 4/6 条）——「能播」优先于「零许可暴露」，因为 AIR 本来也是纯软件解码，报错会低于 AIR。
真要收缩风险，把 `video-formats` 降到 `air`（不含 HEVC/DTS/TrueHD）即可，不需要改代码。

---

## 9. 多端矩阵

| 端 | 解复用 | 解码 | 编码（publish） | 输出 | 备注 |
|---|---|---|---|---|---|
| macOS arm64 | FFmpeg | **VideoToolbox（默认）**：h264、hevc、mpeg1/2/4、h263、prores、vp9；其余软解回退 | `h264_videotoolbox` + `aac`（系统硬编） | `CVPixelBuffer`（NV12）→ `CVMetalTextureCache` 按 plane 给两张 `MTLTexture` → `GrBackendTexture[2]` → **`SkImages::TextureFromYUVATextures`**（零拷贝，§10.2） | arm64 软解走 NEON，无需额外汇编依赖 |
| Windows x64 | FFmpeg | **D3D11VA（默认）**：h264、hevc、mpeg2、vc1、vp9、av1、wmv3；其余软解回退（DXVA2 留老系统） | `h264_mf` + `aac`（MediaFoundation，**未实机验证**） | `ID3D11Texture2D`（`DXGI_FORMAT_NV12`，Y/UV 是**同一资源的两个 plane slice**）→ 拆成 R8/RG8 两张 → `GrBackendTexture[2]` → **`TextureFromYUVATextures`**（§10.3 的平面切片差异） | 软解 SIMD 需 nasm/yasm（见 `checks.ts`） |
| Linux | FFmpeg | 软解；VAAPI 可选（h264/hevc/vp9/av1，**未验证**） | `h264_vaapi`（**需 GPU**；无软编兜底 → 缺 render node 时 `publish()` 报错） | 软解：`AV_PIX_FMT_YUV420P` → **`TextureFromYUVAPixmaps`**（每帧上传，§10.1 ②）；VAAPI：`AV_PIX_FMT_VAAPI` → `EGLImage` → 纹理（与 Android 同形，未验证） | 有 ELF 目标即能编 |
| Web（`--target wasm --package web`） | 浏览器 | **浏览器原生**（`<video>` / WebCodecs） | 浏览器（`MediaRecorder` / WebCodecs）；需 `NetStream.appendBytes` 才能自己产码流 | canvas → WebGL/WebGPU | **不把 FFmpeg 编进 wasm** |
| WASI（`--target wasm`） | 无 | 无 | 无 | — | **响亮报错**「本后端不支持视频」，不静默降级 |
| **iOS（预留，未支持 target）** | FFmpeg | **VideoToolbox**（与 macOS 同源，同一套 `videotoolbox` hwaccel） | `h264_videotoolbox` + `aac` | 同 macOS：`CVPixelBuffer` → 两张 `MTLTexture` → `TextureFromYUVATextures`（§10.2） | **与 macOS 共用一份 glue**，差别只在设备/权限。AOT 上 iOS 本来禁不了（不能下发可执行码），这条路径只在「编译期已固定」的形态下成立 |
| **Android（预留，未支持 target）** | FFmpeg | **MediaCodec**（FFmpeg 侧只有编解码器包装，**没有统一的 hwaccel 框架**）；其余软解回退 | `h264_mediacodec`（未验证） | `AHardwareBuffer` → `EGLImage` → GL/`GrBackendTexture` → `TextureFromYUVATextures` | 需 NDK 编译；**这一端是唯一需要单独写硬件桥的**，不能假定与桌面同形 |

> **移动端是「未来要算进去的第六/七端」**（用户 2026-11-12 裁定）：现在**不实现**，但**接口面别写死**。
> 具体代价：iOS 几乎白送（VT 与 macOS 同一套后端，只多一层权限/生命周期），Android 最难（MediaCodec
> 不是 hwaccel 而是逐帧 surface，纹理桥要另写）——所以 `as_video_*` 的 `backend` 参数必须够抽象，
> 不能把「hwaccel 上下文」当成所有后端的公共形状。

**格式面在多端并不对称**（必须显式记录，不能声称「三端一致」）：

| 格式 | macOS | Windows | Web |
|---|---|---|---|
| MP4/FLV/HLS + H.264/AAC/MP3 | ✅ | ✅ | ✅（浏览器均支持） |
| MKV/TS/AVI/ASF/RM 容器 | ✅ | ✅ | ⚠️ `<video>` 只认 MP4/WebM；要全格式得走 JS 解复用（不做） |
| HEVC | ✅ hw | ✅ hw | ⚠️ Safari / Chrome 部分平台硬解，Firefox 不支持 |
| VP9 / AV1 | ✅（VP9 可 hw，AV1 软解） | ✅ hw | ✅ |
| DTS / TrueHD / WMA | ✅ 软解 | ✅ 软解 | ❌ 浏览器无对应 |

这也是：**native 桌面两端是「全格式」，web 是「浏览器愿意给的子集」**。这是 web 平台的硬边界（同
§1.5），如实写明，不假装同构。需要 web 也能全格式，只有「把 FFmpeg 编成 wasm」一条路，
代价是 4–8 MB + 吃满一核——已裁定不做。

**Web 端的特殊处理（重要）**：把 FFmpeg 编成 wasm 会让产物从几百 KB 涨到 **4–8 MB** 且 720p 解码吃满
一个核。浏览器本来就有 `<video>` 与 `WebCodecs`——**默认走它们**，FFmpeg 只在 native 目标编。
这正好用上构建清单的 `targets.<target>` 分层语义（**替换**而非追加）：native 清单带 FFmpeg 的
`link-libs`，web 清单不带。具体注入规则见 §5.4。

---

## 10. 与已有资产的衔接（我们真正的成本优势）

| 已有资产 | 视频播放怎么用 |
|---|---|
| **YUV 直通**（`yuv-direct-render.md`，四端 Skia 都有 `TextureFromYUVAPixmaps`） | **软解路**：FFmpeg 输出 `YUV420P` 走 `SkImages::TextureFromYUVAPixmaps`——省掉 CPU 色彩转换（720p 0.16 ms/帧），但仍**每帧上传三张平面、每帧新建纹理对象**（§10.1 ②）。**硬解路不能复用它**：帧已在 GPU 侧，必须换 `SkImages::TextureFromYUVATextures`（§10.2），换成 Pixmaps 就是白拷一次全帧。两档的差别不是格式，是**帧当前在哪块内存** |
| `BitmapData` 像素契约（内部 `0xAARRGGBB`） | 需要像素级访问时走「解码 → YUV → 按需物化」，不默认物化 |
| `vendor/audio_glue.c`（miniaudio） | **音频侧已能解 MP3/FLAC/WAV/Vorbis**；AAC 由 FFmpeg 解成 PCM 后直接喂 miniaudio 的 f32 混音管线，不需要另写音频设备层 |
| ANE 视频帧链（`getVideoBitmapData`） | 文件播放与 RTC 帧共用同一个「上传纹理」出口，只有上游不同 |
| 异步 job 表（`as_job_*`，阶段八十九·四十五） | 解复用/解码应挂在同一套后台任务上，不阻塞帧边界；解码器上下文是**长生命周期对象**，不能每帧重建 |

### 10.1 帧的三档形态与三个 Skia 入口

「解码之后怎么上屏」不是一种做法，而是**三个不同入口**，选错不会报错，只会白拷一帧：

| 档 | 帧在哪 | Skia 入口 | 代价 | 现状 |
|---|---|---|---|---|
| ① **CPU ARGB** | `BitmapData.pixels`（`setPixels` 写入） | `SkImages::RasterFromPixmapCopy`（`vendor/skia_glue.cc:1413`） | **CPU 堆分配 + 整帧拷贝**成 raster SkImage，绘制时再上传 | 已实现；**不是视频路径**，是像素物化出口 |
| ② **CPU YUV 平面** | `setYuv420` 的 I420 缓冲 | `SkImages::TextureFromYUVAPixmaps`（`vendor/skia_glue.cc:1424`，`SkImageGanesh.h:233`） | 省掉 CPU 色彩转换，但 Skia **每帧上传 Y/U/V 三张纹理并新建纹理对象**（无「更新已有 YUV 纹理」的公开 API） | 已实现（E20，`--features yuv420`） |
| ③ **GPU YUV 平面** | hwaccel 的 `CVPixelBuffer` / `ID3D11Texture2D` / `AV_PIX_FMT_VAAPI` | `SkImages::TextureFromYUVATextures`（`SkImageGanesh.h:256`） | **零拷贝**：纹理已是 GPU 资源，Skia 只包一层 + shader 采样；配合 `releaseProc` 还能复用同一块纹理 | 未实现（V2） |

**硬规则：视频帧永远不经过 ①。** `BitmapData`/`pixels` 是 AS3 的像素契约，只有 `getPixels`/`draw`/逐像素读才物化。
播放路径一旦落到 ①，一帧要走「解码 → CPU 转 ARGB → 写 `pixels` → CPU 拷贝成 raster → 再上传」四次搬运。
现有 `setYuv420`（②）已经砍掉前两次，硬解（③）再砍掉后两次。

**判据是「帧现在在哪块内存」，不是「什么像素格式」。** 同样是 NV12/I420：在 CPU 侧走 ②，在 GPU 侧走 ③。
两个入口都在 `SkImageGanesh.h` 里相隔二十余行，混用只表现为「硬解开了但 CPU 还是高」——最容易被当成「硬解没生效」。

`GrYUVABackendTextures` 的形状（`include/gpu/GrYUVABackendTextures.h:91`）是 `SkYUVAInfo` + `GrBackendTexture[3]`，
而 `PlaneConfig::kY_UV` + `Subsampling::k420` 正是 NV12（`include/core/SkYUVAInfo.h:52`）——videotoolbox 与 d3d11va 的原生输出。
符号可用性已核实：`libskia.a`（macos-arm64 / wasm）里 `TextureFromYUVATextures` 的两个重载都在。

### 10.2 硬解零拷贝：调用链、生命周期与帧池

macOS / iOS（一份 glue 两端共用）：

```
AVFrame(AV_PIX_FMT_VIDEOTOOLBOX)  --av_hwframe_map-->  CVPixelBuffer (NV12)
  → CVMetalTextureCacheCreateTextureFromImage(plane 0)  → MTLTexture (R8Unorm)
  → CVMetalTextureCacheCreateTextureFromImage(plane 1)  → MTLTexture (RG8Unorm)
  → GrBackendTexture(w, h, mipmapped, GrMtlTextureInfo{tex})        // include/gpu/GrBackendSurface.h:181
  → GrYUVABackendTextures(SkYUVAInfo{w, h, kY_UV, k420, cs}, tex[2], origin)
  → SkImages::TextureFromYUVATextures(ctx, yuva, imageColorSpace, releaseProc, releaseCtx)
  → SkImage  → Canvas.drawImageRect
```

**生命周期闭环（最容易出花屏的一处）**：`TextureFromYUVATextures` **不复制纹理**，SkImage 存活期间那两张
`MTLTexture` 必须有效，而其底层是 `CVPixelBuffer` 与 `CVMetalTexture` 包装。三者都要活到 `releaseProc`，
在其中按创建顺序逆序释放；对应地，`av_frame_unref` / `av_frame_free` **只在 `releaseProc` 之后**才允许。
常见错法是解完帧立刻 `av_frame_unref`，GPU 还在读 → 花屏或黑帧，且不报错。

**帧池**：VT 的解码 surface 是池化的（通常 4–8 张），SkImage 持有纹理就等于占住一张。所以 `Video`
的契约必须是「**每帧画完就放 SkImage**」：

- 不要为了「复用」把上一帧 SkImage 留在字段里当当前帧再画一次——那会同时占两张，池子小的时候直接卡住；
- `pause()` 要留静止帧，此时 SkImage 仍绑着 CVPixelBuffer ⇒ 池少一张。要么接受少一张，要么把最后一帧
  **拷进一张自有纹理**（一次 GPU blit）再让 VT 回收；后者更稳，`pause()` 长驻时应该走它；
- `avcodec_receive_frame` 返回 `EAGAIN` 时不能假设「等一会就有」——池耗尽的表现就是阻塞或丢帧，
  需要「显示端已释放」的回执才能继续喂。

### 10.3 色彩空间与平台差异

**色彩空间必须跟着码流走，不能硬编码。** 现有 `setYuv420` 固定 `kRec601_Limited` 是 ANE 帧的口径，
文件播放的来源是 `AVFrame.colorspace` / `AVFrame.color_range`，映射到 Skia 枚举（`include/core/SkImageInfo.h:68`）：

| `AVFrame` | `SkYUVColorSpace` |
|---|---|
| `AVCOL_SPC_SMPTE170M` / `BT470BG` + `AVCOL_RANGE_MPEG` | `kRec601_Limited` |
| `AVCOL_SPC_BT709` + `AVCOL_RANGE_MPEG` | `kRec709_Limited` |
| `AVCOL_SPC_BT2020_NCL` + `AVCOL_RANGE_MPEG` | `kBT2020_8bit_Limited`（10-bit 源走 `kBT2020_10bit_*`） |
| 任意矩阵 + `AVCOL_RANGE_JPEG` | 对应的 `*_Full` |

这条路不上色彩管理：HDR（PQ/HLG）当前**明确不支持**（§13），BD 素材会把 HLG 当 SDR 画得发灰。

**平台差异（§9 表格里三端写成同形是不成立的）**：

| 平台 | 硬解输出 | 到 `GrBackendTexture` 的差异 |
|---|---|---|
| macOS / iOS | `CVPixelBuffer`（`420YpCbCr8BiPlanarVideoRange` = NV12） | `CVMetalTextureCache` **按 plane 各给一张纹理**，直接可用，最省 |
| Windows | `ID3D11Texture2D`（`DXGI_FORMAT_NV12`） | Y/UV 是**同一资源的两个 plane slice**；`GrBackendTexture` 接的是整张 2D 纹理，**不接 plane slice**。要么用 D3D11.1 的 `Texture2DArray` + plane slice 建两个 SRV，要么先在 GPU 内拆成 R8/RG8（**仍在 GPU 侧，禁止回 CPU**） |
| Linux VAAPI | `AV_PIX_FMT_VAAPI`（DRM_PRIME） | `EGLImage` → GL 纹理，与 Android 同形；`av_hwframe_map(AV_HWFRAME_MAP_READ)` 失败才是软解回退的信号 |
| Android（预留） | `AHardwareBuffer` | `EGLImage` → GL 纹理；MediaCodec 是逐帧 surface，生命周期归 codec，不归 SkImage |

这就是 §9 末尾「`backend` 参数必须够抽象」的具体含义：**`frame_to_image` 必须是后端私有实现**，
不能有一个公共的「两个指针 + 一个 stride」签名——那只能表达 ②（CPU 平面），表达不了 ③ 的三种形状。

---

## 11. 实现落点（对齐 AGENTS.md 分层）

| 层 | 落点 | 禁止 |
|---|---|---|
| C 胶水 | `vendor/video_glue.c`（新）：`as_video_open/read_frame/decode/close`，封装 `AVFormatContext`/`AVCodecContext`，带 `backend`（`auto`/`soft`）与 `formats`（`air`/`broad`/`all`）两个参数；`auto` 内部自己做探测 + 回退 | 在里面做 AS3 语义（`NetStream` 状态机归 codegen）；在胶水里写平台窗口/设备 glue |
| C 胶水（帧出口） | `as_video_frame_to_image(AVFrame*) -> SkImage*`（同类内）：按帧所在（CPU / GPU）选 §10.1 的 ② 或 ③ 入口；色彩空间从 `AVFrame.colorspace`/`color_range` 读（§10.3）；`releaseProc` 负责帧池回执（§10.2）。`Video` 只吃 `SkImage*` | 把 `AVFrame`/`CVPixelBuffer` 泄进 codegen；在 `emit.ts` 里判断像素格式或平台 |
| 运行时 | `src/runtime.ts` 的 `as_video_*` 声明 + no-op 桩（无 FFmpeg 的构建要响亮失败，不是静默返回空帧） | 生成 C 里出现 `avformat.h` |
| AS3 语义 | `src/emit.ts` 的 `NetStream`/`Video` 类：`play/pause/seek/time/client` 回调、`#2126` 等错误号 | 把解码逻辑写进 `emit.ts` |
| 构建 | `src/build.ts` 清单字段（`link-libs`/`include-paths`/`sources`）+ `checks.ts` 增一行「FFmpeg 头/库存在性」 | 在 CLI 分支另写一套检查 |

**错误语义**：`play()` 打不开 → `IOErrorEvent`；容器/编码不支持 → `NetStream.Play.Failed`
（与 AIR 文案对齐，需 `adl` 实测取文案）；**绝不允许「能编译、能跑、黑屏」**。

---

## 12. 分阶段计划（未排期）

| 阶段 | 内容 | 验收 |
|---|---|---|
| V0 | **本文落定 + 裁剪实测**：`air`/`mid`/`broad` 各编一份、各量一次链接体积；VT 硬解的边际代价；软/硬解 1080p 吞吐 | **已完成 2026-11-12**：数字入 §3/§7；`vendor/provision/ffmpeg-static.sh`（入 git）可复现 |
| V1 | **解码 seam + 软解 + 按需注入门 + 三档格式面**：`as_video_*` 带 `backend`+`formats`；落地 `usesVideoCodec` / `video` / `video-formats`；容器 `mov,flv,matroska,mpegts,mp3,aac,ogg,wav`，视频 `h264,hevc,vp9,av1` 软解，音频 `aac,mp3,opus,vorbis,flac`；`onMetaData` + 音频出声 | `examples/video.as` 能播自带样片；与 `adl` 逐项对齐（`videoWidth/Height`、`time`、`onMetaData`）；**格式矩阵自测**：每个容器×编码至少一个样本能出声出画；不碰视频的示例体积不变（§5.8）  **已完成 2026-11-13**（实现现状、实测数字与复现方法见 §16；4K 素材的代价拆分见 §16.7） |
| V2 | **macOS 硬解 + 零拷贝上屏**：`videotoolbox` 后端覆盖 8 个 hwaccel（h264/hevc/mpeg1/2/4/h263/prores/vp9）+ `CVMetalTextureCache` 纹理桥 → `SkImages::TextureFromYUVATextures`（§10.2）；探测失败静默回退软解 | 同片源 A/B：user CPU、墙钟、纹理桥耗时；人为禁掉 VT 必须静默回退而非黑屏；HEVC 1080p 软/硬双跑对比；**零拷贝举证**：把 `TextureFromYUVATextures` 临时换成 `TextureFromYUVAPixmaps`，user CPU 与墙钟必须出现可测差异（拿不出差异 = 零拷贝没真做到）；暂停 30 s 后恢复不得因帧池耗尽卡住（§10.2） |
| V3 | **Windows D3D11VA 后端 + 零拷贝上屏 + 自适应默认**（7 个 hwaccel）+ 缓冲状态（`Buffer.Empty`/`Buffer.Flush`）—— 解码、零拷贝与自适应默认均已完成（§16.8、§16.9）；另加一份 opt-in 的 HDR→SDR 上色（§16.10）；`pause`/`seek` 与 `NetStream.Play.*` 的序列在 V1 已就位（§16.2） | 逐项对齐 `adl`；三端同一份 `.as` 行为一致（后端差异只允许在像素格式内部） |
| V4 | 传输（**读**）：`http:` 渐进式 → **HLS**（`hls`+`mpegts`+`crypto`，已包含在 `broad` 档）→ RTMP/RTSP（FFmpeg 原生协议，**不引 librtmp**） | 对齐 AIR 的 `NetStream.Play.*`；HLS 直播切片延迟与追帧策略写成可复现测试 |
| V5 | **publish 输出面（写）**：`NetStream.publish()` + `appendBytes()`（AIR 原生 API，可绕过采集设备直接堆已编码数据）+ `flv` 封装 + 硬编 H.264/AAC + `rtmp`/`rtmps` 推流；构建侧已在 V0 付完（§6.1） | 用 `ffmpeg -listen 1 -i rtmp://127.0.0.1:1935/live/x` 当收流端做可重复验收；`appendBytes` 路径不依赖任何采集设备；缺硬编的机器必顶报明确错误（不静默） |
| V6（增强，opt-in） | `all` 档（VVC、`libdav1d`、DASH 需 `libxml2`）、多音轨/字幕轨选择、`StageVideo` | 明确标注为增强，默认不启用 |

---

## 13. 明确不支持 / 延后

| 项 | 原因 |
|---|---|
| **`Camera` / `Microphone` 采集后端**（publish 的唯一缺口） | 现在是桩：`Camera.getCamera()` 返回 NULL（`src/symbols.ts:2756`）、`Microphone` 同为 shell。要接 AVFoundation / MediaFoundation / V4L2 三端采集 + 权限弹窗，是**独立于 FFmpeg** 的一项工作。publish 的封装/编码/推流侧已全部就位（V5），只缺“谁来产生帧”。**2026-11-12 裁定：先不排期**，验收走 `appendBytes()` |
| `rtmpe` / `rtmpte` | 需 `ffrtmpcrypt` → GMP，实测被关；Adobe 已退役 RTMPE |
| 纯软件 H.264 编码 | 无 LGPL 选项：`libx264` GPL、`libopenh264` 的专利覆盖只适用于 Cisco 自家二进制。**裁定（2026-11-12）**：只上硬编，缺则报明确错误，不引 GPL |
| Sorenson Spark / Nellymoser 推流 | AIR 的 `publish()` 默认可推这两路。FFmpeg 有 LGPL 的 `flv`(flv1) 与 `nellymoser` 编码器，但我们只开了 H.264+AAC；接线要拖进 mpegvideo 编码框架，体积未测。VP6 只有解码器 |
| `StageVideo` | 需要绕过显示列表的独立合成层，与 `Stage3D` 同一量级的工作；先走 `Video` + 显示列表（V6 打算） |
| 自写 VideoToolbox / Media Foundation 解码器 | §4.2 已裁定**不排期**；仅在 LGPL 依赖或产物体积约束发生根本变化时重新评估 |
| VVC（H.266） | FFmpeg 7.1 的解码器仍是实验性（需 `--enable-decoder=vvc`），归 `all` 档 |
| DASH | demuxer 依赖 libxml2（实测 configure 跳过）；HLS 已够用，需要 DASH 就进 `all` 档并引入 libxml2 |
| 图像序列当视频播 | AIR 用 `Loader`/`BitmapData` 处理静帧，走视频路径是错误模型 |
| DRM（`DRMContentData`） | AIR 自身在多数平台已不可用 |
| **HDR（PQ / HLG）** | 原先不做：`SkYUVColorSpace` 只描述矩阵与范围、**不携带 transfer function**，所以 HLG/PQ 会被当 SDR 画得发灰。现已实现为一层独立的 **opt-in 增强**（`AS_VIDEO_HDR=1`，`vendor/video_hdr.c`；默认关 = 与 AIR 同构），实测见 §16.10 |
| WASI 目标的视频 | 无窗口、无音频设备，做出来也无法验证 |

---

## 14. 决议（2026-11-12 已拍板）

| # | 议题 | 裁定 | 落地位置 |
|---|---|---|---|
| 1 | 首期容器 MP4 / FLV | **不是二选一**：默认 `broad` + publish 全带（MP4/MOV/FLV/MKV/TS/HLS/RTMP 全在），`air` 只给体积卡死的场景 | §3、§6.2 |
| 2 | Web 端是否编 FFmpeg | **不编**，走 `<video>` / WebCodecs。分歧显式记录，不假装同构。**另：未来还有 iOS / Android 两端**，接口面先留好（iOS 与 macOS 共用 VT 后端；Android 的 MediaCodec 不是 hwaccel，纹理桥要另写） | §5.4、§9 |
| 3 | 解码后端开关粒度 | **`video-backend: auto`（默认，唯一推荐值）**：自己探测硬解、失败自己回退软解，不给人一个「手选 hw」的档位。只保留排障用的 `soft` | §5.3 |
| 4 | 软解回落的暴露面 | **接受**：硬解不可用时回落软解，而不是报错（老显卡/虚拟机上仍然能播）。相应风险见 §8 | §4.3、§8 |
| 5 | FFmpeg 版本 | **直接取最新稳定版**（当前 `n9.0.2`），不锁旧 tag。代价：体积随 tag 变，换 tag 必须重量（n7.1→n9.0.2 涨 0.38~0.60 MB） | §6.3、§7 |
| 6 | HEVC / DTS / TrueHD 的软解回落 | **开**：软解难度为零（解码器本来就在 `broad` 的列表里），硬解缺失时降级软解。**这三项的许可风险由我们自己承担**（§8 已按此口径写） | §8 |
| 7 | `Camera`/`Microphone` 采集 | **先不排期**。publish 的封装/编码/推流侧已就位，验收走 `appendBytes()`（不需要采集设备） | §13 |
| 8 | `air` 档带不带 publish | **带**（`NetStream.publish()` 是 AIR 已定义行为，缺它是子集不是超集），实测 +0.20 MB | §3、§6.1 |
| 9 | 纯软件 H.264 编码 | **不做**：只上硬编（VT / MF / VAAPI），无可用编码器时明确报错。不引 GPL 的 `libx264`，也不赌 `libopenh264` 的专利边界 | §6.1、§13 |

**仍未定**（不阻塞实现）：

1. **`all` 档接不接**：VVC + `libdav1d` + DASH（`libxml2`）。`broad` 已覆盖实际使用面，`all` 只是「更全」。
2. **Windows 侧的 video 入口**：**已落地**（2026-11-12）。`windows.ps1 -Only video` 按位宽各跑一次
   `ffmpeg-static.sh --arch=x64|x86`，走 `--toolchain=msvc` + clang-cl，产物是 `vendor/ffmpeg/lib/windows-<arch>/*.lib`。
   仍未验证的只有最后一步：本机缺 MSYS2/`make`/`nasm`，所以 **`make` 阶段与体积数没有实测**；
   `configure` 阶段（含全部组件断言、两位宽的 `ARCH_X86_32/64` 核对）已在 MSVC 14.43 + LLVM 23.1 上跑通。

---

## 15. 复现方法（当前可做的部分）

```bash
# 1) 确认现状：NetStream.play 直接抛错（不需要素材，也不用建示例）
cd as3compiler
grep -n "media transport and FLV decoding" src/emit.ts
# 真要跑一次，写三行 .as 即可（AIR 上同样失败，所以这不是负例，是现状快照）：
#   var nc:NetConnection = new NetConnection(); nc.connect(null);
#   var ns:NetStream = new NetStream(nc);
#   ns.play("x.mp4");   // 期望：Error ... not supported by this subset

# 2) 确认零解码后端（应为空）
grep -rniE "avcodec|avformat|libavcodec|h264_decode" src/ vendor/*.cc vendor/*.c

# 3) 裁剪实测（V0 已完成，可一键复现）—— 配方在 git 里，源码不在
cd as3compiler
bash vendor/provision/ffmpeg-static.sh air     # 4.45 MB（含 publish）
bash vendor/provision/ffmpeg-static.sh mid     # 6.67 MB（仅供对照）
bash vendor/provision/ffmpeg-static.sh broad   # 8.28 MB（默认档）
bash vendor/provision/ffmpeg-static.sh air --no-publish   # 4.25 MB（纯解码口径，§3 那列）
# 首次跑会自动 clone 源码：ASC_FFMPEG_TAG 默认 n9.0.2（最新稳定）→ build-tools/ffmpeg-src
#   查最新稳定：git ls-remote --tags https://git.ffmpeg.org/ffmpeg.git | grep -oE 'n[0-9]+\.[0-9]+(\.[0-9]+)?$' | sort -V | tail -1
#   上面所有体积数字都是 n9.0.2 口径（n7.1 上同一套旗标会小 0.4~0.6 MB）
# 脚本末尾输出 profile=… publish=… linked=… stripped=…；产物在 build-tools/ffmpeg-out/<profile>/
# 换 Windows/Linux 主机时脚本自动换 --enable-d3d11va / --enable-vaapi 与 h264_mf / h264_vaapi
# publish / hwaccel 断言不过则 exit 3（而不是静默产出一个推不了流、或硬解形同虚设的库）

# 3b) 部署进 vendor/（与 curl/skia 同一条流水线，含 LGPL 许可证）
bash vendor/provision/macos.sh --only video      # = ffmpeg-static.sh broad + 拷到 vendor/ffmpeg/

# 4) 确认硬解后端真的在工作（用系统 ffmpeg 即可，不需要先自己编）
ffmpeg -hwaccels                                   # 应列出 videotoolbox（macOS）
ffmpeg -v verbose -hwaccel videotoolbox -i t.mp4 -f null - 2>&1 | grep -E "Selecting decoder|pix_fmt"
#   期望：Selecting decoder 'h264' because of requested hwaccel method videotoolbox
#        Reinit context to WxH, pix_fmt: videotoolbox_vld
# 5) 量两条路径的 CPU（同片源，三次取稳定值；wall clock 不计）
/usr/bin/time -p ffmpeg -hide_banner -loglevel error -i t.mp4 -f null -
/usr/bin/time -p ffmpeg -hide_banner -loglevel error -hwaccel videotoolbox -i t.mp4 -f null -
```

---

## 16. V1 实现现状与实测（2026-11-13）

**V1 已落地**：软解 + 按需注入门 + `broad` 格式面 + `onMetaData` + 音频出声，全部实测通过。
本节记录的是**现在代码在做什么**，不是计划——上面 §1 的「抛错桩」是 2026-11-12 的历史快照，
保留下来是为了说明起点。

### 16.1 落点

| 层 | 文件 | 内容 |
|---|---|---|
| C 胶水 | `vendor/video_glue.c` | `as_video_open/close/tick/state/time/info/frame/seek/pause/resume`；整数句柄 + 静态池（`AS_VIDEO_MAX` 8 条并发流）；**不认识 GC、不认识 AS3 事件**，只做 FFmpeg |
| AS3 语义 | `src/emit.ts` | `NetConnection`/`NetStream`/`Video` 的方法体、`netStatus` 派发、`onMetaData`、`_ns_tpos`/`_ns_vw`/`_ns_vht` 属性、`#2126`/`#2007` 错误号 |
| 运行时 | `src/runtime.ts` | `AS_VIDEO_ST_*` 状态位与无 FFmpeg 时的桩（`as_video_open` 返回 `-2`，不是返回空帧） |
| 构建 | `src/index.ts` + `src/build.ts` | 探测「程序里有没有 `NetStream`/`Video`」→ 决定要不要链接 FFmpeg；`video` / `video-formats` / `video-backend` 三个清单字段覆盖它 |
| 示例 | `examples/video/` | `VideoPlayer.as`（带窗口，31 条断言）+ `media/` 七个自有夹具（非第三方） |

**门是构建期决策**：`NetStream.play()` 的失败分两种，语义完全不同——

- 程序里用到了 `NetStream`，但这份产物没链接 FFmpeg（清单 `video: "off"` 或探测漏了）：
  `as_video_open` 返回 `-2`，`play()` **同步抛** `[as3-aot] not implemented by this build: video playback requires an FFmpeg-linked build`。
  这是**能力缺失**，不是文件问题，所以必须响亮。
- 链接了 FFmpeg，但文件打不开 / 容器不支持：**异步** `NetStatusEvent` `NetStream.Play.Failed`（`level="error"`，
  `info.description` 带 FFmpeg 的原因）。这与 `adl` 实测一致：`play()` 本身返回 `void`，绝不在这条路上抛。

### 16.2 状态机与帧时钟

`NetStream.play()` 同步派发 `NetStream.Play.Start` + `NetStream.Buffer.Full`（本地文件不需要等缓冲），
并在 `as_video_open` 里**先解好第一帧**——所以 `play()` 之后立刻就有 `videoWidth/videoHeight` 与画面，
不是黑等一拍。之后一切都挂在**帧边界**上：`Stage_dispatchFrame()` 开头的 `as_ns_tick()` 与定时器、
MovieClip 同一个安全点（在飞的 NetStream 是 GC 根，`as_ns_tick` 里逐条推进）。

`onMetaData` 是**异步**的（AIR 口径，也是本实现的行为）：它在 `play()` 之后的第一个帧边界上到达
客户端，不在 `play()` 调用内。示例里那三条断言曾写在 `play()` 之后同步检查，因此在真窗口里假红——
把它们挪到第一次 `setTimeout` 之后才是对的（§16.5 记了这次教训）。

### 16.3 上屏节流：一个 FIFO，不是一格抽屉

解码**只跑到时钟前 80 ms**（`AS_VIDEO_LEAD_S`），每帧边界最多 24 个包（`AS_VIDEO_TICK_PACKETS`）。
但光有「不前跑」不够，还踩了两个坑，都是实测出来的：

1. **节流必须在读包之前判**。写成「读一个包 → 解 → 若已超前就 break」时，每个帧边界仍会多解一帧；
   60 fps 下无感，但用手推的帧循环（一毫秒几百帧）会把 1.2 s 的片子在前十几拍里解完。
2. **超前帧不能只留一格**。`advance()` 为了音频不断粮会继续解复用，**音视频交错会把视频帧一起拖走**
   （一个交错片子每拍会解出约两帧）。单槽永远只装最新的那一帧（≈时钟前 80 ms），于是它**永远不会到期**：
   实测 `NetStream.time` 在整段 0.4 s 的推进里一直是 `0.000`，而槽里追着解码器跑。
   改成 8 格 FIFO（`AS_VIDEO_QUEUE`）后，时钟该显示哪帧就取哪帧；队列溢出时**丢最旧的那帧**
   （落后于实时该丢的是「观众没看到的那一帧」，不是最新一帧）。

`as_video_tick` 每拍把「已到期」的队列帧全部出队、**保留最后一个**——那就是时钟正在显示的画面。

### 16.4 容器差异（实测条目）

| 现象 | 根因 | 处置 |
|---|---|---|
| `clip.ts` 只解出 1 帧、`video_frames=1 audio_frames=0`、`time` 恒 0 | MPEG-TS 的 `start_time` 是广播时基：`clip.ts` 从 **1.533 s** 起算，原始 pts 直接和「从 0 起算的播放时钟」比，第一帧就判超前，解码立刻停住 | 记下 `v_start`（`st->start_time × time_base`）并在算 pts 时减掉；`NetStream.time` 从第一帧起算，不是从时基纪元起算 |
| 纯音频流（`tone.mp3`）第一次 `play()` 直接段错误 | `as_video_drain_video` 拿到 `vc == NULL` 仍去 `avcodec_receive_frame` | 开头加了 `vc == NULL` 守卫（音频流没有视频解码器，这是正常路径，不是错误） |
| `Play.Stop` 永远不发（`clip.mp4`） | 结束判据写成「`frame_pts` 追平容器时长」，而最后一帧在 1.133 s、文件时长 1.2 s，永远差一个帧间隔 | 改成「最后一帧上屏后再过一个帧周期」（`1/fps`，上限 200 ms）就算结束——这才是 AIR 的行为（画面放完才结束） |
| 窗口里 `endMs=0`（`getTimer()` 在 1.2 s 时返回 0） | `as_start_ms` 是**首次调用时**懒初始化的，而这个播放器第一次读时钟就是在「播放结束」那一刻，于是差值恒 0 | `main()` 开头新增 `as_clock_init()` 把纪元钉在进程启动；`getTimer()` 的语义本来就是「自进程启动以来的毫秒」 |
| `examples/builtin-arity.as` 链接失败：`undefined symbol: as_audio_live_open` / `sk_image_delete` | 注入门是**源码探针**（故意过近似）：那个示例只是把 `NetStream`/`Video` 当**形参类型**写着，也照样带上 FFmpeg 归档，而它既没有音频 glue 也没有 Skia glue | `video_glue.c` 给两个依赖各加一组编译期兜底（`ASC_HAVE_AUDIO` / `ASC_USE_SKIA`）。没有音频 = 与其它 `flash.media` 构建同一套契约（编译器已经警告过）；**没有 Skia = `as_video_open` 直接拒绝**并给出真实理由（`NetStream.Play.Failed`），不做「解码进虚空」的静默黑屏 |
| `--no-video` 仍打印 `+ video: FFmpeg linked` | 四个 video 开关被解析进 `opts.overrides` 后**再没拷进 `cfg`**（与代码里已记录的 `--ane-platform` 同一类漏拷贝） | 在 CLI 覆盖区补上 `video`/`video-formats`/`video-backend` 三条；`unit: video` 钉住 |
| `examples/with-fn-class-regexp.as` 在 windows-x64 编不过：`error: expected identifier or '('`（第 65 个 `with` 临时名 `__w64`） | `cIdent` 的加下划线逃逸会正好落进 **MS 兼容关键字** `__w64`（clang 认它是关键字；macOS 上只是普通标识符，所以只在 Windows 红） | 落进 `C_MS_COMPAT_KEYWORDS` 时改用后缀 `_`（`__w64_`）；口径与证据写进 `docs/zh-cn/c-naming.md` §7，`unit: emit/GeneratedNameReservation` 钉住 |

音频侧：解码 → `swr` 重采样到 44.1 kHz 单声道/立体声 → 写进混音器的活缓冲（与 `Sound` 同一条链）。
**纯音频流的 `NetStream.time` 由已写入混音器的采样数决定**——没有视频帧可以「假装」出这个数，
所以「1.0 s 的 `tone.mp3` 走到 1.000」本身就是解码 + 重采样 + 混音写入整条链的证明。

### 16.5 实测口径（Windows x64 / 软解 / 2026-11-13）

无头探针（`temp/video-selftest.as`，手推 `Stage.dispatchFrame()`）：

```
after play: time=0 vw=320 vh=240 codes=NetStream.Play.Start,NetStream.Buffer.Full
t=0.4s: time=0.400            pixels lit=175 distinct=52
paused: t0=0.400 t1=0.400
after resume: time=1.200      codes=...,NetStream.Play.Stop
flv: time=1.023  video_frames=15 audio_frames=46080 w=320 h=240
ts : time=1.023  video_frames=15 audio_frames=46080
mkv: time=1.008  video_frames=15 audio_frames=44084   (VP9 + Opus，48 kHz→44.1 kHz)
mp3: time=1.000  video_frames=0  audio_frames=44100   Play.Stop
```

真窗口示例（`examples/video/VideoPlayer.as`）：**31 条断言全绿**，含 `onMetaData`、`pause()` 冻钟、
`Play.Stop`、`time` 收到时长、四条容器各播到终态、纯音频流 `Play.Stop` 且 `Video.videoWidth == 0`。

**回归面（阶段三百九十九 校正）**：套件里自动跑的断言在 `examples/video-headless.as`（24 条，
自己推 `Stage.dispatchFrame()`，无窗口，按状态码结算）。`examples/video/VideoPlayer.as` 是**给人用的
播放器**——自检跑完窗口不关（Open file… 属于用户），所以它在套件里只能 compile+link
（`test/examples.ts` 的 `SKIP_DIRS` 有 `video`）。这条不是洁癖：在那之前套件跑的其实是**没带清单**的
构建——窗口开不出来、`showWindow()` 立刻返回，于是打印 `8 passed, 5 failed` 却因为退出码 0 报
`PASS video/`，视频面等于零自动覆盖。

两个诊断开关（只在排障时开，不影响控制流）：

- `AS_VIDEO_STATS=1` → 每条流关闭时打一行 `[video] <url> video_frames=… audio_frames=… w=… h=… pts=…`。
  加它的理由很实在：「音频到底有没有写进混音器」在 AS3 里**无法观测**（AIR 也没有 API），
  没有计数器时，一个悄悄停止写音频的回归只能靠耳朵发现。
- `AS_VIDEO_DEBUG=1` → 每个帧边界打一行 `[tick] now=… target=… cur=… qn=… q0=… eof=…`，
  §16.3 那两个坑就是靠它定位的。

复现：

```bash
# 真窗口示例（从仓库根跑，夹具路径是相对当前目录的）
node src/index.ts examples/video/VideoPlayer.as --manifest examples/video/video.build.json --run

# 无头自检（不建窗口，手推帧边界）
node src/index.ts temp/video-selftest.as --manifest examples/video/video.build.json -o temp/video-out/selftest.exe
AS_VIDEO_STATS=1 ./temp/video-out/selftest.exe

# 无头**断言**（套件跑的就是这一条，24 条断言，失败退出 1）
node src/index.ts examples/video-headless.as --manifest examples/video/video.build.json --run
```

### 16.6 还没做的（V2 起）

硬解（`videotoolbox` / `d3d11va`）与零拷贝纹理桥、缓冲状态（`Buffer.Empty`/`Buffer.Flush`）、
传输面（`http` 渐进式 → HLS → RTMP）、`publish` 输出面。**当前是纯软解 + 本地文件**：
`NetStream.play()` 接受 `http(s)://`（FFmpeg 自己打开），但没有 HLS 直播切片策略与追帧逻辑。

### 16.7 4K / 10-bit HDR10+ 素材：真实代价与四道修复（2026-11-13 实测）

素材：`The.Furious.2026.2160p.iTunes.WEB-DL.DDP.5.1.Atmos.HDR10+.H.265-CHDWEB.mkv`——
3832×1592 HEVC Main10（HDR10+）、DDP 5.1 Atmos、20.9 GB、23.976 fps。用户实测「选择播放这个视频
卡到不行」，定位下来是**四处互相独立的代价，没有一处是「缺硬解」**：

| # | 缺陷 | 实测代价（3832×1592 10-bit） | 修复 |
|---|---|---|---|
| 1 | `AVCodecContext.thread_count` 停在 FFmpeg 默认的 **1**（单线程解码） | 8.8 ms/帧，直接压在帧边界上 | 按 `av_cpu_count()` 开 frame+slice 线程，**上限 8**（frame threading 每线程持一帧 ≈18 MB，32 线程会钉住约 580 MB） |
| 2 | CPU 回落路径**转换两次**：先 sws→I420 喂一个不存在的 GPU 上传，再 sws→BGRA | 12 ms + 6 ms/帧 | `want_gpu = (grctx != NULL)` 决定**单条**路径；没有 GPU 上下文就直接 sws→BGRA |
| 3 | 示例用 AIR 默认 `Stage.frameRate = 24`，而画面推进挂在帧边界 | 23.976 的素材每个应用帧只够出一帧，任何一次迟到就重复显示同一帧 → 持续抖动 | 示例 `stage.frameRate = 60`；4K 素材下窗口循环 **16.5 → 56 fps** |
| 4 | 窗口是 CPU 光栅（清单没开 `ASC_RENDER_WINGPU`），4K 帧在 CPU 上缩放并被整帧拷进 SDL 纹理 | 上传 3.0 ms/帧（BGRA 24 MB 拷贝） | 清单加 `${win:ASC_RENDER_WINGPU=1}` + `${win:ASC_RENDER_D3D=1}` + `d3d_glue.cc`：YUV 三平面直接进 D3D12 纹理，上传 **0.56 ms/帧** |

修复后（真窗口、`Stage.frameRate = 60`、连续 20 s）：

```text
wall=20130ms  time=20.020  appFrames=1179 (58.5 fps)  worst=46ms
video_frames=484 (24.2 fps)  audio_frames=913030   threads=8
cost/frame: dec≈0.00ms  conv=6.13ms  upload=0.56ms
```

`time` 跟墙钟 0.5% 内（无漂移），`video_frames` 与素材帧率一致（没跳帧也没补帧）。

要点，按重要性：

- **软解本来就不慢**：4K 10-bit HEVC 单线程就是 8.8 ms/帧（≈114 fps 的解码能力），8 线程下解码
  在 `receive_frame` 上的可见耗时变成 0——它被完全隐藏了。真正的瓶颈是「转换两次」「单线程压在
  帧边界」「帧时钟 24 Hz」「CPU 光栅」。所以 **V1 不引 hwaccel 不等于「播不动 4K」**（这也回答
  「§12 是不是还在 V1」：是，V1 已完结，硬解是 V2/V3，而这次卡顿不是硬解缺失造成的）。
- `conv=6.13 ms` 是 10-bit→8-bit I420 的 sws 代价（Skia m124 的 YUV 入口只吃 8-bit 4:2:0，
  `SkYUVAPixmaps` 没有 10-bit 平面类型），要等硬解/零拷贝（V2/V3）或一个 10-bit 纹理入口才会消失。
  按 23.976 fps 算它占单核 15%，所以现在还能接受；60 fps 的 4K 素材会顶到 37%，那时该做的是把
  解码+转换搬到工作线程（本文暂不做，理由见下）。
- **frame threading 会「攒够一队才出帧」**：首帧不能被一次 tick 的包预算卡住，否则 `play()` 之后
  `videoWidth` 仍是 0。`AS_VIDEO_PRIME_PACKETS = 240` 只在 `n_vframes == 0` 且**存在视频流**时
  生效（纯音频流永远 `n_vframes == 0`，不能每 tick 白花 240 个包）。实测过：1.2 s 的夹具在 8 线程
  下用旧预算，`after play: vw=0`。
- 窗口程序的备忘：**播视频把 `Stage.frameRate` 提到 60**，窗口走 GPU 光栅。这两条只影响「好不好看」，
  但 24 Hz 的帧时钟对 23.976 的素材是**结构性抖动**，不是偶发卡顿。
- 没做的：把 sws+上传搬到工作线程（`as_video_present` 里的 `sk_image_from_yuv_strided` 依赖
  GrDirectContext，只能在帧边界所在线程调用，真要做就得让工作线程只产出 I420 并加环形缓冲）。
  当前 6.7 ms/帧的余量够 4K@24，等 4K@60 素材变成常态再说，避免为「假想的未来」加一层同步。


### 16.8 V3 第一步：D3D11VA 硬解接通了，默认仍是软解（2026-11-14 实测）

先把两件事分开：**「硬解能用」与「硬解更快」不是同一件事**。这一节把前者做成能用、可验证、可回退，
并用同一份 4K 素材量出后者在本机是否成立——结论是不成立，所以默认路径保持软解。

#### 16.8.1 重编 FFmpeg：两个 `d3d11va` 名字必须同时开

`n9.0.2` 里这两个 configure 名字注册的像素格式与名字暗示**相反**（`libavcodec/hwconfig.h`）：

```c
#define HWACCEL_D3D11VA2(codec) HW_CONFIG_HWACCEL(1, 1, 0, D3D11,       D3D11VA, ff_..._d3d11va2_hwaccel)
#define HWACCEL_D3D11VA(codec)  HW_CONFIG_HWACCEL(0, 0, 1, D3D11VA_VLD, NONE,    ff_..._d3d11va_hwaccel)
```

即 `h264_d3d11va2` 才是**实现** `AV_PIX_FMT_D3D11` 的那个，`h264_d3d11va` 是 `AV_PIX_FMT_D3D11VA_VLD`
的旧接口。但解码器把 `AV_PIX_FMT_D3D11` 加进候选列表的 `#if` 用的是**旧名字**
（`libavcodec/h264_slice.c:108-111`、`hevc/hevcdec.c:613`、`av1dec.c:587`、`mpeg12dec.c:811`、
`vc1dec.c:59`）。于是：

| 只开 | 现象（都实测过） |
|---|---|
| 只 `d3d11va`（V1 的原始清单） | `avcodec_get_hw_config()` 里只有 `dxva2_vld` 与 `d3d11va_vld`；`avctx->hwaccel` 始终 NULL，第一次 `get_buffer` 就失败 |
| 只 `d3d11va2`（第一次修正） | hw_config 里有了 `pix_fmt=d3d11`，但 `get_format` 收到的是 `yuv420p`——格式从没进过候选列表，解码静默留在软解 |
| **两个都开**（现行） | `get_format -> d3d11`，`decode=d3d11va` |

所以 `vendor/provision/ffmpeg-static.sh` 的 Windows 分支同时请求 `d3d11va` 与 `d3d11va2`（外加 `dxva2`）。
**每次重编都要验证，别信配置**：

```c
// 探针（temp/hwcfg2.c 的形状）：打印实际注册的 hw_config，再试建设备
for (int i = 0;; i++) { const AVCodecHWConfig* c = avcodec_get_hw_config(dec, i); if (!c) break;
  printf("[%d] device=%s pix_fmt=%s methods=0x%x\n", i,
         av_hwdevice_get_type_name(c->device_type), av_get_pix_fmt_name(c->pix_fmt), c->methods); }
av_hwdevice_ctx_create(&dev, AV_HWDEVICE_TYPE_D3D11VA, NULL, NULL, 0);  // rc=0 才算通
```

本机实测（重编后）：`[0] dxva2/dxva2_vld`、`[1] (null)/d3d11va_vld`、`[2] d3d11va/d3d11`，`methods=0x3`
（`HW_DEVICE_CTX|HW_FRAMES_REF`），`av_hwdevice_ctx_create` 返回 0。

重编后 `vendor/ffmpeg/lib/windows-x64/*.lib` 已更新（avcodec 13.5 MB，与旧版差 28 字节：旧的
`d3d11va` 换成 `d3d11va2`，净持平）；`windows-x86` 同法重编并更新（avcodec 11.0 MB），脚本自己断言
`ARCH_X86_32`/`ARCH_X86_64`，所以位宽不会静默错位。

#### 16.8.2 运行时：接上就退不回去，所以做成显式开关

`vendor/video_glue.c` 新增（不碰 Skia，也不碰事件层）：

- `as_video_hw_setup()`：只有编解码器**自己报告**有 `AV_HWDEVICE_TYPE_D3D11VA` 且带 `HW_DEVICE_CTX`
  时才建 `hw_device_ctx`；设备创建失败就静默留在软解（没有可用 D3D11 的机器也要能播）。
- `as_video_get_format()`：优先 `AV_PIX_FMT_D3D11`；没有就取列表里第一个**非 hwaccel** 格式。
  这里踩过：返回 `list[0]` 会拿到 `dxva2_vld`，而挂的是 D3D11 设备，FFmpeg 直接报
  `Invalid setup for format dxva2_vld: does not match the type of the provided device context`。
- 出帧后 `av_hwframe_transfer_data(sw_frame, hw_frame, 0)` 落回系统内存，**再** `av_frame_copy_props`。
  后者不是可选：`av_hwframe_transfer_data` 只分配缓冲、不搬 props（`libavutil/hwcontext.c:448`），
  而 pts / colorspace / color_range 都在 props 里——漏了它，每帧 pts 都是 0，`NetStream.time` 冻在 0.000。
- 开关：`AS_VIDEO_DECODE=hw|d3d11va|auto` 才用 GPU；未设或 `soft` 走 CPU。
- `AS_VIDEO_STATS=1` 多两列：`decode=soft|d3d11va` 与 `hw=…ms`（回读耗时，与 `dec/conv/upload` 并列）。

#### 16.8.3 为什么默认还是软解：同一份 4K 素材，同一支二进制

`temp/probe-4k.as`（真窗口、`stage.frameRate = 60`、连续 20 s、同一台 32 核机器）：

| | `decode` | 每帧成本 | 应用帧 | 最差帧间隔 | `ns.time` / 墙钟 |
|---|---|---|---|---|---|
| 软解（默认） | soft，`threads=8` | `dec≈0` + `conv=6.49` + `upload=0.56` ≈ **7.0 ms** | 1121 / 19.1 s ≈ **58.7 fps** | **44 ms** | 19.019 / 19.107 |
| 硬解 | d3d11va | `hw=11.17` + `conv=3.33` + `upload=0.40` ≈ **14.9 ms** | 1130 / 19.3 s ≈ 58.5 fps | **103 ms** | 19.102 / 19.336 |

结论：**在本机，硬解 + 回读比 8 线程软解慢一倍，帧节奏还更差**。原因不是 D3D11VA 本身，而是
`AV_PIX_FMT_D3D11 → 系统内存` 那一步：4K P010 一帧约 12 MB，`hw=11.17 ms` 全是这次回读（含 driver 同步）。
软解那 7 ms 里也没有解码的份——它在 8 个线程里被完全隐藏了。

所以「硬解要赢」只有一个前提：**别回读**。这正好是 §10.2 里 Windows 那一行的难点——`DXGI_FORMAT_NV12`
的 Y/UV 是同一资源的两个 **plane slice**，而 `GrBackendTexture` 收的是整张 2D 纹理。
**这条链已按 §16.9.2 的形态做完了**（零拷贝实测每帧 0.24 ms、最差帧间隔 20 ms），
在那之前「默认软解」只是当时的权衡，不再是结论。

在这条链做完之前，**默认软解是正确的工程选择**；`AS_VIDEO_DECODE=hw` 留给「CPU 解码撑不住、GPU 有余」
的机器，作为可回退的 A/B 通道（`examples/video-headless.as` 24 项断言在两种模式下都是全绿）。
默认是否翻成硬解：**已经翻了**——`AS_VIDEO_DECODE` 未设即自适应（能零拷贝就硬解），
判据与时点见 §16.9.6；缓存本机实测三路对照也在那里。

#### 16.8.4 复现命令与一个构建坑

```bash
# 重编（必须两个 d3d11va 名字都开）
bash vendor/provision/ffmpeg-static.sh broad --arch=x64
# 真素材 A/B（同一支 exe）
AS_VIDEO_STATS=1 ./temp/probe-4k.exe                    # 软解（默认）
AS_VIDEO_DECODE=hw AS_VIDEO_STATS=1 ./temp/probe-4k.exe # 硬解
```

**构建坑（MSYS2 make）**：MSYS2 的 `make` 会把单引号 recipe 里的反斜杠吃掉一层，FFmpeg 生成依赖的
`awk '/including/ { … gsub(/\\/, "/") … }'` 到 awk 手里变成非法的 `/\/`，于是**每个 .o 都**
`syntax error`。对策：`configure` 之后把 `config.mak` 里那四处 `gsub(/\\/, "/")` 写成
`gsub(/\\\\/, "/")`（4 个反斜杠——make 吃掉一层后 awk 才拿到合法的 `\\`）。`config.mak` 是
`configure` 会覆盖的生成文件，所以每次重编都要重新补。另外三个工具来自三个地方，缺一不可：
`awk`/`sh` 用 Git for Windows 的、`make`/`nasm` 用 `/c/msys64/usr/bin` 的、`lib.exe` 从 vcvars 环境来。

### 16.9 V3 第二步：零拷贝接上了，硬解终于比软解快（2026-11-14 实测）

§16.8 的结论是「硬解 + 回读 = 软解的两倍代价」，代价全在 `AV_PIX_FMT_D3D11 → 系统内存` 那一步。
这一步把回读从链路上拿掉：解码出的切片在 GPU 内被拆成 Y/UV 两张整纹理，直接进 Skia 的 YUV 着色器。

#### 16.9.1 同一份 4K HDR10+ 素材、同一支二进制、真窗口 60 Hz、连续 20 s

素材：`The.Furious.2026 … HDR10+ H.265`（3832×1592、P010、23.976 fps）。

| 路径 | 每帧 CPU 成本 | 应用帧 | 最差帧间隔 | 上屏帧数 |
|---|---|---|---|---|
| 软解（8 线程，默认） | `conv=5.91` + `upload=0.67` ≈ **6.6 ms** | 1181 / 20.1 s ≈ 58.8 fps | **44 ms** | 484 |
| 硬解 + 回读 | `hw=9.59` + `conv=3.37` + `upload=0.42` ≈ **13.4 ms** | 1189 ≈ 59.4 fps | **98 ms** | 487 |
| **硬解 + 零拷贝** | `copy=0.24` + `conv=0.02` ≈ **0.27 ms** | 1198 ≈ 59.9 fps | **20 ms** | 484 |

`copy` 是纯 CPU 侧的提交开销（D3D11 blit、fence、命令录制），真正的 GPU 工作（约 9 MB 的两次 plane 拷贝）
是异步的，不进这个数。最差帧间隔 20 ms 对 60 Hz 也就是「每一帧都在下一帧到之前画完」。

#### 16.9.2 链路：四个环节，每一环都有它的理由

实现在 `vendor/video_d3d.cc`（Windows/D3D12 only），对 `vendor/video_glue.c` 只暴露
`sk_video_d3d_image()` / `sk_video_d3d_stats()` / `sk_video_d3d_forget()` 三个整数/指针接口，
继续保持「FFmpeg 的 C 接缝里不认识 Skia」这条规矩。

1. **解码切片 → 自己的共享 staging（D3D11，`CopySubresourceRegion`）**。
   不直接开放解码纹理是有原因的：FFmpeg 的 `hwcontext_d3d11va.c` 用 `D3D11_BIND_DECODER` 分配
   整块 Texture2DArray，**不带共享标志**，DXVA 也不保证解码面能共享。所以拷到一张同格式（NV12/P010）的
   共享纹理上，这一步是显存内 blit，4K 约 9 MB。
2. **共享 fence 排序**（`ID3D11Device5::CreateFence(D3D11_FENCE_FLAG_SHARED)` → `ID3D12Fence::Wait`）。
   不能用 `Flush()` + 轮询：那要么阻塞 CPU，要么在 D3D12 侧读到未完成的画面。
3. **D3D12 侧把两个 plane 拆成两张整纹理**（`CopyTextureRegion`，源子资源 0=Y / 1=UV，
   目标 R8 / R8G8，10-bit 则是 R16 / R16G16）。这是 `GrBackendTexture` 只收整张 2D 纹理的直接后果，
   也是 `video_d3d.cc` 存在的全部意义。P010 的 10 bit 是左对齐存在 16 位里，`R16_UNORM` 归一化后
   恰好就是 10-bit 值 / 1023——不需要移位，也不需要 swscale。
4. **喂 Skia**：`SkImages::TextureFromYUVATextures(ctx, GrYUVABackendTextures(SkYUVAInfo(kY_UV, k420, cs)), …)`，
   纹理交给 Skia 时报的状态是 `D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE`（和
   `sk_gpu_draw_texture` 同一条契约：Skia 自己跟踪纹理状态，两边必须口径一致）。

#### 16.9.3 颜色：两条独立证据，不靠「看起来对」

| 素材 | 软解（参考） | 硬解+回读 | **硬解+零拷贝** |
|---|---|---|---|
| `clip.mp4`（8-bit）meanR/G/B | 120.9 / 126.14 / 130.13（distinct 764） | **完全相同** | **完全相同** |
| `clip10.mp4`（P010，BT.2020 PQ）meanR/G/B | 20.79 / 22.82 / 25.81 | 20.79 / 22.82 / 25.81 | 20.06 / 23.19 / 24.54 |
| 同内容的 8-bit 转码（`clip8.mp4`，软解） | 20.18 / 22.97 / 24.63 | — | — |

8-bit 三条路逐采样点一致（同一帧的 mean 与 distinct 数完全相同）。10-bit 上零拷贝与「同内容 8-bit 转码」
的差是 0.12 / 0.22 / 0.09，而回读路径差 0.61 / 0.15 / 1.18——**零拷贝更接近真值**，因为参考路径先把
P010 用 sws 降到 8-bit I420，却仍按 10-bit 矩阵（`kBT2020_10bit_Limited`）解释，矩阵与位深本就不匹配。
（`temp/probe-color.as` 是这条对比的取证工具：播到片尾定格再 `BitmapData.draw` + `getPixel32` 采样。）

#### 16.9.4 四个坑（都是实测踩出来的，不是推测）

1. **`D3D11_RESOURCE_MISC_SHARED_NTHANDLE` 必须配 `D3D11_RESOURCE_MISC_SHARED`**：
   只写前者，`CreateTexture2D` 对 NV12(0x67) 与 P010(0x68) 都返回 `E_INVALIDARG`。第一次失败时
   很容易误判成「视频格式不能共享」——不是，格式无关。
2. **纹理环大小要跟解码队列对齐，不是「双缓冲」**：`video_glue.c` 的 `AS_VIDEO_QUEUE = 8` 会把
   解码超前于时钟的帧留在 FIFO 里，每帧都持着一张 SkImage。两格环实测 31 帧里 14 帧「饿死」退回回读，
   等于白做。现在 10 格，按需创建（320×240 只花 0.1 MB/格）。
3. **`TextureReleaseProc` 必须带 epoch**：Skia 可能在流关闭之后才回调（显示列表还持有图片），
   那时表项可能已经属于另一台设备，回调会把在用槽位标成空闲 → 纹理被重写、画面撕裂。
   现在回调携带发牌时的 `Stream::epoch`，对不上就什么都不做。
4. **表项要在释放 D3D11 设备之前 `forget`**：表以设备指针为键，设备被 FFmpeg 释放后地址可能被
   新设备复用，留着旧表项就等于拿着一个死的 immediate context。`as_video_free_state` 里
   先丢弃图像、再 `sk_video_d3d_forget(v->hw_dev11)`、最后 `av_buffer_unref(&v->hw_device)`。

#### 16.9.5 开关与默认

- 零拷贝**只在 Windows + D3D12 后端 + `ASC_USE_SKIA`** 编译进来（`video_d3d.cc` 写在
  `examples/video/video.build.json` 的 `${win:…}` 里）；其他构建里 `sk_video_d3d_image` 是静态
  兜底函数，返回 NULL，**不改变任何行为**。
- 运行时 `AS_VIDEO_ZC=0|off` 关掉零拷贝（做 A/B 用）；默认开。
- **默认解码是自适应**（`AS_VIDEO_DECODE` 未设 = `auto`）：能零拷贝就硬解，不能就软解，判据与
  时点见 §16.9.6。`soft`/`cpu` 强制软解，`hw`/`d3d11va` 强制硬解（不要求零拷贝）。
- `AS_VIDEO_STATS=1` 的 `decode=` 列区分三态：`soft` / `d3d11va-readback` /
  `d3d11va-zero-copy`，并多两列 `zc=<帧数>` `starved=<饿死次数>`。

#### 16.9.6 自适应默认：软解起步、首个帧边界翻牌

判定难点在于**两件事的答案出现在不同时刻**：硬解开不开在 `open`，零拷贝能不能用要看
`GrRecordingContext`（窗口渲染上下文），而 `open` 时它根本不存在。所以：

1. **`open` 一律软解开解**并**预解一帧**。预解不是可选项：`play()` 之后立刻
   `BitmapData.draw` 必须不是黑的（这条是回归钉），而那时没有渲染器可供判定。
2. **第一个帧边界**（`as_video_tick` 拿到非 NULL 的 `grctx`）回答那个问题：建 D3D11 设备 →
   建共享 staging + 一对平面纹理（`sk_video_d3d_probe`）→ 全通才把解码器**重开**成 D3D11VA。
   一次 `av_seek_frame` 回到片子开头（复用正常 seek 路径：丢图、清队列、`av_audio_live_rewind`），
   所以重复的只有那一帧预解，且**流不重开**、`NetStatus`/`onMetaData` 序列不变。
3. 探针不过、设备建不出来、或解码器不接（驱动不支持该 profile）⇒ 留在软解，`hw_refused=1`
   （`AS_VIDEO_DEBUG` 会打印原因）。每流只问一次；没有渲染器的程序（无头示例）永远不问。

两个反例决定了这个形状：

- **不能在 `open` 直接硬解**：在没有渲染器的机器上会落到「硬解可用、零拷贝不可用」= 回读，
  实测 13.4 ms/帧，比软解的 6.6 ms 慢一倍，等于把优化做成负优化。
- **不能每流建两台设备**：探针里建的设备必须留着给真正的解码器用。早期版本探后释放、
  重开再造一台，结果是**每流吃掉两个零拷贝表项**，4 项的表在第三个 `NetStream` 上就满了
  （实测：`[zc] no free stream entry`，该流静默退回回读）。

同一支 exe 的三条路（“默认”即不设任何 `AS_VIDEO_*`）：

| | 每帧 CPU 成本 | 应用帧 | 最差帧间隔 | 上屏 |
|---|---|---|---|---|
| 4K HDR10+ 默认（= 零拷贝） | `copy=0.26` + `conv=0.02` ≈ **0.28 ms** | 1180 / 20.1 s ≈ 58.7 fps | 32 ms | 475 |
| 4K HDR10+ `AS_VIDEO_DECODE=soft` | ≈ 6.6 ms | ≈ 58.8 fps | 44 ms | 484 |
| `examples/video-headless.as` 默认（无窗口 ⇒ 软解） | — | — | — | 24 断言全绿 |

无窗口时不会去建 D3D11 设备：`grctx == NULL` 就不升级，判定保持未决，无头程序一分钱不花。

### 16.10 HDR10+ / HLG 在 SDR 屏幕上：能做，但默认关（2026-11-14 实测）

素材仍是那支 4K HDR10+ 文件（`color_trc=smpte2084`、`colorspace=bt2020nc`、P010）。
问题很具体：**AIR 没有 HDR 上屏面**，`Video` 拿到的是 YUV，Skia 的 YUV 着色器只做
矩阵与范围、**不带 transfer function**，于是 PQ 码值被当成 sRGB 直接画——暗部整体抬平、
高光全糊在 255 附近，画面又灰又闷。这不是我们引入的行为，是「照 AIR 同构」的必然结果。

所以这一层按 AGENTS.md §1.5 做成 **增强**：`AS_VIDEO_HDR=1` 打开，默认**关**（默认仍然是
「照 AIR 画」，一个像素都不动）。关闭时 `vendor/video_hdr.c` 根本不进热路径，SDR 流的行为
与 §16.7/§16.9 完全一致。

**管线**（`vendor/video_hdr.c` + `vendor/video_hdr.h`，纯 C，唯一的外部依赖是 `libm`，
只被 `video_glue.c` 调用）：

```text
P010/NV12 --sws--> RGB48LE (16-bit/通道) --逐通道线性化--> 线性
          --[BT.2020 -> BT.709, 线性光]--> display-referred
          --[shoulder + gamma 0.8]--> 8-bit BGRA --sk_image_from_argb--> Skia
```

四个实现决策，每个都有实测反例：

1. **判定只看 transfer function，不看位深**（`AVFrame.color_trc` / `codecpar.color_trc`）。
   10-bit SDR（ProRes 422 HQ 等）不少，按位深判定会把它们无故压暗。
2. **中间格式是 16-bit RGB（`AV_PIX_FMT_RGB48LE`），不是 8-bit**：PQ 的码值在暗部集中在
   0.3–0.5，先降到 8 bit 再线性化会出台阶。代价是 6 字节/像素的 sws 与内存带宽（见下）。
3. **参考白用 100 nits（video diffuse white），不是 BT.2408 的 203 nits（graphics white）**。
   203 是「HDR 与 SDR 图形同屏」的口径，套在整部电影上会明显偏暗——同一帧（t≈10 s）实测：
   203 白点下均值 `8.83/3.49/2.20`，直通路径是 `16.83/12.15/8.31`，暗部细节直接消失。
   改成 100 后再加一道**中间调 lift（gamma 0.8，折进输出表，每像素零额外成本）**，得到下文表格。
4. **与零拷贝互斥，且优先于它**：Skia 的 YUVA 纹理没有地方做 transfer function 解码，
   所以 HDR 生效时**不尝试** `sk_video_d3d_image()`，也不升级硬解（否则等于在回读之上再加
   一次映射）。判定在 `open()` 就用容器参数做完，避免首帧走错路径；表与两块缓冲也在
   `open()` 建好（放到首帧会是一次 ~100 ms 的帧间隔）。

同一支 exe、同一素材（20 s，3832×1592，23.976 fps）：

| 路线 | 每帧 CPU 成本 | 应用帧 | 最差帧间隔 |
|---|---|---|---|
| 直通（默认，照 AIR：PQ 当 sRGB） | `conv=5.91` + `upload=0.67` ≈ **6.6 ms** | 1195 / 20.2 s ≈ 59 fps | 44 ms |
| `AS_VIDEO_HDR=1`（软解 + 上色） | `sws=12.23` + `map=4.16` + `upload=3.07` ≈ **19.5 ms** | 1156 / 20.2 s ≈ 57 fps | 94 ms |
| 零拷贝（§16.9，HDR 关时才走） | `copy≈0.26` ≈ **0.3 ms** | 1180 / 20.1 s ≈ 59 fps | 20 ms |

映射本身一开始是**单线程 19.5 ms**（4K 6.1 M 像素、逐像素 3 次查表 + 3×3 矩阵），在一帧
41 ms 的预算里吃掉一半；`video_hdr.c` 现在按行切成最多 8 块并发（块间无共享，`rows/8 < 64`
时自动退回单线程），实测降到 **4.2 ms**。sws 那一半（12.2 ms）没有再拆：它是 FFmpeg 自己的
SIMD 转换，同尺寸 1:1，只做 YUV→RGB48。

**上色前后的画面统计**（`temp/probe-hdr.as`，同一时间点各采样 6000 点，BT.709 luma）：

| | meanR/G/B | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| 直通（默认） | 16.83 / 12.15 / 8.31 | 7 | 34 | 65 | 108 |
| `AS_VIDEO_HDR=1` | 22.39 / 11.00 / 7.34 | 2 | 39 | 93 | 175 |

方向是「高光拉开、暗部压深」，这正是 HDR 素材在 SDR 上应有的对比度：max 从 108 抬到 175、
p99 从 65 到 93，整体均值仍在同一量级。**代价说清楚**：这是一条逐通道曲线、不做内容自适应，
所以很饱和的高光会轻微偏色（不是整体色域裁剪）；HLG 用简化 OOTF（忽略跨通道亮度项，
手上没有 HLG 素材可标定）。HDR10+ 的**动态**元数据、Dolby Vision、局部（空间可变）
tone mapping 都没做。

曲线本身有可执行断言：`test/unit/video.ts` 会**用本机 C 编译器编译真正的
`vendor/video_hdr.c`** 并跑一段驱动，钉住「PQ 黑→0」「单调不减」「100 nits 落在 200–245」
「1000 nits 不高于 255 且不暗于 100 nits」「18 nits 落在 100–165（暗部不被压没）」
「gain 生效、非法 gain 被拒」——纯源码 grep 钉不住一条曲线。

复现：

```bash
AS_VIDEO_HDR=1 AS_VIDEO_STATS=1 ./temp/probe-4k.exe      # 每帧成本 + hdr=pq
AS_VIDEO_HDR_GAIN=1.3 ./temp/probe-4k.exe                # 觉得偏暗就抬增益
node --test --test-name-pattern='video' test/unit/*.ts   # 曲线断言
```



---

## 17. 参考锚点

- AS3 语言参考：[`flash.net.NetStream`](https://airsdk.dev/reference/actionscript/3.0/flash/net/NetStream.html)、
  [`flash.media.Video`](https://airsdk.dev/reference/actionscript/3.0/flash/media/Video.html)、
  [`flash.media.VideoCodec`](https://airsdk.dev/reference/actionscript/3.0/flash/media/VideoCodec.html)
- FFmpeg 裁剪与许可：[`doc/configure.texi`](https://ffmpeg.org/ffmpeg-all.html)、[LGPL 合规](https://ffmpeg.org/legal.html)
- 本仓库相关文档：[`yuv-direct-render.md`](yuv-direct-render.md)（YUV 直通已实现）、
  [`audio.md`](audio.md)（miniaudio 后端与音频语义对齐）、
  [`flash-net.md`](flash-net.md)（`NetConnection`/`URLLoader` 现状）
- 仓库根分析：[`video-frame-copy-chain-analysis.md`](../../../video-frame-copy-chain-analysis.md)（RTC 帧拷贝链实测）、
  [`yuv-video-direct-draw-analysis.md`](../../../yuv-video-direct-draw-analysis.md)（YUV 直通收益）
