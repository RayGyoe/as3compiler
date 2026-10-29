/*
 * Recompiled "Probe" native extension: the end-to-end fixture for the FRE host.
 *
 * It is written the way a REAL ANE is written -- include the FRE header, register
 * a function table from the context initializer, read arguments with
 * FREGetObjectAs*, answer with FRENewObjectFrom* -- and the ONLY difference from
 * the original package is which import library it links (asaot.lib instead of
 * Adobe AIR.dll's). That is the whole point of the dual-artifact arrangement: the
 * extension's C source does not change, so a real ANE's source does not either.
 *
 * The function list deliberately covers the values an ANE actually passes:
 *   ping()                              -> "pong"          (a String out)
 *   addInt(a:int, b:int)                -> a + b           (int in, int out)
 *   scale(a:Number, b:Number)           -> a * b           (double in/out)
 *   isDebug()                           -> false           (bool out)
 *   echo(v:*)                           -> v               (round trip)
 *   sumArray(arr:Array)                 -> element count   (Array in)
 *   makeByteArray(n:int)                -> ByteArray       (ByteArray out)
 *   roundTripBytes(ba:ByteArray)        -> first byte      (ByteArray in)
 *   pointX(o:Object)                    -> FRENewObject/GetObjectProperty/CallObjectMethod
 *   nativeData()                        -> FREGet/SetContextNativeData
 *   bumpStatus()                        -> FREDispatchStatusEventAsync
 *   arityCheck(v:*)                     -> FREGetObjectType
 *   stringInfo(v:String)                -> bytes/len/extra (the FRE string length contract)
 *   nativeWindowHandle(win:NativeWindow) -> FREAcquire|ReleaseNativeWindowHandle
 *   writeBitmapData(bmd, argb)          -> FREAcquire|Invalidate|ReleaseBitmapData
 *   bitmapDataErrors(v:*)               -> the FREResult each call answers for a bad operand
 *
 * Anything the host cannot do reports itself on stderr (as_shell_unsupported) and
 * returns FRE_ILLEGAL_STATE, which this fixture turns into a distinguishable
 * string -- so a gap can never masquerade as an answer.
 */

#include "FlashRuntimeExtensions.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

typedef struct {
    int calls;
    int dataReady;
} ProbeExtData;

/* The extension's OWN exports. Note this is deliberately NOT asaot.h's ASAOT_API:
 * that one is dllimport here (it decorates the FRE symbols the extension IMPORTS
 * from the host library), and applying it to a definition is an error. A real ANE
 * decorates its ExtInitializer/ExtFinalizer its own way (ANENDI's .vcxproj does it
 * with a .def file); the FRE header has nothing to say about them. */
#ifdef _WIN32
  #define PROBE_EXPORT __declspec(dllexport)
#else
  /* Default visibility, spelled out rather than relied on: a dylib exports
   * non-static symbols by default anyway, but the build script's guard asserts
   * that ProbeExtInitializer IS exported, and a future -fvisibility=hidden would
   * otherwise turn a working fixture into one that fails to load with a message
   * about a missing initializer. The two halves of the recipe (source decoration
   * and artifact guard) stay in agreement this way. */
  #define PROBE_EXPORT __attribute__((visibility("default")))
#endif

/* ---- registered functions ------------------------------------------------- */

static FREObject probe_ping(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData; (void)argc; (void)argv;
    FREObject out = NULL;
    const char* s = "pong";
    FRENewObjectFromUTF8((uint32_t)strlen(s) + 1u, (const uint8_t*)s, &out);
    return out;
}

static FREObject probe_addInt(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData;
    int32_t a = 0, b = 0;
    if (argc != 2) return NULL;
    if (FREGetObjectAsInt32(argv[0], &a) != FRE_OK) return NULL;
    if (FREGetObjectAsInt32(argv[1], &b) != FRE_OK) return NULL;
    FREObject out = NULL;
    FRENewObjectFromInt32(a + b, &out);
    return out;
}

static FREObject probe_scale(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData;
    double a = 0, b = 0;
    if (argc != 2) return NULL;
    if (FREGetObjectAsDouble(argv[0], &a) != FRE_OK) return NULL;
    if (FREGetObjectAsDouble(argv[1], &b) != FRE_OK) return NULL;
    FREObject out = NULL;
    FRENewObjectFromDouble(a * b, &out);
    return out;
}

static FREObject probe_isDebug(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData; (void)argc; (void)argv;
    FREObject out = NULL;
    FRENewObjectFromBool(0, &out);
    return out;
}

/* The identity round trip: whatever AS3 boxed, AS3 gets back unchanged. It is
 * the single most sensitive test of "FREObject is as_value*": a tag that does not
 * survive the trip shows up here as a wrong value or a crash. */
static FREObject probe_echo(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData;
    if (argc != 1) return NULL;
    return argv[0];
}

static FREObject probe_argsLength(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData; (void)argv;
    FREObject out = NULL;
    FRENewObjectFromInt32((int32_t)argc, &out);
    return out;
}

static FREObject probe_scaleInt(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData;
    uint32_t a = 0, b = 0;
    if (argc != 2) return NULL;
    if (FREGetObjectAsUint32(argv[0], &a) != FRE_OK) return NULL;
    if (FREGetObjectAsUint32(argv[1], &b) != FRE_OK) return NULL;
    FREObject out = NULL;
    FRENewObjectFromUint32(a * b, &out);
    return out;
}

static FREObject probe_truthy(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData;
    if (argc != 1) return NULL;
    uint32_t t = 0;
    if (FREGetObjectAsBool(argv[0], &t) != FRE_OK) return NULL;
    FREObject out = NULL;
    FRENewObjectFromBool(t, &out);
    return out;
}

static FREObject probe_sumArray(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData;
    if (argc != 1) return NULL;
    uint32_t n = 0;
    if (FREGetArrayLength(argv[0], &n) != FRE_OK) return NULL;
    double total = 0;
    for (uint32_t i = 0; i < n; i++) {
        FREObject e = NULL;
        if (FREGetArrayElementAt(argv[0], i, &e) != FRE_OK) return NULL;
        double v = 0;
        if (FREGetObjectAsDouble(e, &v) != FRE_OK) return NULL;
        total += v;
    }
    FREObject out = NULL;
    FRENewObjectFromDouble(total, &out);
    return out;
}

static FREObject probe_makeArray(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData;
    int32_t n = 0;
    if (argc != 1) return NULL;
    if (FREGetObjectAsInt32(argv[0], &n) != FRE_OK) return NULL;
    FREObject cls = NULL;
    if (FRENewObject((const uint8_t*)"Array", 0, NULL, &cls, NULL) != FRE_OK) return NULL;
    for (int32_t i = 0; i < n; i++) {
        FREObject v = NULL;
        FRENewObjectFromInt32(i * 10, &v);
        if (FRESetArrayElementAt(cls, (uint32_t)i, v) != FRE_OK) return cls;
    }
    return cls;
}

static FREObject probe_byteArray(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData;
    int32_t n = 0;
    if (argc != 1) return NULL;
    if (FREGetObjectAsInt32(argv[0], &n) != FRE_OK) return NULL;
    if (n <= 0) n = 1;
    unsigned char* buf = (unsigned char*)malloc((size_t)n);
    if (buf == NULL) return NULL;
    for (int32_t i = 0; i < n; i++) buf[i] = (unsigned char)(i + 1);
    FREByteArray ba;
    ba.bytes = (uint8_t*)buf;
    ba.length = (uint32_t)n;
    FREObject out = NULL;
    FREResult r = FRENewByteArray(&ba, &out);
    free(buf);
    if (r != FRE_OK) return NULL;
    return out;
}

/* Names the failing step of the AcquireByteArray path, because a bare 0 is
 * indistinguishable from "the bytes happened to be all zero". */
static FREObject probe_baInfo(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData;
    if (argc != 1) return NULL;
    FREByteArray ba;
    ba.bytes = NULL;
    ba.length = 0;
    FREResult r = FREAcquireByteArray(argv[0], &ba);
    char msg[96];
    snprintf(msg, sizeof(msg), "acquire=%d len=%u bytes=%s b0=%u",
             (int)r, (unsigned)ba.length, ba.bytes == NULL ? "null" : "live",
             (ba.bytes != NULL && ba.length > 0) ? (unsigned)ba.bytes[0] : 0u);
    if (r == FRE_OK) FREReleaseByteArray(argv[0]);
    FREObject out = NULL;
    FRENewObjectFromUTF8((uint32_t)strlen(msg) + 1u, (const uint8_t*)msg, &out);
    return out;
}

static FREObject probe_sumBytes(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData;
    if (argc != 1) return NULL;
    FREByteArray ba;
    ba.bytes = NULL;
    ba.length = 0;
    if (FREAcquireByteArray(argv[0], &ba) != FRE_OK) return NULL;
    unsigned long long total = 0;
    for (uint32_t i = 0; i < ba.length; i++) total += ba.bytes[i];
    FREReleaseByteArray(argv[0]);
    FREObject out = NULL;
    FRENewObjectFromInt32((int32_t)total, &out);
    return out;
}

/* FRENewObject reports the actual FREResult, not a guess: the first version of
 * this fixture printed "FRE_NO_SUCH_NAME" for every failure, which hid a real
 * #1063 arity error behind a wrong name. The three outcomes it has to tell
 * apart are "no such class" (1), "the constructor threw" (4) and OK (0). */
static FREObject probe_pointX(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData;
    double x = 0;
    if (argc != 1) return NULL;
    if (FREGetObjectAsDouble(argv[0], &x) != FRE_OK) return NULL;

    FREObject cls = NULL;
    FREObject thrown = NULL;
    if (FRENewObject((const uint8_t*)"flash.geom.Point", 0, NULL, &cls, &thrown) != FRE_OK) return NULL;
    FREObject xv = NULL;
    FRENewObjectFromDouble(x, &xv);
    if (FRESetObjectProperty(cls, (const uint8_t*)"x", xv, &thrown) != FRE_OK) return NULL;
    FREObject got = NULL;
    if (FREGetObjectProperty(cls, (const uint8_t*)"x", &got, &thrown) != FRE_OK) return NULL;
    double back = 0;
    if (FREGetObjectAsDouble(got, &back) != FRE_OK || back != x) return NULL;
    FREObject str = NULL;
    if (FRECallObjectMethod(cls, (const uint8_t*)"toString", 0, NULL, &str, &thrown) != FRE_OK) return NULL;
    return str;
}

/* The FRENewObject result code, as a string, so a failure names itself. */
static FREObject probe_newObjectResult(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData; (void)argc; (void)argv;
    FREObject cls = NULL;
    FREObject thrown = NULL;
    FREResult r = FRENewObject((const uint8_t*)"flash.geom.Point", 0, NULL, &cls, &thrown);
    char msg[64];
    snprintf(msg, sizeof(msg), "newObject=%d", (int)r);
    FREObject out = NULL;
    FRENewObjectFromUTF8((uint32_t)strlen(msg) + 1u, (const uint8_t*)msg, &out);
    return out;
}

/* FRESetObjectProperty through the native side must be visible to AS3 as an
 * ordinary property write on the very object AS3 passed in. */
static FREObject probe_setX(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData;
    if (argc != 2) return NULL;
    double x = 0;
    if (FREGetObjectAsDouble(argv[1], &x) != FRE_OK) return NULL;
    FREObject xv = NULL;
    FRENewObjectFromDouble(x, &xv);
    FREObject thrown = NULL;
    if (FRESetObjectProperty(argv[0], (const uint8_t*)"x", xv, &thrown) != FRE_OK) return NULL;
    FREObject out = NULL;
    FRENewObjectFromBool(1, &out);
    return out;
}

/* FREGet/SetContextNativeData: the extension's own per-context pointer, which
 * every real ANE uses to reach its state from a registered function. */
static FREObject probe_nativeData(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)funcData; (void)argc; (void)argv;
    void* p = NULL;
    if (FREGetContextNativeData(ctx, &p) != FRE_OK) return NULL;
    ProbeExtData* d = (ProbeExtData*)p;
    if (d == NULL) return NULL;
    d->calls++;
    d->dataReady = 1;
    FREObject out = NULL;
    FRENewObjectFromInt32(d->calls, &out);
    return out;
}

/* FREDispatchStatusEventAsync: must come back to AS3 as a StatusEvent on the
 * very ExtensionContext the call was made on. */
static FREObject probe_bumpStatus(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)funcData; (void)argc; (void)argv;
    FREDispatchStatusEventAsync(ctx, (const uint8_t*)"probe-status", (const uint8_t*)"status");
    FREObject out = NULL;
    FRENewObjectFromInt32(1, &out);
    return out;
}

/* FREGetObjectType + FRETrace + the object readers, on one value. */
static FREObject probe_describe(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)funcData;
    if (argc != 1) return NULL;
    FREObjectType t = FRE_TYPE_NULL;
    if (FREGetObjectType(argv[0], &t) != FRE_OK) return NULL;
    const char* name = "?";
    switch (t) {
        case FRE_TYPE_NUMBER:    name = "number"; break;
        case FRE_TYPE_BOOLEAN:   name = "boolean"; break;
        case FRE_TYPE_STRING:    name = "string"; break;
        case FRE_TYPE_OBJECT:    name = "object"; break;
        case FRE_TYPE_ARRAY:     name = "array"; break;
        case FRE_TYPE_VECTOR:    name = "vector"; break;
        case FRE_TYPE_BYTEARRAY: name = "bytearray"; break;
        case FRE_TYPE_NULL:      name = "null"; break;
        case FRE_TYPE_BITMAPDATA: name = "bitmapdata"; break;
        default: break;   // FREObjectType_ENUMPADDING is not a value we can ever see
    }
    char msg[64];
    snprintf(msg, sizeof(msg), "type=%s", name);
    FRETrace(ctx, msg);
    FREObject out = NULL;
    FRENewObjectFromUTF8((uint32_t)strlen(msg) + 1u, (const uint8_t*)msg, &out);
    return out;
}

/* The deferred D face: proves the report reaches AS3 instead of a silent OK. */
static FREObject probe_renderMode(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)funcData; (void)argc; (void)argv;
    FREObject stage = NULL;
    uint8_t mode = 0;
    FREResult r = FREGetRenderMode(ctx, stage, &mode);
    char msg[48];
    snprintf(msg, sizeof(msg), "renderMode=%d", (int)r);
    FREObject out = NULL;
    FRENewObjectFromUTF8((uint32_t)strlen(msg) + 1u, (const uint8_t*)msg, &out);
    return out;
}

/* FRECurrentThread / FRENullThread / FRERecursiveMutex*: the threading family.
 * A mutex created here must be lockable HERE -- that is the reason the family is
 * forwarded through the host table rather than implemented inside asaot.dll. */
static FREObject probe_threading(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData; (void)argc; (void)argv;
    FREMutex m;
    int okInit = (int)FRERecursiveMutexInit(&m);
    int okLock = 0;
    if (okInit) {
        FRERecursiveMutexLock(&m);
        /* Recursive by contract: a second lock from the same thread succeeds. */
        okLock = (int)FRERecursiveMutexTryLock(&m);
        FRERecursiveMutexUnlock(&m);
        FRERecursiveMutexUnlock(&m);
        FRERecursiveMutexDestroy(&m);
    }
    char msg[64];
    snprintf(msg, sizeof(msg), "thread=%d null=%d mutex=%d%d", FRECurrentThread() != FRENullThread(), FRENullThread() == 0, okInit, okLock);
    FREObject out = NULL;
    FRENewObjectFromUTF8((uint32_t)strlen(msg) + 1u, (const uint8_t*)msg, &out);
    return out;
}

/* Two outcomes worth telling apart, because they mean different things to an
 * extension: writing to a primitive is a TYPE mismatch (never an AS3 throw), while
 * writing an undeclared property on a SEALED instance makes AS3 raise
 * ReferenceError #1056, which has to surface as FRE_ACTIONSCRIPT_ERROR plus the
 * thrown object instead of unwinding through this C frame. */
static FREObject probe_throwingSet(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData; (void)argc; (void)argv;
    char msg[128];
    FREObject one = NULL;
    FRENewObjectFromDouble(1.0, &one);
    FREObject thrown = NULL;
    FREResult prim = FRESetObjectProperty(one, (const uint8_t*)"noSuchPropertyOnANumber", one, &thrown);

    FREObject pt = NULL;
    thrown = NULL;
    FREObject st = NULL;
    if (FRENewObject((const uint8_t*)"flash.geom.Point", 0, NULL, &pt, &st) != FRE_OK) {
        snprintf(msg, sizeof(msg), "prim=%d sealed=no-point", (int)prim);
    } else {
        thrown = NULL;
        FREResult sealed = FRESetObjectProperty(pt, (const uint8_t*)"noSuchPropertyOnPoint", one, &thrown);
        snprintf(msg, sizeof(msg), "prim=%d sealed=%d thrown=%s", (int)prim, (int)sealed,
                 thrown != NULL ? "yes" : "no");
    }
    FREObject out = NULL;
    FRENewObjectFromUTF8((uint32_t)strlen(msg) + 1u, (const uint8_t*)msg, &out);
    return out;
}

/* The FRE string length contract, made observable from AS3.
 *
 * The AIR SDK header documents FREGetObjectAsUTF8's length as "the size, in
 * bytes, of the string. Includes the null terminator" -- but AIR does not count
 * it (measured against adl; the evidence and the A/B rig are recorded in
 * docs/zh-cn/ane.md 5.1). The one-byte difference is not cosmetic: an extension
 * that CARRIES the length, exactly like the ANEUtils::getString idiom
 * `std::string(val, val + length)`, gets a NUL appended to every string it reads,
 * and a protocol that embeds the string verbatim in a frame (a WebSocket URL in
 * an HTTP request line) then sends a malformed message and the peer closes with
 * no reply. Extensions that only hand the pointer to printf/strcmp never notice.
 *
 * Reporting both counts side by side is what lets AS3 assert the contract
 * (driver.as) instead of trusting it: `extra` must be 0, and it is not 0 for a
 * build that counts the terminator or that counts UTF-16 units instead of bytes. */
static FREObject probe_stringInfo(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData;
    char msg[96];
    uint32_t len = 0;
    const uint8_t* val = NULL;
    if (argc < 1) {
        snprintf(msg, sizeof(msg), "no-argument");
    } else {
        FREResult r = FREGetObjectAsUTF8(argv[0], &len, &val);
        if (r != FRE_OK || val == NULL) {
            snprintf(msg, sizeof(msg), "fre-error=%d", (int)r);
        } else {
            /* bytes = the string's own length in UTF-8 bytes. The buffer is
             * NUL-terminated either way, so strlen is readable and is the count a
             * C string consumer sees; whatever `len` adds to it is the defect. */
            uint32_t bytes = (uint32_t)strlen((const char*)val);
            snprintf(msg, sizeof(msg), "bytes=%u len=%u extra=%d",
                     (unsigned)bytes, (unsigned)len, (int)len - (int)bytes);
        }
    }
    FREObject out = NULL;
    FRENewObjectFromUTF8((uint32_t)strlen(msg) + 1u, (const uint8_t*)msg, &out);
    return out;
}

/* FREAcquire|ReleaseNativeWindowHandle -- the ONE D-face pair that is implemented.
 * A non-null pointer is not evidence (a fabricated one passes that), so what gets
 * asserted is that the handle describes THIS process's window: on Windows
 * IsWindow() must accept it and GetWindowThreadProcessId() must name this process,
 * and on both platforms two acquires of the same NativeWindow must answer the same
 * object -- a recycled or mixed-up window slot answers two different ones.
 *
 * A wrong operand must come back as a FREResult, not as a crash: a Point is
 * FRE_TYPE_MISMATCH (3) and AS3 null is FRE_INVALID_OBJECT (2). */
static FREObject probe_nativeWindowHandle(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData;
    FRENativeWindow h1 = (FRENativeWindow)0;
    FRENativeWindow h2 = (FRENativeWindow)0;
    FREResult r1 = FRE_INVALID_ARGUMENT;
    FREResult r2 = FRE_INVALID_ARGUMENT;
    FREResult rr = FRE_INVALID_ARGUMENT;
    if (argc > 0) {
        r1 = FREAcquireNativeWindowHandle(argv[0], &h1);
        r2 = FREAcquireNativeWindowHandle(argv[0], &h2);
        rr = FREReleaseNativeWindowHandle(argv[0]);
    }
    int live = 0;
    int proc = 0;
    int stable = (r1 == FRE_OK && r2 == FRE_OK && h1 == h2 && h1 != (FRENativeWindow)0) ? 1 : 0;
#if defined(_WIN32)
    HWND hw = (HWND)h1;
    if (hw != NULL && IsWindow(hw)) {
        live = 1;
        DWORD pid = 0;
        GetWindowThreadProcessId(hw, &pid);
        proc = (pid == GetCurrentProcessId()) ? 1 : 0;
    }
#else
    /* No IsWindow() equivalent is reachable from plain C on the other platform, so
     * "live" is the handle being non-null there; "stable" carries the real check. */
    live = (h1 != (FRENativeWindow)0) ? 1 : 0;
    proc = live;
#endif
    char msg[96];
    snprintf(msg, sizeof(msg), "acquire=%d release=%d live=%d sameProcess=%d stable=%d",
             (int)r1, (int)rr, live, proc, stable);
    FREObject out = NULL;
    FRENewObjectFromUTF8((uint32_t)strlen(msg) + 1u, (const uint8_t*)msg, &out);
    return out;
}

/* FREAcquire|Invalidate|ReleaseBitmapData -- the pixel handoff a video ANE is built
 * around (ANEQcloudLive's ANEVideoRander::getVideoBitmapData is acquire, memcpy into
 * bits32, release, and nothing else).
 *
 * The extension writes through the pointer the HOST hands it, which is the whole
 * contract, so filling every row of the surface is the assertion: a descriptor with
 * a wrong stride, a wrong height or a pointer into a COPY leaves part of the bitmap
 * unwritten and the AS3-side readback below shows it.
 *
 * Both descriptor versions are acquired on the same object, because they differ in
 * the middle (v2 inserts isInvertedY before bits32) and a host that filled them with
 * one memcpy would put the pointer where a v1 client reads stride -- `same` reports
 * whether both agree on the buffer, and the driver asserts the whole string. */
static FREObject probe_writeBitmapData(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData;
    if (argc != 2) return NULL;
    uint32_t argb = 0xFF00FF00u;
    if (FREGetObjectAsUint32(argv[1], &argb) != FRE_OK) return NULL;
    FREBitmapData b1;
    FREBitmapData2 b2;
    memset(&b1, 0, sizeof(b1));
    memset(&b2, 0, sizeof(b2));
    FREResult r1 = FREAcquireBitmapData(argv[0], &b1);
    FREResult r2 = FREAcquireBitmapData2(argv[0], &b2);
    int same = 0;
    FREResult ri = FRE_ILLEGAL_STATE;
    FREResult rr = FRE_ILLEGAL_STATE;
    if (r1 == FRE_OK && r2 == FRE_OK && b1.bits32 != NULL && b1.width > 0 && b1.height > 0) {
        same = (b1.bits32 == b2.bits32 && b1.lineStride32 == b2.lineStride32) ? 1 : 0;
        uint32_t stride = b1.lineStride32;
        for (uint32_t y = 0; y < b1.height; y++) {
            uint32_t* row = b1.bits32 + (size_t)y * stride;
            for (uint32_t x = 0; x < b1.width; x++) row[x] = argb;
        }
        ri = FREInvalidateBitmapDataRect(argv[0], 0, 0, b1.width, b1.height);
        rr = FREReleaseBitmapData(argv[0]);
    }
    char msg[160];
    snprintf(msg, sizeof(msg),
             "acq=%d acq2=%d w=%u h=%u stride=%u alpha=%u premul=%u inverted=%u same=%d inv=%d rel=%d",
             (int)r1, (int)r2, (unsigned)b1.width, (unsigned)b1.height,
             (unsigned)b1.lineStride32, (unsigned)b1.hasAlpha,
             (unsigned)b1.isPremultiplied, (unsigned)b2.isInvertedY,
             same, (int)ri, (int)rr);
    FREObject out = NULL;
    FRENewObjectFromUTF8((uint32_t)strlen(msg) + 1u, (const uint8_t*)msg, &out);
    return out;
}

/* The failure half, reported as the FREResult each entry point answers -- never as
 * a crash and never as a fabricated success. A Point is FRE_TYPE_MISMATCH (3); AS3
 * null is FRE_INVALID_OBJECT (2); a disposed BitmapData is 2 as well, because it is
 * still a BitmapData that simply has no pixels left; and a NULL out-pointer is
 * FRE_INVALID_ARGUMENT (5) whatever the object is. */
static FREObject probe_bitmapDataErrors(FREContext ctx, void* funcData, uint32_t argc, FREObject argv[]) {
    (void)ctx; (void)funcData;
    if (argc != 1) return NULL;
    FREBitmapData b;
    FREBitmapData2 b2;
    memset(&b, 0, sizeof(b));
    memset(&b2, 0, sizeof(b2));
    FREResult acq = FREAcquireBitmapData(argv[0], &b);
    FREResult acq2 = FREAcquireBitmapData2(argv[0], &b2);
    FREResult acqNull = FREAcquireBitmapData(argv[0], NULL);
    FREResult acq2Null = FREAcquireBitmapData2(argv[0], NULL);
    FREResult inv = FREInvalidateBitmapDataRect(argv[0], 0, 0, 1, 1);
    FREResult rel = FREReleaseBitmapData(argv[0]);
    char msg[128];
    snprintf(msg, sizeof(msg), "acq=%d acq2=%d acqnull=%d acq2null=%d inv=%d rel=%d",
             (int)acq, (int)acq2, (int)acqNull, (int)acq2Null, (int)inv, (int)rel);
    FREObject out = NULL;
    FRENewObjectFromUTF8((uint32_t)strlen(msg) + 1u, (const uint8_t*)msg, &out);
    return out;
}

static FRENamedFunction probe_functions[] = {
    { (const uint8_t*)"ping",           NULL, probe_ping },
    { (const uint8_t*)"addInt",         NULL, probe_addInt },
    { (const uint8_t*)"scale",          NULL, probe_scale },
    { (const uint8_t*)"scaleUint",      NULL, probe_scaleInt },
    { (const uint8_t*)"isDebug",        NULL, probe_isDebug },
    { (const uint8_t*)"echo",           NULL, probe_echo },
    { (const uint8_t*)"argsLength",     NULL, probe_argsLength },
    { (const uint8_t*)"truthy",         NULL, probe_truthy },
    { (const uint8_t*)"sumArray",       NULL, probe_sumArray },
    { (const uint8_t*)"makeArray",      NULL, probe_makeArray },
    { (const uint8_t*)"makeByteArray",  NULL, probe_byteArray },
    { (const uint8_t*)"sumBytes",       NULL, probe_sumBytes },
    { (const uint8_t*)"baInfo",         NULL, probe_baInfo },
    { (const uint8_t*)"pointX",         NULL, probe_pointX },
    { (const uint8_t*)"newObjectResult", NULL, probe_newObjectResult },
    { (const uint8_t*)"setX",           NULL, probe_setX },
    { (const uint8_t*)"nativeData",     NULL, probe_nativeData },
    { (const uint8_t*)"bumpStatus",     NULL, probe_bumpStatus },
    { (const uint8_t*)"describe",       NULL, probe_describe },
    { (const uint8_t*)"renderMode",     NULL, probe_renderMode },
    { (const uint8_t*)"threading",      NULL, probe_threading },
    { (const uint8_t*)"throwingSet",    NULL, probe_throwingSet },
    { (const uint8_t*)"stringInfo",     NULL, probe_stringInfo },
    { (const uint8_t*)"nativeWindowHandle", NULL, probe_nativeWindowHandle },
    { (const uint8_t*)"writeBitmapData", NULL, probe_writeBitmapData },
    { (const uint8_t*)"bitmapDataErrors", NULL, probe_bitmapDataErrors },
};

/* ---- the AIR protocol ----------------------------------------------------- */

static void probe_ctx_initializer(void* extData, const uint8_t* ctxType, FREContext ctx,
                                  uint32_t* numFunctionsToSet, const FRENamedFunction** functionsToSet) {
    (void)ctxType;
    ProbeExtData* d = (ProbeExtData*)extData;
    /* AIR's ContextInitializer is where an extension hands its own state to the
     * runtime, and probe_nativeData reads it back through
     * FREGetContextNativeData. Not calling this is the classic ANE bug that
     * makes every registered function see a NULL context. */
    FRESetContextNativeData(ctx, extData);
    if (d != NULL) d->dataReady = 1;
    *numFunctionsToSet = sizeof(probe_functions) / sizeof(probe_functions[0]);
    *functionsToSet = probe_functions;
}

static void probe_ctx_finalizer(FREContext ctx) {
    void* p = NULL;
    if (FREGetContextNativeData(ctx, &p) == FRE_OK) {
        ProbeExtData* d = (ProbeExtData*)p;
        if (d != NULL) d->dataReady = 0;
    }
}

PROBE_EXPORT void ProbeExtInitializer(void** extDataToSet, FREContextInitializer* ctxInitializerToSet,
                                     FREContextFinalizer* ctxFinalizerToSet) {
    ProbeExtData* d = (ProbeExtData*)calloc(1, sizeof(ProbeExtData));
    *extDataToSet = d;
    *ctxInitializerToSet = probe_ctx_initializer;
    *ctxFinalizerToSet = probe_ctx_finalizer;
}

PROBE_EXPORT void ProbeExtFinalizer(void* extData) {
    free(extData);
}
