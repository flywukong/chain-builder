import { useEffect, useState } from "react";
import ValidatorRing from "../components/ValidatorRing.jsx";
import HealthPanel from "../components/HealthPanel.jsx";
import { lookupValidator } from "../data/validators.js";

const API = import.meta.env.VITE_API_BASE ?? "";
const DAY = 86400000;
const fmtDay = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };

// 安全 & 近期事件 — 合并原 Slash / 流量两卡:slash + 近7d reorg + 近7d 大流量,点击跳子系统
// 大流量口径:区块 gas 利用率 ≥ hotPct(90%);pending 仅积压参考
function SafetyEventsCard({ slashStatus, slashEvents, reorgTimeline, trafficTimeline, txpool, gasUtil, onNav }) {
  const [days, setDays] = useState(7);          // 3/7/15/30;slash 与 reorg 数据窗口上限 15 天
  const slashDays = Math.min(days, 15);
  const reorgDays = Math.min(days, 15);
  const winLabel = (d) => (d === 1 ? "24h" : `近 ${d} 天`);
  const slashed = (slashStatus ?? []).filter((v) => v.slashCount > 0).sort((a, b) => b.slashCount - a.slashCount);
  const now = Date.now();

  // slash 按所选窗口拉取(WS 推送的 slashEvents 固定 24h,只作兜底)
  const [slashWin, setSlashWin] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch(API + `/api/slash-events?days=${slashDays}`).then((r) => r.json()).then((j) => { if (alive) setSlashWin(j); }).catch(() => {});
    return () => { alive = false; };
  }, [slashDays]);
  const sw = slashWin ?? slashEvents;

  const rDays = reorgTimeline?.days ?? [];
  const reorgN = rDays.slice(-reorgDays).reduce((s, d) => s + (d.count || 0), 0);
  const reorgLast = reorgTimeline?.events?.[0] ?? null;

  const hotPct = trafficTimeline?.hotPct ?? 90;
  const liveHot = (gasUtil ?? 0) >= hotPct || !!txpool?.anomalyNow;   // 复合口径
  const eps = trafficTimeline?.episodes ?? [];
  const trafficN = eps.filter((e) => now - e.start <= days * DAY).length;
  const trafficLast = eps.at(-1) ?? null;
  const epDesc = (e) => e.trigger?.includes("gas") && !e.trigger?.includes("pending")
    ? `gas ${e.peakGasPct}%` : `pending ${e.peakPending?.toLocaleString()}`;

  // validator 名 + 内部运营标注
  const vName = (addr) => {
    const info = lookupValidator(addr);
    return <>{info.name}{info.group === "internal" && <i className="v-internal">内部</i>}</>;
  };
  const rows = [
    {
      icon: "🛡", label: `Slash · ${winLabel(slashDays)}`, nav: "alerts",
      val: `${sw?.count ?? 0} 笔`, tone: (sw?.count ?? 0) > 0 || slashed.length ? "warn" : "ok",
      sub: (sw?.count ?? 0) > 0
        ? <>最近 {vName(sw.recent[0].validator)} · #{sw.recent[0].block?.toLocaleString()}</>
        : slashed.length
        ? <>计数中:{slashed.slice(0, 2).map((v, i) => <span key={v.consensusAddr}>{i > 0 && " · "}{vName(v.consensusAddr)}</span>)}</>
        : "全网无 slash",
    },
    {
      icon: "⛓", label: `Reorg · ${winLabel(reorgDays)}`, nav: "monitor",
      val: `${reorgN} 次`, tone: reorgN > 5 ? "warn" : "ok",
      sub: reorgLast ? `最近 ${fmtDay(reorgLast.t)} · 链级去重` : "链级去重口径",
    },
    {
      icon: "🌊", label: `大流量 · ${winLabel(days)}`, nav: "traffic",
      val: liveHot ? "进行中" : `${trafficN} 次`, tone: trafficN > 0 || liveHot ? "warn" : "ok",
      sub: liveHot ? (txpool?.anomalyNow ? `pending ${txpool.current?.toLocaleString()} 超阈` : `Gas ${gasUtil}% ≥ ${hotPct}%`)
        : trafficLast ? `当前 Gas ${gasUtil ?? "--"}% · 最近 ${fmtDay(trafficLast.peakT)} · ${epDesc(trafficLast)}`
        : `当前 Gas ${gasUtil ?? "--"}% · 30d 无大流量`,
    },
  ];

  return (
    <div className="panel se-card">
      <div className="panel-header">
        <span>安全 &amp; 近期事件</span>
        <span className="se-win">
          {[3, 7, 15, 30].map((d) => (
            <button key={d} className={`tf-range ${days === d ? "on" : ""}`} onClick={() => setDays(d)}>{d}天</button>
          ))}
        </span>
      </div>
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
            txpool={tx}
            reorgStats={state.reorgStats}
            syncErrors={state.syncErrors}
            gasUsed={state.gasUsed}
            gasLimit={state.latestBlock?.gasLimit}
          />

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
