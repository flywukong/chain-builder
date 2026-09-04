/**
 * Sandwich detection — 移植自 bsc-trace-bk internal/logic/mev(生产验证过的算法)。
 *
 * 四类三明治按(同/跨块 × 同/异 trader)划分,全部要求 front/back 的 altcoin
 * 数量在 1% 内匹配 —— attacker 大致回吐 front 库存是三明治的物理特征,
 * 套利 bot 反向多 hop 的数量差通常 90%+,不会误中(阈值演进史见原库 amount.go)。
 *
 * 输入是 fact.swaps(采集时从 Transfer 净流量聚合出的 {pool, tokenIn, amtIn,
 * tokenOut, amtOut}),协议无关:任何发 V2/V3 风格 Swap 事件的池子都覆盖。
 * 检测窗口 = 当前块 + 前一块(Type 3/4 跨相邻块);每个命中只在 back 所在块 emit,
 * 天然去重。victim 反查最近合法 (front, back) 对,避免连续多 victim 漏检。
 */

import fs from "fs";
import path from "path";

// base 侧候选(与 alt 相对):wrapped native + 主流稳定币。双 base 池取 WBNB 为 alt,
// 全稳定币池跳过(三明治主战场是 alt 池,损失可忽略)。
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const BASES = new Set([
  WBNB,
  "0x55d398326f99059ff775485246999027b3197955",   // USDT
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",   // USDC
  "0xe9e7cea3dedca5984780bafc599bd69add087d56",   // BUSD
  "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409",   // FDUSD
  "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",   // USD1
  "0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3",   // DAI
]);

const BUY = 1, SELL = 2;

// |a-b| * 100 <= max(|a|,|b|) —— 1% 容差(V2 0.3% fee ×双向 + 滑点 + 攻击者仓位合并)
export function isAmountClose(a, b) {
  if (a == null || b == null) return false;
  const diff = a > b ? a - b : b - a;
  if (diff === 0n) return true;
  const max = a > b ? a : b;
  return diff * 100n <= max;
}

// fact.swaps 条目 → 检测用 Swap;确定 (alt, side, altAmount),不构成 alt 池返回 null
export function toSwap(fact, s) {
  const inBase = BASES.has(s.ti), outBase = BASES.has(s.to);
  let alt = null, side = null, amt = null;
  if (inBase && !outBase) { alt = s.to; side = BUY; amt = s.ao; }        // base 进 alt 出 → trader 买入 alt
  else if (!inBase && outBase) { alt = s.ti; side = SELL; amt = s.ai; }  // alt 进 base 出 → trader 卖出 alt
  else if (inBase && outBase) {
    if (s.ti === WBNB) { alt = s.ti; side = SELL; amt = s.ai; }
    else if (s.to === WBNB) { alt = s.to; side = BUY; amt = s.ao; }
    else return null;                                                    // 全稳定币池
  } else { alt = s.to; side = BUY; amt = s.ao; }                         // 双非 base(alt/alt 池):按流出侧近似
  let amount;
  try { amount = BigInt(amt); } catch { return null; }
  if (amount <= 0n) return null;
  return { block: fact.b, txIndex: fact.i, trader: fact.f, pool: s.p, alt, side, amount, t: fact.t };
}

const opposite = (s) => (s === BUY ? SELL : s === SELL ? BUY : 0);

// 对(相邻两块内的)一组 swaps 跑四类检测;只 emit back 落在 curBlock 的命中
export function detect(swaps, curBlock) {
  const groups = new Map();   // pool|alt → swaps 按 (block, txIndex) 升序
  for (const s of swaps) {
    const k = `${s.pool}|${s.alt}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(s);
  }
  const hits = [];
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    g.sort((a, b) => (a.block - b.block) || (a.txIndex - b.txIndex));
    // victim 反查:对每个候选 victim j,先向右钉 back(反向、非本人),再向左找
    // 与 back 数量 1% 匹配、与 victim 同向的 front(原库修复的连续多 victim 漏检写法)
    for (let j = 0; j < g.length; j++) {
      const victim = g[j];
      let found = false;
      for (let k = j + 1; k < g.length && !found; k++) {
        const back = g[k];
        if (back.block !== curBlock) continue;
        if (back.side !== opposite(victim.side) || back.trader === victim.trader) continue;
        // 两轮搜 front:先钉同 trader(Type 1/3 证据更强),再放开异 trader(Type 2/4)
        for (const requireSameTrader of [true, false]) {
          for (let i = 0; i < j && !found; i++) {
            const front = g[i];
            if (front.side !== victim.side || front.trader === victim.trader) continue;
            if (requireSameTrader !== (front.trader === back.trader)) continue;
            if (!isAmountClose(front.amount, back.amount)) continue;
            const sameBlock = front.block === back.block;
            if (!sameBlock && back.block - front.block !== 1) continue;   // 只认相邻块
            hits.push({
              type: sameBlock ? (requireSameTrader ? 1 : 2) : (requireSameTrader ? 3 : 4),
              pool: front.pool, alt: front.alt, front, victim, back,
            });
            found = true;
          }
          if (found) break;
        }
      }
    }
  }
  // 原库 excludeAttackerVictims:victim 本身是别的命中的攻击腿 → 该命中判错,丢弃
  const attacker = new Set();
  for (const h of hits) {
    attacker.add(`${h.front.block}:${h.front.txIndex}`);
    attacker.add(`${h.back.block}:${h.back.txIndex}`);
  }
  return hits.filter((h) => !attacker.has(`${h.victim.block}:${h.victim.txIndex}`));
}

/**
 * SandwichTracker — 检测结果的落地层,独立于小时桶/重放体系:
 *  - attacker 地址集持久化(与 labelCloud 的 MEV Tracker 集取并集喂 labelBook.isMev)
 *  - 小时命中计数(sandwiches/victims),供面板窗口聚合
 */
export class SandwichTracker {
  constructor(file, retainMs = 31 * 86400e3) {
    this.file = file;
    this.retainMs = retainMs;
    this.addrs = {};    // attacker → { n, lastT }
    this.hours = {};    // hourKey → { hits, victims, byType: {1..4} }
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        this.addrs = raw.addrs ?? {};
        this.hours = raw.hours ?? {};
      }
    } catch { /* fresh */ }
    this._dirty = false;
  }

  record(hits) {
    for (const h of hits) {
      for (const leg of [h.front, h.back]) {
        const e = (this.addrs[leg.trader] ??= { n: 0, lastT: 0 });
        e.n++;
        if (leg.t > e.lastT) e.lastT = leg.t;
      }
      const hk = Math.floor(h.back.t / 3600e3);
      const b = (this.hours[hk] ??= { hits: 0, victims: 0, byType: {} });
      b.hits++; b.victims++;
      b.byType[h.type] = (b.byType[h.type] || 0) + 1;
    }
    if (hits.length) { this._dirty = true; this.flush(); }
  }

  flush() {
    if (!this._dirty) return;
    const cut = Date.now() - this.retainMs;
    const hkCut = Math.floor(cut / 3600e3);
    for (const hk of Object.keys(this.hours)) if (+hk < hkCut) delete this.hours[hk];
    for (const [a, e] of Object.entries(this.addrs)) if (e.lastT < cut) delete this.addrs[a];
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ addrs: this.addrs, hours: this.hours }));
      this._dirty = false;
    } catch { /* non-fatal */ }
  }

  addrSet() { return new Set(Object.keys(this.addrs)); }

  // 窗口聚合(毫秒)
  window(ms, now = Date.now()) {
    const lo = Math.floor((now - ms) / 3600e3);
    let hits = 0, victims = 0;
    const byType = {};
    for (const [hk, b] of Object.entries(this.hours)) {
      if (+hk < lo) continue;
      hits += b.hits; victims += b.victims;
      for (const [t, n] of Object.entries(b.byType ?? {})) byType[t] = (byType[t] || 0) + n;
    }
    return { hits, victims, byType, attackers: Object.keys(this.addrs).length };
  }
}
