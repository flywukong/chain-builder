/**
 * Keter 日志检索(ES)— AP 区域 validator/fullnode 日志。
 * 端点 POST {KETER_API_BASE}/api/es/search/kql,payload 形态逆向自 keter UI bundle;
 * 鉴权复用 .keter.json 的 JWT。单页上限 1000 条;日志量 ~540 万条/天,
 * 查询务必窄:时间窗 × host × lucene query 至少给两个维度。
 *
 * ⚠ 数值区间陷阱:fields.* 全部以「字符串」入索引(elapsed 还带 ms 后缀),
 * lucene 的 `fields.xxx:>N` / `[a TO b]` 是字典序比较 —— 会返回看似合理、实则错误的结果
 * (实测 elapsed:>100 命中 46ms 的行)。精确匹配(fields.number:117014781)不受影响。
 * 需要数值筛选时:窄化窗口拉回 ≤1000 条后在本地 parseFloat 处理;全量数值扫描请改走 keter 指标。
 */

import { keterPost } from "./client.js";

const APP = {
  team_name: "bnbchain", biz_name: "dex",
  app_name: "bnbchain-dex-ec2-logs", index: "bnbchain-dex-ec2-logs",
};

export async function searchLogs(configPath, { query = "", fromMs, toMs, order = "desc" } = {}) {
  const body = {
    query, search_type: "lucene", time_order: order, filter: [],
    fixed_interval: "60000ms",
    time_start: new Date(fromMs).toISOString(),
    time_end: new Date(toMs).toISOString(),
    ...APP,
  };
  const d = await keterPost("/api/es/search/kql", body, { configPath });
  const rows = (d.hits?.hits ?? []).map((h) => h._source).map((s) => ({
    t: s["@timestamp"], host: s.hostName, role: s.nodeRole, level: s.level,
    msg: s.message, fields: s.fields ?? null, logFile: s.logFile,
  }));
  return { total: d.hits?.total?.value ?? rows.length, rows };
}

// 单节点时间窗日志(喂 AI 证据):该 host 全级别日志,升序压缩成文本行
export async function fetchHostLogs(configPath, ip, fromMs, toMs, { query = "", max = 120 } = {}) {
  const q = `hostName:"${ip}"` + (query ? ` AND (${query})` : "");
  const { total, rows } = await searchLogs(configPath, { query: q, fromMs, toMs, order: "asc" });
  return { host: ip, total, lines: rows.slice(0, max).map(fmtLine) };
}

export function fmtLine(r) {
  const f = r.fields ? Object.entries(r.fields).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(" ") : "";
  return `${(r.t || "").slice(11, 23)} ${r.level} ${r.msg}${f ? " · " + f : ""}`;
}

// 消息聚类:去掉 hash/数字等参数后归并成模式,带出现次数、涉及节点、样本字段与角色(供 AI 定级)
export function clusterMessages(rows) {
  const norm = (m) => (m || "").replace(/0x[0-9a-fA-F]{6,}/g, "0x…").replace(/\d[\d.,]*/g, "N").slice(0, 140);
  const kv = (f) => f ? Object.entries(f).slice(0, 10).map(([k, v]) => `${k}=${v}`).join(" ") : "";
  const map = new Map();
  for (const r of rows) {
    const k = norm(r.msg);
    const e = map.get(k) ?? { pattern: k, count: 0, hostSet: new Set(), roleSet: new Set(),
                              sample: r.msg, sampleExtra: kv(r.fields).slice(0, 300), lastT: r.t, level: r.level };
    e.count++;
    e.hostSet.add(r.host);
    if (r.role) e.roleSet.add(r.role);
    if (r.t > e.lastT) e.lastT = r.t;
    map.set(k, e);
  }
  return [...map.values()].sort((a, b) => b.count - a.count).map(({ hostSet, roleSet, ...e }) => ({
    ...e, hostCount: hostSet.size, hosts: [...hostSet].slice(0, 8), roles: [...roleSet],
  }));
}
