export default function Topbar({ latestBlock, windowStats, mevStats, connected, page }) {
  // MEV% from the 2000-block aggregator — same source as the MEV page, so the
  // headline never contradicts the local-block count shown there.
  const mevPct   = (mevStats?.mevPct ?? windowStats?.mevPct)?.toFixed(1) ?? "--";
  const gasUtil  = windowStats?.avgGasUtilPct?.toFixed(1) ?? "--";
  const anomaly  = windowStats?.empty24h ?? windowStats?.anomalyCount ?? 0;   // 空块 24h

  const PAGE_TITLE = {
    home: "Home", monitor: "Monitor 大盘", mev: "MEV 分析", traffic: "流量分析",
    anomaly: "异常分析", storage: "存储", txn: "Txn 分析", alerts: "告警",
  };

  return (
    <div className="topbar">
      <div className="topbar-brand">
        <svg className="bnb-logo" width="22" height="22" viewBox="4 4 24 24" fill="#F0B90B" aria-label="BNB Chain">
          <path d="M12.116 14.404L16 10.52l3.886 3.886 2.26-2.26L16 6l-6.144 6.144 2.26 2.26z" />
          <path d="M6 16l2.26-2.26L10.52 16l-2.26 2.26L6 16z" />
          <path d="M16 13.706L18.294 16 16 18.294 13.706 16 16 13.706z" />
          <path d="M21.48 16l2.26-2.26L26 16l-2.26 2.26L21.48 16z" />
          <path d="M12.116 17.596L16 21.48l3.886-3.886 2.26 2.26L16 26l-6.144-6.144 2.26-2.26z" />
        </svg>
        <span className="topbar-title tt-binance">BNB CHAIN BUILDER</span>
        <span className="topbar-slash">/</span>
        <span className="topbar-page">{PAGE_TITLE[page] ?? page}</span>
        <span className="topbar-net"><span className="net-dot" />MAINNET</span>
      </div>

      <div className="topbar-stats">
        <Stat label="当前区块" value={latestBlock ? `#${latestBlock.number.toLocaleString()}` : "--"} />
        <Divider />
        <Stat label="MEV%" value={`${mevPct}%`} accent={parseFloat(mevPct) > 60} />
        <Divider />
        <Stat label="GAS 利用率" value={`${gasUtil}%`} warn={parseFloat(gasUtil) >= 90} />
        <Divider />
        {anomaly > 0 && (
          <>
            <Stat label="空块" value={anomaly} warn />
            <Divider />
          </>
        )}
        <div className={`topbar-dot ${connected ? "dot-ok" : "dot-err"}`} title={connected ? "WS connected" : "WS disconnected"} />
      </div>
    </div>
  );
}

function Stat({ label, value, accent, warn }) {
  return (
    <div className="topbar-stat">
      <span className="ts-label">{label}</span>
      <span className={`ts-value ${accent ? "ts-gold" : ""} ${warn ? "ts-warn" : ""}`}>{value}</span>
    </div>
  );
}

function Divider() {
  return <div style={{ width: 1, height: 20, background: "#252525" }} />;
}
