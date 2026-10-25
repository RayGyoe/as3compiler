// graphics-path.as — 阶段二百七十五（G26）：Graphics.drawPath / cubicCurveTo /
// GraphicsPathCommand.NO_OP / GraphicsPathWinding。
//
// 症状（asaotui/compiler-gaps.md G26）：AIR 有 drawPath 与 cubicCurveTo，我们没有——
// 于是任何 SVG 路径图标（M/L/C/Q/Z 这些命令）都画不出来，图标只能用矩形和二次曲线
// 硬拼。ICON 那一批 demo 的斜线与圆角全都退化成方角，就是这个缺口。
//
// AIR 的判据全部来自 adl 51.4.1 实测（temp/g242526/air-sem.txt、air-sem2.txt、
// bounds-air.txt，以及 Pix6/Pix7 两轮的逐格 ink 计数）：
//   * GraphicsPathCommand：NO_OP=0 MOVE_TO=1 LINE_TO=2 CURVE_TO=3 WIDE_MOVE_TO=4
//     WIDE_LINE_TO=5 CUBIC_CURVE_TO=6；
//   * GraphicsPathWinding：EVEN_ODD="evenOdd" NON_ZERO="nonZero"；
//   * drawPath 建出来的路径与 moveTo/lineTo/curveTo/cubicCurveTo 逐个等价（填充 ink
//     相同，含曲线鼓包），NO_OP 透明，未知命令与数据耗尽**丢弃其后命令但保留已建几何**，
//     WIDE_* 命令在 AIR 里什么都不画（不是窄命令的同义词）；
//   * width/height 报的是**曲线的紧包围盒**，不是控制点凸包：moveTo(10,50) +
//     cubicCurveTo(10,0, 90,0, 90,50) 是 80x37.5、curveTo(10,0, 90,50) 是 80x25，
//     而控制点凸包会给出 80x50；
//   * 数据长度是奇数 -> ArgumentError #2004「One of the parameters is invalid.」；
//     winding 非法 -> ArgumentError #2008「Parameter winding must be one of the accepted
//     values.」（两条都在画任何东西之前判定）。
//
// 本示例钉 API 面、错误面与包围盒（两种后端都成立）：像素级等价由 temp/g242526 的
// ink 对照与 air-gallery 的图标页覆盖。
import flash.display.*;

function check(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

function expectError(label:String, id:int, msg:String, fn:Function):void {
  var caught:Boolean = false;
  try {
    fn();
  } catch (e:Error) {
    caught = true;
    check(e.errorID == id, label + ": errorID " + e.errorID + " != " + id);
    check(e.message == msg, label + ": message '" + e.message + "' != '" + msg + "'");
  }
  check(caught, label + ": expected a throw, none happened");
}

function boundsOf(build:Function):String {
  var s:Shape = new Shape();
  build(s.graphics);
  s.graphics.endFill();
  return s.width + "x" + s.height;
}

// ---- A. 命令表与 winding 常量 ----
check(GraphicsPathCommand.NO_OP == 0, "NO_OP");
check(GraphicsPathCommand.MOVE_TO == 1, "MOVE_TO");
check(GraphicsPathCommand.LINE_TO == 2, "LINE_TO");
check(GraphicsPathCommand.CURVE_TO == 3, "CURVE_TO");
check(GraphicsPathCommand.WIDE_MOVE_TO == 4, "WIDE_MOVE_TO");
check(GraphicsPathCommand.WIDE_LINE_TO == 5, "WIDE_LINE_TO");
check(GraphicsPathCommand.CUBIC_CURVE_TO == 6, "CUBIC_CURVE_TO");
check(GraphicsPathWinding.EVEN_ODD == "evenOdd", "EVEN_ODD");
check(GraphicsPathWinding.NON_ZERO == "nonZero", "NON_ZERO");

// ---- B. drawPath 与平铺 API 等价；包围盒是曲线的紧界（37.5 而不是控制点凸包的 50） ----
var cmdA:Vector.<int> = new Vector.<int>();
cmdA.push(GraphicsPathCommand.MOVE_TO, GraphicsPathCommand.CUBIC_CURVE_TO);
var dataA:Vector.<Number> = new Vector.<Number>();
dataA.push(10, 50, 10, 0, 90, 0, 90, 50);

var flat:String = boundsOf(function (g:Graphics):void {
  g.beginFill(0x336699);
  g.moveTo(10, 50);
  g.cubicCurveTo(10, 0, 90, 0, 90, 50);
});
var path:String = boundsOf(function (g:Graphics):void {
  g.beginFill(0x336699);
  g.drawPath(cmdA, dataA);
});
check(flat == path, "drawPath must build the same path as the flat API: " + path + " vs " + flat);
check(flat == "80x37.5", "the box takes the curve extremum, not the control hull: " + flat);

// 二次曲线同理：控制点在 y=0、两端在 y=50，紧界高 25。
var quad:String = boundsOf(function (g:Graphics):void {
  g.beginFill(0x336699);
  g.moveTo(10, 50);
  g.curveTo(10, 0, 90, 50);
});
check(quad == "80x25", "a quadratic reports its own extremum: " + quad);

// ---- C. NO_OP 透明；未知命令与数据耗尽丢弃其后命令但保留已建几何 ----
var cmdB:Vector.<int> = new Vector.<int>();
cmdB.push(GraphicsPathCommand.MOVE_TO, GraphicsPathCommand.NO_OP, GraphicsPathCommand.LINE_TO, GraphicsPathCommand.LINE_TO);
var dataB:Vector.<Number> = new Vector.<Number>();
dataB.push(10, 10, 90, 10, 50, 90);   // NO_OP 不吃数据
var withNoop:String = boundsOf(function (g:Graphics):void {
  g.beginFill(0x336699);
  g.drawPath(cmdB, dataB);
});
check(withNoop == "80x80", "NO_OP consumes no data: " + withNoop);

var cmdC:Vector.<int> = new Vector.<int>();
cmdC.push(GraphicsPathCommand.MOVE_TO, GraphicsPathCommand.LINE_TO, 9, GraphicsPathCommand.LINE_TO);
var dataC:Vector.<Number> = new Vector.<Number>();
dataC.push(10, 10, 90, 10, 10, 90);
var truncated:String = boundsOf(function (g:Graphics):void {
  g.beginFill(0x336699);
  g.drawPath(cmdC, dataC);           // 未知命令 9：其后那条 lineTo 不再执行
});
check(truncated == "80x0", "an unknown command keeps what is built and drops the rest: " + truncated);

var cmdW:Vector.<int> = new Vector.<int>();
cmdW.push(GraphicsPathCommand.WIDE_MOVE_TO, GraphicsPathCommand.WIDE_LINE_TO);
var dataW:Vector.<Number> = new Vector.<Number>();
dataW.push(10, 10, 90, 10);
var wide:String = boundsOf(function (g:Graphics):void {
  g.beginFill(0x336699);
  g.drawPath(cmdW, dataW);           // AIR：wide 命令什么都不画
});
check(wide == "0x0", "WIDE_* paints nothing in AIR: " + wide);

// 空 / null 向量都是合法的空操作。
var emptyI:Vector.<int> = new Vector.<int>();
var emptyN:Vector.<Number> = new Vector.<Number>();
var g0:Shape = new Shape();
g0.graphics.beginFill(0x336699);
g0.graphics.drawPath(emptyI, emptyN);
g0.graphics.drawPath(null, null);
g0.graphics.endFill();
check(g0.width == 0 && g0.height == 0, "an empty drawPath draws nothing");

// ---- D. 两种 winding 都接受，其它值 #2008 ----
var g1:Shape = new Shape();
g1.graphics.beginFill(0x336699);
g1.graphics.drawPath(cmdA, dataA, GraphicsPathWinding.EVEN_ODD);
g1.graphics.drawPath(cmdA, dataA, GraphicsPathWinding.NON_ZERO);
g1.graphics.drawPath(cmdA, dataA);
g1.graphics.drawPath(cmdA, dataA, null);
g1.graphics.endFill();
check(g1.width == 80 && g1.height == 37.5, "every accepted winding builds the path: " + g1.width + "x" + g1.height);

expectError("bad winding", 2008, "Error #2008: Parameter winding must be one of the accepted values.",
  function ():void {
    var g2:Shape = new Shape();
    g2.graphics.beginFill(0x336699);
    g2.graphics.drawPath(cmdA, dataA, "nonzero");
  });

// ---- E. 数据长度必须是偶数，且判定在画东西之前 ----
expectError("odd data length", 2004, "Error #2004: One of the parameters is invalid.",
  function ():void {
    var g3:Shape = new Shape();
    g3.graphics.beginFill(0x336699);
    var c:Vector.<int> = new Vector.<int>();
    c.push(GraphicsPathCommand.MOVE_TO, GraphicsPathCommand.LINE_TO);
    var d:Vector.<Number> = new Vector.<Number>();
    d.push(10, 10, 90);
    g3.graphics.drawPath(c, d);
  });

// ---- F. drawPath 只画、不清场：它扩展当前这一组 ----
var mixed:Shape = new Shape();
mixed.graphics.beginFill(0x336699);
mixed.graphics.moveTo(0, 0);
mixed.graphics.lineTo(200, 0);
mixed.graphics.lineTo(200, 50);
mixed.graphics.drawPath(cmdA, dataA);
mixed.graphics.endFill();
check(mixed.width == 200 && mixed.height == 50,
  "drawPath extends the group it is called in: " + mixed.width + "x" + mixed.height);

trace("graphics-path: OK");