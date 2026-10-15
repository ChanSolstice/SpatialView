import json

import numpy as np

from tools.common.glb import read_glb
from tools.sample_data.path import LARGE_PATH, build_path
from tools.sample_data.workpiece import LARGE, build_surfaces
from tools.validate import validate_model, validate_plan


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
