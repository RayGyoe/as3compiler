// reach.ts — main-class reachability closure for the `--air-app` adapter.
//
// Why this exists
// ---------------
// AIR's own build face is the TRANSITIVE CLASS CLOSURE from the document class:
// `mxmlc`'s linker walks references and silently drops everything else (measured
// with `-link-report` on the six away3d demos — 158/162/171/171/175/246 classes
// each, while `src/` holds 485 `.as` files; 198 of those files are reached by NO
// demo). `--air-app` used to compile the whole `src/` tree instead, which
// over-approximates AIR by ~2.8x and has two visible consequences:
//
//   1. every `[Embed]` in every file becomes an asset, so a demo's binary embeds
//      the other demos' textures/models (measured: `Basic_SkyBox` embeds 40
//      assets / 4.97 MB of which 4.32 MB belongs to other demos) and the
//      generated `.c` is 31 MB, 38% of it asset bytes;
//   2. a broken/absent `[Embed]` in a class the app never reaches fails the BUILD,
//      where `adl` builds and runs fine — a narrow fidelity gap (AGENTS.md §1.5).
//
// So the closure is not an enhancement: it is how we stop over-approximating the
// reference behaviour AIR already has. `--all-sources` restores the old
// whole-`src/` face for anyone who needs it.
//
// What is (deliberately) NOT here
// -------------------------------
// The class REGISTRY (`as_class_registry`) is left alone, and so is the
// unconditional `as_amf_wire()` hook in `main()` that keeps it alive (and with it
// every class object, vtable and embed factory). That is the point of gating the
// *emission* face rather than trying to prune at link time: the registry stays
// eager over whatever set we emit, so `is Class`, `new x()`, AMF typed decode and
// the GC root all keep working. Feeding it fewer classes is the whole fix.
//
// Soundness
// ---------
// The closure must be a SUPERSET of `mxmlc`'s, otherwise pruning would introduce
// a *new* fidelity gap. Two mechanisms keep it that way:
//
//   * resolution over-approximates on purpose — an unresolved short name maps to
//     EVERY class carrying that short name (`typeAlias` in symbols.ts is a global
//     last-wins table, so any of them could be the one codegen picks), and
//     `Vector.<T>` element types, catch types, `is`/`as` targets and every bare
//     identifier are all followed, not just the "obvious" `new X` sites;
//   * every AST node kind is walked through an exhaustive switch with a `never`
//     guard, so adding a node to ast.ts fails the build here until the walker
//     learns it (AGENTS.md §2.2's data-first rule, applied to this walker).
//
// Anything the walker still misses shows up as a hard `CodegenError` ("unknown
// type") rather than a silent miscompile — loud, per §2.5.
//
// A file is kept when a reachable class lives in it, or when it carries
// top-level statements that are not class/interface declarations (module
// statements and free functions are emitted for the whole program, so they
// cannot be pruned per class). In the away3d tree that pins exactly one file
// (`away3d/debug/Debug.as`).

import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { parse } from './parser.ts';
import type { ASType, ClassMember, Expr, Metadata, Param, Stmt } from './ast.ts';

// One parsed source file: its on-disk path, the top-level statements the
// `--air-app` loop produced for it (already rewritten by the caller so
// anonymous-namespace classes carry their file-scoped package name), and the
// module-level imports to append to the program when the file survives.
export interface ReachFile {
  path: string;
  body: Stmt[];
  imports: string[];
  // `[SWF(frameRate = N)]` declared in this file (阶段一百四十八). The compile face
  // carries it out of the parse so index.ts can hand the document class's value to
  // codegen -- the frame rate is the one [SWF] key an AOT build must honour.
  swfFrameRate?: number;
}

export interface ReachResult {
  // Paths of the files to compile, in input order.
  kept: string[];
  // Paths that were dropped (for reporting).
  dropped: string[];
  // AS3 FQNs of the classes/interfaces the closure started from.
  roots: string[];
  // Number of class-to-class reference edges followed (diagnostics).
  edges: number;
}

// AS3 FQN of a top-level declaration, in the same shape the rest of the compiler
// uses for keys: `package.Name`, or just `Name` when the file has no package
// (the caller has already turned that case into a file-scoped package).
function fqnOf(name: string, pkg: string | null): string {
  return pkg ? `${pkg}.${name}` : name;
}

function shortOf(fqn: string): string {
  const dot = fqn.lastIndexOf('.');
  return dot >= 0 ? fqn.slice(dot + 1) : fqn;
}

function pkgOf(fqn: string): string | null {
  const dot = fqn.lastIndexOf('.');
  return dot >= 0 ? fqn.slice(0, dot) : null;
}

// Decompose a type annotation into the bare class names it mentions.
// `Vector.<T>` nests (`Vector.<Vector.<Mesh>>`), and the element can itself be
// package-qualified (`Vector.<flash.geom.Vector3D>`), so this recurses rather
// than stripping one prefix.
function typeNames(t: ASType | null, out: Set<string>): void {
  if (!t) return;
  if (t.startsWith('Vector.<') && t.endsWith('>')) {
    typeNames(t.slice('Vector.<'.length, -1) as ASType, out);
    return;
  }
  out.add(t);
}

// Scalar / structural types that never name a user class. Purely an
// optimisation: resolution would find nothing for them anyway, so a name that
// happens to collide with a user class is still followed.
const NON_CLASS_TYPES = new Set([
  'int', 'uint', 'int64', 'uint64', 'Number', 'Boolean', 'String', 'void',
  'Array', 'Function', 'Class', 'Object', 'Dictionary', 'XML', 'XMLList', 'any',
]);

// Collects the two kinds of reference the closure needs from a reachable class:
// type annotations (`types`) and identifier uses that could name a class
// (`names` — a static access `Foo.bar` and `new Foo()` both arrive as a bare
// `Var`, so they are indistinguishable from a local at this level and are
// over-approximated together).
class RefCollector {
  readonly types = new Set<string>();
  readonly names = new Set<string>();

  members(ms: ClassMember[]): void {
    for (const m of ms) this.member(m);
  }

  member(m: ClassMember): void {
    switch (m.kind) {
      case 'Field':
        typeNames(m.type, this.types);
        if (m.init) this.expr(m.init);
        return;
      case 'Method':
        typeNames(m.returnType, this.types);
        this.params(m.params);
        this.block(m.body);
        return;
      case 'Constructor':
        this.params(m.params);
        this.block(m.body);
        return;
      case 'StaticInit':
        this.block(m.body);
        return;
      default: {
        const _never: never = m;
        throw new Error(`reach: unhandled class member ${JSON.stringify(_never)}`);
      }
    }
  }

  params(ps: Param[]): void {
    for (const p of ps) {
      typeNames(p.type, this.types);
      if (p.defaultValue) this.expr(p.defaultValue);
    }
  }

  block(b: { body: Stmt[] }): void {
    for (const s of b.body) this.stmt(s);
  }

  stmt(s: Stmt): void {
    switch (s.kind) {
      case 'VarDecl':
      case 'ConstDecl':
        typeNames(s.type, this.types);
        if (s.init) this.expr(s.init);
        return;
      case 'VarDecls':
      case 'ConstDecls':
        for (const d of s.decls) {
          typeNames(d.type, this.types);
          if (d.init) this.expr(d.init);
        }
        return;
      case 'ExprStmt':
        this.expr(s.expr);
        return;
      case 'Block':
        this.block(s);
        return;
      case 'If':
        this.expr(s.cond);
        this.stmt(s.then);
        if (s.else) this.stmt(s.else);
        return;
      case 'While':
      case 'DoWhile':
        this.expr(s.cond);
        this.stmt(s.body);
        return;
      case 'For':
        if (s.init) this.stmt(s.init);
        if (s.cond) this.expr(s.cond);
        if (s.update) this.expr(s.update);
        this.stmt(s.body);
        return;
      case 'ForIn':
        this.expr(s.iterable);
        this.stmt(s.body);
        return;
      case 'ForEachIn':
        typeNames(s.varType, this.types);
        this.expr(s.iterable);
        this.stmt(s.body);
        return;
      case 'Switch':
        this.expr(s.disc);
        for (const c of s.cases) {
          if (c.test) this.expr(c.test);
          for (const st of c.body) this.stmt(st);
        }
        return;
      case 'Break':
      case 'Continue':
        return;
      case 'Label':
        this.stmt(s.body);
        return;
      case 'Return':
        if (s.value) this.expr(s.value);
        return;
      case 'SuperCall':
        for (const a of s.args) this.expr(a);
        return;
      case 'Throw':
        this.expr(s.value);
        return;
      case 'Try':
        this.block(s.tryBody);
        for (const c of s.catches) {
          // A catch clause TYPES the exception, so it names a class.
          typeNames(c.type, this.types);
          this.block(c.body);
        }
        if (s.finallyBody) this.block(s.finallyBody);
        return;
      case 'With':
        this.expr(s.obj);
        this.stmt(s.body);
        return;
      case 'FuncDecl':
        // A nested function declaration: its signature and body are part of the
        // enclosing class's reachable code.
        typeNames(s.returnType, this.types);
        this.params(s.params);
        this.block(s.body);
        return;
      case 'ClassDecl':
        this.classDecl(s);
        return;
      case 'InterfaceDecl':
        for (const e of s.extendsList) this.types.add(e);
        for (const m of s.methods) {
          typeNames(m.returnType, this.types);
          this.params(m.params);
        }
        return;
      default: {
        const _never: never = s;
        throw new Error(`reach: unhandled statement ${JSON.stringify(_never)}`);
      }
    }
  }

  classDecl(c: Extract<Stmt, { kind: 'ClassDecl' }>): void {
    if (c.superClass) this.types.add(c.superClass);
    for (const i of c.implements) this.types.add(i);
    this.members(c.members);
  }

  expr(e: Expr): void {
    switch (e.kind) {
      case 'Num':
      case 'Str':
      case 'Bool':
      case 'Null':
      case 'RegExp':
      case 'XmlLit':
        return;
      case 'Var':
        // Could be a local, a parameter, `this`, or a class used as a value
        // (`Foo.bar`, `new Foo()`, `Foo` passed as a Class). Resolution decides.
        this.names.add(e.name);
        return;
      case 'Binary':
      case 'NullCoalesce':
      case 'Comma':
        this.expr(e.left);
        this.expr(e.right);
        return;
      case 'Unary':
      case 'Typeof':
        this.expr(e.operand);
        return;
      case 'Delete':
        this.expr(e.target);
        return;
      case 'Conditional':
        this.expr(e.cond);
        this.expr(e.then);
        this.expr(e.else);
        return;
      case 'Update':
        this.expr(e.target);
        return;
      case 'Assign':
        this.expr(e.target);
        this.expr(e.value);
        return;
      case 'Call':
        this.expr(e.callee);
        for (const a of e.args) this.expr(a);
        return;
      case 'Member':
        this.expr(e.object);
        return;
      case 'AttrAccess':
        this.expr(e.object);
        return;
      case 'E4xName':
        this.expr(e.object);
        this.expr(e.index);
        return;
      case 'Filter':
        this.expr(e.object);
        this.expr(e.value);
        return;
      case 'SuperMethod':
        for (const a of e.args) this.expr(a);
        return;
      case 'SuperProperty':
        return;
      case 'Is':
      case 'As':
        this.expr(e.obj);
        // `x is Foo` / `x as Foo` name a class (or a `Vector.<T>`).
        typeNames(e.typeName, this.types);
        return;
      case 'In':
        this.expr(e.key);
        this.expr(e.object);
        return;
      case 'New':
        // `new Foo.Bar()` arrives qualified; the bare/`Vector.<T>` forms arrive
        // short. Either way it is a type reference.
        typeNames(e.className, this.types);
        for (const a of e.args) this.expr(a);
        return;
      case 'NewDynamic':
        this.expr(e.classExpr);
        for (const a of e.args) this.expr(a);
        return;
      case 'ArrayLit':
        for (const el of e.elements) this.expr(el);
        return;
      case 'VectorLit':
        typeNames(e.elem, this.types);
        for (const el of e.elements) this.expr(el);
        return;
      case 'VectorCoerce':
        typeNames(e.elem, this.types);
        for (const a of e.args) this.expr(a);
        return;
      case 'Index':
        this.expr(e.object);
        this.expr(e.index);
        return;
      case 'ObjectLit':
        for (const f of e.fields) this.expr(f.value);
        return;
      case 'FunctionExpr':
        typeNames(e.returnType, this.types);
        this.params(e.params);
        this.block(e.body);
        return;
      case 'Descendants':
        this.expr(e.object);
        return;
      default: {
        const _never: never = e;
        throw new Error(`reach: unhandled expression ${JSON.stringify(_never)}`);
      }
    }
  }
}

// Per-class resolution context: the imports the class was parsed with (which the
// caller has already extended with its same-file siblings' FQNs) and its own
// package, so a same-package type resolves without an import exactly as it does
// in symbols.ts.
interface ResolveCtx {
  file: string;
  ownPkg: string | null;
  imports: string[];
}

// One top-level declaration, indexed for resolution.
interface Decl {
  fqn: string;
  short: string;
  pkg: string | null;
  file: string;
  stmt: Stmt;
}

function hasWasmExport(md: Metadata[] | undefined): boolean {
  return (md ?? []).some((m) => m.name === 'WasmExport');
}

// Compute the set of files to compile for `mainClassFqn`.
//
// Files carrying module-level statements or free functions are always kept: they
// are emitted for the whole program regardless of which class reached them.
//
// `extraRoots` are additional FQNs that must stay in the closure even though no AS3
// source references them: an SWC symbol class whose `DoABC` base is a class the
// project compiles from source (the combo boxes extending
// `com.example.controls.ComBoBox`) is one — the library links the symbol to that
// class, so AIR's linker keeps it and ours must too (index.ts feeds the SWC bases in).
export function computeReachable(files: ReachFile[], mainClassFqn: string, extraRoots: readonly string[] = []): ReachResult {
  const decls: Decl[] = [];
  const byFqn = new Map<string, Decl>();
  const byShort = new Map<string, Decl[]>();
  const declsByFile = new Map<string, Decl[]>();
  const fileImports = new Map<string, string[]>();

  for (const f of files) {
    const own: Decl[] = [];
    for (const s of f.body) {
      if (s.kind !== 'ClassDecl' && s.kind !== 'InterfaceDecl') continue;
      const d: Decl = {
        fqn: fqnOf(s.name, s.packageName),
        short: s.name,
        pkg: s.packageName,
        file: f.path,
        stmt: s,
      };
      decls.push(d);
      own.push(d);
      byFqn.set(d.fqn, d);
      const list = byShort.get(d.short);
      if (list) list.push(d);
      else byShort.set(d.short, [d]);
      const imp = fileImports.get(f.path);
      if (imp) imp.push(...s.imports);
      else fileImports.set(f.path, [...s.imports]);
    }
    declsByFile.set(f.path, own);
  }

  // Roots: the document class, plus anything the source itself marks as an entry
  // point (`[WasmExport]` is how a class is deliberately reachable from JS with
  // no AS3 reference), plus every file that carries non-class top-level code
  // (module statements / free functions — emitted unconditionally).
  // The document class as written on `--main-class` is a FQN for a packaged
  // class, but a BARE name for one in the default package — and the caller has
  // turned the latter's `packageName` into the file id, so the decl's FQN is
  // `<FileId>.<Name>`. Resolve in that order (exact FQN, then the file-scoped
  // form, then a unique short name) so `--main-class Basic_SkyBox` still finds
  // `Basic_SkyBox.Basic_SkyBox`.
  // The file-scoped package a packageless class was moved into. `prepareReachFiles`
  // assigned it relative to the class's OWN source root, so with --as-class-path
  // there is no single "relative to src/" left to recompute it from -- read it off
  // the declaration. The basename form is the fallback for decls built by hand.
  const fileScopedId = (d: Decl): string => {
    const st = d.stmt as { fileId?: string | null };
    if (typeof st.fileId === 'string' && st.fileId !== '') return st.fileId;
    return (d.file.split(/[\\/]/).pop() ?? d.file).replace(/\.as$/i, '').replace(/[^A-Za-z0-9_]/g, '_');
  };
  const findMainDecl = (name: string): Decl | undefined => {
    const exact = byFqn.get(name);
    if (exact) return exact;
    const cands = byShort.get(shortOf(name)) ?? [];
    if (cands.length <= 1) return cands[0];
    const fileScoped = cands.find((d) => d.pkg !== null && d.pkg === fileScopedId(d));
    return fileScoped ?? cands[0];
  };

  const roots = new Set<string>();
  const mainDecl = findMainDecl(mainClassFqn);
  if (!mainDecl) {
    throw new Error(
      `cannot compute the reachability closure: main class '${mainClassFqn}' is not declared under src/`
    );
  }
  roots.add(mainDecl.fqn);
  for (const r of extraRoots) {
    const d = byFqn.get(r);
    // A base class the project does not declare (a library-only class) cannot be
    // added: the SWC emitter reports that case on its own, so silence here is right.
    if (d !== undefined) roots.add(d.fqn);
  }
  const forced = new Set<string>();
  for (const f of files) {
    let pins = false;
    for (const s of f.body) {
      if (s.kind === 'ClassDecl' || s.kind === 'InterfaceDecl') {
        if (s.kind === 'ClassDecl') {
          if (hasWasmExport(s.metadata)) roots.add(fqnOf(s.name, s.packageName));
          for (const m of s.members) {
            if (m.kind === 'Method' && hasWasmExport(m.metadata) && m.isStatic) {
              roots.add(fqnOf(s.name, s.packageName));
            }
          }
        }
        continue;
      }
      // A top-level function or module statement: this file cannot be pruned.
      pins = true;
    }
    if (pins) forced.add(f.path);
  }

  // Resolve one name as seen from `ctx` into every class it could denote. The
  // import / same-package steps mirror symbols.ts's `resolveType` +
  // `buildImportAlias`.
  //
  // The global short-name step is the delicate one. Codegen's `resolveType`
  // consults the per-class import alias FIRST and only falls back to the
  // program-wide last-wins `typeAlias` table when NO import matched
  // (`importAlias?.get(t) ?? typeAlias.get(t)`). So:
  //   * an import DID resolve the name -> codegen uses that import and the global
  //     candidates are dead code for this reference -> follow ONLY the import.
  //     Following the global set here is what dragged mxmlc-Invisible third-party
  //     trees into a real app: `cn.edoctor...RWebSocket` imports the ANE stub
  //     `com.vsdevelop.air.extension.websocket.WebSocket`, yet the old "all
  //     candidates" rule also pulled in `com.worlize.websocket.WebSocket` (and
  //     with it hurlant's whole TLS/DER stack, whose `class Sequence extends
  //     Array` this subset cannot compile) even though AIR never keeps it.
  //   * nothing resolved it -> codegen falls back to `typeAlias`, a last-wins
  //     table over the EMITTED set, so any candidate could be the winner -> keep
  //     them all (the original over-approximation).
  const resolveInto = (name: string, ctx: ResolveCtx, out: Set<string>): void => {
    if (name.includes('.')) {
      // Already qualified: `flash.display3D.textures.Texture`, or a user FQN.
      // Only an exact user-class hit matters; built-ins live in symbols.ts.
      if (byFqn.has(name)) out.add(name);
      else {
        const short = shortOf(name);
        for (const d of byShort.get(short) ?? []) if (d.fqn === name) out.add(d.fqn);
      }
      return;
    }
    if (NON_CLASS_TYPES.has(name)) return;
    // Did an import (or a same-file name, which the caller turned into an import)
    // resolve this name? If so codegen is precise here and the global fallback
    // below must not run.
    let precise = false;
    // Same file (its classes are visible to each other without an import, and the
    // caller injected their FQNs into this class's import list).
    for (const d of declsByFile.get(ctx.file) ?? []) if (d.short === name) { out.add(d.fqn); precise = true; }
    // Explicit imports.
    for (const imp of ctx.imports) {
      if (imp.endsWith('.*')) continue;
      if (shortOf(imp) === name && byFqn.has(imp)) { out.add(imp); precise = true; }
    }
    // Wildcard imports.
    for (const imp of ctx.imports) {
      if (!imp.endsWith('.*')) continue;
      const pkg = imp.slice(0, -2);
      for (const d of byShort.get(name) ?? []) if (d.pkg === pkg) { out.add(d.fqn); precise = true; }
    }
    // Own package. NB: codegen has no own-package rule (a same-package reference
    // without an import falls through to the global table), so this does NOT set
    // `precise` — the global candidates below stay in play.
    if (ctx.ownPkg) {
      const cand = `${ctx.ownPkg}.${name}`;
      if (byFqn.has(cand)) out.add(cand);
    }
    // Global short-name table: only when nothing above resolved (see the note).
    if (!precise) for (const d of byShort.get(name) ?? []) out.add(d.fqn);
  };

  const reachable = new Set<string>();
  const queue: string[] = [];
  const enqueue = (fqn: string): void => {
    if (reachable.has(fqn)) return;
    reachable.add(fqn);
    queue.push(fqn);
  };
  for (const r of roots) enqueue(r);

  let edges = 0;

  // Every seed must be in the queue BEFORE the fixed-point loop runs, otherwise
  // the classes seeded below are marked reachable but their own references are
  // never followed. That was the G13 defect: these two passes used to sit AFTER
  // the `while` above, so a class whose ONLY entry point is a forced file (a
  // free-function factory, or a module-level statement) got emitted while its
  // superclass / referenced classes were pruned -- `unknown superclass 'Control'`
  // for a class the author never wrote. `--all-sources` masked it by disabling
  // pruning entirely.
  //
  // A forced file is kept whole, so every class it declares is kept with it.
  for (const f of files) {
    if (!forced.has(f.path)) continue;
    for (const d of declsByFile.get(f.path) ?? []) if (!reachable.has(d.fqn)) enqueue(d.fqn);
  }

  // The forced files' non-class code too: a module statement or free function
  // can reference classes of its own, and it is emitted either way. These are
  // real reference edges (not whole-file pinning), so they count and they must
  // be ENQUEUED -- marking them reachable alone is what stranded their closure.
  for (const f of files) {
    if (!forced.has(f.path)) continue;
    const rc = new RefCollector();
    for (const s of f.body) {
      if (s.kind === 'ClassDecl' || s.kind === 'InterfaceDecl') continue;
      rc.stmt(s);
    }
    if (rc.types.size === 0 && rc.names.size === 0) continue;
    const ctx: ResolveCtx = { file: f.path, ownPkg: null, imports: fileImports.get(f.path) ?? [] };
    const next = new Set<string>();
    for (const t of rc.types) resolveInto(t, ctx, next);
    for (const n of rc.names) resolveInto(n, ctx, next);
    for (const n of next) {
      if (reachable.has(n)) continue;
      edges++;
      enqueue(n);
    }
  }

  while (queue.length > 0) {
    const fqn = queue.pop()!;
    const d = byFqn.get(fqn)!;
    const rc = new RefCollector();
    if (d.stmt.kind === 'ClassDecl') rc.classDecl(d.stmt);
    else rc.stmt(d.stmt);
    // The file's own imports are the resolution context (the caller injected the
    // same-file sibling FQNs into every decl's `imports`, so they are covered).
    const ctx: ResolveCtx = {
      file: d.file,
      ownPkg: d.pkg,
      imports: (d.stmt.kind === 'ClassDecl' || d.stmt.kind === 'InterfaceDecl' ? d.stmt.imports : []),
    };
    const next = new Set<string>();
    for (const t of rc.types) resolveInto(t, ctx, next);
    for (const n of rc.names) resolveInto(n, ctx, next);
    for (const n of next) {
      if (reachable.has(n)) continue;
      edges++;
      enqueue(n);
    }
  }

  const kept = files.filter((f) => (declsByFile.get(f.path) ?? []).some((d) => reachable.has(d.fqn)) || forced.has(f.path));
  const keptSet = new Set(kept.map((f) => f.path));
  return {
    kept: kept.map((f) => f.path),
    dropped: files.filter((f) => !keptSet.has(f.path)).map((f) => f.path),
    roots: [...roots],
    edges,
  };
}
// Read, parse and rewrite every `--air-app` source into ReachFile form.
//
// This is pass 1 of the `--air-app` branch, kept here (rather than inline in
// index.ts) so the closure and its unit test share ONE preparation path — the
// rewrite below decides the class identities the closure resolves against, so a
// test that re-implemented it could pass while the real build broke.
//
// Two rewrites happen, both required by AS3's package rules:
//
//   * a class declared outside any `package { }` block lives in a per-file
//     anonymous namespace (AS3 §5.1). Its `packageName` becomes a unique
//     file-scoped id, so its C key cannot collide with a real package class
//     (Polygon.as's `class Rectangle` vs `flash.geom.Rectangle`). Note a bare
//     `package { }` gives `packageName === ''` — falsy but not null, so it keeps
//     its empty package and is NOT rewritten.
//   * a file's members are visible to each other without an import, so every
//     same-file FQN is appended to each class's import list; the import-aware
//     resolver in computeReachable then sees them.
//
// The `fileId` stored on each declaration is also what the real build keys
// same-file visibility off, so it must match `symbols.ts`'s notion of the file.
//
// MULTIPLE SOURCE ROOTS (`--as-class-path`, 阶段二百五十)
// ------------------------------------------------------
// `srcDirs` is `[<appDir>/src, ...--as-class-path dirs]`. A library shared by
// several apps has to live OUTSIDE each of them (three demos each carrying a
// byte-identical 91-file copy of the UI kit is what made this exist), but a file's
// identity must stay stable and unique across those roots:
//
//   * a file belongs to the DEEPEST root that contains it, so a root nested inside
//     another does what a reader expects (the file is named relative to the inner
//     one). `relative` is used rather than a string prefix, so `.../src2/x.as` is
//     not mistaken for a member of `.../src`;
//   * `fileId` is the path relative to ITS OWN root, so `kit/ui/Chip.as` keeps one
//     id (and therefore one anonymous-namespace key, one C symbol) no matter which
//     app directory the build runs from;
//   * two files that would land on the SAME id — the same relative path under two
//     roots — are told apart with a `_2`, `_3`, … suffix. Without it two packageless
//     `Control.as` under different roots would share one anonymous namespace and
//     collide as the same class;
//   * the same FQN declared under TWO roots is a HARD ERROR, never last-wins. That
//     is the migration trap: adding `--as-class-path ../kit` while `src/asaot`
//     still holds a copy would otherwise silently be decided by walk order (§2.5).
export function prepareReachFiles(asFiles: string[], srcDirs: string | readonly string[]): ReachFile[] {
  const roots = (typeof srcDirs === 'string' ? [srcDirs] : [...srcDirs]).map((d) => resolve(d));
  if (roots.length === 0) throw new Error('prepareReachFiles: at least one source root is required');
  // The root a file belongs to, as an index into `roots`.
  const rootOf = (f: string): number => {
    let best = -1;
    let bestLen = Infinity;
    for (let r = 0; r < roots.length; r++) {
      const rel = relative(roots[r], f);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
      if (rel.length < bestLen) { best = r; bestLen = rel.length; }
    }
    // Outside every declared root: a caller bug (the adapter builds this list by
    // walking exactly these roots), so fail loudly rather than guess a root.
    if (best < 0) {
      throw new Error(`prepareReachFiles: '${f}' is not under any source root (${roots.join(', ')})`);
    }
    return best;
  };
  const out: ReachFile[] = [];
  // fileId -> the file that claimed it (see the header note on `_2`, `_3`).
  const claimed = new Map<string, string>();
  // AS3 FQN -> the file that declared it. Only CROSS-root duplicates are fatal:
  // two files in the SAME root colliding is pre-existing last-wins behaviour in
  // symbols.ts, and turning that into an error here would refuse trees that build
  // today.
  const declaredIn = new Map<string, { file: string; root: number }>();
  // Files this compiler's front end cannot parse yet (all in vendored third-party
  // packages in practice: E4X-heavy JSON/crypto, one greensock wall). They are
  // EXCLUDED, not silently ignored: the list is printed loudly, and because a
  // skipped file simply contributes no declarations, any class that was only
  // defined there fails LOUDLY downstream as an unknown type — never a silent
  // fallback to wrong semantics (§2.5). A whole-tree parse used to abort on the
  // first one, which made a real app impossible to attempt at all.
  const unparsed: string[] = [];
  for (const f of asFiles) {
    const rootIdx = rootOf(f);
    const rel = relative(roots[rootIdx], f).replace(/\\/g, '/');
    let p;
    try {
      p = parse(readFileSync(f, 'utf8'));
    } catch (err) {
      unparsed.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const baseId = rel.replace(/\.as$/i, '').replace(/[^A-Za-z0-9_]/g, '_');
    let fileId = baseId;
    for (let n = 2; claimed.has(fileId) && claimed.get(fileId) !== f; n++) fileId = `${baseId}_${n}`;
    claimed.set(fileId, f);
    // Every top-level class/interface declared in this file (for same-file
    // visibility below).
    const fileClasses: { name: string; packageName: string | null }[] = [];
    for (const stmt of p.body) {
      if (stmt.kind === 'ClassDecl' || stmt.kind === 'InterfaceDecl') {
        fileClasses.push({ name: stmt.name, packageName: stmt.packageName });
      }
    }
    for (const stmt of p.body) {
      if (stmt.kind === 'ClassDecl' || stmt.kind === 'InterfaceDecl') {
        stmt.fileId = fileId;
        if (stmt.packageName === null) stmt.packageName = fileId;
      }
    }
    for (const stmt of p.body) {
      if (stmt.kind === 'ClassDecl' || stmt.kind === 'InterfaceDecl') {
        for (const fc of fileClasses) {
          const fqnStr = fc.packageName === null ? `${fileId}.${fc.name}` : `${fc.packageName}.${fc.name}`;
          if (!stmt.imports.includes(fqnStr)) stmt.imports.push(fqnStr);
        }
      }
    }
    // The cross-root duplicate check runs AFTER the anonymous rewrite above, so a
    // packageless class is compared under the file-scoped name it will really be
    // emitted as.
    for (const stmt of p.body) {
      if (stmt.kind !== 'ClassDecl' && stmt.kind !== 'InterfaceDecl') continue;
      const fqn = stmt.packageName === null ? stmt.name : `${stmt.packageName}.${stmt.name}`;
      const prev = declaredIn.get(fqn);
      if (prev === undefined) {
        declaredIn.set(fqn, { file: f, root: rootIdx });
        continue;
      }
      if (prev.file === f || prev.root === rootIdx) continue;
      const show = (q: string): string => relative(process.cwd(), q).replace(/\\/g, '/');
      throw new Error(
        `the same class is declared under two source roots: '${fqn}'\n` +
        `  ${show(prev.file)}\n` +
        `  ${show(f)}\n` +
        `  (${roots[prev.root]} vs ${roots[rootIdx]})\n` +
        `  A shared root named by --as-class-path is compiled IN ADDITION to the app's\n` +
        `  src/, so a stale copy under src/ declares the same class twice. AS3 has one\n` +
        `  class per qualified name: delete the copy you did not mean to keep.`
      );
    }
    out.push({ path: f, body: p.body, imports: p.imports, swfFrameRate: p.swfFrameRate });
  }
  if (unparsed.length > 0) {
    process.stderr.write(
      `\x1b[33mwarning: ${unparsed.length} source file(s) in this build's source roots could not be parsed and were EXCLUDED:\x1b[0m\n`
    );
    for (const l of unparsed) process.stderr.write(`\x1b[33m  - ${l}\x1b[0m\n`);
    process.stderr.write(
      '\x1b[33m  (unlike a silent fallback, a class defined only in an excluded file is simply\n' +
      '  absent: referencing it then fails loudly as an unknown type)\x1b[0m\n'
    );
  }
  return out;
}
