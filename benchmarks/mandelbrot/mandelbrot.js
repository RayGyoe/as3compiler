// mandelbrot.js — Mandelbrot 集合计数（浮点内层循环基准）
const size = 1500;
let inside = 0;
const t0 = process.hrtime.bigint();

for (let py = 0; py < size; py++) {
  const ci = 2.0 * py / size - 1.0;
  for (let px = 0; px < size; px++) {
    const cr = 2.0 * px / size - 1.5;
    let zr = 0, zi = 0;
    let k = 0;
    while (k < 50 && zr * zr + zi * zi <= 4.0) {
      const t = zr * zr - zi * zi + cr;
      zi = 2.0 * zr * zi + ci;
      zr = t;
      k++;
    }
    if (k === 50) inside++;
  }
}

const t1 = process.hrtime.bigint();
console.log(`result=${inside}`);
console.log(`time=${Math.floor(Number(t1 - t0) / 1e6)}`);
