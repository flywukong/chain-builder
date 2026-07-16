import { useEffect, useState } from "react";
import { aiRequest } from "../lib/ai.js";
import { AiText } from "./PanelAi.jsx";
import { lookupValidator } from "../data/validators.js";

const API = import.meta.env.VITE_API_BASE ?? "";
const fmtT = (t) => new Date(t).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

// 空块详情(24h 滚动,判据 gasUsed < 200k):计数 + 按 validator 聚合 + 最近列表 + AI 简析
export default function EmptyBlocksPanel() {
  const [d, setD] = useState(null);
  const [ai, setAi] = useState({ loading: false, text: null, err: null });

  useEffect(() => {
    let alive = true;
    const pull = () => fetch(API + "/api/empty-blocks").then((r) => r.json()).then((j) => { if (alive) setD(j); }).catch(() => {});
    pull();
    const t = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const runAi = async () => {
    setAi({ loading: true, text: null, err: null });
    try {
      const j = await aiRequest("/api/ai/empty");
      if (j.error) setAi({ loading: false, text: null, err: j.error });
      else setAi({ loading: false, text: j.text, err: null });
    } catch (e) { setAi({ loading: false, text: null, err: String(e) }); }
  };

  // 按 validator 聚合,谁出的空块最多
  const byMiner = {};
  (d?.recent ?? []).forEach((b) => {
    const name = b.miner ? lookupValidator(b.miner).name : "未知";
    byMiner[name] = (byMiner[name] ?? 0) + 1;
  });
  const miners = Object.entries(byMiner).sort((a, b) => b[1] - a[1]);
  const maxM = miners[0]?.[1] ?? 1;

  const top3 = miners.slice(0, 3).map(([name]) => name).join("/");

  return (
    <div className="panel eb-panel">
      <div className="panel-header">
        <span>空块 · 24h
          {d && (
            <em className={`panel-verdict pv-${(d.count ?? 0) > 0 ? "mid" : "ok"}`}>
              {d.count > 0 ? `空块 ${d.count}${top3 ? ` · Top: ${top3}` : ""}` : "无空块"}
            </em>
          )}
        </span>
        <span className="bm-ctls">
          <span className="sub">判据 gasUsed &lt; 200k · 60s 刷新</span>
          <button className="st-auto-btn ai-cta panel-ai-btn" onClick={runAi} disabled={ai.loading || !(d?.count > 0)}>
            {ai.loading ? "解读中… ~40s" : "⚡ AI 解读"}
          </button>
        </span>
      </div>
      <div className="panel-body eb-body">
        {/* 三栏:计数 | Top validator | 最近列表;≥3 次的高频 validator 橙标 */}
        <div className="eb-cols">
          <div className={`eb-count ${(d?.count ?? 0) > 0 ? "warn" : "ok"}`}>
            <b>{d?.count ?? "--"}</b>
            <span>空块 / 24h</span>
          </div>
          <div className="eb-miners">
            <div className="re-title">Top validator</div>
            {miners.length === 0
              ? <div className="eb-none">✓ 24h 内无空块</div>
              : miners.slice(0, 6).map(([name, n]) => (
                  <div key={name} className="eb-miner">
                    <em className={n >= 3 ? "eb-hot" : ""}>{name}{n >= 3 ? " ⚠" : ""}</em>
                    <span className="eb-mbar"><i style={{ width: `${(n / maxM) * 100}%` }} /></span>
                    <b>{n}</b>
                  </div>
                ))}
          </div>
          <div className="eb-listcol">
            <div className="re-title">最近空块</div>
            <div className="eb-list">
              {(d?.recent ?? []).slice(0, 30).map((b) => (
                <div key={b.number} className="hpd-row">
                  <span className="hpd-num">#{b.number.toLocaleString()}</span>
                  <span className="hpd-mid">{b.miner ? lookupValidator(b.miner).name : "—"}</span>
                  <span className="hpd-end">{fmtT(b.t)}</span>
                </div>
              ))}
              {(d?.recent?.length ?? 0) === 0 && <div className="eb-none">—</div>}
            </div>
          </div>
        </div>
        {/* AI 解读结果:Top validator 下方空白区;监控侧无节点日志,输出概况 + 排查名单 */}
        {ai.loading && (
          <div className="tf-ai-loading">
            <span className="tf-ai-spin" />
            <span>claude 分析中…空块分布 + 链上取证空块前后轮次,约 30–40s</span>
          </div>
        )}
        {ai.err && <div className="ai-err">⚠ {ai.err}</div>}
        {ai.text && <div className="hpd-ai"><AiText text={ai.text} /></div>}
      </div>
    </div>
  );
}
