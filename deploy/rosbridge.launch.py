"""rosbridge 的启动参数，与服务端对接接口文档 14.2 一致。

    ros2 launch deploy/rosbridge.launch.py                      # 与现场部署相同
    ros2 launch deploy/rosbridge.launch.py dev:=true            # 开发环境：额外放行故障注入服务

不启动 rosapi 节点（接口文档 14.2）。
"""

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, OpaqueFunction
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def _rosbridge(context):
    estop_service = LaunchConfiguration("estop_service").perform(context)
    dev = LaunchConfiguration("dev").perform(context).lower() == "true"
    services = ["/spatialview/*", estop_service]
    if dev:
        services.append("/spatialview_mock/inject")
    return [
        Node(
            package="rosbridge_server",
            executable="rosbridge_websocket",
            name="rosbridge_websocket",
            parameters=[
                {
                    "port": int(LaunchConfiguration("port").perform(context)),
                    "topics_glob": "[/spatialview/*]",
                    "services_glob": "[" + ", ".join(services) + "]",
                    "call_services_in_new_thread": True,
                    "default_call_service_timeout": 5.0,
                    "websocket_ping_interval": 2.0,
                    "websocket_ping_timeout": 6.0,
                }
            ],
        )
    ]


def generate_launch_description():
    return LaunchDescription(
        [
            DeclareLaunchArgument("port", default_value="9090"),
            # 以接口文档第 16 节服务端填写的名称为准
            DeclareLaunchArgument("estop_service", default_value="/robot_driver/emergency_stop"),
            DeclareLaunchArgument("dev", default_value="false"),
            OpaqueFunction(function=_rosbridge),
        ]
    )
