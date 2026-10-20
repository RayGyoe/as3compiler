// swc-bitmap.as — 阶段九十五 B：SWC 位图资源类嵌入回归。
//
// 覆盖两条引用路径（swc.md §6）：`--swc` 里的命名位图资源类可以
//   ① 在源码里按类名直接 `new desktopicon(0, 0)`；
//   ② 经 `getDefinitionByName("desktopicon")` 反射拿到 `Class` 再动态 `new cls()`。
//
// 判据分两层，因为资源解码依赖 Skia：
//   · 结构层（纯 C 构建也成立）：类存在、是 BitmapData 子类、构造器可调用、
//     且**构造器实参被忽略**——AIR 的资源类构造器签名是 `(width, height)` 但从不使用它
//     （`new desktopicon(0,0)` 实测得 342×194，`new desktopicon(999,999)` 同样），这是必须保住的语义。
//   · 像素层（仅 Skia 构建）：尺寸来自嵌入字节解码出的真实图像，且像素在容差内
//     （§11③：允许 ±1 通道偏差，alpha 必须逐位精确）。
// 纯 C 构建下 `as_skia_*` 全是空桩 → 解码不出像素 → 宽高为 0，此时跳过像素层断言。
//
// 编译（结构层）：  as-aot examples/swc-bitmap.as --swc examples/embed-assets/skin.swc --run
// 编译（像素层）：  as-aot examples/swc-bitmap.as --manifest examples/swc-bitmap.build.json --run
// `examples/embed-assets/skin.swc` 是**入库的**实测样本（swc.md §11 的同一份皮肤）。
//
// 期望像素的**来源**：不再是 `adl` 侧的人工读数（本机没有 AIR SDK），而是对夹具里
// `DefineBitsLossless2` 字符 #1 的独立交叉解码：(a) 用第三方解码器（PIL）读我们产出的 PNG；
// (b) 用原生字节解析器直接读该 tag 的裸 ARGB（`stride = w*4`，**没有**逐行 filter byte）。
// 两条路在下列探针像素上逐位一致，所以下面的期望值是真值而非自证。

import flash.display.BitmapData;
import flash.utils.getDefinitionByName;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// ---- ① 直接按类名 new ----
var bd:BitmapData = new desktopicon(0, 0);
check(bd is BitmapData, "a resource class instance must be a BitmapData");

// 构造器实参被忽略：换一组完全不同的尺寸，结果必须不变。
var bdArgs:BitmapData = new desktopicon(999, 999);
check(bdArgs.width == bd.width && bdArgs.height == bd.height,
  "resource-class constructor arguments must be ignored (AIR semantics)");

// ---- ② 反射路径 ----
var cls:Class = getDefinitionByName("desktopicon") as Class;
check(cls != null, "getDefinitionByName('desktopicon') must resolve the embedded resource class");
var bdReflect:BitmapData = new cls() as BitmapData;
check(bdReflect is BitmapData, "reflectively instantiated resource must be a BitmapData");
check(bdReflect.width == bd.width && bdReflect.height == bd.height,
  "reflective instantiation must match direct `new`");

// ---- 像素层（Skia 构建才成立）----
if (bd.width > 0) {
  check(bd.width == 342 && bd.height == 194, "desktopicon must be 342x194 (the SWF RECT says so)");

  // alpha 通道逐位精确（RGB 允许 ±1；见 swc.md §5「保真」实测修正）。
  check(bd.getPixel32(0, 0) == 0x00000000, "pixel(0,0) must be fully transparent");
  check(bd.getPixel32(341, 0) == 0x00000000, "pixel(341,0) must be fully transparent");
  check(bd.getPixel32(0, 193) == 0x00000000, "pixel(0,193) must be fully transparent");
  check(bd.getPixel32(341, 193) >>> 24 == 0xcf, "pixel(341,193) alpha must be 0xcf (exact)");
  check(bd.getPixel32(1, 193) >>> 24 == 0xef, "pixel(1,193) alpha must be 0xef (exact)");

  // 不透明像素走的是恒等路径（预乘/反预乘都不改值），所以 RGB 也必须精确。
  check(bd.getPixel32(171, 97) == 0xfff6f6f6, "pixel(171,97) must be 0xfff6f6f6 (opaque => exact RGB)");
  check(bd.getPixel32(1, 97) == 0xffcccccc, "pixel(1,97) must be 0xffcccccc (opaque => exact RGB)");

  // 半透明像素的 RGB 允许 ±1 通道偏差（Skia 解码的两次取整）。
  var semi:uint = bd.getPixel32(341, 193);
  check(Math.abs((semi >> 16 & 0xFF) - 0xcb) <= 1 &&
        Math.abs((semi >> 8 & 0xFF) - 0xcb) <= 1 &&
        Math.abs((semi & 0xFF) - 0xcb) <= 1,
    "pixel(341,193) RGB must be within ±1 of 0xcbcbcb");
}

trace("swc-bitmap OK (desktopicon " + bd.width + "x" + bd.height + ")");