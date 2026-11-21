"""合成 TCP 路径。TCP 在工件表面上（激光焦点），工具 Z 轴指向工件。

- 曲面块体：在顶面上按区域往复清洗，区域之间抬起走空行程。工具 Z 轴沿顶面法向，X 轴取世界 X 在垂直面内的投影。
- 圆台（演示用）：顶面从中心向外螺旋，越过边缘后在朝向机械臂的几块侧面上沿圆周往复、逐圈向下，
  只在越过边缘时走一段空行程。顶面上工具竖直向下；侧面上工具比表面法向多朝下倾斜一些，否则清洗
  下部时机械臂的腕部会低到桌面。工具 Y 轴沿圆周切向，越过边缘时工具绕它转向侧面。服务端实际规划的
  是最短路径，不一定是这样的形式，演示中不必一致。
- 失败路径（接口文档 11.1 的 failed_paths）：在背向机械臂的侧面上往复的几条线，模拟规划服务生成了 TCP 路径、
  但机械臂够不到的情况。只有位置，点距与工艺段相同。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from tools.sample_data.workpiece import FrustumSpec, WorkpieceSpec


@dataclass(frozen=True)
class PathSpec:
    regions: tuple[int, int]  # 顶面在 x、y 方向分成的作业区数
    margin: float  # 路径离顶面边缘的距离，米
    target_points: int  # 期望的点数（不超过这个数）
    process_speed: float  # 工艺段速度，米/秒
    travel_speed: float  # 空行程速度，米/秒
    lift: float  # 作业区之间空行程的抬起高度，米
    dt: float  # 相邻两点的时间间隔，秒


LARGE_PATH = PathSpec(
    regions=(2, 2),
    margin=0.01,
    target_points=99_500,
    process_speed=0.02,
    travel_speed=0.10,
    lift=0.05,
    dt=0.05,
)

SMALL_PATH = PathSpec(
    regions=(1, 1),
    margin=0.02,
    target_points=800,
    process_speed=0.05,
    travel_speed=0.20,
    lift=0.05,
    dt=0.1,
)


@dataclass(frozen=True)
class FrustumPathSpec:
    sides: tuple[int, ...]  # 清洗的侧面表面编号，沿圆周连续
    pitch: float  # 顶面螺旋相邻两圈的间距，米
    spacing: float  # 侧面相邻两圈沿母线的间距，米
    side_z: tuple[float, float]  # 侧面清洗的高度范围，米；靠近桌面的一段不清洗，工具不会碰到桌面
    margin: float  # 路径离表面边缘的距离，米
    process_speed: float  # 工艺段速度，米/秒
    travel_speed: float  # 空行程速度，米/秒
    lift: float  # 越过边缘时沿工具轴线离开表面的距离，米
    tilt: float  # 侧面上工具比表面法向多朝下倾斜的角度，弧度
    max_turn: float  # 空行程中相邻两点工具姿态的最大变化，弧度
    dt: float  # 相邻两点的时间间隔，秒

    @property
    def surface_ids(self) -> list[str]:
        return ["top", *(f"side_{k:02d}" for k in self.sides)]


# 顶面和朝向机械臂的三块侧面（机械臂在圆台的 -X 方向，正对侧面 4）
DEMO_PATH = FrustumPathSpec(
    sides=(3, 4, 5),
    pitch=0.008,
    spacing=0.01,
    side_z=(0.04, 0.09),
    margin=0.005,
    process_speed=0.02,
    travel_speed=0.10,
    lift=0.03,
    tilt=math.radians(25),
    max_turn=0.03,
    dt=0.05,
)


# 失败路径往复的几条线在侧面上的高度：块体为侧面高度的比例，圆台为侧面清洗高度范围内均分
FAILED_LINES = 3


@dataclass
class FailedPath:
    """无法执行的路径（接口文档 11.1 的 failed_paths）：所属表面和 TCP 位置。"""

    surface_id: str
    positions: np.ndarray  # (N, 3)


@dataclass
class TcpPath:
    t: np.ndarray  # (N,)
    process: np.ndarray  # (N,) bool
    positions: np.ndarray  # (N, 3)
    rotations: np.ndarray  # (N, 3, 3)，列为工具坐标系的 X、Y、Z 轴


def _segment(start: np.ndarray, end: np.ndarray, spacing: float) -> np.ndarray:
    """从 start 到 end（不含 start、含 end）按不超过 spacing 的间距取点；至少两步，中间至少一个点。"""
    distance = float(np.linalg.norm(end - start))
    steps = max(2, math.ceil(distance / spacing))
    fraction = np.arange(1, steps + 1) / steps
    return start + fraction[:, None] * (end - start)


def _zigzag(lines: list[np.ndarray], spacing: float) -> np.ndarray:
    """依次连接几条线（各为 (k, 3)），线与线之间按不超过 spacing 的间距用直线连起来，没有重复的点。"""
    points = [lines[0]]
    for line in lines[1:]:
        points.append(_segment(points[-1][-1], line[0], spacing)[:-1])
        points.append(line)
    return np.concatenate(points)


def build_failed_paths(spec: WorkpieceSpec, path: PathSpec, patches: int = 2) -> list[FailedPath]:
    """曲面块体背向机械臂（机械臂在 base_link 原点，工件在 +X 方向）的侧面 wall_xmax：前 patches 块表面上
    水平往复。"""
    x1 = spec.x_range[1]
    y0, y1 = spec.y_range
    count_y = spec.top_patches[1] * spec.patch_quads[1]
    ys = np.linspace(y0, y1, count_y + 1)
    wall_patches = spec.wall_patches[1]
    per_patch = count_y // wall_patches
    step = path.process_speed * path.dt
    result = []
    for k in range(min(patches, wall_patches)):
        ya = ys[k * per_patch] + path.margin
        yb = ys[(k + 1) * per_patch] - path.margin
        y = np.linspace(ya, yb, max(2, math.ceil((yb - ya) / step) + 1))
        top = spec.height(np.full_like(y, x1), y)
        lines = []
        for i in range(FAILED_LINES):
            line = np.column_stack([np.full_like(y, x1), y, top * (i + 1) / (FAILED_LINES + 1)])
            lines.append(line[::-1] if i % 2 else line)
        # 从上往下：第一条线在最高处
        result.append(FailedPath(f"wall_xmax_{k:02d}", _zigzag(lines[::-1], step)))
    return result


def build_path(spec: WorkpieceSpec, path: PathSpec) -> TcpPath:
    (x0, x1), (y0, y1) = spec.x_range, spec.y_range
    rx, ry = path.regions
    width = (x1 - x0 - 2 * path.margin) / rx
    depth = (y1 - y0 - 2 * path.margin) / ry
    process_step = path.process_speed * path.dt
    travel_step = path.travel_speed * path.dt
    per_line = math.ceil(depth / process_step) + 1
    regions = rx * ry
    # 每个作业区的清洗线条数：让总点数接近而不超过 target_points（扣除转弯和区域间空行程的估计）
    overhead = regions * 80
    lines = max(2, (path.target_points - overhead) // (regions * (per_line + 2)))
    spacing = width / (lines - 1)

    # 作业区按蛇形顺序访问
    order = []
    for i in range(rx):
        columns = range(ry) if i % 2 == 0 else reversed(range(ry))
        order += [(i, j) for j in columns]

    xy: list[np.ndarray] = []
    lift: list[np.ndarray] = []
    process: list[np.ndarray] = []

    def add(points: np.ndarray, height: np.ndarray | float, on: bool) -> None:
        xy.append(points)
        lift.append(np.broadcast_to(np.asarray(height, float), (len(points),)).copy())
        process.append(np.full(len(points), on))

    for index, (i, j) in enumerate(order):
        xa = x0 + path.margin + i * width
        ya, yb = y0 + path.margin + j * depth, y0 + path.margin + (j + 1) * depth
        ys = np.linspace(ya, yb, per_line)
        start = np.array([xa, ya])
        if index > 0:
            # 区域之间：抬起、平移、落下，全部为空行程
            previous = xy[-1][-1]
            up = _segment(np.zeros(1), np.array([path.lift]), travel_step)[:, 0]
            add(np.repeat(previous[None, :], len(up), axis=0), up, False)
            add(_segment(previous, start, travel_step), path.lift, False)
            down = _segment(np.array([path.lift]), np.zeros(1), travel_step)[:, 0]
            add(np.repeat(start[None, :], len(down) - 1, axis=0), down[:-1], False)
        for k in range(lines):
            x = xa + k * spacing
            line_y = ys if k % 2 == 0 else ys[::-1]
            line = np.stack([np.full(per_line, x), line_y], axis=1)
            if k > 0:
                # 转弯：清洗线之间的短空行程，中间至少一个关闭激光的点
                turn = _segment(xy[-1][-1], line[0], travel_step)
                add(turn[:-1], 0.0, False)
            add(line, 0.0, True)

    xy_all = np.concatenate(xy)
    lift_all = np.concatenate(lift)
    process_all = np.concatenate(process)
    # 只有第一条清洗线包含它的起点，其余每段都不含起点，所以没有重复的点
    count = len(xy_all)
    t = np.arange(count) * path.dt

    surface_z = spec.height(xy_all[:, 0], xy_all[:, 1])
    normals = spec.normal(xy_all[:, 0], xy_all[:, 1])
    positions = np.column_stack([xy_all, surface_z + lift_all])
    z_axis = -normals
    x_axis = np.array([1.0, 0.0, 0.0]) - z_axis[:, 0:1] * z_axis
    x_axis /= np.linalg.norm(x_axis, axis=1, keepdims=True)
    y_axis = np.cross(z_axis, x_axis)
    rotations = np.stack([x_axis, y_axis, z_axis], axis=2)
    return TcpPath(t, process_all, positions, rotations)


def _radial_frame(theta, elevation) -> np.ndarray:
    """工具坐标系 (..., 3, 3)：Z 轴在方位角 theta 处的竖直平面内、朝向轴线，仰角为 elevation；
    X 轴在同一平面内、比 Z 轴高 90°；Y 轴沿圆周切向。仰角 -90° 时 Z 轴竖直向下、X 轴朝向轴线。"""
    theta, elevation = np.broadcast_arrays(np.asarray(theta, float), np.asarray(elevation, float))
    inward = np.stack([-np.cos(theta), -np.sin(theta), np.zeros_like(theta)], axis=-1)
    up = np.array([0.0, 0.0, 1.0])
    ce, se = np.cos(elevation)[..., None], np.sin(elevation)[..., None]
    z_axis = ce * inward + se * up
    x_axis = -se * inward + ce * up
    return np.stack([x_axis, np.cross(z_axis, x_axis), z_axis], axis=-1)


def _spiral(radius: float, pitch: float, spacing: float) -> tuple[np.ndarray, np.ndarray]:
    """从中心向外的阿基米德螺旋 r = pitch × φ / 2π，到半径 radius 为止，按不超过 spacing 的弧长取点。
    返回各点的 φ 和 r，含起点（中心）。"""
    phi = np.linspace(0.0, 2 * math.pi * radius / pitch, 20_000)
    r = pitch * phi / (2 * math.pi)
    length = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(r), r[1:] * np.diff(phi)))])
    steps = math.ceil(length[-1] / spacing)
    phi = np.interp(np.linspace(0.0, length[-1], steps + 1), length, phi)
    return phi, pitch * phi / (2 * math.pi)


def build_frustum_path(spec: FrustumSpec, path: FrustumPathSpec) -> TcpPath:
    process_step = path.process_speed * path.dt
    travel_step = path.travel_speed * path.dt
    cx, cy = spec.center
    # 侧面上沿圆周往复的方位角范围；两端离表面边缘 margin（按顶面半径换算成角度）
    angle_margin = path.margin / spec.top_radius
    theta_a = spec.sector_range(path.sides[0])[0] + angle_margin
    theta_b = spec.sector_range(path.sides[-1])[1] - angle_margin
    # 侧面的内法向朝下 atan2(...)，工具再多朝下 tilt
    side_elevation = -math.atan2(spec.bottom_radius - spec.top_radius, spec.height) - path.tilt

    positions: list[np.ndarray] = []
    rotations: list[np.ndarray] = []
    process: list[np.ndarray] = []

    def add(points: np.ndarray, frames: np.ndarray, on: bool) -> None:
        positions.append(points)
        rotations.append(np.broadcast_to(frames, (len(points), 3, 3)))
        process.append(np.full(len(points), on))

    # 顶面：从中心向外螺旋，终点在侧面起点的正上方（方位角 theta_a）
    phi, r = _spiral(spec.top_radius - path.margin, path.pitch, process_step)
    angle = phi - phi[-1] + theta_a
    spiral = np.column_stack(
        [cx + r * np.cos(angle), cy + r * np.sin(angle), np.full_like(r, spec.height)]
    )
    add(spiral, _radial_frame(theta_a, -math.pi / 2), True)

    # 越过边缘：抬起，移到侧面起点外侧，同时工具绕切向转向侧面，再沿工具轴线落到侧面上（落点属于下一段）
    edge = spiral[-1]
    side_start = spec.side_point(theta_a, path.side_z[1])
    above = edge + np.array([0.0, 0.0, path.lift])
    outside = side_start - path.lift * _radial_frame(theta_a, side_elevation)[:, 2]
    up = _segment(edge, above, travel_step)
    add(up, _radial_frame(theta_a, -math.pi / 2), False)
    turn = side_elevation + math.pi / 2
    steps = max(
        2, math.ceil(np.linalg.norm(outside - above) / travel_step), math.ceil(turn / path.max_turn)
    )
    fraction = np.arange(1, steps + 1) / steps
    add(
        above + fraction[:, None] * (outside - above),
        _radial_frame(theta_a, -math.pi / 2 + fraction * turn),
        False,
    )
    down = _segment(outside, side_start, travel_step)[:-1]
    add(down, _radial_frame(theta_a, side_elevation), False)

    # 侧面：沿圆周往复，逐圈向下；相邻两圈之间沿母线下移，关闭激光
    slant = math.hypot(spec.height, spec.bottom_radius - spec.top_radius)
    rounds = math.ceil((path.side_z[1] - path.side_z[0]) / (path.spacing * spec.height / slant)) + 1
    heights = np.linspace(path.side_z[1], path.side_z[0], rounds)
    for k, z in enumerate(heights):
        start, end = (theta_a, theta_b) if k % 2 == 0 else (theta_b, theta_a)
        if k > 0:
            between = _segment(np.array([heights[k - 1]]), np.array([z]), travel_step)[:-1, 0]
            add(spec.side_point(start, between), _radial_frame(start, side_elevation), False)
        steps = math.ceil(float(spec.radius(z)) * abs(end - start) / process_step)
        theta = np.linspace(start, end, steps + 1)
        add(spec.side_point(theta, z), _radial_frame(theta, side_elevation), True)

    positions_all = np.concatenate(positions)
    t = np.arange(len(positions_all)) * path.dt
    return TcpPath(t, np.concatenate(process), positions_all, np.concatenate(rotations))


def build_frustum_failed_paths(
    spec: FrustumSpec, path: FrustumPathSpec, sides: tuple[int, ...] = (0, 1)
) -> list[FailedPath]:
    """圆台背向机械臂的侧面（机械臂在 -X 方向，侧面 0 正对 +X）：沿圆周往复，逐圈向下；圈与圈之间沿母线。"""
    step = path.process_speed * path.dt
    angle_margin = path.margin / spec.top_radius
    heights = np.linspace(path.side_z[1], path.side_z[0], FAILED_LINES)
    result = []
    for k in sides:
        start, end = spec.sector_range(k)
        start, end = start + angle_margin, end - angle_margin
        lines = []
        for i, z in enumerate(heights):
            count = max(2, math.ceil(float(spec.radius(z)) * (end - start) / step) + 1)
            theta = np.linspace(end, start, count) if i % 2 else np.linspace(start, end, count)
            lines.append(spec.side_point(theta, z))
        result.append(FailedPath(f"side_{k:02d}", _zigzag(lines, step)))
    return result
