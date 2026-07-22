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
import { fetchNodeStats, fetchGasUsed, fetchLatencySnapshot, fetchDiskAlerts, fetchTxpoolSnapshot, fetchReorgStats, fetchReorgTimeline, fetchBlockGas, fetchTrafficTimeline, fetchSyncErrors, fetchSyncDetail, fetchDbStats, fetchInsertLatency, fetchLatencyStages, fetchBidMetrics, fetchGreedyMerge, fetchExecStatsAll, setLiveGasLimit, liveGasLimitM, refineEpisode, refineReorgMoment } from "./keter/metrics.js";
import { sampleBlockContracts } from "./ai/evidence.js";
import { LatencyStore } from "./metrics/latencyStore.js";
import { TxpoolStore } from "./metrics/txpoolStore.js";
import { EmptyBlockStore } from "./metrics/emptyStore.js";
import { ReorgObsStore } from "./metrics/reorgStore.js";
import { SlashEventStore } from "./metrics/slashEventStore.js";
import { MevAggregator } from "./mev/aggregator.js";
import { runAnalysis, runTrafficAnalysis, runTrafficTrendAnalysis, runTxpoolAnalysis, runMevAnalysis, runEmptyAnalysis, runSlashAnalysis, runReorgAnalysis, runReorgEventAnalysis, runBlockGasAnalysis, runLatencyAnalysis, runSyncAnalysis, runGreedyMergeAnalysis, runAsk, runContractLabeling, runTxnFeatureAnalysis, aiInfo } from "./ai/analyze.js";
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
// v2:采样口径修正(每节点 q0.5,旧文件混入了 q0.9/q0.99 序列,基线虚高),换文件名废弃旧数据
const latencyStore = new LatencyStore(path.join(dataDir, "latency-24h-v2.json"));
const txpoolStore  = new TxpoolStore(path.join(dataDir, "txpool-24h.json"));
const emptyStore   = new EmptyBlockStore(path.join(dataDir, "empty-24h.json"));
const reorgObs     = new ReorgObsStore(path.join(dataDir, "reorg-obs-24h.json"));
const slashEvents  = new SlashEventStore(path.join(dataDir, "slash-events-15d-v2.json"));   // v2:15d 窗口 + filler/gapMs enrich,换文件触发全量回填
// 交易分析子系统:1min/块 采样 → 规则分类 → AI 归类未知热门合约(标签库滚雪球)
const labelBook  = new LabelBook(path.join(dataDir, "contract-labels.json"));
const txnStore   = new TxnStore(path.join(dataDir, "txn-7d.json"));
const txnSampler = new TxnSampler({ provider, store: txnStore, labelBook });

// validatorSlashed(address) 事件扫描(SlashIndicator 0x…1001)
const SLASH_ADDR  = "0x0000000000000000000000000000000000001001";
const SLASH_TOPIC = "0xddb6012116e51abf5436d956a4f0ebd927e92c576ff96d7918290c8782291e3e";
const hdrMs = (h) => Number(BigInt(h.timestamp)) * 1000 + (h.mixHash ? Number(BigInt(h.mixHash) % 1000n) : 0);
const getHeader = (n) => streamer.http.send("eth_getHeaderByNumber", ["0x" + n.toString(16)]).catch(() => null);
let slashScanBusy = false;   // 首次 15d 回填可超过 60s 定时间隔,防止并发重复扫描
async function scanSlashEvents() {
  if (slashScanBusy) return;
  slashScanBusy = true;
  try {
    const tip = streamer.lastNumber ?? await provider.getBlockNumber();
    if (!tip) return;
    const winBlocks = Math.floor(slashEvents.windowMs / 450);   // 15d ≈ 2.88M 块,仅首次回填
    let from = slashEvents.lastScanned + 1;
    if (!slashEvents.lastScanned || tip - from > winBlocks) from = tip - winBlocks;
    if (from > tip) return;
    const now = Date.now();
    const CHUNK = 45_000;
    const found = [];
    for (let a = from; a <= tip; a += CHUNK) {
      const b = Math.min(a + CHUNK - 1, tip);
      const logs = await provider.getLogs({ address: SLASH_ADDR, topics: [SLASH_TOPIC], fromBlock: a, toBlock: b });
      for (const l of logs) {
        found.push({
          t: now - (tip - l.blockNumber) * 450,   // 兜底估算;下面用 header 真实毫秒时间覆盖
          block: l.blockNumber,
          validator: "0x" + l.topics[1].slice(26),
          tx: l.transactionHash,
        });
      }
    }
    // enrich:slash 记录在替代者出的块里 —— header(block) 给真实时间与替代出块者,
    // 与前块的毫秒差即被 slash 轮次的出块间隔(正常 ~450ms,miss 一轮明显拉大)
    for (let i = 0; i < found.length; i += 30) {
      await Promise.all(found.slice(i, i + 30).map(async (e) => {
        const [h, hp] = await Promise.all([getHeader(e.block), getHeader(e.block - 1)]);
        if (h) {
          e.t = hdrMs(h);
          e.filler = (h.miner || "").toLowerCase();
          if (hp) e.gapMs = Math.round(hdrMs(h) - hdrMs(hp));
        }
      }));
    }
    slashEvents.addBatch(found, tip);
    broadcast("slashEvents", slashEvents.view());
  } catch (err) {
    console.error("[slash events scan]", err.message);
  } finally {
    slashScanBusy = false;
  }
}

// 连续 slash 段聚合:同一 validator、块号相邻(≤3)合并 —— 连续多块 = 节点持续故障信号
function slashEpisodes(items) {
  const byV = new Map();
  for (const e of items) { const a = byV.get(e.validator) ?? []; a.push(e); byV.set(e.validator, a); }
  const eps = [];
  for (const [v, arr] of byV) {
    arr.sort((a, b) => a.block - b.block);
    let cur = null;
    for (const e of arr) {
      if (cur && e.block - cur.endBlock <= 3) {
        cur.endBlock = e.block; cur.blocks++;
        if (e.gapMs != null) cur.gapMsMax = Math.max(cur.gapMsMax ?? 0, e.gapMs);
        if (e.filler) cur.fillerSet.add(e.filler);
      } else {
        if (cur) eps.push(cur);
        cur = { validator: v, startBlock: e.block, endBlock: e.block, blocks: 1, t: e.t,
                gapMsMax: e.gapMs ?? null, fillerSet: new Set(e.filler ? [e.filler] : []) };
      }
    }
    if (cur) eps.push(cur);
  }
  return eps.sort((a, b) => b.t - a.t).map(({ fillerSet, ...x }) => ({
    ...x, ...validatorInfo(x.validator),
    fillers: [...fillerSet].map((f) => validatorInfo(f).name),
    timeLocal: new Date(x.t).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  }));
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
  keterHealth:   null,
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
  if (block.gasLimit) setLiveGasLimit(block.gasLimit);   // gas 折算口径跟随链上实时上限
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
  // 被重组高度上的旧块出块人(窗口里还是旧链数据)—— reorg 嫌疑方
  const oldMiners = (streamer.window ?? [])
    .filter((b) => b.number >= info.to && b.number <= info.from)
    .map((b) => b.miner).filter(Boolean);
  reorgObs.add(info.from, info.to, info.depth ?? 1, oldMiners);   // 本机观测高度(24h)
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
// 新鲜度追踪:轮询静默失败时快照会变旧,前端据此提示「数据 N 分钟前」
const keterHealth = { okAt: null, timelineOkAt: null, error: null };
function keterMark(field, err) {
  if (err) keterHealth.error = err.message;
  else { keterHealth[field] = Date.now(); keterHealth.error = null; }
  broadcast("keterHealth", { ...keterHealth });
}

let lastLatSnap = { mid: [], tail: [] };   // 每节点 q0.5 / q0.95 即时快照(点名慢节点用)
async function pollKeter() {
  try {
    const [nodeStats, gasUsed, latVals, diskAlerts, txVals, reorgStats, blockGas, syncErrors, tiers] = await Promise.all([
      fetchNodeStats(cfg.keterConfigPath),
      fetchGasUsed(cfg.keterConfigPath, "now-24h"),
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
    // fetchLatencySnapshot 返回 {mid, tail}(每节点 q0.5 / q0.95);store 只吃 q0.5 数值
    lastLatSnap = latVals;
    latencyStore.addSample(now, latVals.mid.map((x) => x.ms));   // app-side 24h rolling caches
    txpoolStore.addSample(now, txVals);
    broadcast("nodeStats",  nodeStats);
    broadcast("gasUsed",    gasUsed);
    broadcast("latency",    latencyStore.getView());
    broadcast("diskAlerts", diskAlerts);
    broadcast("txpool",     txpoolStore.getView());
    broadcast("reorgStats", reorgStats);
    broadcast("blockGas",   blockGas);
    broadcast("syncErrors", syncErrors);
    keterMark("okAt");
  } catch (err) {
    console.error("[keter poll]", err.message);
    keterMark("okAt", err);
  }
}
pollKeter();
setInterval(pollKeter, 30_000);

// ── Heavy range-query timelines (reorg 14d / traffic 30d) — every 10 min ───
// 时间 → 区块高度:按 450ms 块距估算,再用 header 时间迭代校正,收敛到 ±2 块
const blockAtCache = new Map();
async function blockAtTime(tsMs) {
  const key = Math.round(tsMs / 60_000);   // 分钟粒度缓存足够(定位精度 5m)
  if (blockAtCache.has(key)) return blockAtCache.get(key);
  const head = await provider.getBlock("latest");
  if (!head) return null;
  if (tsMs >= head.timestamp * 1000) return head.number;
  let est = head.number - Math.round((head.timestamp * 1000 - tsMs) / 450);
  for (let i = 0; i < 6; i++) {
    est = Math.max(1, Math.min(est, head.number));
    const b = await provider.getBlock(est);
    if (!b) return null;
    const step = Math.round((tsMs - b.timestamp * 1000) / 450);
    if (Math.abs(step) <= 2) break;
    est += step;
  }
  blockAtCache.set(key, est);
  if (blockAtCache.size > 500) blockAtCache.delete(blockAtCache.keys().next().value);
  return est;
}

// 大流量事件增强:5m 精化开始/峰值/恢复 + 区块高度区间;已结束事件缓存,进行中每轮重算
const epEnrichCache = new Map();
async function enrichEpisodes(tl) {
  if (!tl?.episodes?.length) return tl;
  for (const ep of tl.episodes) {
    const key = `${ep.start}:${ep.end ?? ""}`;
    const done = (ep.end ?? ep.start) + 7200_000 < Date.now();
    if (done && epEnrichCache.has(key)) { ep.refined = epEnrichCache.get(key); continue; }
    try {
      const r = await refineEpisode(cfg.keterConfigPath, ep, { hotPct: tl.hotPct, threshold: tl.threshold }) ?? {};
      const precise = r.startT != null;
      // 精化失败时退回小时桶边界:桶 t 覆盖 (t-1h, t],恢复 = 结束桶 +1h
      const startT = r.startT ?? ep.start - 3600_000;
      const endT = r.recoverT ?? Math.min((ep.end ?? ep.start) + 3600_000, Date.now());
      const [startBlock, endBlock, peakBlock] = await Promise.all([
        blockAtTime(startT), blockAtTime(endT), r.peakT != null ? blockAtTime(r.peakT) : null,
      ]);
      ep.refined = { ...r, precise, startT, endT, startBlock, endBlock, peakBlock };
      if (done) epEnrichCache.set(key, ep.refined);
    } catch (err) { console.error("[episode enrich]", err.message); }   // keter/RPC 抖动:保持小时口径
  }
  return tl;
}

// reorg 事件补区块范围 + 接管方:5m 精化定位 → ±5m 换算块高;canonical 序列粗采样找最大
// 出块 gap,gap 后首块的出块方即重组赢家(被回滚一方在 canonical 链上已不可见)。
// 事件时间不变,按 t 缓存,每事件只算一次(1 次 keter 查询 + 2 次 blockAtTime + ~50 header)。
const reorgEvBlockCache = new Map();
async function enrichReorgEvents(tl) {
  for (const e of tl?.events ?? []) {
    if (reorgEvBlockCache.has(e.t)) { Object.assign(e, reorgEvBlockCache.get(e.t)); continue; }
    try {
      const refined = await refineReorgMoment(cfg.keterConfigPath, e.t).catch(() => null);
      const winT = refined?.momentT ?? e.t;
      const [startBlock, endBlock] = await Promise.all([
        blockAtTime(refined ? winT - 300e3 : e.t - 3600e3),
        blockAtTime(refined ? winT + 300e3 : e.t),
      ]);
      const v = { startBlock, endBlock, precise: !!refined };
      if (startBlock && endBlock && endBlock > startBlock) {
        const step = Math.max(1, Math.floor((endBlock - startBlock) / 50));
        const nums = []; for (let n = startBlock; n <= endBlock; n += step) nums.push(n);
        const headers = await Promise.all(nums.map(getHeader));
        let prev = null, best = null;
        const rows = headers.filter(Boolean).map((h) => {
          const ts = hdrMs(h); const gapMs = prev != null ? ts - prev : null; prev = ts;
          return { block: Number(BigInt(h.number)), miner: (h.miner || "").toLowerCase(), gapMs };
        });
        for (let i = 1; i < rows.length; i++) if (rows[i].gapMs != null && (best == null || rows[i].gapMs > rows[best].gapMs)) best = i;
        if (best != null && rows[best].gapMs > step * 450 + 900) {
          const w = validatorInfo(rows[best].miner);
          Object.assign(v, { winner: w.name, winnerInternal: w.internal, boundaryBlock: rows[best - 1].block });
        }
      }
      reorgEvBlockCache.set(e.t, v);
      Object.assign(e, v);
      if (reorgEvBlockCache.size > 200) reorgEvBlockCache.delete(reorgEvBlockCache.keys().next().value);
    } catch {}
  }
  return tl;
}

async function pollTimelines() {
  let ok = true;
  try { broadcast("reorgTimeline", await enrichReorgEvents(await fetchReorgTimeline(cfg.keterConfigPath, 30))); }
  catch (err) { ok = false; console.error("[reorg timeline poll]", err.message); keterMark("timelineOkAt", err); }
  try { broadcast("trafficTimeline", await enrichEpisodes(await fetchTrafficTimeline(cfg.keterConfigPath))); }
  catch (err) { ok = false; console.error("[traffic timeline poll]", err.message); keterMark("timelineOkAt", err); }
  if (ok) keterMark("timelineOkAt");
}
pollTimelines();
setInterval(pollTimelines, 600_000);

// ── BNB Chain 官方公告(docs.bnbchain.org/announce)──────────────────────────
// 半小时抓一次,解析最新 3 条(标题/描述/日期/链接),首页横幅展示。失败保留上次结果。
const ANNOUNCE_URL = "https://docs.bnbchain.org/announce/";
let announceCache = { at: 0, items: [] };
async function pollAnnounce() {
  try {
    const r = await fetch(ANNOUNCE_URL, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "bnbchain-ops-monitor" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const items = [];
    const re = /<div class="doc-announce">\s*<a href="([^"]+)">[\s\S]*?<div class="announce-title">([\s\S]*?)<\/div>\s*<div class="announce-desc">([\s\S]*?)<\/div>[\s\S]*?<span class="announce-date">([\s\S]*?)<\/span>/g;
    let m;
    while ((m = re.exec(html)) && items.length < 3) {
      const href = m[1].startsWith("http") ? m[1] : new URL(m[1], ANNOUNCE_URL).href;
      const clean = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      items.push({ title: clean(m[2]), desc: clean(m[3]), date: clean(m[4]), url: href });
    }
    if (items.length) { announceCache = { at: Date.now(), items }; broadcast("announce", announceCache); }
  } catch (err) { console.error("[announce poll]", err.message); }
}
pollAnnounce();
setInterval(pollAnnounce, 1800_000);

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
app.get("/api/gas-used",  async () => safe(fetchGasUsed(cfg.keterConfigPath, "now-24h")));
app.get("/api/latency",   async () => latencyStore.getView());
app.get("/api/txpool",    async () => txpoolStore.getView());
app.get("/api/empty-blocks", async (req) => {
  const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 1, 1), 15);
  return { ...emptyStore.view(days * 86400e3), days };
});
app.get("/api/sync-errors", async () => latest.syncErrors ?? safe(fetchSyncErrors(cfg.keterConfigPath)));
app.get("/api/slash-events", async (req) => {
  const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 1, 1), 15);
  const v = slashEvents.view(days * 86400e3);
  // 窗口内为空时前端展示"最近一次"(15d 全窗口),避免空面板没信息
  const latest15d = days < 15 && !v.count ? (slashEpisodes(slashEvents.view(15 * 86400e3).items)[0] ?? null) : null;
  return {
    days, count: v.count, lastScanned: v.lastScanned,
    episodes: slashEpisodes(v.items),
    recent: v.recent.map((e) => ({ ...e, ...validatorInfo(e.validator), fillerName: e.filler ? validatorInfo(e.filler).name : null })),
    latest15d,
  };
});
app.get("/api/keter-health", async () => ({ ...keterHealth }));
let syncDetailCache = { at: 0, days: 0, data: null };
app.get("/api/sync-detail", async (req) => {
  const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 1, 1), 7);
  if (syncDetailCache.data && syncDetailCache.days === days && Date.now() - syncDetailCache.at < 55_000) return syncDetailCache.data;
  const data = await safe(fetchSyncDetail(cfg.keterConfigPath, 10, 600, days));
  if (data) syncDetailCache = { at: Date.now(), days, data };
  return data;
});
app.get("/api/db-stats", async (req) => {
  const hours = Math.min(Math.max(parseInt(req.query?.hours, 10) || 24, 1), 168);
  return safe(fetchDbStats(cfg.keterConfigPath, hours));
});
let insertLatCache = { at: 0, hours: 0, data: null };
app.get("/api/insert-latency", async (req) => {
  const hours = Math.min(Math.max(parseInt(req.query?.hours, 10) || 24, 1), 168);
  if (insertLatCache.data && insertLatCache.hours === hours && Date.now() - insertLatCache.at < 55_000) return insertLatCache.data;
  const data = await safe(fetchInsertLatency(cfg.keterConfigPath, hours));
  if (data) insertLatCache = { at: Date.now(), hours, data };   // 只缓存成功结果,失败下次重试
  return data;
});
let latStagesCache = { at: 0, hours: 0, data: null };
app.get("/api/latency-stages", async (req) => {
  const hours = Math.min(Math.max(parseInt(req.query?.hours, 10) || 24, 1), 168);
  if (latStagesCache.data && latStagesCache.hours === hours && Date.now() - latStagesCache.at < 60_000) return latStagesCache.data;
  const data = await safe(fetchLatencyStages(cfg.keterConfigPath, hours));
  if (data) latStagesCache = { at: Date.now(), hours, data };
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
let greedyCache = { at: 0, hours: 0, data: null };
app.get("/api/greedy-merge", async (req) => {
  const hours = Math.min(Math.max(parseInt(req.query?.hours, 10) || 6, 1), 24);
  if (greedyCache.data && greedyCache.hours === hours && Date.now() - greedyCache.at < 60_000) return greedyCache.data;
  const data = await safe(fetchGreedyMerge(cfg.keterConfigPath, hours));
  if (data) greedyCache = { at: Date.now(), hours, data };
  return data;
});
app.get("/api/reorg",     async () => latest.reorgTimeline ? { reorg24h: reorg24hFiltered(), source: "keter · ≥2节点" } : safe(fetchReorgStats(cfg.keterConfigPath)));
app.get("/api/reorg-events", async () => ({
  keterEvents: (latest.reorgTimeline?.events ?? []).slice(0, 10),   // 链级(≥2节点),小时粒度
  observed: reorgObs.view(),                                        // 本机 WS 观测,含精确高度
}));
app.get("/api/reorg-timeline", async () => latest.reorgTimeline ?? safe(fetchReorgTimeline(cfg.keterConfigPath).then(enrichReorgEvents)));
let blockGasWinCache = { at: 0, minutes: 0, data: null };
// 流量高峰段:gasused > 45M 的连续区间(相邻 ≤2 个采样点的间隙合并),附区块高度区间
const PEAK_GAS = 45e6;
async function gasPeaks(gasused) {
  const ts = gasused?.times ?? [], vs = gasused?.values ?? [];
  const segs = [];
  let cur = null, gap = 0;
  for (let i = 0; i < vs.length; i++) {
    const hot = typeof vs[i] === "number" && vs[i] > PEAK_GAS;
    if (hot) {
      if (!cur) cur = { startT: ts[i], endT: ts[i], peak: vs[i] };
      else { cur.endT = ts[i]; cur.peak = Math.max(cur.peak, vs[i]); }
      gap = 0;
    } else if (cur && ++gap > 2) { segs.push(cur); cur = null; }
  }
  if (cur) segs.push(cur);
  const recent = segs.slice(-3);
  // 打满段(≥90% 上限):与首页大流量卡同一口径,供流量页打满率卡对齐
  const fullGas = liveGasLimitM() * 1e6 * 0.9;
  const fullSegs = segs.filter((s) => s.peak >= fullGas);
  const lastFullSeg = fullSegs.at(-1) ?? null;
  const lastFull = lastFullSeg ? {
    startT: lastFullSeg.startT, peakM: +(lastFullSeg.peak / 1e6).toFixed(1),
    peakPct: Math.round((lastFullSeg.peak / (liveGasLimitM() * 1e6)) * 100),
    block: await blockAtTime(lastFullSeg.startT).catch(() => null),
  } : null;
  return Promise.all(recent.map(async (s) => ({
    startT: s.startT, endT: s.endT, peakM: +(s.peak / 1e6).toFixed(1),
    startBlock: await blockAtTime(s.startT).catch(() => null),
    endBlock: await blockAtTime(s.endT).catch(() => null),
  }))).then((peaks) => ({ peaks, total: segs.length, fullCount: fullSegs.length, lastFull }));
}
app.get("/api/block-gas", async (req) => {
  const minutes = Math.min(Math.max(parseInt(req.query?.minutes, 10) || 30, 30), 1440);
  if (minutes === 30) {
    const data = latest.blockGas ?? await safe(fetchBlockGas(cfg.keterConfigPath));
    if (!data) return data;
    const p = await gasPeaks(data.gasused).catch(() => null);
    return { ...data, peaks: p?.peaks ?? [], peakTotal: p?.total ?? 0, peakThresholdM: PEAK_GAS / 1e6, fullCount: p?.fullCount ?? 0, lastFull: p?.lastFull ?? null };
  }
  if (blockGasWinCache.data && blockGasWinCache.minutes === minutes && Date.now() - blockGasWinCache.at < 60_000) return blockGasWinCache.data;
  let data = await safe(fetchBlockGas(cfg.keterConfigPath, minutes));
  if (data) {
    const p = await gasPeaks(data.gasused).catch(() => null);
    data = { ...data, peaks: p?.peaks ?? [], peakTotal: p?.total ?? 0, peakThresholdM: PEAK_GAS / 1e6, fullCount: p?.fullCount ?? 0, lastFull: p?.lastFull ?? null };
    blockGasWinCache = { at: Date.now(), minutes, data };
  }
  return data;
});
// Top gas 消耗合约榜(流量子系统):TXN 采样 receipts 的真实 gasUsed 聚合
app.get("/api/traffic/top-gas", async (req) => {
  const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 1, 1), 7);
  return txnStore.topGasContracts(labelBook, days);
});
// 最近 3 次大流量事件 · 涉及合约:7d 内走 TXN 采样桶聚合(真实 gasUsed),更早的链上采样兜底
// ?trigger=pending|gas 筛触发类型(Pending 面板专属视图);不足 3 次按实际数量返回
const epContractsCache = new Map();   // episodeStart -> contracts
app.get("/api/traffic/episode-contracts", async (req) => {
  const trigger = ["pending", "gas"].includes(req.query?.trigger) ? req.query.trigger : null;
  const tl = latest.trafficTimeline;
  const eps = (tl?.episodes ?? []).filter((e) => !trigger || e.trigger?.includes(trigger)).slice(-3).reverse();
  const out = [];
  for (const e of eps) {
    let contracts = epContractsCache.get(e.start) ?? null;
    if (!contracts) {
      contracts = txnStore.contractsInRange(labelBook, e.start, (e.end ?? e.start) + 3600e3, 6);
      if (!contracts?.rows?.length) {
        const sampleFrom = e.refined?.precise ? e.refined.peakT - 300e3 : e.peakT - 3600e3;
        const ev = await sampleBlockContracts(provider, sampleFrom, { samples: 8, labelBook }).catch(() => null);
        if (ev?.topContracts?.length) {
          contracts = {
            source: "chain",
            rows: ev.topContracts.slice(0, 6).map((c) => ({ addr: c.to, name: c.name ?? null, cat: c.cat ?? "other", txs: c.txCount, sharePct: c.gasSharePct })),
          };
        }
      }
      if (contracts?.rows?.length) epContractsCache.set(e.start, contracts);
      if (epContractsCache.size > 60) epContractsCache.delete(epContractsCache.keys().next().value);
    }
    const r = e.refined;
    out.push({
      start: e.start,
      timeLocal: new Date(r?.precise ? r.startT : e.start).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      trigger: e.trigger, kind: e.kind ?? "sustained",
      peakPending: e.peakPending, peakGasPct: e.peakGasPct,
      durationMin: r?.precise && r.endT ? Math.max(Math.round((r.endT - r.startT) / 60e3), 5) : (e.hours ?? 1) * 60,
      startBlock: r?.startBlock ?? null, endBlock: r?.endBlock ?? null,
      contracts: contracts ?? null,
    });
  }
  return { episodes: out };
});

// Gas price 水位(块级中位 gasPrice 的小时 p50/p90,gwei)与 交易类型 gas 份额趋势
app.get("/api/traffic/gas-price", async (req) => {
  const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 1, 1), 7);
  return { days, ...txnStore.gasPriceTrend(days) };
});
app.get("/api/traffic/cat-trend", async (req) => {
  const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 1, 1), 7);
  return { days, ...txnStore.catTrend(days) };
});
app.get("/api/traffic-timeline", async () => latest.trafficTimeline ?? safe(fetchTrafficTimeline(cfg.keterConfigPath).then(enrichEpisodes)));
app.get("/api/announce", async () => announceCache);
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
// 同参数 5min 内重复请求直接吃上次结果:claude 调用要 30-40s,而数据源刷新周期 ≤10min
const AI_TTL_MS = 300_000;

// ── 每 IP 发起频率限制(缓存命中不计):防手快连点/滥用烧额度 ─────────────────
const AI_IP_MAX = Math.max(2, parseInt(process.env.AI_IP_MAX_PER_10MIN, 10) || 8);
const ipHits = new Map();   // ip -> [ts...]
function ipAllowed(ip) {
  const now = Date.now();
  const arr = (ipHits.get(ip) ?? []).filter((t) => now - t < 600_000);
  ipHits.delete(ip);                        // Map 插入序当 LRU 用:重插到末尾
  if (arr.length >= AI_IP_MAX) { ipHits.set(ip, arr); return false; }
  arr.push(now); ipHits.set(ip, arr);
  if (ipHits.size > 2000) ipHits.delete(ipHits.keys().next().value);   // 逐出最久未用,防地址轮换撑爆内存
  return true;
}
const RATE_MSG = `请求过于频繁(每 IP 10 分钟最多 ${AI_IP_MAX} 次分析),请稍后再试`;

// 异步任务模式:POST 立即返回(queued),后台执行,前端轮询 GET 取结果。
// MCP 取证分析可达 1-2 分钟,同步等待会撞反向代理的 60s 超时(网关吐 HTML 504)。
// 并发语义:同参数请求共享同一次运行(第二人轮询同一结果);不同参数在运行期到来
// 时返回明确的 busy 提示,而不是让对方吃到错味结果。
function aiRoutes(key, path, buildAndRun) {
  aiJobs[key] = { text: null, at: null, running: false, error: null };
  app.post(path, async (req, reply) => {
    const job = aiJobs[key];
    const bodyKey = JSON.stringify(req.body ?? {});
    if (job.running) {
      if (job.runningBodyKey === bodyKey) return { running: true, text: job.text, at: job.at };   // 同参共享
      reply.code(409);
      return { error: "该面板正在分析其他目标(约 1-2 分钟),请稍候再试", running: true };
    }
    if (job.text && job.at && job.bodyKey === bodyKey && Date.now() - job.at < AI_TTL_MS) {
      return { text: job.text, at: job.at, running: false, cached: true };
    }
    if (!ipAllowed(req.ip)) { reply.code(429); return { error: RATE_MSG }; }
    job.running = true; job.error = null; job.runningBodyKey = bodyKey;
    const body = req.body ?? {};
    (async () => {
      try {
        const text = await buildAndRun(body);
        aiJobs[key] = { text, at: Date.now(), running: false, error: null, bodyKey };
      } catch (err) {
        aiJobs[key] = { ...aiJobs[key], running: false, error: err.message };
      }
    })();
    return { queued: true, running: true, at: job.at ?? null };
  });
  app.get(path, async () => aiJobs[key]);
}

// jobId 池:同一端点可并发多次分析(不同目标各自独立结果通道),并发上限 max;
// 相同 bodyKey 复用进行中的 job;结果按 bodyKey 缓存 TTL。解决单槽下多目标互相 409 的痛点。
// 兼容旧前端:裸 GET 返回最近一次完成结果(供「先查缓存」优化);GET ?job=<id> 返回指定 job。
function aiJobPool(path, buildAndRun, { max = 2 } = {}) {
  const jobs = new Map();          // jobId -> { running, bodyKey, text, at, error }
  const cache = new Map();         // bodyKey -> { text, at }
  let lastDone = { text: null, at: null, bodyKey: null, running: false };
  let active = 0;
  app.post(path, async (req, reply) => {
    const bodyKey = JSON.stringify(req.body ?? {});
    const c = cache.get(bodyKey);
    if (c && Date.now() - c.at < AI_TTL_MS) return { text: c.text, at: c.at, bodyKey, running: false, cached: true };
    for (const [id, j] of jobs) if (j.running && j.bodyKey === bodyKey) return { jobId: id, running: true, at: j.at };
    if (active >= max) { reply.code(429); return { error: "分析通道繁忙(已有分析进行中),请稍候再试", running: true }; }
    if (!ipAllowed(req.ip)) { reply.code(429); return { error: RATE_MSG }; }
    const jobId = Math.random().toString(36).slice(2, 10);
    const job = { running: true, bodyKey, text: null, at: null, error: null };
    jobs.set(jobId, job);
    active++;
    setTimeout(() => jobs.delete(jobId), 15 * 60_000);
    const body = req.body ?? {};
    (async () => {
      try {
        const text = await buildAndRun(body);
        job.text = text; job.at = Date.now(); job.running = false;
        cache.set(bodyKey, { text, at: job.at });
        if (cache.size > 40) cache.delete(cache.keys().next().value);
        lastDone = { text, at: job.at, bodyKey, running: false };
      } catch (err) {
        job.error = err.message; job.running = false;
      } finally { active = Math.max(0, active - 1); }
    })();
    return { jobId, running: true, at: null };
  });
  app.get(path, async (req) => {
    const id = req.query?.job;
    if (id) { const j = jobs.get(id); return j ? { running: j.running, text: j.text, at: j.at, error: j.error } : { running: false, error: "分析任务不存在或已过期" }; }
    return lastDone;   // 裸 GET:最近一次完成结果(前端按 bodyKey 校验后决定是否复用)
  });
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
  if (days > 14) reorgTl = await fetchReorgTimeline(cfg.keterConfigPath, Math.min(days, 30)).then(enrichReorgEvents).catch(() => reorgTl);
  const reorgEv = (reorgTl?.events ?? []).filter((e) => e.t >= cut);
  const trafficEp = (latest.trafficTimeline?.episodes ?? []).filter((e) => e.start >= cut);
  return {
    windowDays: days,
    block: streamer.lastNumber,
    avgBlockTimeMs: win.avgBlockTimeMs,
    gasUtilPct: win.avgGasUtilPct,
    // MEV 口径与 MEV 页 24h 卡对齐(持久化大样本,一位小数);2000 块窗口刚重启时样本小易凑成 100%
    ...(() => { const m = mevAgg.getStats(); return { mevPct: m?.day24?.mevPct ?? m?.mevPct ?? win.mevPct, mev24h: m?.day24 ?? null }; })(),
    emptyBlocks24h: emptyStore.view().count,
    emptyRecent: emptyStore.view().recent.slice(0, 10),
    missedCount: win.missedCount,
    reorgWindow: { count: reorgEv.reduce((s, e) => s + (e.count || 0), 0), events: reorgEv },
    reorg24h: reorg?.reorg24h ?? null,
    trafficEpisodesWindow: trafficEp,
    txpool24h: tx ? { current: tx.current, max24h: tx.max24h, threshold: tx.threshold, anomalyCount24h: tx.anomalyCount, anomalyNow: tx.anomalyNow } : null,
    // 导入时延不进首页巡检:个别 1-2 个节点的偏慢属节点差异,由监控子系统的
    // Latency AI 解读(per-node + 全量对比)负责;仅当大面积异常(中位节点超一个
    // 出块间隔)才作为链级信号带入
    ...(lat && (lat.p50?.at(-1) ?? 0) > 450 ? {
      latencyAlert: { p50AcrossNodes: lat.p50.at(-1), note: "自营节点导入中位数大面积超过 450ms 出块间隔,链级异常" },
    } : {}),
    syncErrors: latest.syncErrors ? { count: latest.syncErrors.count, total: latest.syncErrors.total, nodes: latest.syncErrors.nodes.slice(0, 5) } : null,
    slashEvents24h: (() => {
      const v = slashEvents.view();
      // timeLocal 预格式化(北京时间),避免 AI 拿毫秒时间戳自行转换出错或写成「深夜」
      return { count: v.count, recent: v.recent.slice(0, 5).map((e) => ({
        ...e, ...validatorInfo(e.validator),
        timeLocal: e.t ? new Date(e.t).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null,
      })) };
    })(),
    slashed: (slash ?? []).filter((v) => v.slashCount > 0).map((v) => ({ addr: v.consensusAddr, count: v.slashCount })),
    // 窗口内 slash(与 Slash 面板同口径:按 validator 连续块聚合成段)——首页巡检四段之一
    slashWindow: (() => {
      const v = slashEvents.view(days * 86400e3);
      const eps = slashEpisodes(v.items);
      return {
        blocks: v.count, episodes: eps.length,
        items: eps.slice(0, 8).map((e) => ({
          timeLocal: e.timeLocal, validator: e.name, internal: e.internal,
          blocks: e.blocks, startBlock: e.startBlock, endBlock: e.endBlock, filler: e.fillers?.[0] ?? null,
        })),
      };
    })(),
    // 全网 geth 版本升级情况(24h 内出过块的 validator 去重)——首页巡检四段之一
    versionUpgrade: (() => {
      const m = mevAgg.getStats();
      const vers = m?.versions ?? [];
      if (!vers.length) return null;
      const cmp = (a, b) => { const pa = a.split(".").map(Number), pb = b.split(".").map(Number); for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; } return 0; };
      const latest = vers.map((v) => v.ver).reduce((a, b) => (cmp(b, a) > 0 ? b : a));
      // 主流版本 = 出块节点数最多的版本(众数);落后以主流为基准,而非以个别超前节点的最新版为基准
      const mainstream = vers.reduce((a, b) => (b.n > a.n ? b : a)).ver;
      // 落后程度:major/minor 落后 = 大版本落后(前端标红);仅 patch 落后 = 小版本落后(标黄)
      const lagLevel = (v) => { const a = String(v).split(".").map(Number), b = String(mainstream).split(".").map(Number); return ((a[0] || 0) < (b[0] || 0) || (a[1] || 0) < (b[1] || 0)) ? "major" : "minor"; };
      const laggards = Object.entries(m.minerVersions || {})
        .map(([addr, ver]) => ({ ver: (ver || "").replace(/^v/, ""), ...validatorInfo(addr) }))
        .filter((x) => x.ver && cmp(x.ver, mainstream) < 0)
        .sort((a, b) => cmp(a.ver, b.ver));
      return {
        latest, mainstream, distribution: vers, laggardCount: laggards.length,
        laggardMajor: laggards.filter((x) => lagLevel(x.ver) === "major").length,
        laggards: laggards.slice(0, 12).map((x) => ({ name: x.name, internal: x.internal, ver: x.ver, level: lagLevel(x.ver) })),
      };
    })(),
  };
}
// Network analysis: on-demand + auto-refresh hourly (broadcast so panels update live)
aiJobs.network = { text: null, brief: null, at: null, running: false, error: null };
// 持久化:重启后 LEO 播报/巡检结果立即可用,到点自动刷新
const AI_NETWORK_FILE = path.join(dataDir, "ai-network.json");
try {
  if (fs.existsSync(AI_NETWORK_FILE)) {
    aiJobs.network = { ...aiJobs.network, ...JSON.parse(fs.readFileSync(AI_NETWORK_FILE, "utf8")), running: false, error: null };
  }
} catch {}

// [播报] 大结论措辞 → 等级:正常=ok(前端折叠) / 需关注=warn / 告警=alert
const verdictOf = (line) => {
  const head = (line ?? "").slice(0, 40);
  return head.includes("告警") ? "alert" : head.includes("需关注") ? "warn" : "ok";
};

async function runNetworkAnalysis(days = 7, auto = true) {
  if (aiJobs.network.running) return aiJobs.network;
  aiJobs.network = { ...aiJobs.network, running: true, error: null };
  try {
    const raw = await runAnalysis(await buildAiData(days));
    // 首行 [播报] = LEO 气泡的 24h 基本面口播;其余为巡检正文
    let brief = null, text = raw;
    const nl = raw.indexOf("\n");
    const first = (nl === -1 ? raw : raw.slice(0, nl)).trim();
    if (first.startsWith("[播报]")) {
      brief = first.replace(/^\[播报\]\s*/, "").trim();
      text = nl === -1 ? "" : raw.slice(nl + 1).trim();
    }
    aiJobs.network = { text, brief, verdict: verdictOf(brief ?? text), windowDays: days, at: Date.now(), running: false, error: null, auto };
    try { fs.writeFileSync(AI_NETWORK_FILE, JSON.stringify({ text, brief, verdict: aiJobs.network.verdict, windowDays: days, at: aiJobs.network.at, auto })); } catch {}
  } catch (err) {
    aiJobs.network = { ...aiJobs.network, running: false, error: err.message };
  }
  broadcast("aiNetwork", aiJobs.network);
  return aiJobs.network;
}
app.post("/api/ai/analyze", async (req) => {
  if (aiJobs.network.running) return { running: true, text: aiJobs.network.text, at: aiJobs.network.at };
  const days = Math.min(Math.max(parseInt(req.body?.days, 10) || 7, 1), 30);
  const n = aiJobs.network;
  if (n.text && n.at && n.windowDays === days && Date.now() - n.at < AI_TTL_MS) {
    return { text: n.text, brief: n.brief, verdict: n.verdict, windowDays: days, at: n.at, running: false, cached: true };
  }
  runNetworkAnalysis(days, false);   // 后台执行,前端轮询 GET /api/ai/analyze
  return { queued: true, running: true, at: n.at ?? null };
});
app.get("/api/ai/analyze", async () => aiJobs.network);
// 详情用:返回与 AI 分析同一份维度数据(明细)
app.get("/api/ai/data", async (req) => {
  const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 7, 1), 30);
  return buildAiData(days);
});
setTimeout(runNetworkAnalysis, 45_000);          // first pass once data is warm
setInterval(runNetworkAnalysis, 3600_000);       // hourly auto-refresh

// Block Gas 执行负载解读(30m 序列压缩为统计量)
aiRoutes("blockgas", "/api/ai/blockgas", async (body) => {
  const minutes = Math.min(Math.max(parseInt(body?.minutes, 10) || 30, 30), 1440);
  const bg = minutes === 30
    ? (latest.blockGas ?? await fetchBlockGas(cfg.keterConfigPath))
    : ((blockGasWinCache.minutes === minutes && blockGasWinCache.data && Date.now() - blockGasWinCache.at < 55_000)
        ? blockGasWinCache.data : await fetchBlockGas(cfg.keterConfigPath, minutes));
  if (!bg?.mgasps?.values?.length) throw new Error("keter blockGas 数据不可用");
  const stat = (s, scale = 1) => {
    const v = (s?.values ?? []).filter((x) => typeof x === "number").map((x) => x / scale);
    if (!v.length) return null;
    const r = (x) => +x.toFixed(1);
    return { avg: r(v.reduce((a, b) => a + b, 0) / v.length), max: r(Math.max(...v)), min: r(Math.min(...v)), last: r(v.at(-1)) };
  };
  // 图表只画 2 台典型;解读时喂 keter 全部自营节点的 per-instance 统计
  const all = await fetchExecStatsAll(cfg.keterConfigPath).catch(() => null);
  return runBlockGasAnalysis({
    chartSampleValidators: ["10.213.32.160", "10.213.32.78"],
    windowMinutes: minutes,
    windowLabel: minutes === 30 ? "30 分钟" : `${minutes / 60} 小时`,
    gasLimitM: liveGasLimitM(),
    mgasPerSec: stat(bg.mgasps),
    gasPerBlockM: stat(bg.gasused, 1e6),
    txsPerBlock: stat(bg.txsize),
    allNodes: all ? { mgasps: all.mgasps, gasusedM: all.gasusedM } : null,
  });
});

// 区块导入时延解读:body.days 选窗口(1/7),body.episodeFrom 重点归因单个超阈段
aiRoutes("latency", "/api/ai/latency", async (body) => {
  const days = Math.min(Math.max(parseInt(body?.days, 10) || 1, 1), 7);
  const hours = days * 24;
  const d = (insertLatCache.hours === hours && insertLatCache.data && Date.now() - insertLatCache.at < 55_000)
    ? insertLatCache.data : await fetchInsertLatency(cfg.keterConfigPath, hours);
  if (!d?.times?.length) throw new Error("keter insert-latency 数据不可用");
  const nodeStat = (s) => {
    const v = (s.values ?? []).filter((x) => typeof x === "number");
    if (!v.length) return { instance: s.instance };
    return { instance: s.instance, avgMs: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1), maxMs: +Math.max(...v).toFixed(1) };
  };
  const focus = body?.episodeFrom ? (d.episodes ?? []).find((e) => e.from === Number(body.episodeFrom)) : null;
  // 图表只画 4 台典型;解读时喂:各阶段分解(validation/execution/commit)+ 全节点 per-stage 统计
  const st = (latStagesCache.hours === hours && latStagesCache.data && Date.now() - latStagesCache.at < 55_000)
    ? latStagesCache.data : await fetchLatencyStages(cfg.keterConfigPath, hours).catch(() => null);
  return runLatencyAnalysis({
    hours, windowLabel: days === 1 ? "24h" : `${days} 天`, thresholdMs: d.threshold,
    chartSampleNodes: d.ips,
    overallMeanMs: d.mean, overallMaxMs: d.max, currentMs: d.cur,
    chartNodes: (d.perNode ?? []).map(nodeStat),
    stagesTypical: st?.stages ?? null,
    perNodeStages: (st?.perNode ?? []).slice(0, 40),
    episodesOverThreshold: (d.episodes ?? []).map((e) => ({ from: new Date(e.from).toISOString(), to: new Date(e.to).toISOString(), peakMs: e.peak })),
    focusEpisode: focus ? { from: new Date(focus.from).toISOString(), to: new Date(focus.to).toISOString(), peakMs: focus.peak } : null,
  });
});

// Greedy merge 命中率解读:典型节点均值形态 + 全量节点横向对比
aiRoutes("greedy", "/api/ai/greedy", async (body) => {
  const hours = Math.min(Math.max(parseInt(body?.hours, 10) || 6, 1), 24);
  const d = (greedyCache.hours === hours && greedyCache.data && Date.now() - greedyCache.at < 55_000)
    ? greedyCache.data : await fetchGreedyMerge(cfg.keterConfigPath, hours);
  if (!d?.times?.length) throw new Error("keter greedy-merge 数据不可用");
  return runGreedyMergeAnalysis({
    hours,
    chartSampleNodes: d.ips,
    overallMean: d.mean, overallMax: d.max, overallMin: d.min, current: d.cur,
    chartNodes: (d.perNode ?? []).map((s) => {
      const v = (s.values ?? []).filter((x) => typeof x === "number");
      return v.length ? { instance: s.instance, avg: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1), max: Math.max(...v), min: Math.min(...v) } : { instance: s.instance };
    }),
    allNodes: d.allNodes,
  });
});

// Reorg 解读:严重度 + 涉及方(自营/外部),无日志不做根因
// body.eventT → 单事件归因(5m 定位 + canonical miner 序列取证);body.days → 整体解读窗口
aiRoutes("reorg", "/api/ai/reorg", async (body) => {
  const tl = latest.reorgTimeline ?? await fetchReorgTimeline(cfg.keterConfigPath).then(enrichReorgEvents).catch(() => null);
  const vinfo = (addr) => {
    const v = VALIDATORS[(addr || "").toLowerCase()];
    return v ? { name: v.name, group: v.group, internal: v.group === "internal" } : { name: (addr || "").slice(0, 10), group: "unknown", internal: false };
  };

  // ── 单事件归因:定位 5m 时刻 → 块高区间 → canonical miner 序列(找出块 gap 与赢家)──
  const picked = body?.eventT ? (tl?.events ?? []).find((e) => e.t === Number(body.eventT)) : null;
  if (picked) {
    const refined = await refineReorgMoment(cfg.keterConfigPath, picked.t).catch(() => null);
    const winT = refined?.momentT ?? picked.t;
    // 精化命中:±5m 窗口;否则整个小时桶
    const [fromB, toB] = await Promise.all([
      blockAtTime(refined ? winT - 300e3 : picked.t - 3600e3),
      blockAtTime(refined ? winT + 300e3 : picked.t),
    ]);
    // canonical 链 miner 序列采样:重组段在 canonical 链上表现为块时间 gap,gap 后首块 miner 即赢家
    const fetchSeq = async (from, to, step) => {
      const nums = []; for (let n = from; n <= to; n += step) nums.push(n);
      const headers = await Promise.all(nums.map((n) =>
        streamer.http.send("eth_getHeaderByNumber", ["0x" + n.toString(16)]).catch(() => null)));
      let prevTs = null;
      return headers.filter(Boolean).map((h) => {
        const ts = Number(BigInt(h.timestamp)) * 1000 + (h.mixHash ? Number(BigInt(h.mixHash) % 1000n) : 0);
        const gapMs = prevTs != null ? ts - prevTs : null; prevTs = ts;
        return { block: Number(BigInt(h.number)), timeLocal: new Date(ts).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }), miner: vinfo(h.miner).name, group: vinfo(h.miner).group, gapMs };
      });
    };
    let minerSeq = null, fineSeq = null;
    const step = fromB && toB && toB > fromB ? Math.max(1, Math.floor((toB - fromB) / 60)) : null;
    if (step) {
      minerSeq = await fetchSeq(fromB, toB, step);
      // 二次精化:粗采样里超出预期最多的 gap,其邻域拉 step=1 逐块序列,把重组边界与赢家 validator 钉到单块
      if (step > 1 && minerSeq.length > 2) {
        let best = null;
        for (let i = 1; i < minerSeq.length; i++) {
          const g = minerSeq[i].gapMs;
          if (g != null && (best == null || g > minerSeq[best].gapMs)) best = i;
        }
        if (best != null && minerSeq[best].gapMs > step * 450 + 900) {
          const a = minerSeq[best - 1].block;
          fineSeq = await fetchSeq(a, Math.min(minerSeq[best].block, a + 80), 1);
        }
      }
    }
    const beijing = (t) => new Date(t).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
    return runReorgEventAnalysis({
      event: { timeLocal: beijing(picked.t), count: picked.count, orphans: picked.orphans, nodesSaw: picked.nodes ?? null },
      refinedMoment: refined ? { timeLocal: beijing(winT), executes5m: refined.executes5m } : null,
      blockRange: { from: fromB, to: toB, sampleStepBlocks: step },
      canonicalMinerSequence: minerSeq,
      fineWindow: fineSeq,   // 最大 gap 邻域的逐块序列(step=1);无明显 gap 时为 null
      expectedBlockGapMs: 450,
    });
  }

  // ── 整体解读:窗口可选(默认 7d,支持 1/7/15/30)──
  // 只喂链级数据(geth chain_reorg_executes,≥2 节点确认):本机 WS 观测走的是 LB RPC,
  // 后端切换会被误读成 depth 2-3 的"重组"(24h 可达数百次假事件),不进 AI 输入。
  // 指标框架对齐 osaka-mendel 报告:链级次数/日、去重孤块/日、发生天数、平均深度、单日峰值。
  const days = Math.min(Math.max(parseInt(body?.days, 10) || 7, 1), 30);
  const cut = Date.now() - days * 86400e3;
  const dayRows = (tl?.days ?? []).slice(-days);
  const total = dayRows.reduce((s, d) => s + d.count, 0);
  const orphans = dayRows.reduce((s, d) => s + d.orphans, 0);
  const peak = dayRows.reduce((m, d) => (d.count > m.count ? d : m), { count: 0, date: null });
  return runReorgAnalysis({
    windowDays: days,
    windowStats: {
      reorgsPerDay: +(total / Math.max(days, 1)).toFixed(2),
      orphansPerDayDedup: +(orphans / Math.max(days, 1)).toFixed(2),
      totalReorgs: total,
      totalOrphansDedup: orphans,
      peakDay: peak.count ? peak : null,   // 仅用于「单日 >10 次」重点提醒,不进常规输出
    },
    chainReorg24h: reorg24hFiltered(),         // 滚动 24h 链级次数(与页面卡片同源;窗口与日历日不同)
    // 事件附块高区间与接管方:优先 enrichReorgEvents 的 5m 精化值(startBlock/endBlock/winner),
    // 缺失时退回小时桶粗算,总结里直接给明细,免得用户再逐个点「分析」
    events: await Promise.all((tl?.events ?? []).filter((e) => e.t >= cut).slice(0, 8).map(async (e) => {
      let from = e.startBlock ?? null, to = e.endBlock ?? null;
      if (from == null || to == null) {
        [from, to] = await Promise.all([
          blockAtTime(e.t).catch(() => null),
          blockAtTime(e.t + 3600e3).catch(() => null),
        ]);
      }
      return {
        ...e,
        timeLocal: new Date(e.t).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
        approxBlockRange: from && to ? { from, to } : null,
      };
    })),
  });
});

// 节点同步解读:全节点 head 增长分布 + 异常历史(body.days 选窗口)→ 孤立/集群性判断
aiRoutes("sync", "/api/ai/sync", async (body) => {
  const days = Math.min(Math.max(parseInt(body?.days, 10) || 1, 1), 7);
  const d = (syncDetailCache.data && syncDetailCache.days === days && Date.now() - syncDetailCache.at < 55_000)
    ? syncDetailCache.data : await fetchSyncDetail(cfg.keterConfigPath, 10, 600, days);
  if (!d?.nodes?.length) throw new Error("keter sync 数据不可用");
  const disk = latest.diskAlerts ?? [];
  return runSyncAnalysis({
    windowMin: d.windowMin, threshold: d.threshold, expected: d.expected,
    windowLabel: days === 1 ? "24h" : `${days} 天`,
    behindNow: d.nodes.filter((n) => n.grew < d.threshold),
    totalNodes: d.total,
    growthDistribution: { min: d.nodes[0]?.grew, p50: d.nodes[Math.floor(d.nodes.length / 2)]?.grew, max: d.nodes.at(-1)?.grew },
    historyAnomalyNodes: d.history,
    diskAlerts: disk.slice(0, 5),
  });
});

// 大流量分析:最近一次大流量事件 + 峰值时段链上采样(合约归因)
// body.days+focus → 窗口形态解读(pending / gas 单维度);body.episodeStart → 单事件归因
// 流量分析走 jobId 池:多个事件归因 / 汇总可并发(不同目标各自独立通道),避免单槽互相 409
aiJobPool("/api/ai/traffic", async (body) => {
  // 冷启动 latest 尚空时兜底也要 enrich,保证 episodes 带 refined.startBlock(否则块区间缺失)
  const tl = latest.trafficTimeline ?? await enrichEpisodes(await fetchTrafficTimeline(cfg.keterConfigPath));
  const tx = txpoolStore.getView();
  const win = streamer.getWindowStats() || {};

  if (body?.focus && body?.days) {
    const days = Math.min(Math.max(Number(body.days), 1), 15);
    const focus = body.focus === "gas" ? "gas" : "pending";
    const h = tl.hourly ?? { times: [], pending: [], gasPct: [] };
    const hours = Math.min(Math.round(days * 24), h.times.length);
    const seq = (focus === "gas" ? h.gasPct : h.pending).slice(-hours).filter((v) => typeof v === "number");
    const over = focus === "gas" ? (v) => v >= (tl.hotPct ?? 90) : (v) => v > (tl.threshold ?? 4000);
    const cut = Date.now() - days * 86400e3;
    // gas 口径补分钟级:episodes 是小时均值,短时打满(1-2 分钟 90%+)会被摊平漏掉;
    // 近 24h 的瞬时高峰(>45M,与 Block Gas 图表黄框同源)单独喂给 AI
    let peaks24h;
    if (focus === "gas") {
      try {
        const bg = (blockGasWinCache.minutes === 1440 && blockGasWinCache.data && Date.now() - blockGasWinCache.at < 60_000)
          ? blockGasWinCache.data : await fetchBlockGas(cfg.keterConfigPath, 1440);
        const p = await gasPeaks(bg.gasused);
        peaks24h = {
          thresholdM: PEAK_GAS / 1e6, total: p.total,
          segments: p.peaks.map((s) => ({
            ...s,
            timeLocal: new Date(s.startT).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
            peakPct: +(s.peakM / liveGasLimitM() * 100).toFixed(0),
          })),
        };
      } catch {}
    }
    return runTrafficTrendAnalysis({
      focus,
      windowLabel: days === 1 ? "24h" : `${days} 天`,
      hotPct: tl.hotPct ?? 90,
      threshold: tl.threshold ?? 4000,
      gasLimitM: liveGasLimitM(),
      windowStats: seq.length ? {
        cur: seq.at(-1),
        avg: +(seq.reduce((a, b) => a + b, 0) / seq.length).toFixed(1),
        max: Math.max(...seq), min: Math.min(...seq),
        hoursOver: seq.filter(over).length, hoursTotal: seq.length,
      } : null,
      // 每个事件都补齐块区间:优先 5m 精化值,缺失用小时桶起止时间换算,保证 AI 每条都能给区间
      episodes: await Promise.all((tl.episodes ?? []).filter((e) => e.start >= cut && e.trigger?.includes(focus)).map(async (e) => {
        const r = e.refined;
        let from = r?.startBlock ?? null, to = r?.endBlock ?? null;
        if (from == null || to == null) {
          [from, to] = await Promise.all([
            blockAtTime(r?.precise ? r.startT : e.start).catch(() => null),
            blockAtTime((r?.precise ? r.endT : (e.end ?? e.start) + 3600e3)).catch(() => null),
          ]);
        }
        return { ...e, blockRange: from && to ? { from, to } : null };
      })),
      minutePeaks24h: peaks24h,   // 近 24h 分钟级瞬时高峰(小时均值口径看不见的部分)
      baseline30d: tl.summary,
      currentPending: focus === "pending" ? tx?.current ?? null : undefined,
      gasUtilPctNow: focus === "gas" ? win.avgGasUtilPct ?? null : undefined,
    });
  }
  // 用户从事件列表点选的历史事件优先;否则进行中大流量 / 最近一次
  const picked = body?.episodeStart ? (tl.episodes ?? []).find((e) => e.start === Number(body.episodeStart)) : null;
  const liveHot = (win.avgGasUtilPct ?? 0) >= (tl.hotPct ?? 90) || !!tx?.anomalyNow;
  const ep = picked ?? (liveHot
    ? { start: Date.now(), peakT: Date.now() - 1800e3, peakGasPct: win.avgGasUtilPct, peakPending: tx?.current ?? null, live: true }
    : tl.lastEpisode);
  let evidence = null;
  if (ep?.peakT) {
    // 精化过的事件直接对准 5m 峰值采样;否则 hourly 桶 t 覆盖 (t-1h, t] 从桶头采
    const sampleFrom = ep.refined?.precise ? ep.refined.peakT - 300e3 : ep.peakT - 3600e3;
    evidence = await sampleBlockContracts(provider, sampleFrom, { samples: 8, labelBook }).catch((e) => ({ error: e.message }));
  }
  return runTrafficAnalysis({
    hotPct: tl.hotPct ?? 90,
    pendingThreshold: tl.threshold ?? 4000,
    gasLimitM: liveGasLimitM(),
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
// jobId 化 + 小并发池:两个人同时提问各自拿各自的结果,互不覆盖
const ASK_MAX_CONCURRENCY = 2;
const askJobs = new Map();   // jobId -> { running, question, text, error, at }
let askActive = 0;
app.post("/api/ai/ask", async (req, reply) => {
  const question = String(req.body?.question ?? "").trim().slice(0, 500);
  if (!question) { reply.code(400); return { error: "empty question" }; }
  if (askActive >= ASK_MAX_CONCURRENCY) { reply.code(429); return { error: "问答通道繁忙(已有多人提问中),请稍候再试", running: true }; }
  if (!ipAllowed(req.ip)) { reply.code(429); return { error: RATE_MSG }; }
  const jobId = Math.random().toString(36).slice(2, 10);
  const job = { running: true, question, text: null, error: null, at: null };
  askJobs.set(jobId, job);
  askActive++;
  setTimeout(() => askJobs.delete(jobId), 15 * 60_000);   // 完成后留 15min 供轮询取走
  (async () => {
    try {
      const base = await buildAiData();
      const m = mevAgg.getStats();

      // 问题里带更长时间范围(如"最近40天")→ 按需拉取对应窗口的历史,而非受限于默认快照
      let reorgTl = latest.reorgTimeline, trafficTl = latest.trafficTimeline;
      const dm = question.match(/(\d{1,3})\s*(天|日|days?|d\b)/i);
      const wantDays = dm ? Math.min(parseInt(dm[1], 10), 90) : null;
      if (wantDays && wantDays > 14) {
        const [r, t] = await Promise.all([
          fetchReorgTimeline(cfg.keterConfigPath, wantDays).then(enrichReorgEvents).catch(() => null),
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
        mev: m ? {
          windowBlocks: m.total, mevPct: m.mevPct, v2Pct: m.v2Pct,
          topFamilies: m.builderFamilies.slice(0, 5),
          // instance 明细(24h):回答「某家族旗下有几个 builder/各占多少」
          builderInstances24h: (m.instances ?? []).slice(0, 20).map((i) => ({ name: i.name, family: i.family, blocks: i.n, pctOfMev: i.pct })),
        } : null,
        // 交易分类摘要(24h):回答「今天 meme 占比/某热门合约是什么」
        txn: (() => {
          try {
            const v = txnStore.view(labelBook);
            return { total24: v.total24, catPct24: v.catPct24, topContracts24: (v.topContracts ?? []).slice(0, 10).map((c) => ({ addr: c.addr, name: c.name, cat: c.cat, txs: c.n })) };
          } catch { return null; }
        })(),
        keterNodes: (latest.nodeStats ?? []).length,
      };
      const text = await runAsk(question, context);
      Object.assign(job, { running: false, text, error: null, at: Date.now() });
    } catch (err) {
      Object.assign(job, { running: false, error: err.message });
    } finally {
      askActive = Math.max(0, askActive - 1);
    }
  })();
  return { jobId, queued: true, running: true, at: null };
});
// 轮询取结果:?job=<jobId>;不带 job 时返回通道状态(兼容探测)
app.get("/api/ai/ask", async (req) => {
  const id = req.query?.job;
  if (id) return askJobs.get(id) ?? { error: "任务不存在或已过期,请重新提问", running: false };
  return { running: askActive > 0, active: askActive };
});

// MEV 状态分析:24h 小时桶口径(占比/集中度/家族与实例份额环比),与 MEV 页四卡对齐
aiRoutes("mev", "/api/ai/mev", async () => {
  const m = mevAgg.getStats();
  if (!m) throw new Error("MEV 窗口尚未积累数据,请稍候");
  return runMevAnalysis({
    day24: m.day24,
    concentration: m.concentration,
    familiesDay: m.famsDay,
    instances: (m.instances ?? []).slice(0, 12),
  });
});

// Slash 解读:谁被 slash / 连续性 / 替代者 / 出块间隔 / 自营还是外部(窗口 1/7/15 天)
aiRoutes("slash", "/api/ai/slash", async (body) => {
  const days = Math.min(Math.max(Number(body?.days) || 1, 1), 15);
  const label = days === 1 ? "24h" : `${days} 天`;
  const v = slashEvents.view(days * 86400e3);
  if (!v.count) throw new Error(`近 ${label} 无 slash 事件`);
  return runSlashAnalysis({
    windowLabel: label,
    totalSlashBlocks: v.count,
    episodes: slashEpisodes(v.items).slice(0, 20),
  });
});

// 空块简析:validator 分布 / 聚集性(窗口 1/7/15 天);miner 补名称与归属
aiRoutes("empty", "/api/ai/empty", async (body) => {
  const days = Math.min(Math.max(Number(body?.days) || 1, 1), 15);
  const label = days === 1 ? "24h" : `${days} 天`;
  const v = emptyStore.view(days * 86400e3);
  if (!v.count) throw new Error(`近 ${label} 无空块`);
  const blocks = v.recent.map((b) => {
    const info = validatorInfo(b.miner);
    return { ...b, validator: info.name ?? (b.miner || "").slice(0, 10), internal: info.internal };
  });
  return runEmptyAnalysis({ windowLabel: label, count: v.count, blocks });
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
    gasLimitM: liveGasLimitM(),
    threshold: tl.threshold,
  });
});
// 交易分析:7 天分类趋势 + 24h 分布 + top 合约(附地址情报,已缓存直挂、未缓存后台预热)
app.get("/api/txn", async (req) => {
  const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 1, 1), 7);
  const v = txnStore.view(labelBook, days);
  for (const c of v.topContracts ?? []) {
    const it = getCachedIntel(c.addr);
    if (it) c.intel = { type: it.type, codeSize: it.codeSize, nonce: it.nonce, verifiedName: it.verifiedName };
    else getAddrIntel(provider, c.addr, { bscscanKey: cfg.bscscanKey }).catch(() => {});
  }
  return v;
});
aiRoutes("txn", "/api/ai/txn", async (body) => {
  const days = Math.min(Math.max(Number(body?.days) || 7, 1), 7);   // 默认 7 天(机器人默认总结同口径)
  const v = txnStore.view(labelBook, days);
  if (!v.total24) throw new Error("采样数据积累中(每分钟 1 块),请稍后再试");
  return runTxnFeatureAnalysis({ ...v, windowLabel: days === 1 ? "24h" : `${days} 天` });
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
console.log(`[ai] backend: ${aiInfo()}`);
