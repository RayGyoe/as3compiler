/*
 * asaot_host.c -- the forwarding half of the FRE host.
 *
 * This translation unit owns no AS3 state. Every FRE entry point below is a
 * one-line pass-through into the AsaotHost table the generated AOT executable
 * installs with asaot_bind(); the table's slots are the executable's own
 * implementations, which sit next to the boxed-value representation, the GC heap
 * and the class registry they operate on.
 *
 * The forwarding is deliberate rather than a limitation. The alternative --
 * implementing FRE here -- would give the extension a second, disjoint copy of
 * the object model: strings allocated in this module's CRT heap could not be
 * returned to the executable's GC, and a FREObject produced by
 * FRENewObjectFromInt32 could not be read by the executable's own
 * ExtensionContext.call path. One heap, one registry, one place that knows what
 * an as_value is -- that is the whole point of routing through the table.
 *
 * Build (Windows x64, clang/LLD, no MSVC toolset required):
 *   clang --target=x86_64-pc-windows-msvc -fms-runtime-lib=static -O2 -shared \
 *         -DASAOT_BUILD -I. asaot_host.c -o asaot.dll -Wl,/IMPLIB:asaot.lib
 * The linker derives the import library's module name from /OUT:, so asaot.lib
 * records `asaot.dll` -- which is exactly what a recompiled ANE must import in
 * place of `Adobe AIR.dll`. See lib/build-asaot.bat.
 */

#define ASAOT_BUILD 1
#include "asaot.h"

#include <stddef.h>

/* The installed host table. Zero-filled until asaot_bind runs, which is how the
 * forwarders below detect that they were called with no runtime behind them. */
static AsaotHost g_host;
static int       g_bound = 0;

ASAOT_API int asaot_bind(const AsaotHost* host) {
    if (host == NULL) return 1;
    if (host->abi_version != ASAOT_ABI_VERSION) return 2;
    g_host = *host;
    g_bound = 1;
    return 0;
}

ASAOT_API int asaot_is_bound(void) { return g_bound; }

/* ------------------------------------------------------------------------- *
 * Forwarders
 *
 * One macro pair instead of 51 hand-expanded copies: the signature, the table
 * slot and the argument list are written once, so a slot can never be wired to
 * the wrong entry point (the compiler checks each `g_host.<name>` against the
 * struct field's declared type). The unbound fallback is spelled per call
 * because the sensible answer differs -- FREResult-valued entries report
 * FRE_ILLEGAL_STATE, the threading entries report "could not create/obtain".
 * ------------------------------------------------------------------------- */

#define FWD(ret, fallback, name, params, args) \
    ASAOT_API ret name params { \
        if (g_host.name == NULL) return fallback; \
        return g_host.name args; \
    }

#define FWDV(name, params, args) \
    ASAOT_API void name params { \
        if (g_host.name != NULL) g_host.name args; \
    }

/* Context data */
FWD(FREResult, FRE_ILLEGAL_STATE, FREGetContextNativeData, (FREContext ctx, void** nativeData), (ctx, nativeData))
FWD(FREResult, FRE_ILLEGAL_STATE, FRESetContextNativeData, (FREContext ctx, void* nativeData), (ctx, nativeData))
FWD(FREResult, FRE_ILLEGAL_STATE, FREGetContextActionScriptData, (FREContext ctx, FREObject* actionScriptData), (ctx, actionScriptData))
FWD(FREResult, FRE_ILLEGAL_STATE, FRESetContextActionScriptData, (FREContext ctx, FREObject actionScriptData), (ctx, actionScriptData))

/* Object type + primitive readers */
FWD(FREResult, FRE_ILLEGAL_STATE, FREGetObjectType, (FREObject object, FREObjectType* objectType), (object, objectType))
FWD(FREResult, FRE_ILLEGAL_STATE, FREGetObjectAsInt32, (FREObject object, int32_t* value), (object, value))
FWD(FREResult, FRE_ILLEGAL_STATE, FREGetObjectAsUint32, (FREObject object, uint32_t* value), (object, value))
FWD(FREResult, FRE_ILLEGAL_STATE, FREGetObjectAsDouble, (FREObject object, double* value), (object, value))
FWD(FREResult, FRE_ILLEGAL_STATE, FREGetObjectAsBool, (FREObject object, uint32_t* value), (object, value))

/* Primitive creators */
FWD(FREResult, FRE_ILLEGAL_STATE, FRENewObjectFromInt32, (int32_t value, FREObject* object), (value, object))
FWD(FREResult, FRE_ILLEGAL_STATE, FRENewObjectFromUint32, (uint32_t value, FREObject* object), (value, object))
FWD(FREResult, FRE_ILLEGAL_STATE, FRENewObjectFromDouble, (double value, FREObject* object), (value, object))
FWD(FREResult, FRE_ILLEGAL_STATE, FRENewObjectFromBool, (uint32_t value, FREObject* object), (value, object))

/* String */
FWD(FREResult, FRE_ILLEGAL_STATE, FREGetObjectAsUTF8, (FREObject object, uint32_t* length, const uint8_t** value), (object, length, value))
FWD(FREResult, FRE_ILLEGAL_STATE, FRENewObjectFromUTF8, (uint32_t length, const uint8_t* value, FREObject* object), (length, value, object))

/* Utility */
FWD(FREResult, FRE_ILLEGAL_STATE, FRETrace, (FREContext ctx, const char* strTrace), (ctx, strTrace))

/* Render pipeline (deferred -- the executable answers and reports) */
FWD(FREResult, FRE_ILLEGAL_STATE, FREGetRenderMode, (FREContext ctx, FREObject stage, uint8_t* pRenderMode), (ctx, stage, pRenderMode))
FWD(FREResult, FRE_ILLEGAL_STATE, FRESetRenderSource, (FREContext ctx, FREObject source, FREObject target), (ctx, source, target))
FWD(FREResult, FRE_ILLEGAL_STATE, FREMediaBufferLock, (FREContext ctx, FREObject mediaBuffer, uint8_t** pData, uint32_t* pWidth, uint32_t* pHeight, uint32_t* pStride, uint32_t* pFormat), (ctx, mediaBuffer, pData, pWidth, pHeight, pStride, pFormat))
FWD(FREResult, FRE_ILLEGAL_STATE, FREMediaBufferUnlock, (FREContext ctx, FREObject mediaBuffer, uint32_t bUpdate), (ctx, mediaBuffer, bUpdate))

/* Object access */
FWD(FREResult, FRE_ILLEGAL_STATE, FRENewObject, (const uint8_t* className, uint32_t argc, FREObject argv[], FREObject* object, FREObject* thrownException), (className, argc, argv, object, thrownException))
FWD(FREResult, FRE_ILLEGAL_STATE, FREGetObjectProperty, (FREObject object, const uint8_t* propertyName, FREObject* propertyValue, FREObject* thrownException), (object, propertyName, propertyValue, thrownException))
FWD(FREResult, FRE_ILLEGAL_STATE, FRESetObjectProperty, (FREObject object, const uint8_t* propertyName, FREObject propertyValue, FREObject* thrownException), (object, propertyName, propertyValue, thrownException))
FWD(FREResult, FRE_ILLEGAL_STATE, FRECallObjectMethod, (FREObject object, const uint8_t* methodName, uint32_t argc, FREObject argv[], FREObject* result, FREObject* thrownException), (object, methodName, argc, argv, result, thrownException))

/* BitmapData access */
FWD(FREResult, FRE_ILLEGAL_STATE, FREAcquireBitmapData, (FREObject object, FREBitmapData* descriptorToSet), (object, descriptorToSet))
FWD(FREResult, FRE_ILLEGAL_STATE, FREAcquireBitmapData2, (FREObject object, FREBitmapData2* descriptorToSet), (object, descriptorToSet))
FWD(FREResult, FRE_ILLEGAL_STATE, FREInvalidateBitmapDataRect, (FREObject object, uint32_t x, uint32_t y, uint32_t width, uint32_t height), (object, x, y, width, height))
FWD(FREResult, FRE_ILLEGAL_STATE, FREReleaseBitmapData, (FREObject object), (object))

/* ByteArray access */
FWD(FREResult, FRE_ILLEGAL_STATE, FRENewByteArray, (FREByteArray* byteArrayData, FREObject* handle), (byteArrayData, handle))
FWD(FREResult, FRE_ILLEGAL_STATE, FREAcquireByteArray, (FREObject object, FREByteArray* byteArrayToSet), (object, byteArrayToSet))
FWD(FREResult, FRE_ILLEGAL_STATE, FREReleaseByteArray, (FREObject object), (object))

/* Array and Vector access */
FWD(FREResult, FRE_ILLEGAL_STATE, FREGetArrayLength, (FREObject arrayOrVector, uint32_t* length), (arrayOrVector, length))
FWD(FREResult, FRE_ILLEGAL_STATE, FRESetArrayLength, (FREObject arrayOrVector, uint32_t length), (arrayOrVector, length))
FWD(FREResult, FRE_ILLEGAL_STATE, FREGetArrayElementAt, (FREObject arrayOrVector, uint32_t index, FREObject* value), (arrayOrVector, index, value))
FWD(FREResult, FRE_ILLEGAL_STATE, FRESetArrayElementAt, (FREObject arrayOrVector, uint32_t index, FREObject value), (arrayOrVector, index, value))

/* NativeWindow access */
FWD(FREResult, FRE_ILLEGAL_STATE, FREAcquireNativeWindowHandle, (FREObject nativeWindow, FRENativeWindow* handle), (nativeWindow, handle))
FWD(FREResult, FRE_ILLEGAL_STATE, FREReleaseNativeWindowHandle, (FREObject nativeWindow), (nativeWindow))

/* Context3D native handle */
FWD(FREResult, FRE_ILLEGAL_STATE, FREGetNativeContext3DHandle, (FREObject context3D, void** handle), (context3D, handle))

/* ExtensionContext <-> FREContext */
FWD(FREResult, FRE_ILLEGAL_STATE, FREGetFREContextFromExtensionContext, (FREObject objExtensionContext, FREContext* pContext), (objExtensionContext, pContext))

/* Threading. These forward like everything else so that the module which
 * INITIALIZES a caller-allocated FREMutex/CRITICAL_SECTION is always the same
 * one that locks and destroys it. */
FWD(FREThread, 0, FRECurrentThread, (void), ())
FWD(FREThread, 0, FRENullThread, (void), ())
FWD(uint32_t, 0, FREThreadCreate, (FREThread* thread, FREThreadFunction start_fn, FREThreadArg arg), (thread, start_fn, arg))
FWD(uint32_t, 0, FREThreadDetach, (FREThread thread), (thread))
FWDV(FREThreadSleep, (int32_t timeout_millis), (timeout_millis))
FWDV(FREThreadJoin, (FREThread thread), (thread))
FWD(uint32_t, 0, FRERecursiveMutexInit, (FREMutex* mutex), (mutex))
FWD(uint32_t, 0, FRERecursiveMutexDestroy, (FREMutex* mutex), (mutex))
FWDV(FRERecursiveMutexLock, (FREMutex* mutex), (mutex))
FWD(uint32_t, 0, FRERecursiveMutexTryLock, (FREMutex* mutex), (mutex))
FWDV(FRERecursiveMutexUnlock, (FREMutex* mutex), (mutex))

/* Callbacks */
FWD(FREResult, FRE_ILLEGAL_STATE, FREDispatchStatusEventAsync, (FREContext ctx, const uint8_t* code, const uint8_t* level), (ctx, code, level))
