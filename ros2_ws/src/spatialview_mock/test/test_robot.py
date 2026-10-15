"""机械臂状态的推导（接口文档 8.2）和对应的告警码、原因码。"""

import pytest

from spatialview_mock.core.constants import ROBOT_MODES, SAFETY_MODES, Code, Phase, Robot
from spatialview_mock.core.robot import derive_robot_state, robot_alarm_code, robot_reason_code


def state(
    connected=True, robot_mode="Running", safety_mode="Normal", estop=False, phase=Phase.NO_MODEL
):
    return derive_robot_state(connected, robot_mode, safety_mode, estop, phase)


def test_offline():
    assert state(connected=False) == Robot.OFFLINE
    assert state(robot_mode="NoController") == Robot.OFFLINE
    assert state(robot_mode="Disconnected") == Robot.OFFLINE


@pytest.mark.parametrize("safety", ["RobotEmergencyStop", "SystemEmergencyStop"])
def test_device_estop(safety):
    assert state(safety_mode=safety) == Robot.ESTOP


def test_software_estop():
    assert state(estop=True) == Robot.ESTOP
    assert state(estop=True, robot_mode="PowerOff") == Robot.ESTOP
    assert state(estop=True, safety_mode="ProtectiveStop") == Robot.ESTOP


@pytest.mark.parametrize(
    "safety", ["Fault", "Violation", "ProtectiveStop", "SafeguardStop", "Recovery"]
)
def test_fault_by_safety_mode(safety):
    assert state(safety_mode=safety) == Robot.FAULT


def test_fault_by_robot_mode():
    assert state(robot_mode="Error") == Robot.FAULT


@pytest.mark.parametrize(
    "mode",
    [
        "PowerOff",
        "PowerOffing",
        "Booting",
        "PowerOn",
        "Idle",
        "BrakeReleasing",
        "ConfirmSafety",
        "BackDrive",
        "Maintaince",
    ],
)
def test_disabled(mode):
    assert state(robot_mode=mode) == Robot.DISABLED


def test_undefined_safety_is_disabled():
    assert state(safety_mode="Undefined") == Robot.DISABLED


@pytest.mark.parametrize("safety", ["Normal", "ReducedMode"])
@pytest.mark.parametrize(
    "phase, expected",
    [
        (Phase.NO_MODEL, Robot.READY),
        (Phase.SCANNING, Robot.RUNNING),
        (Phase.RECONSTRUCTING, Robot.READY),
        (Phase.MODEL_READY, Robot.READY),
        (Phase.PLANNING, Robot.READY),
        (Phase.PLAN_READY, Robot.READY),
        (Phase.EXECUTING, Robot.RUNNING),
        (Phase.PAUSED, Robot.PAUSED),
        (Phase.STOPPING, Robot.RUNNING),
    ],
)
def test_movable(safety, phase, expected):
    assert state(safety_mode=safety, phase=phase) == expected


def test_priority():
    # 同时满足多项时取表中靠前的一项
    assert state(connected=False, safety_mode="RobotEmergencyStop") == Robot.OFFLINE
    assert state(safety_mode="RobotEmergencyStop", robot_mode="Error") == Robot.ESTOP
    assert state(safety_mode="Fault", robot_mode="PowerOff") == Robot.FAULT


def test_every_mode_combination_has_a_state():
    for mode in ROBOT_MODES:
        for safety in SAFETY_MODES:
            assert state(robot_mode=mode, safety_mode=safety) in vars(Robot).values()


def test_alarm_and_reason_codes():
    assert robot_alarm_code(Robot.FAULT, "ProtectiveStop") == Code.ROBOT_PROTECTIVE_STOP
    assert robot_alarm_code(Robot.FAULT, "SafeguardStop") == Code.ROBOT_SAFEGUARD_STOP
    assert robot_alarm_code(Robot.FAULT, "Fault") == Code.ROBOT_FAULT
    assert robot_alarm_code(Robot.OFFLINE, "") == Code.ROBOT_OFFLINE
    for quiet in (Robot.ESTOP, Robot.DISABLED, Robot.READY, Robot.RUNNING, Robot.PAUSED):
        assert robot_alarm_code(quiet, "Normal") is None
    assert robot_reason_code(Robot.ESTOP, "Normal") == Code.ROBOT_ESTOP
    assert robot_reason_code(Robot.DISABLED, "Normal") == Code.ROBOT_DISABLED
    assert robot_reason_code(Robot.OFFLINE, "") == Code.ROBOT_OFFLINE
    assert robot_reason_code(Robot.FAULT, "SafeguardStop") == Code.ROBOT_SAFEGUARD_STOP
