// Build the publishable `dist/` tree: src/*.ts -> dist/*.js.
//
// Why this exists at all: the package may not ship `src/` as its bin target.
// Node refuses to strip types for any file under node_modules
// (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and that refusal is a
// permanent loader restriction, not a version gate -- measured on Node 24.14.1,
// the newest at the time of writing. So `npm i -g as3compiler` + `as-aot`
// crashed on EVERY install. The published entry point therefore has to be
// ordinary JavaScript.
//
// Zero dependencies by design (AGENTS.md §3.1): `module.stripTypeScriptTypes`
// is built into Node itself, so this is not a toolchain -- it is a rewrite in
// place. Two properties make it safe to hand to consumers:
//   * `mode: 'strip'` blanks each type annotation in place rather than deleting
//     it, so line and column numbers are preserved 1:1 with src/. A stack frame
//     in dist/ still names the same line of the same module.
//   * nothing is minified or renamed, which is the same "generated code stays
//     readable" promise the C backend makes (§2.6).
// The emitted C is bit-for-bit identical to the .ts run (verified against
// stage80.as, 2521035 bytes), so this changes the delivery form and nothing else.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nodeModule from 'node:module';

const stripTypeScriptTypes = (nodeModule as { stripTypeScriptTypes?: (code: string, opts: { mode: 'strip' }) => string })
  .stripTypeScriptTypes;

if (typeof stripTypeScriptTypes !== 'function') {
  // Loud, with the version gate named: silently shipping a package whose bin
  // points at a missing dist/ is exactly the failure this script prevents.
  console.error(
    'build-dist: node:module.stripTypeScriptTypes is unavailable. ' +
      `Node ${process.version} is too old to build dist/ -- type stripping landed in ` +
      'Node 22.18.0 / 23.6.0. Run the build under a newer Node.'
  );
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
const outDir = join(root, 'dist');

// Relative specifiers are the only rewrite needed: the sources import each other
// with explicit `.ts` (required by the type-stripping loader), while the emitted
// JS must name the `.js` file that is actually on disk. Bare `node:`/builtin
// specifiers and non-relative ones are left alone.
const TS_RELATIVE_FROM = /(from\s+['"])(\.\.?\/[^'"]+)\.ts(['"])/g;

// Start from an empty tree so a module deleted from src/ cannot survive as a
// stale dist/*.js that still gets shipped and still resolves.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const modules = readdirSync(srcDir).filter((f) => f.endsWith('.ts')).sort();
let bytes = 0;

for (const file of modules) {
  const js = stripTypeScriptTypes(readFileSync(join(srcDir, file), 'utf8'), { mode: 'strip' }).replace(
    TS_RELATIVE_FROM,
    '$1$2.js$3'
  );
  const name = `${file.slice(0, -'.ts'.length)}.js`;
  const outPath = join(outDir, name);
  writeFileSync(outPath, js);
  // The bin target keeps its shebang (preserved verbatim by the stripper, it is
  // not a TypeScript construct) and so must keep the exec bit, since npm links
  // bin entries straight to this path.
  if (name === 'index.js') chmodSync(outPath, 0o755);
  bytes += Buffer.byteLength(js);
}

// stderr, not stdout, and deliberately so: this script runs from `prepare`, i.e.
// inside `npm pack` / `npm publish`, and npm's `--json` mode writes its report to
// stdout. A summary on stdout would prefix the JSON with a non-JSON line and
// break every tool that parses `npm publish --json`.
console.error(`build-dist: ${modules.length} module(s), ${bytes} bytes -> dist/`);
