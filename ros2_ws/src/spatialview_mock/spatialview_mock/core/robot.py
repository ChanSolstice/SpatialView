"""机械臂状态的推导（接口文档 8.2）和对应的告警码、中断原因码（7.2、7.3）。"""

from __future__ import annotations

from spatialview_mock.core.constants import Code, Phase, Robot

OFFLINE_ROBOT_MODES = {"NoController", "Disconnected"}
ESTOP_SAFETY_MODES = {"RobotEmergencyStop", "SystemEmergencyStop"}
FAULT_SAFETY_MODES = {"Fault", "Violation", "ProtectiveStop", "SafeguardStop", "Recovery"}
MOVABLE_SAFETY_MODES = {"Normal", "ReducedMode"}
RUNNING_PHASES = {Phase.SCANNING, Phase.EXECUTING, Phase.STOPPING}

# 机械臂可以接受运动指令的三种状态
MOVABLE_ROBOT_STATES = {Robot.READY, Robot.RUNNING, Robot.PAUSED}


def derive_robot_state(
    connected: bool, robot_mode: str, safety_mode: str, software_estop: bool, phase: str
) -> str:
    """按接口文档 8.2 的表格，同时满足多项时取靠前的一项。"""
    if not connected or robot_mode in OFFLINE_ROBOT_MODES:
        return Robot.OFFLINE
    if safety_mode in ESTOP_SAFETY_MODES or software_estop:
        return Robot.ESTOP
    if safety_mode in FAULT_SAFETY_MODES or robot_mode == "Error":
        return Robot.FAULT
    if robot_mode != "Running" or safety_mode not in MOVABLE_SAFETY_MODES:
        return Robot.DISABLED
    if phase in RUNNING_PHASES:
        return Robot.RUNNING
    if phase == Phase.PAUSED:
        return Robot.PAUSED
    return Robot.READY


def fault_code(safety_mode: str) -> str:
    """FAULT 的细分：保护性停止、防护停止，其余为机械臂故障。"""
    if safety_mode == "ProtectiveStop":
        return Code.ROBOT_PROTECTIVE_STOP
    if safety_mode == "SafeguardStop":
        return Code.ROBOT_SAFEGUARD_STOP
    return Code.ROBOT_FAULT


def robot_alarm_code(robot_state: str, safety_mode: str) -> str | None:
    """当前机械臂状态对应的告警码；急停、未启动和正常状态没有告警（7.3）。"""
    if robot_state == Robot.FAULT:
        return fault_code(safety_mode)
    if robot_state == Robot.OFFLINE:
        return Code.ROBOT_OFFLINE
    return None


def robot_reason_code(robot_state: str, safety_mode: str) -> str:
    """机械臂状态导致扫描或清洗中断时的原因码（7.2、8.5）。"""
    return {
        Robot.ESTOP: Code.ROBOT_ESTOP,
        Robot.DISABLED: Code.ROBOT_DISABLED,
        Robot.OFFLINE: Code.ROBOT_OFFLINE,
    }.get(robot_state) or fault_code(safety_mode)
