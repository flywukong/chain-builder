/**
 * Per-tx classifier — 双口径:
 *  - cat(v1,互斥 12 类):旧面板兼容,逻辑冻结不再扩展,消费原始 tx/receipt
 *  - v2 多维:classifyFactV2(fact, labelBook) 纯函数,在线与 journal 重放同一路径
 * 地址标签不决定 activity;verified predict/bridge 需地址∧动作双命中。
 */

import { extractFact } from "./facts.js";

const SEL_TRANSFER      = "0xa9059cbb";
const SEL_TRANSFER_FROM = "0x23b872dd";
const SEL_APPROVE       = "0x095ea7b3";

const T_SWAP_V2   = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const T_SWAP_V3   = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const T_TRANSFER  = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// v2 分类器版本:规则/verified 表变更时 bump,重启后自动重放 journal 覆盖窗口
export const CLASSIFIER_V2_VER = 3;

// Developer-facing traffic projection. This is intentionally separate from
// the observable activity dimensions above: one transaction has exactly one
// primary segment for the 100% overview, while facts/features remain additive.
export const TRAFFIC_SCHEMA_VER = 2;
export const TRAFFIC_SEGMENTS = [
  "deploy", "prediction", "bridge", "meme_launchpad", "builder_payment",
  "defi", "infrastructure", "stable_transfer", "token_transfer", "native_transfer", "other_call",
];

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
export function classifyBlock(txs, receipts, labelBook, tMs = Date.now(), blockNum = 0, { legacy = true } = {}) {
  // bot 高频判定只统计"合格合约调用"(排除纯转账/标准 token transfer),修正旧版全量计数的误判
  const fromCounts = new Map();
  if (legacy) txs.forEach((tx, i) => {
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
    const feat = logFeatures(rc);
    const fact = extractFact(tx, rc, tMs, blockNum, i);
    const v2 = classifyFactV2(fact, labelBook);
    const traffic = classifyTraffic(fact, labelBook);
    return {
      cat: legacy ? classifyTx(tx, rc, labelBook, fromCounts, feat) : null,
      ...v2,
      ...traffic,
      fact,
      gas: fact.g,
      to: fact.o ?? "",
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

// ── v2 多维(纯函数,输入 TxnFact):activity 互斥 + assets/flows 叠加 ──
// activity 优先级:deploy > system > verified bridge/predict action > swap > native > token > other
export function classifyFactV2(f, labelBook) {
  const isPlain = f.rc === 1 && f.g === 21000 && f.il === 0 && valuePositive(f.z);
  const failed = f.rc === 1 && f.st === 0;
  const isTokenXfer = f.s === SEL_TRANSFER || f.s === SEL_TRANSFER_FROM;

  // activity
  let act;
  if (!f.rc) act = "receipt_missing";                       // 证据不完整,不猜行为
  else if (!f.o) act = "deploy";
  else if (SYSTEM_ADDRS.has(f.o)) act = "system";
  else {
    if (f.sw > 0) act = "swap";
    else if (isPlain) act = "native";
    else if (isTokenXfer || f.xf > 0) act = "token";
    else if (failed) act = "failed_unknown";
    else act = "other";
  }

  // assets:tx.to 或 Transfer 的 token 合约命中 verified 资产表
  const assets = new Set();
  const toAsset = f.o && labelBook.assetOf(f.o);
  if (toAsset) assets.add(toAsset);
  for (const a of f.tk ?? []) { const t = labelBook.assetOf(a); if (t) assets.add(t); }

  // flows:Transfer 参与方或顶层 from/to 命中已知 CEX
  const flows = new Set();
  const isCex = (a) => a && labelBook.get(a)?.actorTypes?.includes("cex");
  const outHit = (f.tf ?? []).some(isCex) || isCex(f.f);
  const inHit = (f.td ?? []).some(isCex) || isCex(f.o);
  if (outHit && inHit) flows.add("cex_internal");
  else if (outHit) flows.add("cex_out");
  else if (inHit) flows.add("cex_in");

  return { act, assets: [...assets], flows: [...flows], fail: failed, rcptMiss: f.rc === 0 };
}

function valuePositive(v) {
  try { return BigInt(v ?? 0) > 0n; } catch { return false; }
}

// One stable developer-facing traffic segment, chosen by strongest evidence.
// Protocol means "interaction with the official protocol", not a claim about
// a specific operation. `method`/event evidence is retained for drill-down.
export function classifyTraffic(f, labelBook) {
  const failed = f.rc === 1 && f.st === 0;
  const methodSel = f.s || null;
  const base = {
    trafficV: TRAFFIC_SCHEMA_VER,
    protocol: null,
    contractRole: null,
    methodSel,
    businessAction: null,
    evidence: null,
    failed,
  };
  if (!f.o) return { ...base, segment: "deploy", evidence: "tx.to=null" };
  // System-contract traffic is chain maintenance rather than developer demand.
  // Keep the fact in the journal, but exclude it from the product denominator.
  if (SYSTEM_ADDRS.has(f.o)) return { ...base, segment: null, excluded: "system", evidence: "bsc_system_contract" };

  const verified = labelBook.verified?.(f.o) ?? null;
  if (verified) {
    // Address identity establishes protocol ownership only. A concrete business
    // action is emitted solely when that exact selector was curated for the
    // verified contract; a generic Oracle/Vault call is never called an order.
    const protocol = verified.entity || null;
    const contractRole = verified.roles?.[0] ?? null;
    const businessAction = methodSel && verified.actions?.[methodSel] || null;
    const common = { ...base, protocol, contractRole, businessAction, evidence: "verified_contract" };
    if (verified.cat === "predict") return { ...common, segment: "prediction" };
    if (verified.cat === "bridge") return { ...common, segment: "bridge" };
    if (verified.cat === "meme") return { ...common, segment: "meme_launchpad" };
    if (verified.cat === "infra" && valuePositive(f.z) && f.il === 0) {
      return { ...common, segment: "builder_payment", evidence: "verified_payment_address" };
    }
    if (verified.cat === "infra") return { ...common, segment: "infrastructure" };
    // A token address (for example WBNB) is not a DeFi protocol merely because
    // an old compatibility label says `defi`. Protocol roles are authoritative.
    if (verified.cat === "defi" && !verified.roles?.includes("token")) {
      return { ...common, segment: "defi" };
    }
    if (verified.assetTypes?.includes("stable") &&
        (methodSel === SEL_TRANSFER || methodSel === SEL_TRANSFER_FROM || f.xf > 0)) {
      return { ...common, segment: "stable_transfer", evidence: "verified_stablecoin_transfer" };
    }
  }

  if (f.sw > 0) return { ...base, segment: "defi", evidence: "swap_event" };
  const stableTouched = (f.tk ?? []).some((a) => labelBook.assetOf(a) === "stable");
  if (stableTouched && f.xf > 0) {
    return { ...base, segment: "stable_transfer", evidence: "verified_stablecoin_transfer_event" };
  }
  if (methodSel === SEL_TRANSFER || methodSel === SEL_TRANSFER_FROM || f.xf > 0) {
    return { ...base, segment: "token_transfer", evidence: "standard_transfer" };
  }
  if (valuePositive(f.z) && f.il === 0 && f.g === 21000) {
    return { ...base, segment: "native_transfer", evidence: "value+empty_input+21000_gas" };
  }
  if (methodSel === SEL_APPROVE && f.ap > 0) {
    return { ...base, segment: "other_call", evidence: "approval" };
  }
  return { ...base, segment: "other_call", evidence: "unmatched_contract_call" };
}

export const CATS = ["meme", "defi", "predict", "bot", "stable", "bnb", "token", "cex", "bridge", "infra", "system", "other"];
export const ACTS = ["swap", "token", "native", "deploy", "system", "receipt_missing", "failed_unknown", "other"];
