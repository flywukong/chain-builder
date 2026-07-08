import { useMemo, useState } from "react";

function cmpVer(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

export default function VersionPanel({ nodeStats }) {
  const [open, setOpen] = useState(null);

  const { rows, total, latest, oldest, behind } = useMemo(() => {
    const map = {};
    (nodeStats ?? []).forEach((n) => {
      const m = /BSC\/v?(\d+\.\d+\.\d+)/i.exec(n.nodeType || "");
      const v = m ? m[1] : "unknown";
      (map[v] ??= []).push(n.instance || n.instanceName || "?");
    });
    const rows = Object.entries(map).sort((a, b) => b[1].length - a[1].length);
    const vers = rows.map((r) => r[0]).filter((v) => v !== "unknown");
    const latest = vers.length ? vers.reduce((a, b) => (cmpVer(b, a) > 0 ? b : a)) : null;
    const oldest = vers.length ? vers.reduce((a, b) => (cmpVer(b, a) < 0 ? b : a)) : null;
    const total = rows.reduce((s, r) => s + r[1].length, 0);
    const behind = latest ? total - (map[latest]?.length ?? 0) : 0;
    return { rows, total, latest, oldest, behind };
  }, [nodeStats]);

  const max = Math.max(1, ...rows.map((r) => r[1].length));
  const latestPct = latest && total ? Math.round(((rows.find((r) => r[0] === latest)?.[1].length ?? 0) / total) * 100) : 0;

  return (
    <div className="panel version-panel">
      <div className="panel-header">
        <span>版本风险</span>
        <span className="sub">{total} nodes</span>
      </div>
      <div className="panel-body version-body">
        <div className="ver-risk">
          <div className="vr-cell"><span className="vr-v" style={{ color: "var(--teal,#3FB8A0)" }}>{latestPct}%</span><span className="vr-l">最新版占比</span></div>
          <div className="vr-cell"><span className="vr-v" style={{ color: behind > 0 ? "var(--orange)" : "var(--green)" }}>{behind}</span><span className="vr-l">落后节点</span></div>
          <div className="vr-cell"><span className="vr-v" style={{ fontSize: 13 }}>{oldest ? "v" + oldest : "—"}</span><span className="vr-l">最老版本</span></div>
        </div>

        <div className="ver-list">
          {rows.length === 0 ? <div className="ver-empty">等待 keter node_stats…</div> :
            rows.map(([v, insts]) => {
              const isLatest = v === latest;
              const color = v === "unknown" ? "var(--muted)" : isLatest ? "var(--teal,#3FB8A0)" : "var(--orange)";
              return (
                <div key={v}>
                  <div className="ver-row clickable" onClick={() => setOpen(open === v ? null : v)}>
                    <span className="ver-caret">{open === v ? "▾" : "▸"}</span>
                    <span className="ver-tag" style={{ color }}>{v === "unknown" ? "?" : "v" + v}</span>
                    <div className="ver-bar-track"><div className="ver-bar" style={{ width: `${(insts.length / max) * 100}%`, background: color }} /></div>
                    <span className="ver-count">{insts.length}{!isLatest && v !== "unknown" ? " ⚠" : ""}</span>
                  </div>
                  {open === v && (
                    <div className="ver-insts">
                      {insts.map((ip, i) => <span key={i} className="ver-inst">{ip}</span>)}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}
