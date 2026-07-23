import { useEffect, useMemo, useRef, useState } from "react";

// BSC fast-finality produces occasional harmless 1-block micro-reorgs; only a
// 24h count above this signals real consensus trouble.
const REORG_ALERT = 5;
const DEFAULT_GAS_LIMIT = 55e6;   // 兜底;实际以链上 header 实时值为准

function cmpVer(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function versionInfo(nodeStats) {
  const map = {};
  (nodeStats ?? []).forEach((n) => {
    const m = /BSC\/v?(\d+\.\d+\.\d+)/i.exec(n.nodeType || "");
    const v = m ? m[1] : "unknown";
    (map[v] ??= []).push({ ip: n.instance || n.instanceName || "?", tier: n.tier || "inactive" });
  });
  const vers = Object.keys(map).filter((v) => v !== "unknown");
  const latest = vers.length ? vers.reduce((a, b) => (cmpVer(b, a) > 0 ? b : a)) : null;
  const total = Object.values(map).reduce((s, a) => s + a.length, 0);
  // 主流版本 = 已知版本里出块节点数最多的(众数):健康基线。落后与升级覆盖率都以主流为准,
  // 而非以个别抢先升级的最新版为准——否则占多数的主流会被误判为「落后 / 未升级」。
  const mainstream = vers.length ? vers.reduce((a, b) => (map[b].length > map[a].length ? b : a)) : null;
  const latestCount = latest ? map[latest].length : 0;
  const latestPct = latest && total ? Math.round((latestCount / total) * 100) : 0;
  const mainstreamCount = mainstream ? map[mainstream].length : 0;
  const mainstreamPct = mainstream && total ? Math.round((mainstreamCount / total) * 100) : 0;
  const belowMain = (v) => v === "unknown" || (mainstream && cmpVer(v, mainstream) < 0);
  // 落后 = 版本低于主流(含 unknown);比主流更新的激进版本不算落后
  const behindList = [];
  Object.entries(map).forEach(([v, nodes]) => {
    if (!belowMain(v)) return;
    nodes.forEach((n) => behindList.push({ ip: n.ip, ver: v, tier: n.tier }));
  });
  // 风险排序:Cabinet 落后 > Candidate 落后 > Inactive 落后 > unknown 版本;组内版本越旧越靠前
  const TIER_RANK = { cabinet: 0, candidate: 1, inactive: 2 };
  const risk = (b) => (b.ver === "unknown" ? 3 : TIER_RANK[b.tier] ?? 2);
  behindList.sort((a, b) => risk(a) - risk(b) || (a.ver === "unknown" ? 0 : cmpVer(a.ver, b.ver)));
  // 分层升级覆盖率:ok = 版本 ≥ 主流(在主流或更新);cabinet(出块中) / candidate(当选) 是重点,inactive 参考
  const tiers = {};
  for (const t of ["cabinet", "candidate", "inactive"]) tiers[t] = { total: 0, ok: 0 };
  Object.entries(map).forEach(([v, nodes]) => {
    nodes.forEach((n) => {
      const t = tiers[n.tier] ?? tiers.inactive;
      t.total++;
      if (!belowMain(v)) t.ok++;
    });
  });
  for (const t of Object.values(tiers)) t.pct = t.total ? Math.round((t.ok / t.total) * 100) : null;
  return { latest, latestPct, latestCount, mainstream, mainstreamPct, mainstreamCount, total, behind: behindList.length, behindList, tiers };
}

// Gas 利用率迷你走势(24h,2 台典型节点均值)
function GasSpark({ gasUsed, gasLimit }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.offsetWidth, H = canvas.offsetHeight;
      if (!W || !H) return;
      canvas.width = W * dpr; canvas.height = H * dpr;
      const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const s = gasUsed?.avg?.[0];
      const vals = (s?.values ?? []).filter((v) => typeof v === "number").map((v) => (v / (gasLimit || DEFAULT_GAS_LIMIT)) * 100);
      if (!vals.length) return;
      const max = Math.max(...vals, 40) * 1.1;
      ctx.strokeStyle = "#3FB8A0"; ctx.lineWidth = 1.4; ctx.lineJoin = "round";
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, "rgba(63,184,160,.25)"); grad.addColorStop(1, "rgba(63,184,160,.02)");
      ctx.beginPath();
      vals.forEach((v, i) => {
        const x = (i / Math.max(vals.length - 1, 1)) * W;
        const y = H - (v / max) * (H - 4) - 2;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
    }
    draw();
    const ro = new ResizeObserver(draw); ro.observe(canvas);
    return () => ro.disconnect();
  }, [gasUsed, gasLimit]);
  return <canvas ref={ref} className="hp-gas-spark" />;
}

export default function HealthPanel({ windowStats, nodeStats, txpool, reorgStats, syncErrors, gasUsed, gasLimit }) {
  const [showSync, setShowSync] = useState(false);
  const [showBehind, setShowBehind] = useState(false);

  const ws = windowStats;
  const reorg = reorgStats?.reorg24h ?? 0;                 // Keter ground truth (24h)
  const gasUtil = ws?.avgGasUtilPct ?? 0;
  const ver = useMemo(() => versionInfo(nodeStats), [nodeStats]);

  // 第一行:链运行(共识活性,看 reorg)与 流量分级,两个并列大字
  const chain = reorg > REORG_ALERT ? { v: "异常", tone: "bad" } : { v: "正常", tone: "ok" };
  // 流量按 Gas 利用率分级:<30 低 / 30~60 中等 / 60~90 大流量 / ≥90 超大流量
  const gasLevel =
    gasUtil >= 90 ? { v: "超大流量", tone: "bad" } :
    gasUtil >= 60 ? { v: "大流量", tone: "warn" } :
    gasUtil >= 30 ? { v: "中等", tone: "mid" } :
    { v: "低", tone: "ok" };
  const traffic = { ...gasLevel, aux: `Gas ${gasUtil}%` };
  if (txpool?.anomalyNow) {   // pending 积压是独立拥堵信号,叠加提示
    traffic.aux = `pending ${txpool.current?.toLocaleString()} · Gas ${gasUtil}%`;
    if (traffic.tone === "ok" || traffic.tone === "mid") traffic.tone = "warn";
  }
  const rowTone = chain.tone === "bad" || traffic.tone === "bad" ? "bad" : traffic.tone === "warn" ? "warn" : "ok";

  const syncCount = syncErrors?.count ?? null;

  // 「节点版本」:重点覆盖 = cabinet + candidate
  const keyOk = ver.tiers.cabinet.ok + ver.tiers.candidate.ok;
  const keyTot = ver.tiers.cabinet.total + ver.tiers.candidate.total;
  const verTone = keyTot && (keyTot - keyOk) / keyTot > 0.2 ? "warn" : "ok";
  const TIER_LABELS = [["cabinet", "Cabinet"], ["candidate", "Candidate"], ["inactive", "Inactive"]];

  return (
    <div className="panel health-panel">
      <div className="panel-header">
        <span className="hp-title-badge">内部 Validator 健康总览</span>
        <span className="sub">{ver.total} nodes</span>
      </div>
      <div className="panel-body health-body">
        {/* 第一行:链运行 + 流量,并列大字;Sync 异常 chip */}
        <div className={`hp-row tone-${rowTone}`}>
          <div className="hp-row-head">
            <span className="hp-row-k">链运行</span>
            <span className={`hp-row-v t-${chain.tone}`}>{chain.v}</span>
            <span className="hp-row-k hp-k2">流量</span>
            <span className={`hp-row-v t-${traffic.tone}`}>{traffic.v}</span>
            <span className="hp-row-aux">{traffic.aux}</span>
          </div>
          <div className="hp-chips">
            <button className={`hp-chip tone-${(syncCount ?? 0) > 0 ? "warn" : "ok"}`}
                    title="同步异常节点 · 点击看明细" onClick={() => setShowSync(true)}>
              <b>{syncCount ?? "--"}</b>
              <span>Sync 异常</span>
            </button>
          </div>
        </div>

        {/* 第二行:节点版本;落后节点收进按钮弹窗 */}
        <div className={`hp-row hp-row-ver tone-${verTone}`}>
          <div className="hp-row-head">
            <span className="hp-row-k">节点版本</span>
            <span className="hp-row-v">{ver.mainstream ? "v" + ver.mainstream : "—"}</span>
            {!ver.mainstream && <span className="hp-row-aux">等待 keter</span>}
            {ver.mainstream && (
              ver.behind > 0
                ? <button className="hp-behind-btn" onClick={() => setShowBehind(true)}>落后版本 点击查看</button>
                : <span className="hp-behind-none">✓ 无落后节点</span>
            )}
          </div>
          {ver.mainstream && (
            <div className="hp-ver-dist">
              主流 v{ver.mainstream} · {ver.mainstreamPct}%({ver.mainstreamCount} 个)
              {ver.latest && ver.latest !== ver.mainstream && <> · 最新 v{ver.latest} · {ver.latestPct}%({ver.latestCount} 个,较新)</>}
            </div>
          )}
          {ver.mainstream && (
            <div className="hp-tier-rows">
              {TIER_LABELS.map(([t, label]) => {
                const d = ver.tiers[t];
                if (!d.total) return null;
                return (
                  <div key={t} className={`hp-tier-row ${t === "inactive" ? "dim" : d.ok === d.total ? "full" : "part"}`}>
                    <em>{label}</em>
                    <span className="hp-tier-track"><span className="hp-tier-fill" style={{ width: `${d.pct}%` }} /></span>
                    <b>{d.ok}/{d.total}</b>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 第三行:Gas 利用率(24h 走势 + 大流量结论:利用率 ≥90% 计一次,相邻分钟合并) */}
        {(() => {
          const gl = gasLimit || DEFAULT_GAS_LIMIT;
          const utils = (gasUsed?.avg?.[0]?.values ?? []).filter((v) => typeof v === "number").map((v) => (v / gl) * 100);
          let surges = 0, inSeg = false, gap = 0, peak = 0;
          for (const u of utils) {
            if (u > peak) peak = u;
            if (u >= 90) { if (!inSeg) { surges++; inSeg = true; } gap = 0; }
            else if (inSeg && ++gap > 2) inSeg = false;
          }
          return (
            <div className={`hp-row tone-${gasLevel.tone === "mid" ? "ok" : gasLevel.tone}`}>
              <div className="hp-row-head">
                <span className="hp-row-k">Gas 利用率</span>
                <span className={`hp-row-v t-${gasLevel.tone}`}>{gasUtil}%</span>
                <span className={`hp-row-aux hp-gas-surge ${surges ? "hot" : "ok"}`}>
                  {!utils.length ? "" : surges
                    ? <>最近 24h 大流量 {surges} 次<br />打满 {Math.round(peak)}%</>
                    : <>最近 24h 无大流量<br />峰值 {Math.round(peak)}%</>}
                </span>
              </div>
              <GasSpark gasUsed={gasUsed} gasLimit={gasLimit} />
            </div>
          );
        })()}

        {showSync && (
          <div className="ai-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setShowSync(false); }}>
            <div className="ai-modal hp-modal">
              <div className="ai-modal-head">
                <span className="hp-modal-title">Sync 异常节点</span>
                <span className="ai-modal-meta">
                  {syncErrors?.windowMin ?? 10}min 增长 &lt; {syncErrors?.threshold ?? 600} 判异常 · 预期 ~{syncErrors?.expected ?? 1333}
                </span>
                <button className="robot-close" onClick={() => setShowSync(false)}>×</button>
              </div>
              {!syncErrors ? <div className="hpd-empty">加载中…</div>
                : syncErrors.count === 0
                ? <div className="hpd-empty">✓ 全部节点同步正常({syncErrors.total} 节点 · {syncErrors.windowMin}min 增长 ≥{syncErrors.threshold},预期 ~{syncErrors.expected})</div>
                : <div className="hpd-list">
                    {syncErrors.nodes.map((n) => (
                      <div key={n.instance} className="hpd-row">
                        <span className="hpd-num">{n.instance}</span>
                        <span className="hpd-mid">{n.job || ""}</span>
                        <span className="hpd-end" style={{ color: "var(--orange)" }}>{n.grew} / {syncErrors.expected} 块·{syncErrors.windowMin}min</span>
                      </div>
                    ))}
                  </div>}
            </div>
          </div>
        )}

        {showBehind && (
          <div className="ai-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setShowBehind(false); }}>
            <div className="ai-modal hp-modal">
              <div className="ai-modal-head">
                <span className="hp-modal-title">落后版本节点 · {ver.behind}</span>
                <span className="ai-modal-meta">落后 = 低于主流 v{ver.mainstream} · 风险排序:Cabinet → Candidate → Inactive → 未知版本</span>
                <button className="robot-close" onClick={() => setShowBehind(false)}>×</button>
              </div>
              <div className="hpd-list">
                {ver.behindList.map((b, i) => (
                  <div key={i} className="hp-behind-row">
                    <span className="hp-behind-ip">{b.ip}</span>
                    <span className={`hp-behind-tier ht-${b.tier}`}>{b.tier === "cabinet" ? "CAB" : b.tier === "candidate" ? "CAND" : b.ver === "unknown" ? "?" : "—"}</span>
                    <span className="hp-behind-ver">{b.ver === "unknown" ? "未知版本" : "v" + b.ver}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
