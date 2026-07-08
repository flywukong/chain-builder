/**
 * Keter metric queries used by the dashboard.
 * Each function returns structured data ready for WebSocket push.
 */

import { grafanaQuery, rangeQuery, DATASOURCES, DS_JOBS, extractLabels, extractSeries } from "./client.js";

// ── Node inventory (version, features, etherbase) ──────────────────────────
// Polls all datasources, merges results
export async function fetchNodeStats(configPath) {
  const nodes = [];
  for (const [dsName, dsUid] of Object.entries(DATASOURCES)) {
    const jobs = DS_JOBS[dsName];
    const raw = await grafanaQuery(dsUid, `node_stats{job=~"${jobs}"}`, { configPath });
    const labels = extractLabels(raw);
    for (const l of labels) {
      nodes.push({
        datasource:      dsName,
        instance:        l.instance,
        instanceName:    l.instance_name || l.instance_full_name || "",
        job:             l.job,
        etherbase:       l.Etherbase,
        nodeType:        l.NodeType,      // "BSC/1.4.15-xxx/linux-amd64/go1.24.13"
        dbFeatures:      l.DBFeatures,   // "PBSS|MultiDB|PruneBlocks"
        miningFeatures:  l.MiningFeatures, // "MEV|FFVoting"
        netFeatures:     l.NetFeatures,
      });
    }
  }
  return nodes;
}

// ── Gas-used ratio of 2 typical validators (avg) ────────────────────────────
// Default to all-validator lines was too noisy; mirror the team's Grafana which
// shows the average gas-used-ratio of 2 representative IPs.
const GAS_SAMPLE_IPS = (process.env.GAS_SAMPLE_IPS ?? "10.213.32.160,10.213.32.78").split(",").map((s) => s.trim());

export async function fetchGasUsed(configPath, from = "now-30m") {
  const ips = GAS_SAMPLE_IPS.join("|");
  const raw = await rangeQuery(
    DATASOURCES["dex-prod"],
    `avg(chain_insert_gasused{instance=~"${ips}"})`,   // 2-IP average gas used (GasPanel scales to util%)
    { from, configPath }
  );
  return { avg: extractSeries(raw) };
}

// ── Block gas (execution view, Monitor) — mgasps / gasused / txsize ─────────
// Distinct from the traffic view (utilization%): how fast blocks EXECUTE and
// how much gas/txs each carries. Same 2 representative IPs as fetchGasUsed.
export async function fetchBlockGas(configPath, from = "now-30m") {
  const ips = GAS_SAMPLE_IPS.join("|");
  const q = (metric) =>
    rangeQuery(DATASOURCES["dex-prod"], `avg(${metric}{instance=~"${ips}"})`, { from, configPath })
      .then((raw) => {
        const s = extractSeries(raw)[0] ?? { times: [], values: [] };
        return { times: s.times, values: s.values };
      });
  const [mgasps, gasused, txsize] = await Promise.all([
    q("chain_insert_mgasps"), q("chain_insert_gasused"), q("chain_insert_txsize"),
  ]);
  return { mgasps, gasused, txsize };
}

// ── Gas utilization % (range) ───────────────────────────────────────────────
export async function fetchGasUtilization(configPath, from = "now-30m") {
  const result = {};
  for (const [dsName, dsUid] of Object.entries(DATASOURCES)) {
    const jobs = DS_JOBS[dsName];
    const raw = await rangeQuery(
      dsUid,
      `chain_block_insert_gasused{job=~"${jobs}"} / on() group_left() chain_config_gas_limit * 100`,
      { from, configPath }
    );
    result[dsName] = extractSeries(raw);
  }
  return result;
}

// ── Latency snapshot (instant, per-instance) — for app-side 24h store ───────
// Returns current per-instance insert-delay values (ms). The LatencyStore turns
// these into p50/p95/p99 + a rolling 24h baseline (no keter avg_over_time query).
export async function fetchLatencySnapshot(configPath) {
  const jobs = DS_JOBS["dex-prod"];
  const raw = await grafanaQuery(DATASOURCES["dex-prod"], `chain_delay_block_insert{job=~"${jobs}"}`, { configPath });
  const series = extractSeries(raw);
  return series.map((s) => s.values?.[s.values.length - 1]).filter((v) => typeof v === "number" && isFinite(v));
}

// ── Block insert latency:4 台样本机均值曲线 + >450ms(出块间隔)异常段 ────
const INSERT_LAT_IPS = (process.env.INSERT_LAT_IPS ?? "10.211.31.89,10.211.32.195,10.211.32.143,10.213.31.163").split(",").map((s) => s.trim());
const BLOCK_INTERVAL_MS = 450;

export async function fetchInsertLatency(configPath, hours = 24) {
  const ips = INSERT_LAT_IPS.join("|");
  const from = `now-${hours}h`;
  // summary 指标带 quantile 标签;取每台 median(q0.5)再跨机均值,>450ms 即处理跟不上出块
  const [avgS, perS] = await Promise.all([
    rangeQuery(DATASOURCES["dex-prod"], `avg(chain_delay_block_insert{instance=~"${ips}",quantile="0.5"})`, { from, configPath }).then(extractSeries),
    rangeQuery(DATASOURCES["dex-prod"], `chain_delay_block_insert{instance=~"${ips}",quantile="0.5"}`, { from, configPath }).then(extractSeries),
  ]);
  const main = avgS[0] ?? { times: [], values: [] };
  const times = main.times ?? [];
  const values = (main.values ?? []).map((v) => (typeof v === "number" ? Math.round(v) : null));

  // avg > 450ms 的连续异常段
  const episodes = [];
  let cur = null;
  times.forEach((t, i) => {
    const v = values[i];
    if (typeof v === "number" && v > BLOCK_INTERVAL_MS) {
      if (!cur) cur = { from: t, to: t, peak: v };
      else { cur.to = t; if (v > cur.peak) cur.peak = v; }
    } else if (cur) { episodes.push(cur); cur = null; }
  });
  if (cur) episodes.push(cur);

  const nums = values.filter((v) => typeof v === "number");
  return {
    hours, ips: INSERT_LAT_IPS, threshold: BLOCK_INTERVAL_MS,
    times, avg: values,
    perNode: perS.map((s) => ({ instance: s.labels.instance, times: s.times, values: s.values.map((v) => (typeof v === "number" ? Math.round(v) : null)) })),
    cur: nums.at(-1) ?? null,
    mean: nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null,
    max: nums.length ? Math.max(...nums) : null,
    episodes,
  };
}

// ── TxPool pending (dataseed nodes) — for traffic-anomaly detection ─────────
// Traffic anomaly = avg pending tx across dataseed nodes > 4000 (user's定义).
// validators sit at ~30-50; dataseed nodes spike to thousands under heavy traffic.
const DATASEED_JOBS = process.env.DATASEED_JOBS ?? ".*bsc-dataseed";

export async function fetchTxpoolSnapshot(configPath) {
  const raw = await grafanaQuery(DATASEED_JOBS_DS(), `txpool_pending{job=~"${DATASEED_JOBS}"}`, { configPath });
  const series = extractSeries(raw);
  return series.map((s) => s.values?.[s.values.length - 1]).filter((v) => typeof v === "number" && isFinite(v));
}
function DATASEED_JOBS_DS() { return DATASOURCES["dex-prod"]; }

// ── DB compaction / write stall(pebble,典型节点)──────────────────────────
const DB_SAMPLE_IPS = (process.env.DB_SAMPLE_IPS ?? "10.211.31.89,10.211.32.195,10.211.32.143").split(",").map((s) => s.trim());

export async function fetchDbStats(configPath, hours = 24) {
  const ips = DB_SAMPLE_IPS.join("|");
  const from = `now-${hours}h`;
  const win = `${hours}h`;
  const range = (expr) => rangeQuery(DATASOURCES["dex-prod"], expr, { from, configPath }).then(extractSeries);
  const inst = (expr) => grafanaQuery(DATASOURCES["dex-prod"], expr, { configPath }).then(extractSeries);

  const [busy, stall, stallDur, stallN, stallSec, l0, nl0, disk] = await Promise.all([
    range(`rate(eth_db_chaindata_compact_time{instance=~"${ips}"}[5m]) / 1e9 * 100`),            // compaction 忙碌 %
    range(`increase(eth_db_chaindata_compact_writedelay_counter{instance=~"${ips}"}[5m])`),      // stall 次数(5m 增量)
    range(`increase(eth_db_chaindata_compact_writedelay_duration{instance=~"${ips}"}[5m]) / 1e6`), // stall 时长 ms(5m 增量)
    inst(`increase(eth_db_chaindata_compact_writedelay_counter{instance=~"${ips}"}[${win}])`),
    inst(`increase(eth_db_chaindata_compact_writedelay_duration{instance=~"${ips}"}[${win}]) / 1e9`),
    inst(`increase(eth_db_chaindata_compact_level0{instance=~"${ips}"}[${win}])`),
    inst(`increase(eth_db_chaindata_compact_nonlevel0{instance=~"${ips}"}[${win}])`),
    inst(`eth_db_chaindata_disk_size{instance=~"${ips}"}`),
  ]);

  const lastOf = (series, ip) => {
    const s = series.find((x) => x.labels.instance === ip);
    const v = s?.values?.at(-1);
    return typeof v === "number" ? v : null;
  };
  const seriesOf = (series) => series.map((s) => ({ instance: s.labels.instance, times: s.times, values: s.values }));

  return {
    hours,
    ips: DB_SAMPLE_IPS,
    busy: seriesOf(busy),
    stall: seriesOf(stall),
    stallDur: seriesOf(stallDur),
    nodes: DB_SAMPLE_IPS.map((ip) => ({
      instance: ip,
      diskTB: lastOf(disk, ip) != null ? +(lastOf(disk, ip) / 1e12).toFixed(2) : null,
      stallN: lastOf(stallN, ip) != null ? Math.round(lastOf(stallN, ip)) : null,
      stallSec: lastOf(stallSec, ip) != null ? +lastOf(stallSec, ip).toFixed(2) : null,
      level0: lastOf(l0, ip) != null ? Math.round(lastOf(l0, ip)) : null,
      nonlevel0: lastOf(nl0, ip) != null ? Math.round(lastOf(nl0, ip)) : null,
    })),
  };
}

// ── Sync errors:chain head 增长异常的节点 ────────────────────────────────────
// 0.45s 出块下 10 分钟应长 ~1333 块;增长 < threshold(600,~45%)判同步异常。
export async function fetchSyncErrors(configPath, windowMin = 10, threshold = 600) {
  const jobs = DS_JOBS["dex-prod"];
  const raw = await grafanaQuery(
    DATASOURCES["dex-prod"],
    `increase(chain_head_block{job=~"${jobs}"}[${windowMin}m])`,
    { configPath }
  );
  const series = extractSeries(raw);
  const nodes = [];
  let total = 0;
  for (const s of series) {
    const v = s.values?.at(-1);
    if (typeof v !== "number") continue;
    total++;
    if (v < threshold) nodes.push({ instance: s.labels.instance, job: s.labels.job, grew: Math.round(v) });
  }
  nodes.sort((a, b) => a.grew - b.grew);
  return { count: nodes.length, total, windowMin, threshold, expected: Math.round((windowMin * 60) / 0.45), nodes };
}

// ── Reorg / bad-block (Keter = ground truth) ────────────────────────────────
// The WS header stream over a load-balanced RPC mis-reads tip rollbacks between
// backends as reorgs. geth's own chain_reorg_executes counter is authoritative.
// raw counter is the node-lifetime total (includes harmless 1-block micro-reorgs);
// the 24h increase is what tells us whether anything reorged *recently* (mainnet = 0).
export async function fetchReorgStats(configPath) {
  const jobs = DS_JOBS["dex-prod"];
  // max, not sum: a chain reorg is recorded once per node, so summing over ~35
  // nodes inflates it ~35x. max ≈ the reorgs a single node actually observed.
  const raw = await grafanaQuery(
    DATASOURCES["dex-prod"],
    `max(increase(chain_reorg_executes{job=~"${jobs}"}[24h]))`,
    { configPath }
  );
  const v = extractSeries(raw)[0]?.values?.at(-1);
  return { reorg24h: typeof v === "number" && isFinite(v) ? Math.round(v) : 0, source: "keter" };
}

// ── Traffic timeline (30d, hourly) ───────────────────────────────────────────
// 大流量 = 复合口径:avg pending > threshold(4000) 或 gas 利用率 ≥ hotPct(90%),
// 任一触发即为大流量小时;事件标注触发原因(pending / gas / both)。
// 返回 hourly 序列供前端灵活切范围(5/7/10/30d)作图。
const GAS_LIMIT = 140e6;

export async function fetchTrafficTimeline(configPath, days = 30, hotPct = 90, threshold = 4000) {
  const opts = { from: `now-${days}d`, intervalMs: 3600_000, maxDataPoints: 24 * days + 12, configPath };
  const [pendRaw, gasRaw] = await Promise.all([
    rangeQuery(DATASOURCES["dex-prod"], `avg(txpool_pending{job=~"${DATASEED_JOBS}"})`, opts),
    rangeQuery(DATASOURCES["dex-prod"], `avg(chain_insert_gasused{instance=~"${GAS_SAMPLE_IPS.join("|")}"})`, opts),
  ]);
  const pend = extractSeries(pendRaw)[0] ?? { times: [], values: [] };
  const gas  = extractSeries(gasRaw)[0]  ?? { times: [], values: [] };
  const gasAt = new Map(gas.times.map((t, i) => [t, gas.values[i]]));
  const hotGas = GAS_LIMIT * (hotPct / 100);

  const vals = pend.values.filter((v) => typeof v === "number");
  const sorted = [...vals].sort((a, b) => a - b);
  const pct = (p) => Math.round(sorted[Math.floor(p * (sorted.length - 1))] ?? 0);

  // hourly 序列(以 pending 时间轴为基准,gas 按 ts 对齐)
  const hourly = { times: [], pending: [], gasPct: [] };
  const episodes = [];
  let cur = null;
  let maxGas = 0, hotHours = 0;
  pend.times.forEach((t, i) => {
    const p = pend.values[i];
    if (typeof p !== "number") return;
    const g = gasAt.get(t);
    const gp = typeof g === "number" ? +((g / GAS_LIMIT) * 100).toFixed(1) : null;
    hourly.times.push(t); hourly.pending.push(Math.round(p)); hourly.gasPct.push(gp);
    if (typeof g === "number") maxGas = Math.max(maxGas, g);

    const hotP = p > threshold, hotG = typeof g === "number" && g >= hotGas;
    if (hotP || hotG) {
      hotHours++;
      if (!cur) cur = { start: t, end: t, peakPending: 0, peakGasM: 0, peakGasPct: 0, peakT: t, hours: 0, trigger: new Set() };
      cur.end = t; cur.hours++;
      if (hotP) cur.trigger.add("pending");
      if (hotG) cur.trigger.add("gas");
      if (Math.round(p) > cur.peakPending) { cur.peakPending = Math.round(p); cur.peakT = t; }
      if (typeof g === "number" && g / 1e6 > cur.peakGasM) { cur.peakGasM = +(g / 1e6).toFixed(1); cur.peakGasPct = Math.round((g / GAS_LIMIT) * 100); }
    } else if (cur) { cur.trigger = [...cur.trigger].join("+"); episodes.push(cur); cur = null; }
  });
  if (cur) { cur.trigger = [...cur.trigger].join("+"); episodes.push(cur); }

  return {
    hotPct,
    threshold,
    hourly,                       // 30d 小时级序列,前端切片 5/7/10/30d
    episodes,
    lastEpisode: episodes.at(-1) ?? null,
    summary: {
      spanDays: Math.round(days),
      baseline: pct(0.5), p90: pct(0.9), p99: pct(0.99),
      maxPending: Math.round(Math.max(...vals, 0)),
      maxGasPct: Math.round((maxGas / GAS_LIMIT) * 100),
      hotHours,
      episodeCount: episodes.length,
    },
  };
}

// ── Reorg timeline (14d, hourly) — mirrors the Osaka/Mendel analysis口径 ─────
// Chain-level dedup: max(increase[1h]) across nodes counts each event once;
// hours where <2 nodes saw a reorg are local jitter and excluded.
export async function fetchReorgTimeline(configPath, days = 14) {
  const jobs = DS_JOBS["dex-prod"];
  const opts = { from: `now-${days}d`, intervalMs: 3600_000, maxDataPoints: 24 * days + 12, configPath };
  const [exeRaw, dropRaw, nodesRaw] = await Promise.all([
    rangeQuery(DATASOURCES["dex-prod"], `max(increase(chain_reorg_executes{job=~"${jobs}"}[1h]))`, opts),
    rangeQuery(DATASOURCES["dex-prod"], `max(increase(chain_reorg_drop{job=~"${jobs}"}[1h]))`, opts),
    rangeQuery(DATASOURCES["dex-prod"], `count(increase(chain_reorg_executes{job=~"${jobs}"}[1h]) > 0)`, opts).catch(() => null),
  ]);
  const exe   = extractSeries(exeRaw)[0]  ?? { times: [], values: [] };
  const drop  = extractSeries(dropRaw)[0] ?? { times: [], values: [] };
  const nodeS = nodesRaw ? (extractSeries(nodesRaw)[0] ?? { times: [], values: [] }) : { times: [], values: [] };

  const dropAt = new Map(drop.times.map((t, i) => [t, drop.values[i]]));
  // affected-node series comes back sparse with its own step — match by nearest ts
  const nodesNear = (t) => {
    let best = null, bd = 2.5 * 3600_000;
    nodeS.times.forEach((nt, i) => { const d = Math.abs(nt - t); if (d < bd) { bd = d; best = nodeS.values[i]; } });
    return best;
  };

  const dayKey = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; }; // host-local day (CST)
  const daysMap = new Map();
  const events = [];
  let excluded = 0;
  exe.times.forEach((t, i) => {
    const k = dayKey(t);
    if (!daysMap.has(k)) daysMap.set(k, { date: k, count: 0, orphans: 0 });
    const c = Math.round(exe.values[i] ?? 0);
    if (c <= 0) return;
    const nodes = nodesNear(t);
    if (nodes != null && nodes < 2) { excluded++; return; }   // single-node local jitter
    const o = Math.round(dropAt.get(t) ?? 0);
    const d = daysMap.get(k);
    d.count += c; d.orphans += o;
    events.push({ t, count: c, orphans: o, nodes });
  });

  const daily = [...daysMap.values()];
  const total = daily.reduce((s, d) => s + d.count, 0);
  const orphans = daily.reduce((s, d) => s + d.orphans, 0);
  const withReorg = daily.filter((d) => d.count > 0).length;
  const peak = daily.reduce((m, d) => (d.count > m.count ? d : m), { count: 0, date: null });
  return {
    days: daily,
    events: events.slice(-10).reverse(),
    summary: {
      spanDays: daily.length, total, orphans, excluded,
      avgPerDay: +(total / Math.max(daily.length, 1)).toFixed(2),
      daysWithReorg: withReorg,
      avgDepth: total ? +(orphans / total).toFixed(2) : 0,
      peakDay: peak.count ? peak : null,
    },
  };
}

// ── Disk usage alerts (instant) ─────────────────────────────────────────────
const DISK_EXCLUDE = "(dex_prod_s1_k8s_kops_control_ec2_1)|(.*).internal";

export async function fetchDiskAlerts(configPath, threshold = 80) {
  const alerts = [];
  for (const [dsName, dsUid] of Object.entries(DATASOURCES)) {
    const raw = await grafanaQuery(
      dsUid,
      `avg_over_time(topk(100,(1-(node_filesystem_free_bytes{fstype=~"ext4|xfs",instance_full_name!~"${DISK_EXCLUDE}"}/node_filesystem_size_bytes{fstype=~"ext4|xfs",instance_full_name!~"${DISK_EXCLUDE}"}))*100)[5m:])`,
      { configPath }
    );
    const series = extractSeries(raw);
    for (const s of series) {
      const val = s.values[s.values.length - 1] ?? 0;
      if (val >= threshold) {
        alerts.push({
          datasource:   dsName,
          instance:     s.labels.instance,
          instanceName: s.labels.instance_full_name || s.labels.instance_name || "",
          job:          s.labels.job,
          mountpoint:   s.labels.mountpoint || "/",
          usedPct:      Math.round(val * 100) / 100,   // frontend reads usedPct
          isValidator:  /validator/i.test(s.labels.job || s.labels.instance_full_name || ""),
        });
      }
    }
  }
  return alerts.sort((a, b) => b.usedPct - a.usedPct);
}
