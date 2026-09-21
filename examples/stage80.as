// stage80.as — 阶段八十：AGAL 字节码内核（解析器 + 校验器 + MSL/GLSL 翻译器）。
// 手写一段最小 vertex+fragment AGAL1 字节码（小端），经 AGALTranslator.translate
// 翻译成 MSL/GLSL，断言含预期指令、寄存器映射与 swizzle/write-mask 展开；并对
// 非法 opcode 断言抛错。纯逻辑、离屏，不碰 GPU。
//
// 字节码编码以官方 AGALMiniAssembler.as 为准：header 7 字节；dest token
// [num:16][mask:8][type:8]；source token [num:16][offset:8][swizzle:8][type:8]
// [reltype:8][relsel:16]；寄存器 type 为 shader 相对编码（vc=fc=1, vt=ft=2,
// op=oc=3, fs=vs=5）。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function has(s:String, sub:String, msg:String):void { if (s.indexOf(sub) < 0) throw new Error("FAIL: " + msg + " (missing '" + sub + "')"); }

// 小端写 32 位无符号整数到 ByteArray（v 非负）。
function u32le(ba:ByteArray, v:int):void {
  ba.writeByte(v & 0xFF);
  ba.writeByte((v >> 8) & 0xFF);
  ba.writeByte((v >> 16) & 0xFF);
  ba.writeByte((v >> 24) & 0xFF);
}

// AGAL 寄存器类型（shader 相对编码，见官方 AGALMiniAssembler）。
const R_VA:int = 0; // vertex attribute
const R_VC:int = 1; // constant（vertex vc / fragment fc）
const R_VT:int = 2; // temporary（vertex vt / fragment ft）
const R_OP:int = 3; // output（vertex op / fragment oc）
const R_V:int  = 4; // varying
const R_FS:int = 5; // texture sampler（vertex vs / fragment fs）
const SW_ID:int = 0xE4; // identity swizzle .xyzw（8-bit）

// opcode token：op | hasDst(0x100) | hasSrc1(0x200) | hasSrc2(0x400)
function op(op:int, hasDst:Boolean, hasSrc1:Boolean, hasSrc2:Boolean):int {
  return op | (hasDst ? 0x100 : 0) | (hasSrc1 ? 0x200 : 0) | (hasSrc2 ? 0x400 : 0);
}
// dest token：[num:16][mask:8][type:8]
function dst(regType:int, num:int, mask:int):int {
  return (mask << 16) | (regType << 24) | num;
}
// source token 两半：[num:16][offset:8][swizzle:8] 与 [type:8][reltype:8][relsel:16]
function srcLo(num:int, swizzle:int):int { return (swizzle << 24) | num; }
function srcHi(regType:int):int { return regType; }

// vertex: m44 op, va0, vc0 ; mov vt0.xy, va1.zw ; mov v0, vt0
function makeVertex():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x00); // header (vertex)
  // m44 op, va0, vc0
  u32le(ba, op(0x18, true, true, true));
  u32le(ba, dst(R_OP, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_VA));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_VC));
  // mov vt0.xy, va1.zw：.zw swizzle = x<-z,y<-w,z<-w,w<-w = 0xFE；.xy mask = 0x3
  u32le(ba, op(0x00, true, true, false));
  u32le(ba, dst(R_VT, 0, 0x3));
  u32le(ba, srcLo(1, 0xFE)); u32le(ba, srcHi(R_VA));
  u32le(ba, 0); u32le(ba, 0); // 2 操作数指令零填充，补齐 24 字节槽位
  // mov v0, vt0
  u32le(ba, op(0x00, true, true, false));
  u32le(ba, dst(R_V, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_VT));
  u32le(ba, 0); u32le(ba, 0); // 2 操作数指令零填充，补齐 24 字节槽位
  return ba;
}

// fragment: tex ft0, v0, fs0 ; mul oc, ft0, fc0
function makeFragment():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x01); // header (fragment)
  // tex ft0, v0, fs0 <2d,linear,repeat>：sampler token [num:16][lod:8][0:8][samplerbits:32]，
  // samplerbits = type(5) | filter(1@28) | repeat(1@20)
  u32le(ba, op(0x28, true, true, true));
  u32le(ba, dst(R_VT, 0, 0xF)); // ft0 == vt type 2
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_V));
  u32le(ba, 0); u32le(ba, 5 | (1 << 28) | (1 << 20)); // sampler fs0
  // mul oc, ft0, fc0
  u32le(ba, op(0x03, true, true, true));
  u32le(ba, dst(R_OP, 0, 0xF)); // oc == op type 3
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_VT));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_VC)); // fc0 == vc type 1
  return ba;
}

// ===== 翻译断言 =====
var vmsl:String = AGALTranslator.translate(makeVertex(), "msl");
has(vmsl, "metal_stdlib", "MSL vertex include");
has(vmsl, "dot(", "m44 expands to dot()");
// MSL 顶点属性走 [[stage_in]] + [[attribute(i)]]，属性寄存器 vaN 映射为 in.aN。
has(vmsl, "in.a0", "va0 register mapped");
has(vmsl, "vc[0]", "vc0 register mapped");
has(vmsl, "vt0.x = in.a1.z", "swizzle .z expanded");
has(vmsl, "vt0.y = in.a1.w", "swizzle .w expanded");
has(vmsl, "v0 = vt0", "mov v0,vt0 translated");

var vglsl:String = AGALTranslator.translate(makeVertex(), "glsl");
has(vglsl, "gl_Position", "GLSL vertex output position");
has(vglsl, "attribute vec4 va0", "GLSL attribute declaration");
has(vglsl, "uniform vec4 vc0", "GLSL uniform declaration");

var fmsl:String = AGALTranslator.translate(makeFragment(), "msl");
has(fmsl, ".sample(smp,", "MSL tex -> sample()");
has(fmsl, "oc = ft0 * fc[0]", "mul oc,ft0,fc0 translated");

var fglsl:String = AGALTranslator.translate(makeFragment(), "glsl");
has(fglsl, "texture2D(", "GLSL tex -> texture2D()");
has(fglsl, "gl_FragColor", "GLSL fragment output color");
has(fglsl, "uniform sampler2D fs0", "GLSL sampler declaration");

// ===== 校验器：非法 opcode 抛错 =====
var bad:ByteArray = new ByteArray();
bad.writeByte(0xA0); u32le(bad, 1); bad.writeByte(0xA1); bad.writeByte(0x00);
u32le(bad, 0x99); // 非法 opcode 0x99
u32le(bad, 0); u32le(bad, 0); u32le(bad, 0); u32le(bad, 0); u32le(bad, 0); // 补齐 24 字节槽位，让校验器读到 opcode
var threw:Boolean = false;
try {
  AGALTranslator.translate(bad, "msl");
} catch (e:Error) {
  threw = true;
}
check(threw, "invalid opcode must throw");

trace("stage80: all AGAL translate/validate assertions passed");
