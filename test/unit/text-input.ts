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
import { readGlue } from '../harness.ts';

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
  // Read the struct BODY instead of a fixed-size window: a window is a proxy that
  // breaks every time DisplayObject grows a field (it did, at 932 characters), while
  // brace matching keeps asserting the real claim.
  const iobjBody = (() => {
    const at = c.indexOf('struct InteractiveObject {');
    if (at < 0) return '';
    const open = c.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < c.length; i++) {
      if (c[i] === '{') depth++;
      else if (c[i] === '}' && --depth === 0) return c.slice(open + 1, i);
    }
    return '';
  })();
  check('InteractiveObject declares doubleClickEnabled',
    iobjBody.includes('bool doubleClickEnabled;'));
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
  // The pipeline function is as_tf_insert_payload (the Return synthesis needs a
  // payload that differs from what is inserted); as_tf_insert_text is the
  // one-string wrapper a typed character or a paste comes through.
  const ins = /static void as_tf_insert_payload\([\s\S]*?\n\}\n/.exec(c)?.[0] ?? '';
  check('the filter runs after the textInput dispatch, so the event keeps the raw text',
    ins.indexOf('as_tf_restrict_char') > ins.indexOf('if (te->cancelled) return;'));
  check('restrict is only consulted when the pattern is non-NULL',
    ins.includes('if (tf->___restrict != NULL) {') && ins.includes('ins = filtered;'));
  check('newlines bypass the filter (measured: Return still inserts in a multiline field)',
    ins.includes('if (c == 13 || c == 10) filtered[fn++] = (char)c;'));
  check('the filtered string is what gets spliced (so it keeps the maxChars/selection semantics)',
    ins.includes('if (as_tf_splice(tf, lo, hi, ins)) as_tf_dispatch_change(tf);'));
  check('the payload is what the event carries, defaulting to the inserted text',
    ins.includes('TextEvent_new((char*)"textInput", true, true, (char*)(payload != NULL ? payload : text))'));
  // (4) 只作用于用户输入：text 赋值路径完全不经过 restrict。
  check('the TextField.text setter never consults restrict',
    /static void TextField_set_text\(void\* _this, char\* value\) \{[\s\S]{0,600}?\n\}/.test(c) &&
    !/static void TextField_set_text\(void\* _this, char\* value\) \{[\s\S]{0,600}?as_tf_restrict/.test(c));
  // (5) 粘贴与单字符走同一条管道（因此也过滤）：as_tf_insert_text 是单串包装。
  const paste = /static void as_tf_paste\([\s\S]*?\n\}\n/.exec(c)?.[0] ?? '';
  check('paste routes through the one-string pipeline, so restrict applies to it too',
    paste.includes('as_tf_insert_text(tf, buf);') && c.includes('static void as_tf_insert_text(TextField* tf, const char* text) { as_tf_insert_payload(tf, text, text); }'));
  // (6) Return 的换行：SDL2/Cocoa 从不为 Return 产生 text，故在 keyDown 上合成提交；
  // 载荷是 "\n"（adl）而插入的是 CR —— 所以走的是两串形态。
  check('Return synthesizes its text commit for a multiline editable field',
    c.includes('if (keyCode == 13 && tf->multiline) as_tf_insert_payload(tf, "\\n", "\\r");'));
  check('the Return commit sits in the keyDown-only path, after the editable-field guard',
    /if \(!down\) return;[\s\S]{0,1400}?if \(keyCode == 13 && tf->multiline\) as_tf_insert_payload/.test(c) &&
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
  const skiaGlue = readGlue();

  // 常量与构造：TextFieldType 是普通 const 类，TextEvent 继承 Event 且带 text 槽。
  check('TextFieldType exposes INPUT/DYNAMIC as measured constants',
    c.includes('TextFieldType_INPUT') && c.includes('"input"') && c.includes('"dynamic"'));
  check('TextEvent carries a text payload and the TEXT_INPUT constant',
    c.includes('{ "text", 3, offsetof(TextEvent, text), NULL, NULL, 0, 0, 0 }')
    && c.includes('static char* const TextEvent_TEXT_INPUT = "textInput";'));
  check('TextEvent constructs through the measured (type, bubbles, cancelable, text) shape',
    c.includes('static TextEvent* TextEvent_new(char* type, bool bubbles, bool cancelable, char* text) {')
    && c.includes('Event_ctor((Event*)o, type, bubbles, cancelable); o->text = text;'));

  // 新字段：type/maxChars/displayAsPassword/restrict。restrict 是 C 关键字，须走 cIdent 的名。
  check('TextField stores the editable-text slots',
    /\nstruct TextField \{[\s\S]{0,2000}?char\* type;/.test(c)
    && /\nstruct TextField \{[\s\S]{0,2000}?int maxChars;/.test(c)
    && /\nstruct TextField \{[\s\S]{0,2000}?bool displayAsPassword;/.test(c)
    && /\nstruct TextField \{[\s\S]{0,2000}?char\* ___restrict;/.test(c));

  // 默认值（adl 逐项实测，temp/editprobe/src/Def.as）：dynamic / 无限 / 非密码 /
  // tabEnabled **false**（不是 true）/ restrict NULL，且 text 是空字符串而非 NULL。
  check('the TextField defaults match the measured adl values',
    c.includes('o->type = (char*)"dynamic";')
    && c.includes('o->maxChars = 0;')
    && c.includes('o->displayAsPassword = false;')
    && c.includes('o->tabEnabled = false;')
    && c.includes('o->___restrict = NULL;'));
  // `as_str_empty()` (not a bare one-byte as_str_alloc) so the byte is really
  // terminated: the GC does not zero GCT_STRING, and a forgotten write made the
  // field report whatever the recycled block held (阶段一百四十九).
  check('a fresh field reports "" (not a NULL string) for text',
    c.includes('o->text = as_str_empty();') && !c.includes('o->text = NULL;'));
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
    /as_v_str\(\([^\n]*g_f[^\n]*->___restrict\)\)/.test(nb) && nb.includes('as_v_loose_eq(g_x, as_v_null())'));

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
  // 遮罩**不**吞掉 run 表（2026-10-11 阶段一百三十五 / L8154 实测推翻旧决定）：
  // adl 上带 24px 红 run 的 htmlText 字段开遮罩后，行盒/run 大小/红色星星号与不遮罩时
  // 同结构（C 行盒 30.28 = B），故星号按所属 run 排版；排版串仍是星号串。
  check('the mask keeps the htmlText runs (each star takes its run\'s style)',
    c.includes('int hasRuns = (tf->_runs != NULL && tf->_runs->length > 0);')
    && !c.includes('length > 0 && !tf->displayAsPassword')
    && c.includes('as_skia_textlayout_new_runs(ltext, &dr, runs, n, pw, pa, collapse);'));
  // 实测：遮罩字段 Cmd+A 仍选中（SEL=0,3），但 Cmd+C / Cmd+X 拒写剪贴板（对照字段
  // 的同一手势复制出 "abcdefghij"）；Cut 连文本也不删。
  check('a password field refuses to copy its plaintext to the clipboard',
    /static void as_tf_copy_selection\(TextField\* tf\) \{[\s\S]{0,600}?if \(tf->displayAsPassword\) return;/.test(c));
  check('and refuses to cut (the text survives, the pasteboard stays empty)',
    /static void as_tf_cut\(TextField\* tf\) \{[\s\S]{0,300}?if \(tf->displayAsPassword\) return;/.test(c));
  // 阶段三百三十七 复测（temp/maxsh/Main9.as）：赋 `.text` 一律把选区与光标**重置为 0**，
  // 不是「钳到新长度」—— 同串、更长、更短、空串、INPUT 字段五种情形全部读到 0,0。
  check('text=... resets the caret and the selection to 0',
    c.includes('tf->_sel_caret = 0;')
    && c.includes('tf->_sel_begin = 0;')
    && c.includes('tf->_sel_end = 0;')
    && !c.includes('if (tf->_sel_caret > len) tf->_sel_caret = len;'));

  // dispatchEvent 的返回值 = 未被取消（textInput/change 的取消语义就靠它）。
  check('dispatchEvent returns whether the event survived',
    c.includes('return !event->cancelled;'));

  // 胶水：SDL_TEXTINPUT 收 UTF-8 文本（非美式键盘/输入法），并保留 wordSelect 通道。
  const glue = readFileSync(join(root, 'vendor', 'window_glue.cc'), 'utf8');
  check('the window glue feeds SDL_TEXTINPUT through the reserved textInput key type',
    glue.includes('case SDL_TEXTINPUT:') && glue.includes('on_key(id, "textInput", 0, 0, 0)') && glue.includes('SDL_StartTextInput();'));
  // Text input is started EXACTLY ONCE, at window creation, and never re-issued on
  // focus gain. Measured on macOS/SDL 2.32.10 (temp/keyprobe, A/B, 2026-10-19): a
  // window that only ever got the creation-time call receives SDL_TEXTINPUT from the
  // app's first keystroke, and SDL itself handles the lose/regain-focus transition --
  // its own header says desktop platforms start text input implicitly at video init.
  // A SDL_WINDOWEVENT_FOCUS_GAINED handler calling SDL_StartTextInput() was added once
  // on the strength of "clicking the field focused it but no textInput ever fired";
  // that observation was an artifact of testing under a CJK input method (letters
  // enter the IME's composition and emit nothing until Enter commits them), it did not
  // reproduce under the A/B, and the handler was removed. This pin keeps it from being
  // re-added on the same non-evidence -- if a future backend really does need it, this
  // check is where the reason has to be written down.
  const startCalls = glue.match(/SDL_StartTextInput\(\);/g) ?? [];
  check('the glue starts text input once (at creation), never on focus gain',
    startCalls.length === 1 && !/FOCUS_GAINED[\s\S]{0,800}?SDL_StartTextInput\(\)/.test(glue));
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
  // The routing chain in front of the switch must resolve SDL_TEXTEDITING too. It did
  // not, so the event fell through to the 0 default, sk_id_from_window_id(0) answered
  // -1 and the whole composition was dropped BEFORE the switch: measured on Windows 11
  // + Microsoft Pinyin (temp/imelive, trace5: 15 x type=770 with zero dispatch lines)
  // the field never showed marked text and sk_window_set_text_input_rect was never
  // called, so there was no preview and no candidate window either.
  check('the window-id chain routes SDL_TEXTEDITING (it is not the 0 default)',
    glue.includes('e.type == SDL_TEXTEDITING ? e.edit.windowID :'));
  // SDL defaults its Windows IME backend to UILess (TSF), where the native candidate
  // window is suppressed and the app is expected to draw the candidate list itself --
  // through IME_Present(), which no public API in SDL 2.32 exposes (no caller in the
  // tree). Measured A/B on the same probe: without the hint only the inline marked text
  // appears (q2-type2.png); with it the candidate list shows under the caret
  // (q1-type2.png), which is what adl 51.4.1 does (ad-type2.png).
  check('the video init asks SDL for the native IME candidate window',
    /static int sk_video_init\(void\) \{[\s\S]*?SDL_SetHint\(SDL_HINT_IME_SHOW_UI, "1"\);[\s\S]*?return SDL_Init\(SDL_INIT_VIDEO\);/.test(glue));
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
  const skia = readGlue();
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
    /static void Stage_dispatchTextEditing\(void\* _this, char\* text, int start, int length\) \{[\s\S]{0,260}?as_is\(\(void\*\)as_focus_obj, &TextField_vt\)[\s\S]{0,400}?!as_tf_is_input\(tf\)\) return;/.test(c));
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
    && c.includes('{ "border", 2, offsetof(TextField, border), NULL, NULL, 0, 0, 0 }')
    && c.includes('{ "borderColor", 5, offsetof(TextField, borderColor), NULL, NULL, 0, 0, 0 }'));
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
    || c.includes('{ "borderColor", 5, offsetof(TextField, borderColor), NULL, NULL, 0, 0, 0 }'));

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
    /static TextField\* drag_tf = NULL;\nstatic int drag_anchor = -1;/.test(c)
    && !/void Stage_dispatchMouse[\s\S]{0,200}static TextField\* drag_tf/.test(c));
  check('a word select cancels the pending collapse from the double click\'s mouseDown',
    /as_tf_word_select\(tf, as_tf_index_at\(tf, tfx, tfy\)\);[\s\S]{0,60}?drag_tf = NULL;[\s\S]{0,40}?drag_anchor = -1;/.test(c));
  check('dynamic fields drag-select too — no input-only wording left',
    !/drag[\s\S]{0,80}only[\s\S]{0,80}input/i.test(c));

  return bad;
}

// Insertion caret (阶段一百三十五). adl ground truth: the caret is a player OVERLAY,
// not part of the field's rasterization — measured on adl 51.4.1 that
// `BitmapData.draw` of a focused editable field captures NO caret at all
// (temp/caretprobe: 14 samples over 1.7 s, every one empty). We reproduce that by
// drawing the caret only in a window/compose pass (ASC_caret_pass): a 1-device-pixel
// bar in the field's text colour, blinking on a ~500 ms half period whose clock
// restarts on focus / caret move / keystroke.
function checkCaret(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [caret] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [caret] ${label}`); }
  };
  const c = generateC(parse(
    'import flash.display.Stage;\n' +
    'import flash.text.TextField;\n' +
    'var s:Stage = new Stage();\n' +
    'var f:TextField = new TextField();\n' +
    's.addChild(f);\n' +
    's.focus = f;\n')).c;

  // (1) blink clock + ~500 ms half period.
  check('the caret blink clock exists and restarts on demand',
    c.includes('static double as_tf_blink_t0 = 0.0;')
    && c.includes('static void as_tf_blink_reset(void) { as_tf_blink_t0 = as_now_ms(); }'));
  check('the caret blinks on a 500 ms half period',
    /static int as_tf_caret_on\(void\) \{[\s\S]{0,320}?\(\(long\)\(dt \/ 500\.0\) % 2\) == 0/.test(c));
  // (2) the clock restarts on focus / caret move / extend, so the caret is solid
  // right after the user acts instead of flickering off mid-keystroke.
  check('focus change restarts the blink',
    /void as_set_focus\(DisplayObject\* obj\) \{[\s\S]{0,420}?as_tf_blink_reset\(\);/.test(c));
  check('a plain caret move restarts the blink',
    /static void as_tf_set_caret\(TextField\* tf, int pos\) \{[\s\S]{0,420}?as_tf_blink_reset\(\);/.test(c));
  check('a shift-extend restarts the blink',
    /static void as_tf_extend_caret\(TextField\* tf, int pos\) \{[\s\S]{0,520}?as_tf_blink_reset\(\);/.test(c));
  // (3) drawn only in a window/compose pass and only on a focused + selectable
  // field, as a 1-device-pixel fill rect at the caret box in the text colour.
  // 阶段二百四十二: the gate also requires an INPUT field -- measured on adl 51.4.1, a
  // focused selectable DYNAMIC field draws no caret (the selection band still paints).
  check('the caret is gated on the window pass, on focused + selectable, and on INPUT',
    c.includes('if (ASC_caret_pass && as_focus_obj == (void*)tf && tf->selectable && as_tf_is_input(tf)) {'));
  check('the caret bar is a 1-device-pixel fill rect at the caret box, in the text colour',
    /if \(ASC_caret_pass && as_focus_obj == \(void\*\)tf && tf->selectable && as_tf_is_input\(tf\)\) \{[\s\S]{0,900}?as_skia_textlayout_caret_rect\(para, as_tf_utf16_index\(tf, as_tf_caret\(tf\)\), &kcx, &kcy, &kch\)[\s\S]{0,1400}?as_skia_paint_fill\(kcol, 1\.0\)[\s\S]{0,180}?as_skia_canvas_draw_rect\(canvas, 2\.0 \+ alignDx - scrollX \+ kcx \+ kdx, 2\.0 - scrollY \+ kcy, kw, kch, kp\)/.test(c));
  // adl 51.4.1 keeps the caret AFTER the marked text while composing (temp/imelive/
  // adz-blink2.png: the bar sits right of "kuang" with the underlined composition
  // still uncommitted), so the bar is offset by the composition advance -- measured
  // with the same paragraph the preview draws, so the two never disagree.
  check('the caret moves to the end of the IME composition while one is active',
    /if \(ASC_caret_pass && as_focus_obj == \(void\*\)tf[\s\S]{0,1200}?double kdx = 0\.0;[\s\S]{0,400}?kdx = as_tf_longest_line\(kcp\);[\s\S]{0,400}?as_skia_canvas_draw_rect\(canvas, 2\.0 \+ alignDx - scrollX \+ kcx \+ kdx/.test(c));
  check('the caret width is one DEVICE pixel (scale divided out), like the border',
    /double kw = ASC_render_scale \/ ksx;/.test(c));
  // (4) the window compose pass switches it on; Stage.render (the screenshot hook)
  // does too; the fingerprint and every bake never do.
  check('ASC_window_render enables the caret pass around the display list only',
    /as_render_fp\(\(DisplayObject\*\)st\);\n\s*ASC_caret_pass = 1;\n\s*as_render_object\(canvas, \(DisplayObject\*\)st\);\n\s*ASC_caret_pass = 0;/.test(c));
  check('Stage.render (screenshot hook) enables the caret pass',
    /as_render_fp\(\(DisplayObject\*\)_this\);\n\s*ASC_caret_pass = 1;\n\s*as_render_object\(canvas, \(DisplayObject\*\)_this\);\n\s*ASC_caret_pass = 0;/.test(c));
  const fp = c.match(/static uint32_t as_render_fp\(DisplayObject\* o\) \{[\s\S]*?\n\}/);
  check('the fingerprint never depends on the caret pass (a bake must not capture a caret)',
    fp !== null && !/ASC_caret_pass/.test(fp[0]));
  // (5) a focused TextField renders live, never from a bake (the caret blinks).
  check('a focused TextField is never served from a bake',
    c.includes('!(as_is(o, &TextField_vt) && as_focus_obj == (void*)o)'));
  return bad;
}

// ---- TODO L8152 / L8155: the index domain of the visual line table, and the
// payload of a multiline Return ----
// Two measured defects that share one root: this runtime indexes strings by UTF-8
// BYTE while Skia's paragraph answers in UTF-16 CODE UNITS, and the domains only
// coincide for ASCII.
//   * the visual line table handed Skia's code-unit starts to as_tf_line_of_index /
//     as_tf_line_end, which compare them against a byte caret. Measured on a
//     wrapped all-CJK field (temp/linecjk, 7 characters = 21 bytes / 7 units, lines
//     4+3 so bytes start at 0/12 while units start at 0/4): Down from byte 0 landed
//     on byte 4 -- inside the first character -- and Down from byte 6 (inside line
//     0) did not move AT ALL, because unit start 4 <= byte 6 read as "already on
//     line 1"; the click path reported the unit count (2) instead of the byte index
//     (6). After the fix the same probe returns 12 / 18 (start + kept column 6) / 6.
//   * a multiline Return dispatches `TextEvent.TEXT_INPUT` with text "\n" (adl
//     51.4.1) while the field's own text gains a CR -- one event, two strings.
function checkIndexDomain(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [indexdomain] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [indexdomain] ${label}`); }
  };
  const c = generateC(parse(
    'import flash.display.Stage;\n' +
    'import flash.text.TextField;\n' +
    'var s:Stage = new Stage();\n' +
    'var f:TextField = new TextField();\n' +
    'f.multiline = true;\n' +
    's.addChild(f);\n' +
    's.focus = f;\n')).c;

  // (1) the inverse of as_tf_utf16_index, and the mask identity: a masked paragraph
  // is laid out from one ASCII star per BYTE, so its code-unit index IS the byte
  // index -- the plaintext count would land short on CJK.
  check('a byte index is the inverse of the code-unit index',
    c.includes('static int as_tf_byte_index(TextField* tf, int unitIndex) {')
    && /int units = 0, i = 0;\n\s*while \(i < n && units < unitIndex\) \{/.test(c));
  check('the masked paragraph keeps the identity in BOTH directions',
    /static int as_tf_utf16_index\(TextField\* tf, int byteIndex\) \{[\s\S]{0,420}?if \(tf->displayAsPassword\) return byteIndex;/.test(c)
    && /static int as_tf_byte_index\(TextField\* tf, int unitIndex\) \{[\s\S]{0,260}?displayAsPassword\) \{ int m = \(int\)strlen\(s\); return unitIndex > m \? m : unitIndex; \}/.test(c));

  // (2) the visual line table converts Skia's answer at its exit, so every consumer
  // (as_tf_line_of_index, as_tf_line_end's CR test, the column arithmetic, the
  // scroll target) stays in bytes; the no-Skia fallback already scans bytes.
  check('the visual line table hands out BYTE offsets, not Skia code units',
    /int n = as_skia_textlayout_line_metrics\(para, starts, ends, tops, NULL, cap\);\n\s*if \(n > 0\) \{[\s\S]{0,260}?if \(starts != NULL\) starts\[i\] = as_tf_byte_index\(tf, starts\[i\]\);\n\s*if \(ends != NULL\) ends\[i\] = as_tf_byte_index\(tf, ends\[i\]\);/.test(c));
  check('the CR/LF fallback table is byte-indexed too (both paths agree)',
    /int le = ls;\n\s*while \(le < len && t\[le\] != 13 && t\[le\] != 10\) le\++;/.test(c));
  check('a click maps Skia\'s answer back to a byte index',
    /int idx = as_skia_textlayout_glyph_position_at\(para, lx, ly\);\n\s*if \(idx < 0\) idx = 0;\n\s*idx = as_tf_byte_index\(tf, idx\);/.test(c));

  // (3) Return: the payload and the inserted text are separate arguments, and the
  // synthesis passes "\n" as the payload while splicing a CR.
  check('the text pipeline takes the event payload and the inserted text separately',
    c.includes('static void as_tf_insert_payload(TextField* tf, const char* payload, const char* text) {')
    && /TextEvent\* te = TextEvent_new\(\(char\*\)"textInput", true, true, \(char\*\)\(payload != NULL \? payload : text\)\);/.test(c));
  check('a typed or pasted character passes its text as both',
    c.includes('static void as_tf_insert_text(TextField* tf, const char* text) { as_tf_insert_payload(tf, text, text); }'));
  check('a multiline Return dispatches "\\n" while inserting a CR',
    c.includes('if (keyCode == 13 && tf->multiline) as_tf_insert_payload(tf, "\\n", "\\r");'));
  return bad;
}

// ---- TODO L8154: displayAsPassword x htmlText (mask keeps the runs) ----
//
// Measured on adl 51.3.2 (temp/pwdhtml, five cases): a field whose htmlText gives
// its first character a 24px RED run reports the SAME paragraph metrics masked as
// unmasked (line 0 height 30.28 / ascent 23.29 against 13.98 / 11.65 for the plain
// control) and the drawn star for that character is the 24px one, in red. A
// run-free masked field keeps the default format (identical to the plain control),
// so the mask replaces the GLYPHS and not the styles.
function checkMaskHtml(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [maskhtml] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [maskhtml] ${label}`); }
  };
  const c = generateC(parse(
    'import flash.display.Stage;\n' +
    'import flash.text.TextField;\n' +
    'import flash.text.TextFormat;\n' +
    'var s:Stage = new Stage();\n' +
    'var f:TextField = new TextField();\n' +
    'f.htmlText = "<font size=\'24\' color=\'#ff0000\'>A</font>aaaa";\n' +
    'f.displayAsPassword = true;\n' +
    's.addChild(f);\n')).c;

  check('the mask does not suppress the run table any more',
    c.includes('int hasRuns = (tf->_runs != NULL && tf->_runs->length > 0);')
    && !c.includes('&& !tf->displayAsPassword);'));
  check('the masked layout still comes from the star string',
    /static const char\* as_tf_layout_text\(TextField\* tf\) \{[\s\S]{0,200}?if \(!tf->displayAsPassword\) return tf->text;/.test(c)
    && c.includes("m[i] = (c == '\\r' || c == '\\n') ? c : '*';"));
  check('the runs are built from the LAYOUT text, so a run\'s byte range lands on its stars',
    c.includes('void* pr = as_skia_textlayout_new_runs(ltext, &dr, runs, n, 0.0, 0, collapse);')
    && c.includes('tf->_para = as_skia_textlayout_new_runs(ltext, &dr, runs, n, pw, pa, collapse);')
    && !/as_skia_textlayout_new_runs\(tf->text/.test(c));
  return bad;
}

registerGroup('unit: text-input/DoubleClick', checkDoubleClick);
registerGroup('unit: text-input/TabFocus', checkTabFocus);
registerGroup('unit: text-input/Restrict', checkRestrict);
registerGroup('unit: text-input/TextInput', checkTextInput);
registerGroup('unit: text-input/TextSelection', checkTextSelection);
registerGroup('unit: text-input/Caret', checkCaret);
registerGroup('unit: text-input/IndexDomain', checkIndexDomain);
registerGroup('unit: text-input/MaskHtml', checkMaskHtml);

// ---- flash.text.StyleSheet + the HTML block model (阶段一百四十八) --------------
//
// Measured on adl 51.4.1 (temp/fpsprobe2, temp/blockprobe, temp/ssprobe): the FPS
// overlay of the talkmed-meeting app renders FIVE numLines for a field whose
// `multiline` is left at its default (false). The mechanism is the stylesheet rule,
// not <br>:
//   * a tag with NO rule that AIR has no inline rendering for (fps/ms/mem/memMax/
//     xml/head/bold/em/div...) becomes a BLOCK, and the break is emitted AFTER its
//     close -- independent of `multiline`;
//   * the tags AIR does render inline (span/p/b/i/u/font/a/li/br/img/textformat) never
//     become blocks, not even with display:block;
//   * display:inline downgrades an unknown tag back to inline, display:none hides
//     the element;
//   * <br> and </p> end a line ONLY when multiline is true;
//   * selectors/tags are matched case-insensitively and stored lowercased.
function checkStyleSheet(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [stylesheet] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stylesheet] ${label}`); }
  };
  const c = generateC(parse(
    'import flash.display.Stage;\n' +
    'import flash.text.TextField;\n' +
    'import flash.text.StyleSheet;\n' +
    'var s:Stage = new Stage();\n' +
    'var f:TextField = new TextField();\n' +
    'var ss:StyleSheet = new StyleSheet();\n' +
    'ss.setStyle("xml", {fontSize:\'9px\', leading:\'-2px\'});\n' +
    'ss.setStyle("fps", {color:"#ffff00"});\n' +
    'f.styleSheet = ss;\n' +
    'f.htmlText = "<xml><fps>FPS: 1 / 2</fps></xml>";\n' +
    'var names:Array = ss.styleNames;\n' +
    'var one:Object = ss.getStyle("fps");\n' +
    'ss.clear();\n' +
    's.addChild(f);\n')).c;

  // The class itself: real members (a stub that only reported "CSS styling is not
  // applied" was here before -- AIR's StyleSheet really styles htmlText).
  check('setStyle is implemented, not the old loud stub',
    c.includes('void StyleSheet_setStyle(void* _this, char* styleName, Object* styleObject) {')
    && !c.includes('flash.text.StyleSheet.setStyle (CSS styling is not applied)'));
  check('setStyle stores a COPY of the style object (AIR: setStyle stores a copy, getStyle returns one)',
    c.includes('as_object_set(ss->_rules, key, as_v_obj((void*)as_object_clone((as_object*)styleObject)));'));
  check('setStyle(name, null) removes the style',
    c.includes('if (styleObject == NULL) { as_object_del(ss->_rules, key); return; }'));
  check('selectors are stored lowercased (styleNames reports memmax after setStyle("memMax"))',
    c.includes('char* key = as_str_toLower(styleName);'));
  check('getStyle returns a copy, or NULL for an unknown name',
    c.includes('Object* StyleSheet_getStyle(void* _this, char* styleName) {')
    && c.includes('as_object* decl = as_ss_lookup(ss->_rules, styleName);')
    && c.includes('return (Object*)(void*)as_object_clone(decl);'));
  check('clear empties the rule table; styleNames lists the stored selectors',
    c.includes('void StyleSheet_clear(void* _this) { StyleSheet* ss = (StyleSheet*)_this; if (ss != NULL) ss->_rules = as_object_new(); }')
    && c.includes('for (int i = 0; i < ss->_rules->length; i++) as_array_push(a, as_v_str(ss->_rules->keys[i]));'));
  // StyleSheet extends EventDispatcher in AIR, so its ctor must chain there (it
  // used to call Object_ctor).
  check('the ctor chains to EventDispatcher and allocates the rule table',
    c.includes('void StyleSheet_ctor(StyleSheet* o) { EventDispatcher_ctor((EventDispatcher*)o, NULL); o->_rules = as_object_new(); }'));
  // The rule table is a C-runtime-only slot: without the props entry gc_scan would
  // never trace it and a collection could free a live sheet's rules.
  check('the rule table is a C-only slot marked for the GC',
    c.includes('as_object* _rules;')
    && c.includes('{ "_rules", 6, offsetof(StyleSheet, _rules), NULL, NULL, 1 },'));

  // The tag classifier.
  check('AIR\'s inline tag set is spelled out (and nothing else is)',
    c.includes('static const char* const t[] = { "span", "p", "b", "i", "u", "font", "a", "li", "br", "img", "textformat", NULL };')
    && c.includes('for (int i = 0; t[i] != NULL; i++) if (strcmp(nm, t[i]) == 0) return 1;'));
  check('the rule lookup happens for every tag and is case-insensitive',
    c.includes('as_object* rule = (tf->styleSheet != NULL) ? as_ss_lookup(tf->styleSheet->_rules, nm) : NULL;')
    && c.includes('static bool as_str_ieq(const char* a, const char* b) {'));
  check('a rule-styled unknown tag is a block; display:inline opts out; display:none hides',
    c.includes('if (!as_tf_tag_inline(nm) && !noinline) { if (depth < AS_TF_STACK) st_block[depth] = 1; }')
    && c.includes('int noinline = (disp != NULL && as_str_ieq(disp, "inline"));')
    && c.includes('int hidden = (disp != NULL && as_str_ieq(disp, "none"));')
    && c.includes('if (hidden) skip++;'));
  check('the block break is emitted AFTER the closing tag (break-after, not before)',
    c.includes('if (st_block[depth] && skip == 0 && opos > 0 && out[opos - 1] != \'\\n\') { out[opos++] = \'\\n\'; tf->_html_block = true; }'));
  check('<br> and </p> only break a MULTILINE field',
    c.includes('if ((strcmp(nm, "br") == 0 || strcmp(nm, "p") == 0) && tf->multiline && skip == 0 && opos > 0 && out[opos - 1] != \'\\n\') out[opos++] = \'\\n\';')
    && c.includes('else if (strcmp(nm, "br") == 0) { if (tf->multiline && skip == 0 && opos > 0 && out[opos - 1] != \'\\n\') out[opos++] = \'\\n\'; }'));
  check('style state is stacked, so a close restores what the open replaced',
    c.includes('if (depth > 0) { depth--; if (depth < AS_TF_STACK) {')
    && c.includes('st_face[depth] = face; st_size[depth] = size; st_color[depth] = color;'));
  check('declarations feed the runs (color/size/family/weight/slant/decoration)',
    c.includes('char* v = as_ss_str(rule, "color"); if (v != NULL) { int c = as_css_color(v); if (c >= 0) color = (unsigned)c; }')
    && c.includes('v = as_ss_str(rule, "fontsize"); if (v != NULL) { double d = as_css_num(v); if (d >= 1.0) size = d; }')
    && c.includes('v = as_ss_str(rule, "fontfamily"); if (v != NULL && v[0] != 0) face = as_str_dup(v);'));
  check('CSS numbers take the numeric part (9px -> 9, -2px -> -2) and colours need #RRGGBB',
    c.includes('static double as_css_num(const char* v) {')
    && c.includes('static int as_css_color(const char* v) {')
    && c.includes('if (v == NULL || v[0] != \'#\') return -1;'));

  // Layout: the block breaks must survive a single-line field's newline collapse.
  check('a block-break htmlText lays out multi-line even with multiline false',
    c.includes('int collapse = (tf->multiline || tf->_html_block) ? 0 : 1;')
    && c.includes('bool _html_block;')
    && c.includes('tf->_html_block = false;')
    && c.includes('if (!tf->multiline && !tf->_html_block) return 1;'));
  // A field with htmlText but no defaultTextFormat still lays out (Fps.as sets only
  // styleSheet + htmlText), with AIR's implicit TextFormat defaults.
  check('a field without defaultTextFormat still lays out (implicit 12px/_sans format)',
    c.includes('if (dflt == NULL) { static TextFormat idd; static int idd_init = 0;')
    && c.includes('idd.font = (char*)"_sans"; idd.size = as_v_num(12.0); idd.color = as_v_num(0.0);'));
  return bad;
}

registerGroup('unit: text-input/StyleSheet', checkStyleSheet);

// ---- TODO「窗口键盘通道把 Shift 自身的 keyDown/keyUp 各派发两次」 ---------------
// adl 51.4.1 的修饰键是「按 keyCode 一维」的：LSHIFT 与 RSHIFT 都是 keyCode 16，
// L/R Control 17、L/R Alt 18、L/R Command 15，且同时按住两侧只派发一对
// keyDown/keyUp（macOS 26.6.2 实测，temp/shiftdup/）。SDL 却按 scancode 报四个键，
// 而且 Cocoa 后端一次 FlagsChanged 会按 modflags 把整个家族都按下去。修法是胶水层
// 按 (AIR keyCode, 方向) 合并同一修饰键的连续重复，且只在 __APPLE__ 下生效——
// Windows 的修饰键会自动重复，那里的重复是真输入。
function checkModifierKeyChannel(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [modkey] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [modkey] ${label}`); }
  };

  const src = readFileSync(join(root, 'vendor', 'window_glue.cc'), 'utf8')
    .replace(/\r\n/g, '\n');

  check('the helper enumerates the eight modifier scancodes and returns AIR\'s keyCode',
    /static int sk_modifier_keycode\(SDL_Scancode sc\) \{[\s\S]*?SDL_SCANCODE_LSHIFT[\s\S]*?SDL_SCANCODE_RGUI[\s\S]*?\n\}/.test(src));

  // 本条的**全部意义**在于「两侧同一个 keyCode」——只按 scancode 匹配去重是修不掉的：
  // 同一修饰键的左右两侧在 SDL 里是四个不同 scancode。
  check('LSHIFT/RSHIFT collapse onto one keyCode (and so do L/R Control/Alt/Command)',
    /case SDL_SCANCODE_LSHIFT: case SDL_SCANCODE_RSHIFT: return 16;/.test(src)
    && /case SDL_SCANCODE_LCTRL:  case SDL_SCANCODE_RCTRL:  return 17;/.test(src)
    && /case SDL_SCANCODE_LALT:   case SDL_SCANCODE_RALT:   return 18;/.test(src)
    && /case SDL_SCANCODE_LGUI:   case SDL_SCANCODE_RGUI:   return 15;/.test(src));

  check('the helper and its state live behind #if defined(__APPLE__)',
    /#if defined\(__APPLE__\)[\s\S]{0,1600}?sk_modifier_keycode[\s\S]{0,1600}?g_mod_last_valid = 0;/.test(src));

  check('the coalescing keys on (AIR keyCode, direction), not on SDL repeat (the KEYUP half carries no repeat flag)',
    src.includes('int down = (e.type == SDL_KEYDOWN) ? 1 : 0;')
    && src.includes('g_mod_last_keycode == mod_kc &&')
    && src.includes('g_mod_last_down == down'));

  // 位置断言：过滤必须在 on_key 派发之前、且落在 KEYDOWN/KEYUP 分支内——回调为空的
  // 窗口不得让共享的去重状态失同步。
  const keyCase = src.slice(src.indexOf('case SDL_KEYDOWN:'));
  const gi = keyCase.indexOf('sk_modifier_keycode(e.key.keysym.scancode)');
  const di = keyCase.indexOf('c->on_key(id, e.type == SDL_KEYDOWN');
  check('the filter runs inside the KEYDOWN/KEYUP case, before the on_key dispatch',
    gi > 0 && di > gi && gi < keyCase.indexOf('case SDL_TEXTEDITING:'));

  check('the keyDown/keyUp dispatch site is still single (the fix is a filter, not a second call)',
    (src.match(/c->on_key\(id, e\.type == SDL_KEYDOWN \? "keyDown" : "keyUp"/g) || []).length === 1);

  check('the rationale cites the SDL sources and the measured AIR coalescing fact',
    src.includes('SDL_cocoaevents.m') && src.includes('SDL_cocoakeyboard.m')
    && src.includes('SDL_keyboard.c') && src.includes('temp/shiftdup/'));

  return bad;
}

registerGroup('unit: text-input/ModifierKey', checkModifierKeyChannel);
