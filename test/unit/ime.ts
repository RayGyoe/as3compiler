// Unit checks: flash.system.IME / IMEConversionMode and flash.events.IMEEvent
// (TODO 遗留 L8148 / L8149). The measured columns are recorded on the classMap
// entries in src/symbols.ts: macOS 51.4.1 is the repo baseline (the four operating
// methods throw #2063 when nothing is focused), Windows 51.3.2 (temp/imeprobe) shows
// the focused case working plus the setter's #2007 / #2063 rejections and the #2012
// constructor. This file pins the generated C against that口径 — the example that
// runs it is examples/ime.as.
//
//   node --test --test-name-pattern='ime/' test/unit/*.ts
import { generateC } from '../../src/codegen.ts';
import { parse } from '../../src/parser.ts';

const SRC =
  'import flash.display.Stage;\n' +
  'import flash.text.TextField;\n' +
  'import flash.text.TextFieldType;\n' +
  'import flash.events.IMEEvent;\n' +
  'import flash.system.IME;\n' +
  'import flash.system.IMEConversionMode;\n' +
  'var s:Stage = new Stage();\n' +
  'var f:TextField = new TextField();\n' +
  'f.type = TextFieldType.INPUT;\n' +
  's.addChild(f);\n' +
  'var m:String = IMEConversionMode.CHINESE;\n' +
  'var n:String = IMEConversionMode.UNKNOWN;\n' +
  'var sup:Boolean = IME.isSupported;\n' +
  'var en:Boolean = IME.enabled;\n' +
  'IME.enabled = false;\n' +
  'var cm:String = IME.conversionMode;\n' +
  'IME.conversionMode = m;\n' +
  'IME.setCompositionString("ni");\n' +
  'IME.doConversion();\n' +
  'IME.compositionSelectionChanged(0, 2);\n' +
  'IME.compositionAbandoned();\n' +
  'var ev:IMEEvent = new IMEEvent(IMEEvent.IME_COMPOSITION, false, false, "ni", null);\n' +
  'ev.imeClient = s;\n' +
  'var t:String = ev.text;\n' +
  'trace(m + n + cm + sup + en + t);\n';

function checkIme(): string[] {
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) console.log(`PASS  [ime] ${label}`);
    else { bad.push(label); console.log(`FAIL  [ime] ${label}`); }
  };
  const c = generateC(parse(SRC)).c;

  // ---- IMEConversionMode: exactly the 8 documented mode strings ---------------
  const consts = ['ALPHANUMERIC_FULL', 'ALPHANUMERIC_HALF', 'CHINESE', 'JAPANESE_HIRAGANA',
    'JAPANESE_KATAKANA_FULL', 'JAPANESE_KATAKANA_HALF', 'KOREAN', 'UNKNOWN'];
  check('the 8 conversion-mode constants are file-scope string literals',
    consts.every((k) => c.includes(`IMEConversionMode_${k} = "${k}";`)));
  check('no Flash-era extra sneaks in (AIR reads them back as undefined)',
    !c.includes('IMEConversionMode_ALPHANUMERIC ') && !c.includes('IMEConversionMode_NONE'));

  // ---- IME: the shape AIR documents ------------------------------------------
  check('isSupported is a static bool defaulting to true',
    /bool IME_isSupported = true;/.test(c));
  check('enabled is a static getter/setter pair over file-scope state',
    c.includes('bool IME_get_enabled_static(void* _this) { (void)_this; return ASC_ime_enabled; }')
    && c.includes('void IME_set_enabled_static(void* _this, bool value) { (void)_this; ASC_ime_enabled = value; }'));
  check('conversionMode starts UNKNOWN (the macOS baseline reading)',
    c.includes('static char* ASC_ime_conversion_mode = (char*)"UNKNOWN";'));
  check('the mode setter walks the seven settable strings and stores the literal',
    consts.filter((k) => k !== 'UNKNOWN')
      .every((k) => c.includes(`if (strcmp(value, "${k}") == 0) { ASC_ime_conversion_mode = (char*)"${k}"; return; }`)));
  check('null mode is AIR\'s #2007 "Parameter mode must be non-null."',
    c.includes('if (value == NULL) { as_throw(Error_new((char*)"Error #2007: Parameter mode must be non-null.", 2007)); return; }'));
  check('anything else (incl. read-only UNKNOWN) is #2063',
    c.includes('Error #2063: Error attempting to execute IME command.')
    && !c.includes('ASC_ime_conversion_mode = (char*)"UNKNOWN"; }'));
  check('setConversionMode does not exist (AIR: #1006, the member is absent)',
    !c.includes('setConversionMode'));

  // ---- IME: the operating methods need a focused editable field ---------------
  check('the composition target is the same focus gate the SDL_TEXTEDITING channel uses',
    /static TextField\* as_ime_target\(void\) \{[\s\S]{0,200}?as_focus_obj == NULL \|\| !as_is\(\(void\*\)as_focus_obj, &TextField_vt\)[\s\S]{0,120}?if \(!as_tf_is_input\(tf\)\) return NULL;/.test(c));
  check('setCompositionString with no target is #2063, else it composes the marked text',
    /void IME_setCompositionString_static\(char\* composition\) \{[\s\S]{0,260}?if \(tf == NULL\) \{ as_throw\(Error_new\(\(char\*\)"Error #2063[\s\S]{0,120}?as_tf_set_comp\(tf, composition, -1, 0\);/.test(c));
  check('doConversion commits the composition as the textInput payload',
    /void IME_doConversion_static\(void\) \{[\s\S]{0,700}?as_tf_set_comp\(tf, NULL, -1, 0\);[\s\S]{0,60}?as_tf_insert_text\(tf, committed\);/.test(c));
  check('doConversion copies before dropping the preview (the preview owns that buffer)',
    /memcpy\(committed, tf->_comp, n \+ 1\);/.test(c) && c.includes('free(committed);'));
  check('compositionSelectionChanged requires a live composition and is #2063 without one',
    /void IME_compositionSelectionChanged_static\(int start, int end\) \{[\s\S]{0,260}?tf->_comp == NULL\) \{ as_throw\(Error_new\(\(char\*\)"Error #2063[\s\S]{0,160}?tf->_comp_len = end - start;/.test(c));
  check('compositionAbandoned never throws (measured no-op when nothing is composed)',
    (() => {
      const body = /void IME_compositionAbandoned_static\(void\) \{[\s\S]*?\n\}/.exec(c)?.[0] ?? '';
      return body.includes('if (tf != NULL) as_tf_set_comp(tf, NULL, -1, 0);') && !body.includes('as_throw');
    })());
  check('new IME() is AIR\'s #2012 with its exact message',
    c.includes('IME_new(void) { as_throw(Error_new((char*)"Error #2012: IME$ class cannot be instantiated.", 2012)); return NULL; }'));
  // System.ime (AIR's IME *instance* singleton, which does carry the EventDispatcher
  // surface) is deliberately NOT provided — see the TODO 遗留 L8148 note.
  check('System.ime is still absent (documented deferral)', !/as_ime_singleton|System_get_ime/.test(c));

  // ---- IMEEvent (L8149) ------------------------------------------------------
  check('IMEEvent is a TextEvent subclass with the two type constants',
    c.includes('IMEEvent_IME_COMPOSITION = "imeComposition";')
    && c.includes('IMEEvent_IME_START_COMPOSITION = "imeStartComposition";'));
  check('its constructor chains through TextEvent (so text keeps the "" default)',
    c.includes('void IMEEvent_ctor(IMEEvent* o, char* type, bool bubbles, bool cancelable, char* text, Object* imeClient) { TextEvent_ctor((TextEvent*)o, type, bubbles, cancelable, text);'));
  check('imeClient is a write-barriered object slot',
    c.includes('o->imeClient = imeClient; gc_write_barrier((void*)imeClient);'));
  check('the 5-arg new matches the documented signature',
    c.includes('IMEEvent* IMEEvent_new(char* type, bool bubbles, bool cancelable, char* text, Object* imeClient)'));
  check('IMEEvent has no `data` property (measured #1069 on AIR)',
    !c.includes('IME_data') && !/struct IMEEvent \{[^}]*data/.test(c));

  // ---- wiring ----------------------------------------------------------------
  // The block is emitted once and its calls resolve against the TEXT section's
  // prototypes (the runtime puts every helper's prototype ahead of the definitions).
  check('the IME block is defined exactly once, after the text helpers’ prototypes',
    (c.match(/void IME_setCompositionString_static\(char\* composition\) \{/g) ?? []).length === 1
    && (c.match(/static TextField\* as_ime_target\(void\) \{/g) ?? []).length === 1
    && c.indexOf('void IME_setCompositionString_static(char* composition) {') > c.indexOf('static void as_tf_set_comp(TextField* tf, const char* text, int start, int length) {') - 1
    && c.indexOf('void IME_setCompositionString_static(char* composition) {') > c.indexOf('static void as_tf_insert_text(TextField* tf, const char* text) { as_tf_insert_payload'));
  return bad;
}

import { registerGroup } from '../harness.ts';
registerGroup('unit: ime/IME', checkIme);
