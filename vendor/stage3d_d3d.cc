// stage3d_d3d.cc — the Windows/Direct3D 12 counterpart of stage3d_glue.mm (Metal)
// and stage3d_webgl.cc (WebGL2): the backend behind the flat extern "C" `s3d_*`
// ABI that the generated C's Context3D state machine calls into.
//
// WHAT IT RENDERS
// Stage3D's Context3D is an OFFSCREEN render target; the 2D display list is
// composited on top of it by Skia (d3d_glue.cc) once per frame. So this file owns
// a BGRA8 render target of its own rather than the swapchain back buffer, and the
// frame's pixels reach the window through `s3d_get_render_target` -> the generated
// C's `as_skia_gpu_draw_texture` -> sk_gpu_draw_texture in d3d_glue.cc. That is the
// same division of labour as Metal's MTLTexture hand-off, and it is what keeps
// Context3D.present() free of any CPU readback.
//
// THE TWO THINGS D3D12 MAKES DIFFERENT FROM METAL
//   1. There is no MTLDepthStencilState object: depth/stencil state lives INSIDE
//      the pipeline state. Stage3D's setDepthTest/setStencilActions are settable
//      between two draws that share one Program3D (Starling alternates depth state
//      on every batch), so the pipeline cache below is keyed on the WHOLE draw
//      state -- program, the blend-FACTOR PAIR (not merely "blending on": see
//      s3d_select_pso), colour mask, depth, stencil, culling, vertex layout and
//      whether a depth attachment is bound. S3D_MAX_PSOVAR bounds it, LRU-evicted.
//   2. There is no render pass either: clears are explicit command-list calls and
//      resource states must be transitioned by hand. The state machine below keeps
//      ONE invariant that both sides of the seam rely on: at the end of every
//      frame's command list the current render target is left in
//      D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE, which is exactly the state
//      d3d_glue.cc's sk_gpu_draw_texture assumes when it wraps that resource (and
//      the state Skia's own D3D12 backend believes a freshly borrowed texture to
//      be in).
//
// QUEUE SHARING
// The batch of draws is submitted to SKIA'S command queue (d3d_glue.cc's
// g_queue), looked up by name so this file still links in a build without the
// window backend. That is the same reason metal_glue.mm hands out
// sk_mtl_shared_queue: the composite is submitted to the same queue later in the
// frame, and a queue serializes its submissions, so `s3d_flush_async` needs no CPU
// wait -- the GPU orders the composite's read after these writes by itself.
//
// SHADERS
// AGAL is translated to HLSL by runtime.ts's `as_agal_translate` (target 2,
// selected by ASC_S3D_HLSL) and handed here as source text: `vs_main(VSIn)` /
// `fs_main(FSIn)` with `cbuffer VCBuf : register(b0)`, `Texture2D<float4> fsN :
// register(tN)` and `SamplerState smpN : register(sN)`. The root signature below
// is built to match exactly that. Compiled with fxc (D3DCompile) at vs_5_1/ps_5_1
// -- the profile Skia's own D3D12 backend uses on this device class.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
// getenv/strncpy are the only "insecure" CRT calls below; the CRTs mark them
// deprecated as a warning-as-error trap, not because they are wrong here.
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <d3d12.h>
#include <dxgi1_4.h>
#include <d3dcompiler.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>

// The rest of the file is the C end of the ABI: the generated C declares these as
// plain `void s3d_create(...)` et al. (no name mangling), and this is a C++
// translation unit, so every definition below needs C linkage. Opening the block
// before the standard headers instead is an error -- MSVC's <cstdlib> overloads
// `abs` inside its own namespace, which `extern "C"` forbids ("conflicting types
// for 'abs'"). Without the block the defect is a link error naming the s3d_*
// symbol (measured: `_s3d_create`, `_s3d_resize`, `_s3d_clear`, `_s3d_flush_async`,
// `_s3d_width`, `_s3d_height` -- every one of them referenced by the demo).
extern "C" {

// Window / texture / frame limits. The per-context tables mirror
// stage3d_glue.mm's; the stream/texture counts are Stage3D's own 8.
#define S3D_MAX_CTX 4
#define S3D_MAX_STREAMS 8
#define S3D_MAX_TEX 8
// Command allocators cannot be reset while a command list using them is in
// flight, so the frame is triple-buffered: the batch opened for frame N reuses the
// slot frame N-3 used, and only once that slot's fence has been reached.
#define S3D_FRAMES_IN_FLIGHT 3
// Draws per frame whose bound-texture descriptors the per-frame arena holds. A
// draw that binds the same textures and sampler states as the draw before it
// reuses the previous block, so this only bounds texture-SWITCHING draws (a
// Starling painter issues far fewer than this).
#define S3D_DRAWS_PER_FRAME 512
#define S3D_DESCS_PER_FRAME (S3D_DRAWS_PER_FRAME * S3D_MAX_TEX)
#define S3D_MAX_PROGRAMS 16
#define S3D_MAX_PSOVAR 16
#define S3D_MAX_RTV 64
#define S3D_MAX_DSV 16
// Sampler descriptor blocks: ONE immutable 8-descriptor block per distinct
// (samplerStateSet, filter, wrap, mip) vector. 256 x 8 = 2048 is exactly
// D3D12_MAX_SHADER_VISIBLE_SAMPLER_HEAP_SIZE, the hard ceiling a D3D12 sampler
// heap may not exceed (a 12288-descriptor heap is E_INVALIDARG, not a warning).
#define S3D_MAX_SMPLCFG 256
#define S3D_RELEASE_QUEUE 4096
// Constant registers are versioned PER DRAW. The generated C re-uploads the whole
// register file immediately before every drawTriangles (Context3D_submit), but a
// D3D12 command list reads its constant buffers only when the GPU EXECUTES it --
// at the end of the frame, after every upload of that frame has landed. One shared
// buffer per frame slot therefore makes every draw in the frame read the LAST
// upload's matrix: measured on examples/air-starling-demo, all 12 menu buttons were
// transformed by the last button's mvp, so only that one landed where it belonged
// (and the previous button's label was squashed by another TextField's scale).
// Metal is immune because setVertexBytes copies the values inline into the command
// buffer, which is why this only ever showed up on the D3D12 backend. Each upload
// gets its own region instead, and a draw binds the region of the last upload.
// 4096 bytes = 256 float4 registers: the largest cbuffer the HLSL translator can
// declare (runtime.ts sizes vc[]/fc[] from the program's highest AGAL register), so
// a region is always at least as large as the range its shader may read.
#define S3D_CB_REGION 4096
#define S3D_CB_BYTES (S3D_CB_REGION * S3D_DRAWS_PER_FRAME)
#define S3D_KEY_CAP 256

// The live-program slots: `live` is one of these, an index into progs[], or
// S3D_LIVE_KEYLESS for a program compiled with no Program3D identity to cache
// under (Program3D.upload always passes one in practice).
#define S3D_LIVE_NONE (-2)
#define S3D_LIVE_KEYLESS (-1)

// ---- the shared D3D12 backend (defined in d3d_glue.cc) ---------------------
// Looked up by NAME rather than linked: a headless Stage3D build (renderMode cpu,
// no window GPU backend) does not link d3d_glue.cc at all, and a hard reference
// would then be an unresolved external. Same discipline as stage3d_glue.mm's
// dlsym(RTLD_DEFAULT, "sk_mtl_shared_queue"); on Windows the two functions are
// __declspec(dllexport) so GetProcAddress can find them in the executable's own
// export table (a PE has no RTLD_DEFAULT equivalent).
typedef ID3D12Device* (*SkD3DDeviceFn)(void);
typedef ID3D12CommandQueue* (*SkD3DQueueFn)(void);

static void* s3d_lookup_export(const char* name) {
  HMODULE m = GetModuleHandleA(NULL);
  if (m == NULL) return NULL;
  return (void*)GetProcAddress(m, name);
}

// ---- debug probes (mirror stage3d_glue.mm's) -------------------------------
static int s3d_env(const char* name) {
  static char seen[8][32];
  static int seen_n = 0;
  for (int i = 0; i < seen_n; i++) if (strcmp(seen[i], name) == 0) return 1;
  if (getenv(name) == NULL) return 0;
  if (seen_n < 8) { strncpy(seen[seen_n], name, 31); seen[seen_n][31] = '\0'; seen_n++; }
  return 1;
}
static double s3d_now_ms(void) {
  LARGE_INTEGER f, c;
  QueryPerformanceFrequency(&f);
  QueryPerformanceCounter(&c);
  return (double)c.QuadPart * 1000.0 / (double)f.QuadPart;
}

// Every backend-creation failure reports itself. They used to `return 0` silently,
// which made a broken backend indistinguishable from a working one: s3d_create
// returns NULL, the generated C stores NULL in `o->gpu`, and every later call
// no-ops -- a black stage with no diagnostic at all (measured in
// temp/s3dprobe.cc, which is how this was found). AGENTS.md 2.5 forbids that.
static int s3d_init_fail(const char* what, HRESULT hr) {
  fprintf(stderr, "stage3d_d3d: init failed at %s (0x%08lx)\n", what, (unsigned long)hr);
  fflush(stderr);
  return 0;
}

// ---- opaque handles --------------------------------------------------------

struct S3DContext;

// One GPU texture. `void*` in the ABI, always one of these. Unlike a Metal
// MTLTexture (which describes itself), a D3D12 resource carries no usable
// bookkeeping, so the handle owns the format, the current resource state and the
// descriptor slots.
typedef struct {
  ID3D12Resource* res;
  struct S3DContext* owner;   // whose RTV/DSV slots and deferred-release queue hold it
  D3D12_RESOURCE_STATES state;
  DXGI_FORMAT format;
  int width, height;
  int mips;       // mip levels the RESOURCE has (a D3D12 descriptor is immutable)
  int hasChain;   // the app supplied (or we generated) a level > 0
  int faces;      // 1, or 6 for a cube
  int isRT;       // RENDER_TARGET flag + an RTV slot
  int rtvSlot;
  int isDepth;    // DSV slot
  int dsvSlot;
} S3DTexture;

// One cached pipeline: the full draw state as a string key plus the PSO built from
// it. See the file header for why the key is the whole state, not just the blend.
typedef struct {
  char key[S3D_KEY_CAP];
  ID3D12PipelineState* pso;
  unsigned long stamp;
} S3DPsoVar;

// One compiled program: the fxc bytecode of its two stages plus the pipeline
// variants built from them. A program switch is a pointer lookup here, not a
// recompile -- the generated C calls s3d_compile on every submit.
typedef struct {
  int used;
  void* key;                    // Program3D identity (the cache slot name)
  unsigned long long srcHash;   // hash of the HLSL this slot was compiled from
  ID3DBlob* vs;
  ID3DBlob* ps;
  S3DPsoVar pso[S3D_MAX_PSOVAR];
  int npso;
  unsigned long stamp;
} S3DProg;

typedef struct {
  ID3D12Resource* buf;     // UPLOAD heap: written by the CPU, read by the IA
  int ub;                  // which pooled buffer owns `buf` (see S3DUploadBuf)
  int components;          // 1..4
  int numVertices;
} S3DStream;

// Upload buffers are POOLED, never created per upload. A D3D12 committed resource
// costs ~100 us of driver/kernel time to make -- measured on
// examples/air-starling-demo, where 64 boot-time uploads took 7.55 ms regardless of
// size -- while the generated C re-uploads its vertex and index buffers on every
// CHANGED frame (20..27 uploads per frame at 66 k objects, 4.4..6.5 ms of a 16.7 ms
// frame, essentially all of it inside CreateCommittedResource). Metal never pays
// this: its upload is a replaceRegion into a persistent buffer (stage3d_glue.mm).
// An UPLOAD-heap resource may stay mapped for its whole life, so the pool hands out
// the smallest FREE entry that fits and writes in place, creating a resource only
// when nothing is free.
//
// "Free" is decided by the fence of the submission that last referenced the buffer
// (stamped in s3d_stamp_uploads at submit time), never by CPU bookkeeping alone: a
// buffer the GPU may still read must not be overwritten. Two further rules keep the
// batch being RECORDED safe, which is what makes this correct rather than merely fast:
//   - a buffer currently bound to a stream (or to the index stage) is never handed
//     out again -- the open batch has already referenced its GPU virtual address;
//   - a buffer REPLACED while a batch is open is re-marked pending for the same
//     reason (s3d_mark_batch_ref).
#define S3D_UBUF_MAX 1024
typedef struct {
  ID3D12Resource* res;
  void* map;              // permanently mapped: legal for UPLOAD heap, and it removes
                          // a Map/Unmap round trip from every upload
  UINT bytes;             // committed capacity
  uint64_t fence;         // submission that may still read it (0 = none ever did)
  int pending;            // written since the last submit, so not stamped yet
} S3DUploadBuf;

// Deferred release: a resource handed to the GPU is not freed when the CPU
// replaces it (the generated C re-uploads its vertex buffer on every submit),
// only once the fence says every submission that could reference it completed.
typedef struct {
  IUnknown* obj;
  uint64_t fence;
} S3DRelease;

typedef struct S3DContext {
  ID3D12Device* device;            // borrowed from d3d_glue.cc, or owned (headless)
  ID3D12CommandQueue* queue;       // borrowed, or owned
  int ownsBackend;

  // --- command submission (triple-buffered) ---
  ID3D12CommandAllocator* alloc[S3D_FRAMES_IN_FLIGHT];
  ID3D12GraphicsCommandList* list;
  ID3D12Fence* fence;
  HANDLE fenceEvent;
  uint64_t fenceValues[S3D_FRAMES_IN_FLIGHT];
  uint64_t fenceNext;
  int slot;                        // the slot the NEXT batch will use
  int listOpen;                    // a batch is being recorded
  // Immediate (blocking) work -- texture uploads, readbacks, resize -- gets its
  // own allocator/list so it can never reset the allocator an open batch uses.
  ID3D12CommandAllocator* upAlloc;
  ID3D12GraphicsCommandList* upList;

  ID3D12RootSignature* rootSig;
  ID3D12DescriptorHeap* srvHeap;   // CBV_SRV_UAV, per-frame arenas
  ID3D12DescriptorHeap* smpHeap;   // SAMPLER, one immutable block per distinct state
  ID3D12DescriptorHeap* rtvHeap;
  ID3D12DescriptorHeap* dsvHeap;
  UINT srvInc, smpInc, rtvInc, dsvInc;
  UINT srvCursor;                  // SRV arena cursor
  UINT srvSlotBase;                // ... and the current frame slot's arena base
  // Sampler blocks are cached PER DISTINCT SAMPLER STATE, not per frame slot: a
  // D3D12 sampler heap tops out at D3D12_MAX_SHADER_VISIBLE_SAMPLER_HEAP_SIZE
  // (2048) descriptors -- a per-frame arena of 4096 x 3 slots fails outright with
  // E_INVALIDARG (measured, temp/s3dprobe.cc). Immutable blocks also remove the
  // cross-frame hazard the SRV arena handles with its slot fences: the block a
  // submitted frame points at is never rewritten.
  unsigned long long smpCfgKey[S3D_MAX_SMPLCFG];
  UINT smpCfgBase[S3D_MAX_SMPLCFG];
  int smpCfgN;
  int rtvUsed[S3D_MAX_RTV];
  int dsvUsed[S3D_MAX_DSV];

  // --- render targets ---
  S3DTexture* target;              // offscreen back buffer (BGRA8, RENDER_TARGET)
  S3DTexture* renderOverride;      // render-to-texture target (NULL = back buffer)
  S3DTexture* depth;               // depth/stencil for `target`
  S3DTexture* rtDepth;             // depth/stencil for `renderOverride`
  int rtDepthW, rtDepthH;
  S3DTexture* dummy;               // 1x1 stand-in for unbound sampler units
  int width, height;

  // --- current render state (Stage3D is a state machine) ---
  int live;                        // S3D_LIVE_*, or an index into progs[]
  S3DProg progs[S3D_MAX_PROGRAMS];
  int nprogs;
  S3DProg keyless;
  unsigned long progstamp;
  S3DTexture* boundRT;             // render target currently bound on the list
  int boundDs;                     // whether a DSV is bound with it

  S3DStream streams[S3D_MAX_STREAMS];
  int numStreams;
  ID3D12Resource* indexBuffer;
  int numIndices;
  int indexBytes;
  int indexUb;                     // which pooled buffer owns indexBuffer
  S3DUploadBuf ubuf[S3D_UBUF_MAX];
  int nubuf;                       // entries ever handed out (a freed one keeps its slot)
  ID3D12Resource* vcBuf[S3D_FRAMES_IN_FLIGHT];
  ID3D12Resource* fcBuf[S3D_FRAMES_IN_FLIGHT];
  void* vcMap[S3D_FRAMES_IN_FLIGHT];
  void* fcMap[S3D_FRAMES_IN_FLIGHT];
  UINT vcBytes, fcBytes;           // slot sizes (256-aligned, grown on demand)
  UINT cbOffV, cbOffF;             // region of the CURRENT draw inside vcBuf/fcBuf
  UINT cbCurV, cbCurF;             // bump cursor into vcBuf/fcBuf (per batch)
  S3DTexture* textures[S3D_MAX_TEX];

  float clearR, clearG, clearB, clearA;
  float clearDepthValue;
  unsigned int clearStencilValue;
  const char* blendSource;
  const char* blendDest;
  int instanceCount;
  int clearPending, clearColor, clearDepth, clearStencil;
  int depthWrite;
  const char* depthCompare;
  const char* cullMode;
  const char* stencilFace;
  const char* stencilCompare;
  const char* stencilBothPass;
  const char* stencilDepthFail;
  const char* stencilDepthPassStencilFail;
  unsigned int stencilRef, stencilReadMask, stencilWriteMask;
  int scissorOn, scissorX, scissorY, scissorW, scissorH;
  int colorMaskR, colorMaskG, colorMaskB, colorMaskA;
  int samplerFilter[S3D_MAX_TEX];
  int samplerWrap[S3D_MAX_TEX];
  int samplerMip[S3D_MAX_TEX];
  int samplerStateSet[S3D_MAX_TEX];
  int texHasMips[S3D_MAX_TEX];
  // Descriptor-block reuse for the per-draw texture/sampler tables: a draw whose
  // bindings equal the previous draw's re-issues no descriptors.
  unsigned long long lastDescKey;
  D3D12_GPU_DESCRIPTOR_HANDLE lastSrvTable;
  D3D12_GPU_DESCRIPTOR_HANDLE lastSmpTable;

  ID3D12Resource* rbBuf;           // readback staging (grown on demand)
  UINT rbBytes, rbRowPitch;

  S3DRelease rel[S3D_RELEASE_QUEUE];
  int nrel;

  long statDraws, statFrames, statCompiles, statPsos;
  double statT0;
} S3DContext;

// Defined with the upload pool far below; s3d_batch_end / s3d_run_immediate need it
// to tie a frame's uploaded buffers to the submission that first references them.
static void s3d_stamp_uploads(S3DContext* c, uint64_t v);

static S3DContext* s3d_live[S3D_MAX_CTX];
static int s3d_live_n = 0;

static void s3d_register_ctx(S3DContext* c) {
  if (s3d_live_n < S3D_MAX_CTX) s3d_live[s3d_live_n++] = c;
}
static void s3d_unregister_ctx(S3DContext* c) {
  for (int i = 0; i < s3d_live_n; i++)
    if (s3d_live[i] == c) { s3d_live[i] = s3d_live[--s3d_live_n]; return; }
}
// Drop every BORROWED binding of `t`: a destroyed texture left in a sampler slot or
// as the render override would crash the next draw (an immediate device-removed,
// not a soft failure). Same rule as stage3d_glue.mm's s3d_unbind_texture_everywhere.
static void s3d_unbind_texture_everywhere(S3DTexture* t) {
  if (t == NULL) return;
  for (int k = 0; k < s3d_live_n; k++) {
    S3DContext* c = s3d_live[k];
    for (int i = 0; i < S3D_MAX_TEX; i++)
      if (c->textures[i] == t) { c->textures[i] = NULL; c->texHasMips[i] = 0; }
    if (c->renderOverride == t) { c->renderOverride = NULL; c->boundRT = NULL; }
    if (c->depth == t) c->depth = NULL;
    if (c->rtDepth == t) c->rtDepth = NULL;
  }
}

// ---- small helpers ---------------------------------------------------------
static void s3d_key_str(char* dst, size_t cap, const char* s) {
  if (s == NULL) { dst[0] = '\0'; return; }
  size_t n = strlen(s);
  if (n >= cap) n = cap - 1;
  memcpy(dst, s, n);
  dst[n] = '\0';
}
static int s3d_streq(const char* a, const char* b) {
  if (a == b) return 1;
  if (a == NULL || b == NULL) return 0;
  return strcmp(a, b) == 0;
}
static UINT s3d_align256(UINT n) { return (n + 255u) & ~255u; }
// Stage3D's clip space and D3D12's NDC are both Y-up and Z 0..1 (the AS3
// projection matrix already carries the screen flip), so no shader flip is applied
// -- matching stage3d_glue.mm, which likewise does none for MSL (only the GLSL ES
// target flips gl_Position.y). Front faces are therefore CLOCKWISE, exactly what
// MTLWindingClockwise declares on the Metal side.
static D3D12_RASTERIZER_DESC s3d_raster_desc(const char* cullMode) {
  D3D12_RASTERIZER_DESC r = {};
  r.FillMode = D3D12_FILL_MODE_SOLID;
  if (cullMode != NULL && strcmp(cullMode, "back") == 0) r.CullMode = D3D12_CULL_MODE_BACK;
  else if (cullMode != NULL && strcmp(cullMode, "front") == 0) r.CullMode = D3D12_CULL_MODE_FRONT;
  else r.CullMode = D3D12_CULL_MODE_NONE;   // "frontAndBack" = do not cull
  r.FrontCounterClockwise = FALSE;
  r.DepthBias = D3D12_DEFAULT_DEPTH_BIAS;
  r.DepthBiasClamp = D3D12_DEFAULT_DEPTH_BIAS_CLAMP;
  r.SlopeScaledDepthBias = D3D12_DEFAULT_SLOPE_SCALED_DEPTH_BIAS;
  r.DepthClipEnable = TRUE;
  // NOTE: unlike D3D11 there is no ScissorEnable field -- a D3D12 rasterizer ALWAYS
  // honours the scissor rect. Stage3D's setScissorRectangle is per-draw state, so a
  // disabled scissor is expressed as a full-target rect at draw time instead (which
  // is exactly what "no scissor" means).
  r.MultisampleEnable = FALSE;
  r.AntialiasedLineEnable = FALSE;
  return r;
}

static void s3d_defer_release(S3DContext* c, IUnknown* o) {
  if (o == NULL) return;
  if (s3d_env("ASC_S3D_LIFE")) fprintf(stderr, "s3d(life) defer %p fence=%llu\n", (void*)o, (unsigned long long)c->fenceNext);
  if (c->fence == NULL) { o->Release(); return; }
  if (c->nrel >= S3D_RELEASE_QUEUE) {
    // Bounded. Draining here is safe: everything still pending simply stays
    // referenced by the GPU, and the queue only fills for an app that replaces
    // hundreds of resources between two frames.
    const uint64_t done = c->fence->GetCompletedValue();
    int w = 0;
    for (int i = 0; i < c->nrel; i++) {
      // fence 0 = parked on the open batch (see s3d_defer_release); not releasable yet.
      if (c->rel[i].fence != 0 && c->rel[i].fence <= done) { c->rel[i].obj->Release(); }
      else c->rel[w++] = c->rel[i];
    }
    c->nrel = w;
    if (c->nrel >= S3D_RELEASE_QUEUE) { o->Release(); return; }
  }
  c->rel[c->nrel].obj = o;
  // A resource disposed WHILE A BATCH IS STILL BEING RECORDED may already be bound by
  // that batch's earlier draws, and its submission has not happened yet -- so the last
  // signalled value (fenceNext) says nothing about it. Such an entry is parked on fence
  // 0, meaning "tie me to the next submission", and s3d_batch_end stamps it with the
  // value that submission signs. Releasing it on fenceNext instead let the GPU sample
  // memory D3D12 had already handed to the NEXT texture: measured on the Starling demo
  // (device removed + a text quad showing another text's pixels after a scene switch,
  // where 171 of 171 releases happened with a batch still open).
  c->rel[c->nrel].fence = c->listOpen ? 0 : c->fenceNext;
  c->nrel++;
}
static void s3d_drain_releases(S3DContext* c) {
  if (c->fence == NULL) return;
  const uint64_t done = c->fence->GetCompletedValue();
  int w = 0;
  for (int i = 0; i < c->nrel; i++) {
    // fence 0 = parked on the open batch (see s3d_defer_release); not releasable yet.
    if (c->rel[i].fence != 0 && c->rel[i].fence <= done) { c->rel[i].obj->Release(); }
    else c->rel[w++] = c->rel[i];
  }
  c->nrel = w;
}

// ---- wait / submit ---------------------------------------------------------

// Block until every submitted command list has completed. Used by the paths that
// READ a GPU resource on the CPU (readback), by the uploads that overwrite a
// resource an in-flight batch may still sample, and by teardown/resize.
static void s3d_wait_idle(S3DContext* c) {
  if (c->queue == NULL || c->fence == NULL) return;
  const uint64_t v = ++c->fenceNext;
  if (FAILED(c->queue->Signal(c->fence, v))) return;
  if (c->fence->GetCompletedValue() < v) {
    if (SUCCEEDED(c->fence->SetEventOnCompletion(v, c->fenceEvent)))
      WaitForSingleObjectEx(c->fenceEvent, INFINITE, FALSE);
  }
  s3d_drain_releases(c);
}

// Wait for the frame slot that is about to be reused. Called both when a batch
// takes the slot's allocator and when the CPU overwrites the slot's constant
// buffer -- the latter happens BEFORE the batch opens (the generated C uploads
// constants between the state setters and drawTriangles), so the wait cannot be
// left to batch begin alone or the GPU could still be reading the CB.
static void s3d_wait_slot(S3DContext* c, int slot) {
  if (c->fence == NULL || slot < 0 || slot >= S3D_FRAMES_IN_FLIGHT) return;
  if (c->fenceValues[slot] != 0 && c->fence->GetCompletedValue() < c->fenceValues[slot]) {
    if (SUCCEEDED(c->fence->SetEventOnCompletion(c->fenceValues[slot], c->fenceEvent)))
      WaitForSingleObjectEx(c->fenceEvent, INFINITE, FALSE);
  }
}

// Open the batch: take the next frame slot, wait for its previous submission,
// reset its allocator and start recording. Called by the first draw of a batch.
static int s3d_batch_begin(S3DContext* c) {
  if (c->listOpen) return 1;
  if (c->list == NULL) return 0;
  s3d_drain_releases(c);
  const int idx = c->slot;
  s3d_wait_slot(c, idx);
  if (FAILED(c->alloc[idx]->Reset())) return 0;
  if (FAILED(c->list->Reset(c->alloc[idx], NULL))) return 0;
  c->srvSlotBase = (UINT)idx * S3D_DESCS_PER_FRAME;
  c->srvCursor = c->srvSlotBase;
  c->lastSrvTable.ptr = 0;
  c->lastSmpTable.ptr = 0;
  c->lastDescKey = 0;
  c->boundRT = NULL;
  c->boundDs = -1;
  c->listOpen = 1;
  c->statFrames++;
  if (c->statT0 == 0.0) c->statT0 = s3d_now_ms();
  return 1;
}

// Close, submit and (optionally) wait. The render target is left in
// PIXEL_SHADER_RESOURCE -- the invariant sk_gpu_draw_texture relies on.
static void s3d_batch_end(S3DContext* c, int wait) {
  if (!c->listOpen) { if (wait) s3d_wait_idle(c); return; }
  if (c->boundRT != NULL && c->boundRT->state == D3D12_RESOURCE_STATE_RENDER_TARGET) {
    D3D12_RESOURCE_BARRIER b = {};
    b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    b.Transition.pResource = c->boundRT->res;
    b.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    b.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
    b.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
    c->list->ResourceBarrier(1, &b);
    c->boundRT->state = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
  }
  const int idx = c->slot;
  c->listOpen = 0;
  c->boundRT = NULL;
  c->boundDs = -1;
  // Constant regions are handed out from the start of the slot's buffer, and this
  // is where that start is established -- NOT in batch_begin: the FIRST draw of a
  // frame uploads its constants before anything opens the batch, so a reset there
  // discards the region that upload just wrote and leaves the frame's first two
  // draws sharing one region (measured in the per-draw dump: cbV=0 on BOTH draw 0
  // and draw 1, so draw 0 rendered with draw 1's matrix). The wait in
  // s3d_batch_begin is what makes it safe to overwrite the regions the GPU read
  // from this slot's previous frame.
  c->cbCurV = c->cbCurF = 0;
  c->cbOffV = c->cbOffF = 0;
  if (FAILED(c->list->Close())) return;
  ID3D12CommandList* lists[1] = { (ID3D12CommandList*)c->list };
  c->queue->ExecuteCommandLists(1, lists);
  const uint64_t v = ++c->fenceNext;
  c->queue->Signal(c->fence, v);
  c->fenceValues[idx] = v;
  // Stamp the entries parked by s3d_defer_release: they were disposed while THIS batch
  // was being recorded, so this submission is the first fence that can prove the GPU is
  // finished with them.
  for (int i = 0; i < c->nrel; i++) if (c->rel[i].fence == 0) c->rel[i].fence = v;
  // ... and the same submission is what makes this frame's pooled upload buffers
  // reclaimable (s3d_acquire_upload refuses any buffer the GPU may still read).
  s3d_stamp_uploads(c, v);
  // The next batch gets the next slot. Only the LAST batch of a frame is submitted
  // before the composite, so the target's final state is PIXEL_SHADER_RESOURCE
  // whichever batch wrote it.
  c->slot = (idx + 1) % S3D_FRAMES_IN_FLIGHT;
  if (wait) s3d_wait_idle(c);
  if (s3d_env("ASC_S3D_STATS") && c->statT0 != 0.0 && (c->statFrames % 600) == 0) {
    const double el = (s3d_now_ms() - c->statT0) / 1000.0;
    fprintf(stderr, "s3d_stats(d3d): %.1fs %ld frames (%.1f fps) %ld draws %ld pso %ld compiles\n",
            el, c->statFrames, el > 0.0 ? (double)c->statFrames / el : 0.0,
            c->statDraws, c->statPsos, c->statCompiles);
    fflush(stderr);
  }
}

// Run the immediate list (not the frame batch) and block: texture uploads and
// readbacks both need a settled GPU, and both use this path.
static int s3d_run_immediate(S3DContext* c) {
  if (FAILED(c->upList->Close())) return 0;
  ID3D12CommandList* lists[1] = { (ID3D12CommandList*)c->upList };
  c->queue->ExecuteCommandLists(1, lists);
  s3d_wait_idle(c);
  // The immediate list is not what reads a vertex/index upload, but it IS a submit:
  // stamping here keeps the pool's bookkeeping in step when an upload happens with no
  // batch open (s3d_wait_idle just signalled c->fenceNext).
  if (c->fence != NULL) s3d_stamp_uploads(c, c->fenceNext);
  return 1;
}

// ---- descriptor heaps ------------------------------------------------------

static int s3d_make_heaps(S3DContext* c) {
  D3D12_DESCRIPTOR_HEAP_DESC h = {};
  h.Type = D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV;
  h.NumDescriptors = S3D_DESCS_PER_FRAME * S3D_FRAMES_IN_FLIGHT;
  h.Flags = D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE;
  HRESULT hr = c->device->CreateDescriptorHeap(&h, __uuidof(ID3D12DescriptorHeap), (void**)&c->srvHeap);
  if (FAILED(hr)) return s3d_init_fail("CreateDescriptorHeap(CBV_SRV_UAV)", hr);
  h.Type = D3D12_DESCRIPTOR_HEAP_TYPE_SAMPLER;
  h.NumDescriptors = S3D_MAX_SMPLCFG * S3D_MAX_TEX;
  hr = c->device->CreateDescriptorHeap(&h, __uuidof(ID3D12DescriptorHeap), (void**)&c->smpHeap);
  if (FAILED(hr)) return s3d_init_fail("CreateDescriptorHeap(SAMPLER)", hr);
  h.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
  h.NumDescriptors = S3D_MAX_RTV;
  h.Flags = D3D12_DESCRIPTOR_HEAP_FLAG_NONE;
  hr = c->device->CreateDescriptorHeap(&h, __uuidof(ID3D12DescriptorHeap), (void**)&c->rtvHeap);
  if (FAILED(hr)) return s3d_init_fail("CreateDescriptorHeap(RTV)", hr);
  h.Type = D3D12_DESCRIPTOR_HEAP_TYPE_DSV;
  h.NumDescriptors = S3D_MAX_DSV;
  hr = c->device->CreateDescriptorHeap(&h, __uuidof(ID3D12DescriptorHeap), (void**)&c->dsvHeap);
  if (FAILED(hr)) return s3d_init_fail("CreateDescriptorHeap(DSV)", hr);
  c->srvInc = c->device->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV);
  c->smpInc = c->device->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_SAMPLER);
  c->rtvInc = c->device->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
  c->dsvInc = c->device->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_DSV);
  return 1;
}
static int s3d_take_rtv(S3DContext* c) {
  for (int i = 0; i < S3D_MAX_RTV; i++) if (!c->rtvUsed[i]) { c->rtvUsed[i] = 1; return i; }
  return -1;
}
static int s3d_take_dsv(S3DContext* c) {
  for (int i = 0; i < S3D_MAX_DSV; i++) if (!c->dsvUsed[i]) { c->dsvUsed[i] = 1; return i; }
  return -1;
}
static void s3d_release_rtv(S3DContext* c, int i) { if (i >= 0 && i < S3D_MAX_RTV) c->rtvUsed[i] = 0; }
static void s3d_release_dsv(S3DContext* c, int i) { if (i >= 0 && i < S3D_MAX_DSV) c->dsvUsed[i] = 0; }
static D3D12_CPU_DESCRIPTOR_HANDLE s3d_rtv_cpu(S3DContext* c, int slot) {
  D3D12_CPU_DESCRIPTOR_HANDLE h = c->rtvHeap->GetCPUDescriptorHandleForHeapStart();
  h.ptr += (SIZE_T)slot * c->rtvInc;
  return h;
}
static D3D12_CPU_DESCRIPTOR_HANDLE s3d_dsv_cpu(S3DContext* c, int slot) {
  D3D12_CPU_DESCRIPTOR_HANDLE h = c->dsvHeap->GetCPUDescriptorHandleForHeapStart();
  h.ptr += (SIZE_T)slot * c->dsvInc;
  return h;
}

// ---- root signature --------------------------------------------------------

static int s3d_make_root_sig(S3DContext* c) {
  D3D12_DESCRIPTOR_RANGE ranges[2] = {};
  ranges[0].RangeType = D3D12_DESCRIPTOR_RANGE_TYPE_SRV;
  ranges[0].NumDescriptors = S3D_MAX_TEX;
  ranges[0].BaseShaderRegister = 0;
  ranges[0].RegisterSpace = 0;
  ranges[0].OffsetInDescriptorsFromTableStart = 0;
  ranges[1].RangeType = D3D12_DESCRIPTOR_RANGE_TYPE_SAMPLER;
  ranges[1].NumDescriptors = S3D_MAX_TEX;
  ranges[1].BaseShaderRegister = 0;
  ranges[1].RegisterSpace = 0;
  ranges[1].OffsetInDescriptorsFromTableStart = 0;

  D3D12_ROOT_PARAMETER p[4] = {};
  // The translator emits `cbuffer VCBuf : register(b0)` in the vertex stage and
  // `cbuffer FCBuf : register(b0)` in the fragment stage: the SAME register b0 on
  // both, which D3D12 accepts only because the two parameters declare disjoint
  // shader visibility.
  p[0].ParameterType = D3D12_ROOT_PARAMETER_TYPE_CBV;
  p[0].Descriptor.ShaderRegister = 0;
  p[0].Descriptor.RegisterSpace = 0;
  p[0].ShaderVisibility = D3D12_SHADER_VISIBILITY_VERTEX;
  p[1].ParameterType = D3D12_ROOT_PARAMETER_TYPE_CBV;
  p[1].Descriptor.ShaderRegister = 0;
  p[1].Descriptor.RegisterSpace = 0;
  p[1].ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;
  p[2].ParameterType = D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
  p[2].DescriptorTable.NumDescriptorRanges = 1;
  p[2].DescriptorTable.pDescriptorRanges = &ranges[0];
  p[2].ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;
  p[3].ParameterType = D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
  p[3].DescriptorTable.NumDescriptorRanges = 1;
  p[3].DescriptorTable.pDescriptorRanges = &ranges[1];
  p[3].ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;

  D3D12_ROOT_SIGNATURE_DESC d = {};
  d.NumParameters = 4;
  d.pParameters = p;
  d.Flags = D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT;

  ID3DBlob* blob = NULL;
  ID3DBlob* err = NULL;
  HRESULT hr = D3D12SerializeRootSignature(&d, D3D_ROOT_SIGNATURE_VERSION_1, &blob, &err);
  if (FAILED(hr) || blob == NULL) {
    fprintf(stderr, "stage3d_d3d: SerializeRootSignature failed: %s\n",
            err ? (const char*)err->GetBufferPointer() : "(no message)");
    if (err) err->Release();
    return 0;
  }
  hr = c->device->CreateRootSignature(0, blob->GetBufferPointer(), blob->GetBufferSize(),
                                      __uuidof(ID3D12RootSignature), (void**)&c->rootSig);
  blob->Release();
  if (err) err->Release();
  if (FAILED(hr)) {
    fprintf(stderr, "stage3d_d3d: CreateRootSignature failed: 0x%08lx\n", (unsigned long)hr);
    return 0;
  }
  return 1;
}

// ---- textures --------------------------------------------------------------

static S3DTexture* s3d_make_texture(S3DContext* c, int w, int h, int mips, int faces,
                                    int isRT, int isDepth) {
  if (w <= 0 || h <= 0) return NULL;
  if (mips < 1) mips = 1;
  if (faces != 6) faces = 1;
  S3DTexture* t = (S3DTexture*)calloc(1, sizeof(S3DTexture));
  if (t == NULL) return NULL;
  t->width = w;
  t->height = h;
  t->mips = mips;
  t->faces = faces;
  t->owner = c;
  t->rtvSlot = -1;
  t->dsvSlot = -1;
  t->format = isDepth ? DXGI_FORMAT_D24_UNORM_S8_UINT : DXGI_FORMAT_B8G8R8A8_UNORM;

  D3D12_RESOURCE_DESC d = {};
  d.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
  d.Width = (UINT64)w;
  d.Height = (UINT)h;
  d.DepthOrArraySize = (UINT16)faces;
  d.MipLevels = (UINT16)mips;
  d.Format = t->format;
  d.SampleDesc.Count = 1;
  d.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;
  d.Flags = isDepth ? D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL
                    : (isRT ? D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET : D3D12_RESOURCE_FLAG_NONE);

  D3D12_HEAP_PROPERTIES hp = {};
  hp.Type = D3D12_HEAP_TYPE_DEFAULT;
  D3D12_CLEAR_VALUE cv = {};
  D3D12_CLEAR_VALUE* cvp = NULL;
  if (isDepth) {
    cv.Format = DXGI_FORMAT_D24_UNORM_S8_UINT;
    cv.DepthStencil.Depth = 1.0f;
    cv.DepthStencil.Stencil = 0;
    cvp = &cv;
  } else if (isRT) {
    cv.Format = t->format;
    cvp = &cv;
  }
  // COMMON is the legal "unknown" starting state: the first use of this texture
  // (an upload, or binding it as a render target) transitions it explicitly.
  t->state = D3D12_RESOURCE_STATE_COMMON;
  const HRESULT hr = c->device->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &d,
                                                        D3D12_RESOURCE_STATE_COMMON, cvp,
                                                        __uuidof(ID3D12Resource), (void**)&t->res);
  if (FAILED(hr) || t->res == NULL) {
    fprintf(stderr, "stage3d_d3d: CreateCommittedResource(%dx%d, mips=%d, faces=%d) failed: 0x%08lx\n",
            w, h, mips, faces, (unsigned long)hr);
    free(t);
    return NULL;
  }
  if (isRT) {
    D3D12_RENDER_TARGET_VIEW_DESC rd = {};
    rd.Format = t->format;
    rd.ViewDimension = D3D12_RTV_DIMENSION_TEXTURE2D;
    rd.Texture2D.MipSlice = 0;
    rd.Texture2D.PlaneSlice = 0;
    t->rtvSlot = s3d_take_rtv(c);
    if (t->rtvSlot < 0) {
      fprintf(stderr, "stage3d_d3d: out of RTV descriptors (%d)\n", S3D_MAX_RTV);
    } else {
      c->device->CreateRenderTargetView(t->res, &rd, s3d_rtv_cpu(c, t->rtvSlot));
      t->isRT = 1;
    }
  }
  if (isDepth) {
    D3D12_DEPTH_STENCIL_VIEW_DESC dd = {};
    dd.Format = t->format;
    dd.ViewDimension = D3D12_DSV_DIMENSION_TEXTURE2D;
    dd.Texture2D.MipSlice = 0;
    t->dsvSlot = s3d_take_dsv(c);
    if (t->dsvSlot < 0) {
      fprintf(stderr, "stage3d_d3d: out of DSV descriptors (%d)\n", S3D_MAX_DSV);
    } else {
      c->device->CreateDepthStencilView(t->res, &dd, s3d_dsv_cpu(c, t->dsvSlot));
      t->isDepth = 1;
    }
  }
  return t;
}

static void s3d_free_texture(S3DContext* c, S3DTexture* t) {
  if (t == NULL) return;
  if (s3d_env("ASC_S3D_LIFE")) fprintf(stderr, "s3d(life) free_texture t=%p res=%p\n", (void*)t, (void*)t->res);
  s3d_release_rtv(c, t->rtvSlot);
  s3d_release_dsv(c, t->dsvSlot);
  // The resource may still be referenced by an in-flight submission.
  s3d_defer_release(c, (IUnknown*)t->res);
  free(t);
}

// Copy a CPU ARGB buffer into one subresource of a texture. ARGB
// (BitmapData.pixels, 0xAARRGGBB) has B,G,R,A byte order on a little-endian host,
// which is exactly DXGI_FORMAT_B8G8R8A8_UNORM's layout, so an upload is a row copy
// with only the pitch changing (D3D12 requires a 256-byte aligned row pitch).
// `srcW` is the source row stride in PIXELS (>= w).
static int s3d_upload_region(S3DContext* c, S3DTexture* t, int subres,
                             int w, int h, const uint32_t* src, int srcW) {
  if (t == NULL || src == NULL || w <= 0 || h <= 0 || srcW < w) return 0;
  const UINT rowPitch = s3d_align256((UINT)w * 4u);
  const UINT bytes = rowPitch * (UINT)h;

  D3D12_HEAP_PROPERTIES hp = {};
  hp.Type = D3D12_HEAP_TYPE_UPLOAD;
  D3D12_RESOURCE_DESC bd = {};
  bd.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
  bd.Width = bytes;
  bd.Height = 1;
  bd.DepthOrArraySize = 1;
  bd.MipLevels = 1;
  bd.SampleDesc.Count = 1;
  bd.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
  ID3D12Resource* up = NULL;
  if (FAILED(c->device->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &bd,
                                                D3D12_RESOURCE_STATE_GENERIC_READ, NULL,
                                                __uuidof(ID3D12Resource), (void**)&up)))
    return 0;
  void* map = NULL;
  D3D12_RANGE rr = { 0, 0 };
  if (FAILED(up->Map(0, &rr, &map)) || map == NULL) { up->Release(); return 0; }
  for (int j = 0; j < h; j++) {
    memcpy((uint8_t*)map + (size_t)j * rowPitch,
           (const uint8_t*)src + (size_t)j * (size_t)srcW * 4u,
           (size_t)w * 4u);
  }
  up->Unmap(0, NULL);

  if (FAILED(c->upAlloc->Reset())) { up->Release(); return 0; }
  if (FAILED(c->upList->Reset(c->upAlloc, NULL))) { up->Release(); return 0; }
  // The upload writes a resource an in-flight batch may still sample, so the GPU
  // has to be settled first: s3d_run_immediate waits, and the wait must happen
  // BEFORE the copy is recorded (a barrier out of a state a live batch has yet to
  // leave would corrupt it).
  s3d_wait_idle(c);
  if (t->state != D3D12_RESOURCE_STATE_COPY_DEST) {
    D3D12_RESOURCE_BARRIER b = {};
    b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    b.Transition.pResource = t->res;
    b.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    b.Transition.StateBefore = t->state;
    b.Transition.StateAfter = D3D12_RESOURCE_STATE_COPY_DEST;
    c->upList->ResourceBarrier(1, &b);
    t->state = D3D12_RESOURCE_STATE_COPY_DEST;
  }
  D3D12_TEXTURE_COPY_LOCATION dst = {};
  dst.pResource = t->res;
  dst.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
  dst.SubresourceIndex = (UINT)subres;
  D3D12_TEXTURE_COPY_LOCATION srcL = {};
  srcL.pResource = up;
  srcL.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
  srcL.PlacedFootprint.Offset = 0;
  srcL.PlacedFootprint.Footprint.Format = t->format;
  srcL.PlacedFootprint.Footprint.Width = (UINT)w;
  srcL.PlacedFootprint.Footprint.Height = (UINT)h;
  srcL.PlacedFootprint.Footprint.Depth = 1;
  srcL.PlacedFootprint.Footprint.RowPitch = rowPitch;
  c->upList->CopyTextureRegion(&dst, 0, 0, 0, &srcL, NULL);
  {
    D3D12_RESOURCE_BARRIER b = {};
    b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    b.Transition.pResource = t->res;
    b.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    b.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_DEST;
    b.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
    c->upList->ResourceBarrier(1, &b);
    t->state = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
  }
  const int ok = s3d_run_immediate(c);
  up->Release();
  return ok;
}

// CPU box-filter mip generation for cube maps. Metal builds the chain with
// generateMipmapsForTexture (a GPU blit); D3D12 has no such API call, and a cube
// sampled with mip filtering while carrying NO chain would take AIR's
// drop-the-draw rule -- so the chain is built here, with the same straight 2x2
// average AIR's own MipmapGenerator uses (MipmapGenerator.as). Runs once per cube
// upload, at load time.
static void s3d_cube_mips(uint32_t* levels[16], int nlv, int size) {
  for (int l = 1; l < nlv; l++) {
    const int pw = size >> (l - 1);
    const int cw = size >> l;
    const uint32_t* prev = levels[l - 1];
    uint32_t* cur = levels[l];
    for (int y = 0; y < cw; y++) {
      for (int x = 0; x < cw; x++) {
        unsigned a = 0, r = 0, g = 0, b = 0;
        for (int dy = 0; dy < 2; dy++) {
          for (int dx = 0; dx < 2; dx++) {
            const int px = x * 2 + dx, py = y * 2 + dy;
            uint32_t p = 0;
            if (px < pw && py < pw) p = prev[(size_t)py * (size_t)pw + (size_t)px];
            a += (p >> 24) & 0xFFu;
            r += (p >> 16) & 0xFFu;
            g += (p >> 8) & 0xFFu;
            b += p & 0xFFu;
          }
        }
        cur[(size_t)y * (size_t)cw + (size_t)x] =
            ((a / 4u) << 24) | ((r / 4u) << 16) | ((g / 4u) << 8) | (b / 4u);
      }
    }
  }
}

// ---- state -> D3D12 --------------------------------------------------------
// Stage3D exposes its state through AS3 enum *strings* (Context3DCompareMode,
// Context3DStencilAction, Context3DTriangleFace, Context3DBlendFactor); the string
// values handled below are the ones Context3D's setters forward (verified against
// adl on the Metal side) -- e.g. "lessEqual", "incrementSaturate",
// "frontAndBack", "oneMinusSourceAlpha".
static D3D12_COMPARISON_FUNC s3d_compare(const char* name) {
  if (name == NULL) return D3D12_COMPARISON_FUNC_ALWAYS;
  if (!strcmp(name, "never")) return D3D12_COMPARISON_FUNC_NEVER;
  if (!strcmp(name, "less")) return D3D12_COMPARISON_FUNC_LESS;
  if (!strcmp(name, "equal")) return D3D12_COMPARISON_FUNC_EQUAL;
  if (!strcmp(name, "lessEqual")) return D3D12_COMPARISON_FUNC_LESS_EQUAL;
  if (!strcmp(name, "greater")) return D3D12_COMPARISON_FUNC_GREATER;
  if (!strcmp(name, "notEqual")) return D3D12_COMPARISON_FUNC_NOT_EQUAL;
  if (!strcmp(name, "greaterEqual")) return D3D12_COMPARISON_FUNC_GREATER_EQUAL;
  return D3D12_COMPARISON_FUNC_ALWAYS;
}
static D3D12_STENCIL_OP s3d_stencil_op(const char* name) {
  if (name == NULL) return D3D12_STENCIL_OP_KEEP;
  if (!strcmp(name, "keep")) return D3D12_STENCIL_OP_KEEP;
  if (!strcmp(name, "zero")) return D3D12_STENCIL_OP_ZERO;
  if (!strcmp(name, "replace")) return D3D12_STENCIL_OP_REPLACE;
  // Stage3D's SET writes the reference value, which is exactly REPLACE.
  if (!strcmp(name, "set")) return D3D12_STENCIL_OP_REPLACE;
  if (!strcmp(name, "incrementSaturate")) return D3D12_STENCIL_OP_INCR_SAT;
  if (!strcmp(name, "decrementSaturate")) return D3D12_STENCIL_OP_DECR_SAT;
  if (!strcmp(name, "invert")) return D3D12_STENCIL_OP_INVERT;
  if (!strcmp(name, "incrementWrap")) return D3D12_STENCIL_OP_INCR;
  if (!strcmp(name, "decrementWrap")) return D3D12_STENCIL_OP_DECR;
  return D3D12_STENCIL_OP_KEEP;
}
static D3D12_BLEND s3d_blend_factor(const char* name) {
  if (name == NULL) return D3D12_BLEND_ONE;
  if (!strcmp(name, "zero")) return D3D12_BLEND_ZERO;
  if (!strcmp(name, "one")) return D3D12_BLEND_ONE;
  if (!strcmp(name, "sourceColor")) return D3D12_BLEND_SRC_COLOR;
  if (!strcmp(name, "oneMinusSourceColor")) return D3D12_BLEND_INV_SRC_COLOR;
  if (!strcmp(name, "sourceAlpha")) return D3D12_BLEND_SRC_ALPHA;
  if (!strcmp(name, "oneMinusSourceAlpha")) return D3D12_BLEND_INV_SRC_ALPHA;
  if (!strcmp(name, "destinationColor")) return D3D12_BLEND_DEST_COLOR;
  if (!strcmp(name, "oneMinusDestinationColor")) return D3D12_BLEND_INV_DEST_COLOR;
  if (!strcmp(name, "destinationAlpha")) return D3D12_BLEND_DEST_ALPHA;
  if (!strcmp(name, "oneMinusDestinationAlpha")) return D3D12_BLEND_INV_DEST_ALPHA;
  return D3D12_BLEND_ONE;
}
// Translate a colour blend factor to its alpha twin, for the ALPHA slots of the
// blend state. D3D12 (like D3D11) forbids a *_COLOR factor there: the alpha blend
// unit can only reach the alpha channels, so "destinationColor" in an alpha slot is
// an invalid enum and CreateGraphicsPipelineState rejects the WHOLE pipeline with
// E_INVALIDARG (0x80070057). The debug layer says so explicitly:
//   "SrcBlendAlpha[0] is trying to use a D3D11_BLEND value (0x9) that manipulates
//    color, which is invalid"
// Stage3D has ONE factor pair for both channels, so the translation is the only
// way to express the same blend on D3D12 -- and it is semantically required, not
// just a workaround: ERASE (ZERO / ONE_MINUS_SOURCE_ALPHA) only erases when the
// alpha of the erased texel actually reaches 0 instead of keeping the
// destination's (Starling erases a RenderTexture this way).
static D3D12_BLEND s3d_blend_factor_alpha(D3D12_BLEND b) {
  if (b == D3D12_BLEND_SRC_COLOR) return D3D12_BLEND_SRC_ALPHA;
  if (b == D3D12_BLEND_INV_SRC_COLOR) return D3D12_BLEND_INV_SRC_ALPHA;
  if (b == D3D12_BLEND_DEST_COLOR) return D3D12_BLEND_DEST_ALPHA;
  if (b == D3D12_BLEND_INV_DEST_COLOR) return D3D12_BLEND_INV_DEST_ALPHA;
  return b;
}
static UINT s3d_write_mask_bits(const S3DContext* c) {
  UINT m = 0;
  if (c->colorMaskR) m |= D3D12_COLOR_WRITE_ENABLE_RED;
  if (c->colorMaskG) m |= D3D12_COLOR_WRITE_ENABLE_GREEN;
  if (c->colorMaskB) m |= D3D12_COLOR_WRITE_ENABLE_BLUE;
  if (c->colorMaskA) m |= D3D12_COLOR_WRITE_ENABLE_ALPHA;
  return m;
}
// Whether the draw needs a depth/stencil attachment at all. Attaching one costs a
// full D24S8 load/store, and Stage3D issues tens of thousands of draws per second,
// so a draw whose state can neither read nor write it gets a pipeline without it
// (mirrors stage3d_glue.mm's dsNeeded). A missing depth texture (no
// <depthAndStencil> in the descriptor, so ASC_RENDER_DEPTH_STENCIL is off) makes
// every draw such a draw: D3D12 forbids depth testing against no attachment.
static int s3d_ds_needed(const S3DContext* c) {
  if (c->depth == NULL && c->rtDepth == NULL) return 0;
  if (c->depthCompare != NULL && strcmp(c->depthCompare, "always") != 0) return 1;
  if (c->stencilCompare != NULL && strcmp(c->stencilCompare, "always") != 0) return 1;
  if (c->stencilBothPass != NULL && strcmp(c->stencilBothPass, "keep") != 0) return 1;
  return 0;
}

// ---- programs & pipelines --------------------------------------------------

static S3DProg* s3d_live_prog(S3DContext* c) {
  if (c->live == S3D_LIVE_KEYLESS) return &c->keyless;
  if (c->live >= 0 && c->live < c->nprogs) return &c->progs[c->live];
  return NULL;
}

static void s3d_prog_release(S3DProg* e) {
  if (e->vs) { e->vs->Release(); e->vs = NULL; }
  if (e->ps) { e->ps->Release(); e->ps = NULL; }
  for (int i = 0; i < e->npso; i++) {
    if (e->pso[i].pso) e->pso[i].pso->Release();
    e->pso[i].pso = NULL;
  }
  e->npso = 0;
}

// Build (or fetch) the pipeline for the state currently recorded on the context.
// The key is the WHOLE draw state -- see the file header for why D3D12 needs this
// where Metal had a separate MTLDepthStencilState.
//
// The blend part of the key is the FACTOR PAIR, not "blending on/off": D3D12,
// like Metal and unlike GL, has no per-draw blend-factor call, so the pair is
// baked into the pipeline state and a *changed* pair needs a *new* pipeline. The
// key used to carry only (blendSource != NULL || blendDest != NULL), so the first
// pair a program was ever drawn with -- Starling's "normal", ONE /
// ONE_MINUS_SOURCE_ALPHA, which the frame's background establishes -- was reused
// for every later pair. Measured on examples/air-starling-demo's Blend Modes
// scene: five "Switch Mode" presses moved 0.3% of the pixels and every one of
// them was the label (the image never changed) -- the very symptom stage3d_glue.mm
// records for Metal in its own header.
static ID3D12PipelineState* s3d_select_pso(S3DContext* c, S3DProg* pr) {
  const int dsNeeded = s3d_ds_needed(c);
  unsigned streamSig = 0;
  for (int i = 0; i < S3D_MAX_STREAMS; i++)
    streamSig |= (unsigned)((c->streams[i].components & 7) << (i * 3));

  char sk[S3D_KEY_CAP];
  snprintf(sk, sizeof sk,
           "%016llx|%x|%d|%s|%s|%s|%s|%s|%s|%d|%d|%d|%s|%d|%s|%s|%x",
           (unsigned long long)(pr ? pr->srcHash : 0),
           s3d_write_mask_bits(c),
           c->depthWrite ? 1 : 0,
           c->depthCompare ? c->depthCompare : "",
           c->stencilFace ? c->stencilFace : "",
           c->stencilCompare ? c->stencilCompare : "",
           c->stencilBothPass ? c->stencilBothPass : "",
           c->stencilDepthFail ? c->stencilDepthFail : "",
           c->stencilDepthPassStencilFail ? c->stencilDepthPassStencilFail : "",
           (int)c->stencilReadMask, (int)c->stencilWriteMask,
           dsNeeded,
           c->cullMode ? c->cullMode : "",
           // Both: the boolean still distinguishes "blending off" (NULL/NULL) from
           // an empty factor name, which maps to ONE/ONE (see s3d_blend_factor).
           (int)(c->blendSource != NULL || c->blendDest != NULL),
           c->blendSource ? c->blendSource : "",
           c->blendDest ? c->blendDest : "",
           streamSig);

  for (int i = 0; i < pr->npso; i++) {
    if (strcmp(pr->pso[i].key, sk) == 0) {
      pr->pso[i].stamp = ++c->progstamp;
      return pr->pso[i].pso;
    }
  }

  D3D12_GRAPHICS_PIPELINE_STATE_DESC pd = {};
  pd.pRootSignature = c->rootSig;
  pd.VS.pShaderBytecode = pr->vs->GetBufferPointer();
  pd.VS.BytecodeLength = pr->vs->GetBufferSize();
  pd.PS.pShaderBytecode = pr->ps->GetBufferPointer();
  pd.PS.BytecodeLength = pr->ps->GetBufferSize();
  pd.SampleMask = 0xFFFFFFFFu;

  pd.BlendState.AlphaToCoverageEnable = FALSE;
  pd.BlendState.IndependentBlendEnable = FALSE;
  D3D12_RENDER_TARGET_BLEND_DESC* rt = &pd.BlendState.RenderTarget[0];
  rt->RenderTargetWriteMask = (UINT8)s3d_write_mask_bits(c);
  rt->BlendOp = D3D12_BLEND_OP_ADD;
  rt->BlendOpAlpha = D3D12_BLEND_OP_ADD;
  rt->LogicOpEnable = FALSE;
  if (c->blendSource != NULL || c->blendDest != NULL) {
    const D3D12_BLEND sf = s3d_blend_factor(c->blendSource);
    const D3D12_BLEND df = s3d_blend_factor(c->blendDest);
    rt->BlendEnable = TRUE;
    rt->SrcBlend = sf;
    rt->DestBlend = df;
    // Stage3D has ONE factor pair for both channels -- the Metal backend hands the
    // same factor to both colour-attachment slots and Metal accepts that. D3D12
    // does NOT, so a colour factor must go through s3d_blend_factor_alpha here.
    // Measured failure without it (adl 51.4.1 as the oracle, named by the D3D12
    // debug layer): Starling's Multiply (destinationColor / oneMinusSourceAlpha) and
    // Screen (one / oneMinusSourceColor) modes built NO pipeline and therefore
    // dropped EVERY draw -- the Blend Modes demo cycled its label while the image
    // never changed at all.
    rt->SrcBlendAlpha = s3d_blend_factor_alpha(sf);
    rt->DestBlendAlpha = s3d_blend_factor_alpha(df);
  } else {
    // Stage3D's initial state is (ONE, ZERO) -- "no blending" expressed as a blend.
    rt->BlendEnable = FALSE;
    rt->SrcBlend = D3D12_BLEND_ONE;
    rt->DestBlend = D3D12_BLEND_ZERO;
    rt->SrcBlendAlpha = D3D12_BLEND_ONE;
    rt->DestBlendAlpha = D3D12_BLEND_ZERO;
  }

  pd.RasterizerState = s3d_raster_desc(c->cullMode);

  D3D12_DEPTH_STENCIL_DESC* ds = &pd.DepthStencilState;
  ds->DepthEnable = dsNeeded ? TRUE : FALSE;
  ds->DepthWriteMask = (dsNeeded && c->depthWrite) ? D3D12_DEPTH_WRITE_MASK_ALL
                                                  : D3D12_DEPTH_WRITE_MASK_ZERO;
  ds->DepthFunc = s3d_compare(c->depthCompare);
  ds->StencilEnable = (dsNeeded && c->stencilCompare != NULL) ? TRUE : FALSE;
  ds->StencilReadMask = (UINT8)(c->stencilReadMask & 0xFFu);
  ds->StencilWriteMask = (UINT8)(c->stencilWriteMask & 0xFFu);
  const D3D12_STENCIL_OP sFail = s3d_stencil_op(c->stencilDepthPassStencilFail);
  const D3D12_STENCIL_OP dpFail = s3d_stencil_op(c->stencilDepthFail);
  const D3D12_STENCIL_OP dPass = s3d_stencil_op(c->stencilBothPass);
  const D3D12_COMPARISON_FUNC sCmp = s3d_compare(c->stencilCompare);
  ds->FrontFace.StencilFunc = sCmp;
  ds->FrontFace.StencilFailOp = sFail;
  ds->FrontFace.StencilDepthFailOp = dpFail;
  ds->FrontFace.StencilPassOp = dPass;
  ds->BackFace = ds->FrontFace;
  // Context3DTriangleFace selects which face the stencil test touches; D3D12 has
  // separate front/back descriptors, so the unselected face keeps the pass-through
  // state ("always", KEEP) -- exactly how stage3d_glue.mm mirrors it onto both
  // faces. "frontAndBack" (Stage3D's default) leaves both faces identical.
  if (c->stencilFace != NULL && strcmp(c->stencilFace, "front") == 0) {
    ds->BackFace.StencilFunc = D3D12_COMPARISON_FUNC_ALWAYS;
    ds->BackFace.StencilPassOp = D3D12_STENCIL_OP_KEEP;
    ds->BackFace.StencilFailOp = D3D12_STENCIL_OP_KEEP;
    ds->BackFace.StencilDepthFailOp = D3D12_STENCIL_OP_KEEP;
  } else if (c->stencilFace != NULL && strcmp(c->stencilFace, "back") == 0) {
    ds->FrontFace.StencilFunc = D3D12_COMPARISON_FUNC_ALWAYS;
    ds->FrontFace.StencilPassOp = D3D12_STENCIL_OP_KEEP;
    ds->FrontFace.StencilFailOp = D3D12_STENCIL_OP_KEEP;
    ds->FrontFace.StencilDepthFailOp = D3D12_STENCIL_OP_KEEP;
  }

  // Input layout: attribute i at slot i, semantic "TEXCOORD" + INDEX i -- exactly
  // the `VSIn` the AGAL->HLSL translator emits (`float4 aN : TEXCOORDN`; HLSL reads
  // TEXCOORDN as the semantic name "TEXCOORD" with semantic index N). D3D12 REJECTS
  // the literal string "TEXCOORD0": "SemanticName string cannot end with a number.
  // Instead, use the number in the SemanticIndex field" -- CreateInputLayout returns
  // E_INVALIDARG (found with temp/psoprobe.cc + the D3D12 debug layer). A stream
  // with fewer than 4 components leaves the unused lanes at D3D's defaults
  // (z=0, w=1), which is AGAL's own float4 padding. Extra elements the shader
  // does not declare are legal and simply not fetched.
  static const char* const SEM = "TEXCOORD";
  D3D12_INPUT_ELEMENT_DESC elems[S3D_MAX_STREAMS];
  UINT nelem = 0;
  for (int i = 0; i < S3D_MAX_STREAMS; i++) {
    const int comp = c->streams[i].components;
    if (comp <= 0) continue;
    elems[nelem].SemanticName = SEM;
    elems[nelem].SemanticIndex = (UINT)i;
    switch (comp) {
      case 1: elems[nelem].Format = DXGI_FORMAT_R32_FLOAT; break;
      case 2: elems[nelem].Format = DXGI_FORMAT_R32G32_FLOAT; break;
      case 3: elems[nelem].Format = DXGI_FORMAT_R32G32B32_FLOAT; break;
      default: elems[nelem].Format = DXGI_FORMAT_R32G32B32A32_FLOAT; break;
    }
    elems[nelem].InputSlot = (UINT)i;
    elems[nelem].AlignedByteOffset = 0;
    elems[nelem].InputSlotClass = D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA;
    elems[nelem].InstanceDataStepRate = 0;
    nelem++;
  }
  pd.InputLayout.pInputElementDescs = nelem ? elems : NULL;
  pd.InputLayout.NumElements = nelem;
  pd.IBStripCutValue = D3D12_INDEX_BUFFER_STRIP_CUT_VALUE_DISABLED;
  pd.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
  pd.NumRenderTargets = 1;
  pd.RTVFormats[0] = DXGI_FORMAT_B8G8R8A8_UNORM;
  pd.DSVFormat = dsNeeded ? DXGI_FORMAT_D24_UNORM_S8_UINT : DXGI_FORMAT_UNKNOWN;
  pd.SampleDesc.Count = 1;
  pd.NodeMask = 0;
  pd.Flags = D3D12_PIPELINE_STATE_FLAG_NONE;

  ID3D12PipelineState* pso = NULL;
  const HRESULT hr = c->device->CreateGraphicsPipelineState(&pd, __uuidof(ID3D12PipelineState), (void**)&pso);
  if (FAILED(hr) || pso == NULL) {
    // A PSO that cannot be built means the draw cannot be encoded at all, so this
    // must be loud rather than a silent black frame.
    fprintf(stderr, "stage3d_d3d: CreateGraphicsPipelineState failed: 0x%08lx (key=%s)\n",
            (unsigned long)hr, sk);
    fflush(stderr);
    return NULL;
  }
  c->statPsos++;
  int idx;
  if (pr->npso < S3D_MAX_PSOVAR) {
    idx = pr->npso++;
  } else {
    idx = 0;
    for (int i = 1; i < pr->npso; i++) if (pr->pso[i].stamp < pr->pso[idx].stamp) idx = i;
    if (pr->pso[idx].pso) pr->pso[idx].pso->Release();
  }
  s3d_key_str(pr->pso[idx].key, sizeof pr->pso[idx].key, sk);
  pr->pso[idx].pso = pso;
  pr->pso[idx].stamp = ++c->progstamp;
  return pso;
}

// ---- render target binding -------------------------------------------------

static S3DTexture* s3d_cur_target(S3DContext* c) {
  return c->renderOverride != NULL ? c->renderOverride : c->target;
}

// Make `t` the render target of the open command list: transition it in, bind its
// RTV (plus the DSV when the draw needs one) and remember it, so the barrier out is
// emitted exactly once at the batch's end.
static void s3d_bind_target(S3DContext* c, S3DTexture* t, int dsNeeded) {
  if (t == NULL) return;
  if (c->boundRT != t) {
    if (c->boundRT != NULL && c->boundRT->state == D3D12_RESOURCE_STATE_RENDER_TARGET) {
      D3D12_RESOURCE_BARRIER b = {};
      b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
      b.Transition.pResource = c->boundRT->res;
      b.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
      b.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
      b.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
      c->list->ResourceBarrier(1, &b);
      c->boundRT->state = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
    }
    if (t->state != D3D12_RESOURCE_STATE_RENDER_TARGET) {
      D3D12_RESOURCE_BARRIER b = {};
      b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
      b.Transition.pResource = t->res;
      b.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
      b.Transition.StateBefore = t->state;
      b.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
      c->list->ResourceBarrier(1, &b);
      t->state = D3D12_RESOURCE_STATE_RENDER_TARGET;
    }
    c->boundRT = t;
    c->boundDs = -1;
  }
  if (c->boundDs != dsNeeded) {
    S3DTexture* ds = dsNeeded ? (c->renderOverride != NULL ? c->rtDepth : c->depth) : NULL;
    D3D12_CPU_DESCRIPTOR_HANDLE rtv = s3d_rtv_cpu(c, t->rtvSlot);
    if (ds != NULL && ds->dsvSlot >= 0) {
      D3D12_CPU_DESCRIPTOR_HANDLE dsv = s3d_dsv_cpu(c, ds->dsvSlot);
      c->list->OMSetRenderTargets(1, &rtv, FALSE, &dsv);
      c->boundDs = 1;
    } else {
      c->list->OMSetRenderTargets(1, &rtv, FALSE, NULL);
      c->boundDs = 0;
    }
  }
}

// ---- lifecycle -------------------------------------------------------------

// Create the process-wide command objects. The device and queue come from
// d3d_glue.cc when the window GPU backend is linked (so the composite and Stage3D
// share one queue), and are created here otherwise -- a headless app that only ever
// reads its render target back.
static int s3d_init_backend(S3DContext* c) {
  SkD3DDeviceFn devFn = (SkD3DDeviceFn)s3d_lookup_export("sk_d3d_shared_device");
  SkD3DQueueFn qFn = (SkD3DQueueFn)s3d_lookup_export("sk_d3d_shared_queue");
  if (devFn != NULL && qFn != NULL) {
    c->device = devFn();
    c->queue = qFn();
  }
  if (c->device == NULL || c->queue == NULL) {
    c->device = NULL;
    c->queue = NULL;
    IDXGIFactory4* factory = NULL;
    if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory4), (void**)&factory)) || factory == NULL) {
      fprintf(stderr, "stage3d_d3d: no DXGI factory (and no shared D3D12 backend)\n");
      return 0;
    }
    IDXGIAdapter1* adapter = NULL;
    for (UINT i = 0;; i++) {
      IDXGIAdapter1* a = NULL;
      if (factory->EnumAdapters1(i, &a) == DXGI_ERROR_NOT_FOUND) break;
      if (a == NULL) break;
      if (SUCCEEDED(D3D12CreateDevice(a, D3D_FEATURE_LEVEL_11_0, __uuidof(ID3D12Device), NULL))) {
        adapter = a;
        break;
      }
      a->Release();
    }
    if (adapter == NULL) {
      fprintf(stderr, "stage3d_d3d: no adapter can create a Direct3D 12 device\n");
      factory->Release();
      return 0;
    }
    ID3D12Device* dev = NULL;
    if (SUCCEEDED(D3D12CreateDevice(adapter, D3D_FEATURE_LEVEL_11_0, __uuidof(ID3D12Device), (void**)&dev)) && dev != NULL) {
      D3D12_COMMAND_QUEUE_DESC qd = {};
      qd.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
      qd.Flags = D3D12_COMMAND_QUEUE_FLAG_NONE;
      ID3D12CommandQueue* q = NULL;
      if (FAILED(dev->CreateCommandQueue(&qd, __uuidof(ID3D12CommandQueue), (void**)&q))) q = NULL;
      if (q != NULL) {
        c->device = dev;
        c->queue = q;
        c->ownsBackend = 1;
      } else { dev->Release();
      }
    }
    adapter->Release();
    factory->Release();
    if (c->device == NULL) {
      fprintf(stderr, "stage3d_d3d: no Direct3D 12 device for Stage3D\n");
      return 0;
    }
    fprintf(stderr, "stage3d_d3d: no shared D3D12 backend found; created a PRIVATE device+queue "
                    "(frames will not composite on screen)\n");
    fflush(stderr);
  }

  for (int i = 0; i < S3D_FRAMES_IN_FLIGHT; i++) {
    const HRESULT hr = c->device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,
                                                         __uuidof(ID3D12CommandAllocator), (void**)&c->alloc[i]);
    if (FAILED(hr)) return s3d_init_fail("CreateCommandAllocator(frame slot)", hr);
  }
  HRESULT hr = c->device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,
                                                 __uuidof(ID3D12CommandAllocator), (void**)&c->upAlloc);
  if (FAILED(hr)) return s3d_init_fail("CreateCommandAllocator(upload)", hr);
  hr = c->device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, c->upAlloc, NULL,
                                    __uuidof(ID3D12GraphicsCommandList), (void**)&c->upList);
  if (FAILED(hr)) return s3d_init_fail("CreateCommandList(upload)", hr);
  c->upList->Close();
  hr = c->device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, c->alloc[0], NULL,
                                    __uuidof(ID3D12GraphicsCommandList), (void**)&c->list);
  if (FAILED(hr)) return s3d_init_fail("CreateCommandList(draw)", hr);
  c->list->Close();
  hr = c->device->CreateFence(0, D3D12_FENCE_FLAG_NONE, __uuidof(ID3D12Fence), (void**)&c->fence);
  if (FAILED(hr)) return s3d_init_fail("CreateFence", hr);
  c->fenceEvent = CreateEventA(NULL, FALSE, FALSE, NULL);
  if (c->fenceEvent == NULL) return s3d_init_fail("CreateEventA", (HRESULT)GetLastError());
  if (!s3d_make_heaps(c)) return 0;   // s3d_make_heaps reports its own failure
  return s3d_make_root_sig(c);        // ... and so does s3d_make_root_sig
}

// Cleanup for the fatal paths inside s3d_create (defined below).
void s3d_destroy(void* ctx);

static int s3d_ensure_cb(S3DContext* c, int slot, int isFragment, UINT need) {
  ID3D12Resource** slotRes = isFragment ? &c->fcBuf[slot] : &c->vcBuf[slot];
  void** slotMap = isFragment ? &c->fcMap[slot] : &c->vcMap[slot];
  const UINT have = isFragment ? c->fcBytes : c->vcBytes;
  if (*slotRes != NULL && have >= need) return 1;
  const UINT want = s3d_align256(need > S3D_CB_BYTES ? need : S3D_CB_BYTES);
  D3D12_HEAP_PROPERTIES hp = {};
  hp.Type = D3D12_HEAP_TYPE_UPLOAD;
  D3D12_RESOURCE_DESC bd = {};
  bd.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
  bd.Width = want;
  bd.Height = 1;
  bd.DepthOrArraySize = 1;
  bd.MipLevels = 1;
  bd.SampleDesc.Count = 1;
  bd.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
  ID3D12Resource* nb = NULL;
  if (FAILED(c->device->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &bd,
                                                D3D12_RESOURCE_STATE_GENERIC_READ, NULL,
                                                __uuidof(ID3D12Resource), (void**)&nb)))
    return 0;
  void* map = NULL;
  D3D12_RANGE rr = { 0, 0 };
  if (FAILED(nb->Map(0, &rr, &map)) || map == NULL) { nb->Release(); return 0; }
  if (*slotRes != NULL) s3d_defer_release(c, (IUnknown*)*slotRes);
  *slotRes = nb;
  *slotMap = map;
  if (isFragment) c->fcBytes = want; else c->vcBytes = want;
  return 1;
}

void* s3d_create(int width, int height) {
  S3DContext* c = (S3DContext*)calloc(1, sizeof(S3DContext));
  if (c == NULL) return NULL;
  c->width = width > 0 ? width : 1;
  c->height = height > 0 ? height : 1;
  c->live = S3D_LIVE_NONE;
  c->slot = 0;
  c->instanceCount = 1;
  c->clearR = c->clearG = c->clearB = 0.0f;
  c->clearA = 1.0f;
  c->clearPending = 1;   // first draw must clear the (fresh) target
  c->clearColor = 1;
  c->clearDepth = 1;
  c->clearStencil = 1;
  c->clearDepthValue = 1.0f;
  c->clearStencilValue = 0;
  c->stencilReadMask = 0xFF;
  c->stencilWriteMask = 0xFF;
  // Stage3D's initial state writes every colour channel: setColorMask is only
  // called by an app that wants to write less. Leaving this at calloc's 0 bakes
  // RenderTargetWriteMask = 0 into the pipeline, which D3D12 rejects outright
  // (CreateGraphicsPipelineState -> E_INVALIDARG, measured) -- where Metal's
  // MTLColorWriteMaskNone would have been legal but equally wrong.
  c->colorMaskR = 1;
  c->colorMaskG = 1;
  c->colorMaskB = 1;
  c->colorMaskA = 1;
  for (int i = 0; i < S3D_MAX_TEX; i++) {
    c->samplerFilter[i] = 0;
    c->samplerWrap[i] = 0;
    c->samplerMip[i] = 0;
  }
  if (!s3d_init_backend(c)) { fprintf(stderr, "stage3d_d3d: s3d_create(%d,%d) failed\n", width, height); fflush(stderr); free(c); return NULL; }

  c->target = s3d_make_texture(c, c->width, c->height, 1, 1, 1, 0);
  if (c->target == NULL) {
    fprintf(stderr, "stage3d_d3d: failed to create the render target\n");
    s3d_destroy((void*)c);
    return NULL;
  }
#ifdef ASC_RENDER_DEPTH_STENCIL
  // Mirrors stage3d_glue.mm: the depth/stencil surface exists only when the
  // descriptor asked for it (<depthAndStencil>), which is also what the GPU
  // backend's own depth attachment is keyed on.
  c->depth = s3d_make_texture(c, c->width, c->height, 1, 1, 0, 1);
  if (c->depth == NULL) fprintf(stderr, "stage3d_d3d: failed to create the depth/stencil target\n");
#endif
  // A 1x1 stand-in for sampler units that are not bound: every descriptor in a
  // bound table must be valid, and the shader only reads the units it declares.
  c->dummy = s3d_make_texture(c, 1, 1, 1, 1, 0, 0);

  // Establish the frame invariant for the fresh targets (and for the dummy, which
  // is never uploaded and would otherwise sit in COMMON): the target is handed to
  // sk_gpu_draw_texture as a PIXEL_SHADER_RESOURCE texture even before anything has
  // been drawn into it.
  if (SUCCEEDED(c->upAlloc->Reset()) && SUCCEEDED(c->upList->Reset(c->upAlloc, NULL))) {
    S3DTexture* firsts[3] = { c->target, c->depth, c->dummy };
    for (int i = 0; i < 3; i++) {
      if (firsts[i] == NULL) continue;
      D3D12_RESOURCE_BARRIER b = {};
      b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
      b.Transition.pResource = firsts[i]->res;
      b.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
      b.Transition.StateBefore = firsts[i]->state;
      b.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
      c->upList->ResourceBarrier(1, &b);
      firsts[i]->state = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
    }
    s3d_run_immediate(c);
  }
  for (int i = 0; i < S3D_FRAMES_IN_FLIGHT; i++) {
    s3d_ensure_cb(c, i, 0, S3D_CB_BYTES);
    s3d_ensure_cb(c, i, 1, S3D_CB_BYTES);
  }
  s3d_register_ctx(c);
  fprintf(stderr, "stage3d_d3d: context %dx%d ready (Direct3D 12)\n", c->width, c->height);
  fflush(stderr);
  return (void*)c;
}

void s3d_destroy(void* ctx) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  // Retire anything in flight before tearing the objects down: an unsubmitted
  // batch would be dropped, and its draws with it.
  s3d_batch_end(c, 1);
  s3d_unregister_ctx(c);

  // The stream and index buffers are BORROWED from the pool: releasing them here
  // would double-free (and leave dangling ubuf entries). The pool owns them all.
  for (int i = 0; i < c->nubuf; i++) if (c->ubuf[i].res) c->ubuf[i].res->Release();
  for (int i = 0; i < S3D_FRAMES_IN_FLIGHT; i++) {
    if (c->vcBuf[i]) c->vcBuf[i]->Release();
    if (c->fcBuf[i]) c->fcBuf[i]->Release();
  }
  if (c->rbBuf) c->rbBuf->Release();
  for (int i = 0; i < c->nprogs; i++) s3d_prog_release(&c->progs[i]);
  s3d_prog_release(&c->keyless);
  s3d_free_texture(c, c->target);
  s3d_free_texture(c, c->depth);
  s3d_free_texture(c, c->rtDepth);
  s3d_free_texture(c, c->dummy);
  // c->renderOverride and c->textures[i] are BORROWED: their lifetime belongs to
  // the AS texture object (released by s3d_destroy_texture).
  s3d_wait_idle(c);
  for (int i = 0; i < c->nrel; i++) c->rel[i].obj->Release();
  c->nrel = 0;
  if (c->rootSig) c->rootSig->Release();
  if (c->srvHeap) c->srvHeap->Release();
  if (c->smpHeap) c->smpHeap->Release();
  if (c->rtvHeap) c->rtvHeap->Release();
  if (c->dsvHeap) c->dsvHeap->Release();
  for (int i = 0; i < S3D_FRAMES_IN_FLIGHT; i++) if (c->alloc[i]) c->alloc[i]->Release();
  if (c->list) c->list->Release();
  if (c->upList) c->upList->Release();
  if (c->upAlloc) c->upAlloc->Release();
  if (c->fence) c->fence->Release();
  if (c->fenceEvent) CloseHandle(c->fenceEvent);
  if (c->ownsBackend) {
    if (c->queue) c->queue->Release();
    if (c->device) c->device->Release();
  }
  free(c);
}

int s3d_resize(void* ctx, int width, int height) {
  if (ctx == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  if (width <= 0 || height <= 0) return 0;
  if (width == c->width && height == c->height) return 1;
  s3d_batch_end(c, 1);
  c->width = width;
  c->height = height;
  S3DTexture* old = c->target;
  c->target = s3d_make_texture(c, width, height, 1, 1, 1, 0);
  if (c->target == NULL) {
    c->target = old;
    return 0;
  }
#ifdef ASC_RENDER_DEPTH_STENCIL
  S3DTexture* oldD = c->depth;
  c->depth = s3d_make_texture(c, width, height, 1, 1, 0, 1);
  if (c->depth == NULL) c->depth = oldD;
  else s3d_free_texture(c, oldD);
#endif
  // Re-establish the invariant for the new target before anything samples it.
  if (SUCCEEDED(c->upAlloc->Reset()) && SUCCEEDED(c->upList->Reset(c->upAlloc, NULL))) {
    D3D12_RESOURCE_BARRIER b = {};
    b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    b.Transition.pResource = c->target->res;
    b.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    b.Transition.StateBefore = c->target->state;
    b.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
    c->upList->ResourceBarrier(1, &b);
    c->target->state = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
    s3d_run_immediate(c);
  }
  s3d_unbind_texture_everywhere(old);
  s3d_free_texture(c, old);
  return 1;
}

// ---- buffers ---------------------------------------------------------------

// Allocate one pool entry of at least `bytes` capacity. Capacities are rounded to a
// POWER OF TWO: this workload grows monotonically (the benchmark's ring adds 16
// objects per frame), so an exact-size pool would find "nothing fits" on every single
// frame and re-create exactly the resource the pool exists to avoid creating. Waste is
// bounded by 2x on a 4 KB floor. A freed entry keeps its index so the `ub` fields in
// S3DStream stay valid.
static S3DUploadBuf* s3d_ubuf_new(S3DContext* c, UINT bytes) {
  int slot = -1;
  for (int i = 0; i < c->nubuf; i++) if (c->ubuf[i].res == NULL) { slot = i; break; }
  if (slot < 0) {
    if (c->nubuf >= S3D_UBUF_MAX) return NULL;
    slot = c->nubuf++;
  }
  UINT cap = 4096;
  while (cap < bytes) {
    if (cap > 0x40000000u) { cap = bytes; break; }
    cap <<= 1;
  }
  D3D12_HEAP_PROPERTIES hp = {};
  hp.Type = D3D12_HEAP_TYPE_UPLOAD;
  D3D12_RESOURCE_DESC bd = {};
  bd.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
  bd.Width = cap;
  bd.Height = 1;
  bd.DepthOrArraySize = 1;
  bd.MipLevels = 1;
  bd.SampleDesc.Count = 1;
  bd.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
  ID3D12Resource* res = NULL;
  if (FAILED(c->device->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &bd,
                                                D3D12_RESOURCE_STATE_GENERIC_READ, NULL,
                                                __uuidof(ID3D12Resource), (void**)&res))) {
    // Never silent (AGENTS.md 2.5): a failure here silently drops a vertex or index
    // buffer and the affected draws read garbage.
    fprintf(stderr, "stage3d_d3d: upload buffer (%u bytes) could not be created\n", (unsigned)cap);
    fflush(stderr);
    return NULL;
  }
  void* map = NULL;
  D3D12_RANGE rr = { 0, 0 };
  if (FAILED(res->Map(0, &rr, &map)) || map == NULL) {
    fprintf(stderr, "stage3d_d3d: upload buffer (%u bytes) could not be mapped\n", (unsigned)cap);
    fflush(stderr);
    res->Release();
    return NULL;
  }
  S3DUploadBuf* b = &c->ubuf[slot];
  b->res = res;              // stays mapped forever: the pool writes through b->map
  b->map = map;
  b->bytes = cap;
  b->fence = 0;
  b->pending = 0;
  return b;
}

// A buffer the batch being recorded already points at (bound to a stream, or the index
// stage) must never be handed out again.
static int s3d_ubuf_bound(S3DContext* c, ID3D12Resource* res) {
  if (res == NULL) return 1;
  for (int i = 0; i < S3D_MAX_STREAMS; i++)
    if (c->streams[i].buf == res) return 1;
  return c->indexBuffer == res;
}

static S3DUploadBuf* s3d_acquire_upload(S3DContext* c, UINT bytes) {
  if (bytes == 0) return NULL;
  const uint64_t done = c->fence != NULL ? c->fence->GetCompletedValue() : ~(uint64_t)0;
  S3DUploadBuf* best = NULL;
  for (int i = 0; i < c->nubuf; i++) {
    S3DUploadBuf* b = &c->ubuf[i];
    if (b->res == NULL || b->pending || b->bytes < bytes) continue;
    if (b->fence != 0 && b->fence > done) continue;
    if (s3d_ubuf_bound(c, b->res)) continue;
    if (best == NULL || b->bytes < best->bytes) best = b;   // smallest that fits
  }
  if (best != NULL) return best;
  int room = c->nubuf < S3D_UBUF_MAX;
  for (int i = 0; i < c->nubuf && !room; i++) if (c->ubuf[i].res == NULL) room = 1;
  if (room) return s3d_ubuf_new(c, bytes);   // ... which reports its own failure
  // Saturated. Retire everything already submitted and then drop the smallest entry
  // that is still too small for this request, so the pool is BOUNDED but also
  // self-cleaning: a workload whose buffers have grown past an older class would
  // otherwise sit on dead capacity for the rest of the run.
  s3d_wait_idle(c);
  if (c->fence != NULL) s3d_stamp_uploads(c, c->fenceNext);   // nothing is in flight now
  for (int i = 0; i < c->nubuf; i++) {
    S3DUploadBuf* e = &c->ubuf[i];
    if (e->res == NULL || e->pending || s3d_ubuf_bound(c, e->res)) continue;
    if (e->bytes >= bytes) return e;
  }
  for (int i = 0; i < c->nubuf; i++) {
    S3DUploadBuf* e = &c->ubuf[i];
    if (e->res == NULL || e->pending || s3d_ubuf_bound(c, e->res)) continue;
    if (e->bytes >= bytes) continue;
    e->res->Release();
    e->res = NULL;
    e->map = NULL;
    e->bytes = 0;
    e->pending = 0;
    e->fence = 0;
    return s3d_ubuf_new(c, bytes);
  }
  // Every entry is bound to a stream, a state no Stage3D program can reach: the
  // app holds S3D_MAX_STREAMS + 1 buffers at most. Report it, never fail silently.
  fprintf(stderr, "stage3d_d3d: upload pool saturated (%d buffers) for %u bytes\n",
          (int)S3D_UBUF_MAX, (unsigned)bytes);
  fflush(stderr);
  return NULL;
}

// Tie every buffer written since the last submit to the fence value that submission
// signed. Anything written before a submit is referenced by that submission (or a later
// one), so the value is always conservative -- and a buffer never referenced at all
// keeps fence 0, i.e. "the GPU has never seen me".
//
// NEVER stamps while a batch is open, which is what makes the rule above safe: a buffer
// written (or replaced) since the last submit is referenced by the OPEN batch, whose
// draws are recorded but NOT submitted, so no fence value can prove the GPU is finished
// with it. Stamping there hands the next upload a buffer whose contents the pending draw
// still reads. Measured on the Starling demo: the immediate list (texture uploads) stamped
// the first frame mid-batch, the next 12 button uploads all landed in ONE buffer, and 11
// of the 12 menu buttons vanished from every subsequent frame (Starling never re-uploads
// an unchanged QuadBatch, so the corrupted buffers survived the whole run).
static void s3d_stamp_uploads(S3DContext* c, uint64_t v) {
  if (c->listOpen) return;
  for (int i = 0; i < c->nubuf; i++)
    if (c->ubuf[i].pending) { c->ubuf[i].pending = 0; c->ubuf[i].fence = v; }
}

// The batch being recorded already holds this buffer's GPU virtual address, so it is
// not reusable until that batch's fence lands.
static void s3d_mark_batch_ref(S3DContext* c, int ub) {
  if (ub >= 0 && ub < c->nubuf && c->ubuf[ub].res != NULL) c->ubuf[ub].pending = 1;
}

int s3d_upload_vertex(void* ctx, int stream, const double* data, int numVertices, int components) {
  if (ctx == NULL || stream < 0 || stream >= S3D_MAX_STREAMS) return 0;
  S3DContext* c = (S3DContext*)ctx;
  if (components < 1 || components > 4 || numVertices <= 0 || data == NULL) return 0;
  const size_t n = (size_t)numVertices * (size_t)components;
  // Convert straight into the pooled buffer. The old code malloc'd a float copy first,
  // and at megabytes of vertices per frame that malloc + memcpy was itself a visible
  // part of the frame.
  S3DUploadBuf* b = s3d_acquire_upload(c, (UINT)(n * sizeof(float)));
  if (b == NULL) return 0;
  float* dst = (float*)b->map;
  for (size_t i = 0; i < n; i++) dst[i] = (float)data[i];
  b->pending = 1;
  if (c->listOpen && c->streams[stream].buf != NULL) s3d_mark_batch_ref(c, c->streams[stream].ub);
  c->streams[stream].buf = b->res;
  c->streams[stream].ub = (int)(b - c->ubuf);
  c->streams[stream].components = components;
  c->streams[stream].numVertices = numVertices;
  if (stream + 1 > c->numStreams) c->numStreams = stream + 1;
  return 1;
}

int s3d_upload_index(void* ctx, const uint32_t* data, int numIndices) {
  if (ctx == NULL || numIndices <= 0 || data == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  const size_t nbytes = (size_t)numIndices * sizeof(uint32_t);
  S3DUploadBuf* b = s3d_acquire_upload(c, (UINT)nbytes);
  if (b == NULL) return 0;
  memcpy(b->map, data, nbytes);
  b->pending = 1;
  if (c->listOpen && c->indexBuffer != NULL) s3d_mark_batch_ref(c, c->indexUb);
  c->indexBuffer = b->res;
  c->indexUb = (int)(b - c->ubuf);
  c->numIndices = numIndices;
  c->indexBytes = numIndices * 4;
  return 1;
}

int s3d_upload_constants(void* ctx, int isFragment, const double* data, int count) {
  if (ctx == NULL || count <= 0 || data == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  const UINT need = (UINT)count * 4u;
  if (need > S3D_CB_REGION) {
    // Loud, never silent (AGENTS.md 2.5): a file this large cannot fit one region,
    // and truncating it would hand the shader wrong constants. The AGAL constant
    // files are 256 registers, so this is unreachable with the generated C.
    fprintf(stderr, "stage3d_d3d: %s constants need %u bytes, one region holds %u\n",
            isFragment ? "fragment" : "vertex", need, (UINT)S3D_CB_REGION);
    fflush(stderr);
    return 0;
  }
  const int slot = c->slot;
  if (!s3d_ensure_cb(c, slot, isFragment, S3D_CB_BYTES)) return 0;
  UINT* cur = isFragment ? &c->cbCurF : &c->cbCurV;
  if (*cur + (UINT)S3D_CB_REGION > (UINT)S3D_CB_BYTES) {
    static int warned = 0;
    if (!warned) {
      warned = 1;
      fprintf(stderr, "stage3d_d3d: constant regions exhausted (%d uploads in one "
                      "frame) -- reusing the first region; the draws after this one "
                      "may read stale constants\n", S3D_DRAWS_PER_FRAME);
      fflush(stderr);
    }
    *cur = 0;
  }
  const UINT off = *cur;
  *cur = off + (UINT)S3D_CB_REGION;
  // The wait cannot be left to batch_begin: the FIRST upload of a frame happens
  // before anything opens the batch (the generated C uploads the register file
  // between the state setters and drawTriangles), so this is the only thing keeping
  // the CPU from overwriting a region the GPU may still be reading. For every later
  // upload of the same batch it is a no-op (the fence value is already satisfied).
  s3d_wait_slot(c, slot);
  float* dst = (float*)((char*)(isFragment ? c->fcMap[slot] : c->vcMap[slot]) + off);
  if (dst == NULL) return 0;
  const UINT n = need / 4u;
  for (UINT i = 0; i < n; i++) dst[i] = (float)data[i];
  if (isFragment) c->cbOffF = off; else c->cbOffV = off;
  return 1;
}

// ---- textures --------------------------------------------------------------

void* s3d_texture_from_pixels(void* ctx, int width, int height, const uint32_t* argb) {
  if (ctx == NULL || width <= 0 || height <= 0 || argb == NULL) return NULL;
  S3DContext* c = (S3DContext*)ctx;
  // The full mip chain is allocated up front: a D3D12 texture's descriptor is
  // immutable, so a level > 0 could otherwise never arrive later (which is how
  // away3d's MipmapGenerator uploads its chain, one level at a time). The cost is
  // 4/3 of the base image in VRAM, which Starling atlases pay whether or not they
  // ever sample a mip -- the same trade-off stage3d_glue.mm documents.
  int nlv = 1, dim = width > height ? width : height;
  while (dim > 1) { dim >>= 1; nlv++; }
  S3DTexture* t = s3d_make_texture(c, width, height, nlv, 1, 0, 0);
  if (t == NULL) return NULL;
  if (!s3d_upload_region(c, t, 0, width, height, argb, width)) {
    s3d_free_texture(c, t);
    return NULL;
  }
  t->hasChain = 0;   // freshly uploaded level 0 only
  return (void*)t;
}

void* s3d_upload_texture(void* ctx, int unit, int width, int height, const uint32_t* argb) {
  if (ctx == NULL || unit < 0 || unit >= S3D_MAX_TEX) return NULL;
  void* tex = s3d_texture_from_pixels(ctx, width, height, argb);
  if (tex != NULL) {
    S3DContext* c = (S3DContext*)ctx;
    c->textures[unit] = (S3DTexture*)tex;   // borrowed; the caller owns the handle
    c->texHasMips[unit] = 0;
  }
  return tex;
}

void s3d_texture_upload_level(void* ctx, void* tex, int level, int lw, int lh,
                              const uint32_t* src, int srcW) {
  if (ctx == NULL || tex == NULL || src == NULL) return;
  if (level <= 0 || lw <= 0 || lh <= 0 || srcW < lw) return;
  S3DContext* c = (S3DContext*)ctx;
  S3DTexture* t = (S3DTexture*)tex;
  if (level >= t->mips) return;
  // The REGION rule is measured, not assumed (temp/mipprobe, adl 51.4.1, T5): the
  // level gets the source's TOP-LEFT lw x lh rectangle, read with the SOURCE's row
  // stride. The probe's source is horizontal stripes grey(32r+16) and level 1 read
  // back as 16,48,80,112 -- exactly source rows 0..3 -- while the two alternatives
  // predict 16,16,48,48 (tightly packed first lw*lh pixels) and 32,96,160,224
  // (whole-source rescale). This is what makes away3d's MipmapGenerator work: it
  // re-uses ONE full-size scratch bitmap, re-scaling level i into that bitmap's
  // top-left (W>>i)x(H>>i) rectangle before upload (MipmapGenerator.as).
  if (s3d_upload_region(c, t, level, lw, lh, src, srcW)) t->hasChain = 1;
}

void* s3d_upload_cube_texture(void* ctx, int unit, int size, const uint32_t* const* argb) {
  if (ctx == NULL || unit < 0 || unit >= S3D_MAX_TEX || size <= 0 || argb == NULL) return NULL;
  S3DContext* c = (S3DContext*)ctx;
  int nlv = 1, dim = size;
  while (dim > 1) { dim >>= 1; nlv++; }
  if (nlv > 16) nlv = 16;
  S3DTexture* t = s3d_make_texture(c, size, size, nlv, 6, 0, 0);
  if (t == NULL) return NULL;
  uint32_t* levels[16] = {};
  for (int l = 0; l < nlv; l++) {
    const int d = size >> l;
    levels[l] = (uint32_t*)malloc(sizeof(uint32_t) * (size_t)d * (size_t)d);
    if (levels[l] == NULL) {
      for (int k = 0; k < l; k++) free(levels[k]);
      s3d_free_texture(c, t);
      return NULL;
    }
  }
  // AGAL/Stage3D face order is +X, -X, +Y, -Y, +Z, -Z, which is the slice order of
  // a D3D12 texture cube; subresource index = mip + slice * mipLevels.
  for (int face = 0; face < 6; face++) {
    if (argb[face] == NULL) {
      for (int l = 0; l < nlv; l++) free(levels[l]);
      s3d_free_texture(c, t);
      return NULL;
    }
    memcpy(levels[0], argb[face], sizeof(uint32_t) * (size_t)size * (size_t)size);
    s3d_cube_mips(levels, nlv, size);
    for (int l = 0; l < nlv; l++) {
      const int d = size >> l;
      if (!s3d_upload_region(c, t, l + face * nlv, d, d, levels[l], d)) {
        for (int k = 0; k < nlv; k++) free(levels[k]);
        s3d_free_texture(c, t);
        return NULL;
      }
    }
  }
  for (int l = 0; l < nlv; l++) free(levels[l]);
  t->hasChain = 1;         // the chain was built here
  c->textures[unit] = t;   // borrowed; the caller owns the handle
  c->texHasMips[unit] = 1;
  return (void*)t;
}

// ---- programs --------------------------------------------------------------

static int s3d_compile_stage(const char* src, const char* entry, const char* profile,
                             ID3DBlob** out, char* errbuf, int errbuf_size) {
  ID3DBlob* blob = NULL;
  ID3DBlob* errs = NULL;
  const HRESULT hr = D3DCompile(src, strlen(src), NULL, NULL, NULL, entry, profile, 0, 0, &blob, &errs);
  if (FAILED(hr) || blob == NULL) {
    const char* msg = (errs != NULL) ? (const char*)errs->GetBufferPointer() : "(no message)";
    fprintf(stderr, "stage3d_d3d: %s compile failed: %s\n", profile, msg);
    fflush(stderr);
    if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "%s: %s", profile, msg);
    if (errs) errs->Release();
    if (blob) blob->Release();
    return 0;
  }
  if (errs) errs->Release();
  *out = blob;
  return 1;
}

int s3d_compile(void* ctx, void* key, const char* vs_hlsl, const char* fs_hlsl,
                char* errbuf, int errbuf_size) {
  if (ctx == NULL || vs_hlsl == NULL || fs_hlsl == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  // FNV-1a over both sources: the Program3D pointer alone is not enough, because
  // Stage3D lets the SAME Program3D be re-uploaded with new bytecode
  // (Program3D.upload), which must recompile rather than silently reuse the stale
  // pipeline.
  unsigned long long h = 1469598103934665603ULL;
  for (const char* p = vs_hlsl; *p; p++) { h ^= (unsigned char)*p; h *= 1099511628211ULL; }
  h ^= 0xFFULL; h *= 1099511628211ULL;   // separator: vs and fs must not be confusable
  for (const char* p = fs_hlsl; *p; p++) { h ^= (unsigned char)*p; h *= 1099511628211ULL; }

  if (s3d_env("ASC_S3D_DUMP")) {
    fprintf(stderr, "=== HLSL VERTEX ===\n%s\n=== HLSL FRAGMENT ===\n%s\n=== END HLSL ===\n",
            vs_hlsl, fs_hlsl);
  }
  S3DProg* pr = NULL;
  if (key != NULL) {
    int idx = -1;
    for (int i = 0; i < c->nprogs; i++) if (c->progs[i].used && c->progs[i].key == key) { idx = i; break; }
    if (idx >= 0 && c->progs[idx].srcHash == h && c->progs[idx].vs != NULL && c->progs[idx].ps != NULL) {
      // Already compiled from exactly this source: bind it instead of rebuilding.
      c->live = idx;
      c->progs[idx].stamp = ++c->progstamp;
      return 1;
    }
    if (idx < 0) {
      if (c->nprogs < S3D_MAX_PROGRAMS) {
        idx = c->nprogs++;
        memset(&c->progs[idx], 0, sizeof(S3DProg));
      } else {
        idx = 0;
        for (int i = 1; i < c->nprogs; i++) if (c->progs[i].stamp < c->progs[idx].stamp) idx = i;
      }
    }
    s3d_prog_release(&c->progs[idx]);
    c->progs[idx].used = 1;
    c->progs[idx].key = key;
    c->progs[idx].srcHash = h;
    c->progs[idx].stamp = ++c->progstamp;
    pr = &c->progs[idx];
    c->live = idx;
  } else {
    // No identity to cache under (NULL key): the previous keyless program is
    // unreachable, so it is released rather than kept alive.
    s3d_prog_release(&c->keyless);
    pr = &c->keyless;
    c->live = S3D_LIVE_KEYLESS;
  }

  c->statCompiles++;
  if (!s3d_compile_stage(vs_hlsl, "vs_main", "vs_5_1", &pr->vs, errbuf, errbuf_size)) {
    c->live = S3D_LIVE_NONE;
    return 0;
  }
  if (!s3d_compile_stage(fs_hlsl, "fs_main", "ps_5_1", &pr->ps, errbuf, errbuf_size)) {
    if (pr->vs) { pr->vs->Release(); pr->vs = NULL; }
    c->live = S3D_LIVE_NONE;
    return 0;
  }
  return 1;
}

// ---- render state ----------------------------------------------------------

void s3d_clear(void* ctx, float r, float g, float b, float a, float depth,
               unsigned int stencil, int maskBits) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  c->clearR = r; c->clearG = g; c->clearB = b; c->clearA = a;
  c->clearDepthValue = depth;
  c->clearStencilValue = stencil & 0xFFu;
  // Stage3D's clear() is NOT an immediate clear; it records the colour and the next
  // drawTriangles applies it. Starling clears once per frame and then issues many
  // draws, so a per-draw clear would erase every previous batch.
  // The Context3DClearMask bits (COLOR=1/DEPTH=2/STENCIL=4) select which
  // attachments are cleared.
  c->clearPending = 1;
  c->clearColor = (maskBits & 1) ? 1 : 0;
  c->clearDepth = (maskBits & 2) ? 1 : 0;
  c->clearStencil = (maskBits & 4) ? 1 : 0;
}

// The setters below are called before EVERY batch, usually with the same values, so
// they return early when nothing changed; the state itself is baked into the
// pipeline the next draw selects, not applied here.
void s3d_set_depth(void* ctx, int depthMask, const char* compareMode) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  if (c->depthWrite == depthMask && s3d_streq(c->depthCompare, compareMode)) return;
  c->depthWrite = depthMask;
  c->depthCompare = compareMode;
}
void s3d_set_cull(void* ctx, const char* face) {
  if (ctx == NULL) return;
  ((S3DContext*)ctx)->cullMode = face;
}
void s3d_set_color_mask(void* ctx, int r, int g, int b, int a) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  c->colorMaskR = r ? 1 : 0;
  c->colorMaskG = g ? 1 : 0;
  c->colorMaskB = b ? 1 : 0;
  c->colorMaskA = a ? 1 : 0;
}
void s3d_set_stencil(void* ctx, const char* face, const char* compare, const char* bothPass,
                     const char* depthFail, const char* dpFail) {
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
}
void s3d_set_stencil_ref(void* ctx, unsigned int ref, unsigned int readMask, unsigned int writeMask) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  c->stencilRef = ref & 0xFFu;
  // Stage3D's read/write masks default to 8 bits all-ones, and a caller passing 0
  // means "unset" in practice (Starling never passes masks), so 0 keeps the value.
  c->stencilReadMask = (readMask != 0) ? (readMask & 0xFFu) : c->stencilReadMask;
  c->stencilWriteMask = (writeMask != 0) ? (writeMask & 0xFFu) : c->stencilWriteMask;
}
void s3d_set_sampler_state_i(void* ctx, int unit, int filter, int wrap, int mip) {
  if (ctx == NULL || unit < 0 || unit >= S3D_MAX_TEX) return;
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
// path (s3d_set_sampler_state_i, driven by Context3D_setProgram); they must share
// that storage -- whichever runs last wins, which is measured AIR behaviour
// (temp/sampprobe: a setSamplerStateAt after setProgram wins, one before loses).
void s3d_set_sampler_state(void* ctx, int unit, const char* wrap, const char* filter, const char* mipfilter) {
  int f = 0, w = 0, m = 0;
  if (filter != NULL && !strcmp(filter, "nearest")) f = 1;
  if (wrap != NULL && !strcmp(wrap, "repeat")) w = 1;
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
// Record the blend factors for the draws that follow. They take effect at the
// next draw, which selects the pipeline carrying this pair (s3d_select_pso) --
// Stage3D is a state machine and setBlendFactors may change between two draws
// that share one Program3D.
void s3d_set_blend(void* ctx, const char* sourceFactor, const char* destFactor) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  c->blendSource = sourceFactor;
  c->blendDest = destFactor;
}
void s3d_set_instance_count(void* ctx, int n) {
  if (ctx == NULL) return;
  ((S3DContext*)ctx)->instanceCount = n > 0 ? n : 1;
}

// ---- descriptors -----------------------------------------------------------

static void s3d_write_srv(S3DContext* c, UINT index, S3DTexture* t) {
  D3D12_CPU_DESCRIPTOR_HANDLE h = c->srvHeap->GetCPUDescriptorHandleForHeapStart();
  h.ptr += (SIZE_T)index * c->srvInc;
  if (t == NULL) t = c->dummy;
  D3D12_SHADER_RESOURCE_VIEW_DESC sd = {};
  sd.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
  sd.Format = t->format;
  if (t->faces == 6) {
    sd.ViewDimension = D3D12_SRV_DIMENSION_TEXTURECUBE;
    sd.TextureCube.MipLevels = (UINT)-1;
    sd.TextureCube.MostDetailedMip = 0;
  } else {
    sd.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
    sd.Texture2D.MipLevels = (UINT)-1;
    sd.Texture2D.MostDetailedMip = 0;
    sd.Texture2D.PlaneSlice = 0;
  }
  c->device->CreateShaderResourceView(t->res, &sd, h);
}
static void s3d_write_sampler(S3DContext* c, UINT index, int unit) {
  int filter = 0, wrap = 0, mip = 0;
  if (c->samplerStateSet[unit]) {
    filter = c->samplerFilter[unit];
    wrap = c->samplerWrap[unit];
    mip = c->samplerMip[unit];
  }
  D3D12_CPU_DESCRIPTOR_HANDLE h = c->smpHeap->GetCPUDescriptorHandleForHeapStart();
  h.ptr += (SIZE_T)index * c->smpInc;
  D3D12_SAMPLER_DESC sd = {};
  // D3D12 has no "mip filtering off" filter enum the way Metal has
  // MTLSamplerMipFilterNotMipmapped, so MIPNONE (Stage3D's default, and what the
  // AGAL `tex` flags encode as 0) is expressed by clamping MaxLOD to 0: every
  // sample then comes from level 0 whatever the derivatives say. That is also what
  // keeps a chain-less texture from being sampled out of its unwritten levels.
  if (mip == 0) {
    sd.Filter = (filter == 1) ? D3D12_FILTER_MIN_MAG_MIP_POINT : D3D12_FILTER_MIN_MAG_MIP_LINEAR;
    sd.MaxLOD = 0.0f;
  } else if (mip == 1) {
    sd.Filter = (filter == 1) ? D3D12_FILTER_MIN_MAG_MIP_POINT : D3D12_FILTER_MIN_MAG_LINEAR_MIP_POINT;
    sd.MaxLOD = 3.402823466e+38f;   // FLT_MAX
  } else {
    sd.Filter = (filter == 1) ? D3D12_FILTER_MIN_MAG_POINT_MIP_LINEAR : D3D12_FILTER_MIN_MAG_MIP_LINEAR;
    sd.MaxLOD = 3.402823466e+38f;
  }
  sd.AddressU = sd.AddressV = sd.AddressW =
      (wrap == 1) ? D3D12_TEXTURE_ADDRESS_MODE_WRAP : D3D12_TEXTURE_ADDRESS_MODE_CLAMP;
  sd.ComparisonFunc = D3D12_COMPARISON_FUNC_NEVER;
  sd.MinLOD = 0.0f;
  sd.MipLODBias = 0.0f;
  sd.MaxAnisotropy = 1;
  sd.BorderColor[0] = sd.BorderColor[1] = sd.BorderColor[2] = sd.BorderColor[3] = 0.0f;
  c->device->CreateSampler(&sd, h);
}

// Allocate the next 8-SRV / 8-sampler descriptor block of the current frame slot.
static UINT s3d_srv_block(S3DContext* c) {
  UINT base = c->srvCursor;
  if (base + S3D_MAX_TEX > c->srvSlotBase + S3D_DESCS_PER_FRAME) {
    static int warned = 0;
    if (!warned && s3d_env("ASC_S3D_DUMP")) {
      warned = 1;
      fprintf(stderr, "stage3d_d3d: descriptor arena full (%d texture-switching draws per "
                      "frame budget) -- reusing the frame's first block\n", S3D_DRAWS_PER_FRAME);
      fflush(stderr);
    }
    base = c->srvSlotBase;
  }
  c->srvCursor = base + S3D_MAX_TEX;
  return base;
}
static UINT s3d_smp_block(S3DContext* c, unsigned long long key) {
  for (int i = 0; i < c->smpCfgN; i++) if (c->smpCfgKey[i] == key) return c->smpCfgBase[i];
  if (c->smpCfgN >= S3D_MAX_SMPLCFG) {
    // Not silent (AGENTS.md 2.5): the heap cannot grow, so the draw is about to be
    // sampled with some other state's samplers. Unreachable in practice -- a frame
    // would have to use 256 different sampler-state vectors.
    static int warned = 0;
    if (!warned) {
      warned = 1;
      fprintf(stderr, "stage3d_d3d: sampler table cache full (%d distinct states) -- "
                      "reusing the first block; saved sampler state may be wrong\n",
              S3D_MAX_SMPLCFG);
      fflush(stderr);
    }
    return c->smpCfgBase[0];
  }
  const UINT base = (UINT)c->smpCfgN * S3D_MAX_TEX;
  for (int i = 0; i < S3D_MAX_TEX; i++) s3d_write_sampler(c, base + (UINT)i, i);
  c->smpCfgKey[c->smpCfgN] = key;
  c->smpCfgBase[c->smpCfgN] = base;
  c->smpCfgN++;
  return base;
}

// ---- draw ------------------------------------------------------------------

// Encode one draw into the frame's batch. Clears are applied here, because
// Stage3D's clear() only records the values.
int s3d_draw(void* ctx, int numTriangles) {
  if (ctx == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  if (numTriangles <= 0) return 0;

  // AIR fidelity: a mip-filtered sampler (miplinear/mipnearest) on a texture that
  // has NO mip chain makes AIR drop the entire draw -- the target keeps whatever was
  // there (measured in temp/sampprobe A6: a 2x2 level-0-only texture read back as
  // the clear colour, while the same texture with <2d,linear,nomip> drew normally).
  // Sampling level 0 with a clamped derivative instead would be a silent divergence
  // in the opposite direction: it renders an aliased image where AIR renders
  // nothing. Depth/stencil need no handling: they are only attached to a pass that
  // actually draws.
  for (int i = 0; i < S3D_MAX_TEX; i++) {
    if (c->samplerStateSet[i] && c->samplerMip[i] != 0 && c->texHasMips[i] == 0 &&
        c->textures[i] != NULL) {
      if (s3d_env("ASC_S3D_DUMP"))
        fprintf(stderr, "S3D(d3d) mip-drop: unit %d asks for mipmaps but the bound texture "
                        "has no chain (AIR drops the draw)\n", i);
      // AIR still clears the frame it dropped into (the A6 probe read back the clear
      // colour), so consume the pending COLOUR clear here instead of letting the
      // frame keep the previous frame's pixels when every draw in it is dropped.
      if (c->clearPending && c->clearColor && s3d_batch_begin(c)) {
        S3DTexture* t = s3d_cur_target(c);
        if (t != NULL && t->rtvSlot >= 0) {
          s3d_bind_target(c, t, 0);
          const float cc[4] = { c->clearR, c->clearG, c->clearB, c->clearA };
          c->list->ClearRenderTargetView(s3d_rtv_cpu(c, t->rtvSlot), cc, 0, NULL);
        }
        c->clearColor = 0;
        c->clearPending = 0;
      }
      return 0;
    }
  }

  S3DProg* pr = s3d_live_prog(c);
  if (pr == NULL || pr->vs == NULL || pr->ps == NULL) return 0;
  if (c->numStreams == 0) return 0;

  const int dsNeeded = s3d_ds_needed(c);
  ID3D12PipelineState* pso = s3d_select_pso(c, pr);
  if (pso == NULL) return 0;
  if (!s3d_batch_begin(c)) return 0;

  S3DTexture* t = s3d_cur_target(c);
  if (t == NULL || t->rtvSlot < 0) return 0;
  s3d_bind_target(c, t, dsNeeded);

  // Clear semantics, matching stage3d_glue.mm deliberately: the colour clear
  // applies to the first draw after clear() whatever the depth state is; the
  // depth/stencil clear is consumed by the first draw that actually ATTACHES the
  // depth buffer, so a scene whose first draw needs no depth still has depth
  // cleared before the first draw that does (AIR clears at clear() time, so this is
  // the reading that cannot lose the clear).
  if (c->clearPending && c->clearColor) {
    const float cc[4] = { c->clearR, c->clearG, c->clearB, c->clearA };
    c->list->ClearRenderTargetView(s3d_rtv_cpu(c, t->rtvSlot), cc, 0, NULL);
    c->clearColor = 0;
  }
  if (dsNeeded && (c->clearDepth || c->clearStencil)) {
    S3DTexture* ds = (c->renderOverride != NULL) ? c->rtDepth : c->depth;
    if (ds != NULL && ds->dsvSlot >= 0) {
      UINT fl = 0;
      if (c->clearDepth) fl |= D3D12_CLEAR_FLAG_DEPTH;
      if (c->clearStencil) fl |= D3D12_CLEAR_FLAG_STENCIL;
      c->list->ClearDepthStencilView(s3d_dsv_cpu(c, ds->dsvSlot),
                                     (D3D12_CLEAR_FLAGS)fl, c->clearDepthValue,
                                     (UINT8)c->clearStencilValue, 0, NULL);
    }
    c->clearDepth = 0;
    c->clearStencil = 0;
  }
  if (!c->clearColor && !c->clearDepth && !c->clearStencil) c->clearPending = 0;

  if (s3d_env("ASC_S3D_DUMP")) {
    fprintf(stderr, "S3DDRAW(d3d) tris=%d streams=%d depth=(%s,w=%d) cull=%s blend=(%s,%s) "
                    "cmask=%d%d%d%d cbV=%u cbF=%u\n", numTriangles, c->numStreams,
            c->depthCompare ? c->depthCompare : "null", c->depthWrite,
            c->cullMode ? c->cullMode : "null",
            c->blendSource ? c->blendSource : "null",
            c->blendDest ? c->blendDest : "null",
            c->colorMaskR, c->colorMaskG, c->colorMaskB, c->colorMaskA,
            (unsigned)c->cbOffV, (unsigned)c->cbOffF);
  }

  c->list->SetGraphicsRootSignature(c->rootSig);
  c->list->SetPipelineState(pso);

  D3D12_VIEWPORT vp = {};
  vp.Width = (float)t->width;
  vp.Height = (float)t->height;   // positive: no Y flip, like the Metal backend
  vp.MinDepth = 0.0f;
  vp.MaxDepth = 1.0f;
  D3D12_RECT sc = {};
  if (c->scissorOn) {
    int x = c->scissorX, y = c->scissorY, w = c->scissorW, h = c->scissorH;
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x > t->width) x = t->width;
    if (y > t->height) y = t->height;
    if (w < 0) w = 0;
    if (h < 0) h = 0;
    if (x + w > t->width) w = t->width - x;
    if (y + h > t->height) h = t->height - y;
    sc.left = x; sc.top = y; sc.right = x + w; sc.bottom = y + h;
  } else {
    sc.left = 0; sc.top = 0; sc.right = t->width; sc.bottom = t->height;
  }
  c->list->RSSetViewports(1, &vp);
  c->list->RSSetScissorRects(1, &sc);

  c->list->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  // One binding call PER SLOT, so the slot number always equals the AGAL attribute
  // number: the generated C binds its streams by attribute index and the HLSL VSIn
  // declares TEXCOORD{i} at slot i, so gaps (stream 2 used, stream 1 not) must not
  // compact the array.
  UINT boundStreams = 0;
  for (int i = 0; i < S3D_MAX_STREAMS; i++) {
    if (c->streams[i].buf == NULL || c->streams[i].components <= 0) continue;
    D3D12_VERTEX_BUFFER_VIEW vb = {};
    vb.BufferLocation = c->streams[i].buf->GetGPUVirtualAddress();
    vb.SizeInBytes = (UINT)(c->streams[i].numVertices * c->streams[i].components * 4);
    vb.StrideInBytes = (UINT)(c->streams[i].components * 4);
    c->list->IASetVertexBuffers((UINT)i, 1, &vb);
    boundStreams++;
  }
  if (boundStreams == 0) return 0;
  if (c->indexBuffer != NULL) {
    D3D12_INDEX_BUFFER_VIEW ibv = {};
    ibv.BufferLocation = c->indexBuffer->GetGPUVirtualAddress();
    ibv.SizeInBytes = (UINT)c->indexBytes;
    ibv.Format = DXGI_FORMAT_R32_UINT;
    c->list->IASetIndexBuffer(&ibv);
  }

  // Texture + sampler tables. A draw whose bindings equal the previous draw's
  // reuses the previous block: without that, the arena would need one block per
  // draw of a frame and a Starling painter issues far more draws than the budget.
  // `smpKey` is the sampler half of the same state, and keys the immutable sampler
  // blocks (see smpCfgKey); it must NOT include textures, which change per draw and
  // would fill that 256-entry cache.
  unsigned long long dk = 1469598103934665603ULL;
  unsigned long long smpKey = 1469598103934665603ULL;
  for (int i = 0; i < S3D_MAX_TEX; i++) {
    dk ^= (unsigned long long)(uintptr_t)c->textures[i];
    dk *= 1099511628211ULL;
    const unsigned long long st = (unsigned long long)(c->samplerStateSet[i]
                                   ? (c->samplerFilter[i] * 9 + c->samplerWrap[i] * 3 + c->samplerMip[i] + 1)
                                   : 0);
    dk ^= st;
    dk *= 1099511628211ULL;
    smpKey ^= st;
    smpKey *= 1099511628211ULL;
  }
  if (c->lastSrvTable.ptr == 0 || dk != c->lastDescKey) {
    const UINT srvBase = s3d_srv_block(c);
    const UINT smpBase = s3d_smp_block(c, smpKey);
    for (int i = 0; i < S3D_MAX_TEX; i++) s3d_write_srv(c, srvBase + (UINT)i, c->textures[i]);
    D3D12_GPU_DESCRIPTOR_HANDLE st = c->srvHeap->GetGPUDescriptorHandleForHeapStart();
    st.ptr += (SIZE_T)srvBase * c->srvInc;
    D3D12_GPU_DESCRIPTOR_HANDLE pt = c->smpHeap->GetGPUDescriptorHandleForHeapStart();
    pt.ptr += (SIZE_T)smpBase * c->smpInc;
    c->lastSrvTable = st;
    c->lastSmpTable = pt;
    c->lastDescKey = dk;
  }
  ID3D12DescriptorHeap* heaps[2] = { c->srvHeap, c->smpHeap };
  c->list->SetDescriptorHeaps(2, heaps);
  c->list->SetGraphicsRootDescriptorTable(2, c->lastSrvTable);
  c->list->SetGraphicsRootDescriptorTable(3, c->lastSmpTable);

  // Constant buffers: the HLSL declares register(b0) in BOTH stages, so the two
  // root parameters carry the vertex and fragment register files respectively.
  // Each draw binds the region the LAST upload for that stage left its values in
  // (see S3D_CB_REGION): the region offsets are 4096-aligned, hence CBV-legal.
  ID3D12Resource* vcb = c->vcBuf[c->slot];
  ID3D12Resource* fcb = c->fcBuf[c->slot];
  if (vcb == NULL || fcb == NULL) return 0;
  c->list->SetGraphicsRootConstantBufferView(0, vcb->GetGPUVirtualAddress() + c->cbOffV);
  c->list->SetGraphicsRootConstantBufferView(1, fcb->GetGPUVirtualAddress() + c->cbOffF);

  // Stage3D's stencil reference is per-draw state (setStencilReferenceValue): the
  // generated C walks it while stencilling, so it is re-set on every draw.
  if (c->stencilCompare != NULL) c->list->OMSetStencilRef(c->stencilRef);

  if (c->indexBuffer != NULL) {
    c->list->DrawIndexedInstanced((UINT)numTriangles * 3u, (UINT)c->instanceCount, 0, 0, 0);
  } else {
    c->list->DrawInstanced((UINT)numTriangles * 3u, (UINT)c->instanceCount, 0, 0);
  }
  c->statDraws++;
  return 1;
}

// ---- flush -----------------------------------------------------------------

void s3d_flush(void* ctx) {
  if (ctx == NULL) return;
  s3d_batch_end((S3DContext*)ctx, 1);
}
void s3d_flush_async(void* ctx) {
  if (ctx == NULL) return;
  // Commit only. The composite is submitted to the SAME queue later in the frame
  // (see the file header), so the GPU orders its read after these writes with no
  // CPU round trip; only the CPU-readback paths wait.
  s3d_batch_end((S3DContext*)ctx, 0);
}
void s3d_flush_all(void) {
  for (int i = 0; i < s3d_live_n; i++) s3d_flush(s3d_live[i]);
}
void s3d_flush_all_async(void) {
  for (int i = 0; i < s3d_live_n; i++) s3d_flush_async(s3d_live[i]);
}

// ---- readback --------------------------------------------------------------

// Copy one texture into a READBACK-heap buffer and memcpy the rows out. Returns 1
// on success.
static int s3d_readback_into(S3DContext* c, S3DTexture* src, uint8_t* out) {
  if (src == NULL || out == NULL) return 0;
  s3d_batch_end(c, 1);
  const UINT rowPitch = s3d_align256((UINT)src->width * 4u);
  const UINT bytes = rowPitch * (UINT)src->height;
  if (c->rbBuf == NULL || c->rbBytes < bytes) {
    if (c->rbBuf) { c->rbBuf->Release(); c->rbBuf = NULL; }
    D3D12_HEAP_PROPERTIES hp = {};
    hp.Type = D3D12_HEAP_TYPE_READBACK;
    D3D12_RESOURCE_DESC bd = {};
    bd.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    bd.Width = bytes;
    bd.Height = 1;
    bd.DepthOrArraySize = 1;
    bd.MipLevels = 1;
    bd.SampleDesc.Count = 1;
    bd.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    if (FAILED(c->device->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &bd,
                                                  D3D12_RESOURCE_STATE_COPY_DEST, NULL,
                                                  __uuidof(ID3D12Resource), (void**)&c->rbBuf)))
      return 0;
    c->rbBytes = bytes;
  }
  c->rbRowPitch = rowPitch;
  if (FAILED(c->upAlloc->Reset())) return 0;
  if (FAILED(c->upList->Reset(c->upAlloc, NULL))) return 0;
  D3D12_RESOURCE_STATES before = src->state;
  if (before != D3D12_RESOURCE_STATE_COPY_SOURCE) {
    D3D12_RESOURCE_BARRIER b = {};
    b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    b.Transition.pResource = src->res;
    b.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    b.Transition.StateBefore = before;
    b.Transition.StateAfter = D3D12_RESOURCE_STATE_COPY_SOURCE;
    c->upList->ResourceBarrier(1, &b);
    src->state = D3D12_RESOURCE_STATE_COPY_SOURCE;
  }
  D3D12_TEXTURE_COPY_LOCATION dst = {};
  dst.pResource = c->rbBuf;
  dst.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
  dst.PlacedFootprint.Offset = 0;
  dst.PlacedFootprint.Footprint.Format = src->format;
  dst.PlacedFootprint.Footprint.Width = (UINT)src->width;
  dst.PlacedFootprint.Footprint.Height = (UINT)src->height;
  dst.PlacedFootprint.Footprint.Depth = 1;
  dst.PlacedFootprint.Footprint.RowPitch = rowPitch;
  D3D12_TEXTURE_COPY_LOCATION srcL = {};
  srcL.pResource = src->res;
  srcL.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
  srcL.SubresourceIndex = 0;
  c->upList->CopyTextureRegion(&dst, 0, 0, 0, &srcL, NULL);
  {
    // Leave the texture in the frame invariant state the compositor expects.
    D3D12_RESOURCE_BARRIER b = {};
    b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    b.Transition.pResource = src->res;
    b.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    b.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_SOURCE;
    b.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
    c->upList->ResourceBarrier(1, &b);
    src->state = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
  }
  if (!s3d_run_immediate(c)) return 0;

  void* map = NULL;
  D3D12_RANGE rr = { 0, (SIZE_T)bytes };
  if (FAILED(c->rbBuf->Map(0, &rr, &map)) || map == NULL) return 0;
  for (int y = 0; y < src->height; y++) {
    memcpy(out + (size_t)y * (size_t)src->width * 4u,
           (const uint8_t*)map + (size_t)y * rowPitch,
           (size_t)src->width * 4u);
  }
  D3D12_RANGE wr = { 0, 0 };
  c->rbBuf->Unmap(0, &wr);
  return 1;
}

// Read back the back-buffer target (drawToBitmapData reads the frame target, not
// the render-to-texture override -- same as stage3d_glue.mm).
int s3d_readback(void* ctx, uint8_t* out) {
  if (ctx == NULL) return 0;
  return s3d_readback_into((S3DContext*)ctx, ((S3DContext*)ctx)->target, out);
}
// Read back the CURRENT render target (override if set, else the back buffer).
int s3d_readback_render(void* ctx, uint8_t* out) {
  if (ctx == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  return s3d_readback_into(c, s3d_cur_target(c), out);
}

int s3d_width(void* ctx) { return ctx ? ((S3DContext*)ctx)->width : 0; }
int s3d_height(void* ctx) { return ctx ? ((S3DContext*)ctx)->height : 0; }

// Largest 2D texture edge this backend can allocate. The device is created at
// D3D_FEATURE_LEVEL_11_0 (see s3d_create), which guarantees 16384, so a constant is
// exact here rather than an approximation. The generated C reads it to decide both
// the Context3D profile it reports and the #3683 "Texture too big" ceiling -- the
// profile claim and the enforced limit must never disagree.
int s3d_max_texture_size(void) { return 16384; }

// ---- render-to-texture -----------------------------------------------------

void* s3d_create_render_texture(void* ctx, int width, int height) {
  if (ctx == NULL || width <= 0 || height <= 0) return NULL;
  S3DContext* c = (S3DContext*)ctx;
  // A render-target texture is created with ALLOW_RENDER_TARGET and an RTV slot:
  // drawTriangles renders into it while it is the render override, and setTextureAt
  // can later sample it as fsN.
  return (void*)s3d_make_texture(c, width, height, 1, 1, 1, 0);
}

// Bind the render override. tex == NULL restores the back-buffer target.
void s3d_set_render_target(void* ctx, void* tex, int enableDepthAndStencil) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  if (tex != NULL) {
    S3DTexture* t = (S3DTexture*)tex;
    if (!t->isRT) {
      fprintf(stderr, "stage3d_d3d: setRenderToTexture: texture %dx%d has no render-target "
                      "usage -- pass ignored\n", t->width, t->height);
      return;
    }
    if (enableDepthAndStencil &&
        (c->rtDepth == NULL || c->rtDepthW != t->width || c->rtDepthH != t->height)) {
      S3DTexture* old = c->rtDepth;
      c->rtDepth = s3d_make_texture(c, t->width, t->height, 1, 1, 0, 1);
      c->rtDepthW = t->width;
      c->rtDepthH = t->height;
      if (c->rtDepth != NULL && old != NULL) s3d_free_texture(c, old);
    }
  }
  // A batch may still be rendering into the CURRENT override (and a draw into it
  // may be unsubmitted): retire the batch before the binding changes, so the two
  // targets' barriers never interleave inside one command list.
  if (c->renderOverride != (S3DTexture*)tex && c->boundRT != NULL) s3d_batch_end(c, 1);
  c->renderOverride = (S3DTexture*)tex;
}

// Bind an existing render-target texture as fragment sampler fs{unit} (no pixel
// upload -- the texture already holds rendered content).
int s3d_bind_texture(void* ctx, int unit, void* tex, int hasChain) {
  if (ctx == NULL || unit < 0 || unit >= S3D_MAX_TEX || tex == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  c->textures[unit] = (S3DTexture*)tex;
  c->texHasMips[unit] = hasChain ? 1 : 0;
  return 1;
}

// Expose the current render target as an opaque ID3D12Resource* for the GPU->GPU
// composite. The caller (the generated C) passes it straight to
// sk_gpu_draw_texture, which reads the format off the resource and assumes
// PIXEL_SHADER_RESOURCE -- the state s3d_batch_end leaves it in. The composite
// BORROWS it: ownership stays with the context, so nothing outlives the draw.
void* s3d_get_render_target(void* ctx) {
  if (ctx == NULL) return NULL;
  S3DContext* c = (S3DContext*)ctx;
  S3DTexture* src = s3d_cur_target(c);
  if (src == NULL) return NULL;
  if (s3d_env("ASC_S3D_TRACE")) {
    // Periodic like the sibling traces: the desc (not just the pointer) is here to make
    // a lifetime bug visible -- a released target would show up as a BUFFER desc.
    static int n = 0;
    if (n++ % 120 == 0) {
      D3D12_RESOURCE_DESC qd = src->res->GetDesc();
      int inRel = 0;
      for (int i = 0; i < c->nrel; i++) if (c->rel[i].obj == (IUnknown*)src->res) inRel = 1;
      fprintf(stderr, "stage3d_d3d: get_render_target c=%p src=%p %dx%d state=%d override=%p "
                      "desc(dim=%d fmt=%d w=%llu h=%u) relQ=%d\n",
              (void*)c, (void*)src->res, src->width, src->height, (int)src->state,
              (void*)c->renderOverride, (int)qd.Dimension, (int)qd.Format,
              (unsigned long long)qd.Width, (unsigned)qd.Height, inRel);
      fflush(stderr);
    }
  }
  return (void*)src->res;
}

void s3d_destroy_texture(void* tex) {
  if (tex == NULL) return;
  S3DTexture* t = (S3DTexture*)tex;
  // Drop every borrowed binding first: a released texture left in a sampler slot or
  // as the render override would crash the next draw (see the live-context registry).
  s3d_unbind_texture_everywhere(t);
  // The creating context owns the RTV/DSV slots, so IT must free them -- not
  // whichever context happens to come first in the registry.
  S3DContext* owner = NULL;
  for (int i = 0; i < s3d_live_n; i++) if (s3d_live[i] == t->owner) { owner = s3d_live[i]; break; }
  if (owner == NULL) {
    // No live context holds it any more: this is teardown, after s3d_destroy
    // released everything it owned.
    t->res->Release();
    free(t);
    return;
  }
  s3d_free_texture(owner, t);
}

}  // extern "C"