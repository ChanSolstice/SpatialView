"""网页版压缩包的交付前检查（阶段规划 4.4）。

解压后用启动脚本打开页面，连接本机开发环境的 mock 服务端，用真实的鼠标事件逐项检查，最后关闭浏览器。
需要 mock 的故障注入：连续扩展、部分无法规划、执行出错和执行加速。只从界面和服务端状态判断，
不依赖开发版的调试接口。
"""

from __future__ import annotations

import base64
import gzip
import json
import os
import re
import signal
import socket
import subprocess
import tarfile
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import websocket

from tools.interface_check.contract import load as load_contract
from tools.interface_check.rosbridge import Rosbridge
from tools.soak.app import AppDriver
from tools.soak.cdp import Page, page_ws_url
from tools.validate.model import validate_model
from tools.web_check.png import decode_png, range_colors

PREFIX = "spatialview_msgs/srv/"
INJECT = ("/spatialview_mock/inject", "spatialview_mock_msgs/srv/Inject")
ARCHIVE_NAME = re.compile(r"^spatialview-web-(\d+\.\d+\.\d+)\.tar\.gz$")
MIN_MEMORY_MB = 500
TASK_SPEED = 20  # 连续清洗时 mock 的执行加速倍率
EXPANDED_TITLE = "规划范围已扩展"
PARTIAL_TITLE = "部分路径未能规划"

# 页面状态中用到的表达式
ENTRY = "document.querySelector('.dlg[aria-label=工程入口]')"
SET_INPUT = """((el, value) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})"""
FIELD = (
    "[...document.querySelectorAll('.eng-field')].find((f) => f.textContent.startsWith({}))"
    ".querySelector('input')"
)


def package_version(archive: Path) -> str:
    """压缩包名中的 APP 版本（scripts/build-web.sh 的命名）。"""
    match = ARCHIVE_NAME.match(archive.name)
    if not match:
        raise ValueError(f"压缩包名应为 spatialview-web-<版本>.tar.gz：{archive.name}")
    return match.group(1)


def range_lines(plan: dict) -> tuple[list[str], int, int]:
    """规划加载后对规划范围的说明（需求 5.5），以及扩展的和没有生成路径的表面数。"""
    selected, scope = plan["selected_surface_ids"], plan["planning_scope_surface_ids"]
    traced = set(plan["surface_ids"])
    expanded = len(scope) - len(selected)
    untraced = sum(1 for s in scope if s not in traced)
    lines = []
    if expanded > 0:
        lines.append(
            f"规划范围按连续曲面从选择的 {len(selected)} 个表面扩展到 {len(scope)} 个，"
            '点击"选面"可以查看，扩展的表面为浅蓝色。'
        )
    if untraced > 0:
        lines.append(f"其中 {untraced} 个表面没有生成路径，选面时以红色边框标出。")
    return lines, expanded, untraced


def toolbar_range(expanded: int, untraced: int) -> str:
    """选面工具条第二行的 textContent：为 0 的一项不显示，都为 0 时没有第二行。"""
    parts = [f"扩展 {expanded} 个"] if expanded else []
    if untraced:
        parts.append(f"未生成路径 {untraced} 个")
    return "当前规划：" + "".join(parts) if parts else ""


def dialog_parts(text: str) -> list[str]:
    """提示框 innerText 按行分开，去掉最后的"确定"按钮。"""
    parts = [p for p in text.split(" | ") if p]
    return parts[:-1] if parts and parts[-1] == "确定" else parts


def available_memory_mb() -> int:
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) // 1024
    return 0


@dataclass
class Options:
    archive: Path
    out: Path
    password_file: Path
    rosbridge: str = "ws://127.0.0.1:9090"
    http: str = "http://127.0.0.1:8080"
    page_port: int = 8093
    cdp_port: int = 9397
    animation: bool = True


class CheckError(RuntimeError):
    """检查无法继续。"""


class WebCheck:
    def __init__(self, options: Options) -> None:
        self.o = options
        self.version = package_version(options.archive)
        self.interface_version = load_contract().interface_version
        self.results: list[tuple[str, bool, str]] = []
        self.page: Page | None = None
        self.app: AppDriver | None = None
        self.proc: subprocess.Popen | None = None
        self.bridge: Rosbridge | None = None
        # 各项检查之间传递的数量：第一次选择的表面数、改动后的选择、规划范围的数量、红色和浅蓝的基准
        self.picked = self.current = self.expanded = self.untraced = 0
        self.full_red = self.red0 = self.blue0 = 0

    # ------------------------------------------------------------------ 记录

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.results.append((name, bool(ok), detail))
        print(("通过  " if ok else "失败  ") + name + (f"：{detail}" if detail else ""), flush=True)
        return bool(ok)

    def memory_guard(self, step: str) -> None:
        available = available_memory_mb()
        print(f"  [{step}] 可用内存 {available} MB", flush=True)
        if available < MIN_MEMORY_MB:
            raise CheckError(f"{step}前可用内存只有 {available} MB，停止检查")

    # ------------------------------------------------------------------ 服务端

    def server_state(self) -> dict:
        return self.bridge.call("/spatialview/get_system_state", PREFIX + "GetSystemState")[0][
            "state"
        ]

    def inject(self, action: str, **args) -> None:
        reply = self.bridge.call(*INJECT, {"action": action, "args": json.dumps(args)})[0]
        print(f"  注入 {action} {args} → {reply}", flush=True)
        if not reply.get("ok"):
            raise CheckError(f"mock 拒绝注入 {action}：{reply.get('message')}")

    def fetch(self, url_path: str) -> bytes:
        request = urllib.request.Request(
            self.o.http + url_path, headers={"Accept-Encoding": "gzip"}
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read()
            gzipped = response.headers.get("Content-Encoding") == "gzip"
        return gzip.decompress(data) if gzipped else data

    def plan_file(self) -> dict:
        return json.loads(self.fetch(self.server_state()["plan_url"]))

    def selectable_count(self) -> int:
        _, info = validate_model(self.fetch(self.server_state()["model_url"]))
        if info is None:
            raise CheckError("无法读取当前模型")
        return sum(1 for selectable in info.surfaces.values() if selectable)

    # ------------------------------------------------------------------ 页面

    def mouse(self, kind: str, x: float, y: float, buttons: int = 0) -> None:
        pressed = kind != "mouseMoved"
        self.page.call(
            "Input.dispatchMouseEvent",
            type=kind,
            x=x,
            y=y,
            buttons=buttons,
            button="left" if pressed else "none",
            clickCount=int(pressed),
        )

    def hold(self, selector: str, seconds: float) -> None:
        x, y, w, h = self.app.rect(selector)
        cx, cy = x + w / 2, y + h / 2
        self.mouse("mouseMoved", cx, cy)
        self.mouse("mousePressed", cx, cy, 1)
        time.sleep(seconds)
        self.mouse("mouseReleased", cx, cy)

    def set_input(self, element: str, value: str) -> None:
        self.page.eval(f"{SET_INPUT}({element}, {json.dumps(value)})")

    def scene_colors(self, name: str) -> tuple[int, int]:
        """三维区截图（保存为 name.png）中红色边框和浅蓝色的像素数。"""
        left, top, width, height = self.app.rect("[data-testid=scene]")
        clip = {"x": left, "y": top, "width": width, "height": height, "scale": 1}
        data = base64.b64decode(
            self.page.call("Page.captureScreenshot", format="png", clip=clip)["data"]
        )
        (self.o.out / f"{name}.png").write_bytes(data)
        return range_colors(decode_png(data))

    def selected_count(self) -> int:
        match = re.search(r"\d+", self.app.state()["selected"])
        return int(match.group()) if match else -1

    def plan_range_text(self) -> str:
        return self.page.eval(
            "document.querySelector('[data-testid=plan-range]')?.textContent ?? ''"
        )

    def dialog_text(self) -> str:
        return self.page.eval(
            "document.querySelector('.dlg')?.innerText.replace(/\\n+/g, ' | ') ?? ''"
        )

    def main_label(self) -> str:
        return self.page.eval("document.querySelector('[data-testid=btn-main]').textContent.trim()")

    def enter_select(self) -> None:
        self.app.press("select")
        self.app.wait_for("进入选面", lambda s: s["selecting"], timeout=10)
        time.sleep(3)

    def exit_select(self) -> None:
        self.app.tap_text("[data-testid=selection-toolbar] button", "退出选面")
        self.app.wait_for("退出选面", lambda s: not s["selecting"], timeout=10)

    def start_plan(self) -> None:
        self.app.answer_confirm("开始规划", self.app.press("plan"))
        self.app.wait_for(
            "开始规划",
            lambda s: s["phase"] in ("规划中", "规划就绪"),
            timeout=30,
            fail_on_dialog=False,
        )

    def wait_result_dialog(self, what: str, timeout: float = 90) -> dict:
        return self.app.wait_for(
            what,
            lambda s: bool(s["dialog"]) and not s["dialog"]["confirm"],
            timeout=timeout,
            fail_on_dialog=False,
        )

    def wait_plan_loaded(self) -> None:
        self.app.wait_for(
            "加载规划", lambda s: s["enabled"]["animate"] and not s["dialog"], timeout=90
        )

    # ------------------------------------------------------------------ 运行

    def run(self) -> bool:
        o = self.o
        o.out.mkdir(parents=True, exist_ok=True)
        try:
            self.memory_guard("启动")
            package = self.extract()
            self.proc = self.start(package)
            self.bridge = Rosbridge(o.rosbridge)
            self.page = Page(page_ws_url(f"http://127.0.0.1:{o.cdp_port}", timeout=30))
            for domain in ("Page", "Runtime", "Inspector"):
                self.page.call(f"{domain}.enable")
            self.app = AppDriver(self.page, timeout=300)
            self.page.wait("document.querySelector('.eng-hold')", 60)
            self.check(
                "启动脚本打开页面，页面为安全上下文",
                self.page.eval("window.isSecureContext") is True,
            )
            baseline = self.engineering()
            self.full_plan(baseline)
            self.expanded_plan()
            self.partial_plan()
            self.reload()
            self.interrupted_task()
            self.repeated_tasks()
            if o.animation:
                self.animation()
            self.check(
                "页面没有未捕获的异常", not self.page.exceptions, "；".join(self.page.exceptions)
            )
        except Exception as error:  # noqa: BLE001  检查中断也要关闭浏览器、写出结果
            self.check("检查中断", False, repr(error))
            try:
                self.page.screenshot(o.out / "failed.png")
            except Exception:  # noqa: BLE001
                pass
        finally:
            self.cleanup()
        failed = [name for name, ok, _ in self.results if not ok]
        print(f"共 {len(self.results)} 项，失败 {len(failed)} 项", failed or "", flush=True)
        (o.out / "results.json").write_text(
            json.dumps(
                {
                    "archive": str(o.archive),
                    "version": self.version,
                    "checks": [{"name": n, "ok": ok, "detail": d} for n, ok, d in self.results],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        return not failed

    def extract(self) -> Path:
        package = self.o.out / self.o.archive.name.removesuffix(".tar.gz")
        if package.exists():
            # 解压目录中的 profile 保存着上次在工程入口中设置的地址，检查要从新解压的开始
            raise CheckError(f"{package} 已经存在，请换一个输出目录或先删除它")
        with tarfile.open(self.o.archive) as tar:
            tar.extractall(self.o.out, filter="data")
        if not (package / "start.sh").is_file():
            raise CheckError(f"压缩包中没有 {package.name}/start.sh")
        return package

    def start(self, package: Path) -> subprocess.Popen:
        env = {k: v for k, v in os.environ.items() if k != "DBUS_SESSION_BUS_ADDRESS"}
        env["SPATIALVIEW_PORT"] = str(self.o.page_port)
        log = open(self.o.out / "start.log", "w")  # noqa: SIM115  随启动脚本的进程一直打开
        return subprocess.Popen(
            [
                str(package / "start.sh"),
                "--headless=new",
                f"--remote-debugging-port={self.o.cdp_port}",
                "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding",
            ],
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    def cleanup(self) -> None:
        if self.bridge is not None:
            try:
                self.inject("speed", factor=1)
            except Exception as error:  # noqa: BLE001
                print(f"  恢复 mock 的执行倍率失败：{error!r}", flush=True)
            self.bridge.close()
        if self.proc is None:
            return
        try:
            url = f"http://127.0.0.1:{self.o.cdp_port}/json/version"
            with urllib.request.urlopen(url, timeout=5) as response:
                ws = websocket.create_connection(
                    json.load(response)["webSocketDebuggerUrl"], suppress_origin=True, timeout=10
                )
            ws.send(json.dumps({"id": 1, "method": "Browser.close"}))
            self.proc.wait(30)
            self.check("关闭浏览器后启动脚本退出", True)
        except Exception as error:  # noqa: BLE001
            self.check("关闭浏览器后启动脚本退出", False, repr(error))
            os.killpg(self.proc.pid, signal.SIGTERM)
        time.sleep(1)
        with socket.socket() as s:
            self.check("页面服务停止", s.connect_ex(("127.0.0.1", self.o.page_port)) != 0)

    # ------------------------------------------------------------------ 各项检查

    def engineering(self) -> str:
        """工程入口：长按时间、密码、版本号，把地址改为本机开发环境。返回连接后的告警文字。"""
        page, app = self.page, self.app
        self.hold(".eng-hold", 2.0)
        time.sleep(1)
        self.check("工程入口长按 2 秒不弹出", not page.eval(f"!!{ENTRY}"))
        self.hold(".eng-hold", 5.6)
        page.wait(ENTRY, 5)
        self.set_input("document.querySelector('input[aria-label=密码]')", "000000")
        app.tap(".dlg .dbtn.primary")
        page.wait("document.querySelector('.eng-error')", 10)
        self.check("错误密码被拒绝", True)
        password = self.o.password_file.read_text(encoding="utf-8").strip()
        self.set_input("document.querySelector('input[aria-label=密码]')", password)
        app.tap(".dlg .dbtn.primary")
        page.wait("document.querySelector('[data-testid=engineering-panel]')", 10)
        foot = page.eval("document.querySelector('.eng-foot').textContent")
        self.check(
            f"面板显示 APP 版本 {self.version}、期望接口版本 {self.interface_version}",
            f"APP 版本 {self.version}" in foot and f"期望接口版本 {self.interface_version}" in foot,
            foot,
        )
        config = json.loads(page.eval("document.querySelector('.eng-json').value"))
        integration = config.get("integration")
        self.check(
            "默认配置把激光器视为已连接",
            integration == {"assume_laser_connected": True},
            json.dumps(integration),
        )
        self.set_input(FIELD.format(json.dumps("ROSbridge")), self.o.rosbridge)
        self.set_input(FIELD.format(json.dumps("HTTP")), self.o.http)
        app.tap_text(".eng-actions button", "保存")  # 保存后页面按新配置重新加载
        time.sleep(3)
        baseline = app.wait_ready()["alarms"]
        self.check("地址改为本机开发环境，保存后重新加载并连接", True)
        return baseline

    def full_plan(self, baseline: str) -> None:
        """扫描后选几个表面规划，全部成功、没有扩展：不弹框，选面时没有规划范围。"""
        self.memory_guard("扫描")
        self.app.scan(baseline)
        self.memory_guard("规划")
        self.picked = self.app.plan(baseline)["selected"]
        time.sleep(3)
        self.full_red, _ = self.scene_colors("1-full-plan")
        plan = self.plan_file()
        self.check(
            "全部规划成功：有效选择、规划范围与 surface_ids 相同，没有失败路径和红色路径",
            plan["selected_surface_ids"]
            == plan["planning_scope_surface_ids"]
            == plan["surface_ids"]
            and len(plan["selected_surface_ids"]) == self.picked
            and "failed_paths" not in plan
            and self.full_red < 300,
            f"选了 {self.picked} 个；红色像素 {self.full_red}",
        )
        self.enter_select()
        self.red0, self.blue0 = self.scene_colors("2-select-no-range")
        self.check(
            "选面：预先选中这次的选择，工具条不显示规划范围",
            self.selected_count() == self.picked and self.plan_range_text() == "",
            f"{self.app.state()['selected']}；红 {self.red0}，浅蓝 {self.blue0}",
        )

    def expanded_plan(self) -> None:
        """去掉一个表面后规划，注入扩展 1 个：规划成功，弹出"规划范围已扩展"。"""
        self.memory_guard("扩展")
        self.app.tap("[data-testid=scene]", 0.5, 0.5)
        time.sleep(1)
        self.current = self.selected_count()
        self.check("点选改变了选择", self.current != self.picked, f"{self.picked} → {self.current}")
        self.exit_select()
        self.inject("plan_expand", count=1)
        self.start_plan()
        s = self.wait_result_dialog(EXPANDED_TITLE)
        time.sleep(1)
        text, plan = self.dialog_text(), self.plan_file()
        lines, expanded, untraced = range_lines(plan)
        self.page.screenshot(self.o.out / "3-expanded-dialog.png")
        self.check(
            "规划文件的有效选择为当前的选择，规划范围多 1 个",
            len(plan["selected_surface_ids"]) == self.current and expanded == 1 and untraced == 0,
            f"有效选择 {len(plan['selected_surface_ids'])}，扩展 {expanded}，未生成路径 {untraced}",
        )
        self.check(
            f"提示框为{EXPANDED_TITLE}，说明扩展的数量",
            s["dialog"]["title"] == EXPANDED_TITLE and len(lines) == 1 and lines[0] in text,
            text,
        )
        self.app.tap(".dlg .dbtn.primary")
        time.sleep(2)
        self.check("没有其他提示框", not self.app.state()["dialog"], self.dialog_text())
        self.wait_plan_loaded()
        self.enter_select()
        _, blue1 = self.scene_colors("4-select-expanded")
        self.check(
            "选面：预先选中有效选择，不选中扩展进来的表面；工具条显示扩展 1 个",
            self.selected_count() == self.current and self.plan_range_text() == toolbar_range(1, 0),
            f"{self.app.state()['selected']}；{self.plan_range_text()}",
        )
        self.check(
            "扩展进来的表面为浅蓝色", blue1 > self.blue0 + 300, f"浅蓝像素 {self.blue0} → {blue1}"
        )

    def partial_plan(self) -> None:
        """扩展到全部可清洗表面，同时部分无法规划：说明加在"部分路径未能规划"中，不另外弹框。"""
        self.memory_guard("部分规划")
        self.exit_select()
        selectable = self.selectable_count()
        self.inject("plan_expand", count=selectable)
        self.inject("plan_partial", keep=self.current + 2)
        self.start_plan()
        self.wait_result_dialog("部分规划")
        self.app.wait_for(
            "规划范围的说明",
            lambda s: "规划范围按连续曲面" in ((s["dialog"] or {}).get("text") or ""),
            timeout=60,
            fail_on_dialog=False,
        )
        time.sleep(1)
        text, plan = self.dialog_text(), self.plan_file()
        lines, self.expanded, self.untraced = range_lines(plan)
        self.page.screenshot(self.o.out / "5-partial-dialog.png")
        self.check(
            f"规划文件：有效选择仍为当前的选择，规划范围为全部 {selectable} 个可清洗表面，带 2 段失败路径",
            len(plan["selected_surface_ids"]) == self.current
            and len(plan["planning_scope_surface_ids"]) == selectable
            and len(plan.get("failed_paths", [])) == 2,
            f"扩展 {self.expanded}，未生成路径 {self.untraced}",
        )
        parts = dialog_parts(text)
        self.check(
            f"提示框为{PARTIAL_TITLE}：原因、说明、两行规划范围、PLAN_PARTIAL",
            text.startswith(PARTIAL_TITLE)
            and len(lines) == 2
            and parts[-3:-1] == lines
            and parts[-1] == "PLAN_PARTIAL",
            text,
        )
        self.app.tap(".dlg .dbtn.primary")
        time.sleep(3)
        self.check(
            f"关闭后没有另外的{EXPANDED_TITLE}提示框",
            not self.app.state()["dialog"],
            self.dialog_text(),
        )
        self.wait_plan_loaded()
        time.sleep(2)
        partial_red, _ = self.scene_colors("6-partial-plan")
        self.check(
            "浏览时失败路径为红色",
            partial_red > self.full_red + 500,
            f"红色像素 {self.full_red} → {partial_red}",
        )
        self.enter_select()
        red2, blue2 = self.scene_colors("7-select-partial")
        self.check(
            "选面：预先选中有效选择；工具条显示扩展和未生成路径的数量",
            self.selected_count() == self.current
            and self.plan_range_text() == toolbar_range(self.expanded, self.untraced),
            f"{self.app.state()['selected']}；{self.plan_range_text()}",
        )
        self.check(
            "没有生成路径的表面有红色边框，扩展的表面为浅蓝色",
            red2 > self.red0 + 300 and blue2 > self.blue0 + 300,
            f"红 {self.red0} → {red2}，浅蓝 {self.blue0} → {blue2}",
        )
        self.check_toolbar_clear()
        self.exit_select()

    def check_toolbar_clear(self) -> None:
        """工具条不挡住右上角的"恢复默认视角"。"""
        boxes = self.page.eval(
            "(() => { const box = (e) => { const r = e?.getBoundingClientRect(); "
            "return r ? [r.left, r.top, r.right, r.bottom] : null }; "
            "return [box(document.querySelector('[data-testid=selection-toolbar]')), "
            "box(document.querySelector('.view-reset'))] })()"
        )
        toolbar, reset = boxes
        clear = (
            toolbar is not None
            and reset is not None
            and (
                toolbar[2] <= reset[0]
                or reset[2] <= toolbar[0]
                or toolbar[3] <= reset[1]
                or reset[3] <= toolbar[1]
            )
        )
        self.check("工具条不挡住恢复默认视角", clear, f"工具条 {toolbar}，按钮 {reset}")

    def reload(self) -> None:
        """重新打开页面：已有的规划不再说明，选面时仍显示规划范围。"""
        self.memory_guard("重新加载")
        self.page.call("Page.reload")
        time.sleep(3)
        self.app.wait_ready()
        self.app.wait_for(
            "加载规划", lambda s: s["enabled"]["animate"], timeout=90, fail_on_dialog=False
        )
        time.sleep(4)
        self.check(
            "重新打开后不弹出规划范围的提示", not self.app.state()["dialog"], self.dialog_text()
        )
        self.enter_select()
        self.check(
            "重新打开后选面仍显示规划范围",
            self.plan_range_text() == toolbar_range(self.expanded, self.untraced)
            and self.selected_count() == self.current,
            self.plan_range_text(),
        )
        self.page.screenshot(self.o.out / "8-reloaded-select.png")
        self.exit_select()

    def interrupted_task(self) -> None:
        """清洗中执行出错：停在已暂停，保留规划和进度；确认后从中断处继续；停止后回到规划就绪。"""
        self.memory_guard("清洗")
        app = self.app
        plan_id = self.server_state()["plan_id"]
        app.answer_confirm("开始清洗", app.press("main"))
        app.wait_for("执行中", lambda s: s["phase"] == "执行中", timeout=30)
        time.sleep(3)
        self.inject("task_error", detail="模拟执行出错")
        self.wait_result_dialog("中断", timeout=20)
        time.sleep(1)
        text, st = self.dialog_text(), self.server_state()
        breakpoint_s = st["exec_time"]
        self.page.screenshot(self.o.out / "9-interrupted.png")
        self.check(
            "执行出错后停在已暂停，规划和执行进度保留",
            st["phase"] == "PAUSED"
            and st["plan_id"] == plan_id
            and breakpoint_s > 1
            and app.state()["phase"] == "已暂停",
            f"{st['phase']}，exec_time {breakpoint_s:.1f} 秒",
        )
        self.check(
            "提示框为清洗已中断，带继续或停止的操作提示",
            text.startswith("清洗已中断")
            and "模拟执行出错" in text
            and '点击"继续"' in text
            and "DEVICE_ERROR" in text,
            text,
        )
        app.tap(".dlg .dbtn.primary")
        app.wait_for("关闭提示框", lambda s: not s["dialog"], timeout=10)
        paused_red, _ = self.scene_colors("10-paused")
        self.check(
            "主按钮为继续，失败路径仍为红色",
            self.main_label() == "继续" and paused_red > self.full_red + 500,
            f"{self.main_label()}；红色像素 {paused_red}",
        )
        app.press("main")
        app.wait_for("继续确认", lambda s: bool(s["dialog"] and s["dialog"]["confirm"]), timeout=10)
        text = self.dialog_text()
        self.check("继续需要确认，说明从暂停处继续", "从暂停处继续" in text, text)
        app.tap(".dlg .dbtn.primary")
        app.wait_for("继续", lambda s: s["phase"] == "执行中", timeout=30)
        time.sleep(3)
        st = self.server_state()
        self.check(
            "继续后从中断处接着执行",
            st["phase"] == "EXECUTING" and st["exec_time"] > breakpoint_s + 1,
            f"exec_time {breakpoint_s:.1f} → {st['exec_time']:.1f} 秒",
        )
        app.answer_confirm("停止", app.press("stop"))
        app.wait_for("停止", lambda s: s["phase"] == "规划就绪", timeout=60, fail_on_dialog=False)
        closed = app.close_dialogs()
        app.wait_for("按钮可用", lambda s: s["enabled"]["main"], timeout=15, fail_on_dialog=False)
        st = self.server_state()
        self.check(
            "停止后回到规划就绪，规划仍在，可以再次开始清洗",
            st["plan_id"] == plan_id
            and app.state()["enabled"]["animate"]
            and self.main_label() == "开始清洗",
            f"提示框 {closed}",
        )

    def repeated_tasks(self) -> None:
        """同一规划连续清洗两次到完成：每次完成后回到规划就绪，开始清洗、轨迹动画仍可用（接口 6.5）。"""
        app = self.app
        self.inject("speed", factor=TASK_SPEED)
        plan_id = self.server_state()["plan_id"]
        for run in (1, 2):
            self.memory_guard(f"第 {run} 次清洗")
            before = self.server_state()["last_result"]["id"]
            app.answer_confirm("开始清洗", app.press("main"))
            deadline = time.time() + 300
            while True:
                st = self.server_state()
                result = st["last_result"]
                if (
                    result["id"] != before
                    and result["operation"] == "TASK"
                    and st["phase"] == "PLAN_READY"
                ):
                    break
                if time.time() > deadline:
                    raise CheckError(f"第 {run} 次清洗没有完成：{st['phase']} {result}")
                time.sleep(0.3)
            s = app.wait_for(
                "回到规划就绪",
                lambda s: s["phase"] == "规划就绪" and bool(s["dialog"]),
                timeout=30,
                fail_on_dialog=False,
            )
            title = s["dialog"]["title"]
            app.close_dialogs()
            s = app.wait_for(
                "按钮可用",
                lambda s: s["enabled"]["main"] and s["enabled"]["animate"],
                timeout=15,
                fail_on_dialog=False,
            )
            self.check(
                f"第 {run} 次清洗完成后回到规划就绪，开始清洗、轨迹动画可用",
                result["result"] == "SUCCEEDED"
                and title == "清洗完成"
                and st["plan_id"] == plan_id
                and self.main_label() == "开始清洗",
                f"{result['result']}，提示框「{title}」",
            )
        self.inject("speed", factor=1)

    def animation(self) -> None:
        """轨迹动画：播放、拖到结尾播完、重新播放、退出；再次进入时从头播放。"""
        self.memory_guard("轨迹动画")
        app = self.app
        app.animate(play_seconds=2, tail_seconds=3)
        app.press("animate")
        s = app.wait_for(
            "再次进入轨迹动画",
            lambda s: s["playbar"] is not None and s["playbar"]["playing"],
            timeout=10,
        )
        self.check(
            "轨迹动画播完后可以重新播放，退出后再次进入从头播放",
            s["playbar"]["time"] < s["playbar"]["duration"],
            json.dumps(s["playbar"]),
        )
        app.tap_text(".playbar button", "退出")
        app.wait_for("退出轨迹动画", lambda s: s["playbar"] is None, timeout=10)
