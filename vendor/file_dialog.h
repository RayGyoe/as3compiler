#ifndef ASC_FILE_DIALOG_H
#define ASC_FILE_DIALOG_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Main UI thread only. UTF-8 inputs are copied before begin returns. The result
 * owns its strings until release; no AS3/GC pointers ever enter the backend.
 * Modes: 1 open, 2 multi-open, 3 directory, 4 save. Status: 1 selected,
 * 0 user cancel, -1 backend error. One native panel at a time. */
int sk_file_dialog_begin(uint64_t serial, int mode, const char* title,
    const char* initial, const char* suggested, int filters,
    const char* const* descriptions, const char* const* extensions);
void sk_file_dialog_cancel(uint64_t serial);
int sk_file_dialog_poll(uint64_t* serial, int* status, int* count);
const char* sk_file_dialog_path(int index);
const char* sk_file_dialog_error(void);
void sk_file_dialog_release(void);
#ifdef __cplusplus
}
#endif
#endif
