# deploy

开发用服务端环境（架构设计 8.1）：用 docker compose 启动 rosbridge、mock 服务端、模拟驱动和 nginx。APP 开发和测试时连接它；服务端团队也可以用它对照接口行为。

## 启动

```bash
docker compose -f deploy/docker-compose.dev.yml up --build -d
```

APP 的配置（需求文档 10.2）：`rosbridge_url` 为 `ws://<本机 IP>:9090`，`http_base_url` 为 `http://<本机 IP>:8080`。

| 服务 | 内容 |
| --- | --- |
| `rosbridge` | rosbridge_websocket，参数和白名单与接口文档 14.2 一致，不启动 rosapi；开发环境额外放行故障注入服务 `/spatialview_mock/inject` |
| `mock` | mock 服务端（`ros2_ws/src/spatialview_mock`） |
| `driver` | 模拟驱动：急停 Service 和软件急停锁存 |
| `nginx` | 文件服务，配置与接口文档 14.3 一致 |

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SAMPLE_SIZE` | `small` | 样例规模：`small` 用于日常开发，`large`（约 30 万三角面、10 万点）用于性能验证 |
| `MOCK_SPEED` | `1` | 扫描、重建、规划和执行的加速倍率 |
| `ROSBRIDGE_PORT`、`HTTP_PORT` | `9090`、`8080` | 本机端口 |
| `ROS_DOMAIN_ID` | `0` | 与同一网络中的其他 ROS 2 系统隔离 |

## 常用操作

```bash
DC="docker compose -f deploy/docker-compose.dev.yml"
$DC logs -f mock                    # 查看 mock 服务端的日志：每次指令调用、故障注入
$DC restart mock                    # 服务端程序重启（接口文档 15.4 场景 3）
$DC stop driver                     # 机械臂驱动离线；$DC start driver 恢复
$DC down -v                         # 停止，并清空文件目录和急停锁存

# 故障注入（动作和参数见 ros2_ws/src/spatialview_mock/README.md）
$DC exec mock /entrypoint.sh ros2 service call /spatialview_mock/inject \
  spatialview_mock_msgs/srv/Inject "{action: 'robot_protective_stop', args: ''}"
```

故障注入服务也已在开发环境的 rosbridge 中放行，可以从浏览器或调试工具经 rosbridge 调用。

## 接口检查

```bash
uv run python -m tools.interface_check --allow-motion --allow-laser --allow-estop   # 对正在运行的开发环境
scripts/dev-env-check.sh            # 用独立的项目名和端口启动一套环境，运行全部用例后关闭（CI 使用）
```

当前用户没有 Docker 权限、或没有 compose 插件时，用 `COMPOSE` 指定命令，例如 `COMPOSE="sudo docker-compose" scripts/dev-env-check.sh`。

## 文件

| 文件 | 说明 |
| --- | --- |
| `docker-compose.dev.yml` | 开发环境 |
| `rosbridge.launch.py` | rosbridge 的启动参数。`dev:=false`（默认）时与现场部署完全相同，服务端团队可以直接参考 |
| `nginx/spatialview.conf` | 文件服务的 nginx 配置 |
| `dev/Dockerfile`、`dev/entrypoint.sh` | 开发镜像：ROS 2 Humble、rosbridge、ros2_ws 和样例数据 |
