// Unit group: the publish form of the npm package.
//
// The example suite compiles and runs every example through `node src/index.ts`,
// so it exercises the compiler and NOTHING about the artifact users install. The
// two can disagree completely while every example stays green, and they did: the
// package shipped `"bin": { "as-aot": "src/index.ts" }`, which meant every install
// of every kind died on
//   ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
// the moment the user ran the command (measured on Node 24.14.1, the newest at the
// time -- local install AND `npm i -g`). Node refuses to strip types for files
// under node_modules by design; that is permanent, not a version gate, so no
// `engines` floor could have rescued it.
//
// The fix is that the published entry point is built JavaScript (`dist/`), which
// makes the *form* of the shipped package load-bearing. Every check here pins a
// property that a green example run cannot see, and none of them is a guess:
//   1. bin must name JavaScript, under the directory `files` actually ships;
//   2. somewhere in the lifecycle a hook rebuilds dist/, because dist/ is
//      gitignored and a stale or absent tree must not reach the tarball;
//   3. the packed tarball really does contain that tree -- `files` is an
//      allowlist, but .gitignore still applies inside it in some npm versions, and
//      we now gitignore dist/ (measured: npm 11 keeps it, which is exactly why the
//      check exists rather than a comment);
//   4. dist/ is semantically identical to src/, not merely present: the same input
//      must produce byte-identical C through both entry points.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerGroup, root } from '../harness.ts';

// A temp tree outside the repo: these checks read the packed artifact and the
// built tree, so nothing they do may leave a file behind that another suite
// (or the [no-src-litter] snapshots) could mistake for source.
function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'asc-npm-package-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface PackedManifest {
  files?: { path: string }[];
}

function checkPublishForm(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) {
      ok++;
      console.log(`PASS  [npm-package] ${label}`);
    } else {
      bad.push(label);
      console.log(`FAIL  [npm-package] ${label}`);
    }
  };

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    bin?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
    engines?: { node?: string };
  };
  const binTarget = pkg.bin?.['as-aot'] ?? '';
  const binDir = binTarget.includes('/') ? binTarget.slice(0, binTarget.lastIndexOf('/')) : '';

  // 1. The load-bearing shape: a .js file, under a shipped directory. Naming
  //    src/index.ts here is the original bug, and it is a one-character edit away.
  check('bin.as-aot names JavaScript, not TypeScript', binTarget.endsWith('.js') && !binTarget.endsWith('.ts'));
  check('bin.as-aot lives under dist/ (the built tree, not the sources)', binDir === 'dist');
  check('files ships the directory the bin lives in', Array.isArray(pkg.files) && pkg.files.includes(binDir));
  // 2. Shipping src/ would be dead weight at best and a decoy at worst: a .ts under
  //    node_modules can never be loaded, so its presence invites the old mistake.
  check('files does not ship src/ (unloadable once installed)', Array.isArray(pkg.files) && !pkg.files.includes('src'));

  // 3. dist/ is generated and gitignored, so it only exists at publish time if a
  //    lifecycle hook puts it there. `prepare` runs for pack, publish and git-dep
  //    installs; prepack/prepublishOnly also qualify -- any one is enough.
  const builders = ['prepare', 'prepack', 'prepublishOnly'].filter((h) =>
    (pkg.scripts?.[h] ?? '').includes('build-dist')
  );
  check('a pack/publish lifecycle hook builds dist/ before packaging', builders.length > 0);

  // 4. The whole point of the build step is that the shipped JS does not need Node
  //    to strip anything, so the declared floor must not sit above the versions
  //    that made the old .ts form work. (The runtime floor measured over src/ is
  //    lower still -- Object.hasOwn, i.e. ~16.9 -- but the claim we can support is
  //    the one that matters: dropping the type-stripping requirement.)
  const floor = /^>=\s*(\d+)\.(\d+)/.exec(pkg.engines?.node ?? '');
  const floorMajor = floor ? Number(floor[1]) : Number.POSITIVE_INFINITY;
  const floorMinor = floor ? Number(floor[2]) : 0;
  check(
    'engines.node no longer requires a type-stripping Node (22.6 / 22.18)',
    floorMajor < 22 || (floorMajor === 22 && floorMinor < 6)
  );

  // ---- the artifact itself -------------------------------------------------

  const distDir = join(root, binDir);
  const srcDir = join(root, 'src');

  let built = false;
  try {
    execFileSync('node', [join('scripts', 'build-dist.ts')], { cwd: root, stdio: 'ignore' });
    built = true;
  } catch {
    built = false;
  }
  check('scripts/build-dist.ts runs', built);

  const binPath = join(root, binTarget);
  const binExists = existsSync(binPath);
  check('dist/<bin> exists after the build', binExists);

  if (binExists) {
    const head = readFileSync(binPath, 'utf8').slice(0, 2);
    // The shebang is what makes npm's bin shim executable, and the exec bit is
    // what `node_modules/.bin/as-aot` is linked to -- npm does not add either.
    check('dist/<bin> keeps its shebang', head === '#!');
    // NTFS has no execute bit, so the file mode says 0o666 on Windows no matter
    // what the build asked for; the mode the build REQUESTS is the thing to pin
    // there (writeFileSync cannot represent it), and on POSIX the real bit.
    check('dist/<bin> is executable (npm links bin straight at it)',
      process.platform === 'win32'
        ? readFileSync(join(root, 'scripts', 'build-dist.ts'), 'utf8')
            .includes("if (name === 'index.js') chmodSync(outPath, 0o755);")
        : (statSync(binPath).mode & 0o111) !== 0);
  }

  // Module-for-module parity, both directions: a module that failed to strip, or a
  // stale .js left behind by a rename, are the two ways the tree drifts from src/.
  const srcModules = readdirSync(srcDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.slice(0, -'.ts'.length))
    .sort();
  const distModules = existsSync(distDir)
    ? readdirSync(distDir)
        .filter((f) => f.endsWith('.js'))
        .map((f) => f.slice(0, -'.js'.length))
        .sort()
    : [];
  check('every src module has a dist counterpart (and none is stale)', srcModules.join(',') === distModules.join(','));

  const danglingSpecifiers: string[] = [];
  const lineMismatches: string[] = [];
  for (const mod of distModules) {
    const js = readFileSync(join(distDir, `${mod}.js`), 'utf8');
    // A surviving `.ts` specifier resolves to no file under node_modules, so it is
    // a hard ENOENT on import -- the exact failure mode of a half-done build.
    if (/from\s+['"]\.\.?\/[^'"]+\.ts['"]/.test(js)) danglingSpecifiers.push(mod);
    // `mode: 'strip'` blanks annotations in place rather than deleting them, which
    // is what keeps stack frames in dist/ pointing at the same line of the same
    // module. Losing that would silently devalue every traceback users paste.
    if (existsSync(join(srcDir, `${mod}.ts`))) {
      const srcLines = readFileSync(join(srcDir, `${mod}.ts`), 'utf8').split('\n').length;
      if (srcLines !== js.split('\n').length) lineMismatches.push(mod);
    }
  }
  check('no relative .ts specifier survives into dist/', danglingSpecifiers.length === 0);
  check('dist line numbers still map 1:1 onto src', lineMismatches.length === 0);

  // ---- dist has to actually load, and behave the same -----------------------

  const usage = (() => {
    try {
      // Default stdio is [pipe, pipe, pipe]: the banner has to be captured, and
      // the no-argument invocation is a usage error (non-zero), so the throw is
      // how we get at it. What matters is that the process got far enough to
      // print a banner at all -- a dangling import throws at load time with an
      // ENOENT / ERR_MODULE_NOT_FOUND and prints nothing of the sort.
      execFileSync('node', [binTarget], { cwd: root });
      return null;
    } catch (err) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
      return `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
  })();
  check(
    'dist/ loads: no-arg run reaches the usage banner (no dangling import)',
    usage !== null && usage.includes('Usage: as-aot')
  );

  const cFrom = withTempDir((dir) => {
    const smoke = join(dir, 'smoke.as');
    // Exercises both a boxed `+` (Array element) and a static String concat: the
    // two paths most sensitive to a corrupted emit.
    writeFileSync(smoke, 'var xs:Array = [3, 4];\nvar n:Number = xs[0] + xs[1];\ntrace("smoke=" + n + " " + typeof xs);\n');
    const emitThrough = (entry: string, name: string): string => {
      execFileSync('node', [entry, smoke, '-o', join(dir, name), '--dry'], { cwd: root, stdio: 'ignore' });
      return readFileSync(join(dir, `${name}.c`), 'utf8');
    };
    return { viaSrc: emitThrough(join('src', 'index.ts'), 'a'), viaDist: emitThrough(binTarget, 'b') };
  });
  check(
    'dist emits byte-identical C to src for the same input',
    cFrom.viaSrc.length > 0 && cFrom.viaSrc === cFrom.viaDist
  );

  // ---- and it has to be in the tarball -------------------------------------

  const packed = withTempDir((dir) => {
    try {
      // Windows installs npm as `npm.cmd`, which execFileSync cannot spawn without
      // a shell (ENOENT, not a PATH problem): `shell: true` is the documented
      // answer and the command name is plain `npm` in both cases.
      const win = process.platform === 'win32';
      const out = execFileSync(win ? 'npm.cmd' : 'npm',
        ['pack', '--json', '--pack-destination', dir], {
          cwd: root,
          encoding: 'utf8',
          shell: win,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      const manifest = (JSON.parse(out) as PackedManifest[])[0];
      // The tarball lists POSIX paths on every host (npm's own convention), so a
      // `join()`-built expectation reads `dist\x.js` here and never matches.
      return (manifest.files ?? []).map((f) => f.path.replace(/\\/g, '/'));
    } catch {
      return null;
    }
  });
  check('npm pack succeeds', packed !== null);
  if (packed !== null) {
    check('the tarball contains the bin target (files beats the dist/ gitignore)', packed.includes(binTarget));
    check('the tarball ships no .ts at all', !packed.some((p) => p.endsWith('.ts')));
    check(
      'the tarball carries the whole dist/ tree',
      srcModules.every((m) => packed.includes(`${binDir.replace(/\\/g, '/')}/${m}.js`))
    );
  }

  if (ok > 0) console.log(`[npm-package] ${ok} publish-form checks passed`);
  return bad;
}

registerGroup('unit: npm-package/PublishForm', checkPublishForm);
