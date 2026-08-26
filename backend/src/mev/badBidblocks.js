/**
 * BadBidblockWatch — 全网 bad block 的 bidblock(BEP-675 SendBidBlock)归因。
 *
 * 数据源:两台部署了统计版本(分支 codex/bad-bidblock-metrics)的灰度探针机:
 *   - keter 指标 chain_insert_badBidblock:进程内 counter,按块 hash LRU 去重(重启归零);
 *   - keter ES 日志「########## BAD BLOCK #########」摘要:多行内容整段存为一条 message,
 *     新版在其中打印 IsBidBlock: true/false 与 Builder: 0x…(header.RequestsHash 自声明标记,
 *     无共识校验,builder 只作线索不作定论)。
 *
 * 采集约束:peer 会反复重播同一坏块 → 同一 hash 在日志里刷屏,必须按块 hash 去重;
 * ES token 查询单窗口上限 2 天 → 增量扫描 + 水位线,首扫回填分片进行。
 */

import fs from "fs";
import path from "path";
import { searchLogs } from "../keter/logs.js";

export const BAD_BIDBLOCK_IPS = (process.env.BAD_BIDBLOCK_IPS ?? "10.213.33.42,10.211.31.79")
  .split(",").map((s) => s.trim()).filter(Boolean);

const CHUNK_MS = 12 * 3600e3;          // 单次 ES 查询窗口(远小于 2d 上限,降低 1000 条截断风险)
const BACKFILL_MS = 46 * 3600e3;       // 首扫回填(2d 上限内留余量)
const BLOCK_CAP = 500;                 // 明细上限;淘汰块的计数已进 totals/byBuilder,不丢

// BAD BLOCK 摘要解析(整段 message):没有 Block: 行的不是坏块摘要
export function parseBadBlockMsg(msg) {
  const head = (msg || "").match(/Block:\s*(\d+)\s*\((0x[0-9a-fA-F]{64})\)/);
  if (!head) return null;
  const isBidM = msg.match(/IsBidBlock:\s*(true|false)/);
  return {
    number: +head[1],
    hash: head[2].toLowerCase(),
    miner: msg.match(/Miner:\s*(0x[0-9a-fA-F]{40})/)?.[1]?.toLowerCase() ?? null,
    isBid: isBidM ? isBidM[1] === "true" : null,   // null = 旧格式日志(未打补丁版本)
    builder: msg.match(/Builder:\s*(0x[0-9a-fA-F]{40})/)?.[1]?.toLowerCase() ?? null,
    error: msg.match(/Error:\s*([^\n]*)/)?.[1]?.trim().slice(0, 240) ?? null,
  };
}

export class BadBidblockWatch {
  constructor(file) {
    this.file = file;
    this.ips = BAD_BIDBLOCK_IPS;
    this.blocks = [];                                          // 明细(unique 坏块)
    this.totals = { blocks: 0, bid: 0, nonBid: 0, unknown: 0 }; // 按 unique hash 累计(持久)
    this.byBuilder = {};                                       // builderAddr → { n, lastT, lastNumber }
    this.watermark = 0;
    this.since = Date.now();
    this.truncated = false;                                    // 有窗口撞到 1000 条页限(可能漏旧行)
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        Object.assign(this, {
          blocks: raw.blocks ?? [], totals: raw.totals ?? this.totals,
          byBuilder: raw.byBuilder ?? {}, watermark: raw.watermark ?? 0, since: raw.since ?? Date.now(),
        });
      }
    } catch { /* fresh start */ }
    this.byHash = new Map(this.blocks.map((b) => [b.hash, b]));
  }

  _merge(ev, host, t) {
    let b = this.byHash.get(ev.hash);
    if (!b) {
      b = { ...ev, firstT: t, lastT: t, n: 0, hosts: [] };
      this.byHash.set(ev.hash, b);
      this.blocks.push(b);
      this.totals.blocks++;
      if (ev.isBid === true) {
        this.totals.bid++;
        const key = ev.builder ?? "unknown";
        const a = (this.byBuilder[key] ??= { n: 0, lastT: 0, lastNumber: null });
        a.n++; a.lastT = t; a.lastNumber = ev.number;
      } else if (ev.isBid === false) this.totals.nonBid++;
      else this.totals.unknown++;
    }
    b.n++;
    if (t > b.lastT) b.lastT = t;
    if (t < b.firstT) b.firstT = t;
    if (!b.hosts.includes(host)) b.hosts.push(host);
  }

  // 增量扫描:水位线(-60s 重叠防边界漏)→ now,分片查询
  async scan(configPath) {
    const now = Date.now();
    let from = this.watermark ? this.watermark - 60e3 : now - BACKFILL_MS;
    from = Math.max(from, now - BACKFILL_MS);
    const hostQ = this.ips.map((ip) => `"${ip}"`).join(" OR ");
    let added = 0;
    while (from < now) {
      const to = Math.min(from + CHUNK_MS, now);
      const { total, rows } = await searchLogs(configPath, {
        query: `hostName:(${hostQ}) AND message:"BAD BLOCK"`,
        fromMs: from, toMs: to, order: "desc",
      });
      if (total > rows.length) this.truncated = true;   // 撞页限:坏块风暴期可能漏更旧的重复行(unique 统计影响有限)
      for (const r of rows) {
        const ev = parseBadBlockMsg(r.msg);
        if (!ev) continue;
        const t = Date.parse(r.t) || to;
        const fresh = !this.byHash.has(ev.hash);
        this._merge(ev, r.host, t);
        if (fresh) added++;
      }
      from = to;
    }
    this.watermark = now;
    // 按最近活跃排序,淘汰最老明细(计数已持久在 totals/byBuilder)
    this.blocks.sort((a, b) => b.lastT - a.lastT);
    if (this.blocks.length > BLOCK_CAP) {
      for (const b of this.blocks.slice(BLOCK_CAP)) this.byHash.delete(b.hash);
      this.blocks = this.blocks.slice(0, BLOCK_CAP);
    }
    this._save();
    return added;
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({
        blocks: this.blocks, totals: this.totals, byBuilder: this.byBuilder,
        watermark: this.watermark, since: this.since,
      }));
    } catch { /* non-fatal */ }
  }

  view(nameOf = () => null) {
    return {
      ips: this.ips,
      since: this.since,
      watermark: this.watermark,
      truncated: this.truncated,
      totals: this.totals,
      byBuilder: Object.entries(this.byBuilder)
        .map(([addr, a]) => ({ addr, name: addr === "unknown" ? null : nameOf(addr), ...a }))
        .sort((x, y) => y.n - x.n),
      recent: this.blocks.slice(0, 40).map((b) => ({
        ...b, builderName: b.builder ? nameOf(b.builder) : null,
      })),
    };
  }
}
