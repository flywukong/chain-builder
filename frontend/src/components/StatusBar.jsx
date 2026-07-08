// Home 首屏健康摘要 — 一眼看出链是否正常（6 项）
function cmpVer(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
function versionSummary(nodeStats) {
  const map = {};
  (nodeStats ?? []).forEach((n) => {
    const m = /BSC\/v?(\d+\.\d+\.\d+)/i.exec(n.nodeType || "");
    if (m) map[m[1]] = (map[m[1]] || 0) + 1;
  });
  const vers = Object.keys(map);
  if (!vers.length) return { pct: null, behind: 0 };
  const total = Object.values(map).reduce((s, c) => s + c, 0);
  const latest = vers.reduce((a, b) => (cmpVer(b, a) > 0 ? b : a));
  const pct = Math.round((map[latest] / total) * 100);
  return { pct, behind: total - map[latest], total };
}

export default function StatusBar({ windowStats, slashStatus, nodeStats, diskAlerts, txpool }) {
  const ws = windowStats;
  const anomalies = ws?.anomalyCount ?? 0;
  const missed = ws?.missedCount ?? 0;
  const reorg = ws?.reorgCount ?? 0;
  const slashed = (slashStatus ?? []).filter((v) => v.slashCount > 0).length;
  const disk = (diskAlerts ?? []).filter((d) => (d.usedPct ?? 0) >= 85).length; // 磁盘高水位并入健康
  const gasUtil = ws?.avgGasUtilPct ?? 0;
  const bt = ws?.avgBlockTimeMs;
  const ver = versionSummary(nodeStats);
  // 大流量：dataseed pending 均值 > 阈值(4000) 为权威信号，gas 利用率为辅助
  const trafficHot = txpool?.anomalyNow || gasUtil > 70;

  // single reorg can be a backfill/reconnect-boundary artifact → tolerate; flag real trouble
  const warn = missed > 0 || reorg > 1 || (bt != null && bt > 900) || anomalies > 5 || disk > 0;

  const chips = [
    { label: "链健康", value: warn ? "WARN" : "OK", tone: warn ? "warn" : "ok" },
    { label: "异常块 / 5min", value: anomalies, tone: anomalies > 0 ? "warn" : "ok" },
    { label: "Missed / Reorg", value: `${missed} / ${reorg}`, tone: missed > 0 ? "bad" : reorg > 0 ? "warn" : "ok" },
    { label: "最新版占比 / 落后", value: ver.pct == null ? "--" : `${ver.pct}% · ${ver.behind}`, tone: ver.behind > (ver.total ?? 0) * 0.2 ? "warn" : "ok" },
    { label: "Slash validator", value: slashed, tone: slashed > 0 ? "warn" : "ok" },
    { label: "Gas / 流量", value: txpool?.anomalyNow ? `积压 ${txpool.current?.toLocaleString()}` : `${gasUtil}%`, tone: trafficHot ? "warn" : "ok" },
  ];

  return (
    <div className="status-bar">
      {chips.map((c) => (
        <div key={c.label} className={`status-chip tone-${c.tone}`}>
          <span className="sc-dot" />
          <div className="sc-body">
            <span className="sc-cval">{c.value}</span>
            <span className="sc-clabel">{c.label}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
