// Line icons (24x24, stroke=currentColor) — replaces flat emoji for a sharper look
const ICONS = {
  home:    "M4 10.5 12 4l8 6.5M6 9.5V20h5v-6h2v6h5V9.5",
  monitor: "M4 20h16M7 20v-4M12 20V7M17 20v-9",
  mev:     "M5 4h14l2.5 5L12 21 2.5 9zM2.5 9h19M8 4l4 5 4-5",
  traffic: "M2 10c2.5-3.4 5.5-3.4 8 0s5.5 3.4 8 0M2 15.5c2.5-3.4 5.5-3.4 8 0s5.5 3.4 8 0",
  storage: "M4 6c0-1.6 3.6-2.8 8-2.8s8 1.2 8 2.8-3.6 2.8-8 2.8S4 7.6 4 6zM4 6v12c0 1.6 3.6 2.8 8 2.8s8-1.2 8-2.8V6M4 12c0 1.6 3.6 2.8 8 2.8s8-1.2 8-2.8",
  txn:     "M4 8h13l-3.2-3.2M20 16H7l3.2 3.2",
  alerts:  "M18 8.5a6 6 0 10-12 0c0 5.5-2.5 7.5-2.5 7.5h17s-2.5-2-2.5-7.5M10 20a2 2 0 004 0",
};

const ITEMS = [
  { id: "home",    label: "首页",   tip: "Validator Ring · 健康总览 · AI 分析 · 近期工作" },
  { id: "monitor", label: "监控",   tip: "Block Gas 执行视角 · 导入时延 · Reorg 分析" },
  { id: "mev",     label: "MEV",    tip: "Builder 格局 · v1/v2 占比 · Validator 出块榜" },
  { id: "traffic", label: "流量",   tip: "Gas 利用率 · TxPool 深度 · 大流量检测" },
  { id: "storage", label: "存储",   tip: "db inspect 全表 · state 增长环比 · 趋势投影", tag: "自动化 v1.1" },
  { id: "txn",     label: "TXN分析", tip: "TXN 分析 · 链上流量特征 · meme/DeFi/bot 归类 · AI 标签库" },
  { id: "alerts",  label: "告警",   tip: "slash / 磁盘 / 大流量 告警汇总", tag: "v1.1" },
];

export default function NavRail({ current, onNav, connected }) {
  return (
    <nav className="nav-rail">
      {/* 提示:左侧可切换子系统(仅首页显示,已在子系统页面时不再提示) */}
      {current === "home" && (
        <div className="nav-hint">
          <span className="nav-hint-arrow">◀</span>
          <span className="nav-hint-text">点击切换子系统</span>
        </div>
      )}
      <div className="nav-logo">
        {/* official BNB mark: top/bottom chevrons + left/center/right diamonds */}
        <svg width="28" height="28" viewBox="4 4 24 24" fill="#F0B90B">
          <path d="M12.116 14.404L16 10.52l3.886 3.886 2.26-2.26L16 6l-6.144 6.144 2.26 2.26z" />
          <path d="M6 16l2.26-2.26L10.52 16l-2.26 2.26L6 16z" />
          <path d="M16 13.706L18.294 16 16 18.294 13.706 16 16 13.706z" />
          <path d="M21.48 16l2.26-2.26L26 16l-2.26 2.26L21.48 16z" />
          <path d="M12.116 17.596L16 21.48l3.886-3.886 2.26 2.26L16 26l-6.144-6.144 2.26-2.26z" />
        </svg>
      </div>

      {/* 列头:说明下方是可切换的子系统入口(替代原浮动红色提示) */}
      <div className="nav-sect">子系统 ▾</div>
      <div className="nav-items">
        {ITEMS.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${current === item.id ? "nav-active" : ""}`}
            onClick={() => onNav(item.id)}
          >
            <svg className="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d={ICONS[item.id]} />
            </svg>
            <span className="nav-label">{item.label}</span>
            <div className="nav-tip" role="tooltip">
              <div className="nav-tip-title">{item.label}</div>
              <div className="nav-tip-desc">{item.tip}</div>
              {item.tag && <span className="nav-tip-tag">{item.tag}</span>}
            </div>
          </button>
        ))}
      </div>

      <div className="nav-footer">
        <div className={`nav-dot ${connected ? "dot-ok" : "dot-err"}`} title={connected ? "Connected" : "Disconnected"} />
      </div>
    </nav>
  );
}
