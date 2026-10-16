"""最小的 rosbridge v2 客户端：订阅 Topic、调用 Service（接口文档附录 A 的 JSON 协议）。"""

from __future__ import annotations

import itertools
import json
import threading
import time
from collections.abc import Callable

import websocket


class RosbridgeError(RuntimeError):
    """连接失败、调用超时，或 rosbridge 返回调用失败（"result": false）。"""


class Rosbridge:
    def __init__(self, url: str, timeout: float = 5.0) -> None:
        self.url = url
        try:
            self.ws = websocket.create_connection(url, timeout=timeout)
        except (OSError, websocket.WebSocketException) as exc:
            raise RosbridgeError(f"无法连接 {url}：{exc}") from exc
        self.ws.settimeout(None)
        self._ids = itertools.count(1)
        self._pending: dict[str, tuple[threading.Event, list]] = {}
        self._subscribers: dict[str, list[Callable[[dict], None]]] = {}
        self._lock = threading.Lock()
        self._closed = False
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def _read(self) -> None:
        while not self._closed:
            try:
                raw = self.ws.recv()
            except (OSError, websocket.WebSocketException):
                break
            if not raw:
                break
            message = json.loads(raw)
            op = message.get("op")
            if op == "service_response":
                with self._lock:
                    waiter = self._pending.pop(message.get("id", ""), None)
                if waiter is not None:
                    event, box = waiter
                    box.append(message)
                    event.set()
            elif op == "publish":
                for callback in list(self._subscribers.get(message.get("topic", ""), [])):
                    callback(message["msg"])

    def _send(self, payload: dict) -> None:
        self.ws.send(json.dumps(payload, ensure_ascii=False))

    def call(self, service: str, service_type: str, args: dict | None = None, timeout: float = 5.0):
        """调用 Service，返回 (values, 耗时秒)。rosbridge 层面失败时抛出 RosbridgeError。"""
        call_id = f"call_service:{service}:{next(self._ids)}"
        event, box = threading.Event(), []
        with self._lock:
            self._pending[call_id] = (event, box)
        started = time.monotonic()
        self._send(
            {
                "op": "call_service",
                "id": call_id,
                "service": service,
                "type": service_type,
                "args": args or {},
            }
        )
        if not event.wait(timeout):
            with self._lock:
                self._pending.pop(call_id, None)
            raise RosbridgeError(f"调用 {service} 超过 {timeout} 秒没有回复")
        elapsed = time.monotonic() - started
        response = box[0]
        if not response.get("result", False):
            raise RosbridgeError(f"调用 {service} 失败：{response.get('values')}")
        return response.get("values"), elapsed

    def subscribe(self, topic: str, message_type: str, callback: Callable[[dict], None]) -> None:
        self._subscribers.setdefault(topic, []).append(callback)
        self._send({"op": "subscribe", "topic": topic, "type": message_type})

    def collect(self, topic: str, message_type: str, seconds: float) -> list[tuple[float, dict]]:
        """订阅一段时间，返回 (收到的时刻, 消息) 列表。"""
        received: list[tuple[float, dict]] = []
        self.subscribe(topic, message_type, lambda m: received.append((time.monotonic(), m)))
        time.sleep(seconds)
        self._subscribers[topic].clear()
        self._send({"op": "unsubscribe", "topic": topic})
        return received

    def close(self) -> None:
        self._closed = True
        try:
            self.ws.close()
        except (OSError, websocket.WebSocketException):
            pass
