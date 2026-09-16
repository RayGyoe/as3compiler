// textflow.as — TextField line layout: hard breaks, single-line mode, and the
// scrollV / maxScrollV viewport math (stage 44).
//
// Assertions are written so they hold in BOTH build flavors: with Skia linked the
// word wrapper measures real glyph advances, while the pure-C stub measures 0 and
// therefore never soft-wraps. Everything asserted here depends only on explicit
// newlines and on line height, so it is stable either way.

var tf:TextField = new TextField();
tf.multiline = true;
tf.wordWrap = false;
tf.defaultTextFormat = new TextFormat(null, 12, 0x000000, false, false);
tf.width = 200;
tf.height = 60;

// --- hard breaks -------------------------------------------------------------
tf.text = "a\nb\nc";
if (tf.numLines != 3) throw new Error("expected 3 lines, got " + tf.numLines);

// A trailing newline opens one more (empty) line, as AIR does.
tf.text = "a\nb\n";
if (tf.numLines != 3) throw new Error("trailing newline should add a line, got " + tf.numLines);

// --- single-line mode keeps newlines inline instead of breaking ---------------
tf.multiline = false;
tf.text = "a\nb\nc";
if (tf.numLines != 1) throw new Error("single-line field must not break, got " + tf.numLines);
tf.multiline = true;

// --- viewport math -----------------------------------------------------------
// Line height is 1.2 * size = 14.4, so a 60px-tall field shows 4 lines.
tf.text = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10";
if (tf.numLines != 10) throw new Error("expected 10 lines, got " + tf.numLines);
// maxScrollV is the top line that still fills the viewport: 10 - 4 + 1 = 7.
if (tf.maxScrollV != 7) throw new Error("expected maxScrollV 7, got " + tf.maxScrollV);

// Setting scrollV = maxScrollV is the log-tailing idiom: the newest line lands at
// the BOTTOM of the box rather than being scrolled up to the top.
tf.scrollV = tf.maxScrollV;
if (tf.scrollV != 7) throw new Error("scrollV should stick to 7, got " + tf.scrollV);

// A field that fits its content cannot scroll at all.
tf.height = 400;
if (tf.maxScrollV != 1) throw new Error("short content must not scroll, got " + tf.maxScrollV);
tf.height = 60;

// --- appendText grows the line count ----------------------------------------
var before:int = tf.numLines;
tf.appendText("appended\n");
if (tf.numLines != before + 1) {
  throw new Error("appendText should add a line: " + before + " -> " + tf.numLines);
}

// --- textHeight tracks the layout -------------------------------------------
// 11 lines * 14.4 = 158.4; independent of the font, so valid without Skia too.
var expected:Number = tf.numLines * 12 * 1.2;
if (tf.textHeight < expected - 0.01 || tf.textHeight > expected + 0.01) {
  throw new Error("textHeight " + tf.textHeight + " != " + expected);
}

trace("textflow: numLines/maxScrollV/scrollV/appendText/textHeight OK");
