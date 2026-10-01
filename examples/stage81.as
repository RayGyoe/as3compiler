// stage81.as — Stage3D + Context3D skeleton (flash.display3D stage 81).
//
// 纯 CPU 状态机 + 资源容器 + 15 个常量类；GPU 上传/绘制在 stage 82。
// 语义参照 AIR 的 flash.display3D.*（mxmlc 对照）。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- 1. 常量类：值断言（string 值对照 AIR flash.display3D） ---
check(Context3DBlendFactor.ONE == "one", "BlendFactor.ONE");
check(Context3DBlendFactor.SOURCE_ALPHA == "sourceAlpha", "BlendFactor.SOURCE_ALPHA");
check(Context3DBlendFactor.ONE_MINUS_SOURCE_ALPHA == "oneMinusSourceAlpha", "BlendFactor.ONE_MINUS_SOURCE_ALPHA");
check(Context3DBufferUsage.STATIC_DRAW == "staticDraw", "BufferUsage.STATIC_DRAW");
check(Context3DBufferUsage.DYNAMIC_DRAW == "dynamicDraw", "BufferUsage.DYNAMIC_DRAW");
// Context3DClearMask is a uint bitmask, not a String: clear(..., mask) uses it as
// a bit set of the attachments to clear. adl-verified values (temp/refcheck/Mask.as):
// COLOR=1, DEPTH=2, STENCIL=4, ALL=7.
check(Context3DClearMask.COLOR == 1, "ClearMask.COLOR");
check(Context3DClearMask.DEPTH == 2, "ClearMask.DEPTH");
check(Context3DClearMask.STENCIL == 4, "ClearMask.STENCIL");
check(Context3DClearMask.ALL == 7, "ClearMask.ALL");
check(Context3DCompareMode.LESS_EQUAL == "lessEqual", "CompareMode.LESS_EQUAL");
check(Context3DProgramType.VERTEX == "vertex", "ProgramType.VERTEX");
check(Context3DProgramType.FRAGMENT == "fragment", "ProgramType.FRAGMENT");
check(Context3DRenderMode.AUTO == "auto", "RenderMode.AUTO");
check(Context3DRenderMode.SOFTWARE == "software", "RenderMode.SOFTWARE");
check(Context3DTextureFormat.BGRA == "bgra", "TextureFormat.BGRA");
check(Context3DVertexBufferFormat.FLOAT_2 == "float2", "VBF.FLOAT_2");
check(Context3DVertexBufferFormat.FLOAT_3 == "float3", "VBF.FLOAT_3");
check(Context3DVertexBufferFormat.FLOAT_4 == "float4", "VBF.FLOAT_4");
check(Context3DTriangleFace.FRONT == "front", "TriangleFace.FRONT");
check(Context3DProfile.BASELINE == "baseline", "Profile.BASELINE");
check(Context3DTextureFilter.LINEAR == "linear", "TextureFilter.LINEAR");
check(Context3DWrapMode.CLAMP == "clamp", "WrapMode.CLAMP");

// --- 2. Stage3D slot + requestContext3D + CONTEXT3D_CREATE ---
var stage:Stage = new Stage();
var slots:Vector.<Stage3D> = stage.stage3Ds;
check(slots.length == 1, "stage3Ds has one slot");

var s3d:Stage3D = slots[0];
check(s3d != null, "stage3Ds[0] is a Stage3D");

var created:Boolean = false;
function onCreated(e:Event):void { created = true; }
s3d.addEventListener(Event.CONTEXT3D_CREATE, onCreated);
check(!created, "not created before request");
s3d.requestContext3D(Context3DRenderMode.AUTO);
// AIR dispatches context3DCreate asynchronously (on a later frame tick); the
// context object itself is created eagerly so stage3D.context3D is immediately
// readable. Asserting the event fires synchronously here would encode a bug.
check(!created, "CONTEXT3D_CREATE is dispatched asynchronously (matches AIR)");

var ctx:Context3D = s3d.context3D;
check(ctx != null, "context3D lazily created");
check(ctx.profile == "baseline", "profile getter");
check(ctx.driverInfo != "" && ctx.driverInfo != null, "driverInfo getter");

// --- 3. 状态机方法（全链路调用，无崩溃） ---
ctx.configureBackBuffer(800, 600, 0, true);

var vb:VertexBuffer3D = ctx.createVertexBuffer(4, 3);
check(vb != null, "createVertexBuffer");
var vbData:Vector.<Number> = new Vector.<Number>();
vbData.push(0); vbData.push(0); vbData.push(0);
vbData.push(100); vbData.push(0); vbData.push(0);
vbData.push(100); vbData.push(100); vbData.push(0);
vbData.push(0); vbData.push(100); vbData.push(0);
vb.uploadFromVector(vbData, 0, 4);
ctx.setVertexBufferAt(0, vb, 0, Context3DVertexBufferFormat.FLOAT_3);

var ib:IndexBuffer3D = ctx.createIndexBuffer(6);
check(ib != null, "createIndexBuffer");
var ibData:Vector.<uint> = new Vector.<uint>();
ibData.push(0); ibData.push(1); ibData.push(2);
ibData.push(0); ibData.push(2); ibData.push(3);
ib.uploadFromVector(ibData, 0, 6);

var prog:Program3D = ctx.createProgram();
check(prog != null, "createProgram");
ctx.setProgram(prog);

var tex:Texture = ctx.createTexture(256, 256, Context3DTextureFormat.BGRA, false);
check(tex != null, "createTexture");
ctx.setTextureAt(0, tex);

ctx.setBlendFactors(Context3DBlendFactor.ONE, Context3DBlendFactor.ONE_MINUS_SOURCE_ALPHA);
ctx.setDepthTest(false, Context3DCompareMode.LESS);
ctx.setCulling(Context3DTriangleFace.FRONT);
ctx.setStencilActions(Context3DTriangleFace.FRONT_AND_BACK, Context3DCompareMode.EQUAL,
                     Context3DStencilAction.INCREMENT_SATURATE);
ctx.setStencilReferenceValue(127);
ctx.setSamplerStateAt(0, Context3DWrapMode.CLAMP, Context3DTextureFilter.LINEAR, Context3DMipFilter.MIPNONE);
ctx.setScissorRectangle(new Rectangle(0, 0, 64, 64));
ctx.setScissorRectangle(null);
check(true, "stencil/sampler/scissor forwarding paths compile + accept args");

var mvp:Matrix3D = new Matrix3D();
mvp.appendScale(2, 2, 1);
ctx.setProgramConstantsFromMatrix(Context3DProgramType.VERTEX, 0, mvp, false);

ctx.clear(0.0, 0.0, 0.0, 1.0, 1.0, 127, Context3DClearMask.ALL);
ctx.clear(0.0, 0.0, 0.0, 1.0);
ctx.drawTriangles(ib, 0, 2);
ctx.present();

trace("stage81: all Stage3D/Context3D assertions passed");
