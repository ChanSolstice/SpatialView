"""SystemState 的结构、取值和字段之间的规则（接口文档第 5 节、第 9 节）。"""

from __future__ import annotations

from tools.interface_check.contract import Contract

TASK_PHASES = ("EXECUTING", "PAUSED", "STOPPING")
TIMED_PHASES = ("SCANNING", "RECONSTRUCTING", "PLANNING")


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_time(value) -> bool:
    return (
        isinstance(value, dict)
        and _is_int(value.get("sec"))
        and _is_int(value.get("nanosec"))
        and 0 <= value["nanosec"] < 1_000_000_000
    )


SIMPLE_TYPES = {
    "string": lambda v: isinstance(v, str),
    "bool": lambda v: isinstance(v, bool),
    "uint64": lambda v: _is_int(v) and v >= 0,
    "float32": _is_number,
    "float64": _is_number,
    "string[]": lambda v: isinstance(v, list) and all(isinstance(x, str) for x in v),
    "builtin_interfaces/Time": _is_time,
}


def _check_fields(value, spec, where: str) -> list[str]:
    if not isinstance(value, dict):
        return [f"{where} 不是对象"]
    problems = []
    for field_type, name in spec:
        if name not in value:
            problems.append(f"{where} 缺少字段 {name}")
        elif field_type in SIMPLE_TYPES and not SIMPLE_TYPES[field_type](value[name]):
            problems.append(f"{where}.{name} 的类型应为 {field_type}，实际为 {value[name]!r}")
    return problems


def validate_state(state, contract: Contract, where: str = "SystemState") -> list[str]:
    """返回发现的问题；为空表示符合接口文档。"""
    simple = [(t, n) for t, n in contract.system_state if t in SIMPLE_TYPES]
    problems = _check_fields(state, simple, where)
    if problems:
        return problems
    for name in ("alarms", "last_result"):
        if name not in state:
            problems.append(f"{where} 缺少字段 {name}")
    alarms = state.get("alarms", [])
    if not isinstance(alarms, list):
        problems.append(f"{where}.alarms 不是数组")
        alarms = []
    for i, alarm in enumerate(alarms):
        problems += _check_fields(alarm, contract.alarm, f"{where}.alarms[{i}]")
    result = state.get("last_result", {})
    problems += _check_fields(result, contract.operation_result, f"{where}.last_result")
    if problems:
        return problems

    major = state["interface_version"].split(".")[0]
    if major != contract.interface_version.split(".")[0]:
        problems.append(
            f"interface_version 为 {state['interface_version']}，主版本号与 {contract.interface_version} 不同"
        )
    for name, allowed in (
        ("robot_state", contract.robot_states),
        ("camera_state", contract.camera_states),
        ("laser_state", contract.laser_states),
        ("phase", contract.phases),
    ):
        if state[name] not in allowed:
            problems.append(f"{name} 的取值 {state[name]!r} 不在接口文档中")

    phase = state["phase"]
    progress = state["progress"]
    if phase in TIMED_PHASES:
        if not (progress == -1 or 0 <= progress <= 100):
            problems.append(f"progress 为 {progress}，应为 -1 或 0–100")
    elif progress != -1:
        problems.append(f"阶段为 {phase} 时 progress 应为 -1，实际为 {progress}")
    if state["exec_time"] < 0:
        problems.append("exec_time 不能为负")
    if phase not in TASK_PHASES and state["exec_time"] != 0:
        problems.append(f"阶段为 {phase} 时 exec_time 应为 0")

    model_id, plan_id = state["model_id"], state["plan_id"]
    if model_id and state["model_url"] != f"/models/{model_id}.glb":
        problems.append(f"model_url 应为 /models/{model_id}.glb，实际为 {state['model_url']!r}")
    if not model_id and (state["model_url"] or plan_id):
        problems.append("没有模型时 model_url、plan_id 都应为空")
    if plan_id and state["plan_url"] != f"/plans/{plan_id}.json":
        problems.append(f"plan_url 应为 /plans/{plan_id}.json，实际为 {state['plan_url']!r}")
    if bool(plan_id) != bool(state["plan_surface_ids"]):
        problems.append("plan_surface_ids 应在有规划时非空、没有规划时为空")
    if state["software_estop"] and state["robot_state"] not in ("ESTOP", "OFFLINE"):
        problems.append(
            f"software_estop 为 true 时 robot_state 应为 ESTOP，实际为 {state['robot_state']}"
        )

    codes = [a["code"] for a in alarms]
    if len(codes) != len(set(codes)):
        problems.append("alarms 中同一 code 出现了多次")
    for alarm in alarms:
        if alarm["level"] not in contract.alarm_levels:
            problems.append(f"告警 {alarm['code']} 的 level {alarm['level']!r} 不在接口文档中")
        if not alarm["code"]:
            problems.append("告警的 code 为空")
    if result["id"]:
        if result["operation"] not in contract.operations:
            problems.append(f"last_result.operation {result['operation']!r} 不在接口文档中")
        if result["result"] not in contract.results:
            problems.append(f"last_result.result {result['result']!r} 不在接口文档中")
    return problems
