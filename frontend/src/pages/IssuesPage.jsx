import AiButton from "../components/AiButton.jsx";

export default function IssuesPage() {
  return (
    <div className="subpage">
      <div className="subpage-head">
        <div>
          <h1>🐛 Issues / Bug Bounty</h1>
          <p>每日拉取 bnb-chain/bsc issues + Immunefi，AI triage / 优先级 / 修复思路</p>
        </div>
        <div className="ai-bar">
          <AiButton label="AI triage" />
          <AiButton deep />
        </div>
      </div>
      <div className="subpage-body">
        <div className="ph-card">
          <span className="ph-ic">🚧</span>
          <div>
            <div className="ph-title">v1.2 实现</div>
            <div className="ph-desc">GitHubFetcher 每日增量拉取 issues/bounty → CloudProvider 评优先级/分类/摘要 → <b>Codex 读本地 bsc 源码</b>做 triage/根因/修复思路。这是 Codex 深挖最大价值点。</div>
          </div>
        </div>
      </div>
    </div>
  );
}
