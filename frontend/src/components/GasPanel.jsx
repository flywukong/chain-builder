import { useEffect, useRef } from "react";

const GAS_LIMIT = 140_000_000;
const ZONES = [
  { pct: 50,  color: "#22c55e", label: "LOW" },
  { pct: 70,  color: "#F0B90B", label: "MED" },
  { pct: 85,  color: "#f97316", label: "HIGH" },
  { pct: 100, color: "#ef4444", label: "SAT" },
];

function zoneColor(pct) {
  if (pct < 50) return "#22c55e";
  if (pct < 70) return "#F0B90B";
  if (pct < 85) return "#f97316";
  return "#ef4444";
}

function zoneLabel(pct) {
  if (pct < 50) return "LOW";
  if (pct < 70) return "MEDIUM";
  if (pct < 85) return "HIGH TRAFFIC";
  return "SATURATED";
}

export default function GasPanel({ gasUsed, windowStats }) {
  const canvasRef = useRef(null);
  const avgUtil   = windowStats?.avgGasUtilPct ?? 0;

  // Flatten series from all datasources
  const series = Object.values(gasUsed ?? {}).flat();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function draw() {
    if (!series.length) return;
    const dpr = window.devicePixelRatio || 1;
    const W   = canvas.offsetWidth;
    const H   = canvas.offsetHeight;
    if (!W || !H) return;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, W, H);

    // Grid lines at 50%, 70%, 85%
    ctx.strokeStyle = "#222";
    ctx.lineWidth   = 1;
    [50, 70, 85].forEach(p => {
      const y = H - (p / 100) * H;
      ctx.beginPath();
      ctx.setLineDash([3, 5]);
      ctx.moveTo(0, y); ctx.lineTo(W, y);
      ctx.stroke();
    });
    ctx.setLineDash([]);

    // Plot each series as a line
    series.forEach((s, si) => {
      const times  = s.times  ?? [];
      const values = s.values ?? [];
      if (!times.length) return;

      const pts = times.map((t, i) => ({
        x: (i / (times.length - 1)) * W,
        y: H - Math.min((values[i] / GAS_LIMIT) * H, H),
      }));

      const hue = si * 47;
      ctx.strokeStyle = `hsl(${hue}, 70%, 55%)`;
      ctx.lineWidth   = 1.2;
      ctx.beginPath();
      pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.stroke();
    });

    // 70% threshold line
    const y70 = H - 0.7 * H;
    ctx.strokeStyle = "#F0B90B44";
    ctx.lineWidth   = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y70); ctx.lineTo(W, y70);
    ctx.stroke();
    ctx.setLineDash([]);
    } // end draw

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [series]);

  const color = zoneColor(avgUtil);
  const label = zoneLabel(avgUtil);

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Gas Utilization</span>
        <span className="sub">200-block avg</span>
      </div>
      <div className="panel-body gas-body">
        <div className="gas-top">
          <GaugeArc pct={avgUtil} color={color} />
          <div className="gas-label-col">
            <div className="gas-pct" style={{ color }}>{avgUtil.toFixed(1)}%</div>
            <div className="gas-zone" style={{ color }}>{label}</div>
            <div className="gas-limit">Limit: {(GAS_LIMIT / 1e6).toFixed(0)}M</div>
          </div>
        </div>
        <canvas ref={canvasRef} className="gas-canvas" />
      </div>
    </div>
  );
}

function GaugeArc({ pct, color }) {
  // Half-circle gauge: left to right across the top
  const r   = 36;
  const cx  = 50;
  const cy  = 42;
  const startAngle = Math.PI;        // left
  const sweepAngle = Math.PI;        // 180° sweep

  const arcPath = (from, sweep) => {
    const to = from + sweep;
    const x1 = cx + r * Math.cos(from);
    const y1 = cy + r * Math.sin(from);
    const x2 = cx + r * Math.cos(to);
    const y2 = cy + r * Math.sin(to);
    const large = sweep > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };

  return (
    <svg width="100" height="50" viewBox="0 0 100 50">
      {/* track */}
      <path d={arcPath(startAngle, sweepAngle)}
        stroke="#252525" strokeWidth="9" fill="none" strokeLinecap="round" />
      {/* fill */}
      {pct > 0 && (
        <path d={arcPath(startAngle, sweepAngle * (pct / 100))}
          stroke={color} strokeWidth="9" fill="none" strokeLinecap="round" />
      )}
      {/* zone ticks at 50%, 70%, 85% */}
      {[50, 70, 85].map(p => {
        const a = startAngle + sweepAngle * (p / 100);
        const i = r - 5, o = r + 3;
        return (
          <line key={p}
            x1={cx + i * Math.cos(a)} y1={cy + i * Math.sin(a)}
            x2={cx + o * Math.cos(a)} y2={cy + o * Math.sin(a)}
            stroke="#555" strokeWidth="1.5" />
        );
      })}
    </svg>
  );
}
