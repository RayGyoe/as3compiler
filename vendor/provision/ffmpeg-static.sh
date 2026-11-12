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
#   ./ffmpeg-static.sh [air|mid|broad|all] [--no-publish]     # default: broad + publish
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
# Windows note: the MINGW branch below assumes an MSYS2/MinGW shell. It is NOT reachable from
# vendor/provision/windows.ps1, whose clang-cl + MSVC ABI toolchain FFmpeg has no build system
# for. Do not "just add -Only video" to that script and assume it works.
set -euo pipefail

PROFILE=broad
PUBLISH=1
for a in "$@"; do
  case "$a" in
    --no-publish) PUBLISH=0 ;;
    air|mid|broad|all) PROFILE="$a" ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "usage: $0 [air|mid|broad|all] [--no-publish]" >&2; exit 64 ;;
  esac
done

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
FFMPEG_TAG="${ASC_FFMPEG_TAG:-n9.0.2}"
SRC="${ASC_FFMPEG_SRC:-$REPO/build-tools/ffmpeg-src}"
BUILD="$REPO/build-tools/ffmpeg-build/$PROFILE"
OUT="$REPO/build-tools/ffmpeg-out/$PROFILE"

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
    PARSERS=h264,aac,mpegaudio,flv
    ;;
  mid)
    # air + the modern mainstream set; kept only so the size table in docs §3 has a measured
    # middle rung -- not a shipping profile.
    DEMUXERS=mov,flv,matroska,mpegts,mp3,aac,ogg,wav
    DECODERS=h264,hevc,vp8,vp9,vp6f,flv,aac,mp3,opus,vorbis,flac,alac,pcm_s16le
    PARSERS=h264,hevc,vp8,vp9,aac,aac_latm,mpegaudio,flac,opus,vorbis,flv
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
add_hwaccels() {  # $1=space-separated codec list, $2=suffix
  local c
  for c in $1; do
    if has_dec "$c"; then HWACCELS="${HWACCELS:+$HWACCELS,}${c}_$2"; fi
  done
}

# System acceleration used to be opt-in (--enable-videotoolbox) and became opt-out
# (--disable-videotoolbox) in n9. The help text only advertises the form that is *not* the
# default, but configure still accepts --enable-<name> for a known feature on both branches
# (verified on n9.0.2: --disable-autodetect alone leaves CONFIG_VIDEOTOOLBOX at 0, while
# adding --enable-videotoolbox turns it back on). So always pass the explicit enable form.
accel_flag() { printf -- '--enable-%s' "$1"; }
add_accel() { local f; f=$(accel_flag "$1"); [ -n "$f" ] && HW="$HW $f"; return 0; }

case "$(uname -s)" in
  Darwin)
    add_hwaccels "h264 hevc mpeg4 mpeg2 mpeg1 prores vp9 h263" videotoolbox
    add_accel videotoolbox
    TLS=$(accel_flag securetransport)
    PUB_ENC=h264_videotoolbox,aac
    PUB_EXTRA=""
    ;;
  MINGW*|MSYS*|CYGWIN*)
    add_hwaccels "h264 hevc mpeg2 vc1 vp9 av1 wmv3" d3d11va
    add_accel d3d11va
    add_accel dxva2
    TLS=$(accel_flag schannel)
    # MediaFoundation is the only free-as-in-LGPL H.264 encoder on Windows; without it the
    # only option left would be GPL libx264, which docs §8 forbids.
    PUB_ENC=h264_mf,aac
    PUB_EXTRA=$(accel_flag mediafoundation)
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

# libpostproc was removed in n8, so --disable-postproc is gone too. --disable-everything
# already turns the library off on versions that still have it. (Unlike the accel flags, a
# removed library has no --enable- form to fall back on, so this one is probed via --help.)
opt_exists() { "$SRC/configure" --help 2>/dev/null | grep -q -- "$1"; }
POSTPROC=""
if opt_exists "--disable-postproc"; then POSTPROC="--disable-postproc"; fi

# --- publish side (NetStream.publish): flv muxer + H.264 encoder + AAC -------------------
# rtmps rides the TLS backend above; rtmpt uses the in-tree ffrtmphttp (no librtmp needed).
# rtmpe/rtmpte stay OFF: they need ffrtmpcrypt -> GMP, and Adobe retired RTMPE anyway.
if [ "$PUBLISH" = 1 ]; then
  PROTOCOLS=file,http,https,tcp,tls,udp,crypto,rtmp,rtmps,rtmpt,rtsp
  PUB="--enable-muxer=flv --enable-encoder=$PUB_ENC $PUB_EXTRA"
else
  PROTOCOLS=file,http,https,tcp,tls,udp,crypto,rtmp,rtsp
  PUB=""
fi

mkdir -p "$BUILD"
cd "$BUILD"
# shellcheck disable=SC2086  # HW/TLS/PUB are deliberately word-split flag lists
"$SRC/configure" \
  --disable-everything --disable-autodetect \
  --disable-programs --disable-doc --disable-debug \
  --disable-avdevice $POSTPROC --disable-avfilter \
  --disable-encoders --disable-muxers --disable-filters \
  --enable-avformat --enable-avcodec --enable-avutil \
  --enable-swscale --enable-swresample \
  $TLS $HW \
  --enable-protocol="$PROTOCOLS" \
  --enable-demuxer="$DEMUXERS" \
  --enable-decoder="$DECODERS" \
  --enable-parser="$PARSERS" \
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc \
  $PUB

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

FW=""
if [ "$(uname -s)" = Darwin ]; then
  FW="-framework Security -framework CoreFoundation"
  case "$HW" in *videotoolbox*) FW="$FW -framework VideoToolbox -framework CoreMedia -framework CoreVideo" ;; esac
fi

# shellcheck disable=SC2086
cc -O2 -o "$BUILD/probe" "$BUILD/probe.c" -I"$SRC" \
  "$BUILD/libavformat/libavformat.a" "$BUILD/libavcodec/libavcodec.a" \
  "$BUILD/libswresample/libswresample.a" "$BUILD/libswscale/libswscale.a" \
  "$BUILD/libavutil/libavutil.a" $FW -lz -lm -lpthread

cp "$BUILD/probe" "$BUILD/probe.stripped"
strip -x "$BUILD/probe.stripped" 2>/dev/null || strip "$BUILD/probe.stripped"

cp "$BUILD"/libav*/*.a "$BUILD"/libsw*/*.a "$OUT"/ 2>/dev/null || true   # libav* misses libswscale/libswresample
mkdir -p "$OUT/include"
# headers only -- copying the whole libav* dirs drags sources and object trees along (~230 MB)
(cd "$SRC" && find libavcodec libavformat libavutil libswscale libswresample -name '*.h' -print \
   | cpio -pdm "$OUT/include" 2>/dev/null) || true
cp "$SRC/COPYING.LGPLv2.1" "$OUT/" 2>/dev/null || true

printf 'profile=%s publish=%s  linked=%s KB  stripped=%s KB\n' "$PROFILE" "$PUBLISH" \
  "$(( $(stat -f %z "$BUILD/probe" 2>/dev/null || stat -c %s "$BUILD/probe") / 1024 ))" \
  "$(( $(stat -f %z "$BUILD/probe.stripped" 2>/dev/null || stat -c %s "$BUILD/probe.stripped") / 1024 ))"
echo "installed -> $OUT"