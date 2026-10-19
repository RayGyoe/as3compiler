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

// ---- URLRequest.method is case-insensitive on the wire (阶段一百五十四) ----
// AIR keeps whatever spelling the app assigned on the property, but normalizes
// the verb to UPPERCASE before the request leaves the process, and applies the
// SAME case-insensitive rule when deciding whether `data` goes into the query
// string or into the body. Measured on adl 51.4.1 against a local echo server
// (probe kept under temp/httpverb, not asserted here):
//
//   new URLRequest(url).method            => "GET"
//   r.method = "get";  r.method           => "get"      (property keeps the spelling)
//   method "get"/"GET" + URLVariables     => wire `GET  /p?a=1&b=x%20y` body ""
//   method "pOsT"/"PUT" + URLVariables    => wire `POST`/`PUT /p` body "a=1&b=x%20y"
//
// The two halves must not drift apart: the fold and the wire verb are decided by
// one predicate, so the fix is a single normalization at the serialization seam
// (net__prepare_request) rather than a case-insensitive strcmp at each site.
function checkRequestMethod(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [req-method] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [req-method] ${label}`); }
  };
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const prep = (() => {
    const i = emitSource.indexOf('static void net__prepare_request(URLRequest* request, net_req* r) {');
    if (i < 0) return '';
    const j = emitSource.indexOf('net_req r; net__prepare_request(request, &r);', i);
    return emitSource.slice(i, j < 0 ? i + 6000 : j);
  })();
  check('the shared serialization seam uppercases request->method',
    /as_str_toUpper\(request->method\)/.test(prep));
  check('the raw spelling never reaches the job verbatim',
    !/r->method = \(request->method != NULL\) \? request->method :/.test(prep));
  check('a request without an explicit method still defaults to GET',
    /: "GET";/.test(prep));
  check('the query/body fold tests the normalized verb',
    /if \(strcmp\(r->method, "GET"\) == 0\)/.test(prep));
  // The transport seam therefore only ever sees an uppercase verb, and its own
  // comparisons may stay literal (they would silently stop matching if the
  // normalization above were dropped).
  check('the curl seam still decides POST/GET/HEAD on the normalized verb',
    /int is_post = \(strcmp\(method, "POST"\) == 0\)/.test(RUNTIME_PREAMBLE) &&
    /else if \(strcmp\(method, "GET"\) != 0\)/.test(RUNTIME_PREAMBLE) &&
    /if \(strcmp\(method, "HEAD"\) == 0\)/.test(RUNTIME_PREAMBLE));
  check('the URLRequest ctor default matches adl ("GET")',
    /o->method = \(char\*\)"GET";/.test(emitSource));
  if (ok > 0) console.log(`[req-method] ${ok} method-normalization checks passed`);
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

  // ...and a loadBytes payload is the THIRD case, where the same rule was applied
  // one time too many: the decode freed it and nulled bytes/len, but the loader's
  // finish thunk builds the display-list SkImage from exactly those bytes. With
  // the payload gone and no URL to fall back on, bd->image stayed NULL and the
  // Bitmap painted nothing while bitmapData held correct pixels -- TalkMED's
  // graphical captcha (a JPEG handed to loadBytes) was invisible for this reason
  // even after its request started succeeding (stage 154).
  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  const emitSrc = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  check('a loadBytes payload survives its own decode',
    /int keep_encoded = \(j->kind == AS_JOB_DECODE\);/.test(pre));
  check('the loader builds its display image from that payload, file second',
    emitSrc.includes("const void* enc = as_job_bytes(job);") &&
    emitSrc.includes('if (enc != NULL && enc_len > 0) bd->image = as_skia_image_from_bytes(enc, enc_len);') &&
    emitSrc.includes('else if (li->url != NULL) bd->image = as_skia_image_from_file(li->url);'));
  check('the decode still releases a payload nobody kept',
    /if \(!keep_encoded\) \{ free\(buf\); j->bytes = NULL; j->len = 0; \}/.test(pre));

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

// ---- SharedObject local store: AIR's ".sol" container (阶段一百五十) ----
// D11 of the TalkMED diff: the store used to be a JSON file under
// <storage>/<name>.json, so an AIR session and an AOT session could not see each
// other's data. The container, the path encoding and the AMF3 payload were then
// reverse-engineered from adl (temp/solprobe2..C) and reimplemented; the two
// directions are verified against each other in temp/sotest (AOT writes -> adl
// reads, adl writes -> AOT reads, byte counts identical). Those probes live
// outside the regression set, so the SHAPE is pinned here. 阶段一百九十四 added
// the name/localPath rules AIR actually applies (temp/sotor So5..SoE, replayed
// by temp/sorow/lpcell.as: 55/55 cells identical), and the example carries the
// same cells as assertions.
function checkSharedObjectStore(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [solstore] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [solstore] ${label}`); }
  };
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const airApp = readFileSync(join(root, 'src', 'air-app.ts'), 'utf8');
  const p = RUNTIME_PREAMBLE;

  // -- how AIR derives the storage path. The name is written with ".sol" and, when
  //    it carries a slash, with a "#" prefix on its FIRST component; localPath
  //    REPLACES the <content> layer and has to be a component-prefix of it.
  //    Measured with adl 51.4.1 (temp/sotor: SoProbe/So3 for the long-name
  //    question, So5..SoE for these rules) and replayed cell-for-cell against our
  //    build by temp/sorow/lpcell.as: 55/55 cells identical, and the store trees
  //    identical for every ASCII name. Names of 32..172 characters all land as
  //    "<name>.sol" inside one directory. An earlier revision folded the name into
  //    31-byte "#"-suffixed components; that rule is not reproducible, and with it
  //    in place the AOT build and AIR kept two different files for the same shared
  //    object -- the D11 symptom this layer exists to remove.
  const so = generateC(parse('import flash.net.SharedObject;\nvar s:SharedObject = SharedObject.getLocal("k");\nvar t:SharedObject = SharedObject.getLocal("x/y", "/");\ntrace(1);\n')).c.replace(/\r\n/g, '\n');
  check('the file name is the name plus ".sol", verbatim for a single-component name',
    so.includes('static char* as_so_file_name(const char* name) {')
    && so.includes('return as_str_concat((char*)n, (char*)".sol");'));
  check('a name still holding a slash after the leading strip gets the "#" prefix',
    so.includes('if (strchr(n, \'/\') != NULL) return as_str_concat(as_str_concat((char*)"#", (char*)n), (char*)".sol");'));
  check('ONE leading "/" and one leading "./" are dropped first',
    so.includes('if (n[0] == \'/\') n++;') && so.includes('if (n[0] == \'.\' && n[1] == \'/\') n += 2;'));
  check('no length-based folding of the name survives (adl writes a 172-character name verbatim)',
    !emitSource.includes('as_so_encode_name')
    && !emitSource.includes('prefix % 30')
    && !emitSource.includes('memcpy(out + w, name + prefix, 27); w += 27;'));
  check('a name may hold slashes (AIR documents getLocal("work/addresses")), so the parent dir is made',
    emitSource.includes('static void as_so_mkparent(const char* p) {')
    && emitSource.includes('as_mkdirs(dir);'));
  check('a local object lives under #SharedObjects, then the REPLACED layer',
    so.includes('base = as_path_join(base, "#SharedObjects");')
    && so.includes('char* layer = as_so_layer(localPath);')
    && so.includes('if (layer[0] != \'\\0\') base = as_path_join(base, layer);'));
  // -- the accepted NAME set is the MEASURED one, not the documented one: every C0
  //    control plus space " # & ' , : ; < > ? \ ~, while "%", "." and 0x7F are
  //    accepted. SoA pinned WHERE it throws: getLocal, not flush.
  const nameBad = /static bool as_so_name_bad\(int c\) \{([\s\S]*?)\n\}/.exec(so)?.[1] ?? '';
  check('a C0 control or a space is a rejected name character',
    nameBad.includes('if (c <= 0x20) return true;'));
  check('…and so are quote, #, &, tick, comma, colon, semi, <, >, ?, backslash, ~',
    nameBad.includes(`strchr("\\"#&',:;<>?\\\\~", c) != NULL`));
  check('"%", "." and 0x7F are NOT rejected (measured; the documented list is wrong)',
    !nameBad.includes('%') && !nameBad.includes('.') && !/0x7f/.test(nameBad));
  check('an empty name and a rejected character raise Error #2134 with adl\'s message',
    so.includes('static void as_so_reject(void) { as_throw(Error_new((char*)"Error #2134: Cannot create SharedObject.", 2134)); }')
    && so.includes('if (name[0] == \'\\0\') as_so_reject();'));
  const getLocal = /SharedObject\* SharedObject_getLocal_static\(char\* name, char\* localPath, bool secure\) \{([\s\S]*?)\n\}/.exec(so)?.[1] ?? '';
  check('a NULL name is Error #2007 instead (adl: "Parameter name must be non-null.")',
    getLocal.includes('if (name == NULL) { as_throw(Error_new((char*)"Error #2007: Parameter name must be non-null.", 2007)); return NULL; }'));
  const checkName = /static void as_so_check_name\(const char\* name\) \{([\s\S]*?)\n\}/.exec(so)?.[1] ?? '';
  check('a name that resolves out of the layer ("../x") is rejected',
    checkName.includes("c == n && e == c + 2 && c[0] == '.' && c[1] == '.'"));
  check('…and so is an empty inner component ("x//y", "//x"), while a trailing one is kept',
    checkName.includes('if (e == c) as_so_reject();'));
  const soLayer = /static char\* as_so_layer\(const char\* localPath\) \{([\s\S]*?)\n\}/.exec(so)?.[1] ?? '';
  check('an empty localPath is NOT the same as null (adl #2134; SoD p7 vs p8)',
    soLayer.includes('if (localPath[0] == \'\\0\') as_so_reject();'));
  check('localPath is compared component-by-component against <content>',
    soLayer.includes("while (k < j - i && c[k] != '\\0' && c[k] != '/') k++;")
    && soLayer.includes('if (k != j - i || memcmp(s + i, c, k) != 0) as_so_reject();'));
  check('a bare build (no <content>) takes the layer verbatim -- the documented relaxation',
    soLayer.includes('if (ASC_SWF_PATH[0] != \'\\0\') {'));

  // -- the application id has to reach the generated C: without it every AOT app
  //    shares one Local Store, and the descriptor's <content> is the directory
  //    level AIR nests the store under. Each OS root is adl's own, measured
  //    byte-for-byte against AIR SDK 51.4.1 (see docs/*/flash-net.md).
  check('the storage dir carries the app id, defaulting to "as3aot"',
    emitSource.includes('#ifndef ASC_APP_ID')
    && emitSource.includes('#define ASC_APP_ID "as3aot"')
    && emitSource.includes('Library/Application Support/" ASC_APP_ID "/Local Store'));
  check('on Windows the store root is %APPDATA%/<id>/Local Store (adl writes the same tree)',
    emitSource.includes('char* appdata = getenv("APPDATA");')
    && emitSource.includes('base = as_path_join(appdata, ASC_APP_ID);')
    && emitSource.includes('base = as_path_join(base, "Local Store");'));
  check('a host that does not export APPDATA falls back to the known folder default',
    emitSource.includes('if (appdata == NULL || *appdata ==')
    && emitSource.includes('appdata = as_path_join(home, "AppData/Roaming");'));
  const winRoot = emitSource.indexOf('char* appdata = getenv("APPDATA");');
  const macRoot = emitSource.indexOf('Library/Application Support/" ASC_APP_ID');
  check('the Windows root is a sibling #elif of the macOS one, not a fallthrough',
    winRoot > 0 && macRoot > winRoot
    && emitSource.slice(winRoot, macRoot).includes('#elif defined(__APPLE__)'));
  check('a POSIX host with no AIR path to copy keeps the ~/.as3aot convention',
    emitSource.includes('base = as_path_join(home, ".as3aot");')
    && emitSource.includes('base = as_path_join(base, ASC_APP_ID);'));
  check('the descriptor content path reaches the generated C too',
    emitSource.includes('#ifndef ASC_SWF_PATH') && emitSource.includes('#define ASC_SWF_PATH ""'));
  check('an AIR descriptor build injects both defines',
    airApp.includes('ASC_APP_ID="${info.id}"') && airApp.includes('ASC_SWF_PATH="${info.content}"'));

  // -- the container: 00 BF | be32(fileSize-6) | "TCSO" | u16 4 | u32 0 |
  //    u16 nameLen | name | 00 00 00 03 | ( U29S key | AMF3 value | 00 )*
  check('the reader accepts only AIR\'s magic, length and TCSO tag',
    emitSource.includes('if (len < 24 || buf[0] != 0x00 || buf[1] != 0xBF || memcmp(buf + 6, "TCSO", 4) != 0) return;')
    && emitSource.includes('unsigned nameLen = (unsigned)((buf[16] << 8) | buf[17]);')
    && emitSource.includes('size_t pos = 18 + (size_t)nameLen + 4;'));
  check('the writer emits the same fixed header (version 4 in the low byte of the u16)',
    emitSource.includes('as_amfb_byte(&w.out, 0x00);')
    && emitSource.includes('as_amfb_byte(&w.out, 0xBF);')
    && emitSource.includes('as_amfb_bytes(&w.out, (const unsigned char*)"TCSO", 4);')
    && emitSource.includes('as_amfb_byte(&w.out, 0x00);') && emitSource.includes('as_amfb_byte(&w.out, 0x04);'));
  const word3 = emitSource.indexOf('as_amfb_byte(&w.out, 0x03);');
  const beforeWord = word3 < 0 ? '' : emitSource.slice(Math.max(0, word3 - 200), word3);
  check('the entry list opens with adl\'s 00 00 00 03 word',
    beforeWord.split('as_amfb_byte(&w.out, 0x00);').length - 1 === 3);
  check('the payload length is patched into bytes 2..5 (fileSize - 6)',
    emitSource.includes('unsigned payload = (unsigned)(w.out.len - 6);')
    && emitSource.includes('w.out.b[2] = (unsigned char)((payload >> 24) & 0xFFu);')
    && emitSource.includes('w.out.b[5] = (unsigned char)(payload & 0xFFu);'));
  check('one AMF3 writer spans every entry, so repeated strings become references like adl\'s',
    emitSource.includes('as_amf3_wstr_body(&w, key);') && emitSource.includes('as_amf3_wvalue(&w, o->_data->vals[i]);'));
  check('a missing/corrupt file leaves the table empty instead of failing',
    emitSource.includes('unsigned char* buf = as_so_load_bytes(path, &len);')
    && emitSource.includes('if (buf != NULL) as_so_read_entries(o, buf, len);'));
  check('size is 0 for an empty table and the serialized byte count otherwise',
    emitSource.includes('if (o->_data->length == 0) return 0;')
    && emitSource.includes('unsigned char* buf = as_so_serialize(o, &len);'));
  check('flush writes the serialized bytes and clear() removes the file',
    emitSource.includes('FILE* f = fopen(o->path, "wb");') && emitSource.includes('remove(o->path);'));

  // -- the AMF3 string table is shared by every entry, and AIR enters BOTH a
  //    string VALUE and a dynamic property NAME into it. The end-of-members
  //    marker is the one exception: a raw literal that takes no slot (measured:
  //    temp/solprobeC). Interning the terminator shifted every later index by one,
  //    which is exactly how adl read a repeated value back as the wrong string.
  //    Skipping the NAMES, on the other hand, made the reader run off the end of
  //    its own table: on temp/solread/adl-login-2617.sol the value of "email" is
  //    the reference 14, the empty string only once accessToken..realname hold
  //    slots 1..13. 阶段一百五十七: the object was then dropped half-way and
  //    every LATER entry was abandoned, so refresh_token_timer read back as
  //    undefined, LoginView's `now < Number(...)` became NaN, and the app cleared
  //    the session on every launch.
  check('the dynamic end marker is written without entering the string table',
    p.includes('static void as_amf3_wstr_endmark(as_amf3w* w) {')
    && /static void as_amf3_wstr_endmark\(as_amf3w\* w\) \{\n\s*as_amfb_u29\(&w->out, 1\);/.test(p));
  const endmarkReader = /static char\* as_amfr_str_endmark\(as_amf3r\* r\) \{([\s\S]*?)\n\}/.exec(p)?.[1] ?? '';
  check('a NON-empty dynamic property name does take a slot, as AIR writes it',
    endmarkReader.includes('if (n > 0) as_amfr_addstr(r, s);'));
  check('…while the empty terminator itself still takes no slot',
    endmarkReader.includes('if (n > 0) as_amfr_addstr(r, s);')
    && !/if \(n == 0\) as_amfr_addstr/.test(endmarkReader));
  const rawWriter = /static void as_amf3_wstr_raw\(as_amf3w\* w, char\* s\) \{([\s\S]*?)\n\}/.exec(p)?.[1] ?? '';
  check('the writer and reader agree: a dynamic key goes through the interning U29S',
    rawWriter.includes('as_amf3_wstr_body(w, s);')
    && p.includes('as_amf3_wstr_raw(w, o->keys[i]);'));
  check('the object path no longer interns the terminator through as_amf3_wstr_raw',
    !/\n        as_amf3_wstr_raw\(w, \(char\*\)""\);\n    \}/.test(p));
  // The example carries the same rule as bytes: a hand-built AIR-shaped stream
  // whose "gamma" holds a reference to the earlier NAME "alpha".
  const soExample = readFileSync(join(dir, 'sharedobject.as'), 'utf8');
  check('examples/sharedobject.as pins the hand-built stream (marker 0A, U29O 0B, reference 06 02)',
    soExample.includes('dyn.writeByte(0x0A);')
    && soExample.includes('dyn.writeByte(0x0B);')
    && soExample.includes('dyn.writeByte(0x06); dyn.writeByte(1 << 1);')
    && soExample.includes('a reference to an earlier dynamic NAME resolves'));
  check('…and names the measured AIR evidence it replays',
    soExample.includes('temp/solread/adl-login-2617.sol') && soExample.includes('clearLoginSession'));
  check('…and examples/sharedobject.as pins the "#" prefix of a slashed name',
    soExample.includes('solPath("#sp/leaf").exists')
    && soExample.includes('solPath("#trail/").exists')
    && soExample.includes('a leading slash is dropped from the name'));
  check('…the REJECTED character set (space included, % and . not)',
    soExample.includes('expect(rejects("has space")')
    && soExample.includes('expect(rejects("has\\\\bs")')
    && soExample.includes('!rejects("has%pc") && !rejects("has.dot")'));
  check('…and the null-vs-empty localPath boundary plus Error #2007',
    soExample.includes('expect(lpRejects(""), "an empty localPath is NOT null')
    && soExample.includes('nullId == 2007'));

  // -- the EMPTY string is the second thing that never takes a slot. AIR writes
  //    `06 01` every single time, so a reader/writer that enters "" on the first
  //    occurrence shifts every later reference by one. Measured on
  //    temp/solread/adl-login-2617.sol: the four empty values in userInfo are all
  //    literals, and interning "" made adl read an AOT store's "email":"" back as
  //    "mobile" and drop the company objects' "title"/"app_menu" keys.
  const wstrBody = /static void as_amf3_wstr_body\(as_amf3w\* w, char\* s\) \{([\s\S]*?)\n\}/.exec(p)?.[1] ?? '';
  check('the writer emits an empty string as a literal every time (no slot)',
    /if \(n == 0\) \{ as_amfb_u29\(&w->out, 1u\); return; \}/.test(wstrBody));
  check('…and only a NON-empty literal joins the writer\'s table',
    wstrBody.includes('as_amf3w_addstr(w, s);')
    && wstrBody.indexOf('if (n == 0)') < wstrBody.indexOf('as_amf3w_addstr(w, s);'));
  const strBodyReader = /static char\* as_amfr_str_body\(as_amf3r\* r\) \{([\s\S]*?)\n\}/.exec(p)?.[1] ?? '';
  check('the reader mirrors it: an empty literal does not take a slot',
    strBodyReader.includes('if (n > 0) as_amfr_addstr(r, s);')
    && !/^\s*as_amfr_addstr\(r, s\);$/m.test(strBodyReader));
  check('…and examples/sharedobject.as pins the repeated-empty-string rule as bytes',
    soExample.includes("emp.writeByte(0x06); emp.writeByte(0x01);")
    && soExample.includes('emp.writeByte(3 << 1);')
    && soExample.includes('an empty literal takes no slot, so a later reference still resolves'));

  if (ok > 0) console.log(`[solstore] ${ok} SharedObject-store checks passed`);
  return bad;
}

registerGroup('unit: transport/IoErrorFidelity', checkIoErrorFidelity);
registerGroup('unit: transport/HttpStatusTerminal', checkHttpStatusTerminal);
registerGroup('unit: transport/AirAppTransport', checkAirAppTransport);
registerGroup('unit: transport/WebTransport', checkWebTransport);
registerGroup('unit: transport/RequestContentType', checkRequestContentType);
registerGroup('unit: transport/RequestMethod', checkRequestMethod);
registerGroup('unit: transport/JobOwnership', checkJobOwnership);
registerGroup('unit: transport/SharedObjectStore', checkSharedObjectStore);
