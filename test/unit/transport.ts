// Unit checks: IO/HTTP error fidelity + --air-app / web transport.
// Moved verbatim out of the single-file test.ts (阶段九十六·一); each group
// still returns the list of failed labels and is registered as one node:test
// case, so it can be re-run alone with:
//   node --test --test-name-pattern='transport/' test/unit/*.ts

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { lex } from '../../src/lexer.ts';
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { defaultBuildConfig, loadManifest, applyManifest, applyManifestOverlay, buildCompileCommand, buildCompileSteps, buildWebCompileSteps, effectiveDefines, validateFeatures, knownFeatures } from '../../src/build.ts';
import type { BuildConfig, Target, Manifest } from '../../src/build.ts';
import { airManifest, prepareAirApp } from '../../src/air-app.ts';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root, dir, EXAMPLE_TIMEOUT_MS } from '../harness.ts';

// ---- ioError fidelity: AIR's NUMBER and sentence per failure (阶段八十九·五十九) ----
// The examples pin the two failures that can be produced offline (a missing local
// file -> Loader #2035 / URLLoader #2032, an undecodable local payload -> Loader
// #2124). The remaining two rows of AIR's matrix need a real network — a
// transport failure and a 4xx response — so they are pinned here, STRUCTURALLY,
// on the runtime preamble and the emitter. Every pair below was measured on adl
// 51.4.1 against the same input; the matrix is docs/zh-cn/flash-net.md §6.7.5.
// Before this stage every internally generated ioError carried errorID 0 and a
// hand-written sentence, which is untestable for a caller that switches on the
// number.
function checkIoErrorFidelity(): string[] {
  let ok = 0;
  const bad: string[] = [];
  // The emitter is read as text: the assertions below are about the shape of the
  // generated C, and no example can reach the two network-only failure kinds.
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [ioerror] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [ioerror] ${label}`); }
  };
  const p = RUNTIME_PREAMBLE;
  const slice = (from: string, to: string, fallback: number): string => {
    const i = p.indexOf(from);
    if (i < 0) return '';
    const j = p.indexOf(to, i + from.length);
    return p.slice(i, j < 0 ? i + fallback : j);
  };

  // The four measured sentences, verbatim. A typo here is a text a caller that
  // greps (instead of reading errorID) silently stops matching.
  check('the 2032 sentence is AIR verbatim', p.includes('case 2032: desc = "Stream Error";'));
  check('the 2035 sentence is AIR verbatim', p.includes('case 2035: desc = "URL Not Found";'));
  check('the 2036 sentence is AIR verbatim', p.includes('case 2036: desc = "Load Never Completed";'));
  check('the 2124 sentence is AIR verbatim',
    p.includes('case 2124: desc = "Loaded file is an unknown type";'));

  // AIR's text is the number's sentence plus the offending URL — both fields, in
  // that order, on one line. Dropping the URL would leave a failure with no
  // subject; dropping the number would make the text un-greppable.
  const fmt = slice('static char* as_ioerror_text', 'static int as_job_loader_ioerror_id', 2000);
  check('the text is "Error #N: <sentence>. URL: <url>"',
    fmt.includes('"Error #%d: %s. URL: %s"') && fmt.includes('id, desc, u'));

  // The Loader classifier is the part that cannot be derived from the job's error
  // kind: a 4xx body ALSO fails the decode, and AIR calls that "Load Never
  // Completed" (2036), not "unknown type" (2124). The status is what separates
  // them, so a classifier that ignored it would report 2124 for every 404 — the
  // exact defect this pins.
  const cls = slice('static int as_job_loader_ioerror_id', 'static void* as_job_pixels', 1200);
  check('a 4xx decode failure is 2036, not 2124 (the status decides)',
    /AS_JOB_ERR_DECODE\)\s*return\s*\(j->status >= 400\)\s*\?\s*2036\s*:\s*2124/.test(cls));
  check('a local read failure is 2035 and a remote one 2036',
    /as_job_is_remote_url\(j->path\)\s*\?\s*2036\s*:\s*2035/.test(cls));
  check('the build-level transport gap keeps no AIR number',
    /AS_JOB_ERR_UNSUPPORTED\)\s*return\s*0/.test(cls));

  // All three event-raising sites must WRITE the number: the constructor leaves
  // errorID 0 (correct for `new IOErrorEvent(...)`, wrong for a runtime-generated
  // one), so a site that forgets the assignment silently ships id 0 again.
  // Four sites now: URLLoader, URLStream, the Loader classifier, and Sound.load
  // (stage 96, measured on adl round 10 -- a failed or undecodable Sound.load
  // reports 2032 like the other transports). The count is deliberately exact: a
  // new transport that dispatches an ioError must come here and prove it carries a
  // number, which is how Sound.load's own id=0 defect was caught.
  check('every dispatched ioError carries its number',
    (emitSource.match(/ev->errorID = eid;/g) ?? []).length === 5);
  check('…and each gets the number from the AIR classifier/constant',
    emitSource.includes('as_job_loader_ioerror_id(job)') &&
    (emitSource.match(/AS_JOB_ERR_UNSUPPORTED\) \? 0 : 2032;/g) ?? []).length === 3);

  if (ok > 0) console.log(`[ioerror] ${ok} ioError fidelity checks passed`);
  return bad;
}

// ---- Non-2xx terminal state: the caller's HTTP_RESPONSE_STATUS listener decides
// (阶段八十九·六十二). The whole matrix was measured with a controlled probe — one
// server, one URL, and the listener as the ONLY variable — in
// temp/httpstatus-probe; the AOT probe (temp/httpstatus-aot) reproduces all 12
// cases byte-for-byte. What is pinned here is the shape of the emitted C, because
// no offline example can reach a 4xx without a server.
function checkHttpStatusTerminal(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [httpstatus] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [httpstatus] ${label}`); }
  };

  // Both terminals (URLLoader__finish and URLStream__finish) must make the same
  // decision; a rule applied to only one of them is the same class of defect as
  // the ioError number that was written on one site but not the others. The three
  // assertions are kept independent on purpose (who consults the listener; what
  // the threshold is; which direction the test goes), so one wrong mutation cannot
  // hide behind another.
  const consult = emitSource.match(/EventDispatcher_hasEventListener\(\(void\*\)o, \(char\*\)"httpResponseStatus"\)/g) ?? [];
  check('both terminals consult the caller\'s listener (URLLoader + URLStream)', consult.length === 2);

  // The threshold is >= 300, not >= 400: a 302 that is not followed splits the
  // same way (case F/G), so a 4xx-only test would silently complete a redirect
  // that AIR reports as an ioError.
  check('the threshold is >= 300 (an unfollowed 302 splits too)',
    (emitSource.match(/st >= 300/g) ?? []).length === 2);

  // The discriminator is the ABSENCE of the listener: with one registered the
  // error body completes (cases A/C/F), without one it ends in ioError (B/D/G).
  check('…and the branch is taken when the listener is ABSENT',
    (emitSource.match(/!EventDispatcher_hasEventListener\(\(void\*\)o, \(char\*\)"httpResponseStatus"\)/g) ?? []).length === 2);

  // The ioError it raises carries AIR's number AND sentence, through the same
  // formatter the rest of flash.net uses — a bare id or a hand-written sentence
  // would make the failure untestable for a caller that switches on the number.
  const errs = emitSource.match(/IOErrorEvent_new\(\(char\*\)"ioError", false, false, as_ioerror_text\(as_job_path\(job\), 2032, NULL\)\)/g) ?? [];
  check('the split dispatches AIR-verbatim #2032 (number + sentence + URL)', errs.length === 2);
  check('…and stamps the number on the event',
    (emitSource.match(/ev->errorID = 2032;/g) ?? []).length === 2);

  // Zero-length body: AIR dispatches no PROGRESS at all (cases I/J), so the
  // terminal progress needs a total > 0 guard on both terminals.
  check('a zero-length body emits no terminal PROGRESS',
    (emitSource.match(/if \(total > 0 && \(as_job_marks_sent\(job\) == 0/g) ?? []).length === 2);

  if (ok > 0) console.log(`[httpstatus] ${ok} non-2xx terminal checks passed`);
  return bad;
}

// ---- --air-app transport auto-detection (阶段八十九·五十五) ----
// `--air-app` REGENERATES <filename>.build.json on every run, so "just edit the
// manifest to add curl" cannot survive a rebuild: the link set has to come from
// the generator. A remote URL with no transport backend still compiles and runs
// (the async job table reports AS_JOB_ERR_UNSUPPORTED) but every load ends in
// ioError — the "网络访问都是 ioError" symptom — so the detector is pinned here on
// the sources themselves. Fixtures live under temp/ (this suite's scratch dir):
// a descriptor + src/ is an *input to the adapter*, not an AS3 program, and
// putting it under examples/ would make the example suite compile and run it.
function checkAirAppTransport(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [air-app] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [air-app] ${label}`); }
  };
  const base = join(root, 'temp', 'air-app-transport');
  const descriptor = (filename: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<application xmlns="http://ns.adobe.com/air/application/51.0">\n` +
    `  <id>com.example.${filename}</id>\n  <filename>${filename}</filename>\n` +
    `  <initialWindow><content>main.swf</content><visible>true</visible>` +
    `<width>400</width><height>400</height></initialWindow>\n</application>\n`;
  // One app that touches the network (URLRequest is the marker every networked
  // path in the AS3 API takes) and one that cannot possibly do so while still
  // importing from `flash.net` — SharedObject lives in that package and never
  // touches the HTTP seam, so matching the package name instead of the class would
  // both over-link curl and hard-fail on a machine without vendor/curl.
  const apps: [string, string][] = [
    ['net', '  import flash.net.URLLoader;\n  import flash.net.URLRequest;\n' +
            '  public class Main extends Sprite {\n' +
            '    public function Main() { new URLLoader().load(new URLRequest("https://example.com/x.json")); }\n  }'],
    ['plain', '  import flash.net.SharedObject;\n' +
              '  public class Main extends Sprite {\n' +
              '    public function Main() { trace(SharedObject.getLocal("k")); }\n  }'],
  ];
  const manifestOf = (name: string, extra: string[]): Record<string, unknown> => {
    const dir = join(base, name);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, `${name}-app.xml`), descriptor(name));
    writeFileSync(join(dir, 'src', 'Main.as'),
      'package {\n  import flash.display.Sprite;\n' + apps.find((a) => a[0] === name)![1] + '\n}\n');
    execFileSync('node', ['src/index.ts', '--air-app', join(dir, `${name}-app.xml`),
      '--main-class', 'Main', ...extra, '--dry'], { cwd: root, stdio: 'pipe', timeout: EXAMPLE_TIMEOUT_MS });
    return JSON.parse(readFileSync(join(dir, `${name}.build.json`), 'utf8')) as Record<string, unknown>;
  };
  const list = (m: Record<string, unknown>, k: string): string[] => (m[k] as string[]) ?? [];

  const netNative = manifestOf('net', ['--target', 'native']);
  check('a networked app links curl', list(netNative, 'link-libs').includes('curl'));
  check('a networked app links nghttp2 (curl\'s HTTP/2 framing)', list(netNative, 'link-libs').includes('nghttp2'));
  check('a networked app defines ASC_HAVE_CURL', list(netNative, 'defines').includes('ASC_HAVE_CURL=1'));
  check('a networked app adds curl\'s include path',
    list(netNative, 'include-paths').some((p) => p.endsWith('vendor/curl/include')));
  check('a networked app adds curl\'s static lib path',
    list(netNative, 'link-paths').some((p) => p.endsWith('vendor/curl/lib/macos-arm64')));
  check('a networked app links curl\'s TLS + proxy frameworks',
    list(netNative, 'frameworks').includes('Security') && list(netNative, 'frameworks').includes('SystemConfiguration'));

  const netWeb = airManifest('../../vendor', true, true, true, true, 'auto', false, false, [], [], [], [], true) as Record<string, unknown>;
  check('the web build defines ASC_HAVE_FETCH instead', list(netWeb, 'defines').includes('ASC_HAVE_FETCH=1'));
  check('the web build links no curl (wasm-ld cannot)',
    !list(netWeb, 'link-libs').includes('curl') && !list(netWeb, 'defines').includes('ASC_HAVE_CURL=1'));
  // The web manifest is asserted through the pure generator rather than the CLI:
  // `--package web` probes for emcc before the dry-run check, and pinning a local
  // emsdk path in the suite would hardcode one machine's SDK location.
  const plainWeb = airManifest('../../vendor', true, true, true, true, 'auto', false, false, [], [], [], [], false) as Record<string, unknown>;
  check('a non-networked web build gets no fetch backend', !list(plainWeb, 'defines').includes('ASC_HAVE_FETCH=1'));

  const plain = manifestOf('plain', ['--target', 'native']);
  check('a non-networked app is not given curl (even importing from flash.net)',
    !list(plain, 'link-libs').includes('curl') && !list(plain, 'defines').includes('ASC_HAVE_CURL=1'));

  if (ok > 0) console.log(`[air-app] ${ok} transport checks passed`);
  return bad;
}

// ---- web-target transport gaps (阶段八十九·五十六) ----
// The suite cannot RUN a web build (that needs emcc and a browser, and pinning an
// emsdk path would hardcode one machine's SDK), so these two defects are pinned
// STRUCTURALLY, on the runtime preamble the generated C is assembled from. Both
// were silent -- the app compiled, ran, and reported a plausible but wrong
// failure -- and both are contracts rather than code shapes, so the assertions
// name the contract: a remote image must have a browser transport, and the
// browser must be told the request's content type.
function checkWebTransport(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [web] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [web] ${label}`); }
  };
  const p = RUNTIME_PREAMBLE;
  // Bounded slices: search from a stable anchor to the next landmark so an
  // assertion can never be satisfied by an unrelated occurrence elsewhere.
  const slice = (from: string, to: string, fallback: number): string => {
    const i = p.indexOf(from);
    if (i < 0) return '';
    const j = p.indexOf(to, i + from.length);
    return p.slice(i, j < 0 ? i + fallback : j);
  };

  // (1) A remote image must be STARTED by the web backend, not reported as a
  // missing transport. Before 八十九·五十六 the AS_JOB_IMAGE_URL case was
  // compiled for the curl backend only, so on web every remote Loader.load ended
  // in "network URLs are not supported in this build" -- the build HAS a
  // transport, it just never got to use it.
  const imageCase = slice('case AS_JOB_IMAGE_URL', '} else if (j->kind == AS_JOB_IMAGE)', 2000);
  check('a remote image load has a browser transport (not only curl)',
    /ASC_HTTP_WEB/.test(imageCase) && /as_http_run\(j\)/.test(imageCase));

  // (2) The browser must be given the request's content type. fetch invents none
  // for the Uint8Array body this backend passes, so without this
  // URLRequest.contentType never reaches the server (measured against the real
  // endpoint: the same JSON login POST is answered "platform ... is required"),
  // while the curl backend has always sent it as a header.
  const glue = slice('EM_JS(void, as_web_fetch_go', 'EM_JS(void, as_web_fetch_stop', 4000);
  check('the web fetch sends URLRequest.contentType as a Content-Type header',
    /headers\['Content-Type'\]/.test(glue) && /ctype/.test(glue));
  check('both transfer entry points (URLLoader and URLStream) declare it',
    (p.match(/as_http_effective_ctype\(j\),/g) ?? []).length === 2);

  // (3) A remote image's payload must be decoded before its thunk reads it. The
  // decode normally happens inside as_job_run, but on web that call only STARTS
  // the fetch, so the pump has to stage the pixels the thunk turns into a
  // BitmapData -- otherwise the load "completes" with an empty Bitmap.
  const pump = slice('static int as_web_fetch_pump', 'static void as_http_run', 6000);
  check('the web pump decodes a remote image payload before its thunk runs',
    /AS_JOB_IMAGE_URL/.test(pump) && /as_skia_image_decode_bytes_argb/.test(pump));

  if (ok > 0) console.log(`[web] ${ok} transport checks passed`);
  return bad;
}

// ---- URLRequest.contentType is TWO different things (阶段八十九·六十九) ----
// adl returns NULL for a fresh URLRequest, while the AS3 reference prints
// "application/x-www-form-urlencoded" as its default value -- that string is the
// Content-Type adl puts on the WIRE for a request that carries a body and declared
// none (capture-server measurement in runtime.ts next to the helper). Stage 89·48
// took the documentation at face value and wrote the MIME string into the
// property; the property then disagreed with AIR, and examples/air-native -- the
// one example that RUNS the assertion rather than merely compiling it -- died in
// 53 ms on the mismatch, before its window was ever drawn. Hence two pins: the
// property default, and the fact that every "default" assertion in the examples
// agrees with it (the example the doc change had missed is exactly what a
// compiler-side pin must be able to see).
function checkRequestContentType(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [req-ctype] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [req-ctype] ${label}`); }
  };
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  check('a fresh URLRequest leaves contentType NULL (adl-measured)',
    /o->contentType = NULL;/.test(emitSource) &&
    !/o->contentType = \(char\*\)"application\/x-www-form-urlencoded";/.test(emitSource));

  // The wire rule, shared by both backends: a body-carrying request without an
  // explicit (non-empty) content type still goes out urlencoded.
  const eff = (() => {
    const p = RUNTIME_PREAMBLE;
    const i = p.indexOf('static const char* as_http_effective_ctype');
    if (i < 0) return '';
    const j = p.indexOf('\n}', i);
    return p.slice(i, j < 0 ? i + 900 : j);
  })();
  check('the URLRequest ctor keeps an explicitly empty string as-is',
    /if \(j->content_type != NULL && j->content_type\[0\] != '\\0'\) return j->content_type;/.test(eff));
  check('a body-carrying request defaults to urlencoded, a bodyless one sends none',
    /if \(j->body == NULL \|\| j->body_len == 0\) return NULL;/.test(eff) &&
    /return "application\/x-www-form-urlencoded";/.test(eff));
  check('the curl backend uses that rule instead of reading the raw field',
    /const char\* ctype = as_http_effective_ctype\(j\);/.test(RUNTIME_PREAMBLE));
  // libcurl invents a Content-Type for every POST, so a bodyless POST needs the
  // library default switched off to match adl's header-less request.
  check('the curl backend suppresses libcurl\'s invented Content-Type',
    /curl_slist_append\(hdrs, "Content-Type:"\)/.test(RUNTIME_PREAMBLE));

  // Every example assertion that names the DEFAULT must agree with the emission
  // above. Only examples/*.as is scanned: these are the files that both document
  // the behaviour and get run.
  const mismatched: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.as')) continue;
      for (const line of readFileSync(full, 'utf8').split('\n')) {
        const m = /contentType\s*==\s*([^,;)]+)/.exec(line);
        if (!m) continue;
        if (!/default/i.test(line)) continue;
        if (m[1].trim() !== 'null') mismatched.push(`${full.replace(root + '/', '')}: ${line.trim()}`);
      }
    }
  };
  walk(join(root, 'examples'));
  check('every example that asserts contentType\'s default asserts null',
    mismatched.length === 0 || (console.log('       ' + mismatched.join('\n       ')), false));

  if (ok > 0) console.log(`[req-ctype] ${ok} request-default checks passed`);
  return bad;
}

// ---- who owns a staged job result (阶段八十九·七十) ----
// The async job table has TWO ownership rules and they are opposites, so the
// wrong one is invisible until a resource is destroyed twice:
//
//   HANDLE (AS_JOB_FS_OPEN)  the FILE* becomes the AS3 FileStream's. The thunk
//                            must TAKE it out of the job, because as_job_retire
//                            closes whatever the job still holds and the app
//                            closes the stream itself (air-native's FileDemos
//                            does it from its own COMPLETE listener).
//   BYTES/PIXELS             the thunk COPIES into the GC heap; the job keeps
//                            its malloc'd buffer and releases it on retire.
//
// The defect was the first rule done as the second: `o->_handle =
// as_job_handle(job)` handed AS3 a COPY and left the job pointing at the same
// FILE*, so retire fclose()d an already-closed stream. The browser reported it
// (`Uncaught RuntimeError: table index is out of bounds`, symbolised as
// `fclose <- as_job_retire <- Stage_dispatchFrame` -- emscripten's fclose ends
// in an indirect call through the stream's own function pointer, and the freed
// stream no longer holds a valid table index); native corrupts the heap in
// silence, so no example run can catch it. Pinned on the GENERATED C rather than
// on the emitter's source text: a getter and a take read the same at a glance.
function checkJobOwnership(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [job-owner] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [job-owner] ${label}`); }
  };

  const c = generateC(parse(
    'import flash.filesystem.File;\n' +
    'import flash.filesystem.FileStream;\n' +
    'import flash.filesystem.FileMode;\n' +
    'var s:FileStream = new FileStream();\n' +
    's.openAsync(File.applicationStorageDirectory.resolvePath("x.txt"), FileMode.READ);\n'
  )).c;

  check('an openAsync program emits the file-open thunk', c.includes('FileStream__openFinish'));
  check('that thunk TAKES the handle out of the job (one owner for the FILE*)',
    c.includes('o->_handle = as_job_take_handle(job);'));
  check('no copying getter for the job handle exists to fall back to',
    !c.includes('as_job_handle('));
  check('the take clears the field, so retire cannot close it a second time',
    /static void\* as_job_take_handle\(void\* job\) \{\s*as_job\* j = \(as_job\*\)job;\s*void\* h = j->handle;\s*j->handle = NULL;\s*return h;/.test(
      RUNTIME_PREAMBLE.replace(/\r\n/g, '\n')));

  // The other half of the mechanism must stay: a job whose thunk never ran (a
  // superseded openAsync) still owns its handle, and retire is the only thing
  // left to close it. Removing that would leak a descriptor per superseded open.
  check('retire still closes a handle the job kept for itself',
    /if \(j->kind == AS_JOB_FS_OPEN && j->handle != NULL\) \{\s*fclose\(\(FILE\*\)j->handle\);/.test(
      RUNTIME_PREAMBLE.replace(/\r\n/g, '\n')));

  // ...and the OPPOSITE rule for decoded images must not be "fixed" into the
  // same shape: bytes/pixels are copied, the job releases its own buffer.
  const retired = (() => {
    const i = RUNTIME_PREAMBLE.indexOf('static void as_job_retire(as_job* j) {');
    if (i < 0) return '';
    const j = RUNTIME_PREAMBLE.indexOf('\n}', i);
    return RUNTIME_PREAMBLE.slice(i, j < 0 ? i + 900 : j);
  })();
  check('a decoded bitmap is still COPIED, not handed over',
    c.includes('memcpy(gcpx, px,') && !c.includes('bd->pixels = (void*)px;'));
  check('the job still owns and frees its staged buffers',
    /free\(\(void\*\)j->bytes\);/.test(retired) && /free\(j->pixels\);/.test(retired));

  // The example that reproduced the crash must keep reproducing it: it is the
  // close() from the app's own COMPLETE listener that makes the second fclose a
  // double close. Without it the pin above passes on a build that cannot fail.
  const demos = readFileSync(join(root, 'examples', 'air-native', 'src', 'demo', 'FileDemos.as'), 'utf8');
  const complete = (() => {
    const i = demos.indexOf('function onAsyncComplete');
    return i < 0 ? '' : demos.slice(i, i + 400);
  })();
  check('the reproducing example opens asynchronously', /openAsync\(af, FileMode\.READ\)/.test(demos));
  check('...and closes the stream itself when COMPLETE arrives',
    /asyncStream\.close\(\)/.test(complete));

  if (ok > 0) console.log(`[job-owner] ${ok} job-ownership checks passed`);
  return bad;
}

registerGroup('unit: transport/IoErrorFidelity', checkIoErrorFidelity);
registerGroup('unit: transport/HttpStatusTerminal', checkHttpStatusTerminal);
registerGroup('unit: transport/AirAppTransport', checkAirAppTransport);
registerGroup('unit: transport/WebTransport', checkWebTransport);
registerGroup('unit: transport/RequestContentType', checkRequestContentType);
registerGroup('unit: transport/JobOwnership', checkJobOwnership);
