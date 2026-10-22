// vectorint.js — 静态类型整型向量迭代与累加（Vector.<int> 在 JS 里的语义对等物：Int32Array）
//
// 选型说明：`Vector.<int>` 是「4 字节裸整型、无装箱」的容器，JS 里唯一布局等价的是
// Int32Array（V8 → INT32ELEMENTS，背面 ByteArray，逐元素 4 B）。普通 Array 是 8 字节
// tagged 槽（PACKED_SMI / HOLEY_SMI），与它并非同一表示，故本基准**不**用普通 Array。
const N = 20000000;
const a = new Int32Array(N);
for (let i = 0; i < N; i++) a[i] = (i * 31) % 997;

const t0 = process.hrtime.bigint();
let sum = 0;
for (let j = 0; j < N; j++) {
  sum += a[j];
  if (sum >= 1000000000) sum -= 1000000000;
}
const t1 = process.hrtime.bigint();
console.log(`result=${sum}`);
console.log(`time=${Math.floor(Number(t1 - t0) / 1e6)}`);