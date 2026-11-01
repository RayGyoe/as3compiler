// stage348.as — 阶段三百四十八：Stage3D 的 `exp` / `log` 是**以 2 为底**，不是自然指数。
//
// 这条看上去像细枝末节，但它决定了任何「把 e^x 折进常量」的写法是否成立：
//   exp(x) = 2^x      log(x) = log2(x)
// 我们自己的 AGAL 翻译早就按 exp2/log2 发射（src/runtime.ts 的 agal 反汇编：
// op 0x0d -> "exp2(...)"、op 0x0c -> "log2(...)"），adl 实测也一致 —— 也就是说
// AIR 与 AOT 在这两个算子上**本来就是对齐的**。
//
// 之所以要单独钉住：asaot3d 的 AGALRenderer 曾经把 EnvBRDFApprox 的系数折成
// -9.28 * ln2 = -6.4324（"AGAL 只有 e^x"），并给 FogExp2 少乘了一个 log2(e)。
// 两个后端**同样地**算错，所以 AOT/AIR 对比看不出来，只有对着 three.js 参考值才暴露。
// 本示例把这条语义钉死在编译器回归里：以后谁再假设 exp 是自然指数，这里立刻红。
//
// 期望值（8bit 线性回读，容忍 ±1 的舍入）：
//   exp(-1)  = 0.5      -> 127/128      （自然指数会给 0.368 -> 94）
//   exp(-4)  = 0.0625   -> 16           （自然指数会给 0.0183 -> 4）
//   log(2)   = 1.0      -> 255          （自然对数会给 0.693 -> 177）
//   log(1.5) = 0.585    -> 149          （自然对数会给 0.405 -> 103）

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function u32le(ba:ByteArray, v:int):void {
  ba.writeByte(v & 0xFF);
  ba.writeByte((v >> 8) & 0xFF);
  ba.writeByte((v >> 16) & 0xFF);
  ba.writeByte((v >> 24) & 0xFF);
}

const R_VA:int = 0;   // vertex attribute
const R_V:int  = 4;   // varying
const R_FT:int = 2;   // temporary
const SW_ID:int = 0xE4;

function dst(regType:int, num:int, mask:int):int { return (mask << 16) | (regType << 24) | num; }
function srcLo(num:int, swizzle:int):int { return (swizzle << 24) | num; }
function srcHi(regType:int):int { return regType; }

// 顶点：va0 = 裁剪空间位置，va1.x = 本用例的输入标量，原样送进 v0.x。
// 3 个顶点都给同一个标量，插值后仍是那个标量，不必依赖片元常量。
function makeVertex():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x00);
  u32le(ba, 0x00);                    // mov op, va0
  u32le(ba, dst(3, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_VA));
  u32le(ba, 0); u32le(ba, 0);
  u32le(ba, 0x00);                    // mov v0, va1
  u32le(ba, dst(R_V, 0, 0xF));
  u32le(ba, srcLo(1, SW_ID)); u32le(ba, srcHi(R_VA));
  u32le(ba, 0); u32le(ba, 0);
  return ba;
}

// 片元：op ft0.x, v0.x ; mov oc, ft0.xxxx
// oc 必须一条指令写满四个分量（AIR #3701），广播式 `mov oc, ft0.xxxx` 满足这一点。
function makeFragment(op:int):ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x00);
  u32le(ba, op);
  u32le(ba, dst(R_FT, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_V));
  u32le(ba, 0); u32le(ba, 0);
  u32le(ba, 0x00);                    // mov oc, ft0.xxxx
  u32le(ba, dst(3, 0, 0xF));
  u32le(ba, srcLo(0, 0x00)); u32le(ba, srcHi(R_FT));   // swizzle 0x00 = xxxx
  u32le(ba, 0); u32le(ba, 0);
  return ba;
}

const OP_MOV:int = 0x00;
const OP_LOG:int = 0x0C;
const OP_EXP:int = 0x0D;

var stage:Stage = new Stage();
var s3d:Stage3D = stage.stage3Ds[0];
s3d.requestContext3D(Context3DRenderMode.AUTO);
var ctx:Context3D = s3d.context3D;
check(ctx != null, "context3D created");
ctx.configureBackBuffer(16, 16, 0, false);

// 全屏三角，铺满 16x16 后台缓冲。
var pos:Vector.<Number> = new Vector.<Number>();
pos.push(-1); pos.push(-1); pos.push(0);
pos.push(3);  pos.push(-1); pos.push(0);
pos.push(-1); pos.push(3);  pos.push(0);
var vbPos:VertexBuffer3D = ctx.createVertexBuffer(3, 3);
vbPos.uploadFromVector(pos, 0, 3);
ctx.setVertexBufferAt(0, vbPos, 0, Context3DVertexBufferFormat.FLOAT_3);

// va1 每帧换一个标量；三个顶点同值。
var vbIn:VertexBuffer3D = ctx.createVertexBuffer(3, 1);
ctx.setVertexBufferAt(1, vbIn, 0, Context3DVertexBufferFormat.FLOAT_1);

var idx:Vector.<uint> = new Vector.<uint>();
idx.push(0); idx.push(1); idx.push(2);
var ib:IndexBuffer3D = ctx.createIndexBuffer(3);
ib.uploadFromVector(idx, 0, 3);

var progExp:Program3D = ctx.createProgram();
progExp.upload(makeVertex(), makeFragment(OP_EXP));
var progLog:Program3D = ctx.createProgram();
progLog.upload(makeVertex(), makeFragment(OP_LOG));

ctx.setBlendFactors(Context3DBlendFactor.ONE, Context3DBlendFactor.ZERO);

// 画一次，读回中心像素的 R 通道。
function drawScalar(prog:Program3D, x:Number):int
{
  var v:Vector.<Number> = new Vector.<Number>();
  v.push(x); v.push(x); v.push(x);
  vbIn.uploadFromVector(v, 0, 3);
  ctx.setProgram(prog);
  ctx.clear(0, 0, 0, 1, 1.0, 0, 3);
  ctx.drawTriangles(ib, 0, 1);
  var bd:BitmapData = new BitmapData(16, 16, false, 0);
  ctx.drawToBitmapData(bd);
  return (bd.getPixel(8, 8) >> 16) & 0xFF;
}

function near8(got:int, want:int):Boolean
{
  return got >= want - 1 && got <= want + 1;
}

if (ctx.driverInfo.indexOf("Metal") >= 0) {
  var e1:int = drawScalar(progExp, -1);
  // exp(-1) 若按自然指数只有 94，差得足够远。
  check(near8(e1, 127), "exp(-1) is 2^-1 = 0.5 (got " + e1 + "/255)");
  var e4:int = drawScalar(progExp, -4);
  check(near8(e4, 16), "exp(-4) is 2^-4 = 0.0625 (got " + e4 + "/255)");
  var l2:int = drawScalar(progLog, 2);
  check(near8(l2, 255), "log(2) is 1.0 (got " + l2 + "/255)");
  var l15:int = drawScalar(progLog, 1.5);
  check(near8(l15, 149), "log(1.5) is log2(1.5) = 0.585 (got " + l15 + "/255)");
  trace("stage348: exp/log are base 2 (" + e1 + ", " + e4 + ", " + l2 + ", " + l15 + ")");
} else {
  // 纯 C（无 GPU）：draw 是状态机空操作，读回清黑 —— 与 stage347 同一口径。
  check(drawScalar(progExp, -1) == 0, "pure-C readback is black");
  trace("stage348: (state machine) passed");
}

progExp.dispose();
progLog.dispose();
ib.dispose();
vbIn.dispose();
vbPos.dispose();