#!/bin/sh
# run-aot-ui.sh — 用本编译器跑 TextField 的 **UI 网格**（Main.as 的 ui 模式），
# 产出 temp/textfield-oracle-ui/aot.raw。与 run-adl-ui.sh 的产物并排拼图。
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT="$ROOT/temp/textfield-oracle-ui"
STORE="$HOME/Library/Application Support/as3aot/Local Store"

mkdir -p "$OUT"
rm -f "$OUT/aot.raw" "$STORE/textfield-grid.raw"

echo "[1/2] compile+run (AOT, ui entry)"
# 与 run-aot.sh 同一份清单；只是入口换成 entry-ui.as（`new Main(true)`）。
( cd "$ROOT" && node src/index.ts examples/textfield/Main.as examples/textfield/UiMain.as \
    examples/textfield/entry-ui.as --manifest examples/textfield/textfield.build.json \
    -o "$OUT/tfprobe-ui" --run )

echo "[2/2] grid -> $OUT/aot.raw"
if [ -f "$STORE/textfield-grid.raw" ]; then
  cp "$STORE/textfield-grid.raw" "$OUT/aot.raw"
  wc -c < "$OUT/aot.raw" | tr -d ' '
else
  echo "NO GRID at $STORE/textfield-grid.raw"; exit 1
fi
