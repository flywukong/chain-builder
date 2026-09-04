/**
 * TxnStore — 30-day rolling hourly aggregates for legacy and developer traffic views.
 * No sender-address list is retained; unique senders use compact HLL sketches.
 * Contracts/events/methods are bounded per hourly bucket before persistence.
 */

import fs from "fs";
import path from "path";
import { CATS, CLASSIFIER_V2_VER, TRAFFIC_SCHEMA_VER, TRAFFIC_SEGMENTS } from "./classifier.js";

// 存储窗留 31d:比 30d 查询窗多 1 天,避免最旧桶滚出时 30d 连续性判定在 719/720h 间闪烁
const WINDOW_MS = 31 * 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const HLL_P = 10;
const HLL_M = 1 << HLL_P;

// Compact HyperLogLog sketches estimate unique senders without retaining
// addresses. 1024 registers are ~1KB/category/hour with ~3.25% standard error.
function hash32(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function hllAdd(registers, value) {
  if (!value) return;
  const h = hash32(value);
  const idx = h & (HLL_M - 1);
  const rest = h >>> HLL_P;
  const rank = Math.min(32 - HLL_P + 1, Math.clz32(rest) - HLL_P + 1);
  if (rank > registers[idx]) registers[idx] = rank;
}

function hllDecode(encoded) {
  if (!encoded) return new Uint8Array(HLL_M);
  try {
    const buf = Buffer.from(encoded, "base64");
    return buf.length === HLL_M ? new Uint8Array(buf) : new Uint8Array(HLL_M);
  } catch { return new Uint8Array(HLL_M); }
}

function hllEncode(registers) {
  return Buffer.from(registers).toString("base64");
}

function hllEstimate(registers) {
  let inv = 0, zeros = 0;
  for (const r of registers) { inv += 2 ** -r; if (r === 0) zeros++; }
  const alpha = 0.7213 / (1 + 1.079 / HLL_M);
  let estimate = alpha * HLL_M * HLL_M / inv;
  if (estimate <= 2.5 * HLL_M && zeros) estimate = HLL_M * Math.log(HLL_M / zeros);
  return Math.max(0, Math.round(estimate));
}

function percentile(values, p) {
  if (!values?.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))];
}

function weightedPercentile(samples, p) {
  if (!samples?.length) return null;
  const sorted = [...samples].sort((a, b) => a[0] - b[0]);
  const target = sorted.reduce((sum, row) => sum + row[1], 0) * p;
  let cumulative = 0;
  for (const [value, weight] of sorted) {
    cumulative += weight;
    if (cumulative >= target) return value;
  }
  return sorted.at(-1)[0];
}

export class TxnStore {
  constructor(file, { v2Only = false, windowMs = WINDOW_MS } = {}) {
    this.file = file;
    this.v2Only = v2Only;
    this.windowMs = windowMs;   // 回填临时 store 用超长窗,避免长任务过程中最早的桶被边填边删
    this.buckets = [];
    // 历史累计(不滚动,重启续算):since + blocks/txs + 分类 n/gas
    this.allTime = { since: Date.now(), blocks: 0, txs: 0, cats: {} };
    // v2 多维累计:自 v2 分类器上线时刻分段起算(不与 v1 历史混口径)
    this.allTime2 = { since: Date.now(), txs: 0, acts: {} };
    this.lastSaveError = null;
    this._senderHll = new Map();
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Array.isArray(raw)) {
          // 旧格式(纯桶数组):迁移 —— 用现有 7d 数据预填累计
          this.buckets = raw;
          this.allTime.since = raw[0]?.t ?? Date.now();
          for (const b of raw) {
            this.allTime.blocks += b.blocks; this.allTime.txs += b.txs;
            for (const [c, v] of Object.entries(b.cats ?? {})) {
              const a = (this.allTime.cats[c] ??= { n: 0, gas: 0 });
              a.n += v.n; a.gas += v.gas || 0;
            }
          }
        } else if (raw) {
          this.buckets = raw.buckets ?? [];
          this.allTime = raw.allTime ?? this.allTime;
          if (raw.allTime2) this.allTime2 = raw.allTime2;
        }
      }
    } catch { this.buckets = []; }
  }

  _senderRegisters(bucket, segment) {
    const key = `${bucket.t}:${segment}`;
    let registers = this._senderHll.get(key);
    if (!registers) {
      registers = hllDecode(bucket.senderHll?.[segment]);
      this._senderHll.set(key, registers);
    }
    return registers;
  }

  _serializedSenderHll(bucket) {
    const out = { ...(bucket.senderHll ?? {}) };
    for (const segment of TRAFFIC_SEGMENTS) {
      const registers = this._senderHll.get(`${bucket.t}:${segment}`);
      if (registers) out[segment] = hllEncode(registers);
    }
    bucket.senderHll = out;
    return out;
  }

  _senderEstimate(buckets, segment) {
    const union = new Uint8Array(HLL_M);
    for (const bucket of buckets) {
      const registers = this._senderRegisters(bucket, segment);
      for (let i = 0; i < HLL_M; i++) if (registers[i] > union[i]) union[i] = registers[i];
    }
    return hllEstimate(union);
  }

  _bucket(now) {
    const t = Math.floor(now / HOUR) * HOUR;
    let b = this.buckets.at(-1);
    if (b?.t === t) return b;
    b = this.buckets.find((x) => x.t === t);   // 并发抓块乱序到达/跨小时边界
    if (!b) {
      b = { t, blocks: 0, txs: 0, cats: {}, contracts: {}, segments: {}, protocols: {}, features: {}, events: {}, trafficExcluded: {} };
      this.buckets.push(b);
      this.buckets.sort((x, y) => x.t - y.t);
      const cutoff = now - this.windowMs;
      if (this.buckets[0]?.t < cutoff) {
        this.buckets = this.buckets.filter((x) => x.t >= cutoff);
        for (const key of this._senderHll.keys()) if (Number(key.slice(0, key.indexOf(":"))) < cutoff) this._senderHll.delete(key);
      }
    }
    return b;
  }

  // 状态文件丢失/损坏时，从已持久化区块区间恢复连续水位，避免退回“只抓链头一分钟”。
  blockCoverage() {
    const ranges = this.buckets.flatMap((b) => b.blockRanges ?? [])
      .filter(([lo, hi]) => Number.isFinite(lo) && Number.isFinite(hi))
      .sort((a, b) => a[0] - b[0]);
    if (!ranges.length) return null;
    let firstBlock = ranges[0][0], contiguousTo = ranges[0][1];
    for (let i = 1; i < ranges.length; i++) {
      const [lo, hi] = ranges[i];
      if (lo > contiguousTo + 1) break;
      contiguousTo = Math.max(contiguousTo, hi);
    }
    return { firstBlock, contiguousTo };
  }

  addBlock(now, classified, blockGp = null, blockGp90 = null, blockNum = null) {
    const b = this._bucket(now);
    const priorBlocks = b.blocks || 0;
    if (Number.isFinite(blockNum)) {
      // 持久化紧凑区块区间，使 sampler 状态文件落后/崩溃重启时重抓也不会重复计数。
      const ranges = (b.blockRanges ??= []);
      if (ranges.some(([lo, hi]) => blockNum >= lo && blockNum <= hi)) return false;
      ranges.push([blockNum, blockNum]);
      ranges.sort((x, y) => x[0] - y[0]);
      const merged = [];
      for (const [lo, hi] of ranges) {
        const last = merged.at(-1);
        if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
        else merged.push([lo, hi]);
      }
      b.blockRanges = merged;
      b.minBlock = b.minBlock == null ? blockNum : Math.min(b.minBlock, blockNum);
      b.maxBlock = b.maxBlock == null ? blockNum : Math.max(b.maxBlock, blockNum);
    }
    b.blocks++;
    b.rev = (b.rev || 0) + 1;
    b.firstSeenAt = b.firstSeenAt == null ? now : Math.min(b.firstSeenAt, now);
    b.lastSeenAt = b.lastSeenAt == null ? now : Math.max(b.lastSeenAt, now);
    b.v2Blocks = (b.v2Blocks ?? Math.max(0, b.blocks - 1)) + 1;
    // 即使空块也属于当前分类器版本的连续采集区间。
    if (b.v2v != null && b.v2v !== CLASSIFIER_V2_VER) b.v2mixed = true;
    else b.v2v = CLASSIFIER_V2_VER;
    if ((b.trafficV != null && b.trafficV !== TRAFFIC_SCHEMA_VER) || (priorBlocks > 0 && b.trafficV == null)) b.trafficMixed = true;
    else b.trafficV = TRAFFIC_SCHEMA_VER;
    b.acts ??= {};
    b.segments ??= {};
    b.protocols ??= {};
    b.features ??= {};
    b.events ??= {};
    b.trafficExcluded ??= {};
    b.contracts ??= {};
    if (b.v2Txs == null) b.v2Txs = b.v2v === CLASSIFIER_V2_VER && !b.v2mixed ? b.txs : 0;
    if (b.trafficTxs == null) b.trafficTxs = b.trafficV === TRAFFIC_SCHEMA_VER && !b.trafficMixed ? b.txs : 0;
    b.v2Txs += classified.length;
    b.trafficTxs += classified.length;
    // 块级 gas price 分位(gwei)蓄水池抽样:gp=块中位(常规价),gp90=块 p90(高价单水位)
    if (typeof blockGp === "number") {
      (b.gp ??= []);
      if (b.gp.length < 300) b.gp.push(blockGp);
      else b.gp[Math.floor(Math.random() * 300)] = blockGp;
    }
    if (typeof blockGp90 === "number") {
      (b.gp90 ??= []);
      if (b.gp90.length < 300) b.gp90.push(blockGp90);
      else b.gp90[Math.floor(Math.random() * 300)] = blockGp90;
    }
    if (!this.v2Only) this.allTime.blocks++;
    for (const c of classified) {
      b.txs++;
      if (!this.v2Only) {
        const cat = (b.cats[c.cat] ??= { n: 0, gas: 0 });
        cat.n++; cat.gas += Number.isFinite(c.gas) ? c.gas : 0;
        this.allTime.txs++;
        const ac = (this.allTime.cats[c.cat] ??= { n: 0, gas: 0 });
        ac.n++; ac.gas += Number.isFinite(c.gas) ? c.gas : 0;
      }
      // v2 多维双写:activity 互斥挂 gas;assets/flows 叠加只计笔数;质量位
      if (c.act) {
        const ae = (b.acts[c.act] ??= { n: 0, gas: 0 });
        ae.n++; ae.gas += Number.isFinite(c.gas) ? c.gas : 0;
        this.allTime2.txs++;
        const a2 = (this.allTime2.acts[c.act] ??= { n: 0, gas: 0 });
        a2.n++; a2.gas += Number.isFinite(c.gas) ? c.gas : 0;
        for (const s of c.assets ?? []) (b.assets ??= {})[s] = (b.assets[s] || 0) + 1;
        for (const f of c.flows ?? []) (b.flows ??= {})[f] = (b.flows[f] || 0) + 1;
        if (c.fail || c.rcptMiss) {
          const q = (b.qual ??= { failed: 0, rcptMiss: 0 });
          if (c.fail) q.failed++;
          if (c.rcptMiss) q.rcptMiss++;
        }
      }
      // Developer-facing primary traffic projection: exact one segment per tx.
      if (c.excluded) b.trafficExcluded[c.excluded] = (b.trafficExcluded[c.excluded] || 0) + 1;
      if (c.segment) {
        b.trafficV = c.trafficV ?? TRAFFIC_SCHEMA_VER;
        const se = (b.segments[c.segment] ??= { n: 0, gas: 0, failed: 0, gasSamples: [] });
        se.n++; se.gas += Number.isFinite(c.gas) ? c.gas : 0; if (c.failed) se.failed++;
        if (Number.isFinite(c.gas)) {
          if (se.gasSamples.length < 128) se.gasSamples.push(c.gas);
          else {
            const j = Math.floor(Math.random() * se.n);
            if (j < se.gasSamples.length) se.gasSamples[j] = c.gas;
          }
        }
        hllAdd(this._senderRegisters(b, c.segment), c.fact?.f);
        if (c.protocol) {
          const protocolKey = `${c.segment}:${c.protocol}`;
          const pe = (b.protocols[protocolKey] ??= { protocol: c.protocol, n: 0, gas: 0, failed: 0, segment: c.segment });
          pe.n++; pe.gas += Number.isFinite(c.gas) ? c.gas : 0; if (c.failed) pe.failed++;
        }
        const f = c.fact;
        if (f?.sw > 0) b.features.swap = (b.features.swap || 0) + 1;
        if (f?.xf > 0) b.features.transfer = (b.features.transfer || 0) + 1;
        if (f?.ap > 0) b.features.approval = (b.features.approval || 0) + 1;
        if (f?.nft > 0) b.features.nft = (b.features.nft || 0) + 1;
        if (f?.mt > 0) b.features.erc1155 = (b.features.erc1155 || 0) + 1;
        const seenTopics = new Set();
        for (const [emitter, topic] of f?.ev ?? []) {
          if (!topic || seenTopics.has(topic)) continue;
          seenTopics.add(topic);
          const event = (b.events[topic] ??= { n: 0, emitters: {} });
          event.n++;
          if (emitter && (event.emitters[emitter] != null || Object.keys(event.emitters).length < 16)) {
            event.emitters[emitter] = (event.emitters[emitter] || 0) + 1;
          }
        }
      }
      // Contract/method drill-down is independent of the legacy category and is
      // also retained by offline traffic-only backfills.
      if (c.to && c.segment && c.segment !== "native_transfer" && c.segment !== "builder_payment") {
        const ct = (b.contracts[c.to] ??= {
          n: 0, gas: 0, failed: 0, cat: c.cat, segment: c.segment || "other_call",
          protocol: c.protocol || null, role: c.contractRole || null,
          sels: {}, methodStats: {}, swap: 0, xfer: 0,
        });
        ct.n++; ct.gas += Number.isFinite(c.gas) ? c.gas : 0; if (c.failed) ct.failed++;
        if (c.segment && (ct.segment === "other_call" || c.segment !== "other_call")) ct.segment = c.segment;
        if (c.protocol) ct.protocol = c.protocol;
        if (c.contractRole) ct.role = c.contractRole;
        if (c.sel && c.sel !== "0x") {
          ct.sels ??= {}; ct.sels[c.sel] = (ct.sels[c.sel] || 0) + 1;
          ct.methodStats ??= {};
          const ms = (ct.methodStats[c.sel] ??= { n: 0, gas: 0, failed: 0, samples: [], txs: [], action: c.businessAction || null });
          if (c.businessAction) ms.action = c.businessAction;
          ms.n++; ms.gas += Number.isFinite(c.gas) ? c.gas : 0; if (c.failed) ms.failed++;
          if (Number.isFinite(c.gas)) {
            if (ms.samples.length < 24) ms.samples.push(c.gas);
            else {
              const j = Math.floor(Math.random() * ms.n);
              if (j < ms.samples.length) ms.samples[j] = c.gas;
            }
          }
          if (c.fact?.h && ms.txs.length < 3 && !ms.txs.includes(c.fact.h)) ms.txs.push(c.fact.h);
        }
        ct.swap = (ct.swap || 0) + (c.swap || 0);
        ct.xfer = (ct.xfer || 0) + (c.xfer || 0);
      }
    }
    this._save();
    return true;
  }

  // 全量抓块下每分钟 addBlock ~133 次,写盘节流为 3s 内最多一次;flush() 立即落盘
  _save() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.flush(); }, 3000);
  }

  flush() {
    if (!this._dirty) return !this.lastSaveError;
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const slim = this.buckets.map((b) => {
        const contracts = Object.fromEntries(Object.entries(b.contracts ?? {})
          .sort((a, x) => x[1].n - a[1].n).slice(0, 200)
          .map(([addr, row]) => {
            const topMethods = Object.entries(row.methodStats ?? {}).sort((a, x) => x[1].n - a[1].n).slice(0, 40);
            return [addr, {
              ...row,
              methodStats: Object.fromEntries(topMethods),
              sels: Object.fromEntries(topMethods.map(([sel, stats]) => [sel, stats.n || 0])),
            }];
          }));
        const events = Object.fromEntries(Object.entries(b.events ?? {}).sort((a, x) => x[1].n - a[1].n).slice(0, 100));
        b.contracts = contracts;
        b.events = events;
        return {
          ...b, contracts, events, senderHll: this._serializedSenderHll(b),
          ...(b.gp?.length > 120 ? { gp: b.gp.slice(-120) } : {}),
          ...(b.gp90?.length > 120 ? { gp90: b.gp90.slice(-120) } : {}),
        };
      });
      fs.writeFileSync(tmp, JSON.stringify({ buckets: slim, allTime: this.allTime, allTime2: this.allTime2 }));
      fs.renameSync(tmp, this.file);
      this._dirty = false;
      this.lastSaveError = null;
      return true;
    } catch (e) {
      // 水位推进依赖这个返回值；失败时保留 dirty，下一批继续重试，绝不能静默丢数据。
      this._dirty = true;
      this.lastSaveError = e?.message || "txn store persist failed";
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
      return false;
    }
  }

  // 离线历史回填完成后，把同版本 V2 小时桶一次性覆盖进主存储。
  // v1 cats/txs/contracts 保持原样；V2 不与旧稀疏结果相加，避免重复计数。
  mergeV2Backfill(sourceBuckets) {
    let merged = 0;
    for (const src of sourceBuckets ?? []) {
      if (!src?.acts || src.v2v !== CLASSIFIER_V2_VER || src.v2mixed) continue;
      let dst = this.buckets.find((b) => b.t === src.t);
      if (!dst) {
        dst = { t: src.t, blocks: 0, txs: 0, cats: {}, contracts: {} };
        this.buckets.push(dst);
      }
      dst.acts = structuredClone(src.acts);
      dst.v2Txs = src.v2Txs ?? src.txs ?? 0;
      delete dst.parts; // Bot/MEV participants 口径已退出,不把回填快照里的旧命中带入正式 API
      dst.assets = structuredClone(src.assets ?? {});
      dst.flows = structuredClone(src.flows ?? {});
      dst.qual = structuredClone(src.qual ?? { failed: 0, rcptMiss: 0 });
      if (src.segments && src.trafficV === TRAFFIC_SCHEMA_VER && !src.trafficMixed) {
        dst.segments = structuredClone(src.segments);
        dst.protocols = structuredClone(src.protocols ?? {});
        dst.features = structuredClone(src.features ?? {});
        dst.events = structuredClone(src.events ?? {});
        dst.senderHll = structuredClone(src.senderHll ?? {});
        for (const segment of TRAFFIC_SEGMENTS) this._senderHll.delete(`${dst.t}:${segment}`);
        dst.trafficExcluded = structuredClone(src.trafficExcluded ?? {});
        dst.contracts = structuredClone(src.contracts ?? {});
        dst.trafficV = TRAFFIC_SCHEMA_VER;
        dst.trafficTxs = src.trafficTxs ?? src.txs ?? 0;
        delete dst.trafficMixed;
      }
      dst.v2v = CLASSIFIER_V2_VER;
      delete dst.v2mixed;
      dst.v2Blocks = src.v2Blocks ?? src.blocks ?? 0;
      dst.blockRanges = structuredClone(src.blockRanges ?? []);
      dst.minBlock = src.minBlock ?? null;
      dst.maxBlock = src.maxBlock ?? null;
      dst.firstSeenAt = src.firstSeenAt ?? null;
      dst.lastSeenAt = src.lastSeenAt ?? null;
      dst.rev = (dst.rev || 0) + 1;
      merged++;
    }
    this.buckets.sort((a, b) => a.t - b.t);
    const cutoff = Date.now() - this.windowMs;
    this.buckets = this.buckets.filter((b) => b.t >= cutoff);

    // V2 累计按当前版本桶重建，避免回填覆盖后 allTime2 仍保留旧规则差量。
    this.allTime2 = { since: Date.now(), txs: 0, acts: {} };
    for (const b of this.buckets) {
      if (!b.acts || b.v2v !== CLASSIFIER_V2_VER || b.v2mixed) continue;
      this.allTime2.since = Math.min(this.allTime2.since, b.t);
      for (const [act, v] of Object.entries(b.acts)) {
        const out = (this.allTime2.acts[act] ??= { n: 0, gas: 0 });
        out.n += v.n || 0; out.gas += v.gas || 0;
        this.allTime2.txs += v.n || 0;
      }
    }
    if (merged) { this._dirty = true; this.flush(); }
    return merged;
  }

  // 是否存在旧版本 v2 数据(分类器/verified 表升级后重启,journal 覆盖窗口内待重放)
  needsReplay() {
    return this.buckets.some((b) => b.acts && (
      (b.v2v ?? 0) !== CLASSIFIER_V2_VER || b.firstSeenAt == null || b.lastSeenAt == null
    )) || this.buckets.some((b) => b.acts && (
      !b.segments || (b.trafficV ?? 0) !== TRAFFIC_SCHEMA_VER || b.firstSeenAt == null || b.lastSeenAt == null
    ));
  }

  // 从 FactJournal 重放,重算窗口内各小时桶的 v2 维度并差量修正 allTime2。
  // v1(cats/txs/contracts)不重放；journal 与桶笔数不严格一致、当前小时或 replay 期间变化的桶一律跳过。
  async replayV2(journal, labelBook, classifyFn) {
    const cov = journal.coverage();
    if (!cov) return { replaced: 0, skipped: 0, facts: 0 };
    const agg = new Map();
    const revisions = new Map(this.buckets.map((b) => [b.t, b.rev || 0]));
    const seen = new Set();
    const facts = await journal.replay(cov.fromMs, cov.toMs, (f) => {
      const id = `${f.b}:${f.i}`;
      if (seen.has(id)) return;
      seen.add(id);
      const v2 = classifyFn(f, labelBook);
      const hk = Math.floor(f.t / HOUR);
      let a = agg.get(hk);
      if (!a) agg.set(hk, (a = {
        txs: 0, acts: {}, assets: {}, flows: {}, qual: { failed: 0, rcptMiss: 0 },
        segments: {}, protocols: {}, features: {}, events: {}, contracts: {}, trafficExcluded: {}, senderRegisters: {},
        firstSeenAt: f.t, lastSeenAt: f.t,
      }));
      a.firstSeenAt = Math.min(a.firstSeenAt, f.t);
      a.lastSeenAt = Math.max(a.lastSeenAt, f.t);
      a.txs++;
      const e = (a.acts[v2.act] ??= { n: 0, gas: 0 });
      e.n++; e.gas += f.rc && Number.isFinite(f.g) ? f.g : 0;
      for (const s of v2.assets) a.assets[s] = (a.assets[s] || 0) + 1;
      for (const fl of v2.flows) a.flows[fl] = (a.flows[fl] || 0) + 1;
      if (v2.fail) a.qual.failed++;
      if (v2.rcptMiss) a.qual.rcptMiss++;
      if (v2.excluded) a.trafficExcluded[v2.excluded] = (a.trafficExcluded[v2.excluded] || 0) + 1;
      if (v2.segment) {
        const se = (a.segments[v2.segment] ??= { n: 0, gas: 0, failed: 0, gasSamples: [] });
        se.n++; se.gas += f.rc && Number.isFinite(f.g) ? f.g : 0; if (v2.failed) se.failed++;
        if (Number.isFinite(f.g)) {
          if (se.gasSamples.length < 128) se.gasSamples.push(f.g);
          else {
            const j = Math.floor(Math.random() * se.n);
            if (j < se.gasSamples.length) se.gasSamples[j] = f.g;
          }
        }
        hllAdd((a.senderRegisters[v2.segment] ??= new Uint8Array(HLL_M)), f.f);
        if (v2.protocol) {
          const protocolKey = `${v2.segment}:${v2.protocol}`;
          const pe = (a.protocols[protocolKey] ??= { protocol: v2.protocol, n: 0, gas: 0, failed: 0, segment: v2.segment });
          pe.n++; pe.gas += f.rc && Number.isFinite(f.g) ? f.g : 0; if (v2.failed) pe.failed++;
        }
        if (f.sw > 0) a.features.swap = (a.features.swap || 0) + 1;
        if (f.xf > 0) a.features.transfer = (a.features.transfer || 0) + 1;
        if (f.ap > 0) a.features.approval = (a.features.approval || 0) + 1;
        if (f.nft > 0) a.features.nft = (a.features.nft || 0) + 1;
        if (f.mt > 0) a.features.erc1155 = (a.features.erc1155 || 0) + 1;
        const seenTopics = new Set();
        for (const [emitter, topic] of f.ev ?? []) {
          if (!topic || seenTopics.has(topic)) continue;
          seenTopics.add(topic);
          const event = (a.events[topic] ??= { n: 0, emitters: {} });
          event.n++;
          if (emitter && (event.emitters[emitter] != null || Object.keys(event.emitters).length < 16)) {
            event.emitters[emitter] = (event.emitters[emitter] || 0) + 1;
          }
        }
      }
      if (f.o && v2.segment && v2.segment !== "native_transfer" && v2.segment !== "builder_payment") {
        const ct = (a.contracts[f.o] ??= {
          n: 0, gas: 0, failed: 0, segment: v2.segment || "other_call",
          protocol: v2.protocol || null, role: v2.contractRole || null, sels: {}, methodStats: {}, swap: 0, xfer: 0,
        });
        ct.n++; ct.gas += f.rc && Number.isFinite(f.g) ? f.g : 0; if (v2.failed) ct.failed++;
        if (f.s) {
          ct.sels[f.s] = (ct.sels[f.s] || 0) + 1;
          const ms = (ct.methodStats[f.s] ??= { n: 0, gas: 0, failed: 0, samples: [], txs: [], action: v2.businessAction || null });
          if (v2.businessAction) ms.action = v2.businessAction;
          ms.n++; ms.gas += f.rc && Number.isFinite(f.g) ? f.g : 0; if (v2.failed) ms.failed++;
          if (Number.isFinite(f.g) && ms.samples.length < 24) ms.samples.push(f.g);
          if (f.h && ms.txs.length < 3 && !ms.txs.includes(f.h)) ms.txs.push(f.h);
        }
        ct.swap += f.sw || 0; ct.xfer += f.xf || 0;
      }
    });
    let replaced = 0, skipped = 0;
    const currentHour = Math.floor(Date.now() / HOUR) * HOUR;
    for (const [hk, a] of agg) {
      const b = this.buckets.find((x) => x.t === hk * HOUR);
      if (!b) { skipped++; continue; }
      // 当前小时未封口；rev 变化说明 replay 期间 sampler 仍在写这个桶。两者都不可覆盖。
      if (b.t >= currentHour || (b.rev || 0) !== (revisions.get(b.t) || 0)) { skipped++; continue; }
      // 事实日志必须与桶严格一致；宁可保留旧版本，也不能用残缺/重复 journal 覆盖。
      const expectedFacts = b.trafficTxs ?? b.v2Txs ?? b.txs;
      if (a.txs !== expectedFacts) { skipped++; continue; }
      const keys = new Set([...Object.keys(b.acts ?? {}), ...Object.keys(a.acts)]);
      for (const k of keys) {
        const oldE = b.acts?.[k], newE = a.acts[k];
        const at = (this.allTime2.acts[k] ??= { n: 0, gas: 0 });
        at.n += (newE?.n || 0) - (oldE?.n || 0);
        at.gas += (newE?.gas || 0) - (oldE?.gas || 0);
        this.allTime2.txs += (newE?.n || 0) - (oldE?.n || 0);
      }
      b.acts = a.acts; delete b.parts; b.assets = a.assets; b.flows = a.flows; b.qual = a.qual;
      b.segments = a.segments; b.protocols = a.protocols; b.features = a.features; b.events = a.events; b.contracts = a.contracts;
      b.trafficExcluded = a.trafficExcluded;
      b.v2Txs = a.txs; b.trafficTxs = a.txs;
      b.senderHll = Object.fromEntries(Object.entries(a.senderRegisters).map(([segment, registers]) => [segment, hllEncode(registers)]));
      for (const segment of TRAFFIC_SEGMENTS) this._senderHll.delete(`${b.t}:${segment}`);
      b.trafficV = TRAFFIC_SCHEMA_VER; delete b.trafficMixed;
      b.firstSeenAt = a.firstSeenAt; b.lastSeenAt = a.lastSeenAt;
      b.v2v = CLASSIFIER_V2_VER; delete b.v2mixed;
      b.rev = (b.rev || 0) + 1;
      replaced++;
    }
    if (replaced) { this._dirty = true; this.flush(); }
    return { replaced, skipped, facts };
  }

  // Hot "other" contracts over recent hours — AI labeling candidates.
  // learned cat="other" 不排除:带着新特征让 AI 重新评估。
  unknownHot(labelBook, hours = 24, top = 30) {
    const cutoff = Date.now() - hours * HOUR;
    const agg = {};
    for (const b of this.buckets) {
      if (b.t < cutoff) continue;
      for (const [addr, c] of Object.entries(b.contracts)) {
        const l = labelBook.get(addr);
        if (c.cat !== "other" || (l && l.cat !== "other")) continue;
        const a = (agg[addr] ??= { addr, n: 0, gas: 0, sels: {}, swap: 0, xfer: 0 });
        a.n += c.n; a.gas += c.gas;
        a.swap += c.swap || 0; a.xfer += c.xfer || 0;
        for (const [s, k] of Object.entries(c.sels ?? {})) a.sels[s] = (a.sels[s] || 0) + k;
      }
    }
    return Object.values(agg).sort((a, b) => b.n - a.n).slice(0, top)
      .map((a) => ({
        addr: a.addr, n: a.n, gas: a.gas, swapLogs: a.swap, transferLogs: a.xfer,
        topSelectors: Object.entries(a.sels).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([s, k]) => `${s}×${k}`),
      }));
  }

  // Top gas 消耗合约(流量子系统):窗口内按 gasUsed 聚合排名,share 以窗口总 gas 为分母。
  // gas 为 receipts 的真实 gasUsed;桶 7d 滚动,数据自部署起积累。
  topGasContracts(labelBook, days = 1, top = 12) {
    const cutoff = Date.now() - Math.min(Math.max(Number(days) || 1, 1), 7) * 24 * HOUR;
    const agg = {}; let totalGas = 0;
    for (const b of this.buckets) {
      if (b.t < cutoff) continue;
      for (const c of Object.values(b.cats ?? {})) totalGas += c.gas || 0;
      for (const [addr, c] of Object.entries(b.contracts ?? {})) {
        const a = (agg[addr] ??= { addr, n: 0, gas: 0, cat: c.cat });
        a.n += c.n; a.gas += c.gas || 0;
        if (c.cat && c.cat !== "other") a.cat = c.cat;
      }
    }
    const rows = Object.values(agg).sort((a, b) => b.gas - a.gas).slice(0, top).map((a) => {
      const l = labelBook?.get?.(a.addr);
      return {
        addr: a.addr,
        name: l?.name ?? null,
        cat: l?.cat ?? a.cat ?? "other",
        txs: a.n,
        gas: a.gas,
        sharePct: totalGas ? +((a.gas / totalGas) * 100).toFixed(1) : null,
      };
    });
    return { days: Math.min(Math.max(Number(days) || 1, 1), 7), totalGas, rows };
  }

  // 指定时间范围内的合约 gas 聚合(大流量事件归因):范围覆盖的小时桶合并,top N
  contractsInRange(labelBook, fromMs, toMs, top = 6) {
    const agg = {}; let totalGas = 0, buckets = 0;
    for (const b of this.buckets) {
      if (b.t < fromMs - HOUR || b.t >= toMs) continue;   // 事件起点所在小时也算入
      buckets++;
      for (const c of Object.values(b.cats ?? {})) totalGas += c.gas || 0;
      for (const [addr, c] of Object.entries(b.contracts ?? {})) {
        const a = (agg[addr] ??= { addr, n: 0, gas: 0, cat: c.cat });
        a.n += c.n; a.gas += c.gas || 0;
        if (c.cat && c.cat !== "other") a.cat = c.cat;
      }
    }
    if (!buckets) return null;   // 范围超出 7d 桶窗口
    const rows = Object.values(agg).sort((a, b) => b.gas - a.gas).slice(0, top).map((a) => {
      const l = labelBook?.get?.(a.addr);
      return { addr: a.addr, name: l?.name ?? null, cat: l?.cat ?? a.cat ?? "other", txs: a.n, sharePct: totalGas ? +((a.gas / totalGas) * 100).toFixed(1) : null };
    });
    return { rows, source: "store" };
  }

  // Gas price 水位线:实线 p50 = 块中位价的小时中位(常规价,天然平稳);
  // 虚线 p90 = 块内 p90 高价单的小时 p90(MEV 抢跑/拥堵时先动的信号)
  gasPriceTrend(days = 1) {
    const cutoff = Date.now() - Math.min(Math.max(Number(days) || 1, 1), 7) * 24 * HOUR;
    const times = [], p50 = [], p90 = [];
    for (const b of this.buckets) {
      if (b.t < cutoff || !b.gp?.length) continue;
      const s = [...b.gp].sort((x, y) => x - y);
      times.push(b.t);
      p50.push(+s[Math.floor(s.length * 0.5)].toFixed(3));
      if (b.gp90?.length) {
        const s9 = [...b.gp90].sort((x, y) => x - y);
        p90.push(+s9[Math.min(Math.floor(s9.length * 0.9), s9.length - 1)].toFixed(3));
      } else {
        p90.push(+s[Math.min(Math.floor(s.length * 0.9), s.length - 1)].toFixed(3));
      }
    }
    return { times, p50, p90 };
  }

  // 交易类型 gas 份额趋势:每小时各类 gas 占比 %(分母为该小时总 gas)
  catTrend(days = 1) {
    const cutoff = Date.now() - Math.min(Math.max(Number(days) || 1, 1), 7) * 24 * HOUR;
    const rows = this.buckets.filter((b) => b.t >= cutoff && b.txs > 0);
    // 按窗口内 gas 总量选 top 5 类,其余合并为 other
    const totals = {};
    for (const b of rows) for (const [c, v] of Object.entries(b.cats ?? {})) totals[c] = (totals[c] || 0) + (v.gas || 0);
    const topCats = Object.entries(totals).sort((a, x) => x[1] - a[1]).slice(0, 5).map(([c]) => c);
    const times = [], series = Object.fromEntries([...topCats, "rest"].map((c) => [c, []]));
    for (const b of rows) {
      const total = Object.values(b.cats ?? {}).reduce((s, v) => s + (v.gas || 0), 0) || 1;
      times.push(b.t);
      let covered = 0;
      for (const c of topCats) {
        const pct = +(((b.cats?.[c]?.gas || 0) / total) * 100).toFixed(1);
        series[c].push(pct); covered += pct;
      }
      series.rest.push(+Math.max(0, 100 - covered).toFixed(1));
    }
    return { times, cats: topCats, series };
  }

  // windowDays:分类分布统计窗口(1/3/7 天);趋势图与热门合约固定 24h
  view(labelBook, windowDays = 1, hotDays = 1) {
    const now = Date.now();
    const winMs = Math.min(Math.max(Number(windowDays) || 1, 1), 30) * 24 * HOUR;
    // 7d daily rollup(维持 7 天口径:图表与环比语义不随 30d 存储窗口改变)
    const days = {};
    for (const b of this.buckets.filter((x) => x.t >= now - 7 * 24 * HOUR)) {
      const d = new Date(b.t);
      const key = `${d.getMonth() + 1}/${d.getDate()}`;
      const day = (days[key] ??= { day: key, t: b.t, blocks: 0, txs: 0, cats: {} });
      day.blocks += b.blocks; day.txs += b.txs;
      for (const [cat, v] of Object.entries(b.cats)) {
        const c = (day.cats[cat] ??= { n: 0, gas: 0 });
        c.n += v.n; c.gas += v.gas;
      }
    }
    // 24h hourly series (tx counts per cat)
    const h24 = this.buckets.filter((b) => b.t >= now - 24 * HOUR)
      .map((b) => ({ t: b.t, txs: b.txs, cats: Object.fromEntries(CATS.map((c) => [c, b.cats[c]?.n ?? 0])) }));
    // today's top contracts (24h) — 带证据字段(swap/transfer/topSel)供前端生成"依据"
    const hotMs = Math.min(Math.max(Number(hotDays) || 1, 1), 30) * 24 * HOUR;
    const agg = {};
    for (const b of this.buckets) {
      if (b.t < now - hotMs) continue;
      for (const [addr, c] of Object.entries(b.contracts)) {
        const a = (agg[addr] ??= { addr, n: 0, gas: 0, cat: c.cat, swap: 0, xfer: 0, sels: {} });
        a.n += c.n; a.gas += c.gas; a.swap += c.swap || 0; a.xfer += c.xfer || 0;
        for (const [s, k] of Object.entries(c.sels ?? {})) a.sels[s] = (a.sels[s] || 0) + k;
      }
    }
    const topContracts = Object.values(agg).sort((a, b) => b.n - a.n).slice(0, 15)
      .map((c) => {
        const l = labelBook.get(c.addr);
        const topSel = Object.entries(c.sels).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
        return { addr: c.addr, n: c.n, gas: c.gas, swap: c.swap, xfer: c.xfer, topSel, name: l?.name ?? null, cat: l?.cat ?? c.cat, ai: l?.ai ?? false };
      });
    // 分布统计按所选窗口聚合(字段名沿用 *24,窗口见 windowDays)
    const bWin = this.buckets.filter((b) => b.t >= now - winMs);
    const total24 = bWin.reduce((s, b) => s + b.txs, 0);
    const catTotals = {};
    const catGas = {}; let gasTotal = 0;
    for (const b of bWin) {
      for (const [c, v] of Object.entries(b.cats)) {
        catTotals[c] = (catTotals[c] ?? 0) + (v.n || 0);
        catGas[c] = (catGas[c] ?? 0) + (v.gas || 0); gasTotal += (v.gas || 0);
      }
    }
    // v2 多维窗口聚合(旧桶无这些字段,自 v2 上线的桶起有值)
    // 当前分类器版本的连续尾段。存在小时缺口时，缺口之前的数据不能冒充“最近 N 天”。
    const currentV2 = this.buckets
      .filter((b) => b.acts && b.v2v === CLASSIFIER_V2_VER && !b.v2mixed && b.firstSeenAt != null && b.lastSeenAt != null)
      .sort((a, b) => a.t - b.t);
    let continuousSince = null, latestV2 = currentV2.at(-1)?.t ?? null;
    if (latestV2 != null) {
      continuousSince = latestV2;
      for (let i = currentV2.length - 2; i >= 0; i--) {
        if (currentV2[i + 1].t - currentV2[i].t !== HOUR) break;
        continuousSince = currentV2[i].t;
      }
    }
    const firstV2 = continuousSince == null ? null : currentV2.find((b) => b.t === continuousSince);
    const lastV2 = latestV2 == null ? null : currentV2.find((b) => b.t === latestV2);
    const preciseTimeCoverage = !!(firstV2?.firstSeenAt && lastV2?.lastSeenAt);
    // 首尾小时都可能是部分桶，覆盖时长必须按真实块时间计算，不能把两个部分桶各算满一小时。
    const continuousHours = preciseTimeCoverage
      ? Math.max(0, (lastV2.lastSeenAt - firstV2.firstSeenAt) / HOUR)
      : 0;
    const requestedHours = winMs / HOUR;
    const dimBuckets = currentV2.filter((b) => b.t >= now - winMs && b.t >= continuousSince);
    const dim = {
      acts: {}, assets: {}, flows: {}, qual: { failed: 0, rcptMiss: 0 },
      total: 0, since: null,
      meta: {
        requestedDays: winMs / (24 * HOUR), requestedHours,
        availableContinuousHours: continuousHours,
        effectiveHours: Math.min(requestedHours, continuousHours),
        latestBucketAt: latestV2,
        blocks: 0, trackedBlocks: 0, minBlock: null, maxBlock: null,
        classifierVersions: [], excludedStaleBuckets: 0, excludedGapBuckets: 0, excludedImpreciseBuckets: 0, excludedVersions: [],
        preciseTimeCoverage,
      },
      denominators: {},
    };
    const dimVers = new Set(), staleVers = new Set();
    for (const b of bWin) {
      if (!b.acts) continue;
      if (b.v2v !== CLASSIFIER_V2_VER || b.v2mixed) {
        dim.meta.excludedStaleBuckets++;
        if (b.v2v != null && b.v2v !== CLASSIFIER_V2_VER) staleVers.add(b.v2v);
      } else if (b.firstSeenAt == null || b.lastSeenAt == null) {
        dim.meta.excludedImpreciseBuckets++;
      } else if (b.t < continuousSince) dim.meta.excludedGapBuckets++;
    }
    for (const b of dimBuckets) {
      dim.since ??= b.t;
      dim.meta.blocks += b.blocks || 0;
      if (b.minBlock != null && b.maxBlock != null) {
        dim.meta.trackedBlocks += b.v2Blocks ?? b.blocks ?? 0;
        dim.meta.minBlock = dim.meta.minBlock == null ? b.minBlock : Math.min(dim.meta.minBlock, b.minBlock);
        dim.meta.maxBlock = dim.meta.maxBlock == null ? b.maxBlock : Math.max(dim.meta.maxBlock, b.maxBlock);
      }
      if (b.v2v != null) dimVers.add(b.v2v);
      for (const [k, v] of Object.entries(b.acts)) {
        const e = (dim.acts[k] ??= { n: 0, gas: 0 });
        e.n += v.n || 0; e.gas += v.gas || 0; dim.total += v.n || 0;
      }
      for (const [k, v] of Object.entries(b.assets ?? {})) dim.assets[k] = (dim.assets[k] || 0) + v;
      for (const [k, v] of Object.entries(b.flows ?? {})) dim.flows[k] = (dim.flows[k] || 0) + v;
      if (b.qual) { dim.qual.failed += b.qual.failed || 0; dim.qual.rcptMiss += b.qual.rcptMiss || 0; }
    }
    const sysN = dim.acts.system?.n || 0;
    dim.denominators = {
      allTx: dim.total,
      businessTx: Math.max(0, dim.total - sysN),
      knownGasTx: Math.max(0, dim.total - dim.qual.rcptMiss),
      receiptKnownTx: Math.max(0, dim.total - dim.qual.rcptMiss),
    };
    dim.meta.classifierVersions = [...dimVers].sort((a, b) => a - b);
    dim.meta.excludedVersions = [...staleVers].sort((a, b) => a - b);
    dim.meta.freshnessHours = lastV2?.lastSeenAt == null ? null : Math.max(0, (now - lastV2.lastSeenAt) / HOUR);
    dim.meta.windowCoveragePct = requestedHours
      ? +Math.min(100, (100 * continuousHours) / requestedHours).toFixed(2)
      : 0;
    if (dim.meta.minBlock != null && dim.meta.maxBlock != null) {
      dim.meta.expectedBlocks = dim.meta.maxBlock - dim.meta.minBlock + 1;
      dim.meta.gapBlocks = Math.max(0, dim.meta.expectedBlocks - dim.meta.trackedBlocks);
      dim.meta.coveragePct = dim.meta.expectedBlocks
        ? +Math.min(100, (100 * dim.meta.trackedBlocks) / dim.meta.expectedBlocks).toFixed(2)
        : null;
    } else {
      dim.meta.expectedBlocks = null;
      dim.meta.gapBlocks = null;
      dim.meta.coveragePct = null;
    }
    dim.meta.windowReady = continuousHours >= requestedHours
      && (dim.meta.freshnessHours ?? Infinity) < 1
      && (dim.meta.coveragePct == null || dim.meta.coveragePct >= 99.9);

    // Primary traffic view (one segment per transaction). It has its own
    // version/continuity boundary and never mixes legacy categories.
    const trafficVersionBuckets = this.buckets
      .filter((b) => b.segments && b.trafficV === TRAFFIC_SCHEMA_VER && !b.trafficMixed && b.firstSeenAt != null && b.lastSeenAt != null)
      .sort((a, b) => a.t - b.t);
    let trafficSince = null;
    const trafficLatest = trafficVersionBuckets.at(-1)?.t ?? null;
    if (trafficLatest != null) {
      trafficSince = trafficLatest;
      for (let i = trafficVersionBuckets.length - 2; i >= 0; i--) {
        if (trafficVersionBuckets[i + 1].t - trafficVersionBuckets[i].t !== HOUR) break;
        trafficSince = trafficVersionBuckets[i].t;
      }
    }
    const trafficFirst = trafficVersionBuckets.find((b) => b.t === trafficSince);
    const trafficLast = trafficVersionBuckets.find((b) => b.t === trafficLatest);
    const trafficHours = trafficFirst && trafficLast
      ? Math.max(0, (trafficLast.lastSeenAt - trafficFirst.firstSeenAt) / HOUR)
      : 0;
    const trafficBuckets = trafficVersionBuckets.filter((b) => b.t >= now - winMs && b.t >= trafficSince);
    const traffic = {
      version: TRAFFIC_SCHEMA_VER,
      total: 0, gas: 0, segments: {}, protocols: [], contracts: [], methods: [], events: [],
      failure: { total: 0, ratePct: 0, methods: [] },
      gasAnalysis: { methods: [] },
      emerging: { newContracts: [], unknownCalls: [] },
      features: {},
      meta: {
        requestedHours, availableContinuousHours: trafficHours,
        effectiveHours: Math.min(requestedHours, trafficHours), excludedSystem: 0,
        blocks: 0, trackedBlocks: 0, minBlock: null, maxBlock: null,
        windowReady: false,
        since: trafficFirst?.firstSeenAt ?? null, latestAt: trafficLast?.lastSeenAt ?? null,
      },
    };
    const contractAgg = {};
    const eventAgg = {};
    const protocolAgg = {};
    for (const b of trafficBuckets) {
      traffic.meta.excludedSystem += b.trafficExcluded?.system || 0;
      traffic.meta.blocks += b.blocks || 0;
      if (b.minBlock != null && b.maxBlock != null) {
        traffic.meta.trackedBlocks += b.v2Blocks ?? b.blocks ?? 0;
        traffic.meta.minBlock = traffic.meta.minBlock == null ? b.minBlock : Math.min(traffic.meta.minBlock, b.minBlock);
        traffic.meta.maxBlock = traffic.meta.maxBlock == null ? b.maxBlock : Math.max(traffic.meta.maxBlock, b.maxBlock);
      }
      for (const [segment, row] of Object.entries(b.segments ?? {})) {
        const out = (traffic.segments[segment] ??= { n: 0, gas: 0, failed: 0, gasSamples: [] });
        out.n += row.n || 0; out.gas += row.gas || 0; out.failed += row.failed || 0;
        if (row.gasSamples?.length) {
          const weight = Math.max(1, row.n || row.gasSamples.length) / row.gasSamples.length;
          out.gasSamples.push(...row.gasSamples.map((value) => [value, weight]));
        }
        traffic.total += row.n || 0; traffic.gas += row.gas || 0; traffic.failure.total += row.failed || 0;
      }
      for (const [feature, n] of Object.entries(b.features ?? {})) traffic.features[feature] = (traffic.features[feature] || 0) + n;
      for (const [storedKey, row] of Object.entries(b.protocols ?? {})) {
        const protocol = row.protocol || storedKey;
        const key = `${row.segment || "other_call"}:${protocol}`;
        const out = (protocolAgg[key] ??= { protocol, n: 0, gas: 0, failed: 0, segment: row.segment, contractAddresses: new Set() });
        out.n += row.n || 0; out.gas += row.gas || 0; out.failed += row.failed || 0;
        if (row.segment) out.segment = row.segment;
      }
      for (const [topic, row] of Object.entries(b.events ?? {})) {
        const out = (eventAgg[topic] ??= { topic, n: 0, emitters: {} });
        out.n += row.n || 0;
        for (const [addr, n] of Object.entries(row.emitters ?? {})) out.emitters[addr] = (out.emitters[addr] || 0) + n;
      }
      for (const [addr, row] of Object.entries(b.contracts ?? {})) {
        const out = (contractAgg[addr] ??= {
          addr, n: 0, gas: 0, failed: 0, segment: row.segment || "other_call",
          protocol: row.protocol || null, role: row.role || null, sels: {}, firstSeenAt: b.t,
        });
        out.n += row.n || 0; out.gas += row.gas || 0; out.failed += row.failed || 0;
        out.firstSeenAt = Math.min(out.firstSeenAt, b.t);
        if (row.segment && (out.segment === "other_call" || row.segment !== "other_call")) out.segment = row.segment;
        if (row.protocol) out.protocol = row.protocol;
        if (row.role) out.role = row.role;
        const methodStats = row.methodStats ?? Object.fromEntries(Object.entries(row.sels ?? {}).map(([s, n]) => [s, { n, gas: 0, failed: 0, samples: [], txs: [] }]));
        for (const [sel, ms] of Object.entries(methodStats)) {
          const sm = (out.sels[sel] ??= { n: 0, gas: 0, failed: 0, samples: [], txs: [], action: ms.action || null });
          sm.n += ms.n || 0; sm.gas += ms.gas || 0; sm.failed += ms.failed || 0;
          if (ms.action) sm.action = ms.action;
          if (ms.samples?.length) sm.samples.push(...ms.samples.slice(0, Math.max(0, 64 - sm.samples.length)));
          if (ms.txs?.length) for (const h of ms.txs) if (sm.txs.length < 3 && !sm.txs.includes(h)) sm.txs.push(h);
        }
      }
    }
    traffic.failure.ratePct = traffic.total ? +((100 * traffic.failure.total) / traffic.total).toFixed(2) : 0;
    traffic.failure.successPct = traffic.total ? +(100 - traffic.failure.ratePct).toFixed(2) : 0;
    for (const [segment, row] of Object.entries(traffic.segments)) {
      row.pct = traffic.total ? +((100 * row.n) / traffic.total).toFixed(1) : 0;
      row.gasPct = traffic.gas ? +((100 * row.gas) / traffic.gas).toFixed(1) : 0;
      row.failurePct = row.n ? +((100 * row.failed) / row.n).toFixed(2) : 0;
      row.successPct = row.n ? +(100 - row.failurePct).toFixed(2) : 0;
      row.p50Gas = weightedPercentile(row.gasSamples, .5);
      row.p95Gas = weightedPercentile(row.gasSamples, .95);
      row.activeSendersEst = this._senderEstimate(trafficBuckets, segment);
      delete row.gasSamples;
    }
    const methodRows = [];
    for (const c of Object.values(contractAgg)) {
      const identity = labelBook.get(c.addr);
      c.name = identity?.name ?? null;
      c.failurePct = c.n ? +((100 * c.failed) / c.n).toFixed(2) : 0;
      c.avgGas = c.n ? Math.round(c.gas / c.n) : 0;
      if (c.protocol) {
        const key = `${c.segment}:${c.protocol}`;
        const p = (protocolAgg[key] ??= { protocol: c.protocol, n: c.n, gas: c.gas, failed: c.failed, segment: c.segment, contractAddresses: new Set() });
        p.contractAddresses.add(c.addr);
      }
      for (const [selector, ms] of Object.entries(c.sels)) {
        methodRows.push({
          addr: c.addr, contract: c.name, selector, protocol: c.protocol, role: c.role, segment: c.segment,
          n: ms.n, gas: ms.gas, failed: ms.failed,
          action: ms.action || null,
          failurePct: ms.n ? +((100 * ms.failed) / ms.n).toFixed(2) : 0,
          avgGas: ms.n ? Math.round(ms.gas / ms.n) : 0,
          p50Gas: percentile(ms.samples, .5), p95Gas: percentile(ms.samples, .95),
          samples: ms.txs ?? [],
        });
      }
    }
    traffic.protocols = Object.values(protocolAgg).map(({ contractAddresses, ...p }) => ({
      ...p, contracts: contractAddresses.size,
      pct: traffic.total ? +((100 * p.n) / traffic.total).toFixed(1) : 0,
      failurePct: p.n ? +((100 * p.failed) / p.n).toFixed(2) : 0,
    })).sort((a, b) => b.n - a.n).slice(0, 20);
    traffic.contracts = Object.values(contractAgg).sort((a, b) => b.n - a.n).slice(0, 30);
    traffic.methods = [...methodRows].sort((a, b) => b.n - a.n).slice(0, 40);
    traffic.events = Object.values(eventAgg).map((row) => ({
      topic: row.topic, n: row.n,
      topEmitter: Object.entries(row.emitters).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      emitterCount: Object.keys(row.emitters).length,
    })).sort((a, b) => b.n - a.n).slice(0, 40);
    traffic.failure.methods = methodRows.filter((m) => m.failed > 0).sort((a, b) => b.failed - a.failed).slice(0, 20);
    traffic.gasAnalysis.methods = [...methodRows].sort((a, b) => b.gas - a.gas).slice(0, 20);

    const priorContractSet = new Set();
    const priorEventSet = new Set();
    for (const b of trafficVersionBuckets) {
      if (b.t < now - winMs && b.t >= now - 2 * winMs) {
        for (const addr of Object.keys(b.contracts ?? {})) priorContractSet.add(addr);
        for (const topic of Object.keys(b.events ?? {})) priorEventSet.add(topic);
      }
    }
    const compareReady = !!trafficFirst && trafficFirst.firstSeenAt <= now - 2 * winMs;
    traffic.meta.compareReady = compareReady;
    traffic.emerging.newContracts = compareReady ? Object.values(contractAgg)
      .filter((c) => !priorContractSet.has(c.addr))
      .sort((a, b) => b.n - a.n).slice(0, 20) : [];
    traffic.emerging.newEvents = compareReady ? traffic.events.filter((e) => !priorEventSet.has(e.topic)).slice(0, 20) : [];
    traffic.emerging.unknownCalls = methodRows
      .filter((m) => m.segment === "other_call" && !m.protocol)
      .sort((a, b) => b.n - a.n).slice(0, 30);
    const priorSegmentTotals = {};
    let priorTrafficTotal = 0;
    for (const b of trafficVersionBuckets) {
      if (b.t < now - 2 * winMs || b.t >= now - winMs) continue;
      for (const [segment, row] of Object.entries(b.segments ?? {})) {
        priorSegmentTotals[segment] = (priorSegmentTotals[segment] || 0) + (row.n || 0);
        priorTrafficTotal += row.n || 0;
      }
    }
    for (const segment of TRAFFIC_SEGMENTS) {
      const row = traffic.segments[segment];
      if (!row) continue;
      row.deltaPct = priorTrafficTotal && traffic.total
        ? +(row.pct - (100 * (priorSegmentTotals[segment] || 0)) / priorTrafficTotal).toFixed(1)
        : null;
    }
    if (traffic.meta.minBlock != null && traffic.meta.maxBlock != null) {
      traffic.meta.expectedBlocks = traffic.meta.maxBlock - traffic.meta.minBlock + 1;
      traffic.meta.gapBlocks = Math.max(0, traffic.meta.expectedBlocks - traffic.meta.trackedBlocks);
      traffic.meta.coveragePct = traffic.meta.expectedBlocks
        ? +Math.min(100, 100 * traffic.meta.trackedBlocks / traffic.meta.expectedBlocks).toFixed(2)
        : null;
    } else {
      traffic.meta.expectedBlocks = null; traffic.meta.gapBlocks = null; traffic.meta.coveragePct = null;
    }
    traffic.meta.windowReady = trafficHours >= requestedHours
      && !!trafficLast && (now - trafficLast.lastSeenAt) < HOUR
      && (traffic.meta.coveragePct == null || traffic.meta.coveragePct >= 99.9);

    // 选择窗口与前一个等长窗口比较,避免“30d 占比”旁边展示“今日 vs 7d”。
    const prevTotals = {}, prevBuckets = this.buckets.filter((b) => b.t >= now - 2 * winMs && b.t < now - winMs);
    let prevTxs = 0;
    for (const b of prevBuckets) {
      prevTxs += b.txs || 0;
      for (const [c, v] of Object.entries(b.cats ?? {})) prevTotals[c] = (prevTotals[c] || 0) + (v.n || 0);
    }
    const catWindowDelta = Object.fromEntries(CATS.map((c) => {
      if (!total24 || !prevTxs) return [c, null];
      const cur = 100 * (catTotals[c] || 0) / total24;
      const prev = 100 * (prevTotals[c] || 0) / prevTxs;
      return [c, +(cur - prev).toFixed(1)];
    }));

    // 环比:各类 tx 占比 today vs 昨日 vs 7d 日均(排除今日 partial 日)
    const dsort = Object.values(days).sort((a, b) => a.t - b.t);
    const share = (day, c) => (day.txs ? ((day.cats[c]?.n ?? 0) / day.txs) * 100 : 0);
    const today = dsort.at(-1), yest = dsort.length >= 2 ? dsort.at(-2) : null;
    const prior = dsort.slice(0, -1);
    const catTrend = {};
    for (const c of CATS) {
      const tP = today ? share(today, c) : null;
      const yP = yest ? share(yest, c) : null;
      const aP = prior.length ? prior.reduce((s, d) => s + share(d, c), 0) / prior.length : null;
      catTrend[c] = {
        dYest: tP != null && yP != null ? +(tP - yP).toFixed(1) : null,
        dAvg7: tP != null && aP != null ? +(tP - aP).toFixed(1) : null,
      };
    }
    // 历史累计视图(自 since,持久化,重启续算)
    const atGasTotal = Object.values(this.allTime.cats).reduce((s, v) => s + (v.gas || 0), 0);
    const allTime = {
      since: this.allTime.since,
      total: this.allTime.txs,
      blocks: this.allTime.blocks,
      catCount: Object.fromEntries(CATS.map((c) => [c, this.allTime.cats[c]?.n ?? 0])),
      catPct: Object.fromEntries(CATS.map((c) => [c, this.allTime.txs ? +((100 * (this.allTime.cats[c]?.n ?? 0)) / this.allTime.txs).toFixed(1) : 0])),
      catGasPct: Object.fromEntries(CATS.map((c) => [c, atGasTotal ? +((100 * (this.allTime.cats[c]?.gas ?? 0)) / atGasTotal).toFixed(1) : 0])),
    };
    return {
      sampledSince: this.buckets[0]?.t ?? null,
      windowDays: winMs / (24 * HOUR),
      allTime,
      daily: Object.values(days),
      hourly24: h24,
      total24,
      catPct24: Object.fromEntries(CATS.map((c) => [c, total24 ? +((100 * (catTotals[c] ?? 0)) / total24).toFixed(1) : 0])),
      catCount24: Object.fromEntries(CATS.map((c) => [c, catTotals[c] ?? 0])),
      catGasPct24: Object.fromEntries(CATS.map((c) => [c, gasTotal ? +((100 * (catGas[c] ?? 0)) / gasTotal).toFixed(1) : 0])),
      catTrend,
      catWindowDelta,
      topContracts,
      learnedLabels: labelBook.learnedCount(),
      traffic,
      dim,
      allTime2: { since: this.allTime2.since, txs: this.allTime2.txs, acts: this.allTime2.acts },
    };
  }
}
