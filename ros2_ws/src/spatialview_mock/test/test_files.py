"""文件目录（接口文档第 9 节）：以新的 ID 写入样例文件、原子写入、保留两份、启动时清空。"""

import json
import shutil

import pytest

from spatialview_mock.export.files import FileStore
from tools.common.glb import read_glb
from tools.sample_data.generate import generate
from tools.validate import validate_plan


@pytest.fixture(scope="module")
def sample(tmp_path_factory):
    out = tmp_path_factory.mktemp("sample")
    generate("small", out)
    return out


@pytest.fixture
def store(tmp_path, sample):
    s = FileStore(tmp_path / "files", sample)
    s.clear()
    return s


def test_surfaces_from_sample(store):
    assert len(store.surfaces) == 29
    assert store.surfaces["bottom"] is False


def test_write_model(store):
    files = store.write_model("model_20261015T100000")
    assert files.url == "/models/model_20261015T100000.glb"
    path = store.root / "models" / "model_20261015T100000.glb"
    assert read_glb(path).gltf["scenes"][0]["extras"]["model_id"] == "model_20261015T100000"
    assert not list((store.root / "models").glob(".*.tmp"))


def test_write_plan(store, sample):
    files = store.write_plan("plan_20261015T100500", "model_20261015T100000", ["top_00_00"])
    plan = json.loads(
        (store.root / "plans" / "plan_20261015T100500.json").read_text(encoding="utf-8")
    )
    original = json.loads(next((sample / "plans").glob("*.json")).read_text(encoding="utf-8"))
    assert (plan["plan_id"], plan["model_id"], plan["surface_ids"]) == (
        "plan_20261015T100500",
        "model_20261015T100000",
        ["top_00_00"],
    )
    assert plan["tcp_path"] == original["tcp_path"]
    assert files.duration == original["duration"]
    assert files.process_intervals[0][0] == 0.0


def test_partial_plan_has_failed_paths(store, sample):
    """部分无法规划时规划文件带上样例的失败路径（接口文档 11.1）；全部成功时没有。"""
    store.write_plan("plan_a", "model_a", ["top_00_00"])
    store.write_plan("plan_b", "model_a", ["top_00_00"], partial=True)
    full = json.loads((store.root / "plans" / "plan_a.json").read_text(encoding="utf-8"))
    partial = json.loads((store.root / "plans" / "plan_b.json").read_text(encoding="utf-8"))
    assert "failed_paths" not in full
    expected = json.loads((sample / "failed_paths.json").read_text(encoding="utf-8"))
    assert partial["failed_paths"] == expected
    assert [f["surface_id"] for f in expected] == ["wall_xmax_00", "wall_xmax_01"]
    assert partial["tcp_path"] == full["tcp_path"]
    assert validate_plan(partial).ok


def test_sample_with_failed_paths(tmp_path):
    """样例的规划文件本身带失败路径时，只在部分无法规划时写入。"""
    sample = tmp_path / "sample"
    generate("small", sample, with_failed_paths=True)
    store = FileStore(tmp_path / "files", sample)
    store.write_plan("plan_a", "model_a", [])
    store.write_plan("plan_b", "model_a", [], partial=True)
    full = json.loads((store.root / "plans" / "plan_a.json").read_text(encoding="utf-8"))
    partial = json.loads((store.root / "plans" / "plan_b.json").read_text(encoding="utf-8"))
    assert "failed_paths" not in full
    assert len(partial["failed_paths"]) == 2


def test_old_sample_without_failed_paths(tmp_path, sample):
    """旧版样例的清单中没有失败路径：部分无法规划时也不写这个字段。"""
    old = tmp_path / "old"
    shutil.copytree(sample, old)
    manifest = json.loads((old / "manifest.json").read_text(encoding="utf-8"))
    del manifest["failed_paths"]
    (old / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    store = FileStore(tmp_path / "files", old)
    store.write_plan("plan_b", "model_a", [], partial=True)
    plan = json.loads((store.root / "plans" / "plan_b.json").read_text(encoding="utf-8"))
    assert "failed_paths" not in plan


def test_keeps_current_and_previous(store):
    for i in range(4):
        store.write_model(f"model_{i}")
    assert sorted(p.name for p in (store.root / "models").iterdir()) == [
        "model_2.glb",
        "model_3.glb",
    ]


def test_clear(store):
    store.write_model("model_x")
    store.write_plan("plan_x", "model_x", [])
    store.clear()
    assert not any((store.root / "models").iterdir()) and not any((store.root / "plans").iterdir())
