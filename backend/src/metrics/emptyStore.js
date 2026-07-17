/**
 * EmptyBlockStore — rolling record of empty blocks (gasUsed below the
 * system-txs-only floor). Fed per-block by the streamer; empties are rare on
 * mainnet so the persisted file stays tiny. Zero extra RPC.
 * Store keeps up to `windowMs` (15d); view() slices a sub-window (default 24h).
 */

import fs from "fs";
import path from "path";

export class EmptyBlockStore {
  constructor(file, windowMs = 15 * 86400e3) {
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

  // 子窗口视图(默认 24h);store 总窗口 15d,历史自上线起积累
  view(subWindowMs = 24 * 3600e3, now = Date.now()) {
    this._prune(now);
    const cut = now - Math.min(subWindowMs, this.windowMs);
    const items = this.items.filter((x) => x.t >= cut);
    return { count: items.length, recent: items.slice(-80).reverse() };
  }
}
