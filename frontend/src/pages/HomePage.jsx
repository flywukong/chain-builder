import { useEffect, useState } from "react";
import ValidatorRing from "../components/ValidatorRing.jsx";
import HealthPanel from "../components/HealthPanel.jsx";
import { lookupValidator } from "../data/validators.js";

const API = import.meta.env.VITE_API_BASE ?? "";
const DAY = 86400000;
const fmtDay = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };

// BNB Chain 官方公告横幅:最新一条为主,其余在同条内横向轮显;点击跳原文
function AnnounceBanner() {
  const [items, setItems] = useState([]);
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    let alive = true;
    const pull = () => fetch(API + "/api/announce").then((r) => r.json()).then((j) => { if (alive) setItems(j?.items ?? []); }).catch(() => {});
    pull();
    const t = setInterval(pull, 600_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  useEffect(() => {
    if (items.length < 2) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % items.length), 6000);
    return () => clearInterval(t);
  }, [items.length]);
  if (!items.length) return null;
  const a = items[idx % items.length];
  return (
    <a className="announce-banner" href={a.url} target="_blank" rel="noreferrer" title={a.desc || a.title}>
      <span className="ann-badge">📢 BNB Chain 公告</span>
      <span className="ann-body">
        <b className="ann-title">{a.title}</b>
        {a.desc && <span className="ann-desc">{a.desc}</span>}
      </span>
      <span className="ann-date">{a.date}</span>
      {items.length > 1 && (
        <span className="ann-dots">{items.map((_, i) => <i key={i} className={i === idx % items.length ? "on" : ""} />)}</span>
      )}
      <span className="ann-arrow">↗</span>
    </a>
  );
}

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

  // validator 名 + 内部运营标注
  const vName = (addr) => {
    const info = lookupValidator(addr);
    return <>{info.name}{info.group === "internal" && <i className="v-internal">内部</i>}</>;
  };
  const rows = [
    {
      icon: "🛡", label: "Slash · 24h 事件", nav: "alerts",
      val: `${slashEvents?.count ?? 0} 笔`, tone: (slashEvents?.count ?? 0) > 0 || slashed.length ? "warn" : "ok",
      sub: (slashEvents?.count ?? 0) > 0
        ? <>最近 {vName(slashEvents.recent[0].validator)} · #{slashEvents.recent[0].block?.toLocaleString()}</>
        : slashed.length
        ? <>计数中:{slashed.slice(0, 2).map((v, i) => <span key={v.consensusAddr}>{i > 0 && " · "}{vName(v.consensusAddr)}</span>)}</>
        : "全网无 slash",
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
        : trafficLast ? `当前 Gas ${gasUtil ?? "--"}% · 最近 ${fmtDay(trafficLast.peakT)} · ${epDesc(trafficLast)}`
        : `当前 Gas ${gasUtil ?? "--"}% · 30d 无大流量`,
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
      <AnnounceBanner />
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
