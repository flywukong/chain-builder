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

export default function MevPage({ state }) {
  const mev = state.mevStats;
  const { s: ai, run: runAi } = MevAiBox();
  // v2(SendBidBlock)观测:主网未激活,出现即代表有 builder 在提前灰度
  const [bb, setBb] = useState(null);
  // 坏块 bidblock 归因(2 台灰度探针机:metric + BAD BLOCK 日志)
  const [bad, setBad] = useState(null);
  const [badTab, setBadTab] = useState("24h");   // 事故表时间窗:24h / 7d / All
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

        {/* BID-BLOCK (v2) 观测:走 BEP-675 路径的 builder 格局(Pasteur 已激活,统计自激活时刻) */}
        <div className="panel" style={{ maxWidth: 936 }}>
          <div className="panel-header">
            <span>BID-BLOCK (v2) 观测
              {bb && (() => {
                const live = bb.lastT && Date.now() - bb.lastT < 5 * 60e3;
                return (
                  <em className={`panel-verdict pv-${live ? "warn" : bb.count ? "mid" : "ok"}`}>
                    {bb.count ? `${live ? "⚡ 出块中 · " : ""}${bb.count.toLocaleString()} 块` : "未观测到 v2 块"}
                  </em>
                );
              })()}
            </span>
            <span className="sub">判据 header.RequestsHash version=2 · Pasteur 已激活 · 统计自激活时刻</span>
          </div>
          <div className="panel-body">
            {!bb || bb.count === 0 ? (
              <div className="ph-note">激活时刻以来暂无 bid-block 标记块(回扫可能仍在进行,首次部署自激活块补齐约需数分钟)。</div>
            ) : (
              <div className="bb-cols">
                <div>
                  <div className="re-title">BUILDER 家族份额(同家实例汇总)</div>
                  {(() => {
                    const fams = new Map();
                    for (const b of bb.builders) {
                      const f = famOf(b.name);
                      fams.set(f, (fams.get(f) ?? 0) + b.count);
                    }
                    const rows = [...fams.entries()].sort((a, x) => x[1] - a[1]);
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
                {/* 分叉后累计:bid / bidblock / local 三分裂(header 逐块精确口径) */}
                {bb.fork?.total > 0 && (() => {
                  const f = bb.fork;
                  const rows = [
                    ["bidblock (v2)", f.v2, f.v2Pct, "#FF9F1C"],
                    ["bid (v1)", f.v1, f.v1Pct, "var(--green)"],
                    ["local", f.local, f.localPct, "#8A8F99"],
                  ];
                  return (
                    <div>
                      <div className="re-title">自分叉累计 · 出块路径分裂</div>
                      <div className="bb-fork-bar">
                        {rows.map(([k, , p, c]) => <i key={k} style={{ width: `${p}%`, background: c }} title={`${k} ${p}%`} />)}
                      </div>
                      {rows.map(([k, n, p, c]) => (
                        <div key={k} className="bb-fork-row">
                          <i style={{ background: c }} />
                          <em>{k}</em>
                          <b>{n.toLocaleString()}</b>
                          <span>{p}%</span>
                        </div>
                      ))}
                      <div className="bb-fork-total">总计 {f.total.toLocaleString()} 块 · 已覆盖至 #{f.coveredTo.toLocaleString()}</div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>

        {/* BAD BLOCK 归因:全网坏块有多少由 bidblock(SendBidBlock)导致 + builder 出错汇总。
            指标 counter 实时可靠;BAD BLOCK 多行长日志可能被采集端丢弃 → counter>0 而日志缺位时以 counter 报警 */}
        <div className="panel" style={{ maxWidth: 1240 }}>
          <div className="panel-header">
            <span>BAD BLOCK · BIDBLOCK 归因
              {bad?.totals && (() => {
                const bidLive = Math.max(0, ...(bad.counters ?? []).map((c) => c.count ?? 0));
                const rc = bad.recent1h?.count ?? 0;
                return (
                  <em className={`panel-verdict pv-${rc > 0 ? "warn" : bad.totals.blocks > 0 ? "ok" : bidLive > 0 ? "warn" : "ok"}`}>
                    {rc > 0 ? `🚨 近 1 小时 +${rc} · bidblock ${bad.recent1h.bid}`
                      : bad.totals.blocks > 0 ? "● 近 1 小时无新增"
                      : bidLive > 0 ? `⚡ 探针已计 ${bidLive} · 日志待入库` : "探针未见坏块"}
                  </em>
                );
              })()}
            </span>
            <span className="sub">探针 {bad?.ips?.join(" / ") ?? "…"}(部署统计版)· chain_insert_badBidblock + BAD BLOCK 日志 · builder 为 header 自声明标记,作线索非定论</span>
          </div>
          <div className="panel-body">
            {!bad || bad.totals.blocks === 0 ? (
              <div className="ph-note">探针日志窗口内未见 BAD BLOCK 摘要。出现后这里会判定坏块是否走 BEP-675 SendBidBlock 路径,并按 builder 汇总出错次数(同一坏块被 peer 重播多次,按块 hash 去重)。若探针指标(chain_insert_badBidblock)&gt;0 而此处为空 = 日志未入 ES,标题会以指标计数报警,归因需登机 grep bsc.log。</div>
            ) : (
              <>
              {/* 最新坏块 hero:1h 内红色告警边,过时转灰 */}
              {(() => {
                const latest = bad.recent.reduce((m, b) => (!m || b.firstT > m.firstT ? b : m), null);
                if (!latest) return null;
                const ageMin = Math.max(1, Math.round((Date.now() - latest.firstT) / 60e3));
                const fresh = Date.now() - latest.firstT < 3600e3;
                const age = ageMin < 60 ? `${ageMin} 分钟前` : ageMin < 1440 ? `${Math.round(ageMin / 60)} 小时前` : `${Math.round(ageMin / 1440)} 天前`;
                return (
                  <div className={`bbx-hero ${fresh ? "fresh" : ""}`} title={latest.hash}>
                    <div className="bbx-hero-top">
                      <b>🚨 最新坏块</b>
                      <i className={fresh ? "bbx-new" : "bbx-age"}>{fresh ? `NEW · ${age}` : age}</i>
                      <span className="bbx-hero-src">RequestsHash 归因 · BidBlock v2</span>
                    </div>
                    <div className="bbx-hero-grid">
                      <div className="bbx-hero-b">
                        <span>BUILDER</span>
                        <b>{latest.isBid ? (latest.builderName ?? (latest.builder ?? "").slice(0, 12) + "…") : latest.isBid === false ? "非 bidblock" : "legacy · 未判"}</b>
                        {latest.isBid && latest.builder ? <code>{latest.builder}</code> : null}
                      </div>
                      <div className="bbx-cell"><span>块高</span><b>#{latest.number.toLocaleString()}</b></div>
                      <div className="bbx-cell"><span>错误</span><b style={{ color: badErrColor(latest.errKey) }} title={latest.error ?? ""}>{errShort(latest.errKey)}</b></div>
                      <div className="bbx-cell"><span>Validator</span><b>{latest.minerName ?? (latest.miner ?? "").slice(0, 10) ?? "—"}</b></div>
                      <div className="bbx-cell"><span>观测(重播)</span><b>×{latest.n}</b></div>
                      <div className="bbx-cell"><span>时间</span><b>{fmtBbT(latest.firstT)}</b></div>
                    </div>
                  </div>
                );
              })()}
              {/* 四指标 */}
              <div className="bbx-tiles">
                <div className="bbx-tile"><b>{bad.totals.blocks}</b><span>唯一坏块</span></div>
                <div className="bbx-tile hot"><b>{bad.totals.bid}</b><span>bidblock 已归因</span></div>
                <div className="bbx-tile"><b>{bad.totals.unknown + bad.totals.nonBid}</b><span>无法归因 / 非 bidblock</span></div>
                <div className="bbx-tile"><b>{(bad.totals.obs ?? 0).toLocaleString()}</b><span>观测上报(含重播)</span></div>
              </div>
              <div className="bb-cols bb-cols-bad">
                <div>
                  <div className="re-title">BUILDER 排名(最近出错在前)</div>
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
                <div>
                  <div className="re-title">错误原因分布(unique 坏块)</div>
                  {(bad.byError ?? []).map((e, i) => (
                    <div key={e.key} className="bbx-dist" title={`${e.key}\n样本:${e.sample}`}>
                      <em>{errShort(e.key)}</em>
                      <span className="bbx-dist-bar"><i style={{ width: `${(e.n / bad.byError[0].n) * 100}%`, background: errIdxColor(i + 1) }} /></span>
                      <b>{e.n}</b>
                    </div>
                  ))}
                  <div className="bbx-dist-total">总计 {bad.totals.blocks} · bidblock {bad.totals.bid}</div>
                </div>
              </div>
              {/* 最近事故:全宽表,时间倒序;1h 内的行红边高亮 */}
              <div className="bbx-inc-head">
                <span className="re-title">最近事故</span>
                <span className="tf-ranges">
                  {["24h", "7d", "All"].map((t) => (
                    <button key={t} className={`tf-range ${badTab === t ? "on" : ""}`} onClick={() => setBadTab(t)}>{t}</button>
                  ))}
                </span>
              </div>
              <div className="bbx-table">
                <div className="bbx-th"><span>时间</span><span>块高</span><span>类型</span><span>builder</span><span>validator</span><span>错误</span><span>观测</span></div>
                {(() => {
                  const cut = badTab === "24h" ? Date.now() - 864e5 : badTab === "7d" ? Date.now() - 7 * 864e5 : 0;
                  const rows = bad.recent.filter((b) => b.firstT >= cut).sort((a, b) => b.firstT - a.firstT).slice(0, 20);
                  if (!rows.length) return <div className="eb-none">该窗口无记录</div>;
                  return rows.map((b) => (
                    <div key={b.hash} className={`bbx-tr ${Date.now() - b.firstT < 3600e3 ? "fresh" : ""}`} title={`${b.hash}\n${b.error ?? ""}`}>
                      <span className="bbx-t">{fmtBbT(b.firstT)}</span>
                      <b>#{b.number.toLocaleString()}</b>
                      <span className={`bbk-tag ${b.isBid ? "bid" : "unk"}`}>{b.isBid ? "bidblock" : b.isBid === false ? "non-bid" : "legacy"}</span>
                      <em className="bbx-bl">{b.isBid ? (b.builderName ?? (b.builder ?? "").slice(0, 10) + "…") : "—"}</em>
                      <em>{b.minerName ?? (b.miner ?? "").slice(0, 10)}</em>
                      <i style={{ color: badErrColor(b.errKey) }}>{errShort(b.errKey)}</i>
                      <span className="bbx-n">×{b.n}</span>
                    </div>
                  ));
                })()}
              </div>
              </>
            )}
            {bad?.truncated && <div className="bbk-note">⚠ 有扫描窗口命中 ES 单页上限(1000 行),重播计数可能偏低;unique 坏块与 builder 汇总基本不受影响。</div>}
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
