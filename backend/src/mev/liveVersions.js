/**
 * 出块版本的实时校正。
 *
 * 全网版本分布来自出块 extraData,只在该 validator 出块时更新:cabinet 每几分钟出一次块
 * 所以很新,但 candidate 靠 shuffle 偶尔才轮到出块,上次出块可能已是几小时前 ——
 * 升级完成后版本仍会显示升级前的旧值。自营节点 keter 有 30s 级实时版本,用它覆盖。
 *
 * 只认服役中的机器(miningFeatures 带 MEV|FFVoting|Mining):同一 etherbase 下的待命备机
 * 版本不代表出块版本,不能拿来覆盖。
 */

const VER_RE = /BSC\/v?(\d+\.\d+\.\d+)/i;
const SERVING_RE = /MEV|FFVoting|Mining/i;
const norm = (v) => String(v).replace(/^v/, "");

// etherbase(小写) → 实时版本,仅收服役中的自营节点
export function liveVersionMap(nodeStats) {
  const live = {};
  for (const n of nodeStats ?? []) {
    const eb = (n.etherbase || "").toLowerCase();
    if (!eb || !SERVING_RE.test(n.miningFeatures || "")) continue;
    const m = VER_RE.exec(n.nodeType || "");
    if (m) live[eb] = m[1];
  }
  return live;
}

// 用实时版本改写 stats.minerVersions 并重算 versions 分布;无可改写时原样返回
export function applyLiveVersions(stats, nodeStats) {
  if (!stats?.minerVersions) return stats;
  const live = liveVersionMap(nodeStats);
  const minerVersions = { ...stats.minerVersions };
  let livePatched = 0;
  for (const [addr, ver] of Object.entries(minerVersions)) {
    const v = live[addr.toLowerCase()];
    if (v && v !== norm(ver)) { minerVersions[addr] = v; livePatched++; }
  }
  if (!livePatched) return stats;

  const vCount = {};
  for (const v of Object.values(minerVersions)) vCount[norm(v)] = (vCount[norm(v)] || 0) + 1;
  const vTotal = Object.values(vCount).reduce((a, b) => a + b, 0);
  const versions = Object.entries(vCount)
    .map(([ver, n]) => ({ ver, n, pct: vTotal ? Math.round((n / vTotal) * 100) : 0 }))
    .sort((a, b) => b.n - a.n);
  return { ...stats, minerVersions, versions, livePatched };
}
