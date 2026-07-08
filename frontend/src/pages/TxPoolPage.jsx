import { useState } from "react";

export default function TxPoolPage() {
  const [node, setNode]     = useState("");
  const [address, setAddress] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  async function query() {
    if (!node) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`/api/txpool/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node, address }),
      });
      setResult(await res.json());
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="subpage">
      <div className="subpage-header">
        <h1>TxPool Query</h1>
        <p>查询节点交易池状态、pending/queued 分布、指定地址 pending tx</p>
      </div>

      <div className="subpage-body">
        <div className="query-card">
          <div className="query-form">
            <div className="form-row">
              <label>Node RPC</label>
              <input
                className="form-input"
                placeholder="http://10.211.x.x:8545"
                value={node}
                onChange={e => setNode(e.target.value)}
              />
            </div>
            <div className="form-row">
              <label>Address</label>
              <input
                className="form-input"
                placeholder="0x… (optional, filter by sender)"
                value={address}
                onChange={e => setAddress(e.target.value)}
              />
            </div>
            <button className="btn-primary" onClick={query} disabled={loading || !node}>
              {loading ? "Querying…" : "Query"}
            </button>
          </div>

          {result && (
            <pre className="query-result">
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>

        <div className="placeholder-note">
          <span className="ph-icon">🚧</span>
          <div>
            <div className="ph-title">功能设计中</div>
            <div className="ph-desc">将展示：pending/queued 数量趋势、gas price 分布、stuck tx 检测、指定地址 nonce gap 分析</div>
          </div>
        </div>
      </div>
    </div>
  );
}
