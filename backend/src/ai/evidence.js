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

/**
 * 精定位「打满」块段做 gas 事件归因:在峰值时刻附近逐块扫 header.gasUsed,
 * 取包含峰值的、连续 gasUsed ≥ hotPct% 的块段(真正被打满的那十几块),
 * 只对这些块聚合 topContracts —— 区间准、归因不被大量未打满块稀释。
 * 找不到打满块返回 null,让调用方回退到时间采样。
 */
export async function sampleFullGasEvent(provider, tsMs, { hotPct = 90, window = 60, maxBlocks = 40, labelBook = null } = {}) {
  const peak = await blockAt(provider, tsMs);
  const heights = [];
  for (let h = Math.max(1, peak - window); h <= peak + window; h++) heights.push(h);
  const heads = await Promise.all(heights.map((h) =>
    provider.send("eth_getHeaderByNumber", ["0x" + h.toString(16)]).catch(() => null)));
  const rows = heads.filter(Boolean).map((hd) => {
    const gu = Number(BigInt(hd.gasUsed)), gl = Number(BigInt(hd.gasLimit));
    return { number: Number(BigInt(hd.number)), gasUsed: gu, gasLimit: gl, pct: gl ? Math.round((gu / gl) * 100) : 0 };
  });
  const full = rows.filter((r) => r.pct >= hotPct).map((r) => r.number).sort((a, b) => a - b);
  if (!full.length) return null;
  // 切成段,选包含 peak 的段;peak 不在任何段内则取最长段。
  // 容忍 ≤gapTol 块的小缺口:事件中间偶尔一个未打满块不应把打满段切断(仍算同一次事件)。
  const gapTol = 2;
  const segs = []; let cur = [full[0]];
  for (let i = 1; i < full.length; i++) {
    if (full[i] - cur[cur.length - 1] <= gapTol + 1) cur.push(full[i]);
    else { segs.push(cur); cur = [full[i]]; }
  }
  segs.push(cur);
  const seg = segs.find((s) => s[0] <= peak && peak <= s[s.length - 1]) ?? segs.sort((a, b) => b.length - a.length)[0];
  const fromBlock = seg[0], toBlock = seg[seg.length - 1];
  const pctOf = (n) => rows.find((r) => r.number === n)?.pct ?? null;

  // 对打满段(限 maxBlocks 台)拉 full txs 做合约归因
  const pick = seg.slice(0, maxBlocks);
  const blocks = (await Promise.all(pick.map((h) => provider.getBlock(h, true).catch(() => null)))).filter(Boolean);
  const agg = new Map(); const blockRows = []; let totalGas = 0;
  for (const b of blocks) {
    const txs = b.prefetchedTransactions ?? [];
    blockRows.push({ number: b.number, gasUsedM: +(Number(b.gasUsed) / 1e6).toFixed(1), pct: pctOf(b.number), txCount: txs.length });
    for (const tx of txs) {
      const to = tx.to ?? "(contract creation)";
      if (to.toLowerCase().startsWith("0x000000000000000000000000000000000000")) continue;
      const g = Number(tx.gasLimit ?? 0); totalGas += g;
      const a = agg.get(to) ?? { to, txCount: 0, gas: 0 }; a.txCount++; a.gas += g; agg.set(to, a);
    }
  }
  const top = [...agg.values()].sort((a, b) => b.gas - a.gas).slice(0, 10).map((a) => {
    const l = labelBook?.get?.(a.to);
    return { to: a.to, txCount: a.txCount, gasSharePct: totalGas ? +((a.gas / totalGas) * 100).toFixed(1) : 0, ...(l ? { name: l.name, cat: l.cat } : {}) };
  });
  return {
    fullGasRange: { from: fromBlock, to: toBlock, blocks: seg.length, hotPct, peakBlock: peak },
    sampledBlocks: blockRows, topContracts: top,
    sampledTxs: blockRows.reduce((s, b) => s + b.txCount, 0),
  };
}
