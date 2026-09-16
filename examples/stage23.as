// stage23: Boolean.valueOf/toString, undefined, URI encode/decode (v0.3.22).

// --- Boolean methods ---
var t:Boolean = true;
trace(t.valueOf() == true);     // true
trace(t.toString() == "true");  // true
var f:Boolean = false;
trace(f.valueOf() == false);    // true
trace(f.toString() == "false"); // true

// --- undefined (global constant, boxed as_value tag 5) ---
trace(String(undefined) == "undefined");  // true

// --- URI encoding (encodeURIComponent escapes reserved chars too) ---
trace(encodeURIComponent("a b&c") == "a%20b%26c");  // true
trace(decodeURIComponent("a%20b") == "a b");        // true

// --- encodeURI keeps URI reserved characters ---
trace(encodeURI("a b&c") == "a%20b&c");             // true
trace(decodeURI("a%20b") == "a b");                 // true

// --- escape / unescape (legacy) ---
trace(escape("a b") == "a%20b");                    // true
trace(unescape("a%20b") == "a b");                  // true
