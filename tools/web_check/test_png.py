import struct
import zlib

import numpy as np
import pytest

from tools.web_check.png import decode_png, range_colors


def paeth(a: int, b: int, c: int) -> int:
    pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
    return a if pa <= pb and pa <= pc else (b if pb <= pc else c)


def encode(image: np.ndarray, filters: list[int]) -> bytes:
    """按给定的每行过滤类型编码 8 位 RGB 或 RGBA 的 PNG。"""
    height, width, channels = image.shape
    stride = width * channels
    flat = image.reshape(height, stride).astype(int)
    raw = bytearray()
    for y in range(height):
        kind = filters[y % len(filters)]
        raw.append(kind)
        for x in range(stride):
            a = flat[y, x - channels] if x >= channels else 0
            b = flat[y - 1, x] if y > 0 else 0
            c = flat[y - 1, x - channels] if x >= channels and y > 0 else 0
            predictor = [0, a, b, (a + b) // 2, paeth(a, b, c)][kind]
            raw.append((flat[y, x] - predictor) & 255)

    def chunk(kind: bytes, body: bytes) -> bytes:
        return (
            struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
        )

    color = {3: 2, 4: 6}[channels]
    header = struct.pack(">IIBBBBB", width, height, 8, color, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw)))
        + chunk(b"IEND", b"")
    )


@pytest.mark.parametrize("channels", [3, 4])
def test_decode_all_filter_types(channels):
    rng = np.random.default_rng(1)
    image = rng.integers(0, 256, (10, 7, channels), dtype=np.uint8)
    decoded = decode_png(encode(image, [0, 1, 2, 3, 4]))
    assert decoded.shape == (10, 7, 3)
    assert np.array_equal(decoded, image[..., :3])


def test_rejects_other_formats():
    with pytest.raises(ValueError, match="不是 PNG"):
        decode_png(b"GIF89a")
    image = np.zeros((2, 2, 4), np.uint8)
    data = bytearray(encode(image, [0]))
    data[8 + 8 + 9] = 3  # IHDR 中的颜色类型改为调色板
    with pytest.raises(ValueError, match="不支持"):
        decode_png(bytes(data))


def test_range_colors():
    image = np.zeros((2, 3, 3), np.uint8)
    image[0, 0] = (217, 48, 37)  # 红色边框
    image[0, 1] = (200, 60, 50)  # 接近红色边框
    image[1, 0] = (127, 176, 238)  # 扩展色
    image[1, 1] = (60, 100, 170)  # 光照较暗的扩展色
    image[1, 2] = (240, 140, 40)  # 选中的橙色
    assert range_colors(image) == (2, 2)
