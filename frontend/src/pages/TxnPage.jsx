import { useEffect, useMemo, useState } from "react";
import RobotWidget from "../components/RobotWidget.jsx";

const API = import.meta.env.VITE_API_BASE ?? "";
const BSC_SCAN = "https://bscscan.com";

const SEGMENTS = {
  prediction:       { label: "预测市场", color: "#8FAE5D", tip: "调用已核实预测市场协议合约；method 用于进一步识别撮合、赎回等动作。" },
  defi:             { label: "DeFi 协议交互", color: "#4CA4D9", tip: "调用已核实 DeFi 合约，或 receipt 出现明确 Swap 事件。" },
  bridge:           { label: "Bridge 协议交互", color: "#B08968", tip: "调用已核实桥合约。只有 method/event 明确时才解释具体跨链动作。" },
  meme_launchpad:   { label: "Meme Launchpad", color: "#C875B2", tip: "调用 four.meme 等已核实管理器或工厂合约，不代表全市场 Meme 交易量。" },
  builder_payment:  { label: "Builder 收款", color: "#7890A8", tip: "向已核实 Builder 付款地址发送原生资产。" },
  infrastructure:   { label: "基础设施交互", color: "#8294A8", tip: "调用已核实的 AA EntryPoint 等基础设施合约；不归入 DeFi。" },
  stable_transfer:  { label: "稳定币转账", color: "#37A89A", tip: "已核实稳定币合约上的标准 Transfer 调用或事件。" },
  token_transfer:   { label: "Token / NFT 转移", color: "#8B7CF6", tip: "标准 Transfer 调用或事件，且没有命中更具体的协议场景。" },
  native_transfer:  { label: "BNB 转账", color: "#D6A82F", tip: "正 value、空 calldata、gasUsed=21000 的原生转账。" },
  deploy:           { label: "合约部署", color: "#6F8FAF", tip: "交易 to 为空。" },
  other_call:       { label: "其他合约调用", color: "#747D88", tip: "尚未命中可信协议或标准行为的调用，可在未知调用面板继续下钻。" },
};

const RANGE_OPTIONS = [["1", "24H"], ["3", "3天"], ["7", "7天"], ["15", "15天"], ["30", "30天"]];
const short = (a) => a ? `${a.slice(0, 8)}…${a.slice(-4)}` : "—";
const methodName = (m) => m?.signature || m?.selector || "无 selector";
const num = (n) => Number(n || 0).toLocaleString();
const gasN = (n) => n == null ? "—" : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`;
const spanLabel = (hours) => (hours || 0) < 24 ? `${Math.max(0, hours || 0).toFixed(1)}小时` : `${((hours || 0) / 24).toFixed(1)}天`;

function InfoTip({ text }) {
  return <span className="info-tip" tabIndex={0}>ⓘ<span className="info-pop">{text}</span></span>;
}

function RangeTabs({ value, onChange }) {
  return <span className="tf-ranges">{RANGE_OPTIONS.map(([v, label]) => (
    <button key={v} className={`tf-range ${value === v ? "on" : ""}`} onClick={() => onChange(v)}>{label}</button>
  ))}</span>;
}

function Delta({ value }) {
  if (value == null) return <span className="txn-delta dim">—</span>;
  return <span className={`txn-delta ${value > 0 ? "up" : value < 0 ? "down" : "dim"}`}>{value > 0 ? "+" : ""}{value}pp</span>;
}

function Empty({ children = "当前口径正在积累数据" }) {
  return <div className="txn-window-empty">{children}</div>;
}

function QualityStrip({ traffic, collector }) {
  const m = traffic?.meta || {};
  return <div className="txn-quality-strip txn-dev-quality">
    <span><em>口径版本</em><b>Traffic v{traffic?.version ?? "—"}</b></span>
    <span><em>实际连续</em><b className={m.windowReady ? "ok" : "warn"}>{spanLabel(m.availableContinuousHours)}</b></span>
    <span><em>窗口就绪</em><b className={m.windowReady ? "ok" : "warn"}>{m.windowReady ? "是" : "积累中"}</b></span>
    <span><em>采集积压</em><b className={(collector?.backlogBlocks || 0) > 0 ? "warn" : "ok"}>{collector?.backlogBlocks == null ? "—" : `${num(collector.backlogBlocks)} 块`}</b></span>
    <span><em>安全确认</em><b>{collector?.confirmationBlocks ?? 0} 块</b></span>
    <span><em>已排除系统交易</em><b>{num(m.excludedSystem)}</b></span>
    {collector?.lastError && <span className="txn-quality-error"><em>最近错误</em><b>#{collector.lastError.height}</b></span>}
  </div>;
}

function TrafficPanel({ traffic, collector, range, setRange, focus, setFocus }) {
  const rows = Object.entries(traffic?.segments || {}).filter(([, v]) => v.n > 0).sort((a, b) => b[1].n - a[1].n);
  return <section className="panel txn-dev-panel txn-traffic-panel">
    <div className="panel-header">
      <span>1 · BSC 流量结构</span>
      <span className="txn-panel-controls"><span className="sub">业务交易唯一主分类 · 合计 100%</span><RangeTabs value={range} onChange={setRange} /></span>
    </div>
    <div className="panel-body">
      <QualityStrip traffic={traffic} collector={collector} />
      {!traffic?.meta?.windowReady && traffic?.total > 0 && <div className="txn-partial-note">当前展示连续覆盖内的临时结果；达到所选窗口后自动转为正式口径。</div>}
      {!rows.length ? <Empty /> : <>
        <div className="txn-dev-table txn-segment-head"><span>主流量分类</span><span>交易量 / 占比</span><span>Gas / 占比</span><span>成功 / 失败</span><span>P50 / P95 gasUsed</span><span>活跃发送者≈</span><span>较前窗口</span></div>
        {rows.map(([key, row]) => {
          const meta = SEGMENTS[key] || { label: key, color: "#747D88" };
          return <button className={`txn-dev-table txn-segment-row ${focus === key ? "active" : ""}`} key={key} onClick={() => setFocus(focus === key ? null : key)}>
            <span className="txn-seg-name" style={{ color: meta.color }}><i style={{ background: meta.color }} />{meta.label}{meta.tip && <InfoTip text={meta.tip} />}</span>
            <span className="txn-cell-stack"><b className="mono">{num(row.n)}</b><span className="txn-inline-bar"><i style={{ width: `${Math.min(100, row.pct || 0)}%`, background: meta.color }} /><em>{row.pct || 0}%</em></span></span>
            <span className="txn-cell-stack"><b className="mono">{gasN(row.gas)}</b><small>{row.gasPct || 0}%</small></span>
            <span className="txn-cell-stack"><b className="ok">{row.successPct ?? 0}%</b><small className={row.failurePct ? "bad" : ""}>{row.failurePct ?? 0}% 失败</small></span>
            <span className="txn-cell-stack"><b className="mono">{gasN(row.p50Gas)}</b><small>{gasN(row.p95Gas)}</small></span>
            <span className="mono">{num(row.activeSendersEst)}</span>
            <Delta value={row.deltaPct} />
          </button>;
        })}
      </>}
    </div>
  </section>;
}

function ProtocolPanel({ traffic, focus }) {
  const protocols = (traffic?.protocols || []).filter((r) => !focus || r.segment === focus).slice(0, 8);
  const contracts = (traffic?.contracts || []).filter((r) => !focus || r.segment === focus).slice(0, 8);
  const methods = (traffic?.methods || []).filter((r) => !focus || r.segment === focus).slice(0, 10);
  const List = ({ title, rows, render }) => <div className="txn-drill-col"><h4>{title}</h4>{rows.length ? rows.map(render) : <Empty>暂无匹配数据</Empty>}</div>;
  return <section className="panel txn-dev-panel">
    <div className="panel-header"><span>2 · 热门协议 / 合约 / Method</span><span className="sub">{focus ? `已筛选：${SEGMENTS[focus]?.label || focus}` : "协议=地址归属；Method=技术入口；仅核实映射才显示业务动作"}</span></div>
    <div className="panel-body txn-drill-grid">
      <List title="协议" rows={protocols} render={(r, i) => <div className="txn-rank-row" key={`${r.segment}:${r.protocol}`}><em>{i + 1}</em><span><b>{r.protocol}</b><small>{r.contracts} 个热门合约</small></span><strong>{num(r.n)}</strong></div>} />
      <List title="合约" rows={contracts} render={(r, i) => <div className="txn-rank-row" key={r.addr}><em>{i + 1}</em><span><b>{r.name || r.protocol || short(r.addr)}</b><a href={`${BSC_SCAN}/address/${r.addr}`} target="_blank" rel="noreferrer">{short(r.addr)}</a></span><strong>{num(r.n)}</strong></div>} />
      <List title="Method / 已核实动作" rows={methods} render={(r, i) => <div className="txn-rank-row" key={`${r.addr}:${r.selector}`}><em>{i + 1}</em><span><b title={r.signature || r.selector}>{r.action || methodName(r)}</b><small>{r.action ? `${methodName(r)} · ` : ""}{r.protocol || r.contract || short(r.addr)}</small></span><strong>{num(r.n)}</strong></div>} />
    </div>
  </section>;
}

function FailureGasPanel({ traffic, focus }) {
  const failed = (traffic?.failure?.methods || []).filter((r) => !focus || r.segment === focus).slice(0, 10);
  const gas = (traffic?.gasAnalysis?.methods || []).filter((r) => !focus || r.segment === focus).slice(0, 10);
  return <section className="panel txn-dev-panel">
    <div className="panel-header"><span>3 · 失败与 Gas 分析</span><span className="sub">失败率 {traffic?.failure?.ratePct ?? 0}% · Method级资源视角</span></div>
    <div className="panel-body txn-two-cols">
      <div className="txn-analysis-list"><h4>失败最多的 Method</h4>{failed.length ? failed.map((r) => <div className="txn-metric-row" key={`${r.addr}:${r.selector}`}><span><b>{methodName(r)}</b><small>{r.protocol || r.contract || short(r.addr)}</small></span><em className="bad">{num(r.failed)} 失败 · {r.failurePct}%</em></div>) : <Empty>所选窗口暂无失败Method</Empty>}</div>
      <div className="txn-analysis-list"><h4>Gas 消耗最高的 Method</h4>{gas.length ? gas.map((r) => <div className="txn-metric-row" key={`${r.addr}:${r.selector}`}><span><b>{methodName(r)}</b><small>{r.protocol || r.contract || short(r.addr)}</small></span><em>{gasN(r.gas)} Gas<small>P50 {gasN(r.p50Gas)} · P95 {gasN(r.p95Gas)}</small></em></div>) : <Empty />}</div>
    </div>
  </section>;
}

function EmergingPanel({ traffic, focus }) {
  const contracts = (traffic?.emerging?.newContracts || []).filter((r) => !focus || r.segment === focus).slice(0, 10);
  const unknown = (traffic?.emerging?.unknownCalls || []).filter((r) => !focus || r.segment === focus).slice(0, 12);
  const events = (traffic?.emerging?.newEvents || []).slice(0, 10);
  return <section className="panel txn-dev-panel">
    <div className="panel-header"><span>4 · 新流量与未知调用</span><span className="sub">未识别调用占比 {traffic?.segments?.other_call?.pct ?? 0}% · {traffic?.meta?.compareReady ? "与前一等长窗口比较" : "对照窗口积累中"}</span></div>
    <div className="panel-body txn-three-cols">
      <div className="txn-analysis-list"><h4>新进入热门榜的合约</h4>{contracts.length ? contracts.map((r) => <div className="txn-metric-row" key={r.addr}><span><b>{r.name || r.protocol || short(r.addr)}</b><a href={`${BSC_SCAN}/address/${r.addr}`} target="_blank" rel="noreferrer">{r.addr}</a></span><em>{num(r.n)} 笔</em></div>) : <Empty>前置对照窗口不足或暂无新合约</Empty>}</div>
      <div className="txn-analysis-list"><h4>未归类调用</h4>{unknown.length ? unknown.map((r) => <div className="txn-metric-row" key={`${r.addr}:${r.selector}`}><span><b>{methodName(r)}</b><a href={`${BSC_SCAN}/address/${r.addr}`} target="_blank" rel="noreferrer">{short(r.addr)}</a></span><em>{num(r.n)} 笔</em></div>) : <Empty>暂无未归类热门调用</Empty>}</div>
      <div className="txn-analysis-list"><h4>新事件签名</h4>{events.length ? events.map((r) => <div className="txn-metric-row" key={r.topic}><span><b title={r.topic}>{r.signature || short(r.topic)}</b><small>{r.emitterCount} 个事件来源合约</small></span><em>{num(r.n)} 笔</em></div>) : <Empty>前置对照窗口不足或暂无新事件</Empty>}</div>
    </div>
  </section>;
}

function FactsPanel({ traffic, dim, focus }) {
  const total = traffic?.total || 0;
  const featureMeta = [
    ["swap", "Swap事件", "#4CA4D9"], ["transfer", "Transfer事件", "#8B7CF6"],
    ["approval", "Approval事件", "#D6A82F"], ["nft", "ERC721形态", "#C875B2"], ["erc1155", "ERC1155事件", "#7890A8"],
  ];
  const samples = (traffic?.methods || []).filter((m) => (!focus || m.segment === focus) && m.samples?.length)
    .flatMap((m) => m.samples.map((hash) => ({ hash, method: methodName(m), protocol: m.protocol }))).slice(0, 8);
  return <section className="panel txn-dev-panel">
    <div className="panel-header"><span>5 · 交易事实与特征分析</span><span className="sub">特征可重叠，不参与主分类100%分母</span></div>
    <div className="panel-body txn-facts-grid">
      <div className="txn-analysis-list"><h4>Receipt事实覆盖</h4>{featureMeta.map(([key, label, color]) => {
        const n = traffic?.features?.[key] || 0; const pct = total ? +(100 * n / total).toFixed(1) : 0;
        return <div className="txn-feature-row" key={key}><span style={{ color }}>{label}</span><i><b style={{ width: `${Math.min(100, pct)}%`, background: color }} /></i><em>{pct}% · {num(n)}</em></div>;
      })}</div>
      <div className="txn-analysis-list"><h4>身份与资产触达</h4>
        <div className="txn-metric-row"><span><b>稳定币触达</b><small>已核实资产地址</small></span><em>{num(dim?.assets?.stable)}</em></div>
        <div className="txn-metric-row"><span><b>Meme Launchpad触达</b><small>当前为已核实管理器覆盖</small></span><em>{num(dim?.assets?.meme)}</em></div>
        <div className="txn-metric-row"><span><b>已知CEX流入 / 流出</b><small>地址覆盖，不代表平台完整充提</small></span><em>{num(dim?.flows?.cex_in)} / {num(dim?.flows?.cex_out)}</em></div>
      </div>
      <div className="txn-analysis-list"><h4>样本交易</h4>{samples.length ? samples.map((s) => <div className="txn-metric-row" key={s.hash}><span><b>{s.method}</b><small>{s.protocol || "未识别协议"}</small></span><a href={`${BSC_SCAN}/tx/${s.hash}`} target="_blank" rel="noreferrer">{short(s.hash)}</a></div>) : <Empty>新口径积累后提供可审计样本</Empty>}</div>
    </div>
  </section>;
}

export default function TxnPage() {
  const [range, setRange] = useState("1");
  const [focus, setFocus] = useState(null);
  const [state, setState] = useState({ data: null, error: null });

  useEffect(() => {
    let alive = true;
    const pull = () => fetch(`${API}/api/txn?days=${range}&hot=${range}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data) => { if (alive) setState({ data, error: null }); })
      .catch((e) => { if (alive) setState((s) => ({ ...s, error: e.message })); });
    pull(); const timer = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, [range]);

  const data = state.data;
  const traffic = data?.traffic;
  const focusLabel = useMemo(() => focus ? SEGMENTS[focus]?.label || focus : null, [focus]);
  return <div className="subpage txn-page txn-dev-page">
    <div className="subpage-header">
      <div><h1>⇄ Txn 开发者流量分析</h1><p>从业务赛道下钻到协议、合约和Method；系统合约已排除，主分类互斥，事实特征独立。</p></div>
      {focus && <button className="txn-clear-focus" onClick={() => setFocus(null)}>清除筛选 · {focusLabel}</button>}
    </div>
    {state.error && <div className="ai-err">⚠ {state.error}</div>}
    <div className="subpage-body txn-dev-body">
      <TrafficPanel traffic={traffic} collector={data?.collector} range={range} setRange={setRange} focus={focus} setFocus={setFocus} />
      <ProtocolPanel traffic={traffic} focus={focus} />
      <FailureGasPanel traffic={traffic} focus={focus} />
      <EmergingPanel traffic={traffic} focus={focus} />
      <FactsPanel traffic={traffic} dim={data?.dim} focus={focus} />
    </div>
    <div className="mev-robot-anchor"><RobotWidget variant="txn" /></div>
  </div>;
}
