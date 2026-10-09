// stage94j.as — 阶段九十四·十一：MouseEvent.DOUBLE_CLICK 的派发语义。
//
// 触发：TODO.md 遗留行的「MouseEvent.DOUBLE_CLICK 从不派发」（阶段九十四·七 登记）。
// 全部按 AGENTS.md §1.5 以 adl 51.4.1 实测为准（证据台 temp/editprobe/src/Ed9.as +
// drive_ed9.py，逐事件输出在 temp/editprobe/adl_ed9.txt；本编译器对照 aot_ed9.txt
// 逐行一致）。
//
// 关键实测口径（本示例逐条钉住；窗口路径的「键入时刻门控」另见 test.ts 的
// [doubleclick] 源码钉子，headless 无窗口跑不到）：
//   * MouseEvent.DOUBLE_CLICK == "doubleClick"（与 CLICK 是不同的 type）。
//   * 一次双击 = down,up,click, down,up,doubleClick —— 第二次 click **被替换**为
//     doubleClick（不是追加）；三击 = click,doubleClick,click（clickCount==3 又变回
//     普通 click）。窗口路径由 glue 的 e.button.clicks==2 打保留类型、AS3 侧按命中
//     目标的 doubleClickEnabled 决议，见 vendor/window_glue.cc + emit.ts。
//   * 门控落在**命中目标自身**的 doubleClickEnabled 上：祖先为 true 不顶用，目标为
//     false 时第二次仍是普通 click。
//   * doubleClick 事件 bubbles=true cancelable=false，可冒泡到祖先监听者。
import flash.display.*;
import flash.events.MouseEvent;

function check(cond:Boolean, msg:String):void {
	if (!cond) throw new Error("FAIL: " + msg);
}

// ---- A. 常量与属性默认/读写（== adl_ed9.txt DEFAULTS 行） ----
check(MouseEvent.DOUBLE_CLICK == "doubleClick", "DOUBLE_CLICK constant is \"doubleClick\"");
check(MouseEvent.DOUBLE_CLICK != MouseEvent.CLICK, "DOUBLE_CLICK differs from CLICK");

var s:Sprite = new Sprite();
check(!s.doubleClickEnabled, "doubleClickEnabled defaults to false");
s.doubleClickEnabled = true;
check(s.doubleClickEnabled, "doubleClickEnabled reads back what was set");
s.doubleClickEnabled = false;
check(!s.doubleClickEnabled, "doubleClickEnabled can be turned off again");

// InteractiveObject 拥有该属性，TextField 同源默认 false。
var io:InteractiveObject = new Sprite();
check(!io.doubleClickEnabled, "the flag lives on InteractiveObject");
var tf:TextField = new TextField();
check(!tf.doubleClickEnabled, "a TextField also defaults it to false");

// ---- B. 冒泡 + 相位 + target/currentTarget（== adl_ed9.txt B 段） ----
var parent:Sprite = new Sprite();
var child:Sprite = new Sprite();
child.doubleClickEnabled = true;
parent.addChild(child);

var seen:int = 0;
var sawType:String = null;
var sawTarget:Object = null;
var sawCur:Object = null;
var sawPhase:int = 0;
var sawBubbles:Boolean = false;
var sawCancelable:Boolean = true;
parent.addEventListener(MouseEvent.DOUBLE_CLICK, function(e:MouseEvent):void {
	seen++;
	sawType = e.type;
	sawTarget = e.target;
	sawCur = e.currentTarget;
	sawPhase = e.eventPhase;
	sawBubbles = e.bubbles;
	sawCancelable = e.cancelable;
});

// 与运行时的构造口径一致：bubbles=true, cancelable=false。
var ev:MouseEvent = new MouseEvent(MouseEvent.DOUBLE_CLICK, true, false, 25, 25);
child.dispatchEvent(ev);
check(seen == 1, "a doubleClick listener on the parent receives the bubbled event");
check(sawType == "doubleClick", "the delivered type is doubleClick");
check(sawTarget == child, "target is the dispatching object");
check(sawCur == parent, "currentTarget is the listener's owner");
check(sawPhase == 3, "eventPhase is BUBBLING at the ancestor");
check(sawBubbles, "doubleClick bubbles");
check(!sawCancelable, "doubleClick is not cancelable");

// ---- C. 与 CLICK 互不串台 ----
var clicks:int = 0;
parent.addEventListener(MouseEvent.CLICK, function(e:MouseEvent):void { clicks++; });
child.dispatchEvent(new MouseEvent(MouseEvent.DOUBLE_CLICK, true, false));
check(clicks == 0, "a doubleClick does not fire CLICK listeners");
check(seen == 2, "the second doubleClick is delivered");

trace("stage94j ok");