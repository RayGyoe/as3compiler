// vertex-texture.as — AGAL4 顶点纹理取值（vertex texture fetch / VTF）。
//
// 覆盖：
//  1. 翻译器：顶点阶段 `tld` 在三目标（MSL/HLSL/GLSL）上生成正确声明与取值
//     （`[[texture(N)]]`+`[[sampler(N)]]` / `register(tN)`+`register(sN)` /
//     `uniform sampler2D` + `texture2DLod`），LOD 字节真的进源码。
//  2. stage/version 门控按 AIR 号码与文案报错（实测 temp/vtfprobe）：
//     顶点 `tex` → #3622、片元 `tld` → #3803、顶点 `tld` v3 → #3805、
//     两阶段版本不同 → #3757。四条都在 Program3D.upload 抛（AIR 亦如此）。
//  3. 后端（Metal）：真机画一个四角 uv 不同的四边形，断言采样值与 AIR 实测语义
//     一致——纹素映射（uv 0.25/0.75 落在 2x2 的四个纹素中心）、逐顶点采样后插值、
//     NEAREST/LINEAR 与 CLAMP/REPEAT 由 sampler 状态驱动。
//
// 纯 CPU 模式（无 GPU）只跑 1/2，读回为黑。

var nchk:int = 0;
// 按主导通道断言（角上像素的顶点权重≈91%，其余是插值，见下方 3d）。
function dom(c:uint, label:String, wantR:Boolean, wantG:Boolean, wantB:Boolean):void {
  var r:int = (c >> 16) & 0xFF, g:int = (c >> 8) & 0xFF, b:int = c & 0xFF;
  check((wantR ? r > 180 : r < 60) && (wantG ? g > 180 : g < 60) && (wantB ? b > 180 : b < 60),
        label + " samples the " + (wantR ? "red" : wantG ? "green" : wantB ? "blue" : "white") +
        " texel (got 0x" + c.toString(16) + ")");
}
function check(cond:Boolean, msg:String):void { nchk++; if (!cond) throw new Error("FAIL: " + msg); }
function has(s:String, sub:String, msg:String):void { if (s.indexOf(sub) < 0) throw new Error("FAIL: " + msg + " (missing '" + sub + "')"); }

function u32le(ba:ByteArray, v:int):void {
  ba.writeByte(v & 0xFF); ba.writeByte((v >> 8) & 0xFF);
  ba.writeByte((v >> 16) & 0xFF); ba.writeByte((v >> 24) & 0xFF);
}

const R_VA:int = 0;
const R_VC:int = 1;
const R_VT:int = 2;
const R_OP:int = 3;
const R_V:int  = 4;
const R_FS:int = 5;
const SW_ID:int = 0xE4;

// opcode token 只放裸操作码；操作数个数由操作码本身决定（AGALMiniAssembler 的
// agal_op_nreg 表）。dest：[num:16][mask:8][type:8]；source：[num:16][..][swizzle:8]
// + [type:8][reltype:8][relsel:16]。
function dst(regType:int, num:int, mask:int):int { return (mask << 16) | (regType << 24) | num; }
function srcLo(num:int, swizzle:int):int { return (swizzle << 24) | num; }
function srcHi(regType:int):int { return regType; }
// 每条指令 24 字节槽位：op(4) + dst(4) + src1(8) + src2(8)。
function tok(ba:ByteArray, op:int, d:int, s1lo:int, s1hi:int, s2lo:int, s2hi:int):void {
  u32le(ba, op); u32le(ba, d); u32le(ba, s1lo); u32le(ba, s1hi); u32le(ba, s2lo); u32le(ba, s2hi);
}
function head(isFrag:Boolean, version:int):ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, version); ba.writeByte(0xA1); ba.writeByte(isFrag ? 0x01 : 0x00);
  return ba;
}
// sampler 操作数：[samplerNum:16][lod:8][0:8] + [type:8]=5（type 5 = sampler 寄存器）。

// 顶点：tld vt0, <uvSrc>, vsN ; mov v0, vt0 ; mov op, va0
function vsTld(version:int, lod:int, uvReg:int, samplerNum:int):ByteArray {
  var ba:ByteArray = head(false, version);
  tok(ba, 0x2E, dst(R_VT, 0, 0xF), srcLo(uvReg, SW_ID), R_VA, (lod << 16) | samplerNum, R_FS);
  tok(ba, 0x00, dst(R_V, 0, 0xF), srcLo(0, SW_ID), R_VT, 0, 0);
  tok(ba, 0x00, dst(R_OP, 0, 0xF), srcLo(0, SW_ID), R_VA, 0, 0);
  return ba;
}
// 顶点：用 vc0.xy 当 uv（整块四边形取同一个纹素）。
function vsUvConst(version:int, lod:int):ByteArray {
  var ba:ByteArray = head(false, version);
  tok(ba, 0x00, dst(R_VT, 0, 0xF), srcLo(0, SW_ID), R_VC, 0, 0);      // mov vt0, vc0
  tok(ba, 0x2E, dst(R_VT, 1, 0xF), srcLo(0, SW_ID), R_VT, (lod << 16), R_FS); // tld vt1, vt0, vs0
  tok(ba, 0x00, dst(R_V, 0, 0xF), srcLo(1, SW_ID), R_VT, 0, 0);       // mov v0, vt1
  tok(ba, 0x00, dst(R_OP, 0, 0xF), srcLo(0, SW_ID), R_VA, 0, 0);      // mov op, va0
  return ba;
}
// 顶点：非法用法——`tex` 在顶点阶段（AIR #3622）。
function vsTex(version:int):ByteArray {
  var ba:ByteArray = head(false, version);
  tok(ba, 0x28, dst(R_VT, 0, 0xF), srcLo(1, SW_ID), R_VA, 0, R_FS);
  tok(ba, 0x00, dst(R_V, 0, 0xF), srcLo(0, SW_ID), R_VT, 0, 0);
  tok(ba, 0x00, dst(R_OP, 0, 0xF), srcLo(0, SW_ID), R_VA, 0, 0);
  return ba;
}
// 片元：mov oc, v0（透传）。
function fsPass(version:int):ByteArray {
  var ba:ByteArray = head(true, version);
  tok(ba, 0x00, dst(R_OP, 0, 0xF), srcLo(0, SW_ID), R_V, 0, 0);
  return ba;
}
// 片元：非法用法——`tld` 在片元阶段（AIR #3803）。
function fsTld(version:int):ByteArray {
  var ba:ByteArray = head(true, version);
  tok(ba, 0x2E, dst(R_VT, 0, 0xF), srcLo(0, SW_ID), R_V, 0, R_FS);
  tok(ba, 0x00, dst(R_OP, 0, 0xF), srcLo(0, SW_ID), R_VT, 0, 0);
  return ba;
}

// ===== 1. 三目标翻译 =====
var mslVs:String = AGALTranslator.translate(vsTld(4, 0, 1, 0), "msl");
has(mslVs, "texture2d<float> fs0 [[texture(0)]]", "MSL vertex entry declares the texture for a vertex 'tld'");
has(mslVs, "sampler smp0 [[sampler(0)]]", "MSL vertex entry declares the sampler state for a vertex 'tld'");
has(mslVs, "fs0.sample(smp0, in.a1.xy, level(0.0))", "MSL vertex 'tld' samples with an explicit LOD");
check(mslVs.indexOf("vertex VSOut vs_main") >= 0, "MSL 'tld' program is still emitted as the vertex entry point");
check(mslVs.indexOf("fragment ") < 0, "the vertex program does not produce a fragment entry point");

var glslVs:String = AGALTranslator.translate(vsTld(4, 0, 1, 0), "glsl");
has(glslVs, "uniform sampler2D fs0;", "GLSL declares the sampler uniform for the vertex stage too");
has(glslVs, "texture2DLod(fs0, va1.xy, 0.0)", "GLSL vertex 'tld' uses the ES 1.00 vertex-stage LOD fetch");

var hlslVs:String = AGALTranslator.translate(vsTld(4, 0, 1, 0), "hlsl");
has(hlslVs, "Texture2D<float4> fs0 : register(t0);", "HLSL declares the SRV for the vertex stage");
has(hlslVs, "SamplerState smp0 : register(s0);", "HLSL declares the sampler for the vertex stage");
has(hlslVs, "fs0.SampleLevel(smp0, input.a1.xy, 0.0)", "HLSL vertex 'tld' uses SampleLevel");

// LOD 字节（sampler 操作数的 byte2）真的进源码：lod=2 → level/texture2DLod/SampleLevel 的 2.0。
var mslLod2:String = AGALTranslator.translate(vsTld(4, 2, 1, 0), "msl");
has(mslLod2, "level(2.0)", "the LOD byte of a vertex 'tld' reaches the MSL source");
var glslLod2:String = AGALTranslator.translate(vsTld(4, 2, 1, 0), "glsl");
has(glslLod2, "texture2DLod(fs0, va1.xy, 2.0)", "the LOD byte of a vertex 'tld' reaches the GLSL source");
// sampler 号（低 16 位）是**与片元共享的单元号**：vs3 → fs3 / register(t3)。
var mslUnit3:String = AGALTranslator.translate(vsTld(4, 0, 1, 3), "msl");
has(mslUnit3, "fs3 [[texture(3)]]", "the sampler register number of a vertex 'tld' is the shared texture unit");
has(mslUnit3, "fs3.sample(smp3,", "the vertex 'tld' samples through the sampler of that unit");

// ===== 2. stage/version 门控（AIR 号码 + 文案，实测 temp/vtfprobe）=====
function expectErr(label:String, fn:Function, id:int, sub:String):void {
  try { fn(); } catch (e:Error) {
    check(e.errorID == id, label + ": expected Error #" + id + ", got #" + e.errorID + " (" + e.message + ")");
    check(e.message.indexOf(sub) >= 0, label + ": message should mention '" + sub + "' (got '" + e.message + "')");
    return;
  }
  throw new Error("FAIL: " + label + " did not throw");
}
var ctxDummy:Context3D = null;
// 直接调翻译器（等价于 upload 期的校验）也能拿到同样的号码。
expectErr("vertex 'tex'", function():void { AGALTranslator.translate(vsTex(4), "msl"); },
          3622, "Opcode tex only allowed in fragment programs at token 1 of vertex program.");
expectErr("vertex 'tld' on AGAL3", function():void { AGALTranslator.translate(vsTld(3, 0, 1, 0), "msl"); },
          3805, "Vertex Texture Fetch is supported in Agal version 4 and above.");
expectErr("fragment 'tld'", function():void { AGALTranslator.translate(fsTld(4), "msl"); },
          3803, "Opcode tld only allowed in vertex programs at token 1 of fragment program.");

// ===== 3. 真机绘制（Metal）=====
var stage:Stage = new Stage();
var s3d:Stage3D = stage.stage3Ds[0];
s3d.requestContext3D(Context3DRenderMode.AUTO);
var ctx:Context3D = s3d.context3D;
check(ctx != null, "context3D created");
ctx.configureBackBuffer(16, 16, 0, false);
ctx.setCulling(Context3DTriangleFace.NONE);
ctx.setBlendFactors(Context3DBlendFactor.ONE, Context3DBlendFactor.ZERO);
var gpu:Boolean = ctx.driverInfo.indexOf("Metal") >= 0;

// 四边形：va0 = 位置（y 向上），va1 = uv（v=0 是纹理上边）。
// 四个顶点按 CLOCKWISE 顺序给三角形索引 0,1,2 / 0,2,3（culling 已关）。
var quad:Vector.<Number> = new Vector.<Number>();
quad.push(-1); quad.push(-1); quad.push(0); quad.push(1);  quad.push(0.25); quad.push(0.75);
quad.push( 1); quad.push(-1); quad.push(0); quad.push(1);  quad.push(0.75); quad.push(0.75);
quad.push( 1); quad.push( 1); quad.push(0); quad.push(1);  quad.push(0.75); quad.push(0.25);
quad.push(-1); quad.push( 1); quad.push(0); quad.push(1);  quad.push(0.25); quad.push(0.25);
var vb:VertexBuffer3D = ctx.createVertexBuffer(4, 6);
vb.uploadFromVector(quad, 0, 4);
ctx.setVertexBufferAt(0, vb, 0, Context3DVertexBufferFormat.FLOAT_4);
ctx.setVertexBufferAt(1, vb, 4, Context3DVertexBufferFormat.FLOAT_2);
var idx:Vector.<uint> = new Vector.<uint>();
idx.push(0); idx.push(1); idx.push(2);
idx.push(0); idx.push(2); idx.push(3);
var ib:IndexBuffer3D = ctx.createIndexBuffer(6);
ib.uploadFromVector(idx, 0, 6);

// 2x2 纹理：纹素 (0,0)=红 (1,0)=绿 (0,1)=蓝 (1,1)=白（行 0 是纹理的**上**行，AIR 实测）。
function makeTex(c:Context3D):Texture {
  var t:Texture = c.createTexture(2, 2, Context3DTextureFormat.BGRA, false);
  var by:ByteArray = new ByteArray();
  // BGRA 字节序
  by.writeByte(0);   by.writeByte(0);   by.writeByte(255); by.writeByte(255);
  by.writeByte(0);   by.writeByte(255); by.writeByte(0);   by.writeByte(255);
  by.writeByte(255); by.writeByte(0);   by.writeByte(0);   by.writeByte(255);
  by.writeByte(255); by.writeByte(255); by.writeByte(255); by.writeByte(255);
  by.position = 0;
  t.uploadFromByteArray(by, 0, 0);
  return t;
}

var rtt:Texture = ctx.createTexture(16, 16, Context3DTextureFormat.BGRA, true);
var tex:Texture = makeTex(ctx);
ctx.setTextureAt(0, tex);

var bd:BitmapData = new BitmapData(16, 16, false, 0);
var prog:Program3D = ctx.createProgram();
function renderVs(v:ByteArray, f:ByteArray, uvx:Number, uvy:Number):uint {
  prog.upload(v, f);
  ctx.setProgram(prog);
  ctx.setProgramConstantsFromVector(Context3DProgramType.VERTEX, 0, Vector.<Number>([uvx, uvy, 0, 1]), 1);
  ctx.setRenderToTexture(rtt, false);
  ctx.clear(0, 0, 0, 1);
  ctx.drawTriangles(ib, 0, 2);
  ctx.drawToBitmapData(bd);
  ctx.setRenderToBackBuffer();
  return bd.getPixel(8, 8);
}

// 3a. 纹素映射：uv 落在 2x2 的四个纹素中心，整块四边形取同一纹素。
ctx.setVertexBufferAt(1, null, 0, Context3DVertexBufferFormat.FLOAT_2);
ctx.setSamplerStateAt(0, Context3DWrapMode.CLAMP, Context3DTextureFilter.NEAREST, Context3DMipFilter.MIPNONE);
var corners:Array = [[0.25, 0.25, 0xFF0000, "red"], [0.75, 0.25, 0x00FF00, "green"],
                     [0.25, 0.75, 0x0000FF, "blue"], [0.75, 0.75, 0xFFFFFF, "white"]];
for (var i:int = 0; i < 4; i++) {
  var px:uint = renderVs(vsUvConst(4, 0), fsPass(4), corners[i][0], corners[i][1]);
  if (gpu) check(px == corners[i][2], "vertex 'tld' at uv(" + corners[i][0] + "," + corners[i][1] + ") fetches the " + corners[i][3] + " texel (got 0x" + px.toString(16) + ")");
  else check(px == 0x000000, "pure-C vertex texture fetch readback is black");
}
// 3b. sampler 状态真到达顶点采样：uv(0.5,0.5) 是四纹素交点，NEAREST 取一个、LINEAR 平均四个。
var pxNear:uint = renderVs(vsUvConst(4, 0), fsPass(4), 0.5, 0.5);
ctx.setSamplerStateAt(0, Context3DWrapMode.CLAMP, Context3DTextureFilter.LINEAR, Context3DMipFilter.MIPNONE);
var pxLin:uint = renderVs(vsUvConst(4, 0), fsPass(4), 0.5, 0.5);
if (gpu) {
  check(pxNear == 0xFFFFFF, "NEAREST at the texel corner picks the single last texel (got 0x" + pxNear.toString(16) + ")");
  check(pxLin == 0x808080, "LINEAR at the texel corner averages the four texels (got 0x" + pxLin.toString(16) + ")");
} else {
  check(pxNear == 0x000000 && pxLin == 0x000000, "pure-C filter readback is black");
}
ctx.setSamplerStateAt(0, Context3DWrapMode.CLAMP, Context3DTextureFilter.NEAREST, Context3DMipFilter.MIPNONE);

// 3c. wrap 状态：uv(2.4,0.4) —— CLAMP 取右边界纹素（绿），REPEAT 回绕到左边（红）。
var pxClamp:uint = renderVs(vsUvConst(4, 0), fsPass(4), 2.4, 0.4);
ctx.setSamplerStateAt(0, Context3DWrapMode.REPEAT, Context3DTextureFilter.NEAREST, Context3DMipFilter.MIPNONE);
var pxRep:uint = renderVs(vsUvConst(4, 0), fsPass(4), 2.4, 0.4);
if (gpu) {
  check(pxClamp == 0x00FF00, "CLAMP at u=2.4 keeps the right-edge texel (got 0x" + pxClamp.toString(16) + ")");
  check(pxRep == 0xFF0000, "REPEAT at u=2.4 wraps back to the left texel (got 0x" + pxRep.toString(16) + ")");
} else {
  check(pxClamp == 0x000000 && pxRep == 0x000000, "pure-C wrap readback is black");
}
ctx.setSamplerStateAt(0, Context3DWrapMode.CLAMP, Context3DTextureFilter.NEAREST, Context3DMipFilter.MIPNONE);

// 3d. 逐顶点取值 + 插值：四角 uv 不同（va1），于是四角各自是自己的纹素色，中心是四色混合。
ctx.setVertexBufferAt(1, vb, 4, Context3DVertexBufferFormat.FLOAT_2);
prog.upload(vsTld(4, 0, 1, 0), fsPass(4));
ctx.setProgram(prog);
ctx.setRenderToTexture(rtt, false);
ctx.clear(0, 0, 0, 1);
ctx.drawTriangles(ib, 0, 2);
ctx.drawToBitmapData(bd);
ctx.setRenderToBackBuffer();
if (gpu) {
  // Stage3D 的裁剪空间 y 向上、读回的第 0 行是画面顶边；v=0.25 取纹理第 0 行（上边）。
  // 于是顶点 (-1,+1,uv 0.25,0.25) 落在左上角 → 红，顺时针依次绿/白/蓝。
  // 取 (1,1) 这种角上像素时顶点权重≈91%，剩下的来自相邻顶点（插值本来就该这样），
  // 所以断言按「主导通道」写而不是纯色相等。
  var tl:uint = bd.getPixel(1, 1), tr:uint = bd.getPixel(14, 1);
  var bl:uint = bd.getPixel(1, 14), br:uint = bd.getPixel(14, 14);
  dom(tl, "top-left", true, false, false);
  dom(tr, "top-right", false, true, false);
  dom(bl, "bottom-left", false, false, true);
  dom(br, "bottom-right", true, true, true);
  // 中心像素落在两个三角形的共享对角线（BL→TR）上：两段插值在该边等价，值 = 绿蓝各一半。
  // 这正好说明片元拿到的是**逐顶点采样结果的插值**，而不是每个片元各自取样（那样中心只会是
  // 四个纯色之一）。
  var c:uint = bd.getPixel(8, 8);
  var cr:int = (c >> 16) & 0xFF, cg:int = (c >> 8) & 0xFF, cb:int = c & 0xFF;
  check(cr < 60 && cg > 90 && cg < 170 && cb > 90 && cb < 170,
        "the centre is the interpolated green/blue edge value, not a single fetched texel (got 0x" + c.toString(16) + ")");
} else {
  check(bd.getPixel(1, 1) == 0x000000, "pure-C per-vertex fetch readback is black");
}

// ===== 4. upload 期校验：与 AIR 一样在 Program3D.upload 抛（而不是等 draw）=====
var up:Program3D = ctx.createProgram();
try { up.upload(vsTex(4), fsPass(4)); throw new Error("FAIL: vertex 'tex' uploaded"); }
catch (e:Error) { check(e.errorID == 3622, "Program3D.upload rejects vertex 'tex' with #3622 (got #" + e.errorID + ")"); }
try { up.upload(vsTld(3, 0, 1, 0), fsPass(3)); throw new Error("FAIL: vertex 'tld' on AGAL3 uploaded"); }
catch (e:Error) { check(e.errorID == 3805, "Program3D.upload rejects vertex 'tld' below AGAL4 with #3805 (got #" + e.errorID + ")"); }
try { up.upload(vsTld(4, 0, 1, 0), fsPass(1)); throw new Error("FAIL: mismatched versions uploaded"); }
catch (e:Error) {
  check(e.errorID == 3757, "Program3D.upload rejects mismatched stage versions with #3757 (got #" + e.errorID + ")");
  check(e.message.indexOf("Vertex and fragment program need to have the same version") >= 0, "#3757 message matches AIR's wording");
}

tex.dispose();
rtt.dispose();
prog.dispose();
up.dispose();

trace("vertex-texture: OK (" + nchk + " checks, " + (gpu ? "Metal" : "state machine") + ")");