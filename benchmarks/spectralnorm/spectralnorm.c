// spectralnorm.c — 谱范数（Vector.<Number> 密集矩阵-向量乘基准）
#include <math.h>
#include <stdio.h>
#include <time.h>

#define N 1000

static double evalA(int i, int j) {
  int ij = i + j;
  return 1.0 / ((ij * (ij + 1)) / 2.0 + i + 1);
}

static void multiplyAv(const double *v, double *av) {
  for (int i = 0; i < N; i++) {
    double sum = 0.0;
    for (int j = 0; j < N; j++) sum += evalA(i, j) * v[j];
    av[i] = sum;
  }
}

static void multiplyAtv(const double *v, double *atv) {
  for (int i = 0; i < N; i++) {
    double sum = 0.0;
    for (int j = 0; j < N; j++) sum += evalA(j, i) * v[j];
    atv[i] = sum;
  }
}

static void multiplyAtAv(const double *v, double *atav, double *tmp) {
  multiplyAv(v, tmp);
  multiplyAtv(tmp, atav);
}

int main(void) {
  static double u[N], v[N], tmp[N];
  for (int k = 0; k < N; k++) { u[k] = 1.0; v[k] = 0.0; tmp[k] = 0.0; }

  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  for (int iter = 0; iter < 10; iter++) {
    multiplyAtAv(u, v, tmp);
    multiplyAtAv(v, u, tmp);
  }
  double vBv = 0.0, vv = 0.0;
  for (int i = 0; i < N; i++) { vBv += u[i] * v[i]; vv += v[i] * v[i]; }
  double result = sqrt(vBv / vv);
  clock_gettime(CLOCK_MONOTONIC, &t1);

  long long ms = (t1.tv_sec - t0.tv_sec) * 1000LL +
                 (t1.tv_nsec - t0.tv_nsec) / 1000000LL;
  printf("result=%lld\n", (long long)floor(result * 1e6));
  printf("time=%lld\n", ms);
  return 0;
}
