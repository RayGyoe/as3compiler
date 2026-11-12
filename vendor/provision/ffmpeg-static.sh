#!/usr/bin/env bash
# ffmpeg-static.sh — build the trimmed static FFmpeg that as3compiler links for
# `flash.net.NetStream` / `flash.media.Video`.
#
# Unlike curl/skia/SDL2, this recipe is IN git on purpose. The flag list below is not a
# build detail: it *is* the design that docs/zh-cn/video.md §3/§6 records (which decoders
# and containers the artifact carries, and which publish pieces survive the trim), and the
# size table in §3/§7 is only reproducible if this file is. A recipe living in an untracked
# build-tools/ tree would make §15's "reproduce it yourself" an empty claim.
#
#   ./ffmpeg-static.sh [air|mid|broad|all] [--no-publish] [--arch=x64|x86] [--disable-x86asm]
#
#                                     default: broad + publish
#                                     Windows arch default: x64 AND x86 (two passes)
#                                     elsewhere: the host's own arch
#
# On Windows _either_ width alone is a fragment: AIR descriptors ask for 32 or 64, so leaving
# --arch out means "build both", not "build the host's". Each pass re-imports that width's
# vcvars environment itself (INCLUDE/LIB are per-arch; the wrong pair is LNK4272), so one
# command from one shell produces both trees -- windows.ps1 still calls in per arch.
#
# Sources: $ASC_FFMPEG_SRC, default <repo>/build-tools/ffmpeg-src. When that directory does
# not exist this script clones the pinned tag ($ASC_FFMPEG_TAG, default n9.0.2) — depth 1,
# tag only, no history. Pinning happens at *clone* time, never by sniffing the working tree:
# an existing checkout is used exactly as checked out, so a deliberate `git checkout` is
# always honoured and never silently reverted.
#
# Profiles only replace the --enable-decoder/demuxer lists; everything else is shared, so the
# sizes in docs/zh-cn/video.md §3/§7 are reproducible by just swapping the argument.
#
# Every profile also carries the **publish** side (NetStream.publish is AIR-defined, so
# dropping it would make the `air` profile narrower than AIR itself): flv muxer + an H.264
# encoder + AAC. The H.264 encoder is always a *hardware* one -- there is no LGPL software
# H.264 encoder in FFmpeg (libx264 is GPL, libopenh264's patent cover only applies to Cisco's
# own binaries), so a host without a usable hw encoder must fail loudly rather than silently
# publish nothing. --no-publish restores the decode-only build (the size reference point in
# docs §3).
#
# ---------------------------------------------------------------------------- artifacts
#
#   macOS    native clang     libav*.a / libsw*.a     -> ffmpeg-out/<profile>/
#   Linux    native cc        libav*.a / libsw*.a     -> ffmpeg-out/<profile>/
#   Windows  MSVC ABI         av*.lib / sw*.lib       -> ffmpeg-out/<profile>-win-<arch>/
#                             (LIBPREF is empty on the msvc toolchain: the archives are
#                              avcodec.lib etc., NOT libavcodec.lib)
#
# ------------------------------------------------------------------- why Windows is MSVC
#
# Windows is MSVC-ABI on purpose, and this is a *hard* constraint, not a preference:
#
#   as3compiler's Windows link line is `clang --target={x86_64,i686}-pc-windows-msvc`
#   (src/build.ts::windowsTargetTriple), and every other vendored archive -- Skia, SDL2,
#   curl -- is MSVC-ABI. A MinGW-built libav*.a carries the GNU ABI (___chkstk_ms,
#   __imp___acrt_iob_func, the mingw CRT), so it does not link against that line at all.
#   The failure surfaces as a wall of unresolved symbols in the *app* link, far from here,
#   which is exactly the silent-wrong-answer class AGENTS.md §1.5 forbids. So: msvc.
#
# WHY --toolchain=msvc NEEDS clang-cl *AND* STILL NEEDS cl.exe (both measured on MSVC 19.43
# + LLVM 23.1, this repository's Windows host):
#
#   * configure's msvc branch probes `cl.exe` for its version gate, so cl.exe must be on
#     PATH even though it is not the compiler doing the work;
#   * MSVC 19.43 no longer honours `-o` (D9035 "deprecated"). configure compiles every test
#     as `-c -o <obj> <src>`, so a real cl.exe drops the object into the CWD and the very
#     first link test dies with `LNK1136: invalid or corrupted file` — the build fails
#     before a single object of FFmpeg is produced;
#   * clang-cl accepts `-c -o`, and it is what windows.ps1 already uses for Skia/SDL2/curl,
#     so the whole vendor tree stays on one compiler with one ABI.
#
# x86 SPECIFICALLY: the x86 build needs the **x86 vcvars environment** (INCLUDE/LIB are
# per-arch). With the x64 environment the link test fails with `LNK4272: library machine
# type "x64" conflicts with target machine type "x86"`. windows.ps1 imports the right
# environment per arch before it calls this script, and a standalone run does the same thing
# itself (vswhere -> vcvarsall -> env dump -> cygpath), so `./ffmpeg-static.sh broad` from a
# plain shell builds both widths. It refuses a half import: without System32 on PATH, VsDevCmd's
# `reg query` silently misses the Windows SDK and the build would die much later at
# 'windows.h' not found / LNK1104 kernel32.lib.
#
# nasm is REQUIRED on Windows: configure refuses outright ("nasm not found or too old")
# rather than degrading, and x86 SIMD kernels are what make H.264 soft decode and swscale
# worthwhile. --disable-x86asm exists only as a deliberate escape hatch and prints a loud
# warning, because a silently scalar build is a performance regression no size table shows.
#
# The shell driving configure on Windows must be a POSIX one (MSYS2 or Cygwin); windows.ps1
# locates one and hard-fails when absent. FFmpeg has no cmd/PowerShell build path.
set -euo pipefail

PROFILE=broad
PUBLISH=1
ARCH=""
X86ASM=1
for a in "$@"; do
  case "$a" in
    --no-publish) PUBLISH=0 ;;
    --arch=*) ARCH="${a#--arch=}" ;;
    --arch) echo "$0: --arch needs a value (x64|x86)" >&2; exit 64 ;;
    --disable-x86asm) X86ASM=0 ;;
    air|mid|broad|all) PROFILE="$a" ;;
    -h|--help) sed -n '2,74p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "usage: $0 [air|mid|broad|all] [--no-publish] [--arch=x64|x86] [--disable-x86asm]" >&2; exit 64 ;;
  esac
done

info() { echo "  $*"; }
warn() { echo "  [warn] $*" >&2; }
die()  { echo "  [fail] $*" >&2; exit 1; }

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
FFMPEG_TAG="${ASC_FFMPEG_TAG:-n9.0.2}"
SRC="${ASC_FFMPEG_SRC:-$REPO/build-tools/ffmpeg-src}"

case "$(uname -s)" in
  Darwin)               PLAT=darwin ;;
  MINGW*|MSYS*|CYGWIN*) PLAT=win ;;
  *)                    PLAT=linux ;;
esac

# --arch is what makes a Windows tree two trees. Elsewhere the builder is native and the
# flag has no meaning, so a stray --arch is an error rather than a silently ignored one
# (an ignored one would put an x86 request into the x64 output directory).
if [ "$PLAT" = win ]; then
  # No --arch on Windows = both widths (see the header). The fan-out happens before any
  # clone/cd/configure, and every child gets an explicit --arch, so it cannot recurse.
  if [ -z "$ARCH" ]; then
    SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
    rc=0
    for _arch in x64 x86; do
      echo "---- $PROFILE / $_arch ----"
      # Keep going after a failure: the two passes fail for different reasons often enough
      # (a missing x86 toolset, an x86-only configure break) that one run should show both.
      "$SELF" "$@" --arch=$_arch || rc=$?
    done
    exit $rc
  fi
  case "$ARCH" in x64|x86) ;; *) die "--arch must be x64 or x86 (got '$ARCH')" ;; esac
  ARCHKEY="win-$ARCH"
else
  [ -n "$ARCH" ] && die "--arch only applies to Windows (MSVC); this host is '$PLAT'"
  ARCHKEY=""
fi

BUILD="$REPO/build-tools/ffmpeg-build/$PROFILE${ARCHKEY:+-$ARCHKEY}"
OUT="$REPO/build-tools/ffmpeg-out/$PROFILE${ARCHKEY:+-$ARCHKEY}"

if [ ! -f "$SRC/configure" ]; then
  echo "ffmpeg-static.sh: no FFmpeg source at $SRC" >&2
  echo "  cloning $FFMPEG_TAG there (depth 1). Set ASC_FFMPEG_SRC to use another tree." >&2
  mkdir -p "$(dirname "$SRC")"
  git clone --depth 1 -b "$FFMPEG_TAG" https://git.ffmpeg.org/ffmpeg.git "$SRC"
fi

# --- per-profile component lists (mirror docs/zh-cn/video.md §6.2) -----------------------
case "$PROFILE" in
  air)
    DEMUXERS=mov,flv,mp3,aac
    DECODERS=h264,aac,mp3,flv,vp6f
    # No `flv` parser: n9 removed it (libavcodec/parsers.c has no ff_flv_parser), so asking
    # for it was a silent no-op. The flv *demuxer* above is what parses the container.
    PARSERS=h264,aac,mpegaudio
    ;;
  mid)
    # air + the modern mainstream set; kept only so the size table in docs §3 has a measured
    # middle rung -- not a shipping profile.
    DEMUXERS=mov,flv,matroska,mpegts,mp3,aac,ogg,wav
    DECODERS=h264,hevc,vp8,vp9,vp6f,flv,aac,mp3,opus,vorbis,flac,alac,pcm_s16le
    PARSERS=h264,hevc,vp8,vp9,aac,aac_latm,mpegaudio,flac,opus,vorbis
    ;;
  broad)
    DEMUXERS=mov,flv,matroska,mpegts,mp3,aac,ogg,wav,avi,asf,mpegps,rm,aiff,caf,w64,ivf,hls,rtsp,sdp
    DECODERS=h264,hevc,mpeg4,mpeg2video,mpeg1video,vp8,vp9,vp6f,vp6a,flv,h263,prores,theora,vc1,wmv3,mjpeg,av1
    DECODERS="$DECODERS,aac,aac_fixed,mp3,mp3float,opus,vorbis,flac,alac,ac3,eac3,dca,truehd,wmav2,nellymoser,adpcm_swf,speex"
    DECODERS="$DECODERS,pcm_s16le,pcm_s24le,pcm_f32le,pcm_mulaw,pcm_alaw"
    PARSERS=h264,hevc,mpeg4video,mpegvideo,vp8,vp9,av1,aac,aac_latm,mpegaudio,flac,opus,vorbis,ac3,dca,h263
    ;;
  all)
    # broad + VVC + external AV1 (libdav1d) + DASH (libxml2). Untested: needs those deps built.
    echo "ffmpeg-static.sh: 'all' profile needs libdav1d and libxml2 prebuilt; not wired yet" >&2
    exit 2
    ;;
esac

# --- platform hwaccel (the soft decoders are always kept as fallback) --------------------
# A hwaccel entry *depends on* its decoder, so the list must be intersected with the profile:
# blindly enabling vp9_videotoolbox drags the whole vp9 decoder into an otherwise H.264-only build.
has_dec() { case ",$DECODERS," in *",$1,"*) return 0 ;; esac; return 1; }
HW=""
HWACCELS=""
# The hwaccel name is not always "<decoder>_<suffix>": the MPEG-picture decoders are
# mpeg2video/mpeg1video while their hwaccels are mpeg2_*/mpeg1_*. Without this map the
# intersection below drops them from the request (`has_dec mpeg2` is false) and configure
# says nothing: on Windows MPEG2_D3D11VA_HWACCEL/DXVA2 stayed 0 even though both names were
# in the list, and the *only* symptom would have been MPEG-2 falling back to software
# decode forever. (The framework flag --enable-d3d11va does not turn per-codec hwaccels on
# by itself; each one has to be named.)
hw_base() {
  case "$1" in
    mpeg2video) echo mpeg2 ;;
    mpeg1video) echo mpeg1 ;;
    *) echo "$1" ;;
  esac
}
add_hwaccels() {  # $1=space-separated DECODER names, $2=hwaccel suffix
  local c
  for c in $1; do
    if has_dec "$c"; then HWACCELS="${HWACCELS:+$HWACCELS,}$(hw_base "$c")_$2"; fi
  done
}

# System acceleration used to be opt-in (--enable-videotoolbox) and became opt-out
# (--disable-videotoolbox) in n9. The help text only advertises the form that is *not* the
# default, but configure still accepts --enable-<name> for a known feature on both branches
# (verified on n9.0.2: --disable-autodetect alone leaves CONFIG_VIDEOTOOLBOX at 0, while
# adding --enable-videotoolbox turns it back on). So always pass the explicit enable form.
accel_flag() { printf -- '--enable-%s' "$1"; }
add_accel() { local f; f=$(accel_flag "$1"); [ -n "$f" ] && HW="$HW $f"; return 0; }

CC_NAME=cc
CXX_NAME=c++
EXTRA_CC=""
CONF_PLATFORM=""   # extra configure args for the Windows/msvc path
CONF_ARCH=""

case "$PLAT" in
  darwin)
    add_hwaccels "h264 hevc mpeg4 mpeg2video mpeg1video prores vp9 h263" videotoolbox
    add_accel videotoolbox
    TLS=$(accel_flag securetransport)
    PUB_ENC=h264_videotoolbox,aac
    PUB_EXTRA=""
    ;;
  win)
    # Only hwaccels that exist on the d3d side: h263/mpeg1/mpeg4/prores have VideoToolbox
    # hwaccels but no d3d11va/dxva2 counterpart in n9 (hwaccels.h is the reference), so they
    # are deliberately absent rather than requested-and-dropped.
    add_hwaccels "h264 hevc mpeg2video vc1 vp9 av1 wmv3" d3d11va
    add_hwaccels "h264 hevc mpeg2video vc1 vp9 av1 wmv3" dxva2
    add_accel d3d11va
    add_accel dxva2
    TLS=$(accel_flag schannel)
    # MediaFoundation is the only free-as-in-LGPL H.264 encoder on Windows; without it the
    # only option left would be GPL libx264, which docs §8 forbids.
    PUB_ENC=h264_mf,aac
    PUB_EXTRA=$(accel_flag mediafoundation)
    CONF_PLATFORM="--toolchain=msvc --target-os=win32"
    if [ "$ARCH" = x86 ]; then CONF_ARCH="--arch=x86"; else CONF_ARCH="--arch=x86_64"; fi
    ;;
  *)
    add_hwaccels "h264 hevc vp9 av1 vc1 mpeg2 wmv3" vaapi
    add_accel vaapi
    TLS=""   # https gets no TLS backend unless gnutls/openssl is available
    # VAAPI needs a usable render node; there is no fallback software encoder by design,
    # so a headless build host must pass --no-publish instead of getting a silent gap.
    PUB_ENC=h264_vaapi,aac
    PUB_EXTRA=""
    ;;
esac
if [ -n "$HWACCELS" ]; then HW="$HW --enable-hwaccel=$HWACCELS"; fi

# --- Windows toolchain gate (loud, before any 20-minute build) ---------------------------
# MSVC's INCLUDE/LIB are per-arch: an x86 target holding x64's libcmt.lib is LNK4272. windows.ps1
# imports per arch already, but the recipe has to stand on its own too -- otherwise the second
# half of the default "both widths" pass would fail at link time for an unrelated-looking
# reason. These two helpers let one command from one plain shell build both widths.
find_vcvarsall() {  # prints a Windows-form path (what cmd.exe wants)
  local pf vs p
  if [ -n "${VCINSTALLDIR:-}" ]; then
    vs="$VCINSTALLDIR\\VC\\Auxiliary\\Build\\vcvarsall.bat"
    if [ -f "$(cygpath -u "$vs")" ]; then printf '%s\n' "$vs"; return 0; fi
  fi
  for pf in "$(printenv 'ProgramFiles(x86)')" "$(printenv ProgramFiles)"; do
    [ -n "$pf" ] || continue
    vs="$pf\\Microsoft Visual Studio\\Installer\\vswhere.exe"
    [ -f "$(cygpath -u "$vs")" ] || continue
    p=$("$vs" -latest -products '*' -property installationPath 2>/dev/null | tr -d '\r' | head -1)
    [ -n "$p" ] || continue
    vs="$p\\VC\\Auxiliary\\Build\\vcvarsall.bat"
    if [ -f "$(cygpath -u "$vs")" ]; then printf '%s\n' "$vs"; return 0; fi
  done
  return 1
}

ensure_vcvars_env() {  # $1 = x64|x86; returns 0 when this shell is (now) set up for that arch
  local want="$1" vcvarsall vdir cmdpath dump winpath oldpath keep d line name val
  [ "${VSCMD_ARG_TGT_ARCH:-}" = "$want" ] && return 0          # already right (ps1 path)
  command -v cygpath >/dev/null 2>&1 || return 1
  vcvarsall=$(find_vcvarsall) || return 1
  vdir=$(dirname "$(cygpath -u "$vcvarsall")")
  cmdpath=$(cygpath -u "${COMSPEC:-C:\Windows\System32\cmd.exe}" 2>/dev/null) || return 1
  [ -n "$cmdpath" ] || return 1
  local sysroot
  if ! command -v reg >/dev/null 2>&1; then
    # VsDevCmd finds the Windows SDK with `reg query`; with no System32 on PATH that lookup
    # fails **silently** -- INCLUDE/LIB then carry MSVC only, and the build dies much later as
    # "'windows.h' file not found" then "LNK1104: cannot open kernel32.lib". Measured here:
    # identical command, SDK present with System32 on PATH and absent without it.
    sysroot=$(cygpath -u "${SystemRoot:-C:\\Windows}")
    PATH="$sysroot/System32:$sysroot/System32/Wbem:$PATH"
  fi
  # The command string carries NO path with a space, on purpose: Cygwin/MSYS2 escape quotes for
  # Windows children the MSVCRT way (\"...\") and cmd.exe does not understand that, so passing
  # "C:\Program Files\...\vcvarsall.bat" yields '\"C:\Program Files\...\"' is not recognized.
  # cd-ing into the batch's own directory and calling it by bare name needs no quotes at all.
  # (cmd //c, not /c: MSYS2/Cygwin would otherwise turn /c into a path.)
  dump=$( ( cd "$vdir" && "$cmdpath" //c "vcvarsall.bat $want >nul 2>&1 && set" ) 2>/dev/null | tr -d '\r' ) || return 1
  [ -n "$dump" ] || return 1
  winpath=$(printf '%s\n' "$dump" | sed -n 's/^PATH=//p' | tail -1)
  [ -n "$winpath" ] || return 1
  oldpath="$PATH"
  while IFS= read -r line; do
    case "$line" in *=*) ;; *) continue ;; esac
    name=${line%%=*}
    val=${line#*=}
    case "$name" in ''|PATH) continue ;; esac
    case "$name" in *[!A-Za-z0-9_]*) continue ;; esac
    export "$name=$val"
  done <<< "$dump"
  # PATH is the one variable bash itself resolves commands through, so it comes back in POSIX
  # form -- but vcvars' PATH has no /usr/bin, and without it make/nasm would "vanish" right
  # after the import. Re-attach the POSIX entries this shell already had.
  PATH="$(cygpath -p -u "$winpath")"
  keep=""
  for d in $(printf '%s' "$oldpath" | tr ':' '\n'); do
    case "$d" in /*) keep="$keep:$d" ;; esac
  done
  export PATH="$PATH$keep"
  # A half-imported environment is worse than none: MSVC without the SDK looks like a working
  # setup until the first #include <windows.h>. Refuse it here, where the cause is still visible.
  case "${INCLUDE:-}" in
    *Windows\ Kits*) ;;
    *) return 2 ;;
  esac
  info "已导入 vcvars $want 环境（自动）"
  return 0
}

if [ "$PLAT" = win ]; then
  have() { command -v "$1" >/dev/null 2>&1; }

  vcrc=0
  ensure_vcvars_env "$ARCH" || vcrc=$?
  case "$vcrc" in
    0) ;;
    2) die "vcvars $ARCH 导入成功，但 INCLUDE 里没有 Windows SDK（只有 MSVC）：半导入的环境比没有更糟。
  常见原因是 shell 的 PATH 上没有 C:\\Windows\\System32——VsDevCmd 用 reg query 找 SDK，失败也不报错。
  把 System32 加进 PATH 重试，或用 windows.ps1 -Only video（它在完整 PATH 上导入）。" ;;
    *) die "无法自动导入 $ARCH 的 MSVC 环境（找不到 vcvarsall.bat，或这个 shell 没有 cygpath）。
  手工：在 cmd 里跑 \"<VS>\\VC\\Auxiliary\\Build\\vcvarsall.bat $ARCH\"，在同一 shell 里再执行本脚本；
  或用 windows.ps1 -Only video（它本来就逐位宽导入环境）。
  绝不能拿另一个位宽的环境凑——那会以 LNK4272 的形式在链接期才爆。" ;;
  esac

  # clang-cl lives outside vcvars' PATH; a standalone run should not have to pre-arrange it.
  if ! have clang-cl; then
    for d in "/c/Program Files/LLVM/bin" "/c/Program Files (x86)/LLVM/bin"; do
      [ -x "$d/clang-cl.exe" ] || continue
      export PATH="$d:$PATH"
      info "clang-cl 不在 PATH 上，已临时加入 $d"
      break
    done
  fi

  # cl.exe: only for configure's msvc version gate — but without it configure dies
  # "Unsupported MSVC version", with no hint that a compiler it never uses is the cause.
  have cl.exe || die "cl.exe is not on PATH. Windows builds are MSVC-ABI; import the arch's
  vcvarsall environment first (windows.ps1 does this per arch). FFmpeg has no MSVC-free
  Windows build system, and a MinGW build would not link against this project's
  --target=*-msvc link line."
  have lib.exe || die "lib.exe is not on PATH (it is the archiver: AR=lib.exe on the msvc
  toolchain). It ships with MSVC; import vcvarsall for this arch."
  have clang-cl || die "clang-cl is not on PATH (LLVM). It is the actual compiler:
  MSVC's cl does not honour -c -o (D9035), which breaks configure's first link test.
  windows.ps1 prepends \$LlvmRoot\\bin; by hand, add LLVM's bin to PATH."
  if [ "$X86ASM" = 1 ]; then
    have nasm || die "nasm is not on PATH. configure refuses to build x86 asm without it
  ('nasm not found or too old'), and the scalar fallback is a real performance regression
  for h264 soft decode and swscale. Install nasm (choco install nasm / pacman -S nasm),
  or pass --disable-x86asm deliberately."
  else
    warn "--disable-x86asm: x86 SIMD kernels are OFF (scalar h264/swscale). Size tables stay
  comparable, frame times do not."
  fi

  # Spelled out for both arches (not just x86): the triple is what makes the objects
  # x86_64-pc-windows-msvc regardless of which clang-cl build happens to be first on PATH.
  if [ "$ARCH" = x86 ]; then
    EXTRA_CC="--target=i686-pc-windows-msvc"
  else
    EXTRA_CC="--target=x86_64-pc-windows-msvc"
  fi
  CC_NAME=clang-cl
  CXX_NAME=clang-cl
fi

# libpostproc was removed in n8, so --disable-postproc is gone too. --disable-everything
# already turns the library off on versions that still have it. (Unlike the accel flags, a
# removed library has no --enable- form to fall back on, so this one is probed via --help.)
opt_exists() { "$SRC/configure" --help 2>/dev/null | grep -q -- "$1"; }
POSTPROC=""
if opt_exists "--disable-postproc"; then POSTPROC="--disable-postproc"; fi

# --- publish side (NetStream.publish): flv muxer + H.264 encoder + AAC -------------------
# rtmps rides the TLS backend above; rtmpt uses the in-tree ffrtmphttp (no librtmp needed).
# rtmpe/rtmpte stay OFF: they need ffrtmpcrypt -> GMP, and Adobe retired RTMPE anyway.
# RTSP is a *demuxer*, not a protocol: `--enable-protocol=rtsp` is a silent no-op (configure
# accepts the name and enables nothing), so it is not listed here — the demuxer is in
# DEMUXERS above, which is where RTSP support actually comes from.
if [ "$PUBLISH" = 1 ]; then
  PROTOCOLS=file,http,https,tcp,tls,udp,crypto,rtmp,rtmps,rtmpt
  PUB="--enable-muxer=flv --enable-encoder=$PUB_ENC $PUB_EXTRA"
else
  PROTOCOLS=file,http,https,tcp,tls,udp,crypto,rtmp
  PUB=""
fi

# x86 asm off only when explicitly asked; on Windows the gate above already refused when
# nasm was missing. On macOS/Linux the assembler is native and --disable-x86asm is inert.
ASM_FLAG=""
if [ "$PLAT" = win ] && [ "$X86ASM" = 0 ]; then ASM_FLAG="--disable-x86asm"; fi

mkdir -p "$BUILD"
cd "$BUILD"
# The configure line is assembled as an ARRAY rather than a shell string: `--cc` carries a
# space ("clang-cl --target=..."), and unquoted expansion would split it into two options
# (configure then dies with `Unknown option "x86_64"`). Everything else stays one token.
CONF=(
  --disable-everything --disable-autodetect
  --disable-programs --disable-doc --disable-debug
  --disable-avdevice --disable-avfilter
  --disable-encoders --disable-muxers --disable-filters
  --enable-avformat --enable-avcodec --enable-avutil
  --enable-swscale --enable-swresample
  "--enable-protocol=$PROTOCOLS"
  "--enable-demuxer=$DEMUXERS"
  "--enable-decoder=$DECODERS"
  "--enable-parser=$PARSERS"
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc
)
if [ -n "$POSTPROC" ]; then CONF+=("$POSTPROC"); fi
if [ -n "$CONF_PLATFORM" ]; then
  # shellcheck disable=SC2206  # "--toolchain=msvc --target-os=win32": two deliberate tokens
  CONF+=($CONF_PLATFORM)
fi
if [ -n "$CONF_ARCH" ]; then CONF+=("$CONF_ARCH"); fi
if [ -n "$ASM_FLAG" ]; then CONF+=("$ASM_FLAG"); fi
if [ -n "$TLS" ]; then CONF+=("$TLS"); fi
if [ -n "$HW" ]; then
  # shellcheck disable=SC2206  # "--enable-d3d11va --enable-hwaccel=h264_d3d11va,...": several tokens
  CONF+=($HW)
fi
if [ -n "$PUB" ]; then
  # shellcheck disable=SC2206  # "--enable-muxer=flv --enable-encoder=h264_mf,aac"
  CONF+=($PUB)
fi
# Windows names the compiler explicitly (clang-cl + triple); everywhere else the native
# toolchain is left exactly as configure would pick it, so the macOS recipe that the size
# table in docs §7 was measured with is unchanged by this file's Windows support.
if [ "$PLAT" = win ]; then
  CONF+=("--cc=$CC_NAME $EXTRA_CC" "--cxx=$CXX_NAME $EXTRA_CC")
fi
"$SRC/configure" "${CONF[@]}"

# configure drops an explicitly enabled component whose deps are unmet and only *warns*.
# That is how a hwaccel silently vanishes (docs §6.3), so both halves are asserted here:
# a build that cannot decode in hardware (when asked) or cannot encode must not pretend it can.
check_on() {  # $1=CONFIG macro, $2=human name
  grep -q "^#define $1 1" config_components.h || {
    echo "ffmpeg-static.sh: $2 was disabled by configure." >&2
    echo "  install the platform deps, or rebuild with --no-publish for a decode-only library." >&2
    exit 3
  }
}
if [ -n "$HWACCELS" ]; then
  first_hw=$(printf '%s' "$HWACCELS" | cut -d, -f1 | tr 'a-z' 'A-Z')
  grep -q "^#define CONFIG_${first_hw}_HWACCEL 1" config_components.h || {
    echo "ffmpeg-static.sh: no hardware decoder is enabled although $HWACCELS was requested." >&2
    echo "  hardware decode would silently not exist; check the configure flags." >&2
    exit 3
  }
fi
if [ "$PUBLISH" = 1 ]; then
  check_on CONFIG_FLV_MUXER "the flv muxer"
  check_on CONFIG_AAC_ENCODER "the aac encoder"
  case "$PUB_ENC" in
    h264_videotoolbox,*) check_on CONFIG_H264_VIDEOTOOLBOX_ENCODER "h264_videotoolbox" ;;
    h264_mf,*)           check_on CONFIG_H264_MF_ENCODER "h264_mf (MediaFoundation)" ;;
    h264_vaapi,*)        check_on CONFIG_H264_VAAPI_ENCODER "h264_vaapi" ;;
  esac
fi
# Bitness is asserted, not assumed: the x86 build differs from the x64 one only by the
# vcvars environment and the clang target triple, and getting either wrong still *builds*
# (just for the other architecture), which no component assertion above would catch.
if [ "$PLAT" = win ]; then
  if [ "$ARCH" = x86 ]; then want_arch=ARCH_X86_32; else want_arch=ARCH_X86_64; fi
  grep -q "^#define $want_arch 1" config.h || {
    echo "ffmpeg-static.sh: this configure resolved to the wrong architecture." >&2
    echo "  expected $want_arch (arch=$ARCH). Check that the imported vcvars environment" >&2
    echo "  matches the requested arch and that the clang --target triple took effect." >&2
    exit 3
  }
fi

make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 8)"

# --- measure: link a probe with the same reference shape as video_glue.c ----------------
# The shape covers BOTH directions (open/read for playback, alloc_output_context2 +
# find_encoder for publish) so a publish and a --no-publish build are directly comparable:
# static archives only pull referenced members, so an un-referenced muxer would otherwise
# be invisible here and the two numbers would silently measure different programs.
mkdir -p "$OUT"
cat > "$BUILD/probe.c" <<'EOF'
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>
#include <stdio.h>
int main(void) {
  AVFormatContext *f = NULL;
  if (avformat_open_input(&f, "none.mp4", NULL, NULL) < 0) { }
  const AVCodec *c = avcodec_find_decoder(AV_CODEC_ID_H264);
  /* publish: flv muxer + h264/aac encoders */
  const AVCodec *ev = avcodec_find_encoder(AV_CODEC_ID_H264);
  const AVCodec *ea = avcodec_find_encoder(AV_CODEC_ID_AAC);
  AVFormatContext *o = NULL;
  avformat_alloc_output_context2(&o, NULL, "flv", "rtmp://x/y");
  AVStream *s = o ? avformat_new_stream(o, ev) : NULL;
  if (s) { s->codecpar->codec_id = AV_CODEC_ID_H264; }
  int h = o ? avformat_write_header(o, NULL) : 0;
  void *sc = sws_getContext(2, 2, AV_PIX_FMT_BGRA, 2, 2, AV_PIX_FMT_NV12, 0, NULL, NULL, NULL);
  struct SwrContext *sw = swr_alloc();
  printf("%p %p %p %p %p %d\n", (void*)c, (void*)sc, (void*)sw, (void*)f, (void*)ea, h);
  return 0;
}
EOF

# Archive names come from the toolchain, not from this script: the msvc toolchain sets
# LIBPREF= (empty) and LIBSUF=.lib, so Windows archives are avcodec.lib while every other
# platform has libavcodec.a. Reading them back out of config.mak keeps that honest.
LIBPFX=$(sed -n 's/^LIBPREF=//p' ffbuild/config.mak | head -1)
LIBEXT=$(sed -n 's/^LIBSUF=//p'  ffbuild/config.mak | head -1)
FFLIBS="avformat avcodec swresample swscale avutil"
probe_inputs=""
for l in $FFLIBS; do probe_inputs="$probe_inputs $BUILD/lib$l/${LIBPFX}${l}${LIBEXT}"; done

if [ "$PLAT" = win ]; then
  # System libraries are read back from config.mak (EXTRALIBS-<lib>) instead of being
  # hard-coded: they change with the enabled hwaccels and TLS backend (schannel pulls
  # secur32/ncrypt/crypt32, mediafoundation pulls mfuuid/strmiids), and a stale list here
  # would show up as a link failure in the probe long after the flag change that caused it.
  SYSLIBS=$(sed -n 's/^EXTRALIBS-[a-z]*=//p' ffbuild/config.mak | tr ' ' '\n' \
            | awk 'NF && !seen[$0]++' | tr '\n' ' ')
  # shellcheck disable=SC2086
  "$CC_NAME" $EXTRA_CC -nologo -O2 -o "$BUILD/probe.exe" "$BUILD/probe.c" -I"$SRC" \
    $probe_inputs $SYSLIBS || die "probe link failed — see the link errors above (a missing
  system lib shows up here first; config.mak's EXTRALIBS-* lines are the reference)"
  cp "$BUILD/probe.exe" "$BUILD/probe.stripped"
  # MSVC has no strip; LLVM's llvm-strip handles PE, and is absent on purpose-built hosts.
  if command -v llvm-strip >/dev/null 2>&1; then
    llvm-strip "$BUILD/probe.stripped" 2>/dev/null || true
  fi
else
  FW=""
  if [ "$(uname -s)" = Darwin ]; then
    FW="-framework Security -framework CoreFoundation"
    case "$HW" in *videotoolbox*) FW="$FW -framework VideoToolbox -framework CoreMedia -framework CoreVideo" ;; esac
  fi
  # shellcheck disable=SC2086
  cc -O2 -o "$BUILD/probe" "$BUILD/probe.c" -I"$SRC" $probe_inputs $FW -lz -lm -lpthread
  cp "$BUILD/probe" "$BUILD/probe.stripped"
  strip -x "$BUILD/probe.stripped" 2>/dev/null || strip "$BUILD/probe.stripped"
fi

for l in $FFLIBS; do cp "$BUILD/lib$l/${LIBPFX}${l}${LIBEXT}" "$OUT/"; done
mkdir -p "$OUT/include"
# headers only -- copying the whole libav* dirs drags sources and object trees along (~230 MB)
if command -v cpio >/dev/null 2>&1; then
  (cd "$SRC" && find libavcodec libavformat libavutil libswscale libswresample -name '*.h' -print \
     | cpio -pdm "$OUT/include" 2>/dev/null) || true
else
  # cpio is not part of every POSIX shell on Windows; tar is.
  (cd "$SRC" && find libavcodec libavformat libavutil libswscale libswresample -name '*.h' -print \
     | tar cf - -T - 2>/dev/null) | tar xf - -C "$OUT/include" 2>/dev/null || true
fi
# avconfig.h is *generated by configure* into the build dir, so it is not in the source
# tree that the find above walks. Without it `#include <libavutil/avutil.h>` fails on
# common.h's include of it — the header tree would look complete and still not compile.
cp "$BUILD/libavutil/avconfig.h" "$OUT/include/libavutil/avconfig.h"
cp "$SRC/COPYING.LGPLv2.1" "$OUT/" 2>/dev/null || true

# `stat` 在几个平台的方言不同，而且失败时**照样往 stdout 写东西**：MSYS2（GNU coreutils）的
# `stat -f %z` 会把 "  File: ...\nBlocks: ..." 这类文件系统信息打到 stdout（stderr 才是报错），
# 于是旧写法 `stat -f %z || stat -c %s` 的捕获值是「一堆文本 + 真正的数字」，进算术后
# bash 报 `File: unbound variable`（set -u 下算术里的未定义标识符）。所以：先 `-c %s`（GNU/Linux/
# MSYS2），不成功再 `-f %z`（BSD/macOS），最后**校验结果是不是纯数字**，不是就归 0。
probe_size() {
  local n
  n=$(stat -c %s "$1" 2>/dev/null)
  case "$n" in ''|*[!0-9]*) n=$(stat -f %z "$1" 2>/dev/null) ;; esac
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  printf '%s' "$n"
}
if [ "$PLAT" = win ]; then PROBE_BIN="$BUILD/probe.exe"; else PROBE_BIN="$BUILD/probe"; fi
printf 'profile=%s publish=%s%s  linked=%s KB  stripped=%s KB\n' "$PROFILE" "$PUBLISH" \
  "${ARCHKEY:+ arch=$ARCH}${ASM_FLAG:+ (no x86asm)}" \
  "$(( $(probe_size "$PROBE_BIN") / 1024 ))" \
  "$(( $(probe_size "$BUILD/probe.stripped") / 1024 ))"
echo "installed -> $OUT"