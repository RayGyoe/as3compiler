# 视频播放（`flash.net.NetStream` / `flash.media.Video`）调研与方案

> 本文回答一个问题：**AS3 的视频播放现在处于什么状态，要让它真的出画面需要做什么、用哪个开源方案**。
> 结论先行：**目前是零支持，而且是「响亮地零支持」**——`NetStream.play()` 直接抛
> `flash.net.NetStream.play: media transport and FLV decoding are not supported by this subset`
> （`src/emit.ts:16607`），`Video.attachNetStream()` 是空函数（`src/emit.ts:16630`）。全仓没有解复用器、
> 没有视频解码器、没有视频时钟。
>
> **本文状态：仅调研与立项依据，未排期实现**（用户 2026-11-11 裁决）。选型已定：**FFmpeg 裁剪**（§4）。
>
> 这份文档刻意区分了三件容易混为一谈的事：
> ① **解码**（H.264/AAC → YUV/PCM）、② **容器与传输**（MP4/FLV/HLS/RTMP）、③ **画到屏幕上**。
> 第 ③ 件**我们已经做完了**（YUV 直通，见 [`yuv-direct-render.md`](yuv-direct-render.md)），
> 真正要补的只有 ① 和 ②。

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
（`BitmapData` / `SkImage` 纹理），这也是我们相对那些从零写播放器的项目唯一的成本优势（§9）。

---

## 2. AS3 侧真实 API 面

权威来源是 [AIR 3.0 语言参考](https://airsdk.dev/reference/actionscript/3.0/)。要真正「播放一段视频」，
需要的不止 `NetStream` 一个类：

| 类 | 在播放路径上的作用 | 我们的现状 |
|---|---|---|
| `NetConnection` | 建连（`connect(null)` 用于本地/HTTP，`connect("rtmp://…")` 用于 RTMP） | 桩，`#2126` |
| `NetStream` | `play()` / `pause()` / `resume()` / `seek()` / `time` / `bufferTime` / `client` 回调（`onMetaData`、`onCuePoint`） | 抛错桩 |
| `Video` | 显示载体：`attachNetStream()` / `videoWidth` / `videoHeight` / `smoothing` | 空壳 |
| `VideoCodec` | `H264Avc` / `SorensonSpark` / `VP6` 常量 | 缺 |
| `NetStreamInfo` / `NetStreamPlayOptions` | 统计与切流 | 缺 |
| `StageVideo` | 硬件合成层（绕过显示列表） | 缺，见 §12 |

**`client` 回调是硬性语义**：`onMetaData` 里的 `width`/`height`/`duration`/`framerate` 决定
`Video.videoWidth/Height` 与进度条，AIR 里这是**播放器代码的第一依赖**。

---

## 3. 为什么「适配各种格式」这个目标该先砍小

我们对齐的基准是 AIR，而 AIR 的 `NetStream` 格式面**本来就很窄**：

| 维度 | AIR 桌面版事实 |
|---|---|
| 容器 | **FLV**（原生）、**MP4/M4A/MOV**（H.264/AAC）、MP3（纯音频）；部分平台支持 HLS |
| 视频编码 | **H.264 (AVC)**、**Sorenson Spark (H.263)**、**VP6** |
| 音频编码 | **AAC**、**MP3**、ADPCM、Nellymoser、Speex |
| 传输 | `file:` / `http:` / `rtmp:` / `rtmpt:` / `rtmps:` |
| **不支持** | HEVC、AV1、VP9、DASH、WebM |

所以「适配各种格式」在 AIR 语义下 = **H.264 + AAC + FLV/MP4 三件套**。
HEVC/AV1/VP9 在 AIR 里**没有对应物**，属于 AGENTS.md §1.5 意义上的**增强**——默认产物不需要，
要就得单独 opt-in，而且每个都是另一套库。

这条判断直接决定了体积：**我们不需要「一个能解所有格式的引擎」，只需要「一个能解 H.264+AAC 的小引擎」**。

---

## 4. 方案选型

### 4.1 三条候选路线

| | A. **FFmpeg 裁剪**（已裁决） | B. 平台硬解 | C. 小库组合 |
|---|---|---|---|
| 覆盖 | 全格式，与 AIR 超集 | H.264/HEVC/AV1/VP9（按平台） | H.264 baseline + AAC |
| 体积（静态链接，量级） | **1.5–3 MB**（裁剪后，含 H.264/AAC 解码器） | 0（系统框架） | ~1.2 MB |
| 许可证 | **LGPL-2.1+**（不带 `--enable-gpl`） | 系统 API，无额外义务 | BSD/Apache |
| 专利 | **风险自担**（LGPL 不授予 H.264/AAC 专利许可） | 由 OS/芯片厂商承担 | 同 A |
| 多端代码量 | **1 套** | **2 套**（VideoToolbox / Media Foundation；web 走浏览器、WASI 报错，见 §4.3） | 1 套，WASM 端排除 |
| 4K / 电量 | CPU 软解，1080p30 约单核 30–60% | 几乎零开销 | 同 A |
| 实现成本 | 编译 FFmpeg（一次性）+ 一层很薄的 C 胶水 | 每端 250–400 行，且 MF/VT 初始化易错 | 中 |

**裁决（2026-11-11）：走 A（FFmpeg 裁剪）**。理由是「一套代码覆盖三端 + 格式面一次到位」，
代价是体积与 §7 的合规动作；硬解（B）保留为**后续可选优化**，不与 A 冲突（同一层
`as_video_decode_*` 接口后面换实现即可）。

### 4.2 为什么不是另外两条

- **B（硬解）**：长期看综合最优（§4.3 给出三条理由），但要写平台代码，且我们这个项目最贵的
  资源是「跨端一致性」——多一套实现就多一份行为差异与 bug 面。它适合作为 A 落地之后的
  **按端替换**，而不是起点（注意：**是两套平台代码，不是三套**，见 §4.3）。
- **C（小库组合）**：`minih264` 其实是**编码器**（作者原话 "Minimalistic H264/SVC **encoder**
  single header library. Decoder can be popped up in future"），不能当解码器用；
  `OpenH264` 官方能力是 **Constrained Baseline**、无多线程，且 **Cisco 只为其发布的预编译二进制
  承担 MPEG-LA 专利费，自己从源码编译则专利责任落回自己**；`h264bsd` 只支持 baseline 且停更。
  AAC 更糟：`FAAD2` 是 **GPL-2**（与我们的 MIT 不兼容），`fdk-aac` 明确**不授予专利许可**。
  结论：**小库组合在 H.264/AAC 上根本凑不齐**，这不是偏好问题。

### 4.3 硬解为什么长期更优，以及它真实的边界

裁决是「先用 FFmpeg 落地」，但**长期看桌面两端应该被硬解替换掉**。三条理由，第三条最容易被忽略：

1. **体积倍数**：1.5–3 MB 对 `skia.lib` 是小头，但对我们的产物定义是硬伤——`hello.as` 那种 34 KB 的
   可执行文件会膨胀 50–90 倍。§2.6 用一整节讲 tree-shake 把 165 KB 压到 34 KB，再塞进 2 MB FFmpeg
   等于前面白做。
2. **专利归属**：硬解那笔 H.264/AAC 专利费操作系统与芯片厂商已经付过，我们只是调 API；软解时它落回
   我们自己（§7 那条，不是可以靠「用了开源库」消解的）。
3. **零拷贝**：软解出来的 YUV 在 **CPU 内存**里，每帧都要上传 GPU——720p NV12 = 1.38 MB/帧 × 30 fps =
   **41 MB/s**，而且这上传串行在渲染线程上。硬解直接产出 GPU 侧资源（macOS `CVPixelBuffer` 可 wrap 成
   Metal texture，Windows `ID3D11Texture2D` 可共享给 D3D12），**一帧都不用传**。
   注意这与 YUV 直通**不是**一回事：直通省的是 YUV→RGBA 的 CPU 转换（0.16 ms/帧），不是上传。

**平台代码是两套不是三套**：WASM 走浏览器（`<video>`/WebCodecs）、WASI 直接报错，都不需要写 codec。
真正要写的只有 **VideoToolbox（macOS）+ Media Foundation（Windows）**，各 250–400 行样板。
所以真实对比是「两套平台代码 + 0 体积」对「一套代码 + 1.5–3 MB + LGPL 义务」。

**分水岭是格式面会不会扩张**：只要停在 AIR 那一小片（H.264+AAC+FLV/MP4），硬解够用且全面更优；
一旦要 HLS、多路 RTMP、或 AIR 之外的 HEVC/AV1，硬解帮不上忙，FFmpeg 是唯一现实路径——而它一旦
进来，体积与 LGPL 就跟着进来。

**硬解的真实坑**（不写清楚就是虚假推荐）：High profile 不是到处能解（10-bit / 4:4:4 会失败，必须有
降级路径）；`AVCDecoderConfigurationRecord`（SPS/PPS）解析绕不开（软解也一样要写，不是硬解独有的成本）；
Media Foundation 的 `MFStartup` → `MFTEnumEx` → `SetInputType`/`SetOutputType` 顺序错了会**静默返回空帧**，
错误码很难读；老显卡/虚拟机偶发失败，必须探测能力并回落，否则表现为黑屏。

---

## 5. FFmpeg 裁剪清单

目标：只留「解 FLV/MP4 的 H.264+AAC+MP3，输出 YUV420P/NV12 + S16/F32 PCM」。**禁用一切编码器、
复用器、滤镜、设备、程序**。

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

要点与坑：

| 项 | 说明 |
|---|---|
| `--disable-network` | **不要传**。本地播放也常用 `http:`（CDN 上的 mp4），而它会关掉 `file:` 之外的一切协议。要 RTMP 才需要额外 `--enable-protocol=rtmp` 并链接 `librtmp`（另一件事，见 §11） |
| `h264` 解码器 | 单个解码器约 **500 KB** 量级（未 strip），是体积最大的一项；**不要**加 `--enable-gpl` 否则会引入 x264 系 |
| `aac` vs `aac_fixed` | 浮点版质量好、定点版省电；`miniaudio` 的混音管线是 f32，用浮点版可少一次转换 |
| `--disable-avfilter` | 我们不需要滤镜；缩放由 `swscale` 直接做（YUV420P → NV12 或 YUV420P 直通给 Skia） |
| `bsf=h264_mp4toannexb` | **只有走硬解时才必需**（硬解要 Annex B 起始码）。纯软解 + `swscale` 可以去掉，省几 KB |
| HLS | 需要 `--enable-demuxer=hls` + `--enable-protocol=crypto`（AES-128 解扰）+ `mpegts`；**首期不做**（§11） |
| 版本 | 锁定一个 tag（如 `n7.1`），不跟 master——FFmpeg 的 API 在 minor 之间会变（`avcodec_send_packet` 之后仍偶有字段语义调整） |

**构建落点**：按 AGENTS.md §2.9，FFmpeg 是**链接进来的库**，不是塞进生成的 `.c`。
清单里走 `link-libs` / `include-paths`，产物仍是「可读的 C + 第三方静态库」。

---

## 6. 体积与性能预期（量级，需实测）

| 项 | 预期 | 备注 |
|---|---|---|
| `libavformat` + `libavcodec` + `libavutil` + `libswscale` + `libswresample` 静态链接增量 | **1.5–3 MB**（strip 后，视裁剪精度） | 与现有 `skia.lib` 比是小头；但相比 `hello.as` 那种 30 KB 的产物就是巨物 |
| `h264` 解码 | 1080p30 约单核 **30–60%**；720p30 约 15–25% | 未开 SIMD 优化时会差一截（x86 要 `--enable-asm`） |
| 解码一帧 → `BitmapData`/纹理 | 已有 YUV 直通实测 **0.16 ms/帧 @720p**（I420 路） | 见 `video-frame-copy-chain-analysis.md` §8.4 |
| 首帧延迟 | 目标 **< 100 ms**（本地文件，含容器探测 + 首关键帧） | |

**验收必须实测，不接受估算**：裁剪后用 `size`/`llvm-size` 量段大小，用 `time` 量解码吞吐，
并把数字写回本文（现在的数字是量级，不是结论）。

---

## 7. LGPL 合规动作（硬性，不做的风险比体积更大）

FFmpeg 不带 `--enable-gpl` 时是 **LGPL-2.1-or-later**。我们的项目是 **MIT**，静态链接 LGPL 库
在分发给第三方时触发 LGPL-2.1 §6（"Combined Work"）的义务：

| 必须做 | 具体做法 |
|---|---|
| ① 不启用 GPL 组件 | 构建脚本里**禁止**出现 `--enable-gpl` / `--enable-nonfree`（会拉进 x264/x265/faac/libfdk 等） |
| ② 保留声明与版本 | 产物内可查 FFmpeg 版本（`av_version_info()`），`--version` 或关于页显示「Powered by FFmpeg (LGPL-2.1+)」 |
| ③ 满足「可重新链接」 | 我们交付的是**生成的 C 源码 + 构建清单 + 公开仓库**，用户可自行替换 FFmpeg 版本并重编——这正是 §6 要的「重新链接的能力」。**但如果将来做纯二进制商业分发，必须额外随包提供 FFmpeg 的 `.a`/目标文件，或改动态链接** |
| ④ 附许可证全文 | 分发产物附带 FFmpeg `COPYING.LGPLv2.1` 与源码获取地址 |
| ⑤ 不静态链接 GPL 解码器 | `FAAD2`（GPL-2）、`x264`（GPL-2）**一律不用**，即使用户要求 AAC 也不换 |

> **必须如实记录的一件事实：LGPL 不授予专利许可。** H.264 与 AAC 的专利池（MPEG-LA / Via LA）
> 与开源许可证是两回事。走硬解时这笔风险由操作系统/芯片厂商承担；**走 FFmpeg 软解时它落回我们自己头上**。
> 这不是可以靠「用了开源库」消解的，需业务侧知悉。若某天要规避，唯一干净的路径是切回 §4.1 的 B（硬解）。

---

## 8. 多端矩阵

| 端 | 解复用/解码 | 输出 | 备注 |
|---|---|---|---|
| macOS arm64 | FFmpeg（软解） | `AV_PIX_FMT_YUV420P` → Skia | `--enable-asm` 可用（arm64 NEON） |
| Windows x64 | FFmpeg（软解） | 同上 | `--enable-asm`（nasm/yasm 需在构建环境里，见 `checks.ts`） |
| Web（`--target wasm --package web`） | **两种形态**（见下） | `YUV420P` → WebGL/WebGPU | **默认走浏览器原生，不把 FFmpeg 编进 wasm** |
| WASI（`--target wasm`） | 无 | — | **响亮报错**「本后端不支持视频播放」，不静默降级 |
| Linux | FFmpeg（软解） | 同上 | 有 ELF 目标即能编；未实机验证 |

**Web 端的特殊处理（重要）**：把 FFmpeg 编成 wasm 会让产物从几百 KB 涨到 **4–8 MB** 且 720p 解码吃满
一个核。浏览器本来就有 `<video>` 与 `WebCodecs`——**默认走它们**，FFmpeg 只在 native 目标编。
这正好用上构建清单的 `targets.<target>` 分层语义（**替换**而非追加）：native 清单带 FFmpeg 的
`link-libs`，web 清单不带。

---

## 9. 与已有资产的衔接（我们真正的成本优势）

| 已有资产 | 视频播放怎么用 |
|---|---|
| **YUV 直通**（`yuv-direct-render.md`，四端 Skia 都有 `TextureFromYUVAPixmaps`） | FFmpeg 输出 `YUV420P` **直接喂纹理**，省掉一次 YUV→RGBA 的 CPU 转换（720p 约 1 ms/帧） |
| `BitmapData` 像素契约（内部 `0xAARRGGBB`） | 需要像素级访问时走「解码 → YUV → 按需物化」，不默认物化 |
| `vendor/audio_glue.c`（miniaudio） | **音频侧已能解 MP3/FLAC/WAV/Vorbis**；AAC 由 FFmpeg 解成 PCM 后直接喂 miniaudio 的 f32 混音管线，不需要另写音频设备层 |
| ANE 视频帧链（`getVideoBitmapData`） | 文件播放与 RTC 帧共用同一个「上传纹理」出口，只有上游不同 |
| 异步 job 表（`as_job_*`，阶段八十九·四十五） | 解复用/解码应挂在同一套后台任务上，不阻塞帧边界；解码器上下文是**长生命周期对象**，不能每帧重建 |

---

## 10. 实现落点（对齐 AGENTS.md 分层）

| 层 | 落点 | 禁止 |
|---|---|---|
| C 胶水 | `vendor/video_glue.c`（新）：`as_video_open/read_frame/decode/close`，封装 `AVFormatContext`/`AVCodecContext` | 在里面做 AS3 语义（`NetStream` 状态机归 codegen） |
| 运行时 | `src/runtime.ts` 的 `as_video_*` 声明 + no-op 桩（无 FFmpeg 的构建要响亮失败，不是静默返回空帧） | 生成 C 里出现 `avformat.h` |
| AS3 语义 | `src/emit.ts` 的 `NetStream`/`Video` 类：`play/pause/seek/time/client` 回调、`#2126` 等错误号 | 把解码逻辑写进 `emit.ts` |
| 构建 | `src/build.ts` 清单字段（`link-libs`/`include-paths`/`sources`）+ `checks.ts` 增一行「FFmpeg 头/库存在性」 | 在 CLI 分支另写一套检查 |

**错误语义**：`play()` 打不开 → `IOErrorEvent`；容器/编码不支持 → `NetStream.Play.Failed`
（与 AIR 文案对齐，需 `adl` 实测取文案）；**绝不允许「能编译、能跑、黑屏」**。

---

## 11. 分阶段计划（未排期）

| 阶段 | 内容 | 验收 |
|---|---|---|
| V0 | **本文落定 + FFmpeg 裁剪实测**：编出静态库，量体积、量 1080p 解码吞吐、跑通「mp4 → YUV420P 帧序列」命令行探针 | 体积/吞吐数字写回 §6；探针可复现 |
| V1 | **MP4(H.264+AAC) 本地/HTTP 播放**：`NetConnection.connect(null)` + `NetStream.play("file.mp4")` + `Video.attachNetStream` + `onMetaData` + 音频出声 | `examples/video.as` 能播自带样片；与 `adl` 逐项对齐（`videoWidth/Height`、`time`、`onMetaData` 字段） |
| V2 | **FLV**（AIR 原生容器）+ `pause/seek` + 缓冲状态 | 逐项对齐 `adl` |
| V3 | 传输：`http:` 渐进式 → RTMP（自研握手/chunk，**不引 librtmp** 以避免又一个 LGPL 依赖） | 对齐 AIR 的 `NetStream.Play.*` 事件序列 |
| V4 | **桌面两端用硬解替换 FFmpeg**（`as_video_decode_*` 换实现，AS3 侧一行不改），FFmpeg 退为 Linux / 需扩格式构建的 **opt-in** 依赖 | 同片源 A/B：帧时间、上传带宽、产物体积；硬解失败必须能回落到软解 |
| V5（增强，opt-in） | HLS（`mpegts`+`hls` demuxer）、HEVC/AV1 | 明确标注为增强，默认不启用 |

---

## 12. 明确不支持 / 延后

| 项 | 原因 |
|---|---|
| `NetStream.publish()`（推流/编码） | 需要 H.264 编码器（x264 是 GPL、OpenH264 编码侧有专利问题），且会议应用已走 TRTC |
| `StageVideo` | 需要绕过显示列表的独立合成层，与 `Stage3D` 同一量级的工作；先走 `Video` + 显示列表 |
| HEVC / AV1 / VP9 / WebM | AIR 无对应物，属增强；每个都是另一套库（libde265 LGPL-3 / dav1d BSD / libvpx BSD） |
| DRM（`NetStream.play` 的 `DRMContentData`） | AIR 自身在多数平台已不可用 |
| WASI 目标的视频 | 无窗口、无音频设备，做出来也无法验证 |

---

## 13. 待拍板项

1. **首期容器**：MP4 还是 FLV？取决于目标内容（本地样片/用户上传多为 MP4；AIR 遗留素材多为 FLV）。
2. **Web 端是否也编 FFmpeg**：建议**不编**（走 `<video>`/WebCodecs），但这会让「同一份 `.as` 三端行为一致」出现第一处真实分歧，需要显式记录。
3. **专利风险的业务口径**：§7 的那条（LGPL 不授予专利许可）由谁承担、是否接受。
4. **FFmpeg 版本锁定**：建议 `n7.1`，是否需要跟随更新。

---

## 14. 复现方法（当前可做的部分）

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

# 3) 裁剪实测（V0 阶段做，需先准备 FFmpeg 源码）
git clone --depth 1 -b n7.1 https://git.ffmpeg.org/ffmpeg.git build-tools/ffmpeg-src
cd build-tools/ffmpeg-src && ./configure <§5 的旗标> && make -j
llvm-size libavcodec/libavcodec.a     # 量体积
```

---

## 15. 参考锚点

- AS3 语言参考：[`flash.net.NetStream`](https://airsdk.dev/reference/actionscript/3.0/flash/net/NetStream.html)、
  [`flash.media.Video`](https://airsdk.dev/reference/actionscript/3.0/flash/media/Video.html)、
  [`flash.media.VideoCodec`](https://airsdk.dev/reference/actionscript/3.0/flash/media/VideoCodec.html)
- FFmpeg 裁剪与许可：[`doc/configure.texi`](https://ffmpeg.org/ffmpeg-all.html)、[LGPL 合规](https://ffmpeg.org/legal.html)
- 本仓库相关文档：[`yuv-direct-render.md`](yuv-direct-render.md)（YUV 直通已实现）、
  [`audio.md`](audio.md)（miniaudio 后端与音频语义对齐）、
  [`flash-net.md`](flash-net.md)（`NetConnection`/`URLLoader` 现状）
- 仓库根分析：[`video-frame-copy-chain-analysis.md`](../../../video-frame-copy-chain-analysis.md)（RTC 帧拷贝链实测）、
  [`yuv-video-direct-draw-analysis.md`](../../../yuv-video-direct-draw-analysis.md)（YUV 直通收益）
