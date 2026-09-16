// C code generator: orchestrates pass 1 (symbol collection) and pass 2 (C
// emission) and returns the complete C translation unit.

import type { Program } from './ast.ts';
import { SymbolTable, type ExportedSymbol } from './symbols.ts';
import { Emitter } from './emit.ts';

export { CodegenError } from './symbols.ts';
export type { ExportedSymbol } from './symbols.ts';

export interface CodegenResult {
  c: string;
  exports: ExportedSymbol[];
}

export interface CodegenOptions {
  // Injected at compile time as Capabilities.version (single source of truth is
  // package.json — the compiled binary has no package.json to read at runtime).
  asAotVersion?: string;
}

export function generateC(program: Program, options: CodegenOptions = {}): CodegenResult {
  const symbols = new SymbolTable();
  symbols.collect(program);
  const emitter = new Emitter(program, symbols, options.asAotVersion ?? '');
  const c = emitter.run();
  return { c, exports: [...symbols.exports] };
}
