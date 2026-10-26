// clipboard.as -- flash.desktop.Clipboard and flash.system.System.setClipboard.
//
// 阶段二百九十三 turned Clipboard from an API-shape-only shell into a real class and
// implemented System.setClipboard. What this example pins is the part that holds on
// EVERY backend, because the example suite has no window backend:
//
//   * a `new Clipboard()` is a pure container: formats/setData/getData/
//     setDataHandler/clearData/clear all work with no operating system involved,
//     and it never sees what the system clipboard holds;
//   * Clipboard.generalClipboard is one object, and System.setClipboard(text) is
//     literally clear + setData(TEXT_FORMAT, text);
//   * the per-format contract from Clipboard.html: richText is a ByteArray,
//     cloneOnly answers null for an application-defined format but still answers
//     for the standard ones, and an unknown transferMode throws;
//   * a deferred handler set with setDataHandler renders on read;
//   * values survive a garbage collection (the three entry arrays are ordinary GC
//     fields of the object, and generalClipboard is a permanent root).
//
// The platform half -- text/html/richText/url reaching the real operating system
// clipboard -- is 95 % of the work but cannot be asserted here: this suite compiles
// without ASC_USE_WINDOW, so the seam is the no-op one. That half is measured
// separately on the real thing (temp/clip: four formats written, read back by
// PowerShell, another application's copy read through), see
// docs/zh-cn/desktop.md 7.10.
//
// Failures THROW: an example unit passes iff the process exits 0.
import flash.desktop.Clipboard;
import flash.desktop.ClipboardFormats;
import flash.desktop.ClipboardTransferMode;
import flash.system.System;
import flash.utils.ByteArray;

function check(what:String, ok:Boolean, detail:String = ""):void {
  if (!ok) throw new Error("clipboard: " + what + " failed: " + detail);
}

// ---- 1. new Clipboard() is a container, not the system clipboard -------------
var local:Clipboard = new Clipboard();
check("new is empty", local.formats.length == 0);
check("new has no text", !local.hasFormat(ClipboardFormats.TEXT_FORMAT));

check("setData returns true", local.setData(ClipboardFormats.TEXT_FORMAT, "hello"));
check("hasFormat after setData", local.hasFormat(ClipboardFormats.TEXT_FORMAT));
check("getData round-trip", (local.getData(ClipboardFormats.TEXT_FORMAT) as String) == "hello",
      String(local.getData(ClipboardFormats.TEXT_FORMAT)));
check("formats lists the format", local.formats.length == 1 && local.formats[0] == "text",
      local.formats.join(","));

// Same format twice replaces, it does not duplicate (Clipboard.html: the same
// information in more than one format, not two entries for one format).
local.setData(ClipboardFormats.TEXT_FORMAT, "second");
check("setData replaces", local.formats.length == 1
      && (local.getData(ClipboardFormats.TEXT_FORMAT) as String) == "second");

// ---- 2. multiple formats coexist --------------------------------------------
check("html accepted", local.setData(ClipboardFormats.HTML_FORMAT, "<b>hi</b>"));
check("two formats", local.formats.length == 2, local.formats.join(","));
check("clearData removes one", (local.clearData(ClipboardFormats.HTML_FORMAT),
       !local.hasFormat(ClipboardFormats.HTML_FORMAT)) && local.hasFormat(ClipboardFormats.TEXT_FORMAT));
check("one left", local.formats.length == 1);

// ---- 3. richText is a ByteArray (Clipboard.html type table) ------------------
var rtf:ByteArray = new ByteArray();
rtf.writeUTFBytes("{\\rtf1 pin}");
check("richText accepted", local.setData(ClipboardFormats.RICH_TEXT_FORMAT, rtf));
var back:ByteArray = local.getData(ClipboardFormats.RICH_TEXT_FORMAT) as ByteArray;
check("richText is a ByteArray", back != null && back is ByteArray);
// The default transfer mode hands back the ORIGINAL object, so the read starts
// where writeUTFBytes left the position -- reset it rather than assuming a copy.
back.position = 0;
check("richText bytes", back.readUTFBytes(back.length) == "{\\rtf1 pin}");

// ---- 4. transfer modes ------------------------------------------------------
// "The value must be one of the names defined in ClipboardTransferMode" and an
// unknown one throws (Clipboard.html getData throws Error).
var threw:Boolean = false;
try {
  local.getData(ClipboardFormats.TEXT_FORMAT, "notAMode");
} catch (e:Error) {
  threw = true;
}
check("unknown transferMode throws", threw);
// Standard formats: "a copy is always returned", so cloneOnly still answers.
check("standard cloneOnly answers",
      (local.getData(ClipboardFormats.TEXT_FORMAT, ClipboardTransferMode.CLONE_ONLY) as String) == "second");
// Application-defined format: only the original exists, so cloneOnly answers null
// while the default (originalPreferred) falls back to it.
local.setData("com.example.pin", "custom-value");
check("custom originalPreferred", (local.getData("com.example.pin") as String) == "custom-value");
check("custom cloneOnly is null",
      local.getData("com.example.pin", ClipboardTransferMode.CLONE_ONLY) == null);
check("custom hasFormat", local.hasFormat("com.example.pin"));

// ---- 5. deferred handler renders on read ------------------------------------
var renders:int = 0;
local.setDataHandler(ClipboardFormats.URL_FORMAT, function():String {
  renders++;
  return "https://example.com/" + renders;
});
check("handler renders", (local.getData(ClipboardFormats.URL_FORMAT) as String) == "https://example.com/1");
check("handler ran", renders == 1, String(renders));
// setData on the same format wins: "the handler function will never be called".
check("setData after handler", local.setData(ClipboardFormats.URL_FORMAT, "https://example.org/x"));
check("setData replaced handler", (local.getData(ClipboardFormats.URL_FORMAT) as String) == "https://example.org/x");

// ---- 6. clear ---------------------------------------------------------------
local.clear();
check("clear empties", local.formats.length == 0);

// ---- 7. generalClipboard + System.setClipboard ------------------------------
var g:Clipboard = Clipboard.generalClipboard;
check("generalClipboard is a singleton", g == Clipboard.generalClipboard);
check("generalClipboard supportsFilePromise is false", !g.supportsFilePromise);

System.setClipboard("system text 中文");
check("setClipboard has text", g.hasFormat(ClipboardFormats.TEXT_FORMAT));
check("setClipboard round-trip", (g.getData(ClipboardFormats.TEXT_FORMAT) as String) == "system text 中文",
      String(g.getData(ClipboardFormats.TEXT_FORMAT)));
check("setClipboard replaces", g.formats.length == 1, g.formats.join(","));

// A local Clipboard is not the system one: whatever it holds stays inside it.
check("local does not see system text", !local.hasFormat(ClipboardFormats.TEXT_FORMAT));

// System.setClipboard is clear + setData: an html entry added before it is gone.
g.setData(ClipboardFormats.HTML_FORMAT, "<i>x</i>");
check("html present", g.hasFormat(ClipboardFormats.HTML_FORMAT));
System.setClipboard("again");
check("setClipboard clears other formats", !g.hasFormat(ClipboardFormats.HTML_FORMAT)
      && (g.getData(ClipboardFormats.TEXT_FORMAT) as String) == "again");

// ---- 8. values survive a collection ----------------------------------------
System.gc();
check("text survives gc", (g.getData(ClipboardFormats.TEXT_FORMAT) as String) == "again");
g.setData("com.example.pin", "survivor");
System.gc();
check("custom format survives gc", (g.getData("com.example.pin") as String) == "survivor");
var handlerRan:Boolean = false;
g.setDataHandler("com.example.lazy", function():String {
  handlerRan = true;
  return "lazy";
});
System.gc();
check("handler survives gc", (g.getData("com.example.lazy") as String) == "lazy" && handlerRan);

g.clear();
check("clear empties the general clipboard", g.formats.length == 0 && !g.hasFormat(ClipboardFormats.TEXT_FORMAT));

trace("clipboard: ok");