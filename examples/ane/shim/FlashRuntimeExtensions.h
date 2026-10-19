/* Recompile shim -- the ONLY file this harness injects into the compilation of an
 * ANE whose native sources must stay untouched.
 *
 * ANE sources do `#include "FlashRuntimeExtensions.h"`, because that is the name
 * the AIR SDK ships. This file carries that exact name and is placed AHEAD of the
 * extension's own airsdk directory on the include path, so the source tree stays
 * byte-for-byte unmodified while every FRE symbol is redirected to the asaot ABI.
 *
 * What that buys: the recompiled library records `asaot.dll` in its import table
 * instead of `Adobe AIR.dll`. Without it an AOT-compiled program cannot load the
 * extension -- there is no Adobe AIR runtime present to satisfy the import, even
 * though the FRE function table it wants is identical.
 *
 * asaot.h is ABI-compatible with the AIR SDK's FlashRuntimeExtensions.h for all
 * 51 entry points, so no extension source change is implied by this redirect.
 * See as3compiler/docs/zh-cn/ane.md for the migration recipe.
 *
 * CAVEAT, measured: MSVC resolves a quoted include from the INCLUDING FILE'S OWN
 * DIRECTORY before any /I path. Some extension trees keep the SDK header beside
 * their sources (that is a project item there), in which case this shim cannot
 * win and the SDK header is what gets compiled. That is harmless HERE -- the
 * import table is decided by which import library is linked (asaot.lib), not by
 * which header declared the prototypes, and the SDK header declares the same
 * plain-C FRE prototypes. check-ext.cjs asserts the import table either way, so
 * the redirect is verified on the artifact rather than assumed from the /I order.
 */
#ifndef ASC_AOT_ANE_FRE_SHIM_INCLUDED
#define ASC_AOT_ANE_FRE_SHIM_INCLUDED
#include "asaot.h"
#endif
