import { useEffect, useRef, useState } from "react";
import { aiRequest } from "../lib/ai.js";
import { AiText } from "../components/PanelAi.jsx";

const API = import.meta.env.VITE_API_BASE ?? "";
const fmtT = (t) => { const d = new Date(t); return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; };
const fmtDay = (t) => { const d = new Date(t); return `${d.getMonth()+1}/${d.getDate()}`; };

// ── 通用小时级面积图:渐变填充 + 网格 + Y刻度 + 阈值线 + 超阈高亮 + hover 十字 ──
// maxValues:分钟级峰值包络(小时内 max_over_time),细虚线叠加 —— 瞬时打满在均值线上看不见
function HourlyChart({ times, values, maxValues = null, threshold, color, hotColor = "#ef6a3a", unit = "", label, fmtV = (v) => Math.round(v)?.toLocaleString?.() ?? v }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);   // {i, x}

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
      const n = times?.length ?? 0;
      if (!n) { ctx.fillStyle = "#4a463c"; ctx.font = "10px monospace"; ctx.textAlign = "center"; ctx.fillText("加载中…", W/2, H/2); return; }

      const padL = 44, padR = 10, padT = 8, padB = 18;
      const iw = W - padL - padR, ih = H - padT - padB;
      const vs = values.filter((v) => typeof v === "number");
      const mvs = (maxValues ?? []).filter((v) => typeof v === "number");
      const maxV = Math.max(threshold != null ? threshold * 1.15 : 0, ...vs, ...mvs) * 1.05 || 1;
      const X = (i) => padL + (i / Math.max(n - 1, 1)) * iw;
      const Y = (v) => padT + ih - (v / maxV) * ih;

      // grid + y labels (4 档)
      ctx.font = "8.5px monospace"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      for (let k = 0; k <= 4; k++) {
        const v = (maxV / 4) * k, y = Y(v);
        ctx.strokeStyle = "#191712"; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillStyle = "#5d594e"; ctx.fillText(fmtV(v), padL - 6, y);
      }
      // x labels(按天,自适应密度)
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      let lastDay = "";
      const stepDays = n > 24 * 12 ? 5 : n > 24 * 6 ? 2 : 1;
      let dayIdx = 0;
      times.forEach((t, i) => {
        const dk = fmtDay(t);
        if (dk !== lastDay) {
          lastDay = dk; dayIdx++;
          if (dayIdx % stepDays === 0) {
            ctx.strokeStyle = "#15130e"; ctx.beginPath(); ctx.moveTo(X(i), padT); ctx.lineTo(X(i), padT + ih); ctx.stroke();
            ctx.fillStyle = "#5d594e"; ctx.fillText(dk, X(i), H - padB + 6);
          }
        }
      });

      // 超阈值区段:红色渐变背景
      for (let i = 0; threshold != null && i < n; i++) {
        const v = values[i];
        if (typeof v === "number" && v > threshold) {
          const x0 = i > 0 ? (X(i - 1) + X(i)) / 2 : X(i);
          const x1 = i < n - 1 ? (X(i) + X(i + 1)) / 2 : X(i);
          const g = ctx.createLinearGradient(0, padT, 0, padT + ih);
          g.addColorStop(0, "rgba(239,106,58,.22)"); g.addColorStop(1, "rgba(239,106,58,.03)");
          ctx.fillStyle = g; ctx.fillRect(x0, padT, Math.max(x1 - x0, 2), ih);
        }
      }

      // 面积渐变 + 主线(超阈值段变红)
      const area = ctx.createLinearGradient(0, padT, 0, padT + ih);
      area.addColorStop(0, color + "3a"); area.addColorStop(1, color + "05");
      ctx.beginPath();
      values.forEach((v, i) => { const y = Y(typeof v === "number" ? v : 0); i === 0 ? ctx.moveTo(X(i), y) : ctx.lineTo(X(i), y); });
      ctx.lineTo(X(n - 1), padT + ih); ctx.lineTo(X(0), padT + ih); ctx.closePath();
      ctx.fillStyle = area; ctx.fill();

      ctx.lineWidth = 1.7; ctx.lineJoin = "round";
      if (n === 1 && typeof values[0] === "number") {   // 单点(数据刚开始积累):画点代替线
        ctx.beginPath(); ctx.arc(X(0), Y(values[0]), 3, 0, 7); ctx.fillStyle = color; ctx.fill();
      }
      for (let i = 1; i < n; i++) {
        const v0 = values[i - 1], v1 = values[i];
        if (typeof v0 !== "number" || typeof v1 !== "number") continue;
        const hot = threshold != null && (v0 > threshold || v1 > threshold);
        ctx.strokeStyle = hot ? hotColor : color;
        if (hot) { ctx.shadowColor = hotColor; ctx.shadowBlur = 6; }
        ctx.beginPath(); ctx.moveTo(X(i - 1), Y(v0)); ctx.lineTo(X(i), Y(v1)); ctx.stroke();
        ctx.shadowBlur = 0;
      }

      // 分钟级峰值包络(细虚线):超阈段亮金色,其余同主色淡化
      if (maxValues?.length) {
        ctx.lineWidth = 1; ctx.setLineDash([3, 2]);
        for (let i = 1; i < n; i++) {
          const a = maxValues[i - 1], b = maxValues[i];
          if (typeof a !== "number" || typeof b !== "number") continue;
          const hot = threshold != null && (a > threshold || b > threshold);
          ctx.strokeStyle = hot ? "#ffd34d" : color + "66";
          ctx.beginPath(); ctx.moveTo(X(i - 1), Y(a)); ctx.lineTo(X(i), Y(b)); ctx.stroke();
        }
        ctx.setLineDash([]);
      }

      // 阈值线(threshold=null 时不画,纯走势图模式)
      if (threshold != null) {
        ctx.setLineDash([5, 4]); ctx.strokeStyle = "#ef4444aa"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, Y(threshold)); ctx.lineTo(W - padR, Y(threshold)); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = "#ef8f8f"; ctx.font = "8.5px monospace"; ctx.textAlign = "left";
        ctx.fillText(`阈值 ${fmtV(threshold)}`, padL + 4, Y(threshold) - 6);
      }

      // hover 十字 + 读数
      if (hover != null && hover.i >= 0 && hover.i < n) {
        const i = hover.i, v = values[i];
        ctx.strokeStyle = "#F0B90B66"; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(X(i), padT); ctx.lineTo(X(i), padT + ih); ctx.stroke(); ctx.setLineDash([]);
        if (typeof v === "number") {
          ctx.beginPath(); ctx.arc(X(i), Y(v), 3.2, 0, 7); ctx.fillStyle = "#FFF6D8"; ctx.fill();
          const mv = maxValues?.[i];
          const txt = `${fmtT(times[i])} · ${fmtV(v)}${unit}${typeof mv === "number" ? ` · 峰 ${fmtV(mv)}${unit}` : ""}`;
          ctx.font = "700 9.5px monospace";
          const tw = ctx.measureText(txt).width + 14;
          let bx = X(i) + 8; if (bx + tw > W - 4) bx = X(i) - tw - 8;
          ctx.fillStyle = "rgba(12,11,8,.94)"; ctx.strokeStyle = "#3a2d00";
          ctx.beginPath(); ctx.roundRect(bx, padT + 2, tw, 18, 5); ctx.fill(); ctx.stroke();
          ctx.fillStyle = threshold != null && v > threshold ? "#ffb08a" : "#e8dcb8"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
          ctx.fillText(txt, bx + 7, padT + 11);
        }
      }
    }
    draw();
    const ro = new ResizeObserver(draw); ro.observe(canvas);
    return () => ro.disconnect();
  }, [times, values, maxValues, threshold, color, hover]);

  const onMove = (e) => {
    const canvas = ref.current;
    if (!canvas || !times?.length) return;
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / (canvas.offsetWidth || rect.width) || 1;   // 界面 zoom 系数
    const x = (e.clientX - rect.left) / sx;                            // 换算回设计 px
    const padL = 44, padR = 10;
    const iw = canvas.offsetWidth - padL - padR;
    const i = Math.round(((x - padL) / Math.max(iw, 1)) * (times.length - 1));
    setHover({ i: Math.min(Math.max(i, 0), times.length - 1) });
  };

  return (
    <div className="hc-wrap">
      <div className="hc-label">{label}</div>
      <canvas ref={ref} className="hc-canvas" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
    </div>
  );
}

// ── 流量历史面板:范围切换 + pending/gas 双图 + 事件列表 ──
const RANGES = [[1, "24h"], [5, "5天"], [7, "7天"], [10, "10天"]];

const fmtDur = (ms) => (ms < 3600e3 ? `${Math.max(Math.round(ms / 60e3), 5)}m` : `${+(ms / 3600e3).toFixed(1)}h`);
const fmtBlk = (n) => (n == null ? "?" : "#" + n.toLocaleString());

// 单类大流量事件列表(pending 与 gas 独立展示),每行可触发 AI 归因
// refined = 后端 5m 精化(精确时间 + 区块高度区间);缺失时退回小时桶口径
function EventList({ title, episodes, metric, emptyText, onAnalyze, loading, busyLabel }) {
  return (
    <div className="tf-evgroup">
      <div className="re-title">{title}</div>
      {episodes.length === 0
        ? <div className="re-empty">✓ {emptyText}</div>
        : [...episodes].reverse().map((e) => {
            const busy = loading && busyLabel === `事件归因 ${fmtT(e.start)}`;
            const r = e.refined;
            const startT = r?.precise ? r.startT : e.start;
            const dur = r?.precise && r.endT ? fmtDur(r.endT - r.startT) : `${e.hours ?? 1}h`;
            const tip = r?.precise
              ? `开始 ${fmtT(r.startT)} · 峰值 ${fmtT(r.peakT)}(5m 均值 ${r.peakPending?.toLocaleString?.() ?? "--"})· 恢复 ${fmtT(r.endT)} · 区块 ${fmtBlk(r.startBlock)} ~ ${fmtBlk(r.endBlock)}`
              : `小时桶口径(±1h):开始 ${fmtT(e.start)} · 峰值 ${fmtT(e.peakT)} · 恢复 ${fmtT((e.end ?? e.start) + 3600e3)}${r ? ` · 区块 ${fmtBlk(r.startBlock)} ~ ${fmtBlk(r.endBlock)}` : ""}`;
            const burst = e.kind === "burst";
            return (
              <div key={e.start} className="re-row" title={tip}>
                <span className={`re-sev ${burst ? "re-sev-burst" : "re-sev-watch"}`}>{burst ? "瞬时" : "持续"}</span>
                <span className="re-time">{fmtT(startT)}{r?.precise ? "" : "±"}</span>
                <span className="re-cnt">{metric(e)}</span>
                <span className="re-dur">持续{dur}</span>
                <button className={`tf-ep-btn ${busy ? "busy" : ""}`} disabled={loading} onClick={() => onAnalyze?.(e)}>
                  {busy ? "解读中…↓" : "⚡ AI 解读"}
                </button>
                {r?.startBlock != null && (
                  <span className="re-blocks">区块 {fmtBlk(r.startBlock)} ~ {fmtBlk(r.endBlock)}</span>
                )}
              </div>
            );
          })}
    </div>
  );
}

// ── Top Gas 消耗合约榜:TXN 采样 receipts 真实 gasUsed 聚合,谁在烧 gas 一目了然 ──
const CAT_NAMES = { defi: "DeFi", bot: "Bot", meme: "Meme", token: "Token", infra: "Infra", predict: "预测", bnb: "转账", cex: "CEX", bridge: "跨链", other: "未识别", system: "系统" };
function TopGasPanel() {
  const [days, setDays] = useState(1);
  const [d, setD] = useState(null);
  useEffect(() => {
    let alive = true;
    const pull = () => fetch(API + `/api/traffic/top-gas?days=${days}`).then((r) => r.json()).then((j) => { if (alive) setD(j); }).catch(() => {});
    pull();
    const t = setInterval(pull, 120_000);
    return () => { alive = false; clearInterval(t); };
  }, [days]);
  const rows = d?.rows ?? [];
  const maxGas = rows[0]?.gas || 1;
  return (
    <div className="panel tf-panel">
      <div className="panel-header">
        <span>Top Gas 消耗合约</span>
        <span className="bm-ctls">
          <span className="sub">真实 gasUsed(receipts)· 占比以窗口总消耗为分母</span>
          <span className="tf-ranges">
            {[[1, "24h"], [3, "3天"], [7, "7天"]].map(([v, l]) => (
              <button key={v} className={`tf-range ${days === v ? "on" : ""}`} onClick={() => setDays(v)}>{l}</button>
            ))}
          </span>
        </span>
      </div>
      <div className="panel-body tf-body">
        <div className="tg-list">
          {rows.map((r, i) => (
            <div key={r.addr} className="tg-row" title={r.addr}>
              <span className="tg-rank">{i + 1}</span>
              <a className="tg-name" href={`https://bscscan.com/address/${r.addr}`} target="_blank" rel="noreferrer"
                 title={`${r.addr} · 点击在 BscScan 查看`}>
                {r.name ?? r.addr.slice(0, 12) + "…"}<span className="tg-ext">↗</span>
              </a>
              <span className={`tg-cat tgc-${r.cat}`}>{CAT_NAMES[r.cat] ?? r.cat}</span>
              <span className="tg-bar"><i style={{ width: `${(r.gas / maxGas) * 100}%` }} /></span>
              <span className="tg-share">{r.sharePct != null ? `${r.sharePct}%` : "--"}</span>
              <span className="tg-txs">{r.txs.toLocaleString()} 笔</span>
            </div>
          ))}
          {rows.length === 0 && <div className="re-empty">采样积累中…(数据自部署起累计,最长 7 天)</div>}
        </div>
      </div>
    </div>
  );
}

// ── 多线趋势图(交易类型 gas 份额):网格 + 每类一条线 + hover 全量读数 ──
const CAT_COLORS = { defi: "#3FB8A0", bot: "#E58A55", meme: "#8B7CF6", token: "#F0B90B", bnb: "#6B7A8F", infra: "#5B8FF9", predict: "#D46FA8", cex: "#9AA5B1", bridge: "#7ED0E0", system: "#555C66", other: "#69727D", rest: "#4A5058" };
function MultiLineChart({ times, series, label }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
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
      const n = times?.length ?? 0;
      if (!n) { ctx.fillStyle = "#4a463c"; ctx.font = "10px monospace"; ctx.textAlign = "center"; ctx.fillText("采样积累中…", W / 2, H / 2); return; }
      const padL = 36, padR = 10, padT = 8, padB = 18;
      const iw = W - padL - padR, ih = H - padT - padB;
      const X = (i) => padL + (i / Math.max(n - 1, 1)) * iw;
      const Y = (v) => padT + ih - (Math.min(v, 100) / 100) * ih;
      ctx.font = "8.5px monospace"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      for (let k = 0; k <= 4; k++) {
        const v = 25 * k, y = Y(v);
        ctx.strokeStyle = "#191712"; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillStyle = "#5d594e"; ctx.fillText(`${v}%`, padL - 5, y);
      }
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      let lastDay = "";
      times.forEach((t, i) => {
        const dk = fmtDay(t);
        if (dk !== lastDay) { lastDay = dk; ctx.fillStyle = "#5d594e"; ctx.fillText(dk, X(i), H - padB + 6); }
      });
      ctx.lineWidth = 1.5; ctx.lineJoin = "round";
      for (const [cat, vals] of Object.entries(series ?? {})) {
        ctx.strokeStyle = CAT_COLORS[cat] ?? "#888";
        ctx.beginPath();
        let started = false;
        vals.forEach((v, i) => {
          if (typeof v !== "number") return;
          if (!started) { ctx.moveTo(X(i), Y(v)); started = true; } else ctx.lineTo(X(i), Y(v));
        });
        ctx.stroke();
      }
      if (hover != null && hover.i >= 0 && hover.i < n) {
        const i = hover.i;
        ctx.strokeStyle = "#F0B90B66"; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(X(i), padT); ctx.lineTo(X(i), padT + ih); ctx.stroke(); ctx.setLineDash([]);
        const lines = [fmtT(times[i]), ...Object.entries(series ?? {}).map(([c, vals]) => `${c}: ${vals[i] ?? "--"}%`)];
        ctx.font = "9.5px monospace";
        const tw = Math.max(...lines.map((s) => ctx.measureText(s).width)) + 14;
        const th = lines.length * 13 + 8;
        let bx = X(i) + 8; if (bx + tw > W - 4) bx = X(i) - tw - 8;
        ctx.fillStyle = "rgba(12,11,8,.94)"; ctx.strokeStyle = "#3a2d00";
        ctx.beginPath(); ctx.roundRect(bx, padT + 2, tw, th, 5); ctx.fill(); ctx.stroke();
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        lines.forEach((s, k) => {
          ctx.fillStyle = k === 0 ? "#e8dcb8" : (CAT_COLORS[s.split(":")[0]] ?? "#aaa");
          ctx.fillText(s, bx + 7, padT + 12 + k * 13);
        });
      }
    }
    draw();
    const ro = new ResizeObserver(draw); ro.observe(canvas);
    return () => ro.disconnect();
  }, [times, series, hover]);
  const onMove = (e) => {
    const canvas = ref.current;
    if (!canvas || !times?.length) return;
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / (canvas.offsetWidth || rect.width) || 1;
    const x = (e.clientX - rect.left) / sx;
    const i = Math.round(((x - 36) / Math.max(canvas.offsetWidth - 46, 1)) * (times.length - 1));
    setHover({ i: Math.min(Math.max(i, 0), times.length - 1) });
  };
  return (
    <div className="hc-wrap">
      <div className="hc-label">{label}</div>
      <canvas ref={ref} className="hc-canvas" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
    </div>
  );
}

// ── 最近 3 次大流量 · 涉及合约:每个事件一组,7d 内走 TXN 采样桶(真实 gasUsed) ──
function EpisodeContractsPanel() {
  const [d, setD] = useState(null);
  useEffect(() => {
    let alive = true;
    const pull = () => fetch(API + "/api/traffic/episode-contracts").then((r) => r.json()).then((j) => { if (alive) setD(j); }).catch(() => {});
    pull();
    const t = setInterval(pull, 300_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const eps = d?.episodes ?? [];
  return (
    <div className="panel tf-panel">
      <div className="panel-header">
        <span>最近大流量 · 涉及合约</span>
        <span className="bm-ctls"><span className="sub">最近 3 次事件 · 事件时段按合约 gas 消耗排名 · 点击查合约</span></span>
      </div>
      <div className="panel-body tf-body">
        {eps.length === 0 ? <div className="re-empty">✓ 30d 内无大流量事件</div> : (
          <div className="ec-grid">
            {eps.map((e) => (
              <div key={e.start} className="ec-card">
                <div className="ec-head">
                  <span className={`re-sev ${e.kind === "burst" ? "re-sev-burst" : "re-sev-watch"}`}>{e.kind === "burst" ? "瞬时" : "持续"}</span>
                  <b>{e.timeLocal}</b>
                  <em>{e.trigger?.includes("pending") ? `pending 峰 ${e.peakPending?.toLocaleString()}` : ""}{e.trigger === "pending+gas" || e.trigger === "gas+pending" ? " · " : ""}{e.trigger?.includes("gas") ? `gas 峰 ${e.peakGasPct}%` : ""} · 持续{e.durationMin >= 60 ? `${+(e.durationMin / 60).toFixed(1)}h` : `${e.durationMin}m`}</em>
                </div>
                {e.startBlock != null && <div className="ec-blocks">区块 {fmtBlk(e.startBlock)} ~ {fmtBlk(e.endBlock)}</div>}
                <div className="ec-list">
                  {(e.contracts?.rows ?? []).map((r) => (
                    <div key={r.addr} className="ec-row" title={r.addr}>
                      <a className="tg-name ec-name" href={`https://bscscan.com/address/${r.addr}`} target="_blank" rel="noreferrer" title={`${r.addr} · 点击在 BscScan 查看`}>
                        {r.name ?? r.addr.slice(0, 12) + "…"}<span className="tg-ext">↗</span>
                      </a>
                      <span className={`tg-cat tgc-${r.cat}`}>{CAT_NAMES[r.cat] ?? r.cat}</span>
                      <span className="ec-share">{r.sharePct != null ? `${r.sharePct}%` : "--"}</span>
                    </div>
                  ))}
                  {!(e.contracts?.rows?.length) && <div className="eb-none">事件时段超出采样窗口,暂无合约明细</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 价格与结构:Gas Price 水位(p50/p90)+ 类型 gas 份额趋势 ──
function PriceStructPanel() {
  const [days, setDays] = useState(1);
  const [gp, setGp] = useState(null);
  const [ct, setCt] = useState(null);
  useEffect(() => {
    let alive = true;
    const pull = () => {
      fetch(API + `/api/traffic/gas-price?days=${days}`).then((r) => r.json()).then((j) => { if (alive) setGp(j); }).catch(() => {});
      fetch(API + `/api/traffic/cat-trend?days=${days}`).then((r) => r.json()).then((j) => { if (alive) setCt(j); }).catch(() => {});
    };
    pull();
    const t = setInterval(pull, 120_000);
    return () => { alive = false; clearInterval(t); };
  }, [days]);
  const legend = Object.keys(ct?.series ?? {});
  return (
    <div className="panel tf-panel">
      <div className="panel-header">
        <span>价格与结构</span>
        <span className="bm-ctls">
          <span className="sub">左:块级中位 gas price 的小时 p50(实线)/ p90(虚线) · 右:各类交易 gas 份额</span>
          <span className="tf-ranges">
            {[[1, "24h"], [3, "3天"], [7, "7天"]].map(([v, l]) => (
              <button key={v} className={`tf-range ${days === v ? "on" : ""}`} onClick={() => setDays(v)}>{l}</button>
            ))}
          </span>
        </span>
      </div>
      <div className="panel-body tf-body">
        <div className="ps-grid">
          <HourlyChart times={gp?.times ?? []} values={gp?.p50 ?? []} maxValues={gp?.p90 ?? []} threshold={null}
            color="#F0B90B" unit=" gwei" label="Gas Price 水位(gwei)· 实线 p50 · 虚线 p90"
            fmtV={(v) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : (+v).toFixed(2))} />
          <div className="ps-right">
            <MultiLineChart times={ct?.times ?? []} series={ct?.series ?? {}} label="交易类型 gas 份额(%)" />
            <div className="ps-legend">
              {legend.map((c) => (
                <span key={c} className="ps-leg"><i style={{ background: CAT_COLORS[c] ?? "#888" }} />{CAT_NAMES[c] ?? c}</span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TrafficHistoryPanel({ tl, blockGas }) {
  const [rangeDays, setRangeDays] = useState(7);   // Pending 面板窗口
  const [gasDays, setGasDays] = useState(7);       // Gas 面板窗口(独立,不与上方联动)
  // 事件行「分析」的独立结果区(不依赖已移除的 AI 面板)
  const [ep, setEp] = useState({ loading: false, label: null, text: null, at: null, err: null });

  // 单事件归因;group 决定结果渲染在哪个面板内(pending / gas)
  const runAi = async (body, label, group) => {
    if (ep.loading) return;
    setEp({ loading: true, label, group, text: null, at: null, err: null });
    try {
      const d = await aiRequest("/api/ai/traffic", body);
      if (d.error) setEp({ loading: false, label, group, text: null, at: null, err: d.error });
      else setEp({ loading: false, label, group, text: d.text, at: d.at, err: null });
    } catch (err) { setEp({ loading: false, label, group, text: null, at: null, err: String(err) }); }
  };
  const clearEp = () => setEp({ loading: false, label: null, group: null, text: null, at: null, err: null });
  // 结果块:渲染在触发按钮所在面板内,点了就能看见
  const epResult = (group) => (ep.group === group && (ep.loading || ep.text || ep.err)) ? (
    <div className="tf-ep-result">
      <div className="tf-ep-head">
        <span>🤖 {ep.label}</span>
        {ep.at && <em className="ai-at">{new Date(ep.at).toLocaleTimeString()}</em>}
        {!ep.loading && <button className="tf-ep-close" onClick={clearEp}>×</button>}
      </div>
      {ep.loading && (
        <div className="tf-ai-loading">
          <span className="tf-ai-spin" />
          <span>claude 分析中…{ep.label},链上取证采样历史区块归因合约,约 30–40s</span>
        </div>
      )}
      {ep.err && <div className="ai-err">⚠ {ep.err}</div>}
      {ep.text && <div className="ai-result"><AiText text={ep.text} /></div>}
    </div>
  ) : null;
  const sum = tl?.summary;
  const thr = tl?.threshold ?? 4000;
  const hotPct = tl?.hotPct ?? 90;

  // 24h 瞬时打满卡(≥90% 上限,分钟级口径,与首页大流量卡同源)
  const [fullStat, setFullStat] = useState(null);
  useEffect(() => {
    let alive = true;
    const pull = () => fetch(API + "/api/block-gas?minutes=1440").then((r) => r.json())
      .then((j) => { if (alive) setFullStat({ count: j?.fullCount ?? 0, last: j?.lastFull ?? null }); }).catch(() => {});
    pull();
    const t = setInterval(pull, 120_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // 从 30d hourly 序列切出各自面板所选范围(*Max 为分钟级峰值包络)
  const h = tl?.hourly ?? { times: [], pending: [], gasPct: [], pendingMax: [], gasPctMax: [] };
  const cut = Math.max(h.times.length - rangeDays * 24, 0);
  const times = h.times.slice(cut), pending = h.pending.slice(cut);
  const pendingMax = (h.pendingMax ?? []).slice(cut);
  const gasCut = Math.max(h.times.length - gasDays * 24, 0);
  const gasTimes = h.times.slice(gasCut), gasPct = h.gasPct.slice(gasCut);
  const gasPctMax = (h.gasPctMax ?? []).slice(gasCut);
  // pending 24h 瞬时峰值(分钟级包络近 24 个小时桶)
  const pm24 = (h.pendingMax ?? []).slice(-24).filter((v) => typeof v === "number");
  const pmPeak = pm24.length ? Math.max(...pm24) : null;
  const now = Date.now();
  const inWindow = (e) => now - e.start <= rangeDays * 86400000;
  const inGasWindow = (e) => now - e.start <= gasDays * 86400000;
  const epsInRange = (tl?.episodes ?? []).filter(inWindow);
  const last = tl?.lastEpisode;
  const rangeLabel = rangeDays === 1 ? "24h" : `${rangeDays} 天`;
  const gasLabel = gasDays === 1 ? "24h" : `${gasDays} 天`;

  // 速率:打包 = 近 30m 平均每块 txs ÷ 0.45s;pending 净变化 = 最近两个小时均值差;流入由二者推导
  const lastTxs = (blockGas?.txsize?.values ?? []).filter((v) => typeof v === "number").at(-1);
  const packRate = lastTxs ? Math.round(lastTxs / 0.45) : null;
  const hp = tl?.hourly?.pending ?? [];
  const dPend = hp.length >= 2 && Number.isFinite(hp.at(-1)) && Number.isFinite(hp.at(-2)) ? Math.round(hp.at(-1) - hp.at(-2)) : null;
  const inflow = packRate != null && dPend != null ? Math.round(packRate + dPend / 3600) : null;

  return (
    <>
      {/* 面板一:Gas 利用率历史(均值 + 分钟级峰值包络,瞬时/持续两级事件) */}
      <div className="panel tf-panel">
        <div className="panel-header">
          <span>Gas 利用率历史</span>
          <span className="bm-ctls">
            <span className="sub">上限 {tl?.gasLimitM ?? 55}M</span>
            <span className="tf-ranges">
              {RANGES.map(([d, l]) => (
                <button key={d} className={`tf-range ${gasDays === d ? "on" : ""}`} onClick={() => setGasDays(d)}>{l}</button>
              ))}
            </span>
          </span>
        </div>
        <div className="panel-body tf-body">
          <div className="reorg-chips tf-chips3">
            <div className={`reorg-chip ${fullStat?.count ? "tone-warn" : "tone-ok"}`}>
              <span className="rc-v">{fullStat ? `${fullStat.count} 次` : "--"}</span>
              <span className="rc-l">24h 瞬时打满(≥90%,分钟级)</span>
            </div>
            <div className={`reorg-chip ${fullStat?.last ? "tone-warn" : "tone-ok"}`}>
              <span className="rc-v">{fullStat?.last ? `${fullStat.last.peakPct}%` : "无"}</span>
              <span className="rc-l">{fullStat?.last ? `最近打满 ${fmtT(fullStat.last.startT)} · ${fmtBlk(fullStat.last.block)}` : "24h 内无打满"}</span>
            </div>
            <div className={`reorg-chip ${(sum?.maxGasPct ?? 0) >= hotPct ? "tone-warn" : "tone-ok"}`}><span className="rc-v">{sum?.maxGasPct ?? "--"}%</span><span className="rc-l">30d 峰值利用率(分钟级)</span></div>
          </div>
          <div className="tf-main">
            <HourlyChart times={gasTimes} values={gasPct} maxValues={gasPctMax} threshold={hotPct} color="#3FB8A0" unit="%"
              label={`实线 = 小时均值 · 虚线 = 小时内分钟峰值 · 阈值 ${hotPct}%`} fmtV={(v) => `${Math.round(v)}`} />
            <div className="reorg-events tf-events">
              <EventList
                title={`Gas 高占用事件(≥${hotPct}%)· 近 ${gasLabel}`}
                episodes={(tl?.episodes ?? []).filter((e) => e.trigger?.includes("gas")).filter(inGasWindow)}
                metric={(e) => `${e.peakGasPct}%`}
                emptyText={`近 ${gasLabel} 无 gas≥${hotPct}%`}
                onAnalyze={(e) => runAi({ episodeStart: e.start }, `事件归因 ${fmtT(e.start)}`, "gas")}
                loading={ep.loading} busyLabel={ep.label} />
            </div>
          </div>
          {epResult("gas")}
        </div>
      </div>

      {/* 面板二:Top Gas 消耗合约(谁在烧 gas) */}
      <TopGasPanel />

      {/* 面板三:最近大流量涉及合约 */}
      <EpisodeContractsPanel />

      {/* 面板四:价格与结构(gas price 水位 + 类型份额趋势) */}
      <PriceStructPanel />

      {/* 面板五:TxPool Pending 历史 */}
      <div className="panel tf-panel">
        <div className="panel-header">
          <span>TxPool Pending 历史</span>
          <span className="bm-ctls">
            <span className="tf-ranges">
              {RANGES.map(([d, l]) => (
                <button key={d} className={`tf-range ${rangeDays === d ? "on" : ""}`} onClick={() => setRangeDays(d)}>{l}</button>
              ))}
            </span>
          </span>
        </div>
        <div className="panel-body tf-body">
          <div className="reorg-chips tf-chips3">
            <div className="reorg-chip tone-ok"><span className="rc-v">{sum?.baseline?.toLocaleString() ?? "--"}</span><span className="rc-l">pending 30d 基线</span></div>
            <div className={`reorg-chip ${pmPeak != null && pmPeak > thr ? "tone-warn" : "tone-ok"}`}>
              <span className="rc-v">{pmPeak != null ? pmPeak.toLocaleString() : "--"}</span>
              <span className="rc-l">24h 瞬时峰值(分钟级)</span>
            </div>
            <div className={`reorg-chip ${epsInRange.length ? "tone-warn" : "tone-ok"}`}><span className="rc-v">{epsInRange.length} 次</span><span className="rc-l">{rangeLabel} 内大流量</span></div>
            <div className={`reorg-chip ${last ? "tone-warn" : "tone-ok"}`}>
              <span className="rc-v">{last ? last.peakPending.toLocaleString() : "无"}</span>
              <span className="rc-l">{last ? `最近一次 ${fmtT(last.refined?.precise ? last.refined.peakT : last.peakT)} · ${last.trigger}` : "30d 内无大流量"}</span>
            </div>
          </div>
          {/* 流入/打包/净增长:判断拥堵是否自行消退的关键 */}
          <div className="reorg-chips tf-chips3">
            <div className="reorg-chip tone-ok"><span className="rc-v">{inflow ?? "--"} tx/s</span><span className="rc-l">Tx 流入(推导)</span></div>
            <div className="reorg-chip tone-ok"><span className="rc-v">{packRate ?? "--"} tx/s</span><span className="rc-l">链上打包(30m 均块)</span></div>
            <div className={`reorg-chip ${dPend > 50 ? "tone-warn" : "tone-ok"}`}><span className="rc-v">{dPend != null ? (dPend >= 0 ? "+" : "") + dPend : "--"}</span><span className="rc-l">pending 净变化 / 1h</span></div>
          </div>
          <div className="tf-main">
            <HourlyChart times={times} values={pending} maxValues={pendingMax} threshold={thr} color="#F0B90B"
              label={`实线 = dataseed 小时均值 · 虚线 = 分钟峰值 · 阈值 ${thr.toLocaleString()}`} />
            <div className="reorg-events tf-events">
              <EventList
                title={`Pending 拥堵事件 · 近 ${rangeLabel}`}
                episodes={(tl?.episodes ?? []).filter((e) => e.trigger?.includes("pending")).filter(inWindow)}
                metric={(e) => e.peakPending.toLocaleString()}
                emptyText={`近 ${rangeLabel} 无 pending 拥堵`}
                onAnalyze={(e) => runAi({ episodeStart: e.start }, `事件归因 ${fmtT(e.start)}`, "pending")}
                loading={ep.loading} busyLabel={ep.label} />
            </div>
          </div>
          {epResult("pending")}
        </div>
      </div>
    </>
  );
}

export default function TrafficPage({ state }) {
  const util = state.windowStats?.avgGasUtilPct ?? 0;
  const hotPct = state.trafficTimeline?.hotPct ?? 90;
  const tx = state.txpool;
  const pendingHot = !!tx?.anomalyNow;   // pending 拥堵(独立判断)
  const gasHot = util >= hotPct;         // gas 高占用(独立判断)

  // 当前 vs 30d 基线偏差,避免两个几乎相同的数字并排引起困惑
  const baseline = state.trafficTimeline?.summary?.baseline;
  const dev = tx?.current && baseline ? ((tx.current - baseline) / baseline) * 100 : null;
  const devStr = dev != null ? `${dev >= 0 ? "+" : ""}${dev.toFixed(1)}%` : null;

  return (
    <div className="subpage">
      <div className="subpage-head">
        <div>
          <h1>🌊 流量分析</h1>
          <p>
            pending 拥堵(&gt;4000)与 gas 高占用(≥{hotPct}%)分别统计 · 30d 小时级历史
            <span className="tf-fresh"> · BSC Mainnet · 当前块 #{state.latestBlock?.number?.toLocaleString() ?? "--"} · {state.connected ? "WS 实时" : "WS 断开"}</span>
          </p>
        </div>
      </div>

      <div className="subpage-body">
        <div className="traffic-status2">
          <div className={`traffic-stat ${pendingHot ? "hot" : "ok"}`}>
            <b>{pendingHot ? "⚠ Pending 拥堵" : "✓ Pending 正常"}</b>
            <em>当前 {tx?.current?.toLocaleString() ?? "--"} · 基线 {baseline?.toLocaleString() ?? "--"}{devStr ? ` · 偏差 ${devStr}` : ""}{pendingHot && tx?.threshold ? ` · 阈值 ${tx.threshold.toLocaleString()}` : ""}</em>
          </div>
          <div className={`traffic-stat ${gasHot ? "hot" : "ok"}`}>
            <b>{gasHot ? "⚠ Gas 高占用" : "✓ Gas 正常"}</b>
            <em>Gas 利用率 {util}%{gasHot ? ` ≥ ${hotPct}%` : ` · 阈值 ${hotPct}%`}</em>
          </div>
        </div>

        <TrafficHistoryPanel tl={state.trafficTimeline} blockGas={state.blockGas} />
      </div>
    </div>
  );
}