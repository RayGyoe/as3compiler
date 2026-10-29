// FRE host: the executable half of the AIR native-extension bridge.
//
// AIR implements the FRE entry points inside the AIR runtime; an ANE's native
// library static-imports them from `Adobe AIR.dll`. This build has no AIR, so it
// provides its own: `asaot.dll` exports all 51 FRE entry points as forwarders
// (see lib/asaot_host.c) and dispatches every call into the table built HERE,
// where the boxed-value representation, the GC heap and the class registry live.
// One heap, one registry -- an FREObject handed to the extension and an as_value
// handed back must be the same kind of thing or the two halves cannot talk.
//
// The emitted C is split by D face (see the feasibility report):
//
//   * B face -- FRE object model: FREObject <-> as_value, the per-call arena the
//     extension's handles live in, and the 51 entry points.
//   * C face -- extension loading: the descriptor table codegen fills in, the
//     platform loader, the Initializer/ContextInitializer protocol, and the
//     function-table dispatch ExtensionContext.call runs.
//
// WHAT IS DELIBERATELY NOT HERE (report section 4.4, "D face, deferred"):
// FREGetRenderMode / FRESetRenderSource / FREMediaBufferLock|Unlock /
// FREGetNativeContext3DHandle. Each answers FRE_ILLEGAL_STATE **and reports
// itself** through the same capped `[as3-aot] not implemented by this build: ...`
// channel every other gap uses. A silent FRE_OK or a fabricated descriptor is
// exactly what AGENTS.md section 1.5 forbids, and for a video ANE it is the
// difference between "the picture is black" and "the build told you it cannot
// present video".
//
// Three pieces are NOT in that list any more, and the reason is the same for all
// three: they hand out something this build already owns rather than something it
// would have to invent.
//
//   * FREAcquire|ReleaseNativeWindowHandle -- SDL creates the window and
//     window_glue answers its HWND / NSWindow*, so a HANDLE claims nothing.
//   * FREAcquireBitmapData / FREAcquireBitmapData2 / FREInvalidateBitmapDataRect /
//     FREReleaseBitmapData -- a BitmapData's pixel buffer is `pixels`, a plain
//     ARGB array this runtime allocates and already renders from. Handing out ITS
//     address is not a promise about a render pipeline; it is the address of the
//     thing the pipeline reads (see the BitmapData section below).
//
// The render pipeline PROPER stays deferred, because THAT is the part that would
// have to pretend: listing composited frames as a media buffer, or naming a GPU
// render mode this build's compositor is not in.
//
// Emission order in the generated translation unit (three independent `#ifdef
// ASC_HAVE_FRE` blocks, so that a build without FRE compiles the whole thing out
// and keeps using ExtensionContext's report-and-return-no-FRE path):
//
//   1. FRE_HEAD        -- include + the as_ane_desc type
//   2. descriptor block -- written by emit.ts, defines as_ane_descs[] and
//                          ASC_ANE_COUNT from the .ane files the build was given
//   3. FRE_BODY        -- the host + the loader, which reads as_ane_descs[]
//   4. hook bodies      -- written by emit.ts next to the classes they read
//                          (ByteArray's byte storage, StatusEvent dispatch)
//
// and every call site of the four functions below is guarded, so the non-FRE
// build links through FRE_STUBS.

/**
 * One native extension the build was handed, already resolved to the native
 * library this platform will load. Produced by ane.ts from the .ane package's
 * extension.xml and carried into the emitted `as_ane_descs[]` table.
 */
export interface AneDescriptor {
  /** The extensionID an application passes to createExtensionContext. */
  extId: string;
  /**
   * Path of the native library RELATIVE to the executable's `extensions` dir:
   * `<extensionID>/<platform>/<nativeLibrary>`. One directory per extension, so
   * two extensions may ship a library of the same file name without becoming one
   * file -- which is what AIR does too (it keeps each extension's library at that
   * extension's own path; measured under `adl`, see ane.ts).
   */
  nativeLib: string;
  /** Exported `<Name>ExtInitializer` symbol. */
  initializer: string;
  /** Exported `<Name>ExtFinalizer` symbol. */
  finalizer: string;
}

/**
 * How many native extensions one build can host.
 *
 * The generated program keeps one `as_ane_loaded` slot per extension, indexed by
 * the descriptor row, so this is the size of a static array (`as_anes` further
 * down FRE_BODY) and NOT a soft limit. It is exported so the compile-time side can
 * refuse an over-long `--ane` list instead of emitting a table that indexes past
 * the end of that array -- measured: 33 extensions used to compile, link and stage
 * with exit 0 and no warning, and only fail as an out-of-bounds write at the first
 * createExtensionContext for the 33rd (see ane.ts resolveAneDescriptors).
 */
export const ANE_COUNT_MAX = 32;

/**
 * Part 1: the include and the descriptor type.
 *
 * as_dyn_new_args is forward-declared because emit.ts emits it alongside the
 * class registry, later in the same translation unit -- and it is the exact
 * routine `new (ClassRef)(...)` uses, so FRENewObject can never disagree with
 * AS3 about a class's arity or about a non-constructor operand.
 */
export const FRE_HEAD = `
#ifdef ASC_HAVE_FRE

// Needs the platform's own dynamic loader (HMODULE/LoadLibraryA on Windows,
// dlopen on macOS) and the AIR-compatible FRE
// declarations; -I as3compiler/lib supplies it (see build.ts).
//
// ASAOT_HOST tells the header this translation unit DEFINES the 51 entry points
// (it is the host, rather than a recompiled ANE that imports them), which is what
// keeps them from being declared dllimport twice.
#define ASAOT_HOST 1
#include "asaot.h"

// Defined with the class registry, further down this file.
static as_value as_dyn_new_args(as_class* c, int argc, as_value* argv);

// Defined next to the NativeWindow class (emit.ts emitNativeWindow reads that
// struct). 1 = the value is a flash.display.NativeWindow instance or a subclass
// and the out pointer received its window slot; 0 = it is not one. The slot may
// be -1 for a window AS3 already closed -- the caller decides what that means,
// because only it knows which FREResult the question deserves.
static int as_native_window_id_of(as_value v, int* out);

// One entry per extension the application descriptor declares. Codegen builds
// the table from the .ane packages the build was given: extension.xml is parsed
// at COMPILE time (there is no XML parser in the runtime), exactly the way the
// AIR SDK's packaging tools do it.
typedef struct {
    const char* ext_id;
    const char* native_lib;    // path inside the extension's directory, see ANE_COUNT_MAX
    const char* initializer;
    const char* finalizer;
} as_ane_desc;

#define ASC_ANE_COUNT_MAX ${ANE_COUNT_MAX}

#endif // ASC_HAVE_FRE
`

/**
 * Part 3: the host and the loader.
 *
 * Assumes FRE_HEAD and the descriptor block were already emitted, so `as_ane_desc`,
 * `as_ane_descs[]` and `ASC_ANE_COUNT` are all in scope.
 */
export const FRE_BODY = `
#ifdef ASC_HAVE_FRE

// ---------- platform shim: the dynamic loader, the executable's own path, and
// the status queue's lock ----------
//
// Loading a native extension is the one thing this runtime does that is an
// OPERATING SYSTEM call rather than a library call: an extension is a file the
// program was TOLD about at compile time (as_ane_descs[]) and opens at run time.
// That is also where the two supported platforms genuinely differ, so the
// difference is spelled once here and every call site above and below it stays
// platform-free.
//
// The names are Windows-flavoured (as_fre_lib_open) rather than dlopen-flavoured
// because the Windows path is the one the FRE host was built and measured on
// first; macOS is the half added later. Both have to answer the same three
// questions: how to open a library, how to take a symbol from it, and how to
// describe a failure in terms a user can act on.
#if defined(_WIN32)
  // A bare name: "asaot.dll" is found beside the executable, which is the first
  // place the Win32 loader searches.
  typedef HMODULE as_fre_lib;
  static as_fre_lib as_fre_lib_open(const char* path) { return LoadLibraryA(path); }
  static void*     as_fre_lib_sym(as_fre_lib lib, const char* name) { return (void*)GetProcAddress(lib, name); }
  // Windows reports WHY as a NUMBER, and the number is the whole diagnosis: 193
  // (ERROR_BAD_EXE_FORMAT) means the file IS there but this process cannot load it
  // -- a 64-bit library beside a 32-bit program -- while 126
  // (ERROR_MOD_NOT_FOUND) is the genuinely-missing one. Both slices of an
  // extension carry the same file name, so a report without the code makes the two
  // indistinguishable.
  static const char* as_fre_lib_err(void) {
      static char as_fre_err_buf[96];
      snprintf(as_fre_err_buf, sizeof(as_fre_err_buf),
               "Win32 error %lu; 193 = wrong bitness, 126 = not found",
               (unsigned long)GetLastError());
      return as_fre_err_buf;
  }
  // The host library beside the executable, and the thing an extension LINKS
  // against. They are different files on Windows -- an import library is what a
  // link line names, and the DLL is what loads -- and the same file on macOS, where
  // a dylib is both.
  #define AS_FRE_LIB_NAME  "asaot.dll"
  #define AS_FRE_LINK_NAME "asaot.lib"
#else
  // RTLD_NOW rather than RTLD_LAZY, so an extension whose FRE imports were never
  // resolved fails HERE, with the loader's own sentence, instead of aborting the
  // program at the first FRE call.
  //
  // RTLD_LOCAL, not RTLD_GLOBAL: an extension links this library explicitly (that
  // is what "recompiled for AOT" means on this platform -- the macOS counterpart of
  // the Windows import-library swap), so its symbols resolve through that
  // dependency and there is no reason to publish the whole 53-entry table into the
  // global namespace of the process.
  #include <dlfcn.h>
  #include <errno.h>
  #include <time.h>
  #include <unistd.h>
  #if defined(__APPLE__)
    #include <mach-o/dyld.h>
  #endif
  typedef void* as_fre_lib;
  static as_fre_lib as_fre_lib_open(const char* path) { return dlopen(path, RTLD_NOW | RTLD_LOCAL); }
  static void*     as_fre_lib_sym(as_fre_lib lib, const char* name) { return dlsym(lib, name); }
  // dlerror() gives a SENTENCE rather than a code, so this slot carries whatever
  // the loader said. A NULL return means "nothing to report", which can only be read
  // right after a failed call.
  static const char* as_fre_lib_err(void) {
      const char* e = dlerror();
      return e != NULL ? e : "no loader diagnostic";
  }
  #define AS_FRE_LIB_NAME  "libasaot.dylib"
  #define AS_FRE_LINK_NAME "libasaot.dylib"
#endif

// One lock for every context's status queue. On Windows a CRITICAL_SECTION, which
// is recursive by construction; on macOS a pthread mutex made recursive
// explicitly, because FREDispatchStatusEventAsync can be reached from a thread
// that is itself inside as_fre_pump and a default mutex would deadlock there.
//
// Mutex initialization cannot be spelled statically in C on either platform, hence
// the init-on-first-use flag.
static int as_fre_qcs_ready = 0;
#if defined(_WIN32)
  static CRITICAL_SECTION as_fre_qcs;
  static void as_fre_qcs_init(void) {
      if (!as_fre_qcs_ready) { InitializeCriticalSection(&as_fre_qcs); as_fre_qcs_ready = 1; }
  }
  #define AS_FRE_Q_LOCK()   EnterCriticalSection(&as_fre_qcs)
  #define AS_FRE_Q_UNLOCK() LeaveCriticalSection(&as_fre_qcs)
#else
  static pthread_mutex_t as_fre_qcs;
  static void as_fre_qcs_init(void) {
      if (as_fre_qcs_ready) return;
      pthread_mutexattr_t a;
      if (pthread_mutexattr_init(&a) != 0) return;
      pthread_mutexattr_settype(&a, PTHREAD_MUTEX_RECURSIVE);
      if (pthread_mutex_init(&as_fre_qcs, &a) != 0) { pthread_mutexattr_destroy(&a); return; }
      pthread_mutexattr_destroy(&a);
      as_fre_qcs_ready = 1;
  }
  #define AS_FRE_Q_LOCK()   pthread_mutex_lock(&as_fre_qcs)
  #define AS_FRE_Q_UNLOCK() pthread_mutex_unlock(&as_fre_qcs)
#endif

// The directory the running executable lives in -- AIR's "application directory",
// and the root every extension path is resolved against (as_ext_dir below).
//
// Windows needs no helper: as_ext_dir() reads GetModuleFileNameA directly and the
// host library is opened by its bare name. POSIX has neither, so the path is
// obtained here once and every caller derives from it. The macOS and Linux
// sources of "where am I" differ; anything else is a loud compile error rather
// than a silent empty path (AGENTS.md 1.5).
#if !defined(_WIN32)
static int as_fre_exe_dir(char* out, size_t n) {
    char path[2048];
    path[0] = 0;
  #if defined(__APPLE__)
    uint32_t sz = (uint32_t)sizeof(path);
    if (_NSGetExecutablePath(path, &sz) != 0) return 0;
  #elif defined(__linux__)
    ssize_t got = readlink("/proc/self/exe", path, sizeof(path) - 1);
    if (got <= 0) return 0;
    path[got] = 0;
  #else
    #error "as_fre_exe_dir: no source of the running executable's path for this platform"
  #endif
    char* slash = strrchr(path, '/');
    if (slash == NULL) return 0;
    *slash = 0;
    if (strlen(path) + 1 > n) return 0;
    strcpy(out, path);
    return 1;
}
#endif

// ---------- per-call FRE object arena ----------
//
// An FREObject is an opaque handle. Ours is a pointer to a BOXED as_value, which
// is what makes the two halves agree for free: the extension stores and returns
// handles, we read and return boxed values, and nothing has to be converted
// across the boundary.
//
// Lifetime is per CALL, matching AIR's own contract (parameters are valid for the
// duration of the call; the runtime releases what FRENewObjectFrom* created).
// as_ext_call opens a scope, every entry point allocates its handles from it, and
// it is released when the call returns -- so an extension that correctly does not
// cache handles never sees a dangling one.
//
// The blocks are malloc'd/freed rather than taken from the arena allocator: the
// arena is program-lifetime (AGENTS.md section 2.4) and a per-call scratch area
// is precisely not that. One malloc per extension call, never per frame.
typedef struct as_fre_block {
    struct as_fre_block* next;
    size_t used;
    size_t cap;
    char*  base;
} as_fre_block;

static as_fre_block* as_fre_arena = NULL;
// Boxed values created during the running call. Registered as GC roots (see
// as_fre_mark_roots) because the extension may hold a handle across several FRE
// calls inside one ExtensionContext.call, and the AS3 code it invokes
// (FRECallObjectMethod) can reach a collection point.
static as_value* as_fre_live = NULL;
static int       as_fre_live_len = 0;
static int       as_fre_live_cap = 0;

static void* as_fre_alloc(size_t n) {
    n = (n + 15u) & ~(size_t)15u;
    as_fre_block* b = as_fre_arena;
    if (b == NULL || b->used + n > b->cap) {
        size_t cap = n > 8192u ? n : 8192u;
        b = (as_fre_block*)malloc(sizeof(as_fre_block) + cap);
        if (b == NULL) return NULL;
        b->next = as_fre_arena;
        b->used = 0;
        b->cap = cap;
        b->base = (char*)(b + 1);
        as_fre_arena = b;
    }
    void* p = b->base + b->used;
    b->used += n;
    return p;
}

static void as_fre_scope_begin(void) { as_fre_live_len = 0; }

static void as_fre_scope_end(void) {
    as_fre_block* b = as_fre_arena;
    while (b != NULL) { as_fre_block* n = b->next; free(b); b = n; }
    as_fre_arena = NULL;
    as_fre_live_len = 0;
}

// Box one as_value into a fresh handle. NULL only on allocation failure, which
// every caller below reports as FRE_INSUFFICIENT_MEMORY.
static FREObject as_fre_box(as_value v) {
    as_value* slot = (as_value*)as_fre_alloc(sizeof(as_value));
    if (slot == NULL) return NULL;
    *slot = v;
    if (as_fre_live_len == as_fre_live_cap) {
        int cap = as_fre_live_cap == 0 ? 32 : as_fre_live_cap * 2;
        as_value* nt = (as_value*)realloc(as_fre_live, sizeof(as_value) * (size_t)cap);
        if (nt != NULL) { as_fre_live = nt; as_fre_live_cap = cap; }
    }
    if (as_fre_live_len < as_fre_live_cap) as_fre_live[as_fre_live_len++] = v;
    return (FREObject)slot;
}

static void as_fre_mark_roots(void) {
    for (int i = 0; i < as_fre_live_len; i++) gc_mark_value(as_fre_live[i]);
}

// An incoming handle back to its boxed value. A NULL FREObject is AS3 null --
// FRE_INVALID_OBJECT doubles as null, and extensions do return it (ANENDI's
// isDeBug returns NULL; ANEWebSocket's senders return NULL).
static as_value as_fre_unbox(FREObject o) {
    if (o == NULL) return as_v_null();
    return *(as_value*)o;
}

// ---------- hooks into generated class code ----------
//
// Two things the FRE entry points need are only knowable once the class that
// owns them has been emitted -- ByteArray's byte storage is a field of a struct
// codegen lays out, and a status event must be dispatched through the generated
// StatusEvent/EventDispatcher pair. The generated code installs these; until it
// does, the entry point that needs the hook reports the gap instead of guessing
// at a struct layout.
static void* (*as_fre_ba_data_hook)(void* ba, unsigned* len) = NULL;
static void* (*as_fre_ba_new_hook)(unsigned len) = NULL;
static void  (*as_fre_status_hook)(void* as3ctx, const char* code, const char* level) = NULL;
// BitmapData: whether a given as_value IS one is a vtable question, and where its
// pixel buffer lives is a struct-layout question -- both belong to the emitter, so
// the four BitmapData entry points reach the generated struct through these two.
// \`desc\` answers 0 = not a BitmapData, 1 = described, -1 = disposed (the pixels
// are gone, which AIR reports as FRE_INVALID_OBJECT and never as a type error).
static int  (*as_fre_bmd_desc_hook)(void* bd, FREBitmapData2* out) = NULL;
// The dirty half: whatever an extension wrote through \`bits32\`, it is visible to
// the renderer no sooner than the buffer's version moves (the Skia view of a
// BitmapData is cached against that version -- see as_bmd_live_image), so both
// RELEASE and INVALIDATE come through here.
static void (*as_fre_bmd_dirty_hook)(void* bd) = NULL;
static void as_fre_wire_classes(void);

// ---------- extension contexts ----------

typedef struct as_fre_status {
    struct as_fre_status* next;
    char* code;
    char* level;
} as_fre_status;

typedef struct as_fre_ctx {
    const as_ane_desc* desc;
    void*       as3ctx;            // the AS3 ExtensionContext instance (a GC ref)
    void*       nativeData;        // FREGet/SetContextNativeData slot
    int         disposed;
    uint32_t    nfuncs;
    const FRENamedFunction* funcs;
    // Status events queued by FREDispatchStatusEventAsync. AIR promises the
    // dispatch is asynchronous and thread-safe, so the queue is mutex-guarded and
    // drained by as_fre_pump at a frame boundary (or right after a call). The
    // strings are strdup'd: the queue must not hold a pointer into an AS3 string,
    // which the GC could reclaim out from under a worker thread.
    as_fre_status* status_head;
    as_fre_status* status_tail;
    struct as_fre_ctx* next;
} as_fre_ctx;

static as_fre_ctx* as_fre_ctxs = NULL;

static as_fre_ctx* as_fre_ctx_find(void* as3ctx) {
    for (as_fre_ctx* c = as_fre_ctxs; c != NULL; c = c->next) if (c->as3ctx == as3ctx) return c;
    return NULL;
}

static as_fre_ctx* as_fre_ctx_add(const as_ane_desc* desc, void* as3ctx) {
    as_fre_ctx* c = (as_fre_ctx*)calloc(1, sizeof(as_fre_ctx));
    if (c == NULL) return NULL;
    c->desc = desc;
    c->as3ctx = as3ctx;
    c->next = as_fre_ctxs;
    as_fre_ctxs = c;
    return c;
}

// Drain queued status events. Called at the end of every ExtensionContext.call
// and from Stage_dispatchFrame, which is what makes a worker thread's
// FREDispatchStatusEventAsync observable in a long-lived application.
static void as_fre_pump(void) {
    if (!as_fre_qcs_ready) return;
    for (as_fre_ctx* c = as_fre_ctxs; c != NULL; c = c->next) {
        AS_FRE_Q_LOCK();
        as_fre_status* s = c->status_head;
        c->status_head = NULL;
        c->status_tail = NULL;
        AS_FRE_Q_UNLOCK();
        while (s != NULL) {
            as_fre_status* n = s->next;
            if (as_fre_status_hook != NULL && c->as3ctx != NULL && !c->disposed)
                as_fre_status_hook(c->as3ctx, s->code, s->level);
            free(s->code);
            free(s->level);
            free(s);
            s = n;
        }
    }
}

// ---------- the FRE entry points ----------

// Classify a value the way FRE_TYPE_* does. A Class instance is told apart by the
// class registry's fqn -- the same identity the sealed-property errors and
// getQualifiedClassName use, so FRE and AS3 cannot disagree about what a value is.
static int as_fre_type_of(FREObject o) {
    as_value v = as_fre_unbox(o);
    switch (v.tag) {
        case 1: case 8: case 9: return FRE_TYPE_NUMBER;
        case 2: return FRE_TYPE_BOOLEAN;
        case 3: return FRE_TYPE_STRING;
        case 6: return FRE_TYPE_ARRAY;
        case 0: case 5: return FRE_TYPE_NULL;
        case 7: return FRE_TYPE_OBJECT;   // a Function is an object to FRE
    }
    if (v.ptr == NULL) return FRE_TYPE_NULL;
    // A monomorphized Vector.<T> is NOT an as_array: it is a GCT_CUSTOM block
    // whose body is mark/data/length/capacity (as_dyn_kind's code 3).
    int dk = as_dyn_kind(v.ptr);
    if (dk == 3) return FRE_TYPE_VECTOR;
    if (dk == 2) return FRE_TYPE_ARRAY;
    // An INSTANCE (ByteArray, BitmapData) is named by its vtable, which is the only
    // thing that survives a subclass: as_class_fqn_of_ptr deliberately answers
    // NULL for anything inside the GC heap (it exists to name a CLASS object, which
    // is a static), so using it here made every ByteArray look like a plain object
    // and every FREAcquireByteArray fail with FRE_TYPE_MISMATCH.
    const char* fqn = NULL;
    void* vt = ((as_object_header*)v.ptr)->vtable;
    if (vt != NULL) fqn = ((as_vtable_header*)vt)->fqn;
    if (fqn != NULL) {
        if (strcmp(fqn, "flash.utils::ByteArray") == 0) return FRE_TYPE_BYTEARRAY;
        if (strcmp(fqn, "flash.display::BitmapData") == 0) return FRE_TYPE_BITMAPDATA;
    }
    return FRE_TYPE_OBJECT;
}

static FREResult FREGetObjectType(FREObject object, FREObjectType *objectType) {
    if (objectType == NULL) return FRE_INVALID_ARGUMENT;
    *objectType = (FREObjectType)as_fre_type_of(object);
    return FRE_OK;
}

// FREGetObjectAs* accept the matching member type and reject everything else with
// FRE_TYPE_MISMATCH; unlike AS3's int(x) they run no conversion (an extension
// passing a String where a number belongs has a bug it needs to see).
static FREResult FREGetObjectAsInt32(FREObject object, int32_t *value) {
    if (value == NULL) return FRE_INVALID_ARGUMENT;
    as_value v = as_fre_unbox(object);
    if (v.tag == 2) { *value = v.num != 0.0 ? 1 : 0; return FRE_OK; }
    if (v.tag == 8) { *value = (int32_t)v.i64; return FRE_OK; }
    if (v.tag == 9) { *value = (int32_t)v.u64; return FRE_OK; }
    if (v.tag != 1) return FRE_TYPE_MISMATCH;
    *value = as_to_int32(v.num);
    return FRE_OK;
}

static FREResult FREGetObjectAsUint32(FREObject object, uint32_t *value) {
    if (value == NULL) return FRE_INVALID_ARGUMENT;
    as_value v = as_fre_unbox(object);
    if (v.tag == 2) { *value = v.num != 0.0 ? 1u : 0u; return FRE_OK; }
    if (v.tag == 8) { *value = (uint32_t)v.i64; return FRE_OK; }
    if (v.tag == 9) { *value = (uint32_t)v.u64; return FRE_OK; }
    if (v.tag != 1) return FRE_TYPE_MISMATCH;
    *value = as_to_uint32(v.num);
    return FRE_OK;
}

static FREResult FREGetObjectAsDouble(FREObject object, double *value) {
    if (value == NULL) return FRE_INVALID_ARGUMENT;
    as_value v = as_fre_unbox(object);
    if (v.tag == 2) { *value = v.num; return FRE_OK; }
    if (v.tag == 8) { *value = (double)v.i64; return FRE_OK; }
    if (v.tag == 9) { *value = (double)v.u64; return FRE_OK; }
    if (v.tag != 1) return FRE_TYPE_MISMATCH;
    *value = v.num;
    return FRE_OK;
}

// FREGetObjectAsBool is the one reader that DOES apply AS3 truthiness: AIR
// documents it as "the Boolean value", and an extension's enabled-flag is
// routinely a Number from older code. as_v_truthy is that exact rule, so a typed
// and a boxed Boolean answer identically (including "" being false).
static FREResult FREGetObjectAsBool(FREObject object, uint32_t *value) {
    if (value == NULL) return FRE_INVALID_ARGUMENT;
    *value = as_v_truthy(as_fre_unbox(object)) ? 1u : 0u;
    return FRE_OK;
}

static FREResult FRENewObjectFromInt32(int32_t value, FREObject *object) {
    if (object == NULL) return FRE_INVALID_ARGUMENT;
    FREObject o = as_fre_box(as_v_num((double)value));
    if (o == NULL) return FRE_INSUFFICIENT_MEMORY;
    *object = o;
    return FRE_OK;
}

static FREResult FRENewObjectFromUint32(uint32_t value, FREObject *object) {
    if (object == NULL) return FRE_INVALID_ARGUMENT;
    FREObject o = as_fre_box(as_v_num((double)value));
    if (o == NULL) return FRE_INSUFFICIENT_MEMORY;
    *object = o;
    return FRE_OK;
}

static FREResult FRENewObjectFromDouble(double value, FREObject *object) {
    if (object == NULL) return FRE_INVALID_ARGUMENT;
    FREObject o = as_fre_box(as_v_num(value));
    if (o == NULL) return FRE_INSUFFICIENT_MEMORY;
    *object = o;
    return FRE_OK;
}

static FREResult FRENewObjectFromBool(uint32_t value, FREObject *object) {
    if (object == NULL) return FRE_INVALID_ARGUMENT;
    FREObject o = as_fre_box(as_v_bool(value != 0));
    if (o == NULL) return FRE_INSUFFICIENT_MEMORY;
    *object = o;
    return FRE_OK;
}

static FREResult FREGetObjectAsUTF8(FREObject object, uint32_t* length, const uint8_t** value) {
    if (length == NULL || value == NULL) return FRE_INVALID_ARGUMENT;
    as_value v = as_fre_unbox(object);
    if (v.tag != 3 || v.ptr == NULL) return FRE_TYPE_MISMATCH;
    const char* s = (const char*)v.ptr;
    // The AIR SDK header DOCUMENTS this length as "the size, in bytes, of the
    // string. Includes the null terminator", and the ANEUtils idiom is
    // std::string(val, val + length) -- but the two disagree, and adl is the
    // oracle: AIR reports the length WITHOUT the terminator. Measured on adl
    // 51.4.1 + ANEWebSocket (ext-aot A/B on one machine, one URL, one token):
    // adl hands over "...appversion=1.9.36" (strlen bytes), while strlen+1
    // appended a NUL that websocketpp baked straight into the wire request line
    // ("GET /node1?...1.9.36\0 HTTP/1.1"), so every wss connect died with
    // status_code 0 + websocketpp.transport:7 (EOF) before any TLS/WS upgrade.
    // Extensions that memcpy(%s) never noticed; ones that carry an explicit
    // length -- a std::string, a protocol frame, a hash -- did.
    // AIR's buffer stays NUL-terminated either way, so a caller that reads
    // one byte past the reported length still sees the same terminator.
    *length = (uint32_t)strlen(s);
    *value = (const uint8_t*)s;
    return FRE_OK;
}

static FREResult FRENewObjectFromUTF8(uint32_t length, const uint8_t* value, FREObject* object) {
    if (object == NULL) return FRE_INVALID_ARGUMENT;
    if (value == NULL || length == 0) {
        FREObject o = as_fre_box(as_v_str(as_str_empty()));
        if (o == NULL) return FRE_INSUFFICIENT_MEMORY;
        *object = o;
        return FRE_OK;
    }
    // The two ANE idioms disagree about the length by one: AS_String(const char*)
    // passes strlen+1, AS_String(std::string) passes strlen. AIR's contract is the
    // former; copying at most length bytes and then terminating satisfies both
    // (a caller-supplied trailing NUL never becomes part of the string).
    size_t n = (size_t)length;
    if (n > 0 && value[n - 1] == 0) n--;
    char* s = as_str_alloc(n + 1);
    memcpy(s, value, n);
    s[n] = 0;
    FREObject o = as_fre_box(as_v_str(s));
    if (o == NULL) return FRE_INSUFFICIENT_MEMORY;
    *object = o;
    return FRE_OK;
}

// Same stream and framing as an AS3 trace, so a program's output does not depend
// on which side of the boundary printed a line.
static FREResult FRETrace(FREContext ctx, const char* strTrace) {
    (void)ctx;
    if (strTrace == NULL) return FRE_INVALID_ARGUMENT;
    fprintf(stdout, "%s\\n", strTrace);
    fflush(stdout);
    return FRE_OK;
}

static FREResult FREGetContextNativeData(FREContext ctx, void** nativeData) {
    if (ctx == NULL || nativeData == NULL) return FRE_INVALID_ARGUMENT;
    *nativeData = ((as_fre_ctx*)ctx)->nativeData;
    return FRE_OK;
}

static FREResult FRESetContextNativeData(FREContext ctx, void* nativeData) {
    if (ctx == NULL) return FRE_INVALID_ARGUMENT;
    ((as_fre_ctx*)ctx)->nativeData = nativeData;
    return FRE_OK;
}

// actionScriptData is an ordinary AS3 property of the ExtensionContext instance,
// so both directions go through the same dynamic accessors a ctx.actionScriptData
// in AS3 source uses -- there is no second copy that could drift.
static FREResult FREGetContextActionScriptData(FREContext ctx, FREObject *actionScriptData) {
    if (ctx == NULL || actionScriptData == NULL) return FRE_INVALID_ARGUMENT;
    as_fre_ctx* c = (as_fre_ctx*)ctx;
    as_value v = c->as3ctx != NULL ? as_dyn_get(c->as3ctx, "actionScriptData") : as_v_null();
    FREObject o = as_fre_box(v);
    if (o == NULL) return FRE_INSUFFICIENT_MEMORY;
    *actionScriptData = o;
    return FRE_OK;
}

static FREResult FRESetContextActionScriptData(FREContext ctx, FREObject actionScriptData) {
    if (ctx == NULL) return FRE_INVALID_ARGUMENT;
    as_fre_ctx* c = (as_fre_ctx*)ctx;
    if (c->as3ctx != NULL) as_dyn_set(c->as3ctx, "actionScriptData", as_fre_unbox(actionScriptData));
    return FRE_OK;
}

static FREResult FREGetFREContextFromExtensionContext(FREObject objExtensionContext, FREContext* pContext) {
    if (pContext == NULL) return FRE_INVALID_ARGUMENT;
    as_value v = as_fre_unbox(objExtensionContext);
    if (v.tag != 4 || v.ptr == NULL) return FRE_INVALID_OBJECT;
    as_fre_ctx* c = as_fre_ctx_find(v.ptr);
    if (c == NULL) return FRE_INVALID_OBJECT;
    *pContext = (FREContext)c;
    return FRE_OK;
}

// ---------- object access ----------
//
// The *_thrownException out-parameter is an invalid handle when nothing was
// thrown and the handle of the thrown value otherwise. Both come from the same
// per-call arena as every other handle.
//
// An AS3 exception raised inside a property/method access is caught here rather
// than unwinding into the extension's C stack, which is AIR's contract: the
// extension gets FRE_ACTIONSCRIPT_ERROR plus the thrown object and decides what
// to do. as_exception is cleared on the way out so the same throw is not seen
// twice by an enclosing handler.

static void as_fre_set_thrown(FREObject* thrownException, as_value exc) {
    if (thrownException != NULL) *thrownException = as_fre_box(exc);
}

static as_value as_fre_take_exception(void) {
    as_value exc = as_exception_boxed ? as_exception_v : as_v_obj(as_exception);
    as_exception = NULL;
    as_exception_boxed = 0;
    return exc;
}

// AIR's FRE className is dot-separated ("flash.geom.Point") while a registry fqn
// puts "::" between the PACKAGE and the class name -- the package's own dots stay
// ("flash.geom::Point", "flash.utils::ByteArray"). So exactly the LAST separator is
// rewritten, not every one: qualifying to "flash::geom::Point" matches nothing and
// silently turns every FRENewObject into FRE_NO_SUCH_NAME.
// A name that already carries "::" is left alone, and a bare short name ("Point",
// which AIR would reject) is passed through so the same lookup that getDefinition
// byName uses gets the last word.
static const char* as_fre_qualify(const uint8_t* className) {
    if (className == NULL) return NULL;
    const char* in = (const char*)className;
    size_t n = strlen(in);
    char* out = (char*)as_fre_alloc(n * 2 + 1);
    if (out == NULL) return NULL;
    if (strstr(in, "::") != NULL || strchr(in, '.') == NULL) {
        memcpy(out, in, n + 1);
        return out;
    }
    size_t dot = 0;
    for (size_t i = 0; i < n; i++) if (in[i] == '.') dot = i;   // last one
    size_t j = 0;
    for (size_t i = 0; i < n; i++) {
        if (i == dot) { out[j++] = ':'; out[j++] = ':'; }
        else out[j++] = in[i];
    }
    out[j] = 0;
    return out;
}

static FREResult FRENewObject(const uint8_t* className, uint32_t argc, FREObject argv[], FREObject* object, FREObject* thrownException) {
    if (object == NULL) return FRE_INVALID_ARGUMENT;
    if (thrownException != NULL) *thrownException = NULL;
    *object = NULL;
    if (className == NULL) return FRE_INVALID_ARGUMENT;
    // A class the program never names in source is not registered, so a name that
    // does not resolve is FRE_NO_SUCH_NAME -- never an AS3 throw, so an extension
    // can tell "no such class" from "the constructor threw".
    as_value cls = as_v_class_by_name(as_fre_qualify(className));
    if (cls.tag != 4 || cls.ptr == NULL) return FRE_NO_SUCH_NAME;
    as_value* argv2 = NULL;
    if (argc > 0) {
        argv2 = (as_value*)as_fre_alloc(sizeof(as_value) * (size_t)argc);
        if (argv2 == NULL) return FRE_INSUFFICIENT_MEMORY;
        for (uint32_t i = 0; i < argc; i++) argv2[i] = as_fre_unbox(argv[i]);
    }
    jmp_buf jb;
    if (setjmp(jb) == 0) {
        as_jmp_push(&jb);
        as_value r = as_dyn_new_args((as_class*)cls.ptr, (int)argc, argv2);
        as_jmp_pop();
        FREObject o = as_fre_box(r);
        if (o == NULL) return FRE_INSUFFICIENT_MEMORY;
        *object = o;
        return FRE_OK;
    }
    as_jmp_pop();
    as_fre_set_thrown(thrownException, as_fre_take_exception());
    return FRE_ACTIONSCRIPT_ERROR;
}

static FREResult FREGetObjectProperty(FREObject object, const uint8_t* propertyName, FREObject* propertyValue, FREObject* thrownException) {
    if (propertyValue == NULL) return FRE_INVALID_ARGUMENT;
    if (thrownException != NULL) *thrownException = NULL;
    *propertyValue = NULL;
    as_value v = as_fre_unbox(object);
    if (propertyName == NULL) return FRE_INVALID_ARGUMENT;
    // Two different failures, two different codes: a NULL handle is an invalid
    // object, while a perfectly good primitive (a Number, a String) is simply not
    // something you can read a NAMED property off -- AIR answers FRE_TYPE_MISMATCH
    // and an extension distinguishes the two when it reports a bug.
    if (object == NULL || v.tag == 0 || v.tag == 5) return FRE_INVALID_OBJECT;
    if (v.tag != 4 || v.ptr == NULL) return FRE_TYPE_MISMATCH;
    jmp_buf jb;
    if (setjmp(jb) == 0) {
        as_jmp_push(&jb);
        as_value r = as_dyn_get(v.ptr, (const char*)propertyName);
        as_jmp_pop();
        FREObject o = as_fre_box(r);
        if (o == NULL) return FRE_INSUFFICIENT_MEMORY;
        *propertyValue = o;
        return FRE_OK;
    }
    as_jmp_pop();
    as_fre_set_thrown(thrownException, as_fre_take_exception());
    return FRE_ACTIONSCRIPT_ERROR;
}

static FREResult FRESetObjectProperty(FREObject object, const uint8_t* propertyName, FREObject propertyValue, FREObject* thrownException) {
    if (thrownException != NULL) *thrownException = NULL;
    as_value v = as_fre_unbox(object);
    if (propertyName == NULL) return FRE_INVALID_ARGUMENT;
    // Same split as FREGetObjectProperty: invalid handle vs. valid-but-not-an-object.
    if (object == NULL || v.tag == 0 || v.tag == 5) return FRE_INVALID_OBJECT;
    if (v.tag != 4 || v.ptr == NULL) return FRE_TYPE_MISMATCH;
    jmp_buf jb;
    if (setjmp(jb) == 0) {
        as_jmp_push(&jb);
        as_dyn_set(v.ptr, (const char*)propertyName, as_fre_unbox(propertyValue));
        as_jmp_pop();
        return FRE_OK;
    }
    as_jmp_pop();
    as_fre_set_thrown(thrownException, as_fre_take_exception());
    return FRE_ACTIONSCRIPT_ERROR;
}

static FREResult FRECallObjectMethod(FREObject object, const uint8_t* methodName, uint32_t argc, FREObject argv[], FREObject* result, FREObject* thrownException) {
    if (result == NULL) return FRE_INVALID_ARGUMENT;
    if (thrownException != NULL) *thrownException = NULL;
    *result = NULL;
    as_value v = as_fre_unbox(object);
    if (v.tag != 4 || v.ptr == NULL || methodName == NULL) return FRE_INVALID_OBJECT;
    as_value* argv2 = NULL;
    if (argc > 0) {
        argv2 = (as_value*)as_fre_alloc(sizeof(as_value) * (size_t)argc);
        if (argv2 == NULL) return FRE_INSUFFICIENT_MEMORY;
        for (uint32_t i = 0; i < argc; i++) argv2[i] = as_fre_unbox(argv[i]);
    }
    jmp_buf jb;
    if (setjmp(jb) == 0) {
        as_jmp_push(&jb);
        as_value r = as_dyn_call(v.ptr, (const char*)methodName, argv2, (int)argc);
        as_jmp_pop();
        FREObject o = as_fre_box(r);
        if (o == NULL) return FRE_INSUFFICIENT_MEMORY;
        *result = o;
        return FRE_OK;
    }
    as_jmp_pop();
    as_fre_set_thrown(thrownException, as_fre_take_exception());
    return FRE_ACTIONSCRIPT_ERROR;
}

// ---------- ByteArray ----------
//
// byteArray.bytes points at the ByteArray's own byte storage, not a copy, so a
// write through the acquired pointer is visible to AS3 with no write-back step
// and FREReleaseByteArray has nothing to commit. An empty ByteArray has no
// storage at all, yet AIR still hands out a non-null zero-length pointer; the
// shared one-byte dummy covers that without letting an extension write anywhere
// real.

static uint8_t as_fre_zero_byte = 0;

static FREResult FREAcquireByteArray(FREObject object, FREByteArray* byteArrayToSet) {
    if (byteArrayToSet == NULL) return FRE_INVALID_ARGUMENT;
    byteArrayToSet->length = 0;
    byteArrayToSet->bytes = &as_fre_zero_byte;
    as_value v = as_fre_unbox(object);
    if (v.tag != 4 || v.ptr == NULL) return FRE_INVALID_OBJECT;
    if (as_fre_type_of(object) != FRE_TYPE_BYTEARRAY) return FRE_TYPE_MISMATCH;
    if (as_fre_ba_data_hook == NULL) {
        as_shell_unsupported("FREAcquireByteArray (flash.utils.ByteArray is not part of this build)");
        return FRE_ILLEGAL_STATE;
    }
    unsigned len = 0;
    void* data = as_fre_ba_data_hook(v.ptr, &len);
    byteArrayToSet->length = len;
    if (data != NULL) byteArrayToSet->bytes = (uint8_t*)data;
    return FRE_OK;
}

static FREResult FREReleaseByteArray(FREObject object) {
    as_value v = as_fre_unbox(object);
    if (v.tag != 4 || v.ptr == NULL) return FRE_INVALID_OBJECT;
    return FRE_OK;
}

static FREResult FRENewByteArray(FREByteArray* byteArrayData, FREObject *handle) {
    if (byteArrayData == NULL || handle == NULL) return FRE_INVALID_ARGUMENT;
    if (as_fre_ba_new_hook == NULL) {
        as_shell_unsupported("FRENewByteArray (flash.utils.ByteArray is not part of this build)");
        return FRE_ILLEGAL_STATE;
    }
    void* ba = as_fre_ba_new_hook(byteArrayData->length);
    if (ba == NULL) return FRE_INSUFFICIENT_MEMORY;
    if (byteArrayData->bytes != NULL && byteArrayData->length > 0) {
        unsigned len = 0;
        void* dst = as_fre_ba_data_hook(ba, &len);
        unsigned n = byteArrayData->length < len ? byteArrayData->length : len;
        if (dst != NULL) memcpy(dst, byteArrayData->bytes, n);
    }
    FREObject o = as_fre_box(as_v_obj(ba));
    if (o == NULL) return FRE_INSUFFICIENT_MEMORY;
    *handle = o;
    return FRE_OK;
}

// ---------- Array / Vector ----------

static FREResult FREGetArrayLength(FREObject arrayOrVector, uint32_t* length) {
    if (length == NULL) return FRE_INVALID_ARGUMENT;
    as_value v = as_fre_unbox(arrayOrVector);
    if (v.tag == 6 && v.ptr != NULL) { *length = (uint32_t)((as_array*)v.ptr)->length; return FRE_OK; }
    if (v.tag == 4 && v.ptr != NULL && as_dyn_kind(v.ptr) == 3) {
        as_value n = as_dyn_get(v.ptr, "length");
        if (n.tag != 1) return FRE_TYPE_MISMATCH;
        *length = as_to_uint32(n.num);
        return FRE_OK;
    }
    return FRE_TYPE_MISMATCH;
}

static FREResult FRESetArrayLength(FREObject arrayOrVector, uint32_t length) {
    as_value v = as_fre_unbox(arrayOrVector);
    if (v.tag == 6 && v.ptr != NULL) { as_array_set_length((as_array*)v.ptr, (unsigned)length); return FRE_OK; }
    // A fixed-size Vector is read-only (AIR: FRE_READ_ONLY); anything that is not
    // a sequence at all is FRE_TYPE_MISMATCH.
    if (v.tag == 4 && v.ptr != NULL && as_dyn_kind(v.ptr) == 3) return FRE_READ_ONLY;
    return FRE_TYPE_MISMATCH;
}

static FREResult FREGetArrayElementAt(FREObject arrayOrVector, uint32_t index, FREObject* value) {
    if (value == NULL) return FRE_INVALID_ARGUMENT;
    *value = NULL;
    as_value v = as_fre_unbox(arrayOrVector);
    if (v.tag == 6 && v.ptr != NULL) {
        as_array* a = (as_array*)v.ptr;
        // AIR answers FRE_OK with an invalid handle for an Array element that was
        // never defined (a sparse Array), rather than an error.
        if ((int)index >= a->length) return FRE_OK;
        FREObject o = as_fre_box(as_array_get(a, (int)index));
        if (o == NULL) return FRE_INSUFFICIENT_MEMORY;
        *value = o;
        return FRE_OK;
    }
    if (v.tag == 4 && v.ptr != NULL && as_dyn_kind(v.ptr) == 3) {
        as_value n = as_dyn_get(v.ptr, "length");
        if (n.tag == 1 && index >= as_to_uint32(n.num)) return FRE_INVALID_ARGUMENT;
        char key[24];
        snprintf(key, sizeof(key), "%u", (unsigned)index);
        FREObject o = as_fre_box(as_dyn_get(v.ptr, key));
        if (o == NULL) return FRE_INSUFFICIENT_MEMORY;
        *value = o;
        return FRE_OK;
    }
    return FRE_TYPE_MISMATCH;
}

static FREResult FRESetArrayElementAt(FREObject arrayOrVector, uint32_t index, FREObject value) {
    as_value v = as_fre_unbox(arrayOrVector);
    if (v.tag == 6 && v.ptr != NULL) {
        as_array_set((as_array*)v.ptr, (int)index, as_fre_unbox(value));
        return FRE_OK;
    }
    if (v.tag == 4 && v.ptr != NULL && as_dyn_kind(v.ptr) == 3) {
        char key[24];
        snprintf(key, sizeof(key), "%u", (unsigned)index);
        as_dyn_set(v.ptr, key, as_fre_unbox(value));
        return FRE_OK;
    }
    return FRE_TYPE_MISMATCH;
}

// ---------- BitmapData direct pixel access ----------
//
// This is the pair a video ANE is actually built around: acquire the caller's
// BitmapData, memcpy the decoded frame into \`bits32\`, release. (The shape is not
// hypothetical -- ANEQcloudLive's ANEVideoRander::getVideoBitmapData is exactly
// those three statements, and its alternative, handing the frame over as a
// ByteArray for AS3's setPixels to copy, costs one extra full-frame copy per
// frame: measured 1.06 ms of a 2.34 ms 720p frame budget on this machine.)
//
// WHY THIS IS LEGAL HERE AND NOT UNDER AIR: AIR's contract is that the pixel
// pointer is "valid only for duration of the call" (FlashRuntimeExtensions.h
// :419) and that acquiring from a non-main thread is FRE_WRONG_THREAD. Both hold:
// every FRE entry point below is reached from as_ext_call, i.e. from the AS3
// thread; and the pointer is not a transient mapping of a tiled texture but
// \`pixels\`, this runtime's own ARGB buffer. Mark-sweep never MOVES an object, so
// the address cannot shift under the extension either, and the BitmapData is
// roots-reachable for the whole call because the extension holds it as an
// argument.
//
// What this does NOT do is what AIR's acquire/release does internally: AIR pins a
// texture's tiling and has to undo it, which is why IT needs the pair. Here there
// is nothing to unwind -- \`release\` exists to say "I am done writing", and that is
// precisely the moment the write must become visible. So RELEASE marks the whole
// surface dirty, and so does INVALIDATE (which AIR only uses to narrow the upload
// to one rect; a full-surface upload is the same answer, more work).
//
// The one thing left to the caller is what AIR also leaves to it: \`width\` and
// \`height\` are the BitmapData's, and an extension that memcpys a LARGER frame than
// the bitmap it was given writes past the end of the buffer. That is the
// extension's bug in both runtimes; the descriptor reports the true geometry so
// the check is possible.

static FREResult as_fre_bmd_describe(FREObject object, FREBitmapData2* out) {
    out->width = 0; out->height = 0; out->hasAlpha = 0; out->isPremultiplied = 0;
    out->lineStride32 = 0; out->isInvertedY = 0; out->bits32 = NULL;
    as_value v = as_fre_unbox(object);
    // AS3 null/undefined and a primitive are different failures to an extension:
    // the first is a missing object, the second is a value of the wrong kind (the
    // same split FREAcquireNativeWindowHandle makes).
    if (v.tag != 4 || v.ptr == NULL) return FRE_INVALID_OBJECT;
    if (as_fre_bmd_desc_hook == NULL) {
        as_shell_unsupported("FREAcquireBitmapData (flash.display.BitmapData is not part of this build)");
        return FRE_ILLEGAL_STATE;
    }
    int st = as_fre_bmd_desc_hook(v.ptr, out);
    if (st == 0) return FRE_TYPE_MISMATCH;
    // A disposed BitmapData still exists as an object; it just has no pixels. AIR
    // answers FRE_INVALID_OBJECT rather than a descriptor pointing at freed memory.
    if (st < 0) return FRE_INVALID_OBJECT;
    return FRE_OK;
}

static FREResult FREAcquireBitmapData(FREObject object, FREBitmapData* descriptorToSet) {
    if (descriptorToSet == NULL) return FRE_INVALID_ARGUMENT;
    // Fill the v1 descriptor field by field rather than memcpy-ing the v2 one: the
    // two agree up to lineStride32 and then diverge (v2 inserts isInvertedY before
    // bits32), so a struct copy would put the pointer where a v1 client reads y.
    FREBitmapData2 d;
    FREResult r = as_fre_bmd_describe(object, &d);
    descriptorToSet->width = d.width;
    descriptorToSet->height = d.height;
    descriptorToSet->hasAlpha = d.hasAlpha;
    descriptorToSet->isPremultiplied = d.isPremultiplied;
    descriptorToSet->lineStride32 = d.lineStride32;
    descriptorToSet->bits32 = d.bits32;
    return r;
}

static FREResult FREAcquireBitmapData2(FREObject object, FREBitmapData2* descriptorToSet) {
    if (descriptorToSet == NULL) return FRE_INVALID_ARGUMENT;
    return as_fre_bmd_describe(object, descriptorToSet);
}

// Both of these answer FRE_OK for any live BitmapData and nothing else: there is
// no lock to unwind here (see the section comment), and an extension calling them
// with the wrong object has a bug that must show up as FRE_TYPE_MISMATCH.
static FREResult FREInvalidateBitmapDataRect(FREObject object, uint32_t x, uint32_t y, uint32_t width, uint32_t height) {
    (void)x; (void)y; (void)width; (void)height;
    FREBitmapData2 d;
    FREResult r = as_fre_bmd_describe(object, &d);
    if (r != FRE_OK) return r;
    as_fre_bmd_dirty_hook(as_fre_unbox(object).ptr);
    return FRE_OK;
}

static FREResult FREReleaseBitmapData(FREObject object) {
    FREBitmapData2 d;
    FREResult r = as_fre_bmd_describe(object, &d);
    if (r != FRE_OK) return r;
    as_fre_bmd_dirty_hook(as_fre_unbox(object).ptr);
    return FRE_OK;
}

// ---------- still deferred: the render pipeline proper (report section 4.4) ----------
//
// Each of these reports itself and answers FRE_ILLEGAL_STATE. FRE_OK here would
// let a video extension believe a frame was presented when nothing was drawn.

static FREResult FREGetRenderMode(FREContext ctx, FREObject stage, uint8_t* pRenderMode) {
    (void)ctx; (void)stage; (void)pRenderMode;
    as_shell_unsupported("FREGetRenderMode (the render pipeline is out of scope for this build)");
    return FRE_ILLEGAL_STATE;
}

static FREResult FRESetRenderSource(FREContext ctx, FREObject source, FREObject target) {
    (void)ctx; (void)source; (void)target;
    as_shell_unsupported("FRESetRenderSource (the render pipeline is out of scope for this build)");
    return FRE_ILLEGAL_STATE;
}

static FREResult FREMediaBufferLock(FREContext ctx, FREObject mediaBuffer, uint8_t** pData, uint32_t* pWidth, uint32_t* pHeight, uint32_t* pStride, uint32_t* pFormat) {
    (void)ctx; (void)mediaBuffer; (void)pData; (void)pWidth; (void)pHeight; (void)pStride; (void)pFormat;
    as_shell_unsupported("FREMediaBufferLock (the render pipeline is out of scope for this build)");
    return FRE_ILLEGAL_STATE;
}

static FREResult FREMediaBufferUnlock(FREContext ctx, FREObject mediaBuffer, uint32_t bUpdate) {
    (void)ctx; (void)mediaBuffer; (void)bUpdate;
    as_shell_unsupported("FREMediaBufferUnlock (the render pipeline is out of scope for this build)");
    return FRE_ILLEGAL_STATE;
}

static FREResult FREGetNativeContext3DHandle(FREObject context3D, void** handle) {
    (void)context3D; (void)handle;
    as_shell_unsupported("FREGetNativeContext3DHandle (the render pipeline is out of scope for this build)");
    return FRE_ILLEGAL_STATE;
}

// ---------- native window handles: the one D-face pair that is NOT deferred ----------
//
// Everything above is deferred because it would claim a presentation path. A window
// HANDLE claims nothing of the sort: this build owns real OS windows (SDL creates
// them, window_glue answers the platform object), so an extension that needs the
// HWND to parent its own child window, install a hook or query the monitor can have
// it. What it must NOT do is infer anything about presentation from it -- there is
// still no render mode, no render source and no media buffer.
//
// Neither call retains anything. AIR's own header annotates the handle as "valid
// only for duration of the call to a registered function", and the window keeps
// owning its native object for its whole life: closing the NativeWindow still tears
// the OS window down through ASC_window_on_close, exactly as without an extension.
// That is also why FREReleaseNativeWindowHandle has no reference count to unwind --
// but it still validates its argument, because an extension calling it with the
// wrong object is a bug that should be visible rather than absorbed.

static FREResult FREAcquireNativeWindowHandle(FREObject nativeWindow, FRENativeWindow* handle) {
    if (handle == NULL) return FRE_INVALID_ARGUMENT;
    *handle = (FRENativeWindow)0;
    as_value v = as_fre_unbox(nativeWindow);
    // AS3 null / undefined: a valid answer to "which window?" is FRE_INVALID_OBJECT,
    // which is also what an extension passing a null handle gets from AIR.
    if (v.tag == 0 || v.tag == 5) return FRE_INVALID_OBJECT;
    // Anything else that is not a NativeWindow instance is a TYPE error, the same
    // reading asaot.h takes for a primitive handle passed where an object belongs.
    int id = -1;
    if (!as_native_window_id_of(v, &id)) return FRE_TYPE_MISMATCH;
    // A closed window has no OS window behind it: ASC_window_on_close sets _win = -1
    // and the SLOT is recycled by the next window, so answering it would hand out
    // somebody else's HWND. FRE_ILLEGAL_STATE, never a stale handle.
    if (id < 0) return FRE_ILLEGAL_STATE;
    void* h = as_window_native_handle(id);
    if (h == NULL) {
        // No window backend at all (web), or a slot SDL cannot describe. Report the
        // gap: a fabricated pointer here is a crash inside the extension.
        as_shell_unsupported("FREAcquireNativeWindowHandle (this build has no native window handle)");
        return FRE_ILLEGAL_STATE;
    }
    *handle = (FRENativeWindow)h;
    return FRE_OK;
}

static FREResult FREReleaseNativeWindowHandle(FREObject nativeWindow) {
    as_value v = as_fre_unbox(nativeWindow);
    if (v.tag == 0 || v.tag == 5) return FRE_INVALID_OBJECT;
    int id = -1;
    if (!as_native_window_id_of(v, &id)) return FRE_TYPE_MISMATCH;
    // Nothing is retained (see above), so a RELEASE is always answerable once the
    // operand is a NativeWindow -- including one the program already closed, whose
    // teardown path must not be turned into a failure the extension cannot act on.
    return FRE_OK;
}

// ---------- threading ----------
//
// Served here rather than in the host library, so the module that INITIALIZES a
// caller-allocated FREMutex is always the one that locks and destroys it. The
// struct is the CALLER's own (a CRITICAL_SECTION on Windows, a pthread_mutex_t on
// macOS -- asaot.h picks the type per platform), and splitting init from lock
// across two modules would be a lifetime bug waiting to happen.
//
// The two platforms also disagree about what an FREThread IS, which is why "the
// null thread" is produced here instead of being assumed by a caller: a Win32
// thread id is a 32-bit number whose 0 no live thread takes (they start at 4),
// whereas a pthread_t is an opaque handle.
#if defined(_WIN32)
static FREThread FRECurrentThread(void) { return (FREThread)(uintptr_t)GetCurrentThreadId(); }
// FREThread is a 32-bit id on Windows, where 0 is the value no thread id takes
// (they start at 4) -- so it is the null this platform can express.
static FREThread FRENullThread(void) { return (FREThread)(uintptr_t)0; }

static uint32_t FREThreadCreate(FREThread* thread, FREThreadFunction start_fn, FREThreadArg arg) {
    if (thread == NULL || start_fn == NULL) return 0;
    DWORD tid = 0;
    HANDLE h = CreateThread(NULL, 0, start_fn, arg, 0, &tid);
    if (h == NULL) return 0;
    CloseHandle(h);
    *thread = (FREThread)(uintptr_t)tid;
    return 1;
}

// Detach is the documented Windows behaviour: the handle is already closed above,
// so the thread's resources are reclaimed when it exits.
static uint32_t FREThreadDetach(FREThread thread) { (void)thread; return 1; }
static void FREThreadSleep(int32_t timeout_millis) { Sleep((DWORD)(timeout_millis < 0 ? 0 : timeout_millis)); }

static void FREThreadJoin(FREThread thread) {
    HANDLE h = OpenThread(SYNCHRONIZE, FALSE, (DWORD)(uintptr_t)thread);
    if (h == NULL) return;
    WaitForSingleObject(h, INFINITE);
    CloseHandle(h);
}

// Windows' CRITICAL_SECTION is recursive by construction, which is exactly what
// the FRERecursiveMutex* family promises.
static uint32_t FRERecursiveMutexInit(FREMutex* mutex) {
    if (mutex == NULL) return 0;
    InitializeCriticalSection(mutex);
    return 1;
}
static uint32_t FRERecursiveMutexDestroy(FREMutex* mutex) {
    if (mutex == NULL) return 0;
    DeleteCriticalSection(mutex);
    return 1;
}
static void FRERecursiveMutexLock(FREMutex* mutex) { if (mutex != NULL) EnterCriticalSection(mutex); }
static uint32_t FRERecursiveMutexTryLock(FREMutex* mutex) {
    if (mutex == NULL) return 0;
    return TryEnterCriticalSection(mutex) ? 1u : 0u;
}
static void FRERecursiveMutexUnlock(FREMutex* mutex) { if (mutex != NULL) LeaveCriticalSection(mutex); }

#else   // POSIX (macOS): pthreads, whose types asaot.h already declares for this side

static FREThread FRECurrentThread(void) { return pthread_self(); }
// A pthread_t is an opaque handle, so unlike the Windows branch there is no
// value no live thread takes; a zeroed one is the null this platform can express.
static FREThread FRENullThread(void) { return (FREThread)0; }

static uint32_t FREThreadCreate(FREThread* thread, FREThreadFunction start_fn, FREThreadArg arg) {
    if (thread == NULL || start_fn == NULL) return 0;
    pthread_t t;
    if (pthread_create(&t, NULL, start_fn, arg) != 0) return 0;
    *thread = t;
    return 1;
}

// Detach is the documented Windows behaviour (the created thread's handle is
// closed at once, so its resources are reclaimed when it exits), and
// pthread_detach is its direct counterpart. Detaching is why FREThreadJoin below
// is best-effort: a detached thread cannot be joined on either platform.
static uint32_t FREThreadDetach(FREThread thread) { return pthread_detach(thread) == 0 ? 1u : 0u; }

static void FREThreadSleep(int32_t timeout_millis) {
    if (timeout_millis <= 0) return;
    struct timespec ts;
    ts.tv_sec = timeout_millis / 1000;
    ts.tv_nsec = (long)(timeout_millis % 1000) * 1000000L;
    // nanosleep resumes on a signal rather than failing, so the loop is what makes
    // the sleep the FULL requested duration.
    while (nanosleep(&ts, &ts) == -1 && errno == EINTR) { }
}

static void FREThreadJoin(FREThread thread) { (void)pthread_join(thread, NULL); }

// PTHREAD_MUTEX_RECURSIVE, because that is exactly what the FRERecursiveMutex*
// family promises and what Windows' CRITICAL_SECTION is by construction. A default
// (non-recursive) mutex would deadlock the first time an extension re-locked its
// own mutex, which is a real pattern.
static uint32_t FRERecursiveMutexInit(FREMutex* mutex) {
    if (mutex == NULL) return 0;
    pthread_mutexattr_t a;
    if (pthread_mutexattr_init(&a) != 0) return 0;
    pthread_mutexattr_settype(&a, PTHREAD_MUTEX_RECURSIVE);
    int rc = pthread_mutex_init(mutex, &a);
    pthread_mutexattr_destroy(&a);
    return rc == 0 ? 1u : 0u;
}
static uint32_t FRERecursiveMutexDestroy(FREMutex* mutex) {
    if (mutex == NULL) return 0;
    return pthread_mutex_destroy(mutex) == 0 ? 1u : 0u;
}
static void FRERecursiveMutexLock(FREMutex* mutex) { if (mutex != NULL) pthread_mutex_lock(mutex); }
static uint32_t FRERecursiveMutexTryLock(FREMutex* mutex) {
    if (mutex == NULL) return 0;
    return pthread_mutex_trylock(mutex) == 0 ? 1u : 0u;
}
static void FRERecursiveMutexUnlock(FREMutex* mutex) { if (mutex != NULL) pthread_mutex_unlock(mutex); }

#endif  // threading

// ---------- callbacks ----------

static FREResult FREDispatchStatusEventAsync(FREContext ctx, const uint8_t* code, const uint8_t* level) {
    if (code == NULL || level == NULL) return FRE_INVALID_ARGUMENT;
    as_fre_ctx* c = (as_fre_ctx*)ctx;
    if (c == NULL) return FRE_INVALID_ARGUMENT;
    // Nothing to dispatch to before the generated ExtensionContext installs the
    // hook. AIR promises FRE_OK regardless ("the referenced object cannot
    // necessarily be checked for validity on the invoking thread"), so the event
    // is dropped rather than turned into an error the extension cannot act on.
    if (as_fre_status_hook == NULL) return FRE_OK;
    as_fre_status* s = (as_fre_status*)calloc(1, sizeof(as_fre_status));
    if (s == NULL) return FRE_INSUFFICIENT_MEMORY;
    size_t cl = strlen((const char*)code), ll = strlen((const char*)level);
    s->code = (char*)malloc(cl + 1);
    s->level = (char*)malloc(ll + 1);
    if (s->code == NULL || s->level == NULL) { free(s->code); free(s->level); free(s); return FRE_INSUFFICIENT_MEMORY; }
    memcpy(s->code, code, cl + 1);
    memcpy(s->level, level, ll + 1);
    as_fre_qcs_init();
    AS_FRE_Q_LOCK();
    if (c->status_tail == NULL) c->status_head = s; else c->status_tail->next = s;
    c->status_tail = s;
    AS_FRE_Q_UNLOCK();
    return FRE_OK;
}

// ---------- installing the host table ----------

static int as_fre_bound = 0;

// Load the host library and hand it the 51 implementations above. It is a pure
// forwarder: it holds no AS3 state, so everything an extension does lands in
// this executable's heap and class registry.
//
// The library sits beside the EXECUTABLE, which is what makes the build
// relocatable -- the same thing AIR does relative to the application directory.
// On Windows a bare LoadLibraryA("asaot.dll") is found there by the loader's own
// search order. On macOS the path is composed from the running executable's
// directory rather than left to the loader's search paths, so the copy opened is
// the one src/index.ts staged and not some other build on the machine.
static void as_fre_install(void) {
    if (as_fre_bound) return;
#if defined(_WIN32)
    as_fre_lib lib = as_fre_lib_open(AS_FRE_LIB_NAME);
#else
    char exedir[2048];
    // NOT named host: an AsaotHost named host is built further down this same
    // function, and a same-scope char array under that name makes every later
    // host.FREFoo assignment report "member reference base type 'char[2300]' is not
    // a structure or union" -- which names neither the array nor the shadowing.
    char hostpath[2300];
    if (!as_fre_exe_dir(exedir, sizeof(exedir))) {
        as_shell_unsupported("the running executable's directory could not be determined, so "
                             AS_FRE_LIB_NAME " cannot be loaded and native extensions are unavailable");
        return;
    }
    snprintf(hostpath, sizeof(hostpath), "%s/%s", exedir, AS_FRE_LIB_NAME);
    as_fre_lib lib = as_fre_lib_open(hostpath);
#endif
    if (lib == NULL) {
        // The loader's own diagnostic is what separates the possible causes. On
        // Windows the code is the whole diagnosis (see as_fre_lib_err): a wrong
        // bitness and a missing file used to be reported identically. On macOS
        // dlerror() names the path it tried and why it gave up.
        char amsg[2400];
        snprintf(amsg, sizeof(amsg),
                 AS_FRE_LIB_NAME " could not be loaded from beside the executable (%s); "
                 "native extensions cannot be loaded", as_fre_lib_err());
        as_shell_unsupported(amsg);
        return;
    }
    typedef int (*AsaotBindFn)(const AsaotHost*);
    AsaotBindFn bind = (AsaotBindFn)as_fre_lib_sym(lib, "asaot_bind");
    if (bind == NULL) {
        as_shell_unsupported(AS_FRE_LIB_NAME " does not export asaot_bind (stale or foreign build)");
        return;
    }
    static AsaotHost host;
    memset(&host, 0, sizeof(host));
    host.abi_version = ASAOT_ABI_VERSION;
    host.report = as_shell_unsupported;
    host.FREGetContextNativeData = FREGetContextNativeData;
    host.FRESetContextNativeData = FRESetContextNativeData;
    host.FREGetContextActionScriptData = FREGetContextActionScriptData;
    host.FRESetContextActionScriptData = FRESetContextActionScriptData;
    host.FREGetObjectType = FREGetObjectType;
    host.FREGetObjectAsInt32 = FREGetObjectAsInt32;
    host.FREGetObjectAsUint32 = FREGetObjectAsUint32;
    host.FREGetObjectAsDouble = FREGetObjectAsDouble;
    host.FREGetObjectAsBool = FREGetObjectAsBool;
    host.FRENewObjectFromInt32 = FRENewObjectFromInt32;
    host.FRENewObjectFromUint32 = FRENewObjectFromUint32;
    host.FRENewObjectFromDouble = FRENewObjectFromDouble;
    host.FRENewObjectFromBool = FRENewObjectFromBool;
    host.FREGetObjectAsUTF8 = FREGetObjectAsUTF8;
    host.FRENewObjectFromUTF8 = FRENewObjectFromUTF8;
    host.FRETrace = FRETrace;
    host.FREGetRenderMode = FREGetRenderMode;
    host.FRESetRenderSource = FRESetRenderSource;
    host.FREMediaBufferLock = FREMediaBufferLock;
    host.FREMediaBufferUnlock = FREMediaBufferUnlock;
    host.FRENewObject = FRENewObject;
    host.FREGetObjectProperty = FREGetObjectProperty;
    host.FRESetObjectProperty = FRESetObjectProperty;
    host.FRECallObjectMethod = FRECallObjectMethod;
    host.FREAcquireBitmapData = FREAcquireBitmapData;
    host.FREAcquireBitmapData2 = FREAcquireBitmapData2;
    host.FREInvalidateBitmapDataRect = FREInvalidateBitmapDataRect;
    host.FREReleaseBitmapData = FREReleaseBitmapData;
    host.FRENewByteArray = FRENewByteArray;
    host.FREAcquireByteArray = FREAcquireByteArray;
    host.FREReleaseByteArray = FREReleaseByteArray;
    host.FREGetArrayLength = FREGetArrayLength;
    host.FRESetArrayLength = FRESetArrayLength;
    host.FREGetArrayElementAt = FREGetArrayElementAt;
    host.FRESetArrayElementAt = FRESetArrayElementAt;
    host.FREAcquireNativeWindowHandle = FREAcquireNativeWindowHandle;
    host.FREReleaseNativeWindowHandle = FREReleaseNativeWindowHandle;
    host.FREGetNativeContext3DHandle = FREGetNativeContext3DHandle;
    host.FREGetFREContextFromExtensionContext = FREGetFREContextFromExtensionContext;
    host.FRECurrentThread = FRECurrentThread;
    host.FRENullThread = FRENullThread;
    host.FREThreadCreate = FREThreadCreate;
    host.FREThreadDetach = FREThreadDetach;
    host.FREThreadSleep = FREThreadSleep;
    host.FREThreadJoin = FREThreadJoin;
    host.FRERecursiveMutexInit = FRERecursiveMutexInit;
    host.FRERecursiveMutexDestroy = FRERecursiveMutexDestroy;
    host.FRERecursiveMutexLock = FRERecursiveMutexLock;
    host.FRERecursiveMutexTryLock = FRERecursiveMutexTryLock;
    host.FRERecursiveMutexUnlock = FRERecursiveMutexUnlock;
    host.FREDispatchStatusEventAsync = FREDispatchStatusEventAsync;
    int rc = bind(&host);
    if (rc != 0) {
        as_shell_unsupported(rc == 2 ? AS_FRE_LIB_NAME " was built against a different ABI version" : "asaot_bind rejected the host table");
        return;
    }
    as_fre_bound = 1;
}

// ---------- C face: loading a native extension ----------

typedef struct {
    const as_ane_desc* desc;
    as_fre_lib lib;
    void* ext_data;
    FREContextInitializer ctx_init;
    FREContextFinalizer ctx_final;
    int state;                       // 0 not tried, 1 loaded, 2 failed
} as_ane_loaded;

static as_ane_loaded as_anes[ASC_ANE_COUNT_MAX];

// Where the recompiled native libraries live: an extensions directory next to
// the executable, resolved through the running module's own path so the build
// stays relocatable (AIR does the same relative to the application directory).
static char as_ext_dir_buf[2048];
static int  as_ext_dir_ready = 0;

static const char* as_ext_dir(void) {
    if (!as_ext_dir_ready) {
#if defined(_WIN32)
        DWORD n = GetModuleFileNameA(NULL, as_ext_dir_buf, (DWORD)sizeof(as_ext_dir_buf));
        if (n == 0 || n >= (DWORD)sizeof(as_ext_dir_buf)) {
            as_ext_dir_buf[0] = 0;
        } else {
            for (DWORD i = n; i > 0; i--) {
                if (as_ext_dir_buf[i - 1] == '\\\\' || as_ext_dir_buf[i - 1] == '/') { as_ext_dir_buf[i - 1] = 0; break; }
            }
        }
        strncat(as_ext_dir_buf, "\\\\extensions", sizeof(as_ext_dir_buf) - strlen(as_ext_dir_buf) - 1);
#else
        // The same layout with POSIX separators: the directory holding the
        // executable, then /extensions. An executable whose own directory cannot be
        // determined leaves this empty, and as_ane_load's report then names the
        // empty path -- the honest answer, rather than a guess at a relative one.
        char exedir[2048];
        if (as_fre_exe_dir(exedir, sizeof(exedir))) {
            snprintf(as_ext_dir_buf, sizeof(as_ext_dir_buf), "%s/extensions", exedir);
        } else {
            as_ext_dir_buf[0] = 0;
        }
#endif
        as_ext_dir_ready = 1;
    }
    return as_ext_dir_buf;
}

// Load (once) the native library behind descriptor i, and run its Initializer.
// Returns 1 when a ContextInitializer is available.
//
// The path is as_ext_dir() (which ends with the platform's separator plus
// "extensions") joined with the descriptor's own relative path
// '<extensionID>/<platform>/<lib>'. The mix of separators is deliberate: the
// descriptor keeps AIR's forward-slash convention (it mirrors the address inside
// the .ane), and both Win32 file APIs and POSIX take '/' as a separator, so the
// loader resolves it either way.
//
// Every failure names itself. AIR's contract is that createExtensionContext
// returns null when the initializer "cannot be loaded or run", which makes a
// silent null indistinguishable from "no extension has this ID" -- the one
// distinction an application has to act on. AGENTS.md section 1.5: report, then
// return the AIR-shaped value.
static int as_ane_load(int i) {
    if (as_anes[i].state == 1) return 1;
    if (as_anes[i].state == 2) return 0;
    const as_ane_desc* d = &as_ane_descs[i];
    as_anes[i].desc = d;
    char path[2300];
#if defined(_WIN32)
    snprintf(path, sizeof(path), "%s\\\\%s", as_ext_dir(), d->native_lib);
#else
    snprintf(path, sizeof(path), "%s/%s", as_ext_dir(), d->native_lib);
#endif
    as_fre_lib lib = as_fre_lib_open(path);
    if (lib == NULL) {
        // Same two-cause split as as_fre_install. This sentence used to blame
        // Adobe AIR.dll unconditionally, which sends a user off to recompile a
        // library that has already been recompiled: a wrong-bitwidth slice fails
        // with 193 (it exists; it just cannot load here), not with a missing
        // import. The FULL PATH is part of the message because both slices of an
        // ANE carry the same file name, so the name alone does not say which one
        // was tried -- and now that each extension has its own directory, so does
        // the directory.
        char emsg[2400];
        snprintf(emsg, sizeof(emsg),
                 "extension native library not loadable: %s (%s; an ANE that still imports "
                 "Adobe AIR must be recompiled against " AS_FRE_LINK_NAME ")",
                 path, as_fre_lib_err());
        as_shell_unsupported(emsg);
        as_anes[i].state = 2;
        return 0;
    }
    as_anes[i].lib = lib;
    FREInitializer init = (FREInitializer)as_fre_lib_sym(lib, d->initializer);
    if (init == NULL) {
        const char* parts[3];
        parts[0] = "extension exports no Initializer named ";
        parts[1] = d->initializer;
        parts[2] = " (is this ANE recompiled against " AS_FRE_LINK_NAME "?)";
        as_shell_unsupported(as_str_concat_n(3, parts));
        as_anes[i].state = 2;
        return 0;
    }
    init(&as_anes[i].ext_data, &as_anes[i].ctx_init, &as_anes[i].ctx_final);
    if (as_anes[i].ctx_init == NULL) {
        const char* parts[2];
        parts[0] = "extension Initializer set no ContextInitializer: ";
        parts[1] = d->initializer;
        as_shell_unsupported(as_str_concat_n(2, parts));
        as_anes[i].state = 2;
        return 0;
    }
    as_anes[i].state = 1;
    return 1;
}

// An extensionID to a descriptor index; -1 means "no extension with this ID is
// part of this build" -- the one case where AIR's null is the whole truth.
static int as_ane_index(const char* ext_id) {
    if (ext_id == NULL) return -1;
    for (int i = 0; i < ASC_ANE_COUNT; i++) {
        if (as_ane_descs[i].ext_id != NULL && strcmp(as_ane_descs[i].ext_id, ext_id) == 0) return i;
    }
    return -1;
}

// createExtensionContext's real body: resolve, load, run the ContextInitializer,
// hand back the context. NULL (always with a report) in exactly AIR's two null
// cases, and never for a third reason.
static as_fre_ctx* as_ext_create(const char* ext_id, const char* ctx_type, void* as3ctx) {
    as_fre_install();
    as_fre_wire_classes();
    int i = as_ane_index(ext_id);
    if (i < 0) {
        const char* parts[2];
        parts[0] = "no native extension with this ID is part of the build: ";
        parts[1] = ext_id;
        as_shell_unsupported(as_str_concat_n(2, parts));
        return NULL;
    }
    if (!as_ane_load(i)) return NULL;
    as_fre_ctx* c = as_fre_ctx_add(&as_ane_descs[i], as3ctx);
    if (c == NULL) return NULL;
    uint32_t n = 0;
    const FRENamedFunction* fns = NULL;
    as_anes[i].ctx_init(as_anes[i].ext_data,
                        (const uint8_t*)(ctx_type != NULL ? ctx_type : ""),
                        (FREContext)c, &n, &fns);
    c->nfuncs = n;
    c->funcs = fns;
    return c;
}

// ExtensionContext.call's native half. *handled is 0 when the extension
// publishes no function with that name -- the caller then reports the miss and
// answers null, exactly as A face documents (AIR's own wording for this case has
// not been measured against a real ANE yet, and inventing an error code would be
// worse than reporting the gap).
static as_value as_ext_call(void* ctxp, const char* fn, as_value* args, int argc, int* handled) {
    as_fre_ctx* c = (as_fre_ctx*)ctxp;
    *handled = 0;
    if (c == NULL || c->disposed || fn == NULL) return as_v_null();
    if (c->funcs == NULL) {
        as_shell_unsupported("the extension published no function table");
        return as_v_null();
    }
    // AIR's registered functions take a per-function context slot: the
    // functionData the table carried, not a value we invent.
    int fi = -1;
    for (uint32_t i = 0; i < c->nfuncs; i++) {
        if (c->funcs[i].name != NULL && strcmp((const char*)c->funcs[i].name, fn) == 0) { fi = (int)i; break; }
    }
    if (fi < 0) {
        const char* parts[2];
        parts[0] = "the extension publishes no function named ";
        parts[1] = fn;
        as_shell_unsupported(as_str_concat_n(2, parts));
        return as_v_null();
    }
    *handled = 1;
    as_fre_scope_begin();
    // The per-call arena needs at least one block before as_fre_box can be used.
    (void)as_fre_alloc(16);
    FREObject* argv = NULL;
    if (argc > 0) {
        argv = (FREObject*)as_fre_alloc(sizeof(FREObject) * (size_t)argc);
        for (int i = 0; i < argc; i++) argv[i] = as_fre_box(args[i]);
    }
    as_value result = as_v_null();
    jmp_buf jb;
    if (setjmp(jb) == 0) {
        as_jmp_push(&jb);
        FREObject r = c->funcs[fi].function((FREContext)c, c->funcs[fi].functionData, (uint32_t)argc, argv);
        as_jmp_pop();
        result = as_fre_unbox(r);
    } else {
        // An AS3 exception thrown across the extension (a listener, a getter, a
        // callProperty) propagates to the AS3 caller, which is what AIR does.
        as_jmp_pop();
        as_throw_val(as_fre_take_exception());
    }
    as_fre_scope_end();
    // Deliver whatever the extension queued during the call before returning to
    // AS3: ctx.addEventListener(StatusEvent.STATUS, ...) must already have fired
    // by the next statement, not at some later frame.
    as_fre_pump();
    return result;
}

static void as_ext_dispose(void* ctxp) {
    as_fre_ctx* c = (as_fre_ctx*)ctxp;
    if (c == NULL || c->disposed) return;
    // AIR runs the ContextFinalizer before the context stops being usable, and
    // keeps the native library loaded (other contexts may share it).
    if (c->desc != NULL) {
        for (int i = 0; i < ASC_ANE_COUNT; i++) {
            if (&as_ane_descs[i] == c->desc) {
                if (as_anes[i].state == 1 && as_anes[i].ctx_final != NULL)
                    as_anes[i].ctx_final((FREContext)c);
                break;
            }
        }
    }
    c->disposed = 1;
    as_fre_pump();
}

static void as_fre_mark_ctx_roots(void) {
    for (as_fre_ctx* c = as_fre_ctxs; c != NULL; c = c->next) {
        if (c->as3ctx != NULL) gc_mark_ptr(c->as3ctx);
    }
    as_fre_mark_roots();
}

#endif // ASC_HAVE_FRE
`

/**
 * The non-FRE build's answer to the four functions generated code calls. Same
 * names, same signatures, no behaviour -- which keeps the emitted
 * ExtensionContext body free of `#ifdef` and lets a wasm/web build (where an
 * ANE's native library has nowhere to run) keep compiling.
 */
export const FRE_STUBS = `
#ifndef ASC_HAVE_FRE
static void* as_ext_create(const char* ext_id, const char* ctx_type, void* as3ctx) {
    (void)ext_id; (void)ctx_type; (void)as3ctx;
    return NULL;
}
static as_value as_ext_call(void* ctx, const char* fn, as_value* args, int argc, int* handled) {
    (void)ctx; (void)fn; (void)args; (void)argc;
    *handled = 0;
    return as_v_null();
}
static void as_ext_dispose(void* ctx) { (void)ctx; }
static void as_fre_pump(void) { }
static void as_fre_mark_ctx_roots(void) { }
#endif
`
