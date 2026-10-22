// nbody.c — 5 天体 N 体模拟（浮点基准）
#include <math.h>
#include <stdio.h>
#include <time.h>

#define N 5
#define PI 3.141592653589793
#define SOLAR_MASS (4 * PI * PI)
#define DPY 365.24

typedef struct { double x, y, z, vx, vy, vz, mass; } Body;

static Body b[N] = {
    {0, 0, 0, 0, 0, 0, SOLAR_MASS},
    {4.84143144246472090, -1.16032004402742839, -0.103622044471123109,
     0.00166007664274403694 * DPY, 0.00769901118419740425 * DPY, -0.0000690460016972063023 * DPY,
     0.000954791938424326609 * SOLAR_MASS},
    {8.34336671824457987, 4.12479856412430479, -0.403523417114321381,
     -0.00276742510726862411 * DPY, 0.00499852801234917238 * DPY, 0.0000230417297573763929 * DPY,
     0.000285885980666130812 * SOLAR_MASS},
    {12.8943695621391310, -15.1111514016986312, -0.223307578892655734,
     0.00296460137564761618 * DPY, 0.00237847173959480950 * DPY, -0.0000296589568540237556 * DPY,
     0.0000436624404335156298 * SOLAR_MASS},
    {15.3796971148509165, -25.9193146099879641, 0.179258772950371181,
     0.00268067772490389322 * DPY, 0.00162824170038242295 * DPY, -0.0000951592254519715870 * DPY,
     0.0000515138902046611451 * SOLAR_MASS}};

static double energy(void) {
  double e = 0;
  for (int i = 0; i < N; i++) {
    e += 0.5 * b[i].mass * (b[i].vx * b[i].vx + b[i].vy * b[i].vy + b[i].vz * b[i].vz);
    for (int j = i + 1; j < N; j++) {
      double dx = b[i].x - b[j].x, dy = b[i].y - b[j].y, dz = b[i].z - b[j].z;
      e -= (b[i].mass * b[j].mass) / sqrt(dx * dx + dy * dy + dz * dz);
    }
  }
  return e;
}

static void advance(double dt) {
  for (int i = 0; i < N; i++) {
    for (int j = i + 1; j < N; j++) {
      double dx = b[i].x - b[j].x, dy = b[i].y - b[j].y, dz = b[i].z - b[j].z;
      double d2 = dx * dx + dy * dy + dz * dz;
      double mag = dt / (d2 * sqrt(d2));
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

int main(void) {
  double px = 0, py = 0, pz = 0;
  for (int i = 0; i < N; i++) {
    px += b[i].vx * b[i].mass;
    py += b[i].vy * b[i].mass;
    pz += b[i].vz * b[i].mass;
  }
  b[0].vx = -px / SOLAR_MASS;
  b[0].vy = -py / SOLAR_MASS;
  b[0].vz = -pz / SOLAR_MASS;

  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  double e0 = energy();
  for (int s = 0; s < 5000000; s++) advance(0.01);
  double e1 = energy();
  clock_gettime(CLOCK_MONOTONIC, &t1);

  long long ms = (t1.tv_sec - t0.tv_sec) * 1000LL +
                 (t1.tv_nsec - t0.tv_nsec) / 1000000LL;
  printf("result=%lld,%lld\n", (long long)floor(e0 * 1e6), (long long)floor(e1 * 1e6));
  printf("time=%lld\n", ms);
  return 0;
}
