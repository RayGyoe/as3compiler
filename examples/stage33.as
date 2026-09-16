// stage33.as — flash.events core: Event / EventDispatcher / three-phase dispatch.

var d:EventDispatcher = new EventDispatcher();
d.addEventListener("foo", function(e:Event):void { trace("L1", e.type); });
d.addEventListener("foo", function(e:Event):void { trace("L2", e.type); });

trace("has foo:", d.hasEventListener("foo"));   // true
trace("has bar:", d.hasEventListener("bar"));   // false
trace("willTrigger foo:", d.willTrigger("foo")); // true

var evt:Event = new Event("foo", false, false);
var ok:Boolean = d.dispatchEvent(evt);
trace("dispatched:", ok);                       // true
trace("event str:", evt.toString());             // [Event type="foo" bubbles=false cancelable=false]
trace("target is d:", evt.target == d);          // true

trace("Event.ENTER_FRAME:", Event.ENTER_FRAME);  // enterFrame

// stopPropagation does NOT stop the remaining listeners on the SAME target.
var d2:EventDispatcher = new EventDispatcher();
d2.addEventListener("x", function(e:Event):void { trace("first"); e.stopPropagation(); });
d2.addEventListener("x", function(e:Event):void { trace("second"); });
d2.dispatchEvent(new Event("x"));                // first, second

// stopImmediatePropagation DOES stop the remaining listeners.
var d3:EventDispatcher = new EventDispatcher();
d3.addEventListener("y", function(e:Event):void { trace("a"); e.stopImmediatePropagation(); });
d3.addEventListener("y", function(e:Event):void { trace("b"); });
d3.dispatchEvent(new Event("y"));                // a only

// removeEventListener removes a specific listener (no "z fired" should print).
var d4:EventDispatcher = new EventDispatcher();
var f:Function = function(e:Event):void { trace("z fired"); };
d4.addEventListener("z", f);
d4.removeEventListener("z", f);
d4.dispatchEvent(new Event("z"));
trace("remove ok (no z fired above)");

// clone copies type/bubbles/cancelable.
var e1:Event = new Event("copy", true, true);
var e2:Event = e1.clone();
trace("clone ok:", e2.type == "copy" && e2.bubbles && e2.cancelable); // true

// bubbles=true but no parent chain in this stage -> only target phase runs.
var d5:EventDispatcher = new EventDispatcher();
d5.addEventListener("b", function(e:Event):void { trace("bubble", e.eventPhase); });
d5.dispatchEvent(new Event("b", true, false));     // bubble 2 (AT_TARGET)
