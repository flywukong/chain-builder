#!/bin/bash
# BNB Chain Ops — 单进程部署(前端 dist + API + WS 同端口)
# 用法: cp .env.example .env && 填好 → bash start.sh → 打开 http://<host>:$PORT
set -e
cd "$(dirname "$0")"

# 加载 .env(不入库;放 RPC key / keter 路径 / ANTHROPIC_API_KEY 等)
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

echo "==> 构建前端..."
( cd frontend && npm install --silent && npm run build )

echo "==> 启动后端(同时托管前端 dist)..."
cd backend
npm install --silent

export PORT="${PORT:-8080}"
# BSC_RPC_URL / BSC_WS_URL / KETER_CONFIG_FILE / ANTHROPIC_API_KEY / BSCSCAN_API_KEY
# 从 .env 或环境变量读取;未设时 config.js 用公共节点兜底(限流)

echo ""
echo "  ✅ http://localhost:$PORT  (PORT=$PORT)"
echo ""
node src/server.js
