/**
 * Per-tx classifier — rules first (free), unknown hot contracts go to the
 * AI labeling queue. cat ∈ meme|defi|bot|stable|bnb|token|cex|bridge|system|other
 *
 * Receipt-log signatures do the heavy lifting: Swap 事件 → defi,
 * Transfer-only → token;短 selector(0x000000xx)= gas-golfed MEV bot。
 */

const SEL_TRANSFER      = "0xa9059cbb";
const SEL_TRANSFER_FROM = "0x23b872dd";
const SEL_VS_DEPOSIT    = "0xf340fa01";   // ValidatorSet.deposit(address) — 系统交易

const T_SWAP_V2   = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const T_SWAP_V3   = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const T_TRANSFER  = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// BSC 系统合约(0x…1000-2005)
const SYSTEM_ADDRS = new Set([
  "0x0000000000000000000000000000000000001000", "0x0000000000000000000000000000000000001001",
  "0x0000000000000000000000000000000000001002", "0x0000000000000000000000000000000000001003",
  "0x0000000000000000000000000000000000001005", "0x0000000000000000000000000000000000001006",
  "0x0000000000000000000000000000000000001007", "0x0000000000000000000000000000000000001008",
  "0x0000000000000000000000000000000000002000", "0x0000000000000000000000000000000000002001",
  "0x0000000000000000000000000000000000002002", "0x0000000000000000000000000000000000002003",
  "0x0000000000000000000000000000000000002004", "0x0000000000000000000000000000000000002005",
]);

// Classify one block's txs. receipts aligned by index (may be null).
export function classifyBlock(txs, receipts, labelBook) {
  const fromCounts = new Map();
  for (const tx of txs) {
    const f = (tx.from || "").toLowerCase();
    fromCounts.set(f, (fromCounts.get(f) || 0) + 1);
  }

  return txs.map((tx, i) => {
    const rc = receipts?.[i] ?? null;
    const gas = rc ? Number(rc.gasUsed) : Number(tx.gas ?? 0);
    const feat = logFeatures(rc);
    return {
      cat: classifyTx(tx, rc, labelBook, fromCounts, feat),
      gas,
      to: (tx.to || "").toLowerCase(),
      sel: (tx.input ?? "0x").slice(0, 10),
      swap: feat.swap, xfer: feat.transfer,
    };
  });
}

function logFeatures(rc) {
  let swap = 0, transfer = 0;
  for (const lg of rc?.logs ?? []) {
    const t0 = lg.topics?.[0];
    if (t0 === T_SWAP_V2 || t0 === T_SWAP_V3) swap++;
    else if (t0 === T_TRANSFER) transfer++;
  }
  return { swap, transfer };
}

function classifyTx(tx, rc, labelBook, fromCounts, feat) {
  const to = (tx.to || "").toLowerCase();
  const from = (tx.from || "").toLowerCase();
  const input = tx.input ?? tx.data ?? "0x";
  const sel = input.length >= 10 ? input.slice(0, 10) : null;

  if (!to) return "other";                          // contract deploy
  if (SYSTEM_ADDRS.has(to)) return "system";        // 系统交易(validator 分账/slash 等)

  // label book;learned "other" 不作终判(带着新特征让规则/AI 继续跑)
  const toL = labelBook.get(to), fromL = labelBook.get(from);
  if (fromL?.cat === "cex" || toL?.cat === "cex") return "cex";
  if (toL && toL.cat !== "other") return toL.cat;

  // bot:gas-golfed 短 selector,或单块同 from ≥3 笔的合约调用。
  // 高频但属纯转账/标准 transfer 的不算(交易所归集、批量分发),放行给 bnb/token
  const isPlainTransfer = (rc && Number(rc.gasUsed) === 21000) || (!rc && input === "0x");
  const isTokenTransfer = sel === SEL_TRANSFER || sel === SEL_TRANSFER_FROM;
  if (sel && /^0x000000[0-9a-f]{2}$/.test(sel)) return "bot";
  if ((fromCounts.get(from) || 0) >= 3 && !isPlainTransfer && !isTokenTransfer) return "bot";

  // 事件签名:有 Swap → defi(router/聚合器/直调 pool 的普通 swap)
  if (feat.swap > 0) return "defi";

  // 原生 BNB 转账:恰好 21000 gas;或无 calldata、无事件、低 gas(简单合约钱包 receive)
  if (isPlainTransfer) return "bnb";
  if (input === "0x" && rc && (rc.logs?.length ?? 0) === 0 && Number(rc.gasUsed) <= 30000) return "bnb";

  // 代币转移:标准 selector,或只有 Transfer 事件的应用合约(批量分发/游戏)
  if (sel === SEL_TRANSFER || sel === SEL_TRANSFER_FROM) return "token";
  if (feat.transfer > 0) return "token";

  return "other";
}

export const CATS = ["meme", "defi", "predict", "bot", "stable", "bnb", "token", "cex", "bridge", "infra", "system", "other"];
