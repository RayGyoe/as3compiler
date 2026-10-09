// Unit checks: Stage3D texture upload semantics (mip levels, dispose safety,
// cube faces). Moved/added alongside the other unit groups; each group returns
// the list of failed labels and is registered as one node:test case, so it can be
// re-run alone with:
//   node --test --test-name-pattern='stage3d/' test/unit/*.ts
//
// Why this group exists at all: every one of these rules was found by driving a
// real GPU app (Basic_SkyBox) and none of them can be asserted by an examples/
// entry. The example suite runs manifest-free in pure-C mode (no Metal, no Skia),
// so `uploadFromBitmapData` only touches the CPU state machine there — a wrong
// upload cannot make any example fail. The failure mode is a *silent* empty
// texture: the 3D pass draws with no sampler bound and the window shows the bare
// stage background (Basic_SkyBox rendered pure white for exactly this reason).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerGroup, root } from '../harness.ts';

// The emitter builds the generated C from `this.line('...')` string literals.
// Assert on the emitted statements, not on the raw source: comments in emit.ts
// quote both the broken and the fixed forms (the same trap render.ts documents).
function emittedLines(): string {
  const src = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  return [...src.matchAll(/this\.line\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]).join('\n');
}

function checkStage3dTextureUpload(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [stage3d] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stage3d] ${label}`); }
  };

  const emitted = emittedLines();

  // 1. Both texture kinds must upload at uploadFromBitmapData time, i.e. while
  //    the source pixels are still alive. AIR's contract is synchronous; away3d's
  //    MipmapGenerator disposes the scratch BitmapData one line after uploading
  //    it, so a deferred (submit-time) upload reads `pixels == NULL` and the
  //    sampler is never bound. `BitmapData_dispose` NULLs the buffer (pin 2), and
  //    the sample app then renders its whole 3D pass invisible.
  check('BitmapData_dispose drops the pixel buffer (the reason eager/snapshot is mandatory)',
    /bd->pixels = NULL;/.test(emitted));
  check('Texture_uploadFromBitmapData uploads eagerly via as_s3d_texture_from_pixels',
    /o->gpu = as_s3d_texture_from_pixels\(o->ctx, o->width, o->height, \(const uint32_t\*\)bitmapData->pixels\);/.test(emitted));
  // A cube cannot be uploaded one face at a time into a single MTLTexture at
  // submit time, so its faces keep a PRIVATE copy of level 0's pixels instead.
  check('CubeTexture_uploadFromBitmapData snapshots the source pixels',
    /memcpy\(px, bitmapData->pixels, nb\);/.test(emitted));
  check('the cube face snapshot publishes the GC write barrier',
    /snap->pixels = \(void\*\)px; gc_write_barrier\(snap->pixels\);/.test(emitted));

  // 2. Mip levels above 0. The CUBE still ignores them (its chain is built on the
  //    GPU -- pins below); the 2D path now HONOURS them with AIR's measured
  //    region rule, see checkStage3dMipSemantics / stage3d/mip-drop.
  check('CubeTexture_uploadFromBitmapData keeps only mip level 0 (GPU builds the chain)',
    /if \(miplevel != 0\) return;/.test(emitted) && (emitted.match(/if \(miplevel != 0\) return;/g) ?? []).length === 1);

  // 3. The Metal cube face write. A cube face IS a texture slice, so the upload
  //    must go through the selector that takes bytesPerImage; sending the 2D
  //    `...mipmapLevel:withBytes:bytesPerRow:` form is an unrecognized selector
  //    (a hard NSInvalidArgumentException crash) rather than a no-op.
  const glue = readFileSync(join(root, 'vendor', 'stage3d_glue.mm'), 'utf8');
  const cubeFn = glue.slice(glue.indexOf('void* s3d_upload_cube_texture'));
  const cubeBody = cubeFn.slice(0, cubeFn.indexOf('\n}\n'));
  check('s3d_upload_cube_texture writes faces with bytesPerImage (slice variant)',
    /slice:\(NSUInteger\)face\s*\n\s*withBytes:argb\[face\] bytesPerRow:\(NSUInteger\)size \* 4 bytesPerImage:/.test(cubeBody));
  check('s3d_upload_cube_texture allocates a cube-typed MTLTexture',
    /textureCubeDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm/.test(cubeBody));
  // AGAL/Stage3D face order is +X,-X,+Y,-Y,+Z,-Z; the loop writes slice == the
  // incoming face index, so the buffer order the caller builds is the contract
  // (pinned here because a reorder would silently mirror the environment map).
  check('cube faces are written in incoming (AGAL) order',
    /for \(int face = 0; face < 6; face\+\+\)/.test(cubeBody));

  // 4. The cube must carry a FULL mip chain. AIR's BitmapCubeTexture uploads
  //    every level via MipmapGenerator.generateMipMaps, and away3d's AGAL asks
  //    for `<cube,linear,miplinear>`, so AIR's minified environment reflection is
  //    mip-filtered. A level-0-only cube made the torus's reflection alias into
  //    per-pixel hatching while the magnified skybox still looked fine -- exactly
  //    the symptom this pin exists to prevent coming back.
  check('cube texture is created mipmapped (full chain)',
    /size:\(NSUInteger\)size mipmapped:YES\]/.test(cubeBody));
  // The chain itself is built in s3d_generate_cube_mips (declared just above the
  // upload function), so assert the call site here and the blit in the file.
  check('the cube mip chain is generated with a blit',
    /s3d_generate_cube_mips\(c, tex\);/.test(cubeBody)
    && /\[blit generateMipmapsForTexture:tex\]/.test(glue));

  console.log(`     [stage3d] ${ok} check(s) passed`);
  return bad;
}

// AGAL sampler state: away3d and Starling NEVER call setSamplerStateAt (0 hits in
// either tree) -- they declare filter/wrap/mip in the AGAL `tex` flags and rely on
// the runtime honouring them. Measured on AIR 51.4.1 (temp/sampprobe):
// `<2d,linear,nomip>` vs `<2d,nearest,nomip>` render bilinear-grey vs pure texel
// colours, `miplinear` with tiled uv lands on the expected mip level
// (lod = log2(texels per pixel)), and setSamplerStateAt / setProgram are
// "last writer wins" in call order. Dropping the flags silently downgraded every
// program to the runtime's own default sampler, which only LOOKED right while
// that default happened to agree with away3d.
function checkStage3dAgalSamplerFlags(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [stage3d] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stage3d] ${label}`); }
  };

  // The runtime preamble is the C text that every generated program embeds, so
  // the decoder is asserted on its definition signature (comments in runtime.ts
  // quote the same names, so a bare name match would pass from a comment).
  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  check('as_agal_sampler_flags decodes used-mask + packed flags per sampler register',
    /static void as_agal_sampler_flags\(const unsigned char\* bytes, int len, unsigned int\* usedOut, unsigned int\* flagsOut\)/.test(runtime));
  // AGALMiniAssembler's SAMPLER_*_SHIFT bit fields. These four shifts are the
  // whole contract: filter 28, mipmap 24, repeat 20, dim 12.
  check('AGAL sampler token bit fields match AGALMiniAssembler (filter 28 / mip 24 / wrap 20)',
    /\(s2hi >> 28\) & 0x3u/.test(runtime) && /\(s2hi >> 24\) & 0x3u/.test(runtime) && /\(s2hi >> 20\) & 0x3u/.test(runtime));
  // AGAL says filter 1 = LINEAR; the Metal glue says filter 1 = NEAREST. Getting
  // this inversion wrong flips every texture between smooth and blocky.
  check('the AGAL linear bit is inverted into the backend encoding',
    /filter == 1 \? 0 : 1/.test(runtime));
  check('as_s3d_apply_agal_sampler_state writes the per-unit state via s3d_set_sampler_state_i',
    /static inline void as_s3d_apply_agal_sampler_state\(void\* ctx, unsigned int used, unsigned int flags\)/.test(runtime)
    && /s3d_set_sampler_state_i\(ctx, u,/.test(runtime));
  check('s3d_set_sampler_state_i is declared as extern in the runtime preamble',
    /extern void s3d_set_sampler_state_i\(void\* ctx, int unit, int filter, int wrap, int mip\);/.test(runtime));

  const emitted = emittedLines();
  check('Program3D_upload decodes the fragment program sampler flags',
    /as_agal_sampler_flags\(\(const unsigned char\*\)o->fragmentProgram->data, o->fragmentProgram->length, \(unsigned int\*\)&o->samplerUsed, \(unsigned int\*\)&o->samplerFlags\);/.test(emitted));
  // Applying the state at setProgram (not lazily at draw time) is what makes the
  // ordering against setSamplerStateAt come out as AIR's "last writer wins".
  check('Context3D_setProgram applies the program sampler state',
    /void Context3D_setProgram\(void\* _this, Program3D\* program\) \{ Context3D\* o = \(Context3D\*\)_this; o->program = program; gc_write_barrier\(\(void\*\)program\); if \(program != NULL\) as_s3d_apply_agal_sampler_state\(o->gpu, \(unsigned int\)program->samplerUsed, \(unsigned int\)program->samplerFlags\); \}/.test(emitted));

  // The glue side: ONE storage for the per-unit state, shared by the AGAL path
  // and setSamplerStateAt (they write the same Stage3D unit state, so the string
  // entry point must delegate rather than keep its own copy).
  const glue = readFileSync(join(root, 'vendor', 'stage3d_glue.mm'), 'utf8');
  const ifn = glue.slice(glue.indexOf('void s3d_set_sampler_state_i('));
  check('s3d_set_sampler_state_i records filter/wrap/mip on the unit',
    /c->samplerFilter\[unit\] = filter;/.test(ifn) && /c->samplerMip\[unit\] = mip;/.test(ifn)
    && /c->samplerStateSet\[unit\] = 1;/.test(ifn));
  const sfn = glue.slice(glue.indexOf('void s3d_set_sampler_state(void* ctx'));
  const sBody = sfn.slice(0, sfn.indexOf('\n}\n'));
  check('s3d_set_sampler_state (setSamplerStateAt) delegates to the same storage',
    /s3d_set_sampler_state_i\(ctx, unit, f, w, m\);/.test(sBody));

  console.log(`     [stage3d] ${ok} check(s) passed`);
  return bad;
}

// 2D mip semantics (阶段一百二十八, batch C) -- the rules are MEASURED, not
// guessed: temp/mipprobe drives `uploadFromBitmapData(bmd, level>0)` under adl
// (MIPPROBE-v2) and the same source under as-aot on native and web. Its 8 tests
// settle two questions that no example can reach (the examples suite runs
// manifest-free, so nothing in it ever uploads a level or samples a mip):
//
//   Q1 which texture drops a mip-filtered draw?
//      T2 createTexture(flag off) + level 0 only + <2d,nearest,miplinear> -> the
//      draw is DROPPED (readback = the clear colour). T3 is the same with the
//      create flag ON and drops identically, so the trigger is "no level > 0 was
//      ever uploaded", NOT the createTexture mipmapped flag. T1/T4/T7 (nomip)
//      draw normally from level 0.
//   Q2 what does a level > 0 upload actually copy when the source bitmap is
//      FULL SIZE (away3d's MipmapGenerator reuses one full-size scratch bitmap
//      and rescales each level into its top-left (W>>i)x(H>>i) rect)?
//      T5 (source = horizontal stripes grey(32r+16), level 1 read back at lod 1)
//      returns 16,48,80,112 = source rows 0..3 read with the SOURCE's stride:
//      the level takes the source's top-left lw x lh rectangle, NOT a tightly
//      packed copy and NOT a rescale of the whole bitmap. T6 (correctly sized
//      level bitmaps) returns exactly what was uploaded, so lod 1 really is
//      level 1.
// Three measurements agree line for line: adl == native Metal == web WebGL2 (only
// the driver marker differs).
function checkStage3dMipSemantics(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [stage3d] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stage3d] ${label}`); }
  };

  const emitted = emittedLines();
  const metal = readFileSync(join(root, 'vendor', 'stage3d_glue.mm'), 'utf8');
  const webgl = readFileSync(join(root, 'vendor', 'stage3d_webgl.cc'), 'utf8');

  // The emitted upload must hand the glue the level's rectangle AND the source's
  // row stride -- that stride is the whole point of the measured region rule.
  check('Texture_uploadFromBitmapData uploads level > 0 as the source\'s top-left lw x lh rect',
    /as_s3d_texture_upload_level\(o->ctx, o->gpu, \(int\)miplevel, lw, lh, \(const uint32_t\*\)bitmapData->pixels, bitmapData->width\);/.test(emitted));
  check('a level > 0 upload records o->mips = 1 (the "this texture has a chain" signal)',
    /o->mips = 1;/.test(emitted));
  check('a level 0 upload resets o->mips = 0 (the chain no longer matches the content)',
    /o->mips = 0;/.test(emitted));
  check('levels beyond max(w,h) are rejected (MTLTexture would fault on a missing level)',
    /if \(\(int\)miplevel >= nlv\) return;/.test(emitted));
  // Layout: Context3D_submit reads a RectangleTexture through Texture*, so the
  // trailing field must exist in BOTH structs at the same offset.
  const symbols = readFileSync(join(root, 'src', 'symbols.ts'), 'utf8');
  check('Texture and RectangleTexture both carry the trailing mips field (shared layout)',
    /\['mips', txf\(\{ kind: 'int' \}\)\]/.test(symbols)
    && /\['mips', rtf\(\{ kind: 'int' \}\)\]/.test(symbols));

  // The bind must carry the flag, and the CUBE must claim a chain it actually has
  // (its upload builds one with a blit). These two lines are concatenations of a
  // literal and a loop variable, so they do not survive emittedLines(); assert on
  // the emit.ts source instead.
  const emitSrc = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  check('Context3D_submit forwards the 2D texture\'s mips flag to the bind',
    /as_s3d_bind_texture\(o->gpu, \$\{i\}, o->tex\$\{i\}->gpu, o->tex\$\{i\}->mips\)/.test(emitSrc));
  check('a bound cube advertises a chain (1)',
    /as_s3d_bind_texture\(o->gpu, ' \+ i \+ ', cube->gpu, 1\);/.test(emitSrc));

  // The drop rule itself, in BOTH glues -- and the two must agree literally, or a
  // scene would drop draws on one target and draw them on the other. In WebGL the
  // placement is load-bearing: GL samples an incomplete texture as BLACK, so the
  // drop has to be decided after the deferred clear (the frame still clears, as
  // AIR does) and before the program is bound.
  const drop = 'c->samplerStateSet[i] && c->samplerMip[i] != 0 && c->texHasMips[i] == 0';
  check('Metal glue drops the draw on a mip-filtered unit with no chain',
    metal.includes(drop) && /asc_tr_mipdrop\+\+/.test(metal));
  check('Metal glue still consumes the pending colour clear in the dropped-draw pass',
    /loadAction = MTLLoadActionClear/.test(metal.slice(metal.indexOf('asc_tr_mipdrop'))));
  check('WebGL glue drops the draw on the same rule (byte-identical condition)',
    webgl.includes(drop) && /S3D mip-drop/.test(webgl));
  check('WebGL drop is decided after the deferred clear and before the program is bound',
    webgl.indexOf('S3D mip-drop') > webgl.indexOf('if (c->clearPending) {')
    && webgl.indexOf('S3D mip-drop') < webgl.indexOf('glUseProgram(c->prog)'));
  // Both glues must clear the flag when a unit is unbound (a stale flag would let
  // a later mip-filtered draw of a chainless texture go through).
  check('Metal glue clears the chain flag when the texture is destroyed/unbound',
    /texHasMips\[i\] = 0/.test(metal));
  check('WebGL glue clears the chain flag when the texture is destroyed/unbound',
    /texHasMips\[i\] = 0/.test(webgl));

  console.log(`     [stage3d] ${ok} check(s) passed`);
  return bad;
}

// Depth-stencil state cache (阶段一百二十八, batch A). Before it, every draw
// rebuilt and re-assigned a MTLDepthStencilState (one device object per draw at
// ~2160 draws/frame in Basic_SkyBox -- pure per-frame garbage). The cache keyed
// on (write, compare) turns that into one object per distinct state; the trace
// counter asc_tr_dss shows the miss count, and "slots own the +1, c->dss is
// borrowed" is the ownership rule that keeps the LRU from double-releasing.
function checkStage3dDssCache(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [stage3d] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stage3d] ${label}`); }
  };

  const metal = readFileSync(join(root, 'vendor', 'stage3d_glue.mm'), 'utf8');
  check('the depth-stencil cache is keyed on (write, compare) with a bounded LRU',
    /#define S3D_MAX_DSS 16/.test(metal) && /static void s3d_select_dss\(S3DContext\* c\)/.test(metal)
    && /S3DDssVariant;/.test(metal));
  check('a cache hit does not re-create the device object (miss counter only on build)',
    /asc_tr_dss\+\+/.test(metal));
  check('the cache key is a copied string (the caller\'s buffer is transient)',
    /s3d_key_str/.test(metal) && /depthCompare/.test(metal));
  check('the cache is released with the context',
    /for \(int i = 0; i < S3D_MAX_DSS; i\+\+\)/.test(metal));

  console.log(`     [stage3d] ${ok} check(s) passed`);
  return bad;
}

registerGroup('stage3d/texture-upload', checkStage3dTextureUpload);
registerGroup('stage3d/mip-semantics', checkStage3dMipSemantics);
registerGroup('stage3d/dss-cache', checkStage3dDssCache);
registerGroup('stage3d/agal-sampler-flags', checkStage3dAgalSamplerFlags);

// Pins the one-queue rule that keeps the Stage3D offscreen target safe to
// composite. The 2D side composites that target by *reading* a texture the 3D
// side *writes* on the next frame (generated ASC_window_render: flush ->
// composite -> present), and Metal only tracks resource hazards within a single
// MTLCommandQueue. On two queues the composite's read raced the following
// frame's write, so the composite landed the previous frame's finished skybox
// plus the current frame's half-written torus pass: the ring came out sliced
// along a straight tile boundary with background showing through. Measured on
// Basic_SkyBox by burst-capturing the window: the ring was cut in 11 of 25
// consecutive frames, and in 0 of 150 once both sides shared one queue. These
// checks are the only guard -- no examples/ entry links Metal at all.
function checkStage3dQueueSharing(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [stage3d] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stage3d] ${label}`); }
  };

  const metal = readFileSync(join(root, 'vendor', 'metal_glue.mm'), 'utf8');
  const glue = readFileSync(join(root, 'vendor', 'stage3d_glue.mm'), 'utf8');

  // 1. The shared queue exists, is created once, and is the process's only one.
  const acc = metal.slice(metal.indexOf('id<MTLCommandQueue> sk_mtl_shared_queue(void) {'));
  const accBody = acc.slice(0, acc.indexOf('\n}\n'));
  check('metal_glue exposes a process-wide shared MTLCommandQueue accessor',
    accBody.length > 0 && /if \(g_shared_queue == nil\)/.test(accBody)
    && /g_shared_queue = \[d newCommandQueue\];/.test(accBody));
  check('the shared queue is retained for the process lifetime (not released on window teardown)',
    !/\[g_shared_queue release\]/.test(metal));

  // 2. Ganesh must run on that queue too, otherwise there are two queues again.
  check('sk_mtl_init adopts the shared queue instead of creating a private one',
    /g_queue = sk_mtl_shared_queue\(\);/.test(metal)
    && !/g_queue = \[g_device newCommandQueue\]/.test(metal));
  // Tearing the queue down when the last window closes would leave a still-live
  // Stage3D context holding it, and the next window would get a different one.
  const destroy = metal.slice(metal.indexOf('void sk_mtl_destroy(int win_id) {'));
  const destroyBody = destroy.slice(0, destroy.indexOf('\n}\n'));
  check('sk_mtl_destroy drops its queue handle without releasing the shared queue',
    /g_queue = nil;/.test(destroyBody) && !/\[g_queue release\]/.test(destroyBody));

  // 3. The Stage3D side must join that queue. The accessor is looked up with
  //    dlsym, NOT declared `weak_import`: a headless Stage3D build links
  //    stage3d_glue.mm without metal_glue.mm, and a weak_import reference is
  //    still an undefined symbol to the modern macOS linker -- the headless link
  //    failed outright (2026-10-09, "Undefined symbols: _sk_mtl_shared_queue",
  //    which is what examples/stage83.build.json does). dlsym resolves to NULL
  //    at runtime instead, keeping the documented fallback.
  check('stage3d_glue looks the shared-queue accessor up at runtime (dlsym)',
    /dlsym\(RTLD_DEFAULT, "sk_mtl_shared_queue"\)/.test(glue));
  const create = glue.slice(glue.indexOf('void* s3d_create(int width, int height) {'));
  const createBody = create.slice(0, create.indexOf('\n}\n'));
  check('s3d_create adopts the shared queue when the symbol is present',
    /SkMtlSharedQueueFn sharedFn = sk_mtl_shared_queue_lookup\(\);/.test(createBody)
    && /\(sharedFn != NULL\) \? sharedFn\(\) : nil/.test(createBody));
  check('s3d_create only falls back to a private queue when there is nothing to share with',
    /c->queue = \(sharedQueue != nil\) \? \[sharedQueue retain\] : \[device newCommandQueue\];/.test(createBody));
  // The adopted queue is +1 on the context so s3d_destroy's release stays balanced.
  check('the adopted queue is retained so s3d_destroy balances it',
    /if \(c->queue != nil\) \[c->queue release\];/.test(glue));

  console.log(`     [stage3d] ${ok} check(s) passed`);
  return bad;
}

registerGroup('stage3d/gpu-queue-sharing', checkStage3dQueueSharing);
// AGAL operand slots: every instruction occupies a FIXED 24-byte slot
// ([opcode:4][dest:4][src1:8][src2:8]) and AGALMiniAssembler writes the dest slot
// even for OP_NO_DEST opcodes -- for a first operand that is a source it emits
// four zero bytes and then the real token (AGALMiniAssembler.as, the `if (j==0)
// writeUnsignedInt(0)` branch). The decoder used to skip that slot only when the
// opcode actually had a destination, which shifted every operand of
// kil/ife/ine/ifg/ifl four bytes early.
//
// The visible damage: away3d's EnvMapMethod generates `kil temp2.w` ("if alpha is
// not 1 (mock texture) kil output"), whose correct guard is the cube sample's
// alpha minus 0.5. Misread, the operand decoded as varying v0 with an xxxx
// swizzle, so the shader discarded every fragment whose transformed NORMAL had
// x < 0 -- a cut along the plane x=0. Basic_SkyBox's torus is centred on that
// plane, so half the ring disappeared behind a perfectly vertical edge at the
// screen centre (and it read as "missing at some rotation angles", because which
// surface normals face -x changes as the torus turns). Measured on the offscreen
// target in temp/ringdiag (ASC_DUMP_TEX/ASC_DRAWLOG probes, since removed): one
// 1600-triangle torus draw in one render pass, geometry a clean R=150/r=60 torus,
// yet the target showed the discards and not the skybox. Fixing the slot offset
// turns the guard into `if (ft4.wwww.x < 0.0)`, which is never taken for a real
// cube map (alpha 1 -> 0.5).
function checkStage3dAgalOperandSlots(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [stage3d] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stage3d] ${label}`); }
  };

  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const bodyOf = (sig: string): string => {
    const i = runtime.indexOf(sig);
    return i < 0 ? '' : runtime.slice(i, runtime.indexOf('\n}\n', i) + 3);
  };

  // Both slot walkers: the dest slot is consumed unconditionally, and the old
  // `if (hasDst) pos += 4;` form -- the bug -- is gone.
  for (const sig of ['static void as_agal_sampler_flags(',
                     'static char* as_agal_translate(']) {
    const name = sig.split(' ').pop()!.replace('(', '');
    const body = bodyOf(sig);
    check(`${name} skips the always-present dest slot before reading src1`,
      body !== '' && /pos \+= 4;\n\s*if \(hasSrc1\)/.test(body)
      && !/if \(hasDst\) pos \+= 4;/.test(body));
  }

  // The operand count comes from the opcode table, so the decoder must still
  // treat a no-dest opcode's operands as sources (1 for kil, 2 for ife/ine/ifg/ifl).
  check('OP_NO_DEST opcodes still count their operands as sources',
    /int hasDst = \(nreg >= 1\) && !agal_op_nodest\[op\];/.test(runtime)
    && /int hasSrc1 = nreg >= \(hasDst \? 2 : 1\);/.test(runtime)
    && /int hasSrc2 = nreg >= \(hasDst \? 3 : 2\);/.test(runtime));

  // kil compares the SWIZZLED operand: away3d writes `kil temp2.w`, so the guard
  // has to read the operand's own swizzle (w1) rather than a hard-coded .x.
  check('kil compares the swizzled operand (src1 expression keeps its own swizzle)',
    /agal_src_expr\(s1, t1, n1, w1, target\)/.test(runtime)
    && /if \(%s\.x < 0\.0\) %s;/.test(runtime));

  console.log(`     [stage3d] ${ok} check(s) passed`);
  return bad;
}

registerGroup('stage3d/agal-operand-slots', checkStage3dAgalOperandSlots);

// Flush policy: the frame boundary commits WITHOUT waiting, the CPU-readback
// paths wait.
//
// Batching a frame's draws into one command buffer (stage 104) left a single
// synchronisation point per frame -- commit + waitUntilCompleted -- whose whole
// cost was the round trip: measured wait 0.93 ms/frame against 0.34 ms of
// whole-frame GPU work on an 8.33 ms (120 Hz) budget. Sharing Skia's command
// queue (stage 114) removed the reason for it: a CPU wait is only needed to make
// the writes visible to the CPU, while the thing that actually observes the
// target on the frame path is the GPU-side composite, and Metal orders command
// buffers of one queue by submission and inserts the dependency barrier for the
// tracked target. Skia's own composite already relies on exactly that (it
// commits with no wait). So the wait is kept for the paths that genuinely read
// the pixels back (readbackFromBitmapData, resize, destroy) and dropped from
// present()/the pre-composite flush.
function checkStage3dFlushPolicy(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [stage3d] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stage3d] ${label}`); }
  };

  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const glue = readFileSync(join(root, 'vendor', 'stage3d_glue.mm'), 'utf8');
  const emitted = emittedLines();

  // One implementation, two policies: the wait is the only difference.
  check('both flush flavours share one commit path, the wait being the only difference',
    /static void s3d_flush_impl\(void\* ctx, int wait\)/.test(glue)
    && /\[cb commit\];\n\s*if \(wait\) \[cb waitUntilCompleted\];/.test(glue)
    && /void s3d_flush\(void\* ctx\) \{ s3d_flush_impl\(ctx, 1\); \}/.test(glue)
    && /void s3d_flush_async\(void\* ctx\) \{ s3d_flush_impl\(ctx, 0\); \}/.test(glue));

  // The sync flavour must survive, and only on the paths where the CPU reads the
  // target: readback, readback_render (BitmapData.draw), resize, destroy. A
  // wait-free draw path is the point; a wait-free READBACK would be a bug.
  const syncSites = [...glue.matchAll(/^\s+s3d_flush\(ctx\);\s*(?:\/\/.*)?$/gm)].length;
  check('the commit+wait flavour is used only by the CPU readback/resize/destroy paths',
    syncSites === 4
    && /int s3d_readback\(void\* ctx, uint8_t\* out\)[\s\S]{0,400}?s3d_flush\(ctx\);/.test(glue)
    && /int s3d_readback_render\(void\* ctx, uint8_t\* out\)[\s\S]{0,400}?s3d_flush\(ctx\);/.test(glue)
    && /int s3d_resize\(void\* ctx, int width, int height\)[\s\S]{0,600}?s3d_flush\(ctx\);/.test(glue)
    && /void s3d_destroy\(void\* ctx\)[\s\S]{0,600}?s3d_flush\(ctx\);/.test(glue));
  const drawBody = glue.slice(glue.indexOf('int s3d_draw(void* ctx, int numTriangles)'));
  check('s3d_draw never flushes (the batch is retired once at the frame boundary)',
    !/^\s+s3d_flush(?:_async)?\(ctx\);/m.test(drawBody.slice(0, drawBody.indexOf('\n}\n') + 3)));

  // The generated C: present() and the pre-composite flush are commit-only, and
  // nothing emits the waiting flavour any more.
  check('Context3D_present commits without waiting',
    /as_s3d_flush_async\(o->gpu\);/.test(emitted) && !/as_s3d_flush\(o->gpu\);/.test(emitted));
  check('ASC_window_render retires the batch before compositing, without waiting',
    /as_s3d_flush_all_async\(\);/.test(emitted) && !/as_s3d_flush_all\(\);/.test(emitted));
  check('the wrappers compile to nothing without a Stage3D backend',
    /static inline void as_s3d_flush_async\(void\* ctx\) \{\n#ifdef ASC_RENDER_STAGE3D\n    s3d_flush_async\(ctx\);\n#else\n    \(void\)ctx;\n#endif\n\}/.test(runtime)
    && /static inline void as_s3d_flush_all_async\(void\) \{\n#ifdef ASC_RENDER_STAGE3D\n    s3d_flush_all_async\(\);\n#endif\n\}/.test(runtime));

  // The GPU-time probe has to survive the split: an async commit has no completed
  // buffer to time, so it banks one and reads its interval at the next commit.
  check('the async flush still reports GPU time (banks the buffer it cannot time yet)',
    /asc_dbg_acc_commit \+= t_done - t0;/.test(glue)
    && /if \(asc_dbg_prev\.status == MTLCommandBufferStatusCompleted\)/.test(glue));

  // ABI parity: the web backend has no batch, so both flavours are glFlush().
  const webgl = readFileSync(join(root, 'vendor', 'stage3d_webgl.cc'), 'utf8');
  for (const sig of ['void s3d_flush(void* ctx)', 'void s3d_flush_async(void* ctx)',
                     'void s3d_flush_all(void)', 'void s3d_flush_all_async(void)']) {
    check(`stage3d_webgl keeps the ABI: ${sig.split('(')[0]}`,
      new RegExp(sig.replace(/[()*]/g, '\\$&') + ' \\{\\n(?:  \\(void\\)ctx;\\n)?  glFlush\\(\\);\\n\\}').test(webgl));
  }

  console.log(`     [stage3d] ${ok} check(s) passed`);
  return bad;
}

function checkStage3dWebglAbiCoverage(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [stage3d] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stage3d] ${label}`); }
  };

  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const webgl = readFileSync(join(root, 'vendor', 'stage3d_webgl.cc'), 'utf8');

  // The seam rule: runtime.ts is the one place that spells a bare `s3d_*` call
  // (the bodies of the `as_s3d_*` wrappers), and each target links exactly ONE
  // glue. So every symbol named there must exist in the WebGL glue too. This is
  // the check that would have caught the CubeTexture gap: the away3d-core and
  // air-starling-demo web builds both died at link time with "undefined symbol:
  // s3d_upload_cube_texture / s3d_set_sampler_state_i" — the emitted C called
  // them, the Metal glue defined them, the WebGL glue simply never did, and a
  // stale-artifact page then reported it as "stuck at the loading screen".
  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const referenced = new Set([...stripComments(runtime).matchAll(/\b(s3d_\w+)\s*\(/g)].map((m) => m[1]));
  const definedWeb = new Set([...webgl.matchAll(/^[A-Za-z_][\w \t\*]*\b(s3d_\w+)\s*\(/gm)].map((m) => m[1]));
  const missing = [...referenced].filter((n) => !definedWeb.has(n)).sort();
  check(`every s3d_* symbol the runtime calls is defined in the WebGL glue (missing: ${missing.join(', ') || 'none'})`,
    missing.length === 0 && referenced.size > 30);

  // Named explicitly as well, so the check keeps its teeth if the runtime ever
  // stops spelling these calls in the wrapper bodies.
  check('the WebGL glue defines the CubeTexture upload entry point',
    /^void\* s3d_upload_cube_texture\(void\* ctx, int unit, int size, const uint32_t\* const\* argb\)/m.test(webgl));
  check('the WebGL glue defines the AGAL sampler-state entry point',
    /^void s3d_set_sampler_state_i\(void\* ctx, int unit, int filter, int wrap, int mip\)/m.test(webgl));

  // A sampled cube unit must be bound as GL_TEXTURE_CUBE_MAP, and GL cannot be
  // asked what target a texture object has — hence the glue-side registry. An
  // empty unit has to clear BOTH targets, or a stale cube binding is what a 2D
  // sampler reads next (that is the observed failure mode, not a missing bind).
  check('the glue tracks each texture target itself (GL cannot report it)',
    /static void s3d_record_target\(S3DContext\* c, GLuint tex, int cube\)/.test(webgl)
    && /static GLenum s3d_tex_gltarget\(S3DContext\* c, GLuint tex\)/.test(webgl));
  check('an unused unit clears both the 2D and the cube binding',
    /glBindTexture\(GL_TEXTURE_2D, 0\)[\s\S]{0,200}?glBindTexture\(GL_TEXTURE_CUBE_MAP, 0\)/.test(webgl));

  // glClear honours the GL write masks, a Metal loadAction=Clear does not. A
  // pass that left depthWrite off (depth compare never on) therefore used to
  // skip the NEXT frame's deferred depth clear: the previous frame's depth kept
  // the skybox (z=1.0) and every later draw out, and the torus silhouette stayed
  // as a black disc. Force all three masks on for the clear.
  const draw = webgl.slice(webgl.indexOf('int s3d_draw(void* ctx, int numTriangles)'));
  check('the deferred clear forces the write masks on first (GL masks gate glClear)',
    /(?:[^\{]|\{[^{}]*\}){0,200}glDepthMask\(GL_TRUE\);[\s\S]{0,200}?glColorMask\(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE\);[\s\S]{0,200}?glStencilMask\(0xFF\);[\s\S]{0,200}?glClear\(bits\);/.test(draw));

  console.log(`     [stage3d] ${ok} check(s) passed`);
  return bad;
}

// Program-cache pin: a Stage3D scene may switch Program3D between draws, and the
// compiled program must be BOUND, not recompiled. away3d's Basic_SkyBox draws its
// torus and its skybox alternately, so the emitter's depth-1 guard
// (`o->program != o->gpuProgram`) fires on every draw — before this fix that
// recompiled both MSL programs AND rebuilt both MTLRenderPipelineStates per draw
// (measured: 8,000 compiles + 8,000 pipelines in 8,000 draws). Each build hands
// Metal a fresh MTLVertexDescriptor, which the driver's pipeline cache keeps, so
// the process grew ~62 MB/min of MALLOC_SMALL and never levelled off. AIR behaves
// the way the fix does: Program3D.upload compiles once, setProgram binds.
function checkStage3dProgramCache(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [stage3d] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stage3d] ${label}`); }
  };

  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const glue = readFileSync(join(root, 'vendor', 'stage3d_glue.mm'), 'utf8');
  const webgl = readFileSync(join(root, 'vendor', 'stage3d_webgl.cc'), 'utf8');
  const emitted = emittedLines();

  // The two halves of the seam: the generated C names the Program3D (the cache
  // key), and the runtime wrapper forwards it to the glue.
  check('the emitter hands the Program3D identity to the backend as the cache key',
    /as_s3d_compile\(o->gpu, \(void\*\)o->program, vs, fs, errbuf, \(int\)sizeof\(errbuf\)\)/.test(emitted));
  check('the runtime wrapper forwards the key (and still compiles to nothing without Stage3D)',
    /return s3d_compile\(ctx, key, vs, fs, errbuf, errbuf_size\);/.test(runtime)
    && /static inline int as_s3d_compile\(void\* ctx, void\* key, const char\* vs, const char\* fs, char\* errbuf, int errbuf_size\)/.test(runtime));

  // Both backends share one shape: a bounded, LRU-stamped cache of compiled
  // programs keyed by the Program3D identity, with the live program moved in/out
  // of a slot on a switch (exactly one place owns each function/program).
  const backends: [string, string][] = [['Metal', glue], ['WebGL', webgl]];
  for (const [name, src] of backends) {
    check(`${name}: s3d_compile takes the Program3D key`, /int s3d_compile\(void\* ctx, void\* key, /.test(src));
    check(`${name}: the entry point keeps a bounded per-Program3D program cache`,
      /#define S3D_MAX_PROGRAMS 16/.test(src) && /s3d_prog_stash\(/.test(src) && /s3d_prog_load\(/.test(src)
      && /S3DProgramCache progs\[S3D_MAX_PROGRAMS\];/.test(src));
    check(`${name}: a repeat of the same source is a BIND, not a recompile`,
      /cached >= 0 && c->progs\[cached\]\.srcHash == srchash/.test(src)
      && /if \(c->progKey != key\) \{ s3d_prog_stash\(c\); s3d_prog_load\(c, cached\); return 1; \}/.test(src));
    check(`${name}: the slot's identity includes the SOURCE, so a re-uploaded program recompiles`,
      /s3d_src_hash\(/.test(src) && /unsigned long long srcHash;/.test(src));
    check(`${name}: teardown releases every cached program (no leak on context destroy)`,
      /for \(int i = 0; i < c->nprogs; i\+\+\) s3d_prog_release\(&c->progs\[i\]\);/.test(src));
    // wasm32 (and LLP64) make `unsigned long` 32 bits, so the FNV constants
    // overflowed there — the whole web build failed on the too-large literal.
    check(`${name}: the source hash stays 64-bit on wasm32 (ULL, not UL)`,
      /unsigned long long h = 1469598103934665603ULL;/.test(src) && !/1469598103934665603UL;/.test(src));
  }

  // The ORDER is what makes it a fix: the cache decision has to be reached before
  // the first driver compile in the body, or the program is rebuilt anyway.
  const metalHead = glue.slice(glue.indexOf('int s3d_compile(void* ctx, void* key,'), glue.indexOf('newLibraryWithSource'));
  check('Metal settles the cache hit BEFORE reaching the MSL compiler',
    metalHead.length > 0 && /return 1;/.test(metalHead) && /s3d_prog_load\(c, cached\)/.test(metalHead));
  const webglHead = webgl.slice(webgl.indexOf('int s3d_compile(void* ctx, void* key,'), webgl.indexOf('GLuint vs = glCreateShader'));
  check('WebGL settles the cache hit BEFORE creating a shader object',
    webglHead.length > 0 && /return 1;/.test(webglHead) && /s3d_prog_load\(c, cached\)/.test(webglHead));

  // The probe that evidenced the bug lives on as the cheap way to re-check it:
  // with AS_S3D_TRACE=1, make_pso must track the number of PROGRAMS, not the
  // number of draws. That ratio is the whole regression in one line.
  check('the AS_S3D_TRACE probe reports draws against pipeline builds',
    /getenv\("AS_S3D_TRACE"\)/.test(glue)
    && /"TRACE draw=%ld compile=%ld make_pso=%ld pso_miss=%ld/.test(glue));

  console.log(`     [stage3d] ${ok} check(s) passed`);
  return bad;
}

registerGroup('stage3d/flush-policy', checkStage3dFlushPolicy);
registerGroup('stage3d/webgl-abi', checkStage3dWebglAbiCoverage);
registerGroup('stage3d/program-cache', checkStage3dProgramCache);
