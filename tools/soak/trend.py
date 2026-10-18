"""内存是否持续增长（需求 12.2：8 小时测试中内存没有持续增长）。"""

from __future__ import annotations

from statistics import median


def slope_per_hour(times_s: list[float], values: list[float]) -> float:
    """最小二乘直线的斜率，每小时的变化量。"""
    n = len(times_s)
    if n < 2:
        return 0.0
    mean_t = sum(times_s) / n
    mean_v = sum(values) / n
    var = sum((t - mean_t) ** 2 for t in times_s)
    if var == 0:
        return 0.0
    cov = sum((t - mean_t) * (v - mean_v) for t, v in zip(times_s, values, strict=True))
    return cov / var * 3600


def growth(values: list[float], warmup: int) -> float:
    """去掉热身轮之后，后一半的中位数相对前一半中位数的增长比例。"""
    rest = values[warmup:]
    if len(rest) < 4:
        return 0.0
    half = len(rest) // 2
    first, last = median(rest[:half]), median(rest[half:])
    return (last - first) / first if first else 0.0


def keeps_growing(values: list[float], warmup: int, limit: float = 0.1) -> bool:
    """后一半比前一半增长超过 limit（默认 10%）即视为持续增长。"""
    return growth(values, warmup) > limit
