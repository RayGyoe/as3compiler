// statusitem_glue.cc — the macOS menu-bar status item behind flash.desktop.SystemTrayIcon.
//
// This is an ENHANCEMENT channel, not part of the AIR surface: measured on adl
// 51.4.1 / macOS, `NativeApplication.supportsSystemTrayIcon` is false and
// `new SystemTrayIcon()` throws #2012, i.e. AIR has no menu-bar item at all on
// this platform. The generated C only calls into this file when the build was
// made with `--features tray` (ASC_HAS_TRAY), so a default build links none of it.
//
// It lives in its own translation unit rather than inside window_glue.cc for one
// practical reason: it shares nothing with the window/menu glue except the
// flattened `sk_menu` model, so the whole Cocoa status-item channel can be read —
// or dropped — as one piece.
//
// Plain C++ on purpose (objc runtime messaging rather than .mm), like
// window_glue.cc: the same file also has to compile on backends with no Cocoa at
// all, where every entry point is an inert definition.

#include <cstdio>
#include <cstdlib>
#include <cstring>

// The flattened menu model, byte-identical to the typedefs in window_glue.cc and
// to the `sk_menu`/`sk_menu_item` structs in the generated C preamble. Duplicated
// rather than shared because the two glue files are independent compilation units
// with no common header: the boundary between them is C, not a C++ header.
typedef struct sk_menu_item_t {
  int kind; const char* label; int enabled; int checked; const char* key;
  int mods; int submenu; int tag;
} sk_menu_item_t;
typedef struct sk_menu_t { const char* title; int first; int count; } sk_menu_t;

extern "C" {

// Up to SK_TRAY_MAX_REPS renderings of the SAME icon at different pixel densities,
// each as straight ARGB rows (BitmapData.pixels verbatim); n <= 0 clears the image.
// One image, several representations: the menu bar is 22pt, so a 22px-tall bitmap is
// the 1x rep and a 44px one the 2x rep, and AppKit then draws the right one on
// whichever display the item is on. Passing only the 2x bitmap makes a 1x display
// downscale it -- at a 15pt glyph that averages a 1.5pt stroke into haze.
#define SK_TRAY_MAX_REPS 4
void sk_tray_set_images(const void* const* argbs, const int* ws, const int* hs, int n);
void sk_tray_set_tooltip(const char* text);
int sk_tray_set_menu(const sk_menu_t* menus, int nmenus, const sk_menu_item_t* items, int nitems, int root, void (*cb)(int));
// kind: 0 = left click, 1 = right click. mods bits: 1 command, 2 control, 4 option,
// 8 shift. Coordinates are AS3 screen points (top-left origin, points).
void sk_tray_set_callback(void (*cb)(int kind, double sx, double sy, int mods));

} // extern "C"

#if defined(__APPLE__)

#include <objc/message.h>
#include <objc/runtime.h>

// AppKit's NSPoint/NSRect without Cocoa.h: both are plain aggregates of doubles,
// so a locally declared struct of the same shape receives what objc_msgSend
// returns (window_glue.cc does exactly this with its own sk_nsrect).
typedef struct { double x, y; } sk_nspoint;
typedef struct { sk_nspoint origin; sk_nspoint size; } sk_nsrect;

extern "C" {

extern id NSApp;

// Everything the AS3 side handed over. The pixel rows and the tooltip are COPIED:
// both come from GC-managed AS3 objects, and the status item may only be created
// several frames later (once the application object exists), long after those
// objects could have been collected.
static void* g_tray_item = NULL;         // NSStatusItem (retained for the process)
static void* g_tray_image = NULL;        // NSImage currently on the button
// Our own copies of the ARGB rows, one per representation (see sk_tray_set_images).
static unsigned* g_tray_rep_px[SK_TRAY_MAX_REPS];
static int g_tray_rep_w[SK_TRAY_MAX_REPS], g_tray_rep_h[SK_TRAY_MAX_REPS];
static int g_tray_nreps = 0;
static char g_tray_tip[1024];
static int g_tray_have_tip = 0;
static void* g_tray_nsmenu = NULL;       // NSMenu the button pops
static void (*g_tray_cb)(int, double, double, int) = NULL;
static void (*g_tray_menu_cb)(int) = NULL;
static int g_tray_created = 0;
static int g_tray_observing = 0;

// A menu installed before the application object exists is kept verbatim: the
// model is arena-allocated by the generated C and never freed, so those pointers
// stay valid until the item is finally created.
typedef struct {
  int set;
  const sk_menu_t* menus; int nmenus;
  const sk_menu_item_t* items; int nitems;
  int root;
} sk_tray_pending_menu;
static sk_tray_pending_menu g_tray_pending;

static void sk_tray_flush(void);
static void sk_tray_launched(void* self, SEL _cmd, void* note);

static void* sk_send_obj(void* o, const char* sel) { return ((void* (*)(void*, SEL))objc_msgSend)(o, sel_registerName(sel)); }
static void sk_send_void(void* o, const char* sel) { ((void (*)(void*, SEL))objc_msgSend)(o, sel_registerName(sel)); }
static void sk_send_void_obj(void* o, const char* sel, void* a) { ((void (*)(void*, SEL, void*))objc_msgSend)(o, sel_registerName(sel), a); }
static void sk_send_void_int(void* o, const char* sel, long v) { ((void (*)(void*, SEL, long))objc_msgSend)(o, sel_registerName(sel), v); }
static void sk_send_void_bool(void* o, const char* sel, int v) { ((void (*)(void*, SEL, signed char))objc_msgSend)(o, sel_registerName(sel), (signed char)(v ? 1 : 0)); }
static int sk_send_int(void* o, const char* sel) { return (int)((long (*)(void*, SEL))objc_msgSend)(o, sel_registerName(sel)); }

static void* sk_nsstring(const char* s) {
  if (s == NULL) s = "";
  return ((void* (*)(void*, SEL, const char*))objc_msgSend)((void*)objc_getClass("NSString"), sel_registerName("stringWithUTF8String:"), s);
}

// ---- menu item click: tag back to the AS3 NativeMenuItem (as_menu_click_cb) ----
static void sk_tray_item_fired(void* self, SEL _cmd, void* sender) {
  (void)self; (void)_cmd;
  if (g_tray_menu_cb != NULL) g_tray_menu_cb(sk_send_int(sender, "tag"));
}

// ---- the status-item click ----
// Load-bearing distinction: the menu is NOT installed with -[NSStatusItem setMenu:].
// Doing that makes AppKit swallow the mouse-down to run menu tracking, so the
// action never fires and AS3 could never see a CLICK. Measured:
// temp/statusprobe/statusprobe2.mm logs "ACTION FIRED" only because the menu was
// popped from inside the action. Popping it here gives the app BOTH: the event
// first, then the menu.
static void sk_tray_fired(void* self, SEL _cmd, void* sender) {
  (void)self; (void)_cmd; (void)sender;
  int kind = 0, mods = 0;
  void* ev = sk_send_obj((void*)NSApp, "currentEvent");
  if (ev != NULL) {
    int type = sk_send_int(ev, "type");
    int flags = sk_send_int(ev, "modifierFlags");
    // NSRightMouseDown = 3, NSRightMouseUp = 4. Control-click is macOS's own
    // "secondary click" gesture, so it reports as one.
    int ctrl = (flags & (1 << 18)) != 0;
    kind = (type == 3 || type == 4 || ctrl) ? 1 : 0;
    if ((flags & (1 << 20)) != 0) mods |= 1;  // NSEventModifierFlagCommand
    if (ctrl) mods |= 2;                     // ...Control
    if ((flags & (1 << 19)) != 0) mods |= 4;  // ...Option
    if ((flags & (1 << 17)) != 0) mods |= 8;  // ...Shift
  }
  // Where the click happened. Three sources, most precise first:
  //   1. the event's own position, when currentEvent really is a mouse event (a
  //      real click) -- -[NSEvent locationInWindow] converted to screen space;
  //   2. the button's frame centre, when the item was activated WITHOUT a mouse
  //      event (an accessibility press, a keyboard activation): measured, AX
  //      "click menu bar item 1" leaves [NSApp currentEvent] pointing at an
  //      unrelated stale event, and -[NSEvent mouseLocation] is wherever the
  //      physical pointer happens to rest -- both report a position far from the
  //      item (1868,-1437 vs a "click" at 1148,452 on the primary display);
  //   3. mouseLocation, last resort.
  sk_nspoint m = {0.0, 0.0};
  int have = 0;
  void* btn = g_tray_item != NULL ? sk_send_obj(g_tray_item, "button") : NULL;
  if (ev != NULL) {
    int t = sk_send_int(ev, "type");
    // NSEventTypeLeftMouseDown .. LeftMouseDragged = 1..6; anything else is not a
    // click on this item.
    if (t >= 1 && t <= 6) {
      void* evwin = sk_send_obj(ev, "window");
      if (evwin != NULL) {
        m = ((sk_nspoint (*)(void*, SEL))objc_msgSend)(ev, sel_registerName("locationInWindow"));
        m = ((sk_nspoint (*)(void*, SEL, sk_nspoint))objc_msgSend)(evwin, sel_registerName("convertPointToScreen:"), m);
        have = 1;
      }
    }
  }
  if (!have && btn != NULL) {
    sk_nsrect b = ((sk_nsrect (*)(void*, SEL))objc_msgSend)(btn, sel_registerName("bounds"));
    sk_nsrect r = ((sk_nsrect (*)(void*, SEL, sk_nsrect))objc_msgSend)(btn, sel_registerName("convertRectToScreen:"), b);
    m.x = r.origin.x + r.size.x * 0.5;
    m.y = r.origin.y + r.size.y * 0.5;
    have = 1;
  }
  if (!have) {
    m = ((sk_nspoint (*)(void*, SEL))objc_msgSend)((void*)objc_getClass("NSEvent"), sel_registerName("mouseLocation"));
  }
  // AS3 screen coordinates: top-left origin, points, y growing downward. AppKit's
  // GLOBAL space has its origin at the PRIMARY display's bottom-left, so the flip
  // constant is the PRIMARY display's height -- not -[NSScreen mainScreen], which
  // is the screen holding the keyboard focus and on a multi-display desktop can be
  // a different, differently sized screen (using it puts the y of a click on a
  // different-display item off by the difference of the two heights).
  double primaryH = 0.0;
  void* screens = sk_send_obj((void*)objc_getClass("NSScreen"), "screens");
  if (screens != NULL) {
    unsigned long n = (unsigned long)((unsigned long (*)(void*, SEL))objc_msgSend)(screens, sel_registerName("count"));
    for (unsigned long i = 0; i < n; i++) {
      void* sc = ((void* (*)(void*, SEL, unsigned long))objc_msgSend)(screens, sel_registerName("objectAtIndex:"), i);
      if (sc == NULL) continue;
      sk_nsrect f = ((sk_nsrect (*)(void*, SEL))objc_msgSend)(sc, sel_registerName("frame"));
      // The zero-origin screen IS the primary one in AppKit's global space.
      if (f.origin.x == 0.0 && f.origin.y == 0.0) { primaryH = f.size.y; break; }
    }
  }
  if (g_tray_cb != NULL) g_tray_cb(kind, m.x, primaryH - m.y, mods);
  // RIGHT click only. A status item with a menu usually pops it on either button,
  // but then a left click could never mean anything else -- and the product that
  // needed this channel (净扫) uses left to open its panel. The event has already
  // been dispatched above, so AS3 has refreshed the menu's checked state by the
  // time it opens.
  if (kind == 1 && g_tray_nsmenu != NULL && g_tray_item != NULL) {
    // Deprecated since 10.14 in favour of the `menu` property — but `menu` is
    // exactly the property that swallows the action (see the note above).
    sk_send_void_obj(g_tray_item, "popUpStatusItemMenu:", g_tray_nsmenu);
  }
}

// One target object for both channels, created on first use through the ObjC
// runtime so this file stays plain C++.
static void* sk_tray_target(void) {
  static void* target = NULL;
  if (target != NULL) return target;
  Class cls = objc_getClass("SKTrayTarget");
  if (cls == NULL) {
    cls = objc_allocateClassPair((Class)objc_getClass("NSObject"), "SKTrayTarget", 0);
    if (cls == NULL) return NULL;
    class_addMethod(cls, sel_registerName("skTrayFired:"), (IMP)sk_tray_fired, "v@:@");
    class_addMethod(cls, sel_registerName("skTrayItemFired:"), (IMP)sk_tray_item_fired, "v@:@");
    class_addMethod(cls, sel_registerName("skTrayLaunched:"), (IMP)sk_tray_launched, "v@:@");
    objc_registerClassPair(cls);
  }
  target = sk_send_obj((void*)cls, "new");
  return target;
}

static void* sk_nsmenu_new(const char* title) {
  void* m = sk_send_obj((void*)objc_getClass("NSMenu"), "alloc");
  m = ((void* (*)(void*, SEL, void*))objc_msgSend)(m, sel_registerName("initWithTitle:"), sk_nsstring(title));
  // Without this AppKit re-derives enabled/checked from the responder chain and
  // overrides whatever the AS3 side set.
  sk_send_void_bool(m, "setAutoenablesItems:", 0);
  return m;
}

// keyEquivalentModifiers -> AppKit's mask (same table as window_glue.cc's
// sk_menu_apply_mods; measured in temp/keyeqprobe: 15 Cmd, 16 Shift, 17 Control,
// 18 Option, 19 none, 20 INERT). 20 alone leaves the item showing a plain "S" that
// no key combination can fire -- NSEventModifierFlagFunction reproduces both
// outcomes (no glyph, unreachable from the four modifiers).
#define SK_MOD_CMD     (1UL << 20)
#define SK_MOD_SHIFT   (1UL << 17)
#define SK_MOD_CTRL    (1UL << 18)
#define SK_MOD_OPT     (1UL << 19)
#define SK_MOD_FN      (1UL << 23)
static void sk_menu_apply_mods(void* item, int mods) {
  unsigned long mask = 0;
  if (mods & 1) mask |= SK_MOD_CMD;
  if (mods & 2) mask |= SK_MOD_SHIFT;
  if (mods & 4) mask |= SK_MOD_CTRL;
  if (mods & 8) mask |= SK_MOD_OPT;
  if (mask == 0 && (mods & 16)) mask |= SK_MOD_FN;
  sk_send_void_int(item, "setKeyEquivalentModifierMask:", (long)mask);
}

// Build one NSMenu (and recursively its submenus) out of the flattened model.
// Same shape as window_glue.cc's sk_menu_build; the difference is the action
// selector, which routes into this file's own tag callback.
static void* sk_tray_menu_build(const sk_menu_t* menus, int nmenus, const sk_menu_item_t* items, int nitems, int root) {
  if (menus == NULL || root < 0 || root >= nmenus) return NULL;
  void* menu = sk_nsmenu_new(menus[root].title != NULL ? menus[root].title : "");
  int first = menus[root].first;
  for (int i = 0; i < menus[root].count; i++) {
    int k = first + i;
    if (k < 0 || k >= nitems) break;
    if (items[k].kind == 1) {
      sk_send_void_obj(menu, "addItem:", sk_send_obj((void*)objc_getClass("NSMenuItem"), "separatorItem"));
      continue;
    }
    void* item = sk_send_obj((void*)objc_getClass("NSMenuItem"), "alloc");
    item = ((void* (*)(void*, SEL, void*, SEL, void*))objc_msgSend)(item, sel_registerName("initWithTitle:action:keyEquivalent:"),
        sk_nsstring(items[k].label), sel_registerName("skTrayItemFired:"), sk_nsstring(items[k].key));
    sk_send_void_obj(item, "setTarget:", sk_tray_target());
    sk_send_void_int(item, "setTag:", items[k].tag);
    sk_menu_apply_mods(item, items[k].mods);
    if (items[k].submenu >= 0) {
      void* sub = sk_tray_menu_build(menus, nmenus, items, nitems, items[k].submenu);
      if (sub != NULL) {
        sk_send_void_obj(sub, "setTitle:", sk_nsstring(items[k].label));
        sk_send_void_obj(item, "setSubmenu:", sub);
      }
    } else {
      sk_send_void_bool(item, "setEnabled:", items[k].enabled);
      sk_send_void_int(item, "setState:", items[k].checked ? 1 : 0);
    }
    sk_send_void_obj(menu, "addItem:", item);
  }
  return menu;
}

// ---- image ----
// The rows arrive as STRAIGHT ARGB (0xAARRGGBB, top-down), but NSBitmapImageRep's
// 8-bit non-planar format is PREMULTIPLIED RGBA in memory order R,G,B,A. Handing
// AppKit straight alpha is visible, not cosmetic: every semi-transparent pixel
// comes out too bright and a fully transparent one paints its colour. Multiply
// once here — the same rule the Dock icon uses (sk_dock_set_icon_image in
// window_glue.cc), and deliberately NOT the double-multiply AIR's Dock icon does.
static void* sk_tray_nsrep(const unsigned* argb, int w, int h) {
  void* rep = sk_send_obj((void*)objc_getClass("NSBitmapImageRep"), "alloc");
  if (rep == NULL) return NULL;
  rep = ((void* (*)(void*, SEL, void*, long, long, long, long, signed char, signed char, void*, long, long))objc_msgSend)(
      rep, sel_registerName("initWithBitmapDataPlanes:pixelsWide:pixelsHigh:bitsPerSample:samplesPerPixel:hasAlpha:isPlanar:colorSpaceName:bytesPerRow:bitsPerPixel:"),
      NULL, (long)w, (long)h, 8L, 4L, (signed char)1, (signed char)0,
      sk_nsstring("NSDeviceRGBColorSpace"), (long)w * 4L, 32L);
  unsigned char* dst = (unsigned char*)sk_send_obj(rep, "bitmapData");
  if (dst == NULL) return NULL;
  long rb = (long)sk_send_int(rep, "bytesPerRow");
  if (rb < (long)w * 4L) rb = (long)w * 4L;
  for (int y = 0; y < h; y++) {
    unsigned char* row = dst + (size_t)y * (size_t)rb;
    const unsigned* srow = argb + (size_t)y * (size_t)w;
    for (int x = 0; x < w; x++) {
      unsigned p = srow[x];
      unsigned a = (p >> 24) & 0xFFu;
      unsigned r = (p >> 16) & 0xFFu, g = (p >> 8) & 0xFFu, b = p & 0xFFu;
      if (a != 255u) {
        r = (r * a + 127u) / 255u; g = (g * a + 127u) / 255u; b = (b * a + 127u) / 255u;
      }
      row[x * 4 + 0] = (unsigned char)r;
      row[x * 4 + 1] = (unsigned char)g;
      row[x * 4 + 2] = (unsigned char)b;
      row[x * 4 + 3] = (unsigned char)a;
    }
  }
  return rep;
}

// Builds the NSImage from every representation handed over. Two rules beyond the
// pixels themselves, both of them what a native menu-bar icon does and therefore
// what this channel has to do to look like one:
//
//  1. POINT SIZE IS THE MENU BAR'S, NOT THE BITMAP'S. `NSImage size` is in points
//     and AppKit derives each rep's scale as repPixels/points, so the item's height
//     is fixed at 22pt (StatusBar's height) and the WIDTH comes from the largest
//     rep (all reps describe the same artwork, so their aspect ratios agree).
//     A single 2x bitmap therefore still lands at 22pt exactly as before; adding a
//     1x bitmap no longer means "the item is 22px tall", it means "one more scale".
//  2. TEMPLATE. The menu bar can be light (a white glyph disappears) or dark (a
//     black one does), and macOS answers that by re-drawing a TEMPLATE image in
//     the current label colour. One artwork therefore works in both appearances,
//     which is the behaviour every menu-bar app ships; the supplied RGB is only
//     used for its ALPHA. A user who needs colour art cannot have it here -- and
//     is told so in docs/zh-cn/enhancements.md §4.11 rather than silently losing
//     the colour.
static void* sk_tray_nsimage(void) {
  int pick = -1;
  for (int i = 0; i < g_tray_nreps; i++) {
    if (g_tray_rep_px[i] == NULL || g_tray_rep_w[i] <= 0 || g_tray_rep_h[i] <= 0) continue;
    if (pick < 0 || g_tray_rep_h[i] > g_tray_rep_h[pick]) pick = i;
  }
  if (pick < 0) return NULL;
  // The tallest rep decides how many pixels a point is worth. A bitmap shorter than
  // 22px would make the item smaller than the menu bar, so the floor is 22 as well.
  int baseH = g_tray_rep_h[pick] > 22 ? g_tray_rep_h[pick] : 22;
  double ptH = 22.0;
  double ptW = (double)g_tray_rep_w[pick] * (ptH / (double)baseH);
  void* img = sk_send_obj((void*)objc_getClass("NSImage"), "alloc");
  img = ((void* (*)(void*, SEL, double, double))objc_msgSend)(img, sel_registerName("initWithSize:"), ptW, ptH);
  for (int i = 0; i < g_tray_nreps; i++) {
    if (g_tray_rep_px[i] == NULL || g_tray_rep_w[i] <= 0 || g_tray_rep_h[i] <= 0) continue;
    void* rep = sk_tray_nsrep(g_tray_rep_px[i], g_tray_rep_w[i], g_tray_rep_h[i]);
    if (rep != NULL) sk_send_void_obj(img, "addRepresentation:", rep);
  }
  sk_send_void_bool(img, "setTemplate:", 1);
  return img;
}

// ---- creation / apply ----
static void sk_tray_apply(void) {
  if (g_tray_item == NULL) return;
  void* btn = sk_send_obj(g_tray_item, "button");
  if (btn == NULL) return;
  void* img = sk_tray_nsimage();
  if (img != NULL) {
    g_tray_image = img;
    sk_send_void_obj(btn, "setImage:", img);
  } else {
    g_tray_image = NULL;
    sk_send_void_obj(btn, "setImage:", NULL);
  }
  if (g_tray_have_tip) sk_send_void_obj(btn, "setToolTip:", sk_nsstring(g_tray_tip));
}

static void sk_tray_apply_menu(void) {
  if (g_tray_item == NULL || !g_tray_pending.set) return;
  void* menu = sk_tray_menu_build(g_tray_pending.menus, g_tray_pending.nmenus, g_tray_pending.items, g_tray_pending.nitems, g_tray_pending.root);
  if (menu == NULL) return;
  g_tray_nsmenu = menu;
}

static void sk_tray_create(void) {
  if (g_tray_created || NSApp == NULL) return;
  void* bar = sk_send_obj((void*)objc_getClass("NSStatusBar"), "systemStatusBar");
  if (bar == NULL) return;
  // NSVariableStatusItemLength (-1): the item sizes itself to the image, the way
  // every menu-bar app does. A fixed length would clip unusual bitmaps.
  void* item = ((void* (*)(void*, SEL, double))objc_msgSend)(bar, sel_registerName("statusItemWithLength:"), (double)(-1.0));
  if (item == NULL) return;
  sk_send_void(item, "retain");
  g_tray_item = item;
  void* btn = sk_send_obj(item, "button");
  if (btn != NULL) {
    sk_send_void_obj(btn, "setTarget:", sk_tray_target());
    sk_send_void_obj(btn, "setAction:", (void*)sel_registerName("skTrayFired:"));
    // NSEventMaskLeftMouseUp (1<<2) | NSEventMaskRightMouseUp (1<<4): right clicks
    // have to reach the action too, or AS3 could never see RIGHT_CLICK.
    sk_send_void_int(btn, "sendActionOn:", (long)((1 << 2) | (1 << 4)));
  }
  g_tray_created = 1;
  sk_tray_apply();
  sk_tray_apply_menu();
}

// Retry hook: the AS3 side runs before the window is opened (the same ordering
// that forced the Dock icon to be queued), so the application object may not exist
// yet. Rather than pump from the window loop — this file must not depend on
// window_glue.cc — an observer waits for AppKit's own finish-launching
// notification, and any later install is applied immediately.
static void sk_tray_observe(void) {
  if (g_tray_observing || NSApp != NULL) return;
  void* nc = sk_send_obj((void*)objc_getClass("NSNotificationCenter"), "defaultCenter");
  if (nc == NULL) return;
  g_tray_observing = 1;
  ((void (*)(void*, SEL, void*, SEL, void*, void*))objc_msgSend)(
      nc, sel_registerName("addObserver:selector:name:object:"),
      sk_tray_target(), sel_registerName("skTrayLaunched:"),
      sk_nsstring("NSApplicationDidFinishLaunchingNotification"), NULL);
}

static void sk_tray_flush(void) {
  if (g_tray_created) return;
  if (NSApp == NULL) { sk_tray_observe(); return; }
  sk_tray_create();
}

static void sk_tray_launched(void* self, SEL _cmd, void* note) {
  (void)self; (void)_cmd; (void)note;
  sk_tray_flush();
  sk_tray_apply();
  sk_tray_apply_menu();
}

void sk_tray_set_images(const void* const* argbs, const int* ws, const int* hs, int n) {
  for (int i = 0; i < g_tray_nreps; i++) {
    if (g_tray_rep_px[i] != NULL) free(g_tray_rep_px[i]);
    g_tray_rep_px[i] = NULL; g_tray_rep_w[i] = 0; g_tray_rep_h[i] = 0;
  }
  g_tray_nreps = 0;
  if (argbs != NULL && ws != NULL && hs != NULL) {
    for (int i = 0; i < n && g_tray_nreps < SK_TRAY_MAX_REPS; i++) {
      if (argbs[i] == NULL || ws[i] <= 0 || hs[i] <= 0) continue;
      size_t px = (size_t)ws[i] * (size_t)hs[i];
      unsigned* copy = (unsigned*)malloc(px * sizeof(unsigned));
      if (copy == NULL) continue;
      memcpy(copy, argbs[i], px * sizeof(unsigned));
      int k = g_tray_nreps;
      g_tray_rep_px[k] = copy; g_tray_rep_w[k] = ws[i]; g_tray_rep_h[k] = hs[i];
      g_tray_nreps = k + 1;
    }
  }
  sk_tray_flush();
  sk_tray_apply();
}

void sk_tray_set_tooltip(const char* text) {
  if (text == NULL) { g_tray_have_tip = 0; g_tray_tip[0] = 0; }
  else {
    // Bounded by this buffer, NOT by AIR's MAX_TIP_LENGTH: that constant describes
    // the WINDOWS tooltip, and there is no macOS AIR behaviour to inherit here.
    size_t n = strlen(text);
    if (n >= sizeof(g_tray_tip)) n = sizeof(g_tray_tip) - 1;
    memcpy(g_tray_tip, text, n);
    g_tray_tip[n] = 0;
    g_tray_have_tip = 1;
  }
  sk_tray_flush();
  sk_tray_apply();
}

int sk_tray_set_menu(const sk_menu_t* menus, int nmenus, const sk_menu_item_t* items, int nitems, int root, void (*cb)(int)) {
  g_tray_menu_cb = cb;
  if (menus == NULL) {
    // `tray.menu = null` detaches: the next click must not pop the menu that was
    // there before.
    g_tray_pending.set = 0;
    g_tray_nsmenu = NULL;
    return g_tray_created;
  }
  g_tray_pending.set = 1;
  g_tray_pending.menus = menus; g_tray_pending.nmenus = nmenus;
  g_tray_pending.items = items; g_tray_pending.nitems = nitems;
  g_tray_pending.root = root;
  sk_tray_flush();
  sk_tray_apply_menu();
  return g_tray_created;
}

void sk_tray_set_callback(void (*cb)(int kind, double sx, double sy, int mods)) {
  g_tray_cb = cb;
  sk_tray_flush();
}

} // extern "C"

#else  // !__APPLE__

// No Cocoa, no status item. The generated C never calls these with ASC_HAS_TRAY
// off, but the definitions exist so a build that flips the macro cannot fail to
// link for a reason that has nothing to do with the real problem.
extern "C" {
void sk_tray_set_images(const void* const* argbs, const int* ws, const int* hs, int n) { (void)argbs; (void)ws; (void)hs; (void)n; }
void sk_tray_set_tooltip(const char* text) { (void)text; }
int sk_tray_set_menu(const sk_menu_t* menus, int nmenus, const sk_menu_item_t* items, int nitems, int root, void (*cb)(int)) {
  (void)menus; (void)nmenus; (void)items; (void)nitems; (void)root; (void)cb; return 0;
}
void sk_tray_set_callback(void (*cb)(int kind, double sx, double sy, int mods)) { (void)cb; }
}

#endif