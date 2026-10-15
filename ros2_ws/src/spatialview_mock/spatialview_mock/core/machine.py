"""mock 服务端的状态机（服务端对接接口文档第 5–8 节）。

全部方法都在调用方持有的同一把锁下调用（接口文档 6.1：指令串行处理）。时间由 clock（单调时钟，秒）
和 wall_clock（时间戳，秒）给出，测试中可以替换。文件、驱动和发布等副作用通过 Hooks 交给调用方。
"""

from __future__ import annotations

import time
import uuid
from bisect import bisect_right
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol

from spatialview_mock.core.constants import (
    INTERFACE_VERSION,
    Camera,
    Code,
    Command,
    Laser,
    Level,
    Operation,
    Outcome,
    Phase,
    Robot,
)
from spatialview_mock.core.robot import (
    MOVABLE_ROBOT_STATES,
    derive_robot_state,
    robot_alarm_code,
    robot_reason_code,
)

IDLE_PHASES = (Phase.NO_MODEL, Phase.MODEL_READY, Phase.PLAN_READY)
TASK_PHASES = (Phase.EXECUTING, Phase.PAUSED, Phase.STOPPING)
TIMED_PHASES = (Phase.SCANNING, Phase.RECONSTRUCTING, Phase.PLANNING)
ROBOT_ALARMS = (
    Code.ROBOT_FAULT,
    Code.ROBOT_PROTECTIVE_STOP,
    Code.ROBOT_SAFEGUARD_STOP,
    Code.ROBOT_OFFLINE,
)
MODULES = {"scan": "扫描", "reconstruct": "重建", "plan": "规划", "execute": "执行"}
DEVICE_HEALTH = ("OK", "ERROR", "OFFLINE")
DEFAULT_FAILURE_CODES = {
    Operation.SCAN: Code.NO_VALID_DATA,
    Operation.RECONSTRUCT: Code.RECONSTRUCT_ERROR,
    Operation.PLAN: Code.NO_SOLUTION,
}
FAILURE_ALARMS = {
    Operation.SCAN: Code.SCAN_FAILED,
    Operation.RECONSTRUCT: Code.RECONSTRUCT_FAILED,
    Operation.PLAN: Code.PLAN_FAILED,
}
# 只有这些字段之外的变化才需要立即补发（接口文档 5.4）
VOLATILE_FIELDS = ("seq", "stamp", "progress", "exec_time")


class ExportError(RuntimeError):
    """导出模型或规划文件失败。"""


class InjectError(ValueError):
    """故障注入的动作或参数不合法。"""


@dataclass
class ModelFiles:
    url: str
    surfaces: dict[str, bool]  # surface_id → 能否清洗


@dataclass
class PlanFiles:
    url: str
    duration: float
    process_intervals: list[tuple[float, float]]


class Hooks(Protocol):
    def publish(self, state: dict) -> None: ...
    def clear_files(self) -> None: ...
    def write_model(self, model_id: str) -> ModelFiles: ...
    def write_plan(self, plan_id: str, model_id: str, surface_ids: list[str]) -> PlanFiles: ...
    def set_motion(self, active: bool) -> None: ...
    def clear_estop(self) -> bool: ...


@dataclass
class SimConfig:
    scan_seconds: float = 10.0
    reconstruct_seconds: float = 5.0
    plan_seconds: float = 5.0
    stop_seconds: float = 1.0
    speed: float = 1.0  # 耗时和执行的加速倍率
    publish_period: float = 0.5  # 定时发布周期（5.4）
    offline_grace: float = 5.0  # 启动后多久仍未取得状态才产生离线告警（8.8）
    driver_timeout: float = 1.0  # 超过这么久没有驱动状态，视为与控制器断开（8.2）


@dataclass
class Reply:
    code: str
    detail: str
    state: dict


@dataclass
class DriverView:
    connected: bool = False
    robot_mode: str = ""
    safety_mode: str = ""
    software_estop: bool = False
    motion_active: bool = False
    detail: str = ""
    received_at: float | None = None


@dataclass
class Device:
    """相机或激光器的健康状态：OK、ERROR、OFFLINE。"""

    health: str = "OK"


@dataclass
class Injection:
    fail_next: dict[str, tuple[str, str]] = field(default_factory=dict)  # 操作 → (原因码, 补充说明)
    partial_keep: int | None = None  # 下一次规划只成功前几个表面（PLAN_PARTIAL）
    interlock: tuple[bool, str] = (True, "")
    modules: dict[str, bool] = field(default_factory=lambda: dict.fromkeys(MODULES, True))
    next_code: tuple[str, str] | None = None  # 下一个指令直接返回这个状态码


def _empty_result() -> dict:
    return {"id": "", "operation": "", "result": "", "code": "", "detail": "", "stamp": _stamp(0.0)}


def _stamp(seconds: float) -> dict:
    sec = int(seconds)
    return {"sec": sec, "nanosec": int(round((seconds - sec) * 1e9)) % 1_000_000_000}


class MockCore:
    def __init__(
        self,
        hooks: Hooks,
        config: SimConfig | None = None,
        *,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
        session_id: str | None = None,
    ) -> None:
        self.hooks = hooks
        self.config = config or SimConfig()
        self.clock = clock
        self.wall_clock = wall_clock
        # 8.8：每次启动生成新会话，seq 从 1 开始，阶段为无模型，告警为空，删除旧文件
        self.session_id = session_id or uuid.uuid4().hex[:8]
        self.started_at = clock()
        self.seq = 0
        self.last_published: dict | None = None
        self.last_publish_at: float | None = None

        self.phase = Phase.NO_MODEL
        self.origin_phase = Phase.NO_MODEL
        self.operation_started = 0.0
        self.operation_duration = 0.0
        self.stop_until = 0.0
        self.pending_surfaces: list[str] = []

        self.model_id = ""
        self.model_url = ""
        self.surfaces: dict[str, bool] = {}
        self.plan_id = ""
        self.plan_url = ""
        self.plan_surface_ids: list[str] = []
        self.plan_duration = 0.0
        self.process_intervals: list[tuple[float, float]] = []
        self._interval_starts: list[float] = []
        self.exec_time = 0.0
        self.exec_updated = 0.0

        self.driver = DriverView()
        self.driver_seen = False
        self.leftover_checked = False
        self.camera = Device()
        self.laser_device = Device()
        self.laser_on = False  # 8.8：激光处于开启时关闭
        self.laser_manual = False
        self.laser_suppressed = False  # 执行中手动关闭后，后续工艺段不自动开启（6.6）
        self.client_count: int | None = None

        self.alarms: dict[str, dict] = {}
        self.last_result = _empty_result()
        self.result_count = 0
        self.used_ids: set[str] = set()
        self.injection = Injection()

        hooks.clear_files()

    # ------------------------------------------------------------------ 派生状态

    def _driver_connected(self) -> bool:
        d = self.driver
        return (
            d.connected
            and d.received_at is not None
            and self.clock() - d.received_at <= self.config.driver_timeout
        )

    @property
    def robot_state(self) -> str:
        d = self.driver
        return derive_robot_state(
            self._driver_connected(), d.robot_mode, d.safety_mode, d.software_estop, self.phase
        )

    @property
    def camera_state(self) -> str:
        return {"OK": Camera.OK, "ERROR": Camera.ERROR, "OFFLINE": Camera.OFFLINE}[
            self.camera.health
        ]

    @property
    def laser_state(self) -> str:
        if self.laser_device.health == "OFFLINE":
            return Laser.OFFLINE
        if self.laser_device.health == "ERROR":
            return Laser.ERROR
        return Laser.ON if self.laser_on else Laser.OFF

    def _progress(self) -> float:
        if self.phase not in TIMED_PHASES or self.operation_duration <= 0:
            return -1.0
        elapsed = self.clock() - self.operation_started
        return float(min(100.0, max(0.0, 100.0 * elapsed / self.operation_duration)))

    def _snapshot(self) -> dict:
        return {
            "interface_version": INTERFACE_VERSION,
            "session_id": self.session_id,
            "seq": self.seq,
            "stamp": _stamp(self.wall_clock()),
            "robot_state": self.robot_state,
            "software_estop": self.driver.software_estop,
            "camera_state": self.camera_state,
            "laser_state": self.laser_state,
            "phase": self.phase,
            "progress": self._progress(),
            "exec_time": self.exec_time if self.phase in TASK_PHASES else 0.0,
            "model_id": self.model_id,
            "model_url": self.model_url,
            "plan_id": self.plan_id,
            "plan_url": self.plan_url,
            "plan_surface_ids": list(self.plan_surface_ids),
            "alarms": [dict(a) for a in self.alarms.values()],
            "last_result": dict(self.last_result),
        }

    @staticmethod
    def _significant(state: dict) -> dict:
        return {k: v for k, v in state.items() if k not in VOLATILE_FIELDS}

    # ------------------------------------------------------------------ 发布

    def publish(self) -> dict:
        """以新的 seq 发布一次状态（接口文档 5.4）。"""
        self.seq += 1
        state = self._snapshot()
        self.last_published = state
        self.last_publish_at = self.clock()
        self.hooks.publish(state)
        return state

    def get_state(self) -> dict:
        """GetSystemState：最近一次发布的状态（6.2）。"""
        return self.last_published if self.last_published is not None else self.publish()

    def tick(self) -> None:
        """推进模拟并按规则处理设备变化；到了周期或有字段变化时发布。调用方每 50 毫秒左右调用一次。"""
        self._update()
        due = (
            self.last_publish_at is None
            or self.clock() - self.last_publish_at >= self.config.publish_period
        )
        if due or self._significant(self._snapshot()) != self._significant(self.last_published):
            self.publish()

    def _update(self) -> None:
        self._advance()
        self._apply_device_rules()
        self._sync_alarms()

    # ------------------------------------------------------------------ 输入

    def on_driver_state(
        self,
        *,
        connected: bool,
        robot_mode: str,
        safety_mode: str,
        software_estop: bool,
        motion_active: bool,
        detail: str = "",
    ) -> None:
        self.driver = DriverView(
            connected, robot_mode, safety_mode, software_estop, motion_active, detail, self.clock()
        )
        self.driver_seen = True
        if not self.leftover_checked:
            # 8.8：机械臂仍在执行上一次会话留下的扫描或清洗时，有序停止，关闭激光，产生告警
            self.leftover_checked = True
            if motion_active:
                self.hooks.set_motion(False)
                self.laser_on = self.laser_manual = False
                self._alarm_on(Code.LEFTOVER_TASK_STOPPED, Level.WARNING, "")
        self._update()

    def on_client_count(self, count: int) -> None:
        self.client_count = count
        self._update()

    def inject(self, action: str, args: dict) -> str:
        """服务端侧的故障注入（架构设计 6.3）；机械臂相关的注入由调用方转给模拟驱动。"""
        inj = self.injection
        if action in ("camera", "laser"):
            health = args.get("state")
            if health not in DEVICE_HEALTH:
                raise InjectError(f"state 应为 {'、'.join(DEVICE_HEALTH)} 之一")
            (self.camera if action == "camera" else self.laser_device).health = health
            if action == "laser" and health != "OK":
                self.laser_on = self.laser_manual = False
            message = f"{'相机' if action == 'camera' else '激光器'}状态改为 {health}"
        elif action == "fail_next":
            operation = args.get("operation")
            if operation not in DEFAULT_FAILURE_CODES:
                raise InjectError("operation 应为 SCAN、RECONSTRUCT、PLAN 之一")
            code = args.get("code") or DEFAULT_FAILURE_CODES[operation]
            inj.fail_next[operation] = (code, args.get("detail", ""))
            message = f"下一次 {operation} 失败，原因码 {code}"
        elif action == "plan_partial":
            keep = args.get("keep", 1)
            if not isinstance(keep, int) or keep < 0:
                raise InjectError("keep 应为非负整数")
            inj.partial_keep = keep
            message = f"下一次规划只成功前 {keep} 个表面"
        elif action == "interlock":
            ok = args.get("ok")
            if not isinstance(ok, bool):
                raise InjectError("ok 应为布尔值")
            inj.interlock = (ok, args.get("detail", "安全门未关闭") if not ok else "")
            message = "联锁满足" if ok else f"联锁不满足：{inj.interlock[1]}"
        elif action == "module":
            name, available = args.get("name"), args.get("available")
            if name not in MODULES or not isinstance(available, bool):
                raise InjectError(f"name 应为 {'、'.join(MODULES)} 之一，available 为布尔值")
            inj.modules[name] = available
            message = f"{MODULES[name]}模块{'可用' if available else '不可用'}"
        elif action == "next_code":
            code = args.get("code")
            if not isinstance(code, str) or not code or code == Code.OK:
                raise InjectError("code 应为 OK 以外的状态码，可以是未知的码")
            inj.next_code = (code, args.get("detail", ""))
            message = f"下一个指令返回 {code}"
        elif action == "speed":
            factor = args.get("factor")
            if not isinstance(factor, (int, float)) or isinstance(factor, bool) or factor <= 0:
                raise InjectError("factor 应为正数")
            self.config.speed = float(factor)
            message = f"加速倍率改为 {factor}"
        else:
            raise InjectError(f"未知的注入动作 {action}")
        self._update()
        return message

    # ------------------------------------------------------------------ 指令

    def _reject(self, code: str, detail: str = "") -> Reply:
        """拒绝：不改变任何状态，回复最近一次发布的状态（6.1 第 5 条）。"""
        return Reply(code, detail, self.get_state())

    def _accept(self) -> Reply:
        """受理：完成迁移后以新的 seq 发布，并在回复中带上同一份状态（6.1 第 3 条）。"""
        self._sync_alarms()
        return Reply(Code.OK, "", self.publish())

    def _injected(self) -> Reply | None:
        if self.injection.next_code is None:
            return None
        code, detail = self.injection.next_code
        self.injection.next_code = None
        return self._reject(code, detail)

    def _module_detail(self, names: list[str]) -> str:
        down = [MODULES[n] for n in names if not self.injection.modules[n]]
        return f"{'、'.join(down)}模块未运行"

    def start_scan(self) -> Reply:
        self._update()
        if (reply := self._injected()) is not None:
            return reply
        if self.phase not in IDLE_PHASES:
            return self._reject(Code.INVALID_STATE)
        if self.robot_state != Robot.READY:
            return self._reject(Code.ROBOT_NOT_READY)
        if self.camera_state != Camera.OK:
            return self._reject(Code.CAMERA_NOT_READY)
        modules = ["scan", "reconstruct"]
        if not all(self.injection.modules[n] for n in modules):
            return self._reject(Code.MODULE_UNAVAILABLE, self._module_detail(modules))
        self.origin_phase = self.phase
        self.laser_on = self.laser_manual = False
        for code in (*FAILURE_ALARMS.values(), Code.LEFTOVER_TASK_STOPPED):
            self.alarms.pop(code, None)
        self._begin(Phase.SCANNING, self.config.scan_seconds)
        self.hooks.set_motion(True)
        return self._accept()

    def start_plan(self, model_id: str, surface_ids: list[str]) -> Reply:
        self._update()
        if (reply := self._injected()) is not None:
            return reply
        if self.phase not in (Phase.MODEL_READY, Phase.PLAN_READY):
            return self._reject(Code.INVALID_STATE)
        if model_id != self.model_id:
            return self._reject(Code.MODEL_MISMATCH)
        for surface_id in surface_ids:
            if not self.surfaces.get(surface_id, False):
                return self._reject(Code.INVALID_SURFACE, f"表面 {surface_id} 不存在或不可清洗")
        if not self.injection.modules["plan"]:
            return self._reject(Code.MODULE_UNAVAILABLE, self._module_detail(["plan"]))
        self.origin_phase = self.phase
        self.alarms.pop(Code.PLAN_FAILED, None)
        requested = list(dict.fromkeys(surface_ids))
        # 为空表示全部可清洗表面（6.4）
        self.pending_surfaces = requested or [s for s, ok in self.surfaces.items() if ok]
        self._begin(Phase.PLANNING, self.config.plan_seconds)
        return self._accept()

    def task_control(self, command: str, plan_id: str) -> Reply:
        self._update()
        if (reply := self._injected()) is not None:
            return reply
        if command not in (Command.START, Command.PAUSE, Command.RESUME, Command.STOP):
            return self._reject(Code.INVALID_ARGUMENT, f"未知的命令 {command}")
        now = self.clock()
        if command == Command.START:
            if self.phase != Phase.PLAN_READY:
                return self._reject(Code.INVALID_STATE)
            if plan_id != self.plan_id:
                return self._reject(Code.PLAN_MISMATCH)
            if self.robot_state != Robot.READY:
                return self._reject(Code.ROBOT_NOT_READY)
            if self.laser_state not in (Laser.OFF, Laser.ON):
                return self._reject(Code.LASER_NOT_READY)
            if not self.injection.modules["execute"]:
                return self._reject(Code.MODULE_UNAVAILABLE, self._module_detail(["execute"]))
            # 再次执行从头开始（16.2）；手动开启的激光转由任务控制（6.5）
            self.phase = Phase.EXECUTING
            self.exec_time = 0.0
            self.exec_updated = now
            self.laser_manual = False
            self.laser_suppressed = False
            self._update_task_laser()
            self.hooks.set_motion(True)
        elif command == Command.PAUSE:
            if self.phase != Phase.EXECUTING:
                return self._reject(Code.INVALID_STATE)
            self.phase = Phase.PAUSED
            self.laser_on = False
        elif command == Command.RESUME:
            if self.phase != Phase.PAUSED:
                return self._reject(Code.INVALID_STATE)
            if self.robot_state != Robot.PAUSED:
                return self._reject(Code.ROBOT_NOT_READY)
            if self.laser_state not in (Laser.OFF, Laser.ON):
                return self._reject(Code.LASER_NOT_READY)
            self.phase = Phase.EXECUTING
            self.exec_updated = now
            self.laser_suppressed = False  # 暂停后继续时由任务恢复激光（6.6）
            self._update_task_laser()
        else:
            if self.phase not in (Phase.EXECUTING, Phase.PAUSED):
                return self._reject(Code.INVALID_STATE)
            self.phase = Phase.STOPPING
            self.stop_until = now + self.config.stop_seconds / self.config.speed
            self.laser_on = False
        return self._accept()

    def set_laser(self, on: bool) -> Reply:
        self._update()
        if (reply := self._injected()) is not None:
            return reply
        if on:
            if self.phase not in IDLE_PHASES:
                return self._reject(Code.INVALID_STATE)
            if self.robot_state != Robot.READY:
                return self._reject(Code.ROBOT_NOT_READY)
            if self.laser_state == Laser.ON:
                return self._reject(Code.INVALID_STATE)
            if self.laser_state != Laser.OFF:
                return self._reject(Code.LASER_NOT_READY)
            ok, detail = self.injection.interlock
            if not ok:
                return self._reject(Code.INTERLOCK, detail)
            self.laser_on = self.laser_manual = True
        else:
            # 任何阶段、任何设备状态下都受理；无法送达激光器时返回 DEVICE_ERROR（6.6）
            if self.laser_device.health == "OFFLINE":
                return self._reject(Code.DEVICE_ERROR, "激光器离线")
            self.laser_on = self.laser_manual = False
            if self.phase == Phase.EXECUTING:
                self.laser_suppressed = True
        return self._accept()

    def reset_estop(self) -> Reply:
        self._update()
        if (reply := self._injected()) is not None:
            return reply
        if not self.driver.software_estop:
            return self._reject(Code.INVALID_STATE)
        if self.phase in (Phase.SCANNING, *TASK_PHASES):
            return self._reject(Code.INVALID_STATE)
        if not self.hooks.clear_estop():
            return self._reject(Code.DEVICE_ERROR, "机械臂驱动没有确认清除锁存")
        self.driver.software_estop = False
        return self._accept()

    # ------------------------------------------------------------------ 推进与规则

    def _begin(self, phase: str, seconds: float) -> None:
        self.phase = phase
        self.operation_started = self.clock()
        self.operation_duration = seconds / self.config.speed

    def _due(self) -> bool:
        return self.clock() >= self.operation_started + self.operation_duration

    def _advance(self) -> None:
        if self.phase == Phase.SCANNING and self._due():
            self._finish_scan()
        elif self.phase == Phase.RECONSTRUCTING and self._due():
            self._finish_reconstruct()
        elif self.phase == Phase.PLANNING and self._due():
            self._finish_plan()
        elif self.phase == Phase.EXECUTING:
            now = self.clock()
            self.exec_time += (now - self.exec_updated) * self.config.speed
            self.exec_updated = now
            if self.exec_time >= self.plan_duration:
                self.exec_time = self.plan_duration
                self._finish_task(Outcome.SUCCEEDED, "")
            else:
                self._update_task_laser()
        elif self.phase == Phase.STOPPING and self.clock() >= self.stop_until:
            self._finish_task(Outcome.STOPPED, "")

    def _fail(self, operation: str, code: str, detail: str) -> None:
        self.phase = self.origin_phase
        self._result(operation, Outcome.FAILED, code, detail)
        self._alarm_on(FAILURE_ALARMS[operation], Level.WARNING, detail)

    def _finish_scan(self) -> None:
        self.hooks.set_motion(False)
        failure = self.injection.fail_next.pop(Operation.SCAN, None)
        if failure is not None:
            self._fail(Operation.SCAN, *failure)
            return
        self._begin(Phase.RECONSTRUCTING, self.config.reconstruct_seconds)

    def _finish_reconstruct(self) -> None:
        failure = self.injection.fail_next.pop(Operation.RECONSTRUCT, None)
        model_id = self._new_id("model")
        if failure is None:
            try:
                files = self.hooks.write_model(model_id)
            except ExportError:
                failure = (Code.EXPORT_ERROR, "模型文件导出失败")
        if failure is not None:
            self._fail(Operation.RECONSTRUCT, *failure)
            return
        # 新模型生效时清除规划（5.1）
        self.model_id, self.model_url, self.surfaces = model_id, files.url, dict(files.surfaces)
        self._set_plan("", "", [], 0.0, [])
        self.phase = Phase.MODEL_READY
        self._result(Operation.RECONSTRUCT, Outcome.SUCCEEDED, "", "")

    def _finish_plan(self) -> None:
        failure = self.injection.fail_next.pop(Operation.PLAN, None)
        surfaces = self.pending_surfaces
        code = detail = ""
        if failure is None and self.injection.partial_keep is not None:
            keep, self.injection.partial_keep = self.injection.partial_keep, None
            if keep <= 0:
                failure = (Code.NO_SOLUTION, "")
            elif keep < len(surfaces):
                code, detail = Code.PLAN_PARTIAL, f"{len(surfaces) - keep} 个表面不可达"
                surfaces = surfaces[:keep]
        plan_id = self._new_id("plan")
        if failure is None:
            try:
                files = self.hooks.write_plan(plan_id, self.model_id, surfaces)
            except ExportError:
                failure = (Code.EXPORT_ERROR, "规划文件导出失败")
        if failure is not None:
            self._fail(Operation.PLAN, *failure)
            return
        self._set_plan(plan_id, files.url, surfaces, files.duration, files.process_intervals)
        self.phase = Phase.PLAN_READY
        self._result(Operation.PLAN, Outcome.SUCCEEDED, code, detail)

    def _set_plan(self, plan_id, url, surfaces, duration, intervals) -> None:
        self.plan_id, self.plan_url, self.plan_surface_ids = plan_id, url, list(surfaces)
        self.plan_duration = float(duration)
        self.process_intervals = [(float(a), float(b)) for a, b in intervals]
        self._interval_starts = [a for a, _ in self.process_intervals]

    def _in_process(self, t: float) -> bool:
        i = bisect_right(self._interval_starts, t) - 1
        return i >= 0 and t <= self.process_intervals[i][1]

    def _update_task_laser(self) -> None:
        """执行中由任务按工艺段开关激光（8.6）。"""
        self.laser_on = (
            self._in_process(self.exec_time)
            and not self.laser_suppressed
            and self.laser_device.health == "OK"
        )

    def _finish_task(self, outcome: str, code: str) -> None:
        self.hooks.set_motion(False)
        self.laser_on = self.laser_manual = self.laser_suppressed = False
        self.phase = Phase.PLAN_READY
        self._result(Operation.TASK, outcome, code, "")

    def _interrupt_scan(self, code: str) -> None:
        self.hooks.set_motion(False)
        self.phase = self.origin_phase
        self._result(Operation.SCAN, Outcome.INTERRUPTED, code, "")

    def _apply_device_rules(self) -> None:
        """设备异常的处理（8.5）和激光的自动关闭（8.6）。"""
        robot = self.robot_state
        if robot not in MOVABLE_ROBOT_STATES:
            reason = robot_reason_code(robot, self.driver.safety_mode)
            if self.phase == Phase.SCANNING:
                self._interrupt_scan(reason)
            elif self.phase in TASK_PHASES:
                self._finish_task(Outcome.INTERRUPTED, reason)
            self.laser_on = self.laser_manual = False
        if self.phase == Phase.SCANNING and self.camera.health != "OK":
            code = Code.CAMERA_ERROR if self.camera.health == "ERROR" else Code.CAMERA_OFFLINE
            self._interrupt_scan(code)
        if self.phase in TASK_PHASES and self.laser_device.health != "OK":
            code = Code.LASER_ERROR if self.laser_device.health == "ERROR" else Code.LASER_OFFLINE
            self._finish_task(Outcome.INTERRUPTED, code)
        # APP 断开：客户端数降为 0，且不在执行中、已暂停、停止中时关闭手动开启的激光
        if self.client_count == 0 and self.laser_manual and self.phase not in TASK_PHASES:
            self.laser_on = self.laser_manual = False

    # ------------------------------------------------------------------ 结果与告警

    def _new_id(self, prefix: str) -> str:
        """带时间戳的 ID，服务端重启后也不重复（接口文档第 3 节）。"""
        base = f"{prefix}_{time.strftime('%Y%m%dT%H%M%S', time.localtime(self.wall_clock()))}"
        candidate, n = base, 1
        while candidate in self.used_ids:
            n += 1
            candidate = f"{base}_{n}"
        self.used_ids.add(candidate)
        return candidate

    def _result(self, operation: str, outcome: str, code: str, detail: str) -> None:
        self.result_count += 1
        self.last_result = {
            "id": f"{self.session_id}-{self.result_count}",
            "operation": operation,
            "result": outcome,
            "code": code,
            "detail": detail,
            "stamp": _stamp(self.wall_clock()),
        }

    def _alarm_on(self, code: str, level: str, detail: str) -> None:
        """产生或更新告警；同一 code 只有一条，持续期间 stamp 不变（8.7）。"""
        if code in self.alarms:
            self.alarms[code].update(level=level, detail=detail)
        else:
            self.alarms[code] = {
                "code": code,
                "level": level,
                "detail": detail,
                "stamp": _stamp(self.wall_clock()),
            }

    def _alarm_set(self, code: str, active: bool, level: str, detail: str = "") -> None:
        if active:
            self._alarm_on(code, level, detail)
        else:
            self.alarms.pop(code, None)

    def _sync_alarms(self) -> None:
        """设备和模块告警跟随当前状态（7.3）；启动 5 秒内不产生离线告警（8.8）。"""
        in_grace = self.clock() - self.started_at < self.config.offline_grace
        robot_code = robot_alarm_code(self.robot_state, self.driver.safety_mode)
        if robot_code == Code.ROBOT_OFFLINE and in_grace and not self.driver_seen:
            robot_code = None
        detail = self.driver.detail if robot_code != Code.ROBOT_OFFLINE else ""
        for code in ROBOT_ALARMS:
            self._alarm_set(code, code == robot_code, Level.ERROR, detail)
        for device, error, offline in (
            (self.camera, Code.CAMERA_ERROR, Code.CAMERA_OFFLINE),
            (self.laser_device, Code.LASER_ERROR, Code.LASER_OFFLINE),
        ):
            self._alarm_set(error, device.health == "ERROR", Level.ERROR)
            self._alarm_set(offline, device.health == "OFFLINE", Level.ERROR)
        down = [n for n, ok in self.injection.modules.items() if not ok]
        self._alarm_set(
            Code.MODULE_UNAVAILABLE,
            bool(down),
            Level.ERROR,
            self._module_detail(down) if down else "",
        )
