#!/bin/sh
# macos.sh — rebuild as3compiler's *vendored* macOS dependency libraries from
# source, so the archives in vendor/*/lib/macos-arm64/ can be reproduced rather
# than taken on faith.
#
# Why this is a thin entry point and not a second windows.ps1:
#
#   On Windows the provisioning script has to be 1400+ lines because almost all
#   of that length is Windows-only obstacle handling (vcvars environment import,
#   clang-cl + MSVC ABI, the /MT-vs-/MD CRT trap, the MSVC STL `auto_ptr` and
#   `GrD3DUtil.h` source repairs, the x86 `SetEnv.cmd` toolchain patch, and a
#   post-build archive-bitness audit). macOS has none of those obstacles: the
#   system toolchain is clang, the cores are Apple frameworks, and the two real
#   build recipes already exist in the tree. What was missing was only the step
#   that strings them together in order — that is this file.
#
#   So: Skia is delegated to gn + ninja against build-tools/skia-src (whose
#   out/macos-arm64/args.gn is the pinned configuration), and curl is delegated
#   to build-tools/curl-src/build-static.sh. This script applies the required
#   local patch, runs those, and copies the products into vendor/.
#
#   HONEST BOUNDARY — SDL2. There is no build-tools/sdl2-src tree on this
#   machine (the macOS SDL2 artifacts were produced by a manual `configure` run
#   whose source directory is gone), so SDL2 cannot be rebuilt from this script
#   and this script does NOT pretend otherwise: it reports the gap, names the
#   version to fetch, and exits non-zero when SDL2 was asked for explicitly.
#   Writing a recipe for a tree that does not exist would be inventing a
#   procedure nobody has ever run.
#
# Prerequisites (checked up front, each failure names what to install):
#   * Xcode command line tools (clang, patch, xcrun)
#   * git + python3           — Skia's git-sync-deps / fetch-gn / fetch-ninja
#   * cmake                   — nghttp2 inside curl-src/build-static.sh
#   * build-tools/skia-src    — the full Skia m124 source tree, NOT in this git
#                               repository (the repo root is as3compiler/; see
#                               the tree's own out/macos-arm64/args.gn)
#
# Usage:
#   sh vendor/provision/macos.sh                  # skia + curl (+ SDL2 note)
#   sh vendor/provision/macos.sh --only curl      # just one package
#   sh vendor/provision/macos.sh --only skia,curl
#   sh vendor/provision/macos.sh --dry            # print the commands, run none
#
# Everything lands where the build already looks for it:
#   vendor/skia/lib/macos-arm64/*.a     vendor/skia/include/     (must stay 1:1)
#   vendor/curl/{include,lib/macos-arm64}/...
#
# Skia's from-source build is genuinely long (tens of minutes / thousands of C++
# files). That is normal, not a hang. An incremental `ninja` after a patch is
# seconds — see vendor/skia/patches/README.md for the measured incremental case.

set -eu

PROVISION=$(cd "$(dirname "$0")" && pwd)
VENDOR=$(cd "$PROVISION/.." && pwd)                 # .../as3compiler/vendor
ASDIR=$(cd "$VENDOR/.." && pwd)                     # .../as3compiler
REPO=$(cd "$ASDIR/.." && pwd)                       # .../as3compiler-aot
BUILD_TOOLS="$REPO/build-tools"                     # NOT in git (see header)

SKIA_SRC="$BUILD_TOOLS/skia-src"
SKIA_OUT="$SKIA_SRC/out/macos-arm64"
CURL_SRC="$BUILD_TOOLS/curl-src"
SDL2_SRC="$BUILD_TOOLS/sdl2-src"

# Pinned to match the archives already committed under vendor/ (and the Windows
# script's own pins: SDL2 2.32.10 / curl 8.11.1 / nghttp2 1.64.0 / zlib 1.3.1).
SDL2_VERSION=2.32.10

DRY=0
ONLY="skia curl sdl2"

usage() {
  sed -n '2,49p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

# --- output helpers ---------------------------------------------------------
# Same three levels as the Windows script's Write-Step/Write-Ok/Write-Note, so
# the two read alike.
step() { echo; echo "=== $* ==="; }
ok()   { echo "  [ok] $*"; }
info() { echo "  $*"; }
note() { echo "  [warn] $*"; }
die()  { echo "  [fail] $*" >&2; exit 1; }

# Run a command, or just print it under --dry. This is the ONLY place commands
# are executed, so --dry cannot be half-honoured.
run() {
  if [ "$DRY" -eq 1 ]; then
    echo "  [dry] $*"
  else
    "$@"
  fi
}

# --- arguments --------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --only)   ONLY=${2:?"--only needs a value (skia,sdl2,curl)"}; shift 2 ;;
    --only=*) ONLY=${1#--only=}; shift ;;
    --dry|-n) DRY=1; shift ;;
    -h|--help) usage 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

# Validate --only against the packages this script knows, so a typo is a hard
# error rather than a silently-empty run.
for w in $ONLY; do
  case "$w" in
    skia|sdl2|curl) ;;
    *) die "unknown --only '$w' (expected: skia, sdl2, curl)" ;;
  esac
done

# want <pkg> — is it in the requested set?
want() {
  case ",$(echo "$ONLY" | tr ' ' ',')," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

step "0. 目录"
info "provision:   $PROVISION"
info "vendor:      $VENDOR"
info "build-tools: $BUILD_TOOLS   (not in git)"
info "packages:    $ONLY"
[ "$DRY" -eq 1 ] && info "模式:        --dry（只打印命令）"

# --- 1. prerequisites -------------------------------------------------------
# Each probe reports the ONE thing the user must do. A missing prerequisite is
# a hard error before any work starts -- failing after 40 minutes of Skia
# because cmake was absent would be the kind of late, contextless failure the
# project's "loud, not silent" rule exists to prevent.
step "1. 环境自检"

need() { # need <exe> <how to get it>
  command -v "$1" >/dev/null 2>&1 || die "找不到 '$1' —— $2"
  ok "$1 -> $(command -v "$1")"
}

need git      "安装 Xcode Command Line Tools：xcode-select --install"
need python3  "安装 Xcode Command Line Tools，或 brew install python3"
need cmake    "brew install cmake（curl-src/build-static.sh 用它编 nghttp2）"
need cc       "安装 Xcode Command Line Tools：xcode-select --install"
need patch    "安装 Xcode Command Line Tools：xcode-select --install"

# The source tree is the one prerequisite that is NOT a tool: it is a ~GB
# checkout that deliberately lives outside this repository. Report it as a
# path, not a package name, because there is no package manager that provides it.
if [ -d "$SKIA_SRC" ]; then
  ok "Skia 源码树 -> $SKIA_SRC"
else
  note "缺 Skia 源码树：$SKIA_SRC"
  note "  它刻意不在本仓库里（仓库根是 as3compiler/）。需要时按 docs/zh-cn/skia.md §6.1 取："
  note "    git clone https://skia.googlesource.com/skia.git $SKIA_SRC"
  note "    cd $SKIA_SRC && python3 tools/git-sync-deps && python3 bin/fetch-ninja"
  note "  缺它时只有 skia 步骤会失败，curl 步骤不受影响。"
fi

# --- 2. Skia ----------------------------------------------------------------
# Two things must not be missed here, both documented in-repo:
#   1. the local CoreText patch must be applied (vendor/skia/patches/README.md)
#      — without it, fonts whose family has two files sharing a PostScript name
#      silently swap faces (docs/zh-cn/skia.md §6.9);
#   2. vendor/skia/include/ must stay byte-identical to the source tree's
#      include/ — a mismatch is an ABI break, not a cosmetic one (§6.5).
build_skia() {
  step "2. Skia (gn + ninja, 从 build-tools/skia-src)"
  [ -d "$SKIA_SRC" ] || die "Skia 源码树不存在：${SKIA_SRC}（见上文获取方式）"

  # NOTE for editors: brace every variable that a CJK character follows
  # (`${VAR}（`). In a UTF-8 locale bash treats a fullwidth punctuation mark as
  # an identifier character, so `$VAR（` silently becomes the variable name
  # `VAR（`, and `set -u` kills the run with "unbound variable".
  if [ ! -f "$SKIA_OUT/build.ninja" ]; then
    die "没有生成过 $SKIA_OUT —— 先跑：cd $SKIA_SRC && bin/gn gen out/macos-arm64\n" \
        "  （args.gn 的钉死配置已在该目录里，本脚本不改它）"
  fi
  ok "复用既有 out 目录（args.gn 是钉死的 m124 + Metal 配置）"

  # Apply the patch only when the tree does not already carry it: `patch -p1
  # --dry-run` succeeding means it is still clean. Re-applying would fail the
  # whole run over a no-op, which is not a real problem.
  PATCH="$VENDOR/skia/patches/skia-m124-ct-exact-copy-keep-face.patch"
  if [ -f "$PATCH" ]; then
    if (cd "$SKIA_SRC" && patch -p1 --dry-run --forward < "$PATCH" >/dev/null 2>&1); then
      info "打本地补丁 $(basename "$PATCH")（干净源码树）"
      (cd "$SKIA_SRC" && run patch -p1 < "$PATCH")
    else
      ok "本地补丁已在该树上（跳过）"
    fi
  else
    note "未找到补丁 $PATCH —— 产物将不含 CoreText 换脸修复（docs/zh-cn/skia.md §6.9）"
  fi

  info "ninja (长时间，数千个 C++ 文件属正常)"
  (cd "$SKIA_SRC" && run ninja -C out/macos-arm64)

  # 1:1 library set. Copying exactly the .a files keeps the vendored set equal
  # to what air-app.ts's link-libs list names -- a superset or subset would
  # break that list's correspondence. icudtl.dat is deliberately NOT copied:
  # macOS reaches ICU through the vendored libicu.a, and the committed vendor
  # set has no icudtl.dat (Windows is the platform that needs the sidecar file).
  [ "$DRY" -eq 1 ] && { info "[dry] 拷贝 $SKIA_OUT/*.a -> $VENDOR/skia/lib/macos-arm64/"; return; }
  n=0
  for a in "$SKIA_OUT"/*.a; do
    [ -e "$a" ] || die "out 目录里没有 .a 产物：$SKIA_OUT"
    cp "$a" "$VENDOR/skia/lib/macos-arm64/"
    n=$((n + 1))
  done
  ok "拷贝 $n 个 .a -> vendor/skia/lib/macos-arm64/"

  # The header/library lockstep check, run for real rather than described.
  if diff -rq "$VENDOR/skia/include" "$SKIA_SRC/include" >/dev/null 2>&1; then
    ok "vendor/skia/include 与源码树逐字节一致（§6.5 的判据）"
  else
    die "vendor/skia/include 与 $SKIA_SRC/include 不一致 —— 这是 ABI 断裂，不是外观问题" \
        "（docs/zh-cn/skia.md §6.5）。两份必须同步更新。"
  fi
}

# --- 3. curl stack ----------------------------------------------------------
# The recipe lives in build-tools/curl-src/build-static.sh, which builds zlib +
# nghttp2 + curl with a SecureTransport (no OpenSSL) TLS backend and installs
# into curl-src/prefix/. This script only deploys the result.
build_curl() {
  step "3. curl 三件套 (zlib + nghttp2 + curl)"
  [ -f "$CURL_SRC/build-static.sh" ] || die "找不到 $CURL_SRC/build-static.sh"

  (cd "$CURL_SRC" && run sh build-static.sh)

  [ "$DRY" -eq 1 ] && { info "[dry] 部署 $CURL_SRC/prefix/{include,lib} -> $VENDOR/curl/"; return; }
  [ -f "$CURL_SRC/prefix/lib/libcurl.a" ] || die "build-static.sh 没有产出 $CURL_SRC/prefix/lib/libcurl.a"

  mkdir -p "$VENDOR/curl/lib/macos-arm64"
  cp -R "$CURL_SRC/prefix/include" "$VENDOR/curl/"
  for a in libcurl.a libnghttp2.a libz.a; do
    [ -f "$CURL_SRC/prefix/lib/$a" ] || die "缺 $CURL_SRC/prefix/lib/$a"
    cp "$CURL_SRC/prefix/lib/$a" "$VENDOR/curl/lib/macos-arm64/"
  done
  ok "部署 curl 头 + libcurl/libnghttp2/libz -> vendor/curl/"
}

# --- 4. SDL2 ----------------------------------------------------------------
# Reported, never faked: there is no source tree, so there is no recipe.
# A full run treats it as a warning (skia + curl still succeeded); asking for
# SDL2 *alone* exits non-zero, because a run whose only request silently
# produced nothing would look like success — the failure mode §1.5 forbids.
SDL2_UNBUILDABLE=0
report_sdl2() {
  step "4. SDL2"
  if [ -d "$SDL2_SRC" ]; then
    note "$SDL2_SRC 存在，但本脚本尚无 SDL2 配方 —— 不猜步骤，请手工 configure 并把"
    note "产物按 vendor/sdl2/{lib,include}/macos-arm64/ 的既有布局落盘。"
    return
  fi
  SDL2_UNBUILDABLE=1
  note "无法重建：没有 ${SDL2_SRC}（macOS 那套 SDL2 是手工 configure 编的，源码树已不在本机）"
  note "  vendor/sdl2/lib/macos-arm64/ 里现有产物本身可用，本脚本不会动它。"
  note "  真要重建：取 SDL2 $SDL2_VERSION 源码，configure --enable-static --disable-shared，"
  note "  按 vendor/sdl2/{include,lib}/macos-arm64/ 的既有形状部署（SDL_config.h 是逐平台生成的，"
  note "  必须与 .a 同批更新）。"
  note "  注意 vendor/sdl2/ 里还有 licenses/ 与 share/，形状见 tests 的 build/VendorLayout 钉子。"
}

# --- run --------------------------------------------------------------------
if want skia; then build_skia; fi
if want curl; then build_curl; fi
if want sdl2; then report_sdl2; fi

# --- summary ----------------------------------------------------------------
step "完成"
[ "$DRY" -eq 1 ] && { info "（--dry：什么都没写盘）"; exit 0; }
for p in skia/lib/macos-arm64 curl/lib/macos-arm64 sdl2/lib/macos-arm64; do
  full="$VENDOR/$p"
  if [ -d "$full" ]; then
    cnt=$(find "$full" -type f | wc -l | tr -d ' ')
    ok "$p  ($cnt 个文件)"
  else
    note "$p 不存在"
  fi
done

cat <<'EOF'

下一步：
  * 改过 vendor/ 里的库之后，跑 `as-aot doctor` 复核本机环境与库的对应关系，
    再跑 `node test.ts`（其中 [skia-abi] 组会逐字节核对头文件与源码树，缺源码树时打 SKIP）。
  * Skia 的 include/ 与 lib/ 必须同批更新（docs/zh-cn/skia.md §6.5）——只换库会得到
    「栈上少 16 字节」这类 SIGSEGV，而不是一个能看懂的报错。
EOF

# `--only sdl2` was the whole request and nothing was produced: that is a
# failure, not a warning.
if [ "$SDL2_UNBUILDABLE" -eq 1 ] && [ "$(echo "$ONLY" | tr -d ' ')" = "sdl2" ]; then
  die "本次只要求 sdl2，而它无法在本机重建（见上）。没有任何产物落盘。"
fi
