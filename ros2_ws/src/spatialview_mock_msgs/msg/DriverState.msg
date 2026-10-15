# 模拟驱动的状态（/spatialview_mock/driver/state），相当于真实驱动提供给服务端程序的内部接口（接口文档 6.7、8.2）。

bool connected                  # 与（模拟的）控制器连接正常
string robot_mode               # ARCS 的机械臂模式，例如 Running、PowerOff、Idle
string safety_mode              # ARCS 的安全模式，例如 Normal、ProtectiveStop、RobotEmergencyStop
bool software_estop             # 软件急停锁存
bool motion_active              # 机械臂正在执行服务端下发的运动（扫描或清洗）
string detail                   # 故障的具体原因，可为空
