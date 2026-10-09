// Unit checks: editable TextField: double click, tab focus, restrict, input, selection.
// Moved verbatim out of the single-file test.ts (阶段九十六·一); each group
// still returns the list of failed labels and is registered as one node:test
// case, so it can be re-run alone with:
//   node --test --test-name-pattern='text-input/' test/unit/*.ts

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { lex } from '../../src/lexer.ts';
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { defaultBuildConfig, loadManifest, applyManifest, applyManifestOverlay, buildCompileCommand, buildCompileSteps, buildWebCompileSteps, effectiveDefines, validateFeatures, knownFeatures } from '../../src/build.ts';
import type { BuildConfig, Target, Manifest } from '../../src/build.ts';
import { airManifest, prepareAirApp } from '../../src/air-app.ts';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root, dir, EXAMPLE_TIMEOUT_MS } from '../harness.ts';

// ---- 阶段九十四·七 C2：可编辑 TextField / 键盘与文本输入 ----------------
// 口径全部来自 temp/editprobe/ 的 adl ↔ AOT 双端对照（探针 src/Ed2.as…Ed4.as，
// adl 51.4.1）：键入时序 keyDown→textInput→插入→change、编辑键、Cmd 加速键、
// TextFieldType/TextEvent、双击选词。这里钉住发射出的 C 与运行时/胶水源码。
// MouseEvent.DOUBLE_CLICK (阶段九十四·十一). The window path is where the gate
// lives, so pin it where it is written: the glue tags SDL's clicks==2 as the
// reserved "dblclick" type, and ASC_window_on_mouse resolves that against the
// HIT TARGET's own doubleClickEnabled. adl ground truth: temp/editprobe/
// drive_ed9.py && src/Ed9.as (logs adl_ed9.txt / aot_ed9.txt).
function checkDoubleClick(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [doubleclick] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [doubleclick] ${label}`); }
  };
  const glue = readFileSync(join(root, 'vendor', 'window_glue.cc'), 'utf8');
  // (1) The glue replaces the second click, it does not add a third event: the
  // same on_mouse call is tagged "dblclick" for clicks==2 and "click" otherwise
  // (a triple click is click,doubleClick,click on adl, so clicks==3 must NOT
  // become a double click).
  check('the glue tags the second click of a double click as the reserved "dblclick"',
    /e\.button\.clicks == 2 \? "dblclick" : "click"/.test(glue));
  check('the glue still emits exactly one mouseUp + one click-channel event per release',
    /on_mouse\(id, \(double\)e\.button\.x, \(double\)e\.button\.y, "mouseUp"\);[\s\S]{0,1400}?clicks == 2 \? "dblclick" : "click"/.test(glue));
  check('the glue does not emit a bare "click" on the double-click release any more',
    !/on_mouse\(id, \(double\)e\.button\.x, \(double\)e\.button\.y, "mouseUp"\);[\s\S]{0,200}?on_mouse\(id, \(double\)e\.button\.x, \(double\)e\.button\.y, "click"\);/.test(glue));

  const c = generateC(parse(
    'var sp:Sprite = new Sprite();\n' +
    'sp.doubleClickEnabled = true;\n' +
    'sp.addEventListener(MouseEvent.DOUBLE_CLICK, onDbl);\n' +
    'function onDbl(e:MouseEvent):void {}\n' +
    'var on:Boolean = sp.doubleClickEnabled;\n')).c;
  // (2) The AS3 bridge intercepts "dblclick" BEFORE Stage_dispatchMouse, exactly
  // like "wordSelect": gated on the hit target's own flag, then dispatched as
  // either "doubleClick" or a plain "click".
  check('ASC_window_on_mouse resolves the reserved "dblclick" type',
    c.includes('if (strcmp(type, "dblclick") == 0) {'));
  check('the gate reads the hit target\'s own doubleClickEnabled',
    c.includes('((InteractiveObject*)hit)->doubleClickEnabled'));
  check('the gate is guarded by an InteractiveObject check (Shape/Bitmap are not interactive)',
    c.includes('as_is(hit, &InteractiveObject_vt)'));
  check('a gated double click dispatches "doubleClick", else a plain "click"',
    c.includes('dce ? (char*)"doubleClick" : (char*)"click"'));
  // (3) The flag and the constant exist as modelled.
  check('InteractiveObject declares doubleClickEnabled',
    /struct InteractiveObject \{[\s\S]{0,900}?bool doubleClickEnabled;/.test(c));
  check('doubleClickEnabled defaults to false in the ctor',
    c.includes('o->doubleClickEnabled = false;'));
  check('MouseEvent.DOUBLE_CLICK exists as "doubleClick"',
    c.includes('"doubleClick"'));
  return bad;
}

// Tab / Shift+Tab focus traversal (阶段九十四·十三). adl ground truth:
// temp/editprobe/src/Ed10.as + drive_ed10.py (adl_ed10.txt == aot_ed10.txt).
function checkTabFocus(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [tabfocus] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [tabfocus] ${label}`); }
  };
  const c = generateC(parse(
    'var sp:Stage = new Stage();\n' +
    'var t:TextField = new TextField();\n' +
    'sp.addChild(t);\n' +
    'sp.dispatchKey("keyDown", 9, 9, 0);\n')).c;
  // (1) The ring walk: display-list pre-order, filtered to InteractiveObjects
  // whose tabEnabled is true. tabIndex is deliberately NOT consulted (measured
  // inconsistent on adl; the leftover row never asked for it).
  const scan = /static void as_tab_scan\([\s\S]*?\n\}\n/.exec(c)?.[0] ?? '';
  check('as_tab_scan walks the display list pre-order',
    scan.includes('if (as_is((void*)o, &DisplayObjectContainer_vt))') &&
    scan.includes('as_tab_scan((DisplayObject*)as_v_obj_val(c->children->data[i])'));
  check('the ring only admits InteractiveObjects with tabEnabled',
    scan.includes('as_is((void*)o, &InteractiveObject_vt) && ((InteractiveObject*)o)->tabEnabled'));
  check('the ring ignores tabIndex entirely (deliberate: adl ordering is not reproducible)',
    scan.length > 0 && !scan.includes('tabIndex'));
  // (2) Selection: forward picks the first ordinal past the anchor, backward the
  // last before it, and both wrap.
  const pick = /static void as_focus_tab\([\s\S]*?\n\}\n/.exec(c)?.[0] ?? '';
  check('forward scan picks the first tabbable after the current ordinal',
    pick.includes('for (int i = 0; i < nt; i++) if (tords[i] > focus_ord) { pick = i; break; }'));
  check('forward wraps to the first, backward wraps to the last',
    pick.includes('if (pick < 0) pick = 0;') && pick.includes('if (pick < 0) pick = nt - 1;'));
  check('with nothing focused the scan resumes from the mouse anchor',
    pick.includes('if (focus_ord < 0) focus_ord = anchor_ord;'));
  check('the walk starts at the Stage that received the key (per-window, not a global)',
    pick.includes('(root != NULL) ? root : (DisplayObject*)ASC_root_stage'));
  check('the move is committed through as_set_focus (which dispatches focusOut/focusIn)',
    pick.includes('as_set_focus(tabs[pick]);'));
  // (3) The anchor is written by the mouse-down focus path only (traversal must
  // not move it) and is kept as a GC root.
  check('a mouseDown on a TextField records the Tab anchor',
    c.includes('obj = (DisplayObject*)target; as_tab_anchor = obj;'));
  check('as_tab_anchor is a permanent GC root',
    c.includes('gc_mark_ptr((void*)as_tab_anchor);'));
  check('the traversal itself never assigns the anchor',
    !/static void as_focus_tab[\s\S]*?as_tab_anchor\s*=/.test(pick));
  // (4) The hook: on the Tab keyDown, after the event is dispatched, suppressed
  // by preventDefault, inside the keyDown-only path (never on keyUp).
  const hook = /if \(keyCode == 9 && !evt->cancelled\)[^\n]*/.exec(c)?.[0] ?? '';
  check('Tab traversal is hooked to the uncancelled Tab keyDown',
    hook.includes('as_focus_tab((DisplayObject*)_this, (mod & ASC_MOD_SHIFT) ? -1 : 1);'));
  check('the hook reads the post-dispatch cancelled flag',
    /as_key_text_suppressed = evt->cancelled \? 1 : 0;\n\s*if \(keyCode == 9 && !evt->cancelled\)/.test(c));
  check('the hook sits after the keyUp early-return, so keyUp never traverses',
    /if \(!down\) return;[\s\S]{0,400}?if \(keyCode == 9 && !evt->cancelled\)/.test(c));
  // (5) stage.dispatchKey is the headless driver for all of the above.
  check('Stage.dispatchKey(type, keyCode, charCode, mod) routes to Stage_dispatchKey',
    c.includes('Stage_dispatchKey(('));
  return bad;
}

function checkRestrict(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [restrict] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [restrict] ${label}`); }
  };
  const c = generateC(parse(
    'var f:TextField = new TextField();\n' +
    'f.restrict = "0-9";\n' +
    'f.type = TextFieldType.INPUT;\n' +
    'f.multiline = true;\n')).c;

  // (1) 模式解码：允许集/区间/转义 + 开头的 `^` 翻转成排除集。
  const has = /static bool as_tf_restrict_has\([\s\S]*?\n\}\n/.exec(c)?.[0] ?? '';
  check('as_tf_restrict_has decodes `\\` escapes before ranges',
    has.includes("p[i] == '\\\\' && p[i + 1] != 0"));
  check('as_tf_restrict_has treats `-` as a range over two decoded members',
    has.includes("p[i] == '-' && p[i + 1] != 0") && has.includes('if (c >= a && c <= b) return true;'));
  const ch = /static int as_tf_restrict_char\([\s\S]*?\n\}\n/.exec(c)?.[0] ?? '';
  check('a leading caret turns the set into an excluded set',
    ch.includes(`bool neg = (pat[0] == '^');`) && ch.includes('const char* p = neg ? pat + 1 : pat;'));
  check('a NULL pattern allows everything (no filter at all)',
    ch.includes('if (pat == NULL) return (int)c;'));
  check('membership is read through the negation (allowed iff in != neg)',
    ch.includes('if (as_tf_restrict_has(p, c) != neg) return (int)c;'));
  // (2) 大小写互换回退：不允许则试互换大小写后的字符。
  check('an unaccepted char falls back to its toggled-case twin',
    ch.includes("if (c >= 'a' && c <= 'z') alt = (unsigned char)(c - 32);") &&
    ch.includes("else if (c >= 'A' && c <= 'Z') alt = (unsigned char)(c + 32);") &&
    ch.includes('if (as_tf_restrict_has(p, alt) != neg) return (int)alt;'));
  check('a char with no other case (digit, symbol) is dropped instead',
    ch.includes('if (alt == c) return 0;') && ch.includes('\n  return 0;'));
  // (3) 过滤位置：textInput 之后（事件带原始文本）、splice 之前；换行绕过。
  const ins = /static void as_tf_insert_text\([\s\S]*?\n\}\n/.exec(c)?.[0] ?? '';
  check('the filter runs after the textInput dispatch, so the event keeps the raw text',
    ins.indexOf('as_tf_restrict_char') > ins.indexOf('if (te->cancelled) return;'));
  check('restrict is only consulted when the pattern is non-NULL',
    ins.includes('if (tf->_restrict != NULL) {') && ins.includes('ins = filtered;'));
  check('newlines bypass the filter (measured: Return still inserts in a multiline field)',
    ins.includes('if (c == 13 || c == 10) filtered[fn++] = (char)c;'));
  check('the filtered string is what gets spliced (so it keeps the maxChars/selection semantics)',
    ins.includes('if (as_tf_splice(tf, lo, hi, ins)) as_tf_dispatch_change(tf);'));
  check('the raw payload is still what the event carries',
    ins.includes('TextEvent_new((char*)"textInput", true, true, (char*)text)'));
  // (4) 只作用于用户输入：text 赋值路径完全不经过 restrict。
  check('the TextField.text setter never consults restrict',
    /static void TextField_set_text\(void\* _this, char\* value\) \{[\s\S]{0,600}?\n\}/.test(c) &&
    !/static void TextField_set_text\(void\* _this, char\* value\) \{[\s\S]{0,600}?as_tf_restrict/.test(c));
  // (5) 粘贴与单字符走同一条管道（因此也过滤）。
  const paste = /static void as_tf_paste\([\s\S]*?\n\}\n/.exec(c)?.[0] ?? '';
  check('paste routes through as_tf_insert_text, so restrict applies to it too',
    paste.includes('as_tf_insert_text(tf, buf);'));
  // (6) Return 的换行：SDL2/Cocoa 从不为 Return 产生 text，故在 keyDown 上合成提交。
  check('Return synthesizes its text commit for a multiline editable field',
    c.includes('if (keyCode == 13 && tf->multiline) as_tf_insert_text(tf, "\\r");'));
  check('the Return commit sits in the keyDown-only path, after the editable-field guard',
    /if \(!down\) return;[\s\S]{0,1400}?if \(keyCode == 13 && tf->multiline\) as_tf_insert_text/.test(c) &&
    /as_tf_is_input\(tf\)\) return;[\s\S]{0,400}?if \(keyCode == 13/.test(c));
  // (7) dispatchText 是 headless 驱动钩子，通到 Stage_dispatchText。
  check('Stage.dispatchText(text) routes to Stage_dispatchText',
    c.includes('Stage_dispatchText(('));
  return bad;
}

function checkTextInput(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [textinput] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [textinput] ${label}`); }
  };
  const c = generateC(parse('import flash.text.TextField;\nimport flash.text.TextFieldType;\nimport flash.events.TextEvent;\nvar f:TextField = new TextField();\nf.type = TextFieldType.INPUT;\nf.maxChars = 5;\nvar e:TextEvent = new TextEvent(TextEvent.TEXT_INPUT, true, true, "x");\n')).c;
  const skiaGlue = readFileSync(join(root, 'vendor', 'skia_glue.cc'), 'utf8');

  // 常量与构造：TextFieldType 是普通 const 类，TextEvent 继承 Event 且带 text 槽。
  check('TextFieldType exposes INPUT/DYNAMIC as measured constants',
    c.includes('TextFieldType_INPUT') && c.includes('"input"') && c.includes('"dynamic"'));
  check('TextEvent carries a text payload and the TEXT_INPUT constant',
    c.includes('{ "text", 3, offsetof(TextEvent, text) }')
    && c.includes('static char* const TextEvent_TEXT_INPUT = "textInput";'));
  check('TextEvent constructs through the measured (type, bubbles, cancelable, text) shape',
    c.includes('static TextEvent* TextEvent_new(char* type, bool bubbles, bool cancelable, char* text) {')
    && c.includes('Event_ctor((Event*)o, type, bubbles, cancelable); o->text = text;'));

  // 新字段：type/maxChars/displayAsPassword/restrict。restrict 是 C 关键字，须走 cIdent 的名。
  check('TextField stores the editable-text slots',
    /\nstruct TextField \{[\s\S]{0,2000}?char\* type;/.test(c)
    && /\nstruct TextField \{[\s\S]{0,2000}?int maxChars;/.test(c)
    && /\nstruct TextField \{[\s\S]{0,2000}?bool displayAsPassword;/.test(c)
    && /\nstruct TextField \{[\s\S]{0,2000}?char\* _restrict;/.test(c));

  // 默认值（adl 逐项实测，temp/editprobe/src/Def.as）：dynamic / 无限 / 非密码 /
  // tabEnabled **false**（不是 true）/ restrict NULL，且 text 是空字符串而非 NULL。
  check('the TextField defaults match the measured adl values',
    c.includes('o->type = (char*)"dynamic";')
    && c.includes('o->maxChars = 0;')
    && c.includes('o->displayAsPassword = false;')
    && c.includes('o->tabEnabled = false;')
    && c.includes('o->_restrict = NULL;'));
  check('a fresh field reports "" (not a NULL string) for text',
    c.includes('o->text = as_str_alloc(1);') && !c.includes('o->text = NULL;'));
  // type 的 setter 复刻 AIR 那个「值真的变化才联动 tabEnabled」的副作用
  // （四步实测见 temp/editprobe/src/Def2.as）：同值重赋不得覆盖手工设置的值。
  check('the type setter implements the measured tabEnabled side effect',
    c.includes('void TextField_set_type(void* _this, char* value) {')
    && c.includes('if (strcmp(cur, nv) != 0) tf->tabEnabled = (strcmp(nv, "input") == 0);')
    && c.includes('tf->type = value;'));

  // 键入时序：keyDown -> textInput（冒泡/cancelable）-> 插入（maxChars 截断）-> change。
  check('keyDown preventDefault suppresses this key text until the insert consumes it',
    c.includes('static int as_key_text_suppressed = 0;')
    && c.includes('as_key_text_suppressed = evt->cancelled ? 1 : 0;')
    && c.includes('if (as_key_text_suppressed) { as_key_text_suppressed = 0; return; }'));
  check('textInput is dispatched before the insert, bubbles, and a cancel blocks the edit',
    /TextEvent_new\(\(char\*\)"textInput", true, true,[\s\S]{0,900}?if \(te->cancelled\) return;[\s\S]{0,900}?as_tf_splice/.test(c));
  check('textInput travels the reserved glue channel into Stage_dispatchText',
    c.includes('void Stage_dispatchText(void* _this, char* text) {')
    && c.includes('if (sk_window_text_take(id, buf, (int)sizeof(buf)) > 0) Stage_dispatchText((void*)w->stage, buf);'));
  check('the insert truncates at maxChars',
    c.includes('if (tf->maxChars > 0) {'));
  // The inserted string is `ins` since 阶段九十四·十四: it aliases `text` when
  // restrict is NULL and the filtered copy otherwise.
  check('change fires only when the bytes actually changed',
    c.includes('static void as_tf_dispatch_change(TextField* tf) {')
    && /if \(as_tf_splice\(tf, lo, hi, ins\)\) as_tf_dispatch_change\(tf\);/.test(c)
    && c.includes('const char* ins = text;'));

  // 可空字符串字段（restrict/styleSheet 等）在**动态**上下文里读到 C NULL 时，
  // as_v_str 必须归一到 null 字面量（与 as_v_obj/as_v_arr/as_v_fn 同约定）——
  // adl 51.4.1 实测 `var x:* = new TextField().restrict; x == null` 为 true
  // （阶段九十四·十）；修复前我们给 tag-3/NULL 指针，=> false 且 `x == ""`/`.length` 段错误。
  const nb = generateC(parse('import flash.text.TextField;\nvar f:TextField = new TextField();\nvar x:* = f.restrict;\nvar b:Boolean = (x == null);\n')).c;
  check('as_v_str normalizes a NULL char* to the null literal (AS3 one-null rule)',
    /static as_value as_v_str\(char\* s\)\s*\{\s*if \(s == NULL\) return as_v_null\(\);/.test(RUNTIME_PREAMBLE.replace(/\r\n/g, '\n')));
  check('a nullable string field boxes through as_v_str, so the NULL guard applies',
    /as_v_str\(\([^\n]*g_f[^\n]*->_restrict\)\)/.test(nb) && nb.includes('as_v_loose_eq(g_x, as_v_null())'));

  // 编辑键集合（Home/End/箭头/Cmd/Option 词跳 + PageUp/PageDown），PageUp/Down 在
  // PageDown 上按「可见行数」移光标（阶段九十四·十五）。
  check('the edit keys are handled in one C routine',
    c.includes('static bool as_tf_is_edit_key(int kc) {')
    && c.includes('static void as_tf_edit_key(TextField* tf, int keyCode, int mod) {'));
  check('PageUp/PageDown are in the edit-key set and move by the visible line count',
    c.includes('return kc == 8 || kc == 33 || kc == 34 || kc == 35 || kc == 36 || kc == 37 || kc == 38 || kc == 39 || kc == 40 || kc == 46;')
    && c.includes('if (keyCode == 33 || keyCode == 34) { as_tf_vmove(tf, keyCode == 33 ? -1 : 1, as_tf_visible_lines(tf), 1, shift); return; }'));
  // 视觉行（软换行也计入）是 AIR 上下键的真实单位；行表来自 Skia 段落的逐行度量，
  // 无 Skia 时回落硬行扫描。
  check('Up/Down move between VISUAL lines through the shared vertical mover',
    c.includes('static int as_tf_line_table(TextField* tf, int* starts, int* ends, double* tops, int cap) {')
    && c.includes('int n = as_skia_textlayout_line_metrics(para, starts, ends, tops, NULL, cap);')
    && c.includes('static void as_tf_line_ud(TextField* tf, int dir, bool shift) { as_tf_vmove(tf, dir, 1, 0, shift); }'));
  check('the mover clamps a page against the text ends but stops an arrow at the edge',
    c.includes('if (target < 0) {')
    && c.includes('if (!page) return;')
    && c.includes('pos = 0;')
    && c.includes('pos = len;')
    && c.includes('if (!page && !tf->multiline) return;'));
  check('the column survives a clamp onto a short line',
    c.includes('tf->_goal_col = -1;')
    && c.includes('if (tf->_goal_col >= 0) col = tf->_goal_col;')
    && c.includes('if (!page) tf->_goal_col = col;')
    && c.includes('int llen = le - ls; if (llen < 0) llen = 0;'));
  check('scrollV follows the caret: top of view downward, bottom upward, arrows only when needed',
    c.includes('static void as_tf_scroll_caret(TextField* tf, int line, int dir) {')
    && c.includes('if (dir > 0) sv = line + 1;')
    && c.includes('else if (dir < 0) sv = line - vis + 2;')
    && c.includes('else { if (line < sv - 1) sv = line + 1; else if (line > sv - 1 + vis - 1) sv = line - vis + 2; }'));
  // TextField.text 里每个 Return 都是 CR，而 Skia 只认 LF 为硬换行：不归一化时整个
  // 多行文本会摊在一条视觉行上（实测 numLines=1）。归一化是逐字节的，索引不受影响。
  check('CR is normalized into Skia\'s LF before layout (byte-for-byte)',
    skiaGlue.includes('sk_textlayout_normalize')
    && skiaGlue.includes("if (*p != '\\r' && *p != '\\n') continue;")
    && (skiaGlue.match(/const char\* t = sk_textlayout_normalize\(text, collapseNewlines, normbuf\);/g) || []).length === 3);
  check('Shift+Home and Shift+End keep the measured asymmetric caret behaviour',
    c.includes('tf->_sel_begin = 0;')
    && c.includes('tf->_sel_end = (hi > caret) ? hi : caret;')
    && c.includes('tf->_sel_caret = len;'));
  check('Cmd+Left/Right equal Home/End and Option+Left/Right jump by word',
    c.includes('else if ((mod & ASC_MOD_CMD) != 0 && keyCode == 37) pos = 0;')
    && c.includes('else if ((mod & ASC_MOD_ALT) != 0 && keyCode == 39) pos = as_tf_word_right(as_tf_text(tf), len, caret);'));

  // 实测到的 AIR 怪癖：Shift+Delete 不动、Cmd 按住时的 keyUp 被吞、
  // 双击选词走保留的 "wordSelect" 通道。（“非可输入字段的拖拽不选词”是 C2 的误判，
  // 已在阶段九十四·八 用 Ed5 探针推翻：拖选门控只剩 selectable，键入仍限 input。）
  check('Shift+Delete is swallowed while an input field has focus',
    c.includes('keyCode == 46 && (mod & ASC_MOD_SHIFT) != 0 && tf != NULL && as_tf_is_input(tf)'));
  check('keyUps are dropped while Cmd is held except for the modifiers themselves',
    c.includes('(mod & ASC_MOD_CMD) != 0 && keyCode != 15 && keyCode != 16 && keyCode != 17 && keyCode != 18'));
  check('the drag selection no longer gates on type == input',
    !c.includes('as_tf_is_input(drag_tf)'));
  check('typing still requires an input field',
    c.includes('if (!as_tf_is_input(tf)) return;'));
  check('double-click word select is a maximal non-space run',
    c.includes('static void as_tf_word_select(TextField* tf, int idx) {')
    && c.includes('while (lo > 0 && !as_tf_is_space(t[lo - 1])) lo--;'));

  // displayAsPassword：排版串 = 一个字节一个 '*'（CR/LF 保留），.text 仍是明文。
  // 实测（adl 51.4.1，temp/editprobe/src/Ed16.as）：`_sans` 的 "W…W" 明文 113px、
  // 遮罩后 46.5px，且同一字段换成 "i…i" 也是 46.5px —— 两者量的是同一个星号串。
  check('the password mask is a separate layout string, never the .text value',
    c.includes('static const char* as_tf_layout_text(TextField* tf) {')
    && c.includes('if (!tf->displayAsPassword) return tf->text;')
    && c.includes('tf->_mask_src = tf->text;')
    && /const char\* ltext = as_tf_layout_text\(tf\);/.test(c));
  check('the mask emits one star per byte and keeps CR/LF as hard breaks',
    /m\[i\] = \(c == '\\r' \|\| c == '\\n'\) \? c : '\*';/.test(c)
    && c.includes('free(tf->_mask);'));
  check('the paragraph cache is keyed on the layout string, not on .text',
    c.includes('tf->_para_text == ltext') && c.includes('tf->_para_text = ltext;')
    && c.includes('as_skia_textlayout_new_leading(ltext, fmt->font'));
  check('the mask wins over htmlText runs while it is on',
    c.includes("tf->_runs->length > 0 && !tf->displayAsPassword"));
  // 实测：遮罩字段 Cmd+A 仍选中（SEL=0,3），但 Cmd+C / Cmd+X 拒写剪贴板（对照字段
  // 的同一手势复制出 "abcdefghij"）；Cut 连文本也不删。
  check('a password field refuses to copy its plaintext to the clipboard',
    /static void as_tf_copy_selection\(TextField\* tf\) \{[\s\S]{0,600}?if \(tf->displayAsPassword\) return;/.test(c));
  check('and refuses to cut (the text survives, the pasteboard stays empty)',
    /static void as_tf_cut\(TextField\* tf\) \{[\s\S]{0,300}?if \(tf->displayAsPassword\) return;/.test(c));
  // 实测：光标在 7 时 `text = "zz"` 读回 caretIndex 2、SEL 2,2（不是 0、也不是陈旧的 7）。
  check('text=... clamps the caret and the selection to the new length',
    c.includes('if (tf->_sel_caret > len) tf->_sel_caret = len;')
    && c.includes('if (tf->_sel_begin > len) tf->_sel_begin = len;')
    && c.includes('if (tf->_sel_end > len) tf->_sel_end = len;'));

  // dispatchEvent 的返回值 = 未被取消（textInput/change 的取消语义就靠它）。
  check('dispatchEvent returns whether the event survived',
    c.includes('return !event->cancelled;'));

  // 胶水：SDL_TEXTINPUT 收 UTF-8 文本（非美式键盘/输入法），并保留 wordSelect 通道。
  const glue = readFileSync(join(root, 'vendor', 'window_glue.cc'), 'utf8');
  check('the window glue feeds SDL_TEXTINPUT through the reserved textInput key type',
    glue.includes('case SDL_TEXTINPUT:') && glue.includes('on_key(id, "textInput", 0, 0, 0)') && glue.includes('SDL_StartTextInput();'));
  check('the glue routes SDL_TEXTINPUT by its own window id',
    glue.includes('e.text.windowID'));
  check('window_glue exposes sk_window_text_take',
    glue.includes('int sk_window_text_take(int id, char* buf, int cap)'));
  check('the glue emits the reserved wordSelect mouse type on a multi-click down',
    glue.includes('"wordSelect"') && glue.includes('e.button.clicks >= 2'));

  const preamble = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  check('the runtime declares sk_window_text_take for the window build',
    preamble.includes('extern int sk_window_text_take(int id, char* buf, int cap);'));
  check('the no-window build keeps a stub so a plain console binary still links',
    preamble.includes('static inline int sk_window_text_take(int id, char* buf, int cap)'));

  // ---- 阶段九十四·十七：IME 合成中态（marked text）预览 ------------------------
  // 合成串是「预览」不是文本：.text/caret/选区/numLines 一概不动，绘制层在光标处
  // 画合成本身 + 1px 下划线；平台送空 marked text = 合成结束；提交走既有 textInput。
  check('the glue stashes SDL_TEXTEDITING before SDL_TEXTINPUT',
    glue.indexOf('case SDL_TEXTEDITING:') > 0 &&
    glue.indexOf('case SDL_TEXTEDITING:') < glue.indexOf('case SDL_TEXTINPUT:'));
  check('SDL_TEXTEDITING is delivered through the reserved textEditing key type',
    /case SDL_TEXTEDITING:[\s\S]{0,1200}?on_key\(id, "textEditing", 0, 0, 0\)/.test(glue));
  check('the glue keeps the composition in its own buffer (text + start + length)',
    glue.includes('char edit_text[256];') && glue.includes('int edit_start;') && glue.includes('int edit_len;'));
  check('window_glue exposes sk_window_text_edit_take',
    glue.includes('int sk_window_text_edit_take(int id, char* buf, int cap, int* start, int* length)'));
  check('window_glue exposes sk_window_set_text_input_rect and forwards it to SDL',
    glue.includes('void sk_window_set_text_input_rect(int id, double x, double y, double w, double h)') &&
    glue.includes('SDL_SetTextInputRect'));
  check('the no-window build stubs both new glue entry points',
    preamble.includes('static inline int sk_window_text_edit_take(int id, char* buf, int cap, int* start, int* length)') &&
    preamble.includes('static inline void sk_window_set_text_input_rect(int id, double x, double y, double w, double h)'));
  const skia = readFileSync(join(root, 'vendor', 'skia_glue.cc'), 'utf8');
  check('skia_glue exposes the caret rect lookup used to place the preview',
    skia.includes('int sk_textlayout_caret_rect(void* para, int index, double* x, double* y, double* h)'));
  check('the caret rect falls back to the previous glyph box at the end of the text',
    /getRectsForRange\(i, i \+ 1u[\s\S]{0,300}?getRectsForRange\(i - 1u, i/.test(skia));
  check('the runtime declares the caret rect for the window build',
    preamble.includes('extern int sk_textlayout_caret_rect(void* para, int index, double* x, double* y, double* h);'));

  check('the TextField carries composition state of its own',
    c.includes('char* _comp;') && c.includes('int _comp_start;') && c.includes('int _comp_len;'));
  check('as_tf_set_comp copies the composition and frees the previous one',
    /static void as_tf_set_comp\(TextField\* tf, const char\* text, int start, int length\) \{[\s\S]{0,300}?free\(tf->_comp\);/.test(c));
  check('an empty composition means "composition ended" and clears the preview',
    /static void as_tf_set_comp\(TextField\* tf, const char\* text, int start, int length\) \{[\s\S]{0,400}?if \(text == NULL \|\| text\[0\] == 0\) return;/.test(c));
  check('Stage.dispatchTextEditing targets the focused editable field only',
    /static void Stage_dispatchTextEditing\(void\* _this, char\* text, int start, int length\) \{[\s\S]{0,260}?as_is\(\(void\*\)as_focus_obj, &TextField_vt\)[\s\S]{0,160}?!as_tf_is_input\(tf\)\) return;/.test(c));
  const dte = /static void Stage_dispatchTextEditing\(void\* _this, char\* text, int start, int length\) \{[\s\S]*?\n\}\n/.exec(c)?.[0] ?? '';
  check('the composition leaves .text alone (it is only stored, never spliced)',
    dte.length > 0 && !dte.includes('as_tf_splice') && !dte.includes('as_tf_insert_text'));
  const dt = /static void Stage_dispatchText\(void\* _this, char\* text\) \{[\s\S]*?\n\}\n/.exec(c)?.[0] ?? '';
  check('the commit path drops the preview before splicing the text',
    dt.includes('as_tf_set_comp(tf, NULL, -1, 0);') &&
    dt.indexOf('as_tf_set_comp(tf, NULL, -1, 0);') < dt.indexOf('as_tf_insert_text(tf'));
  check('the window key bridge handles the reserved textEditing type',
    /strcmp\(type, "textEditing"\) == 0[\s\S]{0,200}?sk_window_text_edit_take[\s\S]{0,200}?Stage_dispatchTextEditing/.test(c));
  check('the candidate window follows the caret through the stage transform',
    /ASC_ime_roi_valid[\s\S]{0,200}?sk_window_set_text_input_rect\(id, w->ox \+ ASC_ime_roi\[0\] \* w->cx/.test(c));
  check('the renderer paints the composition at the caret with an underline',
    /if \(tf->_comp != NULL && tf->_comp\[0\] != 0\)/.test(c) &&
    /tf->_comp != NULL && tf->_comp\[0\] != 0[\s\S]{0,1200}?as_skia_canvas_draw_rect\(canvas, px, py/.test(c));
  check('the composition state is part of the invalidation fingerprint',
    /h = as_fp_str\(h, tf->_comp\);/.test(c) && c.includes('static inline uint32_t as_fp_str(uint32_t h, const char* s)'));
  check('the caret and the password mask are fingerprinted for the same reason',
    /h = as_fp_i32\(h, tf->_sel_caret\);/.test(c) && /h = as_fp_bool\(h, tf->displayAsPassword\);/.test(c));
  check('Skia range queries receive UTF-16 indices, not our byte offsets',
    c.includes('static int as_tf_utf16_index(TextField* tf, int byteIndex)') &&
    /as_skia_textlayout_caret_rect\(para, as_tf_utf16_index\(tf, as_tf_caret\(tf\)\)/.test(c) &&
    /as_skia_textlayout_rects_for_range\(para, selB, selE/.test(c));
  check('Stage.dispatchTextEditing(text, start, length) is registered as a headless hook',
    c.includes('Stage_dispatchTextEditing((') &&
    readFileSync(join(root, 'src', 'symbols.ts'), 'utf8').includes("['dispatchTextEditing', { returnType: { kind: 'void' }"));

  if (ok > 0) console.log(`[textinput] ${ok} text input checks passed`);
  return bad;
}

// ---- 阶段九十四·八：TextField 边框 + 「动态可选文本」的鼠标选区 ----------------
// 口径全部来自 temp/editprobe/ 的双端对照（探针 src/Ed5.as 逐事件上报 + drive_ed5.py
// + cmp_ed5.py 结构化比较器（adl 51.4.1）；边框像素来自 src/Ed6.as 的 BitmapData.draw
// 扫描与 src/Ed7.as 的真窗口截图双端比对）。这里钉住发射出的 C。
function checkTextSelection(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [textsel] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [textsel] ${label}`); }
  };
  const c = generateC(parse('import flash.text.TextField;\nvar f:TextField = new TextField();\nf.border = true;\nf.borderColor = 0x00FF00;\nf.background = true;\nf.backgroundColor = 0xFFFFFF;\nf.textColor = 0;\n')).c;

  // border/borderColor 是真实槽（反射表里要有），默认值按 adl 实测。
  check('TextField declares border/borderColor slots',
    c.includes('bool border;') && c.includes('unsigned int borderColor;')
    && c.includes('{ "border", 2, offsetof(TextField, border) }')
    && c.includes('{ "borderColor", 5, offsetof(TextField, borderColor) }'));
  check('the constructor defaults match adl (border false, borderColor 0, backgroundColor 0xFFFFFF)',
    c.includes('o->border = false;') && c.includes('o->borderColor = 0x000000u;')
    && c.includes('o->backgroundColor = 0xFFFFFFu;'));

  // 三个颜色属性写入时丢掉 alpha 字节（adl 实测：0x8000FF00 读回 0xff00）。
  check('colour setters DROP the alpha byte, like adl',
    c.includes('void TextField_set_borderColor(void* _this, unsigned int value) { ((TextField*)_this)->borderColor = value & 0xFFFFFFu; }')
    && c.includes('((TextField*)_this)->backgroundColor = value & 0xFFFFFFu;')
    && c.includes('((TextField*)_this)->textColor = value & 0xFFFFFFu;'));
  check('the colour properties keep plain field reads and only write through setters',
    c.includes('unsigned int TextField_get_borderColor')
    || c.includes('{ "borderColor", 5, offsetof(TextField, borderColor) }'));

  // 边框渲染：背景之后、文本 clip 之前画四条像素对齐的填充矩形（非 1px 描边）。
  // 阶段九十四·二十一 起厚度不再是常量 1 局部单位，而是屏幕空间的
  // `ASC_render_scale / 画布每轴缩放`（见 [border1px] 组），四条边仍必须是**填充矩形**
  // ——半个像素的居中描边会把外缘那一列/行只盖一半，正是 adl 实测要避免的。
  check('the border draws four pixel-aligned fill rects, not a stroke',
    /if \(tf->border\) \{[\s\S]{0,1400}?as_skia_canvas_draw_rect\(canvas, 0\.0, 0\.0, bw \+ btx, bty, bd\);[\s\S]{0,240}?as_skia_canvas_draw_rect\(canvas, bw, 0\.0, btx, bh \+ bty, bd\);/.test(c)
    && !/as_skia_paint_set_stroke\(bd/.test(c));
  check('the border sits outside the background gate and before the text clip',
    /if \(tf->background\) \{[\s\S]{0,400}?if \(tf->border\) \{[\s\S]{0,1800}?as_skia_canvas_clip_rect\(canvas, 0\.0, 0\.0, tf->_fieldWidth, tf->_fieldHeight\)/.test(c));
  // 阶段一百二十八：`draw` 侧的 `+1` 经 adl 51.4.1 离屏实测定案（temp/bakeprobe/，20 行三端
  // 一致）——`bd.draw(field, scale(k))` 的墨迹是 `width*k + 1`，且边框在**任何 k 下都是 1 个
  // 位图像素**。故栅格化尺寸 = `ceil(fieldWidth * rs) + 1`（`rs` = 矩阵缩放，栅格 1:1 读回），
  // 而不是「1× 栅格 + 1 局部单位再被采样器放大」（那会给出 2/3 px 的边框）。
  // `as_render_bounds` 的那个 `+1` 局部单位仍保留——它只服务烘焙/滤镜**面尺寸**（略大无害）。
  check('a bordered field measures one pixel wider/taller for bake and draw',
    c.includes('*r = tf->_fieldWidth + (tf->border ? 1.0 : 0.0);')
    && c.includes('*b = tf->_fieldHeight + (tf->border ? 1.0 : 0.0);')
    && c.includes('sw = (int)ceil(tf->_fieldWidth * rs) + (tf->border ? 1 : 0);')
    && c.includes('sh = (int)ceil(tf->_fieldHeight * rs) + (tf->border ? 1 : 0);'));
  check('the auto-bake fingerprint covers the border',
    c.includes('h = as_fp_bool(h, tf->border); h = as_fp_u32(h, tf->borderColor);'));

  // 拖选：C2 依据单次合成拖拽写成的「仅 type=input 生效」已被 Ed5 实推翻，
  // 门控只剩 selectable；半开区间 [begin,end) 的「点在选择区内」按实测实现。
  check('the drag selection gate is selectable, NOT type == input',
    /if \(strcmp\(type, "mouseDown"\) == 0\) \{[\s\S]{0,600}?\(\(TextField\*\)target\)->selectable\)/.test(c)
    && !c.includes('as_tf_is_input(drag_tf)'));
  check('a press on the HALF-OPEN span [begin, end) keeps the existing selection',
    c.includes('if (tf->_sel_end > tf->_sel_begin && idx >= tf->_sel_begin && idx < tf->_sel_end) {')
    && c.includes('drag_anchor = -2;'));
  check('the kept selection collapses onto the release index at mouseUp',
    /strcmp\(type, "mouseUp"\) == 0\) \{[\s\S]{0,300}?if \(drag_tf != NULL && drag_anchor == -2\) \{[\s\S]{0,420}?drag_tf->_sel_begin = idx; drag_tf->_sel_end = idx; drag_tf->_sel_caret = idx;/.test(c));
  check('the drag state is FILE scope so the wordSelect bridge can clear it',
    /static TextField\* drag_tf = NULL;\nstatic int drag_anchor = -1;\nstatic void Stage_dispatchMouse/.test(c)
    && !/void Stage_dispatchMouse[\s\S]{0,200}static TextField\* drag_tf/.test(c));
  check('a word select cancels the pending collapse from the double click\'s mouseDown',
    /as_tf_word_select\(tf, as_tf_index_at\(tf, tfx, tfy\)\);[\s\S]{0,60}?drag_tf = NULL;[\s\S]{0,40}?drag_anchor = -1;/.test(c));
  check('dynamic fields drag-select too — no input-only wording left',
    !/drag[\s\S]{0,80}only[\s\S]{0,80}input/i.test(c));

  return bad;
}

registerGroup('unit: text-input/DoubleClick', checkDoubleClick);
registerGroup('unit: text-input/TabFocus', checkTabFocus);
registerGroup('unit: text-input/Restrict', checkRestrict);
registerGroup('unit: text-input/TextInput', checkTextInput);
registerGroup('unit: text-input/TextSelection', checkTextSelection);
