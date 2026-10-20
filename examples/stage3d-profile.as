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
//      satisfy all seven rungs; we implement only the baseline feature set, so we
//      report "baseline" for every request (see Stage3D_requestContext3D in emit.ts).
//      Starling reads the value back rather than trusting what it asked for, so it
//      stays on its tier-A path -- which is why this is honest rather than broken.
import flash.display.Stage;
import flash.display.Stage3D;
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
check(s3d.context3D.profile == "baseline", "profile reports the context we really have");
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

if (failures != 0) throw new Error("stage3d-profile: " + failures + " of " + checks + " assertion(s) failed");
trace("stage3d-profile: " + checks + " assertions passed");