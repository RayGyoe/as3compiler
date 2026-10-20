// Unit checks: a class reference spelled as a FULLY-QUALIFIED name (`pkg.sub.Cls.member`)
// must reach the very same static traits as the short spelling (`Cls.member`).
//
// Why this is pinned at the generated-C layer and not only by an example: the defect
// is a MISSING SPECIALIZATION, so both spellings "work" at runtime when the class's
// props table happens to carry the name — the difference only shows in which C was
// emitted (a direct call vs `as_class_member_value`, whose statics table only holds
// the names walkInferType managed to type, and it cannot type a `pkg.Cls` chain).
// The three negative pins below keep that from becoming an over-specialization.
//
// AIR truth: mxmlc + adl 51.4.1, both spellings, 24 trace lines byte-identical
// (temp/fqnadl/); the reported symptom was
// `flash.filesystem.File.applicationDirectory.nativePath` -> Error #1010.
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup } from '../harness.ts';

// A package-qualified class with one static of every shape the seam has to cover.
const PKG = `package pkg {
  public class C {
    public static var field:int = 5;
    public static const K:String = "k";
    public static function get seven():int { return 7; }
    public static function m():String { return "m"; }
    private static var _s:int = 0;
    public static function set s(v:int):void { _s = v * 2; }
    public static function get s():int { return _s; }
    public static var getTime:Function = myTimer;
    public static function myTimer():int { return 42; }
  }
}`;

// Mirrors the CLI: several inputs are parsed separately and their bodies/imports
// concatenated into one program (src/index.ts), so a package class and a script can
// be compiled as one unit without a build manifest.
function emit(...sources: string[]): string {
  const program: { body: unknown[]; imports: unknown[] } = { body: [], imports: [] };
  for (const s of sources) {
    const p = parse(s);
    program.body.push(...p.body);
    program.imports.push(...p.imports);
  }
  return generateC(program as Parameters<typeof generateC>[0]).c;
}

// The statements the script emitted live in `main`, i.e. after the whole runtime
// preamble + builtin class bodies (they also contain `as_class_member_value`), so
// every assertion below only ever looks at this slice.
function mainTail(c: string): string {
  const i = c.indexOf('int main(void) {');
  return i < 0 ? c : c.slice(i);
}

const count = (s: string, sub: string): number => s.split(sub).length - 1;

function checkFqnStaticClassRef(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [fqn] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [fqn] ${label}`); }
  };
  // `short` and `fqn` are the same source with one spelling swapped, so "the same C"
  // is a byte comparison of the two mains.
  const body = (src: string): string => mainTail(emit(PKG, src));
  const dynamic = (t: string): boolean =>
    t.includes('as_class_member_value') || t.includes('as_class_call_static') || t.includes('as_class_set_member');

  // ---- reads: static field / const / computed getter -> direct static accessor ----
  const filed = body('trace("" + C.field);\ntrace("" + pkg.C.field);');
  check('static field: both spellings emit the same direct slot read',
    count(filed, '(pkg_C_cinit(), pkg_C_field)') === 2 && !dynamic(filed));

  const constd = body('trace("" + C.K);\ntrace("" + pkg.C.K);');
  check('static const: both spellings emit the same direct slot read',
    count(constd, '(pkg_C_cinit(), pkg_C_K)') === 2 && !dynamic(constd));

  const getter = body('trace("" + C.seven);\ntrace("" + pkg.C.seven);');
  check('static getter: both spellings call the same static accessor',
    count(getter, 'pkg_C_get_seven_static(NULL)') === 2 && !dynamic(getter));

  // ---- call: static method + a static field holding a Function (both are calls) ----
  const call = body('C.m();\npkg.C.m();');
  check('static method: both spellings call the same static function',
    count(call, 'pkg_C_m_static();') === 2 && !dynamic(call));

  const fnval = body('trace(C.getTime());\ntrace(pkg.C.getTime());');
  check('static Function field: both spellings dispatch through the field value',
    count(fnval, 'as_req_fn((pkg_C_cinit(), pkg_C_getTime), NULL)->fn(') === 2 && !dynamic(fnval));

  // ---- writes: static field (plain + compound) and a static setter ----
  const wr = body('C.field = 60;\npkg.C.field = 61;');
  check('static field write: both spellings emit the same direct store',
    wr.includes('(pkg_C_cinit(), pkg_C_field = 60);') && wr.includes('(pkg_C_cinit(), pkg_C_field = 61);')
    && !dynamic(wr));

  const compd = body('pkg.C.field += 5;');
  check('static field compound assignment: FQN folds in the same direct read/write',
    compd.includes('(pkg_C_cinit(), pkg_C_field = ((pkg_C_cinit(), pkg_C_field) + 5));') && !dynamic(compd));

  const setter = body('C.s = 3;\npkg.C.s = 4;');
  check('static setter: both spellings call the same static setter',
    setter.includes('pkg_C_set_s_static(NULL, 3);') && setter.includes('pkg_C_set_s_static(NULL, 4);')
    && !dynamic(setter));

  // ---- built-ins: the reported symptom, the static-only pseudo-classes, and a
  //      built-in static getter. All three take a DIFFERENT emitter branch than the
  //      user-class cases above (hardcoded constants / runtime directory probe), so
  //      they are pinned separately rather than assumed to follow. ----
  const file = body('var a:File = File.applicationDirectory;\nvar b:File = flash.filesystem.File.applicationDirectory;');
  check('built-in static (File.applicationDirectory): FQN takes the directory shortcut too',
    count(file, 'File_new(as_app_dir())') === 2 && !dynamic(file));

  const sys = body('System.gc();\nflash.system.System.gc();\ntrace(Capabilities.version);\ntrace(flash.system.Capabilities.version);');
  check('static-only pseudo-classes: FQN System.gc()/Capabilities.version specialize alike',
    count(sys, 'as_system_gc();') === 2 && count(sys, 'as_cap_version()') === 2 && !dynamic(sys));

  const nag = body('trace(flash.desktop.NativeApplication.nativeApplication != NativeApplication.nativeApplication);');
  check('built-in static getter: FQN calls the same accessor',
    count(nag, 'NativeApplication_get_nativeApplication_static(NULL)') === 2 && !dynamic(nag));

  // ---- built-in static STRING getters (阶段二百一十八): File.separator / File.lineEnding.
  //      Both are `[static] [read-only]` String getters on File (airsdk.dev), and both
  //      answer a property of the HOST -- so the emitter hands out a runtime helper
  //      instead of a literal, and (as with the directory shortcuts above) the FQN
  //      spelling has to reach the very same helper. The VALUES are pinned at run time
  //      in examples/stage64.as: a source-level pin cannot tell `\` from `/`.
  //      `!as_add_v` is the typing half: a statically-known String concatenates via
  //      as_str_concat, while an `any`-typed operand would take the ES3 dynamic path. ----
  const hoststr = body('trace("x" + File.separator + File.lineEnding);\ntrace("y" + flash.filesystem.File.separator + flash.filesystem.File.lineEnding);');
  check('File.separator/lineEnding: both spellings call the same host helpers, typed String',
    count(hoststr, 'as_file_separator()') === 2 && count(hoststr, 'as_file_line_ending()') === 2
    && !dynamic(hoststr) && !hoststr.includes('as_add_v'));

  // ---- negative pins: the specialization must stay keyed on the STATIC receiver ----
  const dyn = body('var c:Class = C;\nc.m();');
  check('negative: a Class VALUE still takes the dynamic path (as_class_call_static)',
    dyn.includes('as_class_call_static('));

  const varroot = body('var flash:Object = null;\ntrace(flash.system.File);');
  check('negative: a chain whose root is neither a class nor a package is left alone',
    !varroot.includes('as_app_dir()') && !varroot.includes('File_new('));

  // The discriminating case for the shadowing guard. `flash` here is a LOCAL, so
  // `flash.system.System.gc()` is a member walk on that value -- it must not reach
  // the static-only emitter (the pre-existing FQN branch further down does not take
  // this guard; see TODO.md 遗留待开发 for that family-wide gap).
  const shadow = body('var flash:Object = null;\nflash.system.System.gc();\ntrace(flash.system.Capabilities.version);');
  check('negative: a VARIABLE shadowing the package root does not reach the static emitters',
    !shadow.includes('as_system_gc()') && !shadow.includes('as_cap_version()'));

  const plain = body('var o:Object = {a:1};\ntrace(o.a);\ntrace(Math.max(1, 2));');
  check('negative: ordinary member/method calls are untouched',
    !plain.includes('as_app_dir()') && !dynamic(plain));

  console.log(`  [fqn] ${ok} checks passed, ${bad.length} failed`);
  return bad;
}

registerGroup('unit: fqn/StaticClassRef', checkFqnStaticClassRef);
