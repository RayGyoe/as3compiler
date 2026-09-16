// stage35.as — flash.events interactive: hit test + inside-out mouse dispatch.

var stage:Stage = new Stage();

// --- hit test picks the deepest child, then bubbles to ancestors ---
var outer:Sprite = new Sprite();
outer.x = 0; outer.y = 0; outer.width = 200; outer.height = 200;
var inner:Sprite = new Sprite();
inner.x = 50; inner.y = 50; inner.width = 100; inner.height = 100;
stage.addChild(outer);
outer.addChild(inner);

inner.addEventListener("click", function(e:MouseEvent):void { trace("inner", e.localX, e.localY); });
outer.addEventListener("click", function(e:MouseEvent):void { trace("outer", e.target == inner); });
stage.dispatchMouse(100, 100, "click");
// expect: inner 50 50, then outer true (target is inner, bubbled to outer)

// --- mouseChildren=false absorbs the child's click (target becomes parent) ---
var p:Sprite = new Sprite();
p.x = 0; p.y = 0; p.width = 100; p.height = 100;
p.mouseChildren = false;
var child:Sprite = new Sprite();
child.x = 10; child.y = 10; child.width = 50; child.height = 50;
p.addChild(child);
child.addEventListener("click", function(e:MouseEvent):void { trace("child SHOULD NOT fire"); });
p.addEventListener("click", function(e:MouseEvent):void { trace("parent absorbs, target is p:", e.target == p); });
stage.addChild(p);
stage.dispatchMouse(20, 20, "click");
// expect: parent absorbs, target is p: true (no "child" line)

// --- visible=false is skipped by the hit test (exclusive coordinates) ---
var hidden:Sprite = new Sprite();
hidden.x = 500; hidden.y = 500; hidden.width = 10; hidden.height = 10;
hidden.visible = false;
hidden.addEventListener("click", function(e:MouseEvent):void { trace("hidden SHOULD NOT fire"); });
stage.addChild(hidden);
stage.dispatchMouse(505, 505, "click");
// expect: no output (hidden is invisible, nothing else at 505,505)

// --- MouseEvent / KeyboardEvent / FocusEvent constructors + fields ---
var me:MouseEvent = new MouseEvent("click", true, false, 10, 20, null, true, false, true, false, 0);
trace("mouseevent:", me.type == "click" && me.localX == 10 && me.localY == 20 && me.ctrlKey && me.shiftKey);

var ke:KeyboardEvent = new KeyboardEvent("keyDown", true, false, 65, 65);
trace("keyboardevent:", ke.type == "keyDown" && ke.keyCode == 65 && ke.charCode == 65);

var fe:FocusEvent = new FocusEvent("focusIn", true, false, null, false, 9);
trace("focusevent:", fe.type == "focusIn" && fe.keyCode == 9);

trace("MouseEvent.CLICK:", MouseEvent.CLICK);            // click
trace("KeyboardEvent.KEY_DOWN:", KeyboardEvent.KEY_DOWN); // keyDown
trace("FocusEvent.FOCUS_IN:", FocusEvent.FOCUS_IN);       // focusIn

// --- InteractiveObject default flags ---
var io:Sprite = new Sprite();
trace("io defaults:", io.mouseEnabled && io.mouseChildren && !io.doubleClickEnabled && io.tabIndex == -1 && !io.hasFocus);
