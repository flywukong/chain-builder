# chain-builder — BNB Chain Ops

Real-time BSC mainnet monitoring & analysis dashboard. Single Node.js process serves
the built frontend + REST API + WebSocket on one port. No database, no Docker required.

## Subsystems

- **Home** — Validator Ring (turnLength=8 model), cluster health, chain-wide geth version mix, AI analysis, safety events
- **Monitor** — block gas / insert latency (4-node avg) / reorg
- **MEV** — builder market, v1/v2 (BEP-675) split, per-validator versions
- **Traffic** — gas utilization, TxPool depth, high-traffic episodes with per-episode AI attribution
- **Storage** — geth db inspect, compaction / write-stall
- **TXN 分析** — persisted contiguous block collection, receipt-backed V2 activity/features, explicit window coverage, and a legacy classification view
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
| `ANTHROPIC_API_KEY` | AI analyses use the official Anthropic SDK when set (server deploy). Unset → falls back to the local `claude` CLI (dev only). `ANTHROPIC_MODEL` overrides the default `claude-opus-4-8` |
| `BSCSCAN_API_KEY` | optional — verified contract names for unknown addresses |
| `PORT` | listen port (default 8080) |

## Architecture

```
frontend (React + Vite + Canvas)  ──build──▶  backend/../frontend/dist
        ▲ REST /api/*  · WS /ws (same origin, same port)
backend (Node.js + Fastify)
  ├── BlockStreamer   WS newHeads, MEV enrich off the hot path
  ├── TxnSampler      persisted contiguous block scan → receipt-backed V2 classify
  ├── ChainContracts  ValidatorSet / SlashIndicator / StakeHub
  ├── KeterClient     cluster metrics (node_stats, gasused, latency, disk, reorg)
  └── AI              claude -p headless (network / traffic / txn / mev summaries)
```

See `DEPLOY.md` for the DevOps checklist (inbound/outbound, reverse proxy, resources)
and `docs/txn-classification.md` for the transaction classification rules.

## TXN 20-day backfill

The dashboard enables a time range only after the current classifier version has
continuous data for that whole range. To seed 20 days of V2 history and let the
30-day range become available through subsequent online accumulation, stop the monitor
and run the resumable offline backfill against an archive/full RPC:

```bash
cd backend
TXN_BACKFILL_CONFIRM=YES \
TXN_BACKFILL_DAYS=20 \
BSC_RPC_URL=http://your-archive-node:8545 \
npm run backfill:txn
```

The RPC must support historical `eth_getBlockByNumber` and `eth_getBlockReceipts`.
The backfill uses the production V2 classifier, checkpoints progress, and only replaces
V2 hourly dimensions after the fixed block range completes. Do not run it concurrently
with the monitor because both processes write `backend/data/txn-7d.json`.
Completed checkpoints are retained for audit. To deliberately create a fresh snapshot
after rules or label evidence change, add `TXN_BACKFILL_RESET=YES`; the previous files
are renamed with an `.audit-*` suffix rather than deleted.
