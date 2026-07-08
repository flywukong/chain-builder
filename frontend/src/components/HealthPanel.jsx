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
  // every node not on latest = "behind" (includes unknown), sorted oldest first
  const behindList = [];
  Object.entries(map).forEach(([v, nodes]) => {
    if (v === latest) return;
    nodes.forEach((n) => behindList.push({ ip: n.ip, ver: v, tier: n.tier }));
  });
  behindList.sort((a, b) => (a.ver === "unknown" ? 1 : b.ver === "unknown" ? -1 : cmpVer(a.ver, b.ver)));
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
  const [showBehind, setShowBehind] = useState(true);
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

  // chain-level health = consensus liveness. Keter reorg is the ground truth,
  // tolerating normal micro-reorgs; disk/slash are node/validator sub-items.
  const chainWarn = reorg > REORG_ALERT;

  const cores = [
    { k: "流量", v: trafficHot ? "大流量" : "正常",
      sub: `Gas ${gasUtil}%`, tone: trafficHot ? "warn" : "ok" },
    { k: "Keter 节点 geth", v: ver.latest ? "v" + ver.latest : "—", verCard: true,
      sub: ver.latest ? null : "等待 keter",
      // tone 只看重点层(cabinet+candidate)的落后率
      tone: (() => {
        const c = ver.tiers.cabinet, cd = ver.tiers.candidate;
        const tot = c.total + cd.total, ok = c.ok + cd.ok;
        return tot && (tot - ok) / tot > 0.2 ? "warn" : "ok";
      })() },
  ];
  const TIER_LABELS = [["cabinet", "Cabinet"], ["candidate", "Candidate"], ["inactive", "Inactive"]];

  const subs = [
    { k: "空块 / 24h", v: anomalies, tone: anomalies > 0 ? "warn" : "ok", detail: "empty" },
    { k: "Sync Error", v: syncErrors?.count ?? "--", tone: (syncErrors?.count ?? 0) > 0 ? "warn" : "ok", detail: "sync" },
    { k: "Disk ≥90%", v: disk, tone: disk > 0 ? "warn" : "ok", detail: "disk" },
  ];
  const disks90 = (diskAlerts ?? []).filter((d) => (d.usedPct ?? 0) >= 90).sort((a, b) => b.usedPct - a.usedPct);

  return (
    <div className="panel health-panel">
      <div className="panel-header">
        <span>健康总览<span className={`hp-chain-chip ${chainWarn ? "warn" : "ok"}`}>链健康 {chainWarn ? "WARN" : "OK"}</span></span>
        <span className="sub">{ver.total} nodes</span>
      </div>
      <div className="panel-body health-body">
        <div className="hp-cores">
          {cores.map((c) => (
            <div key={c.k} className={`hp-core tone-${c.tone} ${c.verCard ? "hp-core-ver" : ""}`}>
              <span className="hp-core-v">{c.v}</span>
              <span className="hp-core-k">{c.k}</span>
              {c.verCard && ver.latest && (
                <span className="hp-ver-tiers">
                  {TIER_LABELS.map(([t, label]) => {
                    const d = ver.tiers[t];
                    if (!d.total) return null;
                    return (
                      <span key={t} className={`hp-ver-tier ${t === "inactive" ? "dim" : ""}`}>
                        <em>{label}</em>
                        <span className="hp-ver-track"><span className="hp-ver-fill" style={{ width: `${d.pct}%` }} /></span>
                        <b>{d.ok}/{d.total}</b>
                      </span>
                    );
                  })}
                </span>
              )}
              {c.sub && <span className="hp-core-sub">{c.sub}</span>}
            </div>
          ))}
        </div>

        <div className="hp-subs">
          {subs.map((s) => (
            <div key={s.k} className={`hp-sub tone-${s.tone} ${s.detail ? "hp-sub-click" : ""}`}
                 onClick={s.detail ? () => toggleDetail(s.detail) : undefined}
                 role={s.detail ? "button" : undefined}>
              <span className="hp-sub-dot" />
              <span className="hp-sub-v">{s.v}</span>
              <span className="hp-sub-k">{s.k}</span>
              {s.detail && <span className="hp-sub-caret">{detail === s.detail ? "▾" : "▸"}</span>}
            </div>
          ))}
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
          <div className="hp-behind-head" onClick={() => setShowBehind((x) => !x)} role="button">
            <span className="hp-behind-title">Keter 节点版本风险 · 落后 {ver.behind}</span>
            <span className="hp-behind-caret">{showBehind ? "▾" : "▸"}</span>
          </div>
          {showBehind && (
            ver.behind === 0
              ? <div className="hp-behind-ok">✓ 全部节点已是最新版 v{ver.latest}</div>
              : <div className="hp-behind-list">
                  {ver.behindList.map((b, i) => (
                    <div key={i} className="hp-behind-row">
                      <span className="hp-behind-ip">{b.ip}</span>
                      <span className={`hp-behind-tier ht-${b.tier}`}>{b.tier === "cabinet" ? "CAB" : b.tier === "candidate" ? "CAND" : "—"}</span>
                      <span className="hp-behind-ver">{b.ver === "unknown" ? "?" : "v" + b.ver}</span>
                    </div>
                  ))}
                </div>
          )}
        </div>
      </div>
    </div>
  );
}
