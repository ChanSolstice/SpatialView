"""网页版压缩包的交付前检查（阶段规划 4.4），用法见 tools/README.md。

  uv run python -m tools.web_check delivery/<日期>/spatialview-web-<版本>.tar.gz \\
      --password-file <工程入口密码文件> --out <输出目录>

需要本机的开发环境（deploy/README.md）、Google Chrome，以及至少 500 MB 可用内存。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from tools.web_check.check import Options, WebCheck, package_version


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m tools.web_check",
        description="解压网页版压缩包，用启动脚本打开，连接本机开发环境的 mock 服务端逐项检查",
    )
    parser.add_argument("archive", type=Path, help="spatialview-web-<版本>.tar.gz")
    parser.add_argument(
        "--password-file",
        type=Path,
        required=True,
        help="工程入口的密码，文件中只有这一行；密码不在命令行上给出",
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="解压目录、截图、启动日志和 results.json 的位置；不能已经有同名的解压目录",
    )
    parser.add_argument("--rosbridge", default="ws://127.0.0.1:9090", help="开发环境的 rosbridge")
    parser.add_argument("--http", default="http://127.0.0.1:8080", help="开发环境的文件服务")
    parser.add_argument("--page-port", type=int, default=8093, help="启动脚本提供页面的端口")
    parser.add_argument("--cdp-port", type=int, default=9397, help="Chrome 的远程调试端口")
    parser.add_argument("--no-animation", action="store_true", help="不播放轨迹动画（内存不足时）")
    args = parser.parse_args(argv)
    try:
        package_version(args.archive)
    except ValueError as error:
        parser.error(str(error))
    if not args.archive.is_file():
        parser.error(f"找不到压缩包 {args.archive}")
    if not args.password_file.is_file():
        parser.error(f"找不到密码文件 {args.password_file}")
    options = Options(
        archive=args.archive.resolve(),
        out=args.out.resolve(),
        password_file=args.password_file,
        rosbridge=args.rosbridge,
        http=args.http,
        page_port=args.page_port,
        cdp_port=args.cdp_port,
        animation=not args.no_animation,
    )
    return 0 if WebCheck(options).run() else 1


if __name__ == "__main__":
    sys.exit(main())
