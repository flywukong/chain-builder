import { useEffect, useState } from "react";

const API = import.meta.env.VITE_API_BASE ?? "";
// drop a mascot image at frontend/public/robot.png (透明背景 PNG 最佳) → auto-used;
// falls back to the inline SVG if the file is absent.
const ROBOT_IMG = (import.meta.env.BASE_URL ?? "/") + "robot.png";

const DAY_OPTIONS = [1, 3, 7, 14, 30];
const dayLabel = (d) => (d === 1 ? "24h" : `${d}天`);

// 主页悬浮 AI 助手 = 巡检总结(常驻气泡,绿/黄/红)+ 时间窗选择 + 问答
// 每小时自动巡检的结论直接由 LEO 呈现;原独立「AI 分析」面板已并入此处
export default function RobotWidget() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [ans, setAns] = useState(null);
  const [err, setErr] = useState(null);
  const [imgOk, setImgOk] = useState(true);
  const [days, setDays] = useState(1);          // 时间窗,默认 24h
  const [menuOpen, setMenuOpen] = useState(false);
  // 巡检结果 {text, brief, verdict, at, windowDays, loading}
  const [pa, setPa] = useState({ text: null, brief: null, verdict: null, at: null, windowDays: null, loading: false });

  // 加载缓存巡检 + 轮询(每小时自动巡检的结果自动出现)
  useEffect(() => {
    let alive = true;
    const pull = () => fetch(API + "/api/ai/analyze").then((r) => r.json())
      .then((d) => {
        if (!alive || !d?.text) return;
        setPa((x) => (x.loading || (x.at && d.at && d.at <= x.at) ? x
          : { text: d.text, brief: d.brief ?? null, verdict: d.verdict ?? "ok", at: d.at, windowDays: d.windowDays ?? null, loading: false }));
      })
      .catch(() => {});
    pull();
    const t = setInterval(pull, 90_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // 选择时间窗 → 按新窗口重新分析
  const runDays = async (d) => {
    setDays(d); setMenuOpen(false);
    setPa((x) => ({ ...x, loading: true }));
    try {
      const r = await fetch(API + "/api/ai/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ days: d }),
      });
      const j = await r.json();
      if (j.error) setPa((x) => ({ ...x, loading: false }));
      else if (!j.running) setPa({ text: j.text, brief: j.brief ?? null, verdict: j.verdict ?? "ok", at: j.at, windowDays: j.windowDays, loading: false });
      else setPa((x) => ({ ...x, loading: false }));
    } catch { setPa((x) => ({ ...x, loading: false })); }
  };

  const ask = async () => {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(true); setErr(null); setAns(null);
    try {
      const r = await fetch(API + "/api/ai/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const d = await r.json();
      if (d.error) setErr(d.error);
      else setAns(d.text);
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const verdict = pa.verdict;
  const ok = verdict === "ok";
  // 正文首行的「正常/需关注/告警」与徽条重复,展示时剥掉
  const displayText = (t) => {
    if (!t) return t;
    const lines = t.split("\n");
    const head = (lines[0] || "").replace(/[*#\s：:]/g, "");
    if (/^(总体结论)?(正常|需关注|告警)/.test(head)) return lines.slice(1).join("\n").trim();
    return t;
  };

  return (
    <div className="robot-widget">
      {open && (
        <div className="robot-pop">
          <div className="robot-pop-head">
            <span>🤖 LEO · 主网巡检 + 问答</span>
            <button className="robot-close" onClick={() => setOpen(false)}>×</button>
          </div>

          {/* 巡检详情(与气泡同源,完整正文) */}
          {pa.text ? (
            <div className={`robot-brief ${verdict === "alert" ? "rb-alert" : verdict === "warn" ? "rb-warn" : ""}`}>
              <span className="rb-head">
                {ok ? "✓ 正常" : verdict === "alert" ? "⛔ 告警" : "⚠ 需关注"} · 最近 {pa.windowDays ?? days} 天
                {pa.at ? ` · ${new Date(pa.at).toLocaleTimeString()}` : ""}{pa.loading ? " · 分析中…" : ""}
              </span>
              {pa.brief && <span className="rb-text rb-brief-line">{pa.brief}</span>}
              <span className="rb-text rb-scroll">{displayText(pa.text)}</span>
            </div>
          ) : (
            <div className="robot-greet">{pa.loading ? "分析中… 约 20–40s" : "巡检生成中(每小时自动)…也可直接提问。"}</div>
          )}

          <div className="robot-input-row">
            <input
              className="robot-input"
              placeholder="例：当前网络运行状态如何？"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && ask()}
              disabled={busy}
            />
            <button className="robot-send" onClick={ask} disabled={busy || !q.trim()}>
              {busy ? "…" : "问"}
            </button>
          </div>
          {busy && <div className="robot-busy">正在汇总监控快照并分析（约 20–40s）…</div>}
          {err && <div className="ai-err">⚠ {err}</div>}
          {ans && <div className="robot-ans">{ans}</div>}
        </div>
      )}

      {/* 头顶:CLICK ME + 时间窗选择(默认 24h) */}
      {!open && (
        <span className="robot-head-row">
          <span className="robot-name">CLICK ME</span>
          <span className="robot-days">
            <button className="tf-range on" onClick={(e) => { e.stopPropagation(); setMenuOpen((x) => !x); }}>
              {dayLabel(days)} ▾
            </button>
            {menuOpen && (
              <span className="robot-days-menu">
                {DAY_OPTIONS.map((d) => (
                  <button key={d} className={`tf-range ${d === days ? "on" : ""}`} onClick={() => runDays(d)}>{dayLabel(d)}</button>
                ))}
              </span>
            )}
          </span>
        </span>
      )}

      {/* 常驻巡检结论气泡(精简):一行结论 + 一行摘要 + 详情按钮;绿/黄/红 */}
      {!open && (
        <button className={`robot-brief robot-brief-float ${!pa.text ? "" : verdict === "alert" ? "rb-alert" : verdict === "warn" ? "rb-warn" : "rb-ok"}`}
                onClick={() => setOpen(true)}>
          {pa.text ? (
            <span className="rb-head">
              {ok ? "✓ 正常" : verdict === "alert" ? "⛔ 告警" : "⚠ 需关注"} · 24小时巡检{pa.loading ? " · 分析中…" : ""}
              <em className="rb-more">点击看详情</em>
            </span>
          ) : (
            <span className="rb-text rb-oneline">{pa.loading ? "LEO 分析中… 约 20–40s" : "我是 LEO · 点我看巡检 / 提问"}</span>
          )}
        </button>
      )}

      <button className={`robot-btn ${open ? "robot-btn-open" : ""} ${imgOk ? "has-img" : ""}`} onClick={() => setOpen((x) => !x)}>
        {imgOk ? (
          <img className="robot-img" src={ROBOT_IMG} alt="AI 助手" draggable="false" onError={() => setImgOk(false)} />
        ) : (
        <svg viewBox="0 0 64 64" width="50" height="50" fill="none">
          {/* antenna */}
          <line x1="32" y1="10" x2="32" y2="5.5" stroke="#2b3550" strokeWidth="2.6" strokeLinecap="round" />
          <circle cx="32" cy="4.4" r="3" fill="#4da3ff" style={{ filter: "drop-shadow(0 0 3px #4da3ff)" }} />
          {/* ear pods */}
          <rect x="7.5" y="17" width="7" height="13" rx="3.5" fill="#e9edf5" />
          <circle cx="11" cy="23.5" r="2" fill="#4da3ff" opacity=".85" />
          <rect x="49.5" y="17" width="7" height="13" rx="3.5" fill="#e9edf5" />
          <circle cx="53" cy="23.5" r="2" fill="#4da3ff" opacity=".85" />
          {/* head */}
          <rect x="12" y="9" width="40" height="29" rx="14.5" fill="#f5f7fb" />
          <rect x="12" y="9" width="40" height="29" rx="14.5" stroke="#c9d2e2" strokeWidth="1" />
          {/* visor */}
          <rect x="17.5" y="14" width="29" height="19" rx="9" fill="#1b2437" />
          {/* glowing eyes */}
          <rect className="robot-eye" x="24" y="18.5" width="5" height="8.5" rx="2.5" fill="#5fd4ff" style={{ filter: "drop-shadow(0 0 2.5px #5fd4ff)" }} />
          <rect className="robot-eye" x="35" y="18.5" width="5" height="8.5" rx="2.5" fill="#5fd4ff" style={{ filter: "drop-shadow(0 0 2.5px #5fd4ff)" }} />
          {/* smile */}
          <path d="M28.5 29.5c1.8 1.7 5.2 1.7 7 0" stroke="#5fd4ff" strokeWidth="1.9" strokeLinecap="round" />
          {/* neck */}
          <rect x="27" y="37" width="10" height="5" rx="2.5" fill="#2b3550" />
          {/* torso */}
          <rect x="17" y="40.5" width="30" height="17" rx="8.5" fill="#f5f7fb" stroke="#c9d2e2" strokeWidth="1" />
          {/* waving arm (pivots at right shoulder) */}
          <g className="robot-arm">
            <rect x="44.6" y="33" width="5.8" height="14" rx="2.9" fill="#f5f7fb" stroke="#c9d2e2" strokeWidth="1" />
            <circle cx="47.5" cy="31.2" r="3.1" fill="#f5f7fb" stroke="#c9d2e2" strokeWidth="1" />
          </g>
          {/* chest badge: gold BNB mark */}
          <circle cx="32" cy="49" r="6.2" fill="#1a1608" stroke="#F0B90B" strokeWidth="1.2" style={{ filter: "drop-shadow(0 0 3px rgba(240,185,11,.7))" }} />
          <g fill="#F0B90B" transform="translate(32 49) scale(.16) translate(-16 -16)">
            <path d="M12.116 14.404L16 10.52l3.886 3.886 2.26-2.26L16 6l-6.144 6.144 2.26 2.26z" />
            <path d="M6 16l2.26-2.26L10.52 16l-2.26 2.26L6 16z" />
            <path d="M16 13.706L18.294 16 16 18.294 13.706 16 16 13.706z" />
            <path d="M21.48 16l2.26-2.26L26 16l-2.26 2.26L21.48 16z" />
            <path d="M12.116 17.596L16 21.48l3.886-3.886 2.26 2.26L16 26l-6.144-6.144 2.26-2.26z" />
          </g>
        </svg>
        )}
      </button>
    </div>
  );
}
