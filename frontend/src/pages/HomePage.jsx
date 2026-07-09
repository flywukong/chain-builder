import ValidatorRing from "../components/ValidatorRing.jsx";
import HealthPanel from "../components/HealthPanel.jsx";
import AiAnalysisPanel from "../components/AiAnalysisPanel.jsx";
import { lookupValidator } from "../data/validators.js";

const DAY = 86400000;
const fmtDay = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };

// 安全 & 近期事件 — 合并原 Slash / 流量两卡:slash + 近7d reorg + 近7d 大流量,点击跳子系统
// 大流量口径:区块 gas 利用率 ≥ hotPct(90%);pending 仅积压参考
function SafetyEventsCard({ slashStatus, slashEvents, reorgTimeline, trafficTimeline, txpool, gasUtil, onNav }) {
  const slashed = (slashStatus ?? []).filter((v) => v.slashCount > 0).sort((a, b) => b.slashCount - a.slashCount);
  const now = Date.now();

  const rDays = reorgTimeline?.days ?? [];
  const reorg7d = rDays.slice(-7).reduce((s, d) => s + (d.count || 0), 0);
  const reorgLast = reorgTimeline?.events?.[0] ?? null;

  const hotPct = trafficTimeline?.hotPct ?? 90;
  const liveHot = (gasUtil ?? 0) >= hotPct || !!txpool?.anomalyNow;   // 复合口径
  const eps = trafficTimeline?.episodes ?? [];
  const traffic7d = eps.filter((e) => now - e.start <= 7 * DAY).length;
  const trafficLast = eps.at(-1) ?? null;
  const epDesc = (e) => e.trigger?.includes("gas") && !e.trigger?.includes("pending")
    ? `gas ${e.peakGasPct}%` : `pending ${e.peakPending?.toLocaleString()}`;

  const rows = [
    {
      icon: "🛡", label: "Slash · 24h 事件", nav: "alerts",
      val: `${slashEvents?.count ?? 0} 笔`, tone: (slashEvents?.count ?? 0) > 0 || slashed.length ? "warn" : "ok",
      sub: (slashEvents?.count ?? 0) > 0
        ? `最近 ${lookupValidator(slashEvents.recent[0].validator).name} · #${slashEvents.recent[0].block?.toLocaleString()}`
        : slashed.length ? `计数中:${slashed.slice(0, 2).map((v) => lookupValidator(v.consensusAddr).name).join(" · ")}` : "全网无 slash",
    },
    {
      icon: "⛓", label: "Reorg · 近 7 天", nav: "monitor",
      val: `${reorg7d} 次`, tone: reorg7d > 5 ? "warn" : "ok",
      sub: reorgLast ? `最近 ${fmtDay(reorgLast.t)} · 链级去重` : "链级去重口径",
    },
    {
      icon: "🌊", label: `大流量 · 近 7 天`, nav: "traffic",
      val: liveHot ? "进行中" : `${traffic7d} 次`, tone: traffic7d > 0 || liveHot ? "warn" : "ok",
      sub: liveHot ? (txpool?.anomalyNow ? `pending ${txpool.current?.toLocaleString()} 超阈` : `Gas ${gasUtil}% ≥ ${hotPct}%`)
        : trafficLast ? `当前 Gas ${gasUtil ?? "--"}% 正常 · 最近 ${fmtDay(trafficLast.peakT)} · ${epDesc(trafficLast)}`
        : `当前 Gas ${gasUtil ?? "--"}% 正常 · 30d 无大流量`,
    },
  ];

  return (
    <div className="panel se-card">
      <div className="panel-header"><span>安全 &amp; 近期事件</span><span className="sub">近 7 天 · 点击查看</span></div>
      <div className="panel-body se-body">
        {rows.map((r) => (
          <div key={r.label} className={`se-row tone-${r.tone}`} onClick={() => onNav(r.nav)} role="button">
            <span className="se-ico">{r.icon}</span>
            <div className="se-mid">
              <span className="se-label">{r.label}</span>
              <span className="se-sub">{r.sub}</span>
            </div>
            <span className="se-val">{r.val}</span>
            <span className="se-arrow">→</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function HomePage({ state, onNav }) {
  const tx = state.txpool;

  return (
    <div className="home">
      <div className="home-hero">
        <ValidatorRing
          latestBlock={state.latestBlock}
          windowStats={state.windowStats}
          mevStats={state.mevStats}
          blockGas={state.blockGas}
          slashStatus={state.slashStatus}
          recentBlocks={state.recentBlocks}
        />

        <div className="home-right">
          <HealthPanel
            windowStats={state.windowStats}
            slashStatus={state.slashStatus}
            nodeStats={state.nodeStats}
            diskAlerts={state.diskAlerts}
            reorgStats={state.reorgStats}
            syncErrors={state.syncErrors}
          />

          <AiAnalysisPanel />

          <SafetyEventsCard
            slashStatus={state.slashStatus}
            slashEvents={state.slashEvents}
            reorgTimeline={state.reorgTimeline}
            trafficTimeline={state.trafficTimeline}
            txpool={tx}
            gasUtil={state.windowStats?.avgGasUtilPct}
            onNav={onNav}
          />
        </div>
      </div>
    </div>
  );
}
