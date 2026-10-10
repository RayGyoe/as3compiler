// C runtime helpers: the pre-pended preamble providing string concat, type
// boxing, and the vtable-based runtime subtype check used by `is`/`as`.

export const RUNTIME_PREAMBLE = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <errno.h>   // strtoll/strtoull overflow detection for int64()/uint64()
// MSVC gates the POSIX M_* math constants (M_PI, emitted for Math.PI) behind
// _USE_MATH_DEFINES; define it so the token resolves identically everywhere.
#define _USE_MATH_DEFINES
#include <math.h>
#include <ctype.h>
#include <setjmp.h>
#include <time.h>
// dlfcn.h (and Dl_info/dladdr below) is POSIX; wasi-libc ships the header but
// not the Apple/POSIX symbol-probe API, and Windows has no dlfcn.h at all, so
// the include is skipped on both — the probe degrades to a bare address there
// (see gc_dbg_sym below).
#if !defined(__wasi__) && !defined(_WIN32)
#include <dlfcn.h>
#endif
#include <sys/stat.h>
// MSVC's <sys/stat.h> has st_mode/_S_IFMT/_S_IFDIR but not the POSIX S_ISDIR()
// macro; define it so as_path_is_dir() reads identically on every platform.
#ifndef S_ISDIR
#define S_ISDIR(m) (((m) & _S_IFMT) == _S_IFDIR)
#endif
// dirent.h (opendir/readdir/closedir) is POSIX-only: MSVC ships no such header,
// and Windows directory enumeration goes through FindFirstFile/FindNextFile
// (the File.getDirectoryListing body in emit.ts). WASI ships dirent.h, so this
// is skipped for Win32 only.
#if !defined(_WIN32)
#include <dirent.h>
#endif
// Emscripten glue (EM_ASM / EM_ASM_INT / EM_JS / UTF8ToString / HEAPU8). Needed
// by the web target regardless of the network backend: navigateToURL alone uses
// EM_ASM to call window.open, and the fetch backend adds the rest.
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif
// navigateToURL / sendToURL hand a URL to the platform's default handler by
// spawning it (fork+exec, see as_open_external); that needs <unistd.h> for
// fork/execlp/dup2, <fcntl.h> for the /dev/null the child detaches onto, and
// <signal.h> for SIGCHLD. WASI has none of them (there is no process to hand
// the URL to) and Windows uses ShellExecuteA instead.
#if !defined(__wasi__) && !defined(_WIN32) && !defined(__EMSCRIPTEN__)
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#endif
// flash.system.System.privateMemory reads the real process resident size. The
// query API differs per platform: Mach on Apple, PSAPI on Windows, getrusage on
// Linux/other POSIX; WASI has no process-memory API so it degrades (see
// as_system_private_memory below).
#ifdef __APPLE__
#include <mach/mach.h>
#include <mach/mach_init.h>
// malloc_zone_pressure_relief: the macOS allocator only returns freed pages to
// the OS when asked (see gc_trim_os below).
#include <malloc/malloc.h>
#elif defined(_WIN32)
// <windows.h> pulls in <wingdi.h>, whose GDI Rectangle() function collides with
// the C struct that flash.geom.Rectangle compiles to (typedef struct Rectangle
// Rectangle) — a redefinition error under the MSVC headers. NOGDI drops the whole
// GDI section; the generated C never calls a GDI entry point (all GPU/D3D work
// lives in the separate d3d_glue.cc translation unit), so it loses nothing.
#define NOGDI
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
// gettimeofday is POSIX-only; WASI has no sys/time.h and Windows reads the NT
// system clock instead, so wall-clock time is abstracted behind as_now_ms()
// below (which falls back to second precision on WASI and to FILETIME on Win32).
#if !defined(__wasi__) && !defined(_WIN32)
#include <sys/time.h>
#endif

// __builtin_return_address is a no-op *error* on non-Emscripten wasm (LLVM:
// "Non-Emscripten WebAssembly hasn't implemented __builtin_return_address").
// Every use of it names a caller for the ASC_GC_STATS / ASC_GC_AUDIT_STRICT
// diagnostics, never program-visible behaviour, so WASI substitutes a null
// address -- gc_dbg_sym already renders that as "?" (and as a bare address
// where dladdr is unavailable).
#ifdef __wasi__
#define ASC_RETURN_ADDRESS(n) ((void*)0)
#else
#define ASC_RETURN_ADDRESS(n) __builtin_return_address(n)
#endif

// Wall-clock milliseconds since epoch. Native uses gettimeofday for real ms
// resolution; WASI lacks it, so Date resolution drops to seconds (documented
// subset — the compiler's core is portable C, Date is the one POSIX coupling).
static double as_now_ms(void) {
#ifdef __wasi__
    return (double)time(NULL) * 1000.0;
#elif defined(_WIN32)
    // FILETIME counts 100 ns ticks since 1601-01-01; drop the Unix epoch offset
    // and divide by 10 to land on milliseconds since 1970, the same wall-clock
    // scale the POSIX path reports. windows.h is already included for the
    // privateMemory branch above.
    FILETIME ft;
    ULARGE_INTEGER u;
    GetSystemTimeAsFileTime(&ft);
    u.LowPart = ft.dwLowDateTime;
    u.HighPart = ft.dwHighDateTime;
    return (double)((int64_t)(u.QuadPart - 116444736000000000ULL) / 10000);
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

// ---------- external URL launcher (flash.net.navigateToURL / sendToURL) ----------
// AIR hands the URL to the platform's default handler — the system browser for
// http/https, the mail client for mailto, the file manager for file. The URL is
// therefore never fetched by this process and no response can ever be reported,
// which is exactly the behaviour sendToURL documents as its only difference from
// navigateToURL. Returns 1 when the launcher was started, 0 when this target has
// none (the caller turns that into AIR's #2032 IOError rather than silence).
//
// fork+exec, not system(): the URL comes from application input, and going through
// a shell would turn navigateToURL(userInput) into a command-injection hole (a URL
// containing a semicolon and an rm -rf would run). One argv entry, no shell.
static int as_open_external(const char* url) {
    if (url == NULL || url[0] == '\\0') return 0;
#ifdef __EMSCRIPTEN__
    // Web: a real new tab/window. Being popup-blocked outside a user gesture is
    // the browser's documented behaviour, not something this layer can fix.
    EM_ASM({ window.open(UTF8ToString($0), '_blank'); }, url);
    return 1;
#elif defined(_WIN32)
    return (int)(ShellExecuteA(NULL, "open", url, NULL, NULL, SW_SHOWNORMAL) > (HINSTANCE)32);
#elif defined(__wasi__)
    return 0;  // WASI Preview 1 has no process to launch
#else
    static int as_child_reaping = 0;
    if (!as_child_reaping) {
        // The launcher exits immediately and this process never calls waitpid,
        // so SIG_IGN is what keeps it from lingering as a zombie.
        as_child_reaping = 1;
        signal(SIGCHLD, SIG_IGN);
    }
#ifdef __APPLE__
    const char* launcher = "open";
#else
    const char* launcher = "xdg-open";
#endif
    // Seam for headless verification and custom environments: point the launcher at
    // another program (the probe uses a recorder script so a test can assert the
    // URL was passed through verbatim without opening a real browser).
    const char* override = getenv("ASC_OPEN_LAUNCHER");
    if (override != NULL && override[0] != '\\0') launcher = override;
    pid_t pid = fork();
    if (pid < 0) return 0;
    if (pid == 0) {
        // The child must not inherit this process's descriptors: the launcher
        // can outlive the app from the shell's point of view, and holding the
        // app's stdout/stderr open that long is how a terminal hangs on exit.
        int devnull = open("/dev/null", O_RDWR);
        if (devnull >= 0) {
            dup2(devnull, 0); dup2(devnull, 1); dup2(devnull, 2);
            if (devnull > 2) close(devnull);
        }
        execlp(launcher, launcher, url, (char*)NULL);
        _exit(127);
    }
    return 1;
#endif
}

// Byte-buffer arena: bump-allocate raw byte storage (ByteArray.data, BitmapData
// pixels, zlib scratch) that is NOT a GC-managed AS3 String. AS3 strings now
// live on the GC heap (see as_str_alloc), so this arena no longer grows with
// string concatenation. Byte buffers grow by doubling and old buffers are not
// reclaimed (a documented subset limitation); they are not the animation leak
// source addressed in stage 57.
// Forward declaration: as_alloc's ASC_GC_STATS probe (below) uses this, and the
// definition sits with the GC probes (dladdr + return address -> symbol/offset).
static const char* gc_dbg_sym(const void* ra, unsigned long* off);
static size_t gc_heap_used_bytes(void);
static size_t gc_heap_total_bytes(void);
// ASC_GC_AUDIT corruption gate (defined with the rest of the audit code below):
// forward-declared because as_alloc/gc_alloc -- which run before it in the
// preamble -- call it to validate a bookkeeping word before trusting it.
static void gc_audit_gate(const char* what, const void* p);
// ASC_GC_AUDIT switch (defined with the audit code below): gc_heap_used_bytes()
// re-derives its O(1) mirror from the list when the audit is on.
static bool gc_audit_on(void);

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
    // ASC_GC_STATS probe: a megabyte-scale arena request is a big buffer (a
    // ByteArray / Vector payload). The arena never releases memory, so a
    // repeated growth here is permanent RSS; log the requesting caller (via
    // dladdr + atos) instead of guessing which helper asked for it.
    if (n >= (1u << 20) && getenv("ASC_GC_STATS") != NULL) {
        unsigned long as_dbg_off = 0;
        const char* as_dbg_sym = gc_dbg_sym(ASC_RETURN_ADDRESS(0), &as_dbg_off);
        fprintf(stderr, "as_big size=%.1fMB caller=%s+0x%lx\\n",
                (double)n / 1048576.0, as_dbg_sym, as_dbg_off);
        fflush(stderr);
    }
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
// gc_mark_user_roots), because the incremental collector runs at a frame-boundary
// safe point where all user frame callbacks have returned and there are no live
// stack temporaries to register. Objects reachable only from the display list /
// static fields / event registry / timer table stay alive; transient animation
// objects become unreachable and are swept.
//
// A collection can also be forced while AS3 frames ARE on the stack (System.gc()
// from user code, or Stage.dispatchFrame() called from AS3). Those cases add the
// live C stack conservatively to the root set — see gc_mark_stack.
typedef struct gc_header {
    struct gc_header* next;  // free-list (when idle) or all-objects list (when live)
    int type;                // GCT_* tag, drives mark traversal (0 = free block)
    int color;               // 0 white / 1 grey / 2 black (three-color, GC-4 ready)
    size_t size;             // object body bytes
} gc_header;

typedef struct gc_seg {
    struct gc_seg* next;
    char* base;
    size_t size;
    // Free bytes in this segment, counting each free *block's* header too:
    // free_bytes == size means every byte of the segment is on a free list, i.e.
    // the segment holds no live object (see gc_release_empty_segs). Maintained
    // incrementally by the allocator and the sweeper, so the check is exact
    // without walking anything.
    size_t free_bytes;
    int reap;      // scratch flag for the release pass (1 = wholly free)
    // Scrub fields for the ASC_GC_AUDIT cross-check below: recompute the live
    // footprint by walking gc_all and compare it against free_bytes. Written
    // only in audit mode. audit_ghost is the same sum over blocks whose type is
    // already 0 (freed but still linked), which the release decision must not
    // mistake for live data.
    size_t audit_live;
    size_t audit_ghost;
} gc_seg;

// GC object type tags. The values are deliberately offset by a magic constant:
// the conservative stack scan (gc_mark_stack) may be handed a word pointing into
// the middle of an object (e.g. a char* walking a string body), and reading a
// payload word as h->type then falls outside the GCT_* range, so a stray stack
// word can never be mistaken for a real object header. Free blocks carry 0.
#define GCT_TAG_BASE 0x47430000  // 'G','C' marker in the two high bytes
enum {
    GCT_STRING = GCT_TAG_BASE + 0,      // bare char*, a leaf
    GCT_ARRAY = GCT_TAG_BASE + 1,       // as_array
    GCT_OBJECT = GCT_TAG_BASE + 2,      // as_object (record literal)
    GCT_DICT = GCT_TAG_BASE + 3,        // as_dict (Dictionary)
    GCT_CLOSURE = GCT_TAG_BASE + 4,     // as_closure (function value)
    GCT_CLASS = GCT_TAG_BASE + 5,       // user/builtin class instance (vtable + as_prop)
    GCT_VALUE_ARRAY = GCT_TAG_BASE + 6, // as_value[] buffer (array.data / object.vals)
    GCT_PTR_ARRAY = GCT_TAG_BASE + 7,   // void*[] / char*[] buffer (object.keys)
    GCT_CUSTOM = GCT_TAG_BASE + 8,      // user-supplied mark callback in body word 0
    GCT_XML = GCT_TAG_BASE + 9,         // as_xml_node (E4X DOM element)
    GCT_XML_LIST = GCT_TAG_BASE + 10,   // as_xml_list (E4X node list)
    GCT_NUMBER = GCT_TAG_BASE + 11,     // as_number (boxed Number stored in an Object slot)
    GCT_STRING_OBJ = GCT_TAG_BASE + 12, // as_string (boxed String stored in an Object slot)
    GCT_FUNCTION_OBJ = GCT_TAG_BASE + 13, // as_function (boxed Function in an Object slot)
    GCT_BOOLEAN = GCT_TAG_BASE + 14,    // as_boolean (boxed Boolean stored in an Object slot)
    GCT_RAW = GCT_TAG_BASE + 15,        // raw payload buffer (monomorphized Vector.<T> element storage)
    GCT_BYTES = GCT_TAG_BASE + 16       // raw BYTE buffer held by a GC object (ByteArray.data / BitmapData.pixels)
};

#define GC_SEG_SIZE (1u << 20)          // 1 MiB per segment
#define GC_MIN_BLOCK (sizeof(gc_header) + 8)
#define GC_BIG_CLASS (256u << 10)       // size-class boundary: big payloads vs objects
// Segment size for carving blocks that serve *small* requests. A fresh segment
// becomes one free block (minus the request), so it must itself belong to the
// small class -- otherwise every small allocation would carve 1 MiB and leave
// the leftover unusable for the small list, i.e. one segment per allocation.
#define GC_SMALL_SEG_SIZE (64u << 10)

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
// Free blocks are graded by size, so a request never walks past blocks that could
// not serve it:
//   gc_free_small[i] -- blocks whose size is in [i*GC_SMALL_ALIGN, (i+1)*GC_SMALL_ALIGN);
//   gc_free_mid       -- the rest below GC_BIG_CLASS, first-fit with splitting;
//   gc_free_big       -- GC_BIG_CLASS and above, first-fit with splitting.
// Before the classes existed every block under GC_BIG_CLASS shared ONE list that
// allocation walked from the head testing 'h->size >= size'. Strings are the
// worst case for that: the runtime allocates millions of short strings, so the
// list filled with same-sized blocks while the walk still restarted at the head
// every time -- first-fit degrades to O(list length) per allocation. Measured at
// ~36% of the strings benchmark (temp/bench/invest: swapping as_str_alloc for an
// arena bump cut 248 ms -> 152 ms). With classes, a warm size class is an O(1)
// head pop, and the same block is then reused forever.
#define GC_SMALL_ALIGN 32u
#define GC_SMALL_CLASSES 16               // classes cover [0, 16*32) = [0, 512)
#define GC_SMALL_MAX (GC_SMALL_ALIGN * GC_SMALL_CLASSES)
static gc_header* gc_free_small[GC_SMALL_CLASSES];
static gc_header* gc_free_mid = NULL;
// Big blocks live on their own list. Keeping them out of the small-object walk
// costs nothing when looking for a big block (and vice versa), whereas one
// shared list would have to *skip* every block of the other class on every
// allocation. Without the split list, a freed multi-MB payload gets whittled
// down by the small allocations that follow it in sweep order: it stops being
// able to serve the next multi-MB request, which then carves a fresh segment
// even though megabytes sit unused in the free list. Starling re-uploads a
// multi-MB VertexBuffer3D every frame (Effect.uploadVertexData), so that
// whittling reserved ~1 GB of segments for a ~60 MB working set.
static gc_header* gc_free_big = NULL;

// Release grade of a block of this size: the class whose window contains it, or
// -1 when it is not a small block. Blocks are released under their TRUE size, so
// a class can hold a slightly-larger-than-nominal block; allocation therefore
// checks h->size >= size within the class it starts from (see gc_find_block).
static int gc_small_class(size_t size) {
    if (size >= GC_SMALL_MAX) return -1;
    return (int)(size / GC_SMALL_ALIGN);
}
static gc_header** gc_free_list_for(size_t size) {
    int i = gc_small_class(size);
    if (i >= 0) return &gc_free_small[i];
    return size >= GC_BIG_CLASS ? &gc_free_big : &gc_free_mid;
}
// Every free list by index, in search order: the size classes, then mid, then
// big. Used by the audit/diagnostics walks that used to iterate the two old
// lists by hand, and by gc_find_block.
static gc_header** gc_free_list_at(int i) {
    if (i < GC_SMALL_CLASSES) return &gc_free_small[i];
    if (i == GC_SMALL_CLASSES) return &gc_free_mid;
    return &gc_free_big;
}
// Find a free block able to serve 'size', searching the graded lists in order:
// a small request starts at its own size class and climbs (classes hold blocks
// within one GC_SMALL_ALIGN window, so the climb is bounded and a higher class
// always fits), then falls through to the mid list; a big request searches only
// the big list. Returns NULL when nothing fits, so the caller carves a segment.
static gc_header* gc_find_block(size_t size, gc_header*** out_head, gc_header** out_prev) {
    bool big = size >= GC_BIG_CLASS;
    int first = big ? GC_SMALL_CLASSES + 1 : gc_small_class(size);
    if (!big && first < 0) first = GC_SMALL_CLASSES;
    int last = big ? GC_SMALL_CLASSES + 1 : GC_SMALL_CLASSES;
    for (int li = first; li <= last; li++) {
        gc_header** list = gc_free_list_at(li);
        gc_header* prev = NULL;
        for (gc_header* h = *list; h != NULL; prev = h, h = h->next) {
            gc_audit_gate("free-list node", h);
            if (h->size >= size) { *out_head = list; *out_prev = prev; return h; }
        }
    }
    return NULL;
}
static gc_header* gc_all = NULL;        // live objects, sweep walks this
static size_t gc_bytes_allocated = 0;   // bytes since last collect (trigger)
// O(1) mirror of "header+payload bytes currently linked in gc_all" -- exactly the
// quantity the linear walk in gc_heap_used_bytes() used to sum. That walk is
// O(live objects), and System.totalMemory/freeMemory sum it: Starling's
// StatsDisplay polls totalMemory every 0.5 s, so with a few hundred thousand
// objects the HUD stalled the frame by milliseconds (measured on
// air-starling-demo: totalMemory+freeMemory+privateMemory = 8.4 ms p50, ~all of
// it these two walks). Objects born during a cycle wait on gc_new and are counted
// in gc_new_bytes until the splice at cycle end, so the mirror equals the walk at
// every instant, not merely between cycles.
static size_t gc_all_bytes = 0;         // header+payload bytes linked in gc_all
static size_t gc_new_bytes = 0;         // header+payload bytes waiting in gc_new
// Cached value of gc_trigger() for the offscreen (per-allocation) check. That
// check runs on every single allocation, and gc_trigger() sums 24 decay
// counters, so recomputing it there is pure overhead: measured on binarytrees,
// 98 ms when the floor is computed vs 87 ms when ASC_GC_THRESHOLD short-circuits
// the sum. The threshold only needs refreshing when the live set materially
// changes, which is at a collection -- gc_finish_cycle clears this to 0 to force
// a recompute (the floor is never 0, so 0 is a safe "stale" sentinel).
static size_t gc_trigger_next = 0;
static size_t gc_threshold = (1u << 20); // collect when allocated exceeds this
// Has a frame safe point ever run? gc_step() is only ever entered from the
// emitted Stage_dispatchFrame (one call per dispatched frame), so the first
// entry reports "this program is frame-driven" and gc_alloc then leaves
// collection to that sliced path. Until then -- a plain script, a server loop, a
// WASI run, anything without a display list -- nothing would ever advance the
// collector and the heap would grow with the program's allocation total, so
// gc_alloc itself fires a stop-the-world collection on the threshold (see the
// trigger in gc_alloc). Both properties are needed: without the flag a GUI build
// would lose GC-4's bounded per-frame pause, and without the gc_alloc trigger an
// offscreen build would never collect at all.
static bool gc_frame_driven = false;

// Probe helpers for the ASC_GC_STATS logging below: dladdr() turns a runtime
// return address into a symbol + offset, so the caller can be named with
// atos -o <binary> (0x100000000 + off) instead of guessed at.
//
// Dl_info/dladdr are POSIX-with-Apple-extension; wasi-libc declares dlfcn.h but
// has neither, and Windows has no dlfcn.h at all. The probe only feeds the
// ASC_GC_STATS diagnostics (not any program-visible behaviour), so both WASI
// and Win32 degrade to a bare address instead of failing to compile the whole
// preamble.
#if defined(__wasi__) || defined(_WIN32)
static const char* gc_dbg_sym(const void* ra, unsigned long* off) {
    if (off) *off = (unsigned long)(uintptr_t)ra;
    return "?";
}
#else
static const char* gc_dbg_sym(const void* ra, unsigned long* off) {
    Dl_info di;
    if (dladdr(ra, &di) != 0) {
        if (off) *off = (unsigned long)((const char*)ra - (const char*)di.dli_fbase);
        return di.dli_sname ? di.dli_sname : "?";
    }
    if (off) *off = 0;
    return "?";
}
#endif

// ASC_GC_STATS per-type heap accounting. gc_heap_used_bytes() sums every block
// still linked in gc_all, i.e. live objects *plus* garbage the sweeper has not
// reached yet -- so a multi-hundred-MB "heap" can mean either a big live set or
// a collector that cannot keep up with the allocation rate. Splitting the same
// total by GCT type (updated on allocation and on sweep-free) tells those two
// apart and names the type responsible, which is what drives the fix.
static double gc_dbg_type_bytes[24];
static long gc_dbg_type_count[24];
// O(1) totals of the counters above: bytes/objects currently linked in gc_all
// (live plus not-yet-swept garbage). gc_heap_used_bytes() reports that same total
// from an O(1) mirror -- walking the whole list is far too expensive to do per
// frame -- and these two numbers are exactly
// what the adaptive budget/threshold below need.
static size_t gc_dbg_inuse_bytes(void) {
    double t = 0;
    for (int i = 0; i < 24; i++) t += gc_dbg_type_bytes[i];
    return (size_t)(t < 0 ? 0 : t);
}
static size_t gc_dbg_inuse_count(void) {
    long t = 0;
    for (int i = 0; i < 24; i++) t += gc_dbg_type_count[i];
    return (size_t)(t < 0 ? 0 : t);
}
static const char* gc_type_name(int type) {
    switch (type) {
        case GCT_STRING: return "string";
        case GCT_ARRAY: return "array";
        case GCT_OBJECT: return "object";
        case GCT_DICT: return "dict";
        case GCT_CLOSURE: return "closure";
        case GCT_CLASS: return "instance";
        case GCT_VALUE_ARRAY: return "value_array";
        case GCT_PTR_ARRAY: return "ptr_array";
        case GCT_CUSTOM: return "custom";
        case GCT_XML: return "xml";
        case GCT_XML_LIST: return "xml_list";
        case GCT_NUMBER: return "boxed_num";
        case GCT_STRING_OBJ: return "boxed_str";
        case GCT_FUNCTION_OBJ: return "boxed_fn";
        case GCT_BOOLEAN: return "boxed_bool";
        case GCT_RAW: return "raw";
        case GCT_BYTES: return "bytes";
        default: return "?";
    }
}
static void gc_dbg_dump(const char* tag) {
    if (getenv("ASC_GC_STATS") == NULL) return;
    static double last = 0.0;
    const double now = as_now_ms();
    if (now - last < 500.0) return;
    last = now;
    double total = 0;
    char line[512];
    size_t segs = 0, freeblocks = 0, freebytes = 0;
    for (gc_seg* s = gc_segs; s != NULL; s = s->next) segs++;
    for (int li = 0; li < GC_SMALL_CLASSES + 2; li++) {
        for (gc_header* h = *gc_free_list_at(li); h != NULL; h = h->next) { freeblocks++; freebytes += h->size; }
    }
    int n = snprintf(line, sizeof(line),
                     "gc_heap t=%.1fs %s total=%.0fMB resv=%.0fMB segs=%zu freeblk=%zu freeb=%.0fMB | ",
                     now / 1000.0, tag, gc_heap_used_bytes() / 1048576.0,
                     gc_heap_total_bytes() / 1048576.0, segs, freeblocks, freebytes / 1048576.0);
    for (int i = 0; i < 24; i++) {
        if (gc_dbg_type_bytes[i] <= 0) continue;
        total += gc_dbg_type_bytes[i];
        n += snprintf(line + n, sizeof(line) - (size_t)n, "%s=%.1fMB/%ld ",
                      gc_type_name(GCT_TAG_BASE + i), gc_dbg_type_bytes[i] / 1048576.0,
                      gc_dbg_type_count[i]);
        if (n > (int)sizeof(line) - 64) break;
    }
    fprintf(stderr, "%s\\n", line);
    fflush(stderr);
}

static gc_header* gc_hdr(void* p) {
    return (gc_header*)((char*)p - sizeof(gc_header));
}

// Segment lookup table. gc_segs is the creation-ordered linked list (used to
// iterate/dump/release segments), but answering "is this word inside the GC
// heap?" by walking it is O(#segments): the benchmark holds ~1100 segments, and
// gc_in_heap runs for *every* child pointer the marker follows, every word of
// the conservative stack scan and every write-barrier store. Inlined into
// gc_scan it was measured at 33% of the whole main-thread frame budget (the
// mark of the 30k-object display list alone is millions of lookups). So keep a
// second, base-sorted view of the same segments and answer in O(log n) -- with a
// one-entry cache in front, which makes the common case (many pointers into one
// recently touched segment) a couple of compares. 1 MiB segments are few enough
// that the sorted base array stays cache-resident.
typedef struct { char* base; size_t size; gc_seg* seg; } gc_seg_range;
static gc_seg_range* gc_seg_ranges = NULL;
static size_t gc_seg_range_n = 0, gc_seg_range_cap = 0;
static gc_seg_range* gc_seg_cache = NULL;   // last successful lookup

// Register a freshly carved segment (kept sorted by address, insertion sort:
// segments are created rarely compared to the lookups above).
static void gc_seg_range_add(gc_seg* seg) {
    char* base = seg->base;
    // Any insert invalidates the lookup cache: realloc may move the array, and
    // the shift below renumbers entries (the cache is a pointer into it).
    gc_seg_cache = NULL;
    if (gc_seg_range_n == gc_seg_range_cap) {
        gc_seg_range_cap = gc_seg_range_cap == 0 ? 64 : gc_seg_range_cap * 2;
        gc_seg_ranges = (gc_seg_range*)realloc(gc_seg_ranges, gc_seg_range_cap * sizeof(gc_seg_range));
    }
    size_t i = gc_seg_range_n++;
    while (i > 0 && gc_seg_ranges[i - 1].base > base) {
        gc_seg_ranges[i] = gc_seg_ranges[i - 1];
        i--;
    }
    gc_seg_ranges[i].base = base;
    gc_seg_ranges[i].size = seg->size;
    gc_seg_ranges[i].seg = seg;
}

// Drop a segment that is about to be returned to the OS.
static void gc_seg_range_del(char* base) {
    for (size_t i = 0; i < gc_seg_range_n; i++) {
        if (gc_seg_ranges[i].base == base) {
            // Clear the cache unconditionally, not just when it points at the
            // entry being removed: the memmove below shifts every later entry
            // down one slot, so a cached pointer at index j > i now describes
            // what used to be entry j+1 (and, once j is the last slot, holds a
            // duplicate of a *released* segment whose gc_seg is freed). The
            // lookup would then either credit free_bytes to a freed segment
            // struct or answer gc_in_heap for an address the heap no longer
            // owns -- both silent corruption.
            gc_seg_cache = NULL;
            memmove(&gc_seg_ranges[i], &gc_seg_ranges[i + 1],
                    (gc_seg_range_n - i - 1) * sizeof(gc_seg_range));
            gc_seg_range_n--;
            return;
        }
    }
}

// The segment containing p, or NULL. Addresses between segments are gaps (each
// segment is its own malloc chunk), so a binary search on the base is exact.
static gc_seg_range* gc_seg_find(const void* p) {
    if (gc_seg_cache != NULL && (const char*)p >= gc_seg_cache->base
        && (const char*)p < gc_seg_cache->base + gc_seg_cache->size) return gc_seg_cache;
    size_t lo = 0, hi = gc_seg_range_n;
    while (lo < hi) {
        size_t mid = (lo + hi) / 2;
        if (gc_seg_ranges[mid].base <= (const char*)p) lo = mid + 1; else hi = mid;
    }
    if (lo == 0) return NULL;
    gc_seg_range* r = &gc_seg_ranges[lo - 1];
    if ((const char*)p >= r->base + r->size) return NULL;
    gc_seg_cache = r;
    return r;
}

static bool gc_in_heap(void* p) {
    if (p == NULL) return false;
    // The body of an object always sits sizeof(gc_header) past its block start,
    // and every caller reads the header at p - sizeof(gc_header). A word landing
    // on (or just past) a segment base -- which the conservative stack scan can
    // hand us, since segment bases get spilled to the stack -- would make that
    // read fall into the unmapped gap *before* the segment and fault (SIGBUS).
    // Requiring the header itself to be inside the segment keeps the gate safe:
    // the first object body is at base + sizeof(gc_header), so nothing valid is
    // rejected.
    gc_seg_range* r = gc_seg_find(p);
    return r != NULL && (char*)p >= r->base + sizeof(gc_header);
}

// Push a grey object onto the incremental mark work stack (defined later, near
// the mark phase; forward-declared so gc_alloc's allocation barrier can use it).
static void gc_grey_push(gc_header* h);
// Collection entry points used by gc_alloc's non-GUI trigger below. Both live
// after the mark/sweep code as well, so they need the same treatment.
static size_t gc_trigger(void);
static void gc_collect(void);

// Allocate a GC object of the given type. Returns the object body (header hidden
// before it). The body is zeroed so uninitialized array slots read as tag 0
// (null) during mark, never a stale pointer.
static void* gc_alloc(int type, size_t size) {
    // ASC_GC_AUDIT: gc_all is written only by this function and by the sweeper,
    // so a non-heap value here was stored by unrelated code (a wild store). The
    // report's call chain is the statement that ran right after that store.
    gc_audit_gate("gc_all", gc_all);
    // Non-GUI trigger: no frame has ever been dispatched, so nothing else will
    // ever call gc_step() -- collect here, once the allocation total crosses the
    // (adaptive) threshold. This runs *before* the new object exists, so the
    // sweep can never see it as unreachable garbage.
    //
    // Stop-the-world rather than a sliced cycle is deliberate: there is no frame
    // deadline to protect, and the total work is the same, so slicing would only
    // add state to a path that must be correct from an arbitrary call site. A
    // collection from here is the same kind of operation as the already-supported
    // System.gc() (which can fire while AS3 frames are live): gc_mark_roots runs
    // the conservative C-stack scan, which mirrors the callee-saved registers via
    // setjmp, so live locals of every caller frame stay roots (see gc_midframe.as).
    // The scan needs a stack base, and main records one (GC_NOTE_STACK_BASE) as its
    // first statement -- before any AS3 statement can allocate.
    if (!gc_frame_driven && gc_inc.state == GC_IDLE) {
        if (gc_trigger_next == 0) gc_trigger_next = gc_trigger();
        if (gc_bytes_allocated >= gc_trigger_next) gc_collect();
    }
    if (size == 0) size = 1;
    size = (size + 7) & ~(size_t)7;
    // ASC_GC_STATS probe: a multi-megabyte request is either a legitimate large
    // payload (a big ByteArray/Vector) or a capacity computation gone wrong. Log
    // every one of them with the return address of the caller, so "atos -o
    // <binary> -l <load addr> <ra>" names the responsible helper instead of
    // guessing. Kept behind the env var: it also pins the request address so the
    // log shows whether sizes double (pathological growth) or are one-shot.
    static long gc_dbg_n = 0;
    if (type == GCT_RAW && size >= (64u << 10) && getenv("ASC_GC_STATS") != NULL && (gc_dbg_n++ % 50) == 0) {
        size_t segs = 0;
        unsigned long gc_dbg_off = 0;
        for (gc_seg* s = gc_segs; s != NULL; s = s->next) segs++;
        unsigned long gc_dbg_off2 = 0;
        const char* gc_dbg_up = gc_dbg_sym(ASC_RETURN_ADDRESS(1), &gc_dbg_off2);
        fprintf(stderr, "gc_big type=%d size=%.1fMB segs=%zu since_collect=%.1fMB caller=%s+0x%lx up=%s+0x%lx\\n",
                type, (double)size / 1048576.0, segs,
                (double)gc_bytes_allocated / 1048576.0,
                gc_dbg_sym(ASC_RETURN_ADDRESS(0), &gc_dbg_off), gc_dbg_off,
                gc_dbg_up, gc_dbg_off2);
        fflush(stderr);
    }
    // Big blocks (>= GC_BIG_CLASS) are kept away from small requests and vice
    // versa. Without this, a freed multi-MB payload is whittled down by the
    // small allocations that follow it in sweep order: it stops being able to
    // serve the next multi-MB request, which then carves a fresh segment even
    // though megabytes sit unused in the free list. Starling re-uploads a
    // multi-MB VertexBuffer3D every frame (Effect.uploadVertexData), so that
    // whittling reserved ~1 GB of segments for a ~60 MB working set.
    // Search the graded free lists (see the class comment at gc_free_small):
    // for a small request, its own size class upward -- the head of a warm class
    // is an O(1) hit -- then the mid list; a big request searches the big list.
    // gc_find_block returns the first block that fits along with its list and
    // predecessor, so it can be unlinked below.
    gc_header** head = NULL;
    gc_header* prev = NULL;
    gc_header* h = gc_find_block(size, &head, &prev);
    if (h != NULL) {
        if (prev) prev->next = h->next; else *head = h->next;
        size_t remain = h->size - size;
        if (remain >= GC_MIN_BLOCK) {
            gc_header* rest = (gc_header*)((char*)h + sizeof(gc_header) + size);
            rest->size = remain - sizeof(gc_header);
            gc_header** rl = gc_free_list_for(rest->size);
            rest->next = *rl;
            rest->type = 0;   // fresh free block: not an object header
            *rl = rest;
            h->size = size;
        }
        // Charge the segment that owns this block: the block's footprint
        // (header + payload) leaves the free pool, and the split-off
        // remainder is still free, so the net change is exactly this block.
        // The charge must use the block's *actual* size and therefore comes
        // after the split above: whenever the remainder is smaller than
        // GC_MIN_BLOCK it is not split off and stays part of this block, and
        // charging the requested size instead would leave that difference in
        // free_bytes forever. free_bytes can then climb above the segment's
        // true free space, and the release pass's "this segment holds
        // nothing" test (free_bytes == size) becomes true while live
        // objects are still in it. The segment is then handed back to the OS
        // (malloc reuse overwrites the live objects; gc_all itself was later
        // seen holding a plain double), which is the "second benchmark run"
        // SIGSEGV.
        gc_seg_range* _sr = gc_seg_find(h);
        if (_sr != NULL) _sr->seg->free_bytes -= sizeof(gc_header) + h->size;
        h->type = type;
        {
            int _k = type - GCT_TAG_BASE;
            if (_k >= 0 && _k < 24) { gc_dbg_type_bytes[_k] += (double)h->size; gc_dbg_type_count[_k]++; }
        }
        // Allocation barrier: while a cycle is in progress, new objects are
        // born BLACK on a side list (gc_new) so they survive this cycle and
        // never disturb the sweep walk. Writes into these new objects must
        // go through the write barrier (gc_write_barrier) to grey any WHITE
        // reference, so the mark does not miss it.
        if (gc_inc.state == GC_IDLE) {
            h->next = gc_all;
            gc_all = h;
            gc_all_bytes += sizeof(gc_header) + h->size;
            h->color = GC_WHITE;
        } else {
            h->next = gc_new;
            gc_new = h;
            gc_new_bytes += sizeof(gc_header) + h->size;
            h->color = GC_BLACK;
        }
        gc_bytes_allocated += sizeof(gc_header) + h->size;
        void* body = (void*)((char*)h + sizeof(gc_header));
        memset(body, 0, h->size);
        return body;
    }
    // Out of free blocks: carve a fresh segment. A fixed 1 MiB segment only
    // yields blocks up to GC_SEG_SIZE - sizeof(gc_header); a larger request can
    // never be satisfied by it, so recursing below would loop forever, malloc'ing
    // 1 MiB segments until virtual address space is exhausted (array's 1.5 MiB
    // value-array growth hit exactly this). Mirror as_alloc's oversized branch:
    // allocate a dedicated segment sized to the request so the recursive retry
    // finds a free block of sufficient size on the next pass.
    size_t seg_size = size >= GC_BIG_CLASS ? GC_SEG_SIZE : GC_SMALL_SEG_SIZE;
    if (size > seg_size - sizeof(gc_header)) {
        seg_size = sizeof(gc_header) + size;
    }
    gc_seg* s = (gc_seg*)malloc(sizeof(gc_seg));
    s->base = (char*)malloc(seg_size);
    s->size = seg_size;
    s->free_bytes = seg_size;   // one free block covering the whole segment
    s->reap = 0;
    s->next = gc_segs;
    gc_segs = s;
    gc_seg_range_add(s);
    // 'fresh' rather than 'h': the search above keeps its block pointer in 'h'
    // across the carve, so the two must not share a name.
    gc_header* fresh = (gc_header*)s->base;
    fresh->size = seg_size - sizeof(gc_header);
    // Split the fresh block down to the requested size before retrying. The
    // retry walks the free list, and a brand new 1 MiB segment is a *big* block
    // -- a small request would skip it (see the size-class check above) and
    // recurse until the address space is gone. Splitting serves this request in
    // one allocation and leaves any leftover in the free list as a big block for
    // the next big request.
    if (fresh->size > size && fresh->size - size >= GC_MIN_BLOCK) {
        gc_header* rest = (gc_header*)((char*)fresh + sizeof(gc_header) + size);
        rest->size = fresh->size - size - sizeof(gc_header);
        gc_header** rl = gc_free_list_for(rest->size);
        rest->next = *rl;
        rest->type = 0;   // fresh free block: not an object header
        *rl = rest;
        fresh->size = size;
    }
    gc_header** hl = gc_free_list_for(fresh->size);
    fresh->next = *hl;
    fresh->type = 0;   // fresh free block: not an object header
    *hl = fresh;
    return gc_alloc(type, size);
}

// Live bytes across all GC objects (totalMemory contribution). O(1): the mirror
// updated at the four places that change the lists (gc_alloc's two link sites, the
// two gc_new splices, the sweep unlink). With ASC_GC_AUDIT=1 the original walk is
// re-done and compared here, so the mirror cannot drift unnoticed.
static size_t gc_heap_used_bytes(void) {
    if (gc_audit_on()) {
        size_t walk = 0;
        for (gc_header* h = gc_all; h != NULL; h = h->next) walk += sizeof(gc_header) + h->size;
        if (walk != gc_all_bytes)
            fprintf(stderr, "[gc-audit] gc_all bytes: mirror=%zu walk=%zu\\n", gc_all_bytes, walk);
    }
    return gc_all_bytes;
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

// AS3 string concatenation. A String-typed slot may hold NULL (the AS3 default for
// an unset String field, and null itself), and ES3's ToString(null) is the four
// characters "null" — which is exactly what the reference implementation prints
// when an HTTPStatusEvent.responseURL is null: it shows up as url=null
// (air-probe #8). Reading NULL straight into strlen() crashed instead, so
// substitute there.
static char* as_str_concat(const char* a, const char* b) {
    if (a == NULL) a = "null";
    if (b == NULL) b = "null";
    size_t la = strlen(a), lb = strlen(b);
    char* r = as_str_alloc(la + lb + 1);
    memcpy(r, a, la);
    memcpy(r + la, b, lb);
    r[la + lb] = 0;
    return r;
}

// Null-safe String equality (AS3 ==/!= on String). A String-typed slot may
// hold NULL (the AS3 default for an unset String field), and strcmp(NULL, ...)
// would crash; two NULLs compare equal, a NULL never equals a non-NULL string.
static bool as_str_eq(const char* a, const char* b) {
    if (a == b) return true;
    if (a == NULL || b == NULL) return false;
    return strcmp(a, b) == 0;
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
// The last two slots mirror as_object_vtable's tail: every generated class
// vtable (and every pre-baked box vtable) appends Object's own method slots --
// the effective toString and hasOwnProperty -- directly after the common header,
// so a vtable pointer can be read generically through this struct. as_obj_to_str
// relies on the toString slot to honor a class's override (AIR calls the virtual
// toString for String(x) / "" + x; a ShaderRegisterElement must render as 'vt0',
// not as its C class name -- measured on adl 51.4.1).
typedef struct { const char* name; void* super; void** ifaces; void* props; void* methods; void* getters; void* setters; int dyn_offset; const char* fqn; int is_proxy; char* (*toString)(void*); bool (*hasOwnProperty)(void*, char*); } as_vtable_header;

// Reflection table entry: one reflectable field of a class. 'type' encodes the
// boxed storage kind (1 number, 2 bool, 3 string, 4 int, 5 uint, 6 ref, 7 any;
// 8/9 are our 64-bit enhancement tags). 10/11/12 are REFERENCE kinds whose static
// type IS known, so a dynamic write can be type-checked the way AIR does it
// (measured on adl 51.4.1, temp/pkgA/dyn.body.as: 'var d:Object = sprite;
// d.filters = 5' -> #1034 "cannot convert 5 to Array.", 'd.transform = 5' ->
// #1034 "... to flash.geom.Transform."): 10 = Array, 11 = class instance (needs
// 'vt'/'fqn' for as_v_req_inst), 12 = Object (autoboxes like AIR's Object slot).
// 'offset' is the byte offset of the field within the (flattened) class struct.
typedef struct { const char* name; int type; size_t offset; void* vt; const char* fqn; } as_prop;

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
// Proxy stringification helper: a Proxy receiver is turned into a String by its
// callProperty("toString") override rather than the class name. Declared here
// (its signature uses no as_value, which is not defined yet) and defined with the
// other interceptor helpers below; used by as_obj_to_str and as_v_str_val.
static char* as_proxy_to_str(void* obj);
// Default (Object-level) stringification: AIR renders '[object <local class
// name>]' -- '[object Object]' for a plain object, '[object F]' for a top-level
// class F, '[object Sprite]' for flash.display.Sprite (measured on adl 51.4.1).
// The local name is the tail of the fully-qualified name the vtable carries
// ('pkg::Cls' -> 'Cls'); the C identifier in the name slot is never user-visible.
static char* as_obj_default_str(void* obj) {
    void* vt = obj != NULL ? ((as_object_header*)obj)->vtable : NULL;
    const char* fqn = vt != NULL ? ((as_vtable_header*)vt)->fqn : NULL;
    if (fqn == NULL || fqn[0] == 0) fqn = vt != NULL ? ((as_vtable_header*)vt)->name : "Object";
    const char* local = fqn;
    for (const char* p = fqn; p[0] != 0; p++) if (p[0] == ':' && p[1] == ':') local = p + 2;
    size_t n = strlen(local);
    char* out = as_str_alloc(n + 10);
    if (out == NULL) return (char*)local;
    snprintf(out, n + 10, "[object %s]", local);
    return out;
}
static char* as_obj_to_str(void* obj) {
    if (obj == NULL) return "null";
    void* vt = ((as_object_header*)obj)->vtable;
    if (vt == NULL) return "Object";
    // A Proxy receiver is stringified through its callProperty("toString")
    // override, not the class name (measured on adl 51.4.1: 'String(p)' calls
    // callProperty with "toString"; a proxy without it throws #2090).
    if (((as_vtable_header*)vt)->is_proxy) return as_proxy_to_str(obj);
    // AS3's implicit string conversion calls the virtual toString(): a class
    // override wins, and the no-override slot is Object's default, which renders
    // the AIR '[object X]' text (see as_obj_default_str). Without this, away3d's
    // ShaderRegisterElement -- whose toString() returns the register name --
    // stringified as its C class name and the generated AGAL failed to assemble.
    char* (*toStr)(void*) = ((as_vtable_header*)vt)->toString;
    if (toStr != NULL) return toStr(obj);
    return as_obj_default_str(obj);
}

// ---------- dynamic value (box) ----------
// AS3 Array elements (and other dynamically-typed values) are boxed. Scalars
// live in num, strings/objects/arrays in ptr; tag distinguishes the kind.
typedef struct {
    int tag;      // 0 null, 1 number, 2 bool, 3 string, 4 object, 5 undefined, 6 array,
                  // 7 function, 8 int64, 9 uint64 (8/9 are the opt-in 64-bit enhancement)
    double num;
    // The 64-bit integer payload rides in the pointer slot (anonymous union), so a
    // boxed int64 costs no extra memory and no existing initializer changes. Do NOT
    // read ptr on tag 8/9: those are raw integer bits, never a GC pointer.
    union { void* ptr; int64_t i64; uint64_t u64; };
} as_value;

static as_value as_v_null(void)     { as_value v = {0, 0.0, NULL}; return v; }
static as_value as_v_num(double d)  { as_value v = {1, d, NULL}; return v; }
static as_value as_v_bool(bool b)   { as_value v = {2, b ? 1.0 : 0.0, NULL}; return v; }
// A NULL char* is AS3's null, NOT a String holding a NULL pointer. A tag-3 box
// with a NULL ptr breaks field == null (false in AIR: new TextField().restrict
// == null is true, measured with adl 51.4.1) and makes field == ""/.length
// dereference NULL. This mirrors as_v_obj/as_v_arr/as_v_fn below, which already
// normalize NULL for exactly the same reason (AS3 has one null).
static as_value as_v_str(char* s)   { if (s == NULL) return as_v_null(); as_value v = {3, 0.0, (void*)s}; return v; }
// Pointer kinds normalize a NULL pointer to the null literal (tag 0). AS3 has
// exactly one null, so any *-typed expression that evaluates to null must box
// as tag 0, otherwise x == null is false. A ternary joining an object branch
// with null (e.g.  n <= 3 ? new Probe(n) : null  ) boxes the join as
// as_v_obj(NULL); without normalization the classic idiom
// while ((v = src.next()) != null) would never terminate, because tag 4 with a
// NULL ptr is not equal to tag 0 with a NULL ptr under as_v_eq.
static as_value as_v_obj(void* o)   { if (o == NULL) return as_v_null(); as_value v = {4, 0.0, o}; return v; }
static as_value as_v_arr(void* a)   { if (a == NULL) return as_v_null(); as_value v = {6, 0.0, a}; return v; }
// Function values need their own tag so typeof can distinguish them from plain
// objects (AS3: typeof function == "function"). The ptr is the as_fn closure.
static as_value as_v_fn(void* f)    { if (f == NULL) return as_v_null(); as_value v = {7, 0.0, f}; return v; }
// 64-bit integers (opt-in enhancement; AIR has no such type). Two tags so typeof
// and a dynamic is-check can tell them apart, and so a boxed value round-trips exactly: the raw
// bits live in the union, never as a double (a double would silently round past
// 2^53, which is the whole reason these types exist).
static as_value as_v_i64(int64_t x) { as_value v; v.tag = 8; v.num = 0.0; v.i64 = x; return v; }
static as_value as_v_u64(uint64_t x) { as_value v; v.tag = 9; v.num = 0.0; v.u64 = x; return v; }
static int64_t  as_i64_val(as_value v) { return v.i64; }
static uint64_t as_u64_val(as_value v) { return v.u64; }

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

// AS3 ToInt32 / ToUint32 (ECMA-262 §9.5, the source of int(x) / implicit
// Number→int coercion). NaN and ±Infinity map to 0; finite values truncate
// toward zero and wrap into the 32-bit signed/unsigned range. C's (int) cast
// is undefined behaviour for NaN/Infinity (wasm traps, x86 yields garbage), so
// the AS3 number→int coercion must route through these helpers to stay
// deterministic across the native/wasm/web backends.
static int as_to_int32(double v) {
    if (isnan(v) || isinf(v)) return 0;
    // Fast path: values already inside the int32 range are well-defined under
    // C's (int) cast (it truncates toward zero, exactly AS3's ToInt32 for
    // in-range values) and lower to a single cvttsd2si. Only out-of-range
    // values need the truncate-then-wrap slow path.
    if (v >= -2147483648.0 && v <= 2147483647.0) return (int)v;
    double t = v < 0.0 ? ceil(v) : floor(v);   // truncate toward zero
    double m = fmod(t, 4294967296.0);          // wrap into [0, 2^32)
    if (m < 0.0) m += 4294967296.0;
    return (m >= 2147483648.0) ? (int)(m - 4294967296.0) : (int)m;
}
static unsigned as_to_uint32(double v) {
    if (isnan(v) || isinf(v)) return 0;
    // Same fast path for the unsigned range.
    if (v >= 0.0 && v <= 4294967295.0) return (unsigned)v;
    double t = v < 0.0 ? ceil(v) : floor(v);
    double m = fmod(t, 4294967296.0);
    if (m < 0.0) m += 4294967296.0;
    return (unsigned)m;
}

// AS3 '%' (AVM2's OP_remainder) on two ints/uints is total — defined for every
// divisor — while C's '%' is undefined behaviour in two cases:
//   1. divisor 0      (wasm srem/urem trap by spec; native raises SIGFPE;
//                      -O2 may instead fold the expression to an arbitrary value)
//   2. INT_MIN % -1   (the quotient overflows: signed overflow is UB in C)
// The adl (AIR 51) reference values, probed with mxmlc+adl on an opaque zero:
//   int  '5 % 0'  -> NaN   (a *Number*: AVM2's remainder widens on a zero divisor)
//   uint '5 % 0'  -> NaN
//   int  'INT_MIN % -1' -> 0
//   'var r:int = 5 % 0' -> 0   (an int-typed use coerces NaN to 0)
// ASC types 'int % int' as int (adl reports '(7 % 3) is int' == true), so the
// guarded int/uint result below is exactly AS3's in every context where the
// value is consumed as the int/uint the compiler assigned the expression to —
// including the zero-divisor case, where AS3 itself coerces NaN to 0. The one
// unavoidable divergence is a *dynamically* typed use of a zero-divisor result
// ('var x:* = a % 0'): AIR yields NaN there, we yield the int 0, because the
// NaN case cannot be represented in the expression's static C type without
// turning every 'i % n' into a double. See docs/zh-cn/as3-semantics.md.
static int as_int_rem(int a, int b) {
    return (b == 0 || (a == (-2147483647 - 1) && b == -1)) ? 0 : a % b;
}
static unsigned as_uint_rem(unsigned a, unsigned b) {
    return b == 0 ? 0u : a % b;
}

// Forward declarations: the 64-bit branches below delegate to the coercing
// helpers defined a few lines further down.
static int as_v_to_int(as_value v);
static unsigned as_v_to_uint(as_value v);
// Fast raw accessors for as_value slots whose static type is Number/int/uint/bool.
// The 64-bit tags alias the ptr slot, so each one must consult the tag before
// reading num (which is 0.0 for them) -- otherwise unboxing a dynamic value holding an int64
// silently yields 0. The 64->32-bit narrowings are ToInt32/ToUint32 (low 32 bits);
// 64->Number goes through double and therefore rounds past 2^53, as documented.
static double as_v_num_val(as_value v)  { return (v.tag == 8) ? (double)v.i64 : (v.tag == 9) ? (double)v.u64 : v.num; }
static int as_v_int_val(as_value v)     { return (v.tag == 8 || v.tag == 9) ? as_v_to_int(v) : as_to_int32(v.num); }
static unsigned as_v_uint_val(as_value v) { return (v.tag == 8 || v.tag == 9) ? as_v_to_uint(v) : as_to_uint32(v.num); }
static bool as_v_bool_val(as_value v)   { return (v.tag == 8) ? (v.i64 != 0) : (v.tag == 9) ? (v.u64 != 0u) : (v.num != 0.0); }
// Coercing spellings for the typed-slot casts the EMITTER generates from a '*'
// source (var i:int = a[j], a dynamic thunk's int parameter, i = v["x"], a
// bitwise op on a boxed value). Semantically identical to as_v_to_int /
// as_v_to_uint -- every non-numeric tag is handed to them, so the coercion rules
// exist exactly once -- but shaped so clang inlines the numeric case. The general
// helpers call the ES3 ToNumber parser and are over the inline threshold as a
// result (cost 595 > 325, clang -Rpass-missed=inline), so a hot loop used to pay
// an out-of-line call per iteration: benchmarks/array's 20M-iteration 'sum +=
// a[j]' is 116 ms inlined vs 169 ms as a call (measured on this host, 2025-10).
// tags 1/2 (Number/Boolean) carry their value in num and are the entire hot path;
// tag 2 is only ever built by as_v_bool, which normalizes to 1.0/0.0, so
// as_to_int32(v.num) is exactly as_v_to_int's 'v.num != 0.0 ? 1 : 0'.
static int as_v_int_cast(as_value v) {
    if (v.tag == 1 || v.tag == 2) return as_to_int32(v.num);
    return as_v_to_int(v);
}
static unsigned as_v_uint_cast(as_value v) {
    if (v.tag == 1 || v.tag == 2) return as_to_uint32(v.num);
    return as_v_to_uint(v);
}
// ES3 ToNumber(String) (ECMA-262 3rd ed. §9.3.1), calibrated against adl 51.4.1
// (temp/pkgA/tonum*.body.as): leading/trailing ASCII whitespace is skipped, an
// empty or all-whitespace string is 0, an optional sign followed by "0x"/"0X" is
// a HEX integer, +/-Infinity are the infinities, and EVERYTHING ELSE is NaN --
// notably a string with trailing junk ("12abc", "1 2", "1,000") is NaN, where
// the previous atof() path returned the parsed prefix (12) instead.
// Two deviations from the strict grammar are deliberate, because adl itself is
// lenient there (measured): a trailing exponent marker with no digits still
// yields the mantissa ("1e" and "1e+" -> 1) while "1e-" is NaN; and NBSP
// (U+00A0) is NOT whitespace (adl: Number("\u00a07") is NaN).
static double as_str_to_number(const char* s) {
    if (s == NULL) return 0.0;
    const char* p = s;
    while (*p == ' ' || *p == '\\t' || *p == '\\n' || *p == '\\v' || *p == '\\f' || *p == '\\r') p++;
    // An empty or all-whitespace string is 0, not NaN (adl 51.4.1: Number("") ==
    // 0 and Number("   ") == 0; temp/pkgA/tonum.body.as N[0]/N[4]/N[23]).
    if (*p == '\\0') return 0.0;
    int neg = 0;
    if (*p == '+' || *p == '-') { neg = (*p == '-'); p++; }
    if (p[0] == 'I' && p[1] == 'n' && p[2] == 'f' && p[3] == 'i' && p[4] == 'n' &&
        p[5] == 'i' && p[6] == 't' && p[7] == 'y') {
        const char* q = p + 8;
        while (*q == ' ' || *q == '\\t' || *q == '\\n' || *q == '\\v' || *q == '\\f' || *q == '\\r') q++;
        if (*q != '\\0') return NAN;
        return neg ? -INFINITY : INFINITY;
    }
    if (p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) {
        if (!isxdigit((unsigned char)p[2])) return NAN;
        char* h = NULL;
        errno = 0;
        unsigned long long hv = strtoull(p + 2, &h, 16);
        while (*h == ' ' || *h == '\\t' || *h == '\\n' || *h == '\\v' || *h == '\\f' || *h == '\\r') h++;
        if (*h != '\\0') return NAN;
        double d = (double)hv;
        return neg ? -d : d;
    }
    if (!isdigit((unsigned char)*p) && *p != '.') return NAN;
    char* e = NULL;
    errno = 0;
    double d = strtod(p, &e);
    if (e == p) return NAN;
    if (*e == 'e' || *e == 'E') {
        const char* r = e + 1;
        if (*r == '+') r++;
        if (*r == '-') return NAN;
        while (*r == ' ' || *r == '\\t' || *r == '\\n' || *r == '\\v' || *r == '\\f' || *r == '\\r') r++;
        if (*r != '\\0') return NAN;
        return neg ? -d : d;
    }
    while (*e == ' ' || *e == '\\t' || *e == '\\n' || *e == '\\v' || *e == '\\f' || *e == '\\r') e++;
    if (*e != '\\0') return NAN;
    return neg ? -d : d;
}
// AS3 global conversion functions int(x)/uint(x)/Number(x) applied to a dynamic
// 'any' value. Unlike the 'as' type-checked casts (as_v_cast_*), these COERCE: a
// String operand parses its numeric text, a Boolean maps to 1/0. The value-path
// (non-string) mirrors the static unboxers; the string path is what makes
// uint(someArray[0]) on a string element (e.g. AGALMiniAssembler's register
// index) yield the parsed number instead of a silent 0.
// ES3 ToString of an Array is its join(",") -- '"" + [1,2]' is "1,2", not
// "[Array]" (measured on adl 51.4.1, temp/pkgA/arrstr). The as_array layout is
// not visible yet at this point in the preamble, so the helper is declared here
// and defined next to the other array functions.
static char* as_arr_to_str(void* a);
static double as_v_to_number(as_value v) {
    if (v.tag == 3) return as_str_to_number((char*)v.ptr);
    if (v.tag == 2) return v.num;         // bool: 1.0 or 0.0
    if (v.tag == 1) return v.num;
    // A boxed 64-bit value coerced to Number goes through double, so magnitudes
    // past 2^53 round -- documented in the enhancement's cross-type rule (use
    // int64/uint64 arithmetic, not Number arithmetic, when width matters).
    if (v.tag == 8) return (double)v.i64;
    if (v.tag == 9) return (double)v.u64;
    // Arrays: Number([5]) is 5, Number([]) is 0, Number([1,2]) is NaN (the join
    // is "1,2", which is not a number) -- adl 51.4.1, temp/pkgA/arrnum. Object
    // values keep 0 for now: AIR runs the NUMBER-hint ToPrimitive there (valueOf
    // first, then toString), which needs a valueOf vtable slot (TODO.md 遗留:
    // 对象字面量/类实例的 ToPrimitive).
    if (v.tag == 6 && v.ptr != NULL) return as_str_to_number(as_arr_to_str(v.ptr));
    return 0.0;                           // null/undefined/object -> 0
}
static int as_v_to_int(as_value v) {
    // A String goes through ES3 ToNumber, exactly like int(String) does -- so
    // "10x" is NaN->0 and "0x10" is 16, not atof's 10 / atoi's 0 (measured:
    // temp/pkgA/intcoerce).
    if (v.tag == 3) return as_to_int32(as_str_to_number((char*)v.ptr));
    if (v.tag == 2) return v.num != 0.0 ? 1 : 0;
    if (v.tag == 1) return as_to_int32(v.num);
    if (v.tag == 8) return (int)(uint32_t)((uint64_t)v.i64 & 0xFFFFFFFFu);  // ToInt32 = low 32 bits
    if (v.tag == 9) return (int)(uint32_t)(v.u64 & 0xFFFFFFFFu);
    // An Array goes through its join(",") first (int([3]) is 3, adl 51.4.1).
    if (v.tag == 6 && v.ptr != NULL) return as_to_int32(as_str_to_number(as_arr_to_str(v.ptr)));
    return 0;
}
static unsigned as_v_to_uint(as_value v) {
    if (v.tag == 3) return as_to_uint32(as_str_to_number((char*)v.ptr));
    if (v.tag == 2) return v.num != 0.0 ? 1u : 0u;
    if (v.tag == 1) return as_to_uint32(v.num);
    if (v.tag == 8) return (unsigned)(uint32_t)((uint64_t)v.i64 & 0xFFFFFFFFu);
    if (v.tag == 9) return (unsigned)(uint32_t)(v.u64 & 0xFFFFFFFFu);
    // Same array ToPrimitive as as_v_to_int (uint([3]) is 3 on adl 51.4.1).
    if (v.tag == 6 && v.ptr != NULL) return as_to_uint32(as_str_to_number(as_arr_to_str(v.ptr)));
    return 0u;
}
// ToInt64 / ToUint64 (the int64(x)/uint64(x) coercion functions, and the static
// conversion emitted when a value of another type lands in a 64-bit slot):
// numbers truncate toward zero (NaN/Infinity -> 0 -- the double->int64 C cast is
// undefined for those, hence the guards), a String is parsed DECIMAL DIRECTLY
// (deliberately not through ES3 ToNumber like int()/uint(): going through the
// double would round past 2^53 and defeat the exactness this type exists for;
// so garbage -> 0 but a numeric prefix wins, and "0x10" is 0), out of range
// saturates at the type's limit and is reported separately by errno), Booleans
// map to 1/0, null/undefined/objects -> 0.
static int64_t as_num_to_i64(double d) { return (isnan(d) || isinf(d)) ? 0 : (int64_t)d; }
static uint64_t as_num_to_u64(double d) { return (isnan(d) || isinf(d)) ? 0u : (uint64_t)(int64_t)d; }
static int64_t as_str_to_i64(const char* s) {
    if (s == NULL) return 0;
    char* e; errno = 0;
    long long r = strtoll(s, &e, 10);
    // A leading "0x" is decimal-parsed by strtoll only when base 10 is given, so
    // "0x10" stops at the 'x' -- the digits before it win ("0"). Deliberately NOT
    // int()'s rule (ES3 ToNumber would need the double round-trip this function
    // exists to avoid, see the note above as_v_to_i64).
    return (errno != 0 || e == s) ? 0 : (int64_t)r;
}
static uint64_t as_str_to_u64(const char* s) {
    if (s == NULL) return 0u;
    char* e; errno = 0;
    unsigned long long r = strtoull(s, &e, 10);
    return (errno != 0 || e == s) ? 0u : (uint64_t)r;
}
static int64_t as_v_to_i64(as_value v) {
    if (v.tag == 3) return as_str_to_i64((char*)v.ptr);
    if (v.tag == 2) return v.num != 0.0 ? 1 : 0;
    if (v.tag == 1) return as_num_to_i64(v.num);
    if (v.tag == 8) return v.i64;
    if (v.tag == 9) return (int64_t)v.u64;   // wrap, as a C conversion does
    return 0;
}
static uint64_t as_v_to_u64(as_value v) {
    if (v.tag == 3) return as_str_to_u64((char*)v.ptr);
    if (v.tag == 2) return v.num != 0.0 ? 1u : 0u;
    if (v.tag == 1) return as_num_to_u64(v.num);
    if (v.tag == 8) return (uint64_t)v.i64;
    if (v.tag == 9) return v.u64;
    return 0u;
}
// Mathematically correct ordering across the two 64-bit families (a signed/unsigned
// C comparison would convert the signed side to unsigned and mis-order negatives).
// Returns -1 / 0 / 1. Used by the mixed int64/uint64 comparison emitters.
static int as_cmp_i64u64(int64_t a, uint64_t b) {
    if (a < 0) return -1;
    uint64_t ua = (uint64_t)a;
    return ua < b ? -1 : (ua > b ? 1 : 0);
}
// Guarded 64-bit remainder: C's % is undefined on a zero divisor, and AS3's own
// int/uint remainder yields 0 there (measured: adl's as_int_rem path). Same rule
// for the 64-bit types so int64(5) % int64(0) is 0 instead of a trap.
static int64_t as_i64_rem(int64_t a, int64_t b) { return b == 0 ? 0 : a % b; }
static uint64_t as_u64_rem(uint64_t a, uint64_t b) { return b == 0u ? 0u : a % b; }

// AS3 truthiness for condition contexts (if/while/?:/&&/||): null and undefined
// are falsy; numbers/booleans are tested by non-zero; empty string is falsy;
// objects/arrays are truthy when non-null.
// AS3 truthiness of a Number: NaN and +-0 are false, everything else true.
// C's own "if (d)" would call NaN true (NaN != 0 is true), so both the boxed
// path (as_v_truthy) and the statically-number-typed path (condExpr) must use
// this test — otherwise "if (0/0)" and Boolean(NaN) diverge from AIR, which
// reports false for both.
static bool as_num_truthy(double x) { return x != 0.0 && !isnan(x); }

// AS3 truthiness of a String: NULL and the EMPTY string are false, any other
// string is true. C's own "if (s)" on a char* calls "" true (it is a
// non-NULL pointer), so the statically-string-typed path (condExpr) must use
// this test; as_v_truthy's tag-3 case already does the same thing for the boxed
// path. Takes the value as an argument so the operand is evaluated once even
// when it is a call: if (nextName()).
static bool as_str_truthy(const char* s) { return s != NULL && s[0] != 0; }

static bool as_v_truthy(as_value v) {
    switch (v.tag) {
        case 0:
        case 5: return false;
        case 1:
        case 2: return as_num_truthy(v.num);
        case 3: return v.ptr != NULL && ((char*)v.ptr)[0] != 0;
        case 4:
        case 6:
        case 7: return v.ptr != NULL; // functions are truthy when non-null
        case 8: return v.i64 != 0;
        case 9: return v.u64 != 0u;
        default: return false;
    }
}

// a ?? b: true when a must fall through to b — i.e. it is null (tag 0) or
// undefined (tag 5), the same two tags as_v_truthy rejects first. Nothing else
// qualifies: 0, "" , false and NaN all survive ?? (unlike ||).
static bool as_v_is_nullish(as_value v) { return v.tag == 0 || v.tag == 5; }

// Reflection table entry for one dynamically-callable method. 'fn' takes the
// receiver plus a uniform boxed argument list and returns a boxed result, so
// any method can be invoked through a single as_dyn_call dispatch point.
typedef struct { const char* name; as_value (*fn)(void* _this, as_value* args, int argc); } as_method;
// Prototype for the Proxy interceptor dispatcher, defined with the array helpers
// below (measure: as_dyn_call must reach a dynamic Proxy subclass's callProperty).
static as_value as_proxy_call(void* obj, const char* mname, as_value* args, int argc);
// Prototype for the dynamic has-check, defined with the reflection helpers below:
// the pre-baked record/scalar vtables need it for their Object-level
// hasOwnProperty slot before the definition appears.
static bool as_dyn_has(void* obj, const char* key);
// Prototype for the heap-kind classifier (GCT_DICT/ARRAY/CUSTOM), defined with
// the Dictionary helpers below. as_dyn_call consults it to spot a Vector before
// walking a vtable a Vector does not have.
static int as_dyn_kind(void* obj);
// as_dyn_call's property fallback and the boxed-Function invoker it uses are both
// defined further down (after the function-value helpers).
static as_value as_dyn_get(void* obj, const char* key);
static as_value as_fn_call_dyn(as_value fbox, as_value* args, int argc, const char* name);

// Vector.<T> through a dynamically-typed receiver ('var pv:* = vec; pv.length',
// 'pv[0]', 'pv.push(x)'). A Vector is a GCT_CUSTOM body whose FIRST WORD is its
// mark callback, not a vtable, so as_dyn_get/as_dyn_set/as_dyn_call would
// dereference that callback as a vtable header and crash (measured: a pv.push(..)
// call segfaulted). Detection needs no generated code -- as_dyn_kind() above
// already reports GCT_CUSTOM as kind 3 -- but the element type is known only at codegen
// time, so the three operations are delegated to per-specialization helpers that
// the generated as_vec_wire() installs. Semantics measured on adl 51.4.1
// (temp/vecstar/): length is readable AND writable (grow fills null), an index
// read/write in range works, and both out-of-range and negative indices throw
// #1125 -- identical to the statically-typed path.
static as_value (*as_vec_get_hook)(void* ptr, const char* key) = NULL;
static void (*as_vec_set_hook)(void* ptr, const char* key, as_value v) = NULL;
static bool (*as_vec_has_hook)(void* ptr, const char* key) = NULL;
static as_value (*as_vec_call_hook)(void* ptr, const char* name, as_value* args, int argc) = NULL;

// ByteArray's index form (stage 102). ByteArray is a SEALED class, so an any-typed
// receiver would normally hit the property tables and end in #1069/#1056, but AIR
// gives ByteArray an array-access form on both paths -- measured on adl 51.4.1
// (temp/baidxprobe): d[0] is 65 (typeof "number"), d[3] on a 3-byte buffer is
// undefined with no throw, d[3] = 5 on a 1-byte buffer EXTENDS it to length 4
// with the gap zero-filled, "0" in d is true while "5" in d is false, and a
// non-index key still behaves like a sealed class (d.zz = 1 -> #1056). None of
// that is knowable here (the class body is emitted later), so the generated
// as_ba_wire() installs these four hooks, exactly like the Vector ones above.
static int (*as_ba_is_hook)(void* ptr) = NULL;
static as_value (*as_ba_get_key_hook)(void* ptr, const char* key) = NULL;
static void (*as_ba_set_key_hook)(void* ptr, const char* key, as_value v) = NULL;
static int (*as_ba_has_key_hook)(void* ptr, const char* key) = NULL;
// .length is emitted straight to as_any_length (bypassing as_dyn_get), so the
// ByteArray buffer length needs its own hook; without it a '*' receiver read 0.
static int (*as_ba_len_hook)(void* ptr) = NULL;

// Dynamically invoke a method by name on any object, walking the vtable super
// chain to find the first method-reflection table (if any) that declares it.
// Returns as_v_null() when the object is NULL or has no such method.
static as_value as_dyn_call(void* obj, const char* name, as_value* args, int argc) {
    if (obj == NULL) return as_v_null();
    // A monomorphized Vector has no vtable (its first word is its mark callback),
    // so the super-chain walk below would dereference garbage. Route every
    // dynamic call on one to the generated per-specialization dispatcher.
    if (as_vec_call_hook != NULL && as_dyn_kind(obj) == 3) return as_vec_call_hook(obj, name, args, argc);
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
    // A Proxy receiver intercepts the call even when no real method matches:
    // dotted 'p.m2()' on a dynamic Proxy subclass reaches callProperty (measured).
    if (((as_vtable_header*)((as_object_header*)obj)->vtable)->is_proxy)
        return as_proxy_call(obj, name, args, argc);
    // A dynamic object (an object literal, or a class instance's dynamic props)
    // keeps function-valued members in the PROPERTY table, which the method-table
    // walk above never sees. AIR calls such a member ('var o:Object = {n: f};'
    // then 'o.n()'); we returned null without calling anything at all (measured:
    // 2-parameter f raises #1063 in AIR -- temp/pkgA/cbk3/A and cbk4).
    as_value pv = as_dyn_get(obj, name);
    if (pv.tag == 7) return as_fn_call_dyn(pv, args, argc, name);
    return as_v_null();
}
static void* as_v_obj_val(as_value v)   { return v.ptr; }
// Exact decimal text of a 64-bit integer. ulonglong2str to a static buffer (the
// same single-buffer convention as as_str_from_double) with a hand-written
// division loop: printf("%lld") would need a format string that varies by width
// and would pull in the varargs formatter. UINT64_MIN is handled as an unsigned
// magnitude, like strtoll's reference behaviour.
static char* as_u64_to_str(uint64_t x) {
    static char buf[24];   // dual-use: as_i64_to_str is careful to COPY out of it
    char tmp[24];
    int n = 0;
    if (x == 0) { buf[0] = '0'; buf[1] = 0; return buf; }
    while (x > 0) { tmp[n++] = (char)('0' + (int)(x % 10u)); x /= 10u; }
    for (int i = 0; i < n; i++) buf[i] = tmp[n - 1 - i];
    buf[n] = 0;
    return buf;
}
static char* as_i64_to_str(int64_t x) {
    static char buf[24];
    if (x >= 0) return as_u64_to_str((uint64_t)x);
    // Negate as unsigned so INT64_MIN does not overflow.
    uint64_t m = (uint64_t)0 - (uint64_t)x;
    char* d = as_u64_to_str(m);   // shares the static buffer with the call above
    buf[0] = '-';
    int i = 0;
    while (d[i] != 0 && i < 22) { buf[i + 1] = d[i]; i++; }
    buf[i + 1] = 0;
    return buf;
}
// GC-managed (owned) copies, for slots that keep the string (as_str_from_double's
// callers get a static buffer back; a String-typed slot needs its own storage).
static char* as_str_from_u64(uint64_t x) {
    char* d = as_u64_to_str(x);
    char* r = as_str_alloc(strlen(d) + 1);
    strcpy(r, d);
    return r;
}
static char* as_str_from_i64(int64_t x) {
    char* d = as_i64_to_str(x);
    char* r = as_str_alloc(strlen(d) + 1);
    strcpy(r, d);
    return r;
}
// Forward declarations needed by as_v_str_val's Class-value branch below: a
// Class value is a static as_class object (never GC-allocated), so it is
// recognised by registry identity (as_v_is_class) rather than by tag alone.
static bool as_v_is_class(as_value v);
static char* as_str_concat_n(int, const char**);
static char* as_v_str_val(as_value v) {
    switch (v.tag) {
        case 3: return (char*)v.ptr;
        case 1: return as_str_from_double(v.num);
        case 2: return as_str_from_bool(v.num != 0.0);
        case 0: return "null";
        case 4: {
            // A Class value renders as '[class <short name>]' in AIR (a Class value
            // in an Object slot, e.g. var o:Object = BitmapData; trace(o), prints
            // "[class BitmapData]", measured on adl 51.4.1), not the generic object
            // form its vtable name would otherwise produce ("[object BitmapData]").
            // Class objects are static (non-GC) and enumerated in the registry, so
            // identity is the discriminator; every other object falls through
            // unchanged.
            if (!gc_in_heap(v.ptr) && as_v_is_class(v)) {
                void* vt = v.ptr != NULL ? ((as_object_header*)v.ptr)->vtable : NULL;
                const char* fqn = (vt != NULL && ((as_vtable_header*)vt)->fqn != NULL)
                    ? ((as_vtable_header*)vt)->fqn : "Class";
                const char* last = fqn;
                for (const char* p = fqn; *p != 0; p++) { if (*p == ':' || *p == '.') last = p + 1; }
                const char* parts[3];
                parts[0] = "[class ";
                parts[1] = last;
                parts[2] = "]";
                return as_str_concat_n(3, parts);
            }
            // Class instances and object literals stringify through the same
            // virtual-toString path as any other object: 'a' + arr[0] must call
            // an override (AIR); a plain object renders '[object Object]'.
            return as_obj_to_str(v.ptr);
        }
        case 5: return "undefined";
        case 6: return as_arr_to_str(v.ptr);
        case 7: return "[Function]";
        // Owned (GC) copies, NOT the formatters' shared static buffers: trace
        // passes several of these to one printf, so a static buffer would make
        // every argument print the last value.
        case 8: return as_str_from_i64(v.i64);
        case 9: return as_str_from_u64(v.u64);
        default: return "";
    }
}
// Coerce a boxed dynamic value to an AS3 String reference (implicit coercion
// into a typed String slot). null/undefined become the null String (NULL),
// strings pass through, numbers/bools stringify. Distinct from as_v_str_val,
// which is the display form used by trace/concat (null renders as "null").
static char* as_coerce_str(as_value v) {
    switch (v.tag) {
        case 3: return (char*)v.ptr;
        case 1: return as_str_from_double(v.num);
        case 2: return as_str_from_bool(v.num != 0.0);
        case 0:
        case 5: return NULL;
        case 8: return as_str_from_i64(v.i64);
        case 9: return as_str_from_u64(v.u64);
        default: return as_v_str_val(v);
    }
}
// Primitive is checks on boxed values. Scalars box into as_value where all
// numerics share tag 1, so int/uint/Number are not distinguished at runtime
// (documented subset limitation).
// Numeric is-check: the 64-bit enhancement types are Number subtypes, exactly as
// int/uint are (the static rule in scalarIsCompatible mirrors this).
static bool as_v_is_number(as_value v) { return v.tag == 1 || v.tag == 8 || v.tag == 9; }
static bool as_v_is_i64(as_value v) { return v.tag == 8; }
static bool as_v_is_u64(as_value v) { return v.tag == 9; }
static bool as_v_is_bool(as_value v)   { return v.tag == 2; }
static bool as_v_is_string(as_value v) { return v.tag == 3; }
// 'x is Object' on a boxed value: AS3 counts every value except null/undefined
// as an Object, so a boxed scalar (tag 1/2/3), an array, a function value and
// a class instance all pass while null (tag 0) and undefined (tag 5) do not
// (measured on adl 51.4.1, temp/cisprobe/islit-result.txt O1-O15).
static bool as_v_is_object(as_value v) { return v.tag != 0 && v.tag != 5; }
static bool as_v_is_fn(as_value v)     { return v.tag == 7; }
// 'any is IFace' on a dynamically-typed value: only a real object (tag 4) can
// implement an interface, and membership is a name lookup in the class's interface
// list (arrays and boxed primitives implement none). The interface-side counterpart
// of as_is, which walks the *class* chain by vtable identity.
static bool as_v_is_iface(as_value v, const char* name) {
    if (v.tag != 4) return false;
    return as_iface_lookup(v.ptr, name) != NULL;
}
static bool as_v_is_array(as_value v)  { return v.tag == 6; }
// Defined later, together with the class registry they consult (every class object
// lives in that static registry): a Class value is identified by registry
// membership, and as_v_class_of answers an instance's constructor. Forward-
// declared here because the boxed-value helpers below need them.
static bool as_v_is_class(as_value v);
static as_value as_v_class_of(as_value v);
// Boxed 'any' instance-of check against a concrete class vtable. Only object/
// array tags carry a vtable pointer; all other boxed values are not instances.
static bool as_v_is_inst(as_value v, void* target_vt) {
    if (v.tag != 4 && v.tag != 6) return false;
    if (!as_is(as_v_obj_val(v), target_vt)) return false;
    // A Class VALUE is not an instance of the class it names: its first word is
    // that class's own vtable (so the class chain walk in as_is() -- and hence
    // getQualifiedClassName on a Class value -- sees the right fqn), which makes
    // as_is() claim 'EmbedSkyboxFace is Bitmap' for an embedded Bitmap class.
    // AIR says false (measured on adl 51.4.1: temp/embedprobe7, 'var x:* = pic;
    // x is Bitmap' -> true for the INSTANCE, false for the Class value), and
    // claiming true here returned garbage: away3d's Cast.bitmapData() branches on
    // 'data is Class' and then on 'data is Bitmap', so a mis-answered class value
    // fell into the Bitmap branch and read a struct offset that is not bitmapData.
    // The gc_in_heap() gate first keeps the registry scan off the hot path: every
    // class object is a STATIC as_class (emitClassRegistry), so a heap pointer can
    // never be one, and real instances -- the common case here -- skip the scan.
    if (v.tag == 4 && !gc_in_heap(v.ptr) && as_v_is_class(v)) return false;
    return true;
}
// Primitive as casts on a boxed value. These are TYPE-CHECKED, not coercing:
// a mismatch yields null, NOT the primitive's default (measured on adl 51.4.1,
// temp/pkgA/cast2.body.as: ("x" as int), (true as int), (5 as String),
// (5 as Boolean) and ("5" as Number) are all null).
//
// int/uint are the subtle pair: avmplus stores an integral Number as an int atom,
// so x as int succeeds for any Number EXACTLY representable in the target
// integer type and fails outside it -- (5.0 as int) is 5 while (5.5 as int)
// and (2147483648.0 as int) are null, and (3e9 as uint) is 3000000000 while
// (-1.0 as uint) is null. int and uint atoms are interchangeable here, so the
// check is the same for both and applies whatever the operand's static type is.
// The result boxes into tag 1 (Number) because that is how AS3 sees it: an int
// atom is a Number for typeof/toString purposes (as_v_num).
static as_value as_v_cast_int(as_value v) {
    if (v.tag != 1) return as_v_null();
    double d = v.num;
    if (!(d >= -2147483648.0 && d < 2147483648.0)) return as_v_null();
    int i = (int)d;
    return ((double)i == d) ? as_v_num((double)i) : as_v_null();
}
static as_value as_v_cast_uint(as_value v) {
    if (v.tag != 1) return as_v_null();
    double d = v.num;
    if (!(d >= 0.0 && d < 4294967296.0)) return as_v_null();
    unsigned u = (unsigned)d;
    return ((double)u == d) ? as_v_num((double)u) : as_v_null();
}
// x as Number / x as Boolean / x as String: only the matching tag passes.
// An Object-root operand is autoboxed by the caller first (as_obj_to_value), so a
// Number stored in an Object slot recovers its value here (as Number).
static as_value as_v_cast_number(as_value v) { return v.tag == 1 ? as_v_num(v.num) : as_v_null(); }
static as_value as_v_cast_bool(as_value v)   { return v.tag == 2 ? as_v_bool(v.num != 0.0) : as_v_null(); }
static as_value as_v_cast_string(as_value v) { return v.tag == 3 ? as_v_str((char*)v.ptr) : as_v_null(); }
// x as int64 / x as uint64: the 64-bit twin of the casts above. A Number operand
// does NOT convert here (that is what the int64(x)/uint64(x) coercion functions
// are for).
static as_value as_v_cast_i64(as_value v) { return v.tag == 8 ? as_v_i64(v.i64) : as_v_null(); }
static as_value as_v_cast_u64(as_value v) { return v.tag == 9 ? as_v_u64(v.u64) : as_v_null(); }
static bool as_v_eq(as_value a, as_value b) {
    if (a.tag != b.tag) {
        // AS3 loose equality: undefined == null is true. The two 64-bit tags are
        // one numeric family in this enhancement, so a signed/unsigned pair
        // compares by mathematical value (int64(-1) != uint64(MAX) -- the signed
        // operand only matches when it is non-negative).
        if (a.tag == 8 && b.tag == 9) return a.i64 >= 0 && (uint64_t)a.i64 == b.u64;
        if (a.tag == 9 && b.tag == 8) return b.i64 >= 0 && a.u64 == (uint64_t)b.i64;
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
        case 8: return a.i64 == b.i64;
        case 9: return a.u64 == b.u64;
        default: return false;
    }
}
// AS3 strict equality (===): no coercion, so differing tags (including
// undefined vs null) are never equal. Same-tag comparison mirrors as_v_eq.
static bool as_v_seq(as_value a, as_value b) {
    if (a.tag != b.tag) return false;
    switch (a.tag) {
        case 0:
        case 5: return true;
        case 1: return a.num == b.num;
        case 2: return (a.num != 0.0) == (b.num != 0.0);
        case 3: return strcmp((char*)a.ptr, (char*)b.ptr) == 0;
        case 4:
        case 6:
        case 7: return a.ptr == b.ptr;
        case 8: return a.i64 == b.i64;
        case 9: return a.u64 == b.u64;
        default: return false;
    }
}
// AS3 loose equality (== / !=) on boxed values: ES3 Abstract Equality (§11.9.3),
// which COERCES -- a String/Boolean counterpart of a Number becomes a Number
// (measured on adl 51.4.1, temp/pkgA/eq.body.as: true == "1" is true,
// true == "true" is FALSE because ToNumber("true") is NaN, false == "0" is
// true, 5 == "05" is true). as_v_eq keeps the tag-identity semantics that
// Dictionary keys and Array.indexOf rely on, so loose == gets its own helper.
// Objects/arrays/functions still compare by reference only (we do not call
// user-defined valueOf/toString), and undefined == null holds.
static bool as_v_loose_eq(as_value a, as_value b) {
    if (a.tag == b.tag) return as_v_eq(a, b);
    int an = (a.tag == 1 || a.tag == 2 || a.tag == 8 || a.tag == 9);
    int bn = (b.tag == 1 || b.tag == 2 || b.tag == 8 || b.tag == 9);
    if ((an && (bn || b.tag == 3)) || (bn && a.tag == 3)) return as_v_to_number(a) == as_v_to_number(b);
    // An Array compared to a primitive first goes through ToPrimitive: '[5] == 5'
    // is true, '[1,2] == "1,2"' is true, '[1,2] == 12' is false (adl 51.4.1,
    // temp/pkgA/eq). null/undefined do NOT equal an array with the same numeric
    // value (0), so the scalar side is checked explicitly; only undefined == null
    // crosses types there. A plain object/class instance keeps the old answer for
    // now (AIR's number-hint ToPrimitive needs a valueOf vtable slot -- see the
    // TODO.md backlog row on the ToPrimitive of object literals / class
    // instances).
    int aScalar = an || a.tag == 3;
    int bScalar = bn || b.tag == 3;
    if (a.tag == 6 && bScalar) return (b.tag == 3) ? strcmp(as_arr_to_str(a.ptr), (char*)b.ptr) == 0
                                                   : as_v_to_number(a) == as_v_to_number(b);
    if (b.tag == 6 && aScalar) return (a.tag == 3) ? strcmp(as_arr_to_str(b.ptr), (char*)a.ptr) == 0
                                                   : as_v_to_number(a) == as_v_to_number(b);
    return (a.tag == 0 && b.tag == 5) || (a.tag == 5 && b.tag == 0);
}

// ---------- function values ----------
// A function value is a pointer to a closure record: a thunk (unboxing as_value[]
// arguments, calling the typed implementation, boxing the result) plus an optional
// captured-environment pointer. Non-capturing functions use env = NULL.
typedef as_value (*as_fn_impl)(void* env, as_value* args, int argc);
typedef struct {
    as_fn_impl fn;
    void* env;
    int arity;   // AS3 Function.length: the declared parameter count
} as_closure;
typedef as_closure* as_fn;
static as_fn as_fn_make(as_fn_impl fn, void* env, int arity) {
    as_fn f = (as_fn)gc_alloc(GCT_CLOSURE, sizeof(as_closure));
    f->fn = fn;
    f->env = env;
    f->arity = arity;
    return f;
}

// ---------- setTimeout / setInterval (+ their clear functions) ----------
// AS3 flash.utils.setTimeout(closure, delay, ...) schedules a Function call after
// 'delay' milliseconds and returns a uint timer id; setInterval(closure, delay, ...)
// calls it every 'delay' ms until clearInterval. Both live in ONE table with ONE
// id counter, and clearTimeout/clearInterval are interchangeable — measured on
// adl 51.4.1 (temp/intervalprobe/): ids are handed out 1,2,3... across both
// functions, clearInterval cancels a setTimeout id and clearTimeout cancels a
// setInterval id, and an unknown/0 id is a silent no-op.
// Timers are driven by the frame tick (Stage_dispatchFrame), the same loop that
// fires ENTER_FRAME, so callbacks run from the event loop like AIR's timer
// system. Deadline is wall-clock ms (as_now_ms basis) so delays are real time,
// independent of the frame cadence.
// A repeat timer is rescheduled from the END of its callback (measured: a 50 ms
// callback under a 20 ms interval ticks every ~69 ms, not ~20 ms), and fires at
// most once per frame pass — both match AIR's observable cadence, which is
// itself bounded by the frame loop.
typedef struct {
    unsigned int id;
    double deadline;
    as_fn fn;
    int alive;
    as_value* args;   // NULL when argc==0; GC-managed GCT_VALUE_ARRAY buffer
    int argc;
    int repeat;       // setInterval: 1; setTimeout: 0
    double delay;     // repeat timer's period, in ms
} as_timer;

static as_timer* as_timers = NULL;
static int as_timer_count = 0;
static int as_timer_cap = 0;
static unsigned int as_timer_next_id = 1;

// A negative or NaN delay is RangeError #2066 in AIR (measured for both
// setTimeout and setInterval, and the failed call consumes NO id). Defined in the
// generated section (Error subclasses live there); forward-declared here.
static void as_throw_delay_range(double delay);
// A non-UTF-8/UTF-16 charset on a backend without iconv is a loud failure, not a
// silent decode. Defined in the generated section (Error lives there).
static void as_throw_charset_unsupported(const char* name);

// flash.utils.setTimeout(closure, delay, ...args): schedule a Function call after
// 'delay' ms, passing the boxed trailing 'args' to the closure when it fires.
// Returns a uint timer id. A null closure is NOT an error in AIR — it still
// consumes an id and simply never calls anything (measured: setTimeout(null,100)
// returns 1), so the slot is registered with fn == NULL. The args are copied into
// a GC-managed value-array buffer so any object references survive a collection
// between scheduling and firing.
static unsigned int as_set_timeout_args(as_fn fn, double delay, int argc, as_value* args) {
    if (!(delay >= 0)) as_throw_delay_range(delay);   // also catches NaN
    if (as_timer_count == as_timer_cap) {
        as_timer_cap = as_timer_cap == 0 ? 8 : as_timer_cap * 2;
        as_timers = (as_timer*)realloc(as_timers, (size_t)as_timer_cap * sizeof(as_timer));
    }
    as_timer* t = &as_timers[as_timer_count++];
    t->id = as_timer_next_id++;
    t->deadline = as_now_ms() + delay;
    t->fn = fn;
    t->alive = 1;
    t->argc = argc;
    t->args = NULL;
    t->repeat = 0;
    t->delay = delay;
    if (argc > 0) {
        t->args = (as_value*)gc_alloc(GCT_VALUE_ARRAY, sizeof(as_value) * (size_t)argc);
        for (int i = 0; i < argc; i++) {
            t->args[i] = args[i];
            gc_write_barrier_value(args[i]);
        }
    }
    return t->id;
}

static unsigned int as_set_timeout(as_fn fn, double delay) {
    return as_set_timeout_args(fn, delay, 0, NULL);
}

// flash.utils.setInterval(closure, delay, ...args): like setTimeout, but the
// callback repeats every 'delay' ms until clearInterval/clearTimeout. Shares the
// id counter and the timer table with setTimeout (see the block comment above).
static unsigned int as_set_interval_args(as_fn fn, double delay, int argc, as_value* args) {
    unsigned int id = as_set_timeout_args(fn, delay, argc, args);
    for (int i = 0; i < as_timer_count; i++) {
        if (as_timers[i].id == id) { as_timers[i].repeat = 1; return id; }
    }
    return id;
}

static unsigned int as_set_interval(as_fn fn, double delay) {
    return as_set_interval_args(fn, delay, 0, NULL);
}

// flash.utils.clearTimeout / clearInterval: the two are interchangeable in AIR
// (one table, one id space), so both call this. Unknown and 0 ids are silent
// no-ops (measured). Marking the slot dead is also how a repeat timer is stopped
// from inside its own callback: alive == 2 marks it as firing, and the tick pass
// only reschedules a slot that is still 2 when the callback returns.
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
            as_value* args = t->args;
            int argc = t->argc;
            unsigned int id = t->id;
            int rep = t->repeat;
            double delay = t->delay;
            // A null closure occupies its id slot but never fires (AIR accepts it).
            if (f == NULL || f->fn == NULL) { t->alive = 0; continue; }
            // 0 = spent (timeout), 2 = firing (repeat); a callback that calls
            // clearInterval(id) flips it to 0 before the reschedule below.
            t->alive = rep ? 2 : 0;
            f->fn(f->env, args, argc);
            if (rep) {
                // Re-find the slot by id: the callback may have realloc'd the table
                // (a nested setTimeout/setInterval can grow it).
                for (int j = 0; j < as_timer_count; j++) {
                    if (as_timers[j].id == id) {
                        if (as_timers[j].alive == 2) {
                            as_timers[j].alive = 1;
                            as_timers[j].deadline = as_now_ms() + delay;  // from-completion
                        }
                        break;
                    }
                }
            }
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

// ---------- flash.media audio (阶段九十六) ----------
// The backend is vendor/audio_glue.c (miniaudio) reached through the as_audio_*
// seam below; docs/zh-cn/audio.md is the design record. Two layers live here:
//
//   * the SEAM — the only platform-coupled part. Without ASC_HAVE_AUDIO every
//     entry point is an honest "no backend" (ready() == 0, play() == -1), which
//     the AS3 side turns into AIR's own no-sound-card result (play() returns
//     null). A build with no audio library never pretends a sound played.
//   * the ENGINE — the live-channel table. It is what makes a playing channel a
//     GC root (the app's own reference may be the only other one, and AIR keeps
//     a channel alive until soundComplete), and as_audio_tick() is the
//     frame-boundary poll that turns "the backend finished this voice" into a
//     soundComplete dispatch ON THE AS3 THREAD.
//
// The audio thread never touches this table: it only flips voice state inside
// the glue. Everything here runs on the AS3 thread, so the table needs no lock.
#define AS_AUDIO_VOICES 32

#ifdef ASC_HAVE_AUDIO
extern int as_audio_decode(const void* data, unsigned int size);
extern int as_audio_register_pcm(const float* pcm, long long frames, int channels, int rate);
extern int as_audio_buf_valid(int buf);
extern long long as_audio_buf_frames(int buf);
extern int as_audio_buf_channels(int buf);
extern int as_audio_buf_rate(int buf);
extern double as_audio_buf_ms(int buf);
extern const float* as_audio_buf_data(int buf);
extern int as_audio_play(int buf, double startMs, int loops, double vol, double ltl, double ltr, double rtl, double rtr);
extern void as_audio_voice_stop(int v);
extern void as_audio_voice_reap(int v);
extern int as_audio_voice_state(int v);
extern double as_audio_voice_pos_ms(int v);
extern void as_audio_voice_transform(int v, double vol, double ltl, double ltr, double rtl, double rtr);
extern int as_audio_voice_buf(int v);
extern double as_audio_voice_left_peak(int v);
extern double as_audio_voice_right_peak(int v);
extern void as_audio_stop_all(void);
extern void as_audio_set_mix(double vol, double ltl, double ltr, double rtl, double rtr);
extern int as_audio_ready(void);
extern const char* as_audio_backend(void);
extern const char* as_audio_last_error(void);
extern long long as_audio_ring_read(float* dst, long long frames);
extern int as_audio_spectrum(float* out, int fftMode, int stretchFactor);
extern const char* as_audio_id3_field(int buf, int which);
extern void as_audio_shutdown(void);
#else
// No audio backend: every entry point answers "nothing is playing" instead of
// succeeding quietly. as_audio_last_error() is the string the AS3 side reports
// when it cannot play, so the reason is visible rather than inferred.
static inline int as_audio_decode(const void* d, unsigned int s) { (void)d; (void)s; return -1; }
static inline int as_audio_register_pcm(const float* p, long long f, int c, int r) { (void)p; (void)f; (void)c; (void)r; return -1; }
static inline int as_audio_buf_valid(int b) { (void)b; return 0; }
static inline long long as_audio_buf_frames(int b) { (void)b; return 0; }
static inline int as_audio_buf_channels(int b) { (void)b; return 0; }
static inline int as_audio_buf_rate(int b) { (void)b; return 0; }
static inline double as_audio_buf_ms(int b) { (void)b; return 0; }
static inline const float* as_audio_buf_data(int b) { (void)b; return NULL; }
static inline int as_audio_play(int b, double s, int l, double v, double a, double c, double d, double e) { (void)b; (void)s; (void)l; (void)v; (void)a; (void)c; (void)d; (void)e; return -1; }
static inline void as_audio_voice_stop(int v) { (void)v; }
static inline void as_audio_voice_reap(int v) { (void)v; }
static inline int as_audio_voice_state(int v) { (void)v; return 0; }
static inline double as_audio_voice_pos_ms(int v) { (void)v; return 0; }
static inline void as_audio_voice_transform(int v, double a, double b, double c, double d, double e) { (void)v; (void)a; (void)b; (void)c; (void)d; (void)e; }
static inline int as_audio_voice_buf(int v) { (void)v; return -1; }
static inline double as_audio_voice_left_peak(int v) { (void)v; return 0; }
static inline double as_audio_voice_right_peak(int v) { (void)v; return 0; }
static inline void as_audio_stop_all(void) { }
static inline void as_audio_set_mix(double v, double a, double c, double d, double e) { (void)v; (void)a; (void)c; (void)d; (void)e; }
static inline int as_audio_ready(void) { return 0; }
static inline const char* as_audio_backend(void) { return "none"; }
static inline const char* as_audio_last_error(void) { return "this build has no audio backend (ASC_HAVE_AUDIO undefined)"; }
static inline long long as_audio_ring_read(float* d, long long f) { (void)d; (void)f; return 0; }
static inline int as_audio_spectrum(float* o, int m, int s) { (void)o; (void)m; (void)s; return 0; }
static inline const char* as_audio_id3_field(int b, int w) { (void)b; (void)w; return NULL; }
static inline void as_audio_shutdown(void) { }
#endif

// One entry per backend voice slot. 'done' is emitted by the generator (the
// runtime cannot name the generated SoundChannel struct) and dispatches
// soundComplete + releases the voice; 'active' is the AS3-side flag so a stopped
// channel stops reporting a position from a recycled slot.
typedef struct {
    void* channel;
    int voice;
    void (*done)(void* channel);
} as_audio_chan;

static as_audio_chan as_audio_chans[AS_AUDIO_VOICES];

static int as_audio_chan_add(void* channel, int voice, void (*done)(void*)) {
    if (voice < 0 || voice >= AS_AUDIO_VOICES) return 0;
    as_audio_chans[voice].channel = channel;
    as_audio_chans[voice].voice = voice;
    as_audio_chans[voice].done = done;
    return 1;
}

static void as_audio_chan_remove(int voice) {
    if (voice < 0 || voice >= AS_AUDIO_VOICES) return;
    as_audio_chans[voice].channel = NULL;
    as_audio_chans[voice].done = NULL;
}

// SoundMixer.stopAll walks the same table: it needs the live channel at a slot
// (to reset its position and voice id) before dropping the reference.
static void* as_audio_chan_at(int voice) {
    if (voice < 0 || voice >= AS_AUDIO_VOICES) return NULL;
    return as_audio_chans[voice].channel;
}

// Frame-boundary poll. Only voices that reached the end of their last pass are
// reported: an explicit stop() is handled synchronously by SoundChannel.stop
// (AIR fires no soundComplete for a stopped channel), so a STOPPED slot is
// simply released.
static void as_audio_tick(void) {
    for (int i = 0; i < AS_AUDIO_VOICES; i++) {
        as_audio_chan* c = &as_audio_chans[i];
        if (c->channel == NULL) continue;
        int st = as_audio_voice_state(c->voice);
        if (st == 1) continue;                       // still playing
        void* ch = c->channel;
        void (*done)(void*) = c->done;
        c->channel = NULL;
        c->done = NULL;
        if (st == 2 && done != NULL) done(ch);       // finished: soundComplete
    }
}

static void as_audio_mark_roots(void) {
    for (int i = 0; i < AS_AUDIO_VOICES; i++) {
        if (as_audio_chans[i].channel != NULL) gc_mark_ptr(as_audio_chans[i].channel);
    }
}

// ---------- class reference ----------
// AS3 Class values (obtained via 'x as Class') can be dynamically instantiated
// with 'new (classRef)(...)' and, through their STATIC traits, called:
// classValue.someStaticMethod(...) (away3d keeps parser classes in a
// Vector.<Class> and asks each one _parsers[i].supportsType(ext)). A class
// reference therefore carries the class vtable, a no-arg factory that
// heap-allocates and constructs an instance, an argument-carrying ctor thunk, and
// a table of static members. Factories are emitted per user class; built-ins that
// are never reflected stay NULL.
//
// One static-member entry. kind 1 is a static METHOD: fn is the same boxed-args
// thunk shape as as_fn_impl and arity is the declared parameter count for
// Function.length. kind 2 is a static FIELD/const, recorded by NAME ONLY (fn
// NULL): reading one through a Class value is not implemented, and the name is
// kept so that case fails loudly instead of silently returning undefined -- which
// is exactly what AIR returns for a name that is not a static member at all
// (measured on adl 51.4.1, temp/classprobe: c.nope -> undefined while a real
// static field reads its value).
typedef struct {
    const char* name;
    int kind;
    as_value (*fn)(void* env, as_value* args, int argc);
    int arity;
} as_class_static;

typedef struct {
    void* vtable;
    void* (*factory)(void);
    // Argument-carrying constructor for dynamic instantiation with arguments
    // (new (classRef)(a, b)): an as_fn-shaped thunk that unboxes the boxed
    // arguments, enforces AIR's #1063 count rules and calls the typed X_new.
    // NULL when the class takes no parameters (AIR then reports #1063 for any
    // argument) -- the no-argument 'factory' is tried first, so a parameterless
    // class never reaches it.
    as_value (*ctor_fn)(void* env, as_value* args, int argc);
    // AIR quotes the class in #1063 ("... on pkg::Bar(). Expected 1, got 3."), and
    // reports the count of parameters WITHOUT defaults as "Expected". Both are
    // per-class constants carried in the class object so the error can be built
    // without a per-class message string.
    const char* fqn;
    int ctor_req;
    // NULL-terminated table of the class's static members (NULL when the program
    // never looks a static member up through a Class value).
    const as_class_static* statics;
} as_class;

// Unbox a class reference stored as an object; non-object values yield NULL.
static as_class* as_v_as_class(as_value v) {
    return (v.tag == 4 || v.tag == 6) ? (as_class*)as_v_obj_val(v) : NULL;
}
// Unbox the operand of a dynamic instantiation (new <expr>()). The operand must
// be a Class VALUE; AIR refuses anything else with TypeError #1007
// "Instantiation attempted on a non-constructor." (as_dyn_new turns a NULL here
// into exactly that).
//
// The test is deliberately the SAME one the 'is Class' operator uses -- registry
// identity -- so 'if (x is Class) new x()' can never disagree with itself. Two
// gates in front of the scan keep it cheap and make it fail closed:
//   * tag 4, because that is how a Class value boxes (boxExpr's 'class' case);
//   * not in the GC heap, because every class object is a STATIC as_class
//     (emitClassRegistry) -- the same invariant as_v_is_inst relies on. A heap
//     pointer is therefore a real instance, a record, an Array/Vector or a boxed
//     primitive, none of which is a constructor. Without the gates, a String
//     operand's char* or an object instance's record was followed as an
//     as_class* and its garbage factory slot called instead of throwing.
static as_class* as_v_new_class(as_value v) {
    if (v.tag != 4 || v.ptr == NULL || gc_in_heap(v.ptr)) return NULL;
    return as_v_is_class(v) ? (as_class*)v.ptr : NULL;
}
// The same test for an Object-typed operand, where the class reference travels as
// a bare pointer rather than a box (a class stored in an Object slot is the static
// as_class cast to Object*, not a boxed value).
static as_class* as_new_class_ptr(void* p) {
    if (p == NULL || gc_in_heap(p)) return NULL;
    return as_v_is_class(as_v_obj(p)) ? (as_class*)p : NULL;
}
static void* as_v_as_fn(as_value v) {
    return (v.tag == 7) ? v.ptr : NULL;
}

// ---------- dynamic array ----------
// AS3 Array is a dynamically-growing, heterogeneously-typed sequence. It is also
// a DYNAMIC object: a.bar = 8 stores an ordinary named property (leaving
// a.length and the numeric elements untouched), which is why non-index keys
// need their own slot table — they must never be folded onto element 0.
// (struct as_object_s is declared here and defined with the record type below.)
struct as_object_s;
typedef struct {
    as_value* data;
    int length;
    int capacity;
    int index;      // RegExp exec/match result: match start position
    char* input;    // RegExp exec/match result: the input string
    struct as_object_s* props; // named (non-index) properties: a.bar, a["bar"]
} as_array;

// AS3 array index keys are canonical non-negative decimal integers WITHOUT leading
// zeros: "0", "1", "42" are indices; "01", "-1", "1.0", "" and "bar" are not
// (they address dynamic named properties instead). Returning the index iff the
// key is canonical is what keeps a["01"] from aliasing a[1].
static bool as_array_index_key(const char* key, int* out) {
    if (key == NULL || key[0] == '\\0') return false;
    if (key[0] == '0' && key[1] != '\\0') return false; // leading zero
    long v = 0;
    for (const char* p = key; *p; p++) {
        if (*p < '0' || *p > '9') return false;
        v = v * 10 + (*p - '0');
        if (v > 0x7fffffffL) return false;
    }
    *out = (int)v;
    return true;
}

// Dictionary: a flat key/value table with no vtable of its own (its GC tag
// GCT_DICT is what distinguishes it from a class instance). Declared here rather
// than beside its functions because the dynamic accessors dispatch on it.
typedef struct {
    as_value* keys;
    as_value* vals;
    int length;
    int capacity;
} as_dict;

static as_array* as_array_new(void) {
    as_array* a = (as_array*)gc_alloc(GCT_ARRAY, sizeof(as_array));
    a->data = NULL;
    a->length = 0;
    a->capacity = 0;
    a->index = 0;
    a->input = NULL;
    a->props = NULL;
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
    a->props = NULL;
    return a;
}

// ---------- flash.utils.Proxy interception (stage 94a) ----------
// A Proxy subclass's dynamic operations are INTERCEPTORS, not slot lookups. Its
// flash_proxy overrides are emitted as ordinary methods (same as_method
// signature as every other method), so a miss on a proxy receiver is served by
// locating 'mname' on the vtable super chain and calling it. Measured on
// adl 51.4.1 (temp/proxyprobe/): only the subclass's own overrides are reachable
// this way — the base Proxy methods are absent — and AIR then throws the matching
// numbered Error, all of class Error (not ReferenceError/TypeError): #2088 get /
// #2089 set / #2090 callProperty / #2091 has / #2092 delete / #2093
// getDescendants / #2105 nextNameIndex / #2106 nextName / #2107 nextValue.
// Messages follow this project's convention of carrying AIR's documented text
// (note: 'adl -nodebug' reports the short form "Error #NNNN" for ALL built-in
// errors in this environment, including the pre-existing #1056/#1069).
static as_value as_proxy_throw(const char* mname, int id);
static int as_is_proxy(void* obj) {
    return ((as_vtable_header*)((as_object_header*)obj)->vtable)->is_proxy != 0;
}
static int as_proxy_invoke(void* obj, const char* mname, as_value* args, int argc, as_value* out) {
    // Interceptor methods live in AIR's flash_proxy namespace, so their reflection
    // entries are stored mangled (see PROXY_NS_METHODS in symbols.ts); a public
    // dynamic access never matches them, an interceptor dispatch always does.
    char key[160];
    snprintf(key, sizeof key, "flash_proxy::%s", mname);
    void* vt = ((as_object_header*)obj)->vtable;
    while (vt != NULL) {
        as_method* methods = (as_method*)((as_vtable_header*)vt)->methods;
        if (methods != NULL)
            for (int i = 0; methods[i].name != NULL; i++)
                if (strcmp(methods[i].name, key) == 0) { *out = methods[i].fn(obj, args, argc); return 1; }
        vt = ((as_vtable_header*)vt)->super;
    }
    return 0;
}
static as_value as_proxy_get_miss(void* obj, const char* key) {
    as_value a = as_v_str((char*)key), out;
    if (as_proxy_invoke(obj, "getProperty", &a, 1, &out)) return out;
    return as_proxy_throw("getProperty", 2088);
}
static void as_proxy_set_miss(void* obj, const char* key, as_value v) {
    as_value a[2]; a[0] = as_v_str((char*)key); a[1] = v;
    as_value out;
    if (as_proxy_invoke(obj, "setProperty", a, 2, &out)) return;
    as_proxy_throw("setProperty", 2089);
}
static bool as_proxy_has_miss(void* obj, const char* key) {
    as_value a = as_v_str((char*)key), out;
    if (as_proxy_invoke(obj, "hasProperty", &a, 1, &out)) return as_v_truthy(out);
    as_proxy_throw("hasProperty", 2091);
    return false;
}
static bool as_proxy_del_miss(void* obj, const char* key) {
    as_value a = as_v_str((char*)key), out;
    if (as_proxy_invoke(obj, "deleteProperty", &a, 1, &out)) return as_v_truthy(out);
    as_proxy_throw("deleteProperty", 2092);
    return false;
}
// callProperty(name, ...rest): the invoked name is argument 0 and the call
// arguments follow. The rest parameter is registered as an implicit Array (AS3
// semantics), so the uniform thunk unboxes args[1] as an array: the flat
// argument list is packed into one here rather than spread, matching how a
// direct call packs '...rest'.
static as_value as_proxy_call(void* obj, const char* mname, as_value* args, int argc) {
    as_value buf[2];
    buf[0] = as_v_str((char*)mname);
    buf[1] = as_v_obj(argc > 0 ? as_array_make(argc, args) : as_array_new());
    as_value out;
    if (as_proxy_invoke(obj, "callProperty", buf, 2, &out)) return out;
    return as_proxy_throw("callProperty", 2090);
}
// Enumeration protocol: the loop starts at index 0 and replaces it with each
// nextNameIndex() result until 0 (measured: nextNameIndex(0) -> 1, nextName(1),
// nextNameIndex(1) -> 2, ...). for-each uses nextValue instead of nextName.
static int as_proxy_next_index(void* obj, int index) {
    as_value a = as_v_num((double)index), out;
    if (as_proxy_invoke(obj, "nextNameIndex", &a, 1, &out)) return as_v_to_int(out);
    as_proxy_throw("nextNameIndex", 2105);
    return 0;
}
static char* as_proxy_next_name(void* obj, int index) {
    as_value a = as_v_num((double)index), out;
    if (as_proxy_invoke(obj, "nextName", &a, 1, &out)) return as_v_str_val(out);
    as_proxy_throw("nextName", 2106);
    return NULL;
}
static as_value as_proxy_next_value(void* obj, int index) {
    as_value a = as_v_num((double)index), out;
    if (as_proxy_invoke(obj, "nextValue", &a, 1, &out)) return out;
    return as_proxy_throw("nextValue", 2107);
}
static as_value as_proxy_descendants(void* obj, const char* key) {
    as_value a = as_v_str((char*)key), out;
    if (as_proxy_invoke(obj, "getDescendants", &a, 1, &out)) return out;
    return as_proxy_throw("getDescendants", 2093);
}
static char* as_proxy_to_str(void* obj) {
    as_value out = as_proxy_call(obj, "toString", NULL, 0);
    if (out.tag == 3) return (char*)out.ptr;
    return as_v_str_val(out);
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
// dispatch like obj[type](...) where the callee's static type is 'any'). A value
// that is not a function is a TypeError #1006 in AIR (measured on adl 51.4.1:
// 'p['m'](1,2)' on a Proxy whose getProperty returns a String throws #1006), not a
// silent null — passing the call site's name so the message matches AVM2's form.
static as_value as_throw_not_function(const char* name);
static as_value as_fn_call_dyn(as_value fbox, as_value* args, int argc, const char* name) {
    if (fbox.tag != 7) return as_throw_not_function(name);
    as_fn f = (as_fn)as_v_obj_val(fbox);
    if (f == NULL || f->fn == NULL) return as_throw_not_function(name);
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
    // The fresh block is born BLACK while a cycle is in progress (allocation
    // barrier), so the sweep will not free it -- but a black object is never
    // scanned this cycle either, which means the pointers copied into it would
    // be invisible to the marker and any object reachable ONLY through the new
    // buffer would be swept WHILE STILL REFERENCED. Re-grey every copied slot
    // (a no-op outside MARK): the write barrier is what keeps "no black object
    // points at a white object" true for fresh blocks.
    for (int i = 0; i < a->length; i++) gc_write_barrier_value(nd[i]);
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
// An Array's ES3 string form is its join(","), recursively -- '"" + [1,2]' is
// "1,2" (not "[Array]") and '"" + [[1,2],[3]]' is "1,2,3" (adl 51.4.1,
// temp/pkgA/arrstr). as_arr_to_str is declared up by as_v_to_number, where the
// as_array layout is not visible yet.
static char* as_array_join(as_array* a, const char* sep) {
    // A String-typed separator can be the AS3 null string (C NULL); AIR stringifies
    // it as "null" (adl 51.4.1: String s = null; [1,2].join(s) -> "1null2"), and
    // the strlen below would fault on it.
    if (sep == NULL) sep = "null";
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
static char* as_arr_to_str(void* a) {
    return as_array_join((as_array*)a, ",");
}
// Separator argument of join() when it is dynamically typed: undefined selects the
// default "," while null is the string "null" (ES3 15.4.4.5; adl 51.4.1 measured
// in temp/pkgA/arr5).
static char* as_join_sep(as_value v) {
    return (v.tag == 5) ? (char*)"," : as_v_str_val(v);
}
// Dynamic .length / .join(...) on an 'any' value: dispatch at runtime on the
// boxed tag (string length, array length/join; everything else -> 0/empty).
static int as_any_length(as_value v) {
    if (v.tag == 6) return ((as_array*)v.ptr)->length;
    if (v.tag == 3) return (int)strlen((char*)v.ptr);
    // A dynamically-typed Vector ('var pv:* = vec; pv.length') boxes as tag 4 but
    // has no vtable, so it needs the generated accessor rather than a length field.
    if (v.tag == 4 && v.ptr != NULL && as_vec_get_hook != NULL && as_dyn_kind(v.ptr) == 3)
        return as_v_int_val(as_vec_get_hook(v.ptr, "length"));
    if (v.tag == 4 && v.ptr != NULL && as_ba_is_hook != NULL && as_ba_is_hook(v.ptr)) return as_ba_len_hook(v.ptr);
    return 0;
}
static char* as_any_join(as_value v, const char* sep) {
    if (v.tag == 6) return as_array_join((as_array*)v.ptr, sep);
    // Same GCT_CUSTOM detour as as_any_length: 'pv.join("|")' on a star-typed receiver is
    // emitted straight to as_any_join, bypassing as_any_call.
    if (v.tag == 4 && v.ptr != NULL && as_vec_call_hook != NULL && as_dyn_kind(v.ptr) == 3) {
        as_value a[1];
        a[0] = as_v_str((char*)sep);
        return as_v_str_val(as_vec_call_hook(v.ptr, "join", a, 1));
    }
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

// Array.insertAt(index, value): Starling's extension method. Inserts value at
// index (clamped to [0, length]), shifting the tail right by one.
static void as_array_insertAt(as_array* a, int index, as_value v) {
    if (index < 0) index = 0;
    if (index > a->length) index = a->length;
    as_array_ensure(a, a->length + 1);
    for (int i = a->length; i > index; i--) a->data[i] = a->data[i - 1];
    a->data[index] = v;
    a->length++;
    gc_write_barrier_value(v);
}

// Array.removeAt(index): Starling's extension method. Removes the element at
// index and returns it (or null when out of range).
static as_value as_array_removeAt(as_array* a, int index) {
    if (index < 0 || index >= a->length) return as_v_null();
    as_value v = a->data[index];
    for (int i = index; i < a->length - 1; i++) a->data[i] = a->data[i + 1];
    a->length--;
    return v;
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
    double na = as_v_to_number(a);
    double nb = as_v_to_number(b);
    if (na < nb) return -1;
    if (na > nb) return 1;
    return 0;
}
// Custom comparator: AS3's compare(a,b) returns a Number whose sign selects the
// order (negative = a before b). Map that sign onto the insertion-sort result.
static int as_cmp_cb(as_value a, as_value b, void* ctx) {
    as_fn cb = (as_fn)ctx;
    as_value args[2] = { a, b };
    double d = as_v_to_number(cb->fn(cb->env, args, 2));
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
        // The callback's return is a dynamic value in a Boolean context, so it
        // gets ToBoolean (a non-empty String is truthy; the raw unboxer read
        // .num == 0 and dropped it).
        if (as_v_truthy(cb->fn(cb->env, args, 3))) {
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
// The generated class vtables append Object's own method slots (toString and
// hasOwnProperty) after the common header, so the pre-baked vtables declared here
// must carry the same slots: a shorter object leaves them reading whatever variable
// happens to follow, and '({a:1}).hasOwnProperty("a")' (a plain object literal, or
// an Object-typed slot holding a boxed scalar) then jumps through a garbage
// function pointer. The generated Object_hasOwnProperty is this same as_dyn_has
// walk, and Object_toString is as_obj_to_str, so the semantics match exactly.
typedef struct {
    const char* name; void* super; void** ifaces; void* props; void* methods;
    void* getters; void* setters; int dyn_offset; const char* fqn; int is_proxy;
    char* (*toString)(void*);
    bool (*hasOwnProperty)(void*, char*);
} as_object_vtable;

static bool as_object_own_has_own_property(void* _this, char* name) {
    if (_this == NULL || name == NULL) return false;
    return as_dyn_has(_this, (const char*)name);
}
static char* as_object_box_to_str(void* o) { return as_obj_default_str(o); }
// Boxed scalars know their own text; defined next to their structs below.
static char* as_number_box_to_str(void* o);
static char* as_string_box_to_str(void* o);

static as_object_vtable as_object_vt = { "Object", NULL, NULL, NULL, NULL, NULL, NULL, -1, "Object", 0, as_object_box_to_str, as_object_own_has_own_property };

// ---------- boxed Number (Object slot holding a scalar) ----------
// AS3's Object is the universal base AND auto-boxes scalars: 'var data:Object =
// 3.14' stores a boxed Number, recovered by 'data as Number'. Object-typed slots
// are represented as raw 'Object*' pointers, so a Number (a bare double) cannot
// be stored there without boxing. This leaf object wraps the double behind the
// same vtable header as every other object, so as_object_class_name reads
// "Number" and 'as Number' can recover the value by checking the vtable identity.
typedef struct as_number {
    void* vtable;               // &as_number_vt (Object subclass)
    double value;
} as_number;

static char* as_number_box_to_str(void* o) { return as_str_from_double(((as_number*)o)->value); }

static as_object_vtable as_number_vt = { "Number", &as_object_vt, NULL, NULL, NULL, NULL, NULL, -1, "Number", 0, as_number_box_to_str, as_object_own_has_own_property };

static as_number* as_number_new(double value) {
    as_number* n = (as_number*)gc_alloc(GCT_NUMBER, sizeof(as_number));
    n->vtable = (void*)&as_number_vt;
    n->value = value;
    return n;
}

static bool as_is_number_obj(void* obj) {
    if (obj == NULL) return false;
    return ((as_object_header*)obj)->vtable == (void*)&as_number_vt;
}

static double as_number_obj_val(void* obj) {
    return obj == NULL ? 0.0 : ((as_number*)obj)->value;
}

// ---------- boxed String (Object slot holding a String) ----------
// Mirrors boxed Number: AS3's String is a final Object subclass, so 'var data:
// Object = "hello"' stores a boxed String, recovered by 'data as String'. A bare
// char* (this runtime's String representation) cannot live in an Object* slot, so
// it is wrapped behind the same vtable header. The wrapped char* is itself a
// GCT_STRING leaf (or a non-heap literal) and is traced in gc_scan.
typedef struct as_string {
    void* vtable;               // &as_string_vt (Object subclass)
    char* value;                // the wrapped GCT_STRING char*
} as_string;

static char* as_string_box_to_str(void* o) { return ((as_string*)o)->value; }

static as_object_vtable as_string_vt = { "String", &as_object_vt, NULL, NULL, NULL, NULL, NULL, -1, "String", 0, as_string_box_to_str, as_object_own_has_own_property };

static as_string* as_string_new(char* value) {
    as_string* s = (as_string*)gc_alloc(GCT_STRING_OBJ, sizeof(as_string));
    s->vtable = (void*)&as_string_vt;
    s->value = value;
    gc_write_barrier((void*)value);
    return s;
}

static bool as_is_string_obj(void* obj) {
    if (obj == NULL) return false;
    return ((as_object_header*)obj)->vtable == (void*)&as_string_vt;
}

static char* as_string_obj_val(void* obj) {
    return obj == NULL ? NULL : ((as_string*)obj)->value;
}

// ---------- boxed Function (Object slot holding a Function) ----------
// Mirrors boxed Number/String: AS3's Function is an Object subclass, so 'var
// data:Object = myFunc' stores a Function object recovered by 'data as Function'.
// A bare as_fn closure has no vtable header, so it is wrapped behind the same
// header as every other object; 'is Function'/'as Function' then identify it by
// vtable identity. The wrapped closure is a GCT_CLOSURE and is traced in gc_scan.
typedef struct {
    void* vtable;               // &as_function_vt (Object subclass)
    as_fn value;                // the wrapped closure
} as_function;

static as_object_vtable as_function_vt = { "Function", &as_object_vt, NULL, NULL, NULL, NULL, NULL, -1, "Function", 0, as_object_box_to_str, as_object_own_has_own_property };

static as_function* as_function_new(as_fn value) {
    as_function* f = (as_function*)gc_alloc(GCT_FUNCTION_OBJ, sizeof(as_function));
    f->vtable = (void*)&as_function_vt;
    f->value = value;
    gc_write_barrier((void*)value);
    return f;
}

static bool as_is_fn_obj(void* obj) {
    if (obj == NULL) return false;
    return ((as_object_header*)obj)->vtable == (void*)&as_function_vt;
}

static as_fn as_fn_obj_val(void* obj) {
    return obj == NULL ? NULL : ((as_function*)obj)->value;
}

// ---------- boxed Boolean (Object slot holding a Boolean) ----------
// Mirrors boxed Number/String/Function: AS3's Boolean is an Object subclass, so
// 'var data:Object = true' stores a Boolean object. Without this box a
// primitive bool stored into an Object* slot would be a raw 0/1 reinterpreted as
// a pointer (dangling, no vtable) — the same bug class that made
// 'properties[property] as Number' return NaN.
typedef struct as_boolean {
    void* vtable;               // &as_boolean_vt (Object subclass)
    bool value;
} as_boolean;

static as_object_vtable as_boolean_vt = { "Boolean", &as_object_vt, NULL, NULL, NULL, NULL, NULL, -1, "Boolean", 0, as_object_box_to_str, as_object_own_has_own_property };

static as_boolean* as_boolean_new(bool value) {
    as_boolean* b = (as_boolean*)gc_alloc(GCT_BOOLEAN, sizeof(as_boolean));
    b->vtable = (void*)&as_boolean_vt;
    b->value = value;
    return b;
}

static bool as_is_bool_obj(void* obj) {
    if (obj == NULL) return false;
    return ((as_object_header*)obj)->vtable == (void*)&as_boolean_vt;
}

static bool as_bool_obj_val(void* obj) {
    return obj == NULL ? false : ((as_boolean*)obj)->value;
}

// Auto-box an as_value into an Object* slot: AS3's primitive-to-Object conversion.
// A primitive (new String/number/boolean) stored into an Object-typed location
// becomes a boxed object, so a later 'obj as Number' / 'obj as String' recovers
// it (and as_obj_to_value unwraps it again). Reading a *dynamic member* that holds
// a primitive ('properties[property]' in Starling's Juggler.tween, where
// properties is a literal like { rotationX: 2*Math.PI }) relies on this: the
// as_value coming back from as_dyn_get carries the primitive tag, not a pointer.
static void* as_value_to_obj(as_value v) {
    switch (v.tag) {
        case 1: return (void*)as_number_new(v.num);
        case 2: return (void*)as_boolean_new(v.num != 0.0);
        case 3: return (void*)as_string_new((char*)v.ptr);
        case 7: return (void*)as_function_new((as_fn)v.ptr);
        case 4: case 6: return v.ptr;   // already an object / array reference
        // A dynamic 64-bit value reaching an Object-typed slot has no exact
        // representation there (Object boxes scalars as Number objects, i.e.
        // doubles), so it degrades to a boxed Number -- the compile-time path
        // refuses this conversion outright; only a runtime dynamic value can get here.
        case 8: return (void*)as_number_new((double)v.i64);
        case 9: return (void*)as_number_new((double)v.u64);
        default: return NULL;           // null (tag 0) or void
    }
}

// Convert an Object* reference to a boxed as_value. The Object root can hold an
// auto-boxed scalar (Number/String) or a wrapped Function, which must round-trip
// to its own tag (1/3/7) rather than the generic object tag (4) so that '==',
// 'typeof' and 'is String'/'is Number'/'is Function' on the downstream as_value
// behave per AS3. Every other object — including NULL — boxes as the ordinary
// object/null value.
static as_value as_obj_to_value(void* obj) {
    if (obj == NULL) return as_v_null();
    if (as_is_number_obj(obj)) return as_v_num(as_number_obj_val(obj));
    if (as_is_bool_obj(obj)) return as_v_bool(as_bool_obj_val(obj));
    if (as_is_string_obj(obj)) return as_v_str(as_string_obj_val(obj));
    if (as_is_fn_obj(obj)) return as_v_fn((void*)as_fn_obj_val(obj));
    // An Array stored in an Object-typed slot is still an Array: box it as tag 6 so
    // ToString/ToNumber/length/== see the array and not a bare object (measured on
    // adl 51.4.1: 'var o:Object = [1,2]' gives 'o == "1,2"' true and '"" + o'
    // "1,2"). Without this the loose-equality array branch never fires for an
    // Object-typed receiver, so the comparison silently answered false.
    if (as_dyn_kind(obj) == 2) return as_v_arr(obj);
    return as_v_obj(obj);
}

// ---------- E4X XML (flash.xml.XML / XMLList) ----------
// Starling's resource pipeline (TextureAtlas/BitmapFont/AssetManager) consumes
// atlas/font XML — well-formed element/attribute/text documents without DTD/
// entity/namespace/CDATA. A hand-written recursive-descent parser builds a DOM
// tree (as_xml_node); the E4X navigation (@attr / .child / .(pred)) is a thin
// layer over that tree. XML and XMLList are Object subclasses (first field is a
// vtable) so is-XML / as-XML reuse the vtable subtype check and
// getQualifiedClassName reads the vtable 'fqn' slot.

typedef struct as_xml_node {
    void* vtable;               // &as_xml_vt (Object subclass)
    char* name;                 // element name (localName); NULL for text nodes
    char* text;                 // trimmed direct text content (NULL when empty)
    char** attr_names;          // GCT_PTR_ARRAY of GCT_STRING names
    char** attr_vals;           // GCT_PTR_ARRAY of GCT_STRING values
    int attr_count;
    struct as_xml_node** children; // GCT_PTR_ARRAY of as_xml_node*
    int child_count;
    // Parent node for XML.parent(). Set once when the child is attached to its
    // parent (the tree is immutable afterwards), so no write barrier is needed
    // on reads. The GC marks it (a live child keeps its ancestors alive).
    struct as_xml_node* parent;
} as_xml_node;

typedef struct as_xml_list {
    void* vtable;               // &as_xml_list_vt
    as_xml_node** items;        // GCT_PTR_ARRAY of as_xml_node*
    int length;
} as_xml_list;

static as_object_vtable as_xml_vt = { "XML", &as_object_vt, NULL, NULL, NULL, NULL, NULL, -1, "XML", 0, as_object_box_to_str, as_object_own_has_own_property };
static as_object_vtable as_xml_list_vt = { "XMLList", &as_object_vt, NULL, NULL, NULL, NULL, NULL, -1, "XMLList", 0, as_object_box_to_str, as_object_own_has_own_property };

static as_xml_node* as_xml_node_new(char* name) {
    as_xml_node* n = (as_xml_node*)gc_alloc(GCT_XML, sizeof(as_xml_node));
    n->vtable = (void*)&as_xml_vt;
    n->name = name;
    return n;
}

static as_xml_list* as_xml_list_new(as_xml_node** items, int length) {
    as_xml_list* l = (as_xml_list*)gc_alloc(GCT_XML_LIST, sizeof(as_xml_list));
    l->vtable = (void*)&as_xml_list_vt;
    l->items = items;
    l->length = length;
    return l;
}

// Growable pointer buffer used by the parser to accumulate children (as_xml_node*)
// and attributes (char*) before the node's final arrays are sized exactly.
typedef struct { void** items; int length; int cap; } as_xml_buf;
static void as_xml_buf_push(as_xml_buf* b, void* p) {
    if (b->length == b->cap) {
        b->cap = b->cap == 0 ? 4 : b->cap * 2;
        void** nb = (void**)gc_alloc(GCT_PTR_ARRAY, sizeof(void*) * (size_t)b->cap);
        if (b->length > 0) memcpy(nb, b->items, sizeof(void*) * (size_t)b->length);
        b->items = nb;
        // Fresh block born BLACK during a cycle: re-grey the copied pointers,
        // otherwise the parser's child/attribute nodes are invisible to the
        // marker and get swept while the (not yet published) node still needs
        // them. See as_array_ensure for the full rationale.
        for (int i = 0; i < b->length; i++) gc_write_barrier(nb[i]);
    }
    b->items[b->length++] = p;
    gc_write_barrier(p);
}

// Parser cursor over the raw XML text.
typedef struct { const char* s; int i; int n; } as_xml_sc;

// Scan an XML name (letters/digits/_/-/./:). Returns a GC string or NULL.
static char* as_xml_sc_name(as_xml_sc* sc) {
    int start = sc->i;
    while (sc->i < sc->n) {
        unsigned char c = (unsigned char)sc->s[sc->i];
        if (isalnum(c) || c == '_' || c == '-' || c == '.' || c == ':') sc->i++;
        else break;
    }
    if (sc->i == start) return NULL;
    char* r = as_str_alloc((size_t)(sc->i - start) + 1);
    memcpy(r, sc->s + start, (size_t)(sc->i - start));
    r[sc->i - start] = 0;
    return r;
}
static void as_xml_sc_ws(as_xml_sc* sc) {
    while (sc->i < sc->n) {
        unsigned char c = (unsigned char)sc->s[sc->i];
        if (c == ' ' || c == '\\t' || c == '\\r' || c == '\\n') sc->i++;
        else break;
    }
}
// Scan a quoted attribute value; returns a GC string or NULL (unterminated).
static char* as_xml_sc_attrval(as_xml_sc* sc) {
    if (sc->i >= sc->n) return NULL;
    char q = sc->s[sc->i];
    if (q != '"' && q != '\\'') return NULL;
    sc->i++;
    int start = sc->i;
    while (sc->i < sc->n && sc->s[sc->i] != q) sc->i++;
    if (sc->i >= sc->n) return NULL;
    char* r = as_str_alloc((size_t)(sc->i - start) + 1);
    memcpy(r, sc->s + start, (size_t)(sc->i - start));
    r[sc->i - start] = 0;
    sc->i++; // closing quote
    return r;
}

// Trim leading/trailing whitespace in place; returns the trimmed start pointer.
static char* as_xml_trim(char* s) {
    if (!s) return NULL;
    while (*s == ' ' || *s == '\\t' || *s == '\\r' || *s == '\\n') s++;
    size_t n = strlen(s);
    while (n > 0 && (s[n-1] == ' ' || s[n-1] == '\\t' || s[n-1] == '\\r' || s[n-1] == '\\n')) n--;
    s[n] = 0;
    return s;
}

static as_xml_node* as_xml_sc_element(as_xml_sc* sc);

// Parse one element (caller has consumed nothing; *sc points at '<').
static as_xml_node* as_xml_sc_element(as_xml_sc* sc) {
    sc->i++; // '<'
    char* name = as_xml_sc_name(sc);
    if (!name) return NULL;
    as_xml_node* node = as_xml_node_new(name);

    // attributes
    as_xml_buf anames = { NULL, 0, 0 };
    as_xml_buf avals = { NULL, 0, 0 };
    for (;;) {
        as_xml_sc_ws(sc);
        int c = sc->i < sc->n ? (unsigned char)sc->s[sc->i] : -1;
        if (c == '>') { sc->i++; break; }
        if (c == '/') {
            if (sc->i + 1 < sc->n && sc->s[sc->i + 1] == '>') { sc->i += 2; node->child_count = 0; node->children = NULL; goto as_xml_done_attrs; }
            return NULL;
        }
        if (c < 0) return NULL;
        char* an = as_xml_sc_name(sc);
        if (!an) return NULL;
        as_xml_sc_ws(sc);
        if (sc->i >= sc->n || sc->s[sc->i] != '=') return NULL;
        sc->i++;
        as_xml_sc_ws(sc);
        char* av = as_xml_sc_attrval(sc);
        if (!av) return NULL;
        as_xml_buf_push(&anames, (void*)an);
        as_xml_buf_push(&avals, (void*)av);
    }

    // children / text until the matching close tag
    as_xml_buf children = { NULL, 0, 0 };
    char* text = NULL;
    size_t textlen = 0;
    for (;;) {
        if (sc->i >= sc->n) return NULL; // unterminated
        if (sc->s[sc->i] == '<') {
            if (sc->i + 1 < sc->n && sc->s[sc->i + 1] == '/') {
                sc->i += 2;
                as_xml_sc_name(sc);
                as_xml_sc_ws(sc);
                if (sc->i < sc->n && sc->s[sc->i] == '>') sc->i++;
                break;
            }
            if (sc->i + 1 < sc->n && sc->s[sc->i + 1] == '?') {
                sc->i += 2;
                while (sc->i + 1 < sc->n && !(sc->s[sc->i] == '?' && sc->s[sc->i + 1] == '>')) sc->i++;
                if (sc->i + 1 < sc->n) sc->i += 2;
                continue;
            }
            if (sc->i + 1 < sc->n && sc->s[sc->i + 1] == '!') {
                // comment / CDATA / DOCTYPE
                if (sc->n - sc->i >= 4 && strncmp(sc->s + sc->i, "<!--", 4) == 0) {
                    sc->i += 4;
                    while (sc->i + 2 < sc->n && !(sc->s[sc->i] == '-' && sc->s[sc->i + 1] == '-' && sc->s[sc->i + 2] == '>')) sc->i++;
                    if (sc->i + 2 < sc->n) sc->i += 3;
                    continue;
                }
                if (sc->n - sc->i >= 9 && strncmp(sc->s + sc->i, "<![CDATA[", 9) == 0) {
                    sc->i += 9;
                    int start = sc->i;
                    while (sc->i + 2 < sc->n && !(sc->s[sc->i] == ']' && sc->s[sc->i + 1] == ']' && sc->s[sc->i + 2] == '>')) sc->i++;
                    int tlen = sc->i - start;
                    if (tlen > 0) {
                        char* merged = as_str_alloc(textlen + (size_t)tlen + 1);
                        if (textlen > 0) memcpy(merged, text, textlen);
                        memcpy(merged + textlen, sc->s + start, (size_t)tlen);
                        merged[textlen + tlen] = 0;
                        text = merged;
                        textlen += (size_t)tlen;
                    }
                    if (sc->i + 2 < sc->n) sc->i += 3;
                    continue;
                }
                // <!DOCTYPE ...> or any <!...> declaration: skip to '>'
                sc->i += 2;
                while (sc->i < sc->n && sc->s[sc->i] != '>') sc->i++;
                if (sc->i < sc->n) sc->i++;
                continue;
            }
            // child element
            as_xml_node* child = as_xml_sc_element(sc);
            if (!child) return NULL;
            as_xml_buf_push(&children, (void*)child);
        } else {
            int start = sc->i;
            while (sc->i < sc->n && sc->s[sc->i] != '<') sc->i++;
            int tlen = sc->i - start;
            if (tlen > 0) {
                char* piece = as_str_alloc((size_t)tlen + 1);
                memcpy(piece, sc->s + start, (size_t)tlen);
                piece[tlen] = 0;
                char* merged = as_str_alloc(textlen + (size_t)tlen + 1);
                if (textlen > 0) memcpy(merged, text, textlen);
                memcpy(merged + textlen, piece, (size_t)tlen);
                merged[textlen + tlen] = 0;
                text = merged;
                textlen += (size_t)tlen;
            }
        }
    }
    // Install children and trimmed text.
    node->child_count = children.length;
    node->children = (as_xml_node**)children.items;
    // Back pointers for XML.parent(): every child (and text node) records its
    // parent. Written with a write barrier because the child may already be
    // reachable (it was pushed into the parent's buffer) and could have been
    // marked black while the new parent is still white.
    for (int i = 0; i < children.length; i++) {
        as_xml_node* c = (as_xml_node*)children.items[i];
        if (c != NULL) {
            c->parent = node;
            gc_write_barrier((void*)node);
        }
    }
    node->text = as_xml_trim(text);
    if (node->text && node->text[0] == 0) node->text = NULL;

as_xml_done_attrs:
    node->attr_count = anames.length;
    node->attr_names = (char**)anames.items;
    node->attr_vals = (char**)avals.items;
    return node;
}

// Parse a complete XML document. Returns the root node, or NULL on malformed
// input (the caller throws an AS3 Error — see emitNew for new XML(...)).
static as_xml_node* as_xml_parse(const char* src, int len) {
    if (!src) return NULL;
    as_xml_sc sc = { src, 0, len };
    as_xml_node* root = NULL;
    while (sc.i < sc.n) {
        if (sc.s[sc.i] == '<') {
            if (sc.i + 1 < sc.n && (sc.s[sc.i + 1] == '?' || sc.s[sc.i + 1] == '!')) {
                // leading XML declaration / DOCTYPE
                if (sc.s[sc.i + 1] == '?') {
                    sc.i += 2;
                    while (sc.i + 1 < sc.n && !(sc.s[sc.i] == '?' && sc.s[sc.i + 1] == '>')) sc.i++;
                    if (sc.i + 1 < sc.n) sc.i += 2;
                } else {
                    sc.i += 2;
                    while (sc.i < sc.n && sc.s[sc.i] != '>') sc.i++;
                    if (sc.i < sc.n) sc.i++;
                }
                continue;
            }
            root = as_xml_sc_element(&sc);
            if (!root) return NULL;
        } else {
            unsigned char c = (unsigned char)sc.s[sc.i];
            if (c == ' ' || c == '\\t' || c == '\\r' || c == '\\n') { sc.i++; continue; }
            return NULL; // stray text before root element
        }
    }
    return root;
}

// ---------- E4X navigation helpers ----------
// The LOCAL part of a node's qualified name ('n:item' -> 'item'). Namespaces are
// transparent in the AOT translation (the parser drops a ns:: qualifier), so the
// child axis must compare LOCAL names -- otherwise a prefixed element ('<n:item>',
// the DAE/COLLADA idiom that motivates the x.ns::[expr] form) never matches any
// lookup and silently yields an empty list. Measured on adl 51.4.1
// (temp/nsbracket/): x.ns::[name] finds <n:item>; on the AIR side this also
// decides localName(), which reports 'item', not 'n:item'. The prefix is kept in
// the stored name so toString() still re-serializes <n:item> verbatim.
static const char* as_xml_local(const char* qname) {
    if (!qname) return qname;
    const char* colon = strrchr(qname, ':');
    return colon ? colon + 1 : qname;
}
static char* as_xml_local_name(as_xml_node* n) { return n ? (char*)as_xml_local(n->name) : NULL; }

// @attr: return the attribute value, or the empty string when absent (E4X's
// undefined attribute stringifies to "", matching AS3's implicit toString).
static char* as_xml_attr(as_xml_node* n, const char* name) {
    if (!n) return "";
    for (int i = 0; i < n->attr_count; i++) {
        if (strcmp(n->attr_names[i], name) == 0) return n->attr_vals[i];
    }
    return "";
}

// .child: all direct children whose LOCAL name matches (empty name = all
// children). The requested name is always a bare local name (a source identifier
// or a computed string), so only the node side is local-ized.
static as_xml_list* as_xml_children(as_xml_node* n, const char* name) {
    if (!n || n->child_count == 0) return as_xml_list_new(NULL, 0);
    as_xml_buf buf = { NULL, 0, 0 };
    for (int i = 0; i < n->child_count; i++) {
        as_xml_node* c = n->children[i];
        if (!c->name) continue;
        if (name == NULL || name[0] == 0 || strcmp(as_xml_local(c->name), name) == 0) as_xml_buf_push(&buf, (void*)c);
    }
    return as_xml_list_new((as_xml_node**)buf.items, buf.length);
}

// Flatten a list's children of a given name across all its nodes (.a.b).
static as_xml_list* as_xml_list_children(as_xml_list* l, const char* name) {
    as_xml_buf buf = { NULL, 0, 0 };
    if (l) {
        for (int i = 0; i < l->length; i++) {
            as_xml_list* sub = as_xml_children(l->items[i], name);
            for (int j = 0; j < sub->length; j++) as_xml_buf_push(&buf, (void*)sub->items[j]);
        }
    }
    return as_xml_list_new((as_xml_node**)buf.items, buf.length);
}

// x..name / x..*: every descendant at any depth, self EXCLUDED (E4X's
// descendant axis). name is the local name to match; NULL or "" matches any
// name. Results are appended in document order (pre-order), which is the order
// E4X reports.
static void as_xml_desc_walk(as_xml_buf* buf, as_xml_node* n, const char* name) {
    if (!n) return;
    for (int i = 0; i < n->child_count; i++) {
        as_xml_node* c = n->children[i];
        if (c->name && (name == NULL || name[0] == 0 || strcmp(as_xml_local(c->name), name) == 0)) as_xml_buf_push(buf, (void*)c);
        as_xml_desc_walk(buf, c, name);
    }
}
static as_xml_list* as_xml_descendants(as_xml_node* n, const char* name) {
    as_xml_buf buf = { NULL, 0, 0 };
    as_xml_desc_walk(&buf, n, name);
    return as_xml_list_new((as_xml_node**)buf.items, buf.length);
}
// list..name: flatten the descendant axis across every node in the list.
static as_xml_list* as_xml_list_descendants(as_xml_list* l, const char* name) {
    as_xml_buf buf = { NULL, 0, 0 };
    if (l) for (int i = 0; i < l->length; i++) as_xml_desc_walk(&buf, l->items[i], name);
    return as_xml_list_new((as_xml_node**)buf.items, buf.length);
}

// @attr on a list: the attribute of the first matching item (E4X list.@attr
// returns an XMLList, but Starling only reads it in a scalar String context).
static char* as_xml_list_attr(as_xml_list* l, const char* name) {
    if (!l) return "";
    for (int i = 0; i < l->length; i++) {
        char* v = as_xml_attr(l->items[i], name);
        if (v[0] != 0) return v;
    }
    return "";
}

// .( @attr == value ): keep the items whose named attribute equals the given
// string (neq=1 inverts to !=). Starling uses this only as @attr == "str".
static as_xml_list* as_xml_filter(as_xml_list* l, const char* attr, const char* value, int neq) {
    as_xml_buf buf = { NULL, 0, 0 };
    if (l) {
        for (int i = 0; i < l->length; i++) {
            const char* av = as_xml_attr(l->items[i], attr);
            int cmp = strcmp(av, value);
            if (neq ? (cmp != 0) : (cmp == 0)) as_xml_buf_push(&buf, (void*)l->items[i]);
        }
    }
    return as_xml_list_new((as_xml_node**)buf.items, buf.length);
}

// flash.utils.describeType(value:*):XML — build a minimal <type name="fqn"/> DOM
// tree describing a Class reference. Starling's AssetManager reads typeXml.@name
// plus constant/variable nodes of type "Class"; the demo enqueues File values
// (never Class), so those child lists stay empty — only @name is structurally
// needed there. The tree is a real as_xml_node, so @name / .child / .(pred) all
// operate on it exactly as on parsed XML.
static as_xml_node* as_describe_type(as_class* cls) {
    const char* fqn = "Object";
    if (cls && cls->vtable) {
        const char* f = ((as_vtable_header*)cls->vtable)->fqn;
        if (f) fqn = f;
    }
    as_xml_node* n = as_xml_node_new((char*)"type");
    as_xml_buf anames = { NULL, 0, 0 };
    as_xml_buf avals = { NULL, 0, 0 };
    as_xml_buf_push(&anames, (void*)"name");
    as_xml_buf_push(&avals, (void*)(char*)fqn);
    n->attr_count = anames.length;
    n->attr_names = (char**)anames.items;
    n->attr_vals = (char**)avals.items;
    return n;
}

// Serialize an element back to XML text (best-effort, for toString()).
// Grow a char* buffer in place (reallocating via as_str_alloc when full) and
// append a length-delimited chunk. Used by the serializer below; a plain helper
// avoids a function-like macro, whose line-continuation backslashes would be
// mangled by the JS template-string layer that holds this preamble.
static void as_xml_append(char** outp, size_t* lenp, size_t* capp, const char* chunk, size_t sz) {
    char* out = *outp;
    size_t len = *lenp;
    size_t cap = *capp;
    if (len + sz + 1 > cap) {
        while (len + sz + 1 > cap) cap *= 2;
        char* nb = as_str_alloc(cap);
        memcpy(nb, out, len);
        nb[len] = 0;
        out = nb;
    }
    memcpy(out + len, chunk, sz);
    len += sz;
    out[len] = 0;
    *outp = out;
    *lenp = len;
    *capp = cap;
}

static char* as_xml_to_string(as_xml_node* n) {
    if (!n) return "";
    if (!n->name) return n->text ? n->text : "";
    // <name attr="v" ...>...</name>
    size_t cap = 64;
    char* out = as_str_alloc(cap);
    size_t len = 0;
    char q[2]; q[0] = '"'; q[1] = 0;
    char eq[2]; eq[0] = '='; eq[1] = 0;
    as_xml_append(&out, &len, &cap, "<", 1);
    as_xml_append(&out, &len, &cap, n->name, strlen(n->name));
    for (int i = 0; i < n->attr_count; i++) {
        as_xml_append(&out, &len, &cap, " ", 1);
        as_xml_append(&out, &len, &cap, n->attr_names[i], strlen(n->attr_names[i]));
        as_xml_append(&out, &len, &cap, eq, 1);
        as_xml_append(&out, &len, &cap, q, 1);
        as_xml_append(&out, &len, &cap, n->attr_vals[i], strlen(n->attr_vals[i]));
        as_xml_append(&out, &len, &cap, q, 1);
    }
    if (n->child_count == 0 && !n->text) {
        as_xml_append(&out, &len, &cap, "/>", 2);
        return out;
    }
    as_xml_append(&out, &len, &cap, ">", 1);
    for (int i = 0; i < n->child_count; i++) {
        char* cs = as_xml_to_string(n->children[i]);
        as_xml_append(&out, &len, &cap, cs, strlen(cs));
    }
    if (n->text) as_xml_append(&out, &len, &cap, n->text, strlen(n->text));
    as_xml_append(&out, &len, &cap, "</", 2);
    as_xml_append(&out, &len, &cap, n->name, strlen(n->name));
    as_xml_append(&out, &len, &cap, ">", 1);
    return out;
}

// Serialize a list to text by concatenating each node's serialization.
static char* as_xml_list_to_string(as_xml_list* l) {
    if (!l || l->length == 0) return "";
    char* out = (char*)"";
    for (int i = 0; i < l->length; i++) out = as_str_concat(out, as_xml_to_string(l->items[i]));
    return out;
}

typedef struct as_object_s {
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
        // The 64-bit enhancement tags report "number" like every other numeric
        // value (typeof has no 64-bit spelling in AIR, where the values cannot
        // exist at all, so portable code cannot observe the difference).
        case 8: case 9: return "number";
        case 2: return "boolean";
        case 3: return "string";
        // A Function value sitting in an Object-typed slot is autoboxed into an
        // as_function (as_value_to_obj), so its dynamic type is still "function"
        // -- AS3 reports typeof(f) == "function" for every function value.
        case 4: return (v.ptr != NULL && ((as_object_header*)v.ptr)->vtable == (void*)&as_function_vt)
                       ? "function" : "object";
        case 6: return "object";
        case 7: return "function";
        case 0: return "object"; // AS3: typeof null == "object" (ES3 quirk)
        default: return "undefined";
    }
}

// typeof for a value held in an Object/interface slot: the slot only knows the
// *static* type, but AS3's typeof inspects the *dynamic* one. Primitives and
// Function values stored in such a slot are autoboxed (as_value_to_obj), so
// they must map back to their primitive names instead of the generic "object".
static char* as_ptr_typeof(void* p) {
    if (p == NULL) return "object";
    void* vt = ((as_object_header*)p)->vtable;
    if (vt == (void*)&as_number_vt)   return "number";
    if (vt == (void*)&as_boolean_vt)  return "boolean";
    if (vt == (void*)&as_string_vt)   return "string";
    if (vt == (void*)&as_function_vt) return "function";
    return "object";
}

// flash.utils.getQualifiedClassName(value:*):String — AS3 fully-qualified class
// name ("包::类", e.g. "starling.display::DisplayObject"). Primitives map to the
// canonical name strings; object instances and Class references both carry the
// class vtable as their first field (as_object_header / as_class), so both read
// the vtable's 'fqn' slot. NOTE: int/uint are boxed as number (tag 1) by boxExpr,
// so getQualifiedClassName(5) yields "Number" rather than "int" — a documented
// precision limit (Starling never reflects primitives, so it is moot there).
// Heap kind of a boxed pointer (a GCT_* tag), or -1 when the pointer is not a
// GC object body at all (a static vtable / class descriptor / literal). Box-value
// reflection must ask this before reading a vtable slot: an Array and a Vector
// (GCT_ARRAY / GCT_CUSTOM) start with their data pointer and a Dictionary
// (GCT_DICT) with its key buffer, so an unconditional
// ((as_object_header*)p)->vtable dereferences a data pointer as a vtable and
// crashes (measured: getQualifiedClassName(new Vector.<int>()) segfaulted).
// Everything else -- a record, a class instance, a boxed primitive, and the
// statically allocated as_class of a Class value -- does carry a vtable first.
static int as_heap_kind(void* p) {
    if (p == NULL || !gc_in_heap(p)) return -1;
    return gc_hdr(p)->type;
}
// Vector.<T> reflection names. A Vector is a monomorphized C struct, NOT a modeled
// class: it has no vtable, it is allocated as GCT_CUSTOM, and its FIRST word is its
// per-specialization mark callback -- which makes that pointer a unique identity
// the emitted code can switch on (as_amf_vec_impl already relies on it). The
// emitted as_vec_fqn_wire() installs these hooks. Measured on adl 51.4.1
// (temp/a5probe/): every specialization answers "__AS3__.vec::Vector.<element>",
// but the superclass differs by element kind -- a NUMERIC element type
// (int/uint/Number) extends Object, while every reference element type
// (String/Boolean/Object/Array/class/interface/XML/Date) extends
// "__AS3__.vec::Vector.<*>". Nested vectors are named recursively:
// Vector.<Vector.<int>> is "__AS3__.vec::Vector.<__AS3__.vec::Vector.<int>>".
static const char* (*as_vec_fqn_hook)(void* ptr) = NULL;
static const char* (*as_vec_super_fqn_hook)(void* ptr) = NULL;
static char* as_get_qualified_class_name(as_value v) {
    switch (v.tag) {
        case 0: return "null";
        case 1: return "Number";   // int/uint box into number (see note above)
        case 2: return "Boolean";
        case 3: return "String";
        case 5: return "void";     // undefined
        case 6: return "Array";
        case 7: return "Function";
        case 4: {
            if (v.ptr == NULL) return "null";
            int kind = as_heap_kind(v.ptr);
            if (kind == GCT_CUSTOM) {
                // A recognized Vector specialization answers its own name; any other
                // unmodeled GCT_CUSTOM object keeps the generic "Array" answer.
                if (as_vec_fqn_hook != NULL) { const char* n = as_vec_fqn_hook(v.ptr); if (n != NULL) return (char*)n; }
                return "Array";
            }
            if (kind == GCT_ARRAY) return "Array";
            if (kind == GCT_DICT) return "Object";   // Dictionary is a C kind, not a modeled class
            void* vt = ((as_object_header*)v.ptr)->vtable;
            return (char*)(vt ? ((as_vtable_header*)vt)->fqn : "Object");
        }
        default: return "Object";
    }
}

// flash.utils.getQualifiedSuperclassName(value:*):String — the qualified name of
// the value's superclass, or NULL (AS3 null) when there is none. Measured against
// adl 51.4.1 (temp/qscnprobe/): the Object class, an instance of it, or a plain
// {} record — gives null, so does an interface and so do null/undefined;
// every boxed primitive (int/Number/String/Boolean/Array/Function/Vector) gives
// "Object"; a user class gives its superclass's fqn (SubSub -> Sub -> Base ->
// Object -> null). A Class value is boxed with the class vtable as its first
// field, so it resolves through that same class: getQualifiedSuperclassName(Sub)
// is "Base", and getQualifiedSuperclassName(Object) is null. The boxed-primitive
// vtables chain to as_object_vt (super = Object), so they fall out of the generic
// one-step walk below.
static char* as_get_qualified_superclass_name(as_value v) {
    switch (v.tag) {
        case 0:  // null
        case 5:  // undefined
            return NULL;
        case 1: case 2: case 3: case 6: case 7:
            // The primitive / Array / Function classes all extend Object in AIR.
            return (char*)"Object";
        case 4: {
            if (v.ptr == NULL) return NULL;
            int kind = as_heap_kind(v.ptr);
            if (kind == GCT_CUSTOM) {
                // A Vector specialization knows its own superclass; other GCT_CUSTOM
                // objects keep the generic Object answer.
                if (as_vec_super_fqn_hook != NULL) { const char* n = as_vec_super_fqn_hook(v.ptr); if (n != NULL) return (char*)n; }
                return (char*)"Object";
            }
            if (kind == GCT_ARRAY) return (char*)"Object";
            if (kind == GCT_DICT) return (char*)"Object";
            void* vt = ((as_object_header*)v.ptr)->vtable;
            if (vt == NULL) return NULL;
            void* sup = ((as_vtable_header*)vt)->super;
            if (sup == NULL) return NULL;   // Object itself (and a plain record)
            return (char*)((as_vtable_header*)sup)->fqn;   // NULL for an interface
        }
        default: return NULL;
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
        // Both blocks are born BLACK during a cycle (allocation barrier): re-grey
        // the copied keys/values so properties reachable only through the new
        // parallel arrays are not swept while still referenced.
        for (int i = 0; i < o->length; i++) { gc_write_barrier((void*)nk[i]); gc_write_barrier_value(nv[i]); }
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

// ---------- E4X member helpers used by the emitter ----------
// XML.name() returns a QName in AIR. Our XML model keeps only the element's name
// string (prefix included), so the QName is a plain record carrying the parts the
// AS3 code actually reads: localName and uri. A node without a name (a text node)
// yields empty strings instead of throwing. Defined here, after as_object_set, so
// the record helpers are already declared.
static as_value as_xml_qname(as_xml_node* n) {
    as_object* q = as_object_new();
    const char* ln = (n != NULL && n->name != NULL) ? as_xml_local(n->name) : "";
    as_object_set(q, "localName", as_v_str((char*)ln));
    as_object_set(q, "uri", as_v_str((char*)""));
    return as_v_obj((void*)q);
}
// XML.parent(): the parent node, or NULL at the root (AIR returns undefined;
// the emitter's null-safe member guard turns NULL into the usual #1009 only when
// a member is read off it, which matches AIR's 'cannot access property of null').
static as_xml_node* as_xml_parent(as_xml_node* n) { return n != NULL ? n->parent : NULL; }

// ---------- dynamic property access (obj[key] reflection) ----------
// AS3's root Object is dynamic: obj[key] on an Object-typed value may be a
// record slot lookup OR a reflectable field of a real class instance. as_dyn_get
// walks the vtable's super chain looking for a field named 'key'; when none is
// found and the object is a dynamic record (as_object_vt), it falls back to the
// record's string-keyed slot table. Used by obj[key] where the receiver's static
// type is 'Object'.
//
// Error #1056 / #1069 are raised for SEALED class instances. Their messages are
// built by helpers emitted later in the file (they construct Error objects, whose
// class definitions follow this preamble), so they are prototyped here. AIR's text:
//   "Error #1056: Cannot create property <key> on <qualified class>."
//   "Error #1069: Property <key> not found on <qualified class> and there is no default value."
static void as_throw_sealed_set(const char* key, const char* fqn);
static as_value as_throw_sealed_get(const char* key, const char* fqn);
// The loud "not supported by this subset" failure (an Error with id 0). It builds
// an Error object, so like the two above it is defined after the Error class
// hierarchy and only prototyped here.
static void as_throw_unsupported(const char* msg);
// Runtime type coercion for a boxed value landing in a statically-typed reference
// slot (dynamic call argument, apply/call argument, reflection setter). AS3 throws
// TypeError #1034 when the value's class is incompatible -- silently reinterpreting
// the boxed payload as a pointer would be a wild read, not a translation. Defined
// with the other Error-constructing helpers (emitSealedPropErrors).
static void* as_v_req_inst(as_value v, void* target_vt, const char* fqn);
static void* as_v_req_array(as_value v, const char* fqn);
// Dictionary helpers, defined after the dynamic accessors that now dispatch to
// them (see as_dyn_kind).
static as_value as_dict_get(as_dict* d, as_value key);
static as_value as_dict_set(as_dict* d, as_value key, as_value v);
static int as_dict_find(as_dict* d, as_value key);
static bool as_dict_del(as_dict* d, as_value key);

// Named-property helpers for an Array/Vector reached through an 'any'-typed
// receiver (defined with as_any_get/as_any_set below).
static as_value as_array_prop_get(as_array* a, const char* key);
static void as_array_prop_set(as_array* a, const char* key, as_value v);
static bool as_array_has(as_array* a, const char* key);
static void as_array_key_set(as_array* a, const char* key, as_value v);
static as_value as_array_del(as_array* a, const char* key);

// A Dictionary or an Array can reach the dynamic accessors through an 'any'-typed
// receiver ('var d:* = new Dictionary(); d["k"] = 1'), and neither carries a
// vtable as its first word: a Dictionary starts with its key buffer and an Array
// with its element data. Dereferencing those as a vtable crashed (measured: a
// Dictionary assigned through a '*' variable segfaulted in as_dyn_set).
// as_heap_kind tells them apart from real class instances. A GCT_CUSTOM body is a
// monomorphized Vector.<T> (mark/data/length/capacity), which is NOT an as_array
// and is not dynamic at all, so it gets its own code.
static int as_dyn_kind(void* obj) {
    int k = as_heap_kind(obj);
    if (k == GCT_DICT) return 1;
    if (k == GCT_ARRAY) return 2;
    if (k == GCT_CUSTOM) return 3;
    return 0;
}

// A Vector index key that also accepts a NEGATIVE value, so it can be
// range-checked and rejected with the #1125 adl raises (as_array_index_key
// rejects '-1' as a non-index, which would read back null instead).
//
// It recognizes exactly the strings AIR's Vector treats as an index attempt
// (measured on adl 51.4.1, temp/strkeyprobe): '1' and the non-canonical '01' are
// indices, and '-1'/'1.5'/'4294967295' are ALSO recognized as numbers and then
// rejected by the element accessor's range check, while '+2'/' 2'/'foo' are
// property misses (#1069/#1056). A non-integral or past-int value is therefore
// reported as the invalid index -1 instead of as "not a key".
static bool as_vec_index_key(const char* key, int* out) {
    if (key == NULL || key[0] == '\\0') return false;
    const char* p = key;
    if (*p == '-') p++;
    if (*p == '\\0') return false;
    bool digits = false, dot = false;
    for (; *p; p++) {
        if (*p >= '0' && *p <= '9') { digits = true; continue; }
        if (*p == '.' && !dot && digits) { dot = true; continue; }
        return false;
    }
    if (!digits) return false;
    double d = atof(key);
    if (d != (double)(long long)d || d > 2147483647.0 || d < -2147483648.0) { *out = -1; return true; }
    *out = (int)d;
    return true;
}

// 'key in vec'. One rule for both the statically-typed and the dynamically-typed
// receiver, parameterised by the length so neither needs the Vector body layout:
// true for 'length' and 'fixed' (the two named members a Vector has), and for a
// canonical index inside [0, length). Measured on adl 51.4.1 (temp/pkg1/oracle/
// adl-vd.txt): "length" true, "0" true on a length-2 vector, "5" false,
// "-1" false, "1.5" false, "x" false -- identical for a '*' receiver.
static bool as_vec_has_len(const char* key, int len) {
    if (strcmp(key, "length") == 0) return true;
    if (strcmp(key, "fixed") == 0) return true;
    int i = 0;
    if (!as_vec_index_key(key, &i)) return false;
    return i >= 0 && i < len;
}

// 'v is Vector.<T>' / 'v as Vector.<T>' on a dynamically-typed receiver: recover
// the element type from the vector's reflect name (the codegen-installed hook) and
// compare EXACTLY. AIR is strict here -- a Vector.<int> is NOT a Vector.<Number>
// nor a Vector.<uint>, and it is NOT a Vector.<*> (measured on adl 51.4.1,
// temp/pkg1/oracle/adl-v2.txt: isStar=false, isInt=true, isNum=false,
// isUint=false, isObj=false, asStar=NULL). A non-Vector or an absent hook is
// false/null.
static bool as_vec_is_name(as_value v, const char* name) {
    if (v.tag != 4 || v.ptr == NULL || as_dyn_kind(v.ptr) != 3) return false;
    if (as_vec_fqn_hook == NULL) return false;
    const char* n = as_vec_fqn_hook(v.ptr);
    return n != NULL && strcmp(n, name) == 0;
}
// 'v as Vector.<T>': the pointer when the element type matches exactly, else NULL
// -- one helper so the receiver expression is evaluated only once.
static void* as_v_as_vec_named(as_value v, const char* name) {
    return as_vec_is_name(v, name) ? v.ptr : NULL;
}
static as_value as_dyn_get(void* obj, const char* key) {
    if (obj == NULL) return as_v_null();
    int dk = as_dyn_kind(obj);
    if (dk == 1) return as_dict_get((as_dict*)obj, as_v_str((char*)key));
    if (dk == 2) return as_array_prop_get((as_array*)obj, key);
    if (dk == 3) return as_vec_get_hook != NULL ? as_vec_get_hook(obj, key) : as_v_null();
    // 'constructor' is Object's own instance trait, not a reflected field: every
    // object answers it with its Class reference (AIR: 'var o:* = new Foo();
    // o.constructor === Foo' -> true). Handled here, after the dict/array/vector
    // dispatch, because those heap kinds start with a data pointer rather than a
    // vtable -- as_v_class_of() must only see real as_object_header layouts.
    if (strcmp(key, "constructor") == 0) return as_v_class_of(as_v_obj(obj));
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
                        // Reference kinds 10/11/12 (Array / class instance /
                        // Object slot) read exactly like 6: the slot is already a
                        // pointer; only the WRITE side type-checks.
                        case 10: case 11: case 12: return as_v_obj(*(void**)(base + props[i].offset));
                        case 7: return *(as_value*)(base + props[i].offset);
                        // 64-bit enhancement fields (our own tags 8/9 in the prop
                        // table): the struct slot is a plain int64_t/uint64_t, so
                        // the boxed value carries the exact width.
                        case 8: return as_v_i64(*(int64_t*)(base + props[i].offset));
                        case 9: return as_v_u64(*(uint64_t*)(base + props[i].offset));
                    }
                    return as_v_null();
                }
            }
        }
        vt = ((as_vtable_header*)vt)->super;
    }
    // Getter reflection: dynamic obj["prop"] reaches read-only properties
    // (File.exists / File.isDirectory / File.isHidden / File.url) that are not
    // declared fields. The getter thunk shares the as_method signature and boxes
    // its typed return value.
    vt = ((as_object_header*)obj)->vtable;
    while (vt != NULL) {
        as_method* getters = (as_method*)((as_vtable_header*)vt)->getters;
        if (getters != NULL) {
            for (int i = 0; getters[i].name != NULL; i++) {
                if (strcmp(getters[i].name, key) == 0) return getters[i].fn(obj, NULL, 0);
            }
        }
        vt = ((as_vtable_header*)vt)->super;
    }
    // Method reflection: dynamic obj["method"] used as a Function value (e.g.
    // asset["getDirectoryListing"]()) returns a bound-method closure whose env is
    // the receiver, so as_fn_call_dyn invokes the real implementation.
    vt = ((as_object_header*)obj)->vtable;
    while (vt != NULL) {
        as_method* methods = (as_method*)((as_vtable_header*)vt)->methods;
        if (methods != NULL) {
            for (int i = 0; methods[i].name != NULL; i++) {
                if (strcmp(methods[i].name, key) == 0) return as_v_fn(as_fn_make(methods[i].fn, obj, -1));
            }
        }
        vt = ((as_vtable_header*)vt)->super;
    }
    as_vtable_header* hv = (as_vtable_header*)((as_object_header*)obj)->vtable;
    // Proxy receiver: a name that is not a real trait is served by getProperty
    // (the '_dyn' slot table is NOT consulted — AIR replaces it, measured).
    if (hv->is_proxy) return as_proxy_get_miss(obj, key);
    if (hv == (as_vtable_header*)&as_object_vt) {
        return as_object_get((as_object*)obj, key);
    }
    // Dynamic class instance: undeclared keys live in the _dyn slot table; its
    // byte offset within the struct is recorded in the vtable (dyn_offset >= 0).
    if (hv->dyn_offset >= 0) {
        as_object* dyn = *(as_object**)((char*)obj + hv->dyn_offset);
        return dyn == NULL ? as_v_null() : as_object_get(dyn, key);
    }
    // A real trait did not match, so the ByteArray index form gets its chance
    // before the class is declared sealed (its own property table was walked
    // above, so b["length"] still reads the accessor).
    if (as_ba_is_hook != NULL && as_ba_is_hook(obj)) return as_ba_get_key_hook(obj, key);
    // Sealed class instance: the property does not exist and AS3 has no default
    // value for it, so the read is a runtime error (ReferenceError #1069) — not a
    // silent null/undefined. (Only a *dynamic* receiver falls through to the
    // slot table above; Object records were handled even earlier.)
    return as_throw_sealed_get(key, hv->fqn);
}

// 'key in obj' membership test for class instances (sealed or dynamic), used by
// the 'in' operator when the right operand is statically a class/interface
// reference. Walks fields, getters, and methods across the super chain; a plain
// record (Object) checks its slot table; dynamic classes check their _dyn table.
static bool as_dyn_has(void* obj, const char* key) {
    if (obj == NULL) return false;
    int dk = as_dyn_kind(obj);
    // Vector.<T>: 'key in vec' is true for 'length'/'fixed' and for an in-range
    // canonical index; every other name is false. AIR agrees (measured on adl
    // 51.4.1, temp/pkg1/oracle/adl-vd.txt: "length" true, "0" true, "5" false,
    // "-1"/"1.5"/"x" false). The element type is irrelevant to the answer.
    if (dk == 3) return as_vec_has_hook != NULL && as_vec_has_hook(obj, key);
    if (dk == 1) return as_dict_find((as_dict*)obj, as_v_str((char*)key)) >= 0;
    if (dk == 2) return as_array_has((as_array*)obj, key);
    void* vt = ((as_object_header*)obj)->vtable;
    while (vt != NULL) {
        as_prop* props = (as_prop*)((as_vtable_header*)vt)->props;
        if (props != NULL)
            for (int i = 0; props[i].name != NULL; i++)
                if (strcmp(props[i].name, key) == 0) return true;
        as_method* getters = (as_method*)((as_vtable_header*)vt)->getters;
        if (getters != NULL)
            for (int i = 0; getters[i].name != NULL; i++)
                if (strcmp(getters[i].name, key) == 0) return true;
        as_method* methods = (as_method*)((as_vtable_header*)vt)->methods;
        if (methods != NULL)
            for (int i = 0; methods[i].name != NULL; i++)
                if (strcmp(methods[i].name, key) == 0) return true;
        // Setter-only accessors are traits too (hasOwnProperty must see them).
        as_method* setters = (as_method*)((as_vtable_header*)vt)->setters;
        if (setters != NULL)
            for (int i = 0; setters[i].name != NULL; i++)
                if (strcmp(setters[i].name, key) == 0) return true;
        vt = ((as_vtable_header*)vt)->super;
    }
    as_vtable_header* hv = (as_vtable_header*)((as_object_header*)obj)->vtable;
    // Proxy receiver: membership goes through hasProperty (not the '_dyn' table).
    if (hv->is_proxy) return as_proxy_has_miss(obj, key);
    if (hv == (as_vtable_header*)&as_object_vt) return as_object_has((as_object*)obj, key);
    if (hv->dyn_offset >= 0) {
        as_object* dyn = *(as_object**)((char*)obj + hv->dyn_offset);
        return dyn != NULL && as_object_has(dyn, key);
    }
    // ByteArray: a canonical index is present while it is inside the buffer
    // ("0" in b is true, "9" in b on a 3-byte buffer is false -- measured), and a
    // non-index key is simply absent.
    if (as_ba_is_hook != NULL && as_ba_is_hook(obj)) return as_ba_has_key_hook(obj, key);
    return false;
}

// Value-returning form of as_dyn_set: AS3's assignment EXPRESSION evaluates to the
// assigned value (a.b = c.d = 5), so a writer used as a value must not be void.
// Distinct from as_dyn_set so the statement path keeps the plain void helper.
static void as_dyn_set(void* obj, const char* key, as_value v);
static as_value as_dyn_set_v(void* obj, const char* key, as_value v) { as_dyn_set(obj, key, v); return v; }

static void as_dyn_set(void* obj, const char* key, as_value v) {
    if (obj == NULL) return;
    int dk = as_dyn_kind(obj);
    if (dk == 1) { as_dict_set((as_dict*)obj, as_v_str((char*)key), v); return; }
    if (dk == 2) { as_array_key_set((as_array*)obj, key, v); return; }
    if (dk == 3) { if (as_vec_set_hook != NULL) as_vec_set_hook(obj, key, v); return; }
    void* vt = ((as_object_header*)obj)->vtable;
    while (vt != NULL) {
        as_prop* props = (as_prop*)((as_vtable_header*)vt)->props;
        if (props != NULL) {
            for (int i = 0; props[i].name != NULL; i++) {
                if (strcmp(props[i].name, key) == 0) {
                    char* base = (char*)obj;
                    switch (props[i].type) {
                        // A dynamic write into a TYPED field is an AS3 coercion,
                        // not a reinterpretation: a String source parses for the
                        // numeric/bool slots and stringifies for the char* slot
                        // (the raw unboxers read .num, which is 0 for a String
                        // tag -- adl 51.4.1, temp/pkgA/coerce2.body.as:
                        // dyn.tabIndex = "7" stores 7).
                        case 1: *(double*)(base + props[i].offset) = as_v_to_number(v); return;
                        case 2: *(bool*)(base + props[i].offset) = as_v_truthy(v); return;
                        case 3: *(char**)(base + props[i].offset) = as_coerce_str(v); gc_write_barrier((void*)*(char**)(base + props[i].offset)); return;
                        case 4: *(int*)(base + props[i].offset) = as_v_to_int(v); return;
                        case 5: *(unsigned*)(base + props[i].offset) = as_v_to_uint(v); return;
                        case 6: *(void**)(base + props[i].offset) = as_v_obj_val(v); gc_write_barrier(*(void**)(base + props[i].offset)); return;
                        // Reference kinds whose static type is known: a dynamic
                        // write is a runtime COERCION in AIR, not a
                        // reinterpretation (adl 51.4.1, temp/pkgA/dyn.body.as).
                        // The old blind as_v_obj_val() store put
                        // the boxed value's union word (for a Number, its 'num'
                        // double) into the pointer slot -- a wild pointer that
                        // later reads and gc_scan would walk.
                        case 10: { void* p = as_v_req_array(v, "Array"); *(void**)(base + props[i].offset) = p; gc_write_barrier(p); return; }
                        case 11: { void* p = as_v_req_inst(v, props[i].vt, props[i].fqn); *(void**)(base + props[i].offset) = p; gc_write_barrier(p); return; }
                        case 12: { void* p = as_value_to_obj(v); *(void**)(base + props[i].offset) = p; gc_write_barrier(p); return; }
                        case 7: *(as_value*)(base + props[i].offset) = v; gc_write_barrier_value(v); return;
                        // 64-bit enhancement fields: the incoming boxed value
                        // COERCES (a String parses, a Number truncates) and no
                        // write barrier is needed -- an int64 field holds no
                        // pointer.
                        case 8: *(int64_t*)(base + props[i].offset) = as_v_to_i64(v); return;
                        case 9: *(uint64_t*)(base + props[i].offset) = as_v_to_u64(v); return;
                    }
                    return;
                }
            }
        }
        vt = ((as_vtable_header*)vt)->super;
    }
    // Setter reflection: a dynamic write (obj[key] = v) must reach accessors, not
    // just fields. Starling's Juggler tweens accessor-backed properties
    // (DisplayObject.alpha/x/y/scaleX, Sprite3D.rotationX...) through an
    // Object-typed target, so without this branch every such tween silently did
    // nothing. A getter without a setter stays read-only, as in AS3.
    vt = ((as_object_header*)obj)->vtable;
    while (vt != NULL) {
        as_method* setters = (as_method*)((as_vtable_header*)vt)->setters;
        if (setters != NULL) {
            for (int i = 0; setters[i].name != NULL; i++) {
                if (strcmp(setters[i].name, key) == 0) { setters[i].fn(obj, &v, 1); return; }
            }
        }
        vt = ((as_vtable_header*)vt)->super;
    }
    as_vtable_header* hv = (as_vtable_header*)((as_object_header*)obj)->vtable;
    // Proxy receiver: a write that is not a real field/setter is served by
    // setProperty (AIR never lands it in the '_dyn' slot table, measured).
    if (hv->is_proxy) { as_proxy_set_miss(obj, key, v); return; }
    if (hv == (as_vtable_header*)&as_object_vt) {
        as_object_set((as_object*)obj, key, v);
        return;
    }
    if (hv->dyn_offset >= 0) {
        as_object* dyn = *(as_object**)((char*)obj + hv->dyn_offset);
        if (dyn != NULL) as_object_set(dyn, key, v);
        return;
    }
    // The ByteArray index form again: a canonical index extends the buffer
    // (zero-filling the gap), and the hook raises #1056 for anything else, so a
    // non-index key still reports the sealed-class error.
    if (as_ba_is_hook != NULL && as_ba_is_hook(obj)) { as_ba_set_key_hook(obj, key, v); return; }
    // Sealed class instance: creating a new property is a runtime error in AS3
    // (ReferenceError #1056). Previously this was a silent no-op, so
    // d.unknown = 5 on a sealed instance quietly discarded the write.
    as_throw_sealed_set(key, hv->fqn);
}

// AS3 'delete obj[key]' on a class instance. A Proxy intercepts via
// deleteProperty (#2092 when not overridden); a dynamic class removes the '_dyn'
// slot; anything else has no deletable property and reports false, since AS3 can
// only delete dynamic properties.
static bool as_dyn_del(void* obj, const char* key) {
    if (obj == NULL) return false;
    int dk = as_dyn_kind(obj);
    if (dk == 3) return true;                             // Vector.<T>: 'delete' is a no-op reporting true
    if (dk == 1) return as_dict_del((as_dict*)obj, as_v_str((char*)key));
    if (dk == 2) return as_v_bool_val(as_array_del((as_array*)obj, key));
    as_vtable_header* hv = (as_vtable_header*)((as_object_header*)obj)->vtable;
    if (hv->is_proxy) return as_proxy_del_miss(obj, key);
    // A plain Object record is its own slot table (mirrors as_dyn_get/set/has).
    if (hv == (as_vtable_header*)&as_object_vt) return as_object_del((as_object*)obj, key);
    if (hv->dyn_offset >= 0) {
        as_object* dyn = *(as_object**)((char*)obj + hv->dyn_offset);
        return dyn != NULL && as_object_del(dyn, key);
    }
    return false;
}


// Named (non-index) property access on an Array. AIR's Array is dynamic, so
// a.bar = 8 stores an ordinary named property beside the elements; the table is
// allocated lazily, since the vast majority of arrays never carry one.
static as_value as_array_prop_get(as_array* a, const char* key) {
    return (a == NULL || a->props == NULL) ? as_v_null() : as_object_get(a->props, key);
}
static void as_array_prop_set(as_array* a, const char* key, as_value v) {
    if (a == NULL) return;
    if (a->props == NULL) a->props = as_object_new();
    as_object_set(a->props, key, v);
    gc_write_barrier((void*)a->props);
}

// a.length = n / a["length"] = n: AIR gives an Array's length real resize
// semantics -- growth fills the new slots with undefined, shrinkage truncates,
// and named properties survive either way (measured on adl 51.4.1,
// temp/strkeyprobe). The value is converted with UINT semantics by the caller,
// so a.length = -1 means 4294967295 in AIR; that is past INT_MAX and therefore
// beyond this runtime's int length field, so it fails loudly instead of wrapping
// into a negative size (TODO.md 遗留).
static void as_array_set_length(as_array* a, unsigned int n) {
    if (a == NULL) return;
    if (n > 2147483647u) {
        as_throw_unsupported("Array.length above 2147483647 is not supported by this subset");
        return;
    }
    int m = (int)n;
    if (m <= a->length) { a->length = m; return; }
    as_array_ensure(a, m);
    for (int i = a->length; i < m; i++) { as_value u = {5, 0.0, NULL}; a->data[i] = u; }
    a->length = m;
}

// a[key] where the key is statically a String. AIR's Array is dynamic, so a
// CANONICAL index string is an element access, "length" is the length property,
// and every other name -- including "01"/"-1"/"1.5", which are canonical-index
// REJECTS -- is an ordinary named property (measured on adl 51.4.1,
// temp/strkeyprobe: a["1"]=42 lands in a[1]; a["01"]=7 leaves a.length at 2 and
// reads back; a["length"]=5 resizes; a["7"] reads undefined).
static as_value as_array_key_get(as_array* a, const char* key) {
    int i;
    if (strcmp(key, "length") == 0) return as_v_num((double)a->length);
    if (as_array_index_key(key, &i)) return as_array_get(a, i);
    return as_array_prop_get(a, key);
}
static void as_array_key_set(as_array* a, const char* key, as_value v) {
    int i;
    if (strcmp(key, "length") == 0) { as_array_set_length(a, as_v_to_uint(v)); return; }
    if (as_array_index_key(key, &i)) { as_array_set(a, i, v); return; }
    as_array_prop_set(a, key, v);
}

// delete a[key]. An Array never throws and always reports true: a canonical index
// leaves an undefined hole WITHOUT changing the length, any other name removes the
// named property (measured on adl 51.4.1, temp/strkeyprobe -- including a delete of
// an index past the end, which reports true and leaves the length alone).
static as_value as_array_del(as_array* a, const char* key) {
    int i;
    if (a == NULL) return as_v_bool(true);
    if (as_array_index_key(key, &i)) {
        if (i >= 0 && i < a->length) { as_value u = {5, 0.0, NULL}; a->data[i] = u; }
        return as_v_bool(true);
    }
    if (a->props != NULL) as_object_del(a->props, key);
    return as_v_bool(true);
}

// 'key in array'. AIR's Array is dynamic, so the answer is true for 'length', for
// a canonical index that holds an element (a deleted slot is a hole and reports
// false), and for any named property that was set on the array -- measured on adl
// 51.4.1, temp/pkg1/oracle/adl-b3b.txt: after a.foo = 1, "foo" is true while
// "bar" is false; "0" in ["x"] is true and "1" in ["x"] is false; "length" is
// true. Before this the static form was REJECTED at codegen and the dynamic form
// answered from the property table only, so every element index read false.
static bool as_array_has(as_array* a, const char* key) {
    if (a == NULL) return false;
    if (strcmp(key, "length") == 0) return true;
    int i;
    if (as_array_index_key(key, &i)) {
        if (i < 0 || i >= a->length) return false;
        return a->data[i].tag != 5;
    }
    return a->props != NULL && as_object_has(a->props, key);
}

// Dynamically-typed ('any') index read: dispatch on the boxed value's runtime
// tag — record slot, array element, or object field reflection.
static as_value as_any_get(as_value box, const char* key) {
    switch (box.tag) {
        case 4: return as_dyn_get(as_v_obj_val(box), key);
        case 6: {
            as_array* arr = (as_array*)as_v_obj_val(box);
            int i;
            if (as_array_index_key(key, &i)) return as_array_get(arr, i);
            // Non-index key on a dynamically-typed Array reference: a named
            // dynamic property (a.bar), NOT element 0 (strtol("bar") == 0).
            return as_array_prop_get(arr, key);
        }
        case 3: return as_v_str((char*)key);
        default: return as_v_null();
    }
}
static void as_any_set(as_value box, const char* key, as_value v) {
    switch (box.tag) {
        case 4: as_dyn_set(as_v_obj_val(box), key, v); break;
        case 6: {
            // Route through the same key classifier the literal form uses, so a
            // DYNAMIC write respects Array semantics: 'length' resizes,
            // a canonical index lands in the elements, anything else is a named
            // property. Previously 'length' fell through to the named-property
            // table, so a star-typed 'arr.length = "5"' left the array at its old
            // length (adl 51.4.1 gives 5, temp/pkgA/coerce2.body.as).
            as_array_key_set((as_array*)as_v_obj_val(box), key, v);
            break;
        }
        default: break;
    }
}

// Value-returning form of as_any_set (see as_dyn_set_v): an assignment expression
// evaluates to the assigned value, so a writer reached as a value must not be void.
static as_value as_any_set_v(as_value box, const char* key, as_value v) { as_any_set(box, key, v); return v; }

// The + operator when a dynamically-typed operand decides the semantics: ES3
// ToPrimitive with the default hint, i.e. if either operand's *runtime* value is a
// String -- or an object (whose default-hint conversion goes through toString,
// which yields a String) -- the operands concatenate; otherwise they add
// numerically. The emitter handles the case where one side is *statically* a
// String (as_str_concat); this helper covers any+any and any+statically-non-string,
// where only the box tag knows: var a:Array = ["x","y"]; a[0] + a[1] must be "xy"
// (it used to emit as_v_to_number(..) + as_v_to_number(..) = 0), and d + 1 with
// d:* holding "x" must be "x1" (it used to be 1).
// Object/array boxes render through as_v_str_val ("object"/"[Array]"), the same
// display form the static-String path and trace use -- i.e. the concat-vs-add
// *decision* matches AS3 ToPrimitive, while their text is this subset's
// simplification rather than AS3's toString()/join (see README current limits).
// null/undefined coerce to 0 in the numeric branch, matching as_v_to_number.
static as_value as_add_v(as_value a, as_value b) {
    bool a_obj = a.tag == 3 || a.tag == 4 || a.tag == 6 || a.tag == 7;
    bool b_obj = b.tag == 3 || b.tag == 4 || b.tag == 6 || b.tag == 7;
    if (a_obj || b_obj) return as_v_str(as_str_concat(as_v_str_val(a), as_v_str_val(b)));
    return as_v_num(as_v_to_number(a) + as_v_to_number(b));
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
        double na = as_v_to_number(fa);
        double nb = as_v_to_number(fb);
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

// Dynamic dispatch of the Array built-in method set on a star-typed receiver
// ('var a:* = [..]; a.push(x)'). The static path picks the helper at compile time
// (emitArrayMethod); a dynamic receiver only carries the boxed tag, so the name
// is resolved here. Without this, as_any_call handed an as_array* to as_dyn_call,
// which reads the vtable header out of the element buffer -- 'a.toString()'
// segfaulted and 'a.push(1)' silently did nothing (adl 51.4.1, temp/pkgA/arr3).
static as_value as_arr_call(as_array* a, const char* name, as_value* args, int argc) {
    if (strcmp(name, "toString") == 0 || strcmp(name, "valueOf") == 0) return as_v_str(as_array_join(a, ","));
    if (strcmp(name, "join") == 0)
        return as_v_str(as_array_join(a, (argc > 0 && args[0].tag != 5) ? as_v_str_val(args[0]) : ","));  // join(null) is the separator "null"; join(undefined) picks "," (adl 51.4.1)
    if (strcmp(name, "push") == 0) {
        int n = a->length;
        for (int i = 0; i < argc; i++) n = as_array_push(a, args[i]);
        return as_v_num((double)n);
    }
    if (strcmp(name, "pop") == 0) return as_array_pop(a);
    if (strcmp(name, "shift") == 0) return as_array_shift(a);
    if (strcmp(name, "unshift") == 0) {
        // unshift is variadic and prepends right-to-left, so the final order
        // matches the argument order (same as the static path).
        int n = a->length;
        for (int i = argc - 1; i >= 0; i--) n = as_array_unshift(a, args[i]);
        return as_v_num((double)n);
    }
    if (strcmp(name, "indexOf") == 0) return as_v_num((double)(argc > 0 ? as_array_indexOf(a, args[0]) : -1));
    if (strcmp(name, "insertAt") == 0) {
        as_array_insertAt(a, argc > 0 ? as_v_to_int(args[0]) : 0, argc > 1 ? args[1] : as_v_null());
        return as_v_null();
    }
    if (strcmp(name, "removeAt") == 0) return as_array_removeAt(a, argc > 0 ? as_v_to_int(args[0]) : 0);
    if (strcmp(name, "slice") == 0)
        return as_v_arr((void*)as_array_slice(a, argc > 0 ? as_v_to_int(args[0]) : 0, argc > 1 ? as_v_to_int(args[1]) : a->length));
    if (strcmp(name, "splice") == 0)
        return as_v_arr((void*)as_array_splice(a, argc > 0 ? as_v_to_int(args[0]) : 0, argc > 1 ? as_v_to_int(args[1]) : 0,
                                               argc > 2 ? &args[2] : NULL, argc > 2 ? argc - 2 : 0));
    if (strcmp(name, "reverse") == 0) return as_v_arr((void*)as_array_reverse(a));
    if (strcmp(name, "concat") == 0) {
        // Array.concat(...) flattens Array arguments and appends anything else as
        // a single element (ES3).
        as_array* r = as_array_slice(a, 0, a->length);
        for (int i = 0; i < argc; i++) {
            if (args[i].tag == 6) r = as_array_concat(r, (as_array*)args[i].ptr);
            else as_array_push(r, args[i]);
        }
        return as_v_arr((void*)r);
    }
    if (strcmp(name, "map") == 0 || strcmp(name, "filter") == 0) {
        if (argc < 1 || args[0].tag != 7) return as_v_null();
        as_fn cb = (as_fn)args[0].ptr;
        return as_v_arr((void*)(strcmp(name, "map") == 0 ? as_array_map(a, cb) : as_array_filter(a, cb)));
    }
    if (strcmp(name, "sort") == 0) {
        if (argc > 0 && args[0].tag == 7) return as_v_arr((void*)as_array_sort_cb(a, (as_fn)args[0].ptr));
        if (argc > 0 && (args[0].tag == 1 || args[0].tag == 8 || args[0].tag == 9) && (as_v_to_int(args[0]) & 16) != 0)
            return as_v_arr((void*)as_array_sort_num(a));
        return as_v_arr((void*)as_array_sort_str(a));
    }
    if (strcmp(name, "sortOn") == 0)
        return as_v_arr((void*)as_array_sortOn(a, argc > 0 ? as_v_str_val(args[0]) : "", argc > 1 ? as_v_to_int(args[1]) : 0));
    return as_v_null();
}

// ---------- Dictionary ----------
// AS3 flash.utils.Dictionary: an associative map keyed by STRICT EQUALITY (===).
// String/number/bool keys compare by value; object keys compare by reference.
// Keys are therefore stored as boxed as_value and compared with as_v_eq (which
// does strcmp for strings, pointer identity for objects) rather than raw pointer
// identity — the AGALMiniAssembler keys OPMAP/REGMAP/SAMPLEMAP by string
// ("mov"/"dp4"/"va"…), where value comparison is required. Weak keys (the ctor
// bool) are accepted but not modeled — keys are strongly held for the program
// lifetime (documented subset limitation).

static as_dict* as_dict_new(void) {
    as_dict* d = (as_dict*)gc_alloc(GCT_DICT, sizeof(as_dict));
    d->keys = NULL;
    d->vals = NULL;
    d->length = 0;
    d->capacity = 0;
    return d;
}
static int as_dict_find(as_dict* d, as_value key) {
    for (int i = 0; i < d->length; i++) {
        if (as_v_eq(d->keys[i], key)) return i;
    }
    return -1;
}
static as_value as_dict_get(as_dict* d, as_value key) {
    int i = as_dict_find(d, key);
    return i < 0 ? as_v_null() : d->vals[i];
}
static as_value as_dict_set(as_dict* d, as_value key, as_value v) {
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
        as_value* nk = (as_value*)gc_alloc(GCT_VALUE_ARRAY, sizeof(as_value) * (size_t)cap);
        as_value* nv = (as_value*)gc_alloc(GCT_VALUE_ARRAY, sizeof(as_value) * (size_t)cap);
        if (d->length > 0) {
            memcpy(nk, d->keys, sizeof(as_value) * (size_t)d->length);
            memcpy(nv, d->vals, sizeof(as_value) * (size_t)d->length);
        }
        d->keys = nk;
        d->vals = nv;
        d->capacity = cap;
        // Fresh blocks born BLACK during a cycle: re-grey the copied keys/values
        // (see as_array_ensure) so Dictionary entries are not swept white.
        for (int i = 0; i < d->length; i++) { gc_write_barrier_value(nk[i]); gc_write_barrier_value(nv[i]); }
    }
    d->keys[d->length] = key;
    d->vals[d->length] = v;
    d->length++;
    gc_write_barrier_value(key);
    gc_write_barrier_value(v);
    return v;
}
static bool as_dict_has(as_dict* d, as_value key) {
    return as_dict_find(d, key) >= 0;
}
static bool as_dict_del(as_dict* d, as_value key) {
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
// AS3 String.indexOf(value, startIndex=0) / lastIndexOf(value, startIndex=0x7FFFFFFF).
// The optional startIndex is NOT decoration: walking a string line by line means
// s.indexOf(newline, i), and dropping the bound silently returns the FIRST
// occurrence instead of the next one after i — a wrong answer, not a missing
// feature (a real defect until stage 89·53; found by the HTTP/2 probe).
//
// Exact semantics, pinned against adl (temp/air-probe/Probe10.as):
//   indexOf    clamps start to [0, len] and takes the first match AT OR AFTER it;
//              an empty needle matches at the clamped position
//              ("abcabc".indexOf("bc",99) = -1, .indexOf("",9) = 6, .indexOf("bc",-3) = 1)
//   lastIndexOf clamps down to len, but a NEGATIVE start returns -1 outright — it
//              is not clamped to 0 ("abcabc".lastIndexOf("a",-1) = -1)
static int as_str_indexOf_from(const char* s, const char* sub, int from) {
    int slen = (int)strlen(s);
    if (from < 0) from = 0;
    if (from > slen) from = slen;
    const char* p = strstr(s + from, sub);
    return p ? (int)(p - s) : -1;
}
static int as_str_lastIndexOf_from(const char* s, const char* sub, int from) {
    if (from < 0) return -1;
    int slen = (int)strlen(s);
    if (from > slen) from = slen;
    int sublen = (int)strlen(sub);
    for (int i = from; i >= 0; i--) {
        if (strncmp(s + i, sub, (size_t)sublen) == 0) return i;
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
// _Noreturn (C11) is not decoration. clang only inlines a guard helper when it
// can prove the error path terminates; without the specifier the throw path is
// charged to the inliner as a normal call, so the #1009 null-receiver guard
// as_req_obj stayed OUT OF LINE in large hot functions. Every guarded member
// access then became an opaque call the optimizer cannot see through, which
// roughly doubled the per-object cost of Starling's render loop (peak 41k ->
// 22k objects, stage 九十四·二十六). as_throw always either exit()s or
// longjmps, so the specifier states an exact fact -- and it is standard C11, not
// a compiler attribute.
static _Noreturn void as_throw(void* e) {
    as_exception = e;
    if (as_jmp_depth == 0) {
        fprintf(stderr, "Uncaught exception: %s\\n", as_error_message(e));
        fflush(stderr);
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

// ---------- ASC_GC_AUDIT: dangling-reference detector (diagnostic) ----------
// A precise collector's worst failure mode is silent: a live object keeps a
// pointer to a block the sweep already returned to a free list. Nothing fails
// at that moment -- the freed block still holds its old bytes, so the stale
// pointer keeps 'working' -- and the corruption only shows up much later, when
// the block has been handed to a new owner. In the Starling benchmark that cost
// an afternoon: a Mesh's '_style' pointer began reading a double (the reused
// block now held a numeric payload) and the process died in
// BatchProcessor.addMesh on the *second* ramp, a full minute after the object
// had been freed.
//
// This mode reports the bug at the moment the collector first sees it: every
// pointer offered to the marker is classified, and one that lands on a free
// block (type 0) or inside a segment the release pass handed back to the OS is
// reported together with its *holder* -- the object (AS3 class name plus the
// reflecting-table property, when there is one) or the root slot it came from.
// Free blocks are remembered in a ring so the report can also name what the
// freed object *was*. Off by default; ASC_GC_AUDIT=1 enables it (see
// docs/zh-cn/gc.md).
#define GC_AUDIT_FREED_RING 65536
static gc_header* gc_audit_freed[GC_AUDIT_FREED_RING];
static int gc_audit_freed_type[GC_AUDIT_FREED_RING];
static size_t gc_audit_freed_size[GC_AUDIT_FREED_RING];
static void* gc_audit_freed_vt[GC_AUDIT_FREED_RING];
static int gc_audit_freed_pos = 0;
static int gc_audit_reports = 0;
// Separate budgets: the free_bytes drift lines are numerous and only
// informative in bulk, while a DANGLING/RELEASING report IS the finding --
// it must never be crowded out by drift noise (crowding out is exactly what
// hid the first diagnosis).
static int gc_audit_drift_reports = 0;
static int gc_audit_release_reports = 0;
static int gc_audit_mode_cache = -1;
// Holder of the pointer currently being examined: the object whose fields
// gc_scan is walking (NULL while a root slot is being offered), plus the
// reflecting-table property name / array slot being read from it.
static gc_header* gc_audit_holder = NULL;
static const char* gc_audit_prop = NULL;
static int gc_audit_slot = -1;

static bool gc_audit_on(void) {
    if (gc_audit_mode_cache < 0) {
        const char* e = getenv("ASC_GC_AUDIT");
        const char* s = getenv("ASC_GC_AUDIT_STRICT");
        gc_audit_mode_cache = ((e != NULL && e[0] != '0') || (s != NULL && s[0] != '0')) ? 1 : 0;
    }
    return gc_audit_mode_cache != 0;
}

// ASC_GC_AUDIT_STRICT turns "this invariant is broken" into a non-zero exit
// instead of a report line, so an ordinary regression example can assert the
// heap invariants by simply running: no report is printed while the invariants
// hold, and any violation aborts. Used by examples/gc_seg_reap.as (see test.ts),
// which is the regression for the segment-release accounting bug described at
// gc_audit_seg_account below.
static int gc_audit_strict_cache = -1;
static bool gc_audit_strict(void) {
    if (gc_audit_strict_cache < 0) {
        const char* s = getenv("ASC_GC_AUDIT_STRICT");
        gc_audit_strict_cache = (s != NULL && s[0] != '0') ? 1 : 0;
    }
    return gc_audit_strict_cache != 0;
}
static void gc_audit_fail(void) {
    if (!gc_audit_strict()) return;
    fprintf(stderr, "[gc-audit] STRICT: heap invariant violated (see the report above)\\n");
    fflush(stderr);
    abort();
}

// Name an object *type* the way a reader can act on it: an AS3 qualified class
// name when the block was a class instance, the GCT tag otherwise.
static const char* gc_audit_type_name(int type, void* vt) {
    static char buf[128];
    if (type == GCT_CLASS && vt != NULL) {
        const char* fqn = ((as_vtable_header*)vt)->fqn;
        if (fqn != NULL) return fqn;
    }
    snprintf(buf, sizeof(buf), "GCT tag %d", type - GCT_TAG_BASE);
    return buf;
}

// Record a block the sweeper is about to free, so a later dangling reference to
// it can be named. Called *before* the header is overwritten with type 0.
static void gc_audit_note_freed(gc_header* h) {
    if (!gc_audit_on()) return;
    int i = gc_audit_freed_pos;
    gc_audit_freed[i] = h;
    gc_audit_freed_type[i] = h->type;
    gc_audit_freed_size[i] = h->size;
    gc_audit_freed_vt[i] = h->type == GCT_CLASS
        ? ((as_object_header*)((char*)h + sizeof(gc_header)))->vtable : NULL;
    gc_audit_freed_pos = (i + 1) % GC_AUDIT_FREED_RING;
}

// Cross-check the release pass against the truth, by walking the all-objects
// list instead of trusting the incremental free_bytes counter.
//
// gc_release_empty_segs decides to hand a segment back when free_bytes == size,
// i.e. "every byte of it is on a free list". That is only a proof of emptiness
// while the counter is exact. It was not: handing out a free block whose
// remainder is smaller than GC_MIN_BLOCK skipped the split but still charged
// only the requested size, so free_bytes crept above the segment's true free
// space, the test could pass while live objects were still in the segment, and
// the chunk was freed -- the objects survived as memory the next malloc user
// owned (a MeshStyle whose vtable word turned into a double; gc_all itself was
// later seen holding the double 0.9872449040412903, i.e. the benchmark's
// _container.scale). The allocator now charges the block's actual size, and
// this cross-check is what keeps that invariant honest: audit mode only, one
// O(live objects) walk per release pass, silent while the accounting is exact.
static void gc_audit_seg_account(void) {
    for (gc_seg* s = gc_segs; s != NULL; s = s->next) { s->audit_live = 0; s->audit_ghost = 0; }
    for (gc_header* h = gc_all; h != NULL; h = h->next) {
        gc_seg_range* r = gc_seg_find(h);
        if (r == NULL) continue;
        // A free block (type 0) linked in gc_all is a *ghost*: the sweeper unlinks
        // a block as it frees it, so gc_all pointing at one means the chain was
        // re-linked without being unlinked -- and once a block sits in gc_all and
        // in a free list at the same time, everything downstream (free_bytes,
        // segment release, double frees) is unsound. Counted separately from real
        // live bytes because the fix is completely different.
        if (h->type == 0) {
            r->seg->audit_ghost += sizeof(gc_header) + h->size;
            if (gc_audit_release_reports++ < 32) {
                bool in_fl = false;
                for (int li = 0; li < GC_SMALL_CLASSES + 2; li++)
                    for (gc_header* f = *gc_free_list_at(li); f != NULL && !in_fl; f = f->next) if (f == h) in_fl = true;
                fprintf(stderr, "[gc-audit] GHOST: gc_all holds a FREE block %p size=%zu in seg=%p (next=%p free_list=%s)\\n",
                        (void*)h, h->size, (void*)r->seg->base, (void*)h->next, in_fl ? "YES" : "no");
                fflush(stderr);
                gc_audit_fail();
            }
        } else {
            r->seg->audit_live += sizeof(gc_header) + h->size;
        }
    }
    for (gc_seg* s = gc_segs; s != NULL; s = s->next) {
        size_t truth_free = s->size - s->audit_live - s->audit_ghost;
        if (s->free_bytes != truth_free) {
            if (gc_audit_drift_reports++ < 8) {
                fprintf(stderr, "[gc-audit] free_bytes DRIFT seg=%p size=%zu free_bytes=%zu live=%zu ghost=%zu (truth=%zu) delta=%ld reap=%d\\n",
                        (void*)s->base, s->size, s->free_bytes, s->audit_live, s->audit_ghost, truth_free,
                        (long)s->free_bytes - (long)truth_free, s->reap);
                fflush(stderr);
                gc_audit_fail();
            }
        }
        if (s->reap && s->audit_live != 0) {
            if (gc_audit_release_reports++ < 32) {
                fprintf(stderr, "[gc-audit] RELEASING segment %p with %zu LIVE bytes (free_bytes=%zu size=%zu):",
                        (void*)s->base, s->audit_live, s->free_bytes, s->size);
                int shown = 0;
                for (gc_header* h = gc_all; h != NULL && shown < 6; h = h->next) {
                    if ((char*)h >= s->base && (char*)h < s->base + s->size) {
                        void* vt = h->type == GCT_CLASS
                            ? ((as_object_header*)((char*)h + sizeof(gc_header)))->vtable : NULL;
                        fprintf(stderr, " %s(%zu)", gc_audit_type_name(h->type, vt), h->size);
                        shown++;
                    }
                }
                fprintf(stderr, "\\n");
                fflush(stderr);
                gc_audit_fail();
            }
        }
    }
}

// The corruption gate: a heap bookkeeping word (gc_all, a free-list node, a
// sweep cursor) must always be a real block inside a live segment. A *double*
// sitting in one of them means a wild store already happened -- and this gate
// runs at the top of every allocation and every sweep step, so the call chain
// it reports is the code that ran *right after* the stray store, which is where
// the C source can be read directly. (Written for the "second benchmark run"
// crash: gc_all held 0x3fef9782a0000000 == the double 0.9872449040412903, a
// value the benchmark had just computed as _container.scale, i.e. a stray
// double store into a pointer slot.)
static int gc_audit_gate_reports = 0;
// Is this a *block header* address inside a live segment? gc_in_heap() is not
// usable here: it insists the address sit past the first block header, because
// its callers pass object *bodies* (and that guard is what keeps a word landing
// on a segment base from faulting on the header read). The values this gate
// checks are headers, and the first header sits exactly at the segment base.
static bool gc_audit_is_block(const void* p) {
    gc_seg_range* r = gc_seg_find(p);
    return r != NULL && (const char*)p >= r->base && (const char*)p < r->base + r->size;
}
static void gc_audit_gate_frame(int i, const void* ra) {
    unsigned long off = 0;
    const char* sym = gc_dbg_sym(ra, &off);
    fprintf(stderr, "                 frame %d: %s+0x%lx\\n", i, sym, off);
}
static void gc_audit_gate(const char* what, const void* p) {
    if (p == NULL || !gc_audit_on() || gc_audit_is_block(p)) return;
    if (gc_audit_gate_reports++ >= 8) return;
    fprintf(stderr, "[gc-audit] %s holds NON-HEAP value %p (as double %.17g)\\n",
            what, p, *(const double*)&p);
    // the frame chain needs a constant index, so it is spelled out; the
    // deepest frames are the AS3 method that was running.
    gc_audit_gate_frame(0, ASC_RETURN_ADDRESS(0));
    gc_audit_gate_frame(1, ASC_RETURN_ADDRESS(1));
    gc_audit_gate_frame(2, ASC_RETURN_ADDRESS(2));
    gc_audit_gate_frame(3, ASC_RETURN_ADDRESS(3));
    fflush(stderr);
    gc_audit_fail();
}

static void gc_audit_where(void) {
    if (gc_audit_holder == NULL) {
        fprintf(stderr, "                 held by: a root slot (static field / module var / registry / stack)\\n");
        return;
    }
    gc_header* h = gc_audit_holder;
    if (h->type == GCT_CLASS) {
        const char* fqn = ((as_vtable_header*)((as_object_header*)((char*)h + sizeof(gc_header)))->vtable)->fqn;
        fprintf(stderr, "                 held by: object of class %s", fqn ? fqn : "?");
    } else {
        fprintf(stderr, "                 held by: object with GCT tag %d", h->type - GCT_TAG_BASE);
    }
    if (gc_audit_prop != NULL) fprintf(stderr, " prop=\\"%s\\"", gc_audit_prop);
    if (gc_audit_slot >= 0) fprintf(stderr, " slot=%d", gc_audit_slot);
    fprintf(stderr, "\\n");
}

// Classify one pointer the marker was offered.
static void gc_audit_check(void* p) {
    if (!gc_audit_on()) return;   // resolves (and caches) the env var on first use
    if (p == NULL) return;
    if (gc_in_heap(p)) {
        gc_header* h = gc_hdr(p);
        if (h->type != 0) return;
        if (gc_audit_reports++ < 32) {
            int old_type = -1; size_t old_size = 0; void* old_vt = NULL;
            for (int i = 0; i < GC_AUDIT_FREED_RING; i++) {
                if (gc_audit_freed[i] == h && gc_audit_freed_type[i] != 0) {
                    old_type = gc_audit_freed_type[i];
                    old_size = gc_audit_freed_size[i];
                    old_vt = gc_audit_freed_vt[i];
                    break;
                }
            }
            if (old_type >= 0) {
                fprintf(stderr, "[gc-audit] DANGLING reference to SWEPT block %p (was %s, %zu bytes)\\n",
                        (void*)h, gc_audit_type_name(old_type, old_vt), old_size);
            } else {
                fprintf(stderr, "[gc-audit] DANGLING reference to SWEPT block %p (not in the freed ring)\\n",
                        (void*)h);
            }
            gc_audit_where();
            fflush(stderr);
        }
        return;
    }
    // Pointers outside the heap are NOT inspected any further. A "was this
    // address inside a segment we handed back?" test is unsound by
    // construction: malloc immediately reuses a released chunk, so the arena
    // (ByteArray.data, BitmapData.pixels) legitimately owns those addresses
    // right after the release, and every such report was a false positive that
    // drowned the real ones. Address-range history is therefore not consulted;
    // the sound signals are the SWEPT-block ring above (keyed on an exact block
    // address), the GHOST/DRIFT/RELEASING accounting, and gc_audit_gate.
}

// Mark one pointer: if it points into the GC heap and is still white, colour it
// grey and queue it for scanning. Non-heap pointers (string literals, static
// vtables) are skipped by the address-range check. Non-recursive: the mark is
// driven by draining the grey stack (gc_step / gc_collect), which is what makes
// it resumable across frames.
static void gc_mark_ptr(void* p) {
    if (gc_audit_mode_cache != 0) gc_audit_check(p);
    if (p == NULL || !gc_in_heap(p)) return;
    gc_header* h = gc_hdr(p);
    if (h->color == GC_WHITE) {
        h->color = GC_GREY;
        gc_grey_push(h);
    }
}

static void gc_mark_value(as_value v) {
    // Explicit tag list, never a range test: tags 8/9 (int64/uint64) alias the ptr
    // slot with raw integer bits, so treating them as pointers would mark random
    // memory (and gc_write_barrier_value lists them for the same reason).
    if (v.tag == 3 || v.tag == 4 || v.tag == 6 || v.tag == 7)
        gc_mark_ptr(v.ptr);
}

// Scan one object's child pointers, greying (and queuing) any white child.
static void gc_scan(gc_header* h) {
    char* b = (char*)h + sizeof(gc_header);
    // Expose the object being scanned to the dangling-reference detector, which
    // reports it as the *holder* of any pointer that turns out to point at a
    // swept block (see ASC_GC_AUDIT above).
    gc_header* _prev_holder = gc_audit_holder;
    gc_audit_holder = h;
    gc_audit_prop = NULL;
    gc_audit_slot = -1;
    switch (h->type) {
    case GCT_STRING:
        break;  // leaf
    case GCT_NUMBER:
        break;  // leaf (boxed double carries no child pointers)
    case GCT_BOOLEAN:
        break;  // leaf (boxed bool carries no child pointers)
    case GCT_STRING_OBJ: {
        as_string* s = (as_string*)b;
        gc_mark_ptr(s->value);
        break;
    }
    case GCT_FUNCTION_OBJ: {
        as_function* f = (as_function*)b;
        gc_mark_ptr((void*)f->value);
        break;
    }
    case GCT_ARRAY: {
        as_array* a = (as_array*)b;
        gc_mark_ptr(a->data);
        gc_mark_ptr(a->input);
        gc_mark_ptr(a->props);
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
                    gc_audit_prop = props[i].name;
                    switch (props[i].type) {
                    case 3: gc_mark_ptr(*(char**)(base + props[i].offset)); break;
                    case 6: gc_mark_ptr(*(void**)(base + props[i].offset)); break;
                    // 10/11/12 hold the same kind of pointer as 6 (Array, class
                    // instance, autoboxed Object) -- they exist only so the WRITE
                    // side can type-check, and must stay visibly marked here.
                    case 10: case 11: case 12: gc_mark_ptr(*(void**)(base + props[i].offset)); break;
                    case 7: gc_mark_value(*(as_value*)(base + props[i].offset)); break;
                    // Types 8/9 (int64/uint64 fields) hold no pointer and are
                    // deliberately absent: a range test here would mark raw
                    // integer bits as a heap reference.
                    }
                }
            }
            vt = ((as_vtable_header*)vt)->super;
        }
        // Dynamic class instances also carry an _dyn as_object* slot table; its
        // byte offset is recorded on the object's own vtable (dyn_offset >= 0).
        as_vtable_header* hv = (as_vtable_header*)((as_object_header*)b)->vtable;
        if (hv->dyn_offset >= 0) gc_mark_ptr(*(void**)((char*)b + hv->dyn_offset));
        break;
    }
    case GCT_VALUE_ARRAY: {
        int n = (int)(h->size / sizeof(as_value));
        as_value* arr = (as_value*)b;
        for (int i = 0; i < n; i++) { gc_audit_slot = i; gc_mark_value(arr[i]); }
        break;
    }
    case GCT_PTR_ARRAY: {
        int n = (int)(h->size / sizeof(void*));
        void** arr = (void**)b;
        for (int i = 0; i < n; i++) { gc_audit_slot = i; gc_mark_ptr(arr[i]); }
        break;
    }
    case GCT_RAW:
        // Leaf: a monomorphized Vector's element storage for scalar / boxed
        // element types (double/int/uint/bool/'*'/interface). The bytes hold no
        // pointers the GC could follow -- '*' and interface elements are traced
        // by that vector's own GCT_CUSTOM mark callback -- so nothing to scan here.
        break;
    case GCT_BYTES:
        // Leaf: a raw byte buffer (ByteArray.data, BitmapData.pixels, …). Bytes
        // never hold pointers worth following, and the buffer is reachable only
        // because some class field points at it (the field is what gc_scan
        // follows). Kept distinct from GCT_RAW so the ASC_GC_STATS type
        // accounting can tell a per-frame Vector payload apart from a
        // never-freed byte buffer -- that split is what a leak hunt needs.
        break;
    case GCT_CUSTOM: {
        // The object body's first word is a 'void (*mark)(void* self)' callback
        // (monomorphized Vector / closure-env structs). gc_alloc zeroes the body,
        // so a NULL callback is a safe no-op until the constructor installs it.
        void (**mark)(void*) = (void(**)(void*))b;
        if (*mark) (*mark)(b);
        break;
    }
    case GCT_XML: {
        // DOM node: name/text are GCT_STRING leaves; attr_names/attr_vals/children
        // are GCT_PTR_ARRAY buffers whose element pointers (attr name/value
        // strings, child nodes) are themselves traced when the buffer is scanned.
        as_xml_node* n = (as_xml_node*)b;
        gc_mark_ptr(n->name);
        gc_mark_ptr(n->text);
        gc_mark_ptr(n->attr_names);
        gc_mark_ptr(n->attr_vals);
        gc_mark_ptr(n->children);
        // A live child keeps its ancestors alive (XML.parent()).
        gc_mark_ptr(n->parent);
        break;
    }
    case GCT_XML_LIST: {
        as_xml_list* l = (as_xml_list*)b;
        gc_mark_ptr(l->items);
        break;
    }
    }
    gc_audit_holder = _prev_holder;
    gc_audit_prop = NULL;
    gc_audit_slot = -1;
}

// Permanent roots owned by the runtime itself: the setTimeout timer table,
// the in-flight IO jobs, the registered sockets and the in-flight exception.
// (The event registry and stage live in generated code and are marked by
// gc_mark_user_roots.) Both walks are defined further down with their tables.
static void as_async_mark_roots(void);
static void as_sock_mark_roots(void);
static void as_audio_mark_roots(void);
static void gc_mark_internal_roots(void) {
    for (int i = 0; i < as_timer_count; i++) {
        if (as_timers[i].alive) {
            gc_mark_ptr(as_timers[i].fn);
            gc_mark_ptr(as_timers[i].args);
        }
    }
    for (int i = 0; i < as_rep_timer_count; i++) {
        if (as_rep_timers[i].alive) gc_mark_ptr(as_rep_timers[i].obj);
    }
    for (int i = 0; i < as_mc_count; i++) {
        if (as_mcs[i].alive) gc_mark_ptr(as_mcs[i].obj);
    }
    as_async_mark_roots();
    as_sock_mark_roots();
    as_audio_mark_roots();
    gc_mark_ptr(as_exception);
}

// ---------- conservative stack roots for mid-frame collections ----------
// The collector keeps no shadow stack: generated functions do not register
// their pointer-holding locals, because the incremental collector runs at the
// frame-boundary safe point (Stage_dispatchFrame) where every AS3 frame has
// already returned and the root set really is permanent roots alone.
//
// A collection can, however, be forced while AS3 frames are still live:
// System.gc() called from user code, or Stage.dispatchFrame() called from AS3.
// Any GC object then referenced ONLY by a C local/register of a live generated
// function is invisible to the precise marker — the in-flight event being
// dispatched by EventDispatcher.dispatchEventWith is exactly such a local. The
// sweep would free it, and the emitter's own Event_toPool_static(event) line --
// which runs after dispatchEvent returns -- would push the freed Event into
// Event.sEventPool; the next fromPool() popped freed memory and called a NULL
// vtable slot => SIGSEGV (the Starling demo crash this guards against).
//
// Such a collection therefore adds the live stack region to the roots
// conservatively (Boehm style): every aligned word in [current SP, stack top]
// is offered to gc_mark_ptr, which ignores anything that is not the exact body
// address of a real object (gc_is_object). The top is main()'s frame
// (GC_NOTE_STACK_BASE at the head of main); dead space below the scanning frame
// belongs to calls that already returned, so it is never scanned. setjmp()
// materializes the callee-saved registers into the stack, which is the other
// half of a conservative root set — a live local can sit in a register with no
// stack slot of its own.
//
// This stays out of the hot path: the emitted Stage_dispatchFrame's safe point
// is entered from the C/Objective-C frame loop, so its scan window is only the
// run-loop frames above it (the previous frame's dead callback frames are below
// the scanning frame and thus skipped), and gc_mark_roots runs once per cycle.
static char* gc_stack_top = NULL;   // highest live stack address (main's frame)

static void gc_note_stack_base(void* p) { gc_stack_top = (char*)p; }
// Captures a word *in the caller's own frame*, so the recorded top brackets every
// frame the caller (directly or indirectly) will run.
#define GC_NOTE_STACK_BASE() do { char _gc_sp_marker; gc_note_stack_base(&_gc_sp_marker); } while (0)

// Is 'p' the exact body address of a live-or-not-yet-swept GC object? A stack
// word can also point *into* an object (e.g. a char* walking a string body);
// treating such an interior address as a body would read a payload word as a
// header and could dispatch into garbage (GCT_CUSTOM calls a mark callback taken
// from the "body"). The GCT_* tags carry a magic prefix and free blocks carry 0,
// so the tag check alone rejects every interior/stale word.
// The upper size bound is deliberately far above GC_SEG_SIZE: a payload larger
// than one segment (e.g. a multi-MB Vector.<Number>) gets a dedicated oversized
// segment, and rejecting those here would let the stack scan miss a large buffer
// that is still in use. The tag + colour checks are what reject garbage words.
static bool gc_is_object(void* p) {
    if (!gc_in_heap(p)) return false;
    gc_header* h = gc_hdr(p);
    return h->type >= GCT_STRING && h->type <= GCT_BYTES
        && h->color >= GC_WHITE && h->color <= GC_BLACK
        && h->size >= sizeof(void*) && h->size <= (size_t)(1u << 30);
}

// Offer every word of the live stack region to the marker. Registered as a root
// source by gc_mark_roots.
static void gc_mark_stack(void) {
    if (gc_stack_top == NULL) return;   // no recorded frame (no emitted main)
    jmp_buf jb;
    setjmp(jb);   // spill callee-saved registers onto the stack so they are scanned
    char* lo = (char*)(((uintptr_t)&jb + sizeof(void*) - 1) & ~(uintptr_t)(sizeof(void*) - 1));
    for (char* p = lo; p < gc_stack_top; p += sizeof(void*)) {
        void* w;
        memcpy(&w, p, sizeof(void*));   // words are not guaranteed pointer-aligned
        if (gc_is_object(w)) gc_mark_ptr(w);
    }
}

// Mark every root (internal + registered slots + generated user roots).
static void gc_mark_roots(void) {
    gc_mark_internal_roots();
    for (int i = 0; i < gc_root_count; i++) gc_mark_ptr(*gc_roots[i]);
    gc_mark_user_roots();
    gc_mark_stack();
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
        gc_audit_gate("sweep cursor", h);
        gc_header* next = h->next;
        if (h->color == GC_WHITE) {
            if (gc_inc.sweep_prev) gc_inc.sweep_prev->next = next; else gc_all = next;
            gc_all_bytes -= sizeof(gc_header) + h->size;
            gc_header** fl = gc_free_list_for(h->size);
            gc_audit_note_freed(h);   // remember it for the ASC_GC_AUDIT detector
            h->next = *fl;
            {
                int _k = h->type - GCT_TAG_BASE;
                if (_k >= 0 && _k < 24) { gc_dbg_type_bytes[_k] -= (double)h->size; gc_dbg_type_count[_k]--; }
            }
            gc_seg_range* _sr = gc_seg_find(h);
            if (_sr != NULL) _sr->seg->free_bytes += sizeof(gc_header) + h->size;
            h->type = 0;   // free block: never a plausible object header again
            *fl = h;
        } else {
            h->color = GC_WHITE;   // black -> white for the next cycle
            gc_inc.sweep_prev = h;
        }
        gc_inc.sweep_cursor = next;
    }
    return gc_inc.sweep_cursor == NULL;
}

// Ask the OS allocator to give back the pages it is merely holding empty.
//
// free() is not enough on macOS: the malloc zones keep freed chunks resident, so
// RSS sits at the high-water mark of the process even after the GC released
// every empty segment and the arena stopped using a buffer. Measured with 'heap'
// in the benchmark at 33k objects: 167 MB actually allocated inside 388 MB of
// reserved zone space, of which 263 MB was 'empty' (freed) and still resident --
// i.e. most of the reported RSS. malloc_zone_pressure_relief() is exactly the
// API for this (it is what the system itself calls under memory pressure); it
// walks the zones and madvises their free pages away. Called at the same
// rate-limited point as the segment release, so it costs a few ms per second at
// worst and nothing on platforms without the concept (WASI/Windows).
static void gc_trim_os(void) {
#ifdef __APPLE__
    malloc_zone_pressure_relief(NULL, 0);
#endif
}

// How often to look for wholly-free segments to hand back to the OS. The pass
// is O(segments + free blocks); at a 500 ms cadence that is a fraction of a
// percent of the frame budget while keeping RSS within half a second of the
// live set.
#define GC_RELEASE_MS 500.0
static double gc_release_last = -1e30;

// Cadence of the release pass above, overridable for diagnostics: ASC_GC_RELEASE
// gives the interval in milliseconds, and 0 disables the pass entirely (which is
// how a suspected interaction with the release path gets ruled in or out
// without a rebuild).
static double gc_release_interval(void) {
    static double cached = -1.0;
    static bool resolved = false;
    if (!resolved) {
        const char* e = getenv("ASC_GC_RELEASE");
        cached = e != NULL ? strtod(e, NULL) : GC_RELEASE_MS;
        resolved = true;
    }
    return cached;
}

// Return segments that went entirely free to the OS. A segment is releasable
// only when every byte of it sits on a free list (free_bytes == size), which
// means it holds no live object, so no pointer into it can exist anywhere.
//
// Without this, RSS stays at the *high-water mark* of the GC heap forever: the
// allocator never gives a chunk back, so a ramp that once needed 400 MB of
// segments keeps 400 MB resident even after the garbage is collected. Measured
// in the Starling benchmark at the moment of writing: 43 MB live inside 414 MB
// reserved segments / 613 MB RSS -- i.e. most of the RSS was *empty* segments.
//
// Two passes: flag the empty segments (cheap, O(#segments), and the common case
// finds nothing and stops), then walk the two free lists once and unlink the
// blocks that belong to them before freeing the chunks themselves.
static void gc_release_empty_segs(void) {
    const double interval = gc_release_interval();
    if (interval <= 0.0) return;   // ASC_GC_RELEASE=0: keep every segment mapped
    const double now = as_now_ms();
    if (now - gc_release_last < interval) return;
    gc_release_last = now;
    gc_trim_os();
    int any = 0;
    for (gc_seg* s = gc_segs; s != NULL; s = s->next) {
        s->reap = (s->free_bytes == s->size);
        if (s->reap) any = 1;
    }
    // ASC_GC_AUDIT: before acting on those flags, verify them against gc_all.
    if (gc_audit_on()) gc_audit_seg_account();
    if (!any) return;
    // Unlink every free block living in a doomed segment. A block belongs to at
    // most one list, and the lists are rebuilt in place, so this is one walk of
    // each.
    for (int li = 0; li < GC_SMALL_CLASSES + 2; li++) {
        gc_header** listp = gc_free_list_at(li);
        gc_header* prev = NULL;
        gc_header* h = *listp;
        while (h != NULL) {
            gc_header* next = h->next;
            gc_seg_range* r = gc_seg_find(h);
            if (r != NULL && r->seg->reap) {
                if (prev) prev->next = next; else *listp = next;
            } else {
                prev = h;
            }
            h = next;
        }
    }
    // Now drop the segments: unlink from the creation list and the lookup table,
    // then give the chunk back. free() of a >= 128 KB chunk munmaps it, so this
    // is what makes RSS follow the live set down again.
    gc_seg** sp = &gc_segs;
    while (*sp != NULL) {
        gc_seg* s = *sp;
        if (!s->reap) { sp = &s->next; continue; }
        *sp = s->next;
        gc_seg_range_del(s->base);
        free(s->base);
        free(s);
    }
    // The chunk free above only hands the pages to the allocator; ask the OS
    // again so this pass actually shows up in RSS.
    gc_trim_os();
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
        gc_all_bytes += gc_new_bytes; gc_new_bytes = 0;
        for (gc_header* h = gc_new; h != NULL; h = h->next) h->color = GC_WHITE;
        gc_new = NULL;
    }
    gc_bytes_allocated = 0;
    gc_trigger_next = 0;   // live set just changed: refresh the cached trigger
    gc_inc.state = GC_IDLE;
    gc_release_empty_segs();
    gc_dbg_dump("cycle_end");
}

// One incremental slice, called every frame at the Stage_dispatchFrame safe
// point. Advances the MARK and SWEEP phases by a fixed object budget so the
// per-frame GC pause stays O(budget) instead of growing with the heap.

// Per-frame work budget for one GC slice. gc_inc.budget (500 objects) bounds
// the pause but says nothing about throughput: with a ~100k-object heap a whole
// cycle needs hundreds of frames, and every frame in between allocates fresh
// garbage, so the heap balloons far beyond its live set. ASC_GC_BUDGET
// overrides the slice size so the throughput/latency trade-off can be measured
// instead of guessed (see docs/zh-cn/gc.md).
// A fixed 500-object slice bounds the pause but says nothing about throughput.
// An incremental cycle that needs hundreds of frames never finishes: every frame
// in between allocates more garbage, so the heap (and RSS) balloons far beyond
// the live set -- the measured failure mode was a 900 MB heap for a ~30 MB live
// set, with the ramp collapsing when the collector finally ran. Scale the slice
// so a cycle completes in roughly GC_CYCLE_FRAMES frames, keeping the per-frame
// work proportional to the heap instead of unbounded in time.
// The slice is bounded at both ends: a floor of gc_inc.budget keeps progress on
// tiny heaps, and the cap keeps the *pause* bounded -- an arbitrarily large
// slice makes the collector's per-frame share grow with the heap, which costs
// more frame time than it saves (measured: an uncapped slice/12 dropped the
// frame rate steadily from 120 to 47 fps, while a capped slice held 120 fps).
#define GC_SLICE_CAP 8000
#define GC_CYCLE_FRAMES 16
static size_t gc_budget(void) {
    static size_t override_budget = 0;
    static bool resolved = false;
    if (!resolved) {
        const char* e = getenv("ASC_GC_BUDGET");
        override_budget = e ? (size_t)strtoul(e, NULL, 10) : 0;
        resolved = true;
    }
    if (override_budget != 0) return override_budget;
    size_t adaptive = gc_dbg_inuse_count() / GC_CYCLE_FRAMES + gc_inc.budget;
    return adaptive > GC_SLICE_CAP ? GC_SLICE_CAP : adaptive;
}

// The two callers of gc_trigger() want opposite things, so the *floor* differs
// even though the adaptive term does not:
//
//   - Frame-driven (gc_step): a collection is a slice of the frame budget, so
//     the cycle must start early and get spread out; a small floor keeps tiny
//     heaps prompt and gc_budget() bounds the resulting pause.
//   - Non-GUI (the stop-the-world call in gc_alloc): there is no frame deadline,
//     and the measured cost of one collection is dominated by *re-marking the
//     live set*, which is independent of how much garbage accumulated since the
//     last one (binarytrees: drain 1.05 ms/collection at every threshold, 154
//     collections => 166 ms of pure mark time). That makes total GC time
//     (#collections x constant), so the only lever is to collect less often.
//
// Hence the non-GUI floor is 8 MiB. Measured on the two allocation-heavy console
// benchmarks (median of 3): binarytrees 1 MiB => 287 ms, 4 MiB => 120 ms,
// 8 MiB => 97 ms, 12 MiB => 88 ms (saturates), 16 MiB => 88 ms; strings
// 258 => 229 ms. 8 MiB therefore captures 96% of the available win at half the
// memory of 16 MiB (binarytrees peak RSS 9 => 15 MB, vs 23 MB at 16 MiB), and it
// keeps gc_bytes.as's RSS assertion passing untouched. The ceiling on this knob
// is real: examples/gc_alloc_threshold.as churns ~17.8 MB in total, so a floor at
// or above that never fires during it and the regression stops testing the
// trigger at all. Past ~12 MiB neither benchmark gains any more. The adaptive
// inuse/8 term takes over for large live sets, where the floor no longer matters.
// ASC_GC_THRESHOLD still overrides either floor (and is how a memory-tight
// target -- WASI, embedded -- lowers it).
#define GC_NONGUI_FLOOR (8u << 20)

// Collection trigger: start a cycle once this many bytes have been allocated
// since the previous one. Scaling it with the heap keeps the collector's share
// of the frame roughly constant (collect when garbage is ~1/8 of the heap)
// instead of restarting a cycle on a large heap before the previous one could
// finish. The floor keeps small heaps prompt -- 1 MiB when a frame loop will
// slice the cycle, 8 MiB offscreen (see the rationale above).
static size_t gc_trigger(void) {
    static size_t override_threshold = 0;
    static bool resolved = false;
    if (!resolved) {
        const char* e = getenv("ASC_GC_THRESHOLD");
        override_threshold = e ? (size_t)strtoul(e, NULL, 10) : 0;
        resolved = true;
    }
    if (override_threshold != 0) return override_threshold;
    size_t adaptive = gc_dbg_inuse_bytes() / 8;
    size_t floor = gc_frame_driven ? gc_threshold : GC_NONGUI_FLOOR;
    return adaptive > floor ? adaptive : floor;
}

static void gc_step(void) {
    // Reaching this at all means a frame safe point exists (Stage_dispatchFrame is
    // gc_step()'s only caller), which is what makes the incremental path -- and
    // its bounded per-frame pause -- the right one for this program. From here on
    // gc_alloc stops triggering its own stop-the-world collections.
    gc_frame_driven = true;
    if (gc_inc.state == GC_IDLE) {
        // Segment release / allocator trim is rate-limited and idempotent, so it
        // also runs here (every frame) rather than only at a cycle end: a scene
        // that stopped allocating never ends another cycle, and RSS would then
        // stay at the high-water mark forever after the ramp is over.
        gc_release_empty_segs();
        if (gc_bytes_allocated < gc_trigger()) return;
        gc_inc.state = GC_MARK;
        gc_inc.grey_top = 0;  // fresh mark; a previous cycle drains to empty first
        gc_mark_roots();
    }
    if (gc_inc.state == GC_MARK) {
        size_t n = gc_budget();
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
        if (gc_sweep_step(gc_budget())) gc_finish_cycle();
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
        gc_all_bytes += gc_new_bytes; gc_new_bytes = 0;
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
// Same NULL contract as as_str_concat above: a String-typed slot may hold NULL
// (AS3's default for an unset String field), and ES3's ToString(null) is "null".
// Without the substitution a flat '+' chain that now routes here would strlen(NULL).
static char* as_str_concat_n(int n, const char** parts) {
    size_t total = 0;
    for (int i = 0; i < n; i++) total += strlen(parts[i] == NULL ? "null" : parts[i]);
    char* r = as_str_alloc(total + 1);
    char* p = r;
    for (int i = 0; i < n; i++) {
        const char* s = parts[i] == NULL ? "null" : parts[i];
        size_t l = strlen(s);
        memcpy(p, s, l);
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
// ---------- multi-byte charsets (IDataInput/IDataOutput, stage 94-4) ----------
//
// readMultiByte/writeMultiByte bridge the runtime's internal UTF-8 strings and
// the charset named by the AS3 caller. AIR accepts IANA names ('utf-8',
// 'gb2312', 'shift-jis', ...) plus the legacy code-page aliases its own writers
// use, and silently falls back to the OS default legacy encoding for a name it
// does not know -- measured on macOS: an unknown or empty charset encodes
// U+00E9 as the single byte 0x8E, i.e. MacRoman, with '?' for anything that
// charset cannot represent. Only UTF-8 (already the internal encoding, so it is
// copied) and the UTF-16 family (which honours the ByteArray endian property
// and writes no BOM -- both measured) are handled here; every other code page
// goes through the system iconv. Hand-rolling CJK code-page tables is exactly
// the 'link, don't reinvent' case of AGENTS.md 2.9, and the target app uses
// utf-8 / us-ascii / '' / cn-gb / gb2312 / shift-jis / IBM437 / iso-8859-*.
//
// Portability: iconv lives in libiconv on macOS (linked with -liconv) and
// inside libc on Linux/BSD, but the wasm backends (wasi-libc, emscripten) and
// the Windows CRT ship none -- there is no <iconv.h> at all there. There the
// non-UTF-8/UTF-16 charsets throw loudly instead of silently mis-encoding -- a
// cross-backend difference, not a silent downgrade (AGENTS.md 1.5).
// _WIN32 is tested rather than process.platform: this is the *target* platform of
// the generated C, which is what decides whether the header exists.
#if defined(__EMSCRIPTEN__) || defined(__wasi__) || defined(__wasm__) || defined(_WIN32)
#define AS_HAVE_ICONV 0
#else
#define AS_HAVE_ICONV 1
#include <errno.h>
#include <iconv.h>
#endif

// Lowercase and strip '-'/'_'/' '/' .' so 'gb-2312', 'GB_2312' and 'gb2312'
// all normalize to the same key.
static void as_charset_norm(const char* s, char* out, size_t outsz) {
    size_t j = 0;
    for (size_t i = 0; s != NULL && s[i] != 0 && j + 1 < outsz; i++) {
        char c = s[i];
        if (c == '-' || c == '_' || c == ' ' || c == '.') continue;
        if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
        out[j++] = c;
    }
    out[j] = 0;
}
// AIR's unknown-charset fallback is the OS default legacy encoding. macOS
// measured (MacRoman), so this is not guesswork on the platform we verify on;
// the Windows/Linux spelling is the documented ANSI code page equivalent.
static const char* as_charset_platform_default(void) {
#if defined(__APPLE__)
    return "MACINTOSH";
#else
    return "CP1252";
#endif
}
// Resolve an AS3 charset name. Returns 0 when the byte stream is already the
// runtime's UTF-8 encoding (the fast path: no conversion at all), else 1 and
// out holds the iconv target name.
static int as_charset_resolve(const char* charSet, char* out, size_t outsz) {
    char norm[64];
    as_charset_norm(charSet, norm, sizeof norm);
    if (norm[0] == 0) { snprintf(out, outsz, "%s", as_charset_platform_default()); return 1; }
    if (strcmp(norm, "utf8") == 0 || strcmp(norm, "utf") == 0) return 0;
    // 'unicode'/'utf-16' are UTF-16LE with no BOM, and -- measured on adl
    // 51.4.1 -- the ByteArray endian property does NOT affect them (both
    // big-endian and little-endian ByteArrays wrote 41 00 e9 00 2d 4e for
    // 'A','e-acute','CJK'). Only the explicit utf-16be/utf-16le spellings pick
    // the byte order.
    if (strcmp(norm, "unicode") == 0 || strcmp(norm, "utf16") == 0) {
        snprintf(out, outsz, "%s", "UTF-16LE");
        return 1;
    }
    if (strcmp(norm, "unicodele") == 0 || strcmp(norm, "utf16le") == 0) { snprintf(out, outsz, "%s", "UTF-16LE"); return 1; }
    if (strcmp(norm, "unicodebe") == 0 || strcmp(norm, "utf16be") == 0) { snprintf(out, outsz, "%s", "UTF-16BE"); return 1; }
    if (strcmp(norm, "gb2312") == 0 || strcmp(norm, "eucgb") == 0) { snprintf(out, outsz, "%s", "GB2312"); return 1; }
    if (strcmp(norm, "gbk") == 0 || strcmp(norm, "cngb") == 0 || strcmp(norm, "gb18030") == 0 || strcmp(norm, "cp936") == 0) { snprintf(out, outsz, "%s", "GBK"); return 1; }
    if (strcmp(norm, "big5") == 0 || strcmp(norm, "cp950") == 0) { snprintf(out, outsz, "%s", "BIG5"); return 1; }
    if (strcmp(norm, "shiftjis") == 0 || strcmp(norm, "sjis") == 0 || strcmp(norm, "cp932") == 0) { snprintf(out, outsz, "%s", "SHIFT_JIS"); return 1; }
    if (strcmp(norm, "euckr") == 0 || strcmp(norm, "cp949") == 0) { snprintf(out, outsz, "%s", "EUC-KR"); return 1; }
    if (strcmp(norm, "eucjp") == 0) { snprintf(out, outsz, "%s", "EUC-JP"); return 1; }
    if (strcmp(norm, "usascii") == 0 || strcmp(norm, "ascii") == 0) { snprintf(out, outsz, "%s", "US-ASCII"); return 1; }
    if (strcmp(norm, "macroman") == 0 || strcmp(norm, "macintosh") == 0) { snprintf(out, outsz, "%s", "MACINTOSH"); return 1; }
    if (strcmp(norm, "iso88591") == 0 || strcmp(norm, "latin1") == 0 || strcmp(norm, "ansi") == 0) { snprintf(out, outsz, "%s", "ISO-8859-1"); return 1; }
    // Rebuild the canonical iconv spelling for the numbered families.
    if (strncmp(norm, "iso8859", 7) == 0 && norm[7] >= '1' && norm[7] <= '9') { snprintf(out, outsz, "ISO-8859-%s", norm + 7); return 1; }
    if (strncmp(norm, "cp", 2) == 0 && norm[2] >= '0' && norm[2] <= '9') { snprintf(out, outsz, "CP%s", norm + 2); return 1; }
    if (strncmp(norm, "ibm", 3) == 0 && norm[3] != 0) { snprintf(out, outsz, "IBM%s", norm + 3); return 1; }
    if (strncmp(norm, "windows", 7) == 0 && norm[7] != 0) { snprintf(out, outsz, "WINDOWS-%s", norm + 7); return 1; }
    // Unknown name: AIR falls back to the OS default (it never errors), so this
    // follows the measured behaviour instead of inventing a failure mode.
    snprintf(out, outsz, "%s", as_charset_platform_default());
    return 1;
}
// UTF-8 decode of a byte range: keep well-formed sequences, drop invalid lead
// bytes and a truncated tail. AIR's decode is lossy and never throws --
// measured: readMultiByte(2, 'utf-8') over a truncated 3-byte sequence yields
// the empty string rather than an error.
static char* as_multibyte_utf8_decode(const unsigned char* data, unsigned len) {
    char* out = as_str_alloc((size_t)len + 1);
    unsigned j = 0;
    for (unsigned i = 0; i < len; ) {
        unsigned char b = data[i];
        unsigned n;
        if (b < 0x80) n = 1;
        else if ((b & 0xE0) == 0xC0) n = 2;
        else if ((b & 0xF0) == 0xE0) n = 3;
        else if ((b & 0xF8) == 0xF0) n = 4;
        else { i++; continue; }
        if (i + n > len) break;
        bool ok = true;
        for (unsigned k = 1; k < n; k++) if ((data[i + k] & 0xC0) != 0x80) { ok = false; break; }
        if (!ok) { i++; continue; }
        for (unsigned k = 0; k < n; k++) out[j++] = (char)data[i + k];
        i += n;
    }
    out[j] = 0;
    return out;
}
// Open an iconv handle, falling back through the platform default and
// ISO-8859-1 (which iconv always has) so a bogus target name can never reach
// the caller as a NULL handle.
#if AS_HAVE_ICONV
static iconv_t as_iconv_open_fallback(const char* to, const char* name) {
    iconv_t cd = iconv_open(to, name);
    if (cd != (iconv_t)-1) return cd;
    cd = iconv_open(to, as_charset_platform_default());
    if (cd != (iconv_t)-1) return cd;
    return iconv_open(to, "ISO-8859-1");
}
// Decode a byte range from iconv_name into a fresh UTF-8 string. Undecodable
// bytes (EILSEQ) and incomplete trailing sequences (EINVAL) are skipped one byte
// at a time -- the same lossy policy as the UTF-8 path, and the same one AIR
// shows when it drops an incomplete sequence.
static char* as_multibyte_iconv_decode(const unsigned char* data, unsigned len, const char* iconv_name) {
    char* out = as_str_alloc((size_t)len * 4 + 8);
    iconv_t cd = as_iconv_open_fallback("UTF-8", iconv_name);
    if (cd == (iconv_t)-1) {
        memcpy(out, data, (size_t)len);
        out[len] = 0;
        return out;
    }
    size_t cap = (size_t)len * 4 + 8;
    size_t opos = 0;
    char* ip = (char*)data;
    size_t il = (size_t)len;
    while (il > 0) {
        char* op = out + opos;
        size_t ol = cap - opos - 1;
        size_t r = iconv(cd, &ip, &il, &op, &ol);
        opos = (size_t)(op - out);
        if (r != (size_t)-1) break;
        if (errno == E2BIG) continue;
        if (il > 0) { ip++; il--; } else break;
    }
    iconv_close(cd);
    out[opos] = 0;
    return out;
}
// Encode a UTF-8 string into iconv_name, returning a malloc'd buffer the
// caller frees. A character the target cannot represent becomes '?' -- AIR's
// measured behaviour (adl: writeMultiByte(U+00E9, 'ascii') is 0x3F, and CJK
// under an unknown/MacRoman charset is 0x3F too). macOS iconv's own //TRANSLIT
// would emit an ASCII transliteration instead, so this is done by hand.
static unsigned char* as_multibyte_iconv_encode(const char* s, const char* iconv_name, unsigned* out_len) {
    size_t slen = strlen(s);
    size_t cap = slen * 4 + 8;
    unsigned char* out = (unsigned char*)malloc(cap);
    *out_len = 0;
    if (out == NULL) return NULL;
    iconv_t cd = as_iconv_open_fallback(iconv_name, "UTF-8");
    if (cd == (iconv_t)-1) {
        memcpy(out, s, slen);
        *out_len = (unsigned)slen;
        return out;
    }
    size_t opos = 0;
    char* ip = (char*)s;
    size_t il = slen;
    while (il > 0) {
        char* op = (char*)out + opos;
        size_t ol = cap - opos;
        size_t r = iconv(cd, &ip, &il, &op, &ol);
        opos = (size_t)((unsigned char*)op - out);
        if (r != (size_t)-1) break;
        if (errno == E2BIG) {
            cap *= 2;
            unsigned char* bigger = (unsigned char*)realloc(out, cap);
            if (bigger == NULL) { free(out); iconv_close(cd); return NULL; }
            out = bigger;
            continue;
        }
        if (opos < cap) out[opos++] = (unsigned char)'?';
        if (il > 0) { ip++; il--; }
        while (il > 0 && ((unsigned char)*ip & 0xC0) == 0x80) { ip++; il--; }
    }
    iconv_close(cd);
    *out_len = (unsigned)opos;
    return out;
}
#endif
// Decode a byte range named by an AS3 charset (the readMultiByte path). Note
// that the ByteArray/stream endian property does NOT influence this -- see
// as_charset_resolve.
static char* as_multibyte_decode(const unsigned char* data, unsigned len, const char* charSet) {
    char name[64];
    if (as_charset_resolve(charSet, name, sizeof name) == 0) return as_multibyte_utf8_decode(data, len);
#if AS_HAVE_ICONV
    return as_multibyte_iconv_decode(data, len, name);
#else
    as_throw_charset_unsupported(name);
    return as_multibyte_utf8_decode(data, len);
#endif
}
// Encode a string for writeMultiByte; caller frees the returned buffer.
static unsigned char* as_multibyte_encode(const char* s, const char* charSet, unsigned* out_len) {
    char name[64];
    *out_len = 0;
    if (s == NULL) return NULL;
    if (as_charset_resolve(charSet, name, sizeof name) == 0) {
        size_t n = strlen(s);
        unsigned char* out = (unsigned char*)malloc(n > 0 ? n : 1);
        if (out == NULL) return NULL;
        memcpy(out, s, n);
        *out_len = (unsigned)n;
        return out;
    }
#if AS_HAVE_ICONV
    return as_multibyte_iconv_encode(s, name, out_len);
#else
    as_throw_charset_unsupported(name);
    return NULL;
#endif
}
// URL percent-encoding (application/x-www-form-urlencoded). encode leaves
// unreserved chars [A-Za-z0-9-_.~] alone and escapes everything else as %XX;
// decode reverses %XX (invalid sequences are left verbatim).
static bool as_url_is_unreserved(char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
        || c == '-' || c == '_' || c == '.' || c == '~';
}
static int as_url_hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return 0;
}
static char* as_url_encode(const char* s) {
    if (s == NULL) return (char*)"";
    size_t n = strlen(s);
    char* r = as_str_alloc(n * 3 + 1);
    int p = 0;
    static const char hex[] = "0123456789ABCDEF";
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (as_url_is_unreserved((char)c)) r[p++] = (char)c;
        else { r[p++] = '%'; r[p++] = hex[c >> 4]; r[p++] = hex[c & 0xF]; }
    }
    r[p] = 0;
    return r;
}
static char* as_url_decode(const char* s) {
    if (s == NULL) return (char*)"";
    size_t n = strlen(s);
    char* r = as_str_alloc(n + 1);
    int p = 0;
    for (size_t i = 0; i < n; i++) {
        if (s[i] == '%' && i + 2 < n && isxdigit((unsigned char)s[i+1]) && isxdigit((unsigned char)s[i+2])) {
            int hi = as_url_hexval(s[i+1]);
            int lo = as_url_hexval(s[i+2]);
            r[p++] = (char)((hi << 4) | lo);
            i += 2;
        } else {
            r[p++] = s[i];
        }
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

// XMLList index access: list[i] is the i-th XML of the list, and an
// out-of-range (or negative) index is undefined (E4X: the list is not an Array
// and does not throw). Defined here rather than next to the other XML helpers so
// it can use as_v_undefined, which is introduced just above. Plain XML (not an
// XMLList) index access is not modelled and is rejected at compile time.
// XMLList index read: list[i]. An out-of-range or negative index yields the null
// reference -- E4X gives undefined there and does not throw, but this subset
// models the XML/XMLLink slot as a raw node pointer (the xml C type), so a miss
// and an explicit null are the same representation (documented in TODO.md).
static as_xml_node* as_xml_list_get(as_xml_list* l, int i) {
    if (l == NULL || i < 0 || i >= l->length) return NULL;
    return l->items[i];
}

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
            // Remap targets within the atom, INCLUDING the exit sentinel at
            // atomBase+n (a group's trailing JMP jumps to one-past-the-atom;
            // after unrolling that exit must point one-past-the-copy instead).
            if (ins.a >= atomBase && ins.a <= atomBase + n) ins.a += delta;
            if (ins.b >= atomBase && ins.b <= atomBase + n) ins.b += delta;
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
    // Control-character escapes inside a class (backslash-n/r/t/f/v/0) map to
    // their control bytes, not the literal letters n/r/t/f/v/0.
    case 'n': as_re_bits_add(bits, '\\n'); break;
    case 'r': as_re_bits_add(bits, '\\r'); break;
    case 't': as_re_bits_add(bits, '\\t'); break;
    case 'f': as_re_bits_add(bits, '\\f'); break;
    case 'v': as_re_bits_add(bits, '\\v'); break;
    case '0': as_re_bits_add(bits, '\\0'); break;
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
    // Control-character escapes outside a class (backslash-n/r/t/f/v) match the
    // control byte, not the literal letter.
    case 'n': return as_re_emit(re, AS_RE_CHAR, '\\n', 0, 0);
    case 'r': return as_re_emit(re, AS_RE_CHAR, '\\r', 0, 0);
    case 't': return as_re_emit(re, AS_RE_CHAR, '\\t', 0, 0);
    case 'f': return as_re_emit(re, AS_RE_CHAR, '\\f', 0, 0);
    case 'v': return as_re_emit(re, AS_RE_CHAR, '\\v', 0, 0);
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
// sk_text_run is defined unconditionally (a plain C struct, no Skia symbols)
// because the TextField runtime references it even in pure-C builds.
typedef struct { unsigned start; unsigned end; const char* family; double size; int bold; int italic; unsigned color; double leading; } sk_text_run;
// Graphics draw groups (swc.md §9 E). AIR paints each beginFill/endFill group
// independently, so a single "one path + one fill + one stroke" pair cannot
// represent two overlapping fills or two strokes of different colour: the last
// style written would repaint the whole path. Graphics therefore keeps an ORDERED
// list of (path, fill paint, stroke paint) groups and replays it in order. The
// list head/tail live on Graphics; nodes are malloc'd and released by
// Graphics_clear (the same lifetime rule as the SkPath/SkPaint handles they hold).
typedef struct as_gdraw {
    void* path;
    void* fill;
    void* stroke;
    double stroke_width;
    struct as_gdraw* next;
} as_gdraw;

// Mouse pointer shapes. The generated C names the kinds AS_CURSOR_* and the
// window glue keeps its own copies named SK_CURSOR_*; the two lists must stay in
// step. The generated cursor sampler (ASC_cursor_kind_of_name) references them in
// EVERY backend -- with a window, without one (the offscreen PNG build) and in the
// pure-C runtime alike -- so they are defined exactly once here, OUTSIDE the
// backend branches below. Defining them inside a branch is how the documented
// "Skia offscreen, no window" manifest silently stopped compiling: the branch that
// manifest selects had no copy of the enum (2026-10-06, 10 x "use of undeclared
// identifier", examples/skia-link.build.example.json).
#define AS_CURSOR_ARROW  0
#define AS_CURSOR_IBEAM  1
#define AS_CURSOR_HAND   2
#define AS_CURSOR_BUTTON 3
#ifdef ASC_USE_SKIA
extern void* sk_surface_raster_new(int w, int h);
extern int sk_surface_peek_pixels(void* surface, void** pixels, int* rowBytes);
#ifdef ASC_RENDER_GPU
extern void* sk_surface_gpu_new(int w, int h);
extern void sk_gr_flush(void);
// GPU→GPU composite of the Stage3D render target (see skia_glue.cc). Only the web
// GPU build has a Ganesh context to wrap the texture into, so the wrapper below
// no-ops elsewhere.
extern void sk_gl_draw_texture(void* canvas, unsigned textureId, int w, int h, double dx, double dy, double dw, double dh);
#endif
#ifdef ASC_RENDER_WINGPU
// Native window-on-GPU backend. Which concrete backend that is is decided by the
// glue, not here: window_glue.cc's sk_attach_gpu picks it (sk_attach_metal on
// macOS, sk_attach_d3d on Windows) and the backend's own file implements these
// five — metal_glue.mm (macOS, CAMetalLayer) forwards them to its sk_mtl_* pair,
// d3d_glue.cc (Windows) implements them directly against its own ID3D12
// swapchain on the window's HWND. These names being backend-neutral is what lets
// the generated C, the render loop and the build manifest stay free of
// per-backend branches — the backend is already fixed at build time by
// ASC_RENDER_METAL / ASC_RENDER_D3D.
// NOTE: "implemented by both backend files" is a LINK contract, not a runtime
// one. The generated C references sk_gpu_begin_frame/sk_gpu_flush from
// ASC_window_render even when the window loop never calls them, so a backend
// missing any of the five breaks the link of every GPU build on that platform.
// test/unit/platform.ts pins that each of the two files defines every one of
// them (2026-10-09: the five were implemented on D3D12 only, and no test saw it
// because no test builds an AIR app with --air-app).
// GPU surfaces are one-shot by nature (a CAMetalDrawable; a swapchain back buffer
// is only writable between Acquire and Present), so the window render loop
// acquires a fresh canvas each frame via sk_gpu_begin_frame, draws into it, then
// sk_gpu_flush presents it. Unlike the web sk_surface_gpu_new (persistent FBO 0),
// these are frame-scoped and are only linked for native builds where air-app.ts
// adds ASC_RENDER_WINGPU. Every call is keyed by the window id: the backend state
// (layer/drawable/surface, or swapchain/back buffer) is per window, only the
// device/queue/context behind it are shared process-wide.
extern int sk_gpu_init(int id, void* native_handle);
extern void sk_gpu_destroy(int id);
extern void* sk_gpu_begin_frame(int id, int w, int h);
extern void sk_gpu_flush(int id);
extern void sk_gpu_draw_texture(void* canvas, void* backendTexture, int w, int h, double dx, double dy, double dw, double dh);
#endif
extern void* sk_surface_canvas(void* surface);
extern void* sk_surface_make_snapshot(void* surface);
extern void sk_surface_delete(void* surface);
extern void sk_canvas_clear(void* canvas, unsigned rgb);
extern void sk_canvas_clear_transparent(void* canvas);
extern void sk_canvas_save(void* canvas);
extern void sk_canvas_restore(void* canvas);
extern void sk_canvas_translate(void* canvas, double x, double y);
extern void sk_canvas_rotate(void* canvas, double degrees);
extern void sk_canvas_scale(void* canvas, double sx, double sy);
extern void sk_canvas_concat(void* canvas, double a, double b, double c, double d, double tx, double ty);
extern void sk_canvas_save_layer_alpha(void* canvas, double alpha);
extern void sk_canvas_draw_rect(void* canvas, double x, double y, double w, double h, void* paint);
extern void sk_canvas_draw_circle(void* canvas, double cx, double cy, double r, void* paint);
extern void sk_canvas_draw_path(void* canvas, void* path, void* paint);
extern void sk_canvas_clip_rect(void* canvas, double x, double y, double w, double h);
// clipDepth masks (swc.md §9 E-4): a mask shape's outline becomes a clip path.
extern void sk_canvas_clip_path(void* canvas, void* path, int antialias);
extern void sk_canvas_draw_image_src_rect(void* canvas, void* image, double sx, double sy, double sw, double sh, double dx, double dy, double dw, double dh);
extern void sk_canvas_total_scale(void* canvas, double* sx, double* sy);
extern void* sk_paint_new(void);
extern void sk_paint_delete(void* paint);
extern void sk_paint_set_color(void* paint, unsigned rgb);
extern void sk_paint_set_color_argb(void* paint, unsigned argb);
extern void sk_paint_set_alpha(void* paint, double alpha);
extern void sk_paint_set_fill(void* paint);
extern void sk_paint_set_stroke(void* paint);
extern void sk_paint_set_stroke_width(void* paint, double w);
extern void sk_paint_set_antialias(void* paint, int on);
extern void* sk_paint_black_keep_alpha(void);
// Platform clipboard text flavour (flash.desktop.Clipboard). Set copies the
// string (the caller may free its buffer immediately); the getter returns the number
// of bytes written, 0 when the clipboard holds no text. Implemented by the window
// backend, so a skia build without a window (a PNG-only, not-visible air app)
// gets the same no-op stubs as the pure-C build instead of an unresolved link.
#ifdef ASC_USE_WINDOW
extern void sk_clipboard_set_text(const char* text);
extern int sk_clipboard_get_text(char* buf, int cap);
#else
static inline void sk_clipboard_set_text(const char* text) { (void)text; }
static inline int sk_clipboard_get_text(char* buf, int cap) { (void)buf; (void)cap; return 0; }
#endif
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
extern void sk_path_set_even_odd(void* path, int evenOdd);
extern int sk_path_contains(void* path, double x, double y);
extern int sk_path_stroke_contains(void* path, double width, double x, double y);
extern uint32_t sk_path_generation_id(void* path);
extern void sk_path_add_transformed(void* dst, void* src, double a, double b, double c, double d, double tx, double ty);
extern int sk_image_encode_png(void* image, const char* path);
extern void sk_image_delete(void* image);
extern void sk_paint_set_linear_gradient(void* paint, double x0, double y0, double x1, double y1, unsigned rgb0, double a0, unsigned rgb1, double a1);
extern void* sk_image_from_file(const char* path);
extern void* sk_image_from_bytes(const void* data, size_t len);
// Runtime pixel buffer (straight 0xAARRGGBB uint32 words) -> SkImage copy; the
// channel-order/alpha reasoning lives in skia_glue.cc next to the read-back.
extern void* sk_image_from_argb(const void* px, int w, int h);
extern void* sk_image_decode_argb(const char* path, int* width, int* height);
extern void* sk_image_decode_bytes_argb(const void* data, size_t len, int* width, int* height);
// Read a surface back into the runtime's straight-ARGB (0xAARRGGBB) uint32 buffer.
// Channel order is resolved in skia_glue (kN32 differs by platform), so generated
// C never assumes a byte order of a Skia surface.
extern int sk_surface_read_argb(void* surface, uint32_t* dst, int width, int height);
extern void sk_canvas_draw_image_rect(void* canvas, void* image, double dx, double dy, double dw, double dh);
extern void sk_canvas_draw_bgra(void* canvas, const uint8_t* bgra, int w, int h, double dx, double dy, double dw, double dh);
extern void sk_canvas_draw_text(void* canvas, const char* text, double x, double y, double size, int bold, int italic, void* paint);
extern void sk_canvas_draw_text_n(void* canvas, const char* text, int len, double x, double y, double size, int bold, int italic, void* paint);
extern double sk_text_measure(const char* text, double size, int bold, int italic);
extern double sk_text_measure_n(const char* text, int len, double size, int bold, int italic);
extern void* sk_textlayout_new(const char* text, const char* family, double size, int bold, int italic, unsigned color, double width, int align, int collapseNewlines);
extern void* sk_textlayout_new_leading(const char* text, const char* family, double size, int bold, int italic, unsigned color, double leading, double width, int align, int collapseNewlines);
extern double sk_textlayout_height(void* para);
extern double sk_textlayout_max_width(void* para);
extern int sk_textlayout_line_metrics(void* para, int* starts, int* ends, double* tops, double* bottoms, int cap);
extern int sk_textlayout_line_box(void* para, int idx, double leading, const char* family, double size, int bold, int italic, double* ascent, double* descent, double* left, double* width);
extern int sk_textlayout_line_count(void* para);
extern void sk_textlayout_paint(void* para, void* canvas, double x, double y);
extern void sk_textlayout_delete(void* para);
extern int sk_textlayout_glyph_position_at(void* para, double x, double y);
extern int sk_textlayout_rects_for_range(void* para, int start, int end, int skip, double* lefts, double* tops, double* rights, double* bottoms, int max_rects);
// Caret box for a text index (paragraph-relative): where the insertion point is.
// Used by the IME composition preview and by the caret-driven candidate window.
extern int sk_textlayout_caret_rect(void* para, int index, double* x, double* y, double* h);
// A single styled run of a rich-text paragraph (field order/layout must match
// struct sk_text_run in vendor/skia_glue.cc). Ranges are UTF-8 byte offsets into
// the (collapseNewlines-normalized) text, half-open [start, end).
extern void* sk_textlayout_new_runs(const char* text, const sk_text_run* runs, int run_count, double width, int align, int collapseNewlines);
extern void sk_paint_set_image_filter_blur(void* paint, double sigmaX, double sigmaY);
extern void sk_paint_set_image_filter_drop_shadow(void* paint, double dx, double dy, double sigmaX, double sigmaY, unsigned rgb, double alpha, double strength, int drawSource);
extern void sk_paint_set_image_filter_glow(void* paint, double sigmaX, double sigmaY, unsigned rgb, double alpha, double strength);
extern void sk_canvas_save_layer_paint(void* canvas, void* paint);
extern int sk_paint_set_blend(void* paint, const char* name);
extern void sk_canvas_save_layer_paint_bounds(void* canvas, void* paint, double l, double t, double r, double b);
extern int sk_paint_set_gradient(void* paint, int kind, const double* lm, const unsigned* argb, const double* pos, int count, int spread, double focal);
extern int sk_paint_set_bitmap_shader(void* paint, void* image, const double* lm, int repeat, int smooth);
extern void sk_paint_set_stroke_params(void* paint, int cap, int join, double miter);
extern void sk_paint_set_color_matrix(void* paint, const float* m20);

// as_skia_* semantic wrappers: the entry points DisplayObject.render() drives.
// They are static inline so they emit no symbol unless actually called, keeping
// pure-C (ASC_USE_SKIA undefined) builds link-clean.
static inline void* as_skia_surface_new(int w, int h) {
#ifdef ASC_RENDER_GPU
    return sk_surface_gpu_new(w, h);
#else
    return sk_surface_raster_new(w, h);
#endif
}
// Offscreen bake surface (cacheAsBitmap / auto-bake): ALWAYS a CPU raster surface,
// independent of the window backend. Baking into the GPU FBO 0 (web) or a one-shot
// Metal drawable is wrong — the bake needs a persistent, sized offscreen surface
// whose initial contents are undefined on GPU backends but must be cleared to
// transparent. Raster surfaces always start zeroed, so this keeps the transparent
// padding invariant (§ AGENTS.md: cacheAsBitmap stays CPU-raster regardless).
static inline void* as_skia_surface_bake_new(int w, int h) {
    return sk_surface_raster_new(w, h);
}
static inline void* as_skia_surface_canvas(void* s) { return sk_surface_canvas(s); }
static inline void as_skia_surface_delete(void* s) { sk_surface_delete(s); }
static inline void* as_skia_surface_make_snapshot(void* s) { return sk_surface_make_snapshot(s); }
static inline int as_skia_surface_peek_pixels(void* s, void** pixels, int* rowBytes) { return sk_surface_peek_pixels(s, pixels, rowBytes); }
static inline void as_skia_image_delete(void* img) { sk_image_delete(img); }
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
// --- raw paint construction (SWC baked fills, swc.md §9 E) ---
// The style setters are named set_style_* because as_skia_paint_fill /
// as_skia_paint_stroke above already mean "make a whole paint".
static inline void* as_skia_paint_new(void) { return sk_paint_new(); }
static inline void as_skia_paint_set_color_argb(void* p, unsigned argb) { sk_paint_set_color_argb(p, argb); }
static inline void as_skia_paint_set_antialias(void* p, int on) { sk_paint_set_antialias(p, on); }
static inline void as_skia_paint_set_style_fill(void* p) { sk_paint_set_fill(p); }
static inline void as_skia_paint_set_style_stroke(void* p) { sk_paint_set_stroke(p); }
static inline void as_skia_paint_set_stroke_width(void* p, double w) { sk_paint_set_stroke_width(p, w); }
// A paint that forces everything drawn through it to opaque BLACK while keeping
// the coverage in each pixel's alpha. Painted as a saveLayer paint it re-colours
// the whole layer on composite, which is how the selected glyphs of a focused
// TextField are turned black without laying the text out a second time.
static inline void* as_skia_paint_black(void) { return sk_paint_black_keep_alpha(); }
// Clipboard text flavour (flash.desktop.Clipboard): the platform clipboard is the
// only real store, so these go straight out to the glue layer.
static inline void as_clipboard_set_text(const char* t) { sk_clipboard_set_text(t); }
static inline int as_clipboard_get_text(char* buf, int cap) { return sk_clipboard_get_text(buf, cap); }
static inline void as_skia_canvas_clear(void* c, unsigned rgb) { sk_canvas_clear(c, rgb); }
static inline void as_skia_canvas_clear_transparent(void* c) { sk_canvas_clear_transparent(c); }
static inline void as_skia_canvas_draw_rect(void* c, double x, double y, double w, double h, void* p) { sk_canvas_draw_rect(c, x, y, w, h, p); }
static inline void as_skia_canvas_draw_circle(void* c, double cx, double cy, double r, void* p) { sk_canvas_draw_circle(c, cx, cy, r, p); }
static inline void as_skia_canvas_draw_path(void* c, void* path, void* paint) { sk_canvas_draw_path(c, path, paint); }
static inline void as_skia_canvas_clip_rect(void* c, double x, double y, double w, double h) { sk_canvas_clip_rect(c, x, y, w, h); }
static inline void as_skia_canvas_clip_path(void* c, void* path, int aa) { sk_canvas_clip_path(c, path, aa); }
static inline void as_skia_canvas_draw_image_src_rect(void* c, void* img, double sx, double sy, double sw, double sh, double dx, double dy, double dw, double dh) { sk_canvas_draw_image_src_rect(c, img, sx, sy, sw, sh, dx, dy, dw, dh); }
// Device units per logical unit of the current canvas transform (see
// sk_canvas_total_scale). Used by screen-space stroking: TextField's border is
// a 1px line that must not scale with the object.
static inline void as_skia_canvas_total_scale(void* c, double* sx, double* sy) { sk_canvas_total_scale(c, sx, sy); }
static inline void as_skia_canvas_translate(void* c, double x, double y) { sk_canvas_translate(c, x, y); }
static inline void as_skia_canvas_rotate(void* c, double deg) { sk_canvas_rotate(c, deg); }
static inline void as_skia_canvas_scale(void* c, double sx, double sy) { sk_canvas_scale(c, sx, sy); }
static inline void as_skia_canvas_concat(void* c, double a, double b, double cc, double d, double tx, double ty) { sk_canvas_concat(c, a, b, cc, d, tx, ty); }
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
static inline void as_skia_path_set_even_odd(void* p, int evenOdd) { sk_path_set_even_odd(p, evenOdd); }
static inline int as_skia_path_contains(void* p, double x, double y) { return sk_path_contains(p, x, y); }
static inline int as_skia_path_stroke_contains(void* p, double width, double x, double y) { return sk_path_stroke_contains(p, width, x, y); }
static inline unsigned as_skia_path_generation_id(void* p) { return sk_path_generation_id(p); }
static inline void as_skia_path_add_transformed(void* dst, void* src, double a, double b, double c, double d, double tx, double ty) { sk_path_add_transformed(dst, src, a, b, c, d, tx, ty); }
static inline void as_skia_paint_set_linear_gradient(void* p, double x0, double y0, double x1, double y1, unsigned rgb0, double a0, unsigned rgb1, double a1) { sk_paint_set_linear_gradient(p, x0, y0, x1, y1, rgb0, a0, rgb1, a1); }
// SWC rich fills (swc.md §9 E): multi-stop gradients and bitmap shaders placed by
// the SWF fill matrix. 'lm' is the SWF matrix *divided by 20* (gradient space and
// bitmap pixel space are both mapped to pixels by that one matrix), so the callee
// can treat it as "source space -> shape pixels".
static inline int as_skia_paint_set_gradient(void* p, int kind, const double* lm, const unsigned* argb, const double* pos, int count, int spread, double focal) { return sk_paint_set_gradient(p, kind, lm, argb, pos, count, spread, focal); }
static inline int as_skia_paint_set_bitmap_shader(void* p, void* img, const double* lm, int repeat, int smooth) { return sk_paint_set_bitmap_shader(p, img, lm, repeat, smooth); }
static inline void as_skia_paint_set_stroke_params(void* p, int cap, int join, double miter) { sk_paint_set_stroke_params(p, cap, join, miter); }
// A 4x5 AS3 ColorTransform as a Skia colour matrix, applied to a saveLayer paint
// so the whole composited subtree is tinted once (swc.md §9 E).
static inline void as_skia_paint_set_color_matrix(void* p, const float* m20) { sk_paint_set_color_matrix(p, m20); }
static inline void* as_skia_image_from_file(const char* path) { return sk_image_from_file(path); }
static inline void* as_skia_image_from_argb(const void* px, int w, int h) { return sk_image_from_argb(px, w, h); }
// SkImage view of an image already in memory (Loader.load of an http(s)://
// URL). A file view is impossible there: the payload was never a file, so it
// must not be re-opened by name, or the display-list Bitmap would render
// nothing at all.
static inline void* as_skia_image_from_bytes(const void* data, size_t len) { return sk_image_from_bytes(data, len); }
static inline void* as_skia_image_decode_argb(const char* path, int* width, int* height) { return sk_image_decode_argb(path, width, height); }
static inline void* as_skia_image_decode_bytes_argb(const void* data, size_t len, int* width, int* height) { return sk_image_decode_bytes_argb(data, len, width, height); }
static inline int as_skia_surface_read_argb(void* s, uint32_t* dst, int w, int h) { return sk_surface_read_argb(s, dst, w, h); }
static inline void as_skia_canvas_draw_image_rect(void* c, void* img, double dx, double dy, double dw, double dh) { sk_canvas_draw_image_rect(c, img, dx, dy, dw, dh); }
static inline void as_skia_canvas_draw_bgra(void* c, const uint8_t* bgra, int w, int h, double dx, double dy, double dw, double dh) { sk_canvas_draw_bgra(c, bgra, w, h, dx, dy, dw, dh); }
// Composite the Stage3D render target straight from its GL texture — the web
// counterpart of as_skia_gpu_draw_texture (no CPU readback, no re-upload).
static inline void as_skia_gl_draw_texture(void* c, void* tex, int w, int h, double dx, double dy, double dw, double dh) {
#ifdef ASC_RENDER_GPU
    sk_gl_draw_texture(c, (unsigned)(uintptr_t)tex, w, h, dx, dy, dw, dh);
#else
    (void)c; (void)tex; (void)w; (void)h; (void)dx; (void)dy; (void)dw; (void)dh;
#endif
}
static inline void as_skia_canvas_draw_text(void* c, const char* t, double x, double y, double sz, int bold, int italic, void* p) { sk_canvas_draw_text(c, t, x, y, sz, bold, italic, p); }
static inline void as_skia_canvas_draw_text_n(void* c, const char* t, int len, double x, double y, double sz, int bold, int italic, void* p) { sk_canvas_draw_text_n(c, t, len, x, y, sz, bold, italic, p); }
static inline double as_skia_text_measure(const char* t, double sz, int bold, int italic) { return sk_text_measure(t, sz, bold, italic); }
static inline double as_skia_text_measure_n(const char* t, int len, double sz, int bold, int italic) { return sk_text_measure_n(t, len, sz, bold, italic); }
static inline void* as_skia_textlayout_new(const char* t, const char* fam, double sz, int bold, int italic, unsigned color, double w, int align, int collapse) { return sk_textlayout_new(t, fam, sz, bold, italic, color, w, align, collapse); }
static inline void* as_skia_textlayout_new_leading(const char* t, const char* fam, double sz, int bold, int italic, unsigned color, double leading, double w, int align, int collapse) { return sk_textlayout_new_leading(t, fam, sz, bold, italic, color, leading, w, align, collapse); }
static inline void* as_skia_textlayout_new_runs(const char* t, const sk_text_run* runs, int n, double w, int align, int collapse) { return sk_textlayout_new_runs(t, runs, n, w, align, collapse); }
static inline double as_skia_textlayout_height(void* p) { return sk_textlayout_height(p); }
static inline double as_skia_textlayout_max_width(void* p) { return sk_textlayout_max_width(p); }
static inline int as_skia_textlayout_line_count(void* p) { return sk_textlayout_line_count(p); }
static inline int as_skia_textlayout_line_metrics(void* p, int* s, int* e, double* t, double* b, int cap) { return sk_textlayout_line_metrics(p, s, e, t, b, cap); }
static inline int as_skia_textlayout_line_box(void* p, int i, double ld, const char* fam, double sz, int b, int it, double* a, double* d, double* l, double* w) { return sk_textlayout_line_box(p, i, ld, fam, sz, b, it, a, d, l, w); }
static inline void as_skia_textlayout_paint(void* p, void* c, double x, double y) { sk_textlayout_paint(p, c, x, y); }
static inline void as_skia_textlayout_delete(void* p) { sk_textlayout_delete(p); }
static inline int as_skia_textlayout_glyph_position_at(void* p, double x, double y) { return sk_textlayout_glyph_position_at(p, x, y); }
static inline int as_skia_textlayout_rects_for_range(void* p, int s, int e, int skip, double* l, double* t, double* r, double* b, int max) { return sk_textlayout_rects_for_range(p, s, e, skip, l, t, r, b, max); }
static inline int as_skia_textlayout_caret_rect(void* p, int i, double* x, double* y, double* h) { return sk_textlayout_caret_rect(p, i, x, y, h); }
static inline void as_skia_paint_set_blur(void* p, double sx, double sy) { sk_paint_set_image_filter_blur(p, sx, sy); }
static inline void as_skia_paint_set_drop_shadow(void* p, double dx, double dy, double sx, double sy, unsigned rgb, double a, double st, int drawSource) { sk_paint_set_image_filter_drop_shadow(p, dx, dy, sx, sy, rgb, a, st, drawSource); }
static inline void as_skia_paint_set_glow(void* p, double sx, double sy, unsigned rgb, double a, double st) { sk_paint_set_image_filter_glow(p, sx, sy, rgb, a, st); }
static inline void as_skia_canvas_save_layer_paint(void* c, void* p) { sk_canvas_save_layer_paint(c, p); }
// AS3 BlendMode name -> mix operator. Returns 1 when the caller must isolate the
// object in a layer (a real blend mode, or "layer" = pure group isolation), 0 for
// "normal"/unknown.
static inline int as_skia_paint_set_blend(void* p, const char* n) { return sk_paint_set_blend(p, n); }
static inline void as_skia_canvas_save_layer_paint_bounds(void* c, void* p, double l, double t, double r, double b) { sk_canvas_save_layer_paint_bounds(c, p, l, t, r, b); }
#ifdef ASC_USE_WINDOW
// Every window callback takes the window id as its first argument. AIR's
// NativeWindow lets an app open more than one window, so "the window" is no
// longer implicit; passing the id means one generated callback table serves
// every window, and no ambient "current window" global can be clobbered by a
// nested call (a resize during a frame).
// on_key is the keyboard transport: the glue has already translated SDL's
// keysym into AIR's keyCode/charCode (they are not the same numbers) and passes
// an SK_MOD_* bitmask, so the generated C only has to wrap it in a KeyboardEvent
// and dispatch it. Without a window backend no key can arrive.
// Composed text (SDL_TEXTINPUT) arrives down the same on_key channel with the
// reserved type "textInput" and no key codes; the generated C drains the bytes
// with sk_window_text_take and dispatches AIR's TextEvent.TEXT_INPUT.
extern int sk_window_text_take(int id, char* buf, int cap);
// In-progress IME composition (SDL_TEXTEDITING) rides the same on_key channel
// under the reserved type "textEditing"; start/length are the IME's
// selection inside the composition string (UTF-16 code units, -1/0 when none).
extern int sk_window_text_edit_take(int id, char* buf, int cap, int* start, int* length);
// Where the caret is, so the OS puts the IME candidate window next to it.
extern void sk_window_set_text_input_rect(int id, double x, double y, double w, double h);
extern int sk_window_show(void* surface, int w, int h, int pw, int ph, const char* title,
                          int fullscreen,
                          void (*on_mouse)(int, double, double, const char*),
                          void (*on_wheel)(int, double, double, double),
                          void (*on_key)(int, const char*, int, int, int),
                          void (*on_redraw)(int),
                          void (*on_frame)(int),
                          double (*on_frame_delay)(int),
                          void* (*on_resize)(int, int, int, int, int, double),
                          void (*on_close)(int));
extern double sk_window_probe_scale(int w, int h, int highdpi, int* pw, int* ph);
extern int sk_window_get_display_size(int* w, int* h);
// Refresh rate of the display a GIVEN window sits on: with several windows open
// each one paces its own frame clock, so "the app's display" is not well defined.
extern double sk_window_get_display_refresh(int win);
// Display enumeration for flash.display.Screen: the number of attached displays,
// and per display its full rectangle (bounds) plus its usable area (visibleBounds,
// menu bar / Dock excluded). These are two different quantities on the same
// display, which is why they are separate queries.
extern int sk_display_count(void);
extern int sk_display_bounds(int i, int* x, int* y, int* w, int* h);
extern int sk_display_usable_bounds(int i, int* x, int* y, int* w, int* h);
// Dynamic window API behind flash.display.NativeWindow. A window is created
// hidden (adl reports visible=false right after the constructor) with a CPU
// streaming-texture paint path, and is shown/raised by activate().
extern int sk_window_create(int w, int h, const char* title, int resizable, int decorated, int highdpi,
                            int gpu,
                           void (*on_mouse)(int, double, double, const char*),
                           void (*on_wheel)(int, double, double, double),
                           void (*on_key)(int, const char*, int, int, int),
                           void (*on_redraw)(int),
                           void (*on_frame)(int),
                           double (*on_frame_delay)(int),
                           void* (*on_resize)(int, int, int, int, int, double),
                           void (*on_close)(int));
extern void sk_window_attach_surface(int id, void* surface, int pw, int ph);
extern void sk_window_set_visible(int id, int visible);
extern int sk_window_get_visible(int id);
extern void sk_window_set_title(int id, const char* title);
extern void sk_window_set_bounds(int id, int x, int y, int w, int h);
extern void sk_window_get_bounds(int id, int* x, int* y, int* w, int* h);
extern void sk_window_close(int id);
extern int sk_window_is_closed(int id);
extern void sk_window_activate(int id);
// Mouse pointer shape. The kinds themselves are defined once, above the backend
// branches (AS_CURSOR_*). SDL2 has no per-window cursor API and no "button"
// system cursor: the glue applies SDL_SetCursor (which follows the window under
// the pointer) and folds BUTTON onto the arrow.
extern void sk_window_set_cursor(int id, int kind);
extern void sk_window_minimize(int id);
extern void sk_window_maximize(int id);
extern void sk_window_restore(int id);
extern void sk_window_order_front(int id);
extern void sk_window_order_back(int id);
extern int sk_window_display_index(int id);
extern void sk_window_get_pixel_size(int id, int* pw, int* ph);
extern void sk_window_get_client_size(int id, int* lw, int* lh);
extern int sk_window_is_active(int id);
extern void sk_window_set_always_in_front(int id, int on);
extern int sk_window_main(void);
#ifdef ASC_RENDER_WINGPU
// Native GPU window backend: no surface is passed in or handed back — the frame's
// canvas is re-acquired every frame inside on_redraw, so on_resize only reports
// the new stage dims/scale (its return value is ignored).
extern int sk_window_show_gpu(int w, int h, const char* title, int fullscreen,
                                void (*on_mouse)(int, double, double, const char*),
                                void (*on_wheel)(int, double, double, double),
                                void (*on_key)(int, const char*, int, int, int),
                                void (*on_redraw)(int),
                                void (*on_frame)(int),
                                double (*on_frame_delay)(int),
                                void* (*on_resize)(int, int, int, int, int, double),
                                void (*on_close)(int));
#endif
#else
// SKIA WITHOUT A WINDOW (an --air-app whose <initialWindow> is not visible:
// the build renders the stage once into a PNG instead of opening a window). The
// generated ASC_window_* callbacks are emitted unconditionally — they are static
// and unreferenced here, so -O2 drops them — but they still have to COMPILE, and
// the pointer/IME part of the callback set touches these three window entries
// (the AS_CURSOR_* kinds themselves are defined once, above the branches). Same
// no-op treatment as the pure-C block below; the window declarations above are
// dropped, so this cannot accidentally link the backend.
static inline int sk_window_text_take(int id, char* buf, int cap) { (void)id; (void)buf; (void)cap; return 0; }
static inline int sk_window_text_edit_take(int id, char* buf, int cap, int* start, int* length) { (void)id; (void)buf; (void)cap; (void)start; (void)length; return 0; }
static inline void sk_window_set_text_input_rect(int id, double x, double y, double w, double h) { (void)id; (void)x; (void)y; (void)w; (void)h; }
static inline void sk_window_set_cursor(int id, int kind) { (void)id; (void)kind; }
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
// The refresh rate in Hz of the display a given window occupies, or 0 when it
// cannot be determined. This backs Stage.frameRate's "unset" fallback: frameRate
// <= 0 means "follow this window's display" (vsync cadence) rather than a
// hard-coded default.
static inline double as_window_display_refresh(int win) {
#ifdef ASC_USE_WINDOW
    return sk_window_get_display_refresh(win);
#else
    (void)win;
    return 0.0;
#endif
}
// Present the raster surface in an SDL2 window and run the event loop until
// every window has closed. When ASC_USE_WINDOW is not defined (offscreen-only
// build) this is a safe no-op. on_resize lets the AS3 side rebuild the surface
// at the window's new physical size (and re-render) so a resized window never
// stretches the content; on_close reports a window that has actually gone away,
// which is where Event.CLOSE is dispatched.
static inline int as_skia_surface_show_window(void* s, int w, int h, int pw, int ph,
                                              const char* title, int fullscreen,
                                              void (*on_mouse)(int, double, double, const char*),
                                              void (*on_wheel)(int, double, double, double),
                                              void (*on_key)(int, const char*, int, int, int),
                                              void (*on_redraw)(int),
                                              void (*on_frame)(int),
                                              double (*on_frame_delay)(int),
                                              void* (*on_resize)(int, int, int, int, int, double),
                                              void (*on_close)(int)) {
#ifdef ASC_USE_WINDOW
    return sk_window_show(s, w, h, pw, ph, title, fullscreen, on_mouse, on_wheel, on_key, on_redraw, on_frame, on_frame_delay, on_resize, on_close);
#else
    (void)s; (void)w; (void)h; (void)pw; (void)ph; (void)title; (void)fullscreen;
    (void)on_mouse; (void)on_wheel; (void)on_key; (void)on_redraw; (void)on_frame; (void)on_frame_delay; (void)on_resize; (void)on_close; return 0;
#endif
}
// Present the GPU window and run its event loop. This is the ASC_RENDER_WINGPU
// analogue of as_skia_surface_show_window: no surface crosses the boundary because
// the frame's canvas is re-acquired per frame. When ASC_RENDER_WINGPU is not
// defined this is a safe no-op (and never emitted by the render loop).
static inline int as_skia_surface_show_window_gpu(int w, int h,
                                                    const char* title, int fullscreen,
                                                    void (*on_mouse)(int, double, double, const char*),
                                                    void (*on_wheel)(int, double, double, double),
                                                    void (*on_key)(int, const char*, int, int, int),
                                                    void (*on_redraw)(int),
                                                    void (*on_frame)(int),
                                                    double (*on_frame_delay)(int),
                                                    void* (*on_resize)(int, int, int, int, int, double),
                                                    void (*on_close)(int)) {
#ifdef ASC_RENDER_WINGPU
    return sk_window_show_gpu(w, h, title, fullscreen, on_mouse, on_wheel, on_key, on_redraw, on_frame, on_frame_delay, on_resize, on_close);
#else
    (void)w; (void)h; (void)title; (void)fullscreen;
    (void)on_mouse; (void)on_wheel; (void)on_key; (void)on_redraw; (void)on_frame; (void)on_frame_delay; (void)on_resize; (void)on_close; return 0;
#endif
}
// ---------- dynamic window API (flash.display.NativeWindow) ----------
// Thin pass-throughs so the generated C never names the glue layer directly
// (same discipline as every other helper here). Without the window backend a
// NativeWindow cannot exist, so creation fails (-1) and the class's constructor
// reports it.
// Create a NativeWindow's own OS window. The callbacks are passed in rather than
// installed afterwards because a secondary window must be born with the same
// handler set the main window gets in sk_window_show*(): on_redraw is what
// rasterizes and presents it (without it the window stays a black rectangle),
// on_frame ticks its Stage, on_mouse feeds it input, and on_resize is how
// do_resize() learns the replacement surface after a live resize. The generated
// C supplies ASC_window_on_* here; the glue never learns their names.
// The gpu argument picks the backend: 1 = the window-on-GPU backend (a
// CAMetalLayer on macOS, a D3D12 swapchain on Windows, either way with the shared
// GrDirectContext), 0 = the CPU raster surface + SDL streaming texture. It is a
// build-wide capability question as much as a per-window one — without
// ASC_RENDER_WINGPU no GPU window backend is compiled in and the glue downgrades
// the request (see sk_window_create), so the generated C only ever asks for 1 in a
// build that has one.
static inline int as_window_create(int w, int h, const char* title, int resizable, int decorated, int highdpi,
                                   int gpu,
                                   void (*on_mouse)(int, double, double, const char*),
                                   void (*on_wheel)(int, double, double, double),
                                   void (*on_key)(int, const char*, int, int, int),
                                   void (*on_redraw)(int),
                                   void (*on_frame)(int),
                                   double (*on_frame_delay)(int),
                                   void* (*on_resize)(int, int, int, int, int, double),
                                   void (*on_close)(int)) {
#ifdef ASC_USE_WINDOW
    return sk_window_create(w, h, title, resizable, decorated, highdpi, gpu,
                            on_mouse, on_wheel, on_key, on_redraw, on_frame, on_frame_delay, on_resize, on_close);
#else
    (void)w; (void)h; (void)title; (void)resizable; (void)decorated; (void)highdpi; (void)gpu;
    (void)on_mouse; (void)on_wheel; (void)on_key; (void)on_redraw; (void)on_frame;
    (void)on_frame_delay; (void)on_resize; (void)on_close;
    return -1;
#endif
}
static inline void as_window_attach_surface(int id, void* surface, int pw, int ph) {
#ifdef ASC_USE_WINDOW
    sk_window_attach_surface(id, surface, pw, ph);
#else
    (void)id; (void)surface; (void)pw; (void)ph;
#endif
}
static inline void as_window_set_visible(int id, int visible) {
#ifdef ASC_USE_WINDOW
    sk_window_set_visible(id, visible);
#else
    (void)id; (void)visible;
#endif
}
static inline int as_window_get_visible(int id) {
#ifdef ASC_USE_WINDOW
    return sk_window_get_visible(id);
#else
    (void)id; return 0;
#endif
}
static inline void as_window_set_title(int id, const char* title) {
#ifdef ASC_USE_WINDOW
    sk_window_set_title(id, title);
#else
    (void)id; (void)title;
#endif
}
static inline void as_window_set_bounds(int id, int x, int y, int w, int h) {
#ifdef ASC_USE_WINDOW
    sk_window_set_bounds(id, x, y, w, h);
#else
    (void)id; (void)x; (void)y; (void)w; (void)h;
#endif
}
static inline void as_window_get_bounds(int id, int* x, int* y, int* w, int* h) {
#ifdef ASC_USE_WINDOW
    sk_window_get_bounds(id, x, y, w, h);
#else
    (void)id; if (x) *x = 0; if (y) *y = 0; if (w) *w = 0; if (h) *h = 0;
#endif
}
// Requests teardown; the window is retired at the next frame boundary, which is
// what makes NativeWindow.closed remain false for the rest of the call that
// invoked close() (measured against adl).
static inline void as_window_close(int id) {
#ifdef ASC_USE_WINDOW
    sk_window_close(id);
#else
    (void)id;
#endif
}
static inline int as_window_is_closed(int id) {
#ifdef ASC_USE_WINDOW
    return sk_window_is_closed(id);
#else
    (void)id; return 1;
#endif
}
static inline void as_window_activate(int id) {
#ifdef ASC_USE_WINDOW
    sk_window_activate(id);
#else
    (void)id;
#endif
}
// Set the pointer shape for a window. AIR maps MouseCursor to a fixed set of
// system cursors; offscreen-only builds have no pointer at all, so this is a
// no-op there (same convention as the other as_window_* shims).
static inline void as_window_set_cursor(int id, int kind) {
#ifdef ASC_USE_WINDOW
    sk_window_set_cursor(id, kind);
#else
    (void)id; (void)kind;
#endif
}
static inline void as_window_minimize(int id) {
#ifdef ASC_USE_WINDOW
    sk_window_minimize(id);
#else
    (void)id;
#endif
}
static inline void as_window_maximize(int id) {
#ifdef ASC_USE_WINDOW
    sk_window_maximize(id);
#else
    (void)id;
#endif
}
static inline void as_window_restore(int id) {
#ifdef ASC_USE_WINDOW
    sk_window_restore(id);
#else
    (void)id;
#endif
}
static inline void as_window_order_front(int id) {
#ifdef ASC_USE_WINDOW
    sk_window_order_front(id);
#else
    (void)id;
#endif
}
static inline void as_window_order_back(int id) {
#ifdef ASC_USE_WINDOW
    sk_window_order_back(id);
#else
    (void)id;
#endif
}
static inline int as_window_display_index(int id) {
#ifdef ASC_USE_WINDOW
    return sk_window_display_index(id);
#else
    (void)id; return 0;
#endif
}
static inline void as_window_get_pixel_size(int id, int* pw, int* ph) {
#ifdef ASC_USE_WINDOW
    sk_window_get_pixel_size(id, pw, ph);
#else
    (void)id; if (pw) *pw = 0; if (ph) *ph = 0;
#endif
}
static inline void as_window_get_client_size(int id, int* lw, int* lh) {
#ifdef ASC_USE_WINDOW
    sk_window_get_client_size(id, lw, lh);
#else
    (void)id; if (lw) *lw = 0; if (lh) *lh = 0;
#endif
}
static inline int as_window_is_active(int id) {
#ifdef ASC_USE_WINDOW
    return sk_window_is_active(id);
#else
    (void)id; return 0;
#endif
}
static inline void as_window_set_always_in_front(int id, int on) {
#ifdef ASC_USE_WINDOW
    sk_window_set_always_in_front(id, on);
#else
    (void)id; (void)on;
#endif
}
// The main window's id (the one Stage.showWindow created). -1 before it exists.
static inline int as_window_main(void) {
#ifdef ASC_USE_WINDOW
    return sk_window_main();
#else
    return -1;
#endif
}
// Begin a GPU frame on window id: acquire the next one-shot frame canvas and
// return it (or NULL). Paired with as_skia_gpu_flush which presents it.
// No-op otherwise.
static inline void* as_skia_gpu_begin_frame(int id, int w, int h) {
#ifdef ASC_RENDER_WINGPU
    return sk_gpu_begin_frame(id, w, h);
#else
    (void)id; (void)w; (void)h; return NULL;
#endif
}
static inline void as_skia_gpu_flush(int id) {
#ifdef ASC_RENDER_WINGPU
    sk_gpu_flush(id);
#else
    (void)id;
#endif
}
static inline void as_skia_gpu_draw_texture(void* c, void* tex, int w, int h, double dx, double dy, double dw, double dh) {
#ifdef ASC_RENDER_WINGPU
    sk_gpu_draw_texture(c, tex, w, h, dx, dy, dw, dh);
#else
    (void)c; (void)tex; (void)w; (void)h; (void)dx; (void)dy; (void)dw; (void)dh;
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
// ---- display enumeration (flash.display.Screen) ----
// The count is never 0: AIR always has a Screen.mainScreen, so an unreadable
// display list reports one display rather than none.
static inline int as_screen_count(void) {
#ifdef ASC_USE_WINDOW
    int n = sk_display_count();
    return n > 0 ? n : 1;
#else
    return 1;
#endif
}
// Full display rectangle. Without the window backend each query leaves the
// out-params at zero and returns 0, matching the "0 in headless builds"
// convention of Capabilities.screenResolutionX/Y.
static inline int as_screen_bounds(int i, int* x, int* y, int* w, int* h) {
#ifdef ASC_USE_WINDOW
    return sk_display_bounds(i, x, y, w, h);
#else
    (void)i;
    if (x) *x = 0; if (y) *y = 0; if (w) *w = 0; if (h) *h = 0;
    return 0;
#endif
}
// Usable rectangle (menu bar / Dock excluded) — AIR's Screen.visibleBounds.
static inline int as_screen_usable_bounds(int i, int* x, int* y, int* w, int* h) {
#ifdef ASC_USE_WINDOW
    return sk_display_usable_bounds(i, x, y, w, h);
#else
    (void)i;
    if (x) *x = 0; if (y) *y = 0; if (w) *w = 0; if (h) *h = 0;
    return 0;
#endif
}
// Screen.colorDepth. Every desktop backend we target reports 32bpp (adl agrees).
static inline int as_screen_color_depth(void) { return 32; }
#else
// Pure-C builds still emit the Graphics/Shape/Bitmap/TextField C definitions
// (they are dead code unless the program uses those classes); these no-op
// stubs let that code compile and link without a Skia toolchain.
static inline void* as_skia_surface_new(int w, int h) { (void)w; (void)h; return NULL; }
static inline void* as_skia_surface_bake_new(int w, int h) { (void)w; (void)h; return NULL; }
static inline void* as_skia_surface_canvas(void* s) { (void)s; return NULL; }
static inline void as_skia_surface_delete(void* s) { (void)s; }
static inline void* as_skia_surface_make_snapshot(void* s) { (void)s; return NULL; }
static inline int as_skia_surface_peek_pixels(void* s, void** pixels, int* rowBytes) { (void)s; (void)pixels; (void)rowBytes; return 0; }
static inline void as_skia_image_delete(void* img) { (void)img; }
static inline void as_skia_surface_save_png(void* s, const char* path) { (void)s; (void)path; }
static inline void* as_skia_paint_fill(unsigned rgb, double alpha) { (void)rgb; (void)alpha; return NULL; }
static inline void* as_skia_paint_stroke(unsigned rgb, double alpha, double width) { (void)rgb; (void)alpha; (void)width; return NULL; }
static inline void as_skia_paint_delete(void* p) { (void)p; }
static inline void* as_skia_paint_new(void) { return NULL; }
static inline void as_skia_paint_set_color_argb(void* p, unsigned argb) { (void)p; (void)argb; }
static inline void as_skia_paint_set_antialias(void* p, int on) { (void)p; (void)on; }
static inline void as_skia_paint_set_style_fill(void* p) { (void)p; }
static inline void as_skia_paint_set_style_stroke(void* p) { (void)p; }
static inline void as_skia_paint_set_stroke_width(void* p, double w) { (void)p; (void)w; }
static inline void as_skia_canvas_clear(void* c, unsigned rgb) { (void)c; (void)rgb; }
static inline void as_skia_canvas_clear_transparent(void* c) { (void)c; }
static inline void as_skia_canvas_draw_rect(void* c, double x, double y, double w, double h, void* p) { (void)c; (void)x; (void)y; (void)w; (void)h; (void)p; }
// No-Skia builds have no canvas to measure: report 1 (a 1:1 transform), which
// makes the screen-space border fall back to one local unit -- the same thing the
// pure-C rasterizer (if any) would want.
static inline void as_skia_canvas_total_scale(void* c, double* sx, double* sy) { (void)c; if (sx != NULL) *sx = 1.0; if (sy != NULL) *sy = 1.0; }
static inline void as_skia_canvas_draw_circle(void* c, double cx, double cy, double r, void* p) { (void)c; (void)cx; (void)cy; (void)r; (void)p; }
static inline void as_skia_canvas_draw_path(void* c, void* path, void* paint) { (void)c; (void)path; (void)paint; }
static inline void as_skia_canvas_clip_rect(void* c, double x, double y, double w, double h) { (void)c; (void)x; (void)y; (void)w; (void)h; }
static inline void as_skia_canvas_clip_path(void* c, void* path, int aa) { (void)c; (void)path; (void)aa; }
static inline void as_skia_canvas_draw_image_src_rect(void* c, void* img, double sx, double sy, double sw, double sh, double dx, double dy, double dw, double dh) { (void)c; (void)img; (void)sx; (void)sy; (void)sw; (void)sh; (void)dx; (void)dy; (void)dw; (void)dh; }
static inline void as_skia_canvas_translate(void* c, double x, double y) { (void)c; (void)x; (void)y; }
static inline void as_skia_canvas_rotate(void* c, double deg) { (void)c; (void)deg; }
static inline void as_skia_canvas_scale(void* c, double sx, double sy) { (void)c; (void)sx; (void)sy; }
static inline void as_skia_canvas_concat(void* c, double a, double b, double cc, double d, double tx, double ty) { (void)c; (void)a; (void)b; (void)cc; (void)d; (void)tx; (void)ty; }
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
// A pure-C build keeps no geometry (the path is NULL), so containment cannot be
// answered here: 0 makes the hit test fall back to the stroke-inclusive bounds --
// the same answer this build gives for every shape query (documented subset).
static inline void as_skia_path_set_even_odd(void* p, int evenOdd) { (void)p; (void)evenOdd; }
static inline int as_skia_path_contains(void* p, double x, double y) { (void)p; (void)x; (void)y; return 0; }
static inline int as_skia_path_stroke_contains(void* p, double width, double x, double y) { (void)p; (void)width; (void)x; (void)y; return 0; }
static inline unsigned as_skia_path_generation_id(void* p) { (void)p; return 0u; }
static inline void as_skia_path_add_transformed(void* dst, void* src, double a, double b, double c, double d, double tx, double ty) { (void)dst; (void)src; (void)a; (void)b; (void)c; (void)d; (void)tx; (void)ty; }
static inline void as_skia_paint_set_linear_gradient(void* p, double x0, double y0, double x1, double y1, unsigned rgb0, double a0, unsigned rgb1, double a1) { (void)p; (void)x0; (void)y0; (void)x1; (void)y1; (void)rgb0; (void)a0; (void)rgb1; (void)a1; }
// PURE-C build: no rasteriser, so rich fills degrade to "no shader" exactly like
// every other Skia stub here. The shape's geometry is still emitted, so the
// build stays measurable; it simply paints nothing.
static inline int as_skia_paint_set_gradient(void* p, int kind, const double* lm, const unsigned* argb, const double* pos, int count, int spread, double focal) { (void)p; (void)kind; (void)lm; (void)argb; (void)pos; (void)count; (void)spread; (void)focal; return 0; }
static inline int as_skia_paint_set_bitmap_shader(void* p, void* img, const double* lm, int repeat, int smooth) { (void)p; (void)img; (void)lm; (void)repeat; (void)smooth; return 0; }
static inline void as_skia_paint_set_stroke_params(void* p, int cap, int join, double miter) { (void)p; (void)cap; (void)join; (void)miter; }
static inline void as_skia_paint_set_color_matrix(void* p, const float* m20) { (void)p; (void)m20; }
static inline void* as_skia_image_from_file(const char* path) { (void)path; return NULL; }
static inline void* as_skia_image_from_argb(const void* px, int w, int h) { (void)px; (void)w; (void)h; return NULL; }
static inline void* as_skia_image_from_bytes(const void* data, size_t len) { (void)data; (void)len; return NULL; }
static inline void* as_skia_image_decode_argb(const char* path, int* width, int* height) { (void)path; (void)width; (void)height; return NULL; }
static inline void* as_skia_image_decode_bytes_argb(const void* data, size_t len, int* width, int* height) { (void)data; (void)len; (void)width; (void)height; return NULL; }
static inline int as_skia_surface_read_argb(void* s, uint32_t* dst, int w, int h) { (void)s; (void)dst; (void)w; (void)h; return 0; }
static inline void as_skia_canvas_draw_image_rect(void* c, void* img, double dx, double dy, double dw, double dh) { (void)c; (void)img; (void)dx; (void)dy; (void)dw; (void)dh; }
static inline void as_skia_canvas_draw_bgra(void* c, const uint8_t* bgra, int w, int h, double dx, double dy, double dw, double dh) { (void)c; (void)bgra; (void)w; (void)h; (void)dx; (void)dy; (void)dw; (void)dh; }
static inline void as_skia_gl_draw_texture(void* c, void* tex, int w, int h, double dx, double dy, double dw, double dh) { (void)c; (void)tex; (void)w; (void)h; (void)dx; (void)dy; (void)dw; (void)dh; }
static inline void as_skia_canvas_draw_text(void* c, const char* t, double x, double y, double sz, int bold, int italic, void* p) { (void)c; (void)t; (void)x; (void)y; (void)sz; (void)bold; (void)italic; (void)p; }
static inline void as_skia_canvas_draw_text_n(void* c, const char* t, int len, double x, double y, double sz, int bold, int italic, void* p) { (void)c; (void)t; (void)len; (void)x; (void)y; (void)sz; (void)bold; (void)italic; (void)p; }
static inline double as_skia_text_measure(const char* t, double sz, int bold, int italic) { (void)t; (void)sz; (void)bold; (void)italic; return 0.0; }
static inline double as_skia_text_measure_n(const char* t, int len, double sz, int bold, int italic) { (void)t; (void)len; (void)sz; (void)bold; (void)italic; return 0.0; }
static inline void* as_skia_textlayout_new(const char* t, const char* fam, double sz, int bold, int italic, unsigned color, double w, int align, int collapse) { (void)t; (void)fam; (void)sz; (void)bold; (void)italic; (void)color; (void)w; (void)align; (void)collapse; return NULL; }
static inline void* as_skia_textlayout_new_leading(const char* t, const char* fam, double sz, int bold, int italic, unsigned color, double leading, double w, int align, int collapse) { (void)t; (void)fam; (void)sz; (void)bold; (void)italic; (void)color; (void)leading; (void)w; (void)align; (void)collapse; return NULL; }
static inline void* as_skia_textlayout_new_runs(const char* t, const sk_text_run* runs, int n, double w, int align, int collapse) { (void)t; (void)runs; (void)n; (void)w; (void)align; (void)collapse; return NULL; }
static inline double as_skia_textlayout_height(void* p) { (void)p; return 0.0; }
static inline double as_skia_textlayout_max_width(void* p) { (void)p; return 0.0; }
static inline int as_skia_textlayout_line_count(void* p) { (void)p; return 0; }
static inline int as_skia_textlayout_line_metrics(void* p, int* s, int* e, double* t, double* b, int cap) { (void)p; (void)s; (void)e; (void)t; (void)b; (void)cap; return 0; }
static inline int as_skia_textlayout_line_box(void* p, int i, double ld, const char* fam, double sz, int b, int it, double* a, double* d, double* l, double* w) { (void)p; (void)i; (void)ld; (void)fam; (void)sz; (void)b; (void)it; (void)a; (void)d; (void)l; (void)w; return 0; }
static inline void as_skia_textlayout_paint(void* p, void* c, double x, double y) { (void)p; (void)c; (void)x; (void)y; }
static inline void as_skia_textlayout_delete(void* p) { (void)p; }
static inline int as_skia_textlayout_glyph_position_at(void* p, double x, double y) { (void)p; (void)x; (void)y; return -1; }
static inline int as_skia_textlayout_rects_for_range(void* p, int s, int e, int skip, double* l, double* t, double* r, double* b, int max) { (void)p; (void)s; (void)e; (void)skip; (void)l; (void)t; (void)r; (void)b; (void)max; return 0; }
static inline int as_skia_textlayout_caret_rect(void* p, int i, double* x, double* y, double* h) { (void)p; (void)i; (void)x; (void)y; (void)h; return 0; }
static inline void as_skia_paint_set_blur(void* p, double sx, double sy) { (void)p; (void)sx; (void)sy; }
static inline void as_skia_paint_set_drop_shadow(void* p, double dx, double dy, double sx, double sy, unsigned rgb, double a, double st, int drawSource) { (void)p; (void)dx; (void)dy; (void)sx; (void)sy; (void)rgb; (void)a; (void)st; (void)drawSource; }
static inline void as_skia_paint_set_glow(void* p, double sx, double sy, unsigned rgb, double a, double st) { (void)p; (void)sx; (void)sy; (void)rgb; (void)a; (void)st; }
static inline void as_skia_canvas_save_layer_paint(void* c, void* p) { (void)c; (void)p; }
static inline int as_skia_paint_set_blend(void* p, const char* n) { (void)p; (void)n; return 0; }
static inline void as_skia_canvas_save_layer_paint_bounds(void* c, void* p, double l, double t, double r, double b) { (void)c; (void)p; (void)l; (void)t; (void)r; (void)b; }
static inline void* as_skia_paint_black(void) { return NULL; }
static inline void as_clipboard_set_text(const char* t) { (void)t; }
static inline int as_clipboard_get_text(char* buf, int cap) { (void)buf; (void)cap; return 0; }
// No window backend -> no text input can arrive; the bridge stays compilable.
static inline int sk_window_text_take(int id, char* buf, int cap) { (void)id; (void)buf; (void)cap; return 0; }
static inline int sk_window_text_edit_take(int id, char* buf, int cap, int* start, int* length) { (void)id; (void)buf; (void)cap; (void)start; (void)length; return 0; }
static inline void sk_window_set_text_input_rect(int id, double x, double y, double w, double h) { (void)id; (void)x; (void)y; (void)w; (void)h; }
static inline int as_skia_surface_show_window(void* s, int w, int h, int pw, int ph, const char* title, int fullscreen, void (*on_mouse)(int, double, double, const char*), void (*on_wheel)(int, double, double, double), void (*on_key)(int, const char*, int, int, int), void (*on_redraw)(int), void (*on_frame)(int), double (*on_frame_delay)(int), void* (*on_resize)(int, int, int, int, int, double), void (*on_close)(int)) { (void)s; (void)w; (void)h; (void)pw; (void)ph; (void)title; (void)fullscreen; (void)on_mouse; (void)on_wheel; (void)on_key; (void)on_redraw; (void)on_frame; (void)on_frame_delay; (void)on_resize; (void)on_close; return 0; }
static inline int as_window_create(int w, int h, const char* title, int resizable, int decorated, int highdpi,
                                   int gpu,
                                   void (*on_mouse)(int, double, double, const char*),
                                   void (*on_wheel)(int, double, double, double),
                                   void (*on_key)(int, const char*, int, int, int),
                                   void (*on_redraw)(int),
                                   void (*on_frame)(int),
                                   double (*on_frame_delay)(int),
                                   void* (*on_resize)(int, int, int, int, int, double),
                                   void (*on_close)(int)) {
    (void)w; (void)h; (void)title; (void)resizable; (void)decorated; (void)highdpi; (void)gpu;
    (void)on_mouse; (void)on_wheel; (void)on_redraw; (void)on_frame;
    (void)on_frame_delay; (void)on_resize; (void)on_close;
    return -1;
}
static inline void as_window_attach_surface(int id, void* surface, int pw, int ph) { (void)id; (void)surface; (void)pw; (void)ph; }
static inline void as_window_set_visible(int id, int visible) { (void)id; (void)visible; }
static inline int as_window_get_visible(int id) { (void)id; return 0; }
static inline void as_window_set_title(int id, const char* title) { (void)id; (void)title; }
static inline void as_window_set_bounds(int id, int x, int y, int w, int h) { (void)id; (void)x; (void)y; (void)w; (void)h; }
static inline void as_window_get_bounds(int id, int* x, int* y, int* w, int* h) { (void)id; if (x) *x = 0; if (y) *y = 0; if (w) *w = 0; if (h) *h = 0; }
static inline void as_window_close(int id) { (void)id; }
static inline int as_window_is_closed(int id) { (void)id; return 1; }
static inline void as_window_activate(int id) { (void)id; }
// A pure-C build has no pointer at all, but the generated cursor sampler still
// compiles against it -- and against the AS_CURSOR_* kinds defined once above the
// backend branches.
static inline void as_window_set_cursor(int id, int kind) { (void)id; (void)kind; }
static inline void as_window_minimize(int id) { (void)id; }
static inline void as_window_maximize(int id) { (void)id; }
static inline void as_window_restore(int id) { (void)id; }
static inline void as_window_order_front(int id) { (void)id; }
static inline void as_window_order_back(int id) { (void)id; }
static inline int as_window_display_index(int id) { (void)id; return 0; }
static inline void as_window_get_pixel_size(int id, int* pw, int* ph) { (void)id; if (pw) *pw = 0; if (ph) *ph = 0; }
static inline void as_window_get_client_size(int id, int* lw, int* lh) { (void)id; if (lw) *lw = 0; if (lh) *lh = 0; }
static inline int as_window_is_active(int id) { (void)id; return 0; }
static inline void as_window_set_always_in_front(int id, int on) { (void)id; (void)on; }
static inline int as_window_main(void) { return -1; }
static inline int as_window_get_display_size(int* w, int* h) { if (w) *w = 0; if (h) *h = 0; return 0; }
static inline int as_screen_count(void) { return 1; }
static inline int as_screen_bounds(int i, int* x, int* y, int* w, int* h) { (void)i; if (x) *x = 0; if (y) *y = 0; if (w) *w = 0; if (h) *h = 0; return 0; }
static inline int as_screen_usable_bounds(int i, int* x, int* y, int* w, int* h) { (void)i; if (x) *x = 0; if (y) *y = 0; if (w) *w = 0; if (h) *h = 0; return 0; }
static inline int as_screen_color_depth(void) { return 32; }
static inline double as_window_device_scale(int w, int h, int* pw, int* ph) { if (pw) *pw = w; if (ph) *ph = h; (void)w; (void)h; return 1.0; }
static inline double as_window_display_refresh(int win) { (void)win; return 0.0; }
#endif

// ---------- asynchronous IO jobs (stage 89-45) ----------
// AIR performs URLLoader / FileStream.openAsync / Loader work *off* the AS3
// thread and dispatches the completion events on the AS3 thread at a frame
// boundary. That is what makes those APIs asynchronous in the only way a
// single-threaded AS3 program can observe:
//   1. the call returns immediately (multiple requests can be in flight at
//      once, and several are processed concurrently),
//   2. the loaded state (URLLoader.data, Loader.content) stays null/undefined
//      until the completion event fires,
//   3. a progress event reports the byte counts before COMPLETE.
// This runtime models all three with one job table and two execution
// strategies, so the observable contract is identical on every target:
//   * ASC_ASYNC_THREADS (native POSIX): a small worker pool runs the blocking
//     read / image decode; the frame boundary drains *finished* jobs only, so a
//     frame never waits for IO. Jobs submitted in the same frame run
//     concurrently, like AIR.
//   * otherwise (WASI / wasm / web / Windows): the work runs inline at submit
//     time, but the result is still staged and only becomes AS3-visible when
//     the frame boundary runs the job's finish thunk. Event ordering is
//     unchanged; only the frame time differs (see docs/zh-cn/as3-semantics.md
//     section 3, decision-divergence table).
//
// Two invariants keep the threaded path safe:
//   A. A worker thread NEVER touches the GC heap (gc_alloc has no locks and the
//      collector assumes a single mutator thread). Every staged result lives in
//      plain malloc memory, and every input a worker needs (path string, fopen
//      mode, byte payload) is copied out of the GC heap at submit time, on the
//      AS3 thread.
//   B. The AS3 target of an in-flight job is marked as a root, so it cannot be
//      collected before its completion fires - AIR likewise keeps an otherwise
//      unreferenced FileStream alive until its pending read completes.
//   C. The table itself (as_jobs/as_job_count/as_job_cap, plus j->dead and j->obj)
//      belongs to the AS3 thread. The only cross-thread handoff is j->state plus
//      the staged result fields, and every access to those happens under
//      as_job_lock. In particular a job becomes visible to the workers only in
//      as_job_publish(), once every input field is filled: a worker claiming a
//      half-built job would fopen() a NULL path and report a spurious IO error
//      (that failure mode was observed before publishing was split out).
//
// Staging is also what fixes the event contract: today URLLoader.data and
// Loader.content are filled inside load(), i.e. before COMPLETE. With the
// staging buffer the assignment happens in the finish thunk, which is the first
// moment AS3 code is allowed to see it.
//
// Jobs are individually malloc'd and referenced through a growable pointer
// array, so submitting a job never moves an existing one: a worker holding a
// job pointer stays valid even while the table grows or the AS3 thread retires
// other entries.

#define AS_JOB_READ_TEXT   1
#define AS_JOB_READ_BYTES  2
#define AS_JOB_IMAGE       3
#define AS_JOB_FS_OPEN     4
#define AS_JOB_DECODE      5
#define AS_JOB_HTTP        6
// Streaming variant of AS_JOB_HTTP (URLStream): identical transfer, but the body
// is appended into the job buffer as it arrives instead of being published once
// at the end, so AS3 can read it while the load is still in flight.
#define AS_JOB_HTTP_STREAM 7
// A job that exists only to deliver an asynchronous failure: the transport asked
// for has no backend in this build (e.g. URLStream over a non-http(s) URL). It is
// a job rather than a direct event so the failure still arrives at a frame
// boundary, like every other load outcome — AIR never reports from load() itself.
#define AS_JOB_UNSUPPORTED  8
// Loader.load of an http(s):// URL: fetch the payload over HTTP and then decode
// it, exactly like AS_JOB_IMAGE decodes a local file. It is a separate kind
// because the fetch needs the HTTP transport (and its staging fields: status,
// headers, redirects), while AS_JOB_IMAGE is a plain file read — feeding a URL
// to fopen() is the silently-wrong behaviour the network seam exists to avoid.
#define AS_JOB_IMAGE_URL   9

#define AS_JOB_QUEUED 0
#define AS_JOB_RUNNING 1
#define AS_JOB_DONE 2
// Thunk collected and about to run (or running) on the AS3 thread. The job stays
// in the table in this state on purpose: see as_async_tick.
#define AS_JOB_FINISHING 3

// Failure kinds. The distinction is observable: a URL that cannot be read is an
// IOErrorEvent (AIR never reports COMPLETE for it), while bytes that cannot be
// decoded still complete with a blank Bitmap in this subset.
#define AS_JOB_ERR_IO 1
#define AS_JOB_ERR_DECODE 2
// The URL asked for a transport this build has no backend for (see the network
// seam below). Kept distinct from AS_JOB_ERR_IO on purpose: the URLLoader thunk
// turns it into an ioError whose text names the real cause, so an http(s):// URL
// is never confused with a missing local file.
#define AS_JOB_ERR_UNSUPPORTED 3

typedef struct as_job {
    int kind;
    int state;      // AS_JOB_QUEUED / RUNNING / DONE
    int dead;       // 1 = superseded by a newer request for the same target
    int error;
    void* obj;      // AS3 target (URLLoader / Loader / FileStream); a GC root
    void (*finish)(void* job);  // runs on the AS3 thread inside a frame boundary
    const unsigned char* bytes; // staged read payload (malloc), NULL when none
    size_t len;
    // Capacity of 'bytes' for AS_JOB_HTTP_STREAM, whose buffer grows on the worker
    // thread as chunks arrive (the other kinds size it once, at submit time).
    size_t bytes_cap;
    void* pixels;   // staged decoded ARGB (malloc), NULL when none
    int width, height;
    unsigned total; // byte count reported via bytesLoaded / bytesTotal
    void* handle;   // fopen result for AS_JOB_FS_OPEN (ownership: see retire)
    char* path;     // malloc copies of the inputs, so workers never read GC memory
    char* mode;
    int binary;
    // HTTP staging (AS_JOB_HTTP): 'path' is the URL, 'mode' the method, and the
    // response body lands in 'bytes'. Unlike the file jobs, the request body is a
    // second buffer (the file jobs' input is a path, not data), so it needs its
    // own malloc copy; 'status' is the response code (0 when there was none).
    unsigned char* body;
    size_t body_len;
    char* user_agent;
    char* content_type;
    // Request headers from URLRequest.requestHeaders, pre-joined on the AS3
    // thread as "Name: Value" header lines (a worker must never walk a GC Array).
    char* request_headers;
    int follow_redirects;
    double idle_timeout;
    // URLRequest.manageCookies (default true, from URLRequestDefaults). AIR's
    // cookie store is per application and shared by every request, so the native
    // backend keeps ONE process-wide jar and this flag is what opts a single
    // transfer in or out of it (stage 89·53).
    int manage_cookies;
    int status;
    // Read cursor for AS_JOB_HTTP_STREAM: bytes before 'consumed' have already
    // been handed to AS3, so bytesAvailable is (len - consumed). Writes happen on
    // the worker (as_stream_append) and reads on the AS3 thread; both take
    // as_job_lock when threads are available.
    size_t consumed;
    // Response metadata (stage 89·51, phases C/D). 'headers' is the raw final
    // response header block; the thunk parses it into URLRequestHeader objects
    // (the runtime cannot construct a generated class). 'eff_url' is the URL
    // after redirects (AIR's HTTPStatusEvent.responseURL), 'redirected' whether
    // any redirect was followed, and 'expected_total' the Content-Length (0 when
    // the response did not carry one — AIR: bytesTotal is then indeterminate).
    unsigned char* headers;
    size_t headers_len;
    char* eff_url;
    int redirected;
    unsigned expected_total;
    // Did the transfer actually START? AIR dispatches Event.OPEN only when the
    // request reaches the transport: a refused connection still opens (verified
    // with adl: open;httpStatus(0);ioError), while a missing LOCAL file never
    // opens at all (adl: httpStatus(0);ioError — no open). A build with no
    // network backend issues no request either, so it does not open.
    int started;
    // PROGRESS watermarks recorded by the transfer and replayed by the thunk.
    unsigned* marks;
    int mark_count;
    int mark_cap;
    int mark_oom;   // the watermark list hit its bound (or ran out of memory)
    // Identity of this job allocation. Only the web backend needs it: it hands the
    // raw pointer to JS and takes entries back after an arbitrary delay, and
    // malloc may hand the SAME address to a later job. Comparing the serial turns
    // that ABA race into a dropped entry rather than a body delivered to the
    // wrong loader.
    unsigned serial;
    // Set when as_job_run only STARTS the transfer (the web fetch): the inline
    // strategy must not mark such a job done, because completion arrives later,
    // from the JS pump at a subsequent frame boundary.
    int pending_async;
    // Backend-supplied failure detail (the browser's fetch error text). AIR's
    // ioError carries a text, and without this every web failure would look
    // alike — a CORS refusal, an offline browser and a dead server included.
    char* err_text;
    // Which bookkeeping 'started'/'status'/'marks' are for, and how much of it has
    // already been dispatched. AIR raises OPEN when the request reaches the
    // transport, HTTP_RESPONSE_STATUS when the head arrives and PROGRESS per data
    // chunk — i.e. WHILE the transfer runs, not all at completion — so the events
    // have to be tracked across frames (see as_net_pre_events in the generated
    // code and the pre-pass in as_async_tick). 'net_events' marks a job whose
    // target is a flash.net URLLoader/URLStream; the flags make the dispatch
    // idempotent so a finish thunk that runs before any tick still reports the
    // same sequence, once.
    int net_events;
    int sent_open;
    int sent_status;
    unsigned marks_sent;
    unsigned last_progress;
} as_job;

static as_job** as_jobs = NULL;
static int as_job_count = 0;
static int as_job_cap = 0;
// Guards against a thunk re-entering the frame boundary (see as_async_tick).
static int as_async_in_tick = 0;

static char* as_job_strdup(const char* s) {
    if (s == NULL) return NULL;
    size_t n = strlen(s) + 1;
    char* p = (char*)malloc(n);
    if (p != NULL) memcpy(p, s, n);
    return p;
}

// Appends to a streaming job's buffer under the job lock. Defined after the lock
// exists (see the streaming section below); forward-declared here because both
// backends append through it from above (the curl write callback, the web pump).
static int as_stream_append(as_job* j, const void* p, size_t n);

// Raised by the generated code: the events AIR dispatches WHILE a flash.net
// transfer is in flight (OPEN / HTTP_RESPONSE_STATUS / PROGRESS). It lives in the
// generated code because it has to construct generated classes (the header array),
// and it is declared here because as_async_tick is what drives it. Defined in
// emit.ts; idempotent, so the finish thunk calls it too.
static void as_net_pre_events(void* job);

// Record a byte-count watermark on the job, so the finish thunk can replay the
// PROGRESS events AS3 never saw (see as_job.marks). Bounded on purpose: PROGRESS
// is a notification (the data is still unavailable while it fires), so a close
// sample is faithful. Shared by the native curl callback and the web fetch pump
// so both backends produce exactly the same event sequence.
static void as_job_mark_append(as_job* j, unsigned loaded) {
    if (j->mark_oom) return;
    if (j->mark_count == j->mark_cap) {
        int cap = (j->mark_cap == 0) ? 16 : j->mark_cap * 2;
        if (cap > 4096) { j->mark_oom = 1; return; }
        unsigned* grown = (unsigned*)realloc(j->marks, (size_t)cap * sizeof(unsigned));
        if (grown == NULL) { j->mark_oom = 1; return; }
        j->marks = grown;
        j->mark_cap = cap;
    }
    j->marks[j->mark_count++] = loaded;
}

// Allocate a job. It is deliberately NOT visible to the workers until
// as_job_publish(): a worker that claimed a half-built job would fopen() a NULL
// path and report a spurious IO error, so every input field is filled first and
// publishing is a separate, final step.
static as_job* as_job_alloc(int kind, void* obj, void (*finish)(void*)) {
    as_job* j = (as_job*)calloc(1, sizeof(as_job));
    if (j == NULL) return NULL;
    static unsigned as_job_serial_next = 0;
    j->serial = ++as_job_serial_next;
    j->kind = kind;
    j->obj = obj;
    j->finish = finish;
    return j;
}

// Grow the pointer array. Must run under as_job_lock (threaded path): a worker
// iterating as_jobs in as_job_claim_locked must never see the block that
// realloc() just freed. Returns 0 when out of memory.
static int as_job_grow(void) {
    if (as_job_count < as_job_cap) return 1;
    int cap = as_job_cap == 0 ? 8 : as_job_cap * 2;
    as_job** grown = (as_job**)realloc(as_jobs, (size_t)cap * sizeof(as_job*));
    if (grown == NULL) return 0;
    as_jobs = grown;
    as_job_cap = cap;
    return 1;
}

// Read a whole file into a malloc buffer. Deliberately NOT as_read_file(): that
// one allocates from the GC heap, which a worker thread must never touch. The
// buffer is NUL-terminated so the text path can copy it straight into a string.
static unsigned char* as_job_read_file(const char* path, size_t* out_len, unsigned* out_total) {
    if (out_len != NULL) *out_len = 0;
    if (out_total != NULL) *out_total = 0;
    if (path == NULL) return NULL;
    FILE* f = fopen(path, "rb");
    if (f == NULL) return NULL;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0) sz = 0;
    unsigned char* buf = (unsigned char*)malloc((size_t)sz + 1);
    size_t n = 0;
    if (buf != NULL) {
        if (sz > 0) n = fread(buf, 1, (size_t)sz, f);
        buf[n] = '\\0';
    }
    fclose(f);
    if (out_len != NULL) *out_len = n;
    if (out_total != NULL) *out_total = (unsigned)n;
    return buf;
}

// ---- Network seam (docs/zh-cn/flash-net.md §4.1.1) --------------------------
//
// There is no single library that covers native + web + WASI: browsers forbid
// raw TCP and WASI preview1 has no sockets at all, so the transport is a seam
// with one backend per target rather than one portable HTTP library. Each backend
// is OPT-IN and named by the build layer through a define:
//
//   ASC_HAVE_CURL   native: libcurl (manifest: link-libs ["curl"] +
//                   defines ["ASC_HAVE_CURL"], see docs/zh-cn/compile.md)
//   ASC_HAVE_FETCH  web (Emscripten): the page's own fetch(), which is the only
//                   HTTP client a browser sandbox permits
//   ASC_HTTP2       native: ask for HTTP/2 over TLS (ALPN, automatic 1.1
//                   fallback). OFF by default — see the CURLOPT_HTTP_VERSION
//                   note in as_http_perform.
//   ASC_SYSTEM_PROXY native + macOS: fall back to the operating system's proxy
//                   configuration when no *_proxy variable is exported (what
//                   AIR does: there is no AS3 proxy API). Needs
//                   -framework SystemConfiguration.
//
// Keeping both opt-in is what preserves the default build's zero-dependency,
// self-contained shape. With no backend the http(s):// path still runs —
// through the async job table, so the async contract holds — but as_job_run
// reports AS_JOB_ERR_UNSUPPORTED. That is phase G of the design doc: an honest,
// *distinguishable* failure instead of feeding the URL to fopen() and reporting
// the same generic error a missing file produces.
#if defined(ASC_HAVE_CURL) && !defined(__wasi__) && !defined(__EMSCRIPTEN__)
#define ASC_HTTP_BACKEND 1
#include <curl/curl.h>
// pthread.h is POSIX-only; Windows has no such header. libcurl on Win32 uses its
// own native (winthread) internals, and our share-lock callbacks below are
// backed by CRITICAL_SECTION there instead of pthread_mutex.
#ifndef _WIN32
#include <pthread.h>
#endif
#elif defined(ASC_HAVE_FETCH) && defined(__EMSCRIPTEN__)
#define ASC_HTTP_WEB 1
#endif

#if defined(ASC_HTTP_BACKEND) || defined(ASC_HTTP_WEB)
// The Content-Type this transfer must actually declare, or NULL. This is NOT
// URLRequest.contentType -- that property stays NULL on a fresh request, exactly
// as adl reports it. The AS3 docs print "application/x-www-form-urlencoded" as
// the property's default value, but a local capture server shows adl uses it as
// the WIRE default instead: a request that carries a body and declared no (or an
// empty) content type goes out with that MIME string, while req.contentType
// still reads back NULL. Conflating the two is what made our property value
// disagree with AIR (and broke an example that asserts the real default).
// Measured rule (adl 51.3.4, POST/GET to a local logging server):
//   POST body, contentType unset      -> application/x-www-form-urlencoded
//   POST body, contentType = ""       -> application/x-www-form-urlencoded
//   POST body, contentType set        -> that value, verbatim
//   POST with NO body (Content-Length 0) -> no Content-Type at all
//   GET (data folded into the query string) -> no Content-Type at all
// So the trigger is "has a body", not "is a POST"; both backends share this one
// helper so the wire behaviour cannot drift between them.
static const char* as_http_effective_ctype(const as_job* j) {
    if (j->body == NULL || j->body_len == 0) return NULL;
    if (j->content_type != NULL && j->content_type[0] != '\\0') return j->content_type;
    return "application/x-www-form-urlencoded";
}
#endif

// Is this load input an http(s):// URL rather than a local path? Loader.load
// accepts both, and the two need different transports — which is why the job
// kind (not just the path) is chosen at submit time, in as_async_submit_image.
// Only the two web schemes count: file:// and an app:// style asset URL are
// local reads, and anything else has no transport here.
static int as_job_is_remote_url(const char* p) {
    if (p == NULL) return 0;
    return (strncmp(p, "http://", 7) == 0) || (strncmp(p, "https://", 8) == 0);
}

#ifdef ASC_HTTP_BACKEND
// libcurl callbacks: both run on a worker thread, so they must never touch the
// GC heap — everything accumulates in plain malloc buffers that the finish
// thunk copies out afterwards.
typedef struct as_http_sink { unsigned char* buf; size_t len; size_t cap; int oom; } as_http_sink;

static int as_http_sink_append(as_http_sink* s, const void* p, size_t n) {
    if (s->oom) return 0;
    if (s->len + n + 1 > s->cap) {
        size_t cap = (s->cap == 0) ? 4096 : s->cap;
        while (cap < s->len + n + 1) cap *= 2;
        unsigned char* grown = (unsigned char*)realloc(s->buf, cap);
        if (grown == NULL) { s->oom = 1; return 0; }
        s->buf = grown;
        s->cap = cap;
    }
    if (n > 0) memcpy(s->buf + s->len, p, n);
    s->len += n;
    s->buf[s->len] = '\\0';
    return 1;
}

// Per-transfer context. URLLoader cannot see the payload while the load runs
// (the job publishes only at a frame boundary), so the body callback records a
// bounded list of byte-count watermarks and the thunk replays them as PROGRESS
// events — that is what turns "one event at the very end" into the documented
// OPEN -> (PROGRESS)* -> COMPLETE sequence. PROGRESS is a notification only
// (data is still unavailable), so a bounded sample is faithful.
typedef struct as_http_ctx {
    as_http_sink body;
    as_http_sink hdr;
    // The job this transfer belongs to: the PROGRESS watermarks and (for a
    // URLStream) the live buffer both live on it, so both backends record them
    // the same way.
    as_job* job;
    // Non-NULL for a URLStream transfer: the body is appended straight into this
    // job's growable buffer (visible to AS3 while the transfer runs), instead of
    // accumulating in 'body' for a single publish at completion.
    as_job* stream;
} as_http_ctx;

static size_t as_http_on_data(char* ptr, size_t size, size_t nmemb, void* userp) {
    as_http_ctx* c = (as_http_ctx*)userp;
    size_t n = size * nmemb;
    if (c->stream != NULL) {
        // URLStream: bytes go straight into the job buffer so AS3 can read them
        // while the transfer is still in flight.
        if (!as_stream_append(c->stream, ptr, n)) return 0;
        as_job_mark_append(c->job, (unsigned)c->stream->len);
        return n;
    }
    if (!as_http_sink_append(&c->body, ptr, n)) return 0;
    as_job_mark_append(c->job, (unsigned)c->body.len);
    return n;
}

// Header callback. A line beginning "HTTP/" opens a new header block, so the
// buffer resets there: every intermediate redirect response is dropped and what
// the thunk parses is the FINAL response's header block — which is what AIR
// reports in HTTPStatusEvent.responseHeaders.
static size_t as_http_on_header(char* ptr, size_t size, size_t nmemb, void* userp) {
    as_http_ctx* c = (as_http_ctx*)userp;
    size_t n = size * nmemb;
    if (n >= 5 && strncmp(ptr, "HTTP/", 5) == 0) {
        c->hdr.len = 0;
        if (c->hdr.buf != NULL) c->hdr.buf[0] = '\\0';
    } else if (!as_http_sink_append(&c->hdr, ptr, n)) {
        return 0;
    }
    return n;
}

// Append each "Name: Value" line of a pre-joined header block to a
// curl header list. Scanned by hand rather than with strtok_r so the code stays
// clear of platform differences. Line breaks are matched by numeric code (10 for
// LF, 13 for CR) because this preamble is a TS template literal, where a plain
// backslash escape would be expanded before the C compiler ever sees it.
static struct curl_slist* as_http_add_headers(struct curl_slist* list, const char* block) {
    const char* p = block;
    while (*p != '\\0') {
        const char* nl = p;
        while (*nl != '\\0' && *nl != 10) nl++;
        size_t n = (size_t)(nl - p);
        if (n > 0 && p[n - 1] == 13) n--;
        if (n > 0) {
            char* line = (char*)malloc(n + 1);
            if (line != NULL) {
                memcpy(line, p, n);
                line[n] = '\\0';
                list = curl_slist_append(list, line);
                free(line);
            }
        }
        p = (*nl == '\\0') ? nl : nl + 1;
    }
    return list;
}

// ---- Transport policy: cookie jar / proxy / HTTP version (stage 89·53) ------
//
// Three knobs that decide HOW a transfer is carried out, as opposed to what is
// sent and what comes back. Each one is tied either to an AS3 input that exists
// or to an explicit opt-in define, because two of them trade AIR fidelity for
// reach:
//
//   cookie jar     URLRequest.manageCookies (a real AIR property, default true)
//   proxy          system configuration (AIR uses it; there is no AS3 API) /
//                  the classic *_proxy variables, which libcurl honours itself
//   HTTP/2         ASC_HTTP2 define — NOT the default (see below)

// The cookie jar. AIR keeps ONE cookie store per application and feeds every
// request from it, so a Set-Cookie on the login POST is already visible to the
// follow-up GET — no explicit handling in the .as code. libcurl keeps cookies on
// the easy handle, so sharing them across transfers means a CURLSH. The lock
// callbacks are not optional here: the transfers run on the worker pool, and two
// threads touching the same cookie list without them is a data race.
static CURLSH* as_http_share = NULL;

#ifdef _WIN32
// Windows has no pthread.h. The Win32 backend runs transfers inline on the AS3
// thread (ASC_ASYNC_THREADS is off below), so the share's cookie jar is never
// actually contended; libcurl still rejects CURLSHOPT_SHARE without a LOCKFUNC,
// so the callbacks below are backed by a CRITICAL_SECTION (correct if threaded
// Win32 curl ever arrives) and one-time init by InitOnceExecuteOnce.
static CRITICAL_SECTION as_http_share_locks[CURL_LOCK_DATA_LAST];
static INIT_ONCE as_http_share_once = INIT_ONCE_STATIC_INIT;

static void as_http_share_lock(CURL* handle, curl_lock_data data, curl_lock_access access, void* userptr) {
    (void)handle; (void)access; (void)userptr;
    EnterCriticalSection(&as_http_share_locks[data]);
}

static void as_http_share_unlock(CURL* handle, curl_lock_data data, void* userptr) {
    (void)handle; (void)userptr;
    LeaveCriticalSection(&as_http_share_locks[data]);
}

static BOOL CALLBACK as_http_share_make_cb(PINIT_ONCE once, PVOID arg, PVOID* ctx) {
    (void)once; (void)arg; (void)ctx;
    int i;
    for (i = 0; i < (int)CURL_LOCK_DATA_LAST; i++) InitializeCriticalSection(&as_http_share_locks[i]);
    as_http_share = curl_share_init();
    if (as_http_share != NULL) {
        curl_share_setopt(as_http_share, CURLSHOPT_SHARE, CURL_LOCK_DATA_COOKIE);
        curl_share_setopt(as_http_share, CURLSHOPT_LOCKFUNC, as_http_share_lock);
        curl_share_setopt(as_http_share, CURLSHOPT_UNLOCKFUNC, as_http_share_unlock);
    }
    return TRUE;
}

static CURLSH* as_http_share_get(void) {
    InitOnceExecuteOnce(&as_http_share_once, as_http_share_make_cb, NULL, NULL);
    return as_http_share;
}
#else
static pthread_mutex_t as_http_share_locks[CURL_LOCK_DATA_LAST];
static pthread_once_t as_http_share_once = PTHREAD_ONCE_INIT;

static void as_http_share_lock(CURL* handle, curl_lock_data data, curl_lock_access access, void* userptr) {
    (void)handle; (void)access; (void)userptr;
    pthread_mutex_lock(&as_http_share_locks[data]);
}

static void as_http_share_unlock(CURL* handle, curl_lock_data data, void* userptr) {
    (void)handle; (void)userptr;
    pthread_mutex_unlock(&as_http_share_locks[data]);
}

static void as_http_share_make(void) {
    int i;
    for (i = 0; i < (int)CURL_LOCK_DATA_LAST; i++) pthread_mutex_init(&as_http_share_locks[i], NULL);
    as_http_share = curl_share_init();
    if (as_http_share != NULL) {
        curl_share_setopt(as_http_share, CURLSHOPT_SHARE, CURL_LOCK_DATA_COOKIE);
        curl_share_setopt(as_http_share, CURLSHOPT_LOCKFUNC, as_http_share_lock);
        curl_share_setopt(as_http_share, CURLSHOPT_UNLOCKFUNC, as_http_share_unlock);
    }
}

// Lazily built, exactly once, on whichever worker gets here first. Safe because
// pthread_once serialises it and because curl_global_init has already run (it is
// called from as_job_publish on the AS3 thread, before any job is claimable).
static CURLSH* as_http_share_get(void) {
    pthread_once(&as_http_share_once, as_http_share_make);
    return as_http_share;
}
#endif

// Does the environment already carry a proxy setting? libcurl reads these itself
// on every transfer, so when one is present the OS must not override it (an
// explicit 'http_proxy=... ./app' is a deliberate instruction, and it is also how
// the proxy path is tested).
static int as_http_env_proxy_set(void) {
    static const char* names[6] = { "http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY" };
    int i;
    for (i = 0; i < 6; i++) { const char* v = getenv(names[i]); if (v != NULL && v[0] != '\\0') return 1; }
    return 0;
}

#ifdef ASC_SYSTEM_PROXY
// The operating system's proxy configuration, read by a host-side helper in
// vendor/sysproxy_glue.c. It CANNOT be written here: the SystemConfiguration (and
// even CoreFoundation) headers pull in MacTypes.h, which defines struct Point —
// exactly the name the flash.geom.Point class of this file compiles to. Keeping
// the Apple headers in a separate translation unit is what lets the generated C
// stay header-free and self-contained.
//
// Returns 1 when the OS has a proxy configured for this URL; both out buffers are
// NUL-terminated "host:port" / comma-separated bypass lists, or empty.
extern int as_sysproxy_get(const char* url, char* proxy, int proxy_cap, char* noproxy, int noproxy_cap);
#endif

// The blocking transfer, called from as_job_run — i.e. on a worker thread
// whenever ASC_ASYNC_THREADS is set (it is, on every POSIX native target), so
// the AS3 thread never blocks on the network. A 4xx/5xx is NOT a curl error:
// the status is carried out and the thunk decides what AIR would dispatch.
// Shared by URLLoader (ctx->stream == NULL: one body buffer, published at the
// end) and URLStream (ctx->stream != NULL: appended live into the job).
static void as_http_perform(as_job* j, as_http_ctx* ctx) {
    CURL* h = curl_easy_init();
    if (h == NULL) { j->error = AS_JOB_ERR_IO; return; }
    struct curl_slist* hdrs = NULL;
    const char* method = (j->mode != NULL) ? j->mode : "GET";
    int is_post = (strcmp(method, "POST") == 0);
    int has_body = (j->body != NULL && j->body_len > 0);
    curl_easy_setopt(h, CURLOPT_URL, j->path);
    curl_easy_setopt(h, CURLOPT_WRITEFUNCTION, as_http_on_data);
    curl_easy_setopt(h, CURLOPT_WRITEDATA, ctx);
    curl_easy_setopt(h, CURLOPT_HEADERFUNCTION, as_http_on_header);
    curl_easy_setopt(h, CURLOPT_HEADERDATA, ctx);
    curl_easy_setopt(h, CURLOPT_FOLLOWLOCATION, j->follow_redirects ? 1L : 0L);
    curl_easy_setopt(h, CURLOPT_MAXREDIRS, 20L);
    curl_easy_setopt(h, CURLOPT_CONNECTTIMEOUT, 10L);
    curl_easy_setopt(h, CURLOPT_TIMEOUT, 30L);
#ifdef ASC_HTTP2
    // Opt-in HTTP/2 over TLS: ALPN offers h2 first, and libcurl silently falls
    // back to 1.1 when the server does not. It is NOT the default because AIR's
    // transport is HTTP/1.1 and HTTP/2 rewrites something AS3 can see —
    // HTTPStatusEvent.responseHeaders comes back with lower-cased names, no
    // connection-level headers, and server-chosen ordering. Defaulting to 1.1 is
    // what keeps a header-inspecting .as program byte-identical to adl.
    curl_easy_setopt(h, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2TLS);
#else
    // Pin 1.1 explicitly rather than leaving it to libcurl: with an nghttp2-
    // enabled build the library default is "h2 for https", which would make the
    // transport depend on how libcurl was compiled instead of on AIR's behaviour.
    curl_easy_setopt(h, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1);
#endif
    // Cookie jar, gated by URLRequest.manageCookies. "" means "in-memory engine,
    // no file": nothing is expected to survive the process, matching AIR's
    // per-application jar. The share makes it ONE jar: a cookie stored by an
    // earlier request (any URLLoader/URLStream) is sent by this one.
    if (j->manage_cookies) {
        CURLSH* share = as_http_share_get();
        if (share != NULL) curl_easy_setopt(h, CURLOPT_SHARE, share);
        curl_easy_setopt(h, CURLOPT_COOKIEFILE, "");
    }
#ifdef ASC_SYSTEM_PROXY
    // Proxy. When the environment says nothing, consult the OS configuration;
    // when it does, libcurl's own env handling already applies and must not be
    // overridden. Fixed-size stack buffers: a proxy URL and a bypass list are
    // small, and this runs per transfer.
    if (!as_http_env_proxy_set()) {
        char proxy[512];
        char noproxy[2048];
        proxy[0] = '\\0';
        noproxy[0] = '\\0';
        if (as_sysproxy_get(j->path, proxy, (int)sizeof(proxy), noproxy, (int)sizeof(noproxy))) {
            if (proxy[0] != '\\0') curl_easy_setopt(h, CURLOPT_PROXY, proxy);
            if (noproxy[0] != '\\0') curl_easy_setopt(h, CURLOPT_NOPROXY, noproxy);
        }
    }
#endif
    if (j->idle_timeout > 0.0) {
        // AIR's idleTimeout is "time waiting for a response after the connection
        // is established"; libcurl's low-speed pair is the closest equivalent.
        long secs = (long)(j->idle_timeout / 1000.0);
        if (secs < 1) secs = 1;
        curl_easy_setopt(h, CURLOPT_LOW_SPEED_LIMIT, 1L);
        curl_easy_setopt(h, CURLOPT_LOW_SPEED_TIME, secs);
    }
    if (j->user_agent != NULL) curl_easy_setopt(h, CURLOPT_USERAGENT, j->user_agent);
    if (is_post) {
        // POST carries the payload as the body; GET (and everything else) is a
        // plain request whose query string URLLoader_load already folded in.
        curl_easy_setopt(h, CURLOPT_POST, 1L);
        curl_easy_setopt(h, CURLOPT_POSTFIELDS, (j->body != NULL) ? (const char*)j->body : "");
        curl_easy_setopt(h, CURLOPT_POSTFIELDSIZE, (long)j->body_len);
    } else if (strcmp(method, "GET") != 0) {
        // PUT/DELETE/HEAD/OPTIONS and any custom verb need an explicit method;
        // HEAD additionally suppresses the body (CURLOPT_NOBODY).
        curl_easy_setopt(h, CURLOPT_CUSTOMREQUEST, method);
        if (strcmp(method, "HEAD") == 0) curl_easy_setopt(h, CURLOPT_NOBODY, 1L);
        if (has_body) {
            curl_easy_setopt(h, CURLOPT_POSTFIELDS, (const char*)j->body);
            curl_easy_setopt(h, CURLOPT_POSTFIELDSIZE, (long)j->body_len);
        }
    }
    const char* ctype = as_http_effective_ctype(j);
    if (ctype != NULL) {
        char ct[512];
        snprintf(ct, sizeof(ct), "Content-Type: %s", ctype);
        hdrs = curl_slist_append(hdrs, ct);
    } else if (is_post) {
        // libcurl invents "Content-Type: application/x-www-form-urlencoded" for
        // every POST it issues; adl sends NO Content-Type when the request carries
        // no body (measured: POST with Content-Length 0 arrives header-less). An
        // empty-valued entry is how a libcurl default header is switched off.
        hdrs = curl_slist_append(hdrs, "Content-Type:");
    }
    if (j->request_headers != NULL && j->request_headers[0] != '\\0') {
        hdrs = as_http_add_headers(hdrs, j->request_headers);
    }
    if (hdrs != NULL) curl_easy_setopt(h, CURLOPT_HTTPHEADER, hdrs);
    CURLcode rc = curl_easy_perform(h);
    long status = 0;
    curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &status);
    long redirects = 0;
    curl_easy_getinfo(h, CURLINFO_REDIRECT_COUNT, &redirects);
    // CURLINFO_EFFECTIVE_URL returns a pointer OWNED BY THE HANDLE — it is only
    // valid until curl_easy_cleanup, so it must be copied out before the cleanup
    // below (a use-after-cleanup here produced a garbage responseURL).
    char* eff = NULL;
    curl_easy_getinfo(h, CURLINFO_EFFECTIVE_URL, &eff);
    char* eff_copy = as_job_strdup(eff);
    curl_off_t clen = -1;
    curl_easy_getinfo(h, CURLINFO_CONTENT_LENGTH_DOWNLOAD_T, &clen);
    if (hdrs != NULL) curl_slist_free_all(hdrs);
    curl_easy_cleanup(h);
    if (rc != CURLE_OK || ctx->body.oom || ctx->hdr.oom) {
        free(eff_copy);
        free(ctx->body.buf);
        free(ctx->hdr.buf);
        ctx->body.buf = NULL;
        // A stream keeps whatever it already received (AIR leaves partial
        // content readable after an IO error); only the error is recorded.
        j->error = AS_JOB_ERR_IO;
        return;
    }
    j->status = (int)status;
    if (ctx->stream == NULL) {
        j->bytes = ctx->body.buf;
        j->len = ctx->body.len;
    }
    j->total = (unsigned)j->len;
    j->expected_total = (clen >= 0 && clen <= 0xFFFFFFFFLL) ? (unsigned)clen : 0;
    j->headers = ctx->hdr.buf;
    j->headers_len = ctx->hdr.len;
    j->eff_url = eff_copy;
    j->redirected = (redirects > 0) ? 1 : 0;
}

static void as_http_run(as_job* j) {
    as_http_ctx ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.job = j;
    // The request is issued from here on, so the load counts as started: AIR
    // still dispatches OPEN for a refused connection (adl: open;httpStatus(0);ioError).
    j->started = 1;
    as_http_perform(j, &ctx);
}

// URLStream: the body is appended live into the job (ctx.stream), so AS3 can
// read it while the transfer runs. Same option/response handling as URLLoader.
static void as_http_stream_run(as_job* j) {
    as_http_ctx ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.job = j;
    ctx.stream = j;
    j->started = 1;
    as_http_perform(j, &ctx);
}
#elif defined(ASC_HTTP_WEB)
// The web backend: the page's own fetch(), driven from the same job table.
//
// A browser has no threads and no sockets, so this backend does not "run" the
// job the way curl does: as_job_run() only STARTS the fetch (j->pending_async
// keeps the inline publish from declaring it finished), and the JS promise
// records the outcome — body chunks first, then the terminal status — into a
// JS-side queue. as_web_fetch_pump(), called once per frame from as_async_tick,
// drains that queue into the job. Polling is what keeps the C side free of
// JS glue wiring: the alternative, exporting a C callback to the page, would
// mean touching EXPORTED_FUNCTIONS in build.ts and EMSCRIPTEN_KEEPALIVE here,
// and the one frame of latency the queue costs is invisible because every event
// a job produces is dispatched at a frame boundary anyway.
//
// Queue entry kinds. The queue is a single ordered list on purpose: a body chunk
// must land in the streaming buffer before the terminal entry that follows it.
#define AS_WEB_CHUNK 1
#define AS_WEB_DONE 2
#define AS_WEB_ERROR 3

// Locate a job by the raw pointer JS handed back. The pointer is never
// dereferenced blind: it is compared against the live table (and the serial,
// which is what makes a reused malloc address harmless) before use, so a
// cancelled or long-gone job simply drops its late entries.
static as_job* as_job_find(void* p, unsigned serial) {
    for (int i = 0; i < as_job_count; i++) {
        if ((void*)as_jobs[i] == p && as_jobs[i]->serial == serial) return as_jobs[i];
    }
    return NULL;
}

// Start the transfer. Everything the JS side needs is already copied into the
// job (URL, method, headers, body) by as_async_submit_http on the AS3 thread, so
// nothing here can observe a moving GC heap.
EM_JS(void, as_web_fetch_go, (unsigned job, unsigned serial, const char* url, const char* method, const char* headers, const char* ctype, const char* body, int body_len, int follow, int streaming), {
  var Q = globalThis.__ascHttpQ || (globalThis.__ascHttpQ = []);
  var A = globalThis.__ascHttpActive || (globalThis.__ascHttpActive = {});
  var key = job + ':' + serial;
  var CRLF = String.fromCharCode(13) + String.fromCharCode(10);
  var push = function (o) { o.job = job; o.serial = serial; Q.push(o); };
  var fail = function (text) { push({ kind: 3, text: text }); };
  var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  A[key] = ctl;
  var opts = { method: UTF8ToString(method), redirect: follow ? 'follow' : 'manual', headers: {} };
  if (ctl) opts.signal = ctl.signal;
  // URLRequest.contentType is a HEADER on the wire: the curl backend turns it
  // into one (see as_http_perform) and the browser invents nothing on its own --
  // the Content-Type fetch picks by itself only applies to a string/Blob body,
  // never to the Uint8Array passed here. It applies to a request that HAS a body,
  // exactly as in the curl backend. Applied BEFORE the explicit header block so
  // URLRequest.requestHeaders still wins.
  // (Measured against the real endpoint: the same JSON body with no
  // Content-Type is answered "platform ... is required"; with it, a token.)
  if (ctype) {
    var ctv = UTF8ToString(ctype);
    if (ctv.length > 0) opts.headers['Content-Type'] = ctv;
  }
  var block = headers ? UTF8ToString(headers) : "";
  if (block.length > 0) {
    var lines = block.split(CRLF);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      var c = line.indexOf(':');
      if (c > 0) opts.headers[line.substring(0, c).trim()] = line.substring(c + 1).trim();
    }
  }
  if (body_len > 0) opts.body = HEAPU8.slice(body, body + body_len);
  fetch(UTF8ToString(url), opts).then(function (r) {
    delete A[key];
    if (r.type === 'opaqueredirect') {
      // followRedirects=false and the server answered 3xx: the browser refuses to
      // expose a redirect it did not follow, so there is no status, no header and
      // no body to report. Say exactly that rather than dressing it up as a 0.
      fail('the server redirected and followRedirects is false, but a browser does not expose an unfollowed redirect response (no status, no headers, no body are readable)');
      return null;
    }
    var hstr = "";
    r.headers.forEach(function (v, k) { hstr += k + ': ' + v + CRLF; });
    var cl = parseInt(r.headers.get('content-length'), 10);
    var meta = { kind: 2, status: r.status, url: r.url, redirected: r.redirected, headers: hstr, clen: isNaN(cl) ? 0 : cl, text: "" };
    if (!streaming || !r.body) {
      return r.arrayBuffer().then(function (ab) { meta.buf = new Uint8Array(ab); push(meta); });
    }
    // URLStream: deliver the body as it arrives, so bytesAvailable grows while
    // the transfer is still running (that is the whole point of the class).
    var reader = r.body.getReader();
    var pull = function () {
      return reader.read().then(function (res) {
        if (res.done) { push(meta); return; }
        push({ kind: 1, buf: res.value });
        return pull();
      });
    };
    return pull();
  }).catch(function (e) {
    delete A[key];
    if (e && e.name === 'AbortError') return;   // close() cancelled it: no event
    // The browser deliberately hides WHY a cross-origin fetch failed (a CORS
    // refusal and a dead host look identical), so the text names both.
    fail('fetch failed (' + (e && e.message ? e.message : String(e)) + '); for a cross-origin URL this is usually a missing Access-Control-Allow-Origin header');
  });
});

EM_JS(void, as_web_fetch_stop, (unsigned job, unsigned serial), {
  var A = globalThis.__ascHttpActive;
  var key = job + ':' + serial;
  if (!A || !A[key]) return;
  if (A[key]) A[key].abort();
  delete A[key];
});

// Copy one string field of the entry under the pump's cursor into malloc'd
// memory. The UTF-8 length is taken first and the buffer sized exactly.
//
// The bytes are encoded with TextEncoder rather than Emscripten's stringToUTF8:
// the JS library functions are only linked into the build when COMPILED code
// calls them, so reaching for one from an EM_ASM body is a runtime
// ReferenceError (observed: "stringToUTF8 is not defined"). TextEncoder is a
// browser built-in and needs nothing from the Emscripten library.
static char* as_web_take_jsstr(const char* key) {
    int n = EM_ASM_INT({
        var e = globalThis.__ascCur;
        var s = e ? e[UTF8ToString($0)] : 0;
        return s ? new TextEncoder().encode(s).length : 0;
    }, key);
    char* out = (char*)malloc((size_t)n + 1);
    if (out == NULL) return NULL;
    if (n > 0) {
        EM_ASM({
            var e = globalThis.__ascCur;
            var b = new TextEncoder().encode(e[UTF8ToString($1)]);
            HEAPU8.set(b.subarray(0, $2), $0);
        }, (unsigned)(uintptr_t)out, key, n);
    }
    out[n] = '\\0';
    return out;
}

// Drain one entry: bytes first (a chunk must reach the live buffer, and a
// terminal body must be staged, before the job is marked done), then the
// metadata. Returns 0 when the queue is empty.
static int as_web_fetch_pump(void) {
    int consumed = 0;
    for (;;) {
        int kind = EM_ASM_INT({
            var Q = globalThis.__ascHttpQ;
            if (!Q || Q.length === 0) { globalThis.__ascCur = null; return 0; }
            globalThis.__ascCur = Q.shift();
            return globalThis.__ascCur.kind;
        });
        if (kind == 0) break;
        consumed++;
        unsigned jobp = (unsigned)EM_ASM_INT({ return globalThis.__ascCur.job; });
        unsigned serial = (unsigned)EM_ASM_INT({ return globalThis.__ascCur.serial; });
        as_job* j = as_job_find((void*)(uintptr_t)jobp, serial);
        int n = EM_ASM_INT({ var e = globalThis.__ascCur; return (e && e.buf) ? e.buf.length : 0; });
        unsigned char* buf = NULL;
        if (n > 0) {
            buf = (unsigned char*)malloc((size_t)n + 1);
            if (buf != NULL) {
                buf[n] = 0;
                EM_ASM({ var e = globalThis.__ascCur; HEAPU8.set(e.buf, $0); }, (unsigned)(uintptr_t)buf);
            }
        }
        // A cancelled job is skipped, not resurrected: its stream buffer and its
        // loader are already gone.
        if (j != NULL && !j->dead) {
            if (kind == AS_WEB_CHUNK) {
                if (j->kind == AS_JOB_HTTP_STREAM && buf != NULL) {
                    if (as_stream_append(j, buf, (size_t)n)) as_job_mark_append(j, (unsigned)j->len);
                }
                // A URLLoader job has no live buffer to append to; its whole body
                // arrives with the terminal entry (JS only streams for a stream).
            } else if (kind == AS_WEB_DONE) {
                j->status = EM_ASM_INT({ return globalThis.__ascCur.status; });
                j->redirected = EM_ASM_INT({ return globalThis.__ascCur.redirected ? 1 : 0; });
                j->expected_total = (unsigned)EM_ASM_INT({ return globalThis.__ascCur.clen; });
                if (j->kind != AS_JOB_HTTP_STREAM) {
                    j->bytes = buf;
                    j->len = (size_t)n;
                    buf = NULL;   // ownership moved into the job (retire frees it)
                }
                j->total = (unsigned)j->len;
                j->headers = (unsigned char*)as_web_take_jsstr("headers");
                j->headers_len = (j->headers != NULL) ? strlen((char*)j->headers) : 0;
                j->eff_url = as_web_take_jsstr("url");
                j->error = 0;
                j->state = AS_JOB_DONE;
                // A remote image is the one job kind whose payload is needed
                // AFTER the transport stage, and the decode normally happens
                // inside as_job_run -- which on web only started the fetch. Do
                // it here instead, on the AS3 thread at the frame boundary: there
                // is no worker to hide it on, and the cost is bounded by one
                // image per job (a few ms for a photo-sized PNG).
                if (j->kind == AS_JOB_IMAGE_URL) {
                    int w = 0, h = 0;
                    void* px = (j->len > 0) ? as_skia_image_decode_bytes_argb(j->bytes, j->len, &w, &h) : NULL;
                    if (px == NULL) {
                        // Same treatment as the curl branch's failed decode: drop
                        // the payload, keep the received byte count, and let the
                        // thunk report AS3's "unknown type".
                        free((void*)j->bytes);
                        j->bytes = NULL;
                        j->len = 0;
                        j->error = AS_JOB_ERR_DECODE;
                    } else {
                        j->pixels = px;
                        j->width = w;
                        j->height = h;
                    }
                }
            } else {
                j->error = AS_JOB_ERR_IO;
                j->err_text = as_web_take_jsstr("text");
                j->state = AS_JOB_DONE;
            }
        }
        free(buf);
        EM_ASM({ globalThis.__ascCur = null; });
    }
    return consumed;
}

static void as_http_run(as_job* j) {
    const char* method = (j->mode != NULL) ? j->mode : "GET";
    j->pending_async = 1;
    j->started = 1;
    as_web_fetch_go((unsigned)(uintptr_t)j, j->serial, j->path, method, j->request_headers, as_http_effective_ctype(j), (const char*)j->body, (int)j->body_len, j->follow_redirects, 0);
}

// URLStream over fetch: same start, but the body is streamed chunk by chunk into
// the job's live buffer (see the reader loop in as_web_fetch_go).
static void as_http_stream_run(as_job* j) {
    const char* method = (j->mode != NULL) ? j->mode : "GET";
    j->pending_async = 1;
    j->started = 1;
    as_web_fetch_go((unsigned)(uintptr_t)j, j->serial, j->path, method, j->request_headers, as_http_effective_ctype(j), (const char*)j->body, (int)j->body_len, j->follow_redirects, 1);
}
#else
// No backend in this build: fail with a distinguishable error, never a silent
// success and never a hang.
static void as_http_run(as_job* j) {
    j->error = AS_JOB_ERR_UNSUPPORTED;
}
static void as_http_stream_run(as_job* j) {
    j->error = AS_JOB_ERR_UNSUPPORTED;
}
#endif

// The blocking payload, run either on a worker thread or inline (see the two
// execution strategies above). Never allocates from the GC heap, never fires an
// event: its only job is to fill the staging fields.
static void as_job_run(as_job* j) {
    switch (j->kind) {
        case AS_JOB_READ_TEXT:
        case AS_JOB_READ_BYTES: {
            j->bytes = as_job_read_file(j->path, &j->len, &j->total);
            if (j->bytes == NULL) { j->error = AS_JOB_ERR_IO; break; }
            // A local read knows its total up front, and AIR reports it as
            // bytesTotal (adl: progress(2883/2883) for a 2883-byte file). HTTP
            // without Content-Length stays indeterminate (0) instead.
            j->expected_total = (unsigned)j->len;
            j->started = 1;
            break;
        }
        case AS_JOB_IMAGE:
        case AS_JOB_IMAGE_URL:
        case AS_JOB_DECODE: {
            unsigned char* buf = (unsigned char*)j->bytes;
            size_t n = j->len;
            // AS_JOB_IMAGE_URL keeps its fetched payload on the job: the finish
            // thunk still needs the encoded bytes to build the display-list
            // SkImage (there is no file to re-open by name).
            int keep_encoded = 0;
            if (j->kind == AS_JOB_IMAGE_URL) {
#if defined(ASC_HTTP_BACKEND)
                // The same transport URLLoader uses, run here on the worker: one
                // body buffer, published at the end. A 4xx/5xx is not a curl
                // error, so a 404 body reaches the decoder and fails there —
                // which is what AIR reports too ("unknown type").
                as_http_ctx ctx;
                memset(&ctx, 0, sizeof(ctx));
                ctx.job = j;
                as_http_perform(j, &ctx);
                if (j->error != 0) break;
                buf = (unsigned char*)j->bytes;
                n = j->len;
                keep_encoded = 1;
#elif defined(ASC_HTTP_WEB)
                // Browser target: there are no worker threads, so the fetch
                // cannot complete here the way curl does. Start it and leave the
                // job RUNNING -- as_http_run sets pending_async, so as_job_publish
                // does not mark it DONE and no thunk runs yet. as_web_fetch_pump
                // decodes the payload when the terminal entry lands, staging
                // exactly the pair the curl branch stages: pixels for the
                // BitmapData and the encoded bytes the display image is built
                // from. Without this a remote Loader.load on web reported the
                // "no HTTP backend" ioError even though the build HAS one.
                as_http_run(j);
                break;
#else
                // No HTTP backend in this build: report the missing transport
                // (the LoaderInfo ioError names it) instead of decoding nothing.
                j->error = AS_JOB_ERR_UNSUPPORTED;
                break;
#endif
            } else if (j->kind == AS_JOB_IMAGE) {
                // Read the file here, on the worker: the AS3 thread must not pay
                // for the blocking read. AS_JOB_DECODE already holds its payload,
                // copied out of the GC heap at submit time.
                buf = as_job_read_file(j->path, &n, &j->total);
                if (buf == NULL) { j->error = AS_JOB_ERR_IO; break; }
            }
            int w = 0, h = 0;
            void* px = (n > 0) ? as_skia_image_decode_bytes_argb(buf, n, &w, &h) : NULL;
            // The encoded bytes are only needed to decode; free them right away
            // rather than pinning the whole file until the next frame boundary.
            // (Exception: a fetched payload, which the finish thunk still needs.)
            if (!keep_encoded) { free(buf); j->bytes = NULL; j->len = 0; }
            if (px == NULL) { j->error = AS_JOB_ERR_DECODE; break; }
            j->pixels = px;
            j->width = w;
            j->height = h;
            break;
        }
        case AS_JOB_FS_OPEN: {
            if (j->path == NULL) { j->error = AS_JOB_ERR_IO; break; }
            const char* mode = "rb";
            if (j->mode != NULL) {
                if (strcmp(j->mode, "write") == 0) mode = "wb";
                else if (strcmp(j->mode, "append") == 0) mode = "ab";
                else if (strcmp(j->mode, "update") == 0) mode = "r+b";
                // FileMode.READ ("read") is the default: fall through to "rb".
            }
            void* h = (void*)fopen(j->path, mode);
            if (h == NULL) { j->error = AS_JOB_ERR_IO; break; }
            j->handle = h;
            long cur = ftell((FILE*)h);
            fseek((FILE*)h, 0, SEEK_END);
            j->total = (unsigned)ftell((FILE*)h);
            fseek((FILE*)h, cur, SEEK_SET);
            break;
        }
        case AS_JOB_HTTP: {
            as_http_run(j);
            break;
        }
        case AS_JOB_HTTP_STREAM: {
            as_http_stream_run(j);
            break;
        }
        case AS_JOB_UNSUPPORTED: {
            j->error = AS_JOB_ERR_UNSUPPORTED;
            break;
        }
        default: j->error = AS_JOB_ERR_IO; break;
    }
}

// POSIX targets get real threads. WASI Preview 1 has no thread primitives at
// all, and Emscripten threads need -pthread plus SharedArrayBuffer and COOP/COEP
// response headers (which the demo's plain static server does not send) while on
// web the assets are already packed into the in-memory FS, so there is nothing
// left to overlap. Windows is excluded because this preamble has no Win32 thread
// path yet. Those targets keep the inline strategy.
#if !defined(__wasi__) && !defined(__EMSCRIPTEN__) && !defined(_WIN32)
#define ASC_ASYNC_THREADS 1
#endif

#ifdef ASC_ASYNC_THREADS
#include <pthread.h>

// Four workers: enough that the asset fan-out of a loader queue overlaps, small
// enough not to oversubscribe a laptop. Claiming is first-come; there is no
// priority, matching AIR's internal queue.
#define AS_ASYNC_WORKERS 4

static pthread_t as_worker_ids[AS_ASYNC_WORKERS];
static pthread_mutex_t as_job_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t as_job_wake = PTHREAD_COND_INITIALIZER;
static int as_workers_started = 0;

// Requires as_job_lock held.
static as_job* as_job_claim_locked(void) {
    for (int i = 0; i < as_job_count; i++) {
        as_job* j = as_jobs[i];
        if (j != NULL && j->state == AS_JOB_QUEUED && !j->dead) {
            j->state = AS_JOB_RUNNING;
            return j;
        }
    }
    return NULL;
}

static void* as_job_worker(void* arg) {
    (void)arg;
    for (;;) {
        pthread_mutex_lock(&as_job_lock);
        as_job* j = as_job_claim_locked();
        while (j == NULL) {
            pthread_cond_wait(&as_job_wake, &as_job_lock);
            j = as_job_claim_locked();
        }
        pthread_mutex_unlock(&as_job_lock);
        as_job_run(j);
        pthread_mutex_lock(&as_job_lock);
        j->state = AS_JOB_DONE;
        pthread_cond_broadcast(&as_job_wake);
        pthread_mutex_unlock(&as_job_lock);
    }
    return NULL;
}

static void as_async_start_workers(void) {
    if (as_workers_started) return;
    as_workers_started = 1;
    for (int i = 0; i < AS_ASYNC_WORKERS; i++) pthread_create(&as_worker_ids[i], NULL, as_job_worker, NULL);
}
#endif // ASC_ASYNC_THREADS

// Publish a fully built job. This is the instant a worker may claim it, so it
// is also the only place the table is mutated: the supersede scan, the grow and
// the append all happen under as_job_lock, and the wakeup is broadcast after the
// job is in. Returns 0 when it could not be published (out of memory): nothing
// was started, so no event may fire and the caller drops the job silently.
static int as_job_publish(as_job* j) {
#ifdef ASC_HTTP_BACKEND
    // curl_global_init is not thread-safe and must run before any worker thread
    // touches libcurl. Every as_job_publish happens on the AS3 thread, so a plain
    // static guard is enough.
    static int as_curl_ready = 0;
    if (!as_curl_ready) { as_curl_ready = 1; curl_global_init(CURL_GLOBAL_DEFAULT); }
#endif
#ifdef ASC_ASYNC_THREADS
    as_async_start_workers();
    pthread_mutex_lock(&as_job_lock);
#endif
    // A target that already has a job in flight is superseded: AIR restarts the
    // load when load()/openAsync() is called again, and the stale job must not
    // dispatch an event when it lands.
    for (int i = 0; i < as_job_count; i++) {
        as_job* old = as_jobs[i];
        if (old != NULL && old->obj == j->obj) old->dead = 1;
    }
    if (!as_job_grow()) {
#ifdef ASC_ASYNC_THREADS
        pthread_mutex_unlock(&as_job_lock);
#endif
        return 0;
    }
    as_jobs[as_job_count++] = j;
#ifdef ASC_ASYNC_THREADS
    pthread_cond_broadcast(&as_job_wake);
    pthread_mutex_unlock(&as_job_lock);
#else
    // Inline strategy: the payload runs here and now, so the job is already
    // finished when publish returns and the frame boundary only runs the thunk.
    // A job that merely STARTED its transfer (web fetch) is the exception: it
    // stays RUNNING until the JS pump delivers the response at a later frame,
    // otherwise the thunk would run on a job with no status and no body.
    as_job_run(j);
    if (!j->pending_async) j->state = AS_JOB_DONE;
#endif
    return 1;
}

static void as_job_retire(as_job* j);
static void as_job_release(as_job* j);

// Submit a file job for 'obj'. 'finish' runs on the AS3 thread inside a frame
// boundary and is skipped entirely when the job was superseded.
// Returns the job (NULL when nothing could be started) so the generated code can
// tag a flash.net target with as_job_set_net_events; every other caller ignores it.
static void* as_async_submit(int kind, void* obj, void (*finish)(void*), const char* path, const char* mode, int binary) {
    as_job* j = as_job_alloc(kind, obj, finish);
    if (j == NULL) return NULL;  // out of memory: nothing was started, no event fires
    j->path = as_job_strdup(path);
    j->mode = as_job_strdup(mode);
    j->binary = binary;
    if (!as_job_publish(j)) { as_job_retire(j); as_job_release(j); return NULL; }
    return (void*)j;
}

// Submit a job whose input is an in-memory payload (Loader.loadBytes). The bytes
// are copied out of the GC heap NOW, on the AS3 thread: a worker must never read
// GC memory, and the caller is free to dispose of the ByteArray afterwards
// (Starling does exactly that once the LoaderInfo COMPLETE arrives). A failed
// copy is reported as an IO error rather than as silence, so the caller still
// gets an ioError instead of a load that never finishes.
static void as_async_submit_bytes(int kind, void* obj, void (*finish)(void*), const void* data, size_t len) {
    as_job* j = as_job_alloc(kind, obj, finish);
    if (j == NULL) return;
    j->total = (unsigned)len;
    j->len = len;
    if (data != NULL && len > 0) {
        unsigned char* copy = (unsigned char*)malloc(len);
        if (copy == NULL) j->error = AS_JOB_ERR_IO;
        else {
            memcpy(copy, data, len);
            j->bytes = copy;
        }
    }
    if (!as_job_publish(j)) { as_job_retire(j); as_job_release(j); }
}

// Submit an HTTP job. Every input is copied out of the GC heap NOW, on the AS3
// thread: a worker must never read GC memory, and the URLRequest (plus any
// payload string) may be collected immediately after load() returns. An OOM here
// means nothing was started, so no event fires — same contract as as_async_submit.
static void* as_async_submit_http(void* obj, void (*finish)(void*), const char* url, const char* method, const char* user_agent, const char* content_type, const char* request_headers, const void* body, size_t body_len, int binary, int follow_redirects, double idle_timeout, int manage_cookies) {
    as_job* j = as_job_alloc(AS_JOB_HTTP, obj, finish);
    if (j == NULL) return NULL;
    j->path = as_job_strdup(url);
    j->mode = as_job_strdup(method);
    j->user_agent = as_job_strdup(user_agent);
    j->content_type = as_job_strdup(content_type);
    j->request_headers = as_job_strdup(request_headers);
    j->binary = binary;
    j->follow_redirects = follow_redirects;
    j->idle_timeout = idle_timeout;
    j->manage_cookies = manage_cookies;
    if (body != NULL && body_len > 0) {
        unsigned char* copy = (unsigned char*)malloc(body_len);
        if (copy == NULL) { as_job_retire(j); as_job_release(j); return NULL; }
        memcpy(copy, body, body_len);
        j->body = copy;
        j->body_len = body_len;
    }
    if (!as_job_publish(j)) { as_job_retire(j); as_job_release(j); return NULL; }
    return (void*)j;
}

// Submit an image load for 'obj' (Loader.load). The transport is picked from the
// URL: a local path is the pre-existing file read, while http(s):// goes through
// the HTTP transport — so the two are different job kinds rather than one kind
// that guesses. Redirects are followed and the process-wide cookie jar applies,
// both matching what AIR's Loader does (an image URL that 301s is normal, and the
// image request belongs to the same session as the app's other requests).
static void* as_async_submit_image(void* obj, void (*finish)(void*), const char* url) {
    if (!as_job_is_remote_url(url)) return as_async_submit(AS_JOB_IMAGE, obj, finish, url, NULL, 0);
    as_job* j = as_job_alloc(AS_JOB_IMAGE_URL, obj, finish);
    if (j == NULL) return NULL;  // out of memory: nothing was started, no event fires
    j->path = as_job_strdup(url);
    j->follow_redirects = 1;
    j->manage_cookies = 1;
    if (!as_job_publish(j)) { as_job_retire(j); as_job_release(j); return NULL; }
    return (void*)j;
}

// Retire a finished (or superseded) job: release the staging buffers and the
// slot. A FILE* still held by a superseded FS_OPEN job is closed here, because
// its finish thunk never ran and nothing else took ownership.
static void as_job_retire(as_job* j) {
    if (j->kind == AS_JOB_FS_OPEN && j->handle != NULL) {
        fclose((FILE*)j->handle);
        j->handle = NULL;
    }
    free((void*)j->bytes);
    free(j->pixels);
    free(j->path);
    free(j->mode);
    free(j->body);
    free(j->user_agent);
    free(j->content_type);
    free(j->request_headers);
    free(j->headers);
    free(j->eff_url);
    free(j->marks);
    free(j->err_text);
    j->err_text = NULL;
    j->bytes = NULL;
    j->pixels = NULL;
    j->obj = NULL;
}

static void as_job_release(as_job* j) {
    free(j);
}

// ---- flash.net.Socket / ServerSocket / XMLSocket : the socket seam ----------
//
// TCP in flash.net is a DIFFERENT shape from the HTTP job machinery above: a
// socket is long-lived, the app writes to it and receives from it over many
// frames, and a connection can arrive from a peer (ServerSocket). The HTTP jobs
// are one-shot and run on the worker pool, so reusing them for sockets would
// mean a thread per connection plus a cross-thread handoff of the receive
// buffer.
//
// This seam instead keeps every socket on the AS3 thread and NON-BLOCKING, and
// pumps the whole set once per frame from as_async_tick: connect() returns
// immediately (AIR: "connected" is still false right after connect() returns),
// incoming bytes are drained into a per-socket buffer, and the events that the
// pump raises are dispatched at the same frame boundary that already delivers
// every other event. No locks, no shadow buffers, and a listener that calls
// close() mid-dispatch cannot free the socket under the dispatcher (close()
// only marks it dead; reap happens at the end of the pump).
//
// The AS3-visible behaviour (which errors, their ids and texts, the exact event
// order, when writes reach the network, the NUL framing of XMLSocket) is
// measured from adl, not guessed: temp/air-probe/Probe11.as and
// air-probe11-result.txt; see docs/zh-cn/flash-net.md §7.
//
// Targets: POSIX native has sockets. WASI preview 1 has none, Emscripten's
// browser target cannot open raw TCP, and Windows has no path here yet, so those
// get a seam that always fails with "unsupported" — the AS3 side then reports
// the documented ioError instead of silently doing nothing.

#if !defined(__wasi__) && !defined(__EMSCRIPTEN__) && !defined(_WIN32)
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <poll.h>
#include <fcntl.h>
#include <errno.h>
#include <unistd.h>
#define ASC_SOCK_POSIX 1
#endif

// Closing a raw descriptor is the ONE socket operation the platform-neutral part
// of the state machine still needs: as_sock_drop_fd/as_sock_free run on every
// target, including the ones with no backend, where fd is always -1. Wrapping it
// here keeps <unistd.h> out of the non-POSIX builds — WASI and Windows have no
// close() in scope there (WASI has it only under wasi-libc's unistd.h, which this
// seam deliberately does not include), and an undeclared close() is a hard error
// in C99+ even though the guarded call can never run. The POSIX build keeps the
// real close(); every other target gets an inert stub.
#ifdef ASC_SOCK_POSIX
static inline void as_sock_close_fd(int fd) { if (fd >= 0) close(fd); }
#else
static inline void as_sock_close_fd(int fd) { (void)fd; }
#endif

// Socket states. ERRORED and IDLE both mean "no fd"; the difference is that
// ERRORED still owes the caller an ioError.
#define AS_SOCK_IDLE       0
#define AS_SOCK_CONNECTING 1
#define AS_SOCK_CONNECTED  2
#define AS_SOCK_ERRORED    3

// Events the pump raises and the dispatch pass consumes, in this order: a
// connection that arrives and is closed in the same frame must still hand its
// bytes over before the close.
#define AS_SOCK_EV_CONNECT 1
#define AS_SOCK_EV_ACCEPT  2
#define AS_SOCK_EV_DATA    4
#define AS_SOCK_EV_OUTPUT  8
#define AS_SOCK_EV_ERROR   16
#define AS_SOCK_EV_CLOSE   32

// as_sock is malloc'd, never allocated from the GC heap: it holds raw fd state
// and byte buffers, and the GC would have to be taught to trace them. The AS3
// object is instead registered as a ROOT while the socket lives (see
// as_sock_mark_roots), which is what keeps the target alive.
typedef struct as_sock {
    int fd;                 // -1 when there is no open descriptor
    int state;
    int is_server;
    int dead;               // close() called: raise nothing more, reap at the pump tail
    int err;                // errno of the failure behind AS_SOCK_ERRORED (0 = none)
    int unsupported;        // the target has no socket backend at all
    int listening;          // listen() has been called on this bound server socket
    void* obj;              // the AS3 Socket / ServerSocket / XMLSocket instance
    unsigned char* rbuf;    // bytes received and not yet read by AS3
    int rlen, rpos, rcap;
    unsigned char* wbuf;    // bytes written by AS3 and not yet accepted by the transport
    size_t wlen, wpos, wcap;
    int events;             // AS_SOCK_EV_* raised by the pump, consumed by dispatch
    unsigned timeout_ms;    // connect() budget (Socket.timeout, default 20000)
    double started_ms;      // when the connect attempt began
    char local_addr[64];
    int local_port;
    char remote_addr[64];
    int remote_port;
    char url[256];          // the host a failed connect named, for the ioError text
    struct as_sock* accepted;   // server: a peer accepted this pump, not yet dispatched
    int accepted_ready;
} as_sock;

// The registry. Grows by realloc, entries are never removed mid-pump (close()
// only sets dead), so a listener that opens a socket from inside a dispatch can
// never invalidate the pointer the pump is walking.
static as_sock** as_socks = NULL;
static int as_sock_count = 0;
static int as_sock_cap = 0;
static int as_sock_dispatching = 0;

static int as_sock_in_table(as_sock* s) {
    for (int i = 0; i < as_sock_count; i++) if (as_socks[i] == s) return 1;
    return 0;
}

static as_sock* as_sock_new(int is_server) {
    if (as_sock_count >= as_sock_cap) {
        int cap = as_sock_cap == 0 ? 8 : as_sock_cap * 2;
        as_sock** grown = (as_sock**)realloc(as_socks, (size_t)cap * sizeof(as_sock*));
        if (grown == NULL) return NULL;
        as_socks = grown;
        as_sock_cap = cap;
    }
    as_sock* s = (as_sock*)calloc(1, sizeof(as_sock));
    if (s == NULL) return NULL;
    s->fd = -1;
    s->state = AS_SOCK_IDLE;
    s->is_server = is_server;
    s->timeout_ms = 20000;
#ifdef ASC_SOCK_POSIX
    s->unsupported = 0;
#else
    s->unsupported = 1;
#endif
    as_socks[as_sock_count++] = s;
    return s;
}

// Drop the descriptor but KEEP the raised events: a failure that already
// queued an ioError must still be dispatchable after the fd is gone.
static void as_sock_drop_fd(as_sock* s) {
    as_sock_close_fd(s->fd);
    s->fd = -1;
    s->state = AS_SOCK_IDLE;
    s->listening = 0;               // a dropped fd is not accepting connections
}

// close(): AIR dispatches no close event for this (only the peer's close does),
// so the socket is marked dead and the pending events are discarded.
static void as_sock_close(as_sock* s) {
    if (s == NULL) return;
    if (s->accepted != NULL) { as_sock_close(s->accepted); s->accepted = NULL; s->accepted_ready = 0; }
    as_sock_drop_fd(s);
    s->dead = 1;
    s->events = 0;                  // no event of any kind follows an explicit close()
}

static void as_sock_free(as_sock* s) {
    if (s->accepted != NULL) { as_sock_close(s->accepted); s->accepted = NULL; }
    as_sock_close_fd(s->fd);
    free(s->rbuf);
    free(s->wbuf);
    free(s);
}

// Free the dead entries. Only ever called at the end of the pump, never while a
// dispatch is in progress.
static void as_sock_reap(void) {
    if (as_sock_dispatching) return;
    for (int i = 0; i < as_sock_count; ) {
        as_sock* s = as_socks[i];
        if (s != NULL && s->dead) {
            as_sock_free(s);
            for (int k = i; k + 1 < as_sock_count; k++) as_socks[k] = as_socks[k + 1];
            as_sock_count--;
            continue;
        }
        i++;
    }
}

static int as_sock_count_all(void) { return as_sock_count; }
static as_sock* as_sock_at(int i) { return (i >= 0 && i < as_sock_count) ? as_socks[i] : NULL; }
static int as_sock_is_dead(as_sock* s) { return s == NULL || s->dead; }
static int as_sock_state_of(as_sock* s) { return s->state; }
static int as_sock_is_listening(as_sock* s) { return s != NULL && s->is_server && s->listening; }
// Bound = has a local address and port. listen() requires this, and it stays true
// until the socket is closed (bound and listening are separate states, which is
// why ServerSocket.bound and .listening are separate properties).
static int as_sock_is_bound(as_sock* s) { return s != NULL && s->is_server && s->fd >= 0 && s->local_port > 0; }
static int as_sock_events_of(as_sock* s) { return s->events; }
static void as_sock_clear_events(as_sock* s, int bits) { s->events &= ~bits; }
static int as_sock_errno_of(as_sock* s) { return s->err; }
static int as_sock_is_unsupported(as_sock* s) { return s->unsupported; }
static void as_sock_set_obj(as_sock* s, void* obj) { s->obj = obj; }
static void* as_sock_obj_of(as_sock* s) { return s->obj; }
static void as_sock_set_timeout(as_sock* s, unsigned ms) { s->timeout_ms = ms; }
// The text of AIR's socket ioError is "Error #2031: Socket Error. URL: <host>"
// (measured); the host is what the connect attempt was given.
static const char* as_sock_url(as_sock* s) { return s->url; }
static unsigned as_sock_timeout(as_sock* s) { return s->timeout_ms; }
static int as_sock_avail(as_sock* s) { return s->rlen - s->rpos; }
static int as_sock_pending(as_sock* s) { return (int)(s->wlen - s->wpos); }
static const char* as_sock_local_addr(as_sock* s) { return s->local_addr[0] != 0 ? s->local_addr : NULL; }
static int as_sock_local_port(as_sock* s) { return s->local_port; }
static const char* as_sock_remote_addr(as_sock* s) { return s->remote_addr[0] != 0 ? s->remote_addr : NULL; }
static int as_sock_remote_port(as_sock* s) { return s->remote_port; }
static void as_sock_set_no_delay(as_sock* s, int on) {
#ifdef ASC_SOCK_POSIX
    if (s == NULL || s->fd < 0) return;
    int v = on ? 1 : 0;
    setsockopt(s->fd, IPPROTO_TCP, TCP_NODELAY, &v, sizeof(v));
#endif
}

// Format a sockaddr into the text AIR reports (localAddress/remoteAddress).
// POSIX-only: its parameter type struct sockaddr_storage is declared by the
// sys/socket.h include above, so the whole function (callers included) lives
// inside the guard — otherwise its prototype names an incomplete struct on
// WASI/Windows and clang warns [-Wvisibility].
#ifdef ASC_SOCK_POSIX
static void as_sock_fill_addr(const struct sockaddr_storage* ss, char* out, size_t cap, int* port) {
    out[0] = 0;
    if (port != NULL) *port = 0;
    if (ss->ss_family == AF_INET) {
        const struct sockaddr_in* v4 = (const struct sockaddr_in*)ss;
        inet_ntop(AF_INET, &v4->sin_addr, out, (socklen_t)cap);
        if (port != NULL) *port = (int)ntohs(v4->sin_port);
    } else if (ss->ss_family == AF_INET6) {
        const struct sockaddr_in6* v6 = (const struct sockaddr_in6*)ss;
        inet_ntop(AF_INET6, &v6->sin6_addr, out, (socklen_t)cap);
        if (port != NULL) *port = (int)ntohs(v6->sin6_port);
    }
}
#endif

// Remember the addresses the OS assigned, so localPort/remotePort read back the
// real values (AIR reports them once the connection is up).
static void as_sock_capture_addrs(as_sock* s) {
#ifdef ASC_SOCK_POSIX
    struct sockaddr_storage ss;
    socklen_t len = (socklen_t)sizeof(ss);
    if (s->fd >= 0 && getsockname(s->fd, (struct sockaddr*)&ss, &len) == 0) {
        as_sock_fill_addr(&ss, s->local_addr, sizeof(s->local_addr), &s->local_port);
    }
    len = (socklen_t)sizeof(ss);
    if (s->fd >= 0 && getpeername(s->fd, (struct sockaddr*)&ss, &len) == 0) {
        as_sock_fill_addr(&ss, s->remote_addr, sizeof(s->remote_addr), &s->remote_port);
    }
#endif
}

static void as_sock_fail(as_sock* s, int e) { s->err = e; s->state = AS_SOCK_ERRORED; s->events |= AS_SOCK_EV_ERROR; as_sock_drop_fd(s); }

// start a connect. Returns nothing: every failure (unresolvable host, refused
// port, bad port) becomes an ioError event, which is what adl does for a host
// that was supplied ("an error event is dispatched if a host was specified").
static void as_sock_connect(as_sock* s, const char* host, int port) {
    if (s == NULL) return;
    // AIR: "If the socket is already connected, the existing connection is closed
    // first" — silently, with no close event.
    if (s->accepted != NULL) { as_sock_close(s->accepted); s->accepted = NULL; }
    if (s->fd >= 0) as_sock_drop_fd(s);
    s->rlen = s->rpos = 0;
    s->wlen = s->wpos = 0;
    s->remote_addr[0] = 0;
    s->remote_port = 0;
    snprintf(s->url, sizeof(s->url), "%s", host);
    if (s->unsupported) { as_sock_fail(s, 0); return; }  // no socket backend on this target
#ifdef ASC_SOCK_POSIX
    {
        char portstr[16];
        snprintf(portstr, sizeof(portstr), "%d", port);
        struct addrinfo hints;
        struct addrinfo* res = NULL;
        memset(&hints, 0, sizeof(hints));
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;
        // Resolution is synchronous: the OS resolver caches, and a socket must be
        // usable without a worker thread (see the seam note above).
        int rc = getaddrinfo(host, portstr, &hints, &res);
        if (rc != 0 || res == NULL) { as_sock_fail(s, EADDRNOTAVAIL); if (res != NULL) freeaddrinfo(res); return; }
        int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
        if (fd < 0) { as_sock_fail(s, errno); freeaddrinfo(res); return; }
        int flags = fcntl(fd, F_GETFL, 0);
        fcntl(fd, F_SETFL, flags | O_NONBLOCK);
        s->fd = fd;
        int cr = connect(fd, res->ai_addr, res->ai_addrlen);
        freeaddrinfo(res);
        if (cr == 0) {
            // A loopback connect completes inline, but AIR reports
            // connected=false and dispatches Event.CONNECT only at the next frame
            // boundary. So the state machine stays CONNECTING and the pump's
            // SO_ERROR check (which returns 0 for this socket) is what promotes it
            // — one code path for both the inline and the EINPROGRESS case, and no
            // way for the connected flag to flip before the event is delivered.
            s->state = AS_SOCK_CONNECTING;
            s->started_ms = as_now_ms();
            return;
        }
        if (errno == EINPROGRESS || errno == EALREADY) {
            s->state = AS_SOCK_CONNECTING;
            s->started_ms = as_now_ms();
            return;
        }
        as_sock_fail(s, errno);
    }
#endif
}

// ServerSocket.bind(): binds and remembers the port the OS assigned (port 0 asks
// for an ephemeral one). listening stays false until listen().
static int as_sock_bind(as_sock* s, const char* host, int port) {
    if (s == NULL) return 0;
    if (s->fd >= 0) as_sock_drop_fd(s);
    if (s->unsupported) return 0;
#ifdef ASC_SOCK_POSIX
    {
        struct addrinfo hints;
        struct addrinfo* res = NULL;
        memset(&hints, 0, sizeof(hints));
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;
        hints.ai_flags = AI_PASSIVE;
        char portstr[16];
        snprintf(portstr, sizeof(portstr), "%d", port);
        const char* node = (host != NULL && host[0] != 0) ? host : NULL;
        if (getaddrinfo(node, portstr, &hints, &res) != 0 || res == NULL) { if (res != NULL) freeaddrinfo(res); return 0; }
        int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
        if (fd < 0) { freeaddrinfo(res); return 0; }
        int one = 1;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        int flags = fcntl(fd, F_GETFL, 0);
        fcntl(fd, F_SETFL, flags | O_NONBLOCK);
        if (bind(fd, res->ai_addr, res->ai_addrlen) != 0) { close(fd); freeaddrinfo(res); return 0; }
        freeaddrinfo(res);
        s->fd = fd;
        s->state = AS_SOCK_IDLE;
        s->listening = 0;           // bind() alone does not accept connections
        as_sock_capture_addrs(s);
        return 1;
    }
#else
    return 0;
#endif
}

static int as_sock_listen(as_sock* s, int backlog) {
    if (s == NULL || s->fd < 0) return 0;
#ifdef ASC_SOCK_POSIX
    if (listen(s->fd, backlog > 0 ? backlog : 128) != 0) return 0;
    s->listening = 1;
    return 1;
#else
    return 0;
#endif
}

// Accept one pending connection. The child is a normal non-blocking as_sock in
// the CONNECTED state; its AS3 object is created by the dispatch pass (which is
// where Socket_new is in scope).
static void as_sock_accept_one(as_sock* s) {
    if (s == NULL || s->fd < 0 || s->accepted_ready) return;
#ifdef ASC_SOCK_POSIX
    struct sockaddr_storage ss;
    socklen_t len = (socklen_t)sizeof(ss);
    int fd = accept(s->fd, (struct sockaddr*)&ss, &len);
    if (fd < 0) return;
    int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    as_sock* c = as_sock_new(0);
    if (c == NULL) { close(fd); return; }
    c->fd = fd;
    c->state = AS_SOCK_CONNECTED;
    c->timeout_ms = s->timeout_ms;
    as_sock_capture_addrs(c);
    s->accepted = c;
    s->accepted_ready = 1;
    s->events |= AS_SOCK_EV_ACCEPT;
#endif
}

// Take the accepted child: the dispatch pass creates the AS3 object and then
// calls this, so exactly one dispatcher ever owns it.
static as_sock* as_sock_take_accepted(as_sock* s) {
    if (s == NULL) return NULL;
    as_sock* c = s->accepted;
    s->accepted = NULL;
    s->accepted_ready = 0;
    return c;
}

// Buffer writes. AIR buffers them and only flush() (or the automatic flush
// between frames on some platforms — macOS and this runtime) pushes them to the
// transport; bytesPending is exactly this buffer's remainder.
static void as_sock_write(as_sock* s, const void* data, int len) {
    if (s == NULL) return;
    if (len <= 0) return;
    if (s->wlen > s->wpos) {
        if (s->wpos > 0) { memmove(s->wbuf, s->wbuf + s->wpos, s->wlen - s->wpos); s->wlen -= s->wpos; s->wpos = 0; }
    } else {
        s->wlen = s->wpos = 0;
    }
    if (s->wlen + (size_t)len > s->wcap) {
        size_t cap = s->wcap == 0 ? 256 : s->wcap;
        while (cap < s->wlen + (size_t)len) cap *= 2;
        unsigned char* grown = (unsigned char*)realloc(s->wbuf, cap);
        if (grown == NULL) return;
        s->wbuf = grown;
        s->wcap = cap;
    }
    memcpy(s->wbuf + s->wlen, data, (size_t)len);
    s->wlen += (size_t)len;
}

// Push as much of the write buffer as the transport accepts right now.
static void as_sock_try_flush(as_sock* s) {
    if (s == NULL || s->fd < 0) return;
    if (s->wlen <= s->wpos) { s->wlen = s->wpos = 0; return; }
#ifdef ASC_SOCK_POSIX
    for (;;) {
        ssize_t n = send(s->fd, s->wbuf + s->wpos, s->wlen - s->wpos, 0);
        if (n > 0) {
            s->wpos += (size_t)n;
            if (s->wpos >= s->wlen) { s->wlen = s->wpos = 0; }
            s->events |= AS_SOCK_EV_OUTPUT;
            if (s->wlen == 0) return;
            continue;
        }
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
        if (n < 0) { as_sock_fail(s, errno); return; }
        return;
    }
#endif
}

// Copy out of the receive buffer. The AS3 side has already checked
// bytesAvailable, so this only ever moves what is there.
static int as_sock_read(as_sock* s, void* dst, int n) {
    if (s == NULL) return 0;
    int avail = s->rlen - s->rpos;
    int k = (n < avail) ? n : avail;
    if (k > 0) memcpy(dst, s->rbuf + s->rpos, (size_t)k);
    s->rpos += k;
    if (s->rpos >= s->rlen) { s->rpos = s->rlen = 0; }
    return k;
}

// Drain the descriptor into the receive buffer. POLLIN only promises SOME data;
// this keeps pulling until the kernel says there is no more, so one frame hands
// over a whole chunk (the adl run shows bytesLoaded = the whole echo).
static void as_sock_drain(as_sock* s) {
#ifdef ASC_SOCK_POSIX
    for (;;) {
        if (s->rcap - s->rlen < 4096) {
            if (s->rpos > 0) { memmove(s->rbuf, s->rbuf + s->rpos, (size_t)(s->rlen - s->rpos)); s->rlen -= s->rpos; s->rpos = 0; }
            if (s->rcap - s->rlen < 4096) {
                int cap = s->rcap == 0 ? 8192 : s->rcap * 2;
                unsigned char* grown = (unsigned char*)realloc(s->rbuf, (size_t)cap);
                if (grown == NULL) return;
                s->rbuf = grown;
                s->rcap = cap;
            }
        }
        ssize_t n = recv(s->fd, s->rbuf + s->rlen, (size_t)(s->rcap - s->rlen), 0);
        if (n > 0) { s->rlen += (int)n; s->events |= AS_SOCK_EV_DATA; continue; }
        if (n == 0) {
            // The peer closed. Bytes received in this same pass are already
            // buffered, so the dispatch order DATA-then-CLOSE still lets a
            // listener read them (adl: socketData, then close).
            s->events |= AS_SOCK_EV_CLOSE;
            as_sock_drop_fd(s);
            return;
        }
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) return;
        as_sock_fail(s, errno);
        return;
    }
#endif
}

// The frame-boundary pump: one non-blocking poll of every live descriptor, then
// the state machine that turns readiness into events.
static void as_sock_pump(int wait_ms) {
    if (as_sock_count == 0) return;
#ifdef ASC_SOCK_POSIX
    static struct pollfd* pfds = NULL;
    static as_sock** owners = NULL;
    static int cap = 0;
    int n = 0;
    for (int i = 0; i < as_sock_count; i++) {
        as_sock* s = as_socks[i];
        if (s == NULL || s->dead || s->fd < 0) continue;
        if (n >= cap) {
            int grow = cap == 0 ? 8 : cap * 2;
            struct pollfd* np = (struct pollfd*)realloc(pfds, (size_t)grow * sizeof(struct pollfd));
            as_sock** no = (as_sock**)realloc(owners, (size_t)grow * sizeof(as_sock*));
            if (np == NULL || no == NULL) { free(np != NULL ? np : pfds); break; }
            pfds = np;
            owners = no;
            cap = grow;
        }
        pfds[n].fd = s->fd;
        pfds[n].events = POLLIN;
        if (s->state == AS_SOCK_CONNECTING || s->wlen > s->wpos) pfds[n].events |= POLLOUT;
        pfds[n].revents = 0;
        owners[n] = s;
        n++;
    }
    if (n > 0) poll(pfds, (nfds_t)n, wait_ms);
    for (int i = 0; i < n; i++) {
        as_sock* s = owners[i];
        short re = pfds[i].revents;
        if (s == NULL || s->dead || re == 0) continue;
        if (s->is_server) {
            if (re & POLLIN) as_sock_accept_one(s);
            continue;
        }
        if (s->state == AS_SOCK_CONNECTING) {
            if (re & (POLLOUT | POLLERR | POLLHUP)) {
                int e = 0;
                socklen_t elen = (socklen_t)sizeof(e);
                if (getsockopt(s->fd, SOL_SOCKET, SO_ERROR, &e, &elen) != 0) e = errno;
                if (e == 0) {
                    s->state = AS_SOCK_CONNECTED;
                    as_sock_capture_addrs(s);
                    s->events |= AS_SOCK_EV_CONNECT;
                } else {
                    as_sock_fail(s, e);
                }
            }
            continue;
        }
        if (s->state == AS_SOCK_CONNECTED) {
            if (re & POLLOUT) as_sock_try_flush(s);
            if (re & POLLIN) as_sock_drain(s);
            if (s->state == AS_SOCK_CONNECTED && (re & (POLLERR | POLLHUP)) && !(re & POLLIN)) {
                // A hangup without readable data: nothing left to read.
                s->events |= AS_SOCK_EV_CLOSE;
                as_sock_drop_fd(s);
            }
        }
    }
    // Connect budget. Checked after the poll so a slow-but-successful connect is
    // never failed by a timeout that elapsed during the same wait.
    {
        double now = as_now_ms();
        for (int i = 0; i < as_sock_count; i++) {
            as_sock* s = as_socks[i];
            if (s == NULL || s->dead || s->state != AS_SOCK_CONNECTING) continue;
            if (s->timeout_ms > 0 && (now - s->started_ms) > (double)s->timeout_ms) {
                as_sock_fail(s, ETIMEDOUT);
            }
        }
    }
#endif
    as_sock_reap();
}

// In-flight = something the frame loop can still make progress on without the
// app doing anything: a connect attempt, or output not yet handed to the
// transport. Only the test hook (as_async_tick_wait) waits on this.
static int as_sock_in_flight(void) {
    for (int i = 0; i < as_sock_count; i++) {
        as_sock* s = as_socks[i];
        if (s == NULL || s->dead) continue;
        if (s->state == AS_SOCK_CONNECTING) return 1;
        if (s->wlen > s->wpos) return 1;
    }
    return 0;
}

static int as_sock_any(void) { return as_sock_count > 0; }

// Offset of the first 'ch' among the UNREAD bytes, or -1. XMLSocket uses it to
// find a NUL-terminated message without copying the buffer out first.
static int as_sock_index_of(as_sock* s, int ch) {
    if (s == NULL) return -1;
    for (int i = s->rpos; i < s->rlen; i++) if (s->rbuf[i] == (unsigned char)ch) return i - s->rpos;
    return -1;
}

// The AS3 objects behind live sockets are permanent roots: the as_sock struct
// itself is malloc'd, so nothing else would keep a Socket that the app forgot to
// reference alive while its events are still pending.
static void as_sock_mark_roots(void) {
    for (int i = 0; i < as_sock_count; i++) {
        as_sock* s = as_socks[i];
        if (s == NULL) continue;
        if (s->obj != NULL) gc_mark_ptr(s->obj);
        if (s->accepted != NULL && s->accepted->obj != NULL) gc_mark_ptr(s->accepted->obj);
    }
}

// Drain the completed jobs. Called only at the frame boundary, on the AS3
// thread. The table is scanned under as_job_lock - workers write j->state under
// that same lock - but the thunks run with the lock RELEASED: they dispatch AS3
// events and a listener may chain another load (Starling: URLLoader COMPLETE ->
// Loader.loadBytes), which publishes under the lock again. Holding the lock
// across a dispatch would deadlock.
//
// A picked job is marked AS_JOB_FINISHING and deliberately left IN the table
// until its thunk has run. The table is what as_async_mark_roots walks, and a
// thunk allocates (BitmapData / Bitmap), which can trigger a collection from
// gc_alloc before the target has been published back to AS3. Taking the job out
// of the table up front would therefore unroot an otherwise unreferenced target
// mid-thunk and let the sweep zero it - that was an observed crash (a Loader
// whose contentLoaderInfo had been wiped to NULL), not a theoretical one.
//
// Up to 16 passes, because a thunk may publish a job that is already finished on
// the inline targets, so a whole load chain still completes within one tick.
// Returns the number of thunks run.
static int as_sock_dispatch(void);    // defined with the AS3 Socket section (needs Socket_new)

static int as_async_tick_with(int sock_wait_ms) {
    // A thunk dispatches AS3 events and a listener may call the frame-boundary
    // hook again (tickTimers is AS3-callable). This pass already drains everything
    // the nested one could, so it reports "nothing done" instead of walking the
    // same jobs twice.
    if (as_async_in_tick) return 0;
    as_async_in_tick = 1;

    // Sockets first: a connect that completed, or bytes that arrived, since the
    // last frame dispatch in THIS frame — the same promise the job path makes.
    // sock_wait_ms is 0 at a real frame boundary (never block a frame) and 10 in
    // the test hook, where the caller is waiting for a socket to make progress.
    int sock_events = 0;
    if (as_sock_any()) {
        as_sock_pump(sock_wait_ms);
        sock_events = as_sock_dispatch();
    }

#ifdef ASC_HTTP_WEB
    // The web fetch backend delivers its results through a JS queue, so this is
    // where an in-flight browser request becomes a finished job. Draining before
    // the jobs are picked is what let a fetch that completed since the last frame
    // dispatch in THIS frame.
    as_web_fetch_pump();
#endif

    // Pre-pass: raise the in-flight events of the transfers that are still running.
    // AIR does not batch a load's whole event sequence to its completion, and a
    // streaming consumer needs PROGRESS (and the bytes behind it) as they arrive —
    // this is the frame at which that happens. The pointers are collected under the
    // lock but the events are dispatched with it RELEASED: a listener may submit the
    // next request, and as_async_submit takes the same lock.
    {
        as_job* live[8];
        int ln = 0;
#ifdef ASC_ASYNC_THREADS
        pthread_mutex_lock(&as_job_lock);
#endif
        for (int i = 0; i < as_job_count && ln < (int)(sizeof(live) / sizeof(live[0])); i++) {
            as_job* j = as_jobs[i];
            if (j != NULL && j->state == AS_JOB_RUNNING && j->net_events && !j->dead) live[ln++] = j;
        }
#ifdef ASC_ASYNC_THREADS
        pthread_mutex_unlock(&as_job_lock);
#endif
        for (int i = 0; i < ln; i++) as_net_pre_events((void*)live[i]);
    }

    int finished = 0;
    for (int pass = 0; pass < 16; pass++) {
        as_job* ready[8];
        int n = 0;

        // Phase 1 (locked): pick the thunks that are due.
#ifdef ASC_ASYNC_THREADS
        pthread_mutex_lock(&as_job_lock);
#endif
        for (int i = 0; i < as_job_count; i++) {
            as_job* j = as_jobs[i];
            if (j == NULL || j->state != AS_JOB_DONE) continue;
            if (j->dead || j->finish == NULL) continue;  // superseded: dropped in phase 3
            if (n < (int)(sizeof(ready) / sizeof(ready[0]))) { ready[n++] = j; j->state = AS_JOB_FINISHING; }
        }
#ifdef ASC_ASYNC_THREADS
        pthread_mutex_unlock(&as_job_lock);
#endif

        // Phase 2 (lock released): publish the staged results.
        for (int i = 0; i < n; i++) {
            if (ready[i]->finish != NULL) ready[i]->finish((void*)ready[i]);
        }

        // Phase 3 (locked): drop the jobs whose thunk has run, plus the superseded
        // ones. A superseded FS_OPEN still closes the handle it opened: its thunk
        // never ran, so nothing else took ownership.
#ifdef ASC_ASYNC_THREADS
        pthread_mutex_lock(&as_job_lock);
#endif
        int keep = 0;
        for (int i = 0; i < as_job_count; i++) {
            as_job* j = as_jobs[i];
            if (j == NULL) continue;
            if (j->state == AS_JOB_FINISHING) { as_job_retire(j); as_job_release(j); continue; }
            if (j->state == AS_JOB_DONE && (j->dead || j->finish == NULL)) {
                if (j->kind == AS_JOB_FS_OPEN && j->handle != NULL) { fclose((FILE*)j->handle); j->handle = NULL; }
                as_job_retire(j);
                as_job_release(j);
                continue;
            }
            as_jobs[keep++] = j;
        }
        as_job_count = keep;
#ifdef ASC_ASYNC_THREADS
        pthread_mutex_unlock(&as_job_lock);
#endif

        finished += n;
        if (n == 0) break;
    }

    as_async_in_tick = 0;
    return finished + sock_events;
}

// The frame boundary's entry point: never blocks.
static int as_async_tick(void) { return as_async_tick_with(0); }

// Test hook (tickTimers): wait for the workers to drain the queue, then drain
// the completed jobs, so one call is enough to observe COMPLETE - exactly the
// deterministic behaviour the headless examples relied on before threading.
// Looped because a finish thunk may submit the next link of a load chain.
static void as_async_tick_wait(void) {
    for (int pass = 0; pass < 16; pass++) {
#ifdef ASC_ASYNC_THREADS
        pthread_mutex_lock(&as_job_lock);
        for (;;) {
            int pending = 0;
            for (int i = 0; i < as_job_count; i++) {
                as_job* j = as_jobs[i];
                if (j != NULL && !j->dead && (j->state == AS_JOB_QUEUED || j->state == AS_JOB_RUNNING)) { pending = 1; break; }
            }
            if (!pending) break;
            pthread_cond_wait(&as_job_wake, &as_job_lock);
        }
        pthread_mutex_unlock(&as_job_lock);
#endif
        // The 10 ms socket wait is what makes a loopback round trip (connect ->
        // write -> peer echo -> socketData) land inside one tickTimers() call
        // instead of depending on how fast the host spins.
        if (as_async_tick_with(10) == 0 && !as_sock_in_flight()) break;
    }
}

// Job accessors: generated code reads staged results through these instead of
// poking the struct, so the staging layout stays a runtime detail.
static void* as_job_obj(void* job) { return ((as_job*)job)->obj; }
// The finish thunk identifies the owning generated class: several flash.net and
// flash.media types share this job machinery, and a few of them have to do
// per-owner work as the job's events are raised (a Sound records its final URL
// before OPEN, so Sound.url is already live inside an open listener).
static void* as_job_finish(void* job) { return (void*)((as_job*)job)->finish; }
static int as_job_failed(void* job) { return ((as_job*)job)->error; }
static int as_job_error(void* job) { return ((as_job*)job)->error; }
// The text an ioError carries. A backend that knows more than the error kind
// supplies its own detail (the web fetch error names CORS and the failed URL
// class), otherwise the cause picks between the two fixed texts the caller
// passed: the unsupported-transport one (phase G) and its own generic one.
static char* as_job_error_text(void* job, char* unsupported_text, char* generic_text) {
    as_job* j = (as_job*)job;
    if (j->err_text != NULL) return j->err_text;
    if (j->error == AS_JOB_ERR_UNSUPPORTED) return unsupported_text;
    return generic_text;
}
// The backend's own failure detail, or NULL when it has none. The web fetch
// fills it (it names CORS and the tainted response); every native path leaves it
// NULL. Kept separate from as_job_error_text because AIR's ioError text is a
// fixed sentence per number and this is an EXTRA fact that sentence cannot carry.
static char* as_job_err_detail(void* job) { return ((as_job*)job)->err_text; }
static const char* as_job_path(void* job) { const char* p = ((as_job*)job)->path; return (p != NULL) ? p : ""; }
// AIR attaches a NUMBER and a matching sentence to every internally generated
// ioError, and AS3 code branches on the number (e.errorID == 2032). The pairs we
// emit are MEASURED against adl 51.4.1 on the same failure matrix, because AIR's
// documentation never lists them; the matrix lives in
// docs/zh-cn/flash-net.md §6.7.5:
//
//   Loader    local file not found .......... 2035 "URL Not Found"
//   Loader    HTTP >= 400, or transport .... 2036 "Load Never Completed"
//   Loader    payload is not an image ....... 2124 "Loaded file is an unknown type"
//   URLLoader / URLStream, any failure ...... 2032 "Stream Error"
//   Socket, any failure ..................... 2031 "Socket Error"
//
// The text is that sentence plus the offending URL - the shape every one of those
// measurements shows. The detail argument, when a backend supplied one, is
// appended in parentheses rather than replacing the sentence: AIR has no
// counterpart for it, but discarding it would make a CORS block look like a dead
// server.
static char* as_ioerror_text(const char* url, int id, const char* detail) {
    const char* desc;
    switch (id) {
        case 2032: desc = "Stream Error"; break;
        case 2035: desc = "URL Not Found"; break;
        case 2036: desc = "Load Never Completed"; break;
        case 2124: desc = "Loaded file is an unknown type"; break;
        default: return NULL;  // no measured AIR pair (build-level diagnostics)
    }
    const char* u = (url != NULL) ? url : "";
    size_t n = strlen(u) + strlen(desc) + 40;
    if (detail != NULL) n += strlen(detail) + 3;
    char* t = as_str_alloc(n);
    if (detail != NULL) snprintf(t, n, "Error #%d: %s. URL: %s (%s)", id, desc, u, detail);
    else                snprintf(t, n, "Error #%d: %s. URL: %s", id, desc, u);
    return t;
}
// Which number a failed Loader image load reports. The job's error KIND is not
// enough to decide it: a 4xx/5xx body also reaches the decoder and fails there,
// and AIR reports that as a load that never completed (2036), not as an
// undecodable payload (2124). The staged HTTP status is what separates them.
// Returns 0 only for the build-level "no transport in this build" state, for
// which AIR has no counterpart.
static int as_job_loader_ioerror_id(void* job) {
    as_job* j = (as_job*)job;
    if (j->error == AS_JOB_ERR_UNSUPPORTED) return 0;
    if (j->error == AS_JOB_ERR_DECODE) return (j->status >= 400) ? 2036 : 2124;
    return as_job_is_remote_url(j->path) ? 2036 : 2035;
}
static const unsigned char* as_job_bytes(void* job) { return ((as_job*)job)->bytes; }
static unsigned as_job_len(void* job) { return (unsigned)((as_job*)job)->len; }
static unsigned as_job_total(void* job) { return ((as_job*)job)->total; }
static int as_job_is_binary(void* job) { return ((as_job*)job)->binary; }
static int as_job_status(void* job) { return ((as_job*)job)->status; }
static const char* as_job_headers(void* job) { return (const char*)((as_job*)job)->headers; }
static const char* as_job_eff_url(void* job) { const char* u = ((as_job*)job)->eff_url; return (u != NULL) ? u : ""; }
static int as_job_redirected(void* job) { return ((as_job*)job)->redirected; }
static unsigned as_job_expected_total(void* job) { return ((as_job*)job)->expected_total; }
static int as_job_started(void* job) { return ((as_job*)job)->started; }
static void as_job_set_net_events(void* job) { ((as_job*)job)->net_events = 1; }
static int as_job_sent_open(void* job) { return ((as_job*)job)->sent_open; }
static void as_job_set_sent_open(void* job) { ((as_job*)job)->sent_open = 1; }
static int as_job_sent_status(void* job) { return ((as_job*)job)->sent_status; }
static void as_job_set_sent_status(void* job) { ((as_job*)job)->sent_status = 1; }
static unsigned as_job_marks_sent(void* job) { return ((as_job*)job)->marks_sent; }
static void as_job_set_marks_sent(void* job, unsigned n) { ((as_job*)job)->marks_sent = n; }
static unsigned as_job_last_progress(void* job) { return ((as_job*)job)->last_progress; }
static void as_job_set_last_progress(void* job, unsigned n) { ((as_job*)job)->last_progress = n; }
static int as_job_mark_count(void* job) { return ((as_job*)job)->mark_count; }
static unsigned as_job_mark(void* job, int i) { as_job* j = (as_job*)job; return (i >= 0 && i < j->mark_count) ? j->marks[i] : 0u; }
static void* as_job_pixels(void* job) { return ((as_job*)job)->pixels; }
static int as_job_width(void* job) { return ((as_job*)job)->width; }
static int as_job_height(void* job) { return ((as_job*)job)->height; }
// TAKE (not get) an AS_JOB_FS_OPEN's handle: the FILE* changes owner here, so
// the job must stop pointing at it. as_job_retire() closes whatever is still in
// the job, and the AS3 FileStream closes the handle itself (the demo closes it
// from its own COMPLETE listener), so handing out a COPY closed one FILE*
// twice. Measured on web as a hard trap -- "Uncaught RuntimeError: table index
// is out of bounds", with the symbolised stack fclose <- as_job_retire <-
// Stage_dispatchFrame: emscripten's fclose ends in an indirect call through the
// stream's own function pointer, and the freed stream's slot no longer holds a
// valid table index. Native corrupts the heap silently instead (the double free
// goes unnoticed by libmalloc), which is why only the browser build reported it.
// Ownership rules for the other staged results are the opposite and stay as they
// are: pixels/bytes are COPIED into the GC heap by the thunk and the job keeps
// owning its malloc'd buffer.
//
// (No backticks anywhere in this preamble: it is a TS template literal, so one
// would end the string and the C below would be parsed as TypeScript.)
static void* as_job_take_handle(void* job) {
    as_job* j = (as_job*)job;
    void* h = j->handle;
    j->handle = NULL;
    return h;
}

// Permanent-root walk for in-flight jobs (invariant B above).
static void as_async_mark_roots(void) {
    for (int i = 0; i < as_job_count; i++) {
        as_job* j = as_jobs[i];
        if (j != NULL && j->obj != NULL) gc_mark_ptr(j->obj);
    }
}

// Cancel every in-flight job targeting 'obj' (URLLoader.close / URLStream.close).
// A cancelled job is marked dead exactly like a superseded one, and the existing
// machinery does the rest: phase 1 of as_async_tick skips dead jobs, so no OPEN /
// PROGRESS / COMPLETE / IO_ERROR is dispatched after close(), and phase 3 retires
// them. Only a job that is still live counts as cancelable:
//   * already dead  - a previous close() (or a superseding load) terminated it, so
//                     there is no stream left to close and the caller must report
//                     AIR's "invalid stream error";
//   * AS_JOB_FINISHING - its thunk is running on this very thread (close() called
//                     from one of its own listeners), i.e. a stream does exist but
//                     the terminal events are already being delivered. Reported as
//                     present, but not marked (phase 3 retires it by state anyway).
// No lock is taken: by the ownership rule above, the job table and j->dead belong
// to the AS3 thread, and close() is an AS3 call (as_async_mark_roots walks the
// same table the same way). Returns 1 when a load was actually pending.
static int as_async_cancel(void* obj) {
    int found = 0;
    for (int i = 0; i < as_job_count; i++) {
        as_job* j = as_jobs[i];
        if (j == NULL || j->obj != obj) continue;
        if (j->dead) continue;
        found = 1;
        if (j->state != AS_JOB_FINISHING) j->dead = 1;
#ifdef ASC_HTTP_WEB
        // Stop the browser from downloading a response nobody will read. The
        // AbortError the abort produces is swallowed in JS (see as_web_fetch_go),
        // so a cancelled load dispatches nothing at all.
        if (j->pending_async) as_web_fetch_stop((unsigned)(uintptr_t)j, j->serial);
#endif
    }
    return found;
}

// ---------- URLStream incremental reads (stage 89·51, phase F) ----------
// A streaming job's body grows on the worker thread while AS3 reads it on the
// AS3 thread, so both sides take as_job_lock. On targets without threads the
// transfer already ran to completion inside as_job_publish (inline strategy), so
// the lock compiles out and every access is trivially ordered.
static int as_stream_append(as_job* j, const void* p, size_t n) {
#ifdef ASC_ASYNC_THREADS
    pthread_mutex_lock(&as_job_lock);
#endif
    int ok = 1;
    if (j->len + n + 1 > j->bytes_cap) {
        size_t cap = (j->bytes_cap == 0) ? 4096 : j->bytes_cap;
        while (cap < j->len + n + 1) cap *= 2;
        unsigned char* grown = (unsigned char*)realloc((void*)j->bytes, cap);
        if (grown == NULL) ok = 0;
        else { j->bytes = grown; j->bytes_cap = cap; }
    }
    if (ok && n > 0) {
        memcpy((void*)(j->bytes + j->len), p, n);
        j->len += n;
        ((unsigned char*)j->bytes)[j->len] = 0;
    }
#ifdef ASC_ASYNC_THREADS
    pthread_mutex_unlock(&as_job_lock);
#endif
    return ok;
}

// bytesAvailable: bytes received but not yet handed to AS3. Zero once the job is
// gone, which is what URLStream reports after COMPLETE once the remainder has
// been drained, and after close().
static unsigned as_stream_available(void* job) {
    as_job* j = (as_job*)job;
    if (j == NULL) return 0u;
#ifdef ASC_ASYNC_THREADS
    pthread_mutex_lock(&as_job_lock);
#endif
    size_t n = (j->len > j->consumed) ? (j->len - j->consumed) : 0;
#ifdef ASC_ASYNC_THREADS
    pthread_mutex_unlock(&as_job_lock);
#endif
    return (unsigned)n;
}

// Copies up to 'n' unconsumed bytes into 'dst' and advances the read cursor. The
// return value is what was actually copied, which may be short of 'n' (a
// non-blocking read never waits for bytes that have not arrived): the emitted
// read* methods turn a shortfall into EOFError where AIR does.
static int as_stream_read(void* job, void* dst, int n) {
    as_job* j = (as_job*)job;
    if (j == NULL || n <= 0) return 0;
#ifdef ASC_ASYNC_THREADS
    pthread_mutex_lock(&as_job_lock);
#endif
    size_t avail = (j->len > j->consumed) ? (j->len - j->consumed) : 0;
    size_t k = ((size_t)n < avail) ? (size_t)n : avail;
    if (k > 0 && dst != NULL) memcpy(dst, j->bytes + j->consumed, k);
    j->consumed += k;
#ifdef ASC_ASYNC_THREADS
    pthread_mutex_unlock(&as_job_lock);
#endif
    return (int)k;
}

// One byte, or -1 when nothing is buffered (the caller raises EOFError).
static int as_stream_get_byte(void* job) {
    unsigned char b = 0;
    if (as_stream_read(job, &b, 1) != 1) return -1;
    return (int)b;
}

// 1 while the job is neither finished nor being torn down. 'connected' reports
// this; it never blocks, so it can go stale the instant a transfer ends.
static int as_stream_connected(void* job) {
    as_job* j = (as_job*)job;
    if (j == NULL) return 0;
    return (j->state == AS_JOB_QUEUED || j->state == AS_JOB_RUNNING) ? 1 : 0;
}

// Submit a URLStream transfer. Unlike as_async_submit_http the return value is
// the live job: URLStream owns the handle so it can read the body incrementally
// and, on close(), let the ordinary cancel machinery kill the transfer. NULL
// means the job could not be published (out of memory) — nothing was started.
static void* as_async_submit_http_stream(void* obj, void (*finish)(void*), const char* url, const char* method, const char* user_agent, const char* content_type, const char* request_headers, const void* body, size_t body_len, int follow_redirects, double idle_timeout, int manage_cookies) {
    as_job* j = as_job_alloc(AS_JOB_HTTP_STREAM, obj, finish);
    if (j == NULL) return NULL;
    j->path = as_job_strdup(url);
    j->mode = as_job_strdup((method != NULL) ? method : "GET");
    j->binary = 1;
    if (user_agent != NULL) j->user_agent = as_job_strdup(user_agent);
    if (content_type != NULL) j->content_type = as_job_strdup(content_type);
    if (request_headers != NULL) j->request_headers = as_job_strdup(request_headers);
    if (body != NULL && body_len > 0) {
        j->body = (unsigned char*)malloc(body_len);
        if (j->body != NULL) { memcpy(j->body, body, body_len); j->body_len = body_len; }
    }
    j->follow_redirects = follow_redirects;
    j->idle_timeout = idle_timeout;
    j->manage_cookies = manage_cookies;
    if (!as_job_publish(j)) { as_job_release(j); return NULL; }
    return j;
}

// Publish an already-doomed job so the caller's finish thunk still runs at a
// frame boundary and can report AS_JOB_ERR_UNSUPPORTED. Returns the live job (or
// NULL when nothing could be published) exactly like the streaming submit.
static void* as_async_submit_unsupported(void* obj, void (*finish)(void*), const char* url) {
    as_job* j = as_job_alloc(AS_JOB_UNSUPPORTED, obj, finish);
    if (j == NULL) return NULL;
    j->path = as_job_strdup(url);
    j->binary = 1;
    if (!as_job_publish(j)) { as_job_release(j); return NULL; }
    return j;
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
// ASC_FRAME_STATS: per-frame timing probe (diagnostic, env-gated). Records every
// frame interval plus the time gc_step() spent inside that frame, then prints a
// percentile summary together with RSS. A visible stutter has two candidate
// causes and this separates them by measurement instead of by guess: a long
// gc_step (the incremental slice is too big for the frame) or a long frame with
// a *short* gc_step (allocator storm -- a fresh multi-MB segment is mmap'd,
// zero-filled and copied, i.e. thousands of first-touch page faults per frame).
#define AS_DBG_FRAME_CAP 512
static double as_dbg_frame_ms[AS_DBG_FRAME_CAP];
static double as_dbg_gc_ms[AS_DBG_FRAME_CAP];
static double as_dbg_sort_ms[AS_DBG_FRAME_CAP];
static int as_dbg_frame_n = 0;
static double as_dbg_prev_ms = 0.0;
static int as_dbg_frame_on = -1;
static size_t as_dbg_free_bytes = 0;
static int as_dbg_cmp(const void* a, const void* b) {
    double x = *(const double*)a, y = *(const double*)b;
    return x < y ? -1 : (x > y ? 1 : 0);
}
static void as_dbg_frame(double gc_ms) {
    if (as_dbg_frame_on < 0) as_dbg_frame_on = getenv("ASC_FRAME_STATS") != NULL ? 1 : 0;
    if (!as_dbg_frame_on) return;
    const double now = as_now_ms();
    if (as_dbg_prev_ms > 0.0 && as_dbg_frame_n < AS_DBG_FRAME_CAP) {
        as_dbg_frame_ms[as_dbg_frame_n] = now - as_dbg_prev_ms;
        as_dbg_gc_ms[as_dbg_frame_n] = gc_ms;
        as_dbg_frame_n++;
    }
    as_dbg_prev_ms = now;
    if (as_dbg_frame_n < AS_DBG_FRAME_CAP) return;
    int n = as_dbg_frame_n;
    double gc_max = 0.0, gc_sum = 0.0, frame_sum = 0.0;
    int worst = 0;
    for (int i = 0; i < n; i++) {
        as_dbg_sort_ms[i] = as_dbg_frame_ms[i];
        frame_sum += as_dbg_frame_ms[i];
        gc_sum += as_dbg_gc_ms[i];
        if (as_dbg_gc_ms[i] > gc_max) gc_max = as_dbg_gc_ms[i];
        if (as_dbg_frame_ms[i] > as_dbg_frame_ms[worst]) worst = i;
    }
    qsort(as_dbg_sort_ms, (size_t)n, sizeof(double), as_dbg_cmp);
    int over8 = 0, over17 = 0;
    for (int i = 0; i < n; i++) {
        if (as_dbg_frame_ms[i] > 8.0) over8++;
        if (as_dbg_frame_ms[i] > 17.0) over17++;
    }
    size_t segs = 0, freeb = 0;
    for (gc_seg* s = gc_segs; s != NULL; s = s->next) segs++;
    for (int li = 0; li < GC_SMALL_CLASSES + 2; li++)
        for (gc_header* h = *gc_free_list_at(li); h != NULL; h = h->next) freeb += h->size;
    as_dbg_free_bytes = freeb;
    fprintf(stderr, "FRAME n=%d p50=%.2f p95=%.2f p99=%.2f max=%.2f(worstgc=%.2f) over8ms=%d over17ms=%d | gcmax=%.2f gcavg=%.2f gcshare=%.1f%% | rss=%.0fMB heaptotal=%.0fMB inuse=%.0fMB/%ldobj segs=%zu freeb=%.0fMB\\n",
            n, as_dbg_sort_ms[n / 2], as_dbg_sort_ms[n * 95 / 100], as_dbg_sort_ms[n * 99 / 100],
            as_dbg_sort_ms[n - 1], as_dbg_gc_ms[worst], over8, over17,
            gc_max, gc_sum / (double)n, frame_sum > 0 ? 100.0 * gc_sum / frame_sum : 0.0,
            as_system_private_memory() / 1048576.0, gc_heap_total_bytes() / 1048576.0,
            (double)gc_dbg_inuse_bytes() / 1048576.0, gc_dbg_inuse_count(), segs,
            (double)as_dbg_free_bytes / 1048576.0);
    fflush(stderr);
    as_dbg_frame_n = 0;
}

// System.gc(): force a stop-the-world collection. AIR exposes this for manual
// GC; the frame loop instead calls gc_step() incrementally at the safe point,
// but this lets offscreen scripts trigger a full collection inside a loop.
// Unlike the frame loop it runs *inside* live AS3 frames, so the live C stack is
// added to the root set conservatively (see gc_mark_stack) — otherwise objects
// referenced only by stack locals of the calling chain would be swept underneath
// their users.
static void as_system_gc(void) {
    gc_collect();
}
// System.output(): write a string verbatim to stdout (AIR 33.1 console output).
// No trailing newline is added — AIR outputs exactly the given string.
static void as_system_output(const char* s) {
    fputs(s, stdout);
    fflush(stdout);
}

// ---------- flash.system.Capabilities environment info ----------
// Capabilities is a 'final' static read-only class (no instantiable ClassInfo);
// these helpers back its static getters. os/cpuArchitecture are conditional-
// compile constants; version is injected at codegen time from package.json (NOT
// a runtime lookup — the compiled binary has no package.json to read).
static const char* as_cap_os(void) {
#ifdef __APPLE__
    return "Mac OS";
#elif defined(_WIN32)
    return "Windows";
#elif defined(__wasi__)
    return "WASI";
#else
    return "Linux";
#endif
}
// AIR-compatible Capabilities.version: "<platform-prefix> <major>,<minor>,<build>,<internal>".
// Starling's SystemUtil reads substr(0,3) for the platform and substr(4) for the
// comma-separated version, then parseInt(split(",").shift()) to gate on major >= 19.
// The prefix must therefore be a 3-char uppercase platform code, and the version is a
// fixed AIR-compatible "50,0,0,0" (Adobe AIR's final major is 50). The AS-AOT marker
// deliberately does NOT live here — it lives in Capabilities.manufacturer ("AS-AOT"),
// because version's fixed-offset parsing breaks on any extra token. AIR's platform set
// is MAC/WIN/LNX (desktop), AND/IOS/TVO (mobile/tv) plus our WAS (WASI); only desktop +
// WASI are wired into build.ts today, mobile branches are reserved. On Apple platforms
// __APPLE__ is true for macOS and iOS/tvOS, so TargetConditionals.h distinguishes them.
static char* as_cap_version(void) {
#ifdef __APPLE__
  #include <TargetConditionals.h>
  #if TARGET_OS_TV
    const char* p = "TVO";
  #elif TARGET_OS_IPHONE
    const char* p = "IOS";
  #else
    const char* p = "MAC";
  #endif
#elif defined(_WIN32)
    const char* p = "WIN";
#elif defined(__ANDROID__)
    const char* p = "AND";
#elif defined(__wasi__)
    const char* p = "WAS";
#else
    const char* p = "LNX";
#endif
    static char buf[64];
    snprintf(buf, sizeof(buf), "%s 50,0,0,0", p);
    return buf;
}
static const char* as_cap_cpu_arch(void) {
#if defined(__aarch64__) || defined(__arm__)
    return "ARM";
#elif defined(__x86_64__) || defined(__i386__)
    return "x86";
#else
    return "Unknown";
#endif
}
// Default user-agent string for flash.net requests (URLRequestDefaults.userAgent,
// and therefore every URLRequest constructed from it). AIR documents the default
// as "the same user agent string that is used by Flash Player, which is different
// on Mac, Linux, and Windows", so this mirrors the Flash/AIR shape: an
// AppleWebKit token plus an AdobeAIR/<version> token, with the version taken from
// the same AIR-compatible "50,0,0,0" that as_cap_version reports (=> AdobeAIR/50.0).
// The OS token is a fixed representative string per OS family, not a live
// OS-version probe; it is a UA string, observable only by servers that sniff it.
// WASI has no OS of its own, so it reuses the Linux token.
static char* as_user_agent_default(void) {
#ifdef __APPLE__
  #include <TargetConditionals.h>
  #if TARGET_OS_TV || TARGET_OS_IPHONE
    return (char*)"Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) AdobeAIR/50.0";
  #else
    return (char*)"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AdobeAIR/50.0";
  #endif
#elif defined(_WIN32)
    return (char*)"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AdobeAIR/50.0";
#else
    return (char*)"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) AdobeAIR/50.0";
#endif
}
// ISO 639-1 language from the process locale (LANG, then LC_ALL). AIR reports a
// bare two-letter code ("en", "zh", ...); the POSIX locale's region/encoding
// suffix ("en_US.UTF-8") is stripped. Falls back to "en" when unset.
static const char* as_cap_language(void) {
    const char* lang = getenv("LANG");
    if (!lang) lang = getenv("LC_ALL");
    if (!lang || !lang[0]) return "en";
    static char out[8];
    int i = 0;
    while (lang[i] && lang[i] != '_' && lang[i] != '.' && lang[i] != '-' && i < 7) { out[i] = lang[i]; i++; }
    out[i] = '\\0';
    return out;
}
// Primary display resolution. Backed by the SDL2 window backend's display query;
// headless (pure-C, no ASC_USE_WINDOW) builds report 0.
static int as_cap_screen_resolution_x(void) {
    int w = 0, h = 0;
    as_window_get_display_size(&w, &h);
    return w;
}
static int as_cap_screen_resolution_y(void) {
    int w = 0, h = 0;
    as_window_get_display_size(&w, &h);
    return h;
}
// DPI: AIR reports the primary display's dots-per-inch. The window backend does
// not expose a per-display DPI query, so this is a fixed 72 (AIR's standard
// fallback) — a documented subset, not a real physical-DPI read.
static double as_cap_screen_dpi(void) {
    return 72.0;
}

// ===== AGAL translator (stage 80) =====
// Parses AGAL1/2/3 bytecode (7-byte header + variable-length instruction
// tokens) and emits readable MSL (Metal) or GLSL ES (WebGL) source. Pure C
// string processing, no GPU framework — the MSL *compile* (newLibraryWithSource)
// is wired separately in stage 82. Validation errors return NULL and set
// as_agal_errmsg. Bytecode is little-endian per the AGAL spec.
static const char* as_agal_errmsg = NULL;

static unsigned as_agal_u32(const unsigned char* p) {
    return (unsigned)p[0] | ((unsigned)p[1] << 8) | ((unsigned)p[2] << 16) | ((unsigned)p[3] << 24);
}

// Register types (8-bit field in dest/source tokens). Per the official
// AGALMiniAssembler the type code is *shader-relative*, not globally unique:
// va=0, vc=1, vt=2, op/vo=3, varying(vi/i/v)=4, fs=5, od/fd=6, iid=7 — and
// fragment registers reuse the same codes (fc=1, ft=2, oc/fo=3, vs=5). The
// translator disambiguates vertex-vs-fragment via the agal_is_frag flag.
#define AGAL_VA 0  // vertex attribute
#define AGAL_VC 1  // constant (vertex vc / fragment fc)
#define AGAL_VT 2  // temporary (vertex vt / fragment ft)
#define AGAL_OP 3  // output (vertex op / fragment oc)
#define AGAL_V  4  // varying
#define AGAL_FS 5  // texture sampler (vertex vs / fragment fs)
#define AGAL_OD 6  // fragment depth output
#define AGAL_IID 7 // instance id

// Shader stage for the translation in flight (0 = vertex, 1 = fragment).
static int agal_is_frag = 0;

static const char* const agal_op_name[0x2f] = {
    "mov","add","sub","mul","div","rcp","min","max","frc","sqt","rsq","pow","log","exp","nrm","sin",
    "cos","crs","dp3","dp4","abs","neg","sat","m33","m44","m34","ddx","ddy","ife","ine","ifg","ifl",
    "els","eif",0,0,0,0,0,"kil","tex","sge","slt","sgn","seq","sne","tld"
};

// Set when an instruction cannot be translated faithfully. Translation then
// fails loudly (the caller throws) instead of emitting a shader that silently
// drops the instruction -- a missing instruction renders as wrong pixels, which
// is far harder to trace back than a failed compile.
static char agal_err_buf[128];
static void agal_unsupported(unsigned op) {
    if (as_agal_errmsg != NULL) return;  // keep the first diagnostic
    if (op < 0x2f && agal_op_name[op] != NULL)
        snprintf(agal_err_buf, sizeof(agal_err_buf), "AGAL: opcode '%s' (0x%02x) is not translated to MSL/GLSL/HLSL yet", agal_op_name[op], op);
    else
        snprintf(agal_err_buf, sizeof(agal_err_buf), "AGAL: opcode 0x%02x is not translated to MSL/GLSL/HLSL yet", op);
    as_agal_errmsg = agal_err_buf;
}

// Operand counts and no-destination flags for the OFFICIAL AGALMiniAssembler
// bytecode. The opcode token is the BARE opcode number (0x00..0x2e) — it does
// NOT encode hasDst/hasSrc1/hasSrc2 bits in bits 8..10 (that was a hand-rolled
// assumption in the stage-82 example, not the real bytecode). The operand count
// is implied by the opcode (numRegister); OP_NO_DEST marks opcodes whose first
// operand is a source rather than a destination (ife/ine/ifg/ifl/els/eif/kil),
// matching the assembler's isDest = j==0 && !(flags & OP_NO_DEST) rule.
static const unsigned char agal_op_nreg[0x2f] = {
    2,3,3,3,3, 2,3,3,2,2, 2,3,2,2,2, 2,2,3,3,3, 2,2,2,3,3, 3,2,2,2,2, 2,2,0,0,0, 0,0,0,0,1, 3,3,3,2,3, 3,3
};
static const unsigned char agal_op_nodest[0x2f] = {
    0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0, 0,0,0,1,1, 1,1,1,1,0, 0,0,0,0,1, 0,0,0,0,0, 0,0
};

// A decoded instruction (max 200/1024/2048 per program by profile; we cap at
// 200 here to mirror the AGAL1 baseline).
typedef struct {
    unsigned op;
    unsigned dst, s1lo, s1hi, s2lo, s2hi;
} agal_instr;

static const char agal_swz[4] = { 'x', 'y', 'z', 'w' };

// Decode an 8-bit swizzle field into a 4-char suffix (identity .xyzw is
// collapsed by the caller).
static void agal_swizzle(unsigned swz, char* out) {
    out[0] = agal_swz[swz & 3];
    out[1] = agal_swz[(swz >> 2) & 3];
    out[2] = agal_swz[(swz >> 4) & 3];
    out[3] = agal_swz[(swz >> 6) & 3];
}

// Register access name. One function, three targets; the only differences are
// the *shape* of the name:
//   target 0 (MSL)  : array-indexed uniforms/attributes (vc[i]) and a
//                     [[stage_in]] struct attribute (va -> in.aN).
//   target 1 (GLSL) : one named uniform/attribute per register (vcN/vaN) plus
//                     the built-in gl_Position / gl_FragColor / gl_FragDepth.
//   target 2 (HLSL) : array-indexed *cbuffer* members (vc[i] inside
//                     'cbuffer VCBuf : register(b0)'), a stage-input struct
//                     attribute (va -> input.aN) and the local op/oc/ocN/od that
//                     the entry point packs into its SV_* output struct.
// EVERY branch below must stay three-way. The 'else' arms used to mean "GLSL",
// and the GLSL spellings (gl_FragColor/gl_Position/gl_FragDepth) are hard-coded
// there: leaving one branch two-way would silently emit GLSL identifiers into an
// HLSL shader, which is exactly the "compiles but the result is wrong" failure
// AGENTS.md 2.5 forbids.
static void agal_reg_name(char* out, int type, int num, int target) {
    switch (type) {
        case AGAL_VA: // vertex attribute (vertex only)
            if (target == 0) sprintf(out, "in.a%d", num);
            else if (target == 2) sprintf(out, "input.a%d", num);
            else sprintf(out, "va%d", num); break;
        case AGAL_VC: // constant: vc in vertex, fc in fragment
            // MSL/HLSL index an array (a 'constant float4*' / a cbuffer); GLSL
            // declares one named uniform per register.
            if (agal_is_frag) { if (target == 1) sprintf(out, "fc%d", num); else sprintf(out, "fc[%d]", num); }
            else { if (target == 1) sprintf(out, "vc%d", num); else sprintf(out, "vc[%d]", num); }
            break;
        case AGAL_VT: // temporary: vt in vertex, ft in fragment
            sprintf(out, agal_is_frag ? "ft%d" : "vt%d", num); break;
        case AGAL_OP: // output: op in vertex, oc in fragment (ocN = MRT, HLSL only)
            // MSL/GLSL keep the single-output shape they have always had
            // (oc -> one 'oc' / gl_FragColor); HLSL maps oc0..oc3 onto
            // SV_Target0..3, so the register number has to survive here.
            if (agal_is_frag) {
                if (target == 1) strcpy(out, "gl_FragColor");
                else if (target == 2 && num != 0) sprintf(out, "oc%d", num);
                else strcpy(out, "oc");
            } else {
                if (target == 1) strcpy(out, "gl_Position"); else strcpy(out, "op");
            }
            break;
        case AGAL_V:  // varying
            // Vertex writes a local v%d that is copied into the output struct;
            // the fragment reads it back through the stage-input struct (MSL:
            // 'in.v%d', HLSL: 'input.v%d'). GLSL keeps a file-scope
            // 'varying vec4 vN' visible to both stages instead.
            if (agal_is_frag && target == 0) sprintf(out, "in.v%d", num);
            else if (agal_is_frag && target == 2) sprintf(out, "input.v%d", num);
            else sprintf(out, "v%d", num); break;
        case AGAL_FS: // texture sampler
            sprintf(out, "fs%d", num); break;
        case AGAL_OD: // fragment depth output
            if (target == 1) strcpy(out, "gl_FragDepth"); else strcpy(out, "od"); break;
        case AGAL_IID: // instance id (AGAL3, vertex-only, read-only source)
            // HLSL feeds it from the SV_InstanceID system value, which is a
            // uint; it is broadcast to a float4 so the shared swizzle and
            // component-wise code paths below keep working unchanged.
            if (target == 2) strcpy(out, "float4(iid, iid, iid, iid)");
            else sprintf(out, "r%d", num); break;
        default: sprintf(out, "r%d", num); break;
    }
}
// Source expression: register name + swizzle suffix (collapsed for identity).
static void agal_src_expr(char* out, int type, int num, unsigned swz, int target) {
    char reg[40]; agal_reg_name(reg, type, num, target);
    char sw[5]; agal_swizzle(swz, sw); sw[4] = 0;
    if (strcmp(sw, "xyzw") == 0) strcpy(out, reg);
    else sprintf(out, "%s.%s", reg, sw);
}

// Destination expression: register name (write-mask applied by the emitter).
static void agal_dst_name(char* out, int type, int num, int target) {
    agal_reg_name(out, type, num, target);
}

// A cube sampler is a DIFFERENT shader type ('texturecube<float>' / 'samplerCube')
// and takes a float3 coordinate, so every sampler operand's dimension flag is
// recorded in the same pass that marks the register as used. AGAL packs the
// dimension into bits 12-13 of the sampler word (AGALMiniAssembler's
// SAMPLER_DIM_SHIFT): 0 = 2D, 1 = cube, 2 = 3D. Only 1 changes the code we emit.
// Declared above agal_emit_body, which consults it while emitting a tex/tld.
static unsigned int agal_cube[8];
static void agal_mark_cube(int num) { if (num >= 0 && num < 256) agal_cube[num / 32] |= (1u << (num % 32)); }
static int agal_is_cube(int num) { return (num >= 0 && num < 256) ? ((agal_cube[num / 32] >> (num % 32)) & 1u) : 0; }

// Append a translated instruction body. Emits one statement per written
// component (so write-masks are fully expanded).
static void agal_emit_body(as_json_buf* b, const agal_instr* ins, int n, int target) {
    const char* v4 = target == 1 ? "vec4" : "float4";
    // Builtins whose spelling differs between targets but whose call SHAPE is
    // the same, so one format string still serves all three: MSL/GLSL say
    // fract / dfdx / dfdy, HLSL says frac / ddx / ddy.
    const char* f_fract = (target == 2) ? "frac" : "fract";
    const char* f_ddx   = (target == 2) ? "ddx"  : "dfdx";
    const char* f_ddy   = (target == 2) ? "ddy"  : "dfdy";
    for (int k = 0; k < n; k++) {
        unsigned op = ins[k].op;
        unsigned dst = ins[k].dst, s1lo = ins[k].s1lo, s1hi = ins[k].s1hi, s2lo = ins[k].s2lo, s2hi = ins[k].s2hi;
        int hasDst = (dst != 0);
        int hasSrc1 = (s1lo != 0 || s1hi != 0);
        int hasSrc2 = (s2lo != 0 || s2hi != 0);
        char dname[40] = "", s1[48] = "", s2[48] = "";
        char s1b[40] = "", s2b[40] = "";
        char sw1[5] = "xyzw", sw2[5] = "xyzw";
        int dtype = 0, dnum = 0, dmask = 0xF;
        int t1 = 0, n1 = 0; unsigned w1 = 0xE4;
        int t2 = 0, n2 = 0; unsigned w2 = 0xE4;
        int isTexOp = (op == 0x28 || op == 0x2e);
        if (hasDst) { dtype = (int)((dst >> 24) & 0xFF); dnum = (int)(dst & 0xFFFF); dmask = (int)((dst >> 16) & 0xF); agal_dst_name(dname, dtype, dnum, target); }
        if (hasSrc1) { t1 = (int)(s1hi & 0xFF); n1 = (int)(s1lo & 0xFFFF); w1 = (s1lo >> 24) & 0xFF; agal_reg_name(s1b, t1, n1, target); agal_swizzle(w1, sw1); sw1[4] = 0; agal_src_expr(s1, t1, n1, w1, target); }
        if (hasSrc2) {
            if (isTexOp) { // sampler token: [num:16][lod:8][0:8][samplerbits:32], type fixed FS, no swizzle
                t2 = AGAL_FS; n2 = (int)(s2lo & 0xFFFF); agal_reg_name(s2b, t2, n2, target); strcpy(s2, s2b); strcpy(sw2, "xyzw");
            } else { t2 = (int)(s2hi & 0xFF); n2 = (int)(s2lo & 0xFFFF); w2 = (s2lo >> 24) & 0xFF; agal_reg_name(s2b, t2, n2, target); agal_swizzle(w2, sw2); sw2[4] = 0; agal_src_expr(s2, t2, n2, w2, target); }
        }
        as_json_buf_append_cstr(b, "    ");
        // Control flow (AGAL2): no destination register.
        if (op == 0x1c || op == 0x1d || op == 0x1e || op == 0x1f || op == 0x20 || op == 0x21) {
            char t[64];
            if (op == 0x1c) sprintf(t, "if (%s.x == %s.x) {\\n", s1, s2);
            else if (op == 0x1d) sprintf(t, "if (%s.x != %s.x) {\\n", s1, s2);
            else if (op == 0x1e) sprintf(t, "if (%s.x >= %s.x) {\\n", s1, s2);
            else if (op == 0x1f) sprintf(t, "if (%s.x < %s.x) {\\n", s1, s2);
            else if (op == 0x20) sprintf(t, "} else {\\n");
            else sprintf(t, "}\\n");
            as_json_buf_append_cstr(b, t);
            continue;
        }
        // kill/discard (fragment only).
        if (op == 0x27) { char t[64]; sprintf(t, "if (%s.x < 0.0) %s;\\n", s1, target == 0 ? "discard_fragment()" : "discard"); as_json_buf_append_cstr(b, t); continue; }
        // Matrix×vector: src2..src2+N-1 form the matrix (m33=3 rows, m44=4, m34=3).
        if (op == 0x17 || op == 0x18 || op == 0x19) {
            int rows = (op == 0x18) ? 4 : 3;
            char mrow[4][48]; for (int r = 0; r < rows; r++) agal_reg_name(mrow[r], t2, n2 + r, target);
            // HLSL: build the matrix ROW-major from the consecutive constant
            // registers and use mul(mat, vec). mul() is the only correct HLSL
            // operator here -- HLSL's '*' on matrices is component-wise (unlike
            // MSL/GLSL, where it is a matrix product). mul(M, v) computes
            // result_i = dot(M.row_i, v), i.e. exactly the dot() loop below, so
            // all three targets agree on the matrix convention.
            //
            // m33 deliberately uses the same 3x4 form as m34 rather than a 3x3:
            // the shared dot() loop consumes all four components of every row,
            // while AGAL's m33 would per spec read only .xyz. Letting a new
            // target silently diverge on that never-measured difference is worse
            // than reproducing the existing behaviour bit-for-bit; reconciling
            // it with the spec is a cross-target change registered in TODO.md.
            if (target == 2) {
                char t[320];
                if (op == 0x18) sprintf(t, "    %s = mul(float4x4(%s, %s, %s, %s), %s);\\n", dname, mrow[0], mrow[1], mrow[2], mrow[3], s1);
                else sprintf(t, "    %s.xyz = mul(float3x4(%s, %s, %s), %s);\\n", dname, mrow[0], mrow[1], mrow[2], s1);
                as_json_buf_append_cstr(b, t);
                continue;
            }
            for (int r = 0; r < rows; r++) { char t[200]; sprintf(t, "    %s.%c = dot(%s, %s(%s.x, %s.y, %s.z, %s.w));\\n", dname, agal_swz[r], s1, v4, mrow[r], mrow[r], mrow[r], mrow[r]); as_json_buf_append_cstr(b, t); }
            continue;
        }
        // Partial write-mask: decompose per-channel using the *decoded* swizzle
        // component, so 'mov vt0.xy, va1.zw' emits 'vt0.x = va[1].z; vt0.y = va[1].w;'
        // rather than an opaque '.zwzw.x' re-swizzle.
        if (dmask != 0xF && dmask != 0) {
            for (int c = 0; c < 4; c++) {
                if (!(dmask & (1 << c))) continue;
                char ch = agal_swz[c], c1 = sw1[c], c2 = sw2[c];
                char rhs[128]; rhs[0] = 0;
                if (op == 0x00) sprintf(rhs, "%s.%c", s1b, c1);
                else if (op >= 0x01 && op <= 0x04) { const char* o = op == 0x01 ? "+" : op == 0x02 ? "-" : op == 0x03 ? "*" : "/"; sprintf(rhs, "%s.%c %s %s.%c", s1b, c1, o, s2b, c2); }
                else if (op == 0x05) sprintf(rhs, "1.0 / %s.%c", s1b, c1);
                else if (op == 0x06) sprintf(rhs, "min(%s.%c, %s.%c)", s1b, c1, s2b, c2);
                else if (op == 0x07) sprintf(rhs, "max(%s.%c, %s.%c)", s1b, c1, s2b, c2);
                else if (op == 0x08) sprintf(rhs, "%s(%s.%c)", f_fract, s1b, c1);
                else if (op == 0x09) sprintf(rhs, "sqrt(%s.%c)", s1b, c1);
                else if (op == 0x0a) { if (target == 2) sprintf(rhs, "rsqrt(%s.%c)", s1b, c1); else sprintf(rhs, "1.0 / sqrt(%s.%c)", s1b, c1); }
                else if (op == 0x0b) sprintf(rhs, "pow(%s.%c, %s.%c)", s1b, c1, s2b, c2);
                else if (op == 0x0c) sprintf(rhs, "log2(%s.%c)", s1b, c1);
                else if (op == 0x0d) sprintf(rhs, "exp2(%s.%c)", s1b, c1);
                else if (op == 0x0e) sprintf(rhs, "normalize(%s).%c", s1, c1);
                else if (op == 0x11) sprintf(rhs, "cross(%s.xyz, %s.xyz).%c", s1, s2, c1);
                else if (op == 0x0f) sprintf(rhs, "sin(%s.%c)", s1b, c1);
                else if (op == 0x10) sprintf(rhs, "cos(%s.%c)", s1b, c1);
                // dp3/dp4 produce a scalar dot product, so a partial write-mask
                // (e.g. 'dp4 op.x, va0, vc0') must still emit the full dot for the
                // masked component — otherwise the instruction is silently dropped.
                else if (op == 0x12) sprintf(rhs, "dot(%s.xyz, %s.xyz)", s1, s2);
                else if (op == 0x13) sprintf(rhs, "dot(%s, %s)", s1, s2);
                else if (op == 0x14) sprintf(rhs, "abs(%s.%c)", s1b, c1);
                else if (op == 0x15) sprintf(rhs, "-%s.%c", s1b, c1);
                else if (op == 0x16) { if (target == 2) sprintf(rhs, "saturate(%s.%c)", s1b, c1); else sprintf(rhs, "clamp(%s.%c, 0.0, 1.0)", s1b, c1); }
                else if (op == 0x1a) sprintf(rhs, "%s(%s.%c)", f_ddx, s1b, c1);
                else if (op == 0x1b) sprintf(rhs, "%s(%s.%c)", f_ddy, s1b, c1);
                // tex: MSL needs the sampler that matches the *sampled register*, so
                // the two targets need a different vararg count -- keep them as two
                // separate sprintf calls (a ternary format string would mis-read the
                // tail, see the compare-op note below).
                else if (op == 0x28) { const char* c3 = agal_is_cube(n2) ? ".xyz" : ".xy"; if (target == 0) sprintf(rhs, "%s.sample(smp%d, %s%s).%c", s2b, n2, s1, c3, c1); else if (target == 2) sprintf(rhs, "%s.Sample(smp%d, %s%s).%c", s2b, n2, s1, c3, c1); else sprintf(rhs, "%s(%s, %s%s).%c", agal_is_cube(n2) ? "textureCube" : "texture2D", s2b, s1, c3, c1); }
                else if (op == 0x29) sprintf(rhs, "(%s.%c >= %s.%c) ? 1.0 : 0.0", s1b, c1, s2b, c2);
                else if (op == 0x2a) sprintf(rhs, "(%s.%c < %s.%c) ? 1.0 : 0.0", s1b, c1, s2b, c2);
                else if (op == 0x2c) sprintf(rhs, "(%s.%c == %s.%c) ? 1.0 : 0.0", s1b, c1, s2b, c2);
                else if (op == 0x2d) sprintf(rhs, "(%s.%c != %s.%c) ? 1.0 : 0.0", s1b, c1, s2b, c2);
                if (rhs[0] == 0) { agal_unsupported(op); continue; }
                char t[192]; sprintf(t, "    %s.%c = %s;\\n", dname, ch, rhs); as_json_buf_append_cstr(b, t);
            }
            continue;
        }
        // Full-mask: build a full-float4 RHS expression.
        char rhs[256]; rhs[0] = 0;
        if (op == 0x00) sprintf(rhs, "%s", s1);
        else if (op >= 0x01 && op <= 0x04) { const char* o = op == 0x01 ? "+" : op == 0x02 ? "-" : op == 0x03 ? "*" : "/"; sprintf(rhs, "%s %s %s", s1, o, s2); }
        else if (op == 0x05) sprintf(rhs, "1.0 / %s", s1);
        else if (op == 0x06) sprintf(rhs, "min(%s, %s)", s1, s2);
        else if (op == 0x07) sprintf(rhs, "max(%s, %s)", s1, s2);
        else if (op == 0x08) sprintf(rhs, "%s(%s)", f_fract, s1);
        else if (op == 0x09) sprintf(rhs, "sqrt(%s)", s1);
        else if (op == 0x0a) { if (target == 2) sprintf(rhs, "rsqrt(%s)", s1); else sprintf(rhs, "1.0 / sqrt(%s)", s1); }
        else if (op == 0x0b) sprintf(rhs, "pow(%s, %s)", s1, s2);
        else if (op == 0x0c) sprintf(rhs, "log2(%s)", s1);
        else if (op == 0x0d) sprintf(rhs, "exp2(%s)", s1);
        else if (op == 0x0e) sprintf(rhs, "normalize(%s)", s1);
        else if (op == 0x0f) sprintf(rhs, "sin(%s)", s1);
        else if (op == 0x10) sprintf(rhs, "cos(%s)", s1);
        else if (op == 0x11) sprintf(rhs, "%s(cross(%s.xyz, %s.xyz), 1.0)", v4, s1, s2);
        // dp3/dp4 yield a SCALAR dot product and the destination is a float4, so
        // the vector constructor is needed -- but fxc rejects a scalar-splat
        // constructor outright (X3014, see the note above the HLSL preamble), and
        // it does so even for a literal like float4(1.0). HLSL's scalar swizzle is
        // the portable spelling: 'dot(a, b).xxxx' splats the scalar without
        // recomputing it. Splitting the format per target is required, not
        // cosmetic -- one shared format string cannot express both.
        else if (op == 0x12) { if (target == 2) sprintf(rhs, "dot(%s.xyz, %s.xyz).xxxx", s1, s2); else sprintf(rhs, "%s(dot(%s.xyz, %s.xyz))", v4, s1, s2); }
        else if (op == 0x13) { if (target == 2) sprintf(rhs, "dot(%s, %s).xxxx", s1, s2); else sprintf(rhs, "%s(dot(%s, %s))", v4, s1, s2); }
        else if (op == 0x14) sprintf(rhs, "abs(%s)", s1);
        else if (op == 0x15) sprintf(rhs, "-%s", s1);
        else if (op == 0x16) { if (target == 2) sprintf(rhs, "saturate(%s)", s1); else sprintf(rhs, "clamp(%s, 0.0, 1.0)", s1); }
        else if (op == 0x1a) sprintf(rhs, "%s(%s)", f_ddx, s1);
        else if (op == 0x1b) sprintf(rhs, "%s(%s)", f_ddy, s1);
        else if (op == 0x28) { const char* c3 = agal_is_cube(n2) ? ".xyz" : ".xy"; if (target == 0) sprintf(rhs, "%s.sample(smp%d, %s%s)", s2b, n2, s1, c3); else if (target == 2) sprintf(rhs, "%s.Sample(smp%d, %s%s)", s2b, n2, s1, c3); else sprintf(rhs, "%s(%s, %s%s)", agal_is_cube(n2) ? "textureCube" : "texture2D", s2b, s1, c3); }
        // Compare instructions: sge/slt/seq/sne produce a per-component 0.0/1.0
        // mask. The operands are float4 (or 4-component swizzles), so the natural
        // 'cond ? v4(1.0) : v4(0.0)' is invalid in BOTH targets -- MSL needs a
        // scalar condition and GLSL a bool (not bvecN) condition. select()/mix()
        // take the vector condition directly.
        //
        // These MUST be two separate sprintf calls rather than ONE sprintf with a
        // ternary format string: the two formats consume a different number of
        // varargs (MSL 4, GLSL 5) while the argument list is fixed, so the
        // untaken branch's formats silently mis-read the tail ('mix(..., v0,
        // s2, v4)' instead of 'mix(..., v4, s1, s2)'), producing 'v0(lessThan(
        // v1, vec4))' -- a GLSL syntax error that killed every full-mask compare
        // on the web target (Starling's CompositeFilter, i.e. the demo's "Switch
        // Filter" button, was the only scene that hit it).
        //
        // GLSL side: mix(vec4, vec4, vec4) is legal ES 1.00 (§8.3), and the bvec4
        // -> vec4 conversion is spelled out by ES 1.00 §5.4.2 ("If the basic type
        // of a parameter to a constructor does not match ... the scalar
        // construction rules are used to convert", cf. 'vec4(ivec4)'). mix() with
        // a bvecN condition, by contrast, only exists in ES 3.00 -- and our GLSL
        // is emitted as ES 1.00 (no #version directive), so it would not compile.
        else if (op == 0x29) { if (target == 0) sprintf(rhs, "select(%s(0.0), %s(1.0), %s >= %s)", v4, v4, s1, s2); else if (target == 2) sprintf(rhs, "%s(%s >= %s)", v4, s1, s2); else sprintf(rhs, "mix(%s(0.0), %s(1.0), %s(greaterThanEqual(%s, %s)))", v4, v4, v4, s1, s2); }
        else if (op == 0x2a) { if (target == 0) sprintf(rhs, "select(%s(0.0), %s(1.0), %s < %s)", v4, v4, s1, s2); else if (target == 2) sprintf(rhs, "%s(%s < %s)", v4, s1, s2); else sprintf(rhs, "mix(%s(0.0), %s(1.0), %s(lessThan(%s, %s)))", v4, v4, v4, s1, s2); }
        else if (op == 0x2c) { if (target == 0) sprintf(rhs, "select(%s(0.0), %s(1.0), %s == %s)", v4, v4, s1, s2); else if (target == 2) sprintf(rhs, "%s(%s == %s)", v4, s1, s2); else sprintf(rhs, "mix(%s(0.0), %s(1.0), %s(equal(%s, %s)))", v4, v4, v4, s1, s2); }
        else if (op == 0x2d) { if (target == 0) sprintf(rhs, "select(%s(0.0), %s(1.0), %s != %s)", v4, v4, s1, s2); else if (target == 2) sprintf(rhs, "%s(%s != %s)", v4, s1, s2); else sprintf(rhs, "mix(%s(0.0), %s(1.0), %s(notEqual(%s, %s)))", v4, v4, v4, s1, s2); }
        if (rhs[0] == 0) { agal_unsupported(op); continue; }
        char t[300]; sprintf(t, "    %s = %s;\\n", dname, rhs); as_json_buf_append_cstr(b, t);
    }
}

// Track which registers are referenced, so the emitted shader only declares
// those. Indexed by logical register class (0..7 = type code), each a 256-bit
// usage bitmap (8×u32). Constant/temporary/output classes are shared between
// vertex and fragment (vc=fc=1, vt=ft=2, op=oc=3), disambiguated by agal_is_frag.
static int agal_used[8][8];
static void agal_mark_use(int type, int num) { if (type >= 0 && type < 8 && num >= 0 && num < 256) agal_used[type][num / 32] |= (1u << (num % 32)); }
static int agal_is_used(int type, int num) { return (type >= 0 && type < 8 && num >= 0 && num < 256) ? ((agal_used[type][num / 32] >> (num % 32)) & 1u) : 0; }

// ---- AGAL sampler flags ------------------------------------------------------
//
// Stage3D honours the sampler flags written in the AGAL 'tex'/'tld' instruction
// (<2d|3d|cube, nearest|linear, nomip|mipnearest|miplinear, clamp|repeat>), and
// they are the ONLY sampler state away3d and Starling ever supply: neither calls
// setSamplerStateAt (0 hits in either tree) -- they just write
// <cube,linear,miplinear> (away3d's env-map/skybox path) or <2d,linear,nomip> in
// the AGAL. Measured on AIR 51.4.1 (temp/sampprobe, 13 tests x 2 readbacks):
// the same program with <2d,linear,nomip> vs <2d,nearest,nomip> renders a
// bilinear grey vs pure texel colours, and miplinear with tiled uv lands on the
// expected mip level (lod = log2(texels per pixel): level 1/2/4 at 8/16/64 uv
// tiles of a 64 px texture). setSamplerStateAt writes the SAME per-unit state,
// so the effective state is "last writer wins" in call order -- also measured: a
// setSamplerStateAt call after setProgram wins, one before it loses.
//
// Ignoring these flags (as this runtime did before stage 一百一十三) only LOOKED
// right while the fallback sampler default happened to coincide with what the
// program asked for. It did for away3d's default <cube,linear,miplinear> path,
// but away3d's 'useSmoothTextures = false' path asks for 'nearest' and would
// have silently rendered bilinear.
//
// Bit layout is AGALMiniAssembler's (SAMPLER_*_SHIFT): filter 28 (0 nearest,
// 1 linear), mipmap 24 (0 nomip, 1 mipnearest, 2 miplinear), repeat/wrap 20
// (0 clamp, 1 repeat), dim 12 (0 2d, 1 cube, 2 3d), type 8. Decoded into a
// used-bitmask plus one packed word (filter | wrap<<1 | mip<<2 per register,
// 4 bits each) -- the encoding s3d_set_sampler_state_i and the glue's sampler
// cache use: 0 = linear, 1 = nearest / 0 = clamp, 1 = repeat / 0 = none,
// 1 = nearest, 2 = linear. The backend binds 8 texture units (Stage3D's
// fs0..fs7), so higher sampler registers are skipped; malformed bytecode is
// left for as_agal_translate to report.
static void as_agal_sampler_flags(const unsigned char* bytes, int len, unsigned int* usedOut, unsigned int* flagsOut) {
    *usedOut = 0;
    *flagsOut = 0;
    if (len < 7 || bytes[0] != 0xA0) return;
    int pos = 7;
    while (pos + 24 <= len) {
        int inst_start = pos;
        unsigned op = as_agal_u32(bytes + pos) & 0xFFu; pos += 4;
        if (op > 0x2e || agal_op_name[op] == NULL) return;
        int nreg = agal_op_nreg[op];
        int hasDst = (nreg >= 1) && !agal_op_nodest[op];
        int hasSrc1 = nreg >= (hasDst ? 2 : 1);
        int hasSrc2 = nreg >= (hasDst ? 3 : 2);
        // The assembler always emits the 4-byte destination slot
        // (AGALMiniAssembler writes 4 zero bytes when the first operand is a
        // source), so it must be skipped even for OP_NO_DEST opcodes: otherwise
        // every operand of ife/ine/ifg/ifl/els/eif/kil is misread.
        pos += 4;
        if (hasSrc1) pos += 8;
        if (hasSrc2) {
            unsigned s2lo = as_agal_u32(bytes + pos);
            unsigned s2hi = as_agal_u32(bytes + pos + 4);
            int unit = (int)(s2lo & 0xFFFFu);
            if ((op == 0x28 || op == 0x2e) && unit >= 0 && unit < 8) {
                int filter = (int)((s2hi >> 28) & 0x3u);   // AGAL: 0 nearest, 1 linear
                int mip = (int)((s2hi >> 24) & 0x3u);      // 0 nomip, 1 mipnearest, 2 miplinear
                int wrap = (int)((s2hi >> 20) & 0x3u);     // 0 clamp, 1 repeat
                if (mip > 2) mip = 0;
                if (wrap > 1) wrap = 0;
                *usedOut |= (1u << unit);
                // AGAL's filter bit is 1 for LINEAR; the backend's is 1 for
                // NEAREST, so it is inverted on the way across.
                *flagsOut |= ((unsigned)((filter == 1 ? 0 : 1) | (wrap << 1) | (mip << 2)) << (4 * unit));
            }
            pos += 8;
        }
        pos = inst_start + 24;   // the assembler emits fixed 24-byte slots
    }
}

static char* as_agal_translate(const unsigned char* bytes, int len, int target) {
    as_agal_errmsg = NULL;
    if (len < 7) { as_agal_errmsg = "AGAL: bytecode too short for header"; return NULL; }
    if (bytes[0] != 0xA0) { as_agal_errmsg = "AGAL: bad magic (expected 0xA0)"; return NULL; }
    if (bytes[5] != 0xA1) { as_agal_errmsg = "AGAL: bad program type marker (expected 0xA1)"; return NULL; }
    unsigned version = as_agal_u32(bytes + 1);
    if (version < 1 || version > 3) { as_agal_errmsg = "AGAL: unsupported version"; return NULL; }
    int isFragment = bytes[6] & 1;
    agal_is_frag = isFragment;
    memset(agal_used, 0, sizeof(agal_used));
    memset(agal_cube, 0, sizeof(agal_cube));
    agal_instr ins[200];
    int n = 0, pos = 7;
    // The official AGALMiniAssembler emits each instruction as a fixed 192-bit
    // (24-byte) slot: 32-bit opcode + up to 160 bits of operands, zero-padded.
    // Operand counts are NOT encoded in the opcode token (see agal_op_nreg), so
    // the trailing zero-padding must be skipped to reach the next instruction.
    while (pos + 24 <= len) {
        if (n >= 200) { as_agal_errmsg = "AGAL: too many instructions (limit 200)"; return NULL; }
        int inst_start = pos;
        unsigned op_tok = as_agal_u32(bytes + pos); pos += 4;
        int op = op_tok & 0xFF;
        if (op > 0x2e || agal_op_name[op] == NULL) { as_agal_errmsg = "AGAL: invalid opcode"; return NULL; }
        int nreg = agal_op_nreg[op];
        int hasDst = (nreg >= 1) && !agal_op_nodest[op];
        int hasSrc1 = nreg >= (hasDst ? 2 : 1);
        int hasSrc2 = nreg >= (hasDst ? 3 : 2);
        agal_instr* I = &ins[n];
        memset(I, 0, sizeof(*I));
        I->op = (unsigned)op;
        if (hasDst) { I->dst = as_agal_u32(bytes + pos); int t = (I->dst >> 24) & 0xFF, num = I->dst & 0xFFFF; agal_mark_use(t, num); }
        // The destination slot is ALWAYS 4 bytes wide: for an OP_NO_DEST opcode
        // the assembler writes four zero bytes there (j==0 case) and the real
        // first operand lands in the src1 slot. Skipping it only when hasDst
        // shifted every operand of kil/ife/ine/ifg/ifl by 4 bytes, which turned
        // the EnvMapMethod discard on the cube sample's alpha (kil ft4.w) into a
        // discard on the transformed normal's x: a cut along the plane x=0,
        // visible as a vertical line at the screen centre.
        pos += 4;
        if (hasSrc1) { I->s1lo = as_agal_u32(bytes + pos); I->s1hi = as_agal_u32(bytes + pos + 4); pos += 8; agal_mark_use(I->s1hi & 0xFF, I->s1lo & 0xFFFF); }
        if (hasSrc2) { I->s2lo = as_agal_u32(bytes + pos); I->s2hi = as_agal_u32(bytes + pos + 4); pos += 8; if (op == 0x28 || op == 0x2e) { agal_mark_use(AGAL_FS, I->s2lo & 0xFFFF); if (((I->s2hi >> 12) & 0x3u) == 1u) agal_mark_cube(I->s2lo & 0xFFFF); } else { agal_mark_use(I->s2hi & 0xFF, I->s2lo & 0xFFFF);
            // Matrix x vector (m33/m34/m44) reads src2..src2+rows-1 as consecutive
            // registers, so the extra rows the instruction touches must be marked as
            // used too. The MSL target declares one whole constant float4* vc array
            // and never noticed, but the GLSL target declares ONE uniform per
            // register (uniform vec4 vc0; vc1; ...): an unmarked row is undeclared
            // and the shader fails to compile ("vc1: undeclared identifier").
            int mrows = (op == 0x18) ? 4 : ((op == 0x17 || op == 0x19) ? 3 : 0);
            for (int r = 1; r < mrows; r++) agal_mark_use(I->s2hi & 0xFF, (I->s2lo & 0xFFFF) + r); } }
        pos = inst_start + 24; // skip the fixed-size padding to the next slot
        n++;
    }
    if (n == 0) { as_agal_errmsg = "AGAL: empty program"; return NULL; }
    as_json_buf b; as_json_buf_init(&b);
    if (target == 0) {
        // ---- MSL ----
        as_json_buf_append_cstr(&b, "#include <metal_stdlib>\\nusing namespace metal;\\n\\n");
        if (!isFragment) {
            as_json_buf_append_cstr(&b, "struct VSIn {\\n");
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_VA, i)) { char t[64]; sprintf(t, "  float4 a%d [[attribute(%d)]];\\n", i, i); as_json_buf_append_cstr(&b, t); }
            as_json_buf_append_cstr(&b, "};\\nstruct VSOut {\\n  float4 position [[position]];\\n");
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_V, i)) { char t[64]; sprintf(t, "  float4 varying%d [[user(locn%d)]];\\n", i, i); as_json_buf_append_cstr(&b, t); }
            as_json_buf_append_cstr(&b, "};\\n\\nvertex VSOut vs_main(\\n  VSIn in [[stage_in]],\\n  constant float4* vc [[buffer(0)]]\\n) {\\n  VSOut out;\\n  float4 op;\\n");
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_VT, i)) { char t[32]; sprintf(t, "  float4 vt%d;\\n", i); as_json_buf_append_cstr(&b, t); }
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_V, i)) { char t[32]; sprintf(t, "  float4 v%d;\\n", i); as_json_buf_append_cstr(&b, t); }
        } else {
            as_json_buf_append_cstr(&b, "struct FSIn {\\n");
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_V, i)) { char t[64]; sprintf(t, "  float4 v%d [[user(locn%d)]];\\n", i, i); as_json_buf_append_cstr(&b, t); }
            as_json_buf_append_cstr(&b, "};\\nfragment float4 fs_main(\\n  FSIn in [[stage_in]],\\n  constant float4* fc [[buffer(0)]]");
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_FS, i)) { char t[48]; sprintf(t, ",\\n  %s fs%d [[texture(%d)]]", agal_is_cube(i) ? "texturecube<float>" : "texture2d<float>", i, i); as_json_buf_append_cstr(&b, t); }
            // One sampler per texture register the program samples. Metal keeps no
            // filter/wrap/mip state on the texture object itself, so a single shared
            // sampler (the pre-stage-89-39 shape) forced every unit to use one
            // state -- setSamplerStateAt could only ever be observed for the lowest
            // bound unit. Each smpN is bound at sampler index N by the draw encoder
            // (vendor/stage3d_glue.mm for native Metal, where Metal also *requires*
            // every [[sampler(N)]] the shader declares to have state bound).
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_FS, i)) { char t[48]; sprintf(t, ",\\n  sampler smp%d [[sampler(%d)]]", i, i); as_json_buf_append_cstr(&b, t); }
            as_json_buf_append_cstr(&b, "\\n) {\\n  float4 oc;\\n");
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_VT, i)) { char t[32]; sprintf(t, "  float4 ft%d;\\n", i); as_json_buf_append_cstr(&b, t); }
        }
        agal_emit_body(&b, ins, n, target);
        if (as_agal_errmsg != NULL) { free(b.buf); return NULL; }
        if (!isFragment) {
            as_json_buf_append_cstr(&b, "  out.position = op;\\n");
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_V, i)) { char t[48]; sprintf(t, "  out.varying%d = v%d;\\n", i, i); as_json_buf_append_cstr(&b, t); }
            as_json_buf_append_cstr(&b, "  return out;\\n");
        } else {
            as_json_buf_append_cstr(&b, "  return oc;\\n");
        }
        as_json_buf_append_cstr(&b, "}\\n");
    } else if (target == 1) {
        // ---- GLSL ES 1.00 (WebGL2 accepts ES 1.00 sources) ----
        // Precision: highp everywhere. ES 3.00 (and therefore WebGL2) guarantees
        // highp in fragment shaders, and Starling's programs do matrix math on
        // stage coordinates whose magnitude exceeds mediump's usable range.
        if (isFragment && agal_is_used(AGAL_OD, 0))
            as_json_buf_append_cstr(&b, "#extension GL_EXT_frag_depth : enable\\n");
        as_json_buf_append_cstr(&b, "precision highp float;\\n");
        for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_VC, i)) { char t[40]; sprintf(t, "uniform vec4 %s%d;\\n", isFragment ? "fc" : "vc", i); as_json_buf_append_cstr(&b, t); }
        // Attributes (vertex) and varyings. ES 1.00 has no [[stage_in]] struct, so
        // the vertex stage declares v0..vN as varying at file scope (the MSL path
        // uses local temps copied into out.varyingN instead) and the fragment stage
        // reads the same declarations; they must match exactly or the varying is
        // undefined.
        for (int i = 0; i < 256; i++) if (agal_is_used(isFragment ? AGAL_V : AGAL_VA, i)) { char t[48]; sprintf(t, "%s vec4 %s%d;\\n", isFragment ? "varying" : "attribute", isFragment ? "v" : "va", i); as_json_buf_append_cstr(&b, t); }
        if (!isFragment) for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_V, i)) { char t[40]; sprintf(t, "varying vec4 v%d;\\n", i); as_json_buf_append_cstr(&b, t); }
        if (isFragment) for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_FS, i)) { char t[40]; sprintf(t, "uniform %s fs%d;\\n", agal_is_cube(i) ? "samplerCube" : "sampler2D", i); as_json_buf_append_cstr(&b, t); }
        as_json_buf_append_cstr(&b, "void main() {\\n");
        for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_VT, i)) { char t[32]; sprintf(t, "  vec4 %s%d;\\n", isFragment ? "ft" : "vt", i); as_json_buf_append_cstr(&b, t); }
        agal_emit_body(&b, ins, n, target);
        if (as_agal_errmsg != NULL) { free(b.buf); return NULL; }
        // Orientation: AS3 (and Metal, and every AIR backend) stores render-target
        // row 0 at the TOP of the image -- which is also how BitmapData pixels are
        // laid out, hence how texture coordinate v=0 is defined. GL stores row 0 at
        // the BOTTOM. Negating clip-space Y makes every GL render target (back
        // buffer and render textures) top-down like Metal's, keeps texture
        // sampling consistent with uploads, and makes a glReadPixels buffer start
        // at the image's top row for Skia. It also flips triangle winding, so the
        // GL backend keeps GL's default CCW front faces (Metal needed CW).
        if (!isFragment)
            as_json_buf_append_cstr(&b, "  gl_Position.y = -gl_Position.y;\\n");
        as_json_buf_append_cstr(&b, "}\\n");
    } else {
        // ---- HLSL (Direct3D shader model 4+) ----
        // Paired with vendor/stage3d_d3d.cc (the D3D12 backend, a SEPARATE
        // stage): that glue compiles these sources with D3DCompile at profile
        // vs_4_0 / ps_4_0 and calls the entry points vs_main / fs_main.
        //
        // Bound shape, and where it comes from. The constant registers stay an
        // ARRAY indexed by AGAL register number like MSL's vc[i], but HLSL wants
        // them in a cbuffer with an explicit register(bN) slot (MSL uses a
        // 'constant float4*' with [[buffer(0)]]). Textures and samplers are
        // declared one per sampled register -- exactly the shape stage 89.39
        // settled on for MSL -- because D3D has no "sampler state lives on the
        // texture object" model either (that one is GLSL's).
        //
        // Orientation: NOT flipped. AS3, and Metal, and D3D all put render
        // target row 0 at the TOP; only GL is bottom-up. The GLSL branch's
        // 'gl_Position.y = -gl_Position.y' is therefore deliberately NOT emitted
        // here (to be re-confirmed with a pixel readback the first time a
        // Windows Stage3D build runs -- see TODO.md).
        if (!isFragment) {
            // HLSL rejects an EMPTY struct, so a struct type only exists when the
            // program really reads one: a shader with no vertex attributes takes
            // no struct parameter at all.
            int hasVA = 0; for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_VA, i)) { hasVA = 1; break; }
            if (hasVA) {
                as_json_buf_append_cstr(&b, "struct VSIn {\\n");
                for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_VA, i)) { char t[64]; sprintf(t, "  float4 a%d : TEXCOORD%d;\\n", i, i); as_json_buf_append_cstr(&b, t); }
                as_json_buf_append_cstr(&b, "};\\n");
            }
            // VARYINGS BEFORE SV_Position, and that order is load-bearing: D3D's PSO
            // validation matches the two stages by semantic name+index AND by the
            // DXBC register fxc assigned that semantic, and fxc numbers a
            // stage-input/output struct's registers in DECLARATION order from 0. With
            // position first, a one-varying program gets VSOut TEXCOORD0 at register
            // 1 (SV_Position took 0) while FSIn's TEXCOORD0 sits at register 0 --
            // CreateGraphicsPipelineState then fails outright with E_INVALIDARG,
            // "Semantic 'TEXCOORD' is defined for mismatched hardware registers
            // between the output stage and input stage" (reproduced and bisected with
            // temp/psoprobe.cc + the D3D12 debug layer; the identical shader pair
            // builds as soon as the two fields swap). Both loops walk AGAL_V in
            // ascending order, so the two register sequences line up exactly.
            as_json_buf_append_cstr(&b, "struct VSOut {\\n");
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_V, i)) { char t[64]; sprintf(t, "  float4 varying%d : TEXCOORD%d;\\n", i, i); as_json_buf_append_cstr(&b, t); }
            as_json_buf_append_cstr(&b, "  float4 position : SV_Position;\\n");
            as_json_buf_append_cstr(&b, "};\\n");
            // The backend uploads the constant registers contiguously from index
            // 0, so the array is sized to the highest register the program
            // touches and the AGAL register number IS the array index.
            int cmax = -1; for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_VC, i)) cmax = i;
            if (cmax >= 0) { char t[64]; sprintf(t, "cbuffer VCBuf : register(b0) { float4 vc[%d]; };\\n", cmax + 1); as_json_buf_append_cstr(&b, t); }
            // AGAL3 vertex texture fetch (a tex/tld in a VERTEX program) needs
            // the same texture + sampler declarations in the vertex stage.
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_FS, i)) { char t[64]; sprintf(t, "%s fs%d : register(t%d);\\n", agal_is_cube(i) ? "TextureCube<float4>" : "Texture2D<float4>", i, i); as_json_buf_append_cstr(&b, t); }
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_FS, i)) { char t[64]; sprintf(t, "SamplerState smp%d : register(s%d);\\n", i, i); as_json_buf_append_cstr(&b, t); }
            as_json_buf_append_cstr(&b, "VSOut vs_main(");
            if (hasVA) as_json_buf_append_cstr(&b, "VSIn input");
            // AGAL3 instance id: a uint system value, broadcast to a float4 in
            // agal_reg_name so the shared component/swizzle paths keep working.
            if (agal_is_used(AGAL_IID, 0)) as_json_buf_append_cstr(&b, hasVA ? ", uint iid : SV_InstanceID" : "uint iid : SV_InstanceID");
            as_json_buf_append_cstr(&b, ") {\\n  float4 op;\\n");
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_VT, i)) { char t[32]; sprintf(t, "  float4 vt%d;\\n", i); as_json_buf_append_cstr(&b, t); }
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_V, i)) { char t[32]; sprintf(t, "  float4 v%d;\\n", i); as_json_buf_append_cstr(&b, t); }
        } else {
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_FS, i)) { char t[64]; sprintf(t, "%s fs%d : register(t%d);\\n", agal_is_cube(i) ? "TextureCube<float4>" : "Texture2D<float4>", i, i); as_json_buf_append_cstr(&b, t); }
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_FS, i)) { char t[64]; sprintf(t, "SamplerState smp%d : register(s%d);\\n", i, i); as_json_buf_append_cstr(&b, t); }
            // Same empty-struct rule as VSIn above.
            int hasV = 0; for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_V, i)) { hasV = 1; break; }
            if (hasV) {
                as_json_buf_append_cstr(&b, "struct FSIn {\\n");
                for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_V, i)) { char t[64]; sprintf(t, "  float4 v%d : TEXCOORD%d;\\n", i, i); as_json_buf_append_cstr(&b, t); }
                as_json_buf_append_cstr(&b, "};\\n");
            }
            // Output struct: SV_Target0 for oc0, SV_TargetN for MRT (oc1..oc3 --
            // the MSL/GLSL targets still fold every ocN into a single output, a
            // pre-existing limitation of theirs), and SV_Depth when the program
            // writes the od register.
            as_json_buf_append_cstr(&b, "struct FSOut {\\n  float4 color0 : SV_Target0;\\n");
            for (int i = 1; i < 4; i++) if (agal_is_used(AGAL_OP, i)) { char t[64]; sprintf(t, "  float4 color%d : SV_Target%d;\\n", i, i); as_json_buf_append_cstr(&b, t); }
            if (agal_is_used(AGAL_OD, 0)) as_json_buf_append_cstr(&b, "  float depth : SV_Depth;\\n");
            as_json_buf_append_cstr(&b, "};\\n");
            int cmax = -1; for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_VC, i)) cmax = i;
            if (cmax >= 0) { char t[64]; sprintf(t, "cbuffer FCBuf : register(b0) { float4 fc[%d]; };\\n", cmax + 1); as_json_buf_append_cstr(&b, t); }
            as_json_buf_append_cstr(&b, hasV ? "FSOut fs_main(FSIn input) {\\n  float4 oc;\\n" : "FSOut fs_main() {\\n  float4 oc;\\n");
            for (int i = 1; i < 4; i++) if (agal_is_used(AGAL_OP, i)) { char t[32]; sprintf(t, "  float4 oc%d;\\n", i); as_json_buf_append_cstr(&b, t); }
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_VT, i)) { char t[32]; sprintf(t, "  float4 ft%d;\\n", i); as_json_buf_append_cstr(&b, t); }
            if (agal_is_used(AGAL_OD, 0)) as_json_buf_append_cstr(&b, "  float od;\\n");
        }
        agal_emit_body(&b, ins, n, target);
        if (as_agal_errmsg != NULL) { free(b.buf); return NULL; }
        if (!isFragment) {
            as_json_buf_append_cstr(&b, "  VSOut output;\\n  output.position = op;\\n");
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_V, i)) { char t[48]; sprintf(t, "  output.varying%d = v%d;\\n", i, i); as_json_buf_append_cstr(&b, t); }
            as_json_buf_append_cstr(&b, "  return output;\\n");
        } else {
            as_json_buf_append_cstr(&b, "  FSOut output;\\n  output.color0 = oc;\\n");
            for (int i = 1; i < 4; i++) if (agal_is_used(AGAL_OP, i)) { char t[48]; sprintf(t, "  output.color%d = oc%d;\\n", i, i); as_json_buf_append_cstr(&b, t); }
            if (agal_is_used(AGAL_OD, 0)) as_json_buf_append_cstr(&b, "  output.depth = od;\\n");
            as_json_buf_append_cstr(&b, "  return output;\\n");
        }
        as_json_buf_append_cstr(&b, "}\\n");
    }
    char* out = as_str_alloc(b.len + 1);
    memcpy(out, b.buf, b.len + 1);
    free(b.buf);
    return out;
}

// Shader language handed to the AGAL translator must match the linked Stage3D
// glue: stage3d_glue.mm compiles MSL (target 0), stage3d_webgl.cc compiles GLSL
// ES (target 1), and the Windows D3D12 backend (vendor/stage3d_d3d.cc, which
// emits HLSL) compiles target 2. Web manifests set ASC_S3D_GLSL alongside the GL
// glue; a Windows Stage3D manifest sets ASC_S3D_HLSL. With no macro at all the
// translator stays on MSL, so a build that never mentions Stage3D is unchanged.
#ifndef ASC_AGAL_TARGET
#ifdef ASC_S3D_HLSL
#define ASC_AGAL_TARGET 2
#elif defined(ASC_S3D_GLSL)
#define ASC_AGAL_TARGET 1
#else
#define ASC_AGAL_TARGET 0
#endif
#endif

// ---------- Stage3D raw Metal bridge (stage 82) ----------
// Exposes vendor/stage3d_glue.mm's offscreen programmable pipeline (MTLBuffer
// vertex/index, MTLTexture, MSL-compiled AGAL programs, MTLRenderPassDescriptor
// render-to-texture) to the generated C. The glue is Objective-C++, so these
// extern "C" symbols are only linked for native builds where air-app.ts (or a
// build manifest) adds ASC_RENDER_STAGE3D. The as_s3d_* wrappers below no-op in
// pure-C builds, keeping the Context3D state machine link-clean without Metal.
//
// Vertex/constant data crosses the boundary as double (AS3 Vector.<Number>); the
// glue converts to float32 for the GPU. Index data is uint32 (Vector.<uint>).
// Textures cross as ARGB uint32 (BitmapData.pixels) and are converted to BGRA.
#ifdef ASC_RENDER_STAGE3D
extern void* s3d_create(int width, int height);
extern void s3d_destroy(void* ctx);
extern int s3d_resize(void* ctx, int width, int height);
extern int s3d_upload_vertex(void* ctx, int stream, const double* data, int numVertices, int components);
extern int s3d_upload_index(void* ctx, const uint32_t* data, int numIndices);
extern int s3d_upload_constants(void* ctx, int isFragment, const double* data, int count);
extern void* s3d_upload_texture(void* ctx, int unit, int width, int height, const uint32_t* argb);
extern void* s3d_upload_cube_texture(void* ctx, int unit, int size, const uint32_t* const* argb);
extern void* s3d_texture_from_pixels(void* ctx, int width, int height, const uint32_t* argb);
// Upload ONE mip level (level > 0) from the top-left lw x lh rectangle of a
// source bitmap whose row stride is srcW pixels. Called when the app passes a
// mip level to uploadFromBitmapData; AIR's region semantics were measured in
// temp/mipprobe (see Texture_uploadFromBitmapData in emit.ts).
extern void s3d_texture_upload_level(void* ctx, void* tex, int level, int lw, int lh, const uint32_t* src, int srcW);
extern int s3d_compile(void* ctx, void* key, const char* vs_msl, const char* fs_msl, char* errbuf, int errbuf_size);
extern void s3d_clear(void* ctx, float r, float g, float b, float a, float depth, unsigned int stencil, int maskBits);
extern void s3d_set_blend(void* ctx, const char* sourceFactor, const char* destFactor);
extern void s3d_set_instance_count(void* ctx, int n);
// Stage3D state machine (applied by the glue when the next draw is encoded).
extern void s3d_set_depth(void* ctx, int depthMask, const char* compareMode);
extern void s3d_set_cull(void* ctx, const char* face);
extern void s3d_set_stencil(void* ctx, const char* face, const char* compare, const char* bothPass, const char* depthFail, const char* dpFail);
extern void s3d_set_stencil_ref(void* ctx, unsigned int ref, unsigned int readMask, unsigned int writeMask);
extern void s3d_set_sampler_state(void* ctx, int unit, const char* wrap, const char* filter, const char* mipfilter);
// Same per-unit state, from already-decoded ints (AGAL flags -> unit state).
// filter: 0 linear / 1 nearest; wrap: 0 clamp / 1 repeat; mip: 0 none /
// 1 nearest / 2 linear.
extern void s3d_set_sampler_state_i(void* ctx, int unit, int filter, int wrap, int mip);
extern void s3d_set_color_mask(void* ctx, int r, int g, int b, int a);
extern void s3d_set_scissor(void* ctx, int on, int x, int y, int w, int h);
extern int s3d_draw(void* ctx, int numTriangles);
// Retiring the frame's batched draws. The glue defers the per-draw
// commit/waitUntilCompleted (which serialized CPU against GPU at ~0.5 ms of
// round-trip latency per draw) into one submission per frame, in two flavours:
// commit+wait (s3d_flush, used inside the glue before a CPU readback, a resize or
// a destroy) and commit-only (s3d_flush_async, the frame boundary, where the
// shared command queue's ordering already protects the composite).
extern void s3d_flush(void* ctx);
extern void s3d_flush_async(void* ctx);
extern void s3d_flush_all(void);
extern void s3d_flush_all_async(void);
extern int s3d_readback(void* ctx, uint8_t* out);
extern int s3d_width(void* ctx);
extern int s3d_height(void* ctx);
extern void* s3d_create_render_texture(void* ctx, int width, int height);
extern void s3d_set_render_target(void* ctx, void* tex, int enableDepthAndStencil);
extern int s3d_bind_texture(void* ctx, int unit, void* tex, int hasChain);
extern int s3d_readback_render(void* ctx, uint8_t* out);
extern void s3d_destroy_texture(void* tex);
extern void* s3d_get_render_target(void* ctx);
#endif

// ---- ATF (Adobe Texture Format) ----
// AIR's uploadCompressedTextureFromByteArray hands the container straight to the
// GPU, which decodes the block-compressed payload (S3TC) in hardware. Our
// backend takes plain BGRA8 pixels, so we parse the container and decode the DXT
// record of mip level 0 on the CPU -- the same fallback AIR itself uses on
// devices without S3TC. Without this the texture stays empty and every quad
// sampling it renders as a flat (often pink) block.
//
// Container layout, two header generations (Adobe's "ATF file format" article;
// mirrored by openfl's display3D/_internal/ATFReader.hx and Ruffle's
// render/src/atf.rs):
//   legacy: "ATF" | u24 length | tdata | wLog2 | hLog2 | mipCount
//   modern: "ATF" | 00 00 FF 02 .. (byte 6 == 0xFF):
//           "ATF" | u8 | u8 | 0xFF | version | u32BE length
//                 | tdata | wLog2 | hLog2 | mipCount
// tdata's high bit is the cubemap flag, its low 7 bits are the ATF format:
// 3 = RAW_COMPRESSED (DXT1), 5 = RAW_COMPRESSED_ALPHA (DXT5). Each mip level
// then holds one length-prefixed record per GPU format (DXT, ETC1, PVRTC[4],
// ETC2 -- 4 only from version 3 on). We decode the DXT record, which is what the
// desktop GL/Metal path of AIR binds. Length prefixes are u24 for version 0 and
// u32BE otherwise.
static inline int as_atf_u24(const unsigned char* p) { return (p[0] << 16) | (p[1] << 8) | p[2]; }
static inline int as_atf_u32(const unsigned char* p) { return ((int)p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]; }
// 5-6-5 -> 8-8-8, replicating the high bits into the low ones.
static inline void as_dxt_unpack565(int c, int* r, int* g, int* b) {
    int rr = (c >> 11) & 31, gg = (c >> 5) & 63, bb = c & 31;
    *r = (rr << 3) | (rr >> 2); *g = (gg << 2) | (gg >> 4); *b = (bb << 3) | (bb >> 2);
}
// Decode one 4x4 block of a DXT1 (8-byte) or DXT5 (16-byte) block into ARGB.
static void as_dxt_block(const unsigned char* blk, int dxt5, unsigned* out) {
    int a[16], i;
    if (dxt5) {
        // 8 bytes of alpha: two endpoints plus 16 3-bit indices (48 bits).
        int a0 = blk[0], a1 = blk[1];
        unsigned long long ai = 0;
        for (i = 0; i < 6; i++) ai |= (unsigned long long)blk[2 + i] << (8 * i);
        int pal[8];
        pal[0] = a0; pal[1] = a1;
        if (a0 > a1) { for (i = 1; i < 7; i++) pal[1 + i] = ((7 - i) * a0 + i * a1) / 7; }
        else { for (i = 1; i < 5; i++) pal[1 + i] = ((5 - i) * a0 + i * a1) / 5; pal[6] = 0; pal[7] = 255; }
        for (i = 0; i < 16; i++) a[i] = pal[(int)((ai >> (3 * i)) & 7)];
    } else {
        // DXT1 carries only 1-bit alpha; the transparent code is index 3 in the
        // 3-colour (c0 <= c1) mode, which is also how the fourth palette entry
        // below is defined.
        for (i = 0; i < 16; i++) a[i] = 255;
    }
    const unsigned char* cp = blk + (dxt5 ? 8 : 0);
    int c0 = cp[0] | (cp[1] << 8), c1 = cp[2] | (cp[3] << 8);
    unsigned idx = (unsigned)cp[4] | ((unsigned)cp[5] << 8) | ((unsigned)cp[6] << 16) | ((unsigned)cp[7] << 24);
    int pr[4], pg[4], pb[4];
    as_dxt_unpack565(c0, &pr[0], &pg[0], &pb[0]);
    as_dxt_unpack565(c1, &pr[1], &pg[1], &pb[1]);
    if (c0 > c1) {
        pr[2] = (2 * pr[0] + pr[1] + 1) / 3; pg[2] = (2 * pg[0] + pg[1] + 1) / 3; pb[2] = (2 * pb[0] + pb[1] + 1) / 3;
        pr[3] = (2 * pr[1] + pr[0] + 1) / 3; pg[3] = (2 * pg[1] + pg[0] + 1) / 3; pb[3] = (2 * pb[1] + pb[0] + 1) / 3;
    } else {
        // 3-colour mode: index 2 averages the endpoints, index 3 is transparent
        // black. DXT1 gets its only alpha from that index; DXT5 takes alpha from
        // its own block, so the colour still resolves to black there.
        pr[2] = (pr[0] + pr[1]) / 2; pg[2] = (pg[0] + pg[1]) / 2; pb[2] = (pb[0] + pb[1]) / 2;
        pr[3] = 0; pg[3] = 0; pb[3] = 0;
        if (!dxt5) for (i = 0; i < 16; i++) if (((idx >> (2 * i)) & 3) == 3) a[i] = 0;
    }
    for (i = 0; i < 16; i++) {
        int ci = (int)((idx >> (2 * i)) & 3);
        out[i] = ((unsigned)a[i] << 24) | ((unsigned)pr[ci] << 16) | ((unsigned)pg[ci] << 8) | (unsigned)pb[ci];
    }
}
// Decode the DXT record of mip level 0. Returns a malloc'd ARGB buffer (the
// caller owns it) or NULL when the container is not one we can decode.
static unsigned* as_atf_decode_dxt(const unsigned char* data, int len, int* outW, int* outH) {
    if (data == NULL || len < 16) return NULL;
    if (data[0] != 'A' || data[1] != 'T' || data[2] != 'F') return NULL;
    int version, pos;
    if (data[6] == 0xFF) { version = data[7]; pos = 12; }
    else { version = 0; pos = 6; }
    int tdata = data[pos++];
    if (tdata >> 7) return NULL;                       // cubemap: six faces unsupported
    int fmt = tdata & 0x7F;
    if (fmt != 3 && fmt != 5) return NULL;             // JPEG-XR / lossy variants unsupported
    int w = 1 << data[pos++], h = 1 << data[pos++], mips = data[pos++];
    if (w <= 0 || h <= 0 || mips < 1) return NULL;
    int recs = (version < 3) ? 3 : 4;
    // Only level 0 is consumed: our texture handle is single-level (no mipmaps).
    const unsigned char* dxt = NULL;
    int dxtLen = 0, gi;
    for (gi = 0; gi < recs; gi++) {
        int n = (version == 0) ? as_atf_u24(data + pos) : as_atf_u32(data + pos);
        pos += (version == 0) ? 3 : 4;
        if (n < 0 || pos + n > len) return NULL;
        if (gi == 0) { dxt = data + pos; dxtLen = n; }
        pos += n;
    }
    int dxt5 = (fmt == 5);
    int bw = (w + 3) / 4, bh = (h + 3) / 4;
    if (dxt == NULL || dxtLen < bw * bh * (dxt5 ? 16 : 8)) return NULL;
    unsigned* px = (unsigned*)malloc(sizeof(unsigned) * (size_t)w * (size_t)h);
    if (px == NULL) return NULL;
    int by, bx;
    for (by = 0; by < bh; by++) {
        for (bx = 0; bx < bw; bx++) {
            unsigned blk[16];
            int x, y;
            as_dxt_block(dxt + ((size_t)by * bw + bx) * (dxt5 ? 16 : 8), dxt5, blk);
            for (y = 0; y < 4; y++) {
                int py = by * 4 + y;
                if (py >= h) break;
                for (x = 0; x < 4; x++) {
                    int pxx = bx * 4 + x;
                    if (pxx < w) px[(size_t)py * w + pxx] = blk[y * 4 + x];
                }
            }
        }
    }
    *outW = w; *outH = h;
    return px;
}
static inline void* as_s3d_create(int w, int h) {
#ifdef ASC_RENDER_STAGE3D
    return s3d_create(w, h);
#else
    (void)w; (void)h; return NULL;
#endif
}
static inline void as_s3d_destroy(void* ctx) {
#ifdef ASC_RENDER_STAGE3D
    s3d_destroy(ctx);
#else
    (void)ctx;
#endif
}
static inline int as_s3d_resize(void* ctx, int w, int h) {
#ifdef ASC_RENDER_STAGE3D
    return s3d_resize(ctx, w, h);
#else
    (void)ctx; (void)w; (void)h; return 0;
#endif
}
static inline int as_s3d_upload_vertex(void* ctx, int stream, const double* data, int numVertices, int components) {
#ifdef ASC_RENDER_STAGE3D
    return s3d_upload_vertex(ctx, stream, data, numVertices, components);
#else
    (void)ctx; (void)stream; (void)data; (void)numVertices; (void)components; return 0;
#endif
}
static inline int as_s3d_upload_index(void* ctx, const uint32_t* data, int numIndices) {
#ifdef ASC_RENDER_STAGE3D
    return s3d_upload_index(ctx, data, numIndices);
#else
    (void)ctx; (void)data; (void)numIndices; return 0;
#endif
}
static inline int as_s3d_upload_constants(void* ctx, int isFragment, const double* data, int count) {
#ifdef ASC_RENDER_STAGE3D
    return s3d_upload_constants(ctx, isFragment, data, count);
#else
    (void)ctx; (void)isFragment; (void)data; (void)count; return 0;
#endif
}
static inline void* as_s3d_texture_from_pixels(void* ctx, int w, int h, const uint32_t* argb) {
#ifdef ASC_RENDER_STAGE3D
    return s3d_texture_from_pixels(ctx, w, h, argb);
#else
    (void)ctx; (void)w; (void)h; (void)argb; return NULL;
#endif
}
static inline void* as_s3d_upload_texture(void* ctx, int unit, int w, int h, const uint32_t* argb) {
#ifdef ASC_RENDER_STAGE3D
    return s3d_upload_texture(ctx, unit, w, h, argb);
#else
    (void)ctx; (void)unit; (void)w; (void)h; (void)argb; return NULL;
#endif
}
static inline void as_s3d_texture_upload_level(void* ctx, void* tex, int level, int lw, int lh, const uint32_t* src, int srcW) {
#ifdef ASC_RENDER_STAGE3D
    s3d_texture_upload_level(ctx, tex, level, lw, lh, src, srcW);
#else
    (void)ctx; (void)tex; (void)level; (void)lw; (void)lh; (void)src; (void)srcW;
#endif
}
static inline void* as_s3d_upload_cube_texture(void* ctx, int unit, int size, const uint32_t* const* argb) {
#ifdef ASC_RENDER_STAGE3D
    return s3d_upload_cube_texture(ctx, unit, size, argb);
#else
    (void)ctx; (void)unit; (void)size; (void)argb; return NULL;
#endif
}
// key is the AS3 Program3D identity: the backend caches the compiled program
// under it, so switching programs between draws (Stage3D's normal shape — away3d
// alternates its two materials every frame) is a bind, not a shader recompile.
// AIR behaves the same way: Program3D.upload compiles once, setProgram binds.
static inline int as_s3d_compile(void* ctx, void* key, const char* vs, const char* fs, char* errbuf, int errbuf_size) {
#ifdef ASC_RENDER_STAGE3D
    return s3d_compile(ctx, key, vs, fs, errbuf, errbuf_size);
#else
    (void)ctx; (void)key; (void)vs; (void)fs; (void)errbuf; (void)errbuf_size; return 0;
#endif
}
static inline void as_s3d_clear(void* ctx, float r, float g, float b, float a, float depth, unsigned int stencil, int maskBits) {
#ifdef ASC_RENDER_STAGE3D
    s3d_clear(ctx, r, g, b, a, depth, stencil, maskBits);
#else
    (void)ctx; (void)r; (void)g; (void)b; (void)a; (void)depth; (void)stencil; (void)maskBits;
#endif
}
static inline void as_s3d_set_blend(void* ctx, const char* source, const char* dest) {
#ifdef ASC_RENDER_STAGE3D
    s3d_set_blend(ctx, source, dest);
#else
    (void)ctx; (void)source; (void)dest;
#endif
}
static inline void as_s3d_set_instance_count(void* ctx, int n) {
#ifdef ASC_RENDER_STAGE3D
    s3d_set_instance_count(ctx, n);
#else
    (void)ctx; (void)n;
#endif
}
// Depth test / culling / stencil / sampler / scissor state. Like as_s3d_set_blend
// these only record state in the glue; it is applied when the next draw is
// encoded (Stage3D is a state machine: set* then drawTriangles).
static inline void as_s3d_set_depth(void* ctx, int depthMask, const char* compareMode) {
#ifdef ASC_RENDER_STAGE3D
    s3d_set_depth(ctx, depthMask, compareMode);
#else
    (void)ctx; (void)depthMask; (void)compareMode;
#endif
}
static inline void as_s3d_set_cull(void* ctx, const char* face) {
#ifdef ASC_RENDER_STAGE3D
    s3d_set_cull(ctx, face);
#else
    (void)ctx; (void)face;
#endif
}
static inline void as_s3d_set_stencil(void* ctx, const char* face, const char* compare, const char* bothPass, const char* depthFail, const char* dpFail) {
#ifdef ASC_RENDER_STAGE3D
    s3d_set_stencil(ctx, face, compare, bothPass, depthFail, dpFail);
#else
    (void)ctx; (void)face; (void)compare; (void)bothPass; (void)depthFail; (void)dpFail;
#endif
}
static inline void as_s3d_set_stencil_ref(void* ctx, unsigned int ref, unsigned int readMask, unsigned int writeMask) {
#ifdef ASC_RENDER_STAGE3D
    s3d_set_stencil_ref(ctx, ref, readMask, writeMask);
#else
    (void)ctx; (void)ref; (void)readMask; (void)writeMask;
#endif
}
static inline void as_s3d_set_sampler_state(void* ctx, int unit, const char* wrap, const char* filter, const char* mipfilter) {
#ifdef ASC_RENDER_STAGE3D
    s3d_set_sampler_state(ctx, unit, wrap, filter, mipfilter);
#else
    (void)ctx; (void)unit; (void)wrap; (void)filter; (void)mipfilter;
#endif
}

// Apply the sampler state a fragment program declares in its AGAL 'tex' flags.
// Called by Context3D_setProgram, which is what makes the ordering faithful:
// setProgram and setSamplerStateAt both write the same per-unit state, so
// whichever runs last wins -- measured on AIR 51.4.1 (temp/sampprobe: a
// setSamplerStateAt after setProgram wins, one before it loses).
static inline void as_s3d_apply_agal_sampler_state(void* ctx, unsigned int used, unsigned int flags) {
#ifdef ASC_RENDER_STAGE3D
    for (int u = 0; u < 8; u++) if (used & (1u << u))
        s3d_set_sampler_state_i(ctx, u, (int)((flags >> (4 * u)) & 1u),
                                (int)((flags >> (4 * u + 1)) & 1u),
                                (int)((flags >> (4 * u + 2)) & 3u));
#else
    (void)ctx; (void)used; (void)flags;
#endif
}
static inline void as_s3d_set_scissor(void* ctx, int on, int x, int y, int w, int h) {
#ifdef ASC_RENDER_STAGE3D
    s3d_set_scissor(ctx, on, x, y, w, h);
#else
    (void)ctx; (void)on; (void)x; (void)y; (void)w; (void)h;
#endif
}
// setColorMask (Context3D): which color channels the following draws write.
// Not bakeable into a pipeline on either backend (Metal takes it on the render
// encoder, GL on the context state), so it is recorded and applied when the next
// draw is encoded -- same state-machine contract as the depth/cull setters above.
static inline void as_s3d_set_color_mask(void* ctx, int r, int g, int b, int a) {
#ifdef ASC_RENDER_STAGE3D
    s3d_set_color_mask(ctx, r, g, b, a);
#else
    (void)ctx; (void)r; (void)g; (void)b; (void)a;
#endif
}
static inline int as_s3d_draw(void* ctx, int numTriangles) {
#ifdef ASC_RENDER_STAGE3D
    return s3d_draw(ctx, numTriangles);
#else
    (void)ctx; (void)numTriangles; return 0;
#endif
}
// Commit without waiting: the frame boundary (present() and the window loop's
// pre-composite flush). The target only has to be ordered ahead of the GPU-side
// composite, and since the compositor and Stage3D share one command queue (stage
// 114) Metal's in-queue ordering already guarantees that, so the ~0.6 ms CPU
// wait per frame is not needed. The commit+wait flavour has no C-side caller on
// purpose: every place the generated C READS the target goes through
// as_s3d_readback/as_s3d_resize, and the glue flushes with a wait inside those.
static inline void as_s3d_flush_async(void* ctx) {
#ifdef ASC_RENDER_STAGE3D
    s3d_flush_async(ctx);
#else
    (void)ctx;
#endif
}
// Retire every live Stage3D context's pending batch. The window loop calls this
// before Skia starts compositing the Stage3D texture (see ASC_window_render), so
// a draw issued from ANY callback (ENTER_FRAME, a mouse handler, a timer) is
// ahead of the composite by the time the compositor samples it -- ordering, not
// completion, is what the GPU-side composite needs. Pure-C builds compile it to
// nothing.
static inline void as_s3d_flush_all_async(void) {
#ifdef ASC_RENDER_STAGE3D
    s3d_flush_all_async();
#endif
}
static inline int as_s3d_readback(void* ctx, uint8_t* out) {
#ifdef ASC_RENDER_STAGE3D
    return s3d_readback(ctx, out);
#else
    (void)ctx; (void)out; return 0;
#endif
}
static inline int as_s3d_width(void* ctx) {
#ifdef ASC_RENDER_STAGE3D
    return s3d_width(ctx);
#else
    (void)ctx; return 0;
#endif
}
static inline int as_s3d_height(void* ctx) {
#ifdef ASC_RENDER_STAGE3D
    return s3d_height(ctx);
#else
    (void)ctx; return 0;
#endif
}
static inline void* as_s3d_create_render_texture(void* ctx, int w, int h) {
#ifdef ASC_RENDER_STAGE3D
    return s3d_create_render_texture(ctx, w, h);
#else
    (void)ctx; (void)w; (void)h; return NULL;
#endif
}
static inline void as_s3d_set_render_target(void* ctx, void* tex, int enableDepthAndStencil) {
#ifdef ASC_RENDER_STAGE3D
    s3d_set_render_target(ctx, tex, enableDepthAndStencil);
#else
    (void)ctx; (void)tex; (void)enableDepthAndStencil;
#endif
}
static inline int as_s3d_bind_texture(void* ctx, int unit, void* tex, int hasChain) {
#ifdef ASC_RENDER_STAGE3D
    return s3d_bind_texture(ctx, unit, tex, hasChain);
#else
    (void)ctx; (void)unit; (void)tex; (void)hasChain; return 0;
#endif
}
static inline int as_s3d_readback_render(void* ctx, uint8_t* out) {
#ifdef ASC_RENDER_STAGE3D
    return s3d_readback_render(ctx, out);
#else
    (void)ctx; (void)out; return 0;
#endif
}
static inline void as_s3d_destroy_texture(void* tex) {
#ifdef ASC_RENDER_STAGE3D
    s3d_destroy_texture(tex);
#else
    (void)tex;
#endif
}
static inline void* as_s3d_get_render_target(void* ctx) {
#ifdef ASC_RENDER_STAGE3D
    return s3d_get_render_target(ctx);
#else
    (void)ctx; return NULL;
#endif
}

// ---------- AMF3 codec (flash.utils ByteArray/URLStream readObject+writeObject,
//            flash.net registerClassAlias/getClassByAlias -- stage 94-4) ----------
//
// AMF3 is the wire format AIR's Socket / LocalConnection / SharedObject speak.
// Every rule below was measured on adl 51.4.1 (temp/amfprobe/): integers in
// [-2^28, 2^28-1] use marker 0x04 with a U29 payload and everything else 0x05
// plus an 8-byte big-endian double; strings are UTF-8 with a U29S length whose
// low bit distinguishes a literal from a reference; each write/read call starts
// with FRESH string/object/trait tables (writing the same object twice in two
// writeObject calls re-emits it completely); a class instance whose alias was
// registered with registerClassAlias writes the ALIAS as the class name while an
// unaliased one writes the EMPTY name (which reads back as a dynamic object);
// traits list the public instance variables AND the public getters (a get/set
// pair is ONE member whose value comes from the getter) and no private members;
// a plain object is a dynamic traits-less object (0x0a, count 0, dynamic bit
// set); an Array is 0x09 with a dense count and no associative part; a
// repeated object is the same marker plus a U29O reference (bit0 == 0).
//
// Deliberate divergences, all registered in TODO.md's 遗留 table:
//   * Dynamic-object member ORDER is insertion order here; AIR walks its hash
//     table, so a multi-member object's bytes differ (both decode identically).
//   * Trait order is this compiler's declaration order, own members then the
//     superclass chain (the same shape AIR uses across classes), but AIR also
//     reorders members WITHIN one class (measured: a:int,b:String,c:Boolean,
//     d:Number came out a,c,b,d).
//   * AMF0 (ObjectEncoding.AMF0 == 0) is not implemented: readObject/writeObject
//     with it throws instead of silently emitting AMF3.
//   * XML / XMLDocument, IExternalizable locals and nested class members are
//     outside the subset; their markers throw rather than being guessed.
//   * A Vector decodes to an Array (this subset models Vector.<T> as a typed
//     Array with no runtime element-type tag).
//
// The value layer needs facts only the generated C knows (per-class member
// tables, Date/ByteArray constructors, the getDefinitionByName registry), so it
// reaches them through hooks the generated code installs in as_amf_wire().
static int as_heap_kind(void* p);
// AMF3 faults are reported back as a code, not thrown from here: the typed
// error constructors (Error/TypeError/..._new) are emitted AFTER this preamble,
// so the ByteArray/URLStream wrappers -- which can name them -- do the throwing.
//   0 ok, 1 EOF (#2030), 2 unknown marker (detail = marker, RangeError #2006),
//   3 a table reference out of range, 4 ObjectEncoding.AMF0 (a loud gap),
//   5 unsupported value (detail 1 Function, 2 XML, 3 ByteArray reference,
//     4 externalizable object, 5 unknown Vector element type,
//     6 Vector of interfaces),
//   6 out of memory in the writer.
typedef struct { int code; int detail; } as_amf_err;
typedef struct { unsigned char* b; size_t len, cap; } as_amfbuf;
// Writer-side fault latch (see as_amf_err for the codes).
static int as_amf_err_code = 0;
static int as_amf_err_detail = 0;
static void as_amf_fail(int code, int detail) {
    if (as_amf_err_code == 0) { as_amf_err_code = code; as_amf_err_detail = detail; }
}
static void as_amfb_reserve(as_amfbuf* f, size_t extra) {
    if (f->len + extra <= f->cap) return;
    size_t cap = f->cap > 0 ? f->cap : 64;
    while (cap < f->len + extra) cap *= 2;
    unsigned char* nb = (unsigned char*)realloc(f->b, cap);
    if (nb == NULL) { as_amf_fail(6, 0); return; }
    f->b = nb; f->cap = cap;
}
static void as_amfb_bytes(as_amfbuf* f, const void* p, size_t n) {
    if (n == 0) return;
    as_amfb_reserve(f, n);
    memcpy(f->b + f->len, p, n);
    f->len += n;
}
static void as_amfb_byte(as_amfbuf* f, unsigned v) {
    unsigned char c = (unsigned char)v;
    as_amfb_bytes(f, &c, 1);
}
// AMF3 U29: 1-4 bytes, 7 bits each, high bit = continuation; the 4th byte
// contributes 8 bits (29 total).
static void as_amfb_u29(as_amfbuf* f, unsigned v) {
    v &= 0x1FFFFFFFu;
    if (v < 0x80u) { as_amfb_byte(f, v); return; }
    if (v < 0x4000u) { as_amfb_byte(f, 0x80u | (v >> 7)); as_amfb_byte(f, v & 0x7Fu); return; }
    if (v < 0x200000u) {
        as_amfb_byte(f, 0x80u | (v >> 14));
        as_amfb_byte(f, 0x80u | ((v >> 7) & 0x7Fu));
        as_amfb_byte(f, v & 0x7Fu);
        return;
    }
    as_amfb_byte(f, 0x80u | (v >> 22));
    as_amfb_byte(f, 0x80u | ((v >> 15) & 0x7Fu));
    as_amfb_byte(f, 0x80u | ((v >> 8) & 0x7Fu));
    as_amfb_byte(f, v & 0xFFu);
}
static void as_amfb_bytes_be32(as_amfbuf* f, unsigned v) {
    unsigned char b[4];
    b[0] = (unsigned char)((v >> 24) & 0xFFu);
    b[1] = (unsigned char)((v >> 16) & 0xFFu);
    b[2] = (unsigned char)((v >> 8) & 0xFFu);
    b[3] = (unsigned char)(v & 0xFFu);
    as_amfb_bytes(f, b, 4);
}
static void as_amfb_double(as_amfbuf* f, double d) {
    uint64_t bits;
    memcpy(&bits, &d, 8);
    unsigned char b[8];
    for (int i = 0; i < 8; i++) b[i] = (unsigned char)((bits >> (8 * (7 - i))) & 0xFFu);
    as_amfb_bytes(f, b, 8);
}

// ---- the three AMF3 reference tables (per read/write call) ----
typedef struct {
    as_amfbuf out;
    char* alias;                   // class name for the value being written
    int nstr, strcap; char** strs;
    int nobj, objcap; as_value* objs;
    int ntr, trcap; char** traits;
} as_amf3w;

static void as_amf3w_addstr(as_amf3w* w, char* s) {
    if (w->nstr == w->strcap) {
        w->strcap = w->strcap > 0 ? w->strcap * 2 : 8;
        w->strs = (char**)realloc(w->strs, sizeof(char*) * (size_t)w->strcap);
        if (w->strs == NULL) { w->nstr = 0; w->strcap = 0; return; }
    }
    w->strs[w->nstr++] = s;
}
static int as_amf3w_stridx(as_amf3w* w, char* s) {
    for (int i = 0; i < w->nstr; i++) if (w->strs[i] == s || strcmp(w->strs[i], s) == 0) return i;
    return -1;
}
// A string in AMF3: 0x06 then either a reference (index << 1) or a literal
// ((utf8 byte length << 1) | 1). Every literal joins the string table, which is
// why a repeated member name comes back as a reference (measured).
static void as_amf3_wstr_body(as_amf3w* w, char* s) {
    int idx = as_amf3w_stridx(w, s);
    if (idx >= 0) { as_amfb_u29(&w->out, (unsigned)idx << 1); return; }
    as_amf3w_addstr(w, s);
    size_t n = strlen(s);
    as_amfb_u29(&w->out, (unsigned)((n << 1) | 1));
    as_amfb_bytes(&w->out, s, n);
}
static void as_amf3_wstr(as_amf3w* w, char* s) {
    if (s == NULL) s = (char*)"";
    as_amfb_byte(&w->out, 0x06);
    as_amf3_wstr_body(w, s);
}
// Inside a traits block (the class name, each member name) and the dynamic
// trailer (each key, and the empty key that ends it) AMF3 writes the U29S
// WITHOUT the 0x06 marker -- measured on adl (a dynamic {x:...} object opens
// 0a 0b 01 03 79 ... where 03 79 is the raw reference to "y"). A string VALUE
// keeps the marker, so both forms exist and the tables are shared.
static void as_amf3_wstr_raw(as_amf3w* w, char* s) {
    if (s == NULL) s = (char*)"";
    as_amf3_wstr_body(w, s);
}
// The trait class name is a raw U29S that never joins the string table (measured
// on adl: an object's empty class name is written as 01 and the trait member
// names then occupy the table from index 0, so "b" as a field value came back as
// a reference to index 2 rather than 3).
static void as_amf3_wstr_classname(as_amf3w* w, char* s) {
    if (s == NULL) s = (char*)"";
    size_t n = strlen(s);
    as_amfb_u29(&w->out, (unsigned)((n << 1) | 1));
    as_amfb_bytes(&w->out, s, n);
}
static int as_amf3w_addobj(as_amf3w* w, as_value v) {
    if (w->nobj == w->objcap) {
        w->objcap = w->objcap > 0 ? w->objcap * 2 : 8;
        w->objs = (as_value*)realloc(w->objs, sizeof(as_value) * (size_t)w->objcap);
        if (w->objs == NULL) { w->nobj = 0; w->objcap = 0; return -1; }
    }
    w->objs[w->nobj] = v;
    return w->nobj++;
}
// Index of this exact object in the table, or -1 (a first sighting, which the
// caller registers). Identity is the pointer, so two equal-but-distinct objects
// are written twice -- matching AIR.
static int as_amf3w_objidx(as_amf3w* w, as_value v) {
    for (int i = 0; i < w->nobj; i++) if (w->objs[i].ptr == v.ptr && w->objs[i].tag == v.tag) return i;
    return -1;
}
static int as_amf3w_addtrait(as_amf3w* w, char* sig) {
    if (w->ntr == w->trcap) {
        w->trcap = w->trcap > 0 ? w->trcap * 2 : 8;
        w->traits = (char**)realloc(w->traits, sizeof(char*) * (size_t)w->trcap);
        if (w->traits == NULL) { w->ntr = 0; w->trcap = 0; return -1; }
    }
    w->traits[w->ntr] = sig;
    return w->ntr++;
}
static int as_amf3w_tridx(as_amf3w* w, char* sig) {
    for (int i = 0; i < w->ntr; i++) if (strcmp(w->traits[i], sig) == 0) return i;
    return -1;
}
// Trait signature: the class name, each member name, then a dynamic marker.
// 0x1f (unit separator) cannot occur in an AS3 identifier.
static char* as_amf3_trait_sig(const char* cname, const char** members, int count, int dynamic) {
    size_t n = strlen(cname) + 2;
    for (int i = 0; i < count; i++) n += strlen(members[i]) + 1;
    char* s = as_str_alloc(n);
    size_t p = 0;
    for (const char* c = cname; *c; c++) s[p++] = *c;
    s[p++] = 0x1f;
    for (int i = 0; i < count; i++) {
        for (const char* c = members[i]; *c; c++) s[p++] = *c;
        s[p++] = 0x1f;
    }
    s[p++] = dynamic ? 'D' : 'S';
    s[p] = 0;
    return s;
}

// ---- hooks installed by the generated C (as_amf_wire) ----
// Class member table (public vars then public getters, own members then the
// superclass chain) for a vtable, NULL when the class has none.
static const char** (*as_amf_members_hook)(void* vt) = NULL;
// Is this value a Date, and its epoch milliseconds?
static int (*as_amf_date_hook)(as_value v, double* ms) = NULL;
// Is this value a ByteArray, and its bytes?
static int (*as_amf_ba_out_hook)(as_value v, const unsigned char** data, size_t* len) = NULL;
// Build a Date from epoch milliseconds.
static as_value (*as_amf_date_new_hook)(double ms) = NULL;
// Build a ByteArray from raw bytes.
static as_value (*as_amf_ba_new_hook)(const unsigned char* data, size_t len) = NULL;
// Look up a user class by AS3 fully qualified name (the class registry).
static as_class* (*as_amf_class_hook)(const char* fqn) = NULL;
// Describe a Vector.<T> value: its element flavour (0 int, 1 uint, 2 double,
// 3 boxed '*' slots, 4 object references, 5 string references, 6 interface pairs)
// and its length/data. A Vector is a monomorphized struct with no vtable, so the
// generated code identifies it by its mark callback (see emitAmfCodec).
static int (*as_amf_vec_hook)(as_value v, int* flavor, int* count, void** data) = NULL;

// ---- flash.net.registerClassAlias / getClassByAlias ----
typedef struct { char* name; as_class* cls; } as_amf_alias;
static as_amf_alias* as_amf_aliases = NULL;
static int as_amf_alias_count = 0;
static int as_amf_alias_cap = 0;
// Returns 0 when the arguments are bad (the emitted wrapper throws TypeError
// #2007 for that, matching adl's registerClassAlias(null, X) / ("x", null)).
static int as_register_class_alias(const char* name, as_value cls) {
    if (name == NULL || cls.ptr == NULL) return 0;
    as_class* c = as_v_as_class(cls);
    if (c == NULL) return 0;
    for (int i = 0; i < as_amf_alias_count; i++) {
        if (strcmp(as_amf_aliases[i].name, name) == 0) { as_amf_aliases[i].cls = c; return 1; }
    }
    if (as_amf_alias_count == as_amf_alias_cap) {
        as_amf_alias_cap = as_amf_alias_cap > 0 ? as_amf_alias_cap * 2 : 8;
        as_amf_aliases = (as_amf_alias*)realloc(as_amf_aliases, sizeof(as_amf_alias) * (size_t)as_amf_alias_cap);
        if (as_amf_aliases == NULL) { as_amf_alias_count = 0; as_amf_alias_cap = 0; return 0; }
    }
    char* copy = as_str_alloc(strlen(name) + 1);
    strcpy(copy, name);
    as_amf_aliases[as_amf_alias_count].name = copy;
    as_amf_aliases[as_amf_alias_count].cls = c;
    as_amf_alias_count++;
    return 1;
}
static as_class* as_class_for_alias(const char* name) {
    for (int i = 0; i < as_amf_alias_count; i++) if (strcmp(as_amf_aliases[i].name, name) == 0) return as_amf_aliases[i].cls;
    return NULL;
}
// The registered alias whose class owns this vtable, or NULL. AIR writes the
// alias as the AMF3 class name, and only when one was registered (an unaliased
// class writes an empty name -- measured).
static const char* as_amf_alias_for(void* vt) {
    // Walk the superclass chain innermost-first: measured on adl, an Employee
    // whose base Person was registered under "myAlias" is written with that alias
    // (the alias covers the hierarchy, not just the exact class).
    while (vt != NULL) {
        for (int i = 0; i < as_amf_alias_count; i++) {
            if (as_amf_aliases[i].cls != NULL && as_amf_aliases[i].cls->vtable == vt) return as_amf_aliases[i].name;
        }
        vt = ((as_vtable_header*)vt)->super;
    }
    return NULL;
}
// NULL when the alias is unknown; the emitted wrapper turns that into
// ReferenceError #1014 ("Class could not be found"), measured on adl.
static as_value as_get_class_by_alias(const char* name) {
    as_class* c = name == NULL ? NULL : as_class_for_alias(name);
    if (c == NULL) return as_v_null();
    return as_v_obj((void*)c);
}

static void as_amf3_wvalue(as_amf3w* w, as_value v);
// Write the object marker and, when this object was already written, a U29O
// reference instead of a second copy. Returns 1 when a reference was written.
static int as_amf3_wobj(as_amf3w* w, as_value v, unsigned char marker) {
    int idx = as_amf3w_objidx(w, v);
    as_amfb_byte(&w->out, marker);
    if (idx >= 0) {
        as_amfb_u29(&w->out, (unsigned)idx << 1);
        return 1;
    }
    as_amf3w_addobj(w, v);
    return 0;
}
static void as_amf3_wvalue(as_amf3w* w, as_value v) {
    switch (v.tag) {
        case 0: as_amfb_byte(&w->out, 0x01); return;               // null
        case 5: as_amfb_byte(&w->out, 0x00); return;               // undefined
        case 2: as_amfb_byte(&w->out, v.num != 0.0 ? 0x03 : 0x02); return;
        case 3: as_amf3_wstr(w, (char*)v.ptr); return;
        case 1: {
            double d = v.num;
            // int/uint and Number are the same box tag here, so an integral value
            // goes on the wire in the compact integer form (which reads back as
            // the same number either way).
            if (d == floor(d) && d >= -268435456.0 && d <= 268435455.0) {
                as_amfb_byte(&w->out, 0x04);
                as_amfb_u29(&w->out, (unsigned)((long long)d) & 0x1FFFFFFFu);
            } else {
                as_amfb_byte(&w->out, 0x05);
                as_amfb_double(&w->out, d);
            }
            return;
        }
        case 7:
            as_amf_fail(5, 1);
            return;
        default: break;
    }
    if (v.ptr == NULL) { as_amfb_byte(&w->out, 0x01); return; }
    int kind = as_heap_kind(v.ptr);
    const unsigned char* bd = NULL;
    size_t blen = 0;
    double ms = 0;
    if (kind == GCT_CLASS && as_amf_ba_out_hook != NULL && as_amf_ba_out_hook(v, &bd, &blen)) {
        if (as_amf3_wobj(w, v, 0x0c)) return;                      // ByteArray
        as_amfb_u29(&w->out, (unsigned)((blen << 1) | 1));
        as_amfb_bytes(&w->out, bd, blen);
        return;
    }
    if (kind == GCT_CLASS && as_amf_date_hook != NULL && as_amf_date_hook(v, &ms)) {
        if (as_amf3_wobj(w, v, 0x08)) return;                      // Date
        as_amfb_u29(&w->out, 1);                                   // U29O: inline
        as_amfb_double(&w->out, ms);
        return;
    }
    if (kind == GCT_DICT) {
        as_dict* d = (as_dict*)v.ptr;
        if (as_amf3_wobj(w, v, 0x11)) return;                      // Dictionary
        as_amfb_u29(&w->out, (unsigned)((d->length << 1) | 1));
        as_amfb_byte(&w->out, 0);                                  // weak keys: not modeled
        for (int i = 0; i < d->length; i++) {
            as_amf3_wvalue(w, d->keys[i]);
            as_amf3_wvalue(w, d->vals[i]);
        }
        return;
    }
    if (kind == GCT_CUSTOM) {
        // Vector.<T>: markers 0x0d..0x10 by element type, a U29 count, an element
        // type byte and then raw (scalar) or AMF3-encoded (object) elements --
        // measured on adl: Vector.<int>[1,2] is 0d 05 00 <int><int>.
        int vf = 0, vn = 0;
        void* vd = NULL;
        if (as_amf_vec_hook == NULL || !as_amf_vec_hook(v, &vf, &vn, &vd)) {
            as_amf_fail(5, 5);
            return;
        }
        if (vf == 6) { as_amf_fail(5, 6); return; }
        int marker = 0x0d + (vf <= 2 ? vf : 3);
        if (as_amf3_wobj(w, v, (unsigned char)marker)) return;
        as_amfb_u29(&w->out, (unsigned)((vn << 1) | 1));
        as_amfb_byte(&w->out, (unsigned)(vf <= 2 ? vf : 3));
        // Scalar elements are 4-byte BIG-endian (measured: Vector.<int>[1,2] writes
        // 00 00 00 01 00 00 00 02), so the host word order must not leak out.
        if (vf == 0) { for (int i = 0; i < vn; i++) as_amfb_bytes_be32(&w->out, (unsigned)((int*)vd)[i]); }
        else if (vf == 1) { for (int i = 0; i < vn; i++) as_amfb_bytes_be32(&w->out, ((unsigned*)vd)[i]); }
        else if (vf == 2) { for (int i = 0; i < vn; i++) as_amfb_double(&w->out, ((double*)vd)[i]); }
        else if (vf == 3) { for (int i = 0; i < vn; i++) as_amf3_wvalue(w, ((as_value*)vd)[i]); }
        else if (vf == 5) { for (int i = 0; i < vn; i++) as_amf3_wvalue(w, as_v_str(((char**)vd)[i])); }
        else { for (int i = 0; i < vn; i++) as_amf3_wvalue(w, as_v_obj(((void**)vd)[i])); }
        return;
    }
    if (kind == GCT_ARRAY || v.tag == 6) {
        // A plain Array (tag 6): dense elements plus a named-property section.
        as_array* a = (as_array*)v.ptr;
        if (as_amf3_wobj(w, v, 0x09)) return;
        int assoc = a->props != NULL ? a->props->length : 0;
        as_amfb_u29(&w->out, (unsigned)((a->length << 1) | 1));
        as_amfb_u29(&w->out, (unsigned)((assoc << 1) | 1));
        for (int i = 0; i < a->length; i++) as_amf3_wvalue(w, a->data[i]);
        for (int i = 0; i < assoc; i++) {
            as_amf3_wstr_raw(w, a->props->keys[i]);
            as_amf3_wvalue(w, a->props->vals[i]);
        }
        // A purely dense array has no associative section at all: measured on adl,
        // [1,2,3] is 09 07 01 <ints> with no trailing empty key.
        if (assoc > 0) as_amf3_wstr_raw(w, (char*)"");
        return;
    }
    // Record (dynamic object) or class instance (typed object).
    void* vt = ((as_object_header*)v.ptr)->vtable;
    const char** members = kind == GCT_OBJECT ? NULL : (as_amf_members_hook != NULL ? as_amf_members_hook(vt) : NULL);
    int count = 0;
    if (members != NULL) while (members[count] != NULL) count++;
    int dynamic = kind == GCT_OBJECT ? 1 : 0;
    const char* cname = kind == GCT_OBJECT ? "" : as_amf_alias_for(vt);
    if (cname == NULL) cname = "";
    if (as_amf3_wobj(w, v, 0x0a)) return;
    char* sig = as_amf3_trait_sig(cname, members, count, dynamic);
    int tr = as_amf3w_tridx(w, sig);
    if (tr >= 0) {
        as_amfb_u29(&w->out, ((unsigned)tr << 2) | 0x01u);
    } else {
        as_amf3w_addtrait(w, sig);
        as_amfb_u29(&w->out, (unsigned)((count << 4) | (dynamic ? 0x08u : 0) | 0x02u | 0x01u));
        as_amf3_wstr_classname(w, (char*)cname);
        for (int i = 0; i < count; i++) as_amf3_wstr_raw(w, (char*)members[i]);
    }
    for (int i = 0; i < count; i++) as_amf3_wvalue(w, as_dyn_get(v.ptr, members[i]));
    if (dynamic) {
        as_object* o = (as_object*)v.ptr;
        for (int i = 0; i < o->length; i++) {
            as_amf3_wstr_raw(w, o->keys[i]);
            as_amf3_wvalue(w, o->vals[i]);
        }
        as_amf3_wstr_raw(w, (char*)"");
    }
}

// ---- reader ----
typedef struct { char* name; char** members; int count; int dynamic; } as_amf_trait;
typedef struct {
    const unsigned char* p;
    size_t len, pos;
    int code, detail;              // first fault (see as_amf_err), 0 while clean
    int nstr, strcap; char** strs;
    int nobj, objcap; as_value* objs;
    int ntr, trcap; as_amf_trait* traits;
} as_amf3r;
static void as_amfr_fail(as_amf3r* r, int code, int detail) {
    if (r->code == 0) { r->code = code; r->detail = detail; }
}

static int as_amfr_have(as_amf3r* r, size_t n) { return r->pos + n <= r->len; }
static unsigned as_amfr_byte(as_amf3r* r) {
    if (!as_amfr_have(r, 1)) { as_amfr_fail(r, 1, 0); return 0; }
    return r->p[r->pos++];
}
static unsigned as_amfr_u29(as_amf3r* r) {
    unsigned v = 0;
    for (int i = 0; i < 4; i++) {
        unsigned b = as_amfr_byte(r);
        if (i == 3) return (v << 8) | b;
        v = (v << 7) | (b & 0x7Fu);
        if ((b & 0x80u) == 0) return v;
    }
    return v;
}
static double as_amfr_double(as_amf3r* r) {
    unsigned char b[8];
    if (!as_amfr_have(r, 8)) { as_amfr_fail(r, 1, 0); return 0; }
    memcpy(b, r->p + r->pos, 8);
    r->pos += 8;
    uint64_t bits = 0;
    for (int i = 0; i < 8; i++) bits = (bits << 8) | b[i];
    double d;
    memcpy(&d, &bits, 8);
    return d;
}
static void as_amfr_addstr(as_amf3r* r, char* s) {
    if (r->nstr == r->strcap) {
        r->strcap = r->strcap > 0 ? r->strcap * 2 : 8;
        r->strs = (char**)realloc(r->strs, sizeof(char*) * (size_t)r->strcap);
        if (r->strs == NULL) { r->nstr = 0; r->strcap = 0; return; }
    }
    r->strs[r->nstr++] = s;
}
// The marker-less U29S used by traits blocks and the dynamic trailer (see
// as_amf3_wstr_raw). Shares the string table with the marked form.
static char* as_amfr_str_body(as_amf3r* r) {
    unsigned u = as_amfr_u29(r);
    if ((u & 1u) == 0) {
        unsigned idx = u >> 1;
        if (idx < (unsigned)r->nstr) return r->strs[idx];
        as_amfr_fail(r, 3, 0);
        return (char*)"";
    }
    unsigned n = u >> 1;
    if (!as_amfr_have(r, n)) { as_amfr_fail(r, 1, 0); return (char*)""; }
    char* s = as_str_alloc((size_t)n + 1);
    if (n > 0) memcpy(s, r->p + r->pos, n);
    s[n] = 0;
    r->pos += n;
    as_amfr_addstr(r, s);
    return s;
}
// A string in a VALUE position: the 0x06 marker has already been consumed by
// as_amf3_rvalue, so only the U29S follows.
static char* as_amfr_str(as_amf3r* r) {
    return as_amfr_str_body(r);
}
// The trait class name is a raw U29S literal that is NOT entered into the string
// table, mirroring the writer (see as_amf3_wstr_classname). A reference here
// would be a malformed stream, so it is reported.
static char* as_amfr_str_classname(as_amf3r* r) {
    unsigned u = as_amfr_u29(r);
    if ((u & 1u) == 0) { as_amfr_fail(r, 3, 0); return (char*)""; }
    unsigned n = u >> 1;
    if (!as_amfr_have(r, n)) { as_amfr_fail(r, 1, 0); return (char*)""; }
    char* s = as_str_alloc((size_t)n + 1);
    if (n > 0) memcpy(s, r->p + r->pos, n);
    s[n] = 0;
    r->pos += n;
    return s;
}
static as_value as_amfr_addobj(as_amf3r* r, as_value v) {
    if (r->nobj == r->objcap) {
        r->objcap = r->objcap > 0 ? r->objcap * 2 : 8;
        r->objs = (as_value*)realloc(r->objs, sizeof(as_value) * (size_t)r->objcap);
        if (r->objs == NULL) { r->nobj = 0; r->objcap = 0; return v; }
    }
    r->objs[r->nobj++] = v;
    return v;
}
static int as_amfr_addtrait(as_amf3r* r, char* name, char** members, int count, int dynamic) {
    if (r->ntr == r->trcap) {
        r->trcap = r->trcap > 0 ? r->trcap * 2 : 8;
        r->traits = (as_amf_trait*)realloc(r->traits, sizeof(as_amf_trait) * (size_t)r->trcap);
        if (r->traits == NULL) { r->ntr = 0; r->trcap = 0; return -1; }
    }
    r->traits[r->ntr].name = name;
    r->traits[r->ntr].members = members;
    r->traits[r->ntr].count = count;
    r->traits[r->ntr].dynamic = dynamic;
    return r->ntr++;
}
static char* as_amf3_name_norm(const char* s) {
    // "pkg::Cls" and "pkg.Cls" must both resolve against the registry.
    size_t n = strlen(s);
    char* out = as_str_alloc(n + 1);
    size_t p = 0;
    for (size_t i = 0; i < n; i++) {
        if (s[i] == ':' && i + 1 < n && s[i + 1] == ':') { out[p++] = '.'; i++; continue; }
        out[p++] = s[i];
    }
    out[p] = 0;
    return out;
}
static as_value as_amf3_rvalue(as_amf3r* r);
static as_value as_amf3_robject(as_amf3r* r) {
    unsigned u = as_amfr_u29(r);
    if ((u & 1u) == 0) {
        unsigned idx = u >> 1;
        if (idx < (unsigned)r->nobj) return r->objs[idx];
        as_amfr_fail(r, 3, 0);
        return as_v_null();
    }
    int inline_traits = (int)((u >> 1) & 1u);
    // U29O bits, measured on adl 51.4.1 (temp/amfprobe/: hand-built streams read
    // back through adl): bit1 inline traits, bit3 DYNAMIC, bit4+ member count, and
    // a bit2 (externalizable) stream is rejected by AIR itself (#2173), so this
    // subset reports it as unsupported rather than guessing.
    int externalizable = (int)((u >> 2) & 1u);
    int dynamic = (int)((u >> 3) & 1u);
    int count = (int)(u >> 4);
    char* cname;
    char** members = NULL;
    if (inline_traits && externalizable) {
        as_amfr_fail(r, 5, 4);
        return as_v_null();
    }
    if (inline_traits) {
        cname = as_amfr_str_classname(r);
        if (count > 0) members = (char**)malloc(sizeof(char*) * (size_t)count);
        for (int i = 0; i < count; i++) members[i] = as_amfr_str_body(r);
        as_amfr_addtrait(r, cname, members, count, dynamic);
    } else {
        unsigned ti = u >> 2;
        if (ti >= (unsigned)r->ntr) {
            as_amfr_fail(r, 3, 0);
            return as_v_null();
        }
        cname = r->traits[ti].name;
        members = r->traits[ti].members;
        dynamic = r->traits[ti].dynamic;
    }
    as_value out;
    as_class* cls = NULL;
    if (cname != NULL && cname[0] != 0) {
        cls = as_class_for_alias(cname);
        if (cls == NULL && as_amf_class_hook != NULL) cls = as_amf_class_hook(as_amf3_name_norm(cname));
    }
    if (cls != NULL && cls->factory != NULL) out = as_v_obj(cls->factory());
    else out = as_v_obj(as_object_new());
    as_amfr_addobj(r, out);
    for (int i = 0; i < count; i++) {
        as_value val = as_amf3_rvalue(r);
        if (members != NULL && members[i] != NULL) as_dyn_set(out.ptr, members[i], val);
    }
    if (dynamic) {
        for (;;) {
            char* key = as_amfr_str_body(r);
            if (key == NULL || key[0] == 0) break;
            as_dyn_set(out.ptr, key, as_amf3_rvalue(r));
        }
    }
    return out;
}
static as_value as_amf3_rarray(as_amf3r* r) {
    unsigned u = as_amfr_u29(r);
    if ((u & 1u) == 0) {
        unsigned idx = u >> 1;
        if (idx < (unsigned)r->nobj) return r->objs[idx];
        as_amfr_fail(r, 3, 0);
        return as_v_null();
    }
    unsigned dense = u >> 1;
    unsigned assoc = as_amfr_u29(r) >> 1;
    as_array* a = as_array_new();
    as_value out = as_amfr_addobj(r, as_v_arr(a));
    for (unsigned i = 0; i < dense; i++) as_array_push(a, as_amf3_rvalue(r));
    for (unsigned i = 0; i < assoc; i++) {
        char* key = as_amfr_str_body(r);
        as_dyn_set((void*)a, key, as_amf3_rvalue(r));
    }
    return out;
}
static as_value as_amf3_rvalue(as_amf3r* r) {
    unsigned marker = as_amfr_byte(r);
    switch (marker) {
        case 0x00: return as_v_undefined();
        case 0x01: return as_v_null();
        case 0x02: return as_v_bool(0);
        case 0x03: return as_v_bool(1);
        case 0x04: {
            unsigned u = as_amfr_u29(r);
            // A U29 carries 29 bits, so the top three bits are the sign.
            double d = (u & 0x10000000u) ? (double)(int)(u | 0xE0000000u) : (double)u;
            return as_v_num(d);
        }
        case 0x05: return as_v_num(as_amfr_double(r));
        case 0x06: return as_v_str(as_amfr_str(r));
        case 0x08: {                                   // Date
            unsigned u = as_amfr_u29(r);
            if ((u & 1u) == 0) {
                unsigned idx = u >> 1;
                if (idx < (unsigned)r->nobj) return r->objs[idx];
                as_amfr_fail(r, 3, 0);
                return as_v_null();
            }
            double ms = as_amfr_double(r);
            as_value d = as_amf_date_new_hook != NULL ? as_amf_date_new_hook(ms) : as_v_null();
            return as_amfr_addobj(r, d);
        }
        case 0x09: return as_amf3_rarray(r);
        case 0x0a: return as_amf3_robject(r);
        case 0x0b: case 0x07:
            as_amfr_fail(r, 5, 2);
            return as_v_null();
        case 0x0c: {                                   // ByteArray
            unsigned u = as_amfr_u29(r);
            if ((u & 1u) == 0) {
                unsigned idx = u >> 1;
                if (idx < (unsigned)r->nobj) return r->objs[idx];
                as_amfr_fail(r, 3, 0);
                return as_v_null();
            }
            unsigned n = u >> 1;
            if (!as_amfr_have(r, n)) { as_amfr_fail(r, 1, 0); return as_v_null(); }
            as_value ba = as_amf_ba_new_hook != NULL ? as_amf_ba_new_hook(r->p + r->pos, n) : as_v_null();
            r->pos += n;
            return as_amfr_addobj(r, ba);
        }
        case 0x0d: case 0x0e: case 0x0f: case 0x10: {  // Vector.<int|uint|double|Object>
            unsigned u = as_amfr_u29(r);
            if ((u & 1u) == 0) {
                unsigned idx = u >> 1;
                if (idx < (unsigned)r->nobj) return r->objs[idx];
                as_amfr_fail(r, 3, 0);
                return as_v_null();
            }
            unsigned count = u >> 1;
            int vtype = (int)as_amfr_byte(r);
            as_array* a = as_array_new();
            as_value out = as_amfr_addobj(r, as_v_arr(a));
            for (unsigned i = 0; i < count; i++) {
                if (vtype == 0 || vtype == 1) {
                    unsigned w32 = 0;
                    for (int b = 0; b < 4; b++) w32 = (w32 << 8) | as_amfr_byte(r);
                    as_array_push(a, as_v_num(vtype == 0 ? (double)(int)w32 : (double)w32));
                } else if (vtype == 2) {
                    as_array_push(a, as_v_num(as_amfr_double(r)));
                } else {
                    as_array_push(a, as_amf3_rvalue(r));
                }
            }
            return out;
        }
        case 0x11: {                                   // Dictionary
            unsigned u = as_amfr_u29(r);
            if ((u & 1u) == 0) {
                unsigned idx = u >> 1;
                if (idx < (unsigned)r->nobj) return r->objs[idx];
                as_amfr_fail(r, 3, 0);
                return as_v_null();
            }
            unsigned count = u >> 1;
            (void)as_amfr_byte(r);                     // weak-keys byte
            as_dict* d = as_dict_new();
            as_value out = as_amfr_addobj(r, as_v_obj((void*)d));
            for (unsigned i = 0; i < count; i++) {
                as_value key = as_amf3_rvalue(r);
                as_dict_set(d, key, as_amf3_rvalue(r));
            }
            return out;
        }
        default:
            as_amfr_fail(r, 2, (int)marker);
            return as_v_null();
    }
}

// ---- entry points used by ByteArray/URLStream readObject+writeObject ----
// writeObject: returns a malloc'd buffer the caller hands to the byte sink and
// then frees. readObject: consumes from the buffer and reports how much it used
// so the caller can advance the stream position.
static unsigned char* as_amf_write_object(as_value v, int enc, size_t* out_len, as_amf_err* err) {
    *out_len = 0;
    err->code = 0;
    err->detail = 0;
    if (enc != 3) { err->code = 4; return NULL; }
    as_amf_err_code = 0;
    as_amf_err_detail = 0;
    as_amf3w w;
    memset(&w, 0, sizeof(w));
    as_amf3_wvalue(&w, v);
    if (as_amf_err_code != 0) {
        err->code = as_amf_err_code;
        err->detail = as_amf_err_detail;
        free(w.out.b);
        free(w.strs);
        free(w.objs);
        free(w.traits);
        return NULL;
    }
    *out_len = w.out.len;
    free(w.strs);
    free(w.objs);
    free(w.traits);
    return w.out.b;
}
static as_value as_amf_read_object(const unsigned char* data, size_t len, size_t* consumed, int enc, as_amf_err* err) {
    *consumed = 0;
    err->code = 0;
    err->detail = 0;
    if (enc != 3) { err->code = 4; return as_v_null(); }
    as_amf3r r;
    memset(&r, 0, sizeof(r));
    r.p = data;
    r.len = len;
    as_value v = as_amf3_rvalue(&r);
    *consumed = r.pos;
    if (r.code != 0) { err->code = r.code; err->detail = r.detail; }
    for (int i = 0; i < r.ntr; i++) free(r.traits[i].members);
    free(r.traits);
    free(r.strs);
    free(r.objs);
    return v;
}
`;
