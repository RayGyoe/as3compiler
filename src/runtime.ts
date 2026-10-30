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
// The same gap for S_ISREG(): File.size uses it to answer 0 for a directory
// instead of the directory's own st_size, and MSVC's <sys/stat.h> defines
// _S_IFREG but no S_ISREG macro (C99 then rejects the implicit declaration, so
// every program that links flash.filesystem failed to build on Windows).
#ifndef S_ISREG
#define S_ISREG(m) (((m) & _S_IFMT) == _S_IFREG)
#endif
// dirent.h (opendir/readdir/closedir) is POSIX-only: MSVC ships no such header,
// and Windows directory enumeration goes through FindFirstFile/FindNextFile
// (the File.getDirectoryListing body in emit.ts). WASI ships dirent.h, so this
// is skipped for Win32 only.
#if !defined(_WIN32)
#include <dirent.h>
#endif
// statvfs() backs File.spaceAvailable on POSIX. MSVC has no <sys/statvfs.h> (the
// Windows branch calls GetDiskFreeSpaceExA instead) and wasm targets have no
// mounted volume to report, so the header is pulled in under the same guard as
// the other POSIX-only includes.
#if !defined(__wasi__) && !defined(_WIN32) && !defined(__EMSCRIPTEN__)
#include <sys/statvfs.h>
#endif
// Emscripten glue (EM_JS / UTF8ToString / HEAPU8). Needed by the web target
// regardless of the network backend: navigateToURL alone opens a tab, and the
// fetch backend adds the rest. Everything here goes through EM_JS, never
// EM_ASM: inline asm may not share a function with setjmp (see the pump
// helpers near as_web_take_jsstr for the fatal that taught us).
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
// _NSGetExecutablePath backs File.applicationDirectory (see as_app_dir in emit.ts).
#include <mach-o/dyld.h>
// malloc_zone_pressure_relief: the macOS allocator only returns freed pages to
// the OS when asked (see gc_trim_os below).
#include <malloc/malloc.h>
// sysctlbyname("kern.osproductversion"): the macOS *product* version that AIR
// appends to the family name in Capabilities.os (see as_cap_os below).
#include <sys/sysctl.h>
#elif defined(_WIN32)
// <windows.h> pulls in <wingdi.h>, whose GDI Rectangle() function collides with
// the C struct that flash.geom.Rectangle compiles to (typedef struct Rectangle
// Rectangle) — a redefinition error under the MSVC headers. NOGDI drops the whole
// GDI section; the generated C never calls a GDI entry point (all GPU/D3D work
// lives in the separate d3d_glue.cc translation unit), so it loses nothing.
#define NOGDI
#include <windows.h>
#include <psapi.h>
// <io.h> is the UCRT/MinGW home of the low-level file API. FileStream.truncate
// calls _chsize_s(), which <stdio.h> does not declare at all, so without this
// include the call is an undeclared function and the TU does not compile.
#include <io.h>
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
// Several Windows SDK / UCRT identifiers are OBJECT-LIKE macros, which silently
// rewrite a same-named identifier anywhere it appears -- including inside a struct
// body, where the generated C puts every AS3 field name verbatim. Measured on the
// real app: AS3 field _timezone hit UCRT <time.h>'s "#define _timezone
// (*__timezone())" ("field '__timezone' declared as a function") and AS3 field
// small hit <rpcndr.h>'s "#define small char" ("expected member name or ';' after
// declaration specifiers"); AS3 function near(...) hit <winnt.h>'s "#define near"
// (its prototype collapsed to  static void (double,double,char*);  -> "expected
// identifier or '('" in 6 examples). The generated TU never uses the CRT timezone
// globals or the legacy 16-bit near/far/small/huge/pascal qualifiers, so dropping
// the macros is lossless.
//
// OBJECT-LIKE macros can only be handled HERE, not by renaming: they rewrite every
// occurrence, and a struct member is emitted bare, so renaming a *function* would
// leave the field half broken. (FUNCTION-LIKE macros -- min/max/isnan/... -- are
// the opposite case and are handled by renaming the free function only, see
// C_FN_MACRO_RESERVED in symbols.ts and docs/zh-cn/c-naming.md §4.10.)
//
// The names beyond the six measured above are the rest of the same documented
// Windows object-like family. Listing them is safe BY CONSTRUCTION (#undef of an
// undefined name is a no-op) and each was grep-verified not to be used by this
// preamble or the emitted C; CALLBACK is deliberately absent -- the Win32 path
// below really calls InitOnceExecuteOnce through a BOOL CALLBACK function.
#if defined(_WIN32)
#undef _timezone
#undef _daylight
#undef _tzname
#undef small
#undef near
#undef far
#undef _small
#undef _near
#undef _far
#undef huge
#undef _huge
#undef pascal
#undef _pascal
#undef NEAR
#undef FAR
#undef PASCAL
#undef IN
#undef OUT
#undef OPTIONAL
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

// ---------- forward declarations ----------
// Helpers the preamble calls before their definitions. The preamble is written in
// dependency order, but a helper reached from an earlier one must still be declared
// first -- the same reason the generated C prototypes class members.
static void as_shell_unsupported(const char* what);  // as_show_redraw_regions reports through it
// Class-value helpers reached from the preamble (as_obj_to_str / as_v_str_val /
// as_get_qualified_*), all defined with the registry in emitClassRegistry: a Class
// value is a static as_class object -- never GC-allocated -- so it is recognised by
// registry identity, and its OWN fqn (not its instance vtable's) is its name.
static const char* as_class_fqn_of_ptr(void* p);
static char* as_class_display_name(const char* fqn);  // '[class <short name>]'

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

// flash.display.showRedrawRegions(enable, color): see the codegen note. Accepted and
// recorded, but never painted: this render walk has no AIR-style region list, and a
// rectangle around our dirty rect would depict a different thing. AS3's default color
// (0xFF0000) is what the codegen passes when the second argument is omitted.
static int ASC_show_redraw_regions = 0;
static double ASC_show_redraw_regions_color = 16711680.0;
static void as_show_redraw_regions(int on, double color) {
    ASC_show_redraw_regions_color = color;
    if (on == ASC_show_redraw_regions) return;
    ASC_show_redraw_regions = on;
    if (on) as_shell_unsupported("flash.display.showRedrawRegions (this renderer does not paint region outlines)");
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
#ifdef __EMSCRIPTEN__
// Web: a real new tab/window. Being popup-blocked outside a user gesture is the
// browser's documented behaviour, not something this layer can fix.
//
// EM_JS, not EM_ASM: EM_ASM is inline asm, and clang refuses to compile any
// function that contains BOTH inline asm and setjmp (see the pump helpers
// further down for the full story).
EM_JS(void, as_web_open_tab, (const char* url), {
    window.open(UTF8ToString(url), '_blank');
});
#endif

static int as_open_external(const char* url) {
    if (url == NULL || url[0] == '\\0') return 0;
#ifdef __EMSCRIPTEN__
    as_web_open_tab(url);
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
// Report a pointer handed to the marker/barrier that is in the heap but is not a
// block body (阶段一百四十七). Declared here: the write barrier precedes the
// audit code in the preamble.
static void gc_audit_check(void* p);
// ASC_GC_AUDIT switch (defined with the audit code below): gc_heap_used_bytes()
// re-derives its O(1) mirror from the list when the audit is on.
static bool gc_audit_on(void);
// -1 until gc_audit_on() resolves the environment, then 0/1. Defined here rather
// than with the audit code because the allocation path -- which comes first in
// the preamble -- tests it directly (see the note on gc_audit_gate below).
static int gc_audit_mode_cache = -1;

// Allocation failure (definition sits below the GC segment helpers, next to the
// allocator that uses it). Declared up here because as_alloc, which is emitted
// first, must raise instead of storing a NULL buffer.
static _Noreturn void as_gc_oom(size_t need);

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
    if (n > AS_ARENA_SEG_CAP) {  // single oversized allocation
        char* big = (char*)malloc(n);
        if (big == NULL) as_gc_oom(n);
        as_heap_bytes += n;
        return big;
    }
    if (as_arena_head == NULL || as_arena_head->used + n > AS_ARENA_SEG_CAP) {
        // A 4 MiB segment is the same unguarded store as the GC one below; on a
        // 32-bit process it is a routine outcome under pressure, not a corner case.
        as_arena_seg* s = (as_arena_seg*)malloc(sizeof(as_arena_seg));
        char* sbuf = (char*)malloc(AS_ARENA_SEG_CAP);
        if (s == NULL || sbuf == NULL) { free(s); free(sbuf); as_gc_oom(AS_ARENA_SEG_CAP); }
        s->buf = sbuf;
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
        // The audit gate is off by default and is called once per node visited,
        // i.e. ~once per allocation. Testing the cached mode flag here instead of
        // calling the gate unconditionally keeps the off case a load and a branch:
        // the call alone (prologue, string argument, flag re-check) measured ~7%
        // of benchmarks/strings and ~8% of benchmarks/binarytrees. -1 (not yet
        // resolved) still falls through, and the gate resolves it. 2026-10,
        // temp/bench/wbfix.
        for (gc_header* h = *list; h != NULL; prev = h, h = h->next) {
            if (gc_audit_mode_cache != 0) gc_audit_gate("free-list node", h);
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
        size_t new_cap = gc_seg_range_cap == 0 ? 64 : gc_seg_range_cap * 2;
        // Never assign realloc result straight back: on failure it returns NULL and
        // the original table would be lost, leaving gc_seg_find reading NULL.
        gc_seg_range* grown = (gc_seg_range*)realloc(gc_seg_ranges, new_cap * sizeof(gc_seg_range));
        if (grown == NULL) as_gc_oom(new_cap * sizeof(gc_seg_range));
        gc_seg_ranges = grown;
        gc_seg_range_cap = new_cap;
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

// ---------- allocation failure ----------
// Both allocators used to store malloc result straight into a struct field and
// dereference it. That is a real crash, not a formality: a 32-bit process runs
// out of ADDRESS SPACE long before it runs out of RAM. The stage-278 dumps are
// exactly this -- gc_alloc carving a 3.6 MB BitmapData buffer whose segment base
// had come back NULL, faulting on the NEXT statement (movl edi,0xc(eax) with
// eax = 0, i.e. the fresh->size store); as_alloc has the same shape for its 4 MiB
// arena segments.
//
// AIR answers an allocation it cannot satisfy with Error #1000 (avmplus
// kOutOfMemoryError), which ActionScript can catch, so that is what we raise
// instead of faulting. One stop-the-world collection is attempted first: the
// free lists can hold plenty of bytes while no single block is big enough, and a
// sweep is what turns the former into the latter. gc_in_gc keeps the collector
// from re-entering itself (collect does allocate: gc_grey_push grows its stack).
static int gc_in_gc = 0;
static int as_oom_active = 0;
// ASC_FORCE_OOM_MIN=<bytes>: fail every segment carve at least that big. Unset
// means off (-1 sentinel is resolved on the first carve, never on the hot path).
// This exists so the Error #1000 path is testable where memory is not short.
static size_t as_oom_force_min = (size_t)-1;
static void* as_error_new_oom(const char* msg, int id);  // emitted with the Error class
static _Noreturn void as_throw(void* e);

// Raise Error #1000 the way AIR does (avmplus kOutOfMemoryError): a catchable
// Error, never a fault, and never exit() while an Error can still be raised. The
// one process-wide guard keeps a failed raise from recursing back into itself.
// Where did the address space go? The GC figures in the messages below answer
// "are the free lists shredded"; this answers "is there room in the process at
// all". They are different failures with different fixes, and the report used to
// carry only the first half: a 32-bit run that died on an 8.29 MB carve printed
// "23.6 MB free", which reads like fragmentation but was address-space
// exhaustion -- those 23.6 MB sat inside existing 64 KiB / 1 MiB segments, and
// the fresh 8.29 MB carve had nowhere in the process to land.
//
// largest is the number that matters: a request bigger than it cannot be served
// however much total free space exists. On a 32-bit image that is also where a
// missing LARGEADDRESSAWARE bit shows up as a hard 2 GB ceiling (see
// windowsLinkFlags in build.ts).
static void as_oom_addrspace_report(void) {
#if defined(_WIN32)
    // The region walk only says something where the address space is actually
    // bounded. In a 64-bit process the "free" total is dominated by the 128 TB
    // reserved-but-untouched range and reads as nonsense, so it is compiled out
    // there and the process figures carry the message alone.
    size_t free_total = 0, free_largest = 0, reserved = 0, committed = 0;
#if !defined(_WIN64)
    MEMORY_BASIC_INFORMATION mbi;
    char* p = NULL;
    while (VirtualQuery(p, &mbi, sizeof(mbi)) == sizeof(mbi)) {
        size_t sz = (size_t)mbi.RegionSize;
        if (mbi.State == MEM_FREE) {
            free_total += sz;
            if (sz > free_largest) free_largest = sz;
        } else {
            reserved += sz;
            if (mbi.State == MEM_COMMIT) committed += sz;
        }
        char* next = (char*)mbi.BaseAddress + sz;
        if (next <= p) break;   /* never loop on a wrapped pointer */
        p = next;
    }
#endif
    PROCESS_MEMORY_COUNTERS pmc;
    double ws = 0.0, commit_mb = 0.0, peak_mb = 0.0;
    if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc))) {
        ws = (double)pmc.WorkingSetSize / 1048576.0;
        commit_mb = (double)pmc.PagefileUsage / 1048576.0;
        peak_mb = (double)pmc.PeakPagefileUsage / 1048576.0;
    }
#if defined(_WIN64)
    fprintf(stderr, "[as3-aot] process: ws=%.0f MB commit=%.0f MB peak=%.0f MB\\n",
            ws, commit_mb, peak_mb);
#else
    fprintf(stderr, "[as3-aot] address space: %.0f MB free (largest region %.1f MB), "
                    "%.0f MB reserved of which %.0f MB committed"
                    " | process ws=%.0f MB commit=%.0f MB peak=%.0f MB\\n",
            (double)free_total / 1048576.0, (double)free_largest / 1048576.0,
            (double)reserved / 1048576.0, (double)committed / 1048576.0,
            ws, commit_mb, peak_mb);
#endif
    fflush(stderr);
#endif
}

static _Noreturn void as_oom_raise(void) {
    if (!as_oom_active) {
        as_oom_active = 1;
        as_throw(as_error_new_oom("Error #1000: The system is out of memory.", 1000));
    }
    // The Error object itself could not be allocated: there is nothing left to
    // raise, so stop here rather than recursing back into this function.
    exit(1);
}

static _Noreturn void as_gc_oom(size_t need) {
    // The numbers are the report: they say whether the address space is gone or
    // the free lists are just too fragmented, which are fixed very differently.
    size_t seg_total = 0, seg_free = 0;
    int seg_n = 0;
    for (gc_seg* s = gc_segs; s != NULL; s = s->next) {
        seg_n++;
        seg_total += s->size;
        seg_free += s->free_bytes;
    }
    fprintf(stderr, "[as3-aot] out of memory: malloc failed for %lu bytes "
                    "(gc heap %.1f MB in %d segments, %.1f MB free, arena %.1f MB)\\n",
            (unsigned long)need, (double)seg_total / 1048576.0, seg_n,
            (double)seg_free / 1048576.0, (double)as_heap_bytes / 1048576.0);
    fflush(stderr);
    as_oom_addrspace_report();
    as_oom_raise();
}

// ---------- C++ allocation failure (operator new) ----------
// The same 32-bit address-space wall has a second face, and it is the one the
// stage-二百八十 dump shows: an unsatisfied C++ allocation throws std::bad_alloc,
// nothing in the generated C can catch it, and the exception reaches
// std::terminate -- which on Windows is abort(), i.e. __fastfail(7) and exit code
// 0xC0000409 with no AS3 error at all (fault in _abort+0x29, with
// __CxxThrowException and the std::bad_alloc type descriptor still on the stack:
// terminate is called from the handler SEARCH, so the frames were never unwound).
//
// vendor/skia_glue.cc -- the only place C++ is linked into the program -- therefore
// overrides the global operator new and calls this function instead of throwing.
// Returning 1 tells it to retry the allocation (a collection just ran); never
// returning is the "nothing can be freed" answer, which escalates to Error #1000.
static double as_cxx_oom_last_ms = -1.0;
static int as_cxx_oom_forced = -1;
static int as_oom_from_cxx(size_t need) {
    // ASC_FORCE_CXX_OOM=1: skip the collection and escalate, so the whole chain
    // (failed operator new -> this hook -> catchable Error #1000) is exercised on
    // a machine with memory to spare. The refusal itself is injected by the glue.
    if (as_cxx_oom_forced < 0) {
        const char* f = getenv("ASC_FORCE_CXX_OOM");
        as_cxx_oom_forced = (f != NULL && f[0] != '0') ? 1 : 0;
    }
    size_t seg_total = 0, seg_free = 0;
    int seg_n = 0;
    for (gc_seg* s = gc_segs; s != NULL; s = s->next) {
        seg_n++;
        seg_total += s->size;
        seg_free += s->free_bytes;
    }
    double now = as_now_ms();
    // One collection per 250 ms: a second refusal inside that window means the
    // collection did not free anything usable, and answering "retry" again would
    // only spin inside operator new.
    if (!as_cxx_oom_forced && !gc_in_gc && gc_segs != NULL
        && (as_cxx_oom_last_ms < 0.0 || now - as_cxx_oom_last_ms > 250.0)) {
        as_cxx_oom_last_ms = now;
        fprintf(stderr, "[as3-aot] out of memory: C++ operator new failed for %lu bytes, "
                        "collecting (gc heap %.1f MB in %d segments, %.1f MB free, arena %.1f MB)\\n",
                (unsigned long)need, (double)seg_total / 1048576.0, seg_n,
                (double)seg_free / 1048576.0, (double)as_heap_bytes / 1048576.0);
        fflush(stderr);
        gc_collect();
        return 1;
    }
    fprintf(stderr, "[as3-aot] out of memory: C++ operator new failed for %lu bytes "
                    "(gc heap %.1f MB in %d segments, %.1f MB free, arena %.1f MB)\\n",
            (unsigned long)need, (double)seg_total / 1048576.0, seg_n,
            (double)seg_free / 1048576.0, (double)as_heap_bytes / 1048576.0);
    fflush(stderr);
    as_oom_addrspace_report();
    as_oom_raise();
    return 0;  // unreachable: as_oom_raise never returns
}

// Allocate a GC object of the given type. Returns the object body (header hidden
// before it). The body is zeroed so uninitialized array slots read as tag 0
// (null) during mark, never a stale pointer.
//
// GCT_STRING is the one exception (see the memset below): it is a raw byte
// buffer that gc_scan treats as a leaf, so none of its bytes is ever read as a
// pointer and the zeroing buys nothing there.
static void* gc_alloc(int type, size_t size) {
    // ASC_GC_AUDIT: gc_all is written only by this function and by the sweeper,
    // so a non-heap value here was stored by unrelated code (a wild store). The
    // report's call chain is the statement that ran right after that store.
    if (gc_audit_mode_cache != 0) gc_audit_gate("gc_all", gc_all);
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
        if (gc_audit_mode_cache != 0) gc_audit_gate("free-list block", h);
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
        // Skip the zero-fill for raw string buffers: gc_scan never reads their
        // bytes as pointers (GCT_STRING is a leaf), and every producer writes
        // its own trailing NUL, so the fill is pure cost -- and strings are the
        // most allocation-heavy workload we have (14 of the 16 allocations in
        // each benchmarks/strings iteration). Measured ~12 ms of 225 ms there.
        if (type != GCT_STRING) memset(body, 0, h->size);
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
    // Carve the segment. Both mallocs can return NULL (see as_gc_oom): retry once
    // after a collection, then raise Error #1000 -- never store NULL and write
    // through it on the next line, which is how this used to die.
    if (as_oom_force_min == (size_t)-1) {
        const char* oom_env = getenv("ASC_FORCE_OOM_MIN");
        as_oom_force_min = (oom_env != NULL && atoi(oom_env) > 0) ? (size_t)atoi(oom_env) : 0;
    }
    int oom_forced = as_oom_force_min != 0 && seg_size >= as_oom_force_min;
    gc_seg* s = oom_forced ? NULL : (gc_seg*)malloc(sizeof(gc_seg));
    char* seg_base = oom_forced ? NULL : (char*)malloc(seg_size);
    if ((s == NULL || seg_base == NULL) && gc_in_gc == 0) {
        free(s);
        free(seg_base);
        gc_collect();
        // The forced failure survives the retry on purpose: the point is to see
        // the Error #1000 raise, not to watch a retry succeed.
        s = oom_forced ? NULL : (gc_seg*)malloc(sizeof(gc_seg));
        seg_base = oom_forced ? NULL : (char*)malloc(seg_size);
    }
    if (s == NULL || seg_base == NULL) {
        free(s);
        free(seg_base);
        as_gc_oom(seg_size);
    }
    s->base = seg_base;
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
//
// gc_alloc skips zeroing a GCT_STRING block (see its note): the marker never
// scans these bytes for pointers, so the zero-fill can never matter, and the
// caller writing the trailing NUL is the contract anyway. Every producer below
// honours it -- memcpy of a known length plus an explicit NUL, or snprintf/strcpy
// which terminate -- so the block is always a well-formed C string on return.
static char* as_str_alloc(size_t n) {
    return (char*)gc_alloc(GCT_STRING, n);
}

// Duplicate a C string into a FRESH GC string (NULL-safe).
//
// Every char* that crosses into AS3-owned storage must be an independent value:
// AS3 strings are values, and a pointer that belongs to another object dies with
// its owner. Measured on TalkMED (阶段一百四十七): the XML text of every <label>
// in the language pack reached cn.edoctor.utils.Language's static fields through a
// dynamic write (Language[key] = xml), i.e. ~1000 statics held pointers into
// XML-owned buffers; once the parsed tree became garbage the statics dangled, and
// the freed blocks then corrupted the GC free list (SIGSEGV at gc_sweep_step /
// sk_textlayout_paint / as_v_is_inst, plus a DANGLING reference to a SWEPT block
// naming the Language statics as the holder).
static char* as_str_dup(const char* s) {
    if (s == NULL) return NULL;
    size_t n = strlen(s);
    char* out = as_str_alloc(n + 1);
    memcpy(out, s, n + 1);
    return out;
}

// The empty AS3 string as an independent GC-managed value: one byte, with the
// terminator written right here. Use this instead of a bare one-byte
// as_str_alloc of one byte, which allocates that byte but leaves it uninitialised — the GC deliberately
// does not zero GCT_STRING (see the as_str_alloc contract), so a forgotten write
// lets every consumer of the string (strlen, text layout, trace) read whatever
// the recycled block used to hold. Measured on TalkMED (阶段一百四十九): an
// SWC-baked empty TextField rendered the previous occupant of its block
// ("MS: 17/18", "_sans") as visible text, with the run's own glyph attributes.
static char* as_str_empty(void) {
    char* s = (char*)gc_alloc(GCT_STRING, 1);
    s[0] = 0;
    return s;
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
    // “p 位能读回 v”是单调的：更多位是同一实数的更精确十进制展开，correctly-rounded
    // 的解析只会离 v 更近；p 位已能得回 v 时 p+1 位必然也能。所以二分 0..17，最多 5 次
    // snprintf+strtod，取代原来的线性试错（遇到 17 位小数要走 18 轮）。实测旧写法把一次
    // double 转字符串抬到 20-24us（同一算法在 AIR 里 <2.5us），而拼字符串在应用里随处可见
    // （日志上报、列表行、拼 URL）。
    // 输出与旧写法逐字节一致：同一谓词、同一格式串、同一搜索区间。
    // In FIXED notation the leading zeros after the point eat into the 17
    // significant digits a double can need: 1.2e-4 round-trips only at 20
    // decimal places, so the old hard cap of 17 produced "0.00012000000000000000"
    // -- a string that reads back as a DIFFERENT double (measured on adl 51.4.1,
    // temp/rtprobe2: AIR prints 0.00012000000000000002 and round-trips, we did
    // not). Headroom per decade below 1 keeps the predicate and the format string
    // unchanged; it only widens the search interval (a few more strtod probes).
    int hi = 17;
    if (!sci) { double t = av; while (t < 1.0) { t *= 10.0; hi++; } }
    int lo = 0;
    while (lo < hi) {
        int mid = (lo + hi) >> 1;
        snprintf(buf, sizeof(buf), sci ? "%.*e" : "%.*f", mid, v);
        if (strtod(buf, NULL) == v) hi = mid; else lo = mid + 1;
    }
    snprintf(buf, sizeof(buf), sci ? "%.*e" : "%.*f", lo, v);
    if (sci) as_norm_exp(buf);
    char* r = as_str_alloc(strlen(buf) + 1);
    strcpy(r, buf);
    return r;
}
static char* as_str_from_bool(bool b) {
    return (char*)(b ? "true" : "false");
}

typedef struct { void* vtable; } as_object_header;
// The last three slots mirror as_object_vtable's tail: every generated class
// vtable appends Object's own method slots (toString, hasOwnProperty,
// propertyIsEnumerable) after the common header, so the pre-baked vtables declared
// here must carry the SAME slots in the SAME order: a shorter object leaves them
// reading whatever variable happens to follow, and '({a:1}).hasOwnProperty("a")'
// (a plain object literal, or an Object-typed slot holding a boxed scalar) then
// jumps through a garbage function pointer. The generated Object_hasOwnProperty is
// this same as_dyn_has walk and Object_propertyIsEnumerable the same
// as_dyn_enumerable walk, so the semantics match exactly.
// vtable (and every pre-baked box vtable) appends Object's own method slots --
// the effective toString and hasOwnProperty -- directly after the common header,
// so a vtable pointer can be read generically through this struct. as_obj_to_str
// relies on the toString slot to honor a class's override (AIR calls the virtual
// toString for String(x) / "" + x; a ShaderRegisterElement must render as 'vt0',
// not as its C class name -- measured on adl 51.4.1).
typedef struct { const char* name; void* super; void** ifaces; void* props; void* methods; void* getters; void* setters; int dyn_offset; const char* fqn; int is_proxy; int is_dynamic; int is_final; char* (*toString)(void*); bool (*hasOwnProperty)(void*, char*); } as_vtable_header;

// Reflection table entry: one reflectable field of a class. 'type' encodes the
// boxed storage kind (1 number, 2 bool, 3 string, 4 int, 5 uint, 6 ref, 7 any;
// 8/9 are our 64-bit enhancement tags). 10/11/12 are REFERENCE kinds whose static
// type IS known, so a dynamic write can be type-checked the way AIR does it
// (measured on adl 51.4.1, temp/pkgA/dyn.body.as: 'var d:Object = sprite;
// d.filters = 5' -> #1034 "cannot convert 5 to Array.", 'd.transform = 5' ->
// #1034 "... to flash.geom.Transform."): 10 = Array, 11 = class instance (needs
// 'vt'/'fqn' for as_v_req_inst), 12 = Object (autoboxes like AIR's Object slot).
// 'offset' is the byte offset of the field within the (flattened) class struct.
//
// 'vis' is the member's visibility for the reflection consumers that must skip
// non-public members: 0 = public, 1 = non-public (private/protected/internal,
// plus the synthetic entries this table also carries for the GC scanner). It is
// the LAST field so that every pre-existing initializer -- which omits it --
// still spells a public member, which is what those tables mean. JSON.stringify
// is the first consumer: AIR serializes only public fields and public getters
// (measured on adl 51.4.1 -- temp/jsonair5 emits {"p":3} for a class whose only
// public member is the getter of a private field).
typedef struct { const char* name; int type; size_t offset; void* vt; const char* fqn; int vis; int is_accessor; int is_const; } as_prop;

// Does this heap body start with a vtable pointer? An Object-typed slot is the
// universal value slot, so it can hold things that DO NOT: an Array starts with
// its element buffer, a Dictionary with its key buffer, a Vector with its mark
// callback, a String with its characters, a Closure with its function pointer.
// Reading the first word as an as_object_header and following it as a vtable
// header segfaulted -- 'var o:Object = [1,2,3]; o is Marker' (0xC0000005) and
// the same test through a '*' slot (G14). The test WHITELISTS the kinds that do
// carry one, so a future allocation kind defaults to "no vtable" (a wrong
// false from is) rather than to a wild read.
static bool as_has_vtable(void* obj) {
    if (obj == NULL) return false;
    // Statics -- a class object, a baked vtable, a string literal -- are safe by
    // construction; only a GC body needs the kind dispatch.
    if (!gc_in_heap(obj)) return true;
    switch (gc_hdr(obj)->type) {
        case GCT_OBJECT: case GCT_CLASS: case GCT_XML: case GCT_XML_LIST:
        case GCT_NUMBER: case GCT_STRING_OBJ: case GCT_BOOLEAN: case GCT_FUNCTION_OBJ:
            return true;
        default: return false;
    }
}

// Look up an interface vtable by name from the object's vtable interface list.
// Returns NULL when the object's class does not implement the interface.
static void* as_iface_lookup(void* obj, const char* name) {
    if (!as_has_vtable(obj)) return NULL;
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
    // A NULL target can never match, and answering it requires reading obj's first
    // word as a vtable -- which is a data pointer or a mark callback for an Array/
    // Vector/Dictionary, so the read itself would be the crash. (The core classes
    // int/uint/Array carry no instance vtable: see Emitter.CORE_CLASS_VT.)
    if (target_vt == NULL) return false;
    // The same hazard without a NULL target: 'o is Marker' where o:Object holds an
    // Array read the element buffer as a vtable header and crashed (G14). No
    // vtable-less body can be an instance of a class, so answer false.
    if (!as_has_vtable(obj)) return false;
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
// The Array join(",") stringifier, defined with the Array helpers below; needed
// here because an Array in an Object slot reaches as_obj_to_str AND as_obj_default_str
// (Object's toString slot).
static char* as_arr_to_str(void* a);
static char* as_obj_default_str(void* obj) {
    // An Array is not an object with a vtable: its first word is the element buffer,
    // so the vtable reads below segfaulted (G14: 'var o:Object = [1,2,3]' then
    // 'o.toString()' resolves to Object's slot). Same answer as String(o).
    if (obj != NULL && gc_in_heap(obj) && gc_hdr(obj)->type == GCT_ARRAY) return as_arr_to_str(obj);
    if (obj != NULL && gc_in_heap(obj) && gc_hdr(obj)->type == GCT_DICT) return "[object Dictionary]";
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
    // An Array is not an object with a vtable (first word = element buffer), so the
    // vtable read below crashed: 'var o:Object = [1,2,3]; String(o)' segfaulted
    // (G14). Its string form is join(","), the same answer as_v_str_val's tag-6
    // branch gives a '*' receiver.
    if (gc_in_heap(obj) && gc_hdr(obj)->type == GCT_ARRAY) return as_arr_to_str(obj);
    // A Dictionary has no vtable either (its first word is the pair buffer), and AIR
    // renders it under its class name like any other object (measured: "[object
    // Dictionary]", temp/g14/DictAir.as).
    if (gc_in_heap(obj) && gc_hdr(obj)->type == GCT_DICT) return "[object Dictionary]";
    // A Class VALUE is not an instance: the first word of a class object is the
    // INSTANCE vtable of the class it denotes, so running that vtable's toString on
    // it reads the class object as an object of its own class (measured: the
    // primitive/String comparison 'x == String' segfaulted in as_string_box_to_str).
    // AIR renders a Class value as [class X].
    if (!gc_in_heap(obj)) {
        const char* cfqn = as_class_fqn_of_ptr(obj);
        if (cfqn != NULL) return as_class_display_name(cfqn);
    }
    void* vt = ((as_object_header*)obj)->vtable;
    if (vt == NULL) return "Object";
    // A Proxy receiver is stringified through its callProperty("toString")
    // override, not the class name (measured on adl 51.4.1: 'String(p)' calls
    // callProperty with "toString"; a proxy without it throws #2090).
    if (((as_vtable_header*)vt)->is_proxy) {
        // A Proxy override that returns null (or a proxy without one) must not
        // hand a null pointer to printf("%s"): ES3 ToString(null) == "null".
        char* r = as_proxy_to_str(obj);
        return r != NULL ? r : (char*)"null";
    }
    // AS3's implicit string conversion calls the virtual toString(): a class
    // override wins, and the no-override slot is Object's default, which renders
    // the AIR '[object X]' text (see as_obj_default_str). Without this, away3d's
    // ShaderRegisterElement -- whose toString() returns the register name --
    // stringified as its C class name and the generated AGAL failed to assemble.
    char* (*toStr)(void*) = ((as_vtable_header*)vt)->toString;
    if (toStr != NULL) {
        // A user toString() may return the AS3 null String, and AIR renders that
        // as "null" (ES3 ToString). Measured death without this: the app printed
        // the value through trace() and ucrt fastfailed with 0xC0000409.
        char* r = toStr(obj);
        return r != NULL ? r : (char*)"null";
    }
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
// defined with the XML helpers further down; used by the array/object reads
// below, which return AIR's undefined for a missing element/property.
static as_value as_v_undefined(void);
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

// Read one field of a class instance by reflection-table entry. Shared by the
// dynamic readers (as_dyn_get / as_any_get / for-in) and by JSON.stringify, so
// the two can never drift apart on a storage kind. Type tags are the ones
// documented on as_prop above; kinds 10/11/12 (Array / class instance / Object
// slot) read exactly like 6, because the slot is already a pointer -- only the
// WRITE side type-checks. 64-bit enhancement fields (our own tags 8/9) hold a
// plain int64_t/uint64_t in the struct, so the boxed value keeps the exact width.
static as_value as_prop_read(void* base, const as_prop* p) {
    switch (p->type) {
        case 1: return as_v_num(*(double*)((char*)base + p->offset));
        case 2: return as_v_bool(*(bool*)((char*)base + p->offset));
        case 3: case 13: return as_v_str(*(char**)((char*)base + p->offset));
        case 4: return as_v_num((double)(*(int*)((char*)base + p->offset)));
        case 5: return as_v_num((double)(*(unsigned*)((char*)base + p->offset)));
        case 6: case 11: case 12: return as_v_obj(*(void**)((char*)base + p->offset));
        // An Array-typed field must box as tag 6 (Array): as_v_obj would hand out
        // a tag-4 value whose first word is the array's DATA pointer, so every
        // reflective consumer of that box (String(field), typeof, a dynamic
        // access on the result) would read the data pointer as a vtable instead.
        case 10: return as_v_arr(*(void**)((char*)base + p->offset));
        case 7: return *(as_value*)((char*)base + p->offset);
        case 8: return as_v_i64(*(int64_t*)((char*)base + p->offset));
        case 9: return as_v_u64(*(uint64_t*)((char*)base + p->offset));
    }
    return as_v_null();
}

// Write barrier (GC-4 incremental marking, Dijkstra insertion barrier). During
// MARK the mutator runs between gc_step slices; a write of a still-WHITE pointer
// must grey it so the mark does not miss the edge. Outside MARK the whole barrier
// is one int compare. gc_write_barrier handles raw pointers (dict keys, direct
// field writes); gc_write_barrier_value handles boxed as_value slots.
//
// The split below is a performance decision, not a structural one. The barrier
// body needs gc_in_heap (segment lookup) and gc_grey_push, and clang's inline cost
// for the combined function is 275 -- over the 225 budget -- so all ~580 call sites
// in a generated program (shell constructors, array/dict setters, and the *emitted*
// field writes of a hot loop like benchmarks/binarytrees' make()) get an out-of-line
// call. That is what cost binarytrees 99 -> 117 ms (measured 2026-10): three of
// gc_write_barrier's 580 call sites are inside make(), and make() runs 3.2M times.
// Note the body here is byte-identical to the pre-regression build; the regression
// was purely clang choosing to inline gc_in_heap INTO the barrier that time, which
// pushed the barrier over the budget. Keeping the expensive half out of line makes
// the inlinable wrapper's cost independent of that decision.
//
// The slow path is reached through a volatile function pointer, NOT a direct call,
// and that is load-bearing. clang grants a large "last call to static" bonus to a
// callee with a single call site, which would inline the slow path back into the
// wrapper and restore the 275 cost (measured: with a plain gc_write_barrier_slow(p)
// call in the wrapper, the barrier is NOT inlined into any of its 584 callers again).
// A second direct call site defeats the bonus too, but only while that call site
// survives dead-code elimination -- a program that never touches an Array/Dictionary
// drops gc_write_barrier_value, the slow path falls back to a single call site, and
// the regression returns silently (measured). An indirect call through a volatile
// pointer is immune to both: the address escapes, so the callee is never "used
// once", and the volatile load stops clang devirtualising it. Cost: one predictable
// compare in the hot path, an indirect call only inside MARK (never taken in the
// non-GUI stop-the-world builds, where the mutator does not run during mark).
// Measured on binarytrees: 117 -> 112 ms, vs 112 ms with the barrier deleted
// outright -- i.e. the barrier's fast path is free again (temp/bench/wbfix/).
static void gc_write_barrier_slow(void* p) {
    if (p == NULL || !gc_in_heap(p)) return;
    // ASC_GC_AUDIT: a barrier write is where a bad reference first reaches the
    // heap, so report a non-body pointer here -- the call chain is the writer.
    if (gc_audit_mode_cache != 0) gc_audit_check(p);
    gc_header* h = gc_hdr(p);
    if (h->color == GC_WHITE) { h->color = GC_GREY; gc_grey_push(h); }
}
static void (*volatile gc_write_barrier_slow_fn)(void*) = gc_write_barrier_slow;
static void gc_write_barrier(void* p) {
    if (gc_inc.state != GC_MARK) return;
    gc_write_barrier_slow_fn(p);
}
static void gc_write_barrier_value(as_value v) {
    if (gc_inc.state != GC_MARK) return;
    if (v.tag == 3 || v.tag == 4 || v.tag == 6 || v.tag == 7) gc_write_barrier_slow_fn(v.ptr);
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
// AS3 parseInt(str:String, radix:uint = 0):Number -- the ES3 grammar with AVM2's
// measured deviations (adl 51.4.1, temp/qfix/gcadl/pMain.as + p2/p3/p4): trailing
// junk is IGNORED ("12abc" -> 12), the radix is honored ("ff",16 -> 255), a 0x/0X
// prefix is auto-detected at radix 0 AND stripped when radix 16 is explicit
// ("0xB",16 -> 11) but NOT at other radixes ("0x10",10 -> 0), leading zeros are
// DECIMAL ("010" -> 10, no octal), and a bad radix or a digitless string is NaN.
// Distinct from Number(str), which rejects trailing junk.
static double as_parse_int(const char* str, double radixd) {
    if (str == NULL) return NAN;
    const char* p = str;
    while (*p == ' ' || *p == '\\t' || *p == '\\n' || *p == '\\v' || *p == '\\f' || *p == '\\r') p++;
    int neg = 0;
    if (*p == '+' || *p == '-') { neg = (*p == '-'); p++; }
    int radix = as_to_int32(radixd);
    if (radix == 0) {
        if (p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) { radix = 16; p += 2; }
        else radix = 10;
    } else if (radix < 2 || radix > 36) {
        return NAN;
    } else if (radix == 16 && p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) {
        p += 2;
    }
    double acc = 0.0;
    int digits = 0;
    for (;; p++) {
        int c = (unsigned char)*p;
        int d;
        if (c >= '0' && c <= '9') d = c - '0';
        else if (c >= 'a' && c <= 'z') d = c - 'a' + 10;
        else if (c >= 'A' && c <= 'Z') d = c - 'A' + 10;
        else break;
        if (d >= radix) break;
        acc = acc * (double)radix + (double)d;
        digits++;
    }
    if (digits == 0) return NAN;
    return neg ? -acc : acc;
}
// AS3 parseFloat(str:String):Number -- the longest prefix that is a decimal
// literal; trailing junk is ignored ("5e3junk" -> 5000, "5x" -> 5) unlike
// Number(). AVM2 quirks measured on adl 51.4.1 (temp/qfix/gcadl/p3/p4): an
// exponent marker with no digits REWINDS ("5e" / "5e+" -> 5) unless it is a bare
// minus ("5e-" -> NaN), "Infinity" is case-sensitive, "Inf" is NaN.
static double as_parse_float(const char* str) {
    if (str == NULL) return NAN;
    const char* p = str;
    while (*p == ' ' || *p == '\\t' || *p == '\\n' || *p == '\\v' || *p == '\\f' || *p == '\\r') p++;
    const char* start = p;
    if (*p == '+' || *p == '-') p++;
    if (strncmp(p, "Infinity", 8) == 0) return (start[0] == '-') ? -INFINITY : INFINITY;
    const char* ds = p;
    while (*p >= '0' && *p <= '9') p++;
    int ndig = (int)(p - ds);
    if (*p == '.') {
        p++;
        const char* fs = p;
        while (*p >= '0' && *p <= '9') p++;
        ndig += (int)(p - fs);
    }
    if (ndig == 0) return NAN;
    if (*p == 'e' || *p == 'E') {
        const char* r = p + 1;
        int eneg = 0;
        if (*r == '+' || *r == '-') { eneg = (*r == '-'); r++; }
        if (*r >= '0' && *r <= '9') {
            p = r;
            while (*p >= '0' && *p <= '9') p++;
        } else if (eneg) {
            return NAN;   // "5e-" is NaN, but "5e" / "5e+" rewind to the mantissa
        }
        // else: no exponent digits -> the marker is not part of the literal.
    }
    size_t n = (size_t)(p - start);
    char buf[64];
    if (n >= sizeof(buf)) n = sizeof(buf) - 1;
    memcpy(buf, start, n);
    buf[n] = 0;
    return strtod(buf, NULL);
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
// ES3 ToNumber(Object): NUMBER-hint ToPrimitive -- valueOf() first, then
// toString() -- then stringToDouble on the resulting primitive. Measured on adl
// 51.4.1 (temp/qfix/gcadl/numMain.as): Number({}) is NaN, Number(a class whose
// toString() gives "42") is 42, and a valueOf() override wins over toString()
// (WithValueOf -> 7, not 99). Object's default valueOf returns the receiver, so a
// class that does not override it falls through to toString.
static double as_obj_to_number(void* obj);
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
    // is "1,2", which is not a number) -- adl 51.4.1, temp/pkgA/arrnum.
    if (v.tag == 6 && v.ptr != NULL) return as_str_to_number(as_arr_to_str(v.ptr));
    // An object runs the NUMBER-hint ToPrimitive (valueOf -> toString).
    if (v.tag == 4) return as_obj_to_number(v.ptr);
    // undefined and a Function value are NaN; null is 0 (ES3 9.3).
    if (v.tag == 5 || v.tag == 7) return NAN;
    return 0.0;                           // null -> 0
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
    // An object goes through ToNumber first (int/uint of a class whose toString
    // is "42" give 42); undefined/function give ToNumber NaN -> ToInt32 0.
    if (v.tag == 4) return as_to_int32(as_obj_to_number(v.ptr));
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
    // An object goes through ToNumber first (int/uint of a class whose toString
    // is "42" give 42); undefined/function give ToNumber NaN -> ToUint32 0.
    if (v.tag == 4) return as_to_uint32(as_obj_to_number(v.ptr));
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

// Display text of a statically String-typed value (what trace() and String()
// produce): a String slot legitimately holds C NULL (var s:String = null), and
// AS3's String(null) is the four characters "null". Handing that NULL straight to
// printf is not merely wrong output -- Windows ucrt rejects the null pointer through
// _invalid_parameter -> __fastfail(FAST_FAIL_INVALID_ARG) and kills the process with
// 0xC0000409 (measured on the TalkMED gift panel, where GiftListView.updateList()
// does trace(targetUrl) with targetUrl:String = null and clang folds the printf into
// puts), while Apple libc silently prints "(null)" instead.
static char* as_str_or_null(const char* s) { return s != NULL ? (char*)s : (char*)"null"; }

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
// Method-reflective table entry: 'vis' is the same public/non-public flag as on
// as_prop, so JSON.stringify emits only public getters. Last field again, so an
// initializer that omits it spells a public member.
typedef struct { const char* name; as_value (*fn)(void* _this, as_value* args, int argc); int vis; const char* sig; } as_method; static as_value as_refl_ctor_stub(void* _this, as_value* args, int argc) { (void)_this; (void)args; (void)argc; return as_v_null(); }
// ES3 ToNumber(Object): the NUMBER-hint ToPrimitive (valueOf first, then
// toString) followed by stringToDouble on the primitive. Defined here because
// it needs the as_method struct above; as_v_to_number forward-declares it.
static double as_obj_to_number(void* obj) {
    if (obj == NULL) return 0.0;
    // A Class value has no numeric conversion: ES3's ToNumber of an object runs
    // valueOf/toString, and neither of a class object's inherited slots may be
    // called -- its first word is the INSTANCE vtable of the class it denotes, so
    // a String class object would run as_string_box_to_str on the class struct
    // (measured crash). AIR: Number(SomeClass) is NaN, and '5 == SomeClass' is false.
    if (!gc_in_heap(obj) && as_class_fqn_of_ptr(obj) != NULL) return NAN;
    // An Array in an Object slot is not an object with a vtable: its first word is
    // the element buffer. ToNumber runs ToString first (ES3), i.e. the join --
    // Number([5]) is 5 and Number([1,2]) is NaN, exactly as the '*' path already
    // answered (as_v_to_number's tag-6 branch). Reading the buffer as a vtable is
    // what made 'var o:Object = [1,2,3]; Number(o)' undefined behaviour (G14).
    if (gc_in_heap(obj) && gc_hdr(obj)->type == GCT_ARRAY)
        return as_str_to_number(as_arr_to_str(obj));
    void* vt = ((as_object_header*)obj)->vtable;
    if (vt == NULL) return 0.0;
    // 1) valueOf(): a user override lives in the method table. The built-in
    //    Object.valueOf is not emitted as a method and returns the receiver, so
    //    its absence IS the "falls through to toString" case.
    as_method* methods = (as_method*)((as_vtable_header*)vt)->methods;
    if (methods != NULL) {
        for (int i = 0; methods[i].name != NULL; i++) {
            if (strcmp(methods[i].name, "valueOf") == 0) {
                as_value r = methods[i].fn(obj, NULL, 0);
                if (r.tag != 4 && r.tag != 6 && r.tag != 7) return as_v_to_number(r);
                break;   // valueOf returned an object -> fall through to toString
            }
        }
    }
    // 2) toString() through the vtable slot the string path already uses.
    char* (*toStr)(void*) = ((as_vtable_header*)vt)->toString;
    char* s = toStr != NULL ? toStr(obj) : as_obj_default_str(obj);
    return as_str_to_number(s != NULL ? s : "");
}
// Prototype for the Proxy interceptor dispatcher, defined with the array helpers
// below (measure: as_dyn_call must reach a dynamic Proxy subclass's callProperty).
static as_value as_proxy_call(void* obj, const char* mname, as_value* args, int argc);
// Prototype for the dynamic has-check, defined with the reflection helpers below:
// the pre-baked record/scalar vtables need it for their Object-level
// hasOwnProperty slot before the definition appears.
static bool as_dyn_has(void* obj, const char* key);
// Prototypes for the two Object-level queries as_dyn_call answers itself when the
// receiver has no vtable at all (a Dictionary): both are defined further below.
static bool as_dyn_enumerable(void* obj, const char* key);
static char* as_coerce_str(as_value v);
// Prototype for the heap-kind classifier (GCT_DICT/ARRAY/CUSTOM), defined with
// the Dictionary helpers below. as_dyn_call consults it to spot a Vector before
// walking a vtable a Vector does not have.
static int as_dyn_kind(void* obj);
// The Array method dispatcher (defined with the Array helpers below), taking the
// receiver as void* so this early forward declaration does not need as_array.
static as_value as_arr_call(void* a, const char* name, as_value* args, int argc);
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

// Object's own four methods -- toString / hasOwnProperty / propertyIsEnumerable /
// valueOf -- can never be found by a methods-table walk: the generated vtables keep
// them in three slots AFTER the common header, which no reflection table lists. So
// an Object-typed receiver whose class does not override them ('o.hasOwnProperty(k)',
// 'o.toString()') has to be answered here, and the same function serves the heap
// kinds that have no vtable to walk at all (a Dictionary). Measured on adl 51.4.1
// (temp/g14/DictAir.as): a record's toString is "[object Object]", a Dictionary's
// "[object Dictionary]", Vector.<int>(3) is "0,0,0" (join with a comma);
// hasOwnProperty / propertyIsEnumerable are the same walks as_dyn_get uses, and
// valueOf() is the receiver itself.
static as_value as_dyn_object_builtin(void* obj, int dk, const char* name, as_value* args, int argc) {
    if (name == NULL) return as_v_null();
    if (strcmp(name, "hasOwnProperty") == 0)
        return as_v_bool(as_dyn_has(obj, argc > 0 ? as_coerce_str(args[0]) : NULL));
    if (strcmp(name, "propertyIsEnumerable") == 0)
        return as_v_bool(as_dyn_enumerable(obj, argc > 0 ? as_coerce_str(args[0]) : NULL));
    if (strcmp(name, "valueOf") == 0) return as_v_obj(obj);
    if (strcmp(name, "toString") == 0) {
        if (dk == 3 && as_vec_call_hook != NULL) {
            as_value sep[1];
            sep[0] = as_v_str((char*)",");
            return as_vec_call_hook(obj, "join", sep, 1);
        }
        // as_obj_to_str knows an Array and a Dictionary by heap kind; any other
        // vtable-less body has no text form to give here.
        if (as_has_vtable(obj) || dk == 1) return as_v_str(as_obj_to_str(obj));
        return as_v_null();
    }
    return as_v_null();
}
// Dynamically invoke a method by name on any object, walking the vtable super
// chain to find the first method-reflection table (if any) that declares it.
// Returns as_v_null() when the object is NULL or has no such method.
static as_value as_dyn_call(void* obj, const char* name, as_value* args, int argc) {
    if (obj == NULL) return as_v_null();
    int dk = as_dyn_kind(obj);
    // A monomorphized Vector has no vtable (its first word is its mark callback),
    // so the super-chain walk below would dereference garbage. Route every
    // dynamic call on one to the generated per-specialization dispatcher.
    if (as_vec_call_hook != NULL && dk == 3) {
        as_value rv = as_vec_call_hook(obj, name, args, argc);
        if (rv.tag != 0) return rv;
        // A Vector answers its own methods (join / push / slice ...) but inherits
        // Object's four (measured: Vector.<int>(3).toString() is "0,0,0").
        return as_dyn_object_builtin(obj, dk, name, args, argc);
    }
    // Neither does an Array (its first word is the element buffer):
    // 'var o:Object = [1,2,3]' followed by 'o.push(4)', 'o.join("-")' or
    // 'o.toString()' walked the elements as a vtable header and segfaulted (G14).
    // Same dispatcher the '*' receiver already used (as_any_call's tag-6 branch).
    if (dk == 2) return as_arr_call(obj, name, args, argc);
    // A Dictionary has no vtable either (its first word is the pair buffer), so the
    // walk below would dereference it as one: 'var o:Object = new Dictionary();
    // o.toString()' segfaulted. Object's own four methods answer by heap kind.
    if (!as_has_vtable(obj)) return as_dyn_object_builtin(obj, dk, name, args, argc);
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
    //
    // Object's four inherited methods are answered first, and only when the receiver
    // has NO dynamic property of that name (AS3: an own dynamic member shadows the
    // prototype method). Order matters for the sealed/boxed kinds: as_dyn_get on a
    // boxed Number THROWS #1069 rather than answering null, so asking it first broke
    // 'var o:Object = 5; o.toString()' (examples/object-array-identity.as section L).
    if (name != NULL && !as_dyn_has(obj, name)) {
        as_value b = as_dyn_object_builtin(obj, dk, name, args, argc);
        if (b.tag != 0) return b;
    }
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
// The forward declarations needed by as_v_str_val's Class-value branch below: a
// Class value is a static as_class object (never GC-allocated), so it is
// recognised by registry identity (as_v_is_class) rather than by tag alone.
// as_class_fqn_of_ptr answers that same value's OWN name -- never its instance
// vtable's, which the core classes (int/uint/Array) do not even have -- and
// as_class_display_name renders the '[class X]' text AIR prints for it.
static bool as_v_is_class(as_value v);
static const char* as_class_fqn_of_ptr(void* p);
static as_value as_v_class_by_name(const char* name);  // registry lookup by name
static char* as_str_concat_n(int, const char**);
// AIR's Class-value toString: '[class <short name>]', the tail of the fqn after its
// last ':'/'.' -- trace(BitmapData) prints '[class BitmapData]' (measured on adl
// 51.4.1). Shared by as_v_str_val and as_obj_to_str so a Class value in an Object
// slot and a bare Class value render identically.
static char* as_class_display_name(const char* fqn) {
    if (fqn == NULL) fqn = "Class";
    const char* last = fqn;
    for (const char* p = fqn; *p != 0; p++) { if (*p == ':' || *p == '.') last = p + 1; }
    const char* parts[3];
    parts[0] = "[class ";
    parts[1] = last;
    parts[2] = "]";
    return as_str_concat_n(3, parts);
}
static char* as_v_str_val(as_value v) {
    switch (v.tag) {
        // A boxed String can carry the AS3 null String (C NULL) -- as_v_str
        // normalises at the boxing site, but a hand-built as_value can still be
        // tag 3 with a null ptr. The DISPLAY form is what reaches printf("%s"),
        // and ucrt kills the process with 0xC0000409 on a null %s, so normalise
        // here too (ES3 ToString(null) is the text "null").
        case 3: return v.ptr != NULL ? (char*)v.ptr : (char*)"null";
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
                return as_class_display_name(as_class_fqn_of_ptr(v.ptr));
            }
            // Class instances and object literals stringify through the same
            // virtual-toString path as any other object: 'a' + arr[0] must call
            // an override (AIR); a plain object renders '[object Object]'.
            return as_obj_to_str(v.ptr);
        }
        case 5: return "undefined";
        case 6: return as_arr_to_str(v.ptr);
        case 7: return "function Function() {}";
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
// AIR's "x is int" / "x is uint" are VALUE-RANGE tests, not type identity
// (measured on adl 51.4.1, temp/rtprobe2/Lit.as): an int 5 is BOTH int and uint;
// an int -1 is int but not uint; a uint 5 is both; a Number 5 is both; a Number
// 5.5 is NEITHER; 2^32 is not uint; null is neither. A star-typed operand behaves
// the same way (star3e9 is uint=true / is int=false). Folding on the static C type
// therefore disagreed with AIR on every one of those forms.
static bool as_num_is_int32(double v) { return v == floor(v) && v >= -2147483648.0 && v <= 2147483647.0; }
static bool as_num_is_uint32(double v) { return v == floor(v) && v >= 0.0 && v <= 4294967295.0; }
static bool as_v_is_int32(as_value v) { return as_v_is_number(v) && as_num_is_int32(as_v_to_number(v)); }
static bool as_v_is_uint32(as_value v) { return as_v_is_number(v) && as_num_is_uint32(as_v_to_number(v)); }
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
    if (v.tag != 4) return false;
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
    // An OBJECT compared to a primitive goes through ToPrimitive (ES3 11.9.3):
    // string-hint vs a String, number-hint vs a Number/Bool, and FALSE vs
    // null/undefined (no coercion). Measured on adl 51.4.1 (temp/qfix/gcadl):
    // ({})=="[object Object]" is true, ({})=0 is false, a class with toString
    // "42" == 42 is true.
    if (a.tag == 4 && b.tag == 3) return strcmp(as_obj_to_str(a.ptr), (char*)b.ptr) == 0;
    if (b.tag == 4 && a.tag == 3) return strcmp(as_obj_to_str(b.ptr), (char*)a.ptr) == 0;
    if (a.tag == 4 && bn) return as_obj_to_number(a.ptr) == as_v_to_number(b);
    if (b.tag == 4 && an) return as_obj_to_number(b.ptr) == as_v_to_number(a);
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
// Function.length. kind 2 is a static FIELD/const: addr points at the C slot the
// field lives in and slot names that slot's C kind (see as_class_static_read /
// as_class_static_write), so SomeClass[expr] can read AND write a declared
// static by name at run time -- exactly the lookup AIR performs there (measured on
// adl 51.4.1, temp/classprobe: c.nope -> undefined while a real static field
// reads its value). kind 3 is a COMPUTED static (getter/setter pair): there is no
// C slot, so fn holds a boxed-args thunk that INVOKES the getter and boxes its
// result -- AIR resolves the name and calls the accessor (measured on adl 51.4.1,
// temp/adlprobe/adl.txt section 1: a Class value static getter reads its value, and
// NativeApplication_get_nativeApplication_static is exactly this shape). A name
// that is not a static member at all stays undefined.
typedef struct {
    const char* name;
    int kind;
    as_value (*fn)(void* env, as_value* args, int argc);
    int arity;
    void* addr;
    int slot;
    // The declaring class's static initializer (NULL when it has none): the same
    // X_cinit() a direct C read/write sequences first, so a name-looked-up static
    // never observes its slot before the initializer ran.
    void (*cinit)(void);
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
    // Non-NULL when this Class value denotes an INTERFACE rather than a class: the
    // interface's C FQN, which is the key as_iface_lookup searches the object's
    // interface list for. An interface has no instance vtable and no constructor,
    // so vtable/factory stay NULL and 'x is <ifaceClassValue>' takes the name
    // route instead of the super-chain walk (measured on adl 51.4.1, temp/gprobe
    // B3-B10: new Sprite() is cIE true, {} is cIE false, 5 as cIE null).
    const char* iface;
    // Non-NULL when this Class value denotes one Vector.<T> SPECIALIZATION:
    // its reflect name (__AS3__.vec::Vector.<int>). A vector has no vtable (its
    // first word is the element buffer / mark pointer), so 'x is <vecClassValue>'
    // compares reflect names through as_vec_is_name -- the same strict, exact
    // element-type test the static form uses (measured: temp/gprobe C3-C10).
    const char* vecfqn;
} as_class;

// x as Class for a BOXED operand: keep the value when it really is a class
// reference, else null (measured on adl 51.4.1: Object(Foo) as Class is Foo,
// 5 as Class and null as Class are null). The ordinary object cast cannot be
// used: a Class value is a static as_class object whose first word is the INSTANCE
// vtable of a DIFFERENT class, and Class itself appears in no instance's vtable
// chain, so a subtype test would answer null for every class reference (that is
// also why the is-Class operator uses registry identity). as_v_is_class is
// declared in the preamble ahead of this helper.
static as_value as_val_as_class(as_value v) {
    return as_v_is_class(v) ? v : as_v_null();
}

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

// class X extends Array instances (stage 136) through a DYNAMIC receiver: the
// instance is an ordinary class instance whose elements live in a hidden backing
// array, so a star-typed receiver still has to see the Array side of the object
// (var b:* = new Seq(); b.length, b[0], b["foo"] = v, "0" in b). The generated
// as_arrback_wire() installs one hook that maps an instance to its backing array
// by class fqn and answers NULL for every other receiver, so the dynamic paths
// (as_any_length / as_dyn_get / as_dyn_set / as_dyn_has / as_dyn_del) try it
// LAST -- after the declared fields/getters/setters the object exposes, which is
// exactly AVM2's lookup order (a real trait wins over the Array property map).
static as_array* (*as_arrback_hook)(void* obj) = NULL;
// True when obj is one of those instances, so the sealed-class error paths can
// tell "no such property on an Array subclass" from the sealed-class error.
static bool as_arrback_is(void* obj) {
    return obj != NULL && as_arrback_hook != NULL && as_arrback_hook(obj) != NULL;
}
// Keyed read on an Array (canonical index, "length", or a named property);
// forward-declared here because as_dyn_get reaches it before its definition.
static as_value as_array_key_get(as_array* a, const char* key);

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

// Unimplemented-API report (阶段一百三十六). A shell class exists so the AIR surface
// a real project imports still COMPILES, but this build has no backend behind it:
// every shell method body is a no-op returning the type's zero value. The same
// helper reports an individual member of a REAL built-in that has no
// implementation here (a mask that is stored but never applied, a file dialog
// that cannot open, System.setClipboard). Silence would be a semantic lie, so the
// first few such calls name themselves on stderr (isSupported is false and the
// API-shape members are real, so a program that checks before it calls never gets
// here). Capped so a hot path cannot flood the log; the point is to make the gap
// visible, not to narrate it.
static int as_shell_warn_count = 0;
static void as_shell_unsupported(const char* what) {
    if (as_shell_warn_count >= 5) return;
    as_shell_warn_count++;
    fprintf(stderr, "[as3-aot] not implemented by this build: %s\\n", what);
}

// Resolution probe for a dynamic method call: does the object have a METHOD or a
// Function-valued dynamic member under that name? This mirrors as_dyn_call's walk (the
// per-class method reflection tables along the super chain, a Proxy interceptor,
// then the dynamic property record) WITHOUT invoking anything, so a caller can tell
// "no such member exists" -- a reportable gap -- from "the member ran and returned
// null". The Vector/ByteArray dispatch hooks are deliberately not consulted: they
// are only reachable through a statically star-typed receiver, which never asks this
// question.
static bool as_dyn_has_method(void* obj, const char* name) {
    if (obj == NULL) return false;
    void* vt = ((as_object_header*)obj)->vtable;
    while (vt != NULL) {
        as_method* methods = (as_method*)((as_vtable_header*)vt)->methods;
        if (methods != NULL) {
            for (int i = 0; methods[i].name != NULL; i++) {
                if (strcmp(methods[i].name, name) == 0) return true;
            }
        }
        vt = ((as_vtable_header*)vt)->super;
    }
    if (((as_vtable_header*)((as_object_header*)obj)->vtable)->is_proxy) return true;
    return as_dyn_get(obj, name).tag == 7;
}

// Call a member of a dynamic-class receiver whose name is not statically known.
// AIR resolves such a name at run time (MovieClip is declared dynamic in AIR, and
// every SWC timeline symbol is a MovieClip subclass), so a name the static type does
// not declare is normally dispatched to the RUNTIME class -- a real method declared
// by a subclass the static type cannot see, or a Function held in the object's
// dynamic record. That dispatch happens here; what is left is the case where nothing
// matches, and that is not "the program is wrong" but "this build cannot see it":
// a timeline symbol's own ActionScript lives in the library's DoABC
// (docs/zh-cn/swc.md section 3.3 -- out of scope for the baker). Reported loudly
// (capped) instead of failing silently; AIR would throw #1069 in the same situation,
// so the caller still receives undefined.
static as_value as_dyn_call_reporting(void* obj, const char* name, const char* label, as_value* args, int argc) {
    as_value r = as_dyn_call(obj, name, args, argc);
    if (r.tag == 0 && !as_dyn_has(obj, name) && !as_dyn_has_method(obj, name)) as_shell_unsupported(label);
    return r;
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
// NOTE (阶段一百四十七): during a sliced cycle gc_alloc hands out blocks that are
// already BLACK and stops scanning them, so a reference written into a fresh
// array is only reachable if the WRITE went through the barrier -- filling a new
// array without one loses every element that is not also reachable elsewhere.
static as_array* as_array_make(int n, as_value* items) {
    as_array* a = (as_array*)gc_alloc(GCT_ARRAY, sizeof(as_array));
    a->length = n;
    a->capacity = n;
    a->data = n > 0 ? (as_value*)gc_alloc(GCT_VALUE_ARRAY, sizeof(as_value) * (size_t)n) : NULL;
    for (int i = 0; i < n; i++) { a->data[i] = items[i]; gc_write_barrier_value(items[i]); }
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
// arguments follow. The uniform method thunk PACKS the rest parameter itself, so
// what it must receive is the FLAT argument list (name followed by a0, a1, ...). Building
// the packed Array here instead (the previous shape) made the thunk wrap that
// already-packed Array into a one-element Array, so an interceptor reading
// rest.length saw 1 where adl reports the real count (caught by examples/proxy.as,
// "dotted call routes to callProperty").
static as_value as_proxy_call(void* obj, const char* mname, as_value* args, int argc) {
    as_value buf[8];
    as_value* callArgs = buf;
    if (argc + 1 > (int)(sizeof(buf) / sizeof(buf[0]))) {
        // A proxy call with 8+ arguments is rare enough to take the arena (the
        // runtime's program-lifetime allocator), like every other persistent-shape
        // allocation; nothing here is a per-frame path.
        callArgs = (as_value*)as_alloc(sizeof(as_value) * (size_t)(argc + 1));
    }
    callArgs[0] = as_v_str((char*)mname);
    for (int i = 0; i < argc; i++) callArgs[i + 1] = args[i];
    as_value out;
    if (as_proxy_invoke(obj, "callProperty", callArgs, argc + 1, &out)) return out;
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
    // A missing index is AIR's undefined, not null: 'var e:*=[1,2,3,4]; e.length=2;
    // e[3]' is undefined (=== undefined true, == null true) and 'x' + e[3] is
    // "xundefined" (measured on adl 51.4.1, temp/qfix/gcadl/arrMain.as).
    if (i < 0 || i >= a->length) return as_v_undefined();
    return a->data[i];
}
static as_value as_array_set(as_array* a, int i, as_value v) {
    if (i < 0) return v;
    as_array_ensure(a, i + 1);
    // 索引跳跃写入留下的**空槽**必须是 undefined（tag 5），不是 gc_alloc 清零的
    // tag 0（null）：'var a=[]; a[10]=1; 4 in a' 在 adl 51.4.1 上是 false，而 tag 0
    // 会让 as_array_has（判据是 tag != 5）把它当成「在」。同理 'a[4] === undefined'
    // 在 AIR 上是 true、'a[4] === null' 是 false（temp/sortprobe/）。新槽不持指针，
    // 不需要写屏障。
    for (int j = a->length; j < i; j++) { as_value u = {5, 0.0, NULL}; a->data[j] = u; }
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
    // Popping an empty array is undefined in AIR (temp/qfix/gcadl/arrMain.as).
    if (a->length == 0) return as_v_undefined();
    return a->data[--a->length];
}
static as_value as_array_shift(as_array* a) {
    if (a->length == 0) return as_v_undefined();
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
    // A statically Array-typed expression can still hold AS3 null (a property that
    // was never assigned, SQLResult.data for a statement with no rows), and string
    // concatenation must then produce String(null) == "null" rather than fault on
    // a null receiver.
    if (a == NULL) return (char*)"null";
    // A String-typed separator can be the AS3 null string (C NULL); AIR stringifies
    // it as "null" (adl 51.4.1: String s = null; [1,2].join(s) -> "1null2"), and
    // the strlen below would fault on it.
    if (sep == NULL) sep = "null";
    if (a->length == 0) return (char*)"";
    // A null/undefined ELEMENT contributes the empty string to join(), unlike
    // String(null)/String(undefined) which yield "null"/"undefined" (ES3 15.4.4.5;
    // adl 51.4.1 measured: [1,undefined,2].join('-') = [1--2], [null,1].toString()
    // = ",1", while String(undefined) = "undefined"). as_v_str_val cannot be used
    // for elements -- it is the general-purpose stringifier -- so join special-cases
    // the two tags here.
    // Two passes: first measure total length, then copy with a running pointer.
    // This avoids a temporary parts array (one less malloc per join) and stays
    // O(n); strcat would re-scan from the start each time and become O(n^2).
    size_t total = 0;
    for (int i = 0; i < a->length; i++)
        total += (a->data[i].tag == 0 || a->data[i].tag == 5) ? 0 : strlen(as_v_str_val(a->data[i]));
    size_t seplen = strlen(sep);
    char* r = as_str_alloc(total + seplen * (a->length - 1) + 1);
    char* p = r;
    for (int i = 0; i < a->length; i++) {
        if (i > 0) { memcpy(p, sep, seplen); p += seplen; }
        if (a->data[i].tag == 0 || a->data[i].tag == 5) continue;
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
    // 'class X extends Array' through a '*' receiver: the Array side's length.
    if (v.tag == 4 && v.ptr != NULL && as_arrback_hook != NULL) {
        as_array* ab = as_arrback_hook(v.ptr);
        if (ab != NULL) return ab->length;
    }
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
    // The inserted items are new references into an array that may already be
    // marked (see as_array_make): the barrier is what keeps them alive.
    for (int i = 0; i < itemCount; i++) { a->data[start + i] = items[i]; gc_write_barrier_value(items[i]); }
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
// argument layout; every sort flavor (string default / numeric / custom
// function / sortOn field) shares one stable merge core.
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

// ---------- 排序：稳定归并 + Array 的五个选项位 ----------
//
// 选项位与 Array.* 常量一致（emit.ts 的 emitArrayConst 同源）。adl 51.4.1 实测
// （temp/sortprobe/，Main.as + Main2.as + Main3.as + Main4.as）：
//   CASEINSENSITIVE  1  只折 ASCII 大小写
//   DESCENDING       2  反向比较（不是「排完再 reverse」）
//   UNIQUESORT       4  有重复键 ⇒ 返回 Number 0 且**数组一个字节都不动**
//   RETURNINDEXEDARRAY 8  返回下标表、原数组不动；稀疏槽的下标排在最后
//   NUMERIC          16 按数值比较；sort 遇到转不成数值的值抛 #1034，
//                       sortOn 不抛（按 NaN 参与比较，实测 keys=9 10 a B）
//   32 与其余未知位无效果（sort(32) 与 sort(0) 逐字相同）。
// 这五个位在旧实现里被整个丢掉（sort 只看「参数是不是 Function」，否则一律按
// NUMERIC 或按字符串），是 sort.ci 在一个 8 元素数组上就与 AIR 分叉的根因。
//
// 稳定归并（自底向上）。
//
// 为什么必须稳定：AS3 的 Array.sort / sortOn 是稳定排序（AIR 内部走归并），
// 「相等键保持原相对次序」是作者依赖的语义 —— 先按名字排、再按时间 sortOn 这种
// 二级排序完全靠它。所以不能换 qsort/快排（不稳定）。
//
// 为什么不能是插入排序：它是 O(n^2)。实测（Bench3，存活态、外部看门狗零「未响应」）
// n 每翻倍单元素成本也翻倍，是二次方的指纹：
//   sort(Array.NUMERIC)  n=1000 0.66ms -> n=2000 2.58 -> n=4000 10.8 -> n=8000 43.1ms
//   sortOn("k",NUMERIC)  n=250  0.62 -> n=500 2.75 -> n=1000 12.6 -> n=2000 62.2ms
// 外推到 n=50000：归并 ~3ms，插入排序 ~39s，而且它跑在单个 ENTER_FRAME 里 —— 那就是
// 18:16 Bench2.exe 被 Windows 判 App Hang（事件 1002）关掉的直接原因，也是
// 「打开参会人/文件/聊天列表就卡一下」的形状。
//
// 缓冲全走裸 malloc 的 as_value/int 数组，不参与 GC 扫描。GC 不搬动对象本体（见
// gc_alloc 契约），但比较器是用户 AS3 代码，它可能 push/splice 同一个数组而使
// a->data 被 realloc，所以每次比较都重新读 a->data，我们自己持有的只有下标表。
#define AS_SORT_CI      1
#define AS_SORT_DESC    2
#define AS_SORT_UNIQUE  4
#define AS_SORT_INDEXED 8
#define AS_SORT_NUMERIC 16

// as_throw_1034 由 emitSealedPropErrors() 在类体区无条件发射（它在 preamble 之后），
// 这里只要原型。NUMERIC 排序的报错文案必须与 AIR 逐字一致。
static void as_throw_1034(as_value v, const char* fqn);

// 大小写不敏感比较只折 ASCII A-Z：AIR 的 CASEINSENSITIVE 只承诺拉丁字母等价，
// 我们不复刻 ICU 的 locale 折叠（那需要一张表，且 AIR 的表现随宿主 locale 变）。
static int as_lower_ascii(int c) { return (c >= 'A' && c <= 'Z') ? c + 32 : c; }
static int as_str_cmp_ci(const char* x, const char* y) {
    while (*x != '\0' && *y != '\0') {
        int a = as_lower_ascii((unsigned char)*x);
        int b = as_lower_ascii((unsigned char)*y);
        if (a != b) return a < b ? -1 : 1;
        x++; y++;
    }
    if (*x != '\0') return 1;
    if (*y != '\0') return -1;
    return 0;
}

// 一次排序的全部参数：选项位 + sortOn 的字段名 + sort(compareFunction) 的比较器。
// field != NULL 表示 sortOn（键要从元素上反射取），cb != NULL 表示自定义比较器。
typedef struct { int flags; const char* field; as_fn cb; } as_sort_ctx;

static int as_cmp_opts(as_value a, as_value b, void* ctx) {
    as_sort_ctx* c = (as_sort_ctx*)ctx;
    as_value va = a, vb = b;
    if (c->field != NULL) {
        va = as_dyn_get(as_v_obj_val(a), c->field);
        vb = as_dyn_get(as_v_obj_val(b), c->field);
    }
    int r;
    if (c->cb != NULL) {
        r = as_cmp_cb(va, vb, (void*)c->cb);
    } else if ((c->flags & AS_SORT_NUMERIC) != 0) {
        double na = as_v_to_number(va);
        double nb = as_v_to_number(vb);
        // NaN 在 adl 上排在所有数值**之后**（升序）：[NaN,1].sort(NUMERIC) 得
        // 1,NaN，sortOn("k",NUMERIC) 把转不成数值的字段全放在末尾。这不是
        // 「NaN 与谁都相等」——那样稳定归并会原序不动，整组留在原位。
        if (isnan(na)) r = isnan(nb) ? 0 : 1;
        else if (isnan(nb)) r = -1;
        else r = (na < nb) ? -1 : (na > nb) ? 1 : 0;
    } else if ((c->flags & AS_SORT_CI) != 0) {
        r = as_str_cmp_ci(as_v_str_val(va), as_v_str_val(vb));
    } else {
        r = strcmp(as_v_str_val(va), as_v_str_val(vb));
    }
    return ((c->flags & AS_SORT_DESC) != 0) ? -r : r;
}

// NUMERIC 的严格口径只对 Array.sort 生效（sortOn 不抛，实测）。AIR 在比较时做
// ToNumber：Number/Boolean/null/可解析字符串（含 "0x10"、前后空白）通过，
// undefined / 对象 / 数组 / 函数 / "12abc" / "NaN" 抛 TypeError #1034。
// AIR 的报错点名的是它内部算法先碰到的那个元素（["a","B"] 报 "B"），我们按
// 数组顺序预检 —— 确定性优先，文案本身与 AIR 逐字一致。
static void as_sort_check_numeric(as_array* a) {
    for (int i = 0; i < a->length; i++) {
        as_value v = a->data[i];
        int ok;
        switch (v.tag) {
            case 0: case 1: case 2: case 8: case 9: ok = 1; break;
            case 3: ok = (v.ptr != NULL) && !isnan(as_str_to_number((const char*)v.ptr)); break;
            default: ok = 0; break;
        }
        if (!ok) as_throw_1034(v, "Number");
    }
}

// 稳定归并（自底向上），排序对象是「已定义元素的下标序列」而不是值本身：
// ① RETURNINDEXEDARRAY 的输出就是这趟结果；② 写回时不会与「比较器改了数组」
// 打架。比较器的 <=0 取左边，这就是稳定性的来源（相等键不交换）。
static void as_sort_order(int* ord, int* aux, int k, as_array* a, as_cmp_fn cmp, void* ctx) {
    int in_aux = 0;
    for (int width = 1; width < k; width *= 2) {
        int* src = in_aux ? aux : ord;
        int* dst = in_aux ? ord : aux;
        for (int i = 0; i < k; i += width * 2) {
            int lo = i;
            int mid = (i + width < k) ? i + width : k;
            int hi = (i + width * 2 < k) ? i + width * 2 : k;
            int p = lo, q = mid, t = lo;
            while (p < mid && q < hi) {
                dst[t++] = (cmp(a->data[src[p]], a->data[src[q]], ctx) <= 0) ? src[p++] : src[q++];
            }
            while (p < mid) dst[t++] = src[p++];
            while (q < hi)  dst[t++] = src[q++];
        }
        in_aux = !in_aux;
    }
    if (in_aux) memcpy(ord, aux, (size_t)k * sizeof(int));
}

// 排序核心。**稀疏槽**（tag 5 的洞）的口径来自 adl 51.4.1 实测：排序只搬已定义
// 的元素，把它们压实到前部，长度不变、尾部一律变成洞 ——
//   var a=[5,4,3]; a[10]=1; a.sort();  ⇒ join "1,3,4,5,,,,,,,"、4 in a 为 false
// （旧实现把 11 个槽一起排，于是 4 in a 为 true，且洞被搬到中间）。
// 洞之间按「undefined」参与 UNIQUESORT：≥2 个洞即算重复（1 个洞不算，实测）。
static as_value as_array_sort_ex(as_array* a, as_sort_ctx* ctx) {
    int n = a->length;
    if (n == 0) {
        if ((ctx->flags & AS_SORT_INDEXED) != 0) return as_v_arr((void*)as_array_new());
        return as_v_arr((void*)a);
    }
    if (ctx->field == NULL && ctx->cb == NULL && (ctx->flags & AS_SORT_NUMERIC) != 0)
        as_sort_check_numeric(a);
    int* ord = (int*)malloc((size_t)n * sizeof(int));
    int* aux = (int*)malloc((size_t)n * sizeof(int));
    as_value* vals = (as_value*)malloc((size_t)n * sizeof(as_value));
    if (ord == NULL || aux == NULL || vals == NULL) {
        // 分配失败：先压实，再做插入排序 —— 慢但语义一致（稳定性不变），
        // 不能因为分配失败而改变排序结果。UNIQUE/INDEXED 在这种规模下退化
        // 成「就地排」，是既有行为，不额外伪造返回值。
        free(ord); free(aux); free(vals);
        int k = 0;
        for (int i = 0; i < n; i++)
            if (a->data[i].tag != 5) a->data[k++] = a->data[i];
        for (int i = 1; i < k; i++) {
            as_value key = a->data[i];
            int j = i - 1;
            while (j >= 0 && as_cmp_opts(a->data[j], key, ctx) > 0) { a->data[j + 1] = a->data[j]; j--; }
            a->data[j + 1] = key;
        }
        for (int i = k; i < n; i++) { as_value u = {5, 0.0, NULL}; a->data[i] = u; }
        return as_v_arr((void*)a);
    }
    int k = 0;
    for (int i = 0; i < n; i++) if (a->data[i].tag != 5) ord[k++] = i;
    if (k > 1) as_sort_order(ord, aux, k, a, as_cmp_opts, ctx);
    if ((ctx->flags & AS_SORT_UNIQUE) != 0) {
        int dup = (n - k) >= 2;
        for (int i = 1; i < k && !dup; i++)
            if (as_cmp_opts(a->data[ord[i - 1]], a->data[ord[i]], ctx) == 0) dup = 1;
        if (dup) { free(ord); free(aux); free(vals); return as_v_num(0); }
    }
    if ((ctx->flags & AS_SORT_INDEXED) != 0) {
        as_array* r = as_array_new();
        for (int i = 0; i < k; i++) as_array_push(r, as_v_num((double)ord[i]));
        for (int i = 0; i < n; i++) if (a->data[i].tag == 5) as_array_push(r, as_v_num((double)i));
        free(ord); free(aux); free(vals);
        return as_v_arr((void*)r);
    }
    // 就地写回：ord 是原下标的一个置换，直接写会覆盖还没读的源 ⇒ 先取快照。
    for (int i = 0; i < k; i++) vals[i] = a->data[ord[i]];
    for (int i = 0; i < k; i++) a->data[i] = vals[i];
    for (int i = k; i < n; i++) { as_value u = {5, 0.0, NULL}; a->data[i] = u; }
    free(ord); free(aux); free(vals);
    return as_v_arr((void*)a);
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

// sort()：三种形态共用一个稳定归并核心。默认按字符串排（AS3），Array.NUMERIC 按数值，
// 传 Function 则作比较器。
// 静态发射入口。flags 已知不含 UNIQUESORT 时用 *_arr（返回 as_array*，保持调用点
// 的数组静态类型）；含或未知时用 *(_flags/_v) 的装箱版，因为 UNIQUESORT 命中重复
// 会返回 Number 0（adl 实测：var r:Array = a.sort(4) 于是抛 #1034，var q:* 得到 0）。
static as_value as_array_sort_flags(as_array* a, int options) {
    as_sort_ctx ctx;
    ctx.flags = options; ctx.field = NULL; ctx.cb = NULL;
    return as_array_sort_ex(a, &ctx);
}
static as_array* as_array_sort_arr(as_array* a, int options) {
    as_value r = as_array_sort_flags(a, options);
    return (as_array*)as_v_obj_val(r);
}
// sort(x) 的 x 静态类型是 '*': 运行期才知道它是比较器还是选项位（AIR 同样按
// 「是不是 Function」分流）。静态已知是函数的分支由发射器直接走 as_array_sort_cb。
static as_value as_array_sort_any(as_array* a, as_value v) {
    if (v.tag == 7) {
        as_sort_ctx ctx;
        ctx.flags = 0; ctx.field = NULL; ctx.cb = (as_fn)v.ptr;
        return as_array_sort_ex(a, &ctx);
    }
    return as_array_sort_flags(a, as_v_to_int(v));
}
static as_array* as_array_sort_str(as_array* a) { return as_array_sort_arr(a, 0); }
static as_array* as_array_sort_num(as_array* a) { return as_array_sort_arr(a, AS_SORT_NUMERIC); }
static as_array* as_array_sort_cb(as_array* a, as_fn cb) {
    as_sort_ctx ctx;
    ctx.flags = 0; ctx.field = NULL; ctx.cb = cb;
    return (as_array*)as_v_obj_val(as_array_sort_ex(a, &ctx));
}

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
    void* getters; void* setters; int dyn_offset; const char* fqn; int is_proxy; int is_dynamic; int is_final;
    char* (*toString)(void*);
    bool (*hasOwnProperty)(void*, char*);
    bool (*propertyIsEnumerable)(void*, char*);
} as_object_vtable;

static bool as_object_own_has_own_property(void* _this, char* name) {
    if (_this == NULL || name == NULL) return false;
    return as_dyn_has(_this, (const char*)name);
}
// The pre-baked vtables below need this slot before as_dyn_enumerable is defined;
// the definition is the runtime walk documented further down.
static bool as_dyn_enumerable(void* obj, const char* key);
static bool as_object_own_enumerable(void* _this, char* name) {
    return as_dyn_enumerable(_this, (const char*)name);
}
static char* as_object_box_to_str(void* o) { return as_obj_default_str(o); }
// Boxed scalars know their own text; defined next to their structs below.
static char* as_number_box_to_str(void* o);
static char* as_string_box_to_str(void* o);

static as_object_vtable as_object_vt = { "Object", NULL, NULL, NULL, NULL, NULL, NULL, -1, "Object", 0, 1, 0, as_object_box_to_str, as_object_own_has_own_property, as_object_own_enumerable };

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

static as_object_vtable as_number_vt = { "Number", &as_object_vt, NULL, NULL, NULL, NULL, NULL, -1, "Number", 0, 1, 0, as_number_box_to_str, as_object_own_has_own_property, as_object_own_enumerable };

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

static as_object_vtable as_string_vt = { "String", &as_object_vt, NULL, NULL, NULL, NULL, NULL, -1, "String", 0, 1, 0, as_string_box_to_str, as_object_own_has_own_property, as_object_own_enumerable };

static as_string* as_string_new(char* value) {
    // AS3 converts the VALUE null to Object as null, not as a String wrapper
    // (measured on adl 51.4.1, temp/apv/adl: assigning a null String to an Object
    // slot gives an Object that is null). Boxing NULL produced a non-NULL object, so
    // a plain truthiness test answered true where AIR answers false -- the same
    // defect class as as_function_new below (talkmed-meeting called a null loader
    // callback and died on an uncaught TypeError #1006).
    if (value == NULL) return NULL;
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

// String()/toString() of ANY function value is the constant "function Function() {}"
// on AIR -- measured on adl 51.4.1 for a builtin (unescape), a method closure and an
// anonymous closure alike (temp/apv/adl). The generic box form gave "[object
// Function]", and a bare boxed function value rendered "[Function]" (as_v_str_val
// tag 7); both now answer the AIR constant.
static char* as_function_box_to_str(void* o) { (void)o; return "function Function() {}"; }

static as_object_vtable as_function_vt = { "Function", &as_object_vt, NULL, NULL, NULL, NULL, NULL, -1, "Function", 0, 1, 0, as_function_box_to_str, as_object_own_has_own_property, as_object_own_enumerable };

static as_function* as_function_new(as_fn value) {
    // Null-preserving, exactly like as_string_new above: assigning a null Function to
    // an Object slot is null on AIR (adl 51.4.1, temp/apv/adl). Wrapping a null
    // closure made the guard in talkmed-meeting's TKAppUpdate.loadComplete take the
    // true branch and call a function that is not there (uncaught TypeError #1006).
    if (value == NULL) return NULL;
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

static char* as_boolean_box_to_str(void* o) { return as_str_from_bool(((as_boolean*)o)->value); }

static as_object_vtable as_boolean_vt = { "Boolean", &as_object_vt, NULL, NULL, NULL, NULL, NULL, -1, "Boolean", 0, 1, 0, as_boolean_box_to_str, as_object_own_has_own_property, as_object_own_enumerable };

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
    char* text;                 // element: its direct text content, concatenated;
                                // text node: its own value (may be "")
    int cdata;                  // text node came from <![CDATA[...]]> (markup only)
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

// Dynamic stringification of an XML/XMLList value must yield its E4X string value,
// not "[object XML]". A statically-typed String assignment from an XML already goes
// through as_xml_string_value (emit), but a value that travels through a dynamic slot --
// Object, *, an Array element, a Dictionary value, a dynamic property -- lands in
// vtable->box_to_str instead. talkmed-meeting stores its localized labels as XML
// and resolves them dynamically, so every label on the login page rendered
// "[object XML]" (measured on adl 51.4.1, temp/xmlstr3 + temp/apv/adl: String(xml),
// ""+xml, [xml], [xml] joined, {k:xml}.k and xml-through-an-Object-parameter all
// print the text). Both helpers are defined below, next to the E4X string value.
static char* as_xml_box_to_str(void* o);
static char* as_xml_list_box_to_str(void* o);

static as_object_vtable as_xml_vt = { "XML", &as_object_vt, NULL, NULL, NULL, NULL, NULL, -1, "XML", 0, 0, 1, as_xml_box_to_str, as_object_own_has_own_property, as_object_own_enumerable };
static as_object_vtable as_xml_list_vt = { "XMLList", &as_object_vt, NULL, NULL, NULL, NULL, NULL, -1, "XMLList", 0, 0, 1, as_xml_list_box_to_str, as_object_own_has_own_property, as_object_own_enumerable };

static as_xml_node* as_xml_node_new(char* name) {
    as_xml_node* n = (as_xml_node*)gc_alloc(GCT_XML, sizeof(as_xml_node));
    n->vtable = (void*)&as_xml_vt;
    n->name = name;
    return n;
}

// A TEXT (or CDATA) node: an as_xml_node with no name, so the whole runtime can
// distinguish it from an element by n->name == NULL. The cdata flag only affects the
// MARKUP form -- nodeKind()/toString() report a CDATA section as text, exactly as
// adl 51.4.1 does -- and is what keeps <![CDATA[<b/>]]> from turning into escaped
// text when the document is serialised again.
static as_xml_node* as_xml_text_new(char* text, int cdata) {
    as_xml_node* n = as_xml_node_new(NULL);
    n->text = text;
    n->cdata = cdata;
    return n;
}

static as_xml_list* as_xml_list_new(as_xml_node** items, int length) {
    as_xml_list* l = (as_xml_list*)gc_alloc(GCT_XML_LIST, sizeof(as_xml_list));
    l->vtable = (void*)&as_xml_list_vt;
    l->items = items;
    l->length = length;
    return l;
}

// Growable list used by the general-predicate filter (emitXmlGeneralFilter): the
// constructors above all take the finished item buffer, so the selection loop needs
// an empty list to append to. Same reallocation idiom as as_array_ensure -- GC has
// no realloc, a fresh buffer is copied over and every copied pointer re-greyed so an
// object reachable only through the new block cannot be swept mid-mark.
static as_xml_list* as_xml_list_empty(void) { return as_xml_list_new(NULL, 0); }
static void as_xml_list_append(as_xml_list* l, as_xml_node* n) {
    int n2 = l->length + 1;
    as_xml_node** buf = (as_xml_node**)gc_alloc(GCT_PTR_ARRAY, (size_t)n2 * sizeof(as_xml_node*));
    for (int i = 0; i < l->length; i++) { buf[i] = l->items[i]; gc_write_barrier((void*)buf[i]); }
    buf[l->length] = n;
    gc_write_barrier((void*)n);
    l->items = buf;
    l->length = n2;
}

// new XMLList(value) -- the 1-argument E4X list constructor. Semantics measured on
// adl 51.4.1 (temp/qfix/xmllist.body.as): null/undefined -> an empty list; an XML
// node -> a one-item list holding that node; an XMLList -> a copy of its items;
// any other value -> a one-item list holding a TEXT node whose content is the
// value's string form (new XMLList(5) has length 1 and toString() "5"). A text
// node is an as_xml_node with a NULL name, so the node list itself is the
// distinction, exactly as in the parser.
static as_xml_list* as_xml_list_ctor(as_value v) {
    if (v.tag == 0 || v.tag == 5) return as_xml_list_new(NULL, 0);
    if (v.tag == 4 && v.ptr != NULL) {
        if (as_is(v.ptr, (void*)&as_xml_vt)) {
            as_xml_node** buf = (as_xml_node**)gc_alloc(GCT_PTR_ARRAY, sizeof(as_xml_node*));
            buf[0] = (as_xml_node*)v.ptr;
            return as_xml_list_new(buf, 1);
        }
        if (as_is(v.ptr, (void*)&as_xml_list_vt)) {
            as_xml_list* src = (as_xml_list*)v.ptr;
            int n = src->length;
            as_xml_node** buf = n > 0 ? (as_xml_node**)gc_alloc(GCT_PTR_ARRAY, (size_t)n * sizeof(as_xml_node*)) : NULL;
            for (int i = 0; i < n; i++) buf[i] = src->items[i];
            return as_xml_list_new(buf, n);
        }
    }
    as_xml_node* t = as_xml_text_new(as_str_dup(as_v_str_val(v)), 0);
    as_xml_node** buf = (as_xml_node**)gc_alloc(GCT_PTR_ARRAY, sizeof(as_xml_node*));
    buf[0] = t;
    return as_xml_list_new(buf, 1);
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

// ---------- character data: whitespace, entities, text runs ----------
// XML whitespace. This is the ONLY set the parser trims, and it trims because
// AIR's XML.ignoreWhitespace defaults to true (measured, temp/e4xres/): a
// whitespace-only run between elements disappears, and a run's leading/trailing
// whitespace is cut while its INNER whitespace survives ('x  y' stays 'x  y').
static int as_xml_is_ws(unsigned char c) {
    return c == ' ' || c == '\\t' || c == '\\r' || c == '\\n';
}

// UTF-8 encode one code point into out; returns the byte count (BMP only -- the
// parser never decodes anything above 0xFFFF, see as_xml_decode).
static int as_xml_utf8_put(unsigned int cp, char* out) {
    if (cp < 0x80) { out[0] = (char)cp; return 1; }
    if (cp < 0x800) {
        out[0] = (char)(0xC0 | (cp >> 6));
        out[1] = (char)(0x80 | (cp & 0x3F));
        return 2;
    }
    out[0] = (char)(0xE0 | (cp >> 12));
    out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[2] = (char)(0x80 | (cp & 0x3F));
    return 3;
}

static int as_xml_hexval(unsigned char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// Decode entity references in a length-delimited slice (TEXT and ATTRIBUTE values
// both decode -- measured). Always returns a fresh GC string, never a slice of the
// input, so callers may trim or hand the result to AS3.
//
// MEASURED on adl 51.4.1 (temp/e4xres/, 40 named probes + numeric probes):
//   * the five predefined entities decode, and so does &nbsp; -- whose code point
//     AIR reports as U+FFA0 (not U+00A0). That is an AIR quirk, reproduced here so
//     the VALUE matches the reference runtime rather than the spec.
//   * &#DDD; / &#xHHH; decode up to U+FFFF in either base (&#25991; -> 文).
//   * an UNKNOWN name stays verbatim ('&copy;' -> "&copy;", not ©), and a code
//     point above 0xFFFF also stays verbatim ('&#x1F600;' -> "&#x1F600;").
// Because unknown references survive DECODING, the serialiser must escape every
// '&' it writes or the round trip would double-decode (that is residual (3)).
static char* as_xml_decode(const char* s, int len) {
    char* out = as_str_alloc((size_t)len * 4 + 1);
    int o = 0;
    int i = 0;
    while (i < len) {
        if (s[i] != '&') { out[o++] = s[i++]; continue; }
        // A reference name is short; give up (and copy '&' verbatim) after 12.
        int j = i + 1;
        while (j < len && j - i <= 12 && s[j] != ';') j++;
        if (j >= len || s[j] != ';') { out[o++] = s[i++]; continue; }
        const char* nm = s + i + 1;
        int nl = j - i - 1;
        unsigned int cp = 0xFFFFFFFFu;
        if (nl == 3 && strncmp(nm, "amp", 3) == 0) cp = 38u;
        else if (nl == 2 && strncmp(nm, "lt", 2) == 0) cp = 60u;
        else if (nl == 2 && strncmp(nm, "gt", 2) == 0) cp = 62u;
        else if (nl == 4 && strncmp(nm, "quot", 4) == 0) cp = 34u;
        else if (nl == 4 && strncmp(nm, "apos", 4) == 0) cp = 39u;
        else if (nl == 4 && strncmp(nm, "nbsp", 4) == 0) cp = 0xFFA0u;
        else if (nl >= 2 && nm[0] == '#') {
            int base = 10;
            int k = 1;
            unsigned int v = 0;
            int ok = 1;
            if (nm[k] == 'x' || nm[k] == 'X') { base = 16; k++; }
            if (k >= nl) ok = 0;
            for (; ok && k < nl; k++) {
                int d = base == 16 ? as_xml_hexval((unsigned char)nm[k])
                                   : ((nm[k] >= '0' && nm[k] <= '9') ? nm[k] - '0' : -1);
                if (d < 0) { ok = 0; break; }
                v = v * (unsigned int)base + (unsigned int)d;
                if (v > 0x10FFFFu) { ok = 0; break; }
            }
            // Out-of-BMP and NUL stay verbatim, exactly as AIR leaves them.
            if (ok && v != 0 && v <= 0xFFFFu) cp = v;
        }
        if (cp == 0xFFFFFFFFu) { out[o++] = s[i++]; continue; }
        o += as_xml_utf8_put(cp, out + o);
        i = j + 1;
    }
    out[o] = 0;
    return out;
}

// One raw text run -> the value of a text node, or NULL when the run is DROPPED.
// Two rules, both measured (temp/e4xres/):
//   * a run that is whitespace IN THE SOURCE is pruned completely, so <a> </a>
//     serialises as <a/> and contributes no child;
//   * a run that only BECOMES whitespace after decoding KEEPS its node with an
//     EMPTY value, so <a>&#32;</a> and <a>&#10;</a> serialise as <a></a> (an
//     empty text child) rather than self-closing.
static char* as_xml_text_run(const char* s, int len) {
    int a = 0;
    int b = len;
    while (a < b && as_xml_is_ws((unsigned char)s[a])) a++;
    while (b > a && as_xml_is_ws((unsigned char)s[b - 1])) b--;
    if (a == b) return NULL;
    char* dec = as_xml_decode(s + a, b - a);
    int dl = (int)strlen(dec);
    int da = 0;
    int db = dl;
    while (da < db && as_xml_is_ws((unsigned char)dec[da])) da++;
    while (db > da && as_xml_is_ws((unsigned char)dec[db - 1])) db--;
    if (da == 0 && db == dl) return dec;
    char* t = as_str_alloc((size_t)(db - da) + 1);
    memcpy(t, dec + da, (size_t)(db - da));
    t[db - da] = 0;
    return t;
}

// Parser cursor over the raw XML text. as_xml_err records WHY a NULL return
// happened; the ids are the ones adl 51.4.1 raises, so as_xml_parse_checked can
// throw the same TypeError: 1 = malformed element (#1090), 2 = element not
// terminated (#1085, with the element's name), 3 = markup outside the root
// element (#1088). It is a FILE-level variable rather than a scanner field
// because a nested element reports the failure and every enclosing frame just
// returns NULL.
typedef struct { const char* s; int i; int n; } as_xml_sc;
static int as_xml_err = 0;
static char* as_xml_err_name = NULL;

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
// Scan a quoted attribute value (entities decoded); NULL when unterminated.
// Attribute values are NOT trimmed: adl 51.4.1 keeps "<a b=' x  y '/>" as
// b=" x  y " (temp/e4xres/), unlike text runs.
static char* as_xml_sc_attrval(as_xml_sc* sc) {
    if (sc->i >= sc->n) return NULL;
    char q = sc->s[sc->i];
    if (q != '"' && q != '\\'') return NULL;
    sc->i++;
    int start = sc->i;
    while (sc->i < sc->n && sc->s[sc->i] != q) sc->i++;
    if (sc->i >= sc->n) return NULL;
    char* r = as_xml_decode(sc->s + start, sc->i - start);
    sc->i++; // closing quote
    return r;
}

static as_xml_node* as_xml_sc_element(as_xml_sc* sc);

// Parse one element (caller has consumed nothing; *sc points at '<').
static as_xml_node* as_xml_sc_element(as_xml_sc* sc) {
    sc->i++; // '<'
    char* name = as_xml_sc_name(sc);
    if (!name) { as_xml_err = 1; return NULL; }
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
            as_xml_err = 1;
            return NULL;
        }
        // EOF inside the start tag is MALFORMED (#1090), not "unterminated":
        // adl 51.4.1 reports 'a<b' as #1090 while a complete '<a>' is #1085.
        if (c < 0) { as_xml_err = 1; return NULL; }
        char* an = as_xml_sc_name(sc);
        if (!an) { as_xml_err = 1; return NULL; }
        as_xml_sc_ws(sc);
        if (sc->i >= sc->n || sc->s[sc->i] != '=') { as_xml_err = 1; return NULL; }
        sc->i++;
        as_xml_sc_ws(sc);
        char* av = as_xml_sc_attrval(sc);
        if (!av) { as_xml_err = 1; return NULL; }
        as_xml_buf_push(&anames, (void*)an);
        as_xml_buf_push(&avals, (void*)av);
    }

    // children: ELEMENTS and TEXT/CDATA nodes, in DOCUMENT ORDER. That ordering is
    // what makes mixed content round-trip (<a>x<b/>y</a> keeps x before b and y
    // after it) -- the old model had a single text slot and folded every run
    // into one blob, which is residual (2).
    as_xml_buf children = { NULL, 0, 0 };
    for (;;) {
        if (sc->i >= sc->n) {
            // Unterminated element: AIR names the OPEN element.
            as_xml_err = 2;
            as_xml_err_name = as_str_dup(node->name);
            return NULL;
        }
        if (sc->s[sc->i] == '<') {
            if (sc->i + 1 < sc->n && sc->s[sc->i + 1] == '/') {
                sc->i += 2;
                char* cn = as_xml_sc_name(sc);
                as_xml_sc_ws(sc);
                if (sc->i < sc->n && sc->s[sc->i] == '>') sc->i++;
                // A mismatched close tag is #1085 in AIR, and the message names
                // the OPEN element ('<a></b>' -> 'element type "a" must be
                // terminated ...'), so the open name is what gets reported.
                if (!cn || strcmp(cn, node->name) != 0) {
                    as_xml_err = 2;
                    as_xml_err_name = as_str_dup(node->name);
                    return NULL;
                }
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
                    // CDATA content is LITERAL: not decoded, not trimmed (adl
                    // 51.4.1 prints <a><![CDATA[  x  ]]></a> with the spaces).
                    char* raw = as_str_alloc((size_t)tlen + 1);
                    if (tlen > 0) memcpy(raw, sc->s + start, (size_t)tlen);
                    raw[tlen] = 0;
                    as_xml_buf_push(&children, (void*)as_xml_text_new(raw, 1));
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
            char* t = as_xml_text_run(sc->s + start, sc->i - start);
            if (t != NULL) as_xml_buf_push(&children, (void*)as_xml_text_new(t, 0));
        }
    }
    // Install children.
    node->child_count = children.length;
    node->children = (as_xml_node**)children.items;
    // Back pointers for XML.parent(): every child (text nodes included) records
    // its parent. Written with a write barrier because the child may already be
    // reachable (it was pushed into the parent's buffer) and could have been
    // marked black while the new parent is still white.
    for (int i = 0; i < children.length; i++) {
        as_xml_node* c = (as_xml_node*)children.items[i];
        if (c != NULL) {
            c->parent = node;
            gc_write_barrier((void*)node);
        }
    }
    // text(): the element's direct text content, i.e. every text/cdata child in
    // document order concatenated. Cached in the node because text() and the
    // childless string value read it without walking the children.
    size_t ttotal = 0;
    for (int i = 0; i < children.length; i++) {
        as_xml_node* c = (as_xml_node*)children.items[i];
        if (c != NULL && c->name == NULL && c->text != NULL) ttotal += strlen(c->text);
    }
    if (ttotal > 0) {
        char* t = as_str_alloc(ttotal + 1);
        size_t o = 0;
        for (int i = 0; i < children.length; i++) {
            as_xml_node* c = (as_xml_node*)children.items[i];
            if (c != NULL && c->name == NULL && c->text != NULL) {
                size_t l = strlen(c->text);
                memcpy(t + o, c->text, l);
                o += l;
            }
        }
        t[o] = 0;
        node->text = t;
    }

as_xml_done_attrs:
    node->attr_count = anames.length;
    node->attr_names = (char**)anames.items;
    node->attr_vals = (char**)avals.items;
    return node;
}

// Parse a complete XML document (or, for text-only input, build a TEXT node).
// Returns NULL on malformed input with as_xml_err/as_xml_err_name describing the
// failure; as_xml_parse_checked turns that into the TypeError AIR throws.
//
// The three shapes, all measured on adl 51.4.1 (temp/e4xres/):
//   * NO '<' anywhere      -> a TEXT node. "plaintext" stays a text node
//     (nodeKind "text", localName null, toString/toXMLString both the value),
//     a padded "  hi  " trims to "hi", and whitespace/empty input is a text node
//     whose value is "". This is residual (1): it used to be a hard parse error.
//   * one well-formed<root> -> that element; leading/trailing whitespace and the
//     XML declaration are ignored.
//   * anything else        -> #1088. "text<a/>" and "<a/>trail" both raise it,
//     while a malformed tag raises #1090/#1085 from the element parser itself.
// A root CDATA section is a node in its own right (new XML("<![CDATA[x]]>")).
static as_xml_node* as_xml_parse(const char* src, int len) {
    as_xml_err = 0;
    as_xml_err_name = NULL;
    if (!src) return NULL;
    as_xml_sc sc = { src, 0, len };
    int has_markup = 0;
    for (int k = 0; k < len; k++) if (src[k] == '<') { has_markup = 1; break; }
    if (!has_markup) {
        char* t = as_xml_text_run(src, len);
        if (t == NULL) t = as_str_empty();
        return as_xml_text_new(t, 0);
    }
    as_xml_node* root = NULL;
    int free_text = 0;
    for (;;) {
        as_xml_sc_ws(&sc);
        if (sc.i >= sc.n) break;
        if (sc.s[sc.i] != '<') {
            // Free text between markup tokens: legal nowhere in an XML document.
            while (sc.i < sc.n && sc.s[sc.i] != '<') sc.i++;
            if (root != NULL) { as_xml_err = 3; return NULL; }  // "<a/>trail"
            free_text = 1;
            continue;
        }
        char n1 = sc.i + 1 < sc.n ? sc.s[sc.i + 1] : 0;
        if (n1 == '?') {
            // XML declaration / processing instruction.
            sc.i += 2;
            while (sc.i + 1 < sc.n && !(sc.s[sc.i] == '?' && sc.s[sc.i + 1] == '>')) sc.i++;
            if (sc.i + 1 < sc.n) sc.i += 2;
            continue;
        }
        if (n1 == '!') {
            if (sc.n - sc.i >= 4 && strncmp(sc.s + sc.i, "<!--", 4) == 0) {
                sc.i += 4;
                while (sc.i + 2 < sc.n && !(sc.s[sc.i] == '-' && sc.s[sc.i + 1] == '-' && sc.s[sc.i + 2] == '>')) sc.i++;
                if (sc.i + 2 < sc.n) sc.i += 3;
                continue;
            }
            if (sc.n - sc.i >= 9 && strncmp(sc.s + sc.i, "<![CDATA[", 9) == 0) {
                if (root != NULL) { as_xml_err = 3; return NULL; }
                sc.i += 9;
                int start = sc.i;
                while (sc.i + 2 < sc.n && !(sc.s[sc.i] == ']' && sc.s[sc.i + 1] == ']' && sc.s[sc.i + 2] == '>')) sc.i++;
                int tlen = sc.i - start;
                char* raw = as_str_alloc((size_t)tlen + 1);
                if (tlen > 0) memcpy(raw, sc.s + start, (size_t)tlen);
                raw[tlen] = 0;
                if (sc.i + 2 < sc.n) sc.i += 3;
                root = as_xml_text_new(raw, 1);
                continue;
            }
            // DOCTYPE or other declaration: skipped, as before.
            sc.i += 2;
            while (sc.i < sc.n && sc.s[sc.i] != '>') sc.i++;
            if (sc.i < sc.n) sc.i++;
            continue;
        }
        if (root != NULL) { as_xml_err = 3; return NULL; }  // a SECOND root element
        as_xml_node* e = as_xml_sc_element(&sc);
        if (!e) return NULL;                            // err set by the element
        // The element parsed, so the free text in front of it is what makes the
        // document ill-formed -- AIR reports #1088 here, not #1090.
        if (free_text) { as_xml_err = 3; return NULL; }
        root = e;
    }
    return root;
}

// A parse failure as the AS3 TypeError the reference runtime raises. The ids and
// the wording are adl 51.4.1's, measured in temp/e4xres/:
//   #1085  The element type "a" must be terminated by the matching end-tag "</a>".
//   #1088  The markup in the document following the root element must be well-formed.
//   #1090  XML parser failure: element is malformed.
// The quotes are built from a char array rather than escaped literals: this whole
// preamble is a template string, so an escaped quote would reach the C half-eaten.
static int as_xml_error_id(void) {
    if (as_xml_err == 2) return 1085;
    if (as_xml_err == 3) return 1088;
    return 1090;
}
static char* as_xml_error_message(void) {
    if (as_xml_err == 2) {
        const char* nm = as_xml_err_name != NULL ? as_xml_err_name : "";
        char q[2]; q[0] = '"'; q[1] = 0;
        char* out = as_str_concat("Error #1085: The element type ", q);
        out = as_str_concat(out, nm);
        out = as_str_concat(out, q);
        out = as_str_concat(out, " must be terminated by the matching end-tag ");
        out = as_str_concat(out, q);
        out = as_str_concat(out, "</");
        out = as_str_concat(out, nm);
        out = as_str_concat(out, ">");
        out = as_str_concat(out, q);
        out = as_str_concat(out, ".");
        return out;
    }
    if (as_xml_err == 3) return (char*)"Error #1088: The markup in the document following the root element must be well-formed.";
    return (char*)"Error #1090: XML parser failure: element is malformed.";
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
// localName() is an AS3 String value too: as_xml_local returns an INTERIOR pointer
// (past the 'prefix:' part), so it must be copied before it leaves the runtime.
// A text node has NO name, and adl 51.4.1 reports null (not "") for it.
static char* as_xml_local_name(as_xml_node* n) {
    if (n == NULL || n->name == NULL) return NULL;
    return as_str_dup(as_xml_local(n->name));
}

// XML.attributes() / XMLList.attributes() (E4X). AIR returns an XMLList of the
// element's ATTRIBUTE NODES; this subset stores attributes as a name/value pair
// list and has no attribute nodes, so the value every caller in the wild reads
// (String(el.attributes()) on the app-descriptor text element with a lang= probe)
// Config.as) is reproduced by returning the FIRST attribute's value as a String.
// A multi-attribute element therefore reports only its first attribute: the
// documented simplification (README-CN.md).
static char* as_xml_attr_first(as_xml_node* n) {
    if (n == NULL || n->attr_count <= 0 || n->attr_vals == NULL) return (char*)"";
    return n->attr_vals[0] ? as_str_dup(n->attr_vals[0]) : (char*)"";
}

static char* as_xml_list_attributes(as_xml_list* l) {
    if (l == NULL || l->length <= 0) return (char*)"";
    return as_xml_attr_first(l->items[0]);
}

// XML.appendChild(): needs a mutable tree, which this model does not have (it is
// parsed once from the source text), so the call names itself on stderr instead
// of silently dropping the child.
static void as_xml_append_child_unsupported(void) {
    as_shell_unsupported((char*)"XML.appendChild");
}

// @attr: return the attribute value, or the empty string when absent (E4X's
// undefined attribute stringifies to "", matching AS3's implicit toString).
static char* as_xml_attr(as_xml_node* n, const char* name) {
    if (!n) return "";
    for (int i = 0; i < n->attr_count; i++) {
        if (strcmp(n->attr_names[i], name) == 0) return as_str_dup(n->attr_vals[i]);
    }
    return "";
}

// xml.@attr = value (the XMLList form writes EVERY node in the list). E4X converts
// the assigned value to a String, so the emitter stringifies it and this helper only
// stores text -- the same scalar view as_xml_attr reads back. Attributes are per-node
// parallel arrays here, so an absent name is APPENDED and an existing name keeps its
// slot: the order decides which attribute as_xml_attr_first reports first, which must
// not change under a write.
static void as_xml_set_attr(as_xml_node* n, const char* name, const char* value) {
    if (n == NULL || name == NULL || name[0] == 0) return;
    if (value == NULL) value = "";
    for (int i = 0; i < n->attr_count; i++) {
        if (strcmp(n->attr_names[i], name) == 0) {
            size_t len = strlen(value);
            char* nv = as_str_alloc(len + 1);
            memcpy(nv, value, len + 1);
            n->attr_vals[i] = nv;
            gc_write_barrier((void*)nv);
            return;
        }
    }
    int c = n->attr_count + 1;
    char** names = (char**)gc_alloc(GCT_PTR_ARRAY, (size_t)c * sizeof(char*));
    char** vals = (char**)gc_alloc(GCT_PTR_ARRAY, (size_t)c * sizeof(char*));
    // A fresh block is born black during a cycle, so every pointer copied into it
    // must be re-greyed (see as_array_ensure); the tail slot is filled and barred
    // afterwards.
    for (int i = 0; i < n->attr_count; i++) {
        names[i] = n->attr_names[i]; vals[i] = n->attr_vals[i];
        gc_write_barrier((void*)names[i]); gc_write_barrier((void*)vals[i]);
    }
    size_t ln = strlen(name), lv = strlen(value);
    char* nn = as_str_alloc(ln + 1); memcpy(nn, name, ln + 1);
    char* nv2 = as_str_alloc(lv + 1); memcpy(nv2, value, lv + 1);
    names[c - 1] = nn; vals[c - 1] = nv2;
    gc_write_barrier((void*)nn); gc_write_barrier((void*)nv2);
    n->attr_names = names; n->attr_vals = vals; n->attr_count = c;
    gc_write_barrier((void*)names); gc_write_barrier((void*)vals);
}
static void as_xml_list_set_attr(as_xml_list* l, const char* name, const char* value) {
    if (l == NULL) return;
    for (int i = 0; i < l->length; i++) as_xml_set_attr(l->items[i], name, value);
}

// .child: all direct children whose LOCAL name matches (empty name = all
// children, and "*" is AIR's documented child(propertyName:Object = "*")
// wildcard). The requested name is always a bare local name (a source identifier
// or a computed string), so only the node side is local-ized.
// The WILDCARD axis includes TEXT nodes -- measured on adl 51.4.1: on
// <a>t1<b>bt</b>t2<c/></a>, children(), child("*") and the .* operator all report
// FOUR items (text, element, text, element), while elements() reports two. A named
// lookup never matches a text node (it has no name), which is why the usages in
// the wild (xml.pages.page) are unaffected.
static int as_xml_name_all(const char* name) {
    return name == NULL || name[0] == 0 || (name[0] == '*' && name[1] == 0);
}
static as_xml_list* as_xml_children(as_xml_node* n, const char* name) {
    if (!n || n->child_count == 0) return as_xml_list_new(NULL, 0);
    as_xml_buf buf = { NULL, 0, 0 };
    for (int i = 0; i < n->child_count; i++) {
        as_xml_node* c = n->children[i];
        if (!c->name) {
            // Text nodes take part in the WILDCARD axis only.
            if (as_xml_name_all(name)) as_xml_buf_push(&buf, (void*)c);
            continue;
        }
        if (as_xml_name_all(name) || strcmp(as_xml_local(c->name), name) == 0) as_xml_buf_push(&buf, (void*)c);
    }
    return as_xml_list_new((as_xml_node**)buf.items, buf.length);
}

// XML.elements(): the ELEMENT axis only -- children() with text nodes excluded
// (adl 51.4.1 reports 2 elements against 4 children on <a>t1<b>bt</b>t2<c/></a>).
static as_xml_list* as_xml_elements(as_xml_node* n, const char* name) {
    if (!n || n->child_count == 0) return as_xml_list_new(NULL, 0);
    as_xml_buf buf = { NULL, 0, 0 };
    for (int i = 0; i < n->child_count; i++) {
        as_xml_node* c = n->children[i];
        if (c->name == NULL) continue;
        if (as_xml_name_all(name) || strcmp(as_xml_local(c->name), name) == 0) as_xml_buf_push(&buf, (void*)c);
    }
    return as_xml_list_new((as_xml_node**)buf.items, buf.length);
}

// XML.nodeKind(): "text" for text/cdata nodes, "element" otherwise. AIR reports a
// CDATA section as kind "text" too (its markup still keeps the CDATA wrapper).
static char* as_xml_node_kind(as_xml_node* n) {
    if (n != NULL && n->name == NULL) return (char*)"text";
    return (char*)"element";
}

// XML.text(): the element's own text content. A TEXT node has none -- adl 51.4.1
// answers "" for new XML("abc").text(), not "abc" -- because text() selects the
// text CHILDREN, and a text node has no children.
static char* as_xml_text_of(as_xml_node* n) {
    if (n == NULL || n->name == NULL) return (char*)"";
    return n->text != NULL ? n->text : (char*)"";
}

// Flatten a list's children of a given name across all its nodes (.a.b).
static as_xml_list* as_xml_list_children(as_xml_list* l, const char* name) {
    as_xml_buf buf = { NULL, 0, 0 };
    if (l) {
        for (int i = 0; i < l->length; i++) {
            as_xml_list* sub = as_xml_children(l->items[i], name);            for (int j = 0; j < sub->length; j++) as_xml_buf_push(&buf, (void*)sub->items[j]);
        }
    }
    return as_xml_list_new((as_xml_node**)buf.items, buf.length);
}

// xml.prop = value: an E4X CHILD write (the read side is as_xml_children). The
// semantics were measured on adl 51.4.1 (temp/airref/Main.as): with
// <r><a>1</a><a>2</a><b>3</b></r>, x.a = "9" gives <r><a>9</a><b>3</b></r> (the
// FIRST match's content is replaced -- its own element children are dropped, its
// attributes kept -- and the REMAINING matches are removed), while x.c = "CC"
// on <r><a>1</a><b>2</b></r> APPENDS <c>CC</c> after the last child. The assigned
// value is converted to a String by the emitter, so this helper only stores text
// (a Number child is its decimal form: x.a = 42 gives <a>42</a>).
static void as_xml_set_child(as_xml_node* n, const char* name, const char* text) {
    if (n == NULL || name == NULL || name[0] == 0) return;
    if (text == NULL) text = "";
    int first = -1;
    for (int i = 0; i < n->child_count; i++) {
        as_xml_node* c = n->children[i];
        if (c->name != NULL && (as_xml_name_all(name) || strcmp(as_xml_local(c->name), name) == 0)) { first = i; break; }
    }
    size_t tl = strlen(text);
    char* nt = as_str_alloc(tl + 1);
    memcpy(nt, text, tl + 1);
    if (first < 0) {
        size_t nl = strlen(name);
        char* nn = as_str_alloc(nl + 1);
        memcpy(nn, name, nl + 1);
        as_xml_node* c = as_xml_node_new(nn);
        c->text = nt;
        // The new child also gets a TEXT child, so the content is in the SAME
        // place the parser puts it: a pretty-printed parent then interleaves it
        // like any other text run instead of reading a stale cache.
        as_xml_node** cb = (as_xml_node**)gc_alloc(GCT_PTR_ARRAY, sizeof(as_xml_node*));
        as_xml_node* tc = as_xml_text_new(as_str_dup(nt), 0);
        tc->parent = c;
        cb[0] = tc;
        gc_write_barrier((void*)tc);
        gc_write_barrier((void*)cb);
        c->children = cb;
        c->child_count = 1;
        // The new child is attached to its parent, so XML.parent() sees it -- the
        // parser does the same for parsed nodes (the tree is otherwise immutable).
        c->parent = n;
        int nc = n->child_count + 1;
        as_xml_node** buf = (as_xml_node**)gc_alloc(GCT_PTR_ARRAY, (size_t)nc * sizeof(as_xml_node*));
        for (int i = 0; i < n->child_count; i++) { buf[i] = n->children[i]; gc_write_barrier((void*)buf[i]); }
        buf[n->child_count] = c;
        gc_write_barrier((void*)c);
        n->children = buf; n->child_count = nc;
        gc_write_barrier((void*)buf);
        return;
    }
    as_xml_node* tgt = n->children[first];
    tgt->text = nt;
    gc_write_barrier((void*)nt);
    // Replacing the content DROPS the old children (element and text alike) and
    // installs the assigned string as the single text child.
    {
        as_xml_node** cb = (as_xml_node**)gc_alloc(GCT_PTR_ARRAY, sizeof(as_xml_node*));
        as_xml_node* tc = as_xml_text_new(as_str_dup(nt), 0);
        tc->parent = tgt;
        cb[0] = tc;
        gc_write_barrier((void*)tc);
        gc_write_barrier((void*)cb);
        tgt->children = cb;
        tgt->child_count = 1;
    }
    int keep = 0;
    for (int i = 0; i < n->child_count; i++) {
        as_xml_node* c = n->children[i];
        if (i != first && c->name != NULL && (as_xml_name_all(name) || strcmp(as_xml_local(c->name), name) == 0)) continue;
        keep++;
    }
    if (keep == n->child_count) return;
    as_xml_node** buf = (as_xml_node**)gc_alloc(GCT_PTR_ARRAY, (size_t)keep * sizeof(as_xml_node*));
    int k = 0;
    for (int i = 0; i < n->child_count; i++) {
        as_xml_node* c = n->children[i];
        if (i != first && c->name != NULL && (as_xml_name_all(name) || strcmp(as_xml_local(c->name), name) == 0)) continue;
        buf[k] = c; gc_write_barrier((void*)c); k++;
    }
    n->children = buf; n->child_count = keep;
    gc_write_barrier((void*)buf);
}
// The XMLList form writes EVERY node in the list, exactly like as_xml_list_set_attr.
static void as_xml_list_set_child(as_xml_list* l, const char* name, const char* text) {
    if (l == NULL) return;
    for (int i = 0; i < l->length; i++) as_xml_set_child(l->items[i], name, text);
}

// x..name / x..*: every descendant at any depth, self EXCLUDED (E4X's
// descendant axis). name is the local name to match; NULL or "" matches any
// name. Results are appended in document order (pre-order), which is the order
// E4X reports.
static void as_xml_desc_walk(as_xml_buf* buf, as_xml_node* n, const char* name) {
    if (!n) return;
    for (int i = 0; i < n->child_count; i++) {
        as_xml_node* c = n->children[i];
        if (c->name) {
            if (as_xml_name_all(name) || strcmp(as_xml_local(c->name), name) == 0) as_xml_buf_push(buf, (void*)c);
        } else if (as_xml_name_all(name)) {
            // TEXT nodes on the wildcard axis: descendants() includes them
            // (adl 51.4.1 reports 5 for <a>t1<b>bt</b>t2<c/></a>).
            as_xml_buf_push(buf, (void*)c);
        }
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

// @attr on a list: E4X list.@attr yields an XMLList of the attribute values, and
// in a scalar (String) context that list is the CONCATENATION of every item's
// value in document order, with NO separator; a missing or empty attribute
// contributes nothing. Measured on adl 51.4.1 (temp/qfix/xmlattr.body.as): two
// items at="1"/at="2" give "12" (not "1"), three give "abc", and a partial list
// yields only the present values. Starling reads this only in scalar contexts.
static char* as_xml_list_attr(as_xml_list* l, const char* name) {
    if (!l || l->length == 0) return "";
    // The single-item case is the common Starling shape and needs no allocation.
    if (l->length == 1) return as_xml_attr(l->items[0], name);
    char* out = NULL;
    for (int i = 0; i < l->length; i++) {
        char* v = as_xml_attr(l->items[i], name);
        if (v == NULL) v = "";
        out = (out == NULL) ? v : as_str_concat(out, v);
    }
    return out ? out : "";
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

// Serialize a node back to XML text.
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

// 2 spaces per nesting level. Clamped to 62 columns: deeper nesting only widens
// the output, it never changes what the markup says (there is no real document
// nested 30 levels deep).
static void as_xml_indent(char* buf, int level) {
    int ind = 0;
    for (int i = 0; i < level && ind < 62; i++) { buf[ind++] = ' '; buf[ind++] = ' '; }
    buf[ind] = 0;
}

// Append s with the escapes the reference runtime uses, which are DIFFERENT for
// text and for attribute values (both measured on adl 51.4.1, temp/e4xres/):
//   TEXT (mode 0):      '&' -> &amp;   '<' -> &lt;   '>' -> &gt;
//                       quotes, tabs and newlines stay RAW
//   ATTRIBUTE (mode 1): '&' -> &amp;   '<' -> &lt;   '"' -> &quot;
//                       TAB/LF/CR -> &#x9;/&#xA;/&#xD;   '>' stays RAW
// Escaping is required now that entities are DECODED on the way in: an unknown
// reference arrives as the literal text "&copy;", and writing it back unescaped
// would make the next parse decode it (that was residual (3)).
static void as_xml_append_esc(char** outp, size_t* lenp, size_t* capp, const char* s, int mode) {
    if (s == NULL) return;
    for (size_t i = 0; s[i] != 0; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c == '&') as_xml_append(outp, lenp, capp, "&amp;", 5);
        else if (c == '<') as_xml_append(outp, lenp, capp, "&lt;", 4);
        else if (c == '>' && mode == 0) as_xml_append(outp, lenp, capp, "&gt;", 4);
        else if (c == '"' && mode == 1) as_xml_append(outp, lenp, capp, "&quot;", 6);
        else if (c == '\\n' && mode == 1) as_xml_append(outp, lenp, capp, "&#xA;", 5);
        else if (c == '\\r' && mode == 1) as_xml_append(outp, lenp, capp, "&#xD;", 5);
        else if (c == '\\t' && mode == 1) as_xml_append(outp, lenp, capp, "&#x9;", 5);
        else as_xml_append(outp, lenp, capp, (const char*)&s[i], 1);
    }
}

// MARKUP serialiser -- the value of toXMLString(), and the value toString() falls
// back to for an element WITH element children. Measured on adl 51.4.1
// (temp/toxml/ + temp/e4xres/), three shape rules:
//   * no children                            -> <a b="1"/>
//   * exactly ONE text/CDATA child           -> INLINE: <a>txt</a>
//   * anything else (an element child, or two or more children) -> PRETTY:
//     one child per line, 2 spaces per level, closing tag back at its level
// A text child is escaped, a CDATA child is written back AS CDATA (its content is
// literal, so <![CDATA[<b/>]]> survives the round trip instead of turning into
// escaped text). Whitespace-only text runs never reach here -- the parser drops
// them -- while an EMPTY run created by an entity prints as <a></a>, which is what
// adl does too. Attributes always use double quotes.
// KNOWN DEVIATION (registered in TODO.md): element names are not escaped, and a
// CDATA section whose content contains "]]>" is not split.
static char* as_xml_markup(as_xml_node* n, int level) {
    if (!n) return "";
    size_t cap = 64;
    char* out = as_str_alloc(cap);
    size_t len = 0;
    out[0] = 0;
    if (!n->name) {
        // A bare text/cdata node (the document itself, or a CDATA child).
        if (n->cdata) {
            as_xml_append(&out, &len, &cap, "<![CDATA[", 9);
            if (n->text) as_xml_append(&out, &len, &cap, n->text, strlen(n->text));
            as_xml_append(&out, &len, &cap, "]]>", 3);
        } else {
            as_xml_append_esc(&out, &len, &cap, n->text, 0);
        }
        return out;
    }
    // <name attr="v" ...>
    char q[2]; q[0] = '"'; q[1] = 0;
    as_xml_append(&out, &len, &cap, "<", 1);
    as_xml_append(&out, &len, &cap, n->name, strlen(n->name));
    for (int i = 0; i < n->attr_count; i++) {
        as_xml_append(&out, &len, &cap, " ", 1);
        as_xml_append(&out, &len, &cap, n->attr_names[i], strlen(n->attr_names[i]));
        as_xml_append(&out, &len, &cap, "=", 1);
        as_xml_append(&out, &len, &cap, q, 1);
        as_xml_append_esc(&out, &len, &cap, n->attr_vals[i], 1);
        as_xml_append(&out, &len, &cap, q, 1);
    }
    if (n->child_count == 0) {
        as_xml_append(&out, &len, &cap, "/>", 2);
        return out;
    }
    int has_elem = 0;
    for (int i = 0; i < n->child_count; i++) {
        if (n->children[i] != NULL && n->children[i]->name != NULL) { has_elem = 1; break; }
    }
    as_xml_append(&out, &len, &cap, ">", 1);
    char ib[68];
    if (!has_elem && n->child_count == 1) {
        char* cs = as_xml_markup(n->children[0], level + 1);
        as_xml_append(&out, &len, &cap, cs, strlen(cs));
    } else {
        for (int i = 0; i < n->child_count; i++) {
            as_xml_indent(ib, level + 1);
            as_xml_append(&out, &len, &cap, "\\n", 1);
            as_xml_append(&out, &len, &cap, ib, strlen(ib));
            char* cs = as_xml_markup(n->children[i], level + 1);
            as_xml_append(&out, &len, &cap, cs, strlen(cs));
        }
        as_xml_indent(ib, level);
        as_xml_append(&out, &len, &cap, "\\n", 1);
        as_xml_append(&out, &len, &cap, ib, strlen(ib));
    }
    as_xml_append(&out, &len, &cap, "</", 2);
    as_xml_append(&out, &len, &cap, n->name, strlen(n->name));
    as_xml_append(&out, &len, &cap, ">", 1);
    return out;
}

// Shallow entry point: the markup at indent 0 (the form every other reader uses).
static char* as_xml_to_string(as_xml_node* n) { return as_xml_markup(n, 0); }

// E4X string value -- what XML.toString(), String(xml) and xml + "" all yield.
// MEASURED on adl 51.4.1 (temp/tkmeet-mac/xmlstr + temp/e4xres/): a TEXT node
// yields its text; an element WITH element children yields the MARKUP; every other
// element yields its own direct text content (the concatenation of its text/cdata
// children, in document order). So <a>x<b/>y</a> -> markup, while <a>pre<![CDATA[
// mid]]>post</a> -> "premidpost".
// A String handed to AS3 is a VALUE: always copy the node's own buffer (see
// as_str_dup) -- the node may be collected while AS3 still holds the string.
static char* as_xml_string_value(as_xml_node* n) {
    if (!n) return "";
    if (!n->name) return as_str_dup(n->text ? n->text : "");
    int has_elem = 0;
    for (int i = 0; i < n->child_count; i++) {
        if (n->children[i] != NULL && n->children[i]->name != NULL) { has_elem = 1; break; }
    }
    if (!has_elem) return as_str_dup(n->text ? n->text : "");
    return as_xml_to_string(n);
}
// XMLList string value: 0 items -> "", 1 item -> that item's string value, more
// than one -> each item's MARKUP joined by a newline (adl 51.4.1: a list of two
// <i>a</i>/<i>b</i> nodes prints "<i>a</i>\\n<i>b</i>", while a ONE-item list prints
// "a" -- a lone item delegates, several do not).
static char* as_xml_list_to_string(as_xml_list* l) {
    if (!l || l->length == 0) return "";
    if (l->length == 1) return as_xml_string_value(l->items[0]);
    char* out = (char*)"";
    for (int i = 0; i < l->length; i++) {
        if (i > 0) out = as_str_concat(out, "\\n");
        out = as_str_concat(out, as_xml_to_string(l->items[i]));
    }
    return out;
}

// XMLList.toXMLString(): ALWAYS markup. That is the whole difference from
// toString() above, which hands a ONE-item list over to the item's string value
// (adl 51.4.1, temp/toxml/: <i>a</i> -> toString "a" but toXMLString "<i>a</i>").
// 0 items -> "", otherwise the item markups joined by a newline (same join as
// toString's multi-item form).
static char* as_xml_list_to_xml_string(as_xml_list* l) {
    if (!l || l->length == 0) return "";
    char* out = (char*)"";
    for (int i = 0; i < l->length; i++) {
        if (i > 0) out = as_str_concat(out, "\\n");
        out = as_str_concat(out, as_xml_to_string(l->items[i]));
    }
    return out;
}

static char* as_xml_box_to_str(void* o) { return as_xml_string_value((as_xml_node*)o); }
static char* as_xml_list_box_to_str(void* o) { return as_xml_list_to_string((as_xml_list*)o); }

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
// AS3 Object(x): "every value is an object" -- the value ITSELF, with exactly one
// exception: null/undefined yield a NEW EMPTY Object. Measured on adl 51.4.1
// (temp/xmlmeth, temp/d31probe/adl): Object(null) == null is false and
// String(Object(null)) is "[object Object]", both for a statically null operand
// and for a dynamic star variable holding null/undefined. Boxing the null through
// as_v_to_obj instead handed back the null-box, so Object(null) === null was
// true here and "null" was printed.
static as_value as_obj_conv(as_value v) {
    if (v.tag == 0 || v.tag == 5) { as_value r = {4, 0.0, NULL}; r.ptr = (void*)as_object_new(); return r; }
    return v;
}
static int as_object_find(as_object* o, const char* key) {
    for (int i = 0; i < o->length; i++) {
        if (strcmp(o->keys[i], key) == 0) return i;
    }
    return -1;
}
static as_value as_object_get(as_object* o, const char* key) {
    int i = as_object_find(o, key);
    // AIR's missing dynamic property reads as undefined, not null (measured on
    // adl 51.4.1, temp/qfix/gcadl/omMain.as: 'var o:*={}; o.bar' is undefined,
    // === undefined true, == null true).
    return i < 0 ? as_v_undefined() : o->vals[i];
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
// ASCII case-insensitive equality (stage one hundred forty-eight). CSS selectors and
// HTML tag names are matched case-insensitively: measured on adl 51.4.1
// (temp/fpsprobe2, temp/blockprobe), setStyle("memMax") both styles <memMax> and is
// reported by styleNames as "memmax", and setStyle("MemMax") styles it too.
// No allocation on purpose -- the stylesheet lookup runs on every htmlText
// assignment, and Fps.as assigns htmlText once per frame.
static bool as_str_ieq(const char* a, const char* b) {
    if (a == NULL || b == NULL) return false;
    while (*a != 0 && *b != 0) {
        char ca = (*a >= 'A' && *a <= 'Z') ? (char)(*a + 32) : *a;
        char cb = (*b >= 'A' && *b <= 'Z') ? (char)(*b + 32) : *b;
        if (ca != cb) return false;
        a++; b++;
    }
    return *a == 0 && *b == 0;
}
// Forward declaration: as_object_set is defined further down (the two entry points are
// as_object_set_key/as_object_set); as_object_clone below needs it here.
static as_value as_object_set(as_object* o, const char* key, as_value v);
// Shallow copy of a record: the same string keys and the same property values in a
// brand-new as_object. AIR's StyleSheet.setStyle stores "a copy of the style object
// that you pass to this method" (class reference), and getStyle returns another copy,
// so a caller that mutates the object it passed (or the one it read back) must not
// change the sheet. Keys go through as_object_set, which owns its own copy of the key
// and barriers the value (see the interior-pointer red line there).
static as_object* as_object_clone(const as_object* o) {
    as_object* r = as_object_new();
    if (o == NULL) return r;
    for (int i = 0; i < o->length; i++) as_object_set(r, o->keys[i], o->vals[i]);
    return r;
}
// StyleSheet rule lookup: 'rules' maps a selector to a declaration record. Returns the
// declaration record for 'name' or NULL. Case-insensitive on both sides (see
// as_str_ieq).
static as_object* as_ss_lookup(as_object* rules, const char* name) {
    if (rules == NULL || name == NULL || name[0] == 0) return NULL;
    for (int i = 0; i < rules->length; i++) {
        if (!as_str_ieq(rules->keys[i], name)) continue;
        as_value v = rules->vals[i];
        // as_value tag 4 is a plain object (as_v_obj), tag 6 an array (as_v_arr).
        // Only an OBJECT is a declaration record: a style set to an array/string/
        // number is stored but never matches a tag lookup.
        if (v.tag == 4) return (as_object*)v.ptr;
        return NULL;
    }
    return NULL;
}
// A CSS numeric value's numeric part: AIR's StyleSheet table says "Only the numeric
// part of the value is used. Units (px, pt) are not parsed", so '9px' -> 9 and
// '-2px' -> -2 (measured: temp/fpsprobe2 A vs A2 -- the 9px/leading -2 root rule is
// what makes the overlay 30.1px tall instead of 47.55px).
static double as_css_num(const char* v) {
    if (v == NULL) return 0.0;
    return atof(v);
}
// A CSS color: only '#RRGGBB' (AIR: "Only hexadecimal color values are supported.
// Named colors (such as blue) are not supported"). Anything else yields -1, which the
// caller reads as "no color declared" rather than black.
static int as_css_color(const char* v) {
    if (v == NULL || v[0] != '#') return -1;
    int acc = 0, n = 0;
    const char* p = v + 1;
    while (*p != 0 && n < 8) {
        char c = *p;
        int d;
        if (c >= '0' && c <= '9') d = c - '0';
        else if (c >= 'a' && c <= 'f') d = c - 'a' + 10;
        else if (c >= 'A' && c <= 'F') d = c - 'A' + 10;
        else return -1;
        acc = acc * 16 + d;
        n++;
        p++;
    }
    if (n == 0 || *p != 0) return -1;
    return acc;
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
        case 4:
            // A Function value sitting in an Object-typed slot is autoboxed into an
            // as_function (as_value_to_obj), so its dynamic type is still "function".
            // XML/XMLList report "xml", everything else "object".
            if (v.ptr == NULL) return "object";
            {   void* vt = ((as_object_header*)v.ptr)->vtable;
                if (vt == (void*)&as_function_vt) return "function";
                if (vt == (void*)&as_xml_vt || vt == (void*)&as_xml_list_vt) return "xml";
            }
            return "object";
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
    // E4X is its own typeof bucket in AIR: "xml" for XML and XMLList alike
    // (adl 51.4.1, temp/d31probe/adl -- static, dynamic-slot and Object-slot all
    // report "xml").
    if (vt == (void*)&as_xml_vt || vt == (void*)&as_xml_list_vt) return "xml";
    return "object";
}

// flash.utils.getQualifiedClassName(value:*):String — AS3 fully-qualified class
// name ("包::类", e.g. "starling.display::DisplayObject"). Primitives map to the
// canonical name strings; object instances and Class references both carry the
// class vtable as their first field (as_object_header / as_class), so both read
// the vtable's 'fqn' slot.
//
// Numbers answer by VALUE, not by the slot's static type: AIR has no way to tell a
// boxed int from a Number that happens to hold an integral value, so both say
// "int" — and only inside a 29-bit window. Measured on adl 51.4.1 (temp/qcn/):
// a double from Math.sqrt(25), Number("5"), an int->Number widening and Date.time
// of 0 all answer "int"; 268435455 answers "int" while 268435456, -268435457,
// 2147483647 and 4294967295 answer "Number". The window is exactly
// [-2^28, 2^28-1] (AVM2 tags int atoms with three low bits in a 32-bit word, so
// its int probe saturates there) — matching an int32 test instead would disagree
// with AIR for every int-typed variable above 2^28. uint never appears:
// getQualifiedClassName(uint(5)) is "int" even though "5 is uint" is true, and
// uint values outside the window answer "Number". "x is int" keeps its own, wider
// int32 value-domain caliber (as_v_is_int32); the two predicates are not the same
// question and AIR does not pretend otherwise.
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
        case 1: {
            // Value-domain 29-bit window — see the note above. Negative zero is the
            // one exception in the window: AIR answers "Number" for -0.0 but "int"
            // for +0.0 (measured: 0.0 / -0.0 / z*1 / Math.min(0,-0) vs z+0).
            double d = v.num;
            if (d >= -268435456.0 && d <= 268435455.0 && d == floor(d) && !(d == 0.0 && signbit(d))) return "int";
            return "Number";
        }
        case 2: return "Boolean";
        case 3: return "String";
        case 5: return "void";     // undefined
        case 6: return "Array";
        case 7: return "Function";
        case 4: {
            if (v.ptr == NULL) return "null";
            // A Class VALUE is a static as_class object (never in the GC heap): its
            // OWN name is authoritative. Reading the instance vtable instead would
            // report "Object" for the core classes, which have no boxed instance
            // type at all -- AIR gives "int"/"uint"/"Array" (measured on adl
            // 51.4.1: getQualifiedClassName(int) is "int").
            if (!gc_in_heap(v.ptr)) {
                const char* cfqn = as_class_fqn_of_ptr(v.ptr);
                if (cfqn != NULL) return (char*)cfqn;
            }
            int kind = as_heap_kind(v.ptr);
            if (kind == GCT_CUSTOM) {
                // A recognized Vector specialization answers its own name; any other
                // unmodeled GCT_CUSTOM object keeps the generic "Array" answer.
                if (as_vec_fqn_hook != NULL) { const char* n = as_vec_fqn_hook(v.ptr); if (n != NULL) return (char*)n; }
                return "Array";
            }
            if (kind == GCT_ARRAY) return "Array";
            // Dictionary is a C kind, not a modeled class, but AIR still reports the
            // AS3 name (adl 51.4.1: getQualifiedClassName(new Dictionary()) is
            // "flash.utils::Dictionary"; getQualifiedSuperclassName is "Object",
            // which the generic vtable-less path below already answers).
            if (kind == GCT_DICT) return "flash.utils::Dictionary";
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
            if (vt == NULL) {
                // A Class value with no instance vtable: a core class (int/uint/Array),
                // which AIR reports as extending Object (measured on adl 51.4.1:
                // getQualifiedSuperclassName(int) is "Object"). Object itself and a
                // plain record have no superclass.
                const char* cfqn = as_class_fqn_of_ptr(v.ptr);
                if (cfqn != NULL && strcmp(cfqn, "Object") != 0) return (char*)"Object";
                return NULL;
            }
            void* sup = ((as_vtable_header*)vt)->super;
            if (sup == NULL) return NULL;   // Object itself (and a plain record)
            return (char*)((as_vtable_header*)sup)->fqn;   // NULL for an interface
        }
        default: return NULL;
    }
}
// as_object_set_key is the shared core for the two public entry points below.
// copy_key == 0 is only used for keys this program can PROVE are permanent C string
// literals in the read-only data segment (the compiler emits those for object
// literal keys), where copying would allocate a fresh string on every literal
// evaluation -- pure waste that also shifts the offscreen GC trigger's phase
// (阶段一百四十七: measured +1.4 MB of churn per 1000 literal records).
static as_value as_object_set_key(as_object* o, const char* key, as_value v, int copy_key) {
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
    // The key must be an INDEPENDENT value. o->keys is a GCT_PTR_ARRAY, so the
    // marker walks every entry as a pointer: a caller-supplied INTERIOR pointer
    // (URLVariables.decode passes a p pointer into the buffer it just split in
    // place, and any AS3 obj[str] with a substring key gets here) would be read
    // as a block
    // body, greying a bogus "block" whose header is really string bytes -- the
    // corruption measured on TalkMED (阶段一百四十七). Copying also fixes the
    // lifetime: the caller's buffer may be garbage while the key is still in use.
    // The copy is skipped only for keys the compiler emitted as string literals
    // (see as_object_make), whose lifetime is the program's.
    const char* owned = key;
    if (copy_key && key != NULL) owned = as_str_dup(key);
    o->keys[o->length] = (char*)owned;
    o->vals[o->length] = v;
    o->length++;
    gc_write_barrier((void*)owned);
    gc_write_barrier_value(v);
    return v;
}
// The literal-key path: the keys come from the emitted (char*[n]){ "a", ... } brace
// initialiser, i.e. permanent string literals -- store them as-is (copy_key == 0).
static as_object* as_object_make(int n, char** keys, as_value* vals) {
    as_object* o = as_object_new();
    for (int i = 0; i < n; i++) as_object_set_key(o, keys[i], vals[i], 0);
    return o;
}
static as_value as_object_set(as_object* o, const char* key, as_value v) {
    return as_object_set_key(o, key, v, 1);
}

// SWC named-child properties (阶段一百三十七). AIR exposes every NAMED child of an
// exported symbol's timeline as a property of the symbol instance: Flash
// Professional's generated frame code assigns each instance name to the parent
// object when the timeline runs, and a symbol class derived from MovieClip is
// dynamic, so a class upLoadView extends uploadskin may read select / cancel /
// dragfile as bare identifiers. The baker reproduces that assignment here
// (emitted per named placement, see emit.ts) instead of declaring traits, which is
// what AIR itself does at runtime.
//
// A SEALED timeline (a plain Sprite-backed symbol) is deliberately skipped, not
// reported: AVM2's setproperty on a sealed object with an unknown name is a silent
// no-op, and raising the sealed-property #1056 here would abort a construction AIR
// completes. The child's own name field is set by the caller either way, so
// getChildByName keeps working.
static void as_swc_child_name(void* parent, const char* name, void* child) {
    if (parent == NULL || name == NULL || child == NULL) return;
    as_vtable_header* hv = (as_vtable_header*)((as_object_header*)parent)->vtable;
    if (hv->dyn_offset < 0) return;
    as_object* dyn = *(as_object**)((char*)parent + hv->dyn_offset);
    if (dyn != NULL) as_object_set(dyn, name, as_v_obj(child));
}

// ---------- E4X member helpers used by the emitter ----------
// XML.name() returns a QName in AIR. Our XML model keeps only the element's name
// string (prefix included), so the QName is a plain record carrying the parts the
// AS3 code actually reads: localName and uri. A node without a name (a text node)
// yields empty strings instead of throwing. Defined here, after as_object_set, so
// the record helpers are already declared.
static as_value as_xml_qname(as_xml_node* n) {
    // A text node has no name at all: adl 51.4.1 answers null, so reading .localName
    // off it raises #1009 rather than yielding "".
    if (n == NULL || n->name == NULL) return as_v_null();
    as_object* q = as_object_new();
    const char* ln = as_xml_local(n->name);
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
// Writing a name that IS a trait of the class but cannot be assigned: a getter
// with no setter is ReferenceError #1074, a method is ReferenceError #1037
// (measured on adl 51.4.1, temp/smeprobe/adl4.txt -- both name the RECEIVER's
// class, not the declaring one: 'type' written on a ScreenMouseEvent reports
// "on flash.events.ScreenMouseEvent." even though Event declares it).
static void as_throw_readonly_set(const char* key, const char* fqn);
static void as_throw_method_assign(const char* key, const char* fqn);
// The loud "not supported by this subset" failure (an Error with id 0). It builds
// an Error object, so like the two above it is defined after the Error class
// hierarchy and only prototyped here.
static void as_throw_unsupported(const char* msg);
// DisplayObject.name rejects a null/undefined write with TypeError #2007 in AIR,
// on the static slot and on every dynamic (* / Object) receiver alike (measured
// on adl 51.4.1, temp/qfix/gcadl/result16.txt). The definition sits with the
// other Error-constructing helpers (emitSealedPropErrors), so it is prototyped
// here; prop-table tag 13 marks that slot so a dynamic write takes the guard too.
static char* as_req_name(char* s);
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

// 'x is Array' / 'x as Array' when x's STATIC type is Object -- the universal
// value slot, which holds a bare as_array* for an Array. An Array has no vtable
// (its first word is the element buffer), so the class-chain test cannot answer
// it: as_is() answered false and as_* cast NULL, and both were silent (G14). A
// class X extends Array instance IS an Array through the backing-array hook, the
// same discriminator the dynamic paths use (as_any_length / as_dyn_get).
static bool as_obj_is_array(void* obj) {
    if (obj == NULL) return false;
    return as_dyn_kind(obj) == 2 || as_arrback_is(obj);
}
static as_array* as_obj_as_array(void* obj) {
    if (obj == NULL) return NULL;
    if (as_dyn_kind(obj) == 2) return (as_array*)obj;
    return as_arrback_hook != NULL ? as_arrback_hook(obj) : NULL;
}

// '.constructor' on an Object-typed receiver. as_v_class_of walks the receiver's
// vtable, which an Array does not have (its first word is the element buffer), so
// '[1,2,3]' in an Object slot answered nothing -- String(o.constructor) printed
// '[class Class]' and 'o.constructor == Array' was false (G14). A Dictionary /
// Vector body does not start with a vtable either; neither trait is modelled
// here, so answer null rather than read the data pointer as one.
static as_value as_obj_class_of(void* obj) {
    if (obj == NULL) return as_v_null();
    int dk = as_dyn_kind(obj);
    if (dk == 2) return as_v_class_of(as_v_arr(obj));
    if (dk != 0) return as_v_null();
    return as_v_class_of(as_v_obj(obj));
}

// for each (v in <dynamically-typed expr>): what gets enumerated is decided by the
// VALUE's runtime kind, exactly as AIR dispatches on it -- an Array yields its
// elements, a Dictionary its values, a Vector.<T> its elements, a dynamic Object
// (a record) the VALUES of its dynamic properties in insertion order, and a
// 'class X extends Array' instance its backing array's elements. null/undefined,
// a number or a string yield no iterations (AIR's for-each over a non-collection
// is an empty loop). The typed receiver paths in emit.ts do not come here; this is
// the fallback for a '*' / Object-typed iterable, driven by an index cursor so the
// emitted body stays a plain C loop whose 'break' is a real break.
static int as_foreach_next(as_value coll, int* idx, as_value* out) {
    int i = *idx;
    if (coll.tag == 6) {                 // boxed Array
        as_array* a = (as_array*)coll.ptr;
        if (a == NULL || i >= a->length) return 0;
        *out = a->data[i]; *idx = i + 1; return 1;
    }
    if (coll.tag != 4 || coll.ptr == NULL) return 0;
    void* p = coll.ptr;
    int dk = as_dyn_kind(p);
    if (dk == 2) {
        as_array* a = (as_array*)p;
        if (i >= a->length) return 0;
        *out = a->data[i]; *idx = i + 1; return 1;
    }
    if (dk == 1) {
        as_dict* d = (as_dict*)p;
        if (i >= d->length) return 0;
        *out = d->vals[i]; *idx = i + 1; return 1;
    }
    if (dk == 3) {
        if (as_vec_get_hook == NULL) return 0;
        int n = as_v_int_val(as_vec_get_hook(p, "length"));
        if (i >= n) return 0;
        char key[24];
        snprintf(key, sizeof key, "%d", i);
        *out = as_vec_get_hook(p, key);
        *idx = i + 1; return 1;
    }
    if (as_arrback_hook != NULL) {
        as_array* ab = as_arrback_hook(p);
        if (ab != NULL) {
            if (i >= ab->length) return 0;
            *out = ab->data[i]; *idx = i + 1; return 1;
        }
    }
    as_object* rec = NULL;
    if (((as_object_header*)p)->vtable == (void*)&as_object_vt) rec = (as_object*)p;
    else {
        as_vtable_header* hv = (as_vtable_header*)((as_object_header*)p)->vtable;
        if (hv->is_proxy) {
            // for-each over a Proxy: the same protocol, reading nextValue instead
            // of nextName (measured on adl 51.4.1, temp/proxyany A2/A4/B3/B4: the
            // ni/nv call sequence and the yielded values are identical for a
            // statically typed, a '*' and an Object slot).
            int ni = as_proxy_next_index(p, i);
            if (ni == 0) return 0;
            *out = as_proxy_next_value(p, ni);
            *idx = ni;
            return 1;
        }
        if (hv->dyn_offset >= 0) rec = *(as_object**)((char*)p + hv->dyn_offset);
    }
    if (rec == NULL || i >= rec->length) return 0;
    *out = rec->vals[i]; *idx = i + 1; return 1;
}

// for (k in <expr>): enumerate the object's ENUMERABLE KEYS, each as an ordinary
// key ATOM, in AIR's own order -- an Array's in-range non-hole indices as NUMBERS
// followed by its named properties, a Vector's indices as numbers, a Dictionary's
// keys with whatever type they were created with, a dynamic object's and a dynamic
// class instance's string names (the class instance's _dyn table, so its DECLARED
// fields are never enumerated). Everything else -- a sealed class instance, a
// String, a number, null -- enumerates nothing at all.
//
// Every one of those cases is measured on adl 51.4.1 (temp/airref/Main.as):
// [10,20] with a.foo=7 -> 0, 1, foo; Vector.<int> -> 0; {a:1,b:2} -> a, b; a
// Dictionary -> its one key; a dynamic instance -> only the property added at run
// time; a sealed instance (and a String) -> an empty enumeration. The atom's type
// is what makes a String-declared loop variable and a star-declared one differ, and
// the emitter converts the atom to the loop variable's declared type.
//
// Same index-cursor protocol as as_foreach_next, so the emitted body stays a plain
// C loop whose break/continue are real C break/continue.
static int as_enum_next(as_value coll, int* idx, as_value* out) {
    if (coll.tag == 6) {                 // boxed Array: indices first, then props
        as_array* a = (as_array*)coll.ptr;
        if (a == NULL) return 0;
        while (*idx < a->length) {
            int i = (*idx)++;
            if (a->data[i].tag == 5) continue;   // an undefined element is a hole
            *out = as_v_num((double)i);
            return 1;
        }
        int j = *idx - a->length;
        if (a->props == NULL || j >= a->props->length) return 0;
        *out = as_v_str(a->props->keys[j]);
        (*idx)++;
        return 1;
    }
    if (coll.tag != 4 || coll.ptr == NULL) return 0;
    void* p = coll.ptr;
    int dk = as_dyn_kind(p);
    if (dk == 3) {                        // Vector.<T>: its indices
        if (as_vec_get_hook == NULL) return 0;
        int n = as_v_int_val(as_vec_get_hook(p, "length"));
        if (*idx >= n) return 0;
        *out = as_v_num((double)*idx);
        (*idx)++;
        return 1;
    }
    if (dk == 1) {                        // Dictionary: the keys keep their type
        as_dict* d = (as_dict*)p;
        if (*idx >= d->length) return 0;
        *out = d->keys[*idx];
        (*idx)++;
        return 1;
    }
    if (as_arrback_hook != NULL) {        // 'class X extends Array': like an Array
        as_array* ab = as_arrback_hook(p);
        if (ab != NULL) return as_enum_next(as_v_arr(ab), idx, out);
    }
    as_object* rec = NULL;
    if (((as_object_header*)p)->vtable == (void*)&as_object_vt) rec = (as_object*)p;
    else {
        as_vtable_header* hv = (as_vtable_header*)((as_object_header*)p)->vtable;
        if (hv->is_proxy) {
            // A Proxy subclass runs the SAME nextNameIndex/nextName protocol the
            // emitter emits inline for a statically typed receiver. AIR decides by
            // the VALUE's class ('vp is Proxy'), not by the declared type, so a
            // '*' / Object slot has to run it here. Measured on adl 51.4.1
            // (temp/proxyany): A1..A5 (P / * / Object receivers) and B1/B2 are
            // identical, including the ni/nn call sequence.
            int ni = as_proxy_next_index(p, *idx);
            if (ni == 0) return 0;
            *out = as_v_str(as_proxy_next_name(p, ni));
            *idx = ni;
            return 1;
        }
        if (hv->dyn_offset >= 0) rec = *(as_object**)((char*)p + hv->dyn_offset);
    }
    if (rec == NULL || *idx >= rec->length) return 0;
    *out = as_v_str(rec->keys[*idx]);
    (*idx)++;
    return 1;
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
    if (dk == 2) {
        // An Array in an Object slot has no vtable (first word = element buffer),
        // so it needs the full keyed accessor: a canonical index is an element, a
        // 'length' is the length, anything else a named property. as_array_prop_get
        // alone answered undefined for 'o[0]' and 'o.length' (G14). 'constructor'
        // is Object's own trait, so it answers Array just as the branch below
        // does for a vtable-bearing receiver.
        if (strcmp(key, "constructor") == 0) return as_v_class_of(as_v_arr(obj));
        return as_array_key_get((as_array*)obj, key);
    }
    if (dk == 3) return as_vec_get_hook != NULL ? as_vec_get_hook(obj, key) : as_v_null();
    // 'constructor' is Object's own instance trait, not a reflected field: every
    // object answers it with its Class reference (AIR: 'var o:* = new Foo();
    // o.constructor === Foo' -> true). Handled here, after the dict/array/vector
    // dispatch, because those heap kinds start with a data pointer rather than a
    // vtable -- as_v_class_of() must only see real as_object_header layouts.
    if (strcmp(key, "constructor") == 0) return as_v_class_of(as_v_obj(obj));
    // ONE chain walk, three traits per level, and the FIRST level that declares the
    // name wins. That order is what AS3 means by "nearest declaration", and doing
    // it per trait (all fields of the whole chain first, then all getters) was
    // wrong: EventDispatcher.parent is an internal C link field while
    // DisplayObject.parent (and File.parent) is a GETTER, so a dynamic read of
    // "parent" answered the stale internal null and never reached the getter --
    // measured on adl 51.4.1, where it returns the real container.
    void* vt = ((as_object_header*)obj)->vtable;
    while (vt != NULL) {
        as_prop* props = (as_prop*)((as_vtable_header*)vt)->props;
        if (props != NULL) {
            for (int i = 0; props[i].name != NULL; i++) {
                if (strcmp(props[i].name, key) == 0) return as_prop_read(obj, &props[i]);
            }
        }
        // Getter reflection: dynamic obj["prop"] reaches read-only properties
        // (File.exists / File.isDirectory / File.isHidden / File.url) that are not
        // declared fields. The getter thunk shares the as_method signature and boxes
        // its typed return value.
        as_method* getters = (as_method*)((as_vtable_header*)vt)->getters;
        if (getters != NULL) {
            for (int i = 0; getters[i].name != NULL; i++) {
                if (strcmp(getters[i].name, key) == 0) return getters[i].fn(obj, NULL, 0);
            }
        }
        // Method reflection: dynamic obj["method"] used as a Function value (e.g.
        // asset["getDirectoryListing"]()) returns a bound-method closure whose env is
        // the receiver, so as_fn_call_dyn invokes the real implementation.
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
    // 'class X extends Array': the instance's own backing array is its property
    // map, so an undeclared name (a numeric index, "length", or a dynamic
    // property) is answered from there. This must precede the _dyn branch below:
    // an Array subclass is dynamic, and everything the Array side owns -- indices,
    // length, named properties -- belongs to the backing array, not to the slot
    // table (leaving _dyn empty is what keeps the two views identical).
    if (as_arrback_hook != NULL) {
        as_array* ab = as_arrback_hook(obj);
        if (ab != NULL) return as_array_key_get(ab, key);
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
    // 'class X extends Array': same membership rule as a literal Array ('length'
    // true, a canonical in-range index true, a stored named property true),
    // checked before the _dyn table for the same reason as the read above.
    if (as_arrback_hook != NULL) {
        as_array* ab = as_arrback_hook(obj);
        if (ab != NULL) return as_array_has(ab, key);
    }
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

// Object.propertyIsEnumerable(name): hasOwnProperty MINUS the trait walk -- TRUE
// only when name is a DYNAMIC property of the object. An instance trait (field,
// accessor, method) is never enumerable in this sense, not even on a dynamic
// class. Measured on adl 51.4.1 (temp/airref/Main.as, all recorded on the
// registration in symbols.ts): a sealed class -> false for field/getter/method and
// a missing name; a dynamic class -> false for its declared fields, true for an
// added property; a record -> true for a key, false for toString; an Array -> true
// for an in-range index and an added named property, FALSE for length; a Vector
// and a String -> false.
static bool as_dyn_enumerable(void* obj, const char* key) {
    if (obj == NULL || key == NULL) return false;
    int dk = as_dyn_kind(obj);
    if (dk == 1) return as_dict_find((as_dict*)obj, as_v_str((char*)key)) >= 0;
    // Vector.<T>: every element and length are sealed traits in AIR, and a Vector
    // is not dynamic at all (measured), so nothing here is ever enumerable.
    if (dk == 3) return false;
    if (dk == 2) {
        as_array* a = (as_array*)obj;
        if (strcmp(key, "length") == 0) return false;   // AIR: a trait, not enumerable
        int i;
        if (as_array_index_key(key, &i)) return i >= 0 && i < a->length;
        return a->props != NULL && as_object_has(a->props, key);
    }
    as_vtable_header* hv = (as_vtable_header*)((as_object_header*)obj)->vtable;
    // A plain record (an Object literal): every slot is dynamic.
    if (hv == (as_vtable_header*)&as_object_vt) return as_object_has((as_object*)obj, key);
    if (hv->is_proxy) return as_proxy_has_miss(obj, key);
    // 'class X extends Array': same rule as a literal Array.
    if (as_arrback_hook != NULL) {
        as_array* ab = as_arrback_hook(obj);
        if (ab != NULL) {
            if (strcmp(key, "length") == 0) return false;
            int i;
            if (as_array_index_key(key, &i)) return i >= 0 && i < ab->length;
            return ab->props != NULL && as_object_has(ab->props, key);
        }
    }
    // A dynamic class: only its _dyn slot table holds enumerable properties.
    if (hv->dyn_offset >= 0) {
        as_object* dyn = *(as_object**)((char*)obj + hv->dyn_offset);
        return dyn != NULL && as_object_has(dyn, key);
    }
    return false;
}

// The dynamic-property table of a class instance, or NULL when it has none. AIR's
// for-in yields EXACTLY the enumerable set (measured on adl 51.4.1: a dynamic class
// instance enumerates only the properties added at run time -- its DECLARED fields
// are not enumerated even though they are own properties -- and a sealed instance
// enumerates nothing at all), and that set is the _dyn slot table. Records, arrays
// and dictionaries have their own enumeration branches in the emitter.
static as_object* as_dyn_table(void* obj) {
    if (obj == NULL) return NULL;
    as_vtable_header* hv = (as_vtable_header*)((as_object_header*)obj)->vtable;
    // A Proxy subclass enumerates through AIR's nextNameIndex protocol instead;
    // the emitter handles that case, this is only the safety net.
    if (hv->is_proxy) return NULL;
    if (hv->dyn_offset < 0) return NULL;
    return *(as_object**)((char*)obj + hv->dyn_offset);
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
        // ACCESSOR BEFORE FIELD, PER LAYER. AS3 resolves a property write to the
        // accessor whenever one exists -- a same-named storage slot is an
        // implementation detail of ours, never an AS3-visible alternative. This
        // runtime deliberately keeps text/type/borderColor/backgroundColor/
        // textColor (TextField), length (ByteArray), delay/repeatCount (Timer),
        // quality/align (Stage), filters (DisplayObject), totalFrames (MovieClip)
        // and x/y/visible (Stage3D) as field+setter pairs, and the setter is where
        // the side effects live: _para/_runs invalidation, buffer resize, Timer
        // restart, RGB alpha drop, range validation. Walking the field table
        // first meant a DYNAMIC write (obj[key] = v, as every baked SWC child
        // field is reached) silently skipped all of it -- measured on the real
        // app: item.note.text = ... on an htmlText field kept the old [0,12)
        // run and rendered two U+FFFD (temp/shareitem). Nearest layer wins, and
        // within a layer the accessor wins, which is exactly AS3's rule.
        as_method* setters = (as_method*)((as_vtable_header*)vt)->setters;
        if (setters != NULL) {
            for (int i = 0; setters[i].name != NULL; i++) {
                if (strcmp(setters[i].name, key) == 0) { setters[i].fn(obj, &v, 1); return; }
            }
        }
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
                        // 13: DisplayObject.name -- same string storage, but AIR
                        // validates it against null/undefined (TypeError #2007)
                        // instead of storing null (adl 51.4.1,
                        // temp/qfix/gcadl/result16.txt). Error.name is tag 3.
                        case 13: { char* ns = as_req_name(as_coerce_str(v)); if (ns == NULL) return; *(char**)(base + props[i].offset) = ns; gc_write_barrier((void*)ns); return; }
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
    // Setter reflection already ran inside the layer walk above (accessor before
    // field, per layer), which is also what serves Starling's Juggler tweens
    // (DisplayObject.alpha/x/y/scaleX, Sprite3D.rotationX...) through an
    // Object-typed target. A getter without a setter stays read-only, as in AS3.
    as_vtable_header* hv = (as_vtable_header*)((as_object_header*)obj)->vtable;
    // The name may still be a REAL trait that simply cannot be written. AIR
    // distinguishes that from an unknown name with two other errors, measured on
    // adl 51.4.1 (temp/smeprobe/adl4.txt):
    //   obj[k] = v with k = a read-only accessor (own or inherited)
    //       -> ReferenceError #1074 "Illegal write to read-only property k on F."
    //   obj[k] = v with k = a method
    //       -> ReferenceError #1037 "Cannot assign to a method k on F."
    //   obj[k] = v with k = nothing at all
    //       -> ReferenceError #1056 "Cannot create property k on F."  (below)
    // F is always the RECEIVER's class. Checked BEFORE the dynamic/Array/proxy
    // fallbacks so an accessor wins over a '_dyn' slot, exactly as it wins over a
    // same-named field above.
    for (as_vtable_header* t = hv; t != NULL; t = (as_vtable_header*)t->super) {
        as_method* gs = (as_method*)t->getters;
        if (gs != NULL) for (int i = 0; gs[i].name != NULL; i++)
            if (strcmp(gs[i].name, key) == 0) { as_throw_readonly_set(key, hv->fqn); return; }
    }
    for (as_vtable_header* t = hv; t != NULL; t = (as_vtable_header*)t->super) {
        as_method* ms = (as_method*)t->methods;
        if (ms != NULL) for (int i = 0; ms[i].name != NULL; i++)
            if (strcmp(ms[i].name, key) == 0) { as_throw_method_assign(key, hv->fqn); return; }
    }
    // Proxy receiver: a write that is not a real field/setter is served by
    // setProperty (AIR never lands it in the '_dyn' slot table, measured).
    if (hv->is_proxy) { as_proxy_set_miss(obj, key, v); return; }
    if (hv == (as_vtable_header*)&as_object_vt) {
        as_object_set((as_object*)obj, key, v);
        return;
    }
    // 'class X extends Array': an undeclared write goes to the instance's backing
    // array (same key classifier as a literal Array, so 'length' resizes and a
    // canonical index lands in the elements). Before the _dyn branch, for the same
    // reason as the read above.
    if (as_arrback_hook != NULL) {
        as_array* ab = as_arrback_hook(obj);
        if (ab != NULL) { as_array_key_set(ab, key, v); return; }
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
    // 'class X extends Array': deleting an element/property of the backing array
    // (identical to 'delete arr[key]'), before the _dyn table as above. A DECLARED
    // field is a fixed trait, so deleting it reports false and keeps it (only the
    // Array-side property map is deletable -- same rule as a sealed class).
    if (as_arrback_hook != NULL) {
        as_array* ab = as_arrback_hook(obj);
        if (ab != NULL) {
            void* pvt = ((as_object_header*)obj)->vtable;
            while (pvt != NULL) {
                as_prop* pprops = (as_prop*)((as_vtable_header*)pvt)->props;
                if (pprops != NULL)
                    for (int i = 0; pprops[i].name != NULL; i++)
                        if (strcmp(pprops[i].name, key) == 0) return false;
                pvt = ((as_vtable_header*)pvt)->super;
            }
            return as_v_bool_val(as_array_del(ab, key));
        }
    }
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
    return (a == NULL || a->props == NULL) ? as_v_undefined() : as_object_get(a->props, key);
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
// The Array instance-method names as_array_has reports and as_arr_call dispatches.
// 'every'/'some'/'forEach'/'lastIndexOf' are deliberately absent: the dynamic
// call path does not implement them yet (the statically typed path does), and
// claiming them here would turn a loud #1065 into a silent no-op.
static bool as_array_method_name(const char* key) {
    static const char* const names[] = {
        "toString", "valueOf", "join", "push", "pop", "shift", "unshift",
        "indexOf", "insertAt", "removeAt", "slice", "splice", "reverse",
        "concat", "map", "filter", "sort", "sortOn",
        "hasOwnProperty", "propertyIsEnumerable", "constructor", NULL
    };
    for (int i = 0; names[i] != NULL; i++) if (strcmp(names[i], key) == 0) return true;
    return false;
}
static bool as_array_has(as_array* a, const char* key) {
    if (a == NULL) return false;
    if (strcmp(key, "length") == 0) return true;
    int i;
    if (as_array_index_key(key, &i)) {
        if (i < 0 || i >= a->length) return false;
        return a->data[i].tag != 5;
    }
    // Array's INSTANCE METHODS are members too: AIR answers 'push' in [1,2] == true
    // (measured on adl 51.4.1, temp/proxyany/MainI3 K1..K4: push, join, toString and
    // constructor are all true while an unknown name stays false). Without this a
    // 'with (arr) { push(30) }' fell through to the enclosing scope and threw #1065.    // Keep this list in step with as_arr_call's dispatch table below.
    if (as_array_method_name(key)) return true;
    return a->props != NULL && as_object_has(a->props, key);
}


// Dynamically-typed ('any') index read: dispatch on the boxed value's runtime
// tag — record slot, array element, or object field reflection.
static as_value as_any_get(as_value box, const char* key) {
    // 'constructor' is Object's own trait, not a slot: every value answers its
    // runtime class (AIR: Object("a").constructor is [class String],
    // [1].constructor is [class Array]; measured on adl 51.4.1). Handled before the
    // tag dispatch because a boxed primitive has no slot table to read at all.
    if (strcmp(key, "constructor") == 0) return as_v_class_of(box);
    switch (box.tag) {
        case 4: return as_dyn_get(as_v_obj_val(box), key);
        case 6: {
            // Same keyed accessor as as_dyn_get's array branch: an Array in a '*'
            // slot answers 'length' and canonical indices too ('a["length"]' was
            // undefined before G14, and so was 'a["0"]').
            as_array* arr = (as_array*)as_v_obj_val(box);
            return as_array_key_get(arr, key);
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
//
// The numeric branch is kept inlinable on purpose, exactly like as_v_int_cast
// above. as_v_to_number grew the tag==4 (object -> valueOf/toString) and tag 5/7
// (undefined/function -> NaN) arms, and clang's inline cost for it crossed the
// 225 budget: an out-of-line call per operand in the hot loop, so benchmarks/
// array's 20M-iteration dynamic 'sum += a[j] + b[j]' paid 40M calls (193 ms vs
// 119 ms inlined, measured on this host 2026-10). The tag 1/2 fast path is
// exactly as_v_to_number's own first two arms (Number -> num, Boolean -> num),
// so the wrapper is semantics-preserving and keeps the call out of the loop.
// Every other numeric-ish tag (8/9 -> i64/u64, 5 -> undefined -> NaN) still
// routes to as_v_to_number; the object/string tags were already diverted to the
// concat branch above.
static as_value as_add_v(as_value a, as_value b) {
    bool a_obj = a.tag == 3 || a.tag == 4 || a.tag == 6 || a.tag == 7;
    bool b_obj = b.tag == 3 || b.tag == 4 || b.tag == 6 || b.tag == 7;
    if (a_obj || b_obj) return as_v_str(as_str_concat(as_v_str_val(a), as_v_str_val(b)));
    double na = (a.tag == 1 || a.tag == 2) ? a.num : as_v_to_number(a);
    double nb = (b.tag == 1 || b.tag == 2) ? b.num : as_v_to_number(b);
    return as_v_num(na + nb);
}

// Array.sortOn(field, options): sort objects in place by a named property. The
// field value is fetched reflectively via as_dyn_get. Options are the same five
// bits Array.sort honors (see as_cmp_opts); the one deliberate asymmetry is that
// a value that will not convert to Number does NOT raise #1034 here -- AIR's
// sortOn compares it as NaN (measured: keys 9 10 a B).
static as_value as_array_sortOn_v(as_array* a, const char* field, int options) {
    as_sort_ctx ctx;
    ctx.flags = options; ctx.field = field; ctx.cb = NULL;
    return as_array_sort_ex(a, &ctx);
}
static as_array* as_array_sortOn_arr(as_array* a, const char* field, int options) {
    return (as_array*)as_v_obj_val(as_array_sortOn_v(a, field, options));
}

// Dynamic dispatch of the Array built-in method set on a star-typed receiver
// ('var a:* = [..]; a.push(x)'). The static path picks the helper at compile time
// (emitArrayMethod); a dynamic receiver only carries the boxed tag, so the name
// is resolved here. Without this, as_any_call handed an as_array* to as_dyn_call,
// which reads the vtable header out of the element buffer -- 'a.toString()'
// segfaulted and 'a.push(1)' silently did nothing (adl 51.4.1, temp/pkgA/arr3).
static as_value as_arr_call(void* av, const char* name, as_value* args, int argc) {
    as_array* a = (as_array*)av;
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
        return as_array_sort_flags(a, argc > 0 ? as_v_to_int(args[0]) : 0);
    }
    if (strcmp(name, "sortOn") == 0) {
        // A null/undefined field name reaches us as a NULL char*; the static path
        // spells it "null" (toStringExpr), and as_dyn_get must never see NULL.
        const char* fld = argc > 0 ? as_v_str_val(args[0]) : NULL;
        return as_array_sortOn_v(a, fld != NULL ? fld : "null", argc > 1 ? as_v_to_int(args[1]) : 0);
    }
    // Object's inherited four: an Array answers hasOwnProperty (an index or an added
    // named property), propertyIsEnumerable (the same, but "length" is a trait) and
    // valueOf (handled above); measured on adl 51.4.1 -- temp/g14/DictAir.as.
    return as_dyn_object_builtin(av, 2, name, args, argc);
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
// AVM2's ClampIndex (core/NativeObjectHelpers.h): negative values count from the end.
// Out-of-range results clamp to [0, length]; NaN lands on 0.
static int as_clamp_index(int n, int length) {
    if (n < 0) {
        if (n + length < 0) return 0;
        return n + length;
    }
    if (n > length) return length;
    return n;
}
// AVM2's substr is NOT the ES3 one: String::AS3_substr runs BOTH 'start' and
// 'start + count' through ClampIndex (see avmplus core/StringObject.cpp), so a negative
// length counts back from the end -- "2023-02-10 17:50:00".substr(0,-3) is
// "2023-02-10 17:50", not "" (ES3 would clamp a negative length to 0). Measured
// against adl 51.4.1; the real app relies on it for the 我的会议 start-time label.
static char* as_str_substr(const char* s, int from, int len) {
    int slen = (int)strlen(s);
    int start = as_clamp_index(from, slen);
    // 0x7fffffff is the AS3 default for count; guard the addition against overflow.
    int end = (len == 0x7fffffff) ? slen : as_clamp_index(start + len, slen);
    if (end < start) end = start;
    int n = end - start;
    char* r = as_str_alloc(n + 1);
    memcpy(r, s + start, n);
    r[n] = 0;
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

// Thread-local storage for the exception-unwinding state. The AS3 dispatcher
// thread and every ANE worker thread run through this runtime, so all of it
// (the frame stack, the frame-boundary guard, the pending throw) must be
// per-thread -- see the comments at each group.
#if defined(_MSC_VER)
#define ASC_TLS __declspec(thread)
#elif defined(__wasm__) || defined(__wasm32__)
#define ASC_TLS /* wasm32 has no threads; a plain static is the same thing */
#else
#define ASC_TLS __thread
#endif
// Per-THREAD: an ANE worker thread can enter this runtime through an FRE call
// at the same time the dispatcher thread is inside AS3 code, and unwinding from
// one thread to the other is undefined behaviour (the frame lives on the other
// stack). The FRE entry points catch within the call, so a worker's pending
// value never survives a GC step.
static ASC_TLS void* as_exception = NULL;
// User throw propagates an arbitrary VALUE (any Error, but also a plain string,
// number, object or null). AVM2 boxes it, and a catch clause binds it back with
// its identity intact -- for a thrown string, a dynamic catch still answers
// "e is String" with true (measured on adl 51.4.1, temp/qfix/catchsem). A bare
// object pointer cannot represent that, nor distinguish a thrown null from "no
// exception", so a
// boxed slot runs alongside the object slot. as_exception_boxed selects which
// holds the pending throw: 0 => as_exception (an object; every internal runtime
// error is thrown this way), 1 => as_exception_v (a user-thrown value).
static ASC_TLS as_value as_exception_v = {0, 0.0, NULL};
static ASC_TLS int as_exception_boxed = 0;
// The unwinding stack is per-THREAD and grows on demand. It used to be a
// process-global "jmp_buf*[64]" written with unchecked "stack[depth++]" pushes.
// ANE worker threads (FRE callbacks such as FRESetObjectProperty) and the AS3
// dispatcher thread both use it, so one global counter served two threads:
// past the 64th frame the write landed on the depth counter itself and then at
// wild .data addresses, silently corrupting neighbouring runtime statics, and a
// throw could longjmp into another thread's frame. Per-thread + unbounded
// removes both failure modes.
static ASC_TLS jmp_buf** as_jmp_stack = NULL;
static ASC_TLS int as_jmp_depth = 0;
static ASC_TLS int as_jmp_cap = 0;
static void as_jmp_push(jmp_buf* jb) {
    if (as_jmp_depth == as_jmp_cap) {
        int ncap = as_jmp_cap == 0 ? 64 : as_jmp_cap * 2;
        jmp_buf** ns = (jmp_buf**)realloc(as_jmp_stack, sizeof(jmp_buf*) * (size_t)ncap);
        if (ns == NULL) {
            // Dropping the frame would unwind to the wrong place, and AIR dies
            // on memory exhaustion too -- report rather than corrupt.
            fprintf(stderr, "AS3 out of memory: exception stack\\n");
            fflush(stderr);
            exit(1);
        }
        as_jmp_stack = ns;
        as_jmp_cap = ncap;
    }
    as_jmp_stack[as_jmp_depth++] = jb;
}
static void as_jmp_pop(void) {
    // Push/pop sites are balanced, but a stray pop must never go negative.
    if (as_jmp_depth > 0) as_jmp_depth--;
}
// Recovery point for an UNCAUGHT error. AIR does not terminate the process on an
// uncaught error -- it reports it and keeps running, so one bad listener costs its
// own dispatch rather than the whole application. (Calling exit(1) here instead
// used to strand the process: with 50+ live threads the native teardown deadlocks
// in CEF/ANE DLL-detach, which is what a Windows AOT build did on the very first
// uncaught #1009 → the window stayed visible and unresponsive instead of dying.)
//
// EVERY entry point that runs AS3 code plants this jmp_buf, not just the frame:
//   Stage_dispatchFrame              the frame clock itself
//   ASC_window_on_mouse/_wheel/_key  SDL callbacks, which run OUTSIDE any frame
//   ASC_window_on_frame              the per-window sweep (NativeWindow events) + frame
//   ASC_window_on_resize/_close      the window-manager notifications the glue sends
// Each one checks as_frame_guard before setjmp'ing, so exactly ONE guard stands per
// thread and a nested entry reuses the outer buffer. Every exit path of those
// functions clears the guard again (a guard left planted against a returned stack
// frame would silently disable all later recovery). With no guard at all (a
// non-GUI program, or an error before the first window exists) exit(1) applies.
static ASC_TLS jmp_buf as_frame_jmp;
static ASC_TLS int as_frame_guard = 0;

static const char* as_error_message(void* e) {
    return e ? ((as_error_view*)e)->message : "unknown";
}

// Uncaught-error reporting throttle.
//
// An uncaught error inside a frame is recovered at the frame boundary, so a
// repeating bug (a null receiver in a frame callback or a mouse handler) throws
// once per call and, without this, writes one stderr line per throw: measured on
// a real app, 623 identical "#1009" lines in 40 s, which pushed every other
// diagnostic out of the log window. The first occurrence of a message is always
// printed; repeats of the SAME message are counted and folded into the next
// line, at most one line per second. The count is preserved, so the storm is
// still visible as a number -- only the repetition is gone.
//
// Per-thread (ASC_TLS): errors can be thrown from the frame thread and from IO
// callbacks at the same time, and two threads sharing one "last message" buffer
// would truncate each other's text mid-write.
static ASC_TLS double as_uncaught_last_ms = 0.0;
static ASC_TLS unsigned long as_uncaught_suppressed = 0;
static ASC_TLS char as_uncaught_last_msg[192];
static ASC_TLS int as_uncaught_flush_armed = 0;

// Print whatever the throttle is still holding. Registered with atexit on the
// first report: a storm that fits inside one second would otherwise end with its
// count dropped, so the log would claim one error where there were fifty.
// (TLS: this flushes the exiting thread's counters. Other threads' pending counts
// are lost at exit -- they are diagnostic only, and a per-thread exit hook would
// cost more than the information is worth.)
static void as_uncaught_flush(void) {
    if (as_uncaught_suppressed != 0) {
        fprintf(stderr, "Uncaught exception: %s (%lu more of the same)\\n",
                as_uncaught_last_msg[0] != 0 ? as_uncaught_last_msg : "unknown",
                as_uncaught_suppressed);
        fflush(stderr);
        as_uncaught_suppressed = 0;
    }
}
static void as_report_uncaught(const char* m) {
    const char* s = as_str_or_null(m);
    const double now = as_now_ms();
    const int same = as_uncaught_last_msg[0] != 0 && strcmp(as_uncaught_last_msg, s) == 0;
    if (!as_uncaught_flush_armed) {
        as_uncaught_flush_armed = 1;
        atexit(as_uncaught_flush);
    }
    // Fold repeats of the SAME message, but never more than 20 in a row: a storm
    // that is denser than one per second still shows its count, and the cap is what
    // makes the accounting independent of how long the program runs.
    if (same) {
        // Count FIRST, then decide: the throw that trips the cap is itself one of the
        // repeats, so checking before the increment under-reported by one per line.
        as_uncaught_suppressed++;
        if (now - as_uncaught_last_ms < 1000.0 && as_uncaught_suppressed <= 20) return;
    }
    if (as_uncaught_suppressed != 0) {
        fprintf(stderr, "Uncaught exception: %s (%lu more of the same)\\n",
                s, as_uncaught_suppressed);
        as_uncaught_suppressed = 0;
    } else {
        fprintf(stderr, "Uncaught exception: %s\\n", s);
    }
    fflush(stderr);
    snprintf(as_uncaught_last_msg, sizeof as_uncaught_last_msg, "%s", s);
    as_uncaught_last_ms = now;
}
static char* as_v_str_val(as_value v);
// Throw an arbitrary boxed value (the throw-statement path). Kept separate from
// as_throw(void*) so the ~36 internal runtime-error throws stay byte-identical;
// only the catch side has to look at both slots.
static _Noreturn void as_throw_val(as_value v) {
    as_exception_v = v;
    as_exception_boxed = 1;
    if (as_jmp_depth == 0) {
        // Internal errors keep the historical wording (an object's reflective
        // message); a non-object thrown value has no message slot, so stringify
        // it. (The adl-exact uncaught format is a separate, still-open item.)
        const char* m = as_str_or_null((v.tag == 4 && v.ptr != NULL) ? as_error_message(v.ptr) : as_v_str_val(v));
        // An uncaught error inside a frame is recovered at the frame boundary
        // (see as_frame_jmp): report it and let the loop carry on.
        if (as_frame_guard != 0) {
            as_report_uncaught(m);
            as_frame_guard = 0;
            longjmp(as_frame_jmp, 1);
        }
        as_report_uncaught(m);
        exit(1);
    }
    longjmp(*as_jmp_stack[as_jmp_depth - 1], 1);
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
    as_exception_boxed = 0;
    if (as_jmp_depth == 0) {
        // Recover at the frame boundary when a frame is on the stack.
        if (as_frame_guard != 0) {
            as_report_uncaught(as_error_message(e));
            as_frame_guard = 0;
            longjmp(as_frame_jmp, 1);
        }
        as_report_uncaught(as_error_message(e));
        exit(1);
    }
    longjmp(*as_jmp_stack[as_jmp_depth - 1], 1);
}

// ---------- GC mark / sweep / collect (incremental, GC-4) ----------

// Push a grey object onto the mark work stack, growing it on demand.
static void gc_grey_push(gc_header* h) {
    if (gc_inc.grey_top == gc_inc.grey_cap) {
        int new_cap = gc_inc.grey_cap == 0 ? 256 : gc_inc.grey_cap * 2;
        gc_header** grown = (gc_header**)realloc(gc_inc.grey, (size_t)new_cap * sizeof(gc_header*));
        if (grown == NULL) as_gc_oom((size_t)new_cap * sizeof(gc_header*));
        gc_inc.grey = grown;
        gc_inc.grey_cap = new_cap;
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
static int gc_audit_body_reports = 0;   // NON-BODY budget (阶段一百四十七)
// Separate budgets: the free_bytes drift lines are numerous and only
// informative in bulk, while a DANGLING/RELEASING report IS the finding --
// it must never be crowded out by drift noise (crowding out is exactly what
// hid the first diagnosis).
static int gc_audit_drift_reports = 0;
static int gc_audit_release_reports = 0;
// gc_audit_mode_cache is defined with the forward declarations at the top of the
// preamble: the allocation path tests it before the audit code is declared.
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

// Does this pointer look like the BODY of a real block? The marker is handed raw
// object pointers; an interior pointer (a substring into a string, a malloc'd
// buffer that happens to sit inside a segment, a body used where a header
// belongs) is unmarkable -- gc_hdr(p) = p - sizeof(gc_header) rereads somebody
// else's bytes as type/colour/size and the marker then greys a bogus "block",
// corrupting whatever lives there. Measured on TalkMED (阶段一百四十七): the FPS
// overlay writes an htmlText string every frame, and a link in the heap ended up
// holding the string's first 8 bytes -- the SIGSEGV address was literally the
// ASCII of "FPS: 121". A body has a known type tag, a colour 0..2, an 8-aligned
// size, and does not overrun its segment.
static bool gc_audit_is_body(const void* p) {
    gc_seg_range* r = gc_seg_find(p);
    if (r == NULL || (const char*)p < r->base + sizeof(gc_header) || (const char*)p >= r->base + r->size) return false;
    const gc_header* h = (const gc_header*)((const char*)p - sizeof(gc_header));
    if (h->type != 0 && (h->type < GCT_TAG_BASE || h->type > GCT_TAG_BASE + 16)) return false;
    if (h->color < 0 || h->color > 2) return false;
    if (h->size == 0 || (h->size & 7) != 0) return false;
    // The header sits *before* p, so only the body has to fit (a block that ends
    // exactly at its segment's end is normal, and it is the common case for the
    // last block of a small segment).
    if (h->size > (size_t)((r->base + r->size) - (const char*)p)) return false;
    return true;
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
        if (h->type != 0) {
            // A live block -- but is the pointer we were handed really this
            // block's body? An interior pointer (a substring, a body passed where
            // a header belongs) greys a bogus "block" at p - 24 and the next
            // sweep links that garbage into a free list (阶段一百四十七).
            if (!gc_audit_is_body(p) && gc_audit_body_reports++ < 40) {
                fprintf(stderr, "[gc-audit] NON-BODY pointer %p (hdr type=0x%x color=%d size=%zu) handed to the marker/barrier\\n",
                        p, h->type, h->color, h->size);
                gc_audit_where();
                {
                    // What IS this memory? Dump the surroundings as text: a response
                    // header block, a JSON payload and a struct differ at a glance.
                    const unsigned char* d = (const unsigned char*)p - 40;
                    fprintf(stderr, "                 raw ra=%p bytes:", (void*)ASC_RETURN_ADDRESS(0));
                    for (int _i = 0; _i < 40; _i++) {
                        unsigned char _c = d[_i];
                        fputc((_c >= 32 && _c < 127) ? (int)_c : '.', stderr);
                    }
                    fputs(" | ", stderr);
                    for (int _i = 40; _i < 80; _i++) {
                        unsigned char _c = d[_i];
                        fputc((_c >= 32 && _c < 127) ? (int)_c : '.', stderr);
                    }
                    fputc('\\n', stderr);
                }
                gc_audit_gate_frame(0, ASC_RETURN_ADDRESS(0));
                gc_audit_gate_frame(1, ASC_RETURN_ADDRESS(1));
                gc_audit_gate_frame(2, ASC_RETURN_ADDRESS(2));
                gc_audit_gate_frame(3, ASC_RETURN_ADDRESS(3));
                gc_audit_gate_frame(4, ASC_RETURN_ADDRESS(4));
                fflush(stderr);
            }
            return;
        }
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
        // any (7), string (3) and name-string (13) fields carry pointers.
        void* vt = ((as_object_header*)b)->vtable;
        while (vt != NULL) {
            as_prop* props = (as_prop*)((as_vtable_header*)vt)->props;
            if (props != NULL) {
                for (int i = 0; props[i].name != NULL; i++) {
                    char* base = b;
                    gc_audit_prop = props[i].name;
                    switch (props[i].type) {
                    // 13 is DisplayObject.name: the very same char* storage as 3, but
                    // its own tag because a dynamic write must reject null with
                    // TypeError #2007. It MUST be marked like 3 -- the tag exists for
                    // the WRITE side only. Leaving it out swept every DisplayObject
                    // name on the first collection that reached the object, and the
                    // freed slot was handed to the next short-lived string, so
                    // e.target.name in a click handler came back as an unrelated
                    // string (TalkMED: HomeView.clickTabList parses the tab index out
                    // of e.target.name, so every tab click collapsed to index 0 and
                    // opened the "打开网页" tab's StageWebView; measured on the live
                    // app and reproduced in temp/nameprobe, where a rooted
                    // TextField's name read back as a churned "ZZ: 0").
                    case 3: case 13: gc_mark_ptr(*(char**)(base + props[i].offset)); break;
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
// Native-extension roots: the AS3 ExtensionContext objects a live FREContext
// points at, plus every FREObject handle the running extension call created.
// Defined in the FRE preamble (fre.ts), which is emitted after this file, so it
// follows the same forward-declaration shape as the three walks above.
static void as_fre_mark_ctx_roots(void);
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
    as_fre_mark_ctx_roots();
    if (as_exception_boxed) gc_mark_value(as_exception_v);
    else gc_mark_ptr(as_exception);
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
        // gc_is_object rejects interior pointers (a char* cursor walking a
        // string): marking one would grey a bogus "block" whose "header" is
        // really payload bytes (阶段一百四十七).
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

// ---------- finalizing C++ resources owned by a GC block ----------
//
// The collector reclaims GC blocks; it knows nothing about resources a block
// owns through a POINTER into malloc'd / C++ memory. The renderer has three
// such owners, all of them measured leaks before this hook existed:
//
//   BitmapData._live_image  the SkImage view of a bitmap's own ARGB pixels
//   BitmapData.image        the decoded / encoded view of a loaded bitmap
//   DisplayObject._cache_image  the cacheAsBitmap / auto-bake surface snapshot
//
// Each is deleted on an explicit dispose(), a rebuild or a setter that turns the
// cache off -- and never when the owner is simply collected, because the GC has
// no finalizer. A 1920x1080 slide bitmap therefore left its 8.3 MB SkImage
// behind forever: measured on the meeting client (ASC_GAUGE of the process
// working set, temp/crashmon), flipping through a 39-page deck walked the
// 32-bit process up to 1.1 GB and the next 8.3 MB gc_alloc for the following
// page's pixel buffer raised Error #1000 inside the Loader COMPLETE handler, so
// the page never reached the screen -- "it stops changing when I reach the last
// page".
//
// A block the sweeper is about to recycle is unreachable BY DEFINITION, which is
// exactly the condition for running a finalizer. as_final_on_free() is that
// hook: the sweep calls it with the dying payload address and every resource
// registered under that address is released. Registration is keyed on the owner
// ADDRESS and an entry is dropped the moment its resource is released, so this
// table never dereferences a freed pointer -- it only compares addresses.
#define ASC_FINAL_SLOTS 4096
static void* ASC_final_owner[ASC_FINAL_SLOTS];
static void* ASC_final_res[ASC_FINAL_SLOTS];
static int ASC_final_used = 0;
static int ASC_final_released_n = 0;
static void as_skia_image_delete(void* img);
static void as_final_register(void* owner, void* res) {
    if (owner == NULL || res == NULL) return;
    if (ASC_final_used >= ASC_FINAL_SLOTS) {
        static int warned = 0;
        if (!warned) { warned = 1; fprintf(stderr, "[as3-aot] finalizer table full (%d); C++ resources will leak\\n", ASC_FINAL_SLOTS); }
        return;
    }
    ASC_final_owner[ASC_final_used] = owner;
    ASC_final_res[ASC_final_used] = res;
    ASC_final_used++;
}
// Release ONE resource of an owner (a rebuild replaces an image): the caller has
// already deleted it, this only forgets the registration so the owner's death
// does not delete it a second time.
static void as_final_release(void* owner, void* res) {
    for (int i = 0; i < ASC_final_used; i++) {
        if (ASC_final_owner[i] == owner && (res == NULL || ASC_final_res[i] == res)) {
            ASC_final_owner[i] = ASC_final_owner[ASC_final_used - 1];
            ASC_final_res[i] = ASC_final_res[ASC_final_used - 1];
            ASC_final_used--;
            return;
        }
    }
}
// ASC_NO_FINAL=1 turns the hook off: the leak then reproduces exactly as it was
// before this stage, which is how the fix is A/B-tested on one binary
// (examples/gc-image-free.as grows by ~8.3 MB per dropped 1920x1080 page).
static int as_final_disabled = -1;
static int as_final_on(void) {
    if (as_final_disabled < 0) as_final_disabled = getenv("ASC_NO_FINAL") != NULL;
    return as_final_disabled == 0;
}
// The sweep hook. Called once per recycled block with its payload address.
static void as_final_on_free(void* owner) {
    if (ASC_final_used == 0 || !as_final_on()) return;
    for (int i = 0; i < ASC_final_used; ) {
        if (ASC_final_owner[i] == owner) {
            void* res = ASC_final_res[i];
            ASC_final_owner[i] = ASC_final_owner[ASC_final_used - 1];
            ASC_final_res[i] = ASC_final_res[ASC_final_used - 1];
            ASC_final_used--;
            as_skia_image_delete(res);
            ASC_final_released_n++;
        } else {
            i++;
        }
    }
}

// Sweep a budget of the all-objects list: white objects return to the free-list,
// black objects reset to white for the next cycle. Returns true when the walk is
// complete. gc_all is stable during the walk because in-cycle allocations go to
// gc_new (see gc_alloc), never prepended into gc_all.
static bool gc_sweep_step(size_t budget) {
    while (budget-- > 0 && gc_inc.sweep_cursor != NULL) {
        gc_header* h = gc_inc.sweep_cursor;
        if (gc_audit_mode_cache != 0) gc_audit_gate("sweep cursor", h);
        gc_header* next = h->next;
        if (h->color == GC_WHITE) {
            // Release the C++ resources this block owns (see as_final_on_free).
            // The payload address is the block's body, which is what owners
            // register: gc_alloc returns (char*)h + sizeof(gc_header).
            as_final_on_free((char*)h + sizeof(gc_header));
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
    gc_in_gc = 1;
    if (gc_inc.state == GC_IDLE) {
        // Segment release / allocator trim is rate-limited and idempotent, so it
        // also runs here (every frame) rather than only at a cycle end: a scene
        // that stopped allocating never ends another cycle, and RSS would then
        // stay at the high-water mark forever after the ramp is over.
        gc_release_empty_segs();
        if (gc_bytes_allocated < gc_trigger()) { gc_in_gc = 0; return; }
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
    gc_in_gc = 0;
}


// Stop-the-world collection (System.gc() and offscreen leak checks): mark to
// completion in one shot, then sweep atomically. Works from any gc_step state.
// A partial incremental cycle may have (a) BLACK objects born on the gc_new side
// list whose children were never scanned, and (b) half-marked BLACK objects on
// gc_all. To get a correct result we first fold gc_new into gc_all, reset every
// object to WHITE, and mark the true live set from scratch.
static void gc_collect(void) {
    gc_in_gc = 1;
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
    gc_in_gc = 0;
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
// URLVariables.toString()'s escape set is ALPHANUMERIC ONLY: measured on adl
// 51.4.1 (temp/uvarair), '-' '_' '.' '~' are encoded as well ('s_-.~' comes out
// 's%5F%2D%2E%7E'), so every non [A-Za-z0-9] byte becomes %XX with UPPERCASE hex.
// This is NOT the encodeURIComponent safe set -- that one is as_uri_encode()'s,
// which keeps the extra characters its 'safe' argument lists. Both the KEY and
// the VALUE of a pair go through this encoder.
static bool as_url_var_safe(char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
}
// The encoded length in bytes, WITHOUT allocating. Callers must size their
// destination with this and never with strlen(): a value holding a JSON blob
// encodes to about three times its raw length, and a buffer sized from the raw
// length overflows -- that overflow wrote past a GC string into the next block's
// first word and corrupted the free list (阶段一百五十三).
static size_t as_url_encoded_len(const char* s) {
    if (s == NULL) return 0;
    size_t n = 0;
    for (const unsigned char* p = (const unsigned char*)s; *p != 0; p++) n += as_url_var_safe((char)*p) ? 1 : 3;
    return n;
}
// Encode into a caller-sized buffer. Returns the number of bytes written (no
// terminator is appended).
static size_t as_url_encode_into(char* dst, const char* s) {
    static const char hex[] = "0123456789ABCDEF";
    size_t p = 0;
    if (s == NULL) return 0;
    for (const unsigned char* q = (const unsigned char*)s; *q != 0; q++) {
        unsigned char c = *q;
        if (as_url_var_safe((char)c)) dst[p++] = (char)c;
        else { dst[p++] = '%'; dst[p++] = hex[c >> 4]; dst[p++] = hex[c & 0xF]; }
    }
    return p;
}
static int as_url_hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return 0;
}
static char* as_url_encode(const char* s) {
    if (s == NULL) return (char*)"";
    char* r = as_str_alloc(as_url_encoded_len(s) + 1);
    size_t n = as_url_encode_into(r, s);
    r[n] = 0;
    return r;
}
// application/x-www-form-urlencoded decoding -- the read side of
// URLVariables.decode()/the URLVariables constructor. This is FORM decoding, not
// URI decoding: a literal '+' means a space, in EITHER half of a pair. Measured
// on adl 51.4.1 (temp/uvarair): new URLVariables("plus=a+b") answers "a b",
// new URLVariables("p+q=1") answers the key "p q", and
// new URLVariables("a%20b=c%20d") answers the key "a b" -- the round trip closes
// (toString() gives back "a%20b=c%20d") only because the key was decoded too.
// The only caller is URLVariables_decode, so the form rule lives here.
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
        } else if (s[i] == '+') {
            r[p++] = ' ';
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
    // A pattern that did not compile never matches (AVM2 keeps the PCRE error
    // silent instead of throwing -- see RegExp_ctor). Without this guard the VM
    // would run the zero-instruction program, where ins[0] is a zeroed AS_RE_CHAR.
    if (re == NULL || re->err) return -1;
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
    // A leftover ')' at top level is an error (PCRE2: unmatched closing
    // parenthesis). Without this check the sequence compiler simply stops at the
    // ')' and the program collapses to "match the empty string", so a pattern
    // like ")" would match at every position instead of being inert -- that is
    // exactly what String.replace does NOT do on AIR.
    if (!re->err && c.pos < c.len) as_re_err(&c, "unmatched closing parenthesis");
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
// Append s as a JSON string literal: quoted, with the quote and backslash
// characters backslash-escaped plus the control characters (U+0000..U+001F),
// matching ECMAScript JSON.stringify (measured on adl 51.4.1, temp/jsonair7).
// The two-character escapes are appended as TWO single characters on purpose:
// the earlier form passed a 2-byte C literal for the single-char escapes, which
// also copied the literal's NUL terminator into the MIDDLE of the buffer, so any
// JSON string holding a quote or a backslash came out truncated at that point.
static void as_json_buf_append_string(as_json_buf* b, const char* s) {
    as_json_buf_append_char(b, '"');
    for (const char* p = s; *p; p++) {
        unsigned char c = (unsigned char)*p;
        switch (c) {
            case '"':  as_json_buf_append_char(b, '\\\\'); as_json_buf_append_char(b, '"'); break;
            case '\\\\': as_json_buf_append_char(b, '\\\\'); as_json_buf_append_char(b, '\\\\'); break;
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

// ---------- JSON.stringify: the object SHAPE ----------
// JSON.stringify serializes a value by its RUNTIME shape, not its static type:
// which members an object has, and where they live, depends on what it actually
// is. Measured on adl 51.4.1 (temp/jsonair*, temp/jsonair7):
//   * a plain record emits its dynamic keys in insertion order;
//   * a class instance emits its PUBLIC declared fields (base class members
//     first) and its PUBLIC getters, then its own dynamic slots -- a sealed class
//     with public vars serializes exactly like a dynamic one, and a private field
//     is NOT a member (a class whose only public member is the getter of a
//     private field emits just that getter);
//   * a member whose value is undefined or a Function is OMITTED, not written as
//     null; a null member is kept;
//   * an Array boxed into an Object-typed slot still serializes as a JSON array;
//   * a cyclic structure throws TypeError #1129.
// The previous code read EVERY tag-4 payload as an as_object record. That is the
// layout of an object literal, but not of a class instance, whose first two words
// are its vtable and its _dyn slot table: URLVariables' _dyn pointer was read as
// the record's keys array and its heap neighbours as the vals/length slots. That
// is the crash on the talkmed-meeting SMS-code login tab -- TKURLLoader.sendAndLoad
// json-encodes its URLVariables for the debug trace, so the first
// JSON.stringify(urlVariables) jumped into garbage
// (talkmedE-2026-10-14-062417.ips: SIGBUS in as_json_buf_append_string, the
// string pointer coming from a bogus o->keys[i]).
typedef struct { as_json_buf b; void** path; int depth; int cap; } as_json_ctx;
static _Noreturn void as_throw_json_cycle(void);   // emitted with the class helpers
static void as_json_stringify_rec(as_json_ctx* c, as_value v);

static void as_json_seen_push(as_json_ctx* c, void* p) {
    if (c->depth == c->cap) {
        c->cap = c->cap == 0 ? 32 : c->cap * 2;
        c->path = (void**)realloc(c->path, (size_t)c->cap * sizeof(void*));
    }
    c->path[c->depth++] = p;
}
// True when p is already open HIGHER UP this same chain. A pointer shared by two
// SIBLING branches is a DAG, not a cycle, and must serialize twice -- AIR does
// exactly that (temp/jsonair4 'dag': {p:x, q:x} emits x in both).
static bool as_json_seen(const as_json_ctx* c, void* p) {
    for (int i = 0; i < c->depth; i++) if (c->path[i] == p) return true;
    return false;
}
// One "name":value member; the caller's counter supplies the commas. AIR skips an
// undefined or Function value entirely (temp/jsonair7).
static void as_json_member(as_json_ctx* c, const char* name, as_value v, int* n) {
    if (v.tag == 5 || v.tag == 7) return;
    if (*n > 0) as_json_buf_append_char(&c->b, ',');
    as_json_buf_append_string(&c->b, name);
    as_json_buf_append_char(&c->b, ':');
    as_json_stringify_rec(c, v);
    (*n)++;
}
// The members one class DECLARES, base class first (AIR puts the inherited
// members ahead of the derived ones -- temp/jsonair2 'inherit'). vis != 0 marks a
// non-public member, or a table entry that exists only for the GC scanner, and
// neither is a JSON member.
static void as_json_class_members(as_json_ctx* c, void* obj, void* vt, int* n) {
    as_vtable_header* h = (as_vtable_header*)vt;
    if (h->super != NULL) as_json_class_members(c, obj, h->super, n);
    as_prop* props = (as_prop*)h->props;
    for (int i = 0; props != NULL && props[i].name != NULL; i++) {
        if (props[i].vis) continue;
        as_json_member(c, props[i].name, as_prop_read(obj, &props[i]), n);
    }
    as_method* getters = (as_method*)h->getters;
    for (int i = 0; getters != NULL && getters[i].name != NULL; i++) {
        if (getters[i].vis) continue;
        as_json_member(c, getters[i].name, getters[i].fn(obj, NULL, 0), n);
    }
}
static void as_json_array(as_json_ctx* c, as_array* a) {
    if (as_json_seen(c, a)) as_throw_json_cycle();
    as_json_seen_push(c, a);
    as_json_buf_append_char(&c->b, '[');
    for (int i = 0; i < a->length; i++) {
        if (i > 0) as_json_buf_append_char(&c->b, ',');
        as_json_stringify_rec(c, a->data[i]);
    }
    as_json_buf_append_char(&c->b, ']');
    c->depth--;
}

static void as_json_stringify_rec(as_json_ctx* c, as_value v) {
    switch (v.tag) {
        case 0: as_json_buf_append_cstr(&c->b, "null"); break;
        case 1:
            // JSON has no NaN/Infinity; ECMAScript JSON.stringify serializes
            // them as null.
            if (isnan(v.num) || isinf(v.num)) as_json_buf_append_cstr(&c->b, "null");
            else as_json_buf_append_cstr(&c->b, as_str_from_double(v.num));
            break;
        case 2: as_json_buf_append_cstr(&c->b, (v.num != 0.0) ? "true" : "false"); break;
        case 3: as_json_buf_append_string(&c->b, (char*)v.ptr); break;
        // undefined is null at the TOP level (JSON.stringify(undefined) is
        // "null"); inside an object it is omitted, and as_json_member does that.
        case 5: as_json_buf_append_cstr(&c->b, "null"); break;
        case 6: as_json_array(c, (as_array*)v.ptr); break;
        case 4: {
            void* p = v.ptr;
            if (p == NULL) { as_json_buf_append_cstr(&c->b, "null"); break; }
            int kind = as_heap_kind(p);
            if (kind == GCT_ARRAY) { as_json_array(c, (as_array*)p); break; }
            if (kind != GCT_OBJECT && kind != GCT_CLASS) {
                // A Dictionary (GCT_DICT), a Vector (GCT_CUSTOM) or a static box
                // also keeps tag 4 in an Object-typed slot, but its first word is
                // NOT a vtable, so it cannot be reflected at all. AIR stringifies
                // these as their toString (measured: Dictionary -> "Dictionary",
                // ByteArray -> "ByteArray", Date -> its date string), which this
                // subset does not model; null is reported, and named on stderr,
                // instead of reading a data pointer as a vtable -- the crash the
                // shape dispatch above exists to prevent. Documented divergence.
                as_shell_unsupported("JSON.stringify of a Dictionary/Vector/boxed native value (serialized as null)");
                as_json_buf_append_cstr(&c->b, "null");
                break;
            }
            if (as_json_seen(c, p)) as_throw_json_cycle();
            as_json_seen_push(c, p);
            int n = 0;
            as_json_buf_append_char(&c->b, '{');
            if (kind == GCT_OBJECT) {
                // An object literal / dynamic Object: its own property table IS
                // the member list (insertion order; AIR's is a hash order).
                as_object* o = (as_object*)p;
                for (int i = 0; i < o->length; i++) as_json_member(c, o->keys[i], o->vals[i], &n);
            } else {
                as_json_class_members(c, p, ((as_object_header*)p)->vtable, &n);
                // A dynamic class instance keeps its UNDECLARED members in the
                // _dyn slot table, after the declared ones.
                as_object* dyn = as_dyn_table(p);
                for (int i = 0; dyn != NULL && i < dyn->length; i++)
                    as_json_member(c, dyn->keys[i], dyn->vals[i], &n);
            }
            as_json_buf_append_char(&c->b, '}');
            c->depth--;
            break;
        }
        default: as_json_buf_append_cstr(&c->b, "null"); break;
    }
}
static char* as_json_stringify(as_value v) {
    as_json_ctx c;
    memset(&c, 0, sizeof(c));
    as_json_buf_init(&c.b);
    as_json_stringify_rec(&c, v);
    char* r = as_str_alloc(c.b.len + 1);
    strcpy(r, c.b.buf);
    free(c.b.buf);
    free(c.path);
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
typedef struct { unsigned start; unsigned end; const char* family; double size; int bold; int italic; unsigned color; double leading; int underline; } sk_text_run;
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

// NativeWindow.supportsMenu / supportsNotification: AIR answers these from the OS,
// not from its own build. Measured on adl 51.4.1 -- macOS false/false
// (temp/nwmac/nwmac-out.txt), Windows true/true -- and AIR documents window menus
// and notifications as Windows/Linux features. Macros (not runtime probes) so the
// generated static field stays a compile-time constant on every target.
//
// Same placement rule as the AS_CURSOR_* kinds below: the class's static fields are
// part of the generated CLASS section, which every build emits, so a definition that
// lives inside a backend branch is a definition that is missing whenever a different
// branch is taken. Measured the hard way -- these sat in the ASC_USE_SKIA region and
// a pure-C build of the windowed example answered "use of undeclared identifier
// 'ASC_NW_SUPPORTS_MENU'" (2026-10-19).
#if defined(_WIN32) || defined(__linux__)
  #define ASC_NW_SUPPORTS_MENU true
  #define ASC_NW_SUPPORTS_NOTIFICATION true
#else
  #define ASC_NW_SUPPORTS_MENU false
  #define ASC_NW_SUPPORTS_NOTIFICATION false
#endif
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
// ---- flash.desktop icon family / flash.display.NativeMenu glue (阶段二百五十五) ----
// The generated C builds a FLATTENED description of a menu tree and hands it to
// the window glue, so the glue never learns a generated C type. The tag is the
// identification the native item carries back on a click; it is 1-based into the
// C-side tag table, and submenu is an index into the menus array (-1 = none).
typedef struct { int kind; const char* label; int enabled; int checked; const char* key; int mods; int submenu; int tag; } sk_menu_item;
typedef struct { const char* title; int first; int count; } sk_menu;
// Which desktop capabilities this BACKEND implements (see TODO 遗留/增强 records):
// the Cocoa menu bar and Dock exist, a status item does not, and the login-item /
// default-application services are not wired at all. Advertising them as present
// would turn a documented if (supportsX) guard into a silent no-op.
#if defined(ASC_USE_WINDOW) && defined(__APPLE__)
#define ASC_HAS_DOCK 1
#define ASC_HAS_APP_MENU 1
// The Dock IMAGE is a separate capability from the Dock MENU even though both are
// Cocoa-only today: the menu exists as an NSMenu the glue builds, the image has to
// cross as premultiplied pixels. Kept apart so a future non-Cocoa backend can paint
// the icon without pretending it owns a menu bar.
#define ASC_HAS_DOCK_IMAGE 1
#else
#define ASC_HAS_DOCK 0
#define ASC_HAS_APP_MENU 0
#define ASC_HAS_DOCK_IMAGE 0
#endif
// A menu-bar status item is an ENHANCEMENT, not a gap: measured on adl 51.4.1 /
// macOS, NativeApplication.supportsSystemTrayIcon is false and new
// SystemTrayIcon() throws #2012, i.e. AIR has no macOS counterpart at all. So it
// only exists when the build asked for it ('--features tray'), and it needs the
// window backend because the status item lives in the same NSApplication as the
// menu bar. Without BOTH the runtime keeps AIR's exact refusal.
#if defined(ASC_USE_TRAY) && defined(ASC_USE_WINDOW) && defined(__APPLE__)
#define ASC_HAS_TRAY 1
#else
#define ASC_HAS_TRAY 0
#endif
#define ASC_HAS_LOGIN_ITEM 0
#define ASC_HAS_DEFAULT_APP 0
#if defined(ASC_USE_WINDOW)
extern int sk_menu_supported(void);
extern void sk_menu_install_app(const sk_menu* menus, int nmenus, const sk_menu_item* items, int nitems, int root, void (*cb)(int));
extern void sk_menu_install_dock(const sk_menu* menus, int nmenus, const sk_menu_item* items, int nitems, int root, void (*cb)(int));
// ---- right-click / ContextMenu.display popup (阶段二百八十九) ----
// The description is the SAME flattened model the app/Dock/status menus use, so a
// backend builds the popup with the code it already has. x/y are SCREEN points in
// the model's own space (top-left origin, y downward, the space
// NativeWindow.globalToScreen answers in) -- the glue flips them for AppKit.
// Returns 1 when the popup already RESOLVED synchronously (a native backend runs a
// modal tracking loop, so the call blocks exactly like AIR and *tag holds the
// chosen 1-based tag, 0 = dismissed) and 0 when the backend cannot block (web):
// then the menu is on screen and sk_menu_popup_take must be polled per frame.
// *outx/*outy answer the pointer's position in the SAME space as x/y when the menu
// closed -- AIR replays the swallowed right release at the dismissal point, not at
// the press point (measured: down at stage 400,243, up/click at 460,256, the item's
// position). Untouched backends just echo the opening point.
extern int sk_menu_popup(int win, const sk_menu* menus, int nmenus, const sk_menu_item* items, int nitems, int root, double x, double y, int* tag, double* outx, double* outy);
// Non-zero once a popup opened asynchronously has RESOLVED; *tag then carries the
// 1-based tag, 0 for a dismissal. Answers 0 while the menu is still open.
extern int sk_menu_popup_take(int* tag);
extern void sk_dock_bounce(int critical);
// Straight ARGB (0xAARRGGBB) rows, top-down -- i.e. BitmapData.pixels verbatim. Pass
// NULL/0/0 to restore the bundle icon. Returns nothing: the glue queues the image if
// AppKit is not up yet and applies it from the event loop.
extern void sk_dock_set_icon_image(const void* argb, int w, int h);
// ---- flash.desktop.SystemTrayIcon (阶段二百六十, --features tray) ----
// Straight ARGB rows, exactly like the Dock icon (the glue premultiplies once).
//
// sk_tray_set_images takes up to 4 RENDERINGS OF THE SAME ICON at different pixel
// densities (SystemTrayIcon.bitmaps is an array for exactly that reason, and AIR's
// documentation for it says so). Each becomes one NSImage representation, so a
// status item is crisp on a 1x external display AND on a Retina one; handing AppKit
// only the 2x bitmap makes it downscale there, and at 15pt a halved 1.5pt stroke
// turns to mush -- measured on this machine's 2560x1440 secondary display.
// The item's point height is the menu bar's 22; each rep keeps its own pixel size.
// NULL/0/NULL clears the image. The menu crosses as the same flattened sk_menu
// model the app/Dock menus use.
extern void sk_tray_set_images(const void* const* argbs, const int* ws, const int* hs, int n);
extern void sk_tray_set_tooltip(const char* text);
extern int sk_tray_set_menu(const sk_menu* menus, int nmenus, const sk_menu_item* items, int nitems, int root, void (*cb)(int));
// kind: 0 = left click, 1 = right click. mods bits: 1 command, 2 control, 4 option,
// 8 shift -- the glue translates NSEventModifierFlags, so the generated C never
// sees an AppKit enum value.
extern void sk_tray_set_callback(void (*cb)(int kind, double sx, double sy, int mods));
extern void sk_window_set_auto_exit(int on);
#else
static inline int sk_menu_supported(void) { return 0; }
static inline void sk_menu_install_app(const sk_menu* m, int nm, const sk_menu_item* i, int ni, int root, void (*cb)(int)) { (void)m; (void)nm; (void)i; (void)ni; (void)root; (void)cb; }
static inline void sk_menu_install_dock(const sk_menu* m, int nm, const sk_menu_item* i, int ni, int root, void (*cb)(int)) { (void)m; (void)nm; (void)i; (void)ni; (void)root; (void)cb; }
// No window backend means no pointer and no screen: report "resolved, nothing
// chosen" so the caller never waits on a popup that was never shown.
static inline int sk_menu_popup(int win, const sk_menu* m, int nm, const sk_menu_item* i, int ni, int root, double x, double y, int* tag, double* outx, double* outy) { (void)win; (void)m; (void)nm; (void)i; (void)ni; (void)root; if (tag != NULL) *tag = 0; if (outx != NULL) *outx = x; if (outy != NULL) *outy = y; return 1; }
static inline int sk_menu_popup_take(int* tag) { if (tag != NULL) *tag = 0; return 0; }
static inline void sk_dock_bounce(int critical) { (void)critical; }
static inline void sk_dock_set_icon_image(const void* argb, int w, int h) { (void)argb; (void)w; (void)h; }
static inline void sk_window_set_auto_exit(int on) { (void)on; }
#endif
// The C++ half of the allocation-failure story lives in vendor/skia_glue.cc: it
// overrides the global operator new and hands a refused allocation to
// as_oom_from_cxx through this hook. A build with no Skia glue links no C++ at
// all, so there the installer has nothing to install.
#ifdef ASC_USE_SKIA
extern void sk_set_oom_hook(int (*hook)(size_t));
#endif
static void as_oom_hook_install(void) {
#ifdef ASC_USE_SKIA
    sk_set_oom_hook(as_oom_from_cxx);
#else
    // Keep as_oom_from_cxx referenced so a C-only build does not warn about an
    // unused static function (this is the only thing that could use it).
    (void)&as_oom_from_cxx;
#endif
}

// Platform clipboard (flash.desktop.Clipboard + flash.system.System.setClipboard,
// 阶段二百九十三). The text format is the one every backend carries (SDL text on
// the window backends, nothing on a headless/web build); the other three translated
// formats are asked for by name, and a backend that cannot carry one answers 0.
//   has_fmt  : 1 when the OS clipboard currently holds that format
//   get_fmt  : bytes written; with buf == NULL it returns the LENGTH instead, which
//              is how the caller sizes its buffer
//   set_fmt  : replaces just that format, leaving the others alone
//   clear    : empties the whole clipboard; clear_fmt removes one format
// Implemented by the window backend, so a skia build without a window (a PNG-only,
// not-visible air app) gets the same no-op stubs as the pure-C build instead of an
// unresolved link.
#ifdef ASC_USE_WINDOW
extern void sk_clipboard_set_text(const char* text);
extern int sk_clipboard_get_text(char* buf, int cap);
extern int sk_clipboard_available(void);
extern int sk_clipboard_has_fmt(const char* fmt);
extern void sk_clipboard_set_fmt(const char* fmt, const void* data, int len);
extern int sk_clipboard_get_fmt(const char* fmt, char* buf, int cap);
extern void sk_clipboard_clear_fmt(const char* fmt);
extern void sk_clipboard_clear(void);
#else
static inline void sk_clipboard_set_text(const char* text) { (void)text; }
static inline int sk_clipboard_get_text(char* buf, int cap) { (void)buf; (void)cap; return 0; }
static inline int sk_clipboard_available(void) { return 0; }
static inline int sk_clipboard_has_fmt(const char* fmt) { (void)fmt; return 0; }
static inline void sk_clipboard_set_fmt(const char* fmt, const void* data, int len) { (void)fmt; (void)data; (void)len; }
static inline int sk_clipboard_get_fmt(const char* fmt, char* buf, int cap) { (void)fmt; (void)buf; (void)cap; return 0; }
static inline void sk_clipboard_clear_fmt(const char* fmt) { (void)fmt; }
static inline void sk_clipboard_clear(void) { }
#endif

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
extern void sk_canvas_reset(void* canvas);
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
extern void sk_canvas_total_translate(void* canvas, double* tx, double* ty);
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
extern void* sk_path_new(void);
extern void sk_path_delete(void* path);
extern void sk_path_move_to(void* path, double x, double y);
extern void sk_path_line_to(void* path, double x, double y);
extern void sk_path_cubic_to(void* path, double c1x, double c1y, double c2x, double c2y, double x, double y);
extern void sk_path_quad_to(void* path, double cx, double cy, double x, double y);
extern void sk_path_add_rect(void* path, double x, double y, double w, double h);
extern void sk_path_add_circle(void* path, double cx, double cy, double r);
extern void sk_path_add_oval(void* path, double x, double y, double w, double h);
extern void sk_path_add_rrect(void* path, double x, double y, double w, double h, double rx, double ry);
extern void sk_path_close(void* path);
// Closes every contour (Skia's AA clipper drops an unclosed contour, so a clip
// path must be built from closed figures -- see vendor/skia_glue.cc).
extern void sk_path_close_all(void* path);
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
extern void sk_canvas_draw_image_rect(void* canvas, void* image, double dx, double dy, double dw, double dh, int smooth);
extern void sk_canvas_draw_bgra(void* canvas, const uint8_t* bgra, int w, int h, double dx, double dy, double dw, double dh);
extern void sk_canvas_draw_text(void* canvas, const char* text, double x, double y, double size, int bold, int italic, void* paint);
extern void sk_canvas_draw_text_n(void* canvas, const char* text, int len, double x, double y, double size, int bold, int italic, void* paint);
extern double sk_text_measure(const char* text, double size, int bold, int italic);
extern double sk_text_measure_n(const char* text, int len, double size, int bold, int italic);
extern void* sk_textlayout_new(const char* text, const char* family, double size, int bold, int italic, unsigned color, double width, int align, int collapseNewlines);
extern void* sk_textlayout_new_leading(const char* text, const char* family, double size, int bold, int italic, unsigned color, double leading, double width, int align, int collapseNewlines);
extern double sk_textlayout_height(void* para);
extern double sk_textlayout_max_width(void* para);
// Longest line INCLUDING trailing blanks = AIR's TextField.textWidth. Skia's own
// sk_textlayout_max_width above stops at the last visible glyph, which is why the C
// property used to ignore trailing spaces (adl 51.4.1: "abc " is 3 px wider than "abc").
extern double sk_textlayout_max_width_incl_spaces(void* para);
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
// The 'def' argument carries the field's defaultTextFormat face (see
// sk_set_air_run_height in the glue: AIR fills run gaps AND styles the line box
// from it).
extern void* sk_textlayout_new_runs(const char* text, const sk_text_run* def, const sk_text_run* runs, int run_count, double width, int align, int collapseNewlines);
// G28: TextFormat.underline. rowY is the 1 px row per visual line, already floored by
// the caller; u16 is 2 ints per range (UTF-16 indices into the paragraph text) and
// colors one 0xRRGGBB per range.
extern void sk_textlayout_paint_underline(void* para, void* canvas, double ox, const double* rowY, int lineCount, const int* u16, const unsigned* colors, int rangeCount);
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
// Alpha folded into the paint: the same three primitives, composited with the
// source alpha multiplied (see as_alpha_foldable in the generated renderer).
extern void sk_canvas_draw_path_mul(void* canvas, void* path, void* paint, double mul);
extern void sk_canvas_draw_rect_mul(void* canvas, double x, double y, double w, double h, void* paint, double mul);
extern void sk_canvas_draw_image_rect_mul(void* canvas, void* image, double dx, double dy, double dw, double dh, int smooth, double mul);

// The alpha a single-primitive object folded into its paint, i.e. the product of
// the alphas of the foldable ancestors currently being painted (1.0 = none). Set
// and restored by as_render_object; read by the three draw wrappers below. A stack
// of alpha-0.5 objects therefore composites 0.25 exactly like nested layers would.
static double ASC_alpha_mul = 1.0;

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
    // AIR always anti-aliases vector shapes (SkPaint defaults to AA off). Leaving it
    // off made every diagonal edge a staircase and every 1px stroke 1-2 device rows
    // thinner than AIR's -- measured on temp/g242526 Pix6/Pix8 (44 partial pixels on
    // an AIR triangle edge vs 0 here) and on the 150% bake probe.
    sk_paint_set_antialias(p, 1);
    return p;
}
static inline void* as_skia_paint_stroke(unsigned rgb, double alpha, double width) {
    void* p = sk_paint_new();
    sk_paint_set_color(p, rgb); sk_paint_set_alpha(p, alpha); sk_paint_set_stroke(p);
    sk_paint_set_stroke_width(p, width);
    sk_paint_set_antialias(p, 1);   // see as_skia_paint_fill: AIR anti-aliases strokes too
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
static inline void as_skia_canvas_draw_rect(void* c, double x, double y, double w, double h, void* p) {
    if (ASC_alpha_mul < 1.0) { sk_canvas_draw_rect_mul(c, x, y, w, h, p, ASC_alpha_mul); return; }
    sk_canvas_draw_rect(c, x, y, w, h, p);
}
static inline void as_skia_canvas_draw_circle(void* c, double cx, double cy, double r, void* p) { sk_canvas_draw_circle(c, cx, cy, r, p); }
static inline void as_skia_canvas_draw_path(void* c, void* path, void* paint) {
    if (ASC_alpha_mul < 1.0) { sk_canvas_draw_path_mul(c, path, paint, ASC_alpha_mul); return; }
    sk_canvas_draw_path(c, path, paint);
}
static inline void as_skia_canvas_clip_rect(void* c, double x, double y, double w, double h) { sk_canvas_clip_rect(c, x, y, w, h); }
static inline void as_skia_canvas_clip_path(void* c, void* path, int aa) { sk_canvas_clip_path(c, path, aa); }
static inline void as_skia_canvas_draw_image_src_rect(void* c, void* img, double sx, double sy, double sw, double sh, double dx, double dy, double dw, double dh) { sk_canvas_draw_image_src_rect(c, img, sx, sy, sw, sh, dx, dy, dw, dh); }
// Device units per logical unit of the current canvas transform (see
// sk_canvas_total_scale). Used by screen-space stroking: TextField's border is
// a 1px line that must not scale with the object.
static inline void as_skia_canvas_total_scale(void* c, double* sx, double* sy) { sk_canvas_total_scale(c, sx, sy); }
// Device position of the canvas local origin (see sk_canvas_total_translate).
// Together with the scale above this is the whole CTM the bake origin snap
// needs: a bake surface must start on a DEVICE pixel boundary of the canvas it
// will be blitted onto, and that boundary moves with every parent transform.
static inline void as_skia_canvas_total_translate(void* c, double* tx, double* ty) { sk_canvas_total_translate(c, tx, ty); }
static inline void as_skia_canvas_translate(void* c, double x, double y) { sk_canvas_translate(c, x, y); }
static inline void as_skia_canvas_rotate(void* c, double deg) { sk_canvas_rotate(c, deg); }
static inline void as_skia_canvas_scale(void* c, double sx, double sy) { sk_canvas_scale(c, sx, sy); }
static inline void as_skia_canvas_concat(void* c, double a, double b, double cc, double d, double tx, double ty) { sk_canvas_concat(c, a, b, cc, d, tx, ty); }
static inline void as_skia_canvas_save_layer_alpha(void* c, double a) { sk_canvas_save_layer_alpha(c, a); }
static inline void as_skia_canvas_save(void* c) { sk_canvas_save(c); }
static inline void as_skia_canvas_restore(void* c) { sk_canvas_restore(c); }
static inline void as_skia_canvas_reset(void* c) { sk_canvas_reset(c); }
static inline void* as_skia_path_new(void) { return sk_path_new(); }
static inline void as_skia_path_delete(void* p) { sk_path_delete(p); }
static inline void as_skia_path_move_to(void* p, double x, double y) { sk_path_move_to(p, x, y); }
static inline void as_skia_path_line_to(void* p, double x, double y) { sk_path_line_to(p, x, y); }
static inline void as_skia_path_cubic_to(void* p, double c1x, double c1y, double c2x, double c2y, double x, double y) { sk_path_cubic_to(p, c1x, c1y, c2x, c2y, x, y); }
static inline void as_skia_path_quad_to(void* p, double cx, double cy, double x, double y) { sk_path_quad_to(p, cx, cy, x, y); }
static inline void as_skia_path_add_rect(void* p, double x, double y, double w, double h) { sk_path_add_rect(p, x, y, w, h); }
static inline void as_skia_path_add_circle(void* p, double cx, double cy, double r) { sk_path_add_circle(p, cx, cy, r); }
static inline void as_skia_path_add_oval(void* p, double x, double y, double w, double h) { sk_path_add_oval(p, x, y, w, h); }
static inline void as_skia_path_add_rrect(void* p, double x, double y, double w, double h, double rx, double ry) { sk_path_add_rrect(p, x, y, w, h, rx, ry); }
static inline void as_skia_path_close(void* p) { sk_path_close(p); }
static inline void as_skia_path_close_all(void* p) { sk_path_close_all(p); }
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
static inline void as_skia_canvas_draw_image_rect(void* c, void* img, double dx, double dy, double dw, double dh, int smooth) {
    if (ASC_alpha_mul < 1.0) { sk_canvas_draw_image_rect_mul(c, img, dx, dy, dw, dh, smooth, ASC_alpha_mul); return; }
    sk_canvas_draw_image_rect(c, img, dx, dy, dw, dh, smooth);
}
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
// ---- the text seam: one gate, two implementations (stage 221) ----
// The text engine is a SEPARATE source file (vendor/skia_text_glue.cc) so that a
// build which draws no text can leave it out of the link entirely. That has to be
// a build-level decision rather than a link-time hope: one object file is linked
// WHOLE, so as long as anything in the glue referenced skia::textlayout::*, the
// linker had to resolve libskparagraph.a -> libskunicode.a -> libharfbuzz.a ->
// libicu.a, whose data is a single 9.71 MB object -- and a program that never drew
// a glyph still paid for every byte of it (measured: 19.43 MB, against 6.53 MB for
// the same program once the split let the text half drop out of the link).
//
// ASC_HAVE_TEXT is what the build sets when it links that file; index.ts decides
// from the program's own sources (see usesTextEngine there). Without it the seam
// collapses to the same no-ops the pure-C runtime uses, so the generated C still
// compiles and links with no text symbol at all.
//
// This is NOT a silent downgrade: index.ts prints the decision while building, and
// the no-op path below warns once on stderr the first time it is actually driven.
// Reaching that warning means the detector missed a text user (a TextField conjured
// through getDefinitionByName, say) -- rebuild with the engine linked.
#ifdef ASC_HAVE_TEXT
static inline void as_skia_canvas_draw_text(void* c, const char* t, double x, double y, double sz, int bold, int italic, void* p) { sk_canvas_draw_text(c, t, x, y, sz, bold, italic, p); }
static inline void as_skia_canvas_draw_text_n(void* c, const char* t, int len, double x, double y, double sz, int bold, int italic, void* p) { sk_canvas_draw_text_n(c, t, len, x, y, sz, bold, italic, p); }
static inline double as_skia_text_measure(const char* t, double sz, int bold, int italic) { return sk_text_measure(t, sz, bold, italic); }
static inline double as_skia_text_measure_n(const char* t, int len, double sz, int bold, int italic) { return sk_text_measure_n(t, len, sz, bold, italic); }
static inline void* as_skia_textlayout_new(const char* t, const char* fam, double sz, int bold, int italic, unsigned color, double w, int align, int collapse) { return sk_textlayout_new(t, fam, sz, bold, italic, color, w, align, collapse); }
static inline void* as_skia_textlayout_new_leading(const char* t, const char* fam, double sz, int bold, int italic, unsigned color, double leading, double w, int align, int collapse) { return sk_textlayout_new_leading(t, fam, sz, bold, italic, color, leading, w, align, collapse); }
static inline void* as_skia_textlayout_new_runs(const char* t, const sk_text_run* def, const sk_text_run* runs, int n, double w, int align, int collapse) { return sk_textlayout_new_runs(t, def, runs, n, w, align, collapse); }
static inline double as_skia_textlayout_height(void* p) { return sk_textlayout_height(p); }
static inline double as_skia_textlayout_max_width(void* p) { return sk_textlayout_max_width(p); }
static inline double as_skia_textlayout_text_width(void* p) { return sk_textlayout_max_width_incl_spaces(p); }
static inline int as_skia_textlayout_line_count(void* p) { return sk_textlayout_line_count(p); }
static inline int as_skia_textlayout_line_metrics(void* p, int* s, int* e, double* t, double* b, int cap) { return sk_textlayout_line_metrics(p, s, e, t, b, cap); }
static inline int as_skia_textlayout_line_box(void* p, int i, double ld, const char* fam, double sz, int b, int it, double* a, double* d, double* l, double* w) { return sk_textlayout_line_box(p, i, ld, fam, sz, b, it, a, d, l, w); }
static inline void as_skia_textlayout_paint(void* p, void* c, double x, double y) { sk_textlayout_paint(p, c, x, y); }
static inline void as_skia_textlayout_paint_underline(void* p, void* c, double ox, const double* ry, int nl, const int* u16, const unsigned* col, int nr) { sk_textlayout_paint_underline(p, c, ox, ry, nl, u16, col, nr); }
static inline void as_skia_textlayout_delete(void* p) { sk_textlayout_delete(p); }
static inline int as_skia_textlayout_glyph_position_at(void* p, double x, double y) { return sk_textlayout_glyph_position_at(p, x, y); }
static inline int as_skia_textlayout_rects_for_range(void* p, int s, int e, int skip, double* l, double* t, double* r, double* b, int max) { return sk_textlayout_rects_for_range(p, s, e, skip, l, t, r, b, max); }
static inline int as_skia_textlayout_caret_rect(void* p, int i, double* x, double* y, double* h) { return sk_textlayout_caret_rect(p, i, x, y, h); }
#else
// No text engine in this build: a TextField still exists (it is a built-in class in
// every program, so the display list keeps its branch), it just cannot lay anything
// out. Same shape as the pure-C stubs further down, plus the one-time warning.
static int as_text_engine_absent_warned = 0;
static inline void as_text_engine_absent(void) {
    if (as_text_engine_absent_warned) return;
    as_text_engine_absent_warned = 1;
    fprintf(stderr, "warning: flash.text is not linked into this build, so every TextField operation is a no-op.\\n"
                    "         The build found no flash.text class in the program's sources, so it skipped the text engine;\\n"
                    "         rebuild with it linked (docs/zh-cn/rust-text-backend.md) if that verdict was wrong.\\n");
}
static inline void as_skia_canvas_draw_text(void* c, const char* t, double x, double y, double sz, int bold, int italic, void* p) { (void)c; (void)t; (void)x; (void)y; (void)sz; (void)bold; (void)italic; (void)p; as_text_engine_absent(); }
static inline void as_skia_canvas_draw_text_n(void* c, const char* t, int len, double x, double y, double sz, int bold, int italic, void* p) { (void)c; (void)t; (void)len; (void)x; (void)y; (void)sz; (void)bold; (void)italic; (void)p; as_text_engine_absent(); }
static inline double as_skia_text_measure(const char* t, double sz, int bold, int italic) { (void)t; (void)sz; (void)bold; (void)italic; as_text_engine_absent(); return 0.0; }
static inline double as_skia_text_measure_n(const char* t, int len, double sz, int bold, int italic) { (void)t; (void)len; (void)sz; (void)bold; (void)italic; as_text_engine_absent(); return 0.0; }
static inline void* as_skia_textlayout_new(const char* t, const char* fam, double sz, int bold, int italic, unsigned color, double w, int align, int collapse) { (void)t; (void)fam; (void)sz; (void)bold; (void)italic; (void)color; (void)w; (void)align; (void)collapse; as_text_engine_absent(); return NULL; }
static inline void* as_skia_textlayout_new_leading(const char* t, const char* fam, double sz, int bold, int italic, unsigned color, double leading, double w, int align, int collapse) { (void)t; (void)fam; (void)sz; (void)bold; (void)italic; (void)color; (void)leading; (void)w; (void)align; (void)collapse; as_text_engine_absent(); return NULL; }
static inline void* as_skia_textlayout_new_runs(const char* t, const sk_text_run* def, const sk_text_run* runs, int n, double w, int align, int collapse) { (void)t; (void)def; (void)runs; (void)n; (void)w; (void)align; (void)collapse; as_text_engine_absent(); return NULL; }
static inline double as_skia_textlayout_height(void* p) { (void)p; return 0.0; }
static inline double as_skia_textlayout_max_width(void* p) { (void)p; return 0.0; }
static inline double as_skia_textlayout_text_width(void* p) { (void)p; return 0.0; }
static inline int as_skia_textlayout_line_count(void* p) { (void)p; return 0; }
static inline int as_skia_textlayout_line_metrics(void* p, int* s, int* e, double* t, double* b, int cap) { (void)p; (void)s; (void)e; (void)t; (void)b; (void)cap; return 0; }
static inline int as_skia_textlayout_line_box(void* p, int i, double ld, const char* fam, double sz, int b, int it, double* a, double* d, double* l, double* w) { (void)p; (void)i; (void)ld; (void)fam; (void)sz; (void)b; (void)it; (void)a; (void)d; (void)l; (void)w; return 0; }
static inline void as_skia_textlayout_paint(void* p, void* c, double x, double y) { (void)p; (void)c; (void)x; (void)y; as_text_engine_absent(); }
static inline void as_skia_textlayout_paint_underline(void* p, void* c, double ox, const double* ry, int nl, const int* u16, const unsigned* col, int nr) { (void)p; (void)c; (void)ox; (void)ry; (void)nl; (void)u16; (void)col; (void)nr; as_text_engine_absent(); }
static inline void as_skia_textlayout_delete(void* p) { (void)p; }
static inline int as_skia_textlayout_glyph_position_at(void* p, double x, double y) { (void)p; (void)x; (void)y; return -1; }
static inline int as_skia_textlayout_rects_for_range(void* p, int s, int e, int skip, double* l, double* t, double* r, double* b, int max) { (void)p; (void)s; (void)e; (void)skip; (void)l; (void)t; (void)r; (void)b; (void)max; return 0; }
static inline int as_skia_textlayout_caret_rect(void* p, int i, double* x, double* y, double* h) { (void)p; (void)i; (void)x; (void)y; (void)h; return 0; }
#endif
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
extern int sk_window_create(int w, int h, const char* title, int resizable, int maximizable, int minimizable,
                            int decorated, int highdpi,
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
// Frame borders (title bar / edges), for NativeWindow.globalToScreen.
extern void sk_window_get_borders(int id, int* top, int* left, int* bottom, int* right);
// The window's platform handle (HWND on Windows, NSWindow* on macOS), for
// FREAcquireNativeWindowHandle. NULL when this backend has none -- the FRE entry
// point reports that instead of handing out a fabricated pointer.
extern void* sk_window_native_handle(int id);
// NativeApplication.exit(): end the event loop with windows still open.
extern void sk_window_request_exit(void);
extern void sk_window_close(int id);
extern int sk_window_is_closed(int id);
// Did the user ask this window to close (its close button)? Taken by the AS3
// frame, which reports it as the cancelable Event.CLOSING.
extern int sk_window_take_close_request(int id);
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
extern int sk_window_os_display_state(int id);
extern void sk_window_set_always_in_front(int id, int on);
// Per-window transparency (NativeWindowInitOptions.transparent, and the initial
// window's descriptor <transparent> via ASC_WINDOW_TRANSPARENT). The glue owns the
// platform side (on macOS: NSWindow opaque=NO + clear background + a non-opaque
// layer); the AS3 side keeps w->transparent because the compose step must clear
// to alpha 0 instead of the stage colour -- AIR does not fill the stage background
// in this mode (measured on adl 51.4.1).
extern void sk_window_set_transparent(int id, int on);
// NativeWindow.minSize/maxSize. The limits live in the glue (0 = unlimited) and
// are what the window manager enforces while the user drags an edge; the AS3 side
// keeps its own copy because AIR's getters report the last value written, even on
// a platform that cannot honour it.
extern void sk_window_get_limits(int id, int* mnw, int* mnh, int* mxw, int* mxh);
extern void sk_window_set_limits(int id, int mnw, int mnh, int mxw, int mxh);
// AIR's per-platform defaults for a fresh window's minSize/maxSize, and the floor a
// later minSize assignment is clamped to. Both live in the platform layer, next to
// the other measurements of what the OS actually enforces.
extern void sk_window_limits_floor(int* fw, int* fh);
// The same two numbers, readable before any OS window exists (see the note on
// as_window_limits_default).
extern void sk_window_limits_default(int* mnw, int* mnh, int* mxw, int* mxh);
// NativeWindow.startMove()/startResize(): begin a pointer-driven system drag.
// Returns 1 when the drag was started (AIR's true), 0 when the window cannot be
// dragged at all (closed/maximized/not resizable), which is also AIR's false.
extern int sk_window_start_move(int id);
extern int sk_window_start_resize(int id, const char* edge);
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
static inline int as_window_create(int w, int h, const char* title, int resizable, int maximizable, int minimizable,
                                   int decorated, int highdpi,
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
    return sk_window_create(w, h, title, resizable, maximizable, minimizable, decorated, highdpi, gpu,
                            on_mouse, on_wheel, on_key, on_redraw, on_frame, on_frame_delay, on_resize, on_close);
#else
    (void)w; (void)h; (void)title; (void)resizable; (void)maximizable; (void)minimizable; (void)decorated; (void)highdpi; (void)gpu;
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
// Frame borders (title bar / window edge) of a chrome-decorated window, in
// physical pixels. NativeWindow.globalToScreen needs them: AIR's bounds is the
// OUTER frame rect while globalToScreen is measured from the CLIENT area's
// top-left, so the border has to be added back on the way out -- the inverse of
// what sk_window_get_bounds does. adl 51.4.1: bounds (26,26) with borders
// (8,31) answers globalToScreen(0,0) = (34,57).
static inline void as_window_get_borders(int id, int* top, int* left, int* bottom, int* right) {
#ifdef ASC_USE_WINDOW
    sk_window_get_borders(id, top, left, bottom, right);
#else
    (void)id; if (top) *top = 0; if (left) *left = 0; if (bottom) *bottom = 0; if (right) *right = 0;
#endif
}
// The platform window object behind a window slot (HWND / NSWindow*), handed to a
// native extension by FREAcquireNativeWindowHandle. The slot id is the SAME id
// every other as_window_* call takes, so the main window (slot 0) and a
// NativeWindow created by the program are addressed identically.
static inline void* as_window_native_handle(int id) {
#ifdef ASC_USE_WINDOW
    return sk_window_native_handle(id);
#else
    (void)id; return NULL;
#endif
}
// NativeApplication.exit(): ask the event loop to end now, with every window
// still open. The loop tears the windows down as usual and then returns, so the
// process exits with the same code as an autoExit teardown.
static inline void as_window_request_exit(void) {
#ifdef ASC_USE_WINDOW
    sk_window_request_exit();
#endif
}
// flash.system.System.exit(code:uint): "a value to pass to the operating system"
// (System.html). AIR does not support the method at runtime (adl 51.4.1 throws
// #2018) and points AIR applications at NativeApplication.exit() instead, so this
// shares that shutdown exactly -- record the code, ask the shared loop to stop --
// and the only difference is that main() returns the recorded status rather than 0.
// Statements after the call still run up to the frame boundary, which is the same
// deferral NativeApplication.exit() has.
static int as_exit_status = 0;
static inline void as_system_exit(unsigned code) {
    as_exit_status = (int)code;
    as_window_request_exit();
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
// The user's close request, taken once per frame by ASC_win_poll.
static inline int as_window_take_close_request(int id) {
#ifdef ASC_USE_WINDOW
    return sk_window_take_close_request(id);
#else
    (void)id; return 0;
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
// Display state as the window manager reports it (0 normal, 1 minimized,
// 2 maximized, -1 unknown) -- see sk_window_os_display_state. Kept apart from the
// AS3 record so the generated poll can tell an OS-driven change from one it already
// reported itself.
static inline int as_window_os_display_state(int id) {
#ifdef ASC_USE_WINDOW
    return sk_window_os_display_state(id);
#else
    (void)id; return -1;
#endif
}
static inline void as_window_set_always_in_front(int id, int on) {
#ifdef ASC_USE_WINDOW
    sk_window_set_always_in_front(id, on);
#else
    (void)id; (void)on;
#endif
}
static inline void as_window_set_transparent(int id, int on) {
#ifdef ASC_USE_WINDOW
    sk_window_set_transparent(id, on);
#else
    (void)id; (void)on;
#endif
}
// NativeWindow.minSize/maxSize. The window manager owns the enforcement (a resize
// drag must respect them), the AS3 side owns the values AIR's getters report — so
// the two are kept in step by always going through these two calls.
static inline void as_window_get_limits(int id, int* mnw, int* mnh, int* mxw, int* mxh) {
#ifdef ASC_USE_WINDOW
    sk_window_get_limits(id, mnw, mnh, mxw, mxh);
#else
    (void)id; if (mnw) *mnw = 0; if (mnh) *mnh = 0; if (mxw) *mxw = 0; if (mxh) *mxh = 0;
#endif
}
static inline void as_window_set_limits(int id, int mnw, int mnh, int mxw, int mxh) {
#ifdef ASC_USE_WINDOW
    sk_window_set_limits(id, mnw, mnh, mxw, mxh);
#else
    (void)id; (void)mnw; (void)mnh; (void)mxw; (void)mxh;
#endif
}
static inline void as_window_limits_floor(int* fw, int* fh) {
#ifdef ASC_USE_WINDOW
    sk_window_limits_floor(fw, fh);
#else
    if (fw) *fw = 0; if (fh) *fh = 0;
#endif
}
// The platform's own starting minSize/maxSize. Needed separately because a fresh
// NativeWindow has NO OS window yet -- AIR creates it when the window is first shown
// -- so a limits read at construction time finds an empty slot (zeros) and would
// cache those zeros. NativeWindow's constructor therefore falls back to these
// defaults, the same numbers the backend installs on the real window.
// Degrades to zeros in a build with no window backend, where no window exists at
// all and every NativeWindow entry point reports itself unsupported.
static inline void as_window_limits_default(int* mnw, int* mnh, int* mxw, int* mxh) {
#ifdef ASC_USE_WINDOW
    sk_window_limits_default(mnw, mnh, mxw, mxh);
#else
    if (mnw) *mnw = 0; if (mnh) *mnh = 0; if (mxw) *mxw = 0; if (mxh) *mxh = 0;
#endif
}
// NativeWindow.startMove()/startResize(): begin a pointer-driven system drag.
// Returns 1 when the drag started, which is AIR's true; 0 (no window manager, or a
// window that cannot be dragged) is AIR's false and is reported as such rather
// than faked.
static inline int as_window_start_move(int id) {
#ifdef ASC_USE_WINDOW
    return sk_window_start_move(id);
#else
    (void)id; return 0;
#endif
}
static inline int as_window_start_resize(int id, const char* edge) {
#ifdef ASC_USE_WINDOW
    return sk_window_start_resize(id, edge);
#else
    (void)id; (void)edge; return 0;
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
// Query the primary display size for Stage.fullScreenWidth/fullScreenHeight and
// Capabilities.screenResolutionX/Y. These are LOGICAL units (AIR's DIP), which on
// a HiDPI Windows desktop is NOT the pixel count -- adl 51.4.1 reports 2560x1707
// on a 3840x2560 desktop at 150% scaling, and screenDPI 96. The glue picks the
// SDL query that reports that space (see sk_window_get_display_size).
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
static double ASC_alpha_mul = 1.0;   // see the Skia block: folded single-primitive alpha
static inline void as_skia_canvas_draw_rect(void* c, double x, double y, double w, double h, void* p) { (void)c; (void)x; (void)y; (void)w; (void)h; (void)p; }
// No-Skia builds have no canvas to measure: report 1 (a 1:1 transform), which
// makes the screen-space border fall back to one local unit -- the same thing the
// pure-C rasterizer (if any) would want.
static inline void as_skia_canvas_total_scale(void* c, double* sx, double* sy) { (void)c; if (sx != NULL) *sx = 1.0; if (sy != NULL) *sy = 1.0; }
static inline void as_skia_canvas_total_translate(void* c, double* tx, double* ty) { (void)c; if (tx != NULL) *tx = 0.0; if (ty != NULL) *ty = 0.0; }
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
static inline void as_skia_canvas_reset(void* c) { (void)c; }
static inline void* as_skia_path_new(void) { return NULL; }
static inline void as_skia_path_delete(void* p) { (void)p; }
static inline void as_skia_path_move_to(void* p, double x, double y) { (void)p; (void)x; (void)y; }
static inline void as_skia_path_line_to(void* p, double x, double y) { (void)p; (void)x; (void)y; }
static inline void as_skia_path_cubic_to(void* p, double c1x, double c1y, double c2x, double c2y, double x, double y) { (void)p; (void)c1x; (void)c1y; (void)c2x; (void)c2y; (void)x; (void)y; }
static inline void as_skia_path_quad_to(void* p, double cx, double cy, double x, double y) { (void)p; (void)cx; (void)cy; (void)x; (void)y; }
static inline void as_skia_path_add_rect(void* p, double x, double y, double w, double h) { (void)p; (void)x; (void)y; (void)w; (void)h; }
static inline void as_skia_path_add_circle(void* p, double cx, double cy, double r) { (void)p; (void)cx; (void)cy; (void)r; }
static inline void as_skia_path_add_oval(void* p, double x, double y, double w, double h) { (void)p; (void)x; (void)y; (void)w; (void)h; }
static inline void as_skia_path_add_rrect(void* p, double x, double y, double w, double h, double rx, double ry) { (void)p; (void)x; (void)y; (void)w; (void)h; (void)rx; (void)ry; }
static inline void as_skia_path_close(void* p) { (void)p; }
static inline void as_skia_path_close_all(void* p) { (void)p; }
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
static inline void as_skia_canvas_draw_image_rect(void* c, void* img, double dx, double dy, double dw, double dh, int smooth) { (void)c; (void)img; (void)dx; (void)dy; (void)dw; (void)dh; (void)smooth; }
static inline void as_skia_canvas_draw_bgra(void* c, const uint8_t* bgra, int w, int h, double dx, double dy, double dw, double dh) { (void)c; (void)bgra; (void)w; (void)h; (void)dx; (void)dy; (void)dw; (void)dh; }
static inline void as_skia_gl_draw_texture(void* c, void* tex, int w, int h, double dx, double dy, double dw, double dh) { (void)c; (void)tex; (void)w; (void)h; (void)dx; (void)dy; (void)dw; (void)dh; }
static inline void as_skia_canvas_draw_text(void* c, const char* t, double x, double y, double sz, int bold, int italic, void* p) { (void)c; (void)t; (void)x; (void)y; (void)sz; (void)bold; (void)italic; (void)p; }
static inline void as_skia_canvas_draw_text_n(void* c, const char* t, int len, double x, double y, double sz, int bold, int italic, void* p) { (void)c; (void)t; (void)len; (void)x; (void)y; (void)sz; (void)bold; (void)italic; (void)p; }
static inline double as_skia_text_measure(const char* t, double sz, int bold, int italic) { (void)t; (void)sz; (void)bold; (void)italic; return 0.0; }
static inline double as_skia_text_measure_n(const char* t, int len, double sz, int bold, int italic) { (void)t; (void)len; (void)sz; (void)bold; (void)italic; return 0.0; }
static inline void* as_skia_textlayout_new(const char* t, const char* fam, double sz, int bold, int italic, unsigned color, double w, int align, int collapse) { (void)t; (void)fam; (void)sz; (void)bold; (void)italic; (void)color; (void)w; (void)align; (void)collapse; return NULL; }
static inline void* as_skia_textlayout_new_leading(const char* t, const char* fam, double sz, int bold, int italic, unsigned color, double leading, double w, int align, int collapse) { (void)t; (void)fam; (void)sz; (void)bold; (void)italic; (void)color; (void)leading; (void)w; (void)align; (void)collapse; return NULL; }
static inline void* as_skia_textlayout_new_runs(const char* t, const sk_text_run* def, const sk_text_run* runs, int n, double w, int align, int collapse) { (void)t; (void)def; (void)runs; (void)n; (void)w; (void)align; (void)collapse; return NULL; }
static inline double as_skia_textlayout_height(void* p) { (void)p; return 0.0; }
static inline double as_skia_textlayout_max_width(void* p) { (void)p; return 0.0; }
static inline double as_skia_textlayout_text_width(void* p) { (void)p; return 0.0; }
static inline int as_skia_textlayout_line_count(void* p) { (void)p; return 0; }
static inline int as_skia_textlayout_line_metrics(void* p, int* s, int* e, double* t, double* b, int cap) { (void)p; (void)s; (void)e; (void)t; (void)b; (void)cap; return 0; }
static inline int as_skia_textlayout_line_box(void* p, int i, double ld, const char* fam, double sz, int b, int it, double* a, double* d, double* l, double* w) { (void)p; (void)i; (void)ld; (void)fam; (void)sz; (void)b; (void)it; (void)a; (void)d; (void)l; (void)w; return 0; }
static inline void as_skia_textlayout_paint(void* p, void* c, double x, double y) { (void)p; (void)c; (void)x; (void)y; }
static inline void as_skia_textlayout_paint_underline(void* p, void* c, double ox, const double* ry, int nl, const int* u16, const unsigned* col, int nr) { (void)p; (void)c; (void)ox; (void)ry; (void)nl; (void)u16; (void)col; (void)nr; }
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
static inline int as_window_create(int w, int h, const char* title, int resizable, int maximizable, int minimizable,
                                   int decorated, int highdpi,
                                   int gpu,
                                   void (*on_mouse)(int, double, double, const char*),
                                   void (*on_wheel)(int, double, double, double),
                                   void (*on_key)(int, const char*, int, int, int),
                                   void (*on_redraw)(int),
                                   void (*on_frame)(int),
                                   double (*on_frame_delay)(int),
                                   void* (*on_resize)(int, int, int, int, int, double),
                                   void (*on_close)(int)) {
    (void)w; (void)h; (void)title; (void)resizable; (void)maximizable; (void)minimizable; (void)decorated; (void)highdpi; (void)gpu;
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
// No window => no non-client frame, so globalToScreen degenerates to the window's
// own origin (a headless build has no screen to convert into anyway).
static inline void as_window_get_borders(int id, int* top, int* left, int* bottom, int* right) { (void)id; if (top) *top = 0; if (left) *left = 0; if (bottom) *bottom = 0; if (right) *right = 0; }
// No event loop to end: NativeApplication.exit() in a headless build is a no-op
// whose observable effect is simply that the program stops there.
static inline void as_window_request_exit(void) { }
// flash.system.System.exit(code:uint) with no event loop: nothing to stop, so the
// code is only recorded for main() to return.
static int as_exit_status = 0;
static inline void as_system_exit(unsigned code) { as_exit_status = (int)code; }
// No window => no non-client frame, so globalToScreen degenerates to the window's
// own origin (a headless build has no screen to convert into anyway).
// No event loop to end: NativeApplication.exit() in a headless build is a no-op
// whose observable effect is simply that the program stops there.
static inline void as_window_close(int id) { (void)id; }
static inline int as_window_take_close_request(int id) { (void)id; return 0; }
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
static inline int as_window_os_display_state(int id) { (void)id; return -1; }
static inline int as_window_is_active(int id) { (void)id; return 0; }
static inline void as_window_set_always_in_front(int id, int on) { (void)id; (void)on; }
static inline void as_window_set_transparent(int id, int on) { (void)id; (void)on; }
static inline void* as_window_native_handle(int id) { (void)id; return NULL; }
static inline void as_window_get_limits(int id, int* mnw, int* mnh, int* mxw, int* mxh) {
    (void)id; if (mnw) *mnw = 0; if (mnh) *mnh = 0; if (mxw) *mxw = 0; if (mxh) *mxh = 0;
}
static inline void as_window_set_limits(int id, int mnw, int mnh, int mxw, int mxh) {
    (void)id; (void)mnw; (void)mnh; (void)mxw; (void)mxh;
}
static inline void as_window_limits_floor(int* fw, int* fh) { if (fw) *fw = 0; if (fh) *fh = 0; }
static inline void as_window_limits_default(int* mnw, int* mnh, int* mxw, int* mxh) {
    if (mnw) *mnw = 0; if (mnh) *mnh = 0; if (mxw) *mxw = 0; if (mxh) *mxh = 0;
}
static inline int as_window_start_move(int id) { (void)id; return 0; }
static inline int as_window_start_resize(int id, const char* edge) { (void)id; (void)edge; return 0; }
static inline int as_window_main(void) { return -1; }
static inline int as_window_get_display_size(int* w, int* h) { if (w) *w = 0; if (h) *h = 0; return 0; }
static inline int as_screen_count(void) { return 1; }
static inline int as_screen_bounds(int i, int* x, int* y, int* w, int* h) { (void)i; if (x) *x = 0; if (y) *y = 0; if (w) *w = 0; if (h) *h = 0; return 0; }
static inline int as_screen_usable_bounds(int i, int* x, int* y, int* w, int* h) { (void)i; if (x) *x = 0; if (y) *y = 0; if (w) *w = 0; if (h) *h = 0; return 0; }
static inline int as_screen_color_depth(void) { return 32; }
static inline double as_window_device_scale(int w, int h, int* pw, int* ph) { if (pw) *pw = w; if (ph) *ph = h; (void)w; (void)h; return 1.0; }
static inline double as_window_display_refresh(int win) { (void)win; return 0.0; }
#endif

// ---------- Graphics.beginGradientFill: what the 2-stop linear path cannot draw ----------
// The AS3 gradient API is implemented for the case this project actually draws:
// a LINEAR gradient with exactly two stops spanning the whole ratio range, spread
// PAD, focal 0 -- placed by the caller's Matrix (which maps the gradient space
// +-819.2 px onto the shape). Any OTHER shape of the call would otherwise paint a
// gradient that is not the one asked for, so it reports itself ONCE here instead
// (its own flag, not as_shell_warn_count: this is a documented approximation every
// frame of a rendered app could hit, not a one-off missing member).
static void as_gradient_general_report(void) {
    static bool done = false;
    if (done) return;
    done = true;
    fprintf(stderr, "[as3-aot] Graphics.beginGradientFill: this build draws a 2-stop LINEAR gradient with SpreadMethod.PAD; radial / extra stops / other spreads / a focal point or a narrowed ratio range are approximated\\n");
}
// InterpolationMethod.LINEAR_RGB interpolates the stops in linear RGB (Adobe's
// documented difference from the default InterpolationMethod.RGB). Skia's gradient
// shader interpolates in the destination space, so a LINEAR_RGB gradient here is
// interpolated in sRGB -- i.e. every intermediate pixel can differ. Reported once.
static void as_gradient_linearrgb_report(void) {
    static bool done = false;
    if (done) return;
    done = true;
    fprintf(stderr, "[as3-aot] Graphics.beginGradientFill: InterpolationMethod.LINEAR_RGB is not implemented; the gradient is interpolated in sRGB\\n");
}

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
// File.getDirectoryListingAsync: enumerate a directory INTO entry names on the
// worker thread. This is the one member of the File async family that was
// implemented for real but synchronously before it existed -- it listed inline
// and dispatched from the same call, so the AS3 thread paid for the whole walk
// and a listener registered after the call never fired. adl puts the walk on its
// own IO thread (measured: a 20,000-entry directory returns from the call in
// 0 ms with the event ~10.6 s later), which is what this kind reproduces. Only
// the NAMES are staged here: a worker must never touch the GC heap, and the
// File objects are generated in the finish thunk, on the AS3 thread.
#define AS_JOB_DIR        10
// File.deleteFileAsync / deleteDirectoryAsync / moveToTrashAsync: same shape as
// AS_JOB_DIR (the filesystem work moves off the AS3 thread, the event arrives at a
// frame boundary), with the operation itself carried in the job's 'binary' field.
// These three used to do the work AND dispatch the event inside the call, so
// f.deleteFileAsync() had already deleted the file when it returned and a listener
// added right afterwards never fired -- both measured wrong against adl 51.4.1
// (temp/fileempty/): the file still exists right after the call, the event arrives
// later, a second call while one is in flight throws #2037, and cancel() drops the
// event without undoing the work.
#define AS_JOB_FS_OP      11

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
// AS_JOB_DIR only: the path does not exist at all. adl reports this one as
// ioError #3003 (measured), which is a DIFFERENT outcome from "exists but is not
// a directory" -- that one completes with an empty listing and no error. Both
// are needed to match the member, so the two cases cannot share AS_JOB_ERR_IO.
#define AS_JOB_ERR_NOT_FOUND 4

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
    // AS_JOB_DIR: the entry names the worker enumerated, in the order readdir
    // returned them (AIR does not sort: measured order is the raw directory
    // order, and 'files' matches the SYNC member's order for the same path).
    // Plain malloc'd C strings -- never GC memory -- and freed by retire.
    char** names;
    int name_count;
    int name_cap;
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
    // Wall-clock (as_now_ms) at which this job reached AS_JOB_DONE. Read only by
    // the ASC_NET_TRACE diagnostic, where "when did the worker finish" against
    // "when did the AS3 thunk run" is the whole question: an event that fires
    // long after its transfer finished means the frame boundary starved, while a
    // late transfer means the worker pool did.
    double t_done;
} as_job;

static as_job** as_jobs = NULL;
static int as_job_count = 0;
static int as_job_cap = 0;
// Guards against a thunk re-entering the frame boundary (see as_async_tick).
static int as_async_in_tick = 0;

// ASC_NET_TRACE=1: one stderr line per transfer at each stage -- claimed by a
// worker (with the number of jobs still queued behind it), finished, and handed
// to AS3. This exists because "请求超时" alone cannot be attributed: the meeting
// client TKURLLoader reports a timeout off a 25 s setTimeout and never looks
// at the transfer, so the same message covers a saturated pool, a slow server and
// a starved frame boundary -- three different bugs. Resolved once; the hot path
// only pays a branch on a cached flag.
static int as_net_trace(void) {
    static int on = -1;
    if (on < 0) {
        const char* e = getenv("ASC_NET_TRACE");
        on = (e != NULL && e[0] != '0' && e[0] != '\0') ? 1 : 0;
    }
    return on;
}

// Requires the job lock held.
static int as_job_queued_locked(void) {
    int n = 0;
    for (int i = 0; i < as_job_count; i++) {
        as_job* q = as_jobs[i];
        if (q != NULL && q->state == AS_JOB_QUEUED && !q->dead) n++;
    }
    return n;
}

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
// Windows has no pthread.h. The CRITICAL_SECTION array below does the same job a
// pthread_mutex_t array does on POSIX, and since stage 230 it is load-bearing:
// the Win32 backend runs transfers on the worker pool too (ASC_ASYNC_THREADS),
// so four workers really do share this cookie jar concurrently. One-time init
// needs the Win32 stand-in for pthread_once, which is InitOnceExecuteOnce.
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
// whenever ASC_ASYNC_THREADS is set (it is, on every native target: POSIX
// pthreads, Windows over the SRWLOCK shim above), so the AS3 thread never blocks
// on the network. A 4xx/5xx is NOT a curl error:
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
    // libcurl's default progress meter prints a transfer table to stderr on EVERY
    // request. AIR prints nothing for a URLLoader, and now that Windows transfers
    // run on four workers the rows interleave into unreadable noise -- disable it
    // rather than leave the stream polluted (it also hid our own [as3-aot] http:
    // failure lines behind a progress block).
    curl_easy_setopt(h, CURLOPT_NOPROGRESS, 1L);
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
        // An ioError with no cause is untriable. AIR's #2032 tells the .as
        // program only that the transfer failed, and the AS3-visible text must
        // stay byte-identical to AIR's, so the cause goes to stderr instead:
        // libcurl's own code and sentence, plus the URL that failed. Without
        // this line a transport failure on one host out of many is
        // indistinguishable from the server refusing the request (阶段一百五十三:
        // the SMS-code login request reported #2032 while the same POST answered
        // 200 with plain curl).
        if (rc != CURLE_OK) {
            fprintf(stderr, "[as3-aot] http: %s (%d) for %s\\n", curl_easy_strerror(rc), (int)rc, (j->path != NULL) ? j->path : "(no url)");
        } else {
            fprintf(stderr, "[as3-aot] http: response buffer out of memory for %s\\n", (j->path != NULL) ? j->path : "(no url)");
        }
        fflush(stderr);
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

// ---- the pump's JS side, as EM_JS functions -------------------------------
// NOT EM_ASM bodies: EM_ASM expands to inline asm, and clang's wasm backend
// refuses to compile a function that contains inline asm AND setjmp -- "fatal
// error: error in backend: Cannot use EM_ASM* alongside setjmp/longjmp in
// Stage_dispatchFrame". -O2 inlines this pump into the frame dispatcher, which
// is the frame's exception recovery point (so it holds the setjmp), hence every
// web build that links the fetch backend failed to compile while these bodies
// were EM_ASM (measured on examples/air-native and examples/air-starling-demo;
// the same fatal appears at any -O2, and the error moves to whichever setjmp
// frame the pump lands in). One small EM_JS function per accessor keeps the JS
// opaque to the C optimizer, which is what the backend needs.
//
// Each body is a single statement chain with no empty JS string literal: EM_JS
// bodies go through the C preprocessor as pp-tokens, where an empty quoted
// string is not a valid
// token (docs/zh-cn/flash-net.md §…). And they must not call Emscripten JS
// library helpers -- those are only linked when COMPILED code calls them.
EM_JS(int, as_web_q_next, (void), {
    var Q = globalThis.__ascHttpQ;
    if (!Q || Q.length === 0) { globalThis.__ascCur = null; return 0; }
    globalThis.__ascCur = Q.shift();
    return globalThis.__ascCur.kind;
});
EM_JS(unsigned, as_web_cur_job, (void), { return globalThis.__ascCur.job; });
EM_JS(unsigned, as_web_cur_serial, (void), { return globalThis.__ascCur.serial; });
EM_JS(int, as_web_cur_buflen, (void), {
    var e = globalThis.__ascCur;
    return (e && e.buf) ? e.buf.length : 0;
});
EM_JS(void, as_web_cur_buf, (unsigned dst), {
    var e = globalThis.__ascCur;
    if (e && e.buf) HEAPU8.set(e.buf, dst);
});
EM_JS(int, as_web_cur_status, (void), { return globalThis.__ascCur.status; });
EM_JS(int, as_web_cur_redirected, (void), { return globalThis.__ascCur.redirected ? 1 : 0; });
EM_JS(unsigned, as_web_cur_clen, (void), { return globalThis.__ascCur.clen; });
EM_JS(void, as_web_cur_clear, (void), { globalThis.__ascCur = null; });
EM_JS(int, as_web_jsstr_len, (const char* key), {
    var e = globalThis.__ascCur;
    var s = e ? e[UTF8ToString(key)] : 0;
    return s ? new TextEncoder().encode(s).length : 0;
});
EM_JS(void, as_web_jsstr_copy, (unsigned dst, const char* key, int n), {
    var e = globalThis.__ascCur;
    var b = new TextEncoder().encode(e[UTF8ToString(key)]);
    HEAPU8.set(b.subarray(0, n), dst);
});

// Copy one string field of the entry under the pump's cursor into malloc'd
// memory. The UTF-8 length is taken first and the buffer sized exactly.
//
// The bytes are encoded with TextEncoder rather than Emscripten's stringToUTF8:
// the JS library functions are only linked into the build when COMPILED code
// calls them, so reaching for one from a JS body is a runtime ReferenceError
// (observed: "stringToUTF8 is not defined"). TextEncoder is a browser built-in
// and needs nothing from the Emscripten library.
static char* as_web_take_jsstr(const char* key) {
    int n = as_web_jsstr_len(key);
    char* out = (char*)malloc((size_t)n + 1);
    if (out == NULL) return NULL;
    if (n > 0) as_web_jsstr_copy((unsigned)(uintptr_t)out, key, n);
    out[n] = '\\0';
    return out;
}

// Drain one entry: bytes first (a chunk must reach the live buffer, and a
// terminal body must be staged, before the job is marked done), then the
// metadata. Returns 0 when the queue is empty.
static int as_web_fetch_pump(void) {
    int consumed = 0;
    for (;;) {
        int kind = as_web_q_next();
        if (kind == 0) break;
        consumed++;
        unsigned jobp = as_web_cur_job();
        unsigned serial = as_web_cur_serial();
        as_job* j = as_job_find((void*)(uintptr_t)jobp, serial);
        int n = as_web_cur_buflen();
        unsigned char* buf = NULL;
        if (n > 0) {
            buf = (unsigned char*)malloc((size_t)n + 1);
            if (buf != NULL) {
                buf[n] = 0;
                as_web_cur_buf((unsigned)(uintptr_t)buf);
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
                j->status = as_web_cur_status();
                j->redirected = as_web_cur_redirected();
                j->expected_total = as_web_cur_clen();
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
        as_web_cur_clear();
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
// Append one entry name to an AS_JOB_DIR job. The names are the ONLY thing
// staged for that kind: File.isDirectory is a getter and probes the filesystem
// lazily on the AS3 thread, so the worker does not stat each entry (AIR does not
// either -- the 20,000-entry measurement comes back with nothing but File
// objects). Returns 0 on out-of-memory, which the caller turns into an IO error
// rather than a short listing that looks complete.
static int as_job_dir_push(as_job* j, const char* name) {
    if (j->name_count == j->name_cap) {
        int cap = (j->name_cap == 0) ? 64 : j->name_cap * 2;
        char** grown = (char**)realloc((void*)j->names, (size_t)cap * sizeof(char*));
        if (grown == NULL) return 0;
        j->names = grown;
        j->name_cap = cap;
    }
    size_t n = strlen(name);
    char* copy = (char*)malloc(n + 1);
    if (copy == NULL) return 0;
    memcpy(copy, name, n + 1);
    j->names[j->name_count++] = copy;
    return 1;
}

// Implemented beside the File class (emit.ts): the async delete/trash members run
// their filesystem work on the job thread, so the operation lives with the rest of
// the File helpers and is declared here for the worker's dispatch below. Pure C by
// contract -- a worker must never touch the GC heap.
static int as_file_op_run(const char* path, int op);

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
            //
            // AS_JOB_DECODE (Loader.loadBytes) needs them for the SAME reason and
            // used to drop them: the payload was freed and bytes/len were nulled
            // as only-needed-to-decode, but the finish thunk builds bd->image
            // from exactly those bytes. With neither payload nor URL left, the
            // Bitmap kept correct pixels in bitmapData and still painted
            // NOTHING (the display-list Bitmap draws only from bd->image). That
            // is how the TalkMED login page lost its graphical captcha (a JPEG
            // handed to loadBytes) even after the request itself succeeded
            // (stage 154); measured with an in-app probe printing
            // content=[object Bitmap] w=100 h=50 next to a blank slot.
            int keep_encoded = (j->kind == AS_JOB_DECODE);
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
            // (Exceptions: a fetched payload and a loadBytes payload, which the
            // finish thunk still needs to build the display image.)
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
            // APPEND opens at EOF (AIR: position == file length right after open);
            // MSVC's "ab" only seeks on the first write.
            if (mode[0] == 'a') fseek((FILE*)h, 0, SEEK_END);
#ifdef _WIN32
            // long is 32 bits here, so both the >2 GB size and the restored
            // position need the UCRT's 64-bit forms.
            {
              __int64 cur = _ftelli64((FILE*)h);
              _fseeki64((FILE*)h, 0, SEEK_END);
              j->total = (unsigned)_ftelli64((FILE*)h);
              _fseeki64((FILE*)h, cur, SEEK_SET);
            }
#else
            {
              long cur = ftell((FILE*)h);
              fseek((FILE*)h, 0, SEEK_END);
              j->total = (unsigned)ftell((FILE*)h);
              fseek((FILE*)h, cur, SEEK_SET);
            }
#endif
            break;
        }
        case AS_JOB_FS_OP: {
            // j->binary carries the operation (see as_file_op_run). The result is an
            // AIR error id, not an AS_JOB_ERR_* code, because the finish thunk has to
            // report the SAME id and sentence the synchronous member would throw.
            j->error = as_file_op_run(j->path, j->binary);
            break;
        }
        case AS_JOB_DIR: {
            // Enumerating HERE (on the worker) is the point of this kind. The failure
            // shapes are NOT symmetric, and adl is the authority for all of them
            // (temp/listingprobe/, adl 51.4.1): a path that does not exist never
            // completes (ioError #3003); a path that exists and is not a directory
            // DOES complete, with an empty files array; and an UNREADABLE directory
            // (opendir EACCES) also completes with an empty listing -- it is NOT an
            // error. So "the open failed" is not by itself an error here: only a
            // failed stat() is. AS_JOB_ERR_IO is left to the allocation failure
            // below, where we could not build the list at all.
            if (j->path == NULL) { j->error = AS_JOB_ERR_NOT_FOUND; break; }
#ifdef _WIN32
            // MSVC has no dirent.h: enumerate with FindFirstFile, which wants a
            // backslash separator and a "<dir>\\*" pattern (same shape as the sync
            // member's body in emit.ts).
            size_t pn = strlen(j->path);
            char* pat = (char*)malloc(pn + 3);
            if (pat == NULL) { j->error = AS_JOB_ERR_IO; break; }
            memcpy(pat, j->path, pn);
            for (size_t i = 0; i < pn; i++) if (pat[i] == '/') pat[i] = '\\\\';
            pat[pn] = '\\\\'; pat[pn + 1] = '*'; pat[pn + 2] = '\\0';
            WIN32_FIND_DATAA fd;
            HANDLE h = FindFirstFileA(pat, &fd);
            free(pat);
            if (h == INVALID_HANDLE_VALUE) {
                struct stat st;
                // Only a failed stat() is an error; an unreadable-but-existing
                // directory completes with an empty listing (measured on adl).
                if (stat(j->path, &st) != 0) { j->error = AS_JOB_ERR_NOT_FOUND; break; }
                break;
            }
            do {
                if (strcmp(fd.cFileName, ".") == 0 || strcmp(fd.cFileName, "..") == 0) continue;
                if (!as_job_dir_push(j, fd.cFileName)) { j->error = AS_JOB_ERR_IO; break; }
            } while (FindNextFileA(h, &fd) != 0);
            FindClose(h);
#else
            DIR* d = opendir(j->path);
            if (d == NULL) {
                struct stat st;
                // Same rule as the Windows branch above: a failed stat() means the
                // path is gone (#3003), anything else -- not a directory, EACCES --
                // completes with an empty listing, exactly as measured on adl.
                if (stat(j->path, &st) != 0) { j->error = AS_JOB_ERR_NOT_FOUND; break; }
                break;
            }
            struct dirent* e;
            while ((e = readdir(d)) != NULL) {
                if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
                if (!as_job_dir_push(j, e->d_name)) { j->error = AS_JOB_ERR_IO; break; }
            }
            closedir(d);
#endif
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

// Real threads wherever the platform can give them. WASI Preview 1 has no thread
// primitives at all, and Emscripten threads need -pthread plus SharedArrayBuffer
// and COOP/COEP response headers (which the demo's plain static server does not
// send) while on web the assets are already packed into the in-memory FS, so
// there is nothing left to overlap. Those two keep the inline strategy.
//
// Windows used to be excluded as well ("no Win32 thread path yet"), so EVERY
// transfer ran on the AS3 thread: the loop stalled for the full round trip of
// each request, and a queue that fetches one item per COMPLETE -- the meeting
// client's filmstrip does exactly that, 32 slides deep -- stalled it once per
// item. AIR never blocks the UI thread for the network, and the measured symptom
// was a document preview frozen for several seconds while its slides streamed in.
// Windows therefore gets the same worker pool, over a thin SRWLOCK +
// CONDITION_VARIABLE shim: the closest Win32 pair to pthread_mutex_t /
// pthread_cond_t (one waiter per wakeup, no lost-signal window).
#if !defined(__wasi__) && !defined(__EMSCRIPTEN__)
#define ASC_ASYNC_THREADS 1
#endif

#ifdef ASC_ASYNC_THREADS

// Four workers: enough that the asset fan-out of a loader queue overlaps, small
// enough not to oversubscribe a laptop. Claiming is first-come; there is no
// priority, matching AIR's internal queue.
//
// The count is a BUILD knob (-D AS_ASYNC_WORKERS=N via the manifest's defines),
// not a runtime one: a queue that is deep because the app prefetches every slide
// delays a job without ever failing it, and the app only sees its own timer fire
// (ASC_NET_TRACE prints the queue depth behind each claim so that is measurable).
// Raising it is the app's call -- these jobs are I/O-bound.
#ifndef AS_ASYNC_WORKERS
#define AS_ASYNC_WORKERS 4
#endif

#ifdef _WIN32
// _beginthreadex, not CreateThread: the workers malloc, fopen and call libcurl,
// and the MSVC CRT needs the per-thread block CreateThread does not set up.
#include <process.h>
typedef SRWLOCK as_jm_t;
typedef CONDITION_VARIABLE as_jc_t;
static as_jm_t as_job_lock = SRWLOCK_INIT;
static as_jc_t as_job_wake = CONDITION_VARIABLE_INIT;
#define AS_JOB_LOCK(m)      AcquireSRWLockExclusive(m)
#define AS_JOB_UNLOCK(m)    ReleaseSRWLockExclusive(m)
#define AS_JOB_WAIT(c, m)   SleepConditionVariableSRW((c), (m), INFINITE, 0)
#define AS_JOB_WAKE_ALL(c)  WakeAllConditionVariable(c)
#else
#include <pthread.h>
typedef pthread_mutex_t as_jm_t;
typedef pthread_cond_t as_jc_t;
static as_jm_t as_job_lock = PTHREAD_MUTEX_INITIALIZER;
static as_jc_t as_job_wake = PTHREAD_COND_INITIALIZER;
#define AS_JOB_LOCK(m)      pthread_mutex_lock(m)
#define AS_JOB_UNLOCK(m)    pthread_mutex_unlock(m)
#define AS_JOB_WAIT(c, m)   pthread_cond_wait((c), (m))
#define AS_JOB_WAKE_ALL(c)  pthread_cond_broadcast(c)
#endif

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

// The pool loop, shared by both spawners. Never returns.
static void as_job_worker_loop(void) {
    for (;;) {
        AS_JOB_LOCK(&as_job_lock);
        as_job* j = as_job_claim_locked();
        while (j == NULL) {
            AS_JOB_WAIT(&as_job_wake, &as_job_lock);
            j = as_job_claim_locked();
        }
        int queued = as_net_trace() ? as_job_queued_locked() : 0;
        AS_JOB_UNLOCK(&as_job_lock);
        const double t_start = as_now_ms();
        if (as_net_trace()) {
            fprintf(stderr, "[as3-aot] net start kind=%d queued=%d %s\\n", j->kind, queued, (j->path != NULL) ? j->path : "-");
            fflush(stderr);
        }
        as_job_run(j);
        const double t_took = as_now_ms() - t_start;
        if (as_net_trace()) {
            fprintf(stderr, "[as3-aot] net done  kind=%d ms=%.1f err=%d len=%lu %s\\n", j->kind, t_took, j->error, (unsigned long)j->len, (j->path != NULL) ? j->path : "-");
            fflush(stderr);
        }
        AS_JOB_LOCK(&as_job_lock);
        j->state = AS_JOB_DONE;
        j->t_done = as_now_ms();
        AS_JOB_WAKE_ALL(&as_job_wake);
        AS_JOB_UNLOCK(&as_job_lock);
    }
}

#ifdef _WIN32
static unsigned __stdcall as_job_worker_win(void* arg) {
    (void)arg;
    as_job_worker_loop();
    return 0;
}

static void as_async_start_workers(void) {
    if (as_workers_started) return;
    as_workers_started = 1;
    for (int i = 0; i < AS_ASYNC_WORKERS; i++) {
        // Handles are detached at once: the pool lives for the whole process, and
        // a spawn that fails just leaves one worker fewer (the queue is claimed
        // first-come, so a short pool is slower but still correct).
        HANDLE h = (HANDLE)_beginthreadex(NULL, 0, as_job_worker_win, NULL, 0, NULL);
        if (h != NULL) CloseHandle(h);
    }
}
#else
static pthread_t as_worker_ids[AS_ASYNC_WORKERS];

static void* as_job_worker(void* arg) {
    (void)arg;
    as_job_worker_loop();
    return NULL;
}

static void as_async_start_workers(void) {
    if (as_workers_started) return;
    as_workers_started = 1;
    for (int i = 0; i < AS_ASYNC_WORKERS; i++) pthread_create(&as_worker_ids[i], NULL, as_job_worker, NULL);
}
#endif
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
    AS_JOB_LOCK(&as_job_lock);
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
        AS_JOB_UNLOCK(&as_job_lock);
#endif
        return 0;
    }
    as_jobs[as_job_count++] = j;
#ifdef ASC_ASYNC_THREADS
    AS_JOB_WAKE_ALL(&as_job_wake);
    AS_JOB_UNLOCK(&as_job_lock);
#else
    // Inline strategy: the payload runs here and now, so the job is already
    // finished when publish returns and the frame boundary only runs the thunk.
    // A job that merely STARTED its transfer (web fetch) is the exception: it
    // stays RUNNING until the JS pump delivers the response at a later frame,
    // otherwise the thunk would run on a job with no status and no body.
    as_job_run(j);
    if (!j->pending_async) { j->state = AS_JOB_DONE; j->t_done = as_now_ms(); }
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
// Defined with File (emit.ts) because it needs the app and storage roots.
static char* as_local_path_from_url(const char* url);

static void* as_async_submit_image(void* obj, void (*finish)(void*), const char* url) {
    // A local image load is a URL, not a path: AIR hands File.url straight to
    // Loader.load and that string is "app-storage:/x", "app:/x" or
    // "file:///C:/x" (measured on 51.4.1). Reading it as a literal path found
    // nothing, so a file that had already downloaded into the app storage
    // directory reported #2035 "URL Not Found" -- the TalkMED gift icons, whose
    // bitmap never arrived and left the list as bare titles.
    if (!as_job_is_remote_url(url)) return as_async_submit(AS_JOB_IMAGE, obj, finish, as_local_path_from_url(url), NULL, 0);
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
    if (j->names != NULL) {
        for (int i = 0; i < j->name_count; i++) free(j->names[i]);
        free(j->names);
        j->names = NULL;
        j->name_count = 0;
        j->name_cap = 0;
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
        AS_JOB_LOCK(&as_job_lock);
#endif
        for (int i = 0; i < as_job_count && ln < (int)(sizeof(live) / sizeof(live[0])); i++) {
            as_job* j = as_jobs[i];
            if (j != NULL && j->state == AS_JOB_RUNNING && j->net_events && !j->dead) live[ln++] = j;
        }
#ifdef ASC_ASYNC_THREADS
        AS_JOB_UNLOCK(&as_job_lock);
#endif
        for (int i = 0; i < ln; i++) as_net_pre_events((void*)live[i]);
    }

    int finished = 0;
    for (int pass = 0; pass < 16; pass++) {
        as_job* ready[8];
        int n = 0;

        // Phase 1 (locked): pick the thunks that are due.
#ifdef ASC_ASYNC_THREADS
        AS_JOB_LOCK(&as_job_lock);
#endif
        for (int i = 0; i < as_job_count; i++) {
            as_job* j = as_jobs[i];
            if (j == NULL || j->state != AS_JOB_DONE) continue;
            if (j->dead || j->finish == NULL) continue;  // superseded: dropped in phase 3
            if (n < (int)(sizeof(ready) / sizeof(ready[0]))) { ready[n++] = j; j->state = AS_JOB_FINISHING; }
        }
#ifdef ASC_ASYNC_THREADS
        AS_JOB_UNLOCK(&as_job_lock);
#endif

        // Phase 2 (lock released): publish the staged results.
        for (int i = 0; i < n; i++) {
            if (as_net_trace() && ready[i]->t_done > 0.0) {
                fprintf(stderr, "[as3-aot] net fire  kind=%d lag=%.1f %s\\n", ready[i]->kind, as_now_ms() - ready[i]->t_done, (ready[i]->path != NULL) ? ready[i]->path : "-");
                fflush(stderr);
            }
            if (ready[i]->finish != NULL) ready[i]->finish((void*)ready[i]);
        }

        // Phase 3 (locked): drop the jobs whose thunk has run, plus the superseded
        // ones. A superseded FS_OPEN still closes the handle it opened: its thunk
        // never ran, so nothing else took ownership.
#ifdef ASC_ASYNC_THREADS
        AS_JOB_LOCK(&as_job_lock);
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
        AS_JOB_UNLOCK(&as_job_lock);
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
        AS_JOB_LOCK(&as_job_lock);
        for (;;) {
            int pending = 0;
            for (int i = 0; i < as_job_count; i++) {
                as_job* j = as_jobs[i];
                if (j != NULL && !j->dead && (j->state == AS_JOB_QUEUED || j->state == AS_JOB_RUNNING)) { pending = 1; break; }
            }
            if (!pending) break;
            AS_JOB_WAIT(&as_job_wake, &as_job_lock);
        }
        AS_JOB_UNLOCK(&as_job_lock);
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
static const char* as_job_mode(void* job) { const char* m = ((as_job*)job)->mode; return (m != NULL) ? m : ""; }
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
// AS_JOB_DIR staging: the thunk walks the names and turns each into a generated
// File object, so it needs the count and one name at a time (never the array).
static int as_job_dir_count(void* job) { return ((as_job*)job)->name_count; }
static char* as_job_dir_name(void* job, int i) { as_job* j = (as_job*)job; return (i >= 0 && i < j->name_count) ? j->names[i] : NULL; }
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
// Is a listing already in flight for 'obj'? AIR rejects a SECOND
// getDirectoryListingAsync() on a File whose listing has not been delivered yet
// with #2037 (measured: the first still completes, the second throws), so the
// guard cannot be "just submit another job" -- as_job_publish would supersede
// the in-flight one and dispatch only one event, which is the opposite outcome.
// No lock: the job table belongs to the AS3 thread (same rule as as_async_cancel).
static int as_async_kind_pending(void* obj, int kind) {
    for (int i = 0; i < as_job_count; i++) {
        as_job* j = as_jobs[i];
        if (j == NULL || j->kind != kind || j->obj != obj) continue;
        if (!j->dead && j->state != AS_JOB_FINISHING) return 1;
    }
    return 0;
}

static int as_async_dir_pending(void* obj) {
    return as_async_kind_pending(obj, AS_JOB_DIR);
}

// The same "one in flight at a time" rule for the delete/trash members: AIR rejects
// a second call with #2037 while the first has not reported yet (measured).
static int as_async_op_pending(void* obj) {
    return as_async_kind_pending(obj, AS_JOB_FS_OP);
}

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
    AS_JOB_LOCK(&as_job_lock);
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
    AS_JOB_UNLOCK(&as_job_lock);
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
    AS_JOB_LOCK(&as_job_lock);
#endif
    size_t n = (j->len > j->consumed) ? (j->len - j->consumed) : 0;
#ifdef ASC_ASYNC_THREADS
    AS_JOB_UNLOCK(&as_job_lock);
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
    AS_JOB_LOCK(&as_job_lock);
#endif
    size_t avail = (j->len > j->consumed) ? (j->len - j->consumed) : 0;
    size_t k = ((size_t)n < avail) ? (size_t)n : avail;
    if (k > 0 && dst != NULL) memcpy(dst, j->bytes + j->consumed, k);
    j->consumed += k;
#ifdef ASC_ASYNC_THREADS
    AS_JOB_UNLOCK(&as_job_lock);
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
//
// System.useCodePage is AIR's legacy "encode URL/URLVariables data with the system
// code page instead of UTF-8" flag (default false). Our URL layer always encodes
// UTF-8, which is exactly what AIR does while the flag is false -- so the flag is
// STORED (a read returns what was written, AS3 property semantics) and a write of
// TRUE reports the one case this build cannot honour, once, instead of silently
// changing nothing.
static bool as_sys_use_code_page = false;
static void as_sys_set_use_code_page(bool v) {
    as_sys_use_code_page = v;
    if (v) as_shell_unsupported("System.useCodePage=true (this build always encodes URL data as UTF-8)");
}
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
// Render-path counters shared with the generated code (emit.ts): how many
// subtrees were painted live vs. blitted from a bake inside the reporting
// window. They separate "the frame got slower" from "the frame got slower
// because the auto-bake gave up", which is the FPS question after the
// AS_BAKE_MAX_PIXELS fallback.
static int as_dbg_live_n = 0;
static int as_dbg_cached_n = 0;
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
    fprintf(stderr, "FRAME n=%d p50=%.2f p95=%.2f p99=%.2f max=%.2f(worstgc=%.2f) over8ms=%d over17ms=%d | gcmax=%.2f gcavg=%.2f gcshare=%.1f%% | rss=%.0fMB arena=%.0fMB heaptotal=%.0fMB inuse=%.0fMB/%ldobj segs=%zu freeb=%.0fMB | live=%d cached=%d\\n",
            n, as_dbg_sort_ms[n / 2], as_dbg_sort_ms[n * 95 / 100], as_dbg_sort_ms[n * 99 / 100],
            as_dbg_sort_ms[n - 1], as_dbg_gc_ms[worst], over8, over17,
            gc_max, gc_sum / (double)n, frame_sum > 0 ? 100.0 * gc_sum / frame_sum : 0.0,
            as_system_private_memory() / 1048576.0, (double)as_arena_used_bytes() / 1048576.0, gc_heap_total_bytes() / 1048576.0,
            (double)gc_dbg_inuse_bytes() / 1048576.0, gc_dbg_inuse_count(), segs,
            (double)as_dbg_free_bytes / 1048576.0, as_dbg_live_n, as_dbg_cached_n);
    fflush(stderr);
    as_dbg_frame_n = 0;
    as_dbg_live_n = 0;
    as_dbg_cached_n = 0;
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
// these helpers back its static getters. cpuArchitecture is a conditional-compile
// constant; version is injected at codegen time from package.json (NOT a runtime
// lookup — the compiled binary has no package.json to read).
//
// os reports an OS *name plus version* ("Windows 11", "Windows Server 2012 R2"), because
// AIR's does and apps depend on it: they read the version out of the string
// (Capabilities.os.split(" ")[1]) and hash the whole thing into a device fingerprint.
// The Windows branch therefore reproduces AIR 51.4.1's version->name table, recovered from
// the shipped runtime binary (the VerifyVersionInfoW chain that feeds its string pool).
// AIR queries VerifyVersionInfoW, which is subject to the manifest version lie: a process
// that does not declare the supportedOS compatibility element is answered 6.2 no matter
// how new the OS is: VerifyVersionInfoW(==10.0) answers false and GetVersionExW answers
// "6.2 build 9200", while RtlGetVersion answers "10.0 build 26200" — copying AIR's query
// verbatim would thus report Windows 11 as Windows 8. Our binaries carry no manifest, so
// the true version comes from ntdll's RtlGetVersion (resolved dynamically, so no import
// library is added) and feeds that same table; the observable result then matches AIR's.
// macOS appends its product version the same way ("Mac OS 26.6.2", measured on
// adl 51.4.1). Linux/WASI still report the bare family name: AIR appends a version there
// too, but no Linux release->name table can be verified from this dev host, so the gap is
// left stated rather than guessed at.
#ifdef _WIN32
typedef struct {
    unsigned long dwOSVersionInfoSize;
    unsigned long dwMajorVersion;
    unsigned long dwMinorVersion;
    unsigned long dwBuildNumber;
    unsigned long dwPlatformId;
    wchar_t szCSDVersion[128];
    unsigned short wServicePackMajor;
    unsigned short wServicePackMinor;
    unsigned short wSuiteMask;
    unsigned char wProductType;   // 1 = VER_NT_WORKSTATION, anything else is a server SKU
    unsigned char wReserved;
} as_os_version_info;
typedef long (__stdcall *as_rtl_get_version_fn)(as_os_version_info*);
typedef int (__stdcall *as_get_system_metrics_fn)(int);
// AIR's table verbatim. Windows 11 is 10.0 with build >= 22000, which AIR applies as a
// promotion on top of the 10.0 entry; server SKUs differ only by wProductType.
static const char* as_win_os_name(unsigned long major, unsigned long minor, unsigned long build,
                                 unsigned short suite, int server) {
    if (major == 10 && minor == 0) {
        if (build >= 22000) return server ? "Windows 11 Server" : "Windows 11";
        return server ? "Windows 10 Server" : "Windows 10";
    }
    if (major == 6 && minor == 3) return server ? "Windows Server 2012 R2" : "Windows 8.1";
    if (major == 6 && minor == 2) return server ? "Windows Server 2012" : "Windows 8";
    if (major == 6 && minor == 1) return server ? "Windows Server 2008 R2" : "Windows 7";
    if (major == 6 && minor == 0) return server ? "Windows Server 2008" : "Windows Vista";
    if (major == 5 && minor == 2) {
        if (!server && suite == 0x8000) return "Windows Home Server";   // VER_SUITE_WH_SERVER
        if (!server) return "Windows XP 64";                            // XP x64 Edition
        // SM_SERVERR2 (= 89) tells 2003 R2 from plain 2003. Resolved dynamically because
        // headless builds do not link user32, and this helper is always compiled in.
        HMODULE user32 = GetModuleHandleA("user32.dll");
        as_get_system_metrics_fn metrics = user32
            ? (as_get_system_metrics_fn)(void*)GetProcAddress(user32, "GetSystemMetrics") : NULL;
        if (metrics != NULL && metrics(89) != 0) return "Windows Server 2003 R2";
        return "Windows Server 2003";
    }
    if (major == 5 && minor == 1) return "Windows XP";
    if (major == 5 && minor == 0) return "Windows 2000";
    return "Windows";   // AIR's fallback for anything its table does not name
}
#endif
static const char* as_cap_os(void) {
#ifdef __APPLE__
    // AIR appends a version on macOS too: adl 51.4.1 on macOS 26.6.2 answers
    // "Mac OS 26.6.2" (measured: temp/nwmac/nwmac-out.txt). The number is the OS
    // *product* version, not the Darwin kernel release (uname -r says 25.6.0),
    // so it comes from the kern.osproductversion sysctl -- the same value
    // SystemVersion.plist's ProductVersion holds. The family name is the bare
    // "Mac OS" AIR's own string pool carries (not "Mac OS X").
    //
    // No caching: unlike the Windows branch (whose result is a literal), this one
    // has to build a GC string, and a static-char-pointer cache would be an unrooted
    // pointer the collector could reclaim out from under the next call.
    char ver[64];
    size_t len = sizeof(ver) - 1;
    if (sysctlbyname("kern.osproductversion", ver, &len, NULL, 0) == 0 && len > 0
        && ver[0] >= '0' && ver[0] <= '9') {
        ver[len] = 0;
        char* out = as_str_alloc(7 + len + 1);   // "Mac OS " + version + NUL
        memcpy(out, "Mac OS ", 7);
        memcpy(out + 7, ver, len + 1);
        return out;
    }
    // A kernel without the sysctl (macOS before 10.13) degrades to the family
    // name, exactly like AIR's fallback for a version its table cannot name.
    return "Mac OS";
#elif defined(_WIN32)
    // Resolve once: the OS cannot change while the process runs.
    static const char* cached = NULL;
    if (cached) return cached;
    as_os_version_info vi;
    memset(&vi, 0, sizeof(vi));
    vi.dwOSVersionInfoSize = (unsigned long)sizeof(vi);
    HMODULE ntdll = GetModuleHandleA("ntdll.dll");
    as_rtl_get_version_fn rtl = ntdll
        ? (as_rtl_get_version_fn)(void*)GetProcAddress(ntdll, "RtlGetVersion") : NULL;
    // Unreachable in practice (ntdll is always loaded) -> degrade to the family name.
    if (rtl == NULL || rtl(&vi) != 0) return (cached = "Windows");
    return (cached = as_win_os_name(vi.dwMajorVersion, vi.dwMinorVersion, vi.dwBuildNumber,
                                    vi.wSuiteMask, vi.wProductType != 1));
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
// Capabilities.language / Capabilities.languages are the USER INTERFACE language,
// never the process locale and never the region format. Measured on adl 51.4.1:
//   - macOS 26.6.2: language == "zh-CN", languages == ["zh-CN"], while this
//     process's LANG is "en_US.UTF-8";
//   - Windows 11: language == "zh-CN", languages == ["zh-CN","en-US"] — and both
//     STAYED exactly that after Set-Culture moved the region format to de-DE and
//     again after de-DE was put at the head of the OS language list, so neither
//     the user locale (GetUserDefaultLocaleName answered de-DE, LangID 0x0407)
//     nor the OrderedLanguageList registry value is the source. Only the
//     region-format switch was visible to a fresh process; the language list
//     takes effect at the next sign-in, but AIR ignored both.
// The old implementation read LANG and truncated it to two letters. On Windows
// LANG is unset (launched from Explorer) or whatever the shell exported, so it
// answered "en" there unconditionally: the app's utils.Language.as
// switches to English unless Capabilities.language == "zh-CN", so a Chinese
// Windows box silently got an English UI.
//
// The CoreFoundation HEADERS cannot be included here — they pull in MacTypes.h,
// which defines struct Point, the name this compiler gives flash.geom.Point
// (AGENTS 2.6: the generated C stays header-free, and the collision is a hard
// compile error). So the few CoreFoundation entry points used below are declared
// by hand: the ABI is public and stable, the shapes are fixed (CFIndex is long,
// CFStringEncoding is UnsignedInt, Boolean is one byte), and the darwin link adds
// -framework CoreFoundation (see platformFrameworks in src/build.ts).
#if defined(__APPLE__) && !defined(__wasi__)
#define ASC_HAVE_CFLOCALE 1
typedef const void* ASC_CFRef;
typedef const void* ASC_CFStringRef;
extern ASC_CFRef CFLocaleCopyCurrent(void);
extern ASC_CFRef CFLocaleCopyPreferredLanguages(void);
extern ASC_CFRef CFLocaleGetIdentifier(ASC_CFRef locale);
extern ASC_CFRef CFArrayGetValueAtIndex(ASC_CFRef array, long idx);
extern long CFArrayGetCount(ASC_CFRef array);
extern unsigned char CFStringGetCString(ASC_CFStringRef s, char* buf, long cap, unsigned encoding);
extern void CFRelease(ASC_CFRef obj);
// kCFStringEncodingUTF8 (CFString.h), inlined because the header is off-limits.
#define ASC_CF_UTF8 0x08000100u
#endif

// Normalize a locale tag to the "language-REGION" shape AIR reports: the script
// subtag is dropped (adl turns an AppleLanguages of ["zh-Hans-CN"] into "zh-CN"),
// the region is upper-cased, and the POSIX/ICU decorations that appear in LANG
// ("zh_CN.UTF-8", "en_US@currency=USD") end the tag. A tag with no region keeps
// just the language ("en"). Writes at most cap-1 bytes plus the terminator.
static void as_cap_lang_normalize(const char* tag, char* out, size_t cap) {
    size_t n = 0;
    if (cap == 0) return;
    if (tag == NULL) { out[0] = 0; return; }
    while (*tag != 0 && *tag != '-' && *tag != '_' && *tag != '.' && *tag != '@' && n + 1 < cap) {
        out[n++] = *tag++;
    }
    while (*tag == '-' || *tag == '_') {
        const char* start;
        size_t len = 0;
        tag++;
        start = tag;
        while (start[len] != 0 && start[len] != '-' && start[len] != '_' && start[len] != '.' && start[len] != '@') len++;
        // A region subtag is two letters or three digits; anything else here is a
        // script or variant subtag, which AIR does not report (see above).
        if (len == 2 || (len == 3 && start[0] >= '0' && start[0] <= '9')) {
            size_t i;
            if (n + 1 < cap) out[n++] = '-';
            for (i = 0; i < len && n + 1 < cap; i++) {
                char c = start[i];
                if (c >= 'a' && c <= 'z') c = (char)(c - 'a' + 'A');
                out[n++] = c;
            }
            break;
        }
        tag += len;
    }
    out[n] = 0;
}

// The values Capabilities.language is ALLOWED to report. It is a closed set, not a
// locale tag: the ActionScript 3.0 reference (flash.system.Capabilities.language)
// says the value is "a lowercase two-letter language code from ISO 639-1" with an
// uppercase ISO 3166 country code appended for Chinese only, lists exactly these
// languages (plus zh-CN / zh-TW), and warns that "the value of Capabilities.language
// property is limited to the possible values on this list" — which is why it tells
// applications to read Capabilities.languages[0] instead. A language outside the
// table therefore reports "xu", the documented "Other/unknown" value, and not its
// own code.
static const char* const as_cap_air_langs[] = {
    "cs", "da", "nl", "en", "fi", "fr", "de", "hu", "it", "ja", "ko", "nb",
    "pl", "pt", "ru", "es", "sv", "tr", NULL
};

// Split a BCP-47/POSIX locale tag into its primary language (lower-cased) and its
// region (upper-cased, empty when the tag has none). Script and variant subtags are
// skipped: AIR's language value never carries one, and for the one case where the
// script matters (Chinese) the region already picks between the only two values AIR
// has ever reported for it.
static void as_cap_lang_split(const char* tag, char* lang, size_t lang_cap, char* region, size_t region_cap) {
    size_t ln = 0, rn = 0;
    if (lang_cap > 0) lang[0] = 0;
    if (region_cap > 0) region[0] = 0;
    if (tag == NULL) return;
    while (*tag != 0 && *tag != '-' && *tag != '_' && *tag != '.' && *tag != '@') {
        char c = *tag++;
        if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
        if (ln + 1 < lang_cap) lang[ln++] = c;
    }
    if (lang_cap > 0) lang[ln] = 0;
    while (*tag == '-' || *tag == '_') {
        const char* start;
        size_t len = 0;
        tag++;
        start = tag;
        while (start[len] != 0 && start[len] != '-' && start[len] != '_' && start[len] != '.' && start[len] != '@') len++;
        // A region subtag is two letters or three digits; anything else here is a
        // script ("Hans") or a variant, neither of which this value reports.
        if (len == 2 || (len == 3 && start[0] >= '0' && start[0] <= '9')) {
            size_t i;
            for (i = 0; i < len && rn + 1 < region_cap; i++) {
                char c = start[i];
                if (c >= 'a' && c <= 'z') c = (char)(c - 'a' + 'A');
                region[rn++] = c;
            }
            break;
        }
        tag += len;
    }
    if (region_cap > 0) region[rn] = 0;
}

// Map a locale tag onto Capabilities.language. See as_cap_air_langs for why a
// non-table language collapses to "xu". Chinese keeps its region because zh-CN and
// zh-TW are the only two Chinese values AIR reports (a bare "zh" -- LANGID
// SUBLANG_NEUTRAL, or a script-only tag -- is Simplified Chinese).
static const char* as_cap_language_from_tag(const char* tag, char* out, size_t cap) {
    char lang[16];
    char region[16];
    int i;
    as_cap_lang_split(tag, lang, sizeof(lang), region, sizeof(region));
    if (lang[0] == 0) return "xu";
    if (strcmp(lang, "zh") == 0) {
        int traditional = (strcmp(region, "TW") == 0 || strcmp(region, "HK") == 0 || strcmp(region, "MO") == 0);
        snprintf(out, cap, "%s", traditional ? "zh-TW" : "zh-CN");
        return out;
    }
    for (i = 0; as_cap_air_langs[i] != NULL; i++) {
        if (strcmp(lang, as_cap_air_langs[i]) == 0) {
            snprintf(out, cap, "%s", lang);
            return out;
        }
    }
    return "xu";
}

// Capabilities.language ("zh-CN"). AIR reports the UI language here, which the
// reference spells out for Windows: "this property returns the user interface (UI)
// language, which refers to the language used for all menus, dialog boxes, error
// messages, and help files". macOS reads CFLocaleCopyCurrent() (the same source adl
// uses there, so a 'defaults write -g AppleLocale' override is picked up); Windows
// rebuilds AIR's tag from GetUserDefaultUILanguage(); any other target falls back to
// the process locale, which is all a POSIX target offers.
static const char* as_cap_language(void) {
    static char tag[64];
    static char out[32];
    tag[0] = 0;
#if defined(ASC_HAVE_CFLOCALE)
    {
        ASC_CFRef loc = CFLocaleCopyCurrent();
        if (loc != NULL) {
            ASC_CFRef id = CFLocaleGetIdentifier(loc);
            int ok = 0;
            if (id != NULL) ok = CFStringGetCString((ASC_CFStringRef)id, tag, (long)sizeof(tag), ASC_CF_UTF8) ? 1 : 0;
            CFRelease(loc);
            if (!ok) tag[0] = 0;
        }
    }
#endif
#if defined(_WIN32)
    // The ISO 639-1 name plus the ISO 3166 region of the UI language is the pair
    // AIR's own table is keyed by (the region is what separates Simplified from
    // Traditional Chinese). GetLocaleInfoW on the concrete LCID is used because
    // LOCALE_SISO639LANGNAME reports "zh" for every Chinese LANGID.
    if (tag[0] == 0) {
        LCID lcid = MAKELCID(GetUserDefaultUILanguage(), SORT_DEFAULT);
        WCHAR wname[64];
        if (GetLocaleInfoW(lcid, LOCALE_SISO639LANGNAME, wname, 64) > 0 &&
            WideCharToMultiByte(CP_UTF8, 0, wname, -1, tag, (int)sizeof(tag), NULL, NULL) > 0) {
            size_t n = strlen(tag);
            if (GetLocaleInfoW(lcid, LOCALE_SISO3166CTRYNAME, wname, 64) > 0 && n + 2 < sizeof(tag)) {
                tag[n] = '-';
                if (WideCharToMultiByte(CP_UTF8, 0, wname, -1, tag + n + 1, (int)(sizeof(tag) - n - 1), NULL, NULL) <= 0) tag[n] = 0;
            }
        } else {
            tag[0] = 0;
        }
    }
#endif
    if (tag[0] == 0) {
        const char* env = getenv("LANG");
        if (!env) env = getenv("LC_ALL");
        if (env && env[0]) {
            size_t n = strlen(env);
            if (n >= sizeof(tag)) n = sizeof(tag) - 1;
            memcpy(tag, env, n);
            tag[n] = 0;
        }
    }
    if (tag[0] == 0) return "en";
    return as_cap_language_from_tag(tag, out, sizeof(out));
}

// Capabilities.languages: the user's preferred languages, most preferred first,
// each normalized exactly like 'language'. When no preference list is available the
// single entry that 'language' reports is used instead, which is what keeps the AIR
// relation between the two -- languages[0] and language agree on the PRIMARY language
// (the reference says "generally has the same primary language ID"; they are not
// always equal, e.g. "en" vs "en-US") -- true even on such a host.
static as_array* as_cap_languages(void) {
    as_array* list = as_array_new();
#if defined(ASC_HAVE_CFLOCALE)
    ASC_CFRef prefs = CFLocaleCopyPreferredLanguages();
    if (prefs != NULL) {
        long n = CFArrayGetCount(prefs);
        long i;
        for (i = 0; i < n; i++) {
            ASC_CFRef s = CFArrayGetValueAtIndex(prefs, i);
            char buf[96];
            char norm[32];
            buf[0] = 0;
            if (s != NULL && CFStringGetCString((ASC_CFStringRef)s, buf, (long)sizeof(buf), ASC_CF_UTF8)) {
                as_cap_lang_normalize(buf, norm, sizeof(norm));
                if (norm[0] != 0 && strcmp(norm, "C") != 0) as_array_push(list, as_v_str(as_str_dup(norm)));
            }
        }
        CFRelease(prefs);
    }
#endif
#if defined(_WIN32)
    // GetUserPreferredUILanguages answers the same list adl does, as a
    // double-NUL-terminated run of RFC 4646 tags ("zh-CN", "en-US") in preference
    // order — verified byte-for-byte against adl 51.4.1 on the machine used for the
    // measurements above. NOTE it reflects the EFFECTIVE UI languages: a language
    // moved to the head of the OS list reads back here (and in AIR) only after the
    // next sign-in. The buffer length is passed in WCHARs, which is also valid (and
    // merely conservative) should the API measure it in bytes.
    {
        WCHAR wbuf[512];
        ULONG cnt = 0;
        ULONG cap = (ULONG)(sizeof(wbuf) / sizeof(WCHAR));
        if (GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &cnt, wbuf, &cap)) {
            const WCHAR* w = wbuf;
            ULONG i;
            for (i = 0; i < cnt && w[0] != 0; i++) {
                char buf[96];
                if (WideCharToMultiByte(CP_UTF8, 0, w, -1, buf, (int)sizeof(buf), NULL, NULL) > 0) {
                    char norm[32];
                    as_cap_lang_normalize(buf, norm, sizeof(norm));
                    if (norm[0] != 0 && strcmp(norm, "C") != 0) as_array_push(list, as_v_str(as_str_dup(norm)));
                }
                w += lstrlenW(w) + 1;
            }
        }
    }
#endif
    if (list->length == 0) as_array_push(list, as_v_str(as_str_dup((char*)as_cap_language())));
    return list;
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
// Capabilities.screenDPI: a platform BASELINE, not the display's real DPI and not
// scaled by the desktop's zoom. Measured against adl 51.4.1 at 150% Windows
// scaling (where SDL_GetDisplayDPI answers 144): adl says 96. macOS says 72. Both
// are constants on the platform rather than a read of the panel, so answering the
// physical DPI here would be a silent divergence on every HiDPI desktop.
static double as_cap_screen_dpi(void) {
#ifdef _WIN32
    return 96.0;
#else
    return 72.0;
#endif
}
// Capabilities.serverString: AIR returns a URL-encoded summary of the runtime —
// "a URL-encoded string containing the properties of the player, including version,
// platform, language, and a random number" (AIR reference). Adobe's exact fingerprint
// byte format is not reproducible, so this build emits its OWN values in the same
// url-encoded key=value shape (the AIR keys that carry the same meaning are reused:
// SV version, MP manufacturer, p platform, l language, A=t/SA=t the two "available"
// flags AIR always sets) plus a REAL per-process random component -- callers use the
// string as PRNG/GUID entropy (com.hurlant Random, utils.Guid), so a constant would
// be a security-relevant lie. Computed once and cached, which is AIR's behaviour too
// (the property is stable for the life of the process). Deviation in TODO.md.
static char* as_cap_server_string(void) {
    static char* cached = NULL;
    if (cached != NULL) return cached;
    // Entropy: the clock, the allocator's address (ASLR) and rand() -- one per
    // process is all the property promises, and it is what makes two runs differ.
    unsigned long long nonce =
        (unsigned long long)(as_now_ms() * 1000.0)
        ^ (unsigned long long)(uintptr_t)&cached
        ^ ((unsigned long long)(unsigned int)rand() << 32)
        ^ (unsigned long long)(unsigned int)rand();
    char* nbuf = as_str_alloc(24);
    snprintf(nbuf, 24, "%llu", nonce);
    const char* parts[12];
    parts[0] = "A=t&SA=t&SV=";
    parts[1] = as_cap_version();
    parts[2] = "&MP=";
    parts[3] = "AS-AOT";
    parts[4] = "&p=";
    parts[5] = as_cap_os();
    parts[6] = "&l=";
    parts[7] = as_cap_language();
    parts[8] = "&r=";
    parts[9] = nbuf;
    parts[10] = "";
    cached = as_str_concat_n(11, parts);
    return cached;
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
            // A LOCAL vec4 named 'od' on ALL three targets, not the target's depth
            // builtin: the write-mask expander emits per-component stores
            // ('X.x = ...' for a mask like 0x1) as well as whole-register stores
            // ('X = ft0' for 0xF), and every depth builtin (gl_FragDepth(EXT),
            // SV_Depth, Metal's [[depth(any)]]) is a SCALAR. Each entry point
            // therefore writes the builtin/depth slot from od.x on the way out.
            strcpy(out, "od"); break;
        case AGAL_IID: // instance id (AGAL3, vertex-only, read-only source)
            // Metal and D3D both expose it as an unsigned system value, broadcast
            // to a float4 so the shared swizzle/component paths keep working.
            // GLSL ES 1.00 has NO equivalent (gl_InstanceID is ES 3.00), so a GLSL
            // program that reads iid is REFUSED in as_agal_translate before this
            // is ever called -- never translated to an undeclared identifier.
            if (target == 1) strcpy(out, "gl_InstanceID");
            else strcpy(out, "float4(iid, iid, iid, iid)");
            break;
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
    // 3-component constructor, needed by nrm (see its arm below).
    const char* v3 = target == 1 ? "vec3" : "float3";
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
        // adl 51.4.1 MEASURED (temp/agalprobe/upload.txt): 'nrm ft1, ft0' is
        // rejected at upload with Error #3628, "The destination operand for the
        // nrm instruction must mask w (use .xyz or less)". nrm's result is three
        // components wide (see its arms below), so w is never a legal destination
        // component -- refusing says so instead of emitting a 4-component
        // normalize that AIR would never have run.
        if (op == 0x0e && (dmask & 0x8)) {
            as_agal_errmsg = "AGAL: nrm must not write w (adl rejects the program with Error #3628: mask the destination .xyz or less)";
            break;
        }
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
                // nrm normalizes the source's xyz ONLY. adl 51.4.1 MEASURED
                // (temp/agalprobe/out.txt): nrm of (3,4,0,7) reads back 0.6/0.8 in
                // rgb, i.e. the divisor is |xyz| = 5, not |xyzw| = 8.60. The
                // result is 3 components wide, so it is re-widened with a zero w
                // before the component is picked -- and because the swizzle lives
                // in the operand fetch, the component index is the DESTINATION one
                // (ch), not the source swizzle's (a masked nrm of '.zyx' still
                // writes dst.x from the value's x).
                else if (op == 0x0e) {
                    if (strcmp(sw1, "xyzw") == 0)
                        sprintf(rhs, "%s(normalize(%s.xyz), 0.0).%c", v4, s1b, ch);
                    else
                        sprintf(rhs, "%s(normalize(%s(%s.%c, %s.%c, %s.%c)), 0.0).%c",
                                v4, v3, s1b, sw1[0], s1b, sw1[1], s1b, sw1[2], ch);
                }
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
        // 0x0e (nrm) has no full-mask arm on purpose: a mask that includes w is
        // refused further up (#3628), so a 0xF destination never reaches here.
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

// A temporary register (vt/ft) that is READ BEFORE IT IS WRITTEN has no defined
// value. adl 51.4.1 MEASURED (temp/agalprobe/upload.txt, bytes2.txt -- the latter
// uses Adobe's own AGALMiniAssembler, so the answer is not an artefact of our hand
// encoding): such a program is REFUSED at upload, with Error #3647 ("Temporary
// register read without being written to for source operand N") for a whole
// register and Error #3648 ("... component read ...") when only some components
// were ever written. d3d and GLSLES behave the same way at compile time. Reading
// zero is NOT the AIR semantic; translating the program would leave an
// uninitialised local in the MSL/GLSL/HLSL we emit, i.e. undefined behaviour that
// shows up as garbage pixels.
//
// The scan is LINEAR and per component, exactly like adl's validator: a write that
// only happens inside an ife/els block does not count for a later read, which is
// why this is a validator rather than a dataflow analysis. Masked writes only mark
// the components they actually write, so 'mov ft0.xy, v0' followed by 'mov oc, ft0'
// is refused too (#3648).
//
// What one instruction reads is derived from the same operand-count table the
// decoder uses, so no second copy of the opcode shape can drift. The sampler token
// of tex/tld occupies the second source slot and is not a register read; ife/ine/
// ifg/ifl/kil have no destination, so their operand count is taken as-is.
static const char* agal_check_temp_writes(const agal_instr* ins, int n) {
    static char msg[128];
    unsigned wrote[32];   // one 4-bit component mask per register index
    memset(wrote, 0, sizeof(wrote));
    for (int k = 0; k < n; k++) {
        const agal_instr* I = &ins[k];
        int op = (int)I->op;
        int nreg = agal_op_nreg[op];
        int hasDst = (nreg >= 1) && !agal_op_nodest[op];
        int nsrc = hasDst ? nreg - 1 : nreg;
        for (int j = 0; j < nsrc && j < 2; j++) {
            unsigned lo = j == 0 ? I->s1lo : I->s2lo;
            unsigned hi = j == 0 ? I->s1hi : I->s2hi;
            if (lo == 0 && hi == 0) continue;
            if (j == 1 && (op == 0x28 || op == 0x2e)) continue;  // sampler, not a register
            if ((int)(hi & 0xFF) != AGAL_VT) continue;
            int num = (int)(lo & 0xFFFF);
            if (num < 0 || num > 31) continue;
            unsigned swz = (lo >> 24) & 0xFFu;
            unsigned need = 0;
            for (int c = 0; c < 4; c++) need |= 1u << ((swz >> (2 * c)) & 3u);
            if ((wrote[num] & need) == need) continue;
            snprintf(msg, sizeof(msg),
                     "AGAL: %s%d is read before it is written (adl rejects the program with Error #3647/#3648)",
                     agal_is_frag ? "ft" : "vt", num);
            return msg;
        }
        if (hasDst) {
            int t = (int)((I->dst >> 24) & 0xFF);
            int num = (int)(I->dst & 0xFFFF);
            if (t == AGAL_VT && num >= 0 && num <= 31) wrote[num] |= (unsigned)((I->dst >> 16) & 0xFu);
        }
    }
    return NULL;
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
    {   // Read-before-write on a temporary register is an upload error on adl, not
        // a zero read -- see agal_check_temp_writes.
        const char* werr = agal_check_temp_writes(ins, n);
        if (werr != NULL) { as_agal_errmsg = werr; return NULL; }
    }
    // Two refusals that used to be shader-compile errors with no explanation:
    //   * 'iid' is a VERTEX-only source in AGAL3 (AGAL.min reference: iid is
    //     readable only in the vertex program); a fragment program reading it has
    //     no stage that can supply it.
    //   * the GLSL target compiles as ES 1.00 (attribute/varying/texture2D), which
    //     has no gl_InstanceID at all. Refusing says so; emitting it would only move
    //     the failure into the driver's shader log.
    if (isFragment && agal_is_used(AGAL_IID, 0)) {
        as_agal_errmsg = "AGAL: iid is readable only in a vertex program";
        return NULL;
    }
    if (target == 1 && agal_is_used(AGAL_IID, 0)) {
        as_agal_errmsg = "AGAL: iid is not available on the GLSL target (ES 1.00 has no gl_InstanceID)";
        return NULL;
    }
    as_json_buf b; as_json_buf_init(&b);
    if (target == 0) {
        // ---- MSL ----
        as_json_buf_append_cstr(&b, "#include <metal_stdlib>\\nusing namespace metal;\\n\\n");
        if (!isFragment) {
            // MSL rejects neither an empty struct nor an unused [[stage_in]] the
            // way HLSL/fxc does, but the empty struct is still dead weight and the
            // [[attribute(N)]] list is what the pipeline's vertex descriptor must
            // match, so both structs are built from real use on all three targets.
            int hasVA = 0; for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_VA, i)) { hasVA = 1; break; }
            if (hasVA) {
                as_json_buf_append_cstr(&b, "struct VSIn {\\n");
                for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_VA, i)) { char t[64]; sprintf(t, "  float4 a%d [[attribute(%d)]];\\n", i, i); as_json_buf_append_cstr(&b, t); }
                as_json_buf_append_cstr(&b, "};\\n");
            }
            as_json_buf_append_cstr(&b, "struct VSOut {\\n  float4 position [[position]];\\n");
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_V, i)) { char t[64]; sprintf(t, "  float4 varying%d [[user(locn%d)]];\\n", i, i); as_json_buf_append_cstr(&b, t); }
            as_json_buf_append_cstr(&b, "};\\n\\nvertex VSOut vs_main(\\n");
            // AGAL3's 'iid' is Metal's [[instance_id]] (a uint system value, like
            // HLSL's SV_InstanceID). It used to be translated to the never-declared
            // register name 'r0', so ANY program reading it failed to compile.
            int needComma = 0;
            if (hasVA) { as_json_buf_append_cstr(&b, "  VSIn in [[stage_in]]"); needComma = 1; }
            if (agal_is_used(AGAL_IID, 0)) {
                as_json_buf_append_cstr(&b, needComma ? ",\\n  uint iid [[instance_id]]" : "  uint iid [[instance_id]]");
                needComma = 1;
            }
            as_json_buf_append_cstr(&b, needComma ? ",\\n  constant float4* vc [[buffer(0)]]" : "  constant float4* vc [[buffer(0)]]");
            as_json_buf_append_cstr(&b, "\\n) {\\n  VSOut out;\\n  float4 op;\\n");
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_VT, i)) { char t[32]; sprintf(t, "  float4 vt%d;\\n", i); as_json_buf_append_cstr(&b, t); }
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_V, i)) { char t[32]; sprintf(t, "  float4 v%d;\\n", i); as_json_buf_append_cstr(&b, t); }
        } else {
            // Same rule as the vertex stage: the [[stage_in]] struct exists only
            // when the program really reads a varying, and the parameter list
            // follows. A fragment program with no inputs must not declare one.
            int hasV = 0; for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_V, i)) { hasV = 1; break; }
            if (hasV) {
                as_json_buf_append_cstr(&b, "struct FSIn {\\n");
                for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_V, i)) { char t[64]; sprintf(t, "  float4 v%d [[user(locn%d)]];\\n", i, i); as_json_buf_append_cstr(&b, t); }
                as_json_buf_append_cstr(&b, "};\\n");
            }
            // 'od' (fragment depth output) needs somewhere to GO. Metal expresses
            // it as a '[[depth(any)]]' member of the FRAGMENT OUTPUT STRUCT --
            // there is no gl_FragDepth-style builtin. The old MSL arm declared
            // neither the member nor the local, so 'mov od, ft0' emitted a write to
            // an undeclared identifier: a shader that cannot compile at all.
            int hasOd = agal_is_used(AGAL_OD, 0);
            if (hasOd) as_json_buf_append_cstr(&b, "struct FSOut {\\n  float4 color0 [[color(0)]];\\n  float depth [[depth(any)]];\\n};\\n");
            as_json_buf_append_cstr(&b, hasOd ? "fragment FSOut fs_main(\\n" : "fragment float4 fs_main(\\n");
            int needComma = 0;
            if (hasV) { as_json_buf_append_cstr(&b, "  FSIn in [[stage_in]]"); needComma = 1; }
            as_json_buf_append_cstr(&b, needComma ? ",\\n  constant float4* fc [[buffer(0)]]" : "  constant float4* fc [[buffer(0)]]");
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
            // 'od' is four components, not a bare float: the write-mask expander
            // emits per-component stores ('od.x = ...') and takes the full-mask
            // path ('od = ft0') for mask 0xF, and AGALMiniAssembler writes 0xF for
            // 'mov od, ft0'. A scalar local made both spellings illegal C.
            if (hasOd) as_json_buf_append_cstr(&b, "  float4 od;\\n");
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_VT, i)) { char t[32]; sprintf(t, "  float4 ft%d;\\n", i); as_json_buf_append_cstr(&b, t); }
        }
        agal_emit_body(&b, ins, n, target);
        if (as_agal_errmsg != NULL) { free(b.buf); return NULL; }
        if (!isFragment) {
            as_json_buf_append_cstr(&b, "  out.position = op;\\n");
            for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_V, i)) { char t[48]; sprintf(t, "  out.varying%d = v%d;\\n", i, i); as_json_buf_append_cstr(&b, t); }
            as_json_buf_append_cstr(&b, "  return out;\\n");
        } else if (agal_is_used(AGAL_OD, 0)) {
            // Metal reads depth from component 0 of the float4 the program left in
            // 'od'; a 'mov od, ft0.z' therefore lands in od.x through the source
            // swizzle, exactly like the HLSL arm's 'output.depth = od.x;'.
            as_json_buf_append_cstr(&b, "  FSOut fso;\\n  fso.color0 = oc;\\n  fso.depth = od.x;\\n  return fso;\\n");
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
        // Same four-component local as the other two targets (see the AGAL_OD arm
        // in agal_reg_name): the depth builtin itself is a scalar.
        if (isFragment && agal_is_used(AGAL_OD, 0)) as_json_buf_append_cstr(&b, "  vec4 od;\\n");
        for (int i = 0; i < 256; i++) if (agal_is_used(AGAL_VT, i)) { char t[32]; sprintf(t, "  vec4 %s%d;\\n", isFragment ? "ft" : "vt", i); as_json_buf_append_cstr(&b, t); }
        agal_emit_body(&b, ins, n, target);
        if (as_agal_errmsg != NULL) { free(b.buf); return NULL; }
        // The extension builtin is gl_FragDepthEXT, NOT gl_FragDepth: the source is
        // ES 1.00 (attribute/varying/texture2D), where gl_FragDepth does not exist --
        // only GL_EXT_frag_depth's gl_FragDepthEXT does. Writing the ES 3.00 name
        // into an ES 1.00 shader is a compile error in every WebGL implementation.
        if (isFragment && agal_is_used(AGAL_OD, 0))
            as_json_buf_append_cstr(&b, "  gl_FragDepthEXT = od.x;\\n");
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
            if (agal_is_used(AGAL_OD, 0)) as_json_buf_append_cstr(&b, "  float4 od;\\n");
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
            if (agal_is_used(AGAL_OD, 0)) as_json_buf_append_cstr(&b, "  output.depth = od.x;\\n");
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
// Largest 2D texture edge the linked backend can allocate. Read by the generated C
// both to report Context3D.profile and to enforce the #3683 ceiling, so the claim and
// the limit are always derived from the same number.
extern int s3d_max_texture_size(void);
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
// Largest 2D texture edge available to this build. A build without a GPU backend
// keeps textures in the CPU-side state machine, where a 4096 edge costs nothing, so
// it answers 4096 too -- but a real backend is always asked, never assumed: a WebGL2
// driver capped at 2048 must make the generated C report "baseline" rather than
// promise a texture it cannot allocate.
static inline int as_s3d_max_texture_size(void) {
#ifdef ASC_RENDER_STAGE3D
    return s3d_max_texture_size();
#else
    return 4096;
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
// ((utf8 byte length << 1) | 1). Every NON-EMPTY literal joins the string table,
// which is why a repeated member name comes back as a reference (measured).
//
// The EMPTY string is the one exception: AIR writes 06 01 every single time and
// never gives it a slot. Measured on adl (temp/solread/adl-login-2617.sol): the
// four empty values in userInfo (realname/email/wechat_openid/mini_program_openid)
// are all literals, while our writer entered "" on the first one and referenced it
// afterwards -- and adl then resolved that reference to a DIFFERENT string, so
// "email":"" came back as "mobile", the company objects lost their "title"/
// "app_menu" keys, and HomeView.getTextBtn threw #2007 on a null title.
static void as_amf3_wstr_body(as_amf3w* w, char* s) {
    size_t n = strlen(s);
    if (n == 0) { as_amfb_u29(&w->out, 1u); return; }
    int idx = as_amf3w_stridx(w, s);
    if (idx >= 0) { as_amfb_u29(&w->out, (unsigned)idx << 1); return; }
    as_amf3w_addstr(w, s);
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
// The empty string that terminates an object's dynamic member list is a raw
// literal that does NOT join the string table either. Measured on adl (阶段一百五十,
// temp/solprobeC): for {o:{x:1}, s1:"same", s2:"same"} the second "same" is the
// reference 0x06 (index 3), so only "o1", "x" and "s1" took slots -- the class name
// AND the terminator took none. Interning the terminator pushed every later index
// up by one, and adl then read a repeated value out of our ".sol" as the wrong
// string ("same" came back as "dup2").
static void as_amf3_wstr_endmark(as_amf3w* w) {
    as_amfb_u29(&w->out, 1);
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
        as_amf3_wstr_endmark(w);
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
    // The empty string never joins the table, mirroring the writer and AIR: a
    // literal 06 01 takes no slot, so interning it here would shift every later
    // reference (measured while reading adl-login-2617.sol, which carries seven
    // empty literals).
    if (n > 0) as_amfr_addstr(r, s);
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
// The dynamic-member terminator of an object: an empty string that never entered
// the string table (see as_amf3_wstr_endmark). A NON-empty key, however, does
// join the table exactly like as_amfr_str_body's strings -- AIR interns every
// dynamic property name, and treating them as table-free desynchronised the
// reader on any AIR-written object with dynamic fields (measured on the TalkMED
// store: the value of "email" is the reference 14, which resolved to "" only
// once accessToken..realname had taken slots 1..13). Only the empty terminator
// is skipped, so a reference to "" (interned from some earlier string VALUE)
// still resolves.
static char* as_amfr_str_endmark(as_amf3r* r) {
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
    if (n > 0) as_amfr_addstr(r, s);
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
            char* key = as_amfr_str_endmark(r);
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

// ---------- flash.data engine ABI (SQLite) ----------
// The AS3 flash.data layer (SQLConnection/SQLStatement/SQLResult) is emitted for
// every build, but the ENGINE behind these entry points only exists when the
// program actually references flash.data: then the compiler adds
// -DASC_HAVE_SQLITE plus vendor/sqlite_glue.c and the SQLite amalgamation to the
// link. Without that flag the stubs below keep the build self-contained -- and
// since the AS3 side reports them, every open() fails LOUDLY rather than silently
// pretending to work (AGENTS.md 1.5: never degrade silently).
//
// Plain (unencrypted) AIR databases ARE standard SQLite files -- measured: the
// file adl 51.4.1's SQLConnection.open(..., SQLMode.CREATE) writes has the
// "SQLite format 3\0" header and host sqlite3 reads it back (docs/zh-cn/flash-data.md
// section 3.4). So "link the official amalgamation" is the exact-semantics choice,
// not an approximation.
// Open-flag bits for as_sql_open. The glue uses the same values (separate TU).
#define AS_SQL_F_CREATE 1
#define AS_SQL_F_READONLY 2
#define AS_SQL_F_READWRITE 4

#ifdef ASC_HAVE_SQLITE
// The engine is actually linked: these resolve to vendor/sqlite_glue.c.
extern void* as_sql_open(const char* path, int flags, int pageSize, int autoVacuum, int* rc, char** msg);
extern void  as_sql_close(void* h);
extern int   as_sql_exec(void* h, const char* sql, char** msg);
extern void* as_sql_prepare(void* h, const char* sql, int* rc, char** msg);
extern int   as_sql_bind_null(void* st, int idx);
extern int   as_sql_bind_int(void* st, int idx, long long v);
extern int   as_sql_bind_double(void* st, int idx, double v);
extern int   as_sql_bind_text(void* st, int idx, const char* v);
extern int   as_sql_bind_blob(void* st, int idx, const void* v, int n);
extern int   as_sql_bind_parameter_index(void* st, const char* name);
extern int   as_sql_bind_parameter_count(void* st);
extern const char* as_sql_bind_parameter_name(void* st, int i);
extern int   as_sql_step(void* st);
extern void  as_sql_reset(void* st);
extern void  as_sql_finalize(void* st);
extern int   as_sql_column_count(void* st);
extern const char* as_sql_column_name(void* st, int i);
extern const char* as_sql_column_table_name(void* st, int i);
extern int   as_sql_column_type(void* st, int i);
extern long long as_sql_column_int64(void* st, int i);
extern double as_sql_column_double(void* st, int i);
extern const char* as_sql_column_text(void* st, int i);
extern const void* as_sql_column_blob(void* st, int i);
extern int   as_sql_column_bytes(void* st, int i);
extern long long as_sql_changes(void* h);
extern long long as_sql_total_changes(void* h);
extern long long as_sql_last_insert_rowid(void* h);
extern int   as_sql_errcode(void* h);
extern int   as_sql_extended_errcode(void* h);
extern const char* as_sql_errmsg(void* h);
extern int   as_sql_get_autocommit(void* h);
extern int   as_sql_txn_state(void* h);
extern void  as_sql_interrupt(void* h);
extern void  as_sql_watch_changes(void* h);
extern void  as_sql_reset_updates(void* h);
extern int   as_sql_update_count(void* h);
extern int   as_sql_update_op(void* h, int i);
extern long long as_sql_update_rowid(void* h, int i);
extern const char* as_sql_update_table(void* h, int i);
extern long long as_sql_get_page_size(void* h);
extern long long as_sql_get_cache_size(void* h);
extern long long as_sql_get_auto_vacuum(void* h);
extern int   as_sql_set_cache_size(void* h, long long pages);
extern int   as_sql_is_database_file(const char* path);
extern int   as_sql_file_exists(const char* path);
extern const char* as_sql_libversion(void);
#else
// No database engine in this build (the program never referenced flash.data, so
// src/index.ts did not add the amalgamation). open() returns NULL with a message
// that the AS3 layer turns into a thrown SQLError, so the failure is LOUD and
// names its cause -- never a silently faked database (AGENTS.md 1.5).
static inline void* as_sql_open(const char* p, int f, int ps, int av, int* rc, char** msg) { (void)p; (void)f; (void)ps; (void)av; if (rc) *rc = 1; if (msg) *msg = (char*)"the SQLite backend was not linked into this build (reference flash.data so the compiler adds it)"; return NULL; }
static inline void  as_sql_close(void* h) { (void)h; }
static inline int   as_sql_exec(void* h, const char* q, char** msg) { (void)h; (void)q; if (msg) *msg = (char*)"no SQLite backend"; return 1; }
static inline void* as_sql_prepare(void* h, const char* q, int* rc, char** msg) { (void)h; (void)q; if (rc) *rc = 1; if (msg) *msg = (char*)"no SQLite backend"; return NULL; }
static inline int   as_sql_bind_null(void* st, int i) { (void)st; (void)i; return 0; }
static inline int   as_sql_bind_int(void* st, int i, long long v) { (void)st; (void)i; (void)v; return 0; }
static inline int   as_sql_bind_double(void* st, int i, double v) { (void)st; (void)i; (void)v; return 0; }
static inline int   as_sql_bind_text(void* st, int i, const char* v) { (void)st; (void)i; (void)v; return 0; }
static inline int   as_sql_bind_blob(void* st, int i, const void* v, int n) { (void)st; (void)i; (void)v; (void)n; return 0; }
static inline int   as_sql_bind_parameter_index(void* st, const char* n) { (void)st; (void)n; return 0; }
static inline int   as_sql_bind_parameter_count(void* st) { (void)st; return 0; }
static inline const char* as_sql_bind_parameter_name(void* st, int i) { (void)st; (void)i; return NULL; }
static inline int   as_sql_step(void* st) { (void)st; return 101; }
static inline void  as_sql_reset(void* st) { (void)st; }
static inline void  as_sql_finalize(void* st) { (void)st; }
static inline int   as_sql_column_count(void* st) { (void)st; return 0; }
static inline const char* as_sql_column_name(void* st, int i) { (void)st; (void)i; return ""; }
static inline const char* as_sql_column_table_name(void* st, int i) { (void)st; (void)i; return ""; }
static inline int   as_sql_column_type(void* st, int i) { (void)st; (void)i; return 5; }
static inline long long as_sql_column_int64(void* st, int i) { (void)st; (void)i; return 0; }
static inline double as_sql_column_double(void* st, int i) { (void)st; (void)i; return 0.0; }
static inline const char* as_sql_column_text(void* st, int i) { (void)st; (void)i; return ""; }
static inline const void* as_sql_column_blob(void* st, int i) { (void)st; (void)i; return NULL; }
static inline int   as_sql_column_bytes(void* st, int i) { (void)st; (void)i; return 0; }
static inline long long as_sql_changes(void* h) { (void)h; return 0; }
static inline long long as_sql_total_changes(void* h) { (void)h; return 0; }
static inline long long as_sql_last_insert_rowid(void* h) { (void)h; return 0; }
static inline int   as_sql_errcode(void* h) { (void)h; return 0; }
static inline int   as_sql_extended_errcode(void* h) { (void)h; return 0; }
static inline const char* as_sql_errmsg(void* h) { (void)h; return "no SQLite backend"; }
static inline int   as_sql_get_autocommit(void* h) { (void)h; return 1; }
static inline int   as_sql_txn_state(void* h) { (void)h; return 0; }
static inline void  as_sql_interrupt(void* h) { (void)h; }
static inline void  as_sql_watch_changes(void* h) { (void)h; }
static inline void  as_sql_reset_updates(void* h) { (void)h; }
static inline int   as_sql_update_count(void* h) { (void)h; return 0; }
static inline int   as_sql_update_op(void* h, int i) { (void)h; (void)i; return 0; }
static inline long long as_sql_update_rowid(void* h, int i) { (void)h; (void)i; return 0; }
static inline const char* as_sql_update_table(void* h, int i) { (void)h; (void)i; return NULL; }
static inline long long as_sql_get_page_size(void* h) { (void)h; return 0; }
static inline long long as_sql_get_cache_size(void* h) { (void)h; return 0; }
static inline long long as_sql_get_auto_vacuum(void* h) { (void)h; return 0; }
static inline int   as_sql_set_cache_size(void* h, long long p) { (void)h; (void)p; return 0; }
static inline int   as_sql_is_database_file(const char* p) { (void)p; return 0; }
static inline int   as_sql_file_exists(const char* p) { (void)p; return 0; }
static inline const char* as_sql_libversion(void) { return "none"; }
#endif
`;
