import json
import math

import pytest

from tools.validate import validate_model, validate_plan
from tools.validate.__main__ import main


def errors(plan, **kwargs) -> set[str]:
    return validate_plan(plan, **kwargs).codes("error")


@pytest.fixture(scope="module")
def model_info(small_glb):
    return validate_model(small_glb)[1]


def test_valid(small_plan, model_info, robot):
    report = validate_plan(
        small_plan,
        model=model_info,
        robot=robot,
        tcp_link="tcp_link",
        expected_plan_id="plan_20261015T080500",
    )
    assert report.ok, report.format()
    assert {"FK_MATCH", "TCP_NEAR_MODEL", "PLAN_SUMMARY"} <= report.codes("info")


def test_time_axis(small_plan):
    points = small_plan["tcp_path"]["points"]
    points[0]["t"] = 0.05
    assert "TIME_START" in errors(small_plan)
    points[0]["t"] = 0.0
    points[10]["t"] = points[9]["t"]
    assert "TIME_ORDER" in errors(small_plan)
    points[10]["t"] = points[9]["t"] + 0.1
    small_plan["duration"] += 0.01
    assert "TIME_END" in errors(small_plan)


def test_interval_warning(small_plan):
    joints = small_plan["joint_trajectory"]["points"]
    for point in joints[100:]:
        point["t"] = round(point["t"] + 0.5, 4)
    small_plan["duration"] = joints[-1]["t"]
    for point in small_plan["tcp_path"]["points"][100:]:
        point["t"] = round(point["t"] + 0.5, 4)
    report = validate_plan(small_plan)
    assert report.ok
    assert "TIME_INTERVAL" in report.codes("warning")


def test_joint_points(small_plan, robot):
    small_plan["joint_trajectory"]["points"][5]["positions"].pop()
    assert "JOINT_POINT_FORMAT" in errors(small_plan)


def test_joint_names(small_plan, robot):
    small_plan["joint_trajectory"]["joint_names"][0] = "joint_1"
    report = validate_plan(small_plan, robot=robot)
    assert "JOINT_UNKNOWN" in report.codes("error")
    assert "JOINT_MISSING" in report.codes("warning")


def test_joint_wrap(small_plan):
    # 从第 300 个点起，第 6 轴减去 2π：做了 ±π 回绕
    for point in small_plan["joint_trajectory"]["points"][300:]:
        point["positions"][5] -= 2 * math.pi
    assert "JOINT_WRAP" in errors(small_plan)


def test_joint_limit(small_plan, robot):
    small_plan["joint_trajectory"]["points"][0]["positions"][0] = 7.0
    assert "JOINT_LIMIT" in errors(small_plan, robot=robot)


def test_point_limit(small_plan):
    points = small_plan["tcp_path"]["points"]
    extra = [dict(points[-1], t=round(points[-1]["t"] + 0.01 * (i + 1), 4)) for i in range(100_001)]
    points.extend(extra)
    assert "POINTS_LIMIT" in errors(small_plan)


def test_tcp_points(small_plan):
    points = small_plan["tcp_path"]["points"]
    points[3]["q"] = [0.0, 0.0, 0.0, 2.0]
    assert "TCP_QUATERNION" in errors(small_plan)
    points[3]["q"] = points[4]["q"]
    points[3]["process_on"] = 1
    assert "TCP_POINT_FORMAT" in errors(small_plan)


def test_ids_frame_and_surfaces(small_plan, model_info):
    small_plan["frame_id"] = "world"
    small_plan["model_id"] = "model_other"
    small_plan["surface_ids"] += ["nowhere", "bottom"]
    found = errors(small_plan, model=model_info)
    assert {
        "PLAN_FRAME",
        "PLAN_MODEL_MISMATCH",
        "PLAN_SURFACE_UNKNOWN",
        "PLAN_SURFACE_NOT_SELECTABLE",
    } <= found


def test_forward_kinematics_mismatch(small_plan, robot):
    # 工具实际长 0.17 米而 URDF 写 0.15 米：TCP 路径整体比正运动学低 2 厘米
    for point in small_plan["tcp_path"]["points"]:
        point["p"][2] -= 0.02
    assert "FK_MISMATCH" in errors(small_plan, robot=robot, tcp_link="tcp_link")
    assert "FK_LINK" in errors(small_plan, robot=robot, tcp_link="no_such_link")


def test_cli(small_sample, tmp_path, capsys):
    out, manifest = small_sample
    model, plan = str(out / manifest["model"]), str(out / manifest["plan"])
    assert main(["--model", model, "--plan", plan]) == 0
    assert "0 个错误" in capsys.readouterr().out
    broken = tmp_path / "broken.json"
    data = json.loads((out / manifest["plan"]).read_text(encoding="utf-8"))
    data["frame_id"] = "map"
    broken.write_text(json.dumps(data), encoding="utf-8")
    assert main(["--plan", str(broken), "--json"]) == 1
    (result,) = json.loads(capsys.readouterr().out)
    assert result["errors"] == 1
    assert result["issues"][0]["code"] == "PLAN_FRAME"


def test_invalid_json(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text("{", encoding="utf-8")
    assert errors(bad) == {"PLAN_JSON"}
