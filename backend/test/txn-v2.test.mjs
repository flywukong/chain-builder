import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyFactV2, classifyTraffic, CLASSIFIER_V2_VER, TRAFFIC_SCHEMA_VER } from "../src/txn/classifier.js";
import { FactJournal } from "../src/txn/facts.js";
import { TxnSampler } from "../src/txn/sampler.js";
import { TxnStore } from "../src/txn/store.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const baseFact = (overrides = {}) => ({
  v: 2, b: 1, i: 0, t: Date.now(),
  f: "0x2222222222222222222222222222222222222222", o: ADDRESS,
  s: "0x12345678", g: 50_000, st: 1, rc: 1, lg: 0,
  z: "0x0", il: 4, sw: 0, xf: 0, na: 0, ap: 0, nft: 0, mt: 0, tk: [], tf: [], td: [],
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
  assert.equal(exact.act, "other");
});

test("official protocol identity drives the primary traffic segment, not observable activity", () => {
  const book = {
    ...labels(),
    verified: () => ({ status: "verified", cat: "predict", entity: "predict.fun", roles: ["exchange"] }),
  };
  const result = classifyTraffic(baseFact(), book);
  assert.equal(result.trafficV, TRAFFIC_SCHEMA_VER);
  assert.equal(result.segment, "prediction");
  assert.equal(result.protocol, "predict.fun");
  assert.equal(result.methodSel, "0x12345678");
});

test("official identity does not invent a business action and exact curated selector may add one", () => {
  const withoutAction = {
    ...labels(),
    verified: () => ({ status: "verified", cat: "predict", entity: "predict.fun", roles: ["oracle"], actions: null }),
  };
  assert.equal(classifyTraffic(baseFact(), withoutAction).businessAction, null);

  const withAction = {
    ...labels(),
    verified: () => ({ status: "verified", cat: "predict", entity: "predict.fun", roles: ["exchange"], actions: { "0x12345678": "fill_orders" } }),
  };
  assert.equal(classifyTraffic(baseFact(), withAction).businessAction, "fill_orders");
  assert.equal(classifyTraffic(baseFact({ s: "0x87654321" }), withAction).businessAction, null);
});

test("verified token and AA identities do not pollute DeFi traffic", () => {
  const tokenBook = { ...labels(), verified: () => ({ cat: "defi", roles: ["token"], name: "WBNB" }) };
  assert.equal(classifyTraffic(baseFact({ s: "0xa9059cbb", xf: 1 }), tokenBook).segment, "token_transfer");
  const infraBook = { ...labels(), verified: () => ({ cat: "infra", entity: "ERC-4337", roles: ["entrypoint"] }) };
  assert.equal(classifyTraffic(baseFact(), infraBook).segment, "infrastructure");
});

test("system contracts are explicitly excluded from the developer traffic denominator", () => {
  const result = classifyTraffic(baseFact({ o: "0x0000000000000000000000000000000000001000" }), { ...labels(), verified: () => null });
  assert.equal(result.segment, null);
  assert.equal(result.excluded, "system");
});

test("native transfer requires positive value, empty calldata and exactly 21000 gas", () => {
  const plain = classifyTraffic(baseFact({ s: null, il: 0, z: "0x1", g: 21000 }), { ...labels(), verified: () => null });
  assert.equal(plain.segment, "native_transfer");
  const zeroValue = classifyTraffic(baseFact({ s: null, il: 0, z: "0x0", g: 21000 }), { ...labels(), verified: () => null });
  assert.equal(zeroValue.segment, "other_call");
});

test("old bot heuristics never become a primary traffic segment", () => {
  const compactSelector = classifyTraffic(baseFact({ s: "0x00000001" }), { ...labels(), verified: () => null });
  assert.equal(compactSelector.segment, "other_call");
});

test("traffic view exposes developer metrics without retaining sender addresses", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-traffic-view-"));
  const store = new TxnStore(path.join(dir, "store.json"));
  const now = Date.now();
  const trafficRow = (segment, from, gas, extra = {}) => ({
    cat: "other", act: "other", gas, to: ADDRESS, sel: "0x12345678", swap: 0, xfer: 0,
    assets: [], flows: [], fail: false, rcptMiss: false, segment, trafficV: TRAFFIC_SCHEMA_VER,
    failed: false, protocol: null, contractRole: null, businessAction: null,
    fact: baseFact({ f: from, g: gas, h: `0x${gas.toString(16).padStart(64, "0")}` }),
    ...extra,
  });
  store.addBlock(now, [
    trafficRow("token_transfer", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 100),
    trafficRow("token_transfer", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 200, { failed: true }),
    trafficRow("native_transfer", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 21_000),
    { ...trafficRow(null, "0xcccccccccccccccccccccccccccccccccccccccc", 30_000), excluded: "system", to: "0x0000000000000000000000000000000000001000" },
  ], null, null, 500);
  const view = store.view(labels(), 1, 1).traffic;
  assert.equal(view.total, 3);
  assert.equal(view.meta.excludedSystem, 1);
  assert.equal(view.segments.token_transfer.failurePct, 50);
  assert.equal(view.segments.token_transfer.successPct, 50);
  assert.equal(view.segments.token_transfer.p50Gas, 100);
  assert.equal(view.segments.token_transfer.p95Gas, 200);
  assert.equal(view.segments.token_transfer.activeSendersEst, 2);
  assert.equal(JSON.stringify(store.buckets).includes("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), false);
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
  assert.equal(view.dim.parts, undefined);
  assert.equal(view.dim.meta.coveragePct, 100);
  assert.equal(view.dim.meta.availableContinuousHours, 0);
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
  assert.equal(view.dim.meta.availableContinuousHours, 1);
  assert.equal(view.dim.meta.excludedGapBuckets, 1);
});

test("offline backfill replaces V2 dimensions without changing legacy totals", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-merge-"));
  const main = new TxnStore(path.join(dir, "main.json"));
  const backfill = new TxnStore(path.join(dir, "backfill.json"), { v2Only: true });
  const now = Date.now();
  const row = (act, segment, i = 0) => ({
    cat: "other", act, gas: 10, to: ADDRESS, sel: "0x12345678", swap: 0, xfer: 0,
    assets: [], flows: [], fail: false, rcptMiss: false, segment, trafficV: TRAFFIC_SCHEMA_VER,
    failed: false, protocol: null, fact: baseFact({ i }),
  });
  main.addBlock(now, [row("other", "other_call")], null, null, 300);
  backfill.addBlock(now, [row("swap", "defi", 0), row("token", "token_transfer", 1)], null, null, 300);
  backfill.flush();

  assert.equal(main.mergeV2Backfill(backfill.buckets), 1);
  const view = main.view(labels(), 1, 1);
  assert.equal(view.total24, 1);
  assert.equal(view.dim.total, 2);
  assert.equal(view.dim.acts.swap.n, 1);
  assert.equal(view.dim.acts.token.n, 1);
  assert.equal(view.traffic.total, 2);
  assert.equal(view.traffic.segments.defi.n, 1);
  assert.equal(view.traffic.segments.token_transfer.n, 1);
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
  const sampler = new TxnSampler({ provider, store, labelBook: labels(), stateFile, concurrency: 3, maxPerTick: 10, confirmationBlocks: 0 });
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

test("live sampler leaves the configured confirmation depth at the chain tip", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-confirmations-"));
  const stateFile = path.join(dir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ lastBlock: 100, firstBlock: 100 }));
  const provider = { send: async (method, [hex] = []) => method === "eth_blockNumber"
    ? "0x67"
    : method === "eth_getBlockByNumber"
      ? { timestamp: "0x1", transactions: [] }
      : [] };
  const committed = [];
  const store = { addBlock(_t, _rows, _gp, _gp90, h) { committed.push(h); }, flush: () => true };
  const sampler = new TxnSampler({ provider, store, labelBook: labels(), stateFile, confirmationBlocks: 2 });
  await sampler.sample();
  assert.deepEqual(committed, [101]);
  assert.equal(sampler.status().tip, 103);
  assert.equal(sampler.status().safeTip, 101);
});

test("24 hourly buckets spanning only 23 real hours do not unlock the 24H window", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-real-span-"));
  const store = new TxnStore(path.join(dir, "store.json"));
  const now = Date.now();
  const hour = 3600e3;
  const row = { cat: "other", act: "other", gas: 1, to: "", sel: "0x", swap: 0, xfer: 0, parts: [], assets: [], flows: [], fail: false, rcptMiss: false };
  for (let i = 23; i >= 0; i--) store.addBlock(now - i * hour, [row], null, null, 1000 + i);
  const meta = store.view(labels(), 1, 1).dim.meta;
  assert.equal(meta.availableContinuousHours, 23);
  assert.equal(meta.windowReady, false);
});

test("replay never replaces the active hour even when its snapshot exceeds 98 percent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-replay-active-"));
  const store = new TxnStore(path.join(dir, "store.json"));
  const now = Date.now();
  const row = { cat: "other", act: "other", gas: 1, to: "", sel: "0x", swap: 0, xfer: 0, parts: [], assets: [], flows: [], fail: false, rcptMiss: false };
  store.addBlock(now, Array.from({ length: 100 }, () => ({ ...row })), null, null, 1);
  store.buckets[0].v2v = CLASSIFIER_V2_VER - 1;
  const fact = baseFact({ t: now, b: 1 });
  const journal = {
    coverage: () => ({ fromMs: now - 1, toMs: now + 1 }),
    replay: async (_from, _to, cb) => { for (let i = 0; i < 99; i++) cb({ ...fact, i }); return 99; },
  };
  const result = await store.replayV2(journal, labels(), classifyFactV2);
  assert.equal(result.replaced, 0);
  assert.equal(Object.values(store.buckets[0].acts).reduce((s, v) => s + v.n, 0), 100);
});

test("replay deduplicates block and transaction ids before replacing a sealed hour", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-replay-dedup-"));
  const store = new TxnStore(path.join(dir, "store.json"));
  const t = Date.now() - 2 * 3600e3;
  const row = { cat: "other", act: "other", gas: 1, to: "", sel: "0x", swap: 0, xfer: 0, parts: [], assets: [], flows: [], fail: false, rcptMiss: false };
  store.addBlock(t, [row, row], null, null, 10);
  store.buckets[0].v2v = CLASSIFIER_V2_VER - 1;
  const facts = [baseFact({ t, b: 10, i: 0 }), baseFact({ t, b: 10, i: 1 }), baseFact({ t, b: 10, i: 1 })];
  const journal = {
    coverage: () => ({ fromMs: t - 1, toMs: t + 1 }),
    replay: async (_from, _to, cb) => { facts.forEach(cb); return facts.length; },
  };
  const result = await store.replayV2(journal, labels(), classifyFactV2);
  assert.equal(result.replaced, 1);
  assert.equal(Object.values(store.buckets[0].acts).reduce((s, v) => s + v.n, 0), 2);
  assert.equal(store.buckets[0].firstSeenAt, t);
});

test("sampler does not advance its watermark until the aggregate store is durable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-durable-"));
  const stateFile = path.join(dir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ lastBlock: 100, firstBlock: 100 }));
  const realStore = new TxnStore(path.join(dir, "store.json"));
  const realFlush = realStore.flush.bind(realStore);
  let fail = true;
  realStore.flush = () => {
    if (fail) { realStore.lastSaveError = "disk full"; return false; }
    return realFlush();
  };
  const provider = { send: async (method) => method === "eth_blockNumber"
    ? "0x65"
    : method === "eth_getBlockByNumber"
      ? { timestamp: "0x1", transactions: [] }
      : [] };
  const sampler = new TxnSampler({ provider, store: realStore, labelBook: labels(), stateFile, confirmationBlocks: 0 });
  await sampler.sample();
  assert.equal(sampler.lastBlock, 100);
  assert.match(sampler.lastError.error, /store persist failed/);
  fail = false;
  await sampler.sample();
  assert.equal(sampler.lastBlock, 101);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).lastBlock, 101);
});

test("sampler recovers its watermark from persisted block ranges when state is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-state-recover-"));
  const store = new TxnStore(path.join(dir, "store.json"));
  const row = { cat: "other", act: "other", gas: 1, to: "", sel: "0x", swap: 0, xfer: 0, parts: [], assets: [], flows: [], fail: false, rcptMiss: false };
  store.addBlock(Date.now(), [row], null, null, 100);
  store.addBlock(Date.now(), [row], null, null, 101);
  store.flush();
  const restored = new TxnStore(path.join(dir, "store.json"));
  const sampler = new TxnSampler({ provider: {}, store: restored, labelBook: labels(), stateFile: path.join(dir, "missing-state.json") });
  assert.equal(sampler.lastBlock, 101);
  assert.equal(sampler.firstBlock, 100);
});

test("late facts appended while an old hour is rotating remain replayable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-facts-rotate-"));
  const journal = new FactJournal(dir, 24);
  const t = Date.now() - 2 * 3600e3;
  journal.append([baseFact({ t, b: 10, i: 0 })]);
  journal.append([baseFact({ t, b: 10, i: 1 })]);
  const waitRotation = async () => {
    for (let i = 0; i < 100 && journal._gzipping?.size; i++) await new Promise((r) => setTimeout(r, 10));
  };
  await waitRotation();
  journal._rotate();
  await waitRotation();
  const ids = [];
  await journal.replay(t - 1, t + 1, (f) => ids.push(`${f.b}:${f.i}`));
  assert.deepEqual(ids.sort(), ["10:0", "10:1"]);
});
