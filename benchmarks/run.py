#!/usr/bin/env python3
"""编译四路 benchmark（C / JS / as3compiler / 原生 AIR），运行计时并校验结果一致。

计时口径：
  - 四路均内部计时纯计算时间（C: clock_gettime / JS: hrtime / as3compiler: Date.getTime / 原生 AS3: getTimer）。
  原生 AIR 的 adl 启动开销约 2.6s 不计入（getTimer 从应用启动后开始计时）。

用法：python3 benchmarks/run.py [benchmark ...]（不传参数跑全部）
"""
import os
import subprocess
import statistics
import sys

AIRSDK = os.environ.get(
    "AIRSDK_HOME",
    "/Users/ray.lei/Documents/Software/AIRSDK/AIRSDK_51.3.4/bin",
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
]
RUNS = 3


def sh(cmd, cwd=None):
    return subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)


def air_log(bench):
    return os.path.expanduser(
        f"~/Library/Application Support/bench.{bench}/Local Store/{bench}_air.log"
    )


def compile_one(bench):
    d = os.path.join(ROOT, "benchmarks", bench)
    sh(["cc", "-O2", "-o", f"{d}/{bench}_c", f"{d}/{bench}.c"])
    sh(
        ["node", "src/index.ts", f"benchmarks/{bench}/{bench}.as",
         "-o", f"benchmarks/{bench}/{bench}_asc"],
        cwd=ROOT,
    )
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
    print("编译四路...")
    for b in benches:
        compile_one(b)

    header = f"{'benchmark':<14}{'C(ms)':>9}{'JS(ms)':>9}{'asc(ms)':>10}{'AIR(ms)':>10}  result"
    print("\n" + header)
    print("-" * len(header))
    rows = []
    for b in benches:
        rc, tc = run_c(b)
        rj, tj = run_js(b)
        ra, ta = run_asc(b)
        rr, tr = run_air(b)
        results = {rc, rj, ra, rr}
        flag = "OK" if len(results) == 1 else f"MISMATCH {sorted(results)}"
        print(f"{b:<14}{tc:>9.0f}{tj:>9.0f}{ta:>10.0f}{tr:>10.0f}  {flag}")
        rows.append((b, tc, tj, ta, tr, flag))
    return rows


if __name__ == "__main__":
    main()
