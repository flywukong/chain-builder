/**
 * SlashEventStore — rolling record of validatorSlashed events scanned from
 * SlashIndicator (0x…1001) logs. Persists items + last scanned block so the
 * incremental scanner survives restarts.
 * Store keeps `windowMs` (15d); view() slices a sub-window (default 24h).
 */

import fs from "fs";
import path from "path";

export class SlashEventStore {
  constructor(file, windowMs = 15 * 86400e3) {
    this.file = file;
    this.windowMs = windowMs;
    this.items = [];         // {t, block, validator, tx, filler?, gapMs?}
    this.lastScanned = 0;
    try {
      if (fs.existsSync(file)) {
        const d = JSON.parse(fs.readFileSync(file, "utf8")) || {};
        this.items = d.items ?? [];
        this.lastScanned = d.lastScanned ?? 0;
      }
    } catch { this.items = []; this.lastScanned = 0; }
  }

  addBatch(events, lastScanned) {
    // 幂等:同一 (block, validator) 只记一次,防重叠扫描重复计入
    const seen = new Set(this.items.map((x) => x.block + "-" + x.validator));
    const fresh = events.filter((e) => !seen.has(e.block + "-" + e.validator));
    if (fresh.length) this.items.push(...fresh);
    this.lastScanned = Math.max(this.lastScanned, lastScanned);
    this._prune();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ items: this.items, lastScanned: this.lastScanned }));
    } catch {}
  }

  _prune(now = Date.now()) {
    const cut = now - this.windowMs;
    if (this.items[0]?.t < cut) this.items = this.items.filter((x) => x.t >= cut);
  }

  // 子窗口视图(默认 24h);store 总窗口 15d,历史自上线起积累
  view(subWindowMs = 24 * 3600e3, now = Date.now()) {
    this._prune(now);
    const cut = now - Math.min(subWindowMs, this.windowMs);
    const items = this.items.filter((x) => x.t >= cut);
    return { count: items.length, lastScanned: this.lastScanned, recent: items.slice(-60).reverse(), items };
  }
}
