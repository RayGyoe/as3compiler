// AST node definitions for the AS3 minimal subset.

export type ASType =
  | 'int'
  | 'uint'
  | 'int64'   // opt-in 64-bit enhancement (AIR has no such type name)
  | 'uint64'
  | 'Number'
  | 'Boolean'
  | 'String'
  | 'void'
  | 'Array'
  | string; // class name (object type)

export interface Param {
  name: string;
  type: ASType;
  defaultValue: Expr | null;
  isRest: boolean;
}

export type Block = { kind: 'Block'; body: Stmt[] };

// Source position (the line/col of the token a node STARTED at).
//
// AGENTS.md §2.5 requires every error to carry a line:col. `lexer`/`parser` errors
// already do (their tokens carry both), but the semantic layer had no position at
// all. Rather than threading a token through 150+ `CodegenError` sites, the parser
// stamps the choke points -- every statement (parseStatement) and every class
// member -- and the emitter/symbols layer keeps the position of the construct it
// is currently processing (`setGenPos`), so `new CodegenError(msg)` picks the
// right location up automatically. Expressions stay unstamped: an expression-level
// error is reported at its enclosing statement, which is the granularity a user
// needs to find the construct. Both fields are optional so that hand-built nodes
// (tests, synthesized members) need no position.
export interface Pos { line?: number; col?: number }

// AS3 bracket metadata (e.g. [WasmExport] / [WasmExport("alias")]).
// `args` holds the values in source order; `named` additionally records the
// ones written as `key=value` (`[Embed(source="a.png", mimeType="audio/mpeg")]`),
// because the KEY is what carries the meaning there — value order alone cannot
// distinguish `source` from `mimeType`. Metadata that uses positional arguments
// only (`[WasmExport("alias")]`) leaves `named` unset.
export interface Metadata {
  name: string;
  args: string[];
  named?: Record<string, string>;
}

export type Stmt = (
  | { kind: 'VarDecl'; name: string; type: ASType | null; init: Expr | null }
  | { kind: 'VarDecls'; decls: { name: string; type: ASType | null; init: Expr | null }[] }
  | { kind: 'ConstDecl'; name: string; type: ASType | null; init: Expr | null }
  | { kind: 'ConstDecls'; decls: { name: string; type: ASType | null; init: Expr | null }[] }
  | { kind: 'ExprStmt'; expr: Expr }
  | { kind: 'Block'; body: Stmt[] }
  | { kind: 'If'; cond: Expr; then: Stmt; else: Stmt | null }
  | { kind: 'While'; cond: Expr; body: Stmt }
  | { kind: 'DoWhile'; cond: Expr; body: Stmt }
  | { kind: 'For'; init: Stmt | null; cond: Expr | null; update: Expr | null; body: Stmt }
  | { kind: 'ForIn'; varName: string; declares: boolean; iterable: Expr; body: Stmt }
  | { kind: 'ForEachIn'; varName: string; varType: ASType | null; declares: boolean; iterable: Expr; body: Stmt }
  | { kind: 'Switch'; disc: Expr; cases: SwitchCase[] }
  | { kind: 'Break'; label: string | null }
  | { kind: 'Continue'; label: string | null }
  | { kind: 'Label'; name: string; body: Stmt }
  | { kind: 'Return'; value: Expr | null }
  | { kind: 'SuperCall'; args: Expr[] }
  | { kind: 'Throw'; value: Expr }
  // `try { } catch (a:A) { } catch (b:B) { } finally { }` — AS3 allows any number
  // of catch clauses (tried in source order, first matching type wins). `catches`
  // is therefore a list; a `try` with no catch clause but a `finally` has [].
  | { kind: 'Try'; tryBody: Block; catches: CatchClause[]; finallyBody: Block | null }
  // `with (obj) { body }`: an object scope is inserted into the name-resolution
  // chain for the body (see the semantics measured in emit.ts's emitWith).
  | { kind: 'With'; obj: Expr; body: Stmt }
  | { kind: 'FuncDecl'; name: string; params: Param[]; returnType: ASType; body: Block; metadata: Metadata[] }
  | { kind: 'ClassDecl'; name: string; packageName: string | null; superClass: string | null; members: ClassMember[]; isFinal: boolean; isDynamic: boolean; implements: string[]; metadata: Metadata[]; imports: string[]; fileId: string | null }
  // `extendsList` holds the parent interfaces of `interface I extends A, B {}`.
  // AS3 allows multiple parents, and a class implementing I must also satisfy
  // (and is also an instance of) every parent.
  | { kind: 'InterfaceDecl'; name: string; packageName: string | null; extendsList: string[]; methods: InterfaceMethod[]; imports: string[]; fileId: string | null }
) & Pos;

export interface CatchClause { varName: string; type: ASType | null; body: Block; }

export interface SwitchCase {
  test: Expr | null; // null marks the `default` clause
  body: Stmt[];
}

export type Visibility = 'public' | 'private' | 'protected' | 'internal';

export interface InterfaceMethod { name: string; params: Param[]; returnType: ASType; isGetter: boolean; isSetter: boolean; }

export type ClassMember = (
  | { kind: 'Field'; name: string; type: ASType | null; init: Expr | null; visibility: Visibility; isStatic: boolean; isConst: boolean; metadata?: Metadata[] }
  // `ns` records a namespace qualifier written in front of the member (e.g.
  // `flash_proxy override function getProperty(...)`). The qualifier is otherwise
  // transparent in AOT, but the Proxy interceptor names are only wired when they
  // carry the `flash_proxy` qualifier (measured on adl 51.4.1: a PUBLIC-namespace
  // `getProperty` is an ordinary method and the base Proxy throws #2088 instead).
  | { kind: 'Method'; name: string; params: Param[]; returnType: ASType; body: Block; visibility: Visibility; isStatic: boolean; isFinal: boolean; isGetter: boolean; isSetter: boolean; metadata: Metadata[]; ns?: string }
  | { kind: 'Constructor'; params: Param[]; body: Block }
  // `class C { static var x:int; { x = 1; } }` — AS3's static initializer block.
  // Only static initializers may appear in a class body, so a bare block is
  // always one; its statements run once, in source order, as part of the class's
  // static initialization (after the static field initializers).
  | { kind: 'StaticInit'; body: Block }
) & Pos;

export type Expr =
  | { kind: 'Num'; value: number; isInt: boolean; width?: 'int64' | 'uint64'; raw?: string }
  | { kind: 'Str'; value: string }
  | { kind: 'Bool'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Var'; name: string }
  | { kind: 'Binary'; op: string; left: Expr; right: Expr }
  | { kind: 'Unary'; op: string; operand: Expr }
  | { kind: 'Typeof'; operand: Expr }
  | { kind: 'Delete'; target: Expr }
  | { kind: 'Conditional'; cond: Expr; then: Expr; else: Expr }
  | { kind: 'Update'; op: '++' | '--'; target: Expr; prefix: boolean }
  | { kind: 'Assign'; op: string; target: Expr; value: Expr }
  | { kind: 'Call'; callee: Expr; args: Expr[] }
  | { kind: 'Member'; object: Expr; property: string }
  | { kind: 'AttrAccess'; object: Expr; name: string }
  // E4X computed name, both axes (measured on adl 51.4.1, temp/nsbracket/): the
  // child axis `x.ns::[expr]` (attr=false) picks the child whose LOCAL name is the
  // value of `expr`, and the attribute axis `x.@[expr]` (attr=true) picks that
  // attribute. Both are the static forms `x.name` / `x.@name` with the name
  // computed at run time; the namespace qualifier is dropped like every other
  // `::` (namespaces are transparent in the AOT translation), so the child form
  // is the same local-name lookup `x.name` already performs.
  | { kind: 'E4xName'; object: Expr; index: Expr; attr: boolean }
  | { kind: 'Filter'; object: Expr; attr: string; op: string; value: Expr }
  | { kind: 'SuperMethod'; method: string; args: Expr[] }
  | { kind: 'SuperProperty'; property: string }
  | { kind: 'Is'; obj: Expr; typeName: string }
  | { kind: 'As'; obj: Expr; typeName: string }
  | { kind: 'In'; key: Expr; object: Expr }
  | { kind: 'New'; className: string; args: Expr[] }
  | { kind: 'NewDynamic'; classExpr: Expr; args: Expr[] }
  | { kind: 'ArrayLit'; elements: Expr[] }
  | { kind: 'VectorLit'; elem: ASType; elements: Expr[] }
  // `Vector.<T>(arrayLike)` WITHOUT `new` -- AS3's Vector COERCION, which is NOT
  // the same operation as the `new Vector.<T>(length)` constructor. Measured on
  // adl 51.4.1 (temp/vecconv/):
  //   Vector.<int>([1,2,3])  -> len 3, elements copied
  //   Vector.<int>(someVec)  -> len N, elements coerced one by one
  //   Vector.<int>({a:1})    -> len 0   (array-like `length` read)
  //   Vector.<int>(new Sprite()) -> ReferenceError #1069 (no `length` property)
  //   Vector.<int>(3)        -> TypeError #1034 (a scalar cannot be converted)
  //   Vector.<int>()         -> ArgumentError #1112 (needs exactly 1 argument)
  // while `new Vector.<int>(3)` builds a length-3 vector filled with 0. The parser
  // previously desugared this form onto the `New` node, which silently gave the
  // constructor semantics and rejected every array argument.
  | { kind: 'VectorCoerce'; elem: ASType; args: Expr[] }
  | { kind: 'Index'; object: Expr; index: Expr }
  | { kind: 'ObjectLit'; fields: { name: string; value: Expr }[] }
  | { kind: 'FunctionExpr'; name: string | null; params: Param[]; returnType: ASType; body: Block }
  | { kind: 'RegExp'; pattern: string; flags: string }
  // `a ?? b` — null-coalescing (ASC extension accepted by mxmlc 51.4.1): yields
  // `a` unless it is null or undefined, in which case it yields `b`. `b` is only
  // evaluated when needed (short-circuit), and `a` exactly once.
  | { kind: 'NullCoalesce'; left: Expr; right: Expr }
  // `a, b` — the comma operator (ES3 §11.14): evaluate `a` for its side effects,
  // then yield `b`. It is a sequence point, so no unsequenced-modification hazard
  // (unlike C's `,` when operands share state — here the operands are already
  // sequenced by the language, matching C's comma operator exactly).
  | { kind: 'Comma'; left: Expr; right: Expr }
  // `x..name` / `x..*` — the E4X descendant accessor: every descendant (at any
  // depth, self excluded) whose local name matches; `*` matches any name.
  | { kind: 'Descendants'; object: Expr; name: string }
  // An E4X XML literal (`<a/>`, `<items></items>`) captured VERBATIM in `raw`.
  // The text is handed to the runtime's XML parser at run time, so the literal
  // and `new XML("...")` share one implementation. Embedded `{expr}`
  // interpolations are rejected loudly in the lexer (see lexer.ts).
  | { kind: 'XmlLit'; raw: string };

export interface Program {
  body: Stmt[];
  imports: string[];
}
