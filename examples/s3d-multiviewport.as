// s3d-multiviewport.as — Stage3D 多视口保真（阶段四百六十八）。
//
// 盯的是「AIR 桌面运行时给四个 Stage3D 视口、我们只懒建一个、合成只取 [0]」那个缺口。
// AIR 官方 Stage3D 文档：「The runtime stage provides a fixed number of Stage3D
// objects… Desktop computers typically provide four Stage3D instances.」adl 51.4.1
// 实测 `stage.stage3Ds.length == 4`。每个视口是一块独立 GPU 表面 + 独立 Context3D，
// 用自己的 x/y 摆在舞台上；合成序**预定义、按索引升序底→顶**（[0] 底 [3] 顶），全部
// 在 2D 显示列表之下，且视口彼此**不透明**（重叠区整块遮挡，不混合）。
//
// 进程内可断言的部分（本示例）：
//   ① stage3Ds.length == 4（不是 1）；
//   ② 同一 Stage 的 [0]/[1] 是两个不同 Stage3D、两个不同 Context3D；
//   ③ 两个 context 各画一个满屏四边形、各自 drawToBitmapData = 各自设的颜色
//      ⇒ 两个视口的渲染目标没有别名到一起；
//   ④ Stage3D.x/y 范围 [-8191, 8191]，越界抛 ArgumentError #2006 + adl 实测原文；
//   ⑤ Stage3D.visible 原样读回。
//
// **不能**在这里断言的：像素级「重叠区 [1] 盖 [0]」。合成器写窗口 drawable，AS3 没有
// 回读窗口像素的 API（AIR 也没有）。这一层靠截屏验收：[0] 红 @(0,0)、[1] 绿 @(100,0)
// 重叠，重叠区采样 = 纯绿（[1] 顶），与 adl 逐字一致（temp/s3dmulti/，TODO.md 阶段
// 四百六十八 有实测记录）。
//
// 跑法（清单按宿主展开：macOS 走 Metal，Windows 走 D3D12）：
//   node src/index.ts examples/s3d-multiviewport.as \
//        --manifest examples/s3d-multiviewport.build.json --run
import flash.display.Stage;
import flash.display.Stage3D;
import flash.display3D.Context3D;
import flash.display3D.Context3DRenderMode;
import flash.display3D.Context3DTriangleFace;
import flash.display3D.IndexBuffer3D;
import flash.display3D.Program3D;
import flash.display3D.VertexBuffer3D;
import flash.display3D.Context3DProgramType;
import flash.display3D.Context3DVertexBufferFormat;
import flash.display.BitmapData;
import flash.events.Event;
import flash.desktop.NativeApplication;

var pass:int = 0;
var fails:Array = [];

function eq(label:String, got:*, want:*):void {
  if (String(got) == String(want)) { pass++; }
  else { fails.push(label + " (got " + got + ", want " + want + ")"); }
}

// ---- 手搓 AGAL（与 examples/s3d-multiwindow.as 同一套）----
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
function vsSolidQuad():ByteArray {
  var ba:ByteArray = head(false, 1);
  tok(ba, 0x00, dst(4, 0, 0xF), srcLo(0, 0xE4), 1, 0, 0);
  tok(ba, 0x00, dst(3, 0, 0xF), srcLo(0, 0xE4), 0, 0, 0);
  return ba;
}
function fsSolid():ByteArray {
  var ba:ByteArray = head(true, 1);
  tok(ba, 0x00, dst(3, 0, 0xF), srcLo(0, 0xE4), 4, 0, 0);
  return ba;
}
function makeQuad(ctx:Context3D):IndexBuffer3D {
  var vb:VertexBuffer3D = ctx.createVertexBuffer(4, 4);
  vb.uploadFromVector(Vector.<Number>([-1,-1,0,1, 1,-1,0,1, 1,1,0,1, -1,1,0,1]), 0, 4);
  ctx.setVertexBufferAt(0, vb, 0, Context3DVertexBufferFormat.FLOAT_4);
  var idx:Vector.<uint> = new Vector.<uint>();
  idx.push(0); idx.push(1); idx.push(2); idx.push(0); idx.push(2); idx.push(3);
  var ib:IndexBuffer3D = ctx.createIndexBuffer(6);
  ib.uploadFromVector(idx, 0, 6);
  return ib;
}
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
var ca:Context3D = null;
var cb:Context3D = null;
var iba:IndexBuffer3D = null;
var ibb:IndexBuffer3D = null;
var gpu:Boolean = false;
var frames:int = 0;
var reported:Boolean = false;

function onFrame(e:Event):void {
  frames++;
  if (iba != null) paint(ca, iba, [1, 0, 0]);
  if (ibb != null) paint(cb, ibb, [0, 1, 0]);
  if (reported || frames < 4) return;
  reported = true;
  verify();
  if (fails.length == 0) trace("s3d-multiviewport: " + pass + " checks passed");
  else {
    trace("s3d-multiviewport: " + pass + " passed, " + fails.length + " FAILED");
    for (var i:int = 0; i < fails.length; i++) trace("FAIL " + fails[i]);
  }
  NativeApplication.nativeApplication.exit();
}

function verify():void {
  // ① AIR 桌面给四个视口（adl 51.4.1 实测 length==4），不是一个。
  eq("stage3Ds.length is 4 (AIR desktop)", rootStage.stage3Ds.length, 4);
  var s3a:Stage3D = rootStage.stage3Ds[0];
  var s3b:Stage3D = rootStage.stage3Ds[1];
  // ② 同一 Stage 的两个视口是不同 Stage3D / 不同 Context3D。
  eq("viewport [0] and [1] are distinct Stage3D objects", s3a != s3b, true);
  eq("both contexts exist", (ca != null) && (cb != null), true);
  eq("the two Context3D objects differ", ca != cb, true);
  eq("backBuffer follows configureBackBuffer (200x200)", ca.backBufferWidth + "x" + ca.backBufferHeight, "200x200");
  // ③ 两个视口各保留自己的内容（渲染目标没有别名到一起）。
  var pa:uint = paintAndRead(ca, iba, [1, 0, 0]);
  var pb:uint = paintAndRead(cb, ibb, [0, 1, 0]);
  if (gpu) {
    eq("viewport [0] renders its own colour (red)", pa, 0xFF0000);
    eq("viewport [1] renders its own colour (green)", pb, 0x00FF00);
  } else {
    eq("pure-C readback is black for viewport [0]", pa, 0x000000);
    eq("pure-C readback is black for viewport [1]", pb, 0x000000);
  }
  // ④ x/y 范围 [-8191, 8191]，越界抛 #2006（adl 实测文案），被拒的赋值不落库。
  s3b.x = 8191;
  eq("x=8191 is accepted", s3b.x, 8191);
  s3b.x = 100;
  var id:int = 0; var msg:String = ""; var nm:String = "";
  try { s3b.x = 8192; } catch (e1:Error) { id = e1.errorID; msg = e1.message; nm = e1.name; }
  eq("x=8192 throws", id, 2006);
  eq("the error is an ArgumentError", nm, "ArgumentError");
  eq("the error text matches AIR", msg, "Error #2006: The supplied index is out of bounds.");
  eq("...and the rejected value was not stored", s3b.x, 100);
  // ⑤ visible 原样读回；默认 true；x/y 默认 0。
  s3b.visible = false;
  eq("visible=false reads back", s3b.visible, false);
  s3b.visible = true;
  eq("visible=true reads back", s3b.visible, true);
  eq("Stage3D.visible defaults to true", s3a.visible, true);
  eq("viewport [0].x/y default to 0", s3a.x + "," + s3a.y, "0,0");
}

var s3dA:Stage3D = rootStage.stage3Ds[0];
var s3dB:Stage3D = rootStage.stage3Ds[1];
s3dA.requestContext3D(Context3DRenderMode.AUTO);
s3dB.requestContext3D(Context3DRenderMode.AUTO);
ca = s3dA.context3D;
cb = s3dB.context3D;
ca.configureBackBuffer(200, 200, 0, false, false);
cb.configureBackBuffer(200, 200, 0, false, false);
ca.setCulling(Context3DTriangleFace.NONE);
cb.setCulling(Context3DTriangleFace.NONE);
gpu = ca.driverInfo.indexOf("Metal") >= 0 || ca.driverInfo.indexOf("Direct3D") >= 0;
iba = makeQuad(ca);
ibb = makeQuad(cb);
// [0] 红 @(0,0)、[1] 绿 @(100,0)：重叠区 x=100..200，截屏判 [1] 盖 [0]。
s3dA.x = 0; s3dA.y = 0;
s3dB.x = 100; s3dB.y = 0;
ca.clear(0, 0, 0, 1);
cb.clear(0, 0, 0, 1);

rootStage.addEventListener(Event.ENTER_FRAME, onFrame);
rootStage.showWindow(400, 300, "s3d-multiviewport");