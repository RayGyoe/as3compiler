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
import { resolve, dirname, relative, basename, sep, isAbsolute } from 'node:path';

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
  depthAndStencil: boolean;
  fonts: EmbedFont[];
}

export class AirAppError extends Error {}

// Reverse-DNS third-party library directories. They ship with real AIR apps but
// usually depend on language features outside this compiler's subset, so the
// src/**/*.as walk skips them (mirroring test.ts's SKIP_DIRS). The specific
// GreenSock core files the air-native demo reaches are re-added explicitly.
const THIRD_PARTY_DIRS = new Set(['com', 'org', 'net']);
// Dead-code sources skipped by the src walk (path relative to srcDir). Starling
// ships TWO AssetManager classes: the legacy starling.utils.AssetManager (1.x)
// and the current starling.assets.AssetManager. This demo reaches only the latter;
// the legacy one is unreferenced here AND its identical short name collides with
// the current class in the compiler's global short-name alias table, so it is
// excluded rather than let `AssetManager` resolve to the wrong FQN.
const SKIP_FILES = new Set(['starling/utils/AssetManager.as']);
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
// Adobe's AGALMiniAssembler (com/adobe/utils) is the official AGAL1 assembler that
// Stage3D demos drive to build their shader binaries. It sits in a reverse-DNS
// third-party dir (skipped by the src walk) but is a hard dependency of those
// demos, so it is re-added explicitly — same pattern as GREEN_SOCK_CORE.
const ADOBE_UTILS_CORE = [
  'com/adobe/utils/AGALMiniAssembler.as',
];

// Stage3D usage detector: the generated manifest must link stage3d_glue.mm +
// define ASC_RENDER_STAGE3D (the offscreen Metal triangle pipeline), otherwise
// Context3D falls back to a no-op software state machine and the demo renders
// nothing but the 2D display list (the "white screen" symptom). Detect it by
// scanning for the flash.display3D import, the unambiguous marker that a project
// drives the programmable pipeline.
function detectStage3D(asFiles: string[]): boolean {
  for (const f of asFiles) {
    try {
      if (readFileSync(f, 'utf8').includes('flash.display3D')) return true;
    } catch {
      // unreadable file: skip
    }
  }
  return false;
}

// Network usage detector: a remote URL is only fetched when the build declares a
// transport backend, and the backend is chosen by a *define* (the generated C is
// byte-identical either way). Without one, `http(s)://` still runs through the
// async job table — so the async contract holds and the app compiles cleanly —
// but every request ends in AS_JOB_ERR_UNSUPPORTED, which surfaces as ioError on
// every load (the "网络访问都是 ioError" symptom).
//
// `URLRequest` is the marker, and it is the WHOLE marker: every path that reaches
// the HTTP seam must build one first (URLLoader.load, URLStream.load, Loader.load
// for a remote image, navigateToURL/sendToURL), whereas the `flash.net` *package*
// also hosts classes that never touch the network — SharedObject, FileReference,
// LocalConnection. Matching the package name would link 1.4 MB of static curl into
// an app that only wants local storage and, worse, would hard-fail on a machine
// without vendor/curl (see the check in prepareAirApp). Deliberately NOT a marker
// either: Socket/XMLSocket (they need ASC_SOCK_POSIX, not the HTTP backend) and
// NetConnection/NetStream (RTMP has no curl backend here).
// Same shape as detectStage3D: scan the app's own sources, no config to write.
function detectNetworking(asFiles: string[]): boolean {
  for (const f of asFiles) {
    try {
      if (readFileSync(f, 'utf8').includes('URLRequest')) return true;
    } catch {
      // unreadable file: skip
    }
  }
  return false;
}

// Text-drawing detector: on a web build every glyph comes from a font the page
// injects — the browser sandbox has NO system fonts, so with nothing registered
// sk_platform_fontmgr() returns SkFontMgr_New_Custom_Empty() and drawString
// paints nothing at all. An app that draws text without a font therefore renders
// its TextFields as empty boxes: the field's own background paints (so the
// layout is visibly there) and every glyph is missing. Native/adl are immune
// (CoreText enumerates the installed families), which makes this a web-only trap,
// and a SILENT one: the build succeeds, the page runs, only the text is absent.
//
// `flash.text` is the marker: unlike `flash.net` (whose SharedObject /
// FileReference never touch the network — see detectNetworking), the whole
// package is about drawing text (TextField, TextFormat, TextFieldAutoSize,
// StaticText…), so there is no class in it that would make this a false positive.
function detectText(asFiles: string[]): boolean {
  for (const f of asFiles) {
    try {
      if (readFileSync(f, 'utf8').includes('flash.text')) return true;
    } catch {
      // unreadable file: skip
    }
  }
  return false;
}

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
  // <depthAndStencil> allocates the depth/stencil buffer at startup, before any
  // content loads (required for Context3D.configureBackBuffer's matching
  // enableDepthAndStencil flag). Only valid when renderMode is direct/gpu.
  const depthAndStencil = (childText(iwXml, 'depthAndStencil') ?? 'false').toLowerCase() === 'true';

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
  return { id, versionNumber, filename, content, title: title || filename, visible, resizable, width, height, displayResolution: resolutionStr, renderMode, depthAndStencil, fonts };
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
    // Resolve Stage via its fully-qualified name so the built-in flash.display
    // Stage (keyed by short name 'Stage' in classMap) is used, not a user
    // starling.display.Stage whose constructor takes width/height.
    'var stage:flash.display.Stage = new flash.display.Stage();',
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
export function airManifest(vendorRel: string, visible: boolean, resizable: boolean, highDpi: boolean, web: boolean, renderMode: string, usesStage3D: boolean, depthAndStencil: boolean, fonts: EmbedFont[], preloadPaths: string[], preloadExcludes: string[], appFontUrls: string[], usesNetworking: boolean, features: string[] = []): Record<string, unknown> {
  // Browser backend: skia_glue.cc + web_glue.cc, the wasm Skia library set, no
  // SDL2/Cocoa/frameworks. Mirrors examples/web/hello-web.build.json. The wasm
  // Skia build omits the native-only animation/image codecs (skottie/svg/...), so
  // the library list is the wasm subset; zlib comes from Emscripten's USE_ZLIB.
  if (web) {
    const defines = ['ASC_USE_SKIA=1', 'ASC_USE_WINDOW=1'];
    // Network transport: the browser cannot open a socket, so a remote URL is
    // fetched by the page's own fetch() — the only HTTP client a browser sandbox
    // permits (src/runtime.ts ASC_HTTP_WEB). Opted in by define for the same
    // reason as curl on native: the generated C is identical either way, and
    // without the define every request reports the honest AS_JOB_ERR_UNSUPPORTED
    // (ioError on every load) instead of a silent wrong result.
    if (usesNetworking) defines.push('ASC_HAVE_FETCH=1');
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
    // Stage3D (flash.display3D): link the WebGL2 triangle pipeline and stop the
    // as_s3d_* wrappers from being no-ops. Starling draws *everything* through
    // Context3D, so without this the page shows only the 2D display-list overlay
    // while the stage stays black. ASC_S3D_GLSL picks the AGAL translator's GLSL ES
    // output (stage3d_glue.mm/the Metal backend compiles MSL instead).
    const webSources = [`${vendorRel}/skia_glue.cc`, `${vendorRel}/web_glue.cc`];
    if (usesStage3D) {
      webSources.push(`${vendorRel}/stage3d_webgl.cc`);
      defines.push('ASC_RENDER_STAGE3D=1');
      defines.push('ASC_S3D_GLSL=1');
      // <depthAndStencil>true</depthAndStencil> allocates the depth/stencil
      // attachment (Starling's masking depends on the stencil buffer).
      if (depthAndStencil) defines.push('ASC_RENDER_DEPTH_STENCIL=1');
    }
    return {
      target: 'wasm',
      package: 'web',
      opt: '-O2',
      sources: webSources,
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
      // code edit. With no <embedFonts>, the app's own bundled TTFs are used (see
      // findAppFonts) — falling back to a font the app does not ship would leave
      // every requested family unresolved and render no glyphs at all.
      'font-urls': fonts.length > 0 ? fonts.map((f) => f.path) : appFontUrls,
      // Data roots packed into the FS image (see BuildConfig.preloadPaths). The
      // app root IS `File.applicationDirectory` for adl, so the browser build
      // mirrors it by packing the app root's entries that are neither sources nor
      // this compiler's own artifacts.
      'preload-paths': preloadPaths,
      // Holes punched in the preload set above (emcc `--exclude-file`). A font in
      // `font-urls` is fetched over HTTP by the page and injected into Skia's font
      // manager, so a copy inside the FS image is dead weight — it is downloaded
      // twice and, for a CJK face, that is the bulk of the payload. The FS copy is
      // never read (measured: a page whose `.data` omits the font renders text
      // normally), so `--air-app` excludes exactly the fonts it also lists as
      // `font-urls` and nothing else: bitmap fonts read as real data files
      // (`.fnt` + atlas, which the app opens through File/FileStream) are NOT in
      // font-urls and stay in the image. Entries are fnmatch patterns matched
      // against the host path (see BuildConfig.preloadExcludes), so the generator
      // escapes literals.
      'preload-excludes': preloadExcludes,
      // Carried through even when empty: for the web backend every feature is a
      // native-only channel, so this is [] today — but writing it keeps the
      // persisted choice visible in the generated file (see prepareAirApp).
      features,
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
  const includePaths = [`${vendorRel}/skia`, `${vendorRel}/sdl2/arm64/include`];
  const linkPaths = [`${vendorRel}/skia/lib/macos-arm64`, `${vendorRel}/sdl2/arm64/lib`];
  const frameworks = [
    'CoreFoundation', 'CoreGraphics', 'CoreText', 'CoreServices',
    'ApplicationServices', 'ImageIO', 'Accelerate',
  ];
  if (visible) {
    linkLibs.push('SDL2', 'objc');
    frameworks.push('CoreVideo', 'Cocoa', 'Carbon', 'IOKit', 'Metal', 'QuartzCore');
  }
  // Network transport (flash.net / a remote Loader.load): link the static curl
  // built into vendor/curl by build-tools/curl-src/build-static.sh and define
  // ASC_HAVE_CURL, which is what turns as_http_perform from an honest
  // AS_JOB_ERR_UNSUPPORTED into a real transfer (src/runtime.ts). The static
  // archive keeps the default build self-contained, which is the project's shape:
  // linking the system libcurl would make the executable depend on
  // libcurl.4.dylib at runtime. Security + SystemConfiguration are curl's macOS
  // TLS (Secure Transport) and system-proxy dependencies; nghttp2 is its HTTP/2
  // framing library (only exercised when ASC_HTTP2 is also defined).
  if (usesNetworking) {
    includePaths.push(`${vendorRel}/curl/include`);
    linkPaths.push(`${vendorRel}/curl/lib/macos-arm64`);
    linkLibs.push('curl', 'nghttp2');
    defines.push('ASC_HAVE_CURL=1');
    frameworks.push('Security', 'SystemConfiguration');
  }
  // Stage3D (flash.display3D): link the offscreen Metal triangle pipeline
  // (stage3d_glue.mm) and define ASC_RENDER_STAGE3D so the as_s3d_* wrappers stop
  // being no-ops. Without this the demo runs Context3D as a software state machine
  // and never produces GPU pixels (the "white screen" symptom). The web target has
  // its own backend (stage3d_webgl.cc, WebGL2) wired the same way in the `web`
  // branch above.
  if (usesStage3D) {
    sources.push(`${vendorRel}/stage3d_glue.mm`);
    defines.push('ASC_RENDER_STAGE3D=1');
    // <depthAndStencil>true</depthAndStencil> allocates the depth/stencil buffer at
    // startup (AIR requires it before any content loads; it must match the
    // enableDepthAndStencil argument to Context3D.configureBackBuffer). Mirror it
    // as ASC_RENDER_DEPTH_STENCIL so stage3d_glue.mm attaches a depth32+stencil8
    // render target, which the CPU-side setDepthTest/setStencilActions state
    // machine (stage 87) defers to.
    if (depthAndStencil) defines.push('ASC_RENDER_DEPTH_STENCIL=1');
    if (!frameworks.includes('Metal')) frameworks.push('Metal');
    if (!frameworks.includes('Foundation')) frameworks.push('Foundation');
  }
  return {
    target: 'native',
    'c-compiler': 'clang',
    opt: '-O2',
    sources,
    'include-paths': includePaths,
    'link-libs': linkLibs,
    'link-paths': linkPaths,
    frameworks,
    defines,
    features,
    objects: [],
  };
}

// Font byte-stream URLs for a web build of an app whose descriptor has no
// <embedFonts> (the Starling demo ships its TrueType font as a plain data file
// under assets/fonts/ and references it by family name at runtime). Without a
// font the wasm sandbox has nothing to shape with: every requested family stays
// unresolved and all text draws as nothing. Roots are app-dir-relative paths;
// each is scanned for font files (sorted, so the manifest is deterministic).
// Family names are read by Skia from the font data itself, so a shipped
// Ubuntu-R.ttf satisfies `format.font = "Ubuntu"` with no extra mapping.
function findAppFonts(appDir: string, roots: string[]): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // a single preloaded file, or unreadable
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(resolve(abs, e.name), childRel);
      else if (/\.(ttf|otf|ttc)$/i.test(e.name)) out.push(childRel);
    }
  };
  for (const r of roots) {
    if (/\.(ttf|otf|ttc)$/i.test(r)) out.push(r);
    else walk(resolve(appDir, r), r);
  }
  return out;
}

// Escape a literal host path so emcc's `--exclude-file` matches that exact path
// and nothing else. The pattern language is fnmatch (file_packager's
// should_ignore), where `*?[` are metacharacters: passing a path through verbatim
// would make `weird[1].png` a character class that excludes the unrelated
// `weird1.png` while sparing the file it names (measured), and a font named e.g.
// `MyFont[bold].ttf` would silently delete a neighbour from the FS image. Each
// metacharacter is wrapped in a one-character class, which is how fnmatch spells
// a literal; a single pass (rather than four `replace` calls) keeps the brackets
// this introduces from being escaped again.
function escapeFnmatch(p: string): string {
  return p.replace(/[\[\]*?]/g, (c) => (c === ']' ? '[]]' : `[${c}]`));
}

// Data roots for a web build. adl resolves `File.applicationDirectory` to the
// app's install directory (the directory holding app.xml), and the native AOT
// build mirrors that by running with its CWD set there — so a program reading
// `assets/...` finds its files. The browser sandbox instead starts with an empty
// in-memory FS, so the same tree must be packed into it explicitly. This walks
// the app directory and returns every entry that is program data, i.e. everything
// EXCEPT:
//   - `src/`            the ActionScript sources this compiler translated,
//   - dotfiles          (.DS_Store and friends — never program data),
//   - `<filename>*`     this compiler's own artifacts (the generated .c, the .o,
//                       the .js/.wasm/.html sidecars, the native executable, the
//                       xcode project). AIR app descriptors name every artifact
//                       with the <filename> base, so one prefix test covers them.
// The `<content>` SWF and the descriptor itself stay in (they are part of the
// app's install directory for adl too, and tiny next to the asset tree).
//
// `outputDir` is the directory the current build writes into (-o). The
// `<filename>` prefix test above only catches artifacts named after the
// descriptor, so a build rooted anywhere else inside the app dir (the common
// `-o temp/<x>` / `-o build/<x>` shapes) would be swept in whole - packing the
// executable this very build is producing into the page's FS image (measured:
// a 24 MB native binary plus the generated .c took the root entry from 1.9 MB
// of assets to 36 MB). That is the same "this compiler's own artifacts" rule as
// the prefix test, one directory level deeper than the prefix can reach. The
// exclusion is therefore as coarse as the prefix test is: the top-level entry
// containing the output is dropped, not just the output subtree.
function findPreloadPaths(dir: string, filename: string, outputDir: string | null = null): string[] {
  // Top-level app-dir entry that contains the output, e.g. `/app/temp/web/x`
  // under `/app` -> `temp`. Null when the output is outside the app dir (then
  // there is nothing of ours to exclude) or sits directly in it (the
  // `<filename>` prefix test already covers it).
  let buildRoot: string | null = null;
  if (outputDir !== null) {
    const rel = relative(dir, outputDir);
    const first = rel.split(sep)[0];
    if (first !== '' && first !== '..' && !isAbsolute(rel)) buildRoot = first;
  }
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    if (e.name === 'src') continue;
    if (e.name === buildRoot) continue;
    if (filename !== '' && e.name.startsWith(filename)) continue;
    out.push(e.name);
  }
  return out;
}

// The `<content>` SWF and the descriptor itself stay in (they are part of the
// app's install directory for adl too, and tiny next to the asset tree).

export interface PreparedAirApp {
  info: AirAppInfo;
  mainClass: string;
  asFiles: string[];
  manifestPath: string;
  // Non-fatal problems the adapter can see but not fix (it must not silently
  // produce a build that looks fine and renders wrong). Printed by the caller.
  warnings: string[];
}

// Orchestrate the `--air-app` migration: parse the descriptor, collect every
// .as under <app.xml dir>/src, resolve the main class, and write the generated
// build manifest next to the descriptor. `web` selects the browser backend
// (--target wasm --package web) so the manifest links the right glue + libraries.
// `features` is the resolved --features set for this invocation: `null` means the
// flag was absent, so whatever the existing manifest already pins is kept (this is
// what makes a chosen enhancement survive regeneration); an array (possibly empty,
// from `--features none`) means the user has just decided, so it replaces it.
export function prepareAirApp(appXmlPath: string, mainClassOpt: string | null, vendorAbs: string, web: boolean, features: string[] | null = null, outputPath: string | null = null): PreparedAirApp {
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
      } else if (e.name.endsWith('.as')) {
        const rel = relative(srcDir, p).replace(/\\/g, '/');
        if (SKIP_FILES.has(rel)) continue;
        asFiles.push(p);
      }
    }
  };
  walk(srcDir);
  // Re-add the GreenSock core the demo reaches (present only in this example; a
  // different project without these vendored files simply gets nothing added).
  for (const rel of GREEN_SOCK_CORE) {
    const p = resolve(srcDir, rel);
    if (existsSync(p)) asFiles.push(p);
  }
  for (const rel of ADOBE_UTILS_CORE) {
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
  // Stage3D detection runs for both targets: native links stage3d_glue.mm (Metal),
  // web links stage3d_webgl.cc (WebGL2). The descriptor's <depthAndStencil> feeds
  // ASC_RENDER_DEPTH_STENCIL on both.
  const usesStage3D = detectStage3D(asFiles);
  // Browser builds get the app's data tree packed into the wasm FS (see
  // findPreloadPaths) and, when the descriptor has no <embedFonts>, a font list
  // derived from the TTFs the app itself ships. Native builds read the real
  // directory and need only the descriptor's font list.
  const preloadPaths = web ? findPreloadPaths(dir, info.filename, outputPath === null ? null : dirname(resolve(outputPath))) : [];
  const appFontUrls = web ? findAppFonts(dir, preloadPaths) : [];
  // The list airManifest actually writes: the descriptor's <embedFonts> wins, else
  // the TTFs the app itself ships. Needed here as well because the empty case is
  // exactly the silent-blank-text trap checked just below.
  const fontUrls = info.fonts.length > 0 ? info.fonts.map((f) => f.path) : appFontUrls;
  // Keep those same fonts out of the FS image: the page fetches them itself, so
  // the copy a preload root sweeps in is never read (see BuildConfig.preloadExcludes).
  const preloadExcludes = web ? fontUrls.map(escapeFnmatch) : [];
  // Networking is detected from the app's own sources (see detectNetworking).
  // Native needs the vendored static curl on disk; saying so here beats letting
  // clang report a bare "'curl/curl.h' file not found" against a path the user
  // never wrote. The failure is explicit and one command away from fixed, which
  // is the §2.5 rule applied to the build layer rather than the frontend.
  const usesNetworking = detectNetworking(asFiles);
  if (usesNetworking && !web && !existsSync(resolve(vendorAbs, 'curl', 'include', 'curl', 'curl.h'))) {
    throw new AirAppError(
      `this app uses flash.net / URLRequest, so its build must link the HTTP transport, but the static curl tree is missing:\n` +
      `  expected: ${resolve(vendorAbs, 'curl', 'include', 'curl', 'curl.h')}\n` +
      `  build it with: build-tools/curl-src/build-static.sh`
    );
  }
  // A web build that draws text but resolves no font renders blank (see
  // detectText): the generated page gets `FONT_URLS = []`, so the wasm side stays
  // on the empty font manager and every glyph disappears. That is a silent wrong
  // output, not a missing feature — §2.5 forbids shipping it quietly, so say what
  // is wrong and name the two ways to fix it. Not a hard error: the app still
  // previews correctly in every other respect (layout, bitmaps), and failing the
  // build would not make the font appear.
  const warnings: string[] = [];
  if (web && fontUrls.length === 0 && detectText(asFiles)) {
    warnings.push(
      `this app draws text (flash.text) but its web build resolves no font, so every TextField will render blank:\n` +
      `  the browser sandbox has no system fonts — a page can only use what it injects\n` +
      `  fix: drop a .ttf/.otf/.ttc under the app dir (picked up automatically), or\n` +
      `       list one under <embedFonts> in ${basename(appXmlPath)}`
    );
  }
  // Persist the enhancement choice. The manifest is regenerated in full on every
  // run (it is a build artifact derived from app.xml + the src scan), so a
  // hand-edited `features` would otherwise be wiped by the next build - which made
  // "turn SVG on" impossible to express except on the command line every time.
  // Read the previous file back and carry its set forward unless this invocation
  // said otherwise. Only `features` is carried: every other field is a function of
  // the descriptor and sources, and resurrecting a stale generated value (a
  // dropped define, an old link lib) would be a silent wrong build.
  let persistedFeatures: string[] = [];
  try {
    const prev = JSON.parse(readFileSync(manifestPath, 'utf8')) as { features?: unknown };
    if (Array.isArray(prev.features)) persistedFeatures = prev.features.filter((f): f is string => typeof f === 'string');
  } catch {
    // No readable previous manifest (first run, or it was deleted): nothing to keep.
  }
  const effectiveFeatures = features ?? persistedFeatures;
  const keptFromManifest = features === null && persistedFeatures.length > 0;

  writeFileSync(manifestPath, JSON.stringify(airManifest(vendorRel, info.visible, info.resizable, info.displayResolution === 'high', web, info.renderMode, usesStage3D, info.depthAndStencil, info.fonts, preloadPaths, preloadExcludes, appFontUrls, usesNetworking, effectiveFeatures), null, 2) + '\n');
  if (keptFromManifest) {
    // Not silent (§1.5): the artifact about to be built is NOT an AIR-identical
    // default, and the reason is a setting from a previous run.
    warnings.push(
      `enhancements carried over from ${basename(manifestPath)}: ${persistedFeatures.join(', ')}` + '\n' +
      `  these make the build an AIR superset (adl rejects the same input); run` + '\n' +
      `  \`--features none\` to clear them and get the AIR-identical default back`
    );
  }

  return { info, mainClass, asFiles, manifestPath, warnings };
}
