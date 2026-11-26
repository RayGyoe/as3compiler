// video_d3d.cc: the D3D11 -> D3D12 zero-copy handoff for NetStream's hardware decode.
//
// Why this file exists (video.md §16.8.3): a D3D11VA frame is an
// ID3D11Texture2DArray slice in DXGI_FORMAT_NV12 (or P010 for 10-bit). The measured
// way NOT to hand it to Skia is av_hwframe_transfer_data(): pulling 4K P010 back to
// system memory costs 11.17 ms/frame, twice what software decode costs in total, so
// that route is slower than not using the GPU at all. The way that can win is to
// never leave the GPU:
//
//   D3D11 decoder slice --CopySubresourceRegion--> our NV12/P010 staging texture
//     (created with D3D11_RESOURCE_MISC_SHARED_NTHANDLE, whose handle D3D12 opens)
//   --CopyTextureRegion(plane 0/1)--> two D3D12 plane textures: Y as R8/R16,
//     UV as R8G8/R16G16, i.e. exactly the two whole 2D textures GrBackendTexture
//     requires (a plane *slice* of one resource is not wrappable, and that is the
//     whole reason this file has to exist)
//   --SkImages::TextureFromYUVATextures--> SkImage the display list can draw.
//
// The two copies are pure bandwidth (9 MB for 4K NV12), not colour work: the YUV to
// RGB matrix stays where it already was, in Skia's YUV shader.
//
// Ownership: the D3D11 device belongs to FFmpeg's AVHWDeviceContext (we only
// AddRef it), the D3D12 device/queue belong to d3d_glue.cc (we only borrow them),
// and the SkImage returned here owns a reference to nothing but our own textures --
// it keeps them alive through Skia's refcount and hands them back through
// TextureReleaseProc, which is what lets the next frame reuse them safely.

#define SK_GANESH
#define SK_DIRECT3D

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <d3d11_4.h>
#include <d3d12.h>
#include <dxgi1_6.h>

#include "include/core/SkColorSpace.h"   // GrBackendTexture holds a sk_sp<SkColorSpace>
#include "include/core/SkImage.h"
#include "include/core/SkYUVAInfo.h"
#include "include/gpu/GrBackendSurface.h"
#include "include/gpu/GrYUVABackendTextures.h"
#include "include/gpu/d3d/GrD3DTypes.h"
#include "include/gpu/ganesh/SkImageGanesh.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>   // std::nothrow for the release token below

// The renderer's process-wide D3D12 device and queue (d3d_glue.cc). Declared here
// instead of exported through a header because this is the only consumer: the video
// seam is "pointer in, pointer out" on both sides.
extern "C" ID3D12Device* sk_d3d_shared_device(void);
extern "C" ID3D12CommandQueue* sk_d3d_shared_queue(void);

namespace {

// One entry per distinct D3D11 device. In practice that is one per video stream (each
// NetStream opens its own hw device), and more than a handful of simultaneously
// playing streams is not a shape this runtime has to support -- but the table is
// keyed, not global, so two streams cannot corrupt each other's staging texture.
constexpr int kMaxStreams = 4;
// Texture ring size. It is NOT "two frames in flight": video_glue keeps decoded but
// not-yet-due frames in a FIFO (AS_VIDEO_QUEUE = 8 there) and every one of them owns an
// SkImage -- hence a plane-texture pair -- for as long as it waits for the clock.
// Measured with a two-slot ring: 14 of the 31 frames in one clip were starved and fell
// back to the readback route, i.e. the ring, not the copy, was the bottleneck. QUEUE + 2
// covers the FIFO, the frame on screen and the one being made, and the slots are created
// on first use, so a 320x240 test pays 10 * 0.1 MB rather than 10 * 18 MB.
constexpr int kSlots = 10;

// Where a plane target currently sits, so the barrier we emit is always legal. Skia
// is told PIXEL_SHADER_RESOURCE and (for a sample-only image) leaves it there; the
// only other state these textures ever see is the copy destination.
enum SlotState { kSlotCommon = 0, kSlotCopyDest = 1, kSlotShaderRead = 2 };

struct Slot {
  gr_cp<ID3D12Resource> y;
  gr_cp<ID3D12Resource> uv;
  int in_use = 0;      // 1 until Skia's TextureReleaseProc says the frame is done
  int state = kSlotCommon;
  void* img = nullptr;   // 本槽 wrap 出的 SkImage：与“当前上屏帧”匹配（G-B）
  UINT64 value = 0;      // 本槽拷贝的共享 fence value
};

struct Stream {
  int used = 0;
  int failed = 0;
  ID3D11Device* dev11_key = nullptr;   // identity only, the device is FFmpeg's
  ID3D12Device* dev12_key = nullptr;   // identity only, for device-lost detection

  // D3D11 side
  gr_cp<ID3D11DeviceContext> ctx11;
  gr_cp<ID3D11Device5> dev5;
  gr_cp<ID3D11DeviceContext4> ctx4;
  gr_cp<ID3D11Fence> fence11;
  HANDLE h_fence = nullptr;

  // The same fence seen from D3D12: a queue Wait on it is what orders the decoder's
  // write ahead of our plane copies without a CPU-side stall.
  gr_cp<ID3D12Fence> fence12;
  UINT64 fence_value = 0;

  // Shared staging texture (decoder output format, i.e. NV12 or P010).
  gr_cp<ID3D11Texture2D> stage11;
  gr_cp<ID3D12Resource> stage12;
  HANDLE h_stage = nullptr;
  int stage_ready = 0;    // stage12 has been moved to COPY_SOURCE once
  int sw = 0, sh = 0;
  DXGI_FORMAT sfmt = DXGI_FORMAT_UNKNOWN;

  // Our own command objects, submitted to the renderer's queue so that a Wait, our
  // copies and Skia's draws all execute in submission order.
  gr_cp<ID3D12CommandAllocator> alloc;
  gr_cp<ID3D12GraphicsCommandList> list;

  Slot slots[kSlots];
  int cursor = 0;
  // Bumped whenever this entry is torn down. Skia's TextureReleaseProc can fire much
  // later (the display list may hold the image past stream close), and by then the entry
  // may already belong to a DIFFERENT device. The callback carries the epoch it was
  // created under and does nothing when they disagree -- otherwise a stale frame could
  // clear `in_use` on a live slot and let a texture be rewritten under Skia.
  unsigned epoch = 0;

  int width = 0, height = 0;
  int ten_bit = 0;

  // G-B：最近一帧的平面位置（Stage3D VideoTexture 直采路）。只在该帧成功 wrap 成
  // SkImage 后更新；slot 环 kSlots=10，绑定方每帧重绑 ⇒ 不会采到被复写的旧槽。
  int latest_slot = -1;
  UINT64 latest_value = 0;
  int latest_cs = 1;

  // Counters for AS_VIDEO_STATS (read through sk_video_d3d_stats).
  long long frames = 0;
  long long starved = 0;   // no free slot: the frame fell back to the CPU path
};

Stream g_streams[kMaxStreams];

void zc_release_cb(void* ctx);

// Handed to Skia as the release context. It carries the epoch the slot was issued under
// (see Stream::epoch) so a callback that outlives its stream cannot clear a live slot.
struct RelToken {
  Slot* slot;
  Stream* stream;
  unsigned epoch;
};

void zc_reset(Stream* s) {
  s->epoch++;
  // Everything D3D-related goes; the identity keys must go too, or a re-created
  // device would be mistaken for the old one (d3d_glue rebuilds the device on
  // device-lost, and the old pointers are then recycled addresses).
  for (int i = 0; i < kSlots; ++i) {
    s->slots[i].y.reset();
    s->slots[i].uv.reset();
    s->slots[i].in_use = 0;
    s->slots[i].state = kSlotCommon;
  }
  s->list.reset();
  s->alloc.reset();
  s->stage12.reset();
  s->stage11.reset();
  if (s->h_stage) { CloseHandle(s->h_stage); s->h_stage = nullptr; }
  s->fence12.reset();
  s->fence11.reset();
  if (s->h_fence) { CloseHandle(s->h_fence); s->h_fence = nullptr; }
  s->ctx4.reset();
  s->dev5.reset();
  s->ctx11.reset();
  s->dev11_key = nullptr;
  s->dev12_key = nullptr;
  s->stage_ready = 0;
  s->sw = s->sh = 0;
  s->sfmt = DXGI_FORMAT_UNKNOWN;
  s->width = s->height = 0;
  s->ten_bit = 0;
  s->cursor = 0;
  s->fence_value = 0;
  s->failed = 0;
  s->used = 0;
}

template <typename Out, typename In>
void qq(Out** out, REFIID iid, In* obj) {
  *out = nullptr;
  if (obj != nullptr) obj->QueryInterface(iid, (void**)out);
}

// --- init -----------------------------------------------------------------

int zc_init(Stream* s, ID3D11Device* dev11) {
  ID3D12Device* dev12 = sk_d3d_shared_device();
  ID3D12CommandQueue* queue = sk_d3d_shared_queue();
  if (dev12 == nullptr || queue == nullptr) return 0;

  s->dev11_key = dev11;
  s->dev12_key = dev12;

  ID3D11DeviceContext* ctx = nullptr;
  dev11->GetImmediateContext(&ctx);
  if (ctx == nullptr) return 0;
  s->ctx11.reset(ctx);
  ID3D11Device5* d5 = nullptr;
  qq(&d5, __uuidof(ID3D11Device5), dev11);
  if (d5 == nullptr) {
    fprintf(stderr, "video_d3d: ID3D11Device5 unavailable; zero-copy disabled\n");
    fflush(stderr);
    return 0;
  }
  s->dev5.reset(d5);
  ID3D11DeviceContext4* c4 = nullptr;
  qq(&c4, __uuidof(ID3D11DeviceContext4), ctx);
  if (c4 == nullptr) {
    fprintf(stderr, "video_d3d: ID3D11DeviceContext4 unavailable; zero-copy disabled\n");
    fflush(stderr);
    return 0;
  }
  s->ctx4.reset(c4);

  // A *shared* fence is the only synchronisation object both APIs can name. It costs
  // nothing per frame (a Signal and a Wait) and it is what makes the plane copies
  // legal without a Flush + Query + CPU spin.
  ID3D11Fence* f11 = nullptr;
  HRESULT hr = d5->CreateFence(0, D3D11_FENCE_FLAG_SHARED, __uuidof(ID3D11Fence), (void**)&f11);
  if (FAILED(hr) || f11 == nullptr) {
    fprintf(stderr, "video_d3d: CreateFence(shared) failed: 0x%08lx\n", (unsigned long)hr);
    fflush(stderr);
    return 0;
  }
  s->fence11.reset(f11);
  hr = f11->CreateSharedHandle(nullptr, GENERIC_ALL, nullptr, &s->h_fence);
  if (FAILED(hr) || s->h_fence == nullptr) {
    fprintf(stderr, "video_d3d: fence CreateSharedHandle failed: 0x%08lx\n", (unsigned long)hr);
    fflush(stderr);
    return 0;
  }
  ID3D12Fence* f12 = nullptr;
  hr = dev12->OpenSharedHandle(s->h_fence, __uuidof(ID3D12Fence), (void**)&f12);
  if (FAILED(hr) || f12 == nullptr) {
    fprintf(stderr, "video_d3d: OpenSharedHandle(fence) failed: 0x%08lx\n", (unsigned long)hr);
    fflush(stderr);
    return 0;
  }
  s->fence12.reset(f12);

  D3D12_COMMAND_QUEUE_DESC unused = {};   // keep the type dependency explicit
  (void)unused;
  ID3D12CommandAllocator* alloc = nullptr;
  hr = dev12->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,
                                     __uuidof(ID3D12CommandAllocator), (void**)&alloc);
  if (FAILED(hr) || alloc == nullptr) return 0;
  s->alloc.reset(alloc);
  ID3D12GraphicsCommandList* list = nullptr;
  hr = dev12->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, alloc, nullptr,
                                __uuidof(ID3D12GraphicsCommandList), (void**)&list);
  if (FAILED(hr) || list == nullptr) return 0;
  s->list.reset(list);
  list->Close();   // Reset() is what opens it for a frame
  return 1;
}

// Staging texture for the decoded slice: same format and size as the decoder's own
// texture, but created SHARED so D3D12 can name it. The copy from the decoder slice
// into it is a plain NV12->NV12 (or P010->P010) GPU blit -- the decoder textures
// themselves are NOT shareable, they are allocated by FFmpeg's hwcontext with
// D3D11_BIND_DECODER and no sharing flags, and asking a driver for a shared decode
// surface is not something DXVA guarantees.
int zc_make_stage(Stream* s, ID3D11Texture2D* src, DXGI_FORMAT fmt, int w, int h) {
  if (s->stage11.get() != nullptr && s->sw == w && s->sh == h && s->sfmt == fmt) return 1;

  s->stage12.reset();
  s->stage11.reset();
  if (s->h_stage) { CloseHandle(s->h_stage); s->h_stage = nullptr; }
  s->stage_ready = 0;

  D3D11_TEXTURE2D_DESC d = {};
  d.Width = (UINT)w;
  d.Height = (UINT)h;
  d.MipLevels = 1;
  d.ArraySize = 1;
  d.Format = fmt;
  d.SampleDesc.Count = 1;
  d.Usage = D3D11_USAGE_DEFAULT;
  d.CPUAccessFlags = 0;
  // Both share flags, not just the NT one: D3D11 rejects a resource that names
  // SHARED_NTHANDLE without the legacy SHARED bit with E_INVALIDARG, which is how the
  // first version of this file failed on BOTH NV12 (0x67) and P010 (0x68) -- the
  // formats were never the problem. A video format also has to carry exactly one bind
  // flag that supports it, so the ladder below tries SHADER_RESOURCE first (the one
  // the YUV shader path would use) and falls back to a pure copy destination.
  d.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;
  ID3D11Texture2D* st = nullptr;
  HRESULT hr = E_FAIL;
  const UINT binds[2] = {D3D11_BIND_SHADER_RESOURCE, 0};
  for (int attempt = 0; attempt < 2 && st == nullptr; ++attempt) {
    d.BindFlags = binds[attempt];
    hr = s->dev11_key->CreateTexture2D(&d, nullptr, &st);
    if (getenv("AS_VIDEO_DEBUG") != nullptr) {
      fprintf(stderr, "[zc] staging %dx%d fmt=%d bind=%u -> 0x%08lx\n", w, h, (int)fmt,
              (unsigned)binds[attempt], (unsigned long)hr);
      fflush(stderr);
    }
  }
  if (FAILED(hr) || st == nullptr) {
    fprintf(stderr, "video_d3d: shared staging texture %dx%d fmt=%d failed: 0x%08lx\n",
            w, h, (int)fmt, (unsigned long)hr);
    fflush(stderr);
    return 0;
  }
  s->stage11.reset(st);

  IDXGIResource1* rx = nullptr;
  qq(&rx, __uuidof(IDXGIResource1), st);
  if (rx == nullptr) return 0;
  hr = rx->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
                              nullptr, &s->h_stage);
  rx->Release();
  if (FAILED(hr) || s->h_stage == nullptr) return 0;

  ID3D12Resource* r12 = nullptr;
  hr = s->dev12_key->OpenSharedHandle(s->h_stage, __uuidof(ID3D12Resource), (void**)&r12);
  if (FAILED(hr) || r12 == nullptr) {
    fprintf(stderr, "video_d3d: OpenSharedHandle(staging) failed: 0x%08lx\n", (unsigned long)hr);
    fflush(stderr);
    return 0;
  }
  s->stage12.reset(r12);
  s->sw = w;
  s->sh = h;
  s->sfmt = fmt;
  return 1;
}

int zc_make_plane(ID3D12Device* dev, gr_cp<ID3D12Resource>& out, DXGI_FORMAT fmt, int w, int h) {
  D3D12_HEAP_PROPERTIES hp = {};
  hp.Type = D3D12_HEAP_TYPE_DEFAULT;
  hp.CreationNodeMask = 1;
  hp.VisibleNodeMask = 1;
  D3D12_RESOURCE_DESC rd = {};
  rd.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
  rd.Width = (UINT64)w;
  rd.Height = (UINT)h;
  rd.DepthOrArraySize = 1;
  rd.MipLevels = 1;
  rd.Format = fmt;
  rd.SampleDesc.Count = 1;
  rd.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;
  rd.Flags = D3D12_RESOURCE_FLAG_NONE;
  ID3D12Resource* r = nullptr;
  HRESULT hr = dev->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &rd,
                                            D3D12_RESOURCE_STATE_COMMON, nullptr,
                                            __uuidof(ID3D12Resource), (void**)&r);
  if (FAILED(hr) || r == nullptr) return 0;
  out.reset(r);
  return 1;
}

void zc_barrier(ID3D12GraphicsCommandList* list, ID3D12Resource* res,
                D3D12_RESOURCE_STATES from, D3D12_RESOURCE_STATES to, int sub) {
  D3D12_RESOURCE_BARRIER b = {};
  b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
  b.Flags = D3D12_RESOURCE_BARRIER_FLAG_NONE;
  b.Transition.pResource = res;
  b.Transition.Subresource = (UINT)sub;
  b.Transition.StateBefore = from;
  b.Transition.StateAfter = to;
  list->ResourceBarrier(1, &b);
}

void zc_release_cb(void* ctx) {
  RelToken* t = (RelToken*)ctx;
  if (t->stream->used && t->stream->epoch == t->epoch) t->slot->in_use = 0;
  t->slot->img = nullptr;   // G-B：防 SkImage 地址复用造成 presented 匹配误中
  delete t;
}

// One line per stream, on the first failure only: a zero-copy path that quietly keeps
// returning null looks identical to a working one in the frame counts, and the whole
// point of this section is a measured claim. `AS_VIDEO_ZC=0` is the normal way to turn
// the route off, so this must be a real error, not a per-frame spam.
void zc_fail(Stream* s, const char* why) {
  if (s != nullptr) {
    if (s->failed) return;
    s->failed = 1;
  }
  fprintf(stderr, "video_d3d: zero-copy off: %s (falling back to the readback route)\n", why);
  fflush(stderr);
}

}  // namespace

// --- entry point ----------------------------------------------------------

// Called by video_glue.c BEFORE it commits to a GPU decoder: "could a frame from a
// D3D11 device of this size and format actually reach Skia on this machine?"
//   ctx     GrRecordingContext* (Skia, from the display list)
//   dev11   the ID3D11Device behind the proposed hw_device_ctx
//   w, h    the coded size; ten_bit picks P010 over NV12
// Returns 1 when the whole route is live: a shared D3D12 device+queue exists, the
// entry initialises (ID3D11Device5, shared fence, command list) AND a shared staging
// texture plus one plane pair can be created. It leaves the entry initialised, so the
// first frame reuses it rather than paying twice.
//
// Why a probe and not a try-and-see-at-the-first-frame: hardware decode plus READBACK
// costs 13.4 ms/frame against software's 6.6 ms (§16.8.3), so committing to the GPU
// without this answer would be a pessimisation on every machine where the handoff
// does not work (no GPU context, old driver, device lost). Answering it here keeps the
// default safe -- one decision, before any packet is decoded, no stream restart.
extern "C" int sk_video_d3d_probe(void* ctx, void* dev11, int w, int h, int ten_bit) {
  if (ctx == nullptr || dev11 == nullptr || w <= 0 || h <= 0) return 0;
  if ((w & 1) || (h & 1)) return 0;
  ID3D12Device* dev12 = sk_d3d_shared_device();
  ID3D12CommandQueue* queue = sk_d3d_shared_queue();
  if (dev12 == nullptr || queue == nullptr) return 0;

  ID3D11Device* dev = (ID3D11Device*)dev11;
  Stream* s = nullptr;
  Stream* empty = nullptr;
  for (int i = 0; i < kMaxStreams; ++i) {
    Stream* e = &g_streams[i];
    if (e->used && e->dev11_key == dev) {
      if (e->dev12_key != dev12) zc_reset(e);
      else { s = e; break; }
    }
    if (!e->used && empty == nullptr) empty = e;
  }
  if (s == nullptr) {
    if (empty == nullptr) return 0;
    s = empty;
    s->used = 1;
    if (!zc_init(s, dev)) { zc_reset(s); return 0; }
  }
  if (s->failed) return 0;

  const DXGI_FORMAT sfmt = ten_bit ? DXGI_FORMAT_P010 : DXGI_FORMAT_NV12;
  if (!zc_make_stage(s, nullptr, sfmt, w, h)) {
    zc_fail(s, "shared staging texture (probe)");
    return 0;
  }
  const DXGI_FORMAT yfmt = ten_bit ? DXGI_FORMAT_R16_UNORM : DXGI_FORMAT_R8_UNORM;
  const DXGI_FORMAT uvfmt = ten_bit ? DXGI_FORMAT_R16G16_UNORM : DXGI_FORMAT_R8G8_UNORM;
  Slot* slot = &s->slots[0];
  if (slot->y.get() == nullptr &&
      (!zc_make_plane(dev12, slot->y, yfmt, w, h) ||
       !zc_make_plane(dev12, slot->uv, uvfmt, w / 2, h / 2))) {
    zc_fail(s, "plane textures (probe)");
    return 0;
  }
  if (getenv("AS_VIDEO_DEBUG") != nullptr) {
    fprintf(stderr, "[zc] probe ok: %dx%d ten_bit=%d\n", w, h, ten_bit);
    fflush(stderr);
  }
  return 1;
}

// Called by video_glue.c for a frame whose format is AV_PIX_FMT_D3D11.
//   ctx      GrRecordingContext* (Skia, from the display list)
//   tex      the frame's ID3D11Texture2D* (a Texture2DArray; `slice` picks the frame)
//   slice    frame->data[1] as an integer
//   ten_bit  1 for P010 (R16/R16G16 planes), 0 for NV12 (R8/R8G8)
//   yuv_cs   SkYUVColorSpace value (0..9), the frame's own matrix/range
// Returns an SkImage* the caller owns, or nullptr -- and nullptr is always a valid
// answer: it means "no zero-copy this frame", and the caller falls back to the
// measured CPU route instead of showing nothing.
extern "C" void* sk_video_d3d_image(void* ctx, void* tex, int slice, int w, int h,
                                    int ten_bit, int yuv_cs) {
  if (ctx == nullptr || tex == nullptr || w <= 0 || h <= 0) return nullptr;
  if ((w & 1) || (h & 1)) return nullptr;   // NV12/P010 planes are 2x2 subsampled

  ID3D11Texture2D* src = (ID3D11Texture2D*)tex;
  ID3D11Device* dev11 = nullptr;
  src->GetDevice(&dev11);           // AddRef'd
  if (dev11 == nullptr) return nullptr;

  ID3D12Device* dev12 = sk_d3d_shared_device();
  ID3D12CommandQueue* queue = sk_d3d_shared_queue();
  if (dev12 == nullptr || queue == nullptr) {
    static int once = 0;
    if (!once) {
      once = 1;
      fprintf(stderr, "video_d3d: no D3D12 device/queue yet; zero-copy waits for the "
                      "GPU backend to exist\n");
      fflush(stderr);
    }
    dev11->Release();
    return nullptr;
  }

  // Find (or claim) this device's stream. A renderer device change (device-lost
  // recovery drops and rebuilds the D3D12 device) invalidates every resource we
  // opened from it, so the entry is thrown away rather than reused.
  Stream* s = nullptr;
  Stream* empty = nullptr;
  for (int i = 0; i < kMaxStreams; ++i) {
    Stream* e = &g_streams[i];
    if (e->used && e->dev11_key == dev11) {
      if (e->dev12_key != dev12 || dev12 == nullptr) {
        zc_reset(e);
      } else {
        s = e;
        break;
      }
    }
    if (!e->used && empty == nullptr) empty = e;
  }
  if (s == nullptr) {
    if (empty == nullptr) {
      if (getenv("AS_VIDEO_DEBUG") != nullptr)
        fprintf(stderr, "[zc] no free stream entry (kMaxStreams=%d)\n", kMaxStreams);
      dev11->Release();
      return nullptr;
    }
    s = empty;
    s->used = 1;
    if (!zc_init(s, dev11)) {
      zc_reset(s);
      dev11->Release();
      return nullptr;   // zc_init already said why
    }
  }
  if (s->failed) { dev11->Release(); return nullptr; }

  D3D11_TEXTURE2D_DESC sd = {};
  src->GetDesc(&sd);
  const DXGI_FORMAT sfmt = ten_bit ? DXGI_FORMAT_P010 : DXGI_FORMAT_NV12;
  if (!zc_make_stage(s, src, sfmt, w, h)) {
    zc_fail(s, "shared staging texture");
    dev11->Release();
    return nullptr;
  }

  // Plane targets. YUV420P10/BT.2020 keeps 10 bits end to end: P010's planes are
  // 16-bit containers with the 10-bit value left-justified, which samples through
  // R16_UNORM as exactly the 0..1 the YUV matrix wants -- no shift, no swscale.
  const DXGI_FORMAT yfmt = ten_bit ? DXGI_FORMAT_R16_UNORM : DXGI_FORMAT_R8_UNORM;
  const DXGI_FORMAT uvfmt = ten_bit ? DXGI_FORMAT_R16G16_UNORM : DXGI_FORMAT_R8G8_UNORM;
  const int uw = w / 2, uh = h / 2;
  if (s->width != w || s->height != h || s->ten_bit != ten_bit) {
    for (int i = 0; i < kSlots; ++i) {
      s->slots[i].y.reset();
      s->slots[i].uv.reset();
      s->slots[i].in_use = 0;
      s->slots[i].state = kSlotCommon;
    }
    s->width = w;
    s->height = h;
    s->ten_bit = ten_bit;
    s->cursor = 0;
  }
  // Slots are created on demand, so a stream that never runs ahead (or a tiny clip)
  // never pays for the full ring.
  Slot* slot = nullptr;
  for (int i = 0; i < kSlots; ++i) {
    Slot* cand = &s->slots[(s->cursor + i) % kSlots];
    if (!cand->in_use) { slot = cand; break; }
  }
  if (slot == nullptr) {
    s->starved++;
    dev11->Release();
    return nullptr;
  }
  if (slot->y.get() == nullptr &&
      (!zc_make_plane(dev12, slot->y, yfmt, w, h) ||
       !zc_make_plane(dev12, slot->uv, uvfmt, uw, uh))) {
    zc_fail(s, "plane texture");
    dev11->Release();
    return nullptr;
  }
  s->cursor = (int)(slot - s->slots) + 1;
  if (s->cursor >= kSlots) s->cursor = 0;

  // 1. Decoder slice -> shared staging (GPU blit, same format).
  s->ctx11->CopySubresourceRegion(s->stage11.get(), 0, 0, 0, 0, src,
                                  (UINT)(slice < 0 ? 0 : slice), nullptr);
  const UINT64 value = ++s->fence_value;
  s->ctx4->Signal(s->fence11.get(), value);

  // 2. Our copies must not run before that blit lands. The Wait is GPU-side and on
  //    the same queue Skia submits to, so it costs no CPU time and no ordering code
  //    beyond this call.
  queue->Wait(s->fence12.get(), value);

  // 3. Split the two planes into the whole 2D textures Skia can wrap.
  s->alloc->Reset();
  s->list->Reset(s->alloc.get(), nullptr);
  ID3D12GraphicsCommandList* list = s->list.get();

  if (!s->stage_ready) {
    zc_barrier(list, s->stage12.get(), D3D12_RESOURCE_STATE_COMMON,
               D3D12_RESOURCE_STATE_COPY_SOURCE, D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES);
    s->stage_ready = 1;
  }
  if (slot->state != kSlotCopyDest) {
    const D3D12_RESOURCE_STATES from = slot->state == kSlotShaderRead
                                           ? D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE
                                           : D3D12_RESOURCE_STATE_COMMON;
    zc_barrier(list, slot->y.get(), from, D3D12_RESOURCE_STATE_COPY_DEST,
               D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES);
    zc_barrier(list, slot->uv.get(), from, D3D12_RESOURCE_STATE_COPY_DEST,
               D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES);
  }

  // NV12/P010 expose exactly two subresources (plane 0 = Y, plane 1 = chroma), so a
  // plane is addressed by subresource index and the destination must be a texture
  // whose format is that plane's own: R8/R16 for Y, R8G8/R16G16 for chroma.
  D3D12_TEXTURE_COPY_LOCATION dst = {};
  dst.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
  dst.SubresourceIndex = 0;
  D3D12_TEXTURE_COPY_LOCATION srcLoc = {};
  srcLoc.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
  srcLoc.pResource = s->stage12.get();
  D3D12_BOX box = {};

  dst.pResource = slot->y.get();
  srcLoc.SubresourceIndex = 0;
  box.left = 0; box.top = 0; box.front = 0;
  box.right = (UINT)w; box.bottom = (UINT)h; box.back = 1;
  list->CopyTextureRegion(&dst, 0, 0, 0, &srcLoc, &box);

  dst.pResource = slot->uv.get();
  srcLoc.SubresourceIndex = 1;
  box.right = (UINT)uw; box.bottom = (UINT)uh;
  list->CopyTextureRegion(&dst, 0, 0, 0, &srcLoc, &box);

  // Hand the textures over in the state Skia expects (same contract as
  // sk_gpu_draw_texture in d3d_glue.cc: Skia tracks state per texture and inserts
  // its own barrier, so telling it the truth keeps the two sides from disagreeing).
  zc_barrier(list, slot->y.get(), D3D12_RESOURCE_STATE_COPY_DEST,
             D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE, D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES);
  zc_barrier(list, slot->uv.get(), D3D12_RESOURCE_STATE_COPY_DEST,
             D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE, D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES);
  slot->state = kSlotShaderRead;

  HRESULT hr = list->Close();
  if (FAILED(hr)) {
    zc_fail(s, "command list close");
    dev11->Release();
    return nullptr;
  }
  ID3D12CommandList* lists[1] = {list};
  queue->ExecuteCommandLists(1, lists);

  SkYUVAInfo info(SkISize::Make(w, h), SkYUVAInfo::PlaneConfig::kY_UV,
                  SkYUVAInfo::Subsampling::k420,
                  (SkYUVColorSpace)(yuv_cs < 0 ? 1 : yuv_cs));
  GrD3DTextureResourceInfo yi(nullptr, nullptr, D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE,
                              yfmt, 1, 1, 0, GrProtected::kNo);
  yi.fResource.retain(slot->y.get());   // retain(): the struct releases on destruction
  GrD3DTextureResourceInfo ui(nullptr, nullptr, D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE,
                              uvfmt, 1, 1, 0, GrProtected::kNo);
  ui.fResource.retain(slot->uv.get());

  GrBackendTexture planes[SkYUVAInfo::kMaxPlanes];
  planes[0] = GrBackendTexture(w, h, yi);
  planes[1] = GrBackendTexture(uw, uh, ui);
  GrYUVABackendTextures yuva(info, planes, kTopLeft_GrSurfaceOrigin);

  slot->in_use = 1;
  // Token, not the slot pointer: see Stream::epoch. If the allocation fails the frame
  // simply goes through the readback route (in_use is not taken).
  RelToken* token = new (std::nothrow) RelToken{slot, s, s->epoch};
  if (token == nullptr) { dev11->Release(); return nullptr; }
  sk_sp<SkImage> img = SkImages::TextureFromYUVATextures(
      static_cast<GrRecordingContext*>(ctx), yuva, nullptr, zc_release_cb, token);
  dev11->Release();
  if (img == nullptr) {
    // Only the first frame is worth a line: a driver that refuses the wrap refuses it
    // every time, and this is a diagnostic, not a log.
    if (getenv("AS_VIDEO_DEBUG") != nullptr && s->frames == 0)
      fprintf(stderr, "[zc] TextureFromYUVATextures returned null\n");
    slot->in_use = 0;
    delete token;
    return nullptr;
  }
  s->frames++;
  slot->img = img.get();
  slot->value = value;
  s->latest_slot = (int)(slot - s->slots);
  s->latest_value = value;
  s->latest_cs = yuv_cs < 0 ? 1 : yuv_cs;
  return img.release();
}

// G-B：Stage3D 零拷贝直采入口。返回**当前上屏帧**（presented_img，即 v->image）对应槽的
// Y/UV 平面（D3D12 resource，借用指针）与 fence value；解码器会超前解码 FIFO 未来帧，
// latest_slot 是最新解码帧而非上屏帧 ⇒ 必须按 presented_img 匹配，否则 zc 画未来帧。
// presented_img 无匹配时回 0（该帧走 upload 路保同源），不回退 latest_slot。
extern "C" int sk_video_d3d_latest(void* d3d11_device, void* presented_img, void** y, void** uv,
                                   int* w, int* h, int* ten_bit, int* cs,
                                   unsigned long long* fence_value) {
  if (d3d11_device == nullptr) return 0;
  for (int i = 0; i < kMaxStreams; ++i) {
    Stream* s = &g_streams[i];
    if (!s->used || s->dev11_key != d3d11_device) continue;
    if (s->failed || s->frames == 0 || s->latest_slot < 0) return 0;
    // 上屏帧必须精确匹配：v->image 走软件回退帧时无对应槽 ⇒ 回 0 让应用层该帧走
    // upload 路（与 CPU 同源）；回退 latest_slot 会画 FIFO 未来帧（parity 实测差 91）。
    int pick = -1;
    if (presented_img != nullptr) {
      for (int k = 0; k < kSlots; ++k) {
        if (s->slots[k].img == presented_img) { pick = k; break; }
      }
    }
    if (pick < 0) return 0;
    Slot* slot = &s->slots[pick];
    if (slot->y.get() == nullptr || slot->uv.get() == nullptr) return 0;
    if (y) *y = slot->y.get();
    if (uv) *uv = slot->uv.get();
    if (w) *w = s->width;
    if (h) *h = s->height;
    if (ten_bit) *ten_bit = s->ten_bit;
    if (cs) *cs = s->latest_cs;
    if (fence_value) *fence_value = slot->value;
    return 1;
  }
  return 0;
}

// Counters, for the AS_VIDEO_STATS line: zero-copy is only worth claiming if the
// numbers say so, and a starved frame has to be visible rather than silent.
extern "C" void sk_video_d3d_stats(long long* frames, long long* starved) {
  long long f = 0, st = 0;
  for (int i = 0; i < kMaxStreams; ++i) {
    if (!g_streams[i].used) continue;
    f += g_streams[i].frames;
    st += g_streams[i].starved;
  }
  if (frames) *frames = f;
  if (starved) *starved = st;
}

// Called by video_glue when a stream closes, BEFORE it releases the D3D11 device. The
// entry names that device and every object in it was created from it, so it must not
// outlive it -- and the identity key is a raw pointer, which a later device could
// legitimately reuse at the same address.
extern "C" void sk_video_d3d_forget(void* d3d11_device) {
  if (d3d11_device == nullptr) return;
  for (int i = 0; i < kMaxStreams; ++i) {
    if (g_streams[i].used && g_streams[i].dev11_key == d3d11_device) zc_reset(&g_streams[i]);
  }
}