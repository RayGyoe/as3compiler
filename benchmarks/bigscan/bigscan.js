// bigscan.js — 大 ASCII 文本上的 indexOf / charAt / lastIndexOf（Node 版）
// JS 的字符串内部就是 UTF-16，索引直接可用，不需要码元 ↔ 字节翻译。
const line = "the quick brown fox jumps over the lazy dog";
let big = "";
for (let k = 0; k < 4000; k++) big += line + "\n";

let sum = 0;
const t0 = process.hrtime.bigint();
for (let i = 0; i < 200; i++) {
  let p = -1;
  for (let j = 0; j < 40; j++) { p = big.indexOf("lazy", p + 1); sum += p; }
  sum += big.charAt(90000).length;
  sum += big.lastIndexOf("fox", 100000);
}
const t1 = process.hrtime.bigint();

console.log(`result=${sum}`);
console.log(`time=${Math.floor(Number(t1 - t0) / 1e6)}`);
