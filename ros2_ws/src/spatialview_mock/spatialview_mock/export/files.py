"""文件目录：样例模型和规划文件以新的 ID 写入，接口文档第 9 节。

- 路径：models/<model_id>.glb、plans/<plan_id>.json，SystemState 中给出相对路径。
- 部分无法规划时，规划文件带上样例的失败路径（failed_paths.json，接口文档 11.1 的 failed_paths）。
- 先写临时文件，写完再重命名为正式文件名。
- 保留当前和上一份，更早的删除；启动时清空。
"""

from __future__ import annotations

import json
import os
import struct
from pathlib import Path

from spatialview_mock.core.machine import ExportError, ModelFiles, PlanFiles

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
KEEP_FILES = 2


def _read_glb(data: bytes) -> tuple[dict, bytes]:
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC or version != 2 or length != len(data):
        raise ExportError("样例模型不是有效的 GLB")
    json_length, chunk_type = struct.unpack_from("<II", data, 12)
    if chunk_type != CHUNK_JSON:
        raise ExportError("样例模型缺少 JSON 块")
    gltf = json.loads(data[20 : 20 + json_length].decode("utf-8"))
    return gltf, data[20 + json_length :]


def _with_model_id(data: bytes, model_id: str) -> bytes:
    """替换 scenes[0].extras.model_id，BIN 块原样保留。"""
    gltf, rest = _read_glb(data)
    gltf["scenes"][0].setdefault("extras", {})["model_id"] = model_id
    json_bytes = json.dumps(gltf, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * (-len(json_bytes) % 4)
    header = struct.pack("<II", len(json_bytes), CHUNK_JSON)
    body = header + json_bytes + rest
    return struct.pack("<III", GLB_MAGIC, 2, 12 + len(body)) + body


def _split_plan(text: str) -> tuple[dict, str]:
    """规划文件拆成开头的几个小字段和其余部分，替换 ID 时不必解析整个文件。

    样例由 tools.sample_data 生成，字段顺序固定：plan_id、model_id、frame_id、surface_ids、duration……
    """
    marker = ',"duration":'
    index = text.find(marker)
    if index < 0:
        raise ExportError("样例规划文件的字段顺序不符合预期")
    header = json.loads(text[:index] + "}")
    rest = text[index:]
    # 样例带失败路径时（排在最后）去掉，只在部分无法规划时写入
    failed = rest.rfind(',"failed_paths":')
    if failed >= 0:
        rest = rest[:failed] + "}"
    return header, rest


class FileStore:
    def __init__(self, root: Path, sample_dir: Path) -> None:
        self.root = Path(root)
        sample_dir = Path(sample_dir)
        manifest = json.loads((sample_dir / "manifest.json").read_text(encoding="utf-8"))
        self.sample_model = (sample_dir / manifest["model"]).read_bytes()
        self.plan_header, self.plan_rest = _split_plan(
            (sample_dir / manifest["plan"]).read_text(encoding="utf-8")
        )
        self.duration = float(manifest["duration"])
        # 旧版样例没有失败路径
        failed = manifest.get("failed_paths")
        self.failed_paths = (
            (sample_dir / failed).read_text(encoding="utf-8").strip() if failed else "[]"
        )
        self.intervals = [(float(a), float(b)) for a, b in manifest["process_intervals"]]
        gltf, _ = _read_glb(self.sample_model)
        self.surfaces = {
            node["extras"]["surface_id"]: bool(node["extras"]["selectable"])
            for node in gltf["nodes"]
        }
        self._written: dict[str, list[Path]] = {"models": [], "plans": []}

    def clear(self) -> None:
        """启动时删除文件目录中的旧文件（接口文档 8.8）。"""
        for folder in ("models", "plans"):
            directory = self.root / folder
            directory.mkdir(parents=True, exist_ok=True)
            for path in directory.iterdir():
                if path.is_file():
                    path.unlink()
            self._written[folder] = []

    def _write(self, folder: str, name: str, data: bytes) -> str:
        directory = self.root / folder
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / name
        temporary = directory / f".{name}.tmp"
        try:
            temporary.write_bytes(data)
            os.chmod(temporary, 0o644)
            os.replace(temporary, target)
        except OSError as exc:
            raise ExportError(f"写入 {target} 失败：{exc}") from exc
        written = self._written[folder]
        written.append(target)
        while len(written) > KEEP_FILES:
            written.pop(0).unlink(missing_ok=True)
        return f"/{folder}/{name}"

    def write_model(self, model_id: str) -> ModelFiles:
        url = self._write("models", f"{model_id}.glb", _with_model_id(self.sample_model, model_id))
        return ModelFiles(url, dict(self.surfaces))

    def write_plan(
        self, plan_id: str, model_id: str, surface_ids: list[str], partial: bool = False
    ) -> PlanFiles:
        """partial 为 True（部分无法规划）时带上样例的失败路径，不随未规划的表面变化。"""
        header = dict(self.plan_header, plan_id=plan_id, model_id=model_id, surface_ids=surface_ids)
        text = json.dumps(header, ensure_ascii=False, separators=(",", ":"))[:-1] + self.plan_rest
        if partial and self.failed_paths != "[]":
            text = f'{text[:-1]},"failed_paths":{self.failed_paths}}}'
        url = self._write("plans", f"{plan_id}.json", text.encode("utf-8"))
        return PlanFiles(url, self.duration, list(self.intervals))
