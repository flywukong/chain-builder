import { useMemo, useState } from "react";

// BSC fast-finality produces occasional harmless 1-block micro-reorgs; only a
// 24h count above this signals real consensus trouble.
const REORG_ALERT = 5;

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
  const latestCount = latest ? map[latest].length : 0;
  const latestPct = latest && total ? Math.round((latestCount / total) * 100) : 0;
  // every node not on latest = "behind" (includes unknown)
  const behindList = [];
  Object.entries(map).forEach(([v, nodes]) => {
    if (v === latest) return;
    nodes.forEach((n) => behindList.push({ ip: n.ip, ver: v, tier: n.tier }));
  });
  // 风险排序:Cabinet 落后 > Candidate 落后 > Inactive 落后 > unknown 版本;组内版本越旧越靠前
  const TIER_RANK = { cabinet: 0, candidate: 1, inactive: 2 };
  const risk = (b) => (b.ver === "unknown" ? 3 : TIER_RANK[b.tier] ?? 2);
  behindList.sort((a, b) => risk(a) - risk(b) || (a.ver === "unknown" ? 0 : cmpVer(a.ver, b.ver)));
  // 分层升级覆盖率:cabinet(出块中) / candidate(当选) 是重点,inactive 参考
  const tiers = {};
  for (const t of ["cabinet", "candidate", "inactive"]) tiers[t] = { total: 0, ok: 0 };
  Object.entries(map).forEach(([v, nodes]) => {
    nodes.forEach((n) => {
      const t = tiers[n.tier] ?? tiers.inactive;
      t.total++;
      if (v === latest) t.ok++;
    });
  });
  for (const t of Object.values(tiers)) t.pct = t.total ? Math.round((t.ok / t.total) * 100) : null;
  return { latest, latestPct, total, behind: behindList.length, behindList, tiers };
}

export default function HealthPanel({ windowStats, nodeStats, txpool, reorgStats, syncErrors }) {
  const [showAllBehind, setShowAllBehind] = useState(false);   // 默认只看风险 Top 3
  const [showSync, setShowSync] = useState(false);

  const ws = windowStats;
  const reorg = reorgStats?.reorg24h ?? 0;                 // Keter ground truth (24h)
  const gasUtil = ws?.avgGasUtilPct ?? 0;
  const ver = useMemo(() => versionInfo(nodeStats), [nodeStats]);

  // 第一行:链运行(共识活性,看 reorg)与 流量分级,两个并列大字
  const chain = reorg > REORG_ALERT ? { v: "异常", tone: "bad" } : { v: "正常", tone: "ok" };
  // 流量按 Gas 利用率分级:<30 低 / 30~60 中等 / 60~90 大流量 / ≥90 超大流量
  const traffic =
    gasUtil >= 90 ? { v: "超大流量", tone: "bad" } :
    gasUtil >= 60 ? { v: "大流量", tone: "warn" } :
    gasUtil >= 30 ? { v: "中等", tone: "mid" } :
    { v: "低 Gas", tone: "ok" };
  traffic.aux = `Gas ${gasUtil}%`;
  if (txpool?.anomalyNow) {   // pending 积压是独立拥堵信号,叠加提示
    traffic.aux = `pending ${txpool.current?.toLocaleString()} · Gas ${gasUtil}%`;
    if (traffic.tone === "ok" || traffic.tone === "mid") traffic.tone = "warn";
  }
  const rowTone = chain.tone === "bad" || traffic.tone === "bad" ? "bad" : traffic.tone === "warn" ? "warn" : "ok";

  const syncCount = syncErrors?.count ?? null;

  // 第二行「节点版本」:重点覆盖 = cabinet + candidate
  const keyOk = ver.tiers.cabinet.ok + ver.tiers.candidate.ok;
  const keyTot = ver.tiers.cabinet.total + ver.tiers.candidate.total;
  const verTone = keyTot && (keyTot - keyOk) / keyTot > 0.2 ? "warn" : "ok";
  const TIER_LABELS = [["cabinet", "Cabinet"], ["candidate", "Candidate"], ["inactive", "Inactive"]];

  return (
    <div className="panel health-panel">
      <div className="panel-header">
        <span>内部节点健康总览</span>
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

        {/* 第二行:节点版本是否需要处理 → 下方列表看哪些落后 */}
        <div className={`hp-row hp-row-ver tone-${verTone}`}>
          <div className="hp-row-head">
            <span className="hp-row-k">节点版本</span>
            <span className="hp-row-v">{ver.latest ? "v" + ver.latest : "—"}</span>
            <span className="hp-row-aux">{ver.latest ? `重点覆盖 ${keyOk}/${keyTot}` : "等待 keter"}</span>
          </div>
          {ver.latest && (
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

        <div className="hp-behind">
          <div className="hp-behind-head">
            <span className="hp-behind-title">Keter 节点版本风险 · 落后 {ver.behind}</span>
            {ver.behind > 0 && <span className="hp-behind-hint">风险 Top {Math.min(ver.behind, 3)}</span>}
          </div>
          {ver.behind === 0
            ? <div className="hp-behind-ok">✓ 全部节点已是最新版 v{ver.latest}</div>
            : <>
                <div className="hp-behind-list">
                  {(showAllBehind ? ver.behindList : ver.behindList.slice(0, 3)).map((b, i) => (
                    <div key={i} className="hp-behind-row">
                      <span className="hp-behind-ip">{b.ip}</span>
                      <span className={`hp-behind-tier ht-${b.tier}`}>{b.tier === "cabinet" ? "CAB" : b.tier === "candidate" ? "CAND" : b.ver === "unknown" ? "?" : "—"}</span>
                      <span className="hp-behind-ver">{b.ver === "unknown" ? "未知版本" : "v" + b.ver}</span>
                    </div>
                  ))}
                </div>
                {ver.behind > 3 && (
                  <button className="hp-behind-more" onClick={() => setShowAllBehind((x) => !x)}>
                    {showAllBehind ? "收起 ▴" : `展开全部 ${ver.behind} ▾`}
                  </button>
                )}
              </>}
        </div>
      </div>
    </div>
  );
}
