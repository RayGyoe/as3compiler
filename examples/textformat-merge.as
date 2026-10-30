// Stage 335: TextFormat's "unset" semantics, measured against adl 51.4.1
// (temp/tfc2/Main.as, Main2.as, Main3.as, Main4.as -- each case below names the
// probe it came from).
//
// AIR's TextFormat fields are `Object`, and its constructor sets ONLY the fields
// it was given: `new TextFormat()` leaves 18 fields null. A null field means
// "no opinion", and three separate places act on that:
//   * defaultTextFormat = fmt  merges field by field, keeping the current value
//     for every null (an all-null format is a no-op);
//   * setTextFormat(fmt, ...)  merges the same way, against the format already
//     in effect at `begin` (a run), not against the field default;
//   * the defaultTextFormat getter hands out a COPY, so mutating it changes
//     nothing.
// A fourth rule decides WHEN a format applies: AIR binds the format at INSERTION
// time. Assigning `.text` uses the then-current defaultTextFormat; changing
// defaultTextFormat afterwards leaves existing text alone until the text is
// assigned again.
//
// Every assertion reads formats back through getTextFormat/defaultTextFormat, so
// this example holds in the pure-C flavor too (no font metrics involved).

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- ① a bare format is "no opinion" everywhere ------------------------------
var bare:TextFormat = new TextFormat();
check(bare.size == null && bare.color == null && bare.font == null, "bare: size/color/font unset");
check(bare.bold == null && bare.leading == null && bare.align == null, "bare: bold/leading/align unset");
check(bare.display == "block", "bare: display is the one filled-in field");

// --- ② a fresh field's implicit default is a COMPLETE format -----------------
var tf:TextField = new TextField();
var dflt:TextFormat = tf.defaultTextFormat;
check(dflt.size == 12, "implicit default size 12, got " + dflt.size);
check(dflt.color == 0, "implicit default color 0, got " + dflt.color);
check(dflt.bold == false && dflt.italic == false && dflt.underline == false, "implicit default bold/italic/underline false");
check(dflt.leading == 0, "implicit default leading 0, got " + dflt.leading);
check(dflt.align == "left", "implicit default align left, got " + dflt.align);
check(dflt.leftMargin == 0 && dflt.rightMargin == 0 && dflt.indent == 0, "implicit default margins/indent 0");
check(dflt.display == "block", "implicit default display block");
check(dflt.url == "" && dflt.target == "", "implicit default url/target empty strings");
check(dflt.tabStops != null && dflt.tabStops.length == 0, "implicit default tabStops empty array");

// --- ③ the getter returns a COPY --------------------------------------------
check(tf.defaultTextFormat !== tf.defaultTextFormat, "two getter reads must not be the same object");
var copy:TextFormat = tf.defaultTextFormat;
copy.size = 40;
check(tf.defaultTextFormat.size == 12, "mutating the getter's copy must not change the field, got " + tf.defaultTextFormat.size);

// --- ④ an all-null assignment is a no-op ------------------------------------
tf.defaultTextFormat = new TextFormat("_sans", 20, 0xFF0000, true, true, true);
tf.defaultTextFormat = new TextFormat();
var kept:TextFormat = tf.defaultTextFormat;
check(kept.size == 20 && kept.color == 0xFF0000, "an all-null format must keep size/color, got " + kept.size + "/" + kept.color);
check(kept.font == "_sans" && kept.bold == true && kept.italic == true, "an all-null format must keep font/bold/italic");

// --- ⑤ a partial assignment changes only what it names ----------------------
var onlySize:TextFormat = new TextFormat();
onlySize.size = 30;
tf.defaultTextFormat = onlySize;
kept = tf.defaultTextFormat;
check(kept.size == 30, "partial size must apply, got " + kept.size);
check(kept.color == 0xFF0000 && kept.font == "_sans" && kept.bold == true, "partial size must keep the other fields, got " + kept.color + "/" + kept.font);

var onlyColor:TextFormat = new TextFormat();
onlyColor.color = 0x00FF00;
tf.defaultTextFormat = onlyColor;
kept = tf.defaultTextFormat;
check(kept.color == 0x00FF00 && kept.size == 30, "partial color must keep size, got " + kept.size);

// An EXPLICIT null is the same as an omitted field.
var nullOut:TextFormat = new TextFormat();
nullOut.size = null;
nullOut.font = null;
tf.defaultTextFormat = nullOut;
kept = tf.defaultTextFormat;
check(kept.size == 30 && kept.font == "_sans", "explicit null must keep the value, got " + kept.size + "/" + kept.font);

// --- ⑥ null is rejected, both setter entry points ---------------------------
var threw:int = 0;
try { tf.defaultTextFormat = null; } catch (e:Error) { threw = e.errorID; }
check(threw == 2007, "defaultTextFormat = null must throw #2007, got " + threw);
threw = 0;
try { tf.setTextFormat(null, 0, 1); } catch (e:Error) { threw = e.errorID; }
check(threw == 2007, "setTextFormat(null) must throw #2007, got " + threw);

// --- ⑦ setTextFormat merges against the run at `begin` ----------------------
var rf:TextField = new TextField();
rf.text = "abcdef";
var red:TextFormat = new TextFormat(null, 20, 0xFF0000);
rf.setTextFormat(red, 0, 4);
var blue:TextFormat = new TextFormat();
blue.color = 0x0000FF;
rf.setTextFormat(blue, 1, 2);
var inside:TextFormat = rf.getTextFormat(1, 2);
check(inside.size == 20 && inside.color == 0x0000FF, "a colour-only format over a 20px run keeps 20px, got " + inside.size + "/" + inside.color);
var neighbour:TextFormat = rf.getTextFormat(3, 4);
check(neighbour.size == 20 && neighbour.color == 0xFF0000, "the rest of the run keeps red, got " + neighbour.color);
var outside:TextFormat = rf.getTextFormat(4, 6);
check(outside.size == 12, "text outside the run keeps the default size, got " + outside.size);

// --- ⑧ the format is bound at insertion time --------------------------------
var ins:TextField = new TextField();
ins.text = "abc";
var big:TextFormat = new TextFormat(null, 30, 0x000000);
ins.defaultTextFormat = big;
check(ins.defaultTextFormat.size == 30, "the assignment itself lands, got " + ins.defaultTextFormat.size);
check(ins.getTextFormat(0, 1).size == 12, "existing text must NOT be re-formatted, got " + ins.getTextFormat(0, 1).size);
ins.text = "abc";
check(ins.getTextFormat(0, 1).size == 30, "re-assigning .text applies the new default, got " + ins.getTextFormat(0, 1).size);

// --- ⑨ appendText: preceding character's format + the default follows index 0 -
var ap:TextField = new TextField();
ap.text = "ab";
var apRed:TextFormat = new TextFormat("_sans", 12, 0xFF0000);
ap.setTextFormat(apRed, 0, 2);
ap.appendText("cd");
check(ap.text == "abcd", "appendText must concatenate, got '" + ap.text + "'");
check(ap.getTextFormat(2, 3).color == 0xFF0000, "appended text must inherit the preceding format, got " + ap.getTextFormat(2, 3).color);
check(ap.defaultTextFormat.color == 0xFF0000, "appendText moves defaultTextFormat to the index-0 format, got " + ap.defaultTextFormat.color);

// Appending to a field whose dtf was moved but whose text was not: the appended
// characters follow the TEXT's format, and dtf snaps back to it (adl case P4).
var ap2:TextField = new TextField();
ap2.text = "ab";
ap2.defaultTextFormat = new TextFormat("_sans", 30, 0x00FF00);
ap2.appendText("cd");
check(ap2.getTextFormat(2, 3).size == 12, "appended text follows the text, not dtf, got " + ap2.getTextFormat(2, 3).size);
check(ap2.defaultTextFormat.size == 12, "appendText snaps dtf to the index-0 format, got " + ap2.defaultTextFormat.size);

trace("textformat-merge: unset/merge/copy/bind-at-insertion OK");