import { useEffect, useRef, useState } from "react";
import RobotWidget from "./RobotWidget.jsx";
import { aiRequest } from "../lib/ai.js";

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
  const [aiDays, setAiDays] = useState(14);   // 整体解读窗口:1(24h)/ 7 / 14
  const [ai, setAi] = useState({ loading: false, label: null, text: null, at: null, err: null });

  // body: {days} 整体解读窗口 / {eventT} 单事件归因;label 用于结果区标题与按钮态
  const runAi = async (body, label) => {
    if (ai.loading) return;
    setAi({ loading: true, label, text: null, at: null, err: null });
    try {
      const d = await aiRequest("/api/ai/reorg", body ?? {});
      if (d.error) setAi({ loading: false, label, text: null, at: null, err: d.error });
      else setAi({ loading: false, label, text: d.text, at: d.at, err: null });
    } catch (e) { setAi({ loading: false, label, text: null, at: null, err: String(e) }); }
  };

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

  // 事件分级:严重 = 孤块≥8;关注 = 孤块≥3 或单小时≥2次;其余(含本机观测)为参考
  const events = data?.events ?? [];
  const sevOf = (e) => (e.orphans >= 8 ? "severe" : e.orphans >= 3 || e.count >= 2 ? "watch" : "info");
  const severe = events.filter((e) => sevOf(e) === "severe");
  const watch = events.filter((e) => sevOf(e) === "watch");
  const info = events.filter((e) => sevOf(e) === "info");
  // 结论句:15天内 N 天发生;有严重→需关注;有关注→轻微;否则正常
  const verdict = severe.length ? { t: "需关注", cls: "warn" }
    : (sum?.daysWithReorg ?? 0) > 0 ? { t: "轻微", cls: "mid" } : { t: "正常", cls: "ok" };

  const EvRow = ({ e, tone }) => (
    <div key={e.t} className={`re-row ${tone === "severe" ? "re-severe" : tone === "watch" ? "re-watch" : ""}`}>
      <span className="re-time">{fmtHour(e.t)}</span>
      <span className="re-cnt">{e.count} 次</span>
      <span className="re-orph">{e.orphans} 孤块</span>
      <span className="re-nodes">{e.nodes != null ? `${e.nodes} 节点` : "—"}</span>
      <button className="tf-ep-btn" disabled={ai.loading} title="5m 定位 + canonical 出块序列取证"
              onClick={() => runAi({ eventT: e.t }, `事件 ${fmtHour(e.t)}`)}>
        {ai.loading && ai.label === `事件 ${fmtHour(e.t)}` ? "分析中…" : "⚡ 分析"}
      </button>
    </div>
  );

  return (
    <div className="panel reorg-panel">
      <div className="panel-header">
        <span>Reorg 分析
          {sum && (
            <em className={`panel-verdict pv-${verdict.cls}`}>
              {verdict.t} · {sum.spanDays}天内 {sum.daysWithReorg}天发生 · 平均深度 {sum.avgDepth}
            </em>
          )}
        </span>
        <span className="reorg-head-r">
          <span className="sub">近 {days.length || 14} 天 · 链级去重 max(increase[1h]) · 剔除单节点抖动{sum?.excluded ? `(已剔 ${sum.excluded})` : ""}</span>
          <span className="tf-ranges">
            {[[1, "24h"], [7, "7天"], [14, "14天"]].map(([d, l]) => (
              <button key={d} className={`tf-range ${aiDays === d ? "on" : ""}`} onClick={() => setAiDays(d)}>{l}</button>
            ))}
          </span>
          <button className="st-auto-btn ai-cta reorg-ai-btn" disabled={ai.loading}
                  onClick={() => runAi({ days: aiDays }, `近 ${aiDays === 1 ? "24h" : aiDays + " 天"}`)}>
            {ai.loading ? "解读中… ~20s" : "⚡ AI 解读"}
          </button>
        </span>
      </div>
      <div className="panel-body reorg-body">
        {ai.err && <div className="ai-err">⚠ {ai.err}</div>}
        {ai.text && (
          <div className="reorg-ai-result">
            <div className="tf-ep-head">
              <span>🤖 Reorg 解读 · {ai.label ?? "严重度 + 涉及方"}</span>
              {ai.at && <em className="ai-at">{new Date(ai.at).toLocaleTimeString()}</em>}
              <button className="tf-ep-close" onClick={() => setAi({ loading: false, label: null, text: null, at: null, err: null })}>×</button>
            </div>
            <div className="ai-result" style={{ maxHeight: 200 }}>{ai.text}</div>
          </div>
        )}
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
            {/* 图表下方空白区:监控问答机器人(reorg/空块/出块人/时延) */}
            <div className="reorg-robot-anchor"><RobotWidget variant="monitor" /></div>
          </div>

          <div className="reorg-events">
            <div className="re-title re-t-severe">严重(孤块≥8)</div>
            {severe.length === 0 ? <div className="re-empty">✓ 无</div> : severe.map((e) => <EvRow key={e.t} e={e} tone="severe" />)}

            <div className="re-title re-t-watch" style={{ marginTop: 6 }}>关注(孤块≥3 或 ≥2次/小时)</div>
            {watch.length === 0 ? <div className="re-empty">✓ 无</div> : watch.map((e) => <EvRow key={e.t} e={e} tone="watch" />)}

            <div className="re-title" style={{ marginTop: 6 }}>参考 · 常规 micro-reorg</div>
            {info.length === 0 ? <div className="re-empty">✓ 窗口内无</div> : info.map((e) => <EvRow key={e.t} e={e} tone="info" />)}

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
