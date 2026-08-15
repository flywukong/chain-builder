/**
 * BidBlockStore — rolling record of v2 (BEP-675 SendBidBlock) tagged blocks.
 * 主网 Pasteur 未激活,这些块来自个别 builder 的提前灰度(如 48club/puissant),
 * 稀少且有观测价值:谁在跑、哪些区块区间、每段多少块。
 * Fed per-block by the streamer + boot backfill; deduped by block number; window 15d.
 */

import fs from "fs";
import path from "path";

// header.RequestsHash → {v, builder} | null(非 MEV 标记)。
// 布局见 bsc 源码 core/types/builder/block_mev_info.go:11 字节零哨兵 + 1 字节 version + 20 字节 builder。
export function decodeMevTag(requestsHash) {
  if (!requestsHash || requestsHash.length !== 66) return null;
  const b = Buffer.from(requestsHash.slice(2), "hex");
  for (let i = 0; i < 11; i++) if (b[i] !== 0) return null;
  const v = b[11];
  if (v !== 1 && v !== 2) return null;
  const builder = "0x" + b.subarray(12, 32).toString("hex");
  if (/^0x0{40}$/.test(builder)) return null;
  return { v, builder };
}

// 区间聚合:块号排序后,相邻块距 ≤ gapBlocks 归同一段(跨 validator 轮次也算同一次灰度会话)
const SESSION_GAP_BLOCKS = 1200;   // ~9 分钟

export class BidBlockStore {
  constructor(file, windowMs = 15 * 86400e3, cap = 20000) {
    this.file = file;
    this.windowMs = windowMs;
    this.cap = cap;
    this.items = [];      // { t, number, miner, builder(addr), builderName }
    this.seen = new Set();
    try { if (fs.existsSync(file)) this.items = JSON.parse(fs.readFileSync(file, "utf8")) || []; } catch { this.items = []; }
    for (const it of this.items) this.seen.add(it.number);
    this._dirty = 0;
  }

  add(item) {
    if (!item?.number || this.seen.has(item.number)) return;
    this.seen.add(item.number);
    this.items.push(item);
    if (++this._dirty >= 5) this._save();
  }

  flush() { if (this._dirty) this._save(); }

  _save() {
    this._prune();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.items));
      this._dirty = 0;
    } catch {}
  }

  _prune(now = Date.now()) {
    const cut = now - this.windowMs;
    if (this.items.length > this.cap || this.items[0]?.t < cut) {
      this.items = this.items.filter((x) => x.t >= cut).slice(-this.cap);
      this.seen = new Set(this.items.map((x) => x.number));
    }
  }

  view(now = Date.now()) {
    this._prune(now);
    const asc = [...this.items].sort((a, b) => a.number - b.number);
    // 按 builder 汇总
    const byBuilder = new Map();
    for (const it of asc) {
      const k = (it.builder || "?").toLowerCase();
      const e = byBuilder.get(k) ?? { addr: it.builder, name: it.builderName ?? null, count: 0, firstBlock: it.number, lastBlock: it.number, lastT: it.t };
      e.count++; e.lastBlock = it.number; e.lastT = it.t;
      if (it.builderName) e.name = it.builderName;
      byBuilder.set(k, e);
    }
    // 区间(灰度会话)
    const sessions = [];
    let cur = null;
    for (const it of asc) {
      if (cur && it.number - cur.to <= SESSION_GAP_BLOCKS) {
        cur.to = it.number; cur.count++; cur.tEnd = it.t;
        cur.builders.add(it.builderName ?? it.builder);
        cur.miners.add(it.miner);
      } else {
        if (cur) sessions.push(cur);
        cur = { from: it.number, to: it.number, count: 1, tStart: it.t, tEnd: it.t,
                builders: new Set([it.builderName ?? it.builder]), miners: new Set([it.miner]) };
      }
    }
    if (cur) sessions.push(cur);
    return {
      count: asc.length,
      builders: [...byBuilder.values()].sort((a, b) => b.count - a.count),
      sessions: sessions.reverse().slice(0, 30)
        .map((s) => ({ ...s, builders: [...s.builders], miners: [...s.miners] })),
      lastT: asc.at(-1)?.t ?? null,
    };
  }
}
