// cjkscan.js — 大 CJK 文本上的 indexOf / lastIndexOf / charCodeAt / substring（Node 版）
// JS 的字符串内部就是 UTF-16，索引直接可用，不需要码元 ↔ 字节翻译。
const line = "敏捷的棕色狐狸跳过了那只懒狗用它来测试中日韩文字的码元索引和字节偏移之间的翻译开销六字";
let big = "";
for (let k = 0; k < 4000; k++) big += line + "\n";

let sum = 0;
const t0 = process.hrtime.bigint();
for (let i = 0; i < 100; i++) {
  let p = -1;
  for (let j = 0; j < 40; j++) { p = big.indexOf("懒狗", p + 1); sum += p; }
}
for (let b = 0; b < 100; b++) {
  for (let j = 0; j < 40; j++) { sum += big.lastIndexOf("狐狸", 120000 - j); }
}
for (let q = 0; q < 20000; q++) { sum += big.charCodeAt((q * 5003) % 170000); }
for (let r = 0; r < 20000; r++) {
  const o = (r * 7919) % 170000;
  sum += big.substring(o, o + 20).length;
}
const t1 = process.hrtime.bigint();

console.log(`result=${sum}`);
console.log(`time=${Math.floor(Number(t1 - t0) / 1e6)}`);
