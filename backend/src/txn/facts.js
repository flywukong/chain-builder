/**
 * FactJournal — 可重放分类事实日志(紧凑 TxnFact,非完整 RPC JSON)。
 *
 * 目的:分类规则/verified 地址表更新后,重放最近窗口重算 v2 维度,
 * 让 24h 面板立即恢复准确,而不是只对未来交易生效(v1 口径已冻结,不重放)。
 *
 * 存储:data/txnfacts/<hourKey>.ndjson 按小时分区追加;整点后异步 gzip 轮转,
 * 超过保留窗口整文件删除。~400B/笔裸,gzip 后约 1~1.5GB/天,默认保留 24h。
 *
 * fact 字段(FACT_SCHEMA_VER=2):
 *   b 块号  i tx 序  t 毫秒时间  f from  o to(null=部署)  s selector(null=短 input)
 *   g gasUsed  st status(1/0)  rc receipt 可用(1/0)  lg 日志总数
 *   sw Swap 事件数  xf Transfer 事件数  na 非 Approval 日志数
 *   q  同块同 from 合格合约调用数(采集时定格,重放无需重建块上下文)
 *   tk Transfer 的 token 合约地址集  tf Transfer 付方集  td Transfer 收方集(各去重,cap 20)
 */

import fs from "fs";
import path from "path";
import zlib from "zlib";

export const FACT_SCHEMA_VER = 2;
const HOUR = 3600e3;
const ADDR_CAP = 20;   // 超大空投截断:仅影响极端交易的资产/资金流触达判定,统计可忽略

const T_SWAP_V2   = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const T_SWAP_V3   = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const T_TRANSFER  = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const T_APPROVAL  = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

const SEL_TRANSFER = "0xa9059cbb", SEL_TRANSFER_FROM = "0x23b872dd";

// 单笔交易 → 不可变事实(qualCounts: 块内同 from 合格调用计数 Map,采集侧先算好)
export function extractFact(tx, rc, tMs, blockNum, txIndex, qualCounts) {
  const to = tx.to ? tx.to.toLowerCase() : null;
  const from = (tx.from || "").toLowerCase();
  const input = tx.input ?? tx.data ?? "0x";
  const sel = input.length >= 10 ? input.slice(0, 10) : null;
  let sw = 0, xf = 0, na = 0;
  const tk = new Set(), tf = new Set(), td = new Set();
  for (const lg of rc?.logs ?? []) {
    const t0 = lg.topics?.[0];
    if (t0 === T_SWAP_V2 || t0 === T_SWAP_V3) sw++;
    if (t0 !== T_APPROVAL) na++;
    if (t0 === T_TRANSFER) {
      xf++;
      if (tk.size < ADDR_CAP && lg.address) tk.add(lg.address.toLowerCase());
      if (tf.size < ADDR_CAP && lg.topics[1]?.length === 66) tf.add("0x" + lg.topics[1].slice(26));
      if (td.size < ADDR_CAP && lg.topics[2]?.length === 66) td.add("0x" + lg.topics[2].slice(26));
    }
  }
  return {
    v: FACT_SCHEMA_VER,
    b: blockNum, i: txIndex, t: tMs, f: from, o: to, s: sel,
    // receipt 缺失时 gasUsed/status 都是未知,不能拿 gas limit 冒充实际消耗。
    g: rc ? Number(rc.gasUsed) : null,
    st: rc ? (rc.status === "0x0" ? 0 : 1) : null,
    rc: rc ? 1 : 0,
    lg: rc?.logs?.length ?? 0,
    sw, xf, na,
    q: qualCounts.get(from) || 0,
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

  // 非当前小时明文 → gzip;超保留窗删除。gzip 异步执行,完成前 iterate 仍可读明文
  _rotate(now = Date.now()) {
    const curHk = Math.floor(now / HOUR);
    const minHk = Math.floor((now - this.retainMs) / HOUR);
    let files = [];
    try { files = fs.readdirSync(this.dir); } catch { return; }
    for (const fn of files) {
      const m = fn.match(/^(\d+)\.ndjson(\.gz)?$/);
      if (!m) continue;
      const hk = +m[1];
      const full = path.join(this.dir, fn);
      if (hk < minHk) { try { fs.unlinkSync(full); } catch {} continue; }
      if (!m[2] && hk < curHk && !this._gzipping?.has(fn)) {
        (this._gzipping ??= new Set()).add(fn);
        fs.readFile(full, (err, buf) => {
          if (err) { this._gzipping.delete(fn); return; }
          zlib.gzip(buf, (e2, gz) => {
            try {
              if (!e2) { fs.writeFileSync(full + ".gz", gz); fs.unlinkSync(full); }
            } catch {}
            this._gzipping.delete(fn);
          });
        });
      }
    }
  }

  // journal 当前覆盖范围(毫秒);无数据返回 null
  coverage() {
    let files = [];
    try { files = fs.readdirSync(this.dir); } catch { return null; }
    const hks = files.map((f) => f.match(/^(\d+)\.ndjson(\.gz)?$/)?.[1]).filter(Boolean).map(Number);
    if (!hks.length) return null;
    return { fromMs: Math.min(...hks) * HOUR, toMs: (Math.max(...hks) + 1) * HOUR };
  }

  // 逐文件异步迭代 [fromMs, toMs) 窗口内的 facts;onFact 逐笔回调
  async replay(fromMs, toMs, onFact) {
    const fromHk = Math.floor(fromMs / HOUR), toHk = Math.floor((toMs - 1) / HOUR);
    let n = 0;
    for (let hk = fromHk; hk <= toHk; hk++) {
      let text = null;
      const plain = path.join(this.dir, `${hk}.ndjson`), gz = plain + ".gz";
      try {
        if (fs.existsSync(plain)) text = fs.readFileSync(plain, "utf8");
        else if (fs.existsSync(gz)) text = zlib.gunzipSync(fs.readFileSync(gz)).toString("utf8");
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
