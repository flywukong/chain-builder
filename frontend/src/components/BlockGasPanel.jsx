import { useEffect, useRef } from "react";

const last = (s) => { const v = s?.values ?? []; for (let i = v.length - 1; i >= 0; i--) if (typeof v[i] === "number") return v[i]; return null; };
const fmtM = (v) => (v == null ? "--" : (v / 1e6).toFixed(1) + "M");

// Block Gas — 执行视角(区别于流量子系统的利用率视角):
// mgasps 执行吞吐 / gasused 每块用量 / txsize 每块笔数 / 推导单块执行耗时
export default function BlockGasPanel({ blockGas }) {
  const canvasRef = useRef(null);
  const mg = last(blockGas?.mgasps);
  const gu = last(blockGas?.gasused);
  const tx = last(blockGas?.txsize);
  // execution time per block = gasused / (mgasps × 1e6) seconds
  const execMs = mg && gu ? (gu / (mg * 1e6)) * 1000 : null;
  const slotPct = execMs != null ? (execMs / 450) * 100 : null;

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
      const mgS = blockGas?.mgasps, guS = blockGas?.gasused;
      if (!mgS?.values?.length) {
        ctx.fillStyle = "#4a463c"; ctx.font = "10px monospace"; ctx.textAlign = "center";
        ctx.fillText("加载 keter 30m 数据…", W / 2, H / 2); return;
      }
      // two independently-normalized lines (different units)
      const plot = (s, color, glow) => {
        const v = s.values.filter((x) => typeof x === "number");
        if (!v.length) return;
        const min = Math.min(...v) * 0.92, max = Math.max(...v) * 1.05 || 1;
        ctx.strokeStyle = color; ctx.lineWidth = 1.6;
        if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 5; }
        ctx.beginPath();
        s.values.forEach((val, i) => {
          if (typeof val !== "number") return;
          const x = (i / Math.max(s.values.length - 1, 1)) * W;
          const y = H - ((val - min) / (max - min)) * H * 0.86 - 4;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke(); ctx.shadowBlur = 0;
      };
      plot(guS, "#3FB8A0");
      plot(mgS, "#F0B90B", true);
    }
    draw();
    const ro = new ResizeObserver(draw); ro.observe(canvas);
    return () => ro.disconnect();
  }, [blockGas]);

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Block Gas · 执行视角</span>
        <span className="sub">2 典型节点均值 · 30m</span>
      </div>
      <div className="panel-body bg-body">
        <div className="bg-stats">
          <div className="bg-stat">
            <span className="bg-v" style={{ color: "var(--gold)" }}>{mg != null ? Math.round(mg) : "--"}</span>
            <span className="bg-l">MGas/s 执行吞吐</span>
          </div>
          <div className="bg-stat">
            <span className="bg-v" style={{ color: "#3FB8A0" }}>{fmtM(gu)}</span>
            <span className="bg-l">Gas / 块</span>
          </div>
          <div className="bg-stat">
            <span className="bg-v">{tx != null ? Math.round(tx) : "--"}</span>
            <span className="bg-l">Txs / 块</span>
          </div>
          <div className="bg-stat">
            <span className="bg-v" style={{ color: slotPct > 40 ? "var(--orange)" : "var(--green)" }}>
              {execMs != null ? execMs.toFixed(0) + "ms" : "--"}
            </span>
            <span className="bg-l">执行耗时/块{slotPct != null ? ` · ${slotPct.toFixed(0)}% slot` : ""}</span>
          </div>
        </div>
        <div className="bg-legend">
          <span><i style={{ background: "#F0B90B" }} />MGas/s</span>
          <span><i style={{ background: "#3FB8A0" }} />Gas used / 块</span>
        </div>
        <canvas ref={canvasRef} className="bg-canvas" />
      </div>
    </div>
  );
}
