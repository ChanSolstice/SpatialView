import json
import math

import numpy as np
import pytest

from tools.common.glb import read_glb
from tools.sample_data.generate import generate
from tools.sample_data.path import DEMO_PATH, LARGE_PATH, build_frustum_path, build_path
from tools.sample_data.workpiece import DEMO, LARGE, build_surfaces
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
