"""录制演示视频（阶段规划阶段 13）：本机无头 Chrome 按分镜逐帧录制 APP 的完整工作流程，用 ffmpeg 编码为 MP4。

  SAMPLE_SIZE=demo docker compose -f deploy/docker-compose.dev.yml up -d --force-recreate
  (cd app && NODE_ENV=development npx vite build --mode development --outDir dist-demo)
  python3 -m http.server 4174 --directory app/dist-demo &
  uv run python -m tools.demo --url http://127.0.0.1:4174/ --out demo-output

使用开发模式的构建：界面与打包产物相同，另有 window.spatialviewScene，用来求表面在屏幕上的位置。
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

from tools.demo.recorder import (
    CLOCK_JS,
    INJECT_SERVICE,
    INJECT_TYPE,
    Recorder,
    RecordError,
    format_time,
)
from tools.demo.storyboard import record
from tools.interface_check.rosbridge import Rosbridge, RosbridgeError
from tools.soak.app import override_script
from tools.soak.cdp import CdpError, HeadlessChrome, Page, page_ws_url

# 目标平板的 CSS 尺寸和像素比（需求 12.1）。像素比用启动参数设置：用 Emulation 模拟像素比时，
# Chrome 把较慢的触摸移动事件的坐标多除了一次像素比，单指拖动会变成斜着转
CHROME_ARGS = ["--force-device-scale-factor=1.5", "--window-size=1280,900"]
WIDTH, HEIGHT = 1280, 800


def encode(frames: Path, output: Path, fps: int) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-framerate",
            str(fps),
            "-i",
            str(frames / "%05d.jpg"),
            "-c:v",
            "libx264",
            "-preset",
            "slow",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(output),
        ],
        check=True,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m tools.demo",
        description="录制演示视频：按分镜逐帧录制 APP 的完整工作流程，编码为 MP4。",
    )
    parser.add_argument("--url", required=True, help="开发模式构建的 APP 地址")
    parser.add_argument("--rosbridge", default="ws://127.0.0.1:9090", help="开发环境的 rosbridge")
    parser.add_argument("--http", default="http://127.0.0.1:8080", help="开发环境的文件服务")
    parser.add_argument("--out", type=Path, default=Path("demo-output"), help="输出目录")
    parser.add_argument("--fps", type=int, default=30, help="帧率（默认 30）")
    parser.add_argument(
        "--frame-seconds",
        type=float,
        default=1.0,
        help="每帧占用的真实时间，秒（默认 1）；应大于本机绘制并截取一帧的时间",
    )
    parser.add_argument("--quality", type=int, default=92, help="截图的 JPEG 质量（默认 92）")
    parser.add_argument(
        "--arrow-spacing",
        type=float,
        default=0.05,
        help="写入覆盖配置的路径方向箭头间距，米（默认 0.05，适合约 15 厘米的工件；APP 默认 0.16）",
    )
    parser.add_argument("--port", type=int, default=9393, help="本机 Chrome 的调试端口")
    args = parser.parse_args(argv)
    if not shutil.which("ffmpeg"):
        print("找不到 ffmpeg，请先安装（例如 sudo apt install ffmpeg）", file=sys.stderr)
        return 1

    frames = args.out / "frames"
    shutil.rmtree(frames, ignore_errors=True)
    frames.mkdir(parents=True)
    try:
        mock = Rosbridge(args.rosbridge)
    except (RosbridgeError, OSError) as error:
        print(f"无法连接 {args.rosbridge}：{error}", file=sys.stderr)
        return 1
    chrome = HeadlessChrome(port=args.port, extra_args=CHROME_ARGS)
    started = time.monotonic()
    try:
        page = Page(page_ws_url(chrome.endpoint))
        for domain in ("Page", "Runtime", "Inspector"):
            page.call(f"{domain}.enable")
        page.call(
            "Emulation.setDeviceMetricsOverride",
            width=WIDTH,
            height=HEIGHT,
            deviceScaleFactor=0,
            mobile=False,
        )
        page.call("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)
        page.call("Page.addScriptToEvaluateOnNewDocument", source=CLOCK_JS)
        scene = {"path_arrow_spacing_m": args.arrow_spacing}
        page.call(
            "Page.addScriptToEvaluateOnNewDocument",
            source=override_script(args.rosbridge, args.http, scene),
        )
        page.call("Page.navigate", url=args.url)
        page.wait("window.__demo && document.readyState === 'complete'", 30)
        rec = Recorder(
            page,
            frames,
            mock,
            fps=args.fps,
            frame_seconds=args.frame_seconds,
            quality=args.quality,
        )
        rec.start()
        try:
            record(rec)
        except (RecordError, CdpError) as error:
            page.screenshot(args.out / "failed.png")
            print(f"录制失败（{format_time(rec.video_time)}）：{error}", file=sys.stderr)
            return 1
        finally:
            # mock 恢复真实节奏
            mock.call(
                INJECT_SERVICE, INJECT_TYPE, {"action": "speed", "args": json.dumps({"factor": 1})}
            )
    finally:
        chrome.close()
        mock.close()

    timeline = "\n".join(f"{format_time(t)} {title}" for t, title in rec.timeline)
    (args.out / "timeline.txt").write_text(timeline + "\n", encoding="utf-8")
    output = args.out / "spatialview-demo.mp4"
    encode(frames, output, args.fps)
    work = sorted(rec.work)
    print(
        f"已写入 {output}：{rec.count} 帧，{format_time(rec.video_time)}；"
        f"录制用时 {(time.monotonic() - started) / 60:.0f} 分钟。每帧绘制和截图的耗时："
        f"95% 分位 {work[int(len(work) * 0.95)]:.2f} 秒，最长 {work[-1]:.2f} 秒；"
        f"{rec.overruns} 帧超过 {args.frame_seconds} 秒"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
