/**
 * LabelCloud — NodeReal bsc-trace-bk 地址标签库客户端(dune 同步源,无鉴权,批量 ≤20)。
 *
 * 实测覆盖(2026-08-31):知名协议合约命中好(PancakeRouter 全套),高频无名新合约命中率 ~5%,
 * CEX 主力热钱包缺失 —— 定位为**补充证据源**(AI labeler 证据 + 热门合约补名),
 * 不参与任何统计维度,不覆盖 static/learned 标签。
 *
 * 缓存纪律(上游文档强调):命中 7d、未命中 1d 重试;HTTP/网络错误整批不缓存(错误 ≠ 无标签)。
 */

import fs from "fs";
import path from "path";

const BASE = process.env.LABEL_CLOUD_API_URL || "https://bsc-mainnet-bsc-trace-bk-admin.nodereal.link";
const TTL_HIT = 7 * 86400e3;
const TTL_MISS = 86400e3;

export class LabelCloud {
  constructor(file) {
    this.file = file;
    this.cache = {};
    try {
      if (fs.existsSync(file)) this.cache = JSON.parse(fs.readFileSync(file, "utf8")) || {};
    } catch { this.cache = {}; }
  }

  // 仅返回命中条目 {name, entity, entityType, tags[], mev?};未命中/未查询返回 null
  get(addr) {
    const e = this.cache[(addr || "").toLowerCase()];
    return e && !e.miss ? e : null;
  }

  // 缓存中全部带 MEV Tracker 风险标的地址(供 participants 维度的 mev_bot 判定)
  mevSet() {
    const s = new Set();
    for (const [a, e] of Object.entries(this.cache)) if (e.mev && this._fresh(e)) s.add(a);
    return s;
  }

  _fresh(e) { return e && Date.now() - e.t < (e.miss ? TTL_MISS : TTL_HIT); }

  // 解析一批地址(自动跳过新鲜缓存),失败静默——调用方把它当尽力而为的增强
  async resolve(addrs) {
    const need = [...new Set(addrs.map((a) => (a || "").toLowerCase()))]
      .filter((a) => a.startsWith("0x") && !this._fresh(this.cache[a]));
    if (!need.length) return 0;
    let updated = 0;
    for (let i = 0; i < need.length; i += 20) {
      const batch = need.slice(i, i + 20);
      try {
        const res = await fetch(`${BASE}/api/v1/label-cloud/address-relations-batch?addresses=${batch.join(",")}`,
          { signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;                      // 错误不作负缓存
        const j = await res.json();
        for (const r of j.data ?? []) {
          const a = (r.query_address || "").toLowerCase();
          if (!a) continue;
          const labels = r.address?.data?.labels ?? [];
          const ent = r.address_entity_roles?.[0]?.entity ?? null;
          const tags = (r.address_tags ?? []).map((t) => t.tag?.name).filter(Boolean).slice(0, 6);
          // MEV Activity 风险标:BNB Chain MEV Tracker 的三明治行为检测背书(非 AI 推断)
          const mev = (r.address_risks ?? []).some((x) =>
            x.risk?.risk_name === "MEV Activity" || /MEV Tracker/i.test(x.risk?.source ?? ""));
          if (labels.length || ent || tags.length || mev) {
            const best = [...labels].sort((x, y) => (y.update_time || 0) - (x.update_time || 0))[0];
            // 行为型标签(“DEX Trader”“Apeswap User”)不当名字:身份≠行为,回落 entity 名或不补
            const generic = (s) => !s || /\b(trader|user|holder|whale)\s*$/i.test(s);
            this.cache[a] = {
              name: (!generic(best?.label) && best.label) || ent?.name || (!generic(tags[0]) && tags[0]) || null,
              entity: ent?.name ?? null, entityType: ent?.type ?? null,
              tags, ...(mev ? { mev: 1 } : {}), t: Date.now(),
            };
          } else {
            this.cache[a] = { miss: 1, t: Date.now() };
          }
          updated++;
        }
      } catch { /* 网络错误:跳过,不缓存 */ }
    }
    if (updated) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.cache));
      } catch {}
    }
    return updated;
  }
}
