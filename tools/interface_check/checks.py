"""接口检查（接口文档 15.1）：经 rosbridge 和 HTTP 检查服务端是否符合接口文档。

默认只运行不会让机械臂运动、不会开启激光的用例：状态的结构和取值、发布频率和 seq、GetSystemState、
在当前阶段必然被拒绝的指令、当前的模型和规划文件。扫描与执行、激光、急停的用例需要显式开启，
并由现场人员看护。
"""

from __future__ import annotations

import gzip
import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from tools.common.urdf import parse_urdf
from tools.interface_check.contract import Contract, load
from tools.interface_check.rosbridge import Rosbridge, RosbridgeError
from tools.interface_check.state import validate_state
from tools.validate.model import validate_model
from tools.validate.plan import validate_plan
from tools.validate.report import Report

PREFIX = "spatialview_msgs/srv/"
SYSTEM_STATE = ("/spatialview/system_state", "spatialview_msgs/msg/SystemState")
IDLE = ("NO_MODEL", "MODEL_READY", "PLAN_READY")
SERVICE_DEADLINE = 0.5  # 指令 Service 必须在 500 毫秒内返回（接口文档 13）
CHECK_ID = "interface_check"


@dataclass
class Options:
    rosbridge: str = "ws://localhost:9090"
    http: str = "http://localhost:8080"
    estop_service: str = "/robot_driver/emergency_stop"
    urdf: Path | None = None
    tcp_link: str | None = None
    allow_motion: bool = False
    allow_laser: bool = False
    allow_estop: bool = False
    wait: float = 120.0  # 等待扫描、重建、规划、停止完成的最长时间，秒
    listen: float = 3.0  # 观察 SystemState 发布的时长，秒
    connect_timeout: float = 0.0  # 连接失败或服务端尚未就绪时重试的时长，秒


class Checker:
    def __init__(self, options: Options, contract: Contract | None = None) -> None:
        self.options = options
        self.contract = contract or load()
        self.report = Report(f"{options.rosbridge}、{options.http}", verb="接口检查")
        self.bridge: Rosbridge | None = None

    # ------------------------------------------------------------------ 公共

    def _connect(self) -> bool:
        """连接 rosbridge 并等到 GetSystemState 可用；connect_timeout 内失败时重试。"""
        deadline = time.monotonic() + self.options.connect_timeout
        while True:
            try:
                self.bridge = Rosbridge(self.options.rosbridge)
                self.bridge.call("/spatialview/get_system_state", PREFIX + "GetSystemState")
                return True
            except RosbridgeError as exc:
                if self.bridge is not None:
                    self.bridge.close()
                    self.bridge = None
                if time.monotonic() >= deadline:
                    self.report.error("CONNECT", str(exc))
                    return False
                time.sleep(1.0)

    def run(self) -> Report:
        if not self._connect():
            return self.report
        try:
            state = self.check_get_state()
            if state is None:
                return self.report
            self.check_topic()
            self.check_rejections(state)
            self.check_files(self.get_state() or state)
            if self.options.allow_laser:
                self.check_laser()
            if self.options.allow_motion:
                self.check_motion()
            if self.options.allow_estop:
                self.check_estop()
        finally:
            self.bridge.close()
        return self.report

    def get_state(self) -> dict | None:
        try:
            values, _ = self.bridge.call("/spatialview/get_system_state", PREFIX + "GetSystemState")
        except RosbridgeError as exc:
            self.report.error("SERVICE_FAILED", str(exc))
            return None
        return values.get("state") if isinstance(values, dict) else None

    def _state_ok(self, state, where: str) -> bool:
        problems = validate_state(state, self.contract, where)
        for problem in problems:
            self.report.error("STATE", problem)
        return not problems

    def command(self, name: str, service_type: str, args: dict, expected: tuple[str, ...]):
        """调用指令 Service，检查状态码、响应结构和耗时；返回响应，失败时返回 None。"""
        service = f"/spatialview/{name}"
        try:
            values, elapsed = self.bridge.call(service, PREFIX + service_type, args)
        except RosbridgeError as exc:
            self.report.error("SERVICE_FAILED", str(exc))
            return None
        label = f"{name}({json.dumps(args, ensure_ascii=False)})"
        if not isinstance(values, dict) or not {"code", "detail", "state"} <= set(values):
            self.report.error("SERVICE_RESPONSE", f"{label} 的响应缺少 code、detail 或 state")
            return None
        if not self._state_ok(values["state"], f"{label} 响应中的 state"):
            return None
        code = values["code"]
        if code not in expected:
            self.report.error("SERVICE_CODE", f"{label} 返回 {code}，应为 {' 或 '.join(expected)}")
        elif code not in self.contract.status_codes:
            self.report.error("SERVICE_CODE", f"{label} 返回的 {code} 不是接口文档中的状态码")
        if elapsed > SERVICE_DEADLINE:
            self.report.error(
                "SERVICE_TIME", f"{label} 用时 {elapsed * 1000:.0f} 毫秒，超过 500 毫秒"
            )
        return values

    def wait_for(self, condition, timeout: float, description: str) -> dict | None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            state = self.get_state()
            if state is not None and condition(state):
                return state
            time.sleep(0.3)
        self.report.error("TIMEOUT", f"{timeout:.0f} 秒内没有{description}")
        return None

    # ------------------------------------------------------------------ 默认用例

    def check_get_state(self) -> dict | None:
        state = self.get_state()
        if state is None:
            self.report.error("SERVICE_FAILED", "GetSystemState 没有返回状态")
            return None
        if not self._state_ok(state, "GetSystemState 返回的 state"):
            return None
        self.report.info(
            "STATE",
            f"会话 {state['session_id']}，阶段 {state['phase']}，机械臂 {state['robot_state']}，"
            f"相机 {state['camera_state']}，激光器 {state['laser_state']}",
        )
        return state

    def check_topic(self) -> None:
        received = self.bridge.collect(*SYSTEM_STATE, self.options.listen)
        if len(received) < 2:
            self.report.error(
                "TOPIC", f"{self.options.listen} 秒内只收到 {len(received)} 条 SystemState"
            )
            return
        times = [t for t, _ in received]
        states = [m for _, m in received]
        for i, message in enumerate(states):
            if not self._state_ok(message, f"第 {i + 1} 条 SystemState"):
                return
        rate = (len(times) - 1) / (times[-1] - times[0])
        gap = max(b - a for a, b in zip(times, times[1:], strict=False))
        if rate < 1.8:
            self.report.error("TOPIC_RATE", f"SystemState 每秒 {rate:.2f} 条，应为每 500 毫秒一次")
        if gap > 1.0:
            self.report.error("TOPIC_RATE", f"相邻两条 SystemState 最长间隔 {gap:.2f} 秒")
        sessions = {m["session_id"] for m in states}
        if len(sessions) != 1:
            self.report.error("TOPIC_SEQ", f"观察期间 session_id 变化：{sorted(sessions)}")
        seqs = [m["seq"] for m in states]
        if any(b != a + 1 for a, b in zip(seqs, seqs[1:], strict=False)):
            self.report.error("TOPIC_SEQ", f"seq 应每次加 1，实际为 {seqs}")
        self.report.info(
            "TOPIC",
            f"SystemState 每秒 {rate:.2f} 条，最长间隔 {gap:.2f} 秒，seq {seqs[0]}–{seqs[-1]}",
        )

    def check_rejections(self, state: dict) -> None:
        """在当前阶段必然被拒绝的指令：不会让机械臂运动，也不会开启激光。"""
        phase, robot = state["phase"], state["robot_state"]
        cases = [
            (
                "task_control",
                "TaskControl",
                {"command": CHECK_ID.upper(), "plan_id": ""},
                "INVALID_ARGUMENT",
            )
        ]
        if phase in ("MODEL_READY", "PLAN_READY"):
            cases.append(
                (
                    "start_plan",
                    "StartPlan",
                    {"model_id": f"model_{CHECK_ID}", "surface_ids": []},
                    "MODEL_MISMATCH",
                )
            )
            cases.append(
                (
                    "start_plan",
                    "StartPlan",
                    {"model_id": state["model_id"], "surface_ids": [f"surface_{CHECK_ID}"]},
                    "INVALID_SURFACE",
                )
            )
        else:
            cases.append(
                (
                    "start_plan",
                    "StartPlan",
                    {"model_id": f"model_{CHECK_ID}", "surface_ids": []},
                    "INVALID_STATE",
                )
            )
        start = {"command": "START", "plan_id": f"plan_{CHECK_ID}"}
        cases.append(
            (
                "task_control",
                "TaskControl",
                start,
                "PLAN_MISMATCH" if phase == "PLAN_READY" else "INVALID_STATE",
            )
        )
        if phase != "EXECUTING":
            cases.append(
                (
                    "task_control",
                    "TaskControl",
                    {"command": "PAUSE", "plan_id": ""},
                    "INVALID_STATE",
                )
            )
        if phase != "PAUSED":
            cases.append(
                (
                    "task_control",
                    "TaskControl",
                    {"command": "RESUME", "plan_id": ""},
                    "INVALID_STATE",
                )
            )
        if phase not in ("EXECUTING", "PAUSED"):
            cases.append(
                ("task_control", "TaskControl", {"command": "STOP", "plan_id": ""}, "INVALID_STATE")
            )
        if phase not in IDLE:
            cases.append(("start_scan", "StartScan", {}, "INVALID_STATE"))
            cases.append(("set_laser", "SetLaser", {"on": True}, "INVALID_STATE"))
        elif robot != "READY":
            cases.append(("start_scan", "StartScan", {}, "ROBOT_NOT_READY"))
            cases.append(("set_laser", "SetLaser", {"on": True}, "ROBOT_NOT_READY"))
        if not state["software_estop"]:
            cases.append(("reset_estop", "ResetEstop", {}, "INVALID_STATE"))
        laser_off = "DEVICE_ERROR" if state["laser_state"] == "OFFLINE" else "OK"
        cases.append(("set_laser", "SetLaser", {"on": False}, laser_off))

        for name, service_type, args, expected in cases:
            self.command(name, service_type, args, (expected,))
        after = self.get_state()
        if after is not None and after["phase"] != phase:
            self.report.error(
                "REJECT_CHANGED_STATE", f"被拒绝的指令改变了阶段：{phase} → {after['phase']}"
            )
        self.report.info("REJECTIONS", f"检查了 {len(cases)} 个指令的状态码")

    def fetch(self, url_path: str, *, gzip_expected: bool):
        url = self.options.http.rstrip("/") + url_path
        request = urllib.request.Request(url, headers={"Accept-Encoding": "gzip"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read()
                headers = response.headers
        except (urllib.error.URLError, OSError) as exc:
            self.report.error("HTTP", f"下载 {url} 失败：{exc}")
            return None
        if headers.get("Access-Control-Allow-Origin") != "*":
            self.report.error("HTTP_CORS", f"{url} 缺少响应头 Access-Control-Allow-Origin: *")
        if headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        elif gzip_expected:
            self.report.error(
                "HTTP_GZIP", f"{url} 没有启用 gzip（接口文档第 9 节要求 JSON 开启 gzip）"
            )
        return body

    def check_files(self, state: dict) -> None:
        if state["model_id"] and state["model_id"] == getattr(self, "_checked_model", (None,))[0]:
            model_info = self._checked_model[1]  # 同一个模型只校验一次
        elif state["model_id"]:
            body = self.fetch(state["model_url"], gzip_expected=False)
            if body is not None:
                report, model_info = validate_model(body, expected_model_id=state["model_id"])
                self._merge(report, f"模型 {state['model_id']}")
                self._checked_model = (state["model_id"], model_info)
            else:
                model_info = None
        else:
            model_info = None
            self.report.info("FILES", "当前没有模型，跳过文件检查")
        if state["plan_id"]:
            body = self.fetch(state["plan_url"], gzip_expected=True)
            if body is not None:
                plan = json.loads(body)
                robot = parse_urdf(self.options.urdf) if self.options.urdf else None
                report = validate_plan(
                    plan,
                    model=model_info,
                    robot=robot,
                    tcp_link=self.options.tcp_link,
                    expected_plan_id=state["plan_id"],
                    expected_model_id=state["model_id"],
                )
                self._merge(report, f"规划 {state['plan_id']}")
                if plan.get("surface_ids") != state["plan_surface_ids"]:
                    self.report.error(
                        "PLAN_SURFACES", "规划文件的 surface_ids 与 plan_surface_ids 不一致"
                    )

    def _merge(self, report: Report, label: str) -> None:
        for issue in report.issues:
            self.report.add(issue.level, issue.code, f"{label}：{issue.message}")
        for level, code, more in report._omitted():
            self.report.add(level, code, f"{label}：{code} 另有 {more} 处")

    # ------------------------------------------------------------------ 需要显式开启的用例

    def check_laser(self) -> None:
        state = self.get_state()
        if state is None:
            return
        if (
            state["phase"] not in IDLE
            or state["robot_state"] != "READY"
            or state["laser_state"] != "OFF"
        ):
            self.report.error("LASER", "激光用例需要阶段空闲、机械臂就绪、激光关闭")
            return
        on = self.command("set_laser", "SetLaser", {"on": True}, ("OK", "INTERLOCK"))
        if on is None:
            return
        if on["code"] == "INTERLOCK":
            self.report.info("LASER", f"联锁不满足，无法开启激光：{on['detail']}")
            return
        if self.wait_for(lambda s: s["laser_state"] == "ON", 2.0, "看到激光开启") is None:
            return
        self.command("set_laser", "SetLaser", {"on": False}, ("OK",))
        if self.wait_for(lambda s: s["laser_state"] == "OFF", 2.0, "看到激光关闭") is not None:
            self.report.info("LASER", "开启、关闭激光正常")

    def check_motion(self) -> None:
        state = self.get_state()
        if state is None:
            return
        if (
            state["phase"] not in IDLE
            or state["robot_state"] != "READY"
            or state["camera_state"] != "OK"
        ):
            self.report.error("MOTION", "扫描用例需要阶段空闲、机械臂就绪、相机正常")
            return
        if self.command("start_scan", "StartScan", {}, ("OK",)) is None:
            return
        state = self.wait_for(
            lambda s: s["phase"] == "MODEL_READY", self.options.wait, "完成扫描和重建"
        )
        if state is None:
            return
        self._expect_result(state, "RECONSTRUCT", "SUCCEEDED")
        self.check_files(state)
        if (
            self.command(
                "start_plan",
                "StartPlan",
                {"model_id": state["model_id"], "surface_ids": []},
                ("OK",),
            )
            is None
        ):
            return
        state = self.wait_for(lambda s: s["phase"] == "PLAN_READY", self.options.wait, "完成规划")
        if state is None:
            return
        self._expect_result(state, "PLAN", "SUCCEEDED")
        self.check_files(state)
        start = {"command": "START", "plan_id": state["plan_id"]}
        if self.command("task_control", "TaskControl", start, ("OK",)) is None:
            return
        state = self.wait_for(
            lambda s: s["phase"] == "EXECUTING" and s["exec_time"] > 0, 5.0, "看到执行时间增长"
        )
        if state is None:
            return
        if self.options.allow_estop:
            self._estop_during_task()
            return
        self.command("task_control", "TaskControl", {"command": "PAUSE", "plan_id": ""}, ("OK",))
        paused = self.wait_for(lambda s: s["phase"] == "PAUSED", 2.0, "进入已暂停")
        if paused is not None:
            time.sleep(1.0)
            later = self.get_state()
            if later is not None and later["exec_time"] != paused["exec_time"]:
                self.report.error("EXEC_TIME", "已暂停时 exec_time 仍在增长")
        self.command("task_control", "TaskControl", {"command": "RESUME", "plan_id": ""}, ("OK",))
        self.command("task_control", "TaskControl", {"command": "STOP", "plan_id": ""}, ("OK",))
        state = self.wait_for(
            lambda s: s["phase"] == "PLAN_READY", self.options.wait, "停止后回到规划就绪"
        )
        if state is not None:
            self._expect_result(state, "TASK", "STOPPED")
            self.report.info("MOTION", "扫描、重建、规划、开始、暂停、继续、停止正常")

    def _expect_result(self, state: dict, operation: str, result: str) -> None:
        r = state["last_result"]
        if (r["operation"], r["result"]) != (operation, result):
            self.report.error(
                "RESULT",
                f"last_result 为 {r['operation']} {r['result']} {r['code']}，应为 {operation} {result}",
            )

    def _call_estop(self) -> bool:
        try:
            values, _ = self.bridge.call(
                self.options.estop_service, "std_srvs/srv/Trigger", {}, timeout=1.0
            )
        except RosbridgeError as exc:
            self.report.error("ESTOP", f"急停 Service 调用失败：{exc}")
            return False
        if not values.get("success"):
            self.report.error("ESTOP", f"急停 Service 返回失败：{values.get('message')}")
            return False
        return True

    def _estop_during_task(self) -> None:
        if not self._call_estop():
            return
        state = self.wait_for(
            lambda s: s["robot_state"] == "ESTOP" and s["phase"] == "PLAN_READY",
            2.5,
            "在 2 秒内中断任务并显示急停",
        )
        if state is None:
            return
        if not state["software_estop"]:
            self.report.error("ESTOP", "急停后 software_estop 应为 true")
        self._expect_result(state, "TASK", "INTERRUPTED")
        if state["last_result"]["code"] != "ROBOT_ESTOP":
            self.report.error(
                "ESTOP", f"中断原因应为 ROBOT_ESTOP，实际为 {state['last_result']['code']}"
            )
        self._reset()

    def check_estop(self) -> None:
        state = self.get_state()
        if state is None:
            return
        if state["phase"] not in IDLE or state["software_estop"]:
            self.report.error("ESTOP", "急停用例需要阶段空闲、没有软件急停锁存")
            return
        if not self._call_estop():
            return
        state = self.wait_for(
            lambda s: s["robot_state"] == "ESTOP" and s["software_estop"], 2.0, "显示软件急停"
        )
        if state is not None:
            self._reset()

    def _reset(self) -> None:
        if self.command("reset_estop", "ResetEstop", {}, ("OK",)) is None:
            return
        state = self.wait_for(lambda s: not s["software_estop"], 2.0, "看到软件急停复位")
        if state is not None:
            self.report.info(
                "ESTOP", f"急停、锁存和复位正常，复位后机械臂为 {state['robot_state']}"
            )
