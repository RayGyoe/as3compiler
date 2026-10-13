#!/usr/bin/env bash
#
# build-and-run.sh — compile an Away3D demo with mxmlc and run it under adl
# (AIR Debug Launcher), to capture the AIR reference behaviour of the same
# source our AOT compiler is measured against.
#
# This directory is a read-only copy of away3d-core-fp11 (479 .as files, the
# 2017-02-07 snapshot, Apache-2.0). It is NOT part of the AOT regression suite
# (see SKIP_DIRS in test/examples.ts): the full engine needs language features
# far outside the current subset. It exists as an *adl reference* — "what AIR
# actually renders" — for the Stage3D / native-shader work (enhancement E6).
#
# Usage:
#   ./build-and-run.sh [MAIN_CLASS] [--build-only]
#
#   MAIN_CLASS   Class to compile (default: Basic_SkyBox). Any of the
#                demo entry points under src/ works, e.g. Basic_SkyBox,
#                Basic_View, Basic_LoadModel — the corresponding .as usually
#                lives in BOTH the default package and a named package; the
#                flattened default-package copy under src/ is what we compile.
#   --build-only Compile and ensure the descriptor, but do not launch adl.
#
# Build products go to ./build/ (matched by the repo-root `build/` gitignore
# rule), so the clone's sources stay pristine. The one file written to the app
# root is the adl descriptor, <MAIN_CLASS>-app.xml: it has to live next to src/
# to be usable by as-aot --air-app as well as by adl (see the descriptor
# section below).
#
# AIR SDK discovery order:
#   1. $AIRSDK_HOME environment variable (point it at the SDK root).
#   2. The AIR SDK Manager config at ~/.airsdk/airsdkmanager.cfg (AIR_SDKS=...).
#   3. A sibling directory named AIRSDK_* under the detected root.

set -euo pipefail

# ---------------------------------------------------------------------------
# Arguments.
# ---------------------------------------------------------------------------
MAIN_CLASS="Basic_SkyBox"
BUILD_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=1 ;;
    -*) echo "ERROR: unknown option '$arg'." >&2; exit 2 ;;
    *) MAIN_CLASS="$arg" ;;
  esac
done

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

# Paths are resolved relative to this script, so it works from any CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"
BUILD_DIR="$SCRIPT_DIR/build"
MAIN_SRC="$SRC_DIR/${MAIN_CLASS}.as"
OUTPUT_SWF="$BUILD_DIR/${MAIN_CLASS}.swf"
# The descriptor is a real file at the app root, NOT a heredoc into build/ the
# way this script first did it: `as-aot --air-app <xml>` needs a stable on-disk
# path, and it takes the descriptor's own directory as the app root (it scans
# <descriptor dir>/src and writes <filename>.build.json beside the descriptor).
APP_XML="$SCRIPT_DIR/${MAIN_CLASS}-app.xml"

if [[ ! -f "$MAIN_SRC" ]]; then
  echo "ERROR: main class source not found: $MAIN_SRC" >&2
  echo "  Available default-package demos under src/:" >&2
  # Default-package .as files only (the engine lives under src/away3d/).
  find "$SRC_DIR" -maxdepth 1 -name '*.as' -exec basename {} .as \; | sed 's/^/    /' >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"

echo "AIR SDK: $SDK"
echo "Compiling (main class: $MAIN_CLASS)..."

rm -f "$OUTPUT_SWF"

# -swf-version=51 matches the AIR 51 SDK (and the app.xml namespace below);
# Stage3D/Context3D needs >= 13, so any modern value works, but pinning keeps
# the build reproducible.
#
# -source-path+=src is required twice over: it is how the default-package demo
# and the src/away3d/** engine packages are found, and it is the root the
# engine's absolute embed paths resolve against
# ([Embed(source="/../pb/RayTriangleKernel.pbj")] in core/pick/PBPickingCollider.as
# and textures/SplatBlendBitmapTexture.as → src/../pb/*.pbj). Basic_SkyBox does
# not reach those two classes, so mxmlc never processes those embeds, but the
# source path must still be right if it ever does.
#
# The demo's own [Embed(source="../embeds/skybox/*.jpg")] directives resolve to
# the same place either way mxmlc resolves them (relative to Basic_SkyBox.as, or
# relative to the src/ source root): src/../embeds/skybox == embeds/skybox.
#
# [SWF(backgroundColor="#000000", frameRate="60", quality="LOW")] sits directly
# above the class in Basic_SkyBox.as, so unlike the Starling demo it *is* bound
# to the class; only width/height are missing, hence -default-size.
"$MXMLC" \
  -swf-version=51 \
  -static-link-runtime-shared-libraries=true \
  -default-size 1024 768 \
  -source-path+="$SRC_DIR" \
  -output="$OUTPUT_SWF" \
  "$MAIN_SRC"

echo "Compiled to $OUTPUT_SWF"

# ---------------------------------------------------------------------------
# adl descriptor, at the app root so that it serves both launchers:
#
#   * adl resolves <content> against the descriptor's directory;
#   * `as-aot --air-app <xml>` treats that directory as the app root, scanning
#     <descriptor dir>/src and writing <filename>.build.json beside it.
#
# Basic_SkyBox-app.xml is the canonical descriptor and is never rewritten.
# Any other main class gets its descriptor created here on first use, so
# `./build-and-run.sh Other_Demo` keeps working without a manual step and the
# new file is immediately usable by the AOT adapter too.
#
# The <id> must be a reverse-DNS identifier, which AIR validates as
# dot-separated alphanumeric segments: dots and [A-Za-z0-9] only. Most demo
# class names would fail it as-is — `Basic_SkyBox` throws
# "invalid application descriptor: invalid application identifier" on its
# underscore. Sanitize the class name down to alphanumerics for the id only;
# <filename>/<name> and the .swf name keep the real class name.
# ---------------------------------------------------------------------------
if [[ ! -f "$APP_XML" ]]; then
  echo "No descriptor for $MAIN_CLASS — writing $(basename "$APP_XML")"
  ID_SAFE="$(printf '%s' "$MAIN_CLASS" | tr -cd 'a-zA-Z0-9')"
  cat > "$APP_XML" <<XML
<?xml version="1.0" encoding="utf-8" standalone="no" ?>
<application xmlns="http://ns.adobe.com/air/application/51.1">

    <!-- Kept at the app root (next to src/) by build-and-run.sh, because that is
         the one directory both launchers agree on: adl resolves the content
         subpath from here, and "as-aot --air-app" takes this directory as the
         app root, scanning its src/ tree and writing the build manifest here.
         (Comments are safe here: the AOT descriptor reader strips comments
         before matching elements, so a tag name spelled in one is not read as a
         live element — pinned by air-app/DescriptorComments.) -->

    <id>com.awayfoundation.away3d.example.${ID_SAFE}</id>
    <filename>${MAIN_CLASS}</filename>
    <name>${MAIN_CLASS}</name>
    <versionNumber>0.0.1</versionNumber>

    <!-- Stage3D needs the extended-desktop profile, direct rendering and a
         depth/stencil buffer: Away3D requests a depth buffer when it
         configures the Stage3D back buffer, and without one the SkyBox torus
         loses its depth test. -->
    <supportedProfiles>extendedDesktop</supportedProfiles>

    <initialWindow>
        <!-- The SWF is a build product under build/, so the content is a relative
             subpath rather than a file at the app root. -->
        <content>build/${MAIN_CLASS}.swf</content>
        <renderMode>direct</renderMode>
        <depthAndStencil>true</depthAndStencil>
        <width>1024</width>
        <height>768</height>
        <visible>true</visible>
        <requestedDisplayResolution>high</requestedDisplayResolution>
    </initialWindow>

</application>
XML
fi

# --build-only stops short of launching adl, but the descriptor above has
# already been ensured: it is the input as-aot --air-app reads, so a build-only
# run must leave it in place.
if [[ "$BUILD_ONLY" == "1" ]]; then
  echo "Done (build only)."
  exit 0
fi

echo "Launching (a GPU-backed Stage3D window will open)..."
echo "----------------------------------------"

# The trailing "-- $SCRIPT_DIR" sets the application root directory, so
# File.applicationDirectory / relative asset paths resolve against this folder.
# Basic_SkyBox compiles all of its textures in via [Embed], so nothing is read
# from disk at runtime, but the convention is shared with the other examples.
"$ADL" "$APP_XML" -- "$SCRIPT_DIR"

echo "----------------------------------------"
echo "Done."