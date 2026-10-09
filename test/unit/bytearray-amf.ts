// Unit checks: ByteArray surface + AMF member order.
// Moved verbatim out of the single-file test.ts (阶段九十六·一); each group
// still returns the list of failed labels and is registered as one node:test
// case, so it can be re-run alone with:
//   node --test --test-name-pattern='bytearray-amf/' test/unit/*.ts

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

function checkByteArrayAmf(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [amf] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [amf] ${label}`); }
  };
  const preamble = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');

  // ---- multibyte ---------------------------------------------------------
  check('the multibyte codec is iconv-gated (wasm drops it)',
    preamble.includes('AS_HAVE_ICONV')
    && preamble.includes('#include <iconv.h>')
    && preamble.includes('as_throw_charset_unsupported'));
  check("'unicode' resolves to UTF-16LE regardless of endian (measured on adl)",
    preamble.includes('"%s", "UTF-16LE"')
    && /unicode.*UTF-16LE|UTF-16LE.*unicode/.test(preamble));
  check("an unrepresentable character becomes '?' by hand, never //TRANSLIT",
    preamble.includes("becomes '?' -- AIR's")
    && preamble.includes('would emit an ASCII transliteration instead')
    && !/iconv_open\([^)]*TRANSLIT/.test(preamble));
  check('an unknown/empty charset falls back to the OS legacy default',
    preamble.includes('"MACINTOSH"') && preamble.includes('"CP1252"')
    && preamble.includes('as_charset_platform_default'));
  check('a charset the backend cannot serve throws loudly, it is not silent',
    generateC(parse('var n:int = 1;\n')).c.includes('as_throw_charset_unsupported')
    && generateC(parse('var n:int = 1;\n')).c.includes('charset not supported on this backend'));
  check('the new reads throw EOFError #2030 (unlike the older silent reads)',
    generateC(parse('var n:int = 1;\n')).c.includes('EOFError_new((char*)"Error #2030: End of file was encountered", 2030)'));
  check('iconv is linked on macOS only, never for wasm/web',
    /function platformLinkLibs\(\): string\[\] \{[\s\S]{0,400}'iconv'/.test(readFileSync(join(root, 'src', 'build.ts'), 'utf8')));

  // ---- AMF3 wire format --------------------------------------------------
  check('ByteArray defaults to ObjectEncoding.AMF3',
    generateC(parse('import flash.utils.ByteArray;\nvar b:ByteArray = new ByteArray();\n')).c.includes('objectEncoding = 3'));
  check('dynamic keys and trait names are RAW U29S (no 0x06 marker), string values are not',
    preamble.includes('as_amf3_wstr_raw') && preamble.includes('as_amf3_wvalue(w, as_v_str(')
    && preamble.includes('as_amf3_wstr(w, (char*)v.ptr)'));
  check('the trait class name is never entered into the string table',
    preamble.includes('as_amf3_wstr_classname') && preamble.includes('as_amfr_str_classname'));
  check('the reader takes the DYNAMIC flag from U29O bit 3 (measured: bit 2 is externalizable)',
    preamble.includes('int dynamic = (int)((u >> 3) & 1u);')
    && preamble.includes('bit3 DYNAMIC'));
  check('a Vector is probed by its mark callback, not treated as an as_array',
    preamble.includes('if (k == GCT_CUSTOM) return 3;')
    && generateC(parse('var v:Vector.<int> = new Vector.<int>();\nv.push(1);\n')).c
        .includes('if (mark == (void*)as_vector_int_mark)'));
  check('the writer emits the measured Vector.<int> marker (0x0d + type byte + BE ints)',
    preamble.includes('int marker = 0x0d + (vf <= 2 ? vf : 3);')
    && preamble.includes('as_amfb_bytes_be32'));
  check('AMF0 is refused with a distinct error code, not silently written as AMF3',
    preamble.includes('err->code = 4')
    && generateC(parse('var n:int = 1;\n')).c.includes('only ObjectEncoding.AMF3 is supported by this subset'));
  check('an alias registered for a base class covers its subclasses (measured)',
    preamble.includes('Walk the superclass chain innermost-first'));

  const ex = readFileSync(join(root, 'examples', 'stage94d.as'), 'utf8');
  check('the example pins the multibyte charsets byte-exactly',
    ex.includes('"unicode writes UTF-16LE with no BOM"') && ex.includes('"unicode ignores the endian property"')
    && ex.includes('"gbk encodes 中 through the system code page"')
    && ex.includes("'?' (not a transliteration)")
    && ex.includes('"utf-8 encodes an astral character as four bytes"'));
  check('the example pins the AMF3 marker goldens',
    ex.includes('"AMF3 -1 uses the four-byte U29 form"') && ex.includes('"AMF3 70000 uses the three-byte U29 form"')
    && ex.includes('"a dense AMF3 Array has no associative section"')
    && ex.includes('"the U29S length counts UTF-8 bytes"'));
  check('the example pins the Vector and typed-object goldens',
    ex.includes('"Vector.<int> is 0x0d + count + type + big-endian ints"')
    && ex.includes('"members are own-first then inherited, the alias covers the hierarchy, and the string table dedupes the values"'));
  check('the example pins the error paths (2030 / 2006 / 1014 / 2007 / AMF0)',
    ex.includes('readObject on an empty buffer throws #2030') && ex.includes('an unknown marker throws RangeError #2006')
    && ex.includes('an unknown alias throws ReferenceError #1014')
    && ex.includes('registerClassAlias(null, X) throws TypeError #2007')
    && ex.includes('objectEncoding = AMF0 is refused loudly'));

  if (ok > 0) console.log(`[amf] ${ok} amf checks passed`);
  return bad;
}

function checkByteArraySurface(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [bytearray] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [bytearray] ${label}`); }
  };
  const c = generateC(parse('import flash.utils.ByteArray;\nvar b:ByteArray = new ByteArray;\nb[0] = 1;\nb[b.length] = 2;\n')).c;

  // The receiver is wrapped in the #1009 null guard (as_req_obj), so match the
  // routing by shape rather than the bare `g_b` atom.
  check('an index write routes to ByteArray_set_index, not the dynamic property table',
    /ByteArray_set_index\(\(void\*\)\([^\n]*\), 0, \(\(double\)\(1\)\)\)/.test(c)
    && /ByteArray_set_index\(\(void\*\)\([^\n]*\), \([^\n]*->length\), \(\(double\)\(2\)\)\)/.test(c));
  check('the value is truncated with ToUint32 semantics (measured: 300 -> 44, -1 -> 255)',
    c.includes('as_to_uint32(v) & 0xFFu'));
  check('a write past the end extends and zero-fills the buffer',
    c.includes('if (i >= o->length) o->length = i + 1;')
    && c.includes('memset(nd + o->length, 0, (size_t)(cap - o->length))'));
  check('an index write leaves the position cursor alone',
    !/ByteArray_set_index[\s\S]{0,600}o->position\+\+/.test(c));
  // Measured on adl 51.4.1: a negative index read throws #1069, while a positive
  // index past the end returns without throwing (this subset yields 0 there --
  // registered in TODO.md 遗留 as "ByteArray 越界读给 0 而非 undefined").
  // Stage 102 turned the reader's result into an `as_value`: past the end is
  // `undefined` (not 0) and a negative index still throws #1069.
  check('the read form is split: negative throws #1069, positive past the end is undefined',
    c.includes('if (i < 0) { as_throw_sealed_get(as_str_from_int(i), "flash.utils.ByteArray"); return as_v_undefined(); }')
    && c.includes('if (i >= o->length || o->data == NULL) return as_v_undefined();'));

  // Two AS3 forms real crypto code needs (com.hurlant's MD5 uses both).
  const noParens = generateC(parse('import flash.utils.ByteArray;\nvar b:ByteArray = new ByteArray;\n')).c;
  check('`new C` without an argument list parses (== `new C()`)',
    noParens.includes('ByteArray_new()'));
  const logical = generateC(parse('var a:Array = [];\na[0] ||= 7;\n')).c;
  check('`a[i] ||= v` is supported for an index target (short-circuit write)',
    logical.includes('as_array_set(') && logical.includes('as_v_truthy('));
  let loud = false;
  try {
    generateC(parse('function f():Array { return []; }\nf()[0] ||= 7;\n'));
  } catch (e) { loud = /side-effect-free/.test(String(e)); }
  check('a side-effecting index in a logical assignment is still rejected loudly', loud);

  const ex = readFileSync(join(root, 'examples', 'stage94d.as'), 'utf8');
  check('the example pins the measured index-write goldens',
    ex.includes('"an out-of-range value is truncated to the low byte (300 -> 44)"')
    && ex.includes('"-1 writes as 0xFF"')
    && ex.includes('"a write at length appends (the padding idiom)"')
    && ex.includes('"a write past the end extends and zero-fills"')
    && ex.includes('"an index write does not move the position cursor"')
    && ex.includes('"a[i] ||= v fills only the falsy holes"')
    && ex.includes('"new ByteArray without parens constructs the same object"'));
  check('the example pins the EOF and out-of-range index goldens',
    ex.includes('"readByte at EOF throws #2030"')
    && ex.includes('"readBytes past the end throws #2030"')
    && ex.includes('"a short read is #2030, not a clamped value"')
    && ex.includes('"a negative index read throws #1069"')
    && ex.includes('"a negative index write throws #1056"'));

  if (ok > 0) console.log(`[bytearray] ${ok} bytearray checks passed`);
  return bad;
}

// ---- AMF3 trait member order (stage 94e) ----
// adl 51.4.1 measured (temp/a6probe/): AIR's trait member order is an artifact of
// AVM2's internal trait table, not a semantic rule -- declaring the same members
// in reverse gives the SAME order, yet adding three unrelated classes changed the
// order of an untouched class (and reverting the source restored it). Nothing to
// align to, and AMF interop is name-driven, so we pin OUR rule instead: the member
// table is the declaration order, and that is what the emitted bytes carry.
function checkAmfMemberOrder(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [amforder] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [amforder] ${label}`); }
  };
  const c = generateC(parse('import flash.net.registerClassAlias;\nclass Quad {\n public var a:int;\n public var b:String;\n public var c:Boolean;\n public var d:Number;\n public function Quad() {}\n}\nregisterClassAlias("Quad", Quad);\n')).c;

  check('the emitted trait member table is the declaration order',
    c.includes('static const char* Quad_amf_members[] = { "a", "b", "c", "d", NULL };'));

  const ex = readFileSync(join(dir, 'stage94e.as'), 'utf8');
  check('the example pins the declaration-order bytes and the measured AIR evidence',
    ex.includes('"03 61 03 62 03 63 03 64"')
    && ex.includes('"AMF3 writes the trait members in declaration order (a,b,c,d), got "')
    && ex.includes('"a Quad round-trips through AMF3 (order-independent on the read side)"')
    && ex.includes('artifact of AVM2\'s internal trait'));

  if (ok > 0) console.log(`[amforder] ${ok} amf member order checks passed`);
  return bad;
}

// 阶段一百零二：ByteArray 的下标形式读（含正越界）。
// Semantics measured on adl 51.4.1 (temp/baidxprobe/ba-result.txt, 21 lines, plus
// za-result.txt / wa-result.txt); the negative cases below are source-level pins
// because the examples suite only runs programs that must succeed. Every pin was
// checked against real generated C (temp/bapins/pins.c), never guessed.
function checkByteArrayIndex(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [baidx] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [baidx] ${label}`); }
  };
  const preamble = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');

  // ---- the index reader itself ------------------------------------------
  check('ByteArray_get_index returns as_value (in range Number / past end undefined)',
    /as_value ByteArray_get_index\(void\* _this, int i\) \{/.test(preamble) === false
    && generateC(parse('import flash.utils.ByteArray;\nvar b:ByteArray = new ByteArray();\nvar v:* = b[0];\ntrace(v);\n')).c
      .includes('ByteArray_get_index(void* _this, int i) {'));
  const gen = generateC(parse('import flash.utils.ByteArray;\nvar b:ByteArray = new ByteArray();\nvar v:* = b[0];\ntrace(v);\n')).c;
  check('a negative index throws #1069 while an out-of-range index reads undefined',
    gen.includes('if (i < 0) { as_throw_sealed_get(as_str_from_int(i), "flash.utils.ByteArray"); return as_v_undefined(); }')
    && gen.includes('if (i >= o->length || o->data == NULL) return as_v_undefined();')
    && gen.includes('return as_v_num((double)((unsigned char*)o->data)[i]);'));

  // ---- canonical index text ---------------------------------------------
  check('as_ba_str_index rejects the non-canonical spellings AIR rejects',
    /static int as_ba_str_index\(char\* k\)/.test(gen)
    && gen.includes('as_ba_str_index'));
  const strIdx = gen.slice(gen.indexOf('static int as_ba_str_index(char* k)'));
  const body = strIdx.slice(0, strIdx.indexOf('\n}\n') + 3);
  check('the canonical test rejects empty / leading zero / non-digit / out-of-range keys',
    body.includes("if (k == NULL || k[0] == '\\0') return -1;")
    && body.includes("if (k[0] == '0' && k[1] != '\\0') return -1;   // leading zero is not canonical")
    && body.includes("if (*s < '0' || *s > '9') return -1;")
    && body.includes('if (v > 2147483647L) return -1;   // past int range -> property miss'));
  check('ByteArray_get_index_key turns a non-canonical key into a #1069 property miss',
    gen.includes('as_value ByteArray_get_index_key(void* _this, char* k) {')
    && gen.includes('if (i < 0) { as_throw_sealed_get(k, "flash.utils.ByteArray"); return as_v_undefined(); }'));

  // ---- call sites (real generated C: temp/bapins/pins.c) ------------------
  const pins = 'import flash.utils.ByteArray;\nvar n:int = 3;\n' +
    'function f(b:ByteArray, i:int, k:String, vv:*):void {\n' +
    '  var r1:* = b[i]; var r2:* = b[9]; var r3:* = b[k]; var r4:* = b["0"];\n' +
    '  var r5:* = b[n]; var r6:* = b[-1];\n' +
    '  b[5] = 7; b[n] = vv;\n' +
    '  var d:* = b; var r7:* = d[3]; var r8:* = d[k]; d[3] = vv;\n' +
    '  var r9:Boolean = ("0" in b);\n' +
    '  var r10:Boolean = delete b[0]; var r11:Boolean = delete d[0];\n' +
    '  var r12:int = d.length;\n' +
    '  trace(r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12);\n}\n';

  // ---- the runtime hooks -------------------------------------------------
  check('the ByteArray hook family has its own .length entry',
    preamble.includes('static int (*as_ba_len_hook)(void* ptr) = NULL;')
    && /as_any_length[\s\S]{0,600}as_ba_len_hook\(v\.ptr\)/.test(preamble));
  check('as_dyn_get consults the ByteArray hook only AFTER the props/getters walk',
    preamble.indexOf('if (as_ba_is_hook != NULL && as_ba_is_hook(obj)) return as_ba_get_key_hook(obj, key);')
      > preamble.indexOf('as_throw_sealed_get(key, hv->fqn)') - 4000
    && preamble.indexOf('if (as_ba_is_hook != NULL && as_ba_is_hook(obj)) return as_ba_get_key_hook(obj, key);') > 0);
  check('as_dyn_set routes a ByteArray index write through the hook',
    preamble.includes('if (as_ba_is_hook != NULL && as_ba_is_hook(obj)) { as_ba_set_key_hook(obj, key, v); return; }'));
  check('as_dyn_has routes a ByteArray membership test through the hook',
    preamble.includes('if (as_ba_is_hook != NULL && as_ba_is_hook(obj)) return as_ba_has_key_hook(obj, key);'));

  const pc = generateC(parse(pins)).c;
  check('a numeric index read hits ByteArray_get_index (as_value result)',
    pc.includes('r1 = ByteArray_get_index((void*)(((ByteArray*)as_req_obj((void*)(b)))), i);')
    && pc.includes('r2 = ByteArray_get_index((void*)(((ByteArray*)as_req_obj((void*)(b)))), 9);')
    && pc.includes('r6 = ByteArray_get_index((void*)(((ByteArray*)as_req_obj((void*)(b)))), (-1));'));
  check('a string key read goes through as_dyn_get so a real accessor still wins',
    pc.includes('r3 = as_dyn_get((void*)(((ByteArray*)as_req_obj((void*)(b)))), k);')
    && pc.includes('r4 = as_dyn_get((void*)(((ByteArray*)as_req_obj((void*)(b)))), "0");')
    && !pc.includes('ByteArray_get_index_key((void*)(('));
  check('a BOXED write value uses the string-parsing ToNumber, a static int does not',
    pc.includes('ByteArray_set_index((void*)(((ByteArray*)as_req_obj((void*)(b)))), 5, ((double)(7)));')
    && pc.includes('ByteArray_set_index((void*)(((ByteArray*)as_req_obj((void*)(b)))), g_n, as_v_to_number(vv));')
    && pc.includes('ByteArray_set_index(o, i, as_v_to_number(v));'));
  check('delete is a constant false on a static ByteArray and as_dyn_del on a * one',
    pc.includes('r10 = ((void)(b), false);')
    && pc.includes('r11 = as_dyn_del(as_v_obj_val(d), as_str_from_int(0));'));
  check('a * receiver uses the any helpers for .length and the index form',
    pc.includes('r12 = as_any_length(as_req_box(d));')
    && pc.includes('r7 = as_any_get(as_req_box(d), as_str_from_int(3));')
    && pc.includes('r9 = as_dyn_has(b, "0");'));
  check('as_ba_wire installs all five hooks and main calls it',
    pc.includes('static void as_ba_wire(void) {')
    && pc.includes('as_ba_is_hook = as_ba_is_impl;')
    && pc.includes('as_ba_get_key_hook = as_ba_get_key_impl;')
    && pc.includes('as_ba_set_key_hook = as_ba_set_key_impl;')
    && pc.includes('as_ba_has_key_hook = as_ba_has_key_impl;')
    && pc.includes('as_ba_len_hook = as_ba_len_impl;')
    && pc.split('static void as_ba_wire(void) {')[1].split('}')[0].split('as_ba_len_hook = as_ba_len_impl;').length === 2
    && pc.includes('as_ba_wire();'));

  const ex = readFileSync(join(dir, 'bytearray-index.as'), 'utf8');
  check('the example pins the measured undefined / #1069 / write-coercion rules',
    ex.includes('"in-range end reads undefined"')
    && ex.includes('"a negative index throws #1069"')
    && ex.includes('is not an index')
    && ex.includes('"dynamic write of "')
    && ex.includes('"delete b[0] is false and does not throw"')
    && ex.includes('is false even though the property table is empty'));
  check('the example records the known divergence (dynamic `as <primitive>` gives null on AIR)',
    ex.includes('as <原始类型>')
    && ex.includes('ca-result.txt'));

  if (ok > 0) console.log(`[baidx] ${ok} ByteArray index checks passed`);
  return bad;
}

registerGroup('unit: bytearray-amf/IndexForm', checkByteArrayIndex);

registerGroup('unit: bytearray-amf/ByteArrayAmf', checkByteArrayAmf);
registerGroup('unit: bytearray-amf/ByteArraySurface', checkByteArraySurface);
registerGroup('unit: bytearray-amf/AmfMemberOrder', checkAmfMemberOrder);
