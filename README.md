# SpatialView

现场操作员使用的 Android 平板 APP：发起扫描，浏览重建出的工件模型，选择表面并发起路径规划，查看 TCP 路径和轨迹动画，控制清洗任务。机械臂为 AUBO i5H（控制系统 ARCS 0.31.1-rc.5），全部算法、状态判断和设备控制都在服务端完成。

## 文档

| 文档 | 内容 |
| --- | --- |
| [需求文档](docs/需求文档.md) | APP 的界面和交互 |
| [服务端对接接口文档](docs/服务端对接接口文档.md) | APP 与服务端之间唯一的接口约定 |
| [架构设计](docs/架构设计.md) | 部署、仓库结构、APP 内部架构、mock 服务端、测试 |
| [前端UI设计](docs/前端UI设计.md) | 视觉规范；静态原型见 [docs/prototype/index.html](docs/prototype/index.html) |
| [阶段规划](docs/阶段规划.md) | 开发阶段和进度 |

## 目录

| 目录 | 内容 |
| --- | --- |
| `app/` | APP：Vite + React + TypeScript，three.js 三维场景，Capacitor 打包 |
| `ros2_ws/src/` | ROS 2 Humble 包：接口定义包 `spatialview_msgs`、mock 服务端 `spatialview_mock` |
| `deploy/` | 开发用服务端环境：rosbridge、mock、nginx |
| `tools/` | 样例数据生成、文件校验、接口检查 |
| `scripts/` | 本地检查脚本 |
| `docs/` | 文档、图和静态原型 |

## 环境要求

| 工具 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | 24 LTS，见 `app/.nvmrc` | APP |
| uv | 0.12 及以上 | Python 3.10 环境，会自动下载 Python 3.10 |
| Docker | 带 compose 插件 | ROS 2 Humble 的构建和开发环境（阶段 3 起） |
| actionlint | 可选 | 本地检查 CI 工作流 |

## 常用命令

```bash
# APP
cd app
npm ci              # 按 package-lock.json 安装依赖
npm run dev         # 开发服务器
npm test            # 单元测试
npm run build       # 类型检查并构建

# Python 工具（在仓库根目录），用法见 tools/README.md
uv sync             # 按 uv.lock 安装依赖
uv run pytest       # 测试
uv run ruff check . # 代码检查
uv run python -m tools.sample_data --size large   # 生成样例到 samples/large
uv run python -m tools.validate --model 模型.glb --plan 规划.json

# 开发用服务端环境：rosbridge、mock、nginx，用法见 deploy/README.md
docker compose -f deploy/docker-compose.dev.yml up --build -d
uv run python -m tools.interface_check     # 接口检查，用法见 tools/README.md

# ROS 2 包：在 ros:humble 容器中执行（需要 Docker）
scripts/ros.sh colcon build
scripts/ros.sh ros2 interface show spatialview_msgs/msg/SystemState

# 与 CI 相同的全部检查
./scripts/check.sh
```

当前用户没有 Docker 权限时，在命令前加 `DOCKER="sudo docker"`，例如 `DOCKER="sudo docker" ./scripts/check.sh`。

## 分支

| 分支 | 用途 |
| --- | --- |
| `main` | 稳定版本 |
| `dev` | 开发主线 |
| `phase/<编号>-<名称>` | 每个阶段一个分支，完成并验证后合并回 `dev`；进度记录在[阶段规划](docs/阶段规划.md) |
