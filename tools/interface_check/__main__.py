"""命令行：uv run python -m tools.interface_check --rosbridge ws://<主机>:9090 --http http://<主机>:8080"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from tools.interface_check.checks import Checker, Options


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m tools.interface_check",
        description=(
            "经 rosbridge 和 HTTP 检查服务端是否符合接口文档。默认只运行不会让机械臂运动、不会开启激光的用例；"
            "--allow-* 开启的用例需要现场人员看护。"
        ),
    )
    defaults = Options()
    parser.add_argument(
        "--rosbridge",
        default=defaults.rosbridge,
        help=f"rosbridge 地址（默认 {defaults.rosbridge}）",
    )
    parser.add_argument(
        "--http", default=defaults.http, help=f"文件服务地址（默认 {defaults.http}）"
    )
    parser.add_argument(
        "--estop-service",
        default=defaults.estop_service,
        help="机械臂急停 Service 的名称（接口文档 6.7）",
    )
    parser.add_argument(
        "--urdf", type=Path, help="机械臂 URDF：检查规划文件的关节名，配合 --tcp-link 检查正运动学"
    )
    parser.add_argument("--tcp-link", help="URDF 中的 TCP 连杆名")
    parser.add_argument(
        "--allow-motion",
        action="store_true",
        help="运行扫描、规划、开始、暂停、继续、停止（机械臂会运动）",
    )
    parser.add_argument(
        "--allow-laser", action="store_true", help="运行开启、关闭激光（激光会开启）"
    )
    parser.add_argument("--allow-estop", action="store_true", help="调用机械臂急停 Service 并复位")
    parser.add_argument(
        "--wait", type=float, default=defaults.wait, help="等待扫描、规划、停止完成的最长时间，秒"
    )
    parser.add_argument(
        "--connect-timeout",
        type=float,
        default=0.0,
        help="连接失败或服务端尚未就绪时重试的时长，秒（默认不重试）",
    )
    parser.add_argument("--json", action="store_true", help="以 JSON 输出结果")
    args = parser.parse_args(argv)
    options = Options(
        rosbridge=args.rosbridge,
        http=args.http,
        estop_service=args.estop_service,
        urdf=args.urdf,
        tcp_link=args.tcp_link,
        allow_motion=args.allow_motion,
        allow_laser=args.allow_laser,
        allow_estop=args.allow_estop,
        wait=args.wait,
        connect_timeout=args.connect_timeout,
    )
    report = Checker(options).run()
    print(
        json.dumps(report.to_dict(), ensure_ascii=False, indent=2) if args.json else report.format()
    )
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
