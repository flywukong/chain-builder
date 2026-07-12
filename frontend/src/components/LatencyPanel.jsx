import { useEffect, useRef, useState } from "react";
import { usePanelAi, AiButton, AiResult } from "./PanelAi.jsx";

const API = import.meta.env.VITE_API_BASE ?? "";
const NODE_COLORS = ["#3FB8A0", "#9A86F0", "#38bdf8", "#ec4899"];

const hhmm = (t) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export default function LatencyPanel() {
  const canvasRef = useRef(null);
  const [d, setD] = useState(null);
  const [hover, setHover] = useState(null);   // index into times
  const ai = usePanelAi("/api/ai/latency");

  useEffect(() => {
    let alive = true;
    const pull = () => fetch(API + "/api/insert-latency")
      .then((r) => r.json())
      .then((j) => { if (alive && j?.times) setD(j); })
      .catch(() => {});
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
        ctx.fillText("加载中…(keter · 4 节点均值)", W / 2, H / 2);
        return;
      }
      const padL = 40, padR = 10, padT = 8, padB = 16;
      const iw = W - padL - padR, ih = H - padT - padB;
      const t0 = d.times[0], t1 = d.times[d.times.length - 1] || t0 + 1;
      const maxV = Math.max(d.threshold * 1.3, (d.max ?? 0) * 1.12, 100);
      const X = (t) => padL + ((t - t0) / (t1 - t0)) * iw;
      const Y = (v) => padT + ih - (v / maxV) * ih;

      // y 网格 + 标签
      ctx.font = "8.5px monospace"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      const step = maxV > 800 ? 300 : maxV > 400 ? 150 : 50;
      for (let v = 0; v <= maxV; v += step) {
        const y = Y(v);
        ctx.strokeStyle = "#181610"; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillStyle = "#5d594e"; ctx.fillText(v + "", padL - 5, y);
      }
      // x 时间标签
      ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "#5d594e";
      [0, 0.25, 0.5, 0.75, 1].forEach((f) => {
        const t = t0 + f * (t1 - t0);
        ctx.fillText(hhmm(t), padL + f * iw, H - padB + 5);
      });

      // >450ms 异常段红色背景带
      (d.episodes ?? []).forEach((e) => {
        const x1 = X(e.from), x2 = Math.max(X(e.to), x1 + 2);
        ctx.fillStyle = "rgba(239,68,68,.10)";
        ctx.fillRect(x1, padT, x2 - x1, ih);
      });

      // 450ms 阈值线
      const yT = Y(d.threshold);
      ctx.setLineDash([5, 4]); ctx.strokeStyle = "rgba(239,68,68,.55)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, yT); ctx.lineTo(W - padR, yT); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = "8px monospace"; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      ctx.fillStyle = "rgba(239,68,68,.75)";
      ctx.fillText(`${d.threshold}ms 出块间隔`, padL + 4, yT - 2);

      // 每台机器细线(低透明,准确对照)
      (d.perNode ?? []).forEach((s, si) => {
        const ts = s.times ?? d.times;
        ctx.strokeStyle = NODE_COLORS[si % NODE_COLORS.length] + "55";
        ctx.lineWidth = 1; ctx.lineJoin = "round"; ctx.beginPath();
        let started = false;
        s.values.forEach((v, i) => {
          if (typeof v !== "number") { started = false; return; }
          const x = X(ts[i]), y = Y(Math.min(v, maxV));
          started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          started = true;
        });
        ctx.stroke();
      });

      // 4 机均值主线(金色 + 辉光)
      ctx.save();
      ctx.strokeStyle = "#F0B90B"; ctx.lineWidth = 1.9; ctx.lineJoin = "round";
      ctx.shadowColor = "rgba(240,185,11,.5)"; ctx.shadowBlur = 6;
      ctx.beginPath();
      let started = false;
      d.avg.forEach((v, i) => {
        if (typeof v !== "number") { started = false; return; }
        const x = X(d.times[i]), y = Y(Math.min(v, maxV));
        started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        started = true;
      });
      ctx.stroke();
      ctx.restore();

      // hover crosshair + tooltip
      if (hover != null && d.times[hover] != null) {
        const hx = X(d.times[hover]);
        ctx.strokeStyle = "rgba(240,185,11,.35)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + ih); ctx.stroke();
        const av = d.avg[hover];
        if (typeof av === "number") {
          ctx.fillStyle = "#F0B90B";
          ctx.beginPath(); ctx.arc(hx, Y(Math.min(av, maxV)), 3, 0, Math.PI * 2); ctx.fill();
        }
        const lines = [`${hhmm(d.times[hover])}  avg ${typeof av === "number" ? av + "ms" : "--"}`];
        (d.perNode ?? []).forEach((s) => {
          const ts = s.times ?? d.times;
          // 找最接近 hover 时间的点
          let bi = 0, bd = Infinity;
          for (let i = 0; i < ts.length; i++) { const dd = Math.abs(ts[i] - d.times[hover]); if (dd < bd) { bd = dd; bi = i; } }
          const v = s.values[bi];
          lines.push(`${s.instance}  ${typeof v === "number" ? v + "ms" : "--"}`);
        });
        ctx.font = "9px monospace";
        const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
        const th = lines.length * 13 + 8;
        let bx = hx + 10; if (bx + tw > W - 4) bx = hx - tw - 10;
        const by = padT + 4;
        ctx.fillStyle = "rgba(12,11,8,.94)"; ctx.strokeStyle = "#2e2a1d";
        ctx.beginPath(); ctx.roundRect(bx, by, tw, th, 5); ctx.fill(); ctx.stroke();
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        lines.forEach((l, li) => {
          ctx.fillStyle = li === 0 ? "#F0B90B" : NODE_COLORS[(li - 1) % NODE_COLORS.length];
          ctx.fillText(l, bx + 7, by + 5 + li * 13);
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
    const sx = rect.width / (canvas.offsetWidth || rect.width) || 1;   // 界面 zoom 系数
    const x = (e.clientX - rect.left) / sx;                            // 换算回设计 px
    const padL = 40, padR = 10;
    const f = (x - padL) / Math.max(canvas.offsetWidth - padL - padR, 1);
    if (f < 0 || f > 1) { setHover(null); return; }
    const t0 = d.times[0], t1 = d.times[d.times.length - 1];
    const target = t0 + f * (t1 - t0);
    let bi = 0, bd = Infinity;
    for (let i = 0; i < d.times.length; i++) { const dd = Math.abs(d.times[i] - target); if (dd < bd) { bd = dd; bi = i; } }
    setHover(bi);
  };

  const nEp = d?.episodes?.length ?? 0;

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Block Insert Latency</span>
        <span className="bm-ctls">
          <span className="sub">{d ? `${d.ips.length} 节点均值 · ${d.hours}h` : "…"}</span>
          <AiButton ai={ai} />
        </span>
      </div>
      <div className="panel-body latency-body">
        <AiResult ai={ai} title="导入时延解读 · 节点差异与超阈段" />
        <div className="lat-strip">
          <span className="lat-stat"><em style={{ color: "#F0B90B" }}>{d?.cur ?? "--"}</em>ms 当前</span>
          <span className="lat-stat"><em>{d?.mean ?? "--"}</em>ms 均值</span>
          <span className="lat-stat"><em>{d?.max ?? "--"}</em>ms 峰值</span>
          <span className={`lat-ep ${nEp ? "warn" : "ok"}`}>
            {nEp ? `⚠ ${nEp} 段 > ${d.threshold}ms` : `✓ 无 > ${d?.threshold ?? 450}ms`}
          </span>
        </div>
        {nEp > 0 && (
          <div className="lat-ep-list">
            {d.episodes.slice(0, 6).map((e, i) => (
              <span key={i} className="lat-ep-chip">
                {hhmm(e.from)}–{hhmm(e.to)} · 峰值 {e.peak}ms
              </span>
            ))}
            {nEp > 6 && <span className="lat-ep-chip">+{nEp - 6}</span>}
          </div>
        )}
        <canvas ref={canvasRef} className="latency-canvas"
                onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
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
