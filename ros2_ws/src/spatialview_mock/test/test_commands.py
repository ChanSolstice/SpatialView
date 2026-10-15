"""指令 Service 的受理条件和顺序（接口文档第 6 节）。"""

import pytest

from spatialview_mock.core.constants import Code, Command, Laser, Phase, Robot


def codes_unchanged(rig, reply):
    """拒绝时不改变状态，回复最近一次发布的状态。"""
    assert reply.state is rig.core.last_published


class TestCommon:
    def test_accept_publishes_then_replies_with_same_state(self, rig):
        before = rig.core.seq
        reply = rig.core.start_scan()
        assert reply.code == Code.OK
        assert reply.state["seq"] == before + 1
        assert rig.hooks.published[-1] is reply.state
        assert reply.state["phase"] == Phase.SCANNING

    def test_reject_keeps_state(self, rig):
        rig.core.start_scan()
        seq = rig.core.seq
        reply = rig.core.start_scan()  # 重复指令
        assert reply.code == Code.INVALID_STATE
        assert rig.core.seq == seq
        codes_unchanged(rig, reply)

    def test_injected_next_code(self, rig):
        rig.core.inject("next_code", {"code": "SOMETHING_NEW", "detail": "测试"})
        reply = rig.core.start_scan()
        assert (reply.code, reply.detail) == ("SOMETHING_NEW", "测试")
        assert rig.core.phase == Phase.NO_MODEL
        assert rig.core.start_scan().code == Code.OK


class TestStartScan:
    def test_order(self, rig):
        rig.send_driver(safety_mode="Fault")
        rig.core.inject("camera", {"state": "ERROR"})
        assert rig.core.start_scan().code == Code.ROBOT_NOT_READY
        rig.send_driver(safety_mode="Normal")
        assert rig.core.start_scan().code == Code.CAMERA_NOT_READY
        rig.core.inject("camera", {"state": "OK"})
        rig.core.inject("module", {"name": "reconstruct", "available": False})
        reply = rig.core.start_scan()
        assert reply.code == Code.MODULE_UNAVAILABLE
        assert reply.detail == "重建模块未运行"

    @pytest.mark.parametrize("phase", [Phase.MODEL_READY, Phase.PLAN_READY])
    def test_rescan_allowed(self, rig, phase):
        rig.to_plan_ready() if phase == Phase.PLAN_READY else rig.to_model_ready()
        assert rig.core.start_scan().code == Code.OK

    def test_accept_side_effects(self, rig):
        rig.core.set_laser(True)
        rig.core.inject("fail_next", {"operation": "PLAN"})
        rig.core.alarms["PLAN_FAILED"] = {"code": "PLAN_FAILED"}
        rig.core.alarms["LEFTOVER_TASK_STOPPED"] = {"code": "LEFTOVER_TASK_STOPPED"}
        reply = rig.core.start_scan()
        assert reply.state["laser_state"] == Laser.OFF
        assert rig.hooks.motion[-1] is True
        codes = {a["code"] for a in reply.state["alarms"]}
        assert not codes & {"PLAN_FAILED", "LEFTOVER_TASK_STOPPED"}


class TestStartPlan:
    def test_order(self, rig):
        assert rig.core.start_plan("", []).code == Code.INVALID_STATE
        rig.to_model_ready()
        assert rig.core.start_plan("model_old", []).code == Code.MODEL_MISMATCH
        model = rig.core.model_id
        assert rig.core.start_plan(model, ["nowhere"]).code == Code.INVALID_SURFACE
        assert rig.core.start_plan(model, ["back_00"]).code == Code.INVALID_SURFACE
        rig.core.inject("module", {"name": "plan", "available": False})
        assert rig.core.start_plan(model, ["top_00"]).code == Code.MODULE_UNAVAILABLE

    def test_empty_means_all_selectable(self, rig):
        rig.to_plan_ready()
        assert rig.core.plan_surface_ids == ["top_00", "top_01", "wall_00"]
        assert rig.hooks.plans[-1][2] == ["top_00", "top_01", "wall_00"]

    def test_selected_surfaces(self, rig):
        rig.to_plan_ready(["top_01", "top_01", "wall_00"])
        assert rig.core.plan_surface_ids == ["top_01", "wall_00"]


class TestTaskControl:
    def test_unknown_command(self, rig):
        assert rig.core.task_control("JUMP", "").code == Code.INVALID_ARGUMENT

    def test_start_order(self, rig):
        assert rig.core.task_control(Command.START, "").code == Code.INVALID_STATE
        rig.to_plan_ready()
        plan = rig.core.plan_id
        assert rig.core.task_control(Command.START, "plan_old").code == Code.PLAN_MISMATCH
        rig.send_driver(robot_mode="PowerOff")
        assert rig.core.task_control(Command.START, plan).code == Code.ROBOT_NOT_READY
        rig.send_driver(robot_mode="Running")
        rig.core.inject("laser", {"state": "ERROR"})
        assert rig.core.task_control(Command.START, plan).code == Code.LASER_NOT_READY
        rig.core.inject("laser", {"state": "OK"})
        rig.core.inject("module", {"name": "execute", "available": False})
        assert rig.core.task_control(Command.START, plan).code == Code.MODULE_UNAVAILABLE

    def test_only_start_checks_plan_id(self, rig):
        rig.to_executing()
        assert rig.core.task_control(Command.PAUSE, "").code == Code.OK
        assert rig.core.task_control(Command.RESUME, "whatever").code == Code.OK
        assert rig.core.task_control(Command.STOP, "").code == Code.OK

    def test_phase_checks(self, rig):
        rig.to_plan_ready()
        for command in (Command.PAUSE, Command.RESUME, Command.STOP):
            assert rig.core.task_control(command, "").code == Code.INVALID_STATE
        rig.core.task_control(Command.START, rig.core.plan_id)
        assert rig.core.task_control(Command.RESUME, "").code == Code.INVALID_STATE
        assert rig.core.task_control(Command.START, rig.core.plan_id).code == Code.INVALID_STATE

    def test_resume_after_fault_is_rejected(self, rig):
        rig.to_executing()
        rig.core.task_control(Command.PAUSE, "")
        rig.send_driver(safety_mode="ProtectiveStop")
        # 故障使任务立即中断，已不在暂停阶段
        assert rig.core.task_control(Command.RESUME, "").code == Code.INVALID_STATE


class TestSetLaser:
    def test_on_order(self, rig):
        rig.core.start_scan()
        assert rig.core.set_laser(True).code == Code.INVALID_STATE
        rig.run(15.0)
        rig.send_driver(safety_mode="SafeguardStop")
        assert rig.core.set_laser(True).code == Code.ROBOT_NOT_READY
        rig.send_driver(safety_mode="Normal")
        rig.core.inject("laser", {"state": "ERROR"})
        assert rig.core.set_laser(True).code == Code.LASER_NOT_READY
        rig.core.inject("laser", {"state": "OK"})
        rig.core.inject("interlock", {"ok": False, "detail": "安全门未关闭"})
        reply = rig.core.set_laser(True)
        assert (reply.code, reply.detail) == (Code.INTERLOCK, "安全门未关闭")
        rig.core.inject("interlock", {"ok": True})
        assert rig.core.set_laser(True).state["laser_state"] == Laser.ON
        assert rig.core.set_laser(True).code == Code.INVALID_STATE  # 已开启：重复指令

    def test_off_always_accepted(self, rig):
        assert rig.core.set_laser(False).code == Code.OK
        rig.send_driver(safety_mode="Fault")
        rig.core.inject("laser", {"state": "ERROR"})
        assert rig.core.set_laser(False).code == Code.OK
        rig.core.inject("laser", {"state": "OFFLINE"})
        assert rig.core.set_laser(False).code == Code.DEVICE_ERROR


class TestResetEstop:
    def test_not_latched(self, rig):
        assert rig.core.reset_estop().code == Code.INVALID_STATE

    def test_interruption_not_finished(self, rig):
        # mock 中急停引起的中断立即完成；真实服务端有最多 2 秒的窗口，这里跳过推进来检查这一条
        rig.send_driver(software_estop=True)
        rig.core._update = lambda: None
        rig.core.phase = Phase.EXECUTING
        assert rig.core.reset_estop().code == Code.INVALID_STATE

    def test_driver_refuses(self, rig):
        rig.send_driver(software_estop=True)
        rig.hooks.clear_estop_result = False
        assert rig.core.reset_estop().code == Code.DEVICE_ERROR

    def test_accept(self, rig):
        rig.to_executing()
        rig.send_driver(software_estop=True)
        assert rig.core.phase == Phase.PLAN_READY
        assert rig.state["robot_state"] == Robot.ESTOP
        moves = len(rig.hooks.motion)
        reply = rig.core.reset_estop()
        assert reply.code == Code.OK
        assert reply.state["software_estop"] is False
        assert reply.state["robot_state"] == Robot.READY
        assert reply.state["phase"] == Phase.PLAN_READY  # 作业阶段不变
        assert len(rig.hooks.motion) == moves  # 复位不让机械臂运动
