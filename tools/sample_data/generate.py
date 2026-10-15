"""生成样例：工件模型 GLB、规划文件和清单（接口文档第 10、11 节）。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from tools.common.glb import GlbBuilder
from tools.common.urdf import Chain, parse_urdf, quaternion_xyzw, solve_ik
from tools.sample_data.path import LARGE_PATH, SMALL_PATH, PathSpec, TcpPath, build_path
from tools.sample_data.workpiece import LARGE, SMALL, Surface, WorkpieceSpec, build_surfaces

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_URDF = REPO_ROOT / "app/public/robot/aubo_i5H_dev.urdf"
DEFAULT_TCP_LINK = "tcp_link"
# 逆解从这个关节角出发，落在工具朝下、肘部朝上的分支（接口文档 11.1 的示例位姿）
REFERENCE_POSE = np.array([0.438, -0.045, 1.621, 0.095, 1.571, 0.0])
COARSE_STRIDE = 50  # 先每隔这么多点顺序求解，保证分支连续
MAX_JOINT_STEP = 0.2  # 相邻两点关节角的最大变化，弧度


class SampleError(RuntimeError):
    """样例无法生成，例如工件超出机械臂的工作范围。"""


@dataclass(frozen=True)
class SampleSize:
    name: str
    workpiece: WorkpieceSpec
    path: PathSpec
    model_id: str
    plan_id: str


SIZES = {
    "small": SampleSize(
        "small", SMALL, SMALL_PATH, "model_20261015T080000", "plan_20261015T080500"
    ),
    "large": SampleSize(
        "large", LARGE, LARGE_PATH, "model_20261015T090000", "plan_20261015T090500"
    ),
}


def build_model(surfaces: list[Surface], model_id: str) -> bytes:
    builder = GlbBuilder(generator="SpatialView tools.sample_data")
    for s in surfaces:
        builder.add_mesh_node(
            s.surface_id,
            s.positions,
            s.normals,
            s.indices,
            {"surface_id": s.surface_id, "selectable": s.selectable},
        )
    return builder.build({"model_id": model_id})


def solve_joint_trajectory(chain: Chain, tcp: TcpPath) -> np.ndarray:
    count = len(tcp.t)
    targets = np.zeros((count, 4, 4))
    targets[:, :3, :3] = tcp.rotations
    targets[:, :3, 3] = tcp.positions
    targets[:, 3, 3] = 1.0

    coarse = np.unique(np.r_[np.arange(0, count, COARSE_STRIDE), count - 1])
    solutions = np.empty((len(coarse), len(chain.names)))
    seed = REFERENCE_POSE
    for k, index in enumerate(coarse):
        result = solve_ik(chain, targets[index : index + 1], seed, max_iterations=300)
        if not result.converged.all():
            raise SampleError(
                f"第 {index} 个点无法求解逆运动学（位置误差 {result.position_error[0]:.4f} 米），"
                "工件可能超出机械臂的工作范围"
            )
        solutions[k] = seed = result.q[0]

    seeds = np.column_stack(
        [np.interp(np.arange(count), coarse, solutions[:, j]) for j in range(len(chain.names))]
    )
    q = np.empty_like(seeds)
    for start in range(0, count, 10_000):
        part = slice(start, min(count, start + 10_000))
        result = solve_ik(chain, targets[part], seeds[part], max_iterations=50)
        if not result.converged.all():
            bad = start + int(np.nonzero(~result.converged)[0][0])
            raise SampleError(f"第 {bad} 个点无法求解逆运动学")
        q[part] = result.q
    step = float(np.abs(np.diff(q, axis=0)).max())
    if step > MAX_JOINT_STEP:
        raise SampleError(f"关节轨迹不连续：相邻两点的关节角最大变化 {step:.3f} 弧度")
    return q


def build_plan(
    size: SampleSize,
    surfaces: list[Surface],
    chain: Chain,
    tcp: TcpPath,
    q: np.ndarray,
    model_id: str,
    plan_id: str,
) -> dict:
    t = np.round(tcp.t, 4)
    quaternions = np.round(quaternion_xyzw(tcp.rotations), 6)
    positions = np.round(tcp.positions, 6)
    joints = np.round(q, 6)
    return {
        "plan_id": plan_id,
        "model_id": model_id,
        "frame_id": "base_link",
        "surface_ids": [s.surface_id for s in surfaces if s.surface_id.startswith("top_")],
        "duration": float(t[-1]),
        "joint_trajectory": {
            "joint_names": chain.names,
            "points": [
                {"t": float(ti), "positions": qi}
                for ti, qi in zip(t.tolist(), joints.tolist(), strict=True)
            ],
        },
        "tcp_path": {
            "points": [
                {"t": float(ti), "p": pi, "q": qi, "process_on": bool(on)}
                for ti, pi, qi, on in zip(
                    t.tolist(), positions.tolist(), quaternions.tolist(), tcp.process, strict=True
                )
            ]
        },
    }


def process_intervals(t: np.ndarray, process: np.ndarray) -> list[list[float]]:
    """连续的工艺段点合并为时间区间 [开始, 结束]，mock 服务端据此在执行中开关激光。"""
    flags = np.concatenate([[False], np.asarray(process, bool), [False]])
    edges = np.diff(flags.astype(np.int8))
    starts = np.nonzero(edges == 1)[0]
    ends = np.nonzero(edges == -1)[0] - 1
    return [[float(t[a]), float(t[b])] for a, b in zip(starts, ends, strict=True)]


def generate(
    size_name: str,
    out: Path,
    *,
    urdf: Path = DEFAULT_URDF,
    tcp_link: str = DEFAULT_TCP_LINK,
    model_id: str | None = None,
    plan_id: str | None = None,
) -> dict:
    """生成一组样例，写入 out/models/<model_id>.glb、out/plans/<plan_id>.json 和 out/manifest.json。"""
    size = SIZES[size_name]
    model_id = model_id or size.model_id
    plan_id = plan_id or size.plan_id
    robot = parse_urdf(urdf)
    chain = robot.chain(tcp_link)

    surfaces = build_surfaces(size.workpiece)
    tcp = build_path(size.workpiece, size.path)
    q = solve_joint_trajectory(chain, tcp)
    plan = build_plan(size, surfaces, chain, tcp, q, model_id, plan_id)

    rounded = np.array([p["positions"] for p in plan["joint_trajectory"]["points"]])
    path_points = np.array([p["p"] for p in plan["tcp_path"]["points"]])
    fk_deviation = float(np.linalg.norm(chain.fk(rounded)[:, :3, 3] - path_points, axis=1).max())

    (out / "models").mkdir(parents=True, exist_ok=True)
    (out / "plans").mkdir(parents=True, exist_ok=True)
    model_file = Path("models") / f"{model_id}.glb"
    plan_file = Path("plans") / f"{plan_id}.json"
    (out / model_file).write_bytes(build_model(surfaces, model_id))
    (out / plan_file).write_text(
        json.dumps(plan, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    manifest = {
        "size": size.name,
        "model_id": model_id,
        "plan_id": plan_id,
        "model": model_file.as_posix(),
        "plan": plan_file.as_posix(),
        "urdf": urdf.resolve().relative_to(REPO_ROOT).as_posix()
        if urdf.resolve().is_relative_to(REPO_ROOT)
        else str(urdf),
        "tcp_link": tcp_link,
        "surfaces": len(surfaces),
        "selectable_surfaces": sum(s.selectable for s in surfaces),
        "triangles": sum(s.triangles for s in surfaces),
        "points": len(tcp.t),
        "process_points": int(tcp.process.sum()),
        "duration": plan["duration"],
        "max_joint_step": float(np.abs(np.diff(q, axis=0)).max()),
        "max_fk_deviation": fk_deviation,
        "process_intervals": process_intervals(np.round(tcp.t, 4), tcp.process),
    }
    (out / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return manifest
