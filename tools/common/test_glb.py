import numpy as np
import pytest

from tools.common.glb import GlbBuilder, GlbError, read_accessor, read_glb, set_model_id


def _triangle_glb() -> bytes:
    builder = GlbBuilder()
    positions = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], np.float32)
    normals = np.tile(np.array([0, 0, 1], np.float32), (3, 1))
    builder.add_mesh_node("s1", positions, normals, [0, 1, 2], {"surface_id": "s1"})
    return builder.build({"model_id": "model_x"})


def test_round_trip():
    glb = read_glb(_triangle_glb())
    assert glb.gltf["asset"]["version"] == "2.0"
    assert glb.gltf["scenes"][0]["extras"] == {"model_id": "model_x"}
    primitive = glb.gltf["meshes"][0]["primitives"][0]
    positions = read_accessor(glb, primitive["attributes"]["POSITION"])
    assert positions.shape == (3, 3)
    assert positions[1].tolist() == [1, 0, 0]
    indices = read_accessor(glb, primitive["indices"])
    assert indices.dtype == np.uint16
    assert indices.tolist() == [0, 1, 2]
    position_accessor = glb.gltf["accessors"][primitive["attributes"]["POSITION"]]
    assert position_accessor["min"] == [0, 0, 0]
    assert position_accessor["max"] == [1, 1, 0]


def test_set_model_id():
    glb = read_glb(set_model_id(_triangle_glb(), "model_y"))
    assert glb.gltf["scenes"][0]["extras"]["model_id"] == "model_y"


@pytest.mark.parametrize(
    "data, message",
    [
        (b"short", "太短"),
        (b"abcd" + b"\x02\x00\x00\x00" + b"\x0c\x00\x00\x00", "不是 glTF"),
    ],
)
def test_bad_container(data, message):
    with pytest.raises(GlbError, match=message):
        read_glb(data)


def test_length_mismatch():
    data = bytearray(_triangle_glb())
    data += b"\x00\x00\x00\x00"
    with pytest.raises(GlbError, match="长度"):
        read_glb(bytes(data))
