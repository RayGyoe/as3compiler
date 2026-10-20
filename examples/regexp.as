// regexp: RegExp engine + String.match/search/replace (v0.3.23).

// --- test() (bool) ---
trace(/^a+$/.test("aaa") == true);       // true
trace(/^a+$/.test("baa") == false);      // true

// --- exec() with capture groups ---
var r:RegExp = /(\d+)-(\d+)/;
var m = r.exec("abc-123-45");
trace(m != null);                         // true
trace(m[0] == "123-45");                  // true
trace(m[1] == "123");                     // true
trace(m[2] == "45");                      // true

// --- exec() no match returns null ---
trace(/z/.exec("abc") == null);           // true

// --- global flag drives lastIndex ---
var g:RegExp = /\d/g;
trace(g.test("a1b2"));                    // true
trace(g.lastIndex == 2);                  // true
trace(g.test("a1b2"));                    // true
trace(g.lastIndex == 4);                  // true
trace(g.test("a1b2"));                    // false
trace(g.lastIndex == 0);                  // true (reset after failure)

// --- String.match: global collects all matches ---
var digits = "a1b22c333".match(/\d+/g);
trace(digits.length == 3);                // true
trace(digits[0] == "1");                  // true
trace(digits[1] == "22");                 // true
trace(digits[2] == "333");                // true

// --- String.match: non-global returns full match + captures ---
var single = "hello".match(/l(l)/);
trace(single[0] == "ll");                 // true
trace(single[1] == "l");                  // true
trace("xyz".match(/\d/) == null);         // true

// --- String.search returns first match index ---
trace("abc123".search(/\d+/) == 3);       // true
trace("abc".search(/\d/) == -1);          // true

// --- String.replace with $& and $1 ---
trace("a1b2".replace(/\d/, "X") == "aXb2");    // true
trace("a1b2".replace(/\d/g, "X") == "aXbX");   // true
trace("John Smith".replace(/(\w+) (\w+)/, "$2, $1") == "Smith, John");  // true
trace("cat".replace(/c/, "[$&]") == "[c]at");  // true

// --- character classes, quantifiers, alternation ---
trace(/[a-c]+/.test("abccba") == true);   // true
trace(/colou?r/.test("color") == true);   // true
trace(/colou?r/.test("colour") == true);  // true
trace(/cat|dog/.test("hotdog") == true);  // true

// --- backreference ---
trace(/(\w)\1/.test("hello") == true);    // true ("ll")
trace(/(\w)\1/.test("world") == false);   // true

// --- lookahead ---
trace(/foo(?=bar)/.test("foobar") == true);   // true
trace(/foo(?=bar)/.test("foobaz") == false);  // true
trace(/foo(?!bar)/.test("foobaz") == true);   // true

// --- flags: ignoreCase, dotall, multiline ---
trace(/abc/i.test("AbC") == true);            // true
trace(/a.b/.test("a\nb") == false);           // true (dot excludes newline)
trace(/a.b/s.test("a\nb") == true);           // true (dotall)
trace(/^b/m.test("a\nb") == true);            // true (multiline ^)

// --- extended (x) flag: whitespace and # comments are ignored ---
trace(/a b c/x.test("abc") == true);          // true
trace(/\d+  # one or more digits/x.test("123") == true);  // true

// --- RegExp constructor + source/flags ---
var c:RegExp = new RegExp("ab+", "g");
trace(c.source == "ab+");                     // true
trace(c.global == true);                      // true
trace(c.test("xabbby"));                      // true

// --- lazy quantifier: match as few as possible ---
trace("aaa".replace(/a+?/, "X") == "Xaa");    // true (lazy: one 'a')

// --- bounded quantifier {n,m} ---
trace(/a{2,3}/.test("aa") == true);           // true
trace(/a{2,3}/.test("aaaa") == true);         // true (matches first 3)
trace(/a{2,3}/.test("a") == false);           // true

// --- an uncompilable pattern is INERT, not an error ---
// AVM2 compiles the pattern in RegExpObject::completeInitialization and drops the
// reported error (core/RegExp.cpp writes it to *errorptr; nobody reads it), so the
// object survives with no compiled program: exec -> null, test -> false, and
// String.replace/match/search behave as "no match". ES3 says SyntaxError, AIR
// does not, and talkmed-meeting relies on that (sqliteEscape builds
// new RegExp("[") on every real-time-translation sentence).
var threw:Boolean = false;
var bad:RegExp = null;
var badSquare:RegExp = null;
try {
  bad = new RegExp("(");
  badSquare = new RegExp("[");
} catch (e:Error) {
  threw = true;
}
trace(threw == false);                          // true -- AIR does not throw
trace(bad != null);                             // true -- the object exists
trace(bad.source == "(");                       // true -- source stays verbatim
trace(bad.test("(") == false);                  // true -- never matches
trace(bad.exec("(") == null);                   // true
trace("a(b".replace(bad, "X") == "a(b");      // true -- replace is a no-op
trace("a(b".replace(badSquare, "X") == "a(b"); // true
trace("a(b".search(bad) == -1);                   // true
trace("a(b".match(bad) == null);                  // true
trace(badSquare.test("x[") == false);           // true
// A stray ')' is a compile error in PCRE2 (unmatched closing parenthesis), so the
// regex is inert -- it must NOT collapse into "match the empty string everywhere",
// which is what a sequence compiler that silently stops at the ')' would do.
var badParen:RegExp = new RegExp(")");
trace(badParen.test("a)b") == false);           // true
trace("a)b".replace(badParen, "X") == "a)b");   // true
trace(badParen.exec("a)b") == null);             // true
// ...but a lone ']' OUTSIDE a character class is an ordinary literal in PCRE2, so
// it does match: do not over-inert the pattern.
trace("a]b".replace(new RegExp("]"), "X") == "aXb");  // true

// --- String.replace with repl:Function ---
// An AIR replacer Function always receives (match, [groups...], offset, wholeString);
// a shorter signature raises #1063 (measured on adl 51.4.1, temp/pkgA/rep).
trace("abc".replace(/b/, function(match:String, offset:int, input:String):String { return "X"; }) == "aXc");  // true
trace("a1b2".replace(/\d/g, function(match:String, offset:int, input:String):String { return "(" + match + ")"; }) == "a(1)b(2)");  // true
trace("John Smith".replace(/(\w+) (\w+)/, function(match:String, first:String, last:String, offset:int, whole:String):String { return last + ", " + first; }) == "Smith, John");  // true
trace("abc".replace(/b/, function(match:String, offset:int, input:String):String { return "[" + input + "@" + offset + "]"; }) == "a[abc@1]c");  // true
