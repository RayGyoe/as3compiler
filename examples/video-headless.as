// examples/video-headless.as -- NetStream / Video 的断言，不建窗口（阶段三百九十九）
//
// 为什么要有这个文件：`examples/video/VideoPlayer.as` 是给人用的播放器（Open file… 按钮
// 属于用户），它跑完自检后**窗口不关**，所以套件里只能做 compile+link（见
// test/examples.ts 的 SKIP_DIRS 注释）。在那之前，套件里跑的其实是**没有清单**的构建
// ——窗口开不出来、`showWindow` 立刻返回，于是 `8 passed, 5 failed` 照样报 PASS。视频面
// 因此一条自动回归都没有。这个文件把「解码 / 时钟 / 四容器 / 音频流」那部分断言搬到
// **无头**形态：自己推 `Stage.dispatchFrame()`（也就是 `as_ns_tick()` 挂的那个帧边界），
// 跑完按 AGENTS.md §2.5 用状态码结算。
//
//   node src/index.ts examples/video-headless.as --manifest examples/video/video.build.json --run
//
// 窗口那半边（按钮、Open file… 换源、`BitmapData.draw` 上屏的肉眼观感）仍然只由
// VideoPlayer.as 手验：无头跑不出来，硬造一个假窗口只会让两边都不像。

import flash.display.BitmapData;
import flash.display.Stage;
import flash.display.Video;
import flash.events.NetStatusEvent;
import flash.media.SoundMixer;
import flash.net.NetConnection;
import flash.net.NetStream;
import flash.utils.getTimer;

var passed:int = 0;
var failed:Array = [];
function ck(what:String, cond:Boolean):void {
  if (cond) { passed++; trace("  ok   " + what); }
  else { failed.push(what); trace("  FAIL " + what); }
}

var stage:Stage = new Stage();
var conn:NetConnection = new NetConnection();

// ---- 构造面：AIR 的那两条空参/空连接口径（阶段三百九十七 实测） ----
var threw:int = 0;
try { new NetStream(null); } catch (e:Error) { threw = e.errorID; }
ck("NetStream(null) throws #2007", threw == 2007);
conn.connect(null);
ck("NetConnection.connect(null) -> connected", conn.connected);

var video:Video = new Video(320, 240);
ck("Video.videoWidth is 0 before attach", video.videoWidth == 0);

var codes:Array = [];
var meta:Object = null;
var ns:NetStream = new NetStream(conn);
video.attachNetStream(ns);
ns.client = { onMetaData: function(i:Object):void { meta = i; } };
ns.addEventListener(NetStatusEvent.NET_STATUS, function(e:NetStatusEvent):void {
  codes.push(String(e.info.code));
});

// 帧边界手泵：NetStream 的推进（as_ns_tick）、定时器、MovieClip 都挂在这一个安全点上，
// 所以无头程序只要推它就等于在跑窗口的帧循环。
function pump(ms:int):void {
  var t0:int = getTimer();
  while (getTimer() - t0 < ms) stage.dispatchFrame();
}
function codeSeen(c:String):Boolean { return codes.indexOf(c) >= 0; }

// 抽样统计：亮的像素数与不同颜色数。两者都取 20px 网格，够区分「画出真画面」与
// 「一路黑」/「纯色块」，又不随窗口大小变化。
function stats():String {
  var bd:BitmapData = new BitmapData(320, 240, true, 0x00000000);
  bd.draw(video);
  var lit:int = 0, distinct:int = 0;
  var seen:Object = {};
  for (var y:int = 10; y < 240; y += 20) {
    for (var x:int = 10; x < 320; x += 20) {
      var px:uint = bd.getPixel32(x, y);
      if (((px >>> 24) & 0xFF) < 8) continue;
      var rgb:uint = px & 0xFFFFFF;
      if (rgb != 0) lit++;
      if (!(rgb in seen)) { seen[rgb] = true; distinct++; }
    }
  }
  bd.dispose();
  return lit + "/" + distinct;
}

// ---- clip.mp4：起播、首帧、时钟、暂停、结束 ----
var CLIP:String = "examples/video/media/clip.mp4";
ns.play(CLIP);
ck("play() dispatches Play.Start", codeSeen("NetStream.Play.Start"));
ck("play() dispatches Buffer.Full", codeSeen("NetStream.Buffer.Full"));
// 这一条是 8 线程解码下最容易坏的那一条：frame threading 要攒够一队帧才出画面，
// 一次 tick 的包预算不够（video.md §16.7）。
ck("videoWidth/Height known right after play()",
  video.videoWidth == 320 && video.videoHeight == 240);

pump(400);
var firstPixels:Array = stats().split("/");
ck("decoded frame reaches BitmapData.draw (lit pixels)", int(firstPixels[0]) > 20);
ck("decoded frame has real colour (distinct > 3)", int(firstPixels[1]) > 3);
ck("onMetaData arrived", meta != null);
ck("onMetaData duration ~1.2s", meta != null && Math.abs(Number(meta.duration) - 1.2) < 0.1);
ck("onMetaData width/height 320x240",
  meta != null && Number(meta.width) == 320 && Number(meta.height) == 240);
ck("time advances with playback", ns.time > 0.2);

ns.pause();
var t0:Number = ns.time;
pump(300);
ck("pause() freezes the clock", ns.time == t0);
ns.resume();

var waited:int = 0;
while (!codeSeen("NetStream.Play.Stop") && waited < 4000) { pump(50); waited += 50; }
ck("Play.Stop dispatched at end", codeSeen("NetStream.Play.Stop"));
ck("time pinned to duration at end", Math.abs(ns.time - Number(meta.duration)) < 0.05);

// ---- E 增强：解码游标顺帧（stepFrame/frameTime，导出顺帧路的地基） ----
// 墙钟无关：18 帧（clip.mp4 实为 15fps）必须在远小于一秒播放时长内走完（tick 的“落后即丢”不适用）。
var curNs:NetStream = new NetStream(conn);
var curVideo:Video = new Video(320, 240);
curVideo.attachNetStream(curNs);
curNs.client = { onMetaData: function(i:Object):void { } };
curNs.play(CLIP);
ck("frameTime is 0 at the held first frame", curNs.frameTime == 0);
var curT0:int = getTimer();
var steps:int = 0;
var lastT:Number = -1;
var mono:Boolean = true;
var st:Number = curNs.stepFrame();
while (st >= 0 && steps < 200) {
  if (st <= lastT) mono = false;
  lastT = st;
  steps++;
  st = curNs.stepFrame();
}
var curMs:int = getTimer() - curT0;
ck("stepFrame walks every frame monotonically", mono && steps >= 16 && steps <= 18);
ck("stepFrame ends at EOF (-1)", st < 0);
ck("frameTime tracks the held frame", Math.abs(curNs.frameTime - lastT) < 0.001);
ck("stepFrame is wall-clock independent (" + curMs + "ms for " + steps + " frames)", curMs < 2000);
curNs.close();

// ---- 另外三个容器：各自的解复用器与解码器都要真的出画面 ----
// 每条流单独一个 NetStream（Air 的槽位是逐流的），跑完就 close()，不占 AS_VIDEO_MAX。
var seqNs:NetStream = new NetStream(conn);
var seqVideo:Video = new Video(320, 240);
seqVideo.attachNetStream(seqNs);
seqNs.client = { onMetaData: function(i:Object):void { } };
var seqCodes:Array = [];
seqNs.addEventListener(NetStatusEvent.NET_STATUS, function(e:NetStatusEvent):void {
  seqCodes.push(String(e.info.code));
});
function playToStop(url:String, label:String):void {
  seqCodes = [];
  seqNs.play(url);
  var waited:int = 0;
  while (seqCodes.indexOf("NetStream.Play.Stop") < 0 && waited < 5000) {
    pump(50); waited += 50;
  }
  var px:Array = stats().split("/");
  ck(label + " plays to the end (Play.Stop)", seqCodes.indexOf("NetStream.Play.Stop") >= 0);
  ck(label + " decoded a frame", int(px[0]) > 20);
  seqNs.close();
}
playToStop("examples/video/media/clip.flv", "FLV");
playToStop("examples/video/media/clip.ts", "MPEG-TS");
playToStop("examples/video/media/clip.mkv", "MKV (VP9/Opus)");

// ---- 纯音频流：NetStream 能当时钟用，Video 没有画面 ----
// 没有音频设备的主机（CI 的 macOS runner）播不出声，时钟也就不会前进 —— 那时整组跳过
// 并**打印原因**，而不是假装通过（AGENTS.md §1.5）。
var audioVideo:Video = new Video(320, 240);
var audioNs:NetStream = new NetStream(conn);
audioVideo.attachNetStream(audioNs);
audioNs.client = { onMetaData: function(i:Object):void { } };
var audioStopped:Boolean = false;
audioNs.addEventListener(NetStatusEvent.NET_STATUS, function(e:NetStatusEvent):void {
  if (e.info.code == "NetStream.Play.Stop") audioStopped = true;
});
audioNs.play("examples/video/media/tone.mp3");
var audioWaited:int = 0;
while (!audioStopped && audioWaited < 4000) { pump(50); audioWaited += 50; }
if (SoundMixer.areSoundsInaccessible()) {
  trace("  skip audio-only clock: no audio device on this host (SoundMixer.areSoundsInaccessible)");
} else {
  ck("audio-only stream advances from decoded audio", audioNs.time > 0.8);
  ck("audio-only stream reports Play.Stop", audioStopped);
}
ck("attached Video has no picture for an audio-only stream", audioVideo.videoWidth == 0);
audioNs.close();

trace("video-headless: " + passed + " passed, " + failed.length + " failed");
for (var i:int = 0; i < failed.length; i++) trace("video-headless: FAILED: " + failed[i]);
System.exit(failed.length == 0 ? 0 : 1);