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
import { readFileSync } from 'node:fs';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { knownFeatures, validateFeatures } from '../../src/build.ts';
import { registerGroup, dir, root, readNorm } from '../harness.ts';

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

  // M6: the wiring that only breaks at link or run time (see the block below).
  fails.push(...checkNativeShaderBuildInputs());

  return fails;
}

registerGroup('native-shader/', checkNativeShader);
// ---- M6: the engine side (asaot3d) and the build inputs a feature owns ----
//
// These pin the four links that only fail at RUN or LINK time, i.e. exactly the
// ones a compile-only test cannot see. Each was found by apps/shader-m30 and each
// failed silently or with a message that named the wrong component:
//
//   1. `--features native-shader` must add the vendored shim + archives itself.
//      Without it the C compiles and the LINK dies on `_asc_shader_translate`.
//   2. Context3DNative/NativeProgram3D must carry a reflectFqn, or
//      getDefinitionByName misses and a native build quietly behaves like a
//      default one (the "silent downgrade" §0 forbids).
//   3. The five s3d_native_* entry points must be DECLARED in the preamble.
//      Undeclared is not benign in C99: it is `call to undeclared function`.
//   4. A native draw goes through Context3D_submit, the same sync point an AGAL
//      draw uses; calling s3d_draw directly skips the vertex-upload step and the
//      glue returns on `numStreams == 0` without drawing anything.
const INDEX_SRC = readFileSync(join(root, 'src', 'index.ts'), 'utf8');

export function checkNativeShaderBuildInputs(): string[] {
  const bad: string[] = [];
  const build = readFileSync(join(root, 'src', 'build.ts'), 'utf8');
  if (!build.includes('export function applyFeatureDeps')) bad.push('build.ts: no applyFeatureDeps');
  if (!build.includes("SHADER_FEATURE = 'native-shader'")) bad.push("build.ts: the feature id is not named once");
  if (!build.includes("link-order.txt")) bad.push('build.ts: archive order must come from link-order.txt');
  if (!INDEX_SRC.includes('applyFeatureDeps(cfg)')) bad.push('index.ts: applyFeatureDeps is never applied');
  // The shim is a sibling of skia_glue.cc, not under vendor/shader/.
  if (!build.includes("resolve(shaderVendorParent(), 'shader_compiler.cc')")) {
    bad.push('build.ts: the shim path must be vendor/shader_compiler.cc');
  }

  const symbols = readFileSync(join(root, 'src', 'symbols.ts'), 'utf8');
  for (const fqn of ['flash.display3D::Context3DNative', 'flash.display3D::NativeProgram3D']) {
    if (!symbols.includes(`reflectFqn: '${fqn}'`)) {
      bad.push(`symbols.ts: ${fqn} has no reflectFqn (getDefinitionByName cannot find it)`);
    }
  }

  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  for (const fn of ['s3d_native_use', 's3d_native_uniform', 's3d_native_bind_texture',
                    's3d_native_set_targets', 's3d_create_texture_fmt']) {
    if (!runtime.includes(`extern `) || !new RegExp(`extern [a-z]+\\*? ?${fn}\\(`).test(runtime)) {
      bad.push(`runtime.ts: ${fn} is called but not declared (C99 rejects implicit declarations)`);
    }
  }

  const emit = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  if (!emit.includes('Context3D_submit(self->context, indexBuffer, numTriangles, 1)')) {
    bad.push('emit.ts: the native draw must go through Context3D_submit (vertex uploads live there)');
  }
  if (!emit.includes('Context3DNative_fromContext_static')) {
    bad.push('emit.ts: Context3DNative needs the fromContext factory (a Class value is not constructible)');
  }

  // ---- M34: offscreen MSAA is a per-target API, and it has to survive the same
  // three-link chain the other native entry points do (symbol -> emit -> extern).
  // A missing extern is a C99 hard error; a missing symbol entry means the AS3 side
  // cannot name the method at all, which shows up as a compile error in the demo,
  // not here. Both are cheap to pin by name.
  if (!/\['setRenderTargetSamples',[^\]]*TextureBase[^\]]*'samples', 'int'/.test(symbols)) {
    bad.push('symbols.ts: Context3DNative.setRenderTargetSamples is missing from the method surface');
  }
  if (!runtime.includes('extern int s3d_set_target_samples(')) {
    bad.push('runtime.ts: s3d_set_target_samples is not declared');
  }
  if (!runtime.includes('as_s3d_set_target_samples')) {
    bad.push('runtime.ts: the AS wrapper as_s3d_set_target_samples is missing');
  }
  if (!emit.includes('Context3DNative_setRenderTargetSamples')) {
    bad.push('emit.ts: the setRenderTargetSamples body is not emitted');
  }
  // 8x is accepted by the channel but must still be a listed level: the check is what
  // makes an unsupported request fail loudly instead of silently staying at 1 sample.
  if (!/n != 1 && n != 2 && n != 4 && n != 8/.test(emit)) {
    bad.push('emit.ts: setRenderTargetSamples must validate the level (1/2/4/8)');
  }
  // The deferred pipeline: a native program's vertex descriptor comes from the
  // streams bound at draw time, so s3d_native_use must NOT build one.
  const glue = readFileSync(join(root, 'vendor', 'stage3d_glue.mm'), 'utf8');
  if (!glue.includes('nativePsoPending')) bad.push('stage3d_glue.mm: the native pipeline must be built at draw time');
  // The lazy resolve is what keeps a multisample companion invisible to the app: drop
  // it and every read samples the stale single-sample destination.
  for (const site of ['s3d_msaa_resolve_texture', 's3d_msaa_resolve_all', 'S3D_MAX_MSAA_TARGETS']) {
    if (!glue.includes(site)) bad.push(`stage3d_glue.mm: ${site} is missing (per-target MSAA, docs/zh-cn/native-shader.md §6.10)`);
  }
  return bad;
}
