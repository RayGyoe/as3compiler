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

// --- DisplayObject.transform wiring (Transform.matrix applied to the Skia canvas) ---
var s:Stage = new Stage();
var sp:Shape = new Shape();
sp.graphics.beginFill(0x00CC00, 1.0);
sp.graphics.drawRect(0, 0, 50, 50);
sp.graphics.endFill();
// transform defaults to an identity matrix (Transform holder, unit matrix)
check(sp.transform != null, "DisplayObject.transform non-null");
check(near(sp.transform.matrix.a, 1) && near(sp.transform.matrix.d, 1) && near(sp.transform.matrix.tx, 0), "transform identity default");
// AIR's Transform.matrix getter hands back a *copy*: mutating the returned
// Matrix does not reach the DisplayObject, so the portable way to change the
// transform is get → mutate → set back. (Verified against adl; see the
// transform.matrix section of docs/zh-cn/as3-semantics.md.)
var copy:Matrix = sp.transform.matrix;
copy.tx = 999;
check(near(sp.transform.matrix.tx, 0), "transform.matrix getter returns a copy");
var tm:Matrix = sp.transform.matrix;
tm.translate(30, 40);
sp.transform.matrix = tm;
check(near(sp.transform.matrix.tx, 30) && near(sp.transform.matrix.ty, 40), "transform.matrix.translate read-back");
// The setter decomposes into the object's own x/y/rotation/scaleX/scaleY, so
// the fields move with the matrix (AIR keeps one transform, viewed two ways).
check(near(sp.x, 30) && near(sp.y, 40), "transform.matrix setter feeds x/y");
var sm:Matrix = sp.transform.matrix;
sm.scale(2, 2);
sp.transform.matrix = sm;
check(near(sp.transform.matrix.a, 2), "transform.matrix.scale read-back");

// Rotation is about the object's own origin, so the object moves and the artwork
// does not. Measured on adl 51.4.1: assigning get()->rotate(30deg) to a Shape at
// (90,18) leaves x=68.94228634059948, y=60.58845726811989, rotation=30.
var rsh:Shape = new Shape();
rsh.x = 90;
rsh.y = 18;
var rm:Matrix = rsh.transform.matrix;
rm.rotate(30 * Math.PI / 180);
rsh.transform.matrix = rm;
check(near(rsh.x, 68.94228634059948) && near(rsh.y, 60.58845726811989), "transform.matrix rotate moves x/y, not the artwork");
check(near(rsh.rotation, 30) && near(rsh.scaleX, 1) && near(rsh.scaleY, 1), "rotate decomposes to rotation 30 / unit scale");
check(near(rsh.transform.matrix.a, Math.cos(30 * Math.PI / 180)), "rotate read-back keeps the matrix");

// A skew is what rotation + scale cannot express, so it is kept in the residual
// rather than dropped. adl reports the same gauge (scaleY = hypot(0.4, 1)).
var ksh:Shape = new Shape();
ksh.x = 270;
ksh.y = 18;
var km:Matrix = ksh.transform.matrix;
km.c = 0.4;
ksh.transform.matrix = km;
check(near(ksh.x, 270) && near(ksh.y, 18), "skew setter leaves x/y alone");
check(near(ksh.scaleY, 1.0770329636405618), "skew folds into scaleY (adl gauge)");
check(near(ksh.transform.matrix.c, 0.4), "skew survives the round trip");

// Zero-determinant matrix: no unique decomposition, but it still round-trips.
// adl reports x=7, y=8, rotation 0, scaleX 0, scaleY 0 for this assignment.
var zsh:Shape = new Shape();
zsh.transform.matrix = new Matrix(0, 0, 0, 0, 7, 8);
check(near(zsh.x, 7) && near(zsh.y, 8), "singular matrix keeps x/y");
check(near(zsh.rotation, 0) && near(zsh.scaleX, 0) && near(zsh.scaleY, 0), "singular matrix decomposes to zero scale");
var zb:Matrix = zsh.transform.matrix;
check(near(zb.a, 0) && near(zb.b, 0) && near(zb.c, 0) && near(zb.d, 0) && near(zb.tx, 7) && near(zb.ty, 8), "singular matrix round-trips");

// A write used as a value is an ordinary property write in AIR, so it yields the
// assigned Matrix — including in a chain.
var vsh:Shape = new Shape();
var vm:Matrix = new Matrix(3, 0, 0, 3, 1, 2);
var vgot:Matrix = (vsh.transform.matrix = vm);
check(vgot == vm && near(vsh.x, 1) && near(vsh.scaleX, 3), "valued transform.matrix write yields the matrix");
var wsh:Shape = new Shape();
wsh.transform.matrix = vsh.transform.matrix = new Matrix(4, 0, 0, 4, 9, 10);
check(near(wsh.x, 9) && near(vsh.x, 9), "chained transform.matrix write reaches both targets");
s.addChild(sp);
s.render(100, 100, "stage58.png");

trace("stage58: all flash.geom assertions passed");
