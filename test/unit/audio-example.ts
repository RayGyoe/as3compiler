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
// The fixture swapped on 2026-11-13, at the user's request, to Cambridge English's
// Movers Sample Listening Test vol2 (28.7 min, mono, 64 kbps). That is THIRD-PARTY
// audio, not a repo-owned asset — the previous fixture (the TalkMED product video's
// full audio track, 118 s / 128 kbps stereo) was removed with it. Two consequences
// the pins below depend on:
//   * every number here was MEASURED from this exact file, so replacing the audio
//     means re-measuring, not just recompiling;
//   * it is long and mono, so `extract()`'s "always 44.1 kHz stereo" rule is now
//     exercised on a real mono source, and the byte-path self-check only decodes a
//     512 KB prefix (a full second decode would cost another ~300 MB of PCM).
//
// Two things are pinned that a source grep would otherwise miss, and both are
// deliberate rather than oversights:
//   * the player is WINDOWED, so the suite must compile+link it and NOT run it
//     (`soundComplete` is dispatched by `as_audio_tick()` from the window frame
//     loop, so there is no headless way to observe it);
//   * the tag is ID3v2.3 with **no** TIT2/TPE1/TALB (only TRCK/TYER/TENC), which is
//     what makes the player's "absent frames read as null" assertion meaningful:
//     AIR does not invent empty strings for missing frames.
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
const FIXTURE_BYTES = 13710403;
const FIXTURE_NAME = 'movers-vol2.mp3';
// Frames the player's `length` asserts on: 65 915 frames × 1152/44100 = 1 721 861.22 ms.
const FIXTURE_FRAMES = 65915;
const FIXTURE_MS = Math.round((FIXTURE_FRAMES * 1152 / 44100) * 1000);

function checkAudioExample(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [audio-example] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [audio-example] ${label}`); }
  };

  const audioDir = join(dir, 'audio');
  const clipPath = join(audioDir, FIXTURE_NAME);
  const playerPath = join(audioDir, 'AudioPlayer.as');
  const manifestPath = join(audioDir, 'player.build.json');

  // ---------------------------------------------------------------------
  // 1. The fixture itself: present, and a real ID3v2.3 + MPEG-1 Layer III file.
  // ---------------------------------------------------------------------
  if (!existsSync(clipPath) || !existsSync(playerPath) || !existsSync(manifestPath)) {
    check(`examples/audio/{${FIXTURE_NAME},AudioPlayer.as,player.build.json} all exist`, false);
    console.log(`[audio-example] ${ok} example checks passed`);
    return bad;
  }
  const buf = readFileSync(clipPath);
  const player = readFileSync(playerPath, 'utf8');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

  check('the tracked fixture is the file the player asserts on (size agrees)',
    statSync(clipPath).size === FIXTURE_BYTES && player.includes(String(FIXTURE_BYTES)));
  check('the player\'s default path names this fixture',
    player.includes(`"examples/audio/${FIXTURE_NAME}"`));
  check('the player\'s duration assertion matches this fixture\'s frame count',
    player.includes(`snd.length > ${FIXTURE_MS - 1} && snd.length < ${FIXTURE_MS + 1}`));

  // ID3v2 header: "ID3", version 2.3, then a SYNCHSAFE size (7 bits per byte) that
  // says where the audio starts. Both are read rather than assumed: if the tag is
  // ever re-written to v2.4 with an extended header the offset moves, and a hard
  // coded 83 would then silently point into the middle of the tag.
  const isId3 = buf.subarray(0, 3).toString('latin1') === 'ID3';
  const id3Ver = buf[3];
  const tagSize = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
  const frameAt = 10 + tagSize;
  const syncOk = buf[frameAt] === 0xff && buf[frameAt + 1] === 0xfb;  // MPEG-1 Layer III, no CRC
  const bitrateIdx = (buf[frameAt + 2] >> 4) & 0xf;                   // 5 = 64 kbps
  const rateIdx = (buf[frameAt + 2] >> 2) & 0x3;                      // 0 = 44100 Hz
  const chanMode = (buf[frameAt + 3] >> 6) & 0x3;                     // 3 = mono
  check('the fixture is ID3v2.3 followed by a first MPEG-1 Layer III frame',
    isId3 && id3Ver === 3 && tagSize === 73 && syncOk
    && bitrateIdx === 5 && rateIdx === 0 && chanMode === 3);

  // The tag carries exactly three frames, and NONE of the three text frames the
  // player can display — that is why its `songName`/`artist`/`album` assertion says
  // "null for absent frames" even though AIR never invents empty strings for them.
  const head = buf.subarray(0, frameAt).toString('latin1');
  check('the fixture tag is TRCK/TYER/TENC only (no TIT2/TPE1/TALB)',
    head.includes('TRCK') && head.includes('TYER') && head.includes('TENC')
    && !head.includes('TIT2') && !head.includes('TPE1') && !head.includes('TALB'));
  check('the player asserts the tags this file actually has',
    player.includes('snd.id3.track == "1"') && player.includes('snd.id3.year == "2013"')
    && player.includes('snd.id3.songName == null'));

  // ---------------------------------------------------------------------
  // 2. The player: it exercises the encoded-load route, not just PCM.
  // ---------------------------------------------------------------------
  check('the player loads a FILE through Sound.load(URLRequest)',
    player.includes('new URLRequest(isRemote ? clipPath : clip.url)'));
  check('the player plays through a SoundChannel and observes soundComplete',
    player.includes('SoundChannel') && player.includes('Event.SOUND_COMPLETE'));
  check('the player assigns the returned channel (a null channel must not be faked)',
    player.includes('chan = snd.play(from, 0, st);') && player.includes('if (chan == null)'));
  check('the player keeps the honest no-device path instead of assuming it can play',
    player.includes('SoundMixer.areSoundsInaccessible()'));
  check('volume goes through SoundTransform, including on the live channel',
    player.includes('new SoundTransform(vol, 0)') && player.includes('chan.soundTransform = new SoundTransform(vol, 0);'));
  // File selection is a REAL dialog (macOS Cocoa / Windows IFileDialog), and that must
  // stay the path for FILES. The text field came back for a different reason: a panel
  // can only hand back a local path, so it is the only way to reach an http(s) URL --
  // which `Sound.load` supports and this manifest now links (ASC_HAVE_CURL).
  check('file selection goes through the native panel',
    player.includes('browseForOpen') && player.includes('new FileFilter('));
  // The URL row (user request: "why did the network address go away?"). Both halves are
  // needed: the entry box, and the branch that keeps File/FileStream off a remote source
  // (`new File("https://...")` is #2004, so sharing one path for both shapes would throw).
  check('an editable URL/path box exists and feeds the same load path',
    player.includes('urlTf.type = TextFieldType.INPUT') && player.includes('doLoadUrl();'));
  check('remote sources take the URLRequest branch and skip tickTimers (no frozen window)',
    player.includes('return u.indexOf("http://") == 0 || u.indexOf("https://") == 0;')
    && player.includes('new URLRequest(isRemote ? clipPath : clip.url)')
    && player.includes('if (!isRemote) {') && player.includes('tickTimers();'));
  // Progressive playback (docs/zh-cn/audio.md §13.6). The example starts a channel
  // immediately after load() for a remote source and falls back only when the format
  // has no progressive decoder -- the old "return while loading" guard is what this
  // pin replaces, so it also asserts that the guard is GONE.
  check('a remote load starts playback immediately (progressive), with an honest fallback',
    player.includes('try {') && player.includes('startPlay(0);')
    && player.includes('this format is not progressive: playback starts when the transfer completes')
    && !player.includes('if (phase == "loading") return;'));
  // The growth of bytesLoaded/length is the visible proof of progressive decode; it is
  // refreshed from the frame loop, not only on COMPLETE.
  check('the info block is refreshed while the transfer runs, not only at COMPLETE',
    player.includes('snd.bytesTotal > 0 && snd.bytesLoaded < snd.bytesTotal') && player.includes('refreshInfo();'));
  // These four are the filesystem half the example now carries. `new File(relative)`
  // is #2004 (AIR parity, docs/zh-cn/filesystem.md §11.5), so the default relative
  // path has to be resolved through File.workingDirectory first -- pinning that keeps
  // a future edit from re-introducing a constructor call that throws at startup.
  check('the default relative path is resolved through File.workingDirectory',
    player.includes('File.workingDirectory.resolvePath('));
  check('FileStream reads the file and the bytes go straight to the decoder',
    player.includes('loadCompressedDataFromByteArray') && player.includes('fs.readBytes(ba, 0, 0)')
    && player.includes('FileMode.READ'));
  check('a real RIFF/WAVE file is written through FileStream',
    player.includes('writeUTFBytes("RIFF")') && player.includes('writeUTFBytes("WAVE")')
    && player.includes('FileMode.WRITE') && player.includes('fs.writeBytes(out, 0, out.length)'));

  // ---------------------------------------------------------------------
  // 3. The build manifest: that the audio backend is actually compiled in.
  // ---------------------------------------------------------------------
  const sources = Array.isArray(manifest['sources']) ? (manifest['sources'] as string[]) : [];
  const defines = Array.isArray(manifest['defines']) ? (manifest['defines'] as string[]) : [];
  check('the manifest compiles vendor/audio_glue.c into the build',
    sources.some((s) => s.endsWith('vendor/audio_glue.c')));
  check('the manifest defines ASC_HAVE_AUDIO (else the seam degrades to no-backend)',
    defines.includes('ASC_HAVE_AUDIO=1'));
  // Without the HTTP backend an http(s) URL is an honest ioError ("network URLs are not
  // supported in this build") -- correct behaviour, but it makes the URL row useless.
  const linkLibs = Array.isArray(manifest['link-libs']) ? (manifest['link-libs'] as string[]) : [];
  check('the manifest links the HTTP backend the URL row needs',
    defines.includes('ASC_HAVE_CURL=1') && linkLibs.includes('curl'));
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
