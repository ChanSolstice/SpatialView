"""演示视频的分镜（阶段规划阶段 13）：APP 的完整工作流程和急停，约 1 分 40 秒。

开发环境使用圆台样例（SAMPLE_SIZE=demo），mock 刚启动、作业阶段为无模型。mock 的规划与选择的表面无关，
这里选的正是样例路径覆盖的四块表面（tools/sample_data 的 DEMO_PATH）。视角的转动按 OrbitControls 的规则
换算：单指水平拖过三维区高度那么长时转一整圈。
"""

from __future__ import annotations

import math

from tools.demo.recorder import Point, Recorder, RecordError
from tools.sample_data.path import DEMO_PATH
from tools.sample_data.workpiece import DEMO

SCENE = "[data-testid=scene]"
DIALOG = ".dlg"


def button(name: str) -> str:
    return f"[data-testid=btn-{name}]"


def press(rec: Recorder, name: str, after: float = 0.4) -> None:
    """等按钮栏中的按钮可用后点击。"""
    rec.until(f"等待按钮 {name} 可用", lambda s: s["enabled"][name], timeout=10)
    rec.tap(rec.center(button(name)), after=after)


def confirm(rec: Recorder, what: str) -> None:
    """确认框出现后停留片刻，再点确认按钮。"""
    rec.until(what, lambda s: bool(s["dialog"] and s["dialog"]["confirm"]), timeout=5)
    rec.hold(0.8)
    rec.tap(rec.center(f"{DIALOG} .dbtn.primary"), after=0.3)


def scene_center(rec: Recorder) -> tuple[float, float, float]:
    """三维区中心的 x、y 和三维区的高度。"""
    left, top, width, height = rec.rect(SCENE)
    return left + width / 2, top + height / 2, height


def orbit(rec: Recorder, azimuth: float, elevation: float = 0.0, seconds: float = 2.0) -> None:
    """单指拖动，视角绕工件转过 azimuth 度（俯视逆时针为正）、抬高 elevation 度。"""
    x, y, height = scene_center(rec)
    dx = -azimuth / 360 * height
    dy = elevation / 360 * height
    start = (x - dx / 2, y - dy / 2)
    rec.gesture(lambda u: {1: (start[0] + dx * u, start[1] + dy * u)}, seconds)


def pinch(rec: Recorder, ratio: float, seconds: float = 1.2) -> None:
    """双指捏合：两指间距变为原来的 ratio 倍，大于 1 时拉近。"""
    x, y, _ = scene_center(rec)
    start = 160.0 if ratio >= 1 else 160.0 / ratio
    end = start * ratio

    def fingers(u: float) -> dict[int, Point]:
        half = (start + (end - start) * u) / 2
        return {1: (x - half, y + 0.25 * half), 2: (x + half, y - 0.25 * half)}

    rec.gesture(fingers, seconds)


def side_point(k: int, z: float = 0.065) -> tuple[float, float, float]:
    """侧面表面 k 中线上高度 z 处的点。"""
    theta = k * 2 * math.pi / DEMO.sectors
    r = float(DEMO.radius(z))
    return (DEMO.center[0] + r * math.cos(theta), DEMO.center[1] + r * math.sin(theta), z)


def visible(rec: Recorder, selector: str) -> bool:
    return rec.page.eval(f"!!document.querySelector({selector!r})")


def check_start(rec: Recorder) -> None:
    """从刚启动的 mock 开始录制：无模型、机械臂没有急停；页面是开发模式的构建。"""
    rec.until(
        "连接服务端", lambda s: s["service"] == "已连接" and s["phase"] not in ("", "未知"), 10
    )
    if rec.state()["phase"] != "无模型":
        raise RecordError(
            "mock 不是刚启动（作业阶段不是无模型），请先重启：docker compose restart mock"
        )
    if visible(rec, "[data-testid=robot-notice]"):
        raise RecordError("机械臂处于急停或未启动，请先在 APP 中复位急停")
    try:
        rec.until("三维场景", lambda s: rec.page.eval("!!window.spatialviewScene"), 3)
    except RecordError:
        raise RecordError("页面中没有 window.spatialviewScene，请使用开发模式的构建") from None


def record(rec: Recorder) -> None:
    rec.mark("启动并连接服务端，暂无模型")
    check_start(rec)
    rec.hold(2.5)

    rec.mark("开始扫描：扫描、重建后显示工件模型")
    rec.set_speed(2.5)
    press(rec, "scan")
    rec.until(
        "扫描和重建",
        lambda s: s["phase"] == "模型就绪" and s["enabled"]["select"] and not s["loading"],
        30,
    )
    rec.hold(1.5)

    rec.mark("单指拖动旋转视角，双指缩放")
    orbit(rec, -80, seconds=2.0)
    rec.hold(0.3)
    orbit(rec, 80, elevation=12, seconds=2.0)
    rec.hold(0.3)
    pinch(rec, 1.5)
    rec.hold(0.5)
    pinch(rec, 1 / 1.5)
    rec.hold(0.5)
    rec.tap(rec.center(".view-reset"), after=1.0)

    rec.mark("选面：点选顶面和朝向机械臂的三块侧面")
    press(rec, "select", after=0.8)
    rec.until("进入选面", lambda s: s["selecting"], 3)
    rec.tap(rec.project((*DEMO.center, DEMO.height), "top"), after=0.6)
    # 默认视角从工件的 +X、-Y 一侧看；朝向机械臂的侧面在背面，转过去再点
    orbit(rec, -115, seconds=2.5)
    rec.hold(0.4)
    for k in (4, 3, 5):
        rec.tap(rec.project(side_point(k), f"side_{k:02d}"), after=0.5)
    expected = f"已选 {len(DEMO_PATH.surface_ids)} 个表面"
    rec.until("选中四个表面", lambda s: s["selected"] == expected, 2)
    rec.hold(1.0)

    rec.mark("开始规划：显示 TCP 路径")
    rec.set_speed(2.5)
    press(rec, "plan")
    rec.until(
        "规划",
        lambda s: s["phase"] == "规划就绪" and s["enabled"]["animate"] and not s["loading"],
        30,
    )
    rec.hold(1.5)
    # 转到斜侧方：轨迹动画中机械臂在左、工件在右
    orbit(rec, 35, elevation=8, seconds=2.0)
    rec.hold(1.5)

    rec.mark("轨迹动画：机械臂沿规划的轨迹运动（非实际位置）")
    press(rec, "animate")
    rec.until("进入轨迹动画", lambda s: s["playbar"] is not None, 3)
    rec.hold(1.2)
    # 视角拉远到能看到整个机械臂后，工件显得很小：拉近一些看工具沿路径运动
    pinch(rec, 1.6)
    rec.tap(rec.center(".playbar-speeds button", "5×"))
    rec.hold(4.5)
    left, top, width, height = rec.rect(".playbar-track")
    state = rec.state()["playbar"]
    now = left + width * state["time"] / state["duration"]
    rec.gesture(lambda u: {1: (now + (left + width * 0.3 - now) * u, top + height / 2)}, 1.0)
    rec.hold(3.0)
    rec.tap(rec.center(".playbar-speeds button", "20×"))
    rec.until(
        "轨迹动画播放到结束",
        lambda s: s["playbar"] is not None and not s["playbar"]["playing"],
        10,
    )
    rec.hold(1.0)
    rec.tap(rec.center(".playbar button", "退出"), after=1.0)

    rec.mark("开始清洗：路径按实际执行进度变色")
    rec.set_speed(5)
    press(rec, "main")
    confirm(rec, "确认开始清洗")
    rec.until("执行中", lambda s: s["phase"] == "执行中", 5)
    rec.hold(6.0)
    rec.mark("暂停、继续")
    press(rec, "main")
    rec.until("已暂停", lambda s: s["phase"] == "已暂停", 5)
    rec.hold(2.0)
    press(rec, "main")
    rec.until("清洗完成", lambda s: bool(s["dialog"] and not s["dialog"]["confirm"]), 30)
    rec.hold(2.0)
    rec.tap(rec.center(f"{DIALOG} .dbtn"), after=1.0)

    rec.mark("急停：清洗中按急停，任务中断；复位急停")
    press(rec, "main")
    confirm(rec, "确认开始清洗")
    rec.until("执行中", lambda s: s["phase"] == "执行中", 5)
    rec.hold(3.0)
    rec.tap(rec.center(button("estop")), after=0.5)
    rec.until("急停", lambda s: visible(rec, "[data-testid=robot-notice]"), 5)
    rec.hold(2.0)
    if rec.state()["dialog"]:
        rec.tap(rec.center(f"{DIALOG} .dbtn"), after=0.8)
    if not visible(rec, ".robot-notice-reset"):
        raise RecordError("机械臂提示中没有复位急停按钮")
    rec.tap(rec.center(".robot-notice-reset"))
    confirm(rec, "确认复位急停")
    rec.until("复位急停", lambda s: not visible(rec, "[data-testid=robot-notice]"), 10)
    rec.hold(2.5)
    rec.mark("结束")
