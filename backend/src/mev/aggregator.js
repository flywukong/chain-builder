/**
 * MevAggregator — rolls up the streamer's per-block MEV detection into MEV stats.
 *
 * Two horizons:
 *  - rolling 2000-block window: recent list / top miners (realtime texture)
 *  - persisted day stats: 24h hourly buckets (MEV%, v1/v2/local), all-time
 *    builder totals, and per-validator last-block version (24h validity) —
 *    survives restarts via a throttled JSON file.
 */

import fs from "fs";
import path from "path";
import { EventEmitter } from "events";

// brand aliases: Puissant is 48Club's builder — display under the operator name
const FAMILY_ALIAS = { puissant: "48club" };

const family = (name) => {
  const f = (name || "").trim().split(/\s+/)[0].toLowerCase();
  if (f.startsWith("unknown")) return "unknown";
  return FAMILY_ALIAS[f] ?? f;
};

const HOUR = 3600e3;

export class MevAggregator extends EventEmitter {
  constructor({ windowSize = 2000, file = null } = {}) {
    super();
    this.windowSize = windowSize;
    this.window = [];
    this.file = file;
    // day.buckets: { hourKey: {total, mev, v2} } · builderTotals: 累计 · minerVers: {miner: {ver, t}}
    this.day = { since: Date.now(), buckets: {}, builderTotals: {}, minerVers: {} };
    if (file) {
      try { if (fs.existsSync(file)) this.day = { ...this.day, ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch {}
    }
    this._dirty = 0;
    this._lastSave = 0;
  }

  // Fed from streamer "block" events.
  add(block) {
    if (block == null || typeof block.number !== "number") return;
    const type = block.mev?.source === "bidblock" ? "mev_v2" : block.isMev ? "mev_v1" : "local";
    const fam = family(block.builder);
    this.window.push({
      number: block.number,
      type,
      miner: block.miner,                 // address; frontend resolves to moniker
      builderName: block.builder || null, // e.g. "puissant us"
      family: fam,
      version: block.version || null,     // 从 extraData 解析的 validator 二进制版本
    });
    if (this.window.length > this.windowSize) this.window.shift();

    // ── day stats(持久化口径)──
    const now = Date.now();
    const hk = Math.floor(now / HOUR);
    const b = (this.day.buckets[hk] ??= { total: 0, mev: 0, v2: 0 });
    b.total++;
    if (type !== "local") {
      b.mev++;
      // 桶级 per-family / per-instance 计数:供集中度(Top1/HHI)与 instance 拆分做 24h 环比
      (b.fams ??= {})[fam] = (b.fams[fam] || 0) + 1;
      const inst = (block.builder || "").trim().toLowerCase();
      if (inst) (b.insts ??= {})[inst] = (b.insts[inst] || 0) + 1;
    }
    if (type === "mev_v2") b.v2++;
    // builder 历史累计:捕获到的所有块,local(非 MEV)也计为一类
    const famKey = type === "local" ? "local" : fam;
    this.day.builderTotals[famKey] = (this.day.builderTotals[famKey] || 0) + 1;
    // validator 版本:记最近一次出块所用版本;旧版本一直保留,直到该 validator 用新版本出块覆盖
    if (block.miner && block.version && block.version !== "unknown") {
      this.day.minerVers[block.miner] = { ver: block.version, t: now };
    }
    // prune:桶留 25h,版本记录留 24h
    const cutHk = Math.floor((now - 25 * HOUR) / HOUR);
    for (const k of Object.keys(this.day.buckets)) if (+k < cutHk) delete this.day.buckets[k];
    const cutV = now - 24 * HOUR;
    for (const [m, v] of Object.entries(this.day.minerVers)) if (v.t < cutV) delete this.day.minerVers[m];

    // throttled persist:每 100 块或 30s
    this._dirty++;
    if (this.file && (this._dirty >= 100 || now - this._lastSave > 30_000)) {
      this._dirty = 0;
      this._lastSave = now;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.day));
      } catch {}
    }
  }

  getStats() {
    const w = this.window;
    if (!w.length) return null;
    const typeCounts = {}, famCounts = {}, minerCounts = {};
    for (const b of w) {
      typeCounts[b.type] = (typeCounts[b.type] || 0) + 1;
      if (b.type !== "local") famCounts[b.family] = (famCounts[b.family] || 0) + 1;
      if (b.miner) minerCounts[b.miner] = (minerCounts[b.miner] || 0) + 1;
    }
    // floor to 1 decimal: 1993/2000 must read 99.6%, not round up to a false 100%
    const pct1 = (a, b) => (b ? Math.floor((a / b) * 1000) / 10 : 0);

    // ── 24h 汇总(小时桶)+ 上一 24h 窗口(环比用)──
    const now = Date.now();
    const hkCut = Math.floor((now - 24 * HOUR) / HOUR);
    const hkPrevCut = Math.floor((now - 48 * HOUR) / HOUR);
    let dTotal = 0, dMev = 0, dV2 = 0, prevMev = 0;
    const famsNow = {}, famsPrev = {}, instsNow = {}, instsPrev = {};
    const merge = (dst, src) => { for (const [k, n] of Object.entries(src || {})) dst[k] = (dst[k] || 0) + n; };
    for (const [hk, b] of Object.entries(this.day.buckets)) {
      if (+hk >= hkCut) {
        dTotal += b.total; dMev += b.mev; dV2 += b.v2;
        merge(famsNow, b.fams); merge(instsNow, b.insts);
      } else if (+hk >= hkPrevCut) {
        prevMev += b.mev;
        merge(famsPrev, b.fams); merge(instsPrev, b.insts);
      }
    }
    const day24 = {
      total: dTotal,
      mevPct: pct1(dMev, dTotal),
      v2Pct: pct1(dV2, dMev),
      v1Count: dMev - dV2,
      v2Count: dV2,
      localCount: dTotal - dMev,
    };

    // ── Builder 集中度(24h,分母 = MEV 块;环比 = 上一 24h 窗口)──
    const famsSorted = Object.entries(famsNow).sort((a, b) => b[1] - a[1]);
    const shareOf = ([name, n]) => ({
      name, n,
      pct: pct1(n, dMev),
      prevPct: prevMev ? pct1(famsPrev[name] || 0, prevMev) : null,
    });
    let hhi = 0;
    for (const [, n] of famsSorted) { const s = dMev ? (n / dMev) * 100 : 0; hhi += s * s; }
    const concentration = {
      top1: famsSorted[0] ? shareOf(famsSorted[0]) : null,
      top2: famsSorted[1] ? shareOf(famsSorted[1]) : null,
      hhi: Math.round(hhi),
      hasPrev: prevMev > 0,
    };

    // ── Builder instance 拆分(24h,family 内按实例)──
    const instances = Object.entries(instsNow)
      .map(([name, n]) => ({
        name, family: family(name), n,
        pct: pct1(n, dMev),
        prevPct: prevMev ? pct1(instsPrev[name] || 0, prevMev) : null,
      }))
      .sort((a, b) => b.n - a.n);

    // ── Validator → Builder 关系(滚动窗口):依赖哪个 builder / 是否 fallback local ──
    const vbMap = {};
    for (const b of w) {
      if (!b.miner) continue;
      const m = (vbMap[b.miner] ??= { total: 0, mev: 0, local: 0, fams: {} });
      m.total++;
      if (b.type === "local") m.local++;
      else { m.mev++; m.fams[b.family] = (m.fams[b.family] || 0) + 1; }
    }
    const validatorBuilders = Object.entries(vbMap)
      .map(([miner, m]) => {
        const top = Object.entries(m.fams).sort((a, b) => b[1] - a[1])[0] ?? null;
        return {
          miner,
          total: m.total,
          mevPct: pct1(m.mev, m.total),
          mainFam: top ? top[0] : null,
          mainPct: top ? pct1(top[1], m.mev) : 0,
          famCount: Object.keys(m.fams).length,
          local: m.local,
        };
      })
      .sort((a, b) => b.total - a.total);

    // builder 分布:历史累计(自 since 起,重启续算)
    const buildersAll = Object.entries(this.day.builderTotals).sort((a, b) => b[1] - a[1]);

    // 全网 geth 版本分布:按 validator 去重,取各自最近一次出块的版本(24h 有效)
    const minerVersions = {};
    for (const [m, v] of Object.entries(this.day.minerVers)) minerVersions[m] = v.ver;
    const vCount = {};
    for (const v of Object.values(minerVersions)) vCount[v] = (vCount[v] || 0) + 1;
    const vTotal = Object.values(vCount).reduce((s, n) => s + n, 0);
    const versions = Object.entries(vCount)
      .map(([ver, n]) => ({ ver: ver.replace(/^v/, ""), n, pct: vTotal ? Math.round((n / vTotal) * 100) : 0 }))
      .sort((a, b) => b.n - a.n);

    return {
      total: w.length,
      latest: w[w.length - 1].number,
      mevPct: pct1(w.filter((b) => b.type !== "local").length, w.length),
      v2Pct: pct1(w.filter((b) => b.type === "mev_v2").length, w.filter((b) => b.type !== "local").length),
      typeCounts,
      builderFamilies: Object.entries(famCounts).sort((a, b) => b[1] - a[1]),
      topMiners: Object.entries(minerCounts).sort((a, b) => b[1] - a[1]).slice(0, 25),
      minerVersions,
      versions,
      recent: w.slice(-16).reverse(),
      day24,
      buildersAll,
      buildersSince: this.day.since,
      concentration,
      instances,
      validatorBuilders,
    };
  }
}
