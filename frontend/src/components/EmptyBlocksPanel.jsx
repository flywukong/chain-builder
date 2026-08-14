import { useEffect, useState } from "react";
import { aiRequest } from "../lib/ai.js";
import { AiText } from "./PanelAi.jsx";
import { lookupValidator } from "../data/validators.js";

const API = import.meta.env.VITE_API_BASE ?? "";
const fmtT = (t) => new Date(t).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

// 空块详情(24h 滚动,判据 gasUsed < 200k):计数 + 按 validator 聚合 + 最近列表 + AI 简析
export default function EmptyBlocksPanel() {
  const [days, setDays] = useState(1);        // 1(24h)/ 7 / 15;store 总窗口 15d,历史自上线起积累
  const winLabel = days === 1 ? "24h" : `${days} 天`;
  const [d, setD] = useState(null);
  const [ai, setAi] = useState({ loading: false, text: null, err: null });
  const [sAi, setSAi] = useState({ from: null, loading: false, text: null, err: null });   // 单段连续空块解读
  const [mAi, setMAi] = useState({ name: null, loading: false, text: null, err: null });   // 单个 validator 空块画像

  useEffect(() => {
    let alive = true;
    const pull = () => fetch(API + `/api/empty-blocks?days=${days}`).then((r) => r.json()).then((j) => { if (alive) setD(j); }).catch(() => {});
    pull();
    const t = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [days]);

  const runAi = async () => {
    setAi({ loading: true, text: null, err: null });
    try {
      const j = await aiRequest("/api/ai/empty", { days });
      if (j.error) setAi({ loading: false, text: null, err: j.error });
      else setAi({ loading: false, text: j.text, err: null });
    } catch (e) { setAi({ loading: false, text: null, err: String(e) }); }
  };

  const runStreakAi = async (s) => {
    setSAi({ from: s.from, loading: true, text: null, err: null });
    try {
      const j = await aiRequest("/api/ai/empty-streak", { days, from: s.from });
      setSAi({ from: s.from, loading: false, text: j.error ? null : j.text, err: j.error ?? null });
    } catch (e) { setSAi({ from: s.from, loading: false, text: null, err: String(e) }); }
  };

  const runMinerAi = async (name, miner) => {
    setMAi({ name, loading: true, text: null, err: null });
    try {
      const j = await aiRequest("/api/ai/empty-miner", { days, miner });
      setMAi({ name, loading: false, text: j.error ? null : j.text, err: j.error ?? null });
    } catch (e) { setMAi({ name, loading: false, text: null, err: String(e) }); }
  };

  // 连续空块段(后端判据:同 validator、块号相邻、≥3 个)压成一条,列表里其余块正常展开
  const streaks = d?.streaks ?? [];
  const inStreak = new Map();   // 块号 → 所属段
  streaks.forEach((s) => (s.numbers ?? []).forEach((n) => inStreak.set(n, s)));
  const rows = [];
  const seen = new Set();
  for (const b of d?.recent ?? []) {
    const s = inStreak.get(b.number);
    if (!s) { rows.push({ kind: "block", b }); continue; }
    if (seen.has(s.from)) continue;
    seen.add(s.from);
    rows.push({ kind: "streak", s });
  }

  // 按 validator 聚合,谁出的空块最多(保留地址,Top3 的 AI 解读按它定位)
  const byMiner = {};
  (d?.recent ?? []).forEach((b) => {
    const name = b.miner ? lookupValidator(b.miner).name : "未知";
    const e = (byMiner[name] ??= { n: 0, miner: b.miner ?? null });
    e.n++;
  });
  const miners = Object.entries(byMiner).sort((a, b) => b[1].n - a[1].n);
  const maxM = miners[0]?.[1].n ?? 1;

  const top3 = miners.slice(0, 3).map(([name]) => name).join("/");

  return (
    <div className="panel eb-panel">
      <div className="panel-header">
        <span>空块 · {winLabel}
          {d && (
            <em className={`panel-verdict pv-${streaks.length > 0 ? "warn" : (d.count ?? 0) > 0 ? "mid" : "ok"}`}>
              {d.count > 0
                ? `空块 ${d.count}${streaks.length ? ` · ⚠ 连续 ${streaks.length} 段` : ""}${top3 ? ` · Top: ${top3}` : ""}`
                : "无空块"}
            </em>
          )}
        </span>
        <span className="bm-ctls">
          <span className="sub">判据 gasUsed &lt; 200k · 60s 刷新</span>
          <span className="tf-ranges">
            {[[1, "24h"], [7, "7天"], [15, "15天"]].map(([v, l]) => (
              <button key={v} className={`tf-range ${days === v ? "on" : ""}`} onClick={() => setDays(v)}>{l}</button>
            ))}
          </span>
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
            <span>空块 / {winLabel}</span>
          </div>
          <div className="eb-miners">
            <div className="re-title">Top validator</div>
            {miners.length === 0
              ? <div className="eb-none">✓ 近 {winLabel} 无空块</div>
              : miners.slice(0, 6).map(([name, m], i) => (
                  <div key={name} className="eb-miner">
                    <em className={m.n >= 3 ? "eb-hot" : ""}>{name}{m.n >= 3 ? " ⚠" : ""}</em>
                    <span className="eb-mbar"><i style={{ width: `${(m.n / maxM) * 100}%` }} /></span>
                    <b>{m.n}</b>
                    {i < 3 && m.miner && (
                      <button className="eb-mn-ai" title={`AI 分析 ${name} 的空块成因`}
                              onClick={() => runMinerAi(name, m.miner)}
                              disabled={mAi.loading && mAi.name === name}>
                        {mAi.loading && mAi.name === name ? "解读中…" : "⚡ AI"}
                      </button>
                    )}
                  </div>
                ))}
            {mAi.loading && (
              <div className="tf-ai-loading eb-sk-loading">
                <span className="tf-ai-spin" />
                <span>claude 分析 {mAi.name} 的空块形态…链上取证约 30–40s</span>
              </div>
            )}
            {mAi.err && <div className="ai-err">⚠ {mAi.err}</div>}
            {mAi.text && <div className="hpd-ai eb-sk-ai-out"><AiText text={mAi.text} /></div>}
          </div>
          <div className="eb-listcol">
            <div className="re-title">最近空块
              {streaks.length > 0 && <em className="eb-streak-tag">⚠ 连续空块 {streaks.length} 段</em>}
            </div>
            <div className="eb-list">
              {rows.slice(0, 30).map((r) => r.kind === "streak" ? (
                <div key={"s" + r.s.from} className="eb-streak-row" title={`同一 validator 连续 ${r.s.blocks} 个空块(跨 ${r.s.span} 块),指向节点侧异常`}>
                  <span className="eb-sk-main">
                    <b>连续 {r.s.blocks} 个空块</b>
                    <span className="eb-sk-range">#{r.s.from.toLocaleString()} – #{r.s.to.toLocaleString()}</span>
                  </span>
                  <span className="eb-sk-miner">{r.s.miner ? lookupValidator(r.s.miner).name : "—"}</span>
                  <span className="eb-sk-t">{fmtT(r.s.t)}</span>
                  <button className="eb-sk-ai" onClick={() => runStreakAi(r.s)}
                          disabled={sAi.loading && sAi.from === r.s.from}>
                    {sAi.loading && sAi.from === r.s.from ? "解读中…" : "⚡ AI"}
                  </button>
                </div>
              ) : (
                <div key={r.b.number} className="hpd-row">
                  <span className="hpd-num">#{r.b.number.toLocaleString()}</span>
                  <span className="hpd-mid">{r.b.miner ? lookupValidator(r.b.miner).name : "—"}</span>
                  <span className="hpd-end">{fmtT(r.b.t)}</span>
                </div>
              ))}
              {rows.length === 0 && <div className="eb-none">—</div>}
            </div>
            {sAi.loading && (
              <div className="tf-ai-loading eb-sk-loading">
                <span className="tf-ai-spin" />
                <span>claude 取证中…拉取该段前后轮次,约 30–40s</span>
              </div>
            )}
            {sAi.err && <div className="ai-err">⚠ {sAi.err}</div>}
            {sAi.text && <div className="hpd-ai eb-sk-ai-out"><AiText text={sAi.text} /></div>}
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
