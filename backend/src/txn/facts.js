/**
 * FactJournal — 可重放分类事实日志(紧凑 TxnFact,非完整 RPC JSON)。
 *
 * 目的:分类规则/verified 地址表更新后,重放最近窗口重算 v2 维度,
 * 让 24h 面板立即恢复准确,而不是只对未来交易生效(v1 口径已冻结,不重放)。
 *
 * 存储:data/txnfacts/<hourKey>.ndjson 按小时分区追加;整点后异步 gzip 轮转,
 * 超过保留窗口整文件删除。大小随事件复杂度变化，默认只保留 24h。
 *
 * fact 字段(FACT_SCHEMA_VER=3):
 *   b 块号  i tx 序  t 毫秒时间  f from  o to(null=部署)  s selector(null=短 input)
 *   g gasUsed  st status(1/0)  rc receipt 可用(1/0)  lg 日志总数
 *   z value(hex)  il calldata bytes  sw Swap事件数  xf Transfer事件数
 *   ap Approval数  nft ERC721-like Transfer数  mt ERC1155 Transfer数
 *   ev [emitter,topic0,topicsCount] 去重事件字典(cap 16)
 *   tk Transfer 的 token 合约地址集  tf Transfer 付方集  td Transfer 收方集(各去重,cap 20)
 */

import fs from "fs";
import path from "path";
import zlib from "zlib";

export const FACT_SCHEMA_VER = 3;
const HOUR = 3600e3;
const ADDR_CAP = 20;   // 超大空投截断:仅影响极端交易的资产/资金流触达判定,统计可忽略

const T_SWAP_V2   = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const T_SWAP_V3   = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const T_TRANSFER  = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const T_APPROVAL  = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const T_ERC1155_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const T_ERC1155_BATCH  = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";

const SEL_TRANSFER = "0xa9059cbb", SEL_TRANSFER_FROM = "0x23b872dd";

// 单笔交易 → 不可变事实(qualCounts: 块内同 from 合格调用计数 Map,采集侧先算好)
export function extractFact(tx, rc, tMs, blockNum, txIndex) {
  const to = tx.to ? tx.to.toLowerCase() : null;
  const from = (tx.from || "").toLowerCase();
  const input = tx.input ?? tx.data ?? "0x";
  const sel = input.length >= 10 ? input.slice(0, 10) : null;
  let sw = 0, xf = 0, na = 0, ap = 0, nft = 0, mt = 0;
  const tk = new Set(), tf = new Set(), td = new Set();
  const ev = [];
  for (const lg of rc?.logs ?? []) {
    const t0 = lg.topics?.[0];
    if (t0 === T_SWAP_V2 || t0 === T_SWAP_V3) sw++;
    if (t0 === T_APPROVAL) ap++;
    if (t0 === T_ERC1155_SINGLE || t0 === T_ERC1155_BATCH) mt++;
    if (t0 !== T_APPROVAL) na++;
    if (t0 === T_TRANSFER) {
      xf++;
      if ((lg.topics?.length ?? 0) === 4) nft++;
      if (tk.size < ADDR_CAP && lg.address) tk.add(lg.address.toLowerCase());
      if (tf.size < ADDR_CAP && lg.topics[1]?.length === 66) tf.add("0x" + lg.topics[1].slice(26));
      if (td.size < ADDR_CAP && lg.topics[2]?.length === 66) td.add("0x" + lg.topics[2].slice(26));
    }
    // A compact, deduplicated event dictionary is enough to extend protocol
    // detectors later without retaining the full receipt payload.
    if (t0 && lg.address && ev.length < 16) {
      const row = [lg.address.toLowerCase(), t0, lg.topics?.length ?? 0];
      if (!ev.some((x) => x[0] === row[0] && x[1] === row[1] && x[2] === row[2])) ev.push(row);
    }
  }
  return {
    v: FACT_SCHEMA_VER,
    b: blockNum, i: txIndex, t: tMs, h: tx.hash ?? null, f: from, o: to, s: sel,
    z: tx.value ?? "0x0", il: Math.max(0, (input.length - 2) / 2),
    // receipt 缺失时 gasUsed/status 都是未知,不能拿 gas limit 冒充实际消耗。
    g: rc ? Number(rc.gasUsed) : null,
    st: rc ? (rc.status === "0x0" ? 0 : 1) : null,
    rc: rc ? 1 : 0,
    lg: rc?.logs?.length ?? 0,
    sw, xf, na, ap, nft, mt,
    ...(ev.length ? { ev } : {}),
    ...(tk.size ? { tk: [...tk] } : {}), ...(tf.size ? { tf: [...tf] } : {}), ...(td.size ? { td: [...td] } : {}),
  };
}

export class FactJournal {
  constructor(dir, retainHours = 24) {
    this.dir = dir;
    this.retainMs = retainHours * HOUR;
    this._buf = new Map();   // hourKey → pending lines
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }

  append(facts) {
    for (const f of facts) {
      const hk = Math.floor(f.t / HOUR);
      let arr = this._buf.get(hk);
      if (!arr) this._buf.set(hk, (arr = []));
      arr.push(JSON.stringify(f));
    }
    this.flush();
  }

  flush() {
    for (const [hk, lines] of this._buf) {
      if (!lines.length) continue;
      try { fs.appendFileSync(path.join(this.dir, `${hk}.ndjson`), lines.join("\n") + "\n"); } catch {}
    }
    this._buf.clear();
    this._rotate();
  }

  _compressSnapshot(hk, snapshot) {
    const key = String(hk);
    (this._gzipping ??= new Set()).add(key);
    fs.readFile(snapshot, (err, buf) => {
      if (err) { this._gzipping.delete(key); return; }
      zlib.gzip(buf, (e2, gz) => {
        try {
          // gzip 允许串联 member；晚到的历史小时批次可以安全追加，不覆盖旧内容。
          if (!e2) { fs.appendFileSync(path.join(this.dir, `${hk}.ndjson.gz`), gz); fs.unlinkSync(snapshot); }
        } catch {}
        this._gzipping.delete(key);
      });
    });
  }

  // 非当前小时明文先原子改名封口，再异步 gzip。后续晚到数据写入新的 plain，不会被压缩任务删掉。
  _rotate(now = Date.now()) {
    const curHk = Math.floor(now / HOUR);
    const minHk = Math.floor((now - this.retainMs) / HOUR);
    let files = [];
    try { files = fs.readdirSync(this.dir); } catch { return; }
    for (const fn of files) {
      const m = fn.match(/^(\d+)\.ndjson(?:\.gz|\.rotating-[\w-]+)?$/);
      if (!m) continue;
      const hk = +m[1];
      const full = path.join(this.dir, fn);
      if (hk < minHk) { try { fs.unlinkSync(full); } catch {} continue; }
      if (hk >= curHk || fn.endsWith(".gz") || this._gzipping?.has(String(hk))) continue;
      if (fn.includes(".rotating-")) { this._compressSnapshot(hk, full); continue; }
      const snapshot = `${full}.rotating-${process.pid}-${Date.now()}`;
      try { fs.renameSync(full, snapshot); this._compressSnapshot(hk, snapshot); } catch {}
    }
  }

  // journal 当前覆盖范围(毫秒);无数据返回 null
  coverage() {
    let files = [];
    try { files = fs.readdirSync(this.dir); } catch { return null; }
    const hks = files.map((f) => f.match(/^(\d+)\.ndjson(?:\.gz|\.rotating-[\w-]+)?$/)?.[1]).filter(Boolean).map(Number);
    if (!hks.length) return null;
    return { fromMs: Math.min(...hks) * HOUR, toMs: (Math.max(...hks) + 1) * HOUR };
  }

  // 逐文件异步迭代 [fromMs, toMs) 窗口内的 facts;onFact 逐笔回调
  async replay(fromMs, toMs, onFact) {
    const fromHk = Math.floor(fromMs / HOUR), toHk = Math.floor((toMs - 1) / HOUR);
    let n = 0;
    for (let hk = fromHk; hk <= toHk; hk++) {
      let text = "";
      try {
        const prefix = `${hk}.ndjson`;
        const files = fs.readdirSync(this.dir).filter((f) => f === prefix || f === `${prefix}.gz` || f.startsWith(`${prefix}.rotating-`));
        for (const fn of files.sort()) {
          const buf = fs.readFileSync(path.join(this.dir, fn));
          text += fn.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
        }
      } catch { continue; }
      if (!text) continue;
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const f = JSON.parse(line);
          if (f.t >= fromMs && f.t < toMs) { onFact(f); n++; }
        } catch {}
      }
      await new Promise((r) => setImmediate(r));   // 让出事件循环,避免长阻塞
    }
    return n;
  }
}
