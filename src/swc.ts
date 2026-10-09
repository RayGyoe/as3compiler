// SWC resource extractor (compile-time / build layer).
//
// A SWC is a ZIP archive, but the resources are NOT standalone files: mxmlc
// compiles them into `library.swf` as SWF tags (bitmaps -> DefineBitsLossless2 /
// DefineBitsJPEG2), with a `SymbolClass` tag mapping character ids to AS3 class
// names. So "reading resources out of a SWC" =
//   ZIP unpack -> inflate the CWS/ZWS SWF -> scan the tag stream -> decode the
//   bitmap payload -> (reverse-premultiply) -> re-encode as PNG.
//
// Everything here runs at compile time on the Node side and uses only built-ins
// (node:zlib), per AGENTS.md §3.1 (zero third-party dependencies). The runtime
// never parses SWF: it just decodes the embedded PNG/JPEG bytes via Skia
// (`as_skia_image_decode_bytes_argb`), exactly like `Loader.loadBytes` does.
//
// Scope (swc.md §3.3): this module reads RESOURCES only. `DoABC` (AVM2
// bytecode) is deliberately not parsed — repurposing bytecode needs a
// decompiler or an AVM2 interpreter, i.e. a separate project.
//
// Reference: docs/zh-cn/swc.md §§3.1, 3.2, 4, 5. The two traps that produce
// silently visible-but-wrong output are:
//   ① tag 20's format 5 is XRGB (no alpha), tag 36's format 5 is ARGB;
//   ② the stored pixels are PREMULTIPLIED, while AS3's `BitmapData` is straight
//      ARGB — so extraction must reverse-premultiply at compile time (§3.2).

import { readFileSync } from 'node:fs';
import { inflateRawSync, inflateSync, deflateSync } from 'node:zlib';
import type { Expr, Stmt } from './ast.ts';
import { qualifiedName } from './symbols.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SwcBitmap {
  /** SWF character id (used by `SymbolClass` and by shape fills). */
  tagId: number;
  /** Fully-qualified AS3 class name from `SymbolClass`, or null when unnamed.
   *  In `temp/skin.swc` 16 of 59 bitmaps are named; the other 43 are referenced
   *  only as fills by shapes/sprites (swc.md §6). */
  className: string | null;
  /** Encoding of `encoded`. Both are decoded by Skia at runtime. */
  format: 'png' | 'jpeg' | 'gif';
  width: number;
  height: number;
  /** Encoded image bytes to embed in the generated C (swc.md §5.1). */
  encoded: Buffer;
}

/**
 * A text character (`DefineText` tag 11 / `DefineEditText` tag 37).
 *
 * The baker does NOT decode glyphs or the initial string (swc.md §3.3: text
 * rendering is out of scope for the resource baker). It still reads the character's
 * own RECT, because AIR instantiates these characters as real `TextField`s and the
 * display list must therefore carry a child at that index with that box
 * (item ②, measured in temp/childfx: `staticskin` has 19 children of which 18 are
 * TextFields, `fileitemskin` c1 is an EMPTY TextField 409.8x20.4).
 */
export interface SwcText {
  id: number;
  /** The character's box in its own space (DefineText's `TextBounds`, DefineEditText's `Bounds`). */
  bounds: SwcRect;
  /**
   * `DefineEditText`'s AutoSize flag (bit 0x80 of the second flag byte). AIR then
   * fits the field box to the glyphs it lays out, so the RECT is NOT the box AIR
   * reports for that child (measured: `fileitemskin` c2 is 221.25x41.65 in AIR while
   * its RECT is 37.15x19.55 wide). Counting those separately keeps "our box equals
   * AIR's" honest instead of averaging a known gap into a precision claim.
   * Always false for `DefineText` (tag 11), which has no such flag.
   */
  autoSize: boolean;
}

export interface SwcLibrary {
  /** Path the library was read from (for diagnostics / provenance comments). */
  source: string;
  /** Every bitmap tag, named or not, in tag order. */
  bitmaps: SwcBitmap[];
  /** Every `DefineShape`/`2`/`3`/`4` vector character (swc.md §3.4). */
  shapes: SwcShape[];
  /** Every `DefineSprite` timeline container (first frame is what static skins use). */
  sprites: SwcSprite[];
  /** Every `DefineButton`/`DefineButton2` four-state button. */
  buttons: SwcButton[];
  /** Every text character (`DefineText`/`DefineEditText`) — baked as empty TextField
   *  placeholders so the tree shape matches AIR (item ②). */
  texts: SwcText[];
  /** `DefineScalingGrid` (tag 78): characterId -> 9-slice splitter rect. */
  scalingGrids: Map<number, SwcRect>;
  /** `SymbolClass` id -> AS3 class name. */
  classNames: Map<number, string>;
  /** Every character definition we know about, keyed by character id. */
  characters: Map<number, SwcCharacter>;
}

/** The named bitmaps only — the ones a user's AS3 can name (swc.md §6). */
export function namedResources(lib: SwcLibrary): SwcBitmap[] {
  return lib.bitmaps.filter((b) => b.className !== null);
}

/**
 * One named resource, described the way the emitter needs it: the AS3 name (the
 * `getDefinitionByName` registry key), the sanitized C class identifier, the C
 * byte-array symbol, and the encoded bytes to embed.
 */
export interface SwcResourceSpec {
  className: string; // AS3 fully-qualified name, e.g. "logo" / "a.b.Skin"
  cname: string; // sanitized C class identifier
  bytesSymbol: string; // generated C array holding `encoded`
  width: number;
  height: number;
  format: 'png' | 'jpeg' | 'gif';
  encoded: Buffer;
  source: string; // .swc the resource came from (provenance comment)
}

/** Split an AS3 fully-qualified name into (short name, package). */
function splitFqn(fqn: string): { name: string; pkg: string | null } {
  const dot = fqn.lastIndexOf('.');
  return dot < 0 ? { name: fqn, pkg: null } : { name: fqn.slice(dot + 1), pkg: fqn.slice(0, dot) };
}

/**
 * Synthesize the AST class declaration for one resource class (swc.md §6).
 *
 * A resource class is a `dynamic` `BitmapData` subclass whose constructor takes
 * `(int width, int height)` — and IGNORES both arguments (measured: `new
 * logo(0,0)` yields a 100x72 bitmap; the arguments are a Flash IDE idiom). The
 * real pixels come from the embedded bytes, wired in by the emitter through the
 * bytes symbol (see `Emitter`'s `swcResources`), not from this AS3 body.
 */
function swcClassDecl(name: string, pkg: string | null): Stmt {
  const num = (v: number): Expr => ({ kind: 'Num', value: v, isInt: true });
  return {
    kind: 'ClassDecl',
    name,
    packageName: pkg,
    // Fully-qualified so `resolveType` maps it to the short-keyed built-in
    // (flash.* built-ins are keyed by short name, per symbols.ts resolveType).
    superClass: 'flash.display.BitmapData',
    isFinal: false,
    isDynamic: true,
    implements: [],
    metadata: [],
    imports: ['flash.display.BitmapData'],
    fileId: null,
    members: [
      {
        kind: 'Constructor',
        // Both parameters default, so the class is constructible with no
        // arguments and registers a real no-arg factory for reflection
        // (`getDefinitionByName(...)` + `new`).
        params: [
          { name: 'width', type: 'int', defaultValue: num(0), isRest: false },
          { name: 'height', type: 'int', defaultValue: num(0), isRest: false },
        ],
        body: {
          kind: 'Block',
          body: [{ kind: 'SuperCall', args: [num(0), num(0), { kind: 'Bool', value: true }, num(0)] }],
        },
      },
    ],
  };
}

/**
 * A character class the emitter must bind to a baked display tree: the class's C
 * identifier plus the SWF character id it instantiates. `kind` selects the C
 * superclass the class was synthesized with (a sprite becomes a MovieClip, a
 * button a SimpleButton).
 */
export interface SwcCharacterClass {
  cname: string;
  charId: number;
  kind: 'sprite' | 'button';
}

/**
 * Turn an extracted library into the things the compiler needs: synthetic
 * `ClassDecl`s to append to the program (so every exported symbol resolves as an
 * ordinary class — types, imports, vtables, the reflection registry), the specs
 * the emitter uses to place the embedded bitmap bytes, and the character bindings
 * the emitter uses to bake display trees into the synthesized classes' ctors.
 *
 * Every `SymbolClass` entry gets a class, not just the bitmaps: an exported
 * sprite is a `MovieClip` subclass, an exported button a `SimpleButton`, and a
 * baked ctor body is what makes `new homeskin()` show the artwork (swc.md §9 E-3).
 */
export function swcCompileInputs(lib: SwcLibrary): {
  decls: Stmt[];
  specs: SwcResourceSpec[];
  chars: SwcCharacterClass[];
} {
  const decls: Stmt[] = [];
  const specs: SwcResourceSpec[] = [];
  const chars: SwcCharacterClass[] = [];
  for (const r of namedResources(lib)) {
    const { name, pkg } = splitFqn(r.className);
    const cname = qualifiedName(name, pkg);
    decls.push(swcClassDecl(name, pkg));
    specs.push({
      className: r.className,
      cname,
      bytesSymbol: `__res_${cname}`,
      width: r.width,
      height: r.height,
      format: r.format,
      encoded: r.encoded,
      source: lib.source,
    });
  }
  for (const [charId, className] of lib.classNames) {
    const kind = lib.characters.get(charId)?.kind;
    if (kind !== 'sprite' && kind !== 'button') continue;
    const { name, pkg } = splitFqn(className);
    decls.push(swcDisplayClassDecl(name, pkg, kind));
    chars.push({ cname: qualifiedName(name, pkg), charId, kind });
  }
  return { decls, specs, chars };
}

/**
 * Synthesize the AST class declaration for an exported sprite or button.
 *
 * AIR's symbol classes are `MovieClip`/`SimpleButton` subclasses whose ctor takes
 * no arguments and builds the artwork from the SWF timeline. Here the body is
 * empty: the baked display tree is attached by the emitter after the ctor runs
 * (`as_swc_bind`), because the construction is C — not AS3 — and therefore cannot
 * live in an AST body (AGENTS.md §2.8).
 */
function swcDisplayClassDecl(name: string, pkg: string | null, kind: 'sprite' | 'button'): Stmt {
  return {
    kind: 'ClassDecl',
    name,
    packageName: pkg,
    // Fully-qualified so resolveType maps it to the short-keyed built-in.
    superClass: kind === 'sprite' ? 'flash.display.MovieClip' : 'flash.display.SimpleButton',
    isFinal: false,
    isDynamic: false,
    implements: [],
    metadata: [],
    imports: [kind === 'sprite' ? 'flash.display.MovieClip' : 'flash.display.SimpleButton'],
    fileId: null,
    members: [
      {
        kind: 'Constructor',
        params: [],
        // SimpleButton_ctor takes all four states positionally in C (no defaults
        // survive into the generated function), so the no-arg AS3 ctor must pass
        // them explicitly. MovieClip takes none, so an empty body is complete.
        body: {
          kind: 'Block',
          body: kind === 'button'
            ? [{ kind: 'SuperCall', args: [{ kind: 'Null' }, { kind: 'Null' }, { kind: 'Null' }, { kind: 'Null' }] }]
            : [],
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// ZIP container
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number; // 0 = stored, 8 = deflate
  data: Buffer; // fully decompressed contents
}

/** Locate the End-Of-Central-Directory record (it may have a trailing comment). */
function findEocd(zip: Buffer): number {
  // Signature "PK\x05\x06" = 0x06054b50 little-endian. The comment is at most
  // 65535 bytes, so only that window needs scanning.
  const min = Math.max(0, zip.length - 22 - 0xffff);
  for (let i = zip.length - 22; i >= min; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('SWC: ZIP end-of-central-directory record not found (not a ZIP/SWC?)');
}

/** Parse the ZIP central directory and inflate every entry (swc.md §4 step ①). */
function unzip(zip: Buffer): ZipEntry[] {
  const eocd = findEocd(zip);
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16); // central directory offset
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`SWC: malformed central directory entry #${i} at offset ${p}`);
    }
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const fnLen = zip.readUInt16LE(p + 28);
    const exLen = zip.readUInt16LE(p + 30);
    const cmLen = zip.readUInt16LE(p + 32);
    const localOff = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + fnLen);
    p += 46 + fnLen + exLen + cmLen;

    // The local header repeats the name/extra lengths (they may differ from the
    // central directory's), so the payload offset must be computed from it.
    if (zip.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error(`SWC: malformed local header for '${name}' at offset ${localOff}`);
    }
    const lFnLen = zip.readUInt16LE(localOff + 26);
    const lExLen = zip.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lFnLen + lExLen;
    const raw = zip.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`SWC: unsupported ZIP compression method ${method} for '${name}'`);
    entries.push({ name, method, data });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// SWF container
// ---------------------------------------------------------------------------

/** Decompress the SWF body from `library.swf` (FWS/CWS/ZWS), swc.md §4 step ②. */
function swfBody(swf: Buffer): Buffer {
  const sig = swf.toString('latin1', 0, 3);
  if (sig === 'FWS') return swf.subarray(8); // uncompressed
  if (sig === 'CWS') return inflateSync(swf.subarray(8)); // zlib
  if (sig === 'ZWS') {
    // LZMA layout is documented (swc.md §4) but Node has no built-in LZMA codec
    // and the project forbids third-party deps. `temp/skin.swc` is CWS, and ZWS
    // support is explicitly deferred (§10) — fail loudly rather than silently.
    throw new Error(
      'SWC: this library uses ZWS (LZMA) compression, which is not yet supported ' +
        '(see docs/zh-cn/swc.md §10); re-export the SWC as CWS/FWS.'
    );
  }
  throw new Error(`SWC: unrecognized SWF signature '${sig}' (expected FWS/CWS/ZWS)`);
}

/** Skip the stage header (RECT + frameRate + frameCount) -> tag stream offset. */
function stageHeaderEnd(body: Buffer): number {
  // RECT: 5-bit nbits, then 4 nbits-sized fields. Its byte length is
  // ceil((5 + 4*nbits)/8); frameRate + frameCount add 4 bytes (swc.md §4 step ③).
  const nbits = body[0] >> 3;
  const rectBytes = Math.ceil((5 + 4 * nbits) / 8);
  return rectBytes + 4;
}

interface SwfTag {
  code: number;
  /** Offset of the payload within `body`. */
  start: number;
  length: number;
}
/** Scan the tag stream sequentially (swc.md §4 step ④). */
function scanTags(body: Buffer, from?: number, to?: number): SwfTag[] {
  const tags: SwfTag[] = [];
  const end = to ?? body.length;
  let p = from ?? stageHeaderEnd(body);
  while (p + 2 <= end) {
    const rec = body.readUInt16LE(p);
    const code = rec >> 6;
    let length = rec & 0x3f;
    p += 2;
    if (length === 0x3f) {
      if (p + 4 > end) break;
      length = body.readUInt32LE(p);
      p += 4;
    }
    if (p + length > end) {
      throw new Error(`SWC: truncated SWF tag ${code} at offset ${p} (needs ${length} B)`);
    }
    tags.push({ code, start: p, length });
    p += length;
  }
  return tags;
}

// ---------------------------------------------------------------------------//
// The bitmaps are only half the library: `DefineShape*` carries the actual skin
// geometry (378 of them here), `DefineSprite` the timelines that place them, and
// `DefineScalingGrid`/`DefineButton2` the 9-slice and button behaviour. All of it
// is parsed at compile time (never at runtime, per AGENTS.md §1.3) and baked into
// C. Field order/semantics mirror Ruffle's `swf/src/read.rs`; the traps that
// silently desync the bit stream are documented on the readers below.
// ---------------------------------------------------------------------------

/** A SWF RECT in twips (1/20 px). */
export interface SwcRect {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

export interface SwcGradientStop {
  ratio: number; // 0..255
  rgba: number; // 0xAARRGGBB
}

/** A resolved FILLSTYLE (swc.md §3.4④). */
export interface SwcFillStyle {
  /** 0x00 solid | 0x10 linear | 0x12 radial | 0x13 focal | 0x40..0x43 bitmap. */
  type: number;
  rgba?: number; // solid fills
  gradKind?: 'linear' | 'radial' | 'focal';
  /** Gradient/bitmap placement matrix [a, b, c, d, tx, ty] (tx/ty in twips). */
  matrix?: number[];
  stops?: SwcGradientStop[];
  /** GRADIENT flags hi nibble: bits 6-7 spread (0 pad, 1 reflect, 2 repeat). */
  spread?: number;
  /** GRADIENT flags hi nibble: bits 4-5 interpolation (0 sRGB, 1 linearRGB). */
  interp?: number;
  focal?: number; // focal gradients (FIXED8)
  bitmapId?: number; // bitmap fills -> SWF character id
  repeating?: boolean;
  smoothed?: boolean;
}

/** A resolved LINESTYLE / LINESTYLE2 (swc.md §3.4⑤: v4 flags are MSB-first). */
export interface SwcLineStyle {
  width: number; // twips
  rgba?: number; // when the stroke is a solid colour
  fillStyle?: SwcFillStyle; // LINESTYLE2 HasFill: the stroke paints a fill
  startCap?: number;
  join?: number; // 0 round, 1 bevel, 2 miter
  endCap?: number;
  miter?: number;
  noHScale?: number;
  noVScale?: number;
}

/** One path segment endpoint, absolute twips; a quadratic edge also carries its control point. */
export interface SwcEdge {
  x: number;
  y: number;
  cx?: number;
  cy?: number;
}

/**
 * A style table. `STYLECHANGERECORD`'s NewStyles flag does NOT extend the table:
 * it REPLACES it (Ruffle's ShapeConverter rebinds `fill_styles` and resizes the
 * pending paths there), and starts a new drawing layer painted after the previous
 * one. So style ids restart at 1 in each layer and the tables must be kept per
 * layer — otherwise every post-NewStyles reference is off by the previous
 * table's size. Index 0 is a placeholder meaning "no style".
 */
export interface SwcStyleLayer {
  fills: SwcFillStyle[];
  lines: SwcLineStyle[];
}

/** A maximal run of edges sharing one (layer, fill0, fill1, line) style tuple. */
export interface SwcSubPath {
  layer: number;
  fill0: number; // 0 = none, else 1-based index into this layer's fills
  fill1: number;
  line: number; // 0 = none, else 1-based index into this layer's lines
  /** Pen position when the run started (the moveTo point, or wherever the pen was). */
  start: SwcEdge;
  /** True when the run began with an explicit moveTo, so `start` is real geometry. */
  moveToFirst: boolean;
  /** The run's start edge, then one entry per edge record (quadratics carry cx/cy). */
  pts: SwcEdge[];
}

export interface SwcShape {
  id: number;
  version: 1 | 2 | 3 | 4;
  bounds: SwcRect; // ShapeBounds (twips)
  /** DefineShape4's UsesFillWindingRule: nonzero fills instead of the even-odd default. */
  winding: 'evenOdd' | 'nonZero';
  layers: SwcStyleLayer[];
  subpaths: SwcSubPath[];
}

/** One `PlaceObject*` record on a sprite timeline. */
export interface SwcPlacement {
  depth: number;
  charId: number | null; // null for a pure Modify (move without a character)
  move: boolean;
  name: string | null;
  /** [a, b, c, d, tx, ty]; tx/ty in twips. */
  matrix: number[] | null;
  /** [rMul, gMul, bMul, aMul, rAdd, gAdd, bAdd, aAdd] (mults 0..1, adds -255..255). */
  cxform: number[] | null;
  /**
   * `PlaceObject2` HasClipDepth: this placement is a MASK, not artwork.
   *
   * It is not painted; instead it clips every sibling whose depth lies in
   * `(depth, clipDepth]` (SWF spec: "the mask applies to objects at depths
   * greater than the mask's own depth and less than or equal to clipDepth").
   * skin.swc character #826 (`loginskin`) is the case that surfaced this: its
   * depth-2 white rect has clipDepth 5, so the depth-3 `banner` movieclip — a
   * 1416x402 filmstrip — is visible only inside those 354x402 px, while AIR does
   * not paint the mask rect itself. Ignoring the field painted the full
   * filmstrip AND a white rect over it (swc.md §9 E-4).
   *
   * null = an ordinary drawable placement.
   */
  clipDepth: number | null;
  /**
   * `PlaceObject3` HasVisible with `Visible == 0`: AIR does not paint this
   * placement at all (and it is not hit-testable). 38 records in skin.swc carry
   * it, all inside the exported closure — ignoring the field painted 38 objects
   * AIR hides (swc.md §9.2 F3).
   *
   * A hidden record still occupies its depth: AIR's rule is "nothing is shown at
   * this depth", so a hidden record also cancels an earlier record at the same
   * depth (the bake plan deletes the depth rather than skipping the record).
   */
  hidden: boolean;
  /**
   * The `PlaceObject3` HasVisible byte as a tri-state: `null` = the record
   * carries no Visible field, `true` = Visible is 1 (shown), `false` = Visible
   * is 0 (hidden, same as `hidden`). Item ③ needs the tri-state: on a later
   * frame's Modify record, Visible absent means "leave the object's visibility
   * alone" while Visible = 1 means "show it again".
   */
  visibleFlag: boolean | null;
  /**
   * `PlaceObject2` Ratio: the morph ratio applied to the morph shape at this
   * depth. Kept so the timeline bake can report it (morphs are placeholders).
   */
  ratio: number | null;
  /**
   * `PlaceObject3` FILTERLIST (swc.md §9.2 F4). Empty when the record has none.
   *
   * These were read-and-dropped until v0.4.65: the SWF carries them, AIR applies
   * them, and our runtime already had the whole `DisplayObject.filters` path
   * (`as_render_filtered`). 13 of the 63 records in the test skin's baked closure
   * carry one, so dropping them was a silent visual regression, not a missing
   * feature.
   */
  filters: SwcFilter[];
  /** FILTERLIST entries whose kind we cannot render (Bevel, Convolution, ...).
   *  Reported loudly by the bake plan instead of being dropped silently. */
  skippedFilters: number[];
  /** `PlaceObject3` BlendMode: the raw SWF byte, or null when absent. */
  blendMode: number | null;
  /** `PlaceObject3` BitmapCached (`true` = the SWF asks AIR to cache it). */
  bitmapCached: boolean;
}

/**
 * One `FILTER` record from a `PlaceObject3` FILTERLIST, in the shape our runtime's
 * `DisplayObject.filters` takes (swc.md §9.2 F4).
 *
 * Only the three kinds `as_render_filtered` can paint are modelled — the other
 * SWF kinds are skipped **and reported**, never silently dropped.
 *
 * Layouts (Ruffle `read_filter` agrees with the spec byte for byte): the geometric
 * fields are FIXED (16.16), `strength` is FIXED8 (8.8), and DropShadow/Glow end in
 * a flags byte whose bits are inner, knockout, compositeSource, reserved + a 4-bit
 * pass count. `blurX`/`blurY`/`angle`/`distance` are in PIXELS, which is also what
 * AS3's filter objects take, so no unit conversion happens here.
 */
export type SwcFilter =
  | { kind: 'blur'; blurX: number; blurY: number; quality: number }
  | {
    kind: 'dropShadow'; color: number; alpha: number; blurX: number; blurY: number;
    angle: number; distance: number; strength: number; quality: number;
    inner: boolean; knockout: boolean; hideObject: boolean;
  }
  | {
    kind: 'glow'; color: number; alpha: number; blurX: number; blurY: number;
    strength: number; quality: number; inner: boolean; knockout: boolean;
    /** `CompositeSource == 0`: AIR paints the halo without the source (no AS3 field). */
    hideObject: boolean;
  };

/**
 * `PlaceObject3` BlendMode byte -> the AS3 `BlendMode` string (swc.md §9.2 F4).
 *
 * The byte numbering is the SWF spec's own, which Ruffle maps identically
 * (`BlendMode::from_swf_tag`). null = a mode whose compositing Skia cannot express
 * the way AIR does (subtract / invert / alpha / erase) — the caller reports it
 * instead of approximating.
 */
export function swfBlendModeName(v: number): string | null {
  switch (v) {
    case 0: case 1: return 'normal';
    case 2: return 'layer';
    case 3: return 'multiply';
    case 4: return 'screen';
    case 5: return 'lighten';
    case 6: return 'darken';
    case 7: return 'difference';
    case 8: return 'add';
    case 13: return 'overlay';
    case 14: return 'hardlight';
    default: return null;
  }
}

export interface SwcSprite {
  id: number;
  frames: number;
  /** All placements across every frame (a static skin only needs the first). */
  placements: SwcPlacement[];
  /** Index one past each frame's last placement, so frame N spans [frameStarts[N-1], frameStarts[N]). */
  frameStarts: number[];
  /** `FrameLabel`(43) records in tag order: `frame` is 1-based (item ③). */
  labels: SwcFrameLabel[];
}

/** One `FrameLabel`(43): the tag labels the frame that the NEXT `ShowFrame` ends. */
export interface SwcFrameLabel {
  name: string;
  frame: number;
}

export interface SwcButtonRecord {
  /** SWF state bits: 0b0001 up, 0b0010 over, 0b0100 down, 0b1000 hit. */
  states: number;
  charId: number;
  depth: number;
  matrix: number[];
  cxform: number[];
}

export interface SwcButton {
  id: number;
  trackAsMenu: boolean;
  records: SwcButtonRecord[];
}

export type SwcCharacterKind = 'bitmap' | 'shape' | 'sprite' | 'button' | 'text' | 'morph' | 'other';

export interface SwcCharacter {
  id: number;
  kind: SwcCharacterKind;
  /** The SWF tag code that defined it (for diagnostics: the baker can name the
   *  exact kind of an unsupported character instead of saying "other"). */
  tag: number;
}

/**
 * Mixed bit/byte reader over one SWF tag payload.
 *
 * SWF is inconsistent by design (swc.md §3.4④⑤): bit fields (RECT, MATRIX, shape
 * records) are MSB-first, while the byte-aligned style tables are little-endian
 * words. Reading a UI16 from a byte-aligned position must therefore go through
 * `u16()` (LE), never `ub(16)` (MSB-first).
 */
class SwfReader {
  private buf: Buffer;
  private start: number;
  private end: number;
  pos = 0; // bit offset within [start, end)
  constructor(buf: Buffer, start: number, end: number) {
    this.buf = buf;
    this.start = start;
    this.end = end;
  }
  private bit(): number {
    const at = this.start + (this.pos >> 3);
    if (at >= this.end) throw new Error('SWC: SWF bit read past end of tag');
    const v = (this.buf[at] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  ub(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }
  sb(n: number): number {
    const v = this.ub(n);
    const s = 1 << (n - 1);
    return v & s ? v - (1 << n) : v;
  }
  align(): void {
    this.pos = (this.pos + 7) & ~7;
  }
  u8(): number {
    this.align();
    return this.ub(8);
  }
  u16(): number {
    this.align();
    const v = this.buf.readUInt16LE(this.start + (this.pos >> 3));
    this.pos += 16;
    return v;
  }
  i16(): number {
    const v = this.u16();
    return v >= 0x8000 ? v - 0x10000 : v;
  }
  u32(): number {
    const hi = this.u16();
    const lo = this.u16();
    return (hi | (lo << 16)) >>> 0;
  }
  i32(): number {
    const v = this.u32();
    return v >= 0x80000000 ? v - 0x100000000 : v;
  }
  /** SWF FIXED: signed 16.16 fixed point. */
  fixed(): number {
    return this.i32() / 65536;
  }
  /** SWF FIXED8: signed 8.8 fixed point (the filters' `strength`). */
  fixed8(): number {
    return this.i16() / 256;
  }
  /** Peek the byte at a bit offset without consuming anything. */
  byteAt(bitOffset: number): number {
    return this.buf[this.start + (bitOffset >> 3)];
  }
  asciiZ(): string {
    this.align();
    let s = '';
    for (;;) {
      const b = this.buf[this.start + (this.pos >> 3)];
      this.pos += 8;
      if (b === 0) break;
      s += String.fromCharCode(b);
    }
    return s;
  }
  skipBytes(n: number): void {
    this.align();
    this.pos += n * 8;
  }
  remainingBytes(): number {
    return this.end - (this.start + (this.pos >> 3));
  }
}

function readSwfRect(r: SwfReader): SwcRect {
  const n = r.ub(5);
  const rect = { xmin: r.sb(n), xmax: r.sb(n), ymin: r.sb(n), ymax: r.sb(n) };
  // Ruffle reads the rect through a throwaway bit reader, so the partial byte is
  // discarded: byte alignment after a RECT is part of the format, not an accident.
  r.align();
  return rect;
}

/** MATRIX: variable-width scale/rotate fields then a twips translation. */
function readSwfMatrix(r: SwfReader): number[] {
  const m = [1, 0, 0, 1, 0, 0];
  if (r.ub(1)) {
    const n = r.ub(5);
    m[0] = r.sb(n) / 65536;
    m[3] = r.sb(n) / 65536;
  }
  if (r.ub(1)) {
    const n = r.ub(5);
    m[1] = r.sb(n) / 65536;
    m[2] = r.sb(n) / 65536;
  }
  const n = r.ub(5);
  m[4] = r.sb(n);
  m[5] = r.sb(n);
  r.align();
  return m;
}

/** CXFORM / CXFORMWITHALPHA -> [rMul,gMul,bMul,aMul,rAdd,gAdd,bAdd,aAdd]. */
function readSwfCxform(r: SwfReader, hasAlpha: boolean): number[] {
  const c = [1, 1, 1, 1, 0, 0, 0, 0];
  const hasAdd = r.ub(1);
  const hasMul = r.ub(1);
  const n = r.ub(4);
  if (hasMul) {
    c[0] = r.sb(n) / 256;
    c[1] = r.sb(n) / 256;
    c[2] = r.sb(n) / 256;
    if (hasAlpha) c[3] = r.sb(n) / 256;
  }
  if (hasAdd) {
    c[4] = r.sb(n);
    c[5] = r.sb(n);
    c[6] = r.sb(n);
    if (hasAlpha) c[7] = r.sb(n);
  }
  r.align();
  return c;
}

/**
 * Read one FILTER record (PlaceObject3 FILTERLIST).
 *
 * Returns the parsed filter for the three kinds our runtime renders, or null for
 * a kind it cannot (the record is still consumed, and the caller reports the kind
 * so nothing is dropped silently — swc.md §9.2 F4).
 *
 * DropShadow and Glow share a flags layout: bit 7 inner, bit 6 knockout, bit 5
 * compositeSource, bit 4 reserved, bits 3..0 the pass count. `compositeSource == 0`
 * means "hide the source", which is AS3's `hideObject`. The colour record is RGBA
 * and AS3 splits it: `color` is the RGB, `alpha` the A (measured: the skin's glows
 * are 0xFF000000 = opaque black, its drop shadows 0x7F000000 = 50% black).
 */
function readSwfFilter(r: SwfReader): SwcFilter | null {
  const type = r.u8();
  const colour = (): { color: number; alpha: number } => {
    const argb = readSwfColor(r, true);
    return { color: argb & 0xffffff, alpha: ((argb >>> 24) & 0xff) / 255 };
  };
  const flags = (): { inner: boolean; knockout: boolean; hideObject: boolean; quality: number } => {
    const b = r.u8();
    return { inner: (b & 0x80) !== 0, knockout: (b & 0x40) !== 0, hideObject: (b & 0x20) === 0, quality: b & 0x0f };
  };
  switch (type) {
    case 0: { // DropShadow: colour, blurX, blurY, angle, distance, strength, flags
      const { color, alpha } = colour();
      const blurX = r.fixed();
      const blurY = r.fixed();
      const angle = r.fixed();
      const distance = r.fixed();
      const strength = r.fixed8();
      const f = flags();
      return { kind: 'dropShadow', color, alpha, blurX, blurY, angle, distance, strength, quality: f.quality, inner: f.inner, knockout: f.knockout, hideObject: f.hideObject };
    }
    case 1: { // Blur: blurX, blurY, passes (a plain byte, not a flags byte)
      const blurX = r.fixed();
      const blurY = r.fixed();
      const quality = r.u8();
      return { kind: 'blur', blurX, blurY, quality };
    }
    case 2: { // Glow: colour, blurX, blurY, strength, flags
      const { color, alpha } = colour();
      const blurX = r.fixed();
      const blurY = r.fixed();
      const strength = r.fixed8();
      const f = flags();
      return { kind: 'glow', color, alpha, blurX, blurY, strength, quality: f.quality, inner: f.inner, knockout: f.knockout, hideObject: f.hideObject };
    }
    case 3: r.skipBytes(4 + 4 + 16 + 2 + 1); break; // Bevel
    case 4:
    case 7: { // GradientGlow / GradientBevel
      const n = r.u8();
      r.skipBytes(n * 4 + n + 16 + 2 + 1);
      break;
    }
    case 5: { // Convolution
      const cols = r.u8();
      const rows = r.u8();
      r.skipBytes(4 + 4 + 4 * cols * rows + 4 + 1);
      break;
    }
    case 6: r.skipBytes(20 * 4); break; // ColorMatrix
    default: throw new Error(`SWC: unknown SWF filter type ${type}`);
  }
  return null;
}

/**
 * Read a whole FILTERLIST: `count` then `count` FILTER records.
 *
 * A record read without an 8-bit type alignment? No: each FILTER starts with a
 * byte-aligned FilterID, so `readSwfFilter` begins at a byte boundary every time
 * (Ruffle reads the id with `read_u8` too).
 */
function readSwfFilterList(r: SwfReader): { filters: SwcFilter[]; skipped: number[] } {
  const n = r.u8();
  const filters: SwcFilter[] = [];
  const skipped: number[] = [];
  for (let i = 0; i < n; i++) {
    // Every FILTER starts on a byte boundary with its FilterID, so peeking the
    // upcoming byte names the kind even when the record is only skipped.
    const type = r.byteAt(r.pos);
    const f = readSwfFilter(r);
    if (f === null) skipped.push(type); else filters.push(f);
  }
  return { filters, skipped };
}

/**
 * RGB / RGBA record -> 0xAARRGGBB.
 *
 * The SWF stores a colour as the bytes R, G, B[, A] IN THAT ORDER (Ruffle's
 * `read_rgba` confirms it; the spec's "RGBA" record is byte-order R,G,B,A). Note
 * what this does NOT mean: the 4-byte record is NOT 0xAARRGGBB on the wire, so
 * reading it as one 32-bit MSB-first field silently SWAPS the red and alpha bytes
 * (`0x00000002` — the near-transparent black bar of the `upvpage` button — came out
 * as alpha 0, i.e. invisible, while adl fills all 2400 pixels of it). Every
 * consumer downstream (the bake's `as_swc_paint_solid`, gradient stops, strokes)
 * hands the value straight to Skia as ARGB, so the assembly happens here, once.
 */
function readSwfColor(r: SwfReader, hasAlpha: boolean): number {
  const rb = r.u8();
  const gb = r.u8();
  const bb = r.u8();
  const ab = hasAlpha ? r.u8() : 0xff;
  return ((ab << 24) | (rb << 16) | (gb << 8) | bb) >>> 0;
}

function readSwfFillStyle(r: SwfReader, version: number): SwcFillStyle {
  const type = r.u8();
  const hasAlpha = version >= 3;
  const color = (): number => readSwfColor(r, hasAlpha);
  if (type === 0x00) return { type, rgba: color() };
  if (type === 0x10 || type === 0x12 || type === 0x13) {
    const matrix = readSwfMatrix(r);
    // GRADIENT: a flags byte holds spread/interp (hi nibble) + colour count (lo nibble).
    // Drop the hi nibble and a "reflect"/"repeat" gradient silently renders as
    // "pad", and a linearRGB gradient as sRGB.
    const flags = r.u8();
    const n = flags & 0x0f;
    const stops: SwcGradientStop[] = [];
    for (let i = 0; i < n; i++) stops.push({ ratio: r.u8(), rgba: color() });
    const f: SwcFillStyle = {
      type,
      gradKind: type === 0x10 ? 'linear' : type === 0x12 ? 'radial' : 'focal',
      matrix,
      stops,
      spread: (flags >> 6) & 3,
      interp: (flags >> 4) & 3,
    };
    if (type === 0x13) f.focal = r.i16() / 256;
    return f;
  }
  if (type >= 0x40 && type <= 0x43) {
    const bitmapId = r.u16();
    const matrix = readSwfMatrix(r);
    return { type, bitmapId, matrix, repeating: (type & 1) === 0, smoothed: (type & 2) === 0 };
  }
  throw new Error(`SWC: unknown SWF fill style type 0x${type.toString(16)}`);
}

function readSwfLineStyle(r: SwfReader, version: number): SwcLineStyle {
  const width = r.u16();
  if (version < 4) {
    const rgba = readSwfColor(r, version >= 3);
    return { width, rgba };
  }
  // LINESTYLE2 (swc.md §3.4⑤): read the flags MSB-first. JoinStyle lands on bits
  // 13..12; a miter join is 2. Reading them as a little-endian u16 desyncs the
  // whole record (the tell-tale is a miter limit that is not ~4.0).
  const flags = r.ub(16);
  const startCap = (flags >> 14) & 3;
  const join = (flags >> 12) & 3;
  const hasFill = (flags >> 11) & 1;
  const noHScale = (flags >> 10) & 1;
  const noVScale = (flags >> 9) & 1;
  const endCap = flags & 3;
  const line: SwcLineStyle = { width, startCap, join, endCap, noHScale, noVScale };
  if (join === 2) line.miter = r.i16();
  if (hasFill) line.fillStyle = readSwfFillStyle(r, version);
  else line.rgba = readSwfColor(r, version >= 3);
  return line;
}

interface SwfStyleTable {
  fills: SwcFillStyle[];
  lines: SwcLineStyle[];
  numFillBits: number;
  numLineBits: number;
}

function readSwfShapeStyles(r: SwfReader, version: number): SwfStyleTable {
  let nf = r.u8();
  if (nf === 0xff && version >= 2) nf = r.u16();
  const fills: SwcFillStyle[] = [{ type: -1 }]; // 1-based: index 0 is "none"
  for (let i = 0; i < nf; i++) fills.push(readSwfFillStyle(r, version));
  let nl = r.u8();
  if (nl === 0xff && version >= 2) nl = r.u16();
  const lines: SwcLineStyle[] = [{ width: 0 }];
  for (let i = 0; i < nl; i++) lines.push(readSwfLineStyle(r, version));
  const bits = r.u8();
  return { fills, lines, numFillBits: bits >> 4, numLineBits: bits & 0x0f };
}

/** Parse one `DefineShape*` tag into subpaths + style tables (swc.md §3.4④). */
function parseSwfShape(body: Buffer, tag: SwfTag): SwcShape {
  const version = (tag.code === 2 ? 1 : tag.code === 22 ? 2 : tag.code === 32 ? 3 : 4) as 1 | 2 | 3 | 4;
  const r = new SwfReader(body, tag.start, tag.start + tag.length);
  const id = r.u16();
  const bounds = readSwfRect(r);
  let winding: 'evenOdd' | 'nonZero' = 'evenOdd';
  if (version >= 4) {
    readSwfRect(r); // EdgeBounds
    const flags = r.u8(); // bit0 UsesFillWindingRule, bit1/2 scaling strokes
    if ((flags & 1) !== 0) winding = 'nonZero';
  }
  const styles = readSwfShapeStyles(r, version);
  const layers: SwcStyleLayer[] = [{ fills: styles.fills, lines: styles.lines }];
  let numFillBits = styles.numFillBits;
  let numLineBits = styles.numLineBits;

  let layer = 0;
  let fill0 = 0;
  let fill1 = 0;
  let line = 0;
  let x = 0;
  let y = 0;
  const subpaths: SwcSubPath[] = [];
  let cur: SwcSubPath | null = null;
  const open = (): SwcSubPath => {
    const s: SwcSubPath = { layer, fill0, fill1, line, start: { x, y }, moveToFirst: false, pts: [] };
    subpaths.push(s);
    return s;
  };

  for (;;) {
    const isEdge = r.ub(1);
    if (isEdge) {
      const straight = r.ub(1);
      const n = r.ub(4) + 2;
      if (!cur) cur = open();
      if (straight) {
        // Straight edges have an axis-aligned optimisation: when aligned, one of
        // the two deltas is omitted entirely. Missing this bit desyncs the stream.
        const axisAligned = !r.ub(1);
        const vertical = axisAligned ? r.ub(1) === 1 : false;
        const dx = !axisAligned || !vertical ? r.sb(n) : 0;
        const dy = !axisAligned || vertical ? r.sb(n) : 0;
        x += dx;
        y += dy;
        cur.pts.push({ x, y });
      } else {
        const cdx = r.sb(n);
        const cdy = r.sb(n);
        const adx = r.sb(n);
        const ady = r.sb(n);
        const cx = x + cdx;
        const cy = y + cdy;
        x += cdx + adx;
        y += cdy + ady;
        cur.pts.push({ x, y, cx, cy });
      }
      continue;
    }
    const flags = r.ub(5);
    if (flags === 0) break; // EndShapeRecord
    const newStyles = (flags >> 4) & 1;
    const stateLine = (flags >> 3) & 1;
    const stateFill1 = (flags >> 2) & 1;
    const stateFill0 = (flags >> 1) & 1;
    const moveTo = flags & 1;
    let moved = false;
    if (moveTo) {
      // The MoveTo bits are an ABSOLUTE twips coordinate, not a delta from the pen,
      // even though the record is written as two signed fields. Ruffle's reader
      // resolves them the same way (`self.cursor = *move_to` in
      // ShapeConverter::into_commands, with `move_to: Point<Twips>` built straight
      // from the two signed reads). Accumulating them instead shifts every contour
      // after the first by the pen position: skin.swc shape #23's ring (a 3-layer
      // shape) landed a full diameter to the right, and shape #319's hole/keyhole
      // contours landed outside the shape bounds. Verified pixel-for-pixel against
      // adl (temp/swc-render, shapes #23/#319).
      const nb = r.ub(5);
      x = r.sb(nb);
      y = r.sb(nb);
      moved = true;
    }
    if (stateFill0) fill0 = r.ub(numFillBits);
    if (stateFill1) fill1 = r.ub(numFillBits);
    if (stateLine) line = r.ub(numLineBits);
    if (newStyles) {
      r.align();
      const ns = readSwfShapeStyles(r, version);
      // Replace, never append (Ruffle's converter rebinds the style list here):
      // the new table takes over for every later record, style ids restart at 1,
      // and the previous layer's geometry is painted first. Appending instead
      // shifts every later style reference by the previous table's size and
      // silently paints with the wrong paint.
      layers.push({ fills: ns.fills, lines: ns.lines });
      layer = layers.length - 1;
      fill0 = 0;
      fill1 = 0;
      line = 0;
      numFillBits = ns.numFillBits;
      numLineBits = ns.numLineBits;
    }
    // A style change always starts a new run at the current pen. `moved` marks the
    // moveTo point as real geometry: a run that merely continues must not invent a
    // subpath start that was never drawn.
    cur = open();
    cur.moveToFirst = moved;
    if (moved) cur.pts.push({ x, y });
  }

  // Self-verification (swc.md §3.4⑤): a correct parse lands exactly on the tag end
  // (modulo <1 byte of bit padding). A desync "runs" but leaves bytes behind.
  const leftover = tag.length * 8 - r.pos;
  if (leftover < 0 || leftover > 7) {
    throw new Error(`SWC: DefineShape #${id} did not consume its tag (leftover ${leftover} bits)`);
  }
  // Second self-check: every style reference must land inside its OWN layer's
  // table. This is what proves the replace (rather than append) reading — under
  // the wrong one, post-NewStyles ids index past their table instead of inside it.
  for (const sp of subpaths) {
    const lay = layers[sp.layer];
    if (sp.fill0 > lay.fills.length - 1 || sp.fill1 > lay.fills.length - 1 || sp.line > lay.lines.length - 1) {
      throw new Error(
        `SWC: DefineShape #${id} style reference out of range (layer ${sp.layer}: ` +
          `fill0=${sp.fill0} fill1=${sp.fill1} line=${sp.line}, table has ` +
          `${lay.fills.length - 1} fills / ${lay.lines.length - 1} lines)`
      );
    }
  }
  return { id, version, bounds, winding, layers, subpaths };
}

/** Parse one `PlaceObject*` record. */
function readSwfPlacement(r: SwfReader, version: number): SwcPlacement {
  if (version === 1) {
    const charId = r.u16();
    const depth = r.u16();
    const matrix = readSwfMatrix(r);
    // PlaceObject(1) has no flag byte, so the optional CXFORM is "whatever is left".
    const cxform = r.remainingBytes() > 0 ? readSwfCxform(r, false) : null;
    // PlaceObject(1) has no flag byte: no clip depth, no visibility, no filters,
    // no blend mode and no bitmap cache.
    return {
      depth, charId, move: false, name: null, matrix, cxform, clipDepth: null, hidden: false,
      visibleFlag: null, ratio: null, filters: [], skippedFilters: [], blendMode: null, bitmapCached: false,
    };
  }
  const flags = version >= 3 ? r.u16() : r.u8();
  const depth = r.u16();
  const hasClipActions = (flags & 0x80) !== 0;
  const hasClipDepth = (flags & 0x40) !== 0;
  const hasName = (flags & 0x20) !== 0;
  const hasRatio = (flags & 0x10) !== 0;
  const hasCxform = (flags & 0x08) !== 0;
  const hasMatrix = (flags & 0x04) !== 0;
  const hasChar = (flags & 0x02) !== 0;
  const move = (flags & 0x01) !== 0;
  const hasFilter = version >= 3 && (flags & 0x0100) !== 0;
  const hasBlend = version >= 3 && (flags & 0x0200) !== 0;
  const hasCache = version >= 3 && (flags & 0x0400) !== 0;
  const hasClassName = version >= 3 && (flags & 0x0800) !== 0;
  const hasImage = version >= 3 && (flags & 0x1000) !== 0;
  const hasVisible = version >= 3 && (flags & 0x2000) !== 0;
  const opaqueBg = version >= 3 && (flags & 0x4000) !== 0;
  let name: string | null = null;
  if (hasClassName || (hasImage && !hasChar)) name = r.asciiZ();
  // PlaceObject Ratio: the morph ratio of the DefineMorphShape sitting at this
  // depth. Only morph timelines carry it (skin.swc: `#215`/`#388`/`#476` animate
  // nothing else for up to 100 frames). Morph shapes are baked as empty
  // placeholders, so the ratio cannot be applied -- but it is a real record the
  // timeline uses, so it is reported (swc.md §10), never swallowed.
  let ratio: number | null = null;
  const charId = hasChar ? r.u16() : null;
  const matrix = hasMatrix ? readSwfMatrix(r) : null;
  const cxform = hasCxform ? readSwfCxform(r, true) : null;
  if (hasRatio) ratio = r.u16();
  if (hasName) name = r.asciiZ();
  // HasClipDepth marks this record as a mask (see SwcPlacement.clipDepth). The
  // field comes LAST in the record, so it must be read where the spec puts it.
  const clipDepth = hasClipDepth ? r.u16() : null;
  const { filters, skipped } = hasFilter ? readSwfFilterList(r) : { filters: [], skipped: [] };
  const blendMode = hasBlend ? r.u8() : null;
  const bitmapCached = hasCache && r.remainingBytes() > 0 ? r.u8() !== 0 : false;
  // Visible is a byte (0 = hidden), not a bit -- the field order is the SWF
  // spec's, and Ruffle reads it the same way (swc.md §9.2 F3). It is kept as a
  // tri-state because a Modify record with Visible = 1 must UN-hide the object
  // at that depth, while a Modify record with no Visible field must leave the
  // object's visibility exactly as it was.
  const visibleFlag = hasVisible ? r.u8() !== 0 : null;
  const hidden = visibleFlag === false;
  if (opaqueBg) r.skipBytes(4);
  if (hasClipActions) r.skipBytes(r.remainingBytes());
  return { depth, charId, move, name, matrix, cxform, clipDepth, hidden, visibleFlag, ratio, filters, skippedFilters: skipped, blendMode, bitmapCached };
}

/** A null-terminated UTF-8 string between `start` and `end` (SWF string fields). */
function readSwfCString(body: Buffer, start: number, end: number): string {
  let p = start;
  while (p < end && body[p] !== 0) p++;
  return body.toString('utf8', start, p);
}

function parseSwfSprite(body: Buffer, tag: SwfTag): SwcSprite {
  const id = body.readUInt16LE(tag.start);
  const frames = body.readUInt16LE(tag.start + 2);
  const tags = scanTags(body, tag.start + 4, tag.start + tag.length);
  const placements: SwcPlacement[] = [];
  const frameStarts: number[] = [];
  const labels: SwcFrameLabel[] = [];
  for (const t of tags) {
    // ShowFrame(1) is a length-0 control tag; the sprite body ends with End(0),
    // which must not be mistaken for a placement either.
    if (t.code === 1) {
      frameStarts.push(placements.length);
      continue;
    }
    if (t.code === 43 /* FrameLabel */) {
      // A null-terminated string naming the frame that this tag is in, i.e. the
      // frame the *next* ShowFrame closes (Flash writes the label before that
      // ShowFrame). `frameStarts.length` is the number of frames already closed,
      // so the label belongs to `frameStarts.length + 1` -- clamping to the
      // declared frame count guards damaged files (and the trailing anchor byte
      // SWF<=5 allowed, which AVM2 files never write).
      const name = readSwfCString(body, t.start, t.start + t.length);
      if (name.length > 0) labels.push({ name, frame: Math.min(frameStarts.length + 1, frames) });
      continue;
    }
    if (t.length === 0) continue;
    if (t.code === 5 || t.code === 28) {
      // RemoveObject(5) = CharId + Depth, RemoveObject2(28) = Depth only. Both
      // remove whatever sits at that depth, which is exactly the bake's Delete
      // record. They were silently SKIPPED until item ③, which made a symbol whose
      // frame 2 is "remove depth 2, place at depth 3" look like a pure add: adl
      // reports 3 children for `toastbtn` frame 2 while we reported 4 (measured,
      // temp/tlprobe), and every later-frame delta was wrong in the same way.
      const depth = t.code === 5 ? body.readUInt16LE(t.start + 2) : body.readUInt16LE(t.start);
      placements.push({
        depth, charId: null, move: false, name: null, matrix: null, cxform: null, clipDepth: null,
        hidden: false, visibleFlag: null, ratio: null, filters: [], skippedFilters: [],
        blendMode: null, bitmapCached: false,
      });
      continue;
    }
    if (t.code === 4 || t.code === 26 || t.code === 70) {
      const version = t.code === 4 ? 1 : t.code === 26 ? 2 : 3;
      placements.push(readSwfPlacement(new SwfReader(body, t.start, t.start + t.length), version));
    }
  }
  return { id, frames, placements, frameStarts, labels };
}

function parseSwfButton(body: Buffer, tag: SwfTag): SwcButton {
  const id = body.readUInt16LE(tag.start);
  if (tag.code === 7) {
    // DefineButton(7): id, then records until a zero state byte, then actions.
    const r = new SwfReader(body, tag.start + 2, tag.start + tag.length);
    const records: SwcButtonRecord[] = [];
    for (;;) {
      const flags = r.u8();
      if (flags === 0) break;
      const charId = r.u16();
      const depth = r.u16();
      const matrix = readSwfMatrix(r);
      records.push({ states: flags & 0x0f, charId, depth, matrix, cxform: [1, 1, 1, 1, 0, 0, 0, 0] });
    }
    return { id, trackAsMenu: false, records };
  }
  // DefineButton2(34): id, flags, actionOffset, records..., actions...
  const flags = body[tag.start + 2];
  const actionOffset = body.readUInt16LE(tag.start + 3);
  const r = new SwfReader(body, tag.start + 5, tag.start + tag.length);
  const records: SwcButtonRecord[] = [];
  for (;;) {
    const f = r.u8();
    if (f === 0) break;
    const charId = r.u16();
    const depth = r.u16();
    const matrix = readSwfMatrix(r);
    const cxform = readSwfCxform(r, true);
    records.push({ states: f & 0x0f, charId, depth, matrix, cxform });
  }
  return { id, trackAsMenu: (flags & 1) !== 0, records };
}

// ---------------------------------------------------------------------------
// Bake plan (阶段九十五 E-3)
//
// Everything the emitter needs to write the baked C, distilled into pure data:
// NO C strings here (AGENTS.md §2.8 — `swc.ts` only produces bytes and IR, the
// semantic layer is the sole place that touches C text). Coordinates are already
// in PIXELS: SWF stores twips and our display list is in pixels, so the whole
// plan divides by 20 exactly once, here, rather than sprinkling /20 over the
// emitter and the runtime.
// ---------------------------------------------------------------------------

/** Twips per pixel — SWF's fixed unit (swc.md §3.4). */
const TWIPS = 20;

/** A subpath in pixels, ready to be replayed into a Graphics. */
export interface SwcBakePath {
  start: SwcEdge; // already divided by 20
  pts: SwcEdge[]; // edges only (the moveTo point is `start`, not repeated)
  closed: boolean; // Ruffle's PathSegment::is_closed: start == last point
}

/**
 * One draw group: the subpaths that share a single paint. AIR paints each group
 * independently, so this is the unit the emitter feeds to `beginFill`/`lineStyle`.
 */
export interface SwcBakeGroup {
  fill: SwcFillStyle | null;
  line: SwcLineStyle | null;
  paths: SwcBakePath[];
}

export interface SwcBakeShape {
  id: number;
  /** ShapeBounds in pixels, relative to the shape's own origin. */
  bounds: { x: number; y: number; w: number; h: number };
  evenOdd: boolean;
  groups: SwcBakeGroup[];
}

export interface SwcBakePlacement {
  /**
   * The Flash DEPTH this child sits at. The emitter stores it on the child
   * (`DisplayObject._tl_depth`) so a later frame's timeline op can address the
   * object AIR addresses even if user code adds children of its own to the clip.
   */
  depth?: number;
  /** `PlaceObject3` FILTERLIST, in AS3 filter-object terms (swc.md §9.2 F4). */
  filters?: SwcFilter[];
  /** AS3 `BlendMode` string for a `PlaceObject3` BlendMode byte. */
  blendMode?: string;
  /** `PlaceObject3` BitmapCached -> `DisplayObject.cacheAsBitmap`. */
  bitmapCached?: boolean;
  charId: number;
  /** [a, b, c, d, tx, ty]: the SWF matrix with the 16.16 scale fields already
   *  normalized to real factors (1.0 = unscaled) and the twips translation
   *  divided by 20. Nothing downstream divides again. */
  matrix: number[] | null;
  cxform: number[] | null;
  /**
   * The clipDepth mask that clips this child, already composed into the CHILD's
   * own pixel space: `mask.matrix` maps the mask SHAPE's local pixels onto this
   * child's local pixels (bake-time `inverse(childMatrix) * maskMatrix`), so the
   * renderer only has to build the mask shape's path and clip with it.
   *
   * The mask character itself is never painted (AIR hides the mask object) and
   * therefore never appears in `children`. Absent/null = the child is not masked.
   */
  mask?: { charId: number; matrix: number[] } | null;
  /**
   * The placement carries `PlaceObject3` `Visible = 0`, so AIR creates the object
   * but leaves it hidden. Measured on `adl 51.4.1` (`temp/vishidden/`):
   * `vbitemskin` has **6** children, one with `visible == false` — the child is
   * NOT omitted from the display list, so the emitter sets `visible = false`
   * instead of skipping it (swc.md §9.2 F3).
   */
  hidden?: boolean;
}

export interface SwcBakeButton {
  up: SwcBakePlacement[];
  over: SwcBakePlacement[];
  down: SwcBakePlacement[];
  hit: SwcBakePlacement[];
}

/**
 * A baked text character: AIR instantiates these as real `TextField`s, so we bake
 * an EMPTY `TextField` at the character's own RECT (item ②). The RECT origin is
 * applied by the placement (`x = matrix.tx + xmin`, measured in temp/childfx), and
 * the box size becomes the field size.
 */
/** AutoSize lookup for the report/emitter: only DefineEditText can carry it. */
function textAuto(id: number): boolean {
  return TEXT_AUTOSIZE.get(id) === true;
}
const TEXT_AUTOSIZE = new Map<number, boolean>();

export interface SwcBakeText {
  /** RECT origin in the character's own px (added to the placement translation). */
  ox: number;
  oy: number;
  w: number;
  h: number;
}

export interface SwcBakeCharacter {
  id: number;
  kind: 'shape' | 'sprite' | 'button' | 'bitmap' | 'text' | 'morph';
  /** Text characters only: the RECT that becomes the placeholder TextField's box. */
  text?: SwcBakeText;
  shape?: SwcBakeShape;
  /** Sprite: the frame-1 display list, ordered by depth (Flash paints by depth). */
  children?: SwcBakePlacement[];
  /**
   * Sprite: the timeline length in frames (>= 1). AIR reports this as
   * `MovieClip.totalFrames` and `adl 51.4.1` matches the SWF's `ShowFrame` count
   * (measured: `desktopshareitem` 21, `devicesitemskin` 23, `checkbom` 2).
   */
  totalFrames?: number;
  /**
   * Sprite: the frames after frame 1 that actually carry records, as depth-keyed
   * ops. Flash timelines are CUMULATIVE (frame n = frame 1 + every op up to n),
   * so the emitter applies frames 2..n in order (swc.md §9.2 F6).
   */
  frames?: SwcBakeFrame[];
  /** Sprite: `FrameLabel` records; AIR exposes them as `currentLabels`. */
  labels?: SwcFrameLabel[];
  button?: SwcBakeButton;
  bitmapId?: number;
  /**
   * `DefineScalingGrid` (tag 78): the 9-slice splitter in the character's OWN
   * local pixels. Present only on characters the author gave a scaling grid, so
   * the emitter can tell "no grid" (undefined) from an all-zero grid.
   */
  scalingGrid?: SwcBakeGrid;
}

/** A 9-slice splitter: the inner rectangle that scales (swc.md §9 F). */
export interface SwcBakeGrid {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One timeline op of a frame after frame 1 (item ③, swc.md §9.2 F6). Ops are
 * keyed by the Flash DEPTH, not by a child index: AIR's timeline manages the
 * objects it placed by depth, so user code that adds its own children to a
 * baked movieclip must not shift which object a later frame addresses.
 */
export interface SwcBakeFrameOp {
  /** The depth the op addresses (display-list order is depth order). */
  depth: number;
  /** Present when the record places a character: an add (new depth) or a replace. */
  charId?: number;
  /** True when a timeline child already occupies this depth (replace, not add). */
  replace?: boolean;
  /**
   * The character currently sitting at this depth when a MODIFY record addresses
   * it. The emitter needs it because a TextField child reads `x = matrix.tx +
   * RECT.xmin` (item ②), so a modify that moves a text child must add that origin.
   */
  modCharId?: number;
  /** Absent = the record carries no matrix, so the object keeps the one it has. */
  matrix?: number[] | null;
  cxform?: { mul: number[]; add: number[] } | null;
  /** The record says Visible = 0: hide the object at this depth. */
  hidden?: boolean;
  /** The record says Visible = 1: show the object at this depth again. */
  visible?: boolean;
  filters?: SwcFilter[];
  blendMode?: string;
  bitmapCached?: boolean;
  /** Delete record: remove the timeline child at this depth. */
  del?: boolean;
}

/** The ops of one later frame; frames with no records never appear. */
export interface SwcBakeFrame {
  /** 1-based frame number, always >= 2. */
  frame: number;
  ops: SwcBakeFrameOp[];
}

/** One bitmap the baked C must be able to hand to Skia as an SkImage. */
export interface SwcBakeBitmap {
  id: number;
  /** C array symbol holding `encoded`; shared with the named resources when
   *  the bitmap is also an exported class, so its bytes are embedded once. */
  bytesSymbol: string;
  /** True when this entry needs its own array emitted (see `emitSwcBake`). */
  ownBytes: boolean;
  width: number;
  height: number;
  format: 'png' | 'jpeg' | 'gif';
  encoded: Buffer;
}

export interface SwcBake {
  /** Every character reachable from an export, id-ordered. */
  characters: SwcBakeCharacter[];
  /** Every bitmap the closure uses, id-ordered. */
  bitmaps: SwcBakeBitmap[];
  /** charId -> AS3 class name for the exported characters (a class is synthesized for each). */
  classOf: Map<number, string>;
  /** Exported classes whose ctor must attach a baked tree (cname -> charId). */
  chars: readonly SwcCharacterClass[];
  /**
   * Characters the closure needs but the baker cannot build: DefineText /
   * DefineEditText / fonts / morph shapes. They stay in the graph (their
   * placements still instantiate nothing) and are reported loudly, because the
   * affected symbols would otherwise silently lose that part of their artwork
   * (swc.md §3.3 — text rendering is out of scope for the resource baker).
   */
  unsupported: readonly SwcBakeUnsupported[];
  /**
   * Fidelity gaps in the baked display trees that are NOT about a character: a
   * `PlaceObject3` attribute the baker cannot express (filter kinds we do not
   * render, blend modes with no Skia equivalent). Ready-to-print sentences; the
   * CLI prints them loudly. Always present, empty when there is nothing to say.
   */
  notes: readonly string[];
}

/** One needed character kind the baker passes over, with how many placements use it. */
export interface SwcBakeUnsupported {
  id: number;
  kind: string;
  /** How many placement/button records point at it, across the whole closure. */
  uses: number;
}

/**
 * Turn parsed characters into the emitter's bake plan (swc.md §9 E-3).
 *
 * Only the closure of the exported characters is baked: the library holds 1153
 * characters, but a skin's AS3 can only reach the ones `SymbolClass` names, and
 * every member of that closure is needed to build them. Baking all 1153 would
 * bloat the generated C with geometry nothing can address.
 */
export function swcBakePlan(lib: SwcLibrary, specs: readonly SwcResourceSpec[], classChars: readonly SwcCharacterClass[] = []): SwcBake {
  const shapeById = new Map(lib.shapes.map((s) => [s.id, s]));
  const spriteById = new Map(lib.sprites.map((s) => [s.id, s]));
  const textById = new Map(lib.texts.map((t) => [t.id, t]));
  const buttonById = new Map(lib.buttons.map((b) => [b.id, b]));
  const bitmapById = new Map(lib.bitmaps.map((b) => [b.tagId, b]));
  const resSymbol = new Map(specs.map((s) => [s.className, s.bytesSymbol]));

  // Closure walk over the reference graph (placements -> characters, fills ->
  // bitmaps). A missing character is a broken library, not something to skip.
  const wantChars = new Set<number>();
  const wantBitmaps = new Set<number>();
  // How many references point at each character, so the unsupported report can say
  // how much artwork is affected instead of just naming the tag.
  const uses = new Map<number, number>();
  const unsupportedIds = new Map<number, string>();
  const queue: number[] = [];
  const visit = (id: number): void => {
    uses.set(id, (uses.get(id) ?? 0) + 1);
    if (wantChars.has(id)) return;
    wantChars.add(id);
    queue.push(id);
  };
  for (const id of lib.classNames.keys()) visit(id);
  const placementsOf = (sp: SwcSprite): SwcPlacement[] => sp.placements;
  while (queue.length > 0) {
    const id = queue.shift() as number;
    const ch = lib.characters.get(id);
    if (ch === undefined) throw new Error(`SWC: exported character #${id} has no definition`);
    const shape = shapeById.get(id);
    if (shape) {
      // Only fills some geometry actually references pull a bitmap into the
      // closure. SWF style tables legitimately carry unused entries, and skins
      // written by Flash carry a placeholder `0x41` entry with BitmapId 0xFFFF and
      // an identity matrix that NO shape record points at (38 of them in the test
      // skin): treating those as real references would abort on a bitmap that is
      // never painted. A *referenced* fill with an unknown bitmap still fails.
      const usedByLayer = new Map<number, Set<number>>();
      for (const sp of shape.subpaths) {
        let u = usedByLayer.get(sp.layer);
        if (u === undefined) { u = new Set<number>(); usedByLayer.set(sp.layer, u); }
        if (sp.fill0 > 0) u.add(sp.fill0);
        if (sp.fill1 > 0) u.add(sp.fill1);
      }
      shape.layers.forEach((l, li) => {
        for (const fi of usedByLayer.get(li) ?? []) {
          const f = l.fills[fi];
          if (f !== undefined && f.type >= 0x40 && f.bitmapId !== undefined) wantBitmaps.add(f.bitmapId);
        }
      });
      continue;
    }
    const sprite = spriteById.get(id);
    if (sprite) {
      for (const p of placementsOf(sprite)) if (p.charId !== null) visit(p.charId);
      continue;
    }
    const button = buttonById.get(id);
    if (button) {
      for (const r of button.records) visit(r.charId);
      continue;
    }
    if (ch.kind === 'bitmap') {
      wantBitmaps.add(id);
      continue;
    }
    if (ch.kind === 'morph') {
      // Built as an empty Shape placeholder so the display list keeps AIR's child
      // count and index order. The geometry is not decoded — announced below.
      continue;
    }
    if (ch.kind === 'text') {
      // Text characters ARE built, as empty TextField placeholders (item ②): AIR
      // reports them as children with a real box, and a missing child shifts every
      // later index (`minfo` ours 2 vs adl 6). Their glyphs/initial text stay a
      // documented gap, announced through `notes` below -- never silently dropped.
      continue;
    }
    if (ch.kind === 'other') {
      // Font/morph characters are a documented, deliberately unrendered class
      // (swc.md §3.3): they are reported rather than built. `as_swc_new` returns
      // NULL for them and the placement code skips a NULL child, so the rest of
      // the symbol still renders.
      unsupportedIds.set(id, UNSUPPORTED_TAG_NAMES[ch.tag] ?? `tag#${ch.tag}`);
      continue;
    }
  }
  // Bitmap fills can reference a bitmap that is not itself an exported class, so
  // every wanted bitmap must exist.
  for (const id of wantBitmaps) {
    if (!bitmapById.has(id)) throw new Error(`SWC: bitmap fill references missing bitmap #${id}`);
  }

  const px = (v: number): number => v / TWIPS;
  const pxEdge = (e: SwcEdge): SwcEdge => (e.cx === undefined
    ? { x: px(e.x), y: px(e.y) }
    : { x: px(e.x), y: px(e.y), cx: px(e.cx), cy: px(e.cy as number) });
  const pxMatrix = (m: number[] | null): number[] | null => (m === null ? null : [m[0], m[1], m[2], m[3], px(m[4]), px(m[5])]);

  /** 2x2 inverse of an affine [a, b, c, d, tx, ty] (AS3 convention: x' = a*x + c*y + tx).
   *  null when the matrix is singular (a zero-scale placement paints nothing). */
  const invMatrix = (m: number[]): number[] | null => {
    const det = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(det) < 1e-12) return null;
    const a = m[3] / det;
    const b = -m[1] / det;
    const c = -m[2] / det;
    const d = m[0] / det;
    return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
  };

  /** Compose two affine matrices: `x` applied first, then `y` (y * x). */
  const mulMatrix = (y: number[], x: number[]): number[] => [
    y[0] * x[0] + y[2] * x[1],
    y[1] * x[0] + y[3] * x[1],
    y[0] * x[2] + y[2] * x[3],
    y[1] * x[2] + y[3] * x[3],
    y[0] * x[4] + y[2] * x[5] + y[4],
    y[1] * x[4] + y[3] * x[5] + y[5],
  ];

  /** Group a parsed shape by style, in AIR's paint order (swc.md §9 E): per layer,
   *  fills in style-id order first, then strokes in style-id order (Ruffle's
   *  ShapeConverter::flush_layer). */
  const bakeShape = (s: SwcShape): SwcBakeShape => {
    const groups: SwcBakeGroup[] = [];
    // One pass in RECORD order to freeze each run's start/closed flag: regrouping
    // by style must not depend on the pen state at emission time.
    const runs = s.subpaths.map((sp) => {
      const start = pxEdge(sp.start);
      const pts = sp.moveToFirst ? sp.pts.slice(1) : sp.pts;
      const last = pts.length > 0 ? pts[pts.length - 1] : start;
      const closed = pts.length > 0 && last.x === start.x && last.y === start.y;
      return { sp, path: { start, pts: pts.map(pxEdge), closed } as SwcBakePath };
    });
    s.layers.forEach((layer, li) => {
      for (let fi = 1; fi < layer.fills.length; fi++) {
        const paths = runs.filter((r) => r.sp.layer === li && (r.sp.fill0 === fi || r.sp.fill1 === fi)).map((r) => r.path);
        if (paths.length > 0) groups.push({ fill: layer.fills[fi], line: null, paths });
      }
      for (let li2 = 1; li2 < layer.lines.length; li2++) {
        const paths = runs.filter((r) => r.sp.layer === li && r.sp.line === li2).map((r) => r.path);
        if (paths.length > 0) groups.push({ fill: null, line: layer.lines[li2], paths });
      }
    });
    return {
      id: s.id,
      bounds: { x: px(s.bounds.xmin), y: px(s.bounds.ymin), w: px(s.bounds.xmax - s.bounds.xmin), h: px(s.bounds.ymax - s.bounds.ymin) },
      evenOdd: s.winding === 'evenOdd',
      groups,
    };
  };

  /** A sprite's frame-1 display list: process the records before the first
   *  ShowFrame in order, letting a later Modify (no character) override the
   *  placement at the same depth, then sort by depth (Flash paints depth order).
   *
   *  A `clipDepth` record is a MASK: AIR does not paint it, and it clips the
   *  siblings inside its depth range. The mask is therefore kept out of the
   *  children list and attached to each child it covers instead, with its matrix
   *  already composed into that child's local space. */
  /** Mask shapes we cannot express as a path clip: charId -> its kind. */
  const maskNotes = new Map<number, string>();
  const spriteChildren = (sp: SwcSprite): SwcBakePlacement[] => {
    const firstFrameEnd = sp.frameStarts.length > 0 ? sp.frameStarts[0] : sp.placements.length;
    const byDepth = new Map<number, SwcBakePlacement>();
    /** depth -> the mask record sitting at that depth (charId + matrix in px). */
    const masks = new Map<number, { charId: number; clipDepth: number; matrix: number[] | null }>();
    for (let i = 0; i < firstFrameEnd; i++) {
      const p = sp.placements[i];
      if (p.charId === null) {
        // A pure Modify: fields the record does not carry stay as they were, so a
        // hidden move hides the object that is already at that depth (and a move
        // without the Visible field must not un-hide it). Same rule for the
        // PlaceObject3 attributes.
        const prev = byDepth.get(p.depth);
        if (prev && p.matrix !== null) prev.matrix = pxMatrix(p.matrix);
        if (prev && p.cxform !== null) prev.cxform = p.cxform;
        if (prev && p.hidden) prev.hidden = true;
        if (prev && p.filters.length > 0) prev.filters = p.filters;
        if (prev && p.blendMode !== null) prev.blendMode = swfBlendModeName(p.blendMode) ?? undefined;
        if (prev && p.bitmapCached) prev.bitmapCached = true;
        continue;
      }
      if (p.clipDepth !== null) {
        masks.set(p.depth, { charId: p.charId, clipDepth: p.clipDepth, matrix: pxMatrix(p.matrix) });
        // The mask record is ALSO a child: AIR keeps the mask object in the display
        // list with `visible == true` and its own bounds, it simply does not paint
        // it (measured, temp/childfx: loginskin has 9 children in AIR / 8 without
        // the depth-2 shape mask, small_gift 5/4, skin_fla.元件27_310 5/3, and the
        // MorphShape mask of fileitemskin c2 is an ordinary child). Keeping it here
        // preserves AIR's child count and index order; `maskSource` makes the
        // emitter mark the object non-painting so no pixel moves.
      }
      byDepth.set(p.depth, {
        charId: p.charId, matrix: pxMatrix(p.matrix), cxform: p.cxform, hidden: p.hidden,
        filters: p.filters.length > 0 ? p.filters : undefined,
        blendMode: p.blendMode === null ? undefined : (swfBlendModeName(p.blendMode) ?? undefined),
        bitmapCached: p.bitmapCached || undefined,
        maskSource: p.clipDepth !== null || undefined,
      });
    }
    const out: SwcBakePlacement[] = [];
    for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
      const child = byDepth.get(depth) as SwcBakePlacement;
      child.depth = depth;
      // The innermost (last-written) mask covering this depth wins, matching the
      // "a later record overrides" rule the rest of the frame follows.
      let mask: { charId: number; matrix: number[] | null } | null = null;
      for (const [md, m] of masks) if (md < depth && depth <= m.clipDepth) mask = m;
      if (mask !== null) {
        if (shapeById.has(mask.charId)) {
          // Compose MASK -> CHILD: the child is rendered with its own matrix, so the
          // clip path must be expressed in the child's local pixels. A singular
          // child matrix (scale 0) paints nothing at all, so skipping the clip
          // there cannot change any pixel.
          const inv = child.matrix === null ? [1, 0, 0, 1, 0, 0] : invMatrix(child.matrix);
          const composed = inv === null
            ? null
            : mulMatrix(inv, mask.matrix === null ? [1, 0, 0, 1, 0, 0] : mask.matrix);
          if (composed !== null) child.mask = { charId: mask.charId, matrix: composed };
        } else if (!maskNotes.has(mask.charId)) {
          // A mask that is a sprite or a morph shape cannot be turned into a path
          // clip here (AIR uses the mask's rendered alpha, which our path clip
          // cannot express). Report it loudly — but as a NOTE, not by marking the
          // character unsupported: the mask object is still a child (see above), and
          // marking it unsupported would drop the character entirely, including from
          // every other place the same character is used as an ordinary child.
          maskNotes.set(mask.charId, lib.characters.get(mask.charId)?.kind ?? '?');
        }
      }
      out.push(child);
    }
    return out;
  };

  /**
   * The ops of every frame after frame 1 (item ③). Flash timelines are CUMULATIVE:
   * frame n shows frame 1's objects plus every add/replace/modify/remove up to n,
   * so the ops are a walk over the records *in frame order* against a depth->object
   * state seeded from frame 1. Two record shapes are worth naming:
   *
   *  - `Move` (0x01) with no character = modify: only the fields the record
   *    carries are applied (an omitted matrix must NOT reset the transform, and an
   *    omitted Visible must NOT re-show a hidden object).
   *  - a record with a character at a depth that already has one = a REPLACE: AIR
   *    throws the old object away and instantiates the new character, keeping the
   *    previous transform/cxform when the record omits them (measured on `checkbom`
   *    frame 2: depth 2 gets character #152 with no matrix and AIR keeps x/y == 0).
   *    This is how a timeline swaps artwork between frames.
   *
   * A record with neither `Move` nor a character is a REMOVE.
   */
  const frameNotes: string[] = [];
  let ratioOps = 0;
  const spriteFrames = (sp: SwcSprite): SwcBakeFrame[] => {
    const firstFrameEnd = sp.frameStarts.length > 0 ? sp.frameStarts[0] : sp.placements.length;
    /** depth -> the character placed there and the transform it currently has. */
    const state = new Map<number, { charId: number; matrix: number[] | null }>();
    for (let i = 0; i < firstFrameEnd; i++) {
      const p = sp.placements[i];
      if (p.charId === null) {
        if (!p.move) state.delete(p.depth);
        continue;
      }
      const prev = state.get(p.depth);
      state.set(p.depth, { charId: p.charId, matrix: p.matrix !== null ? pxMatrix(p.matrix) : (prev?.matrix ?? null) });
    }
    const frames: SwcBakeFrame[] = [];
    for (let f = 2; f <= sp.frames; f++) {
      const start = sp.frameStarts[f - 2] ?? 0;
      const end = sp.frameStarts[f - 1] ?? sp.placements.length;
      if (end <= start) continue;
      /** One op per depth per frame: a later record at the same depth wins. */
      const byDepth = new Map<number, SwcBakeFrameOp>();
      for (let i = start; i < end; i++) {
        const p = sp.placements[i];
        if (p.clipDepth !== null) {
          frameNotes.push(
            `sprite #${sp.id} frame ${f}: a clipDepth mask record appears after frame 1; only frame-1 masks are ` +
            `baked, so the depth-${p.depth} mask object is not applied to its sibling range (swc.md §10)`
          );
          continue;
        }
        if (p.charId === null) {
          if (!p.move) {
            // Remove: the depth goes empty from this frame on.
            state.delete(p.depth);
            byDepth.set(p.depth, { depth: p.depth, del: true });
            continue;
          }
          const op = byDepth.get(p.depth) ?? { depth: p.depth, modCharId: state.get(p.depth)?.charId };
          if (p.matrix !== null) op.matrix = pxMatrix(p.matrix);
          if (p.cxform !== null) op.cxform = p.cxform;
          if (p.hidden) op.hidden = true;
          if (p.visibleFlag === true) op.visible = true;
          if (p.filters.length > 0) op.filters = p.filters;
          if (p.blendMode !== null) op.blendMode = swfBlendModeName(p.blendMode) ?? 'normal';
          if (p.bitmapCached) op.bitmapCached = true;
          if (p.ratio !== null) ratioOps++;
          // A record that carries nothing we can apply (in this library: a Move
          // whose only field is the morph Ratio) must not produce an op: the
          // object is already alive from an earlier frame, so a no-op op would
          // only bloat the emitted applier.
          if (op.matrix === undefined && op.cxform === undefined && op.hidden === undefined &&
              op.visible === undefined && op.filters === undefined && op.blendMode === undefined &&
              op.bitmapCached === undefined) {
            byDepth.delete(p.depth);
            continue;
          }
          byDepth.set(p.depth, op);
          // Keep the state's transform in sync so a later replace inherits it.
          const prev = state.get(p.depth);
          if (prev && p.matrix !== null) prev.matrix = pxMatrix(p.matrix);
          continue;
        }
        const prev = state.get(p.depth);
        // A replace inherits the transform/cxform the record omits (see above).
        const matrix = p.matrix !== null ? pxMatrix(p.matrix) : (prev?.matrix ?? null);
        state.set(p.depth, { charId: p.charId, matrix });
        byDepth.set(p.depth, {
          depth: p.depth, charId: p.charId, replace: prev !== undefined || undefined, matrix,
          cxform: p.cxform,
          hidden: p.hidden || undefined,
          visible: p.visibleFlag === true || undefined,
          filters: p.filters.length > 0 ? p.filters : undefined,
          blendMode: p.blendMode === null ? undefined : (swfBlendModeName(p.blendMode) ?? 'normal'),
          bitmapCached: p.bitmapCached || undefined,
        });
      }
      const ops = [...byDepth.values()].sort((a, b) => a.depth - b.depth);
      if (ops.length > 0) frames.push({ frame: f, ops });
    }
    return frames;
  };

  const characters: SwcBakeCharacter[] = [];
  // DefineScalingGrid: the splitter rect is in the character's own twips space,
  // like every other coordinate the baker sees, so it becomes pixels once here.
  const bakeGrid = (id: number): SwcBakeGrid | undefined => {
    const r = lib.scalingGrids.get(id);
    if (r === undefined) return undefined;
    return {
      x: r.xmin / TWIPS,
      y: r.ymin / TWIPS,
      w: (r.xmax - r.xmin) / TWIPS,
      h: (r.ymax - r.ymin) / TWIPS,
    };
  };
  for (const id of [...wantChars].sort((a, b) => a - b)) {
    // Characters the baker cannot build (text/font/morph) are reported through
    // `unsupported` instead of being emitted; `as_swc_new` then returns NULL for
    // them and the placement code skips the child.
    if (unsupportedIds.has(id)) continue;
    if (lib.characters.get(id)?.kind === 'morph') {
      characters.push({ id, kind: 'morph' });
      continue;
    }
    const text = textById.get(id);
    if (text !== undefined) {
      const b = text.bounds;
      characters.push({
        id, kind: 'text',
        text: { ox: px(b.xmin), oy: px(b.ymin), w: px(b.xmax - b.xmin), h: px(b.ymax - b.ymin) },
      });
      continue;
    }
    const shape = shapeById.get(id);
    if (shape) {
      characters.push({ id, kind: 'shape', shape: bakeShape(shape) });
      continue;
    }
    const sprite = spriteById.get(id);
    if (sprite) {
      const frames = spriteFrames(sprite);
      characters.push({
        id, kind: 'sprite', children: spriteChildren(sprite), scalingGrid: bakeGrid(id),
        // Frame 1 is `children`; frames 2..N are the cumulative ops above. A
        // single-frame sprite emits neither (the emitter keys off totalFrames).
        totalFrames: Math.max(1, sprite.frames),
        frames: frames.length > 0 ? frames : undefined,
        labels: sprite.labels.length > 0 ? sprite.labels : undefined,
      });
      continue;
    }
    const button = buttonById.get(id);
    if (button) {
      const states = (bits: number): SwcBakePlacement[] => button.records
        .filter((r) => (r.states & bits) !== 0)
        .sort((a, b) => a.depth - b.depth)
        .map((r) => ({ charId: r.charId, matrix: pxMatrix(r.matrix), cxform: r.cxform }));
      characters.push({ id, kind: 'button', button: { up: states(1), over: states(2), down: states(4), hit: states(8) }, scalingGrid: bakeGrid(id) });
      continue;
    }
    if (lib.characters.get(id)?.kind !== 'bitmap') {
      throw new Error(`SWC: character #${id} is neither buildable nor a known bitmap`);
    }
    characters.push({ id, kind: 'bitmap', bitmapId: id });
  }

  const bitmaps: SwcBakeBitmap[] = [];
  for (const id of [...wantBitmaps].sort((a, b) => a - b)) {
    const b = bitmapById.get(id) as SwcBitmap;
    const shared = b.className !== null ? resSymbol.get(b.className) : undefined;
    bitmaps.push({
      id,
      bytesSymbol: shared ?? `__swcbmp_${id}`,
      ownBytes: shared === undefined,
      width: b.width,
      height: b.height,
      format: b.format,
      encoded: b.encoded,
    });
  }

  // PlaceObject3 attributes the baker cannot express. AIR applies all of them, so
  // each of these is a real fidelity gap and must be named, never swallowed
  // (swc.md §9.2 F4).
  const notes: string[] = [];
  const skippedFilterKinds = new Map<number, number>();
  const unmappedBlends = new Map<number, number>();
  for (const sp of lib.sprites) {
    if (!wantChars.has(sp.id)) continue;
    for (const p of sp.placements) {
      for (const t of p.skippedFilters) skippedFilterKinds.set(t, (skippedFilterKinds.get(t) ?? 0) + 1);
      if (p.blendMode !== null && swfBlendModeName(p.blendMode) === null) {
        unmappedBlends.set(p.blendMode, (unmappedBlends.get(p.blendMode) ?? 0) + 1);
      }
    }
  }
  for (const [t, n] of [...skippedFilterKinds].sort((a, b) => a[0] - b[0])) {
    notes.push(`${n} PlaceObject3 FILTERLIST record(s) use filter kind ${SWF_FILTER_NAMES[t] ?? `#${t}`}, which is not rendered`);
  }
  for (const [v, n] of [...unmappedBlends].sort((a, b) => a[0] - b[0])) {
    notes.push(`${n} PlaceObject3 record(s) use BlendMode ${v}, which has no equivalent here and is rendered as normal`);
  }

  // The placeholders are a tree-shape match, not text rendering: say so once,
  // loudly, instead of letting an empty label look like a decoding bug.
  for (const [mid, kind] of maskNotes) {
    notes.push(
      `clipDepth mask character #${mid} (${kind}) cannot be expressed as a path clip: AIR masks with the ` +
      `rendered alpha of a ${kind}, which our path clip cannot reproduce. The mask object itself keeps its ` +
      `place in the display list (not painted, matching AIR), but the siblings in its depth range are drawn ` +
      `UNCLIPPED (swc.md §10)`
    );
  }
  const morphPlaceholders = characters.filter((c) => c.kind === 'morph').length;
  if (morphPlaceholders > 0) {
    notes.push(
      `${morphPlaceholders} DefineMorphShape/DefineMorphShape2 character(s) are baked as EMPTY Shape placeholders: ` +
      `AIR builds a MorphShape there (a Shape subclass) whose two geometries and morph ratio are not decoded, so ` +
      `the child keeps its place in the display list but paints nothing (swc.md §10)`
    );
  }
  const textPlaceholders = characters.filter((c) => c.kind === 'text').length;
  if (textPlaceholders > 0) {
    const autoSized = characters.filter((c) => c.kind === 'text' && textAuto(c.id)).length;
    notes.push(
      `${textPlaceholders} DefineText/DefineEditText character(s) are baked as EMPTY TextField placeholders ` +
      `(box size + position from the SWF RECT): AIR also fills them with the authored glyphs, which this baker ` +
      `does not decode (swc.md §3.3 / §10)` +
      (autoSized > 0
        ? `; ${autoSized} of them have DefineEditText's AutoSize flag set, so AIR fits their box to those glyphs ` +
          `and the width/height it reports differ from the RECT`
        : '')
    );
  }
  const timelineSprites = characters.filter((c) => c.kind === 'sprite' && (c.totalFrames ?? 1) > 1);
  if (timelineSprites.length > 0) {
    const labelled = timelineSprites.filter((c) => (c.labels ?? []).length > 0).length;
    const animated = timelineSprites.filter((c) => (c.frames ?? []).length > 0).length;
    notes.push(
      `${timelineSprites.length} baked DefineSprite character(s) have a multi-frame timeline (totalFrames > 1): ` +
      `${animated} of them change their display list after frame 1 and ${labelled} carry FrameLabel records. ` +
      `The timeline itself is baked (gotoAndStop/gotoAndPlay/nextFrame/prevFrame/play and currentLabels work), ` +
      `but the per-frame ACTION SCRIPTS live in DoABC, which this baker does not read: AIR's stop()/gotoAndStop() ` +
      `frame scripts are therefore NOT run, and every baked clip starts on frame 1 with isPlaying == false ` +
      `(which is what adl 51.4.1 reports for this library's skin clips, measured)`
    );
  }
  for (const n of frameNotes) notes.push(n);
  if (ratioOps > 0) {
    notes.push(
      `${ratioOps} PlaceObject record(s) carry only a morph Ratio (up to 100 frames of a morph animation): ` +
      `the ratio cannot be applied because DefineMorphShape is baked as an empty placeholder, so those frames ` +
      `paint nothing where AIR morphs between two geometries (swc.md §10)`
    );
  }
  const classOf = new Map<number, string>();
  for (const [id, name] of lib.classNames) classOf.set(id, name);
  const unsupported: SwcBakeUnsupported[] = [...unsupportedIds.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, kind]) => ({ id, kind, uses: uses.get(id) ?? 0 }));
  return { characters, bitmaps, classOf, chars: classChars, unsupported, notes };
}

/** Human names for the non-buildable character tags, so a diagnostic can say
 *  "DefineEditText" rather than "tag 37" (swc.md §3.3 lists the whole class of
 *  tags the baker deliberately does not render). */
/** SWF FilterID -> spec name, so a diagnostic can say "Bevel" not "#3". */
const SWF_FILTER_NAMES: Record<number, string> = {
  0: 'DropShadow', 1: 'Blur', 2: 'Glow', 3: 'Bevel', 4: 'GradientGlow',
  5: 'Convolution', 6: 'ColorMatrix', 7: 'GradientBevel',
};

const UNSUPPORTED_TAG_NAMES: Record<number, string> = {
  6: 'DefineBits', 10: 'DefineFont', 11: 'DefineText', 33: 'DefineText2',
  37: 'DefineEditText', 46: 'DefineMorphShape', 48: 'DefineFont2',
  75: 'DefineFont3', 84: 'DefineMorphShape2', 87: 'DefineBinaryData',
  88: 'DefineFontName',
};

/** SWF tag codes that define a character (used for the reference-graph check). */
const CHARACTER_TAG_KINDS: Record<number, SwcCharacterKind> = {
  // Shapes: DefineShape(2), Shape2(22), Shape3(32), Shape4(83).
  2: 'shape', 22: 'shape', 32: 'shape', 83: 'shape',
  // Buttons: DefineButton(7), DefineButton2(34).
  7: 'button', 34: 'button',
  // Sprites.
  39: 'sprite',
  // Bitmaps: Lossless(20), JPEG2(21), JPEG3(35), Lossless2(36), JPEG4(90).
  20: 'bitmap', 21: 'bitmap', 35: 'bitmap', 36: 'bitmap', 90: 'bitmap',
  // Text characters: DefineText(11) / DefineEditText(37). AIR instantiates these as
  // real TextFields, so the baker builds an empty `TextField` placeholder at the
  // character's own RECT (item ②) rather than dropping the child.
  11: 'text', 37: 'text',
  // Morph shapes: DefineMorphShape(46) / DefMorphShape2(84). AIR instantiates these
  // as `MorphShape` (a Shape subclass) — measured, temp/childfx: fileitemskin c2 has
  // 4 children in AIR of which c1 is a MorphShape, we had 3. The two geometries and
  // their interpolation are NOT decoded (swc.md §10), so the placeholder is an EMPTY
  // Shape: the tree shape (count + index order) matches AIR while the artwork stays
  // reported as a gap through `notes`.
  46: 'morph', 84: 'morph',
  // Everything else a skin can carry and we parse past: fonts/binary.
  // Classified only so the reference graph can verify ids.
  6: 'other', 10: 'other', 33: 'other',
  48: 'other', 75: 'other', 87: 'other', 88: 'other',
};

// ---------------------------------------------------------------------------
// Bitmap tags
// ---------------------------------------------------------------------------

const TAG_DEFINE_BITS_LOSSLESS = 20;
const TAG_DEFINE_BITS_JPEG2 = 21;
const TAG_DEFINE_BITS_JPEG3 = 35;
const TAG_DEFINE_BITS_LOSSLESS2 = 36;
const TAG_SYMBOL_CLASS = 76;

/** Minimal JPEG dimensions reader (SOF0..SOF15 markers), for JPEG2/3 tags whose
 *  width/height are not in the SWF tag itself. */
function jpegSize(jpeg: Buffer): { width: number; height: number } {
  let p = 2; // skip SOI (0xFFD8)
  while (p + 9 < jpeg.length) {
    if (jpeg[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = jpeg[p + 1];
    // Standalone markers without a length field.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      p += 2;
      continue;
    }
    const segLen = jpeg.readUInt16BE(p + 2);
    // SOF0..SOF15 except DHT(0xC4)/JPG(0xC8)/DAC(0xCC) carry the frame header.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: jpeg.readUInt16BE(p + 5), width: jpeg.readUInt16BE(p + 7) };
    }
    p += 2 + segLen;
  }
  return { width: 0, height: 0 };
}

/** Sniff an encoded payload (JPEG2 tags may legally hold PNG or GIF data). */
function sniffFormat(bytes: Buffer): 'png' | 'jpeg' | 'gif' {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (bytes.length >= 6 && bytes.toString('latin1', 0, 3) === 'GIF') return 'gif';
  return 'jpeg';
}

/**
 * Reverse-premultiply a stored channel value (swc.md §3.2).
 * AIR's `getPixel32` returns `floor(stored*255/A + t)` with `t ∈ [0.329, 0.413)`;
 * `floor(x + 1/3)` matched 219/219 observed `(alpha, stored)` pairs exactly.
 * `A == 0` is fully transparent, so the channel is 0 regardless of storage.
 */
function unpremul(c: number, a: number): number {
  if (a === 0) return 0;
  const v = Math.floor((c * 255) / a + 1 / 3);
  return v > 255 ? 255 : v;
}

/**
 * Decode a `DefineBitsLossless`(20) / `DefineBitsLossless2`(36) payload into
 * straight RGBA bytes (PNG channel order R,G,B,A).
 *
 * `hasAlpha` is the tag distinction that matters: only tag 36's format 5 is
 * true ARGB; tag 20's format 5 is XRGB (first byte is padding, §3.1).
 */
function decodeLossless(
  body: Buffer,
  tag: SwfTag,
  hasAlpha: boolean
): { width: number; height: number; rgba: Buffer } {
  const p = tag.start;
  // characterID u16 | bitmapFormat u8 | width u16 | height u16 | [colorTableSize u8]
  const bitmapFormat = body[p + 2];
  const width = body.readUInt16LE(p + 3);
  const height = body.readUInt16LE(p + 5);
  let q = p + 7;
  let colorTableEntries = 0;
  if (bitmapFormat === 3) {
    colorTableEntries = body[q] + 1; // stored value is count-1
    q += 1;
  }

  // Color table (format 3 only). Tag 36 entries are premultiplied ARGB (4 B);
  // tag 20 entries are RGB (3 B).
  const palette = new Uint8Array(colorTableEntries * 4); // expands to RGBA
  if (bitmapFormat === 3) {
    const stride = hasAlpha ? 4 : 3;
    for (let i = 0; i < colorTableEntries; i++) {
      const o = q + i * stride;
      const a = hasAlpha ? body[o] : 255;
      const r = body[o + (hasAlpha ? 1 : 0)];
      const g = body[o + (hasAlpha ? 2 : 1)];
      const b = body[o + (hasAlpha ? 3 : 2)];
      palette[i * 4] = hasAlpha ? unpremul(r, a) : r;
      palette[i * 4 + 1] = hasAlpha ? unpremul(g, a) : g;
      palette[i * 4 + 2] = hasAlpha ? unpremul(b, a) : b;
      palette[i * 4 + 3] = a;
    }
    q += colorTableEntries * stride;
  }

  const zlibLen = tag.start + tag.length - q;
  const data = inflateSync(body.subarray(q, q + zlibLen));
  const rgba = Buffer.alloc(width * height * 4);

  // `BitmapFormat 3` and `4` pad each row to a 32-bit boundary; `5` needs none.
  // Pick padded vs. plain by which exactly matches the inflated length, so a
  // producer that omits padding still decodes (defensive, still deterministic).
  if (bitmapFormat === 3) {
    const paddedRow = (width + 3) & ~3;
    const rowBytes = data.length === height * paddedRow ? paddedRow : width;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const c = data[y * rowBytes + x] * 4;
        rgba[(y * width + x) * 4] = palette[c];
        rgba[(y * width + x) * 4 + 1] = palette[c + 1];
        rgba[(y * width + x) * 4 + 2] = palette[c + 2];
        rgba[(y * width + x) * 4 + 3] = palette[c + 3];
      }
    }
  } else if (bitmapFormat === 4) {
    // 15-bit RGB: u16 little-endian, 0b0RRRRRGGGGGBBBBB; rows padded like above.
    const paddedRow = (width * 2 + 3) & ~3;
    const rowBytes = data.length === height * paddedRow ? paddedRow : width * 2;
    const exp = (v: number): number => (v << 3) | (v >> 2); // 5->8 bits
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = data.readUInt16LE(y * rowBytes + x * 2);
        const o = (y * width + x) * 4;
        rgba[o] = exp((v >> 10) & 0x1f);
        rgba[o + 1] = exp((v >> 5) & 0x1f);
        rgba[o + 2] = exp(v & 0x1f);
        rgba[o + 3] = 255;
      }
    }
  } else if (bitmapFormat === 5) {
    // 32-bit. Byte order is A,R,G,B (§3.2 ①). Only tag 36 carries real alpha;
    // tag 20's first byte is padding -> force opaque (§3.1).
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      const a = hasAlpha ? data[o] : 255;
      const r = data[o + 1];
      const g = data[o + 2];
      const b = data[o + 3];
      rgba[o] = hasAlpha ? unpremul(r, a) : r;
      rgba[o + 1] = hasAlpha ? unpremul(g, a) : g;
      rgba[o + 2] = hasAlpha ? unpremul(b, a) : b;
      rgba[o + 3] = a;
    }
  } else {
    throw new Error(`SWC: unsupported DefineBitsLossless bitmapFormat ${bitmapFormat}`);
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// PNG encoder (zero-dependency; IHDR + IDAT + IEND, filter 0, RGBA8)
// ---------------------------------------------------------------------------

const CRC_TABLE = ((): Int32Array => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Buffer): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encode straight RGBA bytes (R,G,B,A) as an 8-bit RGBA PNG. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) per scanline, then the raw RGBA row.
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Read a SWC and extract every bitmap resource it carries (swc.md §4/§5). */
export function extractSwc(path: string): SwcLibrary {
  TEXT_AUTOSIZE.clear();
  const zip = readFileSync(path);
  const entries = unzip(zip);
  const swfEntry = entries.find((e) => /(^|\/)library\.swf$/i.test(e.name));
  if (!swfEntry) throw new Error(`SWC: '${path}' has no library.swf entry`);

  const body = swfBody(swfEntry.data);
  const tags = scanTags(body);

  // SymbolClass(76): u16 count, then count × (u16 tagId, null-terminated name).
  const classNames = new Map<number, string>();
  for (const t of tags) {
    if (t.code !== TAG_SYMBOL_CLASS) continue;
    const count = body.readUInt16LE(t.start);
    let p = t.start + 2;
    for (let i = 0; i < count; i++) {
      const id = body.readUInt16LE(p);
      p += 2;
      let end = p;
      while (end < body.length && body[end] !== 0) end++;
      classNames.set(id, body.toString('utf8', p, end));
      p = end + 1;
    }
  }

  const bitmaps: SwcBitmap[] = [];
  for (const t of tags) {
    const id = t.length >= 2 ? body.readUInt16LE(t.start) : 0;
    if (t.code === TAG_DEFINE_BITS_LOSSLESS || t.code === TAG_DEFINE_BITS_LOSSLESS2) {
      const hasAlpha = t.code === TAG_DEFINE_BITS_LOSSLESS2;
      const { width, height, rgba } = decodeLossless(body, t, hasAlpha);
      bitmaps.push({
        tagId: id,
        className: classNames.get(id) ?? null,
        format: 'png',
        width,
        height,
        encoded: encodePng(width, height, rgba),
      });
    } else if (t.code === TAG_DEFINE_BITS_JPEG2) {
      // characterID u16 + complete JPEG/PNG/GIF bytes, pass-through (no alpha).
      const encoded = Buffer.from(body.subarray(t.start + 2, t.start + t.length));
      const format = sniffFormat(encoded);
      const { width, height } = format === 'jpeg' ? jpegSize(encoded) : { width: 0, height: 0 };
      bitmaps.push({ tagId: id, className: classNames.get(id) ?? null, format, width, height, encoded });
    } else if (t.code === TAG_DEFINE_BITS_JPEG3) {
      // characterID u16 | alphaDataOffset u32 | JPEG bytes | zlib alpha plane.
      // JPEG cannot carry alpha, and we have no JPEG decoder in the zero-dep
      // build, so the alpha plane is dropped; flag it loudly rather than ship a
      // silently-opaque image (swc.md §10 keeps full JPEG3 support deferred).
      const alphaOffset = body.readUInt32LE(t.start + 2);
      const encoded = Buffer.from(body.subarray(t.start + 6, t.start + 6 + alphaOffset));
      const format = sniffFormat(encoded);
      const { width, height } = format === 'jpeg' ? jpegSize(encoded) : { width: 0, height: 0 };
      process.stderr.write(
        `\x1b[33mwarning: SWC bitmap #${id} is DefineBitsJPEG3; its alpha plane is not ` +
          `composited (JPEG has no alpha channel) — the image will decode opaque\x1b[0m\n`
      );
      bitmaps.push({ tagId: id, className: classNames.get(id) ?? null, format, width, height, encoded });
    }
  }

  // --- Vector characters + display tree (swc.md §3.4) ----------------------
  // Every character is parsed here rather than lazily: the reference graph is
  // self-checking (a placement that names an unknown id means a desync), and the
  // emitter wants the whole closure up front to emit factories bottom-up.
  const shapes: SwcShape[] = [];
  const sprites: SwcSprite[] = [];
  const buttons: SwcButton[] = [];
  const texts: SwcText[] = [];
  const scalingGrids = new Map<number, SwcRect>();
  const characters = new Map<number, SwcCharacter>();
  for (const t of tags) {
    const kind = CHARACTER_TAG_KINDS[t.code];
    if (kind) {
      const id = t.length >= 2 ? body.readUInt16LE(t.start) : 0;
      // A later definition of the same id wins (SWF allows redefinition).
      characters.set(id, { id, kind, tag: t.code });
      // Both text tags carry the character's RECT right after the id:
      // DefineText = CharacterID | TextBounds | TextMatrix | GlyphBits | ..., and
      // DefineEditText = CharacterID | Bounds | flags | ... Only the RECT is read:
      // the glyph/text payload is a documented, out-of-scope gap (swc.md §3.3).
      if (t.code === 11 || t.code === 37) {
        const r = new SwfReader(body, t.start + 2, t.start + t.length);
        const bounds = readSwfRect(r);
        // DefineEditText's flag bytes follow the RECT; AutoSize is 0x80 of the
        // second one. DefineText (tag 11) goes straight to TextMatrix, so it has none.
        let autoSize = false;
        if (t.code === 37) {
          r.u8(); // HasText / HasTextColor / HasMaxLength / HasFont / HasFontClass / HasLayout / Password / ReadOnly
          autoSize = (r.u8() & 0x80) !== 0;
        }
        texts.push({ id, bounds, autoSize });
        TEXT_AUTOSIZE.set(id, autoSize);
      }
    }
    if (t.code === 2 || t.code === 22 || t.code === 32 || t.code === 83) {
      const shape = parseSwfShape(body, t);
      shapes.push(shape);
      characters.set(shape.id, { id: shape.id, kind: 'shape', tag: t.code });
    } else if (t.code === 39) {
      const sprite = parseSwfSprite(body, t);
      sprites.push(sprite);
      characters.set(sprite.id, { id: sprite.id, kind: 'sprite', tag: t.code });
    } else if (t.code === 7 || t.code === 34) {
      const button = parseSwfButton(body, t);
      buttons.push(button);
      characters.set(button.id, { id: button.id, kind: 'button', tag: t.code });
    } else if (t.code === 78) {
      // DefineScalingGrid: characterId u16 | RECT splitter.
      const id = body.readUInt16LE(t.start);
      scalingGrids.set(id, readSwfRect(new SwfReader(body, t.start + 2, t.start + t.length)));
    }
  }
  // Reference-graph check: every placement and button record must name a known
  // character. A dangling id is the cheapest tell that a parse desynced.
  const missing = new Set<number>();
  for (const s of sprites) {
    for (const p of s.placements) if (p.charId !== null && !characters.has(p.charId)) missing.add(p.charId);
  }
  for (const b of buttons) {
    for (const rec of b.records) if (!characters.has(rec.charId)) missing.add(rec.charId);
  }
  if (missing.size > 0) {
    throw new Error(
      `SWC: display tree references unknown character ids [${[...missing].sort((a, b) => a - b).join(', ')}]`
    );
  }
  // counts are exposed only through the returned library (swc.md §9 E).

  return { source: path, bitmaps, shapes, sprites, buttons, texts, scalingGrids, classNames, characters };
}