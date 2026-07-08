import { useState } from "react";
import { lookupValidator } from "../data/validators.js";

const API = import.meta.env.VITE_API_BASE ?? "";

// MEV 格局 AI 分析:按钮 + 结果面板(claude,数据=2000块窗口聚合)
function MevAiBox() {
  const [s, setS] = useState({ loading: false, text: null, at: null, err: null });
  const run = async () => {
    setS((x) => ({ ...x, loading: true, err: null }));
    try {
      const r = await fetch(API + "/api/ai/mev", { method: "POST" });
      const d = await r.json();
      if (d.error) setS({ loading: false, text: null, at: null, err: d.error });
      else if (d.running) setS((x) => ({ ...x, loading: false, err: "已有分析进行中,请稍候" }));
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

  const fams = mev.builderFamilies ?? [];
  const maxFam = Math.max(1, ...fams.map((f) => f[1]));
  const miners = mev.topMiners ?? [];
  const maxMiner = Math.max(1, ...miners.map((m) => m[1]));
  const tc = mev.typeCounts ?? {};
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
          <p>Builder 出块格局 · MEV 占比 · v1/v2 (BEP-675) 路径 · 窗口 {mev.total} 块</p>
        </div>
        <div className="ai-bar">
          <button className="st-auto-btn" onClick={runAi} disabled={ai.loading}>
            {ai.loading ? "分析中… 约 20–30s" : "⚡ MEV 格局分析"}
          </button>
        </div>
      </div>

      <div className="subpage-body">
        {ai.err && <div className="ai-err" style={{ maxWidth: 860 }}>⚠ {ai.err}</div>}
        {ai.text && (
          <div className="panel" style={{ maxWidth: 860 }}>
            <div className="panel-header"><span>🤖 AI 格局分析</span><span className="sub">claude code{ai.at ? ` · ${new Date(ai.at).toLocaleTimeString()}` : ""}</span></div>
            <div className="panel-body"><div className="ai-result" style={{ padding: "10px 14px" }}>{ai.text}</div></div>
          </div>
        )}
        <div className="stat-cards">
          <div className="stat-card"><div className="sc-v" style={{ color: "var(--gold)" }}>{mev.mevPct}%</div><div className="sc-l">MEV 占比</div></div>
          <div className="stat-card sc-card-v2">
            <div className="sc-v" style={{ color: "#FF9F1C" }}><span className="sc-ico">⚡</span>{mev.v2Pct}%</div>
            <div className="sc-l">mev-v2 (bid-block) 占比<span className="sc-bep">BEP-675</span></div>
          </div>
          <div className="stat-card">
            <div className="sc-v" style={{ color: "var(--green)" }}><span className="sc-ico">◇</span>{tc.mev_v1 ?? 0}</div>
            <div className="sc-l">mev-v1 (bid) 块</div>
          </div>
          <div className="stat-card"><div className="sc-v" style={{ color: "var(--muted)" }}>{tc.local ?? 0}</div><div className="sc-l">local（非MEV）块</div></div>
        </div>

        <div className="panel" style={{ maxWidth: 640 }}>
          <div className="panel-header"><span>Builder 分布</span><span className="sub">按系列</span></div>
          <div className="panel-body mev-bars">
            {fams.map(([f, c]) => (
              <div key={f} className="ver-row">
                <span className="ver-tag" style={{ width: 88, color: FAMILY_COLORS[f] || "#aaa" }}>{f}</span>
                <div className="ver-bar-track"><div className="ver-bar" style={{ width: `${(c / maxFam) * 100}%`, background: FAMILY_COLORS[f] || "#888" }} /></div>
                <span className="ver-count">{c}<em>· {Math.round((c / mev.total) * 100)}%</em></span>
              </div>
            ))}
          </div>
        </div>

        {mev.recent?.length > 0 && (
          <div className="panel" style={{ maxWidth: 860 }}>
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

        <div className="panel" style={{ maxWidth: 640 }}>
          <div className="panel-header"><span>出块最多的 Validator</span><span className="sub">top {miners.length} · 窗口 {mev.total} 块 · 版本自 extraData</span></div>
          <div className="panel-body mev-bars">
            {miners.map(([m, c]) => {
              const v = vers[m];
              return (
                <div key={m} className="ver-row">
                  <span className="ver-tag" style={{ width: 110 }}>{minerName(m)}</span>
                  <span className="mv-ver" style={{ color: !v ? "var(--muted)" : v === latestVer ? "var(--green)" : "var(--orange)" }}>{v ?? "—"}</span>
                  <div className="ver-bar-track"><div className="ver-bar" style={{ width: `${(c / maxMiner) * 100}%`, background: "var(--teal, #3FB8A0)" }} /></div>
                  <span className="ver-count">{c}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="ph-note">数据源：内置实时采集（WS newHeads + builder 地址识别，滚动窗口 {mev.total} 块）。当前主网 ~99% 是 mev_v1，v2 bidblock 尚未起量。v1.1 接 AI 后支持 builder 占比突变归因。</div>
      </div>
    </div>
  );
}
