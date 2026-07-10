import { useState } from "react";
import { lookupValidator } from "../data/validators.js";

const SEVERITY = { felony: "sev-crit", misdemeanor: "sev-high", warn: "sev-warn", ok: "sev-ok" };
const SEV_LABEL = { felony: "CRITICAL", misdemeanor: "HIGH", warn: "WARN", ok: "OK" };

export default function AlertsPage({ slashStatus, recentBlocks }) {
  const [notice, setNotice] = useState(null);
  const anomalies = (recentBlocks ?? []).filter(b => b.anomaly);
  const slashActive = (slashStatus ?? []).filter(v => v.slashCount > 0);

  const allAlerts = [
    ...slashActive.map(v => {
      const info = lookupValidator(v.consensusAddr);
      return {
        id:       `slash-${v.consensusAddr}`,
        category: "Slash",
        severity: v.slashCount >= 600 ? "felony" : v.slashCount >= 200 ? "misdemeanor" : "warn",
        title:    `Validator ${info.name} · slash count ${v.slashCount}`,
        internal: info.group === "internal",   // 内部运营节点,列表额外标注
        detail:   v.consensusAddr,
        ts:       null,
      };
    }),
    ...anomalies.slice(-20).map(b => ({
      id:       `anomaly-${b.number}`,
      category: "Block",
      severity: "warn",
      title:    `Slow block #${b.number?.toLocaleString()} (${(b.blockTimeMs/1000).toFixed(1)}s)`,
      detail:   `miner: ${b.miner?.slice(0,10)}…`,
      ts:       b.milliTimestamp,
    })),
  ];

  const handleOne = (a) => {
    setNotice(`「一键处理」开发中：将对「${a.title}」自动诊断并给出建议操作(排查脚本 / 通知运营方 / 静默)。`);
    clearTimeout(handleOne._t);
    handleOne._t = setTimeout(() => setNotice(null), 5000);
  };

  return (
    <div className="subpage">
      <div className="subpage-header">
        <h1>Alerts</h1>
        <p>网络异常、Slash 事件的集中处理视图</p>
      </div>

      <div className="subpage-body">
        {notice && <div className="st-notice">🔧 {notice}</div>}

        {allAlerts.length === 0 ? (
          <div className="alert-empty">
            <div className="alert-empty-icon">✓</div>
            <div className="alert-empty-text">All systems normal</div>
          </div>
        ) : (
          <div className="alert-list">
            {allAlerts.map(a => (
              <div key={a.id} className={`alert-row ${SEVERITY[a.severity] ?? ""}`}>
                <div className="alert-sev-badge">{SEV_LABEL[a.severity]}</div>
                <div className="alert-cat">{a.category}</div>
                <div className="alert-body">
                  <div className="alert-title">{a.title}{a.internal && <i className="v-internal">内部</i>}</div>
                  {a.detail && <div className="alert-detail">{a.detail}</div>}
                </div>
                {a.ts && (
                  <div className="alert-ts">
                    {new Date(a.ts).toLocaleTimeString()}
                  </div>
                )}
                <button className="alert-fix" onClick={() => handleOne(a)}>⚡ 一键处理</button>
                <button className="alert-ack" title="Acknowledge" onClick={() => handleOne(a)}>✓</button>
              </div>
            ))}
          </div>
        )}

        <div className="placeholder-note" style={{ marginTop: 24 }}>
          <span className="ph-icon">🚧</span>
          <div>
            <div className="ph-title">功能设计中</div>
            <div className="ph-desc">「一键处理」将接入自动诊断 + 建议操作;并支持告警规则配置、Slack/微信推送、告警静默、历史记录</div>
          </div>
        </div>
      </div>
    </div>
  );
}
