import { useState } from "react";
import { aiRequest } from "../lib/ai.js";

// 面板级 AI 解读:醒目按钮(放 panel-header 右侧)+ 内联结果块(渲染在 body 顶部)
// 用法:const ai = usePanelAi("/api/ai/blockgas");  → <AiButton ai={ai} /> / <AiResult ai={ai} title="…" />
// getBody 可选:点击时求值作为 POST body(如窗口天数);runWith(body) 供事件行等直接调用
export function usePanelAi(path, eta = "~20s", getBody) {
  const [s, setS] = useState({ loading: false, text: null, at: null, err: null });
  const runWith = async (body) => {
    if (s.loading) return;
    setS({ loading: true, text: null, at: null, err: null });
    try {
      const d = await aiRequest(path, body);
      if (d.error) setS({ loading: false, text: null, at: null, err: d.error });
      else setS({ loading: false, text: d.text, at: d.at, err: null });
    } catch (e) { setS({ loading: false, text: null, at: null, err: String(e) }); }
  };
  const run = () => runWith(getBody?.());
  const close = () => setS({ loading: false, text: null, at: null, err: null });
  return { s, run, runWith, close, eta };
}

export function AiButton({ ai, label = "AI 解读" }) {
  return (
    <button className="st-auto-btn ai-cta panel-ai-btn" onClick={ai.run} disabled={ai.s.loading}>
      {ai.s.loading ? `解读中… ${ai.eta}` : `⚡ ${label}`}
    </button>
  );
}

// AI 输出的轻量 markdown 渲染:**加粗** → <b>,其余原样(容器 pre-wrap 保留换行),
// 避免星号原样露出;不引入完整 md 渲染器
export function AiText({ text }) {
  if (!text) return null;
  return text.split("\n").map((line, i) => {
    // 整行被 ** 包裹 = 段标题(如「**1) Slash 状况**」「**流量**」)→ 黄色小标题
    const h = line.trim().match(/^\*\*(.+?)\*\*$/);
    if (h) return <span key={i} className="ai-h">{h[1].replace(/[:：]\s*$/, "")}：{"\n"}</span>;
    return (
      <span key={i}>
        {line.split(/\*\*(.+?)\*\*/g).map((p, j) => (j % 2 ? <b key={j}>{p}</b> : p))}
        {"\n"}
      </span>
    );
  });
}

export function AiResult({ ai, title }) {
  const { s } = ai;
  if (!s.text && !s.err) return null;
  return (
    <div className="panel-ai-result">
      <div className="tf-ep-head">
        <span>🤖 {title}</span>
        {s.at && <em className="ai-at">{new Date(s.at).toLocaleTimeString()}</em>}
        <button className="tf-ep-close" onClick={ai.close}>×</button>
      </div>
      {s.err && <div className="ai-err">⚠ {s.err}</div>}
      {s.text && <div className="ai-result" style={{ maxHeight: 200 }}><AiText text={s.text} /></div>}
    </div>
  );
}
