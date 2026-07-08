import AiButton from "../components/AiButton.jsx";

export default function AnomalyPage({ state }) {
  const blocks = state.recentBlocks ?? [];
  const slow   = blocks.filter((b) => b.anomaly === "slow");
  const missed = blocks.filter((b) => b.anomaly === "missed");
  const reorgs = blocks.filter((b) => b.isReorg);
  const slashed = (state.slashStatus ?? []).filter((v) => v.slashCount > 0).sort((a, b) => b.slashCount - a.slashCount);

  const events = [
    ...missed.map((b) => ({ k: "missed", t: b.number, txt: `漏槽块 #${b.number?.toLocaleString()} · ${b.blockTimeMs}ms` })),
    ...slow.map((b) => ({ k: "slow", t: b.number, txt: `慢块 #${b.number?.toLocaleString()} · ${b.blockTimeMs}ms` })),
    ...reorgs.map((b) => ({ k: "reorg", t: b.number, txt: `Reorg @ #${b.number?.toLocaleString()}` })),
  ].sort((a, b) => b.t - a.t);

  return (
    <div className="subpage">
      <div className="subpage-head">
        <div>
          <h1>🔍 异常分析</h1>
          <p>慢块 / 漏槽 / Reorg / Slash 的深度钻取与根因（概览在 Monitor 大盘）</p>
        </div>
        <div className="ai-bar">
          <AiButton label="根因分析" />
          <AiButton deep />
        </div>
      </div>

      <div className="subpage-body">
        <div className="stat-cards">
          <div className="stat-card"><div className="sc-v" style={{ color: missed.length ? "var(--red)" : "var(--green)" }}>{missed.length}</div><div className="sc-l">漏槽块 (≥2s)</div></div>
          <div className="stat-card"><div className="sc-v" style={{ color: slow.length ? "var(--orange)" : "var(--green)" }}>{slow.length}</div><div className="sc-l">慢块 (≥900ms)</div></div>
          <div className="stat-card"><div className="sc-v" style={{ color: reorgs.length ? "var(--orange)" : "var(--green)" }}>{reorgs.length}</div><div className="sc-l">Reorg</div></div>
          <div className="stat-card"><div className="sc-v" style={{ color: slashed.length ? "var(--red)" : "var(--green)" }}>{slashed.length}</div><div className="sc-l">被 Slash validator</div></div>
        </div>

        <div className="two-col">
          <div className="panel">
            <div className="panel-header"><span>异常块时间线</span><span className="sub">窗口内</span></div>
            <div className="panel-body anomaly-list">
              {events.length === 0 ? <div className="stab-ok" style={{ padding: 14 }}>✓ 窗口内无异常块</div>
                : events.slice(0, 40).map((e, i) => (
                  <div key={i} className={`anomaly-row ar-${e.k}`}>
                    <span className="ar-tag">{e.k.toUpperCase()}</span>
                    <span className="ar-txt">{e.txt}</span>
                  </div>
                ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header"><span>Slash 事件</span><span className="sub">链上</span></div>
            <div className="panel-body anomaly-list">
              {slashed.length === 0 ? <div className="stab-ok" style={{ padding: 14 }}>✓ 无 slash</div>
                : slashed.map((v) => (
                  <div key={v.consensusAddr} className={`anomaly-row ${v.slashCount >= 600 ? "ar-missed" : "ar-slow"}`}>
                    <span className="ar-tag">{v.status?.toUpperCase()}</span>
                    <span className="ar-txt">{v.consensusAddr?.slice(0, 10)}… · count {v.slashCount}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
