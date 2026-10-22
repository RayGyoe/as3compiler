// oop.c — 多态虚方法派发 + 对象字段访问（面向对象核心基准）
#include <stdio.h>
#include <time.h>

typedef struct Figure {
  int a;
  int b;
  int (*area)(struct Figure*);
} Figure;

static int circle_area(Figure* f) { return 3 * f->a * f->a + 2 * f->b; }
static int square_area(Figure* f) { return f->a * f->a + f->b; }
static int rect_area(Figure* f) { return f->a * f->b + f->a + f->b; }

int main(void) {
  Figure shapes[192];
  for (int i = 0; i < 64; i++) {
    shapes[i * 3 + 0] = (Figure){ (i % 8) + 1, (i % 6) + 1, circle_area };
    shapes[i * 3 + 1] = (Figure){ (i % 9) + 1, (i % 7) + 1, square_area };
    shapes[i * 3 + 2] = (Figure){ (i % 7) + 1, (i % 5) + 1, rect_area };
  }

  const int N = 20000000;
  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  int sum = 0;
  for (int j = 0; j < N; j++) {
    Figure* s = &shapes[j % 192];
    sum += s->area(s);
    if (sum >= 1000000000) sum -= 1000000000;
  }
  clock_gettime(CLOCK_MONOTONIC, &t1);

  long long ms = (t1.tv_sec - t0.tv_sec) * 1000LL +
                 (t1.tv_nsec - t0.tv_nsec) / 1000000LL;
  printf("result=%d\n", sum);
  printf("time=%lld\n", ms);
  return 0;
}
