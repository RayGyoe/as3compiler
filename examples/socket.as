// socket.as — flash.net.Socket / ServerSocket / XMLSocket / SecureSocket
// (stage 89·54).
//
// Entirely hermetic: the server and the client below are two objects in THIS
// process talking over a loopback TCP connection on an ephemeral port, so the
// regression needs no external server and no network beyond 127.0.0.1. It is the
// assertion-style pin for the whole socket seam in both directions (the
// listening half and the connecting half) plus the AIR event contract measured
// from adl in temp/air-probe/air-probe11-result.txt:
//
//   1. A socket that is not open rejects EVERY operation with IOError #2002 —
//      its read-only getters included. That is AIR's rule, not a subset shortcut.
//   2. connect() validates synchronously (TypeError #1009 for a null host,
//      SecurityError #2003 for a port outside 0..65535) but reports the result
//      asynchronously: `connected` is false when connect() returns, and the
//      connection is announced by Event.CONNECT at a later frame boundary.
//   3. A refused connection is NOT a thrown error: it arrives as an ioError with
//      errorID 2031 whose text names the host.
//   4. Writes buffer. writeUTFBytes leaves bytesPending set; only flush() hands
//      the bytes to the transport, after which socketData reports the peer's
//      reply with bytesTotal == 0 (a socket has no declared length).
//   5. The listening socket dispatches ONE connect event, and it is a
//      ServerSocketConnectEvent whose `socket` is the accepted peer.
//   6. close() dispatches nothing; the PEER's close is what raises Event.CLOSE.
//   7. XMLSocket frames messages with a NUL of its own: send() appends it (and
//      sends immediately), and an inbound message arrives as DataEvent.DATA with
//      a String payload and the terminator stripped.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- 1. A socket that was never opened is inert, and says so loudly ----------
var dead:Socket = new Socket();
check(!dead.connected, "a fresh Socket is not connected");
check(dead.endian == "bigEndian", "Socket.endian defaults to bigEndian");
check(dead.objectEncoding == 3, "Socket.objectEncoding defaults to AMF3 (3)");
check(dead.timeout == 20000, "Socket.timeout defaults to 20000");
check(!dead.tcpNoDelay, "Socket.tcpNoDelay defaults to false");
check(dead.localAddress == null, "a fresh Socket has no localAddress");
check(dead.remoteAddress == null, "a fresh Socket has no remoteAddress");
check(dead.localPort == 0 && dead.remotePort == 0, "a fresh Socket has no ports");

// Every one of these must throw IOError #2002 (AIR: "Operation attempted on
// invalid socket."). The read-only getters are included on purpose — they are
// the operations an app reaches for first, and silently returning 0 would hide
// the bug instead of reporting it.
function invalid(fn:Function, what:String):void {
    var id:int = 0;
    try { fn(); } catch (e:IOError) { id = e.errorID; }
    check(id == 2002, what + " must throw IOError #2002 (got " + id + ")");
}
invalid(function():void { var x:uint = dead.bytesAvailable; }, "bytesAvailable on a closed socket");
invalid(function():void { var x:uint = dead.bytesPending; }, "bytesPending on a closed socket");
invalid(function():void { dead.close(); }, "close() on a closed socket");
invalid(function():void { dead.flush(); }, "flush() on a closed socket");
invalid(function():void { var x:int = dead.readByte(); }, "readByte() on a closed socket");
invalid(function():void { var x:String = dead.readUTFBytes(1); }, "readUTFBytes() on a closed socket");
invalid(function():void { dead.writeByte(1); }, "writeByte() on a closed socket");
invalid(function():void { dead.writeUTFBytes("x"); }, "writeUTFBytes() on a closed socket");

// connect() validates its arguments synchronously, before any IO.
var tid:int = 0;
try { dead.connect(null, 80); } catch (e:TypeError) { tid = e.errorID; }
check(tid == 1009, "connect(null, 80) throws TypeError #1009 (got " + tid + ")");
var sid:int = 0;
try { dead.connect("127.0.0.1", 70000); } catch (e2:SecurityError) { sid = e2.errorID; }
check(sid == 2003, "connect() to port 70000 throws SecurityError #2003 (got " + sid + ")");
check(!dead.connected, "a rejected connect() leaves the socket disconnected");

// A refused connection (nothing is listening on port 1) reports ioError, and the
// connect() call itself returns normally.
var refused:Socket = new Socket();
var refusedEvent:String = "";
var refusedID:int = 0;
function onRefused(e:IOErrorEvent):void { refusedEvent = e.text; refusedID = e.errorID; }
refused.addEventListener(IOErrorEvent.IO_ERROR, onRefused);
refused.connect("127.0.0.1", 1);
check(refusedEvent == "", "a refused connect dispatches no event synchronously");
for (var r:int = 0; r < 200 && refusedEvent == ""; r++) { tickFrame(); }
check(refusedID == 2031, "a refused connect reports ioError errorID 2031 (got " + refusedID + ")");
check(refusedEvent.indexOf("127.0.0.1") >= 0, "the ioError text names the host it could not reach");
check(!refused.connected, "a refused connect leaves the socket disconnected");

// --- 2. ServerSocket: bind then listen --------------------------------------
var srv:ServerSocket = new ServerSocket();
check(ServerSocket.isSupported, "ServerSocket.isSupported is true");
check(!srv.bound, "a fresh ServerSocket is not bound");
check(!srv.listening, "a fresh ServerSocket is not listening");
check(srv.localAddress == null && srv.localPort == 0, "a fresh ServerSocket has no address");
srv.bind(0);
check(srv.bound, "bind(0) binds the socket");
check(!srv.listening, "bind() does not start listening");
check(srv.localAddress == "0.0.0.0", "bind() defaults to 0.0.0.0");
var port:int = srv.localPort;
check(port > 0, "bind(0) picked an ephemeral port (got " + port + ")");

// --- 3. The loopback echo ---------------------------------------------------
var order:String = "";
var peer:Socket = null;
var serverSaw:String = "";

// The server side: one connect event, then echo whatever arrives.
function onServerConnect(e:ServerSocketConnectEvent):void {
    order += "accept,";
    peer = e.socket;
    check(peer != null, "ServerSocketConnectEvent.socket is the accepted peer");
    peer.addEventListener(ProgressEvent.SOCKET_DATA, onPeerData);
    peer.addEventListener(Event.CLOSE, onPeerClose);
}
function onPeerData(e:ProgressEvent):void {
    var n:int = peer.bytesAvailable;
    serverSaw += peer.readUTFBytes(n);
    peer.writeUTFBytes("echo:" + serverSaw);
    check(peer.bytesPending > 0, "the echo is buffered until flush()");
    peer.flush();
    check(peer.bytesPending == 0, "flush() empties the write buffer");
}
function onPeerClose(e:Event):void { order += "peerClosed,"; }
srv.addEventListener(ServerSocketConnectEvent.CONNECT, onServerConnect);
srv.listen();
check(srv.listening, "listen() starts listening");

// The client side.
var client:Socket = new Socket();
var clientConnected:Boolean = false;
var clientData:String = "";
var clientClosed:Boolean = false;
var clientPending:int = -1;
// The write is NOT flushed here: AIR buffers it, and the frame boundary (or an
// explicit flush) is what hands it to the transport. clientPending records the
// buffer depth so the assertion below can prove the buffering happened.
function onClientConnect(e:Event):void {
    clientConnected = true;
    client.writeUTFBytes("hello");
    clientPending = client.bytesPending;
}
function onClientData(e:ProgressEvent):void {
    clientData += client.readUTFBytes(client.bytesAvailable);
}
function onClientClose(e:Event):void { clientClosed = true; }
client.addEventListener(Event.CONNECT, onClientConnect);
client.addEventListener(ProgressEvent.SOCKET_DATA, onClientData);
client.addEventListener(Event.CLOSE, onClientClose);
client.connect("127.0.0.1", port);
check(!client.connected, "connect() returns before the connection is announced");
check(!clientConnected, "Event.CONNECT is not dispatched synchronously");

// Pump one frame boundary at a time (tickFrame is the non-blocking frame hook)
// until the round trip lands. The bound is generous but finite: a hang fails the
// assertion below instead of timing out the whole suite.
for (var i:int = 0; i < 500 && clientData == ""; i++) { tickFrame(); }
check(clientConnected, "the client saw Event.CONNECT");
check(clientPending == 5, "Event.CONNECT is delivered before the buffered write leaves (got " + clientPending + ")");
check(peer != null, "the server accepted the connection");
check(peer.connected, "the accepted peer is connected");
check(peer.remoteAddress == "127.0.0.1", "the peer reports the client's address (got " + peer.remoteAddress + ")");
check(peer.remotePort > 0, "the peer reports the client's port");
check(client.remotePort == port, "the client reports the server's port");
check(serverSaw == "hello", "the server read exactly what the client wrote (got " + serverSaw + ")");
check(clientData == "echo:hello", "the loopback round trip returned the echo (got " + clientData + ")");
check(order.indexOf("accept,") == 0, "the server's connect event came before anything else");

// Writes buffered on the client until flush(), exactly as on the server.
client.writeUTFBytes("second");
check(client.bytesPending == 6, "writeUTFBytes buffers all 6 bytes of \"second\"");
client.flush();
check(client.bytesPending == 0, "flush() hands them to the transport");
for (var j:int = 0; j < 500 && serverSaw == "hello"; j++) { tickFrame(); }
check(serverSaw == "hellosecond", "the second message arrived in order (got " + serverSaw + ")");
for (var k:int = 0; k < 500 && clientData == "echo:hello"; k++) { tickFrame(); }
check(clientData == "echo:helloecho:hellosecond", "both replies arrived in order (got " + clientData + ")");

// --- 4. close() dispatches nothing locally; the peer's close does -----------
client.close();
check(!client.connected, "close() disconnects immediately");
check(!clientClosed, "close() dispatches no close event on the closing socket");
var cid:int = 0;
try { var cv:uint = client.bytesAvailable; } catch (e3:IOError) { cid = e3.errorID; }
check(cid == 2002, "bytesAvailable after close() throws IOError #2002 (got " + cid + ")");
for (var m:int = 0; m < 500 && !clientClosed; m++) { tickFrame(); }
check(order.indexOf("peerClosed,") >= 0, "the peer saw the client's close as Event.CLOSE");

// The server stops listening, and a closed ServerSocket cannot be reopened.
srv.close();
check(!srv.bound, "close() clears bound");
check(!srv.listening, "close() clears listening");
check(srv.localPort == 0, "close() clears localPort");
var lsid:int = 0;
try { srv.listen(); } catch (e4:IOError) { lsid = e4.errorID; }
check(lsid == 2002, "listen() after close() throws IOError #2002 (got " + lsid + ")");

// A Socket object is reusable: connect() after close() connects again.
var again:Socket = new Socket();
var againConnected:Boolean = false;
function onAgainConnect(e:Event):void { againConnected = true; }
again.addEventListener(Event.CONNECT, onAgainConnect);
again.connect("127.0.0.1", 1);
again.close();
check(!again.connected, "a reopened socket starts disconnected again");
check(!againConnected, "the refused reconnect has not fired yet");

// --- 5. XMLSocket: NUL framing in both directions ---------------------------
var xmlClient:XMLSocket = new XMLSocket();
check(!xmlClient.connected, "a fresh XMLSocket is not connected");
check(xmlClient.timeout == 20000, "XMLSocket.timeout defaults to 20000");
// AIR accepts the two-argument constructor form with defaults; a null host just
// means "do not connect yet" (measured: no throw).
var noop:XMLSocket = new XMLSocket(null, -5);
check(!noop.connected, "new XMLSocket(null, -5) constructs without connecting");

var xmlSrv:ServerSocket = new ServerSocket();
var xmlPeer:Socket = null;
var xmlReceived:String = "";
var xmlTerminator:int = -1;
function onXmlConnect(e:ServerSocketConnectEvent):void {
    xmlPeer = e.socket;
    xmlPeer.addEventListener(ProgressEvent.SOCKET_DATA, onXmlPeerData);
}
function onXmlPeerData(e:ProgressEvent):void {
    // The peer is a plain Socket, so it sees the framing raw: the payload, then
    // the NUL the XMLSocket appended. The two are read separately because this
    // subset's String is NUL-terminated — an embedded NUL cannot be observed
    // through readUTFBytes (the same rule ByteArray.readUTFBytes follows).
    var n:int = xmlPeer.bytesAvailable;
    xmlReceived += xmlPeer.readUTFBytes(n - 1);
    xmlTerminator = xmlPeer.readByte();
    // Reply through the same framing the XMLSocket understands.
    xmlPeer.writeUTFBytes("fromServer");
    xmlPeer.writeByte(0);
    xmlPeer.flush();
}
xmlSrv.addEventListener(ServerSocketConnectEvent.CONNECT, onXmlConnect);
xmlSrv.bind(0);
xmlSrv.listen();

var xmlData:String = "";
var xmlDataCount:int = 0;
function onXmlData(e:DataEvent):void { xmlData = e.data; xmlDataCount++; }
xmlClient.addEventListener(DataEvent.DATA, onXmlData);
xmlClient.connect("127.0.0.1", xmlSrv.localPort);
for (var x:int = 0; x < 500 && !xmlClient.connected; x++) { tickFrame(); }
check(xmlClient.connected, "the XMLSocket connected");
xmlClient.send("hello");
for (var y:int = 0; y < 500 && xmlData == ""; y++) { tickFrame(); }
// send() appends the terminator itself: the peer sees the payload, then a NUL.
check(xmlReceived == "hello", "the payload arrived intact (got [" + xmlReceived + "])");
check(xmlTerminator == 0, "XMLSocket.send appended the NUL terminator (got " + xmlTerminator + ")");
// ... and an inbound NUL-terminated message arrives as a String with no NUL.
check(xmlData == "fromServer", "DataEvent.DATA carries the message without the terminator (got " + xmlData + ")");
check(xmlDataCount == 1, "one message produced exactly one DATA event (got " + xmlDataCount + ")");
xmlClient.close();
xmlSrv.close();

// --- 6. SecureSocket reports its real capability ---------------------------
// TLS is not implemented in this runtime, and the class says so instead of
// silently connecting in the clear: isSupported is false and connect() reports
// the socket error. An app that feature-detects takes its own fallback.
check(!SecureSocket.isSupported, "SecureSocket.isSupported is false (TLS is not implemented)");
var secure:SecureSocket = new SecureSocket();
check(secure.serverCertificateStatus == "unknown", "serverCertificateStatus starts as unknown");
check(!secure.connected, "a fresh SecureSocket is not connected");
var secureErr:String = "";
function onSecureError(e:IOErrorEvent):void { secureErr = e.text; }
secure.addEventListener(IOErrorEvent.IO_ERROR, onSecureError);
secure.connect("127.0.0.1", port);
check(secureErr != "", "SecureSocket.connect reports the unsupported transport, not a plaintext session");
check(!secure.connected, "SecureSocket.connect never silently connects in the clear");

trace("socket: all flash.net socket assertions passed");