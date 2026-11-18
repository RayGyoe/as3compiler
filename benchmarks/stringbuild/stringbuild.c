// stringbuild.c — 循环字符串累加（`s += "ab"`）基准（C 版）
//
// 被测形态：每轮从空串开始，向同一个串追加 N 次两字节片段，收尾读 length 与
// indexOf。C 侧用「容量翻倍 + realloc」这一 C 程序员写累加时的常规形态——它是
// 摊还 O(1) 的追加，正好作为 AS3 `+=` 的对照基线。
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define N 2000
#define ROUNDS 150

int main(void) {
  long checksum = 0;
  struct timespec t0, t1;

  clock_gettime(CLOCK_MONOTONIC, &t0);
  for (int r = 0; r < ROUNDS; r++) {
    size_t cap = 64, len = 0;
    char *s = (char *)malloc(cap);
    s[0] = 0;
    for (int i = 0; i < N; i++) {
      if (len + 2 + 1 > cap) {
        cap *= 2;
        s = (char *)realloc(s, cap);
      }
      s[len++] = 'a';
      s[len++] = 'b';
      s[len] = 0;
    }
    checksum += (long)len;
    const char *hit = strstr(s, "ba");
    checksum += hit ? (long)(hit - s) : -1;
    free(s);
  }
  clock_gettime(CLOCK_MONOTONIC, &t1);

  long long ms = (t1.tv_sec - t0.tv_sec) * 1000LL + (t1.tv_nsec - t0.tv_nsec) / 1000000LL;
  printf("result=%ld\n", checksum);
  printf("time=%lld\n", ms);
  return 0;
}