// d3d_glue.cc — the Windows counterpart of metal_glue.mm: the C bridge to Skia's
// Ganesh Direct3D 12 backend.
//
// <renderMode>direct</renderMode> (or gpu) on Windows composes each frame on the
// GPU through Skia's Ganesh D3D12 backend. The shape of the problem is identical
// to Metal's — a frame's target is a one-shot resource, so there is no persistent
// SkSurface to hand around, only a per-frame begin/draw/present cycle — and so is
// the API the rest of the compiler sees (sk_gpu_init / sk_gpu_begin_frame /
// sk_gpu_flush / sk_gpu_destroy / sk_gpu_draw_texture, all keyed by the window id
// window_glue.cc assigned). What differs is only what "one-shot target" means:
// instead of a CAMetalDrawable from a CAMetalLayer, it is one of the DXGI
// swapchain's back buffers, which is writable only between Acquire and Present and
// which this file therefore owns end to end.
//
// Division of labour with window_glue.cc (deliberately the same as Metal's):
//   * window_glue.cc owns the SDL2 window, the event loop, input, the cursor and
//     display queries, and hands this file the window's HWND as the "native
//     handle" argument of sk_gpu_init.
//   * this file owns everything GPU: the ID3D12Device / command queue /
//     GrDirectContext (process-wide) and the swapchain + back buffers +
//     synchronization (per window).
// Nothing about a swapchain crosses that boundary, which is why the generated C
// and window_glue.cc never need to know D3D12 exists.
//
// STATUS — READ BEFORE TRUSTING THIS FILE: it is written against Skia m124's own
// Windows reference (tools/window/win/D3D12WindowContext_win.cpp, which this
// mirrors step for step) but has NOT been compiled or run: the development machine
// for this repo is macOS and `clang --target=x86_64-pc-windows-msvc` cannot link a
// D3D12 program here. The compiler-side wiring, the library names and the
// backend-neutral seam ARE verified on macOS; every D3D12 call below is not. See
// docs/zh-cn/win32.md for the exact list of unverified assumptions and for the
// first-run checklist to run on the Windows build machine.
//
// Spec references (AGENTS.md §2.4 requires the authority, not a guess):
//   * swapchain setup, fence protocol, surface wrapping:
//     build-tools/skia-src/tools/window/win/D3D12WindowContext_win.cpp
//   * device/queue creation and the adapter probe:
//     build-tools/skia-src/tools/gpu/d3d/D3DTestUtils.cpp
//   * GrD3DBackendContext / GrD3DTextureResourceInfo field names and order:
//     build-tools/skia-src/include/gpu/d3d/GrD3DBackendContext.h
//   * the memory allocator Skia builds when fMemoryAllocator is left null (it is
//     GrD3DAMDMemoryAllocator, which is why vendor/*/d3d12allocator.lib must be on
//     the link line):
//     build-tools/skia-src/src/gpu/ganesh/d3d/GrD3DGpu.cpp (GrD3DGpu::Make)

// SK_DIRECT3D gates the D3D-specific constructors in Skia's public headers
// (GrDirectContext::MakeDirect3D, and GrD3DTypes.h's contents). Skia's own build
// sets it via `skia_use_direct3d = true` (see vendor/build-windows-deps.ps1, which
// turns it on for the Windows archives); a consumer of those prebuilt .lib files
// must define it here for the same reason metal_glue.mm defines SK_METAL. SK_GANESH
// is also required: SkTypes.h #undefs the backend macro unless a GPU backend is
// selected, so both must be defined before any Skia header.
#define SK_GANESH
#define SK_DIRECT3D

// windows.h must come before Skia's D3D headers (they include it themselves) and
// must not inject the min/max macros: they are function-like macros over the
// whole translation unit, so Skia's own std::min/std::max uses would fail to
// compile. WIN32_LEAN_AND_MEAN keeps <windows.h> from pulling in the 1990s
// multimedia/font surface we do not use.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <d3d12.h>
#include <dxgi1_4.h>

#include "include/core/SkSurface.h"
#include "include/core/SkCanvas.h"
#include "include/gpu/GrDirectContext.h"
#include "include/gpu/GrBackendSurface.h"
#include "include/gpu/ganesh/SkSurfaceGanesh.h"
// GrD3DBackendContext.h pulls in GrD3DTypes.h -> d3d12.h -> windows.h, and warns
// that windows.h redefines common identifiers (interface, small, near, far,
// CreateSemaphore, MemoryBarrier). Including <windows.h> above is what makes that
// safe here: the redefinitions happen once, before any Skia declaration is parsed.
#include "include/gpu/d3d/GrD3DBackendContext.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>

// --- helpers --------------------------------------------------------------

// Every D3D12 call that returns an HRESULT goes through this. A failed call in
// this file leaves a window with no usable GPU target, which must never pass
// unnoticed: the failure is printed with the HRESULT so the first Windows run can
// be diagnosed from stderr alone (the caller also treats the return value as
// failure and refuses the window — see sk_attach_d3d in window_glue.cc).
#define D3D_OK_OR_WARN(call)                                            \
  do {                                                                  \
    HRESULT _hr = (call);                                               \
    if (FAILED(_hr)) {                                                  \
      fprintf(stderr, "d3d_glue: %s failed: 0x%08lx\n", #call, (unsigned long)_hr); \
      fflush(stderr);                                                   \
    }                                                                   \
  } while (0)

static double d3d_now_ms(void) {
  // std::chrono would be finer, but this file is deliberately C++-light: the only
  // C++ it needs is Skia's own types.
  LARGE_INTEGER f, c;
  QueryPerformanceFrequency(&f);
  QueryPerformanceCounter(&c);
  return (double)c.QuadPart * 1000.0 / (double)f.QuadPart;
}

// Window slots. MUST match ASC_MAX_WINDOWS in the generated C, SK_MAX_WINDOWS in
// window_glue.cc and SK_MTL_MAX_WINDOWS in metal_glue.mm: an id is an index into
// all of those tables, and the generated C mints ids from the same generator.
#define SK_D3D_MAX_WINDOWS 16

// Frames in flight. Two is what the Skia reference uses and what flip-model
// swapchains are designed around; more only buys latency, fewer stalls the GPU.
#define SK_D3D_NUM_FRAMES 2

// Swapchain back-buffer format. R8G8B8A8_UNORM + kRGBA_8888_SkColorType is the
// pair Skia's own Windows window context uses (D3D12WindowContext_win.cpp), and
// it is one of the four formats a flip-model swapchain accepts. Note this is the
// opposite byte order from the Metal path's BGRA8 layer — the two backends pick
// the format their platform's compositor prefers, and neither path assumes the
// other's, because the SkColorType is what tells Skia how to interpret the bytes.
#define SK_D3D_SWAPCHAIN_FORMAT DXGI_FORMAT_R8G8B8A8_UNORM

typedef struct {
  int used;
  HWND hwnd;
  gr_cp<IDXGISwapChain3> swapchain;
  gr_cp<ID3D12Resource> buffers[SK_D3D_NUM_FRAMES];
  sk_sp<SkSurface> surfaces[SK_D3D_NUM_FRAMES];
  unsigned int buffer_index;
  // CPU/GPU sync: the back buffer at `buffer_index` may still be in use by the GPU
  // until the fence reaches that frame's value (see sk_gpu_begin_frame).
  gr_cp<ID3D12Fence> fence;
  HANDLE fence_event;
  uint64_t fence_values[SK_D3D_NUM_FRAMES];
  int width, height;
} D3DWin;

static D3DWin g_d3d[SK_D3D_MAX_WINDOWS];
// Process-wide backend, created with the first GPU window and torn down when the
// last one goes away — the same lifetime rule as metal_glue.mm's, and for the same
// reason: it carries no per-window state, and one set per window would only
// multiply GPU memory.
static gr_cp<IDXGIAdapter1> g_adapter;
static gr_cp<ID3D12Device> g_device;
static gr_cp<ID3D12CommandQueue> g_queue;
static sk_sp<GrDirectContext> g_context;
static long g_d3d_frames = 0;
static double g_d3d_t_first = 0.0;

static D3DWin* d3d_slot(int win_id) {
  if (win_id < 0 || win_id >= SK_D3D_MAX_WINDOWS) return nullptr;
  return g_d3d[win_id].used ? &g_d3d[win_id] : nullptr;
}

// Pick the first adapter that can actually create a D3D12 device (the probe SKU
// check: an adapter that fails D3D12CreateDevice here would fail again for real).
// Mirrors sk_gpu_test::get_hardware_adapter.
static IDXGIAdapter1* d3d_hardware_adapter(IDXGIFactory4* factory) {
  for (UINT i = 0;; ++i) {
    IDXGIAdapter1* adapter = nullptr;
    if (factory->EnumAdapters1(i, &adapter) == DXGI_ERROR_NOT_FOUND) return nullptr;
    if (adapter == nullptr) return nullptr;
    if (SUCCEEDED(D3D12CreateDevice(adapter, D3D_FEATURE_LEVEL_11_0,
                                    __uuidof(ID3D12Device), nullptr))) {
      return adapter;
    }
    adapter->Release();
  }
}

// Build the process-wide device/queue/context once. Returns 0 (with a printed
// reason) if any step fails; the caller refuses the window rather than continuing
// with a half-built backend.
static int d3d_init_shared(void) {
  if (g_context != nullptr) return 1;

  gr_cp<IDXGIFactory4> factory;
  D3D_OK_OR_WARN(CreateDXGIFactory1(IID_PPV_ARGS(&factory)));
  if (factory.get() == nullptr) return 0;

  g_adapter = d3d_hardware_adapter(factory.get());
  if (g_adapter.get() == nullptr) {
    fprintf(stderr, "d3d_glue: no adapter can create a Direct3D 12 device\n");
    return 0;
  }

  D3D_OK_OR_WARN(D3D12CreateDevice(g_adapter.get(), D3D_FEATURE_LEVEL_11_0,
                                   IID_PPV_ARGS(&g_device)));
  if (g_device.get() == nullptr) return 0;

  D3D12_COMMAND_QUEUE_DESC qd = {};
  qd.Flags = D3D12_COMMAND_QUEUE_FLAG_NONE;
  qd.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
  D3D_OK_OR_WARN(g_device->CreateCommandQueue(&qd, IID_PPV_ARGS(&g_queue)));
  if (g_queue.get() == nullptr) return 0;

  GrD3DBackendContext backend = {};
  backend.fAdapter = g_adapter;
  backend.fDevice = g_device;
  backend.fQueue = g_queue;
  // fMemoryAllocator is deliberately left null: GrD3DGpu::Make then builds
  // GrD3DAMDMemoryAllocator from the adapter+device itself (GrD3DGpu.cpp), which
  // is what Skia's own Windows window context does too. Handing it in would mean
  // this file naming the allocator — and its headers live under src/, i.e. they
  // are not a public API contract.
  // fProtectedContext stays kNo: protected memory needs a DRM-capable display path
  // that a desktop app has no reason to ask for.
  g_context = GrDirectContext::MakeDirect3D(backend);
  if (g_context == nullptr) {
    fprintf(stderr, "d3d_glue: GrDirectContext::MakeDirect3D failed\n");
    g_queue.reset();
    g_device.reset();
    g_adapter.reset();
    return 0;
  }
  return 1;
}

// (Re)build every back buffer's SkSurface. Called once at init and again after
// every ResizeBuffers: in both cases the old ID3D12Resource pointers are stale, so
// the old surfaces must be dropped first (their GrBackendRenderTargets wrap those
// resources).
static int d3d_setup_surfaces(D3DWin* w) {
  for (int i = 0; i < SK_D3D_NUM_FRAMES; ++i) {
    w->surfaces[i].reset();
    w->buffers[i].reset();

    D3D_OK_OR_WARN(w->swapchain->GetBuffer((UINT)i, IID_PPV_ARGS(&w->buffers[i])));
    if (w->buffers[i].get() == nullptr) return 0;

    // GrD3DTextureResourceInfo(resource, alloc, state, format, levelCount,
    // sampleCount, protected). `alloc` is null because the swapchain owns the
    // resource (Skia must not try to free it), and the state is PRESENT because
    // that is the state DXGI hands a back buffer back in.
    GrD3DTextureResourceInfo info(w->buffers[i].get(), nullptr,
                                  D3D12_RESOURCE_STATE_PRESENT,
                                  SK_D3D_SWAPCHAIN_FORMAT,
                                  1, 1, GrProtected::kNo);
    GrBackendRenderTarget rt(w->width, w->height, info);
    w->surfaces[i] = SkSurfaces::WrapBackendRenderTarget(g_context.get(), rt,
                                                         kTopLeft_GrSurfaceOrigin,
                                                         kRGBA_8888_SkColorType,
                                                         nullptr, nullptr);
    if (w->surfaces[i] == nullptr) {
      fprintf(stderr, "d3d_glue: WrapBackendRenderTarget failed for back buffer %d\n", i);
      return 0;
    }
  }
  return 1;
}

// --- the seam the generated C calls ---------------------------------------

extern "C" {

// Bind a window's HWND to the shared backend: create the flip-model swapchain,
// wrap its back buffers as SkSurfaces and set up the frame fence. `native_handle`
// is the HWND (window_glue.cc fetched it from SDL, it is the one thing the
// backend cannot obtain for itself without knowing about SDL). Returns 1 on
// success; on failure the caller (sk_attach_d3d) refuses the window and the app
// reports it, rather than showing a window nothing can draw into.
int sk_gpu_init(int win_id, void* native_handle) {
  HWND hwnd = (HWND)native_handle;
  if (hwnd == NULL || win_id < 0 || win_id >= SK_D3D_MAX_WINDOWS) return 0;
  // One init per window: the glue frees the slot before an id can be reused, so a
  // second init here would mean the two sides disagree about which HWND the id
  // names — refuse rather than silently rebind (same rule as sk_mtl_init).
  if (g_d3d[win_id].used) return 0;
  if (!d3d_init_shared()) return 0;

  // The swapchain is created at the window's current CLIENT size. A later size
  // change is handled by sk_gpu_begin_frame's ResizeBuffers path, so this only has
  // to be a sensible starting point.
  RECT rc;
  GetClientRect(hwnd, &rc);
  int cw = (int)(rc.right - rc.left);
  int ch = (int)(rc.bottom - rc.top);
  if (cw <= 0 || ch <= 0) { cw = 1; ch = 1; }

  gr_cp<IDXGIFactory4> factory;
  D3D_OK_OR_WARN(CreateDXGIFactory1(IID_PPV_ARGS(&factory)));
  if (factory.get() == nullptr) return 0;

  DXGI_SWAP_CHAIN_DESC1 sd = {};
  sd.BufferCount = SK_D3D_NUM_FRAMES;
  sd.Width = (UINT)cw;
  sd.Height = (UINT)ch;
  sd.Format = SK_D3D_SWAPCHAIN_FORMAT;
  sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  // FLIP_DISCARD is the only modern presentation model (and the only one that gets
  // independent flip on Windows 10+); the swapchain is created on our own command
  // queue so that a Present can be ordered against the Signal below.
  sd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
  sd.SampleDesc.Count = 1;

  gr_cp<IDXGISwapChain1> swapchain;
  D3D_OK_OR_WARN(factory->CreateSwapChainForHwnd(g_queue.get(), hwnd, &sd, nullptr,
                                                 nullptr, &swapchain));
  if (swapchain.get() == nullptr) {
    fprintf(stderr, "d3d_glue: CreateSwapChainForHwnd failed\n");
    return 0;
  }
  // Alt+Enter must not tear the swapchain out from under Skia: this backend has no
  // fullscreen transition (the AS3 side drives displayState through SDL instead).
  D3D_OK_OR_WARN(factory->MakeWindowAssociation(hwnd, DXGI_MWA_NO_ALT_ENTER));
  D3D_OK_OR_WARN(swapchain->QueryInterface(IID_PPV_ARGS(&g_d3d[win_id].swapchain)));
  if (g_d3d[win_id].swapchain.get() == nullptr) return 0;

  g_d3d[win_id].hwnd = hwnd;
  g_d3d[win_id].width = cw;
  g_d3d[win_id].height = ch;
  g_d3d[win_id].buffer_index = g_d3d[win_id].swapchain->GetCurrentBackBufferIndex();

  if (!d3d_setup_surfaces(&g_d3d[win_id])) {
    g_d3d[win_id].swapchain.reset();
    return 0;
  }

  // Fence values start high so they stand out in a PIX capture (Skia's reference
  // does the same); only their ordering matters.
  for (int i = 0; i < SK_D3D_NUM_FRAMES; ++i) g_d3d[win_id].fence_values[i] = 10000;
  D3D_OK_OR_WARN(g_device->CreateFence(g_d3d[win_id].fence_values[g_d3d[win_id].buffer_index],
                                       D3D12_FENCE_FLAG_NONE,
                                       IID_PPV_ARGS(&g_d3d[win_id].fence)));
  if (g_d3d[win_id].fence.get() == nullptr) return 0;
  g_d3d[win_id].fence_event = CreateEvent(NULL, FALSE, FALSE, NULL);
  if (g_d3d[win_id].fence_event == NULL) return 0;

  g_d3d[win_id].used = 1;
  fprintf(stderr, "d3d_glue: window %d bound to %dx%d R8G8B8A8 swapchain\n",
          win_id, cw, ch);
  return 1;
}

// Release one window's GPU state. The shared backend goes when the last GPU
// window does — after an explicit CPU sync, so no frame is still in flight against
// a device we are about to drop.
void sk_gpu_destroy(int win_id) {
  D3DWin* w = d3d_slot(win_id);
  if (w != nullptr) {
    // The queue may still be executing the last present of this window; drain it
    // before anything it reads is released.
    if (g_context != nullptr) {
      g_context->flush();
      g_context->submit(GrSyncCpu::kYes);
    }
    for (int i = 0; i < SK_D3D_NUM_FRAMES; ++i) {
      if (w->fence.get() != nullptr && w->fence_event != NULL &&
          w->fence->GetCompletedValue() < w->fence_values[i]) {
        D3D_OK_OR_WARN(w->fence->SetEventOnCompletion(w->fence_values[i], w->fence_event));
        WaitForSingleObjectEx(w->fence_event, INFINITE, FALSE);
      }
      w->surfaces[i].reset();
      // A flip-model swapchain requires its back-buffer references to be gone
      // before ResizeBuffers — and before the swapchain itself is released here.
      w->buffers[i].reset();
    }
    if (w->fence_event != NULL) CloseHandle(w->fence_event);
    w->fence.reset();
    w->swapchain.reset();
    w->hwnd = NULL;
    w->used = 0;
  }
  for (int i = 0; i < SK_D3D_MAX_WINDOWS; ++i) {
    if (g_d3d[i].used) return;
  }
  g_context.reset();
  g_queue.reset();
  g_device.reset();
  g_adapter.reset();
}

// Begin a frame: make sure the swapchain matches the requested physical size,
// wait until the target back buffer's previous frame has been presented, and
// return that buffer's canvas (the caller draws into it, then calls sk_gpu_flush).
// Returns NULL when the frame cannot start, so the render loop skips the frame
// instead of drawing into a resource DXGI has taken away.
void* sk_gpu_begin_frame(int win_id, int width, int height) {
  D3DWin* w = d3d_slot(win_id);
  if (w == nullptr || g_context == nullptr) return nullptr;
  if (width <= 0 || height <= 0) return nullptr;

  // A resize invalidates every back buffer. This is where a live window drag
  // lands, and it is the D3D analogue of Metal's per-frame drawableSize update:
  // the frame target is rebuilt rather than reused.
  if (width != w->width || height != w->height) {
    if (g_context != nullptr) {
      g_context->flush();
      g_context->submit(GrSyncCpu::kYes);
    }
    for (int i = 0; i < SK_D3D_NUM_FRAMES; ++i) {
      if (w->fence.get() != nullptr && w->fence_event != NULL &&
          w->fence->GetCompletedValue() < w->fence_values[i]) {
        D3D_OK_OR_WARN(w->fence->SetEventOnCompletion(w->fence_values[i], w->fence_event));
        WaitForSingleObjectEx(w->fence_event, INFINITE, FALSE);
      }
      w->surfaces[i].reset();
      w->buffers[i].reset();
    }
    D3D_OK_OR_WARN(w->swapchain->ResizeBuffers(0, (UINT)width, (UINT)height,
                                               SK_D3D_SWAPCHAIN_FORMAT, 0));
    w->width = width;
    w->height = height;
    if (!d3d_setup_surfaces(w)) return nullptr;
    w->buffer_index = w->swapchain->GetCurrentBackBufferIndex();
  }

  // Frame pacing: if the back buffer we are about to draw into is still being read
  // by the GPU (its fence has not reached this frame's value), wait for it. This is
  // the standard flip-model acquire; skipping it would let the GPU read a resource
  // the CPU is already overwriting — visible as torn/black bands.
  const UINT64 current = w->fence_values[w->buffer_index];
  w->buffer_index = w->swapchain->GetCurrentBackBufferIndex();
  if (w->fence.get() != nullptr &&
      w->fence->GetCompletedValue() < w->fence_values[w->buffer_index]) {
    D3D_OK_OR_WARN(w->fence->SetEventOnCompletion(w->fence_values[w->buffer_index],
                                                  w->fence_event));
    WaitForSingleObjectEx(w->fence_event, INFINITE, FALSE);
  }
  w->fence_values[w->buffer_index] = current + 1;

  SkSurface* s = w->surfaces[w->buffer_index].get();
  if (s == nullptr) return nullptr;

  if (getenv("ASC_S3D_STATS") != NULL) {
    g_d3d_frames++;
    const double now = d3d_now_ms();
    if (g_d3d_t_first == 0.0) g_d3d_t_first = now;
    if (g_d3d_frames % 600 == 0) {
      const double el = (now - g_d3d_t_first) / 1000.0;
      fprintf(stderr, "sk_stats t=%.1fs frames=%ld fps=%.1f ms/frame=%.2f\n", el,
              g_d3d_frames, el > 0.0 ? (double)g_d3d_frames / el : 0.0,
              el > 0.0 ? 1000.0 * el / (double)g_d3d_frames : 0.0);
      fflush(stderr);
    }
  }
  return (void*)s->getCanvas();
}

// Submit the frame's Ganesh work and present the back buffer.
//
// The two-step flush here is the D3D counterpart of Metal's flushAndSubmit, and
// skipping either half gives a wrong picture rather than a missing one: `flush`
// only *records* the frame's commands (with kPresent so Skia transitions the back
// buffer's state and marks the resource as presented), `submit` actually sends
// them, and only then may DXGI Present. Presenting before submit shows a stale
// back buffer, which on a freshly created swapchain is visibly wrong rather than
// merely late.
void sk_gpu_flush(int win_id) {
  D3DWin* w = d3d_slot(win_id);
  if (w == nullptr || g_context == nullptr) return;
  SkSurface* s = w->surfaces[w->buffer_index].get();
  if (s == nullptr) return;

  GrFlushInfo info;
  g_context->flush(s, SkSurfaces::BackendSurfaceAccess::kPresent, info);
  g_context->submit();

  D3D_OK_OR_WARN(w->swapchain->Present(1, 0));
  // Mark this frame's completion on the queue so the next begin_frame for this
  // buffer index can wait for it (see above). Signaling AFTER Present is what
  // makes the wait meaningful: the fence reaching this value means DXGI has
  // finished reading the buffer.
  D3D_OK_OR_WARN(g_queue->Signal(w->fence.get(), w->fence_values[w->buffer_index]));
}

// Composite an externally-owned D3D12 texture (an ID3D12Resource) onto the current
// canvas.
//
// NOT REACHABLE IN THIS BUILD, and it says so out loud rather than drawing
// nothing: its only caller is the Stage3D -> window composite, and Stage3D on
// Windows is a build-time error (air-app.ts refuses an AIR descriptor that uses
// Context3D there, because the AGAL -> HLSL pipeline does not exist yet — see
// TODO.md's stage for vendor/stage3d_d3d.cc). When that pipeline lands, this must
// wrap the render target's resource in a GrD3DTextureResourceInfo and draw it; the
// resource's DXGI_FORMAT and current D3D12_RESOURCE_STATE are the two things that
// have to come from the Stage3D context, which is exactly why they cannot be
// invented here. Note that the generated C's Stage3D composite is compiled out
// under ASC_RENDER_D3D anyway (it composites a Metal texture), so this exists to
// make the seam complete, not to be called.
void sk_gpu_draw_texture(void* canvas, void* d3dTexture, int w, int h,
                         double dx, double dy, double dw, double dh) {
  (void)canvas; (void)d3dTexture; (void)w; (void)h;
  (void)dx; (void)dy; (void)dw; (void)dh;
  static int warned = 0;
  if (!warned) {
    warned = 1;
    fprintf(stderr, "d3d_glue: sk_gpu_draw_texture has no implementation yet "
                    "(Stage3D composite); nothing was drawn\n");
    fflush(stderr);
  }
}

}  // extern "C"