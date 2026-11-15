# 完整系统状态（接口文档 5.1），Topic /spatialview/system_state。
# 服务端每 500 毫秒发布一次，除 progress、exec_time 外任何字段变化时 200 毫秒内补发（接口文档 5.4）。

# 接口版本："主版本.次版本"（接口文档第 3 节）
string INTERFACE_VERSION="1.1"

# robot_state 的取值（接口文档 8.2）
string ROBOT_READY="READY"
string ROBOT_RUNNING="RUNNING"
string ROBOT_PAUSED="PAUSED"
string ROBOT_FAULT="FAULT"
string ROBOT_ESTOP="ESTOP"
string ROBOT_DISABLED="DISABLED"
string ROBOT_STARTING="STARTING"
string ROBOT_OFFLINE="OFFLINE"

# camera_state 的取值（接口文档 8.3）
string CAMERA_OK="OK"
string CAMERA_ERROR="ERROR"
string CAMERA_OFFLINE="OFFLINE"

# laser_state 的取值（接口文档 8.3）
string LASER_OFF="OFF"
string LASER_ON="ON"
string LASER_ERROR="ERROR"
string LASER_OFFLINE="OFFLINE"

# phase 的取值（接口文档 8.1）
string PHASE_NO_MODEL="NO_MODEL"
string PHASE_SCANNING="SCANNING"
string PHASE_RECONSTRUCTING="RECONSTRUCTING"
string PHASE_MODEL_READY="MODEL_READY"
string PHASE_PLANNING="PLANNING"
string PHASE_PLAN_READY="PLAN_READY"
string PHASE_EXECUTING="EXECUTING"
string PHASE_PAUSED="PAUSED"
string PHASE_STOPPING="STOPPING"

string interface_version        # 接口版本，本文档为 "1.1"
string session_id               # 服务端每次启动生成一个新值
uint64 seq                      # 本会话内每发布一次加 1，从 1 开始
builtin_interfaces/Time stamp   # 发布时间

string robot_state              # 机械臂状态：READY RUNNING PAUSED FAULT ESTOP DISABLED STARTING OFFLINE（8.2）
bool software_estop             # 软件急停已触发、尚未复位（6.7、6.8）；为 true 时 robot_state 为 ESTOP
string camera_state             # 相机状态：OK ERROR OFFLINE（8.3）
string laser_state              # 激光器状态：OFF ON ERROR OFFLINE（8.3）
string phase                    # 作业阶段（8.1）

float32 progress                # 扫描中、重建中、规划中的完成百分比 0–100；其他阶段或无法提供时为 -1
float64 exec_time               # 本次清洗实际已执行的时间，秒，不含暂停；执行中、已暂停、停止中有效，其他阶段为 0

string model_id                 # 当前模型；无模型时为空
string model_url                # 当前模型文件的相对路径，例如 /models/model_20261012T153012.glb
string plan_id                  # 当前规划；无规划时为空
string plan_url                 # 当前规划文件的相对路径，例如 /plans/plan_20261012T153512.json
string[] plan_surface_ids       # 当前规划实际包含的表面

Alarm[] alarms                  # 当前活动告警（5.2）
OperationResult last_result     # 最近一次操作结果（5.3）；本会话还没有结果时 id 为空
