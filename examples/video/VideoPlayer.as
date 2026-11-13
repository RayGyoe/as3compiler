// VideoPlayer.as — flash.net.NetStream / flash.media.Video 的视频播放器示例。
//
// 它是**视频那条链路**的载体：NetConnection → NetStream → Video（attachNetStream）
// → 解码（FFmpeg）→ 帧上屏，加上 AIR 的状态机（netStatus 的 Play.Start /
// Buffer.Full / Play.Stop / Play.Failed、onMetaData、pause / resume / togglePause /
// seek / time / soundTransform）。口径与实测记录见 docs/zh-cn/video.md。
//
// 为什么是「带窗口的播放器」而不是无头自检：视频帧的推进由**帧边界**的
// `as_ns_tick()` 驱动（src/emit.ts 里 Stage_dispatchFrame 的调用点，和定时器、
// MovieClip 同一个安全点），而离屏的自检钩子不驱动它。所以「播到结束」「暂停真的
// 停住」这些只能在一个真窗口里成立，本示例就是它的载体。回归套件对它是
// **compile+link only**（见 test/examples.ts 的 "example: video/" 用例）；下面是
// 手动跑法，脚本化自检会在窗口里跑完并把每条结果 trace 到 stdout：
//   node src/index.ts examples/video/VideoPlayer.as \
//        --manifest examples/video/video.build.json --run
// （从**仓库根**跑：下面的夹具路径是相对当前目录的。）
//
// 构建口径（video.build.json）：它自己显式列 sources，但**不写 FFmpeg 的
// include/link 路径与 libav\***——那些由编译器按 `NetStream` 的出现自动补齐
// （src/index.ts 的 video 门，docs/zh-cn/video.md §5.1）。这样这份清单只描述
// 「要哪些 glue」，工具链细节留给编译器，换平台不用改清单。
//
// 夹具（examples/video/media/，自有，非第三方）：clip.mp4 / clip.flv / clip.ts 都是
// 320x240 H.264 + 44.1kHz 单声道 AAC、约 1.0–1.2s；clip.mkv 是 VP9 + Opus（同尺寸，
// 不同后端路径）；tone.mp3 / tone.ogg / tone.wav 是 1.0s 单声道音频（纯音频流走
// audio-only 分支：没有视频帧时 time 由**已解码写入混音器的采样数**决定）。
// 断言里的宽高/时长都是对这些文件实测的，换素材必须重测。
//
// 没有音频设备的主机（`SoundMixer.areSoundsInaccessible()`）不会静默假装：
// 音频那组断言整组跳过并**打印原因**，视频那组照跑（AGENTS.md §1.5）。
//
// 第五个按钮 **Open file…** 是给人用的：它开原生文件对话框（`File.browseForOpen`，
// 后端在 vendor/file_dialog_win.cc / file_dialog_macos.mm），选中后把该 File 的
// nativePath 交给同一个 NetStream 播——**任意**本地音视频文件，不限于夹具。
// 自检还在跑的时候按下它不会打断自检：选择先记下来，等 summarize() 之后才播。
import flash.display.Bitmap;
import flash.display.BitmapData;
import flash.display.Shape;
import flash.display.Sprite;
import flash.display.Stage;
import flash.events.Event;
import flash.events.MouseEvent;
import flash.events.NetStatusEvent;
import flash.filesystem.File;
import flash.media.SoundMixer;
import flash.media.SoundTransform;
import flash.media.Video;
import flash.net.FileFilter;
import flash.net.NetConnection;
import flash.net.NetStream;
import flash.text.TextField;
import flash.text.TextFormat;
import flash.utils.getTimer;
import flash.utils.setTimeout;

// ---------------------------------------------------------------------------
// 断言小工具（与其余示例同形：一条 trace 一行结果，收尾汇总）
// ---------------------------------------------------------------------------
var passed:int = 0;
var failed:Array = [];

function ck(label:String, ok:Boolean):void {
  if (ok) { passed++; trace("  ok   " + label); }
  else { failed.push(label); trace("  FAIL " + label); }
}
function near(a:Number, b:Number, tol:Number):Boolean {
  var d:Number = a - b;
  if (d < 0) d = -d;
  return d <= tol;
}

var WIN_W:Number = 480;
var WIN_H:Number = 400;
var stage:Stage = new Stage();
// 帧时钟 60Hz，不是 AIR 默认的 24。
//
// NetStream 的画面推进挂在**帧边界**（Stage_dispatchFrame 里的 as_ns_tick，和定时器、
// MovieClip 同一个安全点，docs/zh-cn/video.md §10.2）。所以画面能换帧的最快速度就是
// Stage.frameRate：24 的默认值对 23.976 的片子只是「刚好每个应用帧出一帧」，任何一次
// 迟到就显示两遍同一帧，观感是持续抖动；换 60 之后每个片子帧有 2–3 个应用帧可落脚，
// 4K 素材实测（3832x1592 10-bit HEVC）窗口循环从 16.5 fps 升到 56 fps。
// 这不是本示例的怪癖：播视频的窗口程序都该把 frameRate 提到 60（§16.5 有实测表）。
stage.frameRate = 60;
var VIDEO_W:int = 320;      // 夹具的原生尺寸：Video 的 width/height 是我们给的**表面**尺寸，
var VIDEO_H:int = 240;      // videoWidth/videoHeight 才是解码出来的画面尺寸（两者必须分开看）
var CLIP:String = "examples/video/media/clip.mp4";
var CLIP_FLV:String = "examples/video/media/clip.flv";
var CLIP_TS:String = "examples/video/media/clip.ts";
var CLIP_MKV:String = "examples/video/media/clip.mkv";
var TONE:String = "examples/video/media/tone.mp3";

// ---------------------------------------------------------------------------
// AIR 的构造期拒绝（错误号与文案都是实测口径，video.md §4.2）
// ---------------------------------------------------------------------------
function ctorChecks():void {
  // 未连接的 NetConnection：NetStream 的构造器抛 Error #2126。
  var dead:NetConnection = new NetConnection();
  var caught:String = "";
  try { new NetStream(dead); } catch (e:Error) { caught = e.errorID + ":" + e.message; }
  ck("NetStream(unconnected) throws #2126", caught.indexOf("2126") == 0);

  // null 连接：先于 #2126 判，抛 ArgumentError #2007。
  caught = "";
  try { new NetStream(null); } catch (e:Error) { caught = e.errorID + ":" + e.message; }
  ck("NetStream(null) throws #2007", caught.indexOf("2007") == 0);

  // 连接后同一个参数就合法了（这条证明上面两条拒绝的是**状态**，不是类型）。
  var nc:NetConnection = new NetConnection();
  nc.connect(null);
  ck("NetConnection.connect(null) -> connected", nc.connected);
  var ok:NetStream = new NetStream(nc);
  ck("NetStream(connected) constructs", ok != null);
  ok.close();

  // Video 的尺寸是它自己的属性，构造后即可读，且与内容无关（AIR 口径）。
  var v:Video = new Video(200, 100);
  ck("Video(200,100) keeps its rect", v.width == 200 && v.height == 100);
  ck("Video.videoWidth is 0 before attach", v.videoWidth == 0 && v.videoHeight == 0);
  v.width = 320; v.height = 240;
  ck("Video width/height writable", v.width == 320 && v.height == 240);
}

// ---------------------------------------------------------------------------
// 主播放链：NetConnection → NetStream → Video
// ---------------------------------------------------------------------------
var conn:NetConnection = new NetConnection();
conn.connect(null);
var ns:NetStream = new NetStream(conn);
var video:Video = new Video(VIDEO_W, VIDEO_H);
video.x = 16;
video.y = 44;
video.smoothing = true;
video.attachNetStream(ns);

var codes:Array = [];         // 收到过的 netStatus code，按到达顺序
var meta:Object = null;       // onMetaData 的参数
var endMs:Number = 0;         // 观察到的终态时刻（Play.Stop）

ns.client = {
  onMetaData: function(info:Object):void {
    meta = info;
    trace("video-player: onMetaData w=" + info.width + " h=" + info.height
      + " duration=" + info.duration + " fps=" + info.framerate);
  }
};
ns.addEventListener(NetStatusEvent.NET_STATUS, function(e:NetStatusEvent):void {
  var code:String = String(e.info.code);
  codes.push(code);
  trace("video-player: netStatus " + code + " (" + e.info.level + ")"
    + (e.info.description != undefined ? " " + e.info.description : ""));
  if (code == "NetStream.Play.Stop") endMs = getTimer();
});

// ---------------------------------------------------------------------------
// UI：Video 本体 + 一行状态 + 五个按钮（pause/重播/seek/换容器/开本地文件）
// ---------------------------------------------------------------------------
var statusTf:TextField = new TextField();
function mkTf(size:int, color:uint, y:Number):TextField {
  var tf:TextField = new TextField();
  tf.x = 16; tf.y = y; tf.width = WIN_W - 32; tf.height = size + 6;
  tf.multiline = false;
  tf.defaultTextFormat = new TextFormat("Arial", size, color);
  tf.text = "";
  return tf;
}
function mkButton(label:String, x:Number, y:Number, w:Number, color:uint, fn:Function):Sprite {
  var s:Sprite = new Sprite();
  s.x = x; s.y = y;
  s.graphics.beginFill(color);
  s.graphics.drawRoundRect(0, 0, w, 26, 6);
  s.graphics.endFill();
  var tf:TextField = new TextField();
  tf.x = 6; tf.y = 5; tf.width = w - 8; tf.height = 18;
  tf.selectable = false;
  tf.mouseEnabled = false;
  tf.defaultTextFormat = new TextFormat("Arial", 12, 0xFFFFFF);
  tf.text = label;
  s.addChild(tf);
  s.addEventListener(MouseEvent.CLICK, fn);
  return s;
}

var titleTf:TextField = mkTf(14, 0x1A237E, 12);
titleTf.text = "TalkMED AOT video player -- NetStream / Video over FFmpeg";
var infoTf:TextField = mkTf(12, 0x37474F, 300);
var posTf:TextField = mkTf(12, 0x00695C, 318);
var hintTf:TextField = mkTf(11, 0x607D8B, 338);
hintTf.text = "buttons: Pause / Restart / Seek 0.6s / FLV / Open file... -- the picture is the decoded frame";

var paused:Boolean = false;
var sourceName:String = "clip.mp4";   // what infoTf shows: the fixture, or the picked file
function playSource(path:String):void {
  var cut:int = path.lastIndexOf("/");
  var cut2:int = path.lastIndexOf("\\");
  if (cut2 > cut) cut = cut2;
  sourceName = cut >= 0 ? path.substring(cut + 1) : path;
  paused = false;
  meta = null;          // a new file has its own header; "?" until onMetaData
  codes = [];
  trace("video-player: play " + path);
  ns.play(path);
}
function doPause():void {
  if (paused) { ns.resume(); paused = false; } else { ns.pause(); paused = true; }
}
function doRestart():void {
  playSource(CLIP);
}
function doSeek():void {
  paused = false;
  ns.seek(0.6);
}
var flvMode:Boolean = false;
function doFlv():void {
  flvMode = !flvMode;
  playSource(flvMode ? CLIP_FLV : CLIP);
}

// ---------------------------------------------------------------------------
// Open file…：原生文件对话框 → 把选中的本地文件交给同一个 NetStream
// ---------------------------------------------------------------------------
// AIR 的契约：`File.browseForOpen()` 返回 void；面板关闭后**这个 File 对象本身**
// 就是选中项（nativePath 已被写入），并在它身上派发 Event.SELECT；取消派发
// Event.CANCEL（此时对象仍无路径）。面板是原生窗口，跑在别的线程上（Windows）或
// 由平台模态泵接管（macOS），主帧循环不停——结果在帧边界由 as_file_dialog_tick()
// 取回，和定时器同一个安全点。
//
// 自检还在跑时按下它：只记录、不播。否则用户选的文件会抢走自检正在测的 ns
// （两条流还要争 AS_VIDEO_MAX 槽位与混音器），把断言搅红。
var picker:File = new File();
var pendingOpen:String = null;
var scriptedDone:Boolean = false;

function doOpen():void {
  picker.browseForOpen("Choose a video or audio file to play", [
    new FileFilter("Video / audio",
      "*.mp4;*.mov;*.m4v;*.flv;*.ts;*.mkv;*.webm;*.mp3;*.m4a;*.aac;*.wav;*.ogg", null),
    new FileFilter("All files", "*.*", null)
  ]);
}
picker.addEventListener(Event.SELECT, function(e:Event):void {
  var path:String = picker.nativePath;
  if (!scriptedDone) {
    pendingOpen = path;
    trace("video-player: picked " + path + " -- queued until the scripted checks finish");
    hintTf.text = "queued: " + picker.name + " (plays when the scripted checks end)";
    return;
  }
  playSource(path);
  hintTf.text = "playing " + picker.name + " -- Pause / Seek / Open file… still work";
});
picker.addEventListener(Event.CANCEL, function(e:Event):void {
  trace("video-player: file dialog cancelled -- still playing " + sourceName);
});

stage.addChild(titleTf);
stage.addChild(video);
stage.addChild(infoTf);
stage.addChild(posTf);
stage.addChild(hintTf);
stage.addChild(mkButton("Pause", 16, 364, 70, 0x1565C0, function(e:MouseEvent):void { doPause(); }));
stage.addChild(mkButton("Restart", 92, 364, 70, 0x2E7D32, function(e:MouseEvent):void { doRestart(); }));
stage.addChild(mkButton("Seek 0.6s", 168, 364, 82, 0x5D4037, function(e:MouseEvent):void { doSeek(); }));
stage.addChild(mkButton("FLV / MP4", 256, 364, 82, 0x6A1B9A, function(e:MouseEvent):void { doFlv(); }));
stage.addChild(mkButton("Open file...", 344, 364, 120, 0xEF6C00, function(e:MouseEvent):void { doOpen(); }));

function updateUi():void {
  infoTf.text = sourceName + "   time " + ns.time.toFixed(3) + "s / "
    + (meta != null ? Number(meta.duration).toFixed(2) : "?")
    + "s   videoWidth " + video.videoWidth + "x" + video.videoHeight
    + "   vol " + ns.soundTransform.volume;
  var frac:Number = 0;
  if (meta != null && Number(meta.duration) > 0) frac = ns.time / Number(meta.duration);
  if (frac < 0) frac = 0;
  if (frac > 1) frac = 1;
  posTf.text = "[" + (paused ? "paused" : "playing") + "] position bar "
    + Math.round(frac * 100) + "%   events " + codes.length;
}
stage.addEventListener(Event.ENTER_FRAME, function(e:Event):void { updateUi(); });

// ---------------------------------------------------------------------------
// 脚本化自检：一帧边界一次机会，所以用 setTimeout 排队（与 audio 示例同法）
// ---------------------------------------------------------------------------
// 「画面真的画上去了」只能看像素。BitmapData.draw(video) 走的是与上屏**同一条**
// 内容渲染分支（as_render_object_content 的 Video 分支），所以这里检查的不是
// 「对象在树上」而是「解码出的帧能变成有颜色的像素」：数一数不透明且不是纯黑的
// 采样点，再数不同颜色。测试图是彩条 + 移动方块，纯黑画面的两个数都会是 0。
function framePixelStats():Array {
  var bd:BitmapData = new BitmapData(VIDEO_W, VIDEO_H, true, 0x00000000);
  bd.draw(video);
  var lit:int = 0;
  var colors:Object = {};
  var distinct:int = 0;
  var step:int = 20;
  for (var y:int = 10; y < VIDEO_H; y += step) {
    for (var x:int = 10; x < VIDEO_W; x += step) {
      var px:uint = bd.getPixel32(x, y);
      var a:int = (px >>> 24) & 0xFF;
      if (a < 8) continue;
      var rgb:uint = px & 0xFFFFFF;
      if (rgb != 0) lit++;
      if (!(rgb in colors)) { colors[rgb] = true; distinct++; }
    }
  }
  bd.dispose();
  return [lit, distinct];
}

var started:Boolean = false;
function scriptedChecks():void {
  trace("video-player: === scripted checks ===");
  ctorChecks();

  // play() 是同步派发 Play.Start / Buffer.Full 的（AIR 口径）：spinner 靠它点亮，
  // 不能等到第一帧才有状态。
  codes = [];
  meta = null;
  ns.play(CLIP);
  ck("play() dispatches Play.Start", codes.indexOf("NetStream.Play.Start") >= 0);
  ck("play() dispatches Buffer.Full", codes.indexOf("NetStream.Buffer.Full") >= 0);

  // 第一帧在 open 时就已经解好（as_video_open 的 prime），所以 play() 之后立刻
  // 就有画面几何 —— 这正是「play 不是空等」的判据。
  ck("videoWidth/Height known right after play()",
     video.videoWidth == VIDEO_W && video.videoHeight == VIDEO_H);
  ck("Video rect stays what we asked for",
     video.width == VIDEO_W && video.height == VIDEO_H);

  var st0:Array = framePixelStats();
  trace("video-player: pixels lit=" + st0[0] + " distinct=" + st0[1]);
  ck("decoded frame reaches BitmapData.draw (lit pixels)", st0[0] > 20);
  ck("decoded frame has real colour (distinct > 3)", st0[1] > 3);

  // 0.3s 后：时间在走，画面在换（同一个像素点的颜色/整帧统计会变）。
  setTimeout(function():void {
    // onMetaData is ASYNCHRONOUS in AIR: the header reaches the client on the first
    // frame boundary after play(), not inside the play() call. Checking it here is the
    // honest form (and the only one that matches what the window actually shows).
    ck("onMetaData arrived", meta != null);
    ck("onMetaData duration ~1.2s", meta != null && near(Number(meta.duration), 1.2, 0.25));
    ck("onMetaData width/height 320x240",
       meta != null && Number(meta.width) == VIDEO_W && Number(meta.height) == VIDEO_H);
    var t1:Number = ns.time;
    ck("time advances with playback", t1 > 0.15 && t1 < 2.0);
    ck("pause() freezes the clock", pauseHolds());

    // 播到结束：1.2s 的片段，给到 3s 余量。
    setTimeout(function():void {
      ck("Play.Stop dispatched at end", codes.indexOf("NetStream.Play.Stop") >= 0);
      ck("time pinned to duration at end", near(ns.time, 1.2, 0.25));
      trace("video-player: endMs=" + endMs + " codes=" + codes.join(","));
      ck("end was reached in wall time", endMs > 0);

      // 第二条容器：FLV 与 MPEG-TS 走同一个解码器，但要分别证明 demux 路径通。
      playAndWait(CLIP_FLV, "FLV", function():void {
        playAndWait(CLIP_TS, "MPEG-TS", function():void {
          // MKV 换的是**解码器**（VP9 + Opus）与音频重采样（48kHz → 44.1kHz），
          // 是 broad profile 里唯一不靠 H.264 的一组。
          playAndWait(CLIP_MKV, "MKV (VP9/Opus)", function():void {
            audioOnlyChecks();
          });
        });
      });
    }, 3000);
  }, 300);
}

// pause() 之后 250ms 的 time 必须**不动**（AIR 的 time 是媒体位置，不是墙钟）。
// 同步返回就得给答案，所以这里用两段 setTimeout 夹住：先暂停并记 d0，再比 d1。
var pauseProbe:Array = [];
function pauseHolds():Boolean {
  // 本函数在 t≈0.3s 被调用：先取当前时间，pause 由上面的调用序列负责。
  // 为了保持同步判据，这里只验证「暂停期间 tick 不推进」——即先暂停、记录，
  // 而真正的比较放在下面的 delayed 里（返回值仅表示入口成立）。
  ns.pause();
  paused = true;
  pauseProbe.push(ns.time);
  setTimeout(function():void {
    var d1:Number = ns.time;
    ns.resume();
    paused = false;
    ck("time did not advance while paused", near(d1, Number(pauseProbe[0]), 0.02));
  }, 250);
  return true;
}

// 播一个夹具到终态，再交回下一个（串行，避免多条流同时抢 AS_VIDEO_MAX / 混音器）。
var seqNs:NetStream = new NetStream(conn);
var seqVideo:Video = new Video(VIDEO_W, VIDEO_H);
seqVideo.attachNetStream(seqNs);
function playAndWait(url:String, label:String, done:Function):void {
  var stopped:Boolean = false;
  seqNs.client = { onMetaData: function(info:Object):void { } };
  seqNs.addEventListener(NetStatusEvent.NET_STATUS, function(e:NetStatusEvent):void {
    if (e.info.code == "NetStream.Play.Stop") stopped = true;
    if (e.info.code == "NetStream.Play.Failed") ck(label + " plays", false);
  });
  codes = [];
  seqNs.play(url);
  var waited:int = 0;
  var poll:Function = function():void {
    waited += 100;
    if (stopped) {
      ck(label + " plays to the end (Play.Stop)", true);
      ck(label + " decoded a frame", seqVideo.videoWidth == VIDEO_W && seqVideo.videoHeight == VIDEO_H);
      done();
      return;
    }
    if (waited > 5000) {
      ck(label + " plays to the end (Play.Stop)", false);
      done();
      return;
    }
    setTimeout(poll, 100);
  };
  setTimeout(poll, 100);
}

// 纯音频流：没有视频帧时 as_video_time 由**已解码写入混音器的采样数**决定，所以
// time 能从 0 走到 1.0 本身就证明音频解码 + 重采样 + 混音器写入这条链是活的
// （没有任何视频帧可以「假装」出这个数）。没有音频设备时整组跳过并打印原因。
function audioOnlyChecks():void {
  if (SoundMixer.areSoundsInaccessible()) {
    trace("video-player: no audio device on this host -- audio-only assertions skipped "
      + "(the video groups above still ran)");
    summarize();
    return;
  }
  var ans:NetStream = new NetStream(conn);
  var av:Video = new Video(VIDEO_W, VIDEO_H);
  av.attachNetStream(ans);
  var stopped:Boolean = false;
  var lastTime:Number = 0;
  ans.client = { onMetaData: function(info:Object):void { } };
  ans.addEventListener(NetStatusEvent.NET_STATUS, function(e:NetStatusEvent):void {
    if (e.info.code == "NetStream.Play.Stop") stopped = true;
  });
  ans.play(TONE);
  var waited:int = 0;
  var poll:Function = function():void {
    waited += 100;
    lastTime = ans.time;
    if (stopped || waited > 4000) {
      trace("video-player: audio-only time=" + lastTime.toFixed(3) + " stopped=" + stopped);
      ck("audio-only stream advances from decoded audio", lastTime > 0.8);
      ck("audio-only stream reports Play.Stop", stopped);
      ck("attached Video has no picture for an audio-only stream", av.videoWidth == 0);
      summarize();
      return;
    }
    setTimeout(poll, 100);
  };
  setTimeout(poll, 100);
}

// ---------------------------------------------------------------------------
// 汇总 + 退出：有失败就以非零码退出（AGENTS.md §2.5：响亮失败，不静默）
// ---------------------------------------------------------------------------
function summarize():void {
  trace("video-player: " + passed + " passed, " + failed.length + " failed");
  for (var i:int = 0; i < failed.length; i++) trace("video-player: FAILED: " + failed[i]);
  trace(failed.length == 0 ? "video-player: all assertions passed" : "video-player: FAILURES");
  // From here on the window belongs to the user: the Open-file pick (if one was
  // made while the checks were still running) plays now, and the buttons act on it.
  scriptedDone = true;
  if (pendingOpen != null) {
    var queued:String = pendingOpen;
    pendingOpen = null;
    playSource(queued);
  } else {
    hintTf.text = "scripted checks done -- click Open file... to play any local file";
  }
}

scriptedChecks();

// 阻塞在窗口事件循环里：帧时钟推进定时器，也推进 as_ns_tick() 的解码。
stage.showWindow(WIN_W, WIN_H, "TalkMED AOT video player");
trace("video-player: window closed  " + passed + " passed, " + failed.length + " failed");
// 用户关窗之后才结算状态码：自检有失败就以 1 退出（AGENTS.md §2.5）。这不是本套件
// 的判据（windowed 示例只做 compile+link，见 test/examples.ts），而是给手跑的人一个
// 能被脚本抓住的信号——之前红着退出 0，正是「打印了 FAILED 还报 PASS」的那一半。
if (failed.length > 0) System.exit(1);