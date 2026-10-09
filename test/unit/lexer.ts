// Unit checks: lexer diagnostics (block comments, string escapes).
// Moved verbatim out of the single-file test.ts (阶段九十六·一); each group
// still returns the list of failed labels and is registered as one node:test
// case, so it can be re-run alone with:
//   node --test --test-name-pattern='lexer/' test/unit/*.ts

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { lex } from '../../src/lexer.ts';
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { defaultBuildConfig, loadManifest, applyManifest, applyManifestOverlay, buildCompileCommand, buildCompileSteps, buildWebCompileSteps, effectiveDefines, validateFeatures, knownFeatures } from '../../src/build.ts';
import type { BuildConfig, Target, Manifest } from '../../src/build.ts';
import { airManifest, prepareAirApp } from '../../src/air-app.ts';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root, dir, EXAMPLE_TIMEOUT_MS } from '../harness.ts';

// ---- lexer diagnostics (阶段八十九·五十四) ----
// A block comment does NOT nest in AS3 (same as ES3/ES4): `/*` inside one is
// comment text, and the comment ends at the FIRST `*/`. Treating it as nesting
// once swallowed the rest of a real source file (a doc-comment containing
// `img/*.png`) and reported the error somewhere else entirely — a diagnosis
// pointed at the wrong line is the failure mode this pins. The unterminated case
// must fail loudly rather than silently swallow the rest of the file (§2.5).
// Checked at the lexer level, not as an example: the second case is a compile
// error, and the example suite only runs programs that must succeed.
function checkLexerDiagnostics(): string[] {
  const bad: string[] = [];
  const ok = (label: string, cond: boolean): void => {
    if (cond) console.log(`PASS  [lexer] ${label}`);
    else { bad.push(label); console.log(`FAIL  [lexer] ${label}`); }
  };
  const has = (src: string, name: string): boolean =>
    lex(src).some((t) => t.value === name && t.kind !== 'str');

  ok('a comment does not end at a bare *', has('/* a * b */ var kept:int = 1;', 'kept'));
  ok('a `/*` inside a block comment is comment text', has('/* img/*.png */ var kept:int = 1;', 'kept'));
  ok('a doc-comment with `/*` keeps every declaration after it',
    has('/** img/*.png */\nclass C {\n  private var a:int;\n}\nvar kept:int = 1;', 'kept'));
  ok('only the FIRST `*/` closes a block comment', has('/* one */ var a:int; /* two */ var kept:int;', 'kept'));
  ok('a `//` inside a block comment does not end it', has('/* // */ var kept:int = 1;', 'kept'));
  ok('a `/*` inside a line comment is inert', has('// /* var gone\nvar kept:int = 1;', 'kept'));
  ok('a `/*` inside a string literal is not a comment', has('var s:String = "/*"; var kept:int = 1;', 'kept'));
  ok('a `/*` inside a regex literal is not a comment', has('var r:RegExp = /a\\/*b/; var kept:int = 1;', 'kept'));

  // ---- 阶段九十四·十八：字符串字面量的转义序列（adl 实测，见 temp/escprobe）----
  // `\uXXXX`/`\xXX` 必须解码；`\b\f\v` 是单码元；未知转义保留字符本身；
  // `\0` 是字符 '0'（AS3 弃用 ES3 的八进制/NUL 转义）；`\`+换行是续行（无字符）；
  // 字符串里的裸换行是编译错误（mxmlc 同样拒绝）。
  const strVal = (src: string): string | undefined =>
    lex(src).find((t) => t.kind === 'str')?.value as string | undefined;
  ok('\\uXXXX decodes to the code unit and to the same UTF-8 bytes as the literal',
    strVal('var s:String = "\\u4f60\\u597d";') === '\u4f60\u597d');
  ok('a surrogate pair written as two \\u escapes reassembles',
    strVal('var s:String = "\\ud83d\\ude00";') === '\ud83d\ude00');
  ok('\\xXX takes exactly two hex digits, either case',
    strVal('var s:String = "\\x41\\x7a\\x4A\\x6b";') === 'AzJk');
  ok('\\b, \\f and \\v are single code units',
    strVal('var s:String = "\\b\\f\\v";') === String.fromCharCode(8, 12, 11));
  ok('an unknown escape keeps the character and drops the backslash',
    strVal('var s:String = "\\q\\z\\8";') === 'qz8');
  ok('\\0 is the character zero, not a NUL (AS3 dropped the ES3 octal escape)',
    strVal('var s:String = "p\\0q";') === 'p0q');
  ok('a backslash before a line terminator is a line continuation',
    strVal('var s:String = "a\\\nb";') === 'ab' && strVal('var s:String = "x\\\r\ny";') === 'xy');
  ok('\\t, \\n and \\r are still single escapes',
    strVal('var s:String = "\\t\\n\\r";') === '\t\n\r');
  ok('\\\\, \\" and \\\' still escape themselves',
    strVal('var s:String = "\\\\\\"\\\'";') === '\\"' + "'");
  let badU = false;
  try { lex('var s:String = "\\u12";'); } catch { badU = true; }
  ok('a \\u escape with fewer than four hex digits reports a LexError', badU);
  let badUHex = false;
  try { lex('var s:String = "\\u12g4";'); } catch { badUHex = true; }
  ok('a \\u escape with a non-hex digit reports a LexError', badUHex);
  let badX = false;
  try { lex('var s:String = "\\x4";'); } catch { badX = true; }
  ok('a \\x escape with fewer than two hex digits reports a LexError', badX);
  let bareNl = false;
  try { lex('var s:String = "raw\nnewline";'); } catch { bareNl = true; }
  ok('a raw line terminator inside a string reports a LexError (mxmlc rejects it too)', bareNl);

  let unterminated = false;
  try { lex('var x:int = 1; /* open'); } catch { unterminated = true; }
  ok('an unterminated block comment reports a LexError', unterminated);
  let lexThrew = false;
  try { lex('/* /* var x:int = 1;'); } catch { lexThrew = true; }
  ok('a nested-looking opener is still unterminated', lexThrew);

  if (bad.length === 0) console.log('[lexer] 22 diagnostics passed');
  return bad;
}

registerGroup('unit: lexer/LexerDiagnostics', checkLexerDiagnostics);

// ---- line terminators (阶段一百零五·一) ----
// AS3 accepts LF, CR and CRLF as line terminators -- mxmlc 51.4.1 compiles a
// CR-only source file (temp/crlf/CrDoc.as). Our lexer used to end a `//` comment
// only at LF, so a CR-only file had its first comment swallow the rest of the
// file and reported `expected '}' but found '<eof>'` -- measured on a real app
// source, src/com/vsdevelop/air/download/DownLoadManage.as (301 CRs, 0 LFs).
// These checks pin the terminator set AND the line numbering: CRLF must count as
// ONE break, otherwise every Windows-authored file would report doubled lines.
// Why a unit group and not an examples/*.as file (AGENTS.md §2.7): the property
// under test is a property of the INPUT BYTES, and a checked-in example can have
// its line endings normalized by any editor or VCS filter, silently turning the
// regression into a no-op. Passing the source as a string cannot drift.
function checkLineTerminators(): string[] {
  const bad: string[] = [];
  const ok = (label: string, cond: boolean): void => {
    if (cond) console.log(`PASS  [lineterm] ${label}`);
    else { bad.push(label); console.log(`FAIL  [lineterm] ${label}`); }
  };

  const vals = (src: string): string[] => lex(src).map((t) => t.value);
  // A `//` comment terminated by a CR: the code after it must still be tokenized.
  ok('a CR ends a // comment', vals('//c\rvar a:int = 1;\r').includes('var'));
  ok('a CRLF ends a // comment', vals('//c\r\nvar a:int = 1;\r\n').includes('var'));
  // A `//` comment at EOF (no terminator at all) is still just a comment.
  ok('a // comment at EOF needs no terminator', vals('var a:int = 1; //c').includes('a'));
  // CR-only source parses end to end (the real failure mode above).
  let parsed = true;
  try { parse('//c\rvar a:int = 1;\rtrace(a);\r'); } catch { parsed = false; }
  ok('a CR-only source file parses', parsed);

  const lineOf = (src: string, value: string): number | undefined =>
    lex(src).find((t) => t.value === value)?.line;
  ok('LF numbers lines 1,2,3', lineOf('a;\nb;\nc;', 'c') === 3);
  ok('CR numbers lines 1,2,3', lineOf('a;\rb;\rc;', 'c') === 3);
  ok('CRLF numbers lines 1,2,3 (a CRLF is ONE break)',
    lineOf('a;\r\nb;\r\nc;', 'c') === 3 && lineOf('a;\r\nb;\r\nc;', 'b') === 2);
  // A raw CR inside a string literal is as illegal as a raw LF (already pinned
  // for LF above); it must not become reachable by the new terminator handling.
  let rawCr = false;
  try { lex('var s:String = "raw\rcr";'); } catch { rawCr = true; }
  ok('a raw CR inside a string reports a LexError', rawCr);
  // ES3 LineContinuation still works with both terminators (\<CR><LF> and \<CR>).
  const strVal2 = (src: string): string | undefined => lex(src).find((t) => t.kind === 'str')?.value as string | undefined;
  ok('a backslash before CR/CRLF is a line continuation',
    strVal2('var s:String = "a\\\rb";') === 'ab' && strVal2('var s:String = "x\\\r\ny";') === 'xy');

  if (bad.length === 0) console.log('[lineterm] 9 checks passed');
  return bad;
}

registerGroup('unit: lexer/LineTerminators', checkLineTerminators);

// ---- E4X XML literals: a pretty-printed (multi-line) literal must lex (阶段一百零八) ----
// The XML-literal scanner skipped the text right after an OPEN tag but not the text
// between siblings, so `</a>` followed by a newline failed the scan. The literal
// then fell back to the `<` symbol and the `/` of the next close tag was lexed as a
// REGEX start -- the user-visible symptom was "unterminated regular expression"
// pointing at a perfectly valid literal (and worse, a program that lexed to
// nonsense instead of failing). Found while writing examples/e4x-name.as, whose
// literals are indented over several lines; pinned here because the example suite
// only covers the happy path of one particular spelling.
function checkXmlLiterals(): string[] {
  const bad: string[] = [];
  let n = 0;
  const ok = (label: string, cond: boolean): void => {
    if (cond) { n++; console.log(`PASS  [xmllit] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [xmllit] ${label}`); }
  };
  const xmlTok = (src: string): string | undefined => {
    const t = lex(src).find((v) => v.kind === 'xml');
    return t?.value;
  };
  const throws = (src: string): string | null => {
    try { lex(src); return null; } catch (e) { return (e as Error).message; }
  };

  // The reported spelling: one literal per line is fine, indented over many lines
  // must be too, and both must cover the WHOLE markup (close tag included).
  ok('a single-line nested literal lexes as one xml token',
    xmlTok('var x:XML = <items><item id="1">a</item></items>;') === '<items><item id="1">a</item></items>');
  const pretty = 'var x:XML =\n  <items xmlns:n="urn:x">\n    <n:item id="1">a</n:item>\n    <n:item id="2">b</n:item>\n  </items>;';
  ok('a pretty-printed (multi-line) literal lexes, close tag included',
    xmlTok(pretty)?.endsWith('</items>') === true && xmlTok(pretty)?.startsWith('<items') === true);
  ok('...and no longer reports the misleading "unterminated regular expression"',
    throws(pretty) === null);
  ok('the text between sibling elements is ordinary content',
    xmlTok('var x:XML = <a>t<b/>u</a>;') === '<a>t<b/>u</a>');
  ok('a self-closing tag may span lines',
    xmlTok('var x:XML =\n  <item\n    id="1"\n  />;')?.endsWith('/>') === true);
  ok('an attribute name may carry a namespace prefix',
    xmlTok('var x:XML = <a xmlns:n="urn:x" n:id="1"/>;') === '<a xmlns:n="urn:x" n:id="1"/>');
  ok('a comment inside the literal is part of it',
    xmlTok('var x:XML = <a><!-- c --><b/></a>;') === '<a><!-- c --><b/></a>');

  // The neighbors the scanner must NOT swallow: a real less-than and a generic
  // parameter list both stay symbols (this is why the scan is verified rather
  // than assumed from the `<` alone).
  ok('`a < b` is still a less-than, not an XML literal',
    xmlTok('var b:Boolean = 1 < 2;') === undefined && lex('var b:Boolean = 1 < 2;').some((t) => t.value === '<'));
  ok('Vector.<int> is still a generic parameter list',
    xmlTok('var v:Vector.<int> = new Vector.<int>();') === undefined
    && lex('var v:Vector.<int> = new Vector.<int>();').filter((t) => t.value === '<').length === 2);

  // An embedded expression is still rejected loudly rather than silently dropped
  // (§2.5): the subset cannot splice computed values into markup.
  ok('an embedded {expr} in a literal is still a loud LexError',
    /E4X embedded expressions/.test(throws('var x:XML = <a>{n}</a>;') ?? ''));

  if (bad.length === 0) console.log(`[xmllit] ${n} checks passed`);
  return bad;
}

registerGroup('unit: lexer/XmlLiteral', checkXmlLiterals);
