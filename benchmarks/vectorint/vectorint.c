// vectorint.c — 静态类型整型向量迭代与累加（Vector.<int> 的 C 对等物：裸 int*）
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

int main(void) {
  const int N = 20000000;
  int* a = (int*)malloc(sizeof(int) * N);
  for (int i = 0; i < N; i++) a[i] = (i * 31) % 997;

  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  int sum = 0;
  for (int j = 0; j < N; j++) {
    sum += a[j];
    if (sum >= 1000000000) sum -= 1000000000;
  }
  clock_gettime(CLOCK_MONOTONIC, &t1);

  long long ms = (t1.tv_sec - t0.tv_sec) * 1000LL +
                 (t1.tv_nsec - t0.tv_nsec) / 1000000LL;
  printf("result=%d\n", sum);
  printf("time=%lld\n", ms);
  free(a);
  return 0;
}