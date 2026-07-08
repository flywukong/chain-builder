/**
 * SlashEventStore — 24h rolling record of validatorSlashed events scanned from
 * SlashIndicator (0x…1001) logs. Persists items + last scanned block so the
 * incremental scanner survives restarts.
 */

import fs from "fs";
import path from "path";

export class SlashEventStore {
  constructor(file, windowMs = 24 * 3600e3) {
    this.file = file;
    this.windowMs = windowMs;
    this.items = [];         // {t, block, validator, tx}
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
    if (events.length) this.items.push(...events);
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

  view(now = Date.now()) {
    this._prune(now);
    return { count: this.items.length, lastScanned: this.lastScanned, recent: this.items.slice(-20).reverse() };
  }
}
