// Capabilities.language / Capabilities.languages (D1).
//
// AIR reports the SYSTEM UI language as a BCP-47 tag, not the process locale:
// measured on adl 51.4.1 / macOS 26.6.2 the process LANG is "en_US.UTF-8" while
// Capabilities.language is "zh-CN" and Capabilities.languages is ["zh-CN"]. We
// used to read LANG and cut it to two letters, so a program comparing against the
// exact "zh-CN" (TalkMED's cn.edoctor.utils.Language.as) always fell back to
// English.
//
// The assertions below are the AIR contract and hold on any machine, so this runs
// everywhere instead of only on a zh-CN host:
//   - `language` is "xx" or "xx-YY" (the script subtag is dropped: an AppleLanguages
//     of ["zh-Hans-CN"] reports "zh-CN");
//   - a region subtag is upper-cased;
//   - `languages` is non-empty and languages[0] === language.
import flash.system.Capabilities;

function fail(what: String): void {
  throw new Error("capabilities: " + what);
}

var lang:String = Capabilities.language;
var langs:Array = Capabilities.languages;
trace("language=[" + lang + "]");
trace("languages=[" + langs.join(",") + "]");

if (lang == null || lang.length < 2) fail("language is not a language tag: " + lang);
var first:String = lang.charAt(0);
if (first < "a" || first > "z") fail("language does not start with a letter: " + lang);

var dash:int = lang.indexOf("-");
if (dash >= 0) {
  // "xx-YY": exactly one region subtag, two upper-case characters (zh-CN, en-US).
  if (lang.length != dash + 3) fail("language is not xx-YY shaped: " + lang);
  var region:String = lang.substring(dash + 1);
  if (region != region.toUpperCase()) fail("the region subtag is not upper-cased: " + lang);
} else if (lang.length != 2) {
  fail("language is neither xx nor xx-YY shaped: " + lang);
}

if (langs == null || langs.length < 1) fail("languages is empty");
if (langs[0] != lang) fail("languages[0] (" + langs[0] + ") != language (" + lang + ")");

trace("capabilities ok");
