#!/usr/bin/env bash
#
# build-and-run.sh — build the Starling demo (Demo.as) and run it either under
# adl (AIR Debug Launcher, the default) or as an AOT-compiled native binary.
# The AIR SDK is auto-detected exactly like the other examples in this repository.
#
# Usage:
#   ./build-and-run.sh           build with mxmlc and run under adl (default)
#   ./build-and-run.sh aot       build with as-aot and run the native binary
#
# AIR SDK discovery order:
#   1. $AIRSDK_HOME environment variable (point it at the SDK root).
#   2. The AIR SDK Manager config at ~/.airsdk/airsdkmanager.cfg (AIR_SDKS=...).
#   3. A sibling directory named AIRSDK_* under the detected root.

set -euo pipefail

# Paths are resolved relative to this script, so it works from any CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Mode selection. No argument = adl (mxmlc + AIR Debug Launcher); `aot` builds
# with as-aot (src/index.ts --air-app) and runs the resulting native binary.
# ---------------------------------------------------------------------------
MODE="adl"
for arg in "$@"; do
  case "$arg" in
    aot) MODE="aot" ;;
    -*) echo "ERROR: unknown option '$arg' (supported: aot)." >&2; exit 2 ;;
    *)  echo "ERROR: unknown argument '$arg' (supported: aot)." >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# AOT mode: no AIR SDK / mxmlc / adl needed. as-aot reads the descriptor,
# regenerates the build manifest for this platform, and --run launches the
# native binary. File.applicationDirectory maps to the process CWD (as_app_dir
# returns "."), so the build runs from the demo directory to keep assets/ and
# the relative source tree reachable.
# ---------------------------------------------------------------------------
if [[ "$MODE" == "aot" ]]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: node not found (as-aot runs src/index.ts under Node >= 22)." >&2
    exit 1
  fi
  cd "$SCRIPT_DIR"
  echo "Building AOT (main class: Demo) with as-aot..."
  echo "----------------------------------------"
  node ../../src/index.ts \
    --air-app Demo-app.xml \
    --main-class Demo \
    -o Starling-Demo \
    --run
  echo "----------------------------------------"
  echo "Done."
  exit 0
fi

# ---------------------------------------------------------------------------
# Locate the AIR SDK root (directory containing bin/mxmlc and bin/adl).
# ---------------------------------------------------------------------------
find_sdk() {
  # 1. Explicit env var.
  if [[ -n "${AIRSDK_HOME:-}" && -x "${AIRSDK_HOME}/bin/mxmlc" ]]; then
    echo "${AIRSDK_HOME}"
    return
  fi

  # 2. AIR SDK Manager config.
  local cfg="${HOME}/.airsdk/airsdkmanager.cfg"
  if [[ -f "$cfg" ]]; then
    local root
    root="$(grep -E '^AIR_SDKS=' "$cfg" | head -n 1 | cut -d= -f2-)"
    if [[ -n "$root" && -d "$root" ]]; then
      local d
      d="$(find "$root" -maxdepth 1 -type d -name 'AIRSDK_*' 2>/dev/null | sort -V | tail -n 1)"
      if [[ -n "$d" && -x "$d/bin/mxmlc" ]]; then
        echo "$d"
        return
      fi
    fi
  fi

  # 3. Nothing found.
  echo ""
}

SDK="$(find_sdk)"
if [[ -z "$SDK" ]]; then
  echo "ERROR: AIR SDK not found." >&2
  echo "  Set AIRSDK_HOME=/path/to/AIRSDK_xx to point at the SDK root." >&2
  exit 1
fi

MXMLC="$SDK/bin/mxmlc"
# The AIR SDK bundles launchers for every platform side by side in bin/:
# plain `adl` (macOS Mach-O), `adl.exe`/`adl64.exe` (Windows PE) and
# `adl_linux64`/`adl_linux_arm64` (Linux ELF). Testing "does adl.exe exist?"
# therefore selects a Windows PE binary on macOS, and exec then fails with
# "cannot execute binary file". Select by the *host* OS instead, falling
# back to a plain `adl` when the host is unrecognised.
case "$(uname -s 2>/dev/null || echo unknown)" in
  Darwin)
    CANDIDATES=("adl" "adl64")
    ;;
  Linux)
    if [[ "$(uname -m 2>/dev/null || echo unknown)" == "aarch64" ||
          "$(uname -m 2>/dev/null || echo unknown)" == "arm64" ]]; then
      CANDIDATES=("adl_linux_arm64" "adl")
    else
      CANDIDATES=("adl_linux64" "adl")
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    CANDIDATES=("adl.exe" "adl64.exe" "adl")
    ;;
  *)
    CANDIDATES=("adl")
    ;;
esac

ADL=""
for c in "${CANDIDATES[@]}"; do
  if [[ -f "$SDK/bin/$c" ]]; then
    ADL="$SDK/bin/$c"
    break
  fi
done

if [[ -z "$ADL" ]]; then
  echo "ERROR: no AIR launcher (adl) found under $SDK/bin." >&2
  exit 1
fi

SRC_DIR="$SCRIPT_DIR/src"
MAIN_CLASS="$SRC_DIR/Demo.as"
OUTPUT_SWF="$SCRIPT_DIR/Demo.swf"
APP_XML_RUN="$SCRIPT_DIR/Demo-app.xml"

echo "AIR SDK: $SDK"
echo "Compiling (main class: Demo)..."

rm -f "$OUTPUT_SWF"

# Starling 2.x targets Flash Player 11+ (SWF 20+). AIR 51's mxmlc defaults are
# fine, but we pin the values so the build is reproducible. The source path is
# the demo root, so starling/, scenes/, utils/ and com/ packages are all found.
"$MXMLC" \
  -swf-version=51 \
  -static-link-runtime-shared-libraries=true \
  -source-path+="$SRC_DIR" \
  -output="$OUTPUT_SWF" \
  "$MAIN_CLASS"

echo "Compiled to $OUTPUT_SWF"


echo "Launching (window will open)..."
echo "----------------------------------------"

# The trailing "-- $SCRIPT_DIR" sets the application root directory so that
# File.applicationDirectory resolves to this folder, keeping assets/ reachable.
"$ADL" "$APP_XML_RUN" -- "$SCRIPT_DIR"

echo "----------------------------------------"
echo "Done."
