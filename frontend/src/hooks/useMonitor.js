/**
 * Central state hook — subscribes to WebSocket, exposes all dashboard data.
 */

import { useEffect, useReducer } from "react";
import { createWSClient } from "../lib/ws.js";

const init = {
  // Block stream
  recentBlocks:  [],   // last 200 blocks
  windowStats:   null, // { mevPct, avgBlockTimeMs, avgGasUtilPct, anomalyCount, builderCounts }
  latestBlock:   null,

  // Keter node metrics
  nodeStats:     [],   // [{instance, nodeType, miningFeatures, ...}]
  gasUsed:       {},   // { dex-prod: [{labels, times, values}] }
  latency:       {},   // same shape
  diskAlerts:    [],

  // On-chain
  slashStatus:   [],   // [{consensusAddr, slashCount, status}]

  // MEV (from getchainstatus mev.log)
  mevStats:      null, // { mevPct, v2Pct, typeCounts, builderFamilies, topMiners, recent }

  // TxPool (dataseed pending + 24h traffic-anomaly)
  txpool:        null, // { threshold, times, avg, max, current, anomalyCount, windows, anomalyNow }

  // Reorg (Keter chain_reorg_executes — ground truth, app WS inference is unreliable)
  reorgStats:    null, // { reorg24h, source }
  reorgTimeline: null, // { days:[{date,count,orphans}], events, summary } — 14d chain-level dedup
  syncErrors:    null, // { count, total, nodes:[{instance,grew}] } — chain head 增长异常
  slashEvents:   null, // { count, recent:[{t,block,validator,tx}] } — validatorSlashed 24h
  blockGas:      null, // { mgasps:{times,values}, gasused:{...}, txsize:{...} } — execution view
  trafficTimeline: null, // { threshold, days, episodes, lastEpisode, summary } — 30d hourly
  keterHealth:   null, // { okAt, timelineOkAt, error } — keter 快照新鲜度

  connected: false,
};

function reducer(state, action) {
  switch (action.type) {
    case "connected":    return { ...state, connected: action.data ?? true };
    case "disconnected": return { ...state, connected: false };

    // periodic poll of recent blocks (replaces window; keeps ring/river live without WS)
    case "blocks": {
      const b = action.data ?? [];
      return b.length ? { ...state, recentBlocks: b, latestBlock: b.at(-1) } : state;
    }

    case "snapshot": {
      const d = action.data;
      return {
        ...state,
        recentBlocks: d.recentBlocks ?? [],
        windowStats:  d.windowStats,
        latestBlock:  d.recentBlocks?.at(-1) ?? null,
        // full snapshot may carry latest cached poll data
        slashStatus:  d.slashStatus ?? state.slashStatus,
        nodeStats:    d.nodeStats   ?? state.nodeStats,
        gasUsed:      d.gasUsed     ?? state.gasUsed,
        latency:      d.latency     ?? state.latency,
        diskAlerts:   d.diskAlerts  ?? state.diskAlerts,
        mevStats:     d.mevStats    ?? state.mevStats,
        txpool:       d.txpool      ?? state.txpool,
        reorgStats:   d.reorgStats  ?? state.reorgStats,
        reorgTimeline: d.reorgTimeline ?? state.reorgTimeline,
        blockGas:     d.blockGas    ?? state.blockGas,
        trafficTimeline: d.trafficTimeline ?? state.trafficTimeline,
        syncErrors:   d.syncErrors  ?? state.syncErrors,
        slashEvents:  d.slashEvents ?? state.slashEvents,
      };
    }

    case "block": {
      const blocks = [...state.recentBlocks, action.data].slice(-200);
      return { ...state, recentBlocks: blocks, latestBlock: action.data };
    }

    case "windowStats":  return { ...state, windowStats:  action.data };
    case "mevStats":     return { ...state, mevStats:     action.data };
    case "nodeStats":    return { ...state, nodeStats:    action.data };
    case "gasUsed":      return { ...state, gasUsed:      action.data };
    case "latency":      return { ...state, latency:      action.data };
    case "diskAlerts":   return { ...state, diskAlerts:   action.data };
    case "txpool":       return { ...state, txpool:       action.data };
    case "reorgStats":   return { ...state, reorgStats:   action.data };
    case "reorgTimeline":return { ...state, reorgTimeline:action.data };
    case "blockGas":     return { ...state, blockGas:     action.data };
    case "trafficTimeline": return { ...state, trafficTimeline: action.data };
    case "syncErrors":   return { ...state, syncErrors:   action.data };
    case "slashEvents":  return { ...state, slashEvents:  action.data };
    case "slashStatus":  return { ...state, slashStatus:  action.data };
    case "keterHealth":  return { ...state, keterHealth:  action.data };

    default: return state;
  }
}

// ---------------------------------------------------------------------------
// Mock data for local dev (no backend). Set VITE_MOCK=1 to enable.
// ---------------------------------------------------------------------------
function buildMock() {
  const builders = ['blockrazor','puissant','blockroute','jetbldr','nodereal','txboost',null];
  // BSC mainnet is at 0.45s blocks (Fermi hardfork, 2026-01-14)
  const blocks = Array.from({length: 200}, (_, i) => ({
    number: 40000000 + i,
    gasUsed: Math.floor(10e6 + Math.random() * 40e6),
    gasLimit: 55e6,
    blockTimeMs: 420 + Math.random() * 80,
    isMev: Math.random() > 0.35,
    builder: builders[Math.floor(Math.random() * builders.length)],
    anomaly: Math.random() > 0.97,
    miner: '0x72b61c6014342d914470ec7ac2975be345796c2b',
  }));
  const now = Date.now();
  const times = Array.from({length: 30}, (_, i) => now - (29-i)*60000);
  return {
    recentBlocks: blocks,
    latestBlock: blocks[blocks.length - 1],
    windowStats: { mevPct: 68.5, avgBlockTimeMs: 452, avgGasUtilPct: 76.3, anomalyCount: 2, empty24h: 0 },
    slashStatus: [
      { consensusAddr: '0x26324d97c8f3e4e53ce359f8aed8495ae45b0d11', slashCount: 45, status: 'warn' },
    ],
    nodeStats: [
      { etherbase: '0x72b61c6014342d914470ec7ac2975be345796c2b', nodeType: 'v1.7.3', instance: '10.211.1.1:9090' },
      { etherbase: '0x26324d97c8f3e4e53ce359f8aed8495ae45b0d11', nodeType: 'v1.7.2', instance: '10.211.1.2:9090' },
      { etherbase: '0x4430b3230294d12c6ab2aac5c2cd68e80b16b581', nodeType: 'v1.7.3', instance: '10.211.1.3:9090' },
      { etherbase: '0xe2d3a739effcd3a99387d015e260eefac72ebea1', nodeType: 'v1.6.4', instance: '10.212.1.1:9090' },
      { etherbase: '0xb4dd66d7c2c7e57f628210187192fb89d4b99dd4', nodeType: 'v1.7.3', instance: '10.212.1.2:9090' },
      { etherbase: '0x9f8ccdafcc39f3c7d6ebf637c9151673cbc36b88', nodeType: 'v1.7.3', instance: '10.212.1.3:9090' },
    ],
    gasUsed: { 'dex-prod': [{ times, values: times.map(() => Math.floor(90e6 + Math.random()*40e6)) }] },
    latency: {
      times, nodes: 35, spanHours: 24,
      p50: times.map(() => Math.floor(70 + Math.random()*30)),
      p95: times.map(() => Math.floor(130 + Math.random()*50)),
      p99: times.map(() => Math.floor(190 + Math.random()*70)),
      baseline24h: { p50: 85, p95: 150, p99: 210 },
    },
    diskAlerts: [],
    mevStats: {
      total: 2000, latest: 105007219, mevPct: 99, v2Pct: 0,
      typeCounts: { mev_v1: 1980, local: 20 },
      builderFamilies: [["blockrazor", 900], ["48club", 900], ["unknown", 140], ["nodereal", 30], ["jetbldr", 18], ["blockroute", 12]],
      topMiners: [["Tranchess", 96], ["LegendII", 88], ["Shannon", 80], ["Defibit", 72], ["Namelix", 64]],
      recent: [],
    },
    txpool: {
      threshold: 4000,
      times,
      avg: times.map((_, i) => (i >= 12 && i <= 18 ? 4200 + Math.random()*1500 : 2500 + Math.random()*900)),
      max: times.map((_, i) => (i >= 12 && i <= 18 ? 6800 + Math.random()*2000 : 4200 + Math.random()*1200)),
      current: 2780, max24h: 5610, anomalyCount: 1,
      windows: [{ start: now - 18*60000, end: now - 12*60000, peak: 5610 }],
      anomalyNow: false, spanHours: 24,
    },
    reorgStats: { reorg24h: 0, source: "keter" },
    syncErrors: { count: 0, total: 33, windowMin: 10, expected: 1333, nodes: [] },
    slashEvents: { count: 0, recent: [] },
    blockGas: {
      mgasps:  { times, values: times.map(() => 420 + Math.random() * 120) },
      gasused: { times, values: times.map(() => 13e6 + Math.random() * 6e6) },
      txsize:  { times, values: times.map(() => 70 + Math.random() * 50) },
    },
    trafficTimeline: (() => {
      const hTimes = Array.from({length: 30*24}, (_, i) => now - (30*24-1-i)*3600e3);
      const spike = (i) => hTimes.length-1-i === 30 || hTimes.length-1-i === 130;
      return {
        hotPct: 90, threshold: 4000,
        hourly: {
          times: hTimes,
          pending: hTimes.map((_, i) => spike(i) ? 9000+Math.random()*3000 : 850+Math.random()*250),
          gasPct: hTimes.map((_, i) => spike(i) ? 35+Math.random()*5 : 8+Math.random()*15),
        },
        episodes: [ { start: now-130*3600e3, end: now-130*3600e3, peakT: now-130*3600e3, peakPending: 11956, peakGasM: 54, peakGasPct: 38, hours: 1, trigger: "pending" } ],
        lastEpisode: { start: now-130*3600e3, end: now-130*3600e3, peakT: now-130*3600e3, peakPending: 11956, peakGasM: 54, peakGasPct: 38, hours: 1, trigger: "pending" },
        summary: { spanDays: 30, baseline: 918, p90: 935, p99: 1241, maxPending: 11956, maxGasPct: 38, hotHours: 2, episodeCount: 1 },
      };
    })(),
    reorgTimeline: {
      days: Array.from({length: 14}, (_, i) => ({ date: `6/${18+i}`, count: [0,2,0,0,1,0,0,3,0,0,0,1,0,2][i], orphans: [0,5,0,0,3,0,0,8,0,0,0,2,0,9][i] })),
      events: [ { t: now - 3600e3 * 30, count: 2, orphans: 9, nodes: 35 }, { t: now - 3600e3 * 80, count: 1, orphans: 2, nodes: 28 } ],
      summary: { spanDays: 14, total: 9, orphans: 27, excluded: 1, avgPerDay: 0.64, daysWithReorg: 5, avgDepth: 3.0, peakDay: { date: "6/25", count: 3 } },
    },
    connected: true,
  };
}

export function useMonitor() {
  const [state, dispatch] = useReducer(reducer, init);

  useEffect(() => {
    if (import.meta.env.VITE_MOCK === '1') {
      const mock = buildMock();
      dispatch({ type: 'connected' });
      dispatch({ type: 'snapshot',   data: { recentBlocks: mock.recentBlocks, windowStats: mock.windowStats } });
      dispatch({ type: 'mevStats',   data: mock.mevStats });
      dispatch({ type: 'nodeStats',  data: mock.nodeStats });
      dispatch({ type: 'slashStatus',data: mock.slashStatus });
      dispatch({ type: 'gasUsed',    data: mock.gasUsed });
      dispatch({ type: 'latency',    data: mock.latency });
      dispatch({ type: 'diskAlerts', data: mock.diskAlerts });
      dispatch({ type: 'txpool',     data: mock.txpool });
      dispatch({ type: 'reorgStats', data: mock.reorgStats });
      dispatch({ type: 'reorgTimeline', data: mock.reorgTimeline });
      dispatch({ type: 'blockGas',   data: mock.blockGas });
      dispatch({ type: 'trafficTimeline', data: mock.trafficTimeline });
      return;
    }

    // Continuous polling so EVERY panel keeps updating to the latest height,
    // independent of the WS (which can be unreachable behind proxies). WS, when
    // available, adds sub-second live block pushes between polls.
    const API = import.meta.env.VITE_API_BASE ?? "";
    const get = (url) => fetch(API + url).then((r) => (r.ok ? r.json() : null));
    const put = (url, type) => get(url).then((d) => d != null && dispatch({ type, data: d }));

    // fast tier (~2.5s): block stream, headline stats, MEV
    const fast = () => {
      get("/api/blocks")
        .then((d) => { dispatch({ type: "connected", data: true }); if (d) dispatch({ type: "blocks", data: d }); })
        .catch(() => dispatch({ type: "connected", data: false }));
      put("/api/window", "windowStats");
      put("/api/mev", "mevStats");
    };
    // slow tier (~25s): keter metrics + on-chain slash
    const slow = () => {
      put("/api/slash", "slashStatus");
      put("/api/latency", "latency");
      put("/api/nodes", "nodeStats");
      put("/api/gas-used", "gasUsed");
      put("/api/disk", "diskAlerts");
      put("/api/txpool", "txpool");
      put("/api/reorg", "reorgStats");
      put("/api/reorg-timeline", "reorgTimeline");
      put("/api/block-gas", "blockGas");
      put("/api/traffic-timeline", "trafficTimeline");
      put("/api/sync-errors", "syncErrors");
      put("/api/slash-events", "slashEvents");
      put("/api/keter-health", "keterHealth");
    };
    fast(); slow();
    const fastTimer = setInterval(fast, 2500);
    const slowTimer = setInterval(slow, 25000);

    // Background tabs throttle setInterval (and may suspend on sleep). The moment
    // the tab is visible again, pull a fresh REST snapshot so the height — which
    // never depends on the WS — jumps straight to the tip instead of crawling.
    const onVisible = () => { if (!document.hidden) { fast(); slow(); } };
    document.addEventListener("visibilitychange", onVisible);

    // WS for low-latency live block append (best-effort; polling is the safety net)
    const client = createWSClient({
      snapshot:    (d) => dispatch({ type: "snapshot",    data: d }),
      block:       (d) => dispatch({ type: "block",       data: d }),
      windowStats: (d) => dispatch({ type: "windowStats", data: d }),
      mevStats:    (d) => dispatch({ type: "mevStats",    data: d }),
      nodeStats:   (d) => dispatch({ type: "nodeStats",   data: d }),
      gasUsed:     (d) => dispatch({ type: "gasUsed",     data: d }),
      latency:     (d) => dispatch({ type: "latency",     data: d }),
      diskAlerts:  (d) => dispatch({ type: "diskAlerts",  data: d }),
      txpool:      (d) => dispatch({ type: "txpool",      data: d }),
      reorgStats:  (d) => dispatch({ type: "reorgStats",  data: d }),
      reorgTimeline: (d) => dispatch({ type: "reorgTimeline", data: d }),
      blockGas:    (d) => dispatch({ type: "blockGas",    data: d }),
      trafficTimeline: (d) => dispatch({ type: "trafficTimeline", data: d }),
      syncErrors:  (d) => dispatch({ type: "syncErrors",  data: d }),
      slashEvents: (d) => dispatch({ type: "slashEvents", data: d }),
      slashStatus: (d) => dispatch({ type: "slashStatus", data: d }),
      keterHealth: (d) => dispatch({ type: "keterHealth", data: d }),
    });

    return () => { clearInterval(fastTimer); clearInterval(slowTimer); document.removeEventListener("visibilitychange", onVisible); client.close(); };
  }, []);

  return state;
}
