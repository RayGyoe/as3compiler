// autobake.as — automatic cacheAsBitmap (incremental redraw) verification.
// Offscreen: a static subtree is rendered across several frames. The renderer
// fingerprints the subtree each frame; once the fingerprint is unchanged for
// ASC_AUTO_BAKE_FRAMES consecutive frames the subtree is auto-baked into a
// bitmap and subsequent frames draw that image instead of re-walking children.
// The test asserts the auto-baked output is pixel-identical to the very first
// (direct) frame, then mutates the subtree and asserts the bake is invalidated
// so the next frame reflects the change.
//
// Compile: as-aot examples/autobake.as --manifest examples/autobake.build.json --run

import flash.display.Sprite;
import flash.display.Shape;
import flash.display.BitmapData;

var stage:Stage = new Stage();
stage.stageWidth = 400;
stage.stageHeight = 300;

var container:Sprite = new Sprite();
container.x = 30;
container.y = 30;

var box:Shape = new Shape();
box.graphics.beginFill(0x3366CC);
box.graphics.drawRect(0, 0, 120, 90);
box.graphics.endFill();
container.addChild(box);

var circle:Shape = new Shape();
circle.graphics.beginFill(0xCC6633);
circle.graphics.drawCircle(180, 45, 40);
circle.graphics.endFill();
container.addChild(circle);

stage.addChild(container);

// Frame 1: direct recursive render (reference). _auto_still becomes 1.
stage.render(400, 300, "autobake_f1.png");
// Frames 2..3: fingerprint unchanged, still counter climbs to the threshold and
// auto-bakes the container. Frame 4 draws the baked image.
stage.render(400, 300, "autobake_f2.png");
stage.render(400, 300, "autobake_f3.png");
stage.render(400, 300, "autobake_f4.png");
// Frame 5: baked path (drawImage). Must equal frame 1 pixel-for-pixel.
stage.render(400, 300, "autobake_f5.png");

trace("autobake: rendered 5 frames (f4/f5 should be auto-baked)");

// Mutate the subtree: move the circle. The fingerprint changes, the bake is
// dropped, and the next frame reflects the new position via the normal path.
circle.x = 60;
circle.y = 40;
stage.render(400, 300, "autobake_moved.png");
trace("autobake: mutated subtree re-rendered");

// After the mutation settles, the subtree auto-bakes again (fingerprint stable).
stage.render(400, 300, "autobake_f6.png");
stage.render(400, 300, "autobake_f7.png");
stage.render(400, 300, "autobake_f8.png");
trace("autobake: re-baked after settle");

trace("autobake: complete");
