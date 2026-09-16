// stage22: String remaining methods (v0.3.21): concat / fromCharCode /
// localeCompare / valueOf / toLocale{Upper,Lower}Case / startsWith / endsWith.

// --- concat (auto-stringifies non-string args) ---
trace("a".concat("b", "c") == "abc");       // true
trace("hello".concat(" ", "world") == "hello world"); // true
trace("num:".concat(42) == "num:42");       // true (int auto-boxed)

// --- String.fromCharCode (static) ---
trace(String.fromCharCode(65, 66) == "AB"); // true
trace(String.fromCharCode(72, 105) == "Hi"); // true

// --- localeCompare (simplified to strcmp) ---
trace("abc".localeCompare("abc") == 0);     // true
trace("abc".localeCompare("abd") < 0);      // true

// --- valueOf (identity) ---
trace("abc".valueOf() == "abc");            // true

// --- toLocale* (simplified to ASCII case) ---
trace("Hello".toLocaleLowerCase() == "hello"); // true
trace("hello".toLocaleUpperCase() == "HELLO"); // true

// --- startsWith / endsWith ---
trace("hello".startsWith("he"));            // true
trace("hello".endsWith("lo"));              // true
trace("hello".startsWith("el") == false);   // true
trace("hello".endsWith("he") == false);     // true
