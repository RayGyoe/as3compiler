// listener-mutation.as — 派发过程中增删监听器必须不影响「本次派发」（阶段二百零九）。
//
// AIR（AVM2）在一次派发开始时会**快照**该阶段要走的监听器列表，因此：
//   C1 监听器删掉自己      → 后面的监听器照样跑
//   C2 监听器删掉下一个    → 那个也照样跑
//   C3 派发中新增监听器    → 本次不跑，下一次才跑
//   C4 删掉自己再重新加回  → 本次各跑一次
// 以上四条都用 adl 51.4.1 实测过（temp/disprem）。
//
// 旧实现直接在 as_array 上原地 shift-down（删一个就左移、length--），而派发循环正
// 按 index 走这份数组 ⇒ 删掉自己会让循环**跳过紧随其后的那个监听器**。这条缺陷在
// 窗口关闭链上直接致命：应用侧 FixStageDpi.closeWindow 注册得比窗口自己的
// Event.CLOSE 处理器早，它一进来就 removeEventListener(CLOSE, 自己)，于是窗口自己的
// 清理函数（sutupWindow = null）永远不跑 —— 表现为「设置/资料库窗口关一次就再也开
// 不出来」（temp/nwreopen 复现，修前 closeCount=0、修后 1）。
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var d:EventDispatcher;

// C1: 删掉自己，后面的监听器仍要跑
var c1:Array = [];
var a1:Function;
d = new EventDispatcher();
a1 = function(e:Event):void { c1.push("A"); d.removeEventListener("x", a1); };
var b1:Function = function(e:Event):void { c1.push("B"); };
d.addEventListener("x", a1);
d.addEventListener("x", b1);
d.dispatchEvent(new Event("x"));
check(c1.join(",") == "A,B", "C1 a self-removing listener does not hide the next one (got " + c1.join(",") + ")");
check(d.hasEventListener("x") == true, "C1 the other listener is still registered");
c1 = [];
d.dispatchEvent(new Event("x"));
check(c1.join(",") == "B", "C1 the removed listener stays removed (got " + c1.join(",") + ")");

// C2: 删掉「下一个」—— 它已经在本次快照里，仍要跑
var c2:Array = [];
var b2:Function = function(e:Event):void { c2.push("B"); };
d = new EventDispatcher();
var a2:Function = function(e:Event):void { c2.push("A"); d.removeEventListener("x", b2); };
d.addEventListener("x", a2);
d.addEventListener("x", b2);
d.dispatchEvent(new Event("x"));
check(c2.join(",") == "A,B", "C2 removing the NEXT listener still runs it this time (got " + c2.join(",") + ")");
c2 = [];
d.dispatchEvent(new Event("x"));
check(c2.join(",") == "A", "C2 but not on the next dispatch (got " + c2.join(",") + ")");
check(d.hasEventListener("x") == true, "C2 the self-kept listener keeps the dispatcher registered");

// C3: 派发过程中新增 —— 本次不跑，下次跑
var c3:Array = [];
var c3f:Function = function(e:Event):void { c3.push("C"); };
d = new EventDispatcher();
var a3:Function = function(e:Event):void { c3.push("A"); d.addEventListener("x", c3f); };
d.addEventListener("x", a3);
d.dispatchEvent(new Event("x"));
check(c3.join(",") == "A", "C3 a listener added mid-dispatch waits for the next one (got " + c3.join(",") + ")");
d.dispatchEvent(new Event("x"));
check(c3.join(",") == "A,A,C", "C3 and runs (once) on the next dispatch (got " + c3.join(",") + ")");

// C4: 删掉自己再立刻加回 —— 本次 A、B 各一次
var c4:Array = [];
d = new EventDispatcher();
var a4:Function = function(e:Event):void {
  c4.push("A");
  d.removeEventListener("x", a4);
  d.addEventListener("x", a4);
};
var b4:Function = function(e:Event):void { c4.push("B"); };
d.addEventListener("x", a4);
d.addEventListener("x", b4);
d.dispatchEvent(new Event("x"));
check(c4.join(",") == "A,B", "C4 remove + re-add inside the handler runs A once and B once (got " + c4.join(",") + ")");

// C5（窗口关闭链的真实形状）：先注册的 A 删掉自己 + 删掉另一个类型，后注册的 B 仍要跑
var c5:Array = [];
d = new EventDispatcher();
var a5:Function = function(e:Event):void {
  c5.push("A");
  d.removeEventListener("close", a5);
  d.removeEventListener("activate", a5);   // 另一个 key 上的移除不能挡住同 key 的后续
};
var b5:Function = function(e:Event):void { c5.push("B"); };
d.addEventListener("close", a5);
d.addEventListener("activate", a5);
d.addEventListener("close", b5);
d.dispatchEvent(new Event("close"));
check(c5.join(",") == "A,B", "C5 the window CLOSE idiom reaches the SECOND close listener (got " + c5.join(",") + ")");
check(d.hasEventListener("close") == true, "C5 the app's own close handler is still registered");
check(d.hasEventListener("activate") == false, "C5 the removed activate handler is gone");

// C6: 不在派发中移除 —— 立刻生效、不留空洞
var c6:Array = [];
d = new EventDispatcher();
var a6:Function = function(e:Event):void { c6.push("A"); };
var b6:Function = function(e:Event):void { c6.push("B"); };
d.addEventListener("x", a6);
d.addEventListener("x", b6);
d.removeEventListener("x", a6);
check(d.hasEventListener("x") == true, "C6 one listener left");
d.dispatchEvent(new Event("x"));
check(c6.join(",") == "B", "C6 removal outside a dispatch takes effect at once (got " + c6.join(",") + ")");
d.removeEventListener("x", b6);
check(d.hasEventListener("x") == false, "C6 the emptied list reports no listener");

// C7: 反复「派发中自删」不能把列表越撑越大（墓碑必须在派发结束后清掉）
var c7:int = 0;
d = new EventDispatcher();
var a7:Function = function(e:Event):void { c7++; d.removeEventListener("x", a7); d.addEventListener("x", a7); };
d.addEventListener("x", a7);
for (var i:int = 0; i < 200; i++) d.dispatchEvent(new Event("x"));
check(c7 == 200, "C7 all 200 rounds ran the re-added listener (got " + c7 + ")");
check(d.hasEventListener("x") == true, "C7 still exactly registered");

// C8: 早退（stopImmediatePropagation）与墓碑共存
var c8:Array = [];
d = new EventDispatcher();
var a8:Function = function(e:Event):void { c8.push("A"); d.removeEventListener("x", a8); e.stopImmediatePropagation(); };
var b8:Function = function(e:Event):void { c8.push("B"); };
d.addEventListener("x", a8);
d.addEventListener("x", b8);
d.dispatchEvent(new Event("x"));
check(c8.join(",") == "A", "C8 stopImmediatePropagation still stops the rest (got " + c8.join(",") + ")");
c8 = [];
d.dispatchEvent(new Event("x"));
check(c8.join(",") == "B", "C8 the tombstoned entry does not swallow B afterwards (got " + c8.join(",") + ")");

trace("listener-mutation: all checks passed");