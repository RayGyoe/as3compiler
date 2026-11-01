// Unit checks: E6 native shader passthrough (--features native-shader).
//
// The example suite runs `examples/native-shader-probe.as`, which pins the RUNTIME
// half of the channel (translation, reflection, the error surface). What an example
// cannot assert is the GATE: that a default build has no such class at all. That is
// the property the whole design rests on -- the absence is what makes
// `getDefinitionByName` answer #1065 the way adl does -- so it is pinned here.
//
//   node --test --test-name-pattern='native-shader/' test/unit/*.ts

import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { knownFeatures, validateFeatures } from '../../src/build.ts';
import { registerGroup, dir, readNorm } from '../harness.ts';

// A program that names the gated class in TYPE position. AS3 answers that at compile
// time (#1046), which is why the default build must refuse it rather than emit a
// reference to a struct it never declared.
const SRC_TYPED = `
package {
  import flash.display3D.Context3DNative;
  public class Probe {
    public function Probe() { var n:Context3DNative = null; }
  }
}
`;

export function checkNativeShader(): string[] {
  const fails: string[] = [];
  const ok = (cond: boolean, label: string): void => { if (!cond) fails.push(label); };

  // ---- the gate exists and is spelled the same everywhere ----
  ok(knownFeatures().includes('native-shader'), 'native-shader must be a known feature');
  const off: string[] = [];
  try { validateFeatures(['native-shader'], 'wasm'); } catch { off.push('wasm'); }
  ok(off.length === 1, 'native-shader must be refused for --target wasm (host archives only)');
  validateFeatures(['native-shader'], 'native');   // must not throw

  // ---- DEFAULT build: the classes do not exist ----
  const symbolsOff = new (Object.getPrototypeOf({}).constructor)() as never;   // unused placeholder
  void symbolsOff;
  const prog = parse(SRC_TYPED);
  let threw = false;
  try { generateC(prog, [], [], undefined, [], undefined, undefined, [], []); } catch (e) {
    threw = true;
    const msg = String((e as Error).message ?? e);
    ok(msg.includes('1046') || /Context3DNative/.test(msg), `default-build error must name the class or the AIR code, got: ${msg}`);
  }
  ok(threw, 'a default build must refuse a reference to Context3DNative');

  // ---- --features native-shader: the class is emitted, behind the macro ----
  const withFeature = generateC(prog, [], [], undefined, [], undefined, undefined, [], ['native-shader']).c;
  ok(withFeature.includes('#if ASC_HAS_NATIVE_SHADER'), 'the native bodies must sit inside #if ASC_HAS_NATIVE_SHADER');
  ok(withFeature.includes('Context3DNative_uploadProgram'), 'uploadProgram body must be emitted with the feature on');
  ok(withFeature.includes('NativeProgram3D_findSlot'), 'the reflection lookup must be emitted with the feature on');
  ok(withFeature.includes('Context3DNative_isAvailable_static'), 'isAvailable must be a STATIC method (the _static suffix)');
  // MRT + float targets are the enhancement itself; the pipeline has to be told how
  // many attachments the program writes.
  ok(withFeature.includes('p->colorAttachments = sp.color_attachments'), 'MRT: the reflected attachment count must reach NativeProgram3D');
  ok(withFeature.includes('#define ASC_HAS_NATIVE_SHADER 1'), 'the macro is derived from ASC_USE_NATIVE_SHADER');

  // ---- and the default build still names none of it ----
  const plain = generateC(parse(SRC_TYPED.replace(/import[^\n]*\n/, '').replace(/var n:Context3DNative = null;/, 'var n:int = 0;')), [], [], undefined, [], undefined, undefined, [], []).c;
  ok(!plain.includes('Context3DNative_uploadProgram'), 'a default build must not emit the native bodies');
  ok(plain.includes('#define ASC_HAS_NATIVE_SHADER 0'), 'a default build resolves the macro to 0');
  // The AIR six constants must be untouched by the enhancement (layer 1 vs layer 2,
  // docs/zh-cn/native-shader.md §6.1).
  const symbolsSrc = readNorm(join(dir, '..', 'src', 'symbols.ts'));
  ok(/constClass\('Context3DTextureFormat'[^\n]*BGRA: 'bgra'/.test(symbolsSrc), 'Context3DTextureFormat must keep AIR\'s six values verbatim');
  ok(!/Context3DTextureFormat[^\n]*RGBA32F/.test(symbolsSrc), 'float formats must NOT be added to Context3DTextureFormat (no constant-existence probe in AS3)');
  // The runtime half is opt-in all the way down: a default preamble must not name the
  // shim, or every build would need glslang on the link line.
  ok(RUNTIME_PREAMBLE.includes('#if defined(ASC_USE_NATIVE_SHADER)'), 'the runtime must gate the channel on ASC_USE_NATIVE_SHADER');
  const gate = RUNTIME_PREAMBLE.indexOf('#if ASC_HAS_NATIVE_SHADER');
  const decl = RUNTIME_PREAMBLE.indexOf('extern int asc_shader_translate');
  ok(gate >= 0 && decl > gate, 'asc_shader_translate must be declared only inside the ASC_HAS_NATIVE_SHADER gate');

  return fails;
}

registerGroup('native-shader/', checkNativeShader);