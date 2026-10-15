"""作业阶段的迁移（接口文档 8.4），每一行一个测试。"""

from spatialview_mock.core.constants import Code, Command, Laser, Phase


def result(rig):
    r = rig.state["last_result"]
    return r["operation"], r["result"], r["code"]


def alarm_codes(rig):
    return {a["code"] for a in rig.state["alarms"]}


def test_scan_success_goes_to_reconstructing(rig):
    rig.core.start_scan()
    rig.run(5.0)
    assert 45 <= rig.state["progress"] <= 55
    rig.run(5.0)
    assert rig.core.phase == Phase.RECONSTRUCTING
    assert rig.hooks.motion[-1] is False
    assert rig.state["progress"] < 10


def test_scan_failure_returns_to_origin(rig):
    rig.to_model_ready()
    model = rig.core.model_id
    rig.core.inject("fail_next", {"operation": "SCAN", "detail": "工件表面反光"})
    rig.core.start_scan()
    rig.run(10.0)
    assert rig.core.phase == Phase.MODEL_READY
    assert rig.core.model_id == model  # 旧模型继续有效
    assert result(rig) == ("SCAN", "FAILED", Code.NO_VALID_DATA)
    assert "SCAN_FAILED" in alarm_codes(rig)


def test_scan_interrupted_by_device(rig):
    rig.core.start_scan()
    rig.run(2.0)
    rig.send_driver(safety_mode="RobotEmergencyStop")
    assert rig.core.phase == Phase.NO_MODEL
    assert result(rig) == ("SCAN", "INTERRUPTED", Code.ROBOT_ESTOP)
    assert rig.hooks.motion[-1] is False


def test_reconstruct_success(rig):
    rig.to_plan_ready()
    old_plan = rig.core.plan_id
    rig.core.start_scan()
    rig.run(12.0)
    assert rig.core.plan_id == old_plan  # 重建中保持旧规划
    rig.run(3.0)
    state = rig.state
    assert state["phase"] == Phase.MODEL_READY
    assert state["model_url"] == f"/models/{state['model_id']}.glb"
    assert (state["plan_id"], state["plan_url"], state["plan_surface_ids"]) == ("", "", [])
    assert result(rig) == ("RECONSTRUCT", "SUCCEEDED", "")


def test_reconstruct_failure(rig):
    rig.core.inject("fail_next", {"operation": "RECONSTRUCT"})
    rig.core.start_scan()
    rig.run(15.0)
    assert rig.core.phase == Phase.NO_MODEL
    assert result(rig) == ("RECONSTRUCT", "FAILED", Code.RECONSTRUCT_ERROR)
    assert "RECONSTRUCT_FAILED" in alarm_codes(rig)


def test_reconstruct_export_failure(rig):
    rig.hooks.fail_export = True
    rig.core.start_scan()
    rig.run(15.0)
    assert result(rig) == ("RECONSTRUCT", "FAILED", Code.EXPORT_ERROR)


def test_plan_success_and_partial(rig):
    rig.to_plan_ready()
    assert result(rig) == ("PLAN", "SUCCEEDED", "")
    rig.core.inject("plan_partial", {"keep": 1})
    rig.core.start_plan(rig.core.model_id, ["top_00", "top_01"])
    rig.run(5.0)
    assert rig.core.plan_surface_ids == ["top_00"]
    operation, outcome, code = result(rig)
    assert (operation, outcome, code) == ("PLAN", "SUCCEEDED", Code.PLAN_PARTIAL)
    assert rig.state["last_result"]["detail"] == "1 个表面不可达"


def test_plan_failure_keeps_old_plan(rig):
    rig.to_plan_ready()
    old = rig.core.plan_id
    rig.core.inject("fail_next", {"operation": "PLAN"})
    rig.core.start_plan(rig.core.model_id, [])
    rig.run(5.0)
    assert rig.core.phase == Phase.PLAN_READY
    assert rig.core.plan_id == old
    assert result(rig) == ("PLAN", "FAILED", Code.NO_SOLUTION)
    assert "PLAN_FAILED" in alarm_codes(rig)
    rig.core.start_plan(rig.core.model_id, [])
    assert "PLAN_FAILED" not in alarm_codes(rig)  # 下一次规划受理时移除


def test_plan_with_no_solution_at_all(rig):
    rig.to_model_ready()
    rig.core.inject("plan_partial", {"keep": 0})
    rig.core.start_plan(rig.core.model_id, [])
    rig.run(5.0)
    assert rig.core.phase == Phase.MODEL_READY
    assert result(rig) == ("PLAN", "FAILED", Code.NO_SOLUTION)


def test_pause_resume_stop(rig):
    rig.to_executing()
    rig.run(5.0)
    rig.core.task_control(Command.PAUSE, "")
    assert rig.core.phase == Phase.PAUSED
    paused_at = rig.state["exec_time"]
    rig.run(3.0)
    assert rig.state["exec_time"] == paused_at  # 暂停期间不增长
    rig.core.task_control(Command.RESUME, "")
    assert rig.core.phase == Phase.EXECUTING
    rig.run(2.0)
    assert rig.state["exec_time"] > paused_at
    rig.core.task_control(Command.STOP, "")
    assert rig.core.phase == Phase.STOPPING
    assert rig.state["laser_state"] == Laser.OFF
    rig.run(1.0)
    assert rig.core.phase == Phase.PLAN_READY
    assert result(rig) == ("TASK", "STOPPED", "")


def test_task_completes(rig):
    rig.to_executing()
    rig.run(101.0, step=0.5)
    assert rig.core.phase == Phase.PLAN_READY
    assert rig.state["laser_state"] == Laser.OFF
    assert result(rig) == ("TASK", "SUCCEEDED", "")
    assert rig.hooks.motion[-1] is False
    # 同一规划可以再次执行，从头开始
    rig.core.task_control(Command.START, rig.core.plan_id)
    assert rig.state["exec_time"] == 0.0


def test_task_interrupted_by_device(rig):
    rig.to_executing()
    rig.run(3.0)
    rig.core.task_control(Command.STOP, "")
    rig.send_driver(robot_mode="PowerOff")
    assert rig.core.phase == Phase.PLAN_READY
    assert result(rig) == ("TASK", "INTERRUPTED", Code.ROBOT_DISABLED)
