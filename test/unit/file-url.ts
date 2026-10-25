// Unit checks: File.url / URL -> native path (阶段二百八十四).
//
// The behavioural contract lives in examples/file-url.as (and, for the decode
// itself, in temp/urlprobe/ against adl). What the example cannot catch is the
// SHAPE of the fix: the whole bug was four entry points each carrying their own
// idea of how a URL becomes a path, so the regression to guard is a new private
// "strip the scheme" site appearing somewhere. These pins read the generated C
// and the runtime preamble and assert that there is exactly one mapping and that
// every local read goes through it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { registerGroup, root } from '../harness.ts';

// Smallest program that still drags in the file/URL surface.
const PROG = `
import flash.display.Loader;
import flash.filesystem.File;
import flash.net.URLLoader;
import flash.net.URLRequest;
var f:File = File.applicationStorageDirectory.resolvePath("a.png");
trace(f.url);
var l:Loader = new Loader();
l.load(new URLRequest(f.url));
var u:URLLoader = new URLLoader();
u.load(new URLRequest(f.url));
`;

function checkMapping(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [fileurl] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [fileurl] ${label}`); }
  };

  const c = generateC(parse(PROG)).c;
  const count = (needle: string): number => c.split(needle).length - 1;

  // ---- one mapping, defined once ----
  check('as_local_path_from_url is defined exactly once',
    count('static char* as_local_path_from_url(const char* url) {') === 1);
  check('it handles all three schemes',
    c.includes('strncmp(url, "app-storage:", 12) == 0') &&
    c.includes('strncmp(url, "app:", 4) == 0') &&
    c.includes('strncmp(url, "file://", 7) == 0'));

  // ---- no entry point keeps its own scheme strip ----
  // The pre-fix shape was `if (strncmp(path, "file://", 7) == 0) path += 7;` in
  // Loader, URLLoader (and a bare `path = url` in the image job). A pointer bump
  // is the fingerprint of that drift, whatever the scheme string looks like.
  check('no `path += 7` scheme strip survives', count('path += 7') === 0);

  // ---- File.url: the two app roots, then file:/// ----
  check('File_get_url maps the storage root to app-storage:/',
    c.includes('(char*)"app-storage:/"'));
  check('File_get_url maps the application root to app:/',
    c.includes('(char*)"app:/"'));
  check('File_get_url percent-encodes the path part',
    c.includes('as_file_url_encode(') && c.includes('as_uri_encode(fwd, "-_.!~*\'()/:")'));
  check('File_get_url normalizes backslashes to slashes before encoding',
    c.includes("(s[i] == '\\\\') ? '/' : s[i]"));
  check('an absolute path outside the roots becomes file:///',
    c.includes('(char*)"file:///"'));

  // ---- the constructor decodes a URL back to a native path ----
  check('File_ctor accepts a URL',
    c.includes('path = as_local_path_from_url(path);'));

  // ---- nativePath is the OS spelling, on the one join point ----
  check('as_path_join goes through the single normalizer',
    count('return as_path_norm(as_str_concat(as_str_concat(a, "/"), b));') === 1);
  check('as_path_norm is a no-op off Windows',
    c.includes('#else') && c.includes('return (char*)p;'));

  // ---- the decoder side of the mapping ----
  // Every local read hands the URL to the one helper: Loader/URLLoader (through
  // URLLoader_load's shared local branch), Sound, and the image job in the
  // runtime preamble (which is a separate translation unit of text).
  check('URLLoader_load opens the mapped path',
    c.includes('const char* path = as_local_path_from_url(url);'));
  const runtime = RUNTIME_PREAMBLE;
  check('the image job maps a local URL before reading it',
    runtime.includes('as_async_submit(AS_JOB_IMAGE, obj, finish, as_local_path_from_url(url)'));
  check('the image job still routes http(s) through the transport',
    runtime.includes('if (!as_job_is_remote_url(url))'));

  if (ok > 0) console.log(`[fileurl] ${ok} emit checks passed`);
  return bad;
}

// The preamble compiles on its own, so the forward declaration it now needs must
// be there -- otherwise a runtime-only build (no File) fails to link.
function checkPreamble(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [fileurl] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [fileurl] ${label}`); }
  };

  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  check('the preamble forward-declares as_local_path_from_url',
    runtime.includes('static char* as_local_path_from_url(const char* url);'));
  check('the preamble does not define it (File owns the definition)',
    !runtime.includes('static char* as_local_path_from_url(const char* url) {'));

  if (ok > 0) console.log(`[fileurl] ${ok} preamble checks passed`);
  return bad;
}

registerGroup('unit: file-url/mapping', checkMapping);
registerGroup('unit: file-url/preamble', checkPreamble);