# BNB Chain Ops — 内网部署清单(给 DevOps)

单进程单端口应用:Fastify 同端口托管 前端静态(dist) + REST(`/api/*`) + WebSocket(`/ws`) + 健康检查(`/health`)。
无数据库、无 Docker 依赖。

## 1. 入站

| 项 | 值 | 说明 |
|---|---|---|
| 内网域名 | `bnbchain-ops.<内网域>`(申请) | HTTPS 443 → 反代应用端口 |
| 应用端口 | **8080/TCP**(`PORT` 可改) | 监听 `0.0.0.0` |
| 健康检查 | `GET /health` | `{ok, block, wsConnected}`;`block` 应持续递增(0.45s/块) |

反代(nginx/ALB)必须项:

```nginx
location /ws {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;                 # WebSocket upgrade
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_read_timeout 180s;                # /api/ai/* 为长请求(claude 分析 20~150s)
}
```

## 2. 出站白名单

| 用途 | 域名 | 端口 | 备注 |
|---|---|---|---|
| BSC 主网 RPC + WSS | `bsc-mainnet-ap.nodereal.io` | 443 | HTTPS 与 WSS 同域;可用内网 fullnode 替代(需 `eth_subscribe newHeads`、`eth_getHeaderByNumber`、近数日区块体,8545/8546) |
| Keter 指标 API | `keter-api.toolsapple.net` | 443 | 内网 ELB(ap-northeast-1),需内网 DNS 可解析 |
| Anthropic API(AI 分析) | `api.anthropic.com` | 443 | 官方 SDK(ANTHROPIC_API_KEY);不开通则仅 AI 按钮不可用,监控功能不受影响 |

## 3. 资源规格(基于本机实测)

| 项 | 实测 | 建议 |
|---|---|---|
| 内存 | 后端稳态 ~200 MB;AI 分析走进程内 SDK(HTTP 到 api.anthropic.com,无子进程),峰值增量很小 | **1 GB 起步 / 2 GB 舒适** |
| 磁盘 | 应用+依赖 ~120 MB;运行数据有界(txn 7d/latency 24h 等滚动 JSON,合计 <10 MB);日志 ~1-3 MB/天 | **5 GB**;日志走 journald/logrotate |
| CPU | 稳态极低(事件驱动 + 30s 轮询 + 1min 全量交易采样) | 2 vCPU |

无数据库;所有内存窗口/磁盘缓存均有界,不随运行时长增长。

## 4. 服务器环境与秘钥

- Node.js ≥ 20。AI 分析用后端依赖 `@anthropic-ai/sdk`(随 `npm install` 装),**不需要**全局装 claude CLI
- `backend/data/` 可写(txn/latency/txpool 等滚动缓存 + AI 学习的合约标签库)

```bash
PORT=8080
BSC_RPC_URL=https://bsc-mainnet-ap.nodereal.io/v1/<key>
BSC_WS_URL=wss://bsc-mainnet-ap.nodereal.io/ws/v1/<key>
KETER_CONFIG_FILE=/etc/bnbchain-ops/keter.json   # JWT;建议申请服务账号 token(勿用个人长效 token)
AI_BACKEND=claude-api                            # claude-api / codex-api / codex-py(见下)
ANTHROPIC_API_KEY=<key>                          # claude-api 用;ANTHROPIC_MODEL 可选(默认 claude-opus-4-8)
```

**AI 后端可选(`AI_BACKEND`)**:
- `claude-api`(默认推荐):官方 SDK + `ANTHROPIC_API_KEY`
- `codex-api`:OpenAI 兼容 API,Node raw fetch + `OPENAI_API_KEY` / `OPENAI_MODEL`
- `codex-py`:**Node 有问题(glibc 等)时用** —— 依赖只在 Python venv 里,Node 只负责 spawn:
  ```bash
  python3 -m venv ~/openai-venv && ~/openai-venv/bin/pip install -U openai
  # .env: AI_BACKEND=codex-py  PYTHON_BIN=~/openai-venv/bin/python  OPENAI_API_KEY=<key>  OPENAI_MODEL=gpt-5.5
  ```
  出站需放行 `api.openai.com:443`。

## 5. 启动

```bash
cd frontend && npm ci && npm run build          # 产出 dist,由后端托管
cd ../backend && npm ci
node src/server.js                              # 建议 systemd / pm2 托管,失败自动拉起
```

进程自愈能力:RPC 断连/机器休眠后 WS 僵死会在 ~10s 内自动重连并跳回链尖;keter 断连仅影响指标面板,恢复后 30s 内自动补齐。

## 6. 暂不需要

- 无入站公网暴露需求(纯内网)
- 认证(v1.x 计划接公司 SSO,届时需追加 OAuth 回调域名一条)
