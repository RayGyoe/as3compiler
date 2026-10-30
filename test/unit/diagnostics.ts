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
  // name the real limitation — subclassing String/Number/int is still a gap
  // (`extends Array` used to be one; it is implemented now, see gi3b below).
  const gi3 = gen('class E extends String {}');
  check('subclassing a built-in type names it instead of reporting \'undefined\'',
    gi3?.message === "Codegen error at 1:1: unsupported superclass 'String' of 'E': subclassing built-in types is not implemented");
  const gi3b = gen('class E extends Array {}');
  check('a built-in that IS subclassable compiles (Array, via the hidden _arr slot)',
    gi3b === null);
  const gi4 = gen('interface I {}\nclass E extends I {}');
  check('extending an interface is reported as such',
    gi4?.message === "Codegen error at 2:1: class 'E' cannot extend interface 'I'");

  const g5 = gen('function f(a:int):void {}\nf(1, 2);');
  check('an arity mismatch is reported with the expected and actual counts',
    g5?.message === 'Codegen error at 2:1: too many arguments (expected 1, got 2) for (params: a) in <top>.<top>');
  const g6 = gen('function f(a:int):void {}\nf();');
  check('a missing argument names the parameter',
    g6?.message === "Codegen error at 2:1: missing argument for parameter 'a' in <top>.<top>");
  // Stage3D.requestContext3D is the AIR-legal place where this matters: AIR declares
  // (context3DRenderMode = "auto", profile = "baseline"), so passing a THIRD argument
  // must still be an error, and the message must name BOTH real parameters — a stale
  // one-parameter signature used to make every two-argument call fail instead.
  const s3d1 = gen('import flash.display.Stage;\nvar st:Stage = new Stage();\nst.stage3Ds[0].requestContext3D("auto", "baseline", "x");');
  check('requestContext3D accepts exactly two arguments, and the message names both',
    s3d1?.message === 'Codegen error at 3:1: too many arguments (expected 2, got 3) for (params: context3DRenderMode,profile) in <top>.<top>');

  // #75 / 阶段一百九十五: a BUILT-IN parameter that AIR requires must not be
  // defaulted. The `gnum` helper used to hand EVERY numeric built-in parameter a
  // `0` default, so the calls below compiled here although `mxmlc` 51.4.1 rejects
  // them all (measured cell-by-cell in temp/optarg/). The AIR-documented optional
  // parameters keep their defaults -- that half is pinned in unit: builtin/Arity.
  const a1 = gen('import flash.display.Shape;\nvar s:Shape = new Shape();\ns.graphics.moveTo(1);');
  check('a built-in required parameter is no longer defaulted (Graphics.moveTo(1))',
    a1?.message === "Codegen error at 3:1: missing argument for parameter 'y' in <top>.<top>");
  const a2 = gen('import flash.geom.Matrix;\nvar m:Matrix = new Matrix();\nm.rotate();');
  check('…and the zero-argument form of a required parameter is refused (Matrix.rotate())',
    a2?.message === "Codegen error at 3:1: missing argument for parameter 'angle' in <top>.<top>");
  const a3 = gen('import flash.geom.Rectangle;\nvar r:Rectangle = new Rectangle(0,0,10,10);\nr.contains(5);');
  check('…a partially supplied list still fails on the next parameter (Rectangle.contains(x, y))',
    a3?.message === "Codegen error at 3:1: missing argument for parameter 'y' in <top>.<top>");
  // AIR's own parameter ORDER is part of the contract: drawTrianglesInstanced takes
  // (indexBuffer, numInstances, firstIndex, numTriangles), so omitting numInstances
  // is an error even though firstIndex/numTriangles have defaults.
  const a4 = gen('import flash.display3D.Context3D;\nimport flash.display3D.IndexBuffer3D;\nvar ctx:Context3D = null;\nvar ib:IndexBuffer3D = null;\nctx.drawTrianglesInstanced(ib);');
  check('the AIR parameter order puts numInstances second (drawTrianglesInstanced(ib))',
    a4?.message === "Codegen error at 5:1: missing argument for parameter 'numInstances' in <top>.<top>");
  const a5 = gen('import flash.ui.ContextMenuItem;\nvar c:ContextMenuItem = new ContextMenuItem();');
  check('a built-in CONSTRUCTOR enforces AIR requiredness too (ContextMenuItem caption)',
    a5?.message === "Codegen error at 2:1: missing argument for parameter 'caption' in <top>.<top> (constructor of ContextMenuItem, args=0, params=[caption, separatorBefore?, enabled?, visible?])");
  // The other direction, which a tightening must not break: AIR's optional
  // parameters stay omittable (every one of these was measured `ok` with mxmlc).
  const a6 = gen('import flash.display.Shape;\nvar s:Shape = new Shape();\ns.graphics.beginFill(0xff0000);');
  check('an AIR-optional parameter may still be omitted (Graphics.beginFill alpha = 1)', a6 === null);
  const a7 = gen('import flash.display.NativeMenuItem;\nvar n:NativeMenuItem = new NativeMenuItem();');
  check('…including a constructor whose parameters are all optional (NativeMenuItem label = "")', a7 === null);
  const a8 = gen('import flash.display3D.Context3D;\nimport flash.display3D.IndexBuffer3D;\nvar ctx:Context3D = null;\nvar ib:IndexBuffer3D = null;\nctx.drawTriangles(ib);');
  check('…and Context3D.drawTriangles needs only the index buffer', a8 === null);
  const a9 = gen('import flash.display3D.Context3D;\nimport flash.display3D.IndexBuffer3D;\nvar ctx:Context3D = null;\nvar ib:IndexBuffer3D = null;\nctx.drawTrianglesInstanced(ib, 3);');
  check('…while the two-argument drawTrianglesInstanced form is accepted (AIR-legal)', a9 === null);

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
  // Only Object/any module variables are dynamic-construction candidates; a
  // module-level scalar slot stays a loud compile error (the fix for
  // examples/top-dynnew.as must not silently accept every identifier).
  const g9b = gen('var n:int = 0;\nvar x:* = new n();');
  check('a module-level non-Object/any variable still fails new',
    g9b?.message === "Codegen error at 2:1: unknown class 'n'");
  // The prefix must survive a message WRAP: the constructor-argument rethrow adds
  // detail to a bare message, and the `with` lexical fallback matches on the bare
  // text (both would break if the prefix leaked in).
  const g10 = gen('class P { public function P(a:int):void { } }\nvar p:* = new P();');
  check('a re-wrapped message keeps exactly one position prefix',
    g10?.message === "Codegen error at 2:1: missing argument for parameter 'a' in <top>.<top> (constructor of P, args=0, params=[a])");
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
  // 阶段一百四十八: StyleSheet is a real class now (setStyle/getStyle/clear/
  // styleNames), but two AIR members are deliberately left out -- see the 遗留表
  // row. They must fail LOUDLY rather than silently accept a stylesheet AIR would
  // have parsed, so the shape of the diagnostic is pinned here.
  const ss1 = gen('var s:StyleSheet = new StyleSheet();\ns.parseCSS(".x{}");');
  check('StyleSheet.parseCSS is not implemented yet, and says so',
    ss1?.message === "Codegen error at 2:1: undefined method 'parseCSS' on class 'StyleSheet'");
  const ss2 = gen('var s:StyleSheet = new StyleSheet();\nvar f:TextFormat = s.transform({});');
  check('StyleSheet.transform is not implemented yet, and says so',
    ss2?.message === "Codegen error at 2:1: undefined method 'transform' on class 'StyleSheet'");

  // 阶段二百四十五: flash.system.System 是 emitter 里的手写伪类（没有 ClassInfo），
  // 所以它的成员必须按「成员」报告。此前 `System.exit(0)` 掉到通用标识符路径，
  // 报 "undefined variable 'System'" —— 把「类认得、成员没有」说成「类不存在」，
  // 读者会去找 import。实测 AIR 51.4.1 对 0 个实参报「参数个数不正确。需要 1 个」。
  const s1 = gen('System.exit();');
  check('System.exit with no argument names the arity, not a missing class',
    s1?.message === 'Codegen error at 1:1: System.exit expects 1 argument (code:uint), got 0');
  const s2 = gen('System.notAMemberXYZ();');
  check('an unknown System member is reported as a missing MEMBER',
    s2?.message === "Codegen error at 1:1: System has no member 'notAMemberXYZ'");

  // 阶段三百二十九: mxmlc 的「隐式强制转换」拒绝面。实测（mxmlc 51.4.1，
  // temp/coerce/ 的 12x10 矩阵 + Q.as）：只有 `*` 源、`Object` 目标、`Boolean`
  // 目标是放行的三角，数值族内部可互转但与 String 不相通，其余一律要求真实子类
  // 关系。我们此前全部接受并在运行期自行转换 —— 等于编译了参考编译器会拒绝的
  // 程序，而且选了一条 AIR 根本不会走的转换路径。
  const c1 = gen('var o:Object;\nvar arr:Array = o;');
  check('Object into an Array slot is an implicit-coercion error',
    c1?.message === 'Codegen error at 2:1: implicit coercion of a value of type Object to a possibly unrelated type Array');
  const c2 = gen('var o:Object;\nvar s:String = o;');
  check('Object into a String slot is an implicit-coercion error',
    c2?.message === 'Codegen error at 2:1: implicit coercion of a value of type Object to a possibly unrelated type String');
  const c3 = gen('var s:String = "5";\nvar n:Number = s;');
  check('String into a Number slot is an implicit-coercion error',
    c3?.message === 'Codegen error at 2:1: implicit coercion of a value of type String to a possibly unrelated type Number');
  const c4 = gen('var n:Number = 5;\nvar f:Function = n;');
  check('Number into a Function slot is an implicit-coercion error',
    c4?.message === 'Codegen error at 2:1: implicit coercion of a value of type Number to a possibly unrelated type Function');
  const c5 = gen('function g(d:DisplayObject):Sprite { return d; }');
  check('a return-position downcast is an implicit-coercion error',
    c5?.message === 'Codegen error at 1:38: implicit coercion of a value of type DisplayObject to a possibly unrelated type Sprite');
  // …and the permissive corners stay open, so the check cannot reject valid AIR.
  const okObj = thrown(() => generateC(parse('var o:Object;\nvar x:Object = o;\nvar b:Boolean = o;\nvar v:* = o;')));
  check('Object/Boolean/* targets accept an Object source', okObj === null);
  const okStar = thrown(() => generateC(parse('var v:*;\nvar arr:Array = v;\nvar s:String = v;\nvar n:Number = v;')));
  check('a * source coerces into any target', okStar === null);
  const okNum = thrown(() => generateC(parse('var i:int = 1;\nvar u:uint = i;\nvar n:Number = u;\nvar i2:int = n;')));
  check('the numeric family interconverts', okNum === null);
  const okXml = thrown(() => generateC(parse('var x:XML = <a/>;\nvar s:String = x;')));
  check('XML implicitly stringifies (measured: mxmlc allows it)', okXml === null);

  const all = [g1, g2, g3, g4, g5, g6, g7, g8, g9, g10, g12, g13, gi2, gi3, gi4, t1, t2, t3, t4, t5, t6, t7, t8, t9, i1, i2, s1, s2, c1, c2, c3, c4, c5];
  check('every CodegenError carries a numeric line and col',
    all.every((e) => e !== null && typeof e.line === 'number' && typeof e.col === 'number')
    && all.every((e) => /^Codegen error at \d+:\d+: /.test(e!.message)));

  if (ok > 0) console.log(`[cgdiag] ${ok} codegen diagnostic checks passed`);
  return bad;
}

registerGroup('unit: diagnostics/Lex', checkLexDiagnostics);
registerGroup('unit: diagnostics/Parse', checkParseDiagnostics);
registerGroup('unit: diagnostics/Codegen', checkCodegenDiagnostics);