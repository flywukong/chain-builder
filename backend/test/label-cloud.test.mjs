import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LabelCloud, parseLabelCloudRelation } from "../src/txn/labelCloud.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const CREATOR = "0x2222222222222222222222222222222222222222";

const relation = (overrides = {}) => ({
  query_address: ADDRESS,
  address: {
    address: ADDRESS,
    type: 2,
    data: {
      labels: [
        { label: "Old name", source: "manual", update_time: 10 },
        { label: "PancakeRouter", source: "dune", update_time: 20 },
      ],
      create_info: { creator: CREATOR, deploy_time: 1234 },
      token_meta: { name: "Cake LP", symbol: "CAKE-LP", decimals: 18, token_type: "ERC20" },
    },
  },
  address_entity_roles: [
    { entity: { name: "pancakeswap", type: "DEX", source: "dune" } },
    {
      entity: { name: "pancakeswap", type: "DEX", source: "dune" },
      entity_role: { role: "PancakeRouter", source: "dune" },
    },
  ],
  address_tags: [
    { tag: { name: "DEX Trader", type: "Identity", source: "dune" } },
    { tag: { name: "Pancakeswap", type: "Identity", source: "dune" } },
  ],
  address_risks: [{ risk: { risk_name: "Example Risk", source: "auditor" } }],
  ...overrides,
});

test("relation parser preserves auditable evidence and chooses the newest label", () => {
  const parsed = parseLabelCloudRelation(relation(), 9999);
  assert.equal(parsed.address, ADDRESS);
  assert.equal(parsed.entry.name, "PancakeRouter");
  assert.deepEqual(parsed.entry.nameEvidence, { kind: "label", source: "dune", updateTime: 20 });
  assert.equal(parsed.entry.entity, "pancakeswap");
  assert.equal(parsed.entry.entityRoles.length, 2);
  assert.equal(parsed.entry.entityRoles[0].role, "PancakeRouter");
  assert.deepEqual(parsed.entry.tags, ["DEX Trader", "Pancakeswap"]);
  assert.deepEqual(parsed.entry.createInfo, { creator: CREATOR, deployTime: 1234 });
  assert.deepEqual(parsed.entry.tokenMeta, { name: "Cake LP", symbol: "CAKE-LP", decimals: 18, tokenType: "ERC20" });
  assert.equal(parsed.entry.evidence.labels[0].source, "dune");
  assert.equal(parsed.entry.evidence.risks[0].source, "auditor");
});

test("unordered tags never become a display name", () => {
  const parsed = parseLabelCloudRelation(relation({
    address: { address: ADDRESS, type: 2, data: null },
    address_entity_roles: [],
    address_tags: [{ tag: { name: "Some Protocol", source: "dune" } }],
    address_risks: [],
  }));
  assert.equal(parsed.entry.name, null);
  assert.deepEqual(parsed.entry.tags, ["Some Protocol"]);
});

test("a generic current label does not revive an older superseded name", () => {
  const parsed = parseLabelCloudRelation(relation({
    address: { address: ADDRESS, type: 2, data: { labels: [
      { label: "DEX Trader", source: "dune", update_time: 30 },
      { label: "Superseded Router", source: "dune", update_time: 20 },
    ] } },
    address_entity_roles: [{ entity: { name: "current protocol", type: "DEX", source: "dune" } }],
    address_tags: [], address_risks: [],
  }));
  assert.equal(parsed.entry.name, "current protocol");
  assert.deepEqual(parsed.entry.nameEvidence, { kind: "entity", source: "dune" });
  assert.equal(parsed.entry.evidence.labels[0].name, "DEX Trader");
});

test("zero-address placeholders become explicit short-lived misses", () => {
  const parsed = parseLabelCloudRelation(relation({
    address: { address: "0x0000000000000000000000000000000000000000", type: 0, data: null },
    address_entity_roles: [], address_tags: [], address_risks: [],
  }), 123);
  assert.equal(parsed.entry.miss, 1);
  assert.equal(parsed.entry.fetchedAt, 123);
});

test("client coalesces concurrent lookups and reuses the versioned cache", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "label-cloud-"));
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true, json: async () => ({ data: [relation()] }) };
  };
  const cloud = new LabelCloud(path.join(dir, "cache.json"), { fetchImpl, base: "https://labels.test" });
  await Promise.all([cloud.resolve([ADDRESS]), cloud.resolve([ADDRESS])]);
  assert.equal(calls, 1);
  assert.equal(cloud.get(ADDRESS).name, "PancakeRouter");
  assert.equal((await cloud.resolve([ADDRESS])), 0);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "cache.json"), "utf8"))[ADDRESS].schema, 2);
});

test("request failures do not create negative cache entries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "label-cloud-error-"));
  const cloud = new LabelCloud(path.join(dir, "cache.json"), {
    fetchImpl: async () => { throw new Error("offline"); }, base: "https://labels.test",
  });
  assert.equal(await cloud.resolve([ADDRESS]), 0);
  assert.equal(cloud.get(ADDRESS), null);
  assert.equal(cloud.cache[ADDRESS], undefined);
  assert.equal(cloud.lastError, "offline");
});
