"""本机 Chrome 各进程的内存（Linux 的 /proc）：按进程类型（命令行中的 --type=）累计。

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


def parse_memory_kb(smaps_rollup: str) -> int | None:
    """进程占用的内存：匿名内存和共享内存的 PSS，加上换出到交换区的部分（SwapPss）。

    不直接用 Pss：其中包括程序文件的映射（Chrome 约 80 MB），内存紧张时内核会丢弃这些页、需要时再从磁盘读回，
    数值随之起落；换出到交换区的页也不计入 Pss。内核不提供 Pss_Anon 时退回到 Pss 加 SwapPss。
    """
    fields = {}
    for line in smaps_rollup.splitlines():
        name, _, rest = line.partition(":")
        if name in ("Pss", "Pss_Anon", "Pss_Shmem", "SwapPss"):
            fields[name] = int(rest.split()[0])
    if "Pss_Anon" in fields:
        return fields["Pss_Anon"] + fields.get("Pss_Shmem", 0) + fields.get("SwapPss", 0)
    if "Pss" in fields:
        return fields["Pss"] + fields.get("SwapPss", 0)
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
    """按进程类型累计的内存（parse_memory_kb），单位 MB。"""
    totals: dict[str, float] = {}
    for pid in descendants(root, proc):
        try:
            kind = process_type((proc / str(pid) / "cmdline").read_bytes())
            used = parse_memory_kb((proc / str(pid) / "smaps_rollup").read_text())
        except OSError:
            continue
        if used is not None:
            totals[kind] = totals.get(kind, 0.0) + used / 1024
    return totals
