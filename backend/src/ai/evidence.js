/**
 * Chain evidence for traffic attribution: locate blocks at a historical
 * timestamp and aggregate which contracts the transactions were hitting.
 * Approximation: tx.gasLimit as weight (receipts would cost 100s of calls).
 */

const BLOCK_MS = 450;   // BSC post-Fermi

// timestamp → height: linear estimate from tip, then refine with 2 corrections
async function blockAt(provider, tsMs) {
  const tip = await provider.getBlock("latest");
  let h = tip.number - Math.round((tip.timestamp * 1000 - tsMs) / BLOCK_MS);
  for (let i = 0; i < 3; i++) {
    h = Math.min(Math.max(h, 1), tip.number);
    const b = await provider.getBlock(h);
    if (!b) break;
    const diffMs = tsMs - b.timestamp * 1000;
    const step = Math.round(diffMs / BLOCK_MS);
    if (Math.abs(step) <= 2) break;
    h += step;
  }
  return Math.min(Math.max(h, 1), tip.number);
}

/**
 * Sample `samples` full blocks spread across [tsMs, tsMs + spanMs) and
 * aggregate per-contract tx counts + gas-limit share.
 */
export async function sampleBlockContracts(provider, tsMs, { samples = 8, spanMs = 3600_000, labelBook = null } = {}) {
  const h0 = await blockAt(provider, tsMs);
  const spanBlocks = Math.floor(spanMs / BLOCK_MS);
  const heights = Array.from({ length: samples }, (_, i) => h0 + Math.floor((i * spanBlocks) / samples));

  const blocks = (await Promise.all(heights.map((h) => provider.getBlock(h, true).catch(() => null)))).filter(Boolean);
  const agg = new Map();   // to → { txCount, gas }
  const blockRows = [];
  let totalGas = 0;
  for (const b of blocks) {
    const txs = b.prefetchedTransactions ?? [];
    blockRows.push({ number: b.number, gasUsedM: +(Number(b.gasUsed) / 1e6).toFixed(1), txCount: txs.length });
    for (const tx of txs) {
      const to = tx.to ?? "(contract creation)";
      // 系统交易(0x…1000 等)gasLimit 为天文数字,会吞掉全部份额,归因时排除
      if (to.toLowerCase().startsWith("0x000000000000000000000000000000000000")) continue;
      const g = Number(tx.gasLimit ?? 0);
      totalGas += g;
      const a = agg.get(to) ?? { to, txCount: 0, gas: 0 };
      a.txCount++; a.gas += g;
      agg.set(to, a);
    }
  }
  const top = [...agg.values()].sort((a, b) => b.gas - a.gas).slice(0, 10)
    .map((a) => {
      const l = labelBook?.get?.(a.to);
      return {
        to: a.to, txCount: a.txCount,
        gasSharePct: totalGas ? +((a.gas / totalGas) * 100).toFixed(1) : 0,
        ...(l ? { name: l.name, cat: l.cat } : {}),
      };
    });
  return { sampledBlocks: blockRows, topContracts: top, sampledTxs: blockRows.reduce((s, b) => s + b.txCount, 0) };
}
