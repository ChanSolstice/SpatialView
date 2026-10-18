#!/usr/bin/env bash
# 打包 Android APP（架构设计 5.10）：npm run build → npx cap sync android → Gradle。
#
#   scripts/build-apk.sh            # debug 包，开启 WebView 远程调试
#   scripts/build-apk.sh release    # 签名的 release 包
#
# 需要 JDK 21 和 Android SDK（ANDROID_HOME，默认 ~/Android/Sdk）。release 包的签名密钥不放进仓库，
# 用环境变量给出：SPATIALVIEW_KEYSTORE、SPATIALVIEW_KEYSTORE_PASSWORD、SPATIALVIEW_KEY_ALIAS、
# SPATIALVIEW_KEY_PASSWORD。启用工程入口时另外设置 VITE_ENABLE_ENGINEERING=true 和
# SPATIALVIEW_ENGINEERING_PASSWORD（打包时只写入摘要）。
set -euo pipefail
cd "$(dirname "$0")/../app"
type=${1:-debug}
case "$type" in
  debug) task=assembleDebug ;;
  release) task=assembleRelease ;;
  *)
    echo "用法：$0 [debug|release]" >&2
    exit 2
    ;;
esac
if [ "$type" = release ] && [ -z "${SPATIALVIEW_KEYSTORE:-}" ]; then
  echo "release 包需要签名密钥：设置 SPATIALVIEW_KEYSTORE 等环境变量（见本文件开头）" >&2
  exit 2
fi
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Android/Sdk}

npm run build
npx cap sync android
(cd android && ./gradlew --no-daemon "$task")

apk=$(find android/app/build/outputs/apk/"$type" -name '*.apk' | head -n 1)
version=$(node -p "require('./package.json').version")
echo "APK：app/$apk（版本 $version）"
