// tex-format.as — Context3DTextureFormat 六常量与 create/upload 的格式规则（阶段三百五十一）。
//
// 为什么需要这个示例：`Context3DTextureFormat` 曾经与 AIR 官方全集有四处偏差——漏了
// `RGBA_HALF_FLOAT`、多了 AIR 根本没有的 `RGBA`（值是 "rgba"）、并且 `BGR_PACKED` /
// `BGRA_PACKED` 的值漏掉了尾部的 565 / 4444。四处都是可观测的：常量值随 setTextureAt
// 与 uploadFromByteArray 的每纹素字节数一路影响结果，"rgba" 这种字符串则直接被 AIR 拒。
// 这里把 adl 51.4.1 上实测到的每一条钉住（temp/texfmt/README.md 有完整探针与原始输出）。
//
// 契约（实测）：
//   六个常量            bgra / bgrPacked565 / bgraPacked4444 /
//                       compressed / compressedAlpha / rgbaHalfFloat（没有 "rgba"）
//   未知格式            ArgumentError  #2008 "Parameter textureFormat must be one of the accepted values."
//   尺寸 0              ArgumentError  #3681 "Texture size is zero."
//   非 2 的幂           ArgumentError  #3682 "Texture size not a power of two."
//   压缩格式 < 4x4      ArgumentError  #3745 "Compressed texture size is too small. ..."
//   压缩格式当渲染目标  Error          #3746 "Rendering to compressed textures is not allowed."
//   RGBA_HALF_FLOAT     ArgumentError  #3759 "The selected texture format is not valid in this profile."
//   上传字节不足        RangeError     #3669 "Bad input size."
//
// 两条容易写错的顺序（AIR 的真实检查顺序）：
//   * 格式先于尺寸：createTexture(0, 0, "rgba") 报 #2008 而不是 #3681；
//   * 尺寸先于压缩下限：3x3 compressed 报 #3682（不是 2 的幂）而不是 #3745，
//     而 2x2 compressed 通过了尺寸检查才报 #3745。
//
// RGBA_HALF_FLOAT 归 `standard` 档：本 build 报的是 baselineExtended（float 纹理已就绪，
// 但 standard 档还要求 MRT，那个还没有，而档位声明是全有全无），所以在默认构建里它一律
// 报 #3759 —— 与 AIR 在 baseline/baselineExtended 下的行为逐字一致。编译时加
// -DASC_S3D_HALF_TEXTURES 会把档位声明抬到 standard 并放行这条路径（诊断/硬件验证用途）。
import flash.display.Stage;
import flash.display.Stage3D;
import flash.display3D.Context3D;
import flash.display3D.Context3DRenderMode;
import flash.display3D.Context3DTextureFormat;
import flash.display3D.Texture;
import flash.display3D.CubeTexture;
import flash.display3D.RectangleTexture;
import flash.utils.ByteArray;
import flash.utils.Endian;

var failures:int = 0;
var checks:int = 0;
function check(cond:Boolean, msg:String):void {
  checks++;
  if (!cond) { failures++; trace("FAIL: " + msg); }
}

// 类型 + errorID + 文案三者都要对上：AIR 的这几条错误各自属于不同类，
// `catch (e:ArgumentError)` 抓不住 #3684/#3746 那两条 Error。
function expectThrow(label:String, f:Function, cls:Class, id:int, msg:String):void {
  try {
    f();
  } catch (e:Error) {
    checks++;
    if (!(e is cls)) { failures++; trace("FAIL: " + label + ": expected " + cls + " got " + e); return; }
    if (e.errorID != id) { failures++; trace("FAIL: " + label + ": expected #" + id + " got #" + e.errorID); return; }
    if (e.message != msg) { failures++; trace("FAIL: " + label + ": expected \"" + msg + "\" got \"" + e.message + "\""); return; }
    return;
  }
  checks++;
  failures++;
  trace("FAIL: " + label + " should have thrown #" + id);
}

// ---- 1. 六个常量与它们的字面值 ----
// 值本身就是契约：createTexture/uploadFromByteArray 的每纹素字节数由它决定。
check(Context3DTextureFormat.BGRA == "bgra", "BGRA == bgra");
check(Context3DTextureFormat.BGR_PACKED == "bgrPacked565", "BGR_PACKED == bgrPacked565");
check(Context3DTextureFormat.BGRA_PACKED == "bgraPacked4444", "BGRA_PACKED == bgraPacked4444");
check(Context3DTextureFormat.COMPRESSED == "compressed", "COMPRESSED == compressed");
check(Context3DTextureFormat.COMPRESSED_ALPHA == "compressedAlpha", "COMPRESSED_ALPHA == compressedAlpha");
check(Context3DTextureFormat.RGBA_HALF_FLOAT == "rgbaHalfFloat", "RGBA_HALF_FLOAT == rgbaHalfFloat");

var E_UNKNOWN:String = "Error #2008: Parameter textureFormat must be one of the accepted values.";
var E_ZERO:String = "Error #3681: Texture size is zero.";
var E_POT:String = "Error #3682: Texture size not a power of two.";
var E_TOOSMALL:String = "Error #3745: Compressed texture size is too small. The minimum size for compressed textures is 4x4.";
var E_COMPRESSED_RT:String = "Error #3746: Rendering to compressed textures is not allowed.";
var E_PROFILE:String = "Error #3759: The selected texture format is not valid in this profile.";
var E_SIZE:String = "Error #3669: Bad input size.";

var stage:Stage = new Stage();
var s3d:Stage3D = stage.stage3Ds[0];
s3d.requestContext3D(Context3DRenderMode.AUTO);
var ctx:Context3D = s3d.context3D;
check(ctx != null, "context3D");

// ---- 2. 未知格式：AIR 没有 "rgba" 这个值 ----
// 用字符串字面量绕过常量表，模拟老代码里写死的 "rgba"。
expectThrow("create rgba", function():void { ctx.createTexture(64, 64, "rgba", false); },
  ArgumentError, 2008, E_UNKNOWN);
expectThrow("create bgra8", function():void { ctx.createTexture(64, 64, "bgra8", false); },
  ArgumentError, 2008, E_UNKNOWN);
// 格式先于尺寸：0x0 的未知格式报格式错误。
expectThrow("create 0x0 rgba", function():void { ctx.createTexture(0, 0, "rgba", false); },
  ArgumentError, 2008, E_UNKNOWN);
// cube / rect 走同一张表。
expectThrow("cube rgba", function():void { ctx.createCubeTexture(64, "rgba", false); },
  ArgumentError, 2008, E_UNKNOWN);
expectThrow("rect rgba", function():void { ctx.createRectangleTexture(64, 64, "rgba", false); },
  ArgumentError, 2008, E_UNKNOWN);

// ---- 3. 尺寸规则与压缩下限的先后顺序 ----
expectThrow("create 0x0 bgra", function():void { ctx.createTexture(0, 0, Context3DTextureFormat.BGRA, false); },
  ArgumentError, 3681, E_ZERO);
expectThrow("create 0x0 compressed", function():void { ctx.createTexture(0, 0, Context3DTextureFormat.COMPRESSED, false); },
  ArgumentError, 3681, E_ZERO);
// 3x3 先撞「不是 2 的幂」。
expectThrow("create 3x3 compressed", function():void { ctx.createTexture(3, 3, Context3DTextureFormat.COMPRESSED, false); },
  ArgumentError, 3682, E_POT);
// 2x2 是 2 的幂，才轮到压缩下限。
expectThrow("create 2x2 compressed", function():void { ctx.createTexture(2, 2, Context3DTextureFormat.COMPRESSED, false); },
  ArgumentError, 3745, E_TOOSMALL);
expectThrow("create 2x2 compressedAlpha", function():void { ctx.createTexture(2, 2, Context3DTextureFormat.COMPRESSED_ALPHA, false); },
  ArgumentError, 3745, E_TOOSMALL);
expectThrow("cube 2 compressed", function():void { ctx.createCubeTexture(2, Context3DTextureFormat.COMPRESSED, false); },
  ArgumentError, 3745, E_TOOSMALL);

// ---- 4. RGBA_HALF_FLOAT 的档位门控 ----
// 默认构建报 baselineExtended ⇒ 与 AIR 在 baseline/baselineExtended 下的答案一致。
var halfOk:Boolean = false;
try {
  ctx.createTexture(64, 64, Context3DTextureFormat.RGBA_HALF_FLOAT, false);
  halfOk = true;
} catch (e:Error) {
  check(e.errorID == 3759, "half float: expected #3759 got #" + e.errorID);
  check(e is ArgumentError, "half float: #3759 is an ArgumentError");
  check(e.message == E_PROFILE, "half float: message");
}
// 档位声明与放行必须同意：accepts half ⟺ profile == "standard"。
check(halfOk == (ctx.profile == "standard"), "half accepted iff profile is standard (profile=" + ctx.profile + ")");
// 门控在尺寸之后：baseline 档下 0x0 / 3x3 的 half 先报尺寸错误（实测顺序）。
expectThrow("create 0x0 half", function():void { ctx.createTexture(0, 0, Context3DTextureFormat.RGBA_HALF_FLOAT, false); },
  ArgumentError, 3681, E_ZERO);
expectThrow("create 3x3 half", function():void { ctx.createTexture(3, 3, Context3DTextureFormat.RGBA_HALF_FLOAT, false); },
  ArgumentError, 3682, E_POT);

// ---- 5. 压缩格式可以 create，但不能当渲染目标 ----
// AIR 在 createTexture 上接受 optimizeForRenderToTexture=true，直到
// setRenderToTexture 才报 #3746 —— 所以这条检查在 set 上，不在 create 上。
var ctex:Texture = ctx.createTexture(64, 64, Context3DTextureFormat.COMPRESSED, true);
check(ctex != null, "create compressed with renderToTexture flag");
expectThrow("setRenderToTexture compressed", function():void { ctx.setRenderToTexture(ctex); },
  Error, 3746, E_COMPRESSED_RT);
// 其余四个像素格式都能当渲染目标（含 half —— 只要 profile 放行）。
var btex:Texture = ctx.createTexture(64, 64, Context3DTextureFormat.BGRA, true);
var p565:Texture = ctx.createTexture(64, 64, Context3DTextureFormat.BGR_PACKED, true);
var p4444:Texture = ctx.createTexture(64, 64, Context3DTextureFormat.BGRA_PACKED, true);
check(btex != null && p565 != null && p4444 != null, "create bgra/565/4444 with RT flag");
ctx.setRenderToTexture(btex);
ctx.setRenderToTexture(p565);
ctx.setRenderToTexture(p4444);
ctx.setRenderToBackBuffer();

// ---- 6. 上传的每纹素字节数 ----
// 2x2 纹素的最少字节数：bgra 4 B/纹素 = 16；565 与 4444 = 2 B/纹素 = 8。
function bytes(n:int):ByteArray {
  var b:ByteArray = new ByteArray();
  b.endian = Endian.LITTLE_ENDIAN;
  for (var i:int = 0; i < n; i++) b.writeByte(i & 255);
  return b;
}
function upload(t:Texture, n:int):void {
  t.uploadFromByteArray(bytes(n), 0, 0);
}

var tBGRA:Texture = ctx.createTexture(2, 2, Context3DTextureFormat.BGRA, false);
var t565:Texture = ctx.createTexture(2, 2, Context3DTextureFormat.BGR_PACKED, false);
var t4444:Texture = ctx.createTexture(2, 2, Context3DTextureFormat.BGRA_PACKED, false);

expectThrow("bgra 2x2 short", function():void { upload(tBGRA, 12); }, RangeError, 3669, E_SIZE);
expectThrow("565 2x2 short", function():void { upload(t565, 4); }, RangeError, 3669, E_SIZE);
expectThrow("4444 2x2 short", function():void { upload(t4444, 7); }, RangeError, 3669, E_SIZE);

// 恰好够就成功；多给会被忽略（AIR 不因多余字节报错）。
upload(tBGRA, 16);
upload(tBGRA, 64);
upload(t565, 8);
upload(t565, 40);
upload(t4444, 8);
upload(t4444, 40);

// ---- 7. 非压缩格式的 4x4 不受压缩下限影响 ----
var t4:Texture = ctx.createTexture(4, 4, Context3DTextureFormat.BGRA, true);
check(t4 != null, "4x4 bgra");
// 压缩格式 4x4 也合法（下限就是 4x4）。
var t4c:Texture = ctx.createTexture(4, 4, Context3DTextureFormat.COMPRESSED, false);
check(t4c != null, "4x4 compressed");

// ---- 8. ignoreResourceLimits：上限还在，错的只是错误类型 ----
// 实测（temp/adlprof ign 模式，baseline / baselineExtended / enhanced 一致）：旗标不抬高
// 边长上限，只把「超限」的报错从 #3683（ArgumentError）换成 #3684（Error）——因为应用现在
// 看到的是一次失败的真实分配。上限仍是档位的 2048/4096。
var cap:int = (ctx.profile == "baseline") ? 2048 : 4096;
var tooBig:int = cap * 2;

check(ctx.ignoreResourceLimits == false, "ignoreResourceLimits defaults to false");
expectThrow("2D ceiling, flag off", function():void { ctx.createTexture(tooBig, tooBig, Context3DTextureFormat.BGRA, false); },
  ArgumentError, 3683, cap >= 4096
    ? "Error #3683: Texture too big (max is 4096x4096)."
    : "Error #3683: Texture too big (max is 2048x2048).");
expectThrow("cube ceiling, flag off", function():void { ctx.createCubeTexture(2048, Context3DTextureFormat.BGRA, false); },
  ArgumentError, 3705, "Error #3705: Cubemap texture too big (max is 1024x1024).");

ctx.ignoreResourceLimits = true;
expectThrow("2D ceiling, flag on", function():void { ctx.createTexture(tooBig, tooBig, Context3DTextureFormat.BGRA, false); },
  Error, 3684, "Error #3684: Texture creation failed. Internal error.");
expectThrow("cube ceiling, flag on", function():void { ctx.createCubeTexture(2048, Context3DTextureFormat.BGRA, false); },
  Error, 3684, "Error #3684: Texture creation failed. Internal error.");
// 上限本身没变：正好 cap 仍通过，且零尺寸 / 非 2 的幂的检查一个字都没少。
var atCap:Texture = ctx.createTexture(cap, cap, Context3DTextureFormat.BGRA, false);
check(atCap != null, "flag on: " + cap + "x" + cap + " still allowed");
expectThrow("zero size, flag on", function():void { ctx.createTexture(0, 0, Context3DTextureFormat.BGRA, false); },
  ArgumentError, 3681, E_ZERO);
expectThrow("pow2, flag on", function():void { ctx.createTexture(3, 3, Context3DTextureFormat.BGRA, false); },
  ArgumentError, 3682, E_POT);
ctx.ignoreResourceLimits = false;

if (failures == 0) trace("tex-format: OK (" + checks + " checks)");
else trace("tex-format: " + failures + " FAILED of " + checks);