#!/usr/bin/env python3
"""编译四路 benchmark（C / JS / as3compiler / 原生 AIR），运行计时并校验结果一致。

计时口径：
  - 四路均内部计时纯计算时间（C: clock_gettime / JS: hrtime / as3compiler: Date.getTime / 原生 AS3: getTimer）。
  原生 AIR 的 adl 启动开销约 2.6s 不计入（getTimer 从应用启动后开始计时）。

用法：python3 benchmarks/run.py [benchmark ...]（不传参数跑全部）

AIRSDK_HOME 必须指向 SDK 的 bin/ 目录（本脚本拼接 $AIRSDK_HOME/mxmlc）。
"""
import os
import subprocess
import statistics
import sys

AIRSDK = os.environ.get(
    "AIRSDK_HOME",
    "/Users/ray.lei/Documents/Software/AIRSDK/AIRSDK_51.4.1/bin",
)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BENCHES = [
    "fib",
    "nbody",
    "binarytrees",
    "mandelbrot",
    "strings",
    "spectralnorm",
    "oop",
    "array",
    "vectorint",
    "stringbuild",
    "textmetrics",
]
RUNS = 3

# 每一项跑哪几路。缺省是四路（C / JS / AOT / AIR）。
#
# `textmetrics` 只有两路：C 与 JS 没有 Skia 排版引擎，`textWidth`/`textHeight`/
# `maxScrollH` 在那两侧无从实现，硬凑一个「同构实现」只会把基准变成两套无关数字
# 的比较。跳过的路在表里显式打 `-`，不静默少算（理由见
# benchmarks/textmetrics/report.md）。
ROUTES = {
    "textmetrics": ("asc", "air"),
}
DEFAULT_ROUTES = ("c", "js", "asc", "air")

# AOT 侧需要链接第三方库的基准 -> 构建清单（路径相对仓库根）。
# 文本排版要 Skia（skparagraph），所以 textmetrics 必须带清单编译。
MANIFESTS = {
    "textmetrics": "benchmarks/textmetrics/textmetrics.build.json",
}


def sh(cmd, cwd=None):
    return subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)


def air_log(bench):
    return os.path.expanduser(
        f"~/Library/Application Support/bench.{bench}/Local Store/{bench}_air.log"
    )


def routes_of(bench):
    return ROUTES.get(bench, DEFAULT_ROUTES)


def compile_one(bench):
    d = os.path.join(ROOT, "benchmarks", bench)
    routes = routes_of(bench)
    if "c" in routes:
        sh(["cc", "-O2", "-o", f"{d}/{bench}_c", f"{d}/{bench}.c"])
    if "asc" in routes:
        cmd = ["node", "src/index.ts", f"benchmarks/{bench}/{bench}.as",
               "-o", f"benchmarks/{bench}/{bench}_asc"]
        manifest = MANIFESTS.get(bench)
        if manifest:
            cmd += ["--manifest", manifest]
        sh(cmd, cwd=ROOT)
    if "air" in routes:
        sh([f"{AIRSDK}/mxmlc", f"{bench}_air.as", "-output", f"{bench}_air.swf"], cwd=d)


def parse(text):
    result = time_ms = None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("result="):
            result = line[len("result="):]
        elif line.startswith("time="):
            time_ms = line[len("time="):]
    return result, time_ms


def run_c(bench):
    exe = os.path.join(ROOT, "benchmarks", bench, f"{bench}_c")
    times, result = [], None
    for _ in range(RUNS):
        res, t = parse(sh([exe]).stdout)
        result, times = res, times + [float(t)]
    return result, statistics.median(times)


def run_js(bench):
    d = os.path.join(ROOT, "benchmarks", bench)
    times, result = [], None
    for _ in range(RUNS):
        res, t = parse(sh(["node", f"{bench}.js"], cwd=d).stdout)
        result, times = res, times + [float(t)]
    return result, statistics.median(times)


def run_asc(bench):
    exe = os.path.join(ROOT, "benchmarks", bench, f"{bench}_asc")
    times, result = [], None
    for _ in range(RUNS):
        res, t = parse(sh([exe]).stdout)
        result, times = res, times + [float(t)]
    return result, statistics.median(times)


def run_air(bench):
    d = os.path.join(ROOT, "benchmarks", bench)
    times, result = [], None
    for _ in range(RUNS):
        sh([f"{AIRSDK}/adl", f"{bench}_air-app.xml"], cwd=d)
        with open(air_log(bench)) as f:
            res, t = parse(f.read())
        result, times = res, times + [float(t)]
    return result, statistics.median(times)


def main():
    benches = sys.argv[1:] or BENCHES
    print("编译各路...")
    for b in benches:
        compile_one(b)

    header = f"{'benchmark':<14}{'C(ms)':>9}{'JS(ms)':>9}{'asc(ms)':>10}{'AIR(ms)':>10}  result"
    print("\n" + header)
    print("-" * len(header))
    rows = []
    runners = {"c": run_c, "js": run_js, "asc": run_asc, "air": run_air}
    for b in benches:
        routes = routes_of(b)
        cells, results = {}, set()
        for r in DEFAULT_ROUTES:
            if r not in routes:
                continue
            res, t = runners[r](b)
            results.add(res)
            cells[r] = t
        skipped = [r for r in DEFAULT_ROUTES if r not in routes]
        flag = "OK" if len(results) == 1 and None not in results else f"MISMATCH {sorted(results)}"
        if skipped:
            flag += "  (no route: " + ", ".join(skipped) + ")"
        def cell(key, width):
            return f"{cells[key]:>{width}.0f}" if key in cells else f"{'-':>{width}}"
        print(f"{b:<14}{cell('c', 9)}{cell('js', 9)}{cell('asc', 10)}{cell('air', 10)}  {flag}")
        rows.append((b, cells, flag))
    return rows


if __name__ == "__main__":
    main()
