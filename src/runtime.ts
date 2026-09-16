// C runtime helpers: the pre-pended preamble providing string concat, type
// boxing, and the vtable-based runtime subtype check used by `is`/`as`.

export const RUNTIME_PREAMBLE = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stddef.h>
#include <math.h>
#include <ctype.h>
#include <setjmp.h>
#include <time.h>
#include <sys/stat.h>
// flash.system.System.privateMemory reads the real process resident size. The
// query API differs per platform: Mach on Apple, PSAPI on Windows, getrusage on
// Linux/other POSIX; WASI has no process-memory API so it degrades (see
// as_system_private_memory below).
#ifdef __APPLE__
#include <mach/mach.h>
#include <mach/mach_init.h>
#elif defined(_WIN32)
#include <windows.h>
#include <psapi.h>
#elif !defined(__wasi__)
#include <sys/resource.h>
#endif
// zlib backs ByteArray.compress/uncompress (a ubiquitous system library, like
// libm). WASI has no zlib, so it is guarded; the compress/uncompress bodies
// degrade to a no-op there.
#ifndef __wasi__
#include <zlib.h>
#endif
// gettimeofday is POSIX-only; WASI has no sys/time.h, so wall-clock time is
// abstracted behind as_now_ms() below and falls back to second precision there.
#ifndef __wasi__
#include <sys/time.h>
#endif

// Wall-clock milliseconds since epoch. Native uses gettimeofday for real ms
// resolution; WASI lacks it, so Date resolution drops to seconds (documented
// subset — the compiler's core is portable C, Date is the one POSIX coupling).
static double as_now_ms(void) {
#ifdef __wasi__
    return (double)time(NULL) * 1000.0;
#else
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (double)tv.tv_sec * 1000.0 + (double)tv.tv_usec / 1000.0;
#endif
}

// flash.utils.getTimer(): milliseconds since the process started. AIR's getTimer
// returns a small, monotonically increasing int (wraps after ~24.8 days), NOT
// the Unix epoch. Subtracting the process start time keeps it within int range
// (the raw epoch milliseconds would overflow int immediately).
static double as_start_ms = 0;
static int as_getTimer(void) {
    if (as_start_ms == 0) as_start_ms = as_now_ms();
    return (int)(as_now_ms() - as_start_ms);
}

// Byte-buffer arena: bump-allocate raw byte storage (ByteArray.data, BitmapData
// pixels, zlib scratch) that is NOT a GC-managed AS3 String. AS3 strings now
// live on the GC heap (see as_str_alloc), so this arena no longer grows with
// string concatenation. Byte buffers grow by doubling and old buffers are not
// reclaimed (a documented subset limitation); they are not the animation leak
// source addressed in stage 57.
#define AS_ARENA_SEG_CAP (1u << 22)
typedef struct as_arena_seg { struct as_arena_seg* next; size_t used; char* buf; } as_arena_seg;
static as_arena_seg* as_arena_head = NULL;
// Scattered malloc()/calloc()/realloc() that lives OUTSIDE the arena (regex
// objects, zlib scratch, JSON builder). Counted so totalMemory reflects all
// runtime-managed heap, not just arena bytes. The arena itself is tracked
// separately via the segment list.
static size_t as_heap_bytes = 0;
static char* as_alloc(size_t n) {
    if (n == 0) n = 1;
    n = (n + 7) & ~(size_t)7;  // align to 8 bytes for embedded structs
    if (n > AS_ARENA_SEG_CAP) { as_heap_bytes += n; return (char*)malloc(n); }  // single oversized allocation
    if (as_arena_head == NULL || as_arena_head->used + n > AS_ARENA_SEG_CAP) {
        as_arena_seg* s = (as_arena_seg*)malloc(sizeof(as_arena_seg));
        s->buf = (char*)malloc(AS_ARENA_SEG_CAP);
        s->used = 0;
        s->next = as_arena_head;
        as_arena_head = s;
    }
    char* p = as_arena_head->buf + as_arena_head->used;
    as_arena_head->used += n;
    return p;
}

// Total bytes currently consumed across all arena segments (the bump-allocated
// working set). Oversized (>4 MiB) allocations bypass the segment list and are
// accounted in as_heap_bytes instead.
static size_t as_arena_used_bytes(void) {
    size_t total = 0;
    for (as_arena_seg* s = as_arena_head; s != NULL; s = s->next) total += s->used;
    return total;
}

// Total capacity the arena has already requested from the OS (fixed segment
// size times segment count). freeMemory = cap - used is the 'requested but
// unused' slack inside those segments.
static size_t as_arena_cap_bytes(void) {
    size_t total = 0;
    for (as_arena_seg* s = as_arena_head; s != NULL; s = s->next) total += AS_ARENA_SEG_CAP;
    return total;
}

// ---------- precise garbage collector (mark-sweep, stage 57) ----------
// A precise (exact) tracing GC. Every GC-managed object carries an external
// header placed immediately BEFORE the object body; gc_alloc returns the body
// address (header stays hidden). Precise means the mark phase never guesses:
// each object's type tag drives how its child pointers are enumerated (see
// gc_mark_children below), and boxed as_value slots are inspected by their tag.
// The heap grows in fixed segments and a free-list reuses swept blocks.
//
// Root set = 'permanent' roots only (see gc_mark_internal_roots + the emitted
// gc_mark_user_roots): the GC runs at a frame-boundary safe point where all
// user frame callbacks have returned, so there are no live stack temporaries
// to register. Objects reachable only from the display list / static fields /
// event registry / timer table stay alive; transient animation objects become
// unreachable and are swept.
typedef struct gc_header {
    struct gc_header* next;  // free-list (when idle) or all-objects list (when live)
    int type;                // GCT_* tag, drives mark traversal
    int color;               // 0 white / 1 grey / 2 black (three-color, GC-4 ready)
    size_t size;             // object body bytes
} gc_header;

typedef struct gc_seg { struct gc_seg* next; char* base; size_t size; } gc_seg;

// GC object type tags.
enum {
    GCT_STRING = 0,      // bare char*, a leaf
    GCT_ARRAY = 1,       // as_array
    GCT_OBJECT = 2,      // as_object (record literal)
    GCT_DICT = 3,        // as_dict (Dictionary)
    GCT_CLOSURE = 4,     // as_closure (function value)
    GCT_CLASS = 5,       // user/builtin class instance (vtable + as_prop reflection)
    GCT_VALUE_ARRAY = 6, // as_value[] buffer (array.data / object.vals / dict.vals)
    GCT_PTR_ARRAY = 7    // void*[] / char*[] buffer (dict.keys / object.keys)
};

#define GC_SEG_SIZE (1u << 20)          // 1 MiB per segment
#define GC_MIN_BLOCK (sizeof(gc_header) + 8)

// Three-color states (GC-4 incremental marking). gc_header.color is one of these.
#define GC_WHITE 0  // not yet reached by the mark phase
#define GC_GREY  1  // reached, children not yet scanned
#define GC_BLACK 2  // reached, children scanned

// Incremental collection phases.
#define GC_IDLE  0
#define GC_MARK  1
#define GC_SWEEP 2

// Incremental marking state (GC-4). Marking is driven by an explicit grey work
// stack (not the C call stack) so it can be paused and resumed across frames at
// the Stage_dispatchFrame safe point. Sweeping walks gc_all with a persistent
// cursor so it too can be sliced across frames.
typedef struct {
    int state;               // GC_IDLE / GC_MARK / GC_SWEEP
    gc_header** grey;        // grey-object work stack (grows on demand)
    int grey_top;            // stack top (a grey object always lives in the stack)
    int grey_cap;            // stack capacity
    size_t budget;           // max objects scanned per gc_step (per frame)
    gc_header* sweep_prev;   // previous node while the incremental sweep walks gc_all
    gc_header* sweep_cursor; // current node while the incremental sweep walks gc_all
} gc_inc_state;

static gc_inc_state gc_inc = { GC_IDLE, NULL, 0, 0, 500, NULL, NULL };
// Objects allocated while a cycle is in progress (MARK/SWEEP). They are born on
// a side list so the sweep cursor walking gc_all is never disturbed by a prepend;
// gc_new is spliced back into gc_all when the cycle completes.
static gc_header* gc_new = NULL;

static gc_seg* gc_segs = NULL;
static gc_header* gc_free = NULL;       // free blocks, first-fit
static gc_header* gc_all = NULL;        // live objects, sweep walks this
static size_t gc_bytes_allocated = 0;   // bytes since last collect (trigger)
static size_t gc_threshold = (1u << 20); // collect when allocated exceeds this

static gc_header* gc_hdr(void* p) {
    return (gc_header*)((char*)p - sizeof(gc_header));
}

static bool gc_in_heap(void* p) {
    if (p == NULL) return false;
    for (gc_seg* s = gc_segs; s != NULL; s = s->next) {
        if ((char*)p >= s->base && (char*)p < s->base + s->size) return true;
    }
    return false;
}

// Push a grey object onto the incremental mark work stack (defined later, near
// the mark phase; forward-declared so gc_alloc's allocation barrier can use it).
static void gc_grey_push(gc_header* h);

// Allocate a GC object of the given type. Returns the object body (header hidden
// before it). The body is zeroed so uninitialized array slots read as tag 0
// (null) during mark, never a stale pointer.
static void* gc_alloc(int type, size_t size) {
    if (size == 0) size = 1;
    size = (size + 7) & ~(size_t)7;
    gc_header* prev = NULL;
    for (gc_header* h = gc_free; h != NULL; prev = h, h = h->next) {
        if (h->size >= size) {
            if (prev) prev->next = h->next; else gc_free = h->next;
            size_t remain = h->size - size;
            if (remain >= GC_MIN_BLOCK) {
                gc_header* rest = (gc_header*)((char*)h + sizeof(gc_header) + size);
                rest->size = remain - sizeof(gc_header);
                rest->next = gc_free;
                gc_free = rest;
                h->size = size;
            }
            h->type = type;
            // Allocation barrier: while a cycle is in progress, new objects are
            // born BLACK on a side list (gc_new) so they survive this cycle and
            // never disturb the sweep walk. Writes into these new objects must
            // go through the write barrier (gc_write_barrier) to grey any WHITE
            // reference, so the mark does not miss it.
            if (gc_inc.state == GC_IDLE) {
                h->next = gc_all;
                gc_all = h;
                h->color = GC_WHITE;
            } else {
                h->next = gc_new;
                gc_new = h;
                h->color = GC_BLACK;
            }
            gc_bytes_allocated += sizeof(gc_header) + h->size;
            void* body = (void*)((char*)h + sizeof(gc_header));
            memset(body, 0, h->size);
            return body;
        }
    }
    // Out of free blocks: carve a fresh segment.
    gc_seg* s = (gc_seg*)malloc(sizeof(gc_seg));
    s->base = (char*)malloc(GC_SEG_SIZE);
    s->size = GC_SEG_SIZE;
    s->next = gc_segs;
    gc_segs = s;
    gc_header* h = (gc_header*)s->base;
    h->size = GC_SEG_SIZE - sizeof(gc_header);
    h->next = gc_free;
    gc_free = h;
    return gc_alloc(type, size);
}

// Live bytes across all GC objects (totalMemory contribution).
static size_t gc_heap_used_bytes(void) {
    size_t total = 0;
    for (gc_header* h = gc_all; h != NULL; h = h->next) total += sizeof(gc_header) + h->size;
    return total;
}
// Total bytes requested from the OS for the GC heap (freeMemory slack).
static size_t gc_heap_total_bytes(void) {
    size_t total = 0;
    for (gc_seg* s = gc_segs; s != NULL; s = s->next) total += s->size;
    return total;
}

// Registered root slots: addresses of global/static variables that hold a raw
// object pointer (e.g. the reused ENTER_FRAME Event). gc_collect marks *slot for
// each entry. Only static-storage slots may be registered (their address is
// process-stable); stack locals never are.
static void*** gc_roots = NULL;  // array of void** slots, each pointing at a raw object pointer
static int gc_root_count = 0;
static int gc_root_cap = 0;
static void gc_root_register(void** slot) {
    if (gc_root_count == gc_root_cap) {
        gc_root_cap = gc_root_cap == 0 ? 64 : gc_root_cap * 2;
        gc_roots = (void***)realloc(gc_roots, gc_root_cap * sizeof(void**));
    }
    gc_roots[gc_root_count++] = slot;
}

// Forward declarations (bodies follow after all runtime structs are defined).
static void gc_mark_ptr(void* p);
static void gc_scan(gc_header* h);
static void gc_write_barrier(void* p);
static void gc_step(void);
static void gc_mark_user_roots(void);
static void gc_collect(void);

// Allocate a GC-managed string of n bytes (the caller writes the trailing NUL).
// Strings are GCT_STRING leaves: they carry no child pointers and are reclaimed
// once no root / reachable object references them (stage 57 GC-2).
static char* as_str_alloc(size_t n) {
    return (char*)gc_alloc(GCT_STRING, n);
}

static char* as_str_concat(const char* a, const char* b) {
    size_t la = strlen(a), lb = strlen(b);
    char* r = as_str_alloc(la + lb + 1);
    memcpy(r, a, la);
    memcpy(r + la, b, lb);
    r[la + lb] = 0;
    return r;
}
static char* as_str_from_int(int v) {
    char* r = as_str_alloc(32);
    snprintf(r, 32, "%d", v);
    return r;
}
static char* as_str_from_uint(unsigned int v) {
    char* r = as_str_alloc(32);
    snprintf(r, 32, "%u", v);
    return r;
}
// Normalize a C "%.*e" exponent in place: "e+06" -> "e+6", "e-07" -> "e-7".
// AS3/ECMAScript scientific notation has no leading zeros in the exponent.
static void as_norm_exp(char* buf) {
    char* e = strchr(buf, 'e');
    if (!e) return;
    int exp = atoi(e + 1);
    char tmp[16];
    snprintf(tmp, sizeof(tmp), "e%+d", exp);
    strcpy(e, tmp);
}
static char* as_str_from_double(double v) {
    // AS3 Number.toString() follows ECMAScript Number::toString: NaN / Infinity /
    // zero are special-cased; otherwise emit the shortest decimal that still
    // round-trips, using fixed notation for 1e-6 <= |v| < 1e21 and scientific
    // notation outside that range (17 significant digits is the maximum a
    // double needs to round-trip). The prior %.*g scan wrongly emitted integers
    // like 30 / 200 as "3e+01" / "2e+02" because %g switches to %e by exponent.
    if (isnan(v)) return "NaN";
    if (isinf(v)) return v > 0 ? "Infinity" : "-Infinity";
    if (v == 0.0) return "0";
    double av = fabs(v);
    bool sci = (av < 1e-6 || av >= 1e21);
    char buf[80];
    for (int prec = 0; prec <= 17; prec++) {
        snprintf(buf, sizeof(buf), sci ? "%.*e" : "%.*f", prec, v);
        if (strtod(buf, NULL) == v) {
            if (sci) as_norm_exp(buf);
            char* r = as_str_alloc(strlen(buf) + 1);
            strcpy(r, buf);
            return r;
        }
    }
    snprintf(buf, sizeof(buf), sci ? "%.17e" : "%.17f", v);
    if (sci) as_norm_exp(buf);
    char* r = as_str_alloc(strlen(buf) + 1);
    strcpy(r, buf);
    return r;
}
static char* as_str_from_bool(bool b) {
    return (char*)(b ? "true" : "false");
}

typedef struct { void* vtable; } as_object_header;
typedef struct { const char* name; void* super; void** ifaces; void* props; void* methods; } as_vtable_header;

// Reflection table entry: one reflectable field of a class. 'type' encodes the
// boxed storage kind (1 number, 2 bool, 3 string, 4 int, 5 uint, 6 ref, 7 any);
// 'offset' is the byte offset of the field within the (flattened) class struct.
typedef struct { const char* name; int type; size_t offset; } as_prop;

// Look up an interface vtable by name from the object's vtable interface list.
// Returns NULL when the object's class does not implement the interface.
static void* as_iface_lookup(void* obj, const char* name) {
    if (obj == NULL) return NULL;
    void* vt = ((as_object_header*)obj)->vtable;
    void** p = ((as_vtable_header*)vt)->ifaces;
    if (p == NULL) return NULL;
    for (int i = 0; p[i] != NULL; i++) {
        if (strcmp(((as_vtable_header*)p[i])->name, name) == 0) return p[i];
    }
    return NULL;
}

static bool as_is(void* obj, void* target_vt) {
    if (obj == NULL) return false;
    void* vt = ((as_object_header*)obj)->vtable;
    while (vt != NULL) {
        if (vt == target_vt) return true;
        vt = ((as_vtable_header*)vt)->super;
    }
    return false;
}
static char* as_obj_to_str(void* obj) {
    if (obj == NULL) return "null";
    void* vt = ((as_object_header*)obj)->vtable;
    return (char*)(vt ? ((as_vtable_header*)vt)->name : "Object");
}

// ---------- dynamic value (box) ----------
// AS3 Array elements (and other dynamically-typed values) are boxed. Scalars
// live in num, strings/objects/arrays in ptr; tag distinguishes the kind.
typedef struct {
    int tag;      // 0 null, 1 number, 2 bool, 3 string, 4 object, 5 undefined, 6 array
    double num;
    void* ptr;
} as_value;

static as_value as_v_null(void)     { as_value v = {0, 0.0, NULL}; return v; }
static as_value as_v_num(double d)  { as_value v = {1, d, NULL}; return v; }
static as_value as_v_bool(bool b)   { as_value v = {2, b ? 1.0 : 0.0, NULL}; return v; }
static as_value as_v_str(char* s)   { as_value v = {3, 0.0, (void*)s}; return v; }
static as_value as_v_obj(void* o)   { as_value v = {4, 0.0, o}; return v; }
static as_value as_v_arr(void* a)   { as_value v = {6, 0.0, a}; return v; }
// Function values need their own tag so typeof can distinguish them from plain
// objects (AS3: typeof function == "function"). The ptr is the as_fn closure.
static as_value as_v_fn(void* f)    { as_value v = {7, 0.0, f}; return v; }

// Write barrier (GC-4 incremental marking, Dijkstra insertion barrier). During
// MARK the mutator runs between gc_step slices; a write of a still-WHITE pointer
// must grey it so the mark does not miss the edge. Outside MARK this is one int
// compare (near-zero cost). gc_write_barrier handles raw pointers (dict keys,
// direct field writes); gc_write_barrier_value handles boxed as_value slots.
static void gc_write_barrier(void* p) {
    if (gc_inc.state != GC_MARK) return;
    if (p == NULL || !gc_in_heap(p)) return;
    gc_header* h = gc_hdr(p);
    if (h->color == GC_WHITE) { h->color = GC_GREY; gc_grey_push(h); }
}
static void gc_write_barrier_value(as_value v) {
    if (gc_inc.state != GC_MARK) return;
    if (v.tag == 3 || v.tag == 4 || v.tag == 6 || v.tag == 7) gc_write_barrier(v.ptr);
}

// GC mark of a boxed value (declared here, after as_value is defined).
static void gc_mark_value(as_value v);

static double as_v_num_val(as_value v)  { return v.num; }
static int as_v_int_val(as_value v)     { return (int)v.num; }
static unsigned as_v_uint_val(as_value v) { return (unsigned)v.num; }
static bool as_v_bool_val(as_value v)   { return v.num != 0.0; }
// AS3 truthiness for condition contexts (if/while/?:/&&/||): null and undefined
// are falsy; numbers/booleans are tested by non-zero; empty string is falsy;
// objects/arrays are truthy when non-null.
static bool as_v_truthy(as_value v) {
    switch (v.tag) {
        case 0:
        case 5: return false;
        case 1:
        case 2: return v.num != 0.0;
        case 3: return v.ptr != NULL && ((char*)v.ptr)[0] != 0;
        case 4:
        case 6:
        case 7: return v.ptr != NULL; // functions are truthy when non-null
        default: return false;
    }
}

// Reflection table entry for one dynamically-callable method. 'fn' takes the
// receiver plus a uniform boxed argument list and returns a boxed result, so
// any method can be invoked through a single as_dyn_call dispatch point.
typedef struct { const char* name; as_value (*fn)(void* _this, as_value* args, int argc); } as_method;

// Dynamically invoke a method by name on any object, walking the vtable super
// chain to find the first method-reflection table (if any) that declares it.
// Returns as_v_null() when the object is NULL or has no such method.
static as_value as_dyn_call(void* obj, const char* name, as_value* args, int argc) {
    if (obj == NULL) return as_v_null();
    void* vt = ((as_object_header*)obj)->vtable;
    while (vt != NULL) {
        as_method* methods = (as_method*)((as_vtable_header*)vt)->methods;
        if (methods != NULL) {
            for (int i = 0; methods[i].name != NULL; i++) {
                if (strcmp(methods[i].name, name) == 0) {
                    return methods[i].fn(obj, args, argc);
                }
            }
        }
        vt = ((as_vtable_header*)vt)->super;
    }
    return as_v_null();
}
static void* as_v_obj_val(as_value v)   { return v.ptr; }
static char* as_v_str_val(as_value v) {
    switch (v.tag) {
        case 3: return (char*)v.ptr;
        case 1: return as_str_from_double(v.num);
        case 2: return as_str_from_bool(v.num != 0.0);
        case 0: return "null";
        case 4: return "object";
        case 5: return "undefined";
        case 6: return "[Array]";
        case 7: return "[Function]";
        default: return "";
    }
}
// Primitive is checks on boxed values. Scalars box into as_value where all
// numerics share tag 1, so int/uint/Number are not distinguished at runtime
// (documented subset limitation).
static bool as_v_is_number(as_value v) { return v.tag == 1; }
static bool as_v_is_bool(as_value v)   { return v.tag == 2; }
static bool as_v_is_string(as_value v) { return v.tag == 3; }
static bool as_v_is_object(as_value v) { return v.tag == 4 || v.tag == 6; }
// Boxed 'any' instance-of check against a concrete class vtable. Only object/
// array tags carry a vtable pointer; all other boxed values are not instances.
static bool as_v_is_inst(as_value v, void* target_vt) {
    return (v.tag == 4 || v.tag == 6) && as_is(as_v_obj_val(v), target_vt);
}
// Primitive as casts on boxed values: return the value when the tag matches,
// otherwise the primitive's default (0 / false / NULL).
static int as_v_as_int(as_value v)      { return v.tag == 1 ? (int)v.num : 0; }
static unsigned as_v_as_uint(as_value v) { return v.tag == 1 ? (unsigned)v.num : 0; }
static double as_v_as_number(as_value v) { return v.tag == 1 ? v.num : 0.0; }
static bool as_v_as_bool(as_value v)    { return v.tag == 2 ? (v.num != 0.0) : false; }
static char* as_v_as_string(as_value v) { return v.tag == 3 ? (char*)v.ptr : NULL; }
static bool as_v_eq(as_value a, as_value b) {
    if (a.tag != b.tag) {
        // AS3 loose equality: undefined == null is true.
        return (a.tag == 0 && b.tag == 5) || (a.tag == 5 && b.tag == 0);
    }
    switch (a.tag) {
        case 0:
        case 5: return true;
        case 1: return a.num == b.num;
        case 2: return (a.num != 0.0) == (b.num != 0.0);
        case 3: return strcmp((char*)a.ptr, (char*)b.ptr) == 0;
        case 4:
        case 6:
        case 7: return a.ptr == b.ptr;
        default: return false;
    }
}

// ---------- function values ----------
// A function value is a pointer to a closure record: a thunk (unboxing as_value[]
// arguments, calling the typed implementation, boxing the result) plus an optional
// captured-environment pointer. Non-capturing functions use env = NULL.
typedef as_value (*as_fn_impl)(void* env, as_value* args, int argc);
typedef struct {
    as_fn_impl fn;
    void* env;
} as_closure;
typedef as_closure* as_fn;
static as_fn as_fn_make(as_fn_impl fn, void* env) {
    as_fn f = (as_fn)gc_alloc(GCT_CLOSURE, sizeof(as_closure));
    f->fn = fn;
    f->env = env;
    return f;
}

// ---------- setTimeout / clearTimeout ----------
// AS3 flash.utils.setTimeout(closure, delay, ...) schedules a Function call after
// 'delay' milliseconds and returns a uint timer id; clearTimeout(id) cancels it.
// Timers are driven by the frame tick (Stage_dispatchFrame), the same loop that
// fires ENTER_FRAME, so callbacks run from the event loop like AIR's timer
// system. Deadline is wall-clock ms (as_now_ms basis) so delays are real time,
// independent of the frame cadence.
typedef struct {
    unsigned int id;
    double deadline;
    as_fn fn;
    int alive;
} as_timer;

static as_timer* as_timers = NULL;
static int as_timer_count = 0;
static int as_timer_cap = 0;
static unsigned int as_timer_next_id = 1;

static unsigned int as_set_timeout(as_fn fn, double delay) {
    if (fn == NULL || fn->fn == NULL) return 0;
    if (as_timer_count == as_timer_cap) {
        as_timer_cap = as_timer_cap == 0 ? 8 : as_timer_cap * 2;
        as_timers = (as_timer*)realloc(as_timers, (size_t)as_timer_cap * sizeof(as_timer));
    }
    as_timer* t = &as_timers[as_timer_count++];
    t->id = as_timer_next_id++;
    t->deadline = as_now_ms() + delay;
    t->fn = fn;
    t->alive = 1;
    return t->id;
}

static void as_clear_timeout(unsigned int id) {
    for (int i = 0; i < as_timer_count; i++) {
        if (as_timers[i].id == id) { as_timers[i].alive = 0; return; }
    }
}

// forward decl: defined below (after the repeat-timer pool).
static void as_rep_timer_tick(void);

// Fire due timers. Called once per frame tick. A timer fires when wall-clock time
// has reached its deadline. The fn/env are copied out and the slot marked dead
// BEFORE invoking, so a callback that reschedules (realloc moves the array) or
// clears another timer never leaves a dangling pointer dereferenced afterwards.
static void as_timer_tick(void) {
    double now = as_now_ms();
    for (int i = 0; i < as_timer_count; i++) {
        as_timer* t = &as_timers[i];
        if (t->alive && now >= t->deadline) {
            as_fn f = t->fn;
            t->alive = 0;
            f->fn(f->env, NULL, 0);
        }
    }
    as_rep_timer_tick();
}

// ---------- flash.utils.Timer (repeating timer) ----------
// Timer repeats every 'delay' ms and dispatches TimerEvent.TIMER. The runtime
// preamble precedes the generated Timer struct/methods, so the pool stores a raw
// object pointer plus a fire callback; the callback (Timer__on_tick) is emitted
// later and passed in at start() time. Each entry's obj is a GC-managed Timer
// instance and is marked as a root in gc_mark_internal_roots.
typedef struct {
    void* obj;
    void (*on_fire)(void*);
    double next_fire;
    int alive;
} as_rep_timer;

static as_rep_timer* as_rep_timers = NULL;
static int as_rep_timer_count = 0;
static int as_rep_timer_cap = 0;

static void as_rep_timer_add(void* obj, double delay, void (*on_fire)(void*)) {
    if (as_rep_timer_count == as_rep_timer_cap) {
        as_rep_timer_cap = as_rep_timer_cap == 0 ? 8 : as_rep_timer_cap * 2;
        as_rep_timers = (as_rep_timer*)realloc(as_rep_timers, (size_t)as_rep_timer_cap * sizeof(as_rep_timer));
    }
    as_rep_timer* t = &as_rep_timers[as_rep_timer_count++];
    t->obj = obj;
    t->on_fire = on_fire;
    t->next_fire = as_now_ms() + delay;
    t->alive = 1;
}

static void as_rep_timer_cancel(void* obj) {
    for (int i = 0; i < as_rep_timer_count; i++) {
        if (as_rep_timers[i].obj == obj) { as_rep_timers[i].alive = 0; return; }
    }
}

// Fire due repeating timers. Copy out obj/on_fire before invoking because the
// callback (re-arm) may realloc the pool (moving the array).
static void as_rep_timer_tick(void) {
    double now = as_now_ms();
    for (int i = 0; i < as_rep_timer_count; i++) {
        as_rep_timer* rt = &as_rep_timers[i];
        if (rt->alive && now >= rt->next_fire) {
            rt->alive = 0;
            void (*on_fire)(void*) = rt->on_fire;
            void* obj = rt->obj;
            on_fire(obj);
        }
    }
}

// ---------- flash.display.MovieClip (frame timeline) ----------
// Playing MovieClips advance one frame per frame tick (ENTER_FRAME-aligned, not
// wall-clock like Timer). The preamble precedes the generated MovieClip struct, so
// the pool stores a raw object pointer + advance callback; MovieClip__on_frame is
// emitted later and passed in at play()/gotoAndPlay() time. Each obj is GC-managed
// and marked as a root in gc_mark_internal_roots.
typedef struct {
    void* obj;
    void (*on_frame)(void*);
    int alive;
} as_mc;

static as_mc* as_mcs = NULL;
static int as_mc_count = 0;
static int as_mc_cap = 0;

static void as_mc_add(void* obj, void (*on_frame)(void*)) {
    // Re-registering the same object (play() called while already playing) updates
    // the callback in place instead of growing the pool with a duplicate slot.
    for (int i = 0; i < as_mc_count; i++) {
        if (as_mcs[i].alive && as_mcs[i].obj == obj) { as_mcs[i].on_frame = on_frame; return; }
    }
    if (as_mc_count == as_mc_cap) {
        as_mc_cap = as_mc_cap == 0 ? 8 : as_mc_cap * 2;
        as_mcs = (as_mc*)realloc(as_mcs, (size_t)as_mc_cap * sizeof(as_mc));
    }
    as_mc* m = &as_mcs[as_mc_count++];
    m->obj = obj;
    m->on_frame = on_frame;
    m->alive = 1;
}

static void as_mc_cancel(void* obj) {
    for (int i = 0; i < as_mc_count; i++) {
        if (as_mcs[i].obj == obj) { as_mcs[i].alive = 0; return; }
    }
}

// Advance every playing MovieClip by one frame. The advance callback only mutates
// the clip's own fields (no realloc of the pool), so direct in-place iteration is
// safe.
static void as_mc_tick(void) {
    for (int i = 0; i < as_mc_count; i++) {
        as_mc* m = &as_mcs[i];
        if (m->alive) m->on_frame(m->obj);
    }
}

// ---------- class reference ----------
// AS3 Class values (obtained via 'x as Class') can be dynamically instantiated
// with 'new (classRef)()'. A class reference carries the class vtable plus a
// no-arg factory that heap-allocates and constructs an instance. Factories are
// emitted per user class; built-ins that are never reflected stay NULL.
typedef struct {
    void* vtable;
    void* (*factory)(void);
} as_class;

// Unbox a class reference stored as an object; non-object values yield NULL.
static as_class* as_v_as_class(as_value v) {
    return (v.tag == 4 || v.tag == 6) ? (as_class*)as_v_obj_val(v) : NULL;
}

// ---------- dynamic array ----------
// AS3 Array is a dynamically-growing, heterogeneously-typed sequence.
typedef struct {
    as_value* data;
    int length;
    int capacity;
    int index;      // RegExp exec/match result: match start position
    char* input;    // RegExp exec/match result: the input string
} as_array;

static as_array* as_array_new(void) {
    as_array* a = (as_array*)gc_alloc(GCT_ARRAY, sizeof(as_array));
    a->data = NULL;
    a->length = 0;
    a->capacity = 0;
    a->index = 0;
    a->input = NULL;
    return a;
}
static as_array* as_array_make(int n, as_value* items) {
    as_array* a = (as_array*)gc_alloc(GCT_ARRAY, sizeof(as_array));
    a->length = n;
    a->capacity = n;
    a->data = n > 0 ? (as_value*)gc_alloc(GCT_VALUE_ARRAY, sizeof(as_value) * (size_t)n) : NULL;
    for (int i = 0; i < n; i++) a->data[i] = items[i];
    a->index = 0;
    a->input = NULL;
    return a;
}

// Function.apply(thisArg, argsArray): invoke a boxed function with the elements
// of an Array as its argument list. AS3 non-method functions ignore the receiver
// (thisArg), matching how the emitted thunks only read (env, args, argc).
static as_value as_fn_apply(as_fn f, as_array* args) {
    if (f == NULL || f->fn == NULL) return as_v_null();
    return f->fn(f->env, (args && args->length > 0) ? args->data : NULL, args ? args->length : 0);
}
static as_value as_fn_apply_v(as_value fbox, as_value argsbox) {
    if (fbox.tag != 7) return as_v_null();
    as_fn f = (as_fn)as_v_obj_val(fbox);
    as_array* args = (argsbox.tag == 6) ? (as_array*)as_v_obj_val(argsbox) : NULL;
    return as_fn_apply(f, args);
}
// Invoke a boxed function with a raw boxed argument list (used by dynamic
// dispatch like obj[type](...) where the callee's static type is 'any').
static as_value as_fn_call_dyn(as_value fbox, as_value* args, int argc) {
    if (fbox.tag != 7) return as_v_null();
    as_fn f = (as_fn)as_v_obj_val(fbox);
    if (f == NULL || f->fn == NULL) return as_v_null();
    return f->fn(f->env, args, argc);
}
// new Array(n): a single integer argument builds a length-n array whose slots
// are all undefined (tag 5), not a one-element array containing n.
static as_array* as_array_new_sized(int n) {
    as_array* a = as_array_new();
    if (n <= 0) return a;
    a->length = n;
    a->capacity = n;
    a->data = (as_value*)gc_alloc(GCT_VALUE_ARRAY, sizeof(as_value) * (size_t)n);
    for (int i = 0; i < n; i++) { as_value v = {5, 0.0, NULL}; a->data[i] = v; }
    return a;
}
static void as_array_ensure(as_array* a, int need) {
    if (need <= a->capacity) return;
    int cap = a->capacity == 0 ? 8 : a->capacity;
    while (cap < need) cap *= 2;
    // GC cannot realloc in place; allocate a fresh value buffer and copy. The
    // old buffer becomes unreachable garbage and is reclaimed by the next sweep.
    as_value* nd = (as_value*)gc_alloc(GCT_VALUE_ARRAY, sizeof(as_value) * (size_t)cap);
    if (a->data != NULL && a->length > 0)
        memcpy(nd, a->data, sizeof(as_value) * a->length);
    a->data = nd;
    a->capacity = cap;
}
static as_value as_array_get(as_array* a, int i) {
    if (i < 0 || i >= a->length) return as_v_null();
    return a->data[i];
}
static as_value as_array_set(as_array* a, int i, as_value v) {
    if (i < 0) return v;
    as_array_ensure(a, i + 1);
    if (i >= a->length) a->length = i + 1;
    a->data[i] = v;
    gc_write_barrier_value(v);
    return v;
}
static int as_array_push(as_array* a, as_value v) {
    as_array_ensure(a, a->length + 1);
    a->data[a->length++] = v;
    gc_write_barrier_value(v);
    return a->length;
}
static as_value as_array_pop(as_array* a) {
    if (a->length == 0) return as_v_null();
    return a->data[--a->length];
}
static as_value as_array_shift(as_array* a) {
    if (a->length == 0) return as_v_null();
    as_value v = a->data[0];
    for (int i = 0; i < a->length - 1; i++) a->data[i] = a->data[i + 1];
    a->length--;
    return v;
}
static int as_array_unshift(as_array* a, as_value v) {
    as_array_ensure(a, a->length + 1);
    for (int i = a->length; i > 0; i--) a->data[i] = a->data[i - 1];
    a->data[0] = v;
    a->length++;
    gc_write_barrier_value(v);
    return a->length;
}
static int as_array_indexOf(as_array* a, as_value v) {
    for (int i = 0; i < a->length; i++) {
        if (as_v_eq(a->data[i], v)) return i;
    }
    return -1;
}
static char* as_array_join(as_array* a, const char* sep) {
    if (a->length == 0) return (char*)"";
    // Two passes: first measure total length, then copy with a running pointer.
    // This avoids a temporary parts array (one less malloc per join) and stays
    // O(n); strcat would re-scan from the start each time and become O(n^2).
    size_t total = 0;
    for (int i = 0; i < a->length; i++) total += strlen(as_v_str_val(a->data[i]));
    size_t seplen = strlen(sep);
    char* r = as_str_alloc(total + seplen * (a->length - 1) + 1);
    char* p = r;
    for (int i = 0; i < a->length; i++) {
        if (i > 0) { memcpy(p, sep, seplen); p += seplen; }
        char* s = as_v_str_val(a->data[i]);
        size_t n = strlen(s);
        memcpy(p, s, n);
        p += n;
    }
    *p = 0;
    return r;
}
// Dynamic .length / .join(...) on an 'any' value: dispatch at runtime on the
// boxed tag (string length, array length/join; everything else -> 0/empty).
static int as_any_length(as_value v) {
    if (v.tag == 6) return ((as_array*)v.ptr)->length;
    if (v.tag == 3) return (int)strlen((char*)v.ptr);
    return 0;
}
static char* as_any_join(as_value v, const char* sep) {
    if (v.tag == 6) return as_array_join((as_array*)v.ptr, sep);
    return (char*)"";
}
static as_array* as_array_slice(as_array* a, int from, int to) {
    if (from < 0) from = 0;
    if (to > a->length) to = a->length;
    int n = to - from;
    if (n <= 0) return as_array_new();
    as_value* items = (as_value*)malloc(sizeof(as_value) * n);
    for (int i = 0; i < n; i++) items[i] = a->data[from + i];
    as_array* r = as_array_make(n, items);
    free(items);
    return r;
}
static as_array* as_array_concat(as_array* a, as_array* b) {
    as_array* r = as_array_new();
    for (int i = 0; i < a->length; i++) as_array_push(r, a->data[i]);
    for (int i = 0; i < b->length; i++) as_array_push(r, b->data[i]);
    return r;
}
static as_array* as_array_splice(as_array* a, int start, int deleteCount, as_value* items, int itemCount) {
    if (start < 0) start = 0;
    if (start > a->length) start = a->length;
    if (deleteCount < 0) deleteCount = 0;
    if (deleteCount > a->length - start) deleteCount = a->length - start;
    as_array* removed = as_array_new();
    for (int i = 0; i < deleteCount; i++) as_array_push(removed, a->data[start + i]);
    int tail = a->length - start - deleteCount;
    int delta = itemCount - deleteCount;
    as_array_ensure(a, a->length + delta);
    if (tail > 0) memmove(&a->data[start + itemCount], &a->data[start + deleteCount], sizeof(as_value) * tail);
    for (int i = 0; i < itemCount; i++) a->data[start + i] = items[i];
    a->length += delta;
    return removed;
}

// Array higher-order methods (map/filter) and sorting (sort/reverse). Callbacks
// are as_fn closure pointers invoked with AS3's (element, index, array)
// argument layout; sort shares one stable insertion-sort core across three
// comparator flavors (string default / numeric / custom function).
typedef int (*as_cmp_fn)(as_value a, as_value b, void* ctx);

static int as_cmp_str(as_value a, as_value b, void* ctx) {
    (void)ctx;
    return strcmp(as_v_str_val(a), as_v_str_val(b));
}
static int as_cmp_num(as_value a, as_value b, void* ctx) {
    (void)ctx;
    double na = as_v_num_val(a);
    double nb = as_v_num_val(b);
    if (na < nb) return -1;
    if (na > nb) return 1;
    return 0;
}
// Custom comparator: AS3's compare(a,b) returns a Number whose sign selects the
// order (negative = a before b). Map that sign onto the insertion-sort result.
static int as_cmp_cb(as_value a, as_value b, void* ctx) {
    as_fn cb = (as_fn)ctx;
    as_value args[2] = { a, b };
    double d = as_v_num_val(cb->fn(cb->env, args, 2));
    if (d < 0.0) return -1;
    if (d > 0.0) return 1;
    return 0;
}

// Stable insertion sort over the raw as_value buffer. O(n^2) worst case but
// simple and dependency-free — sufficient for the teaching-compiler subset.
static void as_array_sort_impl(as_array* a, as_cmp_fn cmp, void* ctx) {
    for (int i = 1; i < a->length; i++) {
        as_value key = a->data[i];
        int j = i - 1;
        while (j >= 0 && cmp(a->data[j], key, ctx) > 0) {
            a->data[j + 1] = a->data[j];
            j--;
        }
        a->data[j + 1] = key;
    }
}

// map(callback): apply callback(element, index, array) and collect the results.
static as_array* as_array_map(as_array* a, as_fn cb) {
    as_array* r = as_array_new();
    as_value args[3];
    args[2] = as_v_obj((void*)a);
    for (int i = 0; i < a->length; i++) {
        args[0] = a->data[i];
        args[1] = as_v_num((double)i);
        as_array_push(r, cb->fn(cb->env, args, 3));
    }
    return r;
}

// filter(callback): keep elements where callback(element, index, array) is truthy.
static as_array* as_array_filter(as_array* a, as_fn cb) {
    as_array* r = as_array_new();
    as_value args[3];
    args[2] = as_v_obj((void*)a);
    for (int i = 0; i < a->length; i++) {
        args[0] = a->data[i];
        args[1] = as_v_num((double)i);
        if (as_v_bool_val(cb->fn(cb->env, args, 3))) {
            as_array_push(r, a->data[i]);
        }
    }
    return r;
}

// reverse(): in-place reversal, returning the same array (AS3 semantics).
static as_array* as_array_reverse(as_array* a) {
    for (int i = 0, j = a->length - 1; i < j; i++, j--) {
        as_value t = a->data[i];
        a->data[i] = a->data[j];
        a->data[j] = t;
    }
    return a;
}

// sort(): three flavors share one insertion-sort core. Default sorts by string
// (AS3), Array.NUMERIC by numeric value, and a Function argument as comparator.
static as_array* as_array_sort_str(as_array* a) { as_array_sort_impl(a, as_cmp_str, NULL); return a; }
static as_array* as_array_sort_num(as_array* a) { as_array_sort_impl(a, as_cmp_num, NULL); return a; }
static as_array* as_array_sort_cb(as_array* a, as_fn cb) { as_array_sort_impl(a, as_cmp_cb, (void*)cb); return a; }

// ---------- object literal (associative map) ----------
// AS3 object literals like { x: 1, y: "a" } are simplified here to a string-keyed
// associative map. It carries a vtable header (pointing at as_object_vt) so the
// dynamic-access runtime (as_dyn_get/set) can tell a dynamic record apart from a
// real class instance by walking the same vtable layout used by every object.
static as_vtable_header as_object_vt = { "Object", NULL, NULL, NULL, NULL };

typedef struct {
    void* vtable;
    char** keys;
    as_value* vals;
    int length;
    int capacity;
} as_object;

static as_object* as_object_new(void) {
    as_object* o = (as_object*)gc_alloc(GCT_OBJECT, sizeof(as_object));
    o->vtable = (void*)&as_object_vt;
    o->keys = NULL;
    o->vals = NULL;
    o->length = 0;
    o->capacity = 0;
    return o;
}
static int as_object_find(as_object* o, const char* key) {
    for (int i = 0; i < o->length; i++) {
        if (strcmp(o->keys[i], key) == 0) return i;
    }
    return -1;
}
static as_value as_object_get(as_object* o, const char* key) {
    int i = as_object_find(o, key);
    return i < 0 ? as_v_null() : o->vals[i];
}
// 'key in object' membership test (AS3 'in' operator).
static bool as_object_has(as_object* o, const char* key) {
    return as_object_find(o, key) >= 0;
}
// AS3 delete: remove the key, returning whether it was present.
static bool as_object_del(as_object* o, const char* key) {
    int i = as_object_find(o, key);
    if (i < 0) return false;
    // Shift the tail left by one (keys/vals are parallel arrays).
    for (int j = i; j < o->length - 1; j++) {
        o->keys[j] = o->keys[j + 1];
        o->vals[j] = o->vals[j + 1];
    }
    o->length--;
    return true;
}
// AS3 typeof: returns the runtime type tag as a string. Matches ES3/AS3
// semantics for the boxed subset ("number"/"string"/"boolean"/"object"/
// "function"/"undefined").
static char* as_v_typeof(as_value v) {
    switch (v.tag) {
        case 1: return "number";
        case 2: return "boolean";
        case 3: return "string";
        case 4: return "object";
        case 6: return "object";
        case 7: return "function";
        case 0: return "object"; // AS3: typeof null == "object" (ES3 quirk)
        default: return "undefined";
    }
}
static as_value as_object_set(as_object* o, const char* key, as_value v) {
    int i = as_object_find(o, key);
    if (i >= 0) {
        o->vals[i] = v;
        gc_write_barrier_value(v);
        return v;
    }
    if (o->length == o->capacity) {
        int cap = o->capacity == 0 ? 8 : o->capacity * 2;
        // GC cannot realloc in place; allocate fresh parallel arrays and copy.
        // The old arrays become garbage and are reclaimed by the next sweep.
        char** nk = (char**)gc_alloc(GCT_PTR_ARRAY, sizeof(char*) * (size_t)cap);
        as_value* nv = (as_value*)gc_alloc(GCT_VALUE_ARRAY, sizeof(as_value) * (size_t)cap);
        if (o->length > 0) {
            memcpy(nk, o->keys, sizeof(char*) * (size_t)o->length);
            memcpy(nv, o->vals, sizeof(as_value) * (size_t)o->length);
        }
        o->keys = nk;
        o->vals = nv;
        o->capacity = cap;
    }
    o->keys[o->length] = (char*)key;
    o->vals[o->length] = v;
    o->length++;
    gc_write_barrier((void*)key);
    gc_write_barrier_value(v);
    return v;
}
static as_object* as_object_make(int n, char** keys, as_value* vals) {
    as_object* o = as_object_new();
    for (int i = 0; i < n; i++) as_object_set(o, keys[i], vals[i]);
    return o;
}

// ---------- dynamic property access (obj[key] reflection) ----------
// AS3's root Object is dynamic: obj[key] on an Object-typed value may be a
// record slot lookup OR a reflectable field of a real class instance. as_dyn_get
// walks the vtable's super chain looking for a field named 'key'; when none is
// found and the object is a dynamic record (as_object_vt), it falls back to the
// record's string-keyed slot table. Used by obj[key] where the receiver's static
// type is 'Object'.
static as_value as_dyn_get(void* obj, const char* key) {
    if (obj == NULL) return as_v_null();
    void* vt = ((as_object_header*)obj)->vtable;
    while (vt != NULL) {
        as_prop* props = (as_prop*)((as_vtable_header*)vt)->props;
        if (props != NULL) {
            for (int i = 0; props[i].name != NULL; i++) {
                if (strcmp(props[i].name, key) == 0) {
                    char* base = (char*)obj;
                    switch (props[i].type) {
                        case 1: return as_v_num(*(double*)(base + props[i].offset));
                        case 2: return as_v_bool(*(bool*)(base + props[i].offset));
                        case 3: return as_v_str(*(char**)(base + props[i].offset));
                        case 4: return as_v_num((double)(*(int*)(base + props[i].offset)));
                        case 5: return as_v_num((double)(*(unsigned*)(base + props[i].offset)));
                        case 6: return as_v_obj(*(void**)(base + props[i].offset));
                        case 7: return *(as_value*)(base + props[i].offset);
                    }
                    return as_v_null();
                }
            }
        }
        vt = ((as_vtable_header*)vt)->super;
    }
    if (((as_object_header*)obj)->vtable == (void*)&as_object_vt) {
        return as_object_get((as_object*)obj, key);
    }
    return as_v_null();
}

static void as_dyn_set(void* obj, const char* key, as_value v) {
    if (obj == NULL) return;
    void* vt = ((as_object_header*)obj)->vtable;
    while (vt != NULL) {
        as_prop* props = (as_prop*)((as_vtable_header*)vt)->props;
        if (props != NULL) {
            for (int i = 0; props[i].name != NULL; i++) {
                if (strcmp(props[i].name, key) == 0) {
                    char* base = (char*)obj;
                    switch (props[i].type) {
                        case 1: *(double*)(base + props[i].offset) = as_v_num_val(v); return;
                        case 2: *(bool*)(base + props[i].offset) = as_v_bool_val(v); return;
                        case 3: *(char**)(base + props[i].offset) = as_v_str_val(v); gc_write_barrier((void*)*(char**)(base + props[i].offset)); return;
                        case 4: *(int*)(base + props[i].offset) = as_v_int_val(v); return;
                        case 5: *(unsigned*)(base + props[i].offset) = as_v_uint_val(v); return;
                        case 6: *(void**)(base + props[i].offset) = as_v_obj_val(v); gc_write_barrier(*(void**)(base + props[i].offset)); return;
                        case 7: *(as_value*)(base + props[i].offset) = v; gc_write_barrier_value(v); return;
                    }
                    return;
                }
            }
        }
        vt = ((as_vtable_header*)vt)->super;
    }
    if (((as_object_header*)obj)->vtable == (void*)&as_object_vt) {
        as_object_set((as_object*)obj, key, v);
    }
}

// Dynamically-typed ('any') index read: dispatch on the boxed value's runtime
// tag — record slot, array element, or object field reflection.
static as_value as_any_get(as_value box, const char* key) {
    switch (box.tag) {
        case 4: return as_dyn_get(as_v_obj_val(box), key);
        case 6: return as_array_get((as_array*)as_v_obj_val(box), (int)strtol(key, NULL, 10));
        case 3: return as_v_str((char*)key);
        default: return as_v_null();
    }
}
static void as_any_set(as_value box, const char* key, as_value v) {
    switch (box.tag) {
        case 4: as_dyn_set(as_v_obj_val(box), key, v); break;
        case 6: as_array_set((as_array*)as_v_obj_val(box), (int)strtol(key, NULL, 10), v); break;
        default: break;
    }
}

// Array.sortOn(field, options): sort objects in place by a named property. The
// field value is fetched reflectively via as_dyn_get. Options honor Array.NUMERIC
// (16, compare as numbers) and Array.DESCENDING (2, reverse order); other flags
// (unique/return-indexed/case-insensitive) are outside this subset.
typedef struct { const char* field; int numeric; int desc; } as_sorton_ctx;
static int as_cmp_sorton(as_value a, as_value b, void* ctx) {
    as_sorton_ctx* c = (as_sorton_ctx*)ctx;
    as_value fa = as_dyn_get(as_v_obj_val(a), c->field);
    as_value fb = as_dyn_get(as_v_obj_val(b), c->field);
    int r;
    if (c->numeric) {
        double na = as_v_num_val(fa);
        double nb = as_v_num_val(fb);
        r = (na < nb) ? -1 : (na > nb) ? 1 : 0;
    } else {
        r = strcmp(as_v_str_val(fa), as_v_str_val(fb));
    }
    return c->desc ? -r : r;
}
static as_array* as_array_sortOn(as_array* a, const char* field, int options) {
    as_sorton_ctx ctx = { field, (options & 16) != 0, (options & 2) != 0 };
    as_array_sort_impl(a, as_cmp_sorton, &ctx);
    return a;
}

// ---------- Dictionary ----------
// AS3 flash.utils.Dictionary: an associative map keyed by OBJECT REFERENCE (not
// string). Values are boxed as_value. Weak keys (the ctor bool) are accepted but
// not modeled — keys are strongly held for the program lifetime (documented
// subset limitation; the arena already grants program-lifetime semantics).
typedef struct {
    void** keys;
    as_value* vals;
    int length;
    int capacity;
} as_dict;

static as_dict* as_dict_new(void) {
    as_dict* d = (as_dict*)gc_alloc(GCT_DICT, sizeof(as_dict));
    d->keys = NULL;
    d->vals = NULL;
    d->length = 0;
    d->capacity = 0;
    return d;
}
static int as_dict_find(as_dict* d, void* key) {
    for (int i = 0; i < d->length; i++) {
        if (d->keys[i] == key) return i;
    }
    return -1;
}
static as_value as_dict_get(as_dict* d, void* key) {
    int i = as_dict_find(d, key);
    return i < 0 ? as_v_null() : d->vals[i];
}
static as_value as_dict_set(as_dict* d, void* key, as_value v) {
    int i = as_dict_find(d, key);
    if (i >= 0) {
        d->vals[i] = v;
        gc_write_barrier_value(v);
        return v;
    }
    if (d->length == d->capacity) {
        int cap = d->capacity == 0 ? 8 : d->capacity * 2;
        // GC cannot realloc in place; allocate fresh parallel arrays and copy.
        // The old arrays become garbage and are reclaimed by the next sweep.
        void** nk = (void**)gc_alloc(GCT_PTR_ARRAY, sizeof(void*) * (size_t)cap);
        as_value* nv = (as_value*)gc_alloc(GCT_VALUE_ARRAY, sizeof(as_value) * (size_t)cap);
        if (d->length > 0) {
            memcpy(nk, d->keys, sizeof(void*) * (size_t)d->length);
            memcpy(nv, d->vals, sizeof(as_value) * (size_t)d->length);
        }
        d->keys = nk;
        d->vals = nv;
        d->capacity = cap;
    }
    d->keys[d->length] = key;
    d->vals[d->length] = v;
    d->length++;
    gc_write_barrier(key);
    gc_write_barrier_value(v);
    return v;
}
static bool as_dict_has(as_dict* d, void* key) {
    return as_dict_find(d, key) >= 0;
}
static bool as_dict_del(as_dict* d, void* key) {
    int i = as_dict_find(d, key);
    if (i < 0) return false;
    for (int j = i; j < d->length - 1; j++) {
        d->keys[j] = d->keys[j + 1];
        d->vals[j] = d->vals[j + 1];
    }
    d->length--;
    return true;
}

// ---------- string methods ----------
static char* as_str_charAt(const char* s, int i) {
    int len = (int)strlen(s);
    if (i < 0 || i >= len) return "";
    char* r = as_str_alloc(2);
    r[0] = s[i]; r[1] = 0;
    return r;
}
static int as_str_charCodeAt(const char* s, int i) {
    int len = (int)strlen(s);
    if (i < 0 || i >= len) return 0;
    return (unsigned char)s[i];
}
static int as_str_indexOf(const char* s, const char* sub) {
    const char* p = strstr(s, sub);
    return p ? (int)(p - s) : -1;
}
static int as_str_lastIndexOf(const char* s, const char* sub) {
    int slen = (int)strlen(s);
    int sublen = (int)strlen(sub);
    if (sublen == 0) return slen;
    for (int i = slen - sublen; i >= 0; i--) {
        if (strncmp(s + i, sub, sublen) == 0) return i;
    }
    return -1;
}
static char* as_str_substring(const char* s, int from, int to) {
    int len = (int)strlen(s);
    if (from < 0) from = 0;
    if (to < 0) to = 0;
    if (from > len) from = len;
    if (to > len) to = len;
    if (from > to) { int t = from; from = to; to = t; }
    int n = to - from;
    char* r = as_str_alloc(n + 1);
    memcpy(r, s + from, n);
    r[n] = 0;
    return r;
}
static char* as_str_substr(const char* s, int from, int len) {
    int slen = (int)strlen(s);
    if (from < 0) from = slen + from;
    if (from < 0) from = 0;
    if (from > slen) from = slen;
    if (len < 0) len = 0;
    if (from + len > slen) len = slen - from;
    char* r = as_str_alloc(len + 1);
    memcpy(r, s + from, len);
    r[len] = 0;
    return r;
}
static char* as_str_slice(const char* s, int from, int to) {
    int slen = (int)strlen(s);
    if (from < 0) from = slen + from;
    if (to < 0) to = slen + to;
    if (from < 0) from = 0;
    if (to < 0) to = 0;
    if (from > slen) from = slen;
    if (to > slen) to = slen;
    if (to < from) to = from;
    int n = to - from;
    char* r = as_str_alloc(n + 1);
    memcpy(r, s + from, n);
    r[n] = 0;
    return r;
}
static as_array* as_str_split(const char* s, const char* sep) {
    as_array* r = as_array_new();
    if (strlen(sep) == 0) {
        for (int i = 0; s[i]; i++) {
            char* copy = as_str_alloc(2);
            copy[0] = s[i]; copy[1] = 0;
            as_array_push(r, as_v_str(copy));
        }
        return r;
    }
    const char* p = s;
    const char* q;
    while ((q = strstr(p, sep)) != NULL) {
        int n = (int)(q - p);
        char* part = as_str_alloc(n + 1);
        memcpy(part, p, n); part[n] = 0;
        as_array_push(r, as_v_str(part));
        p = q + strlen(sep);
    }
    char* last = as_str_alloc(strlen(p) + 1);
    strcpy(last, p);
    as_array_push(r, as_v_str(last));
    return r;
}
static char* as_str_toUpper(const char* s) {
    int len = (int)strlen(s);
    char* r = as_str_alloc(len + 1);
    for (int i = 0; i < len; i++) r[i] = (s[i] >= 'a' && s[i] <= 'z') ? (char)(s[i] - 32) : s[i];
    r[len] = 0;
    return r;
}
static char* as_str_toLower(const char* s) {
    int len = (int)strlen(s);
    char* r = as_str_alloc(len + 1);
    for (int i = 0; i < len; i++) r[i] = (s[i] >= 'A' && s[i] <= 'Z') ? (char)(s[i] + 32) : s[i];
    r[len] = 0;
    return r;
}
// AS3 String.replace with a plain-string searchValue replaces only the first
// match (RegExp-based replace is a later stage).
static char* as_str_replace(const char* s, const char* search, const char* repl) {
    const char* p = strstr(s, search);
    if (p == NULL) {
        char* r = as_str_alloc(strlen(s) + 1);
        strcpy(r, s);
        return r;
    }
    size_t pre = (size_t)(p - s);
    size_t slen = strlen(search);
    size_t rlen = strlen(repl);
    size_t tail = strlen(p + slen);
    char* r = as_str_alloc(pre + rlen + tail + 1);
    memcpy(r, s, pre);
    memcpy(r + pre, repl, rlen);
    memcpy(r + pre + rlen, p + slen, tail);
    r[pre + rlen + tail] = 0;
    return r;
}

// ---------- Number formatting (toFixed / toExponential / toPrecision) ----------
// C's %e zero-pads the exponent to two digits ("e+03"); AS3 uses a minimal-width
// exponent ("e+3"). Strip the leading zeros in place.
static void as_strip_exp_zeros(char* buf) {
    char* e = strchr(buf, 'e');
    if (e == NULL) return;
    char* p = e + 1;
    char sign = (*p == '+' || *p == '-') ? *p++ : '+';
    while (*p == '0' && p[1] != 0) p++;
    int k = 1;
    e[k++] = sign;
    while (*p) e[k++] = *p++;
    e[k] = 0;
}
static char* as_num_toFixed(double v, int digits) {
    if (isnan(v)) return "NaN";
    if (isinf(v)) return v > 0 ? "Infinity" : "-Infinity";
    if (digits < 0) digits = 0;
    if (digits > 20) digits = 20;
    char* r = as_str_alloc(128);
    snprintf(r, 128, "%.*f", digits, v);
    return r;
}
static char* as_num_toExponential(double v, int digits) {
    if (isnan(v)) return "NaN";
    if (isinf(v)) return v > 0 ? "Infinity" : "-Infinity";
    if (digits < 0) digits = 0;
    if (digits > 20) digits = 20;
    char buf[128];
    snprintf(buf, 128, "%.*e", digits, v);
    as_strip_exp_zeros(buf);
    char* r = as_str_alloc(strlen(buf) + 1);
    strcpy(r, buf);
    return r;
}
static char* as_num_toPrecision(double v, int precision) {
    if (isnan(v)) return "NaN";
    if (isinf(v)) return v > 0 ? "Infinity" : "-Infinity";
    if (precision < 1) precision = 1;
    if (precision > 21) precision = 21;
    char buf[128];
    snprintf(buf, 128, "%.*g", precision, v);
    as_strip_exp_zeros(buf);
    char* r = as_str_alloc(strlen(buf) + 1);
    strcpy(r, buf);
    return r;
}

// ---------- Math.random ----------
static double as_math_random(void) {
    return ((double)rand() / (double)RAND_MAX);
}

// ---------- exceptions (throw / try / catch / finally) ----------
// AS3's throw carries an Error object; catch (e) binds it. We propagate a
// void* to the thrown Error, longjmp'ing to the innermost active handler. The
// generated Error struct lays out as { vtable; message }, so the view below
// lets the uncaught-exception path read the message without knowing Error's type.
typedef struct { void* vtable; char* message; } as_error_view;

static void* as_exception = NULL;
static jmp_buf* as_jmp_stack[64];
static int as_jmp_depth = 0;

static const char* as_error_message(void* e) {
    return e ? ((as_error_view*)e)->message : "unknown";
}
static void as_throw(void* e) {
    as_exception = e;
    if (as_jmp_depth == 0) {
        fprintf(stderr, "Uncaught exception: %s\\n", as_error_message(e));
        exit(1);
    }
    longjmp(*as_jmp_stack[as_jmp_depth - 1], 1);
}

// ---------- GC mark / sweep / collect (incremental, GC-4) ----------

// Push a grey object onto the mark work stack, growing it on demand.
static void gc_grey_push(gc_header* h) {
    if (gc_inc.grey_top == gc_inc.grey_cap) {
        gc_inc.grey_cap = gc_inc.grey_cap == 0 ? 256 : gc_inc.grey_cap * 2;
        gc_inc.grey = (gc_header**)realloc(gc_inc.grey, (size_t)gc_inc.grey_cap * sizeof(gc_header*));
    }
    gc_inc.grey[gc_inc.grey_top++] = h;
}

// Mark one pointer: if it points into the GC heap and is still white, colour it
// grey and queue it for scanning. Non-heap pointers (string literals, static
// vtables) are skipped by the address-range check. Non-recursive: the mark is
// driven by draining the grey stack (gc_step / gc_collect), which is what makes
// it resumable across frames.
static void gc_mark_ptr(void* p) {
    if (p == NULL || !gc_in_heap(p)) return;
    gc_header* h = gc_hdr(p);
    if (h->color == GC_WHITE) {
        h->color = GC_GREY;
        gc_grey_push(h);
    }
}

static void gc_mark_value(as_value v) {
    if (v.tag == 3 || v.tag == 4 || v.tag == 6 || v.tag == 7)
        gc_mark_ptr(v.ptr);
}

// Scan one object's child pointers, greying (and queuing) any white child.
static void gc_scan(gc_header* h) {
    char* b = (char*)h + sizeof(gc_header);
    switch (h->type) {
    case GCT_STRING:
        break;  // leaf
    case GCT_ARRAY: {
        as_array* a = (as_array*)b;
        gc_mark_ptr(a->data);
        gc_mark_ptr(a->input);
        break;
    }
    case GCT_OBJECT: {
        as_object* o = (as_object*)b;
        gc_mark_ptr(o->keys);
        gc_mark_ptr(o->vals);
        break;
    }
    case GCT_DICT: {
        as_dict* d = (as_dict*)b;
        gc_mark_ptr(d->keys);
        gc_mark_ptr(d->vals);
        break;
    }
    case GCT_CLOSURE: {
        as_closure* c = (as_closure*)b;
        gc_mark_ptr(c->env);
        break;
    }
    case GCT_CLASS: {
        // Walk the vtable super chain's props reflection tables. Only ref (6),
        // any (7) and string (3) fields carry pointers.
        void* vt = ((as_object_header*)b)->vtable;
        while (vt != NULL) {
            as_prop* props = (as_prop*)((as_vtable_header*)vt)->props;
            if (props != NULL) {
                for (int i = 0; props[i].name != NULL; i++) {
                    char* base = b;
                    switch (props[i].type) {
                    case 3: gc_mark_ptr(*(char**)(base + props[i].offset)); break;
                    case 6: gc_mark_ptr(*(void**)(base + props[i].offset)); break;
                    case 7: gc_mark_value(*(as_value*)(base + props[i].offset)); break;
                    }
                }
            }
            vt = ((as_vtable_header*)vt)->super;
        }
        break;
    }
    case GCT_VALUE_ARRAY: {
        int n = (int)(h->size / sizeof(as_value));
        as_value* arr = (as_value*)b;
        for (int i = 0; i < n; i++) gc_mark_value(arr[i]);
        break;
    }
    case GCT_PTR_ARRAY: {
        int n = (int)(h->size / sizeof(void*));
        void** arr = (void**)b;
        for (int i = 0; i < n; i++) gc_mark_ptr(arr[i]);
        break;
    }
    }
}

// Permanent roots owned by the runtime itself: the setTimeout timer table and
// the in-flight exception. (The event registry and stage live in generated code
// and are marked by gc_mark_user_roots.)
static void gc_mark_internal_roots(void) {
    for (int i = 0; i < as_timer_count; i++) {
        if (as_timers[i].alive) gc_mark_ptr(as_timers[i].fn);
    }
    for (int i = 0; i < as_rep_timer_count; i++) {
        if (as_rep_timers[i].alive) gc_mark_ptr(as_rep_timers[i].obj);
    }
    for (int i = 0; i < as_mc_count; i++) {
        if (as_mcs[i].alive) gc_mark_ptr(as_mcs[i].obj);
    }
    gc_mark_ptr(as_exception);
}

// Mark every root (internal + registered slots + generated user roots).
static void gc_mark_roots(void) {
    gc_mark_internal_roots();
    for (int i = 0; i < gc_root_count; i++) gc_mark_ptr(*gc_roots[i]);
    gc_mark_user_roots();
}

// Drain the grey stack to completion (stop-the-world mark finish).
static void gc_mark_drain(void) {
    while (gc_inc.grey_top > 0) {
        gc_header* g = gc_inc.grey[--gc_inc.grey_top];
        gc_scan(g);
        g->color = GC_BLACK;
    }
}

// Sweep a budget of the all-objects list: white objects return to the free-list,
// black objects reset to white for the next cycle. Returns true when the walk is
// complete. gc_all is stable during the walk because in-cycle allocations go to
// gc_new (see gc_alloc), never prepended into gc_all.
static bool gc_sweep_step(size_t budget) {
    while (budget-- > 0 && gc_inc.sweep_cursor != NULL) {
        gc_header* h = gc_inc.sweep_cursor;
        gc_header* next = h->next;
        if (h->color == GC_WHITE) {
            if (gc_inc.sweep_prev) gc_inc.sweep_prev->next = next; else gc_all = next;
            h->next = gc_free;
            gc_free = h;
        } else {
            h->color = GC_WHITE;   // black -> white for the next cycle
            gc_inc.sweep_prev = h;
        }
        gc_inc.sweep_cursor = next;
    }
    return gc_inc.sweep_cursor == NULL;
}

// Finish a collection cycle: splice the side-list of objects allocated during
// MARK/SWEEP (born BLACK) back into gc_all and reset them to WHITE for the next
// cycle.
static void gc_finish_cycle(void) {
    if (gc_new != NULL) {
        gc_header* t = gc_new;
        while (t->next != NULL) t = t->next;
        t->next = gc_all;
        gc_all = gc_new;
        for (gc_header* h = gc_new; h != NULL; h = h->next) h->color = GC_WHITE;
        gc_new = NULL;
    }
    gc_bytes_allocated = 0;
    gc_inc.state = GC_IDLE;
}

// One incremental slice, called every frame at the Stage_dispatchFrame safe
// point. Advances the MARK and SWEEP phases by a fixed object budget so the
// per-frame GC pause stays O(budget) instead of growing with the heap.
static void gc_step(void) {
    if (gc_inc.state == GC_IDLE) {
        if (gc_bytes_allocated < gc_threshold) return;
        gc_inc.state = GC_MARK;
        gc_inc.grey_top = 0;  // fresh mark; a previous cycle drains to empty first
        gc_mark_roots();
    }
    if (gc_inc.state == GC_MARK) {
        size_t n = gc_inc.budget;
        while (n-- > 0 && gc_inc.grey_top > 0) {
            gc_header* g = gc_inc.grey[--gc_inc.grey_top];
            gc_scan(g);
            g->color = GC_BLACK;
        }
        if (gc_inc.grey_top == 0) {
            gc_inc.state = GC_SWEEP;
            gc_inc.sweep_prev = NULL;
            gc_inc.sweep_cursor = gc_all;
        }
    }
    if (gc_inc.state == GC_SWEEP) {
        if (gc_sweep_step(gc_inc.budget)) gc_finish_cycle();
    }
}

// Stop-the-world collection (System.gc() and offscreen leak checks): mark to
// completion in one shot, then sweep atomically. Works from any gc_step state.
// A partial incremental cycle may have (a) BLACK objects born on the gc_new side
// list whose children were never scanned, and (b) half-marked BLACK objects on
// gc_all. To get a correct result we first fold gc_new into gc_all, reset every
// object to WHITE, and mark the true live set from scratch.
static void gc_collect(void) {
    if (gc_new != NULL) {
        gc_header* t = gc_new;
        while (t->next != NULL) t = t->next;
        t->next = gc_all;
        gc_all = gc_new;
        gc_new = NULL;
    }
    for (gc_header* h = gc_all; h != NULL; h = h->next) h->color = GC_WHITE;
    gc_inc.grey_top = 0;
    gc_inc.state = GC_IDLE;
    gc_mark_roots();
    gc_mark_drain();
    gc_inc.sweep_prev = NULL;
    gc_inc.sweep_cursor = gc_all;
    gc_sweep_step((size_t)-1);
    gc_finish_cycle();
}

// ---------- integer base conversion (toString(radix)) ----------
// AS3 Number/int/uint toString(radix) for bases 2..36. Signed values use a
// leading '-' plus magnitude (AS3's int.toString uses two's-complement for
// negative values; we simplify to signed magnitude — documented subset).
static char* as_int_radix(long long v, int radix) {
    if (radix < 2 || radix > 36) radix = 10;
    if (radix == 10) return as_str_from_int((int)v);
    static const char d[] = "0123456789abcdefghijklmnopqrstuvwxyz";
    int neg = v < 0;
    unsigned long long u = neg ? (unsigned long long)(-v) : (unsigned long long)v;
    char buf[70];
    int i = 0;
    if (u == 0) buf[i++] = '0';
    while (u > 0) { buf[i++] = d[u % (unsigned)radix]; u /= (unsigned)radix; }
    if (neg) buf[i++] = '-';
    buf[i] = 0;
    for (int l = 0, r = i - 1; l < r; l++, r--) { char t = buf[l]; buf[l] = buf[r]; buf[r] = t; }
    char* out = as_str_alloc((size_t)i + 1);
    memcpy(out, buf, (size_t)i + 1);
    return out;
}
static char* as_uint_radix(unsigned long long v, int radix) {
    if (radix < 2 || radix > 36) radix = 10;
    if (radix == 10) {
        char* r = as_str_alloc(32);
        snprintf(r, 32, "%llu", v);
        return r;
    }
    static const char d[] = "0123456789abcdefghijklmnopqrstuvwxyz";
    char buf[70];
    int i = 0;
    if (v == 0) buf[i++] = '0';
    while (v > 0) { buf[i++] = d[v % (unsigned)radix]; v /= (unsigned)radix; }
    buf[i] = 0;
    for (int l = 0, r = i - 1; l < r; l++, r--) { char t = buf[l]; buf[l] = buf[r]; buf[r] = t; }
    char* out = as_str_alloc((size_t)i + 1);
    memcpy(out, buf, (size_t)i + 1);
    return out;
}

// ---------- additional string methods ----------
static char* as_str_concat_n(int n, const char** parts) {
    size_t total = 0;
    for (int i = 0; i < n; i++) total += strlen(parts[i]);
    char* r = as_str_alloc(total + 1);
    char* p = r;
    for (int i = 0; i < n; i++) {
        size_t l = strlen(parts[i]);
        memcpy(p, parts[i], l);
        p += l;
    }
    *p = 0;
    return r;
}
static char* as_str_fromCharCodes(int n, const int* codes) {
    // UTF-8 encode each code point. AS3 stores UTF-16 code units; code points
    // above U+FFFF (surrogate pairs) are simplified here.
    int total = 0;
    for (int i = 0; i < n; i++) {
        unsigned int c = (unsigned int)codes[i];
        if (c < 0x80) total += 1;
        else if (c < 0x800) total += 2;
        else if (c < 0x10000) total += 3;
        else total += 4;
    }
    char* r = as_str_alloc((size_t)total + 1);
    int p = 0;
    for (int i = 0; i < n; i++) {
        unsigned int c = (unsigned int)codes[i];
        if (c < 0x80) r[p++] = (char)c;
        else if (c < 0x800) { r[p++] = (char)(0xC0 | (c >> 6)); r[p++] = (char)(0x80 | (c & 0x3F)); }
        else if (c < 0x10000) { r[p++] = (char)(0xE0 | (c >> 12)); r[p++] = (char)(0x80 | ((c >> 6) & 0x3F)); r[p++] = (char)(0x80 | (c & 0x3F)); }
        else { r[p++] = (char)(0xF0 | (c >> 18)); r[p++] = (char)(0x80 | ((c >> 12) & 0x3F)); r[p++] = (char)(0x80 | ((c >> 6) & 0x3F)); r[p++] = (char)(0x80 | (c & 0x3F)); }
    }
    r[p] = 0;
    return r;
}
// Locale-aware collation is simplified to byte-wise comparison.
static int as_str_localeCompare(const char* a, const char* b) {
    return strcmp(a, b);
}
static bool as_str_startsWith(const char* s, const char* prefix) {
    return strncmp(s, prefix, strlen(prefix)) == 0;
}
static bool as_str_endsWith(const char* s, const char* suffix) {
    int sl = (int)strlen(s), xl = (int)strlen(suffix);
    return xl <= sl && strcmp(s + sl - xl, suffix) == 0;
}

// ---------- URI encoding/decoding ----------
// %XX-hex-encode a UTF-8 string, leaving characters in 'safe' untouched
// (unreserved ASCII letters/digits are always kept).
static char* as_uri_encode(const char* s, const char* safe) {
    int len = (int)strlen(s);
    char* r = as_str_alloc((size_t)len * 3 + 1);
    int p = 0;
    static const char hex[] = "0123456789ABCDEF";
    for (int i = 0; i < len; i++) {
        unsigned char c = (unsigned char)s[i];
        int keep = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
        if (!keep) {
            for (int j = 0; safe[j]; j++) if (c == (unsigned char)safe[j]) { keep = 1; break; }
        }
        if (keep) r[p++] = (char)c;
        else { r[p++] = '%'; r[p++] = hex[c >> 4]; r[p++] = hex[c & 15]; }
    }
    r[p] = 0;
    return r;
}
static int as_hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}
static char* as_uri_decode(const char* s) {
    int len = (int)strlen(s);
    char* r = as_str_alloc((size_t)len + 1);
    int p = 0;
    for (int i = 0; i < len; i++) {
        if (s[i] == '%' && i + 2 < len) {
            int hi = as_hexval(s[i + 1]);
            int lo = as_hexval(s[i + 2]);
            if (hi >= 0 && lo >= 0) { r[p++] = (char)((hi << 4) | lo); i += 2; continue; }
        }
        r[p++] = s[i];
    }
    r[p] = 0;
    return r;
}

// ---------- undefined (global constant) ----------
static as_value as_v_undefined(void) { as_value v = {5, 0.0, NULL}; return v; }

// ================= RegExp engine (ECMAScript / ES3 subset) =================
// A self-contained backtracking regex VM. The pattern compiles to a flat
// instruction array executed by recursive backtracking. Supports the ES3
// grammar: literals, the dot metacharacter, character classes, \d \D \w \W \s \S, ^ $, \b \B,
// quantifiers (* + ? {n,m}, greedy and lazy), capturing/non-capturing groups,
// alternation, backreferences, and lookahead. Flags: i (case-insensitive),
// m (multiline), s (dotall); g (global) and x (extended) are handled by the
// caller — x strips whitespace before compile, g drives lastIndex in exec.
// Note: matching is byte-oriented (ASCII); non-ASCII UTF-8 text is not
// Unicode-aware, matching AS3's pre-ES2018 subset in ASCII mode.

enum {
    AS_RE_MATCH = 0,
    AS_RE_CHAR,
    AS_RE_ANY,
    AS_RE_CLASS,
    AS_RE_BOL,
    AS_RE_EOL,
    AS_RE_BOUND,
    AS_RE_NBOUND,
    AS_RE_SPLIT,
    AS_RE_JMP,
    AS_RE_SAVE,
    AS_RE_BACKREF,
    AS_RE_LOOKAHEAD_POS,
    AS_RE_LOOKAHEAD_NEG,
    AS_RE_FAIL,
    AS_RE_ENDSUB
};

typedef struct { int op; int a; int b; int neg; } as_re_ins;
typedef struct { unsigned char bits[32]; } as_re_class;

#define AS_RE_MAX_GROUPS 32
#define AS_RE_MAX_DEPTH 2000
#define AS_RE_MAX_STEPS 10000000

typedef struct {
    as_re_ins* ins;
    int nins;
    int cap_ins;
    as_re_class* classes;
    int nclasses;
    int cap_classes;
    int ngroups;
    int flags;   // 1=i 2=m 4=s 8=g 16=x
    int err;
    const char* errmsg;
} as_regex;

// -- instruction emission --
static int as_re_emit(as_regex* re, int op, int a, int b, int neg) {
    if (re->nins >= re->cap_ins) {
        re->cap_ins = re->cap_ins ? re->cap_ins * 2 : 64;
        re->ins = (as_re_ins*)realloc(re->ins, (size_t)re->cap_ins * sizeof(as_re_ins));
    }
    re->ins[re->nins].op = op;
    re->ins[re->nins].a = a;
    re->ins[re->nins].b = b;
    re->ins[re->nins].neg = neg;
    return re->nins++;
}

static int as_re_addclass(as_regex* re, const unsigned char* bits) {
    if (re->nclasses >= re->cap_classes) {
        re->cap_classes = re->cap_classes ? re->cap_classes * 2 : 8;
        re->classes = (as_re_class*)realloc(re->classes, (size_t)re->cap_classes * sizeof(as_re_class));
    }
    memcpy(re->classes[re->nclasses].bits, bits, 32);
    return re->nclasses++;
}

// Emit a saved atom instruction block (atom[0..n)) at the current program
// position, remapping internal SPLIT/JMP targets from the atom's original base
// (atomBase) to the current insertion point. Reading from a private copy avoids
// clobbering when the destination overlaps the source (quantifier unrolling).
static int as_re_emit_atom(as_regex* re, const as_re_ins* atom, int n, int atomBase) {
    int newbase = re->nins;
    int delta = newbase - atomBase;
    for (int i = 0; i < n; i++) {
        as_re_ins ins = atom[i];
        if (ins.op == AS_RE_SPLIT || ins.op == AS_RE_JMP) {
            if (ins.a >= atomBase && ins.a < atomBase + n) ins.a += delta;
            if (ins.b >= atomBase && ins.b < atomBase + n) ins.b += delta;
        }
        as_re_emit(re, ins.op, ins.a, ins.b, ins.neg);
    }
    return newbase;
}

// -- character class bitmaps (256-bit = 32 bytes, byte-oriented) --
static void as_re_bits_add(unsigned char* bits, int ch) { bits[ch >> 3] |= (unsigned char)(1 << (ch & 7)); }
static void as_re_bits_range(unsigned char* bits, int lo, int hi) { for (int c = lo; c <= hi; c++) as_re_bits_add(bits, c); }
static void as_re_bits_invert(unsigned char* bits) { for (int i = 0; i < 32; i++) bits[i] = (unsigned char)~bits[i]; }

static void as_re_bits_add_esc(unsigned char* bits, int e) {
    switch (e) {
    case 'd': as_re_bits_range(bits, '0', '9'); break;
    case 'D': as_re_bits_range(bits, '0', '9'); as_re_bits_invert(bits); break;
    case 'w': as_re_bits_range(bits, 'a', 'z'); as_re_bits_range(bits, 'A', 'Z');
              as_re_bits_range(bits, '0', '9'); as_re_bits_add(bits, '_'); break;
    case 'W': as_re_bits_range(bits, 'a', 'z'); as_re_bits_range(bits, 'A', 'Z');
              as_re_bits_range(bits, '0', '9'); as_re_bits_add(bits, '_'); as_re_bits_invert(bits); break;
    case 's': as_re_bits_add(bits, ' '); as_re_bits_add(bits, '\\t'); as_re_bits_add(bits, '\\n');
              as_re_bits_add(bits, '\\r'); as_re_bits_add(bits, '\\f'); as_re_bits_add(bits, '\\v'); break;
    case 'S': as_re_bits_add(bits, ' '); as_re_bits_add(bits, '\\t'); as_re_bits_add(bits, '\\n');
              as_re_bits_add(bits, '\\r'); as_re_bits_add(bits, '\\f'); as_re_bits_add(bits, '\\v'); as_re_bits_invert(bits); break;
    default: as_re_bits_add(bits, e); break;
    }
}

static void as_re_bits_casefold(unsigned char* bits) {
    for (int c = 'a'; c <= 'z'; c++) if (bits[c >> 3] & (1 << (c & 7))) bits[(c - 32) >> 3] |= (unsigned char)(1 << ((c - 32) & 7));
    for (int c = 'A'; c <= 'Z'; c++) if (bits[c >> 3] & (1 << (c & 7))) bits[(c + 32) >> 3] |= (unsigned char)(1 << ((c + 32) & 7));
}

// -- recursive-descent compiler --
typedef struct {
    as_regex* re;
    const char* p;
    int pos;
    int len;
    int ngroups;
} as_re_comp;

static int as_re_peek(as_re_comp* c) { return c->pos < c->len ? (unsigned char)c->p[c->pos] : -1; }
static int as_re_peek1(as_re_comp* c) { return c->pos + 1 < c->len ? (unsigned char)c->p[c->pos + 1] : -1; }
static int as_re_next(as_re_comp* c) { return c->pos < c->len ? (unsigned char)c->p[c->pos++] : -1; }
static void as_re_err(as_re_comp* c, const char* msg) { if (!c->re->err) { c->re->err = 1; c->re->errmsg = msg; } }

static int as_re_comp_alt(as_re_comp* c);
static int as_re_comp_seq(as_re_comp* c);
static int as_re_comp_repeat(as_re_comp* c);
static int as_re_comp_atom(as_re_comp* c);
static int as_re_comp_group(as_re_comp* c);
static int as_re_comp_class(as_re_comp* c);
static int as_re_comp_escape(as_re_comp* c);

static int as_re_comp_seq(as_re_comp* c) {
    int first = c->re->nins;
    while (as_re_peek(c) >= 0 && as_re_peek(c) != '|' && as_re_peek(c) != ')') {
        as_re_comp_repeat(c);
        if (c->re->err) return -1;
    }
    return first;
}

static int as_re_comp_alt(as_re_comp* c) {
    as_regex* re = c->re;
    int head = as_re_emit(re, AS_RE_SPLIT, 0, 0, 0);
    int prevSplit = head;
    int jmps[64]; int njmp = 0;
    while (1) {
        re->ins[prevSplit].a = re->nins;
        as_re_comp_seq(c);
        if (re->err) return -1;
        jmps[njmp++] = as_re_emit(re, AS_RE_JMP, 0, 0, 0);
        if (as_re_peek(c) != '|') break;
        as_re_next(c);
        int nextSplit = as_re_emit(re, AS_RE_SPLIT, 0, 0, 0);
        re->ins[prevSplit].b = nextSplit;
        prevSplit = nextSplit;
    }
    int fail = as_re_emit(re, AS_RE_FAIL, 0, 0, 0);
    re->ins[prevSplit].b = fail;
    int end = re->nins;
    for (int k = 0; k < njmp; k++) re->ins[jmps[k]].a = end;
    return head;
}

static int as_re_comp_atom(as_re_comp* c) {
    as_regex* re = c->re;
    int ch = as_re_peek(c);
    if (ch < 0) return re->nins;
    switch (ch) {
    case '.': as_re_next(c); return as_re_emit(re, AS_RE_ANY, 0, 0, 0);
    case '^': as_re_next(c); return as_re_emit(re, AS_RE_BOL, 0, 0, 0);
    case '$': as_re_next(c); return as_re_emit(re, AS_RE_EOL, 0, 0, 0);
    case '*': case '+': case '?':
        as_re_err(c, "nothing to repeat"); return -1;
    case ')': case '|':
        return re->nins;
    case '(': return as_re_comp_group(c);
    case '[': return as_re_comp_class(c);
    case '\\\\': return as_re_comp_escape(c);
    default:
        as_re_next(c);
        return as_re_emit(re, AS_RE_CHAR, ch, 0, 0);
    }
}

static int as_re_comp_group(as_re_comp* c) {
    as_regex* re = c->re;
    as_re_next(c); // '('
    if (as_re_peek(c) == '?') {
        as_re_next(c); // '?'
        int t = as_re_peek(c);
        if (t == ':') {
            as_re_next(c);
            int e = as_re_comp_alt(c);
            if (re->err) return -1;
            if (as_re_peek(c) != ')') { as_re_err(c, "unbalanced parenthesis"); return -1; }
            as_re_next(c);
            return e;
        }
        if (t == '=' || t == '!') {
            as_re_next(c);
            int neg = (t == '!');
            int look = as_re_emit(re, neg ? AS_RE_LOOKAHEAD_NEG : AS_RE_LOOKAHEAD_POS, 0, 0, 0);
            int jmp = as_re_emit(re, AS_RE_JMP, 0, 0, 0); // skip sub-program in linear flow
            int subStart = re->nins;
            as_re_comp_alt(c);
            if (re->err) return -1;
            if (as_re_peek(c) != ')') { as_re_err(c, "unbalanced parenthesis"); return -1; }
            as_re_next(c);
            as_re_emit(re, AS_RE_ENDSUB, 0, 0, 0);
            re->ins[look].a = subStart;
            re->ins[jmp].a = re->nins;
            return look;
        }
        as_re_err(c, "invalid group"); return -1;
    }
    int g = c->ngroups + 1;
    if (g >= AS_RE_MAX_GROUPS) { as_re_err(c, "too many capture groups"); return -1; }
    c->ngroups = g;
    int save = as_re_emit(re, AS_RE_SAVE, 2 * g, 0, 0);
    as_re_comp_alt(c);
    if (re->err) return -1;
    if (as_re_peek(c) != ')') { as_re_err(c, "unbalanced parenthesis"); return -1; }
    as_re_next(c);
    as_re_emit(re, AS_RE_SAVE, 2 * g + 1, 0, 0);
    return save;
}

static int as_re_comp_escape(as_re_comp* c) {
    as_regex* re = c->re;
    as_re_next(c); // backslash
    int e = as_re_next(c);
    if (e < 0) { as_re_err(c, "trailing backslash"); return -1; }
    switch (e) {
    case 'd': case 'D': case 'w': case 'W': case 's': case 'S': {
        unsigned char bits[32]; memset(bits, 0, 32);
        as_re_bits_add_esc(bits, e);
        if (re->flags & 1) as_re_bits_casefold(bits);
        int idx = as_re_addclass(re, bits);
        return as_re_emit(re, AS_RE_CLASS, idx, 0, 0);
    }
    case 'b': return as_re_emit(re, AS_RE_BOUND, 0, 0, 0);
    case 'B': return as_re_emit(re, AS_RE_NBOUND, 0, 0, 0);
    case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
        return as_re_emit(re, AS_RE_BACKREF, e - '0', 0, 0);
    default:
        return as_re_emit(re, AS_RE_CHAR, e, 0, 0);
    }
}

static int as_re_comp_class(as_re_comp* c) {
    as_regex* re = c->re;
    as_re_next(c); // '['
    int neg = 0;
    if (as_re_peek(c) == '^') { neg = 1; as_re_next(c); }
    unsigned char bits[32]; memset(bits, 0, 32);
    int first = 1;
    while (as_re_peek(c) >= 0 && !(as_re_peek(c) == ']' && !first)) {
        int ch = as_re_next(c);
        if (ch == '\\\\') {
            int e = as_re_next(c);
            if (e < 0) { as_re_err(c, "trailing backslash in class"); return -1; }
            as_re_bits_add_esc(bits, e);
        } else if (as_re_peek(c) == '-' && as_re_peek1(c) != ']' && as_re_peek1(c) >= 0) {
            as_re_next(c); // '-'
            int hi = as_re_next(c);
            if (hi < ch) { as_re_err(c, "invalid character range"); return -1; }
            as_re_bits_range(bits, ch, hi);
        } else {
            as_re_bits_add(bits, ch);
        }
        first = 0;
    }
    if (as_re_peek(c) != ']') { as_re_err(c, "unterminated character class"); return -1; }
    as_re_next(c); // ']'
    if (re->flags & 1) as_re_bits_casefold(bits);
    int idx = as_re_addclass(re, bits);
    return as_re_emit(re, AS_RE_CLASS, idx, 0, neg);
}

static int as_re_comp_repeat(as_re_comp* c) {
    as_regex* re = c->re;
    int atomStart = as_re_comp_atom(c);
    if (re->err) return -1;
    int q = as_re_peek(c);
    if (q != '*' && q != '+' && q != '?' && q != '{') return atomStart;

    int atomEnd = re->nins;
    int atomLen = atomEnd - atomStart;
    // Save the atom's instructions before rewinding: emitting the quantifier's
    // SPLIT at atomStart would otherwise clobber re->ins[atomStart].
    as_re_ins* atom = (as_re_ins*)malloc((size_t)atomLen * sizeof(as_re_ins));
    memcpy(atom, re->ins + atomStart, (size_t)atomLen * sizeof(as_re_ins));

    re->nins = atomStart; // rewind: rebuild with quantifier
    int min = 0, max = -1;
    as_re_next(c);
    if (q == '*') { min = 0; max = -1; }
    else if (q == '+') { min = 1; max = -1; }
    else if (q == '?') { min = 0; max = 1; }
    else {
        min = 0;
        int have = 0;
        while (as_re_peek(c) >= '0' && as_re_peek(c) <= '9') { min = min * 10 + (as_re_next(c) - '0'); have = 1; }
        if (!have) { as_re_err(c, "invalid quantifier"); return -1; }
        if (as_re_peek(c) == '}') { as_re_next(c); max = min; }
        else if (as_re_peek(c) == ',') {
            as_re_next(c);
            if (as_re_peek(c) == '}') { as_re_next(c); max = -1; }
            else {
                max = 0;
                while (as_re_peek(c) >= '0' && as_re_peek(c) <= '9') max = max * 10 + (as_re_next(c) - '0');
                if (as_re_peek(c) != '}') { as_re_err(c, "invalid quantifier"); return -1; }
                as_re_next(c);
                if (max < min) { as_re_err(c, "quantifier range out of order"); return -1; }
            }
        } else { as_re_err(c, "invalid quantifier"); return -1; }
    }
    int lazy = 0;
    if (as_re_peek(c) == '?') { as_re_next(c); lazy = 1; }

    for (int i = 0; i < min; i++) as_re_emit_atom(re, atom, atomLen, atomStart);
    if (max == min) { free(atom); return atomStart; }

    int extraMax = (max == -1) ? -1 : (max - min);
    if (extraMax == -1) {
        int loop = re->nins;
        int split = as_re_emit(re, AS_RE_SPLIT, 0, 0, 0);
        int body = as_re_emit_atom(re, atom, atomLen, atomStart);
        int jmp = as_re_emit(re, AS_RE_JMP, loop, 0, 0);
        if (lazy) { re->ins[split].a = re->nins; re->ins[split].b = body; }
        else { re->ins[split].a = body; re->ins[split].b = re->nins; }
    } else {
        for (int i = 0; i < extraMax; i++) {
            int split = as_re_emit(re, AS_RE_SPLIT, 0, 0, 0);
            int body = as_re_emit_atom(re, atom, atomLen, atomStart);
            if (lazy) { re->ins[split].a = re->nins; re->ins[split].b = body; }
            else { re->ins[split].a = body; re->ins[split].b = re->nins; }
        }
    }
    free(atom);
    return atomStart;
}

// -- backtracking VM --
typedef struct {
    as_regex* re;
    const char* str;
    int len;
    int* cap;
    int steps;
    int match_end;
} as_re_ctx;

static int as_re_charcmp(as_regex* re, unsigned char a, int b) {
    if (re->flags & 1) return tolower(a) == tolower(b);
    return a == b;
}
static int as_re_isword(unsigned char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
}

static int as_re_vm(as_re_ctx* ctx, int pc, int sp, int depth) {
    if (depth > AS_RE_MAX_DEPTH) return 0;
    as_regex* re = ctx->re;
    while (1) {
        if (++ctx->steps > AS_RE_MAX_STEPS) return 0;
        if (pc < 0 || pc >= re->nins) return 0;
        as_re_ins* in = &re->ins[pc];
        switch (in->op) {
        case AS_RE_MATCH: ctx->match_end = sp; return 1;
        case AS_RE_ENDSUB: return 1;
        case AS_RE_FAIL: return 0;
        case AS_RE_CHAR:
            if (sp < ctx->len && as_re_charcmp(re, (unsigned char)ctx->str[sp], in->a)) { sp++; pc++; }
            else return 0;
            break;
        case AS_RE_ANY:
            if (sp < ctx->len && ((re->flags & 4) || ctx->str[sp] != '\\n')) { sp++; pc++; }
            else return 0;
            break;
        case AS_RE_CLASS: {
            if (sp >= ctx->len) return 0;
            unsigned char ch = (unsigned char)ctx->str[sp];
            int m = (re->classes[in->a].bits[ch >> 3] >> (ch & 7)) & 1;
            if (in->neg) m = !m;
            if (m) { sp++; pc++; } else return 0;
            break;
        }
        case AS_RE_BOL:
            if (sp == 0 || ((re->flags & 2) && ctx->str[sp - 1] == '\\n')) pc++;
            else return 0;
            break;
        case AS_RE_EOL:
            if (sp == ctx->len || ((re->flags & 2) && ctx->str[sp] == '\\n')) pc++;
            else return 0;
            break;
        case AS_RE_BOUND: {
            int prev = (sp > 0) ? as_re_isword((unsigned char)ctx->str[sp - 1]) : 0;
            int next = (sp < ctx->len) ? as_re_isword((unsigned char)ctx->str[sp]) : 0;
            if (prev != next) pc++; else return 0;
            break;
        }
        case AS_RE_NBOUND: {
            int prev = (sp > 0) ? as_re_isword((unsigned char)ctx->str[sp - 1]) : 0;
            int next = (sp < ctx->len) ? as_re_isword((unsigned char)ctx->str[sp]) : 0;
            if (prev == next) pc++; else return 0;
            break;
        }
        case AS_RE_SPLIT:
            if (as_re_vm(ctx, in->a, sp, depth + 1)) return 1;
            pc = in->b;
            break;
        case AS_RE_JMP:
            pc = in->a;
            break;
        case AS_RE_SAVE:
            ctx->cap[in->a] = sp;
            pc++;
            break;
        case AS_RE_BACKREF: {
            int g = in->a;
            int gs = ctx->cap[2 * g], ge = ctx->cap[2 * g + 1];
            if (gs < 0 || ge < 0) { pc++; break; }
            int glen = ge - gs;
            if (sp + glen > ctx->len) return 0;
            for (int i = 0; i < glen; i++) {
                if (!as_re_charcmp(re, (unsigned char)ctx->str[sp + i], (unsigned char)ctx->str[gs + i])) return 0;
            }
            sp += glen; pc++;
            break;
        }
        case AS_RE_LOOKAHEAD_POS:
            if (as_re_vm(ctx, in->a, sp, depth + 1)) pc++;
            else return 0;
            break;
        case AS_RE_LOOKAHEAD_NEG:
            if (as_re_vm(ctx, in->a, sp, depth + 1)) return 0;
            pc++;
            break;
        }
    }
}

// Find the leftmost match of the compiled program in str[from..len). On success
// fills cap (group 0 = whole match, groups 1..n = captures) and returns the
// match start; out_end receives the match end. Returns -1 on no match.
static int as_regex_search(as_regex* re, const char* str, int len, int from, int* cap, int* out_end) {
    as_re_ctx ctx;
    ctx.re = re; ctx.str = str; ctx.len = len; ctx.cap = cap; ctx.steps = 0;
    for (int i = from; i <= len; i++) {
        for (int g = 1; g <= re->ngroups; g++) { cap[2 * g] = -1; cap[2 * g + 1] = -1; }
        cap[0] = i; cap[1] = -1;
        ctx.match_end = -1;
        if (as_re_vm(&ctx, 0, i, 0)) {
            cap[0] = i;
            cap[1] = ctx.match_end;
            if (out_end) *out_end = ctx.match_end;
            return i;
        }
    }
    return -1;
}

// Strip unescaped whitespace (and # comments to end-of-line) from an extended
// (x-flag) pattern, except inside character classes.
static void as_re_x_strip(char* out, const char* p, int len) {
    int j = 0, inClass = 0;
    for (int i = 0; i < len; i++) {
        char ch = p[i];
        if (ch == '\\\\') { out[j++] = ch; if (i + 1 < len) out[j++] = p[++i]; continue; }
        if (ch == '[') inClass = 1;
        else if (ch == ']') inClass = 0;
        if (!inClass && (ch == ' ' || ch == '\\t' || ch == '\\n' || ch == '\\r')) continue;
        if (!inClass && ch == '#') { while (i + 1 < len && p[i + 1] != '\\n') i++; continue; }
        out[j++] = ch;
    }
    out[j] = 0;
}

static as_regex* as_regex_compile(const char* pattern, const char* flags) {
    as_regex* re = (as_regex*)calloc(1, sizeof(as_regex));
    as_heap_bytes += sizeof(as_regex);
    int f = 0;
    if (flags) {
        for (const char* q = flags; *q; q++) {
            if (*q == 'i') f |= 1;
            else if (*q == 'm') f |= 2;
            else if (*q == 's') f |= 4;
            else if (*q == 'g') f |= 8;
            else if (*q == 'x') f |= 16;
        }
    }
    re->flags = f;

    char* pat = NULL;
    int plen = (int)strlen(pattern);
    if (f & 16) {
        pat = (char*)malloc((size_t)plen + 1);
        as_re_x_strip(pat, pattern, plen);
    }

    as_re_comp c;
    c.re = re;
    c.p = (f & 16) ? pat : pattern;
    c.pos = 0;
    c.len = (int)strlen(c.p);
    c.ngroups = 0;

    as_re_comp_alt(&c);
    if (!re->err) as_re_emit(re, AS_RE_MATCH, 0, 0, 0);
    re->ngroups = c.ngroups;

    if (pat) free(pat);
    return re;
}

// Build an exec/match result array: element 0 = whole match, elements 1..n =
// capture groups (or undefined for non-participating groups), plus index/input.
static as_array* as_regex_make_result(const char* s, int m, int e, as_regex* re, int* cap) {
    as_array* arr = as_array_new();
    as_array_push(arr, as_v_str(as_str_substring(s, m, e)));
    for (int g = 1; g <= re->ngroups; g++) {
        int gs = cap[2 * g], ge = cap[2 * g + 1];
        if (gs < 0 || ge < 0) as_array_push(arr, as_v_undefined());
        else as_array_push(arr, as_v_str(as_str_substring(s, gs, ge)));
    }
    arr->index = m;
    arr->input = (char*)s;
    return arr;
}

// String.match(RegExp): global collects every full match; non-global returns a
// single exec-style array (full match + captures). NULL when no match.
static as_array* as_str_match_regex(char* s, as_regex* re, int global) {
    int len = (int)strlen(s);
    int cap[2 * (AS_RE_MAX_GROUPS + 1)];
    if (global) {
        as_array* result = as_array_new();
        int pos = 0;
        while (pos <= len) {
            int end = -1;
            int m = as_regex_search(re, s, len, pos, cap, &end);
            if (m < 0) break;
            as_array_push(result, as_v_str(as_str_substring(s, m, end)));
            if (end == m) { if (m < len) pos = m + 1; else pos = len + 1; }
            else pos = end;
        }
        return result;
    }
    for (int i = 0; i < 2 * (re->ngroups + 1); i++) cap[i] = -1;
    int end = -1;
    int m = as_regex_search(re, s, len, 0, cap, &end);
    if (m < 0) return NULL;
    return as_regex_make_result(s, m, end, re, cap);
}

// String.search(RegExp): first match position (always from 0), -1 if none.
static int as_str_search_regex(char* s, as_regex* re) {
    int len = (int)strlen(s);
    int cap[2 * (AS_RE_MAX_GROUPS + 1)];
    for (int i = 0; i < 2 * (re->ngroups + 1); i++) cap[i] = -1;
    int end = -1;
    return as_regex_search(re, s, len, 0, cap, &end);
}

// Growable output buffer for regex replace.
static void as_re_buf_append(char** out, size_t* cap, size_t* len, const char* data, size_t n) {
    if (*len + n + 1 > *cap) {
        while (*len + n + 1 > *cap) *cap *= 2;
        *out = (char*)realloc(*out, *cap);
    }
    memcpy(*out + *len, data, n);
    *len += n;
}

// Append the replacement text, expanding $& (whole match), $1..$9 (captures),
// and $$ (literal $).
static void as_re_buf_repl(char** out, size_t* cap, size_t* len, const char* repl, const char* s, int m, int e, int* cap2) {
    for (const char* p = repl; *p; p++) {
        if (*p == '$') {
            char nxt = p[1];
            if (nxt == '&') { as_re_buf_append(out, cap, len, s + m, (size_t)(e - m)); p++; continue; }
            if (nxt == '$') { as_re_buf_append(out, cap, len, "$", 1); p++; continue; }
            if (nxt >= '1' && nxt <= '9') {
                int g = nxt - '0';
                int gs = cap2[2 * g], ge = cap2[2 * g + 1];
                if (gs >= 0 && ge >= 0) as_re_buf_append(out, cap, len, s + gs, (size_t)(ge - gs));
                p++; continue;
            }
            as_re_buf_append(out, cap, len, "$", 1);
        } else {
            as_re_buf_append(out, cap, len, p, 1);
        }
    }
}

// String.replace(RegExp, repl): replace first (or all, if global) matches.
static char* as_str_replace_regex(char* s, as_regex* re, char* repl, int global) {
    int len = (int)strlen(s);
    size_t cap = (size_t)len + 64;
    char* out = (char*)malloc(cap);
    size_t olen = 0;
    int pos = 0;
    int cap2[2 * (AS_RE_MAX_GROUPS + 1)];
    while (pos <= len) {
        int end = -1;
        int m = as_regex_search(re, s, len, pos, cap2, &end);
        if (m < 0) break;
        as_re_buf_append(&out, &cap, &olen, s + pos, (size_t)(m - pos));
        as_re_buf_repl(&out, &cap, &olen, repl, s, m, end, cap2);
        if (!global) { pos = end; break; }
        if (end > m) pos = end;
        else if (m < len) { as_re_buf_append(&out, &cap, &olen, s + m, 1); pos = m + 1; }
        else pos = m + 1;
    }
    if (pos <= len) as_re_buf_append(&out, &cap, &olen, s + pos, (size_t)(len - pos));
    out[olen] = 0;
    return out;
}

// String.replace(RegExp, replFn): replace each match (or only the first when
// not global) with the string returned by calling replFn(match, p1..pn, offset,
// input). The callback is a boxed AS3 function value (as_fn); its result is
// stringified with AS3's ToString. Non-participating groups arrive as undefined.
static char* as_str_replace_regex_fn(char* s, as_regex* re, as_fn repl) {
    int len = (int)strlen(s);
    size_t cap = (size_t)len + 64;
    char* out = (char*)malloc(cap);
    size_t olen = 0;
    int pos = 0;
    int global = (re->flags & 8) != 0;
    int cap2[2 * (AS_RE_MAX_GROUPS + 1)];
    int ngroups = re->ngroups;
    int argc = ngroups + 3;  // match, p1..pn, offset, input
    while (pos <= len) {
        int end = -1;
        int m = as_regex_search(re, s, len, pos, cap2, &end);
        if (m < 0) break;
        as_re_buf_append(&out, &cap, &olen, s + pos, (size_t)(m - pos));
        as_value* args = (as_value*)malloc((size_t)argc * sizeof(as_value));
        args[0] = as_v_str(as_str_substring(s, m, end));
        for (int g = 1; g <= ngroups; g++) {
            int gs = cap2[2 * g], ge = cap2[2 * g + 1];
            if (gs < 0 || ge < 0) args[g] = as_v_undefined();
            else args[g] = as_v_str(as_str_substring(s, gs, ge));
        }
        args[ngroups + 1] = as_v_num((double)m);
        args[ngroups + 2] = as_v_str(s);
        char* rep = as_v_str_val(repl->fn(repl->env, args, argc));
        as_re_buf_append(&out, &cap, &olen, rep, strlen(rep));
        free(args);
        if (!global) { pos = end; break; }
        if (end > m) pos = end;
        else if (m < len) { as_re_buf_append(&out, &cap, &olen, s + m, 1); pos = m + 1; }
        else pos = m + 1;
    }
    if (pos <= len) as_re_buf_append(&out, &cap, &olen, s + pos, (size_t)(len - pos));
    out[olen] = 0;
    return out;
}

// ---------- JSON (top-level JSON.stringify / JSON.parse) ----------
// A small growable string buffer used only by JSON.stringify; it is malloc-
// backed and freed once the final arena string is materialized.
typedef struct { char* buf; size_t len; size_t cap; } as_json_buf;
static void as_json_buf_init(as_json_buf* b) {
    b->cap = 64;
    b->len = 0;
    b->buf = (char*)malloc(b->cap);
    b->buf[0] = 0;
}
static void as_json_buf_grow(as_json_buf* b, size_t extra) {
    if (b->len + extra + 1 <= b->cap) return;
    size_t cap = b->cap;
    while (cap < b->len + extra + 1) cap *= 2;
    b->buf = (char*)realloc(b->buf, cap);
    b->cap = cap;
}
static void as_json_buf_append(as_json_buf* b, const char* s, size_t n) {
    as_json_buf_grow(b, n);
    memcpy(b->buf + b->len, s, n);
    b->len += n;
    b->buf[b->len] = 0;
}
static void as_json_buf_append_cstr(as_json_buf* b, const char* s) {
    as_json_buf_append(b, s, strlen(s));
}
static void as_json_buf_append_char(as_json_buf* b, char c) {
    as_json_buf_append(b, &c, 1);
}
// Append s as a JSON string literal: quoted, with \", \\ and the control
// characters (U+0000..U+001F) escaped per JSON.
static void as_json_buf_append_string(as_json_buf* b, const char* s) {
    as_json_buf_append_char(b, '"');
    for (const char* p = s; *p; p++) {
        unsigned char c = (unsigned char)*p;
        switch (c) {
            case '"':  as_json_buf_append(b, "\\\"", 2); break;
            case '\\\\': as_json_buf_append(b, "\\\\", 2); break;
            case '\\n': as_json_buf_append(b, "\\\\n", 2); break;
            case '\\r': as_json_buf_append(b, "\\\\r", 2); break;
            case '\\t': as_json_buf_append(b, "\\\\t", 2); break;
            case '\\b': as_json_buf_append(b, "\\\\b", 2); break;
            case '\\f': as_json_buf_append(b, "\\\\f", 2); break;
            default:
                if (c < 0x20) {
                    char hex[8];
                    snprintf(hex, sizeof(hex), "\\\\u%04x", c);
                    as_json_buf_append_cstr(b, hex);
                } else {
                    as_json_buf_append_char(b, (char)c);
                }
        }
    }
    as_json_buf_append_char(b, '"');
}

static void as_json_stringify_rec(as_json_buf* b, as_value v) {
    switch (v.tag) {
        case 0: as_json_buf_append_cstr(b, "null"); break;
        case 1:
            // JSON has no NaN/Infinity; ECMAScript JSON.stringify serializes
            // them as null.
            if (isnan(v.num) || isinf(v.num)) as_json_buf_append_cstr(b, "null");
            else as_json_buf_append_cstr(b, as_str_from_double(v.num));
            break;
        case 2: as_json_buf_append_cstr(b, (v.num != 0.0) ? "true" : "false"); break;
        case 3: as_json_buf_append_string(b, (char*)v.ptr); break;
        case 5: as_json_buf_append_cstr(b, "null"); break;
        case 6: {
            as_array* a = (as_array*)v.ptr;
            as_json_buf_append_char(b, '[');
            for (int i = 0; i < a->length; i++) {
                if (i > 0) as_json_buf_append_char(b, ',');
                as_json_stringify_rec(b, a->data[i]);
            }
            as_json_buf_append_char(b, ']');
            break;
        }
        case 4: {
            as_object* o = (as_object*)v.ptr;
            as_json_buf_append_char(b, '{');
            for (int i = 0; i < o->length; i++) {
                if (i > 0) as_json_buf_append_char(b, ',');
                as_json_buf_append_string(b, o->keys[i]);
                as_json_buf_append_char(b, ':');
                as_json_stringify_rec(b, o->vals[i]);
            }
            as_json_buf_append_char(b, '}');
            break;
        }
        default: as_json_buf_append_cstr(b, "null"); break;
    }
}
static char* as_json_stringify(as_value v) {
    as_json_buf b;
    as_json_buf_init(&b);
    as_json_stringify_rec(&b, v);
    char* r = as_str_alloc(b.len + 1);
    strcpy(r, b.buf);
    free(b.buf);
    return r;
}

// JSON.parse: a strict recursive-descent parser over a C string. Whitespace is
// skipped, then a value is dispatched on the first non-space character. Object
// keys and string values are unescaped into arena strings so they share the
// program-lifetime semantics of the rest of the runtime.
static void as_json_skip_ws(const char** p) {
    while (**p == ' ' || **p == '\\t' || **p == '\\n' || **p == '\\r') (*p)++;
}

// Parse a JSON string literal (the caller has already consumed the opening '"').
static char* as_json_parse_string(const char** p) {
    const char* s = *p;
    size_t cap = strlen(s) + 1;
    char* out = (char*)malloc(cap);
    size_t len = 0;
    while (*s && *s != '"') {
        if (*s == '\\\\') {
            s++;
            char c;
            switch (*s) {
                case '"': c = '"'; s++; break;
                case '\\\\': c = '\\\\'; s++; break;
                case '/': c = '/'; s++; break;
                case 'b': c = '\\b'; s++; break;
                case 'f': c = '\\f'; s++; break;
                case 'n': c = '\\n'; s++; break;
                case 'r': c = '\\r'; s++; break;
                case 't': c = '\\t'; s++; break;
                case 'u': {
                    // \\uXXXX: decode a UTF-16 code unit (BMP only; surrogate
                    // pairs and non-ASCII code points emit a single Latin-1 byte,
                    // a documented subset limitation).
                    if (s[1] && s[2] && s[3] && s[4]) {
                        char hex[5] = { s[1], s[2], s[3], s[4], 0 };
                        c = (char)strtol(hex, NULL, 16);
                        s += 5;
                    } else {
                        c = '?';
                        s++;
                    }
                    break;
                }
                default: c = *s ? *s : '?'; s++; break;
            }
            out[len++] = c;
        } else {
            out[len++] = *s++;
        }
    }
    if (*s == '"') s++;
    out[len] = 0;
    *p = s;
    char* r = as_str_alloc(len + 1);
    strcpy(r, out);
    free(out);
    return r;
}

static as_value as_json_parse_value(const char** p);
static as_value as_json_parse_object(const char** p);
static as_value as_json_parse_array(const char** p);

static as_value as_json_parse_object(const char** p) {
    // caller consumed '{'
    as_object* o = as_object_new();
    as_json_skip_ws(p);
    if (**p == '}') { (*p)++; return as_v_obj((void*)o); }
    while (1) {
        as_json_skip_ws(p);
        if (**p != '"') { (*p)++; continue; }
        (*p)++;
        char* key = as_json_parse_string(p);
        as_json_skip_ws(p);
        if (**p == ':') (*p)++;
        as_json_skip_ws(p);
        as_value val = as_json_parse_value(p);
        as_object_set(o, key, val);
        as_json_skip_ws(p);
        if (**p == ',') { (*p)++; continue; }
        if (**p == '}') { (*p)++; break; }
        (*p)++;
    }
    return as_v_obj((void*)o);
}

static as_value as_json_parse_array(const char** p) {
    // caller consumed '['
    as_array* a = as_array_new();
    as_json_skip_ws(p);
    if (**p == ']') { (*p)++; return as_v_arr((void*)a); }
    while (1) {
        as_json_skip_ws(p);
        as_value val = as_json_parse_value(p);
        as_array_push(a, val);
        as_json_skip_ws(p);
        if (**p == ',') { (*p)++; continue; }
        if (**p == ']') { (*p)++; break; }
        (*p)++;
    }
    return as_v_arr((void*)a);
}

static as_value as_json_parse_value(const char** p) {
    as_json_skip_ws(p);
    char c = **p;
    if (c == '{') { (*p)++; return as_json_parse_object(p); }
    if (c == '[') { (*p)++; return as_json_parse_array(p); }
    if (c == '"') { (*p)++; char* s = as_json_parse_string(p); return as_v_str(s); }
    if (c == 't' && strncmp(*p, "true", 4) == 0) { *p += 4; return as_v_bool(true); }
    if (c == 'f' && strncmp(*p, "false", 5) == 0) { *p += 5; return as_v_bool(false); }
    if (c == 'n' && strncmp(*p, "null", 4) == 0) { *p += 4; return as_v_null(); }
    char* end = NULL;
    double d = strtod(*p, &end);
    if (end && end > *p) { *p = end; return as_v_num(d); }
    (*p)++;
    return as_v_null();
}
static as_value as_json_parse(char* s) {
    const char* p = s;
    return as_json_parse_value(&p);
}

// ---------- Skia raster backend bridge (stage 36) ----------
// These declarations expose the C++ glue layer (vendor/skia_glue.cc) to the
// generated C. They are compiled in only when ASC_USE_SKIA is defined (via a
// build manifest "defines"), so pure-C builds stay link-clean. The stage-37
// DisplayObject.render() will drive these through as_skia_* semantic wrappers.
#ifdef ASC_USE_SKIA
extern void* sk_surface_raster_new(int w, int h);
extern void* sk_surface_canvas(void* surface);
extern void* sk_surface_make_snapshot(void* surface);
extern void sk_surface_delete(void* surface);
extern void sk_canvas_clear(void* canvas, unsigned rgb);
extern void sk_canvas_save(void* canvas);
extern void sk_canvas_restore(void* canvas);
extern void sk_canvas_translate(void* canvas, double x, double y);
extern void sk_canvas_rotate(void* canvas, double degrees);
extern void sk_canvas_scale(void* canvas, double sx, double sy);
extern void sk_canvas_save_layer_alpha(void* canvas, double alpha);
extern void sk_canvas_draw_rect(void* canvas, double x, double y, double w, double h, void* paint);
extern void sk_canvas_draw_circle(void* canvas, double cx, double cy, double r, void* paint);
extern void sk_canvas_draw_path(void* canvas, void* path, void* paint);
extern void sk_canvas_clip_rect(void* canvas, double x, double y, double w, double h);
extern void* sk_paint_new(void);
extern void sk_paint_delete(void* paint);
extern void sk_paint_set_color(void* paint, unsigned rgb);
extern void sk_paint_set_alpha(void* paint, double alpha);
extern void sk_paint_set_fill(void* paint);
extern void sk_paint_set_stroke(void* paint);
extern void sk_paint_set_stroke_width(void* paint, double w);
extern void sk_paint_set_antialias(void* paint, int on);
extern void* sk_path_new(void);
extern void sk_path_delete(void* path);
extern void sk_path_move_to(void* path, double x, double y);
extern void sk_path_line_to(void* path, double x, double y);
extern void sk_path_cubic_to(void* path, double c1x, double c1y, double c2x, double c2y, double x, double y);
extern void sk_path_quad_to(void* path, double cx, double cy, double x, double y);
extern void sk_path_add_rect(void* path, double x, double y, double w, double h);
extern void sk_path_add_circle(void* path, double cx, double cy, double r);
extern void sk_path_close(void* path);
extern int sk_path_get_bounds(void* path, double* l, double* t, double* r, double* b);
extern int sk_image_encode_png(void* image, const char* path);
extern void sk_image_delete(void* image);
extern void sk_paint_set_linear_gradient(void* paint, double x0, double y0, double x1, double y1, unsigned rgb0, double a0, unsigned rgb1, double a1);
extern void* sk_image_from_file(const char* path);
extern void sk_canvas_draw_image_rect(void* canvas, void* image, double dx, double dy, double dw, double dh);
extern void sk_canvas_draw_text(void* canvas, const char* text, double x, double y, double size, int bold, int italic, void* paint);
extern void sk_canvas_draw_text_n(void* canvas, const char* text, int len, double x, double y, double size, int bold, int italic, void* paint);
extern double sk_text_measure(const char* text, double size, int bold, int italic);
extern double sk_text_measure_n(const char* text, int len, double size, int bold, int italic);
extern void sk_paint_set_image_filter_blur(void* paint, double sigmaX, double sigmaY);
extern void sk_paint_set_image_filter_drop_shadow(void* paint, double dx, double dy, double sigmaX, double sigmaY, unsigned rgb, double alpha);
extern void sk_paint_set_image_filter_glow(void* paint, double sigmaX, double sigmaY, unsigned rgb, double alpha);
extern void sk_canvas_save_layer_paint(void* canvas, void* paint);
extern void sk_canvas_save_layer_paint_bounds(void* canvas, void* paint, double l, double t, double r, double b);

// as_skia_* semantic wrappers: the entry points DisplayObject.render() drives.
// They are static inline so they emit no symbol unless actually called, keeping
// pure-C (ASC_USE_SKIA undefined) builds link-clean.
static inline void* as_skia_surface_new(int w, int h) { return sk_surface_raster_new(w, h); }
static inline void* as_skia_surface_canvas(void* s) { return sk_surface_canvas(s); }
static inline void as_skia_surface_delete(void* s) { sk_surface_delete(s); }
static inline void as_skia_surface_save_png(void* s, const char* path) {
    void* img = sk_surface_make_snapshot(s);
    if (img) { sk_image_encode_png(img, path); sk_image_delete(img); }
}
static inline void* as_skia_paint_fill(unsigned rgb, double alpha) {
    void* p = sk_paint_new();
    sk_paint_set_color(p, rgb); sk_paint_set_alpha(p, alpha); sk_paint_set_fill(p);
    return p;
}
static inline void* as_skia_paint_stroke(unsigned rgb, double alpha, double width) {
    void* p = sk_paint_new();
    sk_paint_set_color(p, rgb); sk_paint_set_alpha(p, alpha); sk_paint_set_stroke(p);
    sk_paint_set_stroke_width(p, width);
    return p;
}
static inline void as_skia_paint_delete(void* p) { sk_paint_delete(p); }
static inline void as_skia_canvas_clear(void* c, unsigned rgb) { sk_canvas_clear(c, rgb); }
static inline void as_skia_canvas_draw_rect(void* c, double x, double y, double w, double h, void* p) { sk_canvas_draw_rect(c, x, y, w, h, p); }
static inline void as_skia_canvas_draw_circle(void* c, double cx, double cy, double r, void* p) { sk_canvas_draw_circle(c, cx, cy, r, p); }
static inline void as_skia_canvas_draw_path(void* c, void* path, void* paint) { sk_canvas_draw_path(c, path, paint); }
static inline void as_skia_canvas_clip_rect(void* c, double x, double y, double w, double h) { sk_canvas_clip_rect(c, x, y, w, h); }
static inline void as_skia_canvas_translate(void* c, double x, double y) { sk_canvas_translate(c, x, y); }
static inline void as_skia_canvas_rotate(void* c, double deg) { sk_canvas_rotate(c, deg); }
static inline void as_skia_canvas_scale(void* c, double sx, double sy) { sk_canvas_scale(c, sx, sy); }
static inline void as_skia_canvas_save_layer_alpha(void* c, double a) { sk_canvas_save_layer_alpha(c, a); }
static inline void as_skia_canvas_save(void* c) { sk_canvas_save(c); }
static inline void as_skia_canvas_restore(void* c) { sk_canvas_restore(c); }
static inline void* as_skia_path_new(void) { return sk_path_new(); }
static inline void as_skia_path_delete(void* p) { sk_path_delete(p); }
static inline void as_skia_path_move_to(void* p, double x, double y) { sk_path_move_to(p, x, y); }
static inline void as_skia_path_line_to(void* p, double x, double y) { sk_path_line_to(p, x, y); }
static inline void as_skia_path_cubic_to(void* p, double c1x, double c1y, double c2x, double c2y, double x, double y) { sk_path_cubic_to(p, c1x, c1y, c2x, c2y, x, y); }
static inline void as_skia_path_quad_to(void* p, double cx, double cy, double x, double y) { sk_path_quad_to(p, cx, cy, x, y); }
static inline void as_skia_path_add_rect(void* p, double x, double y, double w, double h) { sk_path_add_rect(p, x, y, w, h); }
static inline void as_skia_path_add_circle(void* p, double cx, double cy, double r) { sk_path_add_circle(p, cx, cy, r); }
static inline void as_skia_path_close(void* p) { sk_path_close(p); }
static inline int as_skia_path_get_bounds(void* p, double* l, double* t, double* r, double* b) { return sk_path_get_bounds(p, l, t, r, b); }
static inline void as_skia_paint_set_linear_gradient(void* p, double x0, double y0, double x1, double y1, unsigned rgb0, double a0, unsigned rgb1, double a1) { sk_paint_set_linear_gradient(p, x0, y0, x1, y1, rgb0, a0, rgb1, a1); }
static inline void* as_skia_image_from_file(const char* path) { return sk_image_from_file(path); }
static inline void as_skia_canvas_draw_image_rect(void* c, void* img, double dx, double dy, double dw, double dh) { sk_canvas_draw_image_rect(c, img, dx, dy, dw, dh); }
static inline void as_skia_canvas_draw_text(void* c, const char* t, double x, double y, double sz, int bold, int italic, void* p) { sk_canvas_draw_text(c, t, x, y, sz, bold, italic, p); }
static inline void as_skia_canvas_draw_text_n(void* c, const char* t, int len, double x, double y, double sz, int bold, int italic, void* p) { sk_canvas_draw_text_n(c, t, len, x, y, sz, bold, italic, p); }
static inline double as_skia_text_measure(const char* t, double sz, int bold, int italic) { return sk_text_measure(t, sz, bold, italic); }
static inline double as_skia_text_measure_n(const char* t, int len, double sz, int bold, int italic) { return sk_text_measure_n(t, len, sz, bold, italic); }
static inline void as_skia_paint_set_blur(void* p, double sx, double sy) { sk_paint_set_image_filter_blur(p, sx, sy); }
static inline void as_skia_paint_set_drop_shadow(void* p, double dx, double dy, double sx, double sy, unsigned rgb, double a) { sk_paint_set_image_filter_drop_shadow(p, dx, dy, sx, sy, rgb, a); }
static inline void as_skia_paint_set_glow(void* p, double sx, double sy, unsigned rgb, double a) { sk_paint_set_image_filter_glow(p, sx, sy, rgb, a); }
static inline void as_skia_canvas_save_layer_paint(void* c, void* p) { sk_canvas_save_layer_paint(c, p); }
static inline void as_skia_canvas_save_layer_paint_bounds(void* c, void* p, double l, double t, double r, double b) { sk_canvas_save_layer_paint_bounds(c, p, l, t, r, b); }
#ifdef ASC_USE_WINDOW
extern int sk_window_show(void* surface, int w, int h, int pw, int ph, const char* title,
                          int fullscreen,
                          void (*on_mouse)(double, double, const char*),
                          void (*on_wheel)(double, double, double),
                          void (*on_redraw)(void),
                          void (*on_frame)(void),
                          double (*on_frame_delay)(void),
                          void* (*on_resize)(int, int, int, int));
extern double sk_window_probe_scale(int w, int h, int highdpi, int* pw, int* ph);
extern int sk_window_get_display_size(int* w, int* h);
extern double sk_window_get_display_refresh(void);
#endif
// How many physical pixels a logical w*h window draws into. Returns the device
// scale (2.0 on a Retina display when <requestedDisplayResolution>high is in
// effect) and writes the pixel size the offscreen surface must be created at.
// Without the window backend, or without ASC_DISPLAY_HIGH, this is 1.0 and the
// pixel size mirrors the logical size — matching AIR's "standard" resolution.
static inline double as_window_device_scale(int w, int h, int* pw, int* ph) {
#ifdef ASC_USE_WINDOW
#ifdef ASC_DISPLAY_HIGH
    return sk_window_probe_scale(w, h, 1, pw, ph);
#else
    if (pw) *pw = w; if (ph) *ph = h; return 1.0;
#endif
#else
    (void)w; (void)h; if (pw) *pw = w; if (ph) *ph = h; return 1.0;
#endif
}
// The primary display's refresh rate in Hz, or 0 when it cannot be determined.
// This backs Stage.frameRate's "unset" fallback: frameRate <= 0 means "follow
// the display" (vsync cadence) rather than a hard-coded default.
static inline double as_window_display_refresh(void) {
#ifdef ASC_USE_WINDOW
    return sk_window_get_display_refresh();
#else
    return 0.0;
#endif
}
// Present the raster surface in an SDL2 window and run the event loop. When
// ASC_USE_WINDOW is not defined (offscreen-only build) this is a safe no-op.
// on_resize lets the AS3 side rebuild the surface at the window's new physical
// size (and re-render) so a resized window never stretches the content.
static inline int as_skia_surface_show_window(void* s, int w, int h, int pw, int ph,
                                              const char* title, int fullscreen,
                                              void (*on_mouse)(double, double, const char*),
                                              void (*on_wheel)(double, double, double),
                                              void (*on_redraw)(void),
                                              void (*on_frame)(void),
                                              double (*on_frame_delay)(void),
                                              void* (*on_resize)(int, int, int, int)) {
#ifdef ASC_USE_WINDOW
    return sk_window_show(s, w, h, pw, ph, title, fullscreen, on_mouse, on_wheel, on_redraw, on_frame, on_frame_delay, on_resize);
#else
    (void)s; (void)w; (void)h; (void)pw; (void)ph; (void)title; (void)fullscreen;
    (void)on_mouse; (void)on_wheel; (void)on_redraw; (void)on_frame; (void)on_frame_delay; (void)on_resize; return 0;
#endif
}
// Query the primary display resolution (Stage.fullScreenWidth/fullScreenHeight).
// Returns 0 (and writes 0) when the SDL2 window backend is not linked in.
static inline int as_window_get_display_size(int* w, int* h) {
#ifdef ASC_USE_WINDOW
    return sk_window_get_display_size(w, h);
#else
    if (w) *w = 0; if (h) *h = 0; return 0;
#endif
}
#else
// Pure-C builds still emit the Graphics/Shape/Bitmap/TextField C definitions
// (they are dead code unless the program uses those classes); these no-op
// stubs let that code compile and link without a Skia toolchain.
static inline void* as_skia_surface_new(int w, int h) { (void)w; (void)h; return NULL; }
static inline void* as_skia_surface_canvas(void* s) { (void)s; return NULL; }
static inline void as_skia_surface_delete(void* s) { (void)s; }
static inline void as_skia_surface_save_png(void* s, const char* path) { (void)s; (void)path; }
static inline void* as_skia_paint_fill(unsigned rgb, double alpha) { (void)rgb; (void)alpha; return NULL; }
static inline void* as_skia_paint_stroke(unsigned rgb, double alpha, double width) { (void)rgb; (void)alpha; (void)width; return NULL; }
static inline void as_skia_paint_delete(void* p) { (void)p; }
static inline void as_skia_canvas_clear(void* c, unsigned rgb) { (void)c; (void)rgb; }
static inline void as_skia_canvas_draw_rect(void* c, double x, double y, double w, double h, void* p) { (void)c; (void)x; (void)y; (void)w; (void)h; (void)p; }
static inline void as_skia_canvas_draw_circle(void* c, double cx, double cy, double r, void* p) { (void)c; (void)cx; (void)cy; (void)r; (void)p; }
static inline void as_skia_canvas_draw_path(void* c, void* path, void* paint) { (void)c; (void)path; (void)paint; }
static inline void as_skia_canvas_clip_rect(void* c, double x, double y, double w, double h) { (void)c; (void)x; (void)y; (void)w; (void)h; }
static inline void as_skia_canvas_translate(void* c, double x, double y) { (void)c; (void)x; (void)y; }
static inline void as_skia_canvas_rotate(void* c, double deg) { (void)c; (void)deg; }
static inline void as_skia_canvas_scale(void* c, double sx, double sy) { (void)c; (void)sx; (void)sy; }
static inline void as_skia_canvas_save_layer_alpha(void* c, double a) { (void)c; (void)a; }
static inline void as_skia_canvas_save(void* c) { (void)c; }
static inline void as_skia_canvas_restore(void* c) { (void)c; }
static inline void* as_skia_path_new(void) { return NULL; }
static inline void as_skia_path_delete(void* p) { (void)p; }
static inline void as_skia_path_move_to(void* p, double x, double y) { (void)p; (void)x; (void)y; }
static inline void as_skia_path_line_to(void* p, double x, double y) { (void)p; (void)x; (void)y; }
static inline void as_skia_path_cubic_to(void* p, double c1x, double c1y, double c2x, double c2y, double x, double y) { (void)p; (void)c1x; (void)c1y; (void)c2x; (void)c2y; (void)x; (void)y; }
static inline void as_skia_path_quad_to(void* p, double cx, double cy, double x, double y) { (void)p; (void)cx; (void)cy; (void)x; (void)y; }
static inline void as_skia_path_add_rect(void* p, double x, double y, double w, double h) { (void)p; (void)x; (void)y; (void)w; (void)h; }
static inline void as_skia_path_add_circle(void* p, double cx, double cy, double r) { (void)p; (void)cx; (void)cy; (void)r; }
static inline void as_skia_path_close(void* p) { (void)p; }
static inline int as_skia_path_get_bounds(void* p, double* l, double* t, double* r, double* b) { (void)p; (void)l; (void)t; (void)r; (void)b; return 0; }
static inline void as_skia_paint_set_linear_gradient(void* p, double x0, double y0, double x1, double y1, unsigned rgb0, double a0, unsigned rgb1, double a1) { (void)p; (void)x0; (void)y0; (void)x1; (void)y1; (void)rgb0; (void)a0; (void)rgb1; (void)a1; }
static inline void* as_skia_image_from_file(const char* path) { (void)path; return NULL; }
static inline void as_skia_canvas_draw_image_rect(void* c, void* img, double dx, double dy, double dw, double dh) { (void)c; (void)img; (void)dx; (void)dy; (void)dw; (void)dh; }
static inline void as_skia_canvas_draw_text(void* c, const char* t, double x, double y, double sz, int bold, int italic, void* p) { (void)c; (void)t; (void)x; (void)y; (void)sz; (void)bold; (void)italic; (void)p; }
static inline void as_skia_canvas_draw_text_n(void* c, const char* t, int len, double x, double y, double sz, int bold, int italic, void* p) { (void)c; (void)t; (void)len; (void)x; (void)y; (void)sz; (void)bold; (void)italic; (void)p; }
static inline double as_skia_text_measure(const char* t, double sz, int bold, int italic) { (void)t; (void)sz; (void)bold; (void)italic; return 0.0; }
static inline double as_skia_text_measure_n(const char* t, int len, double sz, int bold, int italic) { (void)t; (void)len; (void)sz; (void)bold; (void)italic; return 0.0; }
static inline void as_skia_paint_set_blur(void* p, double sx, double sy) { (void)p; (void)sx; (void)sy; }
static inline void as_skia_paint_set_drop_shadow(void* p, double dx, double dy, double sx, double sy, unsigned rgb, double a) { (void)p; (void)dx; (void)dy; (void)sx; (void)sy; (void)rgb; (void)a; }
static inline void as_skia_paint_set_glow(void* p, double sx, double sy, unsigned rgb, double a) { (void)p; (void)sx; (void)sy; (void)rgb; (void)a; }
static inline void as_skia_canvas_save_layer_paint(void* c, void* p) { (void)c; (void)p; }
static inline void as_skia_canvas_save_layer_paint_bounds(void* c, void* p, double l, double t, double r, double b) { (void)c; (void)p; (void)l; (void)t; (void)r; (void)b; }
static inline int as_skia_surface_show_window(void* s, int w, int h, int pw, int ph, const char* title, int fullscreen, void (*on_mouse)(double, double, const char*), void (*on_wheel)(double, double, double), void (*on_redraw)(void), void (*on_frame)(void), double (*on_frame_delay)(void), void* (*on_resize)(int, int, int, int)) { (void)s; (void)w; (void)h; (void)pw; (void)ph; (void)title; (void)fullscreen; (void)on_mouse; (void)on_wheel; (void)on_redraw; (void)on_frame; (void)on_frame_delay; (void)on_resize; return 0; }
static inline int as_window_get_display_size(int* w, int* h) { if (w) *w = 0; if (h) *h = 0; return 0; }
static inline double as_window_device_scale(int w, int h, int* pw, int* ph) { if (pw) *pw = w; if (ph) *ph = h; (void)w; (void)h; return 1.0; }
static inline double as_window_display_refresh(void) { return 0.0; }
#endif

// ---------- TextField text layout (stage 44) ----------
// AIR's TextField breaks text into display lines: an explicit newline always
// starts a new line, and with wordWrap set a line additionally breaks at the last
// space that still fits the field width. Widths are measured with the same Skia
// font used to draw, so the wrap points match what is rendered. A single word
// wider than the field overflows on its own line rather than being split — that
// is AIR's behavior too (wordWrap breaks on spaces, never mid-word).
//
// A laid-out line is a (start,len) slice *into* the original string, never a copy:
// AS3 strings come from as_alloc (a bump allocator whose blocks are never freed
// individually), so copying each line would either leak on every repaint or crash
// when free() meets an arena pointer. Offsets keep layout allocation-free apart
// from the index array, which this layer owns.
typedef struct {
  int start;
  int len;
} AsLine;

typedef struct {
  AsLine* items;
  int count;
  int cap;
} AsLines;

static void as_lines_push(AsLines* L, int start, int len) {
  if (L->count == L->cap) {
    L->cap = L->cap ? L->cap * 2 : 16;
    L->items = (AsLine*)realloc(L->items, sizeof(AsLine) * (size_t)L->cap);
  }
  L->items[L->count].start = start;
  L->items[L->count].len = len;
  L->count++;
}

static void as_lines_reset(AsLines* L) {
  L->items = NULL; L->count = 0; L->cap = 0;
}

static void as_lines_free(AsLines* L) {
  free(L->items);
  as_lines_reset(L);
}

// Break the [start,end) half-open slice (no newlines inside) into wrapped lines.
static void as_text_wrap_segment(const char* text, int start, int end, double maxW,
                                 double size, int bold, int italic, AsLines* out) {
  double spaceW = as_skia_text_measure_n(" ", 1, size, bold, italic);
  int i = start;
  int lineStart = i;
  int lastEnd = i;
  double x = 0.0;
  if (i >= end) { as_lines_push(out, start, 0); return; }
  while (i < end) {
    while (i < end && text[i] == ' ') i++;          // skip inter-word spaces
    if (i >= end) break;
    int ws = i;
    while (i < end && text[i] != ' ') i++;
    double wordW = as_skia_text_measure_n(text + ws, i - ws, size, bold, italic);
    double next = (x > 0.0) ? (x + spaceW + wordW) : wordW;
    if (x > 0.0 && next > maxW) {                   // this word no longer fits
      as_lines_push(out, lineStart, lastEnd - lineStart);
      lineStart = ws; x = wordW;
    } else {
      x = next;
    }
    lastEnd = i;
  }
  as_lines_push(out, lineStart, lastEnd - lineStart);
}

static void as_text_wrap(const char* text, double maxW, double size, int bold, int italic,
                         int wordWrap, AsLines* out) {
  as_lines_reset(out);
  if (text == NULL) return;
  int n = (int)strlen(text);
  int start = 0;
  for (;;) {
    int nl = start;
    while (nl < n && text[nl] != '\\n') nl++;
    if (wordWrap && maxW > 0.0) {
      as_text_wrap_segment(text, start, nl, maxW, size, bold, italic, out);
    } else {
      as_lines_push(out, start, nl - start);
    }
    if (nl >= n) break;
    start = nl + 1;
  }
}

// ---------- flash.system.System memory stats ----------
// There is no AVM2 GC heap in this runtime: totalMemory/freeMemory are a
// 'runtime-managed heap' approximation (arena used + scattered heap, arena cap
// minus used). Their absolute values do NOT equal AIR's; only the trend
// (grows with allocation, shrinks with release) is comparable. privateMemory is
// the real OS process resident size and IS directly comparable.
static double as_system_total_memory_number(void) {
    return (double)(as_arena_used_bytes() + as_heap_bytes + gc_heap_used_bytes());
}
// uint totalMemory: Flash/AIR returns 0 above uint.MAX_VALUE (4 GiB).
static unsigned as_system_total_memory(void) {
    size_t bytes = as_arena_used_bytes() + as_heap_bytes + gc_heap_used_bytes();
    return (bytes > 0xFFFFFFFFu) ? 0u : (unsigned)bytes;
}
static double as_system_free_memory(void) {
    // Bump allocator's 'requested-but-unused' slack within arena segments, plus
    // the GC heap's own free-list slack (total requested minus live bytes).
    double arena_slack = (double)as_arena_cap_bytes() - (double)as_arena_used_bytes();
    double gc_slack = (double)gc_heap_total_bytes() - (double)gc_heap_used_bytes();
    return arena_slack + gc_slack;
}
static double as_system_private_memory(void) {
#ifdef __APPLE__
    mach_task_basic_info_data_t info;
    mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
    if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO, (task_info_t)&info, &count) == KERN_SUCCESS) {
        return (double)info.resident_size;  // bytes
    }
    return 0.0;
#elif defined(_WIN32)
    PROCESS_MEMORY_COUNTERS pmc;
    if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc))) {
        return (double)pmc.WorkingSetSize;  // bytes
    }
    return 0.0;
#elif defined(__wasi__)
    return as_system_total_memory_number();  // no process-memory API on WASI
#else
    struct rusage r;
    if (getrusage(RUSAGE_SELF, &r) == 0) {
#ifdef __linux__
        return (double)r.ru_maxrss * 1024.0;  // Linux reports KB, not bytes
#else
        return (double)r.ru_maxrss;  // bytes on macOS/BSD
#endif
    }
    return 0.0;
#endif
}
// System.gc(): force a stop-the-world collection. AIR exposes this for manual
// GC; the frame loop instead calls gc_step() incrementally at the safe point,
// but this lets offscreen scripts trigger a full collection inside a loop.
static void as_system_gc(void) {
    gc_collect();
}
// System.output(): write a string verbatim to stdout (AIR 33.1 console output).
// No trailing newline is added — AIR outputs exactly the given string.
static void as_system_output(const char* s) {
    fputs(s, stdout);
}
`;
