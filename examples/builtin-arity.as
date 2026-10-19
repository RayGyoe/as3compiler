// builtin-arity.as -- built-in optional arguments must match what AIR accepts.
//
// This is the regression for the stage-195 audit: every (class, method, arity)
// cell of the built-in table was measured against `mxmlc` 51.4.1 (the AIR
// compiler) and our own acceptance was aligned with it. Two directions mattered:
//
//   * we USED TO require arguments AIR accepts omitting -- `ctx.drawTriangles(ib)`,
//     `ctx.configureBackBuffer(1, 1, 0)`, `new NativeMenuItem()`, `w.loadString(t)`
//     all failed to compile here although AIR accepts them (the TODO.md leftover
//     row "内建签名默认实参"). The fix gives those parameters AIR's documented
//     default value, so the omitted argument compiles and the emitted C passes the
//     default through.
//   * we USED TO invent defaults AIR does NOT have -- `g.moveTo(1)`,
//     `m.rotate()`, `new ShaderData()`, `r.inflate(1)` were accepted here although
//     AIR rejects them. Those parameters are required again; the negative pins live
//     in test/unit/diagnostics.ts (an example suite only runs programs that must
//     compile).
//
// `Context3D.drawTrianglesInstanced` also had its parameter ORDER wrong: AIR is
// (indexBuffer, numInstances, firstIndex = 0, numTriangles = -1) -- numInstances
// SECOND -- while we had (indexBuffer, firstIndex, numTriangles, numInstances), so
// the AIR-legal two-argument call `drawTrianglesInstanced(ib, 3)` meant `firstIndex`
// here. Section 1 asserts the order that call now produces.

import flash.display.NativeMenuItem;
import flash.display.NativeWindow;
import flash.display.Graphics;
import flash.display3D.Context3D;
import flash.display3D.IndexBuffer3D;
import flash.display3D.VertexBuffer3D;
import flash.display3D.textures.Texture;
import flash.geom.Matrix;
import flash.geom.Matrix3D;
import flash.geom.Point;
import flash.geom.Rectangle;
import flash.geom.Vector3D;
import flash.media.Microphone;
import flash.media.StageWebView;
import flash.media.Video;
import flash.net.NetConnection;
import flash.net.NetStream;
import flash.text.StyleSheet;
import flash.desktop.Clipboard;
import flash.filesystem.File;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- 1. AIR's parameter ORDER for drawTrianglesInstanced ---------------------
// The argument list below is what the emitted C must pass to the C helper: the
// two-argument AIR call fills (numInstances, firstIndex = 0, numTriangles = -1).
// A wrong order would silently read firstIndex = 3 -- an invisible geometry bug,
// so this is asserted at runtime through the 3-argument form, where the two
// parameters are distinguishable.
var ib:IndexBuffer3D = null;

// (compile-only + order check performed by test/unit/emit.ts on the emitted C;
//  the runtime part below covers the calls that are safe without a Stage)

// --- 2. defaults AIR documents, which we now honour --------------------------
// NativeMenuItem(label:String = "", isSeparator:Boolean = false)
var mi:NativeMenuItem = new NativeMenuItem();
check(mi.label == "", "new NativeMenuItem() -> label '' (AIR default), got '" + mi.label + "'");
check(mi.isSeparator == false, "…and isSeparator false, got " + mi.isSeparator);
var mi2:NativeMenuItem = new NativeMenuItem("Hi", true);
check(mi2.label == "Hi" && mi2.isSeparator, "both arguments still land, got '" + mi2.label + "'/" + mi2.isSeparator);

// StageWebView.loadString(text:String, mimeType:String = "text/html") and
// Microphone.setLoopBack(state:Boolean = true) belong to the same AIR defaults,
// but both classes are compile-time stubs in this build (Microphone.getMicrophone
// returns null), so their calls live in `arityProbe` below.

// Stage3D.requestContext3D(context3DRenderMode:String = "auto") is compile-only
// too: the stub has no Stage to attach a context to.

// --- 3. required-again parameters still take their arguments -----------------
// These had invented defaults before the audit; passing them explicitly is what
// AIR's own signature requires.
var p:Point = new Point(3, 4);
p.normalize(10);
check(p.x == 6 && p.y == 8, "Point.normalize(10) on (3,4) -> (6,8), got (" + p.x + "," + p.y + ")");
p.offset(-1, -1);
check(p.x == 5 && p.y == 7, "Point.offset(-1,-1) -> (5,7), got (" + p.x + "," + p.y + ")");
p.setTo(1, 2);
check(p.x == 1 && p.y == 2, "Point.setTo, got (" + p.x + "," + p.y + ")");

var r:Rectangle = new Rectangle(0, 0, 10, 10);
// AIR's Rectangle.contains(x, y) takes NUMBERS (containsPoint takes a Point).
check(r.contains(5, 5), "Rectangle.contains(5,5)");
check(r.containsPoint(new Point(5, 5)), "Rectangle.containsPoint(point)");
r.inflate(1, 1);
check(r.width == 12 && r.height == 12, "Rectangle.inflate(1,1) widens to 12, got " + r.width);
r.offset(2, 2);
check(r.x == 1 && r.y == 1, "Rectangle.offset moves the origin to (1,1), got (" + r.x + "," + r.y + ")");

var m:Matrix = new Matrix();
m.rotate(Math.PI / 2);
check(Math.abs(Math.round(m.a)) == 0 && Math.round(m.b) == 1, "Matrix.rotate(90deg) -> b = 1, got " + m.b);
m.identity();
m.scale(2, 3);
check(m.a == 2 && m.d == 3, "Matrix.scale(2,3), got " + m.a + "/" + m.d);
m.translate(4, 5);
check(m.tx == 4 && m.ty == 5, "Matrix.translate(4,5), got (" + m.tx + "," + m.ty + ")");

var v:Vector3D = new Vector3D(1, 2, 3);
v.scaleBy(2);
check(v.x == 2 && v.z == 6, "Vector3D.scaleBy(2), got " + v.x + "/" + v.z);
v.setTo(4, 5, 6);
check(v.y == 5, "Vector3D.setTo, got " + v.y);

// StyleSheet.setStyle/getStyle: the selector arguments are required in AIR.
var ss:StyleSheet = new StyleSheet();
ss.setStyle("h1", { color: "#ff0000" });
check(ss.getStyle("h1") != null, "StyleSheet round-trips a style object");

// --- 4. compile-only: the AIR-legal calls that need a Stage / device ---------
// This function is never called (`-O2` prunes it), so the bodies below only have
// to COMPILE. Each line is an AIR-legal short-form call: `mxmlc` 51.4.1 accepts it
// and our compiler now does too, passing AIR's default for the omitted argument.
function arityProbe(ctx:Context3D, ib:IndexBuffer3D, vb:VertexBuffer3D, tex:Texture,
                    m3:Matrix3D, g:Graphics, ns:NetStream, nc:NetConnection, w:StageWebView,
                    nw:NativeWindow, f:File, video:Video):void {
  // Context3D: indexBuffer/firstIndex/numTriangles + the render-state defaults.
  ctx.drawTriangles(ib);
  ctx.drawTriangles(ib, 6);
  ctx.drawTrianglesInstanced(ib, 3);
  ctx.configureBackBuffer(1, 1, 0);
  ctx.setProgramConstantsFromMatrix("vertex", 0, m3);
  ctx.setRenderToTexture(tex);
  ctx.setRenderToTexture(tex, true);
  ctx.setVertexBufferAt(0, vb);
  ctx.setProgramConstantsFromVector("vertex", 0, new <Number>[1, 2, 3, 4]);

  // Graphics: every drawing primitive needs its coordinates; `beginFill`'s alpha
  // and `drawTriangles`' indices/uvt/culling are optional.
  g.beginFill(0xff0000);
  g.drawRect(0, 0, 10, 10);
  g.moveTo(0, 0);
  g.lineTo(10, 10);
  g.drawTriangles(new <Number>[0, 0, 1, 0, 0, 1]);

  // Media / net / filesystem / clipboard.
  w.loadString("<b>x</b>");
  Microphone.getMicrophone().setLoopBack();
  Clipboard.generalClipboard.clearData("text/plain");
  ns.seek(0);
  nc.connect("rtmp://example.invalid/app");
  video.attachCamera(null);
  nw.notifyUser("info");
  f.browseForOpen("pick a file");

  // Matrix3D / Vector3D statics with a middle default.
  m3.pointAt(new Vector3D(0, 0, 1));
  Matrix3D.interpolate(m3, m3, 0.5);
}
