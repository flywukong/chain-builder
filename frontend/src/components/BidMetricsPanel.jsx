import { useEffect, useRef, useState } from "react";

const API = import.meta.env.VITE_API_BASE ?? "";
const COLORS = ["#F0B90B", "#45B8FF", "#22c55e", "#f97316", "#9A86F0", "#3FB8A0", "#ec4899", "#B6CC52", "#5BC8D8", "#8A8F99"];
const AVG_COLOR = "#FFF6D8";
const OUT_COLOR = "#ef4444";
const OUTLIER_DEV = 0.4;   // 节点均值偏离全体均值 ±40% 判异常

const avgOf = (s) => {
  const v = s.values.filter((x) => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
};

// 平均线(逐点)+ 异常者(均值偏离 >40%)
function analyze(series) {
  if (!series?.length) return { grand: 0, outliers: new Set(), avgSeries: null };
  const nodeAvgs = series.map(avgOf);
  const grand = nodeAvgs.reduce((a, b) => a + b, 0) / nodeAvgs.length;
  const outliers = new Set(series.filter((s, i) => grand > 0 && Math.abs(nodeAvgs[i] - grand) / grand > OUTLIER_DEV).map((s) => s.instance));
  const n = Math.max(...series.map((s) => s.values.length));
  const avgSeries = {
    times: series[0].times,
    values: Array.from({ length: n }, (_, i) => {
      const vs = series.map((s) => s.values[i]).filter((v) => typeof v === "number");
      return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
    }),
  };
  return { grand, outliers, avgSeries };
}

// 多节点时序线:普通线淡化,异常者红粗,平均线亮金最上层
function Lines({ series, unit, avgSeries, outliers }) {
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
      const X = (i, n) => padL + (i / Math.max(n - 1, 1)) * iw;
      const Y = (v) => padT + ih - (v / maxV) * ih;
      ctx.font = "8.5px monospace"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      for (let k = 0; k <= 3; k++) {
        const v = (maxV / 3) * k, y = Y(v);
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
      const drawSeries = (sr, color, width, alpha) => {
        const n = sr.values.length;
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = alpha; ctx.lineJoin = "round";
        ctx.beginPath();
        sr.values.forEach((v, i) => {
          const y = Y(typeof v === "number" ? v : 0);
          i === 0 ? ctx.moveTo(X(i, n), y) : ctx.lineTo(X(i, n), y);
        });
        ctx.stroke();
      };
      // 普通线(淡)→ 异常线(红粗)→ 平均线(亮金,最上层)
      series.forEach((sr, si) => { if (!outliers?.has(sr.instance)) drawSeries(sr, COLORS[si % COLORS.length], 1.1, 0.35); });
      series.forEach((sr) => { if (outliers?.has(sr.instance)) drawSeries(sr, OUT_COLOR, 1.9, 1); });
      if (avgSeries) drawSeries(avgSeries, AVG_COLOR, 2.2, 1);
      ctx.globalAlpha = 1;
    }
    draw();
    const ro = new ResizeObserver(draw); ro.observe(canvas);
    return () => ro.disconnect();
  }, [series, avgSeries, outliers]);
  return <canvas ref={ref} className="bm-canvas" />;
}

function MetricPanel({ title, sub, series, unit }) {
  const { grand, outliers, avgSeries } = analyze(series);
  const sorted = [...(series ?? [])].sort((a, b) => {
    const ao = outliers.has(a.instance) ? 1 : 0, bo = outliers.has(b.instance) ? 1 : 0;
    return bo - ao || avgOf(b) - avgOf(a);   // 异常者置顶,其余按均值降序
  });
  return (
    <div className="panel">
      <div className="panel-header"><span>{title}</span><span className="sub">{sub}</span></div>
      <div className="panel-body bm-body">
        <Lines series={series} unit={unit} avgSeries={avgSeries} outliers={outliers} />
        {series?.length > 0 && (
          <div className="bm-legend">
            <span className="bm-item bm-avg">
              <i style={{ background: AVG_COLOR }} />
              平均 · {series.length} 节点
              <b>{grand.toFixed(1)}{unit}</b>
            </span>
            {sorted.map((s) => {
              const idx = series.indexOf(s);
              const out = outliers.has(s.instance);
              return (
                <span key={s.instance} className={`bm-item ${out ? "bm-out" : ""}`}>
                  <i style={{ background: out ? OUT_COLOR : COLORS[idx % COLORS.length] }} />
                  {out ? "⚠ " : ""}{s.instance}
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
const TIERS = [["cabinet", "Cabinet"], ["candidate", "Candidate"], ["all", "全部"]];

// Bid 指标(keter validator 节点):模拟耗时 p50 + best bid gasUsed
// 默认只看 Cabinet(出块中);平均线亮金,偏离均值 ±40% 的节点红色高亮
export default function BidMetricsPanel() {
  const [d, setD] = useState(null);
  const [hours, setHours] = useState(6);
  const [tier, setTier] = useState("cabinet");
  useEffect(() => {
    let alive = true;
    setD(null);
    const pull = () => fetch(`${API}/api/bid-metrics?hours=${hours}`).then((r) => r.json()).then((j) => { if (alive) setD(j); }).catch(() => {});
    pull();
    const t = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [hours]);

  // tier 过滤;该层无匹配(如 tier 数据缺失)时回退全部
  const pick = (arr) => {
    if (!arr?.length || tier === "all") return arr ?? [];
    const f = arr.filter((s) => s.tier === tier);
    return f.length ? f : arr;
  };
  const sim = pick(d?.sim), gas = pick(d?.gas);
  const tierNote = tier !== "all" && d?.sim?.length && !d.sim.some((s) => s.tier === tier);

  return (
    <div className="bm-wrap">
      <div className="bm-head">
        <span className="bm-title">Bid 指标 · Keter validator 节点</span>
        <span className="bm-ctls">
          <span className="tf-ranges">
            {TIERS.map(([k, label]) => (
              <button key={k} className={`tf-range ${tier === k ? "on" : ""}`} onClick={() => setTier(k)}>{label}</button>
            ))}
          </span>
          <span className="tf-ranges">
            {RANGES.map((h) => (
              <button key={h} className={`tf-range ${hours === h ? "on" : ""}`} onClick={() => setHours(h)}>{h}h</button>
            ))}
          </span>
        </span>
      </div>
      {tierNote && <div className="ph-note">该层无匹配节点(tier 数据待 keter 刷新),已显示全部</div>}
      {d === null ? (
        <div className="ph-note">加载中…(keter 不可达时此区无数据)</div>
      ) : !d?.sim?.length && !d?.gas?.length ? (
        <div className="ph-note">keter 无 bid 指标数据</div>
      ) : (
        <div className="bm-grid">
          <MetricPanel title="Bid Simulation 耗时" sub={`p50 · ${hours}h · ${sim.length} 节点`} series={sim} unit="ms" />
          <MetricPanel title="Best Bid GasUsed" sub={`${hours}h · ${gas.length} 节点`} series={gas} unit="M" />
        </div>
      )}
    </div>
  );
}
