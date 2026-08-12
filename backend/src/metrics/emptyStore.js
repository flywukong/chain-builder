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
    return { count: items.length, recent: items.slice(-80).reverse(), streaks: computeStreaks(items) };
  }
}

export const STREAK_MIN = 3;    // 达到几个才算「连续空块」
export const STREAK_GAP = 1;    // 中间容忍几个正常块:同一轮次里夹着一两个正常块仍算同一次异常

/**
 * 连续空块识别:同一 validator、块号相邻(容忍 ≤STREAK_GAP 个正常块)的空块归为一段,
 * 满 STREAK_MIN 个才算一次。零散 1-2 个空块是 mempool 时序波动,连续多个才指向节点异常。
 * 返回按时间倒序(最近的在前)。
 */
export function computeStreaks(items, { minRun = STREAK_MIN, gapTol = STREAK_GAP } = {}) {
  const asc = [...items].sort((a, b) => a.number - b.number);
  const runs = [];
  let cur = [];
  for (const b of asc) {
    const prev = cur[cur.length - 1];
    if (prev && b.miner === prev.miner && b.number - prev.number <= gapTol + 1) cur.push(b);
    else { if (cur.length) runs.push(cur); cur = [b]; }
  }
  if (cur.length) runs.push(cur);
  return runs
    .filter((r) => r.length >= minRun)
    .map((r) => ({
      from: r[0].number, to: r[r.length - 1].number,
      blocks: r.length, span: r[r.length - 1].number - r[0].number + 1,
      miner: r[0].miner, t: r[0].t, tEnd: r[r.length - 1].t,
      numbers: r.map((x) => x.number),
    }))
    .sort((a, b) => b.t - a.t);
}
