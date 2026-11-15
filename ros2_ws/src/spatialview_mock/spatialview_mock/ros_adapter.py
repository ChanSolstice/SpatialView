"""mock 服务端的 ROS 2 节点：/spatialview 下的 Topic 和 Service、故障注入，以及与模拟驱动的内部接口。

线程（接口文档 5.4、6.1）：指令 Service 在一个互斥回调组中串行处理；定时推进和订阅在另一个回调组；
调用模拟驱动的客户端在可重入回调组中，复位急停、上电时可以在指令回调里同步等待驱动的确认。
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from pathlib import Path

import rclpy
from builtin_interfaces.msg import Time
from rcl_interfaces.msg import ParameterDescriptor
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup, ReentrantCallbackGroup
from rclpy.executors import ExternalShutdownException, MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
from spatialview_mock_msgs.msg import DriverState
from spatialview_mock_msgs.srv import Inject
from spatialview_msgs.msg import Alarm, OperationResult, SystemState
from spatialview_msgs.srv import (
    GetSystemState,
    PowerOn,
    ResetEstop,
    SetLaser,
    StartPlan,
    StartScan,
    TaskControl,
)
from std_msgs.msg import Int32
from std_srvs.srv import SetBool, Trigger

from spatialview_mock.core.machine import InjectError, MockCore, Reply, SimConfig
from spatialview_mock.export.files import FileStore

DRIVER = "/spatialview_mock/driver"
LATCHED = QoSProfile(
    depth=1,
    history=HistoryPolicy.KEEP_LAST,
    reliability=ReliabilityPolicy.RELIABLE,
    durability=DurabilityPolicy.TRANSIENT_LOCAL,
)
TEXT_FIELDS = (
    "interface_version",
    "session_id",
    "robot_state",
    "camera_state",
    "laser_state",
    "phase",
    "model_id",
    "model_url",
    "plan_id",
    "plan_url",
)


def to_time(stamp: dict) -> Time:
    return Time(sec=stamp["sec"], nanosec=stamp["nanosec"])


def to_msg(state: dict) -> SystemState:
    msg = SystemState()
    for key in TEXT_FIELDS:
        setattr(msg, key, state[key])
    msg.seq = state["seq"]
    msg.stamp = to_time(state["stamp"])
    msg.software_estop = state["software_estop"]
    msg.progress = float(state["progress"])
    msg.exec_time = float(state["exec_time"])
    msg.plan_surface_ids = list(state["plan_surface_ids"])
    msg.alarms = [
        Alarm(code=a["code"], level=a["level"], detail=a["detail"], stamp=to_time(a["stamp"]))
        for a in state["alarms"]
    ]
    r = state["last_result"]
    msg.last_result = OperationResult(
        id=r["id"],
        operation=r["operation"],
        result=r["result"],
        code=r["code"],
        detail=r["detail"],
        stamp=to_time(r["stamp"]),
    )
    return msg


class MockServer(Node):
    def __init__(self) -> None:
        super().__init__("spatialview_mock")
        param = self.declare_parameter
        sample_dir = Path(param("sample_dir", "samples/small").value)
        files_dir = Path(param("files_dir", "/var/lib/spatialview/files").value)
        config = SimConfig(
            scan_seconds=self._number("scan_seconds", 10.0),
            reconstruct_seconds=self._number("reconstruct_seconds", 5.0),
            plan_seconds=self._number("plan_seconds", 5.0),
            stop_seconds=self._number("stop_seconds", 1.0),
            speed=self._number("speed", 1.0),
            power_on_timeout=self._number("power_on_timeout", 30.0),
        )

        self.lock = threading.Lock()
        self.store = FileStore(files_dir, sample_dir)
        self.commands = MutuallyExclusiveCallbackGroup()
        self.background = MutuallyExclusiveCallbackGroup()
        self.driver_clients = ReentrantCallbackGroup()

        self.publisher = self.create_publisher(SystemState, "/spatialview/system_state", 10)
        self.motion_client = self.create_client(
            SetBool, f"{DRIVER}/set_motion", callback_group=self.driver_clients
        )
        self.clear_client = self.create_client(
            Trigger, f"{DRIVER}/clear_estop", callback_group=self.driver_clients
        )
        self.power_client = self.create_client(
            Trigger, f"{DRIVER}/power_on", callback_group=self.driver_clients
        )
        self.driver_inject = self.create_client(
            Inject, f"{DRIVER}/inject", callback_group=self.driver_clients
        )
        self.core = MockCore(self, config)

        services = [
            (GetSystemState, "get_system_state", self._get_state),
            (StartScan, "start_scan", self._start_scan),
            (StartPlan, "start_plan", self._start_plan),
            (TaskControl, "task_control", self._task_control),
            (SetLaser, "set_laser", self._set_laser),
            (ResetEstop, "reset_estop", self._reset_estop),
            (PowerOn, "power_on", self._power_on),
        ]
        for service_type, name, handler in services:
            self.create_service(
                service_type, f"/spatialview/{name}", handler, callback_group=self.commands
            )
        self.create_service(
            Inject, "/spatialview_mock/inject", self._inject, callback_group=self.commands
        )
        self.create_subscription(
            Int32, "/client_count", self._client_count, LATCHED, callback_group=self.background
        )
        self.create_subscription(
            DriverState,
            f"{DRIVER}/state",
            self._driver_state,
            LATCHED,
            callback_group=self.background,
        )
        self.create_timer(0.05, self._tick, callback_group=self.background)
        self.get_logger().info(
            f"mock 服务端已启动：会话 {self.core.session_id}，样例 {sample_dir}，文件目录 {files_dir}"
        )

    def _number(self, name: str, default: float) -> float:
        """数值参数：命令行写成 5 时 ROS 按整数解析，允许整数和小数两种类型。"""
        descriptor = ParameterDescriptor(dynamic_typing=True)
        value = self.declare_parameter(name, default, descriptor).value
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
            raise ValueError(f"参数 {name} 应为正数，实际为 {value!r}")
        return float(value)

    # ---------------------------------------------------------------- MockCore 的副作用

    def publish(self, state: dict) -> None:
        self.publisher.publish(to_msg(state))

    def clear_files(self) -> None:
        self.store.clear()

    def write_model(self, model_id):
        return self.store.write_model(model_id)

    def write_plan(self, plan_id, model_id, surface_ids):
        return self.store.write_plan(plan_id, model_id, surface_ids)

    def set_motion(self, active: bool) -> None:
        if self.motion_client.service_is_ready():
            self.motion_client.call_async(SetBool.Request(data=active))
        else:
            self.get_logger().warning("模拟驱动不可用，无法下发运动指令")

    def clear_estop(self) -> bool:
        response = self._call(self.clear_client, Trigger.Request(), timeout=0.3)
        return bool(response is not None and response.success)

    def power_on(self) -> bool:
        response = self._call(self.power_client, Trigger.Request(), timeout=0.3)
        return bool(response is not None and response.success)

    def _call(self, client, request, timeout: float):
        """在指令回调中同步调用模拟驱动；响应由另一个执行线程处理。"""
        if not client.service_is_ready():
            return None
        done = threading.Event()
        future = client.call_async(request)
        future.add_done_callback(lambda _: done.set())
        if not done.wait(timeout):
            return None
        return future.result()

    # ---------------------------------------------------------------- Service

    def _command(self, name: str, request_text: str, response, call: Callable[[], Reply]):
        started = time.monotonic()
        with self.lock:
            before = self.core.phase
            reply = call()
        response.code, response.detail = reply.code, reply.detail
        response.state = to_msg(reply.state)
        # 接口文档 14.5：Service 名、请求参数、状态码、调用前后的阶段、耗时
        self.get_logger().info(
            f"{name}({request_text}) → {reply.code}"
            f"{'：' + reply.detail if reply.detail else ''}，"
            f"{before} → {reply.state['phase']}，{(time.monotonic() - started) * 1000:.1f} 毫秒"
        )
        return response

    def _get_state(self, request, response):
        with self.lock:
            response.state = to_msg(self.core.get_state())
        return response

    def _start_scan(self, request, response):
        return self._command(
            "start_scan",
            f"workpiece_type={request.workpiece_type}",
            response,
            lambda: self.core.start_scan(request.workpiece_type),
        )

    def _start_plan(self, request, response):
        surfaces = list(request.surface_ids)
        return self._command(
            "start_plan",
            f"model_id={request.model_id}, surface_ids={surfaces}",
            response,
            lambda: self.core.start_plan(request.model_id, surfaces),
        )

    def _task_control(self, request, response):
        return self._command(
            "task_control",
            f"command={request.command}, plan_id={request.plan_id}",
            response,
            lambda: self.core.task_control(request.command, request.plan_id),
        )

    def _set_laser(self, request, response):
        return self._command(
            "set_laser", f"on={request.on}", response, lambda: self.core.set_laser(request.on)
        )

    def _reset_estop(self, request, response):
        return self._command("reset_estop", "", response, self.core.reset_estop)

    def _power_on(self, request, response):
        return self._command("power_on", "", response, self.core.power_on)

    def _inject(self, request, response):
        try:
            args = json.loads(request.args) if request.args.strip() else {}
        except json.JSONDecodeError as exc:
            response.ok, response.message = False, f"args 不是 JSON：{exc}"
            return response
        if not isinstance(args, dict):
            response.ok, response.message = False, "args 应为 JSON 对象"
            return response
        if request.action.startswith("robot"):
            # 机械臂的状态由模拟驱动维护
            reply = self._call(
                self.driver_inject, Inject.Request(action=request.action, args=request.args), 1.0
            )
            if reply is None:
                response.ok, response.message = False, "模拟驱动不可用"
            else:
                response.ok, response.message = reply.ok, reply.message
        else:
            with self.lock:
                try:
                    response.message = self.core.inject(request.action, args)
                    response.ok = True
                except InjectError as exc:
                    response.ok, response.message = False, str(exc)
        level = self.get_logger().info if response.ok else self.get_logger().warning
        level(f"故障注入 {request.action} {request.args} → {response.message}")
        return response

    # ---------------------------------------------------------------- 定时推进与订阅

    def _tick(self) -> None:
        with self.lock:
            self.core.tick()

    def _client_count(self, msg: Int32) -> None:
        with self.lock:
            self.core.on_client_count(msg.data)

    def _driver_state(self, msg: DriverState) -> None:
        with self.lock:
            self.core.on_driver_state(
                connected=msg.connected,
                robot_mode=msg.robot_mode,
                safety_mode=msg.safety_mode,
                software_estop=msg.software_estop,
                motion_active=msg.motion_active,
                detail=msg.detail,
            )


def main(args=None) -> None:
    rclpy.init(args=args)
    node = MockServer()
    executor = MultiThreadedExecutor(num_threads=4)
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
