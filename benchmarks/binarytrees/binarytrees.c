// binarytrees.c — 递归二叉树分配/遍历（对象分配基准）
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

typedef struct Node { struct Node *left, *right; } Node;

static Node *make(int depth) {
  Node *n = malloc(sizeof(Node));
  if (depth == 0) { n->left = n->right = NULL; }
  else { n->left = make(depth - 1); n->right = make(depth - 1); }
  return n;
}

static int check(Node *n) {
  int total = 1;
  if (n->left) total += check(n->left);
  if (n->right) total += check(n->right);
  return total;
}

static void freeTree(Node *n) {
  if (!n) return;
  freeTree(n->left);
  freeTree(n->right);
  free(n);
}

int main(void) {
  int maxDepth = 14;

  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);

  Node *stretch = make(maxDepth + 1);
  int s = check(stretch);
  freeTree(stretch);

  Node *longLived = make(maxDepth);
  int sum = 0;
  for (int d = 4; d <= maxDepth; d += 2) {
    int n = 1 << (maxDepth - d + 4);
    for (int i = 0; i < n; i++) {
      Node *t = make(d);
      sum += check(t);
      freeTree(t);
    }
  }
  int l = check(longLived);

  clock_gettime(CLOCK_MONOTONIC, &t1);
  long long ms = (t1.tv_sec - t0.tv_sec) * 1000LL +
                 (t1.tv_nsec - t0.tv_nsec) / 1000000LL;
  printf("result=%d,%d,%d\n", s, sum, l);
  printf("time=%lld\n", ms);
  return 0;
}
