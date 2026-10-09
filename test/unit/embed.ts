// Unit checks: `[Embed]` metadata (阶段一百一十二).
//
// Why these live here and not in examples/embed.as: the example suite only runs
// programs that must SUCCEED, so every REFUSAL (a metadata on the wrong member, an
// unsupported mimeType, a missing file) is unassertable there. The example covers
// the runtime contract (asset kinds, Class-value identity, decoded pixels); this
// group pins the compile-time side: what `[Embed]` expands to, which assets share
// a generated class, and the exact wording/position of each refusal.
//
// Everything asserted below is read off the real collectors/emitter, not from
// memory; the adl-measured counterpart of each rule is temp/embedprobe4
// (path resolution), temp/embedprobe6 (mimeType precedence) and temp/embedprobe7
// (Class-value identity, arity, sound length).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { embedCompileInputs, embedFieldKey, resolveEmbedSource } from '../../src/embed.ts';
import { registerGroup, root, dir } from '../harness.ts';

// The committed fixtures feed both this group and examples/embed.as; the same
// files keep the two from drifting apart.
const ASSETS = join(dir, 'embed-assets');
const EXAMPLE_DIR = dir;

function src(body: string): string {
  return `class Assets {\n${body}\n}`;
}

function collect(body: string, fileDir = EXAMPLE_DIR, sourceRoot = EXAMPLE_DIR) {
  return embedCompileInputs(parse(src(body)).body, { fileDir, sourceRoot });
}

function thrown(fn: () => unknown): (Error & { line?: number; col?: number }) | null {
  try { fn(); return null; } catch (e) { return e as Error & { line?: number; col?: number }; }
}

// ---- what [Embed] expands to: kinds, names, the field→class binding ----
function checkCollect(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [embed] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [embed] ${label}`); }
  };

  const image = collect('  [Embed(source="embed-assets/px.png")]\n  public static const px:Class;');
  check('a .png Embed synthesizes exactly one class',
    image.decls.length === 1 && image.resources.length === 1);
  check('...named after the declaring class and field (readable in the C)',
    image.resources[0]?.className === 'Embed_Assets_px');
  check('...of kind image, extending flash.display.Bitmap',
    image.resources[0]?.kind === 'image' && (image.decls[0] as any).superClass === 'flash.display.Bitmap');
  check('...final and dynamic, like AIR\'s generated asset classes',
    (image.decls[0] as any).isFinal === true && (image.decls[0] as any).isDynamic === true);
  check('...with a ZERO-argument constructor',
    (image.decls[0] as any).members[0]?.kind === 'Constructor'
    && (image.decls[0] as any).members[0]?.params.length === 0);
  check('...and the field is bound to that class',
    image.fieldInits.get(embedFieldKey('Assets', null, 'px')) === 'Embed_Assets_px');
  check('the embedded bytes are the file, verbatim',
    image.resources[0]!.encoded.equals(readFileSync(join(ASSETS, 'px.png'))));

  const sound = collect('  [Embed(source="embed-assets/flap.mp3")]\n  public static const snd:Class;');
  check('a .mp3 Embed is a Sound subclass',
    sound.resources[0]?.kind === 'sound' && (sound.decls[0] as any).superClass === 'flash.media.Sound');

  // mimeType WINS over the extension (adl: temp/embedprobe6) -- in both directions.
  const pngAsBin = collect('  [Embed(source="embed-assets/px.png", mimeType="application/octet-stream")]\n  public static const raw:Class;');
  check('mimeType=application/octet-stream turns a .png into raw bytes',
    pngAsBin.resources[0]?.kind === 'binary' && (pngAsBin.decls[0] as any).superClass === 'flash.utils.ByteArray');
  const binAsPng = collect('  [Embed(source="embed-assets/blob.bin", mimeType="image/png")]\n  public static const asPng:Class;');
  check('...and mimeType=image/png turns a .bin into an image',
    binAsPng.resources[0]?.kind === 'image');
  check('a JPEG extension is an image too (away3d skybox)',
    collect('  [Embed(source="embed-assets/px.png", mimeType="image/jpeg")]\n  public static const j:Class;').resources[0]?.kind === 'image');

  // Two fields embedding the SAME file with the same mimeType share one class
  // object; a different mimeType is a different asset (measured on adl 51.4.1,
  // temp/embedprobe7: picA === picB true, and the name carries the digest).
  const twice = collect(
    '  [Embed(source="embed-assets/px.png")]\n  private var a:Class;\n' +
    '  [Embed(source="embed-assets/px.png")]\n  private var b:Class;\n' +
    '  [Embed(source="embed-assets/px.png", mimeType="application/octet-stream")]\n  private var c:Class;'
  );
  check('the same asset embedded twice shares ONE generated class',
    twice.decls.length === 2 && twice.resources.length === 2
    && twice.fieldInits.get(embedFieldKey('Assets', null, 'a')) === 'Embed_Assets_a'
    && twice.fieldInits.get(embedFieldKey('Assets', null, 'b')) === 'Embed_Assets_a');
  check('...while a different mimeType is its own class',
    twice.fieldInits.get(embedFieldKey('Assets', null, 'c')) === 'Embed_Assets_c');

  // A packaged declaring class is flattened the same way class C names are.
  const pkg = embedCompileInputs(
    parse('package com.example { class Assets { [Embed(source="embed-assets/px.png")] public static const px:Class; } }').body,
    { fileDir: EXAMPLE_DIR, sourceRoot: EXAMPLE_DIR }
  );
  check('a packaged declaring class flattens its name into the C identifier',
    pkg.resources[0]?.className === 'Embed_com_example_Assets_px');

  check('an [Embed]-free class yields nothing', collect('  public var n:int;').decls.length === 0);

  // An inherited-static [Embed] (the SWC path's shape) must not be touched: the
  // collector only looks at class members of class declarations.
  check('only class members are scanned (module functions are ignored)',
    embedCompileInputs(parse('function f():void {}').body, { fileDir: EXAMPLE_DIR, sourceRoot: EXAMPLE_DIR }).decls.length === 0);

  if (ok > 0) console.log(`[embed] ${ok} collection checks passed`);
  return bad;
}

// ---- refusals: every unsupported [Embed] fails loudly, with a position ----
function checkRefusals(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [embedrefuse] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [embedrefuse] ${label}`); }
  };

  const onMethod = thrown(() => collect(
    '  [Embed(source="embed-assets/px.png")]\n  public function f():void {}'));
  check('an [Embed] on a method is refused (not ignored)',
    onMethod?.message.includes("[Embed] is only supported on a Class-typed class member, not on 'Assets.f'") === true);
  check('...with the member line and column',
    onMethod?.line === 2 && onMethod?.col === 3);

  const withInit = thrown(() => collect(
    '  [Embed(source="embed-assets/px.png")]\n  public static const px:Class = null;'));
  check('an [Embed] field with an initializer is refused',
    withInit?.message.includes('must not also have an initializer') === true && withInit?.line === 2);

  const wrongType = thrown(() => collect(
    '  [Embed(source="embed-assets/px.png")]\n  public static const px:String;'));
  check('an [Embed] field that is not typed Class is refused',
    wrongType?.message.includes('must be typed Class') === true);

  const noSource = thrown(() => collect('  [Embed]\n  public static const px:Class;'));
  check('[Embed] with no source is refused',
    noSource?.message.includes("has no source") === true);

  const badMime = thrown(() => collect(
    '  [Embed(source="embed-assets/px.png", mimeType="image/svg+xml")]\n  public static const px:Class;'));
  check('an unsupported mimeType is refused with the supported set spelled out',
    badMime?.message.includes("mimeType 'image/svg+xml'") === true
    && badMime?.message.includes('supported: ') === true);

  const badExt = thrown(() => collect('  [Embed(source="embed-assets/blob.bin")]\n  public static const b:Class;'));
  check('an unrecognized extension is refused with the supported set spelled out',
    badExt?.message.includes('has no recognized asset type') === true
    && badExt?.message.includes('mimeType="application/octet-stream"') === true);

  const missing = thrown(() => collect('  [Embed(source="embed-assets/nope.png")]\n  public static const p:Class;'));
  check('a missing file names the resolved path and both resolution rules',
    missing?.message.includes(join(ASSETS, 'nope.png')) === true
    && missing?.message.includes("declaring file's directory") === true
    && missing?.message.includes('source root') === true);

  // A relative source follows the DECLARING FILE (not the cwd, not the entry
  // file); a leading '/' follows the source root. Measured: temp/embedprobe4.
  check('a relative source resolves against the declaring file\'s directory',
    resolveEmbedSource('embed-assets/px.png', join(root, 'examples'), join(root, 'elsewhere'))
      === join(root, 'examples', 'embed-assets', 'px.png'));
  check('a leading / resolves against the source root (away3d\'s /../pb/*.pbj)',
    resolveEmbedSource('/../pb/k.pbj', join(root, 'examples'), join(root, 'app', 'src'))
      === join(root, 'app', 'pb', 'k.pbj'));

  if (ok > 0) console.log(`[embedrefuse] ${ok} refusal checks passed`);
  return bad;
}

// ---- the generated C: one class object, one registry entry, one byte array ----
function checkEmit(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [embedemit] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [embedemit] ${label}`); }
  };

  const program = parse(src(
    '  [Embed(source="embed-assets/px.png")]\n  public static const px:Class;\n' +
    '  [Embed(source="embed-assets/px.png")]\n  private var inst:Class;\n' +
    '  [Embed(source="embed-assets/blob.bin", mimeType="application/octet-stream")]\n  public static const blob:Class;\n' +
    '  public function bd():BitmapData { return (new inst() as Bitmap).bitmapData; }'
  ));
  const inputs = embedCompileInputs(program.body, { fileDir: EXAMPLE_DIR, sourceRoot: EXAMPLE_DIR });
  program.body.push(...inputs.decls);
  const c = generateC(program, [], undefined, undefined, inputs.resources, inputs.fieldInits).c;

  check('the image class carries the file bytes',
    c.includes('static const unsigned char as_embed_bytes_Embed_Assets_px['));
  check('...and the matching decode hook',
    /as_embed_bitmap_fill\(\(Bitmap\*\)o, as_embed_bytes_Embed_Assets_px, \(size_t\)140\);/.test(c));
  check('the binary class gets the raw-bytes hook',
    /as_embed_ba_fill\(\(ByteArray\*\)o, as_embed_bytes_Embed_Assets_blob, \(size_t\)256\);/.test(c));
  check('a payload-only asset emits no separate BitmapData hook',
    !c.includes('as_embed_bytes_Embed_Assets_blob_texture'));
  check('the declaring fields are initialized to the generated class values',
    /Assets_px = &Embed_Assets_px_cls;/.test(c) && /o->inst = &Embed_Assets_px_cls;/.test(c));
  check('the same asset reused for an instance field shares the class object',
    !c.includes('Embed_Assets_inst_cls') && c.includes('o->inst = &Embed_Assets_px_cls;'));
  check('the generated class is registered under one canonical name',
    /\{ "Embed_Assets_px", &Embed_Assets_px_cls \}/.test(c));

  // The class-registry invariant the Class-value identity rules rest on: every
  // entry POINTS at the class's own as_class object. A second inline copy made
  // `x is Class` false for a Class value that came from source (and true for the
  // same value obtained from getDefinitionByName) -- measured on adl 51.4.1:
  // temp/embedprobe7, `var x:* = pic; x is Class` is true.
  const inline = c.match(/as_class_reg as_class_registry\[\] = \{[\s\S]*?\n\};/);
  check('the class registry stores pointers, never inline copies',
    inline !== null && !inline[0].includes('{ &') && inline[0].includes('&Embed_Assets_px_cls'));
  check('...and the Class-value test is registry membership',
    /static bool as_v_is_class\(as_value v\)[\s\S]{0,400}as_class_registry\[i\]\.cls == v\.ptr/.test(c));
  check('a Class VALUE is not an instance of the class it names (as_v_is_inst guard)',
    /as_v_is_inst\(as_value v, void\* target_vt\)[\s\S]{0,2000}as_v_is_class\(v\)\) return false;/.test(c));

  // The runtime's own contract, pinned in the source so a refactor cannot drop it.
  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  check('`obj.constructor` is answered by the object\'s class (not a props lookup)',
    runtime.includes('if (strcmp(key, "constructor") == 0) return as_v_class_of(as_v_obj(obj));'));

  if (ok > 0) console.log(`[embedemit] ${ok} emit checks passed`);
  return bad;
}

registerGroup('unit: embed/collect', checkCollect);
registerGroup('unit: embed/refuse', checkRefusals);
registerGroup('unit: embed/emit', checkEmit);