"""设备异常的处理（接口文档 8.5）和激光规则（8.6）。"""

import pytest

from spatialview_mock.core.constants import Code, Command, Laser, Phase, Robot
from spatialview_mock.core.machine import InjectError


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


def test_executing_interrupted_by_robot_pauses(rig):
    """执行中被中断：停在已暂停，保留执行进度和规划（8.4、8.5）。"""
    rig.to_executing()
    rig.run(5.0)
    plan_id = rig.core.plan_id
    rig.send_driver(safety_mode="ProtectiveStop", detail="检测到碰撞")
    state = rig.state
    assert state["phase"] == Phase.PAUSED
    assert last(rig) == ("TASK", "INTERRUPTED", Code.ROBOT_PROTECTIVE_STOP)
    assert state["laser_state"] == Laser.OFF
    assert rig.hooks.motion[-1] is False
    assert state["exec_time"] == pytest.approx(5.0)
    assert (state["plan_id"], state["model_id"]) == (plan_id, rig.core.model_id)
    rig.run(3.0)
    assert rig.state["exec_time"] == pytest.approx(5.0)  # 中断后不增长


def test_paused_unaffected_by_robot(rig):
    """已暂停时出现设备异常：阶段不变，不产生结果（8.4）。"""
    rig.to_executing()
    rig.core.task_control(Command.PAUSE, "")
    results = rig.core.result_count
    rig.send_driver(safety_mode="ProtectiveStop")
    rig.core.inject("laser", {"state": "ERROR"})
    assert rig.state["phase"] == Phase.PAUSED
    assert rig.core.result_count == results


def test_stopping_interrupted_by_robot(rig):
    rig.to_executing()
    rig.core.task_control(Command.STOP, "")
    rig.send_driver(safety_mode="ProtectiveStop")
    assert rig.core.phase == Phase.PLAN_READY
    assert last(rig) == ("TASK", "INTERRUPTED", Code.ROBOT_PROTECTIVE_STOP)
    assert rig.hooks.motion[-1] is False


def test_stopping_interrupted_by_laser(rig):
    rig.to_executing()
    rig.core.task_control(Command.STOP, "")
    rig.core.inject("laser", {"state": "OFFLINE"})
    assert rig.core.phase == Phase.PLAN_READY
    assert last(rig) == ("TASK", "INTERRUPTED", Code.LASER_OFFLINE)


def test_task_unaffected_by_camera_but_interrupted_by_laser(rig):
    rig.to_executing()
    rig.core.inject("camera", {"state": "ERROR"})
    assert rig.core.phase == Phase.EXECUTING
    rig.core.inject("laser", {"state": "OFFLINE"})
    assert rig.core.phase == Phase.PAUSED
    assert last(rig) == ("TASK", "INTERRUPTED", Code.LASER_OFFLINE)


class TestResumeAfterInterruption:
    """中断后排除故障，从中断处继续（6.5"中断后继续"）。"""

    def test_estop_reset_resume_completes(self, rig):
        rig.to_executing()
        rig.run(30.0)
        rig.send_driver(software_estop=True)
        assert rig.core.phase == Phase.PAUSED
        assert last(rig) == ("TASK", "INTERRUPTED", Code.ROBOT_ESTOP)
        assert rig.core.task_control(Command.RESUME, "").code == Code.ROBOT_NOT_READY
        assert rig.core.reset_estop().code == Code.OK
        rig.send_driver(software_estop=False)
        assert rig.state["robot_state"] == Robot.PAUSED
        reply = rig.core.task_control(Command.RESUME, "")
        assert reply.code == Code.OK
        assert reply.state["phase"] == Phase.EXECUTING
        assert reply.state["exec_time"] == pytest.approx(30.0)  # 从中断处继续，不从头开始
        assert reply.state["laser_state"] == Laser.ON  # 工艺段内由任务重新开启
        assert rig.hooks.motion[-1] is True
        rig.run(80.0, step=0.5)
        assert rig.core.phase == Phase.PLAN_READY
        assert last(rig) == ("TASK", "SUCCEEDED", "")

    def test_power_off_power_on_resume(self, rig):
        rig.to_executing()
        rig.run(5.0)
        rig.send_driver(robot_mode="PowerOff")
        assert last(rig) == ("TASK", "INTERRUPTED", Code.ROBOT_DISABLED)
        assert rig.core.power_on().code == Code.OK
        rig.send_driver(robot_mode="Running")
        assert rig.state["phase"] == Phase.PAUSED  # 上电不自动继续
        assert rig.core.task_control(Command.RESUME, "").code == Code.OK

    def test_laser_must_recover_for_normal_task(self, rig):
        rig.to_executing()
        rig.core.inject("laser", {"state": "ERROR"})
        assert rig.core.phase == Phase.PAUSED
        assert rig.core.task_control(Command.RESUME, "").code == Code.LASER_NOT_READY
        rig.core.inject("laser", {"state": "OFFLINE"})
        assert rig.core.task_control(Command.RESUME, "").code == Code.LASER_NOT_READY
        rig.core.inject("laser", {"state": "OK"})
        assert rig.core.task_control(Command.RESUME, "").code == Code.OK
        assert rig.state["laser_state"] == Laser.ON

    def test_stop_when_robot_cannot_move_completes_immediately(self, rig):
        rig.to_executing()
        rig.send_driver(software_estop=True)
        reply = rig.core.task_control(Command.STOP, "")
        assert reply.code == Code.OK
        assert reply.state["phase"] == Phase.PLAN_READY
        assert last(rig) == ("TASK", "STOPPED", "")
        rig.core.reset_estop()
        rig.send_driver(software_estop=False)
        rig.core.task_control(Command.START, rig.core.plan_id)
        assert rig.state["exec_time"] == 0.0  # 停止后再开始从头执行

    def test_stop_after_recovery_is_orderly(self, rig):
        rig.to_executing()
        rig.send_driver(safety_mode="ProtectiveStop")
        rig.send_driver(safety_mode="Normal")
        assert rig.core.task_control(Command.STOP, "").state["phase"] == Phase.STOPPING
        rig.run(1.0)
        assert last(rig) == ("TASK", "STOPPED", "")

    def test_scan_and_plan_rejected_while_paused(self, rig):
        rig.to_executing()
        rig.send_driver(safety_mode="Fault")
        rig.send_driver(safety_mode="Normal")
        assert rig.core.start_scan().code == Code.INVALID_STATE
        assert rig.core.start_plan(rig.core.model_id, []).code == Code.INVALID_STATE


class TestTaskErrorInjection:
    @pytest.mark.parametrize(
        "code", [Code.DEVICE_ERROR, Code.MODULE_UNAVAILABLE, Code.INTERNAL_ERROR]
    )
    def test_pauses_with_code(self, rig, code):
        rig.to_executing()
        rig.run(5.0)
        rig.core.inject("task_error", {"code": code, "detail": "控制器拒绝轨迹"})
        state = rig.state
        assert state["phase"] == Phase.PAUSED
        assert last(rig) == ("TASK", "INTERRUPTED", code)
        assert state["last_result"]["detail"] == "控制器拒绝轨迹"
        assert state["exec_time"] == pytest.approx(5.0)
        assert state["laser_state"] == Laser.OFF
        assert rig.core.task_control(Command.RESUME, "").code == Code.OK

    def test_default_code_and_stopping(self, rig):
        rig.to_executing()
        rig.core.task_control(Command.STOP, "")
        rig.core.inject("task_error", {})
        assert rig.core.phase == Phase.PLAN_READY
        assert last(rig) == ("TASK", "INTERRUPTED", Code.DEVICE_ERROR)

    def test_invalid(self, rig):
        with pytest.raises(InjectError):
            rig.core.inject("task_error", {})  # 不在执行中
        rig.to_executing()
        with pytest.raises(InjectError):
            rig.core.inject("task_error", {"code": Code.ROBOT_FAULT})
        rig.core.task_control(Command.PAUSE, "")
        with pytest.raises(InjectError):
            rig.core.inject("task_error", {})
        assert rig.core.phase == Phase.PAUSED


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

    def test_stopping_unaffected_by_laser(self, rig):
        rig.to_plan_ready()
        rig.core.inject("laser", {"state": "OFFLINE"})
        rig.core.task_control(Command.START, rig.core.plan_id)
        rig.core.task_control(Command.STOP, "")
        rig.core.inject("laser", {"state": "ERROR"})
        assert rig.core.phase == Phase.STOPPING
        rig.run(1.0)
        assert last(rig) == ("TASK", "STOPPED", "")

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
        assert rig.core.phase == Phase.PAUSED

    def test_robot_fault_still_interrupts(self, rig):
        rig.to_plan_ready()
        rig.core.inject("laser", {"state": "OFFLINE"})
        rig.core.task_control(Command.START, rig.core.plan_id)
        rig.send_driver(safety_mode="Fault")
        assert last(rig) == ("TASK", "INTERRUPTED", Code.ROBOT_FAULT)
        rig.send_driver(safety_mode="Normal")
        # 整次不出光的任务继续时不检查激光器，仍不出光
        assert rig.core.task_control(Command.RESUME, "").code == Code.OK
        rig.run(1.0)
        assert rig.state["laser_state"] == Laser.OFFLINE
