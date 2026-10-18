from tools.soak.report import judge


def rows(heap, ok=True):
    return [
        {"round": i + 1, "ok": ok, "elapsed_s": 600.0 * (i + 1), "js_heap_mb": v, "dom_nodes": 900}
        for i, v in enumerate(heap)
    ]


OPTIONS = dict(hours=8, min_rounds=50, warmup=3, limit=0.1, crashed=False, exceptions=[])


def test_passes_when_memory_is_flat():
    heap = [40, 60, 70] + [80 + (i % 3) for i in range(57)]
    verdict = judge(rows(heap), elapsed_s=8 * 3600, **OPTIONS)
    assert verdict.ok, verdict.reasons
    assert not verdict.metrics["js_heap_mb"]["keeps_growing"]
    assert verdict.metrics["dom_nodes"]["growth"] == 0


def test_reports_growing_memory():
    verdict = judge(rows([80 + 2 * i for i in range(60)]), elapsed_s=8 * 3600, **OPTIONS)
    assert not verdict.ok
    assert any("JS 堆" in reason for reason in verdict.reasons)


def test_reports_short_run_failed_rounds_crash_and_exceptions():
    data = rows([80] * 10)
    data[4]["ok"] = False
    verdict = judge(
        data,
        elapsed_s=3600,
        **{**OPTIONS, "crashed": True, "exceptions": ["TypeError: x is undefined"]},
    )
    assert not verdict.ok
    text = "\n".join(verdict.reasons)
    for expected in (
        "崩溃",
        "只运行了 1.00 小时",
        "成功 9 轮",
        "1 轮失败：第 5 轮",
        "1 个未捕获的异常",
    ):
        assert expected in text
