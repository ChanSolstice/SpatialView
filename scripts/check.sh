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

echo "== 工作流"
if command -v actionlint >/dev/null; then
  actionlint
else
  echo "未安装 actionlint，跳过工作流检查"
fi

echo "全部检查通过"
