"""glTF 二进制（GLB）容器的读写，以及按 accessor 读取数据。只依赖 numpy。"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

GLB_MAGIC = 0x46546C67  # "glTF"
CHUNK_JSON = 0x4E4F534A  # "JSON"
CHUNK_BIN = 0x004E4942  # "BIN\0"

# glTF accessor.componentType → numpy 类型
COMPONENT_DTYPES: dict[int, type[np.generic]] = {
    5120: np.int8,
    5121: np.uint8,
    5122: np.int16,
    5123: np.uint16,
    5125: np.uint32,
    5126: np.float32,
}
TYPE_SIZES = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}

ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963


class GlbError(ValueError):
    """GLB 容器或 accessor 的格式错误。"""


@dataclass
class Glb:
    gltf: dict
    bin: bytes


def read_glb(source: str | Path | bytes) -> Glb:
    """读取 GLB：返回 JSON 部分和 BIN 块。"""
    data = bytes(source) if isinstance(source, (bytes, bytearray)) else Path(source).read_bytes()
    if len(data) < 12:
        raise GlbError("文件太短，不是 GLB")
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        raise GlbError("文件头不是 glTF 二进制（GLB）")
    if version != 2:
        raise GlbError(f"GLB 版本为 {version}，要求 2")
    if length != len(data):
        raise GlbError(f"文件头记录的长度 {length} 与实际长度 {len(data)} 不一致")

    offset = 12
    gltf: dict | None = None
    bin_chunk = b""
    while offset < length:
        if offset + 8 > length:
            raise GlbError("块头不完整")
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk = data[offset : offset + chunk_length]
        if len(chunk) != chunk_length:
            raise GlbError("块数据不完整")
        offset += chunk_length
        if chunk_type == CHUNK_JSON and gltf is None:
            try:
                gltf = json.loads(chunk.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise GlbError(f"JSON 块无法解析：{exc}") from exc
        elif chunk_type == CHUNK_BIN and not bin_chunk:
            bin_chunk = chunk
    if gltf is None:
        raise GlbError("缺少 JSON 块")
    if not isinstance(gltf, dict):
        raise GlbError("JSON 块不是对象")
    return Glb(gltf, bin_chunk)


def pack_glb(gltf: dict, bin_data: bytes) -> bytes:
    """把 JSON 和 BIN 数据打包为 GLB。"""
    json_bytes = json.dumps(gltf, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * (-len(json_bytes) % 4)
    bin_bytes = bytes(bin_data) + b"\x00" * (-len(bin_data) % 4)
    total = 12 + 8 + len(json_bytes) + (8 + len(bin_bytes) if bin_bytes else 0)
    parts = [
        struct.pack("<III", GLB_MAGIC, 2, total),
        struct.pack("<II", len(json_bytes), CHUNK_JSON),
        json_bytes,
    ]
    if bin_bytes:
        parts += [struct.pack("<II", len(bin_bytes), CHUNK_BIN), bin_bytes]
    return b"".join(parts)


def read_accessor(glb: Glb, index: int) -> np.ndarray:
    """按 accessor 读取数据。标量返回一维数组，向量返回 (count, 分量数)。"""
    accessors = glb.gltf.get("accessors", [])
    if not 0 <= index < len(accessors):
        raise GlbError(f"accessor {index} 不存在")
    acc = accessors[index]
    try:
        dtype = np.dtype(COMPONENT_DTYPES[acc["componentType"]])
        components = TYPE_SIZES[acc["type"]]
        count = int(acc["count"])
    except KeyError as exc:
        raise GlbError(f"accessor {index} 缺少或不支持 {exc}") from exc
    if "sparse" in acc:
        raise GlbError(f"accessor {index} 使用了 sparse，不支持")
    if "bufferView" not in acc:
        values = np.zeros((count, components), dtype)
        return values.reshape(count) if components == 1 else values

    views = glb.gltf.get("bufferViews", [])
    view_index = acc["bufferView"]
    if not 0 <= view_index < len(views):
        raise GlbError(f"accessor {index} 引用的 bufferView {view_index} 不存在")
    view = views[view_index]
    if view.get("buffer", 0) != 0:
        raise GlbError("只支持 GLB 内嵌的第一个 buffer")
    element_size = dtype.itemsize * components
    stride = view.get("byteStride") or element_size
    view_start = view.get("byteOffset", 0)
    start = view_start + acc.get("byteOffset", 0)
    end = start + (stride * (count - 1) + element_size if count else 0)
    if end > view_start + view["byteLength"] or end > len(glb.bin):
        raise GlbError(f"accessor {index} 的数据超出 bufferView 或 BIN 块的范围")
    values = np.ndarray(
        shape=(count, components),
        dtype=dtype,
        buffer=glb.bin,
        offset=start,
        strides=(stride, dtype.itemsize),
    ).copy()
    return values.reshape(count) if components == 1 else values


class GlbBuilder:
    """逐个添加三角网格节点，生成 GLB。每个节点一个 mesh，每个 mesh 一个 primitive。"""

    def __init__(self, generator: str = "SpatialView tools") -> None:
        self.gltf: dict = {
            "asset": {"version": "2.0", "generator": generator},
            "buffers": [{"byteLength": 0}],
            "bufferViews": [],
            "accessors": [],
            "meshes": [],
            "nodes": [],
        }
        self._bin = bytearray()

    def _add_view(self, data: bytes, target: int) -> int:
        self._bin += b"\x00" * (-len(self._bin) % 4)
        self.gltf["bufferViews"].append(
            {"buffer": 0, "byteOffset": len(self._bin), "byteLength": len(data), "target": target}
        )
        self._bin += data
        return len(self.gltf["bufferViews"]) - 1

    def _add_accessor(self, array: np.ndarray, target: int, *, bounds: bool = False) -> int:
        array = np.ascontiguousarray(array)
        component = {np.dtype(v): k for k, v in COMPONENT_DTYPES.items()}[array.dtype]
        accessor: dict = {
            "bufferView": self._add_view(array.tobytes(), target),
            "componentType": component,
            "count": int(array.shape[0]),
            "type": "SCALAR" if array.ndim == 1 else f"VEC{array.shape[1]}",
        }
        if bounds:
            accessor["min"] = [float(v) for v in array.min(axis=0)]
            accessor["max"] = [float(v) for v in array.max(axis=0)]
        self.gltf["accessors"].append(accessor)
        return len(self.gltf["accessors"]) - 1

    def add_mesh_node(
        self,
        name: str,
        positions: np.ndarray,
        normals: np.ndarray,
        indices: np.ndarray,
        extras: dict | None = None,
    ) -> int:
        positions = np.asarray(positions, np.float32)
        normals = np.asarray(normals, np.float32)
        index_type = np.uint16 if len(positions) <= 0xFFFF else np.uint32
        primitive = {
            "attributes": {
                "POSITION": self._add_accessor(positions, ARRAY_BUFFER, bounds=True),
                "NORMAL": self._add_accessor(normals, ARRAY_BUFFER),
            },
            "indices": self._add_accessor(
                np.asarray(indices).astype(index_type), ELEMENT_ARRAY_BUFFER
            ),
            "mode": 4,
        }
        self.gltf["meshes"].append({"primitives": [primitive]})
        node: dict = {"name": name, "mesh": len(self.gltf["meshes"]) - 1}
        if extras is not None:
            node["extras"] = extras
        self.gltf["nodes"].append(node)
        return len(self.gltf["nodes"]) - 1

    def build(self, scene_extras: dict | None = None) -> bytes:
        scene: dict = {"nodes": list(range(len(self.gltf["nodes"])))}
        if scene_extras is not None:
            scene["extras"] = scene_extras
        gltf = dict(self.gltf, scene=0, scenes=[scene])
        gltf["buffers"] = [{"byteLength": len(self._bin)}]
        return pack_glb(gltf, bytes(self._bin))


def set_model_id(glb_bytes: bytes, model_id: str) -> bytes:
    """替换 GLB 中 scenes[0].extras.model_id，其余内容不变。"""
    glb = read_glb(glb_bytes)
    scenes = glb.gltf.get("scenes") or [{}]
    scenes[0].setdefault("extras", {})["model_id"] = model_id
    glb.gltf["scenes"] = scenes
    return pack_glb(glb.gltf, glb.bin)
