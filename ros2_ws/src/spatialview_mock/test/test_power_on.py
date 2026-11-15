"""PowerOn：机械臂上电（接口文档 6.9、8.2、8.7）。"""

import pytest

from spatialview_mock.core.constants import Code, Command, Phase, Robot


def last(rig):
    r = rig.state["last_result"]
    return r["operation"], r["result"], r["code"]


def power_on(rig, mode="PowerOff"):
    rig.send_driver(robot_mode=mode)
    assert rig.state["robot_state"] == Robot.DISABLED
    reply = rig.core.power_on()
    assert reply.code == Code.OK
    return reply


class TestConditions:
    @pytest.mark.parametrize("to_phase", ["scanning", "executing", "paused", "stopping"])
    def test_phase_checked_first(self, rig, to_phase):
        if to_phase == "scanning":
            rig.core.start_scan()
        else:
            rig.to_executing()
            if to_phase == "paused":
                rig.core.task_control(Command.PAUSE, "")
            elif to_phase == "stopping":
                rig.core.task_control(Command.STOP, "")
        assert rig.core.power_on().code == Code.INVALID_STATE

    def test_already_started_is_repeated_command(self, rig):
        assert rig.state["robot_state"] == Robot.READY
        reply = rig.core.power_on()
        assert reply.code == Code.INVALID_STATE
        assert reply.state is rig.core.last_published
        assert rig.hooks.power_on_calls == 0

    def test_starting_is_repeated_command(self, rig):
        power_on(rig)
        assert rig.core.power_on().code == Code.INVALID_STATE
        rig.send_driver(robot_mode="Running")
        rig.send_driver(robot_mode="BrakeReleasing")  # 在示教器上启动
        assert rig.core.power_on().code == Code.INVALID_STATE

    @pytest.mark.parametrize(
        "change",
        [{"safety_mode": "Fault"}, {"software_estop": True}, {"connected": False}],
    )
    def test_fault_estop_offline(self, rig, change):
        rig.send_driver(robot_mode="PowerOff", **change)
        assert rig.core.power_on().code == Code.ROBOT_NOT_READY

    @pytest.mark.parametrize("mode", ["ConfirmSafety", "BackDrive", "Maintaince", "PowerOffing"])
    def test_not_startable_by_software(self, rig, mode):
        rig.send_driver(robot_mode=mode)
        reply = rig.core.power_on()
        assert reply.code == Code.ROBOT_NOT_READY
        assert mode in reply.detail

    def test_driver_refuses(self, rig):
        rig.send_driver(robot_mode="PowerOff")
        rig.hooks.power_on_result = False
        assert rig.core.power_on().code == Code.DEVICE_ERROR
        assert rig.state["robot_state"] == Robot.DISABLED

    @pytest.mark.parametrize("phase", [Phase.NO_MODEL, Phase.RECONSTRUCTING, Phase.PLAN_READY])
    def test_accepted_in_other_phases(self, rig, phase):
        if phase == Phase.PLAN_READY:
            rig.to_plan_ready()
        elif phase == Phase.RECONSTRUCTING:
            rig.core.start_scan()
            rig.run(10.0)
        assert rig.core.phase == phase
        power_on(rig)
        assert rig.core.phase == phase  # 不改变作业阶段


class TestProcess:
    def test_reply_carries_starting(self, rig):
        seq = rig.core.seq
        rig.send_driver(robot_mode="PowerOff")
        seq = rig.core.seq
        reply = rig.core.power_on()
        assert reply.state["seq"] == seq + 1
        assert reply.state["robot_state"] == Robot.STARTING
        assert rig.hooks.published[-1] is reply.state
        assert reply.state["alarms"] == []  # 启动中不产生告警

    def test_success_through_all_modes(self, rig):
        power_on(rig)
        results = rig.core.result_count
        for mode in ("PowerOn", "Idle", "BrakeReleasing"):
            rig.send_driver(robot_mode=mode)
            rig.run(1.0)
            assert rig.state["robot_state"] == Robot.STARTING  # 停在 Idle 时也不变回 DISABLED
        assert rig.core.result_count == results
        rig.send_driver(robot_mode="Running")
        assert rig.state["robot_state"] == Robot.READY
        assert last(rig) == ("POWER_ON", "SUCCEEDED", "")
        assert rig.state["laser_state"] == "OFF"

    def test_from_idle_only_releases_brake(self, rig):
        power_on(rig, "Idle")
        rig.run(1.0)
        assert rig.state["robot_state"] == Robot.STARTING
        rig.send_driver(robot_mode="BrakeReleasing")
        rig.send_driver(robot_mode="Running")
        assert last(rig) == ("POWER_ON", "SUCCEEDED", "")

    @pytest.mark.parametrize(
        "change, code",
        [
            ({"software_estop": True}, Code.ROBOT_ESTOP),
            ({"safety_mode": "RobotEmergencyStop"}, Code.ROBOT_ESTOP),
            ({"safety_mode": "Fault"}, Code.ROBOT_FAULT),
            ({"safety_mode": "ProtectiveStop"}, Code.ROBOT_PROTECTIVE_STOP),
            ({"connected": False}, Code.ROBOT_OFFLINE),
        ],
    )
    def test_fails_on_estop_fault_offline(self, rig, change, code):
        power_on(rig)
        rig.send_driver(robot_mode="PowerOn")
        rig.send_driver(**change)
        assert last(rig) == ("POWER_ON", "FAILED", code)
        assert rig.state["robot_state"] != Robot.STARTING

    @pytest.mark.parametrize(
        "modes", [("PowerOn", "PowerOff"), ("PowerOn", "Idle", "BrakeReleasing", "Idle")]
    )
    def test_fails_when_mode_falls_back(self, rig, modes):
        power_on(rig)
        for mode in modes:
            rig.send_driver(
                robot_mode=mode, detail="关节 3 刹车未松开" if mode == modes[-1] else ""
            )
        assert last(rig) == ("POWER_ON", "FAILED", Code.DEVICE_ERROR)
        assert rig.state["last_result"]["detail"] == "关节 3 刹车未松开"
        assert rig.state["robot_state"] == Robot.DISABLED
        assert rig.core.power_on().code == Code.OK  # 回到未启动时可以再次上电

    def test_timeout(self, rig):
        power_on(rig)
        rig.send_driver(robot_mode="PowerOn")
        rig.run(29.0)
        assert rig.state["robot_state"] == Robot.STARTING
        rig.run(1.5)
        assert last(rig) == ("POWER_ON", "FAILED", Code.TIMEOUT)
        # 模式仍为上电中，按 8.2 仍是启动中
        assert rig.state["robot_state"] == Robot.STARTING
        rig.send_driver(robot_mode="PowerOff")
        assert rig.state["robot_state"] == Robot.DISABLED

    def test_teach_pendant_start_gives_no_result(self, rig):
        rig.send_driver(robot_mode="PowerOff")
        results = rig.core.result_count
        for mode in ("PowerOn", "Idle", "BrakeReleasing", "Running"):
            rig.send_driver(robot_mode=mode)
        assert rig.state["robot_state"] == Robot.READY
        assert rig.core.result_count == results

    def test_does_not_resume_interrupted_task(self, rig):
        rig.to_executing()
        rig.send_driver(robot_mode="PowerOff")
        assert rig.core.phase == Phase.PLAN_READY
        rig.core.power_on()
        rig.send_driver(robot_mode="Running")
        assert rig.core.phase == Phase.PLAN_READY
        assert rig.hooks.motion[-1] is False
