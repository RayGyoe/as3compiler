// flash.media.Microphone capture + SampleDataEvent (B1b, stage 425, plan B1).
//
// adl 51.4.1 measured (temp/micprobe/MicCapture.as): setLoopBack(true) starts
// capture and delivers SampleDataEvent.SAMPLE_DATA events whose `data` is a
// ByteArray of 2048 big-endian float32 mono samples (data.length == 8192), whose
// `position` advances by 2048 per event (0, 2048, 4096, ...), and whose samples
// lie in [-1, 1]. activityLevel is -1 before capture and 0..100 while capturing;
// setLoopBack(false) stops capture and resets activityLevel to -1. setSilenceLevel
// and setUseEchoSuppression are real setters (the latter is a hint -- shared-mode
// WASAPI echo cancellation is a system effect).
//
// The Windows backend captures the device mix format (this host: 48 kHz stereo
// float32 -- shared mode rejects a custom rate), downmixes to mono and linearly
// resamples to Microphone.rate kHz on a worker thread; the AS3 events are built at
// the frame boundary (as_mic_dispatch), never on the worker. The assertions hold
// on ANY host: a machine with no microphone reports isSupported=false and
// setLoopBack is a reported no-op, so CI without audio hardware still passes. The
// capture-specific checks are guarded by isSupported and a bounded pump loop.
import flash.media.Microphone;
import flash.events.SampleDataEvent;
import flash.utils.ByteArray;
import flash.utils.getTimer;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var mic:Microphone = Microphone.getMicrophone();
var evCount:int = 0;
var sawLen:Boolean = true;
var sawPos:Boolean = true;
var sawRange:Boolean = true;
var sawAct:Boolean = true;

function onSample(e:SampleDataEvent):void {
  evCount++;
  var ba:ByteArray = e.data;
  if (ba.length != 8192) sawLen = false;
  if (e.position != (evCount - 1) * 2048) sawPos = false;
  var act:Number = mic.activityLevel;
  if (act < 0 || act > 100) sawAct = false;
  ba.position = 0;
  var n:int = ba.length / 4;
  for (var i:int = 0; i < n; i++) {
    var s:Number = ba.readFloat();
    if (s < -1 || s > 1) sawRange = false;
  }
}

if (!Microphone.isSupported) {
  // No capture device: lookup is null and setLoopBack must not crash.
  check(mic == null, "getMicrophone() == null when unsupported");
  trace("microphone-capture ok (no device)");
} else {
  check(mic != null, "getMicrophone() non-null when supported");
  mic.rate = 44;
  mic.setSilenceLevel(0, 1000);
  mic.setUseEchoSuppression(true);
  check(mic.rate == 44, "rate is writable");
  check(mic.activityLevel == -1, "activityLevel -1 before capture");

  mic.addEventListener(SampleDataEvent.SAMPLE_DATA, onSample);
  mic.setLoopBack(true);

  // Pump the frame boundary until a few events arrive (or a bounded deadline).
  // The capture worker runs in real time; tickFrame() drains its queued buffers
  // into SampleDataEvents on this thread.
  var start:Number = getTimer();
  while (evCount < 3 && getTimer() - start < 3000) { tickFrame(); }
  mic.setLoopBack(false);

  check(evCount >= 1, "at least one SAMPLE_DATA event arrived");
  check(sawLen, "every event data.length == 8192 (2048 float32 samples)");
  check(sawPos, "event position advances by 2048 (0, 2048, 4096, ...)");
  check(sawRange, "every sample lies in [-1, 1]");
  check(sawAct, "activityLevel is 0..100 during capture");
  check(mic.activityLevel == -1, "activityLevel resets to -1 after setLoopBack(false)");
  trace("microphone-capture ok (" + evCount + " events)");
}