// Xcode project generator: turns the generated readable .c (plus optional extra
// C/C++ sources, include paths, link libs, frameworks and defines) into a macOS
// .xcodeproj whose target is an *application* bundle (.app), not a bare command-
// line tool. An IDE developer opens it in Xcode to build, run, debug and (later)
// sign/notarize for distribution.
//
// This is a "generate project" step, not a cc invocation: per §6 of the compile
// guide the compile backend (`--target`) still produces the same C, and
// `--package xcode-project` only organizes it into an Xcode application target.
// The generated AS3 C still has an `int main(void)`, which is valid inside a
// macOS .app — SDL2's event loop (when ASC_USE_WINDOW=1) runs from main, and the
// bundle + Info.plist give the process a real app identity (Dock icon, menu bar,
// focus) that a `com.apple.product-type.tool` lacks.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import type { BuildConfig } from './build.ts';
import { parsePlist, serializePlist, asDict, asArray, scalarText, dictEntry, type PlistValue } from './pbxproj.ts';

// A .xcodeproj is a directory containing project.pbxproj plus an optional
// shared scheme (so `xcodebuild -scheme NAME` works from the command line).
export interface XcodeProject {
  projectPath: string; // <base>.xcodeproj (directory)
  appPath: string;     // the built .app bundle path (<outDir>/<base>.app)
  schemeName: string;  // the shared scheme's name == product name
  action: 'create' | 'merge'; // create = fresh generation; merge = patched in place
  changed: boolean;           // merge only: whether the source list actually changed
}

// pbxproj object IDs are 24 hex chars. Xcode only requires uniqueness; we mint
// them deterministically from a counter so output is stable and diffable. The
// leading 'A' keeps the token from being read as a bare integer by the OpenStep
// plist parser (an all-digit key would be parsed as a number, not a string).
let idCounter = 0;
function oid(): string {
  idCounter += 1;
  return 'A' + idCounter.toString(16).toUpperCase().padStart(23, '0');
}

// Generate a macOS .xcodeproj (application target) for the given config. `cPath`
// is the generated readable C file; `outDir` is where to create
// `<base>.xcodeproj` (with Info.plist embedded inside it), typically in the same
// directory as the generated .c. Returns the project layout.
export function generateXcodeProject(
  cfg: BuildConfig,
  cPath: string,
  outDir: string,
  productName: string,
): XcodeProject {
  const projectPath = join(outDir, `${productName}.xcodeproj`);
  const pbxDir = join(projectPath, 'project.pbxproj');

  // Smart merge (§6.4): when the project already exists, the IDE developer has
  // opened it in Xcode and likely hand-edited build settings / schemes / files.
  // Regenerating from scratch would clobber those edits, so patch only the
  // source-file objects we own and preserve everything else.
  if (existsSync(pbxDir)) {
    return mergeXcodeProject(cfg, cPath, outDir, productName);
  }

  // Reference the generated .c and any extra sources by *absolute* path so the
  // project resolves them regardless of Xcode's working directory. Manifest
  // paths are already absolute (resolveFromManifest); CLI paths resolve here.
  const cAbs = resolve(cPath);
  const sourceFiles: string[] = [cAbs, ...cfg.sources.map((s) => resolve(s))];

  // Application identity: bundle id defaults to com.example.<product> when the
  // manifest does not pin one; the display name falls back to the product name.
  const bundleId = cfg.bundleId || `com.example.${productName}`;
  const displayName = cfg.displayName || productName;
  // Icon (.icns) is optional; when present it is copied into Resources via a
  // PBXResourcesBuildPhase entry and referenced by CFBundleIconFile.
  const iconName = cfg.icon ? basename(cfg.icon).replace(/\.icns$/i, '') : null;

  const projectOid = oid();
  const mainGroupOid = oid();
  const productsGroupOid = oid();
  const targetOid = oid();
  const sourcesPhaseOid = oid();
  const frameworksPhaseOid = oid();
  const resourcesPhaseOid = oid();
  const productRefOid = oid();
  const projectCfgListOid = oid();
  const targetCfgListOid = oid();
  const projectDebugCfgOid = oid();
  const projectReleaseCfgOid = oid();
  const targetDebugCfgOid = oid();
  const targetReleaseCfgOid = oid();

  const fileRefs: Array<{ oid: string; path: string }> = sourceFiles.map((p) => ({
    oid: oid(),
    path: p,
  }));
  const buildFiles: Array<{ oid: string; fileRef: string }> = fileRefs.map((fr) => ({
    oid: oid(),
    fileRef: fr.oid,
  }));

  // Icon is the only resource the generator manages: a file reference (absolute
  // path) plus a build file added to the Resources phase.
  let iconRefOid: string | null = null;
  let iconBuildOid: string | null = null;
  if (cfg.icon) {
    iconRefOid = oid();
    iconBuildOid = oid();
  }

  const lines: string[] = [];
  const push = (s: string): void => { lines.push(s); };

  push('// !$*UTF8*$!');
  push('{');
  push('\tarchiveVersion = 1;');
  push('\tclasses = {');
  push('\t};');
  push('\tobjectVersion = 56;');
  push('\tobjects = {');

  // PBXBuildFile section: one entry per compiled source, plus the icon resource.
  push('');
  push('/* Begin PBXBuildFile section */');
  for (const bf of buildFiles) {
    push(`\t\t${bf.oid} /* ${basename(byRef(fileRefs, bf.fileRef))} in Sources */ = {isa = PBXBuildFile; fileRef = ${bf.fileRef} /* ${basename(byRef(fileRefs, bf.fileRef))} */; };`);
  }
  if (iconBuildOid && iconRefOid && cfg.icon) {
    push(`\t\t${iconBuildOid} /* ${basename(cfg.icon)} in Resources */ = {isa = PBXBuildFile; fileRef = ${iconRefOid} /* ${basename(cfg.icon)} */; };`);
  }
  push('/* End PBXBuildFile section */');

  // PBXFileReference section: the source files + the built .app product.
  push('');
  push('/* Begin PBXFileReference section */');
  for (const fr of fileRefs) {
    const type = fileType(fr.path);
    push(`\t\t${fr.oid} /* ${basename(fr.path)} */ = {isa = PBXFileReference; lastKnownFileType = ${type}; name = "${basename(fr.path)}"; path = "${esc(fr.path)}"; sourceTree = "<absolute>"; };`);
  }
  if (iconRefOid && cfg.icon) {
    push(`\t\t${iconRefOid} /* ${basename(cfg.icon)} */ = {isa = PBXFileReference; lastKnownFileType = image.icns; name = "${basename(cfg.icon)}"; path = "${esc(cfg.icon)}"; sourceTree = "<absolute>"; };`);
  }
  push(`\t\t${productRefOid} /* ${productName}.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = "${productName}.app"; sourceTree = BUILT_PRODUCTS_DIR; };`);
  push('/* End PBXFileReference section */');

  // PBXFrameworksBuildPhase: empty (system libs are linked via OTHER_LDFLAGS).
  push('');
  push('/* Begin PBXFrameworksBuildPhase section */');
  push(`\t\t${frameworksPhaseOid} /* Frameworks */ = {`);
  push('\t\t\tisa = PBXFrameworksBuildPhase;');
  push('\t\t\tbuildActionMask = 2147483647;');
  push('\t\t\tfiles = (');
  push('\t\t\t);');
  push('\t\t\trunOnlyForDeploymentPostprocessing = 0;');
  push('\t\t};');
  push('/* End PBXFrameworksBuildPhase section */');

  // PBXGroup section: root group holds sources + Products.
  push('');
  push('/* Begin PBXGroup section */');
  push(`\t\t${mainGroupOid} = {`);
  push('\t\t\tisa = PBXGroup;');
  push('\t\t\tchildren = (');
  for (const fr of fileRefs) {
    push(`\t\t\t\t${fr.oid} /* ${basename(fr.path)} */,`);
  }
  if (iconRefOid && cfg.icon) {
    push(`\t\t\t\t${iconRefOid} /* ${basename(cfg.icon)} */,`);
  }
  push(`\t\t\t\t${productsGroupOid} /* Products */,`);
  push('\t\t\t);');
  push('\t\t\tsourceTree = "<group>";');
  push('\t\t};');
  push(`\t\t${productsGroupOid} /* Products */ = {`);
  push('\t\t\tisa = PBXGroup;');
  push('\t\t\tchildren = (');
  push(`\t\t\t\t${productRefOid} /* ${productName}.app */,`);
  push('\t\t\t);');
  push('\t\t\tname = Products;');
  push('\t\t\tsourceTree = "<group>";');
  push('\t\t};');
  push('/* End PBXGroup section */');

  // PBXNativeTarget section: an application target (Sources + Frameworks +
  // Resources build phases).
  push('');
  push('/* Begin PBXNativeTarget section */');
  push(`\t\t${targetOid} /* ${productName} */ = {`);
  push('\t\t\tisa = PBXNativeTarget;');
  push(`\t\t\tbuildConfigurationList = ${targetCfgListOid} /* Build configuration list for PBXNativeTarget "${productName}" */;`);
  push('\t\t\tbuildPhases = (');
  push(`\t\t\t\t${sourcesPhaseOid} /* Sources */,`);
  push(`\t\t\t\t${frameworksPhaseOid} /* Frameworks */,`);
  push(`\t\t\t\t${resourcesPhaseOid} /* Resources */,`);
  push('\t\t\t);');
  push('\t\t\tbuildRules = (');
  push('\t\t\t);');
  push('\t\t\tdependencies = (');
  push('\t\t\t);');
  push(`\t\t\tname = ${productName};`);
  push(`\t\t\tproductName = ${productName};`);
  push(`\t\t\tproductReference = ${productRefOid} /* ${productName}.app */;`);
  push('\t\t\tproductType = "com.apple.product-type.application";');
  push('\t\t};');
  push('/* End PBXNativeTarget section */');

  // PBXProject section.
  push('');
  push('/* Begin PBXProject section */');
  push(`\t\t${projectOid} /* Project object */ = {`);
  push('\t\t\tisa = PBXProject;');
  push('\t\t\tattributes = {');
  push('\t\t\t\tBuildIndependentTargetsInParallel = 1;');
  push('\t\t\t\tLastUpgradeCheck = 1500;');
  push('\t\t\t};');
  push(`\t\t\tbuildConfigurationList = ${projectCfgListOid} /* Build configuration list for PBXProject "${productName}" */;`);
  push('\t\t\tcompatibilityVersion = "Xcode 14.0";');
  push('\t\t\tdevelopmentRegion = en;');
  push('\t\t\thasScannedForEncodings = 0;');
  push('\t\t\tknownRegions = (');
  push('\t\t\t\ten,');
  push('\t\t\t\tBase,');
  push('\t\t\t);');
  push(`\t\t\tmainGroup = ${mainGroupOid};`);
  push(`\t\t\tproductRefGroup = ${productsGroupOid} /* Products */;`);
  push('\t\t\tprojectDirPath = "";');
  push('\t\t\tprojectRoot = "";');
  push('\t\t\ttargets = (');
  push(`\t\t\t\t${targetOid} /* ${productName} */,`);
  push('\t\t\t);');
  push('\t\t};');
  push('/* End PBXProject section */');

  // PBXResourcesBuildPhase section: icon (if any) is copied into the .app.
  push('');
  push('/* Begin PBXResourcesBuildPhase section */');
  push(`\t\t${resourcesPhaseOid} /* Resources */ = {`);
  push('\t\t\tisa = PBXResourcesBuildPhase;');
  push('\t\t\tbuildActionMask = 2147483647;');
  push('\t\t\tfiles = (');
  if (iconBuildOid && cfg.icon) {
    push(`\t\t\t\t${iconBuildOid} /* ${basename(cfg.icon)} in Resources */,`);
  }
  push('\t\t\t);');
  push('\t\t\trunOnlyForDeploymentPostprocessing = 0;');
  push('\t\t};');
  push('/* End PBXResourcesBuildPhase section */');

  // PBXSourcesBuildPhase section.
  push('');
  push('/* Begin PBXSourcesBuildPhase section */');
  push(`\t\t${sourcesPhaseOid} /* Sources */ = {`);
  push('\t\t\tisa = PBXSourcesBuildPhase;');
  push('\t\t\tbuildActionMask = 2147483647;');
  push('\t\t\tfiles = (');
  for (const bf of buildFiles) {
    push(`\t\t\t\t${bf.oid} /* ${basename(byRef(fileRefs, bf.fileRef))} in Sources */,`);
  }
  push('\t\t\t);');
  push('\t\t\trunOnlyForDeploymentPostprocessing = 0;');
  push('\t\t};');
  push('/* End PBXSourcesBuildPhase section */');

  // XCBuildConfiguration section: project-level + target-level (Debug/Release).
  push('');
  push('/* Begin XCBuildConfiguration section */');
  pushProjectConfig(push, projectDebugCfgOid, 'Debug', cfg.deploymentTarget);
  pushProjectConfig(push, projectReleaseCfgOid, 'Release', cfg.deploymentTarget);
  pushTargetConfig(push, targetDebugCfgOid, 'Debug', cfg, productName, bundleId, displayName);
  pushTargetConfig(push, targetReleaseCfgOid, 'Release', cfg, productName, bundleId, displayName);
  push('/* End XCBuildConfiguration section */');

  // XCConfigurationList section.
  push('');
  push('/* Begin XCConfigurationList section */');
  push(`\t\t${projectCfgListOid} /* Build configuration list for PBXProject "${productName}" */ = {`);
  push('\t\t\tisa = XCConfigurationList;');
  push('\t\t\tbuildConfigurations = (');
  push(`\t\t\t\t${projectDebugCfgOid} /* Debug */,`);
  push(`\t\t\t\t${projectReleaseCfgOid} /* Release */,`);
  push('\t\t\t);');
  push('\t\t\tdefaultConfigurationIsVisible = 0;');
  push('\t\t\tdefaultConfigurationName = Release;');
  push('\t\t};');
  push(`\t\t${targetCfgListOid} /* Build configuration list for PBXNativeTarget "${productName}" */ = {`);
  push('\t\t\tisa = XCConfigurationList;');
  push('\t\t\tbuildConfigurations = (');
  push(`\t\t\t\t${targetDebugCfgOid} /* Debug */,`);
  push(`\t\t\t\t${targetReleaseCfgOid} /* Release */,`);
  push('\t\t\t);');
  push('\t\t\tdefaultConfigurationIsVisible = 0;');
  push('\t\t\tdefaultConfigurationName = Release;');
  push('\t\t};');
  push('/* End XCConfigurationList section */');

  push('\t};');
  push(`\trootObject = ${projectOid} /* Project object */;`);
  push('}');

  mkdirSync(projectPath, { recursive: true });
  writeFileSync(pbxDir, lines.join('\n') + '\n');

  // Info.plist lives inside the .xcodeproj so its directory can never collide
  // with a raw `cc` output binary of the same product name (e.g. `air-native`),
  // which would otherwise make mkdirSync throw EEXIST. Referenced via
  // INFOPLIST_FILE relative to the project directory.
  writeFileSync(join(projectPath, 'Info.plist'), infoPlist(displayName, iconName));

  // Shared scheme so `xcodebuild -scheme NAME` resolves without opening Xcode.
  const schemeDir = join(projectPath, 'xcshareddata', 'xcschemes');
  mkdirSync(schemeDir, { recursive: true });
  writeFileSync(join(schemeDir, `${productName}.xcscheme`), schemeXml(targetOid, productName));

  // Remember the managed source set so the next run can diff against it.
  writeFileSync(join(projectPath, '.as3aot-managed.json'), JSON.stringify({ sources: sourceFiles.map((p) => resolve(p)).sort() }, null, 2) + '\n');

  return { projectPath, appPath: join(outDir, `${productName}.app`), schemeName: productName, action: 'create', changed: true };
}

function byRef(refs: Array<{ oid: string; path: string }>, oid: string): string {
  return refs.find((r) => r.oid === oid)?.path ?? '';
}

function fileType(path: string): string {
  // Objective-C++ (.mm) and Objective-C (.m) must be classified explicitly:
  // falling through to `sourcecode.c.c` would make Xcode compile the file as
  // plain C, and any C++/ObjC headers it includes (Skia's `bool`, scoped
  // `enum`, `<cstdint>`) then fail to parse.
  if (/\.mm$/i.test(path)) return 'sourcecode.cpp.objcpp';
  if (/\.m$/i.test(path)) return 'sourcecode.c.objc';
  if (/\.(cc|cpp|cxx)$/i.test(path)) return 'sourcecode.cpp.cpp';
  return 'sourcecode.c.c';
}

// Escape a path for a pbxproj double-quoted string.
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// A minimal but valid Info.plist for a macOS GUI application. Values that Xcode
// derives (executable name, bundle id, min system version) are injected via
// $(VAR) build settings so they stay in sync with the target configuration.
function infoPlist(displayName: string, iconName: string | null): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>CFBundleDevelopmentRegion</key>',
    '\t<string>$(DEVELOPMENT_LANGUAGE)</string>',
    '\t<key>CFBundleExecutable</key>',
    '\t<string>$(EXECUTABLE_NAME)</string>',
    '\t<key>CFBundleIdentifier</key>',
    '\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>',
    '\t<key>CFBundleInfoDictionaryVersion</key>',
    '\t<string>6.0</string>',
    '\t<key>CFBundleName</key>',
    '\t<string>' + displayName + '</string>',
    '\t<key>CFBundlePackageType</key>',
    '\t<string>APPL</string>',
    '\t<key>CFBundleShortVersionString</key>',
    '\t<string>1.0</string>',
    '\t<key>CFBundleVersion</key>',
    '\t<string>1</string>',
    '\t<key>LSMinimumSystemVersion</key>',
    '\t<string>$(MACOSX_DEPLOYMENT_TARGET)</string>',
    '\t<key>NSHighResolutionCapable</key>',
    '\t<true/>',
  ];
  if (iconName) {
    lines.push('\t<key>CFBundleIconFile</key>');
    lines.push('\t<string>' + iconName + '</string>');
  }
  lines.push('</dict>', '</plist>', '');
  return lines.join('\n');
}

function pushProjectConfig(push: (s: string) => void, oid: string, name: string, deploymentTarget: string): void {
  push(`\t\t${oid} /* ${name} */ = {`);
  push('\t\t\tisa = XCBuildConfiguration;');
  push('\t\t\tbuildSettings = {');
  push('\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;');
  // The generated C uses bare type names (Point, Rectangle, ...) that collide
  // with macOS SDK types (e.g. MacTypes.h's Point). Raw `cc` builds fine because
  // Apple clang does not enable -fmodules by default; Xcode does, and -fmodules
  // would make the SDK's Point shadow the generated struct. Disable modules so
  // the project builds identically to the raw command-line build.
  push('\t\t\t\tCLANG_ENABLE_MODULES = NO;');
  // ARC must stay OFF: the Objective-C++ glue (metal_glue.mm) manages its ObjC
  // objects with manual retain/release and bare bridge casts, matching the raw
  // command-line clang build (which does not enable -fobjc-arc by default).
  // Enabling ARC here breaks those files with "ARC forbids explicit release"
  // and "requires a bridged cast" errors.
  push('\t\t\t\tCLANG_ENABLE_OBJC_ARC = NO;');
  push('\t\t\t\tCOPY_PHASE_STRIP = NO;');
  push('\t\t\t\tENABLE_STRICT_OBJC_MSGSEND = YES;');
  push('\t\t\t\tGCC_C_LANGUAGE_STANDARD = c99;');
  push(`\t\t\t\tGCC_OPTIMIZATION_LEVEL = ${name === 'Debug' ? '0' : 's'};`);
  push('\t\t\t\tGCC_PREPROCESSOR_DEFINITIONS = (');
  push('\t\t\t\t\t"$(inherited)",');
  push('\t\t\t\t);');
  push(`\t\t\t\tMACOSX_DEPLOYMENT_TARGET = ${deploymentTarget};`);
  push('\t\t\t\tONLY_ACTIVE_ARCH = YES;');
  push('\t\t\t\tSDKROOT = macosx;');
  push('\t\t\t};');
  push('\t\t\tname = ' + name + ';');
  push('\t\t};');
}

function pushTargetConfig(
  push: (s: string) => void,
  oid: string,
  name: string,
  cfg: BuildConfig,
  productName: string,
  bundleId: string,
  displayName: string,
): void {
  // OTHER_LDFLAGS mirrors the raw native link step: -lm -lz are always linked,
  // then the manifest's link libs, objects, and frameworks.
  const ldflags: string[] = ['-lm', '-lz'];
  for (const l of cfg.linkLibs) ldflags.push(`-l${l}`);
  for (const o of cfg.objects) ldflags.push(resolve(o));
  for (const f of cfg.frameworks) ldflags.push('-framework', f);

  // Optimization flag: the raw build uses cfg.opt (default -O2). Xcode exposes
  // optimization via GCC_OPTIMIZATION_LEVEL, so map the common -O{0,1,2,3,s}.
  const optLevel = mapOptLevel(cfg.opt);

  const headerPaths = cfg.includePaths.map((p) => resolve(p));
  const libPaths = cfg.linkPaths.map((p) => resolve(p));

  push(`\t\t${oid} /* ${name} */ = {`);
  push('\t\t\tisa = XCBuildConfiguration;');
  push('\t\t\tbuildSettings = {');
  push('\t\t\t\tCLANG_CXX_LANGUAGE_STANDARD = "c++17";');
  push('\t\t\t\tCLANG_CXX_LIBRARY = "libc++";');
  // Ad-hoc sign so `xcodebuild` produces a runnable .app with no provisioning
  // profile or Apple ID. Manual style avoids Xcode's automatic signing trying to
  // reach the developer portal.
  push('\t\t\t\tCODE_SIGN_IDENTITY = "-";');
  push('\t\t\t\tCODE_SIGN_STYLE = Manual;');
  push('\t\t\t\tCOMBINE_HIDPI_IMAGES = YES;');
  push('\t\t\t\tINFOPLIST_FILE = ' + productName + '.xcodeproj/Info.plist;');
  push('\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (');
  push('\t\t\t\t\t"$(inherited)",');
  push('\t\t\t\t\t"@executable_path/../Frameworks",');
  push('\t\t\t\t);');
  if (optLevel !== null) push(`\t\t\t\tGCC_OPTIMIZATION_LEVEL = ${optLevel};`);
  push('\t\t\t\tHEADER_SEARCH_PATHS = (');
  for (const p of headerPaths) push(`\t\t\t\t\t"${esc(p)}",`);
  push('\t\t\t\t);');
  push('\t\t\t\tLIBRARY_SEARCH_PATHS = (');
  for (const p of libPaths) push(`\t\t\t\t\t"${esc(p)}",`);
  push('\t\t\t\t);');
  push('\t\t\t\tGCC_PREPROCESSOR_DEFINITIONS = (');
  for (const d of cfg.defines) push(`\t\t\t\t\t"${esc(d)}",`);
  push('\t\t\t\t);');
  push('\t\t\t\tOTHER_LDFLAGS = (');
  for (const f of ldflags) push(`\t\t\t\t\t"${esc(f)}",`);
  push('\t\t\t\t);');
  push(`\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${bundleId};`);
  push(`\t\t\t\tPRODUCT_NAME = ${productName};`);
  push('\t\t\t};');
  push('\t\t\tname = ' + name + ';');
  push('\t\t};');
}

// Map a -O{0,1,2,3,s} optimization flag to Xcode's GCC_OPTIMIZATION_LEVEL
// integer/letter, or null if the flag does not map (then we omit it rather
// than mis-translate it).
function mapOptLevel(opt: string): string | null {
  const m = /(?:^|\s)-O([0-3s])(?:\s|$)/.exec(opt);
  if (!m) return null;
  return m[1];
}

function schemeXml(targetOid: string, productName: string): string {
  const buildableName = `${productName}.app`;
  const ref = `<BuildableReference\n      BuildableIdentifier = "primary"\n      BlueprintIdentifier = "${targetOid}"\n      BuildableName = "${buildableName}"\n      BlueprintName = "${productName}"\n      ReferencedContainer = "container:${productName}.xcodeproj">\n      </BuildableReference>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "1500"
   version = "1.7">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "YES"
            buildForProfiling = "YES"
            buildForArchiving = "YES"
            buildForAnalyzing = "YES">
            ${ref}
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables>
      </Testables>
   </TestAction>
   <LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      launchStyle = "0"
      useCustomWorkingDirectory = "NO"
      ignoresPersistentStateOnLaunch = "NO"
      debugDocumentVersioning = "YES"
      debugServiceExtension = "internal"
      allowLocationSimulation = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
         ${ref}
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction
      buildConfiguration = "Release"
      shouldUseLaunchSchemeArgsEnv = "YES"
      savedToolIdentifier = ""
      useCustomWorkingDirectory = "NO"
      debugDocumentVersioning = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
         ${ref}
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction
      buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
`;
}

// Smart merge: patch an existing .xcodeproj in place so only the source-file
// list is refreshed, leaving the developer's hand edits (build settings, schemes,
// extra files/resources) untouched. The set of files we manage is remembered in
// a sidecar `.as3aot-managed.json` inside the .xcodeproj; on the next run we diff
// that remembered set against the newly-derived source list and only add/remove
// those entries. Xcode comments are dropped by the plist parser (they are pure
// readability hints) and regenerated by Xcode on its next save.
function mergeXcodeProject(
  cfg: BuildConfig,
  cPath: string,
  outDir: string,
  productName: string,
): XcodeProject {
  const projectPath = join(outDir, `${productName}.xcodeproj`);
  const pbxPath = join(projectPath, 'project.pbxproj');
  const sidecarPath = join(projectPath, '.as3aot-managed.json');

  const cAbs = resolve(cPath);
  const newSources = [cAbs, ...cfg.sources.map((s) => resolve(s))].sort();

  // Previous managed set (empty when absent: then we only add, never remove).
  let oldSources: string[] = [];
  try {
    const sc = JSON.parse(readFileSync(sidecarPath, 'utf8')) as { sources?: unknown };
    if (Array.isArray(sc.sources)) oldSources = sc.sources as string[];
  } catch {
    oldSources = [];
  }

  const root = parsePlist(readFileSync(pbxPath, 'utf8'));
  const top = asDict(root);
  if (!top) throw new Error('pbxproj: top-level object is not a dict');
  const objects = asDict(dictEntry(top, 'objects'));
  if (!objects) throw new Error('pbxproj: missing objects dict');

  const used = new Set<string>(objects.map(([oid]) => oid));

  // Index objects by isa for fast lookup.
  const byIsa = new Map<string, Array<[string, PlistValue]>>();
  for (const [oid, obj] of objects) {
    const isa = isaOf(obj);
    if (isa) {
      const arr = byIsa.get(isa) ?? [];
      arr.push([oid, obj]);
      byIsa.set(isa, arr);
    }
  }

  // Locate the main group (source files are listed in its children) and the
  // Sources build phase (their build-file entries drive compilation).
  const projectObjs = byIsa.get('PBXProject') ?? [];
  if (projectObjs.length === 0) throw new Error('pbxproj: missing PBXProject');
  const projectDict = asDict(projectObjs[0][1])!;
  const mainGroupOid = scalarText(dictEntry(projectDict, 'mainGroup'));
  const mainGroupEntry = objects.find(([oid]) => oid === mainGroupOid);
  if (!mainGroupEntry) throw new Error('pbxproj: missing main group');
  const mainGroupChildren = asArray(dictEntry(asDict(mainGroupEntry[1])!, 'children'))!;

  const sourcesPhaseObjs = byIsa.get('PBXSourcesBuildPhase') ?? [];
  if (sourcesPhaseObjs.length === 0) throw new Error('pbxproj: missing PBXSourcesBuildPhase');
  const sourcesFiles = asArray(dictEntry(asDict(sourcesPhaseObjs[0][1])!, 'files'))!;

  // Map absolute source paths to their fileRef oid, and fileRef oid to its
  // buildFile oid. Only absolute-path file refs are ours to manage; user-added
  // group-relative files are left alone.
  const pathToFileRef = new Map<string, string>();
  const fileRefToBuildFile = new Map<string, string>();
  for (const [oid, obj] of byIsa.get('PBXFileReference') ?? []) {
    const d = asDict(obj);
    if (!d) continue;
    if (scalarText(dictEntry(d, 'sourceTree')) !== '<absolute>') continue;
    const p = scalarText(dictEntry(d, 'path'));
    if (p) pathToFileRef.set(p, oid);
  }
  for (const [oid, obj] of byIsa.get('PBXBuildFile') ?? []) {
    const fr = scalarText(dictEntry(asDict(obj) ?? [], 'fileRef'));
    if (fr) fileRefToBuildFile.set(fr, oid);
  }

  // Additions: new sources absent from the project. Removals: previously-managed
  // sources no longer in the list.
  const toAdd = newSources.filter((p) => !pathToFileRef.has(p));
  const toRemove = oldSources.filter((p) => newSources.indexOf(p) === -1 && pathToFileRef.has(p));

  for (const p of toRemove) {
    const fileRefOid = pathToFileRef.get(p)!;
    const buildFileOid = fileRefToBuildFile.get(fileRefOid);
    spliceObject(objects, fileRefOid);
    if (buildFileOid) spliceObject(objects, buildFileOid);
    removeRef(mainGroupChildren, fileRefOid);
    if (buildFileOid) removeRef(sourcesFiles, buildFileOid);
  }

  for (const p of toAdd) {
    const fileRefOid = freshOid(used);
    const buildFileOid = freshOid(used);
    objects.push([
      fileRefOid,
      {
        kind: 'dict',
        entries: [
          ['isa', { kind: 'atom', value: 'PBXFileReference' }],
          ['lastKnownFileType', { kind: 'atom', value: fileType(p) }],
          ['name', { kind: 'atom', value: basename(p) }],
          ['path', { kind: 'string', value: p }],
          ['sourceTree', { kind: 'string', value: '<absolute>' }],
        ],
      },
    ]);
    objects.push([
      buildFileOid,
      {
        kind: 'dict',
        entries: [
          ['isa', { kind: 'atom', value: 'PBXBuildFile' }],
          ['fileRef', { kind: 'atom', value: fileRefOid }],
        ],
      },
    ]);
    mainGroupChildren.push({ kind: 'atom', value: fileRefOid });
    sourcesFiles.push({ kind: 'atom', value: buildFileOid });
  }

  // Migrate any managed source whose lastKnownFileType no longer matches its
  // extension (e.g. a newly-added .mm was written as `sourcecode.c.c` before the
  // fileType() fix). This repairs an already-generated project in place without
  // clobbering the developer's hand edits.
  let typeFixed = false;
  for (const p of newSources) {
    const fileRefOid = pathToFileRef.get(p);
    if (!fileRefOid) continue;
    const entry = objects.find(([oid]) => oid === fileRefOid);
    if (!entry) continue;
    const d = asDict(entry[1]);
    if (!d) continue;
    const idx = d.findIndex(([k]) => k === 'lastKnownFileType');
    if (idx === -1) continue;
    const expected = fileType(p);
    if (scalarText(d[idx][1]) !== expected) {
      d[idx][1] = { kind: 'atom', value: expected };
      typeFixed = true;
    }
  }

  const changed = toAdd.length > 0 || toRemove.length > 0 || typeFixed;
  if (changed) writeFileSync(pbxPath, serializePlist(root));
  writeFileSync(sidecarPath, JSON.stringify({ sources: newSources }, null, 2) + '\n');

  return {
    projectPath,
    appPath: join(outDir, `${productName}.app`),
    schemeName: productName,
    action: 'merge',
    changed,
  };
}

function isaOf(obj: PlistValue): string | null {
  const d = asDict(obj);
  return d ? scalarText(dictEntry(d, 'isa')) : null;
}

function spliceObject(objects: Array<[string, PlistValue]>, oid: string): void {
  const idx = objects.findIndex(([k]) => k === oid);
  if (idx !== -1) objects.splice(idx, 1);
}

function removeRef(items: PlistValue[], oid: string): void {
  const idx = items.findIndex((it) => scalarText(it) === oid);
  if (idx !== -1) items.splice(idx, 1);
}

// Mint a fresh object ID that does not collide with any existing ID (the shared
// idCounter is reset per process, so a merge must skip over IDs already in use).
function freshOid(used: Set<string>): string {
  let n = used.size + 1;
  for (;;) {
    const id = 'A' + n.toString(16).toUpperCase().padStart(23, '0');
    if (!used.has(id)) { used.add(id); return id; }
    n++;
  }
}
