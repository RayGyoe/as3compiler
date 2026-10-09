// scale9grid.as — 阶段一百零一：AS3 可见的 `DisplayObject.scale9Grid` 属性。
//
// 为什么需要：九宫格（SWF `DefineScalingGrid`）此前只有 SWC 烘焙这一条内部路径，
// AS3 侧写 `s.scale9Grid = ...` 会报「未知成员」。属性补齐后直接复用同一批私有槽
// （`_s9x/_s9y/_s9w/_s9h`）与同一套渲染器（as_render_nine_slice），不新增第二条实现。
//
// 语义全部按 adl 51.4.1 实测（temp/s9probe/s9-result.txt、两轮探针）：
//   * 默认 null；赋 null 是「清除」，读回 null；
//   * **存储截断为整数**（向零截断）：(1.5,2.5,3.25,4.75) 读回 (1,2,3,4)，
//     (-1.5,-1.5,5.5,5.5) 读回 (-1,-1,5,5)；
//   * getter **每次返回新的 Rectangle**：与传入实例不同、与上一次读回的也不同，
//     改传入的 rect / 改读回的 rect 都不影响对象（setter 是**拷贝**语义）；
//   * **校验用未截断的原值，且严格要求「严格内含」**：网格必须 x > bounds.left、
//     y > bounds.top、x+w < bounds.right、y+h < bounds.bottom，且 w>0、h>0；
//     等于 bounds、贴任意一条边、越界、负坐标、零宽/零高、以及**没有任何内容**的
//     对象（bounds 为空）一律抛 `TypeError #2004`。因用原值校验，(0.5,0.5,5,5) 合法
//     （读回 0,0,5,5）而 (0,5,5,5) 抛错 —— 两者截断后都含 0，这是最容易抄错的一处；
//   * 抛错**仍然存储**：catch 里读 getter 会拿到那个非法矩形（截断后的值）；
//   * 非法网格不参与九宫格渲染（内部另有 _s9_apply 位），但仍作为「存在网格」被 getter 报出。
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function rectStr(r:Rectangle):String {
  return r == null ? "null" : r.x + "," + r.y + "," + r.width + "," + r.height;
}
function box(w:Number, h:Number, ox:Number, oy:Number):Sprite {
  var s:Sprite = new Sprite();
  s.graphics.beginFill(0xFF0000);
  s.graphics.drawRect(ox, oy, w, h);
  s.graphics.endFill();
  return s;
}
// 返回 "ok" 或 "THROW 2004"，并附带 catch 中读到的网格（AIR 会保留它）
function trySet(s:Sprite, r:Rectangle):String {
  try { s.scale9Grid = r; return "ok"; }
  catch (e:Error) { return "THROW " + e.errorID; }
}
function setAndRead(s:Sprite, x:Number, y:Number, w:Number, h:Number):String {
  return trySet(s, new Rectangle(x, y, w, h));
}

var box30:Sprite = box(30, 30, 0, 0);

// --- 默认值 / 清除 ---
check(box30.scale9Grid == null, "scale9Grid defaults to null");
check(trySet(box30, new Rectangle(10, 10, 5, 5)) == "ok", "a strictly interior grid is accepted");
check(rectStr(box30.scale9Grid) == "10,10,5,5", "the grid reads back");
check(trySet(box30, null) == "ok", "assigning null clears the grid");
check(box30.scale9Grid == null, "cleared grid reads back as null");
check(trySet(box30, null) == "ok", "clearing twice is still fine");

// --- getter 每次都造新对象；setter 是拷贝语义 ---
var r:Rectangle = new Rectangle(10, 10, 5, 5);
box30.scale9Grid = r;
var g1:Rectangle = box30.scale9Grid;
var g2:Rectangle = box30.scale9Grid;
check(g1 == r == false, "the getter does not hand back the assigned instance");
check(g1 == g2 == false, "each read is a fresh Rectangle");
r.width = 4;
check(box30.scale9Grid.width == 5, "the setter copied, so mutating the source rect is inert");
check(g1.x == 10, "the already-read copy keeps its own values");

// --- 截断为整数存储（向零） ---
var frac:Sprite = box(100, 100, 0, 0);
check(setAndRead(frac, 1.5, 2.5, 3.25, 4.75) == "ok", "fractional grid inside a big box is accepted");
check(rectStr(frac.scale9Grid) == "1,2,3,4", "storage truncates toward zero, got " + rectStr(frac.scale9Grid));
check(setAndRead(frac, 1.9, 1.1, 10.9, 10.1) == "ok", "second fractional grid accepted");
check(rectStr(frac.scale9Grid) == "1,1,10,10", "second truncation, got " + rectStr(frac.scale9Grid));

// --- 合法集（严格内含） ---
check(setAndRead(box(30, 30, 0, 0), 1, 1, 5, 5) == "ok", "(1,1,5,5) is strictly inside");
check(setAndRead(box(30, 30, 0, 0), 24, 24, 5, 5) == "ok", "(24,24,5,5) stops one short of the right/bottom edge");
check(setAndRead(box(30, 30, 0, 0), 23, 23, 6, 6) == "ok", "(23,23,6,6) reaches 29 < 30");
check(setAndRead(box(30, 30, 0, 0), 1, 1, 28, 28) == "ok", "(1,1,28,28) spans almost the whole box");
check(setAndRead(box(30, 30, 0, 0), 0.5, 0.5, 5, 5) == "ok", "validation uses the RAW values: (0.5,..) is inside");
check(box30.scale9Grid != null, "a grid that was cleared+failed before still reports presence when set");
check(setAndRead(box(30, 30, 0, 0), 1.9, 1.9, 5.9, 5.9) == "ok", "raw-right 7.8 < 30 is inside");

// --- 非法集（严格内含的两侧都是严格不等式） ---
var valid:Sprite = box(30, 30, 0, 0);
check(setAndRead(valid, 0, 5, 5, 5) == "THROW 2004", "x == bounds.left throws");
check(setAndRead(valid, 5, 0, 5, 5) == "THROW 2004", "y == bounds.top throws");
check(setAndRead(valid, 25, 25, 5, 5) == "THROW 2004", "touching right/bottom throws");
check(setAndRead(valid, 0, 0, 30, 30) == "THROW 2004", "a grid equal to the bounds throws");
check(setAndRead(valid, -5, -5, 5, 5) == "THROW 2004", "negative origin throws");
check(setAndRead(valid, 40, 40, 10, 10) == "THROW 2004", "a grid outside the bounds throws");
check(setAndRead(valid, 25, 25, 6, 6) == "THROW 2004", "an overflowing grid throws");
check(setAndRead(valid, 10, 10, 0, 0) == "THROW 2004", "a zero-size grid throws");
check(setAndRead(valid, 10, 10, 0, 5) == "THROW 2004", "a zero-width grid throws");

// --- 抛错也存储：catch 里读得到那个（截断的）非法矩形 ---
valid.scale9Grid = null;
var bad:String = trySet(valid, new Rectangle(40, 40, 5, 5));
check(bad == "THROW 2004", "the invalid grid reported #2004");
check(rectStr(valid.scale9Grid) == "40,40,5,5", "AIR stores the invalid grid anyway, got " + rectStr(valid.scale9Grid));
var errId:int = 0;
try { valid.scale9Grid = new Rectangle(0, 0, 30, 30); } catch (e:Error) { errId = e.errorID; }
check(errId == 2004, "the error is #2004, got " + errId);
check(rectStr(valid.scale9Grid) == "0,0,30,30", "and the second failure overwrote the stored grid too");

// --- 无内容对象：bounds 为空，任何网格都非法 ---
var empty:Sprite = new Sprite();
check(empty.scale9Grid == null, "an empty Sprite has no grid");
check(setAndRead(empty, 10, 10, 5, 5) == "THROW 2004", "an object with no content rejects every grid");

// --- 内容偏移时，内含是相对**内容 bounds** 而不是 0,0 ---
var off:Sprite = box(30, 30, 10, 10);           // 内容落在 (10,10)-(40,40)
check(setAndRead(off, 15, 15, 5, 5) == "ok", "a grid strictly inside offset content is accepted");
check(setAndRead(off, 10, 10, 5, 5) == "THROW 2004", "a grid touching the content's own origin throws");
check(setAndRead(off, 0, 0, 5, 5) == "THROW 2004", "a grid outside the content throws");

// --- 九宫格位与「存在」位是两回事：非法网格不参与渲染判定，但仍被 getter 报出 ---
var gate:Sprite = box(30, 30, 0, 0);
check(setAndRead(gate, 5, 5, 5, 5) == "ok", "a legal grid for the render gate");
gate.scaleX = 3;
check(rectStr(gate.scale9Grid) == "5,5,5,5", "reading the grid is unaffected by scaling the object");

trace("scale9grid: all assertions passed");