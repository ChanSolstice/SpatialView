"""按接口文档第 11 节检查规划文件，并与模型、URDF 交叉检查。"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from tools.common.urdf import Robot
from tools.validate.model import ID_PATTERN, ModelInfo
from tools.validate.report import Report

MAX_POINTS = 100_000
TIME_TOLERANCE = 0.001  # 最后一个点的 t 与 duration 的允许误差：1 毫秒
RECOMMENDED_INTERVAL = 0.1  # 相邻两点的建议最大时间间隔（11.2）
NEAR_MODEL_RATIO = 0.95  # 工艺段 TCP 点在模型表面附近的最低比例
SAMPLE_LIMIT = 2000  # 交叉检查最多抽取的点数


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_numbers(value, length: int) -> bool:
    return isinstance(value, list) and len(value) == length and all(_is_number(v) for v in value)


def validate_plan(
    source: str | Path | dict,
    *,
    model: ModelInfo | None = None,
    robot: Robot | None = None,
    tcp_link: str | None = None,
    expected_plan_id: str | None = None,
    expected_model_id: str | None = None,
    expected_selected: list[str] | None = None,
    tcp_tolerance: float = 0.05,
    fk_tolerance: float = 0.005,
) -> Report:
    """expected_selected 为 StartPlan 发送的 surface_ids：给出时检查有效选择与之一致（接口文档 6.4）。"""
    report = Report("规划文件" if isinstance(source, dict) else str(source))
    if isinstance(source, dict):
        plan = source
    else:
        try:
            plan = json.loads(Path(source).read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            report.error("PLAN_JSON", f"无法读取 JSON：{exc}")
            return report
    if not isinstance(plan, dict):
        report.error("PLAN_JSON", "顶层不是 JSON 对象")
        return report

    _check_ids(report, plan, model, expected_plan_id, expected_model_id)
    if plan.get("frame_id") != "base_link":
        report.error("PLAN_FRAME", f'frame_id 为 {plan.get("frame_id")!r}，应为 "base_link"')
    _check_surfaces(report, plan, model)
    _check_scope(report, plan, model, expected_selected)
    duration = plan.get("duration")
    if not _is_number(duration) or not duration > 0:
        report.error("PLAN_DURATION", f"duration 为 {duration!r}，应为大于 0 的秒数")
        duration = None

    joints = _check_joint_trajectory(report, plan.get("joint_trajectory"), duration, robot)
    tcp = _check_tcp_path(report, plan.get("tcp_path"), duration)
    failed = _check_failed_paths(report, plan, model)

    if model is not None and tcp is not None:
        _check_tcp_near_model(report, model, tcp, tcp_tolerance)
    if model is not None and failed is not None:
        _check_failed_near_model(report, model, failed, tcp_tolerance)
    if robot is not None and tcp_link and joints is not None and tcp is not None:
        _check_forward_kinematics(report, robot, tcp_link, joints, tcp, fk_tolerance)

    if joints is not None and tcp is not None:
        report.info(
            "PLAN_SUMMARY",
            f"plan_id {plan.get('plan_id')}，时长 {duration} 秒，关节轨迹 {len(joints[1])} 点，"
            f"TCP 路径 {len(tcp[0])} 点（工艺段 {int(tcp[2].sum())} 点）",
        )
    return report


def _check_ids(report, plan, model, expected_plan_id, expected_model_id) -> None:
    for key in ("plan_id", "model_id"):
        value = plan.get(key)
        if not isinstance(value, str) or not ID_PATTERN.match(value):
            report.error(
                "PLAN_ID_FORMAT", f"{key} 为 {value!r}：应为只含字母、数字、下划线、连字符的字符串"
            )
    if expected_plan_id is not None and plan.get("plan_id") != expected_plan_id:
        report.error(
            "PLAN_ID_MISMATCH", f"plan_id 为 {plan.get('plan_id')}，应为 {expected_plan_id}"
        )
    expected = expected_model_id or (model.model_id if model is not None else None)
    if expected is not None and plan.get("model_id") != expected:
        report.error(
            "PLAN_MODEL_MISMATCH", f"规划的 model_id 为 {plan.get('model_id')}，模型为 {expected}"
        )


def _check_surfaces(report: Report, plan: dict, model: ModelInfo | None) -> None:
    surface_ids = plan.get("surface_ids")
    if not (isinstance(surface_ids, list) and surface_ids):
        report.error("PLAN_SURFACES", "surface_ids 应为非空数组，逐个列出实际规划的表面")
        return
    if not all(isinstance(s, str) and s for s in surface_ids):
        report.error("PLAN_SURFACES", "surface_ids 中有不是字符串的元素")
        return
    if len(set(surface_ids)) != len(surface_ids):
        report.error("PLAN_SURFACES", "surface_ids 有重复")
    if model is None:
        return
    for surface_id in surface_ids:
        if surface_id not in model.surfaces:
            report.error("PLAN_SURFACE_UNKNOWN", f"表面 {surface_id} 不在模型中")
        elif not model.surfaces[surface_id]:
            report.error("PLAN_SURFACE_NOT_SELECTABLE", f"表面 {surface_id} 在模型中标记为不可清洗")


def _id_list(report: Report, plan: dict, key: str) -> list[str] | None:
    value = plan[key]
    if not (isinstance(value, list) and value and all(isinstance(s, str) and s for s in value)):
        report.error("SCOPE_FORMAT", f"{key} 应为非空的字符串数组")
        return None
    if len(set(value)) != len(value):
        report.error("SCOPE_DUPLICATE", f"{key} 有重复")
    return value


def _check_scope(
    report: Report, plan: dict, model: ModelInfo | None, expected_selected: list[str] | None
) -> None:
    """表面集合（11.1 的 selected_surface_ids、planning_scope_surface_ids，11.2）：同时给出；有效选择、
    surface_ids 和失败路径的表面都在规划范围内；都是模型中可清洗的表面。"""
    has_selected = "selected_surface_ids" in plan
    has_scope = "planning_scope_surface_ids" in plan
    if not has_selected and not has_scope:
        report.warning(
            "SCOPE_MISSING",
            "没有 selected_surface_ids 和 planning_scope_surface_ids：按第 13 版实现的服务端必须给出；"
            "APP 按旧服务端的规划文件处理，不显示扩展",
        )
        return
    if not (has_selected and has_scope):
        present = "selected_surface_ids" if has_selected else "planning_scope_surface_ids"
        report.error(
            "SCOPE_FIELDS",
            f"只有 {present}：两个字段应同时给出，只有一个时 APP 视为规划加载失败",
        )
        return
    selected = _id_list(report, plan, "selected_surface_ids")
    scope = _id_list(report, plan, "planning_scope_surface_ids")
    if selected is None or scope is None:
        return
    in_scope = set(scope)

    def outside(code: str, what: str, ids) -> None:
        missing = [s for s in dict.fromkeys(ids) if s not in in_scope]
        if missing:
            report.error(
                code, f"{what} {'、'.join(missing)} 不在规划范围 planning_scope_surface_ids 中"
            )

    outside("SELECTED_NOT_IN_SCOPE", "有效选择中的表面", selected)
    surface_ids = plan.get("surface_ids")
    if isinstance(surface_ids, list):
        outside(
            "SURFACE_NOT_IN_SCOPE",
            "surface_ids 中的表面",
            [s for s in surface_ids if isinstance(s, str)],
        )
    failed = plan.get("failed_paths")
    if isinstance(failed, list):
        outside(
            "FAILED_PATH_NOT_IN_SCOPE",
            "失败路径的表面",
            [
                p["surface_id"]
                for p in failed
                if isinstance(p, dict) and isinstance(p.get("surface_id"), str)
            ],
        )
    if model is not None:
        for surface_id in dict.fromkeys(selected + scope):
            if surface_id not in model.surfaces:
                report.error("SCOPE_SURFACE_UNKNOWN", f"表面集合中的表面 {surface_id} 不在模型中")
            elif not model.surfaces[surface_id]:
                report.error(
                    "SCOPE_SURFACE_NOT_SELECTABLE",
                    f"表面集合中的表面 {surface_id} 在模型中标记为不可清洗",
                )
    if expected_selected is not None:
        if expected_selected:
            expected = list(dict.fromkeys(expected_selected))
        elif model is not None:
            expected = [s for s, selectable in model.surfaces.items() if selectable]
        else:
            expected = None
        if expected is not None and set(selected) != set(expected):
            report.error(
                "SELECTED_MISMATCH",
                f"有效选择为 {'、'.join(selected)}，按 StartPlan 的请求应为 {'、'.join(expected)}"
                "（去掉重复；为空时为全部可清洗表面）",
            )
    traced = set(surface_ids) if isinstance(surface_ids, list) else set()
    chosen = set(selected)
    expanded = [s for s in scope if s not in chosen]
    untraced = [s for s in scope if s not in traced]
    report.info(
        "SCOPE_SUMMARY",
        f"有效选择 {len(chosen)} 个表面，规划范围 {len(in_scope)} 个（扩展 {len(expanded)} 个），"
        f"没有生成路径 {len(untraced)} 个" + (f"（{'、'.join(untraced)}）" if untraced else ""),
    )


def _check_times(report: Report, label: str, t: np.ndarray, duration: float | None) -> bool:
    ok = True
    if abs(t[0]) > 1e-9:
        report.error("TIME_START", f"{label} 第一个点的 t 为 {t[0]}，应为 0")
    steps = np.diff(t)
    bad = np.nonzero(steps <= 0)[0]
    if len(bad):
        ok = False
        first = int(bad[0]) + 1
        report.error(
            "TIME_ORDER",
            f"{label} 的 t 不是严格递增：共 {len(bad)} 处，第一处在第 {first} 个点（t = {t[first]}）",
        )
    if duration is not None and abs(t[-1] - duration) > TIME_TOLERANCE:
        report.error("TIME_END", f"{label} 最后一个点的 t 为 {t[-1]}，应等于 duration {duration}")
    big = np.nonzero(steps > RECOMMENDED_INTERVAL + 1e-9)[0]
    if len(big):
        report.warning(
            "TIME_INTERVAL",
            f"{label} 有 {len(big)} 处相邻点间隔超过 {RECOMMENDED_INTERVAL} 秒，最大 {steps.max():.3f} 秒",
        )
    return ok


def _check_joint_trajectory(report, trajectory, duration, robot):
    if not isinstance(trajectory, dict):
        report.error("PLAN_FIELD", "缺少 joint_trajectory")
        return None
    names = trajectory.get("joint_names")
    if not (isinstance(names, list) and names and all(isinstance(n, str) and n for n in names)):
        report.error("JOINT_NAMES", "joint_names 应为非空的字符串数组")
        return None
    if len(set(names)) != len(names):
        report.error("JOINT_NAMES", "joint_names 有重复")
    points = trajectory.get("points")
    if not (isinstance(points, list) and points):
        report.error("JOINT_POINTS", "joint_trajectory.points 应为非空数组")
        return None
    if len(points) > MAX_POINTS:
        report.error("POINTS_LIMIT", f"joint_trajectory 有 {len(points)} 点，超过 {MAX_POINTS}")

    t = np.empty(len(points))
    positions = np.empty((len(points), len(names)))
    complete = True
    for i, point in enumerate(points):
        if not isinstance(point, dict) or not _is_number(point.get("t")):
            report.error("JOINT_POINT_FORMAT", f"joint_trajectory.points[{i}] 缺少数值 t")
            complete = False
            continue
        if not _is_numbers(point.get("positions"), len(names)):
            report.error(
                "JOINT_POINT_FORMAT",
                f"joint_trajectory.points[{i}].positions 应为 {len(names)} 个数值，与 joint_names 一致",
            )
            complete = False
            continue
        t[i] = point["t"]
        positions[i] = point["positions"]
    if not complete:
        return None
    if not (np.isfinite(t).all() and np.isfinite(positions).all()):
        report.error("JOINT_POINT_FORMAT", "joint_trajectory 含有非有限值")
        return None
    times_ok = _check_times(report, "joint_trajectory", t, duration)

    jumps = np.abs(np.diff(positions, axis=0)) > math.pi
    for column in np.nonzero(jumps.any(axis=0))[0]:
        row = int(np.nonzero(jumps[:, column])[0][0])
        report.error(
            "JOINT_WRAP",
            f"关节 {names[column]} 在第 {row + 1} 个点跳变超过 π，疑似做了 ±π 回绕（11.2 要求连续）",
        )

    if robot is not None:
        movable = robot.movable_joint_names
        unknown = [n for n in names if n not in movable]
        if unknown:
            report.error("JOINT_UNKNOWN", f"URDF 中没有这些关节：{'、'.join(unknown)}")
        missing = [n for n in movable if n not in names]
        if missing:
            report.warning(
                "JOINT_MISSING", f"URDF 中的关节不在文件中，动画中保持为 0：{'、'.join(missing)}"
            )
        for column, name in enumerate(names):
            if name not in movable:
                continue
            joint = robot.joint(name)
            if joint.lower is None or joint.upper is None:
                continue
            values = positions[:, column]
            if values.min() < joint.lower - 1e-9 or values.max() > joint.upper + 1e-9:
                report.error(
                    "JOINT_LIMIT",
                    f"关节 {name} 超出 URDF 的范围 [{joint.lower:.4f}, {joint.upper:.4f}]",
                )
    return (names, t, positions) if times_ok else None


def _check_tcp_path(report, path, duration):
    if not isinstance(path, dict):
        report.error("PLAN_FIELD", "缺少 tcp_path")
        return None
    points = path.get("points")
    if not (isinstance(points, list) and points):
        report.error("TCP_POINTS", "tcp_path.points 应为非空数组")
        return None
    if len(points) > MAX_POINTS:
        report.error("POINTS_LIMIT", f"tcp_path 有 {len(points)} 点，超过 {MAX_POINTS}")

    t = np.empty(len(points))
    p = np.empty((len(points), 3))
    process = np.zeros(len(points), bool)
    quaternions = []
    with_q = 0
    complete = True
    for i, point in enumerate(points):
        where = f"tcp_path.points[{i}]"
        if not isinstance(point, dict) or not _is_number(point.get("t")):
            report.error("TCP_POINT_FORMAT", f"{where} 缺少数值 t")
            complete = False
            continue
        if not _is_numbers(point.get("p"), 3):
            report.error("TCP_POINT_FORMAT", f"{where}.p 应为 3 个数值")
            complete = False
            continue
        if not isinstance(point.get("process_on"), bool):
            report.error("TCP_POINT_FORMAT", f"{where}.process_on 应为布尔值")
            complete = False
            continue
        if "q" in point:
            if not _is_numbers(point["q"], 4):
                report.error("TCP_POINT_FORMAT", f"{where}.q 应为 4 个数值（x、y、z、w）")
                complete = False
                continue
            with_q += 1
            quaternions.append(point["q"])
        t[i] = point["t"]
        p[i] = point["p"]
        process[i] = point["process_on"]
    if not complete:
        return None
    if not (np.isfinite(t).all() and np.isfinite(p).all()):
        report.error("TCP_POINT_FORMAT", "tcp_path 含有非有限值")
        return None
    if 0 < with_q < len(points):
        report.warning("TCP_QUATERNION", f"只有 {with_q} 个点带姿态 q：要么全部提供，要么全部省略")
    if quaternions:
        norms = np.linalg.norm(np.array(quaternions, float), axis=1)
        bad = int((np.abs(norms - 1.0) > 1e-3).sum())
        if bad:
            report.error("TCP_QUATERNION", f"有 {bad} 个 q 不是单位四元数")
    times_ok = _check_times(report, "tcp_path", t, duration)
    if not process.any():
        report.warning("TCP_NO_PROCESS", "tcp_path 中没有工艺段（process_on 全部为 false）")
    return (t, p, process) if times_ok else None


def _check_failed_paths(report: Report, plan: dict, model: ModelInfo | None):
    """失败路径（11.1 的 failed_paths，可选）：每段至少 2 个点，合计不超过 10 万点（11.2）。
    返回全部点 (N, 3)；没有失败路径或格式不对时返回 None。"""
    if "failed_paths" not in plan:
        return None
    paths = plan["failed_paths"]
    if paths is None:
        report.warning("FAILED_PATHS", "failed_paths 为 null：没有失败路径时省略该字段或给空数组")
        return None
    if not isinstance(paths, list):
        report.error("FAILED_PATHS", "failed_paths 应为数组")
        return None
    if not paths:
        return None
    points: list[list[float]] = []
    surfaces: list[str] = []
    complete = True
    for i, path in enumerate(paths):
        where = f"failed_paths[{i}]"
        if not isinstance(path, dict):
            report.error("FAILED_PATH_FORMAT", f"{where} 不是对象")
            complete = False
            continue
        surface_id = path.get("surface_id")
        if not (isinstance(surface_id, str) and surface_id):
            report.error("FAILED_PATH_FORMAT", f"{where}.surface_id 应为非空字符串")
            complete = False
        else:
            surfaces.append(surface_id)
        path_points = path.get("points")
        if not isinstance(path_points, list):
            report.error("FAILED_PATH_FORMAT", f"{where}.points 应为数组")
            complete = False
            continue
        if len(path_points) < 2:
            report.error(
                "FAILED_PATH_POINTS", f"{where} 只有 {len(path_points)} 个点，每段至少 2 个点"
            )
        for j, point in enumerate(path_points):
            p = point.get("p") if isinstance(point, dict) else None
            if not _is_numbers(p, 3) or not all(math.isfinite(v) for v in p):
                report.error("FAILED_PATH_FORMAT", f"{where}.points[{j}].p 应为 3 个有限数值")
                complete = False
                break
            points.append(p)
    if len(points) > MAX_POINTS:
        report.error("POINTS_LIMIT", f"failed_paths 合计 {len(points)} 点，超过 {MAX_POINTS}")
    if model is not None:
        for surface_id in dict.fromkeys(surfaces):
            if surface_id not in model.surfaces:
                report.error(
                    "FAILED_PATH_SURFACE_UNKNOWN", f"失败路径的表面 {surface_id} 不在模型中"
                )
            elif not model.surfaces[surface_id]:
                report.error(
                    "FAILED_PATH_SURFACE_NOT_SELECTABLE",
                    f"失败路径的表面 {surface_id} 在模型中标记为不可清洗",
                )
    if not complete:
        return None
    names = "、".join(dict.fromkeys(surfaces))
    report.info(
        "FAILED_PATHS_SUMMARY",
        f"失败路径 {len(paths)} 段，{len(points)} 点（表面 {names}）；规划结果应为 PLAN SUCCEEDED、"
        "原因码 PLAN_PARTIAL",
    )
    return np.array(points, float)


def _sample(count: int) -> np.ndarray:
    return np.unique(np.linspace(0, count - 1, min(count, SAMPLE_LIMIT)).astype(int))


def points_within(points: np.ndarray, queries: np.ndarray, tolerance: float) -> np.ndarray:
    """每个查询点 tolerance 范围内是否有 points 中的点（按格子分桶，只比较相邻格子）。"""
    result = np.zeros(len(queries), bool)
    if len(points) == 0:
        return result
    cells = np.floor(points / tolerance).astype(np.int64)
    order = np.lexsort((cells[:, 2], cells[:, 1], cells[:, 0]))
    unique, starts, counts = np.unique(cells[order], axis=0, return_index=True, return_counts=True)
    table = {
        tuple(cell): (start, count)
        for cell, start, count in zip(unique.tolist(), starts, counts, strict=True)
    }
    limit = tolerance * tolerance
    offsets = [(dx, dy, dz) for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)]
    for i, query in enumerate(queries):
        cx, cy, cz = np.floor(query / tolerance).astype(np.int64).tolist()
        for dx, dy, dz in offsets:
            entry = table.get((cx + dx, cy + dy, cz + dz))
            if entry is None:
                continue
            start, count = entry
            candidates = points[order[start : start + count]]
            if (np.sum((candidates - query) ** 2, axis=1) <= limit).any():
                result[i] = True
                break
    return result


def _check_tcp_near_model(report, model: ModelInfo, tcp, tolerance: float) -> None:
    _, p, process = tcp
    process_points = p[process]
    if len(process_points) == 0 or len(model.points) == 0:
        return
    sample = process_points[_sample(len(process_points))]
    ratio = float(points_within(model.points, sample, tolerance).mean())
    if ratio < NEAR_MODEL_RATIO:
        report.error(
            "TCP_FAR_FROM_MODEL",
            f"只有 {ratio:.0%} 的工艺段 TCP 点在模型表面 {tolerance} 米以内（要求至少"
            f" {NEAR_MODEL_RATIO:.0%}）：检查模型是否做了 Y-up 转换，单位和坐标系是否与规划一致",
        )
    else:
        report.info("TCP_NEAR_MODEL", f"{ratio:.0%} 的工艺段 TCP 点在模型表面 {tolerance} 米以内")


def _check_failed_near_model(
    report, model: ModelInfo, points: np.ndarray, tolerance: float
) -> None:
    if len(points) == 0 or len(model.points) == 0:
        return
    sample = points[_sample(len(points))]
    ratio = float(points_within(model.points, sample, tolerance).mean())
    if ratio < NEAR_MODEL_RATIO:
        report.error(
            "FAILED_FAR_FROM_MODEL",
            f"只有 {ratio:.0%} 的失败路径点在模型表面 {tolerance} 米以内（要求至少"
            f" {NEAR_MODEL_RATIO:.0%}）：失败路径与 tcp_path 使用同一坐标系 base_link",
        )
    else:
        report.info("FAILED_NEAR_MODEL", f"{ratio:.0%} 的失败路径点在模型表面 {tolerance} 米以内")


def _check_forward_kinematics(report, robot: Robot, tcp_link: str, joints, tcp, tolerance) -> None:
    names, joint_t, positions = joints
    tcp_t, tcp_p, _ = tcp
    try:
        chain = robot.chain(tcp_link)
    except ValueError as exc:
        report.error("FK_LINK", f"无法建立到 {tcp_link} 的关节链：{exc}")
        return
    sample = _sample(len(tcp_t))
    q = np.zeros((len(sample), len(chain.names)))
    for column, name in enumerate(chain.names):
        if name in names:
            q[:, column] = np.interp(tcp_t[sample], joint_t, positions[:, names.index(name)])
    deviation = np.linalg.norm(chain.fk(q)[:, :3, 3] - tcp_p[sample], axis=1)
    p95, worst = float(np.percentile(deviation, 95)), float(deviation.max())
    message = (
        f"按 URDF 正运动学，{tcp_link} 与 TCP 路径点的偏差：95% 分位 {p95 * 1000:.2f} 毫米，"
        f"最大 {worst * 1000:.2f} 毫米"
    )
    if p95 > tolerance:
        report.error(
            "FK_MISMATCH",
            f"{message}，超过 {tolerance * 1000:.1f} 毫米：检查 URDF 的工具和 TCP、关节名和关节轨迹",
        )
    else:
        report.info("FK_MATCH", message)
