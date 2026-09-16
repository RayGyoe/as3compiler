// stage36.as — minimal Skia closed loop: one Shape -> offscreen PNG.
// Runs pure-C (Stage.render is a no-op stub) and, with `--manifest
// skia-link.build.example.json` + a compiled vendor/skia, writes stage36.png.

var stage:Stage = new Stage();
var s:Shape = new Shape();
s.graphics.beginFill(0xFF0000, 1.0);
s.graphics.drawRect(10, 10, 100, 80);
s.graphics.endFill();
stage.addChild(s);
stage.render(200, 100, "stage36.png");
trace("render ok");
