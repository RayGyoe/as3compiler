#!/bin/sh
# run-aot.sh — 用本编译器把 TextField 显示矩阵探针编成原生二进制并跑，报告落到
# temp/textfield-oracle/aot.txt。与 run-adl.sh 的报告逐行 diff（docs/zh-cn/flash-text.md §5）。
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT="$ROOT/temp/textfield-oracle"
STORE="$HOME/Library/Application Support/as3aot/Local Store"

mkdir -p "$OUT"
rm -f "$OUT/aot.txt" "$STORE/textfield-report.txt"

echo "[1/2] compile+run (AOT)"
( cd "$ROOT" && node src/index.ts examples/textfield/Main.as examples/textfield/entry.as --manifest examples/textfield/textfield.build.json -o "$OUT/tfprobe" --run )

echo "[2/2] report -> $OUT/aot.txt"
if [ -f "$STORE/textfield-report.txt" ]; then
  cp "$STORE/textfield-report.txt" "$OUT/aot.txt"
else
  echo "NO REPORT at $STORE/textfield-report.txt"; exit 1
fi
