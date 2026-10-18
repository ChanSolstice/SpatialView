"""本机 Chrome 各进程的内存（Linux 的 /proc）：按进程类型（命令行中的 --type=）累计 PSS。

three.js 的几何体和纹理在 SwiftShader 中占用 GPU 进程的内存，类型化数组占用渲染进程的内存，
都不计入 JS 堆，所以除了 JS 堆还要看这两类进程。
"""

from __future__ import annotations

import re
from pathlib import Path

PROC = Path("/proc")


def parse_ppid(stat: str) -> int:
    """/proc/<pid>/stat 中的父进程号。格式为 "pid (comm) state ppid ..."，comm 中可能有空格和括号。"""
    return int(stat.rsplit(")", 1)[1].split()[1])


def parse_pss_kb(smaps_rollup: str) -> int | None:
    for line in smaps_rollup.splitlines():
        if line.startswith("Pss:"):
            return int(line.split()[1])
    return None


def process_type(cmdline: bytes) -> str:
    """Chrome 子进程的类型（renderer、gpu-process 等）；没有 --type= 的是浏览器主进程。

    子进程启动后会改写进程标题，/proc/<pid>/cmdline 中的参数改为用空格分隔。
    """
    for arg in re.split(rb"[\0 ]", cmdline):
        if arg.startswith(b"--type="):
            return arg[len(b"--type=") :].decode()
    return "browser"


def descendants(root: int, proc: Path = PROC) -> list[int]:
    """root 和它的全部子孙进程。"""
    children: dict[int, list[int]] = {}
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            ppid = parse_ppid((entry / "stat").read_text())
        except (OSError, ValueError, IndexError):
            continue
        children.setdefault(ppid, []).append(int(entry.name))
    found, stack = [], [root]
    while stack:
        pid = stack.pop()
        found.append(pid)
        stack.extend(children.get(pid, []))
    return found


def chrome_memory_mb(root: int, proc: Path = PROC) -> dict[str, float]:
    """按进程类型累计的 PSS，单位 MB。"""
    totals: dict[str, float] = {}
    for pid in descendants(root, proc):
        try:
            kind = process_type((proc / str(pid) / "cmdline").read_bytes())
            pss = parse_pss_kb((proc / str(pid) / "smaps_rollup").read_text())
        except OSError:
            continue
        if pss is not None:
            totals[kind] = totals.get(kind, 0.0) + pss / 1024
    return totals
