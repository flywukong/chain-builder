import { useEffect, useState } from "react";

const API = import.meta.env.VITE_API_BASE ?? "";
const DAY_OPTIONS = [1, 3, 7, 14, 30];

export default function AiAnalysisPanel() {
  const [s, setS] = useState({ loading: false, text: null, verdict: null, at: null, err: null, auto: false, windowDays: null });
  const [days, setDays] = useState(7);
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // 展开时拉取与 AI 同源的维度明细(warn/alert 也先折叠成一行按钮)
  const ok = s.verdict === "ok";
  const showFull = s.text && !ok && expanded;   // 正常态无弹窗(首页已有全部维度)
  // 正文首行的「正常/需关注/告警」与徽条重复,展示时剥掉
  const displayText = (t) => {
    if (!t) return t;
    const lines = t.split("\n");
    const head = (lines[0] || "").replace(/[*#\s：:]/g, "");
    if (/^(总体结论)?(正常|需关注|告警)/.test(head)) return lines.slice(1).join("\n").trim();
    return t;
  };
  // load cached analysis on mount, then poll so the hourly auto-refresh shows up
  useEffect(() => {
    let alive = true;
    const pull = () => fetch(API + "/api/ai/analyze")
      .then((r) => r.json())
      .then((d) => {
        if (!alive || !d?.text) return;
        setS((x) => (x.loading || (x.at && d.at && d.at <= x.at) ? x
          : { loading: false, text: d.text, verdict: d.verdict ?? "ok", at: d.at, err: null, auto: !!d.auto, windowDays: d.windowDays ?? null }));
      })
      .catch(() => {});
    pull();
    const t = setInterval(pull, 90_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const run = async (d = days) => {
    setS((x) => ({ ...x, loading: true, err: null }));
    try {
      const r = await fetch(API + "/api/ai/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ days: d }),
      });
      const j = await r.json();
      if (j.error) setS((x) => ({ ...x, loading: false, err: j.error }));
      else if (j.running) setS((x) => ({ ...x, loading: false, err: "已有分析在进行中，请稍候" }));
      else { setS({ loading: false, text: j.text, verdict: j.verdict ?? "ok", at: j.at, err: null, auto: false, windowDays: j.windowDays }); setExpanded(true); }
    } catch (e) {
      setS((x) => ({ ...x, loading: false, err: String(e) }));
    }
  };

  const pickDays = (d) => {
    setDays(d); setMenuOpen(false);
    run(d);   // 选择即按新窗口重新分析
  };

  return (
    <div className="panel ai-panel">
      <div className="panel-header">
        <span>🤖 AI 分析 · 最近 {days} 天</span>
        <span className="ai-days-wrap">
          <button className="tf-range on" onClick={() => setMenuOpen((x) => !x)}>{days}天 ▾</button>
          {menuOpen && (
            <span className="ai-days-menu">
              {DAY_OPTIONS.map((d) => (
                <button key={d} className={`tf-range ${d === days ? "on" : ""}`} onClick={() => pickDays(d)}>{d}天</button>
              ))}
            </span>
          )}
        </span>
      </div>
      <div className="panel-body ai-body">
        {!s.text && !s.loading && (
          <div className="ai-empty">分析最近 {days} 天网络指标（流量 / 共识 / 安全），仅在偏离基线时展开异常详情 · 每小时自动巡检</div>
        )}

        {s.text && !expanded && (ok ? (
          <div className="ai-okline">
            <span className="ai-okdot" />
            <span className="ai-oktext">各项指标正常 · 无需关注</span>
          </div>
        ) : (
          <div className={`ai-warnline ${s.verdict === "alert" ? "alert" : ""}`} onClick={() => setExpanded(true)} role="button">
            <span className="ai-warnico">{s.verdict === "alert" ? "⛔" : "⚠"}</span>
            <span className="ai-warntext">检测到{s.verdict === "alert" ? "告警" : "需关注"}项</span>
            <button className={`ai-warn-cta ${s.verdict === "alert" ? "alert" : ""}`}>⚡ 分析异常 ▸</button>
          </div>
        ))}

        {showFull && (
          <div className="ai-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setExpanded(false); }}>
            <div className="ai-modal">
              <div className="ai-modal-head">
                <span className={`ai-verdict ai-${ok ? "okv" : s.verdict}`}>
                  {ok ? "✓ 正常" : s.verdict === "alert" ? "⛔ 告警" : "⚠ 需关注"}
                </span>
                <span className="ai-modal-meta">最近 {s.windowDays ?? days} 天{s.auto ? " · 自动巡检" : " · 实时"}{s.at ? ` · ${new Date(s.at).toLocaleTimeString()}` : ""}</span>
                <button className="robot-close" onClick={() => setExpanded(false)}>×</button>
              </div>
              <div className="ai-modal-text">{displayText(s.text)}</div>
              <div className="ai-modal-foot">
                <button className="st-auto-btn hpd-btn" onClick={() => run()} disabled={s.loading}>{s.loading ? "分析中… 约 20–40s" : "↻ 实时分析"}</button>
              </div>
            </div>
          </div>
        )}

        {s.loading && <div className="ai-empty">分析中… 约 20–40s</div>}
        {s.err && <div className="ai-err">⚠ {s.err}</div>}
      </div>
    </div>
  );
}
