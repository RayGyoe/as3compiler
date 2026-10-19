// Capabilities.language / Capabilities.languages: AIR's UI-language contract.
//
// `language` is NOT a locale tag — it is a closed set: a lowercase ISO 639-1 code,
// with an ISO 3166 region appended for Chinese only (zh-CN / zh-TW), and "xu" for
// anything outside AIR's own table. `languages` is the OS's preferred UI language
// list as RFC 4646 tags ("en-US"), most preferred first.
//
// The two used to be conflated: we read the process LANG and cut it to two
// letters, so on Windows (LANG unset, or whatever the shell exported) it always
// answered "en" — and a program that switches to English unless
// Capabilities.language == "zh-CN" then showed English copy on a Chinese machine.
//
// The assertions below are the AIR contract and hold on ANY machine, so this runs
// everywhere instead of only on a zh-CN host:
//   - `language` is "xx", "zh-CN" / "zh-TW", or "xu" (see as_cap_air_langs);
//   - a Chinese language is one of exactly those two values, and its region is
//     upper-cased; no other language carries a region;
//   - `languages` is non-empty and every entry is dash-delimited (never "en_US");
//   - languages[0] shares `language`'s PRIMARY language, which is the relation AIR
//     documents ("generally has the same primary language ID") — NOT equality: an
//     en-US host reports "en" for `language` and "en-US" for languages[0].
import flash.system.Capabilities;

function fail(what: String): void {
  throw new Error("capabilities: " + what);
}

function primaryOf(tag:String): String {
  var dash:int = tag.indexOf("-");
  return dash < 0 ? tag : tag.substring(0, dash);
}

var lang:String = Capabilities.language;
var langs:Array = Capabilities.languages;
trace("language=[" + lang + "]");
trace("languages=[" + langs.join(",") + "]");

if (lang == null || lang.length < 2) fail("language is not a language value: " + lang);
var first:String = lang.charAt(0);
if (first < "a" || first > "z") fail("language does not start with a lowercase letter: " + lang);

var primary:String = primaryOf(lang);
var dash:int = lang.indexOf("-");
if (dash >= 0) {
  // Only Chinese carries a region in AIR's table, and only CN / TW exist for it.
  if (primary != "zh") fail("only Chinese carries a region: " + lang);
  if (lang != "zh-CN" && lang != "zh-TW") fail("a Chinese language must be zh-CN or zh-TW: " + lang);
  if (lang.length != dash + 3) fail("language is not xx-YY shaped: " + lang);
  var region:String = lang.substring(dash + 1);
  if (region != region.toUpperCase()) fail("the region subtag is not upper-cased: " + lang);
} else if (lang.length != 2) {
  fail("language is neither xx nor xx-YY shaped: " + lang);
}

if (langs == null || langs.length < 1) fail("languages is empty");
for (var i:int = 0; i < langs.length; i++) {
  var tag:String = String(langs[i]);
  if (tag == null || tag.length < 2) fail("languages[" + i + "] is empty");
  if (tag.indexOf("_") >= 0) fail("languages[" + i + "] must be dash-delimited: " + tag);
  var c0:String = tag.charAt(0);
  var c1:String = tag.charAt(1);
  if (c0 < "a" || c0 > "z" || c1 < "a" || c1 > "z") {
    fail("languages[" + i + "] does not start with a 2-letter language: " + tag);
  }
}

// AIR reports "xu" (other/unknown) for a language outside its table and then
// points callers at languages[0]; every other value must agree with the head of
// the list on the primary language.
if (lang != "xu") {
  var head:String = String(langs[0]);
  if (primaryOf(head) != primary) {
    fail("languages[0] (" + head + ") and language (" + lang + ") disagree on the primary language");
  }
}

trace("capabilities ok");
