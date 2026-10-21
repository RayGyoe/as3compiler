// bitmap-smoothing.as — Bitmap.smoothing 采样模式回归。
//
// AIR 的 Bitmap.smoothing 决定位图缩放时的采样方式：默认 false（最近邻，放大后的
// 像素块边缘保持硬边），true 时是双线性（adl 51.4.1 实测）。渲染分支此前无论该
// 属性为何都走 Skia 的 SkSamplingOptions() 默认值——即恒为最近邻，于是
// `bitmap.smoothing = true` 被完全忽略。
//
// 真应用的症状：文档预览把幻灯片位图按 scaleX 缩放到视口，缩放比每帧有亚像素
// 抖动；最近邻会把这种抖动放大成「清晰 ↔ 毛糙」的跳变（采样点落在不同像素上），
// 双线性则永远是平滑过渡。
//
// 判据：把一条 16x1 黑白相间的位图缩到 4x1（0.25 倍，每个输出像素覆盖 4 个源像素）。
//   smoothing=false 最近邻 → 每个输出像素就是某个源像素 → 只能是 0x00 / 0xFF
//   smoothing=true  双线性 → 混色 → 至少有一个中间灰（60..195）
// 纯 C 构建没有 raster 后端（as_skia_* 全是 no-op），draw() 不产生像素，此时跳过断言。
//
// 编译（Skia 模式）：as-aot examples/bitmap-smoothing.as --manifest examples/bitmap-smoothing.build.json

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var SRC_W:int = 16;
var src:BitmapData = new BitmapData(SRC_W, 1, false, 0x000000);
for (var i:int = 0; i < SRC_W; i++) src.setPixel(i, 0, (i % 2 == 0) ? 0x000000 : 0xFFFFFF);

// 一个中间灰像素的数量。
function mids(bd:BitmapData):int {
    var n:int = 0;
    for (var x:int = 0; x < bd.width; x++) {
        var v:int = bd.getPixel(x, 0) & 0xFF;
        if (v > 60 && v < 195) n++;
    }
    return n;
}

function render(smooth:Boolean):BitmapData {
    var bm:Bitmap = new Bitmap(src);
    bm.smoothing = smooth;
    bm.scaleX = 4.0 / SRC_W;   // 0.25
    bm.scaleY = 1.0;
    var holder:Sprite = new Sprite();
    holder.addChild(bm);
    var out:BitmapData = new BitmapData(4, 1, true, 0x00000000);
    out.draw(holder);
    return out;
}

var hard:BitmapData = render(false);
var soft:BitmapData = render(true);

if ((hard.getPixel32(0, 0) & 0xFF000000) == 0 && (soft.getPixel32(0, 0) & 0xFF000000) == 0) {
    // 无 raster 后端（纯 C 构建）：draw() 是 no-op，无从判断采样模式。
    trace("bitmap-smoothing: skipped (no raster backend)");
} else {
    var mh:int = mids(hard);
    var ms:int = mids(soft);
    trace("bitmap-smoothing: nearest mids=" + mh + " bilinear mids=" + ms);
    check(mh == 0, "smoothing=false must sample one texel per pixel (no blended value), got " + mh);
    check(ms > 0, "smoothing=true must blend (bilinear), got " + ms);
    trace("bitmap-smoothing: ok");
}