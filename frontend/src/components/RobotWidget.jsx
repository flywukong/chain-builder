import { useEffect, useState } from "react";
import { aiRequest } from "../lib/ai.js";
import { AiText } from "./PanelAi.jsx";

const API = import.meta.env.VITE_API_BASE ?? "";
// drop a mascot image at frontend/public/robot.png (透明背景 PNG 最佳) → auto-used;
// falls back to the inline SVG if the file is absent.
const ROBOT_IMG = (import.meta.env.BASE_URL ?? "/") + "robot.png";

const DAY_OPTIONS = [1, 3, 7, 14, 30];
const dayLabel = (d) => (d === 1 ? "24h" : `${d}天`);

// 主页悬浮 AI 助手 = 巡检总结(常驻气泡,绿/黄/红)+ 时间窗选择 + 问答
// 每小时自动巡检的结论直接由 LEO 呈现;原独立「AI 分析」面板已并入此处
// variant="mev"/"reorg":纯问答形态(无巡检/天数),文案按场景定制
const QA_PRESET = {
  mev: {
    title: "🤖 LEO · MEV 问答",
    greet: "MEV 相关的都可以问我:builder 格局与集中度、份额突变原因、v1/v2 (BEP-675) 进展、某 validator 依赖哪家 builder、instance 层的地区分布…",
    placeholder: "例:48club 份额为什么在涨?v2 什么时候起量?",
    bubbleHead: "LEO · MEV 问答",
    bubbleLine: "任何 MEV 相关问题都可以问:格局 / 份额突变 / v2 进展…",
  },
  monitor: {
    title: "🤖 LEO · 监控问答",
    greet: "监控页相关的都可以问:reorg 事件与影响面、空块与出块质量、导入时延、节点同步、某个块是谁出的、某段区块的出块间隔有没有异常…",
    placeholder: "例:块 109,000,000 是谁出的?今天空块多吗?",
    bubbleHead: "LEO · 监控问答",
    bubbleLine: "reorg / 空块 / 出块人 / 时延…监控相关都可以问",
  },
  txn: {
    title: "🤖 LEO · 交易问答",
    greet: "链上交易相关的都可以问:各类交易占比与趋势、meme/DeFi/bot 热度、某个热门合约是什么(我可以链上查它的 name/symbol)、某地址是合约还是钱包…",
    placeholder: "例:今天 meme 占比多少?0x278d85… 是什么合约?",
    bubbleHead: "LEO · 交易问答",
    bubbleLine: "交易结构 / 热门合约身份 / 分类趋势…都可以问",
  },
};

export default function RobotWidget({ variant = "home" }) {
  const preset = QA_PRESET[variant];
  const isMev = !!preset;   // 纯问答形态(mev/reorg)
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

  // 选择时间窗 → 按新窗口重新分析(异步任务 + 轮询,MCP 取证可达 1-2min)
  const runDays = async (d) => {
    setDays(d); setMenuOpen(false);
    setPa((x) => ({ ...x, loading: true }));
    try {
      const j = await aiRequest("/api/ai/analyze", { days: d });
      if (j.error || !j.text) setPa((x) => ({ ...x, loading: false }));
      else setPa({ text: j.text, brief: j.brief ?? null, verdict: j.verdict ?? "ok", at: j.at, windowDays: j.windowDays, loading: false });
    } catch { setPa((x) => ({ ...x, loading: false })); }
  };

  const ask = async () => {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(true); setErr(null); setAns(null);
    try {
      const d = await aiRequest("/api/ai/ask", { question });
      if (d.error) setErr(d.error);
      else setAns(d.text);
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const verdict = pa.verdict;
  const ok = verdict === "ok";
  // 巡检新鲜度:后端每小时自动跑;超 75 分钟未更新 = 自动巡检可能中断
  const ageMin = pa.at ? Math.round((Date.now() - pa.at) / 60000) : null;
  const staleAuto = ageMin != null && ageMin > 75;
  const hm = (t) => new Date(t).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
  const md = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };

  // 结构化指标快照(安全性/出块/负载/事件由前端直渲染,AI 只负责结论与评述)
  const [snap, setSnap] = useState(null);
  useEffect(() => {
    if (isMev || !open) return;
    fetch(API + `/api/ai/data?days=${pa.windowDays ?? days}`)
      .then((r) => r.json()).then(setSnap).catch(() => {});
  }, [open, pa.at, pa.windowDays]);   // eslint-disable-line react-hooks/exhaustive-deps

  const KV = ({ k, v, tone }) => (
    <div className="rp-kv"><span>{k}</span><b className={tone ?? ""}>{v}</b></div>
  );
  // 时延基线对比:附具体比较值,而非空泛的「优于基线」
  const latCmp = (() => {
    const l = snap?.latency24h;
    if (!l?.p50 || !l?.baseline24h?.p50) return "";
    const d = ((l.p50 - l.baseline24h.p50) / l.baseline24h.p50) * 100;
    return Math.abs(d) < 1 ? " · 与基线持平" : ` · 较基线${d > 0 ? "慢" : "快"} ${Math.abs(d).toFixed(0)}%`;
  })();
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
            <span>{isMev ? preset.title : "🤖 LEO · 主网巡检 + 问答"}</span>
            <button className="robot-close" onClick={() => setOpen(false)}>×</button>
          </div>

          {/* 巡检摘要体:结论 → 指标分区(快照直渲染)→ 近期事件 → AI 评述;输入固定底部 */}
          {isMev ? (
            <div className="robot-greet">{preset.greet}</div>
          ) : pa.text ? (
            <div className="robot-pop-body">
              <div className={`rp-status ${verdict === "alert" ? "bad" : verdict === "warn" ? "warn" : "ok"}`}>
                <i className="rp-dot" />{ok ? "运行正常" : verdict === "alert" ? "告警" : "需关注"}
                <span className="rp-win">· 最近 {pa.windowDays ?? days} 天{pa.loading ? " · 分析中…" : ""}</span>
              </div>
              <div className="rp-when">
                最近巡检 {pa.at ? hm(pa.at) : "--"} · 每小时更新{pa.at ? ` · 下次约 ${hm(pa.at + 3600e3)}` : ""}
                {staleAuto && <em className="rp-stale"> · ⚠ 超 1 小时未更新,自动巡检可能中断</em>}
              </div>
              {pa.brief && <div className="rp-brief"><AiText text={pa.brief} /></div>}

              {snap && (
                <>
                  <div className="rp-sec">
                    <div className="rp-sec-t">安全性</div>
                    <KV k="Slash" v={snap.slashEvents24h?.count ?? "--"} tone={(snap.slashEvents24h?.count ?? 0) > 0 ? "warn" : ""} />
                    <KV k="Reorg" v={snap.reorgWindow?.count ?? "--"} tone={(snap.reorgWindow?.count ?? 0) > 3 ? "warn" : ""} />
                    <KV k="空块" v={`${snap.emptyBlocks24h ?? "--"} 个块 · 24h`} />
                  </div>
                  <div className="rp-sec">
                    <div className="rp-sec-t">出块结构 · 24h</div>
                    <KV k="MEV 占比" v={`${snap.mev24h?.mevPct ?? snap.mevPct ?? "--"}%`} />
                    <KV k="v1 / v2 Builder" v={`${(100 - (snap.mev24h?.v2Pct ?? 0)).toFixed(0)}% / ${snap.mev24h?.v2Pct ?? 0}%`} />
                    <KV k="本地出块" v={`${snap.mev24h?.localCount?.toLocaleString() ?? "--"} 个块`} />
                  </div>
                  <div className="rp-sec">
                    <div className="rp-sec-t">当前负载</div>
                    <KV k="Gas 利用率" v={`${snap.gasUtilPct ?? "--"}%`} tone={(snap.gasUtilPct ?? 0) >= 90 ? "warn" : ""} />
                    <KV k="Pending" v={`${snap.txpool24h?.current?.toLocaleString() ?? "--"} · 24h 峰值 ${snap.txpool24h?.max24h?.toLocaleString() ?? "--"}`} />
                    <KV k="导入时延" v={`p50 ${Math.round(snap.latency24h?.p50 ?? 0)}ms · p95 ${Math.round(snap.latency24h?.p95 ?? 0)}ms${latCmp}`} />
                  </div>
                  <div className="rp-sec">
                    <div className="rp-sec-t">近期事件</div>
                    {(snap.trafficEpisodesWindow ?? []).length === 0 && (snap.reorgWindow?.events ?? []).length === 0
                      ? <div className="rp-none">✓ 窗口内无异常事件</div>
                      : <>
                          {(snap.trafficEpisodesWindow ?? []).map((e) => (
                            <div key={e.start} className="rp-event">
                              <span>{md(e.start)} 流量峰值 · {e.trigger?.includes("gas") ? `Gas ${e.peakGasPct}%` : `Pending ${e.peakPending?.toLocaleString()}`}</span>
                              <em className="ok">已恢复</em>
                            </div>
                          ))}
                          {(snap.reorgWindow?.events ?? []).slice(0, 4).map((e) => (
                            <div key={e.t} className="rp-event">
                              <span>{md(e.t)} Reorg · {e.orphans ?? "?"} 孤块</span>
                              <em>{(e.orphans ?? 0) >= 8 ? "需关注" : "常规"}</em>
                            </div>
                          ))}
                        </>}
                  </div>
                </>
              )}

              {displayText(pa.text) && (
                <div className="rp-ai"><AiText text={displayText(pa.text)} /></div>
              )}
              {busy && <div className="robot-busy">正在汇总监控快照并分析（约 20–40s）…</div>}
              {err && <div className="ai-err">⚠ {err}</div>}
              {ans && <div className="robot-ans"><AiText text={ans} /></div>}
            </div>
          ) : (
            <div className="robot-greet">{pa.loading ? "分析中… 约 20–40s" : "巡检生成中(每小时自动)…也可直接提问。"}</div>
          )}
          {(isMev || !pa.text) && (
            <>
              {busy && <div className="robot-busy">正在汇总监控快照并分析（约 20–40s）…</div>}
              {err && <div className="ai-err">⚠ {err}</div>}
              {ans && <div className="robot-ans"><AiText text={ans} /></div>}
            </>
          )}

          <div className="robot-input-row">
            <input
              className="robot-input"
              placeholder={isMev ? preset.placeholder : "例:当前网络运行状态如何?"}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && ask()}
              disabled={busy}
            />
            <button className="robot-send" onClick={ask} disabled={busy || !q.trim()}>
              {busy ? "…" : "问"}
            </button>
          </div>
        </div>
      )}

      {/* 头顶:CLICK ME + 时间窗选择(默认 24h);MEV 形态只留 CLICK ME */}
      {!open && (
        <span className="robot-head-row">
          <span className="robot-name">CLICK ME</span>
          {!isMev && <span className="robot-days">
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
          </span>}
        </span>
      )}

      {/* 常驻气泡:home=巡检结论(绿/黄/红);mev=问答提示(金) */}
      {!open && (isMev ? (
        <button className="robot-brief robot-brief-float rb-gold" onClick={() => setOpen(true)}>
          <span className="rb-head">
            {preset.bubbleHead}
            <em className="rb-more">点我提问</em>
          </span>
          <span className="rb-text rb-oneline">{preset.bubbleLine}</span>
        </button>
      ) : (
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
      ))}

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
