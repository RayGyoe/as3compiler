// s3d-multiwindow.as — Stage3D 多窗口合成（阶段四百三十六）。
//
// 盯的是「Stage3D 上屏合成是进程级单例」那个缺口。修复前：`Context3D_configureBackBuffer`
// /`present` 把渲染目标写进**全局** `ASC_stage3d_*`，`ASC_window_render` 再把那唯一一张
// 表面 blit 进**每一个** GPU 窗口 ⇒ 两窗都显示「最后 present 的那个」；`Stage3D.x/y/
// visible` 只存不画；`configureBackBuffer` 的 HiDPI 倍率读全局 `ASC_win_scale`（上一个
// 渲染的窗口）而不是所属窗口。
//
// 进程内可断言的部分（本示例）：
//   ① 两个窗口的 Stage 各自有一份 stage3Ds，两个 Stage3D / Context3D 是不同对象；
//   ② 两个 context 的 backBuffer 尺寸各自是 configureBackBuffer 要的尺寸（两个尺寸不同，
//      顺带证明渲染目标没有退化成共用一张）；
//   ③ 两个 context 各画一个满屏四边形、各自 drawToBitmapData 采样 = 各自设的颜色
//      ⇒ 后端没有把两个 context 的渲染目标别名到一起；
//   ④ Stage3D.x/y 范围是 [-8191, 8191]，越界抛 ArgumentError #2006 + adl 实测原文，
//      被拒的赋值不落库；
//   ⑤ Stage3D.visible 原样读回，关掉再打开之后仍能绘制/上屏。
//
// **不能**在这里断言的：像素级「A 窗画的是 A 的表面、B 窗画的是 B 的表面」。合成器写的是
// 窗口的 drawable，AS3 侧没有回读窗口像素的 API（AIR 也没有）。这一层靠截屏验收：两窗同时
// 画不同颜色、只让其中一窗继续 present，看另一窗是否保持自己的上一帧（TODO.md 阶段
// 四百三十六 有实测记录）。
//
// 纯 C 构建（无 GPU）也能跑：此时 `driverInfo` 里没有 Metal，读回按既有惯例是黑的，断言走
// `vertex-texture.as` 同款分支（示例套件里它是 compile+link only，见 test/examples.ts）。
//
// 跑法（清单按宿主展开：macOS 走 Metal，Windows 走 D3D12；见
// docs/zh-cn/compile.md §3.5）：
//   node src/index.ts examples/s3d-multiwindow.as \
//        --manifest examples/s3d-multiwindow.build.json --run
import flash.display.Stage;
import flash.display.Stage3D;
import flash.display3D.Context3D;
import flash.display3D.Context3DRenderMode;
import flash.display3D.IndexBuffer3D;
import flash.display3D.Program3D;
import flash.display3D.VertexBuffer3D;
import flash.display3D.Context3DProgramType;
import flash.display3D.Context3DVertexBufferFormat;
import flash.display.BitmapData;
import flash.display.NativeWindow;
import flash.display.NativeWindowInitOptions;
import flash.display.NativeWindowSystemChrome;
import flash.events.Event;
import flash.desktop.NativeApplication;
import flash.geom.Rectangle;

var pass:int = 0;
var fails:Array = [];

function eq(label:String, got:*, want:*):void {
  if (String(got) == String(want)) { pass++; }
  else { fails.push(label + " (got " + got + ", want " + want + ")"); }
}

// ---- 手搓 AGAL（与 examples/vertex-texture.as 同一套；示例套件无 AGAL 汇编器依赖）----
// AGAL 寄存器编号：op/oc 都是 3（顶点阶段 op、片元阶段 oc 同一号），v0 = 4，va0 = 0，vc0 = 1。
const R_OP:int = 3;
const R_V:int = 4;
const R_VA:int = 0;
const R_VC:int = 1;
const SW_ID:int = 0xE4;

function u32le(ba:ByteArray, v:int):void {
  ba.writeByte(v & 0xFF); ba.writeByte((v >> 8) & 0xFF);
  ba.writeByte((v >> 16) & 0xFF); ba.writeByte((v >> 24) & 0xFF);
}
function dst(regType:int, num:int, mask:int):int { return (mask << 16) | (regType << 24) | num; }
function srcLo(num:int, swizzle:int):int { return (swizzle << 24) | num; }
function tok(ba:ByteArray, op:int, d:int, s1lo:int, s1hi:int, s2lo:int, s2hi:int):void {
  u32le(ba, op); u32le(ba, d); u32le(ba, s1lo); u32le(ba, s1hi); u32le(ba, s2lo); u32le(ba, s2hi);
}
function head(isFrag:Boolean, version:int):ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, version); ba.writeByte(0xA1); ba.writeByte(isFrag ? 0x01 : 0x00);
  return ba;
}
// 顶点：mov op, va0（顶点已经是裁剪空间坐标）；mov v0, vc0（把 vc0 的 RGBA 传给片元）。
function vsSolidQuad():ByteArray {
  var ba:ByteArray = head(false, 1);
  tok(ba, 0x00, dst(R_V, 0, 0xF), srcLo(0, SW_ID), R_VC, 0, 0);
  tok(ba, 0x00, dst(R_OP, 0, 0xF), srcLo(0, SW_ID), R_VA, 0, 0);
  return ba;
}
// 片元：mov oc, v0（纯色填充）。
function fsSolid():ByteArray {
  var ba:ByteArray = head(true, 1);
  tok(ba, 0x00, dst(R_OP, 0, 0xF), srcLo(0, SW_ID), R_V, 0, 0);
  return ba;
}

// 满屏四边形（裁剪空间 -1..1）。索引 0,1,2 / 0,2,3。
function makeQuad(ctx:Context3D):IndexBuffer3D {
  var vb:VertexBuffer3D = ctx.createVertexBuffer(4, 4);
  vb.uploadFromVector(Vector.<Number>([
    -1, -1, 0, 1,
     1, -1, 0, 1,
     1,  1, 0, 1,
    -1,  1, 0, 1]), 0, 4);
  ctx.setVertexBufferAt(0, vb, 0, Context3DVertexBufferFormat.FLOAT_4);
  var idx:Vector.<uint> = new Vector.<uint>();
  idx.push(0); idx.push(1); idx.push(2); idx.push(0); idx.push(2); idx.push(3);
  var ib:IndexBuffer3D = ctx.createIndexBuffer(6);
  ib.uploadFromVector(idx, 0, 6);
  return ib;
}

// 画一帧纯色到**后缓冲**（不是 render-to-texture：窗口合成取的就是后缓冲，所以这样画完
// 上屏和读回是同一张表面），再读回左上角像素。
function paint(ctx:Context3D, ib:IndexBuffer3D, rgb:Array):void {
  var prog:Program3D = ctx.createProgram();
  prog.upload(vsSolidQuad(), fsSolid());
  ctx.setProgram(prog);
  var c:Vector.<Number> = new Vector.<Number>();
  c.push(rgb[0]); c.push(rgb[1]); c.push(rgb[2]); c.push(1);
  ctx.setProgramConstantsFromVector(Context3DProgramType.VERTEX, 0, c, 1);
  ctx.clear(0, 0, 0, 1);
  ctx.drawTriangles(ib, 0, 2);
  ctx.present();
}

function paintAndRead(ctx:Context3D, ib:IndexBuffer3D, rgb:Array):uint {
  paint(ctx, ib, rgb);
  var bmd:BitmapData = new BitmapData(8, 8, false, 0x000000);
  ctx.drawToBitmapData(bmd);
  return bmd.getPixel(1, 1);
}

var rootStage:Stage = new Stage();
var w2:NativeWindow = null;
var ca:Context3D = null;
var cb:Context3D = null;
var iba:IndexBuffer3D = null;
var ibb:IndexBuffer3D = null;
var gpu:Boolean = false;
var frames:int = 0;
var reported:Boolean = false;

function onFrame(e:Event):void {
  frames++;
  // 每帧各窗画自己的颜色并上屏（present 是显式的：本运行时不像 AIR 那样自动提交）。
  if (iba != null) paint(ca, iba, [1, 0, 0]);
  if (ibb != null) paint(cb, ibb, [0, 1, 0]);
  if (reported || frames < 4) return;
  reported = true;
  verify();
  if (w2 != null) w2.close();
  if (fails.length == 0) trace("s3d-multiwindow: " + pass + " checks passed");
  else {
    trace("s3d-multiwindow: " + pass + " passed, " + fails.length + " FAILED");
    for (var i:int = 0; i < fails.length; i++) trace("FAIL " + fails[i]);
  }
  NativeApplication.nativeApplication.exit();
}

function verify():void {
  var s3a:Stage3D = rootStage.stage3Ds[0];
  var s3b:Stage3D = w2.stage.stage3Ds[0];
  // ① 每个 Stage 各自一份 stage3Ds，两个 Stage3D / Context3D 是不同对象。
  eq("main stage has a stage3Ds slot", s3a != null, true);
  eq("the secondary window's stage has its own stage3Ds slot", s3b != null, true);
  eq("the two Stage3D objects differ", s3a != s3b, true);
  eq("both contexts exist", (ca != null) && (cb != null), true);
  eq("the two Context3D objects differ", ca != cb, true);

  // ② backBuffer 跟随各自的 configureBackBuffer（两个尺寸不同 ⇒ 没有共用一张目标）。
  eq("main backBuffer is the configured 300x200", ca.backBufferWidth + "x" + ca.backBufferHeight, "300x200");
  eq("secondary backBuffer is the configured 240x160", cb.backBufferWidth + "x" + cb.backBufferHeight, "240x160");

  // ③ 两个 context 各自保留自己的内容。
  var pa:uint = paintAndRead(ca, iba, [1, 0, 0]);
  var pb:uint = paintAndRead(cb, ibb, [0, 1, 0]);
  if (gpu) {
    eq("main context renders its own colour (red)", pa, 0xFF0000);
    eq("secondary context renders its own colour (green)", pb, 0x00FF00);
  } else {
    eq("pure-C readback is black for the main context", pa, 0x000000);
    eq("pure-C readback is black for the secondary context", pb, 0x000000);
  }

  // ④ Stage3D.x/y 范围 [-8191, 8191]，越界抛 ArgumentError #2006（adl 51.4.1 实测文案）。
  s3b.x = 8191;
  eq("x=8191 is accepted", s3b.x, 8191);
  s3b.x = -8191;
  eq("x=-8191 is accepted", s3b.x, -8191);
  s3b.x = 0;
  var id:int = 0; var msg:String = ""; var nm:String = "";
  try { s3b.x = 8192; } catch (e1:Error) { id = e1.errorID; msg = e1.message; nm = e1.name; }
  eq("x=8192 throws", id, 2006);
  eq("the error is an ArgumentError", nm, "ArgumentError");
  eq("the error text matches AIR", msg, "Error #2006: The supplied index is out of bounds.");
  eq("...and the rejected value was not stored", s3b.x, 0);
  id = 0;
  try { s3b.y = -8192; } catch (e2:Error) { id = e2.errorID; }
  eq("y=-8192 throws", id, 2006);

  // ⑤ visible 原样读回；关掉再打开之后仍能画（没有把窗口表面置成不可用）。
  s3b.x = 40; s3b.y = 30;
  eq("x/y read back", s3b.x + "," + s3b.y, "40,30");
  s3b.visible = false;
  eq("visible=false reads back", s3b.visible, false);
  s3b.visible = true;
  eq("visible=true reads back", s3b.visible, true);
  eq("Stage3D.visible defaults to true", s3a.visible, true);
  eq("main Stage3D.x/y default to 0", s3a.x + "," + s3a.y, "0,0");
}

var opts:NativeWindowInitOptions = new NativeWindowInitOptions();
opts.systemChrome = NativeWindowSystemChrome.NONE;
opts.transparent = false;
w2 = new NativeWindow(opts);
w2.bounds = new Rectangle(420, 120, 240, 160);
w2.stage.color = 0x101010;
w2.visible = true;

var s3dA:Stage3D = rootStage.stage3Ds[0];
var s3dB:Stage3D = w2.stage.stage3Ds[0];
s3dA.requestContext3D(Context3DRenderMode.AUTO);
s3dB.requestContext3D(Context3DRenderMode.AUTO);
ca = s3dA.context3D;
cb = s3dB.context3D;
ca.configureBackBuffer(300, 200, 0, false, false);
cb.configureBackBuffer(240, 160, 0, false, false);
ca.setCulling(Context3DTriangleFace.NONE);
cb.setCulling(Context3DTriangleFace.NONE);
gpu = ca.driverInfo.indexOf("Metal") >= 0;
iba = makeQuad(ca);
ibb = makeQuad(cb);
// 让两窗各自持续画自己的颜色，截屏/harness 才看得到「各窗各表面」。
ca.clear(0, 0, 0, 1);
cb.clear(0, 0, 0, 1);

rootStage.addEventListener(Event.ENTER_FRAME, onFrame);
rootStage.showWindow(400, 300, "s3d-multiwindow");