// strings.c — 字符串 split/join/indexOf/toUpperCase/lastIndexOf（字符串分配基准）
// C 无同构字符串库，手写辅助函数模拟与 AS3/JS 相同的操作。
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

// split(" ").join("-")：把空格替换为 '-'
static char *join_dash(const char *s) {
  char *out = strdup(s);
  for (char *p = out; *p; p++)
    if (*p == ' ') *p = '-';
  return out;
}

// indexOf(sub)：返回首次出现位置，未找到返回 -1
static long index_of(const char *s, const char *sub) {
  const char *hit = strstr(s, sub);
  return hit ? (long)(hit - s) : -1;
}

// split(from).join(to)：把 from 全部替换为 to（与 split+join 语义一致）
static char *replace_all(const char *s, const char *from, const char *to) {
  size_t flen = strlen(from), tlen = strlen(to);
  int count = 0;
  const char *scan = s;
  while ((scan = strstr(scan, from)) != NULL) { count++; scan += flen; }
  long long outlen = (long long)strlen(s) + (long long)count * (long long)tlen
                     - (long long)count * (long long)flen + 1;
  char *out = malloc((size_t)outlen);
  char *q = out;
  const char *p = s;
  while (1) {
    const char *hit = strstr(p, from);
    if (!hit) { strcpy(q, p); break; }
    size_t pre = (size_t)(hit - p);
    memcpy(q, p, pre); q += pre;
    memcpy(q, to, tlen); q += tlen;
    p = hit + flen;
  }
  return out;
}

// lastIndexOf(char)：返回最后出现位置，未找到返回 -1
static long last_index_of(const char *s, char c) {
  long last = -1;
  for (long i = 0; s[i]; i++)
    if (s[i] == c) last = i;
  return last;
}

int main(void) {
  const char *text = "the quick brown fox jumps over the lazy dog";
  long checksum = 0;

  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  for (int i = 0; i < 300000; i++) {
    char *joined = join_dash(text);
    checksum += index_of(joined, "fox");

    char *upper = strdup(joined);
    for (char *p = upper; *p; p++) *p = (char)toupper((unsigned char)*p);
    checksum += (long)strlen(upper);

    char *replaced = replace_all(joined, "quick", "slow");
    checksum += last_index_of(replaced, 'o');

    free(joined); free(upper); free(replaced);
  }
  clock_gettime(CLOCK_MONOTONIC, &t1);

  long long ms = (t1.tv_sec - t0.tv_sec) * 1000LL +
                 (t1.tv_nsec - t0.tv_nsec) / 1000000LL;
  printf("result=%ld\n", checksum);
  printf("time=%lld\n", ms);
  return 0;
}
