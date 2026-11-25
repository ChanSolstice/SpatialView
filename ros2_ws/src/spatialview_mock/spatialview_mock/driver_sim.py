"""模拟的机械臂驱动（与 mock 服务端分开运行）：急停 Service 和软件急停锁存（接口文档 6.7），
模拟的 ARCS 机械臂模式和安全模式（8.2）。

内部接口（相当于真实驱动与服务端程序之间的接口，不经 rosbridge 访问）：
- /spatialview_mock/driver/state：DriverState，transient local，每 100 毫秒和变化时发布
- /spatialview_mock/driver/clear_estop：清除锁存（ResetEstop 使用）
- /spatialview_mock/driver/set_motion：开始或结束运动；锁存期间拒绝开始
- /spatialview_mock/driver/power_on：上电并松开刹车，受理后在后台依次改变机械臂模式（PowerOn 使用）
- /spatialview_mock/driver/inject：机械臂相关的故障注入
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import rclpy
from rcl_interfaces.msg import ParameterDescriptor
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup
from rclpy.executors import ExternalShutdownException, MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
from spatialview_mock_msgs.msg import DriverState
from spatialview_mock_msgs.srv import Inject
from std_srvs.srv import SetBool, Trigger

from spatialview_mock.core.constants import ROBOT_MODES, SAFETY_MODES

DRIVER = "/spatialview_mock/driver"
LATCHED = QoSProfile(
    depth=1,
    history=HistoryPolicy.KEEP_LAST,
    reliability=ReliabilityPolicy.RELIABLE,
    durability=DurabilityPolicy.TRANSIENT_LOCAL,
)
MOVABLE_SAFETY_MODES = ("Normal", "ReducedMode")
STARTABLE_ROBOT_MODES = ("PowerOff", "Idle")
# 上电过程的各步（接口文档 6.9）：机械臂模式、耗时的参数名、失败时退回的模式
POWER_ON_STEPS = (
    ("PowerOn", "power_on_seconds", "PowerOff"),
    ("Idle", "idle_seconds", "Idle"),
    ("BrakeReleasing", "brake_release_seconds", "Idle"),
)
POWER_ON_FAIL_STEPS = {"power_on": "PowerOn", "brake_release": "BrakeReleasing"}

# 常用的机械臂状态变化（架构设计 6.3）
PRESETS = {
    "robot_fault": {"safety_mode": "Fault"},
    "robot_protective_stop": {"safety_mode": "ProtectiveStop"},
    "robot_safeguard_stop": {"safety_mode": "SafeguardStop"},
    "robot_estop": {"safety_mode": "RobotEmergencyStop"},
    "robot_estop_release": {"safety_mode": "Normal", "robot_mode": "Idle"},
    "robot_power_off": {"robot_mode": "PowerOff"},
    "robot_power_on": {"robot_mode": "Running"},
    "robot_recover": {"safety_mode": "Normal", "robot_mode": "Running", "detail": ""},
    "robot_power_on_fail": {},  # 下一次上电过程失败，见 _inject
    "robot_offline": {"connected": False},
    "robot_online": {"connected": True},
}


class DriverSim(Node):
    def __init__(self) -> None:
        super().__init__("spatialview_mock_driver")
        param = self.declare_parameter
        estop_service = param("estop_service", "/robot_driver/emergency_stop").value
        self.latch_file = Path(param("latch_file", "/tmp/spatialview_mock/estop_latched").value)
        self.step_seconds = {
            # 命令行写成 2 时 ROS 按整数解析，允许整数和小数两种类型
            name: float(param(name, default, ParameterDescriptor(dynamic_typing=True)).value)
            for name, default in (
                ("power_on_seconds", 2.0),
                ("idle_seconds", 0.5),
                ("brake_release_seconds", 2.0),
            )
        }
        self.lock = threading.Lock()
        self.power_steps: list[tuple[str, str, str]] = []  # 上电过程中还没有完成的各步
        self.power_step_until = 0.0
        self.power_fail: tuple[str, str] | None = None  # 下一次上电在哪一步失败、说明
        self.state = {
            "connected": True,
            "robot_mode": param("robot_mode", "Running").value,
            "safety_mode": param("safety_mode", "Normal").value,
            # 锁存保存在文件中，驱动进程重启后仍然保持（接口文档 6.7）
            "software_estop": self.latch_file.exists(),
            "motion_active": False,
            "detail": "",
        }
        self.estop_group = MutuallyExclusiveCallbackGroup()
        self.others = MutuallyExclusiveCallbackGroup()
        self.publisher = self.create_publisher(DriverState, f"{DRIVER}/state", LATCHED)
        # 急停 Service 使用独立的回调组，不会被其他回调阻塞（接口文档 6.7）
        self.create_service(Trigger, estop_service, self._estop, callback_group=self.estop_group)
        self.create_service(
            Trigger, f"{DRIVER}/clear_estop", self._clear, callback_group=self.others
        )
        self.create_service(
            SetBool, f"{DRIVER}/set_motion", self._set_motion, callback_group=self.others
        )
        self.create_service(
            Trigger, f"{DRIVER}/power_on", self._power_on, callback_group=self.others
        )
        self.create_service(Inject, f"{DRIVER}/inject", self._inject, callback_group=self.others)
        self.create_timer(0.1, self._tick, callback_group=self.others)
        self.get_logger().info(
            f"模拟驱动已启动：急停 Service {estop_service}，"
            f"软件急停{'已锁存' if self.state['software_estop'] else '未锁存'}"
        )

    def _movable(self) -> bool:
        s = self.state
        return (
            s["connected"]
            and s["robot_mode"] == "Running"
            and s["safety_mode"] in MOVABLE_SAFETY_MODES
        )

    def _publish(self) -> None:
        with self.lock:
            msg = DriverState(**self.state)
        self.publisher.publish(msg)

    def _tick(self) -> None:
        with self.lock:
            self._advance_power_on()
        self._publish()

    def _power_on_allowed(self) -> bool:
        s = self.state
        return (
            s["connected"] and s["safety_mode"] in MOVABLE_SAFETY_MODES and not s["software_estop"]
        )

    def _enter_power_step(self) -> None:
        mode, seconds, _ = self.power_steps[0]
        self.state["robot_mode"] = mode
        self.power_step_until = time.monotonic() + self.step_seconds[seconds]

    def _advance_power_on(self) -> None:
        """推进上电过程；持有锁时调用。急停、故障、断开，或模式被注入改变时放弃。"""
        if not self.power_steps:
            return
        mode, _, fallback = self.power_steps[0]
        if not self._power_on_allowed() or self.state["robot_mode"] != mode:
            if self.state["robot_mode"] == mode:
                self.state["robot_mode"] = fallback
            self.power_steps = []
            return
        if time.monotonic() < self.power_step_until:
            return
        if self.power_fail is not None and self.power_fail[0] == mode:
            self.state["robot_mode"], self.state["detail"] = fallback, self.power_fail[1]
            self.power_fail, self.power_steps = None, []
            return
        self.power_steps.pop(0)
        if self.power_steps:
            self._enter_power_step()
        else:
            self.state["robot_mode"] = "Running"

    def _power_on(self, request, response):
        with self.lock:
            mode = self.state["robot_mode"]
            if self.power_steps:
                response.success, response.message = False, "正在上电"
            elif mode not in STARTABLE_ROBOT_MODES or not self._power_on_allowed():
                response.success, response.message = False, "机械臂不能由软件启动"
            else:
                # 已上电、刹车未松开时只松开刹车
                self.power_steps = list(
                    POWER_ON_STEPS if mode == "PowerOff" else POWER_ON_STEPS[2:]
                )
                self.state["detail"] = ""
                self._enter_power_step()
                response.success, response.message = True, ""
        self._publish()
        self.get_logger().info(f"上电：{'开始' if response.success else response.message}")
        return response

    def _write_latch(self, latched: bool) -> None:
        if latched:
            self.latch_file.parent.mkdir(parents=True, exist_ok=True)
            self.latch_file.write_text("1\n", encoding="utf-8")
        else:
            self.latch_file.unlink(missing_ok=True)

    def _estop(self, request, response):
        # 任何状态下都执行，可以重复调用；停止运动的同时进入锁存。控制器未连接时返回失败，但同样锁存
        with self.lock:
            self.state["motion_active"] = False
            self.state["software_estop"] = True
            self._write_latch(True)
            connected = self.state["connected"]
        self._publish()
        response.success = connected
        response.message = "" if connected else "控制器未连接"
        self.get_logger().warning(f"软件急停：停止运动并锁存（success={connected}）")
        return response

    def _clear(self, request, response):
        with self.lock:
            self.state["software_estop"] = False
            self._write_latch(False)
        self._publish()
        response.success = True
        self.get_logger().info("软件急停锁存已清除")
        return response

    def _set_motion(self, request, response):
        with self.lock:
            if request.data and self.state["software_estop"]:
                response.success, response.message = False, "软件急停锁存中，不执行运动"
            elif request.data and not self._movable():
                response.success, response.message = False, "机械臂不可运动"
            else:
                self.state["motion_active"] = request.data
                response.success, response.message = True, ""
        self._publish()
        return response

    def _inject(self, request, response):
        try:
            args = json.loads(request.args) if request.args.strip() else {}
        except json.JSONDecodeError as exc:
            response.ok, response.message = False, f"args 不是 JSON：{exc}"
            return response
        if request.action == "robot":
            changes = {
                k: args[k]
                for k in ("connected", "robot_mode", "safety_mode", "detail")
                if k in args
            }
        elif request.action == "robot_power_on_fail":
            step = args.get("step", "brake_release")
            if step not in POWER_ON_FAIL_STEPS:
                response.ok = False
                response.message = f"step 应为 {'、'.join(POWER_ON_FAIL_STEPS)} 之一"
                return response
            detail = args.get("detail", "")
            if not isinstance(detail, str):
                response.ok, response.message = False, "detail 应为字符串"
                return response
            with self.lock:
                self.power_fail = (POWER_ON_FAIL_STEPS[step], detail)
            response.ok, response.message = True, f"下一次上电在 {step} 一步失败"
            return response
        elif request.action in PRESETS:
            changes = dict(PRESETS[request.action])
            if "detail" in args:
                changes["detail"] = args["detail"]
        else:
            response.ok = False
            response.message = (
                f"未知的机械臂注入 {request.action}，可用：robot、{'、'.join(PRESETS)}"
            )
            return response
        problem = self._invalid(changes)
        if problem:
            response.ok, response.message = False, problem
            return response
        with self.lock:
            self.state.update(changes)
            if not self._movable():
                self.state["motion_active"] = False
            snapshot = dict(self.state)
        self._publish()
        response.ok = True
        response.message = (
            f"机械臂：connected={snapshot['connected']}，robot_mode={snapshot['robot_mode']}，"
            f"safety_mode={snapshot['safety_mode']}"
        )
        return response

    @staticmethod
    def _invalid(changes: dict) -> str:
        if "robot_mode" in changes and changes["robot_mode"] not in ROBOT_MODES:
            return f"robot_mode 应为 {'、'.join(ROBOT_MODES)} 之一"
        if "safety_mode" in changes and changes["safety_mode"] not in SAFETY_MODES:
            return f"safety_mode 应为 {'、'.join(SAFETY_MODES)} 之一"
        if "connected" in changes and not isinstance(changes["connected"], bool):
            return "connected 应为布尔值"
        if "detail" in changes and not isinstance(changes["detail"], str):
            return "detail 应为字符串"
        return ""


def main(args=None) -> None:
    rclpy.init(args=args)
    node = DriverSim()
    executor = MultiThreadedExecutor(num_threads=3)
    executor.add_node(node)
    try:
        executor.spin()
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()
