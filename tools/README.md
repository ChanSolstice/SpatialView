# tools

对接与测试工具（架构设计第 3 节）。在仓库根目录用 uv 运行，Python 3.10。

## 样例数据 `sample_data`

生成符合接口文档第 10、11 节的工件模型和规划文件，供性能验证、mock 服务端和测试使用。工件放在 i5H 的工作范围内，关节轨迹按开发用 URDF（`app/public/robot/aubo_i5H_dev.urdf`）逆解求出，工具末端沿 TCP 路径运动。

```bash
uv run python -m tools.sample_data --size small   # 29 个表面、930 个三角面、665 点
uv run python -m tools.sample_data --size large   # 483 个表面、292,834 个三角面、98,459 点
```

输出到 `samples/<规模>/`（不提交）：`models/<model_id>.glb`、`plans/<plan_id>.json` 和 `manifest.json`，目录结构与接口文档第 9 节一致。

## 文件校验 `validate`

按接口文档第 10、11 节检查 GLB 和规划文件（接口文档 15.1），服务端可以用它自测导出功能。

```bash
uv run python -m tools.validate --model 模型.glb --plan 规划.json --urdf 机械臂.urdf --tcp-link TCP连杆名
```

- 同时给出模型和规划文件时做交叉检查：ID、表面是否存在且可清洗、工艺段 TCP 点是否贴近模型表面。最后一项能发现 Y-up 转换、单位或坐标系不一致。
- 给出 URDF 时检查关节名和关节范围；再给出 TCP 连杆名时，按正运动学核对工具末端是否沿 TCP 路径。
- 有错误时退出码为 1。同一问题只列出前 5 处，其余计数。

| 参数 | 说明 |
| --- | --- |
| `--model-id`、`--plan-id` | 期望的 ID |
| `--tcp-tolerance` | 工艺段 TCP 点到模型表面的允许距离，默认 0.05 米。TCP 不在工件表面上时调大 |
| `--fk-tolerance` | 正运动学与 TCP 路径的允许偏差，默认 0.005 米 |
| `--json` | 以 JSON 输出结果 |

## 接口检查 `interface_check`

经 rosbridge 和 HTTP 检查服务端是否符合接口文档（接口文档 15.1）。服务端团队在联调前用它自测，接口约定从 `ros2_ws/src/spatialview_msgs` 的 `.msg` 读取。

```bash
uv run python -m tools.interface_check --rosbridge ws://<服务端主机>:9090 --http http://<服务端主机>:8080
```

默认用例不会让机械臂运动，也不会开启激光：

- GetSystemState 和 SystemState 的字段、类型和取值，以及字段之间的规则，例如没有模型时 `model_url` 为空、`software_estop` 为 true 时机械臂为急停
- 发布频率（每 500 毫秒一次）、seq 每次加 1、观察期间 `session_id` 不变
- 按当前阶段选出必然被拒绝的指令，检查状态码、500 毫秒时限，以及拒绝后阶段不变
- 当前的模型和规划文件：跨域响应头、JSON 的 gzip，内容用 `validate` 检查

下面的用例需要显式开启，并由现场人员看护：

| 参数 | 用例 |
| --- | --- |
| `--allow-motion` | 扫描 → 重建 → 规划 → 开始 → 暂停 → 继续 → 停止，检查各阶段、结果和导出的文件。机械臂会运动 |
| `--allow-laser` | 开启、关闭激光；联锁不满足时报告服务端给出的原因。激光会开启 |
| `--allow-estop` | 调用机械臂急停 Service，检查急停和软件急停锁存，再复位；与 `--allow-motion` 同时给出时在执行中急停 |

| 其他参数 | 说明 |
| --- | --- |
| `--estop-service` | 机械臂急停 Service 的名称，默认为暂定名 `/robot_driver/emergency_stop` |
| `--urdf`、`--tcp-link` | 检查规划文件的关节名，并按正运动学核对工具末端是否沿 TCP 路径 |
| `--wait` | 等待扫描、规划、停止完成的最长时间，默认 120 秒 |
| `--connect-timeout` | 连接失败或服务端尚未就绪时重试的时长 |
| `--json` | 以 JSON 输出结果 |

有错误时退出码为 1。对开发环境运行全部用例：`scripts/dev-env-check.sh`（见 `deploy/README.md`）。
