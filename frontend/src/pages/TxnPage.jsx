import { useEffect, useRef, useState } from "react";
import { aiRequest } from "../lib/ai.js";
import { AiText } from "../components/PanelAi.jsx";

const API = import.meta.env.VITE_API_BASE ?? "";

const CAT_META = {
  meme:   { label: "Meme",     color: "#FF6BD5" },
  defi:   { label: "DeFi",     color: "#45B8FF" },
  predict:{ label: "预测市场", color: "#A3E635" },
  bot:    { label: "Bot",      color: "#EF4444" },
  stable: { label: "稳定币合约", color: "#22c55e" },
  bnb:    { label: "BNB 转账", color: "#F0B90B" },
  token:  { label: "代币转账", color: "#9A86F0" },
  cex:    { label: "CEX 充提", color: "#22d3ee" },
  bridge: { label: "Bridge",   color: "#f97316" },
  infra:  { label: "Infra/Builder", color: "#7C93B0" },
  system: { label: "系统交易", color: "#7a6a35" },
  other:  { label: "其他",     color: "#8A8F99" },
};
const CAT_KEYS = Object.keys(CAT_META);
const TAIL_COLOR = "#5a5648";   // top5 之外的长尾统一灰

const CAT_INFO = {
  token: "标准 ERC20 transfer/transferFrom，或仅产生 Transfer 事件的合约调用(批量分发/游戏/claim 等)。稳定币单独统计,不计入此类。",
  stable: "仅直接调用已知稳定币合约(USDT/USDC/BUSD/DAI 等)的交易计入,优先于代币转账。DeFi swap 中涉及稳定币仍归 DeFi。",
  bot: "单块内同一发送方 ≥3 笔的高频合约调用,或 gas 优化短 selector 的 MEV 机器人。纯转账/标准 transfer 即使高频也不计入。",
};

function InfoTip({ text }) {
  return <span className="info-tip" tabIndex={0}>ⓘ<span className="info-pop">{text}</span></span>;
}

// 环比变化(百分点):正绿负红,无数据显示 —
function Delta({ v }) {
  if (v == null) return <span className="txn-delta dim">—</span>;
  const cls = v > 0 ? "up" : v < 0 ? "down" : "dim";
  return <span className={`txn-delta ${cls}`}>{v > 0 ? "+" : ""}{v}pp</span>;
}

// 7 天分类堆叠柱状图(每日归一化到 100%;top5 用本色、长尾统一灰)
function StackedDaily({ days, order, topSet }) {
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
      if (!days?.length) { ctx.fillStyle = "#4a463c"; ctx.font = "10px monospace"; ctx.textAlign = "center"; ctx.fillText("采样积累中…", W / 2, H / 2); return; }
      const padL = 8, padR = 8, padT = 8, padB = 18;
      const iw = W - padL - padR, ih = H - padT - padB;
      // 25/50/75/100% 网格线
      ctx.strokeStyle = "#1a1712"; ctx.lineWidth = 1;
      [0, 0.25, 0.5, 0.75, 1].forEach((f) => { const y = padT + ih * f; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke(); });
      const n = days.length, slot = iw / n, bw = Math.min(46, slot * 0.62);
      days.forEach((d, i) => {
        const x = padL + slot * (i + 0.5) - bw / 2;
        const total = d.txs || 0;
        if (total > 0) {
          let y = padT + ih;
          order.forEach((c) => {
            const v = d.cats[c]?.n ?? 0;
            if (!v) return;
            const h = (v / total) * ih;
            ctx.fillStyle = topSet.has(c) ? CAT_META[c].color : TAIL_COLOR;
            ctx.beginPath(); ctx.roundRect(x, y - h, bw, Math.max(h, 0.5), 1.5); ctx.fill();
            y -= h;
          });
        }
        ctx.fillStyle = total > 0 ? "#8a8578" : "#3a372f"; ctx.font = "8.5px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(d.day, x + bw / 2, padT + ih + 5);
      });
    }
    draw();
    const ro = new ResizeObserver(draw); ro.observe(canvas);
    return () => ro.disconnect();
  }, [days, order, topSet]);
  return <canvas ref={ref} className="txn-daily-canvas" />;
}

function TxnAiBox() {
  const [s, setS] = useState({ loading: false, text: null, at: null, err: null });
  const run = async () => {
    setS((x) => ({ ...x, loading: true, err: null }));
    try {
      const d = await aiRequest("/api/ai/txn");
      if (d.error) setS({ loading: false, text: null, at: null, err: d.error });
      else setS({ loading: false, text: d.text, at: d.at, err: null });
    } catch (e) { setS({ loading: false, text: null, at: null, err: String(e) }); }
  };
  useEffect(() => {   // 有缓存结果就直接展示
    fetch(API + "/api/ai/txn").then((r) => r.json())
      .then((d) => { if (d?.text) setS({ loading: false, text: d.text, at: d.at, err: null }); })
      .catch(() => {});
  }, []);
  return { s, run };
}

const short = (a) => (a ? a.slice(0, 8) + "…" + a.slice(-4) : "—");

const abbrN = (n) => (n == null ? "" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : "" + n);

// 地址形态一句话提示(未命名地址的身份线索)
const intelHint = (it) => {
  if (!it?.type) return null;
  if (it.type === "EOA") return `EOA${it.nonce != null ? ` · nonce ${abbrN(it.nonce)}` : ""}`;
  if (it.type === "EIP-7702") return "7702 委托钱包";
  return `合约 ${it.codeSize ? it.codeSize + "B" : ""}`.trim();
};

// 分类"依据":为什么规则/AI 给它打了这个分类(证据优先)
const reasonOf = (c) => {
  const it = c.intel || {};
  if (it.verifiedName) return `BscScan: ${it.verifiedName}`;
  if (c.cat === "infra") return "Builder 支付地址";
  if (c.swap > 0) return "含 Swap 事件";
  if (it.type === "EIP-7702") return "7702 委托钱包";
  if (c.cat === "bnb" && it.type === "EOA") return "EOA 空 input 转账";
  if (c.cat === "bot" && it.type === "EOA") return `高频 EOA${it.nonce != null ? ` nonce ${abbrN(it.nonce)}` : ""}`;
  if (c.cat === "bot" && it.type === "EIP-7702") return "7702 自动化钱包";
  if (c.topSel && /^0x000000[0-9a-f]{2}$/.test(c.topSel)) return `gas 优化 selector ${c.topSel}`;
  if (c.topSel) return `selector ${c.topSel}`;
  if (c.xfer > 0) return "Transfer 事件";
  return "行为归类";
};

// 规则化生成的一句运维结论(即时,不依赖 AI):排名 + 显著变化/gas 负载 + 集中合约
function Conclusion({ d }) {
  if (!d?.total24) return null;
  const cats = CAT_KEYS.filter((c) => (d.catCount24?.[c] ?? 0) > 0).sort((a, b) => (d.catPct24[b] ?? 0) - (d.catPct24[a] ?? 0));
  if (!cats.length) return null;
  const L = (c) => CAT_META[c]?.label ?? c;
  const col = (c) => CAT_META[c]?.color ?? "#8A8F99";
  const p = (c) => d.catPct24[c] ?? 0, g = (c) => d.catGasPct24?.[c] ?? 0;
  const tc = (c) => (d.topContracts ?? []).find((x) => x.cat === c);
  const cat = (c) => <b style={{ color: col(c) }}>{L(c)}</b>;
  const seg = [];

  const [c1, c2] = cats;
  seg.push(<>过去 24h {cat(c1)} 笔数占比最高(<b>{p(c1)}%</b>){c2 && <>,{cat(c2)} 次之(<b>{p(c2)}%</b>)</>}。</>);

  // 显著变化(需多日数据):较 7d 日均 |Δ|≥2pp 的最大波动项
  const movers = cats.filter((c) => d.catTrend?.[c]?.dAvg7 != null && Math.abs(d.catTrend[c].dAvg7) >= 2)
    .sort((a, b) => Math.abs(d.catTrend[b].dAvg7) - Math.abs(d.catTrend[a].dAvg7));
  if (movers.length) {
    const m = movers[0], dv = d.catTrend[m].dAvg7, t = tc(m);
    seg.push(<> {cat(m)} 占比 <b>{p(m)}%</b>,较 7d 均值<b style={{ color: dv > 0 ? "#22c55e" : "#ef4444" }}>{dv > 0 ? "上升" : "下降"} {Math.abs(dv)}pp</b>{t && <>,主要集中在 <b>{t.name ?? short(t.addr)}</b></>}。</>);
  } else {
    // 无趋势数据时给 gas 负载视角:笔数占比与 gas 占比背离最大的类
    const heavy = cats.slice().sort((a, b) => (g(b) - p(b)) - (g(a) - p(a)))[0];
    if (heavy && g(heavy) > p(heavy) + 3) {
      const t = tc(heavy);
      seg.push(<> {cat(heavy)} 以 <b>{p(heavy)}%</b> 的笔数消耗了 <b>{g(heavy)}%</b> 的 gas,为链上执行资源主要占用方{t && <>,集中在 <b>{t.name ?? short(t.addr)}</b></>}。</>);
    }
  }
  return (
    <div className="txn-conclusion">
      <span className="tc-ico">📌</span>
      <span>{seg.map((x, i) => <span key={i}>{x}</span>)}</span>
    </div>
  );
}

export default function TxnPage() {
  const [d, setD] = useState(null);
  const [openAddr, setOpenAddr] = useState(null);   // 展开完整地址 + 复制
  const [distMode, setDistMode] = useState("24h");  // 分类分布口径:24h / all(历史累计)
  const { s: ai, run: runAi } = TxnAiBox();

  const clickAddr = (addr) => {
    navigator.clipboard?.writeText(addr).catch(() => {});
    setOpenAddr((x) => (x === addr ? null : addr));
  };

  useEffect(() => {
    let alive = true;
    const pull = () => fetch(API + "/api/txn").then((r) => r.json())
      .then((j) => { if (alive) setD(j); }).catch(() => {});
    pull();
    const t = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const pct = (c) => d?.catPct24?.[c] ?? 0;
  const cnt = (c) => d?.catCount24?.[c] ?? 0;
  const gpct = (c) => d?.catGasPct24?.[c] ?? 0;
  const trend = (c) => d?.catTrend?.[c] ?? {};
  const maxTop = Math.max(1, ...(d?.topContracts ?? []).map((c) => c.n));

  // 分类按 24h 笔数排序,统一用于 图/图例/列表;top5 高亮,其余合并灰
  const catOrder = CAT_KEYS.slice().sort((a, b) => cnt(b) - cnt(a));
  const topCats = catOrder.slice(0, 5).filter((c) => cnt(c) > 0);
  const topSet = new Set(topCats);
  const tailCats = catOrder.filter((c) => cnt(c) > 0 && !topSet.has(c));
  const tailPct = +tailCats.reduce((s, c) => s + pct(c), 0).toFixed(1);
  const listCats = [...topCats, ...tailCats];   // 列表全展开,顺序一致
  const maxTxPct = Math.max(0.1, ...listCats.map(pct));    // 列内归一化,让最大项填满
  const maxGasPct = Math.max(0.1, ...listCats.map(gpct));

  // 最近 7 个自然日内有数据的天(空日不渲染,避免柱子参差)
  const days7 = (() => {
    const map = Object.fromEntries((d?.daily ?? []).map((x) => [x.day, x]));
    const now = new Date(), out = [];
    for (let i = 6; i >= 0; i--) {
      const dt = new Date(now); dt.setDate(now.getDate() - i);
      const key = `${dt.getMonth() + 1}/${dt.getDate()}`;
      if (map[key]?.txs > 0) out.push(map[key]);
    }
    return out;
  })();

  return (
    <div className="subpage txn-page">
      <div className="subpage-head">
        <div>
          <h1>⇄ Txn 分析</h1>
          <p>全量覆盖:每分钟并发抓取过去一分钟全部区块 · 规则 + AI 归类 · 7 天滚动 · 已学习 {d?.learnedLabels ?? 0} 个合约标签</p>
        </div>
        <div className="ai-bar">
          <button className="st-auto-btn ai-cta" onClick={runAi} disabled={ai.loading}>
            {ai.loading ? "分析中… 约 20–30s" : "⚡ AI 流量特征总结"}
          </button>
        </div>
      </div>

      <div className="subpage-body">
        <Conclusion d={d} />
        {ai.err && <div className="ai-err" style={{ maxWidth: 900 }}>⚠ {ai.err}</div>}
        {ai.text && (
          <div className="panel" style={{ maxWidth: 900 }}>
            <div className="panel-header"><span>🤖 AI 流量特征</span><span className="sub">claude code{ai.at ? ` · ${new Date(ai.at).toLocaleTimeString()}` : ""}</span></div>
            <div className="panel-body"><div className="ai-result" style={{ padding: "10px 14px" }}><AiText text={ai.text} /></div></div>
          </div>
        )}

        <div className="stat-cards">
          <div className="stat-card"><div className="sc-v" style={{ color: "var(--gold)" }}>{(d?.total24 ?? 0).toLocaleString()}</div><div className="sc-l">24h 交易(全量)</div></div>
          <div className="stat-card"><div className="sc-v" style={{ color: CAT_META.meme.color }}>{pct("meme")}%</div><div className="sc-l">Meme</div></div>
          <div className="stat-card"><div className="sc-v" style={{ color: CAT_META.defi.color }}>{pct("defi")}%</div><div className="sc-l">DeFi</div></div>
          <div className="stat-card"><div className="sc-v" style={{ color: CAT_META.bot.color }}>{pct("bot")}%</div><div className="sc-l">Bot(高频/夹子)</div></div>
        </div>

        <div className="panel" style={{ maxWidth: 900 }}>
          <div className="panel-header"><span>7 天流量结构</span><span className="sub">每日分类占比(归一化 100%) · 全量</span></div>
          <div className="panel-body txn-daily-body">
            <StackedDaily days={days7} order={listCats} topSet={topSet} />
            <div className="txn-legend">
              {topCats.map((c) => (
                <span key={c} className="txn-leg"><i style={{ background: CAT_META[c].color }} />{CAT_META[c].label} <b>{pct(c)}%</b></span>
              ))}
              {tailCats.length > 0 && (
                <span className="txn-leg"><i style={{ background: TAIL_COLOR }} />其余 {tailCats.length} 类 <b>{tailPct}%</b></span>
              )}
            </div>
          </div>
        </div>

        {(() => {
          // 分布口径切换:24h vs 历史累计(持久化,重启续算)
          const at = distMode === "all" ? d?.allTime : null;
          const dcnt = (c) => (at ? at.catCount?.[c] ?? 0 : cnt(c));
          const dpct = (c) => (at ? at.catPct?.[c] ?? 0 : pct(c));
          const dgpct = (c) => (at ? at.catGasPct?.[c] ?? 0 : gpct(c));
          const rows = CAT_KEYS.filter((c) => dcnt(c) > 0).sort((a, b) => dcnt(b) - dcnt(a));
          const mTx = Math.max(0.1, ...rows.map(dpct));
          const mGas = Math.max(0.1, ...rows.map(dgpct));
          const sinceStr = at?.since ? `${new Date(at.since).getMonth() + 1}/${new Date(at.since).getDate()}` : null;
          return (
            <div className="panel" style={{ maxWidth: 820 }}>
              <div className="panel-header">
                <span>{at ? "历史累计交易类型分布" : "24H 交易类型分布"}</span>
                <span className="txn-dist-ctl">
                  <span className="sub">
                    {at ? `自 ${sinceStr} · ${at.total.toLocaleString()} 笔累计` : `${d?.total24?.toLocaleString() ?? "…"} 笔 · 全量`}
                  </span>
                  <span className="tf-ranges">
                    <button className={`tf-range ${distMode === "24h" ? "on" : ""}`} onClick={() => setDistMode("24h")}>24H</button>
                    <button className={`tf-range ${distMode === "all" ? "on" : ""}`} onClick={() => setDistMode("all")}>历史累计</button>
                  </span>
                </span>
              </div>
              <div className="panel-body txn-dist">
                <div className="txn-dist-head">
                  <span>类别</span>
                  <span className="tdr-r">笔数</span>
                  <span>笔数占比</span>
                  <span>Gas 占比<InfoTip text="按各类交易消耗的 gasUsed 总量占比,反映对区块执行资源的占用(而非笔数)。DeFi swap / 复杂合约调用 gas 重,BNB 转账 / 稳定币转账 gas 轻。gasPrice 相近时≈手续费占比。" /></span>
                  <span className="tdr-r">{at ? "环比" : "环比 vs 7d"}</span>
                </div>
                {rows.map((c) => {
                  const t = trend(c);
                  return (
                    <div key={c} className="txn-dist-row">
                      <span className="tdr-label" style={{ color: CAT_META[c].color }}>
                        {CAT_META[c].label}{CAT_INFO[c] && <InfoTip text={CAT_INFO[c]} />}
                      </span>
                      <span className="tdr-count">{dcnt(c).toLocaleString()}</span>
                      <span className="tdr-metric">
                        <span className="tdr-track"><span className="tdr-fill" style={{ width: `${(dpct(c) / mTx) * 100}%`, background: CAT_META[c].color }} /></span>
                        <span className="tdr-pct">{dpct(c)}%</span>
                      </span>
                      <span className="tdr-metric">
                        <span className="tdr-track"><span className="tdr-fill" style={{ width: `${(dgpct(c) / mGas) * 100}%`, background: CAT_META[c].color, opacity: .55 }} /></span>
                        <span className="tdr-pct">{dgpct(c)}%</span>
                      </span>
                      {at
                        ? <span className="tdr-trend" style={{ color: "var(--dim)" }}>—</span>
                        : <span className="tdr-trend" title={`较昨日 ${t.dYest == null ? "—" : (t.dYest > 0 ? "+" : "") + t.dYest + "pp"} · 较 7d 日均 ${t.dAvg7 == null ? "—" : (t.dAvg7 > 0 ? "+" : "") + t.dAvg7 + "pp"}`}>
                            <Delta v={t.dAvg7} />
                          </span>}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        <div className="panel" style={{ maxWidth: 900 }}>
          <div className="panel-header"><span>24H 热门合约</span><span className="sub">标注(身份) · 分类(行为)+ 依据 · AI 标注带 ✦</span></div>
          <div className="panel-body txn-contracts">
            <div className="txn-crow txn-crow-head">
              <span>标注 / 地址线索</span>
              <span>地址</span>
              <span>分类</span>
              <span>依据</span>
              <span className="tcr-n">笔数</span>
            </div>
            {(d?.topContracts ?? []).map((c) => (
              <div key={c.addr} className="txn-crow">
                <span className="tcr-id">
                  {c.name
                    ? <span className="tcr-name">{c.name}{c.ai && <em className="txn-ai">✦</em>}</span>
                    : <span className="tcr-unnamed">未命名{intelHint(c.intel) && <em className="txn-hint">· {intelHint(c.intel)}</em>}</span>}
                </span>
                <span className={`txn-addr ${openAddr === c.addr ? "open" : ""}`} title={`${c.addr}（点击复制）`} onClick={() => clickAddr(c.addr)}>
                  {openAddr === c.addr ? c.addr : short(c.addr)}
                  {openAddr === c.addr && <em className="txn-copied">✓ 已复制</em>}
                </span>
                <span className="txn-cat" style={{ color: CAT_META[c.cat]?.color ?? "#8A8F99", borderColor: (CAT_META[c.cat]?.color ?? "#8A8F99") + "55" }}>{CAT_META[c.cat]?.label ?? c.cat}</span>
                <span className="tcr-reason">{reasonOf(c)}</span>
                <span className="tcr-n">
                  <span className="tcr-nbar" style={{ width: `${(c.n / maxTop) * 100}%`, background: (CAT_META[c.cat]?.color ?? "#8A8F99") + "55" }} />
                  <b>{c.n.toLocaleString()}</b>
                </span>
              </div>
            ))}
            {!d?.topContracts?.length && <div className="ph-note">数据积累中,几分钟后刷新可见。</div>}
          </div>
        </div>

        <div className="ph-note" style={{ maxWidth: 900 }}>
          管线:每分钟并发抓取过去一分钟全部区块(~133 块,含 receipts)→ 规则分类(知名地址库 / 事件签名 / 21000 gas 纯转账 / 高频合约调用判 bot)→
          未识别热门合约每 2h 交给 AI 归类,结果写入标签库持续积累。全量覆盖,数字为真实笔数。
        </div>
      </div>
    </div>
  );
}
