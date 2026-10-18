from pathlib import Path

from tools.soak.procmem import chrome_memory_mb, parse_ppid, parse_pss_kb, process_type


def test_parse_ppid_with_spaces_and_parens_in_name():
    assert parse_ppid("4321 (chrome (renderer)) S 1234 4321 4321 0 -1") == 1234


def test_parse_pss_kb():
    text = "55d0-7ffd ---p 00000000 00:00 0 [rollup]\nRss: 2048 kB\nPss: 1536 kB\n"
    assert parse_pss_kb(text) == 1536
    assert parse_pss_kb("Rss: 1 kB\n") is None


def test_process_type():
    assert process_type(b"/opt/google/chrome/chrome\0--type=renderer\0--lang=zh") == "renderer"
    assert process_type(b"/opt/google/chrome/chrome\0--headless=new\0") == "browser"
    # 改写进程标题后，参数用空格分隔
    assert process_type(b"/opt/google/chrome/chrome --type=gpu-process --no-sandbox\0") == (
        "gpu-process"
    )


def _process(proc: Path, pid: int, ppid: int, cmdline: bytes, pss_kb: int) -> None:
    d = proc / str(pid)
    d.mkdir()
    (d / "stat").write_text(f"{pid} (chrome) S {ppid} 0 0")
    (d / "cmdline").write_bytes(cmdline)
    (d / "smaps_rollup").write_text(f"Rss: {pss_kb * 2} kB\nPss: {pss_kb} kB\n")


def test_chrome_memory_sums_descendants_by_type(tmp_path):
    _process(tmp_path, 100, 1, b"chrome\0--headless=new", 1024)
    _process(tmp_path, 101, 100, b"chrome\0--type=zygote", 512)
    _process(tmp_path, 102, 101, b"chrome\0--type=renderer", 2048)
    _process(tmp_path, 103, 101, b"chrome\0--type=renderer", 1024)
    _process(tmp_path, 104, 100, b"chrome\0--type=gpu-process", 4096)
    _process(tmp_path, 200, 1, b"other\0--type=renderer", 9999)  # 不是这个 Chrome 的子进程
    (tmp_path / "self").mkdir()
    memory = chrome_memory_mb(100, tmp_path)
    assert memory == {"browser": 1.0, "zygote": 0.5, "renderer": 3.0, "gpu-process": 4.0}
