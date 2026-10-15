"""按接口文档第 10 节检查工件模型 GLB。"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from tools.common.glb import Glb, GlbError, read_accessor, read_glb
from tools.validate.report import Report

ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
MAX_TRIANGLES = 300_000
MAX_SURFACES = 500
COMPRESSION_EXTENSIONS = {
    "KHR_draco_mesh_compression",
    "EXT_meshopt_compression",
    "KHR_meshopt_compression",
}
FLOAT = 5126
INDEX_TYPES = {5123: "uint16", 5125: "uint32"}
IDENTITY = {
    "translation": [0, 0, 0],
    "rotation": [0, 0, 0, 1],
    "scale": [1, 1, 1],
    "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
}


@dataclass
class ModelInfo:
    """交叉检查（规划文件）需要的模型信息。"""

    model_id: str | None
    surfaces: dict[str, bool] = field(default_factory=dict)  # surface_id → selectable
    triangles: int = 0
    points: np.ndarray = field(default_factory=lambda: np.zeros((0, 3)))  # 顶点和三角面中心


def validate_model(
    source: str | Path | bytes, *, expected_model_id: str | None = None
) -> tuple[Report, ModelInfo | None]:
    subject = "工件模型" if isinstance(source, (bytes, bytearray)) else str(source)
    report = Report(subject)
    try:
        glb = read_glb(source)
    except (GlbError, OSError) as exc:
        report.error("MODEL_CONTAINER", f"无法读取 GLB：{exc}")
        return report, None

    gltf = glb.gltf
    if gltf.get("asset", {}).get("version") != "2.0":
        report.error("MODEL_ASSET_VERSION", 'asset.version 必须为 "2.0"')
    used = set(gltf.get("extensionsUsed", [])) | set(gltf.get("extensionsRequired", []))
    for name in sorted(used & COMPRESSION_EXTENSIONS):
        report.error("MODEL_COMPRESSION", f"使用了压缩扩展 {name}，接口要求不压缩")

    info = ModelInfo(model_id=None)
    scenes = gltf.get("scenes") or []
    scene_index = gltf.get("scene", 0)
    if not scenes or not isinstance(scene_index, int) or not 0 <= scene_index < len(scenes):
        report.error("MODEL_SCENE", "缺少场景：需要 scenes[0]，并由 scene 指向它")
        return report, info
    if scene_index != 0:
        report.error("MODEL_SCENE", f"scene 为 {scene_index}，接口要求使用 scenes[0]")
    scene = scenes[0]
    _check_model_id(report, scene, expected_model_id, info)

    nodes = gltf.get("nodes", [])
    roots = scene.get("nodes", [])
    if not roots:
        report.error("MODEL_NO_SURFACES", "scenes[0] 中没有表面节点")
    referenced_as_child = {c for n in nodes for c in n.get("children", [])}
    for orphan in sorted(set(range(len(nodes))) - set(roots) - referenced_as_child):
        report.warning("MODEL_ORPHAN_NODE", f"nodes[{orphan}] 不在场景中，APP 不会显示它")

    point_blocks: list[np.ndarray] = []
    for index in roots:
        if not isinstance(index, int) or not 0 <= index < len(nodes):
            report.error("MODEL_SCENE", f"scenes[0].nodes 引用了不存在的节点 {index}")
            continue
        _check_surface_node(report, glb, index, nodes[index], info, point_blocks)

    if len(info.surfaces) > MAX_SURFACES:
        report.error("MODEL_SURFACES_LIMIT", f"表面 {len(info.surfaces)} 个，超过 {MAX_SURFACES}")
    if info.triangles > MAX_TRIANGLES:
        report.error("MODEL_TRIANGLES_LIMIT", f"三角面 {info.triangles} 个，超过 {MAX_TRIANGLES}")
    if info.surfaces and not any(info.surfaces.values()):
        report.warning("MODEL_NOTHING_SELECTABLE", "没有可清洗（selectable 为 true）的表面")
    if point_blocks:
        info.points = np.concatenate(point_blocks)
    report.info(
        "MODEL_SUMMARY",
        f"model_id {info.model_id}，表面 {len(info.surfaces)} 个"
        f"（可清洗 {sum(info.surfaces.values())} 个），三角面 {info.triangles} 个",
    )
    return report, info


def _check_model_id(report: Report, scene: dict, expected: str | None, info: ModelInfo) -> None:
    model_id = (scene.get("extras") or {}).get("model_id")
    if not isinstance(model_id, str) or not model_id:
        report.error("MODEL_ID_MISSING", "scenes[0].extras.model_id 缺失或不是字符串")
        return
    info.model_id = model_id
    if not ID_PATTERN.match(model_id):
        report.error("MODEL_ID_FORMAT", f"model_id {model_id!r} 只能包含字母、数字、下划线和连字符")
    if expected is not None and model_id != expected:
        report.error("MODEL_ID_MISMATCH", f"model_id 为 {model_id}，应为 {expected}")


def _check_surface_node(
    report: Report,
    glb: Glb,
    index: int,
    node: dict,
    info: ModelInfo,
    point_blocks: list[np.ndarray],
) -> None:
    where = f"nodes[{index}]"
    name = node.get("name")
    extras = node.get("extras") or {}
    surface_id = extras.get("surface_id")
    label = f"{where}（{surface_id or name or '无名称'}）"

    if node.get("children"):
        report.error("MODEL_NODE_NESTED", f"{label} 有子节点，表面节点不能嵌套")
    for key, identity in IDENTITY.items():
        if key in node:
            if np.allclose(node[key], identity):
                report.warning("MODEL_NODE_TRANSFORM", f"{label} 设置了 {key}（单位值），建议删除")
            else:
                report.error(
                    "MODEL_NODE_TRANSFORM",
                    f"{label} 设置了 {key}，顶点坐标必须直接是 base_link 坐标（是否做了 Y-up 转换？）",
                )

    if not isinstance(surface_id, str) or not surface_id:
        report.error("MODEL_SURFACE_ID", f"{label} 的 extras.surface_id 缺失")
    else:
        if not ID_PATTERN.match(surface_id):
            report.error(
                "MODEL_SURFACE_ID", f"{label} 的 surface_id 只能包含字母、数字、下划线和连字符"
            )
        if name != surface_id:
            report.error("MODEL_SURFACE_ID", f"{label} 的 name 为 {name!r}，应等于 surface_id")
        if surface_id in info.surfaces:
            report.error("MODEL_SURFACE_ID", f"surface_id {surface_id} 重复")
    selectable = extras.get("selectable")
    if not isinstance(selectable, bool):
        report.error("MODEL_SELECTABLE", f"{label} 的 extras.selectable 缺失或不是布尔值")
    if isinstance(surface_id, str) and surface_id and surface_id not in info.surfaces:
        info.surfaces[surface_id] = selectable is True

    meshes = glb.gltf.get("meshes", [])
    mesh_index = node.get("mesh")
    if not isinstance(mesh_index, int) or not 0 <= mesh_index < len(meshes):
        report.error("MODEL_NODE_NO_MESH", f"{label} 没有指向有效的 mesh")
        return
    primitives = meshes[mesh_index].get("primitives", [])
    if len(primitives) != 1:
        report.error(
            "MODEL_PRIMITIVES", f"{label} 的 mesh 有 {len(primitives)} 个 primitive，要求恰好 1 个"
        )
        if not primitives:
            return
    primitive = primitives[0]
    if primitive.get("mode", 4) != 4:
        report.error(
            "MODEL_PRIMITIVE_MODE", f"{label} 的 mode 为 {primitive['mode']}，要求 4（三角形）"
        )
        return
    _check_geometry(report, glb, label, primitive, info, point_blocks)


def _check_geometry(
    report: Report,
    glb: Glb,
    label: str,
    primitive: dict,
    info: ModelInfo,
    point_blocks: list[np.ndarray],
) -> None:
    accessors = glb.gltf.get("accessors", [])
    attributes = primitive.get("attributes", {})
    arrays = {}
    for name in ("POSITION", "NORMAL"):
        index = attributes.get(name)
        if not isinstance(index, int) or not 0 <= index < len(accessors):
            report.error("MODEL_ATTRIBUTES", f"{label} 缺少 {name}")
            continue
        accessor = accessors[index]
        if accessor.get("componentType") != FLOAT or accessor.get("type") != "VEC3":
            report.error("MODEL_ATTRIBUTES", f"{label} 的 {name} 必须是 float32 的 VEC3")
            continue
        try:
            arrays[name] = read_accessor(glb, index)
        except GlbError as exc:
            report.error("MODEL_ATTRIBUTES", f"{label} 的 {name} 无法读取：{exc}")
    if "POSITION" not in arrays:
        return
    positions = arrays["POSITION"]
    if "NORMAL" in arrays and len(arrays["NORMAL"]) != len(positions):
        report.error("MODEL_ATTRIBUTES", f"{label} 的 NORMAL 与 POSITION 数量不一致")
    if not np.isfinite(positions).all():
        report.error("MODEL_ATTRIBUTES", f"{label} 的 POSITION 含有非有限值")

    index = primitive.get("indices")
    if not isinstance(index, int) or not 0 <= index < len(accessors):
        report.error("MODEL_INDICES", f"{label} 缺少 indices")
        return
    accessor = accessors[index]
    if accessor.get("componentType") not in INDEX_TYPES or accessor.get("type") != "SCALAR":
        report.error("MODEL_INDICES", f"{label} 的 indices 必须是 uint16 或 uint32 的 SCALAR")
        return
    try:
        indices = read_accessor(glb, index)
    except GlbError as exc:
        report.error("MODEL_INDICES", f"{label} 的 indices 无法读取：{exc}")
        return
    if len(indices) == 0 or len(indices) % 3:
        report.error(
            "MODEL_INDICES", f"{label} 的 indices 数量为 {len(indices)}，应为 3 的正整数倍"
        )
        return
    if int(indices.max()) >= len(positions):
        report.error("MODEL_INDICES", f"{label} 的 indices 超出顶点范围")
        return
    triangles = indices.reshape(-1, 3)
    info.triangles += len(triangles)
    centroids = positions[triangles].mean(axis=1)
    point_blocks += [positions.astype(float), centroids.astype(float)]
