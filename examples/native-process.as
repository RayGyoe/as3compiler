// flash.desktop.NativeProcess: launching a child process and talking to it.
//
// This is the surface a desktop client uses for "run this helper and read what it
// says" (a converter, a version probe, an updater). The backend behind it is
// src/native-process.ts; every assertion below is one measured adl 51.4.1 contract
// (temp/npa/air/NP.as, NP2.as), and the whole example holds on ANY host -- the
// child is cmd.exe on Windows and /bin/sh everywhere else, so the same events,
// ordering and error ids are exercised either way.
//
// The contracts pinned here:
//   * isSupported is true on a desktop runtime, and the three pipes exist (empty)
//     from CONSTRUCTION, not from start();
//   * `start(null)` throws TypeError #1009 while an info with no executable throws
//     ArgumentError #3214 ("does not specify a valid executable file") -- the same
//     #3214 the executable SETTER throws for a file that does not exist, and
//     ArgumentError #3215 is the workingDirectory twin;
//   * `closeInput()` and `exit()` before start are silent no-ops (a launcher can
//     call them in a teardown path without knowing whether start() happened);
//   * `running` reads true on the line after start() and false once the exit event
//     was delivered;
//   * data events carry bytesLoaded = the bytes that arrived and bytesTotal = 0 (a
//     pipe announces no length), the handler drains the pipe with
//     readUTFBytes(bytesAvailable), and the EXIT event comes after the data;
//   * the child's exit code is carried by NativeProcessExitEvent.exitCode;
//   * writing to standardInput and then closeInput() delivers the bytes and EOF;
//   * a second start() while the child runs throws Error #3213;
//   * exit(true) stops a long-running child, and the SAME object can start again.
import flash.desktop.NativeProcess;
import flash.desktop.NativeProcessStartupInfo;
import flash.events.NativeProcessExitEvent;
import flash.events.ProgressEvent;
import flash.filesystem.File;
import flash.system.Capabilities;
import flash.utils.getTimer;
import flash.utils.tickFrame;

var isWindows:Boolean = Capabilities.os.indexOf("Windows") == 0;
var shellPath:String = isWindows ? "C:\\Windows\\System32\\cmd.exe" : "/bin/sh";
// Windows: one argument holding the whole command, because AIR joins the argument
// vector verbatim (temp/npa/air/Q.as). POSIX: the argv the shell expects.
var shellFlag:String = isWindows ? "/c" : "-c";

function fail(what:String):void { throw new Error("native-process: " + what); }
function check(ok:Boolean, what:String):void { if (!ok) fail(what); }

var passed:int = 0;
function ok(what:String):void { passed++; }

// Drives the frame pump until `done()` is true or the budget runs out. Headless
// builds have no frame loop of their own, so tickFrame() IS the boundary -- the
// same hook the socket and async-IO examples use.
function pump(done:Function, ms:int):void {
  var t0:int = getTimer();
  var n:int = 0;
  while (!done() && n < 500000 && getTimer() - t0 < ms) { tickFrame(); n++; }
}

function argsOf(list:Array):Vector.<String> {
  var v:Vector.<String> = new Vector.<String>();
  for (var i:int = 0; i < list.length; i++) v.push(list[i]);
  return v;
}

// --- 1. the class and a fresh object ----------------------------------------
check(NativeProcess.isSupported, "isSupported is true on a desktop runtime (" + Capabilities.os + ")");
ok("isSupported");

var np:NativeProcess = new NativeProcess();
check(!np.running, "a fresh NativeProcess is not running");
ok("fresh running");
// Measured: the pipes are live objects BEFORE start(), so a recipe that reads
// bytesAvailable ahead of time does not crash.
check(np.standardOutput != null && np.standardOutput.bytesAvailable == 0, "standardOutput is an empty pipe before start");
check(np.standardError != null && np.standardError.bytesAvailable == 0, "standardError is an empty pipe before start");
check(np.standardInput != null, "standardInput exists before start");
ok("fresh pipes");

// Teardown paths are safe to run unconditionally.
np.closeInput();
np.exit();
check(!np.running, "closeInput/exit before start are silent no-ops");
ok("no-op teardown");

// --- 2. start() validation --------------------------------------------------
function threw(fn:Function):Error {
  try { fn(); } catch (e:Error) { return e; }
  return null;
}
var e1:Error = threw(function():void { np.start(null); });
check(e1 != null && e1.errorID == 1009, "start(null) throws #1009 (got " + (e1 == null ? "no throw" : e1.errorID) + ")");
check(e1 is TypeError, "start(null) is a TypeError");
ok("start(null)");

var e2:Error = threw(function():void { np.start(new NativeProcessStartupInfo()); });
check(e2 != null && e2.errorID == 3214, "start() without an executable throws #3214");
check(e2 is ArgumentError && e2.message.indexOf("does not specify a valid executable file") >= 0,
      "the #3214 message names the executable (" + (e2 == null ? "" : e2.message) + ")");
ok("start(no exe)");

// --- 3. the startup descriptor ---------------------------------------------
var si:NativeProcessStartupInfo = new NativeProcessStartupInfo();
check(si.executable == null && si.workingDirectory == null, "executable/workingDirectory start null");
check(si.arguments != null && si.arguments.length == 0, "arguments starts as an empty Vector");
ok("descriptor defaults");

var e3:Error = threw(function():void { si.executable = new File("C:/definitely/not/here.exe"); });
check(e3 != null && e3.errorID == 3214, "a missing executable throws #3214 from the SETTER");
ok("executable setter");

var e4:Error = threw(function():void { si.workingDirectory = new File("C:/definitely/not/here"); });
check(e4 != null && e4.errorID == 3215, "a missing workingDirectory throws #3215 from the SETTER");
check(e4.message.indexOf("does not specify a valid directory") >= 0, "the #3215 message names the directory");
ok("workingDirectory setter");

// --- 4. a real child: stdout, stderr, exit code, event order ---------------
si = new NativeProcessStartupInfo();
si.executable = new File(shellPath);
si.arguments = argsOf(isWindows
  ? [shellFlag, "echo out-line & echo err-line 1>&2 & exit 7"]
  : [shellFlag, "echo out-line; echo err-line 1>&2; exit 7"]);
var order:String = "";
var outText:String = "";
var errText:String = "";
var outLoaded:int = -1;
var outTotal:int = -1;
var exitCode:int = -1;
np.addEventListener(ProgressEvent.STANDARD_OUTPUT_DATA, function(e:ProgressEvent):void {
  order += "out";
  outLoaded = e.bytesLoaded;
  outTotal = e.bytesTotal;
  outText += np.standardOutput.readUTFBytes(np.standardOutput.bytesAvailable);
});
np.addEventListener(ProgressEvent.STANDARD_ERROR_DATA, function(e:ProgressEvent):void {
  order += "err";
  errText += np.standardError.readUTFBytes(np.standardError.bytesAvailable);
});
np.addEventListener(NativeProcessExitEvent.EXIT, function(e:NativeProcessExitEvent):void {
  order += "exit";
  exitCode = e.exitCode;
});
np.start(si);
// Measured: running is already true on the line after start().
check(np.running, "running is true immediately after start()");
ok("running after start");

pump(function():Boolean { return order.indexOf("exit") >= 0; }, 8000);
check(np.running == false, "running is false once the exit event was delivered");
check(exitCode == 7, "the child's exit code is carried by exitCode (got " + exitCode + ")");
check(outText.indexOf("out-line") >= 0, "stdout reaches standardOutput (got [" + outText + "])");
check(errText.indexOf("err-line") >= 0, "stderr reaches standardError (got [" + errText + "])");
// A pipe announces no length: bytesLoaded is the payload, bytesTotal is 0.
check(outLoaded > 0 && outTotal == 0, "the data event reports bytesLoaded>0 / bytesTotal=0 (got " + outLoaded + "/" + outTotal + ")");
// Data first, exit last -- the order a launcher that accumulates output relies on.
check(order.lastIndexOf("exit") == order.length - 4, "the exit event is delivered after the data (" + order + ")");
check(order.indexOf("out") >= 0, "stdout was delivered as a data event");
ok("child round trip");

// --- 5. standardInput: write, then closeInput() sends EOF ------------------
// `more`/`cat` echo what they read until EOF, so the assertion proves the bytes
// AND the close both crossed the boundary.
var np2:NativeProcess = new NativeProcess();
var si2:NativeProcessStartupInfo = new NativeProcessStartupInfo();
si2.executable = new File(shellPath);
si2.arguments = argsOf([shellFlag, isWindows ? "more" : "cat"]);
var echoed:String = "";
var exited2:Boolean = false;
np2.addEventListener(ProgressEvent.STANDARD_OUTPUT_DATA, function(e:ProgressEvent):void {
  echoed += np2.standardOutput.readUTFBytes(np2.standardOutput.bytesAvailable);
});
np2.addEventListener(NativeProcessExitEvent.EXIT, function(e:NativeProcessExitEvent):void { exited2 = true; });
np2.start(si2);
np2.standardInput.writeUTFBytes("fed-through-stdin\n");
pump(function():Boolean { return echoed.indexOf("fed-through-stdin") >= 0; }, 8000);
check(echoed.indexOf("fed-through-stdin") >= 0, "the child receives what was written to standardInput (got [" + echoed + "])");
np2.closeInput();
pump(function():Boolean { return exited2; }, 8000);
check(exited2, "closeInput() delivers EOF, so the child exits");
ok("standardInput");

// --- 6. start() twice, then force-stop -------------------------------------
var np3:NativeProcess = new NativeProcess();
var si3:NativeProcessStartupInfo = new NativeProcessStartupInfo();
si3.executable = new File(shellPath);
si3.arguments = argsOf([shellFlag, isWindows ? "ping -n 20 127.0.0.1 > nul" : "sleep 5"]);
var killed:Boolean = false;
var killedCode:int = -2;
np3.addEventListener(NativeProcessExitEvent.EXIT, function(e:NativeProcessExitEvent):void {
  killedCode = e.exitCode;
  killed = true;
});
np3.start(si3);
check(np3.running, "the long-running child started");
// Measured: the guard is against the state, so it fires while THIS child runs.
var e5:Error = threw(function():void { np3.start(si3); });
check(e5 != null && e5.errorID == 3213, "start() on a running process throws #3213 (got " + (e5 == null ? "no throw" : e5.errorID) + ")");
check(e5.message.indexOf("already running") >= 0, "the #3213 message says the process is already running");
ok("start twice");

np3.exit(true);
// Measured: `running` stays true on the line after exit(true) -- the exit event is
// what clears it, exactly like a child that ended on its own.
check(np3.running, "exit(true) does not clear running synchronously");
pump(function():Boolean { return killed; }, 8000);
check(killed, "a forced child still delivers the exit event");
check(!np3.running, "running is false after the forced exit");
// The exit CODE of a killed child is platform-specific (AIR itself reports NaN on
// Windows), so only its presence is asserted here.
check(killedCode != -2, "the forced exit reports an exit code (" + killedCode + ")");
ok("force stop");

// --- 7. the same object can start again after an exit ----------------------
var code2:int = -1;
np3.addEventListener(NativeProcessExitEvent.EXIT, function(e:NativeProcessExitEvent):void { code2 = e.exitCode; });
var si4:NativeProcessStartupInfo = new NativeProcessStartupInfo();
si4.executable = new File(shellPath);
si4.arguments = argsOf([shellFlag, "exit 300"]);
np3.start(si4);
pump(function():Boolean { return code2 >= 0; }, 8000);
// Windows keeps the full 32-bit status; a POSIX wait status carries only the low
// eight bits, so the same `exit 300` is observed as 44 there. Both are what the
// host reports to a child-process API (AIR included), so the expectation follows
// the host rather than pinning one number.
var want2:int = isWindows ? 300 : 44;
check(code2 == want2, "a restarted process reports its own exit code (got " + code2 + ", wanted " + want2 + ")");
ok("restart");

// --- 8. workingDirectory is where the child runs ---------------------------
var np4:NativeProcess = new NativeProcess();
var si5:NativeProcessStartupInfo = new NativeProcessStartupInfo();
si5.executable = new File(shellPath);
// The directory has to EXIST (that is #3215), and it must be absolute: a relative
// one would resolve against the launcher and prove nothing.
var wd:File = isWindows ? new File("C:\\Windows") : new File("/");
si5.workingDirectory = wd;
si5.arguments = argsOf([shellFlag, isWindows ? "cd" : "pwd"]);
var cwdText:String = "";
np4.addEventListener(ProgressEvent.STANDARD_OUTPUT_DATA, function(e:ProgressEvent):void {
  cwdText += np4.standardOutput.readUTFBytes(np4.standardOutput.bytesAvailable);
});
np4.start(si5);
pump(function():Boolean { return cwdText.indexOf("\n") >= 0; }, 8000);
check(cwdText.replace("\r", "").replace("\n", "").toLowerCase() == wd.nativePath.toLowerCase().replace("\\", "\\"),
      "the child runs in workingDirectory (got [" + cwdText + "], wanted [" + wd.nativePath + "])");
ok("workingDirectory");

trace("native-process: " + passed + " group(s) of NativeProcess assertions passed");