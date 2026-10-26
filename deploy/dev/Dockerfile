# 开发用服务端环境的镜像：ROS 2 Humble、rosbridge、mock 服务端、模拟驱动和样例数据（架构设计 8.1）
FROM ros:humble

RUN apt-get update \
 && apt-get install -y --no-install-recommends ros-humble-rosbridge-suite python3-numpy \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /ws
COPY ros2_ws/src ros2_ws/src
RUN . /opt/ros/humble/setup.sh \
 && cd ros2_ws \
 && colcon build --event-handlers console_cohesion- \
 && rm -rf build log

# 样例数据：小样例用于日常开发，大样例用于性能验证（SAMPLE_SIZE 选择）
COPY tools tools
COPY app/public/robot/aubo_i5H_dev.urdf app/public/robot/aubo_i5H_dev.urdf
RUN python3 -m tools.sample_data --size small --out samples/small >/dev/null \
 && python3 -m tools.sample_data --size large --out samples/large >/dev/null \
 && python3 -m tools.sample_data --size demo --out samples/demo >/dev/null

COPY deploy deploy
COPY deploy/dev/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
