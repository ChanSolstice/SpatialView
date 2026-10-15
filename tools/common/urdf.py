"""URDF 解析与运动学：关节名、批量正运动学、雅可比和数值逆运动学。只依赖 numpy。

支持 revolute、continuous、prismatic、fixed 四种关节。坐标、角度单位与 URDF 相同（米、弧度）。
"""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

import numpy as np

MOVABLE_TYPES = ("revolute", "continuous", "prismatic")


@dataclass(frozen=True)
class Joint:
    name: str
    type: str
    parent: str
    child: str
    origin: np.ndarray  # (4, 4)
    axis: np.ndarray  # (3,) 单位向量
    lower: float | None = None
    upper: float | None = None

    @property
    def movable(self) -> bool:
        return self.type in MOVABLE_TYPES


def _floats(text: str | None, default: tuple[float, ...]) -> tuple[float, ...]:
    if text is None:
        return default
    values = tuple(float(v) for v in text.split())
    if len(values) != len(default):
        raise ValueError(f"需要 {len(default)} 个数值：{text!r}")
    return values


def rpy_matrix(roll: float, pitch: float, yaw: float) -> np.ndarray:
    """URDF 的 rpy：先绕 X 转 roll，再绕 Y 转 pitch，最后绕 Z 转 yaw（固定轴）。"""
    cr, sr = math.cos(roll), math.sin(roll)
    cp, sp = math.cos(pitch), math.sin(pitch)
    cy, sy = math.cos(yaw), math.sin(yaw)
    return np.array(
        [
            [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
            [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
            [-sp, cp * sr, cp * cr],
        ]
    )


def transform(rotation: np.ndarray | None = None, translation=(0.0, 0.0, 0.0)) -> np.ndarray:
    matrix = np.eye(4)
    if rotation is not None:
        matrix[:3, :3] = rotation
    matrix[:3, 3] = translation
    return matrix


@dataclass
class Robot:
    name: str
    links: list[str]
    joints: list[Joint]

    @property
    def movable_joint_names(self) -> list[str]:
        return [j.name for j in self.joints if j.movable]

    def joint(self, name: str) -> Joint:
        for j in self.joints:
            if j.name == name:
                return j
        raise KeyError(name)

    @property
    def root_link(self) -> str:
        children = {j.child for j in self.joints}
        roots = [link for link in self.links if link not in children]
        if len(roots) != 1:
            raise ValueError(f"URDF 应该只有一个根连杆，实际为 {roots}")
        return roots[0]

    def chain(self, tip: str, root: str | None = None) -> Chain:
        """从 root（默认根连杆）到 tip 的关节链。"""
        root = root or self.root_link
        by_child = {j.child: j for j in self.joints}
        path: list[Joint] = []
        link = tip
        while link != root:
            if link not in by_child:
                raise ValueError(f"连杆 {tip} 不在 {root} 之下")
            joint = by_child[link]
            path.append(joint)
            link = joint.parent
        return Chain(list(reversed(path)))


def parse_urdf(source: str | Path) -> Robot:
    """解析 URDF 文件路径或 XML 文本。非标准的标签和属性被忽略。"""
    text = str(source)
    if not text.lstrip().startswith("<"):
        text = Path(source).read_text(encoding="utf-8")
    root = ET.fromstring(text)
    if root.tag != "robot":
        raise ValueError("根元素不是 <robot>")
    links = [link.get("name", "") for link in root.findall("link")]
    joints: list[Joint] = []
    for element in root.findall("joint"):
        name = element.get("name", "")
        joint_type = element.get("type", "")
        parent = element.find("parent")
        child = element.find("child")
        if parent is None or child is None:
            raise ValueError(f"关节 {name} 缺少 parent 或 child")
        origin = element.find("origin")
        xyz = _floats(origin.get("xyz") if origin is not None else None, (0.0, 0.0, 0.0))
        rpy = _floats(origin.get("rpy") if origin is not None else None, (0.0, 0.0, 0.0))
        axis_element = element.find("axis")
        axis = np.array(
            _floats(axis_element.get("xyz") if axis_element is not None else None, (1.0, 0.0, 0.0))
        )
        if joint_type in MOVABLE_TYPES:
            axis = axis / np.linalg.norm(axis)
        limit = element.find("limit")
        lower = upper = None
        if limit is not None and joint_type in ("revolute", "prismatic"):
            lower = float(limit.get("lower", "0"))
            upper = float(limit.get("upper", "0"))
        joints.append(
            Joint(
                name=name,
                type=joint_type,
                parent=parent.get("link", ""),
                child=child.get("link", ""),
                origin=transform(rpy_matrix(*rpy), xyz),
                axis=axis,
                lower=lower,
                upper=upper,
            )
        )
    return Robot(root.get("name", ""), links, joints)


def _skew(v: np.ndarray) -> np.ndarray:
    x, y, z = v
    return np.array([[0.0, -z, y], [z, 0.0, -x], [-y, x, 0.0]])


class Chain:
    """一条关节链（根到末端）。关节角数组的列按 `names` 的顺序。"""

    def __init__(self, joints: list[Joint]) -> None:
        self.joints = joints
        self.names = [j.name for j in joints if j.movable]

    def _motion(self, joint: Joint, values: np.ndarray) -> np.ndarray:
        n = len(values)
        motion = np.broadcast_to(np.eye(4), (n, 4, 4)).copy()
        if joint.type == "prismatic":
            motion[:, :3, 3] = values[:, None] * joint.axis
        else:
            k = _skew(joint.axis)
            s = np.sin(values)[:, None, None]
            c = np.cos(values)[:, None, None]
            motion[:, :3, :3] = np.eye(3) + s * k + (1.0 - c) * (k @ k)
        return motion

    def _walk(self, q: np.ndarray, *, with_axes: bool):
        q = np.atleast_2d(np.asarray(q, float))
        if q.shape[1] != len(self.names):
            raise ValueError(f"关节角应有 {len(self.names)} 列，实际为 {q.shape[1]}")
        n = q.shape[0]
        frame = np.broadcast_to(np.eye(4), (n, 4, 4)).copy()
        axes, points = [], []
        column = 0
        for joint in self.joints:
            frame = frame @ joint.origin
            if joint.movable:
                if with_axes:
                    axes.append(frame[:, :3, :3] @ joint.axis)
                    points.append(frame[:, :3, 3].copy())
                frame = frame @ self._motion(joint, q[:, column])
                column += 1
        return frame, axes, points

    def fk(self, q: np.ndarray) -> np.ndarray:
        """正运动学：返回末端连杆的位姿 (N, 4, 4)。"""
        return self._walk(q, with_axes=False)[0]

    def jacobian(self, q: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """几何雅可比 (N, 6, 关节数) 和末端位姿。前三行为线速度，后三行为角速度，都在根坐标系下。"""
        tip, axes, points = self._walk(q, with_axes=True)
        n = tip.shape[0]
        jac = np.zeros((n, 6, len(self.names)))
        tip_position = tip[:, :3, 3]
        movable = [j for j in self.joints if j.movable]
        for column, (joint, axis, point) in enumerate(zip(movable, axes, points, strict=True)):
            if joint.type == "prismatic":
                jac[:, :3, column] = axis
            else:
                jac[:, :3, column] = np.cross(axis, tip_position - point)
                jac[:, 3:, column] = axis
        return jac, tip


def rotation_vector(rotation: np.ndarray) -> np.ndarray:
    """批量旋转矩阵 (N, 3, 3) → 旋转向量 (N, 3)（轴乘以角度）。"""
    r = np.asarray(rotation, float)
    cos_angle = np.clip((np.trace(r, axis1=1, axis2=2) - 1.0) / 2.0, -1.0, 1.0)
    angle = np.arccos(cos_angle)
    skew_part = np.stack(
        [r[:, 2, 1] - r[:, 1, 2], r[:, 0, 2] - r[:, 2, 0], r[:, 1, 0] - r[:, 0, 1]], axis=1
    )
    sin_angle = np.sin(angle)
    result = np.empty_like(skew_part)
    small = angle < 1e-6
    near_pi = angle > math.pi - 1e-4
    regular = ~(small | near_pi)
    result[small] = 0.5 * skew_part[small]
    result[regular] = (angle[regular] / (2.0 * sin_angle[regular]))[:, None] * skew_part[regular]
    for i in np.nonzero(near_pi)[0]:
        # 角度接近 π：由 (R + I) / 2 的对角线求轴
        diag = np.clip((np.diag(r[i]) + 1.0) / 2.0, 0.0, None)
        axis = np.sqrt(diag)
        k = int(np.argmax(axis))
        for j in range(3):
            if j != k:
                axis[j] = np.copysign(axis[j], r[i][k, j] + r[i][j, k])
        if skew_part[i] @ axis < 0:
            axis = -axis
        result[i] = angle[i] * axis / np.linalg.norm(axis)
    return result


def pose_error(target: np.ndarray, current: np.ndarray) -> np.ndarray:
    """位姿误差 (N, 6)：位置差和旋转向量，都在根坐标系下。"""
    position = target[:, :3, 3] - current[:, :3, 3]
    rotation = rotation_vector(target[:, :3, :3] @ np.transpose(current[:, :3, :3], (0, 2, 1)))
    return np.concatenate([position, rotation], axis=1)


@dataclass
class IkResult:
    q: np.ndarray
    position_error: np.ndarray
    rotation_error: np.ndarray

    @property
    def converged(self) -> np.ndarray:
        return (self.position_error < 1e-5) & (self.rotation_error < 1e-4)


def solve_ik(
    chain: Chain,
    targets: np.ndarray,
    seed: np.ndarray,
    *,
    max_iterations: int = 200,
    position_tolerance: float = 1e-7,
    rotation_tolerance: float = 1e-7,
    damping: float = 1e-4,
    max_step: float = 0.3,
) -> IkResult:
    """阻尼最小二乘逆解，批量求解。seed 为 (关节数,) 或 (N, 关节数)，解会落在 seed 附近的分支上。"""
    targets = np.asarray(targets, float).reshape(-1, 4, 4)
    n = len(targets)
    q = np.array(np.broadcast_to(np.asarray(seed, float), (n, len(chain.names))))
    identity = np.eye(6)
    for _ in range(max_iterations):
        jac, tip = chain.jacobian(q)
        error = pose_error(targets, tip)
        active = (np.linalg.norm(error[:, :3], axis=1) > position_tolerance) | (
            np.linalg.norm(error[:, 3:], axis=1) > rotation_tolerance
        )
        if not active.any():
            break
        ja = jac[active]
        jt = np.transpose(ja, (0, 2, 1))
        system = ja @ jt + (damping**2) * identity
        step = (jt @ np.linalg.solve(system, error[active][..., None]))[..., 0]
        largest = np.abs(step).max(axis=1)
        step *= np.minimum(1.0, max_step / np.maximum(largest, 1e-12))[:, None]
        q[active] += step
    error = pose_error(targets, chain.fk(q))
    return IkResult(q, np.linalg.norm(error[:, :3], axis=1), np.linalg.norm(error[:, 3:], axis=1))


def quaternion_xyzw(rotation: np.ndarray) -> np.ndarray:
    """批量旋转矩阵 (N, 3, 3) → 四元数 (N, 4)，顺序 x、y、z、w，w ≥ 0。"""
    r = np.asarray(rotation, float)
    m00, m01, m02 = r[:, 0, 0], r[:, 0, 1], r[:, 0, 2]
    m10, m11, m12 = r[:, 1, 0], r[:, 1, 1], r[:, 1, 2]
    m20, m21, m22 = r[:, 2, 0], r[:, 2, 1], r[:, 2, 2]
    trace = m00 + m11 + m22
    # 按最大的分量选择公式，避免除以接近 0 的数
    s0 = np.sqrt(np.maximum(1.0 + trace, 1e-12)) * 2.0
    s1 = np.sqrt(np.maximum(1.0 + m00 - m11 - m22, 1e-12)) * 2.0
    s2 = np.sqrt(np.maximum(1.0 + m11 - m00 - m22, 1e-12)) * 2.0
    s3 = np.sqrt(np.maximum(1.0 + m22 - m00 - m11, 1e-12)) * 2.0
    q0 = np.stack([(m21 - m12) / s0, (m02 - m20) / s0, (m10 - m01) / s0, s0 / 4], axis=1)
    q1 = np.stack([s1 / 4, (m01 + m10) / s1, (m02 + m20) / s1, (m21 - m12) / s1], axis=1)
    q2 = np.stack([(m01 + m10) / s2, s2 / 4, (m12 + m21) / s2, (m02 - m20) / s2], axis=1)
    q3 = np.stack([(m02 + m20) / s3, (m12 + m21) / s3, s3 / 4, (m10 - m01) / s3], axis=1)
    c0 = trace > 0
    c1 = ~c0 & (m00 > m11) & (m00 > m22)
    c2 = ~c0 & ~c1 & (m11 > m22)
    q = np.where(c0[:, None], q0, np.where(c1[:, None], q1, np.where(c2[:, None], q2, q3)))
    q[q[:, 3] < 0] *= -1.0
    return q / np.linalg.norm(q, axis=1, keepdims=True)
