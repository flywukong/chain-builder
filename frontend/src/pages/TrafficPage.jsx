import { useEffect, useRef, useState } from "react";
import GasPanel from "../components/GasPanel.jsx";
import TxpoolPanel from "../components/TxpoolPanel.jsx";

const API = import.meta.env.VITE_API_BASE ?? "";
const fmtT = (t) => { const d = new Date(t); return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:00`; };
const fmtDay = (t) => { const d = new Date(t); return `${d.getMonth()+1}/${d.getDate()}`; };

// ── 通用小时级面积图:渐变填充 + 网格 + Y刻度 + 阈值线 + 超阈高亮 + hover 十字 ──
function HourlyChart({ times, values, threshold, color, hotColor = "#ef6a3a", unit = "", label, fmtV = (v) => v?.toLocaleString?.() ?? v }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);   // {i, x}

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
      const n = times?.length ?? 0;
      if (!n) { ctx.fillStyle = "#4a463c"; ctx.font = "10px monospace"; ctx.textAlign = "center"; ctx.fillText("加载中…", W/2, H/2); return; }

      const padL = 44, padR = 10, padT = 8, padB = 18;
      const iw = W - padL - padR, ih = H - padT - padB;
      const vs = values.filter((v) => typeof v === "number");
      const maxV = Math.max(threshold * 1.15, ...vs) * 1.05;
      const X = (i) => padL + (i / Math.max(n - 1, 1)) * iw;
      const Y = (v) => padT + ih - (v / maxV) * ih;

      // grid + y labels (4 档)
      ctx.font = "8.5px monospace"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      for (let k = 0; k <= 4; k++) {
        const v = (maxV / 4) * k, y = Y(v);
        ctx.strokeStyle = "#191712"; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillStyle = "#5d594e"; ctx.fillText(fmtV(Math.round(v)), padL - 6, y);
      }
      // x labels(按天,自适应密度)
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      let lastDay = "";
      const stepDays = n > 24 * 12 ? 5 : n > 24 * 6 ? 2 : 1;
      let dayIdx = 0;
      times.forEach((t, i) => {
        const dk = fmtDay(t);
        if (dk !== lastDay) {
          lastDay = dk; dayIdx++;
          if (dayIdx % stepDays === 0) {
            ctx.strokeStyle = "#15130e"; ctx.beginPath(); ctx.moveTo(X(i), padT); ctx.lineTo(X(i), padT + ih); ctx.stroke();
            ctx.fillStyle = "#5d594e"; ctx.fillText(dk, X(i), H - padB + 6);
          }
        }
      });

      // 超阈值区段:红色渐变背景
      for (let i = 0; i < n; i++) {
        const v = values[i];
        if (typeof v === "number" && v > threshold) {
          const x0 = i > 0 ? (X(i - 1) + X(i)) / 2 : X(i);
          const x1 = i < n - 1 ? (X(i) + X(i + 1)) / 2 : X(i);
          const g = ctx.createLinearGradient(0, padT, 0, padT + ih);
          g.addColorStop(0, "rgba(239,106,58,.22)"); g.addColorStop(1, "rgba(239,106,58,.03)");
          ctx.fillStyle = g; ctx.fillRect(x0, padT, Math.max(x1 - x0, 2), ih);
        }
      }

      // 面积渐变 + 主线(超阈值段变红)
      const area = ctx.createLinearGradient(0, padT, 0, padT + ih);
      area.addColorStop(0, color + "3a"); area.addColorStop(1, color + "05");
      ctx.beginPath();
      values.forEach((v, i) => { const y = Y(typeof v === "number" ? v : 0); i === 0 ? ctx.moveTo(X(i), y) : ctx.lineTo(X(i), y); });
      ctx.lineTo(X(n - 1), padT + ih); ctx.lineTo(X(0), padT + ih); ctx.closePath();
      ctx.fillStyle = area; ctx.fill();

      ctx.lineWidth = 1.7; ctx.lineJoin = "round";
      for (let i = 1; i < n; i++) {
        const v0 = values[i - 1], v1 = values[i];
        if (typeof v0 !== "number" || typeof v1 !== "number") continue;
        const hot = v0 > threshold || v1 > threshold;
        ctx.strokeStyle = hot ? hotColor : color;
        if (hot) { ctx.shadowColor = hotColor; ctx.shadowBlur = 6; }
        ctx.beginPath(); ctx.moveTo(X(i - 1), Y(v0)); ctx.lineTo(X(i), Y(v1)); ctx.stroke();
        ctx.shadowBlur = 0;
      }

      // 阈值线
      ctx.setLineDash([5, 4]); ctx.strokeStyle = "#ef4444aa"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, Y(threshold)); ctx.lineTo(W - padR, Y(threshold)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "#ef8f8f"; ctx.font = "8.5px monospace"; ctx.textAlign = "left";
      ctx.fillText(`阈值 ${fmtV(threshold)}`, padL + 4, Y(threshold) - 6);

      // hover 十字 + 读数
      if (hover != null && hover.i >= 0 && hover.i < n) {
        const i = hover.i, v = values[i];
        ctx.strokeStyle = "#F0B90B66"; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(X(i), padT); ctx.lineTo(X(i), padT + ih); ctx.stroke(); ctx.setLineDash([]);
        if (typeof v === "number") {
          ctx.beginPath(); ctx.arc(X(i), Y(v), 3.2, 0, 7); ctx.fillStyle = "#FFF6D8"; ctx.fill();
          const txt = `${fmtT(times[i])} · ${fmtV(v)}${unit}`;
          ctx.font = "700 9.5px monospace";
          const tw = ctx.measureText(txt).width + 14;
          let bx = X(i) + 8; if (bx + tw > W - 4) bx = X(i) - tw - 8;
          ctx.fillStyle = "rgba(12,11,8,.94)"; ctx.strokeStyle = "#3a2d00";
          ctx.beginPath(); ctx.roundRect(bx, padT + 2, tw, 18, 5); ctx.fill(); ctx.stroke();
          ctx.fillStyle = v > threshold ? "#ffb08a" : "#e8dcb8"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
          ctx.fillText(txt, bx + 7, padT + 11);
        }
      }
    }
    draw();
    const ro = new ResizeObserver(draw); ro.observe(canvas);
    return () => ro.disconnect();
  }, [times, values, threshold, color, hover]);

  const onMove = (e) => {
    const canvas = ref.current;
    if (!canvas || !times?.length) return;
    const rect = canvas.getBoundingClientRect();
    const padL = 44, padR = 10;
    const iw = rect.width - padL - padR;
    const i = Math.round(((e.clientX - rect.left - padL) / Math.max(iw, 1)) * (times.length - 1));
    setHover({ i: Math.min(Math.max(i, 0), times.length - 1) });
  };

  return (
    <div className="hc-wrap">
      <div className="hc-label">{label}</div>
      <canvas ref={ref} className="hc-canvas" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
    </div>
  );
}

// ── 流量历史面板:范围切换 + pending/gas 双图 + 事件列表 ──
const RANGES = [5, 7, 10, 30];

function TrafficHistoryPanel({ tl, onAnalyzeEpisode, aiLoading, aiEpLabel }) {
  const [rangeDays, setRangeDays] = useState(7);
  const sum = tl?.summary;
  const thr = tl?.threshold ?? 4000;
  const hotPct = tl?.hotPct ?? 90;

  // 从 30d hourly 序列切出所选范围
  const h = tl?.hourly ?? { times: [], pending: [], gasPct: [] };
  const cut = Math.max(h.times.length - rangeDays * 24, 0);
  const times = h.times.slice(cut), pending = h.pending.slice(cut), gasPct = h.gasPct.slice(cut);
  const now = Date.now();
  const epsInRange = (tl?.episodes ?? []).filter((e) => now - e.start <= rangeDays * 86400000);
  const last = tl?.lastEpisode;

  return (
    <div className="panel tf-panel">
      <div className="panel-header">
        <span>流量历史</span>
        <span className="tf-ranges">
          {RANGES.map((d) => (
            <button key={d} className={`tf-range ${rangeDays === d ? "on" : ""}`} onClick={() => setRangeDays(d)}>{d}天</button>
          ))}
        </span>
      </div>
      <div className="panel-body tf-body">
        <div className="reorg-chips tf-chips">
          <div className="reorg-chip tone-ok"><span className="rc-v">{sum?.baseline?.toLocaleString() ?? "--"}</span><span className="rc-l">pending 30d 基线</span></div>
          <div className={`reorg-chip ${(sum?.maxGasPct ?? 0) >= hotPct ? "tone-warn" : "tone-ok"}`}><span className="rc-v">{sum?.maxGasPct ?? "--"}%</span><span className="rc-l">30d gas 峰值利用率</span></div>
          <div className={`reorg-chip ${epsInRange.length ? "tone-warn" : "tone-ok"}`}><span className="rc-v">{epsInRange.length} 次</span><span className="rc-l">{rangeDays} 天内大流量</span></div>
          <div className={`reorg-chip ${last ? "tone-warn" : "tone-ok"}`}>
            <span className="rc-v">{last ? last.peakPending.toLocaleString() : "无"}</span>
            <span className="rc-l">{last ? `最近一次 ${fmtT(last.peakT)} · ${last.trigger}` : "30d 内无大流量"}</span>
          </div>
        </div>

        <div className="tf-main">
          <div className="tf-charts">
            <HourlyChart times={times} values={pending} threshold={thr} color="#F0B90B"
              label={`TxPool pending(dataseed 小时均值 · 阈值 ${thr.toLocaleString()})`} />
            <HourlyChart times={times} values={gasPct} threshold={hotPct} color="#3FB8A0" unit="%"
              label={`Gas 利用率(小时均值 · 阈值 ${hotPct}% · 上限 140M)`} fmtV={(v) => `${v}`} />
          </div>
          <div className="reorg-events tf-events">
            <div className="re-title">大流量事件(pending&gt;{(thr/1000)}k 或 gas≥{hotPct}%)</div>
            {(tl?.episodes ?? []).length === 0
              ? <div className="re-empty">✓ 30d 内无大流量</div>
              : [...tl.episodes].reverse().map((e) => {
                  const busy = aiLoading && aiEpLabel === fmtT(e.start);
                  return (
                    <div key={e.start} className="re-row">
                      <span className="re-time">{fmtT(e.start)}</span>
                      <span className="re-cnt">{e.trigger?.includes("pending") ? e.peakPending.toLocaleString() : `${e.peakGasPct}%`}</span>
                      <span className="re-orph">{e.peakGasM}M</span>
                      <span className="re-nodes">{e.trigger}</span>
                      <button className={`tf-ep-btn ${busy ? "busy" : ""}`} disabled={aiLoading} onClick={() => onAnalyzeEpisode?.(e)}>
                        {busy ? "分析中…↓" : "⚡ 分析"}
                      </button>
                    </div>
                  );
                })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── AI 分析(两个按钮 + 事件行「分析」共用一个结果区)──
function useTrafficAi() {
  const [s, setS] = useState({ key: null, loading: false, text: null, at: null, err: null, epLabel: null });

  useEffect(() => {
    Promise.all([
      fetch(API + "/api/ai/traffic").then(r => r.json()).catch(() => null),
      fetch(API + "/api/ai/txpool").then(r => r.json()).catch(() => null),
    ]).then(([a, b]) => {
      const best = [ {k:"traffic",d:a}, {k:"txpool",d:b} ].filter(x => x.d?.text).sort((x,y) => (y.d.at??0)-(x.d.at??0))[0];
      if (best) setS({ key: best.k, loading: false, text: best.d.text, at: best.d.at, err: null, epLabel: null });
    });
  }, []);

  const run = async (key, path, body = null, epLabel = null) => {
    setS({ key, loading: true, text: null, at: null, err: null, epLabel });
    try {
      const r = await fetch(API + path, {
        method: "POST",
        ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      const d = await r.json();
      if (d.error) setS({ key, loading: false, text: null, at: null, err: d.error, epLabel });
      else if (d.running) setS((x) => ({ ...x, loading: false, err: "已有分析进行中，请稍候" }));
      else setS({ key, loading: false, text: d.text, at: d.at, err: null, epLabel });
    } catch (e) { setS({ key, loading: false, text: null, at: null, err: String(e), epLabel }); }
  };

  const runEpisode = (e) => run("traffic", "/api/ai/traffic", { episodeStart: e.start }, fmtT(e.start));
  return { s, run, runEpisode };
}

function AiBox({ ai }) {
  const { s, run } = ai;
  const TITLES = { traffic: "大流量分析", txpool: "TxPool 拥堵诊断" };
  return (
    <div className="panel tf-ai" id="tf-ai-box">
      <div className="panel-header">
        <span>🤖 AI 流量分析</span>
        <span className="sub">claude code · 事件归因到合约</span>
      </div>
      <div className="panel-body tf-ai-body">
        <div className="tf-ai-btns">
          <button className="st-auto-btn" disabled={s.loading} onClick={() => run("traffic", "/api/ai/traffic")}>
            {s.loading && s.key === "traffic" ? "分析中…约 40s" : "⚡ 大流量分析"}
          </button>
          <button className="st-auto-btn" disabled={s.loading} onClick={() => run("txpool", "/api/ai/txpool")}>
            {s.loading && s.key === "txpool" ? "分析中…约 30s" : "🚦 TxPool 拥堵诊断"}
          </button>
          {s.at && <span className="ai-at">{TITLES[s.key]}{s.epLabel ? ` · 事件 ${s.epLabel}` : ""} · {new Date(s.at).toLocaleTimeString()}</span>}
        </div>
        {s.err && <div className="ai-err">⚠ {s.err}</div>}
        {s.text
          ? <div className="ai-result tf-ai-result">{s.text}</div>
          : !s.loading && <div className="ai-empty">「大流量分析」定位最近一次大流量事件;事件列表每行「⚡分析」针对该次事件的高度区间采样归因;「拥堵诊断」判断当前 TxPool 形态</div>}
        {s.loading && (
          <div className="tf-ai-loading">
            <span className="tf-ai-spin" />
            <span>claude 分析中…{s.epLabel ? ` 目标事件 ${s.epLabel},` : ""} 链上取证采样 8 个历史区块归因合约,约 30–40s</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function TrafficPage({ state }) {
  const util = state.windowStats?.avgGasUtilPct ?? 0;
  const hotPct = state.trafficTimeline?.hotPct ?? 90;
  const tx = state.txpool;
  const high = util >= hotPct || !!tx?.anomalyNow;   // 复合口径
  const ai = useTrafficAi();

  // 点击事件行「分析」:触发后平滑滚到结果区,避免"点了没反应"的错觉
  const analyzeEpisode = (e) => {
    ai.runEpisode(e);
    setTimeout(() => document.getElementById("tf-ai-box")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };

  return (
    <div className="subpage">
      <div className="subpage-head">
        <div>
          <h1>🌊 流量分析</h1>
          <p>大流量 = pending&gt;4000 或 gas≥{hotPct}% · 30d 小时级历史 · AI 归因</p>
        </div>
      </div>

      <div className="subpage-body">
        {high ? (
          <div className="traffic-alert">
            ⚠ 检测到大流量
            {tx?.anomalyNow && ` —— pending ${tx.current?.toLocaleString()} > ${tx.threshold?.toLocaleString()}`}
            {util >= hotPct && ` —— Gas 利用率 ${util}% ≥ ${hotPct}%`}
            ，可点击「大流量分析」归因
          </div>
        ) : (
          <div className="traffic-ok">✓ 当前无大流量（pending {tx?.current?.toLocaleString() ?? "--"} · Gas {util}%）</div>
        )}

        <TrafficHistoryPanel tl={state.trafficTimeline} onAnalyzeEpisode={analyzeEpisode} aiLoading={ai.s.loading} aiEpLabel={ai.s.epLabel} />

        <div className="tf-row2">
          <AiBox ai={ai} />
          <div className="traffic-cell"><GasPanel gasUsed={state.gasUsed} windowStats={state.windowStats} /></div>
          <div className="traffic-cell"><TxpoolPanel txpool={tx} /></div>
        </div>
      </div>
    </div>
  );
}