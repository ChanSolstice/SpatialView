from pathlib import Path

import pytest

from tools.web_check.__main__ import main
from tools.web_check.check import dialog_parts, package_version, range_lines, toolbar_range


def test_package_version():
    assert package_version(Path("delivery/x/spatialview-web-0.1.5.tar.gz")) == "0.1.5"
    for name in ("spatialview-web.tar.gz", "spatialview-web-0.1.5.zip", "web-0.1.5.tar.gz"):
        with pytest.raises(ValueError):
            package_version(Path(name))


def plan(selected, scope, traced):
    return {
        "selected_surface_ids": selected,
        "planning_scope_surface_ids": scope,
        "surface_ids": traced,
    }


def test_range_lines_match_requirement_text():
    """与 APP 的 rangeLines（需求 5.5）一致。"""
    lines, expanded, untraced = range_lines(plan(["a", "b"], ["a", "b", "c"], ["b", "c"]))
    assert (expanded, untraced) == (1, 1)
    assert lines == [
        '规划范围按连续曲面从选择的 2 个表面扩展到 3 个，点击"选面"可以查看，扩展的表面为浅蓝色。',
        "其中 1 个表面没有生成路径，选面时以红色边框标出。",
    ]
    assert range_lines(plan(["a"], ["a"], ["a"])) == ([], 0, 0)
    lines, expanded, untraced = range_lines(plan(["a"], ["a"], []))
    assert (len(lines), expanded, untraced) == (1, 0, 1)


def test_toolbar_range():
    assert toolbar_range(0, 0) == ""
    assert toolbar_range(1, 0) == "当前规划：扩展 1 个"
    assert toolbar_range(0, 3) == "当前规划：未生成路径 3 个"
    assert toolbar_range(22, 20) == "当前规划：扩展 22 个未生成路径 20 个"


def test_dialog_parts():
    assert dialog_parts("标题 | 说明 | PLAN_PARTIAL | 确定") == ["标题", "说明", "PLAN_PARTIAL"]
    assert dialog_parts("标题 | 说明") == ["标题", "说明"]
    assert dialog_parts("") == []


def test_cli_checks_arguments(tmp_path, capsys):
    archive = tmp_path / "spatialview-web-0.1.5.tar.gz"
    with pytest.raises(SystemExit):
        main([str(tmp_path / "other.tar.gz"), "--password-file", "x", "--out", str(tmp_path)])
    assert "spatialview-web-<版本>.tar.gz" in capsys.readouterr().err
    with pytest.raises(SystemExit):
        main([str(archive), "--password-file", "x", "--out", str(tmp_path)])
    assert "找不到压缩包" in capsys.readouterr().err
    archive.write_bytes(b"")
    with pytest.raises(SystemExit):
        main([str(archive), "--password-file", str(tmp_path / "pw"), "--out", str(tmp_path)])
    assert "找不到密码文件" in capsys.readouterr().err
