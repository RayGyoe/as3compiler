// stage37.as — flash.display rendering: Shape/Graphics/Bitmap + recursive render.

var stage:Stage = new Stage();

// --- Graphics: solid fill rectangle ---
var s1:Shape = new Shape();
s1.x = 10; s1.y = 10;
s1.graphics.beginFill(0xFF0000, 1.0);
s1.graphics.drawRect(0, 0, 80, 80);
s1.graphics.endFill();
stage.addChild(s1);

// --- Graphics: two-stop linear gradient rectangle ---
var s2:Shape = new Shape();
s2.x = 100; s2.y = 10;
s2.graphics.beginGradientFill("linear", [0xFF0000, 0x0000FF], [1.0, 1.0], [0, 255], null);
s2.graphics.drawRect(0, 0, 80, 80);
s2.graphics.endFill();
stage.addChild(s2);

// --- nested Sprite with rotation + alpha ---
var group:Sprite = new Sprite();
group.x = 10; group.y = 100; group.rotation = 0; group.alpha = 0.5;
var inner:Shape = new Shape();
inner.graphics.beginFill(0x00FF00, 1.0);
inner.graphics.drawCircle(40, 40, 30);
inner.graphics.endFill();
group.addChild(inner);
stage.addChild(group);

// --- BitmapData getPixel/setPixel (pure C buffer, no Skia needed) ---
var bd:BitmapData = new BitmapData(2, 2, false, 0xFFFFFF);
trace("getPixel default:", bd.getPixel(0, 0) == 0xFFFFFF);
bd.setPixel(0, 0, 0xFF0000);
trace("setPixel/getPixel:", bd.getPixel(0, 0) == 0xFF0000 && bd.getPixel(1, 1) == 0xFFFFFF);
trace("bitmapData size:", bd.width == 2 && bd.height == 2);

// --- Bitmap (image decoded only when Skia is linked) ---
var bmp:Bitmap = new Bitmap(bd);
bmp.x = 200; bmp.y = 10;
stage.addChild(bmp);

// --- offscreen raster -> PNG (no-op without Skia, writes stage37.png with Skia) ---
stage.render(320, 200, "stage37.png");
trace("render ok");
