"""mock 的常量必须与 spatialview_msgs 的 .msg、.srv 一致。"""

import re
from pathlib import Path

import pytest

from spatialview_mock.core import constants as c

MSGS = Path(__file__).resolve().parents[2] / "spatialview_msgs"


def values(file: str, prefix: str) -> list[str]:
    text = (MSGS / file).read_text(encoding="utf-8")
    return [
        v
        for n, v in re.findall(r'^string\s+([A-Z][A-Z0-9_]*)="([^"]*)"', text, re.M)
        if n.startswith(prefix)
    ]


def members(cls) -> list[str]:
    return [v for k, v in vars(cls).items() if k.isupper()]


@pytest.mark.parametrize(
    "file, prefix, cls",
    [
        ("msg/SystemState.msg", "ROBOT_", c.Robot),
        ("msg/SystemState.msg", "CAMERA_", c.Camera),
        ("msg/SystemState.msg", "LASER_", c.Laser),
        ("msg/SystemState.msg", "PHASE_", c.Phase),
        ("msg/Alarm.msg", "LEVEL_", c.Level),
        ("msg/OperationResult.msg", "OPERATION_", c.Operation),
        ("msg/OperationResult.msg", "RESULT_", c.Outcome),
        ("srv/TaskControl.srv", "COMMAND_", c.Command),
        ("srv/StartScan.srv", "WORKPIECE_TYPE_", c.WorkpieceType),
    ],
)
def test_enums(file, prefix, cls):
    assert values(file, prefix) == members(cls)


def test_status_codes_and_version():
    assert sorted(values("msg/StatusCode.msg", "")) == sorted(members(c.Code))
    assert values("msg/SystemState.msg", "INTERFACE_VERSION") == [c.INTERFACE_VERSION]
