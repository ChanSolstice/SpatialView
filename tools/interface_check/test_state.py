"""接口检查的状态校验：接口约定从 .msg 读取，SystemState 的结构、取值和规则。"""

import copy

import pytest

from tools.interface_check.contract import load
from tools.interface_check.state import validate_state

CONTRACT = load()

VALID = {
    "interface_version": "1.1",
    "session_id": "9c1e6f0a",
    "seq": 1024,
    "stamp": {"sec": 1791790512, "nanosec": 0},
    "robot_state": "READY",
    "software_estop": False,
    "camera_state": "OK",
    "laser_state": "OFF",
    "phase": "PLAN_READY",
    "progress": -1.0,
    "exec_time": 0.0,
    "model_id": "model_20261012T153012",
    "model_url": "/models/model_20261012T153012.glb",
    "plan_id": "plan_20261012T153512",
    "plan_url": "/plans/plan_20261012T153512.json",
    "plan_surface_ids": ["surface_02", "surface_04"],
    "alarms": [
        {
            "code": "CAMERA_OFFLINE",
            "level": "ERROR",
            "detail": "",
            "stamp": {"sec": 1, "nanosec": 0},
        }
    ],
    "last_result": {
        "id": "9c1e6f0a-3",
        "operation": "PLAN",
        "result": "SUCCEEDED",
        "code": "",
        "detail": "",
        "stamp": {"sec": 1791790500, "nanosec": 0},
    },
}


def test_contract_from_msgs():
    assert CONTRACT.interface_version == "1.1"
    assert "DISABLED" in CONTRACT.robot_states
    assert len(CONTRACT.status_codes) == 33
    assert ("bool", "software_estop") in CONTRACT.system_state


def test_valid_state():
    assert validate_state(VALID, CONTRACT) == []


def changed(**changes):
    state = copy.deepcopy(VALID)
    state.update(changes)
    return state


@pytest.mark.parametrize(
    "state, fragment",
    [
        ({k: v for k, v in VALID.items() if k != "software_estop"}, "缺少字段 software_estop"),
        (changed(seq="1"), "seq 的类型"),
        (changed(stamp={"sec": 1}), "stamp 的类型"),
        (changed(interface_version="2.0"), "主版本号"),
        (changed(phase="CALIBRATING"), "phase 的取值"),
        (changed(progress=50.0), "progress 应为 -1"),
        (changed(phase="SCANNING", progress=120.0), "0–100"),
        (changed(exec_time=3.0), "exec_time 应为 0"),
        (changed(model_url="/models/other.glb"), "model_url 应为"),
        (changed(plan_surface_ids=[]), "plan_surface_ids"),
        (changed(software_estop=True), "software_estop 为 true"),
        (changed(alarms=VALID["alarms"] * 2), "同一 code"),
        (changed(alarms=[dict(VALID["alarms"][0], level="FATAL")]), "level"),
        (
            changed(last_result=dict(VALID["last_result"], operation="DANCE")),
            "last_result.operation",
        ),
        (changed(model_id="", model_url=""), "没有模型时"),
    ],
)
def test_invalid_states(state, fragment):
    problems = validate_state(state, CONTRACT)
    assert any(fragment in p for p in problems), problems
