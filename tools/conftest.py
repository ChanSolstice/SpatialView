import json

import pytest

from tools.common.urdf import parse_urdf
from tools.sample_data.generate import DEFAULT_URDF, generate


@pytest.fixture(scope="session")
def small_sample(tmp_path_factory):
    """生成一组小样例：返回 (输出目录, 清单)。"""
    out = tmp_path_factory.mktemp("small_sample")
    return out, generate("small", out)


@pytest.fixture(scope="session")
def small_glb(small_sample) -> bytes:
    out, manifest = small_sample
    return (out / manifest["model"]).read_bytes()


@pytest.fixture
def small_plan(small_sample) -> dict:
    """每个测试拿到一份新的规划文件内容，可以随意修改。"""
    out, manifest = small_sample
    return json.loads((out / manifest["plan"]).read_text(encoding="utf-8"))


@pytest.fixture
def small_failed_paths(small_sample) -> list:
    """小样例的失败路径（failed_paths.json），每个测试一份新的。"""
    out, manifest = small_sample
    return json.loads((out / manifest["failed_paths"]).read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def robot():
    return parse_urdf(DEFAULT_URDF)
