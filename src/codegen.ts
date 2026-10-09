// C code generator: orchestrates pass 1 (symbol collection) and pass 2 (C
// emission) and returns the complete C translation unit.

import type { Program } from './ast.ts';
import { SymbolTable, type ExportedSymbol } from './symbols.ts';
import { Emitter } from './emit.ts';
import type { SwcResourceSpec, SwcBake } from './swc.ts';
import type { EmbedResourceSpec } from './embed.ts';

export { CodegenError } from './symbols.ts';
export type { ExportedSymbol } from './symbols.ts';

export interface CodegenResult {
  c: string;
  exports: ExportedSymbol[];
}

// `keepGlobal` carries the CLI `--export` C symbol names into codegen. They must
// survive staticizeTopLevelFunctions (阶段七十八 static 化), which otherwise marks
// every non-[WasmExport] file-scope function `static` — and `static` bytes can't be
// named by wasm-ld's `--export`, so the link failed with "symbol exported via
// --export not found" for a CLI-only export like `--export fib`.
export function generateC(
  program: Program,
  keepGlobal: readonly string[] = [],
  swcResources: readonly SwcResourceSpec[] = [],
  swcBake: SwcBake | undefined = undefined,
  embedResources: readonly EmbedResourceSpec[] = [],
  embedFieldInits?: ReadonlyMap<string, string>
): CodegenResult {
  const symbols = new SymbolTable();
  symbols.collect(program, embedFieldInits);
  const emitter = new Emitter(program, symbols, keepGlobal, swcResources, swcBake, embedResources);
  const c = emitter.run();
  return { c, exports: [...symbols.exports] };
}
