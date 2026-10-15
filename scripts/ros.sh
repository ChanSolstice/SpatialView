#!/usr/bin/env bash
# 在 ros:humble 容器中、以当前用户身份执行命令，仓库挂载到 /ws，工作目录为 /ws/ros2_ws。
# 已加载 ROS 2 Humble 环境；构建过的话也加载 ros2_ws/install。
#
#   scripts/ros.sh colcon build
#   scripts/ros.sh ros2 interface show spatialview_msgs/msg/SystemState
#
# 当前用户没有 Docker 权限时：DOCKER="sudo docker" scripts/ros.sh ...
set -euo pipefail
cd "$(dirname "$0")/.."
DOCKER=${DOCKER:-docker}
IMAGE=${ROS_IMAGE:-ros:humble}
TTY_FLAGS=()
if [ -t 0 ] && [ -t 1 ]; then TTY_FLAGS=(-it); fi
# shellcheck disable=SC2086
exec $DOCKER run --rm "${TTY_FLAGS[@]}" -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:/ws" -w /ws/ros2_ws "$IMAGE" \
  bash -c 'source /opt/ros/humble/setup.bash
           if [ -f install/setup.bash ]; then source install/setup.bash; fi
           exec "$@"' -- "$@"
