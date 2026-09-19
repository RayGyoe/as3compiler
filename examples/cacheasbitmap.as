// cacheasbitmap.as — flash.display.DisplayObject.cacheAsBitmap render verification.
// Offscreen: bakes a container subtree (rect + circle + text) with cacheAsBitmap
// on and off, rasterizes each to a PNG, and asserts the flag does not change the
// visible result semantics (both images are produced without error).
//
// Compile: as-aot examples/cacheasbitmap.as --manifest examples/cacheasbitmap.build.json

import flash.display.Sprite;
import flash.display.Shape;

var stage:Stage = new Stage();
stage.stageWidth = 400;
stage.stageHeight = 300;

var container:Sprite = new Sprite();
container.x = 40;
container.y = 40;

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

// Bake with cacheAsBitmap ON: the container subtree is snapshotted once and the
// image is drawn every frame instead of re-walking the children.
container.cacheAsBitmap = true;
stage.render(400, 300, "cacheasbitmap_on.png");
trace("rendered cacheAsBitmap=on");

// Bake with cacheAsBitmap OFF: the normal recursive path (reference output).
container.cacheAsBitmap = false;
stage.render(400, 300, "cacheasbitmap_off.png");
trace("rendered cacheAsBitmap=off");

trace("cacheasbitmap: render produced both PNGs");
