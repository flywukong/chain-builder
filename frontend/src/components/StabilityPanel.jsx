export default function StabilityPanel({ slashStatus, diskAlerts, recentBlocks }) {
  // Count anomalous blocks (blockTimeMs > 4000)
  const anomalies = (recentBlocks ?? []).filter(b => b.anomaly);
  const reorgs    = (recentBlocks ?? []).filter(b => b.isReorg);

  const slashActive = (slashStatus ?? []).filter(v => v.slashCount > 0);

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Stability</span>
      </div>
      <div className="panel-body stab-body">

        <Section title="Network">
          <StatRow label="Anomaly blocks" value={anomalies.length}
            warn={anomalies.length > 0} />
          <StatRow label="Reorgs (200blk)" value={reorgs.length}
            warn={reorgs.length > 0} />
        </Section>

        <Section title="Slash">
          {slashActive.length === 0
            ? <div className="stab-ok">✓ All clean</div>
            : slashActive.map(v => (
                <div key={v.consensusAddr} className="stab-slash-row">
                  <span className={`stab-badge ${v.slashCount >= 600 ? "badge-fel" : v.slashCount >= 200 ? "badge-mis" : "badge-warn"}`}>
                    {v.slashCount >= 600 ? "FELONY" : v.slashCount >= 200 ? "MISDEM" : "WARN"}
                  </span>
                  <span className="stab-addr">{v.consensusAddr?.slice(2, 8).toUpperCase()}</span>
                  <span className="stab-cnt">{v.slashCount}</span>
                </div>
              ))
          }
        </Section>

        <Section title="Disk Alerts">
          {(diskAlerts ?? []).length === 0
            ? <div className="stab-ok">✓ All OK</div>
            : diskAlerts.map((d, i) => (
                <div key={i} className="stab-disk-row">
                  <span className="stab-addr">{d.instance?.split(":")[0]}</span>
                  <span className="stab-cnt stab-warn">{d.usedPct?.toFixed(1)}%</span>
                </div>
              ))
          }
        </Section>

      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="stab-section">
      <div className="stab-section-title">{title}</div>
      {children}
    </div>
  );
}

function StatRow({ label, value, warn }) {
  return (
    <div className="stab-stat-row">
      <span className="stab-label">{label}</span>
      <span className={`stab-value ${warn && value > 0 ? "stab-warn" : ""}`}>{value}</span>
    </div>
  );
}
