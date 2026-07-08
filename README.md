# chain-builder — BNB Chain Ops

Real-time BSC mainnet monitoring & analysis dashboard. Single Node.js process serves
the built frontend + REST API + WebSocket on one port. No database, no Docker required.

## Subsystems

- **Home** — Validator Ring (turnLength=8 model), cluster health, chain-wide geth version mix, AI analysis, safety events
- **Monitor** — block gas / insert latency (4-node avg) / reorg
- **MEV** — builder market, v1/v2 (BEP-675) split, per-validator versions
- **Traffic** — gas utilization, TxPool depth, high-traffic episodes with per-episode AI attribution
- **Storage** — geth db inspect, compaction / write-stall
- **TXN 分析** — full-coverage tx classification (meme/DeFi/bot/stable/BNB/token/CEX/bridge/infra/…), gas-share vs tx-share, self-growing AI contract-label book
- **Alerts** — slash / block anomalies

## Quick start

```bash
cp .env.example .env      # fill in BSC_RPC_URL / keter / ANTHROPIC_API_KEY
bash start.sh             # builds frontend, starts backend on :$PORT (default 8080)
# open http://localhost:8080
```

## Environment (`.env`)

| var | purpose |
|-----|---------|
| `BSC_RPC_URL` / `BSC_WS_URL` | chain data source (nodereal w/ key, or internal fullnode w/ `eth_subscribe newHeads`). Falls back to public `bsc-dataseed.bnbchain.org` (rate-limited, no WSS) |
| `KETER_CONFIG_FILE` | keter metrics API auth (JSON w/ JWT); internal ELB only — without it the Monitor/Storage/Traffic keter panels are empty, the rest still works |
| `ANTHROPIC_API_KEY` | AI analyses shell out to the `claude` CLI (`claude -p`); server needs it installed & authenticated |
| `BSCSCAN_API_KEY` | optional — verified contract names for unknown addresses |
| `PORT` | listen port (default 8080) |

## Architecture

```
frontend (React + Vite + Canvas)  ──build──▶  backend/../frontend/dist
        ▲ REST /api/*  · WS /ws (same origin, same port)
backend (Node.js + Fastify)
  ├── BlockStreamer   WS newHeads, MEV enrich off the hot path
  ├── TxnSampler      full-coverage per-minute block scan → rule + AI classify
  ├── ChainContracts  ValidatorSet / SlashIndicator / StakeHub
  ├── KeterClient     cluster metrics (node_stats, gasused, latency, disk, reorg)
  └── AI              claude -p headless (network / traffic / txn / mev summaries)
```

See `DEPLOY.md` for the DevOps checklist (inbound/outbound, reverse proxy, resources)
and `docs/txn-classification.md` for the transaction classification rules.
