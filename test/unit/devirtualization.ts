// Unit checks: closed-world leaf-class ordinary calls become direct calls,
// while polymorphic, accessor, dynamic, interface and bound-method paths retain
// their existing dispatch. The behavioral half is examples/devirtualization.as.
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root, readNorm } from '../harness.ts';

function checkLeafMethodDevirtualization(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [devirtualization] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [devirtualization] ${label}`); }
  };

  const c = generateC(parse(readNorm(join(root, 'examples', 'devirtualization.as')))).c;

  check('a leaf receiver calls an inherited method at its declaring owner',
    /Base_inherited\(\(\(Leaf\*\)as_req_obj\(\(void\*\)\(g_leaf\)\)\), 4\)/.test(c));
  check('no fabricated Leaf_inherited implementation or call is emitted',
    !c.includes('Leaf_inherited('));
  check('an implicit public this call is direct',
    c.includes('return (Leaf_helper(this, value));'));
  check('a sealed with call on a leaf receiver is direct',
    /g_withResult = \(Leaf_callHelper\(__w\d+, 5\)\)/.test(c));

  check('a base-typed reference still dispatches an override through the vtable',
    /g_base\)\)\)->vtable->polymorphic\(/.test(c));
  check('private methods stay outside the first devirtualization slice',
    c.includes('return (this->vtable->secret(this));'));
  check('getters stay virtual even when their receiver is a leaf class',
    c.includes('this->vtable->get_accessor(this)')
    && c.includes('->vtable->get_helperCount('));
  check('dynamic and Proxy receivers keep runtime dispatch',
    c.includes('as_any_call(g_dynamicReceiver, "run", NULL, 0)')
    && /as_dyn_call\(\(\(LeafProxy\*\)as_req_obj\(\(void\*\)\(g_proxy\)\)\), "proxied"/.test(c)
    && !c.includes('LeafProxy_proxied('));
  check('interface receivers keep their independent interface vtable',
    /g_runner\.vt->run\(\(void\*\)as_req_obj/.test(c));
  check('super calls keep their existing owner-direct binding',
    c.includes('return Base_polymorphic(this);'));
  check('bound-method thunks keep virtual dispatch',
    /Leaf_callHelper__bound[\s\S]*?\(\(Leaf\*\)env\)->vtable->callHelper/.test(c));

  check('direct calls retain the null-receiver guard',
    /Base_inherited\(\(\(Leaf\*\)as_req_obj\(\(void\*\)\(g_nullLeaf\)\)\)/.test(c));
  check('a side-effecting receiver is hoisted and reused by the direct call',
    /Leaf\* _recv\d+ = currentLeaf\(\);[\s\S]*?Base_inherited\(\(\(Leaf\*\)as_req_obj\(\(void\*\)\(_recv\d+\)\)\)/.test(c));
  check('no inherited-method vtable call remains in this leaf-only call fixture',
    !c.includes('->vtable->inherited('));

  console.log(`     [devirtualization] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: devirtualization/LeafOrdinaryMethods', checkLeafMethodDevirtualization);
