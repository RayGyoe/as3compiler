// Unit checks: flash.ui.ContextMenu on top of flash.display.NativeMenu, plus the
// right-click popup contract it drives (阶段二百八十九).
//   node --test --test-name-pattern='context-menu/' test/unit/*.ts
//
// Everything here is measured on adl 51.4.1 first (temp/ctxprobe/api/out*.txt for the
// object model, temp/ctxprobe/out2.txt for the popup) and then pinned as SOURCE,
// because the alternative -- running a windowed probe -- is not something the suite
// can do. The end-to-end half (the same API calls against AIR and against our build,
// diffed line for line) is examples/context-menu.as.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root } from '../harness.ts';

function checkContextMenuModel(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [ctxmenu] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [ctxmenu] ${label}`); }
  };

  const src = readFileSync(join(root, 'examples', 'context-menu.as'), 'utf8');
  const c = generateC(parse(src)).c;
  const symbols = readFileSync(join(root, 'src', 'symbols.ts'), 'utf8');
  const emit = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const glue = readFileSync(join(root, 'vendor', 'window_glue.cc'), 'utf8');
  const web = readFileSync(join(root, 'vendor', 'web_glue.cc'), 'utf8');
  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');

  // --- hierarchy: ContextMenu IS a NativeMenu, and its items are the INHERITED list.
  check('symbols: ContextMenu extends NativeMenu', /this\.classMap\.set\('ContextMenu', \{[\s\S]{0,4000}?superClass: 'NativeMenu'/.test(symbols));
  check('symbols: ContextMenu no longer declares its own item list as a field',
    !/this\.classMap\.set\('ContextMenu'[\s\S]{0,600}?\['customItems', cmiF\(/.test(symbols));
  check('emit: ContextMenu ctor builds on NativeMenu_ctor', c.includes('void ContextMenu_ctor(ContextMenu* o) {\n  NativeMenu_ctor((NativeMenu*)o);'));
  check('emit: customItems aliases the inherited list',
    c.includes('as_array* ContextMenu_get_customItems(void* _this) {') &&
    /ContextMenu_get_customItems[\s\S]{0,200}?return m->_items;/.test(c));
  check('emit: the popup reads the inherited list',
    c.includes('as_menu_popup_stage(((NativeMenu*)menu)->_items, (void*)menu, hit, owner, win, sx, sy, 1);') &&
    c.includes('as_menu_popup_stage(((NativeMenu*)o)->_items, (void*)o, NULL, NULL, as_stage_window_id(stage), x, y, 0);'));

  // --- the three measured ContextMenu-only rules.
  check('emit: getItemByName answers null on a ContextMenu',
    /NativeMenuItem\* ContextMenu_getItemByName\(void\* _this, char\* name\) \{[\s\S]{0,400}?return NULL;/.test(c) &&
    !/ContextMenu_getItemByName[\s\S]{0,400}?strcmp\(/.test(c));
  check('emit: setItemIndex always throws RangeError #2006',
    /void ContextMenu_setItemIndex\(void\* _this, NativeMenuItem\* item, int index\) \{\n  \(void\)_this; \(void\)item; \(void\)index;[\s\S]{0,200}?Error #2006: The supplied index is out of bounds\.", 2006\)/.test(c));
  check('emit: display(null, ...) is ArgumentError #2007 with AIR\'s message',
    c.includes('Error #2007: Parameter stage must be non-null.", 2007'));
  check('emit: ContextMenu addItem/addItemAt carry NO duplicate check',
    !/ContextMenu_addItem\(void\* _this[\s\S]{0,400}?as_menu_index/.test(c) &&
    !/ContextMenu_addItemAt\(void\* _this[\s\S]{0,400}?as_menu_index/.test(c));

  // --- the popup: MENU_SELECT, then the replayed right release, then the selection.
  check('emit: as_ctxmenu_show dispatches MENU_SELECT before popping up',
    /ContextMenuEvent_new\(\(char\*\)"menuSelect", false, false, \(InteractiveObject\*\)hit, \(InteractiveObject\*\)owner\)[\s\S]{0,200}?as_menu_popup_stage/.test(c));
  check('emit: the context menu is found by walking the ancestor chain',
    /void\* p = hit;[\s\S]{0,300}?p = \(\(DisplayObject\*\)p\)->parent;/.test(c));
  check('emit: no owning menu means no popup at all',
    /if \(owner == NULL\) return;/.test(c));
  check('emit: the swallowed right release is replayed BEFORE the selection events, at the dismissal point',
    /if \(fromPress\) \{[\s\S]{0,400}?ASC_window_on_mouse\(win, ux, uy, "rightMouseUp"\);[\s\S]{0,120}?ASC_window_on_mouse\(win, ux, uy, "rightClick"\);[\s\S]{0,120}?as_menu_popup_finish\(tag\);/.test(c));
  check('emit: display() replayed nothing (fromPress 0)',
    (c.match(/as_menu_popup_stage\([^;]*, 0\);/g) || []).length === 2);
  check('emit: menu-level SELECT keeps the ITEM as target',
    c.includes('static void as_menu_select_on(void* disp, NativeMenuItem* item)') &&
    /as_menu_select_on[\s\S]{0,300}?e->target = \(Object\*\)item;/.test(c));
  check('emit: the popup is polled once per frame',
    c.includes('as_menu_popup_pump();'));

  // --- the glue: modal popup, the SDL button-state resync, and the web fallback.
  check('glue: Cocoa pops up with a blocking tracking loop',
    glue.includes('"popUpMenuPositioningItem:atLocation:inView:"'));
  check('glue: AppKit y is flipped from the model\'s top-left screen space',
    glue.includes('static double sk_screen_flip_y(double y)'));
  check('glue: the release the menu swallowed is replayed by the emitter, so the SDL up it manufactures is swallowed',
    glue.includes('static int g_synth_right_up = 0;') &&
    /g_synth_right_up = 1;[\s\S]{0,300}?SDL_SendMouseButton/.test(glue) &&
    /SDL_MOUSEBUTTONUP:[\s\S]{0,900}?g_synth_right_up\) \{[\s\S]{0,600}?break;/.test(glue));
  check('glue: the resync only fires when the OS says the button is up',
    /static void sk_resync_right_button[\s\S]{0,400}?SDL_GetGlobalMouseState\(NULL, NULL\) & SDL_BUTTON_RMASK\) return;/.test(glue));
  check('glue: right button maps to rightMouseDown / rightMouseUp + rightClick',
    glue.includes('"rightMouseDown"') && glue.includes('"rightMouseUp"') && glue.includes('"rightClick"'));
  check('web: the browser menu is suppressed with a DOM listener (emsdk 3.1.44 has no contextmenu callback)',
    web.includes("el.addEventListener('contextmenu', function(ev) { ev.preventDefault(); });") &&
    !web.includes('emscripten_set_contextmenu_callback('));
  check('web: the popup is a DOM overlay resolved asynchronously',
    web.includes('window.__skMenu') && web.includes('return 0;  // pending: resolved by sk_menu_popup_take from a later frame'));
  check('runtime: the popup extern reports the dismissal point and the sync/pending split',
    /extern int sk_menu_popup\(int win, const sk_menu\* menus, int nmenus, const sk_menu_item\* items, int nitems, int root, double x, double y, int\* tag, double\* outx, double\* outy\);/.test(runtime) &&
    runtime.includes('extern int sk_menu_popup_take(int* tag);'));

  // --- Windows branch (阶段二百九十: measured on a real Windows box, temp/ctxwin).
  // A popup tag is the 1-based index into ASC_popup_tags, never the flat item index:
  // separators take flat slots but are not pushed, so the old formula resolved every
  // item after a separator to a NULL entry and the pick dispatched nothing.
  check('emit: the popup tag is the ASC_popup_tags index, not the flat item index',
    c.includes('as_array_push(ASC_popup_tags, v); c->items[k].tag = ASC_popup_tags->length;') &&
    !c.includes('c->items[k].tag = c->nitems;'));
  const fillTag = c.indexOf('c->items[k].tag = c->tag_base + k + 1;');
  check('emit: as_menu_fill tags every slot and pushes that same slot (self-consistent)',
    fillTag > 0 && c.indexOf('as_array_push(ASC_menu_tags, v);', fillTag) > fillTag);
  check('glue (win): TrackPopupMenu gets SCREEN coordinates, not client ones',
    !glue.includes('ScreenToClient(hwnd, &pt);') &&
    glue.includes('int cmd = (int)TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, pt.x, pt.y, 0, hwnd, NULL);'));
  // The release Win32's modal pump queues arrives after the menu is gone, on top of
  // the pair the emitter replayed at the dismissal point: one right-click produced
  // TWO rightMouseUp/rightClick pairs before this. The flag is raised just before
  // TrackPopupMenu and cleared either by that queued release or by a new press.
  const swUp = glue.indexOf('g_popup_up_swallow) {');
  check('glue (win): the queued popup release is swallowed in MOUSEBUTTONUP',
    glue.includes('static int g_popup_up_swallow = 0;') &&
    glue.indexOf('g_popup_up_swallow = 1;') > 0 &&
    glue.indexOf('g_popup_up_swallow = 1;') < glue.indexOf('int cmd = (int)TrackPopupMenu(') &&
    swUp > 0 &&
    glue.indexOf('g_popup_up_swallow = 0;', swUp) > swUp &&
    glue.indexOf('break;', swUp) > glue.indexOf('g_popup_up_swallow = 0;', swUp));
  const bdown = glue.indexOf('case SDL_MOUSEBUTTONDOWN:');
  const rdown = glue.indexOf('"rightMouseDown"');
  check('glue (win): a new right press clears a pending swallow before dispatching rightMouseDown',
    bdown > 0 && rdown > bdown &&
    glue.indexOf('g_popup_up_swallow = 0;', bdown) > bdown &&
    glue.indexOf('g_popup_up_swallow = 0;', bdown) < rdown);
  check('glue (win): submenus are attached with the SUBMENU HANDLE (MF_POPUP)',
    glue.includes('AppendMenuW(menu, MF_POPUP | MF_STRING, (UINT_PTR)sub, wlabel)') &&
    glue.includes('static HMENU sk_win_menu_build('));

  // --- 阶段二百九十二: two defects this app's own user-list menu exposed on a real
  // 150% box (temp/ctxpos). The menu is built as 修改昵称 / new NativeMenuItem("", true)
  // / 截图上传.
  //
  // (a) A separator ITEM is not a separatorBefore. `new NativeMenuItem("", true)`
  //     makes the item ITSELF the line (no row of its own); only
  //     ContextMenuItem.separatorBefore was honoured, so the popup drew an empty,
  //     clickable row in the middle instead of a line (menuA2.bmp). The
  //     application-menu path (as_menu_fill) always read _sep: this was the only
  //     place that did not.
  check('emit: NativeMenuItem.isSeparator is read as a separator',
    /static int as_ctxmenu_is_sep\(NativeMenuItem\* it\) \{[\s\S]{0,120}?return it->_sep \? 1 : 0;/.test(c));
  check('emit: a separator item takes ONE flat slot, kind=1, and no popup tag',
    /if \(as_ctxmenu_is_sep\(it\)\) \{[\s\S]{0,260}?c->items\[k\]\.kind = 1;[\s\S]{0,260}?c->items\[k\]\.tag = 0;[\s\S]{0,80}?continue;/.test(c) &&
    !/if \(as_ctxmenu_is_sep\(it\)\) \{[\s\S]{0,400}?as_array_push\(ASC_popup_tags/.test(c));
  check('emit: the separator item counts as one slot, never slot+row',
    c.includes('if (as_ctxmenu_is_sep(it)) { n++; continue; }'));
  check('emit: the submenu patch-up skips the separator slot',
    c.includes('if (as_ctxmenu_is_sep(it)) { pos++; continue; }'));
  //
  // (b) The popup point is DIP (stage, NativeWindow.bounds and SDL's window/mouse
  //     positions all are); TrackPopupMenu in a per-monitor-DPI-aware process wants
  //     PHYSICAL pixels. Measured: a right click on the user row at physical
  //     (3516,1245) put the 206x111 popup at (2344,830) = exactly the click / 1.5.
  //     The temp/ctxwin probe missed it because the DPI-unaware PowerShell that
  //     measured it divided every coordinate by the same 1.5.
  check('glue (win): the popup point is scaled by the window DPI factor',
    glue.includes('double bk = sk_window_backing_scale(c->win);') &&
    glue.includes('pt.x = (LONG)(x * bk + (x >= 0.0 ? 0.5 : -0.5));') &&
    glue.includes('pt.y = (LONG)(y * bk + (y >= 0.0 ? 0.5 : -0.5));'));
  check('glue (win): the dismissal point is converted back to DIP for the replayed stage coords',
    glue.includes('*outx = (double)g.x / bk;') &&
    glue.includes('*outy = (double)g.y / bk;'));
  check('example: pins the separator-item contract',
    src.includes('sepIsSeparator=') && src.includes('new NativeMenuItem("", true)'));
  // --- the example stays behaviourally meaningful (it is the diffed contract).
  check('example: pins the measured quirks (name lookup, setItemIndex, duplicate add)',
    src.includes('getItemByName(alphaItem)="') && src.includes('setIndex threw') && src.includes('afterDupAdd='));

  if (ok > 0) console.log(`[ctxmenu] ${ok} context-menu checks passed`);
  return bad;
}

registerGroup('unit: context-menu/Model', checkContextMenuModel);