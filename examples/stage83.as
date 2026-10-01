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

// 每条 AGAL 指令固定占 24 字节（192 bit）：opcode(4) + dst(4) + src1(8) + src2(8)
// + 零填充补足 24，与 AGALMiniAssembler 的字节格式一致（translator 按 24 字节槽位
// 解析，槽内未用到的操作数位置必须以零填充，否则下一条指令会被并进当前槽）。
// vertex: mov op, va0 ; mov v0, va1  （va0=位置 float3，va1=颜色 float3）
function makeVertex():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x00); // header (vertex)
  u32le(ba, op(0x00, true, true, false));
  u32le(ba, dst(3, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_VA));
  u32le(ba, 0); u32le(ba, 0);          // src2 零填充（补齐 24 字节）
  u32le(ba, op(0x00, true, true, false));
  u32le(ba, dst(R_V, 0, 0xF));
  u32le(ba, srcLo(1, SW_ID)); u32le(ba, srcHi(R_VA));
  u32le(ba, 0); u32le(ba, 0);          // src2 零填充（补齐 24 字节）
  return ba;
}
// fragment: mov oc, v0 （把顶点插值后的颜色作为输出）
function makeFragment():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x01); // header (fragment)
  u32le(ba, op(0x00, true, true, false));
  u32le(ba, dst(3, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_V));
  u32le(ba, 0); u32le(ba, 0);          // src2 零填充（补齐 24 字节）
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

// ===== 4. 多采样器：逐单元 sampler 声明 + 逐单元状态绑定（阶段八十九·三十九）=====
// Metal 的 filter/wrap 状态挂在 MTLSamplerState 上、不在纹理对象上，所以「全程序共用一个
// sampler」无法表达逐单元 setSamplerStateAt：翻译器改为按被采样的纹理寄存器逐一声明
// `sampler smpN [[sampler(N)]]`，后端按单元绑定各自的状态（Metal 还要求声明的每个
// [[sampler(N)]] 都有状态绑定，缺一个整个 draw 被拒 → 像素全黑）。
// 这里用双纹理片段程序 + 4x1 底色条纹理验证：单元 0/1 采样同一条纹理，只改单元 1 的
// 过滤方式（NEAREST → LINEAR），两次绘制的中心像素必须不同（共用 sampler 时必然相同）。
function makeTexVertex():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x00); // header (vertex)
  // mov op, va0（顶点位置直接给裁剪空间）
  u32le(ba, op(0x00, true, true, false));
  u32le(ba, dst(3, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_VA));
  u32le(ba, 0); u32le(ba, 0);
  // mov v0, vc0（纹理坐标来自常量，全屏恒定）
  u32le(ba, op(0x00, true, true, false));
  u32le(ba, dst(R_V, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(1)); // R_VC
  u32le(ba, 0); u32le(ba, 0);
  return ba;
}
// tex ft0, v0, fs0 ; tex ft1, v0, fs1 ; add oc, ft0, ft1
function makeTwoTexFragment():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x01); // header (fragment)
  u32le(ba, op(0x28, true, true, true));
  u32le(ba, dst(2, 0, 0xF));                       // ft0
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_V));
  u32le(ba, 0); u32le(ba, 5 | (1 << 28));          // sampler fs0
  u32le(ba, op(0x28, true, true, true));
  u32le(ba, dst(2, 1, 0xF));                       // ft1
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_V));
  u32le(ba, 1); u32le(ba, 5 | (1 << 28));          // sampler fs1
  u32le(ba, op(0x01, true, true, true));           // add
  u32le(ba, dst(3, 0, 0xF));                       // oc
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(2)); // ft0
  u32le(ba, srcLo(1, SW_ID)); u32le(ba, srcHi(2)); // ft1
  return ba;
}
// 4x1 底色条：x=0 红、1 绿、2 蓝、3 白。uv.u=0.4 → 纹素坐标 1.6（注意纹素中心在
// (i+0.5)/4，故 0.4 落在纹素 1 的中心 1.5 与纹素 2 的中心 2.5 之间、且明确偏向纹素 1）：
//   NEAREST → 纹素 1（纯绿，中心距 0.1 对 0.9）
//   LINEAR  → 0.9×绿 + 0.1×蓝（含少量蓝）
var stripBd:BitmapData = new BitmapData(4, 4, false, 0);
var colOf:Vector.<uint> = new Vector.<uint>();
colOf.push(0xFFFF0000); colOf.push(0xFF00FF00); colOf.push(0xFF0000FF); colOf.push(0xFFFFFFFF);
for (var cx:int = 0; cx < 4; cx++) for (var cy:int = 0; cy < 4; cy++) stripBd.setPixel(cx, cy, colOf[cx]);
// getPixel 返回**不含 alpha** 的 0xRRGGBB（AS3 语义：alpha 另由 getPixel32 提供），
// 故下面的期望值一律写成 0xRRGGBB。
check(stripBd.getPixel(2, 0) == 0x0000FF, "probe strip column 2 is blue");
check(stripBd.getPixel(0, 0) == 0xFF0000, "probe strip column 0 is red");
var tex0:Texture = ctx.createTexture(4, 4, Context3DTextureFormat.BGRA, false);
var tex1:Texture = ctx.createTexture(4, 4, Context3DTextureFormat.BGRA, false);
tex0.uploadFromBitmapData(stripBd);
tex1.uploadFromBitmapData(stripBd);
ctx.setTextureAt(0, tex0);
ctx.setTextureAt(1, tex1);
var prog2:Program3D = ctx.createProgram();
prog2.upload(makeTexVertex(), makeTwoTexFragment());
ctx.setProgram(prog2);
var uv:Vector.<Number> = new Vector.<Number>();
uv.push(0.4); uv.push(0.5); uv.push(0); uv.push(1);
ctx.setProgramConstantsFromVector(Context3DProgramType.VERTEX, 0, uv, 1);
ctx.setBlendFactors(Context3DBlendFactor.ONE, Context3DBlendFactor.ZERO);

function renderUnits(f0:String, f1:String):uint {
  ctx.setSamplerStateAt(0, Context3DWrapMode.CLAMP, f0, Context3DMipFilter.MIPNONE);
  ctx.setSamplerStateAt(1, Context3DWrapMode.CLAMP, f1, Context3DMipFilter.MIPNONE);
  ctx.setRenderToTexture(rtt, false);
  ctx.clear(0, 0, 0, 1);
  ctx.drawTriangles(ib, 0, 1);
  var bd:BitmapData = new BitmapData(16, 16, false, 0);
  ctx.drawToBitmapData(bd);
  ctx.setRenderToBackBuffer();
  return bd.getPixel(8, 8);
}
var pxNearest:uint = renderUnits(Context3DTextureFilter.NEAREST, Context3DTextureFilter.NEAREST);
var pxMixed:uint = renderUnits(Context3DTextureFilter.NEAREST, Context3DTextureFilter.LINEAR);
if (ctx.driverInfo.indexOf("Metal") >= 0) {
  // 两次绘制都采样同一条 4x1 底色条，只有单元 1 的过滤方式不同：
  //   都 NEAREST → 两个纯绿样本相加（钳制回纯绿）
  //   单元 1 LINEAR → 绿 + 0.9绿/0.1蓝 → 绿通道仍满、蓝通道约 26（NEAREST 时为 0）
  check(pxNearest == 0x00FF00, "both units NEAREST: two pure-green samples clamp to green (got 0x" + pxNearest.toString(16) + ")");
  check(pxMixed != pxNearest, "unit 1 LINEAR blends in a little blue, so its own sampler state is in effect (got 0x" + pxMixed.toString(16) + ")");
  var rMixed:int = (pxMixed >> 16) & 0xFF;
  var bMixed:int = pxMixed & 0xFF;
  check(rMixed == 0, "neither unit samples the red texel (got r=" + rMixed + ")");
  check(bMixed > 8 && bMixed < 64, "unit 1 LINEAR contributes ~10% of the blue texel (got b=" + bMixed + ")");
} else {
  // 纯 C（无 GPU）：draw 是状态机空操作，读回仍是黑。
  check(pxNearest == 0x000000 && pxMixed == 0x000000, "pure-C multi-sampler readback is black");
}
tex0.dispose();
tex1.dispose();
prog2.dispose();

// 释放资源（含 render-texture 的 MTLTexture 句柄，Metal 模式）。
rtt.dispose();
cube.dispose();
rect.dispose();

trace("stage83: " + (ctx.driverInfo.indexOf("Metal") >= 0 ? "(Metal)" : "(state machine)") + " passed");
