// bigscan.c — 大 ASCII 文本上的 indexOf / charAt / lastIndexOf（C 版）
//
// 与 AS3 侧同构：字节存储（UTF-8），但返回的索引是 **UTF-16 码元**。所以每次命中之后
// 都要把字节偏移翻译成码元索引；这里给翻译加同样的 ASCII 快路径（8 字节一字的高位探测），
// 于是本列代表「翻译塌成恒等」的下界，而不是「不做翻译」的另一种语言。
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

// 码元数 = 字节数 - 续字节数 + 星光面字节数（4 字节字符占 2 码元）。
static long units_of(const char *s, size_t n) {
  size_t i = 0;
  long units = (long)n;
  for (; i + 8 <= n; i += 8) {
    uint64_t w;
    memcpy(&w, s + i, 8);
    if (w & 0x8080808080808080ull) goto slow;
  }
  for (; i < n; i++)
    if ((unsigned char)s[i] & 0x80) goto slow;
  return units;
slow:
  units = 0;
  for (i = 0; i < n; i++) {
    unsigned char b = (unsigned char)s[i];
    if (b < 0x80) units += 1;
    else if (b < 0xC0) continue;              // continuation byte: no unit of its own
    else if (b < 0xF0) units += 1;
    else units += 2;                          // 4-byte character == surrogate pair
  }
  return units;
}

// indexOf(value, startIndex) 的码元索引；startIndex 是码元，先翻译成字节再 strstr。
static long index_of_from(const char *s, size_t slen, const char *needle, long from_unit) {
  size_t from_byte = 0;
  if (from_unit > 0) {
    long u = 0;
    while (from_byte < slen && u < from_unit) {
      unsigned char b = (unsigned char)s[from_byte];
      size_t w = b < 0x80 ? 1 : (b < 0xE0 ? 2 : (b < 0xF0 ? 3 : 4));
      from_byte += w;
      u += (w == 4) ? 2 : 1;
    }
  }
  const char *p = strstr(s + from_byte, needle);
  return p ? units_of(s, (size_t)(p - s)) : -1;
}

// lastIndexOf(value, fromIndex)：最后一个**起点** <= from 的匹配。
static long last_index_of_from(const char *s, size_t slen, const char *needle, long from_unit) {
  size_t nlen = strlen(needle);
  if (nlen == 0) return from_unit;
  long best = -1;
  long u = 0;
  for (size_t i = 0; i < slen; i++) {
    unsigned char b = (unsigned char)s[i];
    size_t w = b < 0x80 ? 1 : (b < 0xE0 ? 2 : (b < 0xF0 ? 3 : 4));
    if (u > from_unit) break;
    if (strncmp(s + i, needle, nlen) == 0) best = u;
    i += w - 1;
    u += (w == 4) ? 2 : 1;
  }
  return best;
}

int main(void) {
  const char *line = "the quick brown fox jumps over the lazy dog";
  size_t line_len = strlen(line);
  size_t nlines = 4000;
  size_t cap = nlines * (line_len + 1) + 1;
  char *big = malloc(cap);
  size_t n = 0;
  for (size_t k = 0; k < nlines; k++) {
    memcpy(big + n, line, line_len);
    n += line_len;
    big[n++] = '\n';
  }
  big[n] = 0;

  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  long sum = 0;
  for (int i = 0; i < 200; i++) {
    long p = -1;
    for (int j = 0; j < 40; j++) {
      p = index_of_from(big, n, "lazy", p + 1);
      sum += p;
    }
    // charAt(90000).length 恒为 1（ASCII），这里只做一次下标翻译，取得到即计 1。
    long u = 0;
    size_t b = 0;
    while (b < n && u < 90000) {
      unsigned char c = (unsigned char)big[b];
      size_t w = c < 0x80 ? 1 : (c < 0xE0 ? 2 : (c < 0xF0 ? 3 : 4));
      b += w;
      u += (w == 4) ? 2 : 1;
    }
    sum += 1;
    sum += last_index_of_from(big, n, "fox", 100000);
  }
  clock_gettime(CLOCK_MONOTONIC, &t1);

  double ms = (double)(t1.tv_sec - t0.tv_sec) * 1000.0 + (double)(t1.tv_nsec - t0.tv_nsec) / 1e6;
  printf("result=%ld\n", sum);
  printf("time=%d\n", (int)(ms + 0.5));
  free(big);
  return 0;
}
