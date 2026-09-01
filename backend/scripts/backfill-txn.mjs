/**
 * Offline V2 history backfill. The monitor must be stopped while this runs.
 *
 * Required:
 *   TXN_BACKFILL_CONFIRM=YES BSC_RPC_URL=http://archive-node npm run backfill:txn
 * Optional:
 *   TXN_BACKFILL_DAYS=30 TXN_BACKFILL_CONCURRENCY=10 TXN_BACKFILL_BATCH=300
 *
 * The job is resumable. It writes a versioned temporary store/state and only
 * replaces V2 hourly dimensions in txn-7d.json after the full fixed range succeeds.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { CLASSIFIER_V2_VER } from "../src/txn/classifier.js";
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
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL);

const blockHeader = async (height) => {
  const b = await provider.send("eth_getBlockByNumber", [`0x${height.toString(16)}`, false]);
  if (!b) throw new Error(`block #${height} unavailable`);
  return b;
};

const tip = Number.parseInt(await provider.send("eth_blockNumber", []), 16);
// 多回填 1 天余量:与存储窗(31d)对齐,保证 30d 连续判定稳定不闪烁
const targetMs = Date.now() - (days + 1) * 86400e3;
let lo = 1, hi = tip;
while (lo < hi) {
  const mid = Math.floor((lo + hi) / 2);
  const b = await blockHeader(mid);
  if (Number.parseInt(b.timestamp, 16) * 1000 < targetMs) lo = mid + 1;
  else hi = mid;
}
const fromBlock = lo;

// 临时 store 用超长窗口:回填跑十几小时,禁止过程中把最早回填的桶按 30d 窗口边填边删
const tempStore = new TxnStore(tempFile, { v2Only: true, windowMs: (days + 3) * 86400e3 });
const tempMax = Math.max(0, ...tempStore.buckets.map((b) => b.maxBlock || 0));
if (!fs.existsSync(stateFile)) {
  fs.writeFileSync(stateFile, JSON.stringify({ lastBlock: Math.max(fromBlock - 1, tempMax), firstBlock: fromBlock }));
}
const labelBook = new LabelBook(path.join(dataDir, "contract-labels.json"));
const sampler = new TxnSampler({
  provider, store: tempStore, labelBook, stateFile,
  concurrency, maxPerTick: batch, intervalMs: 60_000,
});
if (sampler.lastBlock < fromBlock - 1) sampler.lastBlock = fromBlock - 1;

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
    const done = sampler.lastBlock - fromBlock + 1;
    const total = tip - fromBlock + 1;
    console.log(`[txn backfill] #${sampler.lastBlock}/${tip} ${(100 * done / total).toFixed(2)}%`);
  }
}

tempStore.flush();
const mainStore = new TxnStore(mainFile);
const merged = mainStore.mergeV2Backfill(tempStore.buckets);
console.log(`[txn backfill] complete: merged ${merged} V2 hourly buckets into ${mainFile}`);
console.log("[txn backfill] temporary files retained for audit/resume safety.");
