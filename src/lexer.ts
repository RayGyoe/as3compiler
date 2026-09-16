// Lexer: turns ActionScript source text into a token stream.

export type TokenKind = 'num' | 'str' | 'ident' | 'symbol' | 'regex' | 'eof';

export interface Token {
  kind: TokenKind;
  value: string; // ident: name; symbol: the symbol text; str: decoded value; regex: raw pattern
  num?: number;
  isInt?: boolean;
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
]);

const MULTI_SYMBOLS = ['==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '++', '--', '...', '>>>=', '<<=', '>>=', '&=', '|=', '^=', '>>>', '<<', '>>'];
const SINGLE_SYMBOLS = new Set('+-*/%<>=!(){}[];,. :?&|^~'.replace(/ /g, ''));

// Keywords that precede an operand (so a following `/` is a regex literal, not
// division): `return /re/`, `case /re/:`, `throw /re/`, `new /re/` (uncommon).
const PRE_OPERAND_KEYWORDS = new Set(['return', 'throw', 'case', 'new', 'void', 'delete', 'in']);

// Whether a `/` at this point starts a regex literal. A regex literal can only
// appear where an operand/expression is expected (start, after an operator, or
// after `(`/`[`/`{`/`,`/`;`/`=`/`:`). After a value (`)`/`]`/number/string/ident)
// a `/` is division. `++`/`--` are treated as value-ending (division follows),
// which matches the common `i++ / 2` case.
function canStartRegex(prev: Token | undefined): boolean {
  if (!prev) return true;
  if (prev.kind === 'num' || prev.kind === 'str' || prev.kind === 'regex') return false;
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
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (): string => {
    const ch = source[i++];
    if (ch === '\n') { line++; col = 1; } else { col++; }
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
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }
    // block comment; AS3 block comments nest
    if (ch === '/' && peek(1) === '*') {
      advance(); advance();
      let depth = 1;
      while (i < source.length && depth > 0) {
        if (source[i] === '/' && peek(1) === '*') { advance(); advance(); depth++; }
        else if (source[i] === '*' && peek(1) === '/') { advance(); advance(); depth--; }
        else advance();
      }
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
      tokens.push({ kind: 'num', value: text, num: Number(text), isInt, line: startLine, col: startCol });
      continue;
    }

    // string (single or double quoted)
    if (ch === '"' || ch === "'") {
      const quote = advance();
      let value = '';
      while (i < source.length && source[i] !== quote) {
        let c = advance();
        if (c === '\\') {
          const esc = advance();
          switch (esc) {
            case 'n': value += '\n'; break;
            case 't': value += '\t'; break;
            case 'r': value += '\r'; break;
            case '\\': value += '\\'; break;
            case '"': value += '"'; break;
            case "'": value += "'"; break;
            case '0': value += '\0'; break;
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

    // multi-char symbols
    let matched = false;
    for (const sym of MULTI_SYMBOLS) {
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
