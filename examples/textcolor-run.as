// textcolor-run.as — TextField.textColor 覆盖全段 run 颜色（阶段四百三十二，G48）。
// AIR 契约（adl 51.4.1，temp/g48）：textColor setter 等价于对全段施加 color-only
// 格式——setTextFormat(红) 后 textColor=蓝 ⇒ 渲染蓝且 getTextFormat().color=蓝；
// 反序则后写的 setTextFormat 生效。旧实现「有 run 时 run 优先」让主题切换后文字
// 停在旧调色板（hymn-demo 86/86 节点）。本例逐像素钉住 AIR 行为。
import flash.display.BitmapData;
import flash.text.TextField;
import flash.text.TextFormat;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function hex(v:uint):String { var s:String = v.toString(16).toUpperCase(); while (s.length < 6) s = "0" + s; return "0x" + s; }
function ink(tf:TextField):uint {
  var b:BitmapData = new BitmapData(Math.ceil(tf.width), Math.ceil(tf.height), false, 0xFFFFFF);
  b.draw(tf);
  var best:uint = 0xFFFFFF; var bestD:int = -1;
  for (var y:int = 0; y < b.height; y++) for (var x:int = 0; x < b.width; x++) {
    var p:uint = b.getPixel(x, y);
    var r:int = (p >> 16) & 0xFF, g:int = (p >> 8) & 0xFF, bl:int = p & 0xFF;
    var d:int = (255 - r) + (255 - g) + (255 - bl);
    if (d > bestD) { bestD = d; best = p; }
  }
  return best;
}
function mk():TextField {
  var tf:TextField = new TextField();
  tf.text = "MMMM"; tf.width = 200; tf.height = 60;
  var f:TextFormat = new TextFormat(); f.size = 40; f.font = "Arial"; f.bold = true;
  tf.setTextFormat(f);
  return tf;
}

// A: 先红 run 再 textColor=蓝 ⇒ 蓝（覆盖 run），getTextFormat 也读蓝。
var a:TextField = mk();
var red:TextFormat = new TextFormat(); red.color = 0xFF0000;
a.setTextFormat(red);
a.textColor = 0x0000FF;
check(ink(a) == 0x0000FF, "A textColor overrides red run, ink " + hex(ink(a)));
check((a.getTextFormat().color as uint) == 0x0000FF, "A getTextFormat().color reflects textColor");

// B: 先 textColor=蓝 再 setTextFormat(红) ⇒ 后写的红生效。
var b:TextField = mk();
b.textColor = 0x0000FF;
var red2:TextFormat = new TextFormat(); red2.color = 0xFF0000;
b.setTextFormat(red2);
check(ink(b) == 0xFF0000, "B later setTextFormat wins, ink " + hex(ink(b)));

// C: 只 setTextFormat(红) ⇒ 红。
var c:TextField = mk();
var red3:TextFormat = new TextFormat(); red3.color = 0xFF0000;
c.setTextFormat(red3);
check(ink(c) == 0xFF0000, "C run-only red, ink " + hex(ink(c)));

// D: 只 textColor=蓝 ⇒ 蓝。
var d:TextField = mk();
d.textColor = 0x0000FF;
check(ink(d) == 0x0000FF, "D textColor-only blue, ink " + hex(ink(d)));

// E: textColor 覆盖后保留 run 的字号（merge 不丢 size）。
var e:TextField = mk();
var red4:TextFormat = new TextFormat(); red4.color = 0xFF0000;
e.setTextFormat(red4);
e.textColor = 0x0000FF;
check((e.getTextFormat().size as Number) == 40, "E textColor merge keeps run size 40");

trace("PASS textcolor-run");