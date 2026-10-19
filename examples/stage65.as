// stage65.as — flash.system.Capabilities (v0.3.68): environment capability query.
//
// Capabilities is a `final` static read-only class (same pattern as System): no
// instantiable class, each getter maps to a compile-time constant, a conditional-
// compile helper, or a fixed desktop-native value. `version` is a fixed AIR-compatible
// "<platform-prefix> 50,0,0,0" (the AS-AOT marker lives in `manufacturer`). screen size
// is 0 in headless builds (no SDL2 window backend) and the real display otherwise.
// `os` is a family name, plus a version on the platforms where AIR's own table has been
// reproduced (Windows today): apps read the version back out of the string.
// Deferred (platform/backend dependent): languages, serverString, hasMP3/hasTLS/
// hasVideoEncoder, maxLevelIDC, hasAccessibility/hasIME, and hasMultiChannelAudio.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- version: fixed AIR-compatible "<platform-prefix> 50,0,0,0" (AS-AOT marker is `manufacturer`) ---
var v:String = Capabilities.version;
check(v != null && v.length > 0, "version is non-empty");
check(v.charAt(3) == " ", "version has platform prefix + space at index 3: " + v);
check(v.indexOf(",") > 0, "version has comma-separated fields: " + v);
check(parseInt(v.substr(4).split(",").shift()) >= 19, "version major >= 19: " + v);

// --- os: family name, plus a version where AIR's table is reproduced (Windows) ---
var os:String = Capabilities.os;
check(os != null && os.length > 0, "os non-empty");
// AIR reports "family + version" ("Windows 11", "Windows Server 2012 R2"), and apps do
// rely on the version being there: Capabilities.os.split(" ")[1] feeds a device-info
// field, and the whole string is hashed into a device fingerprint. A bare family name is
// therefore a behavioural regression, not a cosmetic one. Windows is the platform whose
// table is recovered from AIR (see src/runtime.ts's as_win_os_name); macOS/Linux/WASI
// still report the bare family name, so the assertion is Windows-only.
if (os.indexOf("Windows") > -1) {
  check(os.indexOf("Windows ") == 0, "windows os starts with the family name: " + os);
  var osWords:Array = os.split(" ");
  check(osWords.length >= 2, "windows os splits into family + version: " + os);
  check(osWords[1] != null && osWords[1].length > 0, "windows os carries a version: " + os);
}
check(Capabilities.cpuArchitecture != null && Capabilities.cpuArchitecture.length > 0, "cpuArchitecture non-empty");

// --- cpuAddressSize + derived process-width flags ---
var addr:int = Capabilities.cpuAddressSize;
check(addr == 32 || addr == 64, "cpuAddressSize is 32 or 64");
check(Capabilities.supports64BitProcesses == (addr == 64), "supports64BitProcesses matches address size");
check(Capabilities.supports32BitProcesses == (addr == 32), "supports32BitProcesses matches address size");

// --- fixed desktop-native values ---
check(Capabilities.playerType == "Desktop", "playerType is Desktop");
check(Capabilities.manufacturer == "AS-AOT", "manufacturer is AS-AOT");
check(Capabilities.isDebugger == false, "isDebugger false (no debug runtime)");
check(Capabilities.touchscreenType == "none", "touchscreenType none on desktop");
check(Capabilities.screenColor == "color", "screenColor color");
check(Capabilities.pixelAspectRatio == 1.0, "pixelAspectRatio 1.0");
check(Capabilities.hasAudio == true, "hasAudio true");

// --- language: locale-derived ISO 639-1 ---
check(Capabilities.language != null && Capabilities.language.length > 0, "language non-empty");

// --- screen: 0 in headless builds, real display otherwise ---
check(Capabilities.screenResolutionX >= 0 && Capabilities.screenResolutionY >= 0, "screen resolution non-negative");
check(Capabilities.screenDPI > 0, "screenDPI positive (72 fallback)");

trace("stage65: all flash.system.Capabilities assertions passed (version " + v + ")");
