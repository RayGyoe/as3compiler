// array.js — 数值数组迭代与累加（整数数组基准）
const N = 20000000;
const a = [];
for (let i = 0; i < N; i++) a.push((i * 31) % 997);

const t0 = process.hrtime.bigint();
let sum = 0;
for (let j = 0; j < N; j++) {
  sum += a[j];
  if (sum >= 1000000000) sum -= 1000000000;
}
const t1 = process.hrtime.bigint();
console.log(`result=${sum}`);
console.log(`time=${Math.floor(Number(t1 - t0) / 1e6)}`);
