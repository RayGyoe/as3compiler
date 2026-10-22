// fib.c — 递归 Fibonacci（整数基准）
#include <stdio.h>
#include <time.h>
static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
int main(void) {
  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  int result = fib(40);
  clock_gettime(CLOCK_MONOTONIC, &t1);
  long long ms = (t1.tv_sec - t0.tv_sec) * 1000LL +
                 (t1.tv_nsec - t0.tv_nsec) / 1000000LL;
  printf("result=%d\n", result);
  printf("time=%lld\n", ms);
  return 0;
}
