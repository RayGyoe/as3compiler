// gettextformat.as — TextField.getTextFormat() 必须回答「该范围内生效的格式」（G21，阶段二百七十）。
//
// 缺陷：`getTextFormat` 曾是**一行** `return (tf != NULL) ? tf->defaultTextFormat : NULL;`
// ——它写在 run 表存在之前。于是 `setTextFormat(new TextFormat('Arial', 30, 0xFF0000))`
// 之后，无论问哪个范围，回读都是默认的 20/黑；无参形式也永远看不到 run。
//
// 判据来自 adl 51.4.1 双端同源探针（asaotui/probes/g21-gettextformat，30 格读数）：
//   * 无 run                  → 非空范围一律回答 defaultTextFormat；
//   * 完全落在一条 run 内      → 回答那条 run 的格式；
//   * 跨 run 边界 / 反序 / 空区间 → 回答**空 TextFormat**（我们建模的字段全 null）；
//   * 相邻两条 run 数值相同    → 仍然回答该格式（比较的是**值**，不是 run 身份）；
//   * (0,0)、空文本、begin>=length、end>length → RangeError #2006，
//     而文本内部的空区间（如 (3,3)）回答空格式、不抛；
//   * 任一端点给 -1 表示「未提供」，不做越界检查。
//
// 本示例只用**值**断言，不依赖文本引擎的像素度量 ⇒ 纯 C 构建也能跑。
//
// 编译：
//   as-aot examples/gettextformat.as --run

import flash.text.TextField;
import flash.text.TextFormat;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function base():TextField {
  var f:TextField = new TextField();
  f.defaultTextFormat = new TextFormat('Arial', 20, 0x000000);
  f.text = '0123456789';
  return f;
}

function fmt(size:Number, color:uint):TextFormat {
  return new TextFormat('Arial', size, color);
}

// 返回 errorID；没抛则为 0。
function errId(f:TextField, b:int, e:int):int {
  try {
    f.getTextFormat(b, e);
  } catch (err:Error) {
    return err.errorID;
  }
  return 0;
}

function main():void {
  // ① 没有 run 时，任何非空范围都回答默认格式
  var plain:TextField = base();
  var p1:TextFormat = plain.getTextFormat();
  check(p1.size == 20, '无 run 无参：size 应为 20，实际 ' + p1.size);
  check(p1.color == 0, '无 run 无参：color 应为 0，实际 ' + p1.color);
  var p2:TextFormat = plain.getTextFormat(0, 10);
  check(p2.size == 20, '无 run 整段：size 应为 20，实际 ' + p2.size);
  var p3:TextFormat = plain.getTextFormat(3, 5);
  check(p3.size == 20 && p3.color == 0, '无 run 内部区间：应为 20/0，实际 ' + p3.size + '/' + p3.color);

  // ② 完全落在一条 run 内 —— 这就是缺陷的原始症状
  var one:TextField = base();
  one.setTextFormat(fmt(30, 0xFF0000), 2, 6);
  var r1:TextFormat = one.getTextFormat(3, 5);
  check(r1.size == 30, 'run 内：size 应为 30，实际 ' + r1.size);
  check(r1.color == 16711680, 'run 内：color 应为 0xFF0000，实际 ' + r1.color);

  // ③ run 之外仍是默认格式（gap 用 defaultTextFormat）
  var r2:TextFormat = one.getTextFormat(0, 2);
  check(r2.size == 20 && r2.color == 0, 'run 之前：应为 20/0，实际 ' + r2.size + '/' + r2.color);
  var r3:TextFormat = one.getTextFormat(6, 9);
  check(r3.size == 20 && r3.color == 0, 'run 之后：应为 20/0，实际 ' + r3.size + '/' + r3.color);

  // ④ 跨 run 边界 ⇒ 空 TextFormat（所有建模字段 null）
  var r4:TextFormat = one.getTextFormat(1, 4);
  check(r4.size == null, '跨出 run：size 应为 null，实际 ' + r4.size);
  check(r4.color == null, '跨出 run：color 应为 null，实际 ' + r4.color);
  check(r4.bold == null, '跨出 run：bold 也应为 null，实际 ' + r4.bold);
  var r5:TextFormat = one.getTextFormat(1, 9);
  check(r5.size == null && r5.color == null, 'run 两侧都跨：应为空格式');

  // ⑤ 空区间：文本内部回答空格式，(0,0) 与越界抛 #2006
  var r6:TextFormat = one.getTextFormat(2, 2);
  check(r6.size == null, '空区间 (2,2)：size 应为 null，实际 ' + r6.size);
  var r7:TextFormat = plain.getTextFormat(3, 3);
  check(r7.size == null, '空区间 (3,3)：size 应为 null，实际 ' + r7.size);
  check(errId(plain, 0, 0) == 2006, '(0,0) 应抛 #2006，实际 ' + errId(plain, 0, 0));
  check(errId(plain, 10, 10) == 2006, '(10,10) 越过末尾应抛 #2006，实际 ' + errId(plain, 10, 10));
  check(errId(plain, 0, 11) == 2006, '(0,11) 越界应抛 #2006，实际 ' + errId(plain, 0, 11));
  check(errId(plain, 20, 30) == 2006, '(20,30) 越界应抛 #2006，实际 ' + errId(plain, 20, 30));
  check(errId(plain, 3, 3) == 0, '文本内部的空区间 (3,3) 不应抛错，实际 ' + errId(plain, 3, 3));

  // ⑥ 反序区间 ⇒ 空格式（不交换、不抛）
  var r8:TextFormat = plain.getTextFormat(6, 2);
  check(r8.size == null, '反序 (6,2)：size 应为 null，实际 ' + r8.size);

  // ⑦ -1 表示「未提供」，不做越界检查
  var plain2:TextField = base();
  var r9:TextFormat = plain2.getTextFormat(-1, 5);
  check(r9.size == 20 && r9.color == 0, '(-1,5)：应为 20/0，实际 ' + r9.size + '/' + r9.color);
  var r10:TextFormat = plain2.getTextFormat(5, -1);
  check(r10.size == 20 && r10.color == 0, '(5,-1)：应为 20/0，实际 ' + r10.size + '/' + r10.color);

  // ⑧ 相邻两条 run：数值相同 ⇒ 回答该格式；数值不同 ⇒ 空格式
  var same:TextField = base();
  same.setTextFormat(fmt(30, 0xFF0000), 0, 3);
  same.setTextFormat(fmt(30, 0xFF0000), 3, 6);
  var r11:TextFormat = same.getTextFormat(0, 6);
  check(r11.size == 30, '两条数值相同的 run 跨读：size 应为 30，实际 ' + r11.size);

  var diff:TextField = base();
  diff.setTextFormat(fmt(11, 0x0000FF), 0, 3);
  diff.setTextFormat(fmt(44, 0x00FF00), 3, 6);
  var r12:TextFormat = diff.getTextFormat(0, 6);
  check(r12.size == null, '两条不同 run 跨读：size 应为 null，实际 ' + r12.size);
  var r13:TextFormat = diff.getTextFormat(4, 5);
  check(r13.size == 44, '第二条 run 内：size 应为 44，实际 ' + r13.size);
  check(r13.color == 65280, '第二条 run 内：color 应为 0x00FF00，实际 ' + r13.color);

  // ⑨ 无参形式也读 run：整段一条 run ⇒ 该格式；只覆盖一部分 ⇒ 空格式
  var whole:TextField = base();
  whole.setTextFormat(fmt(30, 0xFF0000), 0, 10);
  var r14:TextFormat = whole.getTextFormat();
  check(r14.size == 30 && r14.color == 16711680, '整段一条 run 无参：应为 30/0xFF0000，实际 ' + r14.size + '/' + r14.color);
  var r15:TextFormat = one.getTextFormat();
  check(r15.size == null, '部分覆盖无参：size 应为 null，实际 ' + r15.size);

  // ⑩ 空文本：无参回答空格式，显式下标越界
  var empty:TextField = new TextField();
  empty.defaultTextFormat = new TextFormat('Arial', 20, 0x000000);
  empty.text = '';
  var r16:TextFormat = empty.getTextFormat();
  check(r16.size == null && r16.color == null, '空文本无参：应为空格式');
  check(errId(empty, 0, 0) == 2006, '空文本 (0,0) 应抛 #2006，实际 ' + errId(empty, 0, 0));
  check(errId(empty, 0, 1) == 2006, '空文本 (0,1) 应抛 #2006，实际 ' + errId(empty, 0, 1));

  // ⑪ 返回的是**副本**：改它不影响字段（AIR 每次都给新对象）
  var copy:TextField = base();
  copy.setTextFormat(fmt(30, 0xFF0000), 2, 6);
  var got:TextFormat = copy.getTextFormat(3, 5);
  got.color = 0x00FF00;
  got.size = 99;
  var again:TextFormat = copy.getTextFormat(3, 5);
  check(again.size == 30 && again.color == 16711680,
        '改返回值不应影响字段：应为 30/0xFF0000，实际 ' + again.size + '/' + again.color);

  trace('gettextformat: 范围内格式（单 run / gap / 跨边界空格式 / #2006 越界 / 副本）— assertions passed');
}

main();