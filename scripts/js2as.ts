// js2as: translate a RESTRICTED JavaScript subset into AS3 source.
//
// WHY A SUBSET AND NOT "JS SUPPORT". The AOT pipeline is a static AS3 compiler
// (lexer -> parser -> codegen -> C). Feeding it general JavaScript would mean
// modelling prototype chains, `this` rebinding at every call site, `arguments`,
// async/await and module resolution -- and every one of those lands as dynamic
// dispatches that are BOTH slower and easier to get subtly wrong than a hand port
// (AGENTS.md §0: a semantically wrong translation is worse than a missing feature).
// So this tool does the opposite of a general transpiler: it accepts exactly the
// constructs whose meaning is already identical in AS3, REFUSES everything else
// with a line:col, and leans on the fact that the demo's own engine already ships
// hand-written AS3 ports to compare against.
//
// WHY IT REUSES THE COMPILER'S LEXER. The interesting half of JS and the AS3 subset
// overlap almost entirely -- `function`, `for`, `if`, object/array literals,
// `===`, `typeof`, closures -- so inventing a second lexer would duplicate the one
// that defines what this compiler can actually compile. The translator therefore
// works at TOKEN level: lex with the compiler's own lexer, insert the type
// annotations AS3 demands, rewrite the handful of host calls, then hand the result
// back to the compiler's parser as a SELF-CHECK. If the output does not parse, the
// tool fails loudly instead of emitting something the picture of a compiler would
// then reject with a confusing message.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   * no type inference. Every binding is annotated `*` (AS3 dynamic), which is the
//     FAITHFUL mapping of a JS value (ES3 ToPrimitive, +, ==, boxing) and the
//     semantics the compiler already implements. An earlier revision inferred
//     `Number` for bindings whose every write was provably numeric; MEASURED, it
//     changed nothing (nbody 390 -> 394 ms, a pure 20M-iteration arithmetic loop
//     7 ms either way) because `-O2` already inlines the boxing away. What costs
//     the 400x is dynamic MEMBER access (`b[i].x`), which no local type inference
//     can fix -- see docs/zh-cn/js2as.md.
//   * no classes, arrow functions, destructuring, default/rest params, spread,
//     generators, async, for-of, `**`, optional chaining, ESM. Each is refused by
//     name so the message says what to rewrite.
//   * no `this` rewriting. A top-level function in the subset must not rely on a
//     caller-supplied `this`; that is a REFUSAL, not a silent difference.
//
// Run: node scripts/js2as.ts <input.js> [-o <output.as>]

import { readFileSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { lex } from '../src/lexer.ts';
import type { Token } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';

export class Js2AsError extends Error {
  line: number;
  col: number;
  constructor(message: string, line: number, col: number) {
    super(`js2as error at ${line}:${col}: ${message}`);
    this.name = 'Js2AsError';
    this.line = line;
    this.col = col;
  }
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

const HOST_CALLS: Record<string, string> = {
  // console.log/warn/error/info/debug -> trace. Both print their arguments
  // space-separated to the host's log, which is the only thing a translated sample
  // ever asks of them.
  'console.log': 'trace',
  'console.warn': 'trace',
  'console.error': 'trace',
  'console.info': 'trace',
  'console.debug': 'trace',
};

// Constructs that are refused BY NAME. Each entry is the token that must not
// appear; the message tells the author what to write instead. Ordered longest
// first where the detection is a token value, so `...` wins over `.`.
const REFUSED: { value: string; why: string }[] = [
  { value: '...', why: 'spread/rest is not in the subset' },
  { value: '**', why: 'the exponent operator is not in the subset; use Math.pow' },
  { value: 'class', why: 'classes are not in the subset; write an AS3 class with typed fields' },
  { value: 'import', why: 'imports are not in the subset (the file is not self-contained); translate a file that stands alone' },
  { value: 'async', why: 'async functions are not in the subset' },
  { value: 'await', why: 'await is not in the subset' },
  { value: 'yield', why: 'generators are not in the subset' },
  { value: 'arguments', why: 'the implicit `arguments` object has no AS3 equivalent in the subset' },
  { value: 'of', why: 'for-of is not in the subset; use an index loop (AS3 `for each` iterates values, not entries)' },
];

// The subset's one host mapping that is not a rename: a monotonic nanosecond
// counter. `Date` is the only clock the AS3 subset is guaranteed to have, and a
// benchmark only ever subtracts two readings, so wall-clock milliseconds scaled to
// nanoseconds keeps the arithmetic (and the printed result) identical. It is NOT
// monotonic -- that difference is stated here rather than hidden, because a
// translated benchmark that reports a negative duration would be a silent lie.
const HRTIME = '(new Date().getTime() * 1000000)';

// Counter for the `__dN` temporaries that materialise a non-identifier destructuring
// source. Reset per translation so the output is deterministic for a given input.
let destrTemp = 0;

export function jsToAs(source: string, file?: string): string {
  const where = file ?? '<js2as input>';
  // Text passes run before lexing, innermost-shape first: a template may contain an
  // arrow, an arrow may contain destructuring, and a destructuring rewrite emits only
  // plain declarations. Every rewrite here is faithful by construction (no dynamic
  // fallback), and an unsupported SHAPE is refused with a position rather than guessed.
  destrTemp = 0;
  const expanded = expandParams(expandArrows(
    expandTemplates(stripExports(source), where)));
  const destructured = expandDeclarations(expanded);
  const tokens = lex(destructured);
  const lineStarts = buildLineStarts(destructured);

  const offsetOf = (t: Token): number => (lineStarts[t.line - 1] ?? 0) + (t.col - 1);
  const edits: Edit[] = [];
  const insert = (at: number, text: string): void => { edits.push({ start: at, end: at, text }); };
  const replace = (start: number, end: number, text: string): void => { edits.push({ start, end, text }); };

  // Refusals first: a refused construct must be reported even if an earlier edit
  // would have produced something that happens to parse.
  checkRefusals(tokens);


  // Every function header is annotated FIRST, in one pass over all tokens. A function
  // expression sits inside a declarator initialiser, and the declarator pass has to
  // skip initialisers (that is how `var a = 1, b = 2` is told apart) -- so a
  // `(a, b) => ...` rewritten into a function inside `const f = (...)` would otherwise
  // keep untyped parameters, which AS3 then fills with its own default.
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].kind === 'ident' && tokens[k].value === 'function') {
      k = Math.max(k, annotateFunction(tokens, k, offsetOf, insert) - 1);
    }
  }

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const v = t.value;

    // `var` / `const` / `let`, all three of which the subset accepts. `let` becomes
    // `var`: AS3 has no block scope, and neither does `var` in the subset this tool
    // accepts (a `let` whose block a `var` would hoist out of is a semantic
    // difference the caller has to see -- noted in docs/zh-cn/js2as.md).
    if (t.kind === 'ident' && (v === 'var' || v === 'const' || v === 'let') &&
        tokens[i + 1]?.kind === 'ident') {
      if (v === 'let') replace(offsetOf(t), offsetOf(t) + v.length, 'var');
      i = annotateDeclarators(tokens, i, offsetOf, insert);
      continue;
    }

    i++;
  }

  // The host-call rewrites run as a SECOND pass over the whole token stream: the
  // annotation pass above skips over declarator initialisers (it has to, to tell
  // `var a = 1, b = 2` from one declarator), and `const t0 = process.hrtime...`
  // lives in exactly such an initialiser.
  i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const v = t.value;
    if (t.kind === 'ident' && v === 'console' && tokens[i + 1]?.value === '.' &&
        tokens[i + 2]?.kind === 'ident' && HOST_CALLS[`console.${tokens[i + 2].value}`]) {
      const name = tokens[i + 2];
      const end = offsetOf(name) + name.value.length;
      replace(offsetOf(t), end, HOST_CALLS[`console.${name.value}`]);
      i += 3;
      continue;
    }

    // process.hrtime.bigint() -> a millisecond clock scaled to nanoseconds.
    if (t.kind === 'ident' && v === 'process' && tokens[i + 1]?.value === '.' &&
        tokens[i + 2]?.value === 'hrtime' && tokens[i + 3]?.value === '.' &&
        tokens[i + 4]?.value === 'bigint' && tokens[i + 5]?.value === '(' &&
        tokens[i + 6]?.value === ')') {
      replace(offsetOf(t), offsetOf(tokens[i + 6]) + 1, HRTIME);
      i += 7;
      continue;
    }

    i++;
  }

  const out = applyEdits(destructured, edits);

  // Self-check: the translator is only allowed to emit something this compiler can
  // actually compile. A failure here is a bug in the translator, and reporting it as
  // such is the difference between "your JS uses a construct I do not support" and
  // "I produced broken AS3".
  if (process.env.ASC_JS2AS_DUMP) { process.stderr.write(out); process.stderr.write('\n'); }
  try {
    parse(out, `${where} (translated)`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Js2AsError(`translated output does not parse, which is a js2as bug: ${msg}`, 1, 1);
  }
  return out;
}

// ------------------------------------------------------------------ refusals

function checkRefusals(tokens: Token[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'eof') break;

    // Safety net only: `expandArrows` rewrites every arrow before lexing, so a `=>`
    // that survives means the text scanner had a blind spot (a regex literal, say).
    // The lexer has no `=>` symbol, so it arrives as `=` then `>`.
    if (t.value === '=' && tokens[i + 1]?.value === '>') {
      throw new Js2AsError('this arrow function was not rewritten (it sits where the text scan cannot see it)', t.line, t.col);
    }
    // Optional chaining `?.` / `?.[`.
    if (t.value === '?' && tokens[i + 1]?.value === '.') {
      throw new Js2AsError('optional chaining is not in the subset; guard with an explicit null test', t.line, t.col);
    }
    // `**` may arrive as two glued `*` tokens (the compiler's symbol table has no
    // `**`), which the table below cannot match -- its entry is the single-token
    // form. `a * *b` is not valid JS, so adjacency is the test that separates the
    // exponent operator from multiplication.
    if (t.value === '*' && tokens[i + 1]?.value === '*' && tokens[i + 1]?.col === t.col + 1) {
      throw new Js2AsError('the exponent operator is not in the subset; use Math.pow', t.line, t.col);
    }
    for (const r of REFUSED) {
      if (t.value !== r.value) continue;
      // `**` arrives either as one `**` symbol or as two glued `*` tokens,
      // depending on the compiler's symbol table; `a * *b` is not valid JS, so
      // adjacency is the test that separates the exponent from multiplication.
      if (r.value === '**') {
        const glued = t.value === '**' || (tokens[i + 1]?.value === '*' && tokens[i + 1]?.col === t.col + 1);
        if (!glued) continue;
      }
      // `of` is only reserved in a for-of header; elsewhere it is an identifier.
      if (r.value === 'of' && !insideForHeader(tokens, i)) continue;
      throw new Js2AsError(r.why, t.line, t.col);
    }

    // Safety net only, same reason as above: every supported destructuring shape is
    // rewritten to plain declarations before lexing. A pattern inside a `for (`
    // header is exempt -- there the real finding is the for-of itself, and it is
    // reported at the `of` token rather than as a leftover pattern here.
    if ((t.value === 'var' || t.value === 'const' || t.value === 'let') &&
        (tokens[i + 1]?.value === '{' || tokens[i + 1]?.value === '[') &&
        !insideForHeader(tokens, i + 1)) {
      throw new Js2AsError('this destructuring declaration was not rewritten (it sits where the text scan cannot see it)', t.line, t.col);
    }
  }
}

// True when token index i sits inside a `for (` header that closes after it.
// Scans backwards to the nearest unmatched `(` at the same nesting level and asks
// what precedes it -- a statement boundary aborts the scan, so a bare `of` further
// up the file cannot be mistaken for a for-of header.
function insideForHeader(tokens: Token[], i: number): boolean {
  let depth = 0;
  for (let k = i - 1; k >= 0; k--) {
    const v = tokens[k].value;
    if (v === ')' || v === ']' || v === '}') { depth++; continue; }
    if (v === '(') {
      if (depth === 0) return tokens[k - 1]?.value === 'for';
      depth--;
      continue;
    }
    if (v === '[' || v === '{') { depth--; continue; }
    // A statement boundary means this token is not inside any `for` header.
    if (depth === 0 && (v === ';' || v === '{' || v === '}' || v === 'for')) return false;
  }
  return false;
}

// ------------------------------------------------------- type annotations

// Annotate one `var`/`const` declarator list. AS3 requires a type; the default is
// `*` so the meaning is JS's dynamic value (never the compiler's `int` fallback),
// and the only exception is a name `promoteNumeric` proved numeric.
function annotateDeclarators(
  tokens: Token[], i: number,
  offsetOf: (t: Token) => number,
  insert: (at: number, text: string) => void,
): number {
  let j = i + 1;
  for (;;) {
    const id = tokens[j];
    if (id == null || id.kind !== 'ident') {
      throw new Js2AsError('declaration name is not a plain identifier (destructuring is not in the subset)', tokens[i].line, tokens[i].col);
    }
    if (tokens[j + 1]?.value !== ':') insert(offsetOf(id) + id.value.length, ':*');

    // Skip the initialiser up to the next declarator or the end of the statement.
    let depth = 0;
    j++;
    for (; j < tokens.length; j++) {
      const v = tokens[j].value;
      if (depth === 0 && (v === ',' || v === ';' || v === ')' || v === 'in')) break;
      if (v === '(' || v === '[' || v === '{') depth++;
      else if (v === ')' || v === ']' || v === '}') depth--;
    }
    if (tokens[j]?.value === ',') { j++; continue; }
    return j;
  }
}

// Annotate a function's parameter list and, when it has none, its return type.
function annotateFunction(
  tokens: Token[], i: number,
  offsetOf: (t: Token) => number,
  insert: (at: number, text: string) => void,
): number {
  let j = i + 1;
  if (tokens[j]?.kind === 'ident') j++;          // the function's own name
  if (tokens[j]?.value !== '(') return i + 1;     // not a function header (e.g. a call to `function`)

  j++;
  while (j < tokens.length && tokens[j].value !== ')') {
    const t = tokens[j];
    if (t.value === '...') throw new Js2AsError('rest parameters are not in the subset', t.line, t.col);
    if (t.kind !== 'ident') { j++; continue; }

    if (tokens[j + 1]?.value !== ':') insert(offsetOf(t) + t.value.length, ':*');
    j++;
    if (tokens[j]?.value === '=') {
      // Default values are supported by AS3 (`function f(a:int = 5)`), so the
      // expression is left as written and only the type is added above.
      let depth = 0;
      j++;
      for (; j < tokens.length; j++) {
        const v = tokens[j].value;
        if (depth === 0 && (v === ',' || v === ')')) break;
        if (v === '(' || v === '[' || v === '{') depth++;
        else if (v === ')' || v === ']' || v === '}') depth--;
      }
    }
    if (tokens[j]?.value === ',') j++;
  }
  if (tokens[j]?.value !== ')') {
    throw new Js2AsError('unterminated parameter list', tokens[i].line, tokens[i].col);
  }
  // Return type: AS3 needs one after the `)` of a definition.
  if (tokens[j + 1]?.value !== ':') insert(offsetOf(tokens[j]) + 1, ':*');
  return j + 1;
}

// ------------------------------------------------------------- module boundary

// The output is ONE AS3 file, so the module boundary has no meaning: `export { a, b };`
// is dropped and `export function f` becomes `function f`. Named entries therefore turn
// into ordinary top-level functions of the translated file, which is exactly what a
// single-file consumer needs.
//
// `import` stays refused: a file with imports is not self-contained, and inventing a
// module resolver here would be guessing at which side of the boundary a name lives.
// `export ... from` / `export default` / `export *` run into the same problem, so they
// are refused too rather than silently dropped (dropping them would delete code).
function stripExports(src: string): string {
  let out = src;
  for (let guard = 0; ; guard++) {
    const r = stripOneExport(out);
    if (r === null) return out;
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
    if (guard > 10000) throw new Js2AsError('too many export statements to strip', 1, 1);
  }
}

function stripOneExport(src: string): { start: number; end: number; text: string } | null {
  let i = 0;
  while (i < src.length) {
    const skip = skipNoise(src, i);
    if (skip !== i) { i = skip; continue; }
    if (!isWordAt(src, i, 'export')) { i++; continue; }

    const pos = posOf(src, i);
    let p = i + 'export'.length;
    while (p < src.length && isSpace(src[p])) p++;

    if (src[p] === '*') {
      throw new Js2AsError('`export *` is not in the subset (it needs the other module)', pos.line, pos.col);
    }
    if (isWordAt(src, p, 'default')) {
      throw new Js2AsError('`export default` is not in the subset; name the entry point', pos.line, pos.col);
    }
    if (src[p] === '{') {
      const close = matchDelimiter(src, p);
      let q = close + 1;
      while (q < src.length && isSpace(src[q])) q++;
      if (isWordAt(src, q, 'from')) {
        throw new Js2AsError('`export ... from` is not in the subset (it needs the other module)', pos.line, pos.col);
      }
      let end = q;
      while (end < src.length && (src[end] === ';' || src[end] === ' ' || src[end] === '\t')) end++;
      // Blank the statement (keeping its line) so every later position stays put.
      return { start: i, end, text: '' };
    }
    // `export const|let|var|function|class ...`: drop only the keyword, padded to its
    // own width so columns on that line do not move either.
    return { start: i, end: i + 'export'.length, text: ' '.repeat('export'.length) };
  }
  return null;
}

// ------------------------------------------------------------ arrow functions

// `(a, b) => expr` becomes `(function (a, b) { return expr; })`.
//
// AS3 HAS anonymous functions, so an arrow is expressible -- with one exception:
// an arrow's `this` is lexical while an AS3 anonymous function's `this` is the
// receiver of the call. There is no faithful rewrite for that, so a body that
// mentions `this`/`arguments`/`super` is REFUSED instead of silently rebound.
//
// The rewrite is textual and runs before lexing so that the existing annotation
// passes (which only look for the `function` keyword) type every parameter and the
// return slot. One arrow per iteration, leftmost first: a nested arrow survives as
// plain source inside the emitted body and is picked up by the next iteration, which
// keeps every reported position on the author's real line.
function expandArrows(src: string): string {
  let out = src;
  for (let guard = 0; ; guard++) {
    const next = expandOneArrow(out);
    if (next === null) return out;
    out = next;
    if (guard > 10000) throw new Js2AsError('too many arrow functions to rewrite', 1, 1);
  }
}

function expandOneArrow(src: string): string | null {
  const n = src.length;
  let i = 0;
  while (i < n) {
    const skip = skipNoise(src, i);
    if (skip !== i) { i = skip; continue; }
    if (src[i] === '=' && src[i + 1] === '>') break;
    i++;
  }
  if (i >= n) return null;
  const arrowAt = i;
  const pos = posOf(src, arrowAt);

  // Parameter list: `(a, b)` or a single bare `x`.
  let j = arrowAt - 1;
  while (j >= 0 && isSpace(src[j])) j--;
  let paramStart: number;
  let paramsText: string;
  if (j >= 0 && src[j] === ')') {
    paramStart = matchDelimiterBackwards(src, j);
    paramsText = src.slice(paramStart, j + 1);
  } else {
    const end = j + 1;
    while (j >= 0 && isIdentPart(src[j])) j--;
    if (end === j + 1) throw new Js2AsError('arrow function without a parameter list', pos.line, pos.col);
    paramStart = j + 1;
    paramsText = `(${src.slice(paramStart, end)})`;
  }

  // Body: a block stays a block; anything else becomes `return <expr>;`.
  let k = arrowAt + 2;
  while (k < n && isSpace(src[k])) k++;
  let bodyEnd: number;
  let bodyText: string;
  let block = false;
  if (src[k] === '{') {
    bodyEnd = matchDelimiter(src, k) + 1;
    bodyText = src.slice(k, bodyEnd);
    block = true;
  } else {
    bodyEnd = scanExpressionEnd(src, k);
    bodyText = src.slice(k, bodyEnd);
  }

  const banned = /(^|[^A-Za-z0-9_$])(this|arguments|super)([^A-Za-z0-9_$]|$)/.exec(stripNoise(bodyText));
  if (banned) {
    throw new Js2AsError(
      `\`${banned[2]}\` inside an arrow function has no faithful AS3 rewrite ` +
      '(an AS3 anonymous function rebinds it); write a named function', pos.line, pos.col);
  }

  const text = block
    ? `(function ${paramsText} ${bodyText})`
    : `(function ${paramsText} { return ${bodyText}; })`;
  return src.slice(0, paramStart) + text + src.slice(bodyEnd);
}

// ----------------------------------------------------------------- destructuring

// `const { a, b: c } = o;` becomes `const a = o.a, c = o.b;` and
// `const [x, , y] = arr;` becomes `const x = arr[0], y = arr[2];`.
//
// AS3 has no destructuring syntax, but property/element reads are the same
// operation, so the rewrite is faithful for the shapes that name a plain binding.
// Refused (each with a position): nested patterns, rest, computed keys, defaults on
// array holes, and sharing one statement with another declarator -- all cases where
// a text rewrite would have to guess at evaluation order.
//
// When the right-hand side is not a bare identifier it is materialised into a temp
// first, so `const { x } = pick()` calls `pick()` ONCE (as JS does), instead of once
// per destructured name.
function expandDeclarations(src: string): string {
  let out = src;
  for (let guard = 0; ; guard++) {
    const next = expandOneDeclaration(out);
    if (next === null) return out;
    out = next;
    if (guard > 10000) throw new Js2AsError('too many destructuring declarations to rewrite', 1, 1);
  }
}

function expandOneDeclaration(src: string): string | null {
  let i = 0;
  while (i < src.length) {
    const skip = skipNoise(src, i);
    if (skip !== i) { i = skip; continue; }
    const kw = ['var', 'const', 'let'].find((w) => isWordAt(src, i, w));
    if (kw === undefined) { i++; continue; }

    let p = i + kw.length;
    while (p < src.length && isSpace(src[p])) p++;
    if (src[p] !== '{' && src[p] !== '[') { i += kw.length; continue; }

    const { entries, end } = parseDestrPattern(src, p, 'destructuring declaration');
    let q = end + 1;
    while (q < src.length && isSpace(src[q])) q++;
    // No `=`: this is `for (const [k, v] of ...)`, which the for-of refusal owns.
    if (src[q] !== '=') { i = end + 1; continue; }

    const rhsStart = q + 1;
    const rhsEnd = scanDeclarationEnd(src, rhsStart);
    const whole = src.slice(rhsStart, rhsEnd);
    const pos = posOf(src, i);
    // `const { a } = o, b = 1;` -- what follows the first top-level comma is the
    // REST of the declarator list, and it is carried over verbatim so the statement
    // keeps its single declaration form.
    const comma = topLevelIndexOf(whole, ',');
    const rhs = (comma < 0 ? whole : whole.slice(0, comma)).trim();
    const tail = comma < 0 ? '' : whole.slice(comma + 1).trim();
    if (rhs === '') throw new Js2AsError('destructuring declaration without a value', pos.line, pos.col);

    const kwOut = kw === 'let' ? 'var' : kw;
    const bare = isPlainIdent(rhs);
    const base = bare ? rhs : `__d${destrTemp++}`;
    const decls = entries.map((e) => entryDeclaration(e, base)).join(', ')
      + (tail === '' ? '' : `, ${tail}`);
    const text = bare
      ? `${kwOut} ${decls}`
      : `${kwOut} ${base} = ${rhs}; ${kwOut} ${decls}`;
    return src.slice(0, i) + text + src.slice(rhsEnd);
  }
  return null;
}

// One destructured name as a declarator, reading either `base.key` or `base[i]`.
function entryDeclaration(e: DestrEntry, base: string): string {
  const read = e.key !== null ? `${base}.${e.key}` : `${base}[${e.index}]`;
  // A default fires on `undefined` only (not on null), which is `typeof` -- the
  // compiler has no `undefined` identifier to compare against.
  return e.def === null
    ? `${e.name} = ${read}`
    : `${e.name} = (typeof ${read} === "undefined") ? ${e.def} : ${read}`;
}

// `function f({ a, b }, c)` becomes `function f(__p0, c) { const a = __p0.a, b = __p0.b; ... }`.
//
// The prologue is injected at the top of the body so the parameters keep their
// positional identity for the caller, which is exactly what JS does; a destructured
// parameter with a whole-object default (`= {}`) keeps that default as an explicit
// `typeof` test on the raw parameter.
function expandParams(src: string): string {
  let out = src;
  for (let guard = 0; ; guard++) {
    const next = expandOneFunctionParams(out);
    if (next === null) return out;
    out = next;
    if (guard > 10000) throw new Js2AsError('too many destructured parameter lists to rewrite', 1, 1);
  }
}

function expandOneFunctionParams(src: string): string | null {
  let i = 0;
  while (i < src.length) {
    const skip = skipNoise(src, i);
    if (skip !== i) { i = skip; continue; }
    if (!isWordAt(src, i, 'function')) { i++; continue; }

    let p = i + 'function'.length;
    while (p < src.length && isSpace(src[p])) p++;
    if (p < src.length && /[A-Za-z_$]/.test(src[p])) {
      while (p < src.length && isIdentPart(src[p])) p++;
      while (p < src.length && isSpace(src[p])) p++;   // only named functions, not calls
    }
    if (src[p] !== '(') { i += 'function'.length; continue; }

    const close = matchDelimiter(src, p);
    const segments = splitTopLevel(src.slice(p + 1, close), p + 1);
    const holes = segments.filter((s) => /^[\s]*[\[{]/.test(s.text));
    if (holes.length === 0) { i = close + 1; continue; }

    // The body must follow the parameter list (arrows are already functions by now).
    let b = close + 1;
    while (b < src.length && isSpace(src[b])) b++;
    const pos = posOf(src, i);
    if (src[b] !== '{') {
      throw new Js2AsError('a destructured parameter needs a function body with braces', pos.line, pos.col);
    }

    const splices: Edit[] = [];
    const prologue: string[] = [];
    for (let h = 0; h < holes.length; h++) {
      const seg = holes[h];
      let s = seg.start;
      while (isSpace(src[s])) s++;
      const { entries, end } = parseDestrPattern(src, s, 'destructured parameter');
      let after = end + 1;
      while (after < seg.end && isSpace(src[after])) after++;
      let defaultText: string | null = null;
      if (src[after] === '=') defaultText = src.slice(after + 1, seg.end).trim();

      const raw = `__p${h}`;
      splices.push({ start: seg.start, end: seg.end, text: raw });
      if (defaultText !== null) {
        prologue.push(`if (typeof ${raw} === "undefined") { ${raw} = ${defaultText}; }`);
      }
      prologue.push(`${entries.map((e) => entryDeclaration(e, raw)).join(', ').replace(/^/, 'const ')};`);
    }
    splices.push({ start: b + 1, end: b + 1, text: ` ${prologue.join(' ')}` });
    return applyEdits(src, splices);
  }
  return null;
}

interface DestrEntry {
  key: string | null;   // object key, or null for an array index
  name: string;         // the binding
  index: number;        // array index when key is null
  def: string | null;   // default expression source
}

function parseDestrPattern(src: string, open: number, what: string): { entries: DestrEntry[]; end: number } {
  const isObject = src[open] === '{';
  const close = matchDelimiter(src, open);
  const pos = posOf(src, open);
  const entries: DestrEntry[] = [];
  let index = 0;

  for (const raw of splitTopLevel(src.slice(open + 1, close)).map((s) => s.text)) {
    const part = raw.trim();
    if (part === '') {
      if (!isObject) index++;         // `[a, , b]` skips an index
      continue;
    }
    if (part.startsWith('...')) {
      throw new Js2AsError(`rest in a ${what} is not in the subset`, pos.line, pos.col);
    }

    if (isObject) {
      const colon = topLevelIndexOf(part, ':');
      // `{ a = 5 }`: the default belongs to the binding, so it is split off before
      // the key is checked (`a = 5` is not an identifier).
      const eqFirst = colon < 0 ? topLevelIndexOf(part, '=') : -1;
      const left = (colon < 0
        ? (eqFirst < 0 ? part : part.slice(0, eqFirst))
        : part.slice(0, colon)).trim();
      const right = colon < 0 ? null : part.slice(colon + 1).trim();
      if (!isPlainIdent(left)) {
        throw new Js2AsError(
          `computed or nested key \`${left}\` in a ${what} is not in the subset`, pos.line, pos.col);
      }
      const body = right ?? part;
      const eq = topLevelIndexOf(body, '=');
      const name = (eq < 0 ? body : body.slice(0, eq)).trim();
      if (!isPlainIdent(name)) {
        throw new Js2AsError(
          `nested destructuring \`${body}\` is not in the subset; destructure one level at a time`,
          pos.line, pos.col);
      }
      entries.push({ key: left, name, index: -1, def: eq < 0 ? null : body.slice(eq + 1).trim() });
    } else {
      if (!isPlainIdent(part)) {
        throw new Js2AsError(
          `nested or defaulted array destructuring \`${part}\` is not in the subset; destructure one name at a time`,
          pos.line, pos.col);
      }
      entries.push({ key: null, name: part, index, def: null });
      index++;
    }
  }
  return { entries, end: close };
}

// ------------------------------------------------------------------- scanner

function isSpace(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function isIdentPart(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}

function isPlainIdent(text: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text);
}

// True when `word` starts at i and is not part of a longer identifier.
function isWordAt(src: string, i: number, word: string): boolean {
  if (!src.startsWith(word, i)) return false;
  if (i > 0 && isIdentPart(src[i - 1])) return false;
  return !isIdentPart(src[i + word.length]);
}

// Index just past a string or comment starting at i, or i when there is none.
function skipNoise(src: string, i: number): number {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl < 0 ? src.length : nl;
  }
  if (c === '/' && src[i + 1] === '*') {
    const close = src.indexOf('*/', i + 2);
    return close < 0 ? src.length : close + 2;
  }
  if (c === '"' || c === "'") return skipString(src, i);
  return i;
}

// Replace string and comment bodies with spaces so a keyword inside a literal
// cannot trigger a refusal (`"this is fine"` must not look like a `this` use).
function stripNoise(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const skip = skipNoise(text, i);
    if (skip !== i) { out += ' '.repeat(skip - i); i = skip; continue; }
    out += text[i];
    i++;
  }
  return out;
}

// Index of the closer matching the bracket at `open`, string/comment aware.
function matchDelimiter(src: string, open: number): number {
  const openCh = src[open];
  const closeCh = openCh === '{' ? '}' : openCh === '(' ? ')' : ']';
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const skip = skipNoise(src, i);
    if (skip !== i) { i = skip; continue; }
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) { depth--; if (depth === 0) return i; }
    i++;
  }
  throw new Js2AsError(`unterminated '${openCh}'`, posOf(src, open).line, 1);
}

// Index of the opener matching the closer at `close`. Scans backwards without
// string awareness, which is safe here because the only callers look at arrow
// parameter lists and `function (...)` headers -- identifier lists, not literals.
function matchDelimiterBackwards(src: string, close: number): number {
  const closeCh = src[close];
  const openCh = closeCh === ')' ? '(' : closeCh === '}' ? '{' : '[';
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (src[i] === closeCh) depth++;
    else if (src[i] === openCh) { depth--; if (depth === 0) return i; }
  }
  throw new Js2AsError(`unmatched '${closeCh}'`, posOf(src, close).line, 1);
}

// End of an arrow's expression body: the first `,`/`;` or closing bracket at depth 0.
function scanExpressionEnd(src: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const skip = skipNoise(src, i);
    if (skip !== i) { i = skip; continue; }
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--; i++; continue;
    }
    if (depth === 0 && (c === ',' || c === ';')) return i;
    i++;
  }
  return i;
}

// End of a declaration's initialiser: the first `;` (or newline) at depth 0. A `,`
// or a bare newline is returned as-is so the caller can refuse it.
function scanDeclarationEnd(src: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const skip = skipNoise(src, i);
    if (skip !== i) { i = skip; continue; }
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--; i++; continue;
    }
    if (depth === 0 && (c === ';' || c === '\n')) return i;
    i++;
  }
  return i;
}

interface Segment { text: string; start: number; end: number }

// Split on top-level commas. `base` shifts the reported offsets to the caller's
// coordinate space so a segment can be spliced back into the original string.
function splitTopLevel(text: string, base = 0): Segment[] {
  const out: Segment[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const skip = skipNoise(text, i);
    if (skip !== i) { i = skip; continue; }
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push({ text: text.slice(start, i), start: base + start, end: base + i });
      start = i + 1;
    }
    i++;
  }
  out.push({ text: text.slice(start), start: base + start, end: base + text.length });
  return out;
}

function topLevelIndexOf(text: string, ch: string): number {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const skip = skipNoise(text, i);
    if (skip !== i) { i = skip; continue; }
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ch && depth === 0) return i;
    i++;
  }
  return -1;
}

function posOf(src: string, at: number): { line: number; col: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < at && i < src.length; i++) {
    if (src[i] === '\n') { line++; lineStart = i + 1; }
  }
  return { line, col: at - lineStart + 1 };
}

// ------------------------------------------------------------ template literals

// Rewrite `a${x}b` into `("a" + (x) + "b")` BEFORE lexing, because the lexer has
// no template token (and adding one would put a JS-only feature in the compiler).
// The pass is string- and comment-aware so a backtick inside `'...'` or `// ...`
// is left alone, and it REFUSES a multi-line template: preserving line numbers is
// what keeps every later diagnostic pointing at the author's line.
function expandTemplates(src: string, where: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];

    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl < 0 ? n : nl;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close < 0 ? n : close + 2;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === '`') {
      const r = readTemplate(src, i, where);
      out += r.text;
      i = r.end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Index just past the closing quote of the string literal starting at `start`.
function skipString(src: string, start: number): number {
  const q = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === q) return i + 1;
    if (src[i] === '\n') return i;      // unterminated; let the lexer report it
    i++;
  }
  return i;
}

function readTemplate(src: string, start: number, where: string): { text: string; end: number } {
  void where;
  let i = start + 1;
  const parts: string[] = [];
  let chunk = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      // Escapes are handed through EXCEPT \` which AS3 does not know; a literal
      // backtick needs no escape inside an AS3 string.
      const nx = src[i + 1];
      if (nx === '`') chunk += '`';
      else chunk += c + (nx ?? '');
      i += 2;
      continue;
    }
    if (c === '`') {
      parts.push(chunk === '' ? '' : quote(chunk));
      return { text: joinParts(parts), end: i + 1 };
    }
    if (c === '\n') {
      throw new Js2AsError('multi-line template literals are not in the subset (line numbers must survive translation)', lineOf(src, start), 1);
    }
    if (c === '$' && src[i + 1] === '{') {
      parts.push(chunk === '' ? '' : quote(chunk));
      chunk = '';
      const exprEnd = matchBrace(src, i + 1);
      // An interpolation may contain a NESTED template literal
      // (`${a} · ${b} & ${c}` inside another `${}`), so the expression is expanded
      // recursively. Without this the inner backtick reached the lexer raw and
      // killed the run with `unexpected character '`'` instead of a located
      // message (measured on temp/slop-newyork/js/city-config.js:653).
      const expr = expandTemplates(src.slice(i + 2, exprEnd).trim(), where);
      if (expr === '') throw new Js2AsError('empty ${} interpolation', lineOf(src, i), 1);
      parts.push(`(${expr})`);
      i = exprEnd + 1;
      continue;
    }
    chunk += c;
    i++;
  }
  throw new Js2AsError('unterminated template literal', lineOf(src, start), 1);
}

function joinParts(parts: string[]): string {
  const kept = parts.filter((p) => p !== '');
  if (kept.length === 0) return '""';
  return `(${kept.join(' + ')})`;
}

// Escape a template chunk into an AS3 double-quoted string literal.
function quote(chunk: string): string {
  return '"' + chunk.replace(/"/g, '\\"') + '"';
}

// Index of the `}` matching the `{` at `open`.
function matchBrace(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipString(src, i); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  throw new Js2AsError('unterminated ${} interpolation', lineOf(src, open), 1);
}

function lineOf(src: string, at: number): number {
  let line = 1;
  for (let i = 0; i < at && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

// ------------------------------------------------------------------- helpers

function buildLineStarts(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}

function applyEdits(src: string, edits: Edit[]): string {
  const sorted = edits.slice().sort((a, b) => b.start - a.start || b.end - a.end);
  let out = src;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

// ----------------------------------------------------------------------- CLI

function main(argv: string[]): number {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log('usage: node scripts/js2as.ts <input.js> [-o <output.as>]');
    console.log('       (the subset is documented in docs/zh-cn/js2as.md)');
    return args.length === 0 ? 2 : 0;
  }
  const input = args[0];
  let output: string | null = null;
  const oi = args.indexOf('-o');
  if (oi >= 0 && args[oi + 1]) output = args[oi + 1];

  let src: string;
  try {
    src = readFileSync(input, 'utf8');
  } catch {
    console.error(`js2as: cannot read ${input}`);
    return 2;
  }
  let as: string;
  try {
    as = jsToAs(src, input);
  } catch (e) {
    if (e instanceof Js2AsError) { console.error(e.message); return 1; }
    throw e;
  }
  const header = `// Transpiled from ${input} by scripts/js2as.ts -- regenerate, do not hand-edit.\n`;
  if (output) {
    writeFileSync(output, header + as, 'utf8');
    console.log(`js2as: wrote ${output}`);
  } else {
    process.stdout.write(header + as);
  }
  return 0;
}

// Run only when this file is the entry point (it also exports jsToAs for tests).
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  process.exitCode = main(process.argv);
}