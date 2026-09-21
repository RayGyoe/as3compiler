// stage79.as — Stage3D 前置几何类（flash.geom stage 79）：Matrix3D + Vector3D。
// 纯逻辑、不碰 GPU。验证列主序矩阵运算、向量几何、decompose/recompose 往返一致。
// 语义参照 AIR 的 flash.geom.Matrix3D / Vector3D（mxmlc 对照）。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function near(a:Number, b:Number, msg:String):void { if (Math.abs(a - b) > 1e-9) throw new Error("FAIL: " + msg + " (got " + a + ", want " + b + ")"); }

// --- Vector3D 基本运算 ---
var a:Vector3D = new Vector3D(1, 2, 3, 1);
var b:Vector3D = new Vector3D(4, 5, 6, 1);
var sum:Vector3D = a.add(b);
near(sum.x, 5, "add.x"); near(sum.y, 7, "add.y"); near(sum.z, 9, "add.z"); near(sum.w, 2, "add.w");

var diff:Vector3D = a.subtract(b);
near(diff.x, -3, "subtract.x"); near(diff.y, -3, "subtract.y"); near(diff.z, -3, "subtract.z");

near(a.dotProduct(b), 1*4 + 2*5 + 3*6, "dotProduct");

var cross:Vector3D = a.crossProduct(b);
near(cross.x, 2*6 - 3*5, "cross.x");
near(cross.y, 3*4 - 1*6, "cross.y");
near(cross.z, 1*5 - 2*4, "cross.z");

near(a.length, Math.sqrt(1 + 4 + 9), "length");
near(a.lengthSquared, 14, "lengthSquared");

var n:Vector3D = new Vector3D(3, 4, 0, 1);
var origLen:Number = n.normalize();
near(origLen, 5, "normalize returns original length");
near(n.length, 1, "normalized to unit length");

var neg:Vector3D = new Vector3D(1, -2, 3, 1);
neg.negate();
near(neg.x, -1, "negate.x"); near(neg.y, 2, "negate.y"); near(neg.z, -3, "negate.z");

var sc:Vector3D = new Vector3D(1, 2, 3, 4);
sc.scaleBy(10);
near(sc.x, 10, "scaleBy.x"); near(sc.y, 20, "scaleBy.y"); near(sc.z, 30, "scaleBy.z"); near(sc.w, 40, "scaleBy.w");

near(Vector3D.distance(new Vector3D(0,0,0), new Vector3D(3,4,0)), 5, "distance");

var ang:Number = Vector3D.angleBetween(new Vector3D(1,0,0), new Vector3D(0,1,0));
near(ang, Math.PI / 2, "angleBetween 90deg");

check(a.clone().equals(new Vector3D(1,2,3,1)), "clone equals");
check(a.equals(new Vector3D(1,2,3,4)), "equals ignores w by default (xyz equal)");
check(!a.equals(new Vector3D(1,2,3,4), true), "equals allFour=true compares w");

// 静态常量轴
near(Vector3D.X_AXIS.x, 1, "X_AXIS.x"); near(Vector3D.X_AXIS.y, 0, "X_AXIS.y");
near(Vector3D.Y_AXIS.y, 1, "Y_AXIS.y");
near(Vector3D.Z_AXIS.z, 1, "Z_AXIS.z");

// --- Matrix3D 单位矩阵 ---
var id:Matrix3D = new Matrix3D();
var rd:Vector.<Number> = id.rawData;
near(rd[0], 1, "identity rawData[0]");
near(rd[5], 1, "identity rawData[5]");
near(rd[10], 1, "identity rawData[10]");
near(rd[15], 1, "identity rawData[15]");
near(rd[1], 0, "identity rawData[1]");

// 单位矩阵变换向量（w=1 的点）
var p:Vector3D = id.transformVector(new Vector3D(1, 2, 3, 1));
near(p.x, 1, "identity transformVector.x");
near(p.y, 2, "identity transformVector.y");
near(p.z, 3, "identity transformVector.z");
near(p.w, 1, "identity transformVector.w");

// --- appendTranslation / appendScale ---
var t:Matrix3D = new Matrix3D();
t.appendTranslation(10, 20, 30);
var tp:Vector3D = t.transformVector(new Vector3D(1, 2, 3, 1));
near(tp.x, 11, "appendTranslation.x");
near(tp.y, 22, "appendTranslation.y");
near(tp.z, 33, "appendTranslation.z");

var s:Matrix3D = new Matrix3D();
s.appendScale(2, 3, 4);
var sp:Vector3D = s.transformVector(new Vector3D(1, 1, 1, 1));
near(sp.x, 2, "appendScale.x");
near(sp.y, 3, "appendScale.y");
near(sp.z, 4, "appendScale.z");

// --- append（矩阵乘法）与 prepend ---
// 语义（对照 AIR flash.geom.Matrix3D）：append(lhs) = lhs * this（前置相乘，lhs 在左），
// prepend(rhs) = this * rhs（后置相乘，rhs 在右）。下面用「旋转 + 平移」这种不可交换的
// 组合锁定方向，防止回归。
var m1:Matrix3D = new Matrix3D();
m1.appendTranslation(1, 0, 0);
var m2:Matrix3D = new Matrix3D();
m2.appendTranslation(0, 2, 0);
var m3:Matrix3D = m1.clone();
m3.append(m2); // 纯平移可交换，结果仍是 T(1,2,0)
var pp:Vector3D = m3.transformVector(new Vector3D(0, 0, 0, 1));
near(pp.x, 1, "append order.x");
near(pp.y, 2, "append order.y");

// append：先旋转后 appendTranslation，平移在世界系，不受已有旋转影响
var ao:Matrix3D = new Matrix3D();
ao.appendRotation(45, Vector3D.X_AXIS);
ao.appendTranslation(10, 20, 30);
var aoc:Vector.<Vector3D> = ao.decompose();
near(aoc[0].x, 10, "append: translation.x unaffected by prior rotation");
near(aoc[0].y, 20, "append: translation.y unaffected by prior rotation");
near(aoc[0].z, 30, "append: translation.z unaffected by prior rotation");

// prepend：先旋转后 prependTranslation，平移在局部系，会被已有旋转旋转
var po:Matrix3D = new Matrix3D();
po.prependRotation(45, Vector3D.X_AXIS);
po.prependTranslation(10, 20, 30);
var poc:Vector.<Vector3D> = po.decompose();
near(poc[0].x, 10, "prepend: translation.x");
near(poc[0].y, 20 * Math.cos(Math.PI / 4) - 30 * Math.sin(Math.PI / 4), "prepend: translation.y");
near(poc[0].z, 20 * Math.sin(Math.PI / 4) + 30 * Math.cos(Math.PI / 4), "prepend: translation.z");

// --- invert：M * M^-1 = I ---
var m4:Matrix3D = new Matrix3D();
m4.appendTranslation(5, -3, 7);
m4.appendScale(2, 2, 2);
var m5:Matrix3D = m4.clone();
check(m5.invert(), "invert succeeds");
var m6:Matrix3D = m4.clone();
m6.append(m5); // m4 * m4^-1 = I
var ip:Vector3D = m6.transformVector(new Vector3D(1, 2, 3, 1));
near(ip.x, 1, "invert roundtrip.x");
near(ip.y, 2, "invert roundtrip.y");
near(ip.z, 3, "invert roundtrip.z");

// --- transpose ---
var m7:Matrix3D = new Matrix3D();
m7.appendTranslation(1, 2, 3);
m7.transpose();
var m7rd:Vector.<Number> = m7.rawData;
near(m7rd[3], 1, "transpose tx -> row3 col0");
near(m7rd[7], 2, "transpose ty -> row3 col1");
near(m7rd[11], 3, "transpose tz -> row3 col2");
near(m7rd[12], 0, "transpose clears col3 row0");

// --- deltaTransformVector：忽略平移 ---
var m8:Matrix3D = new Matrix3D();
m8.appendTranslation(100, 100, 100);
m8.appendScale(2, 2, 2);
var d:Vector3D = m8.deltaTransformVector(new Vector3D(1, 1, 1, 0));
near(d.x, 2, "deltaTransformVector.x (no translation)");
near(d.y, 2, "deltaTransformVector.y");

// --- appendRotation：绕 Z 轴 90 度 ---
var m9:Matrix3D = new Matrix3D();
m9.appendRotation(90, new Vector3D(0, 0, 1));
var rp:Vector3D = m9.transformVector(new Vector3D(1, 0, 0, 1));
near(rp.x, 0, "rotZ90.x");
near(rp.y, 1, "rotZ90.y");

// --- static identity / interpolate ---
var si:Matrix3D = Matrix3D.identity();
near(si.rawData[0], 1, "static identity rawData[0]");
var from:Matrix3D = new Matrix3D();
var to:Matrix3D = new Matrix3D();
to.appendTranslation(10, 10, 10);
var mid:Matrix3D = Matrix3D.interpolate(from, to, 0.5);
near(mid.rawData[12], 5, "static interpolate tx");

// --- decompose / recompose 往返 ---
var m10:Matrix3D = new Matrix3D();
// append = lhs * this，故按 Scale→Rotation→Translation 的顺序构造得到 T*R*S，
// 平移分量恰为 (3,-2,5)，decompose 直接还原（列主序最后一列）。
m10.appendScale(2, 3, 4);
m10.appendRotation(30, new Vector3D(1, 1, 1));
m10.appendTranslation(3, -2, 5);
var comps:Vector.<Vector3D> = m10.decompose();
check(comps.length == 3, "decompose returns 3 components");
near(comps[0].x, 3, "decompose translation.x");
near(comps[0].y, -2, "decompose translation.y");
near(comps[2].x, 2, "decompose scale.x");
near(comps[2].y, 3, "decompose scale.y");
near(comps[2].z, 4, "decompose scale.z");

var m11:Matrix3D = new Matrix3D();
check(m11.recompose(comps), "recompose succeeds");
var m11rd:Vector.<Number> = m11.rawData;
near(m11rd[12], 3, "recompose tx");
near(m11rd[13], -2, "recompose ty");
near(m11rd[14], 5, "recompose tz");
// recompose(decompose(M)) == M（逐元素对照）
var m10rd:Vector.<Number> = m10.rawData;
var roundtripOk:Boolean = true;
for (var i:int = 0; i < 16; i++) {
  if (Math.abs(m10rd[i] - m11rd[i]) > 1e-9) roundtripOk = false;
}
check(roundtripOk, "decompose/recompose roundtrip");

// --- copyFrom / clone ---
var m12:Matrix3D = new Matrix3D();
m12.appendTranslation(9, 8, 7);
var m13:Matrix3D = new Matrix3D();
m13.copyFrom(m12);
near(m13.rawData[12], 9, "copyFrom tx");
near(m12.clone().rawData[14], 7, "clone tz");

trace("stage79: all Matrix3D/Vector3D assertions passed");
