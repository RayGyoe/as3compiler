// native-window.as — NativeWindow 家族（多窗口）的自校验示例。
//
// 跑法（需要 arm64 SDL2/Skia，见 docs/zh-cn/compile.md §6）：
//   node src/index.ts examples/native-window.as \
//        --manifest examples/window.build.example.json --run
// 程序自己断言，最后打印 "native-window: N checks passed"；有失败则逐条打印
// "FAIL ..."（并仍然退出，方便肉眼定位）。
//
// 覆盖面（逐项对齐 adl 51.4.1，oracle 见 temp/nwmac/）：
//   * minSize/maxSize：默认值随 OS、写入按 [平台地板, 当前对侧上限] 钳制、getter 每次回新 Point
//   * listOwnedWindows()：Vector.<NativeWindow>，元素就是 owner 本人持有的那个窗口对象
//   * 帧边界的 RESIZE/MOVE：before 是**本帧开始**的矩形（不是半更新状态），顺序 RESIZE→MOVE
//   * close()：当帧 closed 仍为 false、CLOSE 在帧边界送达
//   * 槽位复用：关掉的窗口把后端槽位还回去，下一个窗口拿到同一槽位后必须是一个**全新**窗口
//     （closed=false、能进 openedWindows），而关掉的那个对象永远不再指向该槽位（阶段二百零八）
//   * stage.scaleMode 写入即重算 stageWidth/stageHeight（阶段二百二十六）：先 `bounds` 后改模式
//     与先改模式后 `bounds` 必须收敛到同一尺寸，而 showAll 仍钉在 design 矩形
//   * startMove()/startResize()：真实系统拖拽，回 true（放在最后，拖拽闩锁随进程退出消失）
//   * transparent（阶段二百五十六 / G6b）：默认 false、写入后原样读回、与 systemChrome none 共存
//
// 纯 C 构建（没有 window 后端）里 `new NativeWindow()` 会**响亮**地抛 #2012（不静默 fallback），
// 而 examples/ 下的每个 .as 都会被回归套件在纯 C 配置下真跑一遍 —— 所以这里显式分流：没有后端
// 就报明并停在原地，有后端才继续做断言。（这只覆盖「拿不到窗口」这一种构建，不是兜底语义。）
import flash.display.Stage;
import flash.display.NativeWindow;
import flash.display.NativeWindowInitOptions;
import flash.display.NativeWindowResize;
import flash.display.NativeWindowSystemChrome;
import flash.display.StageScaleMode;
import flash.events.Event;
import flash.events.NativeWindowBoundsEvent;
import flash.desktop.NativeApplication;
import flash.geom.Point;
import flash.geom.Rectangle;
import flash.system.Capabilities;
import flash.utils.setTimeout;

var pass:int = 0;
var fails:Array = [];

function eq(label:String, got:*, want:*):void {
  if (String(got) == String(want)) { pass++; }
  else { fails.push(label + " (got " + got + ", want " + want + ")"); }
}
function rr(r:Rectangle):String { return r == null ? "null" : r.x + "," + r.y + " " + r.width + "x" + r.height; }
function pt(p:Point):String { return p == null ? "null" : p.x + "," + p.y; }

// 平台地板/默认值随 OS 变（adl 实测：macOS 默认 78x32、地板 2x32；Windows 默认 136x39）。
var isMac:Boolean = Capabilities.version.substr(0, 3) == "MAC";
var defMin:String = isMac ? "78,32" : "136,39";
var floorMin:String = isMac ? "2,32" : "136,39";

var stage:Stage = new Stage();
// w 只做几何/事件口径的断言，尺寸限制的**写入**全放在 wSize 上：写 minSize/maxSize 会真的改动
// 活窗口（adl 实测：minSize=(1000,800) 之后窗口宽度立刻变 1000），那条 RESIZE 会混进 w 的事件表，
// 让「改 bounds 到底派发什么」变得不可判读。
var w:NativeWindow = null;
var wSize:NativeWindow = null;
var w2:NativeWindow = null;
var got:Array = [];
var gotClose:Boolean = false;
var hasBackend:Boolean = true;

// ---- 透明窗（阶段二百五十六 / G6b）--------------------------------------------
// adl 51.4.1 实测（temp/transprobe/）：<transparent>true</transparent> 时窗口图层的
// 未绘制像素 alpha = 0，而 stage.color 仍答 0xFFFFFFFF——舞台底色在这个模式下根本
// 没被填充。我们同一件事分两半做：NSWindow 置非 opaque（vendor/window_glue.cc）+ 合成
// 时清成 alpha 0（emit 的 compose 步）。这里断言的是 AS3 侧那半（标志原样往返）。
eq("transparent defaults to false", new NativeWindowInitOptions().transparent, false);
try {
  w = new NativeWindow(new NativeWindowInitOptions());
  wSize = new NativeWindow(new NativeWindowInitOptions());
} catch (e:Error) {
  trace("native-window: this build has no window backend (" + e.message + ") -- nothing to check");
  hasBackend = false;
}

if (hasBackend) {
  var optTr:NativeWindowInitOptions = new NativeWindowInitOptions();
  optTr.transparent = true;
  optTr.systemChrome = NativeWindowSystemChrome.NONE;
  var wTr:NativeWindow = new NativeWindow(optTr);
  eq("a transparent, borderless window reads its flag back", wTr.transparent, true);
  eq("...and its chrome", String(wTr.systemChrome), "none");
  wTr.close();

  w.bounds = new Rectangle(100, 100, 300, 200);
  wSize.bounds = new Rectangle(900, 500, 300, 200);
  wSize.visible = true;
  w.visible = true;
  w.addEventListener(NativeWindowBoundsEvent.RESIZE, function(e:NativeWindowBoundsEvent):void {
    got.push("RESIZE(" + rr(e.beforeBounds) + "->" + rr(e.afterBounds) + ")");
  });
  w.addEventListener(NativeWindowBoundsEvent.MOVE, function(e:NativeWindowBoundsEvent):void {
    got.push("MOVE(" + rr(e.beforeBounds) + "->" + rr(e.afterBounds) + ")");
  });
  setTimeout(phase1, 600);
  setTimeout(phase2, 1200);
  setTimeout(phase3, 1800);
  setTimeout(phase4, 2400);
  setTimeout(phase5, 3000);
}

function phase1():void {
  eq("minSize default", pt(w.minSize), defMin);
  eq("maxSize default", pt(w.maxSize), "107374182,107374182");
  // 钳制：低于平台地板抬到地板；高于当前 maxSize 压回 maxSize。
  wSize.minSize = new Point(0, 0);
  eq("minSize (0,0) clamps to the platform floor", pt(wSize.minSize), floorMin);
  wSize.minSize = new Point(100, 10);
  eq("minSize (100,10) keeps the taller axis", pt(wSize.minSize), isMac ? "100,32" : "136,39");
  wSize.maxSize = new Point(1000, 800);
  wSize.minSize = new Point(2000, 2000);
  eq("a minSize above maxSize is pulled down to it", pt(wSize.minSize), "1000,800");
  eq("...and maxSize itself is unchanged", pt(wSize.maxSize), "1000,800");
  // 写下去的限制立刻作用在活窗口上（adl 实测：minSize=(1000,800) 后宽度变 1000；高度按 AIR 是
  // 异步应用的，故只断言宽度这条即刻成立的）。
  eq("a minSize write resizes the live window", wSize.width, 1000);
  // getter 每次都是新对象（adl：`w.minSize === w.minSize` 为 false）。
  eq("minSize returns a fresh Point", wSize.minSize === wSize.minSize, false);
  wSize.minSize = new Point(2, 32);
  wSize.maxSize = new Point(107374182, 107374182);
}

function phase2():void {
  // 程序化改 bounds：帧边界派发 RESIZE + MOVE，before 是本帧开始的矩形。
  w.bounds = new Rectangle(200, 200, 500, 400);
}

function phase3():void {
  eq("bounds= dispatches RESIZE then MOVE with the frame-start before rect",
    got.join(" | "), "RESIZE(100,100 300x200->200,200 500x400) | MOVE(100,100 300x200->200,200 500x400)");
  got = [];

  // owner / listOwnedWindows：只有 owner 是本窗口的那个窗口才在里面。
  var oo:NativeWindowInitOptions = new NativeWindowInitOptions();
  oo.owner = w;
  w2 = new NativeWindow(oo);
  w2.bounds = new Rectangle(700, 200, 300, 200);
  w2.visible = true;
  w2.addEventListener(Event.CLOSE, function(e:Event):void { gotClose = true; });
  eq("w.listOwnedWindows() has one entry", w.listOwnedWindows().length, 1);
  eq("...and its element IS the owned window object", w.listOwnedWindows()[0] === w2, true);
  eq("w2.owner IS w", w2.owner === w, true);
  eq("w2.listOwnedWindows() is empty", w2.listOwnedWindows().length, 0);
  w2.close();
  eq("close() leaves closed false for the rest of the call", w2.closed, false);
}

function phase4():void {
  eq("the window is closed at the next frame boundary", w2.closed, true);
  eq("...and Event.CLOSE arrived", gotClose, true);
}

// 槽位复用（阶段二百零八）。后端只把「最低空闲槽位」发出去：w2 死后它的槽位会立刻被下一个
// NativeWindow 拿走。AIR 的语义是两边都干净——新窗口是新的（closed=false、在 openedWindows 里），
// 旧对象也不再指那个槽位（改 w3.title 不许把 w2.title 一起改掉）。旧实现只清了后端一侧，
// ASC_wins 里的 closed 还是 1：新窗口一出生就是「已关闭」，于是 ASC_win_poll 直接 return，
// 它的关闭按钮永远不会被受理、CLOSING/ACTIVATE 全被丢掉、openedWindows/activeWindow 里也找不到它。
var w3:NativeWindow = null;
var w4:NativeWindow = null;
var w5:NativeWindow = null;
var w6:NativeWindow = null;
function phase5():void {
  w3 = new NativeWindow(new NativeWindowInitOptions());
  w3.title = "reuse";
  eq("a window created in a recycled slot starts out open", w3.closed, false);
  eq("...and has its own Stage", w3.stage === null, false);
  eq("...and is listed in openedWindows",
    NativeApplication.nativeApplication.openedWindows.indexOf(w3) >= 0, true);
  // 旧对象必须彻底脱钩：它现在指 -1，读自己的 title 再也不会读到别人的。
  eq("the closed window does not alias the new occupant", w2.title, "");
  eq("...and is still closed", w2.closed, true);
  w3.close();
  setTimeout(phase6, 600);
}

function phase6():void {
  eq("the recycled window closes normally", w3.closed, true);
  w4 = new NativeWindow(new NativeWindowInitOptions());
  eq("a second recycled window is open again", w4.closed, false);
  eq("the previously closed one stays shut", w3.closed, true);
  w4.close();
  // 真实系统拖拽：AIR 回 true（本示例放在最后，拖拽闩锁随进程退出一起消失）。
  eq("startMove() reports a started drag", w.startMove(), true);
  eq("startResize(bottomRight) reports a started resize", w.startResize(NativeWindowResize.BOTTOM_RIGHT), true);
  setTimeout(phase7, 600);
}

// stage.scaleMode 的写入必须**当场**重算 stageWidth/stageHeight（阶段二百二十六）。
// AIR 的 stageWidth 是 (客户区, scaleMode) 的派生物，改模式立刻生效；真实 App（本仓库的
// cn.edoctor.view.meeting.MeetingWindow）的顺序是 `super(opts)` -> `bounds = rect` ->
// `stage.scaleMode = NO_SCALE`，然后**下一行**就按 stageWidth 排版。旧实现只在 resize/渲染时
// 重算，而那次 resize 永远不来，于是整棵树排在大窗的左上角（temp/nworder/ 实测：窗口
// 1792x1038、舞台仍 400x200）。这里用「同一组 bounds、两种写入顺序」比对，不写死像素值，
// 这样 macOS/Windows 边框差异和「框 vs 客户区」口径都不影响断言。
function phase7():void {
  var opts:NativeWindowInitOptions = new NativeWindowInitOptions();
  w5 = new NativeWindow(opts);
  w5.bounds = new Rectangle(100, 100, 600, 400);
  w5.stage.scaleMode = StageScaleMode.NO_SCALE;
  w6 = new NativeWindow(opts);
  w6.stage.scaleMode = StageScaleMode.NO_SCALE;
  w6.bounds = new Rectangle(100, 100, 600, 400);
  eq("scaleMode set after bounds reaches the same stage size as before bounds",
    w5.stage.stageWidth + "x" + w5.stage.stageHeight,
    w6.stage.stageWidth + "x" + w6.stage.stageHeight);
  eq("...and that size is the client area, not the 400x200 ctor default",
    w5.stage.stageWidth > 400, true);
  // showAll 下舞台停在 design 矩形（400x200），这一步**不能**被上面的修复带偏。
  var w7:NativeWindow = new NativeWindow(opts);
  w7.bounds = new Rectangle(100, 100, 600, 400);
  eq("showAll still pins the stage to the design rect",
    w7.stage.stageWidth + "x" + w7.stage.stageHeight, "400x200");
  w5.close();
  w6.close();
  w7.close();
  if (fails.length == 0) {
    trace("native-window: " + pass + " checks passed");
  } else {
    trace("native-window: " + pass + " passed, " + fails.length + " FAILED");
    for (var i:int = 0; i < fails.length; i++) trace("FAIL " + fails[i]);
  }
  NativeApplication.nativeApplication.exit();
}

stage.showWindow(300, 200, "native-window example");
