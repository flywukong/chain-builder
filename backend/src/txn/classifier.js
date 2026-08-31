/**
 * Per-tx classifier — 双口径:
 *  - cat(v1,互斥 12 类):旧面板兼容,逻辑冻结不再扩展
 *  - v2 多维:activity(互斥,行为证据判定)+ parts/assets/flows(叠加)+ 质量位
 * 地址标签不决定 activity;verified predict/bridge 需地址∧动作双命中。
 */

const SEL_TRANSFER      = "0xa9059cbb";
const SEL_TRANSFER_FROM = "0x23b872dd";

const T_SWAP_V2   = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const T_SWAP_V3   = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const T_TRANSFER  = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const T_APPROVAL  = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

// BSC 系统合约(core/systemcontracts/const.go 全集;1004 TokenHub 归 bridge)
const SYSTEM_ADDRS = new Set([
  "0x0000000000000000000000000000000000001000", "0x0000000000000000000000000000000000001001",
  "0x0000000000000000000000000000000000001002", "0x0000000000000000000000000000000000001003",
  "0x0000000000000000000000000000000000001005", "0x0000000000000000000000000000000000001006",
  "0x0000000000000000000000000000000000001007", "0x0000000000000000000000000000000000001008",
  "0x0000000000000000000000000000000000002000", "0x0000000000000000000000000000000000002001",
  "0x0000000000000000000000000000000000002002", "0x0000000000000000000000000000000000002003",
  "0x0000000000000000000000000000000000002004", "0x0000000000000000000000000000000000002005",
  "0x0000000000000000000000000000000000002006", "0x0000000000000000000000000000000000003000",
]);

// Classify one block's txs. receipts aligned by index (may be null).
export function classifyBlock(txs, receipts, labelBook) {
  // bot 高频判定只统计"合格合约调用"(排除纯转账/标准 token transfer),修正旧版全量计数的误判
  const fromCounts = new Map();
  txs.forEach((tx, i) => {
    const rc = receipts?.[i] ?? null;
    const input = tx.input ?? tx.data ?? "0x";
    const sel = input.length >= 10 ? input.slice(0, 10) : null;
    const plain = (rc && Number(rc.gasUsed) === 21000) || (!rc && input === "0x");
    if (!tx.to || plain || sel === SEL_TRANSFER || sel === SEL_TRANSFER_FROM) return;
    const f = (tx.from || "").toLowerCase();
    fromCounts.set(f, (fromCounts.get(f) || 0) + 1);
  });

  return txs.map((tx, i) => {
    const rc = receipts?.[i] ?? null;
    const gas = rc ? Number(rc.gasUsed) : Number(tx.gas ?? 0);
    const feat = logFeatures(rc);
    const v2 = classifyV2(tx, rc, labelBook, fromCounts, feat);
    return {
      cat: classifyTx(tx, rc, labelBook, fromCounts, feat),
      ...v2,
      gas,
      to: (tx.to || "").toLowerCase(),
      sel: (tx.input ?? "0x").slice(0, 10),
      swap: feat.swap, xfer: feat.transfer,
    };
  });
}

function logFeatures(rc) {
  let swap = 0, transfer = 0, nonApproval = 0;
  for (const lg of rc?.logs ?? []) {
    const t0 = lg.topics?.[0];
    if (t0 === T_SWAP_V2 || t0 === T_SWAP_V3) swap++;
    else if (t0 === T_TRANSFER) transfer++;
    if (t0 !== T_APPROVAL) nonApproval++;
  }
  return { swap, transfer, nonApproval };
}

// ── v1 互斥 cat(冻结)──────────────────────────────────────────────
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

  const isPlainTransfer = (rc && Number(rc.gasUsed) === 21000) || (!rc && input === "0x");
  const isTokenTransfer = sel === SEL_TRANSFER || sel === SEL_TRANSFER_FROM;
  if (sel && /^0x000000[0-9a-f]{2}$/.test(sel)) return "bot";
  if ((fromCounts.get(from) || 0) >= 3 && !isPlainTransfer && !isTokenTransfer) return "bot";

  if (feat.swap > 0) return "defi";

  if (isPlainTransfer) return "bnb";
  if (input === "0x" && rc && (rc.logs?.length ?? 0) === 0 && Number(rc.gasUsed) <= 30000) return "bnb";

  if (sel === SEL_TRANSFER || sel === SEL_TRANSFER_FROM) return "token";
  if (feat.transfer > 0) return "token";

  return "other";
}

// ── v2 多维:activity 互斥 + parts/assets/flows 叠加 ─────────────────
// activity 优先级:deploy > system > verified bridge/predict action > swap > native > token > other
function classifyV2(tx, rc, labelBook, fromCounts, feat) {
  const to = (tx.to || "").toLowerCase();
  const from = (tx.from || "").toLowerCase();
  const input = tx.input ?? tx.data ?? "0x";
  const sel = input.length >= 10 ? input.slice(0, 10) : null;
  const isPlain = (rc && Number(rc.gasUsed) === 21000) || (!rc && input === "0x");
  const failed = rc ? rc.status === "0x0" : false;

  // activity
  let act;
  if (!to) act = "deploy";
  else if (SYSTEM_ADDRS.has(to)) act = "system";
  else {
    const va = labelBook.verifiedAction(to);
    // 双命中:actions 表精确匹配 selector;actions 未配齐(null)时过渡启发式 =
    // 成功且有非 Approval 日志(排除 admin/approve/失败调用)
    const hit = va && (va.actions ? !!va.actions[sel] : (!failed && feat.nonApproval > 0));
    if (hit) act = va.act;                                     // predict | bridge
    else if (feat.swap > 0) act = "swap";
    else if (isPlain || (input === "0x" && rc && (rc.logs?.length ?? 0) === 0 && Number(rc.gasUsed) <= 30000)) act = "native";
    else if (sel === SEL_TRANSFER || sel === SEL_TRANSFER_FROM || feat.transfer > 0) act = "token";
    else act = "other";
  }

  // participants(sender 侧,行为规则;candidate 标签不参与)
  const parts = [];
  const isTokenXfer = sel === SEL_TRANSFER || sel === SEL_TRANSFER_FROM;
  if (to && ((sel && /^0x000000[0-9a-f]{2}$/.test(sel)) ||
             ((fromCounts.get(from) || 0) >= 3 && !isPlain && !isTokenXfer))) parts.push("bot");

  // assets:tx.to 或 Transfer log 的 token 合约命中 verified 资产表
  const assets = new Set();
  const toAsset = labelBook.assetOf(to);
  if (toAsset) assets.add(toAsset);
  // flows:Transfer 参数命中已知 CEX(topics[1]=from / topics[2]=to,32B 左填充)
  const flows = new Set();
  for (const lg of rc?.logs ?? []) {
    if (lg.topics?.[0] !== T_TRANSFER) continue;
    const asset = labelBook.assetOf((lg.address || "").toLowerCase());
    if (asset) assets.add(asset);
    const tFrom = lg.topics[1]?.length === 66 ? "0x" + lg.topics[1].slice(26) : null;
    const tTo = lg.topics[2]?.length === 66 ? "0x" + lg.topics[2].slice(26) : null;
    const fromCex = tFrom && labelBook.get(tFrom)?.actorTypes?.includes("cex");
    const toCex = tTo && labelBook.get(tTo)?.actorTypes?.includes("cex");
    if (fromCex && toCex) flows.add("cex_internal");
    else if (fromCex) flows.add("cex_out");
    else if (toCex) flows.add("cex_in");
  }
  // 原生 BNB 充提:顶层 from/to 命中 CEX
  const fromCexTop = labelBook.get(from)?.actorTypes?.includes("cex");
  const toCexTop = to && labelBook.get(to)?.actorTypes?.includes("cex");
  if (fromCexTop && toCexTop) flows.add("cex_internal");
  else if (fromCexTop) flows.add("cex_out");
  else if (toCexTop) flows.add("cex_in");

  return { act, parts, assets: [...assets], flows: [...flows], fail: failed, rcptMiss: !rc };
}

export const CATS = ["meme", "defi", "predict", "bot", "stable", "bnb", "token", "cex", "bridge", "infra", "system", "other"];
export const ACTS = ["swap", "token", "native", "predict", "bridge", "deploy", "system", "other"];
