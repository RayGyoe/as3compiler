// stage3d-profile.as — Stage3D.requestContext3D's two-argument form and the seven
// Context3DProfile values.
//
// Measured against adl 51.4.1 (temp/adlprof/: 7 legal profiles + 4 negative cases,
// rebuilt on a descriptor whose <renderMode> is inside <initialWindow> — a top-level
// <renderMode> is not in the schema and silently disables Stage3D, which is what the
// "Error #2044 / #3702 Context3D not available" report actually was):
//
//   1. Both parameters are validated SYNCHRONOUSLY. A bad value throws
//      ArgumentError #2008; there is no async ErrorEvent path for a bad argument.
//   2. renderMode is checked BEFORE profile: requestContext3D("direct","nonsense")
//      reports the renderMode error, not the profile one.
//   3. renderMode accepts only "auto" and "software". The descriptor's own
//      vocabulary (gpu/cpu/direct) is NOT legal here, and the comparison is
//      case-sensitive ("AUTO" throws).
//   4. profile accepts the seven Context3DProfile strings, including "enhanced"
//      (the rung Starling's ladder starts from). "auto" is not one of them.
//   5. AIR echoes the requested profile back from context3D.profile because it can
//      satisfy all seven rungs. We report the highest rung THIS build can honour:
//      "baselineExtended" when the backend grants 4096x4096 textures, "baseline"
//      when it tops out at 2048. Starling reads the value back rather than trusting
//      what it asked for, so the report — not the request — decides its texture set.
import flash.display.Stage;
import flash.display.Stage3D;
import flash.display3D.Context3D;
import flash.display3D.Context3DProfile;

// The pass count is printed too: a case that silently never runs would otherwise look
// like a pass (the failure lines are the only output).
var failures:int = 0;
var checks:int = 0;
function check(cond:Boolean, msg:String):void {
  checks++;
  if (!cond) { failures++; trace("FAIL: " + msg); }
}

// `new Stage()` is the standalone Stage of this subset (examples/listener_identity.as
// does the same); its stage3Ds vector is created lazily on first read.
var st:Stage = new Stage();
var s3d:Stage3D = st.stage3Ds[0];
check(st.stage3Ds.length == 1, "stage3Ds has one slot");

// Every constant exists and carries AIR's string value.
check(Context3DProfile.BASELINE == "baseline", "BASELINE");
check(Context3DProfile.BASELINE_CONSTRAINED == "baselineConstrained", "BASELINE_CONSTRAINED");
check(Context3DProfile.BASELINE_EXTENDED == "baselineExtended", "BASELINE_EXTENDED");
check(Context3DProfile.ENHANCED == "enhanced", "ENHANCED");
check(Context3DProfile.STANDARD == "standard", "STANDARD");
check(Context3DProfile.STANDARD_CONSTRAINED == "standardConstrained", "STANDARD_CONSTRAINED");
check(Context3DProfile.STANDARD_EXTENDED == "standardExtended", "STANDARD_EXTENDED");

// The two-argument form is an AIR-legal call: it must compile, and it must not throw
// for any of the seven profiles.
var profiles:Array = [
  Context3DProfile.ENHANCED, Context3DProfile.STANDARD_EXTENDED,
  Context3DProfile.STANDARD, Context3DProfile.STANDARD_CONSTRAINED,
  Context3DProfile.BASELINE_EXTENDED, Context3DProfile.BASELINE,
  Context3DProfile.BASELINE_CONSTRAINED,
];
for (var i:int = 0; i < profiles.length; i++) {
  s3d.requestContext3D("auto", profiles[i]);
  check(s3d.context3D != null, "context3D exists after requesting " + profiles[i]);
}
check(s3d.context3D.profile == "baselineExtended", "profile reports the rung this build honours");
// Requesting a higher rung must NOT raise the report: the value describes the
// context that exists, not the one that was asked for.
s3d.requestContext3D("auto", Context3DProfile.ENHANCED);
check(s3d.context3D.profile == "baselineExtended", "profile never echoes a rung we cannot honour");
check(s3d.renderMode == "auto", "renderMode is stored");

// Illegal values throw #2008 synchronously. The message text is AIR's, verbatim.
try {
  s3d.requestContext3D("auto", "auto");
  check(false, "illegal profile must throw");
} catch (e:Error) {
  check(e.errorID == 2008, "illegal profile error id is 2008, got " + e.errorID);
  check(e.message == "Error #2008: Parameter profile must be one of the accepted values.",
        "illegal profile message: " + e.message);
}

try {
  s3d.requestContext3D("direct", "nonsense");
  check(false, "illegal renderMode must throw");
} catch (e2:Error) {
  check(e2.errorID == 2008, "illegal renderMode error id is 2008");
  // renderMode is validated FIRST, so this is the renderMode message even though the
  // profile is garbage too.
  check(e2.message == "Error #2008: Parameter renderMode must be one of the accepted values.",
        "illegal renderMode message: " + e2.message);
}

try {
  s3d.requestContext3D("AUTO", Context3DProfile.BASELINE);
  check(false, "renderMode comparison must be case-sensitive");
} catch (e3:Error) {
  check(e3.errorID == 2008, "case-sensitive renderMode is rejected");
}

// "software" is legal; we render with the compiled backend either way, but the call
// must not be rejected (AIR-legal input).
s3d.requestContext3D("software", Context3DProfile.BASELINE_EXTENDED);
check(s3d.renderMode == "software", "software mode accepted and stored");

// The one-argument form keeps working, with profile defaulting to "baseline".
var st2:Stage = new Stage();
var s3d2:Stage3D = st2.stage3Ds[0];
s3d2.requestContext3D();
check(s3d2.context3D != null, "single-argument form still creates a context");
check(s3d2.renderMode == "auto", "renderMode defaults to auto");

// ---- texture-size validation (adl 51.4.1, temp/adlprof/ edge mode) ----
// The check ORDER is observable: zero -> power-of-two -> ceiling. A 4097 request is
// rejected as "not a power of two" (not "too big"), and 0/-1 as "size is zero".
// Every code below is an ArgumentError, not an Error.
var c:Context3D = s3d.context3D;

function expectArgError(fn:Function, id:int, msg:String):void {
  try {
    fn();
    check(false, "expected #" + id + " " + msg);
  } catch (e:Error) {
    check(e.errorID == id, "#" + id + " errorID, got " + e.errorID + " for " + msg);
    check(e.message == msg, "#" + id + " message: got [" + e.message + "]");
  }
}

check(c.createTexture(4096, 4096, "bgra", false) != null, "4096 texture is legal at this rung");
check(c.createTexture(2048, 1, "bgra", false) != null, "2048 texture is legal");
check(c.createTexture(1024, 1024, "bgra", false) != null, "non-square-but-pow2 is legal");

expectArgError(function():void { c.createTexture(0, 1, "bgra", false); },
  3681, "Error #3681: Texture size is zero.");
expectArgError(function():void { c.createTexture(-1, 1, "bgra", false); },
  3681, "Error #3681: Texture size is zero.");
expectArgError(function():void { c.createTexture(2049, 1, "bgra", false); },
  3682, "Error #3682: Texture size not a power of two.");
expectArgError(function():void { c.createTexture(3000, 3000, "bgra", false); },
  3682, "Error #3682: Texture size not a power of two.");
expectArgError(function():void { c.createTexture(8192, 8192, "bgra", false); },
  3683, "Error #3683: Texture too big (max is 4096x4096).");

// Cube maps stay at 1024 on every profile (measured), and are checked for pow2 first.
check(c.createCubeTexture(1024, "bgra", false) != null, "1024 cube is legal");
expectArgError(function():void { c.createCubeTexture(0, "bgra", false); },
  3681, "Error #3681: Texture size is zero.");
expectArgError(function():void { c.createCubeTexture(2049, "bgra", false); },
  3682, "Error #3682: Texture size not a power of two.");
expectArgError(function():void { c.createCubeTexture(2048, "bgra", false); },
  3705, "Error #3705: Cubemap texture too big (max is 1024x1024).");

// RectangleTexture has no power-of-two rule: 4097 is "too big", not "not pow2".
check(c.createRectangleTexture(4096, 1, "bgra", false) != null, "4096x1 rectangle is legal");
expectArgError(function():void { c.createRectangleTexture(0, 1, "bgra", false); },
  3681, "Error #3681: Texture size is zero.");
expectArgError(function():void { c.createRectangleTexture(4097, 1, "bgra", false); },
  3766, "Error #3766: RectangleTexture too big (max is the larger of 4096x4096 or the size of the backbuffer).");

// ---- Context3D.ignoreResourceLimits (AIR 50.0+, default false) ----
// Measured on adl 51.4.1 (temp/adlprof/ ign mode). The flag does NOT switch validation
// off: zero-size and power-of-two keep throwing #3681/#3682, and the beyond-ceiling
// answer changes both TYPE and CODE — ArgumentError #3683/#3705/#3766 become
// Error #3684. That type change is the part apps can observe with
// `catch (e:ArgumentError)`, so it is what this example pins.
check(c.ignoreResourceLimits == false, "ignoreResourceLimits defaults to false");

try {
  c.createTexture(8192, 1, "bgra", false);
  check(false, "8192 must be rejected while limits are on");
} catch (e0:Error) {
  check(e0.errorID == 3683, "limits on: 8192 is #3683, got " + e0.errorID);
}

c.ignoreResourceLimits = true;
check(c.ignoreResourceLimits == true, "ignoreResourceLimits read-back");

// Argument validity is independent of the flag.
expectArgError(function():void { c.createTexture(0, 1, "bgra", false); },
  3681, "Error #3681: Texture size is zero.");
expectArgError(function():void { c.createTexture(2049, 1, "bgra", false); },
  3682, "Error #3682: Texture size not a power of two.");

// The ceiling itself is gone. Whether the DEVICE can honour 8192 decides between
// "object" and #3684 — both are correct, and neither may be #3683.
try {
  check(c.createTexture(8192, 1, "bgra", false) != null, "8192 accepted once limits are off");
} catch (e1:Error) {
  check(e1.errorID == 3684, "limits off: beyond the device max is #3684, got " + e1.errorID);
  check(e1.message == "Error #3684: Texture creation failed. Internal error.",
        "#3684 message: " + e1.message);
}

// Cube maps keep AIR's 1024 hard cap even with the flag, but the failure changes from
// ArgumentError #3705 to Error #3684 (measured: cube(2048) -> #3684 on every rung).
try {
  c.createCubeTexture(2048, "bgra", false);
  check(false, "2048 cube must still be rejected");
} catch (e2:Error) {
  check(e2.errorID == 3684, "limits off: 2048 cube is #3684, got " + e2.errorID);
  check(e2.message == "Error #3684: Texture creation failed. Internal error.",
        "#3684 message for cube: " + e2.message);
}

// RectangleTexture goes to the device maximum (AIR reaches 16384 there too).
try {
  check(c.createRectangleTexture(8192, 1, "bgra", false) != null, "8192x1 rectangle accepted");
} catch (e3:Error) {
  check(e3.errorID == 3684, "rect beyond device max is #3684, got " + e3.errorID);
}

// Flipping it back restores AIR's default answers.
c.ignoreResourceLimits = false;
check(c.ignoreResourceLimits == false, "ignoreResourceLimits turns back off");
expectArgError(function():void { c.createTexture(8192, 1, "bgra", false); },
  3683, "Error #3683: Texture too big (max is 4096x4096).");

// The flag never rewrites the profile: it widens what we will ACCEPT, it does not
// claim a higher AGAL feature set.
check(c.profile == "baselineExtended", "ignoreResourceLimits does not change profile");

if (failures != 0) throw new Error("stage3d-profile: " + failures + " of " + checks + " assertion(s) failed");
trace("stage3d-profile: " + checks + " assertions passed");