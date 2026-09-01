/**
 * Offline V2 history backfill. The monitor must be stopped while this runs.
 *
 * Required:
 *   TXN_BACKFILL_CONFIRM=YES BSC_RPC_URL=http://archive-node npm run backfill:txn
 * Optional:
 *   TXN_BACKFILL_DAYS=30 TXN_BACKFILL_CONCURRENCY=10 TXN_BACKFILL_BATCH=300
 *   TXN_BACKFILL_RESET=YES  # archive a completed/old-format checkpoint and start a fresh snapshot
 *
 * The job is resumable. It writes a versioned temporary store/state and only
 * replaces V2 hourly dimensions in txn-7d.json after the full fixed range succeeds.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { CLASSIFIER_V2_VER } from "../src/txn/classifier.js";
import { LabelCloud } from "../src/txn/labelCloud.js";
import { LabelBook } from "../src/txn/labels.js";
import { TxnSampler } from "../src/txn/sampler.js";
import { TxnStore } from "../src/txn/store.js";

if (process.env.TXN_BACKFILL_CONFIRM !== "YES") {
  console.error("Refusing to run: stop the monitor, then set TXN_BACKFILL_CONFIRM=YES.");
  process.exit(2);
}
if (!process.env.BSC_RPC_URL) {
  console.error("BSC_RPC_URL is required and must support eth_getBlockReceipts for historical blocks.");
  process.exit(2);
}

const days = Math.min(Math.max(Number(process.env.TXN_BACKFILL_DAYS) || 30, 1), 30);
const concurrency = Math.min(Math.max(Number(process.env.TXN_BACKFILL_CONCURRENCY) || 10, 1), 50);
const batch = Math.min(Math.max(Number(process.env.TXN_BACKFILL_BATCH) || 300, 10), 2000);
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, "../data");
const suffix = `v${CLASSIFIER_V2_VER}-${days}d`;
const tempFile = path.join(dataDir, `txn-backfill-${suffix}.json`);
const stateFile = path.join(dataDir, `txn-backfill-${suffix}-state.json`);
const mainFile = path.join(dataDir, "txn-7d.json");
if (process.env.TXN_BACKFILL_RESET === "YES") {
  const stamp = Date.now();
  for (const file of [tempFile, stateFile]) {
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.audit-${stamp}`);
  }
}
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL);

const blockHeader = async (height) => {
  const b = await provider.send("eth_getBlockByNumber", [`0x${height.toString(16)}`, false]);
  if (!b) throw new Error(`block #${height} unavailable`);
  return b;
};

const chainTip = Number.parseInt(await provider.send("eth_blockNumber", []), 16);
let savedState = {};
try { if (fs.existsSync(stateFile)) savedState = JSON.parse(fs.readFileSync(stateFile, "utf8")) || {}; } catch {}
if (savedState.completedAt) {
  throw new Error("backfill checkpoint is already complete; set TXN_BACKFILL_RESET=YES to archive it and create a fresh snapshot");
}
// 首次运行固定目标块；续跑沿用同一 target，避免任务边跑边向前延伸而永远没有稳定快照。
const tip = Number(savedState.targetBlock) || chainTip;
// 多回填 1 天余量:与存储窗(31d)对齐,保证 30d 连续判定稳定不闪烁
const targetMs = Date.now() - (days + 1) * 86400e3;
let fromBlock = Number(savedState.firstBlock) || 0;
if (!fromBlock) {
  let lo = 1, hi = tip;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await blockHeader(mid);
    if (Number.parseInt(b.timestamp, 16) * 1000 < targetMs) lo = mid + 1;
    else hi = mid;
  }
  fromBlock = lo;
}

// 临时 store 用超长窗口:回填跑十几小时,禁止过程中把最早回填的桶按 30d 窗口边填边删
const tempStore = new TxnStore(tempFile, { v2Only: true, windowMs: (days + 3) * 86400e3 });
if (tempStore.buckets.some((b) => b.firstSeenAt == null || b.lastSeenAt == null)) {
  throw new Error("backfill checkpoint uses the old time-boundary format; rerun with TXN_BACKFILL_RESET=YES");
}
const tempMax = Math.max(0, ...tempStore.buckets.map((b) => b.maxBlock || 0));
fs.writeFileSync(stateFile, JSON.stringify({
  ...savedState, targetBlock: tip,
  lastBlock: Number(savedState.lastBlock) || Math.max(fromBlock - 1, tempMax),
  firstBlock: fromBlock,
}));
const labelBook = new LabelBook(path.join(dataDir, "contract-labels.json"));
const labelCloud = new LabelCloud(path.join(dataDir, "label-cloud-cache.json"));
labelBook.setMevSet(labelCloud.mevSet());
const sampler = new TxnSampler({
  provider, store: tempStore, labelBook, stateFile,
  concurrency, maxPerTick: batch, intervalMs: 60_000, confirmationBlocks: 0,
});
// 仅全新任务从窗口起点开跑;续跑必须衔接上次水位——重新二分的起点会随时间前移,
// 若跳过中断期间的块段,会在小时桶里留下永久缺口,拖垮 30d 覆盖率判定。
if (tempMax === 0 && sampler.lastBlock < fromBlock - 1) sampler.lastBlock = fromBlock - 1;

console.log(`[txn backfill] classifier=v${CLASSIFIER_V2_VER} days=${days} range=#${fromBlock}..#${tip}`);
console.log(`[txn backfill] resume=#${sampler.lastBlock + 1} concurrency=${concurrency} batch=${batch}`);

let consecutiveFailures = 0;
while (sampler.lastBlock < tip) {
  const before = sampler.lastBlock;
  await sampler.sample(tip).catch(() => {});
  if (sampler.lastBlock === before) {
    consecutiveFailures++;
    if (consecutiveFailures >= 10) throw new Error(`stalled at #${before + 1}: ${sampler.lastError?.error ?? "unknown error"}`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** consecutiveFailures)));
  } else {
    consecutiveFailures = 0;
    const done = Math.max(0, sampler.lastBlock - fromBlock + 1);
    const total = tip - fromBlock + 1;
    console.log(`[txn backfill] #${sampler.lastBlock}/${tip} ${(100 * done / total).toFixed(2)}%`);
  }
}

if (tempStore.flush() === false) throw new Error(`temporary store persist failed: ${tempStore.lastSaveError}`);
const coverage = tempStore.blockCoverage();
if (!coverage || coverage.firstBlock > fromBlock || coverage.contiguousTo < tip) {
  throw new Error(`backfill coverage incomplete: expected #${fromBlock}..#${tip}, got ${coverage ? `#${coverage.firstBlock}..#${coverage.contiguousTo}` : "none"}`);
}
const mainStore = new TxnStore(mainFile);
const merged = mainStore.mergeV2Backfill(tempStore.buckets);
if (mainStore.flush() === false) throw new Error(`main store persist failed: ${mainStore.lastSaveError}`);
const completedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const completedTmp = `${stateFile}.tmp`;
fs.writeFileSync(completedTmp, JSON.stringify({ ...completedState, completedAt: Date.now(), mergedBuckets: merged }));
fs.renameSync(completedTmp, stateFile);
console.log(`[txn backfill] complete: merged ${merged} V2 hourly buckets into ${mainFile}`);
console.log("[txn backfill] checkpoint retained for audit; use TXN_BACKFILL_RESET=YES for a new snapshot.");
