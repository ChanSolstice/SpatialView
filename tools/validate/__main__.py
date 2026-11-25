"""命令行：uv run python -m tools.validate --model 模型.glb --plan 规划.json [--urdf 机械臂.urdf]"""

from __future__ import annotations

import argparse
import json
import sys

from tools.common.urdf import parse_urdf
from tools.validate.model import validate_model
from tools.validate.plan import validate_plan


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m tools.validate",
        description="按接口文档第 10、11 节检查工件模型 GLB 和规划文件。同时给出两者时做交叉检查。",
    )
    parser.add_argument("--model", help="工件模型 GLB")
    parser.add_argument("--plan", help="规划文件 JSON")
    parser.add_argument(
        "--urdf", help="机械臂 URDF：检查关节名、关节范围；配合 --tcp-link 做正运动学检查"
    )
    parser.add_argument("--tcp-link", help="URDF 中的 TCP 连杆名，例如 tcp_link")
    parser.add_argument("--model-id", help="期望的 model_id")
    parser.add_argument("--plan-id", help="期望的 plan_id")
    parser.add_argument(
        "--selected",
        metavar="ID,ID,...",
        help='StartPlan 发送的 surface_ids，逗号分隔；规划全部时给 ""。检查规划文件的有效选择与之一致',
    )
    parser.add_argument(
        "--tcp-tolerance",
        type=float,
        default=0.05,
        help="工艺段 TCP 点到模型表面的允许距离，米（默认 0.05）",
    )
    parser.add_argument(
        "--fk-tolerance",
        type=float,
        default=0.005,
        help="正运动学与 TCP 路径的允许偏差，米（默认 0.005）",
    )
    parser.add_argument("--json", action="store_true", help="以 JSON 输出结果")
    args = parser.parse_args(argv)
    if not args.model and not args.plan:
        parser.error("至少给出 --model 或 --plan")

    reports = []
    model_info = None
    if args.model:
        model_report, model_info = validate_model(args.model, expected_model_id=args.model_id)
        reports.append(model_report)
    if args.plan:
        robot = parse_urdf(args.urdf) if args.urdf else None
        reports.append(
            validate_plan(
                args.plan,
                model=model_info,
                robot=robot,
                tcp_link=args.tcp_link,
                expected_plan_id=args.plan_id,
                expected_model_id=args.model_id,
                expected_selected=None
                if args.selected is None
                else [s for s in args.selected.split(",") if s],
                tcp_tolerance=args.tcp_tolerance,
                fk_tolerance=args.fk_tolerance,
            )
        )

    if args.json:
        print(json.dumps([r.to_dict() for r in reports], ensure_ascii=False, indent=2))
    else:
        print("\n\n".join(r.format() for r in reports))
    return 0 if all(r.ok for r in reports) else 1


if __name__ == "__main__":
    sys.exit(main())
