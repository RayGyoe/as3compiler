# 视频播放（`flash.net.NetStream` / `flash.media.Video`）调研与方案

> 本文回答一个问题：**AS3 的视频播放现在处于什么状态，要让它真的出画面需要做什么、用哪个开源方案**。
> 结论先行：**目前是零支持，而且是「响亮地零支持」**——`NetStream.play()` 直接抛
> `flash.net.NetStream.play: media transport and FLV decoding are not supported by this subset`
> （`src/emit.ts:16607`），`Video.attachNetStream()` 是空函数（`src/emit.ts:16630`）。全仓没有解复用器、
> 没有视频解码器、没有视频时钟。
>
> **本文状态：方案已定稿（§14 全部九项于 2026-11-12 拍板），实现未排期。**
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

## 1. 现状：`NetStream` 是抛错桩，`Video` 是空壳

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
| 解码帧 → 纹理 | YUV 直通 **0.16 ms/帧 @720p** | 见 `yuv-direct-render.md` §8.4；hwaccel 路换成纹理桥，量级相近 |
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
| macOS arm64 | FFmpeg | **VideoToolbox（默认）**：h264、hevc、mpeg1/2/4、h263、prores、vp9；其余软解回退 | `h264_videotoolbox` + `aac`（系统硬编） | `CVPixelBuffer` → `CVMetalTextureCache` → `GrBackendTexture` | arm64 软解走 NEON，无需额外汇编依赖 |
| Windows x64 | FFmpeg | **D3D11VA（默认）**：h264、hevc、mpeg2、vc1、vp9、av1、wmv3；其余软解回退（DXVA2 留老系统） | `h264_mf` + `aac`（MediaFoundation，**未实机验证**） | `ID3D11Texture2D` → `GrBackendTexture` | 软解 SIMD 需 nasm/yasm（见 `checks.ts`） |
| Linux | FFmpeg | 软解；VAAPI 可选（h264/hevc/vp9/av1，**未验证**） | `h264_vaapi`（**需 GPU**；无软编兜底 → 缺 render node 时 `publish()` 报错） | `AV_PIX_FMT_YUV420P` → Skia YUV 直通 | 有 ELF 目标即能编 |
| Web（`--target wasm --package web`） | 浏览器 | **浏览器原生**（`<video>` / WebCodecs） | 浏览器（`MediaRecorder` / WebCodecs）；需 `NetStream.appendBytes` 才能自己产码流 | canvas → WebGL/WebGPU | **不把 FFmpeg 编进 wasm** |
| WASI（`--target wasm`） | 无 | 无 | 无 | — | **响亮报错**「本后端不支持视频」，不静默降级 |
| **iOS（预留，未支持 target）** | FFmpeg | **VideoToolbox**（与 macOS 同源，同一套 `videotoolbox` hwaccel） | `h264_videotoolbox` + `aac` | `CVPixelBuffer` → `CVMetalTextureCache` → `GrBackendTexture` | **与 macOS 共用一份 glue**，差别只在设备/权限。AOT 上 iOS 本来禁不了（不能下发可执行码），这条路径只在「编译期已固定」的形态下成立 |
| **Android（预留，未支持 target）** | FFmpeg | **MediaCodec**（FFmpeg 侧只有编解码器包装，**没有统一的 hwaccel 框架**）；其余软解回退 | `h264_mediacodec`（未验证） | `AHardwareBuffer` → `EGLImage` → `GrBackendTexture` | 需 NDK 编译；**这一端是唯一需要单独写硬件桥的**，不能假定与桌面同形 |

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
| **YUV 直通**（`yuv-direct-render.md`，四端 Skia 都有 `TextureFromYUVAPixmaps`） | 软解路：FFmpeg 输出 `YUV420P` **直接喂纹理**，省掉一次 YUV→RGBA 的 CPU 转换（720p 约 1 ms/帧）。hwaccel 路：帧已在 GPU 侧，这步退化为纹理桥（`CVPixelBuffer`/`ID3D11Texture2D` → `GrBackendTexture`），连上传也省了 |
| `BitmapData` 像素契约（内部 `0xAARRGGBB`） | 需要像素级访问时走「解码 → YUV → 按需物化」，不默认物化 |
| `vendor/audio_glue.c`（miniaudio） | **音频侧已能解 MP3/FLAC/WAV/Vorbis**；AAC 由 FFmpeg 解成 PCM 后直接喂 miniaudio 的 f32 混音管线，不需要另写音频设备层 |
| ANE 视频帧链（`getVideoBitmapData`） | 文件播放与 RTC 帧共用同一个「上传纹理」出口，只有上游不同 |
| 异步 job 表（`as_job_*`，阶段八十九·四十五） | 解复用/解码应挂在同一套后台任务上，不阻塞帧边界；解码器上下文是**长生命周期对象**，不能每帧重建 |

---

## 11. 实现落点（对齐 AGENTS.md 分层）

| 层 | 落点 | 禁止 |
|---|---|---|
| C 胶水 | `vendor/video_glue.c`（新）：`as_video_open/read_frame/decode/close`，封装 `AVFormatContext`/`AVCodecContext`，带 `backend`（`auto`/`soft`）与 `formats`（`air`/`broad`/`all`）两个参数；`auto` 内部自己做探测 + 回退 | 在里面做 AS3 语义（`NetStream` 状态机归 codegen）；在胶水里写平台窗口/设备 glue |
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
| V1 | **解码 seam + 软解 + 按需注入门 + 三档格式面**：`as_video_*` 带 `backend`+`formats`；落地 `usesVideoCodec` / `video` / `video-formats`；容器 `mov,flv,matroska,mpegts,mp3,aac,ogg,wav`，视频 `h264,hevc,vp9,av1` 软解，音频 `aac,mp3,opus,vorbis,flac`；`onMetaData` + 音频出声 | `examples/video.as` 能播自带样片；与 `adl` 逐项对齐（`videoWidth/Height`、`time`、`onMetaData`）；**格式矩阵自测**：每个容器×编码至少一个样本能出声出画；不碰视频的示例体积不变（§5.8） |
| V2 | **macOS 硬解 + 零拷贝上屏**：`videotoolbox` 后端覆盖 8 个 hwaccel（h264/hevc/mpeg1/2/4/h263/prores/vp9）+ `CVMetalTextureCache` 纹理桥；探测失败静默回退软解 | 同片源 A/B：user CPU、墙钟、纹理桥耗时；人为禁掉 VT 必须静默回退而非黑屏；HEVC 1080p 软/硬双跑对比 |
| V3 | **Windows D3D11VA 后端**（7 个 hwaccel）+ `pause/seek` + 缓冲状态 + `NetStream.Play.*` 事件序列 | 逐项对齐 `adl`；三端同一份 `.as` 行为一致（后端差异只允许在像素格式内部） |
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

## 16. 参考锚点

- AS3 语言参考：[`flash.net.NetStream`](https://airsdk.dev/reference/actionscript/3.0/flash/net/NetStream.html)、
  [`flash.media.Video`](https://airsdk.dev/reference/actionscript/3.0/flash/media/Video.html)、
  [`flash.media.VideoCodec`](https://airsdk.dev/reference/actionscript/3.0/flash/media/VideoCodec.html)
- FFmpeg 裁剪与许可：[`doc/configure.texi`](https://ffmpeg.org/ffmpeg-all.html)、[LGPL 合规](https://ffmpeg.org/legal.html)
- 本仓库相关文档：[`yuv-direct-render.md`](yuv-direct-render.md)（YUV 直通已实现）、
  [`audio.md`](audio.md)（miniaudio 后端与音频语义对齐）、
  [`flash-net.md`](flash-net.md)（`NetConnection`/`URLLoader` 现状）
- 仓库根分析：[`video-frame-copy-chain-analysis.md`](../../../video-frame-copy-chain-analysis.md)（RTC 帧拷贝链实测）、
  [`yuv-video-direct-draw-analysis.md`](../../../yuv-video-direct-draw-analysis.md)（YUV 直通收益）
