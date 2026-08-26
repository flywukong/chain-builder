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

        {/* Builder 分布(核心):历史累计 + 24h 对照,单列 */}
        <div className="panel" style={{ maxWidth: 720 }}>
          <div className="panel-header">
            <span>Builder 分布</span>
            <span className="sub">历史累计{famSince ? ` · 自 ${famSince.getMonth() + 1}/${famSince.getDate()}` : ""} · {famTotal.toLocaleString()} 块 · 右列为 24h 份额与环比</span>
          </div>
          <div className="panel-body mev-bars">
            {fams.map(([f, c]) => {
              const d24 = (mev.famsDay ?? []).find((x) => x.name === f);
              return (
                <div key={f} className="ver-row">
                  <span className="ver-tag" style={{ width: 92, color: FAMILY_COLORS[f] || "#aaa" }}>{f}</span>
                  <div className="ver-bar-track"><div className="ver-bar" style={{ width: `${(c / maxFam) * 100}%`, background: FAMILY_COLORS[f] || "#888" }} /></div>
                  <span className="ver-count">{c.toLocaleString()}<em>· {fmtPct(c, famTotal)}</em></span>
                  <span className="fam-24h">{d24 ? <>24h {d24.pct}% {fmtDelta(d24.pct, d24.prevPct)}</> : <em>—</em>}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* BID-BLOCK (v2) 观测:走 BEP-675 路径的 builder 格局(Pasteur 已激活,统计自激活时刻) */}
        <div className="panel" style={{ maxWidth: 720 }}>
          <div className="panel-header">
            <span>BID-BLOCK (v2) 观测
              {bb && (() => {
                const live = bb.sessions.some((s) => Date.now() - s.tEnd < 5 * 60e3);
                return (
                  <em className={`panel-verdict pv-${live ? "warn" : bb.count ? "mid" : "ok"}`}>
                    {bb.count ? `${live ? "⚡ 出块中 · " : ""}${bb.count.toLocaleString()} 块 · ${bb.sessions.length} 段` : "未观测到 v2 块"}
                  </em>
                );
              })()}
            </span>
            <span className="sub">判据 header.RequestsHash version=2 · Pasteur 已于 8/25 10:30 激活 · 统计自激活时刻(#117,920,136)</span>
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
                        <em>{b.name ?? (b.addr || "").slice(0, 10) + "…"}</em>
                        <span className="eb-mbar"><i style={{ width: `${(b.count / bb.builders[0].count) * 100}%` }} /></span>
                        <b>{b.count.toLocaleString()}<em className="bb-pct">· {((b.count / bb.count) * 100).toFixed(1)}%</em></b>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="re-title">会话(相邻 v2 块距 ≤1200 归同一段)</div>
                  <div className="eb-list bb-list">
                    {bb.sessions.map((s) => {
                      const live = Date.now() - s.tEnd < 5 * 60e3;
                      const span = s.to - s.from + 1;
                      const durMin = Math.max(1, Math.round((s.tEnd - s.tStart) / 60e3));
                      const dur = durMin >= 60 ? `${(durMin / 60).toFixed(1)}h` : `${durMin}m`;
                      const share = span > 0 ? ((s.count / span) * 100).toFixed(1) : null;
                      const famN = new Set(s.builders.map(famOf)).size;
                      return (
                        <div key={s.from} className={`bb-sess ${live ? "live" : ""}`}>
                          <div className="bb-sess-top">
                            <em className={`bb-sess-st ${live ? "on" : ""}`}>{live ? "⚡ 进行中" : "已结束"}</em>
                            <b>{fmtBbT(s.tStart)} → {live ? "现在" : fmtBbT(s.tEnd)}</b>
                            <span>· 持续 {dur}</span>
                            <i className="bb-sess-n">v2 {s.count.toLocaleString()} 块</i>
                          </div>
                          <div className="bb-sess-mid">区块 #{s.from.toLocaleString()} – #{s.to.toLocaleString()}</div>
                          <div className="bb-sess-low">
                            <span>builder <b>{famN} 家 / {s.builders.length} 实例</b></span>
                            <span>· validator <b>{s.minerNames.length}</b> 个</span>
                            {share != null && <span title="v2 块数 ÷ 区间总块数">· v2 区间占比 ≈<b>{share}%</b></span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* BAD BLOCK 归因:全网坏块有多少由 bidblock(SendBidBlock)导致 + builder 出错汇总。
            指标 counter 实时可靠;BAD BLOCK 多行长日志可能被采集端丢弃 → counter>0 而日志缺位时以 counter 报警 */}
        <div className="panel" style={{ maxWidth: 720 }}>
          <div className="panel-header">
            <span>BAD BLOCK · bidblock 归因
              {bad?.totals && (() => {
                const bidLive = Math.max(0, ...(bad.counters ?? []).map((c) => c.count ?? 0));
                return (
                  <em className={`panel-verdict pv-${bad.totals.bid > 0 || bidLive > 0 ? "warn" : bad.totals.blocks > 0 ? "mid" : "ok"}`}>
                    {bad.totals.blocks > 0 ? `坏块 ${bad.totals.blocks} · bidblock 致 ${bad.totals.bid}`
                      : bidLive > 0 ? `⚡ 探针已计 ${bidLive} 个坏 bidblock · 日志待入库` : "探针未见坏块"}
                  </em>
                );
              })()}
            </span>
            <span className="sub">探针 {bad?.ips?.join(" / ") ?? "…"}(部署统计版)· chain_insert_badBidblock + BAD BLOCK 日志 · builder 为 header 自声明标记,作线索非定论</span>
          </div>
          <div className="panel-body">
            <div className="bbk-chips">
              {(bad?.counters ?? []).map((c) => (
                <span key={c.instance} className="bbk-chip">📟 {c.instance} 进程计数 <b>{c.count ?? "—"}</b></span>
              ))}
              <span className="bbk-chip">日志累计 unique 坏块 <b>{bad?.totals?.blocks ?? "—"}</b> · 其中 bidblock <b className="bbk-hot">{bad?.totals?.bid ?? "—"}</b>{bad?.totals?.unknown > 0 ? ` · 旧格式待判 ${bad.totals.unknown}` : ""}</span>
            </div>
            {!bad || bad.totals.blocks === 0 ? (
              <div className="ph-note">探针日志窗口内未见 BAD BLOCK 摘要。出现后这里会判定坏块是否走 BEP-675 SendBidBlock 路径,并按 builder 汇总出错次数(同一坏块被 peer 重播多次,按块 hash 去重)。若上方进程计数 &gt;0 而此处为空 = BAD BLOCK 多行长日志未入 ES(采集端可能丢弃超长条目),builder 归因需登机 grep bsc.log。</div>
            ) : (
              <div className="bb-cols">
                <div>
                  <div className="re-title">BUILDER 出错汇总(bidblock 坏块)</div>
                  {bad.byBuilder.length === 0
                    ? <div className="eb-none">✓ 尚无归因到 bidblock 的坏块</div>
                    : bad.byBuilder.map((b) => (
                        <div key={b.addr} className="eb-miner" title={b.addr}>
                          <em className="eb-hot">{b.name ?? (b.addr === "unknown" ? "未带 builder 标记" : b.addr.slice(0, 10) + "…")}</em>
                          <span className="eb-mbar"><i style={{ width: `${(b.n / bad.byBuilder[0].n) * 100}%` }} /></span>
                          <b>{b.n} 次</b>
                        </div>
                      ))}
                  <div className="bb-addrs">
                    {bad.byBuilder.slice(0, 4).filter((b) => b.addr !== "unknown").map((b) => (
                      <div key={b.addr}><em>{b.name ?? "?"}</em> <code>{b.addr}</code></div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="re-title">最近坏块(hash 去重 · ×n 为重播次数)</div>
                  <div className="eb-list bb-list">
                    {bad.recent.slice(0, 12).map((b) => (
                      <div key={b.hash} className="bbk-row" title={`${b.hash}\n${b.error ?? ""}`}>
                        <span className="hpd-num">{fmtBbT(b.lastT)}</span>
                        <b className="bbk-num">#{b.number.toLocaleString()}</b>
                        <span className={`bbk-tag ${b.isBid ? "bid" : b.isBid === false ? "" : "unk"}`}>{b.isBid ? "bidblock" : b.isBid === false ? "非bidblock" : "旧格式"}</span>
                        <span className="bbk-b">{b.isBid ? (b.builderName ?? (b.builder ?? "").slice(0, 10) + "…") : (b.minerName ?? (b.miner ?? "").slice(0, 10))}</span>
                        <em className="bbk-err">{(b.error ?? "").slice(0, 44)}</em>
                        <i className="bbk-n">×{b.n}</i>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
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

        <div className="ph-note">数据源：内置实时采集（WS newHeads + builder 地址识别）。四卡为 24h 小时桶,builder 分布为历史累计(重启续算;归因切换到 header 精确口径后从零重计),validator 榜为滚动 {mev.total} 块,最近出块为最近 20 块。BEP-675 (bid-block) 已随 Pasteur 于 2026-08-25 10:30 在主网激活,v2 观测面板自激活时刻起统计,激活前的灰度数据已废弃。</div>
      </div>
    </div>
  );
}
