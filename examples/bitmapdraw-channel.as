// bitmapdraw-channel.as — BitmapData.draw() 通道序回归。
//
// 背景：BitmapData_draw 的 TextField 分支把 TextField 光栅化到一张 Skia raster
// surface（MakeN32Premul），再逐像素读回成运行时的 straight ARGB。这段读回代码
// 假设 Skia N32 的内存字节序是 B,G,R,A（从 q[0] 取 B、q[2] 取 R）。
//
// 但 Skia 在非 Windows 平台默认 SK_R32_SHIFT=0（见 SkTypes.h），于是
// SK_PMCOLOR_BYTE_ORDER(R,G,B,A) 成立 → kN32 = kRGBA_8888 → 内存字节序是 R,G,B,A。
// 若该假设错误，读回时 R/B 会被交换：红色会被读成蓝色。
//
// 修复（阶段八十九·十六）：没有在生成 C 里改成反着取通道（那只是把同一错误反过来再犯一次），
// 而是把字节序解析下沉到 vendor/skia_glue.cc 的 sk_surface_read_argb()——显式请求
// kBGRA_8888 + kUnpremul，小端下 BGRA 字节序列按 uint32 读出即为 0xAARRGGBB
// （零逐像素开销），kN32 的平台差异因此不再泄漏进生成的 C。
//
// 本示例用「红色背景的 TextField」做判据：draw() 后取像素，红通道应显著大于蓝通道。
// 纯 C 构建没有 raster 后端（as_skia_* 全是 no-op），draw() 不产生像素，此时跳过断言。
//
// 编译（Skia 模式）：as-aot examples/bitmapdraw-channel.as --manifest examples/bitmapdraw-channel.build.json

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var tf:TextField = new TextField();
tf.text = "";
tf.width = 16;
tf.height = 16;
tf.background = true;
tf.backgroundColor = 0xFF0000;   // 纯红

var bd:BitmapData = new BitmapData(16, 16, true, 0x00000000);
bd.draw(tf);

var p:uint = bd.getPixel(8, 8);
var r:uint = (p >> 16) & 0xFF;
var g:uint = (p >> 8) & 0xFF;
var b:uint = p & 0xFF;
trace("bitmapdraw-channel: p=0x" + p.toString(16) + " r=" + r + " g=" + g + " b=" + b);

if (p == 0) {
  // 无 raster 后端（纯 C 构建）：draw() 是 no-op，无从判断通道序。
  trace("bitmapdraw-channel: skipped (no raster backend)");
} else {
  // 红背景必须读回为红：R 高、B 低。若 R/B 被交换则此处失败。
  check(r > 200 && b < 50, "red TextField background must read back as red (got r=" + r + " b=" + b + ")");
  check(g < 50, "green must stay near zero (got g=" + g + ")");
  trace("bitmapdraw-channel: ok");
}