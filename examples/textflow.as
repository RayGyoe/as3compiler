// textflow.as — TextField line layout: hard breaks, single-line mode, and the
// scrollV / maxScrollV viewport math (stage 38/44).
//
// Assertions are written to hold in BOTH build flavors. With Skia linked the
// line height is the font's real ascent+descent (via SkParagraph); the pure-C
// stub falls back to size * 1.2. Every assertion below depends only on hard
// newlines and on the *relationship* lineHeight = textHeight / numLines, which
// is stable either way.

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
// 10 hard-wrapped lines in a 60px-tall field: only part is visible. The line
// height is derived at runtime as textHeight / numLines (single style, no
// leading), so the math holds whether Skia measures the real font or the
// pure-C stub approximates size * 1.2.
tf.text = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10";
if (tf.numLines != 10) throw new Error("expected 10 lines, got " + tf.numLines);

var lineHeight:Number = tf.textHeight / tf.numLines;
var visible:int = int(tf.height / lineHeight);
if (visible < 1) visible = 1;
var expectedMax:int = 10 - visible + 1;
if (tf.maxScrollV != expectedMax) {
  throw new Error("expected maxScrollV " + expectedMax + ", got " + tf.maxScrollV);
}

// Setting scrollV = maxScrollV is the log-tailing idiom: the newest line lands at
// the BOTTOM of the box rather than being scrolled up to the top.
tf.scrollV = tf.maxScrollV;
if (tf.scrollV != expectedMax) {
  throw new Error("scrollV should stick to " + expectedMax + ", got " + tf.scrollV);
}

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

// --- textHeight tracks the layout; the line height stays constant ------------
var lineHeight2:Number = tf.textHeight / tf.numLines;
if (lineHeight2 < lineHeight - 0.01 || lineHeight2 > lineHeight + 0.01) {
  throw new Error("line height drifted: " + lineHeight + " -> " + lineHeight2);
}

trace("textflow: numLines/maxScrollV/scrollV/appendText/textHeight OK");
