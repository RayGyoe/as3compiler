// Unit checks: every activation cell a sibling nested-function group needs must be
// DECLARED and ALLOCATED in the body that owns it (阶段三百五十).
//
// Why source-level pins: the defect did not change any runtime value -- it changed
// whether the generated C compiles at all. A constructor that declared two nested
// functions calling each other emitted the cell struct and `_cellN_alloc()`, but
// never `_cellN* cellN = _cellN_alloc();` in the constructor body, so every call
// site read an undeclared `cellN` and `cc` rejected the program
// (`use of undeclared identifier 'cell2'`). A behaviour example cannot express
// "the C must compile for the shapes we claim to support" for every enclosing
// body kind, and the interesting regression (a new body kind forgetting the call)
// is invisible until a program happens to use that kind.
//
// The four enclosing bodies that can own a group: a method (incl. getter/setter),
// a free function, a CONSTRUCTOR, and a class-body static block. The first two
// always worked; the last two were the bug. The behavioural matrix lives in
// examples/nested-sibling-fn.as and the AIR/AOT comparison in temp/nsfair/.
//
//   node --test --test-name-pattern='closure/sibling-cells' test/unit/*.ts
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup } from '../harness.ts';

function checkClosureSiblingCells(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [cellsib] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [cellsib] ${label}`); }
  };
  const gen = (src: string): string => generateC(parse(src)).c;

  // Every `_cellN` typedef must have a matching `_cellN* cellN = _cellN_alloc();`
  // somewhere. That single invariant covers the whole bug class: an unallocated
  // cell means some body references `cellN` without declaring it.
  const everyCellAllocated = (c: string): boolean => {
    const names = new Set<string>();
    for (const m of c.matchAll(/typedef struct \{[^}]*\} (_cell\d+);/g)) names.add(m[1]);
    if (names.size === 0) return false;
    for (const name of names) {
      const local = name.replace('_cell', 'cell');
      if (!c.includes(`${name}* ${local} = ${name}_alloc();`)) return false;
    }
    return true;
  };

  // ---- the constructor path (the bug) ----
  const ctorSrc = [
    'class Holder {',
    '  public var label:String = "";',
    '  public function Holder(n:int) {',
    '    label = isEven(n) ? "even" : "odd";',
    '    function isEven(k:int):Boolean { return k == 0 ? true : isOdd(k - 1); }',
    '    function isOdd(k:int):Boolean { return k == 0 ? false : isEven(k - 1); }',
    '  }',
    '}',
    'var h:Holder = new Holder(7);',
    'trace(h.label);',
    '',
  ].join('\n');
  const ctorC = gen(ctorSrc);
  // C is only accepted when the declaration precedes the first use; `cc` is the
  // real oracle in the example suite, this pins the shape.
  // The ctor is emitted twice: a prototype near the top and the definition later.
  // Anchor on the DEFINITION (`...) {`), not the prototype (`...) ;`).
  const ctorDef = /\n(?:static )?void Holder_ctor\([^)]*\) \{\n/.exec(ctorC);
  const ctorBodyAt = ctorDef?.index ?? -1;
  const ctorEndAt = ctorBodyAt < 0 ? -1 : ctorC.indexOf('\n}', ctorBodyAt);
  const ctorBody = ctorBodyAt < 0 || ctorEndAt < 0 ? '' : ctorC.slice(ctorBodyAt, ctorEndAt);
  check('a constructor that declares sibling nested functions has a body', ctorBody.length > 0);
  const ctorAlloc = /(_cell\d+)\* (cell\d+) = \1_alloc\(\);/.exec(ctorBody);
  check('...declares and allocates the shared cell inside the constructor', ctorAlloc !== null);
  const ctorUse = ctorBody.indexOf(`${ctorAlloc?.[2] ?? '\u0000'}->`);
  check('...before the first call site reads it',
    ctorAlloc !== null && ctorUse > ctorAlloc.index);
  check('every cell in that program is allocated somewhere', everyCellAllocated(ctorC));

  // ---- the class-body static block path (same bug, same fix) ----
  const staticSrc = [
    'class Reg {',
    '  public static var got:String;',
    '  static {',
    '    got = isEven(6) ? "even" : "odd";',
    '    function isEven(k:int):Boolean { return k == 0 ? true : isOdd(k - 1); }',
    '    function isOdd(k:int):Boolean { return k == 0 ? false : isEven(k - 1); }',
    '  }',
    '}',
    'trace(Reg.got);',
    '',
  ].join('\n');
  const staticC = gen(staticSrc);
  check('a class-body static block that declares siblings allocates its cell too',
    everyCellAllocated(staticC));

  // ---- the paths that already worked must keep working, exactly once ----
  const methodSrc = [
    'class M {',
    '  public function run(n:int):String {',
    '    function a(k:int):String { return "a" + b(k); }',
    '    function b(k:int):String { return k.toString(); }',
    '    return a(n);',
    '  }',
    '}',
    'trace(new M().run(1));',
    '',
  ].join('\n');
  const methodC = gen(methodSrc);
  check('a method that declares siblings still allocates its cell', everyCellAllocated(methodC));
  const methodAllocs = methodC.match(/_cell\d+\* cell\d+ = _cell\d+_alloc\(\);/) ?? [];
  check('...exactly once (the constructor fix must not double-emit for methods)',
    methodAllocs.length === 1);

  const freeSrc = [
    'function outer(n:int):String {',
    '  function a(k:int):String { return "f" + b(k); }',
    '  function b(k:int):String { return k.toString(); }',
    '  return a(n);',
    '}',
    'trace(outer(2));',
    '',
  ].join('\n');
  const freeC = gen(freeSrc);
  check('a free function that declares siblings still allocates its cell', everyCellAllocated(freeC));
  const freeAllocs = freeC.match(/_cell\d+\* cell\d+ = _cell\d+_alloc\(\);/) ?? [];
  check('...exactly once', freeAllocs.length === 1);

  // ---- the control: a sibling pair inside a CLOSURE body needs no cell ----
  // Both siblings are reached by direct call from inside that closure, so no
  // function value is captured and no activation cell is born. Pinned so a future
  // "always allocate a cell" change does not quietly box every nested function.
  const deepSrc = [
    'class D {',
    '  public function run(k:int):String {',
    '    function inner(x:int):String {',
    '      function s1(y:int):String { return "v" + s2(y); }',
    '      function s2(y:int):String { return (y * 2).toString(); }',
    '      return s1(x);',
    '    }',
    '    return inner(k);',
    '  }',
    '}',
    'trace(new D().run(4));',
    '',
  ].join('\n');
  const deepC = gen(deepSrc);
  check('a sibling pair reached by direct call from a closure body needs no cell',
    !/typedef struct \{[^}]*\} _cell\d+;/.test(deepC));

  // ---- the emitted example carries the measured AIR answers ----
  const example = gen([
    'class Counter {',
    '  public var label:String = "";',
    '  public function Counter(start:int) {',
    '    label = isEven(6) ? "even" : "odd";',
    '    function isEven(k:int):Boolean { return k == 0 ? true : isOdd(k - 1); }',
    '    function isOdd(k:int):Boolean { return k == 0 ? false : isEven(k - 1); }',
    '  }',
    '}',
    'trace(new Counter(7).label);',
    '',
  ].join('\n'));
  check('a mutually recursive ctor pair (the measured AIR shape) gets an allocated cell',
    everyCellAllocated(example));

  if (ok > 0) console.log(`[cellsib] ${ok} sibling-cell checks passed`);
  return bad;
}
registerGroup('unit: closure/sibling-cells', checkClosureSiblingCells);