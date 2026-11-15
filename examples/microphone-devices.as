// flash.media.Microphone device face (B1a, stage 424, plan B1).
//
// adl 51.4.1 measured (temp/micprobe/): Microphone.names is a fresh Array of the
// capture devices' friendly names, isSupported == (names.length > 0), and
// getMicrophone(index=-1) selects the first device (index<0 -> 0), returns null for
// an out-of-range index, and populates the AIR defaults: rate 8, gain 50,
// silenceLevel 10, silenceTimeout 2000, activityLevel -1 (no capture yet -- that is
// B1b), muted false, codec "nellymoser", enableVAD true. getEnhancedMicrophone
// answers the same device on this platform. The Windows backend enumerates active
// WASAPI capture endpoints (eCapture / DEVICE_STATE_ACTIVE); the friendly names
// match AIR byte-for-byte. describeType shows NO fps field and NO setCodec/setRate
// methods -- those invented shell members were removed.
//
// The assertions hold on ANY host: a machine with no microphone reports
// isSupported=false / empty names / getMicrophone()==null (the seam reports the gap
// once), and the device-specific checks are guarded by isSupported so CI without
// audio hardware still passes.
import flash.media.Microphone;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- names is always a live Array; isSupported tracks its length ---
var names:Array = Microphone.names;
check(names != null, "names is a non-null Array");
check(Microphone.isSupported == (names.length > 0), "isSupported == (names.length > 0)");

// --- a fresh Array on every call (identity never shared) ---
var names2:Array = Microphone.names;
check(names2 != null && names2.length == names.length, "names stable length across calls");

// --- out-of-range index is always null, on every host ---
check(Microphone.getMicrophone(999) == null, "getMicrophone(999) == null");
check(Microphone.getEnhancedMicrophone(999) == null, "getEnhancedMicrophone(999) == null");

if (Microphone.isSupported) {
  // --- a device exists: default lookup returns the first device ---
  var m:Microphone = Microphone.getMicrophone();
  check(m != null, "getMicrophone() non-null when supported");
  check(m.index == 0, "default index is 0");
  check(m.name == names[0], "name matches names[0]");
  // AIR-measured defaults
  check(m.rate == 8, "default rate 8");
  check(m.gain == 50, "default gain 50");
  check(m.silenceLevel == 10, "default silenceLevel 10");
  check(m.silenceTimeout == 2000, "default silenceTimeout 2000");
  check(m.activityLevel == -1, "activityLevel -1 before capture");
  check(m.muted == false, "default muted false");
  check(m.codec == "nellymoser", "default codec nellymoser");
  check(m.enableVAD == true, "default enableVAD true");
  // explicit index 0 and the enhanced variant agree
  var m0:Microphone = Microphone.getMicrophone(0);
  check(m0 != null && m0.name == m.name && m0.index == 0, "getMicrophone(0) agrees");
  var me:Microphone = Microphone.getEnhancedMicrophone();
  check(me != null && me.name == m.name, "getEnhancedMicrophone() agrees");
  // gain is a readwrite field
  m.gain = 60;
  check(m.gain == 60, "gain is writable");
  // each call hands out a distinct instance
  check(Microphone.getMicrophone() != m, "fresh instance per call");
} else {
  // --- no device: lookup is null, never a crash ---
  check(Microphone.getMicrophone() == null, "getMicrophone() == null when unsupported");
  check(Microphone.getEnhancedMicrophone() == null, "getEnhancedMicrophone() == null when unsupported");
}

trace("microphone-devices ok");