import { useEffect, useRef, useState } from "react";
import { GROUPS, ACTIVE_SET, lookupValidator } from "../data/validators.js";
import RobotWidget from "./RobotWidget.jsx";

const cmpVer = (a, b) => { const pa = a.split(".").map(Number), pb = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); return 0; };

// 全网 geth 版本分布(按 validator 去重,来自出块 extraData;最新版绿、落后橙)
function RingVersions({ mevStats }) {
  const [showBehind, setShowBehind] = useState(false);
  const versions = mevStats?.versions ?? [];
  if (!versions.length) return null;
  const total = versions.reduce((s, v) => s + v.n, 0);
  const latest = versions.map((v) => v.ver).reduce((a, b) => (cmpVer(b, a) > 0 ? b : a));
  // 落后名单:minerVersions(地址→版本,值带 v 前缀)里非最新版的 validator,旧版本靠前
  const norm = (s) => (s || "").replace(/^v/i, "");
  const behind = Object.entries(mevStats?.minerVersions ?? {})
    .filter(([, ver]) => norm(ver) && norm(ver) !== latest)
    .map(([addr, ver]) => ({ addr, ver: norm(ver), ...lookupValidator(addr) }))
    .sort((a, b) => cmpVer(a.ver, b.ver));
  return (
    <div className="ring-versions">
      <div className="rv-head">
        <span className="rv-title">出块 validator 版本</span>
        <span className="rv-sub">{total} 个出块 validator · 24h · 来自 extraData</span>
      </div>
      <div className="rv-bar">
        {versions.map((v) => (
          <span key={v.ver} className={`rv-seg ${v.ver === latest ? "latest" : "old"}`} style={{ width: `${v.pct}%` }} title={`v${v.ver} · ${v.n} 验证者 · ${v.pct}%`} />
        ))}
      </div>
      <div className="rv-legend">
        {versions.map((v) => (
          <span key={v.ver} className="rv-item">
            <i className={v.ver === latest ? "latest" : "old"} />v{v.ver} <b>{v.pct}%</b><em>({v.n})</em>
          </span>
        ))}
        {behind.length > 0 && (
          <button className="hp-behind-btn rv-behind-btn" onClick={() => setShowBehind(true)}>
            查看落后版本 validator({behind.length})
          </button>
        )}
      </div>
      {showBehind && (
        <div className="ai-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setShowBehind(false); }}>
          <div className="ai-modal hp-modal">
            <div className="ai-modal-head">
              <span className="hp-modal-title">落后版本 validator · {behind.length}</span>
              <span className="ai-modal-meta">24h 出块 extraData · 最新 v{latest} · 旧版本靠前</span>
              <button className="robot-close" onClick={() => setShowBehind(false)}>×</button>
            </div>
            <div className="hpd-list">
              {behind.map((b) => (
                <div key={b.addr} className="hpd-row">
                  <span className="hpd-num">v{b.ver}</span>
                  <span className="hpd-mid">{b.name}{b.group === "internal" ? " · 内部运营 ⚠" : ""}</span>
                  <span className="hpd-end">{b.addr.slice(0, 10)}…</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── color utils ──
function hx(c){ return { r:parseInt(c.slice(1,3),16), g:parseInt(c.slice(3,5),16), b:parseInt(c.slice(5,7),16) }; }
function rgba(o,a){ return `rgba(${o.r|0},${o.g|0},${o.b|0},${a})`; }
function sc(o,f){ return { r:Math.min(255,o.r*f), g:Math.min(255,o.g*f), b:Math.min(255,o.b*f) }; }

const TILT = 0.5;
const HOP  = 104;

const last = (s) => { const v = s?.values ?? []; for (let i = v.length - 1; i >= 0; i--) if (typeof v[i] === "number") return v[i]; return null; };

// header metric strip — all real: active set / block time / TPS / MEV%
function RingStats({ windowStats, mevStats, blockGas }) {
  const btMs = windowStats?.avgBlockTimeMs;
  const tx = last(blockGas?.txsize);
  const tps = tx && btMs ? Math.round(tx / (btMs / 1000)) : null;
  const mev = mevStats?.mevPct ?? windowStats?.mevPct;
  const cells = [
    { icon: "◈", label: "活跃集合", value: ACTIVE_SET.length, unit: "验证者" },
    { icon: "◷", label: "出块时间", value: btMs ? (btMs / 1000).toFixed(2) : "--", unit: "s" },
    { icon: "⤢", label: "吞吐", value: tps ?? "--", unit: "TPS" },
    { icon: "◆", label: "MEV 占比", value: mev != null ? mev.toFixed(1) : "--", unit: "%", gold: true },
  ];
  return (
    <div className="ring-stats">
      {cells.map((c) => (
        <div key={c.label} className="rs-cell">
          <span className="rs-ico">{c.icon}</span>
          <div className="rs-body">
            <span className={`rs-val ${c.gold ? "rs-gold" : ""}`}>{c.value}<i>{c.unit}</i></span>
            <span className="rs-lbl">{c.label}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ValidatorRing({ latestBlock, windowStats, mevStats, blockGas, slashStatus, recentBlocks }) {
  const canvasRef = useRef(null);
  const propsRef  = useRef({});
  const [wlOpen, setWlOpen] = useState(false);   // 近期工作默认折叠(背景信息,不占实时权重)
  propsRef.current = { latestBlock, windowStats, mevStats, slashStatus, recentBlocks };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const set = ACTIVE_SET;
    const N = set.length;
    let W = 0, H = 0, cx = 0, cy = 0, RX = 0, RY = 0;

    const st = { cur: 0, lastHop: 0, rot: 0, frame: 0, trail: [], dust: [], demoBlk: 0 };
    st.dust = Array.from({ length: 30 }, (_, i) => ({
      a: (i / 30) * Math.PI * 2, r: 70 + Math.random() * 180,
      sp: 0.0005 + Math.random() * 0.0009, s: Math.random() * 1.5 + 0.3,
    }));

    function resize() {
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = W / 2; cy = H * 0.5;
      const visualW = Math.min(W, 1180);
      RX = visualW * 0.32;
      RY = Math.max(Math.min(RX * 0.56, H * 0.34), RX * 0.30);
    }
    resize();
    const ro = new ResizeObserver(resize); ro.observe(canvas);

    const baseAng = (i) => i * (Math.PI * 2 / N) - Math.PI / 2;
    const pos = (ang) => ({ x: cx + RX * Math.cos(ang), y: cy + RY * Math.sin(ang), d: Math.sin(ang) });

    function slashMap() {
      const m = {};
      (propsRef.current.slashStatus ?? []).forEach(v => {
        m[(v.consensusAddr || "").toLowerCase()] = { count: v.slashCount, misdemeanor: v.misdemeanor || 100, felony: v.felony || 350 };
      });
      return m;
    }
    // proposer index from live block miner, else demo auto-cycle
    function liveProposerIdx() {
      const miner = (propsRef.current.latestBlock?.miner || "").toLowerCase();
      if (!miner) return -1;
      return set.findIndex(v => v.addr === miner);
    }

    function orb(x, y, r, baseHex, alpha, active) {
      const base = hx(baseHex);
      ctx.shadowColor = rgba(base, active ? 0.9 : 0.45);
      ctx.shadowBlur = active ? 22 : Math.max(0, r * 1.4);
      const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.45, r * 0.05, x, y, r * 1.08);
      g.addColorStop(0, active ? `rgba(255,250,235,${alpha})` : rgba(sc(base, 1.75), alpha));
      g.addColorStop(0.4, rgba(active ? sc(base, 1.5) : base, alpha));
      g.addColorStop(1, rgba(sc(base, 0.32), alpha));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(x, y, r, 0.25, 1.45);
      ctx.strokeStyle = rgba(sc(base, 1.9), alpha * 0.55); ctx.lineWidth = Math.max(1, r * 0.13); ctx.stroke();
      ctx.beginPath(); ctx.arc(x - r * 0.34, y - r * 0.4, r * 0.26, 0, 7);
      ctx.fillStyle = `rgba(255,255,255,${alpha * 0.7})`; ctx.fill();
    }

    function frame() {
      const f = st.frame++;
      ctx.clearRect(0, 0, W, H);
      // bg
      const bgg = ctx.createRadialGradient(cx, cy, 30, cx, cy, Math.max(W, H) * 0.7);
      bgg.addColorStop(0, "#14110b"); bgg.addColorStop(0.55, "#0b0a08"); bgg.addColorStop(1, "#070605");
      ctx.fillStyle = bgg; ctx.fillRect(0, 0, W, H);

      st.rot += 0.0015;

      // proposer hop: follow live miner if in set, else auto-cycle
      const live = liveProposerIdx();
      if (live >= 0) {
        if (live !== st.cur) { st.cur = live; st.lastHop = f; }
      } else if (f - st.lastHop >= HOP) {
        st.cur = (st.cur + 1) % N; st.lastHop = f; st.demoBlk++;
      }
      const t = Math.min((f - st.lastHop) / HOP, 1);
      const sm = slashMap();

      // dust
      st.dust.forEach(p => {
        p.a += p.sp;
        const x = cx + Math.cos(p.a) * p.r, y = cy + Math.sin(p.a) * p.r * TILT;
        ctx.beginPath(); ctx.arc(x, y, p.s, 0, 7); ctx.fillStyle = "rgba(240,185,11,0.09)"; ctx.fill();
      });

      // orbit band
      ctx.save(); ctx.translate(cx, cy); ctx.scale(1, RY / RX);
      ctx.beginPath(); ctx.arc(0, 0, RX + 22, 0, 7); ctx.strokeStyle = "rgba(240,185,11,0.05)"; ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, RX, 0, 7); ctx.strokeStyle = "#1d1a14"; ctx.lineWidth = 11; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, RX, 0, 7); ctx.strokeStyle = "rgba(240,185,11,0.09)"; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.restore();

      const order = [...Array(N).keys()].sort((a, b) => pos(baseAng(a) + st.rot).d - pos(baseAng(b) + st.rot).d);

      function node(i) {
        const v = set[i];
        const grp = GROUPS[v.group] || GROUPS.independent;
        const ang = baseAng(i) + st.rot, p = pos(ang), df = (p.d + 1) / 2;
        const scl = 0.62 + df * 0.62, alpha = 0.4 + df * 0.6, active = i === st.cur;
        const gc = grp.color, r = (active ? 10 : 7) * scl;
        const sl = sm[v.addr];

        if (active) {
          const pulse = 0.5 + 0.5 * Math.sin(f * 0.13);
          ctx.beginPath(); ctx.arc(p.x, p.y, r + 8 + pulse * 5, 0, 7);
          ctx.strokeStyle = rgba(hx(gc), 0.6); ctx.lineWidth = 2; ctx.stroke();
        }
        orb(p.x, p.y, r, gc, alpha, active);

        // slash 警示环:仅达到 misdemeanor(橙)/接近 felony(红)才画,零星计数不打扰
        if (sl && sl.count >= sl.misdemeanor) {
          ctx.beginPath(); ctx.arc(p.x, p.y, r + 3.5, 0, 7);
          ctx.strokeStyle = sl.count >= sl.felony * 0.8 ? "#EF4444" : "#F97316";
          ctx.lineWidth = 2; ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0;
        }

        const lx = cx + (RX + 16 + df * 8) * Math.cos(ang);
        const ly = cy + (RY + 12 + df * 6) * Math.sin(ang) + (p.d > 0 ? 8 : -5);
        ctx.font = active ? "700 10px monospace" : "8.5px monospace";
        ctx.fillStyle = active ? "#FFF6D8" : rgba(hx(gc), 0.3 + df * 0.5);
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(v.name, lx, ly);
      }

      order.filter(i => pos(baseAng(i) + st.rot).d < 0).forEach(node);

      // beam
      const ap = pos(baseAng(st.cur) + st.rot);
      const gc = (GROUPS[set[st.cur].group] || GROUPS.independent).color, gb = hx(gc);
      const bm = ctx.createLinearGradient(ap.x, ap.y, cx, cy);
      bm.addColorStop(0, rgba(sc(gb, 1.4), 0.55)); bm.addColorStop(1, rgba(gb, 0));
      ctx.strokeStyle = bm; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(ap.x, ap.y); ctx.lineTo(cx, cy); ctx.stroke();

      // particle + trail
      const pang = baseAng((st.cur - 1 + N) % N) + (Math.PI * 2 / N) * t + st.rot, pp = pos(pang);
      st.trail.push({ x: pp.x, y: pp.y }); if (st.trail.length > 16) st.trail.shift();
      st.trail.forEach((tp, idx) => { const a = idx / st.trail.length;
        ctx.beginPath(); ctx.arc(tp.x, tp.y, a * 3, 0, 7); ctx.fillStyle = rgba(sc(gb, 1.4), a * 0.5); ctx.fill(); });
      ctx.shadowColor = rgba(sc(gb, 1.5), 1); ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(pp.x, pp.y, 3.4, 0, 7); ctx.fillStyle = "#FFF6D8"; ctx.fill(); ctx.shadowBlur = 0;

      // core
      const cpulse = 0.5 + 0.5 * Math.sin(f * 0.08);
      const coreR = Math.max(48, Math.min(RX * 0.32, 78)) + cpulse * 9;
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      cg.addColorStop(0, "rgba(255,246,216,0.92)");
      cg.addColorStop(0.22, rgba(sc(gb, 1.3), 0.45));
      cg.addColorStop(0.6, rgba(gb, 0.10));
      cg.addColorStop(1, rgba(gb, 0));
      ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, 7); ctx.fill();

      order.filter(i => pos(baseAng(i) + st.rot).d >= 0).forEach(node);

      // readout
      const P = propsRef.current;
      const blkNum = P.latestBlock?.number ?? (40000000 + st.demoBlk);
      const mev = P.mevStats?.mevPct ?? P.windowStats?.mevPct;   // same 2000-block source as the MEV page
      ctx.textAlign = "center"; ctx.textBaseline = "middle";

      // BSC MAINNET crest — gold, glowing, flanked by hairlines
      const crestA = 0.72 + 0.28 * Math.sin(f * 0.045);
      ctx.font = "700 10.5px monospace";
      ctx.fillStyle = `rgba(240,185,11,${crestA})`;
      ctx.shadowColor = "rgba(240,185,11,.85)"; ctx.shadowBlur = 14;
      ctx.fillText("◆  B S C   M A I N N E T  ◆", cx, cy - 33);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(240,185,11,.28)"; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - 178, cy - 33); ctx.lineTo(cx - 118, cy - 33);
      ctx.moveTo(cx + 118, cy - 33); ctx.lineTo(cx + 178, cy - 33);
      ctx.stroke();

      ctx.shadowColor = "rgba(0,0,0,0.85)"; ctx.shadowBlur = 7;
      ctx.font = "700 23px monospace"; ctx.fillStyle = "#FFF6D8";
      ctx.fillText("#" + blkNum.toLocaleString(), cx, cy - 3);
      ctx.shadowBlur = 0;
      ctx.font = "9px monospace"; ctx.fillStyle = "#8a857c";
      ctx.fillText(mev != null ? `MEV ${mev.toFixed(1)}%` : "", cx, cy + 19);

      // proposer pills: [▶ name] [group]
      const cv = set[st.cur];
      const gName = (GROUPS[cv.group] || GROUPS.independent).name;
      ctx.font = "700 9.5px monospace";
      const t1 = `▶ ${cv.name}`, t2 = gName;
      const w1 = ctx.measureText(t1).width + 22, w2 = ctx.measureText(t2).width + 22;
      const ph = 19, pgap = 8, py = cy + 28;
      let px = cx - (w1 + pgap + w2) / 2;
      const pill = (x, w, txt, hot) => {
        ctx.beginPath(); ctx.roundRect(x, py, w, ph, 9.5);
        ctx.fillStyle = "rgba(10,9,6,.82)"; ctx.fill();
        ctx.strokeStyle = hot ? rgba(sc(gb, 1.35), 0.95) : "rgba(240,185,11,.4)"; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = hot ? "#FFF6D8" : "#c9b982"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(txt, x + w / 2, py + ph / 2 + 0.5);
      };
      pill(px, w1, t1, true);
      pill(px + w1 + pgap, w2, t2, false);

      // corner HUD
      ctx.textAlign = "left"; ctx.font = "9px monospace"; ctx.fillStyle = "#6b644f";
      ctx.fillText(`活跃集合 · ${N} 个验证者 · 第 ${st.cur + 1} 轮`, 14, 18);

      raf = requestAnimationFrame(frame);
    }

    let raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return (
    <div className="ring-panel">
      <RingStats windowStats={windowStats} mevStats={mevStats} blockGas={blockGas} />
      <canvas ref={canvasRef} className="ring-canvas" />
      <RobotWidget />
      <div className="ring-legend-bar">
        {Object.entries(GROUPS).map(([id, g]) => (
          <span key={id} className="rl-item">
            <span className="rl-orb" style={{ background: `radial-gradient(circle at 35% 30%, ${g.color}, ${g.color} 50%, #000 130%)` }} />
            {g.name}
          </span>
        ))}
      </div>

      {/* 全网版本统计(实时,来自出块 extraData)*/}
      <RingVersions mevStats={mevStats} />

      {/* 近期工作 — 背景信息,默认折叠(不与实时健康同权重) */}
      <div className={`ring-worklog ${wlOpen ? "open" : ""}`}>
        <div className="rw-head" onClick={() => setWlOpen((x) => !x)} role="button">
          <span className="rw-title">近期工作 · Pasteur 硬分叉 <em className="rw-count">BEP-673/675/682/695</em></span>
          <span className="rw-meta">
            <span className="rw-badge rw-draft">Draft</span>
            <span className="rw-caret">{wlOpen ? "▾" : "▸"}</span>
          </span>
        </div>
        {wlOpen && (
          <div className="rw-items">
            <div className="rw-item">
              <span className="rw-chip hf">硬分叉</span>
              <b>BEP-682</b><span className="rw-desc">CometBFT light block 校验拒绝重复 validator</span>
            </div>
            <div className="rw-item">
              <span className="rw-chip hf">硬分叉</span>
              <b>BEP-695</b><span className="rw-desc">Staking / 治理安全加固</span>
            </div>
            <div className="rw-item">
              <span className="rw-chip nohf">免硬分叉</span>
              <b>BEP-675</b><span className="rw-desc">Builder 出块 + Validator 盲签 · SendBidBlock 于 Pasteur 激活后经 RPC 启用</span>
            </div>
            <a className="rw-link" href="https://github.com/bnb-chain/BEPs/blob/master/BEPs/BEP-673.md" target="_blank" rel="noreferrer">BEP-673 spec ↗</a>
          </div>
        )}
      </div>
    </div>
  );
}
