import { useEffect, useRef, useState } from "react";
import { usePanelAi, AiButton, AiResult } from "./PanelAi.jsx";

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

// Block Gas — 执行视角:紧凑 strip + 趋势图(70%)+ 摘要栏(30%)
export default function BlockGasPanel({ blockGas, gasLimit }) {
  const canvasRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [metric, setMetric] = useState("gasused");
  const ai = usePanelAi("/api/ai/blockgas");

  // 上限与阈值:跟随链上实时 gasLimit;关注 = 50% 上限,高位 = 85% 上限
  const GL = gasLimit || DEFAULT_GAS_LIMIT;
  const glM = Math.round(GL / 1e6);
  const WATCH_GAS = GL * 0.5;
  const watchM = Math.round(WATCH_GAS / 1e6), highM = Math.round(GL * 0.85 / 1e6);

  const mg = last(blockGas?.mgasps);
  const gu = last(blockGas?.gasused);
  const tx = last(blockGas?.txsize);
  const execMs = mg && gu ? (gu / (mg * 1e6)) * 1000 : null;
  const slotPct = execMs != null ? (execMs / 450) * 100 : null;

  const m = METRICS[metric];
  const st = seriesStat(m.src(blockGas), m.scale === 1e6 ? 1e6 : 1);   // gasused 以 M 计
  const guStat = seriesStat(blockGas?.gasused, 1e6);
  // 异常点:块 gas 超关注阈值(50% 上限)的采样点数
  const hotPoints = (blockGas?.gasused?.values ?? []).filter((v) => typeof v === "number" && v > WATCH_GAS).length;

  // 结论:正常/偏高 + 区间 + 距上限
  const headroom = gu != null ? Math.max(0, 100 - (gu / GL) * 100) : null;
  const verdict = gu == null ? null : (gu / GL) * 100 >= 60 || hotPoints > 0 ? { t: "偏高", cls: "warn" } : { t: "正常", cls: "ok" };
  const aiFirstLine = ai.s.text ? ai.s.text.split("\n").find((l) => l.trim()) : null;

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
      const s = m.src(blockGas);
      if (!s?.values?.length) {
        ctx.fillStyle = "#4a463c"; ctx.font = "10px monospace"; ctx.textAlign = "center";
        ctx.fillText("加载 keter 30m 数据…", W / 2, H / 2); return;
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
        ctx.setLineDash([5, 4]); ctx.strokeStyle = "rgba(240,185,11,.5)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, yW); ctx.lineTo(W - padR, yW); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = "rgba(240,185,11,.7)"; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
        ctx.fillText(`关注 ${watchM}M`, padL + 4, yW - 2);
      }
      const ts = s.times ?? [];
      if (ts.length) {
        ctx.fillStyle = "#5d594e"; ctx.textAlign = "center"; ctx.textBaseline = "top";
        [[0, 0], [0.5, Math.floor(ts.length / 2)], [1, ts.length - 1]].forEach(([f, i]) =>
          ctx.fillText(fmtT(ts[i]), padL + f * iw, H - padB + 6));
      }

      const area = ctx.createLinearGradient(0, padT, 0, padT + ih);
      area.addColorStop(0, m.color + "42"); area.addColorStop(1, m.color + "05");
      ctx.beginPath();
      s.values.forEach((v, i) => { const y = Y(typeof v === "number" ? v : 0); i === 0 ? ctx.moveTo(X(i), y) : ctx.lineTo(X(i), y); });
      ctx.lineTo(X(n - 1), padT + ih); ctx.lineTo(X(0), padT + ih); ctx.closePath();
      ctx.fillStyle = area; ctx.fill();
      ctx.strokeStyle = m.color; ctx.lineWidth = 1.8; ctx.lineJoin = "round";
      ctx.shadowColor = m.color; ctx.shadowBlur = 6;
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
  }, [blockGas, hover, metric, gasLimit]);

  const onMove = (e) => {
    const canvas = canvasRef.current;
    const n = m.src(blockGas)?.values?.length;
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
          <AiButton ai={ai} />
        </span>
      </div>
      <div className="panel-body bg-body">
        {aiFirstLine && !ai.s.err && (
          <div className="bg-ai-line">AI:{aiFirstLine.slice(0, 90)}</div>
        )}
        <AiResult ai={ai} title="Block Gas 解读 · 执行负载" />
        {/* 紧凑 metric strip(替代四个大卡) */}
        <div className="bg-strip">
          <span>Gas/块 <em style={{ color: "#3FB8A0" }}>{fmtM(gu)}</em></span>
          <span>距上限 <em>{headroom != null ? headroom.toFixed(0) + "%" : "--"}</em></span>
          <span>执行吞吐 <em style={{ color: "var(--gold)" }}>{mg != null ? Math.round(mg) : "--"} MGas/s</em></span>
          <span>Txs/块 <em>{tx != null ? Math.round(tx) : "--"}</em></span>
          <span>耗时 <em style={{ color: slotPct > 40 ? "var(--orange)" : "var(--green)" }}>{execMs != null ? execMs.toFixed(0) + "ms" : "--"}</em>{slotPct != null ? ` · ${slotPct.toFixed(0)}% slot` : ""}</span>
        </div>
        {/* 主体:趋势图 70% + 摘要栏 30% */}
        <div className="bg-main">
          <div className="bg-chartcol">
            <div className="bg-legend">
              <span><i style={{ background: m.color }} />{m.label}</span>
              <em className="bg-src">曲线为 {SAMPLE_IPS.join(" / ")} 两台典型 validator 均值 · 30m</em>
            </div>
            <canvas ref={canvasRef} className="bg-canvas" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
          </div>
          <div className="bg-side">
            <div className="re-title">30m 摘要 · {m.label}</div>
            <div className="bg-side-row"><span>当前</span><b>{f1(st?.cur)}{u}</b></div>
            <div className="bg-side-row"><span>均值</span><b>{f1(st?.avg)}{u}</b></div>
            <div className="bg-side-row"><span>峰值</span><b>{f1(st?.max)}{u}</b></div>
            <div className="bg-side-row"><span>最低</span><b>{f1(st?.min)}{u}</b></div>
            <div className="bg-side-row"><span>异常点(&gt;{watchM}M)</span><b style={{ color: hotPoints > 0 ? "var(--orange)" : "var(--green)" }}>{hotPoints}</b></div>
            <div className="bg-side-ref">参考:正常 &lt;{watchM}M · 关注 {watchM}-{highM}M · 上限 {glM}M(链上实时)</div>
          </div>
        </div>
      </div>
    </div>
  );
}
