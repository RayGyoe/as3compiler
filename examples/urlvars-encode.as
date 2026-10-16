// urlvars-encode.as — URLVariables.toString(), the exact
// application/x-www-form-urlencoded form AIR produces (阶段一百五十三).
//
// Two defects lived here. (a) The escape set was the permissive "unreserved" set,
// keeping '-' '_' '.' '~' literal, while AIR encodes EVERY non-alphanumeric byte.
// (b) The destination buffer was sized from the RAW value length while up to 3x
// that many bytes were written -- a heap overflow that wrote past the GC string
// into the next block and corrupted the free list, which is what crashed the
// TalkMED desktop build on the SMS-code login tab (its device_info JSON blob is
// 159 raw bytes and encodes to 285). Every expectation below was measured on
// adl 51.4.1 against the same input (temp/uvarair/adl.txt).
//
// Only [A-Za-z0-9] stay literal; both halves of a pair are encoded, with
// UPPERCASE hex and one %XX per UTF-8 byte.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function enc(k:String, v:*):String { var u:URLVariables = new URLVariables(); u[k] = v; return u.toString(); }

check(new URLVariables().toString() == "", "an empty URLVariables is the empty string");
check(enc("a b", "c d") == "a%20b=c%20d", "a space is %20 in the key AND in the value");
check(enc("k&x", "1=2") == "k%26x=1%3D2", "'&' and '=' inside a pair are encoded, so they cannot split it");
check(enc("plus+", "a+b") == "plus%2B=a%2Bb", "'+' is %2B, never a literal plus");
check(enc("pct%", "%41") == "pct%25=%2541", "'%' is %25, so an encoded 'A' is not decoded here");
check(enc("h#", "?q") == "h%23=%3Fq", "'#' and '?' are encoded");
check(enc("sl/", "c:d") == "sl%2F=c%3Ad", "'/' and ':' are encoded");
check(enc("t~", "s_-.~") == "t%7E=s%5F%2D%2E%7E", "even '~' '_' '-' '.' are encoded -- alphanumeric only");
check(enc("uni你", "好") == "uni%E4%BD%A0=%E5%A5%BD", "non-ASCII becomes one %XX per UTF-8 byte, uppercase");

// The whole printable ASCII range in one value: exactly the alphanumerics survive.
var all:String = "";
for (var i:int = 32; i < 127; i++) { all += String.fromCharCode(i); }
check(enc("V", all) == "V=%20%21%22%23%24%25%26%27%28%29%2A%2B%2C%2D%2E%2F0123456789%3A%3B%3C%3D%3E%3F%40ABCDEFGHIJKLMNOPQRSTUVWXYZ%5B%5C%5D%5E%5F%60abcdefghijklmnopqrstuvwxyz%7B%7C%7D%7E",
  "printable ASCII: [A-Za-z0-9] literal, every other byte %XX");

// The short form of the payload the desktop app posts.
var v:URLVariables = new URLVariables();
v.device_info = "{\"brand\":\"unknown\",\"ratio\":\"1800x1169\"}";
check(v.toString() == "device%5Finfo=%7B%22brand%22%3A%22unknown%22%2C%22ratio%22%3A%221800x1169%22%7D",
  "a JSON blob survives encoding intact, key included");

// The full one: 159 raw bytes -> 285 encoded. Sizing the buffer from the raw
// length under-states the write by 126 bytes; if that ever comes back, the tail
// is what gets truncated or smashes the neighbouring block.
var w:URLVariables = new URLVariables();
w.device_info = "{\"brand\":\"unknown\",\"system\":\"Mac\",\"version\":\"OS\",\"uuid\":\"f6:24:43:df:4a:e3 \",\"architecture\":\"x86_64\",\"ratio\":\"1800x1169\",\"dpi\":72,\"touchs\":0,\"macAddress\":null}";
var s:String = w.toString();
check(w.device_info.length == 159, "the raw value is 159 bytes");
check(s.length == 285, "…and its encoded form is 285 -- about 1.8x, not 1x");
check(s.substr(0, 6) == "device", "the key is encoded too, starting with the raw alphanumerics");
check(s.substr(s.length - 26) == "%22macAddress%22%3Anull%7D", "…and the tail is complete");

// Non-String values go through their String form first.
var t:URLVariables = new URLVariables(); t.a = null;
check(t.toString() == "a=null", "null becomes the text null");
var t2:URLVariables = new URLVariables(); t2.n = 1.5;
check(t2.toString() == "n=1%2E5", "a number is formatted then encoded");
var t3:URLVariables = new URLVariables(); t3.b = true;
check(t3.toString() == "b=true", "a boolean becomes its String form");

trace("urlvars-encode: all checks passed");
