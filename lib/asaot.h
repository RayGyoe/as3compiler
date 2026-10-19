/*
 * asaot.h -- the FRE (Flash Runtime Extension) host ABI implemented by
 * as3compiler's AOT runtime.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * An AIR native extension is an ordinary dynamic library whose native half
 * calls back into the runtime through the FRE entry points (FREGetObjectAsInt32,
 * FRENewObjectFromUTF8, FREDispatchStatusEventAsync, ...). Under AIR those
 * symbols live in the AIR runtime itself, so every ANE .dll records a static
 * import against the module name "Adobe AIR.dll" / "Adobe AIR.framework" /
 * the iOS static AIR lib.
 *
 * An AOT build has no AIR. The chosen loading route (documented in
 * as3compiler/docs/zh-cn/ane.md, section 4) is "dual artifacts +
 * recompile-and-rename": the ORIGINAL ANE keeps running under
 * `adl` untouched, and a SECOND copy is produced by recompiling the ANE's own
 * native sources against THIS header and an import library whose module name is
 * `asaot` instead of `Adobe AIR`. That second copy is what the AOT build loads,
 * so no ANE binary is ever patched and no runtime symbol-table hack (PE import
 * mapper / PEB name registration) is needed.
 *
 * ABI CONTRACT (do not "improve" any of it)
 * -----------------------------------------
 * This header must stay byte-for-byte interchangeable with the AIR SDK's
 * FlashRuntimeExtensions.h, because the SAME ANE sources are compiled twice --
 * once against the SDK header (for adl) and once against this one (for AOT):
 *
 *   * struct layouts and field order (FREBitmapData, FREBitmapData2,
 *     FREByteArray, FRENamedFunction) -- identical;
 *   * enum VALUES (FREResult, FREObjectType, FRERenderMode) -- identical,
 *     including the 0xfffff ENUMPADDING sentinels that force a 4-byte enum on
 *     both C and C++;
 *   * typedef targets (FREContext / FREObject are void*, FREFunction /
 *     FREContextInitializer / ... are the same function-pointer shapes);
 *   * the signatures of all FRE entry points.
 *
 * Anything added for AOT convenience lives at the BOTTOM of this file, after
 * the SDK-identical half, so that a reader can see exactly where the SDK ABI
 * ends and our extension begins.
 *
 * HOW THE CALLS ARE SERVED
 * ------------------------
 * `asaot` is a thin FORWARDER, not a second runtime. The 51 FRE entry points
 * exported by asaot.dll hold no state of their own; they dispatch through a
 * table of function pointers that the generated AOT executable installs once at
 * startup with asaot_bind(). All AS3 semantics (boxed values, the GC heap,
 * string/array/BitmapData access, property reflection) live in the generated
 * executable, which is the only place they CAN live -- the ANE's own copy of
 * the runtime would have a separate heap and separate class registry.
 *
 * Lifecycle, end to end:
 *
 *   exe  --LoadLibrary("asaot.dll") + GetProcAddress("asaot_bind")
 *        --> asaot_bind(&host)                 (once, before any ANE loads)
 *   exe  --LoadLibrary("ANEXxx.dll")           (the recompiled ANE; its import
 *                                               table names asaot.dll, which is
 *                                               already resident, so the loader
 *                                               binds it to this same module)
 *   exe  --GetProcAddress("ANEXxxExtInitializer") --> FREInitializer(...)
 *   exe  --ctxInitializer(extData, ctxType, ctx, &n, &funcs)
 *   ANE  --FREGetObjectAsInt32(argv[0], &v)  --> asaot.dll --> exe's host table
 */

#ifndef ASAOT_H_
#define ASAOT_H_

/* ------------------------------------------------------------------------- *
 * SDK-identical half -- types
 * ------------------------------------------------------------------------- */

#ifdef _WIN32
  /* HWND / CRITICAL_SECTION / DWORD / LPTHREAD_START_ROUTINE are Windows
   * types that the SDK header assumes the includer has already declared (it
   * simply writes `typedef HWND FRENativeWindow;`). Pulling windows.h in
   * ourselves keeps asaot.h self-sufficient, which matters because a recompiled
   * ANE may include this header first. `_WINDEF_` is windef.h's guard, so the
   * include happens only when the type is genuinely undeclared. */
  #if !defined(_WINDEF_)
    #define WIN32_LEAN_AND_MEAN
    #include <windows.h>
  #endif
#endif

#include <stdint.h>

/* Export/import decoration. ASAOT_BUILD is defined only when compiling
 * asaot_host.c itself; every consumer (a recompiled ANE, or the generated
 * executable) sees dllimport, which is what makes the recompiled ANE's import
 * table name `asaot.dll` instead of `Adobe AIR.dll`. It is applied to the FRE
 * declarations themselves -- not to the definitions only -- so that a
 * translation unit in this DLL sees ONE consistent declaration.
 *
 * Note this is the one place where asaot.h deliberately says something the SDK
 * header does not: the SDK's FRE symbols come from the runtime the executable
 * already links, so they need no decoration there.
 *
 * ASAOT_HOST is the third mode: the generated executable DEFINES all 51 entry
 * points (it is the host, see fre.ts), so it must see them undecorated. Without
 * it the exe's own definitions are second declarations of dllimport symbols and
 * clang warns "'FREGetObjectAsInt32' redeclared without 'dllimport' attribute"
 * once per entry point. */
#if defined(_WIN32)
  #if defined(ASAOT_BUILD)
    #define ASAOT_API __declspec(dllexport)
  #elif defined(ASAOT_HOST)
    #define ASAOT_API
  #else
    #define ASAOT_API __declspec(dllimport)
  #endif
#else
  #define ASAOT_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef void *FREContext;
typedef void *FREObject;

/* Initialization ***********************************************************/

typedef FREObject (*FREFunction)(
        FREContext ctx,
        void*      functionData,
        uint32_t   argc,
        FREObject  argv[]
);

typedef struct FRENamedFunction_ {
    const uint8_t* name;
    void*          functionData;
    FREFunction    function;
} FRENamedFunction;

typedef void (*FREContextInitializer)(
        void*                    extData          ,
        const uint8_t*           ctxType          ,
        FREContext               ctx              ,
        uint32_t*                numFunctionsToSet,
        const FRENamedFunction** functionsToSet
);

typedef void (*FREContextFinalizer)(FREContext ctx);

typedef void (*FREInitializer)(
        void**                 extDataToSet       ,
        FREContextInitializer* ctxInitializerToSet,
        FREContextFinalizer*   ctxFinalizerToSet
);

typedef void (*FREFinalizer)(void* extData);

/* Result codes (values fixed by the SDK) ***********************************/

typedef enum {
    FRE_OK                  = 0,
    FRE_NO_SUCH_NAME        = 1,
    FRE_INVALID_OBJECT      = 2,
    FRE_TYPE_MISMATCH       = 3,
    FRE_ACTIONSCRIPT_ERROR  = 4,
    FRE_INVALID_ARGUMENT    = 5,
    FRE_READ_ONLY           = 6,
    FRE_WRONG_THREAD        = 7,
    FRE_ILLEGAL_STATE       = 8,
    FRE_INSUFFICIENT_MEMORY = 9,
    FREResult_ENUMPADDING   = 0xfffff
} FREResult;

/* Primitive type tags (values fixed by the SDK) ****************************/

typedef enum {
    FRE_TYPE_OBJECT           = 0,
    FRE_TYPE_NUMBER           = 1,
    FRE_TYPE_STRING           = 2,
    FRE_TYPE_BYTEARRAY        = 3,
    FRE_TYPE_ARRAY            = 4,
    FRE_TYPE_VECTOR           = 5,
    FRE_TYPE_BITMAPDATA       = 6,
    FRE_TYPE_BOOLEAN          = 7,
    FRE_TYPE_NULL             = 8,
    FREObjectType_ENUMPADDING = 0xfffff
} FREObjectType;

typedef enum {
    FRE_RENDERMODE_UNKNOWN = 0,
    FRE_RENDERMODE_NONE,
    FRE_RENDERMODE_CPU,
    FRE_RENDERMODE_DIRECT_OGLES,
    FRE_RENDERMODE_DIRECT_OGL,
    FRE_RENDERMODE_DIRECT_D3D9,
    FRE_RENDERMODE_DIRECT_D3D10,
    FRE_RENDERMODE_DIRECT_D3D11,
    FRE_RENDERMODE_SOFTWARE_GDI,
    FRE_RENDERMODE_GPU_OGLES,
    FRE_RENDERMODE_ENUMPADDING = 0xfffff
} FRERenderMode;

/* BitmapData descriptors ***************************************************/

typedef struct {
    uint32_t  width;
    uint32_t  height;
    uint32_t  hasAlpha;
    uint32_t  isPremultiplied;
    uint32_t  lineStride32;
    uint32_t* bits32;
} FREBitmapData;

typedef struct {
    uint32_t  width;
    uint32_t  height;
    uint32_t  hasAlpha;
    uint32_t  isPremultiplied;
    uint32_t  lineStride32;
    uint32_t  isInvertedY;
    uint32_t* bits32;
} FREBitmapData2;

/* ByteArray descriptor ******************************************************/

typedef struct {
    uint32_t length;
    uint8_t* bytes;
} FREByteArray;

/* Native window handle ******************************************************/
/* Same per-platform selection as the SDK. On Windows this is HWND (declared by
 * the windows.h include above); everywhere else a void* stands in for the
 * platform window object. */

#if defined(_WIN32)
  typedef HWND FRENativeWindow;
#elif defined(__APPLE__)
  #if (defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE) || (defined(TARGET_OS_SIMULATOR) && TARGET_OS_SIMULATOR)
  typedef void* FRENativeWindow;
  #else
  typedef void* FRENativeWindow;   /* NSWindow*; kept untyped so this header
                                      needs no Objective-C frameworks. */
  #endif
#elif defined(__linux__) && !defined(ANDROID)
  #ifndef GTK_TYPE_WINDOW
    typedef struct { int if_using_FRENativeWindow_please_include_gtk_headers_before_this_one; } GtkWindow;
  #endif
  typedef GtkWindow* FRENativeWindow;
#else
  typedef void* FRENativeWindow;
#endif

/* Threading types ***********************************************************/

#if defined(_WIN32)
  typedef DWORD                  FREThread;
  typedef CRITICAL_SECTION       FREMutex;
  typedef LPVOID                 FREThreadArg;
  typedef DWORD                  FREThreadReturn;
  typedef LPTHREAD_START_ROUTINE FREThreadFunction;
#else
  #include <pthread.h>
  typedef pthread_t              FREThread;
  typedef pthread_mutex_t        FREMutex;
  typedef void*                  FREThreadArg;
  typedef void*                  FREThreadReturn;
  typedef FREThreadReturn      (*FREThreadFunction)(FREThreadArg);
#endif

/* ------------------------------------------------------------------------- *
 * SDK-identical half -- the 51 FRE entry points
 * ------------------------------------------------------------------------- */

/* Context data (4) */
ASAOT_API FREResult FREGetContextNativeData(FREContext ctx, void** nativeData);
ASAOT_API FREResult FRESetContextNativeData(FREContext ctx, void*  nativeData);
ASAOT_API FREResult FREGetContextActionScriptData(FREContext ctx, FREObject *actionScriptData);
ASAOT_API FREResult FRESetContextActionScriptData(FREContext ctx, FREObject  actionScriptData);

/* Object type + primitive readers (5) */
ASAOT_API FREResult FREGetObjectType(FREObject object, FREObjectType *objectType);
ASAOT_API FREResult FREGetObjectAsInt32 (FREObject object, int32_t  *value);
ASAOT_API FREResult FREGetObjectAsUint32(FREObject object, uint32_t *value);
ASAOT_API FREResult FREGetObjectAsDouble(FREObject object, double   *value);
ASAOT_API FREResult FREGetObjectAsBool  (FREObject object, uint32_t *value);

/* Primitive creators (4) */
ASAOT_API FREResult FRENewObjectFromInt32 (int32_t  value, FREObject *object);
ASAOT_API FREResult FRENewObjectFromUint32(uint32_t value, FREObject *object);
ASAOT_API FREResult FRENewObjectFromDouble(double   value, FREObject *object);
ASAOT_API FREResult FRENewObjectFromBool  (uint32_t value, FREObject *object);

/* String (2) */
ASAOT_API FREResult FREGetObjectAsUTF8(FREObject object, uint32_t* length, const uint8_t** value);
ASAOT_API FREResult FRENewObjectFromUTF8(uint32_t length, const uint8_t* value, FREObject* object);

/* Utility (1) */
ASAOT_API FREResult FRETrace(FREContext ctx, const char* strTrace);

/* Render pipeline (4) -- see the deferred-API note in the appendix. */
ASAOT_API FREResult FREGetRenderMode(FREContext ctx, FREObject stage, uint8_t* pRenderMode);
ASAOT_API FREResult FRESetRenderSource(FREContext ctx, FREObject source, FREObject target);
ASAOT_API FREResult FREMediaBufferLock(FREContext ctx, FREObject mediaBuffer, uint8_t** pData, uint32_t* pWidth, uint32_t* pHeight, uint32_t* pStride, uint32_t* pFormat);
ASAOT_API FREResult FREMediaBufferUnlock(FREContext ctx, FREObject mediaBuffer, uint32_t bUpdate);

/* Object access (4) */
ASAOT_API FREResult FRENewObject(const uint8_t* className, uint32_t argc, FREObject argv[], FREObject* object, FREObject* thrownException);
ASAOT_API FREResult FREGetObjectProperty(FREObject object, const uint8_t* propertyName, FREObject* propertyValue, FREObject* thrownException);
ASAOT_API FREResult FRESetObjectProperty(FREObject object, const uint8_t* propertyName, FREObject propertyValue, FREObject* thrownException);
ASAOT_API FREResult FRECallObjectMethod(FREObject object, const uint8_t* methodName, uint32_t argc, FREObject argv[], FREObject* result, FREObject* thrownException);

/* BitmapData access (4) */
ASAOT_API FREResult FREAcquireBitmapData(FREObject object, FREBitmapData* descriptorToSet);
ASAOT_API FREResult FREAcquireBitmapData2(FREObject object, FREBitmapData2* descriptorToSet);
ASAOT_API FREResult FREInvalidateBitmapDataRect(FREObject object, uint32_t x, uint32_t y, uint32_t width, uint32_t height);
ASAOT_API FREResult FREReleaseBitmapData(FREObject object);

/* ByteArray access (3) */
ASAOT_API FREResult FRENewByteArray(FREByteArray* byteArrayData, FREObject *handle);
ASAOT_API FREResult FREAcquireByteArray(FREObject object, FREByteArray* byteArrayToSet);
ASAOT_API FREResult FREReleaseByteArray(FREObject object);

/* Array and Vector access (4) */
ASAOT_API FREResult FREGetArrayLength(FREObject arrayOrVector, uint32_t* length);
ASAOT_API FREResult FRESetArrayLength(FREObject arrayOrVector, uint32_t length);
ASAOT_API FREResult FREGetArrayElementAt(FREObject arrayOrVector, uint32_t index, FREObject* value);
ASAOT_API FREResult FRESetArrayElementAt(FREObject arrayOrVector, uint32_t index, FREObject value);

/* NativeWindow access (2) */
ASAOT_API FREResult FREAcquireNativeWindowHandle(FREObject nativeWindow, FRENativeWindow* handle);
ASAOT_API FREResult FREReleaseNativeWindowHandle(FREObject nativeWindow);

/* Context3D native handle (1) */
ASAOT_API FREResult FREGetNativeContext3DHandle(FREObject context3D, void** handle);

/* ExtensionContext <-> FREContext (1) */
ASAOT_API FREResult FREGetFREContextFromExtensionContext(FREObject objExtensionContext, FREContext* pContext);

/* Threading (11) */
ASAOT_API FREThread FRECurrentThread(void);
ASAOT_API FREThread FRENullThread(void);
ASAOT_API uint32_t  FREThreadCreate(FREThread* thread, FREThreadFunction start_fn, FREThreadArg arg);
ASAOT_API uint32_t  FREThreadDetach(FREThread thread);
ASAOT_API void      FREThreadSleep(int32_t timeout_millis);
ASAOT_API void      FREThreadJoin(FREThread thread);
ASAOT_API uint32_t  FRERecursiveMutexInit(FREMutex* mutex);
ASAOT_API uint32_t  FRERecursiveMutexDestroy(FREMutex* mutex);
ASAOT_API void      FRERecursiveMutexLock(FREMutex* mutex);
ASAOT_API uint32_t  FRERecursiveMutexTryLock(FREMutex* mutex);
ASAOT_API void      FRERecursiveMutexUnlock(FREMutex* mutex);

/* Callbacks (1) */
ASAOT_API FREResult FREDispatchStatusEventAsync(FREContext ctx, const uint8_t* code, const uint8_t* level);

/* ------------------------------------------------------------------------- *
 * AOT extension -- everything below this line is NOT part of the SDK ABI
 * ------------------------------------------------------------------------- */

#define ASAOT_ABI_VERSION 1

/*
 * The host table. One slot per FRE entry point, in the order the declarations
 * appear above, plus two lifecycle slots the forwarder needs in order to be a
 * pure pass-through without owning any memory:
 *
 *   alloc / free  -- the arena the forwarder uses for the few buffers that must
 *                    outlive an individual forwarding call (currently none; the
 *                    slots exist so the DLL never falls back to malloc'ing
 *                    through a different CRT than the executable's).
 *   report        -- the executable's as_shell_unsupported(), so a stub the DLL
 *                    answers for a deferred API is reported on the same stderr
 *                    channel, and in the same "[as3-aot] ..." format, as every
 *                    other unimplemented-API report.
 */
typedef struct AsaotHost_ {
    uint32_t abi_version;

    void* (*alloc)(uint32_t size);
    void  (*release)(void* p);
    void  (*report)(const char* what);

    FREResult (*FREGetContextNativeData)(FREContext, void**);
    FREResult (*FRESetContextNativeData)(FREContext, void*);
    FREResult (*FREGetContextActionScriptData)(FREContext, FREObject*);
    FREResult (*FRESetContextActionScriptData)(FREContext, FREObject);

    FREResult (*FREGetObjectType)(FREObject, FREObjectType*);
    FREResult (*FREGetObjectAsInt32)(FREObject, int32_t*);
    FREResult (*FREGetObjectAsUint32)(FREObject, uint32_t*);
    FREResult (*FREGetObjectAsDouble)(FREObject, double*);
    FREResult (*FREGetObjectAsBool)(FREObject, uint32_t*);

    FREResult (*FRENewObjectFromInt32)(int32_t, FREObject*);
    FREResult (*FRENewObjectFromUint32)(uint32_t, FREObject*);
    FREResult (*FRENewObjectFromDouble)(double, FREObject*);
    FREResult (*FRENewObjectFromBool)(uint32_t, FREObject*);

    FREResult (*FREGetObjectAsUTF8)(FREObject, uint32_t*, const uint8_t**);
    FREResult (*FRENewObjectFromUTF8)(uint32_t, const uint8_t*, FREObject*);

    FREResult (*FRETrace)(FREContext, const char*);

    FREResult (*FREGetRenderMode)(FREContext, FREObject, uint8_t*);
    FREResult (*FRESetRenderSource)(FREContext, FREObject, FREObject);
    FREResult (*FREMediaBufferLock)(FREContext, FREObject, uint8_t**, uint32_t*, uint32_t*, uint32_t*, uint32_t*);
    FREResult (*FREMediaBufferUnlock)(FREContext, FREObject, uint32_t);

    FREResult (*FRENewObject)(const uint8_t*, uint32_t, FREObject[], FREObject*, FREObject*);
    FREResult (*FREGetObjectProperty)(FREObject, const uint8_t*, FREObject*, FREObject*);
    FREResult (*FRESetObjectProperty)(FREObject, const uint8_t*, FREObject, FREObject*);
    FREResult (*FRECallObjectMethod)(FREObject, const uint8_t*, uint32_t, FREObject[], FREObject*, FREObject*);

    FREResult (*FREAcquireBitmapData)(FREObject, FREBitmapData*);
    FREResult (*FREAcquireBitmapData2)(FREObject, FREBitmapData2*);
    FREResult (*FREInvalidateBitmapDataRect)(FREObject, uint32_t, uint32_t, uint32_t, uint32_t);
    FREResult (*FREReleaseBitmapData)(FREObject);

    FREResult (*FRENewByteArray)(FREByteArray*, FREObject*);
    FREResult (*FREAcquireByteArray)(FREObject, FREByteArray*);
    FREResult (*FREReleaseByteArray)(FREObject);

    FREResult (*FREGetArrayLength)(FREObject, uint32_t*);
    FREResult (*FRESetArrayLength)(FREObject, uint32_t);
    FREResult (*FREGetArrayElementAt)(FREObject, uint32_t, FREObject*);
    FREResult (*FRESetArrayElementAt)(FREObject, uint32_t, FREObject);

    FREResult (*FREAcquireNativeWindowHandle)(FREObject, FRENativeWindow*);
    FREResult (*FREReleaseNativeWindowHandle)(FREObject);

    FREResult (*FREGetNativeContext3DHandle)(FREObject, void**);

    FREResult (*FREGetFREContextFromExtensionContext)(FREObject, FREContext*);

    FREThread (*FRECurrentThread)(void);
    FREThread (*FRENullThread)(void);
    uint32_t  (*FREThreadCreate)(FREThread*, FREThreadFunction, FREThreadArg);
    uint32_t  (*FREThreadDetach)(FREThread);
    void      (*FREThreadSleep)(int32_t);
    void      (*FREThreadJoin)(FREThread);
    uint32_t  (*FRERecursiveMutexInit)(FREMutex*);
    uint32_t  (*FRERecursiveMutexDestroy)(FREMutex*);
    void      (*FRERecursiveMutexLock)(FREMutex*);
    uint32_t  (*FRERecursiveMutexTryLock)(FREMutex*);
    void      (*FRERecursiveMutexUnlock)(FREMutex*);

    FREResult (*FREDispatchStatusEventAsync)(FREContext, const uint8_t*, const uint8_t*);
} AsaotHost;

/*
 * Install the host table. Called exactly once by the generated executable,
 * before any extension library is loaded. Returns 0 on success, non-zero when
 * the table's abi_version does not match this build (in which case every FRE
 * call keeps answering FRE_ILLEGAL_STATE -- a loud, checkable failure rather
 * than a jump through a mismatched pointer).
 */
ASAOT_API int asaot_bind(const AsaotHost* host);

/* True once asaot_bind has accepted a table. Exposed so a caller can tell
 * "the runtime is installed" from "LoadLibrary found the wrong asaot.dll". */
ASAOT_API int asaot_is_bound(void);

#ifdef __cplusplus
}
#endif

#endif /* ASAOT_H_ */
