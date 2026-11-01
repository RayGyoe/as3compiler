// stage346.as — 阶段三百四十六：写掩码逐分量展开时，与目的寄存器同名的源操作数必须先快照。
//
// AGAL 的一条指令是「先读全部源操作数，再写目的」。翻译器把写掩码展开成**逐分量**语句
// （x 在 y 之前、y 在 z 之前），于是「源操作数就是目的寄存器、且它的 swizzle 会读到已经被
// 写过的分量」这一类指令会读到**新值**：
//
//   mul ft1.xyz, ft0.xyz, ft1.xxxx
//   →   ft1.x = ft0.x * ft1.x;   （对）
//       ft1.y = ft0.y * ft1.x;   （错：这里是刚写进去的新 ft1.x）
//       ft1.z = ft0.z * ft1.x;
//
// 结果整个向量被乘上了自己的 x 分量。实测后果：asaot3d 的镜面金属球采样立方体环境时，
// 红通道为 0 的贴图（绿/蓝面）在 AOT 上全黑，而 adl（真 AGAL）是对的 —— 见
// asaot3d/apps/cubeface-m25。修法是先 `float4 as_agal_s0 = ft1;` 再按分量算。
//
// 本示例同时钉两件事：① 翻译文本里必须有那条快照、且后续读到的是快照；② 真上屏时
// （链路里链了 Metal 胶水）该指令的结果必须等于不做别名时的结果 —— 绿就是绿，不是黑。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function has(s:String, sub:String, msg:String):void { if (s.indexOf(sub) < 0) throw new Error("FAIL: " + msg + " (missing '" + sub + "')"); }
function lacks(s:String, sub:String, msg:String):void { if (s.indexOf(sub) >= 0) throw new Error("FAIL: " + msg + " (unexpected '" + sub + "')"); }

function u32le(ba:ByteArray, v:int):void {
  ba.writeByte(v & 0xFF);
  ba.writeByte((v >> 8) & 0xFF);
  ba.writeByte((v >> 16) & 0xFF);
  ba.writeByte((v >> 24) & 0xFF);
}

const R_VA:int = 0;   // vertex attribute
const R_VC:int = 1;   // constant（顶点 vc / 片元 fc，同一种编码，靠程序类型区分）
const R_FT:int = 2;   // temporary（顶点 vt / 片元 ft）
const R_OP:int = 3;   // output（顶点 op / 片元 oc）
const R_V:int  = 4;   // varying
const SW_ID:int  = 0xE4; // 恒等 swizzle .xyzw
const SW_X:int   = 0x00; // .xxxx

function dst(regType:int, num:int, mask:int):int {
  return (mask << 16) | (regType << 24) | num;
}
function srcLo(num:int, swizzle:int):int { return (swizzle << 24) | num; }
function srcHi(regType:int):int { return regType; }

// 每条 AGAL 指令固定 24 字节：opcode(4) + dst(4) + src1(8) + src2(8)。
function emit(ba:ByteArray, op:int, d:int, s1:int, s1t:int, s2:int, s2t:int):void {
  u32le(ba, op);
  u32le(ba, d);
  u32le(ba, s1); u32le(ba, s1t);
  u32le(ba, s2); u32le(ba, s2t);
}

// mov op, va0 ; mov v0, va1（va0 = 位置 float3，va1 = 颜色 float3）
function makeVertex():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x00);
  emit(ba, 0x00, dst(R_OP, 0, 0xF), srcLo(0, SW_ID), srcHi(R_VA), 0, 0);          // mov op, va0
  emit(ba, 0x00, dst(R_V, 0, 0xF), srcLo(1, SW_ID), srcHi(R_VA), 0, 0);        // mov v0, va1
  return ba;
}

// 片元：
//   mov ft0, fc0                 -- (0,1,0,1) 纯绿
//   mov ft1, fc1                 -- (1,1,1,1) 全一，使乘法恒等
//   mul ft1.xyz, ft0.xyz, ft1.xxxx   -- ← 别名：源 2 就是目的寄存器
//   mov oc, ft1
// 正确语义：(0,1,0)*1 = 绿。别名 bug：(0*1, 1*0, 0*0) = 黑。
function makeFragment():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x01);
  emit(ba, 0x00, dst(R_FT, 0, 0xF), srcLo(0, SW_ID), srcHi(R_VC), 0, 0);       // mov ft0, fc0
  emit(ba, 0x00, dst(R_FT, 1, 0xF), srcLo(1, SW_ID), srcHi(R_VC), 0, 0);       // mov ft1, fc1
  emit(ba, 0x03, dst(R_FT, 1, 0x7), srcLo(0, SW_ID), srcHi(R_FT), srcLo(1, SW_X), srcHi(R_FT));
  emit(ba, 0x00, dst(R_OP, 0, 0xF), srcLo(1, SW_ID), srcHi(R_FT), 0, 0);          // mov oc, ft1
  return ba;
}

// ===== 1. 翻译文本（纯 CPU，任何后端都跑得到）=====
var fmsl:String = AGALTranslator.translate(makeFragment(), "msl");
// 快照必须出现在被别名的那条指令之前，且后续分量读到的是快照而不是新值。
has(fmsl, "float4 as_agal_s0 = ft1;", "aliased source is snapshotted before the write-mask");
has(fmsl, "ft1.x = ft0.x * as_agal_s0.x;", "component x reads the snapshot");
has(fmsl, "ft1.y = ft0.y * as_agal_s0.x;", "component y reads the snapshot, not the new ft1.x");
has(fmsl, "ft1.z = ft0.z * as_agal_s0.x;", "component z reads the snapshot, not the new ft1.x");
lacks(fmsl, "ft1.y = ft0.y * ft1.x;", "no component reads a component written earlier in the same instruction");
// 快照必须是**全寄存器**拷贝（写掩码之外的 w 也要在），否则 w 会被漏掉。
has(fmsl, "float4 as_agal_s0 = ft1;", "the snapshot copies the whole register");
// GLSL 档同一实现，逐字同样要求（它是 web 后端的实际产物）。
var fglsl:String = AGALTranslator.translate(makeFragment(), "glsl");
has(fglsl, "vec4 as_agal_s0 = ft1;", "GLSL target snapshots the aliased source too");
has(fglsl, "ft1.y = ft0.y * as_agal_s0.x;", "GLSL component y reads the snapshot");

// ===== 2. 真上屏（只有链了 Metal 胶水的构建才有 GPU）=====
var stage:Stage = new Stage();
var s3d:Stage3D = stage.stage3Ds[0];
s3d.requestContext3D(Context3DRenderMode.AUTO);
var ctx:Context3D = s3d.context3D;
check(ctx != null, "context3D created");

ctx.configureBackBuffer(16, 16, 0, false);

var pos:Vector.<Number> = new Vector.<Number>();
pos.push(-1); pos.push(-1); pos.push(0);
pos.push(3);  pos.push(-1); pos.push(0);
pos.push(-1); pos.push(3);  pos.push(0);
var vbPos:VertexBuffer3D = ctx.createVertexBuffer(3, 3);
vbPos.uploadFromVector(pos, 0, 3);
ctx.setVertexBufferAt(0, vbPos, 0, Context3DVertexBufferFormat.FLOAT_3);

// 顶点色标成白色：颜色全部来自片元常量，别名 bug 才不会被顶点插值掩盖。
var col:Vector.<Number> = new Vector.<Number>();
for (var i:int = 0; i < 3; i++) { col.push(1); col.push(1); col.push(1); }
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

var fc0:Vector.<Number> = new Vector.<Number>(); fc0.push(0); fc0.push(1); fc0.push(0); fc0.push(1);
var fc1:Vector.<Number> = new Vector.<Number>(); fc1.push(1); fc1.push(1); fc1.push(1); fc1.push(1);
ctx.setProgramConstantsFromVector(Context3DProgramType.FRAGMENT, 0, fc0);
ctx.setProgramConstantsFromVector(Context3DProgramType.FRAGMENT, 1, fc1);

// 真上屏的读回是**机会性**的：本机实测窗口还没合成时 drawToBitmapData 一律清黑，
// 这与翻译器无关（stage82/83 的 GPU 腿同样没接进 CI）。真正逐字钉住本 bug 的是上面的
// 翻译文本断言，它不依赖 GPU；这里只在上屏读回可用时再补一刀像素证据。
if (stage.nativeWindow != null) stage.nativeWindow.activate();

var bd:BitmapData = new BitmapData(16, 16, false, 0);
ctx.drawToBitmapData(bd);
var center:uint = bd.getPixel(8, 8);

if (ctx.driverInfo.indexOf("Metal") >= 0) {
  // 绿 → 0x00FF00。别名 bug 会让它变成 0x000000。
  if (center == 0x00FF00) {
    trace("stage346: aliased write-mask (Metal pixel) passed");
  } else {
    // 读回不可用（窗口未合成）与真失败在像素上无法区分，如实报明而不是静默通过。
    trace("stage346: SKIP Metal pixel readback (got 0x" + center.toString(16) + "); translation assertions above still hold");
  }
} else {
  // 纯 C：GPU 未链接，drawToBitmapData 清黑。
  check(center == 0x000000, "pure-C readback is black");
  trace("stage346: aliased write-mask (translation only) passed");
}
