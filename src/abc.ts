// AVM2 `DoABC` reader + SWC symbol timeline-script decoder (compile time / build layer).
//
// A Flash-authored skin symbol is a `DefineSprite` PLUS an ABC class: the symbol's
// timeline scripts — the `stop()`, the `buttonMode = true`, the click handler that
// moves a checkbox to its checked frame — are compiled into a generated class in the
// FLA package (`skin_fla.元件172_339`) whose constructor calls
// `addFrameScript(<frame - 1>, <method>)`. `swc.ts` bakes the ARTWORK out of the SWF
// but never read those scripts, so a scripted symbol's playhead never moved:
// talkmed's agreement checkbox stayed on frame 1 and every login was blocked by its
// "同意用户协议" toast (diff doc D17 / R9).
//
// This module decodes exactly that class shape and TRANSLATES its methods back into
// our own AST, so the one existing emitter compiles them as ordinary AS3 (AGENTS.md
// §2.9 — no second backend). It is deliberately NOT an AVM2 interpreter:
//
//   * only the method bodies of ONE symbol class are decoded, and only straight-line
//     code plus the `if` / `if-else` / ternary shapes Flash emits for a timeline
//     script (`if` arms are required to leave the value stack balanced, or to push
//     exactly one value each — anything else is refused);
//   * an opcode, trait or shape outside the supported set is REPORTED through
//     `notes` and the whole class is skipped, never guessed at (AGENTS.md §1.5:
//     say what is unsupported instead of silently mistranslating).
//
// What it does cover is the whole Flash timeline-script idiom: `stop`/`play`/
// `gotoAndStop`/`gotoAndPlay`, `buttonMode`/`mouseEnabled`/`mouseChildren`/`visible`
// on the clip or a named child, `label.autoSize = TextFieldAutoSize.LEFT`,
// `label.text`/`textColor`, dynamic `this["name"]` reads and writes with the
// `if (!x) x = "…"` guard Flash emits for them,
// `addEventListener(<MouseEvent constant>, this.method | function () { … })`,
// `setTimeout(function () { … }, ms)`, and nested closures over the symbol's `this`.

import type { ASType, Block, Expr, Param, Stmt, Visibility } from './ast.ts';

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/** One `addFrameScript(frameIndex0, method)` record from a symbol class's ctor. */
export interface AbcFrameScript {
  /** 1-based frame number (Flash passes `frame - 1`). */
  frame: number;
  /** Trait (method) name on the symbol class, e.g. `frame1`. */
  method: string;
}

/** A decoded method of the symbol class, already lowered to our AST. */
export interface AbcMethod {
  name: string;
  params: Param[];
  returnType: ASType;
  body: Block;
  visibility: Visibility;
}

export interface AbcSymbolClass {
  /** Frame scripts registered by the constructor, in registration order. */
  frames: AbcFrameScript[];
  /**
   * Fully-qualified names the decoded methods reach through the scope chain
   * (`flash.events.MouseEvent` for a `MouseEvent.CLICK`). The synthesized class
   * declaration imports these so the emitter resolves the short names the same way
   * it resolves a source file's own imports.
   */
  imports: string[];
  /** Every translatable method (the frame scripts and helpers such as `setText`). */
  methods: AbcMethod[];
  /** Anything that could not be decoded. A non-empty list makes the caller skip
   *  the class (keeping today's "no scripts" behaviour) and report why. */
  notes: string[];
}

export interface AbcTagRef {
  code: number;
  start: number;
  length: number;
}

/** `DoABC` tag code in the SWF tag stream. */
const TAG_DO_ABC = 82;

/**
 * Decode the timeline scripts of every `SymbolClass` character that has them.
 *
 * `body` is the (already inflated) SWF body and `tags` its scanned tag stream —
 * exactly what `extractSwc` holds. The result is keyed by SWF character id, the id
 * `SymbolClass` and the sprite bake both use.
 */
export function decodeSymbolScripts(
  body: Buffer,
  tags: readonly AbcTagRef[],
  classNames: ReadonlyMap<number, string>,
  charKinds: ReadonlyMap<number, string>
): { scripts: Map<number, AbcSymbolClass>; skipped: string[] } {
  // A DoABC tag is `flags:u32`, the ABC name as a NUL-terminated string, then the
  // ABC body. The tag's own name uses the package separator
  // (`skin_fla/元件172_339`) while SymbolClass uses a dot, so normalize to match.
  const byName = new Map<string, Buffer>();
  for (const t of tags) {
    if (t.code !== TAG_DO_ABC) continue;
    const d = body.subarray(t.start, t.start + t.length);
    const end = d.indexOf(0, 4);
    if (end < 0) continue;
    byName.set(d.toString('utf8', 4, end).replace(/\//g, '.'), d.subarray(end + 1));
  }

  const out = new Map<number, AbcSymbolClass>();
  const skipped: string[] = [];
  for (const [charId, className] of classNames) {
    const kind = charKinds.get(charId);
    if (kind !== 'sprite' && kind !== 'button') continue;
    const abc = byName.get(className);
    // No DoABC under this name simply means "this symbol has no timeline script".
    if (abc === undefined) continue;
    const decoded = decodeSymbolClass(abc, className);
    // Only a clean decode is trustworthy: a `notes`-bearing result means we could not
    // read part of the timeline, so leaving the character scriptless (and reporting it
    // upward) beats wiring a half-decoded one.
    if (decoded === null) continue; // no timeline script at all: nothing to report
    if (decoded.notes.length === 0) out.set(charId, decoded);
    else skipped.push(`#${charId} (${className}): ${decoded.notes.join('; ')}`);
  }
  return { scripts: out, skipped };
}

/** Decode one symbol class's ABC into frame scripts + methods. */
function decodeSymbolClass(abc: Buffer, className: string): AbcSymbolClass | null {
  const notes: string[] = [];
  let parsed: AbcFile;
  try {
    parsed = parseAbc(abc);
  } catch (err) {
    return { frames: [], methods: [], imports: [], notes: [`the ABC of '${className}' could not be parsed: ${(err as Error).message}`] };
  }
  // The DoABC tag is named after the class it carries, so select that instance:
  // a symbol ABC may also declare helper classes, and picking one at random would
  // wire the wrong `addFrameScript`.
  const matches = parsed.instances.filter((i) => i.name === className);
  if (matches.length === 0) {
    const names = parsed.instances.map((i) => i.name);
    const shown = names.slice(0, 8).join(', ') + (names.length > 8 ? `, … (${names.length} total)` : '');
    return {
      frames: [],
      methods: [],
      imports: [],
      notes: [`the ABC of '${className}' declares no class by that name (declares: ${shown})`],
    };
  }
  if (matches.length > 1) {
    return { frames: [], methods: [], imports: [], notes: [`the ABC of '${className}' declares ${matches.length} classes by that name`] };
  }
  const inst = matches[0];
  const tr = new Translator(parsed);

  // Frame scripts come from the constructor's `addFrameScript(i, this.frameN)` calls
  // rather than from the trait names: Flash also passes frame 7 to `frame8`, so the
  // name is NOT the frame number.
  const frames: AbcFrameScript[] = [];
  try {
    frames.push(...tr.ctorFrameScripts(inst.ctorMethod));
  } catch (err) {
    notes.push(`the constructor of '${className}' could not be read: ${(err as Error).message}`);
  }

  // Methods. `frame1` and friends are ordinary instance traits, and helpers such as
  // `setText`/`downClick` are referenced from the frame scripts, so the class only
  // behaves like AIR when all of its methods exist.
  const methods: AbcMethod[] = [];
  for (const t of inst.traits) {
    if (t.kind !== 'method' || t.name === null) continue;
    // `methodId` is the method-table index the trait carries, and it is 0-based —
    // the same number the body table uses (checked against swfdump: `setText`'s
    // trait points at the method whose signature is `(String):void`).
    const mi = parsed.methods[t.methodId];
    if (mi === undefined) continue;
    try {
      methods.push({ name: t.name, params: mi.params, returnType: mi.returnType, body: tr.translateMethod(t.methodId), visibility: 'public' });
    } catch (err) {
      notes.push(`method '${t.name}' of '${className}' could not be decoded: ${(err as Error).message}`);
    }
  }

  // A frame script that did not translate would leave the timeline half-wired, and a
  // helper that did not translate is still callable from a frame script, so a single
  // failure skips the whole class (loudly) rather than emitting a class that is
  // partially wired up.
  const translated = new Set(methods.map((m) => m.name));
  for (const f of frames) {
    if (!translated.has(f.method)) {
      notes.push(`frame ${f.frame} of '${className}' references '${f.method}', which was not decoded`);
    }
  }
  if (notes.length > 0) return { frames: [], methods: [], notes };
  if (frames.length === 0 && methods.length === 0) return null;
  // Sorted: the import list feeds the synthesized class declaration, and a stable
  // order keeps the generated C byte-identical between runs.
  return { frames, methods, imports: [...tr.externalRefs].sort(), notes };
}

// ---------------------------------------------------------------------------
// ABC container
// ---------------------------------------------------------------------------

interface AbcMultiname {
  /** Resolved local name, or null when it comes from the stack at run time. */
  name: string | null;
  /** Namespace name of a QName/Multiname (`''` = the global namespace). */
  ns: string;
  /** True for the `…L` kinds (MultinameL / RTQNameL): the name is a stack value. */
  late: boolean;
}

interface AbcMethodInfo {
  name: string | null;
  params: Param[];
  returnType: ASType;
}

interface AbcTrait {
  kind: string;
  name: string | null;
  methodId: number;
}

interface AbcInstance {
  /** Qualified class name, e.g. `skin_fla.元件172_339`. */
  name: string;
  ctorMethod: number;
  traits: AbcTrait[];
}

interface AbcFile {
  /** Offset just past the parsed tables; a caller can assert it equals the tag
   *  length, which is what proves the table layout above is right. */
  end: number;
  strings: string[];
  ints: number[];
  uints: number[];
  doubles: number[];
  multinames: AbcMultiname[];
  methods: AbcMethodInfo[];
  bodies: Map<number, Buffer>;
  instances: AbcInstance[];
}

/** A cursor over a byte buffer. `u30` is AVM2's variable-length integer. */
class AbcReader {
  private readonly b: Buffer;
  p: number;
  constructor(b: Buffer, p = 0) {
    this.b = b;
    this.p = p;
  }
  u8(): number {
    return this.b[this.p++];
  }
  u16(): number {
    const v = this.b.readUInt16LE(this.p);
    this.p += 2;
    return v;
  }
  /** Signed 24-bit (branch offsets). */
  s24(): number {
    const v = this.b.readUIntLE(this.p, 3);
    this.p += 3;
    return (v & 0x800000) !== 0 ? v - 0x1000000 : v;
  }
  dbl(): number {
    const v = this.b.readDoubleLE(this.p);
    this.p += 8;
    return v;
  }
  u30(): number {
    let r = 0;
    let shift = 0;
    for (;;) {
      const x = this.u8();
      r |= (x & 0x7f) << shift;
      if ((x & 0x80) === 0) return r >>> 0;
      shift += 7;
    }
  }
  str(): string {
    const n = this.u30();
    const s = this.b.toString('utf8', this.p, this.p + n);
    this.p += n;
    return s;
  }
}

const KIND = {
  QName: 0x07,
  QNameA: 0x0d,
  RTQName: 0x0f,
  RTQNameA: 0x10,
  RTQNameL: 0x11,
  RTQNameLA: 0x12,
  Multiname: 0x09,
  MultinameA: 0x0e,
  MultinameL: 0x1b,
  MultinameLA: 0x1c,
  TypeName: 0x1d,
  TypeNameA: 0x1e,
  TypeNameL: 0x1f,
  TypeNameLA: 0x20,
} as const;

const TRAIT_KIND = ['slot', 'method', 'getter', 'setter', 'class', 'function', 'const'] as const;

/** `method_info.flags` bits that add fields to the record. */
const FLAG_HAS_OPTIONAL = 0x08;
const FLAG_HAS_PARAM_NAMES = 0x80;

/** Parse the parts of an ABC file this decoder needs. Throws on anything unknown. */
export function parseAbc(buf: Buffer): AbcFile {
  const r = new AbcReader(buf);
  r.u16();
  r.u16(); // minor, major
  const countThen = <T>(read: (i: number) => T): T[] => {
    const n = r.u30();
    const a: T[] = [];
    for (let i = 1; i < n; i++) a.push(read(i));
    return a;
  };
  const ints = countThen(() => r.u30());
  const uints = countThen(() => r.u30());
  const doubles = countThen(() => r.dbl());
  const strings = countThen(() => r.str());
  // Namespaces are kept: an instance's name is a QName, so rebuilding its qualified
  // name (`skin_fla.元件172_339`) needs the namespace string.
  const namespaces = countThen(() => {
    r.u8();
    return strings[r.u30() - 1] ?? '';
  });
  const nsSets = countThen(() => {
    const n = r.u30();
    const set: string[] = [];
    for (let i = 0; i < n; i++) set.push(namespaces[r.u30() - 1] ?? '');
    return set;
  });
  const multinames = countThen<AbcMultiname>(() => {
    const kind = r.u8();
    switch (kind) {
      case KIND.QName:
      case KIND.QNameA: {
        const ns = r.u30();
        return { name: strings[r.u30() - 1] ?? null, ns: namespaces[ns - 1] ?? '', late: false };
      }
      case KIND.RTQName:
      case KIND.RTQNameA:
        return { name: strings[r.u30() - 1] ?? null, ns: '', late: false };
      case KIND.RTQNameL:
      case KIND.RTQNameLA:
        return { name: null, ns: '', late: true };
      case KIND.Multiname:
      case KIND.MultinameA: {
        // (name, ns_set): a name qualified by a whole set of namespaces.
        const name = r.u30();
        const nsSet = r.u30();
        return { name: strings[name - 1] ?? null, ns: nsSet === 0 ? '' : (nsSets[nsSet - 1] ?? []).join('|'), late: false };
      }
      case KIND.MultinameL:
      case KIND.MultinameLA:
        // ONE operand: the ns_set. The name is the runtime key (late bound).
        r.u30();
        return { name: null, ns: '', late: true };
      case KIND.TypeNameL:
      case KIND.TypeNameLA:
        // A TypeName whose type arguments are only known at runtime.
        r.u30();
        return { name: null, ns: '', late: false };
      case KIND.TypeName:
      case KIND.TypeNameA: {
        const name = r.u30();
        const n = r.u30();
        for (let i = 0; i < n; i++) r.u30();
        return { name: strings[name - 1] ?? null, ns: '', late: false };
      }
      default:
        throw new Error(`unknown multiname kind 0x${kind.toString(16)}`);
    }
  });

  const mnAt = (i: number): AbcMultiname => {
    const m = multinames[i - 1];
    if (m === undefined) throw new Error(`multiname index ${i} out of range`);
    return m;
  };
  /** AS3 type name for a multiname index (`*` and `void` included). */
  const typeName = (i: number): ASType => {
    if (i === 0) return 'any';
    const { name } = mnAt(i);
    if (name === null || name === '*') return 'any';
    if (name === 'void') return 'void';
    // `flash.events:MouseEvent` -> `MouseEvent`: built-ins are keyed by short name.
    const colon = name.lastIndexOf(':');
    return (colon >= 0 ? name.slice(colon + 1) : name) as ASType;
  };

  const methodCount = r.u30();
  const methods: AbcMethodInfo[] = [];
  for (let mi = 0; mi < methodCount; mi++) methods.push(readMethod());
  function readMethod(): AbcMethodInfo {
    const paramCount = r.u30();
    const ret = r.u30();
    const paramTypes: number[] = [];
    for (let i = 0; i < paramCount; i++) paramTypes.push(r.u30());
    const nameIdx = r.u30();
    const flags = r.u8();
    // `option_info` and the param names are present only when flagged: the encoder
    // omits them entirely for the vast majority of methods, so reading them
    // unconditionally desyncs the whole table (verified against swfdump's dump of
    // talkmed's skin.swc, where a symbol class has 5 4-byte method_info entries).
    if ((flags & FLAG_HAS_OPTIONAL) !== 0) {
      const optCount = r.u30();
      for (let i = 0; i < optCount; i++) {
        r.u30();
        r.u8();
      }
    }
    const paramNames: number[] = [];
    if ((flags & FLAG_HAS_PARAM_NAMES) !== 0) {
      for (let i = 0; i < paramCount; i++) paramNames.push(r.u30());
    }
    const params: Param[] = [];
    for (let i = 0; i < paramCount; i++) {
      params.push({
        name: paramNames[i] === 0 ? `arg${i}` : (strings[paramNames[i] - 1] ?? `arg${i}`),
        type: typeName(paramTypes[i]),
        defaultValue: null,
        isRest: false,
      });
    }
    return { name: nameIdx === 0 ? null : (strings[nameIdx - 1] ?? null), params, returnType: typeName(ret) };
  }

  const metaCount = r.u30();
  for (let i = 0; i < metaCount; i++) {
    r.u30(); // metadata name (a string index)
    const n = r.u30(); // item count
    for (let j = 0; j < n; j++) {
      r.u30();
      r.u30();
    }
  }

  const readTraits = (): AbcTrait[] => {
    const n = r.u30();
    const out: AbcTrait[] = [];
    for (let i = 0; i < n; i++) {
      const nameIdx = r.u30();
      const tag = r.u8();
      const kind = TRAIT_KIND[tag & 0xf] ?? 'slot';
      const attr = tag >> 4;
      let methodId = 0;
      if (kind === 'slot' || kind === 'const') {
        r.u30();
        r.u30();
        if (r.u30() !== 0) r.u8();
      } else if (kind === 'method' || kind === 'getter' || kind === 'setter') {
        r.u30();
        methodId = r.u30();
      } else {
        r.u30();
        const second = r.u30();
        if (kind === 'function') methodId = second;
      }
      if ((attr & 0x4) !== 0) {
        // A trait's metadata list holds one metadata index per entry (the key/value
        // pairs live in the metadata table itself).
        const mn = r.u30();
        for (let j = 0; j < mn; j++) r.u30();
      }
      // A trait's name is a MULTINAME index (the same pool the instructions use),
      // not a string index: reading it as a string yields nonsense like
      // "flash.display" for `gotoAndStop`.
      const mn = nameIdx === 0 ? null : (multinames[nameIdx - 1] ?? null);
      out.push({ kind, name: mn?.name ?? null, methodId });
    }
    return out;
  };

  // `class_count` is read once and drives BOTH tables. The instance entries are
  // 0-based on `iinit` (the constructor), which is what the method table below uses.
  const instanceCount = r.u30();
  const instanceTraits: AbcTrait[][] = [];
  const ctorMethods: number[] = [];
  const instanceNames: string[] = [];
  for (let i = 0; i < instanceCount; i++) {
    const mn = mnAt(r.u30());
    instanceNames.push(mn.ns === '' ? (mn.name ?? '?') : `${mn.ns}.${mn.name ?? '?'}`);
    r.u30(); // base class (a multiname)
    const flags = r.u8();
    // `protectedNs` is a NAMESPACE index (not a multiname): talkmed's checkbox
    // symbol points at its own ProtectedNamespace entry here.
    if ((flags & 0x08) !== 0) r.u30();
    const nint = r.u30();
    for (let j = 0; j < nint; j++) r.u30();
    ctorMethods.push(r.u30());
    instanceTraits.push(readTraits());
  }
  for (let i = 0; i < instanceCount; i++) {
    r.u30(); // class init method
    readTraits();
  }
  const scriptCount = r.u30();
  for (let i = 0; i < scriptCount; i++) {
    r.u30();
    readTraits();
  }

  const bodies = new Map<number, Buffer>();
  const bodyCount = r.u30();
  for (let i = 0; i < bodyCount; i++) {
    const methodId = r.u30();
    r.u30();
    r.u30(); // maxStack, maxRegs
    r.u30();
    r.u30(); // scopeDepth, maxScope
    const codeLen = r.u30();
    bodies.set(methodId, Buffer.from(buf.subarray(r.p, r.p + codeLen)));
    r.p += codeLen;
    const exCount = r.u30();
    for (let j = 0; j < exCount; j++) {
      for (let k = 0; k < 5; k++) r.u30();
    }
    readTraits();
  }

  return {
    end: r.p,
    strings,
    ints,
    uints,
    doubles,
    multinames,
    methods,
    bodies,
    instances: instanceTraits.map((traits, i) => ({
      name: instanceNames[i],
      ctorMethod: ctorMethods[i],
      traits,
    })),
  };
}

// ---------------------------------------------------------------------------
// Instruction decoding
// ---------------------------------------------------------------------------

interface Ins {
  op: number;
  off: number;
  /** First immediate (multiname / cpool / local / method / count / argc). */
  a: number;
  /** Second immediate (argc of a two-operand call form). */
  b: number;
  /** Branch target as an instruction index; -1 when the op is not a branch. */
  target: number;
}

/**
 * Operand shapes, in the order the operands appear in the instruction stream.
 *
 *  - `none`   no immediates
 *  - `byte`   one u8 immediate (local index, `pushbyte`, `getscopeobject`)
 *  - `u30`    one u30 immediate (cpool / multiname index, count, method index)
 *  - `u30u30` two u30 immediates (index + arg_count)
 *  - `branch` one s24 branch offset
 *  - `switch` s24 default + u30 case count + count × s24
 *  - `debug`  u8 debug_type + u30 string index + u8 reg + u8 extra
 */
type OpShape = 'none' | 'byte' | 'u30' | 'u30u30' | 'branch' | 'switch' | 'debug';

/**
 * The AVM2 instruction set (AVM2 Overview, appendix).
 *
 * Every opcode Flash's compiler emits for a symbol class is listed here together with
 * the immediates it carries, so `decodeCode` can walk a body without guessing. An
 * opcode we have not verified is deliberately ABSENT: decoding then throws (AGENTS.md
 * §1.5) rather than desyncing the instruction stream — a desynced stream would
 * translate into silently wrong C, which is far worse than a skipped symbol.
 *
 * Numbers are the spec's own ("name = N (0xNN)"): note `ifnlt` is 0x0C and `pushbyte`
 * is 0x24, which is where a table built from memory goes wrong.
 */
const OPCODES: Record<number, { name: string; shape: OpShape }> = {
  // --- control flow -------------------------------------------------------
  0x09: { name: 'label', shape: 'none' },
  0x0c: { name: 'ifnlt', shape: 'branch' },
  0x0d: { name: 'ifnle', shape: 'branch' },
  0x0e: { name: 'ifngt', shape: 'branch' },
  0x0f: { name: 'ifnge', shape: 'branch' },
  0x10: { name: 'jump', shape: 'branch' },
  0x11: { name: 'iftrue', shape: 'branch' },
  0x12: { name: 'iffalse', shape: 'branch' },
  0x13: { name: 'ifeq', shape: 'branch' },
  0x14: { name: 'ifne', shape: 'branch' },
  0x15: { name: 'iflt', shape: 'branch' },
  0x16: { name: 'ifle', shape: 'branch' },
  0x17: { name: 'ifgt', shape: 'branch' },
  0x18: { name: 'ifge', shape: 'branch' },
  0x19: { name: 'ifstricteq', shape: 'branch' },
  0x1a: { name: 'ifstrictne', shape: 'branch' },
  0x1b: { name: 'lookupswitch', shape: 'switch' },
  // --- stack, constants, scopes -------------------------------------------
  0x02: { name: 'nop', shape: 'none' },
  0x03: { name: 'throw', shape: 'none' },
  0x08: { name: 'kill', shape: 'u30' },
  0x1c: { name: 'pushwith', shape: 'none' },
  0x1d: { name: 'popscope', shape: 'none' },
  0x1e: { name: 'nextname', shape: 'none' },
  0x1f: { name: 'hasnext', shape: 'none' },
  0x20: { name: 'pushnull', shape: 'none' },
  0x21: { name: 'pushundefined', shape: 'none' },
  0x23: { name: 'nextvalue', shape: 'none' },
  0x24: { name: 'pushbyte', shape: 'byte' },
  0x25: { name: 'pushshort', shape: 'u30' },
  0x26: { name: 'pushtrue', shape: 'none' },
  0x27: { name: 'pushfalse', shape: 'none' },
  0x28: { name: 'pushnan', shape: 'none' },
  0x29: { name: 'pop', shape: 'none' },
  0x2a: { name: 'dup', shape: 'none' },
  0x2b: { name: 'swap', shape: 'none' },
  0x2c: { name: 'pushstring', shape: 'u30' },
  0x2d: { name: 'pushint', shape: 'u30' },
  0x2e: { name: 'pushuint', shape: 'u30' },
  0x2f: { name: 'pushdouble', shape: 'u30' },
  0x30: { name: 'pushscope', shape: 'none' },
  0x31: { name: 'pushnamespace', shape: 'u30' },
  0x32: { name: 'hasnext2', shape: 'u30u30' },
  // --- objects, functions, calls ------------------------------------------
  0x40: { name: 'newfunction', shape: 'u30' },
  0x41: { name: 'call', shape: 'u30' },
  0x42: { name: 'construct', shape: 'u30' },
  0x43: { name: 'callmethod', shape: 'u30u30' },
  0x44: { name: 'callstatic', shape: 'u30u30' },
  0x45: { name: 'callsuper', shape: 'u30u30' },
  0x46: { name: 'callproperty', shape: 'u30u30' },
  0x47: { name: 'returnvoid', shape: 'none' },
  0x48: { name: 'returnvalue', shape: 'none' },
  0x49: { name: 'constructsuper', shape: 'u30' },
  0x4a: { name: 'constructprop', shape: 'u30u30' },
  0x4c: { name: 'callproplex', shape: 'u30u30' },
  0x4e: { name: 'callsupervoid', shape: 'u30u30' },
  0x4f: { name: 'callpropvoid', shape: 'u30u30' },
  0x55: { name: 'newobject', shape: 'u30' },
  0x56: { name: 'newarray', shape: 'u30' },
  0x57: { name: 'newactivation', shape: 'none' },
  0x58: { name: 'newclass', shape: 'u30' },
  0x59: { name: 'getdescendants', shape: 'u30' },
  0x5a: { name: 'newcatch', shape: 'u30' },
  // --- properties, slots, locals -----------------------------------------
  0x04: { name: 'getsuper', shape: 'u30' },
  0x05: { name: 'setsuper', shape: 'u30' },
  0x06: { name: 'dxns', shape: 'u30' },
  0x07: { name: 'dxnslate', shape: 'none' },
  0x5d: { name: 'findpropstrict', shape: 'u30' },
  0x5e: { name: 'findproperty', shape: 'u30' },
  0x60: { name: 'getlex', shape: 'u30' },
  0x61: { name: 'setproperty', shape: 'u30' },
  0x62: { name: 'getlocal', shape: 'byte' },
  0x63: { name: 'setlocal', shape: 'byte' },
  0x64: { name: 'getglobalscope', shape: 'none' },
  0x65: { name: 'getscopeobject', shape: 'byte' },
  0x66: { name: 'getproperty', shape: 'u30' },
  0x68: { name: 'initproperty', shape: 'u30' },
  0x6a: { name: 'deleteproperty', shape: 'u30' },
  0x6c: { name: 'getslot', shape: 'u30' },
  0x6d: { name: 'setslot', shape: 'u30' },
  0x6e: { name: 'getglobalslot', shape: 'u30' },
  0x6f: { name: 'setglobalslot', shape: 'u30' },
  // --- conversions and type tests ----------------------------------------
  0x70: { name: 'convert_s', shape: 'none' },
  0x71: { name: 'esc_xelem', shape: 'none' },
  0x72: { name: 'esc_xattr', shape: 'none' },
  0x73: { name: 'convert_i', shape: 'none' },
  0x74: { name: 'convert_u', shape: 'none' },
  0x75: { name: 'convert_d', shape: 'none' },
  0x76: { name: 'convert_b', shape: 'none' },
  0x77: { name: 'convert_o', shape: 'none' },
  0x78: { name: 'checkfilter', shape: 'none' },
  0x80: { name: 'coerce', shape: 'u30' },
  0x82: { name: 'coerce_a', shape: 'none' },
  0x85: { name: 'coerce_s', shape: 'none' },
  0x86: { name: 'astype', shape: 'u30' },
  0x87: { name: 'astypelate', shape: 'none' },
  // --- arithmetic and logic ----------------------------------------------
  0x90: { name: 'negate', shape: 'none' },
  0x91: { name: 'increment', shape: 'none' },
  0x92: { name: 'inclocal', shape: 'u30' },
  0x93: { name: 'decrement', shape: 'none' },
  0x94: { name: 'declocal', shape: 'u30' },
  0x95: { name: 'typeof', shape: 'none' },
  0x96: { name: 'not', shape: 'none' },
  0x97: { name: 'bitnot', shape: 'none' },
  0xa0: { name: 'add', shape: 'none' },
  0xa1: { name: 'subtract', shape: 'none' },
  0xa2: { name: 'multiply', shape: 'none' },
  0xa3: { name: 'divide', shape: 'none' },
  0xa4: { name: 'modulo', shape: 'none' },
  0xa5: { name: 'lshift', shape: 'none' },
  0xa6: { name: 'rshift', shape: 'none' },
  0xa7: { name: 'urshift', shape: 'none' },
  0xa8: { name: 'bitand', shape: 'none' },
  0xa9: { name: 'bitor', shape: 'none' },
  0xaa: { name: 'bitxor', shape: 'none' },
  0xab: { name: 'equals', shape: 'none' },
  0xac: { name: 'strictequals', shape: 'none' },
  0xad: { name: 'lessthan', shape: 'none' },
  0xae: { name: 'lessequals', shape: 'none' },
  0xaf: { name: 'greaterthan', shape: 'none' },
  0xb0: { name: 'greaterequals', shape: 'none' },
  0xb1: { name: 'instanceof', shape: 'none' },
  0xb2: { name: 'istype', shape: 'u30' },
  0xb3: { name: 'istypelate', shape: 'none' },
  0xb4: { name: 'in', shape: 'none' },
  0xc0: { name: 'increment_i', shape: 'none' },
  0xc1: { name: 'decrement_i', shape: 'none' },
  0xc2: { name: 'inclocal_i', shape: 'u30' },
  0xc3: { name: 'declocal_i', shape: 'u30' },
  0xc4: { name: 'negate_i', shape: 'none' },
  0xc5: { name: 'add_i', shape: 'none' },
  0xc6: { name: 'subtract_i', shape: 'none' },
  0xc7: { name: 'multiply_i', shape: 'none' },
  // --- register shortcuts and debug info ---------------------------------
  0xd0: { name: 'getlocal_0', shape: 'none' },
  0xd1: { name: 'getlocal_1', shape: 'none' },
  0xd2: { name: 'getlocal_2', shape: 'none' },
  0xd3: { name: 'getlocal_3', shape: 'none' },
  0xd4: { name: 'setlocal_0', shape: 'none' },
  0xd5: { name: 'setlocal_1', shape: 'none' },
  0xd6: { name: 'setlocal_2', shape: 'none' },
  0xd7: { name: 'setlocal_3', shape: 'none' },
  0xef: { name: 'debug', shape: 'debug' },
  0xf0: { name: 'debugline', shape: 'u30' },
  0xf1: { name: 'debugfile', shape: 'u30' },
};

/** Mnemonic for diagnostics; falls back to the raw byte for an unknown opcode. */
export function opName(op: number): string {
  return OPCODES[op]?.name ?? `0x${op.toString(16)}`;
}

/** Decode a method body into an instruction list. Throws on an unknown opcode. */
export function decodeCode(code: Buffer, methodName: string | null): Ins[] {
  const r = new AbcReader(code);
  const raw: { op: number; off: number; a: number; b: number; delta: number }[] = [];
  while (r.p < code.length) {
    const off = r.p;
    const op = r.u8();
    const spec = OPCODES[op];
    if (spec === undefined) {
      throw new Error(`unsupported opcode 0x${op.toString(16)} at byte ${off} in '${methodName ?? '<anon>'}'`);
    }
    let a = 0;
    let b = 0;
    let delta = 0;
    switch (spec.shape) {
      case 'none':
        break;
      case 'byte':
        a = r.u8();
        break;
      case 'u30':
        a = r.u30();
        break;
      case 'u30u30':
        a = r.u30();
        b = r.u30();
        break;
      case 'branch':
        delta = r.s24();
        break;
      case 'switch': {
        delta = r.s24();
        const n = r.u30();
        for (let i = 0; i < n; i++) r.s24();
        break;
      }
      case 'debug':
        r.u8();
        a = r.u30();
        r.u8();
        r.u8();
        break;
    }
    raw.push({ op, off, a, b, delta });
  }
  const offToIdx = new Map<number, number>();
  raw.forEach((ins, i) => offToIdx.set(ins.off, i));
  return raw.map((x, i) => {
    if (OPCODES[x.op]?.shape !== 'branch') return { op: x.op, off: x.off, a: x.a, b: x.b, target: -1 };
    // A branch offset is relative to the END of the branch instruction (the start of
    // the next one), not to the opcode itself — checked byte-by-byte against Flash's
    // own output in skin.swc.
    const next = i + 1 < raw.length ? raw[i + 1].off : code.length;
    const dest = next + x.delta;
    const target = offToIdx.get(dest);
    if (target === undefined) {
      throw new Error(`branch at byte ${x.off} lands mid-instruction (byte ${dest}) in '${methodName ?? '<anon>'}'`);
    }
    return { op: x.op, off: x.off, a: x.a, b: x.b, target };
  });
}

// ---------------------------------------------------------------------------
// Bytecode -> AST
// ---------------------------------------------------------------------------

const BINOP: Record<number, string> = { 0x94: '+', 0x97: '+', 0x98: '-', 0x9a: '-', 0xa2: '*', 0xa9: '/' };

/** Sentinel marking the object `findpropstrict`/`findproperty` push (a scope binding). */
interface ScopeRef {
  scopeBinding: string;
}
function isScopeRef(e: Expr): e is Expr & ScopeRef {
  return (e as unknown as { scopeBinding?: string }).scopeBinding !== undefined;
}
function scopeRef(binding: string): Expr {
  // The marker field must be the one the interface declares, or `recv.scopeBinding`
  // reads `undefined` at runtime while TypeScript still believes it is a string.
  return { kind: 'Var', name: binding, scopeBinding: binding } as unknown as Expr;
}

class Translator {
  private readonly abc: AbcFile;
  /**
   * Class/global names reached through the scope chain (`findpropstrict X;
   * getproperty X` / `getlex`), as fully-qualified names. A symbol's ABC carries
   * its own constant pool and no import list, so these are the only record of
   * which names the code expects to find — the caller turns them into imports.
   */
  readonly externalRefs = new Set<string>();
  constructor(abc: AbcFile) {
    this.abc = abc;
  }

  /** Record a scope-chain name so the caller can import it (see `externalRefs`). */
  private noteExternal(binding: string, mnIndex: number): void {
    const mn = this.mnAt(mnIndex);
    if (mn.ns !== '') this.externalRefs.add(`${mn.ns}.${mn.name ?? binding}`);
  }

  // ---- constructor scan ----------------------------------------------------

  /**
   * Read the frame registrations out of a symbol class's constructor.
   *
   * Flash compiles a timeline script into `addFrameScript(frame - 1, this.frameN)`
   * (one call with several pairs when more than one frame carries a script), so the
   * frame number is the ARGUMENT and not the method name (`frame8` is frame 7).
   */
  ctorFrameScripts(methodId: number): AbcFrameScript[] {
    const code = this.abc.bodies.get(methodId);
    if (code === undefined) return [];
    const ins = decodeCode(code, 'constructor');
    const out: AbcFrameScript[] = [];
    const stack: Expr[] = [];
    const pop = (): Expr => {
      const v = stack.pop();
      if (v === undefined) throw new Error('value stack underflow');
      return v;
    };
    for (const x of ins) {
      switch (x.op) {
        case 0xd0: // getlocal_0
          stack.push({ kind: 'Var', name: 'this' });
          break;
        case 0x5d: // findpropstrict
        case 0x5e: // findproperty
          stack.push(scopeRef(this.name(x.a) ?? '?'));
          break;
        case 0x24: // pushbyte
        case 0x25: // pushshort
          stack.push({ kind: 'Num', value: x.a, isInt: true });
          break;
        case 0x2d: // pushint
          stack.push({ kind: 'Num', value: this.abc.ints[x.a - 1] ?? 0, isInt: true });
          break;
        case 0x66: // getproperty
          stack.push(this.property(pop(), x.a, true, undefined));
          break;
        case 0x46: // callproperty
        case 0x4f: { // callpropvoid
          const args = stack.splice(stack.length - x.b, x.b);
          pop(); // the `findpropstrict` scope binding
          if (this.name(x.a) === 'addFrameScript') out.push(...this.framePairs(args));
          // `callproperty` leaves a value (the ctor's next instruction pops it);
          // `callpropvoid` leaves nothing.
          if (x.op === 0x46) stack.push({ kind: 'Var', name: 'undefined' });
          break;
        }
        case 0x49: // constructsuper: `super()` in the synthesized constructor
          stack.splice(Math.max(0, stack.length - x.a), x.a);
          pop(); // the receiver (`this` was duplicated by `getlocal_0`)
          break;
        case 0x30: // pushscope: moves the top value onto the scope chain
        case 0x1d: // popscope
        case 0x29: // pop
          pop();
          break;
        case 0x47: // returnvoid
        case 0x09: // label
        case 0x02: // nop
        case 0xef: // debug
        case 0xf0: // debugline
        case 0xf1: // debugfile
          break;
        default:
          // A Flash symbol constructor is `super(); addFrameScript(…)` and nothing
          // else; anything beyond that means this is not that shape.
          throw new Error(`unexpected opcode ${opName(x.op)} at byte ${x.off} in the constructor`);
      }
    }
    return out;
  }

  /** `(0, this.frame1, 3, this.frame2)` argument pairs -> frame registrations. */
  private framePairs(args: Expr[]): AbcFrameScript[] {
    const out: AbcFrameScript[] = [];
    for (let i = 0; i + 1 < args.length; i += 2) {
      const frame = args[i];
      const fn = args[i + 1];
      if (frame.kind !== 'Num' || fn.kind !== 'Member' || fn.property === '') {
        throw new Error('addFrameScript argument shape not understood');
      }
      out.push({ frame: frame.value + 1, method: fn.property });
    }
    return out;
  }

  // ---- method translation --------------------------------------------------

  /** The main entry point: the method's statements as a `Block`. */
  translateMethod(methodId: number): Block {
    const code = this.abc.bodies.get(methodId);
    if (code === undefined) throw new Error(`method ${methodId} has no body`);
    const mi = this.abc.methods[methodId];
    const ins = decodeCode(code, mi?.name ?? null);
    const ctx: Ctx = {
      ins,
      stack: [],
      regs: seedParams(mi?.params ?? []),
      prelude: [],
      activation: false,
      activationVars: new Set(),
    };
    const out: Stmt[] = [];
    this.region(ctx, 0, ins.length, out);
    return { kind: 'Block', body: [...ctx.prelude, ...out] };
  }

  /**
   * Translate `ins[start, end)` into statements, appending to `out`.
   *
   * `ctx.stack` is the value stack carried INTO the region (a branch's arms inherit
   * whatever was pushed before the branch, such as the receiver of the call the
   * ternary feeds) and is mutated in place so the caller can see what an arm left
   * behind. A conditional branch becomes two nested regions classified by what the
   * arms leave: nothing (a statement `if`) or exactly one value each (the ternary
   * `if` Flash uses to pick a call argument or an assigned value).
   */
  private region(ctx: Ctx, start: number, end: number, out: Stmt[]): void {
    const { ins, stack } = ctx;
    const pop = (): Expr => {
      const v = stack.pop();
      if (v === undefined) throw new Error('value stack underflow');
      return v;
    };
    const bin = (op: string): void => {
      const right = pop();
      stack.push({ kind: 'Binary', op, left: pop(), right });
    };
    const un = (op: string): void => {
      stack.push({ kind: 'Unary', op, operand: pop() });
    };
    const convert = (name: string): void => {
      stack.push({ kind: 'Call', callee: { kind: 'Var', name }, args: [pop()] });
    };
    let i = start;
    while (i < end) {
      const x = ins[i];
      switch (x.op) {
        // ---- conditional branches ------------------------------------------
        case 0x12: // iffalse
        case 0x11: // iftrue
        {
          const cond: Expr = x.op === 0x12 ? pop() : { kind: 'Unary', op: '!', operand: pop() };
          if (x.target <= i) {
            throw new Error(`unsupported backward branch (loop) at byte ${x.off}`);
          }
          const depth = stack.length;
          const thenStart = i + 1;
          const elseStart = x.target;
          // Flash lays a two-armed `if`/ternary out as
          //     cond; iffalse ELSE; then…; jump JOIN; else…; JOIN
          // so the arm before the else-block ends with the `jump` that skips it.
          const last = ins[elseStart - 1];
          const hasElse = elseStart - 1 > i && last.op === 0x10 && last.target >= elseStart;
          const thenEnd = hasElse ? elseStart - 1 : elseStart;
          const join = hasElse ? last.target : elseStart;
          const thenStmts: Stmt[] = [];
          this.region(ctx, thenStart, thenEnd, thenStmts);
          const thenDepth = stack.length;
          if (thenDepth === depth) {
            let elseStmts: Stmt[] = [];
            if (hasElse) {
              elseStmts = [];
              this.region(ctx, elseStart, join, elseStmts);
            }
            if (stack.length !== depth) throw new Error('if/else arms leave different stack depths');
            out.push({ kind: 'If', cond, then: blk(thenStmts), else: elseStmts.length > 0 ? blk(elseStmts) : null });
          } else if (thenDepth === depth + 1) {
            // Both arms leave exactly one value. The arms put it on the (shared)
            // value stack — reading it back off the stack is the only faithful way,
            // because a bare `push …; coerce_a` arm emits no statements at all.
            if (!hasElse) throw new Error('ternary without an else arm');
            if (thenStmts.length > 0) throw new Error('ternary arm has statements, not a plain value');
            const thenValue = pop();
            const elseStmts: Stmt[] = [];
            this.region(ctx, elseStart, join, elseStmts);
            if (stack.length !== depth + 1) throw new Error('ternary arms leave different stack depths');
            if (elseStmts.length > 0) throw new Error('ternary arm has statements, not a plain value');
            const elseValue = pop();
            stack.push({ kind: 'Conditional', cond, then: thenValue, else: elseValue });
          } else {
            throw new Error('if/else arms leave an unsupported value-stack shape');
          }
          i = join;
          continue;
        }
        case 0x0c: // ifnlt 0x0d ifnle 0x0e ifngt 0x0f ifnge
        case 0x0d:
        case 0x0e:
        case 0x0f:
        case 0x13: // ifeq 0x14 ifne 0x15 iflt 0x16 ifle
        case 0x14:
        case 0x15:
        case 0x16:
        case 0x17: // ifgt 0x18 ifge 0x19 ifstricteq 0x1a ifstrictne
        case 0x18:
        case 0x19:
        case 0x1a:
        case 0x1b: // lookupswitch
          throw new Error(`unsupported conditional branch ${opName(x.op)} at byte ${x.off}`);
        case 0x10: // jump
          i = x.target;
          continue;

        // ---- bookkeeping / no-ops -----------------------------------------
        case 0x02: // nop
        case 0x07: // dxnslate
        case 0x09: // label
        case 0x1d: // popscope: pops the scope chain, no value-stack effect
        case 0x80: // coerce: a type hint, the value is unchanged
        case 0x82: // coerce_a
        case 0x06: // dxns
        case 0xef: // debug
        case 0xf0: // debugline
        case 0xf1: // debugfile
          i++;
          continue;
        case 0x30: // pushscope: the top value moves onto the scope chain
          pop();
          i++;
          continue;
        case 0x57: // newactivation: an opaque scope object; its bindings are the
          // `initproperty` writes handled below plus `setlocal1`/`getlocal1`.
          ctx.activation = true;
          stack.push({ kind: 'Var', name: 'undefined' });
          i++;
          continue;
        case 0x08: // kill
          ctx.regs.delete(x.a);
          i++;
          continue;
        case 0x47: // returnvoid
          i = end;
          continue;
        case 0x48: // returnvalue
          out.push({ kind: 'Return', value: pop() });
          i = end;
          continue;
        case 0x29: { // pop
          const stmt = asStatement(pop());
          if (stmt !== null) out.push(stmt);
          i++;
          continue;
        }

        // ---- constants and locals -----------------------------------------
        case 0xd0: stack.push({ kind: 'Var', name: 'this' }); i++; continue;
        case 0xd1:
        case 0xd2:
        case 0xd3: stack.push(this.readReg(ctx, x.op - 0xd0)); i++; continue;
        case 0xd4:
        case 0xd5:
        case 0xd6:
        case 0xd7: ctx.regs.set(x.op - 0xd4, pop()); i++; continue;
        case 0x62: stack.push(this.readReg(ctx, x.a)); i++; continue;
        case 0x63: ctx.regs.set(x.a, pop()); i++; continue;
        case 0x24: // pushbyte
        case 0x25: // pushshort
          stack.push({ kind: 'Num', value: x.a, isInt: true });
          i++;
          continue;
        case 0x2d: stack.push({ kind: 'Num', value: this.abc.ints[x.a - 1] ?? 0, isInt: true }); i++; continue;
        case 0x2e: stack.push({ kind: 'Num', value: this.abc.uints[x.a - 1] ?? 0, isInt: true }); i++; continue;
        case 0x2f: stack.push({ kind: 'Num', value: this.abc.doubles[x.a - 1] ?? 0, isInt: false }); i++; continue;
        case 0x2c: stack.push({ kind: 'Str', value: this.abc.strings[x.a - 1] ?? '' }); i++; continue;
        case 0x26: stack.push({ kind: 'Bool', value: true }); i++; continue;
        case 0x27: stack.push({ kind: 'Bool', value: false }); i++; continue;
        case 0x20: stack.push({ kind: 'Null' }); i++; continue;
        case 0x21: stack.push({ kind: 'Var', name: 'undefined' }); i++; continue;
        case 0x28: stack.push({ kind: 'Num', value: NaN, isInt: false }); i++; continue;
        case 0x2a: { // dup
          const v = stack[stack.length - 1];
          if (v === undefined) throw new Error('dup with an empty stack');
          stack.push(v);
          i++;
          continue;
        }
        case 0x2b: { // swap
          const top = pop();
          const below = pop();
          stack.push(top);
          stack.push(below);
          i++;
          continue;
        }

        // ---- operators -----------------------------------------------------
        case 0xa0: bin('+'); i++; continue;
        case 0xa1: bin('-'); i++; continue;
        case 0xa2: bin('*'); i++; continue;
        case 0xa3: bin('/'); i++; continue;
        case 0xa4: bin('%'); i++; continue;
        case 0xa5: bin('<<'); i++; continue;
        case 0xa6: bin('>>'); i++; continue;
        case 0xa7: bin('>>>'); i++; continue;
        case 0xa8: bin('&'); i++; continue;
        case 0xa9: bin('|'); i++; continue;
        case 0xaa: bin('^'); i++; continue;
        case 0xab: bin('=='); i++; continue;
        case 0xac: bin('==='); i++; continue;
        case 0xad: bin('<'); i++; continue;
        case 0xae: bin('<='); i++; continue;
        case 0xaf: bin('>'); i++; continue;
        case 0xb0: bin('>='); i++; continue;
        case 0x90: un('-'); i++; continue;
        case 0x96: un('!'); i++; continue;
        case 0x97: un('~'); i++; continue;
        case 0x95: // typeof
          stack.push({ kind: 'Typeof', operand: pop() });
          i++;
          continue;
        case 0x70: // convert_s
        case 0x85: // coerce_s
          convert('String');
          i++;
          continue;
        case 0x76: // convert_b
          convert('Boolean');
          i++;
          continue;
        case 0x73: // convert_i
          convert('int');
          i++;
          continue;
        case 0x74: // convert_u
          convert('uint');
          i++;
          continue;
        case 0x75: // convert_d
          convert('Number');
          i++;
          continue;
        case 0x77: // convert_o: non-null objects pass through unchanged
          i++;
          continue;

        // ---- property access ----------------------------------------------
        case 0x66: { // getproperty
          // The receiver is on the stack, and for a late-bound multiname the NAME
          // is on the stack too (above the receiver).
          const late = this.mnAt(x.a).late;
          const key = late ? pop() : undefined;
          const recv = pop();
          stack.push(this.property(recv, x.a, true, key));
          i++;
          continue;
        }
        case 0x61: // setproperty
        case 0x68: { // initproperty
          const late = this.mnAt(x.a).late;
          const key = late ? pop() : undefined;
          const value = pop();
          const recv = pop();
          if (isActivationStore(recv, value)) {
            // `this._self = this` with an activation in scope is Flash storing the
            // clip in the activation so a nested closure can reach it; the closure
            // reads it back through `findpropstrict <name>; getproperty <name>`.
            this.declareActivationVar(ctx, this.name(x.a) ?? '?');
          } else {
            const target = this.property(recv, x.a, false, key);
            out.push({ kind: 'ExprStmt', expr: { kind: 'Assign', op: '=', target, value } });
          }
          i++;
          continue;
        }
        case 0x5d: // findpropstrict
        case 0x5e: // findproperty
          stack.push(scopeRef(this.name(x.a) ?? '?'));
          i++;
          continue;
        case 0x60: // getlex
          this.noteExternal(this.name(x.a) ?? '?', x.a);
          stack.push({ kind: 'Var', name: this.name(x.a) ?? '?' });
          i++;
          continue;

        // ---- calls ----------------------------------------------------------
        case 0x46: // callproperty
        case 0x4c: // callproplex
        case 0x4f: { // callpropvoid
          const args = stack.splice(Math.max(0, stack.length - x.b), x.b);
          const recv = pop();
          const call: Expr = { kind: 'Call', callee: callTarget(recv, this.name(x.a)), args };
          if (x.op === 0x4f) {
            const stmt = asStatement(call);
            if (stmt !== null) out.push(stmt);
          } else {
            stack.push(call);
          }
          i++;
          continue;
        }
        case 0x4a: { // constructprop
          const args = stack.splice(Math.max(0, stack.length - x.b), x.b);
          const target = pop();
          stack.push(
            target.kind === 'Var'
              ? { kind: 'New', className: target.name, args }
              : { kind: 'NewDynamic', classExpr: target, args }
          );
          i++;
          continue;
        }
        case 0x42: { // construct
          const args = stack.splice(Math.max(0, stack.length - x.a), x.a);
          const target = pop();
          stack.push(
            target.kind === 'Var'
              ? { kind: 'New', className: target.name, args }
              : { kind: 'NewDynamic', classExpr: target, args }
          );
          i++;
          continue;
        }
        case 0x41: { // call: the callee is a stack value (a closure)
          const args = stack.splice(Math.max(0, stack.length - x.a), x.a);
          stack.push({ kind: 'Call', callee: pop(), args });
          i++;
          continue;
        }
        case 0x43: // callmethod
        case 0x44: { // callstatic
          const args = stack.splice(Math.max(0, stack.length - x.b), x.b);
          stack.push({ kind: 'Call', callee: { kind: 'Var', name: `method${x.a}` }, args });
          i++;
          continue;
        }
        case 0x40: // newfunction
          stack.push(this.closure(ctx, x.a));
          i++;
          continue;
        case 0x49: // constructsuper: the synthesized constructor does this itself
          stack.splice(Math.max(0, stack.length - x.a), x.a);
          pop();
          i++;
          continue;
        case 0x55: { // newobject: alternating name/value on the stack
          const vals = stack.splice(Math.max(0, stack.length - x.a * 2), x.a * 2);
          const fields: { name: string; value: Expr }[] = [];
          for (let k = 0; k < vals.length; k += 2) {
            const key = vals[k];
            fields.push({ name: key.kind === 'Str' ? key.value : '?', value: vals[k + 1] });
          }
          stack.push({ kind: 'ObjectLit', fields });
          i++;
          continue;
        }
        case 0x56: { // newarray
          stack.push({ kind: 'ArrayLit', elements: stack.splice(Math.max(0, stack.length - x.a), x.a) });
          i++;
          continue;
        }
        default:
          throw new Error(`unsupported opcode ${opName(x.op)} at byte ${x.off}`);
      }
    }
  }

  /** Declare `var <name>:* = this;` in the method prologue (the activation idiom). */
  private declareActivationVar(ctx: Ctx, name: string): void {
    if (ctx.activationVars.has(name)) return;
    ctx.activationVars.add(name);
    ctx.prelude.push({ kind: 'VarDecl', name, type: 'any', init: { kind: 'Var', name: 'this' } });
  }

  private readReg(ctx: Ctx, slot: number): Expr {
    const v = ctx.regs.get(slot);
    if (v === undefined) {
      if (ctx.activation) return { kind: 'Var', name: 'undefined' };
      throw new Error(`read of unset register ${slot}`);
    }
    return v;
  }

  /** `obj.name` / `obj[key]`, with the scope-binding pseudo-receiver resolved. */
  private property(recv: Expr, mnIndex: number, read: boolean, key: Expr | undefined): Expr {
    const mn = this.mnAt(mnIndex);
    if (isScopeRef(recv)) {
      // `findpropstrict X; …; getproperty X` is how AVM2 reads a scope binding: a
      // class, a global, or a member reached through the scope chain.
      if (read) {
        this.noteExternal(recv.scopeBinding, mnIndex);
        return { kind: 'Var', name: recv.scopeBinding };
      }
      // A WRITE through the scope object writes to the clip itself.
      return { kind: 'Member', object: { kind: 'Var', name: 'this' }, property: this.name(mnIndex) ?? recv.scopeBinding };
    }
    if (mn.late) {
      // MultinameL / RTQNameL: the name is a stack value, so `obj[key]` is a
      // dynamic property access — exactly what `this["labelOff"]` needs.
      if (key === undefined) throw new Error('late-bound property with no name on the stack');
      return { kind: 'Index', object: recv, index: key };
    }
    return { kind: 'Member', object: recv, property: mn.name ?? '?' };
  }

  /** Translate a nested `newfunction` body into a closure value. */
  private closure(ctx: Ctx, methodId: number): Expr {
    const code = this.abc.bodies.get(methodId);
    const mi = this.abc.methods[methodId];
    if (code === undefined || mi === undefined) throw new Error(`newfunction ${methodId} has no body`);
    const ins = decodeCode(code, mi.name);
    const inner: Ctx = {
      ins,
      stack: [],
      regs: seedParams(mi.params),
      prelude: [],
      activation: ctx.activation,
      activationVars: ctx.activationVars,
    };
    const out: Stmt[] = [];
    this.region(inner, 0, ins.length, out);
    return {
      kind: 'FunctionExpr',
      name: null,
      params: mi.params,
      returnType: mi.returnType,
      body: { kind: 'Block', body: [...inner.prelude, ...out] },
    };
  }

  private name(i: number): string | null {
    if (i === 0) return null;
    return this.abc.multinames[i - 1]?.name ?? null;
  }
  private mnAt(i: number): AbcMultiname {
    const m = this.abc.multinames[i - 1];
    if (m === undefined) throw new Error(`multiname index ${i} out of range`);
    return m;
  }
}

interface Ctx {
  ins: Ins[];
  stack: Expr[];
  regs: Map<number, Expr>;
  prelude: Stmt[];
  /** True once `newactivation` has been seen (Flash's closure bookkeeping). */
  activation: boolean;
  activationVars: Set<string>;
}

/**
 * Registers 1..n hold a method's parameters (register 0 is `this`), so a body that
 * reads one sees the argument rather than an unset register.
 */
function seedParams(params: Param[]): Map<number, Expr> {
  const regs = new Map<number, Expr>();
  params.forEach((p, i) => regs.set(i + 1, { kind: 'Var', name: p.name }));
  return regs;
}

/** `_self = this` (both sides `this`) is Flash's activation store. */
function isActivationStore(recv: Expr, value: Expr): boolean {
  const isThis = (e: Expr): boolean => e.kind === 'Var' && (e as { name: string }).name === 'this';
  return isThis(recv) && isThis(value);
}

function blk(body: Stmt[]): Stmt {
  return { kind: 'Block', body };
}

/** A discarded stack value: keep it when it has side effects, drop it otherwise. */
function asStatement(v: Expr): Stmt | null {
  if (v.kind === 'Call' || v.kind === 'Assign' || v.kind === 'New' || v.kind === 'NewDynamic' || v.kind === 'Update') {
    return { kind: 'ExprStmt', expr: v };
  }
  return null;
}

/** Receiver of a `callproperty`: a scope binding calls itself, else `obj.name(…)`. */
function callTarget(recv: Expr, name: string | null): Expr {
  if (isScopeRef(recv) && (name === null || recv.scopeBinding === name)) {
    // `findpropstrict foo; …; callproperty foo` is the unqualified call `foo(…)`,
    // which the emitter resolves to `this.foo(…)` for a method of this class.
    return { kind: 'Var', name: recv.scopeBinding };
  }
  if (name === null) throw new Error('late-bound call with no name on the stack');
  return { kind: 'Member', object: recv, property: name };
}
