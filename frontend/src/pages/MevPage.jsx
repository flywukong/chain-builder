import { useState } from "react";
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

export default function MevPage({ state }) {
  const mev = state.mevStats;
  const { s: ai, run: runAi } = MevAiBox();

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
    ? { mevPct: d24.mevPct, v2Pct: d24.v2Pct, v1: d24.v1Count, local: d24.localCount }
    : { mevPct: mev.mevPct, v2Pct: mev.v2Pct, v1: tc.mev_v1 ?? 0, local: tc.local ?? 0 };
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
          <p>Builder 出块格局 · MEV 占比 · v1/v2 (BEP-675) 路径 · 指标窗口 24 小时</p>
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
          <div className="stat-card sc-card-v2">
            <div className="sc-v" style={{ color: "#FF9F1C" }}><span className="sc-ico">⚡</span>{cards.v2Pct}%</div>
            <div className="sc-l">mev-v2 (bid-block) 占比 · 24h<span className="sc-bep">BEP-675</span></div>
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

        {/* 右侧固定 LEO:MEV 问答 */}
        <div className="mev-robot-anchor"><RobotWidget variant="mev" /></div>

        <BidMetricsPanel />
        <GreedyMergePanel />

        {mev.recent?.length > 0 && (
          <div className="panel" style={{ maxWidth: 1240 }}>
            <div className="panel-header"><span>最近出块</span><span className="sub">block · miner · builder</span></div>
            <div className="panel-body mev-recent">
              {mev.recent.map((b) => (
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

        <div className="ph-note">数据源：内置实时采集（WS newHeads + builder 地址识别）。四卡为 24h 小时桶,builder 分布为历史累计(重启续算),最近出块/validator 榜为滚动 {mev.total} 块。当前主网 ~99% 是 mev_v1，v2 bidblock 尚未起量。</div>
      </div>
    </div>
  );
}
