// context-menu.as — flash.ui.ContextMenu / ContextMenuItem on top of flash.display.NativeMenu
// (阶段二百八十九).
//
// Pure API surface: no window, no popup. The right-click POPUP itself needs a real
// window and is verified by hand (temp/ctxmenu); what is pinned here is the object
// model a program sees before a menu ever opens, every line of it measured on
// adl 51.4.1 with the same program (temp/ctxprobe/api/Api*.as -> out*.txt):
//
//   * ContextMenu IS a NativeMenu, and its items live in the INHERITED list --
//     `items.length` counts them and `items[i]` is the very object added, so
//     `customItems` is the synonym it is documented to be;
//   * getItemByName NEVER finds anything on a ContextMenu (a ContextMenuItem in a
//     plain NativeMenu IS found, so the rule is the menu's, not the item's);
//   * setItemIndex always throws RangeError #2006, whatever the index;
//   * addItem/addItemAt do NOT de-duplicate (A,B,A), unlike NativeMenu's #2004;
//   * getItemAt out of range is RangeError #2006, display(null, ...) is #2007.
import flash.display.NativeMenu;
import flash.display.NativeMenuItem;
import flash.ui.ContextMenu;
import flash.ui.ContextMenuItem;

function say(s:String):void { trace(s); }

var menu:ContextMenu = new ContextMenu();
say("isNativeMenu=" + (menu is NativeMenu));            // true: ContextMenu extends NativeMenu
say("isDispatcher=" + (menu is flash.events.EventDispatcher));
say("isSupported=" + ContextMenu.isSupported);           // static, true on a desktop runtime
say("emptyNumItems=" + menu.numItems);                   // 0
say("nativeItems=" + menu.items.length);                 // 0

var a:ContextMenuItem = new ContextMenuItem("Alpha");
var b:ContextMenuItem = new ContextMenuItem("Beta");
var c:ContextMenuItem = new ContextMenuItem("Gamma", true);   // separatorBefore
say("defaults=" + a.enabled + "," + a.visible + "," + a.separatorBefore + "," + a.checked);
say("sepBeforeC=" + c.separatorBefore);
say("isNativeMenuItem=" + (a is NativeMenuItem));         // true

a.name = "alphaItem";
say("label=" + a.label + " name=" + a.name);

menu.addItem(a);
menu.addItem(b);
menu.addItem(c);
say("numItems=" + menu.numItems);
say("itemsCoherent=" + menu.items.length + "," + (menu.items[0] == a));
say("customItemsCoherent=" + menu.customItems.length + "," + (menu.customItems[0] == a));
say("getItemIndex(a)=" + menu.getItemIndex(a));           // 0
say("getItemIndex(missing)=" + menu.getItemIndex(new ContextMenuItem("nope")));  // -1
say("getItemByName(alphaItem)=" + (menu.getItemByName("alphaItem") != null));    // false

menu.removeItem(b);
say("afterRemove=" + menu.numItems + " idxC=" + menu.getItemIndex(c));           // 2, 1

// No duplicate check on a ContextMenu (measured: A,B,A).
menu.addItem(a);
say("afterDupAdd=" + menu.numItems + " order="
    + menu.getItemAt(0).label + "," + menu.getItemAt(1).label + "," + menu.getItemAt(2).label);
menu.removeItemAt(2);

menu.addItemAt(b, 1);
say("afterAddAt=" + menu.numItems + " idxC=" + menu.getItemIndex(c));            // 3, 2

// setItemIndex is not supported by AIR's ContextMenu: every index throws #2006.
try {
  menu.setItemIndex(c, 0);
  say("setIndex ok");
} catch (e:Error) {
  say("setIndex threw " + e.errorID);                                            // 2006
}

// Out-of-range reads throw too.
try {
  menu.getItemAt(99);
  say("getItemAt99 ok");
} catch (e2:Error) {
  say("getItemAt99 threw " + e2.errorID);                                        // 2006
}

// display() needs a stage; AIR's message is a parameter error, not a null deref.
try {
  menu.display(null, 0, 0);
  say("display(null) ok");
} catch (e3:Error) {
  say("display(null) threw " + e3.errorID + "|" + e3.message);                   // 2007|...#2007: Parameter stage must be non-null.
}

var mutable:ContextMenuItem = new ContextMenuItem("Mutable");
mutable.enabled = false;
mutable.visible = false;
say("mutated=" + mutable.enabled + "," + mutable.visible);
mutable.enabled = true;
mutable.visible = true;
say("restored=" + mutable.enabled + "," + mutable.visible);

menu.removeAllItems();
say("afterRemoveAll=" + menu.numItems);                                          // 0

// A standalone NativeMenu DOES find items by name -- the contrast with the
// ContextMenu above is the whole point of the two behaviours.
var nm:NativeMenu = new NativeMenu();
var nmItem:NativeMenuItem = new NativeMenuItem("Native");
nmItem.name = "nativeItem";
nm.addItem(nmItem);
say("nmItems=" + nm.items.length + " nmByName=" + (nm.getItemByName("nativeItem") == nmItem));
say("nmIsMenuItem=" + (nmItem is NativeMenuItem));