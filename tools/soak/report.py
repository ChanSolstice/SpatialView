"""8 小时测试的结论（需求 12.2）：没有崩溃，每一轮都成功，内存没有持续增长。"""

from __future__ import annotations

from dataclasses import dataclass, field

from tools.soak.trend import growth, slope_per_hour

# 每轮结束后记录的内存指标。进程内存只有本机 Chrome 才有
METRICS = {
    "js_heap_mb": "JS 堆（MB）",
    "dom_nodes": "DOM 节点数",
    "listeners": "事件监听数",
    "renderer_mb": "渲染进程内存（MB）",
    "gpu_mb": "GPU 进程内存（MB）",
}


@dataclass
class Verdict:
    ok: bool
    reasons: list[str] = field(default_factory=list)
    metrics: dict[str, dict] = field(default_factory=dict)


def judge(
    rows: list[dict],
    *,
    elapsed_s: float,
    hours: float,
    min_rounds: int,
    warmup: int,
    limit: float,
    crashed: bool,
    exceptions: list[str],
) -> Verdict:
    reasons = []
    if crashed:
        reasons.append("APP 崩溃，或与页面的调试连接中断")
    if elapsed_s < hours * 3600:
        reasons.append(f"只运行了 {elapsed_s / 3600:.2f} 小时，要求 {hours:g} 小时")
    passed = [r for r in rows if r["ok"]]
    if len(passed) < min_rounds:
        reasons.append(f"成功 {len(passed)} 轮，要求至少 {min_rounds} 轮")
    failed = [r for r in rows if not r["ok"]]
    if failed:
        listed = "、".join(str(r["round"]) for r in failed[:10])
        reasons.append(f"{len(failed)} 轮失败：第 {listed}{' 等' if len(failed) > 10 else ''} 轮")
    if exceptions:
        reasons.append(f"页面中有 {len(exceptions)} 个未捕获的异常")

    metrics = {}
    for key, label in METRICS.items():
        series = [(r["elapsed_s"], r[key]) for r in passed if r.get(key) is not None]
        if len(series) < 2:
            continue
        times = [t for t, _ in series]
        values = [v for _, v in series]
        g = growth(values, warmup)
        metrics[key] = {
            "label": label,
            "first": values[0],
            "last": values[-1],
            "max": max(values),
            "growth": g,
            "slope_per_hour": slope_per_hour(times, values),
            "keeps_growing": g > limit,
        }
        if g > limit:
            reasons.append(f"{label}持续增长：去掉热身轮后，后一半比前一半多 {g:.0%}")
    return Verdict(ok=not reasons, reasons=reasons, metrics=metrics)
