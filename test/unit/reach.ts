// Unit checks: the `--air-app` main-class reachability closure (阶段一百二十四).
//
// Why these live here and not in examples/: the closure only exists on the
// `--air-app` path, which the example suite never takes (`test/examples.ts`
// compiles directory units through the plain input list, and `examples/away3d-core`
// — the tree that motivated the closure — is a gitignored 485-file engine it
// skips). So nothing in `node test.ts` would notice if the closure started
// dropping a class some reachable file needs.
//
// The fixture below is synthetic and small enough to state its expected
// kept/dropped sets in FULL, and every class is kept by exactly ONE edge kind, so
// a walker that loses a case names the case when the class disappears. The
// attribution checks prove that: they delete one reference from the document
// class and assert the target class — and nothing else — leaves the kept set.
//
// Everything runs through the REAL preparation path (`prepareReachFiles`), whose
// anonymous-namespace rewrite decides the identities the closure resolves
// against; a test that re-implemented that rewrite could pass while the build
// broke.
//
// The emitted-C checks at the end turn the manual acceptance evidence into a
// regression: `generateC` must accept the pruned program, and the pruned C must
// be a strict function-level SUBSET of the whole-tree C (measured on the away3d
// demos: 0 functions present only in the closure build; the only text that
// differs is the per-build type/root manifest tables, which are themselves
// subsets).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { prepareReachFiles, computeReachable } from '../../src/reach.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root } from '../harness.ts';

// ---- fixture: `app.Main` plus one class per edge kind -------------------------
//
// `// m-*` comments tag the statement that reaches each class, so an attribution
// check can delete exactly that line. `app/Main.as` is the only file that varies.
//
// `Thing` is declared twice (`amb.Thing`, `amb2.Thing`) and referenced as a bare
// name with no import for either: AS3 resolves that through the global
// short-name table (`typeAlias` in symbols.ts is last-wins), so the closure must
// keep BOTH candidates — over-approximation is the whole soundness argument.
const FIXTURE: [string, string][] = [
  ['app/Main.as', `package app {
  import app.chain.A;
  import app.unused.Unused;
  import app.wild.*;
  import app.stt.St;
  public class Main {
    public function Main():void {
      var a:A = new A(); // m-chain
      trace(a); // m-chain
      var q:app.qual.Q = new app.qual.Q(); // m-qualified
      trace(q); // m-qualified
      var w:W = new W(); // m-wildcard
      trace(w); // m-wildcard
      var v:Vector.<app.vec.V> = new Vector.<app.vec.V>(); // m-vector
      trace(v); // m-vector
      var s:Object = new Object();
      if (s is app.isx.Ix) { trace("is"); } // m-is
      try { trace("t"); } catch (e:app.err.Err) { trace("c"); } // m-catch
      St.run(); // m-static
      var impl:app.iface.Impl = new app.iface.Impl(); // m-impl
      trace(impl); // m-impl
      make(null);
      var t:Thing = null; // m-ambiguous
      trace(t); // m-ambiguous
    }
    public function make(p:app.par.P):app.par.Ret { return null; } // m-paramsig
  }
}
`],
  // A extends Base with a SHORT name (the parser takes only short names for
  // `extends`/`implements`), so Base is reached by own-package resolution.
  ['app/chain/A.as', `package app.chain {
  import app.chain.B;
  public class A extends Base {
    public function A():void { var b:B = new B(); trace(b); }
  }
}
`],
  ['app/chain/B.as', `package app.chain {
  public class B { public function B():void { } }
}
`],
  ['app/chain/Base.as', `package app.chain {
  public class Base { public function Base():void { } }
}
`],
  ['app/qual/Q.as', `package app.qual {
  public class Q { public function Q():void { } }
}
`],
  ['app/wild/W.as', `package app.wild {
  public class W { public function W():void { } }
}
`],
  ['app/vec/V.as', `package app.vec {
  public class V { public function V():void { } }
}
`],
  ['app/isx/Ix.as', `package app.isx {
  public class Ix { public function Ix():void { } }
}
`],
  ['app/err/Err.as', `package app.err {
  public class Err { public function Err():void { } }
}
`],
  ['app/stt/St.as', `package app.stt {
  public class St { public static function run():void { } }
}
`],
  ['app/iface/Iface.as', `package app.iface {
  public interface Iface { function ping():int; }
}
`],
  // Impl is reached by `new Impl()`; Iface is reached ONLY through this
  // `implements` clause.
  ['app/iface/Impl.as', `package app.iface {
  public class Impl implements Iface {
    public function ping():int { return 1; }
  }
}
`],
  ['app/par/P.as', `package app.par {
  public class P { public function P():void { } }
}
`],
  ['app/par/Ret.as', `package app.par {
  public class Ret { public function Ret():void { } }
}
`],
  // Imported by Main but never used: an unused `import` is NOT an edge (mxmlc
  // does not link a class just because it was imported).
  ['app/unused/Unused.as', `package app.unused {
  public class Unused { public function Unused():void { } }
}
`],
  ['other/Dead.as', `package other {
  public class Dead { public function Dead():void { } }
}
`],
  // No `package` block at all => per-file anonymous namespace (AS3 §5.1). Nothing
  // can reach it from another file, so it drops.
  ['anon/Anon.as', `class Anon { public function Anon():void { } }
`],
  // A free function is a non-class top-level statement, emitted for the whole
  // program regardless of reachability, so its file is always kept. This is the
  // `away3d/debug/Debug.as` case (`function dotrace(...)`).
  ['mod/Mod.as', `package mod {
  function helper():int { return 1; }
}
`],
  // `[WasmExport]` marks a deliberate JS entry point, so it is a root with no AS3
  // reference pointing at it.
  ['wx/Wx.as', `package wx {
  [WasmExport]
  public class Wx { public static function f():int { return 2; } }
}
`],
  ['amb/A1.as', `package amb { public class Thing { public function Thing():void { } } }
`],
  ['amb2/A2.as', `package amb2 { public class Thing { public function Thing():void { } } }
`],
];

const EXPECTED_KEPT = [
  'A', 'A1', 'A2', 'B', 'Base', 'Err', 'Iface', 'Impl', 'Ix', 'Main',
  'Mod', 'P', 'Q', 'Ret', 'St', 'V', 'W', 'Wx',
];
const EXPECTED_DROPPED = ['Anon', 'Dead', 'Unused'];

const FIXTURE_ROOT = join(root, 'temp', 'reachunit');

type Overrides = Map<string, [string, string]>;

function short(p: string): string {
  return basename(p).replace(/\.as$/, '');
}

// Write the fixture (optionally rewriting one source, e.g. to drop a `[WasmExport]`)
// and return the directory layout the closure needs.
function writeFixture(dirName: string, overrides: Overrides = new Map()): { srcDir: string; asFiles: string[] } {
  const dir = join(FIXTURE_ROOT, dirName);
  rmSync(dir, { recursive: true, force: true });
  const srcDir = join(dir, 'src');
  for (const [rel, source] of FIXTURE) {
    const p = join(srcDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    const ov = overrides.get(rel);
    writeFileSync(p, ov === undefined ? source : source.replace(ov[0], ov[1]));
  }
  return { srcDir, asFiles: FIXTURE.map(([rel]) => join(srcDir, rel)) };
}

// Replace the `strip` marker's lines in Main.as (null keeps the fixture verbatim).
function mainWithout(strip: string | null): Overrides {
  const ov: Overrides = new Map();
  if (strip !== null) {
    const source = FIXTURE.find(([rel]) => rel === 'app/Main.as')?.[1] ?? '';
    ov.set('app/Main.as', [source, source.split('\n').filter((l) => !l.includes(`// ${strip}`)).join('\n')]);
  }
  return ov;
}

interface ClosureRun {
  kept: string[];
  dropped: string[];
  files: ReturnType<typeof prepareReachFiles>;
  result: ReturnType<typeof computeReachable>;
}

function runClosure(dirName: string, overrides: Overrides = new Map(), mainClass = 'app.Main'): ClosureRun {
  const { srcDir, asFiles } = writeFixture(dirName, overrides);
  const files = prepareReachFiles(asFiles, srcDir);
  const result = computeReachable(files, mainClass);
  return { kept: result.kept.map(short).sort(), dropped: result.dropped.map(short).sort(), files, result };
}

function checker(prefix: string) {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [${prefix}] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [${prefix}] ${label}`); }
  };
  return { check, bad, done: () => { if (ok > 0) console.log(`[${prefix}] ${ok} checks passed`); return bad; } };
}

// ---- the kept/dropped sets themselves ----------------------------------------
function checkClosure(): string[] {
  const c = checker('reach');
  const r = runClosure('p1');

  c.check('the document class and its whole transitive closure are kept',
    JSON.stringify(r.kept) === JSON.stringify(EXPECTED_KEPT));
  c.check('everything unreachable is dropped',
    JSON.stringify(r.dropped) === JSON.stringify(EXPECTED_DROPPED));
  c.check('kept + dropped accounts for every input file',
    r.kept.length + r.dropped.length === FIXTURE.length);
  c.check('an unused `import` alone does not keep a class (matches mxmlc)',
    r.dropped.includes('Unused'));
  c.check('a file in the per-file anonymous namespace is not cross-reachable',
    r.dropped.includes('Anon'));
  c.check('a file declaring two same-short-name classes keeps BOTH (global last-wins resolution)',
    r.kept.includes('A1') && r.kept.includes('A2'));
  c.check('the document class is a root',
    r.result.roots.includes('app.Main'));
  c.check('[WasmExport] is a root with no AS3 reference to it',
    r.result.roots.includes('wx.Wx') && r.kept.includes('Wx'));
  c.check('the closure walks edges (not just the roots)', r.result.edges > 0);
  return c.done();
}

// ---- one edge kind per target: delete the reference, the target must go -------
//
// These are the real soundness tests: each proves the class is retained BY that
// edge and by no other, so a walker that stops handling the node kind cannot pass
// by accident.
function checkAttribution(): string[] {
  const c = checker('reach-edge');
  const base = runClosure('p1');
  const baselineDropped = new Set(base.dropped);
  const cases: [string, string[]][] = [
    ['m-chain', ['A', 'B', 'Base']],        // import + `new` + `extends` + own package
    ['m-qualified', ['Q']],                 // `new pkg.Q()` — fully qualified
    ['m-wildcard', ['W']],                  // `import app.wild.*`
    ['m-vector', ['V']],                    // `Vector.<pkg.V>` element type
    ['m-is', ['Ix']],                       // `x is pkg.Ix`
    ['m-catch', ['Err']],                   // `catch (e:pkg.Err)`
    ['m-static', ['St']],                   // `St.run()` — a bare static member call
    ['m-impl', ['Impl', 'Iface']],          // `new Impl()` + `implements`
    ['m-paramsig', ['P', 'Ret']],           // parameter and return type annotations
    ['m-ambiguous', ['A1', 'A2']],          // the ambiguous short-name pair
  ];
  for (const [strip, expect] of cases) {
    const r = runClosure('p1', mainWithout(strip));
    const gone = base.kept.filter((n) => !r.kept.includes(n)).sort();
    c.check(`deleting the ${strip} reference drops exactly [${expect.join(' ')}]`,
      JSON.stringify(gone) === JSON.stringify([...expect].sort())
      && JSON.stringify(r.dropped) === JSON.stringify([...baselineDropped].concat(expect).sort()));
  }
  c.check('a strip that matches nothing changes no kept/dropped decision',
    JSON.stringify(runClosure('p1', mainWithout('m-nonexistent')).kept) === JSON.stringify(base.kept));
  // Roots are not edges: remove the metadata / the free function and the file drops.
  c.check('removing [WasmExport] drops the class it was the only root for',
    runClosure('p1', new Map([['wx/Wx.as', ['[WasmExport]\n  ', '']]])).dropped.includes('Wx'));
  c.check('removing the free function drops the file it was forcing',
    runClosure('p1', new Map([['mod/Mod.as', ['  function helper():int { return 1; }\n', '']]])).dropped.includes('Mod'));
  return c.done();
}

// ---- the AS3 §5.1 rewrite that prepareReachFiles shares with the build -------
function checkPrepare(): string[] {
  const c = checker('reach-prep');

  // A class with no `package` block at all gets a FILE-SCOPED package, so two
  // files can each declare `class Rectangle` without colliding with each other or
  // with flash.geom.Rectangle.
  const { srcDir, asFiles } = writeFixture('p3');
  const files = prepareReachFiles(asFiles, srcDir);
  const anon = files.find((f) => f.path.endsWith('Anon.as'));
  const decl = anon?.body[0];
  c.check('a packageless class is moved into a file-scoped package',
    decl?.kind === 'ClassDecl' && decl.packageName === 'anon_Anon' && decl.fileId === 'anon_Anon');
  c.check('...named after the path RELATIVE to src/, not the basename (so two same-named files differ)',
    decl?.kind === 'ClassDecl' && decl.packageName !== short(anon?.path ?? ''));
  c.check('...derived from the path RELATIVE to src/, not the basename',
    files.find((f) => f.path.endsWith(join('app', 'chain', 'A.as')))?.body[0]?.kind === 'ClassDecl'
    && (files.find((f) => f.path.endsWith(join('app', 'chain', 'A.as')))?.body[0] as { packageName?: string }).packageName === 'app.chain');

  // A bare `package { }` yields packageName '' — falsy but NOT null — so it keeps
  // its empty package (the away3d demos are written this way, and `--main-class
  // Basic_SkyBox` matches their FQN exactly because of it).
  mkdirSync(srcDir, { recursive: true });
  const bare = join(srcDir, 'Bare.as');
  writeFileSync(bare, 'package {\n  public class Bare { }\n}\n');
  const bareDecl = prepareReachFiles([bare], srcDir)[0]?.body[0];
  c.check("a bare `package { }` keeps its empty package ('' is not null)",
    bareDecl?.kind === 'ClassDecl' && bareDecl.packageName === '');

  // Same-file visibility: every same-file FQN is injected into each class's
  // imports, because `symbols.ts` makes a file's classes visible to each other
  // without an import.
  writeFileSync(join(srcDir, 'Pair.as'), 'package p {\n  public class One { }\n  public class Two { }\n}\n');
  const pair = prepareReachFiles([join(srcDir, 'Pair.as')], srcDir)[0];
  const one = pair?.body[0];
  c.check('same-file FQNs are injected into each class\'s imports',
    one?.kind === 'ClassDecl' && one.imports.includes('p.One') && one.imports.includes('p.Two'));
  return c.done();
}

// ---- the pruned program must still compile, and prune nothing it needs -------
function funcNames(cSource: string): Set<string> {
  const out = new Set<string>();
  const header = /^([A-Za-z_][^\n]*\))\s*\{\s*$/;
  for (const line of cSource.split('\n')) {
    if (!header.test(line)) continue;
    if (/^(struct |typedef|union |enum )/.test(line)) continue;
    const head = line.split('(')[0].trim().split(/\s+/);
    if (head.length > 0) out.add(head[head.length - 1]);
  }
  return out;
}

function checkEmit(): string[] {
  const c = checker('reach-emit');
  const { srcDir, asFiles } = writeFixture('p4');
  const files = prepareReachFiles(asFiles, srcDir);
  const result = computeReachable(files, 'app.Main');
  const keep = new Set(result.kept);

  const full = { body: files.flatMap((f) => f.body), imports: files.flatMap((f) => f.imports) };
  const pruned = {
    body: files.filter((f) => keep.has(f.path)).flatMap((f) => f.body),
    imports: files.filter((f) => keep.has(f.path)).flatMap((f) => f.imports),
  };

  const cFull = generateC(full).c;
  const cPruned = generateC(pruned).c;

  c.check('the pruned program still generates C (no CodegenError for a dropped type)',
    cPruned.length > 0);
  const fFull = funcNames(cFull);
  const fPruned = funcNames(cPruned);
  const onlyPruned = [...fPruned].filter((n) => !fFull.has(n));
  c.check('every function in the pruned C also exists in the whole-tree C',
    onlyPruned.length === 0);
  c.check('...and the pruned C is smaller', cPruned.length < cFull.length);
  c.check('a dropped class\'s code is absent from the pruned C but present in the full one',
    cFull.includes('other_Dead_new') && !cPruned.includes('other_Dead_new'));
  c.check('a kept class\'s code survives in the pruned C',
    cPruned.includes('app_chain_A_new'));
  return c.done();
}

// ---- the CLI wiring: the closure is what `--air-app` compiles -----------------
//
// Source-level pins, because the alternative (an end-to-end `--air-app` build of
// a 485-file tree) is not runnable in the suite. They state the shape a reader
// must find in index.ts, and the escape hatch that keeps the old face available.
function checkWiring(): string[] {
  const c = checker('reach-wire');
  const index = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
  const reach = readFileSync(join(root, 'src', 'reach.ts'), 'utf8');

  c.check('the --air-app branch prepares sources through reach.ts (one shared rewrite path)',
    /prepareReachFiles\(air\.asFiles, air\.sourceRoots\)/.test(index));
  c.check('...with the roots the adapter swept (src/ plus every --as-class-path)',
    /const sourceRoots = \[srcDir, \.\.\.classPaths\];/.test(
      readFileSync(join(root, 'src', 'air-app.ts'), 'utf8'))
    && /--as-class-path/.test(index));
  c.check('...and compiles the closure the adapter computed',
    /computeReachable\(parsedFiles, air\.mainClass, swcBaseRoots\)/.test(index));
  // The closure's extra roots: a symbol class whose SWC-declared base is a project
  // class must keep that class's source, or the binding (swc.ts) has nothing to bind
  // to and AIR would have linked the class while we dropped it.
  c.check('...seeding the closure with the SWC symbols\' project base classes',
    /const swcBaseRoots: string\[\] = \[\];/.test(index) &&
    /for \(const base of swcLib\(p\)\.bases\.values\(\)\)/.test(index) &&
    /base\.baseName\.length > 0 && !base\.baseName\.startsWith\('flash\.'\)/.test(index));
  c.check('...and parsing each SWC library exactly once (the cache both users share)',
    /const swcLibs = new Map<string, SwcLibrary>\(\)/.test(index) &&
    /const lib = swcLib\(libPath\);/.test(index) &&
    !/const lib = extractSwc\(libPath\);/.test(index));
  c.check('the closure is skipped only by the --all-sources escape hatch',
    /if \(!opts\.allSources\)/.test(index));

  const keptLoop = index.indexOf('for (const f of keptFiles)');
  const firstEmbed = index.indexOf('collectEmbeds(');
  c.check('embeds are collected from the KEPT files only (an unreachable [Embed] is not built)',
    keptLoop > 0 && firstEmbed > keptLoop);
  c.check('...and only the kept files\' bodies/imports reach the program',
    /program\.body\.push\(\.\.\.f\.body\)/.test(index) && /program\.imports\.push\(\.\.\.f\.imports\)/.test(index));
  c.check('the run reports how many sources survived the closure',
    /reachNote/.test(index) && /\$\{reachNote\}/.test(index));

  c.check('--all-sources is parsed', /a === '--all-sources'\) opts\.allSources = true/.test(index));
  c.check('--all-sources is documented in --help', index.includes('--all-sources'));
  c.check('--all-sources defaults to off, so the closure is the default face',
    /allSources: false/.test(index));

  const neverGuards = reach.match(/const _never: never =/g) ?? [];
  c.check('every AST switch in reach.ts is exhaustive-guarded (a new node fails the build here)',
    neverGuards.length >= 3);
  return c.done();
}

// ---- G13: a class entered through a FORCED file must still be expanded -------
//
// A file whose only top-level code is a free function cannot be pruned, so the
// closure forces it into the kept set. The classes it names used to be marked
// reachable and emitted WITHOUT being expanded, so their superclass and their own
// referenced classes were dropped and `--air-app` died in codegen with
// `unknown superclass 'Base' of 'p_Leaf'` -- a class name the author never wrote.
// That was G13; the fix (阶段二百四十九) seeds every forced file BEFORE the
// fixed-point loop and enqueues (rather than merely marking) what it finds.
//
// Both halves of the fix are pinned, because each is independently load-bearing:
//   G13_A  the forced file's NON-CLASS code names the class (pass ②)
//   G13_B  the class is DECLARED IN the forced file (pass ①)
// A mutation that reverts either half makes the probe in asaotui/ go red; these
// checks are what makes the compiler suite itself notice.
const G13_A: [string, string][] = [
  ['p/Main.as', `package p {
  public class Main {
    public function Main():void { make(); }
  }
}
`],
  // The forced file: its only top-level declaration is a free function. Keep the
  // signature free of class types too, so the ONLY edge to Leaf is the body.
  ['p/Fac.as', `package p {
  public function make():Leaf { return new Leaf(); }
}
`],
  // Leaf is reached from the forced file only, and hangs two different kinds of
  // reference off itself: a superclass and a plain `new`.
  ['p/Leaf.as', `package p {
  public class Leaf extends Base {
    public var tag:String;
    public function Leaf():void {
      super();
      var h:Helper = new Helper();
      this.tag = h.suffix;
    }
  }
}
`],
  ['p/Base.as', `package p {
  public class Base {
    public var kind:String;
    public function Base():void { this.kind = "base"; }
  }
}
`],
  ['p/Helper.as', `package p {
  public class Helper {
    public var suffix:String;
    public function Helper():void { this.suffix = "!"; }
  }
}
`],
];

// The `Ui extends Control` shape the real UI kit produced: the subclass is
// DECLARED IN the forced file, so it is the class-declaration pass that has to
// expand it. Nothing else names Control.
const G13_B: [string, string][] = [
  ['p/Main.as', `package p {
  public class Main {
    public function Main():void { makeUi(); }
  }
}
`],
  ['p/Ui.as', `package p {
  public class Ui extends Control {
    public function Ui():void { super(); }
  }
  public function makeUi():Ui { return new Ui(); }
}
`],
  ['p/Control.as', `package p {
  public class Control {
    public function Control():void { }
  }
}
`],
];

// Write a synthetic tree, optionally applying one replacement to one file, and
// return the closure's kept/dropped short names.
function runSynthetic(dirName: string, fixture: [string, string][], edit?: [string, string, string]): { kept: string[]; dropped: string[] } {
  const dir = join(FIXTURE_ROOT, dirName);
  rmSync(dir, { recursive: true, force: true });
  const srcDir = join(dir, 'src');
  const paths: string[] = [];
  for (const [rel, source] of fixture) {
    const p = join(srcDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    const text = edit !== undefined && edit[0] === rel ? source.replace(edit[1], edit[2]) : source;
    if (edit !== undefined && edit[0] === rel && text === source) throw new Error('G13 fixture edit did not apply: ' + edit[1]);
    writeFileSync(p, text);
    paths.push(p);
  }
  const result = computeReachable(prepareReachFiles(paths, srcDir), 'p.Main');
  return { kept: result.kept.map(short).sort(), dropped: result.dropped.map(short).sort() };
}

function checkForcedFileExpansion(): string[] {
  const c = checker('reach-forced');

  // A: the forced file's non-class code names Leaf -> Leaf, its superclass and its
  // constructor's `new Helper()` must all be kept.
  const a = runSynthetic('g13a', G13_A);
  c.check('a class named only from a forced file is kept',
    a.kept.includes('Leaf'));
  c.check('...and so is its SUPERCLASS (was: `unknown superclass Base`)',
    a.kept.includes('Base'));
  c.check('...and the class its constructor instantiates',
    a.kept.includes('Helper'));
  c.check('the A fixture drops nothing', a.dropped.length === 0);
  c.check('the A fixture keeps exactly Main, Fac, Leaf, Base, Helper',
    JSON.stringify(a.kept) === JSON.stringify(['Base', 'Fac', 'Helper', 'Leaf', 'Main']));

  // Attribution: the edge really comes from the forced file's BODY. Dropping the
  // reference (signature and body together, so no other edge survives) must drop
  // exactly Leaf + Base + Helper, while Fac stays forced.
  const aGone = runSynthetic('g13a', G13_A,
    ['p/Fac.as', 'public function make():Leaf { return new Leaf(); }', 'public function make():Object { return null; }']);
  c.check('deleting the forced file\'s reference drops exactly [Leaf Base Helper]',
    JSON.stringify(aGone.kept) === JSON.stringify(['Fac', 'Main'])
    && JSON.stringify(aGone.dropped) === JSON.stringify(['Base', 'Helper', 'Leaf']));

  // B: the class is DECLARED IN the forced file, so it is the class-declaration
  // pass that must enqueue (and therefore expand) it.
  const b = runSynthetic('g13b', G13_B);
  c.check('a class declared in a forced file has its SUPERCLASS kept (the real kit shape)',
    b.kept.includes('Ui') && b.kept.includes('Control'));
  c.check('the B fixture drops nothing', b.dropped.length === 0);
  const bGone = runSynthetic('g13b', G13_B,
    ['p/Ui.as', 'public class Ui extends Control {', 'public class Ui {']);
  c.check('...and that superclass is dropped once the `extends` is gone (attribution)',
    bGone.dropped.includes('Control'));
  return c.done();
}

// ---------------------------------------------------------------------------
// --as-class-path: source roots beyond the app's src/ (阶段二百五十)
// ---------------------------------------------------------------------------
//
// A library shared by several apps has to live OUTSIDE each of them (three demos
// each carrying a byte-identical copy of the UI kit is what motivated this), so the
// compiler must compile from more than one root. Two things can go silently wrong,
// and both are pinned here:
//
//   * a file's identity is its path relative to ITS OWN root, so the same kit gets
//     the same anonymous-namespace key (and the same C symbols) whichever app builds
//     it — and two files that would land on one id still stay distinct;
//   * the same FQN declared under two roots is a HARD ERROR, not walk-order
//     last-wins. That is the migration trap: adding the shared root while src/ still
//     holds a copy.
const MULTI: [string, string][] = [
  ['src/app/Main.as', `package app {
  import kit.Widget;
  public class Main {
    public function Main():void { trace(new Widget().name()); }
  }
}
`],
  ['src/app/Dead.as', `package app {
  public class Dead { public function Dead():void { } }
}
`],
  ['kit/Widget.as', `package kit {
  public class Widget {
    public function name():String { return "widget"; }
  }
}
`],
  ['kit/Unused.as', `package kit {
  public class Unused { public function Unused():void { } }
}
`],
  // The SAME packageless relative path under both roots: their file-scoped
  // anonymous namespaces must not merge into one class.
  ['src/Control.as', `class Control { public function Control():void { } }
`],
  ['kit/Control.as', `class Control { public function Control():void { } }
`],
];

interface MultiTree { dir: string; srcDir: string; kitDir: string; paths: string[] }

function writeMulti(dirName: string, extra: [string, string][] = []): MultiTree {
  const dir = join(FIXTURE_ROOT, dirName);
  rmSync(dir, { recursive: true, force: true });
  const paths: string[] = [];
  for (const [rel, source] of [...MULTI, ...extra]) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, source);
    paths.push(p);
  }
  return { dir, srcDir: join(dir, 'src'), kitDir: join(dir, 'kit'), paths };
}

const declFileId = (f: { body: unknown[] } | undefined): string | undefined => {
  const d = f?.body[0] as { fileId?: string | null } | undefined;
  return d?.fileId ?? undefined;
};
const declPkg = (f: { body: unknown[] } | undefined): string | null | undefined => {
  const d = f?.body[0] as { packageName?: string | null } | undefined;
  return d?.packageName;
};

function checkAsClassPath(): string[] {
  const c = checker('reach-roots');

  const t = writeMulti('multi');
  const files = prepareReachFiles(t.paths, [t.srcDir, t.kitDir]);
  const byName = (n: string): (typeof files)[number] | undefined => files.find((f) => f.path.endsWith(n));

  c.check('a file under the second root is identified relative to THAT root (`<kit>/Widget.as` -> `Widget`)',
    declFileId(byName('Widget.as')) === 'Widget');
  c.check('...and a file under src/ is still identified relative to src/ (`app/Main.as` -> `app_Main`)',
    declFileId(byName('Main.as')) === 'app_Main');
  c.check('a kit file is NOT named `.._kit_Widget` (the root is matched, not string-concatenated)',
    !(declFileId(byName('Widget.as')) ?? '').includes('..'));

  // Two packageless files at the same relative path must not share one anonymous
  // namespace: AS3's per-file namespace would otherwise collapse them into ONE class.
  const controls = files.filter((f) => f.path.endsWith('Control.as'));
  const ids = controls.map((f) => declFileId(f) ?? '');
  c.check('two packageless `Control.as` under different roots get DISTINCT file ids',
    controls.length === 2 && new Set(ids).size === 2);
  c.check('...and therefore distinct anonymous package names',
    new Set(controls.map((f) => declPkg(f) ?? '')).size === 2);
  c.check('the first root keeps the plain id (`Control`), the later one is suffixed',
    ids.includes('Control') && ids.some((i) => i.startsWith('Control_')));

  // Root ORDER must not change identities: the root a file belongs to is the
  // deepest match, not the first one tried.
  const reversed = prepareReachFiles(t.paths, [t.kitDir, t.srcDir]);
  c.check('identities do not depend on the order the roots are named in',
    JSON.stringify(reversed.map((f) => [(f.body[0] as { fileId?: string }).fileId])) ===
    JSON.stringify(files.map((f) => [(f.body[0] as { fileId?: string }).fileId])));

  // A root NESTED inside another: the DEEPEST root names the file, so `src/` plus
  // `src/app/` behaves like a reader expects. A "first matching root" implementation
  // (or one that string-prefixes instead of using `relative`) names it `app_Main`.
  const inner = join(t.srcDir, 'app');
  // (only the files under those two roots: the kit is a third root and would be rejected,
  //  which is itself the next check)
  const nested = prepareReachFiles(t.paths.filter((p) => p.startsWith(t.srcDir)), [t.srcDir, inner]);
  c.check('a root nested inside another: the DEEPEST root names the file (`app/Main.as` -> `Main`)',
    declFileId(nested.find((f) => f.path.endsWith(join('app', 'Main.as')))) === 'Main');

  // The closure itself works across roots: the kit class Main imports is kept, the
  // unused kit class is dropped exactly like an unused src/ class.
  const r = computeReachable(files, 'app.Main');
  c.check('a class reached across roots is kept', r.kept.map(short).includes('Widget'));
  c.check('an unreachable class in the shared root is dropped like any other',
    r.dropped.map(short).includes('Unused'));

  // Cross-root duplicate FQN: hard error, naming both files.
  const dup = writeMulti('multi-dup', [
    ['kit/app/Dead.as', `package app {
  public class Dead { public function Dead():void { } }
}
`],
  ]);
  const threw = ((): string => {
    try { prepareReachFiles(dup.paths, [dup.srcDir, dup.kitDir]); return ''; }
    catch (e) { return e instanceof Error ? e.message : String(e); }
  })();
  c.check('the same FQN under two roots is a hard error',
    /the same class is declared under two source roots: 'app\.Dead'/.test(threw));
  c.check('...naming BOTH files (the stale copy is what a migration must delete)',
    threw.includes('src/app/Dead.as') && threw.includes('kit/app/Dead.as'));
  c.check('...and pointing at --as-class-path as the cause',
    threw.includes('--as-class-path'));

  // The rule stops at the root boundary: two files in the SAME root colliding is
  // pre-existing last-wins behaviour (symbols.ts), and refusing it here would break
  // trees that build today.
  const same = writeMulti('multi-same', [
    ['src/dup1/Same.as', `package s { public class Same { public function Same():void { } } }
`],
    ['src/dup2/Same.as', `package s { public class Same { public function Same():void { } } }
`],
  ]);
  let sameThrew = '';
  try { prepareReachFiles(same.paths, [same.srcDir, same.kitDir]); } catch (e) { sameThrew = String(e); }
  c.check('two same-FQN files inside ONE root keep last-wins (unchanged behaviour)',
    sameThrew === '');
  return c.done();
}

// ---- the CLI end to end: the flag is what makes the shared root compile ------
//
// The shipped tree's demos live outside this repo (asaotui/ui-demo), so the only
// way for `node test.ts` to notice a broken flag is to build a tiny app here. `--dry`
// still runs the whole frontend (parse -> reach -> codegen -> emit) and writes the
// `.c`; only the C compiler invocation is skipped.
function checkAsClassPathCli(): string[] {
  const c = checker('reach-cp-cli');
  const base = join(root, 'temp', 'reachunit', 'cp-cli');
  rmSync(base, { recursive: true, force: true });
  const xml = (name: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<application xmlns="http://ns.adobe.com/air/application/51.0">\n` +
    `  <id>com.example.${name}</id>\n  <filename>${name}</filename>\n` +
    `  <initialWindow><content>main.swf</content><visible>true</visible>` +
    `<width>200</width><height>200</height></initialWindow>\n</application>\n`;

  const appDir = join(base, 'app');
  const kitDir = join(base, 'kit');
  mkdirSync(join(appDir, 'src'), { recursive: true });
  mkdirSync(kitDir, { recursive: true });
  writeFileSync(join(appDir, 'cp-app.xml'), xml('cp'));
  writeFileSync(join(appDir, 'src', 'Main.as'),
    'package {\n  import flash.display.Sprite;\n  import kit.Widget;\n' +
    '  public class Main extends Sprite {\n' +
    '    public function Main() { trace(new Widget().name()); }\n  }\n}\n');
  writeFileSync(join(kitDir, 'Widget.as'),
    'package kit {\n  public class Widget {\n    public function name():String { return "widget"; }\n  }\n}\n');

  const run = (args: string[]): { ok: boolean; out: string } => {
    try {
      const out = execFileSync('node', ['src/index.ts', '--air-app', join(appDir, 'cp-app.xml'), ...args, '--dry'],
        { cwd: root, stdio: 'pipe', encoding: 'utf8', timeout: 240_000 }) as string;
      return { ok: true, out };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };

  // Without the flag the kit class is simply absent -> a LOUD unknown type, not a
  // silently smaller program.
  const bare = run([]);
  c.check('without --as-class-path the app does not build (the class is absent, loudly)',
    !bare.ok && /Widget/.test(bare.out));

  const withRoot = run(['--as-class-path', kitDir]);
  c.check('--as-class-path <dir> compiles the app against the shared root', withRoot.ok);
  const emitted = existsSync(join(appDir, 'cp.c')) ? readFileSync(join(appDir, 'cp.c'), 'utf8') : '';
  c.check('...and the shared root\'s class is really in the emitted C', emitted.includes('kit_Widget'));

  // The flag names a ROOT; an individual .as file is a different thing.
  const asFile = run(['--as-class-path', join(kitDir, 'Widget.as')]);
  c.check('a .as FILE is refused as a root, by name',
    !asFile.ok && /--as-class-path is not a directory/.test(asFile.out));

  // Without a descriptor there is no closure to widen, so the flag is refused
  // instead of being accepted and doing nothing.
  const noAir = ((): { ok: boolean; out: string } => {
    try {
      const out = execFileSync('node', ['src/index.ts', 'examples/hello.as', '--as-class-path', kitDir, '--dry'],
        { cwd: root, stdio: 'pipe', encoding: 'utf8', timeout: 240_000 }) as string;
      return { ok: true, out };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  })();
  c.check('--as-class-path without --air-app is refused (no closure to widen)',
    !noAir.ok && /--as-class-path only applies to --air-app/.test(noAir.out));
  return c.done();
}

registerGroup('unit: reach/closure', checkClosure);
registerGroup('unit: reach/edge', checkAttribution);
registerGroup('unit: reach/prepare', checkPrepare);
registerGroup('unit: reach/emit', checkEmit);
registerGroup('unit: reach/wiring', checkWiring);
registerGroup('unit: reach/as-class-path', checkAsClassPath);
registerGroup('unit: reach/as-class-path-cli', checkAsClassPathCli);
registerGroup('unit: reach/forced', checkForcedFileExpansion);