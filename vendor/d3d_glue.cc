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
// mirrors step for step). It now COMPILES (2026-10-10, clang 23.1.3 +
// `--target=i686-pc-windows-msvc` — the font-backend/objc/_m_prefetch/type errors
// that first blocked it are fixed, see docs/zh-cn/win32.md §2.6) but has NOT been
// linked or run: the development machine for this repo is macOS and cannot link a
// D3D12 program. The compiler-side wiring, the library names and the
// backend-neutral seam ARE verified on macOS; every D3D12 call below is still
// unverified at runtime. See docs/zh-cn/win32.md §5 for the first-run checklist.
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
// sets it via `skia_use_direct3d = true` (see vendor/provision/windows.ps1, which
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
// GrD3DTextureResourceInfo's GrBackendRenderTarget wrapper carries a
// sk_sp<SkColorSpace>, so SkColorSpace must be a complete type where the surface
// is wrapped (the classic SkRefCnt.h "incomplete type" error otherwise).
#include "include/core/SkColorSpace.h"
#include "include/gpu/GrDirectContext.h"
#include "include/gpu/GrBackendSurface.h"
#include "include/gpu/ganesh/SkSurfaceGanesh.h"
// The Stage3D composite borrows an ID3D12Resource as an SkImage
// (SkImages::BorrowTextureFrom) and draws it into the frame's canvas.
#include "include/core/SkImage.h"
#include "include/core/SkPaint.h"
#include "include/gpu/ganesh/SkImageGanesh.h"
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

// --- device-lost recovery --------------------------------------------------
// DXGI takes the device away (driver update, TDR, VRAM pressure) and every object
// created from it -- the swapchain, its back buffers, and the Skia Ganesh context
// that wraps them -- is invalid from that instant. Continuing to use them is an
// access violation, which is exactly what a real app did: one
// "Present failed 0x887A0005" (DXGI_ERROR_DEVICE_REMOVED, which D3D_OK_OR_WARN
// only PRINTS) and 386 ms later the process died inside Skia, having drawn several
// more frames into a device that no longer existed. The same failure without the
// crash is worse in another way: Present returns immediately, the frame loop spins
// and the window stops answering (AppHangB1).
//
// The recovery below is the DXGI contract: drop every GPU object, rebuild the
// device/context and each live window's swapchain, and until that succeeds let
// sk_gpu_begin_frame return NULL so the AS3 side skips the frame (it already
// treats NULL as "nothing to draw into").
static int g_d3d_lost = 0;
static double g_d3d_retry_at = 0.0;
static int g_d3d_retry_ms = 250;
static int g_d3d_rebuilds = 0;

// ASC_GPU_LOSE_AT=<frame>: remove the device on purpose (ID3D12Device5::RemoveDevice)
// to exercise the recovery path. -1 means "the env has not been read yet", 0 means
// off. Only a genuinely removed device makes Skia's teardown unsafe, so a simulated
// loss would prove nothing -- this hook asks DXGI to remove the real one.
static long g_d3d_lose_at = -1;
static long g_d3d_frames_seen = 0;

// The HRESULTs that mean "this device is gone". Anything else (a bad argument, an
// occluded present) leaves the swapchain usable, so it must not trigger a rebuild.
static int d3d_hr_is_device_lost(HRESULT hr) {
  return hr == DXGI_ERROR_DEVICE_REMOVED ||
         hr == DXGI_ERROR_DEVICE_RESET ||
         hr == DXGI_ERROR_DRIVER_INTERNAL_ERROR;
}

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

// Frames in flight == swapchain buffer count (one buffer per frame in flight).
//
// THREE, not the two the Skia reference uses. The reason is not throughput but a
// measured drag defect on Windows: with two buffers, DXGI's presentation queue can
// hold BOTH of them while the compositor is busy with the window -- and it is busy
// at roughly half rate exactly while the user is moving the window. The acquire wait
// in sk_gpu_begin_frame then blocks for two vblanks per frame (~31 ms measured), and
// since our frames can run *inside* the OS's modal move loop dispatch
// (live_resize_watch -> sk_pump_frame), that wait is time the move loop never gets:
// the window advanced in rock-steady 66.6 ms steps while being dragged (four
// vblanks), where a plain Win32 window, a CPU-rendered SDL window and adl all move in
// ~3 ms steps. A spare buffer means DXGI never has to stall the acquire (measured:
// the wait drops from 31 ms to 0.0 ms and the drag from 66.6 ms to 3.1 ms steps,
// matching adl, with the app still animating through the drag). The cost is one
// extra back buffer (~1.7 MB for a 480x870 window) and about one frame of latency.
#define SK_D3D_NUM_FRAMES 3

// How long the resize path may wait for the GPU to release the old back buffers
// before it gives up and skips the frame.
//
// ResizeBuffers requires every back-buffer reference to be gone, so that wait is
// unavoidable -- but it must not be unbounded. DXGI retires a flip-model present
// only when the compositor takes it, and the compositor is exactly what is busy
// while the user drags a window edge, so an unbounded wait here can block the one
// thread that would otherwise let it through: measured, dragging the bottom-right
// corner wedged the app outright (the window stopped following and stopped
// redrawing, IsHungAppWindow went true, 0% CPU, only a kill ended it). 250 ms is
// far longer than any real drain (a live resize frame is 16 ms, and the whole
// teardown measured at ~0-2 ms when it works) and far shorter than the point where
// a user calls the app hung. Skipping a frame instead leaves the swapchain intact
// and retries on the next one, which is exactly what a NULL return from
// sk_gpu_begin_frame already means.
#define SK_D3D_DRAIN_MS 250

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
  // A failed swapchain rebuild must not be attempted on every frame: without GPU
  // quiescence the old swapchain can make CreateSwapChainForHwnd fail repeatedly.
  double recreate_retry_at;
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

// ASC_GPU_STATS: how much CPU the frame costs, with the blocking present removed
// from the measurement. The sk_stats block in sk_gpu_begin_frame above times whole
// frame intervals, which under vsync reads 16.7 ms on every backend and so cannot
// compare backends at all. This accumulator times only "record the frame and hand
// it to the driver": from the end of sk_gpu_begin_frame (after the acquire wait) to
// just before Present. It is CPU submit cost, NOT GPU time -- submit() is async, so
// a GPU-bound frame still reads low here. Deliberately identical to the probe in
// gl_glue.cc so the two backends produce comparable numbers.
static int g_d3d_stats_on = -1;
static double g_d3d_work_t0 = 0.0;
static double g_d3d_work_sum = 0.0;
static double g_d3d_work_max = 0.0;
static long g_d3d_work_n = 0;

static void d3d_stats_frame_done(void) {
  if (g_d3d_stats_on <= 0) return;
  const double dt = d3d_now_ms() - g_d3d_work_t0;
  g_d3d_work_sum += dt;
  if (dt > g_d3d_work_max) g_d3d_work_max = dt;
  g_d3d_work_n++;
  if (g_d3d_work_n % 120 == 0) {
    fprintf(stderr, "gpu_stats frames=%ld work_avg=%.3f work_max=%.3f ms\n",
            g_d3d_work_n, g_d3d_work_sum / (double)g_d3d_work_n, g_d3d_work_max);
    fflush(stderr);
  }
}

static D3DWin* d3d_slot(int win_id) {
  if (win_id < 0 || win_id >= SK_D3D_MAX_WINDOWS) return nullptr;
  return g_d3d[win_id].used ? &g_d3d[win_id] : nullptr;
}

// Is the device actually gone? Only that makes Skia's teardown unsafe -- a failed
// rebuild may well have installed a HEALTHY device (the swapchain then failed for an
// unrelated reason) which must be destroyed the normal way. GetDeviceRemovedReason()
// is a local query: nothing is submitted.
static int d3d_device_gone(void) {
  if (g_device.get() == nullptr) return 1;
  return FAILED(g_device->GetDeviceRemovedReason());
}

// Release every GPU object. Used by the lost path (the objects are already
// invalid) and by a failed rebuild (a partial set must not outlive the attempt).
//
// abandonContext, NOT reset: GrDirectContext's destructor flushes whatever is still
// pending, which is precisely the operation that must not happen on a removed
// device. abandonContext() is Skia's contract for "the backend context is gone" --
// it drops every resource without submitting anything.
//
// abandonContext is NECESSARY BUT NOT SUFFICIENT on a removed device, and that is
// what "device lost then crash" turned out to be. GrGpu::disconnect() is an empty
// default and GrD3DGpu does not override it, so abandoning drops the resources and
// leaves fCurrentDirectCommandList in place; the context still has to be destroyed
// after that, and ~GrDirectContext -> ~GrD3DGpu -> destroyResources() calls
//   fCurrentDirectCommandList->close();   // submitResourceBarriers + ID3D12 Close
//   waitForQueueCompletion();             // SetEventOnCompletion + INFINITE wait
// -- i.e. exactly the two things that must not happen on a device DXGI took away.
// Measured (temp/crashmon dumps, 0xc0000005 twice): the process dies inside
//   ?close@GrD3DCommandList@@QAE_NXZ+0x2a
//   <- ~GrDirectContext <- d3d_drop_gpu_state <- d3d_mark_lost("Present") <- sk_gpu_flush
// and had the close been harmless, the fence wait right after it would have hung the
// window instead (AppHangB1). GrDirectContext exposes no "destroy without teardown"
// entry point, so on a lost device the context is PARKED: the last reference is
// released without ever being freed. One loss costs one context (~KB; the resource
// cache was emptied by abandonContext) and the rebuild below creates a fresh one.
static void d3d_drop_gpu_state(int device_gone) {
  for (int i = 0; i < SK_D3D_MAX_WINDOWS; ++i) {
    D3DWin* w = &g_d3d[i];
    for (int b = 0; b < SK_D3D_NUM_FRAMES; ++b) {
      w->surfaces[b].reset();
      w->buffers[b].reset();
    }
    if (w->fence_event != NULL) CloseHandle(w->fence_event);
    w->fence_event = NULL;
    w->fence.reset();
    w->swapchain.reset();
    // used/hwnd/width/height are deliberately kept: the WINDOW still exists, so a
    // rebuild re-creates its swapchain at the same size instead of treating it as
    // closed (sk_gpu_destroy is the only path that clears `used`).
  }
  if (g_context != nullptr) {
    g_context->abandonContext();
    if (device_gone) {
      // Deliberate leak, for the reason spelled out above: the destructor would close
      // a command list and wait on a fence of the removed device.
      GrDirectContext* parked = g_context.release();
      fprintf(stderr,
              "d3d_glue: parking the lost GrDirectContext (%p) instead of destroying "
              "it: its destructor closes a command list and waits on a fence of the "
              "removed device\n",
              (void*)parked);
      fflush(stderr);
    } else {
      g_context.reset();
    }
  }
  g_queue.reset();
  g_device.reset();
  g_adapter.reset();
}

// Enter the lost state. Must run BEFORE anything else touches Skia after a failing
// call: the Present/ResizeBuffers failure is only the symptom, and the next flush()
// would go on to record into the removed device.
// The removal reason DXGI reports, in words. GetDeviceRemovedReason() is the only
// thing that distinguishes "the driver was reset under us" (DEVICE_RESET/DEVICE_HUNG,
// a TDR: something -- ours or the compositor's -- held one submission too long) from
// "we ran the GPU out of memory" (OUTOFMEMORY: a texture or buffer that is too big,
// e.g. a shared-screen frame or a very large bitmap) from "the driver crashed"
// (DRIVER_INTERNAL_ERROR). Without it the log says only 0x887A0005, which is the same
// code for all of them.
static const char* d3d_removed_reason_name(HRESULT reason) {
  switch (reason) {
    case S_OK: return "not removed";
    case DXGI_ERROR_DEVICE_HUNG: return "DEVICE_HUNG (a submission did not finish in time)";
    case DXGI_ERROR_DEVICE_REMOVED: return "DEVICE_REMOVED (hardware/driver reset)";
    case DXGI_ERROR_DEVICE_RESET: return "DEVICE_RESET (bad command or driver reset)";
    case DXGI_ERROR_DRIVER_INTERNAL_ERROR: return "DRIVER_INTERNAL_ERROR";
    case E_OUTOFMEMORY: return "OUTOFMEMORY (video memory exhausted)";
    case DXGI_ERROR_INVALID_CALL: return "INVALID_CALL";
    default: return "unrecognised";
  }
}

// Stage3D borrows this device and queue. Notify it through the same by-name seam
// it uses to find them: its frames must stop while lost, and its context must be
// rebound after recovery instead of submitting into the removed queue forever.
static void d3d_notify_stage3d(const char* name) {
  HMODULE module = GetModuleHandleA(NULL);
  if (module == NULL) return;
  void (*notify)(void) = (void (*)(void))GetProcAddress(module, name);
  if (notify != NULL) notify();
}

static void d3d_mark_lost(const char* what, HRESULT hr) {
  if (g_d3d_lost) return;
  g_d3d_lost = 1;
  g_d3d_retry_ms = 250;
  g_d3d_retry_at = d3d_now_ms() + (double)g_d3d_retry_ms;
  fprintf(stderr,
          "d3d_glue: GPU device lost (%s, 0x%08lx): dropping every GPU object; "
          "frames are skipped and the device is rebuilt in %d ms\n",
          what, (unsigned long)hr, g_d3d_retry_ms);
  // Asked BEFORE the device is released below.
  if (g_device.get() != nullptr) {
    const HRESULT reason = g_device->GetDeviceRemovedReason();
    fprintf(stderr, "d3d_glue: device removed reason 0x%08lx: %s\n",
            (unsigned long)reason, d3d_removed_reason_name(reason));
  }
  fflush(stderr);
  // The caller of d3d_mark_lost is by definition a call that failed because the
  // device is gone, so the teardown must not go through Skia (see the note above
  // d3d_drop_gpu_state).
  d3d_notify_stage3d("s3d_shared_device_lost");
  d3d_drop_gpu_state(1);
}

// Progress trace for the backend's init sequence. Without it a hang inside
// d3d_init_shared prints NOTHING at all (the window exists and the app never reaches
// its event loop), which is indistinguishable from a hang in the window layer.
// ASC_GPU_TRACE=1 turns it on.
static void gpu_trace(const char* what) {
  if (getenv("ASC_GPU_TRACE") == nullptr) return;
  fprintf(stderr, "d3d_glue: trace %s\n", what);
  fflush(stderr);
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
  gpu_trace("factory");

  g_adapter.reset(d3d_hardware_adapter(factory.get()));
  if (g_adapter.get() == nullptr) {
    fprintf(stderr, "d3d_glue: no adapter can create a Direct3D 12 device\n");
    return 0;
  }
  gpu_trace("adapter");

  D3D_OK_OR_WARN(D3D12CreateDevice(g_adapter.get(), D3D_FEATURE_LEVEL_11_0,
                                   IID_PPV_ARGS(&g_device)));
  if (g_device.get() == nullptr) return 0;
  gpu_trace("device");

  D3D12_COMMAND_QUEUE_DESC qd = {};
  qd.Flags = D3D12_COMMAND_QUEUE_FLAG_NONE;
  qd.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
  D3D_OK_OR_WARN(g_device->CreateCommandQueue(&qd, IID_PPV_ARGS(&g_queue)));
  if (g_queue.get() == nullptr) return 0;
  gpu_trace("queue");

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
  gpu_trace("GrDirectContext");
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

    HRESULT ghr = w->swapchain->GetBuffer((UINT)i, IID_PPV_ARGS(&w->buffers[i]));
    if (FAILED(ghr)) {
      fprintf(stderr, "d3d_glue: GetBuffer(%d) failed: 0x%08lx\n", i, (unsigned long)ghr);
      fflush(stderr);
      // Return immediately after marking: dropping the state reset w->swapchain,
      // so the next iteration must not dereference it.
      if (d3d_hr_is_device_lost(ghr)) d3d_mark_lost("GetBuffer", ghr);
      return 0;
    }

    // GrD3DTextureResourceInfo(resource, alloc, state, format, sampleCount,
    // levelCount, sampleQualityLevel, protected). `alloc` is null because the
    // swapchain owns the resource (Skia must not try to free it), and the state
    // is PRESENT because that is the state DXGI hands a back buffer back in.
    // sampleQualityLevel is 0 (the standard pattern, matching Skia's own
    // D3D12WindowContext_win.cpp reference) and protected is kNo.
    GrD3DTextureResourceInfo info(nullptr, nullptr,
                                  D3D12_RESOURCE_STATE_PRESENT,
                                  SK_D3D_SWAPCHAIN_FORMAT,
                                  1, 1, 0, GrProtected::kNo);
    // NOT the (resource, ...) constructor: that one ADOPTS the bare pointer without
    // AddRef while its destructor still Releases (see the ownership note below), so
    // it would eat the reference w->buffers[i] believes it holds -- a double release
    // the moment the surface is dropped. retain() Adds its own ref instead, which is
    // what Skia's own D3D12WindowContext_win.cpp does (`info.fResource = fBuffers[i]`).
    info.fResource.retain(w->buffers[i].get());
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

// Create (or re-create) one window's swapchain, back buffers, SkSurfaces and frame
// fence. Called by sk_gpu_init for the first bind and by d3d_rebuild_all after a
// device-lost, which is why the size is a parameter: a rebuild must land at the
// size the AS3 side last asked for, not re-read a window that may be mid-resize.
static int d3d_create_swapchain(D3DWin* w, HWND hwnd, int cw, int ch) {
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
  sd.Scaling = DXGI_SCALING_NONE;
  sd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
  sd.SampleDesc.Count = 1;

  gr_cp<IDXGISwapChain1> swapchain;
  D3D_OK_OR_WARN(factory->CreateSwapChainForHwnd(g_queue.get(), hwnd, &sd, nullptr,
                                                 nullptr, &swapchain));
  if (swapchain.get() == nullptr) {
    fprintf(stderr, "d3d_glue: CreateSwapChainForHwnd failed\n");
    return 0;
  }
  D3D_OK_OR_WARN(factory->MakeWindowAssociation(hwnd, DXGI_MWA_NO_ALT_ENTER));
  D3D_OK_OR_WARN(swapchain->QueryInterface(IID_PPV_ARGS(&w->swapchain)));
  if (w->swapchain.get() == nullptr) return 0;

  w->hwnd = hwnd;
  w->width = cw;
  w->height = ch;
  w->buffer_index = w->swapchain->GetCurrentBackBufferIndex();

  if (!d3d_setup_surfaces(w)) { w->swapchain.reset(); return 0; }

  // Fence values start high so they stand out in a PIX capture (Skia's reference
  // does the same); only their ordering matters.
  for (int i = 0; i < SK_D3D_NUM_FRAMES; ++i) w->fence_values[i] = 10000;
  D3D_OK_OR_WARN(g_device->CreateFence(w->fence_values[w->buffer_index],
                                       D3D12_FENCE_FLAG_NONE,
                                       IID_PPV_ARGS(&w->fence)));
  if (w->fence.get() == nullptr) return 0;
  w->fence_event = CreateEvent(NULL, FALSE, FALSE, NULL);
  if (w->fence_event == NULL) return 0;
  return 1;
}

// Wait until neither this window's GPU submissions nor its presented buffers are
// still in flight. Releasing a live swapchain without this drain leaves DXGI with
// an old swapchain for the HWND: CreateSwapChainForHwnd then alternates between
// E_ACCESSDENIED and a short-lived replacement whose next Present runs out of
// resources. A timeout leaves the old state intact so a later frame can retry.
static int d3d_drain_window(D3DWin* w) {
  if (g_context != nullptr) {
    g_context->flush();
    g_context->submit(GrSyncCpu::kYes);
  }
  for (int i = 0; i < SK_D3D_NUM_FRAMES; ++i) {
    if (w->fence.get() != nullptr && w->fence_event != NULL &&
        w->fence->GetCompletedValue() < w->fence_values[i]) {
      D3D_OK_OR_WARN(w->fence->SetEventOnCompletion(w->fence_values[i], w->fence_event));
      if (WaitForSingleObjectEx(w->fence_event, SK_D3D_DRAIN_MS, FALSE) != WAIT_OBJECT_0) {
        return 0;
      }
    }
  }
  return 1;
}

// ResizeBuffers can fail even while the device remains healthy (the real app hits
// E_OUTOFMEMORY after a device rebuild followed by minimize/restore). The old
// buffers have already been released at that point, so retrying ResizeBuffers on
// the same swapchain forever cannot make progress. Recreate only this window's
// swapchain and fence; other windows and the shared device stay alive.
static int d3d_recreate_window(D3DWin* w, int width, int height) {
  const double now = d3d_now_ms();
  if (now < w->recreate_retry_at) return 0;
  if (!d3d_drain_window(w)) {
    w->recreate_retry_at = now + (double)SK_D3D_DRAIN_MS;
    return 0;
  }
  for (int i = 0; i < SK_D3D_NUM_FRAMES; ++i) {
    w->surfaces[i].reset();
    w->buffers[i].reset();
  }
  if (w->fence_event != NULL) CloseHandle(w->fence_event);
  w->fence_event = NULL;
  w->fence.reset();
  w->swapchain.reset();
  if (d3d_create_swapchain(w, w->hwnd, width, height)) {
    w->recreate_retry_at = 0.0;
    fprintf(stderr, "d3d_glue: window swapchain recreated at %dx%d\n", width, height);
    fflush(stderr);
    return 1;
  }
  // A later begin_frame retries through the null-swapchain gate below. Keeping
  // used/hwnd preserves the identity of the still-live SDL window. Back off instead
  // of calling CreateSwapChainForHwnd again on every frame while DXGI is busy.
  w->width = 0;
  w->height = 0;
  w->recreate_retry_at = now + 250.0;
  return 0;
}

// Rebuild everything the device carried. Returns 1 only when the whole set is back;
// a partial success is dropped again so the next attempt starts clean (a window
// holding a swapchain against a device about to be discarded would be the same bug
// one level down).
static int d3d_rebuild_all(void) {
  // d3d_device_gone(), not 1: the context dropped here may be the fresh one just
  // created by d3d_init_shared (the swapchain then failed for an unrelated reason),
  // and destroying a context on a healthy device is the normal, freeing path.
  if (!d3d_init_shared()) { d3d_drop_gpu_state(d3d_device_gone()); return 0; }
  for (int i = 0; i < SK_D3D_MAX_WINDOWS; ++i) {
    if (!g_d3d[i].used) continue;
    if (!d3d_create_swapchain(&g_d3d[i], g_d3d[i].hwnd, g_d3d[i].width, g_d3d[i].height)) {
      d3d_drop_gpu_state(d3d_device_gone());
      return 0;
    }
  }
  return 1;
}

// The throttled rebuild attempt. A device that vanished under VRAM pressure can be
// taken away again right after being recreated, so retries back off to 4 s instead
// of calling D3D12CreateDevice on every skipped frame.
static int d3d_try_recover(void) {
  const double now = d3d_now_ms();
  if (now < g_d3d_retry_at) return 0;
  if (d3d_rebuild_all()) {
    d3d_notify_stage3d("s3d_shared_device_rebuilt");
    g_d3d_lost = 0;
    g_d3d_rebuilds++;
    g_d3d_retry_ms = 250;
    fprintf(stderr, "d3d_glue: GPU device rebuilt (attempt %d); rendering resumed\n",
            g_d3d_rebuilds);
    fflush(stderr);
    return 1;
  }
  g_d3d_retry_ms = g_d3d_retry_ms * 2 > 4000 ? 4000 : g_d3d_retry_ms * 2;
  g_d3d_retry_at = now + (double)g_d3d_retry_ms;
  fprintf(stderr, "d3d_glue: GPU device rebuild failed; next attempt in %d ms\n",
          g_d3d_retry_ms);
  fflush(stderr);
  return 0;
}

// --- shipping the backend to the Stage3D glue ------------------------------
//
// vendor/stage3d_d3d.cc renders the Stage3D frame on ITS OWN D3D12 command list,
// but must submit it to THIS file's queue: the Skia composite samples the Stage3D
// render target on the next submission to the same queue, and a shared queue is
// what turns "submitted earlier" into "the GPU has the pixels" with no CPU wait.
// That is exactly the contract metal_glue.mm exposes as sk_mtl_shared_queue and
// stage3d_glue.mm picks up with a weak dlsym lookup; the D3D counterpart is below.
//
// The accessors are looked up by NAME (GetProcAddress on the main module) rather
// than linked: a build may link stage3d_d3d.cc without the window backend at all
// (D3D12 on a machine with no GPU window, i.e. a headless readback build), and a
// hard reference would then be an unresolved external in every such build.
//
// __declspec(dllexport) is what makes that by-name lookup possible at all: a PE image has no RTLD_DEFAULT equivalent, so GetProcAddress only finds symbols listed in the executable's own export directory. (With __cdecl on i686 the exported name is the undecorated one, which is what stage3d_d3d.cc asks for.)
__declspec(dllexport) extern "C" ID3D12Device* sk_d3d_shared_device(void) { return g_device.get(); }
__declspec(dllexport) extern "C" ID3D12CommandQueue* sk_d3d_shared_queue(void) { return g_queue.get(); }

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
  // A window created while the device is lost must not be the one that gets a
  // swapchain against a dead device: try the rebuild first (throttled; on failure
  // the caller refuses the window rather than binding it to nothing).
  if (g_d3d_lost && !d3d_try_recover()) return 0;
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
  if (!d3d_create_swapchain(&g_d3d[win_id], hwnd,
                            (int)(rc.right - rc.left), (int)(rc.bottom - rc.top))) {
    return 0;
  }
  gpu_trace("surfaces");

  g_d3d[win_id].used = 1;
  fprintf(stderr, "d3d_glue: window %d bound to %dx%d R8G8B8A8 swapchain\n",
          win_id, g_d3d[win_id].width, g_d3d[win_id].height);
  return 1;
}

// Release one window's GPU state. The shared backend goes when the last GPU
// window does — after an explicit CPU sync, so no frame is still in flight against
// a device we are about to drop.
void sk_gpu_destroy(int win_id) {
  D3DWin* w = d3d_slot(win_id);
  // A device DXGI has taken away must not be flushed, waited on, or torn down through
  // Skia (see the note above d3d_drop_gpu_state). d3d_device_gone() is a local query,
  // so this also covers a window closed on the very frame the device went away --
  // before any frame got the chance to mark the loss -- where the fence wait below
  // would otherwise block forever on a queue that will never signal.
  const int device_gone = d3d_device_gone();
  if (w != nullptr) {
    // The queue may still be executing the last present of this window; drain it
    // before anything it reads is released.
    if (!device_gone && g_context != nullptr) {
      g_context->flush();
      g_context->submit(GrSyncCpu::kYes);
    }
    for (int i = 0; i < SK_D3D_NUM_FRAMES; ++i) {
      if (!device_gone && w->fence.get() != nullptr && w->fence_event != NULL &&
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
  if (device_gone) {
    // Same rule as the lost path: nothing Skia owns may be destroyed on a removed
    // device. This is also what releases the shared device/queue/adapter.
    d3d_drop_gpu_state(1);
    return;
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
  // ASC_GPU_LOSE_AT=<frame>: remove the device on purpose. ID3D12Device5::RemoveDevice()
  // puts it into the same removed state a TDR does (GetDeviceRemovedReason() then
  // answers DXGI_ERROR_DEVICE_REMOVED), which is what makes the recovery path testable
  // at all: the whole reason it needs a test is that a mistake in it is an access
  // violation inside Skia, and no synthetic flag reproduces that -- only a device that
  // is really gone does.
  if (g_d3d_lose_at < 0) {
    const char* loseAt = getenv("ASC_GPU_LOSE_AT");
    g_d3d_lose_at = loseAt != nullptr ? atol(loseAt) : 0;
  }
  if (g_d3d_lose_at > 0 && !g_d3d_lost && g_device.get() != nullptr &&
      ++g_d3d_frames_seen == g_d3d_lose_at) {
    gr_cp<ID3D12Device5> dev5;
    if (SUCCEEDED(g_device->QueryInterface(IID_PPV_ARGS(&dev5))) && dev5.get() != nullptr) {
      fprintf(stderr, "d3d_glue: ASC_GPU_LOSE_AT=%ld -- removing the device on purpose\n",
              g_d3d_lose_at);
      fflush(stderr);
      dev5->RemoveDevice();
      // Straight into the lost path: the reconcile logic further down would wait on a
      // fence this device can no longer reach.
      d3d_mark_lost("ASC_GPU_LOSE_AT", DXGI_ERROR_DEVICE_REMOVED);
      return nullptr;
    }
  }
  // THE device-lost gate. GetDeviceRemovedReason() is a local query (nothing is
  // submitted), so asking it every frame costs one call and catches the removal
  // BEFORE Present/ResizeBuffers have to fail -- the frames between those two
  // events are the ones that used to crash inside Skia.
  if (!g_d3d_lost && g_device.get() != nullptr) {
    HRESULT removed = g_device->GetDeviceRemovedReason();
    if (FAILED(removed)) d3d_mark_lost("GetDeviceRemovedReason", removed);
  }
  if (g_d3d_lost && !d3d_try_recover()) return nullptr;
  D3DWin* w = d3d_slot(win_id);
  if (w == nullptr || g_context == nullptr) return nullptr;
  if (width <= 0 || height <= 0) return nullptr;
  if (w->swapchain.get() == nullptr && !d3d_recreate_window(w, width, height)) return nullptr;

  // A resize invalidates every back buffer. This is where a live window drag
  // lands, and it is the D3D analogue of Metal's per-frame drawableSize update:
  // the frame target is rebuilt rather than reused.
  if (width != w->width || height != w->height) {
    if (g_context != nullptr) {
      g_context->flush();
      g_context->submit(GrSyncCpu::kYes);
    }
    int drained = 1;
    for (int i = 0; i < SK_D3D_NUM_FRAMES; ++i) {
      if (w->fence.get() != nullptr && w->fence_event != NULL &&
          w->fence->GetCompletedValue() < w->fence_values[i]) {
        D3D_OK_OR_WARN(w->fence->SetEventOnCompletion(w->fence_values[i], w->fence_event));
        if (WaitForSingleObjectEx(w->fence_event, SK_D3D_DRAIN_MS, FALSE) != WAIT_OBJECT_0) {
          drained = 0;
          break;
        }
      }
    }
    if (!drained) {
      // The GPU is still reading an old back buffer and the compositor has not let
      // go of it (see SK_D3D_DRAIN_MS). Nothing has been released yet, so the only
      // safe move is to abandon this frame: the swapchain and every surface stay
      // exactly as they were and the next frame retries the resize. Reported once,
      // not once per frame -- a stall lasts as long as the drag does.
      static int told = 0;
      if (!told) {
        told = 1;
        fprintf(stderr, "d3d_glue: resize to %dx%d timed out after %d ms waiting for the "
                        "GPU to release the old back buffers; skipping frames until it "
                        "does\n", width, height, SK_D3D_DRAIN_MS);
        fflush(stderr);
      }
      return nullptr;
    }
    for (int i = 0; i < SK_D3D_NUM_FRAMES; ++i) {
      w->surfaces[i].reset();
      w->buffers[i].reset();
    }
    // ASC_GPU_RESIZE_FAIL=1 injects one healthy-device E_OUTOFMEMORY so the
    // per-window recovery path is executable without waiting for a driver/TDR.
    static int injectedResizeFailure = 0;
    HRESULT rhr;
    if (!injectedResizeFailure && getenv("ASC_GPU_RESIZE_FAIL") != nullptr) {
      injectedResizeFailure = 1;
      rhr = E_OUTOFMEMORY;
    } else {
      rhr = w->swapchain->ResizeBuffers(0, (UINT)width, (UINT)height,
                                        SK_D3D_SWAPCHAIN_FORMAT, 0);
    }
    if (FAILED(rhr)) {
      fprintf(stderr, "d3d_glue: ResizeBuffers to %dx%d failed: 0x%08lx\n",
              width, height, (unsigned long)rhr);
      fflush(stderr);
      if (d3d_hr_is_device_lost(rhr)) {
        d3d_mark_lost("ResizeBuffers", rhr);
      } else {
        // The device is still alive. Do not spin on a swapchain whose old back
        // buffers have just been released: replace it and resume on the next frame.
        d3d_recreate_window(w, width, height);
      }
      return nullptr;
    }
    w->width = width;
    w->height = height;
    if (!d3d_setup_surfaces(w)) return nullptr;
    // Deliberately NOT
    //   w->buffer_index = w->swapchain->GetCurrentBackBufferIndex();
    // here. The next begin_frame re-reads the index anyway, and reading it early is
    // what corrupted the fence ledger: begin_frame takes the value to count up from
    // out of the slot named by w->buffer_index, so pointing that at a rebuilt
    // swapchain's current index -- which is whichever buffer the resize happened to
    // land on, not the one just presented -- can name an OLDER slot, and the value
    // assigned to the new buffer is then one the fence has already passed. Signal()
    // on a passed value is a no-op (a fence never moves backwards), so that buffer
    // loses the "the GPU is finished with me" marker the acquire wait below relies
    // on, and the next resize (whose drain waits for every slot) blocks on a value
    // that no longer means anything. Measured before this line was removed: the
    // window wedged solid after three corner-resize steps. Leaving the index alone
    // keeps every assigned value strictly greater than every value signalled before
    // it, which is what makes each wait reachable.
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
  if (g_d3d_stats_on < 0) g_d3d_stats_on = getenv("ASC_GPU_STATS") != NULL ? 1 : 0;
  if (g_d3d_stats_on > 0) g_d3d_work_t0 = d3d_now_ms();
  return (void*)s->getCanvas();
}

// Debug: write the just-drawn back buffer to a 24-bit BMP.
//
// A flip-model swapchain's content CANNOT be screen-captured: GDI/BitBlt and most
// screen grabbers see a stale or black surface because the presented image never
// passes through the window's GDI surface. Without this dump a headless run has no
// way to tell "composited correctly" from "drew nothing" -- the two look identical
// in a screenshot. The copy is a plain back-buffer -> READBACK-buffer read on the
// SAME queue, before Present, and it puts the resource back in PRESENT when done.
//
// ASC_GPU_DUMP   = output .bmp path (no dump unless set)
// ASC_GPU_DUMP_AT = frame index to dump (default 30: the demo has its assets loaded)
static void d3d_dump_backbuffer(D3DWin* w) {
  const char* out = getenv("ASC_GPU_DUMP");
  if (out == nullptr || out[0] == '\0') return;
  static long n = 0;
  const char* atEnv = getenv("ASC_GPU_DUMP_AT");
  const long at = atEnv != nullptr ? atol(atEnv) : 30;
  static int done = 0;
  if (done || n++ < at) return;
  done = 1;

  ID3D12Resource* bb = w->buffers[w->buffer_index].get();
  if (bb == nullptr) { fprintf(stderr, "ASC_GPU_DUMP: no back buffer\n"); fflush(stderr); return; }
  const UINT width = (UINT)w->width, height = (UINT)w->height;
  if (width == 0 || height == 0) { fprintf(stderr, "ASC_GPU_DUMP: zero size\n"); fflush(stderr); return; }
  // CopyTextureRegion only accepts a 256-byte-aligned row pitch.
  const UINT rowPitch = (width * 4u + 255u) & ~255u;

  gr_cp<ID3D12CommandAllocator> alloc;
  gr_cp<ID3D12GraphicsCommandList> list;
  gr_cp<ID3D12Resource> rb;
  gr_cp<ID3D12Fence> fence;
  if (FAILED(g_device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&alloc)))) { fprintf(stderr, "ASC_GPU_DUMP: allocator\n"); fflush(stderr); return; }
  if (FAILED(g_device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, alloc.get(), nullptr, IID_PPV_ARGS(&list)))) { fprintf(stderr, "ASC_GPU_DUMP: list\n"); fflush(stderr); return; }
  D3D12_HEAP_PROPERTIES hp = {};
  hp.Type = D3D12_HEAP_TYPE_READBACK;
  D3D12_RESOURCE_DESC bd = {};
  bd.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
  bd.Width = (UINT64)rowPitch * height;
  bd.Height = 1;
  bd.DepthOrArraySize = 1;
  bd.MipLevels = 1;
  bd.SampleDesc.Count = 1;
  bd.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
  if (FAILED(g_device->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &bd,
                                               D3D12_RESOURCE_STATE_COPY_DEST, nullptr,
                                               IID_PPV_ARGS(&rb)))) { fprintf(stderr, "ASC_GPU_DUMP: readback resource\n"); fflush(stderr); return; }
  if (FAILED(g_device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence)))) { fprintf(stderr, "ASC_GPU_DUMP: fence\n"); fflush(stderr); return; }

  // Skia's kPresent flush left the back buffer in PRESENT, and DXGI needs it back
  // there before the Present(1,0) that follows in sk_gpu_flush.
  D3D12_RESOURCE_BARRIER bar = {};
  bar.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
  bar.Transition.pResource = bb;
  bar.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
  bar.Transition.StateBefore = D3D12_RESOURCE_STATE_PRESENT;
  bar.Transition.StateAfter = D3D12_RESOURCE_STATE_COPY_SOURCE;
  list->ResourceBarrier(1, &bar);
  D3D12_TEXTURE_COPY_LOCATION src = {};
  src.pResource = bb;
  src.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
  src.SubresourceIndex = 0;
  D3D12_TEXTURE_COPY_LOCATION dst = {};
  dst.pResource = rb.get();
  dst.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
  dst.PlacedFootprint.Footprint.Format = SK_D3D_SWAPCHAIN_FORMAT;
  dst.PlacedFootprint.Footprint.Width = width;
  dst.PlacedFootprint.Footprint.Height = height;
  dst.PlacedFootprint.Footprint.Depth = 1;
  dst.PlacedFootprint.Footprint.RowPitch = rowPitch;
  list->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);
  bar.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_SOURCE;
  bar.Transition.StateAfter = D3D12_RESOURCE_STATE_PRESENT;
  list->ResourceBarrier(1, &bar);
  if (FAILED(list->Close())) { fprintf(stderr, "ASC_GPU_DUMP: close\n"); fflush(stderr); return; }
  ID3D12CommandList* lists[1] = { list.get() };
  g_queue->ExecuteCommandLists(1, lists);
  D3D_OK_OR_WARN(g_queue->Signal(fence.get(), 1));
  for (int spin = 0; spin < 20000; ++spin) {
    if (fence->GetCompletedValue() >= 1) break;
    Sleep(1);
  }

  void* mapped = nullptr;
  const D3D12_RANGE readRange = { 0, (SIZE_T)rowPitch * height };
  if (FAILED(rb->Map(0, &readRange, &mapped)) || mapped == nullptr) { fprintf(stderr, "ASC_GPU_DUMP: map\n"); fflush(stderr); return; }

  const UINT rowBytes = ((width * 3u + 3u) & ~3u);
  const UINT dataBytes = rowBytes * height;
  const UINT fileBytes = 54u + dataBytes;
  FILE* f = fopen(out, "wb");
  if (f == nullptr) {
    fprintf(stderr, "d3d_glue: ASC_GPU_DUMP: cannot open %s\n", out);
  } else {
    unsigned char hdr[54] = { 0 };
    hdr[0] = 'B'; hdr[1] = 'M';
    memcpy(hdr + 2, &fileBytes, 4);
    const unsigned int off = 54, hsz = 40;
    memcpy(hdr + 10, &off, 4);
    memcpy(hdr + 14, &hsz, 4);
    const int iw = (int)width, ih = -(int)height;   // negative height = top-down rows
    memcpy(hdr + 18, &iw, 4);
    memcpy(hdr + 22, &ih, 4);
    const unsigned short planes = 1, bpp = 24;
    memcpy(hdr + 26, &planes, 2);
    memcpy(hdr + 28, &bpp, 2);
    memcpy(hdr + 34, &dataBytes, 4);
    fwrite(hdr, 1, sizeof hdr, f);
    const unsigned char* px = (const unsigned char*)mapped;
    for (UINT y = 0; y < height; ++y) {
      const unsigned char* row = px + (SIZE_T)y * rowPitch;
      for (UINT x = 0; x < width; ++x) {
        // R8G8B8A8 in memory -> B,G,R in the file.
        const unsigned char bgr[3] = { row[x * 4 + 2], row[x * 4 + 1], row[x * 4 + 0] };
        fwrite(bgr, 1, 3, f);
      }
      const unsigned char pad[3] = { 0, 0, 0 };
      if (rowBytes > width * 3u) fwrite(pad, 1, rowBytes - width * 3u, f);
    }
    fclose(f);
    fprintf(stderr, "d3d_glue: ASC_GPU_DUMP wrote %s (%ux%u)\n", out, width, height);
  }
  rb->Unmap(0, nullptr);
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

  // Before Present below, which is where the frame blocks on the display.
  d3d_stats_frame_done();

  d3d_dump_backbuffer(w);

  // NOT D3D_OK_OR_WARN: a failed Present is the one place the old
  // print-and-continue behaviour killed the process (frames kept being recorded
  // into a removed device). Report, then enter the lost path -- which drops every
  // GPU object before the next frame can touch Skia -- and do not signal a fence
  // the dead queue will never reach.
  // ASC_GPU_PRESENT_FAIL=1 injects one healthy-device Present failure so the
  // drain-before-recreate path is testable without waiting for a driver/TDR.
  static int injectedPresentFailure = 0;
  HRESULT phr;
  if (!injectedPresentFailure && getenv("ASC_GPU_PRESENT_FAIL") != nullptr) {
    injectedPresentFailure = 1;
    phr = E_OUTOFMEMORY;
  } else {
    phr = w->swapchain->Present(1, 0);
  }
  if (FAILED(phr)) {
    const HRESULT presentReason = g_device.get() != nullptr ? g_device->GetDeviceRemovedReason() : E_FAIL;
    fprintf(stderr, "d3d_glue: Present failed: 0x%08lx win=%d hwnd=%p hwndAlive=%d deviceReason=0x%08lx\n",
            (unsigned long)phr, win_id, (void*)w->hwnd, w->hwnd != NULL && IsWindow(w->hwnd),
            (unsigned long)presentReason);
    fflush(stderr);
    if (d3d_hr_is_device_lost(phr)) {
      d3d_mark_lost("Present", phr);
    } else {
      // The device and queue are still alive and this frame's GPU commands were
      // already submitted. Retire its fence before draining: otherwise the next
      // acquire waits forever for a value that the failed-Present return skipped.
      D3D_OK_OR_WARN(g_queue->Signal(w->fence.get(), w->fence_values[w->buffer_index]));
      // A healthy device with a failed present has no reliable old swapchain to
      // keep submitting to. Recover this window instead of logging E_FAIL forever.
      d3d_recreate_window(w, w->width, w->height);
    }
    return;
  }
  // Mark this frame's completion on the queue so the next begin_frame for this
  // buffer index can wait for it (see above). Signaling AFTER Present is what
  // makes the wait meaningful: the fence reaching this value means DXGI has
  // finished reading the buffer.
  D3D_OK_OR_WARN(g_queue->Signal(w->fence.get(), w->fence_values[w->buffer_index]));
}

// Composite an externally-owned D3D12 texture (an ID3D12Resource) onto the current
// canvas — the Stage3D -> window blit, and the D3D counterpart of metal_glue.mm's
// sk_mtl_draw_texture. Its only caller is the generated C's ASC_window_render
// (`as_skia_gpu_draw_texture(canvas, ASC_stage3d_tex, ...)`), where
// ASC_stage3d_tex is exactly the pointer s3d_get_render_target handed over.
//
// The contract with vendor/stage3d_d3d.cc (two things this file cannot obtain for
// itself, which is why it used to refuse instead of guessing):
//   * the resource is a single-level, single-sample 2D texture — read from the
//     resource's own D3D12_RESOURCE_DESC (its DXGI_FORMAT included), so the format
//     is NOT assumed; an sRGB or multi-sample resource is refused loudly rather
//     than sampled wrong;
//   * the resource is in D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE, which the
//     Stage3D glue guarantees as its frame invariant (it ends every frame's
//     command list by transitioning the current render target there) precisely so
//     that this wrapper needs no state of its own.
//
// Skia tracks the state of a texture it wraps and inserts the barrier itself, so
// passing the true state is what keeps the two sides from double-transitioning.
// The image is borrowed for one draw and dropped immediately after it: it wraps a
// resource the Stage3D context owns, so nothing here may outlive the draw.
void sk_gpu_draw_texture(void* canvas, void* d3dTexture, int w, int h,
                         double dx, double dy, double dw, double dh) {
  if (canvas == nullptr || d3dTexture == nullptr || g_context == nullptr) return;
  if (w <= 0 || h <= 0) return;
  ID3D12Resource* res = (ID3D12Resource*)d3dTexture;

  // Stage3D keeps its context across a window-device rebuild. Its old target must
  // never be sampled by the new device: that cross-device submission is what turned
  // one recovered DEVICE_HUNG into E_OUTOFMEMORY and then E_FAIL on every Present.
  gr_cp<ID3D12Device> owner;
  const HRESULT ownerHr = res->GetDevice(IID_PPV_ARGS(&owner));
  if (FAILED(ownerHr) || owner.get() != g_device.get()) {
    static int staleReported = 0;
    if (!staleReported) {
      staleReported = 1;
      fprintf(stderr, "d3d_glue: skipping a Stage3D texture from the previous device\n");
      fflush(stderr);
    }
    return;
  }

  const D3D12_RESOURCE_DESC rd = res->GetDesc();
  if (getenv("ASC_S3D_TRACE") != nullptr) {
      fprintf(stderr, "d3d_glue: draw_texture res=%p fmt=%d samples=%u dw=%llu dh=%llu w=%d h=%d\n",
              (void*)res, (int)rd.Format, (unsigned)rd.SampleDesc.Count,
              (unsigned long long)rd.Width, (unsigned long long)rd.Height, w, h);
  }
  SkColorType ct = kUnknown_SkColorType;
  if (rd.Format == DXGI_FORMAT_B8G8R8A8_UNORM) ct = kBGRA_8888_SkColorType;
  else if (rd.Format == DXGI_FORMAT_R8G8B8A8_UNORM) ct = kRGBA_8888_SkColorType;
  if (ct == kUnknown_SkColorType || rd.SampleDesc.Count != 1) {
    static int warned = 0;
    if (!warned || getenv("ASC_S3D_TRACE") != nullptr) {
      warned = 1;
      fprintf(stderr, "d3d_glue: sk_gpu_draw_texture: unsupported render target "
                      "(dxgi format %d, %u samples); nothing was drawn\n",
              (int)rd.Format, (unsigned)rd.SampleDesc.Count);
      fflush(stderr);
    }
    return;
  }

  // Ownership contract of Skia's D3D backend (include/gpu/d3d/GrD3DTypes.h):
  //   "there is no notion of Borrowed or Adopted resources in the D3D backend, so
  //    Ganesh will ref fResource once it's asked to wrap it. Clients are responsible
  //    for releasing their own ref to avoid memory leaks."
  // GrD3DTextureResourceInfo::fResource is a gr_cp, and building the struct from a
  // BARE pointer ADOPTS that pointer without AddRef -- while its destructor Releases.
  // Passing our only reference in via that constructor therefore silently drops the
  // Stage3D context's reference to the render target: the resource is freed when this
  // function returns and its address is recycled by the next allocation. Measured
  // failure mode: frame 1's composite is fine, frame 2 reads a 144-byte vertex BUFFER
  // where the 1000x600 texture was, and sk_gpu_draw_texture refuses it
  // ("unsupported render target (dxgi format 0, 1 samples); nothing was drawn").
  // retain() is the balanced recipe -- it AddRefs into the struct and the struct's
  // destructor releases that reference -- exactly like Skia's own
  // tools/window/win/D3D12WindowContext_win.cpp (`info.fResource = fBuffers[i]`).
  GrD3DTextureResourceInfo info(nullptr, nullptr,
                               D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE,
                               rd.Format, 1, 1, 0, GrProtected::kNo);
  info.fResource.retain(res);
  GrBackendTexture beTex(w, h, info);
  // BGRA8 render targets hold straight-ish premultiplied Stage3D output (Starling
  // blends premultiplied), which is also the alpha type the 2D display list uses.
  sk_sp<SkImage> img = SkImages::BorrowTextureFrom(g_context.get(), beTex,
                                                   kTopLeft_GrSurfaceOrigin, ct,
                                                   kPremul_SkAlphaType, nullptr);
  if (img == nullptr) {
    static int warned = 0;
    if (!warned) {
      warned = 1;
      fprintf(stderr, "d3d_glue: sk_gpu_draw_texture: BorrowTextureFrom failed; "
                      "nothing was drawn\n");
      fflush(stderr);
    }
    return;
  }

  SkCanvas* c = (SkCanvas*)canvas;
  SkRect dst = SkRect::MakeXYWH((SkScalar)dx, (SkScalar)dy, (SkScalar)dw, (SkScalar)dh);
  // The dst-only overload (like sk_mtl_draw_texture) samples the WHOLE image, which
  // is the render target's full extent; w/h only shaped the GrBackendTexture above.
  // Linear filtering, not Skia's nearest default: the destination is the render
  // target's LOGICAL size while the source is its DEVICE size under HiDPI, so this
  // is a real scale-down and nearest would alias the game's sprites.
  //
  // kSrc, NOT Skia's default kSrcOver: AIR presents the Stage3D back buffer with
  // its alpha channel IGNORED -- the alpha is not a compositing input, because
  // nothing in an AIR scene is ever layered BEHIND Stage3D (the 2D display list is
  // always drawn on top). Measured against the adl oracle (51.4.1, D3D11): a
  // context cleared to (1, 0, 0, 0.25) and one cleared to (1, 0, 0, 1.0), both over
  // an opaque GREEN stage colour, produce the SAME window pixel (255, 0, 0) -- the
  // green never shows through a translucent back buffer.
  // Under kSrcOver the alpha written by the LAST blend mode does show through:
  // Starling's ERASE (ZERO / ONE_MINUS_SOURCE_ALPHA) zeroes RGB *and* alpha, so the
  // erased pixels let the stage colour through and Starling's Blend Modes demo
  // renders a WHITE rocket silhouette where AIR renders a black one.
  SkPaint paint;
  paint.setBlendMode(SkBlendMode::kSrc);
  c->drawImageRect(img, dst, SkSamplingOptions(SkFilterMode::kLinear, SkMipmapMode::kNone), &paint);
}

}  // extern "C"