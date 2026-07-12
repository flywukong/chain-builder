/**
 * ReorgObsStore — 24h rolling record of reorgs observed by our own WS SeqGuard,
 * with exact block heights (keter counters carry no heights). Single-vantage:
 * used for height display; the chain-level count comes from keter (≥2 nodes).
 */

import fs from "fs";
import path from "path";

export class ReorgObsStore {
  constructor(file, windowMs = 24 * 3600e3) {
    this.file = file;
    this.windowMs = windowMs;
    this.items = [];
    try { if (fs.existsSync(file)) this.items = JSON.parse(fs.readFileSync(file, "utf8")) || []; } catch { this.items = []; }
  }

  add(from, to, depth, oldMiners = []) {
    // oldMiners:被重组掉的旧块出块人(嫌疑方),供 AI 判定自营/外部
    this.items.push({ t: Date.now(), from, to, depth, oldMiners });
    this._prune();
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
    return { count: this.items.length, recent: this.items.slice(-20).reverse() };
  }
}
