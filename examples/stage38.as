// stage38.as — flash.text: TextField + TextFormat (single-line SkFont path).

var stage:Stage = new Stage();

var fmt:TextFormat = new TextFormat("Arial", 24, 0x003399, true, false);
trace("textformat:", fmt.font == "Arial" && fmt.size == 24 && fmt.color == 0x003399 && fmt.bold && !fmt.italic);

var tf:TextField = new TextField();
tf.defaultTextFormat = fmt;
tf.text = "Hello, Skia!";
tf.x = 10; tf.y = 10;
stage.addChild(tf);

trace("textfield.text:", tf.text == "Hello, Skia!");
trace("textHeight ~ size:", tf.textHeight == 24);
// tf.textWidth is Skia-measured (as_skia_text_measure): it reports the real
// advance width only when ASC_USE_SKIA links the C++ glue; the pure-C stub
// returns 0, so this line is intentionally not asserted here.

var tf2:TextField = new TextField();
tf2.text = "plain";
trace("default format size:", tf2.defaultTextFormat.size == 12 && !tf2.defaultTextFormat.bold);

// --- offscreen raster -> PNG (no-op without Skia, writes stage38.png with Skia) ---
stage.render(200, 80, "stage38.png");
trace("render ok");
