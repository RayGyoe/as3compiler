// Unit checks: air.net.WebSocket (AIR 51) — the client contract AND the wire.
//
// Two groups:
//   websocket/            source-shape pins on the seam, the emitted class and the
//                         build wiring. These are the invariants a mutation breaks
//                         silently (a missing error sentence, the props table
//                         tracing the borrowed handle, a lost ASC_HAVE_CURL).
//   websocket-roundtrip/  a REAL server. examples/websocket.as deliberately pins
//                         only the client contract, because the fixture server there
//                         would have to be written with flash.net.ServerSocket — a
//                         POSIX-only seam in this compiler (docs/zh-cn/flash-net.md
//                         §4.5), so on Windows the example would skip the round trip
//                         in exactly the build that needs it most. Node's own
//                         http server is the honest fixture instead: real SHA-1
//                         accept token, real masking, real fragmentation, real
//                         close codes. This is the only unit group that spawns a
//                         server and a compiled program; both are local and
//                         hermetic (ephemeral port, 127.0.0.1).
//
// Re-run alone with:
//   node --test --test-name-pattern='websocket' test/unit/*.ts

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert';
import { Socket as NetSocket, type Socket } from 'node:net';
import { registerGroup, root, readNorm } from '../harness.ts';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';

const runAsync = promisify(execFile);

function checkWebSocketShape(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [websocket] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [websocket] ${label}`); }
  };

  const rt = readNorm(join(root, 'src', 'runtime.ts'));
  const emitSrc = readNorm(join(root, 'src', 'emit.ts'));
  const symSrc = readNorm(join(root, 'src', 'symbols.ts'));
  const indexSrc = readNorm(join(root, 'src', 'index.ts'));
  const airSrc = readNorm(join(root, 'src', 'air-app.ts'));

  // --- the seam: registry always, backend conditionally -------------------
  check('the registry is emitted for every target (AS_WS_FAILED exists)',
    rt.includes('#define AS_WS_FAILED     3'));
  check('the seam is the vendored curl transport (easy_send/easy_recv)',
    rt.includes('curl_easy_send(') && rt.includes('curl_easy_recv('));
  check('the backend half is gated on curl AND threads',
    /#if defined\(ASC_HTTP_BACKEND\) && defined\(ASC_ASYNC_THREADS\)/.test(rt));
  // Without the backend the build must FAIL LOUDLY at runtime: a silent no-op
  // would leave an app waiting forever for a connect that can never happen.
  check('a backend-less build still fails with AIR\'s #2031',
    rt.includes('"Error #2031: Socket Error."'));
  // One worker owns the handle end to end; the AS3 side must never block on the wire.
  // CONNECT_ONLY=1, never 2: curl's 2 does perform the upgrade, but it then feeds
  // every byte behind the 101 response to its OWN ws decoder, where the raw
  // curl_easy_recv path this runtime uses cannot reach them -- a frame a peer
  // pipelines behind its handshake was silently dropped (TODO 阶段四百三十九).
  check('the worker owns the transport (CONNECT_ONLY=1, upgrade is ours)',
    rt.includes('CURLOPT_CONNECT_ONLY, 1L') && rt.includes('curl_easy_perform(')
    && !/CURLOPT_CONNECT_ONLY,\s*2/.test(rt));
  // curl's ws_* frame layer cannot express the end of a fragmented message (and
  // its raw mode rejects the PONG it sends itself), so the framing is the
  // runtime's own -- and it must stay that way, or fragments split into events.
  check('the frame codec is the runtime\'s own (parse_frames + FIN handling)',
    rt.includes('as_ws_parse_frames(') && /int fin = \(p\[0\] & 0x80\) != 0;/.test(rt));
  check('a fragmented message is reassembled before it is published',
    rt.includes('as_ws_frag_append(') && /if \(fin\) \{[\s\S]{0,200}as_ws_push\(w, \*msg_op/.test(rt));
  // Masking follows the SIDE, not the call site: a client frame must be masked
  // and a server frame must not (RFC 6455 §5.1), so one codec serves both
  // directions and the flag comes from as_ws_wire.server.
  check('client frames are masked and server frames are not',
    rt.includes('as_ws_mask_key(') && rt.includes('int use_mask = !wr->server;')
    && /use_mask \? 0x80 : 0\) \| \(unsigned char\)len/.test(rt));
  check('a server PING is answered with a PONG by the transport',
    rt.includes('as_ws_send_frame(wr, 0xA,'));

  // --- the frame-boundary contract ---------------------------------------
  // Same shape as the socket pump: mark roots, drain in the tick, and keep the
  // loop alive while a connection is in flight.
  check('the WebSocket objects are permanent GC roots',
    /static void as_ws_mark_roots\(void\)/.test(rt) && /as_ws_mark_roots\(\);/.test(rt));
  check('root marking is wired into the GC root walk',
    /static void gc_mark_internal_roots\(void\)[\s\S]{0,6000}as_ws_mark_roots\(\);/.test(rt));
  check('as_async_tick_with drains WebSocket messages',
    /as_ws_dispatch\(\)/.test(rt) && /ws_events = as_ws_dispatch\(\);/.test(rt));
  check('the wait loop counts WebSocket work as in flight',
    /as_ws_in_flight\(\)/.test(rt));

  // --- the emitted AS3 class ---------------------------------------------
  // The class body is emitted as one raw C block (not through this.line()), so
  // these pins read emit.ts directly: each sentence below is AIR's own wording,
  // measured on adl, and an app matching it must keep working.
  for (const sentence of [
    'Error #2007: Parameter url must be non-null.',
    'Error #2007: Parameter socket must be non-null.',
    'Error #2147: Forbidden protocol in URL ',
    'Error #2082: Connect failed because the object is already connected.',
    'Error #2002: Operation attempted on invalid socket.',
  ]) {
    check(`the emitted class carries "${sentence}"`, emitSrc.includes(sentence));
  }
  check('measurement note: an unknown sendMessage format is silently dropped',
    /unknown format/i.test(emitSrc));
  // --- server mode (startServer) -----------------------------------------
  // AIR 51.4.1 measured: only a NULL socket throws; every other argument is
  // accepted in silence (never-connected, refused, already-serving). The gap that
  // used to be reported as #2031 is closed, so the old sentence must be gone.
  check('server mode is implemented (the old "not implemented" throw is gone)',
    !emitSrc.includes('WebSocket server mode is not implemented'));
  check('startServer() adopts the accepted descriptor instead of copying it',
    /air_net_WebSocket_startServer[\s\S]{0,2000}as_ws_start_server\(/.test(emitSrc)
    && rt.includes('as_sock_detach('));
  check('the server handshake is SHA-1 + base64 over the client key',
    rt.includes('as_ws_sha1(') && rt.includes('as_ws_b64(')
    && rt.includes('258EAFA5-E914-47DA-95CA-C5AB0DC85B11'));
  check('the server answers the measured 101 reply',
    rt.includes('"HTTP/1.1 101 Switching Protocols') &&
    rt.includes('"Upgrade: websocket') &&
    rt.includes('"Connection: Upgrade') &&
    rt.includes('"Sec-WebSocket-Accept: %s'));
  // No curl anywhere on the server path: the peer dialed us, so there is no
  // handshake to perform and no TLS layer to keep. A curl call here would mean the
  // seam had quietly gone back to the client code path.
  // The slice stops at the next function, because as_ws_client_handshake (which
  // legitimately talks to curl through as_ws_wire_*) is defined a few lines later.
  const hnStart = rt.indexOf('static int as_ws_server_handshake(');
  const hnEnd = Math.min(
    ...[rt.indexOf('static int as_ws_client_handshake(', hnStart),
        rt.indexOf('static void as_ws_worker_body(', hnStart)]
      .filter((i) => i > hnStart),
  );
  const serverFn = hnStart >= 0 && hnEnd > hnStart ? rt.slice(hnStart, hnEnd) : '';
  check('the server handshake path never calls libcurl',
    serverFn.length > 0 && !/curl_easy_\w+\s*\(/.test(serverFn));

  // --- the client upgrade (阶段四百三十九) --------------------------------
  // The response is validated here rather than by curl: status 101 plus
  // base64(sha1(key + GUID)) == Sec-WebSocket-Accept.
  check('the client handshake verifies the 101 and the accept token',
    rt.includes('static int as_ws_client_handshake(')
    && rt.includes('"Sec-WebSocket-Key: %s') && rt.includes('"Sec-WebSocket-Version: 13')
    && /as_ws_client_handshake[\s\S]{0,4000}as_ws_sha1\(/.test(rt)
    && /"Sec-WebSocket-Accept", got/.test(rt));
  // Bytes that arrived with the handshake are the BEGINNING of the frame stream,
  // so they seed the decoder and are parsed before the transport is read again --
  // reading first left them unparsed until some later arrival, which made a
  // welcome message look lost until the app sent something.
  check('post-handshake bytes seed the decoder on both sides',
    /as_ws_client_handshake\(&wr, w, &seed, &seed_len\)/.test(rt)
    && rt.includes('unsigned char* rx = seed;'));
  check('buffered stream bytes are parsed before the transport is read again',
    /static int as_ws_recv_pass\([\s\S]{0,900}if \(\*rx_len > 0\)/.test(rt));
  check('a never-connected Socket is accepted silently (no #2007/#2002)',
    emitSrc.includes('if (s == NULL) return;'));
  check('DATA position follows AIR per direction (server 0, client end)',
    emitSrc.includes('as_ws_is_server(w) ? 0 : m->len'));

  // --- borrowing, not owning ---------------------------------------------
  // `_ws` is a handle into the runtime registry, exactly like Socket._sock: the
  // props table must trace `_protocol` (a GC string) and leave `_ws` alone.
  const wsProp = /air_net_WebSocket[\s\S]{0,400}?offsetof\(air_net_WebSocket, _protocol\)/.exec(emitSrc);
  check('the props table traces _protocol', wsProp !== null);
  const propTable = wsProp === null ? '' : wsProp[0];
  check('the props table does NOT trace the borrowed _ws handle',
    !propTable.includes('_ws'));

  // --- the registry keys --------------------------------------------------
  // `air.*` is not `flash.*`, so the class key is the sanitized FQN; a short-name
  // key would have made `import air.net.WebSocket` resolve to nothing.
  check('air.net.WebSocket is keyed by its sanitized FQN',
    symSrc.includes("'air_net_WebSocket'") && symSrc.includes("fqn: 'air.net::WebSocket'"));
  check('WebSocketEvent lives in flash.events',
    symSrc.includes("fqn: 'flash.events::WebSocketEvent'"));

  // --- build wiring -------------------------------------------------------
  // A WebSocket-only program never names URLRequest, so the transport detection
  // has to know the class by name or the build links no curl at all.
  check('the CLI links the vendored curl for a WebSocket program',
    indexSrc.includes("t.includes('air.net.WebSocket')") && indexSrc.includes("cfg.linkLibs.push(l)"));
  check('the CLI refuses loudly when the vendored curl is missing',
    indexSrc.includes('is not in vendor/curl'));
  check('the --air-app path detects WebSocket as networking too',
    airSrc.includes("text.includes('air.net.WebSocket')"));
  // advapi32 is where CryptAcquireContext lives; crypt32 alone leaves curl's
  // schannel/sha256 objects unresolved (measured link failure).
  check('the Windows link line carries advapi32 for Schannel hashing',
    indexSrc.includes("'iphlpapi', 'advapi32'"));

  // --- the C the compiler really produces ---------------------------------
  const src = [
    'import air.net.WebSocket;',
    'import flash.events.WebSocketEvent;',
    'var w:WebSocket = new WebSocket();',
    'w.connect("ws://127.0.0.1:1/");',
    'w.sendMessage(WebSocket.fmtTEXT, "x");',
    'w.close(1000);',
    'trace(w.closeReason);',
    'trace(w.protocol);',
    'var e:WebSocketEvent = new WebSocketEvent(WebSocketEvent.DATA, WebSocket.fmtTEXT, null);',
    'trace(e.stringData);',
  ].join('\n');
  const c = generateC(parse(src)).c;
  for (const sym of [
    'air_net_WebSocket_new(', 'air_net_WebSocket_connect(',
    'air_net_WebSocket_sendMessage(', 'air_net_WebSocket_close(',
    'air_net_WebSocket_get_closeReason(', 'air_net_WebSocket_get_protocol(',
    'WebSocketEvent_new(',
  ]) {
    check(`generated C defines ${sym}`, c.includes(sym));
  }
  check('connect() hands the URL to the seam (as_ws_start)',
    /air_net_WebSocket_connect\(void\* _this, char\* url[\s\S]{0,2500}as_ws_start\(/.test(c));
  // The fmt* constants are static fields of the class, not literals inlined at
  // the call sites (an app reads WebSocket.fmtTEXT at run time).
  check('the fmt* constants are emitted as static fields',
    c.includes('air_net_WebSocket_fmtTEXT') && c.includes('air_net_WebSocket_fmtBINARY'));
  check('WebSocketEvent.DATA is the measured event name',
    c.includes('WebSocketEvent_DATA = "websocketData"'));

  console.log(`      [websocket] ${ok} checks passed`);
  return bad;
}

registerGroup('websocket/', checkWebSocketShape);

// ---------------------------------------------------------------------------
// websocket-roundtrip/: a real RFC 6455 server, a real compiled client.
// ---------------------------------------------------------------------------

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Frame encoder for the SERVER side of the wire (server frames are never masked).
function frame(opcode: number, payload: Buffer, fin = true): Buffer {
  const n = payload.length;
  const head = n < 126
    ? Buffer.from([(fin ? 0x80 : 0x00) | opcode, n])
    : Buffer.from([(fin ? 0x80 : 0x00) | opcode, 126, (n >> 8) & 0xff, n & 0xff]);
  return Buffer.concat([head, payload]);
}

interface Fixture {
  port: number;
  seen: { protocol: string | null; pong: boolean; text: string[]; binary: number; closed: number };
  close: () => Promise<void>;
}

/**
 * The server the client is graded against. It demands a correct accept token
 * (so a client that failed to send a real Sec-WebSocket-Key cannot pass), echoes
 * TEXT and BINARY, answers a client PING with PONG, and on the text "bye" sends a
 * FRAGMENTED message followed by a close frame carrying 4001.
 */
function startFixture(): Promise<Fixture> {
  const seen: Fixture['seen'] = { protocol: null, pong: false, text: [], binary: 0, closed: -1 };
  let server: Server | null = null;
  const sockets: Socket[] = [];

  const promise = new Promise<Fixture>((resolveList, rejectList) => {
    const srv = createServer((req, res) => {
      res.writeHead(404, { 'Content-Length': 0 }).end();
    });
    server = srv;
    srv.on('error', rejectList);
    srv.on('upgrade', (req: IncomingMessage, socket: Socket) => {
      sockets.push(socket);
      const key = req.headers['sec-websocket-key'];
      const proto = req.headers['sec-websocket-protocol'];
      seen.protocol = typeof proto === 'string' ? proto : null;
      if (typeof key !== 'string') { socket.destroy(); return; }
      const accept = createHash('sha1').update(key + GUID).digest('base64');
      // The upgrade response, a welcome TEXT and a PING go out in ONE write, so they
      // share a TCP segment: everything after the 101 is pipelined behind the
      // handshake. That is the shape that matters -- a real server greets a new
      // client this way all the time, and it is exactly what a client with
      // curl's CONNECT_ONLY=2 silently drops (curl hands the bytes behind the 101
      // to its OWN ws decoder, out of reach of curl_easy_recv). Writing these as
      // separate socket.write() calls passed even with that bug, because the
      // kernel usually delivered them after the client's handshake read: the old
      // flake WAS this race (see TODO 阶段四百三十九).
      // RFC 6455 §5.5.3 also makes answering the PING the endpoint's duty, and
      // curl does not do it for the application.
      socket.write(Buffer.concat([
        Buffer.from(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n` +
          (seen.protocol !== null ? `Sec-WebSocket-Protocol: ${seen.protocol.split(',')[0].trim()}\r\n` : '') +
          '\r\n'
        ),
        frame(0x1, Buffer.from('hello-first')),
        frame(0x9, Buffer.from('pp')),
      ]));

      let buf = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          const opcode = buf[0] & 0x0f;
          const masked = (buf[1] & 0x80) !== 0;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          }
          const need = off + (masked ? 4 : 0) + len;
          if (buf.length < need) return;
          let payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need));
          if (masked) {
            const mask = buf.subarray(off, off + 4);
            for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
          }
          buf = buf.subarray(need);

          if (opcode === 0x8) {
            seen.closed = len >= 2 ? payload.readUInt16BE(0) : -1;
            socket.write(frame(0x8, Buffer.alloc(0)));
            socket.end();
            return;
          }
          if (opcode === 0xa) { seen.pong = true; continue; }
          if (opcode === 0x9) { socket.write(frame(0xa, payload)); continue; }
          if (opcode === 0x1) {
            const text = payload.toString('utf8');
            seen.text.push(text);
            if (text === 'bye') {
              // Fragmented delivery: a TEXT frame with FIN=0 plus a CONT with FIN=1.
              // The client must hand the app ONE message.
              socket.write(frame(0x1, Buffer.from('frag-a'), false));
              socket.write(frame(0x0, Buffer.from('+frag-b'), true));
              socket.write(frame(0x8, Buffer.from([0x0f, 0xa1])));
              continue;
            }
            socket.write(frame(0x1, payload));
            continue;
          }
          if (opcode === 0x2) { seen.binary++; socket.write(frame(0x2, payload)); }
        }
      });
      socket.on('error', () => { /* the client's close is expected */ });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') { rejectList(new Error('no port')); return; }
      resolveList({
        port: addr.port,
        seen,
        close: async () => {
          for (const s of sockets) s.destroy();
          await new Promise<void>((r) => { srv.close(() => r()); });
          void server;
        },
      });
    });
  });
  return promise;
}

function cCompiler(): string | null {
  for (const c of ['clang', 'cc', 'gcc']) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return c; } catch { /* next */ }
  }
  return null;
}

test('websocket-roundtrip/ a real server: handshake, TEXT, BINARY, fragments, close code', async (t) => {
  const cc = cCompiler();
  if (cc === null) {
    t.skip('no C compiler on PATH');
    return;
  }
  const fixture = await startFixture();
  const dir = mkdtempSync(join(tmpdir(), 'as-ws-'));
  try {
    // The client program. Every assertion prints a line the driver matches, so a
    // failure names itself in the report instead of "the program exited 1".
    const src = `
import air.net.WebSocket;
import flash.events.Event;
import flash.events.IOErrorEvent;
import flash.events.WebSocketEvent;
import flash.utils.ByteArray;

var ws:WebSocket = new WebSocket();
var opened:Boolean = false;
var gotText:String = null;
var gotBin:String = null;
var gotFirst:String = null;
var gotFrag:String = null;
var ioText:String = null;
var closeSeen:Boolean = false;
var closeCode:int = -999;
var dataIsBytes:Boolean = false;
var binHasString:Boolean = false;

function onOpen(e:Event):void { opened = true; }
function onData(e:WebSocketEvent):void {
    dataIsBytes = (e.data is ByteArray);
    if (e.format == WebSocket.fmtTEXT) {
        var s:String = e.stringData;
        if (s == "hello-first") gotFirst = s;
        else if (s == "hello-ws") gotText = s;
        else if (s == "frag-a+frag-b") gotFrag = s;
        else trace("UNEXPECTED-TEXT " + s);
    } else {
        if (e.stringData != null) binHasString = true;
        e.data.position = 0;
        gotBin = e.data.readUTFBytes(e.data.length);
    }
}
function onClose(e:Event):void { closeSeen = true; closeCode = ws.closeReason; }
function onIoError(e:IOErrorEvent):void { ioText = e.text; }

ws.addEventListener(Event.CONNECT, onOpen);
ws.addEventListener(WebSocketEvent.DATA, onData);
ws.addEventListener(Event.CLOSE, onClose);
ws.addEventListener(IOErrorEvent.IO_ERROR, onIoError);
ws.protocol = "chat.v1";
var protos:Vector.<String> = new Vector.<String>();
protos.push("chat.v1");
protos.push("chat.v2");
ws.connect("ws://127.0.0.1:${fixture.port}/ws", protos);

for (var a:int = 0; a < 500 && !opened && ioText == null; a++) tickTimers();
if (!opened) { trace("FAIL-OPEN " + (ioText == null ? "timeout" : ioText)); }
if (opened) trace("OK-OPEN");
// The welcome message the server pipelined behind its 101 response. It has to be
// delivered like any other frame: bytes that arrive together with the handshake
// are still the beginning of the WebSocket stream. The wait is time-based, not
// tick-based: once the connection is OPEN the worker no longer counts as "in
// flight", so tickTimers() does not block and a fixed tick budget can expire
// before the worker has unloaded the buffered frame.
var tFirst:int = getTimer();
while (opened && gotFirst == null && ioText == null && getTimer() - tFirst < 5000) tickTimers();
trace(gotFirst == "hello-first" ? "OK-FIRST" : "FAIL-FIRST " + gotFirst);

ws.sendMessage(WebSocket.fmtTEXT, "hello-ws");
for (var b:int = 0; b < 500 && gotText == null && ioText == null; b++) tickTimers();
trace(gotText == "hello-ws" ? "OK-TEXT" : "FAIL-TEXT " + gotText);

var bytes:ByteArray = new ByteArray();
bytes.writeUTFBytes("bin-7");
ws.sendMessage(WebSocket.fmtBINARY, bytes);
for (var c:int = 0; c < 500 && gotBin == null && ioText == null; c++) tickTimers();
trace(gotBin == "bin-7" ? "OK-BINARY" : "FAIL-BINARY " + gotBin);

ws.sendMessage(WebSocket.fmtTEXT, "bye");
for (var d:int = 0; d < 500 && gotFrag == null && ioText == null; d++) tickTimers();
trace(gotFrag == "frag-a+frag-b" ? "OK-FRAGMENT" : "FAIL-FRAGMENT " + gotFrag);
for (var e2:int = 0; e2 < 500 && !closeSeen; e2++) tickTimers();
trace(closeSeen ? "OK-CLOSE" : "FAIL-CLOSE-none");
trace(closeCode == 4001 ? "OK-CODE" : "FAIL-CODE " + closeCode);
trace(dataIsBytes ? "OK-BYTES" : "FAIL-BYTES");
trace(!binHasString ? "OK-STRINGDATA-NULL" : "FAIL-STRINGDATA");
trace(ioText == null ? "OK-NO-IOERR" : "FAIL-IOERR " + ioText);
`;
    const asFile = join(dir, 'wsrt.as');
    const exe = join(dir, process.platform === 'win32' ? 'wsrt.exe' : 'wsrt');
    writeFileSync(asFile, src);

    // Async spawn, NOT spawnSync: the fixture server lives in THIS process, so a
    // synchronous child would block the event loop its peer needs.
    let out = '';
    try {
      // Use the compiler this machine actually has (cc is absent on Windows).
      const r = await runAsync('node', ['src/index.ts', asFile, '--cc', cc, '-o', exe, '--run'], {
        cwd: root,
        timeout: 300_000,
        maxBuffer: 32 * 1024 * 1024,
        env: process.env,
      });
      out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      out = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`;
    }

    for (const line of [
      'OK-OPEN', 'OK-FIRST', 'OK-TEXT', 'OK-BINARY', 'OK-FRAGMENT', 'OK-CLOSE', 'OK-CODE',
      'OK-BYTES', 'OK-STRINGDATA-NULL', 'OK-NO-IOERR',
    ]) {
      assert.ok(out.includes(line), `${line} missing from the client run:\n${out}`);
    }
    // The server side: the subprotocol vector became one header value, the PING
    // was answered by the transport (not by the app), and the client's own close
    // frame never came back as a 4001 (the server's 4001 is what the app saw).
    assert.strictEqual(fixture.seen.protocol, 'chat.v1, chat.v2');
    assert.ok(fixture.seen.pong, 'the transport did not answer the server PING with a PONG');
    assert.deepStrictEqual(fixture.seen.text, ['hello-ws', 'bye']);
    assert.strictEqual(fixture.seen.binary, 1);
  } finally {
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// websocket-roundtrip/: air.net.WebSocket.startServer() -- the SERVER side.
// ---------------------------------------------------------------------------
//
// The compiled AS3 program IS the server (ServerSocket -> accept -> startServer)
// and this process is the raw RFC 6455 CLIENT. That direction is the one with no
// coverage until now: AIR hands startServer() an already-accepted
// flash.net.Socket, so the runtime has to READ the opening handshake instead of
// writing one, and every frame it sends must be unmasked while every frame it
// receives must be unmasked-after-masking.

// A CLIENT frame: always masked (RFC 6455 §5.1), FIN optional for fragments.
function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const n = payload.length;
  const head: number[] = [(fin ? 0x80 : 0x00) | opcode];
  if (n < 126) head.push(0x80 | n);
  else if (n < 65536) head.push(0x80 | 126, (n >> 8) & 0xff, n & 0xff);
  else {
    head.push(0x80 | 127, 0, 0, 0, 0,
      (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([Buffer.from(head), mask, body]);
}

// The AS3 server. Every line it prints is matched by the driver below, so a
// failure names itself instead of "the program exited 1".
const WS_SERVER_SRC = `
import air.net.WebSocket;
import flash.events.Event;
import flash.events.IOErrorEvent;
import flash.events.ServerSocketConnectEvent;
import flash.events.WebSocketEvent;
import flash.net.ServerSocket;
import flash.net.Socket;
import flash.utils.ByteArray;

var srv:ServerSocket = new ServerSocket();
var ws:WebSocket = null;
var connectSeen:Boolean = false;
var dataIsBytes:Boolean = true;
var posZero:Boolean = true;
var texts:String = "";
var closeReason:int = -999;
var closed:Boolean = false;
var ioText:String = null;

function onAccept(e:ServerSocketConnectEvent):void {
    var sock:Socket = e.socket;
    trace("SRV-ACCEPT-CONNECTED=" + sock.connected);
    ws = new WebSocket();
    ws.addEventListener(Event.CONNECT, function(ev:Event):void { connectSeen = true; });
    ws.addEventListener(WebSocketEvent.DATA, onData);
    ws.addEventListener(Event.CLOSE, onClose);
    ws.addEventListener(IOErrorEvent.IO_ERROR, function(ev:IOErrorEvent):void { ioText = ev.text; });
    ws.startServer(sock);
    trace("SRV-STARTSERVER-DONE protocol=" + (ws.protocol === null ? "null" : ws.protocol));
}

function onData(e:WebSocketEvent):void {
    if (!(e.data is ByteArray)) dataIsBytes = false;
    if (e.data.position != 0) posZero = false;
    if (e.format == WebSocket.fmtTEXT) {
        texts = texts + e.stringData + "|";
        ws.sendMessage(WebSocket.fmtTEXT, e.stringData);
    } else {
        ws.sendMessage(WebSocket.fmtBINARY, e.data);
    }
}

function onClose(e:Event):void {
    closeReason = ws.closeReason;
    closed = true;
}

srv.addEventListener(ServerSocketConnectEvent.CONNECT, onAccept);
srv.bind(0, "127.0.0.1");
srv.listen();
trace("PORT=" + srv.localPort);

for (var i:int = 0; i < 2000 && !closed; i++) tickTimers();

trace(closed ? "OK-CLOSED" : "FAIL-NO-CLOSE");
trace(connectSeen ? "FAIL-SERVER-DISPATCHED-CONNECT" : "OK-NO-CONNECT-EVENT");
trace(dataIsBytes ? "OK-DATA-BYTES" : "FAIL-DATA-NOT-BYTES");
trace(posZero ? "OK-POS-ZERO" : "FAIL-POS-NOT-ZERO");
trace(texts == "srv-text|fragmented|" ? "OK-TEXTS" : "FAIL-TEXTS " + texts);
trace(closeReason == 4002 ? "OK-CLOSE-4002" : "FAIL-CLOSE-CODE " + closeReason);
trace(ioText == null ? "OK-NO-IOERR" : "FAIL-IOERR " + ioText);
trace("DONE");
`;

test('websocket-roundtrip/ startServer(): a compiled AS3 server answers a raw client', async (t) => {
  const cc = cCompiler();
  if (cc === null) { t.skip('no C compiler on PATH'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'as-wssrv-'));
  const asFile = join(dir, 'wssrv.as');
  const exe = join(dir, process.platform === 'win32' ? 'wssrv.exe' : 'wssrv');
  writeFileSync(asFile, WS_SERVER_SRC);

  // Build synchronously (nothing is listening yet), then SPAWN the binary: its
  // stdout is how the AS3 side reports the port it picked (bind(0)), and the
  // client cannot exist before it knows that number.
  execFileSync('node', ['src/index.ts', asFile, '--cc', cc, '-o', exe], {
    cwd: root,
    timeout: 300_000,
    stdio: 'pipe',
  });

  const child = spawn(exe, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stderr += String(d); });

  const sock = new NetSocket();
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`the AS3 server never printed PORT=:\n${stdout}\n${stderr}`)),
        30_000);
      const look = (): void => {
        const m = /PORT=(\d+)/.exec(stdout);
        if (m !== null) { clearTimeout(timer); resolve(Number(m[1])); }
      };
      child.stdout.on('data', look);
      look();
    });

    // --- the client's view of the wire -----------------------------------
    let head = '';
    let rest = Buffer.alloc(0);
    const frames: { fin: boolean; op: number; body: Buffer }[] = [];
    let wake: (() => void) | null = null;
    let headReady: (() => void) | null = null;

    const parse = (): void => {
      for (;;) {
        if (rest.length < 2) break;
        const fin = (rest[0] & 0x80) !== 0;
        const op = rest[0] & 0x0f;
        const masked = (rest[1] & 0x80) !== 0;
        assert.ok(!masked, 'a SERVER frame must not be masked (RFC 6455 §5.1)');
        let len = rest[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (rest.length < 4) break;
          len = rest.readUInt16BE(2);
          off = 4;
        }
        if (rest.length < off + len) break;
        frames.push({ fin, op, body: Buffer.from(rest.subarray(off, off + len)) });
        rest = rest.subarray(off + len);
      }
      if (wake !== null) { const w = wake; wake = null; w(); }
    };

    sock.on('data', (d: Buffer) => {
      rest = Buffer.concat([rest, d]);
      if (head === '') {
        const i = rest.indexOf('\r\n\r\n');
        if (i < 0) return;
        head = rest.subarray(0, i + 4).toString('latin1');
        rest = rest.subarray(i + 4);
        if (headReady !== null) { const h = headReady; headReady = null; h(); }
      }
      parse();
    });

    const waitHead = async (): Promise<void> => {
      if (head !== '') return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no handshake response:\n${stdout}\n${stderr}`)), 20_000);
        headReady = () => { clearTimeout(timer); resolve(); };
      });
    };

    const nextFrame = async (what: string): Promise<{ fin: boolean; op: number; body: Buffer }> => {
      for (;;) {
        const f = frames.shift();
        if (f !== undefined) return f;
        const got = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 20_000);
          wake = () => { clearTimeout(timer); resolve(true); };
        });
        if (!got) throw new Error(`timed out waiting for ${what}:\n${stdout}\n${stderr}`);
      }
    };

    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve());
      sock.once('error', reject);
      sock.connect(port, '127.0.0.1');
    });

    const key = Buffer.from('the-sample-nonce').toString('base64');
    sock.write([
      'GET /chat HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Protocol: chat, superchat',
      '', '',
    ].join('\r\n'));

    await waitHead();
    assert.match(head, /^HTTP\/1\.1 101 Switching Protocols/);
    const want = createHash('sha1').update(key + GUID).digest('base64');
    assert.ok(head.includes(`Sec-WebSocket-Accept: ${want}`),
      `the server's accept token is wrong:\n${head}`);
    // AIR 51.4.1 measured: the server echoes NO subprotocol, even when asked.
    assert.ok(!/sec-websocket-protocol/i.test(head),
      `the server must not echo a subprotocol:\n${head}`);

    sock.write(clientFrame(1, Buffer.from('srv-text')));
    const echo = await nextFrame('the TEXT echo');
    assert.strictEqual(echo.op, 1);
    assert.strictEqual(echo.body.toString('utf8'), 'srv-text');

    // Fragment reassembly on the SERVER side: two frames, one event, one echo.
    sock.write(clientFrame(1, Buffer.from('frag'), false));
    sock.write(clientFrame(0, Buffer.from('mented'), true));
    const frag = await nextFrame('the reassembled TEXT echo');
    assert.strictEqual(frag.op, 1);
    assert.strictEqual(frag.body.toString('utf8'), 'fragmented');

    sock.write(clientFrame(2, Buffer.from([1, 2, 3])));
    const bin = await nextFrame('the BINARY echo');
    assert.strictEqual(bin.op, 2);
    assert.deepStrictEqual([...bin.body], [1, 2, 3]);

    sock.write(clientFrame(9, Buffer.from('p1')));
    const pong = await nextFrame('the PONG');
    assert.strictEqual(pong.op, 10);
    assert.strictEqual(pong.body.toString('utf8'), 'p1');

    const closePayload = Buffer.alloc(4);
    closePayload.writeUInt16BE(4002, 0);
    closePayload.write('bye', 2, 'utf8');
    sock.write(clientFrame(8, closePayload));
    const echoClose = await nextFrame('the CLOSE echo');
    assert.strictEqual(echoClose.op, 8);
    assert.strictEqual(echoClose.body.readUInt16BE(0), 4002);

    // --- the server's own report -----------------------------------------
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`the AS3 server did not exit:\n${stdout}\n${stderr}`)); }, 60_000);
      child.on('exit', () => { clearTimeout(timer); resolve(); });
    });
    for (const line of [
      'SRV-ACCEPT-CONNECTED=true',
      'SRV-STARTSERVER-DONE protocol=null',
      'OK-CLOSED', 'OK-NO-CONNECT-EVENT', 'OK-DATA-BYTES', 'OK-POS-ZERO',
      'OK-TEXTS', 'OK-CLOSE-4002', 'OK-NO-IOERR', 'DONE',
    ]) {
      assert.ok(stdout.includes(line), `server line "${line}" missing:\n${stdout}\n${stderr}`);
    }
  } finally {
    sock.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      // Windows keeps the exe locked until the process is really gone; the rm
      // below would fail with EPERM if it ran first.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 5000);
        child.on('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});