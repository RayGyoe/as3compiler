// Recursive-descent parser for the AS3 minimal subset.

import { lex, isKeyword } from './lexer.ts';
import type { Token } from './lexer.ts';
import type {
  Program, Stmt, Expr, Param, ASType, ClassMember, Block, SwitchCase, Visibility, InterfaceMethod, Metadata, CatchClause,
} from './ast.ts';

const TYPE_KEYWORDS = new Set(['int', 'uint', 'Number', 'Boolean', 'String', 'void', 'Array', 'Function']);

// Splice a file-top-level bare `{ ... }` block's body into the enclosing program
// body so class/interface/function declarations it wraps become top-level
// symbols. Recursive: a bare block may nest another bare block.
function flattenTopLevelBlocks(body: Stmt[]): Stmt[] {
  const out: Stmt[] = [];
  for (const s of body) {
    if (s.kind === 'Block') {
      for (const inner of flattenTopLevelBlocks(s.body)) out.push(inner);
    } else {
      out.push(s);
    }
  }
  return out;
}


const BIN_PREC: Record<string, number> = {
  // `??` binds looser than every other binary operator (JS puts null-coalescing
  // below `||`; `a ?? b || c` therefore parses as `a ?? (b || c)`).
  '??': 0,
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6, '!=': 6, '===': 6, '!==': 6,
  '<': 7, '<=': 7, '>': 7, '>=': 7,
  '<<': 8, '>>': 8, '>>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
};

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '||=', '&&=']);

// Keywords that may immediately follow bracket metadata ([WasmExport] function...,
// [WasmExport] class..., [WasmExport] static function..., ...). Used to tell a
// metadata sequence apart from an array-literal expression statement.
const METADATA_DECL = new Set([
  'function', 'class', 'interface', 'var', 'const',
  'final', 'public', 'internal', 'dynamic', 'static', 'override', 'private', 'protected',
]);

export class ParseError extends Error {
  token: Token;
  constructor(message: string, token: Token) {
    super(`Parse error at ${token.line}:${token.col}: ${message}`);
    this.token = token;
  }
}

export function parse(source: string): Program {
  return new Parser(lex(source)).parseProgram();
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  private imports: string[] = [];
  private currentPackage: string | null = null;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(n = 0): Token {
    return this.tokens[Math.min(this.pos + n, this.tokens.length - 1)];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  // Match the current token against an expected value. The token `value` alone is
  // NOT an identity: the string literal `"]"` carries the same `value` as the `]`
  // symbol, so a bare value comparison made `[ "]" ]` look like an empty array
  // (and let `[ "[" ]` pass by luck), and a stray `"]"` in any token stream could
  // masquerade as a terminator. Word-like values (`function`, `package`, …) are
  // always `ident` tokens (this lexer has no separate keyword kind); every other
  // value is a `symbol`. Require the matching kind so only the real token matches.
  private at(value: string): boolean {
    const t = this.peek();
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
    return t.value === value && t.kind === (word ? 'ident' : 'symbol');
  }

  private atIdent(name: string): boolean {
    const t = this.peek();
    return t.kind === 'ident' && t.value === name;
  }

  private expect(value: string): Token {
    if (!this.at(value)) {
      throw new ParseError(`expected '${value}' but found '${this.peek().value}'`, this.peek());
    }
    return this.next();
  }

  private expectIdent(): Token {
    const t = this.peek();
    if (t.kind !== 'ident') throw new ParseError(`expected identifier but found '${t.value}'`, t);
    return this.next();
  }

  // Whether a line terminator separates the previously consumed token from the
  // current token. AS3 automatic semicolon insertion (ASI, ECMA-262 §7.9) uses
  // this to decide whether a statement may omit its trailing `;`. The lexer only
  // increments `line` on `\n` (which also covers `\r\n`), so comparing line
  // numbers detects the common newline cases.
  private hadLineTerminator(): boolean {
    if (this.pos === 0) return false;
    return this.peek().line > this.tokens[this.pos - 1].line;
  }

  // Consume a statement-terminating `;`, applying ASI: the `;` may be omitted when
  // the next token is `}`, end-of-input, or separated from the previous token by a
  // line terminator. Otherwise it is a syntax error.
  private consumeSemicolon(): void {
    if (this.at(';')) { this.next(); return; }
    if (this.at('}')) return;               // `}` terminates the statement (rule 1)
    if (this.peek().kind === 'eof') return; // end-of-input terminates (rule 2)
    if (this.hadLineTerminator()) return;   // newline before offending token (rule 1)
    throw new ParseError(`expected ';' but found '${this.peek().value}'`, this.peek());
  }

  private parseType(): ASType {
    // `*` is AS3's untyped type, which this subset models as the dynamic `any`.
    if (this.at('*')) { this.next(); return 'any'; }
    const t = this.expectIdent();
    if (TYPE_KEYWORDS.has(t.value)) return t.value as ASType;
    // Vector.<T> — type-safe generic array.
    if (t.value === 'Vector' && this.at('.') && this.peek(1).value === '<') {
      this.next(); // '.'
      this.next(); // '<'
      const elem = this.parseType();
      this.expect('>');
      return `Vector.<${elem}>`;
    }
    // Fully-qualified class name: `flash.display3D.textures.Texture`. A bare
    // identifier is a short class name (object type) resolved later.
    let name = t.value;
    while (this.at('.') && this.peek(1).kind === 'ident') {
      this.next();
      name += '.' + this.expectIdent().value;
    }
    return name;
  }

  // A dot-separated qualified name (`flash.display3D.textures.Texture`), used for
  // `is`/`as` target type names where a full package path is required.
  private parseQualifiedName(): string {
    let name = this.expectIdent().value;
    while (this.at('.') && this.peek(1).kind === 'ident') {
      this.next();
      name += '.' + this.expectIdent().value;
    }
    return name;
  }

  // ---- program ----

  parseProgram(): Program {
    const body: Stmt[] = [];
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'ident' && t.value === 'import') {
        this.parseImport();
      } else if (t.kind === 'ident' && t.value === 'package') {
        this.parsePackage(body); // parse package body, attaching its namespace
      } else {
        body.push(this.parseStatement());
      }
    }
    // AS3 allows a bare `{ ... }` block at file top level to wrap helper class
    // declarations (e.g. Adobe's AGALMiniAssembler.as). At module scope a bare
    // block is a pure scope container with no runtime effect, so we splice its
    // body into the top level — class/interface/function declarations then land
    // directly in program.body where symbol collection and code emission expect
    // them. Only top-level blocks are flattened (never those inside functions).
    return { body: flattenTopLevelBlocks(body), imports: this.imports };
  }

  // `import a.b.C;` or `import a.b.*;` — record the imported qualified name for
  // symbol resolution across files/namespaces.
  private parseImport(): void {
    this.expect('import');
    let path = this.expectIdent().value;
    while (this.at('.')) {
      this.next();
      if (this.at('*')) { this.next(); break; }
      path += '.' + this.expectIdent().value;
    }
    this.expect(';');
    this.imports.push(path);
  }

  // `package a.b.c { ... }` — parse the qualified name, then parse the body with
  // that namespace attached to its declarations (for cross-file resolution).
  // AS3 also allows an unnamed package (`package { ... }`), which is the default
  // package; its name is the empty string.
  private parsePackage(body: Stmt[]): void {
    this.expect('package');
    let pkg = '';
    if (!this.at('{')) {
      pkg = this.expectIdent().value;
      while (this.at('.')) {
        this.next();
        pkg += '.' + this.expectIdent().value;
      }
    }
    this.expect('{');
    const saved = this.currentPackage;
    this.currentPackage = pkg;
    while (!this.at('}') && this.peek().kind !== 'eof') {
      const before = this.pos;
      if (this.atIdent('import')) {
        this.parseImport();
      } else if (this.at('[')) {
        // Flash metadata at package level ([SWF(...)], [Frame(...)], etc.) configures
        // the .swf (size/framerate/background) and has no runtime effect for the AOT
        // translation, so it is parsed and discarded. At package level a leading '['
        // is always metadata (there is no array-literal statement here), so we
        // consume it unconditionally instead of backtracking.
        //
        // BUT: declaration metadata ([WasmExport], [Embed], ...) must not be thrown
        // away with it — `package p { [WasmExport] function f() {} }` silently lost
        // the export because this branch ate the metadata before the declaration
        // was parsed. So consume the block, then rewind and let parseStatement()
        // handle the whole `[meta] decl` when a declaration actually follows.
        const save = this.pos;
        this.parseMetadataIfPresent(false);
        const nxt = this.peek();
        if (nxt.kind === 'ident' && METADATA_DECL.has(nxt.value)) {
          this.pos = save;
          body.push(this.parseStatement());
        }
      } else {
        body.push(this.parseStatement());
      }
      // Loop-progress sentinel: every branch above must consume at least one
      // token. The metadata branch can rewind to its start when parsing fails
      // (parseMetadataIfPresent restores `pos` on an unexpected literal), which
      // would leave `[` as the current token forever — a silent infinite loop.
      // Report a syntax error instead (AGENTS.md §2.5: never hang, never
      // swallow); a hang is far harder to diagnose than a positioned error.
      if (this.pos === before) {
        throw new ParseError(`unexpected token '${this.peek().value}' in package body`, this.peek());
      }
    }
    this.expect('}');
    this.currentPackage = saved;
  }

  // ---- statements ----

  // Every statement (top level, block, loop body, class body via parseStatement at
  // the top level, ...) funnels through here, so this is the one choke point where
  // the starting token is still known. Stamp the position onto the node so the
  // semantic layer can point a `CodegenError` at the offending construct
  // (AGENTS.md §2.5). Nodes built by a wrapper (e.g. a Block returned for `;`) just
  // get the position of the token the statement started at.
  private parseStatement(): Stmt {
    const t = this.peek();
    const node = this.parseStatementInner();
    if (node.line === undefined) { node.line = t.line; node.col = t.col; }
    return node;
  }

  private parseStatementInner(): Stmt {
    const t = this.peek();

    if (t.kind === 'symbol') {
      if (t.value === '{') return this.parseBlock();
      if (t.value === ';') { this.next(); return { kind: 'Block', body: [] }; }
    }

    // AS3 bracket metadata ([WasmExport] etc.) precedes a declaration. Only a `[`
    // followed by an identifier is treated as metadata; anything else (an array
    // literal expression statement) is left untouched by parseMetadataIfPresent.
    const metadata = this.parseMetadataIfPresent();
    if (metadata.length > 0) {
      if (this.atIdent('function')) return this.parseFuncDecl(metadata);
      if (this.atIdent('class')) return this.parseClassDecl(false, metadata, false);
      if (this.atIdent('interface')) return this.parseInterfaceDecl();
      if (this.atIdent('final') || this.atIdent('public') || this.atIdent('internal') || this.atIdent('dynamic')) {
        let isFinal = false;
        let isDynamic = false;
        while (this.atIdent('final') || this.atIdent('public') || this.atIdent('internal') || this.atIdent('dynamic')) {
          const mod = this.next().value;
          if (mod === 'final') isFinal = true;
          else if (mod === 'dynamic') isDynamic = true;
        }
        if (this.atIdent('class')) return this.parseClassDecl(isFinal, metadata, isDynamic);
        if (this.atIdent('interface')) return this.parseInterfaceDecl();
      }
      throw new ParseError(`metadata must precede a function/class/interface declaration`, this.peek());
    }

    if (t.kind === 'ident') {
      if (t.value === 'var') return this.parseVarDeclStmt();
      if (t.value === 'const') return this.parseConstDeclStmt();
      if (t.value === 'if') return this.parseIf();
      if (t.value === 'while') return this.parseWhile();
      if (t.value === 'with') return this.parseWith();
      if (t.value === 'do') return this.parseDoWhile();
      if (t.value === 'for') return this.parseFor();
      if (t.value === 'switch') return this.parseSwitch();
      if (t.value === 'break') return this.parseBreak();
      if (t.value === 'continue') return this.parseContinue();
      if (t.value === 'return') return this.parseReturn();
      if (t.value === 'throw') return this.parseThrow();
      if (t.value === 'try') return this.parseTry();
      if (t.value === 'super' && this.peek(1).value === '(') return this.parseSuperStmt();
      if (t.value === 'use') return this.parseUseNamespace();
      if (t.value === 'namespace') return this.parseNamespaceDecl();
      if (t.value === 'function') return this.parseFuncDecl();
      if (t.value === 'class') return this.parseClassDecl(false, [], false);
      if (t.value === 'interface') return this.parseInterfaceDecl();
      // class/interface modifiers: `public`, `internal`, `dynamic`, `final`.
      // Visibility is governed by the package context; `final` and `dynamic`
      // are real traits and are recorded on the ClassDecl.
      if (t.value === 'final' || t.value === 'public' || t.value === 'internal' || t.value === 'dynamic') {
        let isFinal = false;
        let isDynamic = false;
        while (this.atIdent('final') || this.atIdent('public') || this.atIdent('internal') || this.atIdent('dynamic')) {
          const mod = this.next().value;
          if (mod === 'final') isFinal = true;
          else if (mod === 'dynamic') isDynamic = true;
        }
        if (this.atIdent('class')) return this.parseClassDecl(isFinal, [], isDynamic);
        if (this.atIdent('interface')) return this.parseInterfaceDecl();
        if (this.atIdent('namespace')) return this.parseNamespaceDecl();
        if (this.atIdent('function')) return this.parseFuncDecl();
      }
    }

    // labeled statement: `label: statement` (a non-keyword identifier followed by ':').
    if (t.kind === 'ident' && !isKeyword(t.value) && this.peek(1).value === ':') {
      const name = this.next().value;
      this.next(); // ':'
      const body = this.parseStatement();
      return { kind: 'Label', name, body };
    }

    // fall through: expression statement
    const expr = this.parseExpression();
    this.consumeSemicolon();
    return { kind: 'ExprStmt', expr };
  }

  // Parse leading AS3 bracket metadata: `[Name]` or `[Name("a", "b")]`, repeated
  // (`[A][B]`). Returns [] when there is no metadata. A sequence that is not
  // followed by a declaration keyword (e.g. an array literal expression
  // statement) restores the token position and returns [] so the caller parses it
  // as an expression instead.
  private parseMetadataIfPresent(requireDecl = true): Metadata[] {
    const saved = this.pos;
    if (!this.at('[') || this.peek(1).kind !== 'ident') return [];
    const list: Metadata[] = [];
    try {
      while (this.at('[')) {
        this.next(); // '['
        const name = this.expectIdent().value;
        const args: string[] = [];
        const named: Record<string, string> = {};
        if (this.at('(')) {
          this.next();
          if (!this.at(')')) {
            do {
              // Flash metadata uses either positional args (`[WasmExport("x")]`) or
              // named args (`[SWF(width = "1000")]`, `[Embed(source="a.png")]`).
              // Both are collected as raw strings for later filtering; the `key =`
              // prefix is dropped from `args` so the value is what gets recorded
              // positionally, and KEPT in `named` — `[Embed]` is keyed metadata
              // (`source`/`mimeType`), so a consumer that only sees values cannot
              // tell `source` from `mimeType`.
              // Metadata arguments are literals: strings, identifiers/keywords
              // (`true`, `null`, an unquoted enum name) or numbers. Flash metadata
              // routinely uses unquoted numbers — `[SWF(frameRate = 60)]` — and
              // rejecting them used to abort the whole metadata block (which at
              // package level then spun the loop; see parsePackage).
              const a = this.next();
              if (a.kind === 'str' || a.kind === 'ident' || a.kind === 'num') {
                if (this.at('=')) {
                  this.next(); // '='
                  const v = this.next();
                  if (v.kind === 'str' || v.kind === 'ident' || v.kind === 'num') {
                    args.push(v.value);
                    named[a.value] = v.value;
                  } else throw new ParseError(`expected metadata value but found '${v.value}'`, v);
                } else {
                  args.push(a.value);
                }
              } else {
                throw new ParseError(`expected metadata argument but found '${a.value}'`, a);
              }
            } while (this.at(',') && (this.next(), true));
          }
          this.expect(')');
        }
        this.expect(']');
        list.push(Object.keys(named).length > 0 ? { name, args, named } : { name, args });
      }
      const nxt = this.peek();
      if (requireDecl && !(nxt.kind === 'ident' && METADATA_DECL.has(nxt.value))) {
        this.pos = saved;
        return [];
      }
      return list;
    } catch {
      this.pos = saved;
      return [];
    }
  }

  private parseBlock(): Block {
    this.expect('{');
    const body: Stmt[] = [];
    while (!this.at('}') && this.peek().kind !== 'eof') {
      body.push(this.parseStatement());
    }
    this.expect('}');
    return { kind: 'Block', body };
  }

  // Parse a single `name[: Type][= init]` declarator (the leading `var` is
  // already consumed). Shared by var statements and the C-style for init.
  private parseVarDeclarator(): { name: string; type: ASType | null; init: Expr | null } {
    const name = this.expectIdent().value;
    let type: ASType | null = null;
    let init: Expr | null = null;
    if (this.at(':')) {
      this.next();
      type = this.parseType();
    }
    if (this.at('=')) {
      this.next();
      init = this.parseAssignment(); // a separator context: no comma operator
    }
    return { name, type, init };
  }

  private parseVarDeclCore(): { name: string; type: ASType | null; init: Expr | null } {
    this.expect('var');
    return this.parseVarDeclarator();
  }

  private parseVarDeclStmt(): Stmt {
    this.expect('var');
    const decls: { name: string; type: ASType | null; init: Expr | null }[] = [this.parseVarDeclarator()];
    // AS3 multi-declarator: `var a:T, b:T, c:*;` declares several variables in
    // one statement. Emitted as a flat VarDecls node — `var` is function-scoped
    // in AS3, so the declarators must NOT be wrapped in a block scope.
    while (this.at(',')) {
      this.next();
      decls.push(this.parseVarDeclarator());
    }
    this.consumeSemicolon();
    return decls.length === 1 ? { kind: 'VarDecl', ...decls[0] } : { kind: 'VarDecls', decls };
  }

  private parseConstDeclStmt(): Stmt {
    this.expect('const');
    const decls: { name: string; type: ASType | null; init: Expr | null }[] = [];
    do {
      const name = this.expectIdent().value;
      let type: ASType | null = null;
      if (this.at(':')) {
        this.next();
        type = this.parseType();
      }
      this.expect('='); // const must have an initializer
      const init = this.parseAssignment();
      decls.push({ name, type, init });
      if (this.at(',')) this.next();
      else break;
    } while (true);
    this.consumeSemicolon();
    return decls.length === 1 ? { kind: 'ConstDecl', ...decls[0] } : { kind: 'ConstDecls', decls };
  }

  private parseIf(): Stmt {
    this.expect('if');
    this.expect('(');
    const cond = this.parseExpression();
    this.expect(')');
    const then = this.parseStatement();
    let elseBranch: Stmt | null = null;
    if (this.atIdent('else')) {
      this.next();
      elseBranch = this.parseStatement();
    }
    return { kind: 'If', cond, then, else: elseBranch };
  }

  private parseWhile(): Stmt {
    this.expect('while');
    this.expect('(');
    const cond = this.parseExpression();
    this.expect(')');
    const body = this.parseStatement();
    return { kind: 'While', cond, body };
  }

  // `with (object) statement` — pure syntax here; all of the (very specific)
  // object-scope resolution semantics live in the codegen semantic layer.
  private parseWith(): Stmt {
    this.expect('with');
    this.expect('(');
    const obj = this.parseExpression();
    this.expect(')');
    const body = this.parseStatement();
    return { kind: 'With', obj, body };
  }

  private parseDoWhile(): Stmt {
    this.expect('do');
    const body = this.parseStatement();
    this.expect('while');
    this.expect('(');
    const cond = this.parseExpression();
    this.expect(')');
    this.consumeSemicolon();
    return { kind: 'DoWhile', cond, body };
  }

  private parseSwitch(): Stmt {
    this.expect('switch');
    this.expect('(');
    const disc = this.parseExpression();
    this.expect(')');
    this.expect('{');
    const cases: SwitchCase[] = [];
    while (!this.at('}') && this.peek().kind !== 'eof') {
      let test: Expr | null = null;
      if (this.atIdent('case')) {
        this.next();
        test = this.parseExpression();
        this.expect(':');
      } else if (this.atIdent('default')) {
        this.next();
        this.expect(':');
      } else {
        throw new ParseError(`expected 'case' or 'default' but found '${this.peek().value}'`, this.peek());
      }
      const body: Stmt[] = [];
      while (!this.atIdent('case') && !this.atIdent('default') && !this.at('}') && this.peek().kind !== 'eof') {
        body.push(this.parseStatement());
      }
      cases.push({ test, body });
    }
    this.expect('}');
    return { kind: 'Switch', disc, cases };
  }

  private parseBreak(): Stmt {
    this.expect('break');
    let label: string | null = null;
    // Restricted production `break [no LineTerminator here] Identifier` — a label
    // is only attached when it is on the same line as `break`.
    if (!this.at(';') && !this.hadLineTerminator()) label = this.expectIdent().value;
    this.consumeSemicolon();
    return { kind: 'Break', label };
  }

  private parseContinue(): Stmt {
    this.expect('continue');
    let label: string | null = null;
    // Restricted production `continue [no LineTerminator here] Identifier`.
    if (!this.at(';') && !this.hadLineTerminator()) label = this.expectIdent().value;
    this.consumeSemicolon();
    return { kind: 'Continue', label };
  }

  private parseFor(): Stmt {
    this.expect('for');

    // for-each-in: `for each (var v in arr)` / `for each (v in arr)` — iterates
    // values. The `var` (and thus the declaration) is optional: `for each (touch
    // in touches)` iterates an already-declared variable.
    if (this.atIdent('each')) {
      this.next();
      this.expect('(');
      let declares = false;
      if (this.atIdent('var')) { this.next(); declares = true; }
      const varName = this.expectIdent().value;
      let varType: ASType | null = null;
      if (this.at(':')) { this.next(); varType = this.parseType(); }
      this.expectIdent('in');
      const iterable = this.parseExpression();
      this.expect(')');
      const body = this.parseStatement();
      return { kind: 'ForEachIn', varName, varType, declares, iterable, body };
    }

    this.expect('(');

    // for-in: `for (var key in arr)` / `for (key in arr)` — iterates indices of
    // an Array or keys of a dynamic object. Detect by trying the
    // `[var] <name> [: Type] in` shape and backtracking if it is a C-style for.
    {
      const saved = this.pos;
      let declares = false;
      if (this.atIdent('var')) { this.next(); declares = true; }
      const nameTok = this.peek();
      if (nameTok.kind === 'ident' && !isKeyword(nameTok.value)) {
        this.next(); // name
        if (this.at(':')) { this.next(); this.parseType(); }
        if (this.atIdent('in')) {
          this.next();
          const iterable = this.parseExpression();
          this.expect(')');
          const body = this.parseStatement();
          return { kind: 'ForIn', varName: nameTok.value, declares, iterable, body };
        }
      }
      this.pos = saved; // backtrack: treat as C-style for
    }

    let init: Stmt | null = null;
    if (this.at(';')) {
      this.next();
    } else if (this.atIdent('var')) {
      this.next();
      const decls = [this.parseVarDeclarator()];
      while (this.at(',')) {
        this.next();
        decls.push(this.parseVarDeclarator());
      }
      this.expect(';');
      init = decls.length === 1 ? { kind: 'VarDecl', ...decls[0] } : { kind: 'VarDecls', decls };
    } else {
      const e = this.parseExpression();
      this.expect(';');
      init = { kind: 'ExprStmt', expr: e };
    }

    let cond: Expr | null = null;
    if (!this.at(';')) cond = this.parseExpression();
    this.expect(';');

    let update: Expr | null = null;
    if (!this.at(')')) update = this.parseExpression();
    this.expect(')');

    const body = this.parseStatement();
    return { kind: 'For', init, cond, update, body };
  }

  private parseReturn(): Stmt {
    this.expect('return');
    let value: Expr | null = null;
    // Restricted production `return [no LineTerminator here] Expression` — a value
    // on the next line is a separate statement, not the return value.
    if (!this.at(';') && !this.at('}') && this.peek().kind !== 'eof' && !this.hadLineTerminator()) {
      value = this.parseExpression();
    }
    this.consumeSemicolon();
    return { kind: 'Return', value };
  }

  private parseThrow(): Stmt {
    this.expect('throw');
    // Restricted production `throw [no LineTerminator here] Expression` — a line
    // terminator after `throw` is a syntax error (there is no valid `throw;`
    // form for ASI to fall back to).
    if (this.hadLineTerminator()) {
      throw new ParseError("a line terminator is not allowed after 'throw'", this.peek());
    }
    const value = this.parseExpression();
    this.consumeSemicolon();
    return { kind: 'Throw', value };
  }

  // `try { ... } catch (e:Type) { ... } finally { ... }` — catch and finally are
  // both optional, but at least one must be present.
  private parseTry(): Stmt {
    this.expect('try');
    const tryBody = this.parseBlock();
    // AS3 allows any number of catch clauses; they are tried in source order and
    // the first whose type matches handles the exception. A `try` may also have
    // only a `finally`.
    const catches: CatchClause[] = [];
    while (this.atIdent('catch')) {
      this.next();
      this.expect('(');
      const varName = this.expectIdent().value;
      let type: ASType | null = null;
      if (this.at(':')) {
        this.next();
        type = this.parseType();
      }
      this.expect(')');
      catches.push({ varName, type, body: this.parseBlock() });
    }
    let finallyBody: Block | null = null;
    if (this.atIdent('finally')) {
      this.next();
      finallyBody = this.parseBlock();
    }
    if (catches.length === 0 && finallyBody === null) {
      throw new ParseError("'try' must be followed by 'catch' or 'finally'", this.peek());
    }
    return { kind: 'Try', tryBody, catches, finallyBody };
  }

  private parseSuperStmt(): Stmt {
    this.expect('super');
    const args = this.parseArgList();
    this.consumeSemicolon();
    return { kind: 'SuperCall', args };
  }

  private parseArgList(): Expr[] {
    this.expect('(');
    const args: Expr[] = [];
    while (!this.at(')')) {
      args.push(this.parseAssignment()); // separator context: no comma operator
      if (this.at(',')) this.next();
    }
    this.expect(')');
    return args;
  }

  private parseParams(): Param[] {
    this.expect('(');
    const params: Param[] = [];
    while (!this.at(')')) {
      let isRest = false;
      if (this.at('...')) {
        this.next();
        isRest = true;
      }
      const name = this.expectIdent().value;
      // An untyped parameter (`function f(_callObject) {}`) is AS3's `*`: the C
      // type is the boxed `any`. mxmlc 51.4.1 accepts the form (with an implicit
      // "untyped" warning), so this is a compatibility gap, not an enhancement.
      let type: ASType = 'any';
      if (this.at(':')) {
        this.next();
        type = this.parseType();
      } else if (isRest) {
        type = 'Array'; // `...rest` is implicitly an Array
      }
      let defaultValue: Expr | null = null;
      if (this.at('=')) {
        this.next();
        defaultValue = this.parseAssignment();
      }
      params.push({ name, type, defaultValue, isRest });
      if (this.at(',')) {
        if (isRest) throw new ParseError('rest parameter must be the last parameter', this.peek());
        this.next();
      }
    }
    this.expect(')');
    return params;
  }

  private parseFuncDecl(metadata: Metadata[] = []): Stmt {
    this.expect('function');
    const name = this.expectIdent().value;
    const params = this.parseParams();
    let returnType: ASType = 'void';
    if (this.at(':')) {
      this.next();
      returnType = this.parseType();
    }
    const body = this.parseBlock();
    return { kind: 'FuncDecl', name, params, returnType, body, metadata };
  }

  private parseClassDecl(isFinal: boolean, metadata: Metadata[] = [], isDynamic = false): Stmt {
    this.expect('class');
    const name = this.expectIdent().value;
    let superClass: string | null = null;
    if (this.atIdent('extends')) {
      this.next();
      superClass = this.expectIdent().value;
    }
    const implementsList: string[] = [];
    if (this.atIdent('implements')) {
      this.next();
      for (;;) {
        implementsList.push(this.expectIdent().value);
        if (this.at(',')) { this.next(); continue; }
        break;
      }
    }
    this.expect('{');
    const members: ClassMember[] = [];
    while (!this.at('}') && this.peek().kind !== 'eof') {
      // The member's own starting token (modifiers included) -- stamped onto the
      // member below so a semantic error inside a signature/reference resolves to
      // the offending member rather than to the whole class.
      const memberTok = this.peek();
      const markMember = <T extends ClassMember>(m: T): T => {
        m.line = memberTok.line; m.col = memberTok.col;
        return m;
      };
      // `import a.b.C;` written INSIDE a class body (a zxing-ported idiom):
      // recorded like a file-level import so the class's short-name resolution
      // sees it; it is consumed here so the member loop continues.
      if (this.atIdent('import')) {
        this.parseImport();
        continue;
      }
      // A stray `;` between members is tolerated by AS3 (`function get p():Boolean
      // { return true; };`).
      if (this.at(';')) { this.next(); continue; }
      // `use namespace starling_internal;` opens a namespace for the rest of the
      // class body. Transparent in AOT (no visibility enforcement) — dropped.
      if (this.atIdent('use')) {
        this.next(); // use
        this.expect('namespace');
        this.expectIdent(); // namespace name
        this.consumeSemicolon();
        continue;
      }
      // Class members may carry their own metadata ([WasmExport] static function...).
      const memberMetadata = this.parseMetadataIfPresent();
      let visibility: Visibility = 'public';
      let isStatic = false;
      let isFinal = false;
      // A namespace qualifier on a class member (e.g. `flash_proxy override
      // function getProperty`). Transparent in AOT except for Proxy's interceptor
      // names, so it is recorded on the member rather than merely dropped.
      let nsQualifier: string | null = null;
      let modifierCount = 0;
      while (true) {
        if (this.atIdent('public') || this.atIdent('private') || this.atIdent('protected') || this.atIdent('internal')) {
          visibility = this.next().value as Visibility;
          modifierCount++;
        } else if (this.atIdent('static')) {
          this.next(); isStatic = true;
          modifierCount++;
        } else if (this.atIdent('final')) {
          this.next(); isFinal = true;
          modifierCount++;
        } else if (this.atIdent('override')) {
          this.next(); // override is handled implicitly via the vtable slot
          modifierCount++;
        } else if (this.isNamespaceModifier()) {
          nsQualifier = this.peek().value;
          this.next(); // namespace qualifier (e.g. starling_internal, flash_proxy)
          modifierCount++;
        } else {
          break;
        }
      }

      if (this.at('{')) {
        // A bare block in a class body is AS3's static initializer. Only static
        // initializers are legal there, so every class-body block is one; its
        // statements run once as part of the class's static initialization.
        const body = this.parseBlock();
        members.push(markMember({ kind: 'StaticInit', body }));
      } else if (this.atIdent('var') || this.atIdent('const')) {
        const isConst = this.next().value === 'const';
        // AS3 allows several declarators in ONE class-body field declaration
        // (`private var _r:Number = 0, _g:Number = 0, _b:Number = 0;`, the
        // Away3D material-method idiom). Each declarator becomes its own Field,
        // sharing the modifiers already consumed above. `parseVarDeclarator` is
        // the same leading-`var`-already-consumed primitive the statement form
        // uses, so `var a:T, b:U = v;` parses identically in both positions.
        while (true) {
          const { name: fName, type, init } = this.parseVarDeclarator();
          members.push(markMember({ kind: 'Field', name: fName, type, init, visibility, isStatic, isConst, metadata: memberMetadata }));
          if (!this.at(',')) break;
          this.next();
        }
        this.consumeSemicolon();
      } else if (this.atIdent('function')) {
        this.expect('function');
        let isGetter = false;
        let isSetter = false;
        let mName = this.expectIdent().value;
        // `get`/`set` are accessor keywords only when followed by a property
        // name (an identifier). When followed by `(` they are ordinary method
        // names, e.g. `public function get(styleType:Class):MeshBatch`.
        if ((mName === 'get' || mName === 'set') && this.peek().kind === 'ident') {
          isGetter = mName === 'get';
          isSetter = mName === 'set';
          mName = this.expectIdent().value;
        }
        const params = this.parseParams();
        // A method whose name matches the class name is the constructor (AS3 rule).
        if (mName === name && !isGetter && !isSetter) {
          // A constructor may carry an explicit `:void` return type annotation.
          if (this.at(':')) {
            this.next();
            this.parseType();
          }
          const body = this.parseBlock();
          members.push(markMember({ kind: 'Constructor', params, body }));
        } else {
          let returnType: ASType = 'void';
          if (this.at(':')) {
            this.next();
            returnType = this.parseType();
          }
          const body = this.parseBlock();
          members.push(markMember({ kind: 'Method', name: mName, params, returnType, body, visibility, isStatic, isFinal, isGetter, isSetter, metadata: memberMetadata, ns: nsQualifier ?? undefined }));
        }
      } else if (modifierCount === 0) {
        // A BARE STATEMENT in a class body is legal AS3: it is an unbraced static
        // initializer, running in declaration order with the static field
        // initializers. Measured on mxmlc 51.4.1 (temp/unbraced/U.as):
        // `class U { static const v:Number = 1; String.fromCharCode(65); }`
        // compiles, and a bare `x = 1;` fails only because the NAME is undefined,
        // never as a syntax error. greensock's TweenMax.as is the real case
        // (`TweenPlugin.activate([...]);` between two static fields).
        //
        // Every member declaration begins with a modifier, `function`, `var`,
        // `const` or `{` — all consumed above — so with no modifier read, anything
        // else here must be a statement. A modifier followed by junk stays a hard
        // error, keeping the precise "unexpected token in class body" message for
        // genuinely malformed members (`public 3;`).
        const stmt = this.parseStatement();
        members.push(markMember({ kind: 'StaticInit', body: { kind: 'Block', body: [stmt] } }));
      } else {
        throw new ParseError(`unexpected token '${this.peek().value}' in class body`, this.peek());
      }
    }
    this.expect('}');
    return { kind: 'ClassDecl', name, packageName: this.currentPackage, superClass, members, isFinal, isDynamic, implements: implementsList, metadata, imports: this.imports.slice(), fileId: null };
  }

  private parseInterfaceDecl(): Stmt {
    this.expect('interface');
    const name = this.expectIdent().value;
    // `interface I extends A, B { }` — AS3 allows multiple parent interfaces.
    const extendsList: string[] = [];
    if (this.atIdent('extends')) {
      this.next();
      for (;;) {
        extendsList.push(this.expectIdent().value);
        if (this.at(',')) { this.next(); continue; }
        break;
      }
    }
    this.expect('{');
    const methods: InterfaceMethod[] = [];
    while (!this.at('}') && this.peek().kind !== 'eof') {
      this.expect('function');
      let isGetter = false;
      let isSetter = false;
      let mName = this.expectIdent().value;
      // Interface getter/setter (`function get targetBounds():Rectangle;`). A
      // `get`/`set` followed by an identifier is an accessor declaration; the
      // accessor flag is preserved so the class-side vtable wiring can match a
      // getter/setter implementation.
      if ((mName === 'get' || mName === 'set') && this.peek().kind === 'ident') {
        isGetter = mName === 'get';
        isSetter = mName === 'set';
        mName = this.expectIdent().value;
      }
      const params = this.parseParams();
      let returnType: ASType = 'void';
      if (this.at(':')) {
        this.next();
        returnType = this.parseType();
      }
      this.consumeSemicolon();
      methods.push({ name: mName, params, returnType, isGetter, isSetter });
    }
    this.expect('}');
    return { kind: 'InterfaceDecl', name, packageName: this.currentPackage, extendsList, methods, imports: this.imports.slice(), fileId: null };
  }

  // ---- expressions ----

  parseExpression(): Expr {
    return this.parseComma();
  }

  // The comma operator (ES3 §11.14): `a, b` evaluates `a` for its side effects and
  // yields `b`. It sits at the very bottom of the expression grammar, so ONLY the
  // contexts that accept a full `Expression` use parseExpression: expression
  // statements, `for` init/cond/update, `if`/`while`/`switch` heads, `return`/
  // `throw` values, and parenthesised groups. Every separator context (argument
  // lists, array/object literals, parameter defaults, var/const initialisers)
  // takes a single AssignmentExpression instead — otherwise `f(a, b)` would parse
  // as one argument `(a, b)`.
  private parseComma(): Expr {
    let left = this.parseAssignment();
    while (this.at(',')) {
      this.next();
      const right = this.parseAssignment();
      left = { kind: 'Comma', left, right };
    }
    return left;
  }

  private parseAssignment(): Expr {
    const left = this.parseConditional();
    if (ASSIGN_OPS.has(this.peek().value)) {
      const op = this.next().value;
      const value = this.parseAssignment(); // right-associative
      return { kind: 'Assign', op, target: left, value };
    }
    return left;
  }

  // Ternary `cond ? a : b` is right-associative and sits just above assignment.
  private parseConditional(): Expr {
    const cond = this.parseBinary(0); // 0 admits `??`, the loosest binary operator
    if (this.at('?')) {
      this.next();
      const then = this.parseAssignment();
      this.expect(':');
      const elseBranch = this.parseAssignment();
      return { kind: 'Conditional', cond, then, else: elseBranch };
    }
    return cond;
  }

  private parseBinary(minPrec: number): Expr {
    let left = this.parseUnary();
    while (true) {
      const t = this.peek();
      if (t.kind === 'symbol') {
        const prec = BIN_PREC[t.value];
        if (prec === undefined || prec < minPrec) break;
        this.next();
        const right = this.parseBinary(prec + 1); // left-associative
        // `??` is a distinct node: its right operand is evaluated only when the
        // left is null/undefined (short-circuit), so it cannot go through the
        // ordinary arithmetic/comparison Binary path.
        left = t.value === '??'
          ? { kind: 'NullCoalesce', left, right }
          : { kind: 'Binary', op: t.value, left, right };
      } else if (t.kind === 'ident' && (t.value === 'is' || t.value === 'as')) {
        // `is` / `as` are relational-level operators (same precedence as < <= > >=).
        const prec = 7;
        if (prec < minPrec) break;
        this.next();
        // The target may be a scalar, a fully-qualified class name, or a generic
        // `Vector.<T>` (e.g. `data as Vector.<Touch>`); parseType handles all three.
        const typeName = this.parseType();
        left = t.value === 'is'
          ? { kind: 'Is', obj: left, typeName }
          : { kind: 'As', obj: left, typeName };
      } else if (t.kind === 'ident' && t.value === 'in') {
        // `key in object` membership test — relational-level, like `is`/`as`.
        const prec = 7;
        if (prec < minPrec) break;
        this.next();
        const obj = this.parseBinary(prec + 1);
        left = { kind: 'In', key: left, object: obj };
      } else {
        break;
      }
    }
    return left;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.kind === 'ident' && t.value === 'typeof') {
      this.next();
      return { kind: 'Typeof', operand: this.parseUnary() };
    }
    if (t.kind === 'ident' && t.value === 'delete') {
      this.next();
      return { kind: 'Delete', target: this.parseUnary() };
    }
    if (t.kind === 'symbol' && (t.value === '!' || t.value === '-' || t.value === '+' || t.value === '~')) {
      this.next();
      const operand = this.parseUnary();
      return { kind: 'Unary', op: t.value, operand };
    }
    if (t.kind === 'symbol' && (t.value === '++' || t.value === '--')) {
      this.next();
      const operand = this.parseUnary();
      return { kind: 'Update', op: t.value as '++', target: operand, prefix: true };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    while (true) {
      if (this.at('..')) {
        // E4X descendant accessor: `x..name` collects every descendant of x (any
        // depth, x itself excluded) whose local name is `name`; `x..*` collects
        // all of them. `..` is its own token, so it never collides with the `.`
        // member access below.
        this.next();
        let name = '*';
        if (this.at('*')) this.next();
        else {
          name = this.expectIdent().value;
          // `x..ns::name` — the descendant axis over a NAMESPACE-QUALIFIED local
          // name. Like every other `ns::` form, the qualifier is transparent in the
          // AOT translation, so `x..ns::name` becomes `x..name` (DAEParser does this
          // throughout: `_doc.._ns::scene`).
          if (this.at('::')) {
            this.next();
            name = this.expectIdent().value;
          }
        }
        expr = { kind: 'Descendants', object: expr, name };
      } else if (this.at('.')) {
        if (this.peek(1).value === '@') {
          // E4X attribute access: expr.@name (only valid on XML/XMLList). The name
          // may also be computed: `expr.@[expr]` (adl 51.4.1 accepts it and it
          // behaves exactly like the literal form -- temp/nsbracket/ case P/Q).
          this.next(); // '.'
          this.next(); // '@'
          if (this.at('[')) {
            this.next();
            const index = this.parseExpression();
            this.expect(']');
            expr = { kind: 'E4xName', object: expr, index, attr: true };
          } else {
            const attr = this.expectIdent().value;
            expr = { kind: 'AttrAccess', object: expr, name: attr };
          }
        } else if (this.peek(1).value === '(') {
          // E4X filter predicate: expr.(@attr == value). Starling uses only the
          // @attr == "str" form (asset metadata extraction), so the predicate is
          // compiled down to an attribute-name / comparison pair rather than a
          // general predicate expression.
          this.next(); // '.'
          this.next(); // '('  (the filter operator)
          this.expect('@');
          const attr = this.expectIdent().value;
          const opTok = this.next();
          if (opTok.value !== '==' && opTok.value !== '!=') {
            throw new ParseError(`unsupported E4X filter operator '${opTok.value}' (expected == or !=)`, opTok);
          }
          const value = this.parseAssignment();
          this.expect(')');
          expr = { kind: 'Filter', object: expr, attr, op: opTok.value, value };
        } else {
          this.next();
          const prop = this.expectIdent().value;
          expr = { kind: 'Member', object: expr, property: prop };
        }
      } else if (this.at('::')) {
        // `ns::member` (custom namespace qualification): namespaces are transparent
        // in the AOT translation (no visibility enforcement), so the qualifier is
        // dropped. `A.ns::m` -> `A.m` (static/member access); `A.B.ns::m` -> `A.B.m`;
        // a bare `ns::m` -> `m` (an unqualified member of the current class).
        //
        // The name may also be COMPUTED -- `element.ns::[expr]` (the DAEParser
        // idiom): the namespace qualifier is dropped the same way, leaving a
        // child-axis lookup by the runtime-computed local name.
        this.next(); // '::'
        if (this.at('[')) {
          this.next();
          const index = this.parseExpression();
          this.expect(']');
          const target: Expr = expr.kind === 'Member' ? expr.object : { kind: 'Var', name: 'this' };
          expr = { kind: 'E4xName', object: target, index, attr: false };
        } else {
          const member = this.expectIdent().value;
          if (expr.kind === 'Member') {
            expr = { kind: 'Member', object: expr.object, property: member };
          } else {
            expr = { kind: 'Var', name: member };
          }
        }
      } else if (this.at('(')) {
        this.next();
        const args: Expr[] = [];
        while (!this.at(')')) {
          args.push(this.parseAssignment()); // separator context: no comma operator
          if (this.at(',')) this.next();
        }
        this.expect(')');
        expr = { kind: 'Call', callee: expr, args };
      } else if (this.at('[')) {
        this.next();
        const index = this.parseExpression();
        this.expect(']');
        expr = { kind: 'Index', object: expr, index };
      } else if ((this.at('++') || this.at('--')) && !this.hadLineTerminator()) {
        const op = this.next().value as '++';
        expr = { kind: 'Update', op, target: expr, prefix: false };
      } else {
        break;
      }
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    if (t.kind === 'regex') {
      this.next();
      return { kind: 'RegExp', pattern: t.value, flags: t.regexFlags ?? '' };
    }

    if (t.kind === 'xml') {
      // An E4X XML literal, captured verbatim by the lexer; the runtime parses it
      // into the same node tree `new XML("...")` produces.
      this.next();
      return { kind: 'XmlLit', raw: t.value };
    }
    if (t.kind === 'num') {
      this.next();
      return { kind: 'Num', value: t.num!, isInt: t.isInt!, width: t.width, raw: t.value };
    }
    if (t.kind === 'str') {
      this.next();
      return { kind: 'Str', value: t.value };
    }
    if (t.kind === 'ident') {
      if (t.value === 'true') { this.next(); return { kind: 'Bool', value: true }; }
      if (t.value === 'false') { this.next(); return { kind: 'Bool', value: false }; }
      if (t.value === 'null') { this.next(); return { kind: 'Null' }; }
      if (t.value === 'Infinity') { this.next(); return { kind: 'Num', value: Infinity, isInt: false }; }
      if (t.value === 'NaN') { this.next(); return { kind: 'Num', value: NaN, isInt: false }; }
      if (t.value === 'this') { this.next(); return { kind: 'Var', name: 'this' }; }
      if (t.value === 'super') return this.parseSuperExpr();
      if (t.value === 'new') return this.parseNew();
      // Vector.<T>(...) without `new`: AS3 allows the type-to-constructor form
      // as a plain call, so desugar it to the same New node `new Vector.<T>()`
      // produces. Detected before the generic ident fall-through.
      if (t.value === 'Vector' && this.peek(1).value === '.' && this.peek(2).value === '<') {
        return this.parseVectorCall();
      }
      if (t.value === 'function') return this.parseFunctionExpr();
      // type-name conversion/constructor functions: String(x) / Number(x) /
      // Boolean(x) / int(x) / uint(x), and the built-in constructor calls
      // Array(...) / Object(...) used without `new`.
      if (t.value === 'String' || t.value === 'Number' || t.value === 'Boolean' || t.value === 'int' || t.value === 'uint' || t.value === 'Array' || t.value === 'Object') {
        this.next();
        return { kind: 'Var', name: t.value };
      }
      if (!isKeyword(t.value) || t.value === 'get' || t.value === 'set') {
        this.next();
        return { kind: 'Var', name: t.value };
      }
      throw new ParseError(`unexpected keyword '${t.value}'`, t);
    }
    if (t.kind === 'symbol' && t.value === '(') {
      this.next();
      const e = this.parseExpression();
      this.expect(')');
      return e;
    }
    if (t.kind === 'symbol' && t.value === '[') {
      return this.parseArrayLit();
    }
    if (t.kind === 'symbol' && t.value === '{') {
      return this.parseObjectLit();
    }

    throw new ParseError(`unexpected token '${t.value}' in expression`, t);
  }

  private parseArrayLit(): Expr {
    this.expect('[');
    const elements: Expr[] = [];
    while (!this.at(']')) {
      elements.push(this.parseAssignment()); // separator context: no comma operator
      if (this.at(',')) this.next();
    }
    this.expect(']');
    return { kind: 'ArrayLit', elements };
  }

  private parseObjectLit(): Expr {
    this.expect('{');
    const fields: { name: string; value: Expr }[] = [];
    while (!this.at('}')) {
      // AS3 object literals allow identifier keys (`{ x: 1 }`), string keys
      // (`{ "bytes4": 4 }`, Starling's format-size tables) and NUMBER keys
      // (`{ 23 : parseApplicationData }`, hurlant's protocol handler map). A
      // numeric key is the property name its decimal text calls for (AS3 keys are
      // strings), so `23` becomes "23".
      const keyTok = this.peek();
      let name: string;
      if (keyTok.kind === 'str') {
        this.next();
        name = keyTok.value;
      } else if (keyTok.kind === 'num') {
        this.next();
        name = String(keyTok.num);
      } else {
        name = this.expectIdent().value;
      }
      this.expect(':');
      const value = this.parseAssignment(); // separator context: no comma operator
      fields.push({ name, value });
      if (this.at(',')) this.next();
    }
    this.expect('}');
    return { kind: 'ObjectLit', fields };
  }

  private parseNew(): Expr {
    this.expect('new');
    // Dynamic class instantiation: `new (expr as Class)(...)`. The `(` after
    // `new` distinguishes it from `new ClassName(...)`.
    if (this.at('(')) {
      this.next();
      const classExpr = this.parseAssignment();
      this.expect(')');
      const args = this.parseArgList();
      return { kind: 'NewDynamic', classExpr, args };
    }
    // Vector literal: `new <T>[...]` (AS3's compact Vector construction syntax).
    if (this.at('<')) {
      this.next(); // '<'
      const elem = this.parseType();
      this.expect('>');
      this.expect('[');
      const elements: Expr[] = [];
      if (!this.at(']')) {
        elements.push(this.parseAssignment());
        while (this.at(',')) {
          this.next();
          elements.push(this.parseAssignment());
        }
      }
      this.expect(']');
      return { kind: 'VectorLit', elem, elements };
    }
    let className = this.expectIdent().value;
    // new Vector.<T>() — generic element type argument.
    let isGenericVector = false;
    if (className === 'Vector' && this.at('.') && this.peek(1).value === '<') {
      this.next(); // '.'
      this.next(); // '<'
      const elem = this.parseType();
      this.expect('>');
      className = `Vector.<${elem}>`;
      isGenericVector = true;
    } else {
      // Fully-qualified class name: `new flash.display3D.textures.Texture(...)`.
      while (this.at('.') && this.peek(1).kind === 'ident') {
        this.next();
        className += '.' + this.expectIdent().value;
      }
    }
    // `new memberExpression(...)`: the class reference is not a literal class name
    // but a MemberExpression that evaluates to a Class at runtime. AS3's grammar
    // puts the argument list after the whole member expression, so
    // `new map[key]()`, `new list[i].cls()` and `new this.parsers[i]()` are all
    // dynamic instantiations (away3d: `return new _parsers[i]();` in
    // SingleFileLoader). Detected by the `[` / trailing `.` that the literal-name
    // path above cannot consume; the parsed name becomes the head of a postfix
    // chain and the instantiation is emitted as NewDynamic.
    if (this.at('[') || this.at('.')) {
      let classExpr: Expr = { kind: 'Var', name: className };
      const parts = className.split('.');
      if (parts.length > 1) {
        classExpr = { kind: 'Var', name: parts[0] };
        for (let k = 1; k < parts.length; k++) classExpr = { kind: 'Member', object: classExpr, property: parts[k] };
      }
      while (this.at('.')) {
        this.next();
        classExpr = { kind: 'Member', object: classExpr, property: this.expectIdent().value };
      }
      while (this.at('[')) {
        this.next();
        const index = this.parseExpression();
        this.expect(']');
        classExpr = { kind: 'Index', object: classExpr, index };
      }
      const dynArgs = this.at('(') ? this.parseArgList() : [];
      return { kind: 'NewDynamic', classExpr, args: dynArgs };
    }
    // AS3 allows the argument list to be omitted entirely: `new ByteArray` means
    // `new ByteArray()`. Real-world code relies on it (com.hurlant's MD5 does
    // `new ByteArray;`), so the parens are optional for every `new X` form.
    const args = this.at('(') ? this.parseArgList() : [];
    return { kind: 'New', className, args };
  }

  // `Vector.<T>(...)` without `new` — AS3's Vector COERCION, not the
  // `new Vector.<T>(length)` constructor (see the VectorCoerce AST node; the adl
  // measurements separating the two live in temp/vecconv/).
  private parseVectorCall(): Expr {
    this.next(); // Vector
    this.next(); // '.'
    this.next(); // '<'
    const elem = this.parseType();
    this.expect('>');
    const args = this.parseArgList();
    return { kind: 'VectorCoerce', elem, args };
  }

  // Function expression: `function [name](params):ret { body }`. AS3 allows an
  // optional name (ES3 semantics): the name is bound ONLY inside the function's
  // own body — it supports recursive self-reference and does not leak into the
  // enclosing scope. An unannotated return type defaults to `any` (AS3's `*`), so
  // `return expr` boxes the value.
  private parseFunctionExpr(): Expr {
    this.expect('function');
    let name: string | null = null;
    // A name is present iff an identifier (not a keyword) is directly followed by
    // '(' — distinguishing `function f(` from `function (`.
    if (this.peek().kind === 'ident' && !isKeyword(this.peek().value) && this.peek(1).value === '(') {
      name = this.next().value;
    }
    const params = this.parseParams();
    let returnType: ASType = 'any';
    if (this.at(':')) {
      this.next();
      returnType = this.parseType();
    }
    const body = this.parseBlock();
    return { kind: 'FunctionExpr', name, params, returnType, body };
  }

  private parseSuperExpr(): Expr {
    this.expect('super');
    this.expect('.');
    const name = this.expectIdent().value;
    // `super.method(...)` is a super method call; `super.property` is a field/
    // getter/setter access on the superclass (read or write).
    if (this.at('(')) {
      const args = this.parseArgList();
      return { kind: 'SuperMethod', method: name, args };
    }
    return { kind: 'SuperProperty', property: name };
  }

  // `[public] namespace name;` — declares a custom namespace (Starling's
  // `starling_internal`). Namespaces only gate compile-time visibility, which the
  // AOT translation does not enforce, so the declaration is consumed and dropped.
  private parseNamespaceDecl(): Stmt {
    this.expect('namespace');
    this.expectIdent(); // namespace name
    this.consumeSemicolon();
    return { kind: 'Block', body: [] };
  }

  // `use namespace name;` — opens a namespace for the current scope. Transparent
  // in the AOT translation (no visibility enforcement); consumed and dropped.
  private parseUseNamespace(): Stmt {
    this.expect('use');
    this.expect('namespace');
    this.expectIdent(); // namespace name
    this.consumeSemicolon();
    return { kind: 'Block', body: [] };
  }

  // A namespace qualifier immediately before a class member (e.g.
  // `starling_internal function f()`): an identifier that is not a modifier
  // keyword, directly followed by a member-declaration keyword. Namespaces are
  // transparent in AOT, so the qualifier is recognised and dropped.
  private isNamespaceModifier(): boolean {
    const t = this.peek();
    if (t.kind !== 'ident' || isKeyword(t.value)) return false;
    const nxt = this.peek(1).value;
    return nxt === 'function' || nxt === 'var' || nxt === 'const' ||
      nxt === 'static' || nxt === 'override' || nxt === 'get' || nxt === 'set';
  }
}
