/**
 * MevAggregator — rolls up the streamer's per-block MEV detection into MEV stats.
 *
 * The block streamer already detects MEV on every block as it follows the chain
 * tip (newHeads + getchainstatus-style last-tx→builderMap heuristic). This just
 * maintains a rolling window and computes aggregates for the MEV subsystem.
 *
 * Continuous & tip-following — no fixed block range, no external mev.log.
 */

import { EventEmitter } from "events";

// brand aliases: Puissant is 48Club's builder — display under the operator name
const FAMILY_ALIAS = { puissant: "48club" };

const family = (name) => {
  const f = (name || "").trim().split(/\s+/)[0].toLowerCase();
  if (f.startsWith("unknown")) return "unknown";
  return FAMILY_ALIAS[f] ?? f;
};

export class MevAggregator extends EventEmitter {
  constructor({ windowSize = 2000 } = {}) {
    super();
    this.windowSize = windowSize;
    this.window = [];
  }

  // Fed from streamer "block" events.
  add(block) {
    if (block == null || typeof block.number !== "number") return;
    const type = block.mev?.source === "bidblock" ? "mev_v2" : block.isMev ? "mev_v1" : "local";
    this.window.push({
      number: block.number,
      type,
      miner: block.miner,                 // address; frontend resolves to moniker
      builderName: block.builder || null, // e.g. "puissant us"
      family: family(block.builder),
      version: block.version || null,     // 从 extraData 解析的 validator 二进制版本
    });
    if (this.window.length > this.windowSize) this.window.shift();
  }

  getStats() {
    const w = this.window;
    if (!w.length) return null;
    const typeCounts = {}, famCounts = {}, minerCounts = {}, minerVersions = {};
    for (const b of w) {
      typeCounts[b.type] = (typeCounts[b.type] || 0) + 1;
      if (b.type !== "local") famCounts[b.family] = (famCounts[b.family] || 0) + 1;
      if (b.miner) {
        minerCounts[b.miner] = (minerCounts[b.miner] || 0) + 1;
        if (b.version && b.version !== "unknown") minerVersions[b.miner] = b.version;   // 该 validator 最近一次出块的版本
      }
    }
    const mev = w.filter((b) => b.type !== "local").length;
    const v2 = w.filter((b) => b.type === "mev_v2").length;
    // floor to 1 decimal: 1993/2000 must read 99.6%, not round up to a false 100%
    const pct1 = (a, b) => (b ? Math.floor((a / b) * 1000) / 10 : 0);

    // 全网 geth 版本分布:按 validator 去重(minerVersions=各 validator 最近出块的 extraData 版本)
    const vCount = {};
    for (const v of Object.values(minerVersions)) vCount[v] = (vCount[v] || 0) + 1;
    const vTotal = Object.values(vCount).reduce((s, n) => s + n, 0);
    const versions = Object.entries(vCount)
      .map(([ver, n]) => ({ ver: ver.replace(/^v/, ""), n, pct: vTotal ? Math.round((n / vTotal) * 100) : 0 }))
      .sort((a, b) => b.n - a.n);
    return {
      total: w.length,
      latest: w[w.length - 1].number,
      mevPct: pct1(mev, w.length),
      v2Pct: pct1(v2, mev),
      typeCounts,
      builderFamilies: Object.entries(famCounts).sort((a, b) => b[1] - a[1]),
      topMiners: Object.entries(minerCounts).sort((a, b) => b[1] - a[1]).slice(0, 25),
      minerVersions,
      versions,
      recent: w.slice(-16).reverse(),
    };
  }
}
