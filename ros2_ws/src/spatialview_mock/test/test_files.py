"""文件目录（接口文档第 9 节）：以新的 ID 写入样例文件、原子写入、保留两份、启动时清空。"""

import json

import pytest

from spatialview_mock.export.files import FileStore
from tools.common.glb import read_glb
from tools.sample_data.generate import generate


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
