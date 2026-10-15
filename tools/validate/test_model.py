import numpy as np

from tools.common.glb import GlbBuilder, pack_glb, read_accessor, read_glb
from tools.validate import validate_model, validate_plan


def mutate(glb_bytes: bytes, change) -> bytes:
    glb = read_glb(glb_bytes)
    change(glb.gltf)
    return pack_glb(glb.gltf, glb.bin)


def rebuild(glb_bytes: bytes, transform) -> bytes:
    """读出全部表面节点，对顶点和法向量做变换后重新打包。"""
    glb = read_glb(glb_bytes)
    builder = GlbBuilder()
    for node in glb.gltf["nodes"]:
        primitive = glb.gltf["meshes"][node["mesh"]]["primitives"][0]
        positions = read_accessor(glb, primitive["attributes"]["POSITION"])
        normals = read_accessor(glb, primitive["attributes"]["NORMAL"])
        indices = read_accessor(glb, primitive["indices"])
        builder.add_mesh_node(
            node["name"], transform(positions), transform(normals), indices, node["extras"]
        )
    return builder.build(glb.gltf["scenes"][0]["extras"])


def codes(glb_bytes: bytes, **kwargs) -> set[str]:
    report, _ = validate_model(glb_bytes, **kwargs)
    return report.codes("error")


def test_valid(small_glb):
    report, info = validate_model(small_glb, expected_model_id="model_20261015T080000")
    assert report.ok, report.format()
    assert len(info.surfaces) == 29
    assert info.triangles == 930


def test_container():
    assert codes(b"not a glb at all") == {"MODEL_CONTAINER"}


def test_compression(small_glb):
    glb = mutate(small_glb, lambda g: g.update(extensionsUsed=["KHR_draco_mesh_compression"]))
    assert "MODEL_COMPRESSION" in codes(glb)


def test_model_id(small_glb):
    assert "MODEL_ID_MISMATCH" in codes(small_glb, expected_model_id="model_other")
    missing = mutate(small_glb, lambda g: g["scenes"][0].pop("extras"))
    assert "MODEL_ID_MISSING" in codes(missing)
    bad = mutate(small_glb, lambda g: g["scenes"][0]["extras"].update(model_id="模型 1"))
    assert "MODEL_ID_FORMAT" in codes(bad)


def test_node_transform(small_glb):
    moved = mutate(small_glb, lambda g: g["nodes"][0].update(translation=[0, 0, 0.1]))
    assert "MODEL_NODE_TRANSFORM" in codes(moved)
    identity = mutate(small_glb, lambda g: g["nodes"][0].update(rotation=[0, 0, 0, 1]))
    report, _ = validate_model(identity)
    assert report.ok
    assert "MODEL_NODE_TRANSFORM" in report.codes("warning")


def test_nested_node(small_glb):
    def nest(g):
        g["nodes"][0]["children"] = [1]
        g["scenes"][0]["nodes"].remove(1)

    assert "MODEL_NODE_NESTED" in codes(mutate(small_glb, nest))


def test_primitives(small_glb):
    def two(g):
        mesh = g["meshes"][0]
        mesh["primitives"].append(dict(mesh["primitives"][0]))

    assert "MODEL_PRIMITIVES" in codes(mutate(small_glb, two))
    lines = mutate(small_glb, lambda g: g["meshes"][0]["primitives"][0].update(mode=1))
    assert "MODEL_PRIMITIVE_MODE" in codes(lines)


def test_attributes(small_glb):
    no_normal = mutate(
        small_glb, lambda g: g["meshes"][0]["primitives"][0]["attributes"].pop("NORMAL")
    )
    assert "MODEL_ATTRIBUTES" in codes(no_normal)


def test_indices_out_of_range(small_glb):
    def shrink(g):
        position = g["meshes"][0]["primitives"][0]["attributes"]["POSITION"]
        g["accessors"][position]["count"] = 3

    assert "MODEL_INDICES" in codes(mutate(small_glb, shrink))


def test_surface_ids(small_glb):
    renamed = mutate(small_glb, lambda g: g["nodes"][0].update(name="other"))
    assert "MODEL_SURFACE_ID" in codes(renamed)

    def duplicate(g):
        g["nodes"][1]["name"] = g["nodes"][0]["name"]
        g["nodes"][1]["extras"]["surface_id"] = g["nodes"][0]["name"]

    assert "MODEL_SURFACE_ID" in codes(mutate(small_glb, duplicate))
    no_flag = mutate(small_glb, lambda g: g["nodes"][0]["extras"].pop("selectable"))
    assert "MODEL_SELECTABLE" in codes(no_flag)


def _triangles(nodes: int, triangles_per_node: int) -> bytes:
    builder = GlbBuilder()
    positions = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], np.float32)
    normals = np.tile(np.array([0, 0, 1], np.float32), (3, 1))
    indices = np.tile([0, 1, 2], triangles_per_node)
    for i in range(nodes):
        builder.add_mesh_node(
            f"s{i}", positions, normals, indices, {"surface_id": f"s{i}", "selectable": True}
        )
    return builder.build({"model_id": "model_x"})


def test_limits():
    assert "MODEL_SURFACES_LIMIT" in codes(_triangles(501, 1))
    assert "MODEL_TRIANGLES_LIMIT" in codes(_triangles(1, 300_001))
    assert codes(_triangles(500, 600)) == set()


def test_y_up_conversion_detected_with_plan(small_glb, small_plan):
    # Blender 等工具导出 glTF 时的 Y-up 转换：(x, y, z) → (x, z, -y)
    converted = rebuild(small_glb, lambda v: np.column_stack([v[:, 0], v[:, 2], -v[:, 1]]))
    report, info = validate_model(converted)
    assert report.ok  # 单看模型发现不了
    plan_report = validate_plan(small_plan, model=info)
    assert "TCP_FAR_FROM_MODEL" in plan_report.codes("error")
