import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyFactV2, CLASSIFIER_V2_VER } from "../src/txn/classifier.js";
import { TxnSampler } from "../src/txn/sampler.js";
import { TxnStore } from "../src/txn/store.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const baseFact = (overrides = {}) => ({
  v: 2, b: 1, i: 0, t: Date.now(),
  f: "0x2222222222222222222222222222222222222222", o: ADDRESS,
  s: "0x12345678", g: 50_000, st: 1, rc: 1, lg: 0,
  sw: 0, xf: 0, na: 0, q: 0, tk: [], tf: [], td: [],
  ...overrides,
});

const labels = ({ action = null } = {}) => ({
  get: () => null,
  assetOf: () => null,
  verifiedAction: () => action,
  learnedCount: () => 0,
});

test("verified identity without an exact action never decides activity", () => {
  const identityOnly = classifyFactV2(baseFact({ lg: 3, na: 3 }), labels({ action: { act: "predict", actions: null } }));
  assert.equal(identityOnly.act, "other");

  const exact = classifyFactV2(baseFact(), labels({ action: { act: "predict", actions: { "0x12345678": "predict" } } }));
  assert.equal(exact.act, "predict");
});

test("failed calls retain observable intent and unknown failures are separated", () => {
  const failedTransfer = classifyFactV2(baseFact({ s: "0xa9059cbb", st: 0 }), labels());
  assert.equal(failedTransfer.act, "token");
  assert.equal(failedTransfer.fail, true);

  const failedUnknown = classifyFactV2(baseFact({ st: 0 }), labels());
  assert.equal(failedUnknown.act, "failed_unknown");

  const missingReceipt = classifyFactV2(baseFact({ rc: 0, st: null, g: null }), labels());
  assert.equal(missingReceipt.act, "receipt_missing");
  assert.equal(missingReceipt.rcptMiss, true);
});

test("V2 view uses one business denominator and reports block coverage", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-store-"));
  const store = new TxnStore(path.join(dir, "store.json"));
  const now = Date.now();
  const row = (cat, act, extra = {}) => ({ cat, act, gas: 10, to: "", sel: "0x", swap: 0, xfer: 0, parts: [], assets: [], flows: [], fail: false, rcptMiss: false, ...extra });
  store.addBlock(now, [row("system", "system"), row("defi", "swap", { parts: ["bot"], assets: ["stable"] })], null, null, 100);
  store.addBlock(now, [row("other", "failed_unknown", { fail: true })], null, null, 101);
  assert.equal(store.addBlock(now, [row("other", "other")], null, null, 101), false);

  const view = store.view(labels(), 1, 1);
  assert.equal(view.dim.denominators.allTx, 3);
  assert.equal(view.dim.denominators.businessTx, 2);
  assert.equal(view.dim.parts.bot, 1);
  assert.equal(view.dim.meta.coveragePct, 100);
  assert.equal(view.dim.meta.availableContinuousHours, 1);
  assert.equal(view.dim.meta.windowReady, false);
  assert.deepEqual(view.dim.meta.classifierVersions, [CLASSIFIER_V2_VER]);

  store.buckets[0].v2v = CLASSIFIER_V2_VER - 1;
  const staleView = store.view(labels(), 1, 1);
  assert.equal(staleView.dim.total, 0);
  assert.equal(staleView.dim.meta.excludedStaleBuckets, 1);
});

test("V2 window aggregates only the continuous tail after an hourly gap", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-gap-"));
  const store = new TxnStore(path.join(dir, "store.json"));
  const hour = 3600e3;
  const now = Date.now();
  const row = { cat: "other", act: "other", gas: 10, to: "", sel: "0x", swap: 0, xfer: 0, parts: [], assets: [], flows: [], fail: false, rcptMiss: false };
  store.addBlock(now - 3 * hour, [row], null, null, 200);
  store.addBlock(now - hour, [row], null, null, 201);
  store.addBlock(now, [row], null, null, 202);

  const view = store.view(labels(), 1, 1);
  assert.equal(view.dim.total, 2);
  assert.equal(view.dim.meta.availableContinuousHours, 2);
  assert.equal(view.dim.meta.excludedGapBuckets, 1);
});

test("sampler commits only the contiguous successful prefix and retries the gap", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-sampler-"));
  const stateFile = path.join(dir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ lastBlock: 100, firstBlock: 100 }));
  let fail102 = true;
  const provider = {
    async send(method, [hex] = []) {
      if (method === "eth_blockNumber") return "0x67"; // 103
      const h = Number.parseInt(hex, 16);
      if (method === "eth_getBlockByNumber") return { timestamp: "0x1", transactions: [] };
      if (method === "eth_getBlockReceipts") {
        if (h === 102 && fail102) throw new Error("temporary RPC failure");
        return [];
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const committed = [];
  const store = {
    addBlock(_t, _rows, _gp, _gp90, height) { committed.push(height); },
    flush() {},
  };
  const sampler = new TxnSampler({ provider, store, labelBook: labels(), stateFile, concurrency: 3, maxPerTick: 10 });
  await sampler.sample();
  assert.deepEqual(committed, [101]);
  assert.equal(sampler.status().contiguousTo, 101);
  assert.equal(sampler.status().lastError.height, 102);

  fail102 = false;
  await sampler.sample();
  assert.deepEqual(committed, [101, 102, 103]);
  assert.equal(sampler.status().contiguousTo, 103);
  assert.equal(sampler.status().lastError, null);
});
