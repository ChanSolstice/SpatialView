import base64
import json
import shutil

import pytest

from tools.demo.recorder import (
    CLOCK_JS,
    FADE_SECONDS,
    INJECT_SERVICE,
    Recorder,
    RecordError,
    ease,
    format_time,
)

PIXEL = base64.b64encode(b"jpeg").decode()


class FakePage:
    """记录脚本和 CDP 调用；截图返回固定内容，界面状态由 state 给出。"""

    def __init__(self) -> None:
        self.evals: list[str] = []
        self.calls: list[tuple[str, dict]] = []
        self.state = {"phase": "无模型"}

    def eval(self, expression: str):
        self.evals.append(expression)
        if expression == "__demo.errors()":
            return []
        if expression.startswith("(() =>"):
            return self.state
        return None

    def call(self, method: str, **params):
        self.calls.append((method, params))
        return {"data": PIXEL} if method == "Page.captureScreenshot" else {}


class FakeMock:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def call(self, service, service_type, args):
        self.calls.append((service, service_type, args))
        return {"ok": True, "message": ""}, 0.0


def recorder(tmp_path, frame_seconds: float = 0.001) -> tuple[Recorder, FakePage, FakeMock]:
    page, mock = FakePage(), FakeMock()
    rec = Recorder(page, tmp_path, mock, fps=10, frame_seconds=frame_seconds)
    rec.start()
    return rec, page, mock


def markers(page: FakePage) -> list[dict]:
    """最后一帧画出的触点标记。"""
    script = next(e for e in reversed(page.evals) if "__demo.touches(" in e)
    return json.loads(script.split("__demo.touches(", 1)[1].rstrip(")"))


def test_format_time_and_ease():
    assert format_time(0) == "00:00.00"
    assert format_time(83.5) == "01:23.50"
    assert ease(0) == 0 and ease(1) == 1 and ease(0.5) == pytest.approx(0.5)


def test_mock_and_css_animations_slow_down_with_the_recording(tmp_path):
    # 视频中 1 秒对应真实时间 10 × 0.5 = 5 秒
    rec, page, mock = recorder(tmp_path, frame_seconds=0.5)
    assert ("Animation.setPlaybackRate", {"playbackRate": 0.2}) in page.calls
    rec.set_speed(2.5)
    service, _, args = mock.calls[-1]
    assert service == INJECT_SERVICE
    assert json.loads(args["args"]) == {"factor": 0.5}


def test_frames_are_written_in_order(tmp_path):
    rec, _, _ = recorder(tmp_path)
    rec.hold(0.3)
    assert rec.count == 3
    assert sorted(p.name for p in tmp_path.iterdir()) == ["00000.jpg", "00001.jpg", "00002.jpg"]


def test_tap_marker_fades_after_release(tmp_path):
    rec, page, _ = recorder(tmp_path)
    rec.tap((100, 200), after=0)
    assert markers(page) == [{"x": 100, "y": 200}]
    touches = [p for m, p in page.calls if m == "Input.dispatchTouchEvent"]
    assert [t["type"] for t in touches] == ["touchStart", "touchEnd"]
    rec.frame()
    fading = markers(page)
    assert len(fading) == 1 and fading[0]["opacity"] < 1
    rec.hold(FADE_SECONDS)
    assert markers(page) == []


def test_gesture_moves_every_frame(tmp_path):
    rec, page, _ = recorder(tmp_path)
    rec.gesture(lambda u: {1: (100 * u, 0), 2: (-100 * u, 0)}, seconds=0.5)
    touches = [p for m, p in page.calls if m == "Input.dispatchTouchEvent"]
    assert touches[0]["type"] == "touchStart" and len(touches[0]["touchPoints"]) == 2
    assert [t["type"] for t in touches[1:-1]] == ["touchMove"] * 5
    assert touches[-2]["touchPoints"][0]["x"] == 100 and touches[-1]["type"] == "touchEnd"


def test_until_times_out_in_video_time(tmp_path):
    rec, page, _ = recorder(tmp_path)
    with pytest.raises(RecordError, match="等待超时"):
        rec.until("规划", lambda s: s["phase"] == "规划就绪", timeout=0.5)
    assert rec.count == 5
    page.state = {"phase": "规划就绪"}
    assert rec.until("规划", lambda s: s["phase"] == "规划就绪")["phase"] == "规划就绪"


@pytest.mark.skipif(not shutil.which("google-chrome"), reason="需要本机的 Chrome")
def test_clock_runs_timers_and_frames_in_virtual_time():
    from tools.soak.cdp import HeadlessChrome, Page, page_ws_url

    chrome = HeadlessChrome(port=9392)
    try:
        page = Page(page_ws_url(chrome.endpoint))
        page.call("Page.enable")
        page.call("Page.addScriptToEvaluateOnNewDocument", source=CLOCK_JS)
        page.call("Page.navigate", url="data:text/html,<p>clock</p>")
        page.wait("window.__demo && document.readyState === 'complete'", 15)
        page.eval(
            """window.log = []; window.t0 = performance.now(); window.d0 = Date.now()
            const ms = (t) => Math.round((t - t0) * 1000) / 1000
            const at = (name) => () => log.push([name, ms(performance.now())])
            setTimeout(at('t50'), 50); setTimeout(at('t10'), 10); setInterval(at('i20'), 20)
            requestAnimationFrame((t) => log.push(['frame', ms(t)]))"""
        )
        page.eval("__demo.advance(45)")
        log = page.eval("log")
        assert log == [["t10", 10], ["i20", 20], ["i20", 40], ["frame", 45]]
        # 时间只在 advance 时前进；Date 与 performance.now 一致
        elapsed = "[performance.now() - t0, Date.now() - d0, new Date().getTime() - d0]"
        assert page.eval(f"{elapsed}.map((v) => Math.round(v))") == [45, 45, 45]
        assert page.eval("new Promise((r) => setTimeout(() => r('立即'), 0))") == "立即"
        page.eval("__demo.advance(10)")
        assert page.eval("log.slice(4)") == [["t50", 50]]
        page.close()
    finally:
        chrome.close()
