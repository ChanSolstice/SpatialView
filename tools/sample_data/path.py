"""合成 TCP 路径：在工件顶面上按区域往复清洗，区域之间抬起走空行程。

TCP 在顶面上（激光焦点），工具 Z 轴沿顶面法向指向工件，工具 X 轴取世界 X 在垂直面内的投影。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from tools.sample_data.workpiece import WorkpieceSpec


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


@dataclass
class TcpPath:
    t: np.ndarray  # (N,)
    xy: np.ndarray  # (N, 2) 在顶面上的投影位置
    lift: np.ndarray  # (N,) 高出顶面的距离
    process: np.ndarray  # (N,) bool
    positions: np.ndarray  # (N, 3)
    rotations: np.ndarray  # (N, 3, 3)，列为工具坐标系的 X、Y、Z 轴


def _segment(start: np.ndarray, end: np.ndarray, spacing: float) -> np.ndarray:
    """从 start 到 end（不含 start、含 end）按不超过 spacing 的间距取点；至少两步，中间至少一个点。"""
    distance = float(np.linalg.norm(end - start))
    steps = max(2, math.ceil(distance / spacing))
    fraction = np.arange(1, steps + 1) / steps
    return start + fraction[:, None] * (end - start)


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
    return TcpPath(t, xy_all, lift_all, process_all, positions, rotations)
