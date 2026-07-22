import { useEffect, useState } from "react";
import { aiRequest } from "../lib/ai.js";
import { AiText } from "./PanelAi.jsx";

const API = import.meta.env.VITE_API_BASE ?? "";

// Slash 分析(SlashIndicator 事件,窗口 24h/7d/15d):谁被 slash、连续块数、替代出块者、
// 出块间隔、自营/外部归属。episodes 由后端按「同 validator 连续块」聚合。
export default function SlashPanel() {
  const [days, setDays] = useState(15);       // 1(24h)/ 7 / 15,默认 15 天;store 15d,历史自上线起积累
  const winLabel = days === 1 ? "24h" : `${days} 天`;
  const [d, setD] = useState(null);
  const [ai, setAi] = useState({ loading: false, text: null, err: null });

  useEffect(() => {
    let alive = true;
    const pull = () => fetch(API + `/api/slash-events?days=${days}`).then((r) => r.json()).then((j) => { if (alive) setD(j); }).catch(() => {});
    pull();
    const t = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [days]);

  const runAi = async () => {
    setAi({ loading: true, text: null, err: null });
    try {
      const j = await aiRequest("/api/ai/slash", { days });
      if (j.error) setAi({ loading: false, text: null, err: j.error });
      else setAi({ loading: false, text: j.text, err: null });
    } catch (e) { setAi({ loading: false, text: null, err: String(e) }); }
  };

  const eps = d?.episodes ?? [];
  // 按 validator 汇总 slash 块数(bar 图)
  const byV = {};
  eps.forEach((e) => {
    const k = e.name ?? e.validator;
    byV[k] = byV[k] ?? { n: 0, internal: e.internal };
    byV[k].n += e.blocks;
  });
  const vRows = Object.entries(byV).sort((a, b) => b[1].n - a[1].n);
  const maxV = vRows[0]?.[1].n ?? 1;
  const top3 = vRows.slice(0, 3).map(([name]) => name).join("/");
  const internalHit = eps.some((e) => e.internal);
  const fmtGap = (ms) => (ms == null ? "--" : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`);
  // 内容少时缩小 40%(compact);事件多 / validator 多 / 有 AI 结果时恢复完整尺寸,列表内部滚动
  const expanded = eps.length > 8 || vRows.length > 4 || !!ai.text || ai.loading;

  return (
    <div className={`panel eb-panel sl-panel ${expanded ? "" : "sl-compact"}`}>
      <div className="panel-header">
        <span>Slash 分析 · {winLabel}
          {d && (
            <em className={`panel-verdict pv-${internalHit ? "warn" : (d.count ?? 0) > 0 ? "mid" : "ok"}`}>
              {d.count > 0 ? `slash ${d.count} 块 · ${eps.length} 段${top3 ? ` · Top: ${top3}` : ""}${internalHit ? " · 含自营" : ""}` : "无 slash"}
            </em>
          )}
        </span>
        <span className="bm-ctls">
          <span className="sub">missed turn · SlashIndicator 事件 · 60s 刷新</span>
          <span className="tf-ranges">
            {[[1, "24h"], [7, "7天"], [15, "15天"]].map(([v, l]) => (
              <button key={v} className={`tf-range ${days === v ? "on" : ""}`} onClick={() => setDays(v)}>{l}</button>
            ))}
          </span>
          <button className="st-auto-btn ai-cta panel-ai-btn" onClick={runAi} disabled={ai.loading || !(d?.count > 0)}>
            {ai.loading ? "解读中… ~20s" : "⚡ AI 解读"}
          </button>
        </span>
      </div>
      <div className="panel-body eb-body">
        <div className="eb-cols">
          <div className={`eb-count ${internalHit ? "warn" : (d?.count ?? 0) > 0 ? "warn" : "ok"}`}>
            <b>{d?.count ?? "--"}</b>
            <span>slash 块 / {winLabel}</span>
          </div>
          <div className="eb-miners">
            <div className="re-title">被 slash validator(块数)</div>
            {vRows.length === 0
              ? <div className="eb-none">✓ 近 {winLabel} 无 slash</div>
              : vRows.slice(0, 6).map(([name, v]) => (
                  <div key={name} className="eb-miner">
                    <em className={v.n >= 3 || v.internal ? "eb-hot" : ""}>{name}{v.internal ? " · 自营" : ""}{v.n >= 3 ? " ⚠" : ""}</em>
                    <span className="eb-mbar"><i style={{ width: `${(v.n / maxV) * 100}%` }} /></span>
                    <b>{v.n}</b>
                  </div>
                ))}
          </div>
          <div className="eb-listcol">
            <div className="re-title">事件段 · 被 slash → 替代出块 · 间隔</div>
            <div className="eb-list">
              {eps.slice(0, 30).map((e) => (
                <div key={`${e.validator}-${e.startBlock}`} className="hpd-row sl-row" title={`块 #${e.startBlock.toLocaleString()}${e.blocks > 1 ? ` ~ #${e.endBlock.toLocaleString()}` : ""}`}>
                  <span className="hpd-num">{e.timeLocal}</span>
                  <span className={`hpd-mid ${e.internal ? "sl-int" : ""}`}>{e.name}{e.internal ? "·自营" : ""}{e.blocks > 1 ? ` ×${e.blocks}块` : ""}</span>
                  <span className="sl-fill">→ {(e.fillers ?? [])[0] ?? "?"}</span>
                  <span className={`hpd-end ${e.gapMsMax > 800 ? "sl-gap-hot" : ""}`}>{fmtGap(e.gapMsMax)}</span>
                </div>
              ))}
              {eps.length === 0 && (
                <div className="eb-none">
                  {d?.latest15d
                    ? <>最近一次:{d.latest15d.timeLocal} {d.latest15d.name}{d.latest15d.internal ? "·自营" : ""}{d.latest15d.blocks > 1 ? ` ×${d.latest15d.blocks}块` : ""} → {(d.latest15d.fillers ?? [])[0] ?? "?"}</>
                    : "—"}
                </div>
              )}
            </div>
          </div>
        </div>
        {/* AI 解读结果:概况 + internal 排查名单 */}
        {ai.loading && (
          <div className="tf-ai-loading">
            <span className="tf-ai-spin" />
            <span>claude 分析中…slash 分布 / 连续性 / 替代关系,约 20s</span>
          </div>
        )}
        {ai.err && <div className="ai-err">⚠ {ai.err}</div>}
        {ai.text && <div className="hpd-ai"><AiText text={ai.text} /></div>}
      </div>
    </div>
  );
}
