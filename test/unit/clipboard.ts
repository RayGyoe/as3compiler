// Unit checks: flash.desktop.Clipboard and flash.system.System.setClipboard
// (阶段二百九十三).
//   node --test --test-name-pattern='clipboard/' test/unit/*.ts
//
// The API surface is pinned against the AIR 3.0 reference page
// (airsdk.dev/reference/actionscript/3.0/flash/desktop/Clipboard.html): the
// format->type table, the transferMode names, the two null-argument TypeErrors and
// the "handler renders on read" rule all come from there, not from our behaviour.
// The platform half is pinned as SOURCE because the suite has no window backend;
// the real Win32 clipboard was measured separately (temp/clip: four formats written,
// read back by an outside PowerShell process, and an outside copy read through).
// See docs/zh-cn/desktop.md 7.10.
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, readNorm, root } from '../harness.ts';
import { join } from 'node:path';

function checkClipboard(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [clipboard] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [clipboard] ${label}`); }
  };

  const symbols = readNorm(join(root, 'src', 'symbols.ts'));
  const emitSrc = readNorm(join(root, 'src', 'emit.ts'));
  const runtime = readNorm(join(root, 'src', 'runtime.ts'));
  const glue = readNorm(join(root, 'vendor', 'window_glue.cc'));
  const web = readNorm(join(root, 'vendor', 'web_glue.cc'));
  const example = readNorm(join(root, 'examples', 'clipboard.as'));
  const c = generateC(parse(example)).c;

  // ---- 1. Clipboard is a real built-in class now, not a shell -----------------
  check('symbols: Clipboard is no longer registered as a shell (API shape only)',
    !/shell\(\s*'Clipboard'/.test(symbols));
  check('symbols: Clipboard carries the built-in marker reflectFqn',
    /this\.classMap\.set\('Clipboard', \{[\s\S]{0,4000}?reflectFqn: 'flash\.desktop::Clipboard'/.test(symbols));
  // Clipboard.html: formats is a read-only Array, supportsFilePromise a read-only
  // Boolean, generalClipboard a static read-only Clipboard.
  check('symbols: getters formats + supportsFilePromise',
    /this\.classMap\.set\('Clipboard', \{[\s\S]{0,4000}?getters: new Map\(\[[\s\S]{0,200}?\['formats', clget\(\{ kind: 'array' \}\)\][\s\S]{0,200}?\['supportsFilePromise', clget\(\{ kind: 'bool' \}\)\]/.test(symbols));
  check('symbols: static getter generalClipboard',
    /this\.classMap\.set\('Clipboard', \{[\s\S]{0,4000}?staticGetters: new Map\(\[[\s\S]{0,200}?\['generalClipboard'/.test(symbols));
  // The five methods AIR lists, plus setDataHandler.
  for (const m of ['clear', 'clearData', 'getData', 'hasFormat', 'setData', 'setDataHandler']) {
    check(`symbols: method ${m}`, new RegExp(`\\['${m}', clm\\(`).test(symbols));
  }
  check('symbols: getData default transferMode is originalPreferred',
    /\['getData', clm\(\{ kind: 'any' \}, \[[\s\S]{0,300}?'transferMode'[\s\S]{0,120}?value: 'originalPreferred'/.test(symbols));
  // Clipboard.html: setData(format, data:Object, serializable:Boolean = true).
  check('symbols: setData takes (format, data, serializable = true)',
    /\['setData', clm\(\{ kind: 'bool' \}, \[shReq\('format', 'String'\), shReq\('data', 'any'\), shBoolP\('serializable', true\)\]\)/.test(symbols));
  check('symbols: setDataHandler takes (format, handler, serializable = true)',
    /\['setDataHandler', clm\(\{ kind: 'bool' \}, \[shReq\('format', 'String'\), shReq\('handler', 'Function'\), shBoolP\('serializable', true\)\]\)/.test(symbols));

  // ---- 2. ClipboardFormats / ClipboardTransferMode ----------------------------
  // Clipboard.html lists the standard format names; getData compares transferMode
  // against exactly these four strings.
  for (const [name, value] of [
    ['TEXT_FORMAT', 'text'], ['HTML_FORMAT', 'html'], ['RICH_TEXT_FORMAT', 'richText'],
    ['URL_FORMAT', 'url'], ['BITMAP_FORMAT', 'bitmap'], ['FILE_LIST_FORMAT', 'fileList'],
    ['FILE_PROMISE_LIST_FORMAT', 'filePromiseList'],
  ]) {
    check(`symbols: ClipboardFormats.${name} == '${value}'`,
      new RegExp(`\\['${name}', '${value}'\\]`).test(symbols));
  }
  check('symbols: ClipboardTransferMode has the four documented names',
    /constClass\('ClipboardTransferMode', \{[\s\S]{0,400}?CLONE_ONLY: 'cloneOnly'[\s\S]{0,200}?CLONE_PREFERRED: 'clonePreferred'[\s\S]{0,200}?ORIGINAL_ONLY: 'originalOnly'[\s\S]{0,200}?ORIGINAL_PREFERRED: 'originalPreferred'/.test(symbols));

  // ---- 3. the emitted C model -------------------------------------------------
  check('emit: the three entry arrays are the object model',
    c.includes('static void Clipboard_ctor(Clipboard* o) {') &&
    /Clipboard_ctor[\s\S]{0,200}?o->_fmts = as_array_new\(\);[\s\S]{0,120}?o->_vals = as_array_new\(\);[\s\S]{0,120}?o->_hdl = as_array_new\(\);/.test(c));
  check('emit: generalClipboard is one lazily built instance',
    /Clipboard\* Clipboard_get_generalClipboard_static\(void\* _this\) \{[\s\S]{0,300}?if \(ASC_general_clipboard == NULL\) ASC_general_clipboard = Clipboard_new\(\);/.test(c));
  check('emit: generalClipboard is a GC root',
    c.includes('gc_mark_ptr((void*)ASC_general_clipboard);'));
  // Clipboard.html: "When the format is a standard format the data is returned as
  // an object of the corresponding Flash type", and generalClipboard reads the
  // platform, so the OS lookup has to come BEFORE the stored payload -- otherwise
  // an entry written earlier shadows what another application has copied since.
  const getData = c.slice(c.indexOf('static as_value Clipboard_getData('));
  check('emit: getData asks the OS before the stored payload',
    getData.indexOf('as_clip_os_has(kind)) return as_clip_os_read(kind);') > 0 &&
    getData.indexOf('as_clip_os_has(kind)) return as_clip_os_read(kind);') < getData.indexOf('return o->_vals->data[i];'));
  check('emit: hasFormat asks the OS first',
    /bool Clipboard_hasFormat\([\s\S]{0,500}?if \(kind != 0 && as_clip_is_os\(o\) && as_clip_os_has\(kind\)\) return true;[\s\S]{0,120}?return as_clip_index\(o, format\) >= 0;/.test(c));
  check('emit: a successful OS write drops the shadow copy',
    /if \(!as_clip_os_write\(kind, data\)\) \{[\s\S]{0,900}?int i = as_clip_index\(o, format\);[\s\S]{0,120}?if \(i >= 0\) as_clip_drop\(o, i\);/.test(c));
  // Clipboard.html: setData/setDataHandler throw TypeError when an argument is null.
  check('emit: setData throws #2007 for a null format',
    c.includes('Error #2007: Parameter format must be non-null.'));
  check('emit: setData throws #2007 for a null data',
    c.includes('Error #2007: Parameter data must be non-null.'));
  check('emit: setDataHandler throws #2007 for a null handler',
    c.includes('Error #2007: Parameter handler must be non-null.'));
  // Clipboard.html: "a copy is always returned" for the standard formats, so
  // cloneOnly must not be answered with null for them -- only for an
  // application-defined format with nothing but the original.
  check('emit: cloneOnly only nulls an application-defined format',
    c.includes('if (clone_only && kind == 0) return as_v_null();'));
  check('emit: a handler renders on read',
    getData.includes('as_fn_call_dyn(o->_hdl->data[i], NULL, 0, "setDataHandler")'));

  // ---- 4. System.setClipboard is the real thing --------------------------------
  check('emit: System.setClipboard no longer reports itself unimplemented',
    !/as_shell_unsupported\([^)]*flash\.system\.System\.setClipboard/.test(emitSrc));
  check('emit: System.setClipboard is clear + setData(text)',
    /if \(isSystemClass && callee\.property === 'setClipboard'\) \{[\s\S]{0,700}?as_system_set_clipboard\(\$\{a\}\)/.test(emitSrc));
  check('emit: as_system_set_clipboard clears then sets the text format',
    /void as_system_set_clipboard\(char\* s\) \{[\s\S]{0,400}?Clipboard_clear\(\(void\*\)c\);[\s\S]{0,200}?Clipboard_setData\(\(void\*\)c, \(char\*\)"text"/.test(c));

  // ---- 5. the platform seam ---------------------------------------------------
  for (const fn of ['sk_clipboard_set_text', 'sk_clipboard_get_text', 'sk_clipboard_available',
    'sk_clipboard_has_fmt', 'sk_clipboard_set_fmt', 'sk_clipboard_get_fmt',
    'sk_clipboard_clear_fmt', 'sk_clipboard_clear']) {
    check(`runtime: declares ${fn} for a window backend`,
      new RegExp(`extern [^\\n]*\\b${fn}\\(`).test(runtime));
    check(`runtime: stubs ${fn} without a window backend`,
      new RegExp(`static inline [^\\n]*\\b${fn}\\(`).test(runtime));
  }
  // Regression for the stage-293 bug this nearly shipped: the block used to live
  // INSIDE the `#ifdef ASC_USE_SKIA` section, so a pure-C build called functions it
  // had never declared.
  check('runtime: the clipboard declarations sit before the skia section',
    runtime.indexOf('// Platform clipboard') < runtime.indexOf('extern void* sk_surface_raster_new(int w, int h);'));

  // ---- 6. the Win32 translation ----------------------------------------------
  check('glue: text <-> CF_UNICODETEXT', glue.includes('if (strcmp(fmt, "text") == 0) return CF_UNICODETEXT;'));
  check('glue: html <-> the "HTML Format" clipboard format',
    glue.includes('RegisterClipboardFormatW(L"HTML Format")'));
  check('glue: richText <-> "Rich Text Format"', glue.includes('RegisterClipboardFormatW(L"Rich Text Format")'));
  check('glue: url <-> "UniformResourceLocatorW"', glue.includes('RegisterClipboardFormatW(L"UniformResourceLocatorW")'));
  check('glue: html is wrapped in a CF_HTML header with byte offsets',
    glue.includes('StartFragment:%010d') && glue.includes('\\r\\nStartHTML:'));
  check('glue: html reads back the fragment, not the header',
    /sk_clip_html_fragment\([\s\S]{0,600}?StartFragment:/.test(glue));
  check('glue: a set rebuilds the clipboard so the other formats survive',
    /static void sk_clip_rebuild\(UINT setid, HGLOBAL blob, UINT drop\) \{[\s\S]{0,900}?EmptyClipboard\(\);/.test(glue));
  // Another process holding the clipboard open made the first external verification
  // run report "not translated" for every format; the retry is the fix.
  check('glue: OpenClipboard is retried', /static BOOL sk_clip_open\(void\) \{[\s\S]{0,300}?Sleep\(2\)/.test(glue));
  check('web: answers available() == 0 so the AS3 side reports honestly',
    web.includes('int sk_clipboard_available(void) { return 0; }'));
  check('web: the rest of the seam is stubbed, not missing',
    web.includes('void sk_clipboard_clear(void) { }') && web.includes('int sk_clipboard_get_fmt(const char* fmt, char* buf, int cap)'));

  // ---- 7. what the example pins ----------------------------------------------
  // The example is the end-to-end half: it must exercise every documented mode.
  for (const needle of [
    'ClipboardTransferMode.CLONE_ONLY', 'com.example.pin', 'setDataHandler',
    'System.setClipboard("system text', 'supportsFilePromise', 'System.gc();',
  ]) {
    check(`example: covers ${needle}`, example.includes(needle));
  }

  console.log(`[clipboard] ${ok} checks passed`);
  return bad;
}

registerGroup('clipboard/', checkClipboard);