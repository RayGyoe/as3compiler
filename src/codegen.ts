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

export function generateC(program: Program): CodegenResult {
  const symbols = new SymbolTable();
  symbols.collect(program);
  const emitter = new Emitter(program, symbols);
  const c = emitter.run();
  return { c, exports: [...symbols.exports] };
}
