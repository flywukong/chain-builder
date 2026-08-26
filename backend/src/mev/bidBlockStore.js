/**
 * BidBlockStore — rolling record of v2 (BEP-675 SendBidBlock) tagged blocks.
 * Pasteur 已于 2026-08-25 10:30(UTC+8)在主网激活,bid-block 为协议内正式路径;
 * 统计自激活时刻起(sinceMs 守卫),激活前的灰度数据不混入。
 *
 * 主网火力全开时 v2 可达 ~16 万块/天,15 天窗口存不下逐块明细 ——
 * 明细只保留最近 cap 条;被 cap/窗口淘汰的块折叠进持久「会话归档」
 * (每段仅 from/to/count/时间/名单,体积趋近于零),历史段不丢。
 * Fed per-block by the streamer + boot backfill; deduped by number + 归档水位线。
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
const SAVE_MIN_DIRTY = 50;
const SAVE_MIN_MS = 30_000;

// 把一批(升序)块折叠进会话列表;sessions 就地修改
function foldIntoSessions(sessions, items) {
  for (const it of items) {
    const name = it.builderName ?? it.builder;
    const last = sessions[sessions.length - 1];
    if (last && it.number - last.to <= SESSION_GAP_BLOCKS && it.number > last.to) {
      last.to = it.number; last.tEnd = it.t; last.count++;
      if (!last.miners.includes(it.miner)) last.miners.push(it.miner);
      if (!last.builders.includes(name)) last.builders.push(name);
    } else if (last && it.number <= last.to) {
      // 乱序回填落在已归档范围内:计数即可,不动区间
      last.count++;
    } else {
      sessions.push({ from: it.number, to: it.number, count: 1, tStart: it.t, tEnd: it.t,
                      miners: [it.miner], builders: [name] });
    }
  }
}

export class BidBlockStore {
  constructor(file, windowMs = 15 * 86400e3, cap = 60000, sinceMs = 0) {
    this.file = file;
    this.windowMs = windowMs;
    this.cap = cap;
    this.sinceMs = sinceMs;      // 统计起点(Pasteur 激活时刻),更早的块不入账
    this.items = [];        // 明细 { t, number, miner, builder(addr), builderName }
    this.archive = { sessions: [], builders: {}, count: 0, watermark: 0 };   // 淘汰块的折叠归档
    this.seen = new Set();
    this.discardedLegacy = false;
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        // v3 起淘汰按块号升序(见 _prune)。旧格式按插入顺序淘汰,回扫+实时并发写入时
        // watermark 会跳到链头、之后的回填被 add() 整段拒收 —— 旧数据不可信,弃掉重扫
        if (raw?.v === 3) { this.items = raw.items ?? []; this.archive = { ...this.archive, ...raw.archive }; }
        else { this.discardedLegacy = true; try { fs.copyFileSync(file, file + ".pre-v3.bak"); } catch {} }
      }
    } catch { this.items = []; }
    for (const it of this.items) this.seen.add(it.number);
    this._dirty = 0;
    this._lastSave = 0;
  }

  add(item) {
    if (!item?.number || this.seen.has(item.number)) return;
    if (item.t && item.t < this.sinceMs) return;          // 统计起点之前(激活前灰度)不入账
    if (item.number <= this.archive.watermark) return;   // 已归档范围,防回填重复计数
    this.seen.add(item.number);
    this.items.push(item);
    this._dirty++;
    if (this._dirty >= SAVE_MIN_DIRTY && Date.now() - this._lastSave >= SAVE_MIN_MS) this._save();
  }

  flush() { if (this._dirty) this._save(); }

  // 已覆盖到的最高块号(明细 + 归档),供启动回扫定起点
  lastNumber() {
    const it = this.items.reduce((m, x) => (x.number > m ? x.number : m), 0);
    const arc = Math.max(this.archive.watermark || 0, this.archive.sessions.at(-1)?.to ?? 0);
    return Math.max(it, arc);
  }

  _save() {
    this._prune();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ v: 3, items: this.items, archive: this.archive }));
      this._dirty = 0;
      this._lastSave = Date.now();
    } catch {}
  }

  // 窗口/容量淘汰:被挤出的明细折叠进归档(会话 + builder 计数),而不是丢弃。
  // 必须按块号升序从最老的块淘汰:add() 以「块号 ≤ archive.watermark = 已归档」做去重,
  // 回扫(低块号)与实时流(链头)并发写入时插入顺序≠块号序,按插入序淘汰会把
  // watermark 顶到链头,之后整段回填被拒收(v2 前的静默丢数据 bug)
  _prune(now = Date.now()) {
    const cut = now - this.windowMs;
    // 归档里滚出 15d 窗口的会话直接删(整段过期)
    this.archive.sessions = this.archive.sessions.filter((s) => s.tEnd >= cut);
    if (this.items.length <= this.cap && !(this.items[0]?.t < cut)) return;
    this.items.sort((a, b) => a.number - b.number);
    const overflow = Math.max(0, this.items.length - this.cap);
    let idx = 0;
    while (idx < this.items.length && (idx < overflow || this.items[idx].t < cut)) idx++;
    const evicted = this.items.slice(0, idx);
    const kept = this.items.slice(idx);
    if (evicted.length) {
      const stillValid = evicted.filter((x) => x.t >= cut);   // 过期块不进归档
      foldIntoSessions(this.archive.sessions, stillValid);
      for (const it of stillValid) {
        const name = it.builderName ?? it.builder ?? "?";
        const e = (this.archive.builders[name] ??= { addr: it.builder, count: 0, firstBlock: it.number, lastBlock: 0, lastT: 0 });
        e.count++;
        if (it.number > e.lastBlock) { e.lastBlock = it.number; e.lastT = it.t; }
        if (it.number < e.firstBlock) e.firstBlock = it.number;
      }
      this.archive.count += stillValid.length;
      this.archive.watermark = Math.max(this.archive.watermark, evicted[evicted.length - 1].number);   // evicted 已升序
    }
    this.items = kept;
    this.seen = new Set(kept.map((x) => x.number));
  }

  view(now = Date.now()) {
    this._prune(now);
    const asc = [...this.items].sort((a, b) => a.number - b.number);
    // builder 汇总 = 归档计数 + 在册明细
    const byBuilder = new Map();
    for (const [name, e] of Object.entries(this.archive.builders))
      byBuilder.set(name, { addr: e.addr, name, count: e.count, firstBlock: e.firstBlock, lastBlock: e.lastBlock, lastT: e.lastT });
    for (const it of asc) {
      const name = it.builderName ?? it.builder ?? "?";
      const e = byBuilder.get(name) ?? { addr: it.builder, name, count: 0, firstBlock: it.number, lastBlock: 0, lastT: 0 };
      e.count++;
      if (it.number > e.lastBlock) { e.lastBlock = it.number; e.lastT = it.t; }
      byBuilder.set(name, e);
    }
    // 会话 = 归档段 + 在册明细段,交界处按同一间隙规则缝合
    const sessions = this.archive.sessions.map((s) => ({ ...s, miners: [...s.miners], builders: [...s.builders] }));
    foldIntoSessions(sessions, asc);
    return {
      count: this.archive.count + asc.length,
      statsSince: this.sinceMs || null,
      builders: [...byBuilder.values()].sort((a, b) => b.count - a.count),
      sessions: sessions.reverse().slice(0, 30),
      lastT: asc.at(-1)?.t ?? this.archive.sessions.at(-1)?.tEnd ?? null,
    };
  }
}
