import { useEffect, useRef } from "react";

const fmtClock = (t) =>
  new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export default function TxpoolPanel({ txpool }) {
  const canvasRef = useRef(null);
  const v = txpool && txpool.times?.length ? txpool : null;
  const thr = txpool?.threshold ?? 4000;

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
      if (!v) {
        ctx.fillStyle = "#333"; ctx.font = "11px sans-serif"; ctx.textAlign = "center";
        ctx.fillText("采样中…(每30s一点)", W / 2, H / 2); return;
      }
      // Scale to avg + threshold only. A single stuck node can sit at ~25k in
      // the per-node max, which would squash the avg line — and avg is what the
      // anomaly definition (avg > threshold) actually uses.
      const maxV = Math.max(thr * 1.3, ...v.avg) * 1.05;
      const n = v.times.length;
      const X = (i) => (i / Math.max(n - 1, 1)) * W;
      const Y = (val) => H - (val / maxV) * H * 0.9 - 4;

      // anomaly bands: shade contiguous spans where avg > threshold
      ctx.fillStyle = "#ef444422";
      let bs = -1;
      for (let i = 0; i <= n; i++) {
        const over = i < n && v.avg[i] > thr;
        if (over && bs < 0) bs = i;
        else if (!over && bs >= 0) {
          const x0 = X(bs) - (X(1) - X(0)) / 2, x1 = X(i - 1) + (X(1) - X(0)) / 2;
          ctx.fillRect(x0, 0, Math.max(x1 - x0, 2), H); bs = -1;
        }
      }

      // threshold line
      ctx.setLineDash([4, 4]); ctx.strokeStyle = "#ef4444aa"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, Y(thr)); ctx.lineTo(W, Y(thr)); ctx.stroke();
      ctx.setLineDash([]);

      // avg (main line)
      ctx.strokeStyle = "#F0B90B"; ctx.lineWidth = 1.8; ctx.beginPath();
      v.avg.forEach((val, i) => (i === 0 ? ctx.moveTo(X(i), Y(val)) : ctx.lineTo(X(i), Y(val))));
      ctx.stroke();
    }
    draw();
    const ro = new ResizeObserver(draw); ro.observe(canvas);
    return () => ro.disconnect();
  }, [v, thr]);

  const anomalies = v?.anomalyCount ?? 0;
  const wins = v?.windows ?? [];

  return (
    <div className="panel">
      <div className="panel-header">
        <span>TxPool Pending · Dataseed</span>
        <span className="sub">vs 24h{v?.spanHours != null ? ` (${v.spanHours}h)` : ""}</span>
      </div>
      <div className="panel-body txpool-body">
        <div className="txp-top">
          <div className="txp-stat">
            <span className="txp-k">当前均值</span>
            <span className="txp-v" style={{ color: v?.anomalyNow ? "#ef4444" : "#F0B90B" }}>
              {v?.current?.toLocaleString() ?? "--"}
            </span>
          </div>
          <div className="txp-stat">
            <span className="txp-k">24h 峰值</span>
            <span className="txp-v">{v?.max24h?.toLocaleString() ?? "--"}</span>
          </div>
          <div className="txp-stat">
            <span className="txp-k">阈值</span>
            <span className="txp-v txp-thr">{thr.toLocaleString()}</span>
          </div>
          <div className={`txp-badge ${anomalies ? "bad" : "ok"}`}>
            {v?.anomalyNow ? "● 大流量中" : anomalies ? `24h 大流量 ${anomalies} 次` : "24h 无大流量"}
          </div>
        </div>
        <canvas ref={canvasRef} className="txpool-canvas" />
        {wins.length > 0 && (
          <div className="txp-wins">
            {wins.slice().reverse().map((w, i) => (
              <div key={i} className="txp-win">
                <span className="txp-win-time">{fmtClock(w.start)}–{fmtClock(w.end)}</span>
                <span className="txp-win-peak">峰值 {Math.round(w.peak).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
