import { useRef, useEffect } from "react";

const BUILDER_COLORS = {
  blockrazor: "#F0B90B",
  puissant:   "#a855f7",
  blockroute: "#38bdf8",
  jetbldr:    "#22c55e",
  nodereal:   "#f97316",
  txboost:    "#ec4899",
  default:    "#444",
};

function builderColor(builder) {
  if (!builder) return "#333";
  const k = builder.toLowerCase();
  for (const [name, col] of Object.entries(BUILDER_COLORS)) {
    if (k.includes(name)) return col;
  }
  return BUILDER_COLORS.default;
}

export default function BlockRiver({ blocks }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !blocks?.length) return;

    const dpr = window.devicePixelRatio || 1;
    const W   = canvas.offsetWidth;
    const H   = canvas.offsetHeight;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const GAP       = 2;
    const COUNT     = Math.min(blocks.length, Math.floor(W / 6));
    const visible   = blocks.slice(-COUNT);
    const blockW    = Math.floor((W - GAP * (COUNT - 1)) / COUNT);
    const MAX_BT    = 6000; // ms, for block-time height encoding

    visible.forEach((b, i) => {
      const x      = i * (blockW + GAP);
      const gasH   = Math.max(2, ((b.gasUsed ?? 0) / (b.gasLimit || 55e6)) * (H - 12));
      const col    = builderColor(b.builder);
      const isAnom = b.anomaly;

      // Base fill — height = gas used
      ctx.fillStyle = col + (isAnom ? "ff" : "99");
      ctx.fillRect(x, H - gasH, blockW, gasH);

      // Anomaly glow top
      if (isAnom) {
        ctx.fillStyle = "#ef444488";
        ctx.fillRect(x, H - gasH - 3, blockW, 3);
      }

      // MEV indicator dot at top
      if (b.isMev) {
        ctx.fillStyle = "#F0B90B";
        ctx.beginPath();
        ctx.arc(x + blockW / 2, H - gasH - 6, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // Y guide line at 70%
    const y70 = H - 0.7 * (H - 12);
    ctx.strokeStyle = "#F0B90B22";
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath(); ctx.moveTo(0, y70); ctx.lineTo(W, y70); ctx.stroke();
    ctx.setLineDash([]);

  }, [blocks]);

  // Legend
  const builders = Object.entries(BUILDER_COLORS).filter(([k]) => k !== "default");

  return (
    <div className="panel river-panel">
      <div className="panel-header">
        <span>Block River</span>
        <div className="river-legend">
          {builders.map(([name, col]) => (
            <span key={name} className="river-leg-item">
              <span style={{ width: 8, height: 8, background: col, borderRadius: 2, display: "inline-block" }} />
              {name}
            </span>
          ))}
          <span className="river-leg-item">
            <span style={{ width: 8, height: 8, background: "#F0B90B", borderRadius: "50%", display: "inline-block" }} />
            MEV
          </span>
        </div>
        <span className="sub">height = gas used</span>
      </div>
      <div className="panel-body">
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
      </div>
    </div>
  );
}
