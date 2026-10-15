#!/usr/bin/env bash
# 在本地执行与 CI（.github/workflows/ci.yml）相同的检查。修改其中一处时同步修改另一处。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== APP"
(
  cd app
  npm ci --no-audit --no-fund
  npm run lint
  npm run format:check
  npm run typecheck
  npm test
  npm run build
)

echo "== Python"
uv sync --locked
uv run ruff check .
uv run ruff format --check .
uv run pytest

echo "== ROS 2"
# 当前用户没有 Docker 权限时：DOCKER="sudo docker" scripts/check.sh
if ${DOCKER:-docker} info >/dev/null 2>&1; then
  scripts/ros.sh colcon build
  scripts/ros.sh python3 -c "from spatialview_msgs.msg import SystemState; assert SystemState.INTERFACE_VERSION == '1.0'"
  scripts/mock-selftest.sh
else
  echo "无法使用 Docker，跳过 ROS 2 构建"
fi

echo "== 工作流"
if command -v actionlint >/dev/null; then
  actionlint
else
  echo "未安装 actionlint，跳过工作流检查"
fi

echo "全部检查通过"
