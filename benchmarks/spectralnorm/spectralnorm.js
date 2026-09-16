// spectralnorm.js — 谱范数（密集矩阵-向量乘基准）
const N = 1000;

function evalA(i, j) {
  const ij = i + j;
  return 1.0 / ((ij * (ij + 1)) / 2 + i + 1);
}

function multiplyAv(v, av) {
  for (let i = 0; i < N; i++) {
    let sum = 0.0;
    for (let j = 0; j < N; j++) sum += evalA(i, j) * v[j];
    av[i] = sum;
  }
}

function multiplyAtv(v, atv) {
  for (let i = 0; i < N; i++) {
    let sum = 0.0;
    for (let j = 0; j < N; j++) sum += evalA(j, i) * v[j];
    atv[i] = sum;
  }
}

function multiplyAtAv(v, atav, tmp) {
  multiplyAv(v, tmp);
  multiplyAtv(tmp, atav);
}

const u = new Array(N).fill(1.0);
const v = new Array(N).fill(0.0);
const tmp = new Array(N).fill(0.0);

const t0 = process.hrtime.bigint();
for (let iter = 0; iter < 10; iter++) {
  multiplyAtAv(u, v, tmp);
  multiplyAtAv(v, u, tmp);
}
let vBv = 0.0, vv = 0.0;
for (let i = 0; i < N; i++) { vBv += u[i] * v[i]; vv += v[i] * v[i]; }
const result = Math.sqrt(vBv / vv);
const t1 = process.hrtime.bigint();

console.log(`result=${Math.floor(result * 1e6)}`);
console.log(`time=${Math.floor(Number(t1 - t0) / 1e6)}`);
