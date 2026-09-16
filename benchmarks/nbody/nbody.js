// nbody.js — 5 天体 N 体模拟（浮点基准）
const N = 5;
const PI = Math.PI;
const SOLAR_MASS = 4 * PI * PI;
const DPY = 365.24;

const b = [
  {x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, mass: SOLAR_MASS},
  {x: 4.84143144246472090, y: -1.16032004402742839, z: -0.103622044471123109,
   vx: 0.00166007664274403694 * DPY, vy: 0.00769901118419740425 * DPY, vz: -0.0000690460016972063023 * DPY,
   mass: 0.000954791938424326609 * SOLAR_MASS},
  {x: 8.34336671824457987, y: 4.12479856412430479, z: -0.403523417114321381,
   vx: -0.00276742510726862411 * DPY, vy: 0.00499852801234917238 * DPY, vz: 0.0000230417297573763929 * DPY,
   mass: 0.000285885980666130812 * SOLAR_MASS},
  {x: 12.8943695621391310, y: -15.1111514016986312, z: -0.223307578892655734,
   vx: 0.00296460137564761618 * DPY, vy: 0.00237847173959480950 * DPY, vz: -0.0000296589568540237556 * DPY,
   mass: 0.0000436624404335156298 * SOLAR_MASS},
  {x: 15.3796971148509165, y: -25.9193146099879641, z: 0.179258772950371181,
   vx: 0.00268067772490389322 * DPY, vy: 0.00162824170038242295 * DPY, vz: -0.0000951592254519715870 * DPY,
   mass: 0.0000515138902046611451 * SOLAR_MASS},
];

function energy() {
  let e = 0;
  for (let i = 0; i < N; i++) {
    e += 0.5 * b[i].mass * (b[i].vx * b[i].vx + b[i].vy * b[i].vy + b[i].vz * b[i].vz);
    for (let j = i + 1; j < N; j++) {
      const dx = b[i].x - b[j].x, dy = b[i].y - b[j].y, dz = b[i].z - b[j].z;
      e -= (b[i].mass * b[j].mass) / Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  }
  return e;
}

function advance(dt) {
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const dx = b[i].x - b[j].x, dy = b[i].y - b[j].y, dz = b[i].z - b[j].z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const mag = dt / (d2 * Math.sqrt(d2));
      b[i].vx -= dx * b[j].mass * mag;
      b[i].vy -= dy * b[j].mass * mag;
      b[i].vz -= dz * b[j].mass * mag;
      b[j].vx += dx * b[i].mass * mag;
      b[j].vy += dy * b[i].mass * mag;
      b[j].vz += dz * b[i].mass * mag;
    }
    b[i].x += dt * b[i].vx;
    b[i].y += dt * b[i].vy;
    b[i].z += dt * b[i].vz;
  }
}

let px = 0, py = 0, pz = 0;
for (let i = 0; i < N; i++) {
  px += b[i].vx * b[i].mass;
  py += b[i].vy * b[i].mass;
  pz += b[i].vz * b[i].mass;
}
b[0].vx = -px / SOLAR_MASS;
b[0].vy = -py / SOLAR_MASS;
b[0].vz = -pz / SOLAR_MASS;

const t0 = process.hrtime.bigint();
const e0 = energy();
for (let s = 0; s < 5000000; s++) advance(0.01);
const e1 = energy();
const t1 = process.hrtime.bigint();

console.log(`result=${Math.floor(e0 * 1e6)},${Math.floor(e1 * 1e6)}`);
console.log(`time=${Math.floor(Number(t1 - t0) / 1e6)}`);
