"""操作结果与告警（接口文档 8.7）、启动（8.8）和发布规则（5.4）。"""

from conftest import FakeClock, FakeHooks
from spatialview_mock.core.constants import Code, Phase, Robot
from spatialview_mock.core.machine import MockCore, SimConfig


def alarms(rig):
    return {a["code"]: a for a in rig.state["alarms"]}


def test_result_ids_unique(rig):
    rig.to_plan_ready()
    first = rig.state["last_result"]["id"]
    rig.core.start_plan(rig.core.model_id, [])
    rig.run(5.0)
    second = rig.state["last_result"]["id"]
    assert first.startswith("s1-") and second.startswith("s1-") and first != second


def test_alarm_stamp_kept_while_active(rig):
    rig.send_driver(safety_mode="Fault", detail="第 3 轴过载")
    alarm = alarms(rig)[Code.ROBOT_FAULT]
    assert alarm["level"] == "ERROR" and alarm["detail"] == "第 3 轴过载"
    rig.run(2.0)
    rig.send_driver(detail="第 3 轴过载，温度过高")
    again = alarms(rig)[Code.ROBOT_FAULT]
    assert again["stamp"] == alarm["stamp"]
    assert again["detail"] == "第 3 轴过载，温度过高"
    rig.send_driver(safety_mode="ProtectiveStop", detail="")
    codes = set(alarms(rig))
    assert Code.ROBOT_PROTECTIVE_STOP in codes and Code.ROBOT_FAULT not in codes
    rig.send_driver(safety_mode="Normal")
    assert not set(alarms(rig)) & {Code.ROBOT_FAULT, Code.ROBOT_PROTECTIVE_STOP}


def test_estop_and_disabled_have_no_alarm(rig):
    rig.send_driver(software_estop=True)
    assert rig.state["robot_state"] == Robot.ESTOP and not alarms(rig)
    rig.send_driver(software_estop=False, robot_mode="PowerOff")
    assert rig.state["robot_state"] == Robot.DISABLED and not alarms(rig)


def test_device_and_module_alarms(rig):
    rig.core.inject("camera", {"state": "OFFLINE"})
    rig.core.inject("laser", {"state": "ERROR"})
    rig.core.inject("module", {"name": "plan", "available": False})
    found = alarms(rig)
    assert {Code.CAMERA_OFFLINE, Code.LASER_ERROR, Code.MODULE_UNAVAILABLE} <= set(found)
    assert found[Code.MODULE_UNAVAILABLE]["detail"] == "规划模块未运行"
    rig.core.inject("camera", {"state": "OK"})
    rig.core.inject("module", {"name": "plan", "available": True})
    assert not set(alarms(rig)) & {Code.CAMERA_OFFLINE, Code.MODULE_UNAVAILABLE}


def test_startup():
    clock, hooks = FakeClock(), FakeHooks()
    core = MockCore(hooks, SimConfig(), clock=clock, wall_clock=lambda: clock.t, session_id="new")
    assert hooks.cleared == 1
    core.tick()
    state = core.get_state()
    assert (state["session_id"], state["seq"], state["phase"]) == ("new", 1, Phase.NO_MODEL)
    assert state["robot_state"] == Robot.OFFLINE
    assert state["alarms"] == [] and state["last_result"]["id"] == ""
    assert core.start_scan().code == Code.ROBOT_NOT_READY  # 取得设备状态之前不受理运动指令
    clock.t += 4.0
    core.tick()
    assert core.get_state()["alarms"] == []  # 5 秒内不产生离线告警
    clock.t += 1.5
    core.tick()
    assert [a["code"] for a in core.get_state()["alarms"]] == [Code.ROBOT_OFFLINE]


def test_leftover_task_stopped():
    clock, hooks = FakeClock(), FakeHooks()
    core = MockCore(hooks, SimConfig(), clock=clock, wall_clock=lambda: clock.t)
    core.on_driver_state(
        connected=True,
        robot_mode="Running",
        safety_mode="Normal",
        software_estop=False,
        motion_active=True,
    )
    core.tick()
    assert hooks.motion == [False]
    assert [a["code"] for a in core.get_state()["alarms"]] == [Code.LEFTOVER_TASK_STOPPED]
    # 只在启动时检查一次
    core.on_driver_state(
        connected=True,
        robot_mode="Running",
        safety_mode="Normal",
        software_estop=False,
        motion_active=True,
    )
    assert hooks.motion == [False]


def test_failure_alarms_removed_by_next_scan(rig):
    rig.core.inject("fail_next", {"operation": "SCAN"})
    rig.core.start_scan()
    rig.run(10.0)
    assert Code.SCAN_FAILED in alarms(rig)
    rig.core.start_scan()
    assert Code.SCAN_FAILED not in alarms(rig)


def test_periodic_and_immediate_publishing(rig):
    published = len(rig.hooks.published)
    rig.run(0.25)
    assert len(rig.hooks.published) == published  # 没有变化：不到 500 毫秒不发布
    rig.run(0.25)
    assert len(rig.hooks.published) == published + 1  # 定时发布
    rig.core.inject("camera", {"state": "ERROR"})
    rig.core.tick()
    assert len(rig.hooks.published) == published + 2  # 状态变化：立即补发
    seqs = [s["seq"] for s in rig.hooks.published]
    assert seqs == list(range(1, len(seqs) + 1))


def test_progress_alone_does_not_force_publish(rig):
    rig.core.start_scan()
    published = len(rig.hooks.published)
    rig.clock.t += 0.2
    rig.core.on_driver_state(**rig.driver)
    rig.core.tick()
    assert len(rig.hooks.published) == published


def test_get_state_returns_last_published(rig):
    state = rig.core.get_state()
    assert state is rig.hooks.published[-1]
