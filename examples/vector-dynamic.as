// vector-dynamic.as — 阶段九十八·二：`Vector.<T>` 经 `*` 接收者的动态访问，
// 以及 `*` 元素槽的 GC 写屏障。
//
// 为什么需要：单态化的 `Vector.<T>` 体是 GCT_CUSTOM，其**首字是它的 mark 回调，
// 不是 vtable**，所以运行时的动态派发点（as_dyn_get / as_dyn_set / as_dyn_call）
// 若照 vtable 走，就会把那个回调当 vtable 头解引用而崩 —— `pv.push(..)` 曾段错误。
// 元素类型只有 codegen 期知道，故三个钩子（as_vec_get_hook / as_vec_set_hook /
// as_vec_call_hook）由生成的 as_vec_wire() 装入，判定用现成的 as_dyn_kind()==3。
//
// 语义按 adl 51.4.1 实测（temp/vecstar/vec-result.txt、vec2-result.txt）：
//   * `pv.length` 可读**也可写**（增长填 null、截断），`pv[i]` 读写皆可；
//     越界与**负**索引的读/写一律抛 #1125 —— 与静态路径逐字一致；
//   * `pv.push/pop/shift/unshift/indexOf/removeAt/insertAt/join/slice/concat/
//     splice/reverse/sort/map/filter/forEach` 全部转调**同一个**单态化助手，
//     所以动态与静态两条路不可能漂移（这正是「复用而非重写」的理由）；
//   * `pv.join("|")` 与 `pv.length` 读还会走 as_any_join/as_any_length 这两个
//     快捷助手（codegen 直发），故它们各自也需要一个 GCT_CUSTOM 分支。
//
// GC 红线（AGENTS.md §2.4）：`Vector.<*>` 的元素槽是**可持 GC 指针的字段**，
// 所以 push/unshift/insertAt/set/splice 的每个写点都必须补
// gc_write_barrier_value —— 否则增量标记期已变黑的对象写进一个白引用会被漏标，
// 该对象随后被误回收成悬空指针。下面的 ENTER_FRAME 段就是这条不变式的回归。
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

class Item {
  public var n:int;
  public var tag:String;
  public function Item(n:int, t:String) { this.n = n; this.tag = t; }
}

// ---- 1. 动态读：length 与下标 ----
var vs:Vector.<String> = new <String>["abc", "def"];
var pv:* = vs;
check(pv.length == 2, "pv.length");
check(pv[0] == "abc" && pv[1] == "def", "pv[i] read");
check(vs.length == 2 && vs[0] == "abc", "typed receiver still reads the same object");

// ---- 2. 动态方法调用 ----
check(pv.push("ghi") == 3, "push returns the new length");
check(pv.length == 3 && vs.length == 3 && vs[2] == "ghi", "push is visible on the typed vector");
check(pv.indexOf("abc") == 0 && pv.indexOf("zzz") == -1, "indexOf");
check(pv.join("|") == "abc|def|ghi", "join");
check(pv.pop() == "ghi" && pv.length == 2, "pop");
check(pv.shift() == "abc" && vs[0] == "def", "shift");
check(pv.unshift("x") == 2 && vs[0] == "x", "unshift");
check(pv.removeAt(0) == "x" && vs.length == 1, "removeAt");
pv.insertAt(0, "y");
check(vs.join(",") == "y,def", "insertAt");
var sl:* = pv.slice(0, 1);
check(sl.length == 1 && sl[0] == "y", "slice returns a vector");
var cc:* = pv.concat(sl);
check(cc.join(",") == "y,def,y", "concat");
var sp:* = pv.splice(1, 1);
check(sp.join(",") == "def" && pv.join(",") == "y", "splice returns the removed items");
pv.reverse();
check(pv.join(",") == "y", "reverse in place");

// ---- 3. 动态 length 写：增长填 null、截断 ----
var z:Vector.<*> = new <*>["abc", "def"];
var pz:* = z;
pz.length = 4;
check(pz.length == 4 && z.length == 4, "grow writes through");
check(pz[2] == null && pz[3] == null && z[2] == null, "grown slots are null");
pz.length = 1;
check(pz.length == 1 && z.length == 1, "truncate writes through");

// ---- 4. 越界与负索引：#1125（与静态路径同号） ----
function errorID(fn:Function):int {
  try { fn(); } catch (e:Error) { return e.errorID; }
  return -1;
}
var pe:* = new <int>[3, 4];
check(errorID(function ():void { var x:* = pe[9]; }) == 1125, "oob read -> #1125");
check(errorID(function ():void { pe[9] = 1; }) == 1125, "oob write -> #1125");
check(errorID(function ():void { var x:* = pe[-1]; }) == 1125, "negative read -> #1125");
check(errorID(function ():void { pe[-1] = 1; }) == 1125, "negative write -> #1125");
var es:Vector.<int> = new <int>[3, 4];
check(errorID(function ():void { var x:int = es[9]; }) == 1125, "typed oob read -> #1125");

// ---- 5. Number 向量的 sort / map / filter / forEach ----
// A new or grown slot fills with the element type's ZERO value, not the
// "uninitialised variable" default: adl 51.4.1 gives 0,0,0 here (isNaN false),
// while a bare `var n:Number` is NaN (temp/vecstar/vecfill-result.txt).
var sized:Vector.<Number> = new Vector.<Number>(3);
check(sized.join(",") == "0,0,0" && !isNaN(sized[0]), "a sized Vector.<Number> fills with 0");
sized.length = 5;
check(sized.join(",") == "0,0,0,0,0", "growing a Vector.<Number> fills with 0");
var pn:* = new <Number>[3, 1, 2];
pn.sort();
check(pn.join(",") == "1,2,3", "sort (no comparator)");
check(pn.map(incr).join(",") == "2,3,4", "map");
check(pn.filter(big).join(",") == "3", "filter");
var cnt:int = 0;
pn.forEach(countUp);
check(cnt == 3, "forEach");
// Vector callbacks receive (element, index, vector): AIR requires the full
// 3-parameter signature and raises #1063 for a shorter one (measured on
// adl 51.4.1: temp/pkgA/cbk2 A "Expected 1, got 3").
function incr(n:Number, i:int, v:*):Number { return n + 1; }
function big(n:Number, i:int, v:*):Boolean { return n > 2; }
function countUp(n:Number, i:int, v:*):void { cnt = cnt + 1; }

// ---- 6. 对象元素：动态写 + GC（写屏障回归） ----
var stage:Stage = new Stage();
var pool:Vector.<*> = new <*>[];
var poolRef:* = pool;
var frame:int = 0;
function onFrame(e:Event):void {
  // 每帧经 `*` 接收者 **push / 下标写** 塞进新对象。帧边界是 GC 安全点
  // （Stage_dispatchFrame 开头 gc_step()），增量标记会跨帧推进，所以这些写点
  // 命中「已变黑的对象写白引用」的窗口 —— 缺写屏障就会被漏标并误回收。
  for (var i:int = 0; i < 20; i++) poolRef.push(new Item(frame * 100 + i, "t" + frame));
  if (frame % 3 == 0) poolRef[0] = new Item(-1, "replaced" + frame);
  frame++;
}
stage.addEventListener(Event.ENTER_FRAME, onFrame);
for (var f:int = 0; f < 200; f++) stage.dispatchFrame();

System.gc();
var total:int = 0;
var bad:int = 0;
for (var k:int = 0; k < poolRef.length; k++) {
  var it:Item = poolRef[k];
  if (it == null || it.tag == null) bad++;
  else total = total + it.n;
}
check(poolRef.length == 200 * 20, "every pushed element survived");
check(bad == 0, "no element was recycled into a dangling pointer");
check(pool.length == 200 * 20, "the typed vector sees the same elements");

// 动态 set 也要穿到类型化向量，且再跑一轮 GC
poolRef[0] = new Item(42, "final");
System.gc();
check((pool[0] as Item).n == 42, "dynamic index write is visible on the typed vector");

trace("vector-dynamic: all assertions passed; elements=", poolRef.length, "sum=", total);