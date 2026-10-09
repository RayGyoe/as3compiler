// stage3d_glue.mm — the Objective-C++ -> C bridge for Stage3D's raw Metal
// pipeline (flash.display3D). Unlike metal_glue.mm (which wraps Skia's Ganesh
// backend for the 2D display list), this file owns the *programmable* GPU
// triangle pipeline: MTLBuffer vertex/index buffers, MTLTexture 2D textures,
// MTLLibrary (MSL compiled from AGAL bytecode), MTLRenderPipelineDescriptor +
// MTLDepthStencilState, and a MTLRenderPassDescriptor that renders into an
// offscreen MTLTexture so pixels can be read back (drawToBitmapData / tests).
//
// It is offscreen-first: it renders into an offscreen render target and exposes
// a flat extern "C" API for the generated C to call. Compositing that render
// target with Skia's 2D surface into a single CAMetalLayer drawable is the stage
// 82 P2 follow-up, whose missing half was the *shared* command queue (see the
// weak declaration of sk_mtl_shared_queue below); the offscreen path here is the
// testable core that stage 82's acceptance ("assert the triangle's pixels") and
// stage 83's drawToBitmapData both build on.

#import <Metal/Metal.h>
#include <cstdio>
#include <cfloat>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <ctime>

extern "C" {

// The process-wide MTLCommandQueue shared with Skia's Ganesh backend, defined in
// metal_glue.mm. Adopting it is what makes the offscreen target safe to hand to
// the 2D composite: Stage3D writes the target while Skia reads it (the composite
// of frame N samples the texture frame N+1 renders into), and Metal only tracks
// resource hazards within one queue. On two queues the read raced the next
// frame's write and the composite landed a half-written torus pass -- the ring
// cut along a straight tile boundary.
//
// Looked up with dlsym rather than declared `weak_import`, because the build has
// to *link* both ways: with metal_glue (windowed app, share the queue) and
// without it (headless Stage3D build -- examples/stage83.build.json, which links
// this file alone and has no Ganesh to race with). A weak_import reference is
// still an undefined symbol to the modern macOS linker, so the headless link
// failed outright ("Undefined symbols: _sk_mtl_shared_queue", 2026-10-09);
// dlsym resolves to NULL at runtime when nothing defines it, which is exactly
// the documented fallback.
#include <dlfcn.h>
typedef id<MTLCommandQueue> (*SkMtlSharedQueueFn)(void);
static SkMtlSharedQueueFn sk_mtl_shared_queue_lookup(void) {
  static SkMtlSharedQueueFn cached = NULL;
  static bool probed = false;
  if (!probed) { probed = true; cached = (SkMtlSharedQueueFn)dlsym(RTLD_DEFAULT, "sk_mtl_shared_queue"); }
  return cached;
}

// ---- draw cost probe (ASC_S3D_STATS=1) ----
// Answers "is this frame CPU-bound or GPU-bound?" with numbers rather than
// guesses: per draw it records the CPU time spent encoding, the wall time
// blocked in -waitUntilCompleted (GPU latency, which is *serialized* with the
// next frame's CPU work — see s3d_draw), and Metal's own
// GPUStartTime/GPUEndTime delta (the true GPU execution time). Printed every
// 240 draws together with elapsed time, so the draw rate can be compared with
// metal_glue.mm's sk_stats frame rate to derive draws/frame and ms/frame.
static double asc_dbg_now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1.0e6;
}
static int asc_s3d_stats(void) {
  static int on = -1;
  if (on < 0) on = (getenv("ASC_S3D_STATS") != NULL) ? 1 : 0;
  return on;
}
// Debug probe: dump the translated MSL and every draw's state (depth/cull/blend/
// streams/per-unit sampler) to stderr. Cached so the hot draw path never calls
// getenv per draw.
static int asc_s3d_dump(void) {
  static int on = -1;
  if (on < 0) on = (getenv("ASC_S3D_DUMP") != NULL) ? 1 : 0;
  return on;
}

// Per-frame entry-point counters, printed every 60 draws when AS_S3D_TRACE is
// set. This is the probe that found the program-cache bug: make_pso and compile
// read 1-per-draw before the fix, which is what grew the process ~62 MB/min.
// They must now track the number of PROGRAMS (compile may still run once per
// draw -- that is a cache lookup -- but make_pso must not). See
// test/unit/stage3d.ts, unit group stage3d/program-cache.
static int asc_s3d_trace(void) {
  static int on = -1;
  if (on < 0) on = (getenv("AS_S3D_TRACE") != NULL) ? 1 : 0;
  return on;
}
static long asc_tr_draw = 0, asc_tr_compile = 0, asc_tr_pso = 0, asc_tr_psomiss = 0,
            asc_tr_dss = 0, asc_tr_smpmiss = 0, asc_tr_bindtex = 0, asc_tr_cube = 0,
            asc_tr_smpseti = 0, asc_tr_rt = 0, asc_tr_uptex = 0, asc_tr_mipbuild = 0,
            asc_tr_mipdrop = 0;
static void asc_tr_report(void) {
  if (!asc_s3d_trace()) return;
  static long frame = 0;
  if (++frame % 60) return;
  fprintf(stderr, "TRACE draw=%ld compile=%ld make_pso=%ld pso_miss=%ld dss=%ld smp_miss=%ld bindtex=%ld cube=%ld smpseti=%ld rt=%ld uptex=%ld mipbuild=%ld mipdrop=%ld\n",
    asc_tr_draw, asc_tr_compile, asc_tr_pso, asc_tr_psomiss, asc_tr_dss,
    asc_tr_smpmiss, asc_tr_bindtex, asc_tr_cube, asc_tr_smpseti, asc_tr_rt, asc_tr_uptex,
    asc_tr_mipbuild, asc_tr_mipdrop);
}

// Probe accumulators shared by s3d_draw (encode cost) and the flushes (GPU,
// wait and commit cost). With per-frame batching the two costs land in different
// places: the encode happens per draw, while the submission happens once per
// batch -- so cpu= is normalized per draw and gpu=/wait=/commit= per batch (see
// s3d_flush_impl). wait= only counts the commit+wait path (readback/resize) and
// commit= only the commit-only path (present/window loop); a program does one or
// the other, not both, so at most one of the two is non-zero.
static double asc_dbg_acc_cpu = 0;    // encode ms, summed over draws
static double asc_dbg_acc_tri = 0;    // triangles, summed over draws
static long asc_dbg_acc_n = 0;        // draws since the last report
static long asc_dbg_tot_n = 0;        // draws since start
static double asc_dbg_t_first = 0;    // wall clock of the first draw
static double asc_dbg_acc_wait = 0;   // commit+wait ms, summed over batches
static double asc_dbg_acc_commit = 0; // commit-only ms, summed over batches
static double asc_dbg_acc_gpu = 0;    // GPU execution ms, summed over batches
static long asc_dbg_acc_b = 0;        // batches since the last report
static id<MTLCommandBuffer> asc_dbg_prev = nil;  // last async batch, for gpu= (see s3d_flush_impl)

// ---- opaque context ----
// One context owns a device, queue, offscreen render target, the current
// pipeline, and the bound resources. The generated C holds an opaque `void*`
// (never dereferenced) and passes it back on every call.
struct S3DContext;

// Vertex stream layout: each setVertexBufferAt(i, buffer, offset, format)
// becomes one attribute i fed from MTLBuffer index i. `components` is 1..4
// (FLOAT_1..FLOAT_4); Metal fills the missing .zw components with 0 and .w with
// 1, matching AGAL's float4 register semantics.
struct S3DStream {
  id<MTLBuffer> buffer;
  int components;   // 1..4
  int numVertices;
};

// Metal bakes the blend state into MTLRenderPipelineState (there is no per-draw
// blend-factor call, unlike GL), but Stage3D is a state machine: setBlendFactors
// may change between two draws that share one Program3D. The context therefore
// keeps the compiled vertex/fragment functions alive and caches one pipeline per
// blend-factor pair, selected when a draw is encoded (s3d_select_pso). Without
// this the factors only took effect if they had been set before the program's
// first draw: Starling's Blend Modes demo cycled its label while the image never
// changed.
//
// The color write mask (setColorMask) is baked the same way: Metal's only knob is
// MTLRenderPipelineDescriptor.writeMask (no encoder-level equivalent, unlike GL),
// so it joins the variant key. away3d's DepthRenderer draws its depth-only
// prepass with all four channels masked off and then restores them, which
// otherwise would have written the prepass into the color target.
#define S3D_MAX_BLEND_VARIANTS 16

// One cached pipeline: the blend-factor names ("" for both = blending disabled),
// the color write mask, plus the state built for them, LRU-stamped.
typedef struct {
  char sf[32];
  char df[32];
  unsigned int writeMask;   // MTLColorWriteMask bits baked into this pipeline
  id<MTLRenderPipelineState> pso;
  unsigned long stamp;
} S3DBlendVariant;

// Depth/stencil state follows the same rule, and NEEDS a cache more than the
// blend variants do: Stage3D lets a scene alternate depth state between two
// consecutive draws, and away3d does exactly that -- its chromed torus draws
// with depth=(less, write on) and its skybox with depth=(lessEqual, write off),
// so the value-dedup in s3d_set_depth ("only mark dirty when a value actually
// changes") fires on EVERY draw of that scene. Rebuilding then hands the driver a
// fresh MTLDepthStencilState per draw (measured dss=8039 across 8040 draws,
// while make_pso stayed at 2 because the pipeline cache already worked).
// Cache one state per tuple instead, LRU-bounded like the other caches.
//
// The key covers exactly what is baked into the object: depth compare/write and
// the five stencil fields plus the read/write masks. It deliberately EXCLUDES
// the stencil reference value -- Stage3D applies that per draw on the encoder
// (setStencilReferenceValue), it is not part of the state object.
#define S3D_MAX_DSS 16

typedef struct {
  int depthWrite;
  char depthCompare[32];
  char stencilFace[16];
  char stencilCompare[32];
  char bothPass[32];
  char depthFail[32];
  char dpFail[32];
  unsigned int readMask, writeMask;
  id<MTLDepthStencilState> state;
  unsigned long stamp;
} S3DDssVariant;

// One compiled program: the MSL-derived functions plus the blend variants built
// from them. Stage3D lets a scene switch Program3D between draws (away3d's
// SkyBox alternates its torus material and its skybox material on EVERY frame),
// and compiling MSL is a *driver* operation, not a cheap bind: Metal compiles
// the source, and each newRenderPipelineStateWithDescriptor: hands it a fresh
// MTLVertexDescriptor that its pipeline cache keeps. Compiling once per draw
// measured 8,000 compiles in 8,000 draws and grew the process ~62 MB/min. The
// compiled program is therefore cached per Program3D identity and merely
// SELECTED on a switch (s3d_use_program / s3d_compile), like AIR's program bind.
#define S3D_MAX_PROGRAMS 16

typedef struct {
  void* key;                // Program3D identity (never cleared: the slot's name)
  unsigned long long srcHash;    // hash of the MSL this slot was compiled from
  id<MTLFunction> vfn;      // owned by the slot while it is STASHED (see s3d_prog_stash)
  id<MTLFunction> ffn;
  S3DBlendVariant bvars[S3D_MAX_BLEND_VARIANTS];  // pipelines built for this program
  int nbvars;
  unsigned long stamp;      // LRU stamp (updated on stash/load/compile)
} S3DProgramCache;

struct S3DContext {
  id<MTLDevice> device;
  id<MTLCommandQueue> queue;
  id<MTLTexture> target;          // offscreen render target (BGRA8Unorm)
  id<MTLTexture> renderOverride;  // render-to-texture target (nil = back buffer)
  id<MTLTexture> depthStencil;    // depth32+stencil8 attachment (nil unless ASC_RENDER_DEPTH_STENCIL)
  // Depth/stencil for render-to-texture passes. The back-buffer attachment above
  // is sized to the window; a render pass requires the depth attachment to match
  // the color attachment, so an offscreen render target needs its own
  // same-size surface. Allocated lazily in s3d_set_render_target and kept until
  // the render target size changes.
  id<MTLTexture> rtDepthStencil;
  int rtDepthStencilW, rtDepthStencilH;
  int width, height;
  // current pipeline (one of the cached blend variants below)
  id<MTLRenderPipelineState> pso;
  // Program kept alive for the blend variants: the last compiled functions plus
  // one pipeline per blend-factor pair seen for them.
  // The LIVE program: borrowed from the cache slot named c->progKey (see
  // s3d_prog_load), or owned here while key == NULL. s3d_prog_stash hands this
  // state back to its slot before any switch, so exactly one place owns it.
  id<MTLFunction> vfn;
  id<MTLFunction> ffn;
  S3DBlendVariant bvars[S3D_MAX_BLEND_VARIANTS];
  int nbvars;
  unsigned long bstamp;
  // Compiled-program cache (see S3DProgramCache).
  S3DProgramCache progs[S3D_MAX_PROGRAMS];
  int nprogs;
  void* progKey;            // identity of the live program (NULL = not cached)
  unsigned long long progHash;   // source hash of the live program
  unsigned long progstamp;  // LRU source for the slots
  // bound resources
  S3DStream streams[8];
  int numStreams;
  id<MTLBuffer> indexBuffer;
  int numIndices;
  id<MTLBuffer> vc;               // vertex constants (float4 array)
  id<MTLBuffer> fc;               // fragment constants (float4 array)
  id<MTLTexture> textures[8];     // fragment samplers fs0..fs7
  // clear color / blend
  float clearR, clearG, clearB, clearA;
  // Stage3D clear(red,green,blue,alpha,depth,stencil,mask) also carries the
  // VALUES written to the depth and stencil attachments. Starling clears the
  // stencil to Painter.DEFAULT_STENCIL_VALUE (127), NOT 0: its mask passes
  // compare EQUAL against the current reference and then increment, so a
  // stencil cleared to 0 would make the very first mask pass fail and every
  // masked object vanish.
  float clearDepthValue;
  unsigned int clearStencilValue;
  const char* blendSource;   // AS3 blend-factor name (e.g. "one"), NULL = off
  const char* blendDest;     // AS3 blend-factor name (e.g. "oneMinusSourceAlpha")
  int instanceCount;               // 1 unless drawTrianglesInstanced set it
  int clearPending;                // set by s3d_clear, consumed by the next s3d_draw
  // Per-attachment clear flags for the next draw (Stage3D's clear() takes a
  // Context3DClearMask: COLOR=1/DEPTH=2/STENCIL=4). Each applies to exactly one
  // draw; afterwards the render pass loads instead of clearing.
  int clearColor, clearDepth, clearStencil;
  // Depth test / culling (Stage3D state machine, applied when the draw is encoded).
  int depthWrite;                  // setDepthTest's depthMask
  const char* depthCompare;        // Context3DCompareMode name, NULL = "always"
  const char* cullMode;            // Context3DTriangleFace name, NULL = no culling
  // Stencil: compare mode + the three actions (both-pass / depth-fail /
  // depth-pass-stencil-fail) + reference and masks. Starling's masking drives
  // this state: draw the mask shape with INCREMENT_SATURATE (compare ALWAYS) to
  // stamp it into the stencil, then draw the masked content with compare EQUAL
  // against the incremented reference value.
  const char* stencilFace;
  const char* stencilCompare;
  const char* stencilBothPass;
  const char* stencilDepthFail;
  const char* stencilDepthPassStencilFail;
  unsigned int stencilRef, stencilReadMask, stencilWriteMask;
  // Scissor rectangle in DEVICE pixels (setScissorRectangle is in stage units;
  // the C side scales it by backBufferWidth/logicalWidth before forwarding).
  int scissorOn, scissorX, scissorY, scissorW, scissorH;
  // setColorMask: which channels the following draws may write (1 = write).
  // Metal has no encoder-level colorWriteMask, so it is baked into the pipeline
  // variant (see S3DBlendVariant.writeMask); away3d renders its depth-only
  // prepass with all four channels masked off and then restores them.
  int colorMaskR, colorMaskG, colorMaskB, colorMaskA;
  // Sampler state per texture unit (setSamplerStateAt): filter/wrap/mip as small
  // enums, resolved to a cached MTLSamplerState when a draw is encoded. The
  // generated MSL declares one sampler per sampled texture register
  // (smpN [[sampler(N)]]), so each unit's state is bound at its own index (see
  // s3d_draw).
  int samplerFilter[8];            // 0 = linear, 1 = nearest
  int samplerWrap[8];              // 0 = clamp, 1 = repeat
  int samplerMip[8];               // 0 = none, 1 = nearest, 2 = linear
  int samplerStateSet[8];          // whether setSamplerStateAt ran for this unit
  // Whether the texture bound at each unit actually owns a mip chain. Reported
  // by s3d_bind_texture (the AS texture knows: it built the chain when the app
  // supplied a mip level > 0), and consulted by s3d_draw to reproduce AIR's
  // "mip-filtered sample on a chainless texture drops the draw" rule.
  int texHasMips[8];
  id<MTLSamplerState> samplerCache[2][2][3];  // [filter][wrap][mip]
  id<MTLDepthStencilState> dss;    // BORROWED from a dssv[] slot (see below)
  int dssDirty;                    // (re)select before the next draw
  // Keyed depth/stencil cache. c->dss is borrowed from one of these slots, so
  // the slots own the +1 and s3d_destroy releases them there -- releasing c->dss
  // separately would be a double free.
  S3DDssVariant dssv[S3D_MAX_DSS];
  int ndss;
  unsigned long dssstamp;
  // Fragment samplers. The AGAL->MSL translator declares one shared sampler per
  // program by default, and the encoder MUST bind a sampler state at every index
  // the shader declares — leaving one unbound made Metal reject the whole draw
  // ("missing Sampler binding at index 0 for smp[0]"), which is why
  // 3D-transformed sprites (Sprite 3D's cube) never appeared. Linear
  // min/mag/mip with clamp-to-edge matches Starling's default texture smoothing.
  id<MTLSamplerState> samplerLinear;
  id<MTLSamplerState> samplerNearest;
  // ---- per-frame command batching ----
  // Stage3D makes every drawTriangles a separate render pass, and this backend
  // used to commit + waitUntilCompleted for each one. That serialized the CPU
  // against the GPU: measured 0.04 ms of GPU work against ~0.5 ms of pure
  // round-trip latency per draw, i.e. a scene issuing 5 draws/frame threw away
  // ~2.5 ms/frame (a third of a 120 Hz budget) waiting. A batch holds ONE
  // command buffer open across every draw of a frame; the per-draw encoders are
  // appended to it and the batch is committed once at the frame boundary
  // (s3d_flush), so the CPU encodes the whole frame while the GPU executes it
  // and blocks at most once per frame instead of once per draw.
  //
  // Deferring the wait is safe because every upload creates a NEW MTLBuffer /
  // MTLTexture (newBufferWithBytes / newTextureWithDescriptor) instead of
  // mutating one in place, and a command buffer retains every resource its
  // encoders reference until it completes — so releasing the context's own +1
  // during the frame cannot free memory the GPU still reads.
  id<MTLCommandBuffer> batch;      // open command buffer (nil = nothing pending)
};

// Blend-variant pipeline cache (defined with the blend-factor mapping further
// down, but needed by the lifecycle/compile/draw entry points): every helper
// bakes the blend state into an MTLRenderPipelineState, since Metal has no
// per-draw blend-factor call.
static void s3d_factor_key(char* dst, const char* name);
static id<MTLRenderPipelineState> s3d_make_pso(S3DContext* c, const char* blendSource, const char* blendDest, unsigned int writeMask, NSError** err);
static void s3d_clear_variants(S3DContext* c);
static void s3d_prog_release(S3DProgramCache* e);
static void s3d_prog_stash(S3DContext* c);
static void s3d_prog_load(S3DContext* c, int idx);
static void s3d_select_pso(S3DContext* c);

// ---- lifecycle ----

// Allocate (or reallocate) the depth32float+stencil8 attachment. Only present
// when the build manifest sets ASC_RENDER_DEPTH_STENCIL (the AIR
// <depthAndStencil>true</depthAndStencil> flag). Depth/stencil is GPU-only —
// never read back to the CPU — so it uses private storage (the fastest on
// Apple Silicon) unlike the BGRA8 target which is shared for readback.
static id<MTLTexture> s3d_make_depth_stencil(id<MTLDevice> device, int width, int height) {
  MTLTextureDescriptor* td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatDepth32Float_Stencil8
      width:width height:height mipmapped:NO];
  td.usage = MTLTextureUsageRenderTarget;
  td.storageMode = MTLStorageModePrivate;
  return [device newTextureWithDescriptor:td];
}

// Create a fragment sampler state (linear or nearest); clamp-to-edge addressing
// and a full 0..maxLod range (a texture uploaded without mipmaps clamps to
// level 0 automatically).
static id<MTLSamplerState> s3d_make_sampler(id<MTLDevice> device, bool linear) {
  MTLSamplerDescriptor* sd = [[MTLSamplerDescriptor alloc] init];
  sd.minFilter = linear ? MTLSamplerMinMagFilterLinear : MTLSamplerMinMagFilterNearest;
  sd.magFilter = linear ? MTLSamplerMinMagFilterLinear : MTLSamplerMinMagFilterNearest;
  sd.mipFilter = linear ? MTLSamplerMipFilterLinear : MTLSamplerMipFilterNearest;
  sd.sAddressMode = MTLSamplerAddressModeClampToEdge;
  sd.tAddressMode = MTLSamplerAddressModeClampToEdge;
  sd.lodMinClamp = 0.0f;
  sd.lodMaxClamp = FLT_MAX;
  id<MTLSamplerState> st = [device newSamplerStateWithDescriptor:sd];
  [sd release];
  return st;
}

// ---- Stage3D state -> Metal enums ------------------------------------------
//
// Stage3D exposes its state through AS3 enum *strings* (Context3DCompareMode,
// Context3DStencilAction, Context3DTriangleFace, Context3DWrapMode,
// Context3DTextureFilter, Context3DMipFilter). The string values below are the
// ones the port emits (verified against adl) — e.g. "lessEqual",
// "incrementSaturate", "frontAndBack", "mipnearest".
static MTLCompareFunction s3d_compare(const char* name) {
  if (name == NULL) return MTLCompareFunctionAlways;
  if (!strcmp(name, "never")) { return MTLCompareFunctionNever; }
  if (!strcmp(name, "less")) { return MTLCompareFunctionLess; }
  if (!strcmp(name, "equal")) { return MTLCompareFunctionEqual; }
  if (!strcmp(name, "lessEqual")) { return MTLCompareFunctionLessEqual; }
  if (!strcmp(name, "greater")) { return MTLCompareFunctionGreater; }
  if (!strcmp(name, "notEqual")) { return MTLCompareFunctionNotEqual; }
  if (!strcmp(name, "greaterEqual")) { return MTLCompareFunctionGreaterEqual; }
  return MTLCompareFunctionAlways;
}

static MTLStencilOperation s3d_stencil_op(const char* name) {
  if (name == NULL) return MTLStencilOperationKeep;
  if (!strcmp(name, "keep")) { return MTLStencilOperationKeep; }
  if (!strcmp(name, "zero")) { return MTLStencilOperationZero; }
  if (!strcmp(name, "replace")) { return MTLStencilOperationReplace; }
  // Stage3D's SET writes the reference value like REPLACE; Metal has no separate
  // SET op, so both map to Replace.
  if (!strcmp(name, "set")) { return MTLStencilOperationReplace; }
  if (!strcmp(name, "incrementSaturate")) { return MTLStencilOperationIncrementClamp; }
  if (!strcmp(name, "decrementSaturate")) { return MTLStencilOperationDecrementClamp; }
  if (!strcmp(name, "invert")) { return MTLStencilOperationInvert; }
  if (!strcmp(name, "incrementWrap")) { return MTLStencilOperationIncrementWrap; }
  if (!strcmp(name, "decrementWrap")) { return MTLStencilOperationDecrementWrap; }
  return MTLStencilOperationKeep;
}

// Rebuild the cached MTLDepthStencilState from the recorded Stage3D state.
// Metal needs one even when there is no stencil test, otherwise the depth
// compare/write state would be undefined (and a pipeline with a depth attachment
// would fail validation).
// Copy a (possibly NULL) state name into a fixed key buffer. The recorded
// pointers are caller-owned and may be transient, so the cache key owns its copy
// -- the previous design kept the raw pointer in c->depthCompare and compared it
// with strcmp, which worked only because the generated C happens to pass string
// literals.
static void s3d_key_str(char* dst, size_t cap, const char* s) {
  if (s == NULL) { dst[0] = '\0'; return; }
  size_t n = strlen(s);
  if (n >= cap) n = cap - 1;
  memcpy(dst, s, n);
  dst[n] = '\0';
}

// Select (or build, on first use) the depth/stencil state matching what is
// recorded on the context. Mirrors s3d_select_pso: a state setter between two
// draws now lands on a cached object instead of allocating a driver object.
static void s3d_select_dss(S3DContext* c) {
  char dc[32], sf[16], sc[32], bp[32], df[32], dp[32];
  s3d_key_str(dc, sizeof dc, c->depthCompare);
  s3d_key_str(sf, sizeof sf, c->stencilFace);
  s3d_key_str(sc, sizeof sc, c->stencilCompare);
  s3d_key_str(bp, sizeof bp, c->stencilBothPass);
  s3d_key_str(df, sizeof df, c->stencilDepthFail);
  s3d_key_str(dp, sizeof dp, c->stencilDepthPassStencilFail);
  int dw = c->depthWrite ? 1 : 0;
  for (int i = 0; i < c->ndss; i++) {
    S3DDssVariant* v = &c->dssv[i];
    if (v->depthWrite == dw && strcmp(v->depthCompare, dc) == 0 &&
        strcmp(v->stencilFace, sf) == 0 && strcmp(v->stencilCompare, sc) == 0 &&
        strcmp(v->bothPass, bp) == 0 && strcmp(v->depthFail, df) == 0 &&
        strcmp(v->dpFail, dp) == 0 &&
        v->readMask == c->stencilReadMask && v->writeMask == c->stencilWriteMask) {
      v->stamp = ++c->dssstamp;
      c->dss = v->state;
      c->dssDirty = 0;
      return;
    }
  }
  asc_tr_dss++;
  MTLDepthStencilDescriptor* dd = [[MTLDepthStencilDescriptor alloc] init];
  dd.depthCompareFunction = s3d_compare(c->depthCompare);
  dd.depthWriteEnabled = c->depthWrite ? YES : NO;
  if (c->stencilCompare != NULL) {
    MTLStencilDescriptor* sd = [[MTLStencilDescriptor alloc] init];
    sd.stencilCompareFunction = s3d_compare(c->stencilCompare);
    sd.depthStencilPassOperation = s3d_stencil_op(c->stencilBothPass);
    sd.depthFailureOperation = s3d_stencil_op(c->stencilDepthFail);
    sd.stencilFailureOperation = s3d_stencil_op(c->stencilDepthPassStencilFail);
    sd.readMask = c->stencilReadMask;
    sd.writeMask = c->stencilWriteMask;
    // Stage3D selects the face being tested/culled; Metal keeps separate front
    // and back stencil descriptors, so mirror the same state onto the selected
    // face(s). "frontAndBack" (Starling's masking) drives both.
    bool useFront = true, useBack = true;
    if (c->stencilFace != NULL && !strcmp(c->stencilFace, "front")) useBack = false;
    else if (c->stencilFace != NULL && !strcmp(c->stencilFace, "back")) useFront = false;
    if (useFront) dd.frontFaceStencil = sd;
    if (useBack) dd.backFaceStencil = sd;
    [sd release];
  }
  id<MTLDepthStencilState> ns = [c->device newDepthStencilStateWithDescriptor:dd];
  [dd release];
  if (ns == nil) {
    // Keep the previously bound state rather than dropping to "no depth test":
    // a wrong-but-defined depth compare beats an unbounded draw, and the caller
    // gets the same loud-ish signal as the pipeline path below.
    fprintf(stderr, "stage3d_glue: depth/stencil state create failed\n");
    c->dssDirty = 0;
    return;
  }
  int idx;
  if (c->ndss < S3D_MAX_DSS) {
    idx = c->ndss++;
  } else {
    // Cache full: evict the least recently used tuple. away3d/Starling use a
    // handful of depth/stencil combinations, so this only guards a pathological
    // program.
    idx = 0;
    for (int i = 1; i < c->ndss; i++) if (c->dssv[i].stamp < c->dssv[idx].stamp) idx = i;
    if (c->dssv[idx].state != nil) [c->dssv[idx].state release];
  }
  S3DDssVariant* v = &c->dssv[idx];
  v->depthWrite = dw;
  memcpy(v->depthCompare, dc, sizeof dc);
  memcpy(v->stencilFace, sf, sizeof sf);
  memcpy(v->stencilCompare, sc, sizeof sc);
  memcpy(v->bothPass, bp, sizeof bp);
  memcpy(v->depthFail, df, sizeof df);
  memcpy(v->dpFail, dp, sizeof dp);
  v->readMask = c->stencilReadMask;
  v->writeMask = c->stencilWriteMask;
  v->state = ns;
  v->stamp = ++c->dssstamp;
  c->dss = ns;
  c->dssDirty = 0;
}

// Cached sampler state for one (filter, wrap, mip) combination.
static id<MTLSamplerState> s3d_sampler_for(S3DContext* c, int filter, int wrap, int mip) {
  if (filter < 0 || filter > 1) filter = 0;
  if (wrap < 0 || wrap > 1) wrap = 0;
  if (mip < 0 || mip > 2) mip = 0;
  if (c->samplerCache[filter][wrap][mip] != nil) return c->samplerCache[filter][wrap][mip];
  MTLSamplerDescriptor* sd = [[MTLSamplerDescriptor alloc] init];
  sd.minFilter = filter == 1 ? MTLSamplerMinMagFilterNearest : MTLSamplerMinMagFilterLinear;
  sd.magFilter = filter == 1 ? MTLSamplerMinMagFilterNearest : MTLSamplerMinMagFilterLinear;
  sd.mipFilter = mip == 0 ? MTLSamplerMipFilterNotMipmapped
               : (mip == 1 ? MTLSamplerMipFilterNearest : MTLSamplerMipFilterLinear);
  MTLSamplerAddressMode mode = wrap == 1 ? MTLSamplerAddressModeRepeat : MTLSamplerAddressModeClampToEdge;
  sd.sAddressMode = mode;
  sd.tAddressMode = mode;
  sd.lodMinClamp = 0.0f;
  sd.lodMaxClamp = FLT_MAX;
  id<MTLSamplerState> st = [c->device newSamplerStateWithDescriptor:sd];
  [sd release];
  asc_tr_smpmiss++;
  c->samplerCache[filter][wrap][mip] = st;
  return st;
}

// Live contexts. `s3d_destroy_texture` releases an MTLTexture whose +1 is owned
// by the AS texture object, but a context may still hold it BORROWED in a
// sampler slot or as the render override (e.g. Starling uploaded a new bitmap
// into the same AS texture, or disposed a filter helper texture while it was
// still the last-bound sampler). Binding a released MTLTexture crashes inside
// -[AGXG...FamilyRenderContext setFragmentTexture:atIndex:] (objc_retain on a
// dangling pointer, EXC_BAD_ACCESS). So every context registers itself and a
// destroyed texture scrubs itself out of every binding first.
#define S3D_MAX_CTX 4
static S3DContext* s3d_live[S3D_MAX_CTX];
static int s3d_live_n = 0;

static void s3d_register_ctx(S3DContext* c) {
  if (s3d_live_n < S3D_MAX_CTX) s3d_live[s3d_live_n++] = c;
}
static void s3d_unregister_ctx(S3DContext* c) {
  for (int i = 0; i < s3d_live_n; i++)
    if (s3d_live[i] == c) { s3d_live[i] = s3d_live[--s3d_live_n]; return; }
}
static void s3d_unbind_texture_everywhere(id<MTLTexture> t) {
  if (t == nil) return;
  for (int k = 0; k < s3d_live_n; k++) {
    S3DContext* c = s3d_live[k];
    for (int i = 0; i < 8; i++) if (c->textures[i] == t) { c->textures[i] = nil; c->texHasMips[i] = 0; }
    if (c->renderOverride == t) c->renderOverride = nil;
  }
}

// Commit the pending per-frame batch. `wait` = also block the CPU until the GPU
// finished it. No-op when no draws were batched since the last flush.
//
// Two flavours, because only one of them has to wait:
//
//   s3d_flush (wait=1)   -- before anything READS the target with the CPU: a
//   getBytes readback, or a resize/destroy that swaps the target out from under
//   a still-writing GPU. AIR's "readback returns what was drawn" needs it.
//   s3d_flush_async (0)  -- the frame boundary (present / the window loop). It
//   only has to make the target's writes VISIBLE TO THE GPU COMPOSITOR, and that
//   no longer needs a CPU round trip: since stage 114 the batch runs on the same
//   MTLCommandQueue as Skia's compositor (sk_mtl_shared_queue), and Metal
//   serializes the command buffers of one queue by submission order while
//   inserting the dependency barriers for the target (which keeps the default
//   tracked hazard mode). So the composite command buffer -- submitted later,
//   same queue -- cannot sample the target before these writes land. Waiting
//   here cost a measured ~0.6 ms of the ~0.93 ms/frame flush (vs ~0.34 ms of
//   whole-frame GPU work on an 8.33 ms budget, ~7% of the frame).
//
// Skia's own side already composes exactly this way: sk_mtl_end_frame commits
// its composite buffer with no wait at all.
static void s3d_flush_impl(void* ctx, int wait) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  id<MTLCommandBuffer> cb = c->batch;
  if (cb == nil) return;
  c->batch = nil;
  const int dbg = asc_s3d_stats();
  const double t0 = dbg ? asc_dbg_now_ms() : 0.0;
  // Same autorelease-pool wrap as before: commit may autorelease driver objects
  // and the C++ SDL loop has no pool of its own (the air-native leak).
  @autoreleasepool {
  [cb commit];
  if (wait) [cb waitUntilCompleted];
  if (dbg) {
    const double t_done = asc_dbg_now_ms();
    if (wait) {
      asc_dbg_acc_gpu += (cb.GPUEndTime - cb.GPUStartTime) * 1000.0;
      asc_dbg_acc_wait += t_done - t0;
    } else {
      asc_dbg_acc_commit += t_done - t0;
      // An async commit has nothing to time the GPU with yet, so bank this
      // buffer and read its GPU interval at the NEXT commit -- by then it has
      // finished (and if it has not, the CPU is running ahead of the GPU, which
      // is the point of not waiting). Keeps gpu= reportable after the split.
      if (asc_dbg_prev != nil) {
        if (asc_dbg_prev.status == MTLCommandBufferStatusCompleted)
          asc_dbg_acc_gpu += (asc_dbg_prev.GPUEndTime - asc_dbg_prev.GPUStartTime) * 1000.0;
        [asc_dbg_prev release];
      }
      asc_dbg_prev = [cb retain];
    }
    asc_dbg_acc_b++;
    if (asc_dbg_acc_n >= 240) {
      const double elapsed = (t_done - asc_dbg_t_first) / 1000.0;
      fprintf(stderr,
              "s3d_stats t=%.1fs draws=%ld draws/s=%.1f tri/draw=%.0f "
              "cpu=%.2fms gpu=%.2fms wait=%.2fms commit=%.2fms per-batch draws/batch=%.1f\n",
              elapsed, asc_dbg_tot_n, elapsed > 0.0 ? (double)asc_dbg_tot_n / elapsed : 0.0,
              asc_dbg_acc_tri / (double)asc_dbg_acc_n,
              asc_dbg_acc_cpu / (double)asc_dbg_acc_n,
              asc_dbg_acc_b > 0 ? asc_dbg_acc_gpu / (double)asc_dbg_acc_b : 0.0,
              asc_dbg_acc_b > 0 ? asc_dbg_acc_wait / (double)asc_dbg_acc_b : 0.0,
              asc_dbg_acc_b > 0 ? asc_dbg_acc_commit / (double)asc_dbg_acc_b : 0.0,
              asc_dbg_acc_b > 0 ? (double)asc_dbg_acc_n / (double)asc_dbg_acc_b : 0.0);
      fflush(stderr);
      asc_dbg_acc_cpu = asc_dbg_acc_tri = asc_dbg_acc_wait = 0;
      asc_dbg_acc_commit = asc_dbg_acc_gpu = 0;
      asc_dbg_acc_n = 0;
      asc_dbg_acc_b = 0;
    }
  }
  }  // @autoreleasepool
  [cb release];  // the +1 we took when the batch was opened
}

// Commit + wait: the readback / resize / destroy path (see s3d_flush_impl).
void s3d_flush(void* ctx) { s3d_flush_impl(ctx, 1); }

// Commit only: present() and the window loop, where the shared queue's ordering
// already protects the compositor's read (see s3d_flush_impl).
void s3d_flush_async(void* ctx) { s3d_flush_impl(ctx, 0); }

// Retire every live context's pending batch before Skia starts compositing a
// frame, so a draw issued from ANY callback (ENTER_FRAME, a mouse handler, a
// timer) is in the queue ahead of the composite, whatever issued it. Async, for
// the reason above; the CPU-visible readback paths still call s3d_flush.
void s3d_flush_all_async(void) {
  for (int i = 0; i < s3d_live_n; i++) s3d_flush_async(s3d_live[i]);
}

// Commit + wait for every live context (the CPU is about to read the targets).
void s3d_flush_all(void) {
  for (int i = 0; i < s3d_live_n; i++) s3d_flush(s3d_live[i]);
}

void* s3d_create(int width, int height) {
  id<MTLDevice> device = MTLCreateSystemDefaultDevice();
  if (device == nil) { fprintf(stderr, "stage3d_glue: no Metal device\n"); return NULL; }
  S3DContext* c = new S3DContext();
  c->device = device;
  // Share Skia's queue when it exists (see the weak declaration above); fall back
  // to a private one only in a build with no Ganesh to race with. Either way the
  // context holds a +1 that s3d_destroy releases.
  SkMtlSharedQueueFn sharedFn = sk_mtl_shared_queue_lookup();
  id<MTLCommandQueue> sharedQueue = (sharedFn != NULL) ? sharedFn() : nil;
  c->queue = (sharedQueue != nil) ? [sharedQueue retain] : [device newCommandQueue];
  c->width = width > 0 ? width : 1;
  c->height = height > 0 ? height : 1;
  c->target = nil;
  c->renderOverride = nil;
  c->depthStencil = nil;
  c->rtDepthStencil = nil;
  c->rtDepthStencilW = 0; c->rtDepthStencilH = 0;
  c->pso = nil;
  c->vfn = nil;
  c->ffn = nil;
  c->nbvars = 0;
  c->bstamp = 0;
  for (int i = 0; i < S3D_MAX_BLEND_VARIANTS; i++) { c->bvars[i].pso = nil; c->bvars[i].sf[0] = '\0'; c->bvars[i].df[0] = '\0'; c->bvars[i].writeMask = 0; c->bvars[i].stamp = 0; }
  c->numStreams = 0;
  c->indexBuffer = nil;
  c->numIndices = 0;
  c->vc = nil;
  c->fc = nil;
  for (int i = 0; i < 8; i++) { c->streams[i].buffer = nil; c->streams[i].components = 0; c->streams[i].numVertices = 0; c->textures[i] = nil; }
  c->clearR = c->clearG = c->clearB = 0.0f; c->clearA = 1.0f;
  c->blendSource = NULL;
  c->blendDest = NULL;
  c->instanceCount = 1;
  c->clearPending = 1;  // first draw must clear the (fresh) target
  c->clearColor = 1; c->clearDepth = 1; c->clearStencil = 1;
  c->clearDepthValue = 1.0f;
  c->clearStencilValue = 0;
  c->depthWrite = 0;
  c->depthCompare = NULL;
  c->cullMode = NULL;
  c->colorMaskR = 1; c->colorMaskG = 1; c->colorMaskB = 1; c->colorMaskA = 1;
  c->stencilFace = NULL;
  c->stencilCompare = NULL;
  c->stencilBothPass = NULL;
  c->stencilDepthFail = NULL;
  c->stencilDepthPassStencilFail = NULL;
  c->stencilRef = 0;
  c->stencilReadMask = 0xFF;
  c->stencilWriteMask = 0xFF;
  c->scissorOn = 0; c->scissorX = c->scissorY = c->scissorW = c->scissorH = 0;
  for (int i = 0; i < 8; i++) { c->samplerFilter[i] = 0; c->samplerWrap[i] = 0; c->samplerMip[i] = 0; c->samplerStateSet[i] = 0; c->texHasMips[i] = 0; }
  for (int i = 0; i < 2; i++) for (int j = 0; j < 2; j++) for (int k = 0; k < 3; k++) c->samplerCache[i][j][k] = nil;
  c->dss = nil;
  c->dssDirty = 1;
  c->ndss = 0;
  c->dssstamp = 0;
  for (int i = 0; i < S3D_MAX_DSS; i++) { c->dssv[i].state = nil; c->dssv[i].depthWrite = 0; c->dssv[i].depthCompare[0] = '\0'; c->dssv[i].stencilFace[0] = '\0'; c->dssv[i].stencilCompare[0] = '\0'; c->dssv[i].bothPass[0] = '\0'; c->dssv[i].depthFail[0] = '\0'; c->dssv[i].dpFail[0] = '\0'; c->dssv[i].readMask = 0; c->dssv[i].writeMask = 0; c->dssv[i].stamp = 0; }
  c->samplerLinear = s3d_make_sampler(device, true);
  c->samplerNearest = s3d_make_sampler(device, false);
  c->batch = nil;
  // Offscreen render target (BGRA8Unorm, the same format as CAMetalLayer so the
  // eventual compositing step is a straight blit). ShaderRead usage is required
  // by drawToBitmapData's readback and by render-to-texture (stage 83).
  MTLTextureDescriptor* td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
      width:c->width height:c->height mipmapped:NO];
  td.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
  // Shared storage (not the private default): the offscreen target is read back
  // to the CPU every frame (s3d_readback_render). A private-storage texture makes
  // getBytes do an internal GPU->CPU blit each call, allocating one blit command
  // buffer + blit context per frame that the driver never returns to the pool —
  // the residual shmup leak (AGXG14XFamilyBlitContext × 1/frame). Shared storage
  // (unified memory on Apple Silicon) makes getBytes a direct memcpy, no blit.
  td.storageMode = MTLStorageModeShared;
  c->target = [device newTextureWithDescriptor:td];
  if (c->target == nil) { fprintf(stderr, "stage3d_glue: failed to create render target\n"); delete c; return NULL; }
#ifdef ASC_RENDER_DEPTH_STENCIL
  c->depthStencil = s3d_make_depth_stencil(device, c->width, c->height);
  if (c->depthStencil == nil) { fprintf(stderr, "stage3d_glue: failed to create depth/stencil target\n"); }
#endif
  s3d_register_ctx(c);
  return (void*)c;
}

void s3d_destroy(void* ctx) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  // Finish any in-flight batch before tearing the context down, otherwise the
  // uncommitted encoders would be dropped (and the draws with them).
  s3d_flush(ctx);
  s3d_unregister_ctx(c);
  // MRC: release every retained resource the context owns. device/queue/target
  // and the vertex/index/constant buffers are +1 (from create/init and uploads).
  // c->textures[i] and c->renderOverride are BORROWED references (their +1 is
  // owned by the Texture->gpu handle and released by s3d_destroy_texture), so do
  // NOT release them here — that would double-free.
  for (int i = 0; i < 8; i++) {
    if (c->streams[i].buffer != nil) [c->streams[i].buffer release];
  }
  if (c->indexBuffer != nil) [c->indexBuffer release];
  if (c->vc != nil) [c->vc release];
  if (c->fc != nil) [c->fc release];
  // Releases every cached blend variant, including the bound c->pso, the live
  // program's functions, and every stashed program in the cache.
  s3d_clear_variants(c);
  if (c->vfn != nil) [c->vfn release];
  if (c->ffn != nil) [c->ffn release];
  c->vfn = nil; c->ffn = nil; c->progKey = NULL;
  for (int i = 0; i < c->nprogs; i++) s3d_prog_release(&c->progs[i]);
  c->nprogs = 0;
  if (c->target != nil) [c->target release];
  if (c->depthStencil != nil) [c->depthStencil release];
  if (c->rtDepthStencil != nil) [c->rtDepthStencil release];
  if (c->samplerLinear != nil) [c->samplerLinear release];
  if (c->samplerNearest != nil) [c->samplerNearest release];
  for (int i = 0; i < 2; i++) for (int j = 0; j < 2; j++) for (int k = 0; k < 3; k++)
    if (c->samplerCache[i][j][k] != nil) [c->samplerCache[i][j][k] release];
  // c->dss is borrowed from a slot, so only the slots release -- releasing it
  // here as well would be a double free.
  for (int i = 0; i < c->ndss; i++) if (c->dssv[i].state != nil) [c->dssv[i].state release];
  c->ndss = 0;
  c->dss = nil;
  if (c->queue != nil) [c->queue release];
  if (c->device != nil) [c->device release];
  delete c;
}

// Resize the offscreen render target (drawToBitmapData + window resize path).
int s3d_resize(void* ctx, int width, int height) {
  if (ctx == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  if (width <= 0 || height <= 0) return 0;
  if (width == c->width && height == c->height) return 1;
  // Retire the pending batch first: it targets the texture we are about to
  // replace, and a resize is a frame boundary in practice anyway.
  s3d_flush(ctx);
  c->width = width; c->height = height;
  MTLTextureDescriptor* td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
      width:c->width height:c->height mipmapped:NO];
  td.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
  td.storageMode = MTLStorageModeShared;
  if (c->target != nil) [c->target release];
  c->target = [c->device newTextureWithDescriptor:td];
#ifdef ASC_RENDER_DEPTH_STENCIL
  if (c->depthStencil != nil) [c->depthStencil release];
  c->depthStencil = s3d_make_depth_stencil(c->device, c->width, c->height);
#endif
  return c->target != nil ? 1 : 0;
}

// ---- buffers ----

// Upload a vertex stream. `data` is `numVertices * components` doubles (AS3
// Vector.<Number> holds doubles); converted to float32 on the Metal side. `stream`
// is the attribute index (0..7). Returns 1 on success.
int s3d_upload_vertex(void* ctx, int stream, const double* data, int numVertices, int components) {
  if (ctx == NULL || stream < 0 || stream > 7) return 0;
  S3DContext* c = (S3DContext*)ctx;
  if (components < 1 || components > 4 || numVertices <= 0) return 0;
  size_t n = (size_t)numVertices * (size_t)components;
  float* tmp = (float*)malloc(n * sizeof(float));
  for (size_t i = 0; i < n; i++) tmp[i] = (float)data[i];
  // MRC: release the previous frame's buffer before overwriting the pointer,
  // otherwise every upload leaks one full vertex buffer (this ran every frame).
  if (c->streams[stream].buffer != nil) [c->streams[stream].buffer release];
  c->streams[stream].buffer = [c->device newBufferWithBytes:tmp length:n * sizeof(float) options:0];
  free(tmp);
  c->streams[stream].components = components;
  c->streams[stream].numVertices = numVertices;
  if (stream + 1 > c->numStreams) c->numStreams = stream + 1;
  return c->streams[stream].buffer != nil ? 1 : 0;
}

// Upload the index buffer (uint32 indices).
int s3d_upload_index(void* ctx, const uint32_t* data, int numIndices) {
  if (ctx == NULL || numIndices <= 0) return 0;
  S3DContext* c = (S3DContext*)ctx;
  if (c->indexBuffer != nil) [c->indexBuffer release];
  c->indexBuffer = [c->device newBufferWithBytes:data length:(size_t)numIndices * sizeof(uint32_t) options:0];
  c->numIndices = numIndices;
  return c->indexBuffer != nil ? 1 : 0;
}

// Upload float4 constants: `isFragment ? fc : vc`, `count` doubles total (AS3
// Vector.<Number>); converted to float32 here.
int s3d_upload_constants(void* ctx, int isFragment, const double* data, int count) {
  if (ctx == NULL || count <= 0) return 0;
  S3DContext* c = (S3DContext*)ctx;
  id<MTLBuffer>* slot = isFragment ? &c->fc : &c->vc;
  float* tmp = (float*)malloc((size_t)count * sizeof(float));
  for (int i = 0; i < count; i++) tmp[i] = (float)data[i];
  if (*slot != nil) [*slot release];
  *slot = [c->device newBufferWithBytes:tmp length:(size_t)count * sizeof(float) options:0];
  free(tmp);
  return *slot != nil ? 1 : 0;
}

// Upload a 2D texture. `argb` is the runtime's straight-ARGB (0xAARRGGBB) uint32
// buffer (BitmapData.pixels). On a little-endian host that buffer's bytes are
// already B,G,R,A -- exactly MTLPixelFormatBGRA8Unorm's layout -- so the upload
// is a straight copy with no per-pixel pass. A big-endian host would read A,R,G,B
// and needs the explicit swizzle below (no such target exists today; kept so the
// byte-order rule is stated at the boundary rather than assumed).
//
// Returns the MTLTexture handle (owned +1 by the caller, released via
// s3d_destroy_texture) so the caller can cache it and bind on later frames
// instead of re-uploading the same sprite sheet every frame. It does NOT touch
// c->textures[unit]: the binding is the caller's job (s3d_bind_texture at draw
// time), which is what lets an upload happen before anything is drawn.
void* s3d_texture_from_pixels(void* ctx, int width, int height, const uint32_t* argb) {
  if (ctx == NULL || width <= 0 || height <= 0 || argb == NULL) return NULL;
  S3DContext* c = (S3DContext*)ctx;
  // mipmapped:YES even though most textures stay level-0-only: a Metal texture's
  // descriptor is immutable, so a chain can only be created together with the
  // texture. The cost is 4/3 of the base image in VRAM (Starling atlases pay it
  // whether or not they ever sample a mip); the alternative -- recreating the
  // texture when a level > 0 arrives -- would need the level-0 pixels, which
  // Starling has already disposed by then.
  MTLTextureDescriptor* td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
      width:width height:height mipmapped:YES];
  td.usage = MTLTextureUsageShaderRead;
  id<MTLTexture> tex = [c->device newTextureWithDescriptor:td];
  if (tex == nil) return NULL;
#if defined(__BYTE_ORDER__) && (__BYTE_ORDER__ == __ORDER_BIG_ENDIAN__)
  size_t n = (size_t)width * (size_t)height;
  uint8_t* bgra = (uint8_t*)malloc(n * 4);
  if (bgra == NULL) { [tex release]; return NULL; }
  for (size_t i = 0; i < n; i++) {
    uint32_t p = argb[i];
    bgra[i * 4 + 0] = (uint8_t)(p & 0xFF);         // B
    bgra[i * 4 + 1] = (uint8_t)((p >> 8) & 0xFF);  // G
    bgra[i * 4 + 2] = (uint8_t)((p >> 16) & 0xFF); // R
    bgra[i * 4 + 3] = (uint8_t)((p >> 24) & 0xFF); // A
  }
  [tex replaceRegion:MTLRegionMake2D(0, 0, width, height) mipmapLevel:0
      withBytes:bgra bytesPerRow:width * 4];
  free(bgra);
#else
  // Little-endian: a 0xAARRGGBB word in memory already reads B,G,R,A, which is
  // what BGRA8Unorm wants -- hand Metal the runtime buffer directly.
  [tex replaceRegion:MTLRegionMake2D(0, 0, width, height) mipmapLevel:0
      withBytes:argb bytesPerRow:width * 4];
#endif
  return (void*)tex;  // caller owns the +1
}

// Upload pixels AND bind them as fragment sampler fs{unit} in one step. Only
// correct when the draw that samples fs{unit} is the very next thing that
// happens; the sequential-upload-then-draw path in Context3D_submit uses it.
void* s3d_upload_texture(void* ctx, int unit, int width, int height, const uint32_t* argb) {
  asc_tr_uptex++;
  if (ctx == NULL || unit < 0 || unit > 7) return NULL;
  void* tex = s3d_texture_from_pixels(ctx, width, height, argb);
  if (tex != NULL) {
    S3DContext* c = (S3DContext*)ctx;
    c->textures[unit] = (id<MTLTexture>)tex;  // borrowed; caller owns the +1
    // Freshly uploaded level 0 only: no chain yet, so a mip-filtered sample on
    // it must drop the draw like AIR does (s3d_draw).
    c->texHasMips[unit] = 0;
  }
  return tex;
}

// Upload ONE mip level (level > 0) from the top-left lw x lh rectangle of a
// source whose row stride is srcW pixels.
//
// The REGION rule is measured, not assumed (temp/mipprobe, adl 51.4.1, T5): the
// level gets the source's top-left corner, read with the SOURCE's row stride.
// The probe's source is horizontal stripes grey(32r+16) and level 1 read back as
// 16,48,80,112 -- exactly source rows 0..3 -- while the two alternatives predict
// 16,16,48,48 (tightly packed first lw*lh pixels) and 32,96,160,224 (whole-source
// rescale). This is what makes away3d's MipmapGenerator work: it re-uses ONE
// full-size scratch bitmap, re-scaling level i into that bitmap's top-left
// (W>>i)x(H>>i) rectangle before upload (MipmapGenerator.as).
//
// The texture is created mipmapped:YES so the levels already exist; this only
// writes one of them, synchronously (a Shared-storage CPU write -- no command
// buffer, so nothing needs ordering against the frame's draw batch).
void s3d_texture_upload_level(void* ctx, void* tex, int level, int lw, int lh, const uint32_t* src, int srcW) {
  if (ctx == NULL || tex == NULL || src == NULL) return;
  if (level <= 0 || lw <= 0 || lh <= 0 || srcW < lw) return;
  id<MTLTexture> t = (id<MTLTexture>)tex;
  if (level >= (int)t.mipmapLevelCount) return;
  asc_tr_mipbuild++;
#if defined(__BYTE_ORDER__) && (__BYTE_ORDER__ == __ORDER_BIG_ENDIAN__)
  // A 0xAARRGGBB word in memory reads B,G,R,A on little-endian only; on a
  // big-endian host the region must be re-packed before it can be handed over
  // (same rule as s3d_texture_from_pixels' level-0 upload).
  size_t n = (size_t)lw * (size_t)lh;
  uint8_t* bgra = (uint8_t*)malloc(n * 4);
  if (bgra == NULL) return;
  for (int y = 0; y < lh; y++) {
    for (int x = 0; x < lw; x++) {
      uint32_t p = src[(size_t)y * (size_t)srcW + (size_t)x];
      uint8_t* d = bgra + ((size_t)y * (size_t)lw + (size_t)x) * 4;
      d[0] = (uint8_t)(p & 0xFF);
      d[1] = (uint8_t)((p >> 8) & 0xFF);
      d[2] = (uint8_t)((p >> 16) & 0xFF);
      d[3] = (uint8_t)((p >> 24) & 0xFF);
    }
  }
  [t replaceRegion:MTLRegionMake2D(0, 0, (NSUInteger)lw, (NSUInteger)lh) mipmapLevel:(NSUInteger)level
      withBytes:bgra bytesPerRow:(NSUInteger)lw * 4];
  free(bgra);
#else
  [t replaceRegion:MTLRegionMake2D(0, 0, (NSUInteger)lw, (NSUInteger)lh) mipmapLevel:(NSUInteger)level
      withBytes:src bytesPerRow:(NSUInteger)srcW * 4];
#endif
}

// Same as s3d_upload_texture but for a cube map: the six faces arrive as six
// ARGB buffers (AGAL/Stage3D order: +X, -X, +Y, -Y, +Z, -Z) in ONE
// MTLTextureTypeCube, so the sampler declared `texturecube<float>` by the AGAL
// translator can sample it. `size` is the face edge (cube faces are square).
//
// The texture gets a FULL MIP CHAIN, like AIR's. away3d uploads every level of
// a BitmapCubeTexture (BitmapCubeTexture.as -> MipmapGenerator.generateMipMaps
// -> CubeTexture.uploadFromBitmapData(mipmap, side, i++)), and away3d never
// calls setSamplerStateAt, so the env-map reflection is minified with
// Stage3D's default sampler state -- which therefore selects mip levels. A
// level-0-only cube made the *skybox* look right (it magnifies the cube, one
// texel spread over several pixels) while every MINIFIED sample -- the chrome
// torus's environment reflection -- aliased into per-pixel noise, because a
// 512-texel environment map squeezed into a few hundred pixels of ring has no
// level to fall back to. Metal builds the chain from level 0 itself (the same
// box-filtered content the CPU-side generator produced), which keeps this
// independent of the deferred-upload ordering that forced level-0-only (see
// CubeTexture_uploadFromBitmapData in emit.ts).
//
// Shared S3DContext mip generator state: `tex` must outlive the blit, and the
// source level 0 of all six faces must already be filled -- call this once,
// after the face loop.
static void s3d_generate_cube_mips(S3DContext* c, id<MTLTexture> tex) {
  // The mip chain is built with a blit pass on the context's own queue, so it
  // is ordered before the frame's draw batch (same queue, FIFO) whatever
  // command buffer that batch ends up in. Wait on completion: the texture is
  // sampled this frame, and this runs once per asset upload, not per frame.
  id<MTLCommandBuffer> cb = [c->queue commandBuffer];
  id<MTLBlitCommandEncoder> blit = [cb blitCommandEncoder];
  [blit generateMipmapsForTexture:tex];
  [blit endEncoding];
  [cb commit];
  [cb waitUntilCompleted];
}

void* s3d_upload_cube_texture(void* ctx, int unit, int size, const uint32_t* const* argb) {
  asc_tr_cube++;
  if (ctx == NULL || unit < 0 || unit > 7 || size <= 0 || argb == NULL) return NULL;
  S3DContext* c = (S3DContext*)ctx;
  MTLTextureDescriptor* td = [MTLTextureDescriptor textureCubeDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
      size:(NSUInteger)size mipmapped:YES];
  td.usage = MTLTextureUsageShaderRead;
  id<MTLTexture> tex = [c->device newTextureWithDescriptor:td];
  if (tex == nil) return NULL;
  for (int face = 0; face < 6; face++) {
    if (argb[face] == NULL) { [tex release]; return NULL; }
    // Little-endian: a 0xAARRGGBB word in memory already reads B,G,R,A for
    // BGRA8Unorm, exactly like the 2D upload (see s3d_texture_from_pixels).
    // A cube face is a texture *slice*, so the upload must use the slice
    // variant that also takes bytesPerImage — the 2D `...mipmapLevel:withBytes:
    // bytesPerRow:` selector does not exist on a cube texture (sending it is an
    // unrecognized selector, i.e. a hard crash, not a driver no-op).
    [tex replaceRegion:MTLRegionMake2D(0, 0, size, size) mipmapLevel:0 slice:(NSUInteger)face
        withBytes:argb[face] bytesPerRow:(NSUInteger)size * 4 bytesPerImage:(NSUInteger)size * 4 * (NSUInteger)size];
  }
  s3d_generate_cube_mips(c, tex);
  c->textures[unit] = tex;  // borrowed; caller owns the +1
  c->texHasMips[unit] = 1;  // cube maps always carry a chain (built just above)
  return (void*)tex;
}

// ---- program ----

// Vertex streams bind at MTLBuffer indices STREAM_BASE..STREAM_BASE+7. Buffer
// index 0 is reserved for the vertex-constant array (vc, `[[buffer(0)]]` in the
// generated MSL); Metal's `[[attribute(i)]]` resolves its buffer through the
// vertex descriptor's `bufferIndex`, so attribute i reads buffer STREAM_BASE+i
// without colliding with the constants. This mirrors the demo shaders that read
// va0/va1 while also using vc0..vc3.
#define S3D_STREAM_BASE 8

// Map an AGAL vertex-buffer component count to a Metal vertex format. Metal
// fetches 1/2/3 floats and expands the float4 register with (0,0,1) padding,
// which is exactly how AGAL's vaN float4 is defined.
static MTLVertexFormat s3d_vformat(int components) {
  switch (components) {
    case 1: return MTLVertexFormatFloat;
    case 2: return MTLVertexFormatFloat2;
    case 3: return MTLVertexFormatFloat3;
    case 4: return MTLVertexFormatFloat4;
    default: return MTLVertexFormatFloat4;
  }
}

// Map an AS3 Context3DBlendFactor name (the constClass string value, e.g.
// "one" / "oneMinusSourceAlpha") to the Metal blend factor. Unknown/NULL falls
// back to ONE so the common premultiplied (ONE, ONE_MINUS_SOURCE_ALPHA) path is
// the safe default.
static MTLBlendFactor s3d_blend_factor(const char* name) {
  if (name == NULL) return MTLBlendFactorOne;
  if (strcmp(name, "zero") == 0) return MTLBlendFactorZero;
  if (strcmp(name, "one") == 0) return MTLBlendFactorOne;
  if (strcmp(name, "sourceColor") == 0) return MTLBlendFactorSourceColor;
  if (strcmp(name, "oneMinusSourceColor") == 0) return MTLBlendFactorOneMinusSourceColor;
  if (strcmp(name, "sourceAlpha") == 0) return MTLBlendFactorSourceAlpha;
  if (strcmp(name, "oneMinusSourceAlpha") == 0) return MTLBlendFactorOneMinusSourceAlpha;
  if (strcmp(name, "destinationColor") == 0) return MTLBlendFactorDestinationColor;
  if (strcmp(name, "oneMinusDestinationColor") == 0) return MTLBlendFactorOneMinusDestinationColor;
  if (strcmp(name, "destinationAlpha") == 0) return MTLBlendFactorDestinationAlpha;
  if (strcmp(name, "oneMinusDestinationAlpha") == 0) return MTLBlendFactorOneMinusDestinationAlpha;
  return MTLBlendFactorOne;
}

// Copy a blend-factor name into a variant key; NULL (blending off) becomes "".
static void s3d_factor_key(char* dst, const char* name) {
  if (name == NULL) { dst[0] = '\0'; return; }
  snprintf(dst, 32, "%s", name);
}

// Build one render pipeline for the current program (c->vfn/c->ffn + the vertex
// streams and attachments bound on the context) with the given blend factors
// (both NULL = blending disabled). Only the blend state varies between variants,
// so this is the single place a pipeline state is created. Returns nil on
// failure; *err receives the Metal error.
static id<MTLRenderPipelineState> s3d_make_pso(S3DContext* c, const char* blendSource,
                                              const char* blendDest, unsigned int writeMask, NSError** err) {
  MTLRenderPipelineDescriptor* pd = [[MTLRenderPipelineDescriptor alloc] init];
  pd.vertexFunction = c->vfn;
  pd.fragmentFunction = c->ffn;
  pd.colorAttachments[0].pixelFormat = MTLPixelFormatBGRA8Unorm;
  // Color write mask (setColorMask). Metal bakes it into the pipeline, so the
  // caller passes the mask recorded by the last setColorMask -- MTLClearMaskAll
  // when all four channels are writable, which is also the descriptor default.
  pd.colorAttachments[0].writeMask = writeMask;
  // Depth/stencil: only when the manifest allocated the attachment
  // (ASC_RENDER_DEPTH_STENCIL). The pipeline must declare the depth/stencil pixel
  // format or the render pass's depth attachment would be ignored; depth test /
  // stencil ops themselves are driven by Context3D_setDepthTest/setStencilActions
  // (stage 87) and land on the encoder in s3d_draw below.
  if (c->depthStencil != nil) {
    pd.depthAttachmentPixelFormat = MTLPixelFormatDepth32Float_Stencil8;
    pd.stencilAttachmentPixelFormat = MTLPixelFormatDepth32Float_Stencil8;
  }
  // Blending defaults to off; setBlendFactors turns it on. Stage3D's initial
  // state is (ONE, ZERO), which is exactly "no blending".
  pd.colorAttachments[0].blendingEnabled = NO;
  if (blendSource != NULL || blendDest != NULL) {
    MTLBlendFactor sf = s3d_blend_factor(blendSource);
    MTLBlendFactor df = s3d_blend_factor(blendDest);
    pd.colorAttachments[0].blendingEnabled = YES;
    pd.colorAttachments[0].sourceRGBBlendFactor = sf;
    pd.colorAttachments[0].destinationRGBBlendFactor = df;
    pd.colorAttachments[0].sourceAlphaBlendFactor = sf;
    pd.colorAttachments[0].destinationAlphaBlendFactor = df;
    pd.colorAttachments[0].rgbBlendOperation = MTLBlendOperationAdd;
    pd.colorAttachments[0].alphaBlendOperation = MTLBlendOperationAdd;
  }

  // Vertex descriptor: one layout per stream, stride = components * 4 bytes.
  MTLVertexDescriptor* vd = [MTLVertexDescriptor vertexDescriptor];
  for (int i = 0; i < c->numStreams && i < 8; i++) {
    if (c->streams[i].components <= 0) continue;
    int bi = S3D_STREAM_BASE + i;
    vd.attributes[i].format = s3d_vformat(c->streams[i].components);
    vd.attributes[i].offset = 0;
    vd.attributes[i].bufferIndex = bi;
    vd.layouts[bi].stride = c->streams[i].components * sizeof(float);
    vd.layouts[bi].stepFunction = MTLVertexStepFunctionPerVertex;
    vd.layouts[bi].stepRate = 1;
  }
  pd.vertexDescriptor = vd;

  asc_tr_pso++;
  id<MTLRenderPipelineState> pso = [c->device newRenderPipelineStateWithDescriptor:pd error:err];
  [pd release];
  return pso;
}

// Drop every cached blend variant (program change / context destruction). The
// bound pipeline is one of them, so it is cleared as well; the caller assigns a
// fresh one right after.
static void s3d_clear_variants(S3DContext* c) {
  for (int i = 0; i < c->nbvars; i++) {
    if (c->bvars[i].pso != nil) [c->bvars[i].pso release];
    c->bvars[i].pso = nil;
    c->bvars[i].sf[0] = '\0';
    c->bvars[i].df[0] = '\0';
    c->bvars[i].writeMask = 0;
  }
  c->nbvars = 0;
  c->pso = nil;
}

// MTLColorWriteMask bits for the mask recorded on the context (all four channels
// by default, which s3d_create sets).
static unsigned int s3d_color_mask_bits(const S3DContext* c) {
  unsigned int m = 0;
  if (c->colorMaskR) m |= MTLColorWriteMaskRed;
  if (c->colorMaskG) m |= MTLColorWriteMaskGreen;
  if (c->colorMaskB) m |= MTLColorWriteMaskBlue;
  if (c->colorMaskA) m |= MTLColorWriteMaskAlpha;
  return m;
}

// Select the pipeline whose baked blend + color-write state matches what is
// currently recorded on the context, building and caching it on first use. Called
// once per encoded draw: a setBlendFactors or setColorMask between two draws
// (same program) now takes effect instead of being silently ignored.
static void s3d_select_pso(S3DContext* c) {
  if (c->vfn == nil || c->ffn == nil) return;
  char sf[32], df[32];
  s3d_factor_key(sf, c->blendSource);
  s3d_factor_key(df, c->blendDest);
  unsigned int wm = s3d_color_mask_bits(c);
  for (int i = 0; i < c->nbvars; i++) {
    if (strcmp(c->bvars[i].sf, sf) == 0 && strcmp(c->bvars[i].df, df) == 0 && c->bvars[i].writeMask == wm) {
      c->bvars[i].stamp = ++c->bstamp;
      c->pso = c->bvars[i].pso;
      return;
    }
  }
  asc_tr_psomiss++;
  NSError* err = nil;
  id<MTLRenderPipelineState> pso = s3d_make_pso(c, c->blendSource, c->blendDest, wm, &err);
  if (pso == nil) {
    fprintf(stderr, "stage3d_glue: blend variant pipeline failed: %s\n", [[err localizedDescription] UTF8String]);
    return;  // keep the previous pipeline: a wrong blend beats no draw at all
  }
  int idx;
  if (c->nbvars < S3D_MAX_BLEND_VARIANTS) {
    idx = c->nbvars++;
  } else {
    // Cache full: evict the least recently used variant. Starling registers fewer
    // than a dozen blend modes; away3d adds a handful of color-mask combinations
    // (all-on / all-off), so this only guards a pathological program.
    idx = 0;
    for (int i = 1; i < c->nbvars; i++) if (c->bvars[i].stamp < c->bvars[idx].stamp) idx = i;
    if (c->bvars[idx].pso != nil) [c->bvars[idx].pso release];
  }
  s3d_factor_key(c->bvars[idx].sf, c->blendSource);
  s3d_factor_key(c->bvars[idx].df, c->blendDest);
  c->bvars[idx].writeMask = wm;
  c->bvars[idx].pso = pso;
  c->bvars[idx].stamp = ++c->bstamp;
  c->pso = pso;
}

// Release everything a cache slot owns (its functions and every blend-variant
// pipeline built from them). The slot's KEY is deliberately left in place: it is
// how an emptied slot is still found on the next switch to that program.
static void s3d_prog_release(S3DProgramCache* e) {
  if (e->vfn != nil) { [e->vfn release]; e->vfn = nil; }
  if (e->ffn != nil) { [e->ffn release]; e->ffn = nil; }
  for (int i = 0; i < e->nbvars; i++) {
    if (e->bvars[i].pso != nil) [e->bvars[i].pso release];
    e->bvars[i].pso = nil;
    e->bvars[i].sf[0] = '\0';
    e->bvars[i].df[0] = '\0';
    e->bvars[i].writeMask = 0;
  }
  e->nbvars = 0;
}

// Move the LIVE program (c->vfn/c->ffn + its blend variants) into the cache slot
// named c->progKey so a later switch back to it is a pointer lookup instead of a
// Metal recompile. Ownership MOVES: the live slots are emptied afterwards, so at
// any moment exactly one place owns each function/pipeline. A full table evicts
// the least recently used slot (never the one being stashed: it is refreshed).
// No-op when the live program is unkeyed (key == NULL).
static void s3d_prog_stash(S3DContext* c) {
  if (c->progKey == NULL) return;
  int idx = -1;
  for (int i = 0; i < c->nprogs; i++) if (c->progs[i].key == c->progKey) { idx = i; break; }
  if (idx < 0) {
    if (c->nprogs < S3D_MAX_PROGRAMS) {
      idx = c->nprogs++;
      c->progs[idx].key = c->progKey;
      c->progs[idx].vfn = nil;
      c->progs[idx].ffn = nil;
      c->progs[idx].nbvars = 0;
    } else {
      idx = 0;
      for (int i = 1; i < c->nprogs; i++) if (c->progs[i].stamp < c->progs[idx].stamp) idx = i;
      s3d_prog_release(&c->progs[idx]);
      c->progs[idx].key = c->progKey;
    }
  } else {
    // The slot still holds an older copy of this program's state (a recompile of
    // the same Program3D): drop it, the live state replaces it below.
    s3d_prog_release(&c->progs[idx]);
  }
  S3DProgramCache* e = &c->progs[idx];
  e->vfn = c->vfn;
  e->ffn = c->ffn;
  memcpy(e->bvars, c->bvars, sizeof(e->bvars));
  e->nbvars = c->nbvars;
  e->srcHash = c->progHash;
  e->stamp = ++c->progstamp;
  c->vfn = nil;
  c->ffn = nil;
  c->nbvars = 0;
  memset(c->bvars, 0, sizeof(c->bvars));
  c->pso = nil;   // the bound pipeline was one of the variants just moved
  c->progKey = NULL;
}

// Move a cached program's state back into the live slots. The slot keeps its key
// (so it is still findable) and gives up ownership of the resources.
static void s3d_prog_load(S3DContext* c, int idx) {
  S3DProgramCache* e = &c->progs[idx];
  c->vfn = e->vfn;
  c->ffn = e->ffn;
  memcpy(c->bvars, e->bvars, sizeof(c->bvars));
  c->nbvars = e->nbvars;
  e->vfn = nil;
  e->ffn = nil;
  e->nbvars = 0;
  memset(e->bvars, 0, sizeof(e->bvars));
  // Re-selected from the restored variants by the next s3d_draw.
  c->pso = nil;
  c->progKey = e->key;
  c->progHash = e->srcHash;
  e->stamp = ++c->progstamp;
}

// FNV-1a over both shader sources: the cache slot's content check. The Program3D
// pointer alone is not enough — Stage3D lets the SAME Program3D be re-uploaded
// with new bytecode (Program3D.upload), which produces different MSL that must be
// recompiled instead of silently reusing the stale pipeline.
static unsigned long long s3d_src_hash(const char* vs, const char* fs) {
  unsigned long long h = 1469598103934665603ULL;
  for (const char* p = vs; p != NULL && *p != '\0'; p++) { h ^= (unsigned char)*p; h *= 1099511628211ULL; }
  h ^= 0xFFUL; h *= 1099511628211ULL;   // separator: vs and fs must not be confusable
  for (const char* p = fs; p != NULL && *p != '\0'; p++) { h ^= (unsigned char)*p; h *= 1099511628211ULL; }
  return h;
}

// Compile vertex + fragment MSL into the program's functions and build the
// pipeline for the blend factors in effect right now. `key` is the Program3D
// identity the caller wants current (NULL = compile without caching).
// Returns 1 on success, 0 on failure (errbuf receives a truncated message).
int s3d_compile(void* ctx, void* key, const char* vs_msl, const char* fs_msl, char* errbuf, int errbuf_size) {
  if (ctx == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  asc_tr_compile++;
  // away3d alternates its two materials on every frame, so this entry point runs
  // on nearly every draw. A program whose source is already compiled is merely
  // SELECTED here (see S3DProgramCache) — only new MSL reaches the Metal
  // compiler, exactly like AIR's program bind.
  const unsigned long long srchash = s3d_src_hash(vs_msl, fs_msl);
  if (key != NULL) {
    int cached = -1;
    for (int i = 0; i < c->nprogs; i++) if (c->progs[i].key == key) { cached = i; break; }
    if (cached >= 0 && c->progs[cached].srcHash == srchash) {
      // Already compiled from exactly this source: bind it instead of rebuilding.
      if (c->progKey == key && c->progHash == srchash) return 1;
      if (c->progKey != key) { s3d_prog_stash(c); s3d_prog_load(c, cached); return 1; }
    }
    // Preserve whatever program is live, then drop a stale copy of THIS one.
    // (Re-find it afterwards: the stash may have evicted that very slot.)
    s3d_prog_stash(c);
    for (int i = 0; i < c->nprogs; i++) if (c->progs[i].key == key) { s3d_prog_release(&c->progs[i]); break; }
  } else {
    // No identity to cache under: the previous program is unreachable.
    s3d_clear_variants(c);
    if (c->vfn != nil) { [c->vfn release]; c->vfn = nil; }
    if (c->ffn != nil) { [c->ffn release]; c->ffn = nil; }
  }
  if (asc_s3d_dump()) {
    fprintf(stderr, "=== MSL VERTEX ===\n%s\n=== MSL FRAGMENT ===\n%s\n=== END MSL ===\n", vs_msl, fs_msl);
  }
  NSError* err = nil;
  id<MTLLibrary> vlib = [c->device newLibraryWithSource:[NSString stringWithUTF8String:vs_msl] options:nil error:&err];
  if (vlib == nil) {
    fprintf(stderr, "stage3d_glue: MSL(vertex) compile failed: %s\n", [[err localizedDescription] UTF8String]);
    if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "MSL(vertex): %s", [[err localizedDescription] UTF8String]);
    return 0;
  }
  id<MTLFunction> vfn = [vlib newFunctionWithName:@"vs_main"];
  if (vfn == nil) {
    if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "MSL: no vs_main");
    [vlib release];   // MRC: nothing else kept it
    return 0;
  }

  id<MTLLibrary> flib = [c->device newLibraryWithSource:[NSString stringWithUTF8String:fs_msl] options:nil error:&err];
  if (flib == nil) {
    fprintf(stderr, "stage3d_glue: MSL(fragment) compile failed: %s\n", [[err localizedDescription] UTF8String]);
    if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "MSL(fragment): %s", [[err localizedDescription] UTF8String]);
    [vfn release];
    [vlib release];
    return 0;
  }
  id<MTLFunction> ffn = [flib newFunctionWithName:@"fs_main"];
  if (ffn == nil) {
    if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "MSL: no fs_main");
    [vfn release];
    [vlib release];
    [flib release];
    return 0;
  }

  // The live slots are already empty: the code above either restored this
  // program from the cache or moved the previous one into its slot.
  c->vfn = vfn;
  c->ffn = ffn;
  // MRC: the libraries are +1 and no longer needed once the functions are
  // created; the functions themselves stay retained on the context so a later
  // setBlendFactors can build another variant of the same program.
  [vlib release];
  [flib release];

  NSError* perr = nil;
  id<MTLRenderPipelineState> pso = s3d_make_pso(c, c->blendSource, c->blendDest, s3d_color_mask_bits(c), &perr);
  if (pso == nil) {
    fprintf(stderr, "stage3d_glue: pipeline create failed: %s\n", [[perr localizedDescription] UTF8String]);
    if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "pipeline: %s", [[perr localizedDescription] UTF8String]);
    return 0;
  }
  // Seed the cache with this variant so a re-selection never rebuilds it.
  s3d_factor_key(c->bvars[0].sf, c->blendSource);
  s3d_factor_key(c->bvars[0].df, c->blendDest);
  c->bvars[0].writeMask = s3d_color_mask_bits(c);
  c->bvars[0].pso = pso;
  c->bvars[0].stamp = ++c->bstamp;
  c->nbvars = 1;
  c->pso = pso;
  // Record the live program's identity + source hash, so the next switch away
  // stashes it under the right slot and a re-upload is detected.
  c->progKey = key;
  c->progHash = srchash;
  for (int i = 0; i < c->nprogs; i++) if (c->progs[i].key == key) { c->progs[i].stamp = ++c->progstamp; break; }
  return 1;
}

// ---- render ----

void s3d_clear(void* ctx, float r, float g, float b, float a, float depth, unsigned int stencil, int maskBits) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  c->clearR = r; c->clearG = g; c->clearB = b; c->clearA = a;
  c->clearDepthValue = depth;
  c->clearStencilValue = stencil & 0xFFu;
  // Stage3D's clear() is NOT an immediate clear; it records the color and the
  // next drawTriangles applies it as the render pass load action. Starling calls
  // clear() once per frame, then issues many drawTriangles — so each draw must
  // NOT re-clear (that would erase every prior batch). Defer via these flags.
  // The Context3DClearMask bits (COLOR=1/DEPTH=2/STENCIL=4) select which
  // attachments are cleared. Starling clears all three once per frame, writing
  // DEFAULT_STENCIL_VALUE (127) into the stencil so the first mask pass's
  // EQUAL comparison succeeds (see clearStencilValue above).
  c->clearPending = 1;
  c->clearColor = (maskBits & 1) ? 1 : 0;
  c->clearDepth = (maskBits & 2) ? 1 : 0;
  c->clearStencil = (maskBits & 4) ? 1 : 0;
}

// The setters below are called by Starling before EVERY batch, usually with the
// same values, so they return early when nothing changed and otherwise mark the
// depth/stencil selection dirty. The select itself is a CACHE LOOKUP
// (s3d_select_dss), not a build: alternating the state between draws is cheap now.
// (The early return alone was not enough -- away3d alternates depth state on
// every draw, so "changed" was true every time and each draw allocated a driver
// object; see S3DDssVariant.)
static int s3d_streq(const char* a, const char* b) {
  if (a == b) return 1;
  if (a == NULL || b == NULL) return 0;
  return strcmp(a, b) == 0;
}

void s3d_set_depth(void* ctx, int depthMask, const char* compareMode) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  if (c->depthWrite == depthMask && s3d_streq(c->depthCompare, compareMode)) return;
  c->depthWrite = depthMask;
  c->depthCompare = compareMode;
  c->dssDirty = 1;
}

void s3d_set_cull(void* ctx, const char* face) {
  if (ctx == NULL) return;
  ((S3DContext*)ctx)->cullMode = face;
}

// setColorMask: record the per-channel write mask used by the next draw
// (Stage3D's set-state-then-drawTriangles order). It is baked into the pipeline
// variant, so nothing is applied here -- s3d_select_pso picks/creates the
// matching pipeline when the draw is encoded.
void s3d_set_color_mask(void* ctx, int r, int g, int b, int a) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  c->colorMaskR = r ? 1 : 0;
  c->colorMaskG = g ? 1 : 0;
  c->colorMaskB = b ? 1 : 0;
  c->colorMaskA = a ? 1 : 0;
}

void s3d_set_stencil(void* ctx, const char* face, const char* compare, const char* bothPass, const char* depthFail, const char* dpFail) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  if (s3d_streq(c->stencilFace, face) && s3d_streq(c->stencilCompare, compare) &&
      s3d_streq(c->stencilBothPass, bothPass) && s3d_streq(c->stencilDepthFail, depthFail) &&
      s3d_streq(c->stencilDepthPassStencilFail, dpFail)) return;
  c->stencilFace = face;
  c->stencilCompare = compare;
  c->stencilBothPass = bothPass;
  c->stencilDepthFail = depthFail;
  c->stencilDepthPassStencilFail = dpFail;
  c->dssDirty = 1;
}

void s3d_set_stencil_ref(void* ctx, unsigned int ref, unsigned int readMask, unsigned int writeMask) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  c->stencilRef = ref & 0xFFu;
  // Stage3D's read/write mask have 8-bit defaults; a caller passing 0 means
  // "unset" in practice (Starling never passes masks), so keep 0xFF for that.
  unsigned int rm = (readMask != 0) ? (readMask & 0xFFu) : c->stencilReadMask;
  unsigned int wm = (writeMask != 0) ? (writeMask & 0xFFu) : c->stencilWriteMask;
  // The reference value is read per draw (setStencilReferenceValue on the
  // encoder), so only the masks need to invalidate the cached state.
  if (rm != c->stencilReadMask || wm != c->stencilWriteMask) {
    c->stencilReadMask = rm;
    c->stencilWriteMask = wm;
    c->dssDirty = 1;
  }
}

void s3d_set_sampler_state_i(void* ctx, int unit, int filter, int wrap, int mip) {
  asc_tr_smpseti++;
  if (ctx == NULL) return;
  if (unit < 0 || unit > 7) return;
  S3DContext* c = (S3DContext*)ctx;
  if (filter < 0 || filter > 1) filter = 0;
  if (wrap < 0 || wrap > 1) wrap = 0;
  if (mip < 0 || mip > 2) mip = 0;
  c->samplerFilter[unit] = filter;
  c->samplerWrap[unit] = wrap;
  c->samplerMip[unit] = mip;
  c->samplerStateSet[unit] = 1;
}

// setSamplerStateAt(unit, wrap, filter, mipfilter): the AS3 side passes enum
// *strings*, which decode to the same ints s3d_set_sampler_state_i takes. Stage3D
// keeps ONE per-unit sampler state, written by both this call and the AGAL `tex`
// flags of the bound program, so "last writer wins" -- which is why the AGAL
// path (s3d_set_sampler_state_i, called from Context3D_setProgram) and this path
// must share the same storage.
void s3d_set_sampler_state(void* ctx, int unit, const char* wrap, const char* filter, const char* mipfilter) {
  int f = (filter != NULL && !strcmp(filter, "nearest")) ? 1 : 0;
  int w = (wrap != NULL && !strcmp(wrap, "repeat")) ? 1 : 0;
  int m = 0;
  if (mipfilter != NULL) {
    if (!strcmp(mipfilter, "mipnearest")) m = 1;
    else if (!strcmp(mipfilter, "miplinear")) m = 2;
  }
  s3d_set_sampler_state_i(ctx, unit, f, w, m);
}

void s3d_set_scissor(void* ctx, int on, int x, int y, int w, int h) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  c->scissorOn = on;
  c->scissorX = x; c->scissorY = y; c->scissorW = w; c->scissorH = h;
}

// Record the blend factors for the following draws. Metal bakes the blend state
// into the pipeline, so the factors are honored by selecting (or lazily building)
// the matching variant when the next draw is encoded — Stage3D's set-state-then-
// drawTriangles order, with no recompile of the MSL itself.
void s3d_set_blend(void* ctx, const char* sourceFactor, const char* destFactor) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  c->blendSource = sourceFactor;
  c->blendDest = destFactor;
}

// Instance count for the next draw (drawTrianglesInstanced). 0 clamps to 1.
void s3d_set_instance_count(void* ctx, int n) {
  if (ctx == NULL) return;
  ((S3DContext*)ctx)->instanceCount = n > 0 ? n : 1;
}

// Encode one draw into the frame's batch: append a render pass (clear on the
// first draw after clear(), load afterwards) with the bound index/vertex
// streams and pipeline. The batch is committed + waited ONCE per frame by
// s3d_flush — see the `batch` field for why waiting per draw was costing
// ~0.5 ms of round-trip latency each. This is still a clear/draw/present-per-
// frame model: the render target is only valid after the frame's flush.
int s3d_draw(void* ctx, int numTriangles) {
  if (ctx == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  asc_tr_draw++;
  asc_tr_report();
  const int dbg = asc_s3d_stats();
  const double t_dbg0 = dbg ? asc_dbg_now_ms() : 0.0;
  // The program's functions must exist (compile ran) and geometry must be bound.
  if (c->vfn == nil || c->numStreams == 0) return 0;
  // AIR fidelity: a mip-filtered sampler (miplinear/mipnearest) on a texture
  // that has NO mip chain makes AIR drop the entire draw -- the target keeps
  // whatever was there (measured in temp/sampprobe A6: a 2x2 level-0-only
  // texture read back as the clear colour, while the same texture with
  // <2d,linear,nomip> drew normally). Sampling level 0 with a clamped
  // derivative instead would be a silent divergence in the opposite direction:
  // it renders an aliased image where AIR renders nothing.
  for (int i = 0; i < 8; i++) {
    if (c->samplerStateSet[i] && c->samplerMip[i] != 0 && c->texHasMips[i] == 0 && c->textures[i] != nil) {
      asc_tr_mipdrop++;
      if (asc_s3d_dump())
        fprintf(stderr, "S3D mip-drop: unit %d asks for mipmaps but the bound texture has no chain (AIR drops the draw)\n", i);
      // AIR still clears the frame it dropped into (the A6 probe read back the
      // clear colour), so consume the pending COLOUR clear here instead of
      // letting the frame keep the previous frame's pixels when every draw in it
      // is dropped. Depth/stencil need no handling: they are only attached to a
      // pass that actually draws.
      if (c->clearPending && c->clearColor) {
        @autoreleasepool {
          if (c->batch == nil) c->batch = [[c->queue commandBuffer] retain];
          if (c->batch != nil) {
            MTLRenderPassDescriptor* drp = [MTLRenderPassDescriptor renderPassDescriptor];
            drp.colorAttachments[0].texture = c->renderOverride != nil ? c->renderOverride : c->target;
            drp.colorAttachments[0].loadAction = MTLLoadActionClear;
            drp.colorAttachments[0].clearColor = MTLClearColorMake((double)c->clearR, (double)c->clearG, (double)c->clearB, (double)c->clearA);
            drp.colorAttachments[0].storeAction = MTLStoreActionStore;
            id<MTLRenderCommandEncoder> e = [c->batch renderCommandEncoderWithDescriptor:drp];
            if (e != nil) [e endEncoding];
            c->clearPending = 0;
          }
        }
      }
      return 0;
    }
  }
  // Bind the pipeline whose baked blend state matches the current blend factors;
  // this is what makes setBlendFactors observable after the program was compiled.
  s3d_select_pso(c);
  if (c->pso == nil) return 0;
  if (asc_s3d_dump()) {
    int ntex = 0; for (int i = 0; i < 8; i++) if (c->samplerStateSet[i]) ntex++;
    fprintf(stderr, "S3DDRAW tris=%d streams=%d depth=(%s,w=%d) cull=%s blend=(%s,%s) cmask=%d%d%d%d samplers=%d\n",
      numTriangles, c->numStreams,
      c->depthCompare ? c->depthCompare : "null", c->depthWrite,
      c->cullMode ? c->cullMode : "null",
      c->blendSource ? c->blendSource : "null", c->blendDest ? c->blendDest : "null",
      c->colorMaskR, c->colorMaskG, c->colorMaskB, c->colorMaskA, ntex);
    for (int i = 0; i < 8; i++) {
      if (c->streams[i].buffer != nil)
        fprintf(stderr, "   stream[%d] comp=%d nv=%d\n", i, c->streams[i].components, c->streams[i].numVertices);
      if (c->samplerStateSet[i])
        fprintf(stderr, "   sampler[%d] filter=%d wrap=%d mip=%d\n", i, c->samplerFilter[i], c->samplerWrap[i], c->samplerMip[i]);
    }
  }
  // The command buffer / render pass descriptor / render encoder returned by
  // these factory methods are autoreleased (not +1). The C++ SDL main loop has
  // no autorelease pool, so without an explicit @autoreleasepool they would
  // accumulate for the whole run (the air-native slow leak). Drain per frame.
  @autoreleasepool {
  // Open the frame's batch on the first draw; every later draw in the same
  // frame appends to it (the +1 we take here is released by s3d_flush).
  if (c->batch == nil) c->batch = [[c->queue commandBuffer] retain];
  if (c->batch == nil) return 0;
  id<MTLCommandBuffer> cb = c->batch;
  MTLRenderPassDescriptor* rp = [MTLRenderPassDescriptor renderPassDescriptor];
  rp.colorAttachments[0].texture = c->renderOverride != nil ? c->renderOverride : c->target;
  // Only the first draw after a clear() clears; subsequent draws accumulate onto
  // the same render target (Starling's clear-then-many-drawTriangles model).
  rp.colorAttachments[0].loadAction = (c->clearPending && c->clearColor) ? MTLLoadActionClear : MTLLoadActionLoad;
  rp.colorAttachments[0].clearColor = MTLClearColorMake((double)c->clearR, (double)c->clearG, (double)c->clearB, (double)c->clearA);
  rp.colorAttachments[0].storeAction = MTLStoreActionStore;

  // Depth/stencil are only attached when the draw actually needs them. The
  // attachment is a 1280x2160 D32S8 texture (~22 MB): a per-draw Load+Store of it
  // costs ~44 MB, and Starling issues tens of thousands of draws per second —
  // attaching it unconditionally made a masked scene so slow that CAMetalLayer's
  // three drawables starved and the window froze on the previous frame.
  // Not attaching a pass neither reads nor writes the texture, so a mask written
  // by an earlier attached pass survives untouched and the mask state is correct.
  int dsNeeded = (c->depthCompare != NULL && strcmp(c->depthCompare, "always") != 0)
              || (c->stencilCompare != NULL && strcmp(c->stencilCompare, "always") != 0)
              || (c->stencilBothPass != NULL && strcmp(c->stencilBothPass, "keep") != 0);
  // Depth/stencil comes from the back-buffer surface for on-screen passes and
  // from the render target's own same-size surface for offscreen passes (Metal
  // requires matching attachment sizes).
  id<MTLTexture> ds = (c->renderOverride != nil) ? c->rtDepthStencil : c->depthStencil;
  if (ds != nil && dsNeeded) {
    rp.depthAttachment.texture = ds;
    rp.depthAttachment.loadAction = (c->clearPending && c->clearDepth) ? MTLLoadActionClear : MTLLoadActionLoad;
    rp.depthAttachment.clearDepth = (double)c->clearDepthValue;
    rp.depthAttachment.storeAction = MTLStoreActionStore;
    rp.stencilAttachment.texture = ds;
    rp.stencilAttachment.loadAction = (c->clearPending && c->clearStencil) ? MTLLoadActionClear : MTLLoadActionLoad;
    rp.stencilAttachment.clearStencil = (uint32_t)c->clearStencilValue;
    rp.stencilAttachment.storeAction = MTLStoreActionStore;
  }
  c->clearPending = 0;
  c->clearColor = 0; c->clearDepth = 0; c->clearStencil = 0;

  id<MTLRenderCommandEncoder> enc = [cb renderCommandEncoderWithDescriptor:rp];
  [enc setRenderPipelineState:c->pso];
  // Stage3D's clip space is Y-down while Metal's is Y-up; the geometry therefore
  // arrives with the opposite winding, so a triangle that Stage3D considers
  // front-facing is clockwise here. Declare that once for every draw, otherwise
  // cullMode=Back would cull exactly the faces Starling wants to keep (the
  // Sprite 3D cube vanished entirely because of it).
  [enc setFrontFacingWinding:MTLWindingClockwise];
  // NOTE: the color write mask is NOT set here -- Metal has no encoder-level
  // colorWriteMask, it lives in MTLRenderPipelineDescriptor.writeMask, so it is
  // baked into the pipeline variant selected by s3d_select_pso above.

  // Culling: Context3DTriangleFace -> MTLCullMode. "frontAndBack" is Stage3D's
  // "do not cull" default (Starling renders with it), not GL's cull-everything.
  if (c->cullMode != NULL && !strcmp(c->cullMode, "back")) [enc setCullMode:MTLCullModeBack];
  else if (c->cullMode != NULL && !strcmp(c->cullMode, "front")) [enc setCullMode:MTLCullModeFront];
  else [enc setCullMode:MTLCullModeNone];
  // Depth test / stencil test state (rebuilt only when the recorded state
  // changed) plus the stencil reference value Starling walks while masking.
  if (c->dssDirty || c->dss == nil) s3d_select_dss(c);
  if (c->dss != nil) [enc setDepthStencilState:c->dss];
  if (c->stencilCompare != NULL) [enc setStencilReferenceValue:c->stencilRef];
  // Scissor rectangle (Stage3D clips with setScissorRectangle; Starling uses it
  // for rectangular masks and TextField viewports). Clamp into the target —
  // Metal rejects a rect outside the attachment.
  if (c->scissorOn) {
    int rw = c->renderOverride != nil ? (int)c->renderOverride.width : c->width;
    int rh = c->renderOverride != nil ? (int)c->renderOverride.height : c->height;
    int x = c->scissorX, y = c->scissorY, w = c->scissorW, h = c->scissorH;
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x > rw) x = rw;
    if (y > rh) y = rh;
    if (w < 0) w = 0;
    if (h < 0) h = 0;
    if (x + w > rw) w = rw - x;
    if (y + h > rh) h = rh - y;
    MTLScissorRect sr; sr.x = x; sr.y = y; sr.width = (NSUInteger)w; sr.height = (NSUInteger)h;
    [enc setScissorRect:sr];
  }
  if (c->vc != nil) [enc setVertexBuffer:c->vc offset:0 atIndex:0];
  if (c->fc != nil) [enc setFragmentBuffer:c->fc offset:0 atIndex:0];
  // Vertex streams: attribute i reads MTLBuffer S3D_STREAM_BASE+i (buffer 0 is
  // the vertex-constant array vc).
  for (int i = 0; i < c->numStreams && i < 8; i++) {
    if (c->streams[i].buffer != nil) [enc setVertexBuffer:c->streams[i].buffer offset:0 atIndex:(S3D_STREAM_BASE + i)];
  }
  // Fragment textures fs0..fs7 -> texture(0..7). Without this binding Metal fails
  // the draw ("missing Texture binding at index 0 for fs0[0]") and nothing is
  // rasterized — the Sprite 3D cube rendered as an empty scene because of it.
  for (int i = 0; i < 8; i++) {
    if (c->textures[i] != nil) [enc setFragmentTexture:c->textures[i] atIndex:i];
  }
  // One sampler state per unit: the fragment program declares smpN [[sampler(N)]]
  // for each fsN it samples (the AGAL translator emits one per register), and
  // Metal rejects the draw when a declared sampler index has no state bound
  // ("missing Sampler binding at index N"). Each unit's state comes from the
  // AGAL `tex` flags of the bound program (s3d_set_sampler_state_i, applied by
  // Context3D_setProgram) or from an explicit setSamplerStateAt, whichever ran
  // last -- that is the only sampler state away3d and Starling ever provide.
  // All 8 indices must be bound because a program may sample fs3 without ever
  // touching fs0 -- before this, only the lowest bound unit's state could be
  // observed, so per-unit REPEAT/NEAREST was silently ignored in multi-texture
  // programs. The linear default below is unreachable for any program that
  // samples at all.
  for (int i = 0; i < 8; i++) {
    id<MTLSamplerState> smp = nil;
    if (c->samplerStateSet[i]) smp = s3d_sampler_for(c, c->samplerFilter[i], c->samplerWrap[i], c->samplerMip[i]);
    if (smp == nil) smp = (c->samplerLinear != nil ? c->samplerLinear : c->samplerNearest);
    [enc setFragmentSamplerState:smp atIndex:i];
  }

  if (c->indexBuffer != nil) {
    [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:numTriangles * 3
        indexType:MTLIndexTypeUInt32 indexBuffer:c->indexBuffer indexBufferOffset:0
        instanceCount:c->instanceCount];
  } else {
    int vcount = 0;
    for (int i = 0; i < c->numStreams && i < 8; i++) if (c->streams[i].numVertices > vcount) vcount = c->streams[i].numVertices;
    [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:numTriangles * 3
        instanceCount:c->instanceCount];
  }
  [enc endEncoding];
  const double t_dbg_enc = dbg ? asc_dbg_now_ms() : 0.0;
  // NO commit/wait here: the batch is submitted once per frame by s3d_flush.
  if (dbg) {
    if (asc_dbg_t_first == 0.0) asc_dbg_t_first = t_dbg0;
    asc_dbg_acc_cpu += t_dbg_enc - t_dbg0;
    asc_dbg_acc_tri += numTriangles;
    asc_dbg_acc_n++;
    asc_dbg_tot_n++;
  }
  }  // @autoreleasepool
  return 1;
}

// Read back the render target into a tightly packed BGRA8 buffer (width*height*4).
// Returns 1 on success.
int s3d_readback(void* ctx, uint8_t* out) {
  if (ctx == NULL || out == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  // The CPU is about to read the target, so the frame's GPU writes must be
  // complete first (the old per-draw wait gave this for free).
  s3d_flush(ctx);
  // getBytes on a render target synchronizes with the GPU and may internally
  // create an autoreleased blit command buffer/encoder. With no pool in the C++
  // SDL loop that would leak one command buffer per frame (the shmup residual
  // leak), so drain it here like s3d_draw does.
  @autoreleasepool {
  [c->target getBytes:out bytesPerRow:c->width * 4
      fromRegion:MTLRegionMake2D(0, 0, c->width, c->height) mipmapLevel:0];
  }
  return 1;
}

int s3d_width(void* ctx) { return ctx ? ((S3DContext*)ctx)->width : 0; }
int s3d_height(void* ctx) { return ctx ? ((S3DContext*)ctx)->height : 0; }

// ---- render-to-texture (stage 83) ----
// A render-target texture (optimizeForRenderToTexture=true) is an MTLTexture with
// both RenderTarget and ShaderRead usage: drawTriangles renders into it when it is
// the current render override, and setTextureAt can later sample it as fsN.
void* s3d_create_render_texture(void* ctx, int width, int height) {
  if (ctx == NULL || width <= 0 || height <= 0) return NULL;
  S3DContext* c = (S3DContext*)ctx;
  MTLTextureDescriptor* td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
      width:width height:height mipmapped:NO];
  td.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
  id<MTLTexture> tex = [c->device newTextureWithDescriptor:td];
  // `newTextureWithDescriptor:` is a "new" method, so it already returns +1.
  // No extra retain here (that would leak) — the caller owns this +1 and must
  // balance it with s3d_destroy_texture (MRR, not ARC).
  return (void*)tex;
}

// Bind the render override. tex == NULL restores the back-buffer target.
void s3d_set_render_target(void* ctx, void* tex, int enableDepthAndStencil) {
  asc_tr_rt++;
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  if (tex != NULL) {
    id<MTLTexture> t = (id<MTLTexture>)tex;
    if ((t.usage & MTLTextureUsageRenderTarget) == 0) {
      fprintf(stderr, "stage3d_glue: setRenderToTexture: texture %lux%lu has no render-target usage (0x%lx) -- pass ignored (usage must include MTLTextureUsageRenderTarget)\n",
              (unsigned long)t.width, (unsigned long)t.height, (unsigned long)t.usage);
      return;
    }
    // An offscreen pass needs a depth/stencil surface of the render target's own
    // size: Metal rejects a render pass whose depth attachment differs in size
    // from the color attachment (which would silently drop the whole pass and
    // leave the texture holding stale memory). Size-cached so a per-frame filter
    // does not reallocate it.
    if (enableDepthAndStencil) {
      int w = (int)t.width, h = (int)t.height;
      if (c->rtDepthStencil == nil || c->rtDepthStencilW != w || c->rtDepthStencilH != h) {
        if (c->rtDepthStencil != nil) [c->rtDepthStencil release];
        c->rtDepthStencil = s3d_make_depth_stencil(c->device, w, h);
        c->rtDepthStencilW = w; c->rtDepthStencilH = h;
      }
    }
  }
  c->renderOverride = (id<MTLTexture>)tex;
}

// Bind an existing render-target texture as a fragment sampler fs{unit} (no
// ARGB pixel upload — the texture already holds rendered content).
int s3d_bind_texture(void* ctx, int unit, void* tex, int hasChain) {
  asc_tr_bindtex++;
  if (ctx == NULL || unit < 0 || unit > 7 || tex == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  c->textures[unit] = (id<MTLTexture>)tex;
  c->texHasMips[unit] = hasChain ? 1 : 0;
  return 1;
}

// Expose the current render target (render override if set, else back buffer) as
// an opaque MTLTexture handle for direct GPU→GPU compositing by the Skia Metal
// backend. The caller BORROWS it — ownership stays with the context — so the
// composite path samples the live texture each frame without a CPU readback.
void* s3d_get_render_target(void* ctx) {
  if (ctx == NULL) return NULL;
  S3DContext* c = (S3DContext*)ctx;
  id<MTLTexture> src = c->renderOverride != nil ? c->renderOverride : c->target;
  // Debug probe (ASC_S3D_TRACE=1): which texture the compositor is handed, and
  // whether the back buffer actually holds drawn pixels (the render-to-texture
  // override, if set, is a DIFFERENT texture and may be untouched).
  if (getenv("ASC_S3D_TRACE") != NULL) {
    static int n = 0;
    if (n++ < 6) {
      uint32_t tb[2] = { 0, 0 }, to[2] = { 0, 0 };
      if (c->target != nil) [c->target getBytes:tb bytesPerRow:8 fromRegion:MTLRegionMake2D(100, 100, 2, 1) mipmapLevel:0];
      if (c->renderOverride != nil) [c->renderOverride getBytes:to bytesPerRow:8 fromRegion:MTLRegionMake2D(100, 100, 2, 1) mipmapLevel:0];
      fprintf(stderr, "get_render_target: src=%p target=%p backbuf=%08x,%08x override=%p overridepx=%08x,%08x\n",
              (void*)src, (void*)c->target, tb[0], tb[1], (void*)c->renderOverride, to[0], to[1]);
      fflush(stderr);
    }
  }
  return (void*)src;
}

// Read back the current render target (render override if set, else back buffer).
int s3d_readback_render(void* ctx, uint8_t* out) {
  if (ctx == NULL || out == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  s3d_flush(ctx);  // see s3d_readback: the readback needs the GPU writes complete
  id<MTLTexture> src = c->renderOverride != nil ? c->renderOverride : c->target;
  // Same autorelease-pool wrap as s3d_readback: getBytes may allocate an
  // autoreleased blit command buffer each frame (see the shmup residual leak).
  @autoreleasepool {
  [src getBytes:out bytesPerRow:(NSUInteger)src.width * 4
      fromRegion:MTLRegionMake2D(0, 0, src.width, src.height) mipmapLevel:0];
  }
  return 1;
}

void s3d_destroy_texture(void* tex) {
  if (tex == NULL) return;
  // Drop every borrowed binding first: a released texture left in a sampler slot
  // or as the render override would crash the next draw (see the live-context
  // registry above).
  s3d_unbind_texture_everywhere((id<MTLTexture>)tex);
  [(id<MTLTexture>)tex release];
}

}  // extern "C"
