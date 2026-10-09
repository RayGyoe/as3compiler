// stage94h.as — 阶段九十四·八：TextField 的 border/borderColor 与「动态可选文本」的拖选。
//
// 触发：两处「AIR 已定义、我们跑不出」的缺口（AGENTS.md §1.5 的硬判据）——
//   ① `TextField.border`/`borderColor` 此前**完全没有实现**（属性不存在 ⇒ 编译期报错）；
//   ② 阶段九十四·七 依据 Ed2 的单次合成拖拽，把「鼠标拖选」实现成**仅 type='input'
//      生效**（当时的读数是 dynamic+selectable 字段拖完仍为 (7,7,7)）。用逐步上报的
//      Ed5 探针重测后**推翻**：dynamic+selectable 字段同样能拖选、能 Cmd+C 复制，
//      旧读数是「合成拖拽没被引擎识别」的误判。
//
// 证据台：temp/editprobe/（探针 src/Ed5.as 逐事件 STATE 上报 + drive_ed5.py 同一驱动
// 两端跑 + cmp_ed5.py 结构化比较器判「选区锚定行为」；边框像素口径来自 src/Ed6.as
// 的 BitmapData.draw 逐像素扫描与 src/Ed7.as 的真窗口截图双端比对；结论表见该目录
// README.md）。
//
// 本示例只钉**无窗口可断言**的部分：默认值、读写往返、边框不参与文本度量。
// 鼠标/键盘驱动才能观测的部分（拖选、点在选择区内、双击选词、Cmd+C）由上述
// 双端对照台负责，缺口登记在 TODO.md。
import flash.display.Sprite;
import flash.text.TextField;
import flash.text.TextFormat;

function check(cond:Boolean, msg:String):void {
	if (!cond) throw new Error("FAIL: " + msg);
}

function eq(actual:*, expected:*, msg:String):void {
	if (actual != expected) throw new Error("FAIL: " + msg + " (got " + actual + ", want " + expected + ")");
}

// ---- 1. 默认值（adl 51.4.1 实测，probe src/Ed6.as 的默认值段） -------------
// 注意 backgroundColor 默认是 **0xFFFFFF**（不是 0xFFFFFFFF）——这是本轮修正：
// 旧实现按「带 alpha 的 0xFFFFFFFF」写，adl 读回的是 16777215。
var f:TextField = new TextField();
eq(f.border, false, "default border is false");
eq(f.borderColor, 0, "default borderColor is black");
eq(f.background, false, "default background is false");
eq(f.backgroundColor, 16777215, "default backgroundColor is 0xFFFFFF");
// selectable 默认 true，与 type 无关 —— 这正是「dynamic 字段也能拖选」的前提。
eq(f.selectable, true, "default selectable is true");

// ---- 2. 读写往返（border 是 Boolean、borderColor 是 uint） ----------------
var g:TextField = new TextField();
g.border = true;
eq(g.border, true, "border round-trip");
g.border = false;
eq(g.border, false, "border can be turned off again");
g.borderColor = 0x00FF00;
eq(g.borderColor, 0x00FF00, "borderColor round-trip");
g.borderColor = 0x0000FF;
eq(g.borderColor, 0x0000FF, "borderColor round-trip (blue)");
// 三个颜色属性都是 **24 位 RGB**：AIR 在**写入时丢掉 alpha 字节**，所以读回也看不到它
// （adl 51.4.1 实测，temp/editprobe/tracesrc/Ed8.as）：borderColor 0xFFFFFFFF ->
// 0xffffff、0xFF00FF00 -> 0xff00；backgroundColor/textColor 亦然（0x8000FF00 -> 0xff00）。
g.borderColor = 0x8000FF00;
eq(g.borderColor, 0x0000FF00, "borderColor drops the alpha byte on write");
g.borderColor = 0xFFFFFFFF;
eq(g.borderColor, 0xFFFFFF, "borderColor 0xFFFFFFFF reads back 0xFFFFFF");
g.backgroundColor = 0x8000FF00;
eq(g.backgroundColor, 0x0000FF00, "backgroundColor drops the alpha byte too");
g.textColor = 0x8000FF00;
eq(g.textColor, 0x0000FF00, "textColor drops the alpha byte too");

// ---- 3. 边框不参与文本度量，也不改字段自身尺寸 ---------------------------
// adl 实测：开/关 border 对 textWidth/textHeight 无影响；边框画在
// x∈{0,width}、y∈{0,height} 的**外沿**，不改变字段的 width/height 读写值。
var h:TextField = new TextField();
h.defaultTextFormat = new TextFormat("_typewriter", 12, 0x000000);
h.text = "ABCDEFGHIJ";
h.width = 100;
h.height = 30;
var w0:Number = h.width;
var h0:Number = h.height;
var tw0:Number = h.textWidth;
var th0:Number = h.textHeight;
h.border = true;
eq(h.width, w0, "border does not change width");
eq(h.height, h0, "border does not change height");
eq(h.textWidth, tw0, "border does not change textWidth");
eq(h.textHeight, th0, "border does not change textHeight");
eq(h.text, "ABCDEFGHIJ", "border never touches the text");

// ---- 4. 与 background 正交：四种组合都能表达 -----------------------------
var k:TextField = new TextField();
k.border = true; k.background = false;
check(k.border && !k.background, "border-only state");
k.background = true; k.backgroundColor = 0xEEEEEE;
check(k.border && k.background, "border + background state");
eq(k.backgroundColor, 0xEEEEEE, "backgroundColor round-trip");
k.border = false;
check(!k.border && k.background, "background-only state");
k.background = false;
check(!k.border && !k.background, "neither state");

trace("stage94h ok");