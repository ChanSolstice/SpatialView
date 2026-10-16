#!/usr/bin/env bash
# 启动开发用服务端环境（deploy/docker-compose.dev.yml），运行接口检查工具的全部用例和 APP 的接口约定测试，
# 然后关闭。使用独立的项目名和本机端口（19090、18080），不影响正在运行的开发环境。
# APP 的接口约定测试需要先在 app/ 中安装依赖（npm ci）。
#
#   scripts/dev-env-check.sh
#   COMPOSE="sudo docker-compose" scripts/dev-env-check.sh     # 没有 Docker 权限或没有 compose 插件时
set -euo pipefail
cd "$(dirname "$0")/.."
read -r -a COMPOSE <<<"${COMPOSE:-docker compose}"
ENV_FILE=$(mktemp)
trap 'rm -f "$ENV_FILE"' EXIT
cat >"$ENV_FILE" <<VARS
MOCK_SPEED=${MOCK_SPEED:-5}
ROSBRIDGE_PORT=19090
HTTP_PORT=18080
ROS_DOMAIN_ID=${ROS_DOMAIN_ID:-41}
VARS
DC=("${COMPOSE[@]}" -p spatialview-check -f deploy/docker-compose.dev.yml --env-file "$ENV_FILE")
cleanup() {
  "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

"${DC[@]}" up --build -d
if ! uv run python -m tools.interface_check --rosbridge ws://localhost:19090 --http http://localhost:18080 \
  --connect-timeout 90 --allow-motion --allow-laser --allow-estop \
  --urdf app/public/robot/aubo_i5H_dev.urdf --tcp-link tcp_link; then
  "${DC[@]}" logs --no-color --tail 40
  exit 1
fi
if ! (cd app && SPATIALVIEW_CONTRACT_ROSBRIDGE=ws://localhost:19090 npm run --silent test:contract); then
  "${DC[@]}" logs --no-color --tail 40
  exit 1
fi
