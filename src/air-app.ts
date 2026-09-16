// air-app.ts — AIR application descriptor (air-native-app.xml) parsing plus
// bootstrap/manifest generation for the `--air-app` migration adapter.
//
// A hand-written minimal XML extractor (zero dependencies) reads the few fields
// as-aot needs from an AIR app.xml, then turns them into an AS3 bootstrap source
// string (fed through the normal lexer/parser, so the "frontend only translates"
// rule holds) and a build manifest that links the Skia + SDL2 backend.
//
// The one piece of information app.xml does NOT carry is the document class
// (main class) — mxmlc gets it from the compile arguments, not the descriptor.
// So the main class must come from `--main-class`, or (by convention) a unique
// `src/**/Main.as` whose `package` statement yields the FQN.

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';

export interface AirAppInfo {
  id: string;
  versionNumber: string;
  filename: string;
  content: string;
  title: string;
  visible: boolean;
  resizable: boolean;
  width: number;
  height: number;
  displayResolution: string;
}

export class AirAppError extends Error {}

// Reverse-DNS third-party library directories. They ship with real AIR apps but
// usually depend on language features outside this compiler's subset, so the
// src/**/*.as walk skips them (mirroring test.ts's SKIP_DIRS). The specific
// GreenSock core files the air-native demo reaches are re-added explicitly.
const THIRD_PARTY_DIRS = new Set(['com', 'org', 'net']);
// GreenSock core files TweenDemo actually reaches. Only these are pulled in; the
// rest of the vendored com/greensock library (TweenMax/TimelineMax/loading/layout/
// motionPaths/43 plugins/easing/help bundle) stays outside the subset and is left
// to the mxmlc/adl path (build-and-run.sh). Mirrors test.ts's GREENSOCK_CORE.
const GREEN_SOCK_CORE = [
  'com/greensock/TweenLite.as',
  'com/greensock/core/TweenCore.as',
  'com/greensock/core/SimpleTimeline.as',
  'com/greensock/core/PropTween.as',
  'com/greensock/plugins/TweenPlugin.as',
  'com/greensock/easing/Quad.as',
  'com/greensock/easing/Cubic.as',
];

// Extract the text of a single element by name (no nested same-name elements in
// the AIR descriptor subset we read).
function childText(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : null;
}

export function parseAirApp(xml: string): AirAppInfo {
  const id = childText(xml, 'id') ?? '';
  const versionNumber = childText(xml, 'versionNumber') ?? '';
  const filename = childText(xml, 'filename') ?? '';

  const iw = xml.match(/<initialWindow\b[^>]*>([\s\S]*?)<\/initialWindow>/);
  const iwXml = iw ? iw[1] : '';
  const content = childText(iwXml, 'content') ?? '';
  const title = childText(iwXml, 'title') ?? '';
  const visibleStr = childText(iwXml, 'visible') ?? 'true';
  const resizableStr = childText(iwXml, 'resizable') ?? 'true';
  const widthStr = childText(iwXml, 'width') ?? '800';
  const heightStr = childText(iwXml, 'height') ?? '600';
  // AIR's default is "standard" (1x, blurry on Retina); "high" renders at the
  // device's native resolution.
  const resolutionStr = (childText(iwXml, 'requestedDisplayResolution') ?? 'standard').toLowerCase();

  const visible = visibleStr.toLowerCase() !== 'false';
  const resizable = resizableStr.toLowerCase() !== 'false';
  const width = parseInt(widthStr, 10);
  const height = parseInt(heightStr, 10);

  if (!id || !filename) {
    throw new AirAppError('air-app.xml is missing <id> or <filename>');
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new AirAppError('air-app.xml <initialWindow> width/height must be positive integers');
  }
  return { id, versionNumber, filename, content, title: title || filename, visible, resizable, width, height, displayResolution: resolutionStr };
}

// Short name of a fully-qualified class: `demo.Main` -> `Main`.
export function shortClassName(fqn: string): string {
  const i = fqn.lastIndexOf('.');
  return i >= 0 ? fqn.slice(i + 1) : fqn;
}

function escapeAsString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// Generate the bootstrap AS3 source (equivalent to boot-gui.as / boot.as). It is
// parsed by the normal lexer/parser rather than emitted as C directly.
export function generateBootstrap(info: AirAppInfo, mainClass: string): string {
  const short = shortClassName(mainClass);
  const lines: string[] = [
    `// auto-generated bootstrap by as-aot --air-app (main class: ${mainClass})`,
    `import ${mainClass};`,
    '',
    'var stage:Stage = new Stage();',
    // adl creates the NativeWindow before the document class runs, so stage
    // dimensions are already set when Main's constructor reads them. Preset
    // stageWidth/stageHeight here so trace(stage.stageWidth, stage.stageHeight)
    // inside Main.start() matches adl (1000 680) instead of default 0 0.
    `stage.stageWidth = ${info.width};`,
    `stage.stageHeight = ${info.height};`,
    `var app:${short} = new ${short}();`,
    'stage.addChild(app);',
  ];
  if (info.visible) {
    lines.push(`stage.showWindow(${info.width}, ${info.height}, "${escapeAsString(info.title)}");`);
    lines.push('trace("window closed");');
  } else {
    lines.push(`stage.render(${info.width}, ${info.height}, "${escapeAsString(info.filename)}.png");`);
    lines.push(`trace("${escapeAsString(info.filename)} rendered");`);
  }
  lines.push('');
  return lines.join('\n');
}

// Build the manifest object (kebab-case fields, matching build.ts's Manifest).
// `vendorRel` is the path from the manifest's directory to as3compiler/vendor,
// so all Skia/SDL2 paths resolve correctly regardless of where the app.xml lives.
export function airManifest(vendorRel: string, visible: boolean, resizable: boolean, highDpi: boolean): Record<string, unknown> {
  const skiaSrc = `${vendorRel}/skia_glue.cc`;
  const winSrc = `${vendorRel}/window_glue.cc`;
  const sources = visible ? [skiaSrc, winSrc] : [skiaSrc];
  const defines = visible ? ['ASC_USE_SKIA=1', 'ASC_USE_WINDOW=1'] : ['ASC_USE_SKIA=1'];
  // ASC_WINDOW_FIXED mirrors AIR's <resizable>false</resizable>: the window is
  // created without SDL_WINDOW_RESIZABLE, matching adl's fixed-size window.
  if (visible && !resizable) defines.push('ASC_WINDOW_FIXED=1');
  // ASC_DISPLAY_HIGH mirrors <requestedDisplayResolution>high: the window asks SDL
  // for a native-resolution drawable and the offscreen surface is sized in physical
  // pixels, so text is not stretched by the compositor (the "blurry" symptom).
  if (visible && highDpi) defines.push('ASC_DISPLAY_HIGH=1');
  const linkLibs = [
    'skia', 'skparagraph', 'skshaper', 'skunicode', 'skottie', 'sksg', 'svg',
    'skresources', 'bentleyottmann', 'skcms', 'wuffs', 'png', 'jpeg', 'webp',
    'webp_sse41', 'dng_sdk', 'piex', 'expat', 'freetype2', 'harfbuzz', 'icu',
    'zlib', 'z',
  ];
  const frameworks = [
    'CoreFoundation', 'CoreGraphics', 'CoreText', 'CoreServices',
    'ApplicationServices', 'ImageIO', 'Accelerate',
  ];
  if (visible) {
    linkLibs.push('SDL2', 'objc');
    frameworks.push('CoreVideo', 'Cocoa', 'Carbon', 'IOKit', 'Metal', 'QuartzCore');
  }
  return {
    target: 'native',
    'c-compiler': 'clang',
    opt: '-O2',
    sources,
    'include-paths': [`${vendorRel}/skia`, `${vendorRel}/sdl2/arm64/include`],
    'link-libs': linkLibs,
    'link-paths': [`${vendorRel}/skia/lib`, `${vendorRel}/sdl2/arm64/lib`],
    frameworks,
    defines,
    objects: [],
  };
}

export interface PreparedAirApp {
  info: AirAppInfo;
  mainClass: string;
  asFiles: string[];
  manifestPath: string;
}

// Orchestrate the `--air-app` migration: parse the descriptor, collect every
// .as under <app.xml dir>/src, resolve the main class, and write the generated
// build manifest next to the descriptor.
export function prepareAirApp(appXmlPath: string, mainClassOpt: string | null, vendorAbs: string): PreparedAirApp {
  const xml = readFileSync(appXmlPath, 'utf8');
  const info = parseAirApp(xml);
  const dir = dirname(resolve(appXmlPath));
  const srcDir = resolve(dir, 'src');
  if (!existsSync(srcDir)) {
    throw new AirAppError(`air-app src directory not found: ${srcDir}`);
  }

  const asFiles: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = resolve(d, e.name);
      if (e.isDirectory()) {
        if (THIRD_PARTY_DIRS.has(e.name)) continue;
        walk(p);
      } else if (e.name.endsWith('.as')) asFiles.push(p);
    }
  };
  walk(srcDir);
  // Re-add the GreenSock core the demo reaches (present only in this example; a
  // different project without these vendored files simply gets nothing added).
  for (const rel of GREEN_SOCK_CORE) {
    const p = resolve(srcDir, rel);
    if (existsSync(p)) asFiles.push(p);
  }
  if (asFiles.length === 0) {
    throw new AirAppError(`no .as sources found under ${srcDir}`);
  }

  let mainClass = mainClassOpt;
  if (!mainClass) {
    const mains = asFiles.filter((f) => f.endsWith('Main.as'));
    if (mains.length !== 1) {
      throw new AirAppError(
        `cannot infer the main class: found ${mains.length} Main.as under ${srcDir}; pass --main-class <pkg.Main>`
      );
    }
    const src = readFileSync(mains[0], 'utf8');
    const pkg = src.match(/package\s+([\w.]+)/);
    mainClass = pkg ? `${pkg[1]}.Main` : 'Main';
  }

  const vendorRel = relative(dir, vendorAbs).replace(/\\/g, '/');
  const manifestPath = resolve(dir, `${info.filename}.build.json`);
  writeFileSync(manifestPath, JSON.stringify(airManifest(vendorRel, info.visible, info.resizable, info.displayResolution === 'high'), null, 2) + '\n');

  return { info, mainClass, asFiles, manifestPath };
}
