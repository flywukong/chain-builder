import { useEffect, useRef, useState } from "react";
import { aiRequest } from "../lib/ai.js";
import { AiText, usePanelAi, AiButton, AiResult } from "../components/PanelAi.jsx";
import RobotWidget from "../components/RobotWidget.jsx";

const API = import.meta.env.VITE_API_BASE ?? "";

// 分类色只用于图表识别:柔和低饱和色板,不与状态红绿/品牌黄冲突(Bot 不用红)
const CAT_META = {
  meme:   { label: "Meme",     color: "#C875B2" },
  defi:   { label: "DeFi",     color: "#4CA4D9" },
  predict:{ label: "预测市场", color: "#8FAE5D" },
  bot:    { label: "Bot",      color: "#E58A55" },
  stable: { label: "稳定币合约", color: "#37A89A" },
  bnb:    { label: "BNB 转账", color: "#D6A82F" },
  token:  { label: "代币转账", color: "#8B7CF6" },
  cex:    { label: "CEX 充提", color: "#5FA8C7" },
  bridge: { label: "Bridge",   color: "#B08968" },
  infra:  { label: "Infra/Builder", color: "#7890A8" },
  system: { label: "系统交易", color: "#8A8471" },
  other:  { label: "其他",     color: "#747D88" },
};
const CAT_KEYS = Object.keys(CAT_META);
const TAIL_COLOR = "#5a5648";   // top5 之外的长尾统一灰

// v2 activity(互斥,行为证据判定;地址标签不参与)
const ACT_META = {
  swap:    { label: "Swap",     color: "#4CA4D9" },
  token:   { label: "Token 事件/调用", color: "#8B7CF6" },
  native:  { label: "BNB 转账", color: "#D6A82F" },
  predict: { label: "预测市场", color: "#8FAE5D" },
  bridge:  { label: "Bridge",   color: "#B08968" },
  deploy:  { label: "合约部署", color: "#7890A8" },
  receipt_missing: { label: "Receipt 缺失", color: "#A86F45" },
  failed_unknown: { label: "失败调用(未识别)", color: "#B45A62" },
  other:   { label: "其他调用", color: "#747D88" },
};
const spanLabel = (hours) => {
  const h = Math.max(0, Number(hours) || 0);
  if (h < 24) return `${+h.toFixed(1)}小时`;
  return `${+(h / 24).toFixed(1)}天`;
};

// v2 主面板:一条互斥行为分布 + 三组可重叠特征。把口径和质量放在图前面。
function DimPanel({ dim, collector, range, setRange }) {
  const [metric, setMetric] = useState("tx");
  if (!dim?.total) {
    const available = dim?.meta?.availableContinuousHours ?? 0;
    return (
      <div className="panel txn-dim-panel" style={{ maxWidth: 1230 }}>
        <div className="panel-header">
          <span>交易行为与特征(V2)</span>
          <span className="tf-ranges">
            {[["1", "24H"], ["3", "3天"], ["7", "7天"], ["30", "30天"]].map(([v, label]) => (
              <button key={v} className={`tf-range ${range === v ? "on" : ""}`} disabled={available < Number(v) * 24 && range !== v} onClick={() => setRange(v)}>{label}</button>
            ))}
          </span>
        </div>
        <div className="panel-body"><div className="txn-window-empty">当前版本尚无可用连续数据。请求窗口 {range === "1" ? "24H" : `${range}天`}，实际连续覆盖 <b>{spanLabel(available)}</b>；统计不会用旧版本、时间边界不明或缺口前的数据补齐。{collector?.lastError && <> 最近错误：<b>#{collector.lastError.height} {collector.lastError.error}</b>。</>}</div></div>
      </div>
    );
  }
  const sysN = dim.acts.system?.n ?? 0;
  const bizTotal = dim.denominators?.businessTx ?? (dim.total - sysN);
  const gasTotal = Object.entries(dim.acts).reduce((s, [k, v]) => s + (k === "system" ? 0 : v.gas || 0), 0);
  const rows = Object.keys(ACT_META).filter((k) => dim.acts[k]?.n > 0)
    .sort((a, b) => (dim.acts[b]?.n ?? 0) - (dim.acts[a]?.n ?? 0));
  const pct = (k) => (bizTotal ? +(((dim.acts[k]?.n ?? 0) / bizTotal) * 100).toFixed(1) : 0);
  const gpct = (k) => (gasTotal ? +(((dim.acts[k]?.gas ?? 0) / gasTotal) * 100).toFixed(1) : 0);
  const shownPct = metric === "gas" ? gpct : pct;
  const cov = (n) => (bizTotal ? +((n / bizTotal) * 100).toFixed(1) : 0);
  const sinceStr = dim.since ? new Date(dim.since).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  const coverage = dim.meta?.coveragePct;
  const windowCoverage = dim.meta?.windowCoveragePct ?? 0;
  const windowReady = !!dim.meta?.windowReady;
  const available = dim.meta?.availableContinuousHours ?? 0;
  const receiptsKnown = dim.denominators?.receiptKnownTx ?? Math.max(0, dim.total - (dim.qual?.rcptMiss ?? 0));
  const receiptPct = dim.total ? +((receiptsKnown / dim.total) * 100).toFixed(2) : 0;
  const successPct = dim.total ? +(((dim.total - (dim.qual?.failed ?? 0)) / dim.total) * 100).toFixed(2) : 0;
  const backlog = collector?.backlogBlocks;
  const covRow = (label, color, n, tip) => (
    <div className="txn-cov-row" key={label}>
      <span className="tcv-l" style={{ color }}>{label}{tip && <InfoTip text={tip} />}</span>
      <span className="tdr-track"><span className="tdr-fill" style={{ width: `${Math.min(cov(n), 100)}%`, background: color }} /></span>
      <span className="tcv-v">{cov(n)}%<em>{(n ?? 0).toLocaleString()}</em></span>
    </div>
  );
  return (
    <div className="panel txn-dim-panel" style={{ maxWidth: 1230 }}>
      <div className="panel-header">
        <span>交易行为与特征(V2)</span>
        <span className="txn-dist-ctl">
          <span className="sub">请求 {range === "1" ? "24H" : `${range}天`} · 实际连续 {spanLabel(dim.meta?.effectiveHours)} · 自 {sinceStr}</span>
          <span className="tf-ranges">
            {[["1", "24H"], ["3", "3天"], ["7", "7天"], ["30", "30天"]].map(([v, label]) => (
              <button key={v} className={`tf-range ${range === v ? "on" : ""}`} disabled={available < Number(v) * 24 && range !== v} title={available < Number(v) * 24 ? `当前仅连续覆盖 ${spanLabel(available)}` : ""} onClick={() => setRange(v)}>{label}</button>
            ))}
          </span>
        </span>
      </div>
      <div className="panel-body">
        <div className="txn-quality-strip">
          <span><em>窗口就绪</em><b className={windowReady ? "ok" : "warn"}>{windowReady ? "是" : `否 · ${windowCoverage}%`}</b></span>
          <span><em>采集连续性</em><b className={coverage == null ? "warn" : coverage >= 99.9 ? "ok" : "bad"}>{coverage == null ? "待建立" : `${coverage}%`}</b></span>
          <span><em>Receipt 完整</em><b className={receiptPct >= 99.99 ? "ok" : "bad"}>{receiptPct}%</b></span>
          <span><em>执行成功</em><b>{successPct}%</b></span>
          <span><em>业务交易</em><b>{bizTotal.toLocaleString()}</b></span>
          <span><em>采集积压</em><b className={backlog > 0 ? "warn" : "ok"}>{backlog == null ? "—" : `${backlog.toLocaleString()} 块`}</b></span>
          {collector?.lastError && <span className="txn-quality-error" title={collector.lastError.error}><em>最近错误</em><b>#{collector.lastError.height}</b></span>}
          {collector?.stateError && <span className="txn-quality-error" title={collector.stateError}><em>水位写盘</em><b>失败</b></span>}
          {collector?.storeError && <span className="txn-quality-error" title={collector.storeError}><em>统计落盘</em><b>失败</b></span>}
        </div>

        <div className="txn-activity-stack" aria-label="交易行为百分比分布">
          {rows.map((k) => <i key={k} title={`${ACT_META[k].label} ${pct(k)}%`} style={{ width: `${pct(k)}%`, background: ACT_META[k].color }} />)}
        </div>

        <div className="txn-dim-body">
          <div className="txn-dim-left">
            <div className="txn-dim-section-head">
              <span>主行为<InfoTip text="每笔交易只选一个 primary activity。依据当笔 input/receipt/logs 判定；地址标签仅提供候选协议/角色，不能直接决定行为。分母不含系统交易。" /></span>
              <span className="txn-metric-toggle">
                <button className={metric === "tx" ? "on" : ""} onClick={() => setMetric("tx")}>笔数</button>
                <button className={metric === "gas" ? "on" : ""} onClick={() => setMetric("gas")}>Gas</button>
              </span>
            </div>
            <div className="txn-action-head"><span>类型</span><span>笔数</span><span>{metric === "gas" ? "Gas 占比" : "笔数占比"}</span></div>
            {rows.map((k) => (
              <div key={k} className="txn-action-row">
                <span className="tdr-label" style={{ color: ACT_META[k].color }}><i style={{ background: ACT_META[k].color }} />{ACT_META[k].label}</span>
                <span className="tdr-count">{(dim.acts[k]?.n ?? 0).toLocaleString()}</span>
                <span className="tdr-metric">
                  <span className="tdr-track"><span className="tdr-fill" style={{ width: `${Math.min(shownPct(k), 100)}%`, background: ACT_META[k].color }} /></span>
                  <span className="tdr-pct">{shownPct(k)}%</span>
                </span>
              </div>
            ))}
            <div className="txn-dim-sys">系统交易 {sysN.toLocaleString()} 笔单列,不进入上方业务行为分母；失败交易按已观察到的动作归类,无法确认时进入“失败调用”。</div>
          </div>

          <div className="txn-dim-right">
            <div className="txn-feature-group">
              <div className="tcv-title">自动化特征(非 Bot 总量)</div>
              {covRow("疑似自动化", "#E58A55", dim.parts.bot ?? 0, "短 selector 或同块同发送方 ≥3 笔合格合约调用；只表示规则命中率，既有误报也有漏报。")}
              {covRow("MEV 风险标命中", "#D96A6A", dim.parts.mev_bot ?? 0, "发送方命中 Label Cloud 返回的 MEV Activity / MEV Tracker 风险标。这里只表示外部风险标签覆盖，不等于本站独立识别了全部 MEV Bot。")}
            </div>
            <div className="txn-feature-group">
              <div className="tcv-title">资产触达</div>
              {covRow("稳定币", "#37A89A", dim.assets.stable ?? 0, "Transfer 日志地址或目标合约命中已核实稳定币表；是交易触达率，不代表稳定币交易类型。")}
              {covRow("Meme Launchpad", "#C875B2", dim.assets.meme ?? 0, "当前覆盖已识别 launchpad/相关资产，外盘 meme token 尚不完整，因此是下限。")}
            </div>
            <div className="txn-feature-group">
              <div className="tcv-title">已知 CEX 地址资金流</div>
              {covRow("流入 CEX", "#5FA8C7", dim.flows.cex_in ?? 0, "Transfer 的接收方命中已知 CEX 热钱包。它是地址覆盖流入，不等于全平台充值量。")}
              {covRow("流出 CEX", "#5FA8C7", dim.flows.cex_out ?? 0, "Transfer 的发送方命中已知 CEX 热钱包。它是地址覆盖流出，不等于全平台提现量。")}
              {(dim.flows.cex_internal ?? 0) > 0 && covRow("CEX 地址间", "#44758a", dim.flows.cex_internal)}
            </div>
            <div className="txn-dim-qual">
              V2 规则版本 {(dim.meta?.classifierVersions ?? []).join(", ") || "—"} · 安全确认 {collector?.confirmationBlocks ?? 0} 块 · receipt 缺失 <b>{(dim.qual?.rcptMiss ?? 0).toLocaleString()}</b> · 失败 <b>{(dim.qual?.failed ?? 0).toLocaleString()}</b>
              {((dim.meta?.excludedStaleBuckets ?? 0) + (dim.meta?.excludedGapBuckets ?? 0) + (dim.meta?.excludedImpreciseBuckets ?? 0)) > 0 && <> · 已隔离旧版本/缺口/时间边界不明桶 <b>{(dim.meta?.excludedStaleBuckets ?? 0) + (dim.meta?.excludedGapBuckets ?? 0) + (dim.meta?.excludedImpreciseBuckets ?? 0)}</b></>}
              {(!dim.meta?.actionCapabilities?.predict || !dim.meta?.actionCapabilities?.bridge) && <> · 预测市场/Bridge 主行为：<b>待核实动作表，暂不出数</b></>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const CAT_INFO = {
  token: "标准 ERC20 transfer/transferFrom，或仅产生 Transfer 事件的合约调用(批量分发/游戏/claim 等)。稳定币单独统计,不计入此类。",
  stable: "仅直接调用已知稳定币合约(USDT/USDC/BUSD/DAI 等)的交易计入,优先于代币转账。DeFi swap 中涉及稳定币仍归 DeFi。",
  bot: "两条行为特征,命中任一即算:① 函数选择器前三字节全零(0x000000xx)——MEV bot 为省 gas 的惯用写法,正常应用不会这么写;② 同一发送方在同一个块(450ms)内发出 ≥3 笔合约调用——人手做不到。纯 BNB 转账和标准代币转账即使高频也不算。注意:夹子/套利等主流 MEV 通常每块只发 1 笔,不会被这两条命中,所以此数是下限,真实 bot 量高于它。",
};

// v1 互斥分类的判定规则(与 backend/src/txn/classifier.js 优先级链一致;命中即停)
const CLASSIFY_RULES = [
  ["1", "系统交易", "接收方是 BSC 系统合约(0x…1000~2006、0x…3000,共 16 个固定地址,每块 1 笔 validator 分账)"],
  ["2", "CEX 充提", "发送方或接收方命中已知交易所热钱包(Binance/OKX/Gate 等 12 个,人工核实;充值方向覆盖不全,详见多维面板)"],
  ["3", "地址标签", "接收方在标签库中 → 按标签定类:预测市场(predict.fun)、稳定币(USDT/USDC/FDUSD 等 7 个)、Meme(four.meme)、Bridge(TokenHub)、Infra(builder 支付)、DeFi(PancakeSwap Router 等)。标签库 = 70 条人工核实 + AI 学得(带 ✦,未经完整审计)"],
  ["4", "Bot", "① 选择器前三字节全零(0x000000xx,MEV 省 gas 惯例);② 同发送方同块 ≥3 笔合约调用(450ms 内人手做不到)。纯转账/标准代币转账不计入;单发型 MEV 不会命中,数字是下限"],
  ["5", "DeFi", "回执含 UniswapV2/V3 风格 Swap 事件(直调池子、聚合器等未被标签命中的兜底)"],
  ["6", "BNB 转账", "恰好 21000 gas 的原生转账;或空 calldata、无事件、≤30k gas(简单合约钱包收款)"],
  ["7", "代币转账", "transfer/transferFrom 选择器,或回执含 Transfer 事件(含 NFT 转移/mint/空投,未细分)"],
  ["8", "其他", "以上全部未命中的残差(含合约部署);该类突增通常意味着新热点合约出现,会进入 AI 归类队列"],
];

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
  if (c.lc) return "NodeReal 标签库(dune)";
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
function Conclusion({ d, label = "24h" }) {
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
  seg.push(<>过去 {label} {cat(c1)} 笔数占比最高(<b>{p(c1)}%</b>){c2 && <>,{cat(c2)} 次之(<b>{p(c2)}%</b>)</>}。</>);

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

function DimConclusion({ dim, collector, label }) {
  if (!dim?.total) return null;
  const bizTotal = dim.denominators?.businessTx ?? Math.max(0, dim.total - (dim.acts?.system?.n ?? 0));
  const rows = Object.entries(dim.acts ?? {}).filter(([k]) => k !== "system").sort((a, b) => (b[1]?.n ?? 0) - (a[1]?.n ?? 0));
  const [top] = rows;
  const topPct = top && bizTotal ? +((top[1].n / bizTotal) * 100).toFixed(1) : 0;
  const coverage = dim.meta?.coveragePct;
  return (
    <div className="txn-conclusion">
      <span className="tc-ico">📌</span>
      <span>
        过去 {label} 记录 <b>{bizTotal.toLocaleString()}</b> 笔业务交易；主行为以
        {top && <> <b style={{ color: ACT_META[top[0]]?.color }}>{ACT_META[top[0]]?.label ?? top[0]}</b> 为主(<b>{topPct}%</b>)</>}。
        采集连续性 <b>{coverage == null ? "正在建立基线" : `${coverage}%`}</b>
        {collector?.backlogBlocks > 0 ? <>，仍有 <b>{collector.backlogBlocks.toLocaleString()}</b> 个区块积压</> : ""}。
        “疑似自动化/资产触达/CEX 流向”是可重叠特征，不与主行为争抢分类。
      </span>
    </div>
  );
}

export default function TxnPage() {
  const [d, setD] = useState(null);
  const [openAddr, setOpenAddr] = useState(null);   // 展开完整地址 + 复制
  const [distMode, setDistMode] = useState("1");    // V2 全局窗口:1/3/7/30 天
  const [legacyAll, setLegacyAll] = useState(false);
  const { s: ai, run: runAi } = TxnAiBox();
  const distDays = Number(distMode);
  const distLabel = distMode === "1" ? "24H" : `${distMode}天`;
  const effectiveLabel = d?.dim?.total
    ? (d.dim.meta?.windowReady ? distLabel : `连续 ${spanLabel(d.dim.meta?.effectiveHours)}`)
    : distLabel;

  const clickAddr = (addr) => {
    navigator.clipboard?.writeText(addr).catch(() => {});
    setOpenAddr((x) => (x === addr ? null : addr));
  };

  // 热门合约独立时间窗(24h/7d/30d),与分布口径互不影响
  const [hotDays, setHotDays] = useState(1);
  const hotLabel = hotDays === 1 ? "24H" : `${hotDays}天`;

  // 分布面板:判定规则折叠 + 窗口跟随的 AI 解读
  const [rulesOpen, setRulesOpen] = useState(false);
  const distAi = usePanelAi("/api/ai/txn-dist", "~30s",
    () => ({ days: Number(distMode) }));
  // 热门合约榜 AI 解读(跟随 hotDays 窗口)
  const hotAi = usePanelAi("/api/ai/txn-hot", "~30s", () => ({ days: hotDays }));

  useEffect(() => {
    let alive = true;
    const pull = () => fetch(API + `/api/txn?days=${distDays}&hot=${hotDays}`).then((r) => r.json())
      .then((j) => { if (alive) setD(j); }).catch(() => {});
    pull();
    const t = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [distDays, hotDays]);

  const pct = (c) => d?.catPct24?.[c] ?? 0;
  const cnt = (c) => d?.catCount24?.[c] ?? 0;
  const gpct = (c) => d?.catGasPct24?.[c] ?? 0;
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
          <p>连续区块水位 + 完整 receipts · 行为/参与者/资产/资金流分维统计 · 可重放事实窗口 · 已学习 {d?.learnedLabels ?? 0} 个候选标签</p>
        </div>
        <div className="ai-bar">
          <button className="st-auto-btn ai-cta" onClick={runAi} disabled={ai.loading}>
            {ai.loading ? "分析中… 约 20–30s" : "⚡ AI 流量特征总结"}
          </button>
        </div>
      </div>

      <div className="subpage-body">
        <DimConclusion dim={d?.dim} collector={d?.collector} label={effectiveLabel} />
        {ai.err && <div className="ai-err" style={{ maxWidth: 900 }}>⚠ {ai.err}</div>}
        {ai.text && (
          <div className="panel" style={{ maxWidth: 900 }}>
            <div className="panel-header"><span>🤖 AI 流量特征</span><span className="sub">claude code{ai.at ? ` · ${new Date(ai.at).toLocaleTimeString()}` : ""}</span></div>
            <div className="panel-body"><div className="ai-result" style={{ padding: "10px 14px" }}><AiText text={ai.text} /></div></div>
          </div>
        )}

        {/* 主 KPI 只使用 V2 分维口径,不再拿旧互斥 cat 的 Bot/DeFi/Meme 混在同一层。 */}
        <div className="stat-cards">
          {(() => {
            const biz = d?.dim?.denominators?.businessTx ?? 0;
            const ratio = (n) => biz ? +((100 * (n ?? 0)) / biz).toFixed(1) : 0;
            return <>
              <div className="stat-card"><div className="sc-v" style={{ color: "var(--gold)" }}>{biz.toLocaleString()}</div><div className="sc-l">{effectiveLabel} 业务交易</div></div>
              <div className="stat-card"><div className="sc-v">{ratio(d?.dim?.acts?.swap?.n)}%</div><div className="sc-l"><i className="sc-dot" style={{ background: ACT_META.swap.color }} />Swap 主行为</div></div>
              <div className="stat-card"><div className="sc-v">{ratio(d?.dim?.assets?.stable)}%</div><div className="sc-l"><i className="sc-dot" style={{ background: CAT_META.stable.color }} />稳定币触达</div></div>
              <div className="stat-card"><div className="sc-v">{ratio(d?.dim?.parts?.bot)}%</div><div className="sc-l"><i className="sc-dot" style={{ background: CAT_META.bot.color }} />疑似自动化命中</div></div>
            </>;
          })()}
        </div>

        <DimPanel dim={d?.dim} collector={d?.collector} range={distMode} setRange={setDistMode} />

        <details className="txn-legacy">
          <summary>查看旧版单分类口径(仅兼容历史趋势，不作为主结论)</summary>
          <div className="txn-legacy-body">
            <Conclusion d={d} label={legacyAll ? "历史累计" : distLabel} />

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
          // 旧版单 cat 仅用于历史兼容；时间窗口沿用页面 V2，另可查看累计。
          const at = legacyAll ? d?.allTime : null;
          const dcnt = (c) => (at ? at.catCount?.[c] ?? 0 : cnt(c));
          const dpct = (c) => (at ? at.catPct?.[c] ?? 0 : pct(c));
          const dgpct = (c) => (at ? at.catGasPct?.[c] ?? 0 : gpct(c));
          const rows = CAT_KEYS.filter((c) => dcnt(c) > 0).sort((a, b) => dcnt(b) - dcnt(a));
          const sinceStr = at?.since ? `${new Date(at.since).getMonth() + 1}/${new Date(at.since).getDate()}` : null;
          return (
            <div className="panel txn-dist-xl" style={{ maxWidth: 1230 }}>
              <div className="panel-header">
                <span>{at ? "历史累计交易类型分布" : `${distLabel} 交易类型分布`}</span>
                <span className="txn-dist-ctl">
                  <span className="sub">
                    {at ? `自 ${sinceStr} · ${at.total.toLocaleString()} 笔累计` : `${d?.total24?.toLocaleString() ?? "…"} 笔 · 全量`}
                  </span>
                  <span className="tf-ranges">
                    <button className={`tf-range ${legacyAll ? "on" : ""}`} onClick={() => setLegacyAll((v) => !v)}>{legacyAll ? `返回 ${distLabel}` : "历史累计"}</button>
                    <button className={`tf-range ${rulesOpen ? "on" : ""}`} onClick={() => setRulesOpen((v) => !v)}>ⓘ 判定规则</button>
                  </span>
                  <AiButton ai={distAi} label={`AI 解读(${distLabel})`} />
                </span>
              </div>
              <div className="panel-body txn-dist">
                <AiResult ai={distAi} title={`交易类型分布 · ${distLabel}`} />
                {rulesOpen && (
                  <div className="txn-rules">
                    <div className="txn-rules-note">
                      每笔交易按 1→8 顺序逐条判定,<b>命中即停</b>(靠前类别优先),只归入一类。想看"动作/参与者/资产"分开统计的口径,见下方「多维分布」面板。
                    </div>
                    {CLASSIFY_RULES.map(([n, cat, rule]) => (
                      <div key={n} className="txn-rule-row"><b>{n}</b><em>{cat}</em><span>{rule}</span></div>
                    ))}
                  </div>
                )}
                <div className="txn-dist-head">
                  <span>类别</span>
                  <span className="tdr-r">笔数</span>
                  <span>笔数占比</span>
                  <span>Gas 占比<InfoTip text="按各类交易消耗的 gasUsed 总量占比,反映对区块执行资源的占用(而非笔数)。DeFi swap / 复杂合约调用 gas 重,BNB 转账 / 稳定币转账 gas 轻。gasPrice 相近时≈手续费占比。" /></span>
                  <span className="tdr-r">{at ? "环比" : `较前${distLabel}`}</span>
                </div>
                {rows.map((c) => {
                  return (
                    <div key={c} className="txn-dist-row">
                      <span className="tdr-label" style={{ color: CAT_META[c].color }}>
                        {CAT_META[c].label}{CAT_INFO[c] && <InfoTip text={CAT_INFO[c]} />}
                      </span>
                      <span className="tdr-count">{dcnt(c).toLocaleString()}</span>
                      <span className="tdr-metric">
                        <span className="tdr-track"><span className="tdr-fill" style={{ width: `${Math.min(dpct(c), 100)}%`, background: CAT_META[c].color }} /></span>
                        <span className="tdr-pct">{dpct(c)}%</span>
                      </span>
                      <span className="tdr-metric">
                        <span className="tdr-track"><span className="tdr-fill" style={{ width: `${Math.min(dgpct(c), 100)}%`, background: CAT_META[c].color, opacity: .55 }} /></span>
                        <span className="tdr-pct">{dgpct(c)}%</span>
                      </span>
                      {at
                        ? <span className="tdr-trend" style={{ color: "var(--dim)" }}>—</span>
                        : <span className="tdr-trend" title="当前窗口较前一个等长窗口">
                            <Delta v={d?.catWindowDelta?.[c]} />
                          </span>}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

          </div>
        </details>

        <div className="panel txn-hot-xl" style={{ maxWidth: 1620 }}>
          <div className="panel-header">
            <span>{hotLabel} 热门合约</span>
            <span className="txn-dist-ctl">
              <span className="sub">标注(身份) · 分类(行为)+ 依据 · ✦ = AI 候选标签,未经人工审计</span>
              <span className="tf-ranges">
                {[[1, "24H"], [7, "7天"], [30, "30天"]].map(([v, l]) => (
                  <button key={v} className={`tf-range ${hotDays === v ? "on" : ""}`} onClick={() => setHotDays(v)}>{l}</button>
                ))}
              </span>
              <AiButton ai={hotAi} label={`AI 解读(${hotLabel})`} />
            </span>
          </div>
          <div className="panel-body txn-contracts">
            <AiResult ai={hotAi} title={`热门合约 · ${hotLabel}`} />
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
                    ? <span className="tcr-name">{c.name}{c.ai && <em className="txn-ai">✦</em>}{c.lc && <em className="txn-ai" title="NodeReal 标签库">◈</em>}</span>
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
          管线:从持久化连续水位并发追取区块与完整 receipts → 写入可重放事实窗口 → V2 行为规则与身份/资产标签分开聚合。
          只有“采集连续性”和“Receipt 完整”均达标的区间才可视为全量；AI 候选标签不直接决定交易主行为。
        </div>
      </div>
      <div className="mev-robot-anchor"><RobotWidget variant="txn" /></div>
    </div>
  );
}
