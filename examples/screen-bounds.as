// 阶段四百六十三: flash.display.Screen 的 AIR 空间矩形。
//
// AIR 在 Windows 上把 Screen.bounds/visibleBounds 报成物理像素（150% 桌面
// 3840x2560 / 3840x2488），而 Capabilities.screenResolution* 与 Stage.fullScreen*
// 仍是 DIP（2560x1707）——两套空间各归各（adl 51.4.1 实测 temp/screenpx/adl）。
// macOS 上 SDL 本来就报点，即 AIR 在那边的空间。本示例只钉与主机无关的结构
// 不变量（包含关系、对象同一性、getScreensForRectangle 的匹配空间）；物理像素
// 的具体数值由 unit: platform/DisplayMetrics 的形状钉 + adl A/B 证据守住，
// 因为 100% 缩放的机器上读数分不出两个空间。
import flash.display.Screen;
import flash.geom.Rectangle;
import flash.system.Capabilities;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var screens:Array = Screen.screens;
check(screens.length >= 1, "at least one screen");

var ms:Screen = Screen.mainScreen;
var b:Rectangle = ms.bounds;
var vb:Rectangle = ms.visibleBounds;
check(b.width > 0 && b.height > 0, "bounds non-empty");
check(vb.width > 0 && vb.height > 0, "visibleBounds non-empty");
check(vb.x >= b.x && vb.y >= b.y, "visibleBounds origin inside bounds");
check(vb.right <= b.right && vb.bottom <= b.bottom, "visibleBounds within bounds");

// AIR hands back the SAME Rectangle object on every read of one Screen, while
// the Screen wrapper itself is fresh on every access (both measured on adl).
check(ms.bounds === b, "bounds identity preserved");
check(ms.visibleBounds === vb, "visibleBounds identity preserved");
check(Screen.mainScreen !== Screen.mainScreen, "mainScreen wrapper is fresh");

// getScreensForRectangle matches against bounds in the SAME space Screen reports
// (physical on Windows): the full bounds rect matches, zero-area and far-away
// rects match nothing (half-open overlap rule, measured on adl).
check(Screen.getScreensForRectangle(b).length >= 1, "bounds rect matches a screen");
check(Screen.getScreensForRectangle(new Rectangle(b.x, b.y, 0, 0)).length == 0, "zero-area rect matches nothing");
check(Screen.getScreensForRectangle(new Rectangle(b.right + 100, b.bottom + 100, 50, 50)).length == 0, "far rect matches nothing");

check(Capabilities.screenResolutionX > 0 && Capabilities.screenResolutionY > 0, "capabilities resolution positive");

trace("screen-bounds: all checks passed");