// gc_name.as — DisplayObject.name has to survive a collection.
//
// `name` is an ordinary String slot on DisplayObject, so the collector must follow
// it. It carries its own property-table tag (13 instead of 3) because a *dynamic*
// write of null to a DisplayObject name throws TypeError #2007 while Error.name
// stores it -- but that tag exists for the WRITE side only. The marker's switch did
// not list 13, so the string was never greyed: the first collection that reached the
// object reclaimed it, and the freed block was handed straight to the next
// short-lived string. TalkMED's HomeView.clickTabList parses the clicked tab out of
// e.target.name ("b_0"/"b_1"/"b_2"), so after a few seconds of FPS-overlay string
// churn every tab click read a recycled string, indexed menuArray[0], and opened the
// "打开网页" tab's StageWebView -- "whatever I click, a web page opens".
//
// The churn below is what makes the bug loud: without the fix the name reads back as
// one of the freshly allocated "MS: N"/"ZZ: N" strings instead of "b_2".
//
// Compile: as-aot examples/gc_name.as --run

import flash.display.Sprite;
import flash.text.TextField;
import flash.system.System;

class Holder {
  public var nm:String = "held_" + 9;              // control: a plain String field
}

class Root {
  public static var tf:TextField;                  // statics are permanent GC roots
  public static var s:String;
  public static var h:Holder;
  public static var keep:Array = [];
}

Root.tf = new TextField();
Root.tf.name = "b_" + 2;
Root.s = "s_" + 3;
Root.h = new Holder();

// The display list keeps it alive independently of any local variable.
var host:Sprite = new Sprite();
host.addChild(Root.tf);

function churn(prefix:String):void {
  // 30k short-lived strings per round: the recycled block has to be handed to one
  // of these, otherwise a dangling name could accidentally still read correctly.
  for (var i:int = 0; i < 30000; i++) {
    var s:String = prefix + i;
    if (i % 997 == 0) Root.keep.push(s);
  }
}

var bad:Array = [];
function expect(label:String, got:String, want:String):void {
  if (got != want) bad.push("FAIL " + label + ": want [" + want + "] got [" + got + "]");
  else trace(label + " ok");
}

churn("MS: ");
System.gc();
expect("name survives the first collection", Root.tf.name, "b_2");
churn("ZZ: ");
System.gc();
expect("name survives the second collection", Root.tf.name, "b_2");

// The controls must keep working too (they always did -- they are what the broken
// object-name slot was silently compared against).
expect("plain String field is marked", Root.h.nm, "held_9");
expect("static String is marked", Root.s, "s_3");

// A rename must be seen the same way.
Root.tf.name = "renamed";
System.gc();
expect("a later rename is what the object reports", Root.tf.name, "renamed");

if (bad.length > 0) throw new Error(bad.join("\n"));
trace("gc_name: all assertions passed");
