// mandelbrot.c — Mandelbrot 集合计数（浮点内层循环基准）
#include <stdio.h>
#include <time.h>

int main(void) {
  int size = 1500, inside = 0;
  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);

  for (int py = 0; py < size; py++) {
    double ci = 2.0 * py / size - 1.0;
    for (int px = 0; px < size; px++) {
      double cr = 2.0 * px / size - 1.5;
      double zr = 0, zi = 0;
      int k = 0;
      while (k < 50 && zr * zr + zi * zi <= 4.0) {
        double t = zr * zr - zi * zi + cr;
        zi = 2.0 * zr * zi + ci;
        zr = t;
        k++;
      }
      if (k == 50) inside++;
    }
  }

  clock_gettime(CLOCK_MONOTONIC, &t1);
  long long ms = (t1.tv_sec - t0.tv_sec) * 1000LL +
                 (t1.tv_nsec - t0.tv_nsec) / 1000000LL;
  printf("result=%d\n", inside);
  printf("time=%lld\n", ms);
  return 0;
}
