// clipDepth masks are built from the LIVE mask object every frame (阶段三百一十九).
//
// skin.swc sprite #74 (`skin_fla.元件77_50`, 100 frames) is the reference: depth 2 is a
// MORPH that clips depths 3..4, and frame 100 replaces it with a plain shape while
// redeclaring the same clipDepth. Under the previous bake the mask was dropped
// entirely (morph masks were reported unsupported) and frame 100's record was skipped,
// so the sprite lost a child (4 -> 3).
//
// The masked child (depth 3) is TEAL and the unmasked one (depth 1) is dark grey, and
// they sit at the same place — so this counts the masked child's own colour, which is
// exactly the stencil's doing. Sliding the MASK (not the child) keeps every shape at
// non-negative x, where BitmapData.draw's 0..w bake surface cannot crop it.
import flash.display.*;
import flash.geom.*;
import flash.utils.*;

var bmd: BitmapData = new BitmapData(320, 40, true, 0x00000000);
var Cls: Class = getDefinitionByName("skin_fla.元件77_50") as Class;
var mc: MovieClip = new Cls() as MovieClip;
var fails: Array = [];

function teal(): int {
  var n: int = 0;
  for (var y: int = 0; y < bmd.height; y++) {
    for (var x: int = 0; x < bmd.width; x++) if ((bmd.getPixel32(x, y) & 0xffffff) == 0x00948c) n++;
  }
  return n;
}

function tealAt(x: Number): int {
  var mask: DisplayObject = mc.getChildAt(1);
  mask.x = x;
  bmd.fillRect(bmd.rect, 0x00000000);
  bmd.draw(mc);
  return teal();
}

function expect(label: String, ok: Boolean, detail: String): void {
  if (!ok) fails.push(label + " (" + detail + ")");
}

// The removed-then-replaced frame must keep the child count: AIR answers 4 at both ends.
expect("f1 child count", mc.numChildren == 4, "" + mc.numChildren);
var t1_closed: int = tealAt(0);
var t1_open: int = tealAt(40);
expect("f1 clipped at x=0", t1_closed == 0, "" + t1_closed);
expect("f1 revealed at x=40", t1_open > 150 && t1_open < 260, "" + t1_open);

mc.gotoAndStop(99);
var t99: int = tealAt(0);
expect("f99 follows the morph ratio", t99 > 300, "" + t99);

mc.gotoAndStop(100);
expect("f100 child count", mc.numChildren == 4, "" + mc.numChildren);
var t100: int = tealAt(0);
var t100_far: int = tealAt(100);
expect("f100 still clipped by the new shape", t100 > 300, "" + t100);
expect("f100 clipped at x=100", t100_far == 0, "" + t100_far);

mc.gotoAndStop(1);
expect("back to f1", tealAt(0) == 0, "stale stencil");

// A plain shape mask (loginskin, clipping depth 3 only) must keep working: these are
// the numbers adl 51.4.1 gives for the same draw call.
var LoginCls: Class = getDefinitionByName("loginskin") as Class;
var login: MovieClip = new LoginCls() as MovieClip;
var big: BitmapData = new BitmapData(900, 700, true, 0x00000000);
big.draw(login, new Matrix(1, 0, 0, 1, 300, 200));
var ink: int = 0;
for (var y2: int = 0; y2 < big.height; y2++) {
  for (var x2: int = 0; x2 < big.width; x2++) if ((big.getPixel32(x2, y2) >>> 24) != 0) ink++;
}
expect("loginskin ink", ink == 177000, "" + ink);

if (fails.length == 0) {
  trace("swc-mask-frames: OK");
} else {
  trace("swc-mask-frames: FAIL " + fails.join("; "));
}