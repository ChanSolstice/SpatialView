"""合成工件，都放在桌面上（z = 0）。

- 曲面块体（small、large）：顶面按网格分成多个表面，四个侧面和底面另成表面。
- 圆台（demo，演示视频用）：顶面一个表面，侧面沿圆周分成若干表面，底面贴着桌面、不可清洗。
"""

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


@dataclass(frozen=True)
class FrustumSpec:
    """圆台，轴线竖直。侧面表面 k 以方位角 k × 360° / sectors 为中心，方位角从 base_link 的 X 轴起算。"""

    center: tuple[float, float]  # 底面圆心在 base_link 下的 x、y，米
    bottom_radius: float
    top_radius: float
    height: float
    sectors: int  # 侧面沿圆周分成的表面数
    sector_segments: int  # 每个侧面表面沿圆周的网格数
    side_layers: int  # 侧面沿母线的网格数
    disk_rings: int  # 顶面、底面沿半径的网格数

    def radius(self, z):
        return (
            self.bottom_radius
            + (self.top_radius - self.bottom_radius) * np.asarray(z) / self.height
        )

    def side_point(self, theta, z) -> np.ndarray:
        """侧面上方位角 theta、高度 z 处的点，形状 (..., 3)。"""
        theta, z = np.broadcast_arrays(np.asarray(theta, float), np.asarray(z, float))
        r = self.radius(z)
        cx, cy = self.center
        return np.stack([cx + r * np.cos(theta), cy + r * np.sin(theta), z], axis=-1)

    def side_normal(self, theta) -> np.ndarray:
        """侧面在方位角 theta 处朝外的单位法向量（沿母线不变），形状 (..., 3)。"""
        theta = np.asarray(theta, float)
        slope = np.full_like(theta, self.bottom_radius - self.top_radius)
        n = np.stack([self.height * np.cos(theta), self.height * np.sin(theta), slope], axis=-1)
        return n / np.linalg.norm(n, axis=-1, keepdims=True)

    def sector_range(self, k: int) -> tuple[float, float]:
        """侧面表面 k 的方位角范围，弧度。"""
        width = 2 * math.pi / self.sectors
        return ((k - 0.5) * width, (k + 0.5) * width)


# 底面直径约 15 厘米（服务端团队的建议），放在机械臂正前方。更近时清洗朝向机械臂的侧面下部，
# 肘部要折到接近极限
DEMO = FrustumSpec(
    center=(0.55, 0.0),
    bottom_radius=0.075,
    top_radius=0.05,
    height=0.10,
    sectors=8,
    sector_segments=24,
    side_layers=4,
    disk_rings=6,
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


def _disk(
    spec: FrustumSpec, z: float, radius: float, outward: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """顶面或底面的顶点、法向和三角面：圆心一个顶点，外面 disk_rings 圈，每圈的顶点数与侧面沿圆周的网格数相同。"""
    count = spec.sectors * spec.sector_segments
    angles = np.arange(count) * 2 * math.pi / count
    radii = np.arange(1, spec.disk_rings + 1) * radius / spec.disk_rings
    cx, cy = spec.center
    rings = np.stack(
        [
            cx + radii[:, None] * np.cos(angles),
            cy + radii[:, None] * np.sin(angles),
            np.full((len(radii), count), z),
        ],
        axis=-1,
    ).reshape(-1, 3)
    positions = np.vstack([[cx, cy, z], rings])
    a = np.arange(count)
    b = (a + 1) % count
    fan = np.stack([np.zeros(count, int), 1 + a, 1 + b], axis=1)
    # 相邻两圈之间：inner 为里圈第一个顶点的编号
    inner = 1 + np.arange(spec.disk_rings - 1)[:, None] * count
    outer = inner + count
    bands = np.stack([inner + a, outer + a, outer + b, inner + a, outer + b, inner + b], axis=-1)
    triangles = np.vstack([fan, bands.reshape(-1, 3)])
    normals = np.tile(outward, (len(positions), 1))
    return positions, normals, _orient(triangles, positions, outward)


def build_frustum_surfaces(spec: FrustumSpec) -> list[Surface]:
    positions, normals, triangles = _disk(spec, spec.height, spec.top_radius, np.array([0.0, 0, 1]))
    surfaces = [_surface("top", True, positions, normals, triangles)]
    for k in range(spec.sectors):
        start, end = spec.sector_range(k)
        theta, z = np.meshgrid(
            np.linspace(start, end, spec.sector_segments + 1),
            np.linspace(0.0, spec.height, spec.side_layers + 1),
            indexing="ij",
        )
        positions = spec.side_point(theta, z).reshape(-1, 3)
        normals = spec.side_normal(theta).reshape(-1, 3)
        # 一个表面只跨 360° / sectors，三角面都与表面中线处的法向同侧
        outward = spec.side_normal((start + end) / 2)
        triangles = _orient(
            _grid_triangles(spec.sector_segments, spec.side_layers), positions, outward
        )
        surfaces.append(_surface(f"side_{k:02d}", True, positions, normals, triangles))
    positions, normals, triangles = _disk(spec, 0.0, spec.bottom_radius, np.array([0.0, 0, -1]))
    # 底面贴着桌面，不能清洗
    surfaces.append(_surface("bottom", False, positions, normals, triangles))
    return surfaces
