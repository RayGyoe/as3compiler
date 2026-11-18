// stringbuild.js — 循环字符串累加（`s += "ab"`）基准（JS 版）
const N = 2000;
const ROUNDS = 150;

let checksum = 0;
const t0 = process.hrtime.bigint();
for (let r = 0; r < ROUNDS; r++) {
  let s = "";
  for (let i = 0; i < N; i++) s += "ab";
  checksum += s.length;
  checksum += s.indexOf("ba");
}
const t1 = process.hrtime.bigint();

console.log(`result=${checksum}`);
console.log(`time=${Math.floor(Number(t1 - t0) / 1e6)}`);