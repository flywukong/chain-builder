import { useEffect, useRef, useState } from "react";

const API = import.meta.env.VITE_API_BASE ?? "";

const fmtHour = (t) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:00`;
};

// Reorg 分析 — 数据维度对齐 Osaka/Mendel 硬分叉对比报告:
// 链级去重口径 max(increase[1h])、剔除单节点本地抖动、日聚合 + 孤块数 + 平均深度
export default function ReorgPanel({ data }) {
  const canvasRef = useRef(null);
  const days = data?.days ?? [];
  const sum = data?.summary;
  const [obs, setObs] = useState(null);   // 本机 WS 观测(精确高度,24h)

  useEffect(() => {
    fetch(API + "/api/reorg-events").then((r) => r.json())
      .then((d) => setObs(d.observed)).catch(() => {});
  }, [data]);

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
      if (!days.length) {
        ctx.fillStyle = "#4a463c"; ctx.font = "10px monospace"; ctx.textAlign = "center";
        ctx.fillText("加载 Keter 14d 数据…", W / 2, H / 2); return;
      }
      const padL = 8, padR = 8, padB = 16, padT = 6;
      const iw = W - padL - padR, ih = H - padT - padB;
      const maxV = Math.max(2, ...days.map((d) => Math.max(d.count, d.orphans)));
      const n = days.length;
      const slot = iw / n, bw = Math.min(14, slot * 0.3);

      // baseline
      ctx.strokeStyle = "#3a3527"; ctx.beginPath();
      ctx.moveTo(padL, padT + ih + 0.5); ctx.lineTo(W - padR, padT + ih + 0.5); ctx.stroke();

      days.forEach((d, i) => {
        const cxm = padL + slot * i + slot / 2;
        // count bar (gold) | orphan bar (teal), side by side
        const hC = (d.count / maxV) * ih, hO = (d.orphans / maxV) * ih;
        if (d.count > 0) {
          ctx.fillStyle = "#F0B90B";
          ctx.shadowColor = "rgba(240,185,11,.5)"; ctx.shadowBlur = 6;
          ctx.fillRect(cxm - bw - 1, padT + ih - hC, bw, Math.max(hC, 2));
          ctx.shadowBlur = 0;
        } else {
          ctx.fillStyle = "#1d1b15";
          ctx.fillRect(cxm - bw - 1, padT + ih - 2, bw, 2);
        }
        if (d.orphans > 0) {
          ctx.fillStyle = "#3FB8A0";
          ctx.fillRect(cxm + 1, padT + ih - hO, bw, Math.max(hO, 2));
        }
        // labels: value above bar, date below (sparse)
        if (d.count > 0) {
          ctx.fillStyle = "#e0c96a"; ctx.font = "700 9px monospace"; ctx.textAlign = "center";
          ctx.fillText(d.count, cxm - bw / 2 - 1, padT + ih - hC - 4);
        }
        if (i % 2 === 0 || d.count > 0) {
          ctx.fillStyle = d.count > 0 ? "#8a857c" : "#4a463c"; ctx.font = "8.5px monospace"; ctx.textAlign = "center";
          ctx.fillText(d.date, cxm, H - 4);
        }
      });
    }
    draw();
    const ro = new ResizeObserver(draw); ro.observe(canvas);
    return () => ro.disconnect();
  }, [data]);

  const chips = sum ? [
    { v: sum.avgPerDay, l: `日均次数 · ${sum.spanDays}d`, tone: sum.avgPerDay > 5 ? "warn" : "ok" },
    { v: `${sum.total} / ${sum.orphans}`, l: "总次数 / 孤块(去重)", tone: "ok" },
    { v: `${sum.daysWithReorg}/${sum.spanDays}`, l: "发生 Reorg 天数", tone: sum.daysWithReorg > sum.spanDays * 0.5 ? "warn" : "ok" },
    { v: sum.avgDepth, l: "平均深度 (孤块/次)", tone: sum.avgDepth > 4 ? "warn" : "ok" },
  ] : [];

  return (
    <div className="panel reorg-panel">
      <div className="panel-header">
        <span>Reorg 分析</span>
        <span className="sub">近 {days.length || 14} 天 · 链级去重 max(increase[1h]) · 剔除单节点抖动{sum?.excluded ? `(已剔 ${sum.excluded})` : ""}</span>
      </div>
      <div className="panel-body reorg-body">
        <div className="reorg-chips">
          {chips.map((c) => (
            <div key={c.l} className={`reorg-chip tone-${c.tone}`}>
              <span className="rc-v">{c.v}</span>
              <span className="rc-l">{c.l}</span>
            </div>
          ))}
          {sum?.peakDay && (
            <div className="reorg-chip tone-ok">
              <span className="rc-v">{sum.peakDay.count} 次</span>
              <span className="rc-l">单日峰值 · {sum.peakDay.date}</span>
            </div>
          )}
        </div>

        <div className="reorg-main">
          <div className="reorg-chart">
            <div className="reorg-legend">
              <span><i style={{ background: "#F0B90B" }} />链级 Reorg 次数/日</span>
              <span><i style={{ background: "#3FB8A0" }} />重组孤块数/日</span>
            </div>
            <canvas ref={canvasRef} className="reorg-canvas" />
          </div>

          <div className="reorg-events">
            <div className="re-title">最近事件 · 孤块 = 被回滚块数(≈深度)</div>
            {(data?.events ?? []).length === 0
              ? <div className="re-empty">✓ 窗口内无链级 reorg</div>
              : data.events.map((e) => (
                  <div key={e.t} className="re-row">
                    <span className="re-time">{fmtHour(e.t)}</span>
                    <span className="re-cnt">{e.count} 次</span>
                    <span className="re-orph">{e.orphans} 孤块</span>
                    <span className="re-nodes">{e.nodes != null ? `${e.nodes} 节点` : "—"}</span>
                  </div>
                ))}

            <div className="re-title" style={{ marginTop: 6 }}>本机观测高度 · 24h(单视角,仅参考)</div>
            {!obs || obs.count === 0
              ? <div className="re-empty">✓ 24h 本机未观测到 reorg</div>
              : obs.recent.slice(0, 6).map((r) => (
                  <div key={r.t} className="re-row">
                    <span className="re-time">#{r.from?.toLocaleString()}→{r.to?.toLocaleString()}</span>
                    <span className="re-cnt">d{r.depth}</span>
                    <span className="re-nodes">{new Date(r.t).toLocaleTimeString()}</span>
                  </div>
                ))}
          </div>
        </div>
      </div>
    </div>
  );
}
