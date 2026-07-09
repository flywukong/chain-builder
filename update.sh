#!/usr/bin/env bash
# update.sh — 服务器一键更新:拉代码 → 重建前端 dist → 重启服务 → 自检
# 用法:cd /server/leo/chain-builder && ./update.sh
# 关键:dist 是 .gitignore 忽略的,git pull 不会更新它,必须 npm run build 重新生成。
set -euo pipefail

cd "$(dirname "$0")"
PORT="${PORT:-8080}"
echo "▶ repo: $(pwd)"

echo "▶ git pull…"
git pull --ff-only

echo "▶ frontend build…"
pushd frontend >/dev/null
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  echo "  npm install…"
  npm install
fi
npm run build
popd >/dev/null

echo "▶ restart service…"
if systemctl cat bsc-monitor.service &>/dev/null; then
  systemctl restart bsc-monitor
  echo "  systemd: bsc-monitor restarted"
else
  lsof -ti ":$PORT" | xargs -r kill -9 || true
  nohup bash start.sh > run.log 2>&1 &
  echo "  nohup: start.sh relaunched"
fi

echo "▶ verify…"
sleep 3
echo -n "  health: "; curl -s "localhost:$PORT/health" || echo "(no response)"; echo
echo -n "  bundle: "; { curl -s "localhost:$PORT/" | grep -o 'index-[A-Za-z0-9_-]*\.js' | head -1; } || echo "(none)"
echo "✅ done — 浏览器 Cmd+Shift+R 硬刷新"
