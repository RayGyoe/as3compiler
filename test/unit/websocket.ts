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
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert';
import type { Socket } from 'node:net';
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
  check('the worker owns curl_easy_perform (CONNECT_ONLY=2 handshake)',
    rt.includes('CURLOPT_CONNECT_ONLY') && rt.includes('curl_easy_perform('));
  // curl's ws_* frame layer cannot express the end of a fragmented message (and
  // its raw mode rejects the PONG it sends itself), so the framing is the
  // runtime's own -- and it must stay that way, or fragments split into events.
  check('the frame codec is the runtime\'s own (parse_frames + FIN handling)',
    rt.includes('as_ws_parse_frames(') && /int fin = \(p\[0\] & 0x80\) != 0;/.test(rt));
  check('a fragmented message is reassembled before it is published',
    rt.includes('as_ws_frag_append(') && /if \(fin\) \{[\s\S]{0,200}as_ws_push\(w, \*msg_op/.test(rt));
  check('client frames are masked (RFC 6455 §5.3)',
    rt.includes('as_ws_mask_key(') && /0x80 \| \(unsigned char\)len/.test(rt));
  check('a server PING is answered with a PONG by the transport',
    rt.includes('as_ws_send_frame(h, 0xA,'));

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
  check('server mode is a NAMED gap, reported as #2031',
    emitSrc.includes('WebSocket server mode is not implemented by this runtime'));

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
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        (seen.protocol !== null ? `Sec-WebSocket-Protocol: ${seen.protocol.split(',')[0].trim()}\r\n` : '') +
        '\r\n'
      );
      // A PING right after the handshake: RFC 6455 §5.5.3 makes answering it the
      // endpoint's duty, and curl does not do it for the application.
      socket.write(frame(0x9, Buffer.from('pp')));

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
  if (cCompiler() === null) {
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
        if (s == "hello-ws") gotText = s;
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
      const r = await runAsync('node', ['src/index.ts', asFile, '-o', exe, '--run'], {
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
      'OK-OPEN', 'OK-TEXT', 'OK-BINARY', 'OK-FRAGMENT', 'OK-CLOSE', 'OK-CODE',
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