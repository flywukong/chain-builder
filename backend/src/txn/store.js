/**
 * TxnStore — 7-day rolling hourly buckets of classified tx samples.
 * bucket: { t(hour-start ms), blocks, txs, cats: {cat:{n,gas}}, contracts: {addr:{n,gas}} }
 * Persisted as JSON; contracts trimmed to top 80 per bucket on save.
 */

import fs from "fs";
import path from "path";
import { CATS } from "./classifier.js";

const WINDOW_MS = 7 * 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

export class TxnStore {
  constructor(file) {
    this.file = file;
    this.buckets = [];
    // 历史累计(不滚动,重启续算):since + blocks/txs + 分类 n/gas
    this.allTime = { since: Date.now(), blocks: 0, txs: 0, cats: {} };
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

  addBlock(now, classified) {
    const b = this._bucket(now);
    b.blocks++;
    this.allTime.blocks++;
    for (const c of classified) {
      b.txs++;
      const cat = (b.cats[c.cat] ??= { n: 0, gas: 0 });
      cat.n++; cat.gas += c.gas;
      this.allTime.txs++;
      const ac = (this.allTime.cats[c.cat] ??= { n: 0, gas: 0 });
      ac.n++; ac.gas += c.gas;
      if (c.to && ["other", "meme", "defi", "bot", "predict", "token", "infra"].includes(c.cat)) {
        const ct = (b.contracts[c.to] ??= { n: 0, gas: 0, cat: c.cat, sels: {}, swap: 0, xfer: 0 });
        ct.n++; ct.gas += c.gas;
        // 特征供 AI 归类:top selector / Swap / Transfer 事件计数
        if (c.sel && c.sel !== "0x") { ct.sels ??= {}; ct.sels[c.sel] = (ct.sels[c.sel] || 0) + 1; }
        ct.swap = (ct.swap || 0) + (c.swap || 0);
        ct.xfer = (ct.xfer || 0) + (c.xfer || 0);
      }
    }
    this._save();
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
      }));
      fs.writeFileSync(this.file, JSON.stringify({ buckets: slim, allTime: this.allTime }));
    } catch { /* non-fatal */ }
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

  // windowDays:分类分布统计窗口(1/3/7 天);趋势图与热门合约固定 24h
  view(labelBook, windowDays = 1) {
    const now = Date.now();
    const winMs = Math.min(Math.max(Number(windowDays) || 1, 1), 7) * 24 * HOUR;
    // 7d daily rollup
    const days = {};
    for (const b of this.buckets) {
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
    const agg = {};
    for (const b of this.buckets) {
      if (b.t < now - 24 * HOUR) continue;
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
      topContracts,
      learnedLabels: labelBook.learnedCount(),
    };
  }
}
