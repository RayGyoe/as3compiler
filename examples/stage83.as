// stage83.as — 阶段八十三：Stage3D 对齐加固（v0.3.94）。
//
// 覆盖：
//  1. render-to-texture（setRenderToTexture / setRenderToBackBuffer）
//  2. CubeTexture / RectangleTexture 资源类 + Context3DCubeMapFace 常量
//  3. AGAL3 实例化 drawTrianglesInstanced + setProgramConstantsFromVector
//
// 纯 CPU 回归：断言状态机与资源类字段；Metal 模式（stage83.build.json）
// 额外走 render-to-texture 路径读回像素断言（中心红色）。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function u32le(ba:ByteArray, v:int):void {
  ba.writeByte(v & 0xFF);
  ba.writeByte((v >> 8) & 0xFF);
  ba.writeByte((v >> 16) & 0xFF);
  ba.writeByte((v >> 24) & 0xFF);
}

const R_VA:int = 0;
const R_V:int  = 4;
const SW_ID:int = 0xE4;

function op(op:int, hasDst:Boolean, hasSrc1:Boolean, hasSrc2:Boolean):int {
  return op | (hasDst ? 0x100 : 0) | (hasSrc1 ? 0x200 : 0) | (hasSrc2 ? 0x400 : 0);
}
function dst(regType:int, num:int, mask:int):int { return (mask << 16) | (regType << 24) | num; }
function srcLo(num:int, swizzle:int):int { return (swizzle << 24) | num; }
function srcHi(regType:int):int { return regType; }

function makeVertex():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x00);
  u32le(ba, op(0x00, true, true, false));
  u32le(ba, dst(3, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_VA));
  u32le(ba, op(0x00, true, true, false));
  u32le(ba, dst(R_V, 0, 0xF));
  u32le(ba, srcLo(1, SW_ID)); u32le(ba, srcHi(R_VA));
  return ba;
}
function makeFragment():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x01);
  u32le(ba, op(0x00, true, true, false));
  u32le(ba, dst(3, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_V));
  return ba;
}

var stage:Stage = new Stage();
var s3d:Stage3D = stage.stage3Ds[0];
s3d.requestContext3D(Context3DRenderMode.AUTO);
var ctx:Context3D = s3d.context3D;
check(ctx != null, "context3D created");
ctx.configureBackBuffer(16, 16, 0, false);

// ===== 1. CubeTexture / RectangleTexture 资源类 =====
var cube:CubeTexture = ctx.createCubeTexture(4, Context3DTextureFormat.BGRA, false);
check(cube != null, "cube texture created");
check(cube.width == 4 && cube.height == 4, "cube size");
var faceBd:BitmapData = new BitmapData(4, 4, false, 0xFF00FF00);
cube.uploadFromBitmapData(faceBd, Context3DCubeMapFace.POSITIVE_X, 0);
check(cube.face0 == faceBd, "cube face0 uploaded");
check(Context3DCubeMapFace.NEGATIVE_Z == 5, "cube face constant");

var rect:RectangleTexture = ctx.createRectangleTexture(5, 7, Context3DTextureFormat.BGRA, false);
check(rect != null, "rectangle texture created");
check(rect.width == 5 && rect.height == 7, "rectangle size");
var rectBd:BitmapData = new BitmapData(5, 7, false, 0xFF0000FF);
rect.uploadFromBitmapData(rectBd);
check(rect.bitmapData == rectBd, "rectangle bitmapData stored");

// ===== 2. render-to-texture =====
var rtt:Texture = ctx.createTexture(16, 16, Context3DTextureFormat.BGRA, true);
check(rtt != null, "render texture created");

// 顶点/索引/程序
var pos:Vector.<Number> = new Vector.<Number>();
pos.push(-1); pos.push(-1); pos.push(0);
pos.push(3);  pos.push(-1); pos.push(0);
pos.push(-1); pos.push(3);  pos.push(0);
var vbPos:VertexBuffer3D = ctx.createVertexBuffer(3, 3);
vbPos.uploadFromVector(pos, 0, 3);
ctx.setVertexBufferAt(0, vbPos, 0, Context3DVertexBufferFormat.FLOAT_3);

var col:Vector.<Number> = new Vector.<Number>();
col.push(1); col.push(0); col.push(0);
col.push(1); col.push(0); col.push(0);
col.push(1); col.push(0); col.push(0);
var vbCol:VertexBuffer3D = ctx.createVertexBuffer(3, 3);
vbCol.uploadFromVector(col, 0, 3);
ctx.setVertexBufferAt(1, vbCol, 0, Context3DVertexBufferFormat.FLOAT_3);

var idx:Vector.<uint> = new Vector.<uint>();
idx.push(0); idx.push(1); idx.push(2);
var ib:IndexBuffer3D = ctx.createIndexBuffer(3);
ib.uploadFromVector(idx, 0, 3);

var prog:Program3D = ctx.createProgram();
prog.upload(makeVertex(), makeFragment());
ctx.setProgram(prog);

// setProgramConstantsFromVector（AGAL3）：上传 vc0。
var cnst:Vector.<Number> = new Vector.<Number>();
cnst.push(1); cnst.push(0); cnst.push(0); cnst.push(1);
ctx.setProgramConstantsFromVector(Context3DProgramType.VERTEX, 0, cnst, 1);

// 渲染到纹理，然后读回（本后端 drawToBitmapData 读取当前渲染目标）。
ctx.setRenderToTexture(rtt, false);
ctx.clear(0, 0, 0, 1);
ctx.drawTriangles(ib, 0, 1);
var rttBd:BitmapData = new BitmapData(16, 16, false, 0);
ctx.drawToBitmapData(rttBd);
ctx.setRenderToBackBuffer();

if (ctx.driverInfo.indexOf("Metal") >= 0) {
  // Metal：render-to-texture 后中心像素为红色。
  check(rttBd.getPixel(8, 8) == 0xFF0000, "render-to-texture center pixel is red");
} else {
  // 纯 C：无 GPU，读回为黑。
  check(rttBd.getPixel(8, 8) == 0x000000, "pure-C rtt readback is black");
}

// ===== 3. AGAL3 实例化 =====
ctx.clear(0, 0, 0, 1);
ctx.drawTrianglesInstanced(ib, 0, 1, 2); // 2 实例（不抛异常即可）
ctx.present();

// 释放资源（含 render-texture 的 MTLTexture 句柄，Metal 模式）。
rtt.dispose();
cube.dispose();
rect.dispose();

trace("stage83: " + (ctx.driverInfo.indexOf("Metal") >= 0 ? "(Metal)" : "(state machine)") + " passed");
