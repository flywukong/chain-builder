import { useEffect, useState } from "react";
import { lookupValidator } from "../data/validators.js";

const API = import.meta.env.VITE_API_BASE ?? "";
const fmtT = (t) => new Date(t).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

// 空块详情(24h 滚动,判据 gasUsed < 200k):计数 + 按 validator 聚合 + 最近列表 + AI 简析
export default function EmptyBlocksPanel() {
  const [d, setD] = useState(null);
  const [ai, setAi] = useState({ loading: false, text: null, err: null });

  useEffect(() => {
    let alive = true;
    const pull = () => fetch(API + "/api/empty-blocks").then((r) => r.json()).then((j) => { if (alive) setD(j); }).catch(() => {});
    pull();
    const t = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const runAi = async () => {
    setAi({ loading: true, text: null, err: null });
    try {
      const r = await fetch(API + "/api/ai/empty", { method: "POST" });
      const j = await r.json();
      if (j.error) setAi({ loading: false, text: null, err: j.error });
      else setAi({ loading: false, text: j.text, err: null });
    } catch (e) { setAi({ loading: false, text: null, err: String(e) }); }
  };

  // 按 validator 聚合,谁出的空块最多
  const byMiner = {};
  (d?.recent ?? []).forEach((b) => {
    const name = b.miner ? lookupValidator(b.miner).name : "未知";
    byMiner[name] = (byMiner[name] ?? 0) + 1;
  });
  const miners = Object.entries(byMiner).sort((a, b) => b[1] - a[1]);
  const maxM = miners[0]?.[1] ?? 1;

  return (
    <div className="panel eb-panel">
      <div className="panel-header">
        <span>空块 · 24h</span>
        <span className="sub">判据 gasUsed &lt; 200k · 60s 刷新</span>
      </div>
      <div className="panel-body eb-body">
        <div className="eb-top">
          <div className={`eb-count ${(d?.count ?? 0) > 0 ? "warn" : "ok"}`}>
            <b>{d?.count ?? "--"}</b>
            <span>空块 / 24h</span>
          </div>
          <div className="eb-miners">
            {miners.length === 0
              ? <div className="eb-none">✓ 24h 内无空块</div>
              : miners.slice(0, 5).map(([name, n]) => (
                  <div key={name} className="eb-miner">
                    <em>{name}</em>
                    <span className="eb-mbar"><i style={{ width: `${(n / maxM) * 100}%` }} /></span>
                    <b>{n}</b>
                  </div>
                ))}
          </div>
        </div>

        {(d?.recent?.length ?? 0) > 0 && (
          <div className="eb-list">
            {d.recent.slice(0, 30).map((b) => (
              <div key={b.number} className="hpd-row">
                <span className="hpd-num">#{b.number.toLocaleString()}</span>
                <span className="hpd-mid">{b.miner ? lookupValidator(b.miner).name : "—"}</span>
                <span className="hpd-end">{fmtT(b.t)}</span>
              </div>
            ))}
          </div>
        )}

        <div className="eb-foot">
          <button className="st-auto-btn" onClick={runAi} disabled={ai.loading || !(d?.count > 0)}>
            {ai.loading ? "分析中… ~20s" : "⚡ AI 简析"}
          </button>
        </div>
        {ai.err && <div className="ai-err">⚠ {ai.err}</div>}
        {ai.text && <div className="hpd-ai">{ai.text}</div>}
      </div>
    </div>
  );
}
