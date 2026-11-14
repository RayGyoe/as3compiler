// Unit checks for scripts/js2as.ts -- the restricted JS -> AS3 translator.
//
// Three things are pinned here, and only here (the example suite in
// test/examples.ts runs programs that must succeed, so a REFUSAL could never be
// caught there -- AGENTS.md §2.7):
//   1. every refusal reports the author's line:col and names the construct; the
//      refused set is now what a TEXT rewrite cannot do faithfully -- nested or rest
//      patterns, computed keys, `this` inside an arrow, and module-referencing exports;
//   2. the rewrites (`let`->`var`, `console.*`->`trace`, hrtime, template literals,
//      arrow functions -> anonymous functions, destructuring -> property reads, export
//      stripping) produce exactly the text the compiler needs, and leave the rest alone;
//   3. the whole benchmark corpus translates (except the class-based sample, which
//      is refused by name) -- and since jsToAs SELF-PARSES its output with the real
//      parser before returning, a green run here means the emitted AS3 parses.
//
// The end-to-end equivalence measurements (translated output -> C -> native, result
// compared against `node`) are in docs/zh-cn/js2as.md; they need a compiler and a
// linker, which is what test/examples.ts is for, not this layer.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { jsToAs, Js2AsError } from '../../scripts/js2as.ts';
import { registerGroup, root } from '../harness.ts';

// The message of the Js2AsError a translation throws, or null when it succeeds.
function refusal(src: string): Js2AsError | null {
  try {
    jsToAs(src, '<test>');
    return null;
  } catch (e) {
    if (e instanceof Js2AsError) return e;
    throw e;
  }
}

function checkRefusals(): string[] {
  const bad: string[] = [];
  const ok = (label: string, cond: boolean): void => { if (!cond) bad.push(label); };

  // Each case pins the line:col AND a substring of the reason: a refusal that
  // points at the wrong place is as bad as no refusal at all (§2.5).
  const cases: { name: string; src: string; line: number; col: number; why: string }[] = [
    { name: 'class', src: 'const x = 1;\nclass A {}\n', line: 2, col: 1, why: 'classes are not in the subset' },
    { name: 'spread', src: 'const a = [1];\nconst b = [...a];\n', line: 2, col: 12, why: 'spread/rest' },
    { name: 'for-of', src: 'const a = [1];\nfor (const v of a) { trace(v); }\n', line: 2, col: 14, why: 'for-of' },
    // A destructured for-of pattern is still a for-of: the pattern is NOT reported as
    // a leftover, and the `of` is what gets the message and the position.
    { name: 'for-of with a pattern', src: 'const p = [];\nfor (const [a, b] of p) { trace(a); }\n', line: 2, col: 19, why: 'for-of' },
    { name: 'optional chaining', src: 'const a = null;\nconst b = a?.x;\n', line: 2, col: 12, why: 'optional chaining' },
    { name: 'nested destructuring', src: 'const o = {};\nconst { a: { b } } = o;\n', line: 2, col: 7, why: 'nested destructuring' },
    { name: 'rest in destructuring', src: 'const o = {};\nconst { ...r } = o;\n', line: 2, col: 7, why: 'rest in a destructuring' },
    { name: 'computed key', src: 'const o = {};\nconst { [k]: v } = o;\n', line: 2, col: 7, why: 'computed or nested key' },
    // An arrow's `this` is lexical but an AS3 anonymous function's is the receiver,
    // so there is no faithful rewrite; refusing beats rebinding silently.
    { name: 'this inside an arrow', src: 'const o = {};\nconst f = () => this.x;\n', line: 2, col: 14, why: 'no faithful AS3 rewrite' },
    { name: 'export *', src: 'export * from "y";\n', line: 1, col: 1, why: '`export *`' },
    { name: 'export default', src: 'export default 1;\n', line: 1, col: 1, why: '`export default`' },
    { name: 'export ... from', src: 'export { a } from "y";\n', line: 1, col: 1, why: '`export ... from`' },
    { name: 'exponent', src: 'const a = 2 ** 8;\n', line: 1, col: 13, why: 'exponent operator' },
    { name: 'async', src: 'async function f() { }\n', line: 1, col: 1, why: 'async functions' },
    { name: 'await', src: 'function f() { await g(); }\n', line: 1, col: 16, why: 'await' },
    { name: 'yield', src: 'function f() { yield 1; }\n', line: 1, col: 16, why: 'generators' },
    { name: 'arguments', src: 'function f() { return arguments; }\n', line: 1, col: 23, why: 'arguments' },
    { name: 'import', src: 'import x from "y";\n', line: 1, col: 1, why: 'imports are not in the subset' },
    { name: 'multi-line template', src: 'const s = `a\nb`;\n', line: 1, col: 1, why: 'multi-line template' },
  ];
  for (const c of cases) {
    const r = refusal(c.src);
    ok(`${c.name}: refused`, r !== null);
    ok(`${c.name}: line:col ${c.line}:${c.col}`, r?.line === c.line && r?.col === c.col);
    ok(`${c.name}: reason mentions "${c.why}"`, (r?.message ?? '').includes(c.why));
  }

  // `of` is an ordinary identifier outside a for-of header; refusing it everywhere
  // would reject valid files that happen to use it as a name.
  ok('`of` as a plain identifier is allowed',
    refusal('const of = 1;\nconst x = of + 1;\n') === null);
  // ...but a for-of header is caught even when the body is on the same line.
  ok('`of` inside a for header is refused',
    refusal('for (var k of [1]) { trace(k); }\n') !== null);

  if (bad.length === 0) console.log(`[js2as/refusals] ${cases.length * 3 + 2} checks passed`);
  return bad;
}

function checkRewrites(): string[] {
  const bad: string[] = [];
  const ok = (label: string, cond: boolean): void => { if (!cond) bad.push(label); };
  const as = (src: string): string => jsToAs(src, '<test>');

  ok('let becomes var', as('let a = 1;\n').includes('var a:* = 1;'));
  ok('const keeps its keyword', as('const a = 1;\n').includes('const a:* = 1;'));
  ok('an untyped binding is `*`, never the compiler\'s `int` fallback',
    as('var a;\n').includes('var a:*;'));
  // AS3 wants a type on every declaration; both declarators of a `,` list get one.
  ok('every declarator is annotated',
    as('var a = 1, b = 2;\n').includes('var a:* = 1, b:* = 2;'));
  // AS3 also wants a type on each parameter and on the return.
  ok('parameters and return type are annotated',
    as('function f(a, b) { return a + b; }\n').includes('function f(a:*, b:*):*'));
  ok('a default parameter keeps its expression',
    as('function f(a = 5) { return a; }\n').includes('function f(a:* = 5):*'));

  ok('console.log becomes trace', as('console.log("x");\n').trim() === 'trace("x");');
  ok('console.error becomes trace', as('console.error("x");\n').trim() === 'trace("x");');
  ok('another console method is left alone (and so is its receiver)',
    as('console.table(1);\n').includes('console.table'));

  ok('process.hrtime.bigint() becomes a millisecond clock',
    as('const t = process.hrtime.bigint();\n').includes('(new Date().getTime() * 1000000)'));

  // Template literals are expanded BEFORE lexing (the lexer has no template token,
  // and adding one would put a JS-only feature in the compiler).
  ok('a template with no interpolation becomes a plain string',
    as('const s = `abc`;\n').includes('("abc")'));
  ok('a template with one interpolation becomes a concatenation',
    as('const s = `a=${x}`;\n').replace(/\s+/g, ' ').includes('("a=" + (x))'));
  ok('an empty template is an empty string', as('const s = ``;\n').includes('const s:* = "";'));
  ok('a backtick inside a string literal is not a template',
    as('const s = "`";\n').includes('"`"'));

  // Statement shape must survive: the translator edits text, it does not reformat.
  ok('statements keep their line layout',
    as('const a = 1;\nconst b = 2;\n').split('\n').length === 3);
  ok('comments are preserved',
    as('// hello\nconst a = 1;\n').includes('// hello'));

  // ── Arrow functions. AS3 has anonymous functions, so `(a) => expr` maps onto
  // `function (a) { return expr; }` and the normal annotation pass types the rest.
  ok('an arrow with a parenthesised parameter list becomes an anonymous function',
    as('const f = (a) => a + 1;\n').includes('const f:* = (function (a:*):* { return a + 1; });'));
  ok('a block-bodied arrow keeps its statements',
    as('const g = (a, b) => { const s = a + b; return s; };\n')
      .includes('(function (a:*, b:*):* { const s = a + b; return s; })'));
  ok('a bare parameter gets a parameter list',
    as('const h = x => x * 2;\n').includes('(function (x:*):* { return x * 2; })'));
  ok('an object-literal body keeps its own parenthesisation',
    as('const mk = (x) => ({ a: x });\n').includes('(function (x:*):* { return ({ a: x }); })'));
  ok('a nested arrow is rewritten innermost-first',
    as('const n = (x) => (y) => x + y;\n').includes('(function (x:*):* { return (function (y:*):* { return x + y; }); })'));
  ok('a zero-argument arrow becomes a zero-argument function',
    as('const z = () => 1;\n').includes('(function ():* { return 1; })'));
  ok('an arrow parameter list is type-annotated like any other',
    as('const f = (a, b = 2) => a;\n').includes('(function (a:*, b:* = 2)'));
  ok('a `this`-mentioning string inside an arrow body is not mistaken for a use',
    as('const f = () => "this";\n').includes('return "this"'));

  // ── Destructuring: a property read IS the same operation in AS3, so the rewrite
  // is faithful for plain bindings. A non-identifier source goes through a temp so
  // the right-hand side is evaluated exactly once (as JS does).
  ok('object destructuring becomes property reads',
    as('const { x, z } = o;\n').includes('const x:* = o.x, z:* = o.z;'));
  ok('a rename reads the original key',
    as('const { x: sx, z: sz } = o;\n').includes('const sx:* = o.x, sz:* = o.z;'));
  ok('array destructuring becomes index reads',
    as('const [p, q] = pair;\n').includes('const p:* = pair[0], q:* = pair[1];'));
  ok('an array hole skips its index',
    as('const [, second] = pair;\n').includes('const second:* = pair[1];'));
  ok('a call source is materialised once',
    as('const { a } = pick();\n').includes('const __d0:* = pick(); const a:* = __d0.a;'));
  ok('a default keeps the undefined test (typeof), not a null test',
    as('const { a = 5 } = o;\n').includes('const a:* = (typeof o.a === "undefined") ? 5 : o.a;'));
  ok('a shared declarator list is carried over',
    as('const { a } = o, b = 1;\n').includes('const a:* = o.a, b:* = 1;'));
  ok('a destructured parameter keeps its position and unpacks in the body',
    as('function f({ a, b }, c) { return a; }\n')
      .includes('function f(__p0:*, c:*):* { const a:* = __p0.a, b:* = __p0.b; return a; }'));
  ok('a whole-parameter default stays an explicit test',
    as('function f({ a = 2 } = {}) { return a; }\n').includes('if (typeof __p0 === "undefined") { __p0 = {}; }'));

  // ── The module boundary: the output is one file, so exports are stripped and
  // imports are refused (a file with imports is not self-contained).
  ok('`export function` keeps the function',
    as('export function f() { return 1; }\n').includes('function f():* { return 1; }'));
  ok('`export const` keeps the declaration',
    as('export const K = 1;\n').includes('const K:* = 1;'));
  ok('an `export { }` list is dropped and its line kept',
    as('function f() { return 1; }\nexport { f };\n').split('\n').length === 3);

  if (bad.length === 0) console.log(`[js2as/rewrites] 36 checks passed`);
  return bad;
}

function checkBenchmarkCorpus(): string[] {
  const bad: string[] = [];
  const ok = (label: string, cond: boolean): void => { if (!cond) bad.push(label); };

  const dir = join(root, 'benchmarks');
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(dir, d.name, `${d.name}.js`))
    .filter((p) => existsSync(p));
  ok('the corpus was found', files.length >= 8);

  for (const f of files) {
    const name = f.split(/[\\/]/).slice(-2)[0];
    const src = readFileSync(f, 'utf8');
    let out: string | null = null;
    let err: Js2AsError | null = null;
    try { out = jsToAs(src, f); } catch (e) { if (e instanceof Js2AsError) err = e; else throw e; }

    if (name === 'oop') {
      // The one sample written around `class`. A typed AS3 class is a hand port,
      // not a translation, so the tool must say so instead of faking it.
      ok('oop.js is refused by name (classes)', err !== null && err.message.includes('classes are not in the subset'));
      continue;
    }
    ok(`${name}.js translates`, out !== null);
    // jsToAs already ran the compiler's parser over `out`; reaching here means it
    // parsed. Pin the two rewrites that the corpus depends on, so a silent
    // regression in either pass shows up as a corpus failure and not as a
    // mysterious "translated output does not parse".
    ok(`${name}: no ` + '`let`' + ' survived', out !== null && !/(^|[^A-Za-z0-9_$])let\s/.test(out));
    ok(`${name}: no console.* call survived`, out !== null && !/\bconsole\s*\./.test(out));
  }

  if (bad.length === 0) console.log(`[js2as/benchmarks] ${files.length} files checked`);
  return bad;
}

registerGroup('unit: js2as/refusals', checkRefusals);
registerGroup('unit: js2as/rewrites', checkRewrites);
registerGroup('unit: js2as/benchmarks', checkBenchmarkCorpus);