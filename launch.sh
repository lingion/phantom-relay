#!/bin/bash
# Phantom Relay Launcher
# 用此脚本启动 Chrome Canary 以自动加载 Phantom Relay 扩展
# 用法: ./launch.sh [url]

URL="${1:-https://www.doubao.com/chat/}"

# 如果 Chrome Canary 已在运行，先退出
if pgrep -f "Google Chrome Canary" > /dev/null; then
    echo "Stopping Chrome Canary..."
    osascript -e 'tell application "Google Chrome Canary" to quit'
    sleep 3
fi

echo "Launching Chrome Canary with Phantom Relay..."
open -a "Google Chrome Canary" --args \
    --load-extension="$(cd "$(dirname "$0")" && pwd)/extension" \
    "$URL"

sleep 2
echo "✅ Phantom Relay loaded. Open doubao.com and click the 👻 icon."
