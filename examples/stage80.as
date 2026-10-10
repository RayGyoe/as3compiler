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

// ===== HLSL 目标（阶段一百三十一）：Windows/D3D12 Stage3D 后端的前置 =====
// 第三个 target：AGALTranslator.translate(bytes, "hlsl") -> 运行期 as_agal_translate 的
// target 2（编译期由 ASC_S3D_HLSL 选中 ASC_AGAL_TARGET 2）。它与 MSL/GLSL 的关系是
// 「同一实现、按 target 分档」：只有寄存器名、内建拼写、入口形状三处随 target 变，
// opcode 表 / 槽位解码 / 写掩码展开三处完全共用 —— 所以上面两目标的断言逐字不变，
// 本文件就是那把回归锁（改档位时 MSL/GLSL 的输出必须一个字节都不动）。
//
// 形态差异及其理由：
//   1. 常量寄存器住进 cbuffer（vc[i] 的数组下标 = AGAL 寄存器号），纹理/采样器逐寄存器
//      声明 register(tN)/register(sN) —— 与 MSL 的 constant float4* + texture(N)/sampler(N)
//      同构，因为 D3D 和 Metal 一样没有「采样状态挂在纹理对象上」的模型（那是 GL 的）。
//   2. 入口是 vs_main/fs_main，参数是结构体；输出打进带 SV_* 语义的结构体
//      （SV_Position / SV_TargetN / SV_Depth）。
//   3. 不做 Y 取反：AS3、Metal、D3D 的渲染目标行 0 都在上，只有 GL 在下。GLSL 分支那句
//      gl_Position.y = -gl_Position.y 绝不能出现在这里（否则整幅画面上下翻转）。
var vhlsl:String = AGALTranslator.translate(makeVertex(), "hlsl");
has(vhlsl, "struct VSIn {", "HLSL vertex declares a stage-input struct");
has(vhlsl, "float4 a0 : TEXCOORD0;", "HLSL va0 -> input.a0 bound at TEXCOORD0");
has(vhlsl, "float4 position : SV_Position;", "HLSL vertex output position");
// m44 读 vc0..vc3（mark-use 把整段矩阵行都标上），所以 cbuffer 尺寸是 4 而不是 1 ——
// 与 GLSL 那条「只标基址会让 vc3 未声明」的断言同一个事实，这里是它在 cbuffer 上的投影。
has(vhlsl, "cbuffer VCBuf : register(b0) { float4 vc[4]; };", "HLSL constants live in a cbuffer sized to the highest register the program touches");
has(vhlsl, "VSOut vs_main(VSIn input) {", "HLSL vertex entry point");
has(vhlsl, "op = mul(float4x4(vc[0], vc[1], vc[2], vc[3]), input.a0);", "HLSL m44 -> mul(float4x4, vec)");
has(vhlsl, "vt0.x = input.a1.z;", "HLSL swizzle .z expanded");
has(vhlsl, "v0 = vt0;", "HLSL mov v0,vt0 translated");
has(vhlsl, "output.varying0 = v0;", "HLSL varying written into the output struct");
// 别的 target 的标识符一个都不能漏进来 —— 这正是 AGENTS.md 2.5 说的「编得过但结果是错的」。
check(vhlsl.indexOf("gl_Position") < 0, "HLSL must not use GLSL built-ins");
check(vhlsl.indexOf("metal_stdlib") < 0, "HLSL must not include the Metal stdlib");
check(vhlsl.indexOf("in.a0") < 0, "HLSL must not use MSL stage-input naming");
check(vhlsl.indexOf("-gl_Position.y") < 0, "HLSL must not flip clip-space Y (D3D is top-down like AS3)");

var fhlsl:String = AGALTranslator.translate(makeFragment(), "hlsl");
has(fhlsl, "Texture2D<float4> fs0 : register(t0);", "HLSL texture declared per sampled register");
has(fhlsl, "SamplerState smp0 : register(s0);", "HLSL sampler declared per sampled register");
has(fhlsl, "float4 v0 : TEXCOORD0;", "HLSL varying read through the stage-input struct");
has(fhlsl, "float4 color0 : SV_Target0;", "HLSL fragment output colour");
has(fhlsl, "cbuffer FCBuf : register(b0) { float4 fc[1]; };", "HLSL fragment constants are fc[] in a cbuffer");
has(fhlsl, "FSOut fs_main(FSIn input) {", "HLSL fragment entry point");
has(fhlsl, "ft0 = fs0.Sample(smp0, input.v0.xy);", "HLSL tex -> Texture2D.Sample(sampler, uv)");
has(fhlsl, "oc = ft0 * fc[0];", "HLSL mul oc,ft0,fc0 translated");
has(fhlsl, "output.color0 = oc;", "HLSL packs oc into SV_Target0");
check(fhlsl.indexOf("gl_FragColor") < 0, "HLSL must not use gl_FragColor");
check(fhlsl.indexOf("texture2D(") < 0, "HLSL must not use GLSL texture2D");
check(fhlsl.indexOf(".sample(") < 0, "HLSL must not use MSL sample()");

// 目标字符串决定档位：三档必须产出三份不同文本。"hlsl" 不是 "glsl" 的别名，更不能落到
// 默认的 MSL 档（bridge 的 else 分支就是 MSL）—— 漏一处就会把 MSL 源喂给 D3D 编译器。
check(vhlsl != vglsl && vhlsl != vmsl && fhlsl != fglsl && fhlsl != fmsl, "the three targets are distinct");
var fallback:String = AGALTranslator.translate(makeVertex(), "nonsense");
check(fallback == vmsl, "an unknown target falls back to MSL, so 'hlsl' must be spelled out exactly");

// 矩阵指令：HLSL 的 '*' 在矩阵上按分量乘（不是矩阵积），必须用 mul()。m33 与 m34 都用
// 3x4 形态，与 MSL/GLSL 那条逐行 dot() 的语义逐位一致（AGAL 的 m33 按规范只读 .xyz，
// 三档统一的取舍记在 TODO.md，不在这一档单独改动）。
var mhlsl:String = AGALTranslator.translate(makeMatrixVertex(), "hlsl");
has(mhlsl, "cbuffer VCBuf : register(b0) { float4 vc[9]; };", "HLSL cbuffer sized to the highest constant register touched");
has(mhlsl, "op = mul(float4x4(vc[1], vc[2], vc[3], vc[4]), input.a0);", "HLSL m44 reads the 4 rows from its base register");
has(mhlsl, "op.xyz = mul(float3x4(vc[6], vc[7], vc[8]), input.a1);", "HLSL m34 writes .xyz from a 3x4 mul");

// 多采样器：与 MSL 同口径，逐 fsN 声明纹理+采样器（D3D 也没有「状态在纹理上」的模型）。
var mshlsl:String = AGALTranslator.translate(makeMultiSamplerFragment(), "hlsl");
has(mshlsl, "Texture2D<float4> fs3 : register(t3);", "HLSL declares fs3 at texture slot 3");
has(mshlsl, "SamplerState smp3 : register(s3);", "HLSL declares smp3 at sampler slot 3");
has(mshlsl, "fs3.Sample(smp3,", "HLSL samples fs3 through smp3, not a shared sampler");
check(mshlsl.indexOf("smp1") < 0, "HLSL declares no sampler for an unused texture register");
// 带写掩码的 tex 走逐分量发射（另一条分支），HLSL 的 Sample 形态同样要沿用到分量展开上。
var mmhlsl:String = AGALTranslator.translate(makeMaskedSamplerFragment(), "hlsl");
has(mmhlsl, "ft2.x = fs3.Sample(smp3, input.v1.xy).x;", "HLSL masked tex keeps its operands in order");
has(mmhlsl, "ft2.y = fs3.Sample(smp3, input.v1.xy).y;", "HLSL masked tex expands every component");

// 片段深度输出（od）：HLSL 用 SV_Depth 系统值语义，且要求每条执行路径都写到。
var odhlsl:String = AGALTranslator.translate(makeOdFragment(), "hlsl");
has(odhlsl, "float depth : SV_Depth;", "HLSL od write declares the SV_Depth output");
has(odhlsl, "output.depth = od;", "HLSL od is written unconditionally");
check(odhlsl.indexOf("gl_FragDepth") < 0, "HLSL must not use gl_FragDepth");

// 比较指令：全掩码在 HLSL 里是「bool4 -> float4 构造」（HLSL 允许这种逐分量转换），
// 部分掩码走分量三元 —— 与 MSL select() / GLSL mix() 是三条不同的合法写法，但结果一致。
var hsge:String = AGALTranslator.translate(makeCompareFragment(0x29, R_V, 0, 0xF), "hlsl");
has(hsge, "ft5 = float4(input.v0 >= input.v0);", "HLSL sge full-mask converts a bool4 to float4");
var hslt:String = AGALTranslator.translate(makeCompareFragment(0x2a, R_V, 1, 0xF), "hlsl");
has(hslt, "ft5 = float4(input.v0 < input.v1);", "HLSL slt full-mask keeps s1/s2 order");
var hseq:String = AGALTranslator.translate(makeCompareFragment(0x2c, R_V, 1, 0xF), "hlsl");
has(hseq, "ft5 = float4(input.v0 == input.v1);", "HLSL seq full-mask keeps s1/s2 order");
var hsne:String = AGALTranslator.translate(makeCompareFragment(0x2d, R_V, 1, 0xF), "hlsl");
has(hsne, "ft5 = float4(input.v0 != input.v1);", "HLSL sne full-mask keeps s1/s2 order");
var hmask:String = AGALTranslator.translate(makeCompareFragment(0x29, R_V, 1, 0x1), "hlsl");
has(hmask, "ft5.x = (input.v0.x >= input.v1.x) ? 1.0 : 0.0;", "HLSL sge with a write mask stays component-wise");

// dp3/dp4 产出标量点积，而目的地是 float4。MSL/GLSL 的「向量构造器 + 标量」是合法 splat，
// 但 fxc（d3dcompiler_47，ps_4_0/vs_4_0）对任何标量 splat 构造器都报 X3014
// 'incorrect number of arguments to numeric-type constructor' —— 连 float4(1.0) 也一样，
// 且与 D3DCOMPILE_ENABLE_STRICTNESS 无关（ps_6_0/DXC 才接受）。所以 HLSL 必须改用标量
// swizzle '.xxxx' 展开。实证：temp/hlslcheck 把每个生成着色器交给 D3DCompile 全量编译，
// 这是当时唯一编不过的点。
function makeDotFragment():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x01);
  // dp3 ft0, v0, v1
  u32le(ba, op(0x12, true, true, true));
  u32le(ba, dst(R_VT, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_V));
  u32le(ba, srcLo(1, SW_ID)); u32le(ba, srcHi(R_V));
  // dp4 oc, v0, v1
  u32le(ba, op(0x13, true, true, true));
  u32le(ba, dst(R_OP, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_V));
  u32le(ba, srcLo(1, SW_ID)); u32le(ba, srcHi(R_V));
  return ba;
}
var dmsl:String = AGALTranslator.translate(makeDotFragment(), "msl");
has(dmsl, "ft0 = float4(dot(in.v0.xyz, in.v1.xyz));", "MSL dp3 keeps the vector constructor");
has(dmsl, "oc = float4(dot(in.v0, in.v1));", "MSL dp4 keeps the vector constructor");
var dglsl:String = AGALTranslator.translate(makeDotFragment(), "glsl");
has(dglsl, "ft0 = vec4(dot(v0.xyz, v1.xyz));", "GLSL dp3 keeps the vector constructor");
has(dglsl, "gl_FragColor = vec4(dot(v0, v1));", "GLSL dp4 keeps the vector constructor");
var dhlsl:String = AGALTranslator.translate(makeDotFragment(), "hlsl");
has(dhlsl, "ft0 = dot(input.v0.xyz, input.v1.xyz).xxxx;", "HLSL dp3 splats through a scalar swizzle");
has(dhlsl, "oc = dot(input.v0, input.v1).xxxx;", "HLSL dp4 splats through a scalar swizzle");
check(dhlsl.indexOf("float4(dot(") < 0, "HLSL must not build the dot result with a scalar-splat constructor");

// AGAL3 实例 id（iid，类型码 7）：HLSL 里没有对应寄存器，走 SV_InstanceID 系统值。
// 这个程序同时锁住「不读顶点属性时不能声明空结构体」：HLSL 拒绝 struct VSIn {}（fxc 实测
// 语法错误，见 temp/hlslcheck），所以入口签名必须跟着属性/varying 的实际使用情况变。
function makeIidVertex():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x00);
  // mov vt0, iid
  u32le(ba, op(0x00, true, true, false));
  u32le(ba, dst(R_VT, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(7));
  u32le(ba, 0); u32le(ba, 0);
  // mov op, vt0
  u32le(ba, op(0x00, true, true, false));
  u32le(ba, dst(R_OP, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_VT));
  u32le(ba, 0); u32le(ba, 0);
  return ba;
}
var iidhlsl:String = AGALTranslator.translate(makeIidVertex(), "hlsl");
has(iidhlsl, "VSOut vs_main(uint iid : SV_InstanceID) {", "HLSL iid comes from SV_InstanceID");
has(iidhlsl, "vt0 = float4(iid, iid, iid, iid);", "HLSL iid is broadcast to a float4");
check(iidhlsl.indexOf("struct VSIn") < 0, "HLSL omits the stage-input struct when no attribute is read");

// 同理：不读 varying 的片元程序不能声明 struct FSIn {}，入口也不带参数。
function makeConstantFragment():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x01);
  // mov oc, fc0
  u32le(ba, op(0x00, true, true, false));
  u32le(ba, dst(R_OP, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_VC));
  u32le(ba, 0); u32le(ba, 0);
  return ba;
}
var cfhlsl:String = AGALTranslator.translate(makeConstantFragment(), "hlsl");
has(cfhlsl, "FSOut fs_main() {", "HLSL fragment entry takes no stage-input struct when it reads no varying");
check(cfhlsl.indexOf("struct FSIn") < 0, "HLSL omits the stage-input struct when no varying is read");

// tld（AGAL3 顶点纹理取样）在三个目标上都明确不支持：它的 LOD 来源在 AIR 上无法实测
// （Adobe 的 AGAL 参考页已 404），而静默丢掉一条指令会让像素悄悄错掉（AGENTS.md 2.5 禁止）。
// 新增一档不能把「明确拒绝」变成「编得过」—— 这里对三档逐个断言它仍然抛错。
function makeTldVertex():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x00);
  u32le(ba, op(0x2e, true, true, true));
  u32le(ba, dst(R_OP, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_VA));
  u32le(ba, 0); u32le(ba, 5 | (1 << 28));
  return ba;
}
for (var ti:int = 0; ti < 3; ti++) {
  var tgt:String = ti == 0 ? "msl" : (ti == 1 ? "glsl" : "hlsl");
  var tldThrew:Boolean = false;
  try { AGALTranslator.translate(makeTldVertex(), tgt); } catch (e:Error) { tldThrew = true; }
  check(tldThrew, "tld must be refused loudly for target " + tgt);
}
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
