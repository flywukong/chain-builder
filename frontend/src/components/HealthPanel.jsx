import { useMemo, useState } from "react";
import { lookupValidator } from "../data/validators.js";

const API = import.meta.env.VITE_API_BASE ?? "";

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

export default function HealthPanel({ windowStats, nodeStats, diskAlerts, txpool, reorgStats, syncErrors }) {
  const [showAllBehind, setShowAllBehind] = useState(false);   // 默认只看风险 Top 5
  const [detail, setDetail] = useState(null);            // null | 'empty' | 'disk'
  const [emptyView, setEmptyView] = useState(null);      // /api/empty-blocks 结果
  const [emptyAi, setEmptyAi] = useState({ loading: false, text: null, err: null });

  const toggleDetail = (k) => {
    const next = detail === k ? null : k;
    setDetail(next);
    if (next === "empty") {
      fetch(API + "/api/empty-blocks").then((r) => r.json()).then(setEmptyView).catch(() => {});
    }
  };

  const runEmptyAi = async () => {
    setEmptyAi({ loading: true, text: null, err: null });
    try {
      const r = await fetch(API + "/api/ai/empty", { method: "POST" });
      const d = await r.json();
      if (d.error) setEmptyAi({ loading: false, text: null, err: d.error });
      else setEmptyAi({ loading: false, text: d.text, err: null });
    } catch (e) { setEmptyAi({ loading: false, text: null, err: String(e) }); }
  };
  const ws = windowStats;
  const anomalies = ws?.empty24h ?? ws?.anomalyCount ?? 0;   // 空块 24h 滚动计数
  const missed = ws?.missedCount ?? 0;
  const reorg = reorgStats?.reorg24h ?? 0;                 // Keter ground truth (24h)
  // BSC nodes routinely sit at 85%+ disk (large chain data); only ≥90% warrants attention
  const disk = (diskAlerts ?? []).filter((d) => (d.usedPct ?? 0) >= 90).length;
  const gasUtil = ws?.avgGasUtilPct ?? 0;
  const trafficHot = gasUtil >= 90 || !!txpool?.anomalyNow;   // 复合口径:gas≥90% 或 pending>4000
  const ver = useMemo(() => versionInfo(nodeStats), [nodeStats]);

  // 第一行「链运行」:回答"链现在是否正常"。reorg(共识活性)优先于流量
  const chain = reorg > REORG_ALERT
    ? { v: "异常", tone: "bad", aux: `Reorg 24h ${reorg}` }
    : trafficHot
    ? { v: "大流量", tone: "warn", aux: txpool?.anomalyNow ? `pending ${txpool.current?.toLocaleString()}` : `Gas ${gasUtil}%` }
    : { v: "正常", tone: "ok", aux: `Gas ${gasUtil}%` };

  // 第二行「节点版本」:重点覆盖 = cabinet + candidate
  const keyOk = ver.tiers.cabinet.ok + ver.tiers.candidate.ok;
  const keyTot = ver.tiers.cabinet.total + ver.tiers.candidate.total;
  const verTone = keyTot && (keyTot - keyOk) / keyTot > 0.2 ? "warn" : "ok";
  const TIER_LABELS = [["cabinet", "Cabinet"], ["candidate", "Candidate"], ["inactive", "Inactive"]];

  const subs = [
    { k: "空块", v: anomalies, tone: anomalies > 0 ? "warn" : "ok", detail: "empty", title: "24h 滚动计数 · 点击看明细" },
    { k: "Disk ≥90%", v: disk, tone: disk > 0 ? "warn" : "ok", detail: "disk", title: "磁盘使用率 ≥90% 节点 · 点击看明细" },
    { k: "Sync Error", v: syncErrors?.count ?? "--", tone: (syncErrors?.count ?? 0) > 0 ? "warn" : "ok", detail: "sync", title: "同步异常节点 · 点击看明细" },
  ];
  const disks90 = (diskAlerts ?? []).filter((d) => (d.usedPct ?? 0) >= 90).sort((a, b) => b.usedPct - a.usedPct);

  return (
    <div className="panel health-panel">
      <div className="panel-header">
        <span>内部节点健康总览</span>
        <span className="sub">{ver.total} nodes</span>
      </div>
      <div className="panel-body health-body">
        {/* 第一行:链是否正常 → 有没有异常项 */}
        <div className={`hp-row tone-${chain.tone}`}>
          <div className="hp-row-head">
            <span className="hp-row-k">链运行</span>
            <span className="hp-row-v">{chain.v}</span>
            <span className="hp-row-aux">{chain.aux}</span>
          </div>
          <div className="hp-chips">
            {subs.map((s) => (
              <button key={s.k} className={`hp-chip tone-${s.tone}`} title={s.title} onClick={() => toggleDetail(s.detail)}>
                <b>{s.v}</b>
                <span>{s.k}</span>
              </button>
            ))}
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

        {detail && (
          <div className="ai-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setDetail(null); }}>
            <div className="ai-modal hp-modal">
              <div className="ai-modal-head">
                <span className="hp-modal-title">
                  {detail === "empty" ? "空块明细 · 24h" : detail === "sync" ? "Sync Error 节点" : "Disk 使用率 ≥90%"}
                </span>
                <span className="ai-modal-meta">
                  {detail === "empty" ? `判据 gasUsed < 200k · ${emptyView?.count ?? "…"} 块`
                    : detail === "sync" ? `${syncErrors?.windowMin ?? 10}min 增长 < ${syncErrors?.threshold ?? 600} 判异常 · 预期 ~${syncErrors?.expected ?? 1333}`
                    : `${disks90.length} 节点`}
                </span>
                <button className="robot-close" onClick={() => setDetail(null)}>×</button>
              </div>

              {detail === "empty" && (
                !emptyView ? <div className="hpd-empty">加载中…</div>
                  : emptyView.count === 0 ? <div className="hpd-empty">✓ 24h 内无空块</div>
                  : <>
                      <div className="hpd-list">
                        {emptyView.recent.map((b) => (
                          <div key={b.number} className="hpd-row">
                            <span className="hpd-num">#{b.number.toLocaleString()}</span>
                            <span className="hpd-mid">{b.miner ? lookupValidator(b.miner).name : "—"}</span>
                            <span className="hpd-end">{new Date(b.t).toLocaleString("zh-CN", { hour12: false })}</span>
                          </div>
                        ))}
                      </div>
                      <div className="hpd-foot">
                        <button className="st-auto-btn hpd-btn" onClick={runEmptyAi} disabled={emptyAi.loading}>
                          {emptyAi.loading ? "分析中… ~20s" : "⚡ AI 简析"}
                        </button>
                      </div>
                      {emptyAi.err && <div className="ai-err">⚠ {emptyAi.err}</div>}
                      {emptyAi.text && <div className="hpd-ai">{emptyAi.text}</div>}
                    </>
              )}

              {detail === "sync" && (
                !syncErrors ? <div className="hpd-empty">加载中…</div>
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
                    </div>
              )}

              {detail === "disk" && (
                disks90.length === 0 ? <div className="hpd-empty">✓ 无 ≥90% 节点</div>
                  : <div className="hpd-list">
                      {disks90.map((d, i) => (
                        <div key={i} className="hpd-row">
                          <span className="hpd-num">{d.instance}</span>
                          <span className="hpd-mid">{d.instanceName || d.mountpoint || ""}</span>
                          <span className="hpd-end" style={{ color: "var(--orange)" }}>{d.usedPct}%</span>
                        </div>
                      ))}
                    </div>
              )}
            </div>
          </div>
        )}

        <div className="hp-behind">
          <div className="hp-behind-head">
            <span className="hp-behind-title">Keter 节点版本风险 · 落后 {ver.behind}</span>
            {ver.behind > 0 && <span className="hp-behind-hint">风险 Top {Math.min(ver.behind, 5)}</span>}
          </div>
          {ver.behind === 0
            ? <div className="hp-behind-ok">✓ 全部节点已是最新版 v{ver.latest}</div>
            : <>
                <div className="hp-behind-list">
                  {(showAllBehind ? ver.behindList : ver.behindList.slice(0, 5)).map((b, i) => (
                    <div key={i} className="hp-behind-row">
                      <span className="hp-behind-ip">{b.ip}</span>
                      <span className={`hp-behind-tier ht-${b.tier}`}>{b.tier === "cabinet" ? "CAB" : b.tier === "candidate" ? "CAND" : b.ver === "unknown" ? "?" : "—"}</span>
                      <span className="hp-behind-ver">{b.ver === "unknown" ? "未知版本" : "v" + b.ver}</span>
                    </div>
                  ))}
                </div>
                {ver.behind > 5 && (
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
