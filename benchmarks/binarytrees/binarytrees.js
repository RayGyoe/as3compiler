// binarytrees.js — 递归二叉树分配/遍历（对象分配基准）
function make(depth) {
  const n = {left: null, right: null};
  if (depth === 0) { n.left = n.right = null; }
  else { n.left = make(depth - 1); n.right = make(depth - 1); }
  return n;
}

function check(n) {
  let total = 1;
  if (n.left) total += check(n.left);
  if (n.right) total += check(n.right);
  return total;
}

const maxDepth = 14;
const t0 = process.hrtime.bigint();

const stretch = make(maxDepth + 1);
const s = check(stretch);
const longLived = make(maxDepth);
let sum = 0;
for (let d = 4; d <= maxDepth; d += 2) {
  const n = 1 << (maxDepth - d + 4);
  for (let i = 0; i < n; i++) {
    const t = make(d);
    sum += check(t);
  }
}
const l = check(longLived);

const t1 = process.hrtime.bigint();
console.log(`result=${s},${sum},${l}`);
console.log(`time=${Math.floor(Number(t1 - t0) / 1e6)}`);
