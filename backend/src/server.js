/**
 * BSC Monitor backend server
 * - WebSocket: real-time block events → frontend
 * - REST: snapshot queries (slash, node stats, keter metrics)
 */

import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import { BlockStreamer } from "./block/streamer.js";
import { ChainContracts } from "./chain/contracts.js";
import { fetchNodeStats, fetchGasUsed, fetchLatencySnapshot, fetchDiskAlerts, fetchTxpoolSnapshot, fetchReorgStats, fetchReorgTimeline, fetchBlockGas, fetchTrafficTimeline, fetchSyncErrors, fetchDbStats, fetchInsertLatency, fetchBidMetrics } from "./keter/metrics.js";
import { sampleBlockContracts } from "./ai/evidence.js";
import { LatencyStore } from "./metrics/latencyStore.js";
import { TxpoolStore } from "./metrics/txpoolStore.js";
import { EmptyBlockStore } from "./metrics/emptyStore.js";
import { ReorgObsStore } from "./metrics/reorgStore.js";
import { SlashEventStore } from "./metrics/slashEventStore.js";
import { MevAggregator } from "./mev/aggregator.js";
import { runAnalysis, runTrafficAnalysis, runTxpoolAnalysis, runMevAnalysis, runEmptyAnalysis, runAsk, runContractLabeling, runTxnFeatureAnalysis } from "./ai/analyze.js";
import { VALIDATORS } from "../../frontend/src/data/validators.js";
import { LabelBook } from "./txn/labels.js";
import { TxnStore } from "./txn/store.js";
import { TxnSampler } from "./txn/sampler.js";
import { lookupSelectors } from "./txn/siglookup.js";
import { getAddrIntel, getCachedIntel } from "./txn/addrIntel.js";
import { loadConfig } from "./config.js";

// slash 事件归属:AI 需区分内部运营(需排查)与外部 validator(协议自动惩罚,不干预)
const validatorInfo = (addr) => {
  const v = VALIDATORS[(addr || "").toLowerCase()];
  return { name: v?.name ?? null, internal: v?.group === "internal" };
};

const cfg = loadConfig();
const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
const contracts = new ChainContracts(provider);
const streamer  = new BlockStreamer({ wsUrl: cfg.wsUrl, rpcUrl: cfg.rpcUrl });
const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../data");
const mevAgg    = new MevAggregator({ file: path.join(dataDir, "mev-day.json") });   // continuous, tip-following (fed by streamer blocks)
const latencyStore = new LatencyStore(path.join(dataDir, "latency-24h.json"));
const txpoolStore  = new TxpoolStore(path.join(dataDir, "txpool-24h.json"));
const emptyStore   = new EmptyBlockStore(path.join(dataDir, "empty-24h.json"));
const reorgObs     = new ReorgObsStore(path.join(dataDir, "reorg-obs-24h.json"));
const slashEvents  = new SlashEventStore(path.join(dataDir, "slash-events-24h.json"));
// 交易分析子系统:1min/块 采样 → 规则分类 → AI 归类未知热门合约(标签库滚雪球)
const labelBook  = new LabelBook(path.join(dataDir, "contract-labels.json"));
const txnStore   = new TxnStore(path.join(dataDir, "txn-7d.json"));
const txnSampler = new TxnSampler({ provider, store: txnStore, labelBook });

// validatorSlashed(address) 事件扫描(SlashIndicator 0x…1001)
const SLASH_ADDR  = "0x0000000000000000000000000000000000001001";
const SLASH_TOPIC = "0xddb6012116e51abf5436d956a4f0ebd927e92c576ff96d7918290c8782291e3e";
async function scanSlashEvents() {
  try {
    const tip = streamer.lastNumber ?? await provider.getBlockNumber();
    if (!tip) return;
    const dayBlocks = Math.floor((24 * 3600e3) / 450);   // ~192k 块
    let from = slashEvents.lastScanned + 1;
    if (!slashEvents.lastScanned || tip - from > dayBlocks) from = tip - dayBlocks;
    if (from > tip) return;
    const now = Date.now();
    const CHUNK = 45_000;
    const found = [];
    for (let a = from; a <= tip; a += CHUNK) {
      const b = Math.min(a + CHUNK - 1, tip);
      const logs = await provider.getLogs({ address: SLASH_ADDR, topics: [SLASH_TOPIC], fromBlock: a, toBlock: b });
      for (const l of logs) {
        found.push({
          t: now - (tip - l.blockNumber) * 450,   // 0.45s/块 估算时间,展示足够
          block: l.blockNumber,
          validator: "0x" + l.topics[1].slice(26),
          tx: l.transactionHash,
        });
      }
    }
    slashEvents.addBatch(found, tip);
    broadcast("slashEvents", slashEvents.view());
  } catch (err) {
    console.error("[slash events scan]", err.message);
  }
}

// 链级 reorg 24h 计数:来自 14d 时间线(已按 ≥2 节点过滤,单节点本地事件不计)
const reorg24hFiltered = () => {
  const evs = latest.reorgTimeline?.events ?? [];
  const cut = Date.now() - 24 * 3600e3;
  return evs.filter((e) => e.t >= cut).reduce((s2, e) => s2 + (e.count || 0), 0);
};

// streamer 的 5min 窗口统计 + 24h 空块计数
const windowStatsPlus = () => {
  const w = streamer.getWindowStats();
  return w ? { ...w, empty24h: emptyStore.view().count } : w;
};

// Clients subscribed via WebSocket
const wsClients = new Set();

// Latest poll results, cached so a freshly-connected client gets a full snapshot
// immediately instead of waiting up to 30–60s for the next poll tick.
const latest = {
  slashStatus: [],
  nodeStats:   [],
  gasUsed:     {},
  latency:     {},
  diskAlerts:  [],
  mevStats:      null,
  txpool:        null,
  reorgStats:    null,
  reorgTimeline: null,
  blockGas:      null,
  trafficTimeline: null,
  syncErrors:    null,
  slashEvents:   null,
};

function broadcast(type, data) {
  if (type in latest) latest[type] = data;   // keep cache in sync with every push
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ── Start block streaming ──────────────────────────────────────────────────
streamer.on("block", (block) => {
  broadcast("block", block);
  if (block.empty) emptyStore.add(block.timestampMs ?? Date.now(), block.number, block.miner);
  // Every 10 blocks push window stats (~4.5s @ 0.45s blocks)
  if (block.number % 10 === 0) {
    broadcast("windowStats", windowStatsPlus());
  }
});
// MEV aggregator fed by enriched blocks (async, off the tip path)
streamer.on("blockMev", (block) => mevAgg.add(block));
streamer.on("reorg", (info) => {
  console.warn("[streamer] reorg", info);
  reorgObs.add(info.from, info.to, info.depth ?? 1);   // 本机观测高度(24h)
  broadcast("reorg", info);
});
streamer.on("status", (s) => console.log("[streamer] status", s));
streamer.on("error", (err) => console.error("[streamer]", err.message));
streamer.start().catch(console.error);

// ── MEV stats broadcast (aggregated from the live block stream, every 5s) ──
setInterval(() => {
  const s = mevAgg.getStats();
  if (s) broadcast("mevStats", s);
}, 5000);

// ── Periodic keter polling (every 30s) ─────────────────────────────────────
async function pollKeter() {
  try {
    const [nodeStats, gasUsed, latVals, diskAlerts, txVals, reorgStats, blockGas, syncErrors, tiers] = await Promise.all([
      fetchNodeStats(cfg.keterConfigPath),
      fetchGasUsed(cfg.keterConfigPath),
      fetchLatencySnapshot(cfg.keterConfigPath),
      fetchDiskAlerts(cfg.keterConfigPath),
      fetchTxpoolSnapshot(cfg.keterConfigPath),
      latest.reorgTimeline ? Promise.resolve({ reorg24h: reorg24hFiltered(), source: "keter · ≥2节点" }) : fetchReorgStats(cfg.keterConfigPath),
      fetchBlockGas(cfg.keterConfigPath),
      fetchSyncErrors(cfg.keterConfigPath),
      contracts.getValidatorTiers().catch((e) => { console.error("[tiers]", e.message); return null; }),
    ]);
    // 节点分层:cabinet(当前出块) / candidate(当选未出块) / inactive
    if (tiers) {
      const mining = new Set(tiers.mining), elected = new Set(tiers.elected);
      for (const n of nodeStats) {
        const eb = (n.etherbase || "").toLowerCase();
        n.tier = mining.has(eb) ? "cabinet" : elected.has(eb) ? "candidate" : "inactive";
      }
    }
    const now = Date.now();
    latencyStore.addSample(now, latVals);            // app-side 24h rolling caches
    txpoolStore.addSample(now, txVals);
    broadcast("nodeStats",  nodeStats);
    broadcast("gasUsed",    gasUsed);
    broadcast("latency",    latencyStore.getView());
    broadcast("diskAlerts", diskAlerts);
    broadcast("txpool",     txpoolStore.getView());
    broadcast("reorgStats", reorgStats);
    broadcast("blockGas",   blockGas);
    broadcast("syncErrors", syncErrors);
  } catch (err) {
    console.error("[keter poll]", err.message);
  }
}
pollKeter();
setInterval(pollKeter, 30_000);

// ── Heavy range-query timelines (reorg 14d / traffic 30d) — every 10 min ───
async function pollTimelines() {
  try { broadcast("reorgTimeline", await fetchReorgTimeline(cfg.keterConfigPath)); }
  catch (err) { console.error("[reorg timeline poll]", err.message); }
  try { broadcast("trafficTimeline", await fetchTrafficTimeline(cfg.keterConfigPath)); }
  catch (err) { console.error("[traffic timeline poll]", err.message); }
}
pollTimelines();
setInterval(pollTimelines, 600_000);

// ── Periodic slash polling (every 60s) ─────────────────────────────────────
async function pollSlash() {
  try {
    const slashStatus = await contracts.getSlashStatus();
    broadcast("slashStatus", slashStatus);
  } catch (err) {
    console.error("[slash poll]", err.message);
  }
}
pollSlash();
setInterval(pollSlash, 60_000);

// ── 交易采样(1min/块)+ AI 合约归类(6h 批,标签库滚雪球)─────────────
txnSampler.start();
async function pollContractLabels(retry = true) {
  try {
    const candidates = txnStore.unknownHot(labelBook, 24, 30);
    if (candidates.length < 5) return;                 // 样本太少,下轮再说
    // selector → 方法签名(openchain),方法名语义大幅提升 AI 识别率
    const sels = candidates.flatMap((c) => (c.topSelectors ?? []).map((s) => s.split("×")[0]));
    const sigs = await lookupSelectors(sels);
    // 地址情报:形态(合约/EOA/7702)+ code size + nonce + BscScan verified 名称
    const intels = await Promise.all(candidates.map((c) => getAddrIntel(provider, c.addr, { bscscanKey: cfg.bscscanKey })));
    candidates.forEach((c, i) => {
      c.topSelectors = (c.topSelectors ?? []).map((s) => {
        const sel = s.split("×")[0];
        return sigs[sel] ? `${s} = ${sigs[sel]}` : s;
      });
      const it = intels[i];
      c.addrType = it.type; c.codeSize = it.codeSize; c.nonce = it.nonce; c.balanceBNB = it.balanceBNB;
      if (it.verifiedName) c.verifiedName = it.verifiedName;
    });
    const labeled = await runContractLabeling(candidates);
    const n = labelBook.addLearned(labeled);
    console.log(`[txn labels] learned ${n}/${candidates.length} (total ${labelBook.learnedCount()})`);
  } catch (err) {
    console.error("[txn labels]", err.message);
    if (retry) setTimeout(() => pollContractLabels(false), 15 * 60_000);   // 偶发超时,一刻钟后重试一次
  }
}
setTimeout(pollContractLabels, 10 * 60_000);           // 首跑等采样积累
setInterval(pollContractLabels, 2 * 3600_000);         // 2h 一轮加速收编长尾;无候选时空转不耗 AI
scanSlashEvents();
setInterval(scanSlashEvents, 60_000);

// ── HTTP server ────────────────────────────────────────────────────────────
const app = Fastify({ logger: true });
await app.register(fastifyCors, { origin: cfg.corsOrigin });
await app.register(fastifyWebsocket);

// WebSocket endpoint
app.register(async (fastify) => {
  fastify.get("/ws", { websocket: true }, (conn) => {
    const socket = conn.socket ?? conn;   // @fastify/websocket v8: SocketStream.socket; v11: socket itself
    wsClients.add(socket);

    // Send full snapshot on connect (blocks + latest cached poll data)
    socket.send(JSON.stringify({
      type: "snapshot",
      data: {
        recentBlocks: streamer.window.slice(-50),
        windowStats:  windowStatsPlus(),
        slashStatus:  latest.slashStatus,
        nodeStats:    latest.nodeStats,
        gasUsed:      latest.gasUsed,
        latency:      latest.latency,
        diskAlerts:   latest.diskAlerts,
        mevStats:     latest.mevStats,
        txpool:       latest.txpool,
        reorgStats:   latest.reorgStats,
        reorgTimeline: latest.reorgTimeline,
        blockGas:     latest.blockGas,
        trafficTimeline: latest.trafficTimeline,
        syncErrors:   latest.syncErrors,
        slashEvents:  latest.slashEvents,
      },
      ts: Date.now(),
    }));

    socket.on("close", () => wsClients.delete(socket));
  });
});

// REST endpoints (for initial page load)
// keter 不可达时优雅降级:失败返回 null(前端组件均已用 ?. / ?? [] 兜底),避免刷 500
const safe = (p) => Promise.resolve(p).then((x) => x, () => null);
app.get("/api/slash",     async () => contracts.getSlashStatus());
app.get("/api/nodes",     async () => latest.nodeStats ?? safe(fetchNodeStats(cfg.keterConfigPath)));
app.get("/api/gas-used",  async () => safe(fetchGasUsed(cfg.keterConfigPath)));
app.get("/api/latency",   async () => latencyStore.getView());
app.get("/api/txpool",    async () => txpoolStore.getView());
app.get("/api/empty-blocks", async () => emptyStore.view());
app.get("/api/sync-errors", async () => latest.syncErrors ?? safe(fetchSyncErrors(cfg.keterConfigPath)));
app.get("/api/slash-events", async () => slashEvents.view());
app.get("/api/db-stats", async (req) => {
  const hours = Math.min(Math.max(parseInt(req.query?.hours, 10) || 24, 1), 168);
  return safe(fetchDbStats(cfg.keterConfigPath, hours));
});
let insertLatCache = { at: 0, hours: 0, data: null };
app.get("/api/insert-latency", async (req) => {
  const hours = Math.min(Math.max(parseInt(req.query?.hours, 10) || 24, 1), 72);
  if (insertLatCache.data && insertLatCache.hours === hours && Date.now() - insertLatCache.at < 55_000) return insertLatCache.data;
  const data = await safe(fetchInsertLatency(cfg.keterConfigPath, hours));
  if (data) insertLatCache = { at: Date.now(), hours, data };   // 只缓存成功结果,失败下次重试
  return data;
});
let bidMetricsCache = { at: 0, hours: 0, data: null };
app.get("/api/bid-metrics", async (req) => {
  const hours = Math.min(Math.max(parseInt(req.query?.hours, 10) || 6, 1), 24);
  if (bidMetricsCache.data && bidMetricsCache.hours === hours && Date.now() - bidMetricsCache.at < 60_000) return bidMetricsCache.data;
  const data = await safe(fetchBidMetrics(cfg.keterConfigPath, hours));
  if (data) {
    // 注入 validator tier(cabinet/candidate/inactive),前端按层筛选;端口后缀剥离后匹配
    const tierOf = {};
    (latest.nodeStats ?? []).forEach((n) => { const ip = (n.instance || "").split(":")[0]; if (ip) tierOf[ip] = n.tier || null; });
    for (const arr of [data.sim, data.gas]) arr.forEach((s) => { s.tier = tierOf[(s.instance || "").split(":")[0]] ?? null; });
    bidMetricsCache = { at: Date.now(), hours, data };
  }
  return data;
});
app.get("/api/reorg",     async () => latest.reorgTimeline ? { reorg24h: reorg24hFiltered(), source: "keter · ≥2节点" } : safe(fetchReorgStats(cfg.keterConfigPath)));
app.get("/api/reorg-events", async () => ({
  keterEvents: (latest.reorgTimeline?.events ?? []).slice(0, 10),   // 链级(≥2节点),小时粒度
  observed: reorgObs.view(),                                        // 本机 WS 观测,含精确高度
}));
app.get("/api/reorg-timeline", async () => latest.reorgTimeline ?? safe(fetchReorgTimeline(cfg.keterConfigPath)));
app.get("/api/block-gas", async () => latest.blockGas ?? safe(fetchBlockGas(cfg.keterConfigPath)));
app.get("/api/traffic-timeline", async () => latest.trafficTimeline ?? safe(fetchTrafficTimeline(cfg.keterConfigPath)));
app.get("/api/disk",      async (req) => {
  // threshold=0 返回全部节点水位(topk 100),存储页磁盘总览用;默认 80 供告警
  const t = req.query?.threshold != null ? Math.max(Number(req.query.threshold) || 0, 0) : 80;
  return safe(fetchDiskAlerts(cfg.keterConfigPath, t));
});
app.get("/api/window",    async () => windowStatsPlus());
app.get("/api/blocks",    async () => streamer.window.slice(-120));   // recent blocks for ring/river polling
app.get("/api/mev",       async () => mevAgg.getStats());

// ── AI analyses (on-demand claude -p calls) ─────────────────────────────────
const aiJobs = {};   // key → { text, at, running, error }
function aiRoutes(key, path, buildAndRun) {
  aiJobs[key] = { text: null, at: null, running: false, error: null };
  app.post(path, async (req, reply) => {
    const job = aiJobs[key];
    if (job.running) return { running: true, text: job.text, at: job.at };
    job.running = true; job.error = null;
    try {
      const text = await buildAndRun(req.body ?? {});
      aiJobs[key] = { text, at: Date.now(), running: false, error: null };
      return { text, at: aiJobs[key].at, running: false };
    } catch (err) {
      job.running = false; job.error = err.message;
      reply.code(500);
      return { error: err.message };
    }
  });
  app.get(path, async () => aiJobs[key]);
}

async function buildAiData(days = 7) {
  const [reorg, slash] = await Promise.all([
    Promise.resolve(latest.reorgTimeline ? { reorg24h: reorg24hFiltered() } : null).then(v => v ?? fetchReorgStats(cfg.keterConfigPath)).catch(() => ({ reorg24h: null })),
    contracts.getSlashStatus().catch(() => []),
  ]);
  const win = streamer.getWindowStats() || {};
  const tx = txpoolStore.getView();
  const lat = latencyStore.getView();
  // N 天窗口聚合;reorg 缓存 14d、traffic 缓存 30d,超出按需拉取
  const cut = Date.now() - days * 86400e3;
  let reorgTl = latest.reorgTimeline;
  if (days > 14) reorgTl = await fetchReorgTimeline(cfg.keterConfigPath, Math.min(days, 30)).catch(() => reorgTl);
  const reorgEv = (reorgTl?.events ?? []).filter((e) => e.t >= cut);
  const trafficEp = (latest.trafficTimeline?.episodes ?? []).filter((e) => e.start >= cut);
  return {
    windowDays: days,
    block: streamer.lastNumber,
    avgBlockTimeMs: win.avgBlockTimeMs,
    gasUtilPct: win.avgGasUtilPct,
    mevPct: win.mevPct,
    emptyBlocks24h: emptyStore.view().count,
    emptyRecent: emptyStore.view().recent.slice(0, 10),
    missedCount: win.missedCount,
    reorgWindow: { count: reorgEv.reduce((s, e) => s + (e.count || 0), 0), events: reorgEv },
    reorg24h: reorg?.reorg24h ?? null,
    trafficEpisodesWindow: trafficEp,
    txpool24h: tx ? { current: tx.current, max24h: tx.max24h, threshold: tx.threshold, anomalyCount24h: tx.anomalyCount, anomalyNow: tx.anomalyNow } : null,
    latency24h: lat ? { p50: lat.p50?.at(-1), p95: lat.p95?.at(-1), p99: lat.p99?.at(-1), baseline24h: lat.baseline24h } : null,
    syncErrors: latest.syncErrors ? { count: latest.syncErrors.count, total: latest.syncErrors.total, nodes: latest.syncErrors.nodes.slice(0, 5) } : null,
    slashEvents24h: (() => {
      const v = slashEvents.view();
      return { count: v.count, recent: v.recent.slice(0, 5).map((e) => ({ ...e, ...validatorInfo(e.validator) })) };
    })(),
    slashed: (slash ?? []).filter((v) => v.slashCount > 0).map((v) => ({ addr: v.consensusAddr, count: v.slashCount })),
  };
}
// Network analysis: on-demand + auto-refresh hourly (broadcast so panels update live)
aiJobs.network = { text: null, at: null, running: false, error: null };

// 首行结论 → 等级:正常=ok(前端折叠) / 需关注=warn / 告警=alert
const verdictOf = (text) => {
  const head = (text ?? "").slice(0, 40);
  return head.includes("告警") ? "alert" : head.includes("需关注") ? "warn" : "ok";
};

async function runNetworkAnalysis(days = 7, auto = true) {
  if (aiJobs.network.running) return aiJobs.network;
  aiJobs.network = { ...aiJobs.network, running: true, error: null };
  try {
    const text = await runAnalysis(await buildAiData(days));
    aiJobs.network = { text, verdict: verdictOf(text), windowDays: days, at: Date.now(), running: false, error: null, auto };
  } catch (err) {
    aiJobs.network = { ...aiJobs.network, running: false, error: err.message };
  }
  broadcast("aiNetwork", aiJobs.network);
  return aiJobs.network;
}
app.post("/api/ai/analyze", async (req, reply) => {
  if (aiJobs.network.running) return { running: true, text: aiJobs.network.text, at: aiJobs.network.at };
  const days = Math.min(Math.max(parseInt(req.body?.days, 10) || 7, 1), 30);
  const r = await runNetworkAnalysis(days, false);
  if (r.error) { reply.code(500); return { error: r.error }; }
  return { text: r.text, verdict: r.verdict, windowDays: r.windowDays, at: r.at, running: false };
});
app.get("/api/ai/analyze", async () => aiJobs.network);
// 详情用:返回与 AI 分析同一份维度数据(明细)
app.get("/api/ai/data", async (req) => {
  const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 7, 1), 30);
  return buildAiData(days);
});
setTimeout(runNetworkAnalysis, 45_000);          // first pass once data is warm
setInterval(runNetworkAnalysis, 3600_000);       // hourly auto-refresh

// 大流量分析:最近一次大流量事件 + 峰值时段链上采样(合约归因)
aiRoutes("traffic", "/api/ai/traffic", async (body) => {
  const tl = latest.trafficTimeline ?? await fetchTrafficTimeline(cfg.keterConfigPath);
  const tx = txpoolStore.getView();
  const win = streamer.getWindowStats() || {};
  // 用户从事件列表点选的历史事件优先;否则进行中大流量 / 最近一次
  const picked = body?.episodeStart ? (tl.episodes ?? []).find((e) => e.start === Number(body.episodeStart)) : null;
  const liveHot = (win.avgGasUtilPct ?? 0) >= (tl.hotPct ?? 90) || !!tx?.anomalyNow;
  const ep = picked ?? (liveHot
    ? { start: Date.now(), peakT: Date.now() - 1800e3, peakGasPct: win.avgGasUtilPct, peakPending: tx?.current ?? null, live: true }
    : tl.lastEpisode);
  let evidence = null;
  if (ep?.peakT) {
    // hourly bucket at t covers (t-1h, t] → sample from the bucket start;附交易分析标签库名称
    evidence = await sampleBlockContracts(provider, ep.peakT - 3600e3, { samples: 8, labelBook }).catch((e) => ({ error: e.message }));
  }
  return runTrafficAnalysis({
    hotPct: tl.hotPct ?? 90,
    pendingThreshold: tl.threshold ?? 4000,
    gasLimitM: 140,
    baseline30d: tl.summary,
    lastEpisode: ep ?? tl.lastEpisode,
    pickedByUser: !!picked,
    episodes: tl.episodes,
    gasUtilPctNow: win.avgGasUtilPct ?? null,
    currentPending: tx?.current ?? null,
    liveHot,
    chainEvidence: evidence,
  });
});

// 自由问答(主页机器人):监控快照 + 用户问题 → claude
let askBusy = false;
app.post("/api/ai/ask", async (req, reply) => {
  const question = String(req.body?.question ?? "").trim().slice(0, 500);
  if (!question) { reply.code(400); return { error: "empty question" }; }
  if (askBusy) { reply.code(429); return { error: "上一个问题还在回答中,请稍候" }; }
  askBusy = true;
  try {
    const base = await buildAiData();
    const m = mevAgg.getStats();

    // 问题里带更长时间范围(如"最近40天")→ 按需拉取对应窗口的历史,而非受限于默认快照
    let reorgTl = latest.reorgTimeline, trafficTl = latest.trafficTimeline;
    const dm = question.match(/(\d{1,3})\s*(天|日|days?|d\b)/i);
    const wantDays = dm ? Math.min(parseInt(dm[1], 10), 90) : null;
    if (wantDays && wantDays > 14) {
      const [r, t] = await Promise.all([
        fetchReorgTimeline(cfg.keterConfigPath, wantDays).catch(() => null),
        fetchTrafficTimeline(cfg.keterConfigPath, wantDays).catch(() => null),
      ]);
      if (r) reorgTl = r;
      if (t) trafficTl = t;
    }

    const context = {
      ...base,
      historyWindowDays: wantDays && wantDays > 14 ? wantDays : { reorg: 14, traffic: 30 },
      traffic: trafficTl ? { summary: trafficTl.summary, episodes: trafficTl.episodes.slice(-6) } : null,
      reorg: reorgTl ? { summary: reorgTl.summary, daily: reorgTl.days.filter((d) => d.count > 0), recentEvents: reorgTl.events?.slice(0, 5) ?? [] } : null,
      mev: m ? { windowBlocks: m.total, mevPct: m.mevPct, v2Pct: m.v2Pct, topFamilies: m.builderFamilies.slice(0, 5) } : null,
      keterNodes: (latest.nodeStats ?? []).length,
    };
    const text = await runAsk(question, context);
    return { text, at: Date.now() };
  } catch (err) {
    reply.code(500);
    return { error: err.message };
  } finally {
    askBusy = false;
  }
});

// MEV 格局分析:builder 集中度 / v1v2 / local & unknown(2000 块窗口)
aiRoutes("mev", "/api/ai/mev", async () => {
  const m = mevAgg.getStats();
  if (!m) throw new Error("MEV 窗口尚未积累数据,请稍候");
  const win = streamer.getWindowStats() || {};
  return runMevAnalysis({
    windowBlocks: m.total,
    approxWindowMinutes: Math.round((m.total * 0.45) / 60),
    mevPct: m.mevPct,
    v2Pct: m.v2Pct,
    typeCounts: m.typeCounts,
    builderFamilies: m.builderFamilies,
    topBuilderInstances: Object.entries(win.builderCounts ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 10),
  });
});

// 空块简析:validator 分布 / 聚集性(24h 记录)
aiRoutes("empty", "/api/ai/empty", async () => {
  const v = emptyStore.view();
  if (!v.count) throw new Error("24h 内无空块");
  return runEmptyAnalysis({ count24h: v.count, blocks: v.recent });
});

// TxPool 拥堵诊断:当前 24h 形态 + 30d 基线 + gas 利用率
aiRoutes("txpool", "/api/ai/txpool", async () => {
  const tl = latest.trafficTimeline ?? await fetchTrafficTimeline(cfg.keterConfigPath);
  const tx = txpoolStore.getView();
  const win = streamer.getWindowStats() || {};
  return runTxpoolAnalysis({
    current: tx ? { avgPending: tx.current, max24h: tx.max24h, anomalyNow: tx.anomalyNow, anomalyCount24h: tx.anomalyCount, spanHours: tx.spanHours } : null,
    baseline30d: tl.summary,
    recentEpisodes: tl.episodes.slice(-3),
    gasUtilPctNow: win.avgGasUtilPct ?? null,
    threshold: tl.threshold,
  });
});
// 交易分析:7 天分类趋势 + 24h 分布 + top 合约(附地址情报,已缓存直挂、未缓存后台预热)
app.get("/api/txn", async () => {
  const v = txnStore.view(labelBook);
  for (const c of v.topContracts ?? []) {
    const it = getCachedIntel(c.addr);
    if (it) c.intel = { type: it.type, codeSize: it.codeSize, nonce: it.nonce, verifiedName: it.verifiedName };
    else getAddrIntel(provider, c.addr, { bscscanKey: cfg.bscscanKey }).catch(() => {});
  }
  return v;
});
aiRoutes("txn", "/api/ai/txn", async () => {
  const v = txnStore.view(labelBook);
  if (!v.total24) throw new Error("采样数据积累中(每分钟 1 块),请稍后再试");
  return runTxnFeatureAnalysis(v);
});

app.get("/health",        async () => ({ ok: true, block: streamer.lastNumber, wsConnected: streamer.connected }));

// ── Serve the built frontend (single-process local deploy: frontend+api+ws same-origin) ──
const distPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../frontend/dist");
if (fs.existsSync(distPath)) {
  await app.register(fastifyStatic, { root: distPath });
  // SPA fallback: serve index.html for non-api/ws/asset routes
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url.startsWith("/api") || req.raw.url.startsWith("/ws")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });
  console.log(`Serving frontend from ${distPath}`);
} else {
  console.log(`No frontend build at ${distPath} (run: cd frontend && npm run build). Dev: use vite on :3000.`);
}

await app.listen({ port: cfg.port, host: "0.0.0.0" });
console.log(`BSC Monitor running on http://localhost:${cfg.port}`);
