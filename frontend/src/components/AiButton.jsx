// AI 分析按钮占位（v1.0 灰态；v1.1 接云端 API，v1.2 接 Codex 深挖）
export default function AiButton({ label = "AI 分析", deep = false }) {
  return (
    <button className={`ai-btn ${deep ? "ai-deep" : ""}`} disabled title={deep ? "v1.2 Codex 深挖" : "v1.1 云端 AI 分析"}>
      <span>{deep ? "🔬 Codex 深挖" : `⚡ ${label}`}</span>
      <span className="ai-soon">{deep ? "v1.2" : "v1.1"}</span>
    </button>
  );
}
