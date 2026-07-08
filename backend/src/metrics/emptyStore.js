/**
 * EmptyBlockStore — 24h rolling record of empty blocks (gasUsed below the
 * system-txs-only floor). Fed per-block by the streamer; empties are rare on
 * mainnet so the persisted file stays tiny. Zero extra RPC.
 */

import fs from "fs";
import path from "path";

export class EmptyBlockStore {
  constructor(file, windowMs = 24 * 3600e3) {
    this.file = file;
    this.windowMs = windowMs;
    this.items = [];
    try { if (fs.existsSync(file)) this.items = JSON.parse(fs.readFileSync(file, "utf8")) || []; } catch { this.items = []; }
  }

  add(t, number, miner = null) {
    this.items.push({ t, number, miner });
    this._prune(t);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.items));
    } catch {}
  }

  _prune(now = Date.now()) {
    const cut = now - this.windowMs;
    if (this.items[0]?.t < cut) this.items = this.items.filter((x) => x.t >= cut);
  }

  view(now = Date.now()) {
    this._prune(now);
    return { count: this.items.length, recent: this.items.slice(-50).reverse() };
  }
}
