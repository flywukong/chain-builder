import { useEffect, useState } from "react";
import { aiRequest } from "../lib/ai.js";
import { AiText } from "../components/PanelAi.jsx";
import { lookupValidator } from "../data/validators.js";
import BidMetricsPanel from "../components/BidMetricsPanel.jsx";
import GreedyMergePanel from "../components/GreedyMergePanel.jsx";
import RobotWidget from "../components/RobotWidget.jsx";

const API = import.meta.env.VITE_API_BASE ?? "";

// MEV 格局 AI 分析:按钮 + 结果面板(claude,数据=2000块窗口聚合)
function MevAiBox() {
  const [s, setS] = useState({ loading: false, text: null, at: null, err: null });
  const run = async () => {
    setS((x) => ({ ...x, loading: true, err: null }));
    try {
      const d = await aiRequest("/api/ai/mev");
      if (d.error) setS({ loading: false, text: null, at: null, err: d.error });
      else setS({ loading: false, text: d.text, at: d.at, err: null });
    } catch (e) { setS({ loading: false, text: null, at: null, err: String(e) }); }
  };
  return { s, run };
}

// miner may be an address (from live aggregator) or already a moniker (from mev.log)
const minerName = (m) => (m && m.startsWith("0x") ? lookupValidator(m).name : m);

const FAMILY_COLORS = {
  blockrazor: "#F0B90B", "48club": "#45B8FF", blockroute: "#38bdf8", jetbldr: "#22c55e",
  nodereal: "#f97316", txboost: "#ec4899", blockbus: "#5BC8D8", darwin: "#B6CC52",
  inblock: "#9A86F0", unknown: "#8A8F99", xzbuilder: "#8A8F99", trustnet: "#8A8F99",
  local: "#6d675a",
};

const fmtBbT = (t) => new Date(t).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

// 坏块错误原因配色:1 号(最大头)红,依次错开;分布条/主要错误点/事故表错误列同色联动
const ERR_IDX_COLORS = ["#F6465D", "#FF9F1C", "#45B8FF", "#22c55e", "#ec4899", "#9A86F0"];
const errIdxColor = (ix) => ERR_IDX_COLORS[(ix - 1) % ERR_IDX_COLORS.length];
// 归一化错误键 → 英文短标签(展示用;悬停仍可见原始键/样本)
const ERR_SHORT = {
  "invalid merkle root · remote全0": "StateRoot zero",
  "invalid merkle root": "StateRoot mismatch",
  "invalid bloom": "Bloom mismatch",
};
const errShort = (k) => ERR_SHORT[k] ?? (k || "—");

// builder 实例名 → 家族(首词);puissant 系与 48club 同源,归并
const BB_FAMILY_ALIAS = { puissant: "48club" };
const famOf = (name) => {
  const w = (name ?? "?").split(" ")[0].toLowerCase();
  return BB_FAMILY_ALIAS[w] ?? w;
};

// V2 采用率趋势(24h 小时线 + 7d 均值虚线基准);丢弃当前未满小时,末点即最近完整小时
function V2TrendChart({ hourly, bph }) {
  const now = Date.now();
  const curHk = Math.floor(now / 3600e3);
  const done = (hourly ?? []).filter((h) => Math.floor(h.t / 3600e3) < curHk);
  const h24 = done.filter((h) => h.t >= now - 25 * 3600e3);
  const h7 = done.filter((h) => h.t >= now - 7 * 86400e3);
  if (h24.length < 3) return <div className="ph-note">小时序列积累中(部署后自动补齐)…</div>;
  const rate = (h) => Math.min(100, (h.total / bph) * 100);
  const avg7 = h7.reduce((s, h) => s + rate(h), 0) / h7.length;
  const cur = rate(h24[h24.length - 1]);
  const W = 320, H = 104;
  const px = (i) => (i / (h24.length - 1)) * W;
  const py = (r) => 4 + (H - 8) * (1 - r / 100);
  const pts = h24.map((h, i) => `${px(i).toFixed(1)},${py(rate(h)).toFixed(1)}`).join(" ");
  const fmtH = (t) => new Date(t).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
  return (
    <>
      <div className="v2x-trend-head">
        <span className="re-title">V2 采用率趋势(24h · 小时)</span>
        <b>{cur.toFixed(1)}%</b>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="v2x-svg" preserveAspectRatio="none">
        {[25, 50, 75].map((g) => <line key={g} x1="0" x2={W} y1={py(g)} y2={py(g)} stroke="rgba(255,255,255,.06)" strokeWidth="1" />)}
        <line x1="0" x2={W} y1={py(avg7)} y2={py(avg7)} stroke="#8A8F99" strokeWidth="1" strokeDasharray="4 3" />
        <polyline points={pts} fill="none" stroke="#F0B90B" strokeWidth="1.6" />
      </svg>
      <div className="v2x-axis"><span>{fmtH(h24[0].t)}</span><span>{fmtH(h24[Math.floor(h24.length / 2)].t)}</span><span>{fmtH(h24[h24.length - 1].t)}</span></div>
      <div className="v2x-legend"><i className="v2x-li" /> V2 采用率 <i className="v2x-li dash" /> 7d 均值 {avg7.toFixed(1)}%<span className="v2x-note">分母 = 每小时链上总块数(450ms/块)</span></div>
    </>
  );
}

export default function MevPage({ state }) {
  const mev = state.mevStats;
  const { s: ai, run: runAi } = MevAiBox();
  // v2(SendBidBlock)观测:主网未激活,出现即代表有 builder 在提前灰度
  const [bb, setBb] = useState(null);
  // 坏块 bidblock 归因(2 台灰度探针机:metric + BAD BLOCK 日志)
  const [bad, setBad] = useState(null);
  const [badTab, setBadTab] = useState("3d");    // 事故表时间窗:24h / 3d / 7d / All,默认 3d
  const [badQ, setBadQ] = useState("");          // 事故表搜索:builder/validator/块高/hash
  const [badOpen, setBadOpen] = useState(null);  // 展开的事故行(hash)
  const [badPage, setBadPage] = useState(-1);    // 事故表分页:-1=收起(仅前10),≥0=展开后的页码(10/页)
  const copyText = (t) => { try { navigator.clipboard?.writeText(t); } catch { /* http 环境无 clipboard */ } };
  // 错误原因 → 序号(按块数排序,1 = 最大头);分布条与事故表错误列同色联动
  const badErrIdx = new Map((bad?.byError ?? []).map((e, i) => [e.key, i + 1]));
  const badErrColor = (k) => (badErrIdx.get(k) ? errIdxColor(badErrIdx.get(k)) : "var(--muted)");
  useEffect(() => {
    let alive = true;
    const pull = () => fetch(API + "/api/bidblock").then((r) => r.json()).then((j) => { if (alive) setBb(j); }).catch(() => {});
    const pullBad = () => fetch(API + "/api/bad-bidblock").then((r) => r.json()).then((j) => { if (alive && !j.error) setBad(j); }).catch(() => {});
    pull(); pullBad();
    const t = setInterval(pull, 60_000);
    const t2 = setInterval(pullBad, 60_000);
    return () => { alive = false; clearInterval(t); clearInterval(t2); };
  }, []);

  if (!mev) {
    return (
      <div className="subpage">
        <div className="subpage-head">
          <div><h1>💎 MEV 分析</h1><p>Builder 出块格局 · MEV 占比 · v1/v2 路径</p></div>
        </div>
        <div className="subpage-body"><div className="ph-note">MEV 窗口积累中（实时采集 · WS newHeads）…</div></div>
      </div>
    );
  }

  // 四卡:24h 小时桶口径(旧后端无 day24 时回退 2000 窗口)
  const d24 = mev.day24 ?? null;
  const tc = mev.typeCounts ?? {};
  const cards = d24
    ? { mevPct: d24.mevPct, v2Pct: d24.v2Pct, v2: d24.v2Count ?? 0, v1: d24.v1Count, local: d24.localCount }
    : { mevPct: mev.mevPct, v2Pct: mev.v2Pct, v2: tc.mev_v2 ?? 0, v1: tc.mev_v1 ?? 0, local: tc.local ?? 0 };
  // builder 分布:历史累计(重启续算);旧后端回退 2000 窗口
  const fams = mev.buildersAll ?? mev.builderFamilies ?? [];
  const maxFam = Math.max(1, ...fams.map((f) => f[1]));
  const famTotal = fams.reduce((s, f) => s + f[1], 0);
  const famSince = mev.buildersSince ? new Date(mev.buildersSince) : null;
  // 集中度(24h)与 instance 拆分
  const conc = mev.concentration ?? null;
  const insts = mev.instances ?? [];
  const maxInst = Math.max(1, ...insts.map((i) => i.n));
  const vbRows = mev.validatorBuilders ?? [];
  const hhiInfo = (h) => (h < 1500 ? ["分散", "var(--green)"] : h <= 2500 ? ["中等集中", "var(--gold)"] : ["高度集中", "var(--orange)"]);
  // 占比格式化:非零但舍入到 0 的显示「<1%」,避免 1,872 块被写成 0% 的误解
  const fmtPct = (n, total) => {
    if (!total || n <= 0) return "0%";
    const p = (n / total) * 100;
    return p < 1 ? "<1%" : `${Math.round(p)}%`;
  };
  const fmtDelta = (pct, prevPct) => {
    if (prevPct == null) return <span style={{ color: "var(--dim)" }}>—</span>;
    const d = pct - prevPct;
    if (d > 0.05) return <span style={{ color: "var(--gold)" }}>▲{d.toFixed(1)}</span>;
    if (d < -0.05) return <span style={{ color: "#3FB8A0" }}>▼{Math.abs(d).toFixed(1)}</span>;
    return <span style={{ color: "var(--muted)" }}>—</span>;
  };
  // validator 运行版本(extraData 解析);最新版绿、落后橙
  const vers = mev.minerVersions ?? {};
  const verKey = (v) => (v || "").replace("v", "").split(".").map(Number);
  const latestVer = Object.values(vers).sort((a, b) => {
    const [a1=0,a2=0,a3=0] = verKey(a), [b1=0,b2=0,b3=0] = verKey(b);
    return (a1-b1) || (a2-b2) || (a3-b3);
  }).at(-1);

  return (
    <div className="subpage">
      <div className="subpage-head">
        <div>
          <h1>💎 MEV 分析</h1>
          <p>Builder 出块格局 · MEV 占比 · v1/v2 路径(BEP-675 已随 Pasteur 激活)· 指标窗口 24 小时</p>
        </div>
        <div className="ai-bar">
          <button className="st-auto-btn ai-cta" onClick={runAi} disabled={ai.loading}>
            {ai.loading ? "分析中… 约 20–30s" : "⚡ MEV 格局分析"}
          </button>
        </div>
      </div>

      <div className="subpage-body">
        {ai.err && <div className="ai-err" style={{ maxWidth: 1240 }}>⚠ {ai.err}</div>}
        {ai.text && (
          <div className="panel" style={{ maxWidth: 1240 }}>
            <div className="panel-header"><span>🤖 AI 格局分析</span><span className="sub">claude code{ai.at ? ` · ${new Date(ai.at).toLocaleTimeString()}` : ""}</span></div>
            <div className="panel-body"><div className="ai-result" style={{ padding: "10px 14px" }}><AiText text={ai.text} /></div></div>
          </div>
        )}
        <div className="stat-cards mev-cards">
          <div className="stat-card"><div className="sc-v" style={{ color: "var(--gold)" }}>{cards.mevPct}%</div><div className="sc-l">MEV 占比 · 24h</div></div>
          {/* header.RequestsHash 的 version 字节 = 2。BEP-675 已随 Pasteur 硬分叉于 2026-08-25 10:30(UTC+8)在主网激活 */}
          <div className="stat-card sc-card-v2" title="判据:header.RequestsHash 的 version 字节 = 2(BEP-675 SendBidBlock 编码)。Pasteur 硬分叉已于 2026-08-25 10:30(UTC+8)在主网激活,bid-block 为协议内正式出块路径。">
            <div className="sc-v" style={{ color: "#FF9F1C" }}><span className="sc-ico">⚡</span>{cards.v2.toLocaleString()}<span className="sc-sub-pct">({cards.v2Pct}% MEV)</span></div>
            <div className="sc-l">header 标记 v2 (bid-block) 块 · 24h<span className="sc-bep">Pasteur 已激活</span></div>
          </div>
          <div className="stat-card">
            <div className="sc-v" style={{ color: "var(--green)" }}><span className="sc-ico">◇</span>{cards.v1.toLocaleString()}</div>
            <div className="sc-l">mev-v1 (bid) 块 · 24h</div>
          </div>
          <div className="stat-card"><div className="sc-v" style={{ color: "var(--muted)" }}>{cards.local.toLocaleString()}</div><div className="sc-l">local（非MEV）块 · 24h</div></div>
        </div>

        {/* Builder 集中度:MEV 出块是否被少数 builder 过度集中(24h,环比上一 24h) */}
        {conc?.top1 && (
          <div className="stat-cards mev-cards">
            <div className="stat-card">
              <div className="sc-v" style={{ color: FAMILY_COLORS[conc.top1.name] || "var(--gold)" }}>{conc.top1.pct}%</div>
              <div className="sc-l">Top1 · {conc.top1.name}</div>
            </div>
            <div className="stat-card">
              <div className="sc-v" style={{ color: FAMILY_COLORS[conc.top2?.name] || "var(--text)" }}>{conc.top2?.pct ?? 0}%</div>
              <div className="sc-l">Top2 · {conc.top2?.name ?? "—"}</div>
            </div>
            <div className="stat-card">
              <div className="sc-v" style={{ color: hhiInfo(conc.hhi)[1] }}>{conc.hhi.toLocaleString()}</div>
              <div className="sc-l">HHI 集中度 · {hhiInfo(conc.hhi)[0]}</div>
            </div>
            <div className="stat-card">
              <div className="sc-v" style={{ color: !conc.hasPrev ? "var(--dim)" : (conc.top1.pct - conc.top1.prevPct) > 0 ? "var(--orange)" : "var(--green)" }}>
                {conc.hasPrev ? `${conc.top1.pct - conc.top1.prevPct >= 0 ? "+" : ""}${(conc.top1.pct - conc.top1.prevPct).toFixed(1)}` : "—"}
              </div>
              <div className="sc-l">{conc.hasPrev ? `${conc.top1.name} 环比 · vs 上一 24h` : "环比 · 前一窗口积累中"}</div>
            </div>
          </div>
        )}

        {/* Builder 分布(核心):历史累计 + 24h/7d 对照,单列 */}
        <div className="panel" style={{ maxWidth: 936 }}>
          <div className="panel-header">
            <span>Builder 分布</span>
            <span className="sub">历史累计{famSince ? ` · 自 ${famSince.getMonth() + 1}/${famSince.getDate()}` : ""} · {famTotal.toLocaleString()} 块 · 右两列为 24h / 7d 份额与环比{(mev.fams7dHours ?? 168) < 160 ? ` · 7d 桶积累中 ${mev.fams7dHours}/168h` : ""}</span>
          </div>
          <div className="panel-body mev-bars">
            {fams.map(([f, c]) => {
              const d24 = (mev.famsDay ?? []).find((x) => x.name === f);
              const d7 = (mev.fams7d ?? []).find((x) => x.name === f);
              return (
                <div key={f} className="ver-row">
                  <span className="ver-tag" style={{ width: 92, color: FAMILY_COLORS[f] || "#aaa" }}>{f}</span>
                  <div className="ver-bar-track"><div className="ver-bar" style={{ width: `${(c / maxFam) * 100}%`, background: FAMILY_COLORS[f] || "#888" }} /></div>
                  <span className="ver-count">{c.toLocaleString()}<em>· {fmtPct(c, famTotal)}</em></span>
                  <span className="fam-24h">{d24 ? <>24h {d24.pct}% {fmtDelta(d24.pct, d24.prevPct)}</> : <em>—</em>}</span>
                  <span className="fam-24h fam-7d">{d7 ? <>7d {d7.pct}% {fmtDelta(d7.pct, d7.prevPct)}</> : <em>—</em>}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* BID-BLOCK (v2) 观测:份额表(家族/实例 + 24h/7d/自激活)| 采用率趋势 + 出块路径分布 */}
        <div className="panel" style={{ maxWidth: 1240 }}>
          <div className="panel-header">
            <span>BID-BLOCK (V2) 观测
              {bb && (() => {
                const live = bb.lastT && Date.now() - bb.lastT < 5 * 60e3;
                return (
                  <em className={`panel-verdict pv-${live ? "warn" : bb.count ? "mid" : "ok"}`}>
                    {bb.count ? `${live ? "⚡ 出块中 · " : ""}${bb.count.toLocaleString()} 块` : "未观测到 v2 块"}
                  </em>
                );
              })()}
            </span>
            <span className="sub">判据 header.RequestsHash version=2 · Pasteur 已激活 · 自激活累计</span>
          </div>
          <div className="panel-body">
            {!bb || bb.count === 0 ? (
              <div className="ph-note">激活时刻以来暂无 bid-block 标记块(回扫可能仍在进行,首次部署自激活块补齐约需数分钟)。</div>
            ) : (
              <div className="v2x-cols">
                {/* 左:家族份额 + 实例明细(旧版样式,自激活累计) */}
                <div>
                  <div className="re-title">BUILDER 家族份额(同家实例汇总)</div>
                  {(() => {
                    const famsM = new Map();
                    for (const b of bb.builders) {
                      const f = famOf(b.name);
                      famsM.set(f, (famsM.get(f) ?? 0) + b.count);
                    }
                    const rows = [...famsM.entries()].sort((a, x) => x[1] - a[1]);
                    return rows.map(([f, c]) => (
                      <div key={f} className="eb-miner">
                        <em style={{ color: FAMILY_COLORS[f] || "var(--text)" }}>{f}</em>
                        <span className="eb-mbar"><i style={{ width: `${(c / rows[0][1]) * 100}%`, background: FAMILY_COLORS[f] || undefined }} /></span>
                        <b>{c.toLocaleString()}<em className="bb-pct">· {((c / bb.count) * 100).toFixed(1)}%</em></b>
                      </div>
                    ));
                  })()}
                  <div className="re-title" style={{ marginTop: 10 }}>实例明细</div>
                  <div className="eb-list bb-inst-list">
                    {bb.builders.map((b) => (
                      <div key={b.addr ?? b.name} className="eb-miner" title={b.addr}>
                        <em className="bb-wrap">{b.name ?? (b.addr || "").slice(0, 10) + "…"}</em>
                        <span className="eb-mbar"><i style={{ width: `${(b.count / bb.builders[0].count) * 100}%` }} /></span>
                        <b>{b.count.toLocaleString()}<em className="bb-pct">· {((b.count / bb.count) * 100).toFixed(1)}%</em></b>
                      </div>
                    ))}
                  </div>
                </div>
                {/* 右:采用率趋势 + 出块路径分布 */}
                <div className="v2x-right">
                  <div className="v2x-card">
                    <V2TrendChart hourly={bb.hourly} bph={bb.blocksPerHour ?? 8000} />
                  </div>
                  {bb.fork?.total > 0 && (() => {
                    const f = bb.fork;
                    const rows = [
                      ["BidBlock (V2)", f.v2, f.v2Pct, "#FF9F1C"],
                      ["Bid (V1)", f.v1, f.v1Pct, "var(--green)"],
                      ["Local", f.local, f.localPct, "#8A8F99"],
                    ];
                    return (
                      <div className="v2x-card">
                        <div className="re-title">出块路径分布(自激活累计)</div>
                        <div className="bb-fork-bar">
                          {rows.map(([k, , p, c]) => <i key={k} style={{ width: `${p}%`, background: c }} title={`${k} ${p}%`} />)}
                        </div>
                        <div className="v2x-fork-leg">
                          {rows.map(([k, n, p, c]) => (
                            <div key={k}><i style={{ background: c }} /><em>{k}</em><b>{n.toLocaleString()}</b><span>{p}%</span></div>
                          ))}
                        </div>
                        <div className="bb-fork-total">总计 {f.total.toLocaleString()} 块 · 覆盖至 #{f.coveredTo.toLocaleString()}</div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* BAD BLOCK 归因:全网坏块有多少由 bidblock(SendBidBlock)导致 + builder 出错汇总。
            指标 counter 实时可靠;BAD BLOCK 多行长日志可能被采集端丢弃 → counter>0 而日志缺位时以 counter 报警 */}
        <div className="panel bbx-panel">
          <div className="panel-header">
            <span>BAD BLOCK / BIDBLOCK 归因
              {bad?.totals && (() => {
                const bidLive = Math.max(0, ...(bad.counters ?? []).map((c) => c.count ?? 0));
                const rc = bad.recent1h?.count ?? 0;
                return (
                  <em className={`panel-verdict pv-${rc > 0 ? "warn" : bad.totals.blocks > 0 ? "ok" : bidLive > 0 ? "warn" : "ok"}`}>
                    {rc > 0 ? `近 1 小时 +${rc} · bidblock ${bad.recent1h.bid}`
                      : bad.totals.blocks > 0 ? "● 近 1 小时无新增"
                      : bidLive > 0 ? `探针已计 ${bidLive} · 日志待入库` : "探针未见坏块"}
                  </em>
                );
              })()}
            </span>
            <span className="bm-ctls" title={`探针 ${bad?.ips?.join(" / ") ?? "…"} · chain_insert_badBidblock + BAD BLOCK 日志 · builder 为自声明标记`}>
              <span className="tf-ranges">
                {["24h", "3d", "7d", "All"].map((t) => (
                  <button key={t} className={`tf-range ${badTab === t ? "on" : ""}`} onClick={() => { setBadTab(t); setBadPage(-1); }}>{t}</button>
                ))}
              </span>
              <input className="bbx-q" placeholder="搜索 Builder / Validator / 块高 / 哈希" value={badQ} onChange={(e) => { setBadQ(e.target.value); setBadPage(-1); }} />
            </span>
          </div>
          <div className="panel-body">
            {!bad || bad.totals.blocks === 0 ? (
              <div className="ph-note">探针日志窗口内未见 BAD BLOCK 摘要。出现后这里会判定坏块是否走 BEP-675 SendBidBlock 路径,并按 builder 汇总出错次数(同一坏块被 peer 重播多次,按块 hash 去重)。若探针指标(chain_insert_badBidblock)&gt;0 而此处为空 = 日志未入 ES,标题会以指标计数报警,归因需登机 grep bsc.log。</div>
            ) : (
              <>
              {/* 最近一批坏块:以最新坏块为锚,往前 1 小时内的全部坏块为一批(时间聚簇,非固定条数);1h 内有新块时红边告警 */}
              {(() => {
                const sorted = [...bad.recent].sort((a, b) => b.firstT - a.firstT);
                if (!sorted.length) return null;
                const anchor = sorted[0].firstT;
                const batch = sorted.filter((b) => b.firstT >= anchor - 3600e3);
                const newest = batch[0], oldest = batch[batch.length - 1];
                const ageMin = Math.max(1, Math.round((Date.now() - newest.firstT) / 60e3));
                const fresh = Date.now() - newest.firstT < 3600e3;
                const age = ageMin < 60 ? `${ageMin} 分钟前` : ageMin < 1440 ? `${Math.round(ageMin / 60)} 小时前` : `${Math.round(ageMin / 1440)} 天前`;
                const nums = batch.map((b) => b.number);
                const lo = Math.min(...nums), hi = Math.max(...nums);
                const bAgg = new Map(), eAgg = new Map();
                for (const b of batch) {
                  const name = b.isBid ? (b.builderName ?? (b.builder ?? "").slice(0, 10) + "…") : "legacy/未带标记";
                  bAgg.set(name, (bAgg.get(name) ?? 0) + 1);
                  eAgg.set(b.errKey, (eAgg.get(b.errKey) ?? 0) + 1);
                }
                const bList = [...bAgg.entries()].sort((a, x) => x[1] - a[1]);
                const eList = [...eAgg.entries()].sort((a, x) => x[1] - a[1]);
                const topAddr = batch.find((b) => b.isBid && b.builder)?.builder ?? null;
                const sameDay = new Date(oldest.firstT).toDateString() === new Date(newest.firstT).toDateString();
                const hm = (t) => new Date(t).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
                const fmtRange = sameDay ? `${fmtBbT(oldest.firstT)} – ${hm(newest.firstT)}` : `${fmtBbT(oldest.firstT)} – ${fmtBbT(newest.firstT)}`;
                const BATCH_KEY = "__batch__";
                return (
                  <div className={`bbx-hero ${fresh ? "fresh" : ""}`}>
                    <div className="bbx-hero-top">
                      <b><span className="bbx-alert-dot" />最近一批坏块 · {batch.length} 块</b>
                      <i className={fresh ? "bbx-new" : "bbx-age"}>{fresh ? `NEW · ${age}` : `最新 ${age}`}</i>
                      <span className="bbx-hero-src">RequestsHash 归因 · BidBlock v2</span>
                      <span className="bbx-hero-actions">
                        <button className="bbx-copy" title="复制这批坏块的文字报告"
                          onClick={() => copyText([
                            `BAD BLOCK 最近一批(${batch.length} 块)`,
                            `块高: #${lo} – #${hi}`,
                            `builder: ${bList.map(([n, c]) => `${n} ×${c}`).join("、")}`,
                            `错误: ${eList.map(([k, c]) => `${k ?? "未知"} ×${c}`).join("、")}`,
                            `时间: ${fmtRange}`,
                            "明细:",
                            ...batch.map((b) => `#${b.number} ${b.hash} ${errShort(b.errKey)}`),
                          ].join("\n"))}>
                          复制报告
                        </button>
                        <button className="bbx-copy" title="展开这批坏块的逐块明细"
                          onClick={() => setBadOpen(badOpen === BATCH_KEY ? null : BATCH_KEY)}>
                          {badOpen === BATCH_KEY ? "收起详情" : "查看详情"}
                        </button>
                      </span>
                    </div>
                    <div className="bbx-hero-grid">
                      <div className="bbx-hero-b">
                        <span>BUILDER(本批汇总)</span>
                        <b>{bList.map(([n, c]) => `${n} ×${c}`).join(" / ")}</b>
                        {topAddr ? <code>{topAddr}</code> : null}
                      </div>
                      <div className="bbx-cell"><span>块高范围</span><b>#{lo.toLocaleString()} – #{hi.toLocaleString()}</b></div>
                      <div className="bbx-cell"><span>错误汇总</span>
                        <b>{eList.map(([k, c], i) => (
                          <span key={k ?? i} style={{ color: badErrColor(k) }}>{i > 0 ? " · " : ""}{errShort(k)} ×{c}</span>
                        ))}</b>
                      </div>
                      <div className="bbx-cell"><span>时间</span><b>{fmtRange}</b></div>
                    </div>
                    {badOpen === BATCH_KEY && (
                      <div className="bbx-hero-detail">
                        {batch.map((b) => (
                          <div key={b.hash}><span>#{b.number.toLocaleString()}</span><code>{errShort(b.errKey)} · {b.hash}</code></div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
              <div className="bb-cols bb-cols-bad">
                <div className="bbx-card">
                  <div className="re-title bbx-card-title">Builder 排名</div>
                  {bad.byBuilder.length === 0
                    ? <div className="eb-none">✓ 尚无归因到 bidblock 的坏块</div>
                    : (
                      <div className="bb-tbl">
                        <div className="bb-tbl-h"><span /><span>builder</span><span>24h</span><span>累计</span><span>最近</span><span>主要错误</span></div>
                        {bad.byBuilder.map((b, i) => (
                          <div key={b.addr} className="bb-tbl-r" title={b.addr}>
                            <i className="bb-err-idx" style={{ color: b.n24 > 0 ? "#FF9F1C" : "var(--muted)", borderColor: b.n24 > 0 ? "#FF9F1C" : "var(--line)" }}>{i + 1}</i>
                            <em className={b.n24 > 0 ? "hot" : ""}>{b.name ?? (b.addr === "unknown" ? "未带标记" : b.addr.slice(0, 10) + "…")}</em>
                            <b className={b.n24 > 0 ? "hot" : ""}>{b.n24}</b>
                            <b>{b.n}</b>
                            <span>{fmtBbT(b.lastT)}</span>
                            <i className="bb-tbl-err" title={b.mainErr ?? ""}>
                              {b.mainErr ? <><u style={{ background: badErrColor(b.mainErr) }} />{errShort(b.mainErr)} ({b.mainErrN})</> : "—"}
                            </i>
                          </div>
                        ))}
                      </div>
                    )}
                </div>
                <div className="bbx-card">
                  <div className="re-title bbx-card-title">错误原因分布</div>
                  {(bad.byError ?? []).map((e, i) => (
                    <div key={e.key} className="bbx-dist" title={`${e.key}\n样本:${e.sample}`}>
                      <em>{errShort(e.key)}</em>
                      <span className="bbx-dist-bar"><i style={{ width: `${(e.n / bad.byError[0].n) * 100}%`, background: errIdxColor(i + 1) }} /></span>
                      <b>{e.n}</b>
                    </div>
                  ))}
                  <div className="bbx-dist-total">总计 {bad.totals.blocks} · bidblock 已归因 {bad.totals.bid} · 无法归因/非 bidblock {bad.totals.unknown + bad.totals.nonBid}</div>
                </div>
              </div>
              {/* 最近事故:卡片全宽表,时间倒序;1h 内红边;点行展开完整 hash/错误;搜索与窗口 tab 在面板 header */}
              <div className="bbx-card">
                <div className="bbx-inc-head"><span className="re-title">最近事故</span></div>
                <div className="bbx-table">
                  <div className="bbx-th"><span>时间</span><span>块高</span><span>类型</span><span>Builder</span><span>Validator</span><span>错误</span><span /></div>
                  {(() => {
                    const cut = badTab === "24h" ? Date.now() - 864e5 : badTab === "3d" ? Date.now() - 3 * 864e5 : badTab === "7d" ? Date.now() - 7 * 864e5 : 0;
                    const q = badQ.trim().toLowerCase();
                    const all = bad.recent
                      .filter((b) => b.firstT >= cut)
                      .filter((b) => !q || [b.builderName, b.minerName, b.builder, b.miner, String(b.number), b.hash].some((v) => (v ?? "").toString().toLowerCase().includes(q)))
                      .sort((a, b) => b.firstT - a.firstT);
                    if (!all.length) {
                      const newest = bad.recent.reduce((m, b) => (b.firstT > m ? b.firstT : m), 0);
                      return (
                        <div className="eb-none">
                          {q ? "该窗口无匹配记录" : <>✓ 近 {badTab} 无新增坏块 · 历史共 {bad.totals.blocks} 条{newest ? `,最近一次 ${fmtBbT(newest)}` : ""}
                            <button className="bbx-copy" style={{ marginLeft: 8 }} onClick={() => { setBadTab("All"); setBadPage(-1); }}>查看全部</button></>}
                        </div>
                      );
                    }
                    // 分页:收起态只看前 10;展开后 10 条/页
                    const PAGE = 10;
                    const pages = Math.ceil(all.length / PAGE);
                    const page = badPage < 0 ? 0 : Math.min(badPage, pages - 1);
                    const rows = all.slice(page * PAGE, page * PAGE + PAGE);
                    const pager = badPage < 0
                      ? (all.length > PAGE && (
                          <div className="bbx-pager">
                            <button className="bbx-copy" onClick={() => setBadPage(0)}>展开全部 {all.length} 条</button>
                          </div>
                        ))
                      : (
                          <div className="bbx-pager">
                            <button className="bbx-copy" disabled={page === 0} onClick={() => setBadPage(page - 1)}>‹ 上一页</button>
                            <span>第 {page + 1} / {pages} 页 · 共 {all.length} 条</span>
                            <button className="bbx-copy" disabled={page >= pages - 1} onClick={() => setBadPage(page + 1)}>下一页 ›</button>
                            <button className="bbx-copy" onClick={() => setBadPage(-1)}>收起</button>
                          </div>
                        );
                    return (<>
                    {rows.map((b) => (
                      <div key={b.hash}>
                        <div className={`bbx-tr ${Date.now() - b.firstT < 3600e3 ? "fresh" : ""}`} onClick={() => setBadOpen(badOpen === b.hash ? null : b.hash)}>
                          <span className="bbx-t">{fmtBbT(b.firstT)}</span>
                          <b>#{b.number.toLocaleString()}</b>
                          <span className={`bbk-tag ${b.isBid ? "bid" : "unk"}`}>{b.isBid ? "bidblock" : b.isBid === false ? "non-bid" : "legacy"}</span>
                          <em className="bbx-bl" title={b.manual ? "人工归因:旧格式日志无 Builder 行,由 debug_getBadBlocks 的 RequestsHash 人工核实" : undefined}>{b.isBid ? (b.builderName ?? (b.builder ?? "").slice(0, 10) + "…") : "Unknown"}{b.manual ? " *" : ""}</em>
                          <em>{b.minerName ?? (b.miner ?? "").slice(0, 10)}</em>
                          <i style={{ color: badErrColor(b.errKey) }}>{errShort(b.errKey)}</i>
                          <button className="bbx-copy sm" title="复制 hash 与错误"
                            onClick={(ev) => { ev.stopPropagation(); copyText(`#${b.number} ${b.hash}\n${b.error ?? ""}`); }}>复制</button>
                        </div>
                        {badOpen === b.hash && (
                          <div className="bbx-tr-detail">
                            <div><span>hash</span><code>{b.hash}</code></div>
                            {b.builder && <div><span>Builder</span><code>{b.builder}</code></div>}
                            {b.miner && <div><span>Validator</span><code>{b.miner}</code></div>}
                            <div><span>错误全文</span><code>{b.error ?? "—"}</code></div>
                            <div><span>首次发现</span><code>{new Date(b.firstT).toLocaleString("zh-CN", { hour12: false })}</code></div>
                          </div>
                        )}
                      </div>
                    ))}
                    {pager}
                    </>);
                  })()}
                </div>
              </div>
              </>
            )}
            {bad?.truncated && <div className="bbk-note">扫描窗口命中 ES 单页上限(1000 行)，历史事故记录可能不完整。</div>}
          </div>
        </div>

        {/* instance 拆分:定位某地区/实例异常,而非只看 family */}
        {insts.length > 0 && (
          <div className="panel" style={{ maxWidth: 720 }}>
            <div className="panel-header"><span>Builder Instance 拆分</span><span className="sub">24h · Δ 为占比环比上一 24h</span></div>
            <div className="panel-body mev-bars">
              {insts.map((it) => (
                <div key={it.name} className="ver-row">
                  <span className="ver-tag" style={{ width: 150, color: FAMILY_COLORS[it.family] || "#aaa" }}>{it.name}</span>
                  <div className="ver-bar-track"><div className="ver-bar" style={{ width: `${(it.n / maxInst) * 100}%`, background: FAMILY_COLORS[it.family] || "#888" }} /></div>
                  <span className="ver-count">{it.n.toLocaleString()}<em>· {it.n > 0 && it.pct === 0 ? "<0.1%" : `${it.pct}%`}</em></span>
                  <span className="mi-delta">{fmtDelta(it.pct, it.prevPct)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 核心表:某 validator 是否只依赖一个 builder、是否 fallback local、某类是否集体异常 */}
        <div className="panel" style={{ maxWidth: 1240 }}>
          <div className="panel-header"><span>Validator → Builder 关系</span><span className="sub">窗口 {mev.total} 块 · 版本自 extraData</span></div>
          <div className="panel-body vb-body">
            <div className="vb-row vb-head">
              <span>validator</span><span>版本</span><span>出块</span><span>MEV%</span><span>主 builder</span><span>多样性</span><span>local</span>
            </div>
            {vbRows.map((v) => {
              const gv = vers[v.miner];
              return (
                <div key={v.miner} className="vb-row">
                  <span className="vb-name">{minerName(v.miner)}</span>
                  <span style={{ color: !gv ? "var(--muted)" : gv === latestVer ? "var(--green)" : "var(--orange)" }}>{gv ?? "—"}</span>
                  <span>{v.total}</span>
                  <span style={{ color: v.mevPct >= 99 ? "var(--green)" : v.mevPct >= 90 ? "var(--gold)" : "var(--orange)" }}>{v.mevPct}%</span>
                  <span className="vb-main" style={{ color: FAMILY_COLORS[v.mainFam] || "#aaa" }}>{v.mainFam ?? "—"}{v.mainFam && <em>{v.mainPct}%</em>}</span>
                  <span style={{ color: v.famCount >= 2 ? "var(--text)" : "var(--orange)" }}>{v.famCount} 家</span>
                  <span style={{ color: v.local > 0 ? "var(--orange)" : "var(--muted)" }}>{v.local}</span>
                </div>
              );
            })}
          </div>
        </div>

        {mev.recent?.length > 0 && (
          <div className="panel" style={{ maxWidth: 1240 }}>
            <div className="panel-header"><span>最近出块</span><span className="sub">block · miner · builder · 最近 20 块</span></div>
            <div className="panel-body mev-recent">
              {mev.recent.slice(0, 20).map((b) => (
                <div key={b.number} className="mev-recent-row">
                  <span className="mr-num">#{b.number?.toLocaleString()}</span>
                  <span className={`mr-type mr-${b.type}`}>{b.type}</span>
                  <span className="mr-miner">{minerName(b.miner)}</span>
                  <span className="mr-builder" style={{ color: FAMILY_COLORS[b.family] || "#aaa" }}>{b.builderName}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 右侧固定 LEO:MEV 问答 */}
        <div className="mev-robot-anchor"><RobotWidget variant="mev" /></div>

        <BidMetricsPanel />
        <GreedyMergePanel />

        <div className="ph-note">数据源：内置实时采集（WS newHeads + builder 地址识别）。四卡为 24h 小时桶,builder 分布为历史累计(重启续算;归因切换到 header 精确口径后从零重计),validator 榜为滚动 {mev.total} 块,最近出块为最近 20 块。BEP-675 (bid-block) 已随 Pasteur 在主网激活,v2 观测面板与路径分裂自激活时刻起统计(header 逐块精确口径),激活前的灰度数据已废弃。</div>
      </div>
    </div>
  );
}
