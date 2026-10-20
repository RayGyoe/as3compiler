#!/bin/sh
# Build the "Probe" ANE fixture for macOS -- the ONE native extension that
# examples/ane/ and examples/ane-app/ share.
#
# The macOS half of build-ane.bat, and deliberately the same shape: those two
# examples reach the same extension by two different routes (a manifest's
# `ane-paths` versus an application descriptor's <extensions>), and they are the
# before/after pair a reader compares. So this compiles the source ONCE and copies
# the result into BOTH staging trees, and the two cannot come to disagree about
# what com.example.probe is. Nothing in the build enforces that: they are two
# independent directories, and a tree that lost its descriptor still compiles and
# still links -- the only symptom is the load failing at run time, on one example,
# on one platform. Hence the descriptor guard per tree and the export guard on the
# artifact below.
#
# What makes this AOT-loadable without AIR is the same two moves as on Windows,
# with the platform's own file names:
#
#   - `shim/FlashRuntimeExtensions.h` sits AHEAD of the extension's own directory
#     on the include path, so that header name resolves to the asaot ABI and the
#     source tree stays unmodified;
#   - `-lasaot` from lib/bin/macos-x86-64, not Adobe AIR.framework, is what gets
#     linked, so the dylib records `@executable_path/libasaot.dylib` as a
#     dependency. There is no Adobe runtime next to a generated executable to
#     satisfy the other import, even though the FRE function table is identical.
#     That install name is what makes the fixture relocatable: it resolves to the
#     MAIN executable's directory, so the copy src/index.ts stages beside the
#     program is the one dyld opens -- see lib/build-asaot.sh and src/fre.ts.
#
# The slice set is universal (x86_64 + arm64), because the AIR platform key for
# macOS does not encode an architecture: `MacOS-x86-64` is the single 64-bit key
# in BOTH slices of AIR's own universal macOS runtime (measured; the reasoning is
# in src/ane.ts currentAnePlatform). A one-slice fixture would be rejected by dyld
# on the other architecture, so both are built by default. `--platform native`
# exists for the edit/build loop and is not what a committed fixture may be.
#
# Intermediates land in temp/ (git-ignored) rather than beside the sources. The
# staged dylibs are the committed fixture, so those two copies are the only things
# this script writes into the example trees.
#
# Usage:
#   build-ane.sh                    build the fixture (universal)
#   build-ane.sh --platform native  build for the host architecture only (faster)

set -eu

cd "$(dirname "$0")"

EX="$(pwd)"
REPO="$EX/../.."
SCRATCH="$REPO/temp/ane-probe-build-mac"

ID="com.example.probe"
PLAT="MacOS-x86-64"
LIB="ProbeANE.dylib"

ARCH_FLAGS="-arch arm64 -arch x86_64"
if [ "${1:-}" = "--platform" ]; then
  case "${2:-}" in
    native) ARCH_FLAGS="" ;;
    *)
      echo "[ane] unknown platform: ${2:-}" >&2
      echo "[ane] expected: native   (or no --platform for the universal default)" >&2
      exit 2
      ;;
  esac
elif [ $# -ne 0 ]; then
  echo "[ane] unknown argument: $1" >&2
  echo "[ane] expected: --platform native" >&2
  exit 2
fi

# The host library must exist before the fixture can link against it. Named here
# rather than left to the linker, whose message for a missing -lasaot is about a
# search path rather than about the library that was never built.
if [ ! -f "$REPO/lib/bin/macos-x86-64/libasaot.dylib" ]; then
  echo "[ane] FAILED - lib/bin/macos-x86-64/libasaot.dylib is not built" >&2
  echo "[ane] run lib/build-asaot.sh first" >&2
  exit 1
fi

mkdir -p "$SCRATCH"

echo "[ane] compiling ProbeANE.c -> $LIB"

# -I shim BEFORE the extension's own directory: that is what redirects the AIR SDK
# header name to the asaot ABI (see the header comment).
#
# The output goes to the scratch directory, so no object file or link artefact is
# written into the example tree.
#
# shellcheck disable=SC2086
clang -O2 -dynamiclib -fPIC -Wall -Wextra \
  -I "$EX/shim" -I "$REPO/lib" \
  $ARCH_FLAGS "$EX/ProbeANE.c" -o "$SCRATCH/$LIB" \
  -L "$REPO/lib/bin/macos-x86-64" -lasaot

# --- artifact guards (docs/zh-cn/ane.md 4.5) ------------------------------------
# A dylib that still depends on Adobe AIR.framework builds and links perfectly and
# then fails to load, so the artifact itself is what gets asserted, not the flags
# above. Same discipline as the .bat's import-table guard.

if ! otool -L "$SCRATCH/$LIB" | grep -q 'libasaot\.dylib'; then
  echo "[ane] FAILED - $LIB does not depend on libasaot.dylib" >&2
  otool -L "$SCRATCH/$LIB" >&2
  exit 1
fi

if otool -L "$SCRATCH/$LIB" | grep -qi 'Adobe AIR'; then
  echo "[ane] FAILED - $LIB still depends on Adobe AIR" >&2
  exit 1
fi

# The dependency must be the RELOCATABLE name, not an absolute path into this
# checkout: an absolute one would make the fixture build here and load nowhere
# else. This is the macOS counterpart of the .bat's "the import library must name
# asaot.dll" guard -- the failure it catches is equally silent at build time.
if ! otool -L "$SCRATCH/$LIB" | grep -q '@executable_path/libasaot\.dylib'; then
  echo "[ane] FAILED - $LIB records an absolute path to the host library" >&2
  exit 1
fi

if ! nm -gU "$SCRATCH/$LIB" | grep -q '_ProbeExtInitializer$'; then
  echo "[ane] FAILED - $LIB exports no ProbeExtInitializer" >&2
  exit 1
fi

if [ "$ARCH_FLAGS" != "" ]; then
  SLICES="$(lipo -archs "$SCRATCH/$LIB")"
  case "$SLICES" in
    *arm64*x86_64*|*x86_64*arm64*) ;;
    *)
      echo "[ane] FAILED - $LIB carries '$SLICES', expected arm64 + x86_64" >&2
      exit 1
      ;;
  esac
fi

# --- stage into BOTH trees, guarding each descriptor first ----------------------
for T in "$EX/ext-aot" "$EX/../ane-app/ext-aot"; do
  XML="$T/$ID/extension.xml"
  if ! grep -q "<id>$ID</id>" "$XML"; then
    echo "[ane] FAILED - $XML does not declare $ID" >&2
    exit 1
  fi
  if ! grep -q "<nativeLibrary>$LIB</nativeLibrary>" "$XML"; then
    echo "[ane] FAILED - $XML does not name $LIB" >&2
    exit 1
  fi
  # The platform entry too: a descriptor that names the library but not the key it
  # belongs to would stage a dylib no build ever looks for, and the symptom is the
  # build refusing the package with "has no <platform name=MacOS-x86-64> entry".
  if ! grep -q "<platform name=\"$PLAT\">" "$XML"; then
    echo "[ane] FAILED - $XML declares no <platform name=\"$PLAT\"> entry" >&2
    exit 1
  fi
  mkdir -p "$T/$ID/$PLAT"
  cp "$SCRATCH/$LIB" "$T/$ID/$PLAT/$LIB"
  echo "[ane] staged -> $T/$ID/$PLAT/$LIB"
done

echo "[ane] ok -- one compile, both trees ($(lipo -archs "$SCRATCH/$LIB"))"
