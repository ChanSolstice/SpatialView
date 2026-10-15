#!/usr/bin/env bash
# 重新生成 docs/前端UI设计.md 中的画面截图。需要 Google Chrome，并能访问 cdn.jsdelivr.net（加载 three.js）。
set -euo pipefail
cd "$(dirname "$0")"
out=../assets/ui
mkdir -p "$out"
for id in plan-ready no-model scanning select animation executing confirm result rejected alarms disconnected estop-failed; do
  google-chrome --headless=new --no-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader \
    --hide-scrollbars --window-size=1280,800 --virtual-time-budget=10000 \
    --screenshot="$out/$id.webp" "file://$PWD/index.html?capture=1&screen=$id" >/dev/null 2>&1
  echo "$out/$id.webp"
done
