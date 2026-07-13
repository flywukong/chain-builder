import { useState } from "react";

const API = import.meta.env.VITE_API_BASE ?? "";

// 面板级 AI 解读:醒目按钮(放 panel-header 右侧)+ 内联结果块(渲染在 body 顶部)
// 用法:const ai = usePanelAi("/api/ai/blockgas");  → <AiButton ai={ai} /> / <AiResult ai={ai} title="…" />
// getBody 可选:点击时求值作为 POST body(如窗口天数);runWith(body) 供事件行等直接调用
export function usePanelAi(path, eta = "~20s", getBody) {
  const [s, setS] = useState({ loading: false, text: null, at: null, err: null });
  const runWith = async (body) => {
    if (s.loading) return;
    setS({ loading: true, text: null, at: null, err: null });
    try {
      const r = await fetch(API + path, {
        method: "POST",
        ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      const d = await r.json();
      if (d.error) setS({ loading: false, text: null, at: null, err: d.error });
      else if (d.running) setS((x) => ({ ...x, loading: false, err: "已有分析进行中,请稍候" }));
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
      {s.text && <div className="ai-result" style={{ maxHeight: 200 }}>{s.text}</div>}
    </div>
  );
}
