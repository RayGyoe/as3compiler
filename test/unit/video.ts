// Unit checks: the video surface (flash.net.NetStream / flash.media.Video).
//
// The examples suite proves the runtime behaviour end to end (examples/video-headless.as:
// four containers, the clock, pause/resume, the audio-only stream); the invariants below
// are the ones a mutation breaks silently, and several of them were found by measurement
// (docs/zh-cn/video.md §16.3/§16.4/§16.7 records the failure each one prevents). Re-run
// alone with:
//   node --test --test-name-pattern='video/' test/unit/*.ts

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

  const bodyOf = (name: string): string => {
    const at = glue.indexOf(name);
    return at < 0 ? '' : glue.slice(at, at + 6000);
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
  check('hardware decode is opt-in, and software stays the default',
    glue.includes('static int as_video_hw_wanted(void)') &&
    /if \(want == NULL \|\| want\[0\] == 0\) return 0;/.test(glue) &&
    glue.includes('strcmp(want, "soft") == 0'));
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
  check('the zero-copy seam is D3D-gated with NULL fallbacks (other builds still link)',
    glue.includes('#if defined(ASC_RENDER_D3D) && ASC_RENDER_D3D && defined(ASC_USE_SKIA)') &&
    glue.includes('static void* sk_video_d3d_image(void* ctx, void* tex, int slice, int w, int h,'));
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
    glue.indexOf('zc_img = sk_video_d3d_image(') > 0 &&
    glue.indexOf('zc_img = sk_video_d3d_image(') < glue.indexOf('av_hwframe_transfer_data(v->sw_frame') &&
    glue.includes('av_hwframe_transfer_data(v->sw_frame, v->frame, 0)'));
  check('the table entry is dropped before FFmpeg releases the device',
    glue.indexOf('sk_video_d3d_forget(v->hw_dev11)') > 0 &&
    glue.indexOf('sk_video_d3d_forget(v->hw_dev11)') < glue.indexOf('av_buffer_unref(&v->hw_device)'));
  check('AS_VIDEO_STATS separates zero-copy frames from readback frames',
    glue.includes('d3d11va-zero-copy') && glue.includes('zc=%lld starved=%lld'));
  check('a hardware frame\'s 10-bit-ness is read from its frames context',
    glue.includes('hf->sw_format == AV_PIX_FMT_P010LE'));
  const manifestWithSeam = readNorm(join(root, 'examples', 'video', 'video.build.json'));
  check('the Windows video manifest compiles the zero-copy seam',
    manifestWithSeam.includes('"${win:../../vendor/video_d3d.cc}"'));

  console.log(`[video] ${ok} check(s) passed`);
  return bad;
}

registerGroup('video/', checkVideoSurface);