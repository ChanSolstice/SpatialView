"""用真实的点击事件操作 APP，完成一轮"扫描 → 加载模型 → 规划 → 加载规划 → 轨迹动画"（需求 12.2），
可选再加"开始清洗 → 停止"。

只从界面判断状态：按钮是否可用、Status Bar 的作业阶段和告警数、对话框、播放条。不依赖开发版的调试接口，
打包产物和平板上的 APP 都可以用。
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable

from tools.soak.cdp import Page

# 界面上可见的状态，每次轮询读取一次
STATE_JS = """(() => {
  const text = (s) => document.querySelector(s)?.textContent.trim() ?? ''
  const button = (id) => document.querySelector(`[data-testid=btn-${id}]`)
  const enabled = (id) => !!button(id) && !button(id).disabled
  const dialog = document.querySelector('.dlg')
  const track = document.querySelector('.playbar-track')
  return {
    phase: text('[data-testid=sb-phase] .sb-phase'),
    service: text('[data-testid=sb-service] .pill'),
    alarms: text('[data-testid=sb-alarm]'),
    enabled: Object.fromEntries(
      ['scan', 'select', 'plan', 'animate', 'main', 'stop'].map((id) => [id, enabled(id)])),
    loading: !!document.querySelector('[data-testid=progress-card]'),
    selecting: !!document.querySelector('[data-testid=selection-toolbar]'),
    selected: text('.toolbar-count'),
    dialog: dialog && {
      title: dialog.getAttribute('aria-label') ?? '',
      text: dialog.textContent.trim(),
      confirm: [...dialog.querySelectorAll('button')].some((b) => b.textContent.trim() === '取消'),
    },
    playbar: track && {
      time: Number(track.getAttribute('aria-valuenow')),
      duration: Number(track.getAttribute('aria-valuemax')),
      playing: document.querySelector('.playbar-play')?.getAttribute('aria-label') === '暂停',
    },
  }
})()"""

# APP 自己记录的耗时（架构设计 5.6），同名的只保留最近一次。显示耗时即需求 12.2 中
# "下载完成到显示"的两项
MEASURES = {
    "model_display_ms": "spatialview:model-display",
    "plan_display_ms": "spatialview:plan-display",
}

# 选面时点击的位置：三维区中间一带，按三维区的宽高比例。默认视角下工件在三维区中央
SELECT_TAPS = [(0.5, 0.5), (0.42, 0.45), (0.58, 0.45), (0.45, 0.58), (0.55, 0.58)]
# 不能接受新指令的作业阶段
BUSY_PHASES = {"扫描中", "重建中", "规划中", "停止中"}
NO_ALARM = "无告警"


class StepError(RuntimeError):
    """一轮中的某一步失败或没有在时限内完成。"""


class AppDriver:
    def __init__(self, page: Page, timeout: float = 300) -> None:
        self.page = page
        self.timeout = timeout

    # ---- 读取与操作界面

    def state(self) -> dict:
        return self.page.eval(STATE_JS)

    def wait_for(
        self,
        what: str,
        predicate: Callable[[dict], bool],
        timeout: float | None = None,
        fail_on_dialog: bool = True,
    ) -> dict:
        """等到 predicate 成立。期间出现确认框以外的对话框（操作失败等）时立即失败。"""
        deadline = time.time() + (self.timeout if timeout is None else timeout)
        while True:
            s = self.state()
            dialog = s["dialog"]
            if fail_on_dialog and dialog and not dialog["confirm"]:
                raise StepError(f"{what}：出现提示框「{dialog['title']}」{dialog['text']}")
            if predicate(s):
                return s
            if time.time() > deadline:
                raise StepError(f"{what}：等待超时（作业阶段：{s['phase'] or '未知'}）")
            time.sleep(0.25)

    def rect(self, selector: str) -> tuple[float, float, float, float]:
        rect = self.page.eval(
            f"(() => {{ const e = document.querySelector({json.dumps(selector)}); if (!e) return null; "
            "const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] })()"
        )
        if rect is None:
            raise StepError(f"找不到元素 {selector}")
        return tuple(rect)

    def tap(self, selector: str, fx: float = 0.5, fy: float = 0.5) -> None:
        """点击元素内按宽高比例给出的位置，默认为中心。"""
        left, top, width, height = self.rect(selector)
        self.page.tap(left + width * fx, top + height * fy)

    def tap_text(self, selector: str, text: str) -> None:
        """点击 selector 匹配的元素中文字为 text 的那一个。"""
        point = self.page.eval(
            f"(() => {{ const e = [...document.querySelectorAll({json.dumps(selector)})]"
            f".find((e) => e.textContent.trim() === {json.dumps(text)}); if (!e) return null; "
            "const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()"
        )
        if point is None:
            raise StepError(f"找不到按钮「{text}」")
        self.page.tap(*point)

    def press(self, button: str) -> str:
        """等按钮可用后点击，返回点击前的作业阶段。"""
        s = self.wait_for(f"等待按钮 {button} 可用", lambda s: s["enabled"][button], timeout=60)
        self.tap(f"[data-testid=btn-{button}]")
        return s["phase"]

    def answer_confirm(self, what: str, phase_before: str) -> None:
        """点击指令按钮后：弹出确认框时点确认；没有确认框时指令已直接发出，作业阶段会变化。"""
        s = self.wait_for(
            what,
            lambda s: bool(s["dialog"] and s["dialog"]["confirm"]) or s["phase"] != phase_before,
            timeout=15,
        )
        if s["dialog"] and s["dialog"]["confirm"]:
            self.tap(".dlg .dbtn.primary")

    def check_alarms(self, what: str, baseline: str) -> None:
        alarms = self.state()["alarms"]
        if alarms not in (NO_ALARM, baseline):
            raise StepError(f"{what}：出现告警（{alarms}）{self.alarm_details()}")

    def alarm_details(self) -> str:
        """展开告警面板读出内容，再收起。"""
        self.tap("[data-testid=sb-alarm]")
        time.sleep(0.5)
        try:
            return self.page.eval(
                "document.querySelector('[data-testid=alarm-panel]')?.textContent.trim() ?? ''"
            )
        finally:
            self.tap("[data-testid=sb-alarm]")

    # ---- 一轮中的各步

    def wait_ready(self, timeout: float = 120) -> dict:
        return self.wait_for(
            "连接服务端",
            lambda s: s["service"] == "已连接" and s["phase"] not in ("", "未知"),
            timeout=timeout,
            fail_on_dialog=False,
        )

    def scan(self, baseline_alarms: str) -> dict:
        before = self.press("scan")
        self.answer_confirm("开始扫描", before)
        # mock 加速运行时，扫描中、重建中可能短于轮询间隔，直接看到模型就绪
        self.wait_for(
            "开始扫描",
            lambda s: (
                s["phase"] in ("扫描中", "重建中")
                or (s["phase"] == "模型就绪" and before != "模型就绪")
            ),
            timeout=30,
        )
        started = time.time()
        self.wait_for("扫描和重建", lambda s: s["phase"] == "模型就绪")
        scan_s = time.time() - started
        self.wait_for("加载模型", lambda s: s["enabled"]["select"] and not s["loading"])
        self.check_alarms("加载模型", baseline_alarms)
        return {"scan_s": scan_s}

    def plan(self, baseline_alarms: str) -> dict:
        self.press("select")
        self.wait_for("进入选面", lambda s: s["selecting"], timeout=10)
        for fx, fy in SELECT_TAPS:
            self.tap("[data-testid=scene]", fx, fy)
            time.sleep(0.4)
        match = re.search(r"\d+", self.state()["selected"])
        selected = int(match.group()) if match else 0
        # 没有选择表面时，确认框询问是否规划全部表面
        before = self.press("plan")
        self.answer_confirm("开始规划", before)
        # 扫描后总是从模型就绪开始规划；看到规划就绪说明规划已经完成
        self.wait_for("开始规划", lambda s: s["phase"] in ("规划中", "规划就绪"), timeout=30)
        started = time.time()
        s = self.wait_for("规划", lambda s: s["phase"] == "规划就绪")
        plan_s = time.time() - started
        if s["selecting"]:
            self.tap_text("[data-testid=selection-toolbar] button", "退出选面")
        self.wait_for("加载规划", lambda s: s["enabled"]["animate"])
        self.check_alarms("加载规划", baseline_alarms)
        return {"selected": selected, "plan_s": plan_s}

    def animate(self, play_seconds: float, tail_seconds: float) -> None:
        """以最高倍速播放一段，拖到剩下 tail_seconds（动画时间）处播放到结束，再重新播放一会儿后退出。

        没有 GPU 时大样例每帧要几秒；从固定比例处播放到结束，规划时长较长时会很慢。
        """
        self.press("animate")
        self.wait_for("进入轨迹动画", lambda s: s["playbar"] is not None, timeout=10)
        self.tap(".playbar-speeds button:last-child")
        self.wait_for(
            "开始播放", lambda s: s["playbar"] is not None and s["playbar"]["playing"], timeout=10
        )
        time.sleep(play_seconds)
        playbar = self.state()["playbar"]
        if playbar is None or playbar["time"] <= 0:
            raise StepError("轨迹动画：播放时间没有前进")
        duration = playbar["duration"]
        self.tap(".playbar-track", max(0.0, 1 - tail_seconds / duration) if duration > 0 else 0.0)
        time.sleep(0.5)
        playbar = self.state()["playbar"]
        if playbar is not None and not playbar["playing"]:
            # 拖动前已经播放到结束：拖动后不会自动继续
            self.tap(".playbar-play")
        self.wait_for(
            "轨迹动画播放到结束",
            lambda s: (
                s["playbar"] is not None
                and not s["playbar"]["playing"]
                and s["playbar"]["time"] >= s["playbar"]["duration"]
            ),
        )
        self.tap("[aria-label=重新播放]")
        self.wait_for(
            "重新播放",
            lambda s: (
                s["playbar"] is not None
                and s["playbar"]["playing"]
                and s["playbar"]["time"] < s["playbar"]["duration"]
            ),
            timeout=10,
        )
        time.sleep(2)
        self.tap_text(".playbar button", "退出")
        self.wait_for("退出轨迹动画", lambda s: s["playbar"] is None, timeout=10)

    def execute(self, seconds: float) -> None:
        """开始清洗，执行 seconds 秒后停止。"""
        before = self.press("main")
        self.answer_confirm("开始清洗", before)
        self.wait_for("开始清洗", lambda s: s["phase"] == "执行中", timeout=30)
        time.sleep(seconds)
        before = self.press("stop")
        self.answer_confirm("停止", before)
        self.wait_for("停止", lambda s: s["phase"] == "规划就绪", timeout=60, fail_on_dialog=False)
        self.close_dialogs()

    def measures(self) -> dict:
        names = json.dumps(MEASURES)
        return self.page.eval(
            f"Object.fromEntries(Object.entries({names}).map(([key, name]) => "
            "[key, performance.getEntriesByName(name).at(-1)?.duration ?? null]))"
        )

    def round(
        self,
        baseline_alarms: str,
        play_seconds: float,
        tail_seconds: float,
        execute_seconds: float,
    ) -> dict:
        # 清除上一轮的耗时记录，本轮结束时读到的一定是本轮的
        self.page.eval(
            f"Object.values({json.dumps(MEASURES)}).forEach((n) => performance.clearMeasures(n))"
        )
        result = self.scan(baseline_alarms)
        result.update(self.plan(baseline_alarms))
        self.animate(play_seconds, tail_seconds)
        if execute_seconds > 0:
            self.execute(execute_seconds)
        result.update(self.measures())
        return result

    # ---- 失败后恢复到可以开始下一轮的状态

    def close_dialogs(self) -> list[str]:
        """关闭全部对话框：确认框点"取消"，提示框点唯一的按钮。返回关闭的对话框标题。"""
        titles = []
        for _ in range(10):
            dialog = self.state()["dialog"]
            if not dialog:
                break
            titles.append(dialog["title"])
            # 确认框的第一个按钮是"取消"，提示框只有一个按钮
            self.tap(".dlg .dbtn")
            time.sleep(0.5)
        return titles

    def recover(self) -> None:
        self.close_dialogs()
        s = self.state()
        if self.page.eval("!!document.querySelector('[data-testid=alarm-panel]')"):
            self.tap("[data-testid=sb-alarm]")
        if s["playbar"] is not None:
            self.tap_text(".playbar button", "退出")
        if s["selecting"]:
            self.tap_text("[data-testid=selection-toolbar] button", "退出选面")
        s = self.wait_for(
            "恢复", lambda s: s["phase"] not in BUSY_PHASES, fail_on_dialog=False, timeout=120
        )
        if s["phase"] in ("执行中", "已暂停"):
            before = self.press("stop")
            self.answer_confirm("停止", before)
            self.wait_for(
                "停止",
                lambda s: s["phase"] not in (BUSY_PHASES | {"执行中", "已暂停"}),
                timeout=60,
                fail_on_dialog=False,
            )
        self.close_dialogs()
