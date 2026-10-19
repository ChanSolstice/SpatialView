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

## 8 小时测试 `soak`

需求 12.2 的连续运行测试：用真实的点击事件循环操作 APP，每轮依次"扫描 → 加载模型 → 选面、规划 → 加载规划 → 轨迹动画"，每轮结束后记录内存，最后判断有无崩溃、内存是否持续增长。只从界面判断状态，不依赖开发版的调试接口，打包产物和平板上的 APP 都可以测。

本机测试：开发环境使用大样例，无头 Chrome 打开打包产物，并写入指向开发环境的覆盖配置（与工程入口保存的相同）。

```bash
SAMPLE_SIZE=large docker compose -f deploy/docker-compose.dev.yml up -d
(cd app && npm run build)
python3 -m http.server 4173 --directory app/dist &
uv run python -m tools.soak --url http://127.0.0.1:4173/ \
    --rosbridge ws://127.0.0.1:9090 --http http://127.0.0.1:8080 --out soak-report
```

平板测试：安装 debug 包，在工程入口中设置服务端地址，转发 WebView 的调试端口后连接（APP 保持在前台）：

```bash
adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof com.spatialview.app)
uv run python -m tools.soak --endpoint http://127.0.0.1:9222 --out soak-report
```

连接真实服务端时，扫描会让机械臂运动；`--execute-seconds` 还会开始清洗、开启激光，需要现场人员看护（接口文档 15.4 场景 10）。

| 参数 | 说明 |
| --- | --- |
| `--hours`、`--rounds` | 运行时长和至少完成的轮数，默认 8 小时、50 轮 |
| `--play-seconds`、`--tail-seconds` | 轨迹动画先以最高倍速播放的秒数（默认 20）；之后拖到只剩这么多动画时间处，播放到结束（默认 40）。没有 GPU 时大样例每帧要几秒，不从头播放完 |
| `--execute-seconds` | 大于 0 时，每轮最后开始清洗，执行这么多秒后停止 |
| `--warmup`、`--limit` | 判断内存增长时去掉的前几轮（默认 3）；去掉后，后一半的中位数比前一半多出这个比例即为持续增长（默认 0.1） |
| `--max-failures` | 连续失败多少轮后停止，默认 3 |
| `--dpr` | 本机 Chrome 的 `devicePixelRatio`，默认 1.5，与目标平板相同 |

结果写在 `--out` 目录：`rounds.csv` 每轮一行，包括各步耗时、APP 记录的模型和路径显示耗时（架构设计 5.6）和内存；`summary.json` 是结论；失败的轮次有截图。内存指标为垃圾回收后的 JS 堆、DOM 节点数和事件监听数，本机 Chrome 另有渲染进程和 GPU 进程的内存：匿名内存和共享内存的 PSS，加上换出到交换区的部分；不计程序文件的映射，它们在内存紧张时由内核丢弃和读回，数值不稳定。three.js 的几何体在 SwiftShader 中占用 GPU 进程的内存。不通过时退出码为 1：崩溃、有失败的轮次、页面中有未捕获的异常、未运行满时长或轮数不够，或任一内存指标持续增长。
