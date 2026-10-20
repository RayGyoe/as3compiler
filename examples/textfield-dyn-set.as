// textfield-dyn-set.as — 动态写（`obj[key] = v`，即 `as_dyn_set`）必须先查
// **同层的 setter 表**，再查同名的 props 字段表（阶段二百一十二）。
//
// 为什么必须这样：AS3 里访问器（accessor）压过同名存储字段，而本运行时把
// `text`/`type`/`textColor`（TextField）、`length`（ByteArray）、`delay`（Timer）、
// `quality`（Stage）、`filters`（DisplayObject）、`totalFrames`（MovieClip）等做成
// 「字段 + setter」并存——**字段只是实现细节，setter 才是语义出口**，副作用都在
// setter 里（富文本 `_runs`/`_para` 失效、缓冲区扩容与 position 钳位、tabEnabled
// 联动、24 位 RGB 去 alpha…）。
//
// 反例（修前）：烘焙 SWC 子件（应用里 `item:*` ⇒ `item.note.text = ...`）全走动态写，
// 命中 props 表直接写字段就 return 了——`_runs` 还是上一次 htmlText 的 `[0,12)`，
// 排版只排 12 字节并把一个字劈成两半，渲染出两个 U+FFFD（真实复现见 temp/shareitem）。
// 本例用一个普通类的 TextField 成员复刻同一条路径（不依赖 SWC），断言动态写与
// 静态写**结果完全相同**。
import flash.text.TextField;
import flash.text.TextFieldType;
import flash.text.TextFormat;
import flash.utils.ByteArray;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var LIT:String = "(视频互动请使用此链接，点击可复制)";
var FMT:TextFormat = new TextFormat("_sans", 12, 0x000000);

class Holder {
  public var note:TextField;
  public function Holder():void { note = new TextField(); note.defaultTextFormat = FMT; }
}

// ---- 1. 动态写 text 必须清掉上一次 htmlText 留下的富文本区间 ----------------
var h:* = new Holder();
h.note.wordWrap = true;                 // 动态写一个普通字段：照旧写字段
h.note.autoSize = "left";
h.note.htmlText = "<p>说明文字</p>";     // 静态写：安装 runs [0,12)
var richWidth:Number = h.note.textWidth;

h.note.text = LIT;                      // 动态写：必须走 TextField_set_text
check(h.note.text == LIT, "dynamic text write stores the whole string");
// 纯 C 构建没有排版后端，textWidth 恒为 0（既有口径，见 textrich.as）；只有接了
// 排版后端时才可能「量出」旧 run 的残宽，所以这一条在能量时才有意义。
if (richWidth > 0) {
  check(h.note.textWidth > richWidth,
    "dynamic text write lays out the new text, not the stale run (" + h.note.textWidth + " vs " + richWidth + ")");
}

// 同一个字符串、同一个格式，但字段从未装过富文本 —— 宽度必须一模一样。
// （纯 C 构建按 strlen 估宽、Skia 构建按真实字形排，两种口径下这条都必须成立；
// 修前 Skia 下这里是 66.27 vs 208 的差别。）
var fresh:TextField = new TextField();
fresh.defaultTextFormat = FMT;
fresh.autoSize = "left";
fresh.wordWrap = true;
fresh.text = LIT;
check(h.note.textWidth == fresh.textWidth,
  "dynamic write and static write lay out the same string identically ("
  + h.note.textWidth + " vs " + fresh.textWidth + ")");
check(h.note.numLines == fresh.numLines, "and agree on the line count");
check(h.note.textHeight == fresh.textHeight, "and on the height");

// ---- 2. 动态写 type 必须触发 setter 的 tabEnabled 联动 ----------------------
var te:TextField = new TextField();
var dte:* = te;
dte.type = TextFieldType.INPUT;
check(te.type == "input", "dynamic type write stores the value");
check(te.tabEnabled == true, "dynamic type write reaches the setter (tabEnabled follows)");
dte.type = TextFieldType.DYNAMIC;
check(te.tabEnabled == false, "and the reverse change resets tabEnabled");

// ---- 3. 动态写 textColor 必须按 setter 丢掉 alpha 字节 ----------------------
var tc:TextField = new TextField();
var dtc:* = tc;
dtc.textColor = 0x8000FF00;
check(tc.textColor == 0x00FF00, "dynamic textColor write drops the alpha byte");
dtc.backgroundColor = 0x8011AA33;
check(tc.backgroundColor == 0x11AA33, "dynamic backgroundColor write drops the alpha byte");

// ---- 4. 动态写 ByteArray.length 必须真正 resize + 钳位 position ------------
var ba:ByteArray = new ByteArray();
ba.writeUTFBytes("hello");              // length 5, position 5
var dba:* = ba;
dba.length = 2;                         // 缩容：截断，position 跟到 2
check(ba.length == 2, "dynamic length write truncates the buffer");
check(ba.position == 2, "and clamps position to the new length");
check(ba[0] == 104 && ba[1] == 101, "the kept bytes are the original prefix");
dba.length = 5;                         // 扩容：补 0，position 不动
check(ba.length == 5, "dynamic length write grows the buffer");
check(ba.position == 2, "growing does not move position");
check(ba[4] == 0, "the grown range is zero-filled");

// ---- 5. 动态写普通字段仍然直接写字段 ---------------------------------------
var plain:* = new TextField();
plain.multiline = true;
check((plain as TextField).multiline == true, "a field without an accessor still takes the dynamic write");
plain.selectable = false;
check((plain as TextField).selectable == false, "and a second one too");

trace("textfield-dyn-set: all checks passed");