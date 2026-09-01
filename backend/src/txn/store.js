/**
 * TxnStore — 30-day rolling hourly buckets of classified tx samples.
 * bucket: { t(hour-start ms), blocks, txs, cats: {cat:{n,gas}}, contracts: {addr:{n,gas}} }
 * Persisted as JSON; contracts trimmed to top 80 per bucket on save.
 */

import fs from "fs";
import path from "path";
import { CATS, CLASSIFIER_V2_VER } from "./classifier.js";

const WINDOW_MS = 30 * 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

export class TxnStore {
  constructor(file) {
    this.file = file;
    this.buckets = [];
    // 历史累计(不滚动,重启续算):since + blocks/txs + 分类 n/gas
    this.allTime = { since: Date.now(), blocks: 0, txs: 0, cats: {} };
    // v2 多维累计:自 v2 分类器上线时刻分段起算(不与 v1 历史混口径)
    this.allTime2 = { since: Date.now(), txs: 0, acts: {} };
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Array.isArray(raw)) {
          // 旧格式(纯桶数组):迁移 —— 用现有 7d 数据预填累计
          this.buckets = raw;
          this.allTime.since = raw[0]?.t ?? Date.now();
          for (const b of raw) {
            this.allTime.blocks += b.blocks; this.allTime.txs += b.txs;
            for (const [c, v] of Object.entries(b.cats ?? {})) {
              const a = (this.allTime.cats[c] ??= { n: 0, gas: 0 });
              a.n += v.n; a.gas += v.gas || 0;
            }
          }
        } else if (raw) {
          this.buckets = raw.buckets ?? [];
          this.allTime = raw.allTime ?? this.allTime;
          if (raw.allTime2) this.allTime2 = raw.allTime2;
        }
      }
    } catch { this.buckets = []; }
  }

  _bucket(now) {
    const t = Math.floor(now / HOUR) * HOUR;
    let b = this.buckets.at(-1);
    if (b?.t === t) return b;
    b = this.buckets.find((x) => x.t === t);   // 并发抓块乱序到达/跨小时边界
    if (!b) {
      b = { t, blocks: 0, txs: 0, cats: {}, contracts: {} };
      this.buckets.push(b);
      this.buckets.sort((x, y) => x.t - y.t);
      const cutoff = now - WINDOW_MS;
      if (this.buckets[0]?.t < cutoff) this.buckets = this.buckets.filter((x) => x.t >= cutoff);
    }
    return b;
  }

  addBlock(now, classified, blockGp = null, blockGp90 = null, blockNum = null) {
    const b = this._bucket(now);
    if (Number.isFinite(blockNum)) {
      // 持久化紧凑区块区间，使 sampler 状态文件落后/崩溃重启时重抓也不会重复计数。
      const ranges = (b.blockRanges ??= []);
      if (ranges.some(([lo, hi]) => blockNum >= lo && blockNum <= hi)) return false;
      ranges.push([blockNum, blockNum]);
      ranges.sort((x, y) => x[0] - y[0]);
      const merged = [];
      for (const [lo, hi] of ranges) {
        const last = merged.at(-1);
        if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
        else merged.push([lo, hi]);
      }
      b.blockRanges = merged;
      b.minBlock = b.minBlock == null ? blockNum : Math.min(b.minBlock, blockNum);
      b.maxBlock = b.maxBlock == null ? blockNum : Math.max(b.maxBlock, blockNum);
    }
    b.blocks++;
    // 即使空块也属于当前分类器版本的连续采集区间。
    if (b.v2v != null && b.v2v !== CLASSIFIER_V2_VER) b.v2mixed = true;
    else b.v2v = CLASSIFIER_V2_VER;
    b.acts ??= {};
    // 块级 gas price 分位(gwei)蓄水池抽样:gp=块中位(常规价),gp90=块 p90(高价单水位)
    if (typeof blockGp === "number") {
      (b.gp ??= []);
      if (b.gp.length < 300) b.gp.push(blockGp);
      else b.gp[Math.floor(Math.random() * 300)] = blockGp;
    }
    if (typeof blockGp90 === "number") {
      (b.gp90 ??= []);
      if (b.gp90.length < 300) b.gp90.push(blockGp90);
      else b.gp90[Math.floor(Math.random() * 300)] = blockGp90;
    }
    this.allTime.blocks++;
    for (const c of classified) {
      b.txs++;
      const cat = (b.cats[c.cat] ??= { n: 0, gas: 0 });
      cat.n++; cat.gas += Number.isFinite(c.gas) ? c.gas : 0;
      this.allTime.txs++;
      const ac = (this.allTime.cats[c.cat] ??= { n: 0, gas: 0 });
      ac.n++; ac.gas += Number.isFinite(c.gas) ? c.gas : 0;
      // v2 多维双写:activity 互斥挂 gas;parts/assets/flows 叠加只计笔数;质量位
      if (c.act) {
        const ae = (b.acts[c.act] ??= { n: 0, gas: 0 });
        ae.n++; ae.gas += Number.isFinite(c.gas) ? c.gas : 0;
        this.allTime2.txs++;
        const a2 = (this.allTime2.acts[c.act] ??= { n: 0, gas: 0 });
        a2.n++; a2.gas += Number.isFinite(c.gas) ? c.gas : 0;
        for (const p of c.parts ?? []) (b.parts ??= {})[p] = (b.parts[p] || 0) + 1;
        for (const s of c.assets ?? []) (b.assets ??= {})[s] = (b.assets[s] || 0) + 1;
        for (const f of c.flows ?? []) (b.flows ??= {})[f] = (b.flows[f] || 0) + 1;
        if (c.fail || c.rcptMiss) {
          const q = (b.qual ??= { failed: 0, rcptMiss: 0 });
          if (c.fail) q.failed++;
          if (c.rcptMiss) q.rcptMiss++;
        }
      }
      if (c.to && ["other", "meme", "defi", "bot", "predict", "token", "infra"].includes(c.cat)) {
        const ct = (b.contracts[c.to] ??= { n: 0, gas: 0, cat: c.cat, sels: {}, swap: 0, xfer: 0 });
        ct.n++; ct.gas += Number.isFinite(c.gas) ? c.gas : 0;
        // 特征供 AI 归类:top selector / Swap / Transfer 事件计数
        if (c.sel && c.sel !== "0x") { ct.sels ??= {}; ct.sels[c.sel] = (ct.sels[c.sel] || 0) + 1; }
        ct.swap = (ct.swap || 0) + (c.swap || 0);
        ct.xfer = (ct.xfer || 0) + (c.xfer || 0);
      }
    }
    this._save();
    return true;
  }

  // 全量抓块下每分钟 addBlock ~133 次,写盘节流为 3s 内最多一次;flush() 立即落盘
  _save() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.flush(); }, 3000);
  }

  flush() {
    if (!this._dirty) return;
    this._dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const slim = this.buckets.map((b) => ({
        ...b,
        contracts: Object.fromEntries(
          Object.entries(b.contracts).sort((a, x) => x[1].n - a[1].n).slice(0, 80)
        ),
        ...(b.gp?.length > 120 ? { gp: b.gp.slice(-120) } : {}),
        ...(b.gp90?.length > 120 ? { gp90: b.gp90.slice(-120) } : {}),
      }));
      fs.writeFileSync(this.file, JSON.stringify({ buckets: slim, allTime: this.allTime, allTime2: this.allTime2 }));
    } catch { /* non-fatal */ }
  }

  // 是否存在旧版本 v2 数据(分类器/verified 表升级后重启,journal 覆盖窗口内待重放)
  needsReplay() {
    return this.buckets.some((b) => b.acts && (b.v2v ?? 0) !== CLASSIFIER_V2_VER);
  }

  // 从 FactJournal 重放,重算窗口内各小时桶的 v2 维度并差量修正 allTime2。
  // v1(cats/txs/contracts)不重放;journal 覆盖不完整的小时(<98% 笔数)与当前小时跳过。
  async replayV2(journal, labelBook, classifyFn) {
    const cov = journal.coverage();
    if (!cov) return { replaced: 0, skipped: 0, facts: 0 };
    const agg = new Map();
    const facts = await journal.replay(cov.fromMs, cov.toMs, (f) => {
      const v2 = classifyFn(f, labelBook);
      const hk = Math.floor(f.t / HOUR);
      let a = agg.get(hk);
      if (!a) agg.set(hk, (a = { txs: 0, acts: {}, parts: {}, assets: {}, flows: {}, qual: { failed: 0, rcptMiss: 0 } }));
      a.txs++;
      const e = (a.acts[v2.act] ??= { n: 0, gas: 0 });
      e.n++; e.gas += f.rc && Number.isFinite(f.g) ? f.g : 0;
      for (const p of v2.parts) a.parts[p] = (a.parts[p] || 0) + 1;
      for (const s of v2.assets) a.assets[s] = (a.assets[s] || 0) + 1;
      for (const fl of v2.flows) a.flows[fl] = (a.flows[fl] || 0) + 1;
      if (v2.fail) a.qual.failed++;
      if (v2.rcptMiss) a.qual.rcptMiss++;
    });
    let replaced = 0, skipped = 0;
    for (const [hk, a] of agg) {
      const b = this.buckets.find((x) => x.t === hk * HOUR);
      if (!b) { skipped++; continue; }
      if (a.txs < b.txs * 0.98) { skipped++; continue; }
      const keys = new Set([...Object.keys(b.acts ?? {}), ...Object.keys(a.acts)]);
      for (const k of keys) {
        const oldE = b.acts?.[k], newE = a.acts[k];
        const at = (this.allTime2.acts[k] ??= { n: 0, gas: 0 });
        at.n += (newE?.n || 0) - (oldE?.n || 0);
        at.gas += (newE?.gas || 0) - (oldE?.gas || 0);
        this.allTime2.txs += (newE?.n || 0) - (oldE?.n || 0);
      }
      b.acts = a.acts; b.parts = a.parts; b.assets = a.assets; b.flows = a.flows; b.qual = a.qual;
      b.v2v = CLASSIFIER_V2_VER; delete b.v2mixed;
      replaced++;
    }
    if (replaced) { this._dirty = true; this.flush(); }
    return { replaced, skipped, facts };
  }

  // Hot "other" contracts over recent hours — AI labeling candidates.
  // learned cat="other" 不排除:带着新特征让 AI 重新评估。
  unknownHot(labelBook, hours = 24, top = 30) {
    const cutoff = Date.now() - hours * HOUR;
    const agg = {};
    for (const b of this.buckets) {
      if (b.t < cutoff) continue;
      for (const [addr, c] of Object.entries(b.contracts)) {
        const l = labelBook.get(addr);
        if (c.cat !== "other" || (l && l.cat !== "other")) continue;
        const a = (agg[addr] ??= { addr, n: 0, gas: 0, sels: {}, swap: 0, xfer: 0 });
        a.n += c.n; a.gas += c.gas;
        a.swap += c.swap || 0; a.xfer += c.xfer || 0;
        for (const [s, k] of Object.entries(c.sels ?? {})) a.sels[s] = (a.sels[s] || 0) + k;
      }
    }
    return Object.values(agg).sort((a, b) => b.n - a.n).slice(0, top)
      .map((a) => ({
        addr: a.addr, n: a.n, gas: a.gas, swapLogs: a.swap, transferLogs: a.xfer,
        topSelectors: Object.entries(a.sels).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([s, k]) => `${s}×${k}`),
      }));
  }

  // Top gas 消耗合约(流量子系统):窗口内按 gasUsed 聚合排名,share 以窗口总 gas 为分母。
  // gas 为 receipts 的真实 gasUsed;桶 7d 滚动,数据自部署起积累。
  topGasContracts(labelBook, days = 1, top = 12) {
    const cutoff = Date.now() - Math.min(Math.max(Number(days) || 1, 1), 7) * 24 * HOUR;
    const agg = {}; let totalGas = 0;
    for (const b of this.buckets) {
      if (b.t < cutoff) continue;
      for (const c of Object.values(b.cats ?? {})) totalGas += c.gas || 0;
      for (const [addr, c] of Object.entries(b.contracts ?? {})) {
        const a = (agg[addr] ??= { addr, n: 0, gas: 0, cat: c.cat });
        a.n += c.n; a.gas += c.gas || 0;
        if (c.cat && c.cat !== "other") a.cat = c.cat;
      }
    }
    const rows = Object.values(agg).sort((a, b) => b.gas - a.gas).slice(0, top).map((a) => {
      const l = labelBook?.get?.(a.addr);
      return {
        addr: a.addr,
        name: l?.name ?? null,
        cat: l?.cat ?? a.cat ?? "other",
        txs: a.n,
        gas: a.gas,
        sharePct: totalGas ? +((a.gas / totalGas) * 100).toFixed(1) : null,
      };
    });
    return { days: Math.min(Math.max(Number(days) || 1, 1), 7), totalGas, rows };
  }

  // 指定时间范围内的合约 gas 聚合(大流量事件归因):范围覆盖的小时桶合并,top N
  contractsInRange(labelBook, fromMs, toMs, top = 6) {
    const agg = {}; let totalGas = 0, buckets = 0;
    for (const b of this.buckets) {
      if (b.t < fromMs - HOUR || b.t >= toMs) continue;   // 事件起点所在小时也算入
      buckets++;
      for (const c of Object.values(b.cats ?? {})) totalGas += c.gas || 0;
      for (const [addr, c] of Object.entries(b.contracts ?? {})) {
        const a = (agg[addr] ??= { addr, n: 0, gas: 0, cat: c.cat });
        a.n += c.n; a.gas += c.gas || 0;
        if (c.cat && c.cat !== "other") a.cat = c.cat;
      }
    }
    if (!buckets) return null;   // 范围超出 7d 桶窗口
    const rows = Object.values(agg).sort((a, b) => b.gas - a.gas).slice(0, top).map((a) => {
      const l = labelBook?.get?.(a.addr);
      return { addr: a.addr, name: l?.name ?? null, cat: l?.cat ?? a.cat ?? "other", txs: a.n, sharePct: totalGas ? +((a.gas / totalGas) * 100).toFixed(1) : null };
    });
    return { rows, source: "store" };
  }

  // Gas price 水位线:实线 p50 = 块中位价的小时中位(常规价,天然平稳);
  // 虚线 p90 = 块内 p90 高价单的小时 p90(MEV 抢跑/拥堵时先动的信号)
  gasPriceTrend(days = 1) {
    const cutoff = Date.now() - Math.min(Math.max(Number(days) || 1, 1), 7) * 24 * HOUR;
    const times = [], p50 = [], p90 = [];
    for (const b of this.buckets) {
      if (b.t < cutoff || !b.gp?.length) continue;
      const s = [...b.gp].sort((x, y) => x - y);
      times.push(b.t);
      p50.push(+s[Math.floor(s.length * 0.5)].toFixed(3));
      if (b.gp90?.length) {
        const s9 = [...b.gp90].sort((x, y) => x - y);
        p90.push(+s9[Math.min(Math.floor(s9.length * 0.9), s9.length - 1)].toFixed(3));
      } else {
        p90.push(+s[Math.min(Math.floor(s.length * 0.9), s.length - 1)].toFixed(3));
      }
    }
    return { times, p50, p90 };
  }

  // 交易类型 gas 份额趋势:每小时各类 gas 占比 %(分母为该小时总 gas)
  catTrend(days = 1) {
    const cutoff = Date.now() - Math.min(Math.max(Number(days) || 1, 1), 7) * 24 * HOUR;
    const rows = this.buckets.filter((b) => b.t >= cutoff && b.txs > 0);
    // 按窗口内 gas 总量选 top 5 类,其余合并为 other
    const totals = {};
    for (const b of rows) for (const [c, v] of Object.entries(b.cats ?? {})) totals[c] = (totals[c] || 0) + (v.gas || 0);
    const topCats = Object.entries(totals).sort((a, x) => x[1] - a[1]).slice(0, 5).map(([c]) => c);
    const times = [], series = Object.fromEntries([...topCats, "rest"].map((c) => [c, []]));
    for (const b of rows) {
      const total = Object.values(b.cats ?? {}).reduce((s, v) => s + (v.gas || 0), 0) || 1;
      times.push(b.t);
      let covered = 0;
      for (const c of topCats) {
        const pct = +(((b.cats?.[c]?.gas || 0) / total) * 100).toFixed(1);
        series[c].push(pct); covered += pct;
      }
      series.rest.push(+Math.max(0, 100 - covered).toFixed(1));
    }
    return { times, cats: topCats, series };
  }

  // windowDays:分类分布统计窗口(1/3/7 天);趋势图与热门合约固定 24h
  view(labelBook, windowDays = 1, hotDays = 1) {
    const now = Date.now();
    const winMs = Math.min(Math.max(Number(windowDays) || 1, 1), 30) * 24 * HOUR;
    // 7d daily rollup(维持 7 天口径:图表与环比语义不随 30d 存储窗口改变)
    const days = {};
    for (const b of this.buckets.filter((x) => x.t >= now - 7 * 24 * HOUR)) {
      const d = new Date(b.t);
      const key = `${d.getMonth() + 1}/${d.getDate()}`;
      const day = (days[key] ??= { day: key, t: b.t, blocks: 0, txs: 0, cats: {} });
      day.blocks += b.blocks; day.txs += b.txs;
      for (const [cat, v] of Object.entries(b.cats)) {
        const c = (day.cats[cat] ??= { n: 0, gas: 0 });
        c.n += v.n; c.gas += v.gas;
      }
    }
    // 24h hourly series (tx counts per cat)
    const h24 = this.buckets.filter((b) => b.t >= now - 24 * HOUR)
      .map((b) => ({ t: b.t, txs: b.txs, cats: Object.fromEntries(CATS.map((c) => [c, b.cats[c]?.n ?? 0])) }));
    // today's top contracts (24h) — 带证据字段(swap/transfer/topSel)供前端生成"依据"
    const hotMs = Math.min(Math.max(Number(hotDays) || 1, 1), 30) * 24 * HOUR;
    const agg = {};
    for (const b of this.buckets) {
      if (b.t < now - hotMs) continue;
      for (const [addr, c] of Object.entries(b.contracts)) {
        const a = (agg[addr] ??= { addr, n: 0, gas: 0, cat: c.cat, swap: 0, xfer: 0, sels: {} });
        a.n += c.n; a.gas += c.gas; a.swap += c.swap || 0; a.xfer += c.xfer || 0;
        for (const [s, k] of Object.entries(c.sels ?? {})) a.sels[s] = (a.sels[s] || 0) + k;
      }
    }
    const topContracts = Object.values(agg).sort((a, b) => b.n - a.n).slice(0, 15)
      .map((c) => {
        const l = labelBook.get(c.addr);
        const topSel = Object.entries(c.sels).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
        return { addr: c.addr, n: c.n, gas: c.gas, swap: c.swap, xfer: c.xfer, topSel, name: l?.name ?? null, cat: l?.cat ?? c.cat, ai: l?.ai ?? false };
      });
    // 分布统计按所选窗口聚合(字段名沿用 *24,窗口见 windowDays)
    const bWin = this.buckets.filter((b) => b.t >= now - winMs);
    const total24 = bWin.reduce((s, b) => s + b.txs, 0);
    const catTotals = {};
    const catGas = {}; let gasTotal = 0;
    for (const b of bWin) {
      for (const [c, v] of Object.entries(b.cats)) {
        catTotals[c] = (catTotals[c] ?? 0) + (v.n || 0);
        catGas[c] = (catGas[c] ?? 0) + (v.gas || 0); gasTotal += (v.gas || 0);
      }
    }
    // v2 多维窗口聚合(旧桶无这些字段,自 v2 上线的桶起有值)
    // 当前分类器版本的连续尾段。存在小时缺口时，缺口之前的数据不能冒充“最近 N 天”。
    const currentV2 = this.buckets
      .filter((b) => b.acts && b.v2v === CLASSIFIER_V2_VER && !b.v2mixed)
      .sort((a, b) => a.t - b.t);
    let continuousSince = null, latestV2 = currentV2.at(-1)?.t ?? null;
    if (latestV2 != null) {
      continuousSince = latestV2;
      for (let i = currentV2.length - 2; i >= 0; i--) {
        if (currentV2[i + 1].t - currentV2[i].t !== HOUR) break;
        continuousSince = currentV2[i].t;
      }
    }
    const continuousHours = continuousSince == null ? 0 : Math.max(0, (latestV2 + HOUR - continuousSince) / HOUR);
    const requestedHours = winMs / HOUR;
    const dimBuckets = currentV2.filter((b) => b.t >= now - winMs && b.t >= continuousSince);
    const dim = {
      acts: {}, parts: {}, assets: {}, flows: {}, qual: { failed: 0, rcptMiss: 0 },
      total: 0, since: null,
      meta: {
        requestedDays: winMs / (24 * HOUR), requestedHours,
        availableContinuousHours: continuousHours,
        effectiveHours: Math.min(requestedHours, continuousHours),
        latestBucketAt: latestV2,
        blocks: 0, trackedBlocks: 0, minBlock: null, maxBlock: null,
        classifierVersions: [], excludedStaleBuckets: 0, excludedGapBuckets: 0, excludedVersions: [],
      },
      denominators: {},
    };
    const dimVers = new Set(), staleVers = new Set();
    for (const b of bWin) {
      if (!b.acts) continue;
      if (b.v2v !== CLASSIFIER_V2_VER || b.v2mixed) {
        dim.meta.excludedStaleBuckets++;
        if (b.v2v != null && b.v2v !== CLASSIFIER_V2_VER) staleVers.add(b.v2v);
      } else if (b.t < continuousSince) dim.meta.excludedGapBuckets++;
    }
    for (const b of dimBuckets) {
      dim.since ??= b.t;
      dim.meta.blocks += b.blocks || 0;
      if (b.minBlock != null && b.maxBlock != null) {
        dim.meta.trackedBlocks += b.blocks || 0;
        dim.meta.minBlock = dim.meta.minBlock == null ? b.minBlock : Math.min(dim.meta.minBlock, b.minBlock);
        dim.meta.maxBlock = dim.meta.maxBlock == null ? b.maxBlock : Math.max(dim.meta.maxBlock, b.maxBlock);
      }
      if (b.v2v != null) dimVers.add(b.v2v);
      for (const [k, v] of Object.entries(b.acts)) {
        const e = (dim.acts[k] ??= { n: 0, gas: 0 });
        e.n += v.n || 0; e.gas += v.gas || 0; dim.total += v.n || 0;
      }
      for (const [k, v] of Object.entries(b.parts ?? {})) dim.parts[k] = (dim.parts[k] || 0) + v;
      for (const [k, v] of Object.entries(b.assets ?? {})) dim.assets[k] = (dim.assets[k] || 0) + v;
      for (const [k, v] of Object.entries(b.flows ?? {})) dim.flows[k] = (dim.flows[k] || 0) + v;
      if (b.qual) { dim.qual.failed += b.qual.failed || 0; dim.qual.rcptMiss += b.qual.rcptMiss || 0; }
    }
    const sysN = dim.acts.system?.n || 0;
    dim.denominators = {
      allTx: dim.total,
      businessTx: Math.max(0, dim.total - sysN),
      knownGasTx: Math.max(0, dim.total - dim.qual.rcptMiss),
      receiptKnownTx: Math.max(0, dim.total - dim.qual.rcptMiss),
    };
    dim.meta.classifierVersions = [...dimVers].sort((a, b) => a - b);
    dim.meta.excludedVersions = [...staleVers].sort((a, b) => a - b);
    dim.meta.freshnessHours = latestV2 == null ? null : Math.max(0, (now - (latestV2 + HOUR)) / HOUR);
    dim.meta.windowCoveragePct = requestedHours
      ? +Math.min(100, (100 * continuousHours) / requestedHours).toFixed(2)
      : 0;
    if (dim.meta.minBlock != null && dim.meta.maxBlock != null) {
      dim.meta.expectedBlocks = dim.meta.maxBlock - dim.meta.minBlock + 1;
      dim.meta.gapBlocks = Math.max(0, dim.meta.expectedBlocks - dim.meta.trackedBlocks);
      dim.meta.coveragePct = dim.meta.expectedBlocks
        ? +Math.min(100, (100 * dim.meta.trackedBlocks) / dim.meta.expectedBlocks).toFixed(2)
        : null;
    } else {
      dim.meta.expectedBlocks = null;
      dim.meta.gapBlocks = null;
      dim.meta.coveragePct = null;
    }
    dim.meta.windowReady = continuousHours >= requestedHours
      && (dim.meta.freshnessHours ?? Infinity) < 1
      && (dim.meta.coveragePct == null || dim.meta.coveragePct >= 99.9);

    // 选择窗口与前一个等长窗口比较,避免“30d 占比”旁边展示“今日 vs 7d”。
    const prevTotals = {}, prevBuckets = this.buckets.filter((b) => b.t >= now - 2 * winMs && b.t < now - winMs);
    let prevTxs = 0;
    for (const b of prevBuckets) {
      prevTxs += b.txs || 0;
      for (const [c, v] of Object.entries(b.cats ?? {})) prevTotals[c] = (prevTotals[c] || 0) + (v.n || 0);
    }
    const catWindowDelta = Object.fromEntries(CATS.map((c) => {
      if (!total24 || !prevTxs) return [c, null];
      const cur = 100 * (catTotals[c] || 0) / total24;
      const prev = 100 * (prevTotals[c] || 0) / prevTxs;
      return [c, +(cur - prev).toFixed(1)];
    }));

    // 环比:各类 tx 占比 today vs 昨日 vs 7d 日均(排除今日 partial 日)
    const dsort = Object.values(days).sort((a, b) => a.t - b.t);
    const share = (day, c) => (day.txs ? ((day.cats[c]?.n ?? 0) / day.txs) * 100 : 0);
    const today = dsort.at(-1), yest = dsort.length >= 2 ? dsort.at(-2) : null;
    const prior = dsort.slice(0, -1);
    const catTrend = {};
    for (const c of CATS) {
      const tP = today ? share(today, c) : null;
      const yP = yest ? share(yest, c) : null;
      const aP = prior.length ? prior.reduce((s, d) => s + share(d, c), 0) / prior.length : null;
      catTrend[c] = {
        dYest: tP != null && yP != null ? +(tP - yP).toFixed(1) : null,
        dAvg7: tP != null && aP != null ? +(tP - aP).toFixed(1) : null,
      };
    }
    // 历史累计视图(自 since,持久化,重启续算)
    const atGasTotal = Object.values(this.allTime.cats).reduce((s, v) => s + (v.gas || 0), 0);
    const allTime = {
      since: this.allTime.since,
      total: this.allTime.txs,
      blocks: this.allTime.blocks,
      catCount: Object.fromEntries(CATS.map((c) => [c, this.allTime.cats[c]?.n ?? 0])),
      catPct: Object.fromEntries(CATS.map((c) => [c, this.allTime.txs ? +((100 * (this.allTime.cats[c]?.n ?? 0)) / this.allTime.txs).toFixed(1) : 0])),
      catGasPct: Object.fromEntries(CATS.map((c) => [c, atGasTotal ? +((100 * (this.allTime.cats[c]?.gas ?? 0)) / atGasTotal).toFixed(1) : 0])),
    };
    return {
      sampledSince: this.buckets[0]?.t ?? null,
      windowDays: winMs / (24 * HOUR),
      allTime,
      daily: Object.values(days),
      hourly24: h24,
      total24,
      catPct24: Object.fromEntries(CATS.map((c) => [c, total24 ? +((100 * (catTotals[c] ?? 0)) / total24).toFixed(1) : 0])),
      catCount24: Object.fromEntries(CATS.map((c) => [c, catTotals[c] ?? 0])),
      catGasPct24: Object.fromEntries(CATS.map((c) => [c, gasTotal ? +((100 * (catGas[c] ?? 0)) / gasTotal).toFixed(1) : 0])),
      catTrend,
      catWindowDelta,
      topContracts,
      learnedLabels: labelBook.learnedCount(),
      dim,
      allTime2: { since: this.allTime2.since, txs: this.allTime2.txs, acts: this.allTime2.acts },
    };
  }
}
