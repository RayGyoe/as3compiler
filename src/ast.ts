// AST node definitions for the AS3 minimal subset.

export type ASType =
  | 'int'
  | 'uint'
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

// AS3 bracket metadata (e.g. [WasmExport] / [WasmExport("alias")]).
export interface Metadata {
  name: string;
  args: string[];
}

export type Stmt =
  | { kind: 'VarDecl'; name: string; type: ASType | null; init: Expr | null }
  | { kind: 'VarDecls'; decls: { name: string; type: ASType | null; init: Expr | null }[] }
  | { kind: 'ConstDecl'; name: string; type: ASType | null; init: Expr | null }
  | { kind: 'ExprStmt'; expr: Expr }
  | { kind: 'Block'; body: Stmt[] }
  | { kind: 'If'; cond: Expr; then: Stmt; else: Stmt | null }
  | { kind: 'While'; cond: Expr; body: Stmt }
  | { kind: 'DoWhile'; cond: Expr; body: Stmt }
  | { kind: 'For'; init: Stmt | null; cond: Expr | null; update: Expr | null; body: Stmt }
  | { kind: 'ForIn'; varName: string; declares: boolean; iterable: Expr; body: Stmt }
  | { kind: 'ForEachIn'; varName: string; varType: ASType | null; iterable: Expr; body: Stmt }
  | { kind: 'Switch'; disc: Expr; cases: SwitchCase[] }
  | { kind: 'Break'; label: string | null }
  | { kind: 'Continue'; label: string | null }
  | { kind: 'Label'; name: string; body: Stmt }
  | { kind: 'Return'; value: Expr | null }
  | { kind: 'SuperCall'; args: Expr[] }
  | { kind: 'Throw'; value: Expr }
  | { kind: 'Try'; tryBody: Block; catchVar: string | null; catchType: ASType | null; catchBody: Block | null; finallyBody: Block | null }
  | { kind: 'FuncDecl'; name: string; params: Param[]; returnType: ASType; body: Block; metadata: Metadata[] }
  | { kind: 'ClassDecl'; name: string; packageName: string | null; superClass: string | null; members: ClassMember[]; isFinal: boolean; implements: string[]; metadata: Metadata[] }
  | { kind: 'InterfaceDecl'; name: string; packageName: string | null; methods: InterfaceMethod[] };

export interface SwitchCase {
  test: Expr | null; // null marks the `default` clause
  body: Stmt[];
}

export type Visibility = 'public' | 'private' | 'protected' | 'internal';

export interface InterfaceMethod { name: string; params: Param[]; returnType: ASType; }

export type ClassMember =
  | { kind: 'Field'; name: string; type: ASType | null; init: Expr | null; visibility: Visibility; isStatic: boolean; isConst: boolean }
  | { kind: 'Method'; name: string; params: Param[]; returnType: ASType; body: Block; visibility: Visibility; isStatic: boolean; isFinal: boolean; isGetter: boolean; isSetter: boolean; metadata: Metadata[] }
  | { kind: 'Constructor'; params: Param[]; body: Block };

export type Expr =
  | { kind: 'Num'; value: number; isInt: boolean }
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
  | { kind: 'SuperMethod'; method: string; args: Expr[] }
  | { kind: 'Is'; obj: Expr; typeName: string }
  | { kind: 'As'; obj: Expr; typeName: string }
  | { kind: 'In'; key: Expr; object: Expr }
  | { kind: 'New'; className: string; args: Expr[] }
  | { kind: 'NewDynamic'; classExpr: Expr; args: Expr[] }
  | { kind: 'ArrayLit'; elements: Expr[] }
  | { kind: 'Index'; object: Expr; index: Expr }
  | { kind: 'ObjectLit'; fields: { name: string; value: Expr }[] }
  | { kind: 'FunctionExpr'; params: Param[]; returnType: ASType; body: Block }
  | { kind: 'RegExp'; pattern: string; flags: string };

export interface Program {
  body: Stmt[];
  imports: string[];
}
