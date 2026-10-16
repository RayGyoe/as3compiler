#!/bin/sh
# run-adl.sh — 用 AIR `adl` 跑 TextField 显示矩阵探针，报告落到 temp/textfield-oracle/adl.txt。
#
# 口径见 docs/zh-cn/flash-text.md §5：adl 是唯一 oracle，AOT 侧用 run-aot.sh，
# 两份报告逐行 diff。
#
#   AIRSDK_HOME=/path/to/AIRSDK ./run-adl.sh
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
AIRSDK=${AIRSDK_HOME:-$HOME/Documents/Software/AIRSDK/AIRSDK_51.4.1}
OUT="$ROOT/temp/textfield-oracle"
APPID=textfieldprobe
STORE="$HOME/Library/Application Support/$APPID/Local Store"

mkdir -p "$OUT"
rm -f "$OUT/adl.txt" "$STORE/textfield-report.txt"

# adl is single-instance: a leftover process would make this launch only forward to
# it ("invocation forwarded to primary instance") and no report would be written.
# Clear residue first; never SIGKILL (it corrupts the app's local store).
pkill -x adl 2>/dev/null && sleep 1 || true

echo "[1/3] mxmlc -> $OUT/Main.swf"
"$AIRSDK/bin/mxmlc" -debug=false "$HERE/Main.as" -output="$OUT/Main.swf" > "$OUT/mxmlc.log" 2>&1 \
  || { echo "mxmlc FAILED"; tail -20 "$OUT/mxmlc.log"; exit 1; }
cp "$HERE/app.xml" "$OUT/app.xml"

echo "[2/3] adl (headless window), polling for the report"
( cd "$OUT" && exec "$AIRSDK/bin/adl" app.xml > "$OUT/adl.out" 2>&1 ) &
PID=$!
i=0
while [ $i -lt 60 ]; do
  [ -f "$STORE/textfield-report.txt" ] && break
  sleep 0.25
  i=$((i + 1))
done
if [ -f "$STORE/textfield-report.txt" ]; then
  cp "$STORE/textfield-report.txt" "$OUT/adl.txt"
  echo "[3/3] report -> $OUT/adl.txt"
else
  echo "[3/3] NO REPORT (adl stdout:)"; head -20 "$OUT/adl.out"; RC=1
fi
kill "$PID" 2>/dev/null || true
sleep 0.5
kill "$PID" 2>/dev/null || true
exit ${RC:-0}
