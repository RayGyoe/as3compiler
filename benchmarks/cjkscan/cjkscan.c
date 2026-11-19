// cjkscan.c — 大 CJK 文本上的 indexOf / lastIndexOf / charCodeAt / substring（C 版）
//
// 与 AS3 侧同构：UTF-8 字节存储，但对外返回的索引是 **UTF-16 码元**（G38 语义），所以每一步
// 都要在「码元 ↔ 字节」之间翻译。本列的算法与修好后的运行时**同一形状**（反向候选扫 + 正向
// 续走游标），因此它代表「同样的语义做得好」的可达上界，而不是另一种语言的天然优势；差的那部分
// 就是「我们还要分配 GC 串」。
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

// --- 码元 ↔ 字节 -------------------------------------------------------------
static const char *g_s;
static size_t g_n;      // 字节数
static long g_u, g_b;   // 游标：码元偏移与对应的字节偏移（总是字符起点）

static size_t width_of(unsigned char b) {
  if (b < 0xC0) return 1;
  if (b < 0xE0) return 2;
  if (b < 0xF0) return 3;
  return 4;
}
static long units_of(const char *s, size_t n) {
  long u = 0;
  for (size_t i = 0; i < n;) {
    size_t w = width_of((unsigned char)s[i]);
    u += (w == 4) ? 2 : 1;
    i += w;
  }
  return u;
}
static void cursor_reset(void) { g_s = NULL; g_u = 0; g_b = 0; }
static void cursor_set(const char *s, long u, size_t b) { g_s = s; g_u = u; g_b = (long)b; }

// 码元索引 -> 字节偏移（字符起点）。
static size_t byte_of_unit(const char *s, size_t n, long u) {
  long cu = 0;
  size_t cb = 0;
  // 游标只能正向续走（与运行时同形）：随机访问落后于游标时从 0 重走。这正是「没有索引」
  // 的固有成本，本列不假装有索引——否则 C 列就成了另一种数据结构，不再可比。
  if (g_s == s && u >= g_u) { cu = g_u; cb = (size_t)g_b; }
  while (cu < u && cb < n) {
    size_t w = width_of((unsigned char)s[cb]);
    cu += (w == 4) ? 2 : 1;
    cb += w;
  }
  cursor_set(s, cu, cb);
  return cb;
}
// 字节偏移 -> 码元索引（游标双向续走）。
static long unit_of_byte(const char *s, size_t n, size_t byteoff) {
  long cu = 0;
  size_t cb = 0;
  if (g_s == s) {
    cu = g_u;
    cb = (size_t)g_b;
    while (cb > byteoff) {  // 反向：退到上一个字符起点
      cb--;
      while (cb > 0 && ((unsigned char)s[cb] & 0xC0) == 0x80) cb--;
      cu -= (width_of((unsigned char)s[cb]) == 4) ? 2 : 1;
    }
  }
  while (cb < byteoff && cb < n) {
    size_t w = width_of((unsigned char)s[cb]);
    cu += (w == 4) ? 2 : 1;
    cb += w;
  }
  cursor_set(s, cu, cb);
  return cu;
}
static long index_of_from(const char *s, size_t n, const char *needle, long from_unit) {
  size_t from_byte = byte_of_unit(s, n, from_unit);
  const char *p = strstr(s + from_byte, needle);
  return p ? unit_of_byte(s, n, (size_t)(p - s)) : -1;
}
// 最后一个**起点** <= from 的匹配：反向扫字节，跳过续字节（续字节永远不是字符起点）。
static long last_index_of_from(const char *s, size_t n, const char *needle, long from_unit) {
  size_t nlen = strlen(needle);
  if (nlen == 0) return from_unit;
  long last = (long)byte_of_unit(s, n, from_unit);
  for (long i = last; i >= 0; i--) {
    if (((unsigned char)s[i] & 0xC0) == 0x80) continue;
    if (s[i] == needle[0] && strncmp(s + i, needle, nlen) == 0) return unit_of_byte(s, n, (size_t)i);
  }
  return -1;
}
static int char_code_at(const char *s, size_t n, long u) {
  size_t b = byte_of_unit(s, n, u);
  if (b >= n) return 0;
  unsigned char c = (unsigned char)s[b];
  if (c < 0x80) return c;
  if (c < 0xE0) return ((int)(c & 0x1F) << 6) | (int)(s[b + 1] & 0x3F);
  if (c < 0xF0) return ((int)(c & 0x0F) << 12) | ((int)(s[b + 1] & 0x3F) << 6) | (int)(s[b + 2] & 0x3F);
  return 0;  // 本夹具只有 BMP 字符；星光面分支不影响本基准的校验和
}
// 码元区间 [a, b) 的字节区间，再算新串的码元数。
static long substring_len(const char *s, size_t n, long a, long b) {
  size_t ba = byte_of_unit(s, n, a);
  size_t bb = byte_of_unit(s, n, b);
  if (bb < ba) { size_t t = ba; ba = bb; bb = t; }
  char buf[256];
  size_t len = bb - ba;
  if (len >= sizeof buf) len = sizeof buf - 1;
  memcpy(buf, s + ba, len);
  buf[len] = 0;
  return units_of(buf, len);
}

int main(void) {
  const char *line = "敏捷的棕色狐狸跳过了那只懒狗用它来测试中日韩文字的码元索引和字节偏移之间的翻译开销六字";
  size_t line_len = strlen(line);          // 129 字节
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
  cursor_reset();

  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  long sum = 0;
  for (int i = 0; i < 100; i++) {
    long p = -1;
    for (int j = 0; j < 40; j++) { p = index_of_from(big, n, "懒狗", p + 1); sum += p; }
  }
  for (int b2 = 0; b2 < 100; b2++) {
    for (int j = 0; j < 40; j++) { sum += last_index_of_from(big, n, "狐狸", 120000 - j); }
  }
  for (int q = 0; q < 20000; q++) { sum += char_code_at(big, n, (long)(q * 5003) % 170000); }
  for (int r = 0; r < 20000; r++) {
    long o = (long)(r * 7919) % 170000;
    sum += substring_len(big, n, o, o + 20);
  }
  clock_gettime(CLOCK_MONOTONIC, &t1);

  double ms = (double)(t1.tv_sec - t0.tv_sec) * 1000.0 + (double)(t1.tv_nsec - t0.tv_nsec) / 1e6;
  printf("result=%ld\n", sum);
  printf("time=%d\n", (int)(ms + 0.5));
  free(big);
  return 0;
}
