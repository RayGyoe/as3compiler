// Unit group: the CLI surface that is met before any compilation happens.
//
// Two commands were added because three ways of asking "which version is this?"
// each failed differently, and none of them said what was wrong: `--version` and
// `-V` were `unknown argument` (buried under a Node stack), `-v` was swallowed as
// doctor's --verbose, and a bare `version` was taken for an input file and died
// with `ENOENT: open 'version'`. Nothing about the compiler is exercised by any
// of that, so no example could ever have caught it -- hence a unit group.
//
// What is pinned here, and why each one could regress quietly:
//   1. the version reported IS package.json's (the stage ritual bumps that file
//      only, so a second copy in the sources would drift from it silently);
//   2. `-v` still means `doctor --verbose` -- it predates --version, so quietly
//      repurposing it would break scripts that already pass it;
//   3. an argument error is one line and no stack (the stack is behind AS3_TRACE);
//   4. the update check is opt-in, read-only, never fatal, and never moves the
//      exit code -- 0/1/2 are build-readiness and a machine that merely cannot
//      reach the registry is still one that can build;
//   5. an argument error carries a NEXT STEP. A near miss of a known flag is
//      guessed at, a flag nothing resembles gets pointed at `--help`, and a
//      value-taking flag that got no value is refused -- the last one used to
//      be silent (a trailing `-o` built under the default name; `-o --dry`
//      named the output `--dry` and lost the flag, surfacing only later as
//      clang rejecting `--dry.c`).
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root, registerGroup } from '../harness.ts';
import { compareVersions, describeUpdate, type UpdateStatus } from '../../src/doctor.ts';

const readSrc = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; version: string };

interface Run {
  out: string;
  err: string;
  code: number;
}

function run(args: string[], env: Record<string, string> = {}, cwd: string = root): Run {
  // Absolute, because some checks run the CLI from a scratch directory: the
  // entry point has to be found no matter which cwd the check established.
  //
  // Every inherited `npm_config_*` variable is dropped first. Windows environment
  // variables are CASE-INSENSITIVE, so a machine-wide `NPM_CONFIG_REGISTRY` wins
  // over the lower-case one a check passes, and the update check then talks to
  // whatever registry that shell was pointed at (the observed symptom: a 404 from
  // a mirror, so the report never named 127.0.0.1:45999 and the pin went red for
  // a reason no compiler change could fix). Dropping the family is right on every
  // host: a test that discovers a registry is the only one that may choose it.
  const inherited: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^npm_config_/i.test(k)) inherited[k] = v;
  }
  const r = spawnSync('node', [join(root, 'src', 'index.ts'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...inherited, ...env },
  });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? -1 };
}

// A scratch directory OUTSIDE the repo: the checks below deliberately provoke
// commands that used to write files, and nothing they do may leave a `--dry.c`
// behind for another suite to trip over.
function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'asc-cli-argerrors-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A port nothing listens on -- and one fetch will actually connect to, which is
// why it is not 9 or 1: those are on the fetch spec's "bad port" blocklist, so
// they fail before connect() and report "bad port" instead of a refusal.
const DEAD_REGISTRY = 'http://127.0.0.1:45999/';

function checkVersionCommand(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [cli] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [cli] ${label}`); }
  };

  const expected = `as3compiler ${pkg.version}`;
  const long = run(['--version']);
  const short = run(['-V']);
  const subcommand = run(['version']);

  check('--version prints one version line and exits 0', long.out.trim() === expected && long.code === 0);
  check('-V is the same thing', short.out.trim() === expected && short.code === 0);
  check('the `version` subcommand is the same thing (it reads no file called "version")',
    subcommand.out.trim() === expected && subcommand.code === 0);
  // The name in front is the PACKAGE's, because that is what identifies a release
  // to the registry; the last field is the bare semver, so `--version | awk
  // '{print $NF}'` works in a script.
  check('the line names the package, so a pasted report identifies the release',
    expected.split(' ')[0] === pkg.name && long.out.trim().endsWith(pkg.version));

  // One source of truth: the stage ritual bumps package.json, so the version must
  // be READ from there rather than repeated in the sources -- a second copy drifts
  // the first time someone bumps one and not the other.
  const index = readSrc('src/index.ts');
  check('the version is read from package.json, not a second constant',
    index.includes("new URL('../package.json', import.meta.url)")
    && !index.includes(`'${pkg.version}'`) && !index.includes(`"${pkg.version}"`));

  // `-v` predates --version and means `doctor --verbose`: repurposing it would
  // break anyone already passing it, so -V is the flag that had to give.
  const verbose = run(['-v']);
  check('-v still means doctor --verbose, not --version',
    verbose.out === '' && verbose.code === 1 && verbose.err.includes('Usage: as-aot'));
  const help = run(['-h']);
  check('the help lists both flags, unambiguously',
    help.out.includes('  -V, --version') && help.out.includes('  -v, --verbose'));
  check('the help names the version subcommand too', help.out.includes('as-aot version'));

  // Argument errors are the compiler talking to a user, not a crash: the stack is
  // for whoever is debugging the compiler, and AS3_TRACE is how they ask for it.
  const typo = run(['--versionn']);
  check('an unknown flag is one line, not a Node stack',
    typo.err.includes('unknown argument: --versionn') && !typo.err.includes('    at '));
  check('AS3_TRACE=1 brings the stack back (a bug report wants it)',
    run(['--versionn'], { AS3_TRACE: '1' }).err.includes('    at '));

  // The report header is where "which release am I running" belongs, next to
  // platform/node -- `doctor` is already the "what is this machine" command.
  const report = JSON.parse(run(['doctor', '--json']).out) as { compiler: { name: string; version: string } };
  check('doctor --json carries the compiler name and version',
    report.compiler.name === pkg.name && report.compiler.version === pkg.version);
  check('the human header carries the version next to platform/node',
    run(['doctor']).out.split('\n')[0].includes(pkg.version));

  if (ok > 0) console.log(`[cli] ${ok} version-surface checks passed`);
  return bad;
}

function checkUpdateCheck(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [cli] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [cli] ${label}`); }
  };

  // ---- the comparison (pure: the interesting cases need no network) ---------
  check('a newer release compares greater', compareVersions('0.4.181', '0.4.180') > 0);
  check('an equal version compares equal', compareVersions('0.4.180', '0.4.180') === 0);
  check('an older release compares less', compareVersions('0.4.179', '0.4.180') < 0);
  check('the comparison is numeric, not lexicographic',
    compareVersions('0.10.0', '0.9.9') > 0 && compareVersions('2.0.0', '10.0.0') < 0);
  check('a prerelease does not read as newer than its own release',
    compareVersions('0.5.0-beta.1', '0.5.0') === 0);

  // ---- the three renderings (plain text: the caller picks the colour) ------
  const upToDate: UpdateStatus = { current: '0.4.180', latest: '0.4.180', upToDate: true, error: null };
  const behind: UpdateStatus = { current: '0.4.180', latest: '0.4.181', upToDate: false, error: null };
  const failed: UpdateStatus = { current: '0.4.180', latest: null, upToDate: null, error: 'the reason' };
  check('up to date says so, naming the version',
    describeUpdate(upToDate) === 'up to date: 0.4.180 is the latest published release');
  check('being behind gives the upgrade command, not just a hint',
    describeUpdate(behind).includes('0.4.180 -> 0.4.181')
    && describeUpdate(behind).includes('npm i -g as3compiler@latest'));
  check('a check that could not complete states the reason',
    describeUpdate(failed).includes('could not check') && describeUpdate(failed).includes('the reason'));
  check('the rendering carries no escape codes of its own',
    ![upToDate, behind, failed].some((s) => describeUpdate(s).includes('\x1b')));
  check('an unreadable version is still described, never left blank',
    describeUpdate({ current: '', latest: null, upToDate: null, error: 'this build reports no version' })
      === 'could not check for a newer release (this build reports no version)');

  // ---- end to end, against a registry that refuses the connection ----------
  // Offline is the case that must be boring: it is reported, it names where we
  // looked, and the run is otherwise exactly the run without the flag.
  const withFlag = run(['doctor', '--check-update'], { npm_config_registry: DEAD_REGISTRY });
  const withoutFlag = run(['doctor'], { npm_config_registry: DEAD_REGISTRY });
  check('an unreachable registry is reported, naming where we looked',
    withFlag.out.includes('could not check for a newer release')
    && withFlag.out.includes('127.0.0.1:45999'));
  check('...and does not change the exit code (that code is build-readiness)',
    withFlag.code === withoutFlag.code);
  check('...and is never thrown at the user',
    withFlag.err.trim() === '');
  check('without the flag there is no update line at all (opt-in -- no silent network)',
    !withoutFlag.out.includes('could not check') && !withoutFlag.out.includes('newer release'));
  check('--check-update outside the doctor subcommand is refused, not silently ignored',
    run(['nope.as', '--check-update']).err.includes('only applies to the doctor subcommand'));
  check('the registry is the one npm_config_registry names (a mirror is honoured)',
    readSrc('src/index.ts').includes('process.env.npm_config_registry'));

  // ---- and --json stays one object, which is what CI parses ---------------
  const json = run(['doctor', '--json', '--check-update'], { npm_config_registry: DEAD_REGISTRY });
  let parsed: { compiler?: { version?: string }; update?: UpdateStatus } | null = null;
  try { parsed = JSON.parse(json.out) as typeof parsed; } catch { parsed = null; }
  check('--check-update --json is still one parseable object',
    parsed !== null && parsed.compiler?.version === pkg.version);
  // The failure has to be a STATUS in the object, not a missing key: "asked and
  // could not reach the registry" must not read like "never asked".
  check('...with the failed check recorded as a status, not an absent key',
    parsed?.update !== undefined && parsed.update.current === pkg.version
    && parsed.update.latest === null && parsed.update.upToDate === null && parsed.update.error !== null);
  const jsonPlain = JSON.parse(run(['doctor', '--json']).out) as Record<string, unknown>;
  check('...while an absent `update` key means "not checked"',
    !Object.prototype.hasOwnProperty.call(jsonPlain, 'update'));

  // ---- the path we ask for ------------------------------------------------
  // Built from the package's own name: rename the package and this goes red,
  // instead of the check silently asking npmjs for a package that no longer exists
  // (which would arrive as a 404 indistinguishable from being offline).
  check('the registry path carries the package\'s own name',
    readSrc('src/doctor.ts').includes(`/${pkg.name}/latest`));

  if (ok > 0) console.log(`[cli] ${ok} update-check checks passed`);
  return bad;
}

function checkArgErrors(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [argerr] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [argerr] ${label}`); }
  };

  // ---- an unknown flag says where the list is ----------------------------
  // 阶段二百零二: the message used to be a bare `unknown argument: X`. It is
  // still ONE line, still stderr, still not a stack -- what is new is that it
  // carries a next step. Two shapes of mistake, two different next steps:
  // a near miss is guessed at, and a flag nothing resembles gets the pointer.
  const bare = run(['--sss']);
  check('an unrecognised flag still names itself, in one line, without a stack',
    bare.err.includes('unknown argument: --sss') && !bare.err.includes('    at ')
    && bare.err.split('\n').filter((l) => l.trim() !== '').length === 1);
  check('...and points at the list when it cannot guess',
    bare.err.includes('as-aot --help') && !bare.err.includes('did you mean'));
  // The rule that keeps the guess trustworthy: two edits is only a typo
  // RELATIVE to the name's length. `--sss` is two edits from `--swc`, and
  // suggesting `--swc` there would send the user further from the answer than
  // the bare message did.
  check('a short name is never guessed at from far away', !bare.err.includes('--swc'));
  check('a plausible-but-distant alias is answered with the list, not a wrong guess',
    !run(['--output']).err.includes('did you mean'));

  check('a misspelt long flag is guessed at',
    run(['--versoin']).err.includes('did you mean --version?'));
  check('...and so is a transposition',
    run(['--hepl']).err.includes('did you mean --help?'));
  check('...and a flag the user stopped typing',
    run(['--feat']).err.includes('did you mean --features?'));
  // Single-letter flags are one edit from EACH OTHER, so any guess there is a
  // coin flip. No guess at all beats a confident wrong one.
  check('a single-letter flag gets no guess (they are all one edit apart)',
    !run(['-x']).err.includes('did you mean') && run(['-x']).err.includes('as-aot --help'));

  // ---- a value-taking flag must actually get a value ---------------------
  // Both of these were SILENT before. `x.as -o` set the output to `undefined`
  // and the `?? default` downstream built under the default name as if -o had
  // never been written; `-o --dry` named the output `--dry`, dropped the flag,
  // and only came back as clang rejecting `--dry.c`.
  const example = join(root, 'examples', 'any-add.as');
  withTempDir((dir) => {
    copyFileSync(example, join(dir, 'any-add.as'));

    const trailing = run(['any-add.as', '--dry', '-o'], {}, dir);
    check('a flag with no value left is refused, naming the flag',
      trailing.err.includes('-o: expects a value') && trailing.err.includes('last argument')
      && trailing.code === 1);
    check('...and nothing is built under the default name behind the user',
      readdirSync(dir).join(',') === 'any-add.as');

    const swallowed = run(['any-add.as', '-o', '--dry'], {}, dir);
    check('a flag that would swallow the NEXT flag is refused, naming both',
      swallowed.err.includes('expects a value') && swallowed.err.includes('--dry')
      && swallowed.code === 1);
    check('...so the file named after the swallowed flag never appears',
      readdirSync(dir).join(',') === 'any-add.as');

    // The check is "is this operand a known flag", NOT "does it start with a
    // dash": these three are legitimate values that do start with one, and a
    // naive guard would break all three.
    const legit = run(['any-add.as', '--dry', '-o', 'out', '--opt', '-O3', '-D', 'FOO=-1', '-I', '.'], {}, dir);
    check('a value that starts with a dash is still a value',
      legit.code === 0 && legit.out.includes('-O3') && legit.out.includes('FOO=-1'));
  });

  // ---- one list, read by both features ----------------------------------
  // The suggestion and the missing-value check share KNOWN_FLAGS. A second copy
  // would drift from the parser the first time a flag is added, and the failure
  // would be invisible (a flag that exists but is never suggested, or one the
  // parser rejects but the guard treats as a value). So the list is checked
  // AGAINST the parser's own chain, in both directions.
  const src = readSrc('src/index.ts');
  const body = src.slice(src.indexOf('function parseArgs'), src.indexOf('function usage()'));
  const accepted = [...body.matchAll(/a === '([^']+)'/g)].map((m) => m[1]);
  const listed = (src.match(/const KNOWN_FLAGS: readonly string\[\] = \[([\s\S]*?)\n\];/) ?? ['', ''])[1];
  const known = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  check('every flag the parser accepts is in KNOWN_FLAGS (the parse is real, not vacuous)',
    accepted.length >= 30 && accepted.every((f) => known.includes(f)));
  check('...and KNOWN_FLAGS holds nothing the parser rejects, nor a duplicate',
    new Set(known).size === known.length && known.every((f) => accepted.includes(f)));

  if (ok > 0) console.log(`[argerr] ${ok} argument-diagnostic checks passed`);
  return bad;
}

registerGroup('unit: cli/Version', checkVersionCommand);
registerGroup('unit: cli/UpdateCheck', checkUpdateCheck);
registerGroup('unit: cli/ArgErrors', checkArgErrors);
