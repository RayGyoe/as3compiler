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
has(fmsl, ".sample(smp0,", "MSL tex -> sample()");
has(fmsl, "oc = ft0 * fc[0]", "mul oc,ft0,fc0 translated");

var fglsl:String = AGALTranslator.translate(makeFragment(), "glsl");
has(fglsl, "texture2D(", "GLSL tex -> texture2D()");
has(fglsl, "gl_FragColor", "GLSL fragment output color");
has(fglsl, "uniform sampler2D fs0", "GLSL sampler declaration");

// ===== 多采样器：MSL 每个被采样的纹理寄存器各声明一个 sampler =====
// Metal 的 filter/wrap/mip 状态挂在 MTLSamplerState 上、不在纹理对象上，所以「全程序
// 共用一个 sampler」无法表达逐单元的 setSamplerStateAt —— 所有单元都只能用最低已绑定
// 单元的状态（web/GL 后端没这个问题：状态属于纹理对象，后端已逐单元应用）。翻译器改为
// 按 fsN 声明 `sampler smpN [[sampler(N)]]`，绘制时由后端按单元绑定；Metal 还要求着色器
// 声明的每个 [[sampler(N)]] 都有状态绑定，缺一个整个 draw 被拒（native 侧见
// vendor/stage3d_glue.mm 的逐单元绑定）。
function makeMultiSamplerFragment():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x01);
  // tex ft0, v0, fs0 <2d,linear,repeat>
  u32le(ba, op(0x28, true, true, true));
  u32le(ba, dst(R_VT, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_V));
  u32le(ba, 0); u32le(ba, 5 | (1 << 28) | (1 << 20));
  // tex ft1, v1, fs3：第 3 号纹理单元，**跳过** fs1/fs2（真实程序会这样用：
  // Starling 的多纹理 Filter 只占用自己用到的单元）
  u32le(ba, op(0x28, true, true, true));
  u32le(ba, dst(R_VT, 1, 0xF));
  u32le(ba, srcLo(1, SW_ID)); u32le(ba, srcHi(R_V));
  // sampler token 两半：[num:16][lod:8][0:8] 与 [samplerbits:32]，槽位固定 24 字节
  u32le(ba, 3); u32le(ba, 5 | (1 << 28));
  // mul oc, ft0, ft1
  u32le(ba, op(0x03, true, true, true));
  u32le(ba, dst(R_OP, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_VT));
  u32le(ba, srcLo(1, SW_ID)); u32le(ba, srcHi(R_VT));
  return ba;
}
var msmsl:String = AGALTranslator.translate(makeMultiSamplerFragment(), "msl");
has(msmsl, "sampler smp0 [[sampler(0)]]", "fs0 declares its own sampler at index 0");
has(msmsl, "sampler smp3 [[sampler(3)]]", "fs3 declares its own sampler at index 3");
check(msmsl.indexOf("sampler smp1") < 0, "no sampler declared for an unused texture register");
has(msmsl, "fs0.sample(smp0,", "tex on fs0 samples through smp0");
has(msmsl, "fs3.sample(smp3,", "tex on fs3 samples through smp3");
check(msmsl.indexOf("sample(smp,") < 0, "no tex instruction uses a shared sampler name");
// 单纹理程序（最常见形态）也走同一路径：smp0 而非 smp。
check(fmsl.indexOf("sampler smp0 [[sampler(0)]]") >= 0, "the single-texture program declares smp0");
// 带写掩码的 tex 走的是另一条发射路径（逐分量展开），sampler 名同样要按寄存器取；
// 该分支里 MSL/GLSL 的格式化参数个数不同，必须两条独立 sprintf（三元格式串会错位）。
function makeMaskedSamplerFragment():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x01);
  // tex ft2.xy, v1, fs3
  u32le(ba, op(0x28, true, true, true));
  u32le(ba, dst(R_VT, 2, 0x3)); // ft2, mask .xy
  u32le(ba, srcLo(1, SW_ID)); u32le(ba, srcHi(R_V));
  u32le(ba, 3); u32le(ba, 5 | (1 << 28));
  // mov oc, ft2
  u32le(ba, op(0x00, true, true, false));
  u32le(ba, dst(R_OP, 0, 0xF));
  u32le(ba, srcLo(2, SW_ID)); u32le(ba, srcHi(R_VT));
  u32le(ba, 0); u32le(ba, 0);
  return ba;
}
var mmsmsl:String = AGALTranslator.translate(makeMaskedSamplerFragment(), "msl");
has(mmsmsl, "ft2.x = fs3.sample(smp3, in.v1.xy).x", "masked tex on fs3 samples through smp3 (.x)");
has(mmsmsl, "ft2.y = fs3.sample(smp3, in.v1.xy).y", "masked tex on fs3 samples through smp3 (.y)");
check(mmsmsl.indexOf("smp0") < 0, "a program sampling only fs3 declares no smp0");
var mmsglsl:String = AGALTranslator.translate(makeMaskedSamplerFragment(), "glsl");
has(mmsglsl, "ft2.x = texture2D(fs3, v1.xy).x", "GLSL masked tex keeps its operands in order");

var msglsl:String = AGALTranslator.translate(makeMultiSamplerFragment(), "glsl");
has(msglsl, "uniform sampler2D fs0;", "GLSL declares fs0 as its own uniform sampler");
has(msglsl, "uniform sampler2D fs3;", "GLSL declares fs3 as its own uniform sampler");
check(msglsl.indexOf("uniform sampler2D fs1;") < 0, "GLSL declares no unused sampler uniform");

// ===== GLSL 目标专属断言（web 的 Stage3D 后端依赖这些形态）=====
// GLSL ES 1.00 要求显式精度限定，MSL 不需要 —— 缺了它程序直接编译失败。
has(vglsl, "precision highp float;", "GLSL vertex declares default float precision");
has(fglsl, "precision highp float;", "GLSL fragment declares default float precision");
// Y 轴翻转：GL 的渲染目标行 0 在下、AS3/Metal 在上，故顶点阶段统一取反；
// 采样与 glReadPixels 的行序、以及绕序（保持 GL_CCW 为正面）都依赖这一行。
check(vglsl.indexOf("gl_Position.y = -gl_Position.y;") >= 0, "GLSL vertex flips clip-space Y");
// varying 必须在顶点/片元两阶段用一致的声明，否则 GL 拒绝链接；顶点阶段只声明它写过的。
has(vglsl, "varying vec4 v0;", "GLSL vertex declares the varying it writes");
has(fglsl, "varying vec4 v0;", "GLSL fragment declares the varying it reads");

// 矩阵指令（m44/m34/m33）读的是基址起的连续寄存器，GLSL 目标逐寄存器声明 uniform，
// 故翻译器的 mark-use 必须把整段行都标上：只标基址会让 vc2/vc3 等未声明，
// 链接着色器时报 'vc3: undeclared identifier'（Starling 的矩阵程序全线失败）。
function makeMatrixVertex():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x00);
  // m44 op, va0, vc1 -> 读 vc1..vc4
  u32le(ba, op(0x18, true, true, true));
  u32le(ba, dst(R_OP, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_VA));
  u32le(ba, srcLo(1, SW_ID)); u32le(ba, srcHi(R_VC));
  // m34 op, va1, vc6 -> 读 vc6..vc8
  u32le(ba, op(0x19, true, true, true));
  u32le(ba, dst(R_OP, 0, 0xF));
  u32le(ba, srcLo(1, SW_ID)); u32le(ba, srcHi(R_VA));
  u32le(ba, srcLo(6, SW_ID)); u32le(ba, srcHi(R_VC));
  return ba;
}
var mglsl:String = AGALTranslator.translate(makeMatrixVertex(), "glsl");
has(mglsl, "uniform vec4 vc1;", "m44 marks its base constant row");
has(mglsl, "uniform vec4 vc3;", "m44 marks all 4 rows it reads");
has(mglsl, "uniform vec4 vc4;", "m44 marks its last row");
has(mglsl, "uniform vec4 vc8;", "m34 (3 rows from vc6) marks vc8");
has(mglsl, "dot(va0, vec4(vc3.x", "m44 row 2 expands to dot() against vc3");
check(mglsl.indexOf("uniform vec4 vc5;") < 0, "m44/m34 must not declare untouched rows (vc5 gap stays undeclared)");

// 片段深度输出（od，寄存器类型 6）走 gl_FragDepth，需按需打开 GL_EXT_frag_depth；
// 不用 od 的程序不该带这个扩展声明（web 端由 GLSL ES 侧的 #extension 生效）。
function makeOdFragment():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x01);
  // mov od, ft0：od 的类型码是 6（oc/op 是 3）
  u32le(ba, op(0x00, true, true, false));
  u32le(ba, dst(6, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_VT));
  u32le(ba, 0); u32le(ba, 0);
  return ba;
}
var odglsl:String = AGALTranslator.translate(makeOdFragment(), "glsl");
has(odglsl, "gl_FragDepth", "od write maps to gl_FragDepth");
has(odglsl, "#extension GL_EXT_frag_depth : enable", "od enables GL_EXT_frag_depth");
check(fglsl.indexOf("#extension GL_EXT_frag_depth") < 0, "programs without od must not request the extension");

// 全掩码比较指令（sge/slt/seq/sne）：按分量产出 0.0/1.0 掩码。两个目标的实现形态不同
// （MSL select() 收 float4 分量布尔，GLSL mix()+bvec→vec4 转换），曾因用「三元格式串」
// 写成一个 sprintf 而两支吃到的 varargs 个数不同（MSL 4 个、GLSL 5 个），GLSL 分支
// 静默错位成 'v0(lessThan(v1, vec4))' —— 语法错误，web 端每次全掩码比较都编不过
// 着色器（Starling CompositeFilter，即 demo 的 "Switch Filter" 按钮，是唯一命中的场景）。
// 这里逐个 opcode 断言两目标的完整表达式，同时锁住操作数顺序（错位的正是 s1/s2/v4）。
function makeCompareFragment(opcode:int, s2type:int, s2num:int, dmask:int):ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x01);
  u32le(ba, op(opcode, true, true, true));
  u32le(ba, dst(R_VT, 5, dmask)); // ft5
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_V)); // v0
  u32le(ba, srcLo(s2num, SW_ID)); u32le(ba, srcHi(s2type));
  return ba;
}
// sge ft5, v0, v0 —— Starling CompositeFilter.as 的 "ft5 -> 1, 1, 1, 1" hack，
// 即崩溃现场那段 AGAL；操作数同为一个寄存器，正好也锁住「不能把 v4 当成操作数」。
var csge:String = AGALTranslator.translate(makeCompareFragment(0x29, R_V, 0, 0xF), "glsl");
has(csge, "ft5 = mix(vec4(0.0), vec4(1.0), vec4(greaterThanEqual(v0, v0)));", "GLSL sge full-mask uses mix() + bvec4->vec4 conversion");
var msge:String = AGALTranslator.translate(makeCompareFragment(0x29, R_V, 0, 0xF), "msl");
has(msge, "ft5 = select(float4(0.0), float4(1.0), in.v0 >= in.v0);", "MSL sge full-mask uses select()");

var cslt:String = AGALTranslator.translate(makeCompareFragment(0x2a, R_V, 1, 0xF), "glsl");
has(cslt, "ft5 = mix(vec4(0.0), vec4(1.0), vec4(lessThan(v0, v1)));", "GLSL slt full-mask keeps s1/s2 order");
var cseq:String = AGALTranslator.translate(makeCompareFragment(0x2c, R_V, 1, 0xF), "glsl");
has(cseq, "ft5 = mix(vec4(0.0), vec4(1.0), vec4(equal(v0, v1)));", "GLSL seq full-mask keeps s1/s2 order");
var csne:String = AGALTranslator.translate(makeCompareFragment(0x2d, R_V, 1, 0xF), "glsl");
has(csne, "ft5 = mix(vec4(0.0), vec4(1.0), vec4(notEqual(v0, v1)));", "GLSL sne full-mask keeps s1/s2 order");
var mslt:String = AGALTranslator.translate(makeCompareFragment(0x2a, R_V, 1, 0xF), "msl");
has(mslt, "ft5 = select(float4(0.0), float4(1.0), in.v0 < in.v1);", "MSL slt full-mask uses select()");
// 部分掩码（如 sge ft5.x, ...）走「分量三元」路径而非向量比较，两目标共用同一形态，
// 既不受上面的 mix/select 改动影响，也是 full-mask 分支之外必须保留的路径。
var cmask:String = AGALTranslator.translate(makeCompareFragment(0x29, R_V, 1, 0x1), "glsl");
has(cmask, "ft5.x = (v0.x >= v1.x) ? 1.0 : 0.0;", "GLSL sge with a write mask stays component-wise");
var mmask:String = AGALTranslator.translate(makeCompareFragment(0x29, R_V, 1, 0x1), "msl");
has(mmask, "ft5.x = (in.v0.x >= in.v1.x) ? 1.0 : 0.0;", "MSL sge with a write mask stays component-wise");

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
