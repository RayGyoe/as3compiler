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

// A single <font> entry under <embedFonts>. AIR uses these for StageText custom
// fonts: <fontPath> is the ttf relative to the app root, <fontName> is the name
// StageText references it by (which need not equal the ttf's internal family).
export interface EmbedFont {
  path: string;
  name: string;
}

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
  renderMode: string;
  fonts: EmbedFont[];
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

// Parse <embedFonts> into [{ path, name }]. AIR nests it as
//   <embedFonts><font><fontPath>ttf/x.ttf</fontPath><fontName>x</fontName></font>…</embedFonts>
// with any number of <font> children. Empty (the common case) yields [].
function parseEmbedFonts(xml: string): EmbedFont[] {
  const wrap = xml.match(/<embedFonts\b[^>]*>([\s\S]*?)<\/embedFonts>/);
  if (!wrap) return [];
  const fonts: EmbedFont[] = [];
  const re = /<font\b[^>]*>([\s\S]*?)<\/font>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wrap[1])) !== null) {
    const path = childText(m[1], 'fontPath');
    const name = childText(m[1], 'fontName');
    if (path) fonts.push({ path, name: name ?? path });
  }
  return fonts;
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
  // <renderMode> selects the GPU/CPU split (see airsdk.dev initialWindow):
  //   auto   (default) — currently falls back to CPU mode.
  //   cpu    — hardware acceleration is not used (software raster + putImageData).
  //   direct — composition on CPU, blit via GPU (software raster + WebGL blit).
  //   gpu    — full hardware-accelerated composition (Ganesh; not yet wired).
  const renderMode = (childText(iwXml, 'renderMode') ?? 'auto').toLowerCase();

  const visible = visibleStr.toLowerCase() !== 'false';
  const resizable = resizableStr.toLowerCase() !== 'false';
  const width = parseInt(widthStr, 10);
  const height = parseInt(heightStr, 10);
  const fonts = parseEmbedFonts(xml);

  if (!id || !filename) {
    throw new AirAppError('air-app.xml is missing <id> or <filename>');
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new AirAppError('air-app.xml <initialWindow> width/height must be positive integers');
  }
  return { id, versionNumber, filename, content, title: title || filename, visible, resizable, width, height, displayResolution: resolutionStr, renderMode, fonts };
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
//
// `web` switches the manifest to the browser backend (--target wasm --package web):
// the same generated .c links against web_glue.cc (canvas + rAF frame driver) and
// the wasm build of Skia, with no SDL2/objc/Cocoa — those are native-only and wasm-ld
// cannot find them (`-lobjc`). The AIR <initialWindow> visible/resizable/highdpi
// flags still shape defines, but the window-backend specifics differ per target.
export function airManifest(vendorRel: string, visible: boolean, resizable: boolean, highDpi: boolean, web: boolean, renderMode: string, fonts: EmbedFont[]): Record<string, unknown> {
  // Browser backend: skia_glue.cc + web_glue.cc, the wasm Skia library set, no
  // SDL2/Cocoa/frameworks. Mirrors examples/web/hello-web.build.json. The wasm
  // Skia build omits the native-only animation/image codecs (skottie/svg/...), so
  // the library list is the wasm subset; zlib comes from Emscripten's USE_ZLIB.
  if (web) {
    const defines = ['ASC_USE_SKIA=1', 'ASC_USE_WINDOW=1'];
    // ASC_DISPLAY_HIGH mirrors <requestedDisplayResolution>high: the offscreen
    // surface is sized in physical pixels (window.devicePixelRatio) and the canvas
    // CSS box stays at logical size, so a Retina display presents 1:1 instead of
    // the browser stretching a 1x bitmap into blur — the same flag as the native
    // backend, just resolved via window.devicePixelRatio instead of SDL's probe.
    if (visible && highDpi) defines.push('ASC_DISPLAY_HIGH=1');
    // <renderMode> maps to the Skia backend in skia_glue.cc / web_glue.cc.
    // Efficiency-first (not AIR's "direct = CPU compose + GPU blit" split):
    //   cpu/auto — pure software raster + putImageData (the default; no define).
    //   direct/gpu — full Ganesh GPU rasterization: Skia composes on the GPU
    //     (GrDirectContext + WebGL2) so the whole render loop is hardware
    //     accelerated, not just the final blit.
    if (renderMode === 'direct' || renderMode === 'gpu') defines.push('ASC_RENDER_GPU=1');
    return {
      target: 'wasm',
      package: 'web',
      opt: '-O2',
      sources: [`${vendorRel}/skia_glue.cc`, `${vendorRel}/web_glue.cc`],
      'include-paths': [`${vendorRel}/skia`],
      'link-libs': [
        'skia', 'skparagraph', 'skshaper', 'skunicode', 'skcms', 'wuffs',
        'png', 'jpeg', 'webp', 'webp_sse41', 'freetype2', 'harfbuzz', 'icu',
      ],
      'link-paths': [`${vendorRel}/skia/lib/wasm`],
      defines,
      // The browser has no system fonts; the page fetches these at runtime and
      // injects them into Skia's custom font manager (see html5-web.md §3). The
      // list comes from the descriptor's <embedFonts> <fontPath> entries (relative
      // to the app.xml dir), so swapping/adding fonts is a descriptor edit, not a
      // code edit. With no <embedFonts>, fall back to the bundled Arial.ttf.
      'font-urls': fonts.length > 0 ? fonts.map((f) => f.path) : ['fonts/Arial.ttf'],
      objects: [],
    };
  }

  const skiaSrc = `${vendorRel}/skia_glue.cc`;
  const winSrc = `${vendorRel}/window_glue.cc`;
  const mtlSrc = `${vendorRel}/metal_glue.mm`;
  const sources = visible ? [skiaSrc, winSrc] : [skiaSrc];
  const defines = visible ? ['ASC_USE_SKIA=1', 'ASC_USE_WINDOW=1'] : ['ASC_USE_SKIA=1'];
  // ASC_WINDOW_FIXED mirrors AIR's <resizable>false</resizable>: the window is
  // created without SDL_WINDOW_RESIZABLE, matching adl's fixed-size window.
  if (visible && !resizable) defines.push('ASC_WINDOW_FIXED=1');
  // ASC_DISPLAY_HIGH mirrors <requestedDisplayResolution>high: the window asks SDL
  // for a native-resolution drawable and the offscreen surface is sized in physical
  // pixels, so text is not stretched by the compositor (the "blurry" symptom).
  if (visible && highDpi) defines.push('ASC_DISPLAY_HIGH=1');
  // <renderMode> direct/gpu maps to the native Metal backend (ASC_RENDER_METAL):
  // the window's Skia composition runs on the GPU through GrDirectContext(Metal)
  // + SDL_Metal_CreateView/CAMetalLayer instead of the CPU raster surface + SDL
  // blit. The Metal glue (metal_glue.mm) is Objective-C++, so it is added to the
  // source set only when the GPU path is requested. Offscreen PNG export and
  // cacheAsBitmap stay CPU-raster regardless (Metal drawables are one-shot and
  // cannot back a persistent offscreen surface).
  const gpu = renderMode === 'direct' || renderMode === 'gpu';
  if (visible && gpu) {
    defines.push('ASC_RENDER_METAL=1');
    sources.push(mtlSrc);
  }
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
    'link-paths': [`${vendorRel}/skia/lib/macos-arm64`, `${vendorRel}/sdl2/arm64/lib`],
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
// build manifest next to the descriptor. `web` selects the browser backend
// (--target wasm --package web) so the manifest links the right glue + libraries.
export function prepareAirApp(appXmlPath: string, mainClassOpt: string | null, vendorAbs: string, web: boolean): PreparedAirApp {
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
  writeFileSync(manifestPath, JSON.stringify(airManifest(vendorRel, info.visible, info.resizable, info.displayResolution === 'high', web, info.renderMode, info.fonts), null, 2) + '\n');

  return { info, mainClass, asFiles, manifestPath };
}
