import { useEffect, useRef, useState } from "react";
import AiButton from "../components/AiButton.jsx";
import { INSPECT_META, INSPECT_GROUPS, STATE_HISTORY } from "../data/storageInspect.js";

const fmtSize = (g) =>
  g >= 1024 ? (g / 1024).toFixed(2) + " TiB"
  : g >= 1  ? g.toFixed(g >= 100 ? 0 : 2) + " GiB"
  : (g * 1024).toFixed(1) + " MiB";
const fmtItems = (n) => n.toLocaleString();

function GrowthTable({ title, rows, unit }) {
  return (
    <div className="st-gtable">
      <div className="st-gtitle">{title}</div>
      {rows.map((r) => (
        <div key={r.d} className="st-grow">
          <span className="st-gd">{r.d}</span>
          <span className="st-gv">{r.v}{unit}</span>
          <span className="st-gdelta">{r.delta ?? "—"}</span>
        </div>
      ))}
    </div>
  );
}


// ── DB Compaction / Write Stall(pebble · 典型节点,keter 实时)──
const IP_COLORS = ["#3FB8A0", "#F0B90B", "#9A86F0"];

function MultiLine({ series, unit }) {
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
      if (!series?.length) { ctx.fillStyle="#4a463c"; ctx.font="10px monospace"; ctx.textAlign="center"; ctx.fillText("加载中…", W/2, H/2); return; }
      const padL = 36, padR = 8, padT = 6, padB = 16;
      const iw = W - padL - padR, ih = H - padT - padB;
      const all = series.flatMap((s) => s.values.filter((v) => typeof v === "number"));
      const maxV = Math.max(...all, 0.1) * 1.1;
      // grid + y
      ctx.font = "8.5px monospace"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      for (let k = 0; k <= 3; k++) {
        const v = (maxV / 3) * k, y = padT + ih - (v / maxV) * ih;
        ctx.strokeStyle = "#191712"; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillStyle = "#5d594e"; ctx.fillText(v.toFixed(v < 10 ? 1 : 0) + unit, padL - 5, y);
      }
      // x labels:首/中/尾
      const t0 = series[0].times;
      if (t0?.length) {
        ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "#5d594e";
        [[0, 0], [0.5, Math.floor(t0.length / 2)], [1, t0.length - 1]].forEach(([f, i]) => {
          const d = new Date(t0[i]);
          ctx.fillText(`${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`, padL + f * iw, H - padB + 5);
        });
      }
      series.forEach((sr, si) => {
        const n = sr.values.length;
        ctx.strokeStyle = IP_COLORS[(sr.colorIdx ?? si) % IP_COLORS.length]; ctx.lineWidth = sr.dash ? 1.2 : 1.6; ctx.lineJoin = "round";
        ctx.setLineDash(sr.dash ? [4, 3] : []);
        ctx.beginPath();
        sr.values.forEach((v, i) => {
          const x = padL + (i / Math.max(n - 1, 1)) * iw;
          const y = padT + ih - ((typeof v === "number" ? v : 0) / maxV) * ih;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      });
    }
    draw();
    const ro = new ResizeObserver(draw); ro.observe(canvas);
    return () => ro.disconnect();
  }, [series]);
  return <canvas ref={ref} className="db-canvas" />;
}

const DB_RANGES = [6, 12, 24, 72];

function DbStatsPanel() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [hours, setHours] = useState(24);
  useEffect(() => {
    setD(null);
    fetch(`/api/db-stats?hours=${hours}`).then((r) => r.json()).then(setD).catch((e) => setErr(String(e)));
  }, [hours]);
  const allStallZero = d?.stall?.every((s) => s.values.every((v) => !v))
    && d?.stallDur?.every((s) => s.values.every((v) => !v));
  return (
    <div className="panel st-db-panel">
      <div className="panel-header">
        <span>DB Compaction / Write Stall</span>
        <span className="tf-ranges">
          {DB_RANGES.map((h) => (
            <button key={h} className={`tf-range ${hours === h ? "on" : ""}`} onClick={() => setHours(h)}>{h}h</button>
          ))}
        </span>
      </div>
      <div className="panel-body st-db-body">
        {err && <div className="ai-err">⚠ {err}</div>}
        <div className="reorg-chips db-chips">
          {(d?.nodes ?? []).map((n, i) => (
            <div key={n.instance} className={`reorg-chip ${n.stallN > 0 ? "tone-warn" : "tone-ok"}`}>
              <span className="rc-v" style={{ color: IP_COLORS[i % IP_COLORS.length] }}>{n.instance}</span>
              <span className="rc-l">disk {n.diskTB ?? "--"}TB · stall {n.stallN ?? "--"} 次/{n.stallSec ?? "--"}s · L0/非L0 {n.level0 ?? "--"}/{n.nonlevel0 ?? "--"}</span>
            </div>
          ))}
        </div>
        <div className="hc-wrap">
          <div className="hc-label">DB 处于 Compaction 的时间占比 —— 每秒有多少 ms 在做 compaction(rate 5m)</div>
          <MultiLine series={d?.busy} unit="%" />
        </div>
        <div className="db-stall-row">
          <div className="db-stall-head">
            Write Stall · 写入停顿{allStallZero ? <span className="db-stall-ok"> ✓ {hours}h 无 stall</span> : ""}
          </div>
          <div className="db-charts">
            <div className="hc-wrap">
              <div className="hc-label">次数 · increase(writedelay_counter[5m])</div>
              <MultiLine series={d?.stall} unit=" 次" />
            </div>
            <div className="hc-wrap">
              <div className="hc-label">时长 · increase(writedelay_duration[5m])</div>
              <MultiLine series={d?.stallDur} unit="ms" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function StoragePage() {
  const [notice, setNotice] = useState(false);
  const stateLast = STATE_HISTORY.total.at(-1);
  const snapLast = STATE_HISTORY.snapshot.at(-1);
  const nonLast = STATE_HISTORY.nonSnapshot.at(-1);
  const maxRow = Math.max(...INSPECT_GROUPS.flatMap((g) => g.rows.map((r) => r.sizeGiB)));

  const runAuto = () => {
    setNotice(true);
    clearTimeout(runAuto._t);
    runAuto._t = setTimeout(() => setNotice(false), 6000);
  };

  return (
    <div className="subpage">
      <div className="subpage-head">
        <div>
          <h1>💾 存储分析</h1>
          <p>geth db inspect 全表 · compaction / write stall · state 增长对比 · 扫描 {INSPECT_META.scannedAt}</p>
        </div>
        <div className="ai-bar">
          <button className="st-auto-btn" onClick={runAuto}>⚡ 自动分析 · db inspect</button>
          <AiButton deep />
        </div>
      </div>

      <div className="subpage-body">
        {notice && (
          <div className="st-notice">
            🔧 自动分析建设中：将支持远程在节点执行 <code>geth db inspect</code> → 解析生成下表 → 自动与上月扫描对比增长并归因。当前数据为手动扫描（{INSPECT_META.scannedAt}）。
          </div>
        )}
        {/* 总览 */}
        <div className="stat-cards st-cards">
          <div className="stat-card"><div className="sc-v" style={{ color: "var(--gold)" }}>{INSPECT_META.totalTiB} TiB</div><div className="sc-l">DB 总量 · {INSPECT_META.totalItems} items</div></div>
          <div className="stat-card"><div className="sc-v" style={{ color: "#3FB8A0" }}>{stateLast.v} TiB</div><div className="sc-l">State 合计 · {stateLast.delta}</div></div>
          <div className="stat-card"><div className="sc-v" style={{ color: "#3FB8A0" }}>{snapLast.v} GiB</div><div className="sc-l">Snapshot · {snapLast.delta}(storage 占 93%)</div></div>
          <div className="stat-card"><div className="sc-v">{nonLast.v} GiB</div><div className="sc-l">Trie+Code+状态历史 · {nonLast.delta}</div></div>
        </div>

        <DbStatsPanel />

        {/* db inspect 全表 */}
        <div className="panel st-inspect-panel">
          <div className="panel-header"><span>DB Inspect 明细</span><span className="sub">{INSPECT_META.scannedAt} · 零值/未启用类目已省略</span></div>
          <div className="panel-body st-inspect-body">
            {INSPECT_GROUPS.map((g) => (
              <div key={g.db} className="st-group">
                <div className="st-group-title">{g.db}</div>
                {g.rows.map((r) => (
                  <div key={r.cat} className="st-row">
                    <span className="st-cat">{r.cat}</span>
                    <div className="st-bar-track">
                      <div className="st-bar" style={{ width: `${Math.max((r.sizeGiB / maxRow) * 100, 0.4)}%`,
                        background: r.sizeGiB > 400 ? "var(--gold)" : r.sizeGiB > 30 ? "#c99b18" : "#3FB8A0" }} />
                    </div>
                    <span className="st-size">{fmtSize(r.sizeGiB)}</span>
                    <span className="st-items">{fmtItems(r.items)}</span>
                  </div>
                ))}
              </div>
            ))}
            <div className="st-total-row">
              <span>TOTAL</span><span>{INSPECT_META.totalTiB} TiB</span><span>{INSPECT_META.totalItems}</span>
            </div>
          </div>
        </div>

        {/* 增长分析:环比结论 + 三张对比表 + 投影图 */}
        <div className="panel st-growth-panel">
          <div className="panel-header"><span>State 数据增长 · 环比</span><span className="sub">月增按扫描区间折算</span></div>
          <div className="panel-body st-growth-body">
            <div className="st-verdict">
              最近区间(04-07 → 06-23)月增 <b>+49 GiB</b>,较上一区间(+39)回升 <b>+26%</b>;
              snapshot 增速平稳(+16/月),增量主要来自纯 trie + 状态历史(+34/月)。
              按当前速率,<b>12 个月后 state ≈ 2.12 TiB</b>,24 个月 ≈ 2.70 TiB。
            </div>
            <div className="st-gtables">
              <GrowthTable title="State 合计 (TiB)" rows={STATE_HISTORY.total} unit="" />
              <GrowthTable title="Snapshot (GiB)" rows={STATE_HISTORY.snapshot} unit="" />
              <GrowthTable title="非 Snapshot (GiB)" rows={STATE_HISTORY.nonSnapshot} unit="" />
            </div>
          </div>
        </div>

        <div className="ph-note">
          数据源:手动脚本 <code>geth db inspect</code>(扫描 {INSPECT_META.scannedAt})。
          「自动分析」按钮(v1.1):远程节点执行 inspect → 解析生成本表 → 自动与上月扫描对比增长并归因(哪些类目在涨)。
        </div>
      </div>
    </div>
  );
}
