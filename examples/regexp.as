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

// --- invalid regex throws SyntaxError ---
var caught:Boolean = false;
try {
  new RegExp("(");
} catch (e:SyntaxError) {
  caught = true;
}
trace(caught);                                 // true

// --- String.replace with repl:Function ---
trace("abc".replace(/b/, function(match:String):String { return "X"; }) == "aXc");  // true
trace("a1b2".replace(/\d/g, function(match:String):String { return "(" + match + ")"; }) == "a(1)b(2)");  // true
trace("John Smith".replace(/(\w+) (\w+)/, function(match:String, first:String, last:String):String { return last + ", " + first; }) == "Smith, John");  // true
trace("abc".replace(/b/, function(match:String, offset:int, input:String):String { return "[" + input + "@" + offset + "]"; }) == "a[abc@1]c");  // true
