/**
 * MevLogReader — tails the getchainstatus MEV log (continuously appended by a
 * separate collector) and serves aggregated MEV stats.
 *
 * Line format:
 *   blockNum: 105000000   type: mev_v1   miner: Tranchess   builder: (puissant us) 0x48Fe...
 *
 * Why a log instead of the streamer's own heuristic: getchainstatus is the
 * authoritative MEV logic (v1/v2 typing + miner monikers), and decouples the
 * heavy per-block MEV RPC load from the realtime block streamer.
 */

import fs from "fs";
import { EventEmitter } from "events";

const LINE_RE = /blockNum:\s*(\d+)\s+type:\s*(\S+)\s+miner:\s*(.+?)\s+builder:\s*\(([^)]*)\)\s*(\S+)/;
const family = (name) => {
  const f = (name || "").trim().split(/\s+/)[0].toLowerCase();
  return f.startsWith("unknown") ? "unknown" : f; // collapse unknown-1/2/3…
};

export class MevLogReader extends EventEmitter {
  constructor(path, { windowSize = 2000, pollMs = 2000 } = {}) {
    super();
    this.path = path;
    this.windowSize = windowSize;
    this.pollMs = pollMs;
    this.window = [];
    this.offset = 0;
    this.partial = "";
    this.running = false;
  }

  start() {
    if (!this.path || !fs.existsSync(this.path)) {
      this.emit("status", { mevLogMissing: this.path });
      return;
    }
    this.running = true;
    this._readNew();
    this._timer = setInterval(() => this._readNew(), this.pollMs);
  }

  stop() {
    this.running = false;
    clearInterval(this._timer);
  }

  _readNew() {
    try {
      const stat = fs.statSync(this.path);
      if (stat.size < this.offset) { this.offset = 0; this.partial = ""; this.window = []; } // truncated/rotated
      if (stat.size === this.offset) return;

      const fd = fs.openSync(this.path, "r");
      const len = stat.size - this.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      fs.closeSync(fd);
      this.offset = stat.size;

      const text = this.partial + buf.toString("utf8");
      const lines = text.split("\n");
      this.partial = lines.pop();

      let added = 0;
      for (const line of lines) {
        const m = LINE_RE.exec(line);
        if (!m) continue;
        this.window.push({
          number: +m[1], type: m[2], miner: m[3].trim(),
          builderName: m[4].trim(), builder: m[5], family: family(m[4]),
        });
        added++;
      }
      if (this.window.length > this.windowSize) this.window = this.window.slice(-this.windowSize);
      if (added) this.emit("update", this.getStats());
    } catch (e) {
      this.emit("error", e);
    }
  }

  getStats() {
    const w = this.window;
    if (!w.length) return null;
    const typeCounts = {}, famCounts = {}, minerCounts = {};
    for (const b of w) {
      typeCounts[b.type] = (typeCounts[b.type] || 0) + 1;
      if (b.type !== "local") famCounts[b.family] = (famCounts[b.family] || 0) + 1;
      minerCounts[b.miner] = (minerCounts[b.miner] || 0) + 1;
    }
    const mev = w.filter((b) => b.type !== "local").length;
    const v2 = w.filter((b) => b.type === "mev_v2").length;
    return {
      total: w.length,
      latest: w[w.length - 1].number,
      mevPct: Math.round((mev / w.length) * 100),
      v2Pct: mev ? Math.round((v2 / mev) * 100) : 0,
      typeCounts,
      builderFamilies: Object.entries(famCounts).sort((a, b) => b[1] - a[1]),
      topMiners: Object.entries(minerCounts).sort((a, b) => b[1] - a[1]).slice(0, 12),
      recent: w.slice(-24).reverse(),
    };
  }
}
