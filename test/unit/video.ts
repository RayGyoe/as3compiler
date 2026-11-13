// Unit checks: the video surface (flash.net.NetStream / flash.media.Video).
//
// The examples suite can only prove "a windowed program plays four fixtures and
// asserts 31 things"; the invariants below are the ones a mutation breaks
// silently, and several of them were found by measurement (docs/zh-cn/video.md
// §16.3/§16.4 records the failure each one prevents). Re-run alone with:
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

  console.log(`[video] ${ok} check(s) passed`);
  return bad;
}

registerGroup('video/', checkVideoSurface);