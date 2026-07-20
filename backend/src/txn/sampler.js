/**
 * TxnSampler — every tick, fetch ALL blocks produced since the last tick
 * (~133 blocks/min at 450ms) with bounded concurrency, classify and store.
 * Full coverage, not sampling. ~2 RPC per block.
 */

import { classifyBlock } from "./classifier.js";

const BLOCK_MS = 450;

export class TxnSampler {
  constructor({ provider, store, labelBook, intervalMs = 60_000, concurrency = 10, maxPerTick = 300 }) {
    this.provider = provider;
    this.store = store;
    this.labelBook = labelBook;
    this.intervalMs = intervalMs;
    this.concurrency = concurrency;
    this.maxPerTick = maxPerTick;   // 落后超过此数直接跳到最新(保新弃旧,统计口径可容忍)
    this.lastBlock = 0;
    this._busy = false;
  }

  start() {
    const tick = () => this.sample().catch((e) => console.error("[txn sampler]", e.message));
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  async sample() {
    if (this._busy) return;
    this._busy = true;
    try {
      const tip = parseInt(await this.provider.send("eth_blockNumber", []), 16);
      if (!this.lastBlock) this.lastBlock = tip - Math.round(this.intervalMs / BLOCK_MS);  // 首轮回填一个周期
      let from = this.lastBlock + 1;
      if (tip - from + 1 > this.maxPerTick) from = tip - this.maxPerTick + 1;
      if (from > tip) return;

      const heights = Array.from({ length: tip - from + 1 }, (_, i) => from + i);
      const results = [];
      let next = 0, failed = 0;
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
            if (block?.transactions?.length) {
              // 块级 gas price 分位(gwei):p50=常规价(1/3 交易用 0.05 默认价,天然平稳);
              // p90=高价单水位(MEV 抢跑/拥堵时先动的信号)
              const gps = block.transactions.map((tx) => Number(BigInt(tx.gasPrice ?? 0)) / 1e9).filter((v) => v > 0).sort((a, b) => a - b);
              results.push({
                t: parseInt(block.timestamp, 16) * 1000,
                classified: classifyBlock(block.transactions, receipts, this.labelBook),
                blockGp: gps.length ? +gps[Math.floor(gps.length / 2)].toFixed(3) : null,
                blockGp90: gps.length ? +gps[Math.min(Math.floor(gps.length * 0.9), gps.length - 1)].toFixed(3) : null,
              });
            }
          } catch { failed++; }
        }
      };
      await Promise.all(Array.from({ length: this.concurrency }, worker));

      for (const r of results) this.store.addBlock(r.t, r.classified, r.blockGp, r.blockGp90);
      this.store.flush();
      this.lastBlock = tip;
      if (failed) console.warn(`[txn sampler] ${failed}/${heights.length} blocks failed this tick`);
    } finally {
      this._busy = false;
    }
  }
}
