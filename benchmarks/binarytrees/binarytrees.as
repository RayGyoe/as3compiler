// binarytrees.as — 递归二叉树分配/遍历（对象分配基准，as3compiler 版）
class Node {
  var left:Node;
  var right:Node;
}

function make(depth:int):Node {
  var n:Node = new Node();
  if (depth == 0) {
    n.left = null;
    n.right = null;
  } else {
    n.left = make(depth - 1);
    n.right = make(depth - 1);
  }
  return n;
}

function check(n:Node):int {
  var total:int = 1;
  if (n.left != null) { total += check(n.left); }
  if (n.right != null) { total += check(n.right); }
  return total;
}

var maxDepth:int = 14;
var t0:Number = new Date().getTime();
var stretch:Node = make(maxDepth + 1);
var s:int = check(stretch);
var longLived:Node = make(maxDepth);
var sum:int = 0;
for (var d:int = 4; d <= maxDepth; d += 2) {
  var n:int = 1 << (maxDepth - d + 4);
  for (var i:int = 0; i < n; i++) {
    var t:Node = make(d);
    sum += check(t);
    // 周期性触发 GC 回收，验证 Node 树在持续分配压力下能被正确标记与回收。
    if ((i % 2048) == 0) { System.gc(); }
  }
  System.gc();
}
var l:int = check(longLived);
var t1:Number = new Date().getTime();

trace("result=" + s + "," + sum + "," + l);
trace("time=" + int(t1 - t0));
