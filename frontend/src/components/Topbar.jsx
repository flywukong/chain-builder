import { useState } from "react";

export default function Topbar({ latestBlock, windowStats, mevStats, connected, keterHealth, page, nodeCount = null, zoomPref = 1, onZoomPref }) {
  const [netOpen, setNetOpen] = useState(false);

  // keter 快照新鲜度:正常时不占位,数据超 25min 或一直拉不到才亮警示
  const staleMin = keterHealth?.okAt ? Math.round((Date.now() - keterHealth.okAt) / 60000) : null;
  const keterStale = staleMin != null && staleMin > 25;
  const keterDown = !keterHealth?.okAt && !!keterHealth?.error;

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
        <span className="topbar-title tt-binance">BNB CHAIN AI ANALYTICS</span>
        <span className="topbar-slash">/</span>
        <span className="topbar-page">{PAGE_TITLE[page] ?? page}</span>
        {/* 网络切换器:目前仅 BSC Mainnet,其余占位提示 */}
        <span className="topbar-net-wrap">
          <button className="topbar-net" onClick={() => setNetOpen((x) => !x)}>
            <span className="net-dot" />BSC MAINNET<i className="net-caret">▾</i>
          </button>
          {netOpen && (
            <div className="net-menu" onMouseLeave={() => setNetOpen(false)}>
              <div className="net-item on"><span className="net-dot" />BSC Mainnet<em>当前</em></div>
              <div className="net-item off"><span className="net-dot dot-dim" />opBNB Mainnet<em>即将支持</em></div>
              <div className="net-item off"><span className="net-dot dot-dim" />BSC Testnet<em>即将支持</em></div>
              <div className="net-tip">目前仅支持 BSC Mainnet</div>
            </div>
          )}
        </span>
      </div>

      {page === "home" && (
        <span className="topbar-health-title">内部 VALIDATOR 健康总览{nodeCount != null ? ` · ${nodeCount} nodes` : ""}</span>
      )}

      <div className="topbar-stats">
        <Stat label="当前区块" value={latestBlock ? `#${latestBlock.number.toLocaleString()}` : "--"} />
        <Divider />
        {(keterStale || keterDown) && (
          <>
            <div title={keterHealth?.error ?? ""}>
              <Stat label="KETER" value={keterDown ? "不可用" : `数据 ${staleMin}m 前`} warn />
            </div>
            <Divider />
          </>
        )}
        <div className={`topbar-dot ${connected ? "dot-ok" : "dot-err"}`} title={connected ? "WS connected" : "WS disconnected"} />
        <div className="zoom-ctl" title="界面大小 · 本机记忆">
          <button onClick={() => onZoomPref?.(Math.max(0.7, +(zoomPref - 0.1).toFixed(2)))}>−</button>
          <span className="zc-val" onClick={() => onZoomPref?.(1)} title="点击重置 100%">{Math.round(zoomPref * 100)}%</span>
          <button onClick={() => onZoomPref?.(Math.min(1.5, +(zoomPref + 0.1).toFixed(2)))}>+</button>
        </div>
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
