// gc_bytes.as — 字节缓冲纳入 GC 堆（阶段八十九·四十二）。
//
// `ByteArray.data`（grow / compress / uncompress）与 `BitmapData.pixels` 原本走 arena /
// malloc：缓冲挂在 GC 可见的字段上（反射表条目 type 6），却**不在 GC 堆里**，于是
// `System.gc()` 永远收不到它——反复建 ByteArray / BitmapData 再丢弃的程序会一路涨
// （实测 Starling `Sprite 3D` 场景进出 12 轮、每轮 +3.7 MB，线性不收敛）。
//
// 修法：这两类缓冲改为 `gc_alloc(GCT_BYTES, n)`。新类型 `GCT_BYTES` 是叶子（字节里没有
// 指针可跟，可达性完全由持有它的类字段的反射表条目决定），与 `GCT_RAW`（Vector.<T> 的
// 元素存储）分开是为了让 ASC_GC_STATS 的类型账目能区分「每帧的 Vector 载荷」与
// 「可能漏掉的字节缓冲」；旧缓冲只被丢弃（不再 free/realloc），写入这些字段的位置补写屏障；
// `BitmapData.dispose()` 改成丢引用（free 一个 GC 缓冲会砸坏 GC 的空闲链）。
//
// 断言分两层：
//   · `System.totalMemoryNumber` —— GC 堆账目。缓冲进 GC 后这里立刻反映（迁移前这里是 0，
//     因为 malloc 的块不在任何账目里，这正是这个泄漏长期隐形的原因）。
//   · `System.privateMemory` —— 整个进程的常驻内存。malloc 的块只有它看得见：迁移前
//     40 轮 × 1 MB 会让它涨 ~40 MB 且**永不回落**，迁移后 GC 段会被复用/回收，只是平台
//     分配器保留一点工作集。
//
// 界的量级是「一两块」而不是「零」：保守栈扫描会把**最后一次**那一块的指针当作栈上的
// 陈旧字留住（实测正好一块；把变量显式置 null 则能收到 0）——这是 docs/zh-cn/gc.md §4.2.1
// 的既有性质，不是泄漏。

function expect(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

const CHURN_ROUNDS:int = 40;      // 每轮 1 MB，40 轮 = 40 MB
const BUFFER_SIZE:int = 1000000;

function churnByteArrays(rounds:int, size:int):int {
  for (var i:int = 0; i < rounds; i++) {
    var ba:ByteArray = new ByteArray();
    ba.length = size;             // → ByteArray_set_length：容量按 2 的幂增长
    ba.position = 0;
    ba.writeInt(0x01020304);      // → as_ba_grow_pos 路径
    ba.position = size;
    ba.writeByte(0x7F);           // 越界 1 字节 → 可能需要再增长一次
    ba.writeUTFBytes("tail");
    if (ba.length != size + 5) throw new Error("FAIL: ByteArray tail length " + ba.length);
  }
  return rounds;
}

System.gc();
var p0:Number = System.privateMemory;
var t0:Number = System.totalMemoryNumber;

// ① 第一轮：40 × 2 MB 缓冲全部丢弃，`System.gc()` 后账目和 RSS 都不许线性上涨。
churnByteArrays(CHURN_ROUNDS, BUFFER_SIZE);
System.gc();
var t1:Number = System.totalMemoryNumber;
var p1:Number = System.privateMemory;
expect(t1 < t0 + 2500000, "gc reclaimed the ByteArray buffers (totalMemory " + t0 + " → " + t1 + ")");
expect(p1 < p0 + 16000000, "RSS did not grow by the churn size (privateMemory " + p0 + " → " + p1 + ")");

// 第二轮：再 40 轮。段被复用后**不许**再涨一个 churn 的量——这条是「不是一次性巧合」的证据。
churnByteArrays(CHURN_ROUNDS, BUFFER_SIZE);
System.gc();
var t2:Number = System.totalMemoryNumber;
var p2:Number = System.privateMemory;
expect(t2 < t0 + 2500000, "second burst: gc reclaims again (totalMemory=" + t2 + ")");
expect(p2 < p1 + 8000000, "second burst: RSS plateaus instead of ramping (privateMemory " + p1 + " → " + p2 + ")");

// ② compress / uncompress 的整块中间缓冲（compressBound / 4x+64）同样要能回收。
var big:ByteArray = new ByteArray();
big.length = 400000;
big.position = 0;
for (var w:int = 0; w < 40000; w++) big.writeInt(w & 0xFFFF);
var rawLen:int = big.length;
big.compress();
var compressedLen:int = big.length;
big.uncompress();
expect(big.length == rawLen, "uncompress restores the original length (got " + big.length + " want " + rawLen + ")");
expect(compressedLen < rawLen, "compress shrank the payload (" + compressedLen + " < " + rawLen + ")");
big = null;
System.gc();
var t3:Number = System.totalMemoryNumber;
expect(t3 < t0 + 2500000, "the zlib scratch buffers were reclaimed (totalMemory=" + t3 + ")");

// ③ BitmapData：512×512 = 1 MB/张，40 张全部丢弃（**不**调 dispose）。
//    循环包在函数里：直接写在 main 里的话，最后一次的局部仍留在 main 的栈帧里，保守扫描
//    会把它连同 1 MB 缓冲留住；包进函数后已返回的帧不在扫描窗口内，断言更严格。
function churnBitmaps(rounds:int, size:int):void {
  for (var b:int = 0; b < rounds; b++) {
    var bd:BitmapData = new BitmapData(size, size, true, 0x80402010);
    if (bd.getPixel(1, 1) != 0x402010) throw new Error("FAIL: BitmapData fill wrong: " + bd.getPixel(1, 1));
  }
}

churnBitmaps(40, 512);
System.gc();
var t4:Number = System.totalMemoryNumber;
var p4:Number = System.privateMemory;
expect(t4 < t0 + 2500000, "gc reclaimed the BitmapData pixel buffers (totalMemory=" + t4 + ")");
expect(p4 < p0 + 16000000, "the pixel buffers did not leak into RSS (privateMemory " + p0 + " → " + p4 + ")");

// ④ dispose() 之后必须彻底回收（dispose 现在是「丢引用」，不再 free GC 缓冲）。
var bd2:BitmapData = new BitmapData(512, 512);
bd2.dispose();
System.gc();
var t5:Number = System.totalMemoryNumber;
expect(t5 < t0 + 2500000, "dispose() lets the pixel buffer go (totalMemory=" + t5 + ")");

// ⑤ 活着的缓冲**不许**被回收。这里用「同尺寸反复分配 + 收集」把复用逼出来：若标记
//    漏掉了 `data` / `pixels`（反射表条目的 type 6），活着的缓冲会被收进空闲链，下一次
//    同尺寸分配就会拿到它并被 `gc_alloc` 清零 —— 读数立刻暴露。尺寸必须**同档**（下面
//    live 的容量是 131072 字节，正是 churn 里 100000 字节增长后的档位；live2 与 churn
//    的位图都是 512×512 = 1 MB 档），否则空闲链不会命中，测试就变成空转。
var live:ByteArray = new ByteArray();
live.length = 100000;
live.position = 0;
for (var k:int = 0; k < 25000; k++) live.writeInt(0x0A0B0C0D + k);
var live2:BitmapData = new BitmapData(512, 512, true, 0xFF00FF00);
live2.setPixel(0, 0, 0x010203);
live2.setPixel(10, 20, 0xABCDEF);
live2.setPixel(511, 511, 0x123456);
for (var r:int = 0; r < 20; r++) {
  churnByteArrays(5, 100000);                       // 同尺寸（100000 → 容量 131072）→ 逼复用
  churnBitmaps(1, 512);                     // 同尺寸 1 MB → 逼复用
  System.gc();
}
live.position = 0;
expect(live.readInt() == 0x0A0B0C0D, "a live ByteArray keeps its first word across collections (got " + live.readInt() + ")");
live.position = 4 * 24999;
expect(live.readInt() == 0x0A0B0C0D + 24999, "a live ByteArray keeps its last word (got " + live.readInt() + ")");
expect(live2.getPixel(0, 0) == 0x010203, "a live BitmapData keeps its first pixel (got " + live2.getPixel(0, 0) + ")");
expect(live2.getPixel(10, 20) == 0xABCDEF, "a live BitmapData keeps a middle pixel (got " + live2.getPixel(10, 20) + ")");
expect(live2.getPixel(511, 511) == 0x123456, "a live BitmapData keeps its last pixel (got " + live2.getPixel(511, 511) + ")");
expect(live2.getPixel(1, 1) == 0x00FF00, "a live BitmapData keeps its fill (got " + live2.getPixel(1, 1) + ")");

trace("gc_bytes: p0=" + p0 + " p1=" + p1 + " p2=" + p2 + " p4=" + p4);
trace("gc_bytes: t1=" + t1 + " t2=" + t2 + " t3=" + t3 + " t4=" + t4 + " t5=" + t5);
trace("gc_bytes: all assertions passed");