// AIR drag-and-drop state lives on the AS3 thread; the OS owns native payloads.
export const NATIVE_DRAG_HEAD = String.raw`
typedef struct sk_drag_data {
    int file_count; const char* const* files; const char* text; const char* url; int local;
} sk_drag_data;
typedef int (*sk_drag_callback)(int, int, uint64_t, double, double, int, int, const sk_drag_data*);
#ifdef ASC_USE_NATIVE_DRAG
extern void sk_drag_init(sk_drag_callback);
extern int sk_drag_supported(void);
extern int sk_drag_begin(int, uint64_t, const sk_drag_data*, int, const unsigned char*, int, int, double, double, double, double);
#else
static void sk_drag_init(sk_drag_callback cb) { (void)cb; }
static int sk_drag_supported(void) { return 0; }
static int sk_drag_begin(int w, uint64_t s, const sk_drag_data* d, int a, const unsigned char* p, int x, int y, double dw, double dh, double ox, double oy) { (void)w;(void)s;(void)d;(void)a;(void)p;(void)x;(void)y;(void)dw;(void)dh;(void)ox;(void)oy;return 0; }
#endif
static int as_nd_mouse_window = -1;
static int as_nd_mouse_depth = 0;
static int as_native_drag_callback(int, int, uint64_t, double, double, int, int, const sk_drag_data*);
static void as_native_drag_clip_access(Clipboard*, int);
static void as_native_drag_retarget(Event*, void*);
`;

export const NATIVE_DRAG_BODY = String.raw`
// Incoming destination and outgoing source are separate: an application can drag
// from one of its windows into another without replacing the source's clipboard.
static Clipboard* as_nd_clip = NULL;
static Clipboard* as_nd_source_clip = NULL;
static InteractiveObject* as_nd_source = NULL;
static InteractiveObject* as_nd_hit = NULL;
static InteractiveObject* as_nd_accepted = NULL;
static NativeDragOptions* as_nd_options = NULL;
static Clipboard* as_nd_current_clip = NULL;
static Event* as_nd_current_event = NULL;
static as_array* as_nd_payload_files = NULL;
static char* as_nd_payload_text = NULL;
static char* as_nd_payload_url = NULL;
static int as_nd_window = -1, as_nd_source_window = -1;
static uint64_t as_nd_serial = 0, as_nd_source_serial = 0, as_nd_next = 0;
static int as_nd_allowed = 0, as_nd_source_allowed = 0;
static int as_nd_action = 0, as_nd_phase = 0, as_nd_event_depth = 0, as_nd_in_native = 0;
static double as_nd_x = 0, as_nd_y = 0;
static void as_native_drag_mark_roots(void) {
    gc_mark_ptr(as_nd_clip); gc_mark_ptr(as_nd_source_clip); gc_mark_ptr(as_nd_source);
    gc_mark_ptr(as_nd_hit); gc_mark_ptr(as_nd_accepted); gc_mark_ptr(as_nd_options);
    gc_mark_ptr(as_nd_current_event); gc_mark_ptr(as_nd_current_clip); gc_mark_ptr(as_nd_payload_files);
    gc_mark_ptr(as_nd_payload_text); gc_mark_ptr(as_nd_payload_url);
}
static int as_nd_bit(const char* action) {
    if (!action || !strcmp(action, "none")) return 0;
    if (!strcmp(action, "copy")) return 1;
    if (!strcmp(action, "move")) return 2;
    if (!strcmp(action, "link")) return 4;
    return -1;
}
static char* as_nd_name(int action) { return (char*)(action == 1 ? "copy" : action == 2 ? "move" : action == 4 ? "link" : "none"); }
static int as_nd_default(int mask) { return mask & 1 ? 1 : mask & 2 ? 2 : mask & 4 ? 4 : 0; }
static NativeDragOptions* as_nd_make_options(int mask) {
    NativeDragOptions* o = NativeDragOptions_new();
    o->allowCopy = (mask & 1) != 0; o->allowMove = (mask & 2) != 0; o->allowLink = (mask & 4) != 0;
    return o;
}
static void as_native_drag_clip_access(Clipboard* o, int operation) {
    if (!o || o->_dragState == 0) return;
    if (o->_dragState == 2 || !as_nd_event_depth || o != as_nd_current_clip)
        as_throw(SecurityError_new((char*)"Drag clipboard is not accessible outside its native drag event.", 0));
    if (operation == 2) as_throw(SecurityError_new((char*)"Drag clipboard is read-only during a drag.", 0));
    if (operation == 1 && as_nd_phase != 4 && !o->_dragLocal)
        as_throw(SecurityError_new((char*)"External drag data is readable only in nativeDragDrop.", 0));
}
static void as_nd_expire(Clipboard* o) {
    if (!o) return;
    o->_dragState = 2; o->_fmts = NULL; o->_vals = NULL; o->_hdl = NULL;
}
static void as_nd_clear_destination(void) {
    if (as_nd_clip != as_nd_source_clip) as_nd_expire(as_nd_clip);
    as_nd_clip = NULL; as_nd_hit = NULL; as_nd_accepted = NULL; as_nd_options = NULL;
    as_nd_window = -1; as_nd_serial = 0; as_nd_allowed = 0;
}
static int as_nd_contains(DisplayObject* parent, DisplayObject* child) {
    for (DisplayObject* p = child; p; p = (DisplayObject*)p->parent) if (p == parent) return 1;
    return 0;
}
static int as_nd_visible(DisplayObject* o, Stage* stage) {
    for (DisplayObject* p = o; p; p = (DisplayObject*)p->parent) {
        if (!p->visible) return 0;
        if (p == (DisplayObject*)stage) return 1;
    }
    return 0;
}
static void as_native_drag_retarget(Event* event, void* target) {
    if (event != as_nd_current_event || !as_is(event, &NativeDragEvent_vt) || !as_is(target, &DisplayObject_vt)) return;
    NativeDragEvent* e = (NativeDragEvent*)event;
    as_local_point((DisplayObject*)target, e->stageX, e->stageY, &e->localX, &e->localY);
}
static int as_nd_emit(InteractiveObject* target, const char* type, int phase, Clipboard* clipboard,
        NativeDragOptions* options, InteractiveObject* related, double x, double y, int mod) {
    if (!target) return 1;
    Clipboard* old_clip = as_nd_current_clip; int old_phase = as_nd_phase;
    as_nd_current_clip = clipboard; as_nd_phase = phase; as_nd_event_depth++;
    double lx = x, ly = y;
    as_local_point((DisplayObject*)target, x, y, &lx, &ly);
    NativeDragEvent* event = NativeDragEvent_new((char*)type, true, phase == 2 || phase == 4 || phase == 7,
        lx, ly, related, clipboard, options, as_nd_name(as_nd_action), (mod & 1) != 0,
        (mod & 2) != 0, (mod & 4) != 0, (mod & 8) != 0);
    event->stageX = x; event->stageY = y;
#ifdef __APPLE__
    event->ctrlKey = event->commandKey;
#endif
    Event* old_event = as_nd_current_event; as_nd_current_event = (Event*)event; gc_write_barrier(event);
    EventDispatcher_dispatchEvent(target, (Event*)event);
    as_nd_current_event = old_event;
    int cancelled = event->cancelled;
    as_nd_event_depth--; as_nd_phase = old_phase; as_nd_current_clip = old_clip;
    return !cancelled;
}
static void as_nd_set_clip(const sk_drag_data* data) {
    if (data && data->local && as_nd_source_clip) { as_nd_clip = as_nd_source_clip; return; }
    as_nd_clip = Clipboard_new(); gc_write_barrier(as_nd_clip);
    if (data) {
        if (data->file_count > 0) {
            as_array* files = as_array_new();
            for (int i = 0; i < data->file_count; i++) {
                if (data->files && data->files[i]) as_array_push(files, as_v_obj(File_new((char*)data->files[i])));
            }
            Clipboard_setData(as_nd_clip, (char*)"fileList", as_v_arr(files), false);
        }
        if (data->text) Clipboard_setData(as_nd_clip, (char*)"text", as_v_str(as_str_dup(data->text)), false);
        if (data->url) Clipboard_setData(as_nd_clip, (char*)"url", as_v_str(as_str_dup(data->url)), false);
    }
    as_nd_clip->_dragState = 1; as_nd_clip->_dragLocal = false;
}
static int as_nd_destination(int win, int phase, uint64_t serial, double x, double y, int mask, int mod, const sk_drag_data* data) {
    ASCWin* w = ASC_w(win);
    if (!w || !w->stage || w->cx == 0 || w->cy == 0) { as_nd_clear_destination(); return 0; }
    double sx = (x - w->ox) / w->cx, sy = (y - w->oy) / w->cy;
    // Only enter opens a destination session. A delayed drop/over must never
    // manufacture a new enter and revive an already-finished gesture.
    if (phase != 1 && phase != 3 && (as_nd_window != win || as_nd_serial != serial)) return 0;
    if (phase == 3 && (as_nd_window != win || (serial && as_nd_serial != serial))) return 0;
    if (phase != 3 && (as_nd_window != win || as_nd_serial != serial)) {
        as_nd_clear_destination(); as_nd_window = win; as_nd_serial = serial;
        as_nd_allowed = mask & 7; as_nd_action = as_nd_default(as_nd_allowed);
        as_nd_set_clip(data);
        as_nd_options = as_nd_make_options(as_nd_allowed); gc_write_barrier(as_nd_options);
    }
    as_nd_allowed = mask & 7; as_nd_x = sx; as_nd_y = sy;
    if (phase == 3) {
        as_nd_emit(as_nd_hit, "nativeDragExit", 3, as_nd_clip, as_nd_options, NULL, sx, sy, mod);
        as_nd_clear_destination(); return 0;
    }
    InteractiveObject* hit = (InteractiveObject*)as_pick_hit(w->stage, sx, sy);
    // ASC_ND_TRACE=1: the drag path has no other window into it. A drop that
    // reaches OLE but never raises an AS3 event is either a stage that is not the
    // one holding the target, a coordinate that misses it, or an empty hit test --
    // these four numbers separate them.
    if (getenv("ASC_ND_TRACE") != NULL)
        fprintf(stderr, "nd phase=%d win=%d x=%.1f y=%.1f sx=%.1f sy=%.1f cx=%.4f cy=%.4f ox=%.1f oy=%.1f stage=%p hit=%p\n",
            phase, win, x, y, sx, sy, w->cx, w->cy, w->ox, w->oy, (void*)w->stage, (void*)hit);
    if (hit != as_nd_hit) {
        InteractiveObject* old = as_nd_hit;
        if (as_nd_accepted && !as_nd_contains((DisplayObject*)as_nd_accepted, (DisplayObject*)hit)) as_nd_accepted = NULL;
        as_nd_emit(old, "nativeDragExit", 3, as_nd_clip, as_nd_options, hit, sx, sy, mod);
        as_nd_hit = hit; gc_write_barrier(hit);
        as_nd_emit(hit, "nativeDragEnter", 1, as_nd_clip, as_nd_options, old, sx, sy, mod);
    }
    if (phase != 4 && !as_nd_emit(hit, "nativeDragOver", 2, as_nd_clip, as_nd_options, NULL, sx, sy, mod)) as_nd_accepted = NULL;
    // User listeners may move/remove/hide/reparent a target. Validate the live
    // tree again; never return an OS acceptance based on a stale pointer.
    hit = (InteractiveObject*)as_pick_hit(w->stage, sx, sy);
    int valid = as_nd_accepted && as_nd_accepted->mouseEnabled &&
        as_nd_visible((DisplayObject*)as_nd_accepted, w->stage) &&
        as_nd_contains((DisplayObject*)as_nd_accepted, (DisplayObject*)hit);
    int action = valid && (as_nd_allowed & as_nd_action) ? as_nd_action : 0;
    if (phase == 4) {
        if (action && !as_nd_emit(as_nd_accepted, "nativeDragDrop", 4, as_nd_clip, as_nd_options, NULL, sx, sy, mod)) action = 0;
        hit = (InteractiveObject*)as_pick_hit(w->stage, sx, sy);
        if (!as_nd_accepted || !as_nd_visible((DisplayObject*)as_nd_accepted, w->stage) ||
            !as_nd_contains((DisplayObject*)as_nd_accepted, (DisplayObject*)hit) || !(as_nd_allowed & as_nd_action)) action = 0;
        else if (action) action = as_nd_action;
        as_nd_clear_destination();
    }
    return action;
}
static void as_nd_end_source(void) {
    as_nd_clear_destination(); if (as_nd_source_clip && as_nd_source_clip->_dragState) as_nd_expire(as_nd_source_clip);
    ASC_mouse_down = 0; ASC_press_gen = 0;
    as_nd_source_clip = NULL; as_nd_source = NULL; as_nd_source_window = -1;
    as_nd_payload_files = NULL; as_nd_payload_text = NULL; as_nd_payload_url = NULL;
    as_nd_source_allowed = 0; as_nd_action = 0;
}
static int as_native_drag_callback(int win, int phase, uint64_t serial, double x, double y, int mask, int mod, const sk_drag_data* data) {
    if (as_nd_in_native) return 0;
    as_nd_in_native = 1;
    int saved_disp = as_disp_depth;
    jmp_buf env; int thrown = AS_SETJMP(env);
    volatile int result = 0;
    if (!thrown) {
        as_jmp_push(&env);
        if (phase == 5 || phase == 6) {
            if (as_nd_source && serial == as_nd_source_serial) {
                ASCWin* w = ASC_w(as_nd_source_window);
                double sx = w && w->cx ? (x - w->ox) / w->cx : x;
                double sy = w && w->cy ? (y - w->oy) / w->cy : y;
                if (phase == 6) as_nd_action = as_nd_default(mask & 7);
                NativeDragOptions* options = as_nd_make_options(as_nd_source_allowed);
                as_nd_emit(as_nd_source, phase == 5 ? "nativeDragUpdate" : "nativeDragComplete", phase,
                    as_nd_source_clip, options, NULL, sx, sy, mod);
                if (phase == 6) as_nd_end_source();
            }
        } else result = as_nd_destination(win, phase, serial, x, y, mask, mod, data);
    }
    as_jmp_pop();
    if (thrown) {
        as_disp_depth = saved_disp; as_nd_event_depth = 0; as_nd_phase = 0; as_nd_current_clip = NULL; as_nd_current_event = NULL;
        as_report_uncaught("native drag listener threw; drag rejected");
        as_exception = NULL; as_exception_boxed = 0;
        as_nd_clear_destination();
        if (phase == 6) as_nd_end_source();
    }
    as_nd_in_native = 0;
    return result;
}
static void as_native_drag_init(void) { sk_drag_init(as_native_drag_callback); }
void NativeDragManager_acceptDragDrop_static(InteractiveObject* target) {
    if (!target) as_throw(TypeError_new((char*)"Error #2007: Parameter target must be non-null.", 2007));
    if (!as_nd_event_depth || (as_nd_phase != 1 && as_nd_phase != 2))
        as_throw(Error_new((char*)"acceptDragDrop requires nativeDragEnter or nativeDragOver.", 0));
    ASCWin* w = ASC_w(as_nd_window);
    if (w && as_nd_visible((DisplayObject*)target, w->stage) && as_nd_contains((DisplayObject*)target, (DisplayObject*)as_nd_hit)) {
        as_nd_accepted = target; gc_write_barrier(target);
    }
}
char* NativeDragManager_get_dropAction_static(void* self) { (void)self; return as_nd_name(as_nd_action); }
void NativeDragManager_set_dropAction_static(void* self, char* value) {
    (void)self; int bit = as_nd_bit(value);
    if (bit < 0) as_throw(ArgumentError_new((char*)"Error #2004: Invalid native drag action.", 2004));
    as_nd_action = bit;
}
InteractiveObject* NativeDragManager_get_dragInitiator_static(void* self) { (void)self; return as_nd_source; }
bool NativeDragManager_get_isDragging_static(void* self) { (void)self; return as_nd_source != NULL || as_nd_clip != NULL; }
bool NativeDragManager_get_isSupported_static(void* self) { (void)self; return sk_drag_supported() != 0; }
void NativeDragManager_doDrag_static(InteractiveObject* initiator, Clipboard* clipboard, BitmapData* image, Point* offset, NativeDragOptions* options) {
    if (!sk_drag_supported()) { as_shell_unsupported((char*)"NativeDragManager.doDrag: native backend unavailable"); return; }
    if (!initiator || !clipboard) as_throw(TypeError_new((char*)"Error #2007: initiator and clipboard must be non-null.", 2007));
    if (!as_nd_mouse_depth || as_nd_source || as_nd_clip) as_throw(Error_new((char*)"doDrag requires a mouseDown/mouseMove gesture and no active drag.", 0));
    ASCWin* w = ASC_w(as_nd_mouse_window);
    if (!w || !w->stage || !as_nd_visible((DisplayObject*)initiator, w->stage)) as_throw(ArgumentError_new((char*)"Drag initiator must be attached to the gesture window.", 2004));
#ifdef _WIN32
    if (image) as_shell_unsupported((char*)"NativeDragManager.doDrag: Windows dragImage is not implemented; using the system cursor");
#endif
    int allowed = options ? (options->allowCopy ? 1 : 0) | (options->allowMove ? 2 : 0) | (options->allowLink ? 4 : 0) : 7;
    as_nd_source = initiator; as_nd_source_clip = clipboard; as_nd_source_window = as_nd_mouse_window;
    as_nd_source_serial = ++as_nd_next; as_nd_source_allowed = allowed; as_nd_action = 0;
    gc_write_barrier(initiator); gc_write_barrier(clipboard);
    int saved_disp = as_disp_depth;
    volatile int started = 0;
    unsigned char* volatile pixels = NULL; const char** volatile paths = NULL;
    jmp_buf env; int thrown = AS_SETJMP(env);
    if (!thrown) {
        as_jmp_push(&env);
        // Render deferred handlers before locking the clipboard for a native drag.
        as_nd_payload_files = NULL; as_nd_payload_text = NULL; as_nd_payload_url = NULL;
        if (Clipboard_hasFormat(clipboard, (char*)"fileList")) {
            as_value files = Clipboard_getData(clipboard, (char*)"fileList", (char*)"originalPreferred");
            if (files.tag != 6) as_throw(TypeError_new((char*)"fileList requires an Array of File objects.", 1034));
            as_nd_payload_files = as_array_new(); gc_write_barrier(as_nd_payload_files);
            as_array* list = (as_array*)files.ptr;
            for (int i = 0; i < list->length; i++) {
                if (list->data[i].tag != 4 || !as_is(list->data[i].ptr, &File_vt)) as_throw(TypeError_new((char*)"fileList requires File objects.", 1034));
                char* path = ((File*)list->data[i].ptr)->_nativePath;
                if (!path) as_throw(ArgumentError_new((char*)"Cannot drag a File without a path.", 2004));
                as_array_push(as_nd_payload_files, as_v_str(as_str_dup(path)));
            }
        }
        if (Clipboard_hasFormat(clipboard, (char*)"text")) as_nd_payload_text = as_v_str_val(Clipboard_getData(clipboard, (char*)"text", (char*)"originalPreferred"));
        if (Clipboard_hasFormat(clipboard, (char*)"url")) as_nd_payload_url = as_v_str_val(Clipboard_getData(clipboard, (char*)"url", (char*)"originalPreferred"));
        gc_write_barrier(as_nd_payload_text); gc_write_barrier(as_nd_payload_url);
        if (!as_nd_payload_files && !as_nd_payload_text && !as_nd_payload_url) as_throw(Error_new((char*)"This native backend supports fileList, text and url drag payloads.", 0));
        clipboard->_dragState = 1; clipboard->_dragLocal = true;
        NativeDragOptions* actual = options ? options : as_nd_make_options(allowed);
        if (as_nd_emit(initiator, "nativeDragStart", 7, clipboard, actual, NULL, w->stage->_mouse_x, w->stage->_mouse_y, 0) && allowed) {
            sk_drag_data data = {0};
            data.file_count = as_nd_payload_files ? as_nd_payload_files->length : 0;
            paths = data.file_count ? (const char**)calloc((size_t)data.file_count, sizeof(char*)) : NULL;
            if (data.file_count && !paths) as_throw(Error_new((char*)"Drag allocation failed.", 0));
            for (int i = 0; i < data.file_count; i++) paths[i] = as_v_str_val(as_nd_payload_files->data[i]);
            data.files = (const char* const*)paths; data.text = as_nd_payload_text; data.url = as_nd_payload_url; data.local = 1;
            int iw = image ? image->width : 0, ih = image ? image->height : 0;
            if (iw < 0 || ih < 0 || (uint64_t)iw * (uint64_t)ih > 16777216) as_throw(ArgumentError_new((char*)"Drag image too large.", 2004));
            if (iw && ih) {
                pixels = (unsigned char*)malloc((size_t)iw * (size_t)ih * 4);
                if (!pixels) as_throw(Error_new((char*)"Drag image allocation failed.", 0));
                for (int y = 0; y < ih; y++) for (int x = 0; x < iw; x++) {
                    unsigned argb = BitmapData_getPixel32(image, x, y); size_t at = ((size_t)y * iw + x) * 4;
                    pixels[at] = (argb >> 16) & 255; pixels[at+1] = (argb >> 8) & 255; pixels[at+2] = argb & 255; pixels[at+3] = argb >> 24;
                }
            }
            started = sk_drag_begin(as_nd_source_window, as_nd_source_serial, &data, allowed, (const unsigned char*)pixels, iw, ih,
                iw * w->cx, ih * w->cy, offset ? offset->x * w->cx : 0, offset ? offset->y * w->cy : 0);
        }
        if (!started) as_nd_emit(initiator, "nativeDragComplete", 6, clipboard, actual, NULL, 0, 0, 0);
    }
    as_jmp_pop(); free((void*)pixels); free((void*)paths);
    if (!started || thrown) {
        as_nd_end_source();
    }
    if (thrown) { as_disp_depth = saved_disp; as_nd_phase = 0; as_nd_event_depth = 0; as_nd_current_clip = NULL; as_nd_current_event = NULL; if (as_exception_boxed) as_throw_val(as_exception_v); else as_throw(as_exception); }
}
`;
