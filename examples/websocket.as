// websocket.as — air.net.WebSocket (AIR 51): the RFC 6455 client, no ANE.
//
// The client is the vendored static libcurl (curl_ws_*): an app that speaks
// WebSocket needs no native extension, and on Windows/macOS the same archive and
// TLS stack that serves http(s):// serves ws(s)://.
//
// THIS example is the client-side CONTRACT, and it is hermetic: every assertion
// below needs no server, no network beyond a refused loopback connect, and no
// timing luck. The wire round trip (handshake, TEXT/BINARY echo, peer close code,
// fragment reassembly) needs a real server and is pinned in
// test/unit/websocket.ts, which starts one and drives this same seam.
//
// What it pins, in the order AIR's own behaviour was measured
// (temp/wsapi/out-adl*.txt, adl 51.4.1):
//
//   1. The synchronous surface: protocol/closeReason defaults and the fmt*
//      constants.
//   2. The four argument errors: #2007 (null url), #2147 (not ws:// or wss://),
//      #2007 (null socket).
//   3. A transport call made BEFORE connect() is a silent no-op — not an error.
//   4. A refused connection is an ASYNCHRONOUS ioError: nothing is thrown, the
//      error arrives after connect() returns, its id is #2031, and its text names
//      the host. CONNECT never fires for it.
//   5. Once a connection is gone (or was never made and failed), send and close
//      throw Error #2002 — the same "operation on an invalid socket" rule
//      flash.net.Socket follows.
//   6. Server mode is a NAMED gap, not a silent stall: startServer() reports
//      itself instead of pretending to accept.

import air.net.WebSocket;
import flash.events.Event;
import flash.events.IOErrorEvent;
import flash.net.Socket;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// Runs `fn` and answers the Error id it threw (0 when it threw nothing).
function errorIdOf(fn:Function):int {
    try { fn(); } catch (e:Error) { return e.errorID; }
    return 0;
}

// ---------------------------------------------------------------------------
// 1. The synchronous surface
// ---------------------------------------------------------------------------
var w:WebSocket = new WebSocket();
check(w.protocol == null, "a fresh WebSocket has a null protocol");
check(w.closeReason == -1, "a fresh WebSocket has closeReason -1 (got " + w.closeReason + ")");
check(WebSocket.fmtTEXT == 1, "fmtTEXT is 1");
check(WebSocket.fmtBINARY == 2, "fmtBINARY is 2");
check(WebSocket.fmtCLOSE == 8, "fmtCLOSE is 8");
check(WebSocket.fmtPING == 9, "fmtPING is 9");
check(WebSocket.fmtPONG == 10, "fmtPONG is 10");

check(errorIdOf(function():void { w.connect(null); }) == 2007, "connect(null) is TypeError #2007");
check(errorIdOf(function():void { w.connect("http://example.com/"); }) == 2147, "connect(http://…) is ArgumentError #2147");
check(errorIdOf(function():void { w.connect(""); }) == 2147, "connect(\"\") is ArgumentError #2147");
check(errorIdOf(function():void { w.startServer(null); }) == 2007, "startServer(null) is TypeError #2007");

// Before connect() the two transport calls are silently ignored (AIR), NOT errors.
check(errorIdOf(function():void { w.sendMessage(WebSocket.fmtTEXT, "x"); }) == 0, "sendMessage before connect() is a no-op");
check(errorIdOf(function():void { w.close(); }) == 0, "close() before connect() is a no-op");

// ---------------------------------------------------------------------------
// 2. A refused connection is an asynchronous ioError, never a throw
// ---------------------------------------------------------------------------
// Port 1 is never a WebSocket server, so this is a deterministic refusal. Every
// handshake failure (refused, not an HTTP upgrade, TLS refused) reaches the app
// the same way: ONE ioError at a frame boundary, with AIR's wording.
var dead:WebSocket = new WebSocket();
var deadIo:String = null;
var deadOpen:Boolean = false;
var deadClosed:Boolean = false;
function onDeadIo(e:IOErrorEvent):void { deadIo = e.text; }
function onDeadOpen(e:Event):void { deadOpen = true; }
function onDeadClose(e:Event):void { deadClosed = true; }
dead.addEventListener(IOErrorEvent.IO_ERROR, onDeadIo);
dead.addEventListener(Event.CONNECT, onDeadOpen);
dead.addEventListener(Event.CLOSE, onDeadClose);
dead.connect("ws://127.0.0.1:1/");
check(deadIo == null, "connect() does not throw when the connection fails");
check(!deadOpen, "CONNECT is not dispatched synchronously");

// tickTimers() is the headless pump: one call lets the transport thread make
// progress and drains what it produced, so the failure lands inside this loop
// instead of on a host-speed race. The transport thread is real, hence the bound.
for (var i:int = 0; i < 400 && deadIo == null; i++) tickTimers();
check(deadIo != null, "a refused connection raises ioError");
check(deadIo.indexOf("2031") >= 0, "the ioError carries #2031 (got " + deadIo + ")");
check(deadIo.indexOf("127.0.0.1") >= 0, "the ioError names the host (got " + deadIo + ")");
check(!deadOpen, "a refused connection never dispatches CONNECT");
// The terminal event of ANY connection is close: the app's teardown handler must
// run whether the connection opened or not (measured on adl for a refused port).
check(deadClosed, "a failed connection still dispatches Event.CLOSE");

// The connection is gone: the transport calls now throw AIR's #2002.
check(errorIdOf(function():void { dead.sendMessage(WebSocket.fmtTEXT, "x"); }) == 2002, "sendMessage after a failed connect is Error #2002");
check(errorIdOf(function():void { dead.close(); }) == 2002, "close() after a failed connect is Error #2002");

// ---------------------------------------------------------------------------
// 3. Server mode is a named gap
// ---------------------------------------------------------------------------
var modeW:WebSocket = new WebSocket();
var plain:Socket = new Socket();
check(errorIdOf(function():void { modeW.startServer(plain); }) == 2031, "startServer() reports the unimplemented server mode");

trace("websocket: all assertions passed");