"""设备异常的处理（接口文档 8.5）和激光规则（8.6）。"""

import pytest

from spatialview_mock.core.constants import Code, Command, Laser, Phase


def last(rig):
    r = rig.state["last_result"]
    return r["operation"], r["result"], r["code"]


@pytest.mark.parametrize(
    "change, code",
    [
        ({"safety_mode": "Fault"}, Code.ROBOT_FAULT),
        ({"safety_mode": "ProtectiveStop"}, Code.ROBOT_PROTECTIVE_STOP),
        ({"safety_mode": "SafeguardStop"}, Code.ROBOT_SAFEGUARD_STOP),
        ({"safety_mode": "SystemEmergencyStop"}, Code.ROBOT_ESTOP),
        ({"software_estop": True}, Code.ROBOT_ESTOP),
        ({"robot_mode": "Idle"}, Code.ROBOT_DISABLED),
        ({"connected": False}, Code.ROBOT_OFFLINE),
    ],
)
def test_scan_interrupted_by_robot(rig, change, code):
    rig.core.start_scan()
    rig.run(1.0)
    rig.send_driver(**change)
    assert rig.core.phase == Phase.NO_MODEL
    assert last(rig) == ("SCAN", "INTERRUPTED", code)


def test_driver_silence_means_offline(rig):
    rig.core.start_scan()
    rig.driver_alive = False
    rig.run(1.5)
    assert rig.state["robot_state"] == "OFFLINE"
    assert last(rig) == ("SCAN", "INTERRUPTED", Code.ROBOT_OFFLINE)


@pytest.mark.parametrize(
    "health, code", [("ERROR", Code.CAMERA_ERROR), ("OFFLINE", Code.CAMERA_OFFLINE)]
)
def test_scan_interrupted_by_camera(rig, health, code):
    rig.core.start_scan()
    rig.core.inject("camera", {"state": health})
    assert last(rig) == ("SCAN", "INTERRUPTED", code)


def test_laser_does_not_affect_scan(rig):
    rig.core.start_scan()
    rig.core.inject("laser", {"state": "ERROR"})
    assert rig.core.phase == Phase.SCANNING


@pytest.mark.parametrize("phase", [Phase.RECONSTRUCTING, Phase.PLANNING])
def test_computation_unaffected(rig, phase):
    if phase == Phase.RECONSTRUCTING:
        rig.core.start_scan()
        rig.run(10.0)
    else:
        rig.to_model_ready()
        rig.core.start_plan(rig.core.model_id, [])
    rig.send_driver(safety_mode="Fault")
    rig.core.inject("camera", {"state": "OFFLINE"})
    assert rig.core.phase == phase
    rig.run(5.0)
    assert rig.core.phase in (Phase.MODEL_READY, Phase.PLAN_READY)


@pytest.mark.parametrize("phase", [Phase.EXECUTING, Phase.PAUSED, Phase.STOPPING])
def test_task_interrupted_by_robot(rig, phase):
    rig.to_executing()
    if phase == Phase.PAUSED:
        rig.core.task_control(Command.PAUSE, "")
    elif phase == Phase.STOPPING:
        rig.core.task_control(Command.STOP, "")
    rig.send_driver(safety_mode="ProtectiveStop", detail="检测到碰撞")
    assert rig.core.phase == Phase.PLAN_READY
    assert last(rig) == ("TASK", "INTERRUPTED", Code.ROBOT_PROTECTIVE_STOP)
    assert rig.state["laser_state"] == Laser.OFF
    assert rig.hooks.motion[-1] is False


def test_task_unaffected_by_camera_but_interrupted_by_laser(rig):
    rig.to_executing()
    rig.core.inject("camera", {"state": "ERROR"})
    assert rig.core.phase == Phase.EXECUTING
    rig.core.inject("laser", {"state": "OFFLINE"})
    assert last(rig) == ("TASK", "INTERRUPTED", Code.LASER_OFFLINE)


class TestLaser:
    def test_task_follows_process_segments(self, rig):
        rig.to_executing()  # 工艺段：0–10 秒、20–90 秒
        assert rig.state["laser_state"] == Laser.ON
        rig.run(12.0)
        assert rig.state["laser_state"] == Laser.OFF
        rig.run(10.0)
        assert rig.state["laser_state"] == Laser.ON

    def test_manual_laser_handed_over_to_task(self, rig):
        rig.to_plan_ready()
        rig.core.set_laser(True)
        rig.core.task_control(Command.START, rig.core.plan_id)
        rig.run(12.0)
        assert rig.state["laser_state"] == Laser.OFF  # 空行程：由任务关闭

    def test_manual_off_during_task_until_resume(self, rig):
        rig.to_executing()
        rig.core.set_laser(False)
        rig.run(25.0)
        assert rig.state["laser_state"] == Laser.OFF  # 后续工艺段不再自动开启
        rig.core.task_control(Command.PAUSE, "")
        assert rig.state["laser_state"] == Laser.OFF
        rig.core.task_control(Command.RESUME, "")
        assert rig.state["laser_state"] == Laser.ON  # 暂停后继续时由任务恢复

    @pytest.mark.parametrize(
        "trigger",
        [
            "start_scan",
            "robot_fault",
            "robot_estop",
            "robot_disabled",
            "robot_offline",
            "app_disconnected",
        ],
    )
    def test_auto_off(self, rig, trigger):
        rig.to_model_ready()
        rig.core.set_laser(True)
        assert rig.state["laser_state"] == Laser.ON
        if trigger == "start_scan":
            rig.core.start_scan()
        elif trigger == "robot_fault":
            rig.send_driver(safety_mode="Fault")
        elif trigger == "robot_estop":
            rig.send_driver(software_estop=True)
        elif trigger == "robot_disabled":
            rig.send_driver(robot_mode="PowerOff")
        elif trigger == "robot_offline":
            rig.send_driver(connected=False)
        else:
            rig.core.on_client_count(0)
        assert rig.state["laser_state"] == Laser.OFF

    def test_app_disconnect_does_not_stop_task(self, rig):
        rig.to_executing()
        rig.core.on_client_count(0)
        assert rig.core.phase == Phase.EXECUTING
        assert rig.state["laser_state"] == Laser.ON


class TestNoLightTask:
    """开始时激光器异常或离线的任务整次不出光（6.5、8.5、8.6）。"""

    @pytest.mark.parametrize("health, laser", [("ERROR", Laser.ERROR), ("OFFLINE", Laser.OFFLINE)])
    def test_runs_without_light_even_after_laser_recovers(self, rig, health, laser):
        rig.to_plan_ready()
        rig.core.inject("laser", {"state": health})
        assert rig.core.task_control(Command.START, rig.core.plan_id).code == Code.OK
        rig.run(5.0)  # 工艺段内
        assert rig.core.phase == Phase.EXECUTING
        assert rig.state["laser_state"] == laser
        rig.core.inject("laser", {"state": "OK"})
        rig.run(1.0)
        assert rig.state["laser_state"] == Laser.OFF  # 中途恢复也不开启
        rig.core.task_control(Command.PAUSE, "")
        rig.core.task_control(Command.RESUME, "")
        rig.run(1.0)
        assert rig.state["laser_state"] == Laser.OFF  # 暂停后继续仍不出光
        rig.core.inject("laser", {"state": "ERROR"})  # 激光器的状态变化不影响任务
        assert rig.core.phase == Phase.EXECUTING
        rig.run(100.0)
        assert last(rig) == ("TASK", "SUCCEEDED", "")

    def test_next_task_is_normal(self, rig):
        rig.to_plan_ready()
        rig.core.inject("laser", {"state": "OFFLINE"})
        rig.core.task_control(Command.START, rig.core.plan_id)
        rig.core.task_control(Command.STOP, "")
        rig.run(2.0)
        assert rig.core.phase == Phase.PLAN_READY
        rig.core.inject("laser", {"state": "OK"})
        rig.core.task_control(Command.START, rig.core.plan_id)
        rig.run(5.0)
        assert rig.state["laser_state"] == Laser.ON
        rig.core.inject("laser", {"state": "ERROR"})  # 正常任务仍按 8.5 中断
        assert last(rig) == ("TASK", "INTERRUPTED", Code.LASER_ERROR)

    def test_robot_fault_still_interrupts(self, rig):
        rig.to_plan_ready()
        rig.core.inject("laser", {"state": "OFFLINE"})
        rig.core.task_control(Command.START, rig.core.plan_id)
        rig.send_driver(safety_mode="Fault")
        assert last(rig) == ("TASK", "INTERRUPTED", Code.ROBOT_FAULT)
