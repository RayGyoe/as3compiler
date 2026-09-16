#!/usr/bin/env bash
#
# build-and-run.sh — compile the native AS3 demo project with mxmlc and run it
# with adl (AIR Debug Launcher). No global AIR SDK required; the SDK location
# is auto-detected as described below.
#
# Usage:
#   ./build-and-run.sh
#
# AIR SDK discovery order:
#   1. $AIRSDK_HOME environment variable (point it at the SDK root).
#   2. The AIR SDK Manager config at ~/.airsdk/airsdkmanager.cfg (AIR_SDKS=...).
#   3. A sibling directory named AIRSDK_* under the detected root.

set -euo pipefail

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
ADL="$SDK/bin/adl"

# Paths are resolved relative to this script, so it works from any CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"
OUTPUT_SWF="$SCRIPT_DIR/main.swf"
APP_XML="$SCRIPT_DIR/air-native-app.xml"

echo "AIR SDK: $SDK"
echo "Compiling..."

rm -f "$OUTPUT_SWF"

"$MXMLC" \
  -source-path+="$SRC_DIR" \
  -output="$OUTPUT_SWF" \
  "$SRC_DIR/demo/Main.as"

echo "Compiled to $OUTPUT_SWF"
echo "Launching (window will open; demo output is drawn on screen)..."
echo "----------------------------------------"

# Launch the AIR app in a visible window. The demo classes write their
# results to a visible TextField (see demo/Log.as) so the output is readable
# on screen; trace() output also goes to the AIR debug log.
"$ADL" "$APP_XML" -- "$SCRIPT_DIR"

echo "----------------------------------------"
echo "Done."
