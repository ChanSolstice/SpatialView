"""逐帧录制 APP 的画面。页面的时钟由 clock.js 接管，每帧推进 1/fps 秒后截图。

本机软件渲染，实时录屏达不到 30 帧。录制时每帧固定占用 frame_seconds 秒的真实时间，视频中的 1 秒对应
真实时间 slowdown = fps × frame_seconds 秒。mock 服务端的耗时和执行用故障注入的 speed 按同样的比例放慢，
CSS 动画用 CDP 的 Animation.setPlaybackRate 放慢，视频中的进度和动画因此与真实节奏一致。某一帧超时
（例如解析模型时页面忙）时，之后的几帧不再等待，直到赶上进度。
"""

from __future__ import annotations

import base64
import json
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from tools.interface_check.rosbridge import Rosbridge
from tools.soak.app import STATE_JS
from tools.soak.cdp import Page

CLOCK_JS = (Path(__file__).parent / "clock.js").read_text(encoding="utf-8")
INJECT_SERVICE = "/spatialview_mock/inject"
INJECT_TYPE = "spatialview_mock_msgs/srv/Inject"
FADE_SECONDS = 0.3  # 手指抬起后触点标记淡出的时长
PRESS_SECONDS = 0.15  # 点击时手指按住的时长（只是画面上的标记，触摸事件在抬起时一起发出）

# 页面中 base_link 坐标的点在屏幕上的位置，以及从相机看过去该处的第一个表面。
# 需要开发模式构建中的 window.spatialviewScene（SceneCanvas.tsx）
PROJECT_JS = """((p) => {
  const s = window.spatialviewScene
  if (!s) return null
  const v = s.camera.position.clone().set(p[0], p[1], p[2]).project(s.camera)
  const rect = s.gl.domElement.getBoundingClientRect()
  s.raycaster.setFromCamera({ x: v.x, y: v.y }, s.camera)
  const hit = s.raycaster
    .intersectObjects(s.scene.children, true)
    .find((h) => h.object.isMesh && h.object.visible && h.object.name)
  return {
    x: rect.left + ((v.x + 1) / 2) * rect.width,
    y: rect.top + ((1 - v.y) / 2) * rect.height,
    hit: hit ? hit.object.name : null,
  }
})"""

Point = tuple[float, float]


class RecordError(RuntimeError):
    """分镜中的某一步没有完成。"""


@dataclass
class Marker:
    x: float
    y: float
    released: int | None = None  # 手指抬起时的帧号；None 表示还按着


def format_time(seconds: float) -> str:
    minutes, rest = divmod(seconds, 60)
    return f"{int(minutes):02d}:{rest:05.2f}"


def ease(fraction: float) -> float:
    """手势的速度先加快后减慢。"""
    return (1 - math.cos(math.pi * fraction)) / 2


class Recorder:
    def __init__(
        self,
        page: Page,
        frames: Path,
        mock: Rosbridge | None,
        *,
        fps: int = 30,
        frame_seconds: float = 1.0,
        quality: int = 92,
    ) -> None:
        self.page = page
        self.frames = frames
        self.mock = mock
        self.fps = fps
        self.frame_seconds = frame_seconds
        self.quality = quality
        self.count = 0  # 已录制的帧数
        self.overruns = 0  # 超过 frame_seconds 的帧数
        self.work: list[float] = []  # 每帧推进、绘制和截图的真实耗时，秒
        self.touching: dict[int, Marker] = {}  # 按着的手指：触点编号 → 标记
        self.fading: list[Marker] = []  # 已抬起、正在淡出的标记
        self.timeline: list[tuple[float, str]] = []
        self.started = 0.0

    @property
    def slowdown(self) -> float:
        """视频中的 1 秒对应的真实秒数。"""
        return self.fps * self.frame_seconds

    @property
    def video_time(self) -> float:
        return self.count / self.fps

    # ---- 时间

    def start(self) -> None:
        self.page.call("Animation.enable")
        self.page.call("Animation.setPlaybackRate", playbackRate=1 / self.slowdown)
        self.set_speed(1)
        self.started = time.monotonic()

    def set_speed(self, speed: float) -> None:
        """mock 的扫描、重建、规划和执行在视频中加快 speed 倍（1 为真实节奏）。"""
        if self.mock is None:
            return
        args = json.dumps({"factor": speed / self.slowdown})
        values, _ = self.mock.call(INJECT_SERVICE, INJECT_TYPE, {"action": "speed", "args": args})
        if not values.get("ok"):
            raise RecordError(f"设置 mock 的倍率失败：{values.get('message')}")

    def mark(self, title: str) -> None:
        """在时间轴上记一笔，便于之后配字幕或配音。"""
        self.timeline.append((self.video_time, title))
        print(f"{format_time(self.video_time)} {title}", flush=True)

    def frame(self) -> None:
        """录制一帧：页面时间前进 1/fps 秒，更新触点标记，截图，再等到这一帧的真实时间用完。"""
        begin = time.monotonic()
        markers = json.dumps(self._visible_markers())
        self.page.eval(f"__demo.advance({1000 / self.fps}); __demo.touches({markers})")
        data = self.page.call("Page.captureScreenshot", format="jpeg", quality=self.quality)["data"]
        (self.frames / f"{self.count:05d}.jpg").write_bytes(base64.b64decode(data))
        self.work.append(time.monotonic() - begin)
        self.count += 1
        delay = self.started + self.count * self.frame_seconds - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        else:
            self.overruns += 1
        errors = self.page.eval("__demo.errors()")
        if errors:
            raise RecordError(f"页面中的回调出错：{errors[0]}")

    def hold(self, seconds: float) -> None:
        for _ in range(round(seconds * self.fps)):
            self.frame()

    def state(self) -> dict:
        return self.page.eval(STATE_JS)

    def until(self, what: str, predicate: Callable[[dict], bool], timeout: float = 30) -> dict:
        """逐帧录制，直到界面状态满足 predicate。timeout 为视频时间，秒。"""
        limit = self.count + round(timeout * self.fps)
        while True:
            state = self.state()
            if predicate(state):
                return state
            if self.count >= limit:
                raise RecordError(f"{what}：等待超时（作业阶段：{state['phase'] or '未知'}）")
            self.frame()

    # ---- 触点标记

    def _visible_markers(self) -> list[dict]:
        visible = [{"x": m.x, "y": m.y} for m in self.touching.values()]
        # 抬起发生在两帧之间：抬起后的第一帧已经过去 1/fps 秒
        self.fading = [m for m in self.fading if self._age(m) < FADE_SECONDS]
        for m in self.fading:
            fade = self._age(m) / FADE_SECONDS
            visible.append({"x": m.x, "y": m.y, "opacity": 1 - fade, "scale": 1 + 0.3 * fade})
        return visible

    def _age(self, marker: Marker) -> float:
        """手指抬起后到这一帧的时间，秒。"""
        return (self.count + 1 - marker.released) / self.fps

    def _release(self, touch_id: int) -> None:
        marker = self.touching.pop(touch_id)
        marker.released = self.count
        self.fading.append(marker)

    # ---- 触摸

    def _touch(self, kind: str, points: dict[int, Point]) -> None:
        touch_points = [{"x": x, "y": y, "id": i} for i, (x, y) in points.items()]
        self.page.call("Input.dispatchTouchEvent", type=kind, touchPoints=touch_points)

    def tap(self, point: Point, after: float = 0.4) -> None:
        """单指轻点：画面上手指按住 PRESS_SECONDS 秒，抬起时发出触摸事件，再录制 after 秒。"""
        self.touching[1] = Marker(*point)
        self.hold(PRESS_SECONDS)
        self._touch("touchStart", {1: point})
        self._touch("touchEnd", {})
        self._release(1)
        self.hold(after)

    def gesture(self, path: Callable[[float], dict[int, Point]], seconds: float) -> None:
        """拖动或捏合：path(进度 0–1) 给出各触点的位置，按 seconds 秒移动，每帧发送一次移动。"""
        points = path(0.0)
        for i, point in points.items():
            self.touching[i] = Marker(*point)
        self.hold(PRESS_SECONDS)
        self._touch("touchStart", points)
        steps = max(2, round(seconds * self.fps))
        for k in range(1, steps + 1):
            points = path(ease(k / steps))
            for i, (x, y) in points.items():
                self.touching[i].x, self.touching[i].y = x, y
            self._touch("touchMove", points)
            self.frame()
        self._touch("touchEnd", {})
        for i in points:
            self._release(i)

    # ---- 界面元素和场景中的位置

    def center(self, selector: str, text: str | None = None) -> Point:
        """元素的中心；给出 text 时为 selector 匹配的元素中文字为 text 的那一个。"""
        point = self.page.eval(
            f"(() => {{ const e = [...document.querySelectorAll({json.dumps(selector)})]"
            f".find((e) => {json.dumps(text)} === null || e.textContent.trim() === {json.dumps(text)});"
            " if (!e) return null; const r = e.getBoundingClientRect();"
            " return [r.left + r.width / 2, r.top + r.height / 2] })()"
        )
        if point is None:
            raise RecordError(f"找不到元素 {selector} {text or ''}".strip())
        return tuple(point)

    def rect(self, selector: str) -> tuple[float, float, float, float]:
        rect = self.page.eval(
            f"(() => {{ const e = document.querySelector({json.dumps(selector)}); if (!e) return null; "
            "const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] })()"
        )
        if rect is None:
            raise RecordError(f"找不到元素 {selector}")
        return tuple(rect)

    def project(self, point: tuple[float, float, float], surface: str) -> Point:
        """场景中 base_link 坐标的点在屏幕上的位置；从当前视角看过去，该处必须是表面 surface。"""
        result = self.page.eval(f"{PROJECT_JS}({json.dumps(list(point))})")
        if result is None:
            raise RecordError(
                "页面中没有 window.spatialviewScene，请使用开发模式的构建（tools/README.md）"
            )
        if result["hit"] != surface:
            raise RecordError(f"从当前视角点不到 {surface}：该处是 {result['hit']}")
        return result["x"], result["y"]
