# spatialview_mock

mock 服务端（架构设计第 6 节）：实现[服务端对接接口文档](../../../docs/服务端对接接口文档.md)的全部接口和服务端行为，用模拟数据代替设备和算法。APP 的开发和测试都基于它；服务端团队可以连上它，对照接口文档观察各种情况下的状态和状态码。

## 进程

与真实系统中服务端程序和机械臂驱动的关系相同，分两个进程运行，可以分别停止和重启（接口文档 14.4）。

| 进程 | 可执行文件 | 内容 |
| --- | --- | --- |
| mock 服务端 | `mock_server` | `/spatialview/system_state` 和七个 Service；故障注入 `/spatialview_mock/inject`；订阅 `/client_count` |
| 模拟驱动 | `driver_sim` | 机械臂急停 Service（默认 `/robot_driver/emergency_stop`）和软件急停锁存；模拟的 ARCS 机械臂模式和安全模式，以及上电过程 |

两者之间的内部接口在 `/spatialview_mock/driver` 下（消息定义在 `spatialview_mock_msgs`），相当于真实驱动与服务端程序之间的接口，不经 rosbridge 访问：

| 名称 | 类型 | 用途 |
| --- | --- | --- |
| `state` | `spatialview_mock_msgs/msg/DriverState`，transient local | 连接、机械臂模式、安全模式、软件急停锁存、是否在运动；每 100 毫秒和变化时发布 |
| `clear_estop` | `std_srvs/srv/Trigger` | 清除锁存（ResetEstop 使用） |
| `set_motion` | `std_srvs/srv/SetBool` | 开始或结束运动；锁存期间、机械臂不可运动时拒绝开始 |
| `power_on` | `std_srvs/srv/Trigger` | 上电并松开刹车（PowerOn 使用）；只在机械臂模式为 PowerOff 或 Idle、没有急停和故障时受理，受理后在后台进行 |
| `inject` | `spatialview_mock_msgs/srv/Inject` | 机械臂相关的故障注入 |

## 运行

```bash
uv run python -m tools.sample_data --size small     # 先生成样例
scripts/ros.sh colcon build
scripts/mock-selftest.sh                            # 命令行自测（接口文档 15.2）
```

开发时用 docker compose 启动完整的开发环境（rosbridge、mock、nginx），见 `deploy/`。

### mock_server 的参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `sample_dir` | `samples/small` | 样例目录（`tools.sample_data` 的输出） |
| `files_dir` | `/var/lib/spatialview/files` | 文件目录，nginx 的根目录；启动时清空 |
| `scan_seconds`、`reconstruct_seconds`、`plan_seconds` | 10、5、5 | 扫描、重建、规划的耗时 |
| `stop_seconds` | 1 | 停止中持续的时间 |
| `speed` | 1 | 耗时和执行的加速倍率 |
| `power_on_timeout` | 30 | 上电过程的时限，秒；超过后结果为 POWER_ON FAILED，原因码 TIMEOUT。不随 `speed` 变化 |

### driver_sim 的参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `estop_service` | `/robot_driver/emergency_stop` | 急停 Service 的名称，与真实系统一致 |
| `latch_file` | `/tmp/spatialview_mock/estop_latched` | 锁存文件；存在即表示锁存，进程重启后保持 |
| `robot_mode`、`safety_mode` | `Running`、`Normal` | 启动时的机械臂模式和安全模式 |
| `power_on_seconds`、`idle_seconds`、`brake_release_seconds` | 2、0.5、2 | 上电过程各步的耗时，秒：上电中（PowerOn）、刹车未松开（Idle）、刹车松开中（BrakeReleasing） |

## 上电

PowerOn 受理后，模拟驱动把机械臂模式依次改为 PowerOn、Idle、BrakeReleasing，最后为 Running；从 Idle 开始时只松开刹车。期间 `robot_state` 为 STARTING，结束时给出 POWER_ON 的结果（接口文档 6.9、8.2）。

- 上电过程中出现急停、故障、离线时，模拟驱动放弃上电，机械臂模式退回这一步开始前的模式，结果为 POWER_ON FAILED，原因码与机械臂状态对应。
- 机械臂模式退回靠前的模式（例如 BrakeReleasing 退回 Idle）时，mock 服务端判断为上电或松开刹车失败，原因码 DEVICE_ERROR。用 `robot_power_on_fail` 注入。
- 用 `robot` 注入把机械臂模式改为 Booting、PowerOn 或 BrakeReleasing，可以模拟在示教器上启动：`robot_state` 为 STARTING，不产生 POWER_ON 结果。

## 故障注入

调用 `/spatialview_mock/inject`（`spatialview_mock_msgs/srv/Inject`），`args` 为 JSON 字符串，可为空。例如：

```bash
ros2 service call /spatialview_mock/inject spatialview_mock_msgs/srv/Inject \
  "{action: 'robot_protective_stop', args: '{\"detail\": \"检测到碰撞\"}'}"
```

机械臂（转给模拟驱动）：

| action | args | 效果 |
| --- | --- | --- |
| `robot_fault`、`robot_protective_stop`、`robot_safeguard_stop` | `detail` 可选 | 安全模式为 Fault、ProtectiveStop、SafeguardStop：机械臂故障 |
| `robot_estop` | — | 设备急停（RobotEmergencyStop） |
| `robot_estop_release` | — | 解除设备急停：安全模式 Normal、机械臂模式 Idle，即未启动 |
| `robot_power_off`、`robot_power_on` | — | 机械臂模式 PowerOff、Running；`robot_power_on` 直接变为 Running，不经过上电过程 |
| `robot_power_on_fail` | `step`：`power_on` 或 `brake_release`，默认 `brake_release`；`detail` 可选 | 下一次从接口上电时在这一步失败：机械臂模式退回 PowerOff 或 Idle，结果为 POWER_ON FAILED，原因码 DEVICE_ERROR，`detail` 写入结果 |
| `robot_recover` | — | 恢复为 Running、Normal，清除 detail |
| `robot_offline`、`robot_online` | — | 驱动与控制器断开、恢复 |
| `robot` | `robot_mode`、`safety_mode`、`connected`、`detail` 任选 | 直接设置；模式名称见接口文档 8.2 |

软件急停直接调用急停 Service 触发，用 ResetEstop 复位；也可以停止 `driver_sim` 进程模拟驱动离线。

服务端：

| action | args | 效果 |
| --- | --- | --- |
| `camera`、`laser` | `state`：OK、ERROR、OFFLINE | 相机、激光器的状态 |
| `fail_next` | `operation`：SCAN、RECONSTRUCT、PLAN；`code`、`detail` 可选 | 下一次该操作失败，默认原因码分别为 NO_VALID_DATA、RECONSTRUCT_ERROR、NO_SOLUTION |
| `plan_partial` | `keep`：整数 | 下一次规划只成功前 `keep` 个表面（PLAN_PARTIAL）；为 0 时规划失败（NO_SOLUTION） |
| `interlock` | `ok`：布尔；`detail` 可选 | 激光联锁是否满足，不满足时的说明默认为"安全门未关闭" |
| `module` | `name`：scan、reconstruct、plan、execute；`available`：布尔 | 模块是否可用 |
| `next_code` | `code`、`detail` 可选 | 下一个指令直接返回这个状态码，状态不变；可以是未知的码 |
| `speed` | `factor`：正数 | 耗时和执行的加速倍率 |

## 与真实服务端的差别

- 规划文件沿用样例的 TCP 路径和关节轨迹，只替换 ID 和 `surface_ids`，不随所选表面变化。
- 扫描和重建不产生新的几何，每次得到的模型都是同一个样例（ID 不同）。
- 工件类型只校验和记录，不影响得到的模型。
- 设备异常引起的中断立即完成；真实服务端最多可以有 2 秒（接口文档 8.5）。
- 测试见 `test/`：状态机部分不依赖 ROS，在仓库根目录用 `uv run pytest` 运行。
