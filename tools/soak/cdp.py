"""最小的 Chrome DevTools Protocol 客户端：连接 APP 所在的页面，执行脚本，读取性能指标，发送真实的鼠标事件。

可以启动本机的无头 Chrome，也可以连接已有的 CDP 端点，例如用 adb forward 转发的平板 WebView：
adb forward tcp:9222 localabstract:webview_devtools_remote_<进程号>
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

import websocket


class CdpError(RuntimeError):
    pass


class Page:
    def __init__(self, ws_url: str) -> None:
        self.ws = websocket.create_connection(ws_url, suppress_origin=True, timeout=30)
        self.next_id = 0
        self.crashed = False
        # 页面中未捕获的异常（需要先 Runtime.enable）
        self.exceptions: list[str] = []

    def call(self, method: str, timeout: float = 60, **params):
        self.next_id += 1
        call_id = self.next_id
        self.ws.send(json.dumps({"id": call_id, "method": method, "params": params}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            message = json.loads(self.ws.recv())
            if "method" in message:
                self._event(message["method"], message.get("params", {}))
            if message.get("id") == call_id:
                if "error" in message:
                    raise CdpError(f"{method}：{message['error']}")
                return message.get("result", {})
        raise CdpError(f"{method} 没有回复")

    def _event(self, method: str, params: dict) -> None:
        if method == "Inspector.targetCrashed":
            self.crashed = True
        elif method == "Runtime.exceptionThrown":
            details = params.get("exceptionDetails", {})
            self.exceptions.append(
                details.get("exception", {}).get("description") or details.get("text", "")
            )

    def eval(self, expression: str):
        result = self.call(
            "Runtime.evaluate", expression=expression, returnByValue=True, awaitPromise=True
        )
        if "exceptionDetails" in result:
            details = result["exceptionDetails"]
            raise CdpError(details.get("exception", {}).get("description") or details.get("text"))
        return result["result"].get("value")

    def wait(self, expression: str, timeout: float) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.eval(f"!!({expression})"):
                return
            time.sleep(0.2)
        raise TimeoutError(f"等待超时：{expression}")

    def tap(self, x: float, y: float) -> None:
        for kind, buttons in (("mouseMoved", 0), ("mousePressed", 1), ("mouseReleased", 0)):
            self.call(
                "Input.dispatchMouseEvent",
                type=kind,
                x=x,
                y=y,
                button="none" if kind == "mouseMoved" else "left",
                buttons=buttons,
                clickCount=0 if kind == "mouseMoved" else 1,
            )

    def screenshot(self, path: Path) -> None:
        data = self.call("Page.captureScreenshot", format="png")["data"]
        path.write_bytes(base64.b64decode(data))

    def close(self) -> None:
        self.ws.close()


def page_ws_url(endpoint: str, timeout: float = 15) -> str:
    """CDP 端点（http://主机:端口）中第一个页面的 WebSocket 地址。"""
    deadline = time.time() + timeout
    while True:
        try:
            with urllib.request.urlopen(f"{endpoint}/json", timeout=5) as response:
                targets = json.load(response)
            pages = [t for t in targets if t.get("type") == "page"]
            if pages:
                return pages[0]["webSocketDebuggerUrl"]
        except OSError:
            pass
        if time.time() > deadline:
            raise CdpError(f"{endpoint} 上没有可连接的页面")
        time.sleep(0.3)


class HeadlessChrome:
    """本机的无头 Chrome，用 SwiftShader 软件渲染 WebGL。页面尺寸由调用方用 Emulation 设置。"""

    def __init__(self, port: int = 9399) -> None:
        chrome = shutil.which("google-chrome") or shutil.which("chromium")
        if not chrome:
            raise CdpError("找不到 google-chrome 或 chromium")
        self.profile = tempfile.mkdtemp(prefix="spatialview-soak-")
        env = {k: v for k, v in os.environ.items() if k != "DBUS_SESSION_BUS_ADDRESS"}
        self.process = subprocess.Popen(
            [
                chrome,
                "--headless=new",
                f"--remote-debugging-port={port}",
                f"--user-data-dir={self.profile}",
                "--enable-unsafe-swiftshader",
                # 长时间运行时不降低定时器和渲染的优先级
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--no-first-run",
                "--window-size=1280,800",
                "about:blank",
            ],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.endpoint = f"http://127.0.0.1:{port}"
        self.pid = self.process.pid

    def close(self) -> None:
        self.process.terminate()
        try:
            self.process.wait(10)
        except subprocess.TimeoutExpired:
            self.process.kill()
        shutil.rmtree(self.profile, ignore_errors=True)
