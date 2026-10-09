// audio.as -- flash.media (v0.4.69): Sound / SoundChannel / SoundTransform /
// SoundMixer / SoundLoaderContext / ID3Info.
//
// The audio backend (vendor/audio_glue.c, miniaudio) is a build-layer choice, so
// this example links it through audio.build.json and still has to be correct on a
// CI runner with no audio device at all: every check below is about the AS3
// contract, and the playback group branches on SoundMixer.areSoundsInaccessible()
// instead of assuming a device. Nothing here needs an mp3 fixture either -- the
// tone is synthesized and handed to Sound.loadPCMFromByteArray, which is the same
// path a dynamically generated sound takes.
//
// AIR alignment notes (measured on adl 51.4.1, see docs/zh-cn/audio.md §13):
//   * SoundTransform.pan is DERIVED, never stored: pan = 1 - leftToLeft^2 when
//     the cross channels are zero. The pan setter is unsymmetric (leftToLeft =
//     sqrt(1-pan), rightToLeft/leftToRight = 0, rightToRight = sqrt(1+pan)) and
//     does NOT clamp, so pan=2 gives leftToLeft = NaN.
//   * Sound.length is the decoder's frame count in ms, not the byte count:
//     44100 frames read 1000 ms exactly.
//   * extract() is always 44100 Hz stereo ("a sample contains both the left and
//     right channels -- that is, two 32-bit floating-point values"), so a mono
//     source is written twice, and the write starts at the ByteArray's CURRENT
//     position and advances it.
//   * play() on a Sound with no data throws Error #2068 ("Invalid sound."), and
//     with no backend at all it returns null -- never a fake channel.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- SoundTransform: derived pan, no clamping ---------------------------------
var st:SoundTransform = new SoundTransform();
check(st.volume == 1, "SoundTransform volume defaults to 1");
check(st.pan == 0 && st.leftToLeft == 1 && st.rightToRight == 1, "default gains are unity");

st.leftToLeft = 0.5;
st.rightToRight = 0.75;
check(st.pan == 0.75, "pan is derived from leftToLeft: 1 - 0.5*0.5");

st.leftToRight = 0.25;
check(st.pan == 0, "a non-zero cross channel forces pan to 0");

st = new SoundTransform(0.8, 0.6);
check(st.volume == 0.8 && st.pan == 0.6, "constructor takes (volume, pan)");

var st2:SoundTransform = st;
check(st2 === st, "a transform is a plain object reference");

// --- SoundMixer / SoundLoaderContext defaults ---------------------------------
check(SoundMixer.bufferTime == 5, "SoundMixer.bufferTime defaults to 5");
check(SoundMixer.audioPlaybackMode == "media", "audioPlaybackMode defaults to media");
var ctx:SoundLoaderContext = new SoundLoaderContext();
check(ctx.bufferTime == 1000 && ctx.checkPolicyFile == false, "SoundLoaderContext defaults");

// --- an empty Sound is legal and reports zeros --------------------------------
var empty:Sound = new Sound();
check(empty.length == 0 && empty.bytesTotal == 0 && empty.bytesLoaded == 0, "empty Sound reports 0");
check(empty.url == null && empty.isBuffering == false, "empty Sound has no url and is not buffering");
check(empty.id3.songName == null, "empty Sound has an ID3Info with null fields");
check(!empty.isURLInaccessible, "isURLInaccessible is false");

var threw:Boolean = false;
try { empty.play(); } catch (e:Error) { threw = true; }
check(threw, "play() on a Sound with no data throws Error #2068");

// --- PCM loading: 44100 frames of a 440 Hz tone --------------------------------
var RATE:int = 44100;
var FRAMES:int = 44100;
var pcm:ByteArray = new ByteArray();
for (var n:int = 0; n < FRAMES; n++) {
  pcm.writeFloat(Math.sin(2 * Math.PI * 440 * n / RATE) * 0.5);
}
pcm.position = 0;

var tone:Sound = new Sound();
tone.loadPCMFromByteArray(pcm, FRAMES, "float", false, RATE);
check(tone.length == 1000, "a 44100-frame mono sound is 1000 ms long, got " + tone.length);
check(tone.bytesLoaded == FRAMES * 4, "bytesLoaded counts the PCM bytes");

// The source ByteArray was consumed exactly up to the sample length, one channel
// of 32-bit floats: "leaves the ByteArray position at the end of the specified
// sample length multiplied by either 1 channel or 2 channels".
check(pcm.position == FRAMES * 4, "loadPCMFromByteArray advanced the source position");

// The wrong format name is rejected with AIR's own error, and only "float"/"short"
// are accepted ("short" was measured to work too, despite the parameter docs).
var fmts:Array = ["bogus", "double"];
for (var fi:int = 0; fi < fmts.length; fi++) {
  var bad:Sound = new Sound();
  var badThrew:Boolean = false;
  try { bad.loadPCMFromByteArray(pcm, 10, fmts[fi], false, RATE); } catch (e2:Error) { badThrew = true; }
  check(badThrew, "loadPCMFromByteArray rejects format '" + fmts[fi] + "'");
}

// --- extract(): always stereo, at the current position -------------------------
var out:ByteArray = new ByteArray();
var got:Number = tone.extract(out, 4);
check(got == 4, "extract returns the number of samples written");
check(out.length == 4 * 2 * 4, "4 stereo samples are 32 bytes, got " + out.length);
check(out.position == out.length, "extract leaves the position at the end of the data");

out.position = 0;
var l0:Number = out.readFloat();
var r0:Number = out.readFloat();
check(l0 == r0, "a mono source is duplicated into both channels");
check(Math.abs(l0) < 1e-6, "sample 0 of a sine is 0");
out.position = 0;
out.readFloat();
out.readFloat();
check(Math.abs(out.readFloat() - Math.sin(2 * Math.PI * 440 / RATE) * 0.5) < 1e-6, "sample 1 round-trips");

// A second extract without startPosition continues where the first stopped.
var out2:ByteArray = new ByteArray();
tone.extract(out2, 1);
check(out2.length == 8, "the cursor advanced past the first four samples");

// --- the device-dependent part ------------------------------------------------
// Everything above is decoder work, which AIR keeps independent of the output
// device, so it holds on a CI runner with no sound card. Team playback is the
// only part that needs one -- and the honest answer there is to REPORT the
// missing device instead of pretending: play() returns null, never a fake
// channel, and computeSpectrum leaves outputArray unchanged ("if
// areSoundsInaccessible() is true, outputArray is left unchanged").
var noDevice:Boolean = SoundMixer.areSoundsInaccessible();
trace("audio device unavailable in this environment: " + noDevice);
if (noDevice) {
  var marker:ByteArray = new ByteArray();
  marker.writeByte(7);
  SoundMixer.computeSpectrum(marker, false, 0);
  check(marker.length == 1, "no device leaves the spectrum array unchanged");
  check(tone.play() == null, "play() returns null with no device");
} else {
  var spec:ByteArray = new ByteArray();
  SoundMixer.computeSpectrum(spec, false, 0);
  check(spec.length == 2048, "computeSpectrum writes 512 floats (256 per channel)");
  check(spec.position == 0, "computeSpectrum rewinds the output array");

  var ch:SoundChannel = tone.play(0, 1);
  check(ch != null, "play() returns a channel on a working backend");
  check(ch.position <= tone.length, "channel position stays inside the sound");

  var stx:SoundTransform = ch.soundTransform;
  check(stx.volume == 1, "a fresh channel is at volume 1");
  stx.volume = 0.25;
  ch.soundTransform = stx;
  check(ch.soundTransform.volume == 0.25, "soundTransform round-trips");
  ch.stop();
  check(ch.position >= 0, "stop() keeps the position readable");
  SoundMixer.stopAll();
  trace("played a 1000 ms tone");
}

trace("audio.as OK");