#ifndef ASC_NATIVE_DRAG_H
#define ASC_NATIVE_DRAG_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Main UI thread, borrowed UTF-8 for the callback only. No GC pointers.
 * Effects: COPY=1 MOVE=2 LINK=4. Modifiers: CONTROL=1 ALT=2 SHIFT=4 COMMAND=8.
 * Phases: enter=1 over=2 exit=3 drop=4 update=5 complete=6.
 * The callback must synchronously return the chosen effect or zero to reject. */
typedef struct sk_drag_data {
  int file_count;
  const char* const* files;
  const char* text;
  const char* url;
  int local;
} sk_drag_data;
typedef int (*sk_drag_callback)(int, int, uint64_t, double, double, int, int, const sk_drag_data*);
void sk_drag_init(sk_drag_callback callback);
int sk_drag_supported(void);
int sk_drag_attach(int window, void* native_window);
void sk_drag_detach(int window);
int sk_drag_begin(int window, uint64_t serial, const sk_drag_data* data, int allowed,
  const unsigned char* rgba, int width, int height, double display_width,
  double display_height, double offset_x, double offset_y);
#ifdef __cplusplus
}
#endif
#endif
