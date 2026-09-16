// strings.js — 字符串 split/join/indexOf/toUpperCase/lastIndexOf（字符串分配基准）
const text = "the quick brown fox jumps over the lazy dog";
let checksum = 0;

const t0 = process.hrtime.bigint();
for (let i = 0; i < 300000; i++) {
  const joined = text.split(" ").join("-");
  checksum += joined.indexOf("fox");
  checksum += joined.toUpperCase().length;
  checksum += joined.split("quick").join("slow").lastIndexOf("o");
}
const t1 = process.hrtime.bigint();

console.log(`result=${checksum}`);
console.log(`time=${Math.floor(Number(t1 - t0) / 1e6)}`);
