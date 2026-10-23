// native-menu.as — flash.display.NativeMenu / NativeMenuItem + flash.desktop 图标族
// 的自校验示例。
//
// 跑法：
//   node src/index.ts examples/native-menu.as --run                      (纯 C，无窗口)
//   node src/index.ts examples/native-menu.as \
//        --manifest examples/window.build.example.json --run             (真窗口 + 真菜单栏)
//
// 断言全部对齐 adl 51.4.1 / macOS 的实测口径（探针与原始输出见 temp/deskprobe2/
// probe-ext.txt、probe2-ext.txt、probe3-log.txt），因此**纯 C 构建也必须通过**：
// 模型层（列表、错误号、拷贝语义、默认值）与后端无关，只有「原生菜单栏是否真的挂上」
// 取决于构建里有没有窗口后端。
//
// 覆盖面：
//   * 默认值：label="" name=null enabled=true checked=false isSeparator=false
//     keyEquivalent=null keyEquivalentModifiers=[15] mnemonicIndex=-1 data=null
//   * 构造：Icon 可实例化；InteractiveIcon/DockIcon/SystemTrayIcon 抛 #2012
//   * 列表：重复 addItem 静默忽略、addItemAt(已存在) #2004、removeItem(外来) #2006、
//     getItemAt 越界 #2006、getItemByName 认 name 不认 label
//   * 拷贝：items / bitmaps / keyEquivalentModifiers 的 getter 每次回新 Array
//   * DockIcon.bitmaps 赋值：width/height 取逐轴最大值，清空后沿用旧值（选图规则
//     本身只在有 Cocoa 的构建里可观测，钉在 unit: emit/DockIconImage）
//   * modifiers：只留 15..20、升序去重
//   * submenu：写进去后 submenu.parent 就是「拥有它的那个菜单」
//   * clone：深拷贝（item 不共享）、但 data 不复制
//   * 能力位：supportsMenu/supportsDockIcon 反映**后端**（无窗口后端即 false），
//     na.menu 恒非 null，na.autoExit 可读可写
import flash.display.BitmapData;
import flash.display.NativeMenu;
import flash.display.NativeMenuItem;
import flash.desktop.NativeApplication;
import flash.desktop.Icon;
import flash.desktop.InteractiveIcon;
import flash.desktop.DockIcon;
import flash.desktop.SystemTrayIcon;
import flash.events.Event;

var pass:int = 0;
var fails:Array = [];

function eq(label:String, got:*, want:*):void {
  if (String(got) == String(want)) { pass++; }
  else { fails.push(label + ": got " + got + ", want " + want); }
}

function throwsCode(label:String, fn:Function, code:int):void {
  try {
    fn();
    fails.push(label + ": no throw, want #" + code);
  } catch (e:Error) {
    if (e.errorID == code) { pass++; }
    else { fails.push(label + ": threw #" + e.errorID + " (" + e.message + "), want #" + code); }
  }
}

function count(a:Array):int { return a.length; }
function join(a:Array):String {
  var s:String = "";
  for (var i:int = 0; i < a.length; i++) { if (i > 0) s += ","; s += String(a[i]); }
  return s;
}

// ---- defaults ----
var it:NativeMenuItem = new NativeMenuItem("Hello");
eq("label default from ctor", it.label, "Hello");
eq("name default", it.name, null);
eq("enabled default", it.enabled, true);
eq("checked default", it.checked, false);
eq("isSeparator default", it.isSeparator, false);
eq("keyEquivalent default", it.keyEquivalent, null);
eq("modifiers default", join(it.keyEquivalentModifiers), "15");
eq("mnemonicIndex default", it.mnemonicIndex, -1);
eq("data default", it.data, null);
eq("menu default", it.menu, null);
eq("submenu default", it.submenu, null);
eq("toString", it.toString(),
   "[NativeMenuItem label=\"Hello\" keyEquivalent=null keyEquivalentChar=0 keyEquivalentModifiers={ 15 }]");
eq("separator ctor", new NativeMenuItem("", true).isSeparator, true);

// ---- modifiers: 只留 15..20，升序去重 ----
it.keyEquivalentModifiers = [18, 16, 16, 3, 99];
eq("modifiers filtered/sorted/deduped", join(it.keyEquivalentModifiers), "16,18");
it.keyEquivalentModifiers = [];
eq("modifiers [] empties", join(it.keyEquivalentModifiers), "");
eq("keyEquivalent '' reads back null", (function():String { it.keyEquivalent = ""; return String(it.keyEquivalent); })(), "null");

// ---- 拷贝语义 ----
var mods:Array = it.keyEquivalentModifiers;
mods.push(20);
eq("modifiers getter returns a copy", join(it.keyEquivalentModifiers), "");

// ---- 容器 ----
var m:NativeMenu = new NativeMenu();
var a:NativeMenuItem = new NativeMenuItem("One");
var b:NativeMenuItem = new NativeMenuItem("Two");
b.name = "two-name";
eq("numItems empty", m.numItems, 0);
eq("items empty", count(m.items), 0);
eq("parent empty", m.parent, null);
eq("addItem returns the item", m.addItem(a) === a, true);
m.addItem(a);                       // 实测：重复 addItem 是静默 no-op
eq("duplicate addItem is a no-op", m.numItems, 1);
throwsCode("addItem(null)", function():void { m.addItem(null); }, 2007);
m.addItemAt(b, 1);
eq("addItemAt appends at index", m.numItems, 2);
eq("order after addItemAt", m.getItemAt(0).label + "," + m.getItemAt(1).label, "One,Two");
throwsCode("addItemAt(existing)", function():void { m.addItemAt(a, 0); }, 2004);
throwsCode("addItemAt(99)", function():void { m.addItemAt(new NativeMenuItem("x"), 99); }, 2006);
throwsCode("addItemAt(-1)", function():void { m.addItemAt(new NativeMenuItem("x"), -1); }, 2006);
throwsCode("getItemAt(-1)", function():void { m.getItemAt(-1); }, 2006);
throwsCode("getItemAt(99)", function():void { m.getItemAt(99); }, 2006);
eq("getItemByName matches name", m.getItemByName("two-name") === b, true);
eq("getItemByName does NOT match label", m.getItemByName("One"), null);
eq("getItemByName(none)", m.getItemByName("nope"), null);
throwsCode("getItemByName(null)", function():void { m.getItemByName(null); }, 2007);
eq("getItemIndex", m.getItemIndex(b), 1);
eq("getItemIndex(foreign)", m.getItemIndex(new NativeMenuItem("f")), -1);
eq("containsItem", m.containsItem(b), true);
var foreign:NativeMenuItem = new NativeMenuItem("foreign");
throwsCode("removeItem(foreign)", function():void { m.removeItem(foreign); }, 2006);

// items getter 是拷贝；items setter 收 Array
var copy:Array = m.items;
copy.pop();
eq("items getter returns a copy", m.numItems, 2);
m.items = [a];
eq("items setter replaces", m.numItems + ":" + m.getItemAt(0).label, "1:One");
m.removeAllItems();
eq("removeAllItems", m.numItems, 0);

// ---- submenu / parent ----
var root:NativeMenu = new NativeMenu();
var sub:NativeMenu = new NativeMenu();
var leaf:NativeMenuItem = new NativeMenuItem("Leaf");
sub.addItem(leaf);
var subItem:NativeMenuItem = root.addSubmenu(sub, "Sub");
eq("addSubmenu returns the item", subItem.submenu === sub, true);
eq("submenu.parent is the owning menu", sub.parent === root, true);
eq("item.menu is the owning menu", leaf.menu === sub, true);
eq("addSubmenu(null) still makes an item", root.addSubmenu(null, "SubNull") !== null, true);
eq("root.parent is null", root.parent, null);

// ---- clone: 深拷贝，data 不复制 ----
a.data = { k: 1 };
var cloned:NativeMenu = root.clone();
eq("clone item count", cloned.numItems, root.numItems);
eq("clone shares no item", cloned.getItemAt(0) === root.getItemAt(0), false);
eq("item clone drops data", (function():NativeMenuItem { var c:NativeMenuItem = a.clone(); return c; })().data, null);

// ---- Icon 族 ----
eq("new Icon() is allowed", new Icon() !== null, true);
throwsCode("new Icon().bitmaps", function():void { var i:Icon = new Icon(); var x:Array = i.bitmaps; }, 1009);
throwsCode("new InteractiveIcon()", function():void { new InteractiveIcon(); }, 2012);
throwsCode("new DockIcon()", function():void { new DockIcon(); }, 2012);
throwsCode("new SystemTrayIcon()", function():void { new SystemTrayIcon(); }, 2012);
eq("SystemTrayIcon.MAX_TIP_LENGTH", SystemTrayIcon.MAX_TIP_LENGTH, 63);

var na:NativeApplication = NativeApplication.nativeApplication;
eq("na.icon is an Icon", (na.icon as Object) !== null, true);
eq("pristine dock bitmaps length", count((na.icon as DockIcon).bitmaps), 0);
// DockIcon.bitmaps 的「哪张上屏」是纯模型的选图规则（|max(w,h) - 128| 最小，
// 并列取更早的那张，见 TODO 阶段二百五十六）。纯 C 构建不上屏，但 setter 全路
// 仍然要跑通：赋值后 width/height 更新，清空后沿用旧值（adl 实测）。
var dockIcon:DockIcon = na.icon as DockIcon;
dockIcon.bitmaps = [new BitmapData(1, 1, true, 0xFFFF0000), new BitmapData(2, 2, true, 0xFF00FF00)];
eq("bitmaps assignment keeps both entries", count(dockIcon.bitmaps), 2);
eq("bitmaps assignment updates width/height", dockIcon.width + dockIcon.height, 4);
dockIcon.bitmaps = [];
eq("clearing bitmaps keeps the last width/height", dockIcon.width + dockIcon.height, 4);
eq("na.menu is never null", (na.menu as Object) !== null, true);
eq("autoExit default", na.autoExit, true);
na.autoExit = false;
eq("autoExit round-trip", na.autoExit, false);

// ---- 能力位自洽：报的能力位必须是后端真有的 ----
// 纯 C 构建没有窗口后端，因此 supportsMenu/supportsDockIcon 必须为 false——
// 报 true 会让 `if (supportsMenu)` 这类守卫变成静默 no-op。
eq("supportsMenu implies a window backend", NativeApplication.supportsMenu,
   NativeApplication.supportsDockIcon);
eq("supportsSystemTrayIcon is false on macOS", NativeApplication.supportsSystemTrayIcon, false);
eq("supportsStartAtLogin is false (no login-item backend)", NativeApplication.supportsStartAtLogin, false);

// ---- 安装一次菜单：模型永远可用；没有后端时也绝不能抛 ----
var bar:NativeMenu = new NativeMenu();
var fileMenu:NativeMenu = new NativeMenu();
var quit:NativeMenuItem = new NativeMenuItem("Quit");
var seen:int = 0;
quit.addEventListener(Event.SELECT, function (e:Event):void { seen++; });
fileMenu.addItem(quit);
bar.addSubmenu(fileMenu, "File");
try {
  na.menu = bar;
  pass++;
} catch (e:Error) {
  fails.push("na.menu = bar threw " + e.message);
}
eq("na.menu reads back the installed menu", na.menu === bar, true);

// SELECT 在本后端由原生点击驱动；这里只能确认监听器登记好了（真点击由
// examples 的窗口构建 + AX 驱动覆盖）。
quit.dispatchEvent(new Event(Event.SELECT));
eq("SELECT listener fires", seen, 1);

na.autoExit = true;

if (fails.length > 0) {
  for (var j:int = 0; j < fails.length; j++) trace("FAIL " + fails[j]);
  trace("native-menu: " + fails.length + " FAILED, " + pass + " passed");
} else {
  trace("native-menu: " + pass + " checks passed");
}