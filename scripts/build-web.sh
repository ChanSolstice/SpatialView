#!/usr/bin/env bash
# 打包网页版：npm run build 之后，把页面、启动脚本和说明（app/web/）打成压缩包，
# 没有平板时在 Ubuntu 电脑上用 Chrome 测试服务端。页面与 APK 中的相同。
#
#   scripts/build-web.sh [输出目录]   # 默认输出 delivery/spatialview-web-<版本>.tar.gz
#
# 启用工程入口时另外设置 VITE_ENABLE_ENGINEERING=true 和 SPATIALVIEW_ENGINEERING_PASSWORD
# （打包时只写入摘要），同 build-apk.sh。
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$root/delivery}
mkdir -p "$out"
out=$(cd "$out" && pwd)
cd "$root/app"
version=$(node -p "require('./package.json').version")
name=spatialview-web-$version

npm run build

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/$name"
cp -R dist "$stage/$name/dist"
cp web/start.sh web/README.md "$stage/$name/"
tar -czf "$out/$name.tar.gz" -C "$stage" "$name"

# 交付记录（阶段规划 4.4）：压缩包的位置和 SHA-256
echo "压缩包：$out/$name.tar.gz"
echo "SHA-256：$(sha256sum "$out/$name.tar.gz" | cut -d ' ' -f 1)"
