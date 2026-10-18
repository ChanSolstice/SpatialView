"""8 小时测试（需求 12.2；接口文档 15.4 场景 10）：用真实的点击事件循环操作 APP，每轮结束后记录内存。

  # 本机无头 Chrome 打开打包产物，连接本机的开发环境
  uv run python -m tools.soak --url http://127.0.0.1:4173/ \\
      --rosbridge ws://127.0.0.1:9090 --http http://127.0.0.1:8080
  # 平板上的 debug 包：先用 adb forward 转发 WebView 的调试端口（见 cdp.py）
  uv run python -m tools.soak --endpoint http://127.0.0.1:9222

连接真实服务端时，扫描会让机械臂运动；--execute-seconds 还会开始清洗、开启激光，需要现场人员看护。
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from statistics import median

import websocket

from tools.soak.app import MEASURES, AppDriver, StepError
from tools.soak.cdp import CdpError, HeadlessChrome, Page, page_ws_url
from tools.soak.procmem import chrome_memory_mb
from tools.soak.report import METRICS, judge

# 与工程入口保存的覆盖配置相同（app/src/config/load.ts 的 OVERRIDE_KEY）。
# 浏览器中 Capacitor Preferences 存在 localStorage，键名加 "CapacitorStorage." 前缀
OVERRIDE_STORAGE_KEY = "CapacitorStorage.spatialview.config_override"

COLUMNS = [
    "round",
    "started",
    "ok",
    "error",
    "round_s",
    "elapsed_s",
    "scan_s",
    "selected",
    "plan_s",
    "model_display_ms",
    "plan_display_ms",
    *METRICS,
    "chrome_mb",
    "alarms",
]


def override_script(rosbridge: str | None, http: str | None) -> str:
    server = {}
    if rosbridge:
        server["rosbridge_url"] = rosbridge
    if http:
        server["http_base_url"] = http
    value = json.dumps({"config_version": 1, "server": server})
    return f"localStorage.setItem({json.dumps(OVERRIDE_STORAGE_KEY)}, {json.dumps(value)})"


def sample(page: Page, chrome: HeadlessChrome | None) -> dict:
    """先做两次垃圾回收，再读内存。"""
    for _ in range(2):
        page.call("HeapProfiler.collectGarbage")
        time.sleep(0.5)
    metrics = {m["name"]: m["value"] for m in page.call("Performance.getMetrics")["metrics"]}
    row = {
        "js_heap_mb": metrics["JSHeapUsedSize"] / 2**20,
        "dom_nodes": metrics["Nodes"],
        "listeners": metrics["JSEventListeners"],
    }
    if chrome is not None:
        memory = chrome_memory_mb(chrome.pid)
        row["renderer_mb"] = memory.get("renderer")
        row["gpu_mb"] = memory.get("gpu-process")
        row["chrome_mb"] = sum(memory.values())
    return row


def fmt(value) -> str:
    return f"{value:.1f}" if isinstance(value, float) else str(value)


def run(args: argparse.Namespace, page: Page, chrome: HeadlessChrome | None, out: Path) -> int:
    app = AppDriver(page, timeout=args.timeout)
    try:
        state = app.wait_ready()
        print(f"已连接，作业阶段：{state['phase']}，告警：{state['alarms']}", flush=True)
        app.recover()
    except StepError as error:
        print(f"无法开始测试：{error}", flush=True)
        return 1
    baseline = app.state()["alarms"]

    rows: list[dict] = []
    crashed = False
    started = time.time()
    failures = 0
    with (out / "rounds.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, COLUMNS, extrasaction="ignore")
        writer.writeheader()
        try:
            while time.time() - started < args.hours * 3600:
                row = {
                    "round": len(rows) + 1,
                    "started": datetime.now().isoformat(timespec="seconds"),
                }
                begin = time.time()
                try:
                    row.update(
                        app.round(
                            baseline, args.play_seconds, args.tail_seconds, args.execute_seconds
                        )
                    )
                    row.update(ok=True, error="")
                    failures = 0
                except StepError as error:
                    row.update(ok=False, error=str(error))
                    failures += 1
                    page.screenshot(out / f"round-{row['round']:04d}.png")
                    try:
                        app.recover()
                    except StepError as again:
                        row["error"] += f"；恢复失败：{again}"
                if page.crashed:
                    raise CdpError("页面崩溃")
                row["round_s"] = time.time() - begin
                row["elapsed_s"] = time.time() - started
                row["alarms"] = app.state()["alarms"]
                row.update(sample(page, chrome))
                rows.append(row)
                writer.writerow({k: fmt(v) for k, v in row.items()})
                f.flush()
                print(
                    f"第 {row['round']} 轮 {'成功' if row['ok'] else '失败'}"
                    f"（{row['round_s']:.0f} 秒，累计 {row['elapsed_s'] / 3600:.2f} 小时）"
                    f" JS 堆 {row['js_heap_mb']:.1f} MB，DOM 节点 {row['dom_nodes']}"
                    + (
                        f"，渲染进程 {fmt(row['renderer_mb'])} MB，GPU 进程 {fmt(row['gpu_mb'])} MB"
                        if chrome
                        else ""
                    )
                    + (f"\n  {row['error']}" if row["error"] else ""),
                    flush=True,
                )
                if failures >= args.max_failures:
                    print(f"连续 {failures} 轮失败，停止测试", flush=True)
                    break
        except (CdpError, websocket.WebSocketException, OSError) as error:
            crashed = True
            print(f"与页面的调试连接中断：{error}", flush=True)
        except KeyboardInterrupt:
            print("手动停止", flush=True)

    elapsed = time.time() - started
    verdict = judge(
        rows,
        elapsed_s=elapsed,
        hours=args.hours,
        min_rounds=args.rounds,
        warmup=args.warmup,
        limit=args.limit,
        crashed=crashed or page.crashed,
        exceptions=page.exceptions,
    )
    # 需求 12.2 的两项显示耗时，只记录不判断：目标是平板上的数值
    timings = {}
    for key in MEASURES:
        values = [r[key] for r in rows if r["ok"] and r.get(key) is not None]
        if values:
            timings[key] = {"median": median(values), "max": max(values)}
    summary = {
        "ok": verdict.ok,
        "reasons": verdict.reasons,
        "hours": elapsed / 3600,
        "rounds": len(rows),
        "failed_rounds": [r["round"] for r in rows if not r["ok"]],
        "metrics": verdict.metrics,
        "timings": timings,
        "exceptions": page.exceptions[:20],
    }
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"\n运行 {elapsed / 3600:.2f} 小时，{len(rows)} 轮")
    for metric in verdict.metrics.values():
        print(
            f"  {metric['label']}：{fmt(metric['first'])} → {fmt(metric['last'])}，"
            f"最大 {fmt(metric['max'])}，增长 {metric['growth']:.1%}，"
            f"斜率 {metric['slope_per_hour']:.2f}/小时"
        )
    for key, label in (
        ("model_display_ms", "模型下载完成到显示"),
        ("plan_display_ms", "规划下载完成到路径显示"),
    ):
        if key in timings:
            print(
                f"  {label}：中位数 {timings[key]['median']:.0f} 毫秒，最大 {timings[key]['max']:.0f} 毫秒"
            )
    print("通过" if verdict.ok else "不通过：\n  " + "\n  ".join(verdict.reasons))
    return 0 if verdict.ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m tools.soak",
        description="8 小时测试：循环执行扫描、加载模型、规划、加载规划、轨迹动画，检查崩溃和内存增长。",
    )
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--url", help="本机无头 Chrome 打开的 APP 地址")
    target.add_argument("--endpoint", help="已有的 CDP 端点（平板 WebView），连接其中已打开的 APP")
    parser.add_argument("--rosbridge", help="与 --url 一起使用：写入覆盖配置的 rosbridge 地址")
    parser.add_argument("--http", help="与 --url 一起使用：写入覆盖配置的文件服务地址")
    parser.add_argument("--hours", type=float, default=8, help="运行时长，小时（默认 8）")
    parser.add_argument("--rounds", type=int, default=50, help="至少完成的轮数（默认 50）")
    parser.add_argument(
        "--play-seconds",
        type=float,
        default=20,
        help="轨迹动画先播放的秒数（默认 20）",
    )
    parser.add_argument(
        "--tail-seconds",
        type=float,
        default=40,
        help="之后拖到只剩这么多动画时间处，播放到结束（默认 40）",
    )
    parser.add_argument(
        "--execute-seconds",
        type=float,
        default=0,
        help="大于 0 时，每轮最后开始清洗，执行这么多秒后停止（默认 0，不执行）",
    )
    parser.add_argument("--timeout", type=float, default=300, help="每一步的最长等待，秒")
    parser.add_argument("--max-failures", type=int, default=3, help="连续失败多少轮后停止")
    parser.add_argument("--warmup", type=int, default=3, help="判断内存增长时去掉的前几轮")
    parser.add_argument(
        "--limit", type=float, default=0.1, help="后一半比前一半增长超过这个比例即为持续增长"
    )
    parser.add_argument("--dpr", type=float, default=1.5, help="本机 Chrome 的 devicePixelRatio")
    parser.add_argument("--port", type=int, default=9399, help="本机 Chrome 的调试端口")
    parser.add_argument(
        "--out", type=Path, default=Path("soak-report"), help="结果目录（默认 soak-report）"
    )
    args = parser.parse_args(argv)
    if args.endpoint and (args.rosbridge or args.http):
        parser.error("--rosbridge、--http 只用于 --url：平板上的地址在工程入口中设置")
    args.out.mkdir(parents=True, exist_ok=True)

    chrome = HeadlessChrome(port=args.port) if args.url else None
    page = Page(page_ws_url(chrome.endpoint if chrome else args.endpoint))
    try:
        for domain in ("Page", "Runtime", "Inspector", "Performance"):
            page.call(f"{domain}.enable")
        if chrome:
            # 与目标平板相同的 CSS 尺寸和像素比（需求 12.1）
            page.call(
                "Emulation.setDeviceMetricsOverride",
                width=1280,
                height=800,
                deviceScaleFactor=args.dpr,
                mobile=False,
            )
            if args.rosbridge or args.http:
                page.call(
                    "Page.addScriptToEvaluateOnNewDocument",
                    source=override_script(args.rosbridge, args.http),
                )
            page.call("Page.navigate", url=args.url)
        return run(args, page, chrome, args.out)
    finally:
        page.close()
        if chrome:
            chrome.close()


if __name__ == "__main__":
    sys.exit(main())
