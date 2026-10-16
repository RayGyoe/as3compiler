// sbtn-null-up.as — SimpleButton with `upState == NULL` (D3).
//
// adl 51.4.1 truth (temp/sbtnstate2, seven probes; oracle file adl.txt):
//   * a button whose upState is NULL paints NOTHING -- over/down/hit do not stand
//     in for it -- and reports width/height/getRect all 0. The SWC-baked skin has
//     such "down-only" buttons (up = NULL, over = NULL, down/hit filled), and they
//     used to leak two grey blocks where adl shows invisible hot zones.
//   * hitTestPoint(x, y, true) is ALWAYS false on a SimpleButton: it owns no shape
//     of its own (its four states are separate DisplayObjects), so the shapeFlag
//     region is empty -- true even with a filled 60x60 hitTestState and the button
//     on the display list. hitTestState is the *input* hit area only.
//   * hitTestPoint(x, y, false) tests the button's own bounds, i.e. the up state
//     (0x0 when there is none).
//
// This file is also the regression for a hard hang: the hit region helper used to
// fall back to the button itself, so as_sbtn_contains_local <-> as_obj_region_hit_local
// recursed forever (100% CPU, never returned) for exactly this up=null/hit=null
// button shape. Reaching the checks below at all is half the test.

import flash.display.BitmapData;
import flash.display.DisplayObject;
import flash.display.SimpleButton;
import flash.display.Sprite;
import flash.geom.Rectangle;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function box(color:uint, size:Number):Sprite {
  var s:Sprite = new Sprite();
  s.graphics.beginFill(color);
  s.graphics.drawRect(0, 0, size, size);
  s.graphics.endFill();
  return s;
}

// --- the D3 shape: up = NULL, over = NULL, down + hit filled ---
var downOnly:SimpleButton = new SimpleButton(null, null, box(0xFF0000, 40), box(0x00FF00, 60));
check(downOnly.upState == null, "upState stays null");
check(downOnly.width == 0 && downOnly.height == 0, "upState==NULL: width/height are 0");
var r:Rectangle = downOnly.getRect(downOnly);
check(r.width == 0 && r.height == 0, "upState==NULL: getRect is empty");

// ...and it paints nothing: the down state (red 40x40 at the origin) must NOT show.
var bd:BitmapData = new BitmapData(80, 80, true, 0x00000000);
bd.draw(downOnly);
check(bd.getPixel32(5, 5) == 0x00000000, "upState==NULL must not fall back to the down state");

// --- hitTestPoint: shapeFlag=true is always false, shapeFlag=false follows the up state ---
check(!downOnly.hitTestPoint(5, 5, true), "shapeFlag=true is false on a SimpleButton");
check(!downOnly.hitTestPoint(5, 5, false), "upState==NULL: the bbox is empty too");

// A down-only button with NO hit state is the exact shape that used to hang.
var downNoHit:SimpleButton = new SimpleButton(null, null, box(0xFF0000, 40), null);
check(!downNoHit.hitTestPoint(5, 5, true), "down-only (up=null, hit=null) must return, not recurse");

// --- positive control: with an up state, the up state is what is measured and drawn ---
var full:SimpleButton = new SimpleButton(box(0x0000FF, 40), null, box(0xFF0000, 40), box(0x00FF00, 60));
check(full.width == 40 && full.height == 40, "up present: width/height come from the up state");
check(!full.hitTestPoint(5, 5, true), "shapeFlag=true stays false even with a hit state");
check(full.hitTestPoint(5, 5, false), "shapeFlag=false uses the up-state bounds");
check(!full.hitTestPoint(55, 55, false), "shapeFlag=false is the up state, not the 60x60 hit state");
var bd2:BitmapData = new BitmapData(80, 80, true, 0x00000000);
bd2.draw(full);
check((bd2.getPixel32(5, 5) & 0xFFFFFF) == 0x0000FF, "the up state (blue) is what gets drawn");

// --- an over state is not a substitute for a missing up state either ---
var overOnly:SimpleButton = new SimpleButton(null, box(0xFFAA00, 40), box(0xFF0000, 40), box(0x00FF00, 60));
check(overOnly.width == 0 && overOnly.height == 0, "upState==NULL: an over state does not provide a box");
var bd3:BitmapData = new BitmapData(80, 80, true, 0x00000000);
bd3.draw(overOnly);
check(bd3.getPixel32(5, 5) == 0x00000000, "upState==NULL: the over state is not drawn either");
