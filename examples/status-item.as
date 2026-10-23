// status-item.as — flash.desktop.SystemTrayIcon behind a real macOS NSStatusItem.
//
// 跑法（必须带清单，清单里写着 features: ["tray"]）：
//   node src/index.ts examples/status-item.as --manifest examples/status-item.build.json --run
//
// 这是**增强**通道，不是 AIR 面：实测 `adl 51.4.1` / macOS 上
// `NativeApplication.supportsSystemTrayIcon` 为 `false`、`new SystemTrayIcon()` 抛
// `#2012`，即 AIR 在这台机器上压根没有菜单栏状态项。所以同一份源码**不带**这个
// 开关构建时必须照旧抛 `#2012`（钉在 unit: emit/SystemTrayIcon），带开关才真的
// 拿到一个 NSStatusItem —— 默认产物与现状同构，这是 AGENTS §1.5 的硬要求。
//
// 覆盖面：
//   * 能力位：supportsSystemTrayIcon 由**后端**回答（这条通道存在才为 true）
//   * 构造：SystemTrayIcon 可实例化，且 is Icon / is InteractiveIcon /
//     is EventDispatcher（Icon 的父类是 EventDispatcher，实测口径）
//   * 默认值：tooltip=null、bitmaps 为空数组、menu=null
//   * bitmaps：width/height 取逐轴最大值（与 DockIcon 同一条继承链规则）
//   * tooltip：原样往返（不按 MAX_TIP_LENGTH 截断，那是 Windows 的常量）
//   * menu：赋值后读回同一个对象，列表操作照常
//   * 监听：addEventListener(MouseEvent.CLICK) 能挂上（真实派发在带窗口的构建里）
import flash.display.BitmapData;
import flash.display.NativeMenu;
import flash.display.NativeMenuItem;
import flash.desktop.Icon;
import flash.desktop.InteractiveIcon;
import flash.desktop.NativeApplication;
import flash.desktop.SystemTrayIcon;
import flash.events.Event;
import flash.events.EventDispatcher;
import flash.events.MouseEvent;
import flash.utils.getQualifiedSuperclassName;

var pass:int = 0;
var fails:Array = [];
var clicks:int = 0;

function onClick(e:Event):void { clicks = clicks + 1; }

function ok(cond:Boolean, what:String):void {
  if (cond) { pass++; trace("ok   " + what); }
  else { fails.push(what); trace("FAIL " + what); }
}

// The feature switch has to be visible from AS3: a capability bit that lies would
// turn `if (supportsSystemTrayIcon)` into a silent no-op.
ok(NativeApplication.supportsSystemTrayIcon == true,
   "supportsSystemTrayIcon is true in a --features tray build");
ok(NativeApplication.supportsDockIcon == true,
   "the Dock is unaffected (still true)");

// Icon's superclass: measured, getQualifiedSuperclassName(Icon) is EventDispatcher.
// Getting this wrong is not cosmetic -- an icon could not dispatch anything.
ok(getQualifiedSuperclassName(Icon) == "flash.events::EventDispatcher",
   "Icon extends EventDispatcher");
ok(getQualifiedSuperclassName(SystemTrayIcon) == "flash.desktop::InteractiveIcon",
   "SystemTrayIcon extends InteractiveIcon");

var tray:SystemTrayIcon = null;
try {
  tray = new SystemTrayIcon();
  ok(true, "new SystemTrayIcon() constructs (no #2012 when the switch is on)");
} catch (e:Error) {
  ok(false, "new SystemTrayIcon() threw " + e.errorID);
}

ok(tray != null, "the tray icon exists");
ok(tray is SystemTrayIcon && tray is InteractiveIcon && tray is Icon,
   "the instance walks the Icon chain");
ok(tray is EventDispatcher, "the instance can dispatch (Icon's base)");
ok(tray.tooltip == null, "tooltip starts null");
ok(tray.menu == null, "menu starts null");
ok(tray.bitmaps.length == 0, "bitmaps starts empty");
ok(SystemTrayIcon.MAX_TIP_LENGTH == 63, "MAX_TIP_LENGTH is AIR's 63");

// width/height are the per-axis MAXIMUM over the assigned bitmaps (the same rule
// DockIcon follows -- it lives in InteractiveIcon_set_bitmaps).
var small:BitmapData = new BitmapData(16, 16, true, 0xFF11AA33);
var wide:BitmapData = new BitmapData(22, 20, true, 0xFFAA3311);
tray.bitmaps = [small, wide];
ok(tray.bitmaps.length == 2, "bitmaps round-trips");
ok(tray.width == 22 && tray.height == 20, "width/height are the per-axis maximum (22x20)");

// A tooltip longer than MAX_TIP_LENGTH is stored verbatim: MAX_TIP_LENGTH is AIR's
// WINDOWS constant and there is no macOS behaviour to inherit a truncation rule
// from, so nothing is silently dropped.
var longTip:String = "0123456789012345678901234567890123456789012345678901234567890123456789";
tray.tooltip = longTip;
ok(tray.tooltip == longTip, "tooltip round-trips verbatim (no silent truncation)");
tray.tooltip = "Prune";
ok(tray.tooltip == "Prune", "tooltip reassigns");
tray.tooltip = null;
ok(tray.tooltip == null, "tooltip = null clears");

var menu:NativeMenu = new NativeMenu();
var i1:NativeMenuItem = new NativeMenuItem("Open");
var i2:NativeMenuItem = new NativeMenuItem("Quit");
menu.addItem(i1);
menu.addItem(i2);
tray.menu = menu;
ok(tray.menu == menu, "menu reads back the assigned object");
ok(tray.menu.numItems == 2, "the tray menu keeps its items");
ok(tray.menu.getItemAt(0) == i1, "item 0 is the one that was added first");

// The listener path: a real click over a window-bearing build dispatches
// ScreenMouseEvent; here the registration itself is what must not fail.
tray.addEventListener(MouseEvent.CLICK, onClick);
ok(tray.hasEventListener(MouseEvent.CLICK) == true, "addEventListener works on the tray icon");
tray.removeEventListener(MouseEvent.CLICK, onClick);
ok(tray.hasEventListener(MouseEvent.CLICK) == false, "removeEventListener works too");
ok(clicks == 0, "no synthetic click is ever invented");

if (fails.length == 0) {
  trace("status-item: " + pass + " checks passed");
} else {
  trace("status-item: " + pass + " passed, " + fails.length + " FAILED");
  for (var k:int = 0; k < fails.length; k++) trace("  failed: " + fails[k]);
}