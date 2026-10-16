#!/bin/sh
# run-adl-ui.sh — 用 AIR `adl` 跑 TextField 的 **UI 网格**（Main.as 的 ui 模式），
# 产出 temp/textfield-oracle-ui/adl.raw。配套 run-aot-ui.sh 出 aot.raw，再由
# examples/textfield/grid.py 拼成并排对照图。
#
#   AIRSDK_HOME=/path/to/AIRSDK examples/textfield/run-adl-ui.sh
#
# 与 run-adl.sh 的区别只有两点：编的是文档类 UiMain.as（无参构造 ⇒ super(true)），
# 收的文件多一个 textfield-grid.raw。窗口仍然 visible=false —— 网格是
# BitmapData.draw(this) 离屏光栅化的，不需要窗口，也不弹窗。
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
AIRSDK=${AIRSDK_HOME:-$HOME/Documents/Software/AIRSDK/AIRSDK_51.4.1}
OUT="$ROOT/temp/textfield-oracle-ui"
APPID=textfieldprobe
STORE="$HOME/Library/Application Support/$APPID/Local Store"

mkdir -p "$OUT"
rm -f "$OUT/adl.raw" "$STORE/textfield-grid.raw"

# adl is single-instance: a leftover process would make this launch only forward to
# it ("invocation forwarded to primary instance") and no grid would be written.
# Clear residue first; never SIGKILL (it corrupts the app's local store).
pkill -x adl 2>/dev/null && sleep 1 || true

echo "[1/3] mxmlc -> $OUT/Main.swf (+ grid)"
"$AIRSDK/bin/mxmlc" -debug=false "$HERE/UiMain.as" -output="$OUT/Main.swf" > "$OUT/mxmlc.log" 2>&1 \
  || { echo "mxmlc FAILED"; tail -20 "$OUT/mxmlc.log"; exit 1; }
cp "$HERE/app.xml" "$OUT/app.xml"

echo "[2/3] adl (headless window), polling for the grid"
( cd "$OUT" && exec "$AIRSDK/bin/adl" app.xml > "$OUT/adl.out" 2>&1 ) &
PID=$!
i=0
while [ $i -lt 120 ]; do
  [ -f "$STORE/textfield-grid.raw" ] && break
  sleep 0.25
  i=$((i + 1))
done
if [ -f "$STORE/textfield-grid.raw" ]; then
  cp "$STORE/textfield-grid.raw" "$OUT/adl.raw"
  echo "[3/3] grid -> $OUT/adl.raw ($(wc -c < "$OUT/adl.raw" | tr -d ' ') bytes)"
else
  echo "[3/3] NO GRID (adl stdout:)"; head -20 "$OUT/adl.out"; RC=1
fi
kill "$PID" 2>/dev/null || true
sleep 0.5
kill "$PID" 2>/dev/null || true
exit ${RC:-0}
