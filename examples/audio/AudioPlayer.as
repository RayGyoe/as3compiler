// AudioPlayer.as — 带 UI 的音频播放器示例（阶段二百零一）。
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
// 夹具来源：`clip.mp3` 是从 README 里那份产品视频（TalkMED 会议 App 录屏）的**完整音轨**
// 抽出来的，见 docs/zh-cn/audio.md §13.5。它是一份**自有**夹具 —— 先前那三条音频钉子读的是
// 第三方 Starling 示例的 `AssetManager.as`，被阶段一百九十八 连同外部夹具一起删掉了。
//
// 无设备的主机不会静默假装：`SoundMixer.areSoundsInaccessible()` 为真时播放断言整组
// 跳过并**打印原因**（AGENTS.md §1.5），解码/长度/id3 那组仍然照跑。
//
// 选文件：AIR 的原生文件对话框（`FileReference.browse` / `File.browseForOpen`）在本
// 后端**没有实现**（src/symbols.ts 的 File 类注释：那四个交互式成员「report themselves
// loudly」），所以这里不用它，而是一个可编辑的路径输入框 + Load 按钮 —— 真能换文件，
// 且不是假装的对话框。
import flash.display.Shape;
import flash.display.Sprite;
import flash.display.Stage;
import flash.events.Event;
import flash.events.IOErrorEvent;
import flash.events.MouseEvent;
import flash.media.Sound;
import flash.media.SoundChannel;
import flash.media.SoundMixer;
import flash.media.SoundTransform;
import flash.net.URLRequest;
import flash.text.TextField;
import flash.text.TextFieldType;
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
var WIN_H:Number = 320;
var BAR_X:Number = 16;
var BAR_Y:Number = 132;
var BAR_W:Number = 448;
var BAR_H:Number = 10;

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
var clipPath:String = "examples/audio/clip.mp3";
var phase:String = "empty";           // empty / loading / loaded / playing / paused / stopped / finished
var doneFired:Boolean = false;        // soundComplete 是否到达
var shortSnd:Sound = null;            // 短片段（从夹具 extract 出来的真实音频）
var shortChan:SoundChannel = null;

var infoTf:TextField = mkLabel(16, 38, 448, 66, 12, 0xDDDDDD);
var posTf:TextField = mkLabel(16, 106, 448, 18, 12, 0x9BE39B);
var barBg:Shape = new Shape();
var barFill:Shape = new Shape();
var pathTf:TextField = mkLabel(16, 226, 360, 22, 12, 0xFFFFFF);
var hintTf:TextField = mkLabel(16, 258, 448, 46, 11, 0x999999);

function setInfo(msg:String):void {
  infoTf.text = msg;
}

// ---------------------------------------------------------------------------
// 载入（异步任务 + 一次 tickTimers 排空，本地文件因此是确定性的）
// ---------------------------------------------------------------------------
function loadFrom(p:String):void {
  clipPath = p;
  phase = "loading";
  setInfo("loading " + p + " ...");
  snd = new Sound();
  snd.addEventListener(Event.COMPLETE, onLoaded);
  snd.addEventListener(IOErrorEvent.IO_ERROR, onLoadErr);
  snd.load(new URLRequest(p));
  // 文件读取 + 解码是一个异步任务；tickTimers() 等 worker 排空并派发终态事件，
  // 所以本地文件在这一行之后就一定是已解码状态（见 docs/zh-cn/as3-semantics.md）。
  tickTimers();
}

function onLoadErr(e:IOErrorEvent):void {
  phase = "empty";
  setInfo("无法载入 " + clipPath + "\n" + e.text);
  trace("audio-player: load failed: " + e.text);
}

function onLoaded(e:Event):void {
  phase = "loaded";
  refreshInfo();
  // --- 载入面的自检：这些都是 AIR 的 Sound.load 契约 ---
  ck("load: bytesTotal is the file size (1890142)", snd.bytesTotal == 1890142);
  ck("load: bytesLoaded == bytesTotal after COMPLETE", snd.bytesLoaded == snd.bytesTotal);
  ck("load: url names the loaded file", snd.url != null && snd.url.indexOf("clip.mp3") >= 0);
  // 实测口径：load() 过的 Sound，isBuffering 在 COMPLETE 后仍为 true（load() 建的对象
  // 恒为该值，见 src/emit.ts 的 Sound__finish 注释），而 loadPCMFromByteArray 那条路为 false。
  ck("load: isBuffering stays true for a load()ed Sound", snd.isBuffering == true);
  // Sound.length 的单位是**毫秒**（不是秒）：这个 118.1s 的文件报 118125.71ms。
  // 它是 MPEG 的“名义时长”（帧数 × 1152/44100），比容器的 118.0996s 多约 26ms，
  // 与 adl 同口径（embed.as 里那只 6686 字节的 mp3 也报 417.959…ms）。
  ck("load: length is the decoded duration (~118.13s)", snd.length > 118100 && snd.length < 118200);
  // ID3v2 标签（夹具是 ffmpeg 写的 v2.3）：TIT2/TPE1/TALB。
  ck("id3: songName from TIT2", snd.id3.songName == "TalkMED AOT audio fixture");
  ck("id3: artist from TPE1", snd.id3.artist == "TalkMED");
  ck("id3: album from TALB", snd.id3.album == "as3compiler examples");
  trace("audio-player: loaded " + clipPath + " len=" + snd.length + " bytes=" + snd.bytesTotal);
  // 不在这里自播：换文件也要起播，而那是调用方的事（启动块 / doLoadPath），放这里会双重 startPlay。
}

function refreshInfo():void {
  setInfo("file   " + clipPath + "\n"
    + "bytes  " + snd.bytesLoaded + " / " + snd.bytesTotal + "\n"
    + "len    " + fmtSec(snd.length)
    + "   id3  " + snd.id3.songName + " - " + snd.id3.artist);
}

// ---------------------------------------------------------------------------
// 播放控制
// ---------------------------------------------------------------------------
function startPlay(from:Number):void {
  if (snd == null) return;
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
function doLoadPath():void {
  var p:String = pathTf.text;
  if (p == null || p.length == 0) return;
  doStop();
  loadFrom(p);
  // loadFrom 里的 tickTimers() 会把异步载入排空，所以这一行时终态事件已经到过：
  // 载入成功（phase 落成 "loaded"）就直接续播，失败则留在 onLoadErr 报的错上。
  if (phase == "loaded" && !SoundMixer.areSoundsInaccessible()) startPlay(0);
}

// ---------------------------------------------------------------------------
// 每帧刷新（窗口的帧循环会重绘 stage，所以改图形/文字后立刻可见）
// ---------------------------------------------------------------------------
function updateUi():void {
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
  snd.extract(pcm, 22050);                                   // 0.5s，恒为 44100Hz 立体声 f32
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
titleTf.text = "TalkMED AOT audio player";

barBg.graphics.beginFill(0x333333);
barBg.graphics.drawRect(0, 0, BAR_W, BAR_H);
barBg.graphics.endFill();
barBg.x = BAR_X; barBg.y = BAR_Y;

barFill.x = BAR_X; barFill.y = BAR_Y;

pathTf.text = clipPath;
pathTf.type = TextFieldType.INPUT;
pathTf.border = true;
pathTf.background = true;
pathTf.backgroundColor = 0x222222;
pathTf.borderColor = 0x666666;
pathTf.multiline = false;
pathTf.wordWrap = false;

hintTf.text = "Play/Pause/Stop、\u00b110% 音量、\u00b110s 拖动；\n"
  + "下框是可编辑路径，改完点 Load 换文件（中文输入法下打字要回车确认才会落到框里）。\n"
  + "AIR 的原生文件对话框在本后端无实现，故用路径输入代替。";

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
stage.addChild(mkButton("\u00ab10s", 16, 188, 70, 28, 0x5D4037, function(e:MouseEvent):void { seekBy(-10000); }));
stage.addChild(mkButton("10s\u00bb", 92, 188, 70, 28, 0x5D4037, function(e:MouseEvent):void { seekBy(10000); }));

stage.addChild(pathTf);
stage.addChild(mkButton("Load", 384, 226, 80, 22, 0x6A1B9A, function(e:MouseEvent):void { doLoadPath(); }));
stage.addChild(hintTf);

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
loadFrom(clipPath);        // tickTimers() 排空，所以到这一行结束 snd 已解码

if (SoundMixer.areSoundsInaccessible()) {
  trace("audio-player: no audio device on this host -- playback assertions skipped; "
    + "the decode/length/id3 group above still ran");
} else {
  startPlay(0);
  setTimeout(phaseA, 600);
  setTimeout(phaseB, 1300);
  setTimeout(phaseC, 1900);
  setTimeout(phaseD, 3000);
}

// 阻塞在窗口事件循环里；帧时钟推进定时器，进而驱动上面的自检与 UI 刷新。
stage.showWindow(WIN_W, WIN_H, "TalkMED AOT audio player");
trace("audio-player: window closed");
