// AudioPlayer.as — 带 UI 的音频播放器示例（阶段二百零一，文件盘一版：见下）。
//
// 这个示例现在同时是**声音**与**文件**两条能力的载体：
//   * 声音：Sound.load / extract / loadPCMFromByteArray / play / SoundChannel /
//     soundComplete / SoundTransform / id3，以及 loadCompressedDataFromByteArray；
//   * 文件：File 的元数据与 url、原生文件面板（browseForOpen / browseForSave）、
//     FileStream 的读（磁盘 → ByteArray → 解码）与写（PCM → 真 WAV 文件）；
//   * 网络：输入框里贴一个 `http(s)://` 地址就能播（`Sound.load` 的远程分支）。这条需要构建**链接了
//     HTTP 后端**，所以 player.build.json 里带了 `ASC_HAVE_CURL` + 静态 `vendor/curl`；没链接时
//     它不静默失败，会报“network URLs are not supported in this build”。
// 两者不是并列摆着：`Bytes` 那条路是「FileStream 读出字节 → 直接解码」，`Save WAV` 是
// 「解码后的 PCM → FileStream 写文件」，启动自检两条都跑一遍（不弹任何面板）。
//
// 为什么是「带窗口的播放器」而不是一个无头自检脚本：`SoundChannel` 的
// `soundComplete` 由**帧边界**的 `as_audio_tick()` 派发（见 src/runtime.ts 的
// as_audio_tick 与 src/emit.ts 里 Stage_dispatchFrame 的调用点），而离屏的自检钩子
// （`tickTimers`/`tickFrame`）**不驱动**它 —— 只有窗口事件循环（ASC_window_on_frame
// → Stage_dispatchFrame）会。所以「播放到结束」这件事只有在真实窗口里才成立，本示例
// 就是它的载体：窗口内可播放/暂停/停止/调音量/换文件，启动时再跑一遍脚本化自检并打印。
//
// 跑法（需要 arm64 SDL2 + Skia + miniaudio，见 docs/zh-cn/compile.md §6）：从**仓库根**跑，
// 因为下面那个默认路径是相对当前目录的：
//   node src/index.ts examples/audio/AudioPlayer.as \
//        --manifest examples/audio/player.build.json --run
// （回归套件只做 compile+link，不开窗；见 test/examples.ts 的
//  "example: audio/ (windowed: compile+link only)" 用例。）
//
// 夹具来源：`movers-vol2.mp3` —— Cambridge English 的 Movers Sample Listening Test vol2 录音
// （用户 2026-11-13 指定）。它是**第三方**素材（见 docs/zh-cn/audio.md §13.5 的开头）：只用来
// 在本机试听与量测，要不要进版本库由仓库主体的授权决定；断言里的字节数/时长/id3 字段都是
// 对**这个**文件实测出来的，换素材必须重测（不只是重编）。
//
// 它比早先那份自有夹具（TalkMED 产品视频音轨，118s / 1.89MB / 128kbps 立体声）长得多：
// 28.7 分钟、13.7MB、64kbps **单声道**。两件连带后果：
//   * `extract()` 恒把单声道复制成**立体声** float32（AIR 契约），所以 2 秒切片很容易算；
//   * 全曲解码后的 PCM 很大（单声道 float32 约 300MB），所以「读字节再解码」这组自检只解码
//     文件**前缀**（512KB），整文件那条路留给「Bytes」按钮手动触发。
//
// 无设备的主机不会静默假装：`SoundMixer.areSoundsInaccessible()` 为真时播放断言整组
// 跳过并**打印原因**（AGENTS.md §1.5），解码/长度/id3/文件那几组仍然照跑。
//
// 换文件：**走 AIR 的原生文件面板**（`File.browseForOpen`）。这条早期在本后端没有实现，
// 早期版本的示例只好用一个可编辑的路径输入框来代替；现在 macOS 的 Cocoa 与 Windows 的
// `IFileDialog` 都已接入默认窗口构建（见 docs/zh-cn/desktop-file-interaction.md，
// 构建层通过 ASC_USE_FILE_DIALOG 自动给），所以这里换成真面板 —— 对话框里选什么都行，
// 选中后照旧解码、播、并把这轮的文件元数据刷到界面上。路径输入框被删掉了：
// 留一个「能手打、但对话框才是正路」的输入框只会让人以为面板还不能用。
import flash.display.Shape;
import flash.display.Sprite;
import flash.display.Stage;
import flash.events.Event;
import flash.events.IOErrorEvent;
import flash.events.MouseEvent;
import flash.filesystem.File;
import flash.filesystem.FileMode;
import flash.filesystem.FileStream;
import flash.media.Sound;
import flash.media.SoundChannel;
import flash.media.SoundMixer;
import flash.media.SoundTransform;
import flash.net.FileFilter;
import flash.net.URLRequest;
import flash.text.TextField;
import flash.text.TextFormat;
import flash.utils.ByteArray;
import flash.utils.setTimeout;

// ---------------------------------------------------------------------------
// 自检记账（与 examples/native-window.as 同口径：逐条断言，最后打印汇总）
// ---------------------------------------------------------------------------
var passed:int = 0;
var failed:Array = [];

function ck(label:String, ok:Boolean):void {
  if (ok) { passed++; }
  else { failed.push(label); trace("FAIL " + label); }
}

// 秒数格式化：显式取整，不用 toFixed（避免依赖格式化实现的小数口径）。
function fmtSec(ms:Number):String {
  if (ms < 0) ms = 0;
  var whole:int = Math.floor(ms / 1000);
  var hundredths:int = Math.floor((ms - whole * 1000) / 10);
  var tail:String = hundredths < 10 ? ("0" + hundredths) : String(hundredths);
  return whole + "." + tail + "s";
}

// ---------------------------------------------------------------------------
// 布局
// ---------------------------------------------------------------------------
var WIN_W:Number = 480;
var WIN_H:Number = 392;
var BAR_X:Number = 16;
var BAR_Y:Number = 132;
var BAR_W:Number = 448;
var BAR_H:Number = 10;
var WAV_FRAMES:int = 88200;          // 2.0s @44100（extract 的 length 是**采样帧数**）

var stage:Stage = new Stage();

function mkLabel(x:Number, y:Number, w:Number, h:Number, size:Number, color:uint):TextField {
  var t:TextField = new TextField();
  t.x = x; t.y = y; t.width = w; t.height = h;
  t.selectable = false;
  t.multiline = true;
  t.wordWrap = true;
  t.textColor = color;
  var f:TextFormat = new TextFormat();
  f.size = size;
  t.defaultTextFormat = f;
  return t;
}

// 一个按钮 = 底色矩形（Shape）+ 文字（TextField），整体是个 Sprite；点击挂在 Sprite 上
// （命中走子件的绘制区域，与 examples/window_click.as 同路子）。
function mkButton(label:String, x:Number, y:Number, w:Number, h:Number, col:uint, onTap:Function):Sprite {
  var b:Sprite = new Sprite();
  b.x = x; b.y = y;
  var g:Shape = new Shape();
  g.graphics.beginFill(col);
  g.graphics.drawRect(0, 0, w, h);
  g.graphics.endFill();
  b.addChild(g);
  var t:TextField = new TextField();
  t.x = 6; t.y = 5; t.width = w - 12; t.height = h - 8;
  t.selectable = false; t.textColor = 0xFFFFFF;
  var f:TextFormat = new TextFormat();
  f.size = 12;
  t.defaultTextFormat = f;
  t.text = label;
  b.addChild(t);
  b.addEventListener("click", onTap);
  return b;
}

// ---------------------------------------------------------------------------
// 播放器状态
// ---------------------------------------------------------------------------
var snd:Sound = null;                 // 当前载入的音源
var chan:SoundChannel = null;         // 正在播的通道（null = 未播/已停）
var vol:Number = 1.0;                 // 0..1
var resumeMs:Number = 0;              // 暂停/拖动后的续播位置
var clipPath:String = "examples/audio/movers-vol2.mp3";
var PREFIX_BYTES:int = 524288;        // 4xxKB：给「读字节再解码」自检用的前缀长度（见 fileChecks）
var clip:File = null;                 // 当前文件的 File 视图（nativePath / url / size / name）
var isRemote:Boolean = false;         // 当前数据源是 http(s) 地址（没有 File 视图，FileStream 那套不适用）
var phase:String = "empty";           // empty / loading / loaded / playing / paused / stopped / finished
var doneFired:Boolean = false;        // soundComplete 是否到达
var autoPlay:Boolean = false;         // 载入完成后是否自动起播（远程载入不在调用点同步完成）
var fixtureChecks:Boolean = false;    // 只在启动那次载入夹具时跑「载入面」自检
var shortSnd:Sound = null;            // 短片段（从夹具 extract 出来的真实音频）
var shortChan:SoundChannel = null;
var status:String = "";               // 面板/写盘的结果行（对话框取消也照实写）

var infoTf:TextField = mkLabel(16, 38, 448, 66, 12, 0xDDDDDD);
var posTf:TextField = mkLabel(16, 106, 448, 18, 12, 0x9BE39B);
var barBg:Shape = new Shape();
var barFill:Shape = new Shape();
var fileTf:TextField = mkLabel(16, 252, 448, 44, 11, 0xAED6F1);
var hintTf:TextField = mkLabel(16, 300, 448, 48, 11, 0x999999);
// 地址/路径输入框：本地文件走上面的 Open... 面板，但**网络地址只能靠打字**（面板只给本地路径）。
// 旧版把它当“原生面板缺位时的替代品”，那时确实只是替代；现在面板在了，它留下的是它独占的那个能力。
var urlTf:TextField = mkLabel(16, 224, 350, 22, 11, 0xE8E8E8);

function setInfo(msg:String):void {
  infoTf.text = msg;
}

// ---------------------------------------------------------------------------
// 文件面：File 元数据 + FileStream 读写
// ---------------------------------------------------------------------------
function adoptFile(p:String):void {
  // `new File(相对路径)` 抛 #2004 —— 构造器与 nativePath setter 都只收**绝对**路径，与
  // adl 一致（docs/zh-cn/filesystem.md §11.5）。所以先把相对路径按**进程 CWD** 解成绝对：
  // `File.workingDirectory.resolvePath()` 对已经是绝对的参数原样返回（§11 的同一条实测），
  // 于是面板给回来的绝对路径和这里的默认相对路径走同一条分支。
  var f:File = File.workingDirectory.resolvePath(p);
  // 路径存在时 canonicalize() 走 realpath（再折掉符号链接）；不存在时只做词法归一化，
  // 不谎报存在性。url 在绝对路径上才是 AIR 的 `file:///...` 形状（§11）。
  f.canonicalize();
  clip = f;
  clipPath = f.nativePath;
  refreshFileInfo();
}

function refreshFileInfo():void {
  if (isRemote) {
    fileTf.text = "remote " + clipPath
      + "\n(no File view: Bytes / Save WAV need a local file)"
      + (status.length > 0 ? "\n" + status : "");
    return;
  }
  if (clip == null) { fileTf.text = status; return; }
  var s:String = "";
  if (clip.exists) {
    s = clip.name + "   " + clip.size + " B   (" + fmtMB(clip.size) + ")\n"
      + clip.nativePath;
  } else {
    s = clipPath + "\n(not found -- run from the repository root)";
  }
  if (status.length > 0) s += "\n" + status;
  fileTf.text = s;
}

function fmtMB(bytes:Number):String {
  var mb:Number = bytes / (1024 * 1024);
  var tenths:int = Math.round(mb * 10);
  return (tenths / 10) + " MB";
}

// 磁盘 → ByteArray。`readBytes(ba, 0, 0)` 的 length 0 表示「读到流末尾」，与 AIR 一致。
function fileBytes(f:File):ByteArray {
  var fs:FileStream = new FileStream();
  fs.open(f, FileMode.READ);
  var ba:ByteArray = new ByteArray();
  try {
    fs.readBytes(ba, 0, 0);
  } finally {
    fs.close();
  }
  ba.position = 0;
  return ba;
}

// float32 → 16-bit PCM。extract() 的数据是**归一化到 ±1 的浮点**，越界只能削平：
// 直接乘 32767 会溢出成反相的噪声，所以先夹再取整。
function toPcm16(v:Number):int {
  if (isNaN(v)) v = 0;
  if (v > 1) v = 1;
  if (v < -1) v = -1;
  var s:int = Math.round(v * 32767);
  if (s > 32767) s = 32767;
  if (s < -32768) s = -32768;
  return s;
}

// PCM → 一个真能播的 WAV（44 字节 RIFF 头 + 16-bit 立体声小端样本）。
//
// 两个字节序陷阱都在这一个函数里，且方向相反：
//   * `Sound.extract()` 往 ByteArray 里写的是**目标数组当时的 endian**（默认 bigEndian，
//     即 4 字节大端 float），所以回读要用默认 endian 的 readFloat()；
//   * WAV 要的是**小端 16-bit**，所以样本写进另一个 `endian = "littleEndian"` 的数组。
// 把这两个混在一起（例如先给 pcm 切小端再 readFloat）读出来的是字节翻转的噪声。
function writeWav(target:File, frames:int):int {
  if (snd == null) return 0;
  var pcm:ByteArray = new ByteArray();
  var got:int = snd.extract(pcm, frames, 0);   // 显式给 startPosition：不给就是接着上次的游标
  if (got <= 0) return 0;
  pcm.position = 0;
  var data:ByteArray = new ByteArray();
  data.endian = "littleEndian";
  var n:int = 0;
  while (pcm.bytesAvailable >= 8) {            // 每帧 2 声道 × 4 字节 float
    var l:Number = pcm.readFloat();
    var r:Number = pcm.readFloat();
    data.writeShort(toPcm16(l));
    data.writeShort(toPcm16(r));
    n++;
  }
  var out:ByteArray = new ByteArray();
  out.endian = "littleEndian";
  out.writeUTFBytes("RIFF");
  out.writeInt(36 + n * 4);                    // 块大小 = 4 + (8+16) + (8 + 数据)
  out.writeUTFBytes("WAVE");
  out.writeUTFBytes("fmt ");
  out.writeInt(16);                            // PCM 的 fmt 块长度
  out.writeShort(1);                           // format = 1 (PCM)
  out.writeShort(2);                           // 声道
  out.writeInt(44100);                         // 采样率（extract 恒为 44100）
  out.writeInt(44100 * 2 * 2);                 // byteRate = rate × 声道 × 样本字节
  out.writeShort(4);                           // blockAlign
  out.writeShort(16);                          // bits per sample
  out.writeUTFBytes("data");
  out.writeInt(n * 4);
  out.writeBytes(data, 0, data.length);

  var fs:FileStream = new FileStream();
  fs.open(target, FileMode.WRITE);
  try {
    fs.writeBytes(out, 0, out.length);
  } finally {
    fs.close();
  }
  return n;
}

// ---------------------------------------------------------------------------
// 载入（异步任务 + 一次 tickTimers 排空，本地文件因此是确定性的）
// ---------------------------------------------------------------------------
// 数据源有两种形状，且**不能合并处理**：
//   * 本地路径（面板给的绝对路径 / 启动默认的相对路径）→ 走 File/FileStream 那一整套；
//   * 网络地址（http:// https://）→ 只能是 URLRequest，File 那套对它根本不存在
//     （`new File("https://…")` 抛 #2004，因为 File 只活在本地文件系统里）。
function looksRemote(u:String):Boolean {
  return u.indexOf("http://") == 0 || u.indexOf("https://") == 0;
}

function loadFrom(p:String):void {
  isRemote = looksRemote(p);
  if (isRemote) {
    clip = null;                 // 远程源没有 File 视图，FileStream/Bytes/写盘三件事都不可用
    clipPath = p;
  } else {
    adoptFile(p);
  }
  phase = "loading";
  setInfo("loading " + clipPath + " ...");
  snd = new Sound();
  snd.addEventListener(Event.COMPLETE, onLoaded);
  snd.addEventListener(IOErrorEvent.IO_ERROR, onLoadErr);
  // 本地走 clip.url：这是 AIR 的正路（File.url 是 URL，Sound.load 认它），顺带验证 §11 的
  // 「URL ↔ 路径」互转。远程就直接把用户给的地址交给它（远程分支是异步 HTTP，不是本地读）。
  snd.load(new URLRequest(isRemote ? clipPath : clip.url));
  // 本地读取 + 解码是一个异步任务；tickTimers() 等 worker 排空并派发终态事件，
  // 所以本地文件在这一行之后就一定是已解码状态（见 docs/zh-cn/as3-semantics.md）。
  //
  // 远程**不**在这里排空：tickTimers 的等法是 as_async_tick_wait，会把窗口冻到下载完
  // （这份 13.7MB 要十几秒）。不排空则交给窗口帧循环里那个**非阻塞**的 as_async_tick()
  // 逐帧推进，下载期间界面照旧刷新、进度可见，COMPLETE 到达时自动续播（见 onLoaded）。
  if (!isRemote) {
    tickTimers();
  } else {
    // 远程边下边播：MP3 是**渐进式**的（audio_glue 的 streaming 缓冲按帧解码），所以
    // load() 之后立刻 play() 就返回通道、第一批帧到手就出声——这正是 AIR 的行为。
    // 非 MP3（wav/flac/…）没有渐进解码，整包到手才解，此时 play() 抛 `#2068: Invalid
    // sound.`；那就诚实地等到 COMPLETE 再起播（界面也这么写），不假装能提前出声。
    try {
      startPlay(0);
    } catch (e:Error) {
      autoPlay = true;
      setInfo("loading " + clipPath + "\n(this format is not progressive: playback starts when the transfer completes)");
    }
  }
  refreshFileInfo();
}

function onLoadErr(e:IOErrorEvent):void {
  phase = "empty";
  autoPlay = false;
  fixtureChecks = false;
  setInfo("cannot load " + clipPath + "\n" + e.text);
  trace("audio-player: load failed: " + e.text);
  refreshFileInfo();
}

function onLoaded(e:Event):void {
  // 下载中已经起播时不要把它改回 "loaded"：phase 驱动界面文字与按钮语义。
  if (phase == "loading") phase = "loaded";
  refreshInfo();
  trace("audio-player: loaded " + clipPath + " len=" + snd.length + " bytes=" + snd.bytesTotal);
  // 「载入面」那组自检只在**启动那次**载入夹具时跑：面板换文件、贴网络地址都会跑到这里，
  // 而那些断言绑的是夹具的字节数/时长/id3——拿它们去量别的源只会制造假红。
  if (fixtureChecks) { fixtureChecks = false; loadFaceChecks(); }
  // 远程载入不在调用点同步完成，起播就在这里补（本地在 loadFrom 里排空时也已经走到这里）。
  if (autoPlay) {
    autoPlay = false;
    if (!SoundMixer.areSoundsInaccessible()) startPlay(0);
  }
}

// 载入面自检：这些都是 AIR 的 Sound.load 契约（只对夹具跑，见 onLoaded）。
function loadFaceChecks():void {
  ck("load: bytesTotal is the file size (13710403)", snd.bytesTotal == 13710403);
  ck("load: bytesLoaded == bytesTotal after COMPLETE", snd.bytesLoaded == snd.bytesTotal);
  ck("load: url names the loaded file", snd.url != null && snd.url.indexOf("movers-vol2.mp3") >= 0);
  // 实测口径：load() 过的 Sound，isBuffering 在 COMPLETE 后仍为 true（load() 建的对象
  // 恒为该值，见 src/emit.ts 的 Sound__finish 注释），而 loadPCMFromByteArray 那条路为 false。
  ck("load: isBuffering stays true for a load()ed Sound", snd.isBuffering == true);
  // Sound.length 的单位是**毫秒**（不是秒）：这个文件 65 915 帧 × 1152/44100 = 1 721 861ms。
  // 它是 MPEG 的“名义时长”（帧数驱动，不信容器），与 adl 同口径。
  ck("load: length is the nominal duration (~1721861ms)", snd.length > 1721860 && snd.length < 1721862);
  // ID3v2.3 标签里**没有** TIT2/TPE1/TALB（这个文件只有 TRCK/TYER/TENC，见 §13.5 的表），
  // 所以歌曲名/艺术家/专辑读出来就是 null —— AIR 对缺失的帧不编造空串。
  ck("id3: track from TRCK", snd.id3.track == "1");
  ck("id3: year from TYER", snd.id3.year == "2013");
  ck("id3: absent TIT2/TPE1/TALB read as null",
    snd.id3.songName == null && snd.id3.artist == null && snd.id3.album == null);
}

function refreshInfo():void {
  // 远程源在下载中：bytesLoaded 逐帧长，bytesTotal 是 Content-Length（分块传输时为 0）。
  var dl:String = (snd.bytesTotal > 0 && snd.bytesLoaded < snd.bytesTotal)
    ? ("  downloading " + Math.floor(100 * snd.bytesLoaded / snd.bytesTotal) + "%")
    : "";
  // "source" 而不是 "file"：远程地址不是一个文件（没有 File 视图），这一行说的是「数据源」。
  setInfo("source " + clipPath + dl + "\n"
    + "bytes  " + snd.bytesLoaded + " / " + snd.bytesTotal + "\n"
    + "len    " + fmtSec(snd.length) + "   " + id3Summary());
}

// 这个夹具没有 TIT2/TPE1，直接拼 songName 会显示 "null - null"；有就照实显示，没有就说没有。
function id3Summary():String {
  if (snd.id3.songName != null || snd.id3.artist != null) {
    return "id3  " + snd.id3.songName + " - " + snd.id3.artist;
  }
  return "id3  (no TIT2/TPE1; track " + snd.id3.track + ", year " + snd.id3.year + ")";
}

// ---------------------------------------------------------------------------
// 文件面自检：不弹任何面板，启动时跑一遍（File 元数据 / 读字节解码 / 写 WAV 再读回）
// ---------------------------------------------------------------------------
function fileChecks():void {
  // File 的元数据。
  ck("file: exists", clip.exists);
  ck("file: size is the mp3 byte count", clip.size == 13710403);
  ck("file: name / extension come from the path",
    clip.name == "movers-vol2.mp3" && clip.extension == "mp3");
  ck("file: url is a file URL", clip.url.indexOf("file://") == 0);
  ck("file: parent is the audio/ directory", clip.parent.name == "audio");

  // FileStream READ → Sound.loadCompressedDataFromByteArray：不经 URLRequest 的同一条解码链。
  var ba:ByteArray = fileBytes(clip);
  ck("file: FileStream read the whole file", ba.length == 13710403);
  // 只解码**前綴**：这条文件解码后的 PCM 约 300MB（单声道 28.7 分钟 × float32），而解码结果是登记在
  // 音频注册表里的、不归还 —— 为了自检再整曲解一遍会让进程常驻两份。前綴 512KB @64kbps ≈ 65.5s，
  // 所以时长可验：512×1024×8/64000 = 65536ms。
  ba.length = PREFIX_BYTES;
  ba.position = 0;
  var bs:Sound = new Sound();
  bs.loadCompressedDataFromByteArray(ba, PREFIX_BYTES);
  ck("bytes: bytesTotal is the slice length", bs.bytesTotal == PREFIX_BYTES);
  ck("bytes: the 512KB prefix decodes to its 64kbps duration (~65.5s)",
    bs.length > 65000 && bs.length < 66100);

  // FileStream WRITE → 真 WAV，再把头读回来逐字段核对。临时文件用 File.createTempFile()：
  // 落在系统 TMPDIR 里（与 AIR 一致，由系统清理），这里主动删掉以顺带验证 deleteFile()。
  var tmp:File = File.createTempFile();
  var frames:int = writeWav(tmp, WAV_FRAMES);
  ck("wav: extract produced the requested frames", frames == WAV_FRAMES);
  ck("wav: file size is 44 + frames*2ch*2B", tmp.size == 44 + WAV_FRAMES * 4);

  var hdr:FileStream = new FileStream();
  hdr.open(tmp, FileMode.READ);
  // FileStream 默认 bigEndian（AIR 口径），WAV 是小端：读多字节字段前必须切过来。
  hdr.endian = "littleEndian";
  var riff:String = hdr.readUTFBytes(4);
  var riffLen:int = hdr.readInt();
  var wave:String = hdr.readUTFBytes(4);
  ck("wav: RIFF / size-8 / WAVE", riff == "RIFF" && riffLen == tmp.size - 8 && wave == "WAVE");
  var fmtTag:String = hdr.readUTFBytes(4);
  var fmtLen:int = hdr.readInt();
  var pcmTag:int = hdr.readShort();
  var chans:int = hdr.readShort();
  var rate:int = hdr.readInt();
  var byteRate:int = hdr.readInt();
  var align:int = hdr.readShort();
  var bits:int = hdr.readShort();
  ck("wav: fmt is 16-byte PCM", fmtTag == "fmt " && fmtLen == 16 && pcmTag == 1);
  ck("wav: 2ch / 44100 / byteRate 176400 / align 4 / 16-bit",
    chans == 2 && rate == 44100 && byteRate == 176400 && align == 4 && bits == 16);
  var dataTag:String = hdr.readUTFBytes(4);
  var dataLen:int = hdr.readInt();
  ck("wav: data chunk covers every frame", dataTag == "data" && dataLen == WAV_FRAMES * 4);
  hdr.close();

  tmp.deleteFile();
  ck("file: deleteFile removes the temp file", !tmp.exists);
}

// ---------------------------------------------------------------------------
// 播放控制
// ---------------------------------------------------------------------------
function startPlay(from:Number):void {
  if (snd == null) return;
  // 下载中也能播：远程 MP3 是**渐进式**解码（audio_glue.c 的 streaming 缓冲按帧解），
  // 所以 load() 之后立刻 play() 就返回通道，第一批帧到手就出声 —— 这正是 AIR 的行为。
  // 不能再加「载入中直接 return」那种前置拦截：那会让 #2068 之外的所有进度白等（见 §13.6）。
  // 非渐进格式（wav/flac/…）仍然会抛 `#2068: Invalid sound.`，由调用点 try/catch 回退。
  autoPlay = false;                       // 已经有人要求播了，别再在 COMPLETE 时重起
  if (chan != null) { chan.stop(); chan = null; }
  var st:SoundTransform = new SoundTransform(vol, 0);
  chan = snd.play(from, 0, st);
  if (chan == null) { phase = "loaded"; return; }   // 无后端：诚实返回 null，不造假通道
  doneFired = false;
  var c:SoundChannel = chan;
  c.addEventListener(Event.SOUND_COMPLETE, onMainDone);
  resumeMs = from;
  phase = "playing";
}

function onMainDone(e:Event):void { phase = "finished"; }

function doPlay():void {
  if (snd == null) return;
  startPlay(phase == "paused" ? resumeMs : 0);
}
function doPause():void {
  if (chan == null) return;
  resumeMs = chan.position;
  chan.stop();
  chan = null;
  phase = "paused";
}
function doStop():void {
  if (chan != null) { chan.stop(); chan = null; }
  resumeMs = 0;
  phase = "stopped";
}
function seekBy(deltaMs:Number):void {
  if (snd == null) return;
  var base:Number = chan != null ? chan.position : resumeMs;
  var target:Number = base + deltaMs;
  if (target < 0) target = 0;
  if (target > snd.length - 150) target = snd.length - 150;
  if (target < 0) target = 0;
  resumeMs = target;
  startPlay(target);
}
function setVol(v:Number):void {
  if (v < 0) v = 0;
  if (v > 1) v = 1;
  vol = v;
  // 活通道的音量走 soundTransform（AIR：改它立刻作用于正在播的声音）。
  if (chan != null) chan.soundTransform = new SoundTransform(vol, 0);
}

// 载入一个新路径/地址（对话框选中后、或输入框里点 Load，都走这里）。
function doLoadPath(p:String):void {
  if (p == null || p.length == 0) return;
  doStop();
  autoPlay = true;          // 被 onLoaded 消费：本地当场起播，远程在 COMPLETE 那一帧起播
  loadFrom(p);
}

// 输入框 → Load。能贴的东西只有两种：本地路径与 http(s) 地址（见 loadFrom 的两个分支）。
// 尾部空白要去掉：中文输入法/粘贴很容易带一个尾空格，而路径里多一个空格就是另一个文件。
function doLoadUrl():void {
  var u:String = urlTf.text;
  if (u == null) return;
  var a:int = 0;
  var b:int = u.length - 1;
  while (a <= b && isSpace(u.charCodeAt(a))) a++;
  while (b >= a && isSpace(u.charCodeAt(b))) b--;
  if (b < a) return;
  u = u.substring(a, b + 1);
  urlTf.text = u;
  status = looksRemote(u) ? "remote source" : "local path";
  doLoadPath(u);
}

function isSpace(c:int):Boolean {
  return c == 32 || c == 9 || c == 10 || c == 13;
}

// ---------------------------------------------------------------------------
// 原生文件面板：打开（browseForOpen）与保存（browseForSave）
// ---------------------------------------------------------------------------
var picked:File = new File();          // browseForOpen 的就地更新目标
var saveTo:File = new File();          // browseForSave 的就地更新目标

function onPicked(e:Event):void {
  status = "picked " + picked.name;
  doLoadPath(picked.nativePath);
}
function onBrowseCancelled(e:Event):void {
  // AIR 的取消路径是 CANCEL 事件，不是异常；本后端也不伪造一个 SELECT。
  status = "open cancelled";
  refreshFileInfo();
}
function doBrowseOpen():void {
  // 初始目录取这个 File 当前的路径（AIR 口径）：从当前文件所在目录开始翻。
  picked.nativePath = clip != null ? clip.nativePath : clipPath;
  picked.browseForOpen("Open an audio file", [
    new FileFilter("Audio", "*.mp3;*.wav"),
    new FileFilter("All files", "*.*")
  ]);
}
function onSavePathChosen(e:Event):void {
  var n:int = writeWav(saveTo, WAV_FRAMES);
  status = n > 0 ? ("wrote " + saveTo.name + "  " + saveTo.size + " B") : "nothing to write";
  refreshFileInfo();
  trace("audio-player: wav -> " + saveTo.nativePath + " frames=" + n + " bytes=" + saveTo.size);
}
function doSaveWav():void {
  if (snd == null) { status = "load a file first"; refreshFileInfo(); return; }
  if (clip == null) { status = "Save WAV needs a local file (remote source has no File view)"; refreshFileInfo(); return; }
  // 建议名与建议目录都给出来，但最终路径由面板决定；面板只给路径，写盘是我们自己做的。
  saveTo = clip.parent.resolvePath("extract.wav");
  saveTo.browseForSave("Save 2s of audio as 16-bit PCM WAV");
}

// ---------------------------------------------------------------------------
// 每帧刷新（窗口的帧循环会重绘 stage，所以改图形/文字后立刻可见）
// ---------------------------------------------------------------------------
function updateUi():void {
  // 下载中也要让「到手的字节/已解码时长」逐帧长出来：这两个数正是渐进式播放的证据，
  // 只在 COMPLETE 时刷新一次就等于整段下载期间什么都没说。
  if (snd != null && (phase == "loading" || (snd.bytesTotal > 0 && snd.bytesLoaded < snd.bytesTotal))) refreshInfo();
  var durMs:Number = snd != null ? snd.length : 0;
  var posMs:Number = chan != null ? chan.position : resumeMs;
  posTf.text = fmtSec(posMs) + " / " + fmtSec(durMs)
    + "   vol " + Math.round(vol * 100) + "%   [" + phase + "]"
    + (doneFired ? "   soundComplete!" : "");
  var frac:Number = durMs > 0 ? posMs / durMs : 0;
  if (frac < 0) frac = 0;
  if (frac > 1) frac = 1;
  barFill.graphics.clear();
  barFill.graphics.beginFill(0x2E8B57);
  barFill.graphics.drawRect(0, 0, BAR_W * frac, BAR_H);
  barFill.graphics.endFill();
}
stage.addEventListener(Event.ENTER_FRAME, function(e:Event):void { updateUi(); });

// ---------------------------------------------------------------------------
// 短片段 soundComplete 自检：从夹具里 extract 0.5s 真实音频再播到结束。
// 长片段要等 118 秒才能结束，所以这条用真音频的短切片，几帧内就能观察到终态。
// ---------------------------------------------------------------------------
function startShort():void {
  if (snd == null) return;
  var pcm:ByteArray = new ByteArray();
  snd.extract(pcm, 22050, 0);                                // 0.5s，恒为 44100Hz 立体声 f32
  // extract() 把目标的位置留在数据末尾，而 loadPCMFromByteArray 是**从当前位置**读的 ——
  // 不归零就是 0 字节可用，AIR 会抛 ArgumentError #2084（examples/audio.as 同样归零）。
  pcm.position = 0;
  shortSnd = new Sound();
  shortSnd.loadPCMFromByteArray(pcm, 22050, "float", true, 44100);
  shortChan = shortSnd.play(0, 0, new SoundTransform(vol, 0));
  if (shortChan != null) shortChan.addEventListener(Event.SOUND_COMPLETE, function(e:Event):void { doneFired = true; });
}

// ---------------------------------------------------------------------------
// UI 组装
// ---------------------------------------------------------------------------
var titleTf:TextField = mkLabel(16, 12, 448, 22, 16, 0xFFFFFF);
titleTf.text = "TalkMED AOT audio player  (sound + files)";

barBg.graphics.beginFill(0x333333);
barBg.graphics.drawRect(0, 0, BAR_W, BAR_H);
barBg.graphics.endFill();
barBg.x = BAR_X; barBg.y = BAR_Y;

barFill.x = BAR_X; barFill.y = BAR_Y;

hintTf.text = "Play/Pause/Stop, \u00b110% volume, \u00b110s seek.\n"
  + "Open... uses the native panel; the box below takes a path OR an http(s) URL, then Load."
  + "\nBytes reads the file with FileStream then loadCompressedDataFromByteArray "
  + "(local only); Save WAV writes 2s of 16-bit PCM through FileStream.";

urlTf.text = clipPath;
urlTf.type = TextFieldType.INPUT;
urlTf.border = true;
urlTf.background = true;
urlTf.backgroundColor = 0x1E1E1E;
urlTf.borderColor = 0x666666;
urlTf.multiline = false;
urlTf.wordWrap = false;

stage.addChild(titleTf);
stage.addChild(infoTf);
stage.addChild(posTf);
stage.addChild(barBg);
stage.addChild(barFill);

stage.addChild(mkButton("Play", 16, 152, 70, 28, 0x2E7D32, function(e:MouseEvent):void { doPlay(); }));
stage.addChild(mkButton("Pause", 92, 152, 70, 28, 0x1565C0, function(e:MouseEvent):void { doPause(); }));
stage.addChild(mkButton("Stop", 168, 152, 70, 28, 0x8D6E63, function(e:MouseEvent):void { doStop(); }));
stage.addChild(mkButton("Vol -", 244, 152, 60, 28, 0x455A64, function(e:MouseEvent):void { setVol(vol - 0.1); }));
stage.addChild(mkButton("Vol +", 310, 152, 60, 28, 0x455A64, function(e:MouseEvent):void { setVol(vol + 0.1); }));
stage.addChild(mkButton("\u00ab10s", 16, 188, 68, 28, 0x5D4037, function(e:MouseEvent):void { seekBy(-10000); }));
stage.addChild(mkButton("10s\u00bb", 90, 188, 68, 28, 0x5D4037, function(e:MouseEvent):void { seekBy(10000); }));
stage.addChild(mkButton("Open...", 164, 188, 92, 28, 0x6A1B9A, function(e:MouseEvent):void { doBrowseOpen(); }));
stage.addChild(mkButton("Bytes", 262, 188, 88, 28, 0x00838F, function(e:MouseEvent):void {
  // 同一条文件，另一种到达方式：面板拿路径，FileStream 拿字节，解码器拿字节。
  if (clip == null) { status = "Bytes needs a local file (remote source has no File view)"; refreshFileInfo(); return; }
  doStop();
  var ba:ByteArray = fileBytes(clip);
  snd = new Sound();
  snd.loadCompressedDataFromByteArray(ba, ba.length);
  refreshInfo();
  status = "decoded " + ba.length + " B from FileStream";
  refreshFileInfo();
  if (!SoundMixer.areSoundsInaccessible()) startPlay(0);
}));
stage.addChild(mkButton("Save WAV", 356, 188, 108, 28, 0xAD1457, function(e:MouseEvent):void { doSaveWav(); }));

stage.addChild(urlTf);
stage.addChild(mkButton("Load", 372, 224, 92, 22, 0x4A148C, function(e:MouseEvent):void { doLoadUrl(); }));

stage.addChild(fileTf);
stage.addChild(hintTf);

picked.addEventListener(Event.SELECT, onPicked);
picked.addEventListener(Event.CANCEL, onBrowseCancelled);
saveTo.addEventListener(Event.SELECT, onSavePathChosen);
saveTo.addEventListener(Event.CANCEL, onBrowseCancelled);

// ---------------------------------------------------------------------------
// 脚本化自检的阶段（窗口开起来之后靠帧时钟推进）
// ---------------------------------------------------------------------------
function phaseA():void {
  ck("play: a channel was returned", chan != null);
  if (chan != null) {
    var p:Number = chan.position;
    ck("play: position advanced past 0 after ~600ms", p > 0);
    var stx:SoundTransform = chan.soundTransform;
    ck("play: fresh channel volume is 1", stx.volume == 1);
    doPause();
    ck("pause: channel is released (stop + remember position)", chan == null);
    ck("pause: resume position is the position at the pause", resumeMs == p);
    phase = "paused";
  }
}

function phaseB():void {
  ck("pause: position did NOT advance while paused", chan == null);
  doPlay();
  ck("resume: play() restarts a channel", chan != null);
  if (chan != null) ck("resume: resumed from the remembered position", chan.position >= resumeMs - 5);
  setVol(0.4);
  ck("volume: setter clamps into 0..1", vol == 0.4);
  if (chan != null) ck("volume: live channel carries the new volume",
    Math.abs(chan.soundTransform.volume - 0.4) < 0.001);
  setVol(0.5);
  // 拖动：seekBy 就是 AIR 的做法（stop + play(startTime)），位置必须真跳到目标附近。
  var beforePos:Number = chan != null ? chan.position : 0;
  seekBy(10000);
  ck("seek: +10s restarts near the requested offset",
    chan != null && chan.position > beforePos + 9000);
  ck("seek: still playing after the seek", phase == "playing");
}

function phaseC():void {
  startShort();
  ck("short: a 0.5s extract plays as a channel", shortChan != null);
}

function phaseD():void {
  ck("soundComplete: fired for the 0.5s slice", doneFired == true);
  doStop();
  ck("stop: stop() keeps the position readable and clears the channel", chan == null);
  setVol(1.0);

  if (failed.length == 0) {
    trace("audio-player: " + passed + " checks passed");
  } else {
    trace("audio-player: " + passed + " passed, " + failed.length + " FAILED");
    for (var i:int = 0; i < failed.length; i++) trace("FAIL " + failed[i]);
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
// 脚本化自检是**夹具专用**的：它断言的是 movers-vol2.mp3 的字节数/时长/id3，以及本地
// File/FileStream/WAV 那些事。换成网络地址（或面板里选了别的文件）就只跑 UI，不跑这三组——
// 拿夹具的数字去量另一个源只会造假红，而这恰恰是上一版在远程启动时报五条 FAIL 的来源。
var fixtureRun:Boolean = !looksRemote(clipPath);
fixtureChecks = fixtureRun;
autoPlay = true;           // 由 onLoaded 消费：本地载入在 loadFrom 的排空里就完成，当场起播
loadFrom(clipPath);        // 本地：tickTimers() 排空，所以到这一行结束 snd 已解码
if (fixtureRun) fileChecks();   // 文件面那组：读字节解码 + 写 WAV 再读回（全同步，不弹面板）

if (!fixtureRun) {
  trace("audio-player: startup source is not the local fixture -- scripted checks skipped "
    + "(the UI still plays it; COMPLETE starts playback)");
} else if (SoundMixer.areSoundsInaccessible()) {
  trace("audio-player: no audio device on this host -- playback assertions skipped; "
    + "the decode/length/id3/file groups above still ran");
} else {
  setTimeout(phaseA, 600);
  setTimeout(phaseB, 1300);
  setTimeout(phaseC, 1900);
  setTimeout(phaseD, 3000);
}

// 阻塞在窗口事件循环里；帧时钟推进定时器，进而驱动上面的自检与 UI 刷新。
stage.showWindow(WIN_W, WIN_H, "TalkMED AOT audio player");
trace("audio-player: window closed");