// stage82.as — 阶段八十二：Metal 端到端三角形（彩色三角形上屏）。
//
// 纯 CPU 回归：断言状态机（requestContext3D → configureBackBuffer →
// createVertexBuffer/uploadFromVector → setVertexBufferAt → drawTriangles）
// 与 AGAL→MSL 翻译（AGALTranslator.translate）。
//
// Metal 模式（stage82.build.json：链接 vendor/stage3d_glue.mm + ASC_RENDER_STAGE3D）
// 额外走完整 GPU 路径：上传顶点/索引/常量/纹理、编译 MSL、drawTriangles、
// drawToBitmapData 读回并断言中心像素为红色。用 driverInfo 判断后端，
// 使同一份 .as 在纯 C 与 Metal 两模式下都可通过。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function has(s:String, sub:String, msg:String):void { if (s.indexOf(sub) < 0) throw new Error("FAIL: " + msg + " (missing '" + sub + "')"); }

// 小端写 32 位无符号整数（AGAL 字节码为小端）。
function u32le(ba:ByteArray, v:int):void {
  ba.writeByte(v & 0xFF);
  ba.writeByte((v >> 8) & 0xFF);
  ba.writeByte((v >> 16) & 0xFF);
  ba.writeByte((v >> 24) & 0xFF);
}

// AGAL 寄存器类型（shader 相对编码）。
const R_VA:int = 0;  // vertex attribute
const R_V:int  = 4;  // varying
const SW_ID:int = 0xE4; // identity swizzle .xyzw

// opcode token：op | hasDst(0x100) | hasSrc1(0x200) | hasSrc2(0x400)
function op(op:int, hasDst:Boolean, hasSrc1:Boolean, hasSrc2:Boolean):int {
  return op | (hasDst ? 0x100 : 0) | (hasSrc1 ? 0x200 : 0) | (hasSrc2 ? 0x400 : 0);
}
function dst(regType:int, num:int, mask:int):int {
  return (mask << 16) | (regType << 24) | num;
}
function srcLo(num:int, swizzle:int):int { return (swizzle << 24) | num; }
function srcHi(regType:int):int { return regType; }

// 每条 AGAL 指令固定占 24 字节（192 bit）：opcode(4) + dst(4) + src1(8) + 零填充(8)，
// 与 AGALMiniAssembler 的字节格式一致（translator 按 24 字节槽位解析）。
// vertex: mov op, va0 ; mov v0, va1  （va0=位置 float3，va1=颜色 float3）
function makeVertex():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x00); // header (vertex)
  u32le(ba, op(0x00, true, true, false));
  u32le(ba, dst(3, 0, 0xF));           // op（vertex output）
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_VA)); // va0
  u32le(ba, 0); u32le(ba, 0);          // src2 零填充（补齐 24 字节）
  u32le(ba, op(0x00, true, true, false));
  u32le(ba, dst(R_V, 0, 0xF));         // v0（varying）
  u32le(ba, srcLo(1, SW_ID)); u32le(ba, srcHi(R_VA)); // va1
  u32le(ba, 0); u32le(ba, 0);          // src2 零填充（补齐 24 字节）
  return ba;
}

// fragment: mov oc, v0 （把顶点插值后的颜色作为输出）
function makeFragment():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x01); // header (fragment)
  u32le(ba, op(0x00, true, true, false));
  u32le(ba, dst(3, 0, 0xF));           // oc（fragment output）
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_V)); // v0
  u32le(ba, 0); u32le(ba, 0);          // src2 零填充（补齐 24 字节）
  return ba;
}

// ===== 1. AGAL→MSL 翻译断言（纯 CPU，两模式通用） =====
var vmsl:String = AGALTranslator.translate(makeVertex(), "msl");
has(vmsl, "in.a0", "va0 attribute mapped");
has(vmsl, "out.position", "vertex position output");
has(vmsl, "varying0", "varying declared");

var fmsl:String = AGALTranslator.translate(makeFragment(), "msl");
has(fmsl, "return oc", "fragment color output");

// ===== 2. Context3D 状态机 + 全链路绘制 =====
var stage:Stage = new Stage();
var s3d:Stage3D = stage.stage3Ds[0];
s3d.requestContext3D(Context3DRenderMode.AUTO);
var ctx:Context3D = s3d.context3D;
check(ctx != null, "context3D created");

ctx.configureBackBuffer(16, 16, 0, false);
check(ctx.backBufferWidth == 16, "backBufferWidth");

// 顶点：两个 stream（位置 float3 + 颜色 float3），覆盖整个屏幕的三角形。
var pos:Vector.<Number> = new Vector.<Number>();
pos.push(-1); pos.push(-1); pos.push(0);
pos.push(3);  pos.push(-1); pos.push(0);
pos.push(-1); pos.push(3);  pos.push(0);
var vbPos:VertexBuffer3D = ctx.createVertexBuffer(3, 3);
vbPos.uploadFromVector(pos, 0, 3);
ctx.setVertexBufferAt(0, vbPos, 0, Context3DVertexBufferFormat.FLOAT_3);

var col:Vector.<Number> = new Vector.<Number>();
// 全红（0xFF0000）
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

ctx.clear(0, 0, 0, 1);
ctx.drawTriangles(ib, 0, 1);
ctx.present();

// ===== 3. 后端分派：Metal 模式读回像素断言，纯 C 模式断言黑屏读回 =====
var bd:BitmapData = new BitmapData(16, 16, false, 0);
ctx.drawToBitmapData(bd);
var center:uint = bd.getPixel(8, 8);

if (ctx.driverInfo.indexOf("Metal") >= 0) {
  // Metal：三角形覆盖全屏且为红色 → 中心像素 0xFF0000。
  check(center == 0xFF0000, "Metal center pixel is red (got " + center + ")");
} else {
  // 纯 C：GPU 未链接，drawToBitmapData 清黑。
  check(center == 0x000000, "pure-C readback is black");
}

trace("stage82: triangle " + (ctx.driverInfo.indexOf("Metal") >= 0 ? "(Metal)" : "(state machine)") + " passed");
