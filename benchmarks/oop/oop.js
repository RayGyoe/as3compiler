// oop.js — 多态虚方法派发 + 对象字段访问（面向对象核心基准）
class Figure {
  constructor(a, b) { this.a = a; this.b = b; }
  area() { return 0; }
}
class Circle extends Figure { area() { return 3 * this.a * this.a + 2 * this.b; } }
class Square extends Figure { area() { return this.a * this.a + this.b; } }
class Rect extends Figure { area() { return this.a * this.b + this.a + this.b; } }

const shapes = [];
for (let i = 0; i < 64; i++) {
  shapes.push(new Circle((i % 8) + 1, (i % 6) + 1));
  shapes.push(new Square((i % 9) + 1, (i % 7) + 1));
  shapes.push(new Rect((i % 7) + 1, (i % 5) + 1));
}

const N = 20000000;
const t0 = process.hrtime.bigint();
let sum = 0;
for (let j = 0; j < N; j++) {
  const s = shapes[j % 192];
  sum += s.area();
  if (sum >= 1000000000) sum -= 1000000000;
}
const t1 = process.hrtime.bigint();
console.log(`result=${sum}`);
console.log(`time=${Math.floor(Number(t1 - t0) / 1e6)}`);
