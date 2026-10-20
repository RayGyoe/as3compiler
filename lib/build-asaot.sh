#!/bin/sh
# Build the FRE host library for macOS (lib/bin/macos-x86-64/libasaot.dylib)
# from asaot_host.c.
#
# The macOS half of lib/build-asaot.bat, and deliberately the same shape: the
# source is one width-agnostic forwarding translation unit, so the two platforms
# differ in the driver flags and in the artifact name, never in the code.
#
# Why a script rather than a loose command line: the artifact records two things
# that are load-bearing and invisible at build time.
#
#   1. Its INSTALL NAME. macOS records, inside every binary that links this
#      library, the path to load it by -- so the name chosen here is what both
#      consumers will ask dyld for. `@executable_path/libasaot.dylib` is the
#      choice that makes the build relocatable for both of them at once:
#      `@executable_path` is substituted with the directory of the MAIN
#      executable, so the generated program and the extension library it dlopen()s
#      (which sits two levels down in extensions/<extID>/MacOS-x86-64/) resolve to
#      the SAME copy -- the one src/index.ts stages next to the executable. This is
#      the macOS counterpart of the Windows arrangement, where the import library
#      records the module name `asaot.dll` and the DLL is found beside the exe.
#      A bare `libasaot.dylib` name would NOT do: dyld treats a name without a
#      slash as a search-path basename and looks in DYLD_FALLBACK_LIBRARY_PATH
#      (/usr/local/lib:/lib:/usr/lib), never beside the executable.
#
#   2. Which architectures it carries. The AIR platform key for macOS is
#      `MacOS-x86-64` and it does NOT encode an architecture -- AIR SDK 51.4.1's
#      `Adobe AIR.framework/.../Adobe AIR` is a universal x86_64+arm64 binary whose
#      single 64-bit ANE key is `MacOS-x86-64` in BOTH slices (measured; the
#      reasoning is written out in src/ane.ts currentAnePlatform). So a macOS ANE is
#      normally universal, and a host library that was one slice would be rejected
#      by dyld on the other. Both slices are therefore built by default, exactly
#      like the .bat builds both Windows widths.
#
# Output is platform-tagged under bin/<platform>/, the layout vendor/ already uses
# (vendor/sdl2/lib/macos-arm64) and the .bat already uses for Windows. The
# directory is named for AIR's macOS KEY rather than for an artifact slice,
# because the key cannot tell the two macOS architectures apart -- see
# aneHostDirName in src/ane.ts.
#
#   bin/macos-x86-64/libasaot.dylib   universal (x86_64 + arm64)
#
# Usage:
#   build-asaot.sh          build the host (same as `all`)
#   build-asaot.sh all      build the host
#   build-asaot.sh native   build only the host architecture (faster; not for shipping)
#
# Any other argument is an ERROR, not a skip: silently building nothing (or the
# wrong slice set) is the failure mode the two explicit modes exist to remove.

set -eu

cd "$(dirname "$0")"

OUT=bin/macos-x86-64
LIB="$OUT/libasaot.dylib"

# Air's macOS key is architecture-neutral, so BOTH slices are the default -- one
# dependency (the host is what every extension's FRE symbol resolves through), so
# one binary that dyld accepts anywhere. `native` exists for the edit/build loop;
# it is NOT what a committed artifact may be, and the guard below says so by name.
WHICH="${1:-all}"
case "$WHICH" in
  all)
    ARCH_FLAGS="-arch arm64 -arch x86_64"
    ;;
  native)
    ARCH_FLAGS=""
    ;;
  *)
    echo "[asaot] unknown argument: $WHICH" >&2
    echo "[asaot] expected one of: all, native   (no argument = all)" >&2
    exit 2
    ;;
esac

mkdir -p "$OUT"

echo "[asaot] macos-x86-64: compiling asaot_host.c -> $LIB"

# -dynamiclib rather than -shared: macOS distinguishes a loadable bundle from a
# dylib, and this IS a dylib (the generated executable links it AND the extension
# library links it; -bundle would refuse the former).
#
# -fPIC is implied by -dynamiclib on this target, but spelled out so the build does
# not depend on that implication.
#
# No -fvisibility=hidden: asaot.h decorates every one of the 53 entry points with
# `visibility("default")` on this side (see the non-_WIN32 branch of the
# ASAOT_API macro), which is the same export set the .bat's guard asserts on the
# Windows artifact.
#
# shellcheck disable=SC2086
clang -O2 -dynamiclib -fPIC -Wall -Wextra -DASAOT_BUILD -I. \
  $ARCH_FLAGS asaot_host.c -o "$LIB" \
  -install_name @executable_path/libasaot.dylib

# --- artifact guards -----------------------------------------------------------
# Every one of these fails silently at BUILD time and loudly (or, worse, not at
# all) much later, so the artifact is what gets asserted rather than the flags
# above. Same discipline as the .bat's import-table guard.

# 1. The install name. Getting this wrong is invisible here and then makes every
#    built program fail to launch (the executable records it as a dependency).
# otool -D prints a `<file>:` (thin) or `<file> (architecture <arch>):` (fat)
# header line before each name, so only the lines that ARE a name are kept. An
# install name is an absolute path or an @-prefixed token, which is the whole
# filter. Sorting first is what makes the two architectures answer identically
# regardless of which one the fat header lists first.
NAME="$(otool -D "$LIB" | grep -E '^[@/]' | sort -u)"
if [ "$NAME" != "@executable_path/libasaot.dylib" ]; then
  echo "[asaot] FAILED - $LIB has install name '$NAME'" >&2
  echo "[asaot] expected @executable_path/libasaot.dylib" >&2
  exit 1
fi
# Both slices must agree, or the shippable binary loads differently on Apple
# Silicon and on Intel. Checked separately because the comparison above collapses
# a disagreement into a passing match when the two happen to sort apart.
SLICE_NAMES="$(otool -D "$LIB" | grep -E '^[@/]' | sort -u | wc -l | tr -d ' ')"
if [ "$SLICE_NAMES" != "1" ]; then
  echo "[asaot] FAILED - $LIB's slices disagree about the install name" >&2
  exit 1
fi

# 2. The forwarding entry point. A library that lost asaot_bind would link and
#    load, and then report "asaot.dll does not export asaot_bind" at run time.
if ! nm -gU "$LIB" | grep -q '_asaot_bind$'; then
  echo "[asaot] FAILED - $LIB does not export asaot_bind" >&2
  exit 1
fi

# 3. The entry-point count, which is what makes this library FRE rather than
#    something that merely has the right name (the .bat asserts the same set on
#    Windows through the import table). 51 FRE entry points + asaot_bind +
#    asaot_is_bound.
EXPORTS="$(nm -gU "$LIB" | grep -c ' T _')"
if [ "$EXPORTS" -ne 53 ]; then
  echo "[asaot] FAILED - $LIB exports $EXPORTS symbols, expected 53" >&2
  exit 1
fi

# 4. No AIR dependency. The whole point of a recompiled-for-AOT host is that there
#    is no Adobe runtime beside a generated executable; a library that still
#    references one would load only on a machine that has AIR installed.
if otool -L "$LIB" | grep -qi 'Adobe AIR'; then
  echo "[asaot] FAILED - $LIB still references Adobe AIR" >&2
  exit 1
fi

# 5. The slices, for the default build only: `native` deliberately produces one.
if [ "$WHICH" = "all" ]; then
  SLICES="$(lipo -archs "$LIB")"
  case "$SLICES" in
    *arm64*x86_64*|*x86_64*arm64*) ;;
    *)
      echo "[asaot] FAILED - $LIB carries '$SLICES', expected arm64 + x86_64" >&2
      exit 1
      ;;
  esac
fi

echo "[asaot] ok -- $LIB ($(lipo -archs "$LIB"), $(nm -gU "$LIB" | grep -c ' T _') exports)"
