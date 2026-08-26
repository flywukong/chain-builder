/**
 * BadBidblockWatch — 全网 bad block 的 bidblock(BEP-675 SendBidBlock)归因。
 *
 * 数据源:两台部署了统计版本(分支 codex/bad-bidblock-metrics)的灰度探针机:
 *   - keter 指标 chain_insert_badBidblock:进程内 counter,按块 hash LRU 去重(重启归零);
 *   - keter ES 日志「########## BAD BLOCK #########」摘要:多行内容整段存为一条 message,
 *     新版在其中打印 IsBidBlock: true/false 与 Builder: 0x…(header.RequestsHash 自声明标记,
 *     无共识校验,builder 只作线索不作定论)。
 *
 * 采集约束:
 *  - peer 反复重播同一坏块 → 同一 hash 刷屏,unique 统计按块 hash 去重;
 *  - BAD BLOCK 多行长日志可能延迟数小时才入 ES → 不能用"只扫水位线之后"的增量,
 *    每轮固定回看 12h + 行级幂等(host|t 行键),迟到的行随时补记、重扫不重复计数;
 *  - 空库首扫回看 46h(ES token 查询单窗上限 2 天),分片进行;
 *  - quickwit 不支持 hostName:("A" OR "B") 分组语法(静默返回 0),必须逐项 OR 展开。
 */

import fs from "fs";
import path from "path";
import { searchLogs } from "../keter/logs.js";

export const BAD_BIDBLOCK_IPS = (process.env.BAD_BIDBLOCK_IPS ?? "10.213.33.42,10.211.31.79")
  .split(",").map((s) => s.trim()).filter(Boolean);

const CHUNK_MS = 12 * 3600e3;          // 单次 ES 查询窗口(远小于 2d 上限,降低 1000 条截断风险)
const BACKFILL_MS = 46 * 3600e3;       // 空库首扫回看(2d 上限内留余量)
const LOOKBACK_MS = 12 * 3600e3;       // 常规每轮回看窗:容忍 ES 迟到入库(实测可迟到数小时)
const BLOCK_CAP = 500;                 // 明细上限;淘汰块的计数已进 totals/byBuilder,不丢
const ROWKEY_CAP = 300;                // 每块最多记多少行键(host|t),超出的重播不再细计

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

// 错误原因归一化:截掉首个括号起的参数段,抹平 hex/数字 → 稳定的模式键
// 如 "invalid merkle root (remote: d20e… local: ae7d…) dberr: …" → "invalid merkle root"
// remote 全 0(builder 根本没填执行结果字段)与真实值不一致是两种病因,单独成键:
// "invalid merkle root (remote: 0000…0000 local: c09b…)" → "invalid merkle root · remote全0"
export const ERR_NORM_VER = 2; // 归一化规则版本:变更时加载端用在册明细重建 byError
export const normErrReason = (err) => {
  const s = (err ?? "").replace(/\(.*$/s, "").replace(/0x[0-9a-fA-F]{4,}/g, "").replace(/\d+/g, "").replace(/\s+/g, " ").trim();
  let key = s.slice(0, 60) || "未知";
  const remote = (err ?? "").match(/remote:\s*(?:0x)?([0-9a-fA-F]{8,})/);
  if (remote && !/[^0]/.test(remote[1])) key += " · remote全0";
  return key;
};

export class BadBidblockWatch {
  constructor(file) {
    this.file = file;
    this.ips = BAD_BIDBLOCK_IPS;
    this.blocks = [];                                          // 明细(unique 坏块)
    this.totals = { blocks: 0, bid: 0, nonBid: 0, unknown: 0 }; // 按 unique hash 累计(持久)
    this.byBuilder = {};                                       // builderAddr → { n, lastT, lastNumber }
    this.byError = {};                                         // 错误模式 → { n, bid, lastT, lastNumber, sample }
    this.watermark = 0;
    this.since = Date.now();
    this.truncated = false;                                    // 有窗口撞到 1000 条页限(可能漏旧行)
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        Object.assign(this, {
          blocks: raw.blocks ?? [], totals: raw.totals ?? this.totals,
          byBuilder: raw.byBuilder ?? {}, watermark: raw.watermark ?? 0, since: raw.since ?? Date.now(),
          countedHashes: raw.countedHashes ?? [],
        });
        // 旧文件无 byError 或归一化规则升级:用在册明细重建(blocks 按 hash 唯一,重建精确;已淘汰部分不可追溯)
        if (raw.byError && raw.byErrorVer === ERR_NORM_VER) this.byError = raw.byError;
        else { this.byError = {}; for (const b of this.blocks) this._countError(b, b.lastT); }
      }
    } catch { /* fresh start */ }
    this.counted = new Set(this.countedHashes ?? []);   // 曾计入 totals 的 hash(防明细淘汰后重扫双计)
    this.byHash = new Map(this.blocks.map((b) => [b.hash, b]));
  }

  _countError(ev, t) {
    const ek = normErrReason(ev.error);
    const e = (this.byError[ek] ??= { n: 0, bid: 0, lastT: 0, lastNumber: null, sample: ev.error ?? "" });
    e.n++;
    if (ev.isBid === true) e.bid++;
    if (t >= e.lastT) { e.lastT = t; e.lastNumber = ev.number; }
  }

  _merge(ev, host, t, rowKey) {
    let b = this.byHash.get(ev.hash);
    if (!b) {
      b = { ...ev, firstT: t, lastT: t, n: 0, hosts: [], rk: [] };
      this.byHash.set(ev.hash, b);
      this.blocks.push(b);
      if (!this.counted.has(ev.hash)) {                 // totals/byBuilder/byError 每 hash 只计一次(跨淘汰持久)
        this.counted.add(ev.hash);
        this.totals.blocks++;
        this._countError(ev, t);
        if (ev.isBid === true) {
          this.totals.bid++;
          const key = ev.builder ?? "unknown";
          const a = (this.byBuilder[key] ??= { n: 0, lastT: 0, lastNumber: null });
          a.n++; a.lastT = t; a.lastNumber = ev.number;
        } else if (ev.isBid === false) this.totals.nonBid++;
        else this.totals.unknown++;
      }
    }
    // 行级幂等:回看窗内同一行每轮都会再见到,记过的行键不重复累计 n
    if (b.rk?.includes(rowKey)) return;
    if ((b.rk ??= []).length < ROWKEY_CAP) b.rk.push(rowKey);
    b.n++;
    if (t > b.lastT) b.lastT = t;
    if (t < b.firstT) b.firstT = t;
    if (!b.hosts.includes(host)) b.hosts.push(host);
  }

  // 每轮固定回看 12h(空库首扫 46h,分片);行级幂等保证重扫不重复计数
  async scan(configPath) {
    const now = Date.now();
    let from = now - (this.blocks.length === 0 ? BACKFILL_MS : LOOKBACK_MS);
    const hostQ = this.ips.map((ip) => `hostName:"${ip}"`).join(" OR ");
    let added = 0;
    while (from < now) {
      const to = Math.min(from + CHUNK_MS, now);
      const { total, rows } = await searchLogs(configPath, {
        query: `(${hostQ}) AND message:"BAD BLOCK"`,
        fromMs: from, toMs: to, order: "desc",
      });
      if (total > rows.length) this.truncated = true;   // 撞页限:坏块风暴期可能漏更旧的重复行(unique 统计影响有限)
      for (const r of rows) {
        const ev = parseBadBlockMsg(r.msg);
        if (!ev) continue;
        const t = Date.parse(r.t) || to;
        const fresh = !this.byHash.has(ev.hash);
        this._merge(ev, r.host, t, `${r.host}|${r.t}`);
        if (fresh) added++;
      }
      from = to;
    }
    this.watermark = now;   // 语义:最近一次扫描时刻(展示用),不再做增量起点
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
        blocks: this.blocks, totals: this.totals, byBuilder: this.byBuilder, byError: this.byError,
        byErrorVer: ERR_NORM_VER, watermark: this.watermark, since: this.since,
        countedHashes: [...this.counted].slice(-4000),
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
      byError: Object.entries(this.byError)
        .map(([key, e]) => ({ key, ...e }))
        .sort((x, y) => y.n - x.n),
      recent: this.blocks.slice(0, 40).map((b) => ({
        ...b, builderName: b.builder ? nameOf(b.builder) : null,
        errKey: normErrReason(b.error), // 供前端把明细行标注到错误原因汇总的编号
      })),
    };
  }
}
