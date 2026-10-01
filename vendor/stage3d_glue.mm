// stage3d_glue.mm — the Objective-C++ -> C bridge for Stage3D's raw Metal
// pipeline (flash.display3D). Unlike metal_glue.mm (which wraps Skia's Ganesh
// backend for the 2D display list), this file owns the *programmable* GPU
// triangle pipeline: MTLBuffer vertex/index buffers, MTLTexture 2D textures,
// MTLLibrary (MSL compiled from AGAL bytecode), MTLRenderPipelineDescriptor +
// MTLDepthStencilState, and a MTLRenderPassDescriptor that renders into an
// offscreen MTLTexture so pixels can be read back (drawToBitmapData / tests).
//
// It is deliberately self-contained and offscreen-first: it creates its own
// MTLDevice + MTLCommandQueue, renders into an offscreen render target, and
// exposes a flat extern "C" API for the generated C to call. Compositing that
// render target with Skia's 2D surface into a single CAMetalLayer drawable is
// the stage 82 P2 follow-up (shared device/queue); the offscreen path here is
// the testable core that stage 82's acceptance ("assert the triangle's pixels")
// and stage 83's drawToBitmapData both build on.

#import <Metal/Metal.h>
#include <cstdio>
#include <cfloat>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <ctime>

extern "C" {

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
#define S3D_MAX_BLEND_VARIANTS 12

// One cached pipeline: the blend-factor names ("" for both = blending disabled)
// plus the state built for them, LRU-stamped.
typedef struct {
  char sf[32];
  char df[32];
  id<MTLRenderPipelineState> pso;
  unsigned long stamp;
} S3DBlendVariant;

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
  id<MTLFunction> vfn;
  id<MTLFunction> ffn;
  S3DBlendVariant bvars[S3D_MAX_BLEND_VARIANTS];
  int nbvars;
  unsigned long bstamp;
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
  // Sampler state per texture unit (setSamplerStateAt): filter/wrap/mip as small
  // enums, resolved to a cached MTLSamplerState when a draw is encoded. The
  // generated MSL declares one sampler per sampled texture register
  // (smpN [[sampler(N)]]), so each unit's state is bound at its own index (see
  // s3d_draw).
  int samplerFilter[8];            // 0 = linear, 1 = nearest
  int samplerWrap[8];              // 0 = clamp, 1 = repeat
  int samplerMip[8];               // 0 = none, 1 = nearest, 2 = linear
  int samplerStateSet[8];          // whether setSamplerStateAt ran for this unit
  id<MTLSamplerState> samplerCache[2][2][3];  // [filter][wrap][mip]
  id<MTLDepthStencilState> dss;    // cached depth/stencil state
  int dssDirty;                    // rebuild before the next draw
  // Fragment samplers. The AGAL->MSL translator declares one shared sampler per
  // program by default, and the encoder MUST bind a sampler state at every index
  // the shader declares — leaving one unbound made Metal reject the whole draw
  // ("missing Sampler binding at index 0 for smp[0]"), which is why
  // 3D-transformed sprites (Sprite 3D's cube) never appeared. Linear
  // min/mag/mip with clamp-to-edge matches Starling's default texture smoothing.
  id<MTLSamplerState> samplerLinear;
  id<MTLSamplerState> samplerNearest;
};

// Blend-variant pipeline cache (defined with the blend-factor mapping further
// down, but needed by the lifecycle/compile/draw entry points): every helper
// bakes the blend state into an MTLRenderPipelineState, since Metal has no
// per-draw blend-factor call.
static void s3d_factor_key(char* dst, const char* name);
static id<MTLRenderPipelineState> s3d_make_pso(S3DContext* c, const char* blendSource, const char* blendDest, NSError** err);
static void s3d_clear_variants(S3DContext* c);
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
static void s3d_rebuild_dss(S3DContext* c) {
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
  if (c->dss != nil) [c->dss release];
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
    for (int i = 0; i < 8; i++) if (c->textures[i] == t) c->textures[i] = nil;
    if (c->renderOverride == t) c->renderOverride = nil;
  }
}

void* s3d_create(int width, int height) {
  id<MTLDevice> device = MTLCreateSystemDefaultDevice();
  if (device == nil) { fprintf(stderr, "stage3d_glue: no Metal device\n"); return NULL; }
  S3DContext* c = new S3DContext();
  c->device = device;
  c->queue = [device newCommandQueue];
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
  for (int i = 0; i < S3D_MAX_BLEND_VARIANTS; i++) { c->bvars[i].pso = nil; c->bvars[i].sf[0] = '\0'; c->bvars[i].df[0] = '\0'; c->bvars[i].stamp = 0; }
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
  c->stencilFace = NULL;
  c->stencilCompare = NULL;
  c->stencilBothPass = NULL;
  c->stencilDepthFail = NULL;
  c->stencilDepthPassStencilFail = NULL;
  c->stencilRef = 0;
  c->stencilReadMask = 0xFF;
  c->stencilWriteMask = 0xFF;
  c->scissorOn = 0; c->scissorX = c->scissorY = c->scissorW = c->scissorH = 0;
  for (int i = 0; i < 8; i++) { c->samplerFilter[i] = 0; c->samplerWrap[i] = 0; c->samplerMip[i] = 0; c->samplerStateSet[i] = 0; }
  for (int i = 0; i < 2; i++) for (int j = 0; j < 2; j++) for (int k = 0; k < 3; k++) c->samplerCache[i][j][k] = nil;
  c->dss = nil;
  c->dssDirty = 1;
  c->samplerLinear = s3d_make_sampler(device, true);
  c->samplerNearest = s3d_make_sampler(device, false);
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
  // Releases every cached blend variant, including the bound c->pso.
  s3d_clear_variants(c);
  if (c->vfn != nil) [c->vfn release];
  if (c->ffn != nil) [c->ffn release];
  if (c->target != nil) [c->target release];
  if (c->depthStencil != nil) [c->depthStencil release];
  if (c->rtDepthStencil != nil) [c->rtDepthStencil release];
  if (c->samplerLinear != nil) [c->samplerLinear release];
  if (c->samplerNearest != nil) [c->samplerNearest release];
  for (int i = 0; i < 2; i++) for (int j = 0; j < 2; j++) for (int k = 0; k < 3; k++)
    if (c->samplerCache[i][j][k] != nil) [c->samplerCache[i][j][k] release];
  if (c->dss != nil) [c->dss release];
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
  MTLTextureDescriptor* td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
      width:width height:height mipmapped:NO];
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
  if (ctx == NULL || unit < 0 || unit > 7) return NULL;
  void* tex = s3d_texture_from_pixels(ctx, width, height, argb);
  if (tex != NULL) ((S3DContext*)ctx)->textures[unit] = (id<MTLTexture>)tex;  // borrowed; caller owns the +1
  return tex;
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
                                              const char* blendDest, NSError** err) {
  MTLRenderPipelineDescriptor* pd = [[MTLRenderPipelineDescriptor alloc] init];
  pd.vertexFunction = c->vfn;
  pd.fragmentFunction = c->ffn;
  pd.colorAttachments[0].pixelFormat = MTLPixelFormatBGRA8Unorm;
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
  }
  c->nbvars = 0;
  c->pso = nil;
}

// Select the pipeline whose baked blend state matches the factors currently
// recorded on the context, building and caching it on first use. Called once per
// encoded draw: a setBlendFactors between two draws (same program) now takes
// effect instead of being silently ignored.
static void s3d_select_pso(S3DContext* c) {
  if (c->vfn == nil || c->ffn == nil) return;
  char sf[32], df[32];
  s3d_factor_key(sf, c->blendSource);
  s3d_factor_key(df, c->blendDest);
  for (int i = 0; i < c->nbvars; i++) {
    if (strcmp(c->bvars[i].sf, sf) == 0 && strcmp(c->bvars[i].df, df) == 0) {
      c->bvars[i].stamp = ++c->bstamp;
      c->pso = c->bvars[i].pso;
      return;
    }
  }
  NSError* err = nil;
  id<MTLRenderPipelineState> pso = s3d_make_pso(c, c->blendSource, c->blendDest, &err);
  if (pso == nil) {
    fprintf(stderr, "stage3d_glue: blend variant pipeline failed: %s\n", [[err localizedDescription] UTF8String]);
    return;  // keep the previous pipeline: a wrong blend beats no draw at all
  }
  int idx;
  if (c->nbvars < S3D_MAX_BLEND_VARIANTS) {
    idx = c->nbvars++;
  } else {
    // Cache full: evict the least recently used variant. Starling registers fewer
    // than a dozen blend modes, so this only guards a pathological program.
    idx = 0;
    for (int i = 1; i < c->nbvars; i++) if (c->bvars[i].stamp < c->bvars[idx].stamp) idx = i;
    if (c->bvars[idx].pso != nil) [c->bvars[idx].pso release];
  }
  s3d_factor_key(c->bvars[idx].sf, c->blendSource);
  s3d_factor_key(c->bvars[idx].df, c->blendDest);
  c->bvars[idx].pso = pso;
  c->bvars[idx].stamp = ++c->bstamp;
  c->pso = pso;
}

// Compile vertex + fragment MSL into the program's functions and build the
// pipeline for the blend factors in effect right now. `numAttr` is how many
// vertex streams (attributes) the vertex shader reads; the vertex descriptor
// maps attribute i -> MTLBuffer index i with the stream's format.
// Returns 1 on success, 0 on failure (errbuf receives a truncated message).
int s3d_compile(void* ctx, const char* vs_msl, const char* fs_msl, char* errbuf, int errbuf_size) {
  if (ctx == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  NSError* err = nil;
  id<MTLLibrary> vlib = [c->device newLibraryWithSource:[NSString stringWithUTF8String:vs_msl] options:nil error:&err];
  if (vlib == nil) {
    fprintf(stderr, "stage3d_glue: MSL(vertex) compile failed: %s\n", [[err localizedDescription] UTF8String]);
    if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "MSL(vertex): %s", [[err localizedDescription] UTF8String]);
    return 0;
  }
  id<MTLFunction> vfn = [vlib newFunctionWithName:@"vs_main"];
  if (vfn == nil) { if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "MSL: no vs_main"); return 0; }

  id<MTLLibrary> flib = [c->device newLibraryWithSource:[NSString stringWithUTF8String:fs_msl] options:nil error:&err];
  if (flib == nil) {
    fprintf(stderr, "stage3d_glue: MSL(fragment) compile failed: %s\n", [[err localizedDescription] UTF8String]);
    if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "MSL(fragment): %s", [[err localizedDescription] UTF8String]);
    return 0;
  }
  id<MTLFunction> ffn = [flib newFunctionWithName:@"fs_main"];
  if (ffn == nil) { if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "MSL: no fs_main"); return 0; }

  // A new program replaces the previous functions and invalidates every cached
  // blend variant (they were built from the old functions).
  s3d_clear_variants(c);
  if (c->vfn != nil) [c->vfn release];
  if (c->ffn != nil) [c->ffn release];
  c->vfn = vfn;
  c->ffn = ffn;
  // MRC: the libraries are +1 and no longer needed once the functions are
  // created; the functions themselves stay retained on the context so a later
  // setBlendFactors can build another variant of the same program.
  [vlib release];
  [flib release];

  NSError* perr = nil;
  id<MTLRenderPipelineState> pso = s3d_make_pso(c, c->blendSource, c->blendDest, &perr);
  if (pso == nil) {
    fprintf(stderr, "stage3d_glue: pipeline create failed: %s\n", [[perr localizedDescription] UTF8String]);
    if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "pipeline: %s", [[perr localizedDescription] UTF8String]);
    return 0;
  }
  // Seed the cache with this variant so a re-selection never rebuilds it.
  s3d_factor_key(c->bvars[0].sf, c->blendSource);
  s3d_factor_key(c->bvars[0].df, c->blendDest);
  c->bvars[0].pso = pso;
  c->bvars[0].stamp = ++c->bstamp;
  c->nbvars = 1;
  c->pso = pso;
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
// same values. Rebuilding the MTLDepthStencilState each time would allocate a
// driver object per draw (measured: the app became unresponsive), so only mark
// the cached state dirty when a value actually changes.
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

void s3d_set_sampler_state(void* ctx, int unit, const char* wrap, const char* filter, const char* mipfilter) {
  if (ctx == NULL) return;
  if (unit < 0 || unit > 7) return;
  S3DContext* c = (S3DContext*)ctx;
  int f = (filter != NULL && !strcmp(filter, "nearest")) ? 1 : 0;
  int w = (wrap != NULL && !strcmp(wrap, "repeat")) ? 1 : 0;
  int m = 0;
  if (mipfilter != NULL) {
    if (!strcmp(mipfilter, "mipnearest")) m = 1;
    else if (!strcmp(mipfilter, "miplinear")) m = 2;
  }
  c->samplerFilter[unit] = f;
  c->samplerWrap[unit] = w;
  c->samplerMip[unit] = m;
  c->samplerStateSet[unit] = 1;
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

// Encode + submit one draw: clear to the stored color, draw the bound
// index/vertex streams with the bound pipeline, commit, and wait (so the caller
// can immediately read back). This is a one-shot frame — the AGAL/Stage3D model
// is clear/draw/present per frame, not a persistent retained-mode scene.
int s3d_draw(void* ctx, int numTriangles) {
  if (ctx == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  const int dbg = asc_s3d_stats();
  const double t_dbg0 = dbg ? asc_dbg_now_ms() : 0.0;
  // The program's functions must exist (compile ran) and geometry must be bound.
  if (c->vfn == nil || c->numStreams == 0) return 0;
  // Bind the pipeline whose baked blend state matches the current blend factors;
  // this is what makes setBlendFactors observable after the program was compiled.
  s3d_select_pso(c);
  if (c->pso == nil) return 0;

  // The command buffer / render pass descriptor / render encoder returned by
  // these factory methods are autoreleased (not +1). The C++ SDL main loop has
  // no autorelease pool, so without an explicit @autoreleasepool they would
  // accumulate for the whole run (the air-native slow leak). Drain per frame.
  @autoreleasepool {
  id<MTLCommandBuffer> cb = [c->queue commandBuffer];
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
  // Culling: Context3DTriangleFace -> MTLCullMode. "frontAndBack" is Stage3D's
  // "do not cull" default (Starling renders with it), not GL's cull-everything.
  if (c->cullMode != NULL && !strcmp(c->cullMode, "back")) [enc setCullMode:MTLCullModeBack];
  else if (c->cullMode != NULL && !strcmp(c->cullMode, "front")) [enc setCullMode:MTLCullModeFront];
  else [enc setCullMode:MTLCullModeNone];
  // Depth test / stencil test state (rebuilt only when the recorded state
  // changed) plus the stencil reference value Starling walks while masking.
  if (c->dssDirty || c->dss == nil) s3d_rebuild_dss(c);
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
  // ("missing Sampler binding at index N"). Bind each unit's own
  // setSamplerStateAt state, defaulting to linear+clamp. All 8 indices must be
  // bound because a program may sample fs3 without ever touching fs0 — before
  // this, only the lowest bound unit's state could be observed, so per-unit
  // REPEAT/NEAREST was silently ignored in multi-texture programs.
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
  [cb commit];
  [cb waitUntilCompleted];
  if (dbg) {
    const double t_done = asc_dbg_now_ms();
    const double gpu_ms = (cb.GPUEndTime - cb.GPUStartTime) * 1000.0;
    static double acc_cpu = 0, acc_gpu = 0, acc_wait = 0, acc_tri = 0;
    static long acc_n = 0, tot_n = 0;
    static double t_first = 0;
    if (t_first == 0.0) t_first = t_dbg0;
    acc_cpu += t_dbg_enc - t_dbg0;
    acc_wait += t_done - t_dbg_enc;
    acc_gpu += gpu_ms;
    acc_tri += numTriangles;
    acc_n++;
    tot_n++;
    if (acc_n % 240 == 0) {
      const double elapsed = (t_done - t_first) / 1000.0;
      fprintf(stderr,
              "s3d_stats t=%.1fs draws=%ld draws/s=%.1f tri/draw=%.0f "
              "cpu=%.2fms gpu=%.2fms wait=%.2fms per-draw\n",
              elapsed, tot_n, elapsed > 0.0 ? (double)tot_n / elapsed : 0.0,
              acc_tri / (double)acc_n, acc_cpu / acc_n, acc_gpu / acc_n,
              acc_wait / acc_n);
      fflush(stderr);
      acc_cpu = acc_gpu = acc_wait = acc_tri = 0;
      acc_n = 0;
    }
  }
  }  // @autoreleasepool
  return 1;
}

// Read back the render target into a tightly packed BGRA8 buffer (width*height*4).
// Returns 1 on success.
int s3d_readback(void* ctx, uint8_t* out) {
  if (ctx == NULL || out == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
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
int s3d_bind_texture(void* ctx, int unit, void* tex) {
  if (ctx == NULL || unit < 0 || unit > 7 || tex == NULL) return 0;
  ((S3DContext*)ctx)->textures[unit] = (id<MTLTexture>)tex;
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
  return (void*)src;
}

// Read back the current render target (render override if set, else back buffer).
int s3d_readback_render(void* ctx, uint8_t* out) {
  if (ctx == NULL || out == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
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
