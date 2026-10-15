"""Python 环境检查：工具与 mock 服务端以 ROS 2 Humble 的 Python 3.10 为准。"""

import sys


def test_python_version_matches_ros2_humble():
    assert sys.version_info[:2] == (3, 10)
