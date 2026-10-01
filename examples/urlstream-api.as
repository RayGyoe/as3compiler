// urlstream-api.as — phase F/H of docs/zh-cn/flash-net.md: `URLStream` and the
// package-level navigateToURL/sendToURL, on the DEFAULT build (no HTTP backend, no
// launcher side effects).
//
// Everything asserted here was MEASURED against the reference implementation
// (mxmlc + adl, temp/air-probe, see flash-net.md §6.7). AIR's URLStream state
// machine is not what the one-line API docs suggest:
//
//   * bytesAvailable / read* / close() on a stream that was never opened throw
//     Error #2029 ("This URLStream object does not have a stream opened.") —
//     bytesAvailable does NOT return 0;
//   * a FAILED load leaves the stream "opened but empty": connected stays true,
//     bytesAvailable is 0 and reads report EOFError #2030 — only close() makes
//     it throw #2029 again;
//   * `connected` therefore means "has a stream", not "has a live transfer";
//   * load(null) and load(new URLRequest(null)) are distinct TypeErrors #2007;
//   * navigateToURL(null) / sendToURL(null) likewise throw TypeError #2007
//     instead of launching anything (a REAL url would fork a browser, which a
//     headless regression must not do).
//
// The live streaming behaviour (incremental bytesAvailable, the read* methods over
// real bytes, per-chunk PROGRESS) is verified by temp/netprobe3.as against a live
// server; see flash-net.md §6.3.
import flash.net.URLStream;
import flash.net.URLRequest;
import flash.events.Event;
import flash.events.IOErrorEvent;
import flash.events.ProgressEvent;
import flash.utils.ByteArray;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function errId(e:Error):int { return e.errorID; }

// --- the surface and its defaults -------------------------------------------
var s:URLStream = new URLStream();
check(s.endian == "bigEndian", "URLStream.endian defaults to bigEndian (AIR)");
check(s.objectEncoding == 3, "URLStream.objectEncoding defaults to AMF3 (AIR)");
check(!s.connected, "a fresh URLStream is not connected");

// --- no stream at all: #2029 everywhere (not a silent 0 / no-op) ------------
var saw2029:int = 0;
try { s.bytesAvailable; } catch (e:Error) { if (errId(e) == 2029) saw2029++; }
try { s.readByte(); } catch (e:Error) { if (errId(e) == 2029) saw2029++; }
try { s.close(); } catch (e:Error) { if (errId(e) == 2029) saw2029++; }
check(saw2029 == 3, "bytesAvailable/readByte/close on a never-opened stream all throw #2029 (got " + saw2029 + ")");

// --- parameter validation: the two #2007 shapes AIR distinguishes ----------
var paramLog:String = "";
try { s.load(null); } catch (e:Error) { paramLog += e.errorID + ":" + e.message + "|"; }
try { s.load(new URLRequest(null)); } catch (e:Error) { paramLog += e.errorID + ":" + e.message + "|"; }
check(paramLog.indexOf("2007:Error #2007: Parameter request must be non-null.") >= 0, "load(null) is a #2007 parameter error (got [" + paramLog + "])");
check(paramLog.indexOf("2007:Error #2007: Parameter url must be non-null.") >= 0, "load(URLRequest(null)) is a #2007 url error (got [" + paramLog + "])");

// --- a non-http transport is refused loudly, never read as empty ----------
var badLog:String = "";
var badText:String = "";
function onBadError(e:IOErrorEvent):void { badLog = "ioError"; badText = e.text; }
function onBadComplete(e:Event):void { badLog = "complete"; }
s.addEventListener(IOErrorEvent.IO_ERROR, onBadError);
s.addEventListener(Event.COMPLETE, onBadComplete);
s.load(new URLRequest("ftp://example.com/file.bin"));
tickTimers();
check(badLog == "ioError", "a non-http transport must report ioError, not complete");
check(badText.indexOf("not supported") >= 0, "the refusal names the unsupported transport (got [" + badText + "])");

// A failed load is NOT a closed stream in AIR: it stays opened-but-empty until
// close() is called. (This is the subtle one — it is why an ioError handler may
// still call close() and why reads report #2030 rather than #2029.)
check(s.connected, "after a failed load the stream still counts as connected (AIR)");
check(s.bytesAvailable == 0, "a failed stream exposes zero bytes (not an exception)");
var eofId:int = 0;
try { s.readByte(); } catch (e:Error) { eofId = e.errorID; }
check(eofId == 2030, "reading a failed-but-open stream reports EOFError #2030 (got " + eofId + ")");
var closedOk:Boolean = true;
try { s.close(); } catch (e:Error) { closedOk = false; }
check(closedOk, "close() on a failed-but-open stream succeeds (AIR)");
check(!s.connected, "after close() the stream is disconnected");
saw2029 = 0;
try { s.bytesAvailable; } catch (e:Error) { if (errId(e) == 2029) saw2029++; }
check(saw2029 == 1, "after close() bytesAvailable throws #2029 again");

// --- http(s):// on a build without a backend: the phase G contract --------
var netLog:String = "";
var netText:String = "";
function onNetError(e:IOErrorEvent):void { netLog = "ioError"; netText = e.text; }

var s2:URLStream = new URLStream();
s2.addEventListener(IOErrorEvent.IO_ERROR, onNetError);
s2.addEventListener(Event.COMPLETE, onBadComplete);
s2.load(new URLRequest("http://127.0.0.1:9/never"));
tickTimers();
check(netLog == "ioError", "http:// without a backend reports ioError");
check(netText.indexOf("network") >= 0 || netText.indexOf("not supported") >= 0,
      "the ioError text names the missing backend (got [" + netText + "])");
check(s2.connected, "the failed stream is still opened-but-empty (AIR)");

// --- navigateToURL / sendToURL parameter validation -----------------------
var navId:int = 0;
var navMsg:String = "";
try { navigateToURL(null, "_blank"); } catch (e:Error) { navId = e.errorID; navMsg = e.message; }
check(navId == 2007 && navMsg.indexOf("Parameter request must be non-null") >= 0,
      "navigateToURL(null) throws the AIR #2007 request error (got " + navId + " [" + navMsg + "])");

var navId2:int = 0;
try { navigateToURL(new URLRequest(null), "_blank"); } catch (e:Error) { navId2 = e.errorID; }
check(navId2 == 2007, "navigateToURL(URLRequest(null)) throws #2007 too (got " + navId2 + ")");

var sendId:int = 0;
try { sendToURL(null); } catch (e:Error) { sendId = e.errorID; }
check(sendId == 2007, "sendToURL(null) throws #2007 instead of launching (got " + sendId + ")");

trace("urlstream-api: URLStream + navigateToURL/sendToURL surface assertions passed");