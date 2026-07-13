import { useEffect, useRef, useState } from "react";
import { usePanelAi, AiButton, AiResult } from "./PanelAi.jsx";

const API = import.meta.env.VITE_API_BASE ?? "";
const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

// 24h 异常节点数迷你走势(半小时采样)
function SyncHistSpark({ history, threshold }) {
  const ref = useRef(null);
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
      const vals = (history?.values ?? []).map((v) => (typeof v === "number" ? v : 0));
      if (!vals.length) return;
      const maxV = Math.max(...vals, 2);
      const X = (i) => (i / Math.max(vals.length - 1, 1)) * (W - 4) + 2;
      const Y = (v) => H - 12 - (v / maxV) * (H - 18);
      ctx.strokeStyle = "#23201a"; ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(W, Y(0)); ctx.stroke();
      ctx.strokeStyle = "#3FB8A0"; ctx.lineWidth = 1.4; ctx.lineJoin = "round"; ctx.beginPath();
      vals.forEach((v, i) => (i === 0 ? ctx.moveTo(X(i), Y(v)) : ctx.lineTo(X(i), Y(v))));
      ctx.stroke();
      vals.forEach((v, i) => {
        if (v > 0) { ctx.fillStyle = "#ef4444"; ctx.beginPath(); ctx.arc(X(i), Y(v), 2.2, 0, 7); ctx.fill(); }
      });
      const ts = history?.times ?? [];
      if (ts.length) {
        ctx.fillStyle = "#5d594e"; ctx.font = "8px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        [[0, 0], [0.5, Math.floor(ts.length / 2)], [1, ts.length - 1]].forEach(([f, i]) =>
          ctx.fillText(hhmm(ts[i]), 2 + f * (W - 4), H - 1));
      }
    }
    draw();
    const ro = new ResizeObserver(draw); ro.observe(canvas);
    return () => ro.disconnect();
  }, [history, threshold]);
  return <canvas ref={ref} className="sync-hist-canvas" />;
}

// 节点同步详情:全节点 10min 链头增长柱状图 + 异常列表 + 24h 异常历史 + AI 解读
export default function SyncPanel() {
  const canvasRef = useRef(null);
  const [d, setD] = useState(null);
  const [hover, setHover] = useState(null);
  const ai = usePanelAi("/api/ai/sync");

  useEffect(() => {
    let alive = true;
    const pull = () => fetch(API + "/api/sync-detail").then((r) => r.json())
      .then((j) => { if (alive && j?.nodes) setD(j); }).catch(() => {});
    pull();
    const t = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

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
      const nodes = d?.nodes ?? [];
      if (!nodes.length) {
        ctx.fillStyle = "#4a463c"; ctx.font = "10px monospace"; ctx.textAlign = "center";
        ctx.fillText("加载 keter 数据…", W / 2, H / 2); return;
      }
      const padL = 44, padR = 8, padT = 8, padB = 16;
      const iw = W - padL - padR, ih = H - padT - padB;
      const maxV = Math.max(...nodes.map((n) => n.grew), d.expected) * 1.1;
      const Y = (v) => padT + ih - (v / maxV) * ih;
      // y 网格
      ctx.font = "8.5px monospace"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      for (let k = 0; k <= 3; k++) {
        const v = (maxV / 3) * k, y = Y(v);
        ctx.strokeStyle = "#181610"; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillStyle = "#5d594e"; ctx.fillText(Math.round(v).toLocaleString(), padL - 5, y);
      }
      // 阈值 + 预期参考线
      [[d.threshold, "rgba(239,68,68,.55)", `阈值 ${d.threshold}`], [d.expected, "rgba(63,184,160,.4)", `预期 ~${d.expected.toLocaleString()}`]].forEach(([v, c, label]) => {
        const y = Y(v);
        ctx.setLineDash([5, 4]); ctx.strokeStyle = c; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = c; ctx.font = "8px monospace"; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
        ctx.fillText(label, padL + 4, y - 2);
      });
      // 每节点柱:落后红,正常青
      const n = nodes.length;
      const slot = iw / n, bw = Math.max(3, Math.min(16, slot * 0.62));
      nodes.forEach((node, i) => {
        const x = padL + slot * i + (slot - bw) / 2;
        const behind = node.grew < d.threshold;
        const h = Math.max((node.grew / maxV) * ih, 2);
        ctx.fillStyle = behind ? "#ef4444" : hover === i ? "#6fd8c4" : "#3FB8A0";
        if (behind) { ctx.shadowColor = "rgba(239,68,68,.6)"; ctx.shadowBlur = 6; }
        ctx.fillRect(x, padT + ih - h, bw, h);
        ctx.shadowBlur = 0;
      });
      ctx.fillStyle = "#5d594e"; ctx.font = "8.5px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText(`${n} 节点 · 按 ${d.windowMin}min 增长升序`, padL + iw / 2, H - padB + 5);
      // hover tooltip
      if (hover != null && nodes[hover]) {
        const node = nodes[hover];
        const x = padL + slot * hover + slot / 2;
        const txt = `${node.instance} · ${node.grew.toLocaleString()} 块/${d.windowMin}min`;
        ctx.font = "700 9.5px monospace";
        const tw = ctx.measureText(txt).width + 14;
        let bx = x + 8; if (bx + tw > W - padR) bx = x - tw - 8;
        ctx.fillStyle = "rgba(12,11,8,.94)"; ctx.strokeStyle = "#2e2a1d";
        ctx.beginPath(); ctx.roundRect(bx, padT + 2, tw, 18, 5); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#e8dcb8"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(txt, bx + 7, padT + 11);
      }
    }
    draw();
    const ro = new ResizeObserver(draw); ro.observe(canvas);
    return () => ro.disconnect();
  }, [d, hover]);

  const onMove = (e) => {
    const canvas = canvasRef.current;
    const n = d?.nodes?.length;
    if (!canvas || !n) return;
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / (canvas.offsetWidth || rect.width) || 1;
    const x = (e.clientX - rect.left) / sx;
    const padL = 44, padR = 8;
    const iw = canvas.offsetWidth - padL - padR;
    const i = Math.floor(((x - padL) / Math.max(iw, 1)) * n);
    setHover(i >= 0 && i < n ? i : null);
  };

  const behind = (d?.nodes ?? []).filter((n) => n.grew < (d?.threshold ?? 600));
  const histPeak = Math.max(...((d?.history?.values ?? []).filter((v) => typeof v === "number")), 0);

  return (
    <div className="panel sync-panel">
      <div className="panel-header">
        <span>节点同步 · Chain Head 增长
          {d && (behind.length > 0
            ? <em className="panel-verdict pv-warn">需关注 · {behind.length} 节点落后</em>
            : <em className="panel-verdict pv-ok">正常 · {d.total}/{d.total} 同步中</em>)}
        </span>
        <span className="bm-ctls">
          <span className="sub">判据 {d?.windowMin ?? 10}min 增长 &lt; {d?.threshold ?? 600} · 预期 ~{(d?.expected ?? 1333).toLocaleString()} · 60s 刷新</span>
          <AiButton ai={ai} />
        </span>
      </div>
      <div className="panel-body sync-body">
        <AiResult ai={ai} title="节点同步解读 · 孤立/集群性判断" />
        <div className="reorg-chips">
          <div className={`reorg-chip ${behind.length ? "tone-warn" : "tone-ok"}`}><span className="rc-v">{d ? behind.length : "--"}</span><span className="rc-l">当前落后节点</span></div>
          <div className="reorg-chip tone-ok"><span className="rc-v">{d?.total ?? "--"}</span><span className="rc-l">监控节点总数</span></div>
          <div className={`reorg-chip ${histPeak > 0 ? "tone-warn" : "tone-ok"}`}><span className="rc-v">{d ? histPeak : "--"}</span><span className="rc-l">24h 异常峰值(节点数)</span></div>
        </div>
        <div className="sync-main">
          <canvas ref={canvasRef} className="sync-canvas" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
          <div className="sync-side">
            <div className="re-title">当前落后节点</div>
            {behind.length === 0
              ? <div className="re-empty">✓ 全部节点同步正常</div>
              : behind.map((n) => (
                  <div key={n.instance} className="re-row">
                    <span className="re-time">{n.instance}</span>
                    <span className="re-cnt" style={{ color: "var(--orange)" }}>{n.grew.toLocaleString()}</span>
                    <span className="re-nodes">/{d.windowMin}min</span>
                  </div>
                ))}
            <div className="re-title" style={{ marginTop: 8 }}>24h 异常节点数走势</div>
            <SyncHistSpark history={d?.history} threshold={d?.threshold} />
          </div>
        </div>
      </div>
    </div>
  );
}
