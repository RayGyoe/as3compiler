// Recursive-descent parser for the AS3 minimal subset.

import { lex, isKeyword } from './lexer.ts';
import type { Token } from './lexer.ts';
import type {
  Program, Stmt, Expr, Param, ASType, ClassMember, Block, SwitchCase, Visibility, InterfaceMethod, Metadata,
} from './ast.ts';

const TYPE_KEYWORDS = new Set(['int', 'uint', 'Number', 'Boolean', 'String', 'void', 'Array', 'Function']);

const BIN_PREC: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6, '!=': 6,
  '<': 7, '<=': 7, '>': 7, '>=': 7,
  '<<': 8, '>>': 8, '>>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
};

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '<<=', '>>=', '>>>=', '&=', '|=', '^=']);

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

  private at(value: string): boolean {
    return this.peek().value === value;
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
    // A bare identifier used as a type is treated as a class name (object type).
    return t.value;
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
    return { body, imports: this.imports };
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
  private parsePackage(body: Stmt[]): void {
    this.expect('package');
    let pkg = this.expectIdent().value;
    while (this.at('.')) {
      this.next();
      pkg += '.' + this.expectIdent().value;
    }
    this.expect('{');
    const saved = this.currentPackage;
    this.currentPackage = pkg;
    while (!this.at('}') && this.peek().kind !== 'eof') {
      if (this.atIdent('import')) {
        this.parseImport();
      } else {
        body.push(this.parseStatement());
      }
    }
    this.expect('}');
    this.currentPackage = saved;
  }

  // ---- statements ----

  private parseStatement(): Stmt {
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
      if (this.atIdent('class')) return this.parseClassDecl(false, metadata);
      if (this.atIdent('interface')) return this.parseInterfaceDecl();
      if (this.atIdent('final') || this.atIdent('public') || this.atIdent('internal') || this.atIdent('dynamic')) {
        let isFinal = false;
        while (this.atIdent('final') || this.atIdent('public') || this.atIdent('internal') || this.atIdent('dynamic')) {
          if (this.next().value === 'final') isFinal = true;
        }
        if (this.atIdent('class')) return this.parseClassDecl(isFinal, metadata);
        if (this.atIdent('interface')) return this.parseInterfaceDecl();
      }
      throw new ParseError(`metadata must precede a function/class/interface declaration`, this.peek());
    }

    if (t.kind === 'ident') {
      if (t.value === 'var') return this.parseVarDeclStmt();
      if (t.value === 'const') return this.parseConstDeclStmt();
      if (t.value === 'if') return this.parseIf();
      if (t.value === 'while') return this.parseWhile();
      if (t.value === 'do') return this.parseDoWhile();
      if (t.value === 'for') return this.parseFor();
      if (t.value === 'switch') return this.parseSwitch();
      if (t.value === 'break') return this.parseBreak();
      if (t.value === 'continue') return this.parseContinue();
      if (t.value === 'return') return this.parseReturn();
      if (t.value === 'throw') return this.parseThrow();
      if (t.value === 'try') return this.parseTry();
      if (t.value === 'super') return this.parseSuperStmt();
      if (t.value === 'function') return this.parseFuncDecl();
      if (t.value === 'class') return this.parseClassDecl(false);
      if (t.value === 'interface') return this.parseInterfaceDecl();
      // class/interface modifiers: `public`, `internal`, `dynamic`, `final`.
      // Visibility is governed by the package context; dynamic is a runtime
      // trait we do not model, so both are consumed and ignored here.
      if (t.value === 'final' || t.value === 'public' || t.value === 'internal' || t.value === 'dynamic') {
        let isFinal = false;
        while (this.atIdent('final') || this.atIdent('public') || this.atIdent('internal') || this.atIdent('dynamic')) {
          if (this.next().value === 'final') isFinal = true;
        }
        if (this.atIdent('class')) return this.parseClassDecl(isFinal);
        if (this.atIdent('interface')) return this.parseInterfaceDecl();
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
    this.expect(';');
    return { kind: 'ExprStmt', expr };
  }

  // Parse leading AS3 bracket metadata: `[Name]` or `[Name("a", "b")]`, repeated
  // (`[A][B]`). Returns [] when there is no metadata. A sequence that is not
  // followed by a declaration keyword (e.g. an array literal expression
  // statement) restores the token position and returns [] so the caller parses it
  // as an expression instead.
  private parseMetadataIfPresent(): Metadata[] {
    const saved = this.pos;
    if (!this.at('[') || this.peek(1).kind !== 'ident') return [];
    const list: Metadata[] = [];
    try {
      while (this.at('[')) {
        this.next(); // '['
        const name = this.expectIdent().value;
        const args: string[] = [];
        if (this.at('(')) {
          this.next();
          if (!this.at(')')) {
            do {
              const a = this.next();
              if (a.kind === 'str' || a.kind === 'ident') args.push(a.value);
              else throw new ParseError(`expected metadata argument but found '${a.value}'`, a);
            } while (this.at(','));
          }
          this.expect(')');
        }
        this.expect(']');
        list.push({ name, args });
      }
      const nxt = this.peek();
      if (!(nxt.kind === 'ident' && METADATA_DECL.has(nxt.value))) {
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
      init = this.parseExpression();
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
    this.expect(';');
    return decls.length === 1 ? { kind: 'VarDecl', ...decls[0] } : { kind: 'VarDecls', decls };
  }

  private parseConstDeclStmt(): Stmt {
    this.expect('const');
    const name = this.expectIdent().value;
    let type: ASType | null = null;
    if (this.at(':')) {
      this.next();
      type = this.parseType();
    }
    this.expect('='); // const must have an initializer
    const init = this.parseExpression();
    this.expect(';');
    return { kind: 'ConstDecl', name, type, init };
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

  private parseDoWhile(): Stmt {
    this.expect('do');
    const body = this.parseStatement();
    this.expect('while');
    this.expect('(');
    const cond = this.parseExpression();
    this.expect(')');
    this.expect(';');
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
    if (!this.at(';')) label = this.expectIdent().value;
    this.expect(';');
    return { kind: 'Break', label };
  }

  private parseContinue(): Stmt {
    this.expect('continue');
    let label: string | null = null;
    if (!this.at(';')) label = this.expectIdent().value;
    this.expect(';');
    return { kind: 'Continue', label };
  }

  private parseFor(): Stmt {
    this.expect('for');

    // for-each-in: `for each (var v in arr)` — iterates values.
    if (this.atIdent('each')) {
      this.next();
      this.expect('(');
      this.expect('var');
      const varName = this.expectIdent().value;
      let varType: ASType | null = null;
      if (this.at(':')) { this.next(); varType = this.parseType(); }
      this.expectIdent('in');
      const iterable = this.parseExpression();
      this.expect(')');
      const body = this.parseStatement();
      return { kind: 'ForEachIn', varName, varType, iterable, body };
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
      const d = this.parseVarDeclCore();
      this.expect(';');
      init = { kind: 'VarDecl', ...d };
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
    if (!this.at(';')) value = this.parseExpression();
    this.expect(';');
    return { kind: 'Return', value };
  }

  private parseThrow(): Stmt {
    this.expect('throw');
    const value = this.parseExpression();
    this.expect(';');
    return { kind: 'Throw', value };
  }

  // `try { ... } catch (e:Type) { ... } finally { ... }` — catch and finally are
  // both optional, but at least one must be present.
  private parseTry(): Stmt {
    this.expect('try');
    const tryBody = this.parseBlock();
    let catchVar: string | null = null;
    let catchType: ASType | null = null;
    let catchBody: Block | null = null;
    if (this.atIdent('catch')) {
      this.next();
      this.expect('(');
      catchVar = this.expectIdent().value;
      if (this.at(':')) {
        this.next();
        catchType = this.parseType();
      }
      this.expect(')');
      catchBody = this.parseBlock();
    }
    let finallyBody: Block | null = null;
    if (this.atIdent('finally')) {
      this.next();
      finallyBody = this.parseBlock();
    }
    if (catchBody === null && finallyBody === null) {
      throw new ParseError("'try' must be followed by 'catch' or 'finally'", this.peek());
    }
    return { kind: 'Try', tryBody, catchVar, catchType, catchBody, finallyBody };
  }

  private parseSuperStmt(): Stmt {
    this.expect('super');
    if (this.at('(')) {
      const args = this.parseArgList();
      this.expect(';');
      return { kind: 'SuperCall', args };
    }
    // super.method(...) used as an expression statement
    this.expect('.');
    const method = this.expectIdent().value;
    const args = this.parseArgList();
    this.expect(';');
    return { kind: 'ExprStmt', expr: { kind: 'SuperMethod', method, args } };
  }

  private parseArgList(): Expr[] {
    this.expect('(');
    const args: Expr[] = [];
    while (!this.at(')')) {
      args.push(this.parseExpression());
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
      let type: ASType;
      if (this.at(':')) {
        this.next();
        type = this.parseType();
      } else if (isRest) {
        type = 'Array'; // `...rest` is implicitly an Array
      } else {
        throw new ParseError(`expected ':' in parameter '${name}'`, this.peek());
      }
      let defaultValue: Expr | null = null;
      if (this.at('=')) {
        this.next();
        defaultValue = this.parseExpression();
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

  private parseClassDecl(isFinal: boolean, metadata: Metadata[] = []): Stmt {
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
      do {
        implementsList.push(this.expectIdent().value);
      } while (this.at(','));
    }
    this.expect('{');
    const members: ClassMember[] = [];
    while (!this.at('}') && this.peek().kind !== 'eof') {
      // Class members may carry their own metadata ([WasmExport] static function...).
      const memberMetadata = this.parseMetadataIfPresent();
      let visibility: Visibility = 'public';
      let isStatic = false;
      let isFinal = false;
      while (true) {
        if (this.atIdent('public') || this.atIdent('private') || this.atIdent('protected') || this.atIdent('internal')) {
          visibility = this.next().value as Visibility;
        } else if (this.atIdent('static')) {
          this.next(); isStatic = true;
        } else if (this.atIdent('final')) {
          this.next(); isFinal = true;
        } else if (this.atIdent('override')) {
          this.next(); // override is handled implicitly via the vtable slot
        } else {
          break;
        }
      }

      if (this.atIdent('var') || this.atIdent('const')) {
        const isConst = this.next().value === 'const';
        const fName = this.expectIdent().value;
        let type: ASType | null = null;
        if (this.at(':')) { this.next(); type = this.parseType(); }
        let init: Expr | null = null;
        if (this.at('=')) { this.next(); init = this.parseExpression(); }
        this.expect(';');
        members.push({ kind: 'Field', name: fName, type, init, visibility, isStatic, isConst });
      } else if (this.atIdent('function')) {
        this.expect('function');
        let isGetter = false;
        let isSetter = false;
        let mName = this.expectIdent().value;
        if (mName === 'get' || mName === 'set') {
          isGetter = mName === 'get';
          isSetter = mName === 'set';
          mName = this.expectIdent().value;
        }
        const params = this.parseParams();
        // A method whose name matches the class name is the constructor (AS3 rule).
        if (mName === name && !isGetter && !isSetter) {
          const body = this.parseBlock();
          members.push({ kind: 'Constructor', params, body });
        } else {
          let returnType: ASType = 'void';
          if (this.at(':')) {
            this.next();
            returnType = this.parseType();
          }
          const body = this.parseBlock();
          members.push({ kind: 'Method', name: mName, params, returnType, body, visibility, isStatic, isFinal, isGetter, isSetter, metadata: memberMetadata });
        }
      } else {
        throw new ParseError(`unexpected token '${this.peek().value}' in class body`, this.peek());
      }
    }
    this.expect('}');
    return { kind: 'ClassDecl', name, packageName: this.currentPackage, superClass, members, isFinal, implements: implementsList, metadata };
  }

  private parseInterfaceDecl(): Stmt {
    this.expect('interface');
    const name = this.expectIdent().value;
    this.expect('{');
    const methods: InterfaceMethod[] = [];
    while (!this.at('}') && this.peek().kind !== 'eof') {
      this.expect('function');
      const mName = this.expectIdent().value;
      const params = this.parseParams();
      let returnType: ASType = 'void';
      if (this.at(':')) {
        this.next();
        returnType = this.parseType();
      }
      this.expect(';');
      methods.push({ name: mName, params, returnType });
    }
    this.expect('}');
    return { kind: 'InterfaceDecl', name, packageName: this.currentPackage, methods };
  }

  // ---- expressions ----

  parseExpression(): Expr {
    return this.parseAssignment();
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
    const cond = this.parseBinary(1);
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
        left = { kind: 'Binary', op: t.value, left, right };
      } else if (t.kind === 'ident' && (t.value === 'is' || t.value === 'as')) {
        // `is` / `as` are relational-level operators (same precedence as < <= > >=).
        const prec = 7;
        if (prec < minPrec) break;
        this.next();
        const typeName = this.expectIdent().value;
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
      if (this.at('.')) {
        this.next();
        const prop = this.expectIdent().value;
        expr = { kind: 'Member', object: expr, property: prop };
      } else if (this.at('(')) {
        this.next();
        const args: Expr[] = [];
        while (!this.at(')')) {
          args.push(this.parseExpression());
          if (this.at(',')) this.next();
        }
        this.expect(')');
        expr = { kind: 'Call', callee: expr, args };
      } else if (this.at('[')) {
        this.next();
        const index = this.parseExpression();
        this.expect(']');
        expr = { kind: 'Index', object: expr, index };
      } else if (this.at('++') || this.at('--')) {
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

    if (t.kind === 'num') {
      this.next();
      return { kind: 'Num', value: t.num!, isInt: t.isInt! };
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
      if (!isKeyword(t.value)) {
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
      elements.push(this.parseExpression());
      if (this.at(',')) this.next();
    }
    this.expect(']');
    return { kind: 'ArrayLit', elements };
  }

  private parseObjectLit(): Expr {
    this.expect('{');
    const fields: { name: string; value: Expr }[] = [];
    while (!this.at('}')) {
      const name = this.expectIdent().value;
      this.expect(':');
      const value = this.parseExpression();
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
      const classExpr = this.parseExpression();
      this.expect(')');
      const args = this.parseArgList();
      return { kind: 'NewDynamic', classExpr, args };
    }
    let className = this.expectIdent().value;
    // new Vector.<T>() — generic element type argument.
    if (className === 'Vector' && this.at('.') && this.peek(1).value === '<') {
      this.next(); // '.'
      this.next(); // '<'
      const elem = this.parseType();
      this.expect('>');
      className = `Vector.<${elem}>`;
    }
    const args = this.parseArgList();
    return { kind: 'New', className, args };
  }

  // `Vector.<T>(...)` without `new` — the current token is `Vector`, followed
  // by `.<`. Desugars to the same New node the `new Vector.<T>()` path emits.
  private parseVectorCall(): Expr {
    this.next(); // Vector
    this.next(); // '.'
    this.next(); // '<'
    const elem = this.parseType();
    this.expect('>');
    const args = this.parseArgList();
    return { kind: 'New', className: `Vector.<${elem}>`, args };
  }

  // Anonymous function expression: `function(params):ret { body }`. An unannotated
  // return type defaults to `any` (AS3's `*`), so `return expr` boxes the value.
  private parseFunctionExpr(): Expr {
    this.expect('function');
    const params = this.parseParams();
    let returnType: ASType = 'any';
    if (this.at(':')) {
      this.next();
      returnType = this.parseType();
    }
    const body = this.parseBlock();
    return { kind: 'FunctionExpr', params, returnType, body };
  }

  private parseSuperExpr(): Expr {
    this.expect('super');
    this.expect('.');
    const method = this.expectIdent().value;
    const args = this.parseArgList();
    return { kind: 'SuperMethod', method, args };
  }
}
