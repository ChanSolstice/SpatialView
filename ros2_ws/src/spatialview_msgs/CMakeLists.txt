cmake_minimum_required(VERSION 3.8)
project(spatialview_msgs)

find_package(ament_cmake REQUIRED)
find_package(builtin_interfaces REQUIRED)
find_package(rosidl_default_generators REQUIRED)

rosidl_generate_interfaces(${PROJECT_NAME}
  "msg/Alarm.msg"
  "msg/OperationResult.msg"
  "msg/StatusCode.msg"
  "msg/SystemState.msg"
  "srv/GetSystemState.srv"
  "srv/PowerOn.srv"
  "srv/ResetEstop.srv"
  "srv/SetLaser.srv"
  "srv/StartPlan.srv"
  "srv/StartScan.srv"
  "srv/TaskControl.srv"
  DEPENDENCIES builtin_interfaces
)

ament_export_dependencies(rosidl_default_runtime)
ament_package()
