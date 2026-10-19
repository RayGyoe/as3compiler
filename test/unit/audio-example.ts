// Unit checks: the self-owned encoded-audio example (examples/audio/).
//
// WHY this exists at all. Of the two audio examples that predate it, neither
// touched the encoded-file route: `examples/audio.as` feeds SYNTHESIZED PCM to
// `loadPCMFromByteArray`, and `examples/embed.as` decodes an mp3 baked in at
// COMPILE time. So `Sound.load(URLRequest)` — the asynchronous file load and its
// `bytesLoaded`/`bytesTotal`/`url`/`length`/`id3` surface, plus `SoundChannel`
// playback and the `soundComplete` lifecycle — had no regression input anywhere.
// What LOOKED like coverage was three pins in platform.ts reading a THIRD-PARTY
// Starling sample's `AssetManager.as`; they asserted Starling's own classes, not
// this compiler, and went away with the external fixtures in 阶段一百九十八.
//
// The replacement is `examples/audio/AudioPlayer.as` + `clip.mp3`, both owned by
// this repo, so the pins below read a fixture that cannot be re-cloned into a
// different shape underneath them. The fixture is the FULL audio track of the
// product video in the README (see docs/zh-cn/audio.md §13.5), not a synthesised
// beep: decoding a real MPEG-1 Layer III stream is the thing under test.
//
// Two things are pinned that a source grep would otherwise miss, and both are
// deliberate divergences rather than oversights:
//   * the player is WINDOWED, so the suite must compile+link it and NOT run it
//     (`soundComplete` is dispatched by `as_audio_tick()` from the window frame
//     loop, so there is no headless way to observe it);
//   * the fixture must stay free of container metadata. The audio was demuxed from
//     an mp4 with ffmpeg, which copies the container's own `major_brand`/`Remotion`
//     into TXXX frames unless it is told not to — those leaked through once and are
//     asserted absent below, so a future re-extraction that skips the cleanup fails
//     here instead of shipping someone else's tooling metadata in the fixture.
//
// Re-run alone with:
//   node --test --test-name-pattern='audio-example/' test/unit/*.ts
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { root, dir } from '../harness.ts';
import { registerGroup } from '../harness.ts';

// The byte size the player itself asserts on (AudioPlayer.as). Kept here as a
// second copy ON PURPOSE: the two must agree, and the check below compares them
// rather than trusting either one alone.
const FIXTURE_BYTES = 1890142;

function checkAudioExample(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [audio-example] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [audio-example] ${label}`); }
  };

  const audioDir = join(dir, 'audio');
  const clipPath = join(audioDir, 'clip.mp3');
  const playerPath = join(audioDir, 'AudioPlayer.as');
  const manifestPath = join(audioDir, 'player.build.json');

  // ---------------------------------------------------------------------
  // 1. The fixture itself: present, and a real ID3v2.3 + MPEG-1 Layer III file.
  // ---------------------------------------------------------------------
  if (!existsSync(clipPath) || !existsSync(playerPath) || !existsSync(manifestPath)) {
    check('examples/audio/{clip.mp3,AudioPlayer.as,player.build.json} all exist', false);
    console.log(`[audio-example] ${ok} example checks passed`);
    return bad;
  }
  const buf = readFileSync(clipPath);
  const player = readFileSync(playerPath, 'utf8');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

  check('the tracked fixture is the file the player asserts on (size agrees)',
    statSync(clipPath).size === FIXTURE_BYTES && player.includes(String(FIXTURE_BYTES)));

  // ID3v2 header: "ID3", version 2.3, then a SYNCHSAFE size (7 bits per byte) that
  // says where the audio starts. Both are read rather than assumed: if the tag is
  // ever re-written to v2.4 with an extended header the offset moves, and a hard
  // coded 132 would then silently point into the middle of the tag.
  const isId3 = buf.subarray(0, 3).toString('latin1') === 'ID3';
  const id3Ver = buf[3];
  const tagSize = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
  const frameAt = 10 + tagSize;
  const syncOk = buf[frameAt] === 0xff && buf[frameAt + 1] === 0xfb;  // MPEG-1 Layer III, no CRC
  const bitrateIdx = (buf[frameAt + 2] >> 4) & 0xf;                   // 9 = 128 kbps
  const rateIdx = (buf[frameAt + 2] >> 2) & 0x3;                      // 0 = 44100 Hz
  const chanMode = (buf[frameAt + 3] >> 6) & 0x3;                     // 0 = stereo
  check('the fixture is ID3v2.3 followed by a first MPEG-1 Layer III frame',
    isId3 && id3Ver === 3 && syncOk && bitrateIdx === 9 && rateIdx === 0 && chanMode === 0);

  // Our own three text frames, and nothing the mp4 container dragged in.
  const head = buf.subarray(0, 256).toString('latin1');
  check('the fixture carries the three tags the player reads (TIT2/TPE1/TALB)',
    head.includes('TIT2') && head.includes('TPE1') && head.includes('TALB')
    && head.includes('TalkMED AOT audio fixture'));
  check('...and none of the demuxer/container leftovers (TXXX / Remotion / major_brand)',
    !buf.includes('TXXX') && !buf.includes('Remotion') && !buf.includes('major_brand'));

  // ---------------------------------------------------------------------
  // 2. The player: it exercises the encoded-load route, not just PCM.
  // ---------------------------------------------------------------------
  check('the player loads a FILE through Sound.load(URLRequest)',
    player.includes('snd.load(new URLRequest(p));'));
  check('the player plays through a SoundChannel and observes soundComplete',
    player.includes('SoundChannel') && player.includes('Event.SOUND_COMPLETE'));
  check('the player assigns the returned channel (a null channel must not be faked)',
    player.includes('chan = snd.play(from, 0, st);') && player.includes('if (chan == null)'));
  check('the player keeps the honest no-device path instead of assuming it can play',
    player.includes('SoundMixer.areSoundsInaccessible()'));
  check('the default path names the fixture',
    player.includes('"examples/audio/clip.mp3"'));
  check('volume goes through SoundTransform, including on the live channel',
    player.includes('new SoundTransform(vol, 0)') && player.includes('chan.soundTransform = new SoundTransform(vol, 0);'));
  // The only file-selection affordance is a text field (AIR's native dialog is not
  // implemented in this backend). Under a CJK input method letters enter the IME's
  // composition and produce NO textInput until the user commits with Enter -- a
  // measured trap that once made the whole channel look dead. The hint has to keep
  // saying so, or the example silently misleads the one user who can't type into it.
  check('the path box still states the CJK-IME commit step (measured, not cosmetic)',
    player.includes('回车确认'));

  // ---------------------------------------------------------------------
  // 3. The build manifest: that the audio backend is actually compiled in.
  // ---------------------------------------------------------------------
  const sources = Array.isArray(manifest['sources']) ? (manifest['sources'] as string[]) : [];
  const defines = Array.isArray(manifest['defines']) ? (manifest['defines'] as string[]) : [];
  check('the manifest compiles vendor/audio_glue.c into the build',
    sources.some((s) => s.endsWith('vendor/audio_glue.c')));
  check('the manifest defines ASC_HAVE_AUDIO (else the seam degrades to no-backend)',
    defines.includes('ASC_HAVE_AUDIO=1'));
  check('the manifest also defines the window and Skia seams this example needs',
    defines.includes('ASC_USE_WINDOW=1') && defines.includes('ASC_USE_SKIA=1'));
  check('the manifest targets a native binary (the web backend cannot link miniaudio)',
    manifest['target'] === 'native');

  // ---------------------------------------------------------------------
  // 4. The suite wiring: compile+link, and never a run.
  // ---------------------------------------------------------------------
  const exSrc = readFileSync(join(root, 'test', 'examples.ts'), 'utf8');
  const skipSet = /const SKIP_DIRS = new Set\(\[([^\]]*)\]\)/.exec(exSrc);
  check('`audio` is in SKIP_DIRS (a windowed directory unit would hang the pool)',
    skipSet !== null && /'audio'/.test(skipSet[1]));
  // Slice THIS case's body out (up to the next top-level test) rather than a fixed
  // window of characters, so adding a line above cannot silently move the assertion
  // off the code it is meant to cover. The `test('` prefix is part of the needle
  // because the SKIP_DIRS comment above quotes the same case name -- anchoring on the
  // name alone matched that comment first and then sliced across the whole driver.
  const caseAt = exSrc.indexOf("test('example: audio/ (windowed: compile+link only)'");
  const rest = caseAt >= 0 ? exSrc.slice(caseAt) : '';
  const nextCase = rest.indexOf('\ntest(');
  const caseSrc = nextCase >= 0 ? rest.slice(0, nextCase) : rest;
  check('the dedicated case exists, names the manifest, and passes NO --run',
    caseSrc.includes("'--manifest'") && !caseSrc.includes("'--run'"));

  if (ok > 0) console.log(`[audio-example] ${ok} example checks passed`);
  return bad;
}

registerGroup('unit: examples/AudioPlayer', checkAudioExample);
