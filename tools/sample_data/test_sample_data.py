import json
import math

import numpy as np
import pytest

from tools.common.glb import read_glb
from tools.sample_data.generate import generate
from tools.sample_data.path import (
    DEMO_PATH,
    LARGE_PATH,
    SMALL_PATH,
    build_failed_paths,
    build_frustum_failed_paths,
    build_frustum_path,
    build_path,
)
from tools.sample_data.workpiece import DEMO, LARGE, SMALL, build_surfaces
from tools.validate import validate_model, validate_plan


@pytest.fixture(scope="module")
def demo_sample(tmp_path_factory):
    out = tmp_path_factory.mktemp("demo_sample")
    return out, generate("demo", out)


def joints(plan: dict) -> np.ndarray:
    return np.array([p["positions"] for p in plan["joint_trajectory"]["points"]])


def test_small_sample_is_valid(small_sample, robot):
    out, manifest = small_sample
    model_report, info = validate_model(out / manifest["model"])
    assert model_report.ok, model_report.format()
    plan_report = validate_plan(
        out / manifest["plan"], model=info, robot=robot, tcp_link="tcp_link"
    )
    assert plan_report.ok, plan_report.format()
    assert plan_report.count("warning") == 0, plan_report.format()
    assert "FK_MATCH" in plan_report.codes("info")


def test_small_sample_contents(small_sample, robot):
    out, manifest = small_sample
    glb = read_glb(out / manifest["model"])
    assert glb.gltf["scenes"][0]["extras"]["model_id"] == manifest["model_id"]
    plan = json.loads((out / manifest["plan"]).read_text(encoding="utf-8"))
    assert plan["model_id"] == manifest["model_id"]
    assert plan["joint_trajectory"]["joint_names"] == robot.movable_joint_names
    t = np.array([p["t"] for p in plan["tcp_path"]["points"]])
    assert np.allclose(np.diff(t), 0.1)
    # 工艺段和空行程都有，且空行程夹在工艺段之间
    process = [p["process_on"] for p in plan["tcp_path"]["points"]]
    assert process[0] and process[-1] and not all(process)


def test_tool_tip_follows_tcp_path(small_sample, robot):
    out, manifest = small_sample
    plan = json.loads((out / manifest["plan"]).read_text(encoding="utf-8"))
    q = np.array([p["positions"] for p in plan["joint_trajectory"]["points"]])
    p = np.array([pt["p"] for pt in plan["tcp_path"]["points"]])
    tip = robot.chain("tcp_link").fk(q)[:, :3, 3]
    assert np.abs(tip - p).max() < 1e-5
    assert np.abs(np.diff(q, axis=0)).max() < 0.2


def test_large_spec_respects_interface_limits():
    surfaces = build_surfaces(LARGE)
    assert len(surfaces) <= 500
    assert sum(s.triangles for s in surfaces) <= 300_000
    assert any(not s.selectable for s in surfaces)
    path = build_path(LARGE, LARGE_PATH)
    assert 95_000 <= len(path.t) <= 100_000


def test_process_intervals(small_sample):
    out, manifest = small_sample
    plan = json.loads((out / manifest["plan"]).read_text(encoding="utf-8"))
    points = plan["tcp_path"]["points"]
    intervals = manifest["process_intervals"]
    assert intervals[0][0] == 0.0 and intervals[-1][1] == plan["duration"]
    for point in points:
        inside = any(start <= point["t"] <= end for start, end in intervals)
        assert inside == point["process_on"]


def test_demo_sample_is_valid(demo_sample, robot):
    out, manifest = demo_sample
    model_report, info = validate_model(out / manifest["model"])
    assert model_report.ok, model_report.format()
    plan_report = validate_plan(
        out / manifest["plan"], model=info, robot=robot, tcp_link="tcp_link"
    )
    assert plan_report.ok, plan_report.format()
    assert plan_report.count("warning") == 0, plan_report.format()


def test_demo_sample_contents(demo_sample, robot):
    out, manifest = demo_sample
    glb = read_glb(out / manifest["model"])
    selectable = {n["name"]: n["extras"]["selectable"] for n in glb.gltf["nodes"]}
    assert list(selectable) == ["top", *(f"side_{k:02d}" for k in range(8)), "bottom"]
    assert [name for name, on in selectable.items() if not on] == ["bottom"]
    plan = json.loads((out / manifest["plan"]).read_text(encoding="utf-8"))
    assert plan["surface_ids"] == ["top", "side_03", "side_04", "side_05"]
    # 工具末端沿 TCP 路径，关节角连续
    p = np.array([pt["p"] for pt in plan["tcp_path"]["points"]])
    tip = robot.chain("tcp_link").fk(joints(plan))[:, :3, 3]
    assert np.abs(tip - p).max() < 1e-5
    assert np.abs(np.diff(joints(plan), axis=0)).max() < 0.2


def test_demo_process_points_are_on_planned_surfaces():
    """工艺段的点在顶面上，或在侧面 3–5 上、不低于清洗范围的下限。"""
    tcp = build_frustum_path(DEMO, DEMO_PATH)
    cx, cy = DEMO.center
    p = tcp.positions[tcp.process]
    radial = np.hypot(p[:, 0] - cx, p[:, 1] - cy)
    top = np.isclose(p[:, 2], DEMO.height)
    assert radial[top].max() <= DEMO.top_radius - DEMO_PATH.margin + 1e-9
    side = ~top
    assert np.allclose(radial[side], DEMO.radius(p[side, 2]))
    assert p[side, 2].min() >= DEMO_PATH.side_z[0] - 1e-9
    theta = np.arctan2(p[side, 1] - cy, p[side, 0] - cx) % (2 * math.pi)
    assert theta.min() >= DEMO.sector_range(3)[0] and theta.max() <= DEMO.sector_range(5)[1]
    # 顶面一段螺旋，侧面各圈之间只有短暂的关闭
    starts = np.flatnonzero(np.diff(tcp.process.astype(int)) == 1)
    assert tcp.process[0] and tcp.process[-1] and len(starts) >= 3


def test_demo_wrist_stays_above_table(demo_sample, robot):
    """侧面上工具朝下倾斜：清洗下部时机械臂的腕部也离桌面足够远，轨迹动画中不会穿过地面。"""
    out, manifest = demo_sample
    plan = json.loads((out / manifest["plan"]).read_text(encoding="utf-8"))
    for link in ("wrist1_Link", "wrist2_Link", "wrist3_Link"):
        chain = robot.chain(link)
        heights = chain.fk(joints(plan)[:, : len(chain.names)])[:, 2, 3]
        assert heights.min() > 0.08, link


class TestFailedPaths:
    """失败路径（接口文档 11.1 的 failed_paths）：在背向机械臂的侧面上，不与 TCP 路径重复。"""

    def test_block_on_far_wall(self):
        failed = build_failed_paths(SMALL, SMALL_PATH)
        assert [f.surface_id for f in failed] == ["wall_xmax_00", "wall_xmax_01"]
        step = SMALL_PATH.process_speed * SMALL_PATH.dt
        for f in failed:
            p = f.positions
            assert np.allclose(p[:, 0], SMALL.x_range[1])  # 在侧面上
            assert (p[:, 2] > 0).all() and (p[:, 2] < SMALL.base_height).all()
            gaps = np.linalg.norm(np.diff(p, axis=0), axis=1)
            assert gaps.min() > 0 and gaps.max() <= step + 1e-9  # 点距与工艺段相同，没有重复的点
        assert failed[0].positions[:, 1].max() <= 0.0 <= failed[1].positions[:, 1].min()

    def test_frustum_on_far_sides(self):
        failed = build_frustum_failed_paths(DEMO, DEMO_PATH)
        assert [f.surface_id for f in failed] == ["side_00", "side_01"]
        cx, cy = DEMO.center
        for k, f in enumerate(failed):
            p = f.positions
            radial = np.hypot(p[:, 0] - cx, p[:, 1] - cy)
            assert np.allclose(radial, DEMO.radius(p[:, 2]))  # 在侧面上
            theta = np.arctan2(p[:, 1] - cy, p[:, 0] - cx)
            start, end = DEMO.sector_range(k)
            assert theta.min() > start and theta.max() < end
            assert np.linalg.norm(np.diff(p, axis=0), axis=1).min() > 0

    def test_written_separately_by_default(self, small_sample):
        out, manifest = small_sample
        plan = json.loads((out / manifest["plan"]).read_text(encoding="utf-8"))
        assert "failed_paths" not in plan and manifest["plan_has_failed_paths"] is False
        failed = json.loads((out / manifest["failed_paths"]).read_text(encoding="utf-8"))
        assert [f["surface_id"] for f in failed] == ["wall_xmax_00", "wall_xmax_01"]
        assert sum(len(f["points"]) for f in failed) == manifest["failed_points"]
        assert set(failed[0]["points"][0]) == {"p"}

    def test_plan_with_failed_paths_is_valid(self, tmp_path, robot):
        manifest = generate("small", tmp_path, with_failed_paths=True)
        plan = json.loads((tmp_path / manifest["plan"]).read_text(encoding="utf-8"))
        assert [f["surface_id"] for f in plan["failed_paths"]] == ["wall_xmax_00", "wall_xmax_01"]
        assert list(plan)[-1] == "failed_paths"  # 排在最后，mock 服务端据此替换
        model_report, info = validate_model(tmp_path / manifest["model"])
        report = validate_plan(plan, model=info, robot=robot, tcp_link="tcp_link")
        assert report.ok, report.format()
        assert report.count("warning") == 0, report.format()
        assert "FAILED_NEAR_MODEL" in report.codes("info")
        # 失败路径的表面没有列入 surface_ids（整个表面都无法执行）
        assert not {f["surface_id"] for f in plan["failed_paths"]} & set(plan["surface_ids"])

    def test_demo_failed_paths_near_model(self, demo_sample):
        out, manifest = demo_sample
        failed = json.loads((out / manifest["failed_paths"]).read_text(encoding="utf-8"))
        plan = json.loads((out / manifest["plan"]).read_text(encoding="utf-8"))
        _, info = validate_model(out / manifest["model"])
        report = validate_plan(dict(plan, failed_paths=failed), model=info)
        assert report.ok, report.format()
        assert "FAILED_NEAR_MODEL" in report.codes("info")
