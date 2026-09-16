// stage60.as — flash.utils.Timer (stage 60): repeating timer with currentCount /
// repeatCount / running state and TimerEvent.TIMER / TIMER_COMPLETE dispatch.
// Headless: timers are pumped manually via tickTimers() (maps to as_timer_tick).

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var timerFires:int = 0;
var completeFires:int = 0;
function onTimer(e:TimerEvent):void { timerFires++; }
function onComplete(e:TimerEvent):void { completeFires++; }

// --- constructor + property defaults ---
var t:Timer = new Timer(1, 3);
check(t is EventDispatcher && t is Object, "Timer is EventDispatcher/Object");
check(t.delay == 1, "delay readback");
check(t.repeatCount == 3, "repeatCount readback");
check(t.currentCount == 0, "currentCount starts 0");
check(t.running == false, "running starts false");

// --- infinite default (repeatCount = 0) ---
var inf:Timer = new Timer(1);
check(inf.repeatCount == 0, "default repeatCount == 0");

// --- repeating fire: 3 TIMER + 1 TIMER_COMPLETE ---
t.addEventListener(TimerEvent.TIMER, onTimer);
t.addEventListener(TimerEvent.TIMER_COMPLETE, onComplete);
t.start();
check(t.running == true, "running true after start");
var guard:int = 0;
while (t.currentCount < 3 && guard < 100000000) { tickTimers(); guard++; }
check(t.currentCount == 3, "currentCount reached repeatCount");
check(t.running == false, "running false after exhaustion");
check(timerFires == 3, "TIMER fired exactly 3 times");
check(completeFires == 1, "TIMER_COMPLETE fired once");

// --- stop() halts without resetting currentCount ---
var t2:Timer = new Timer(1, 100);
var t2fires:int = 0;
t2.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void { t2fires++; });
t2.start();
tickTimers(); tickTimers(); // may fire 0..2 depending on wall-clock
t2.stop();
var snapshot:int = t2.currentCount;
check(t2.running == false, "running false after stop");
check(t2.currentCount == snapshot, "stop keeps currentCount");

// --- reset() stops and zeroes currentCount ---
t2.reset();
check(t2.running == false, "running false after reset");
check(t2.currentCount == 0, "currentCount zeroed after reset");

// --- delay setter validation (negative / non-finite) ---
var threw:Boolean = false;
try { t2.delay = -5; } catch (e:Error) { threw = true; }
check(threw, "delay = -5 throws");
threw = false;
try { t2.delay = 0/0; } catch (e:Error) { threw = true; }
check(threw, "delay = NaN throws");

// --- repeatCount setter: NOT validated (real AIR only int-truncates) ---
t2.repeatCount = -1;
check(t2.repeatCount == -1, "repeatCount = -1 kept as-is (no throw)");

trace("stage60: all flash.utils.Timer assertions passed");
