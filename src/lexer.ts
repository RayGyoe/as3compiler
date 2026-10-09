// Lexer: turns ActionScript source text into a token stream.

export type TokenKind = 'num' | 'str' | 'ident' | 'symbol' | 'regex' | 'xml' | 'eof';

export interface Token {
  kind: TokenKind;
  value: string; // ident: name; symbol: the symbol text; str: decoded value; regex: raw pattern; xml: raw literal markup
  num?: number;
  isInt?: boolean;
  // Set on a numeric literal carrying a 64-bit suffix (123L / 123UL): the
  // enhancement's opt-in literal form.
  width?: 'int64' | 'uint64';
  regexFlags?: string;
  line: number;
  col: number;
}

const KEYWORDS = new Set([
  'var', 'function', 'class', 'if', 'else', 'while', 'for', 'return',
  'new', 'this', 'true', 'false', 'null', 'void',
  'int', 'uint', 'Number', 'Boolean', 'String',
  'do', 'switch', 'case', 'default', 'break', 'continue',
  'extends', 'override', 'super',
  'public', 'private', 'protected', 'internal',
  'is', 'as',
  'Array', 'each', 'in',
  'const', 'static', 'get', 'set', 'final', 'interface', 'implements',
  'Function',
  'package', 'import',
  'throw', 'try', 'catch', 'finally',
  'namespace', 'use',
]);

const MULTI_SYMBOLS = ['===', '!==', '==', '!=', '<=', '>=', '||=', '&&=', '&&', '||', '??', '+=', '-=', '*=', '/=', '%=', '++', '--', '...', '..', '>>>=', '<<=', '>>=', '&=', '|=', '^=', '>>>', '<<', '>>', '::'];
const SINGLE_SYMBOLS = new Set('+-*/%<>=!(){}[];,. :?&|^~@'.replace(/ /g, ''));

// Keywords that precede an operand (so a following `/` is a regex literal, not
// division): `return /re/`, `case /re/:`, `throw /re/`, `new /re/` (uncommon).
const PRE_OPERAND_KEYWORDS = new Set(['return', 'throw', 'case', 'new', 'void', 'delete', 'in']);

// Whether a `<` at this point may start an E4X XML literal. Like a regex, an XML
// literal can only appear where an expression/operand is expected — after an
// operator or an operand-expecting keyword, never after a value. A `<` that
// follows `.` is a generic parameter list (`Vector.<T>`), and one after a value
// (`a < b`, `f() < g()`) is the less-than operator. Any candidate is additionally
// verified by actually scanning a well-formed element (scanXmlLiteral), so a
// stray `<` in expression position still falls back to the `<` symbol.
function canStartXml(prev: Token | undefined): boolean {
  if (!prev) return true;
  if (prev.kind === 'num' || prev.kind === 'str' || prev.kind === 'regex') return false;
  if (prev.kind === 'ident') return PRE_OPERAND_KEYWORDS.has(prev.value) || prev.value === 'typeof';
  switch (prev.value) {
    case ')': case ']': case '}': case '++': case '--': case '>': case '.': case '..':
      return false;
    default:
      return true;
  }
}

const XML_NAME_START = /[A-Za-z_:]/;
const XML_NAME_CHAR = /[A-Za-z0-9_.:-]/;
const XML_WS = /[ \t\r\n]/;

// Skip a `{ ... }` E4X embedded-expression group starting at `src[i] === '{'`,
// balancing nested braces and ignoring braces inside string literals. Returns the
// index just past the closing `}` (E4X literals have no escape for `{`), or -1.
function skipBraces(src: string, i: number): number {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      if (src[i] !== q) return -1;
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return -1;
}

// Scan an E4X XML literal starting at `src[start] === '<'` and return the index
// just past the matching close tag, or -1 when the text is not a well-formed XML
// literal (the caller then falls back to the `<` symbol). `interp` counts the
// `{expr}` embedded expressions seen; the caller rejects them loudly since this
// subset cannot yet splice computed values into a literal's markup.
function scanXmlLiteral(src: string, start: number): { end: number; interp: number } | -1 {
  let i = start;
  let interp = 0;
  const stack: string[] = [];

  const readName = (): string | -1 => {
    if (i >= src.length || !XML_NAME_START.test(src[i])) return -1;
    let s = '';
    while (i < src.length && XML_NAME_CHAR.test(src[i])) s += src[i++];
    return s;
  };

  // Skip over markup that has no content of its own (comments / CDATA / PIs).
  const skipDelimited = (open: string, close: string): boolean => {
    if (!src.startsWith(open, i)) return false;
    const e = src.indexOf(close, i + open.length);
    if (e < 0) return false;
    i = e + close.length;
    return true;
  };

  // Skip element content (text / nested markup) up to the next `<`, the point
  // where the outer loop takes over. Must run after an OPEN tag AND after a nested
  // CLOSE tag: the text between siblings is ordinary content, so a pretty-printed
  // (multi-line) literal is well-formed. Before, only the text right after an open
  // tag was skipped, so the newline in `<a><b/></a>`'s multi-line spelling
  // `<a>\n<b/>\n</a>` made the scan fail and the literal fall back to the `<`
  // symbol -- whose `</a>` slash was then lexed as a regex start, reporting the
  // misleading "unterminated regular expression".
  const skipContent = (): boolean => {
    for (;;) {
      if (src[i] === undefined) return false;
      if (src[i] === '<') return true;
      if (src[i] === '{') {
        const e = skipBraces(src, i);
        if (e === -1) return false;
        interp++;
        i = e;
        continue;
      }
      i++;
    }
  };

  for (;;) {
    if (src[i] !== '<') return -1; // text may not contain a raw '<'
    if (skipDelimited('<!--', '-->')) continue;
    if (skipDelimited('<![CDATA[', ']]>')) continue;
    if (skipDelimited('<?', '?>')) continue;
    if (src[i + 1] === '/') {
      // Close tag: must match the innermost open element.
      i += 2;
      const n = readName();
      if (n === -1 || stack.length === 0 || stack[stack.length - 1] !== n) return -1;
      stack.pop();
      while (XML_WS.test(src[i] ?? '')) i++;
      if (src[i] !== '>') return -1;
      i++;
      if (stack.length === 0) return { end: i, interp };
    } else {
      // Open tag.
      i++;
      const n = readName();
      if (n === -1) return -1;
      for (;;) {
        while (XML_WS.test(src[i] ?? '')) i++;
        if (src[i] === '/' && src[i + 1] === '>') { i += 2; break; } // self-closing
        if (src[i] === '>') { i++; stack.push(n); break; }
        const an = readName();
        if (an === -1) return -1;
        while (XML_WS.test(src[i] ?? '')) i++;
        if (src[i] !== '=') continue; // valueless attribute (not valid XML; tolerated here)
        i++;
        while (XML_WS.test(src[i] ?? '')) i++;
        const q = src[i];
        if (q === '"' || q === "'") {
          i++;
          while (i < src.length && src[i] !== q) i++;
          if (src[i] !== q) return -1;
          i++;
        } else if (q === '{') {
          // `attr={expr}` — an embedded expression in attribute position.
          const e = skipBraces(src, i);
          if (e === -1) return -1;
          interp++;
          i = e;
        } else {
          return -1;
        }
      }
      if (stack.length === 0) return { end: i, interp }; // the open tag was self-closing
    }
    if (!skipContent()) return -1;
  }
}

// Whether a `/` at this point starts a regex literal. A regex literal can only
// appear where an operand/expression is expected (start, after an operator, or
// after `(`/`[`/`{`/`,`/`;`/`=`/`:`). After a value (`)`/`]`/number/string/ident)
// a `/` is division. `++`/`--` are treated as value-ending (division follows),
// which matches the common `i++ / 2` case.
function canStartRegex(prev: Token | undefined): boolean {
  if (!prev) return true;
  if (prev.kind === 'num' || prev.kind === 'str' || prev.kind === 'regex' || prev.kind === 'xml') return false;
  if (prev.kind === 'ident') return PRE_OPERAND_KEYWORDS.has(prev.value);
  switch (prev.value) {
    case ')': case ']': case '++': case '--':
      return false;
    default:
      return true;
  }
}

export class LexError extends Error {
  line: number;
  col: number;
  constructor(message: string, line: number, col: number) {
    super(`Lex error at ${line}:${col}: ${message}`);
    this.line = line;
    this.col = col;
  }
}

export function lex(source: string): Token[] {
  // Strip a leading UTF-8 BOM (EF BB BF) so it is not read as a stray identifier
  // character (BitmapFont.as ships with one).
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  // Generic angle-bracket depth. `<` opens a generic parameter list only when it
  // follows `.` (Vector.<T>) or `new` (new <T>[]); a `<` after an operand is the
  // less-than operator. While depth > 0, a `>` is the list's closing bracket and
  // must NOT merge with a following `=`/`>` into `>=`/`>>`/`>>>` (those are real
  // operators only at depth 0), so `Vector.<String>=null` and nested
  // `Vector.<Vector.<T>>` lex correctly.
  let angleDepth = 0;

  const advance = (): string => {
    const ch = source[i++];
    // AS3 line terminators are LF, CR and CRLF (the ES4 grammar lists all three;
    // mxmlc compiles a CR-only file, temp/crlf/CrDoc.as). A CRLF pair must count as
    // ONE break, so the LF after a CR is consumed here -- otherwise every source
    // file authored with Windows line endings would report doubled line numbers.
    if (ch === '\n') { line++; col = 1; }
    else if (ch === '\r') { if (source[i] === '\n') i++; line++; col = 1; }
    else { col++; }
    return ch;
  };

  const peek = (n = 0): string => source[i + n] ?? '';

  while (i < source.length) {
    const ch = source[i];

    // whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance();
      continue;
    }

    // comments
    if (ch === '/' && peek(1) === '/') {
      // Ends at either terminator: a CR-only file would otherwise have its first
      // `//` comment swallow the rest of the file (that is exactly how
      // com/vsdevelop/air/download/DownLoadManage.as failed to parse).
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') advance();
      continue;
    }
    // block comment. AS3 block comments do NOT nest — verified against the
    // reference compiler: `/** glob: img/*.png */` inside a package compiles under
    // mxmlc, so the `/*` inside is ordinary text. Nesting therefore diverges from
    // AIR and, worse, fails SILENTLY: a doc comment that mentions a `*.png` glob
    // swallowed every line up to the next `*/`, and when the braces happened to
    // balance afterwards the rest of the file compiled as if it did not exist.
    // The comment now ends at the first `*/`, and running off the end is a loud
    // error instead of an unterminated comment that eats the file.
    if (ch === '/' && peek(1) === '*') {
      const cLine = line;
      const cCol = col;
      advance(); advance();
      let closed = false;
      while (i < source.length) {
        if (source[i] === '*' && peek(1) === '/') { advance(); advance(); closed = true; break; }
        advance();
      }
      if (!closed) throw new LexError('unterminated block comment', cLine, cCol);
      continue;
    }

    // regex literal: /pattern/flags — disambiguated from division `/` and
    // compound assignment `/=` by the preceding-token rule (canStartRegex) and
    // by skipping when the next char is `=` (handled as `/=` below).
    const startLine = line;
    const startCol = col;
    if (ch === '/' && peek(1) !== '=' && canStartRegex(tokens[tokens.length - 1])) {
      advance(); // opening '/'
      let pattern = '';
      let inClass = false;
      let closed = false;
      while (i < source.length) {
        const c = source[i];
        if (c === '\n' || c === '\r') throw new LexError('unterminated regular expression', startLine, startCol);
        if (c === '\\') {
          pattern += advance();
          if (i < source.length) pattern += advance();
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        if (c === '/' && !inClass) { advance(); closed = true; break; }
        pattern += advance();
      }
      if (!closed) throw new LexError('unterminated regular expression', startLine, startCol);
      let flags = '';
      while (/[a-z]/i.test(source[i] ?? '')) flags += advance();
      for (const f of flags) {
        if (!'gimsx'.includes(f)) throw new LexError(`invalid regular expression flag '${f}'`, startLine, startCol);
      }
      tokens.push({ kind: 'regex', value: pattern, regexFlags: flags, line: startLine, col: startCol });
      continue;
    }

    // number
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(peek(1)))) {
      // hexadecimal integer literal (0x...)
      if (ch === '0' && (peek(1) === 'x' || peek(1) === 'X')) {
        let text = advance() + advance(); // consume "0x"
        const digitsStart = i;
        while (/[0-9A-Fa-f]/.test(source[i])) text += advance();
        if (i === digitsStart) throw new LexError('malformed hexadecimal literal', startLine, startCol);
        tokens.push({ kind: 'num', value: text, num: parseInt(text.slice(2), 16), isInt: true, line: startLine, col: startCol });
        continue;
      }
      let text = '';
      while (/[0-9]/.test(source[i])) text += advance();
      let isInt = true;
      if (source[i] === '.') {
        isInt = false;
        text += advance();
        while (/[0-9]/.test(source[i])) text += advance();
      }
      if (source[i] === 'e' || source[i] === 'E') {
        isInt = false;
        text += advance();
        if (source[i] === '+' || source[i] === '-') text += advance();
        while (/[0-9]/.test(source[i])) text += advance();
      }
      // 64-bit integer suffix (opt-in enhancement -- AIR has no such suffix, so
      // a portable program cannot contain one): `123L` is an int64 literal and
      // `123UL`/`123LU` a uint64 one. The digits are kept verbatim (the token's
      // `value` is the source text) so the emitted C never routes them through a
      // double, which would round anything past 2^53.
      let width: 'int64' | 'uint64' | undefined;
      if (isInt && (source[i] === 'L' || source[i] === 'l')) {
        width = 'int64';
        advance();
        if (source[i] === 'U' || source[i] === 'u') { width = 'uint64'; advance(); }
      } else if (isInt && (source[i] === 'U' || source[i] === 'u')) {
        advance();
        if (source[i] === 'L' || source[i] === 'l') { width = 'uint64'; advance(); }
        else throw new LexError('unsigned suffix needs an L for a 64-bit literal', startLine, startCol);
      }
      tokens.push({ kind: 'num', value: text, num: Number(text), isInt, width, line: startLine, col: startCol });
      continue;
    }

    // string (single or double quoted)
    if (ch === '"' || ch === "'") {
      const quote = advance();
      let value = '';
      while (i < source.length && source[i] !== quote) {
        // A raw line terminator is not allowed inside a string literal -- AIR
        // rejects it at compile time ("syntax error: expected ; or newline",
        // measured with mxmlc 51.4.1, temp/escprobe/Raw.as), and accepting it would
        // silently swallow the rest of a broken literal. `\` + newline (the ES3
        // LineContinuation handled below) is still fine.
        if (source[i] === '\n' || source[i] === '\r') throw new LexError('unterminated string literal (line terminator in string)', startLine, startCol);
        let c = advance();
        if (c === '\\') {
          const esc = advance();
          switch (esc) {
            case 'n': value += '\n'; break;
            case 't': value += '\t'; break;
            case 'r': value += '\r'; break;
            // ES3 escape sequences AS3 inherits (ECMA-262 3rd ed. §7.8.4). \b/\f/\v
            // are single code units like \n/\t; \xXX is one code unit from two hex
            // digits and \uXXXX one from four -- both ERROR out when the digits are
            // not there (a SyntaxError in AIR too), which is the point: silently
            // keeping the escape's text was the bug this fixes. Measured on adl
            // 51.4.1 (temp/escprobe): "\u4f60\u597d".length is 2 and charCodeAt(0)
            // is 0x4F60, "\x41" is "A", "\q" is "q".
            case 'b': value += '\b'; break;
            case 'f': value += '\f'; break;
            case 'v': value += '\v'; break;
            case '\\': value += '\\'; break;
            case '"': value += '"'; break;
            case "'": value += "'"; break;
            // NOTE: no `case '0'`. AS3 inherits ES4, which dropped ES3's octal
            // escapes, so `\0` is an ordinary "unknown escape" that stands for the
            // character `0` -- measured on adl 51.4.1 (temp/escprobe): "p\0q".length
            // is 3 with codes 112, 48, 113, i.e. 'p','0','q'. Mapping it to a NUL
            // byte would both diverge and quietly truncate the C string.
            case 'u': {
              let hex = '';
              for (let k = 0; k < 4; k++) {
                const h = source[i];
                if (h === undefined || !/[0-9A-Fa-f]/.test(h)) throw new LexError('invalid \\u escape sequence', startLine, startCol);
                hex += advance();
              }
              // AS3 strings are UTF-16 code units, and so is the JS string this
              // lexer builds, so a surrogate pair written as two \u escapes
              // reassembles itself exactly as it would in AIR.
              value += String.fromCharCode(parseInt(hex, 16));
              break;
            }
            case 'x': {
              let hex = '';
              for (let k = 0; k < 2; k++) {
                const h = source[i];
                if (h === undefined || !/[0-9A-Fa-f]/.test(h)) throw new LexError('invalid \\x escape sequence', startLine, startCol);
                hex += advance();
              }
              value += String.fromCharCode(parseInt(hex, 16));
              break;
            }
            // ES3 LineContinuation: a backslash before a line terminator contributes
            // nothing (`\<LF>` and `\<CR><LF>` both).
            case '\n': break;
            // advance() has already consumed the LF of a CRLF pair, so nothing is
            // left to skip here.
            case '\r': break;
            default: value += esc;
          }
        } else {
          value += c;
        }
      }
      if (source[i] !== quote) throw new LexError('unterminated string literal', startLine, startCol);
      advance(); // closing quote
      tokens.push({ kind: 'str', value, line: startLine, col: startCol });
      continue;
    }

    // identifier / keyword
    if (/[A-Za-z_$]/.test(ch)) {
      let name = '';
      while (/[A-Za-z0-9_$]/.test(source[i])) name += advance();
      tokens.push({ kind: 'ident', value: name, line: startLine, col: startCol });
      continue;
    }

    // E4X XML literal: `<a/>`, `<items></items>`, `<x><y/></x>` in expression
    // position. Without this, the `<` fell through to the single-char branch and
    // the `/` of a close tag `</items>` was then lexed as a REGEX start (the
    // reported failure was "unterminated regular expression"). Only attempted
    // where an operand may start; a failed scan falls back to the `<` symbol, so
    // `a < b` in expression position is unaffected.
    if (ch === '<' && angleDepth === 0 && canStartXml(tokens[tokens.length - 1])) {
      const lit = scanXmlLiteral(source, i);
      if (lit !== -1) {
        const text = source.slice(i, lit.end);
        if (lit.interp > 0) {
          throw new LexError('E4X embedded expressions ({...}) inside XML literals are not supported by this subset', startLine, startCol);
        }
        for (let k = 0; k < text.length; k++) advance();
        tokens.push({ kind: 'xml', value: text, line: startLine, col: startCol });
        continue;
      }
    }

    // multi-char symbols
    let matched = false;
    // Inside a generic parameter list, `>` closes the bracket: emit it alone and
    // leave any following `=`/`>` for the next iteration (so `Vector.<T>=null`
    // and `Vector.<Vector.<T>>` don't collapse into `>=`/`>>`).
    if (angleDepth > 0 && ch === '>') {
      advance();
      tokens.push({ kind: 'symbol', value: '>', line: startLine, col: startCol });
      angleDepth--;
      continue;
    }
    for (const sym of MULTI_SYMBOLS) {
      // `:*=` — the `*` is AS3's untyped type annotation and `=` is a default
      // value separator, but the lexer would otherwise merge them into the
      // `*=` compound-assignment token. A `*=` following `:` can never be a
      // compound assignment (its left operand would have to be a value), so we
      // skip it here and let the single-char branch emit `*`, with `=` handled
      // on the next iteration.
      if (sym === '*=' && tokens.length > 0 && tokens[tokens.length - 1].value === ':') continue;
      if (source.startsWith(sym, i)) {
        for (let k = 0; k < sym.length; k++) advance();
        tokens.push({ kind: 'symbol', value: sym, line: startLine, col: startCol });
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // single-char symbols
    if (SINGLE_SYMBOLS.has(ch)) {
      advance();
      // A `<` after `.` (Vector.<) or `new` (new <T>[]) opens a generic list.
      const prev = tokens[tokens.length - 1];
      if (ch === '<' && prev && (prev.value === '.' || prev.value === 'new')) angleDepth++;
      tokens.push({ kind: 'symbol', value: ch, line: startLine, col: startCol });
      continue;
    }

    throw new LexError(`unexpected character '${ch}'`, startLine, startCol);
  }

  tokens.push({ kind: 'eof', value: '<eof>', line, col });
  return tokens;
}

export function isKeyword(name: string): boolean {
  return KEYWORDS.has(name);
}
