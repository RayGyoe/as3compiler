package demo {
  import flash.geom.Point;
  import flash.geom.Rectangle;
  import flash.geom.Matrix;
  import flash.geom.ColorTransform;

  /**
   * Stage 58 — flash.geom 2D value/reference types.
   * Verifies Point / Rectangle / Matrix / ColorTransform / Transform against
   * the AS3 semantics implemented by as-aot (reference types, add/subtract
   * return new objects while offset/normalize mutate `this`).
   */
  public class GeometryDemos {
    public static function run():void {
      Log.out("");
      Log.out("--- Geometry (stage 58) ---");

      // --- Point ---
      var p:Point = new Point(3, 4);
      Assert.check(Assert.near(p.length, 5), "Point.length sqrt(3^2+4^2)");
      Assert.check(Assert.near(Point.distance(new Point(0, 0), new Point(6, 8)), 10), "Point.distance");

      var a:Point = new Point(1, 2);
      var b:Point = new Point(3, 4);
      Assert.check(a.add(b).equals(new Point(4, 6)), "Point.add returns new");
      Assert.check(a.subtract(b).equals(new Point(-2, -2)), "Point.subtract returns new");
      Assert.check(a.equals(new Point(1, 2)), "add/subtract do not mutate this");

      var mid:Point = Point.interpolate(new Point(0, 0), new Point(10, 10), 0.5);
      Assert.check(Assert.near(mid.x, 5) && Assert.near(mid.y, 5), "Point.interpolate midpoint");
      Assert.check(Point.interpolate(new Point(0, 0), new Point(10, 0), 1).equals(new Point(0, 0)), "interpolate f=1 -> pt1");

      var pol:Point = Point.polar(2, 0);
      Assert.check(Assert.near(pol.x, 2) && Assert.near(pol.y, 0), "Point.polar");

      var n:Point = new Point(3, 4);
      n.normalize(10);
      Assert.check(Assert.near(n.length, 10), "Point.normalize");
      n.setTo(7, 8);
      Assert.check(n.equals(new Point(7, 8)), "Point.setTo");
      n.copyFrom(new Point(9, 10));
      Assert.check(n.equals(new Point(9, 10)), "Point.copyFrom");
      Assert.check(new Point(1, 2).clone().equals(new Point(1, 2)), "Point.clone");
      Assert.check(p.toString() == "(x=3, y=4)", "Point.toString");

      // --- Rectangle ---
      var r:Rectangle = new Rectangle(0, 0, 100, 50);
      Assert.check(Assert.near(r.top, 0) && Assert.near(r.left, 0), "Rectangle top/left");
      Assert.check(Assert.near(r.bottom, 50) && Assert.near(r.right, 100), "Rectangle bottom/right");
      Assert.check(!r.isEmpty(), "Rectangle not empty");

      Assert.check(r.intersects(new Rectangle(10, 10, 100, 100)), "Rectangle.intersects");
      Assert.check(!new Rectangle(0, 0, 10, 10).intersects(new Rectangle(20, 20, 10, 10)), "intersects disjoint");

      Assert.check(r.contains(50, 25), "Rectangle.contains");
      Assert.check(r.containsPoint(new Point(1, 1)), "Rectangle.containsPoint");
      Assert.check(!r.containsPoint(new Point(200, 200)), "Rectangle.containsPoint out");
      Assert.check(r.containsRect(new Rectangle(10, 10, 20, 20)), "Rectangle.containsRect");

      var inter:Rectangle = r.intersection(new Rectangle(50, 0, 100, 50));
      Assert.check(inter.equals(new Rectangle(50, 0, 50, 50)), "Rectangle.intersection");
      var uni:Rectangle = r.union(new Rectangle(50, 0, 100, 50));
      Assert.check(uni.equals(new Rectangle(0, 0, 150, 50)), "Rectangle.union");

      var inf:Rectangle = new Rectangle(10, 10, 20, 20);
      inf.inflate(5, 5);
      Assert.check(inf.equals(new Rectangle(5, 5, 30, 30)), "Rectangle.inflate");
      inf.offset(1, 2);
      Assert.check(Assert.near(inf.x, 6) && Assert.near(inf.y, 7), "Rectangle.offset");

      var e:Rectangle = new Rectangle(1, 2, 3, 4);
      e.setEmpty();
      Assert.check(e.isEmpty() && Assert.near(e.width, 0), "Rectangle.setEmpty/isEmpty");

      // --- Matrix ---
      var m:Matrix = new Matrix();
      Assert.check(Assert.near(m.a, 1) && Assert.near(m.d, 1) && Assert.near(m.tx, 0) && Assert.near(m.ty, 0), "Matrix identity default");

      m.translate(10, 20);
      Assert.check(Assert.near(m.tx, 10) && Assert.near(m.ty, 20), "Matrix.translate");
      var tpt:Point = m.transformPoint(new Point(1, 1));
      Assert.check(Assert.near(tpt.x, 11) && Assert.near(tpt.y, 21), "Matrix.transformPoint (translate)");

      var rot:Matrix = new Matrix();
      rot.rotate(Math.PI / 2);
      var rotp:Point = rot.transformPoint(new Point(1, 0));
      Assert.check(Assert.near(rotp.x, 0) && Assert.near(rotp.y, 1), "Matrix.rotate 90deg");

      var inv:Matrix = new Matrix();
      inv.translate(10, 20);
      inv.invert();
      var back:Point = inv.transformPoint(new Point(10, 20));
      Assert.check(Assert.near(back.x, 0) && Assert.near(back.y, 0), "Matrix.invert");

      var sc:Matrix = new Matrix();
      sc.scale(2, 3);
      var scp:Point = sc.transformPoint(new Point(1, 1));
      Assert.check(Assert.near(scp.x, 2) && Assert.near(scp.y, 3), "Matrix.scale");

      var c1:Matrix = new Matrix();
      c1.translate(1, 2);
      var c2:Matrix = new Matrix();
      c2.translate(10, 20);
      c1.concat(c2);
      var ccp:Point = c1.transformPoint(new Point(0, 0));
      Assert.check(Assert.near(ccp.x, 11) && Assert.near(ccp.y, 22), "Matrix.concat");

      var box:Matrix = new Matrix();
      box.createBox(2, 3, 0, 5, 6);
      var bp:Point = box.transformPoint(new Point(1, 1));
      Assert.check(Assert.near(bp.x, 7) && Assert.near(bp.y, 9), "Matrix.createBox");

      // --- ColorTransform ---
      var ct:ColorTransform = new ColorTransform();
      Assert.check(Assert.near(ct.redMultiplier, 1) && Assert.near(ct.alphaMultiplier, 1), "ColorTransform multipliers default 1");
      Assert.check(Assert.near(ct.redOffset, 0) && Assert.near(ct.alphaOffset, 0), "ColorTransform offsets default 0");

      var cta:ColorTransform = new ColorTransform(2, 1, 1, 1, 10, 0, 0, 0);
      var ctb:ColorTransform = new ColorTransform(1, 1, 1, 1, 5, 0, 0, 0);
      cta.concat(ctb);
      Assert.check(Assert.near(cta.redMultiplier, 2) && Assert.near(cta.redOffset, 20), "ColorTransform.concat");

      Log.out("GeometryDemos: all flash.geom assertions passed");
    }
  }
}
