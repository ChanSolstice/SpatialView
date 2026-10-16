#!/bin/bash
# 加载 ROS 2 和本仓库的工作空间后执行命令
set -e
source /opt/ros/humble/setup.bash
source /ws/ros2_ws/install/setup.bash
exec "$@"
