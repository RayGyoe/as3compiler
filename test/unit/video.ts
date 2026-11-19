// Unit checks: the video surface (flash.net.NetStream / flash.media.Video).
//
// The examples suite proves the runtime behaviour end to end (examples/video-headless.as:
// four containers, the clock, pause/resume, the audio-only stream); the invariants below
// are the ones a mutation breaks silently, and several of them were found by measurement
// (docs/zh-cn/video.md §16.3/§16.4/§16.7 records the failure each one prevents). Re-run
// alone with:
//   node --test --test-name-pattern='video/' test/unit/*.ts

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { registerGroup, root, readNorm } from '../harness.ts';

function checkVideoSurface(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [video] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [video] ${label}`); }
  };

  const glue = readNorm(join(root, 'vendor', 'video_glue.c'));
  // Assert on what the emitter WRITES OUT: comments in emit.ts quote both the
  // intended and the broken form, so a substring search over the source file
  // would count documentation as code.
  const emitSource = readNorm(join(root, 'src', 'emit.ts'));
  const emitted = [...emitSource.matchAll(/this\.line\('((?:[^'\\]|\\.)*)'\)/g)]
    .map((m) => m[1]).join('\n');

  // A function body, found by brace matching rather than a fixed window: a window silently
  // truncated the body once the HDR block grew, and the ordering pins below then read -1
  // as "the anchor is missing".
  const bodyOf = (name: string): string => {
    const at = glue.indexOf(name);
    if (at < 0) return '';
    const open = glue.indexOf('{', at);
    if (open < 0) return '';
    let depth = 0;
    for (let i = open; i < glue.length; i++) {
      if (glue[i] === '{') depth++;
      else if (glue[i] === '}') {
        depth--;
        if (depth === 0) return glue.slice(open, i + 1);
      }
    }
    return glue.slice(open);
  };

  // ---- the build gate has TWO failure meanings, and they must not be merged ----
  // No backend in this artifact -> synchronous throw (a missing capability).
  check('play() throws when the build has no video backend (hv == -2)',
    emitted.includes('if (hv == -2) { as_throw(') &&
    emitted.includes('video playback requires an FFmpeg-linked build'));
  // Backend present, file bad -> ASYNCHRONOUS NetStream.Play.Failed. Throwing here
  // would be a different AS3 contract: play() returns void, the failure is an event.
  check('a failed open reports NetStream.Play.Failed as an event, not a throw',
    emitted.includes('as_ns_status(o, "NetStream.Play.Failed", "error", err)'));
  check('netStatus info is a dynamic object (as_object_new), not a sealed Object_new',
    emitted.includes('as_object_new()') && emitted.includes('as_ns_status('));

  // ---- the frame clock: same safe point as timers and MovieClips ----
  check('as_ns_tick() runs from the frame boundary', emitted.includes('as_ns_tick();'));

  // ---- pacing: checked BEFORE the read, or every tick pulls one extra frame ----
  // The bug this pins: written as "read -> decode -> break if ahead", a 1.2 s clip
  // was fully consumed in the first dozen ticks of a hand-pumped frame loop
  // (docs/zh-cn/video.md §16.3, trap 1).
  const advance = bodyOf('static void as_video_advance');
  const checkAt = advance.indexOf('v->decoded_pts >= target_s');
  const readAt = advance.indexOf('as_video_next_packet');
  check('as_video_advance paces before reading the next packet',
    checkAt > 0 && readAt > 0 && checkAt < readAt);
  check('the first frame can still open the file (n_vframes guard on the pacing test)',
    advance.includes('v->n_vframes > 0 && v->decoded_pts >= target_s'));

  // ---- the queue: one slot froze NetStream.time at 0.000 (§16.3, trap 2) ----
  check('decoded-but-not-due frames live in a FIFO, not a single slot',
    /#define AS_VIDEO_QUEUE\s+\d+/.test(glue) &&
    glue.includes('void* qimg[AS_VIDEO_QUEUE];') &&
    glue.includes('double qpts[AS_VIDEO_QUEUE];'));
  check('queue overflow drops the OLDEST frame (a viewer behind real time missed that one)',
    /if \(v->qn >= AS_VIDEO_QUEUE\) \{\s*\n\s*sk_image_delete\(\(void\*\)v->qimg\[0\]\)/.test(glue));
  check('as_video_tick dequeues every due frame and keeps the last',
    /while \(v->qn > 0 && v->qpts\[0\] <= target \+ 0\.001\)/.test(glue));

  // ---- timestamps are normalised to a 0-based presentation timeline ----
  // MPEG-TS starts at a broadcast epoch (clip.ts at 1.533 s); comparing raw pts
  // against the 0-based play clock stopped decoding after one frame.
  check('video pts subtract the stream start_time',
    glue.includes('v_start') && glue.includes('pts = (double)ts * tb - v->v_start') &&
    glue.includes('v->v_start = (double)st->start_time * v->v_tb'));

  // ---- an audio-only stream has no video decoder ----
  check('as_video_drain_video guards a NULL video decoder',
    /static int as_video_drain_video[\s\S]{0,600}?if \(v->vc == NULL\)/.test(glue));

  // ---- end of playback: one frame period after the last picture, not the container
  // duration (clip.mp4's last frame sits at 1.133 s in a 1.2 s file, so the old test
  // never fired and Play.Stop was never dispatched) ----
  check('end of stream allows one frame period (capped at 200 ms)',
    glue.includes('v->at_end') && glue.includes('1.0 / v->fps') && glue.includes('> 0.2) period = 0.2'));
  check('as_video_state reports ENDED from the flag, not from frame_pts >= duration',
    !/frame_pts \+ 0\.001 >= last/.test(glue));

  // ---- per-frame cost: why a 4K HDR10+ file played at 16 fps (§16.5) ----
  // Three separate defects sat on the same path, so each gets its own pin.
  //
  // (1) Decoder threads. FFmpeg's AVCodecContext defaults thread_count to 1, and a
  // single thread decoding 3832x1592 10-bit HEVC costs ~8.8 ms per frame *inside the
  // frame loop*, next to the paint and the timers.
  check('the video decoder is sized for this CPU, with a cap on frame-thread memory',
    glue.includes('av_cpu_count()') && glue.includes('v->vc->thread_count = ncpu;') &&
    glue.includes('if (ncpu > 8) ncpu = 8;') &&
    glue.includes('FF_THREAD_FRAME | FF_THREAD_SLICE'));
  // (2) Priming. A thread queue of frames has to be fed before a frame-threaded
  // decoder emits anything, so one tick's packet budget left videoWidth at 0 right
  // after play() (measured on clip.mp4 with 8 threads: the 1.2 s file is shorter
  // than the pipe).
  check('priming is exempt from the per-tick packet budget',
    /#define AS_VIDEO_PRIME_PACKETS\s+\d+/.test(glue) &&
    /if \(v->vs >= 0 && v->n_vframes == 0\) budget = AS_VIDEO_PRIME_PACKETS;/.test(glue));
  // (3) The CPU-raster fallback used to convert every frame TWICE: one I420 pass to
  // feed an upload that cannot happen (no GPU context), then BGRA. 6 ms + 6 ms per
  // 4K frame. The I420 call must therefore sit inside the want_gpu branch and BEFORE
  // the img == NULL fallback.
  const present = bodyOf('static int as_video_present');
  const gpuAt = present.indexOf('if (want_gpu) {');
  const i420At = present.indexOf('v->sws = sws_getContext');
  const cpuAt = present.indexOf('if (img == NULL) {');
  check('the CPU-raster fallback converts straight to BGRA (no throwaway I420 pass)',
    // Since V3 step 2 the same branch also has to skip conversion when a pre-made GPU
    // image arrives (`pre_img`), so the guard carries both conditions; the ordering
    // invariant it pins is unchanged.
    /const int want_gpu = \(grctx != NULL\)( && \(img == NULL\))?;/.test(present) &&
    gpuAt > 0 && i420At > gpuAt && cpuAt > i420At);
  check('AS_VIDEO_STATS reports the cost split (decode / convert / upload)',
    glue.includes('cost/frame: dec=') && glue.includes('t_conv_ms') &&
    glue.includes('t_upload_ms') && glue.includes('t_dec_ms'));

  // ---- V3 step one: D3D11VA hardware decode (§16.8) ----
  // Pinned as four separate facts, because three of them fail *silently* if changed:
  // the hwaccel can be attached and never selected, selected and never used, or used
  // and lose the frame timestamps -- each with no error, only a different picture.
  const buildScript = readNorm(join(root, 'vendor', 'provision', 'ffmpeg-static.sh'));
  check('the FFmpeg recipe enables BOTH d3d11va names (format list and implementation)',
    buildScript.includes('add_hwaccels "h264 hevc mpeg2video vc1 vp9 av1 wmv3" d3d11va\n') &&
    buildScript.includes('add_hwaccels "h264 hevc mpeg2video vc1 vp9 av1 wmv3" d3d11va2\n'));
  // Superseded by the adaptive default above: what has to stay true is that the
  // SOFTWARE decoder is reachable (forced, or the fallback) and that the GPU is never
  // chosen without the zero-copy probe.
  check('the software route is always available, by flag and by fallback',
    glue.includes('static int as_video_decode_mode(void)') &&
    glue.includes('strcmp(want, "soft") == 0') &&
    glue.includes('if (!hw) {') &&
    glue.includes('return as_video_open_vdec(v, 0);'));
  check('get_format falls back to a SOFTWARE format, never to dxva2 against a D3D11 device',
    glue.includes('AV_PIX_FMT_FLAG_HWACCEL') && glue.includes('if (pick == AV_PIX_FMT_NONE) pick = list[0];'));
  check('a GPU frame is transferred back and keeps its props (pts/colorspace)',
    glue.includes('av_hwframe_transfer_data(v->sw_frame, v->frame, 0)') &&
    glue.includes('av_frame_copy_props(v->sw_frame, v->frame)'));
  check('AS_VIDEO_STATS says which decoder ran, and what the readback cost',
    glue.includes('decode=%s') && glue.includes('hw=%.2fms') && glue.includes('t_hw_ms'));
  // The windowed demo: the video advances at the frame boundary, so the app frame
  // clock is what decides smoothness (24 Hz on a 23.976 fps file aliases), and the
  // window itself wants the GPU backend -- CPU raster scaled a 4K frame on the CPU.
  const videoManifest = readNorm(join(root, 'examples', 'video', 'video.build.json'));
  check('the windowed demo asks for the GPU window backend on Windows',
    videoManifest.includes('${win:ASC_RENDER_WINGPU=1}') &&
    videoManifest.includes('${win:ASC_RENDER_D3D=1}') &&
    videoManifest.includes('${win:../../vendor/d3d_glue.cc}'));
  const videoDemo = readNorm(join(root, 'examples', 'video', 'VideoPlayer.as'));
  check('the demo runs the frame clock at 60 Hz', videoDemo.includes('stage.frameRate = 60;'));
  // The automated regression is the HEADLESS example (阶段三百九十九). The windowed
  // player keeps its window open for the user, so the suite can only compile+link it --
  // and before this split the suite was green while the run printed `8 passed, 5 failed`
  // (it built without the manifest, the window never opened, exit status was 0). Pinning
  // the arrangement keeps a future tidy-up from silently deleting the only coverage.
  const suite = readNorm(join(root, 'test', 'examples.ts'));
  check('the video regression is headless and wired to the real manifest',
    suite.includes("'video-headless.as': ['--manifest', join(dir, 'video', 'video.build.json')]") &&
    /SKIP_DIRS = new Set\(\[[^\]]*'video'\]\)/.test(suite));
  const headlessDemo = readNorm(join(root, 'examples', 'video-headless.as'));
  check('the headless video example settles its exit code from its own assertions',
    headlessDemo.includes('System.exit(failed.length == 0 ? 0 : 1)') &&
    headlessDemo.includes('stage.dispatchFrame()'));

  // ---- the gate's own switches must actually reach the build config ----
  // --video/--no-video/--video-formats/--video-backend were parsed into
  // opts.overrides and then never copied into cfg, so `--no-video` linked FFmpeg
  // anyway and printed the same "FFmpeg linked" line (measured). Same failure shape
  // as the --ane-platform bug the code already documents.
  const switches: [string, string][] = [
    ['--video / --no-video', 'if (opts.overrides.video) cfg.video = opts.overrides.video;'],
    ['--video-formats', 'if (opts.overrides.videoFormats) cfg.videoFormats = opts.overrides.videoFormats;'],
    ['--video-backend', 'if (opts.overrides.videoBackend) cfg.videoBackend = opts.overrides.videoBackend;'],
  ];
  // These three live in the CLI, not the emitter: assert on index.ts itself.
  const cli = readNorm(join(root, 'src', 'index.ts'));
  for (const [flag, line] of switches) check(`${flag} reaches cfg`, cli.includes(line));

  // ---- an import-only program must still LINK ----
  // The probe deliberately over-includes (examples/builtin-arity.as only names the
  // classes as parameter types), and such a program has neither the Skia glue nor the
  // audio glue. Before these guards the link failed with undefined as_audio_live_open /
  // sk_image_delete -- three examples went red for a capability they never used.
  check('video_glue compiles without the Skia glue (ASC_USE_SKIA fallbacks)',
    glue.includes('#ifdef ASC_USE_SKIA') && glue.includes('static void sk_image_delete(void* image) { (void)image; }'));
  check('video_glue compiles without the audio glue (ASC_HAVE_AUDIO fallbacks)',
    glue.includes('#ifdef ASC_HAVE_AUDIO') && glue.includes('static int as_audio_live_open(int channels, int rate)'));
  check('a build with no renderer refuses the stream instead of decoding into a void',
    glue.includes('this build has no Skia renderer: video frames cannot be shown'));

  // ---- getTimer() counts from process start, not from its own first call ----
  // The player's "end reached in wall time" read 0 at 1.2 s because the epoch was
  // lazily initialised on that very call (§16.4).
  check('the clock epoch is anchored at program start',
    RUNTIME_PREAMBLE.includes('static void as_clock_init(void)') &&
    emitted.includes('as_clock_init();'));

  // ---- zero copy (V3 step 2, video.md §16.9) ----
  // The route only exists on Windows, and every step of it protects a measurement:
  // the readback route costs 9.6 ms/frame on a 4K P010 source, so it is worth a lot of
  // machinery -- but only if the machinery stays honest about what it did.
  const zc = readNorm(join(root, 'vendor', 'video_d3d.cc'));
  check('the zero-copy seam is backend-gated with NULL fallbacks (other builds still link)',
    glue.includes('#if defined(ASC_RENDER_D3D) && ASC_RENDER_D3D && defined(ASC_USE_SKIA)') &&
    glue.includes('#elif defined(ASC_RENDER_METAL) && ASC_RENDER_METAL && defined(ASC_USE_SKIA)') &&
    glue.includes('static void* sk_video_zc_image(void* ctx, void* tex, int slice, int w, int h,'));
  check('the staging texture carries BOTH share flags (SHARED_NTHANDLE alone is E_INVALIDARG)',
    zc.includes('D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE'));
  check('the staging texture is shared through IDXGIResource1::CreateSharedHandle',
    zc.includes('CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE'));
  // The plane split is the whole reason video_d3d.cc exists: a GrBackendTexture wraps a
  // whole 2D texture, and Y/UV are two plane slices of one NV12 resource.
  check('the planes are split into whole textures by plane subresource',
    zc.includes('list->CopyTextureRegion(&dst, 0, 0, 0, &srcLoc, &box)') &&
    zc.includes('srcLoc.SubresourceIndex = 1;'));
  check('8-bit planes are R8 / R8G8, 10-bit are R16 / R16G16 (P010 is left-justified)',
    zc.includes('ten_bit ? DXGI_FORMAT_R16_UNORM : DXGI_FORMAT_R8_UNORM') &&
    zc.includes('ten_bit ? DXGI_FORMAT_R16G16_UNORM : DXGI_FORMAT_R8G8_UNORM'));
  check('the handoff is ordered by a shared fence, not a Flush',
    zc.includes('CreateFence(0, D3D11_FENCE_FLAG_SHARED') &&
    zc.includes('queue->Wait(s->fence12.get(), value)'));
  check('Skia receives YUVA textures in the state it tracks',
    zc.includes('SkImages::TextureFromYUVATextures(') &&
    zc.includes('SkYUVAInfo::PlaneConfig::kY_UV') &&
    zc.includes('D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE'));
  // Measured with a two-slot ring: 14 of 31 frames starved and fell back to the readback
  // route, because video_glue keeps up to AS_VIDEO_QUEUE decoded-but-not-due images alive.
  check('the ring is sized for the decode queue, not for two frames in flight',
    /constexpr int kSlots = (\d+);/.test(zc) &&
    Number(/constexpr int kSlots = (\d+);/.exec(zc)![1]) >= 10);
  // A release callback can outlive its stream; without the epoch it would clear a live
  // slot in an entry that a new device already owns.
  check('Skia\'s release callback is epoch-checked',
    zc.includes('t->stream->epoch == t->epoch') && zc.includes('s->epoch++'));
  check('the zero-copy attempt precedes the readback and both remain',
    glue.indexOf('zc_img = sk_video_zc_image(') > 0 &&
    glue.indexOf('zc_img = sk_video_zc_image(') < glue.indexOf('av_hwframe_transfer_data(v->sw_frame') &&
    glue.includes('av_hwframe_transfer_data(v->sw_frame, v->frame, 0)'));
  check('the table entry is dropped before FFmpeg releases the device',
    glue.indexOf('sk_video_zc_forget(v->hw_dev11)') > 0 &&
    glue.indexOf('sk_video_zc_forget(v->hw_dev11)') < glue.indexOf('av_buffer_unref(&v->hw_device)'));
  check('AS_VIDEO_STATS separates zero-copy frames from readback frames',
    glue.includes('AS_VIDEO_HW_NAME "-zero-copy"') && glue.includes('zc=%lld starved=%lld'));
  check('a hardware frame\'s 10-bit-ness is read from its frames context',
    glue.includes('hf->sw_format == AV_PIX_FMT_P010LE'));
  const manifestWithSeam = readNorm(join(root, 'examples', 'video', 'video.build.json'));
  check('the Windows video manifest compiles the zero-copy seam',
    manifestWithSeam.includes('"${win:../../vendor/video_d3d.cc}"'));

  // ---- zero copy on Apple: VideoToolbox -> CVMetalTextureCache (video.md §16.13) ----
  // Same promise, different platform: the decoder's CVPixelBuffer is an IOSurface, so
  // the planes can be wrapped as MTLTextures with no blit and no CPU touch. The pins
  // below are the pieces that make it correct rather than merely fast.
  const mtlSeam = readNorm(join(root, 'vendor', 'video_metal.mm'));
  const indexSrc = readNorm(join(root, 'src', 'index.ts'));
  check('the GPU decode surface is a per-platform constant, not a hardcoded D3D11',
    glue.includes('#define AS_VIDEO_HW_PIX AV_PIX_FMT_VIDEOTOOLBOX') &&
    glue.includes('#define AS_VIDEO_HW_PIX AV_PIX_FMT_D3D11') &&
    glue.includes('if (*p == AS_VIDEO_HW_PIX) { pick = *p; break; }') &&
    !glue.includes('if (*p == AV_PIX_FMT_D3D11) { pick = *p; break; }'));
  check('a hardware frame is reached through the field that actually carries it',
    glue.includes('void* zc_tex = (void*)v->frame->data[3];') &&          // Apple: CVPixelBuffer
    glue.includes('const int zc_slice = (int)(intptr_t)v->frame->data[1];')); // D3D: array slice
  // The identity is only needed where the seam keys a table by the decoder's device.
  // Apple has one process-wide MTLDevice, so AS_VIDEO_ZC_DEVICE keeps the D3D pointer
  // out of the Apple build (where the type does not even exist).
  check('the per-stream device identity is D3D-only',
    glue.includes('#define AS_VIDEO_ZC_DEVICE 1') && glue.includes('#define AS_VIDEO_ZC_DEVICE 0') &&
    glue.includes('#if AS_VIDEO_ZC_DEVICE') &&
    glue.includes('if (zc_dev == NULL) return 0;') &&
    /#if AS_VIDEO_ZC && AS_VIDEO_ZC_DEVICE\n  \{\n    const AVHWDeviceContext\* hwc/.test(glue));
  // The plane layout must come from the BUFFER, not from the caller's ten_bit flag:
  // 'x420' stores its ten bits in the high half of a 16-bit word (the P010 packing),
  // and a stream mislabelled here would be sampled with the wrong matrix.
  check('the plane layout is derived from the CVPixelBuffer format, not from ten_bit',
    mtlSeam.includes('CVPixelBufferGetPixelFormatType(pb)') &&
    mtlSeam.includes('case kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange:') &&
    mtlSeam.includes('*y_fmt = kPlaneR16; *uv_fmt = kPlaneRG16;') &&
    mtlSeam.includes('case kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange:') &&
    mtlSeam.includes('*y_fmt = kPlaneR8; *uv_fmt = kPlaneRG8;'));
  check('the wrap is a YUVA texture pair, never a copy',
    mtlSeam.includes('CVMetalTextureCacheCreateTextureFromImage(') &&
    mtlSeam.includes('CVMetalTextureGetTexture(ytex)') &&
    mtlSeam.includes('SkImages::TextureFromYUVATextures(') &&
    mtlSeam.includes('SkYUVAInfo::PlaneConfig::kY_UV') &&
    !/sws_scale|memcpy/.test(mtlSeam));
  // The MTLTextures are views into the pixel buffer's IOSurface: releasing the buffer
  // before Skia drops the image is a use-after-free that paints a corrupt frame rather
  // than crashing, so the token holds it for exactly the image's lifetime.
  check('the pixel buffer outlives the image (release callback holds it)',
    mtlSeam.includes('token->pb = (CVPixelBufferRef)CFRetain(pb);') &&
    /static void zc_release\(void\* ctx\)/.test(mtlSeam) &&
    mtlSeam.includes('if (t->pb != NULL) CFRelease(t->pb);') &&
    mtlSeam.includes('SkImages::TextureFromYUVATextures(\n        static_cast<GrRecordingContext*>(ctx), yuva, nullptr, zc_release, token);'));
  // A buffer whose plane HEIGHT is aligned up would be stretched by an w*h YUVAInfo.
  check('a padded plane geometry falls back instead of stretching the picture',
    mtlSeam.includes('CVPixelBufferGetWidthOfPlane(pb, 0)') &&
    mtlSeam.includes('if ((int)pw != w || (int)ph != h || (int)cw != w / sx || (int)ch != h / sy) {'));
  check('the cache belongs to the same MTLDevice Skia renders on',
    mtlSeam.includes('extern "C" void* sk_mtl_device_ptr(void);') &&
    mtlSeam.includes('CVMetalTextureCacheCreate(kCFAllocatorDefault, empty, (id<MTLDevice>)dev,') &&
    readNorm(join(root, 'vendor', 'metal_glue.mm')).includes('void* sk_mtl_device_ptr(void) { return (void*)g_device; }'));
  check('the seam is injected only where a GrDirectContext can exist',
    indexSrc.includes("const hasMetal = cfg.defines.some((d) => d.split('=')[0].trim() === 'ASC_RENDER_METAL');") &&
    cli.includes("cfg.sources.push(resolve(vendorDir, 'video_metal.mm'));"));
  check('the macOS video manifest compiles the zero-copy seam',
    manifestWithSeam.includes('"${mac:../../vendor/video_metal.mm}"') &&
    manifestWithSeam.includes('"${mac:ASC_RENDER_METAL=1}"') &&
    manifestWithSeam.includes('"${mac:../../vendor/metal_glue.mm}"'));

  // ---- native HDR presentation (video.md §16.12) ----
  // An scRGB swapchain is a promise the GPU can keep and the pixels still be wrong: the
  // measured "looks HDR, is SDR" failure was an SkColorFilters::Matrix gain, which clamps
  // its output at 1.0, so 203-nit white came out as 80 nits and every highlight above it
  // was cut. These pins keep the shape that was measured to work (kModulate of a
  // LINEAR-tagged colour) and keep the SDR default byte-identical.
  const d3d = readNorm(join(root, 'vendor', 'd3d_glue.cc'));
  check('HDR presentation is opt-in and defaults off',
    d3d.includes('static int d3d_hdr_requested(void)') &&
    d3d.includes('getenv("ASC_HDR")') &&
    d3d.includes('static int g_hdr_req = -1;'));
  check('the HDR request is a request, not a verdict: it falls back to SDR',
    d3d.includes('DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709') &&
    d3d.includes('CheckColorSpaceSupport'));
  check('the HDR swapchain is F16 scRGB, which is what DXGI accepts for scRGB',
    d3d.includes('#define SK_D3D_HDR_FORMAT DXGI_FORMAT_R16G16B16A16_FLOAT') &&
    d3d.includes('kRGBA_F16_SkColorType') &&
    d3d.includes('SkColorSpace::MakeSRGBLinear()'));
  check('SDR white is lifted by a linear multiply, not a colour-matrix filter',
    d3d.includes('SkBlendMode::kModulate') &&
    d3d.includes('SkColorSpace::MakeSRGBLinear().get()') &&
    !/setColorFilter\(SkColorFilters::Matrix/.test(d3d));
  check('the present gain is white/80 (scRGB stores 1.0 == 80 nits)',
    d3d.includes('#define SK_D3D_HDR_NITS_PER_UNIT 80.0') &&
    d3d.includes('w->hdr_white / (float)SK_D3D_HDR_NITS_PER_UNIT'));
  check('the window answers whether it is HDR, so video cannot disagree with it',
    d3d.includes('int sk_gpu_hdr_active(void)') && d3d.includes('float sk_gpu_hdr_white(void)'));
  // The video side: HDR frames become linear F16 for an scRGB window and tone-mapped
  // BGRA for an SDR one, and the decision is asked every frame (a window can fall back
  // to SDR behind our back after a device-lost rebuild).
  check('video output form follows the window, not an env var',
    glue.includes('const int window_hdr = sk_gpu_hdr_active();') &&
    glue.includes('as_hdr_tonemap_rgb48_f16(v->hdr, v->rgb48, w * 6, v->rgba16, w * 8, w, h,') &&
    glue.includes('img = sk_image_from_f16(v->rgba16, w, h);') &&
    glue.includes('img = sk_image_from_argb(v->bgra, w, h);'));
  check('an HDR window is enough to take the HDR route (no AS_VIDEO_HDR needed)',
    glue.includes('(as_video_hdr_wanted() || sk_gpu_hdr_active())'));
  const skglue = readNorm(join(root, 'vendor', 'skia_glue.cc'));
  check('the decoded HDR frame is tagged sRGB-linear so it is not encoded twice',
    skglue.includes('void* sk_image_from_f16(const void* px, int w, int h)') &&
    /SkImageInfo::Make\(w, h, kRGBA_F16_SkColorType, kUnpremul_SkAlphaType,\s*\n?\s*SkColorSpace::MakeSRGBLinear\(\)\)/.test(skglue));
  check('a build without the D3D presenter answers "not HDR", not "unknown"',
    glue.includes('static int sk_gpu_hdr_active(void) { return 0; }') &&
    glue.includes('static float sk_gpu_hdr_white(void) { return 0.0f; }'));

  // ---- the adaptive default (V3 step 3, video.md §16.9.6) ----
  // Software is no longer the default answer, it is the default START: open() primes a
  // frame in software (the black-beat guarantee needs it and there is no renderer yet),
  // then the first frame boundary answers the real question and re-opens on the GPU
  // only when the zero-copy probe passes. Each pin below is one way for that to go
  // silently wrong: a default that quietly became "always hardware" (twice the cost
  // with readback), an upgrade that never happens (the measured win is unreachable),
  // or a second device per stream (two table entries, and the 4-entry table ran out on
  // the third NetStream -- measured).
  const mode = /static int as_video_decode_mode\(void\) \{([\s\S]*?)\n\}/.exec(glue)?.[1] ?? '';
  check('an unset AS_VIDEO_DECODE means AUTO, not software',
    mode.includes('return 2;') && mode.includes('strcmp(want, "auto") != 0'));
  check('soft/cpu still force the CPU decoder',
    mode.includes('strcmp(want, "soft") == 0') && mode.includes('strcmp(want, "cpu") == 0') &&
    mode.includes('return 0;'));
  check('open() still primes a frame, so play() then draw is not black',
    glue.includes('as_video_advance(v, NULL, 0.0, -1.0);'));
  check('the GPU upgrade is gated on a passing zero-copy probe',
    glue.includes('const int ok = as_video_zc_available(grctx, v->hw_dev11, v->w, v->h, v->src_10bit);') &&
    glue.includes('as_video_hw_detach(v);   // drops the device AND its table entry'));
  check('the upgrade waits for a renderer, then never asks twice',
    glue.includes('if (v->decided || v->failed) return;') &&
    glue.includes('if (grctx == NULL) return;') && glue.includes('v->decided = 1;'));
  check('the upgrade rewinds through the seek path (the prime is the only re-decode)',
    glue.includes('v->seek_to = 0.0;'));
  check('one D3D11 device per stream: the reopen reuses the probe device',
    glue.includes('AVBufferRef* dev = v->hw_device;') &&
    !glue.includes('probe_dev'));
  check('the probe leaves its entry initialised for the first real frame',
    zc.includes('zc_make_stage(s, nullptr, sfmt, w, h)') &&
    /extern "C" int sk_video_d3d_probe\(void\* ctx, void\* dev11, int w, int h, int ten_bit\)/.test(zc));
  check('a build without a zero-copy seam still answers the probe (with 0)',
    glue.includes('static int sk_video_zc_probe(void* ctx, void* dev, int w, int h, int ten_bit)') &&
    glue.includes('return 0;'));
  // Audio-only streams have no video context at all: the gate must not stop them.
  check('the "decoder not open" gate only applies to streams with video',
    glue.includes('if (v->vs >= 0 && !v->vc_open) return;'));

  // ---- HDR -> SDR tone mapping (video.md §16.10) ----
  // The colour numbers are the whole point of vendor/video_hdr.c, and a source-level
  // pin cannot check a curve. So this group COMPILES the real file with a tiny driver
  // and asserts the shape end to end -- exactly the kind of check that would have caught
  // the first version's BT.2408 white point (203 nits), which made a dark HDR scene land
  // at a mean of 8.8 against the pass-through path's 16.8.
  check('the mapping is opt-in and never touches an SDR stream',
    glue.includes('static int as_video_hdr_wanted(void)') &&
    /const char\* e = getenv\("AS_VIDEO_HDR"\);\n    if \(e == NULL\) cached = 0;/.test(glue) &&
    glue.includes('if (trc == AVCOL_TRC_SMPTE2084) return 1;') &&
    glue.includes('if (trc == AVCOL_TRC_ARIB_STD_B67) return 2;'));
  check('the verdict comes from the transfer function, not the bit depth',
    glue.includes('v->v_trc = st->codecpar->color_trc;') &&
    !glue.includes('src_10bit && as_video_hdr'));
  check('zero copy is off while tone mapping is on (Skia cannot map, so RGB is required)',
    /as_video_zc_wanted\(\) &&\n          v->hdr == NULL && !sk_gpu_hdr_active\(\)/.test(glue));
  check('tone mapping keeps the CPU decode (GPU would add the readback on top)',
    glue.includes('if ((as_video_hdr_wanted() || sk_gpu_hdr_active()) && as_video_hdr_kind(v->v_trc) != 0) {'));
  check('the mapping input is 16-bit RGB, so a 10-bit source keeps its bits',
    glue.includes('AV_PIX_FMT_RGB48LE') && glue.includes('sws_setColorspaceDetails') &&
    glue.includes('SWS_CS_BT2020'));
  check('AS_VIDEO_STATS reports the HDR route and its two costs',
    glue.includes('hdr=%s') && glue.includes('sws=%.2fms map=%.2fms'));
  const manifestWithHdr = readNorm(join(root, 'examples', 'video', 'video.build.json'));
  check('the video manifest compiles the tone-mapping file',
    manifestWithHdr.includes('video_hdr.c'));

  // Numeric: compile the real implementation and check the curve by running it.
  const cc = (() => {
    for (const c of ['clang', 'cc', 'gcc']) {
      try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return c; } catch { /* next */ }
    }
    return null;
  })();
  if (cc === null) {
    console.log('SKIP  [video] no C compiler for the tone-mapping probe');
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'as-hdr-'));
    const drv = join(dir, 'drv.c');
    const exe = join(dir, process.platform === 'win32' ? 'drv.exe' : 'drv');
    writeFileSync(drv, `
#include <stdio.h>
#include <math.h>
#include <string.h>
#include <stdlib.h>
#include "${join(root, 'vendor', 'video_hdr.h').replace(/\\/g, '/')}"
static double pq_code(double nits) {
  const double m1 = 2610.0 / 16384.0, m2 = 2523.0 / 4096.0 * 128.0;
  const double c1 = 3424.0 / 4096.0, c2 = 2413.0 / 4096.0 * 32.0, c3 = 2392.0 / 4096.0 * 32.0;
  double p = pow(nits / 10000.0, m1);
  return pow((c1 + c2 * p) / (1.0 + c3 * p), m2);
}
// IEEE half -> double, for reading the F16 present buffer back in the probe.
static double half_at(const unsigned char* p) {
  const unsigned short h = (unsigned short)(p[0] | (p[1] << 8));
  const int sign = (h >> 15) & 1, exp = (h >> 10) & 0x1f, man = h & 0x3ff;
  double v = exp == 0 ? (double)man * (1.0 / 16777216.0)
                      : (double)(man | 0x400) * ldexp(1.0, exp - 25);
  return sign ? -v : v;
}
int main(void) {
  as_hdr* h = as_hdr_create(1, 1);
  if (!h) { printf("create=0\\n"); return 1; }
  const double nits[] = {0, 1, 4, 18, 50, 100, 203, 1000, 4000};
  printf("create=1\\n");
  for (int i = 0; i < 9; ++i)
    printf("m %g %d\\n", nits[i], as_hdr_map8(h, (int)(pq_code(nits[i]) * 65535.0 + 0.5)));
  int mono = 1, prev = -1;
  for (int c = 0; c <= 65535; c += 97) { int v = as_hdr_map8(h, c); if (v < prev) mono = 0; prev = v; }
  printf("mono=%d\\n", mono);
  printf("tau_default=%.3f\\n", as_hdr_curve_tau(h));
  // No metadata: the scene peak is unknown, so the curve stays at the measured default.
  const int peak367_off = as_hdr_map8(h, (int)(pq_code(367.0) * 65535.0 + 0.5));
  as_hdr_set_gain(h, 2.0f);
  printf("gain18=%d\\n", as_hdr_map8(h, (int)(pq_code(18) * 65535.0 + 0.5)));
  as_hdr_set_gain(h, 0.0f);
  printf("gain_bad_still=%d\\n", as_hdr_map8(h, (int)(pq_code(18) * 65535.0 + 0.5)));
  as_hdr_set_gain(h, 1.0f);
  // F1: dynamic metadata moves the shoulder, and only where the scene actually reaches it.
  as_hdr_meta m;
  memset(&m, 0, sizeof m);
  m.kind = 1; m.peak_nits = 367.0f; m.avg_nits = 3.7f; m.master_nits = 1000.0f;
  as_hdr_set_meta(h, &m);
  printf("tau367=%.3f\\n", as_hdr_curve_tau(h));
  printf("peak367=%g\\n", (double)as_hdr_scene_peak(h));
  printf("meta_kind=%d\\n", as_hdr_meta_kind(h));
  printf("peak367_on=%d\\n", as_hdr_map8(h, (int)(pq_code(367.0) * 65535.0 + 0.5)));
  printf("peak367_off=%d\\n", peak367_off);
  // Below the knee the two curves must agree exactly: an adaptive shoulder that moved the
  // mid-tones would make the picture pulse between scenes.
  printf("mid18_on=%d\\n", as_hdr_map8(h, (int)(pq_code(18) * 65535.0 + 0.5)));
  m.peak_nits = 143.0f; as_hdr_set_meta(h, &m); printf("tau143=%.3f\\n", as_hdr_curve_tau(h));
  m.peak_nits = 4000.0f; as_hdr_set_meta(h, &m); printf("tau4000=%.3f\\n", as_hdr_curve_tau(h));
  m.peak_nits = 10000.0f; as_hdr_set_meta(h, &m); printf("tau10000=%.3f\\n", as_hdr_curve_tau(h));
  as_hdr_destroy(h);

  // F2: HLG. At R=G=B the BT.2100 OOTF is exactly the per-channel value (the luminance
  // of a grey IS that grey), so as_hdr_map8 must agree with the frame path there.
  as_hdr* g = as_hdr_create(2, 1);
  printf("hlg0=%d hlgmid=%d\\n", as_hdr_map8(g, 0), as_hdr_map8(g, 49152));
  unsigned short cv = 32768;
  unsigned char src[2 * 6], dst[2 * 4];
  memset(src, 0, sizeof src);
  src[0] = cv & 0xff; src[1] = cv >> 8;                 // pixel 0: red only
  src[6] = cv & 0xff; src[7] = cv >> 8;                 // pixel 1: neutral
  src[8] = cv & 0xff; src[9] = cv >> 8;
  src[10] = cv & 0xff; src[11] = cv >> 8;
  as_hdr_tonemap_rgb48(g, src, 12, dst, 8, 2, 1);
  printf("hlg_red_b=%d\\n", dst[0]);
  printf("hlg_red_g=%d\\n", dst[1]);
  printf("hlg_red_r=%d\\n", dst[2]);
  printf("hlg_neutral_r=%d\\n", dst[6]);
  printf("hlg_neutral_g=%d\\n", dst[5]);
  printf("hlg_neutral_b=%d\\n", dst[4]);
  printf("hlg_grey_map=%d\\n", as_hdr_map8(g, 32768));
  as_hdr_set_hlg_peak(g, 400.0f);
  printf("hlg400_mid=%d\\n", as_hdr_map8(g, 49152));
  as_hdr_set_hlg_peak(g, 10.0f);
  printf("hlg_bad_peak=%d\\n", as_hdr_map8(g, 49152));
  as_hdr_destroy(g);

  // F3: local mapping. A flat field must come out identical to the global path (the
  // operator may not shift exposure when there is no neighbourhood), a dark patch inside
  // a bright frame must be lifted, and the bright part must be left alone in lift mode.
  as_hdr* L = as_hdr_create(1, 1);
  const int w = 256, ht = 128;
  unsigned char* s2 = (unsigned char*)malloc((size_t)w * ht * 6);
  unsigned char* d2 = (unsigned char*)malloc((size_t)w * ht * 4);
  unsigned short brightc = (unsigned short)(pq_code(300.0) * 65535.0 + 0.5);
  unsigned short darkc = (unsigned short)(pq_code(8.0) * 65535.0 + 0.5);
  for (int yy = 0; yy < ht; ++yy)
    for (int xx = 0; xx < w; ++xx) {
      unsigned short v = (xx < 32) ? darkc : brightc;
      unsigned char* p = s2 + ((size_t)yy * w + xx) * 6;
      p[0] = v & 0xff; p[1] = v >> 8; p[2] = v & 0xff; p[3] = v >> 8;
      p[4] = v & 0xff; p[5] = v >> 8;
    }
  as_hdr_tonemap_rgb48(L, s2, w * 6, d2, w * 4, w, ht);
  printf("gl_dark=%d\\n", d2[(64 * w + 8) * 4 + 2]);
  printf("gl_light=%d\\n", d2[(64 * w + 200) * 4 + 2]);
  as_hdr_set_local(L, 0.25f);
  printf("local_mode=%d\\n", as_hdr_local_mode(L));
  for (int it = 0; it < 20; ++it) as_hdr_tonemap_rgb48(L, s2, w * 6, d2, w * 4, w, ht);
  printf("lc_dark=%d\\n", d2[(64 * w + 8) * 4 + 2]);
  printf("lc_light=%d\\n", d2[(64 * w + 200) * 4 + 2]);
  printf("lc_gain=%g\\n", (double)as_hdr_last_gain(L));
  as_hdr_set_local_mode(L, 1);
  for (int it = 0; it < 20; ++it) as_hdr_tonemap_rgb48(L, s2, w * 6, d2, w * 4, w, ht);
  printf("both_light=%d\\n", d2[(64 * w + 200) * 4 + 2]);
  printf("both_mode=%d\\n", as_hdr_local_mode(L));
  // Flat field: every neighbourhood equals the anchor, so every gain is exactly 1.
  for (int yy = 0; yy < ht; ++yy)
    for (int xx = 0; xx < w; ++xx) {
      unsigned char* p = s2 + ((size_t)yy * w + xx) * 6;
      p[0] = brightc & 0xff; p[1] = brightc >> 8; p[2] = brightc & 0xff; p[3] = brightc >> 8;
      p[4] = brightc & 0xff; p[5] = brightc >> 8;
    }
  as_hdr_set_local_mode(L, 0);
  for (int it = 0; it < 20; ++it) as_hdr_tonemap_rgb48(L, s2, w * 6, d2, w * 4, w, ht);
  printf("flat_local=%d\\n", d2[(64 * w + 100) * 4 + 2]);
  printf("flat_gain=%g\\n", (double)as_hdr_last_gain(L));
  as_hdr_set_local(L, 0.0f);
  printf("local_off=%d\\n", as_hdr_local_strength(L));
  free(s2); free(d2);
  as_hdr_destroy(L);

  // F4: native HDR presentation (docs §16.12). as_hdr_tonemap_rgb48_f16 must produce
  // LINEAR light in units of the SDR white level -- no shoulder, no OETF, and nothing
  // clamped: on a 203-nit white level a 1000-nit patch is 4.93, which is the whole
  // point of an scRGB swapchain (1.0 == 80 nits, so 4.93 == 394 nits after the
  // window's own gain). A curve here would compress highlights the display is about to
  // map itself, and a clamp would silently turn "HDR" into 8-bit SDR.
  {
    as_hdr* F = as_hdr_create(1, 1);
    unsigned char fsrc[3 * 6], fdst[3 * 8];
    memset(fsrc, 0, sizeof fsrc);
    memset(fdst, 0, sizeof fdst);
    const double fnits[3] = {100.0, 203.0, 1000.0};
    for (int i = 0; i < 3; ++i) {
      const unsigned short v = (unsigned short)(pq_code(fnits[i]) * 65535.0 + 0.5);
      for (int c = 0; c < 3; ++c) {
        fsrc[i * 6 + c * 2] = (unsigned char)(v & 0xff);
        fsrc[i * 6 + c * 2 + 1] = (unsigned char)(v >> 8);
      }
    }
    as_hdr_tonemap_rgb48_f16(F, fsrc, 18, fdst, 24, 3, 1, 203.0f);
    for (int i = 0; i < 3; ++i) {
      printf("f16_%d=%g\\n", (int)fnits[i], (double)half_at(fdst + i * 8));
    }
    // A second white level must move the whole picture by exactly the ratio: this is
    // what keeps video and 2D chrome on the same scale when ASC_HDR_WHITE changes.
    as_hdr_tonemap_rgb48_f16(F, fsrc, 18, fdst, 24, 3, 1, 100.0f);
    printf("f16w100_203=%g\\n", (double)half_at(fdst + 8));
    printf("f16_badwhite=%d\\n", as_hdr_tonemap_rgb48_f16(F, fsrc, 18, fdst, 24, 3, 1, 0.0f));
    printf("f16_badargs=%d\\n", as_hdr_tonemap_rgb48_f16(NULL, fsrc, 18, fdst, 24, 3, 1, 203.0f));
    as_hdr_destroy(F);
  }
  return 0;
}
`);
    let out = '';
    try {
      execFileSync(cc, ['-O1', '-o', exe, drv, join(root, 'vendor', 'video_hdr.c')], { stdio: 'pipe' });
      out = execFileSync(exe, [], { encoding: 'utf8', timeout: 60000 });
    } catch (e) {
      out = '';
      const se = (e as { stderr?: string }).stderr ?? '';
      console.log(`      tone-mapping probe failed: ${String(se || (e as Error).message).slice(0, 400)}`);
    }
    // The driver prints key=value for scalars and `m <nits> <code>` for the curve.
    const num = (name: string): number => {
      const m = new RegExp(`^${name}=(\\S+)$`, 'm').exec(out);
      return m ? Number(m[1]) : NaN;
    };
    const at = (nits: string): number => {
      const m = new RegExp(`^m ${nits} (\\d+)$`, 'm').exec(out);
      return m ? Number(m[1]) : NaN;
    };
    check('the tone-mapping probe builds and runs', out.includes('create=1'));
    check('PQ black maps to 0 and the curve is monotonic',
      at('0') === 0 && num('mono') === 1);
    check('reference white (100 nits) is near the top of the range',
      at('100') >= 200 && at('100') <= 245);
    check('1000 nits is brighter than 100 nits and still below clip',
      at('1000') >= at('100') && at('1000') <= 255);
    // Shadows stay visible: the first version mapped 18 nits to 84 (with BT.2408's 203
    // nit white) and a real scene lost its shadow detail to clipping at the bottom.
    check('shadows are not crushed (18 nits lands in the visible middle)',
      at('18') >= 100 && at('18') <= 165);
    check('gain scales the picture, and a bad gain is rejected rather than blacking out',
      num('gain18') > at('18') && num('gain_bad_still') === num('gain18'));
    check('HLG shares the same output range',
      num('hlg0') === 0 || out.includes('hlg0=0'));

    // --- F1: HDR10+ / Dolby Vision dynamic metadata drives the shoulder ---
    // Tau is the shoulder's soft-knee width in reference-white units. Without metadata
    // it sits at the measured default; a 367-nit scene peak shortens it (the highlights
    // get to keep their level) and a 4000-nit peak hits the 8.0 clamp (fully soft).
    check('the default shoulder is the measured 4.0', num('tau_default') === 4);
    check('a 367-nit scene peak tightens the shoulder',
      num('tau367') > 1.0 && num('tau367') < 2.0);
    check('a dim 143-nit scene shortens the shoulder further, a 4000-nit one clamps it',
      num('tau143') > 0.2 && num('tau143') < 0.6 && num('tau4000') === 8);
    check('an absurd peak is clamped rather than producing a negative shoulder',
      num('tau10000') === 8);
    check('metadata is recorded on the mapper (kind + scene peak)',
      num('meta_kind') === 1 && num('peak367') > 360 && num('peak367') < 375);
    // The point of the adaptive shoulder: the peak of the scene lands higher, so a 500-nit
    // graded highlight is no longer flattened to the same place as a 4000-nit one.
    check('dynamic metadata lifts the scene peak above the fixed-shoulder result',
      num('peak367_on') > num('peak367_off'));
    // ...and it must not touch the mid-tones, or the picture would pulse scene to scene.
    check('the adaptive shoulder leaves 18 nits exactly where it was',
      num('mid18_on') === at('18'));

    // --- F2: HLG complete BT.2100 OOTF ---
    // At R=G=B the OOTF luminance term is the grey's own value, so the frame path and the
    // per-channel table must agree. A saturated colour must NOT: its luminance is that of
    // the weighted mix, which is where the cross-channel term shows up.
    check('HLG is unchanged on the neutral axis (grey = per-channel table)',
      Math.abs(num('hlg_neutral_r') - num('hlg_grey_map')) <= 1 &&
      num('hlg_neutral_g') === num('hlg_neutral_r'));
    // Red-only at 10-bit code 32768. Three candidate answers, all computed by hand from
    // the spec: full BT.2100 OOTF plus the BT.2020->709 matrix = 218; the old per-channel
    // gamma (alpha*E^1.2), which never looks at Y = 225; the OOTF with no matrix = 190.
    // The band is what separates the first from the other two.
    check('HLG applies the cross-channel OOTF to saturated colour',
      num('hlg_red_r') >= 210 && num('hlg_red_r') <= 222);
    // A saturated primary sits above the grey of the same code (BT.2020 red is wider than
    // BT.709 red, so the matrix has to expand it); an implementation that lost either the
    // matrix or the OOTF would land on the wrong side of this.
    check('a saturated primary is expanded above the same code as grey',
      num('hlg_red_r') > num('hlg_neutral_r'));
    check('HLG carries no chroma into the other channels',
      num('hlg_red_g') === 0 && num('hlg_red_b') === 0);
    check('colours and grey of equal code do not collide (the OOTF is not per-channel)',
      num('hlg_red_r') !== num('hlg_neutral_r'));
    check('the HLG nominal peak changes the output, and an absurd peak is rejected',
      num('hlg400_mid') !== num('hlgmid') && num('hlg_bad_peak') > 0);

    // --- F3: local (spatially varying) tone mapping ---
    // A dark patch inside an otherwise bright frame: global leaves it at 102, the local
    // operator lifts it ~25 codes while the bright side stays put (lift-only default).
    check('local tone mapping lifts a dark region inside a bright frame',
      num('lc_dark') - num('gl_dark') >= 15);
    check('lift-only local mapping leaves the bright region alone',
      Math.abs(num('lc_light') - num('gl_light')) <= 2);
    check('the default local mode is lift-only', num('local_mode') === 0);
    check('two-sided mode is available and does compress the bright side',
      num('both_mode') === 1 && num('both_light') < num('lc_light'));
    // A flat field has no neighbourhood: every gain must be 1, or the operator would
    // shift exposure on ordinary content.
    check('a flat field passes through the local operator unchanged',
      Math.abs(num('flat_local') - num('gl_light')) <= 2 &&
      Math.abs(num('flat_gain') - 1) < 0.01);
    check('local strength 0 turns the pass off', num('local_off') === 0);
    // Native HDR present (§16.12): linear light in SDR-white units, nothing clamped.
    // The three source patches are PQ code values that decode to exactly 100/203/1000
    // nits, so the stored values are nits/white with no curve in between.
    check('the F16 present pass stores nits/white (100 nits on a 203-nit white) ',
      Math.abs(num('f16_100') - 100 / 203) < 0.01);
    check('SDR white lands on 1.0 in the F16 present buffer',
      Math.abs(num('f16_203') - 1.0) < 0.01);
    check('highlights above SDR white are NOT clamped (>1.0 survives)',
      num('f16_1000') > 4.5 && num('f16_1000') < 5.4);
    check('the whole buffer scales with the requested white level',
      Math.abs(num('f16w100_203') - 203 / 100) < 0.02);
    check('an invalid white level and a NULL context are refused, not guessed',
      num('f16_badwhite') === 0 && num('f16_badargs') === 0);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`[video] ${ok} check(s) passed`);
  return bad;
}

registerGroup('video/', checkVideoSurface);