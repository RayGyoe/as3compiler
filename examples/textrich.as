// textrich.as — TextField rich features: autoSize, hscroll/maxScrollH/scrollH,
// selectable, selection indices, leading, htmlText, and setTextFormat runs
// (stage 38 continuation).
//
// Assertions are written to hold in BOTH build flavors. Layout values that
// depend on the real font (textWidth/maxScrollH) are asserted only as ranges or
// relationships, never as absolute pixel counts, so pure-C (size*1.2 stub, no
// Skia measurement) and Skia (real ascent+descent + real width) both pass.

var tf:TextField = new TextField();
tf.defaultTextFormat = new TextFormat(null, 12, 0x000000, false, false);

// --- selection indices -------------------------------------------------------
// Before any selection, the caret sits at 0 and the selection range is empty.
if (tf.caretIndex != 0) throw new Error("default caretIndex should be 0, got " + tf.caretIndex);
tf.text = "hello world";
tf.setSelection(0, 5);
if (tf.selectionBeginIndex != 0 || tf.selectionEndIndex != 5) {
  throw new Error("selection should be [0,5), got [" + tf.selectionBeginIndex + "," + tf.selectionEndIndex + ")");
}
if (tf.caretIndex != 5) throw new Error("caret should follow selection end, got " + tf.caretIndex);
// setSelection clamps to the string length (byte length).
tf.setSelection(3, 999);
if (tf.selectionEndIndex != 11) {
  throw new Error("selection should clamp to strlen, got " + tf.selectionEndIndex);
}

// --- leading: a positive leading raises the line height ----------------------
tf.multiline = true;
tf.wordWrap = false;
tf.text = "a\nb";
var h0:Number = tf.textHeight;
var lh0:Number = h0 / tf.numLines;

var lf:TextFormat = new TextFormat(null, 12, 0x000000, false, false, 8);
tf.defaultTextFormat = lf;
var h1:Number = tf.textHeight;
var lh1:Number = h1 / tf.numLines;
if (lh1 <= lh0) {
  throw new Error("leading should increase line height: " + lh0 + " -> " + lh1);
}

// --- hscroll / maxScrollH / scrollH ------------------------------------------
tf.defaultTextFormat = new TextFormat(null, 12, 0x000000, false, false);
tf.multiline = false;
tf.wordWrap = false;
tf.width = 50;
tf.height = 30;
tf.text = "this is a much longer single line that overflows";
// Without hscroll, maxScrollH is 0 (no horizontal pan) in both flavors.
if (tf.maxScrollH != 0) throw new Error("maxScrollH should be 0 when hscroll=false, got " + tf.maxScrollH);
tf.hscroll = true;
var mh:int = tf.maxScrollH;
// scrollH is clamped to [0, maxScrollH] on assignment. Setting it far past the
// extent must land inside the range regardless of the real measured width.
tf.scrollH = mh + 1000;
if (tf.scrollH < 0 || tf.scrollH > mh) {
  throw new Error("scrollH should clamp to [0,maxScrollH], got " + tf.scrollH + " (max " + mh + ")");
}
tf.scrollH = 0;
if (tf.scrollH != 0) throw new Error("scrollH should stick to 0, got " + tf.scrollH);

// --- autoSize: the field shrinks/grows to hug its text -----------------------
var autoTf:TextField = new TextField();
autoTf.defaultTextFormat = new TextFormat(null, 12, 0x000000, false, false);
autoTf.autoSize = TextFieldAutoSize.LEFT;
autoTf.multiline = false;
autoTf.wordWrap = false;
autoTf.text = "abc";
// textWidth is non-negative in both flavors (pure-C stub reports 0).
if (autoTf.textWidth < 0) throw new Error("textWidth should be non-negative, got " + autoTf.textWidth);

// --- htmlText: tags stripped to plain text, runs preserved -------------------
var ht:TextField = new TextField();
ht.defaultTextFormat = new TextFormat(null, 12, 0x000000, false, false);
ht.multiline = true;
ht.htmlText = "a<b>b</b>c";
if (ht.text != "abc") throw new Error("htmlText should strip tags, got '" + ht.text + "'");
if (ht.numLines != 1) throw new Error("htmlText single line should be 1 line, got " + ht.numLines);

// <br> becomes a hard break.
ht.htmlText = "line1<br>line2";
if (ht.numLines != 2) throw new Error("htmlText <br> should break, got " + ht.numLines + " lines");

// <font color> changes only the run color, not the text.
ht.htmlText = "x<font color=\"#ff0000\">y</font>z";
if (ht.text != "xyz") throw new Error("htmlText <font> should not add text, got '" + ht.text + "'");

// Attribute values may be quoted with EITHER quote style (AIR accepts
// `<font color='#ff0000'>`) and both must parse alike: the value is delimited by
// the quote that opened it. Pre-fix only '"' was understood, so a single-quoted
// value began at the quote itself (`size='30'` collapsed to the 1.0 floor, and
// `color='#208080'` was read from the quote as a wrong dark blue).
var sqA:TextField = new TextField();
var sqB:TextField = new TextField();
sqA.width = sqB.width = 200;
sqA.height = sqB.height = 100;
sqA.wordWrap = false;
sqB.wordWrap = false;
sqA.defaultTextFormat = new TextFormat(null, 12, 0x000000, false, false);
sqB.defaultTextFormat = new TextFormat(null, 12, 0x000000, false, false);
sqA.htmlText = "x<font color='#ff0000' size='30'>y</font>";
sqB.htmlText = "x<font color=\"#ff0000\" size=\"30\">y</font>";
if (sqA.text != sqB.text) throw new Error("single-quoted <font> changed the text: '" + sqA.text + "' vs '" + sqB.text + "'");
if (sqA.textWidth != sqB.textWidth || sqA.textHeight != sqB.textHeight) {
  throw new Error("single-quoted <font> attributes must lay out like double-quoted ones, got "
    + sqA.textWidth + "x" + sqA.textHeight + " vs " + sqB.textWidth + "x" + sqB.textHeight);
}

// --- a plain .text assignment replaces the content (drops htmlText runs) ---
// AIR's `.text = ...` replaces the whole content: rich-text runs installed by an
// earlier htmlText / setTextFormat must be dropped, so the new text is laid out
// from defaultTextFormat alone. A fresh field with the same text is the oracle.
var leakA:TextField = new TextField();
var leakB:TextField = new TextField();
leakA.width = leakB.width = 200;
leakA.height = leakB.height = 100;
leakA.wordWrap = false;
leakB.wordWrap = false;
leakA.defaultTextFormat = new TextFormat(null, 12, 0x000000, false, false);
leakB.defaultTextFormat = new TextFormat(null, 12, 0x000000, false, false);
leakA.htmlText = "<font color='#ff0000' size='30'>Back</font>";
leakB.text = "Back";
leakA.text = "Back";
if (leakA.textWidth != leakB.textWidth || leakA.textHeight != leakB.textHeight) {
  throw new Error("`.text` must drop htmlText runs: leaked run laid out as "
    + leakA.textWidth + "x" + leakA.textHeight + ", plain reference is " + leakB.textWidth + "x" + leakB.textHeight);
}
// Same rule for a setTextFormat run, including a re-assignment of the very same
// string object (the content is replaced even when the pointer is unchanged).
var leakC:TextField = new TextField();
leakC.width = 200;
leakC.height = 100;
leakC.wordWrap = false;
leakC.defaultTextFormat = new TextFormat(null, 12, 0x000000, false, false);
leakC.text = "Back";
leakC.setTextFormat(new TextFormat(null, 30, 0x000000, false, false), 0, 4);
leakC.text = "Back";
if (leakC.textWidth != leakB.textWidth || leakC.textHeight != leakB.textHeight) {
  throw new Error("`.text` must drop setTextFormat runs: leaked run laid out as "
    + leakC.textWidth + "x" + leakC.textHeight + ", plain reference is " + leakB.textWidth + "x" + leakB.textHeight);
}

// --- setTextFormat: apply a style range without changing text ----------------
var rf:TextField = new TextField();
rf.defaultTextFormat = new TextFormat(null, 12, 0x000000, false, false);
rf.multiline = false;
rf.wordWrap = false;
rf.text = "hello world";
var boldFmt:TextFormat = new TextFormat(null, 12, 0x000000, true, false);
rf.setTextFormat(boldFmt, 0, 5);
// The text is unchanged; only the run style changes.
if (rf.text != "hello world") throw new Error("setTextFormat must not change text, got '" + rf.text + "'");
if (rf.numLines != 1) throw new Error("setTextFormat single line should stay 1 line, got " + rf.numLines);

trace("textrich: selection/leading/hscroll/autoSize/htmlText/setTextFormat/text-replaces-runs OK");
