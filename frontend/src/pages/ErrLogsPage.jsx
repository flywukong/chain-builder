import { useEffect, useState } from "react";
import { aiRequest } from "../lib/ai.js";
import { AiText } from "../components/PanelAi.jsx";

const API = import.meta.env.VITE_API_BASE ?? "";
const RANGES = [[30, "30m"], [120, "2h"], [360, "6h"], [1440, "24h"]];
const fmtT = (t) => new Date(t).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

// ERR 级日志分析:keter ES(AP 区域自营节点)· 模式聚类 + 节点归属 + AI 解读
export default function ErrLogsPage() {
  const [minutes, setMinutes] = useState(30);
  const [d, setD] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [ai, setAi] = useState({ loading: false, text: null, err: null });

  useEffect(() => {
    let alive = true;
    setD(null); setLoadErr(null);
    const pull = () => fetch(API + `/api/errlogs?minutes=${minutes}`).then((r) => r.json())
      .then((j) => { if (!alive) return; if (j.error) setLoadErr(j.error); else { setD(j); setLoadErr(null); } })
      .catch((e) => { if (alive) setLoadErr(String(e)); });
    pull();
    const t = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [minutes]);

  const runAi = async () => {
    setAi({ loading: true, text: null, err: null });
    try {
      const j = await aiRequest("/api/ai/errlogs", { minutes });
      setAi({ loading: false, text: j.error ? null : j.text, err: j.error ?? null });
    } catch (e) { setAi({ loading: false, text: null, err: String(e) }); }
  };

  const winLabel = RANGES.find(([m]) => m === minutes)?.[1] ?? `${minutes}m`;
  const maxC = d?.clusters?.[0]?.count ?? 1;
  // 定级:P0 致命 / P1 影响 / P2 轻微 / noise 噪声;worst 决定顶部风险卡
  const LV = { P0: ["P0 致命", "p0"], P1: ["P1 影响", "p1"], P2: ["P2 轻微", "p2"], noise: ["噪声", "noise"] };
  const ORDER = ["P0", "P1", "P2", "noise"];
  const worst = d?.clusters?.reduce((w, c) => {
    const l = c.grade?.level;
    return l && (w == null || ORDER.indexOf(l) < ORDER.indexOf(w)) ? l : w;
  }, null) ?? null;
  const lvCounts = ORDER.map((l) => [l, (d?.clusters ?? []).filter((c) => c.grade?.level === l).length]).filter(([, n]) => n > 0);

  return (
    <div className="subpage">
      <div className="subpage-head">
        <div>
          <h1>📋 ERR 日志分析</h1>
          <p>keter ES · AP 区域 validator/fullnode · level:ERROR · 聚类基于最近 ≤1000 条采样</p>
        </div>
        <span className="tf-ranges">
          {RANGES.map(([m, l]) => (
            <button key={m} className={`tf-range ${minutes === m ? "on" : ""}`} onClick={() => setMinutes(m)}>{l}</button>
          ))}
        </span>
        <button className="st-auto-btn ai-cta" onClick={runAi} disabled={ai.loading || !(d?.total > 0)}>
          {ai.loading ? "解读中… ~40s" : "⚡ AI 解读"}
        </button>
      </div>
      <div className="subpage-body">
        {loadErr && <div className="ai-err">⚠ 日志检索失败:{loadErr}</div>}
        {!d && !loadErr && <div className="ph-note">检索 keter 日志中…</div>}
        {d && (
          <>
            <div className="stat-cards">
              <div className="stat-card">
                <div className="sc-v" style={{ color: d.total > 0 ? "var(--orange)" : "var(--green)" }}>{d.total.toLocaleString()}</div>
                <div className="sc-l">ERROR 总数 · {winLabel}</div>
              </div>
              <div className="stat-card"><div className="sc-v">{d.clusters.length}</div><div className="sc-l">消息模式(采样 {d.sampled} 条)</div></div>
              <div className="stat-card"><div className="sc-v">{d.hosts.length}</div><div className="sc-l">涉及节点</div></div>
              <div className="stat-card">
                <div className="sc-v" style={{ fontSize: 16 }}>{d.hosts[0] ? (d.hosts[0].validator ?? d.hosts[0].host) : "—"}</div>
                <div className="sc-l">错误最多的节点{d.hosts[0] ? ` · ${d.hosts[0].n} 条` : ""}</div>
              </div>
              <div className={`stat-card el-worst-${worst ? LV[worst][1] : "none"}`}>
                <div className="sc-v">{worst ? LV[worst][0] : d.grading?.pending ? "定级中…" : "—"}</div>
                <div className="sc-l">最高定级 · AI 评估稳定性影响{d.grading?.pending ? ` · ${d.grading.pending} 个待定级` : ""}</div>
              </div>
            </div>

            {ai.loading && <div className="tf-ai-loading"><span className="tf-ai-spin" /><span>claude 分析 ERROR 模式与节点分布…约 30–40s</span></div>}
            {ai.err && <div className="ai-err">⚠ {ai.err}</div>}
            {ai.text && <div className="panel"><div className="panel-header"><span>🤖 AI 解读</span></div><div className="panel-body"><AiText text={ai.text} /></div></div>}

            <div className="el-cols">
              <div className="panel">
                <div className="panel-header">
                  <span>消息模式聚类
                    {lvCounts.length > 0 && (
                      <em className="panel-verdict pv-mid" style={{ textTransform: "none" }}>
                        {lvCounts.map(([l, n]) => `${LV[l][0].split(" ")[0]}×${n}`).join(" · ")}
                      </em>
                    )}
                  </span>
                  <span className="sub">去参归并 · AI 定级(模式级,一次定级持久复用)</span>
                </div>
                <div className="panel-body el-list">
                  {d.clusters.length === 0 && <div className="ph-note">窗口内无 ERROR 日志 ✓</div>}
                  {d.clusters.map((c) => (
                    <div key={c.pattern} className={`el-cluster ${c.grade ? "lv-" + LV[c.grade.level][1] : ""}`} title={c.sample}>
                      <div className="el-cl-top">
                        <span className={`el-lv ${c.grade ? "el-lv-" + LV[c.grade.level][1] : "el-lv-none"}`}>
                          {c.grade ? LV[c.grade.level][0] : (d.grading?.running || d.grading?.pending ? "定级中…" : "未定级")}
                        </span>
                        <span className="el-cl-pattern">{c.pattern}</span>
                        <b className="el-cl-n">{c.count}</b>
                      </div>
                      <div className="el-cl-bar"><i style={{ width: `${(c.count / maxC) * 100}%` }} /></div>
                      <div className="el-cl-meta">{c.hostCount} 个节点 · 最近 {fmtT(c.lastT)}</div>
                      {c.grade && (
                        <div className="el-cl-grade">
                          <span><em>原因</em>{c.grade.cause}</span>
                          <span><em>影响</em>{c.grade.impact}</span>
                          <span><em>处置</em>{c.grade.action}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <div className="el-side">
                <div className="panel">
                  <div className="panel-header"><span>节点分布</span><span className="sub">有名称 = 自营 validator</span></div>
                  <div className="panel-body el-list">
                    {d.hosts.map((h) => {
                      const badge = h.tier === "cabinet" ? ["CAB 出块中", "cabinet"]
                        : h.tier === "candidate" ? ["CAND 候选", "candidate"]
                        : h.tier === "inactive" ? ["非活跃", "inactive"]
                        : h.role === "data-seed" ? ["data-seed", "seed"]
                        : h.role ? [h.role, "seed"] : ["未知", "seed"];
                      return (
                        <div key={h.host} className="eb-miner" title={h.host}>
                          <em>{h.validator ?? h.host}</em>
                          <span className={`hp-behind-tier ht-${badge[1]}`}>{badge[0]}</span>
                          <span className="eb-mbar"><i style={{ width: `${(h.n / (d.hosts[0]?.n || 1)) * 100}%` }} /></span>
                          <b>{h.n}</b>
                        </div>
                      );
                    })}
                    {d.hosts.length === 0 && <div className="ph-note">—</div>}
                  </div>
                </div>
                <div className="panel">
                  <div className="panel-header"><span>最近样本</span><span className="sub">最新 {d.recent.length} 条</span></div>
                  <div className="panel-body el-list el-recent">
                    {d.recent.map((r, i) => (
                      <div key={i} className="el-row2">
                        <div className="el-row2-top">
                          <span className="el-row-t">{fmtT(r.t)}</span>
                          <span className="el-row-h" title={r.host}>{r.validator ?? r.host}</span>
                          <span className="el-row-m">{r.msg}</span>
                        </div>
                        {r.extra && <div className="el-row2-x">{r.extra}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
