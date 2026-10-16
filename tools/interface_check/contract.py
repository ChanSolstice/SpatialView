"""从 spatialview_msgs 的 .msg 文件读取接口约定（枚举取值、字段和类型），与接口定义包只有一个来源。"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

MSGS = Path(__file__).resolve().parents[2] / "ros2_ws/src/spatialview_msgs"
_CONSTANT = re.compile(r'^\s*string\s+([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"', re.M)


def _strip(line: str) -> str:
    return line.split("#", 1)[0].strip()


def constants(text: str, prefix: str) -> list[str]:
    return [value for name, value in _CONSTANT.findall(text) if name.startswith(prefix)]


def fields(text: str) -> list[tuple[str, str]]:
    """(类型, 字段名)，不含常量。"""
    result = []
    for line in text.splitlines():
        line = _strip(line)
        if line and "=" not in line and line != "---":
            field_type, name = line.split()[:2]
            result.append((field_type, name))
    return result


@dataclass(frozen=True)
class Contract:
    interface_version: str
    robot_states: tuple[str, ...]
    camera_states: tuple[str, ...]
    laser_states: tuple[str, ...]
    phases: tuple[str, ...]
    alarm_levels: tuple[str, ...]
    operations: tuple[str, ...]
    results: tuple[str, ...]
    status_codes: tuple[str, ...]
    system_state: tuple[tuple[str, str], ...]
    alarm: tuple[tuple[str, str], ...]
    operation_result: tuple[tuple[str, str], ...]


def load(msgs: Path = MSGS) -> Contract:
    state = (msgs / "msg/SystemState.msg").read_text(encoding="utf-8")
    alarm = (msgs / "msg/Alarm.msg").read_text(encoding="utf-8")
    result = (msgs / "msg/OperationResult.msg").read_text(encoding="utf-8")
    codes = (msgs / "msg/StatusCode.msg").read_text(encoding="utf-8")
    return Contract(
        interface_version=constants(state, "INTERFACE_VERSION")[0],
        robot_states=tuple(constants(state, "ROBOT_")),
        camera_states=tuple(constants(state, "CAMERA_")),
        laser_states=tuple(constants(state, "LASER_")),
        phases=tuple(constants(state, "PHASE_")),
        alarm_levels=tuple(constants(alarm, "LEVEL_")),
        operations=tuple(constants(result, "OPERATION_")),
        results=tuple(constants(result, "RESULT_")),
        status_codes=tuple(constants(codes, "")),
        system_state=tuple(fields(state)),
        alarm=tuple(fields(alarm)),
        operation_result=tuple(fields(result)),
    )
