import { useEffect, useRef, useState } from "react";
import { AiText } from "./PanelAi.jsx";
import { aiRequest } from "../lib/ai.js";

const last = (s) => { const v = s?.values ?? []; for (let i = v.length - 1; i >= 0; i--) if (typeof v[i] === "number") return v[i]; return null; };
const fmtM = (v) => (v == null ? "--" : (v / 1e6).toFixed(1) + "M");
const fmtT = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

const DEFAULT_GAS_LIMIT = 55e6;   // 兜底;实际以链上 header 实时值为准
// 采样口径(与后端 GAS_SAMPLE_IPS 一致):两台典型 validator 的均值
const SAMPLE_IPS = ["10.213.32.160", "10.213.32.78"];

const METRICS = {
  gasused: { key: "gasused", label: "Gas used / 块", color: "#3FB8A0", scale: 1e6, src: (bg) => bg?.gasused },
  mgasps:  { key: "mgasps",  label: "MGas/s 执行吞吐", color: "#F0B90B", scale: 1, src: (bg) => bg?.mgasps },
};

const seriesStat = (s, scale = 1) => {
  const v = (s?.values ?? []).filter((x) => typeof x === "number");
  if (!v.length) return null;
  return {
    cur: v.at(-1) / scale,
    avg: v.reduce((a, b) => a + b, 0) / v.length / scale,
    max: Math.max(...v) / scale,
    min: Math.min(...v) / scale,
  };
};

const API = import.meta.env.VITE_API_BASE ?? "";

// Block Gas — 执行视角:紧凑 strip + 趋势图(70%)+ 摘要栏(30%)
// 窗口 30m(WS 实时)/ 6h / 24h(按需查 keter);AI 解读跟随所选窗口
export default function BlockGasPanel({ blockGas, gasLimit }) {
  const canvasRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [metric, setMetric] = useState("gasused");
  const [win, setWin] = useState(1440);
  const winLabel = win === 30 ? "30m" : `${win / 60}h`;
  const winCn = win === 30 ? "30 分钟" : win === 360 ? "6 小时" : "24 小时";
  const [fetched, setFetched] = useState(null);
  useEffect(() => {
    setFetched(null);
    let alive = true;
    // 30m 窗口曲线走 WS 实时(props),但仍拉一次拿 peaks(>45M 高峰段 + 区块区间)
    const pull = () => fetch(API + `/api/block-gas?minutes=${win}`).then((r) => r.json())
      .then((j) => { if (alive && j?.mgasps) setFetched(j); }).catch(() => {});
    pull();
    const t = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [win]);
  const bg = win === 30 ? (blockGas ?? fetched) : fetched;
  const peaks = fetched?.peaks ?? [];
  const lastPeak = peaks.at(-1);
  const peakT = (t) => new Date(t).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
  const peakBlk = (n) => (n == null ? "?" : "#" + n.toLocaleString());

  // 右区:gas 流量汇总(默认 7 天,可切 15 天;挂载/切换自动加载,1h 内的同参缓存直接用)
  const [sumDays, setSumDays] = useState(7);
  const [sum, setSum] = useState({ text: null, at: null, loading: false, err: null });
  useEffect(() => {
    let alive = true;
    (async () => {
      setSum({ text: null, at: null, loading: true, err: null });
      try {
        const bodyKey = JSON.stringify({ days: sumDays, focus: "gas" });
        const g = await fetch(API + "/api/ai/traffic").then((r) => r.json()).catch(() => null);
        if (alive && g?.text && g.bodyKey === bodyKey && g.at && Date.now() - g.at < 3600e3) {
          setSum({ text: g.text, at: g.at, loading: false, err: null }); return;
        }
        const d = await aiRequest("/api/ai/traffic", { days: sumDays, focus: "gas" });
        if (alive) setSum({ text: d.text ?? null, at: d.at ?? null, loading: false, err: d.error ?? null });
      } catch (e) { if (alive) setSum({ text: null, at: null, loading: false, err: String(e) }); }
    })();
    return () => { alive = false; };
  }, [sumDays]);   // eslint-disable-line react-hooks/exhaustive-deps
  const refreshSum = async () => {
    if (sum.loading) return;
    setSum((s) => ({ ...s, loading: true, err: null }));
    const d = await aiRequest("/api/ai/traffic", { days: sumDays, focus: "gas" }).catch((e) => ({ error: String(e) }));
    setSum({ text: d.text ?? null, at: d.at ?? null, loading: false, err: d.error ?? null });
  };

  // 右区提问(独立 jobId 通道,监控快照 + MCP 链上查证)
  const [q, setQ] = useState("");
  const [qa, setQa] = useState({ busy: false, ans: null, err: null });
  const ask = async () => {
    const question = q.trim();
    if (!question || qa.busy) return;
    setQa({ busy: true, ans: null, err: null });
    try {
      const d = await aiRequest("/api/ai/ask", { question });
      setQa({ busy: false, ans: d.text ?? null, err: d.error ?? null });
    } catch (e) { setQa({ busy: false, ans: null, err: String(e) }); }
  };

  // 上限与阈值:跟随链上实时 gasLimit;关注 = 50% 上限,高位 = 85% 上限
  const GL = gasLimit || DEFAULT_GAS_LIMIT;
  const glM = Math.round(GL / 1e6);
  const WATCH_GAS = GL * 0.5;
  const watchM = Math.round(WATCH_GAS / 1e6), highM = Math.round(GL * 0.85 / 1e6);

  const mg = last(bg?.mgasps);
  const gu = last(bg?.gasused);
  const tx = last(bg?.txsize);
  const execMs = mg && gu ? (gu / (mg * 1e6)) * 1000 : null;
  const slotPct = execMs != null ? (execMs / 450) * 100 : null;

  const m = METRICS[metric];
  const st = seriesStat(m.src(bg), m.scale === 1e6 ? 1e6 : 1);   // gasused 以 M 计
  const guStat = seriesStat(bg?.gasused, 1e6);
  // 异常点:块 gas 超关注阈值(50% 上限)的采样点数
  const hotPoints = (bg?.gasused?.values ?? []).filter((v) => typeof v === "number" && v > WATCH_GAS).length;

  // 结论:正常/偏高 + 区间 + 距上限
  const headroom = gu != null ? Math.max(0, 100 - (gu / GL) * 100) : null;
  const verdict = gu == null ? null : (gu / GL) * 100 >= 60 || hotPoints > 0 ? { t: "偏高", cls: "warn" } : { t: "正常", cls: "ok" };
  const aiFirstLine = sum.text ? sum.text.split("\n").find((l) => l.trim())?.replace(/^结论[::]\s*/, "") : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.offsetWidth, H = canvas.offsetHeight;
      if (!W || !H) return;
      canvas.width = W * dpr; canvas.height = H * dpr;
      const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const s = m.src(bg);
      if (!s?.values?.length) {
        ctx.fillStyle = "#4a463c"; ctx.font = "10px monospace"; ctx.textAlign = "center";
        ctx.fillText(`加载 keter ${winLabel} 数据…`, W / 2, H / 2); return;
      }
      const padL = 50, padR = 12, padT = 10, padB = 18;
      const iw = W - padL - padR, ih = H - padT - padB;
      const n = s.values.length;
      const X = (i) => padL + (i / Math.max(n - 1, 1)) * iw;
      const vals = s.values.filter((v) => typeof v === "number");
      const maxV = Math.max(...vals, 1) * 1.12;
      const Y = (v) => padT + ih - (v / maxV) * ih;

      // 参考带(仅 gasused):关注阈值 70M 落在轴内时画黄虚线;正常区语义在摘要栏
      ctx.font = "8.5px monospace"; ctx.textBaseline = "middle"; ctx.textAlign = "right";
      for (let k = 0; k <= 4; k++) {
        const y = padT + ih - (k / 4) * ih;
        ctx.strokeStyle = "#191712"; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillStyle = "#8a857c";
        const v = (maxV / 4) * k;
        ctx.fillText(m.scale === 1e6 ? (v / 1e6).toFixed(0) + "M" : Math.round(v) + "", padL - 6, y);
      }
      if (m.key === "gasused" && WATCH_GAS <= maxV) {
        const yW = Y(WATCH_GAS);
        ctx.setLineDash([5, 4]); ctx.strokeStyle = "rgba(240,185,11,.3)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, yW); ctx.lineTo(W - padR, yW); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = "rgba(240,185,11,.5)"; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
        ctx.fillText(`关注 ${watchM}M`, padL + 4, yW - 2);
      }
      const ts = s.times ?? [];
      if (ts.length) {
        ctx.fillStyle = "#5d594e"; ctx.textAlign = "center"; ctx.textBaseline = "top";
        [[0, 0], [0.5, Math.floor(ts.length / 2)], [1, ts.length - 1]].forEach(([f, i]) =>
          ctx.fillText(fmtT(ts[i]), padL + f * iw, H - padB + 6));
      }

      // 降噪:细线 + 弱 glow + 淡填充,让波峰/阈值/异常点成为视觉主体
      const area = ctx.createLinearGradient(0, padT, 0, padT + ih);
      area.addColorStop(0, m.color + "24"); area.addColorStop(1, m.color + "03");
      ctx.beginPath();
      s.values.forEach((v, i) => { const y = Y(typeof v === "number" ? v : 0); i === 0 ? ctx.moveTo(X(i), y) : ctx.lineTo(X(i), y); });
      ctx.lineTo(X(n - 1), padT + ih); ctx.lineTo(X(0), padT + ih); ctx.closePath();
      ctx.fillStyle = area; ctx.fill();
      ctx.strokeStyle = m.color; ctx.lineWidth = 1.5; ctx.lineJoin = "round";
      ctx.shadowColor = m.color; ctx.shadowBlur = 3;
      ctx.beginPath();
      s.values.forEach((v, i) => { const y = Y(typeof v === "number" ? v : 0); i === 0 ? ctx.moveTo(X(i), y) : ctx.lineTo(X(i), y); });
      ctx.stroke(); ctx.shadowBlur = 0;

      if (hover != null && hover >= 0 && hover < n) {
        const i = hover, v = s.values[i];
        ctx.strokeStyle = m.color + "66"; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(X(i), padT); ctx.lineTo(X(i), padT + ih); ctx.stroke(); ctx.setLineDash([]);
        if (typeof v === "number") {
          ctx.beginPath(); ctx.arc(X(i), Y(v), 3, 0, 7); ctx.fillStyle = "#FFF6D8"; ctx.fill();
          const txt = `${ts[i] ? fmtT(ts[i]) : ""} · ${m.scale === 1e6 ? (v / 1e6).toFixed(1) + "M" : Math.round(v)}`;
          ctx.font = "700 9.5px monospace";
          const tw = ctx.measureText(txt).width + 14;
          let bx = X(i) + 8; if (bx + tw > W - padR) bx = X(i) - tw - 8;
          ctx.fillStyle = "rgba(12,11,8,.94)"; ctx.strokeStyle = "#3a2d00";
          ctx.beginPath(); ctx.roundRect(bx, padT + 2, tw, 18, 5); ctx.fill(); ctx.stroke();
          ctx.fillStyle = "#e8dcb8"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
          ctx.fillText(txt, bx + 7, padT + 11);
        }
      }
    }
    draw();
    const ro = new ResizeObserver(draw); ro.observe(canvas);
    return () => ro.disconnect();
  }, [bg, hover, metric, gasLimit, win]);

  const onMove = (e) => {
    const canvas = canvasRef.current;
    const n = m.src(bg)?.values?.length;
    if (!canvas || !n) return;
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / (canvas.offsetWidth || rect.width) || 1;
    const x = (e.clientX - rect.left) / sx;
    const padL = 50, padR = 12;
    const iw = canvas.offsetWidth - padL - padR;
    const i = Math.round(((x - padL) / Math.max(iw, 1)) * (n - 1));
    setHover(Math.min(Math.max(i, 0), n - 1));
  };

  const u = m.scale === 1e6 ? "M" : "";
  const f1 = (v) => (v == null ? "--" : m.scale === 1e6 ? v.toFixed(1) : Math.round(v));

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Block Gas · 执行视角
          {verdict && guStat && (
            <em className={`panel-verdict pv-${verdict.cls}`}>
              {verdict.t} · Gas 稳定在 {guStat.min.toFixed(0)}-{guStat.max.toFixed(0)}M · 距上限 {headroom.toFixed(0)}%
            </em>
          )}
        </span>
        <span className="bm-ctls">
          <span className="tf-ranges">
            {Object.values(METRICS).map((mm) => (
              <button key={mm.key} className={`tf-range ${metric === mm.key ? "on" : ""}`} onClick={() => setMetric(mm.key)}>{mm.label}</button>
            ))}
          </span>
          <span className="tf-ranges">
            {[[30, "30m"], [360, "6h"], [1440, "24h"]].map(([v, l]) => (
              <button key={v} className={`tf-range ${win === v ? "on" : ""}`} onClick={() => setWin(v)}>{l}</button>
            ))}
          </span>
        </span>
      </div>
      <div className="panel-body bg-body">
        {/* 图上方只留一行 AI 摘要,完整解读在右侧 LEO 区 */}
        {aiFirstLine && !sum.err && (
          <div className="bg-ai-line">AI:{aiFirstLine.slice(0, 90)}</div>
        )}
        {/* 紧凑 metric strip(替代四个大卡) */}
        <div className="bg-strip">
          <span>Gas/块 <em style={{ color: "#3FB8A0" }}>{fmtM(gu)}</em></span>
          <span>距上限 <em>{headroom != null ? headroom.toFixed(0) + "%" : "--"}</em></span>
          <span>执行吞吐 <em style={{ color: "var(--gold)" }}>{mg != null ? Math.round(mg) : "--"} MGas/s</em></span>
          <span>Txs/块 <em>{tx != null ? Math.round(tx) : "--"}</em></span>
          <span>耗时 <em style={{ color: slotPct > 40 ? "var(--orange)" : "var(--green)" }}>{execMs != null ? execMs.toFixed(0) + "ms" : "--"}</em>{slotPct != null ? ` · ${slotPct.toFixed(0)}% slot` : ""}</span>
        </div>
        {/* 主体:趋势图 60% + LEO 分析区 40%(结论/关键数字/建议 + 摘要并入) */}
        <div className="bg-main bg-main2">
          <div className="bg-chartcol">
            <div className="bg-legend">
              <span><i style={{ background: m.color }} />{m.label}</span>
              <em className="bg-src">曲线为 {SAMPLE_IPS.join(" / ")} 两台典型 validator 均值 · {winLabel}</em>
            </div>
            <div className="bg-canvas-wrap">
              <span className="bg-chart-tag">近 {winCn} 流量</span>
              <span className={`bg-peak-tag ${lastPeak ? "hot" : ""}`}>
                {lastPeak
                  ? <>最近高峰 {lastPeak.peakM}M · {peakT(lastPeak.startT)} · 块 {peakBlk(lastPeak.startBlock)}</>
                  : <>近 {winCn} 无明显高峰</>}
              </span>
              <canvas ref={canvasRef} className="bg-canvas" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
            </div>
          </div>
          <div className="bg-leo">
            <div className="bg-leo-head">
              <img className="bg-leo-bot" src={(import.meta.env.BASE_URL ?? "/") + "robot.png"} alt="" />
              <span>近 {sumDays} 天流量汇总</span>
              <span className="tf-ranges">
                {[7, 15].map((d) => (
                  <button key={d} className={`tf-range ${sumDays === d ? "on" : ""}`} disabled={sum.loading} onClick={() => setSumDays(d)}>{d}天</button>
                ))}
              </span>
              {sum.at && <em className="bg-leo-at">{new Date(sum.at).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })}</em>}
              <button className="st-auto-btn ai-cta panel-ai-btn" onClick={refreshSum} disabled={sum.loading}>
                {sum.loading ? "分析中…" : "↻ 刷新"}
              </button>
            </div>
            {sum.err && <div className="ai-err">⚠ {sum.err}</div>}
            {sum.text
              ? <div className="bg-leo-text"><AiText text={sum.text} /></div>
              : <div className="bg-leo-hint">{sum.loading ? `汇总近 ${sumDays} 天 gas 利用率与打满情况(链上抽查未打满块的交易特征)… ~1-2min` : "暂无汇总"}</div>}
            <div className="bg-leo-ask">
              <input className="robot-input" placeholder="问 gas/打满相关:某块为什么没打满?"
                     value={q} onChange={(e) => setQ(e.target.value)}
                     onKeyDown={(e) => e.key === "Enter" && ask()} disabled={qa.busy} />
              <button className="robot-send" onClick={ask} disabled={qa.busy || !q.trim()}>{qa.busy ? "…" : "问"}</button>
            </div>
            {qa.err && <div className="ai-err">⚠ {qa.err}</div>}
            {qa.ans && <div className="bg-leo-ans"><AiText text={qa.ans} /></div>}
          </div>
        </div>
      </div>
    </div>
  );
}
