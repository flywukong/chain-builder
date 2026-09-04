/**
 * Pull Label Cloud entity reverse indexes into an audit-only snapshot.
 *
 * Default scope is CEX. Results never mutate labels.js or transaction statistics;
 * promote an address to the verified registry only after independent review.
 *
 *   npm run audit:labels
 *   LABEL_CLOUD_AUDIT_ENTITY_TYPES=CEX,DEX npm run audit:labels
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STATIC_LABELS } from "../src/txn/labels.js";

const base = (process.env.LABEL_CLOUD_API_URL
  || "https://bsc-mainnet-bsc-trace-bk-admin.nodereal.link").replace(/\/$/, "");
const wantedTypes = new Set((process.env.LABEL_CLOUD_AUDIT_ENTITY_TYPES || "CEX")
  .split(",").map((v) => v.trim().toLowerCase()).filter(Boolean));
const wantedIds = new Set((process.env.LABEL_CLOUD_AUDIT_ENTITY_IDS || "")
  .split(",").map((v) => Number(v.trim())).filter(Number.isFinite));
const here = path.dirname(fileURLToPath(import.meta.url));
const output = process.env.LABEL_CLOUD_AUDIT_FILE
  ? path.resolve(process.env.LABEL_CLOUD_AUDIT_FILE)
  : path.resolve(here, "../data/label-cloud-identity-audit.json");

const fetchJson = async (pathname) => {
  const res = await fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${pathname}: HTTP ${res.status}`);
  return res.json();
};
const rowsOf = (body) => Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
const idOf = (row) => Number(row?.ID ?? row?.id);
const addressOf = (row) => String(row?.address ?? "").toLowerCase();

const catalog = rowsOf(await fetchJson("/api/v1/label-cloud/entities"));
const entities = catalog.map((row) => row?.entity ?? row).filter((entity) =>
  Number.isFinite(idOf(entity))
  && wantedTypes.has(String(entity?.type ?? "").toLowerCase())
  && (!wantedIds.size || wantedIds.has(idOf(entity))));
const verified = new Set(Object.entries(STATIC_LABELS)
  .filter(([, label]) => label.status === "verified")
  .map(([address]) => address));

const jobs = [];
for (const entity of entities) {
  for (const addressType of [1, 2, 3]) jobs.push({ entity, addressType });
}
let next = 0;
const records = [];
const failures = [];
const worker = async () => {
  while (next < jobs.length) {
    const { entity, addressType } = jobs[next++];
    const entityId = idOf(entity);
    try {
      const body = await fetchJson(`/api/v1/label-cloud/addresses-by-entity?type=${addressType}&entity_id=${entityId}`);
      for (const row of rowsOf(body)) {
        const address = addressOf(row);
        if (!/^0x[0-9a-f]{40}$/.test(address)) continue;
        records.push({
          address,
          addressType,
          entityId,
          entity: entity.name ?? null,
          entityType: entity.type ?? null,
          source: entity.source ?? null,
          alreadyVerified: verified.has(address),
        });
      }
    } catch (error) {
      failures.push({ entityId, addressType, error: error?.message || "request failed" });
    }
  }
};
await Promise.all(Array.from({ length: Math.min(5, jobs.length || 1) }, worker));

const deduped = [...new Map(records.map((row) => [`${row.address}:${row.entityId}:${row.addressType}`, row])).values()]
  .sort((a, b) => a.entity.localeCompare(b.entity) || a.address.localeCompare(b.address));
const snapshot = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  source: `${base}/api/v1/label-cloud`,
  filters: { entityTypes: [...wantedTypes], entityIds: [...wantedIds] },
  policy: "audit_only_never_auto_promote",
  entities: entities.length,
  addresses: deduped.length,
  alreadyVerified: deduped.filter((row) => row.alreadyVerified).length,
  candidates: deduped.filter((row) => !row.alreadyVerified).length,
  failures,
  records: deduped,
};
fs.mkdirSync(path.dirname(output), { recursive: true });
const tmp = `${output}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
fs.renameSync(tmp, output);
console.log(`[label audit] ${snapshot.addresses} addresses from ${snapshot.entities} entities; ${snapshot.candidates} candidates -> ${output}`);
if (failures.length) console.warn(`[label audit] ${failures.length} reverse-index requests failed; snapshot is partial`);
