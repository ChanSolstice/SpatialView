"""命令行：uv run python -m tools.sample_data --size large --out samples/large"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from tools.sample_data.generate import DEFAULT_TCP_LINK, DEFAULT_URDF, SIZES, SampleError, generate


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m tools.sample_data",
        description="生成符合接口文档第 10、11 节的样例工件模型和规划文件。",
    )
    parser.add_argument(
        "--size", choices=sorted(SIZES), default="small", help="样例规模（默认 small）"
    )
    parser.add_argument("--out", type=Path, help="输出目录（默认 samples/<规模>）")
    parser.add_argument("--urdf", type=Path, default=DEFAULT_URDF, help="机械臂 URDF")
    parser.add_argument("--tcp-link", default=DEFAULT_TCP_LINK, help="URDF 中的 TCP 连杆名")
    parser.add_argument("--model-id", help="model_id（默认按规模取固定值）")
    parser.add_argument("--plan-id", help="plan_id（默认按规模取固定值）")
    parser.add_argument(
        "--failed-paths",
        action="store_true",
        help="规划文件中带上失败路径 failed_paths（接口文档 11.1）；默认只写入 failed_paths.json",
    )
    args = parser.parse_args(argv)

    out = args.out or Path("samples") / args.size
    started = time.monotonic()
    try:
        manifest = generate(
            args.size,
            out,
            urdf=args.urdf,
            tcp_link=args.tcp_link,
            model_id=args.model_id,
            plan_id=args.plan_id,
            with_failed_paths=args.failed_paths,
        )
    except SampleError as exc:
        print(f"生成失败：{exc}", file=sys.stderr)
        return 1
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f"已写入 {out}，用时 {time.monotonic() - started:.1f} 秒")
    return 0


if __name__ == "__main__":
    sys.exit(main())
