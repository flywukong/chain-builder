/**
 * LabelCloud — bsc-trace-bk 地址身份客户端(无鉴权,批量 <=20)。
 *
 * 只提供可审计的地址身份证据和展示名,不直接决定交易 activity、asset 或 CEX flow。
 * verified 统计集合仍由 labels.js 管理；反查结果只能进入审计候选,人工核实后再晋升。
 *
 * 缓存纪律:命中 7d、未命中 1d;HTTP/网络错误不作负缓存并保留旧值。
 */

import fs from "fs";
import path from "path";

const DEFAULT_BASE = "https://bsc-mainnet-bsc-trace-bk-admin.nodereal.link";
const CACHE_SCHEMA = 2;
const TTL_HIT = 7 * 86400e3;
const TTL_MISS = 86400e3;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const text = (v) => typeof v === "string" && v.trim() ? v.trim() : null;
const number = (v) => v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
const sourceOf = (v) => text(v?.source) ?? null;
const genericIdentity = (s) => !s || /\b(trader|user|holder|whale)\s*$/i.test(s);
const uniq = (values) => [...new Set(values.filter(Boolean))];

const normalizeAddress = (v) => {
  const a = typeof v === "string" ? v.toLowerCase() : "";
  return ADDRESS_RE.test(a) ? a : null;
};

const compactLabels = (rows) => (rows ?? []).map((row) => ({
  name: text(row?.label),
  source: sourceOf(row),
  updateTime: number(row?.update_time),
})).filter((row) => row.name).sort((a, b) =>
  (b.updateTime ?? 0) - (a.updateTime ?? 0) || a.name.localeCompare(b.name));

const compactRoles = (rows) => (rows ?? []).map((row) => ({
  entity: text(row?.entity?.name),
  entityType: text(row?.entity?.type),
  role: text(row?.entity_role?.role),
  entitySource: sourceOf(row?.entity),
  roleSource: sourceOf(row?.entity_role),
})).filter((row) => row.entity || row.role).sort((a, b) =>
  Number(!!b.role) - Number(!!a.role)
  || (a.entity ?? "").localeCompare(b.entity ?? "")
  || (a.role ?? "").localeCompare(b.role ?? ""));

const compactTags = (rows) => (rows ?? []).map((row) => ({
  name: text(row?.tag?.name),
  type: text(row?.tag?.type),
  source: sourceOf(row?.tag),
})).filter((row) => row.name).sort((a, b) =>
  a.name.localeCompare(b.name) || (a.type ?? "").localeCompare(b.type ?? ""));

const compactRisks = (rows) => (rows ?? []).map((row) => ({
  name: text(row?.risk?.risk_name ?? row?.risk?.name),
  source: sourceOf(row?.risk),
})).filter((row) => row.name).sort((a, b) => a.name.localeCompare(b.name));

const compactCreateInfo = (row) => {
  if (!row) return null;
  const creator = normalizeAddress(row.creator);
  const deployTime = number(row.deploy_time);
  return creator || deployTime != null ? { creator, deployTime } : null;
};

const compactTokenMeta = (row) => {
  if (!row) return null;
  const out = {
    name: text(row.name), symbol: text(row.symbol), decimals: number(row.decimals),
    tokenType: text(row.token_type ?? row.tokenType),
  };
  return Object.values(out).some((v) => v != null) ? out : null;
};

/** Normalize one address-relations row into bounded, auditable evidence. */
export function parseLabelCloudRelation(row, fetchedAt = Date.now()) {
  const address = normalizeAddress(row?.query_address);
  if (!address) return null;
  const returned = normalizeAddress(row?.address?.address);
  const data = row?.address?.data ?? null;
  const labels = compactLabels(data?.labels);
  const entityRoles = compactRoles(row?.address_entity_roles);
  const tagEvidence = compactTags(row?.address_tags);
  const risks = compactRisks(row?.address_risks);
  const createInfo = compactCreateInfo(data?.create_info);
  const tokenMeta = compactTokenMeta(data?.token_meta);
  const addressType = number(row?.address?.type);

  const hasEvidence = returned && returned !== ZERO_ADDRESS && (
    labels.length || entityRoles.length || tagEvidence.length || risks.length
    || createInfo || tokenMeta || addressType
  );
  if (!hasEvidence) return { address, entry: { schema: CACHE_SCHEMA, miss: 1, fetchedAt, t: fetchedAt } };

  const entities = [];
  for (const role of entityRoles) {
    if (!role.entity || entities.some((e) => e.name === role.entity && e.type === role.entityType)) continue;
    entities.push({ name: role.entity, type: role.entityType, source: role.entitySource });
  }
  // 只有 update_time 最新的一条才是当前 label；若它只是行为标签则回退角色/实体，
  // 不能偷偷使用已经被上游更新替代的旧名称。
  const currentLabel = labels[0] ?? null;
  const bestLabel = currentLabel && !genericIdentity(currentLabel.name) ? currentLabel : null;
  const bestRole = entityRoles.find((item) => !genericIdentity(item.role)) ?? null;
  const onlyEntity = entities.length === 1 ? entities[0] : null;
  const name = bestLabel?.name ?? bestRole?.role ?? onlyEntity?.name ?? tokenMeta?.name ?? null;
  const nameEvidence = bestLabel ? { kind: "label", source: bestLabel.source, updateTime: bestLabel.updateTime }
    : bestRole ? { kind: "entity_role", source: bestRole.roleSource }
      : onlyEntity ? { kind: "entity", source: onlyEntity.source }
        : tokenMeta?.name ? { kind: "token_meta", source: null } : null;

  return {
    address,
    entry: {
      schema: CACHE_SCHEMA,
      name,
      nameEvidence,
      addressType,
      entity: onlyEntity?.name ?? null,
      entityType: onlyEntity?.type ?? null,
      entities,
      entityRoles,
      tags: tagEvidence.map((item) => item.name),
      evidence: { labels, entityRoles, tags: tagEvidence, risks, createInfo, tokenMeta },
      createInfo,
      tokenMeta,
      fetchedAt,
      t: fetchedAt,
    },
  };
}

export class LabelCloud {
  constructor(file, { fetchImpl = globalThis.fetch, base = process.env.LABEL_CLOUD_API_URL || DEFAULT_BASE } = {}) {
    this.file = file;
    this.fetch = fetchImpl;
    this.base = base.replace(/\/$/, "");
    this.cache = {};
    this.inflight = new Map();
    this.lastError = null;
    try {
      if (fs.existsSync(file)) this.cache = JSON.parse(fs.readFileSync(file, "utf8")) || {};
    } catch { this.cache = {}; }
  }

  get(addr) {
    const address = normalizeAddress(addr);
    if (!address) return null;
    const entry = this.cache[address];
    return entry && !entry.miss ? entry : null;
  }

  publicEvidence(addr) {
    const entry = typeof addr === "string" ? this.get(addr) : addr;
    if (!entry || entry.miss) return null;
    return {
      name: entry.name ?? null,
      nameEvidence: entry.nameEvidence ?? null,
      addressType: entry.addressType ?? null,
      entity: entry.entity ?? null,
      entityType: entry.entityType ?? null,
      entities: entry.entities ?? [],
      entityRoles: entry.entityRoles ?? [],
      tags: entry.tags ?? [],
      createInfo: entry.createInfo ?? null,
      tokenMeta: entry.tokenMeta ?? null,
      fetchedAt: entry.fetchedAt ?? entry.t ?? null,
    };
  }

  _fresh(entry) {
    return entry?.schema === CACHE_SCHEMA
      && Date.now() - (entry.fetchedAt ?? entry.t ?? 0) < (entry.miss ? TTL_MISS : TTL_HIT);
  }

  _persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.cache));
    fs.renameSync(tmp, this.file);
  }

  async _resolveBatch(batch) {
    try {
      const res = await this.fetch(`${this.base}/api/v1/label-cloud/address-relations-batch?addresses=${batch.join(",")}`,
        { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`label cloud HTTP ${res.status}`);
      const body = await res.json();
      const allowed = new Set(batch);
      let updated = 0;
      for (const row of body?.data ?? []) {
        const parsed = parseLabelCloudRelation(row);
        if (!parsed || !allowed.has(parsed.address)) continue;
        this.cache[parsed.address] = parsed.entry;
        updated++;
      }
      if (updated) this._persist();
      this.lastError = null;
      return updated;
    } catch (error) {
      // 请求失败不写 miss,也不覆盖已经存在的陈旧命中。
      this.lastError = error?.message || "label cloud request failed";
      return 0;
    }
  }

  /** Resolve unique addresses with per-address in-flight coalescing. */
  async resolve(addrs) {
    const need = uniq((addrs ?? []).map(normalizeAddress))
      .filter((address) => !this._fresh(this.cache[address]));
    if (!need.length) return 0;

    const waiting = [];
    const owned = [];
    for (const address of need) {
      const current = this.inflight.get(address);
      if (current) waiting.push(current);
      else owned.push(address);
    }
    const ownJobs = [];
    for (let i = 0; i < owned.length; i += 20) {
      const batch = owned.slice(i, i + 20);
      let job;
      job = this._resolveBatch(batch).finally(() => {
        for (const address of batch) if (this.inflight.get(address) === job) this.inflight.delete(address);
      });
      for (const address of batch) this.inflight.set(address, job);
      ownJobs.push(job);
    }
    await Promise.all(waiting);
    const counts = await Promise.all(ownJobs);
    return counts.reduce((sum, value) => sum + value, 0);
  }
}
