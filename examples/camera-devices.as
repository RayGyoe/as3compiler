// flash.media.Camera device face (B2, stage 426, plan B2).
//
// adl 51.4.1 measured (temp/camprobe/): Camera.names is a fresh Array of the video
// capture devices' friendly names, isSupported == (names.length > 0), and
// getCamera(name=null) selects the first device, matching by device name OR by
// index-as-string (getCamera("0") selects device 0); an out-of-range index or an
// unknown name returns null. The returned Camera's read-only name/index reflect the
// inventory. The Windows backend enumerates DirectShow video-capture devices
// (CLSID_VideoInputDeviceCategory); the friendly names match AIR byte-for-byte.
// Capture itself still goes through the app's ANE -- this stage is enumeration only.
//
// The assertions hold on ANY host: a machine with no camera reports
// isSupported=false / empty names / getCamera()==null (the seam reports the gap
// once), and the device-specific checks are guarded by isSupported so CI without
// camera hardware still passes.
import flash.media.Camera;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- names is always a live Array; isSupported tracks its length ---
var names:Array = Camera.names;
check(names != null, "names is a non-null Array");
check(Camera.isSupported == (names.length > 0), "isSupported == (names.length > 0)");

// --- a fresh Array on every call (identity never shared) ---
var names2:Array = Camera.names;
check(names2 != null && names2.length == names.length, "names stable length across calls");
check(names2 != names, "names is a fresh Array per call");

// --- out-of-range index / unknown name are always null, on every host ---
check(Camera.getCamera("999") == null, "getCamera('999') == null");
check(Camera.getCamera("no-such-camera-xyz") == null, "getCamera(bad name) == null");

if (Camera.isSupported) {
  // --- a device exists: default lookup returns the first device ---
  var c:Camera = Camera.getCamera();
  check(c != null, "getCamera() non-null when supported");
  check(c.index == 0, "default index is 0");
  check(c.name == names[0], "name matches names[0]");
  // explicit index-as-string 0 agrees with the default
  var c0:Camera = Camera.getCamera("0");
  check(c0 != null && c0.name == c.name && c0.index == 0, "getCamera('0') agrees");
  // lookup by the device's own friendly name agrees too
  var cn:Camera = Camera.getCamera(names[0]);
  check(cn != null && cn.name == names[0] && cn.index == 0, "getCamera(names[0]) agrees");
  // each call hands out a distinct instance
  check(Camera.getCamera() != c, "fresh instance per call");
} else {
  // --- no device: lookup is null, never a crash ---
  check(Camera.getCamera() == null, "getCamera() == null when unsupported");
  check(Camera.getCamera("0") == null, "getCamera('0') == null when unsupported");
}

trace("camera-devices ok");