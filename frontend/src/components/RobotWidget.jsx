import { useEffect, useState } from "react";

const API = import.meta.env.VITE_API_BASE ?? "";
// drop a mascot image at frontend/public/robot.png (透明背景 PNG 最佳) → auto-used;
// falls back to the inline SVG if the file is absent.
const ROBOT_IMG = (import.meta.env.BASE_URL ?? "/") + "robot.png";

// 主页悬浮 AI 助手 — 基于监控快照(keter/链上/历史时间线)回答主网状态问题
export default function RobotWidget() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [ans, setAns] = useState(null);
  const [err, setErr] = useState(null);
  const [imgOk, setImgOk] = useState(true);
  const [brief, setBrief] = useState(null);   // 每小时巡检生成的 24h 基本面播报 {text, at, verdict}

  useEffect(() => {
    let alive = true;
    const pull = () => fetch(API + "/api/ai/analyze").then((r) => r.json())
      .then((j) => { if (alive && j?.brief) setBrief({ text: j.brief, at: j.at, verdict: j.verdict }); })
      .catch(() => {});
    pull();
    const t = setInterval(pull, 5 * 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

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

  return (
    <div className="robot-widget">
      {open && (
        <div className="robot-pop">
          <div className="robot-pop-head">
            <span>🤖 BSC 主网助手</span>
            <button className="robot-close" onClick={() => setOpen(false)}>×</button>
          </div>
          {brief ? (
            <div className={`robot-brief ${brief.verdict === "alert" ? "rb-alert" : brief.verdict === "warn" ? "rb-warn" : ""}`}>
              <span className="rb-head">24h 基本面{brief.at ? ` · ${new Date(brief.at).getHours()}:${String(new Date(brief.at).getMinutes()).padStart(2, "0")} 自动巡检` : ""}</span>
              <span className="rb-text">{brief.text}</span>
            </div>
          ) : (
            <div className="robot-greet">24h 基本面播报生成中(每小时自动巡检)…也可以直接提问。</div>
          )}
          <div className="robot-greet">
            继续提问:我了解主网的监控信息和链上状态（keter 指标 · 流量 / reorg 历史 · MEV 格局 · TxPool）。
          </div>
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

      <span className="robot-name">CLICK ME</span>
      {!open && <span className="robot-tip">我是 LEO · 点我看 24h 基本面 / 提问</span>}

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
