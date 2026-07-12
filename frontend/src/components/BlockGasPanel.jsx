import { useEffect, useRef, useState } from "react";
import { usePanelAi, AiButton, AiResult } from "./PanelAi.jsx";

const last = (s) => { const v = s?.values ?? []; for (let i = v.length - 1; i >= 0; i--) if (typeof v[i] === "number") return v[i]; return null; };
const fmtM = (v) => (v == null ? "--" : (v / 1e6).toFixed(1) + "M");
const fmtT = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

// 采样口径(与后端 GAS_SAMPLE_IPS 一致):两台典型 validator 的均值
const SAMPLE_IPS = ["10.213.32.160", "10.213.32.78"];

// Block Gas — 执行视角:MGas/s 执行吞吐(金,面积)+ 每块 gasUsed(青,独立轴)
export default function BlockGasPanel({ blockGas }) {
  const canvasRef = useRef(null);
  const [hover, setHover] = useState(null);
  const ai = usePanelAi("/api/ai/blockgas");

  const mg = last(blockGas?.mgasps);
  const gu = last(blockGas?.gasused);
  const tx = last(blockGas?.txsize);
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
      const padL = 46, padR = 52, padT = 10, padB = 18;
      const iw = W - padL - padR, ih = H - padT - padB;
      const n = mgS.values.length;
      const X = (i) => padL + (i / Math.max(n - 1, 1)) * iw;

      // 左轴:MGas/s;右轴:Gas/块(M)—— 双轴独立标定
      const mgV = mgS.values.filter((v) => typeof v === "number");
      const mgMax = Math.max(...mgV, 1) * 1.12;
      const Ymg = (v) => padT + ih - (v / mgMax) * ih;
      const guV = (guS?.values ?? []).filter((v) => typeof v === "number");
      const guMax = Math.max(...guV, 1) * 1.12;
      const Ygu = (v) => padT + ih - (v / guMax) * ih;

      // 网格 + 左右轴刻度
      ctx.font = "8.5px monospace"; ctx.textBaseline = "middle";
      for (let k = 0; k <= 4; k++) {
        const y = padT + ih - (k / 4) * ih;
        ctx.strokeStyle = "#191712"; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillStyle = "#8a7a3a"; ctx.textAlign = "right";
        ctx.fillText(Math.round((mgMax / 4) * k), padL - 6, y);
        ctx.fillStyle = "#3FB8A0"; ctx.textAlign = "left"; ctx.globalAlpha = .75;
        ctx.fillText((((guMax / 4) * k) / 1e6).toFixed(0) + "M", W - padR + 6, y);
        ctx.globalAlpha = 1;
      }
      // 轴标题
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillStyle = "#8a7a3a"; ctx.fillText("MGas/s", padL - 40, padT - 8);
      ctx.fillStyle = "#3FB8A0"; ctx.globalAlpha = .75; ctx.fillText("Gas/块", W - padR + 6, padT - 8); ctx.globalAlpha = 1;
      // x 时间(首/中/尾)
      const ts = mgS.times ?? [];
      if (ts.length) {
        ctx.fillStyle = "#5d594e"; ctx.textAlign = "center";
        [[0, 0], [0.5, Math.floor(ts.length / 2)], [1, ts.length - 1]].forEach(([f, i]) =>
          ctx.fillText(fmtT(ts[i]), padL + f * iw, H - padB + 6));
      }

      // MGas/s:金色渐变面积 + 发光主线
      const area = ctx.createLinearGradient(0, padT, 0, padT + ih);
      area.addColorStop(0, "rgba(240,185,11,.28)"); area.addColorStop(1, "rgba(240,185,11,.02)");
      ctx.beginPath();
      mgS.values.forEach((v, i) => { const y = Ymg(typeof v === "number" ? v : 0); i === 0 ? ctx.moveTo(X(i), y) : ctx.lineTo(X(i), y); });
      ctx.lineTo(X(n - 1), padT + ih); ctx.lineTo(X(0), padT + ih); ctx.closePath();
      ctx.fillStyle = area; ctx.fill();
      ctx.strokeStyle = "#F0B90B"; ctx.lineWidth = 1.8; ctx.lineJoin = "round";
      ctx.shadowColor = "#F0B90B"; ctx.shadowBlur = 6;
      ctx.beginPath();
      mgS.values.forEach((v, i) => { const y = Ymg(typeof v === "number" ? v : 0); i === 0 ? ctx.moveTo(X(i), y) : ctx.lineTo(X(i), y); });
      ctx.stroke(); ctx.shadowBlur = 0;

      // Gas/块:青色细线(右轴)
      if (guV.length) {
        ctx.strokeStyle = "rgba(63,184,160,.85)"; ctx.lineWidth = 1.3;
        ctx.beginPath();
        (guS.values ?? []).forEach((v, i) => { const y = Ygu(typeof v === "number" ? v : 0); i === 0 ? ctx.moveTo(X(i), y) : ctx.lineTo(X(i), y); });
        ctx.stroke();
      }

      // hover 十字 + 双值读数
      if (hover != null && hover >= 0 && hover < n) {
        const i = hover;
        ctx.strokeStyle = "#F0B90B66"; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(X(i), padT); ctx.lineTo(X(i), padT + ih); ctx.stroke(); ctx.setLineDash([]);
        const mv = mgS.values[i], gv = guS?.values?.[i];
        if (typeof mv === "number") { ctx.beginPath(); ctx.arc(X(i), Ymg(mv), 3, 0, 7); ctx.fillStyle = "#FFF6D8"; ctx.fill(); }
        const txt = `${ts[i] ? fmtT(ts[i]) : ""} · ${typeof mv === "number" ? Math.round(mv) : "--"} MGas/s · ${typeof gv === "number" ? (gv / 1e6).toFixed(1) : "--"}M/块`;
        ctx.font = "700 9.5px monospace";
        const tw = ctx.measureText(txt).width + 14;
        let bx = X(i) + 8; if (bx + tw > W - padR) bx = X(i) - tw - 8;
        ctx.fillStyle = "rgba(12,11,8,.94)"; ctx.strokeStyle = "#3a2d00";
        ctx.beginPath(); ctx.roundRect(bx, padT + 2, tw, 18, 5); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#e8dcb8"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(txt, bx + 7, padT + 11);
      }
    }
    draw();
    const ro = new ResizeObserver(draw); ro.observe(canvas);
    return () => ro.disconnect();
  }, [blockGas, hover]);

  const onMove = (e) => {
    const canvas = canvasRef.current;
    const n = blockGas?.mgasps?.values?.length;
    if (!canvas || !n) return;
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / (canvas.offsetWidth || rect.width) || 1;   // 界面 zoom 系数
    const x = (e.clientX - rect.left) / sx;
    const padL = 46, padR = 52;
    const iw = canvas.offsetWidth - padL - padR;
    const i = Math.round(((x - padL) / Math.max(iw, 1)) * (n - 1));
    setHover(Math.min(Math.max(i, 0), n - 1));
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Block Gas · 执行视角</span>
        <span className="bm-ctls">
          <span className="sub">典型 validator 均值:{SAMPLE_IPS.join(" · ")} · 30m</span>
          <AiButton ai={ai} />
        </span>
      </div>
      <div className="panel-body bg-body">
        <AiResult ai={ai} title="Block Gas 解读 · 执行负载" />
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
          <span><i style={{ background: "#F0B90B" }} />MGas/s 执行吞吐(左轴)</span>
          <span><i style={{ background: "#3FB8A0" }} />Gas used / 块(右轴)</span>
          <em className="bg-src">曲线为 {SAMPLE_IPS.join(" / ")} 两台典型 validator 节点的 gas 占用均值</em>
        </div>
        <canvas ref={canvasRef} className="bg-canvas" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </div>
    </div>
  );
}
