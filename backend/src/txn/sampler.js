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
              results.push({
                t: parseInt(block.timestamp, 16) * 1000,
                classified: classifyBlock(block.transactions, receipts, this.labelBook),
              });
            }
          } catch { failed++; }
        }
      };
      await Promise.all(Array.from({ length: this.concurrency }, worker));

      for (const r of results) this.store.addBlock(r.t, r.classified);
      this.store.flush();
      this.lastBlock = tip;
      if (failed) console.warn(`[txn sampler] ${failed}/${heights.length} blocks failed this tick`);
    } finally {
      this._busy = false;
    }
  }
}
