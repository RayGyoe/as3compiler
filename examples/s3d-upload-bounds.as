// s3d-upload-bounds.as — uploadFromVector / uploadFromByteArray 的 AIR 边界契约
// （阶段三百二十）。
//
// 为什么需要这个示例：这四个上传入口以前是「能拷多少拷多少，拷不到就静默返回」，
// 与 AIR「不够就是 RangeError #3669」相反；更糟的是 startVertex/startIndex 为负时
// 目标指针会跑到缓冲区之前，即一次越界写（与 setPixels 越界同族，阶段三百一十六）。
// 这里把 51.4.1 上实测到的每一条都钉住，任何一条退化都会让示例直接 FAIL。
//
// 契约（adl 51.4.1 + temp/s3dupload/ 逐条实测）：
//   data == null                      TypeError      #2007 "Parameter data must be non-null."
//   尺寸 / 下标越界                    RangeError     #3669 "Bad input size."
//   miplevel 超出 mip 链               ArgumentError  #3674 "Miplevel too large."
// 另外两条容易写错的语义：
//   * uploadFromVector 的源从 data[0] 读，startVertex/startIndex 只决定**写到哪**
//     （实测：只有 1 个顶点的 Vector，start=1/n=1 也能成功）；
//   * 越界的调用不许改动缓冲区（AIR 抛异常，什么都没写）。

function check(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

// 期望抛错：类型 + errorID + 文案三者都要对上（AIR 的 #3669 只有一句 "Bad input size."）。
function expectThrow(label:String, f:Function, id:int, msg:String):void {
  try {
    f();
  } catch (e:Error) {
    check(e is RangeError || e is TypeError || e is ArgumentError, label + ": wrong error class");
    check(e.errorID == id, label + ": expected #" + id + " got #" + e.errorID);
    check(e.message == msg, label + ": expected \"" + msg + "\" got \"" + e.message + "\"");
    return;
  }
  throw new Error("FAIL: " + label + " should have thrown #" + id);
}

function expectOk(label:String, f:Function):void {
  try { f(); } catch (e:Error) { throw new Error("FAIL: " + label + " threw " + e); }
}

var E_BAD:String = "Error #3669: Bad input size.";
var E_NULL:String = "Error #2007: Parameter data must be non-null.";
var E_MIP:String = "Error #3674: Miplevel too large.";

var stage:Stage = new Stage();
var s3d:Stage3D = stage.stage3Ds[0];
s3d.requestContext3D(Context3DRenderMode.AUTO);
var ctx:Context3D = s3d.context3D;
check(ctx != null, "context3D");

// 造一个 12 个 32 位字（= 4 个顶点 x 3 个分量）的小端字节流，字值 0x1000+i。
function words(n:int):ByteArray {
  var b:ByteArray = new ByteArray();
  b.endian = Endian.LITTLE_ENDIAN;
  for (var i:int = 0; i < n; i++) b.writeUnsignedInt(0x1000 + i);
  return b;
}
function bytesN(n:int):ByteArray {
  var b:ByteArray = new ByteArray();
  for (var i:int = 0; i < n; i++) b.writeByte(1);
  return b;
}

function shorts(n:int):ByteArray {
  var b:ByteArray = new ByteArray();
  b.endian = Endian.LITTLE_ENDIAN;
  for (var i:int = 0; i < n; i++) b.writeShort(0x0100 + i);
  return b;
}

// ---------------------------------------------------------------- VertexBuffer3D
var vb:VertexBuffer3D = ctx.createVertexBuffer(4, 3);
expectThrow("vb null", function():void { vb.uploadFromByteArray(null, 0, 0, 1); }, 2007, E_NULL);
expectThrow("vb off=-1", function():void { vb.uploadFromByteArray(words(12), -1, 0, 1); }, 3669, E_BAD);
expectThrow("vb off=len", function():void { vb.uploadFromByteArray(words(12), 48, 0, 1); }, 3669, E_BAD);
expectThrow("vb off=len n=0", function():void { vb.uploadFromByteArray(words(12), 48, 0, 0); }, 3669, E_BAD);
expectThrow("vb short bytes", function():void { vb.uploadFromByteArray(words(11), 0, 0, 4); }, 3669, E_BAD);
expectThrow("vb num=-1", function():void { vb.uploadFromByteArray(words(12), 0, 0, -1); }, 3669, E_BAD);
expectThrow("vb start=-1", function():void { vb.uploadFromByteArray(words(12), 0, -1, 1); }, 3669, E_BAD);
// AIR 按 createVertexBuffer3D 的尺寸校验 startVertex+numVertices（字节数再够也不行）。
// 128 字节够 7 个顶点（start=3 + n=4），所以这条只能被 capacity 守卫拦住。
expectThrow("vb beyond capacity", function():void { vb.uploadFromByteArray(words(32), 0, 3, 4); }, 3669, E_BAD);
expectOk("vb num=0", function():void { vb.uploadFromByteArray(words(12), 0, 0, 0); });

// 先整块上传，建立已知内容（raw 是按需增长的，长度 = 已上传到的最大字数）。
expectOk("vb full", function():void { vb.uploadFromByteArray(words(12), 0, 0, 4); });
check(vb.raw != null && vb.raw.length == 12, "vb.raw 12 words");
check(vb.raw[0] == 0x1000 && vb.raw[11] == 0x100B, "vb.raw = data[0..48)");
// 字节流从 off 连续读，startVertex 只决定写到哪里：off=12 → 顶点 1、2。
expectOk("vb off=12 start=1 n=2", function():void { vb.uploadFromByteArray(words(12), 12, 1, 2); });
check(vb.raw[3] == 0x1003 && vb.raw[4] == 0x1004 && vb.raw[5] == 0x1005, "vertex 1 = data[12..24)");
check(vb.raw[6] == 0x1006 && vb.raw[7] == 0x1007 && vb.raw[8] == 0x1008, "vertex 2 = data[24..36)");
check(vb.raw[0] == 0x1000 && vb.raw[9] == 0x1009, "vertices 0 and 3 untouched");

// 被拒的调用不许破坏已有内容。
expectThrow("vb rejected after data", function():void { vb.uploadFromByteArray(words(3), 0, 0, 2); }, 3669, E_BAD);
check(vb.raw[3] == 0x1003, "rejected upload left the buffer alone");

// uploadFromVector：源从 data[0] 读（不是 data[startVertex*stride]）。
var short3:Vector.<Number> = new Vector.<Number>(3, true);
short3[0] = 1.5; short3[1] = -2.5; short3[2] = 100;
expectOk("vbv short vector at start=1", function():void { vb.uploadFromVector(short3, 1, 1); });
check(vb.raw[3] == 0x3FC00000, "vertex 1.w0 = 1.5f (read from data[0])");
check(vb.raw[4] == 0xC0200000, "vertex 1.w1 = -2.5f");
check(vb.raw[5] == 0x42C80000, "vertex 1.w2 = 100f");
expectThrow("vbv null", function():void { vb.uploadFromVector(null, 0, 1); }, 2007, E_NULL);
expectThrow("vbv short n=2", function():void { vb.uploadFromVector(short3, 0, 2); }, 3669, E_BAD);
expectThrow("vbv beyond capacity", function():void { vb.uploadFromVector(short3, 3, 2); }, 3669, E_BAD);
expectThrow("vbv start=-1", function():void { vb.uploadFromVector(short3, -1, 1); }, 3669, E_BAD);
// data.endian 对上传无意义：参考文档要求小端 ByteArray，而 adl 接受 bigEndian 且
// 仍按小端读字节。尊重该标志就会把 AIR 原样透传的数据翻个个儿。
var be:ByteArray = new ByteArray();
be.endian = Endian.BIG_ENDIAN;
be.writeUnsignedInt(0x00112233);
be.writeUnsignedInt(0);
be.writeUnsignedInt(0);
expectOk("vb bigendian bytes read as LE", function():void { vb.uploadFromByteArray(be, 0, 0, 1); });
check(vb.raw[0] == 0x33221100, "bigEndian flag ignored: bytes 00 11 22 33 = LE 0x33221100");
vb.dispose();

// ---------------------------------------------------------------- IndexBuffer3D
var ib:IndexBuffer3D = ctx.createIndexBuffer(6);
expectThrow("ib null", function():void { ib.uploadFromByteArray(null, 0, 0, 1); }, 2007, E_NULL);
expectThrow("ib off=-1", function():void { ib.uploadFromByteArray(shorts(32), -1, 0, 1); }, 3669, E_BAD);
expectThrow("ib off=len", function():void { ib.uploadFromByteArray(shorts(32), 64, 0, 1); }, 3669, E_BAD);
expectThrow("ib short bytes", function():void { ib.uploadFromByteArray(shorts(31), 0, 0, 32); }, 3669, E_BAD);
expectThrow("ib n=-1", function():void { ib.uploadFromByteArray(shorts(32), 0, 0, -1); }, 3669, E_BAD);
expectThrow("ib start=-1", function():void { ib.uploadFromByteArray(shorts(32), 0, -1, 2); }, 3669, E_BAD);
expectThrow("ib beyond capacity", function():void { ib.uploadFromByteArray(shorts(32), 0, 5, 4); }, 3669, E_BAD);
expectOk("ib exact fit", function():void { ib.uploadFromByteArray(shorts(32), 52, 0, 6); });
check(ib.data[0] == 0x011A && ib.data[5] == 0x011F, "ib exact fit = data[52..64)");

// uint16 小端：off=2 落在第二个字上，startIndex=1 → 索引 1..3。
expectOk("ib off=2 start=1 n=3", function():void { ib.uploadFromByteArray(shorts(32), 2, 1, 3); });
check(ib.data[1] == 0x0101 && ib.data[2] == 0x0102 && ib.data[3] == 0x0103, "ib.data[1..3] from data[2..8) LE");
check(ib.data[0] == 0x011A && ib.data[4] == 0x011E, "ib.data[0] and [4..6) untouched");

// Vector 版本：源同样从 data[0] 读。
var short2:Vector.<uint> = new Vector.<uint>(2, true);
short2[0] = 0x7777; short2[1] = 0x8888;
expectOk("ibv short vector at start=1", function():void { ib.uploadFromVector(short2, 1, 2); });
check(ib.data[1] == 0x7777 && ib.data[2] == 0x8888, "ibv reads data[0..2)");
expectThrow("ibv null", function():void { ib.uploadFromVector(null, 0, 1); }, 2007, E_NULL);
expectThrow("ibv short", function():void { ib.uploadFromVector(short2, 0, 3); }, 3669, E_BAD);
expectThrow("ibv beyond capacity", function():void { ib.uploadFromVector(short2, 5, 2); }, 3669, E_BAD);
ib.dispose();

// ---------------------------------------------------------------- Texture
var tx:Texture = ctx.createTexture(4, 4, "bgra", false);
expectThrow("tx null", function():void { tx.uploadFromByteArray(null, 0); }, 2007, E_NULL);
// null 优先于其它一切拒绝原因（实测：null + miplevel=9 报 #2007）。
expectThrow("tx null wins", function():void { tx.uploadFromByteArray(null, 0, 9); }, 2007, E_NULL);
expectThrow("tx off=-1", function():void { tx.uploadFromByteArray(words(16), -1); }, 3669, E_BAD);
expectThrow("tx off=len", function():void { tx.uploadFromByteArray(words(16), 64); }, 3669, E_BAD);
expectThrow("tx short 63", function():void { tx.uploadFromByteArray(words(16), 1); }, 3669, E_BAD);
expectOk("tx 64 bytes", function():void { tx.uploadFromByteArray(words(16), 0); });
// 4x4 的 mip 链只有 0、1 两级：level 1 需要 2x2x4 = 16 字节。
expectThrow("tx mip=1 too short", function():void { tx.uploadFromByteArray(words(3), 0, 1); }, 3669, E_BAD);
expectOk("tx mip=1 fits", function():void { tx.uploadFromByteArray(words(4), 0, 1); });
// 4x4 的链是 4,2,1：level 2 合法（1x1x4 = 4 字节），level 3 才超链。
expectOk("tx mip=2 needs 4 bytes", function():void { tx.uploadFromByteArray(words(1), 0, 2); });
expectThrow("tx mip=2 len=3", function():void { tx.uploadFromByteArray(bytesN(3), 0, 2); }, 3669, E_BAD);
expectThrow("tx mip=3 past chain", function():void { tx.uploadFromByteArray(words(1), 0, 3); }, 3674, E_MIP);
// uploadFromBitmapData 用的是同一条链规则：4x4 的 level 2（1x1）成功，level 3 与 9 都是
// #3674（实测 adl 51.4.1，temp/s3dupload/ChainProbe.as）。以前这条路径是静默丢弃。
var bd:BitmapData = new BitmapData(4, 4, false, 0xFF102030);
expectOk("bmp mip=2 (1x1)", function():void { tx.uploadFromBitmapData(bd, 2); });
expectThrow("bmp mip=3 past chain", function():void { tx.uploadFromBitmapData(bd, 3); }, 3674, E_MIP);
expectThrow("bmp mip=9", function():void { tx.uploadFromBitmapData(bd, 9); }, 3674, E_MIP);
tx.dispose();

// 8x8 的链是 8,4,2,1：level 2 要 16 字节，level 3 要 4 字节，level 4 不存在。
var mm:Texture = ctx.createTexture(8, 8, "bgra", true);
expectOk("8x8 mip2 len=16", function():void { mm.uploadFromByteArray(words(4), 0, 2); });
expectThrow("8x8 mip2 len=15", function():void { mm.uploadFromByteArray(bytesN(15), 0, 2); }, 3669, E_BAD);
expectOk("8x8 mip3 len=4", function():void { mm.uploadFromByteArray(bytesN(4), 0, 3); });
expectThrow("8x8 mip=4", function():void { mm.uploadFromByteArray(words(1), 0, 4); }, 3674, E_MIP);
// 非 mipmapped 纹理照样接受 level>0（实测），级别尺寸规则不变。
expectOk("nonmip mip1 len=64", function():void { mm.uploadFromByteArray(words(16), 0, 1); });
var narrow:Texture = ctx.createTexture(8, 2, "bgra", false);
expectThrow("8x2 mip2 needs 8", function():void { narrow.uploadFromByteArray(words(1), 0, 2); }, 3669, E_BAD);
expectOk("8x2 mip2 len=8", function():void { narrow.uploadFromByteArray(words(2), 0, 2); });
expectOk("8x2 mip3 len=4", function():void { narrow.uploadFromByteArray(words(1), 0, 3); });
expectThrow("8x2 mip=4 past chain", function():void { narrow.uploadFromByteArray(words(1), 0, 4); }, 3674, E_MIP);
narrow.dispose();
mm.dispose();

// ---------------------------------------------------------------- RectangleTexture
var rt:RectangleTexture = ctx.createRectangleTexture(4, 4, "bgra", false);
expectThrow("rt null", function():void { rt.uploadFromByteArray(null, 0); }, 2007, E_NULL);
expectThrow("rt off=len", function():void { rt.uploadFromByteArray(words(16), 64); }, 3669, E_BAD);
expectThrow("rt short", function():void { rt.uploadFromByteArray(words(15), 0); }, 3669, E_BAD);
expectOk("rt 64 bytes", function():void { rt.uploadFromByteArray(words(16), 0); });
rt.dispose();

trace("s3d-upload-bounds: OK");
