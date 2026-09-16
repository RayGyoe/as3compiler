// stage58.as — flash.geom 2D value types (v0.3.59): Point / Rectangle / Matrix /
// ColorTransform / Transform.
//
// These are reference types in AS3 (new Point() returns an object), modeled in C
// as gc_alloc'd structs with `double` fields. add/subtract/intersection/union/
// clone return NEW objects; offset/normalize/inflate/concat/invert mutate `this`.

function near(a:Number, b:Number):Boolean { return Math.abs(a - b) < 0.000001; }
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- Point ---
var p:Point = new Point(3, 4);
check(near(p.length, 5), "Point.length sqrt(3^2+4^2)");
check(near(Point.distance(new Point(0, 0), new Point(6, 8)), 10), "Point.distance");
check(near(Point.distance(Point(0, 0), Point(6, 8)), 10), "Point.distance (no-new)");

var a:Point = new Point(1, 2);
var b:Point = new Point(3, 4);
check(a.add(b).equals(new Point(4, 6)), "Point.add returns new");
check(a.subtract(b).equals(new Point(-2, -2)), "Point.subtract returns new");
check(a.equals(new Point(1, 2)), "add/subtract do not mutate this");

// interpolate: f closer to 1 -> closer to pt1 (AS3 quirk); midpoint at f=0.5.
var mid:Point = Point.interpolate(new Point(0, 0), new Point(10, 10), 0.5);
check(near(mid.x, 5) && near(mid.y, 5), "Point.interpolate midpoint");
check(Point.interpolate(new Point(0, 0), new Point(10, 0), 1).equals(new Point(0, 0)), "interpolate f=1 -> pt1");

var pol:Point = Point.polar(2, 0);
check(near(pol.x, 2) && near(pol.y, 0), "Point.polar");

var n:Point = new Point(3, 4);
n.normalize(10);
check(near(n.length, 10), "Point.normalize");
n.setTo(7, 8);
check(n.equals(new Point(7, 8)), "Point.setTo");
n.copyFrom(new Point(9, 10));
check(n.equals(new Point(9, 10)), "Point.copyFrom");
check(new Point(1, 2).clone().equals(new Point(1, 2)), "Point.clone");
check(p.toString() == "(x=3, y=4)", "Point.toString");

// --- Rectangle ---
var r:Rectangle = new Rectangle(0, 0, 100, 50);
check(near(r.top, 0) && near(r.left, 0), "Rectangle top/left");
check(near(r.bottom, 50) && near(r.right, 100), "Rectangle bottom/right");
check(!r.isEmpty(), "Rectangle not empty");

var r2:Rectangle = new Rectangle(10, 10, 100, 100);
check(r.intersects(r2), "Rectangle.intersects");
check(new Rectangle(0, 0, 10, 10).intersects(new Rectangle(5, 5, 10, 10)), "intersects overlap");
check(!new Rectangle(0, 0, 10, 10).intersects(new Rectangle(20, 20, 10, 10)), "intersects disjoint");

check(r.contains(50, 25), "Rectangle.contains");
check(r.containsPoint(new Point(1, 1)), "Rectangle.containsPoint");
check(!r.containsPoint(new Point(200, 200)), "Rectangle.containsPoint out");
check(r.containsRect(new Rectangle(10, 10, 20, 20)), "Rectangle.containsRect");

var inter:Rectangle = r.intersection(new Rectangle(50, 0, 100, 50));
check(inter.equals(new Rectangle(50, 0, 50, 50)), "Rectangle.intersection");
var uni:Rectangle = r.union(new Rectangle(50, 0, 100, 50));
check(uni.equals(new Rectangle(0, 0, 150, 50)), "Rectangle.union");

var inf:Rectangle = new Rectangle(10, 10, 20, 20);
inf.inflate(5, 5);
check(inf.equals(new Rectangle(5, 5, 30, 30)), "Rectangle.inflate");
inf.offset(1, 2);
check(near(inf.x, 6) && near(inf.y, 7), "Rectangle.offset");
check(r.clone().equals(r), "Rectangle.clone");

var e:Rectangle = new Rectangle(1, 2, 3, 4);
e.setEmpty();
check(e.isEmpty() && near(e.x, 0) && near(e.width, 0), "Rectangle.setEmpty/isEmpty");

// --- Matrix ---
var m:Matrix = new Matrix();
check(near(m.a, 1) && near(m.d, 1) && near(m.tx, 0) && near(m.ty, 0), "Matrix identity default");

m.translate(10, 20);
check(near(m.tx, 10) && near(m.ty, 20), "Matrix.translate");

var tpt:Point = m.transformPoint(new Point(1, 1));
check(near(tpt.x, 11) && near(tpt.y, 21), "Matrix.transformPoint (translate)");

var rot:Matrix = new Matrix();
rot.rotate(Math.PI / 2);
var rotp:Point = rot.transformPoint(new Point(1, 0));
check(near(rotp.x, 0) && near(rotp.y, 1), "Matrix.rotate 90deg");

var inv:Matrix = new Matrix();
inv.translate(10, 20);
inv.invert();
var back:Point = inv.transformPoint(new Point(10, 20));
check(near(back.x, 0) && near(back.y, 0), "Matrix.invert");

var sc:Matrix = new Matrix();
sc.scale(2, 3);
var scp:Point = sc.transformPoint(new Point(1, 1));
check(near(scp.x, 2) && near(scp.y, 3), "Matrix.scale");

var c1:Matrix = new Matrix();
c1.translate(1, 2);
var c2:Matrix = new Matrix();
c2.translate(10, 20);
c1.concat(c2);
var ccp:Point = c1.transformPoint(new Point(0, 0));
check(near(ccp.x, 11) && near(ccp.y, 22), "Matrix.concat");

var box:Matrix = new Matrix();
box.createBox(2, 3, 0, 5, 6);
var bp:Point = box.transformPoint(new Point(1, 1));
check(near(bp.x, 7) && near(bp.y, 9), "Matrix.createBox");

var idm:Matrix = new Matrix();
idm.translate(50, 60);
idm.identity();
check(near(idm.a, 1) && near(idm.tx, 0), "Matrix.identity");

// --- ColorTransform ---
var ct:ColorTransform = new ColorTransform();
check(near(ct.redMultiplier, 1) && near(ct.greenMultiplier, 1) && near(ct.blueMultiplier, 1) && near(ct.alphaMultiplier, 1), "ColorTransform multipliers default 1");
check(near(ct.redOffset, 0) && near(ct.blueOffset, 0) && near(ct.alphaOffset, 0), "ColorTransform offsets default 0");

var cta:ColorTransform = new ColorTransform(2, 1, 1, 1, 10, 0, 0, 0);
var ctb:ColorTransform = new ColorTransform(1, 1, 1, 1, 5, 0, 0, 0);
cta.concat(ctb);
check(near(cta.redMultiplier, 2) && near(cta.redOffset, 20), "ColorTransform.concat");

// --- Transform (holder: identity matrix + color transform) ---
var tr:Transform = new Transform();
check(tr.matrix != null && tr.colorTransform != null, "Transform matrix/colorTransform non-null");
check(near(tr.matrix.a, 1) && near(tr.colorTransform.redMultiplier, 1), "Transform identity defaults");

trace("stage58: all flash.geom assertions passed");
