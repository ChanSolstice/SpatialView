# tools

对接与测试工具（架构设计第 3 节）。在仓库根目录用 uv 运行，Python 3.10。

## 样例数据 `sample_data`

生成符合接口文档第 10、11 节的工件模型和规划文件，供性能验证、mock 服务端和测试使用。工件放在 i5H 的工作范围内，关节轨迹按开发用 URDF（`app/public/robot/aubo_i5H_dev.urdf`）逆解求出，工具末端沿 TCP 路径运动。

```bash
uv run python -m tools.sample_data --size small   # 29 个表面、930 个三角面、665 点
uv run python -m tools.sample_data --size large   # 483 个表面、292,834 个三角面、98,459 点
uv run python -m tools.sample_data --size demo    # 圆台：10 个表面、5,760 个三角面、1,746 点，演示视频用
```

输出到 `samples/<规模>/`（不提交）：`models/<model_id>.glb`、`plans/<plan_id>.json` 和 `manifest.json`，目录结构与接口文档第 9 节一致。

另有失败路径 `failed_paths.json`（接口文档 11.1 的 `failed_paths` 格式）：在背向机械臂的两块侧面上往复，模拟规划服务生成了 TCP 路径、但机械臂够不到的情况；块体在 `wall_xmax_00`、`wall_xmax_01` 上，圆台在 `side_00`、`side_01` 上，各约 100–160 点。mock 服务端在部分无法规划时把它写入规划文件。加 `--failed-paths` 时规划文件本身也带上失败路径，可以单独检查 APP 的红色显示。

样例的规划没有连续扩展：有效选择 `selected_surface_ids` 与规划范围 `planning_scope_surface_ids` 相同（接口文档 11.1），为有路径的表面；加 `--failed-paths` 时还包括失败路径所在的表面。连续扩展由 mock 服务端注入（见 `ros2_ws/src/spatialview_mock/README.md`）。

## 文件校验 `validate`

按接口文档第 10、11 节检查 GLB 和规划文件（接口文档 15.1），服务端可以用它自测导出功能。

```bash
uv run python -m tools.validate --model 模型.glb --plan 规划.json --urdf 机械臂.urdf --tcp-link TCP连杆名
```

- 同时给出模型和规划文件时做交叉检查：ID、表面是否存在且可清洗、工艺段 TCP 点是否贴近模型表面。最后一项能发现 Y-up 转换、单位或坐标系不一致。
- 有失败路径 `failed_paths` 时检查格式、每段至少 2 个点、合计不超过 10 万点（接口文档 11.2）；给出模型时还检查所属表面和点是否贴近模型表面。
- 检查表面集合 `selected_surface_ids`、`planning_scope_surface_ids`（接口文档 11.2）：两个字段同时给出，不重复；有效选择、`surface_ids` 和失败路径的表面都在规划范围内；给出模型时还检查这些表面存在且可清洗。两个字段都没有时为警告（APP 按旧服务端的规划文件处理）。结果中列出有效选择、规划范围、扩展和没有生成路径的表面数量。
- 模型超过 500 个表面或 30 万三角面时为警告：服务端照常导出，APP 照常显示并产生本地警告（接口文档 10.2）。
- 给出 URDF 时检查关节名和关节范围；再给出 TCP 连杆名时，按正运动学核对工具末端是否沿 TCP 路径。
- 有错误时退出码为 1。同一问题只列出前 5 处，其余计数。

| 参数 | 说明 |
| --- | --- |
| `--model-id`、`--plan-id` | 期望的 ID |
| `--selected` | StartPlan 发送的 `surface_ids`，逗号分隔：检查有效选择是否为去掉重复的请求。规划全部时给 `""`，这时需要同时给出模型，检查有效选择是否为全部可清洗表面 |
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
| `--allow-power-on` | 机械臂未启动时从接口上电：受理后为启动中，重复上电被拒绝，结束后为就绪，结果为 POWER_ON SUCCEEDED。机械臂会上电并松开刹车；先于其他用例运行 |
| `--allow-estop` | 调用机械臂急停 Service，检查急停和软件急停锁存，再复位；与 `--allow-motion` 同时给出时在执行中急停：检查任务停在已暂停、复位后从中断处继续，再次急停后停止立即完成 |

| 其他参数 | 说明 |
| --- | --- |
| `--estop-service` | 机械臂急停 Service 的名称，默认 `/robot_driver/emergency_stop`（接口 6.7） |
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

## 网页版交付前检查 `web_check`

交付网页版之前（阶段规划 4.4）检查 `scripts/build-web.sh` 打出的压缩包：解压，用其中的启动脚本以无头 Chrome 打开页面，连接本机开发环境的 mock 服务端，用真实的鼠标事件逐项操作。只从界面和服务端状态判断，不依赖开发版的调试接口。

```bash
docker compose -f deploy/docker-compose.dev.yml up --build -d
uv run python -m tools.web_check delivery/<日期>/spatialview-web-<版本>.tar.gz \
    --password-file <工程入口密码文件> --out <输出目录>
```

工程入口的密码从文件读取，文件中只有这一行，不在命令行上给出，也不放进仓库。需要 Google Chrome 和至少 500 MB 可用内存，每一步之前检查可用内存，不足时停止。检查会用到 mock 的故障注入（连续扩展、部分无法规划、执行出错、执行加速），只能对开发环境运行。对小样例的开发环境，全部检查在本机约 2 分钟。

| 部分 | 检查内容 |
| --- | --- |
| 启动和工程入口 | 页面为安全上下文；长按 2 秒不弹出，错误密码被拒绝；面板底部的 APP 版本与压缩包名一致，期望接口版本与 `spatialview_msgs` 一致；默认把激光器视为已连接；改为本机开发环境的地址后重新加载并连接 |
| 规划范围（接口文档第 13 版） | 全部规划成功时不弹框，选面时没有规划范围；注入扩展 1 个时弹出"规划范围已扩展"，预选有效选择，扩展的表面为浅蓝色；扩展到全部可清洗表面并部分无法规划时，说明加在"部分路径未能规划"中，失败路径为红色，没有生成路径的表面有红色边框，工具条不挡住"恢复默认视角"；重新打开页面后不再提示 |
| 中断后继续 | 执行出错后停在已暂停，规划和进度保留，提示框带操作提示；继续需要确认，从中断处接着执行；停止后回到规划就绪 |
| 连续清洗 | 同一规划连续清洗两次到完成，每次都弹出"清洗完成"，回到规划就绪，"开始清洗""轨迹动画"仍可用（接口文档 6.5） |
| 轨迹动画 | 播放、拖到结尾播完、重新播放、退出，再次进入时从头播放。内存不足时可以用 `--no-animation` 跳过 |
| 结束 | 页面没有未捕获的异常；关闭浏览器后启动脚本退出，页面服务停止 |

| 参数 | 说明 |
| --- | --- |
| `--out` | 解压目录、截图、启动日志 `start.log` 和结果 `results.json` 的位置。解压目录中的浏览器数据保存着工程入口设置的地址，每次检查都要新解压，已有同名的解压目录时不运行 |
| `--rosbridge`、`--http` | 开发环境的地址，默认 `ws://127.0.0.1:9090`、`http://127.0.0.1:8080` |
| `--page-port`、`--cdp-port` | 启动脚本提供页面的端口（默认 8093）和 Chrome 的远程调试端口（默认 9397） |

有失败的检查或检查中断时退出码为 1，中断时在输出目录中保存截图 `failed.png`。

## 演示视频 `demo`

按分镜录制一段 APP 完整工作流程的视频（阶段规划阶段 13）：启动并连接，扫描与重建，旋转和缩放视角，选面，规划，轨迹动画，清洗（暂停、继续），清洗中急停与复位。使用圆台样例（`SAMPLE_SIZE=demo`），画面上只叠加触点标记，不加字幕；每段开始的时间写在 `timeline.txt`，便于之后配字幕或配音。

本机没有 GPU，实时录屏达不到 30 帧。工具接管页面的时钟（`clock.js`：定时器、动画帧、`performance.now`、`Date`），逐帧推进 1/30 秒后截图；每帧固定占用 `--frame-seconds` 秒的真实时间，mock 的耗时和执行（故障注入的 `speed`）、CSS 动画按同样的比例放慢，视频中的进度和动画与真实节奏一致。扫描、重建、规划和清洗的等待时间按分镜压缩。

```bash
SAMPLE_SIZE=demo docker compose -f deploy/docker-compose.dev.yml up -d --force-recreate
(cd app && NODE_ENV=development npx vite build --mode development --outDir dist-demo)
python3 -m http.server 4174 --directory app/dist-demo &
uv run python -m tools.demo --url http://127.0.0.1:4174/ --out demo-output
```

- 使用开发模式的构建：界面与打包产物相同，另有 `window.spatialviewScene`，用来求选面时要点的表面在屏幕上的位置。
- 开始时 mock 应刚启动（作业阶段为无模型）、机械臂没有急停；再次录制前先重启 mock：`docker compose -f deploy/docker-compose.dev.yml restart mock`。
- 需要 ffmpeg（`sudo apt install ffmpeg`）。中文字体为 Noto Sans CJK SC（`fonts-noto-cjk`），与平板相同。
- 页面为 1280 × 800 CSS 像素、`devicePixelRatio` 1.5，与目标平板相同；像素比用 Chrome 的启动参数设置，用 Emulation 模拟像素比时，Chrome 处理较慢的触摸移动事件时坐标有误。

| 参数 | 说明 |
| --- | --- |
| `--frame-seconds` | 每帧占用的真实时间，默认 1 秒，应大于本机绘制并截取一帧的时间；结束时打印超过它的帧数 |
| `--fps` | 帧率，默认 30 |
| `--quality` | 截图的 JPEG 质量，默认 92 |

输出在 `--out` 目录：`spatialview-demo.mp4`（H.264，1920 × 1200）、`timeline.txt` 和逐帧截图 `frames/`；录制失败时有 `failed.png`。
