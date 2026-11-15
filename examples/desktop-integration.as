// desktop-integration.as — File.openWithDefaultApplication + NativeApplication.systemIdleMode
// (stage 422, plan E1+E2). Measured on adl 51.4.1 (temp/desktopprobe/).
//
// E1 openWithDefaultApplication: an empty File (no path) raises #1009 (NOT the usual
// #2037 that other path-needing members raise), a missing path raises #3003, and an
// existing file/directory is handed to the OS default handler. The success path
// actually launches an app, so it is verified on the real machine rather than here;
// this example pins the error contract that does not launch anything.
//
// E2 systemIdleMode: default "normal", get/set round-trips, null raises #2007
// ("Parameter idleMode must be non-null."), any other invalid value raises #2008
// ("Parameter systemIdleMode must be one of the accepted values."). KEEP_AWAKE drives
// the real idle-timer backend (SetThreadExecutionState on Windows, IOPMAssertion on
// macOS); the inhibition itself is observed via the power API on the real machine.
import flash.filesystem.File;
import flash.desktop.NativeApplication;
import flash.desktop.SystemIdleMode;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var app:NativeApplication = NativeApplication.nativeApplication;

// --- E2: default + round-trip ---
check(app.systemIdleMode == SystemIdleMode.NORMAL, "E2 default is normal");
app.systemIdleMode = SystemIdleMode.KEEP_AWAKE;
check(app.systemIdleMode == SystemIdleMode.KEEP_AWAKE, "E2 keepAwake round-trip");
app.systemIdleMode = SystemIdleMode.NORMAL;
check(app.systemIdleMode == SystemIdleMode.NORMAL, "E2 normal round-trip");

// --- E2: invalid value -> #2008 ---
var threw2008:Boolean = false;
try { app.systemIdleMode = "bogus"; } catch (e8:Error) { threw2008 = (e8.errorID == 2008); }
check(threw2008, "E2 invalid value raises #2008");
check(app.systemIdleMode == SystemIdleMode.NORMAL, "E2 mode unchanged after rejected write");

// --- E2: null -> #2007 ---
var threw2007:Boolean = false;
try { app.systemIdleMode = null; } catch (e7:Error) { threw2007 = (e7.errorID == 2007); }
check(threw2007, "E2 null raises #2007");

// --- E1: missing path -> #3003 (no launch) ---
var missing:File = File.applicationStorageDirectory.resolvePath("no-such-file-xyz.txt");
var threw3003:Boolean = false;
try { missing.openWithDefaultApplication(); } catch (e3:Error) { threw3003 = (e3.errorID == 3003); }
check(threw3003, "E1 missing path raises #3003");

// --- E1: empty File -> #1009 (the openWith-specific code, not #2037) ---
var threw1009:Boolean = false;
try { new File().openWithDefaultApplication(); } catch (e9:Error) { threw1009 = (e9.errorID == 1009); }
check(threw1009, "E1 empty File raises #1009");

app.systemIdleMode = SystemIdleMode.NORMAL;
trace("desktop-integration ok");