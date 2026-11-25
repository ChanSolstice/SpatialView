"""读取 Chrome 截图（PNG），统计三维区中规划范围的颜色。"""

from __future__ import annotations

import struct
import zlib

import numpy as np

SIGNATURE = b"\x89PNG\r\n\x1a\n"
CHANNELS = {2: 3, 6: 4}  # 颜色类型：RGB、RGBA


def decode_png(data: bytes) -> np.ndarray:
    """解码 8 位 RGB 或 RGBA、非隔行的 PNG（Chrome 截图的格式），返回 (高, 宽, 3) 的 uint8 数组。"""
    if not data.startswith(SIGNATURE):
        raise ValueError("不是 PNG")
    pos, idat = len(SIGNATURE), b""
    width = height = channels = 0
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos : pos + 8])
        body = data[pos + 8 : pos + 8 + length]
        if kind == b"IHDR":
            width, height, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8 or color not in CHANNELS or interlace != 0:
                raise ValueError(f"不支持的 PNG：位深 {depth}，颜色类型 {color}，隔行 {interlace}")
            channels = CHANNELS[color]
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break
        pos += 12 + length
    raw = zlib.decompress(idat)
    stride = width * channels
    rows = np.zeros((height, stride), np.uint8)
    prev = np.zeros(stride, np.int32)
    for y in range(height):
        start = y * (stride + 1)
        kind = raw[start]
        line = np.frombuffer(raw, np.uint8, stride, start + 1).astype(np.int32)
        if kind == 0:
            cur = line
        elif kind == 2:  # Up
            cur = (line + prev) & 255
        else:  # Sub、Average、Paeth 依赖同一行左侧已经还原的像素，逐个计算
            cur = np.zeros(stride, np.int32)
            for x in range(stride):
                a = int(cur[x - channels]) if x >= channels else 0
                b = int(prev[x])
                c = int(prev[x - channels]) if x >= channels else 0
                if kind == 1:
                    predictor = a
                elif kind == 3:
                    predictor = (a + b) // 2
                elif kind == 4:
                    pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                    predictor = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                else:
                    raise ValueError(f"第 {y} 行的过滤类型 {kind} 无效")
                cur[x] = (int(line[x]) + predictor) & 255
        rows[y] = cur
        prev = cur
    return rows.reshape(height, width, channels)[..., :3]


def range_colors(image: np.ndarray) -> tuple[int, int]:
    """红色边框 #D93025 附近的像素数，和扩展色 #7FB0EE 一类的浅蓝像素数。

    浅蓝经过光照后亮度变化大，只按色相判断：蓝明显高于红、绿，绿高于红。
    """
    r, g, b = (image[..., i].astype(int) for i in range(3))
    red = (abs(r - 217) < 30) & (abs(g - 48) < 30) & (abs(b - 37) < 30)
    blue = (b > 140) & (b - r > 60) & (b - g > 25) & (g - r > 20)
    return int(red.sum()), int(blue.sum())
