// stage34.as — flash.display display list: DisplayObject / Container / Stage / Sprite.

var s:Sprite = new Sprite();
var c:Sprite = new Sprite();
c.name = "child";
s.addChild(c);

trace("parent set:", c.parent == s);            // true
trace("numChildren:", s.numChildren == 1);      // true
trace("stage non-null:", c.stage != null);      // true (root acts as stage)
trace("root is s:", c.root == s);               // true
trace("getChildAt:", s.getChildAt(0) == c);     // true
trace("getChildByName:", s.getChildByName("child") == c); // true
trace("contains:", s.contains(c));              // true

// default transform properties.
trace("visible default:", c.visible);           // true
trace("alpha default:", c.alpha == 1.0);        // true
trace("scale default:", c.scaleX == 1.0 && c.scaleY == 1.0); // true

// multi-child depth order + setChildIndex.
var a:Sprite = new Sprite();
var b:Sprite = new Sprite();
var c2:Sprite = new Sprite();
s.addChild(a); s.addChild(b); s.addChild(c2);
trace("order0:", s.getChildAt(0) == c);         // true (child added first)
trace("order1:", s.getChildAt(1) == a);         // true
trace("order2:", s.getChildAt(2) == b);         // true
s.setChildIndex(b, 0);
trace("after reorder:", s.getChildAt(0) == b);  // true

// removeChild / removeChildAt reset parent.
s.removeChild(a);
trace("removed:", !s.contains(a) && a.parent == null); // true
var removed:Sprite = s.removeChildAt(0);
trace("removedAt:", removed == b && b.parent == null); // true

// nested containers: root walks to the topmost ancestor.
var outer:Sprite = new Sprite();
var inner:Sprite = new Sprite();
outer.addChild(inner);
s.addChild(outer);
trace("nested root:", inner.root == s);         // true
trace("nested parent:", inner.parent == outer); // true
trace("nested stage:", inner.stage == s);       // true
