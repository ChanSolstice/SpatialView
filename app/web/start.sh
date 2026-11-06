#!/usr/bin/env bash
# SpatialView 网页版：在本机提供页面，用 Chrome 或 Chromium 的应用窗口打开，关闭窗口后退出。
# 页面与 APK 中的相同，用于没有平板时在电脑上测试服务端，用法见同目录的 README.md。
#
#   ./start.sh                         # 页面端口 8090
#   SPATIALVIEW_PORT=8091 ./start.sh   # 换一个页面端口
#   ./start.sh --参数 ...              # 其余参数原样传给浏览器
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
port=${SPATIALVIEW_PORT:-8090}

browser=${SPATIALVIEW_BROWSER:-}
if [ -z "$browser" ]; then
  for name in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$name" >/dev/null; then
      browser=$name
      break
    fi
  done
fi
if [ -z "$browser" ]; then
  echo "找不到 Google Chrome 或 Chromium，请先安装（见 README.md）" >&2
  exit 1
fi

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; }
if port_open; then
  echo "端口 $port 已被占用，可能已经打开了一个 SpatialView；可以用 SPATIALVIEW_PORT 换一个端口" >&2
  exit 1
fi

# 页面只在 127.0.0.1 上提供，也从这个地址打开：平板上页面的地址同样是本机（http://localhost），
# 访问服务端属于跨域访问；工程入口校验密码用的 crypto.subtle 也只在本机地址或 https 的页面中可用
log=$(mktemp)
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$here/dist" >"$log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true; rm -f "$log"' EXIT
for _ in $(seq 50); do
  port_open && break
  if ! kill -0 "$server" 2>/dev/null; then
    echo "无法在端口 $port 上提供页面：" >&2
    cat "$log" >&2
    exit 1
  fi
  sleep 0.1
done
if ! port_open; then
  echo "页面服务没有在 5 秒内启动" >&2
  exit 1
fi

url="http://127.0.0.1:$port/"
echo "SpatialView：$url，关闭窗口后退出"
# 浏览器的数据（包括工程入口保存的配置）放在 profile/，与平时使用的浏览器分开。
# --password-store=basic：不使用系统钥匙环，避免启动时要求解锁；
# --enable-unsafe-swiftshader：没有可用的 GPU 时（例如虚拟机）允许用软件渲染 WebGL，否则三维区无法显示
"$browser" \
  --app="$url" \
  --window-size=1280,800 \
  --user-data-dir="$here/profile" \
  --no-first-run \
  --no-default-browser-check \
  --password-store=basic \
  --enable-unsafe-swiftshader \
  "$@"
