#!/usr/bin/env bash
# mock 服务端的命令行自测（接口文档 15.2、阶段规划阶段 4）。在 ros:humble 中启动模拟驱动和 mock 服务端，
# 用 ros2 命令行检查状态、各指令、文件导出，以及急停在服务端程序停止和驱动重启时的行为。
#
#   scripts/mock-selftest.sh            在本机通过 Docker 运行（没有 Docker 权限时加 DOCKER="sudo docker"）
#   scripts/mock-selftest.sh --inside   已经在 ROS 2 Humble 环境中（例如 CI 的 ros:humble 容器）、构建过 ros2_ws、
#                                       生成过 samples/small 时直接运行
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

if [ "${1:-}" != "--inside" ]; then
  # 没有样例，或样例早于失败路径（failed_paths.json）时重新生成
  grep -qs '"failed_paths"' samples/small/manifest.json || uv run python -m tools.sample_data --size small >/dev/null
  scripts/ros.sh colcon build >/dev/null
  exec scripts/ros.sh bash /ws/scripts/mock-selftest.sh --inside
fi

# ---------------------------------------------------------------- 以下在 ROS 2 环境中执行
set +u
# shellcheck disable=SC1091
source /opt/ros/humble/setup.bash
# shellcheck disable=SC1091
source "$ROOT/ros2_ws/install/setup.bash"
set -u
export ROS_DOMAIN_ID=${ROS_DOMAIN_ID:-37}
WORK=/tmp/mock-selftest
FILES=$WORK/files
LATCH=$WORK/estop_latched
rm -rf "$WORK" && mkdir -p "$FILES"
failures=0

# 直接启动节点（不经 ros2 run），PID 就是节点本身；非交互式 shell 中后台进程忽略 SIGINT，用 SIGTERM 停止
BIN=$ROOT/ros2_ws/install/spatialview_mock/lib/spatialview_mock
start_driver() {
  "$BIN/driver_sim" --ros-args -p latch_file:="$LATCH" >>"$WORK/driver.log" 2>&1 &
  echo $! >"$WORK/driver.pid"
}
start_server() {
  "$BIN/mock_server" --ros-args -p sample_dir:="$ROOT/samples/small" \
    -p files_dir:="$FILES" -p speed:=10.0 >>"$WORK/server.log" 2>&1 &
  echo $! >"$WORK/server.pid"
}
stop() {
  local pid
  pid=$(cat "$WORK/$1.pid" 2>/dev/null) || return 0
  kill -TERM "$pid" 2>/dev/null || return 0
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
}
cleanup() {
  stop server
  stop driver
}
trap cleanup EXIT

wait_for() {
  for _ in $(seq 1 50); do
    if ros2 service list 2>/dev/null | grep -qx "$1"; then return 0; fi
    sleep 0.2
  done
  echo "等待 $1 超时"
  return 1
}

check() {
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  ✓ $name"
  else
    echo "  ✗ $name"
    failures=$((failures + 1))
  fi
}

state() { ros2 topic echo /spatialview/system_state --once --field "$1" 2>/dev/null | head -1; }
call() { ros2 service call "$@" 2>&1; }
has() { grep -q -- "$2" <<<"$1"; }
state_is() { [ "$(state "$1")" = "$2" ]; }
eventually() {
  local field=$1 value=$2
  for _ in $(seq 1 30); do
    if state_is "$field" "$value"; then return 0; fi
    sleep 0.3
  done
  return 1
}

start_driver
start_server
wait_for /spatialview/get_system_state
wait_for /robot_driver/emergency_stop
eventually robot_state READY

echo "接口文档 15.2 的命令"
check "system_state 的接口版本为 1.1" state_is interface_version 1.1
hz=$(timeout 6 ros2 topic hz /spatialview/system_state 2>/dev/null | grep -m1 -o 'average rate: [0-9.]*' | grep -o '[0-9.]*$' || true)
check "system_state 定时发布（实测 ${hz:-无} 次/秒）" awk -v r="${hz:-0}" 'BEGIN { exit !(r >= 1.6 && r <= 3.0) }'
check "get_system_state 返回无模型" has "$(call /spatialview/get_system_state spatialview_msgs/srv/GetSystemState)" "phase='NO_MODEL'"
check "start_plan 在无模型时拒绝" has "$(call /spatialview/start_plan spatialview_msgs/srv/StartPlan "{model_id: 'model_x', surface_ids: []}")" "code='INVALID_STATE'"
check "task_control PAUSE 在无任务时拒绝" has "$(call /spatialview/task_control spatialview_msgs/srv/TaskControl "{command: 'PAUSE', plan_id: ''}")" "code='INVALID_STATE'"
# YAML 中不加引号的 on 会被解析为布尔值 true，键名必须加引号
check "set_laser 关闭总是受理" has "$(call /spatialview/set_laser spatialview_msgs/srv/SetLaser "{'on': false}")" "code='OK'"
check "power_on 在机械臂已就绪时拒绝" has "$(call /spatialview/power_on spatialview_msgs/srv/PowerOn)" "code='INVALID_STATE'"
check "start_scan 拒绝未知的工件类型" has "$(call /spatialview/start_scan spatialview_msgs/srv/StartScan "{workpiece_type: 'CUBE'}")" "code='INVALID_ARGUMENT'"
check "reset_estop 在没有锁存时拒绝" has "$(call /spatialview/reset_estop spatialview_msgs/srv/ResetEstop)" "code='INVALID_STATE'"

echo "扫描、规划、执行"
check "start_scan 受理（旋转体）" has "$(call /spatialview/start_scan spatialview_msgs/srv/StartScan "{workpiece_type: 'REVOLVED'}")" "code='OK'"
check "重建完成后为模型就绪" eventually phase MODEL_READY
model=$(state model_id)
check "模型文件已导出（$model）" test -f "$FILES/models/$model.glb"
check "start_plan 受理" has "$(call /spatialview/start_plan spatialview_msgs/srv/StartPlan "{model_id: '$model', surface_ids: []}")" "code='OK'"
check "规划完成后为规划就绪" eventually phase PLAN_READY
plan=$(state plan_id)
check "规划文件已导出（$plan）" test -f "$FILES/plans/$plan.json"
check "全部规划成功时没有失败路径" bash -c "! grep -q failed_paths '$FILES/plans/$plan.json'"
check "注入部分无法规划" has "$(call /spatialview_mock/inject spatialview_mock_msgs/srv/Inject "{action: 'plan_partial', args: '{\"keep\": 1}'}")" "ok=True"
check "start_plan 受理（部分无法规划）" has "$(call /spatialview/start_plan spatialview_msgs/srv/StartPlan "{model_id: '$model', surface_ids: []}")" "code='OK'"
check "部分规划完成后为规划就绪" eventually phase PLAN_READY
check "结果为 PLAN_PARTIAL" has "$(ros2 topic echo /spatialview/system_state --once --field last_result 2>/dev/null)" "PLAN_PARTIAL"
plan=$(state plan_id)
check "规划文件带失败路径（$plan）" grep -q '"failed_paths":\[{"surface_id":' "$FILES/plans/$plan.json"

echo "激光器不可用时的清洗（接口文档 6.5）"
# 样例的清洗在 10 倍速下只有几秒，从这里到急停改回原速
call /spatialview_mock/inject spatialview_mock_msgs/srv/Inject "{action: 'speed', args: '{\"factor\": 1}'}" >/dev/null
check "激光器离线" has "$(call /spatialview_mock/inject spatialview_mock_msgs/srv/Inject "{action: 'laser', args: '{\"state\": \"OFFLINE\"}'}")" "ok=True"
check "激光器离线时开始清洗受理" has "$(call /spatialview/task_control spatialview_msgs/srv/TaskControl "{command: 'START', plan_id: '$plan'}")" "code='OK'"
check "激光器恢复" has "$(call /spatialview_mock/inject spatialview_mock_msgs/srv/Inject "{action: 'laser', args: '{\"state\": \"OK\"}'}")" "ok=True"
check "任务继续执行" state_is phase EXECUTING
check "整次不出光" state_is laser_state OFF
check "停止受理" has "$(call /spatialview/task_control spatialview_msgs/srv/TaskControl "{command: 'STOP', plan_id: ''}")" "code='OK'"
check "停止后回到规划就绪" eventually phase PLAN_READY

echo "清洗"
check "开始清洗受理" has "$(call /spatialview/task_control spatialview_msgs/srv/TaskControl "{command: 'START', plan_id: '$plan'}")" "code='OK'"
check "清洗中机械臂为运行中" eventually robot_state RUNNING

echo "执行出错后继续（接口文档 6.5）"
check "注入执行出错" has "$(call /spatialview_mock/inject spatialview_mock_msgs/srv/Inject "{action: 'task_error', args: '{\"code\": \"MODULE_UNAVAILABLE\"}'}")" "ok=True"
check "任务停在已暂停" eventually phase PAUSED
check "任务中断，原因 MODULE_UNAVAILABLE" has "$(ros2 topic echo /spatialview/system_state --once --field last_result 2>/dev/null)" "MODULE_UNAVAILABLE"
check "规划保留" state_is plan_id "$plan"
check "继续受理" has "$(call /spatialview/task_control spatialview_msgs/srv/TaskControl "{command: 'RESUME', plan_id: ''}")" "code='OK'"
check "继续后为执行中" eventually phase EXECUTING

echo "急停"
check "急停 Service 返回成功" has "$(call /robot_driver/emergency_stop std_srvs/srv/Trigger)" "success=True"
check "机械臂状态为急停" eventually robot_state ESTOP
check "software_estop 为 true" state_is software_estop True
check "任务中断后停在已暂停" eventually phase PAUSED
check "任务中断，原因 ROBOT_ESTOP" has "$(ros2 topic echo /spatialview/system_state --once --field last_result 2>/dev/null)" "ROBOT_ESTOP"
check "锁存期间继续被拒绝" has "$(call /spatialview/task_control spatialview_msgs/srv/TaskControl "{command: 'RESUME', plan_id: ''}")" "code='ROBOT_NOT_READY'"

echo "急停的独立性（接口文档 6.7、14.4）"
stop server
check "服务端程序停止时急停仍然成功" has "$(call /robot_driver/emergency_stop std_srvs/srv/Trigger)" "success=True"
stop driver
start_driver
wait_for /robot_driver/emergency_stop
check "驱动重启后锁存仍在" has "$(ros2 topic echo /spatialview_mock/driver/state --once --field software_estop 2>/dev/null)" "True"
start_server
wait_for /spatialview/reset_estop
check "服务端重启后显示急停" eventually robot_state ESTOP
check "复位受理" has "$(call /spatialview/reset_estop spatialview_msgs/srv/ResetEstop)" "code='OK'"
check "复位后为就绪" eventually robot_state READY

echo "故障注入"
check "机械臂断电" has "$(call /spatialview_mock/inject spatialview_mock_msgs/srv/Inject "{action: 'robot_power_off', args: ''}")" "ok=True"
check "机械臂状态为未启动" eventually robot_state DISABLED

echo "上电（接口文档 6.9）"
last_result() { ros2 topic echo /spatialview/system_state --once --field last_result 2>/dev/null; }
result_has() {
  for _ in $(seq 1 30); do
    if has "$(last_result)" "$1"; then return 0; fi
    sleep 0.3
  done
  return 1
}
check "power_on 受理，回复中为启动中" has "$(call /spatialview/power_on spatialview_msgs/srv/PowerOn)" "code='OK'.*robot_state='STARTING'"
check "上电期间再次上电被拒绝" has "$(call /spatialview/power_on spatialview_msgs/srv/PowerOn)" "code='INVALID_STATE'"
check "上电完成后为就绪" eventually robot_state READY
check "结果为 POWER_ON SUCCEEDED" result_has "result: SUCCEEDED"
call /spatialview_mock/inject spatialview_mock_msgs/srv/Inject "{action: 'robot_power_off', args: ''}" >/dev/null
eventually robot_state DISABLED
check "注入上电失败" has "$(call /spatialview_mock/inject spatialview_mock_msgs/srv/Inject "{action: 'robot_power_on_fail', args: '{\"detail\": \"关节 3 刹车未松开\"}'}")" "ok=True"
check "power_on 受理" has "$(call /spatialview/power_on spatialview_msgs/srv/PowerOn)" "code='OK'"
check "松开刹车失败，原因 DEVICE_ERROR" result_has "code: DEVICE_ERROR"
check "失败后回到未启动" eventually robot_state DISABLED
check "power_on 受理" has "$(call /spatialview/power_on spatialview_msgs/srv/PowerOn)" "code='OK'"
check "上电过程中急停" has "$(call /robot_driver/emergency_stop std_srvs/srv/Trigger)" "success=True"
check "上电失败，原因 ROBOT_ESTOP" result_has "code: ROBOT_ESTOP"
check "复位受理" has "$(call /spatialview/reset_estop spatialview_msgs/srv/ResetEstop)" "code='OK'"
check "复位后为未启动" eventually robot_state DISABLED
check "power_on 受理" has "$(call /spatialview/power_on spatialview_msgs/srv/PowerOn)" "code='OK'"
check "再次上电后为就绪" eventually robot_state READY

if [ "$failures" -gt 0 ]; then
  echo "自测失败：$failures 项。日志：$WORK/server.log、$WORK/driver.log"
  tail -20 "$WORK/server.log"
  exit 1
fi
echo "自测通过"
