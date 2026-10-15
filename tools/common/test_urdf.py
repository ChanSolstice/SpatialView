import math
from pathlib import Path

import numpy as np
import pytest

from tools.common.urdf import parse_urdf, quaternion_xyzw, rotation_vector, solve_ik

DEV_URDF = Path(__file__).resolve().parents[2] / "app/public/robot/aubo_i5H_dev.urdf"
I5H_JOINTS = [
    "shoulder_joint",
    "upperArm_joint",
    "foreArm_joint",
    "wrist1_joint",
    "wrist2_joint",
    "wrist3_joint",
]


@pytest.fixture(scope="module")
def robot():
    return parse_urdf(DEV_URDF)


def test_parse_i5h(robot):
    assert robot.name == "aubo_i5H_dev"
    assert robot.movable_joint_names == I5H_JOINTS
    assert robot.root_link == "world"
    assert robot.chain("tcp_link").names == I5H_JOINTS
    assert robot.joint("shoulder_joint").lower == pytest.approx(-2 * math.pi)


def test_fk_zero_pose(robot):
    # 零位时机械臂竖直向上，wrist2_Link 原点在 (0, -0.1215, 1.0085)
    tip = robot.chain("wrist2_Link").fk(np.zeros((1, 5)))[0]
    assert tip[:3, 3] == pytest.approx([0.0, -0.1215, 1.0085], abs=1e-9)


def test_fk_matches_interface_example(robot):
    # 接口文档 11.1 的示例位姿：法兰在 (0.5, 0.1, 0.4) 且竖直朝下，TCP 在其下方 0.15 米
    q = np.array([[0.438, -0.0451, 1.6205, 0.0948, 1.5708, 0.0]])
    flange = robot.chain("wrist3_Link").fk(q)[0]
    tcp = robot.chain("tcp_link").fk(q)[0]
    assert flange[:3, 3] == pytest.approx([0.5, 0.1, 0.4], abs=2e-4)
    assert flange[:3, 2] == pytest.approx([0.0, 0.0, -1.0], abs=1e-3)
    assert tcp[:3, 3] == pytest.approx([0.5, 0.1, 0.25], abs=2e-4)


def test_ik_round_trip(robot):
    chain = robot.chain("tcp_link")
    rng = np.random.default_rng(1)
    seed = np.array([0.4, 0.0, 1.6, 0.1, 1.57, 0.0])
    q_true = seed + rng.uniform(-0.3, 0.3, size=(50, 6))
    targets = chain.fk(q_true)
    result = solve_ik(chain, targets, seed)
    assert result.converged.all()
    assert np.abs(chain.fk(result.q) - targets).max() < 1e-6


def test_rotation_vector_round_trip():
    rng = np.random.default_rng(2)
    axes = rng.normal(size=(200, 3))
    axes /= np.linalg.norm(axes, axis=1, keepdims=True)
    angles = np.concatenate([rng.uniform(0, math.pi, 196), [0.0, 1e-8, math.pi - 1e-6, math.pi]])
    vectors = axes * angles[:, None]
    matrices = []
    for v in vectors:
        angle = np.linalg.norm(v)
        k = np.zeros((3, 3)) if angle == 0 else _skew(v / angle)
        matrices.append(np.eye(3) + math.sin(angle) * k + (1 - math.cos(angle)) * k @ k)
    recovered = rotation_vector(np.array(matrices))
    for original, back in zip(vectors, recovered, strict=True):
        if np.linalg.norm(original) > math.pi - 1e-3:
            # 角度为 π 时轴的方向有两种等价写法
            assert min(np.linalg.norm(back - original), np.linalg.norm(back + original)) < 1e-4
        else:
            assert back == pytest.approx(original, abs=1e-6)


def test_quaternion_matches_rotation():
    rng = np.random.default_rng(3)
    q = rng.normal(size=(100, 4))
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    x, y, z, w = q.T
    matrices = np.stack(
        [
            np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], axis=1),
            np.stack([2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], axis=1),
            np.stack([2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], axis=1),
        ],
        axis=1,
    )
    result = quaternion_xyzw(matrices)
    expected = np.where(q[:, 3:4] < 0, -q, q)
    assert result == pytest.approx(expected, abs=1e-9)


def _skew(v):
    x, y, z = v
    return np.array([[0.0, -z, y], [z, 0.0, -x], [-y, x, 0.0]])
