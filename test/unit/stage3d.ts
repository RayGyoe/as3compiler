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
import { registerGroup, root, readNorm } from '../harness.ts';

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
  // 阶段三百二十：越界 level 从「静默 return」改成 AIR 的 #3674 —— adl 51.4.1 实测
  // （temp/s3dupload/ChainProbe.as）：4x4 的 level 2（1x1）成功，level 3 与 level 9
  // 都抛 ArgumentError #3674 "Miplevel too large."。检查也提到 gpu 检查之前，
  // 因为 AIR 没有惰性纹理句柄，答案不能取决于我方 GPU 状态。
  check('levels beyond max(w,h) are rejected with AIR #3674 (MTLTexture would fault on a missing level)',
    /if \(\(int\)miplevel >= nlv\) \{ as_s3d_mip_too_large\(\); return; \}/.test(emitted));
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
  // A literal '\n}\n' probe matches NOTHING in this CRLF checkout, which silently
  // reduced every body below to the signature's first two characters (so the two
  // checks further down asserted against "st" and failed for the wrong reason).
  const bodyOf = (sig: string): string => {
    const i = runtime.indexOf(sig);
    if (i < 0) return '';
    const m = /\r?\n\}\r?\n/.exec(runtime.slice(i));
    return m == null ? '' : runtime.slice(i, i + m.index);
  };

  // Both slot walkers: the dest slot is consumed unconditionally, and the old
  // `if (hasDst) pos += 4;` form -- the bug -- is gone.
  for (const sig of ['static void as_agal_sampler_flags(',
                     'static char* as_agal_translate(']) {
    const name = sig.split(' ').pop()!.replace('(', '');
    const body = bodyOf(sig);
    check(`${name} skips the always-present dest slot before reading src1`,
      body !== '' && /pos \+= 4;\r?\n\s*if \(hasSrc1\)/.test(body)
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

// nrm: what adl 51.4.1 ACTUALLY does, measured in temp/agalprobe (a Stage3D pixel
// probe run under adl AND under our own Metal build -- identical readbacks):
//   * nrm's divisor is |xyz| only. nrm of (3,4,0,7) reads back 0.6/0.8 in rgb,
//     i.e. divided by 5, not by |xyzw| = 8.6023.
//   * a masked nrm leaves the destination's w untouched; `nrm ft0, fc0` (mask that
//     includes w) is refused at upload with Error #3628, so w has no nrm value at
//     all.
// The translator used to normalize all four components ('normalize(ft0)') and to
// accept a w-masked destination -- two silent divergences from AIR.
function checkStage3dAgalNrm(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean) => {
    if (cond) { ok++; console.log(`PASS  [stage3d] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stage3d] ${label}`); }
  };
  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const bodyOf = (sig: string): string => {
    const i = runtime.indexOf(sig);
    if (i < 0) return '';
    const m = /\r?\n\}\r?\n/.exec(runtime.slice(i));
    return m == null ? '' : runtime.slice(i, i + m.index);
  };
  const body = bodyOf('static void agal_emit_body(');

  check('nrm normalizes the source .xyz, never all four components',
    /normalize\(%s\.xyz\)/.test(body) && !/normalize\(%s\)/.test(body));
  check('nrm re-widens its 3-component result before a component is picked',
    /%s\(normalize\(%s\.xyz\), 0\.0\)\.%c/.test(body));
  check('a swizzled nrm source is gathered by component (no double swizzle)',
    /%s\(normalize\(%s\(%s\.%c, %s\.%c, %s\.%c\)\), 0\.0\)\.%c/.test(body));
  check('nrm picks the DESTINATION component, not the source swizzle component',
    /normalize\(%s\.xyz\), 0\.0\)\.%c", v4, s1b, ch\)/.test(body));
  check('a w-masked nrm is refused with adl\'s Error #3628',
    /if \(op == 0x0e && \(dmask & 0x8\)\)/.test(body)
    && /nrm must not write w \(adl rejects the program with Error #3628/.test(runtime));
  console.log(`     [stage3d] ${ok} check(s) passed`);
  return bad;
}

registerGroup('stage3d/agal-nrm', checkStage3dAgalNrm);

// AGAL version ceiling. asaot3d assembles with AGAL 4 and asks for the
// `enhanced` Context3D profile, because that is the only profile AIR 51.4.1
// accepts v4 under (measured matrix: enhanced takes v2/v3/v4, standardExtended
// v2/v3, standard v2, baseline/baselineExtended none). The translator's header
// check used to stop at 3 and rejected those programs with "AGAL: unsupported
// version" before decoding a single instruction.
//
// The instruction budget matters for the same reason: v4 programs are longer
// (the assembler may need an extra `mov` per constant-only operand), and a cap
// that is too low reports a bogus "too many instructions" on a program AIR
// compiles happily.
function checkStage3dAgalVersions(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [stage3d] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stage3d] ${label}`); }
  };
  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');

  check('the AGAL header accepts versions 1..4 (v4 is the enhanced-profile ceiling)',
    /if \(version < 1 \|\| version > 4\)/.test(runtime));
  check('anything above v4 is still rejected, not silently decoded',
    !/version > 5/.test(runtime));
  check('the instruction budget is 400 (v4 programs are longer than v3 ones)',
    /agal_instr ins\[400\]/.test(runtime) && /if \(n >= 400\)/.test(runtime)
    && !/agal_instr ins\[200\]/.test(runtime));

  console.log(`     [stage3d] ${ok} check(s) passed`);
  return bad;
}

registerGroup('stage3d/agal-versions', checkStage3dAgalVersions);

// Reading a temporary register before writing it is an UPLOAD ERROR on adl, not a
// zero read: measured in temp/agalprobe (upload.txt, plus bytes2.txt which feeds
// Adobe's own AGALMiniAssembler output, so this is not an artefact of our hand
// encoding) -- Error #3647 for a whole register, #3648 for a single component.
// Translating such a program would put an uninitialised local in the MSL/GLSL/HLSL
// we emit, i.e. undefined behaviour.
function checkStage3dAgalTempWrites(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean) => {
    if (cond) { ok++; console.log(`PASS  [stage3d] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stage3d] ${label}`); }
  };
  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const bodyOf = (sig: string): string => {
    const i = runtime.indexOf(sig);
    if (i < 0) return '';
    const m = /\r?\n\}\r?\n/.exec(runtime.slice(i));
    return m == null ? '' : runtime.slice(i, i + m.index);
  };
  const body = bodyOf('static const char* agal_check_temp_writes(');

  check('the write-tracking validator exists and is called before emitting',
    body !== '' && /agal_check_temp_writes\(ins, n\)/.test(runtime));
  check('it tracks a component mask per register (not just "written")',
    /wrote\[num\] & need\) == need/.test(body) && /wrote\[num\] \|= \(unsigned\)\(\(I->dst >> 16\) & 0xFu\)/.test(body));
  check('the components a read touches come from the source swizzle',
    /unsigned swz = \(lo >> 24\) & 0xFFu;/.test(body)
    && /need \|= 1u << \(\(swz >> \(2 \* c\)\) & 3u\)/.test(body));
  check('a tex/tld sampler slot is not mistaken for a register read',
    /j == 1 && \(op == 0x28 \|\| op == 0x2e\)/.test(body));
  check('the refusal names AIR\'s own error numbers',
    /read before it is written \(adl rejects the program with Error #3647\/#3648\)/.test(body));
  console.log(`     [stage3d] ${ok} check(s) passed`);
  return bad;
}

registerGroup('stage3d/agal-temp-writes', checkStage3dAgalTempWrites);

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

  const runtime = readNorm(join(root, 'src', 'runtime.ts'));
  const glue = readNorm(join(root, 'vendor', 'stage3d_glue.mm'));
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
  const webgl = readNorm(join(root, 'vendor', 'stage3d_webgl.cc'));
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
// AGAL -> HLSL (stage 131): the third translation target, i.e. the prerequisite for
// a Windows/D3D12 Stage3D backend. The groups above pin the slot walk and the
// sampler flags; this one pins that target 2 is a genuine third dialect.
//
// What is actually being guarded. as_agal_translate is ONE implementation
// parameterised by `target`, and the arms of its shared emitters used to be written
// as "if (target == 0) ... else ..." where the else meant GLSL. Adding a third
// target therefore risks the opposite of a missing feature: an HLSL shader quietly
// carrying a GLSL identifier (gl_FragColor, gl_Position, mix(), greaterThanEqual()).
// That is the "compiles but the result is wrong" failure AGENTS.md 2.5 forbids, and
// no example can catch it -- examples/ runs in pure-C mode, with no GPU and no D3D
// compiler anywhere near it.
//
// So the proof is split deliberately:
//   - examples/stage80.as asserts the emitted text for every instruction class in
//     all three dialects, and that the MSL/GLSL text is unchanged;
//   - temp/hlslcheck compiles every generated HLSL shader with Microsoft's fxc
//     (d3dcompiler_47, vs_4_0/ps_4_0). The two rules marked "fxc" below were found
//     only by that run and are pinned here so they cannot regress without a GPU.
function checkStage3dAgalHlsl(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [stage3d] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stage3d] ${label}`); }
  };

  // Line endings are normalised first: the checkout is CRLF on Windows and LF in
  // CI, and a pattern that only matches one of them is a false failure, not a
  // finding (the same trap the operand-slot group documents).
  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8').replace(/\r\n/g, '\n');
  const airApp = readFileSync(join(root, 'src', 'air-app.ts'), 'utf8').replace(/\r\n/g, '\n');
  const emitted = emittedLines();
  // Whole-line comments quote the very spellings under test, so commentary is
  // removed before any check that asserts a spelling is ABSENT.
  const noComments = (s: string): string => s.replace(/^[ \t]*\/\/.*$/gm, '');
  const region = (from: string, to: string): string => {
    const i = runtime.indexOf(from);
    const j = i < 0 ? -1 : runtime.indexOf(to, i);
    return i >= 0 && j > i ? runtime.slice(i, j) : '';
  };

  // ---- target selection ------------------------------------------------------
  // An explicit three-way ladder, with 2 tested before 1: a build that mentions
  // only GLSL must keep meaning GLSL, and one that mentions neither keeps meaning
  // MSL (so a build that never touches Stage3D is byte-identical to before).
  check('ASC_S3D_HLSL selects target 2, ahead of the GLSL arm and the MSL fallback',
    /#ifdef ASC_S3D_HLSL\n#define ASC_AGAL_TARGET 2\n#elif defined\(ASC_S3D_GLSL\)\n#define ASC_AGAL_TARGET 1\n#else\n#define ASC_AGAL_TARGET 0\n#endif/.test(runtime));
  // The AS3-facing bridge has to name "hlsl" explicitly; anything unrecognised
  // still falls back to MSL (that fallback is asserted in examples/stage80.as).
  check('AGALTranslator.translate maps the "hlsl" target string to 2',
    emitted.includes('strcmp(target, "hlsl") == 0) ? 2 : 0'));
  // driverInfo is compile-time selected and the order of the arms is load-bearing:
  // a Windows Stage3D build defines ASC_S3D_HLSL *and* ASC_RENDER_STAGE3D, so a D3D
  // arm placed after the Metal one would report "Metal (Stage3D)" on Windows.
  const diStart = emitted.indexOf('#if defined(ASC_S3D_GLSL)');
  const diEnd = emitted.indexOf('#endif', diStart);
  const di = diStart >= 0 && diEnd > diStart ? emitted.slice(diStart, diEnd) : '';
  check('driverInfo has a D3D arm before the Metal arm',
    di.includes('#elif defined(ASC_S3D_HLSL)') && di.includes('Direct3D12')
    && di.indexOf('#elif defined(ASC_S3D_HLSL)') < di.indexOf('#elif defined(ASC_RENDER_STAGE3D)'));

  // ---- dialect isolation -----------------------------------------------------
  // Every GLSL built-in must sit inside an explicit "if (target == 1)" test. A bare
  // 'else' emitting one is precisely how a two-way arm becomes a wrong third target.
  // Leading whitespace is allowed inside the literal ("  gl_FragDepthEXT = od.x;"),
  // and `gl_FragDepth` matches its ES 1.00 extension spelling `gl_FragDepthEXT`
  // too -- that name is the one a wrong ES-level assumption gets wrong.
  const glslLines = noComments(runtime).split('\n').filter((l) => /"\s*(gl_Position|gl_FragColor|gl_FragDepth)/.test(l));
  // Two legitimate homes for a GL built-in: a line that carries its own
  // "target == 1" test, or the body of the GLSL branch (which IS the test). Stage
  // 261's `gl_FragDepthEXT = od.x;` lives in the second kind, so the pin checks the
  // branch too instead of being weakened to "no check at all".
  const glslBranch = region('// ---- GLSL ES 1.00', '// ---- HLSL (Direct3D shader model 4+)');
  const inGlslBranch = (l: string): boolean => glslBranch.includes(l.trim());
  check('every GLSL built-in is emitted only under an explicit target == 1 test',
    glslLines.length >= 3 && glslLines.every((l) => l.includes('target == 1') || inGlslBranch(l)));
  const msl = region('// ---- MSL ----', '// ---- GLSL ES 1.00');
  const hlsl = region('// ---- HLSL (Direct3D shader model 4+) ----', 'char* out = as_str_alloc(b.len + 1);');
  check('the MSL branch carries no D3D or GL spelling',
    msl.length > 500 && !/SV_|cbuffer|TEXCOORD|\.Sample\(|gl_Position|gl_FragColor/.test(noComments(msl)));
  check('the HLSL branch carries no GL or Metal spelling',
    hlsl.length > 1500 && !/"gl_|metal_stdlib|\[\[stage_in\]\]|\.sample\(/.test(noComments(hlsl)));
  check('the HLSL vertex stage does not flip clip-space Y (D3D is top-down like AS3)',
    !/"gl_Position\.y = -/.test(noComments(hlsl)) && hlsl.includes('output.position = op;'));

  // ---- the shared register/instruction emitters -----------------------------
  // These are the exact branches that had to grow a third arm; each one is pinned so
  // a revert to the two-way form is a test failure rather than a wrong shader.
  check('the HLSL register names are all three-way',
    runtime.includes('else if (target == 2) sprintf(out, "input.a%d", num);')
    && runtime.includes('else if (agal_is_frag && target == 2) sprintf(out, "input.v%d", num);')
    && runtime.includes('else if (target == 2 && num != 0) sprintf(out, "oc%d", num);')
    // `iid` is a system value on D3D/Metal and NON-EXISTENT on ES 1.00: HLSL and
    // MSL get the uint broadcast to a float4, and the GLSL target never reaches
    // this name because as_agal_translate refuses the program first (pinned below).
    && runtime.includes('else strcpy(out, "float4(iid, iid, iid, iid)");'));
  // The refusals that replaced the undeclared-register spellings. A program that
  // reads `iid` must either get a real system value or a CLEAR error -- never a
  // shader the driver cannot compile.
  check('iid is refused on the GLSL target and in fragment programs',
    runtime.includes('"AGAL: iid is not available on the GLSL target (ES 1.00 has no gl_InstanceID)"')
    && runtime.includes('"AGAL: iid is readable only in a vertex program"'));
  // Both od arms must hand the depth slot a COMPONENT of the four-component local:
  // the write mask can be 0xF (whole register) or a per-component subset, so a
  // scalar local cannot hold what the emitter writes.
  check('od is a float4/vec4 local on every target, with the depth slot fed from .x',
    runtime.includes('if (hasOd) as_json_buf_append_cstr(&b, "  float4 od;')
    && runtime.includes('fso.depth = od.x;') && runtime.includes('output.depth = od.x;')
    && runtime.includes('gl_FragDepthEXT = od.x;'));
  check('the HLSL instruction spellings are all three-way',
    runtime.includes('(target == 2) ? "frac" : "fract"')
    && runtime.includes('(target == 2) ? "ddx"')
    && runtime.includes('(target == 2) ? "ddy"')
    && runtime.includes('rsqrt(%s)') && runtime.includes('saturate(%s)')
    && runtime.includes('.Sample(smp%d,'));

  // ---- the HLSL dialect shape ------------------------------------------------
  check('HLSL binds the D3D system values it needs',
    hlsl.includes(': SV_Position') && hlsl.includes(': SV_Target%d')
    && hlsl.includes(': SV_Depth') && hlsl.includes(': SV_InstanceID'));
  // The VS float4 `position : SV_Position` field must be declared AFTER the varyings,
  // and this one is a pure D3D12 linkage rule rather than a style choice: fxc numbers
  // a stage struct's registers in declaration order, and D3D12 matches the VS output
  // to the PS input by semantic name+index AND by that register number. With
  // SV_Position first, VSOut's TEXCOORD0 sat at register 1 while FSIn's sat at 0, and
  // CreateGraphicsPipelineState failed with "Vertex Shader - Pixel Shader linkage
  // error: Signatures between stages are incompatible". Walking AGAL_V ascending on
  // both sides lines the two sequences up. MSL/GLSL are order-insensitive, so only
  // the HLSL arm carries this.
  check('HLSL declares the varyings before SV_Position (fxc register order)',
    hlsl.indexOf(': SV_Position') > hlsl.indexOf('varying%d : TEXCOORD%d')
    && hlsl.indexOf('varying%d : TEXCOORD%d') >= 0);
  check('HLSL constants live in cbuffers bound at b0',
    hlsl.includes('cbuffer VCBuf : register(b0)') && hlsl.includes('cbuffer FCBuf : register(b0)'));
  check('HLSL declares one texture and one sampler per sampled register',
    hlsl.includes(': register(t%d)') && hlsl.includes(': register(s%d)')
    && hlsl.includes('Texture2D<float4>') && hlsl.includes('TextureCube<float4>'));

  // ---- the two rules only fxc could teach ------------------------------------
  // fxc rejects EVERY scalar-splat numeric constructor at vs_4_0/ps_4_0: both
  // float4(dot(a, b)) and even float4(1.0) fail with X3014 "incorrect number of
  // arguments to numeric-type constructor", with or without
  // D3DCOMPILE_ENABLE_STRICTNESS (ps_6_0/DXC accepts it). A scalar dot product
  // therefore splats through HLSL's scalar swizzle instead.
  check('fxc: a scalar dot product splats with .xxxx, never float4(scalar)',
    runtime.includes('dot(%s.xyz, %s.xyz).xxxx') && runtime.includes('dot(%s, %s).xxxx')
    && !noComments(runtime).includes('float4(dot('));
  // fxc also rejects an EMPTY struct, so a stage-input struct may only be declared
  // when the program genuinely reads an attribute/varying -- and the entry signature
  // has to follow (a shader with no inputs takes no parameter at all).
  check('fxc: the vertex stage-input struct is guarded by actual attribute use',
    hlsl.includes('int hasVA = 0; for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_VA, i)) { hasVA = 1; break; }')
    && hlsl.includes('if (hasVA) as_json_buf_append_cstr(&b, "VSIn input");')
    && hlsl.indexOf('"struct VSIn {') > hlsl.indexOf('if (hasVA) {'));
  check('fxc: the fragment stage-input struct is guarded by actual varying use',
    hlsl.includes('int hasV = 0;')
    && hlsl.includes('hasV ? "FSOut fs_main(FSIn input)') && hlsl.includes('"FSOut fs_main() {')
    && hlsl.indexOf('"struct FSIn {') > hlsl.indexOf('if (hasV) {'));

  // ---- the Windows backend is wired, and the wiring is what used to be refused ---
  // Until stage3d_d3d.cc existed, --air-app on Windows had to REFUSE a Stage3D app:
  // linking stage3d_glue.mm there cannot compile, and leaving every as_s3d_* a no-op
  // meant a black stage (the silent-wrong-result case). The refusal is gone, so the
  // pin moves to the wiring it was replaced by -- a Windows build must take the D3D
  // branch, which means the D3D glue, the HLSL dialect and the three D3D libs, and
  // never the Metal glue/frameworks.
  check('a Windows Stage3D build compiles the D3D glue with the HLSL dialect',
    /if \(onWin\) \{[\s\S]{0,400}?stage3d_d3d\.cc[\s\S]{0,400}?ASC_S3D_HLSL=1[\s\S]{0,600}?stage3d_glue\.mm/.test(airApp)
    && airApp.includes("'d3d12', 'dxgi', 'd3dcompiler'"));
  check('the Windows Stage3D refusal is gone (the translator AND the backend exist now)',
    !/if \(onWin\) \{\n\s*throw new AirAppError\(/.test(airApp)
    && !airApp.includes('has not been written'));
  check('the web branch still selects GLSL for stage3d_webgl.cc',
    airApp.includes("defines.push('ASC_S3D_GLSL=1')") && airApp.includes('stage3d_webgl.cc'));
  // A new target must not soften "we cannot translate this": an untranslatable
  // opcode stays a hard error on all three, never a silently dropped instruction.
  check('an untranslatable opcode still names all three targets in its diagnostic',
    runtime.includes('is not translated to MSL/GLSL/HLSL yet'));

  console.log(`     [stage3d] ${ok} check(s) passed`);
  return bad;
}

registerGroup('stage3d/agal-hlsl', checkStage3dAgalHlsl);

// Windows/Direct3D 12 backend pins (vendor/stage3d_d3d.cc + vendor/d3d_glue.cc).
//
// The D3D backend is a SECOND full implementation of the same s3d_* ABI, so it earns
// the same seam check the WebGL glue has: runtime.ts is the only place that spells a
// bare `s3d_*` call, and each target links exactly ONE glue, so every symbol named
// there must exist here too. A gap is not a soft failure -- it is the Windows link
// error "undefined symbol: s3d_..." (which is exactly how the WebGL cube-texture gap
// announced itself on the web target), or a silently black stage.
function checkStage3dD3dGlue(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [stage3d] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stage3d] ${label}`); }
  };

  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const d3d = readFileSync(join(root, 'vendor', 'stage3d_d3d.cc'), 'utf8');
  const glue = readFileSync(join(root, 'vendor', 'd3d_glue.cc'), 'utf8');
  const emitSrc = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const airApp = readFileSync(join(root, 'src', 'air-app.ts'), 'utf8');
  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  const referenced = new Set([...stripComments(runtime).matchAll(/\b(s3d_\w+)\s*\(/g)].map((m) => m[1]));
  const definedD3d = new Set([...d3d.matchAll(/^[A-Za-z_][\w \t\*]*\b(s3d_\w+)\s*\(/gm)].map((m) => m[1]));
  const missing = [...referenced].filter((n) => !definedD3d.has(n)).sort();
  check(`every s3d_* symbol the runtime calls is defined in the D3D glue (missing: ${missing.join(', ') || 'none'})`,
    missing.length === 0 && referenced.size > 30);

  // The window backend's device/queue must be shared, not duplicated: Stage3D submits
  // on the SAME D3D12 queue Ganesh composites on, which is what turns "submitted
  // earlier" into "the GPU already has the pixels" with no CPU wait (the D3D
  // counterpart of stage3d_glue.mm's sk_mtl_shared_queue). It is looked up by NAME
  // through the loaded module -- not linked -- because a Stage3D-only build may omit
  // the window glue entirely and a hard reference would then be an unresolved
  // external in every such build.
  check('the D3D glue exports the shared device/queue for Stage3D to join',
    /__declspec\(dllexport\)[^\n]*\bsk_d3d_shared_queue\s*\(/.test(glue)
    && /__declspec\(dllexport\)[^\n]*\bsk_d3d_shared_device\s*\(/.test(glue));
  check('Stage3D looks the shared device/queue up by name with a loud private fallback',
    d3d.includes('sk_d3d_shared_queue') && d3d.includes('sk_d3d_shared_device')
    && /GetProcAddress/.test(d3d)
    && /no shared D3D12|private device|its own device/.test(d3d));

  // ---- THE OWNERSHIP PIN ------------------------------------------------------
  // Skia's D3D backend has no Borrow/Adopt notion: GrD3DTextureResourceInfo's
  // fResource is a gr_cp, and its bare-pointer constructor ADOPTS the pointer WITHOUT
  // AddRef while the destructor still Releases it. Wrapping a BORROWED resource with
  // that constructor therefore eats the owner's only reference: the Stage3D render
  // target was freed as sk_gpu_draw_texture returned, and the next allocation
  // recycled its address. Measured, per-frame: frame 1's composite saw
  // desc(dim=3 TEXTURE2D fmt=87 1000x600) and drew; frame 2's GetDesc() on the SAME
  // pointer reported a 144-byte vertex BUFFER (dim=1 fmt=0 w=144), so
  // sk_gpu_draw_texture refused it -- "unsupported render target (dxgi format 0, 1
  // samples); nothing was drawn" -- and the Stage3D frame never reached the window.
  // It looked intermittent only because a just-released driver object often still
  // reads back valid until the allocator hands its block out again.
  // retain() is the balanced recipe (AddRef into the struct; its dtor releases that
  // reference), and is exactly what Skia's own tools/window/win/D3D12WindowContext_win.cpp
  // does with `info.fResource = fBuffers[i]` (gr_cp copy-assignment AddRefs).
  check('the D3D window glue never wraps a borrowed resource with the adopting constructor',
    !/GrD3DTextureResourceInfo\s+\w+\s*\(\s*(?!nullptr)/.test(stripComments(glue)));
  check('both D3D wrap sites retain() their resource instead of adopting it',
    (stripComments(glue).match(/\.retain\(/g) || []).length >= 2
    && /draw_texture/.test(glue));
  check('the ownership contract is documented where it bit (GrD3DTypes.h / retain)',
    glue.includes('borrowed') || glue.includes('BORROW'));

  // The composite condition: a GPU backend that renders INTO a texture (Metal, D3D12)
  // composites that texture into the window's canvas, while the CPU backend
  // (ASC_RENDER_GPU) owns a pixel buffer and instead draws it in the `#elif` arm.
  // Handing a pixel backend into the texture-composite arm would pass a uint8_t*
  // where an ID3D12Resource* is expected.
  check('the composite arm is gated on the two texture-rendering backends only',
    emitSrc.includes('#if defined(ASC_RENDER_METAL) || defined(ASC_RENDER_D3D)')
    && emitSrc.includes('#elif defined(ASC_RENDER_GPU)'));
  check('present()/the pre-composite flush arm also covers the D3D texture path',
    emitSrc.includes('#if defined(ASC_RENDER_METAL) || defined(ASC_RENDER_D3D) || defined(ASC_RENDER_GPU)'));
  check('the D3D glue implements the composite entry point the generated C calls',
    /void sk_gpu_draw_texture\(void\* canvas, void\* d3dTexture, int w, int h,/.test(glue));

  // ---- THE CONSTANT-REGION PIN ---------------------------------------------------
  // D3D12 reads a root CBV when the GPU EXECUTES the command list (end of frame),
  // while the generated C re-uploads the whole register file immediately before every
  // drawTriangles (Context3D_submit). One constant buffer per frame slot therefore made
  // every draw read the LAST upload's matrix: measured on examples/air-starling-demo,
  // all 12 menu buttons were transformed by the final button's mvp (11 left the screen),
  // while Metal -- whose setVertexBytes copies the values inline -- never saw it. Each
  // upload now owns a REGION inside the slot's buffer and a draw binds the region of the
  // last upload; every part below is load-bearing (dropping one reproduces the bug).
  const bodyOfIn = (src: string, sig: string): string => {
    const i = src.indexOf(sig);
    if (i < 0) return '';
    const m = /\r?\n\}\r?\n/.exec(src.slice(i));
    return m == null ? '' : src.slice(i, i + m.index);
  };
  const region = /#define S3D_CB_REGION (\d+)/.exec(d3d);
  check(`the constant region is a whole number of float4 (${region == null ? 'missing' : 'S3D_CB_REGION=' + region[1]})`,
    region != null && Number(region[1]) > 0 && Number(region[1]) % 256 === 0);
  check('each frame slot holds S3D_DRAWS_PER_FRAME constant regions',
    /#define S3D_CB_BYTES \(S3D_CB_REGION \* S3D_DRAWS_PER_FRAME\)/.test(d3d));

  const upload = bodyOfIn(d3d, 'int s3d_upload_constants(');
  check('an upload advances the per-stage cursor and remembers its region',
    upload !== '' && /UINT\* cur = isFragment \? &c->cbCurF : &c->cbCurV;/.test(upload)
    && /\*cur = off \+ \(UINT\)S3D_CB_REGION;/.test(upload)
    && /if \(isFragment\) c->cbOffF = off; else c->cbOffV = off;/.test(upload));
  check('an oversize register file is refused loudly, never truncated',
    /if \(need > S3D_CB_REGION\)/.test(upload)
    && /constants need %u bytes, one region holds %u/.test(upload));
  check('running out of regions in one frame warns instead of silently wrapping',
    /constant regions exhausted/.test(upload) && /\*cur = 0;/.test(upload));
  check('the CPU waits the slot before writing into one of its regions',
    /s3d_wait_slot\(c, slot\);/.test(upload));
  check('a draw binds the region the last upload left on each stage',
    /SetGraphicsRootConstantBufferView\(0,\s*vcb->GetGPUVirtualAddress\(\) \+ c->cbOffV\)/.test(d3d)
    && /SetGraphicsRootConstantBufferView\(1,\s*fcb->GetGPUVirtualAddress\(\) \+ c->cbOffF\)/.test(d3d));

  // The cursor reset lives in batch_end, NOT batch_begin: the FIRST upload of a frame
  // precedes anything opening the batch, so a reset there discarded the region that
  // upload had just written and left draws 0 and 1 sharing region 0 (measured in the
  // per-draw dump: cbV=0 on BOTH draw 0 and draw 1).
  const batchEnd = bodyOfIn(d3d, 'static void s3d_batch_end(');
  const batchBegin = bodyOfIn(d3d, 'static int s3d_batch_begin(');
  check('the constant-region cursor is rewound in batch_end',
    /c->cbCurV = c->cbCurF = 0;/.test(batchEnd));
  check('batch_begin leaves the constant-region cursor alone',
    batchBegin !== '' && !/cbCurV|cbCurF|cbOffV|cbOffF/.test(batchBegin));

  // ---- THE DEFERRED-RELEASE PIN --------------------------------------------------
  // A D3D12 resource handed to s3d_defer_release while a batch is being RECORDED is
  // already bound by that batch's earlier draws, and its submission has not happened
  // yet -- so the last SIGNALLED fence value says nothing about it. Recording fenceNext
  // there released the resource out from under the GPU: measured on
  // examples/air-starling-demo after a scene switch, 171 of 171 releases happened with
  // a batch open, the recycled memory became the NEXT texture's storage, one text quad
  // sampled another text's pixels and the device was removed (Present: 0x887A0005).
  // ONE bug, TWO symptoms -- they must not be debugged separately. All three parts
  // below are load-bearing.
  const defer = bodyOfIn(d3d, 'static void s3d_defer_release(');
  check('a release deferred while a batch is open is parked on fence 0 (tie it to the NEXT submission)',
    /c->rel\[c->nrel\]\.fence = c->listOpen \? 0 : c->fenceNext;/.test(defer)
    && /next submission/.test(defer) && /listOpen/.test(defer));
  check('both drain loops skip entries parked on fence 0 and keep them queued',
    (d3d.match(/c->rel\[i\]\.fence != 0 && c->rel\[i\]\.fence <= done/g) || []).length === 2
    && (d3d.match(/c->rel\[i\]\.fence <= done/g) || []).length === 2
    && (d3d.match(/else c->rel\[w\+\+\] = c->rel\[i\];/g) || []).length === 2);
  check('batch_end stamps every parked entry with the fence THAT submission signed',
    /const uint64_t v = \+\+c->fenceNext;/.test(batchEnd)
    && batchEnd.indexOf('ExecuteCommandLists') < batchEnd.indexOf('c->rel[i].fence = v;')
    && batchEnd.indexOf('const uint64_t v = ++c->fenceNext;') < batchEnd.indexOf('c->rel[i].fence = v;')
    && /for \(int i = 0; i < c->nrel; i\+\+\) if \(c->rel\[i\]\.fence == 0\) c->rel\[i\]\.fence = v;/.test(batchEnd));

  // The rule is worth a doc line where it bit, because the symptom (a text quad showing
  // another text) points at the TEXTURE path, not at the release path.
  const win32Doc = readFileSync(join(root, 'docs', 'zh-cn', 'win32.md'), 'utf8');
  check('win32.md 3.6 records the release-lifetime rule and the measurement',
    /### 3\.6 [^\n]*延迟释放/.test(win32Doc)
    && /下一次提交/.test(win32Doc)
    && /171/.test(win32Doc) && /listOpen/.test(win32Doc));

  // ---- THE BLEND-MODE PINS -------------------------------------------------------
  // Starling's Blend Modes scene drives DisplayObject.blendMode -> BlendMode.activate()
  // -> Context3D.setBlendFactors(), and "switching does nothing" was THREE independent
  // defects, each measured against adl 51.4.1 on examples/air-starling-demo (pixel
  // difference vs adl: multiply 13.7% -> 3.5%, screen 10.6% -> 2.0%, add 10.2% -> 1.7%,
  // erase 13.8% -> 1.9%, none 62.4% -> 3.8%, with the untouched "normal" mode staying
  // at 3.7% as the control):
  //   a) the PSO key carried only "is blending on", so the first factor pair a program
  //      was drawn with (Starling's normal) was reused for every later mode;
  //   b) D3D12 rejects a *_COLOR factor in an ALPHA slot, so multiply/screen built NO
  //      pipeline and every draw of those modes was dropped;
  //   c) the window composite used the default kSrcOver while AIR presents the Stage3D
  //      back buffer with its alpha IGNORED (erase drew a WHITE silhouette, adl black).
  const mtl = readFileSync(join(root, 'vendor', 'metal_glue.mm'), 'utf8');
  const gl = readFileSync(join(root, 'vendor', 'skia_glue.cc'), 'utf8');
  const pso = bodyOfIn(d3d, 'static ID3D12PipelineState* s3d_select_pso(');
  check('the PSO key carries the blend FACTOR PAIR, not just "is blending on"',
    pso !== ''
    && /\|\%d\|\%s\|\%s\|\%x"/.test(pso)
    && /\(int\)\(c->blendSource != NULL \|\| c->blendDest != NULL\),/.test(pso)
    && /c->blendSource \? c->blendSource : ""/.test(pso)
    && /c->blendDest \? c->blendDest : ""/.test(pso));
  const alphaOf = bodyOfIn(d3d, 'static D3D12_BLEND s3d_blend_factor_alpha(');
  check('a *_COLOR blend factor is translated to its alpha twin for the alpha slots',
    alphaOf !== ''
    && /D3D12_BLEND_SRC_COLOR\) return D3D12_BLEND_SRC_ALPHA;/.test(alphaOf)
    && /D3D12_BLEND_INV_SRC_COLOR\) return D3D12_BLEND_INV_SRC_ALPHA;/.test(alphaOf)
    && /D3D12_BLEND_DEST_COLOR\) return D3D12_BLEND_DEST_ALPHA;/.test(alphaOf)
    && /D3D12_BLEND_INV_DEST_COLOR\) return D3D12_BLEND_INV_DEST_ALPHA;/.test(alphaOf)
    && /return b;/.test(alphaOf));
  check('both alpha slots go through that translation, never the raw colour factor',
    /rt->SrcBlendAlpha = s3d_blend_factor_alpha\(sf\);/.test(d3d)
    && /rt->DestBlendAlpha = s3d_blend_factor_alpha\(df\);/.test(d3d)
    && !/rt->SrcBlendAlpha = sf;/.test(stripComments(d3d))
    && !/rt->DestBlendAlpha = df;/.test(stripComments(d3d)));
  check('all four Stage3D composite paths draw with kSrc (AIR ignores the back buffer alpha)',
    /paint\.setBlendMode\(SkBlendMode::kSrc\);/.test(glue)
    && /drawImageRect\(img, dst, SkSamplingOptions\(SkFilterMode::kLinear, SkMipmapMode::kNone\), &paint\)/.test(glue)
    && (stripComments(mtl).match(/setBlendMode\(SkBlendMode::kSrc\)/g) || []).length === 1
    && /drawImageRect\(img\.get\(\), dst, SkSamplingOptions\(\), &paint\)/.test(mtl)
    && (stripComments(gl).match(/setBlendMode\(SkBlendMode::kSrc\)/g) || []).length === 2
    && /drawImageRect\(img\.get\(\), dst, SkSamplingOptions\(\), &paint\)/.test(gl)
    && /drawImageRect\(image\.get\(\), dst, SkSamplingOptions\(\), &paint\)/.test(gl));
  check('no Stage3D composite path is left on the default SrcOver paint',
    !/drawImageRect\(img\.get\(\), dst, SkSamplingOptions\(\)\);/.test(stripComments(mtl))
    && !/drawImageRect\(img\.get\(\), dst, SkSamplingOptions\(\)\);/.test(stripComments(gl))
    && !/drawImageRect\(image\.get\(\), dst, SkSamplingOptions\(\)\);/.test(stripComments(gl)));

  // The rule is worth a doc line where it bit: the symptom ("switching has no effect")
  // points at the AS3 blend-mode plumbing, not at three separate backend states.
  const display3dDoc = readFileSync(join(root, 'docs', 'zh-cn', 'display3d.md'), 'utf8');
  check('display3d.md 10.6 records all three blend-mode causes and the adl numbers',
    /### 10\.6 [^\n]*混合模式/.test(display3dDoc)
    && /blendSource\|blendDest/.test(display3dDoc)
    && /12\.93%/.test(display3dDoc) && /13\.68%/.test(display3dDoc)
    && /kSrcOver/.test(display3dDoc) && /s3d_blend_factor_alpha/.test(display3dDoc));

  // ---- THE UPLOAD-HEAP POOL PIN --------------------------------------------------
  // s3d_make_upload used to build a fresh committed UPLOAD resource on EVERY call
  // (CreateCommittedResource + Map + memcpy + Unmap, the old one deferred-released),
  // and at examples/air-starling-demo's ~66k objects that is 20-27 uploads and 4-5 MB
  // per frame. ASC_VB_PROBE measured the fixed cost at ~100 us per upload REGARDLESS of
  // size (64 boot-time 0.5 KiB uploads = 7.55 ms), i.e. 4.4-6.5 ms of a 16.7 ms frame:
  // the benchmark plateaued at 67,728 and pools to 147,488. Metal never pays it -- its
  // upload is a replaceRegion into a persistent buffer.
  //
  // Every part below is load-bearing, and one of them is not a performance bug but a
  // RENDERING bug: with no `listOpen` guard on the stamp, the immediate list (texture
  // uploads) cleared every pending flag while a batch was still open, so the first
  // frame's 12 menu-button uploads all landed in ONE buffer and 11 of the 12 buttons
  // vanished for the rest of the run -- while the benchmark number looked BETTER
  // (150,992). A rendering regression hides much better than a performance one.
  const poolNew = bodyOfIn(d3d, 'static S3DUploadBuf* s3d_ubuf_new(');
  const poolGet = bodyOfIn(d3d, 'static S3DUploadBuf* s3d_acquire_upload(');
  const uploadV = bodyOfIn(d3d, 'int s3d_upload_vertex(');
  const uploadI = bodyOfIn(d3d, 'int s3d_upload_index(');
  const destroy = bodyOfIn(d3d, 'void s3d_destroy(void* ctx) {');
  const ubufMax = /#define S3D_UBUF_MAX (\d+)/.exec(d3d);
  check('an upload buffer is created once, permanently mapped, and pooled',
    ubufMax != null && Number(ubufMax[1]) >= 16
    && poolNew !== '' && /b->map = map;/.test(poolNew) && /b->fence = 0;/.test(poolNew)
    && /could not be created/.test(poolNew) && /could not be mapped/.test(poolNew));
  check('a pooled buffer is only handed out when the GPU is provably done with it',
    poolGet !== '' && /GetCompletedValue\(\)/.test(poolGet)
    && /b->pending \|\| b->bytes < bytes/.test(poolGet)
    && /if \(b->fence != 0 && b->fence > done\) continue;/.test(poolGet));
  check('a buffer still bound to a stream or the index stage is never handed out',
    /static int s3d_ubuf_bound\(S3DContext\* c, ID3D12Resource\* res\) \{/.test(d3d)
    && /c->streams\[i\]\.buf == res/.test(d3d) && /return c->indexBuffer == res;/.test(d3d)
    && /s3d_ubuf_bound\(c, b->res\)\) continue;/.test(poolGet));
  check('the upload paths convert straight into the pool, with no per-call malloc',
    uploadV !== '' && uploadV.includes('s3d_acquire_upload(c,') && uploadV.includes('b->map')
    && /float\* dst = \(float\*\)b->map;/.test(uploadV) && !/CreateCommittedResource/.test(uploadV)
    && uploadI !== '' && /memcpy\(b->map, data, nbytes\);/.test(uploadI));
  check('a buffer replaced while a batch is open is re-marked for that batch',
    /static void s3d_mark_batch_ref\(S3DContext\* c, int ub\) \{/.test(d3d)
    && /c->ubuf\[ub\]\.pending = 1;/.test(d3d)
    && (d3d.match(/s3d_mark_batch_ref\(c, c->streams\[stream\]\.ub\);/g) || []).length === 1
    && (d3d.match(/s3d_mark_batch_ref\(c, c->indexUb\);/g) || []).length === 1);
  check('the stamp refuses to make an open batch\'s buffers reclaimable',
    /static void s3d_stamp_uploads\(S3DContext\* c, uint64_t v\) \{\r?\n  if \(c->listOpen\) return;\r?\n  for \(int i = 0; i < c->nubuf; i\+\+\)/.test(d3d)
    && /next 12 button uploads all landed in ONE buffer/.test(d3d));
  check('the pool is bounded and reports saturation instead of dropping an upload',
    /upload pool saturated/.test(poolGet) && /s3d_wait_idle\(c\);/.test(poolGet)
    && /e->res->Release\(\);/.test(poolGet));
  check('teardown releases the pool and never the borrowed stream/index buffers',
    destroy !== ''
    && /for \(int i = 0; i < c->nubuf; i\+\+\) if \(c->ubuf\[i\]\.res\) c->ubuf\[i\]\.res->Release\(\);/.test(destroy)
    && !/indexBuffer->Release\(\)|streams\[i\]\.buf->Release\(\)/.test(destroy));
  check('win32.md 3.10 records the pool, the measured plateau and the stamp guard',
    /### 3\.10 [^\n]*上传/.test(win32Doc)
    && /67,728 → 147,488 对象/.test(win32Doc)
    && /s3d_stamp_uploads/.test(win32Doc) && /listOpen/.test(win32Doc));

  console.log(`     [stage3d] ${ok} check(s) passed`);
  return bad;
}

registerGroup('stage3d/d3d-glue', checkStage3dD3dGlue);

// Stage3D.requestContext3D(context3DRenderMode, profile) — the AIR contract for the two
// argument form, measured against adl 51.4.1 (temp/adlprof/run-all.js + run-modes.js on a
// descriptor whose <renderMode> lives inside <initialWindow>).
//
// Why a structural pin and not just examples/stage3d-profile.as: the example proves the
// behaviour of ONE call sequence, but what keeps breaking is the *contract* — the
// parameter existing at all, the two values being validated in AIR's order with AIR's
// words, and the reported profile staying honest. Any one of those regressing makes an
// AIR-legal app fail at runtime: Starling's profile ladder calls this with two arguments
// through Function.apply, so a missing parameter surfaces as #1063 inside its retry loop.
function checkStage3dRequestContextProfile(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [stage3d] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stage3d] ${label}`); }
  };

  const emitted = emittedLines();

  // 1. Two parameters, in AIR's order and with AIR's names.
  check('requestContext3D takes (renderMode, profile), not a single argument',
    emitted.includes('void Stage3D_requestContext3D(void* _this, char* renderMode, char* profile) {'));

  // 2. renderMode is validated BEFORE profile — adl reports the renderMode error for a
  //    call where both values are wrong. Comparing the two indices makes this a pin about
  //    ORDER rather than about the two checks merely existing.
  const iMode = emitted.indexOf('Parameter renderMode must be one of the accepted values.');
  const iProf = emitted.indexOf('Parameter profile must be one of the accepted values.');
  check('both arguments are validated synchronously with AIR\'s exact #2008 text',
    iMode > 0 && iProf > iMode
    && emitted.includes('if (renderMode == NULL || (strcmp(renderMode, "auto") && strcmp(renderMode, "software")))')
    && emitted.includes('as_throw(ArgumentError_new((char*)"Error #2008: Parameter renderMode must be one of the accepted values.", 2008));')
    && emitted.includes('as_throw(ArgumentError_new((char*)"Error #2008: Parameter profile must be one of the accepted values.", 2008));'));

  // 3. The accepted profile set is exactly AIR's seven rungs — no more, no less.
  const body = emitted.slice(emitted.indexOf('static bool as_s3d_profile_ok'),
                            emitted.indexOf('void Stage3D_requestContext3D'));
  const accepted = [...body.matchAll(/!strcmp\(p, "([^"]+)"\)/g)].map((m) => m[1]).sort();
  check('all seven Context3DProfile strings are accepted (enhanced included)',
    accepted.join(',') ===
      'baseline,baselineConstrained,baselineExtended,enhanced,standard,standardConstrained,standardExtended');
  check('a NULL profile is rejected instead of reaching strcmp',
    /if \(p == NULL\) return false;/.test(body));

  // 4. Validation precedes context creation, so a bad call leaves stage3D.context3D null
  //    — exactly what adl prints ("final context3D=null").
  const iCreate = emitted.indexOf('if (o->context3d == NULL) { o->context3d = Context3D_new();', iProf);
  check('validation precedes context creation (a bad argument leaves context3D null)',
    iProf > 0 && iCreate > iProf);

  // 5. The reported profile is the highest rung this build can honour, derived from the
  //    SAME backend query that enforces #3683 — never an echo of the request. AIR echoes
  //    because its D3D11/GL backends satisfy all seven rungs; Starling branches on the
  //    READ-BACK value (Painter.get_profile), so echoing "enhanced" would push it onto a
  //    4096-texture + double-buffered path on a backend that may not be able to serve it.
  const iProfile = emitted.indexOf('char* Context3D_get_profile');
  const profileBody = emitted.slice(iProfile, emitted.indexOf('Context3D_get_totalGPUMemory', iProfile));
  check('context3D.profile is derived from the backend ceiling, never echoed',
    iProfile > 0
    && profileBody.includes('as_s3d_max_texture_size() >= 4096 ? "baselineExtended" : "baseline"')
    && !profileBody.includes('return (char*)"baseline";'));

  console.log(`     [stage3d] ${ok} check(s) passed`);
  return bad;
}

registerGroup('stage3d/request-context-profile', checkStage3dRequestContextProfile);

// Texture-size validation. Every number and message below is a measurement against
// adl 51.4.1 (temp/adlprof/, PROBE_MODE=edge and PROBE_MODE=ign), not an inference
// from the docs:
//   createTexture      0/negative -> #3681, non-pow2 -> #3682, > ceiling -> #3683
//   createCubeTexture  0/negative -> #3681, non-pow2 -> #3682, > 1024 -> #3705
//   createRectangle*   0/negative -> #3681, no pow2 rule, > ceiling -> #3766
// The ceiling is 2048 at baseline and 4096 from baselineExtended up, and it is the
// same query the profile report is derived from, so the claim and the limit cannot
// drift apart.
//
// Context3D.ignoreResourceLimits (AIR 50.0+) lifts the CEILING paths only. Measured:
// #3681 and #3682 keep throwing with the flag on, and the beyond-ceiling failure
// changes from ArgumentError #3683/#3705/#3766 to Error #3684.
function checkStage3dTextureLimits(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [stage3d] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stage3d] ${label}`); }
  };

  const emitted = emittedLines();
  const i2d = emitted.indexOf('static void as_tex_check_2d');
  const body2d = emitted.slice(i2d, emitted.indexOf('static void as_tex_check_cube'));

  // 1. The ORDER of the checks is observable: a 4097 request reports "not a power of
  //    two", and 0 reports "size is zero". Pinning the relative indices makes this a
  //    statement about order, not about the three messages merely existing.
  const iZero = body2d.indexOf('Error #3681: Texture size is zero.');
  const iPow = body2d.indexOf('Error #3682: Texture size not a power of two.');
  const iBig = body2d.indexOf('Error #3683: Texture too big');
  check('#3681 (zero) before #3682 (pow2) before #3683 (ceiling)',
    i2d > 0 && iZero > 0 && iPow > iZero && iBig > iPow);

  // 2. The ceiling is the profile ceiling, not a hard-coded 2048/4096 decision made
  //    here: it must come from as_s3d_max_texture_size(), i.e. the backend.
  check('the 2D ceiling is derived from the backend query',
    body2d.includes('int m = as_tex_ceiling();')
    && emitted.includes('static int as_tex_ceiling(void) { return as_s3d_max_texture_size() >= 4096 ? 4096 : 2048; }'));

  // 3. Both legal ceilings exist with AIR's verbatim text. The message quotes the
  //    LIMIT, so a 4097 request still says "max is 4096x4096".
  check('both ceiling messages are AIR-verbatim (2048 and 4096 variants)',
    body2d.includes('"Error #3683: Texture too big (max is 2048x2048)."')
    && body2d.includes('"Error #3683: Texture too big (max is 4096x4096)."'));

  // 4. Cube maps do NOT scale with the profile: 1024 at every rung up to enhanced.
  const iCube = emitted.indexOf('static void as_tex_check_cube');
  const bodyCube = emitted.slice(iCube, emitted.indexOf('static void as_tex_check_rect'));
  check('cube maps stay capped at 1024 on every profile (#3705)',
    iCube > 0 && bodyCube.includes('if (size > 1024)')
    && bodyCube.includes('Error #3705: Cubemap texture too big (max is 1024x1024).')
    && !bodyCube.includes('as_tex_ceiling()'));

  // 5. RectangleTexture has no power-of-two rule — 4097 is "too big", not "not pow2".
  const iRect = emitted.indexOf('static void as_tex_check_rect');
  const bodyRect = emitted.slice(iRect, emitted.indexOf('Texture* Context3D_createTexture'));
  check('RectangleTexture has a ceiling but no power-of-two rule (#3766)',
    iRect > 0 && bodyRect.includes('Error #3766: RectangleTexture too big')
    && !bodyRect.includes('Error #3682')
    && bodyRect.includes('as_tex_ceiling()'));

  // 6. Each factory runs its validator before allocating anything, so a rejected call
  //    leaves no half-built texture behind (adl leaves context3D untouched too).
  const iCreate = emitted.indexOf('Texture* Context3D_createTexture');
  check('all three factories validate before allocating',
    iCreate > 0
    && emitted.indexOf('as_tex_check_2d(ctx, width, height);') < emitted.indexOf('Texture* t = Texture_new();')
    && emitted.indexOf('as_tex_check_cube(ctx->ignoreResourceLimits, size);') < emitted.indexOf('CubeTexture* t = CubeTexture_new();')
    && emitted.indexOf('as_tex_check_rect(ctx, width, height);') < emitted.indexOf('RectangleTexture* t = RectangleTexture_new();'));

  // 7. ignoreResourceLimits does not switch validation off: the zero and pow2 checks
  //    have to sit ABOVE the flag branch, and the flag must be the context field (a
  //    compile-time constant would let a caller's setter be ignored).
  check('zero/pow2 checks precede the ignoreResourceLimits branch',
    iZero > 0 && iPow > iZero
    && body2d.indexOf('ctx->ignoreResourceLimits') > iPow
    && bodyRect.indexOf('ctx->ignoreResourceLimits') > 0);

  // 8. With the flag set, the ceiling comes from the DEVICE query, not the profile
  //    ceiling: AIR's own post-bypass limit is still the profile ceiling, which is the
  //    one documented divergence and the reason the switch exists at all.
  const ignore2d = body2d.slice(body2d.indexOf('if (ctx != NULL && ctx->ignoreResourceLimits)'),
    body2d.indexOf('int m = as_tex_ceiling();'));
  check('flag-on 2D ceiling uses the device maximum',
    ignore2d.includes('int d = as_s3d_max_texture_size();') && ignore2d.includes('as_tex_alloc_failed();'));

  // 9. #3684 is an Error (not an ArgumentError) with AIR's verbatim text, and it is
  //    the answer from all three validators once the flag is on.
  check('#3684 is an Error with AIR text, reachable from all three validators',
    emitted.includes('static void as_tex_alloc_failed(void) {')
    && emitted.includes('as_throw(Error_new((char*)"Error #3684: Texture creation failed. Internal error.", 3684));')
    && body2d.includes('as_tex_alloc_failed();')
    && bodyCube.includes('as_tex_alloc_failed();')
    && bodyRect.includes('as_tex_alloc_failed();'));

  // 10. Cube maps keep AIR's 1024 hard cap even with the flag (measured: cube(2048)
  //     still fails, only the error type changes), so the device query must NOT appear
  //     in the cube validator.
  check('cube keeps 1024 even with the flag, error type becomes #3684',
    bodyCube.includes('if (ignoreLimits) as_tex_alloc_failed();')
    && bodyCube.includes('else as_throw(ArgumentError_new((char*)"Error #3705')
    && !bodyCube.includes('as_s3d_max_texture_size()'));

  // 11. The no-backend fallback stays 4096 ON PURPOSE. AIR's software render mode is
  //     locked to baseline (requesting baselineExtended/enhanced answers #3702, and even
  //     the context it does hand out rejects 4096 with #3683 "max is 2048x2048"), so this
  //     is a documented divergence registered as enhancement E17 -- see display3d.md
  //     §9.14. Pinned here because "4096 looks like a typo next to AIR's 2048" is exactly
  //     the kind of line a future reader will want to "fix", and doing so would silently
  //     drop every no-backend build to baseline.
  //     Source is runtime.ts, not emittedLines(): emittedLines() scans emit.ts only, and
  //     this helper lives in the runtime preamble.
  const runtimeSrc = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const iMax = runtimeSrc.indexOf('static inline int as_s3d_max_texture_size(void) {');
  const bodyMax = runtimeSrc.slice(iMax, runtimeSrc.indexOf('static inline void* as_s3d_create_render_texture'));
  check('a build with no GPU backend answers 4096 on purpose (E17), a real backend is asked',
    iMax > 0
    && bodyMax.includes('#ifdef ASC_RENDER_STAGE3D')
    && bodyMax.includes('return s3d_max_texture_size();')
    && bodyMax.includes('return 4096;'));

  console.log(`     [stage3d] ${ok} check(s) passed`);
  return bad;
}

registerGroup('stage3d/texture-size-limits', checkStage3dTextureLimits);
// uploadFromVector / uploadFromByteArray 的边界契约（阶段三百二十）。
//
// 这四个入口以前是「能拷多少拷多少，拷不到就静默返回」——与 AIR 抛 RangeError 相反，
// 且 startVertex/startIndex 为负时目标指针会走到缓冲区之前，即一次越界写（与
// BitmapData.setPixels 的越界读同族）。契约全部来自 adl 51.4.1 实测
// （temp/s3dupload/：89 条用例逐行对齐 + ChainProbe 的 mip 链）：
//
//   data == null                TypeError      #2007 "Parameter data must be non-null."
//   尺寸 / 下标越界              RangeError     #3669 "Bad input size."
//   miplevel 超出 mip 链         ArgumentError  #3674 "Miplevel too large."
//
// 两条容易写错、且注释里必须留下痕迹的语义：
//   * uploadFromVector 的源从 data[0] 读，startVertex/startIndex 只决定**写到哪**
//     （实测：只有 1 个顶点的 Vector，start=1/n=1 也能成功）；
//   * Vector 的长度对照 numVertices，不是 startVertex + numVertices（实测：
//     2 个元素的 Vector，start=1/count=2 成功）。
function checkStage3dUploadBounds(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [stage3d] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stage3d] ${label}`); }
  };

  const emitted = emittedLines();
  const body = (name: string, next: string): string => {
    const i = emitted.indexOf(name);
    if (i < 0) return '';
    const j = emitted.indexOf(next, i);
    return emitted.slice(i, j < 0 ? undefined : j);
  };

  // 1. 一套错误铸造器，三处文案与 errorID 必须逐字对齐 AIR。
  check('#2007 null-data helper carries AIR text and id',
    emitted.includes('static void as_s3d_null_data(void) {')
    && emitted.includes('as_throw(TypeError_new((char*)"Error #2007: Parameter data must be non-null.", 2007))'));
  check('#3669 bad-input helper carries AIR text and id',
    emitted.includes('static void as_s3d_bad_input(void) {')
    && emitted.includes('as_throw(RangeError_new((char*)"Error #3669: Bad input size.", 3669))'));
  check('#3674 mip-level helper carries AIR text and id',
    emitted.includes('static void as_s3d_mip_too_large(void) {')
    && emitted.includes('as_throw(ArgumentError_new((char*)"Error #3674: Miplevel too large.", 3674))'));

  // 2. 校验的是 createVertexBuffer3D/createIndexBuffer3D 给的尺寸，不是本次上传的
  //    长度 —— uploadFromByteArray 会把 numVertices/numIndices 覆盖成上传的那一段。
  const symbolsSrc = readFileSync(join(root, 'src', 'symbols.ts'), 'utf8');
  check('VertexBuffer3D keeps a separate capacity field',
    symbolsSrc.includes("['capacity', vbf({ kind: 'int' })]"));
  check('IndexBuffer3D keeps a separate capacity field',
    symbolsSrc.includes("['capacity', ibf({ kind: 'int' })]"));
  check('ctors zero the capacity',
    emitted.includes('o->numVertices = 0; o->capacity = 0;')
    && emitted.includes('o->numIndices = 0; o->capacity = 0;'));
  check('createVertexBuffer/createIndexBuffer record the capacity',
    emitted.includes('b->numVertices = numVertices; b->capacity = numVertices; b->data32PerVertex = data32PerVertex;')
    && emitted.includes('b->numIndices = numIndices; b->capacity = numIndices;'));

  // 3. 四个入口都必须先判 null（实测 null 优先于其它一切拒绝原因：null+mip=9 报 #2007）。
  const vbBa = body('void VertexBuffer3D_uploadFromByteArray(', 'void VertexBuffer3D_dispose(');
  const vbVec = body('void VertexBuffer3D_uploadFromVector(', 'void VertexBuffer3D_uploadFromByteArray(');
  const ibBa = body('void IndexBuffer3D_uploadFromByteArray(', 'CubeTexture_');
  const ibVec = body('void IndexBuffer3D_uploadFromVector(', 'void IndexBuffer3D_uploadFromByteArray(');
  const texBa = body('void Texture_uploadFromByteArray(', 'void Texture_uploadFromBitmapData(');
  const texHelper = body('static const uint32_t* as_tex_argb_from_byte_array(', 'void Texture_uploadFromByteArray(');

  for (const [label, b] of [
    ['VertexBuffer3D.uploadFromByteArray', vbBa],
    ['VertexBuffer3D.uploadFromVector', vbVec],
    ['IndexBuffer3D.uploadFromByteArray', ibBa],
    ['IndexBuffer3D.uploadFromVector', ibVec],
    ['Texture.uploadFromByteArray', texBa],
    ['as_tex_argb_from_byte_array', texHelper],
  ] as const) {
    check(`${label} rejects null data with #2007`, b.includes('as_s3d_null_data();'));
  }

  // 4. 尺寸校验：-1 / 越界 / 差一个字节都必须同一条 #3669，且不再有「截断到可用长度」。
  check('VB byte-array upload validates the offset, the capacity window and the byte count',
    vbBa.includes('off >= data->length') && vbBa.includes('as_s3d_bad_input();')
    && vbBa.includes('startVertex > o->capacity - numVertices')
    && vbBa.includes('numVertices * (long long)stride * 4LL > (long long)(data->length - off)'));
  check('IB byte-array upload validates the same three things at 2 bytes/index',
    ibBa.includes('off >= data->length')
    && ibBa.includes('startIndex > o->capacity - numIndices')
    && ibBa.includes('numIndices * 2LL > (long long)(data->length - off)'));
  check('no upload entry point silently clamps to the available bytes any more',
    !/maxCount/.test(emitted) && !emitted.includes('if (count > maxCount) count = maxCount;'));

  // 5. 源与目标是两件事：源自偏移/数组头部连续读，startVertex 只决定写到哪。
  //    「从 data[startVertex*stride] 读」既是越界读也是与 AIR 不符的形状。
  check('uploadFromByteArray reads the source contiguously from the offset',
    vbBa.includes('const unsigned char* src = (const unsigned char*)data->data + off;')
    && vbBa.includes('unsigned* out = dst + (size_t)startVertex * (size_t)stride;'));
  check('uploadFromVector reads the source from data[0], not data[startVertex*stride]',
    vbVec.includes('const double* src = data->data;')
    && !vbVec.includes('data->data + (size_t)startVertex * (size_t)stride')
    && ibVec.includes('o->data->data[startIndex + i] = data->data[i];'));
  check('uploadFromVector compares the VECTOR length with the count alone',
    vbVec.includes('(long long)numVertices * (long long)stride > (long long)data->length')
    && ibVec.includes('(long long)numIndices > (long long)data->length'));

  // 6. Texture：miplevel 是真实现的（旧代码把 level>0 直接报 unsupported），
  //    链长按 max(w,h)，级别尺寸决定字节数，超链 #3674。非 mipmapped 纹理照样接受
  //    level>0（实测），所以这守卫不能挂在 mips 标志上。
  check('Texture.uploadFromByteArray honours miplevel instead of reporting it unsupported',
    !emitted.includes('Texture.uploadFromByteArray (mip level > 0)')
    && texBa.includes('int dim = o->width > o->height ? o->width : o->height;')
    && texBa.includes('while (dim > 1) { dim >>= 1; nlv++; }')
    && texBa.includes('as_s3d_mip_too_large();'));
  check('the mip level dimensions drive the byte-count check',
    texBa.includes('int lw = o->width >> lv; if (lw < 1) lw = 1;')
    && texBa.includes('int lh = o->height >> lv; if (lh < 1) lh = 1;')
    && texBa.includes('as_tex_argb_from_byte_array(data, byteArrayOffset, lw, lh, o->format, &sw)'));
  check('a short ByteArray is #3669, not the old #2004 "parameters is invalid"',
    texHelper.includes('as_s3d_bad_input();')
    && !texHelper.includes('Error #2004'));
  // 目标字指针必须能安全解引用：非 4 字节对齐的偏移走逐字节装配（IB 实测接受 off=1，
  // 纹理同理），否则 uint32_t* 解引用是 UB。
  check('the in-place texel fast path is guarded by alignment and host byte order',
    texHelper.includes('if ((off & 3u) == 0u && as_host_little() && strcmp(format, "bgra") == 0) return (const uint32_t*)src;')
    && texHelper.includes('unsigned r = isbgra ? b2 : b0, b = isbgra ? b0 : b2;'));

  // 7. data.endian 被刻意忽略：参考文档要求小端 ByteArray，adl 却接受 bigEndian 且
  //    按小端读 —— 尊重该标志会字节翻转 AIR 原样透传的数据。
  check('ByteArray.endian is deliberately ignored (AIR reads the bytes as little-endian)',
    !vbBa.includes('as_ba_little(') && !ibBa.includes('as_ba_little(')
    && vbBa.includes('if (as_host_little()) {') && ibBa.includes("(unsigned int)src[i*2+1] << 8"));

  console.log(`     [stage3d] ${ok} check(s) passed`);
  return bad;
}

registerGroup('stage3d/upload-bounds', checkStage3dUploadBounds);

