// pointer-per-stage.as — 指针态按 Stage 隔离（阶段二百零七）。
//
// AIR 里每个 Stage 各有**一份**指针（一个 NativeWindow 一个 Stage），所以往 B 的舞台里灌鼠标
// 事件，绝不能挪动 A 的 mouseX/mouseY，也不能让 A 的按钮悬停。旧实现把这几个坐标放在进程级
// static 里，于是「鼠标在别的窗口里动一下，本窗口的按钮就亮起来、mouseX/mouseY 跟着别的窗口
// 的客户端坐标走」（实测现场 temp/mouse2w：双窗口 + 真实指针 + Stage.dispatchMouse 两条臂）。
//
// 这是纯 C（没有窗口后端）也能跑的示例：两个 Stage 都用 `new Stage()` 拿（本运行时的测试钩子），
// 事件用 Stage.dispatchMouse(x, y, type) 灌进去，按钮态直接看 up/over 两个状态的宽度差。
// 断言顺序刻意「先反后正」：修好之前第一条（反例）就会红。
import flash.display.Sprite;
import flash.display.SimpleButton;
import flash.display.Stage;

var pass:int = 0;
var fails:Array = [];

function eq(label:String, got:*, want:*):void {
  if (String(got) == String(want)) { pass++; }
  else { fails.push(label + " (got " + got + ", want " + want + ")"); }
}

// up 态 40x20、over 态 80x40：按钮的 width 直接暴露它现在显示的是哪个状态。
var up:Sprite = new Sprite();
up.graphics.beginFill(0x9aa0a6);
up.graphics.drawRect(0, 0, 40, 20);
up.graphics.endFill();
var over:Sprite = new Sprite();
over.graphics.beginFill(0xff2d2d);
over.graphics.drawRect(0, 0, 80, 40);
over.graphics.endFill();
// 命中区固定 80x40：状态切换不改变"哪里算按钮上"，只改画出来的那个状态。
var hit:Sprite = new Sprite();
hit.graphics.beginFill(0x000000);
hit.graphics.drawRect(0, 0, 80, 40);
hit.graphics.endFill();
var btn:SimpleButton = new SimpleButton(up, over, up, hit);
btn.x = 10;
btn.y = 10;

var a:Stage = new Stage();
var b:Stage = new Stage();
a.addChild(btn);

// ① 还没人指过：两个 Stage 都没有指针，按钮保持 up（离屏就是 up，AIR 亦然）。
eq("no pointer yet -> up state", btn.width, 40);
eq("a stage nobody pointed at reports mouse 0,0", a.mouseX + "," + a.mouseY, "0,0");

// ② 反例：往 b 的舞台灌一个**落在 a 的按钮上**的坐标 —— a 必须一点动静都没有。
b.dispatchMouse(20, 20, "mouseMove");
eq("a pointer on another stage does not hover this stage's button", btn.width, 40);
eq("...nor move this stage's pointer", a.mouseX + "," + a.mouseY, "0,0");
eq("...while that stage keeps its own", b.mouseX + "," + b.mouseY, "20,20");

// ③ 正例（同一份代码真的会动）：灌给 a 自己。
a.dispatchMouse(20, 20, "mouseMove");
eq("a pointer on this stage hovers the button", btn.width, 80);
eq("...and this stage reports it", a.mouseX + "," + a.mouseY, "20,20");

// ④ b 再动：a 的悬停态保持不变（a 自己的指针没动，AIR 也是这样），只是不再跟着 b 走。
b.dispatchMouse(200, 150, "mouseMove");
eq("moving the pointer on the other stage leaves this stage hovered", btn.width, 80);
eq("...and its coordinates untouched", a.mouseX + "," + a.mouseY, "20,20");
eq("...while that stage follows its own pointer", b.mouseX + "," + b.mouseY, "200,150");

// ⑤ a 的指针移出按钮：回 up。
a.dispatchMouse(5, 5, "mouseMove");
eq("moving this stage's pointer off the button rolls it back to up", btn.width, 40);

if (fails.length == 0) {
  trace("pointer-per-stage: " + pass + " checks passed");
} else {
  trace("pointer-per-stage: " + pass + " passed, " + fails.length + " FAILED");
  for (var i:int = 0; i < fails.length; i++) trace("FAIL " + fails[i]);
}
