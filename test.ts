// Test runner: compile and run every example in examples/, reporting pass/fail.
// This is the stage-8 assertion-style regression suite for the whole compiler.
// Usage: node test.ts

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = import.meta.dirname;
const dir = join(root, 'examples');
const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

let pass = 0;
const failed: string[] = [];

// GUI entry points that open a window are not part of the automated regression:
// a directory must have exactly one top-level entry, and boot-gui.as duplicates
// boot.as (offscreen). They still compile standalone in pure-C mode, but the
// directory unit already uses the offscreen entry.
// air-native's Main instantiates TweenDemo, which depends on the GreenSock core
// (a third-party library directory excluded by SKIP_DIRS below). Those specific
// sources are re-added explicitly for the air-native unit (see GREENSOCK_CORE).
const SKIP_FILES = new Set(['boot-gui.as']);
// Third-party library directories (e.g. com/greensock) ship with full AIR apps
// but depend on features outside this compiler's subset; they are not part of
// the regression suite's input.
const SKIP_DIRS = new Set(['com', 'org', 'net']);
// GreenSock core files that air-native's TweenDemo actually reaches. Only these
// are pulled in; the rest of com/greensock (easing/loading/other plugins) stays
// outside the subset and is not compiled.
const GREENSOCK_CORE = [
  'com/greensock/TweenLite.as',
  'com/greensock/core/TweenCore.as',
  'com/greensock/core/SimpleTimeline.as',
  'com/greensock/core/PropTween.as',
  'com/greensock/plugins/TweenPlugin.as',
  'com/greensock/easing/Quad.as',
  'com/greensock/easing/Cubic.as',
];

// Recursively collect .as files so nested multi-file projects (e.g.
// air-native/src/demo/*.as plus its boot.as entry) compile as one unit.
function collectAsFiles(path: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...collectAsFiles(full));
    }
    else if (e.name.endsWith('.as') && !SKIP_FILES.has(e.name)) out.push(full);
  }
  return out.sort();
}

function runExample(label: string, args: string[]): void {
  try {
    execFileSync('node', ['src/index.ts', ...args, '--run'], { cwd: root, stdio: 'pipe' });
    console.log(`PASS  ${label}`);
    pass++;
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    console.log(`FAIL  ${label}`);
    if (e.stdout) process.stdout.write(e.stdout.toString());
    if (e.stderr) process.stderr.write(e.stderr.toString());
    failed.push(label);
  }
}

for (const e of entries) {
  if (e.isDirectory()) {
    // Multi-file example: compile every .as in the subdirectory (recursively) as one unit.
    const subDir = join(dir, e.name);
    const subFiles = collectAsFiles(subDir);
    if (subFiles.length === 0) continue;
    if (e.name === 'air-native') {
      for (const g of GREENSOCK_CORE) subFiles.push(join(subDir, 'src', g));
    }
    const names = subFiles.map((f) => f.slice(subDir.length + 1));
    runExample(`${e.name}/ (${names.join(', ')})`, subFiles);
  } else if (e.name.endsWith('.as')) {
    runExample(e.name, [join(dir, e.name)]);
  }
}

console.log(`\n${pass} passed, ${failed.length} failed, ${pass + failed.length} total`);
if (failed.length > 0) {
  console.log('Failed examples:');
  for (const f of failed) console.log(`  ${f}`);
  process.exit(1);
}
