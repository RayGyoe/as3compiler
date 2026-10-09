// Unit checks: the three diagnostic channels (阶段九十六·一).
//
// Why this cannot be an examples/ unit: the example suite only runs programs
// that must SUCCEED, so a compiler error can never be asserted there. AGENTS.md
// §2.5 makes `Lex/Parse error at line:col: <reason>` a contract — a diagnostic
// that points at the wrong line is its own defect — so the contract is pinned
// here against measured output.
//
// Every expectation below is the real string the compiler produces today
// (probe: temp/testrefactor/probe-diag.ts); nothing is asserted from memory.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { lex } from '../../src/lexer.ts';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { codegenBareMessage } from '../../src/symbols.ts';
import { registerGroup, root, dir } from '../harness.ts';

// Run a compiler entry point and return the thrown error, or null if it passed.
function thrown(fn: () => unknown): (Error & { line?: number; col?: number; token?: { line: number; col: number } }) | null {
  try { fn(); return null; } catch (e) { return e as Error; }
}

function checkLexDiagnostics(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [lexdiag] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [lexdiag] ${label}`); }
  };

  // An unterminated block comment must point at the OPENING `/*`, not at EOF:
  // the whole rest of the file is comment text, so EOF would be the wrong place
  // to look. (An earlier defect reported the comment as non-nesting and swallowed
  // the file — see the [lexer] group.)
  const c1 = thrown(() => lex('var a:int = 1;\n/* never closed'));
  check('an unterminated block comment names the class, position and reason',
    c1?.message === 'Lex error at 2:1: unterminated block comment');
  check('...and exposes the same position on the error object',
    c1?.line === 2 && c1?.col === 1);

  const c2 = thrown(() => lex('var r:RegExp = /abc'));
  check('an unterminated regular expression reports the opening slash',
    c2?.message === 'Lex error at 1:16: unterminated regular expression');

  const c3 = thrown(() => lex('var s:String = "abc'));
  check('an unterminated string literal reports the opening quote',
    c3?.message === 'Lex error at 1:16: unterminated string literal');

  // A raw line terminator inside a string is a compile error in AS3 (mxmlc
  // rejects it too); the message must say WHY, not just "unterminated".
  const c4 = thrown(() => lex('var s:String = "ab\ncd";'));
  check('a raw line terminator inside a string says so',
    c4?.message === 'Lex error at 1:16: unterminated string literal (line terminator in string)');

  // \u needs exactly four hex digits, \x exactly two; a short one is an error
  // rather than a silently truncated character.
  const u1 = thrown(() => lex('var s:String = "\\u12";'));
  check('a \\u escape with fewer than four hex digits is rejected',
    u1?.message === 'Lex error at 1:16: invalid \\u escape sequence');
  const u2 = thrown(() => lex('var s:String = "\\u12zz";'));
  check('a \\u escape with a non-hex digit is rejected',
    u2?.message === 'Lex error at 1:16: invalid \\u escape sequence');
  const x1 = thrown(() => lex('var s:String = "\\x1";'));
  check('a \\x escape with fewer than two hex digits is rejected',
    x1?.message === 'Lex error at 1:16: invalid \\x escape sequence');

  check('every lexer diagnostic carries a position', [c1, c2, c3, c4, u1, u2, x1]
    .every((e) => typeof e?.line === 'number' && typeof e?.col === 'number'));

  if (ok > 0) console.log(`[lexdiag] ${ok} lexer diagnostic checks passed`);
  return bad;
}

function checkParseDiagnostics(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [parsediag] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [parsediag] ${label}`); }
  };

  // §2.5's worked example: name both tokens, and point at the offending one.
  const p1 = thrown(() => parse('class C {\n  var a:int;\n'));
  check("an unclosed class reports expected '}' but found '<eof>'",
    p1?.message === "Parse error at 3:1: expected '}' but found '<eof>'");
  check('...and carries the offending token position',
    p1?.token?.line === 3 && p1?.token?.col === 1);

  const p2 = thrown(() => parse('var 123:int;'));
  check('a non-identifier where one is required says which token it found',
    p2?.message === "Parse error at 1:5: expected identifier but found '123'");

  const p3 = thrown(() => parse('if (true { }'));
  check("an unclosed argument list reports expected ')' and the found token",
    p3?.message === "Parse error at 1:10: expected ')' but found '{'");

  const p4 = thrown(() => parse('var a:int = 1 var b:int = 2;'));
  check("a missing statement separator reports expected ';'",
    p4?.message === "Parse error at 1:15: expected ';' but found 'var'");

  // A package body can only contain imports and declarations, so a stray `[` there
  // is a syntax error — but it must be REPORTED, not spun on. Before the fix a
  // bracket sequence that failed to parse as metadata (e.g. because its argument
  // was an unquoted number) rolled back to its start, consumed nothing, and the
  // package loop iterated forever. The loop-progress sentinel turns that into the
  // positioned diagnostic below (AGENTS.md §2.5: never hang, never swallow).
  const p5 = thrown(() => parse('package { [Tag(+)] class A {} }'));
  check('an unparseable package-level bracket is reported, not hung',
    p5?.message === "Parse error at 1:11: unexpected token '[' in package body");

  check('every parser diagnostic carries a token position', [p1, p2, p3, p4, p5]
    .every((e) => typeof e?.token?.line === 'number' && typeof e?.token?.col === 'number'));

  if (ok > 0) console.log(`[parsediag] ${ok} parser diagnostic checks passed`);
  return bad;
}

function checkCodegenDiagnostics(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [cgdiag] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [cgdiag] ${label}`); }
  };
  const gen = (src: string) => thrown(() => generateC(parse(src)));

  // §2.5's other half: never silently emit C that does not mean what the source
  // said. Each of these is a semantically invalid program, and the contract is
  // that codegen THROWS instead of producing "compiles but means the wrong thing".
  // §2.5: every layer reports a locatable position. CodegenError used to carry
  // none at all (the semantic layer had no position source either); the parser now
  // stamps every statement and class member and the emitter/symbols layer
  // publishes the construct it is visiting (`setGenPos`), so the message carries
  // the same `Codegen error at L:C: ` prefix as LexError/ParseError.
  const g1 = gen('class A extends Nope {}');
  check('an unknown superclass is a CodegenError, not a silent no-superclass',
    g1?.constructor.name === 'CodegenError' && g1.message === "Codegen error at 1:1: unknown superclass 'Nope' of 'A'");
  check('...and exposes the position on the error object too',
    g1?.line === 1 && g1?.col === 1);

  const g2 = gen('class A extends B {}\nclass B extends A {}');
  check('circular inheritance is reported',
    g2?.message === "Codegen error at 1:1: circular inheritance involving 'A'");

  const g3 = gen('final class F {}\nclass A extends F {}');
  check('inheriting from a final class is reported',
    g3?.message === "Codegen error at 2:1: cannot inherit from final class 'F'");

  const g4 = gen('interface I { function f():void; }\nclass C implements I {}');
  check('a class missing an interface method names both the class and the method',
    g4?.message === "Codegen error at 2:1: class 'C' does not implement method 'f' of interface 'I'");

  // An interface ACCESSOR can be satisfied by an accessor-backed BUILT-IN property:
  // AIR declares `DisplayObject.x` as `get x`/`set x`, so a subclass INHERITING it
  // implements the interface without declaring anything (measured on adl 51.4.1 —
  // mxmlc accepts this). Our C model stores x as a plain field, so the conformance
  // check must accept it too, and the interface vtable gets a generated thunk.
  const gi1 = gen('package { public interface IX { function get x():Number; function set x(v:Number):void; } }\npackage { import flash.display.Sprite; public class C extends Sprite implements IX {} }');
  check('an interface accessor is satisfied by an inherited built-in property', gi1 === null);
  // ...but a USER `var` does NOT satisfy an interface ACCESSOR: AIR rejects exactly
  // this shape ("class C 未实现 interface IX 中的 interface 方法 x"), measured in
  // temp/accprobe/ImplVar.as. The check must not be relaxed into "any member".
  const gi2 = gen('package { public interface IX { function get x():Number; function set x(v:Number):void; } }\nclass C implements IX { public var x:Number; }');
  check('a user var does NOT satisfy an interface accessor (matches AIR)',
    gi2?.message === "Codegen error at 2:1: class 'C' does not implement method 'x' of interface 'IX'");

  // `extends <built-in type>`: `resolveType` maps the type-only built-ins to
  // non-class CTypes with NO className, so an earlier version reported a superclass
  // literally named "undefined" (e.g. `class E extends Array {}`). The message must
  // name the real limitation — subclassing Array is a genuine, AIR-supported gap
  // (2 files in the talkmed-meeting closure use it).
  const gi3 = gen('class E extends Array {}');
  check('subclassing a built-in type names it instead of reporting \'undefined\'',
    gi3?.message === "Codegen error at 1:1: unsupported superclass 'Array' of 'E': subclassing built-in types is not implemented");
  const gi4 = gen('interface I {}\nclass E extends I {}');
  check('extending an interface is reported as such',
    gi4?.message === "Codegen error at 2:1: class 'E' cannot extend interface 'I'");

  const g5 = gen('function f(a:int):void {}\nf(1, 2);');
  check('an arity mismatch is reported with the expected and actual counts',
    g5?.message === 'Codegen error at 2:1: too many arguments (expected 1, got 2) for a');
  const g6 = gen('function f(a:int):void {}\nf();');
  check('a missing argument names the parameter',
    g6?.message === "Codegen error at 2:1: missing argument for parameter 'a'");

  // The statement stamp must report the statement's OWN line, not the file start.
  const g7 = gen('class A { }\n\n\nclass B extends Nope {}');
  check('the reported line is the offending statement, not 1:1',
    g7?.line === 4 && g7?.col === 1);
  // Class members are stamped too (a member error points at the member).
  const g8 = gen('class A {\n  public var x:int;\n  [WasmExport] public function f():void { }\n}');
  check('a class-member error points at the member line', g8?.line === 3);
  // An error thrown while emitting a TOP-LEVEL initializer (emitTopLevel, which does
  // not go through emitStmt) must still be locatable.
  const g9 = gen('var a:int = 0;\nvar b:* = new Nope();');
  check('a top-level initializer error carries the top-level line',
    g9?.message === "Codegen error at 2:1: unknown class 'Nope'");
  // The prefix must survive a message WRAP: the constructor-argument rethrow adds
  // detail to a bare message, and the `with` lexical fallback matches on the bare
  // text (both would break if the prefix leaked in).
  const g10 = gen('class P { public function P(a:int):void { } }\nvar p:* = new P();');
  check('a re-wrapped message keeps exactly one position prefix',
    g10?.message === "Codegen error at 2:1: missing argument for parameter 'a' (constructor of P, args=0, params=[a])");
  check('codegenBareMessage strips the position prefix',
    g1 !== null && codegenBareMessage(g1 as never) === "unknown superclass 'Nope' of 'A'");
  // The `with` lexical fallback still degrades an unknown name into AIR's runtime
  // #1065 rather than failing the build (examples/with.as pins it end to end).
  const g11 = gen('var d:Object = { a: 5 };\nwith (d) { trace(a); }');
  check('the `with` fallback still recognizes an undefined-variable CodegenError',
    g11 === null);

  // 阶段一百零八: the E4X computed-name forms have a receiver-type contract. Both
  // are compile errors in AIR too (mxmlc rejects `.@` outside XML), so the channel
  // is a loud CodegenError -- never a silent `as_dyn_get` on a non-object.
  const g12 = gen('var n:int = 5;\nvar at:String = "x";\ntrace(n.@[at]);');
  check("x.@[expr] on a non-XML receiver names the receiver type",
    g12?.message === "Codegen error at 3:1: '@[...]' attribute access on non-XML type int");
  const g13 = gen('var s:String = "abc";\nvar nm:String = "x";\ntrace(s.ns::[nm]);');
  check('x.ns::[expr] on a non-XML receiver names the receiver type',
    g13?.message === 'Codegen error at 3:1: E4X computed child access on non-XML type string');

  // 阶段九十九 (批次1c): a type ANNOTATION that names no known class/interface is a
  // compile error. Before this the name sailed through `resolveType` (a pure
  // function with no symbol table, which must answer "some object type" for a name
  // it cannot classify) and surfaced as cc's `error: unknown type name 'Nope'` with
  // NO AS3 position. The check lives in the symbol-table-aware `checkTypeAnnotation`
  // and must never move into `rt()`: `rt` doubles as the "is this a class?" probe
  // for the `Type(expr)` cast syntax, where an unknown name is legal.
  const t1 = gen('var a:Nope = null;');
  check('an unknown local annotation is a locatable CodegenError',
    t1?.message === "Codegen error at 1:1: unknown type 'Nope'");
  check('...and exposes the position on the error object too', t1?.line === 1 && t1?.col === 1);
  const t2 = gen('package demo { public class C {\n  public var f:Nope;\n} }');
  check('an unknown FIELD annotation points at the field',
    t2?.message === "Codegen error at 2:3: unknown type 'Nope'");
  const t3 = gen('package demo { public class C {\n  public function m(a:Nope):void {}\n} }');
  check('an unknown PARAM annotation points at the method',
    t3?.message === "Codegen error at 2:3: unknown type 'Nope'");
  const t4 = gen('package demo { public class C {\n  public function m():Nope { return null; }\n} }');
  check('an unknown RETURN annotation points at the method',
    t4?.message === "Codegen error at 2:3: unknown type 'Nope'");
  const t5 = gen('package demo { public class C {\n  public function C(a:Nope) {}\n} }');
  check('an unknown CONSTRUCTOR param annotation is reported',
    t5?.message === "Codegen error at 2:3: unknown type 'Nope'");
  // A free function has no `declareVar`/member pass for its params, so the
  // prototype is the only site that can catch them.
  const t6 = gen('function f(a:Nope):void {}\nf(null);');
  check('an unknown free-function param annotation is reported',
    t6?.message === "Codegen error at 1:1: unknown type 'Nope'");
  const t7 = gen('function f():Nope { return null; }');
  check('an unknown free-function return annotation is reported',
    t7?.message === "Codegen error at 1:1: unknown type 'Nope'");
  // A Vector element type is an annotation too -- the message must name the ELEMENT
  // (`Nope`), not the unhelpful `Vector.<Nope>`.
  const t8 = gen('var v:Vector.<Nope> = null;');
  check('an unknown Vector element type names the element',
    t8?.message === "Codegen error at 1:1: unknown type 'Nope'");
  const t9 = gen('interface IX { function f(a:Nope):void; }');
  check('an unknown INTERFACE method annotation is reported',
    t9?.message === "Codegen error at 1:1: unknown type 'Nope'");
  // A known interface (user or built-in) is NOT an error: interface types are
  // resolved by `resolveType` and validated against `hasInterface`.
  const t10 = gen('interface IU { function f():void; }\nclass K {}\nvar x:IU = null;');
  check('a known interface annotation is accepted', t10 === null);
  const t11 = gen('var x:IDataInput = null;');
  check('a built-in interface annotation is accepted', t11 === null);
  // 阶段一百二十七 — an interface METHOD naming a user class is legal and must not be a
  // false `unknown type`. This is the exact shape that broke the build of
  // examples/air-starling-demo (`IFilterHelper.getTexture(): Texture`): the annotation
  // check originally ran during interface registration (pass 0), before pass 1
  // registered any user class shell, so `hasClass` saw only the built-ins. It now runs
  // as a deferred pass once the whole symbol table exists (symbols.ts "pass 2.1").
  const t12 = gen('package lib.tex { public class Texture {} }\npackage lib.f { import lib.tex.Texture; public interface IH { function getTexture():Texture; } }');
  check('an interface method naming an imported user class is accepted', t12 === null);
  const t13 = gen('package lib.tex { public class Texture {}\n public interface IH { function getTexture():Texture; } }');
  check('an interface method naming a same-package class needs no import', t13 === null);
  const t14 = gen('package lib.tex { public class Texture {} }\npackage lib.f { import lib.tex.*; public interface IH { function getTexture():Texture; } }');
  check('an interface method naming a wildcard-imported user class is accepted', t14 === null);

  // 阶段九十九 (批次1d): IDataInput/IDataOutput are registered with AIR's FULL
  // member list (measured from the installed SDK: flash.utils, NOT flash.net).
  // Being *laxer* than AIR here would accept a class that omits a member and fail
  // only at the call site, so the conformance pass must name the first missing one.
  const i1 = gen('class C implements IDataInput {}');
  check('a class missing IDataInput members names the first one',
    i1?.message === "Codegen error at 1:1: class 'C' does not implement method 'readBoolean' of interface 'IDataInput'");
  const i2 = gen('class C implements IDataOutput {}');
  check('a class missing IDataOutput members names the first one',
    i2?.message === "Codegen error at 1:1: class 'C' does not implement method 'writeBoolean' of interface 'IDataOutput'");
  // The TLSSocket shape: a subclass restating both interfaces (every member comes
  // from Socket) must pass, which is the whole point of registering them.
  const i3 = gen('class MySock extends Socket implements IDataInput, IDataOutput {}');
  check('a Socket subclass restating both byte interfaces compiles', i3 === null);

  // The CLI must print the locatable message too (it prints `err.message`, so a
  // CodegenError that only carried a position FIELD would not be visible to a user).
  // End to end: the CLI prints `err.message` in red, so the position must be IN the
  // message, not merely a field on the error object.
  const tmpDir = join(root, 'temp', 'unit-diag');
  mkdirSync(tmpDir, { recursive: true });
  const badPath = join(tmpDir, 'bad.as');
  writeFileSync(badPath, 'class A { }\n\n\nclass B extends Nope { }\n');
  const cli = spawnSync(process.execPath, [join(root, 'src', 'index.ts'), badPath], { encoding: 'utf8', cwd: root });
  check('the CLI prints the position for a CodegenError',
    cli.status === 1 && cli.stderr.includes('Codegen error at 4:1: unknown superclass'));
  rmSync(tmpDir, { recursive: true, force: true });

  // Every codegen diagnostic in this file is locatable.
  const all = [g1, g2, g3, g4, g5, g6, g7, g8, g9, g10, g12, g13, gi2, gi3, gi4, t1, t2, t3, t4, t5, t6, t7, t8, t9, i1, i2];
  check('every CodegenError carries a numeric line and col',
    all.every((e) => e !== null && typeof e.line === 'number' && typeof e.col === 'number')
    && all.every((e) => /^Codegen error at \d+:\d+: /.test(e!.message)));

  if (ok > 0) console.log(`[cgdiag] ${ok} codegen diagnostic checks passed`);
  return bad;
}

registerGroup('unit: diagnostics/Lex', checkLexDiagnostics);
registerGroup('unit: diagnostics/Parse', checkParseDiagnostics);
registerGroup('unit: diagnostics/Codegen', checkCodegenDiagnostics);