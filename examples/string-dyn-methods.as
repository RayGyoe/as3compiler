// string-dyn-methods: String methods on a DYNAMICALLY typed receiver.
//
// A * / Object slot holding a String dispatches through as_any_call ->
// as_str_dyn_call, a different table from the statically typed String path in
// emit.ts. The dynamic table was missing the two methods AVM2 implements in
// AS3-land (core/String.as: prototype.toLowerCase = prototype.toLocaleLowerCase
// = ...) plus concat/localeCompare/startsWith/endsWith, so
// d.name.toLocaleLowerCase() answered null. Assigning that into a String slot and
// calling indexOf() on it then threw Error #1009 (null receiver) out of
// ShareWindowView.selectItemView -- which is what froze the app's 分享屏幕 window,
// because an uncaught error in a mouse handler reached exit(1) and hung in
// teardown. AIR lowercases and matches.
var d:Object = { sourceName: "MiXeD Case / WPS Office" };
var lower:String = d.sourceName.toLocaleLowerCase();
trace(lower == "mixed case / wps office");              // true
trace(lower.indexOf("wps office") == 13);               // true
// ...and the very next statement of the app, which is where #1009 used to fire.
trace(lower.indexOf("powerpoint") == -1);              // true

// toLocaleUpperCase is the same alias on the upper side.
trace(d.sourceName.toLocaleUpperCase() == "MIXED CASE / WPS OFFICE");  // true

// concat(...args) folds the receiver and every argument, auto-stringified; a null
// argument stringifies to "null" (ES3 ToString), never a crash.
trace(d.sourceName.concat("|", 1) == "MiXeD Case / WPS Office|1");   // true
var nil:* = null;
trace("a".concat(nil) == "anull");                     // true

// localeCompare / startsWith / endsWith on a dynamic receiver.
trace(d.sourceName.localeCompare("MiXeD Case / WPS Office") == 0);     // true
trace("Apple".localeCompare("Banana") < 0);           // true
trace(d.sourceName.startsWith("MiXeD"));              // true
trace(d.sourceName.endsWith("Office"));               // true
trace(d.sourceName.startsWith("Case"));               // false

// The whole String method surface, reached through a * reference.
var s:* = "MiXeD Case";
trace(s.length == 10);                                  // true
trace(s.charAt(1) == "i");                             // true
trace(s.charCodeAt(1) == 105);                          // true
trace(s.indexOf("Case") == 6);                         // true
trace(s.lastIndexOf("e") == 9);                        // true
trace(s.slice(1, 3) == "iX");                          // true
trace(s.substr(1, 3) == "iXe");                        // true
trace(s.substring(1, 3) == "iX");                      // true
trace(s.split(" ").length == 2);                       // true
trace(s.toLowerCase() == "mixed case");                // true
trace(s.toUpperCase() == "MIXED CASE");                // true
trace(s.toLocaleLowerCase() == "mixed case");          // true
trace(s.toLocaleUpperCase() == "MIXED CASE");          // true
trace(s.toString() == "MiXeD Case");                   // true
trace(s.valueOf() == "MiXeD Case");                    // true

// The statically typed path is unchanged (it never went through the dynamic table).
var t:String = "ABC";
trace(t.toLocaleLowerCase() == "abc");                 // true
trace(t.toLocaleUpperCase() == "ABC");                 // true
trace(t.concat("!") == "ABC!");                        // true
