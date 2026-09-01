/**
 * TxnSampler — every tick, fetch ALL blocks produced since the last tick
 * (~133 blocks/min at 450ms) with bounded concurrency, classify and store.
 * Persisted contiguous watermark + retry-on-gap. ~2 RPC per block.
 */

import { classifyBlock } from "./classifier.js";
import fs from "fs";
import path from "path";

const BLOCK_MS = 450;

export class TxnSampler {
  constructor({ provider, store, labelBook, journal = null, stateFile = null, intervalMs = 60_000, concurrency = 10, maxPerTick = 300 }) {
    this.provider = provider;
    this.store = store;
    this.labelBook = labelBook;
    this.journal = journal;   // FactJournal:可重放分类事实(v2 维度热更新/回滚的输入)
    this.stateFile = stateFile;
    this.intervalMs = intervalMs;
    this.concurrency = concurrency;
    this.maxPerTick = maxPerTick;   // 单批上限;有积压时连续追赶,绝不跳块
    this.lastBlock = 0;       // 仅表示连续成功抓取到的最高块,绝不跨过失败块
    this.firstBlock = 0;
    this.tip = 0;
    this.lastError = null;
    this.stateError = null;
    this._mevCand = new Map();   // 疑似 MEV 候选 from(swap trader/bot 命中),供 labelCloud 批量核查
    this._busy = false;
    try {
      if (stateFile && fs.existsSync(stateFile)) {
        const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        this.lastBlock = Number(s.lastBlock) || 0;
        this.firstBlock = Number(s.firstBlock) || this.lastBlock;
      }
    } catch { /* 无状态时从当前链头附近启动 */ }
  }

  _persistState() {
    if (!this.stateFile || !this.lastBlock) return true;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ lastBlock: this.lastBlock, firstBlock: this.firstBlock, updatedAt: Date.now() }));
      fs.renameSync(tmp, this.stateFile);
      this.stateError = null;
      return true;
    } catch (e) {
      // store 的 blockRanges 会阻止重启后的重复计数，但状态写盘失败仍需显式暴露。
      this.stateError = e?.message || "sampler state persist failed";
      return false;
    }
  }

  // 取出频次最高的 n 个 MEV 候选地址并清空累计(供周期性 labelCloud 核查)
  drainMevCandidates(n = 200) {
    const top = [...this._mevCand.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([a]) => a);
    this._mevCand.clear();
    return top;
  }

  status() {
    return {
      firstBlock: this.firstBlock || null,
      contiguousTo: this.lastBlock || null,
      tip: this.tip || null,
      backlogBlocks: this.tip && this.lastBlock ? Math.max(0, this.tip - this.lastBlock) : null,
      lastError: this.lastError,
      stateError: this.stateError,
    };
  }

  start() {
    const tick = async () => {
      try { await this.sample(); } catch (e) { console.error("[txn sampler]", e.message); }
      // 成功批次后快速追赶积压；遇失败则等常规定时器，避免对故障 RPC 紧密重试。
      if (!this.lastError && this.tip > this.lastBlock && !this._catchupTimer) {
        this._catchupTimer = setTimeout(() => { this._catchupTimer = null; tick(); }, 250);
      }
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  async sample(tipOverride = null) {
    if (this._busy) return;
    this._busy = true;
    try {
      const tip = tipOverride == null
        ? parseInt(await this.provider.send("eth_blockNumber", []), 16)
        : Number(tipOverride);
      this.tip = tip;
      if (!this.lastBlock) {
        this.lastBlock = tip - Math.round(this.intervalMs / BLOCK_MS);  // 首次部署只声明从此处开始覆盖
        this.firstBlock = this.lastBlock + 1;
        this._persistState();
      }
      let from = this.lastBlock + 1;
      if (from > tip) return;

      // 积压时从连续水位向前追,不再“保新弃旧”制造永久缺口。
      const to = Math.min(tip, from + this.maxPerTick - 1);
      const heights = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      const results = new Map();
      let next = 0;
      const worker = async () => {
        while (true) {
          const i = next++;
          if (i >= heights.length) break;
          const hex = "0x" + heights[i].toString(16);
          try {
            const [block, receipts] = await Promise.all([
              this.provider.send("eth_getBlockByNumber", [hex, true]),
              this.provider.send("eth_getBlockReceipts", [hex]).catch(() => null),
            ]);
            if (!block || !Array.isArray(block.transactions)) throw new Error("block unavailable");
            // receipt 是 Activity/Gas 的事实来源;缺整块 receipts 时宁可重试,不写入污染数据。
            if (!Array.isArray(receipts) || receipts.length !== block.transactions.length) throw new Error("receipts unavailable");
            {
              // 块级 gas price 分位(gwei):p50=常规价(1/3 交易用 0.05 默认价,天然平稳);
              // p90=高价单水位(MEV 抢跑/拥堵时先动的信号)
              const gps = block.transactions.map((tx) => Number(BigInt(tx.gasPrice ?? 0)) / 1e9).filter((v) => v > 0).sort((a, b) => a - b);
              const t = parseInt(block.timestamp, 16) * 1000;
              results.set(heights[i], {
                height: heights[i],
                t,
                classified: classifyBlock(block.transactions, receipts, this.labelBook, t, heights[i]),
                blockGp: gps.length ? +gps[Math.floor(gps.length / 2)].toFixed(3) : null,
                blockGp90: gps.length ? +gps[Math.min(Math.floor(gps.length * 0.9), gps.length - 1)].toFixed(3) : null,
              });
            }
          } catch (e) {
            results.set(heights[i], { height: heights[i], error: e?.message || "fetch failed" });
          }
        }
      };
      await Promise.all(Array.from({ length: this.concurrency }, worker));

      // 只提交从 from 开始的连续成功前缀。失败点之后即使已抓到也丢弃,下轮重抓,
      // 避免 store/journal 重复计数并保证 persisted watermark 的连续语义。
      const committed = [];
      let failure = null;
      for (const h of heights) {
        const r = results.get(h);
        if (!r || r.error) { failure = { height: h, error: r?.error || "missing result" }; break; }
        committed.push(r);
      }
      const newlyStored = [];
      for (const r of committed) {
        if (this.store.addBlock(r.t, r.classified, r.blockGp, r.blockGp90, r.height) !== false) newlyStored.push(r);
      }
      for (const r of newlyStored) for (const c of r.classified) {
        if (!c.fact || !(c.fact.sw > 0 || c.parts?.includes("bot"))) continue;
        if (this._mevCand.size >= 8000 && !this._mevCand.has(c.fact.f)) continue;
        this._mevCand.set(c.fact.f, (this._mevCand.get(c.fact.f) || 0) + 1);
      }
      this.store.flush();
      if (this.journal) {
        try { this.journal.append(newlyStored.flatMap((r) => r.classified.map((c) => c.fact).filter(Boolean))); }
        catch (e) { console.warn("[txn facts]", e.message); }
      }
      if (committed.length) {
        this.lastBlock = committed.at(-1).height;
        this._persistState();
      }
      this.lastError = failure;
      if (failure) console.warn(`[txn sampler] stopped at #${failure.height}: ${failure.error}; committed ${committed.length}/${heights.length}`);
    } catch (e) {
      this.lastError = { height: this.lastBlock ? this.lastBlock + 1 : null, error: e?.message || "sampler failed" };
      throw e;
    } finally {
      this._busy = false;
    }
  }
}
