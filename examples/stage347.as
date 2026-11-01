// stage347.as — 阶段三百四十七：clear() 之后**没有任何 draw** 的离屏目标也必须真的被清。
//
// Stage3D 的 clear() 不是立即清屏，它只记录颜色/深度/模板值，真正的清屏动作挂在**下一次
// drawTriangles** 的渲染通道上（loadAction = Clear）。这对「清完就画」的常规路径没问题，
// 却漏掉了一个 AIR 会正确处理的情形：清完**一个 draw 都没有**。
//
// 实测后果（asaot3d/apps/shadow-m13，源码完全同源）：
//   一盏 castShadow=true 的平行光，但场景里一个 castShadow=true 的网格都没有 ⇒ 阴影
//   prepass 不清不画，阴影贴图停在 Metal 新分配私有不透明纹理的**未定义内容**（驱动给
//   全 0），于是 8bit 打包深度解出来就是 0.0 = 「比任何片元都近」⇒ 整个视锥被判定为遮挡。
//   AIR 那边 clear() 照样落到贴图上（深度 1.0 = 最远），所以同样是「零投形体」它不产生
//   任何阴影。AOT 则整片压黑：地面 11.8 对 AIR 31.8（temp/w26ab/50-noshadow.png）。
//
// 本示例钉住的就是这条缝隙，用**纯 Stage3D**（不依赖 asaot3d seam）：
//   ① 建一张 16x16 可渲染纹理，setRenderToTexture 绑定它；
//   ② clear(1,1,1,1, depth=1, 0, 三面全清)；
//   ③ 一个 drawTriangles 都不发；
//   ④ 切回后台缓冲，用一条全屏三角采样它；
//   ⑤ 中心像素必须是**白**（0xFFFFFF）。修复前是黑（0x000000）。

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

// 顶点：位置直接给裁剪空间（va0），uv 走 va1。
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

// 片元：tex ft0, v0, fs0 <2d,clamp,linear,mipnone> ; mov oc, ft0
// mipnone 很关键：miplinear 遇到没有 mip 链的贴图会被后端整条丢弃（AIR 也这样），
// 那样这条用例就以「根本没画」的方式假通过了。
function makeFragment():ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.writeByte(0xA0); u32le(ba, 1); ba.writeByte(0xA1); ba.writeByte(0x01);
  u32le(ba, 0x28);                    // tex
  u32le(ba, dst(R_FT, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_V));
  u32le(ba, 0); u32le(ba, 5 | (1 << 28));   // fs0, linear, nomip, clamp, 2d
  u32le(ba, 0x00);                    // mov oc, ft0
  u32le(ba, dst(3, 0, 0xF));
  u32le(ba, srcLo(0, SW_ID)); u32le(ba, srcHi(R_FT));
  u32le(ba, 0); u32le(ba, 0);
  return ba;
}

var stage:Stage = new Stage();
var s3d:Stage3D = stage.stage3Ds[0];
s3d.requestContext3D(Context3DRenderMode.AUTO);
var ctx:Context3D = s3d.context3D;
check(ctx != null, "context3D created");
ctx.configureBackBuffer(16, 16, 0, false);

// 全屏三角：裁剪空间 (-1,-1) (3,-1) (-1,3)，uv 恒定取纹理中心。
var pos:Vector.<Number> = new Vector.<Number>();
pos.push(-1); pos.push(-1); pos.push(0);
pos.push(3);  pos.push(-1); pos.push(0);
pos.push(-1); pos.push(3);  pos.push(0);
var vbPos:VertexBuffer3D = ctx.createVertexBuffer(3, 3);
vbPos.uploadFromVector(pos, 0, 3);
ctx.setVertexBufferAt(0, vbPos, 0, Context3DVertexBufferFormat.FLOAT_3);

var uv:Vector.<Number> = new Vector.<Number>();
uv.push(0.5); uv.push(0.5); uv.push(0);
uv.push(0.5); uv.push(0.5); uv.push(0);
uv.push(0.5); uv.push(0.5); uv.push(0);
var vbUv:VertexBuffer3D = ctx.createVertexBuffer(3, 3);
vbUv.uploadFromVector(uv, 0, 3);
ctx.setVertexBufferAt(1, vbUv, 0, Context3DVertexBufferFormat.FLOAT_3);

var idx:Vector.<uint> = new Vector.<uint>();
idx.push(0); idx.push(1); idx.push(2);
var ib:IndexBuffer3D = ctx.createIndexBuffer(3);
ib.uploadFromVector(idx, 0, 3);

var prog:Program3D = ctx.createProgram();
prog.upload(makeVertex(), makeFragment());
ctx.setProgram(prog);
ctx.setTextureAt(0, null);       // 稍后换成离屏目标
ctx.setBlendFactors(Context3DBlendFactor.ONE, Context3DBlendFactor.ZERO);

// ===== 离屏目标：清成白，然后**一个 draw 都不发** =====
// enableDepthAndStencil=true，和阴影 prepass 的用法一致（那张贴图也是这么建的）。
var rtt:Texture = ctx.createTexture(16, 16, Context3DTextureFormat.BGRA, true);
check(rtt != null, "render texture created");
ctx.setRenderToTexture(rtt, true);
ctx.clear(1, 1, 1, 1, 1.0, 0, 3);   // 颜色=白，深度=1（最远），三面全清
// ← 这里没有 drawTriangles：这就是本用例的全部意义。
ctx.setRenderToBackBuffer();

// ===== 采样它并读回 =====
ctx.clear(0, 0, 0, 1, 1.0, 0, 3);
ctx.setTextureAt(0, rtt);
ctx.drawTriangles(ib, 0, 1);
var bd:BitmapData = new BitmapData(16, 16, false, 0);
ctx.drawToBitmapData(bd);
var center:uint = bd.getPixel(8, 8);

if (ctx.driverInfo.indexOf("Metal") >= 0) {
  // 白 → 0xFFFFFF。清屏被吞掉时这里全 0（未定义内容），得到 0x000000。
  check(center == 0xFFFFFF, "clear-only offscreen target reads back white (got 0x" + center.toString(16) + ")");
  trace("stage347: (Metal) passed");
} else {
  // 纯 C（无 GPU）：draw 是状态机空操作，读回清黑。
  check(center == 0x000000, "pure-C readback is black");
  trace("stage347: (state machine) passed");
}

rtt.dispose();
prog.dispose();