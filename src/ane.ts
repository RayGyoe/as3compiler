// ANE (Adobe native extension) resolution: turn the .ane packages a build is
// given into the static descriptor table the generated executable carries, and
// stage each package's native library next to the executable.
//
// Everything here happens at COMPILE time. AIR resolves an extensionID at run
// time out of the application's `extensions/` directory and parses extension.xml
// with a full XML engine; this build has no XML engine in its runtime and does
// not want one (AGENTS.md §1.1 — the front end translates, it does not ship an
// interpreter). So the lookup the runtime would have done is done here, once, and
// emitted as data.
//
// Two consequences worth stating, because they are the difference between this
// and AIR:
//
//   * The set of extensions a program can reach is fixed at build time. AIR can
//     load an extension the application never declared; here an extensionID that
//     is not in the descriptor table is reported and answered with null — the
//     same value AIR gives for an ID it cannot find, and never a silent success.
//   * The `extensions` directory is resolved relative to the executable (see
//     as_ext_dir in fre.ts), so the build stays relocatable.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { unzip, type ZipEntry } from './swc.ts';
import { ANE_COUNT_MAX, type AneDescriptor } from './fre.ts';

/**
 * Extra advice for a host with no AIR platform key of its own; '' when the plain
 * "pass --ane-platform <key>" instruction is already enough.
 *
 * Split out of index.ts's error path so it can be tested behaviourally: this
 * sentence is the only thing between "no key" and a user hand-writing
 * `--ane-platform Windows-arm64`, which AIR has never accepted. Kept next to
 * currentAnePlatform because it explains the answer that function gives.
 */
export function anePlatformHint(platform: string, arch: string): string {
  if (platform === 'win32' && arch === 'arm64') {
    return (
      '\n  On Windows ARM64 that key is Windows-x86-64, and it needs an x64 build to go with it ' +
      '(manifest "architecture": "64", or an air-app.xml <architecture>64</architecture>): AIR ships no ' +
      'Windows ARM64 runtime, so AIR itself runs these apps as x64 under emulation — and an arm64 ' +
      'process could not load an x64 asaot.dll anyway.'
    );
  }
  return '';
}

/**
 * The AIR platform key of the machine doing the build.
 *
 * An ANE carries one native library per platform, and only the current one is
 * usable: a Windows build cannot load the macOS slice and must not pretend it
 * can. AIR's own keys are `Windows-x86`, `Windows-x86-64`, `MacOS-x86-64` and
 * `iPhone-ARM`; an explicit override exists because a
 * cross-build (Windows host, macOS target) is the one case where the answer is
 * not the build machine. `MacOS-x86` is a real AIR key too, but no host library
 * is built for it, so it throws in aneHostDirName rather than being offered here.
 *
 * Returns '' when this host has no AIR key of its own, which the caller turns
 * into an error asking for an explicit `--ane-platform`. The two hosts that hit
 * that path are Linux (AIR ships a Linux runtime, but no `asaot` is built for
 * it) and Windows ARM64 (AIR has no Windows ARM64 runtime at all — see below).
 *
 * `platform`/`arch` are parameters rather than read straight from `process` so
 * every branch is reachable from a test: an x64 host cannot otherwise exercise
 * the ARM64 answer, and an untested branch is exactly where a silent wrong
 * target hides.
 */
export function currentAnePlatform(platform: string = process.platform, arch: string = process.arch): string {
  if (platform === 'win32') {
    if (arch === 'ia32') return 'Windows-x86';
    if (arch === 'x64') return 'Windows-x86-64';
    // Windows ARM64 returns '' instead of falling through to the x64 key.
    //
    // Deliberately NOT 'Windows-x86-64'. AIR has no Windows ARM64 runtime: in AIR
    // SDK 51.4.1 each Windows runtime carries exactly ONE platform key --
    // `Windows-x86` (win/) and `Windows-x86-64` (win64/) -- so the closed set is
    // those two, they are the only Windows runtimes the SDK ships, and the 51.4.1
    // release notes name arm64
    // for Linux/iOS/macOS only. So no .ane declares a Windows ARM64 slice and no
    // runtime would look for one. An arm64 process cannot dlopen the x64
    // asaot.dll either, so answering 'Windows-x86-64' here would be a silent
    // wrong target — the same failure mode as an override that parses but is
    // never applied. '' instead makes index.ts demand an explicit key, and the
    // correct answer on Windows ARM64 is an x64 build, which is what AIR itself
    // is under emulation.
    return '';
  }
  if (platform === 'darwin') {
    // ONE key for both macOS architectures, because the key does not encode one.
    //
    // Measured on AIR SDK 51.4.1: `runtimes/air/mac/Adobe AIR.framework/Versions/1.0/Adobe AIR`
    // is a UNIVERSAL binary (x86_64 + arm64 slices -- `Adobe AIR_64` beside it is a
    // 9-byte symlink to it), and its ANE-loader string table reads
    // `".framework", "MacOS-x86-64", "/Contents/MacOS/", "Contents/Frameworks",
    //  "Failed to load ANE native library for %s: %s", "Loaded ANE native library for %s: %s"`.
    // That literal is in BOTH slices, so the arm64 runtime on Apple Silicon looks up
    // `MacOS-x86-64` as well: the macOS key names the platform pair, and the arch
    // lives in the .dylib the ANE ships (which is why macOS extensions are usually
    // universal).
    //
    // This function used to answer `MacOS-AOT` for darwin/arm64. That key exists
    // nowhere in the SDK (0 hits across 2079 files; the only file skipped, the 222 MB
    // `lib/aot/bin/ld64/ld64`, is a linker), and `lib/aot/` is the iOS/tvOS AOT
    // toolchain -- `libRuntimeHMAOT.arm-air.a` and the `iPhone-ARM` keys live there.
    // So the answer could never match a real .ane: the ONE macOS entry such a package
    // can declare (`MacOS-x86-64`) went unmatched on Apple Silicon -- `adl` on the
    // same machine loads it (AGENTS.md §1.5: a case AIR gets right and this build
    // does not is a defect, not an enhancement).
    return 'MacOS-x86-64';
  }
  return '';
}

/**
 * The `lib/bin/<name>/` directory holding the FRE host library for an AIR platform key.
 *
 * Deliberately NOT the AIR key spelled verbatim. The two name different things:
 * the AIR key is a ZIP subdirectory inside an .ane (`META-INF/ANE/Windows-x86-64/`),
 * whereas this names a host build product, and `vendor/` already settled that
 * vocabulary in lowercase (`vendor/sdl2/lib/windows-x64`, `vendor/curl/lib/windows-x64`).
 * Keeping the key for one job and the directory for the other is why the two can be
 * translated here in one place instead of being conflated at every call site.
 *
 * An unknown key is an ERROR rather than a fallback: guessing a directory would send
 * a build looking for a host library that was never built for that platform.
 *
 * There is deliberately no `Windows-arm64` case: AIR has no Windows ARM64 key to
 * translate (measured — see currentAnePlatform), so a `lib/bin/windows-arm64/`
 * would be a host library nothing could ever load. It falls into the throw below
 * rather than into a directory that exists for symmetry's sake. `MacOS-AOT` is the
 * same shape of non-key and throws for the same reason: the SDK never emits it, so a
 * `lib/bin/macos-arm64/` could never be asked for.
 *
 * `macos-x86-64` follows AIR's key spelling rather than naming an artifact slice,
 * unlike the Windows entries above. That is not an oversight: the macOS key is
 * architecture-neutral (measured — AIR's macOS runtime is one universal binary whose
 * single 64-bit ANE key is `MacOS-x86-64` in both slices), so it cannot tell one
 * macOS architecture from the other. The directory therefore names AIR's macOS key,
 * and a macOS host library has to pin its own slices at build time.
 */
export function aneHostDirName(platform: string): string {
  switch (platform) {
    case 'Windows-x86-64':
      return 'windows-x64';
    case 'Windows-x86':
      return 'windows-x86';
    case 'MacOS-x86-64':
      return 'macos-x86-64';
    case 'iPhone-ARM':
      return 'ios-arm64';
    default:
      throw new Error(`no lib/bin/ directory is defined for AIR platform '${platform}'`);
  }
}

/**
 * The AIR platform key a *build* should resolve its ANEs for.
 *
 * `currentAnePlatform()` answers for the machine doing the compile, which is the
 * right answer only while the build produces a program that machine could run. A
 * Windows native build can be told otherwise: `<architecture>32</architecture>`
 * (or a manifest `"architecture": "32"`) produces a 32-bit program, and AIR runs
 * such a program under the x86 runtime -- so the ANE slice it may load is
 * `Windows-x86`, not the x64 slice the host would pick.
 *
 * Measured before this existed, on an x64 host with `"architecture": "32"` and an
 * ANE that declares both slices: the compiler emitted i686 objects, linked the x64
 * `asaot.lib`, staged the x64 `WinCore.dll` into `extensions\`, and the 32-bit
 * program then failed at run time -- a 64-bit DLL cannot load into a 32-bit
 * process. The mixture was created at compile time, so it is fixed at compile
 * time; at run time there is nothing left to detect but the wreckage.
 *
 * `architecture` is inert for anything but a Windows native build (exactly the
 * condition `nativeTargetFlags` applies), and `''` / `arm64` keep the host answer:
 * `''` means "let clang pick the host default", and AIR has no Windows ARM64
 * runtime whose key an arm64 build could legitimately ask for.
 */
export function anePlatformForBuild(architecture: string, target: string, platform: string = process.platform, arch: string = process.arch): string {
  if (platform === 'win32' && target === 'native') {
    if (architecture === '32') return 'Windows-x86';
    if (architecture === '64') return 'Windows-x86-64';
    // An arm64 TARGET has no key for the same reason an arm64 HOST has none (see
    // currentAnePlatform): AIR ships no Windows ARM64 runtime, and a native arm64
    // process cannot load the x64 asaot.dll or the x64 ANE slice either. Answering
    // with the host's x64 key would stage a library this program can never load,
    // so '' makes index.ts refuse -- as it already does for an arm64 host.
    if (architecture === 'arm64') return '';
  }
  return currentAnePlatform(platform, arch);
}

/** One parsed `<platform>` entry of an extension.xml. */
export interface AnePlatformEntry {
  name: string;
  nativeLibrary: string;
  initializer: string;
  finalizer: string;
}

/** The extension.xml of one .ane, plus the bytes of every native library it ships. */
export interface AnePackage {
  extId: string;
  version: string;
  platforms: AnePlatformEntry[];
  /** FULL entry name inside the ZIP (path included) -> its decompressed bytes. */
  natives: Map<string, Buffer>;
}

/** Strip XML comments (`<!-- ... -->`) from an extension.xml.
 *
 * Not cosmetic: the rest of the parser is regex-based, so a comment is invisible
 * text EXCEPT when it makes a pair of tags look adjacent. One measured case (the
 * fixture descriptor the examples share, `examples/ane/ext-aot/com.example.probe/
 * extension.xml`): a comment that MENTIONS
 * `<platform name="...">` pairs with the real entry's `</platform>` closing tag,
 * so the comment body is parsed as a platform and the REAL entry is swallowed -
 * the build then rejects a perfectly loadable .ane with "has no <platform
 * name=Windows-x86-64> entry". A descriptor is user-written XML; comments that
 * quote the very tags being parsed are ordinary documentation practice, so the
 * fix belongs here rather than in a rule telling users not to comment. */
export function stripXmlComments(xml: string): string {
  // The non-greedy body is what keeps `<!-- a --> ... <!-- b -->` from collapsing
  // into one match, and `[\s\S]` is what lets a comment span lines.
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

/** Read the text of the element named `tag` inside `xml`, or null. */
function tagText(xml: string, tag: string): string | null {
  // Non-greedy, and `[^>]*` on the open tag so an attribute (AIR writes none
  // here, but a hand-edited descriptor may) does not defeat the match.
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? m[1].trim() : null;
}

/**
 * Parse one extension.xml.
 *
 * Only the elements this build consumes are read: `<id>`, `<versionNumber>`, and
 * each `<platform>`'s nativeLibrary/initializer/finalizer. `<extension>`'s own
 * attributes — the `xmlns` in particular — are deliberately ignored: they carry
 * the AIR namespace version, and requiring an exact one would reject packages AIR
 * itself loads. The AIR-specific siblings that have no counterpart here
 * (`<certificate>`, `<platform>`s for other OSes) are skipped rather than
 * rejected, which is what keeps an OFFICIAL, unmodified .ane readable — the whole
 * point of the dual-artifact arrangement.
 *
 * Comments are stripped first (see stripXmlComments): they are documentation, not
 * structure, and a regex parser that reads them as structure silently invents
 * platforms out of prose.
 */
export function parseExtensionXml(xml: string, source: string): Omit<AnePackage, 'natives'> {
  xml = stripXmlComments(xml);
  // An unterminated comment is malformed XML -- AIR rejects such a package -- and
  // leaving it in is worse than an error: the tag scanner below would pair a
  // commented `<platform ...>` with the NEXT real `</platform>`, inventing a
  // platform nobody declared while swallowing the declared one. The failure would
  // then surface as "has no <platform name=...> entry", blaming the one line that
  // was actually correct.
  if (xml.includes('<!--')) {
    throw new Error(`ANE '${source}': extension.xml has an unterminated XML comment (\`<!--\` with no \`-->\`)`);
  }
  const extId = tagText(xml, 'id');
  if (!extId) throw new Error(`ANE '${source}': extension.xml has no <id>`);
  const version = tagText(xml, 'versionNumber') ?? '';
  const platforms: AnePlatformEntry[] = [];
  const re = /<platform(\s[^>]*)?>([\s\S]*?)<\/platform>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const nameMatch = /name\s*=\s*"([^"]*)"/.exec(m[1] ?? '');
    if (!nameMatch) continue;
    const body = m[2];
    // <applicationDeployment> wraps these for a desktop platform; the iOS/Android
    // shape differs (a .a/.so plus an <initializer> directly), so reading the
    // three names wherever they appear covers both without special-casing.
    const nativeLibrary = tagText(body, 'nativeLibrary');
    const initializer = tagText(body, 'initializer');
    const finalizer = tagText(body, 'finalizer');
    if (!nativeLibrary || !initializer || !finalizer) continue;
    platforms.push({ name: nameMatch[1], nativeLibrary, initializer, finalizer });
  }
  return { extId, version, platforms };
}

/**
 * List one UNPACKED package directory as ZIP-shaped entries.
 *
 * Names are made relative and slash-separated, so an address taken from a
 * directory is the same string as the same address inside a ZIP — which is what
 * lets findNativeEntry's candidate table serve both with no second table.
 *
 * Sorted, so a build driven off a directory enumerates identically every run
 * (readdir order is filesystem-dependent, and a nondeterministic input is a
 * nondeterministic diagnosis when something is rejected).
 */
function readDirectoryEntries(root: string): ZipEntry[] {
  const out: ZipEntry[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push({ name: relative(root, abs).replace(/\\/g, '/'), method: 0, data: readFileSync(abs) });
    }
  };
  walk(root);
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/**
 * Read one ANE: a ZIP file, or an UNPACKED DIRECTORY holding the same tree.
 *
 * The directory form is not a convenience. A package recompiled for this build
 * has no consumer other than this compiler — its native library imports
 * `asaot.dll`, which forwards into the generated program's own tables, so AIR
 * could not load it even signed. Packaging such a library into a signed ZIP with
 * a `signatures.xml` and a `library.swf` therefore buys nothing (and the DoABC
 * in that `library.swf` is out of scope here anyway, so the extension's AS3
 * classes must still be compiled from `.as` source). The staging tree —
 * `extension.xml` next to `<platform>/<nativeLibrary>`, exactly what `adt` is
 * fed — is the whole artifact, and reading it directly removes the packaging
 * step along with the certificate it needs.
 *
 * Both layouts that would be on disk resolve through the same candidate table:
 * a staging directory (candidate 3), and the tree an official package leaves
 * behind when unzipped, `META-INF/ANE/<plat>/<lib>` (candidate 2).
 */
export function readAne(path: string): AnePackage {
  if (!existsSync(path)) throw new Error(`ANE '${path}': no such file or directory`);
  const entries = statSync(path).isDirectory() ? readDirectoryEntries(path) : unzip(readFileSync(path));
  const manifest = entries.find((e) => basename(e.name) === 'extension.xml');
  if (!manifest) {
    throw new Error(`ANE '${path}': no extension.xml at the package root (not an ANE?)`);
  }
  const parsed = parseExtensionXml(manifest.data.toString('utf8'), path);
  const natives = new Map<string, Buffer>();
  for (const e of entries) {
    // Every entry, nested ones included, keyed by its FULL name. A nested entry
    // that happens to share a base name with a root one is a different file, so
    // the address is the path, never the base name (see findNativeEntry).
    natives.set(e.name, e.data);
  }
  return { ...parsed, natives };
}

/**
 * The ZIP paths an ANE's native library can legitimately live at, in priority
 * order, for one `<platform>` entry that declares `nativeLibrary`.
 *
 * Three layouts are in the wild and all three are things a user has on disk:
 *
 *   1. `<lib>`                       a flat package (extension.xml and the
 *                                    library side by side at the ZIP root;
 *                                    what a hand-rolled packer produces --
 *                                    the example fixture used to, before §4.6
 *                                    made the recompiled artifact an unpacked
 *                                    staging tree).
 *   2. `META-INF/ANE/<plat>/<lib>`   what `adt -package -target ane` writes:
 *                                    the ANE is a SIGNED package and everything
 *                                    real lives under META-INF/ANE/ next to
 *                                    `signatures.xml`. This is the layout every
 *                                    shipped ANE has, and reading only layout 1
 *                                    is why an official package used to be
 *                                    rejected as "does not contain it" while
 *                                    adl loaded the very same file.
 *   3. `<plat>/<lib>`                the on-disk staging directory `adt` is fed
 *                                    (`-platform Windows-x86-64 -C Windows-x86-64 .`),
 *                                    here in case a user zips that directory
 *                                    themselves instead of running adt.
 *
 * Priority is "most specific address last" on purpose: layout 1 is tried first so
 * every package that already resolved keeps resolving out of the identical entry.
 * The lookup is platform-scoped, so targeting Windows-x86 can never pick up the
 * Windows-x86-64 slice even though both are present in one ZIP.
 */
function nativeEntryCandidates(platform: string, nativeLibrary: string): string[] {
  // AIR writes forward slashes inside a ZIP; a hand-edited descriptor may use
  // backslashes, and an address that cannot match is worse than a cheap rewrite.
  const lib = nativeLibrary.replace(/\\/g, '/');
  return [lib, `META-INF/ANE/${platform}/${lib}`, `${platform}/${lib}`];
}

/**
 * Find one `<platform>`'s native library inside a package, or null.
 *
 * Exact full-path matching (never a base-name scan): in an official package the
 * Windows-x86 and Windows-x86-64 slices both contain `WinCore.dll`, so a base
 * name is not an address — it is two addresses, and picking the wrong one is a
 * load-with-the-wrong-bitness failure far from its cause.
 */
function findNativeEntry(pkg: AnePackage, platform: string, nativeLibrary: string): Buffer | null {
  for (const candidate of nativeEntryCandidates(platform, nativeLibrary)) {
    const bytes = pkg.natives.get(candidate);
    if (bytes) return bytes;
  }
  return null;
}

/** What a build's `--ane-path` list resolved to. */
export interface AneResolution {
  descriptors: AneDescriptor[];
  /** Native library bytes to write next to the executable, keyed by file name. */
  staging: Map<string, Buffer>;
  /**
   * The AIR platform key every descriptor was resolved for. Carried along rather than
   * recomputed by the caller: the host library (`lib/bin/<name>/asaot.*`) is picked by
   * the SAME decision, and a second copy of that decision is a second thing to drift.
   */
  platform: string;
}

/**
 * Resolve a descriptor's `<extensionID>` list to the packages that declare them,
 * searching `roots` in order.
 *
 * The other half of "the descriptor names an extension": AIR never learns a
 * package's PATH from app.xml either. It learns it from `-extdir` — the unpacked
 * trees for adl, the packed `.ane` files for adt — and REFUSES TO START when a
 * declared ID is not there (measured: exit 5, `Requested extension
 * com.example.wincore could not be found.`). Locating by declared
 * ID rather than by "whatever is in the directory" is what keeps a directory
 * holding OTHER platforms' packages from failing the build: measured on a real
 * project, its packed `lib/` carries 14 `.ane` files while its descriptor declares
 * 5, and the other 9 span Android-only, tools and shared-dependency packages —
 * sweeping them in aborts on a package the app never asked for.
 *
 * Roots are searched in order and the first package declaring an ID wins, which
 * is load-bearing rather than cosmetic: a project that ran its own unzip step has
 * the SAME extension in both `lib/` and `ext-folder/`, and taking the second would
 * re-read a copy of what the first already supplied. A root is only opened while
 * some ID is still unresolved, and entries within a root are enumerated sorted —
 * readdir order is filesystem-dependent, and "which of these two packages won"
 * must not be.
 *
 * A missing ID is an ERROR, not a skip (§1.5): AIR refuses to launch, whereas a
 * program built without the extension answers null from every
 * createExtensionContext with nothing on stderr to explain it.
 */
export function resolveExtensionPackages(roots: readonly string[], extensionIDs: readonly string[]): Map<string, string> {
  const needed = new Set(extensionIDs);
  const found = new Map<string, string>();
  const seen = new Set<string>();
  const offered: string[] = [];
  const searched: string[] = [];
  for (const root of roots) {
    if (found.size === needed.size) break;
    if (!existsSync(root)) {
      // Named in the diagnosis rather than skipped silently: a typo'd --extdir and
      // a directory that simply has not been populated read the same otherwise.
      searched.push(`${root} (absent)`);
      continue;
    }
    if (!statSync(root).isDirectory()) throw new Error(`extension directory '${root}' is not a directory`);
    searched.push(root);
    for (const e of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(root, e.name);
      // A package is one of the three shapes readAne accepts: a `.ane` ZIP; an
      // unpacked tree (`<dir>/META-INF/ANE/extension.xml`, what `adl -extdir` is fed);
      // or a staging tree (`<dir>/extension.xml` beside its `<platform>/` directories,
      // what `adt` is fed and what this project's own recompiled-for-AOT extension
      // artifact IS). Recognising fewer shapes here than readAne does is a trap: the
      // same tree resolves through `--ane <tree>` yet stays invisible in a scanned
      // directory, so whatever else in that directory declares the ID wins silently.
      // Anything else in the directory — an unzip helper, a .swc, a .fla — is not a
      // package and is not an error.
      const isPackage = e.isFile()
        ? e.name.toLowerCase().endsWith('.ane')
        : e.isDirectory() &&
          (existsSync(join(abs, 'META-INF', 'ANE', 'extension.xml')) || existsSync(join(abs, 'extension.xml')));
      if (!isPackage) continue;
      // readAne is the reader every other path goes through, so an ID is read here
      // exactly as the ID a build resolves against. It needs no platform key (an
      // `<id>` is not platform-scoped), which is what lets this run before the
      // target is known and still leave `--ane-platform` the last word.
      const extId = readAne(abs).extId;
      if (seen.has(extId)) continue;
      seen.add(extId);
      offered.push(`${extId} <- ${abs}`);
      if (needed.has(extId)) found.set(extId, abs);
    }
  }
  const missing = extensionIDs.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(
      // adl's own wording, one line per ID, so a user grepping for it finds the
      // same sentence in both tools.
      missing.map((id) => `Requested extension ${id} could not be found.`).join('\n') +
        `\n  looked in: ${searched.join(', ') || '(no directory given)'}` +
        `\n  those directories offer: ${offered.join(', ') || '(no extension packages)'}` +
        `\n  fix: put the package in one of those directories (a packed .ane, or an unpacked` +
        // All THREE package shapes readAne accepts are named, not the two the SDK
        // template happens to ship: the staging tree is what a recompiled-for-AOT
        // extension IS (docs/zh-cn/ane.md §4.6), so a hint that omits it would fail
        // to name the way out for exactly the user who hit this while migrating.
        `\n       tree -- either <dir>/META-INF/ANE/extension.xml, or <dir>/extension.xml` +
        `\n       beside its <platform>/ libraries), or name its directory with --extdir <dir>`
    );
  }
  return found;
}

/**
 * Resolve every .ane the build was given into the descriptor row for `platform`.
 *
 * A package with no entry for the current platform is an ERROR, not a skip: AIR
 * would report the extension as unavailable, and silently dropping it would turn
 * a missing native library into a mysterious null from createExtensionContext
 * with nothing on stderr to explain it. (This is the ANEDownloader case — it
 * ships Windows-x86 only, so an x64 build must say so.)
 *
 * Two extensions sharing a native-library FILE NAME are supported, and that is
 * why each one is addressed by `<extensionID>/<platform>/<lib>` rather than by
 * its bare file name. Measured before this was nested: two packages declaring
 * different extensionIDs but both shipping `Shared.dll` resolved to two
 * descriptors pointing at ONE staged file (the second overwrote the first, the
 * summary claimed "2 extension(s)" beside "1 native library(ies)", exit 0), and
 * the first extension then failed at load with "exports no Initializer named
 * ..." — a wrong-cause diagnosis far from the real one. AIR keeps each
 * extension's library at that extension's own path (measured under `adl`: with a
 * second package in `-extdir` shipping a sentinel under the same file name, the
 * first extension still passed 13/13), so one flat, name-keyed directory was a
 * §1.5 defect (adl right, this build wrong) rather than a limitation to document.
 *
 * The count is bounded here too, because a descriptor row is an `as_anes[]` slot
 * in the generated program: an over-long list would index past that static array.
 */
export function resolveAneDescriptors(paths: readonly string[], platform: string): AneResolution {
  const descriptors: AneDescriptor[] = [];
  const staging = new Map<string, Buffer>();
  const seen = new Set<string>();
  for (const path of paths) {
    const pkg = readAne(path);
    if (seen.has(pkg.extId)) {
      throw new Error(`two ANEs declare the same extensionID '${pkg.extId}' (the second is '${path}')`);
    }
    if (seen.size >= ANE_COUNT_MAX) {
      // A sentence at compile time instead of an out-of-bounds write at the first
      // createExtensionContext for the extension after the limit (measured: 33
      // extensions used to compile, link and stage with exit 0 and no warning).
      const last = [...seen].slice(-2).map((e) => `'${e}'`).join(', ');
      throw new Error(
        `too many native extensions: '${path}' would be number ${seen.size + 1}, but one build hosts at most ` +
          `${ANE_COUNT_MAX} (the generated as_anes[] table holds one slot per extension; last accepted: ${last}). ` +
          'Split the program, or raise ANE_COUNT_MAX in src/fre.ts and rebuild asaot.'
      );
    }
    seen.add(pkg.extId);
    const entry = pkg.platforms.find((p) => p.name === platform);
    if (!entry) {
      const have = pkg.platforms.map((p) => p.name).join(', ') || 'none';
      throw new Error(
        `ANE '${path}' (${pkg.extId}) has no <platform name="${platform}"> entry — it declares: ${have}.` +
          ` A build cannot load another platform's native library.`
      );
    }
    const bytes = findNativeEntry(pkg, platform, entry.nativeLibrary);
    if (!bytes) {
      // Listing what the ZIP does hold turns "does not contain it" into a
      // one-read diagnosis: a wrong-case `META-INF/ANE/` prefix, a `.zip` that
      // holds only the staged directory, or a truly empty package all look
      // identical from the sentence alone.
      const listed = [...pkg.natives.keys()].slice(0, 12).join(', ');
      const more = pkg.natives.size > 12 ? `, … (${pkg.natives.size} entries)` : '';
      throw new Error(
        `ANE '${path}' (${pkg.extId}) declares nativeLibrary '${entry.nativeLibrary}' for ${platform} but the ` +
          `package does not contain it — looked for ${nativeEntryCandidates(platform, entry.nativeLibrary)
            .map((c) => `'${c}'`)
            .join(', ')}; the package holds: ${listed || '(no entries)'}${more}`
      );
    }
    // The library keeps the RELATIVE PATH its descriptor declares, two levels down
    // from the extensions root, so a library declared in a subdirectory is not
    // flattened onto a name it never had (AIR keeps that relative path too).
    const rel = `${pkg.extId}/${platform}/${entry.nativeLibrary.replace(/\\/g, '/')}`;
    descriptors.push({
      extId: pkg.extId,
      nativeLib: rel,
      initializer: entry.initializer,
      finalizer: entry.finalizer,
    });
    staging.set(rel, bytes);
  }
  return { descriptors, staging, platform };
}

/**
 * Write every staged native library into `<exeDir>/extensions/<extensionID>/<platform>/`.
 *
 * That root is where as_ext_dir() (fre.ts) looks; the rest of the path comes from
 * the descriptor, so the pairing is compile-time-determined on both sides. One
 * directory per extension is what keeps two extensions that happen to ship a
 * library with the same file name from becoming one file (see
 * resolveAneDescriptors), and it mirrors AIR, whose extension directories are
 * per-extension as well. Returns the paths written (relative to the extensions
 * root), so the caller can report them: a program whose extension silently is not
 * there is the failure mode this whole step exists to prevent.
 */
export function stageAneNatives(resolution: AneResolution, exePath: string): string[] {
  if (resolution.staging.size === 0) return [];
  const root = join(dirname(exePath), 'extensions');
  const written: string[] = [];
  for (const [rel, bytes] of resolution.staging) {
    const dest = join(root, ...rel.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    written.push(rel);
  }
  return written;
}
