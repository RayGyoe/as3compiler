import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractSwc, swcCompileInputs, swcBakePlan } from '../../src/swc.ts';
import { root } from '../harness.ts';

// Tiny authored shapes provide an independent coordinate/paint oracle. No host
// fonts participate: one glyph is a rectangle with a quadratic edge.
const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 65535); return b; };
class Bits {
  bits = '';
  put(v: number, n: number) { this.bits += (v >>> 0).toString(2).padStart(n, '0').slice(-n); return this; }
  bytes() { return Buffer.from(this.bits.padEnd(Math.ceil(this.bits.length / 8) * 8, '0').match(/.{8}/g)!.map(b => parseInt(b, 2))); }
}
function rect(x: number, y: number, w: number, h: number) {
  return new Bits().put(16, 5).put(x, 16).put(x + w, 16).put(y, 16).put(y + h, 16).bytes();
}
function glyph(units: number) {
  const b = new Bits().put(1, 4).put(0, 4);
  b.put(0, 1).put(5, 5).put(1, 5).put(0, 1).put(0, 1).put(1, 1); // move + fill1
  const edge = (dx: number, dy: number) => b.put(1, 1).put(1, 1).put(14, 4).put(1, 1).put(dx, 16).put(dy, 16);
  edge(units / 2, 0); edge(0, -units / 2);
  b.put(1, 1).put(0, 1).put(14, 4).put(-units / 4, 16).put(-units / 4, 16).put(-units / 4, 16).put(units / 4, 16);
  edge(0, units / 2);
  return b.put(0, 1).put(0, 5).bytes();
}
function tag(code: number, data: Buffer) {
  const h = Buffer.alloc(6); h.writeUInt16LE((code << 6) | 63); h.writeUInt32LE(data.length, 2);
  return Buffer.concat([h, data]);
}
function zip(data: Buffer) {
  const name = Buffer.from('library.swf');
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(ch.length + name.length, 12); end.writeUInt32LE(lh.length + name.length + data.length, 16);
  return Buffer.concat([lh, name, data, ch, name, end]);
}
function fixture(version: 2 | 3, alpha = false, badIndex = false, air = false) {
  const units = version === 3 ? 20480 : 1024;
  const g = glyph(units);
  // WideCodes + WideOffsets deliberately cover both font offset widths.
  const wide = version === 3;
  const offset = (n: number) => { const b = Buffer.alloc(wide ? 4 : 2); wide ? b.writeUInt32LE(n) : b.writeUInt16LE(n); return b; };
  const font = Buffer.concat([u16(1), Buffer.from([4 | (wide ? 8 : 0), 0, 1, 65]), u16(1), offset(wide ? 8 : 4), offset((wide ? 8 : 4) + g.length), g, u16(0x4e2d)]);
  // TextMatrix translates (40,60) twips. A baseline at (100,300) gives (7,18)px.
  const matrix = new Bits().put(0, 1).put(0, 1).put(8, 5).put(40, 8).put(60, 8).bytes();
  const entries = new Bits().put(badIndex ? 1 : 0, 1).put(600, 12).put(0, 1).put(-100, 12).bytes();
  const text = Buffer.concat([u16(2), rect(0, 0, 1600, 1000), matrix, Buffer.from([1, 12, 0x8f]), u16(1), Buffer.from(alpha ? [255, 0, 0, 128] : [255, 0, 0]), u16(100), u16(300), u16(400), Buffer.from([2]), entries,
    // A second run inherits font, height, X and Y, but changes paint.
    Buffer.from([0x84]), Buffer.from(alpha ? [0, 0, 255, 255] : [0, 0, 255]), Buffer.from([1]), new Bits().put(0, 1).put(0, 12).bytes(), Buffer.from([0])]);
  const place = tag(26, Buffer.concat([Buffer.from([6]), u16(1), u16(2), Buffer.from([0])]));
  const sprite = tag(39, Buffer.concat([u16(3), u16(1), place, tag(1, Buffer.alloc(0)), tag(0, Buffer.alloc(0))]));
  const symbols = tag(76, Buffer.concat([u16(1), u16(3), Buffer.from('StaticProbe\0')]));
  const body = Buffer.concat([rect(0, 0, 2000, 2000), u16(24 * 256), u16(1), ...(air ? [tag(69, Buffer.from([8, 0, 0, 0]))] : []), tag(version === 3 ? 75 : 48, font), tag(alpha ? 33 : 11, text), ...(air ? [place, tag(1, Buffer.alloc(0))] : [sprite, symbols]), tag(0, Buffer.alloc(0))]);
  const h = Buffer.alloc(8); h.write('FWS'); h[3] = 10; h.writeUInt32LE(body.length + 8, 4);
  return zip(Buffer.concat([h, body]));
}
const dir = join(root, 'temp', 'swc-static-text');
mkdirSync(dir, { recursive: true });
test('unit: SWC static glyph coordinates, records, alpha and font scales', () => {
  for (const version of [2, 3] as const) for (const alpha of [false, true]) {
    const path = join(dir, `font${version}-${alpha}.swc`); writeFileSync(path, fixture(version, alpha));
    const lib = extractSwc(path), input = swcCompileInputs(lib), bake = swcBakePlan(lib, input.specs, input.chars);
    const t = lib.texts[0];
    assert.equal(t.staticText, '中中中');
    assert.equal(t.staticShape?.subpaths.length, 3);
    assert.deepEqual(t.staticShape?.subpaths[0].start, { x: 140, y: 360 });
    assert.deepEqual(t.staticShape?.subpaths[1].start, { x: 740, y: 360 });
    assert.deepEqual(t.staticShape?.subpaths[2].start, { x: 640, y: 360 });
    assert.equal(t.staticShape?.subpaths[0].pts[1].x, 340);
    assert.equal(t.staticShape?.subpaths[0].pts[3].cx, 240);
    assert.equal(t.staticShape?.layers[0].fills[1].rgba, alpha ? 0x80ff0000 : 0xffff0000);
    const text = bake.characters.find(c => c.id === 2)?.text;
    assert.equal(text?.ox, 0); assert.equal(text?.oy, 0);
    assert.equal(text?.shape?.groups.length, 3);
    assert.equal(text?.shape?.groups[0].paths[0].start.x, 7);
    assert(!bake.notes.some(n => /EMPTY|CodeTable/.test(n)));
  }
  const path = join(dir, 'bad.swc'); writeFileSync(path, fixture(2, false, true));
  assert.throws(() => extractSwc(path), /glyph index 1 exceeds/);
});
test('unit: SWC StaticText native type, values and rasterized embedded outlines', () => {
  const ref = fixture(3, true, false, true);
  writeFileSync(join(dir, 'Reference.swf'), ref.subarray(41, 41 + ref.readUInt32LE(18)));
  const swc = join(dir, 'runtime.swc'); writeFileSync(swc, fixture(3, true));
  const source = join(dir, 'Probe.as');
  writeFileSync(source, `
var root:Sprite = new StaticProbe();
var t:DisplayObject = root.getChildAt(0);
if (!(t is StaticText) || t is TextField || t is Shape || t is InteractiveObject) throw new Error("static type");
if (getQualifiedClassName(t) != "flash.text::StaticText") throw new Error("static name");
if (StaticText(t).text != "中中中") throw new Error("static text");
var bounds:Rectangle = t.getBounds(root);
if (bounds.x != 0 || bounds.y != 0 || bounds.width != 80 || bounds.height != 50) throw new Error("static bounds");
var b:BitmapData = new BitmapData(100, 100, true, 0);
b.draw(root);
if (b.getPixel32(12, 14) != 0x80ff0000) throw new Error("red glyph pixel " + b.getPixel32(12,14));
if (b.getPixel32(38, 14) != 0xff0000ff) throw new Error("blue inherited glyph pixel " + b.getPixel32(38,14));
if (b.getPixel32(60, 14) != 0) throw new Error("outside glyph");
var caught:Boolean = false;
try { new StaticText(); } catch(e:ArgumentError) { caught = e.errorID == 2012; }
if (!caught) throw new Error("StaticText construction");
caught = false;
try { new MorphShape(); } catch(e:ArgumentError) { caught = e.errorID == 2012; }
if (!caught) throw new Error("MorphShape construction");
trace("static-text: OK");
`);
  const manifest = join(dir, 'probe.build.json');
  const config = JSON.parse(readFileSync(join(root, 'examples', 'swc-bitmap.build.json'), 'utf8'));
  for (const key of Object.keys(config)) if (Array.isArray(config[key])) {
    config[key] = config[key].map((v: string) => v.replaceAll('../vendor', join(root, 'vendor')));
  }
  config['swc-paths'] = [swc];
  writeFileSync(manifest, JSON.stringify(config));
  const result = spawnSync(process.execPath, ['src/index.ts', source, '--manifest', manifest, '-o', join(dir, 'Probe'), '--run'], { cwd: root, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /static-text: OK/);
  assert(!/warning:/.test(result.stderr), result.stderr);
});
