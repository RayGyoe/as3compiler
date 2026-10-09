// Unit checks: `[` disambiguation and symbol-vs-string token matching.
//
// Two parser defects surfaced by surveying the talkmed-meeting AIR app (its entry
// src/Main.as plus the worlize websocket stack in its dependency closure). Both
// are pinned here at the AST level; the end-to-end path is covered by
// examples/swf-metadata.as and the diagnostic text by unit/diagnostics.ts.
//
//   * a package-body `[SWF(frameRate = 60)]` (unquoted NUMBER argument) made the
//     parser loop forever — the metadata block was rolled back on the numeric
//     argument and the package loop then consumed nothing;
//   * `at()` compared only a token's `value`, so the string literal `"]"` matched
//     the `]` symbol and `[ "]" ]` closed early.
//
// Both fixes are deliberately narrow: metadata literals now accept `num`, and
// `at()` requires the kind implied by the literal (word-like ⇒ `ident`, else
// `symbol`). The checks below assert BOTH the fixed behavior and that the
// neighboring, previously-correct behavior did not regress.
import { parse } from '../../src/parser.ts';
import { registerGroup } from '../harness.ts';

function checkMetadataBrackets(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [brackets] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [brackets] ${label}`); }
  };
  const first = (src: string): any => parse(src).body[0];

  // Defect 1 — the exact shape of talkmed-meeting src/Main.as:105. Before the fix
  // this call never returned; the assertion is that it returns at all, and that the
  // numeric values are captured rather than merely consumed. `args` keeps the raw
  // positional tokens, `named` the `name=value` pairs ([Embed(source=…, mimeType=…)]
  // needs the named form; see 阶段一百一十二).
  const swf: any = first('package { [SWF(frameRate = 60, backgroundColor = "0x000000")] class A {} }');
  check('a package-body [SWF(numeric)] parses and yields the class',
    swf?.kind === 'ClassDecl' && swf?.name === 'A');
  check('...and keeps the unquoted numeric argument verbatim',
    swf?.metadata?.[0]?.name === 'SWF' && swf?.metadata?.[0]?.args[0] === '60'
    && swf?.metadata?.[0]?.named?.frameRate === '60'
    && swf?.metadata?.[0]?.named?.backgroundColor === '0x000000');

  // Positional / float / boolean / hex literals are all legal metadata arguments.
  const tag: any = first('package { [Tag(1, 2.5, true, 0x1F)] class A {} }');
  check('positional numeric/float/hex metadata arguments are captured',
    JSON.stringify(tag?.metadata) === JSON.stringify([{ name: 'Tag', args: ['1', '2.5', 'true', '0x1F'] }]));

  // The string form worked before and must keep working (and is now ALSO recorded
  // under its name, which is how [Embed(source="x.png")] reads it).
  const str: any = first('package { [SWF(a = "1")] class A {} }');
  check('the quoted-string metadata form is unchanged',
    str?.metadata?.[0]?.name === 'SWF' && str?.metadata?.[0]?.args[0] === '1'
    && str?.metadata?.[0]?.named?.a === '1');

  // The package-level `[` branch must still hand declaration metadata to the
  // declaration (the branch rewinds when a declaration keyword follows); losing it
  // here would silently break [WasmExport]/[Embed].
  const fn: any = first('package p { [WasmExport] function f():void {} }');
  check('declaration metadata is still attached to the declaration',
    fn?.kind === 'FuncDecl' && fn?.name === 'f' && fn?.metadata?.[0]?.name === 'WasmExport');

  if (ok > 0) console.log(`[brackets] ${ok} metadata/bracket checks passed`);
  return bad;
}

function checkSymbolVsString(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [symstr] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [symstr] ${label}`); }
  };
  const arr = (src: string): any => (parse(src).body[0] as any).init;

  // Defect 2 — a string whose value is a bracket is a string, NOT the bracket.
  // Before the fix `[ "]" ]` parsed as an empty array plus a stray string.
  const r: any = arr('var a:Array = ["]"];');
  check('["]"] is a one-element array, not an empty one',
    r?.kind === 'ArrayLit' && r?.elements.length === 1 && r?.elements[0].value === ']');
  const o: any = arr('var b:Array = ["["];');
  check('["["] round-trips (this used to pass only by luck)',
    o?.elements.length === 1 && o?.elements[0].value === '[');
  const cb: any = arr('var c:Array = ["}"];');
  check('["}"] round-trips', cb?.elements.length === 1 && cb?.elements[0].value === '}');
  const cp: any = arr('var d:Array = [")"];');
  check('[")"] round-trips', cp?.elements.length === 1 && cp?.elements[0].value === ')');

  // The real-world form: worlize/WebSocket.as's punctuation delimiter table.
  const table: any = arr('var t:Array = [ "(", ")", "[", "]", "{", "}", "?" ];');
  check('a punctuation table parses with every element',
    table?.elements.length === 7
    && table.elements.map((e: any) => e.value).join('') === '()[]{}?');

  // Empty and default arrays are untouched.
  check('[] is still a zero-element array', arr('var e:Array = [];')?.elements.length === 0);
  check('[1, 2, 3] is unchanged',
    arr('var f:Array = [1, 2, 3];')?.elements.length === 3);

  // `at()` is also used with word values (keywords): the kind check must not break
  // them. A class using `public`/`var`/`function`/`while`/`return` exercises both
  // the ident and the symbol paths of the matcher.
  const cls: any = parse('package { class A { public var x:int = 0; public function f():int { while (x < 3) { x++; } return x; } } }').body[0];
  check('keyword and symbol expectations still match',
    cls?.kind === 'ClassDecl' && cls?.members.length === 2);

  if (ok > 0) console.log(`[symstr] ${ok} symbol/string checks passed`);
  return bad;
}

registerGroup('unit: parser/MetadataBrackets', checkMetadataBrackets);
registerGroup('unit: parser/SymbolVsString', checkSymbolVsString);

// ---- 阶段一百零八: the two language-layer gaps found by compiling away3d-core ----
// Both were hard ParseErrors on legal AS3; the AST shapes are pinned here (the
// end-to-end behavior is examples/field-declarators.as and examples/e4x-name.as,
// the adl-measured semantics are in temp/nsbracket/).
function checkClassFieldDeclarators(): string[] {
  const bad: string[] = [];
  let n = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { n++; console.log(`PASS  [fielddecl] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [fielddecl] ${label}`); }
  };
  const cls = (body: string): any => parse(`package { class A { ${body} } }`).body[0];

  // One statement, three fields -- the Away3D material-method idiom.
  const a = cls('private var _r:Number = 0, _g:Number = 0, _b:Number = 0;');
  check('a comma-separated class field becomes one Field member per declarator',
    a?.members?.length === 3 && a.members.map((m: any) => m.name).join(',') === '_r,_g,_b');
  check('...each keeping its own type and initializer',
    a?.members?.every((m: any) => m.kind === 'Field' && m.type === 'Number' && m.init?.value === 0 && m.isStatic === false && m.isConst === false));
  check('...and sharing the modifiers of the statement',
    a?.members?.every((m: any) => m.visibility === 'private'));

  const b = cls('public static const K:int = 9, L:int = 10;');
  check('`const` may list several constants, all static and const',
    b?.members?.length === 2 && b.members.every((m: any) => m.isConst === true && m.isStatic === true && m.type === 'int'));

  // An untyped declarator has NO type annotation (null), not the `int` default the
  // function-scope convention uses -- class fields are typed by resolveType later.
  const c = cls('public var u, v:String = "x";');
  check('an untyped declarator keeps type === null',
    c?.members?.length === 2 && c.members[0].type === null && c.members[1].type === 'String');
  check('...and its missing initializer stays null (not an undefined expr)',
    c?.members?.[1]?.init?.kind === 'Str' && c.members[0].init === null);

  // Trailing semicolon is still normalized away, and the single-declarator form
  // (with every modifier combination) is unchanged.
  const d = cls('arcane var _x:Number = 1;');
  check('the single-declarator form is unchanged',
    d?.members?.length === 1 && d.members[0].name === '_x' && d.members[0].ns === undefined);

  // A class-body STATEMENT must still not be mistaken for a field declaration.
  const e = cls('static const s:int = 1; TweenPlugin.activate([s]);');
  check('a bare class-body statement is still a StaticInit, not a field',
    e?.members?.some((m: any) => m.kind === 'StaticInit'));

  if (bad.length === 0) console.log(`[fielddecl] ${n} checks passed`);
  return bad;
}

function checkE4xComputedName(): string[] {
  const bad: string[] = [];
  let n = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { n++; console.log(`PASS  [e4xname] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [e4xname] ${label}`); }
  };
  // The first expression of the statement `var r:* = <expr>;`.
  const expr = (src: string): any => (parse(src).body[0] as any).init;

  // `element.ns::[name]` -- the DAEParser shape. The `.ns` was already parsed as a
  // member access, so the computed-name branch must COLLAPSE it (drop the namespace
  // qualifier) exactly like the identifier form does, leaving the element as the
  // receiver -- not the Namespace object.
  const a = expr('var r:* = element.ns::[name];');
  check('x.ns::[expr] is an E4xName on the ELEMENT (the `.ns` qualifier is dropped)',
    a?.kind === 'E4xName' && a.attr === false && a.object?.kind === 'Var' && a.object.name === 'element'
    && a.index?.kind === 'Var' && a.index.name === 'name');

  // `x.@[expr]` -- the attribute axis; a literal index is the same node.
  const b = expr('var r:* = one.@["id"];');
  check('x.@[expr] is an E4xName on the attribute axis',
    b?.kind === 'E4xName' && b.attr === true && b.object?.name === 'one' && b.index?.value === 'id');

  // A bare qualifier (no receiver) mirrors the identifier form: a member of `this`.
  const c = expr('var r:* = ns::[name];');
  check('ns::[expr] without a receiver targets `this`, like ns::member does',
    c?.kind === 'E4xName' && c.object?.kind === 'Var' && c.object.name === 'this');
  const c2 = expr('var r:* = ns::member;');
  check('...the identifier form still degrades to a bare name',
    c2?.kind === 'Var' && c2.name === 'member');

  // The static forms must be untouched: `.@name` is still AttrAccess, `.ns::name`
  // still collapses to a plain Member, and `x[e]` is still an Index.
  const d = expr('var r:* = one.@id;');
  check('x.@name is still AttrAccess', d?.kind === 'AttrAccess' && d.name === 'id');
  const e = expr('var r:* = element.ns::init_from;');
  check('x.ns::name is still collapsed to Member(x, name)',
    e?.kind === 'Member' && e.object?.name === 'element' && e.property === 'init_from');
  const f = expr('var r:* = arr[i];');
  check('x[expr] is still an Index', f?.kind === 'Index');

  // The index is a full expression, not just an identifier.
  const g = expr('var r:* = element.ns::[prefix + suffix];');
  check('the computed name may be any expression', g?.kind === 'E4xName' && g.index?.kind === 'Binary');

  if (bad.length === 0) console.log(`[e4xname] ${n} checks passed`);
  return bad;
}

registerGroup('unit: parser/ClassFieldDeclarators', checkClassFieldDeclarators);
registerGroup('unit: parser/E4xComputedName', checkE4xComputedName);