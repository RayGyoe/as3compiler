// stage65.as — flash.system.Capabilities (v0.3.68): environment capability query.
//
// Capabilities is a `final` static read-only class (same pattern as System): no
// instantiable class, each getter maps to a compile-time constant, a conditional-
// compile helper, or a fixed desktop-native value. `version` is the AS-AOT version
// injected at codegen time from package.json (single source of truth). screen size
// is 0 in headless builds (no SDL2 window backend) and the real display otherwise.
// Deferred (platform/backend dependent): languages, serverString, hasMP3/hasTLS/
// hasVideoEncoder, maxLevelIDC, hasAccessibility/hasIME, and hasMultiChannelAudio.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- version: compile-time injected from package.json, prefixed with "AS-AOT " ---
var v:String = Capabilities.version;
check(v != null && v.length > 0, "version is non-empty");
check(v.indexOf("AS-AOT ") == 0, "version starts with AS-AOT prefix: " + v);
check(v.indexOf(".") > 0, "version looks like a semver: " + v);

// --- os / cpuArchitecture: conditional-compile constants ---
check(Capabilities.os != null && Capabilities.os.length > 0, "os non-empty");
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
