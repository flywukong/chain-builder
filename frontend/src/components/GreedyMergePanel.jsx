import { useEffect, useRef, useState } from "react";
import { usePanelAi, AiButton, AiResult } from "./PanelAi.jsx";

const API = import.meta.env.VITE_API_BASE ?? "";
const NODE_COLORS = ["#8B7CF6", "#4CA4D9", "#37A89A", "#E58A55"];
const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

// Greedy merge 命中率:中标 bid 中触发链上 greedy merge 的比例(validator 侧 keter 指标)
// 展示典型节点(与 insert latency 同套路),AI 解读喂全量 validator 横向对比
export default function GreedyMergePanel() {
  const canvasRef = useRef(null);
  const [d, setD] = useState(null);
  const [hover, setHover] = useState(null);
  const ai = usePanelAi("/api/ai/greedy");

  useEffect(() => {
    let alive = true;
    const pull = () => fetch(API + "/api/greedy-merge").then((r) => r.json())
      .then((j) => { if (alive && j?.times) setD(j); }).catch(() => {});
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
      if (!d?.times?.length) {
        ctx.fillStyle = "#4a463c"; ctx.font = "10px monospace"; ctx.textAlign = "center";
        ctx.fillText("加载中…(keter · 典型 validator)", W / 2, H / 2); return;
      }
      const padL = 34, padR = 10, padT = 8, padB = 16;
      const iw = W - padL - padR, ih = H - padT - padB;
      const t0 = d.times[0], t1 = d.times[d.times.length - 1] || t0 + 1;
      const maxV = 100;
      const X = (t) => padL + ((t - t0) / (t1 - t0)) * iw;
      const Y = (v) => padT + ih - (Math.min(v, maxV) / maxV) * ih;

      ctx.font = "8.5px monospace"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      for (let v = 0; v <= 100; v += 25) {
        const y = Y(v);
        ctx.strokeStyle = "#181610"; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillStyle = "#5d594e"; ctx.fillText(v + "%", padL - 5, y);
      }
      ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "#5d594e";
      [0, 0.5, 1].forEach((f) => ctx.fillText(hhmm(t0 + f * (t1 - t0)), padL + f * iw, H - padB + 5));

      // 每台节点细线
      (d.perNode ?? []).forEach((s, si) => {
        const ts = s.times ?? d.times;
        ctx.strokeStyle = NODE_COLORS[si % NODE_COLORS.length] + "66";
        ctx.lineWidth = 1; ctx.lineJoin = "round"; ctx.beginPath();
        let started = false;
        s.values.forEach((v, i) => {
          if (typeof v !== "number") { started = false; return; }
          const x = X(ts[i]), y = Y(v);
          started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
        });
        ctx.stroke();
      });
      // 均值主线(金色)
      ctx.strokeStyle = "#F0B90B"; ctx.lineWidth = 1.9; ctx.lineJoin = "round";
      ctx.shadowColor = "rgba(240,185,11,.5)"; ctx.shadowBlur = 6; ctx.beginPath();
      let started = false;
      d.avg.forEach((v, i) => {
        if (typeof v !== "number") { started = false; return; }
        const x = X(d.times[i]), y = Y(v);
        started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
      });
      ctx.stroke(); ctx.shadowBlur = 0;

      if (hover != null && d.times[hover] != null) {
        const hx = X(d.times[hover]);
        ctx.strokeStyle = "rgba(240,185,11,.35)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + ih); ctx.stroke();
        const av = d.avg[hover];
        const lines = [`${hhmm(d.times[hover])}  均值 ${typeof av === "number" ? av + "%" : "--"}`];
        (d.perNode ?? []).forEach((s) => {
          const ts = s.times ?? d.times;
          let bi = 0, bd = Infinity;
          for (let i = 0; i < ts.length; i++) { const dd = Math.abs(ts[i] - d.times[hover]); if (dd < bd) { bd = dd; bi = i; } }
          const v = s.values[bi];
          lines.push(`${s.instance}  ${typeof v === "number" ? v + "%" : "--"}`);
        });
        ctx.font = "9px monospace";
        const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
        const th = lines.length * 13 + 8;
        let bx = hx + 10; if (bx + tw > W - 4) bx = hx - tw - 10;
        ctx.fillStyle = "rgba(12,11,8,.94)"; ctx.strokeStyle = "#2e2a1d";
        ctx.beginPath(); ctx.roundRect(bx, padT + 4, tw, th, 5); ctx.fill(); ctx.stroke();
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        lines.forEach((l, li) => {
          ctx.fillStyle = li === 0 ? "#F0B90B" : NODE_COLORS[(li - 1) % NODE_COLORS.length];
          ctx.fillText(l, bx + 7, padT + 9 + li * 13);
        });
      }
    }
    draw();
    const ro = new ResizeObserver(draw); ro.observe(canvas);
    return () => ro.disconnect();
  }, [d, hover]);

  const onMove = (e) => {
    if (!d?.times?.length) return;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / (canvas.offsetWidth || rect.width) || 1;
    const x = (e.clientX - rect.left) / sx;
    const padL = 34, padR = 10;
    const f = (x - padL) / Math.max(canvas.offsetWidth - padL - padR, 1);
    if (f < 0 || f > 1) { setHover(null); return; }
    const t0 = d.times[0], t1 = d.times[d.times.length - 1];
    const target = t0 + f * (t1 - t0);
    let bi = 0, bd = Infinity;
    for (let i = 0; i < d.times.length; i++) { const dd = Math.abs(d.times[i] - target); if (dd < bd) { bd = dd; bi = i; } }
    setHover(bi);
  };

  return (
    <div className="panel" style={{ maxWidth: 1240 }}>
      <div className="panel-header">
        <span>Greedy Merge 命中率
          {d && <em className="panel-verdict pv-ok">均值 {d.mean ?? "--"}% · 区间 {d.min ?? "--"}–{d.max ?? "--"}%</em>}
        </span>
        <span className="bm-ctls">
          <span className="sub">{d ? `${d.ips.length} 台典型 validator · ${d.hours}h · bid 中标触发链上贪婪合并占比` : "…"}</span>
          <AiButton ai={ai} />
        </span>
      </div>
      <div className="panel-body latency-body">
        <AiResult ai={ai} title="Greedy Merge 命中率解读 · 节点差异" />
        <div className="lat-strip">
          <span className="lat-stat"><em style={{ color: "#F0B90B" }}>{d?.cur ?? "--"}</em>% 当前</span>
          <span className="lat-stat"><em>{d?.mean ?? "--"}</em>% 均值</span>
          <span className="lat-stat"><em>{d?.max ?? "--"}</em>% 峰值</span>
          <span className="lat-stat"><em>{d?.min ?? "--"}</em>% 低值</span>
        </div>
        <canvas ref={canvasRef} className="latency-canvas" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        <div className="lat-nodes">
          {(d?.perNode ?? []).map((s, i) => (
            <span key={s.instance} className="lat-node">
              <span className="lat-dot" style={{ background: NODE_COLORS[i % NODE_COLORS.length] }} />{s.instance}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
