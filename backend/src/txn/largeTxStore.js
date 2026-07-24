/**
 * LargeTxStore — rolling record of "gas-whale" single transactions
 * (a single tx whose receipt.gasUsed ≥ RECORD_MIN). Fed per-block by the
 * streamer: the MEV enrichment already fetches full txs, so we filter
 * candidates by gasLimit ≥ RECORD_MIN there (gasUsed ≤ gasLimit ⇒ no misses)
 * and confirm with one receipt per candidate — most blocks add zero RPC.
 * Window 3d, capped; deduped by txHash.
 */

import fs from "fs";
import path from "path";

export const LARGE_TX_RECORD_MIN = 3_000_000; // lowest offered threshold; frontend filters up (3M/5M/10M)

export class LargeTxStore {
  constructor(file, windowMs = 3 * 86400e3, cap = 600) {
    this.file = file;
    this.windowMs = windowMs;
    this.cap = cap;
    this.items = [];
    this.seen = new Set();
    try { if (fs.existsSync(file)) this.items = JSON.parse(fs.readFileSync(file, "utf8")) || []; } catch { this.items = []; }
    for (const it of this.items) this.seen.add(it.txHash);
  }

  // item: { t, block, txHash, gasUsed, blockGasUsed, to, from, miner }
  add(item) {
    if (!item?.txHash || this.seen.has(item.txHash)) return;
    this.seen.add(item.txHash);
    this.items.push(item);
    this._prune(item.t);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.items));
    } catch {}
  }

  _prune(now = Date.now()) {
    const cut = now - this.windowMs;
    if (this.items.length > this.cap || (this.items[0] && this.items[0].t < cut)) {
      this.items = this.items.filter((x) => x.t >= cut).slice(-this.cap);
      this.seen = new Set(this.items.map((x) => x.txHash));
    }
  }

  // 子窗口(默认 24h)+ gas 阈值过滤,按时间倒序
  view(subWindowMs = 24 * 3600e3, minGas = 0, now = Date.now()) {
    this._prune(now);
    const cut = now - Math.min(subWindowMs, this.windowMs);
    const items = this.items.filter((x) => x.t >= cut && x.gasUsed >= minGas).sort((a, b) => b.t - a.t);
    return { count: items.length, items };
  }
}
