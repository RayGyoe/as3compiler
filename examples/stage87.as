// stage87.as — Context3D 骨架补方法（Starling 前置 Tier 3，stage 87）。
//
// setStencilActions / setScissorRectangle / setStencilReferenceValue /
// maxBackBufferWidth+Height getter / VertexBuffer3D+IndexBuffer3D.uploadFromByteArray。
// 全部走 CPU 状态机记录；uploadFromByteArray 把 ByteArray 当小端 float32/uint16
// 数据源，宽化进既有 vector 字段（data 可读回校验）。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var stage:Stage = new Stage();
var s3d:Stage3D = stage.stage3Ds[0];
s3d.requestContext3D(Context3DRenderMode.AUTO);
var ctx:Context3D = s3d.context3D;
check(ctx != null, "context3D");

// --- 1. maxBackBufferWidth / Height getter（AIR 桌面 16384） ---
check(ctx.maxBackBufferWidth == 16384, "maxBackBufferWidth == 16384");
check(ctx.maxBackBufferHeight == 16384, "maxBackBufferHeight == 16384");
ctx.configureBackBuffer(800, 600, 0, true);
check(ctx.maxBackBufferWidth >= 800, "maxBackBufferWidth >= backBuffer after configure");
check(ctx.backBufferWidth == 800, "backBufferWidth field");
check(ctx.backBufferHeight == 600, "backBufferHeight field");

// --- 2. setStencilActions（2/3/5 参；尾部三参默认 keep） ---
ctx.setStencilActions(Context3DTriangleFace.FRONT_AND_BACK, Context3DCompareMode.ALWAYS);
ctx.setStencilActions(Context3DTriangleFace.FRONT, Context3DCompareMode.EQUAL, Context3DStencilAction.INCREMENT_SATURATE);
ctx.setStencilActions(Context3DTriangleFace.FRONT_AND_BACK, Context3DCompareMode.ALWAYS,
    Context3DStencilAction.KEEP, Context3DStencilAction.KEEP, Context3DStencilAction.KEEP);

// --- 3. setStencilReferenceValue（1 参 + 3 参，readMask/writeMask 接受但暂不落地） ---
ctx.setStencilReferenceValue(0);
ctx.setStencilReferenceValue(1);
ctx.setStencilReferenceValue(0xFF, 0xFF, 0xFF);

// --- 4. setScissorRectangle（矩形 + null 禁用） ---
ctx.setScissorRectangle(new Rectangle(10, 20, 30, 40));
ctx.setScissorRectangle(null);

// --- 5. uploadFromByteArray（小端 float32 顶点 / uint16 索引，raw 可读回） ---
var vb:VertexBuffer3D = ctx.createVertexBuffer(4, 3, Context3DBufferUsage.DYNAMIC_DRAW);
check(vb != null, "createVertexBuffer");

var vbytes:ByteArray = new ByteArray();
vbytes.endian = Endian.LITTLE_ENDIAN;
vbytes.writeFloat(0); vbytes.writeFloat(1.5); vbytes.writeFloat(-2.5);
vbytes.writeFloat(100); vbytes.writeFloat(0.25); vbytes.writeFloat(0);
vbytes.writeFloat(100); vbytes.writeFloat(100); vbytes.writeFloat(0);
vbytes.writeFloat(0); vbytes.writeFloat(100); vbytes.writeFloat(0);
vb.uploadFromByteArray(vbytes, 0, 0, 4);
// vb.raw holds the vertex payload as raw 32-bit GPU words (one per component),
// so the float32 bit patterns are what's asserted -- 1.5 = 0x3FC00000,
// -2.5 = 0xC0200000, 100 = 0x42C80000, 0.25 = 0x3E800000.
check(vb.raw != null, "vb.raw populated");
check(vb.raw.length == 12, "vb.raw has 12 words");
check(vb.raw[0] == 0, "vb.raw[0]");
check(vb.raw[1] == 0x3FC00000, "vb.raw[1] (1.5f)");
check(vb.raw[2] == 0xC0200000, "vb.raw[2] (-2.5f)");
check(vb.raw[3] == 0x42C80000, "vb.raw[3] (100f)");
check(vb.raw[4] == 0x3E800000, "vb.raw[4] (0.25f)");
ctx.setVertexBufferAt(0, vb, 0, Context3DVertexBufferFormat.FLOAT_3);

var ib:IndexBuffer3D = ctx.createIndexBuffer(6, Context3DBufferUsage.STATIC_DRAW);
check(ib != null, "createIndexBuffer");
var ibytes:ByteArray = new ByteArray();
ibytes.endian = Endian.LITTLE_ENDIAN;
ibytes.writeShort(0); ibytes.writeShort(1); ibytes.writeShort(2);
ibytes.writeShort(0); ibytes.writeShort(2); ibytes.writeShort(3);
ib.uploadFromByteArray(ibytes, 0, 0, 6);
check(ib.data != null, "ib.data populated");
check(ib.data.length == 6, "ib.data has 6 indices");
check(ib.data[0] == 0, "ib.data[0]");
check(ib.data[1] == 1, "ib.data[1]");
check(ib.data[2] == 2, "ib.data[2]");
check(ib.data[3] == 0, "ib.data[3]");
check(ib.data[4] == 2, "ib.data[4]");
check(ib.data[5] == 3, "ib.data[5]");

ctx.clear(0, 0, 0, 1);
ctx.drawTriangles(ib, 0, 2);
ctx.present();

trace("stage87: all Context3D skeleton supplementary method assertions passed");
