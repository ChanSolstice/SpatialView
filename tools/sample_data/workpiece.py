"""合成工件：放在桌面上的曲面块体。顶面按网格分成多个表面，四个侧面和底面另成表面。"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class WorkpieceSpec:
    x_range: tuple[float, float]  # base_link 下的范围，米
    y_range: tuple[float, float]
    base_height: float  # 顶面边缘的高度
    amplitude: float  # 顶面中央比边缘高出的量
    top_patches: tuple[int, int]  # 顶面在 x、y 方向分成的表面数
    patch_quads: tuple[int, int]  # 每个顶面表面在 x、y 方向的网格数
    wall_layers: int  # 侧面在竖直方向的网格数
    wall_patches: tuple[int, int]  # 沿 x 方向的两个侧面、沿 y 方向的两个侧面各分成的表面数

    @property
    def center(self) -> tuple[float, float]:
        return (sum(self.x_range) / 2, sum(self.y_range) / 2)

    @property
    def size(self) -> tuple[float, float]:
        return (self.x_range[1] - self.x_range[0], self.y_range[1] - self.y_range[0])

    def height(self, x, y):
        (cx, cy), (lx, ly) = self.center, self.size
        return self.base_height + self.amplitude * np.cos(math.pi * (x - cx) / lx) * np.cos(
            math.pi * (y - cy) / ly
        )

    def normal(self, x, y) -> np.ndarray:
        """顶面在 (x, y) 处朝外的单位法向量，形状 (..., 3)。"""
        (cx, cy), (lx, ly) = self.center, self.size
        ax, ay = math.pi * (np.asarray(x) - cx) / lx, math.pi * (np.asarray(y) - cy) / ly
        dhdx = -self.amplitude * math.pi / lx * np.sin(ax) * np.cos(ay)
        dhdy = -self.amplitude * math.pi / ly * np.cos(ax) * np.sin(ay)
        n = np.stack([-dhdx, -dhdy, np.ones_like(dhdx)], axis=-1)
        return n / np.linalg.norm(n, axis=-1, keepdims=True)


LARGE = WorkpieceSpec(
    x_range=(0.30, 0.64),
    y_range=(-0.20, 0.20),
    base_height=0.10,
    amplitude=0.04,
    top_patches=(20, 22),
    patch_quads=(17, 18),
    wall_layers=8,
    wall_patches=(10, 11),
)

SMALL = WorkpieceSpec(
    x_range=(0.30, 0.64),
    y_range=(-0.20, 0.20),
    base_height=0.10,
    amplitude=0.04,
    top_patches=(4, 5),
    patch_quads=(4, 4),
    wall_layers=2,
    wall_patches=(2, 2),
)


@dataclass
class Surface:
    surface_id: str
    selectable: bool
    positions: np.ndarray  # (n, 3) float32
    normals: np.ndarray  # (n, 3) float32
    indices: np.ndarray  # (m,) uint32，每 3 个一个三角面

    @property
    def triangles(self) -> int:
        return len(self.indices) // 3


def _grid_triangles(rows: int, cols: int) -> np.ndarray:
    """(rows+1) × (cols+1) 个顶点的网格，按行优先编号，每个格子两个三角面。"""
    a = np.arange(rows)[:, None] * (cols + 1) + np.arange(cols)[None, :]
    b, c, d = a + (cols + 1), a + (cols + 2), a + 1
    return np.stack([a, b, c, a, c, d], axis=-1).reshape(-1, 3)


def _orient(triangles: np.ndarray, positions: np.ndarray, outward: np.ndarray) -> np.ndarray:
    """让三角面按逆时针方向朝外：面法向与 outward 相反的三角面翻转顶点顺序。"""
    p = positions[triangles]
    face = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
    flip = np.einsum("ij,ij->i", face, np.broadcast_to(outward, face.shape)) < 0
    triangles = triangles.copy()
    triangles[flip] = triangles[flip][:, [0, 2, 1]]
    return triangles


def _surface(surface_id, selectable, positions, normals, triangles) -> Surface:
    return Surface(
        surface_id,
        selectable,
        np.asarray(positions, np.float32),
        np.asarray(normals, np.float32),
        triangles.reshape(-1).astype(np.uint32),
    )


def build_surfaces(spec: WorkpieceSpec) -> list[Surface]:
    surfaces = []
    (x0, x1), (y0, y1) = spec.x_range, spec.y_range
    (px, py), (qx, qy) = spec.top_patches, spec.patch_quads
    nx, ny = px * qx, py * qy  # 顶面在 x、y 方向的总网格数
    xs, ys = np.linspace(x0, x1, nx + 1), np.linspace(y0, y1, ny + 1)

    for i in range(px):
        for j in range(py):
            gx = xs[i * qx : (i + 1) * qx + 1]
            gy = ys[j * qy : (j + 1) * qy + 1]
            x, y = np.meshgrid(gx, gy, indexing="ij")
            positions = np.stack([x, y, spec.height(x, y)], axis=-1).reshape(-1, 3)
            normals = spec.normal(x, y).reshape(-1, 3)
            triangles = _orient(_grid_triangles(qx, qy), positions, np.array([0.0, 0.0, 1.0]))
            surfaces.append(_surface(f"top_{i:02d}_{j:02d}", True, positions, normals, triangles))

    def wall(name, selectable, edge_points, outward, patches):
        # edge_points：沿边缘的 (k, 2) 个 x、y 点；竖直方向从桌面到顶面边缘
        quads = len(edge_points) - 1
        per_patch = quads // patches
        layers = spec.wall_layers
        for k in range(patches):
            edge = edge_points[k * per_patch : (k + 1) * per_patch + 1]
            top = spec.height(edge[:, 0], edge[:, 1])
            fraction = np.linspace(0.0, 1.0, layers + 1)
            positions = np.stack(
                [
                    np.repeat(edge[:, 0], layers + 1),
                    np.repeat(edge[:, 1], layers + 1),
                    (top[:, None] * fraction[None, :]).reshape(-1),
                ],
                axis=-1,
            )
            normals = np.broadcast_to(outward, positions.shape)
            triangles = _orient(_grid_triangles(per_patch, layers), positions, outward)
            surfaces.append(_surface(f"{name}_{k:02d}", selectable, positions, normals, triangles))

    wx, wy = spec.wall_patches
    wall("wall_ymin", True, np.stack([xs, np.full_like(xs, y0)], 1), np.array([0.0, -1, 0]), wx)
    # 靠近夹具的一侧标记为不可清洗，用来覆盖 selectable 为 false 的情况
    wall("wall_ymax", False, np.stack([xs, np.full_like(xs, y1)], 1), np.array([0.0, 1, 0]), wx)
    wall("wall_xmin", True, np.stack([np.full_like(ys, x0), ys], 1), np.array([-1.0, 0, 0]), wy)
    wall("wall_xmax", True, np.stack([np.full_like(ys, x1), ys], 1), np.array([1.0, 0, 0]), wy)

    corners = np.array([[x0, y0, 0.0], [x1, y0, 0.0], [x1, y1, 0.0], [x0, y1, 0.0]])
    down = np.array([0.0, 0.0, -1.0])
    triangles = _orient(np.array([[0, 1, 2], [0, 2, 3]]), corners, down)
    surfaces.append(_surface("bottom", False, corners, np.tile(down, (4, 1)), triangles))
    return surfaces
