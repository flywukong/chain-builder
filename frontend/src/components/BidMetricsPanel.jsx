import { useEffect, useRef, useState } from "react";

const API = import.meta.env.VITE_API_BASE ?? "";
const COLORS = ["#F0B90B", "#45B8FF", "#22c55e", "#f97316", "#9A86F0", "#3FB8A0", "#ec4899", "#B6CC52", "#5BC8D8", "#ef4444"];

const avgOf = (s) => {
  const v = s.values.filter((x) => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
};

// 多节点时序线图(y 3 档 + x 首中尾),节点颜色循环
function Lines({ series, unit }) {
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
      if (!series?.length) { ctx.fillStyle = "#4a463c"; ctx.font = "10px monospace"; ctx.textAlign = "center"; ctx.fillText("加载中…", W / 2, H / 2); return; }
      const padL = 40, padR = 8, padT = 6, padB = 16;
      const iw = W - padL - padR, ih = H - padT - padB;
      const all = series.flatMap((s) => s.values.filter((v) => typeof v === "number"));
      const maxV = Math.max(...all, 0.1) * 1.08;
      ctx.font = "8.5px monospace"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      for (let k = 0; k <= 3; k++) {
        const v = (maxV / 3) * k, y = padT + ih - (v / maxV) * ih;
        ctx.strokeStyle = "#191712"; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillStyle = "#5d594e"; ctx.fillText(v.toFixed(v < 10 ? 1 : 0) + unit, padL - 5, y);
      }
      const t0 = series[0].times;
      if (t0?.length) {
        ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "#5d594e";
        [[0, 0], [0.5, Math.floor(t0.length / 2)], [1, t0.length - 1]].forEach(([f, i]) => {
          const d = new Date(t0[i]);
          ctx.fillText(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`, padL + f * iw, H - padB + 5);
        });
      }
      series.forEach((sr, si) => {
        const n = sr.values.length;
        ctx.strokeStyle = COLORS[si % COLORS.length]; ctx.lineWidth = 1.3; ctx.lineJoin = "round"; ctx.globalAlpha = 0.9;
        ctx.beginPath();
        sr.values.forEach((v, i) => {
          const x = padL + (i / Math.max(n - 1, 1)) * iw;
          const y = padT + ih - ((typeof v === "number" ? v : 0) / maxV) * ih;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
    }
    draw();
    const ro = new ResizeObserver(draw); ro.observe(canvas);
    return () => ro.disconnect();
  }, [series]);
  return <canvas ref={ref} className="bm-canvas" />;
}

function MetricPanel({ title, sub, series, unit }) {
  const sorted = [...(series ?? [])].sort((a, b) => avgOf(b) - avgOf(a));
  return (
    <div className="panel">
      <div className="panel-header"><span>{title}</span><span className="sub">{sub}</span></div>
      <div className="panel-body bm-body">
        <Lines series={series} unit={unit} />
        {sorted.length > 0 && (
          <div className="bm-legend">
            {sorted.map((s) => {
              const idx = series.indexOf(s);
              return (
                <span key={s.instance} className="bm-item">
                  <i style={{ background: COLORS[idx % COLORS.length] }} />
                  {s.instance}
                  <b>{avgOf(s).toFixed(1)}{unit}</b>
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const RANGES = [1, 6, 24];

// Bid 指标(keter validator 节点):模拟耗时 p50 + best bid gasUsed
export default function BidMetricsPanel() {
  const [d, setD] = useState(null);
  const [hours, setHours] = useState(6);
  useEffect(() => {
    let alive = true;
    setD(null);
    const pull = () => fetch(`${API}/api/bid-metrics?hours=${hours}`).then((r) => r.json()).then((j) => { if (alive) setD(j); }).catch(() => {});
    pull();
    const t = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [hours]);

  return (
    <div className="bm-wrap">
      <div className="bm-head">
        <span className="bm-title">Bid 指标 · Keter validator 节点</span>
        <span className="tf-ranges">
          {RANGES.map((h) => (
            <button key={h} className={`tf-range ${hours === h ? "on" : ""}`} onClick={() => setHours(h)}>{h}h</button>
          ))}
        </span>
      </div>
      {d === null ? (
        <div className="ph-note">加载中…(keter 不可达时此区无数据)</div>
      ) : !d?.sim?.length && !d?.gas?.length ? (
        <div className="ph-note">keter 无 bid 指标数据</div>
      ) : (
        <div className="bm-grid">
          <MetricPanel title="Bid Simulation 耗时" sub={`p50 · ${hours}h · ${d.sim.length} 节点`} series={d.sim} unit="ms" />
          <MetricPanel title="Best Bid GasUsed" sub={`${hours}h · ${d.gas.length} 节点`} series={d.gas} unit="M" />
        </div>
      )}
    </div>
  );
}
