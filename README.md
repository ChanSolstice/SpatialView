# SpatialView

现场操作员使用的 Android 平板 APP：发起扫描，浏览重建出的工件模型，选择表面并发起路径规划，查看 TCP 路径和轨迹动画，控制清洗任务。机械臂为 AUBO i5H，平板为 Chainway P100（Android 14），全部算法、状态判断和设备控制都在服务端完成。

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
| `tools/` | 样例数据生成、文件校验、接口检查、8 小时测试、网页版交付前检查 |
| `scripts/` | 本地检查脚本、Android 和网页版的打包脚本 |
| `docs/` | 文档、图和静态原型 |

## 环境要求

| 工具 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | 24 LTS，见 `app/.nvmrc` | APP |
| uv | 0.12 及以上 | Python 3.10 环境，会自动下载 Python 3.10 |
| Docker | 带 compose 插件 | ROS 2 Humble 的构建和开发环境（阶段 3 起） |
| JDK、Android SDK | JDK 21；SDK 的 platform 36 和 build-tools | 打包 Android APP，`ANDROID_HOME` 默认为 `~/Android/Sdk` |
| Google Chrome | — | 8 小时测试、网页版交付前检查（本机无头 Chrome） |
| actionlint | 可选 | 本地检查 CI 工作流 |

## 常用命令

```bash
# APP
cd app
npm ci              # 按 package-lock.json 安装依赖
npm run dev         # 开发服务器，连接本机的开发环境（app/.env.development）
npm test            # 单元测试
npm run build       # 类型检查并构建
SPATIALVIEW_CONTRACT_ROSBRIDGE=ws://localhost:9090 npm run test:contract   # 接口约定测试，需要开发环境

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

# Android APP：debug 包开启 WebView 远程调试；release 包需要签名密钥
scripts/build-apk.sh debug
scripts/build-apk.sh release

# 网页版：没有平板时在 Ubuntu 电脑上用 Chrome 测试服务端，压缩包输出到 delivery/
scripts/build-web.sh
# 网页版的交付前检查：需要开发环境，用法见 tools/README.md
uv run python -m tools.web_check delivery/spatialview-web-<版本>.tar.gz --password-file <密码文件> --out <输出目录>

# 与 CI 相同的全部检查
./scripts/check.sh
```

### Android 打包

`scripts/build-apk.sh` 依次执行 `npm run build`、`npx cap sync android` 和 Gradle（架构设计 5.10），最后输出 APK 的位置、版本号和 SHA-256，交付时记录。release 包的签名密钥不放进仓库，用环境变量给出：

| 环境变量 | 说明 |
| --- | --- |
| `SPATIALVIEW_KEYSTORE` | 密钥库文件的路径 |
| `SPATIALVIEW_KEYSTORE_PASSWORD`、`SPATIALVIEW_KEY_ALIAS`、`SPATIALVIEW_KEY_PASSWORD` | 密钥库密码、密钥别名、密钥密码 |
| `VITE_ENABLE_ENGINEERING` | 为 `true` 时启用工程入口（需求 10.3） |
| `SPATIALVIEW_ENGINEERING_PASSWORD` | 工程入口的密码，启用工程入口时必须给出；产物中只有它的 SHA-256 |

版本号写在 `app/package.json`，versionCode 由它算出。

当前用户没有 Docker 权限时，在命令前加 `DOCKER="sudo docker"`，例如 `DOCKER="sudo docker" ./scripts/check.sh`。

### 网页版打包

网页版与 APK 中的页面相同，用于没有平板时在 Ubuntu 电脑上用 Chrome 测试服务端（架构设计 5.10）。`scripts/build-web.sh` 执行 `npm run build`，把页面和 `app/web/` 中的启动脚本、说明打成压缩包，默认输出到 `delivery/spatialview-web-<版本>.tar.gz`，最后输出 SHA-256，交付时记录。启用工程入口的环境变量与 Android 打包相同。

启动脚本在本机 127.0.0.1 上提供页面，用 Chrome 或 Chromium 的应用窗口打开，用法见 [app/web/README.md](app/web/README.md)。

交付前用 `tools/web_check` 检查压缩包（[tools/README.md](tools/README.md)）：用启动脚本打开页面，连接本机开发环境，检查工程入口、版本号、规划范围、中断后继续、连续清洗和轨迹动画。交付记录在[阶段规划](docs/阶段规划.md) 4.4。

## 分支

| 分支 | 用途 |
| --- | --- |
| `main` | 稳定版本 |
| `dev` | 开发主线，GitHub 上的默认分支 |
| `phase/<编号>-<名称>` | 每个阶段一个分支，完成并验证后合并回 `dev`；进度记录在[阶段规划](docs/阶段规划.md) |
