// Stage 331: AIR's full TextFormat member table and 13-argument constructor.
//
// Two separate defects, both measured against adl 51.4.1 (temp/implicit/Main.as,
// same source compiled by mxmlc and by us, read back in one pass):
//
// ① The member table stopped at 12 fields, so AIR-legal code using url/target/
//    indent/blockIndent/bullet/display/tabStops failed to COMPILE here
//    ("undefined field 'indent' on class 'TextFormat'").
// ② The constructor took 6 parameters in a different ORDER. AIR's 6th parameter
//    is `underline`; ours was `leading`, so `new TextFormat(f, 12, 0, false,
//    false, 8)` meant two different things in the two compilers -- and AIR's
//    reading (underline = 8) is the one that has to win.
//
// The zero-argument form and the field-by-field merge it feeds were finished in
// 阶段三百三十五 (see examples/textformat-merge.as); ④ below pins the part that
// belongs to this member table.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// ① The 13-argument form, in AIR's order, field by field.
var f:TextFormat = new TextFormat("_typewriter", 14, 0xFF0000, true, true, true,
                                  "http://example.com", "_blank", "center", 3, 4, 5, 6);
check(f.font == "_typewriter", "font");
check(f.size == 14, "size");
check(f.color == 0xFF0000, "color");
check(f.bold == true && f.italic == true && f.underline == true, "bold/italic/underline");
check(f.url == "http://example.com", "url");
check(f.target == "_blank", "target");
check(f.align == "center", "align");
check(f.leftMargin == 3 && f.rightMargin == 4, "left/right margin");
check(f.indent == 5, "indent");
check(f.leading == 6, "leading (the 13th parameter, not the 6th)");

// ② The fields that only exist in the member table.
f.blockIndent = 9;
f.bullet = true;
f.display = "block";
f.tabStops = [10, 20];
check(f.blockIndent == 9, "blockIndent");
check(f.bullet == true, "bullet");
check(f.display == "block", "display");
check(f.tabStops.length == 2 && f.tabStops[1] == 20, "tabStops");

// ③ The 6th positional argument is `underline`: passing 8 there sets underline,
//    and `leading` stays UNSET (null, not 0) -- AIR's constructor leaves every
//    omitted field null, and a null field means "keep the current value" when the
//    format is installed (阶段三百三十五). This is the mapping AIR uses, so a
//    program that means "leading 8" must say so.
var six:TextFormat = new TextFormat("_typewriter", 12, 0x000000, false, false, 8);
check(six.underline == true, "the 6th argument is underline (AIR order)");
check(six.leading == null, "leading is untouched by the 6th argument");

// ④ A zero-argument format is ALL NULL apart from `display` -- measured on adl
//    51.4.1 (temp/tfc2/Main.as, case E0). This is what makes the merge in ⑤
//    meaningful: an unset field carries no opinion.
var bare:TextFormat = new TextFormat();
check(bare.font == null && bare.size == null && bare.color == null, "bare: font/size/color unset");
check(bare.bold == null && bare.italic == null && bare.underline == null, "bare: bold/italic/underline unset");
check(bare.leading == null && bare.kerning == null && bare.letterSpacing == null, "bare: leading/kerning/letterSpacing unset");
check(bare.align == null && bare.leftMargin == null && bare.rightMargin == null, "bare: align/margins unset");
check(bare.indent == null && bare.blockIndent == null && bare.bullet == null, "bare: indent/blockIndent/bullet unset");
check(bare.url == null && bare.target == null && bare.tabStops == null, "bare: url/target/tabStops unset");
check(bare.display == "block", "bare: display is the one field AIR fills in");

trace("textformat-members: OK");