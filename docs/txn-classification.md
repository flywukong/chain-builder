# 交易分类逻辑(交易分析子系统)

「交易」页把 BSC 主网交易按 **9+1 类**归类,展示 7 天流量结构。本文档说明采样方式、每一类的判定逻辑与优先级,以及 AI 标签库的工作机制。

代码位置:`backend/src/txn/`(`sampler.js` 采样 / `classifier.js` 规则分类 / `labels.js` 标签库 / `store.js` 存储 / `siglookup.js` 签名反查),AI 归类入口在 `server.js` `pollContractLabels`。

## 1. 数据采集

- **全量覆盖**:每分钟一个 tick,并发(10 路)抓取**过去一分钟产生的全部区块**(0.45s 出块 ≈ 133 块/分钟),每块 `eth_getBlockByNumber(full)` + `eth_getBlockReceipts`,约 2 次 RPC/块(~38 万 RPC/天)
- 按**区块自身时间戳**归入小时桶(并发乱序/跨小时边界安全);单 tick 落后超过 300 块时跳到最新(保新弃旧)
- 抓取失败的块跳过并记日志;写盘节流 3s,7 天滚动持久化(`backend/data/txn-7d.json`)
- 统计数字为**真实全量笔数**(此前为每分钟采样 1 块的结构占比,2026-07-08 起全量)

## 2. 分类定义

| 类别 | key | 含义 |
|---|---|---|
| Meme | `meme` | meme 币发射台/交易(four.meme 等) |
| DeFi | `defi` | DEX swap/聚合器/借贷/质押/账户抽象 |
| 预测市场 | `predict` | predict.fun 全套合约(CTFExchange/ConditionalTokens/NegRisk 系,主网 28 地址,源 dev.predict.fun) |
| Bot | `bot` | 套利/夹子/keeper/oracle 等自动化机器人 |
| 稳定币 | `stable` | USDT/USDC/BUSD/DAI/FRAX 合约上的操作 |
| BNB 转账 | `bnb` | 纯原生转账(gasUsed = 21000) |
| 代币转账 | `token` | ERC20 转账及**包含** Transfer 事件且无 Swap 的合约调用(分发/游戏/claim 等) |
| CEX 充提 | `cex` | 交易所热钱包参与(from 或 to)。**优先级高于 stable/token**:Binance 热钱包转 USDT 归 cex 不归 stable(按"充提行为"而非资产类型) |
| Bridge | `bridge` | 跨链桥。**TokenHub 0x…1004 有意归此类**(跨链流量单列),不在 system 里 |
| 系统交易 | `system` | BSC 系统合约 0x…1000-1008(除 1004)及 0x…2000-2005(validator 分账 deposit、slash 等) |
| 其他 | `other` | 以上均未命中 |

## 3. 规则判定(classifier.js,按优先级)

对每笔交易依次检查,**先命中先归类**:

1. **合约部署**:`to == null` → `other`
2. **系统交易**:`to ∈ 系统合约集合(0x…1000-1008, 0x…2000-2005)` → `system`
   - 典型:每块最后一笔 `ValidatorSet.deposit(address)`(selector `0xf340fa01`),稳定占全网 ~1.3%
3. **CEX**:`from` 或 `to` 命中交易所热钱包地址库 → `cex`(双向覆盖充值/提现)
4. **标签库命中**:`to` 在标签库(静态 + AI 学习)且 cat ≠ other → 直接用库里分类
   - 静态库:PancakeSwap 全家桶/Venus/Lista → defi;four.meme → meme;稳定币合约 → stable;ERC-4337 EntryPoint → defi;TokenHub → bridge
   - AI 学习标签为 `other` 的**不作终判**,继续走下面规则(留给 AI 带新特征重评)
5. **Bot(行为特征)**,满足任一:
   - **短 selector** `0x000000xx`(gas-golfed MEV bot 的标志性优化)
   - 同一 `from` 在**单块内 ≥3 笔**的**合约调用**(套利/夹子高频特征)。
     纯转账(21000 gas)与标准 `transfer/transferFrom` 即使高频也**不算** bot —— 交易所归集、批量分发、活动脚本放行给 bnb/token
6. **Swap 事件 → DeFi**:receipt logs 含 V2/V3 Swap 签名
   - `V2 Swap = 0xd78ad95f…`、`V3 Swap = 0xc42079f9…`
   - 覆盖:直调 pool、聚合器、未收录的新 router(bot 已被上一步截获,剩余 swap 视为 DeFi 活动)
7. **BNB 转账**,满足任一:
   - `gasUsed == 21000`(纯原生转账的精确指纹;无 receipt 时用 `input == 0x` 近似)
   - `input == 0x` 且无事件日志且 `gasUsed ≤ 30000`(简单合约钱包 receive 收款)。
     带 calldata 的原生转账、复杂 receive/fallback 仍会落到 other,占比极小
8. **代币转账**,满足任一:
   - selector 为 `transfer(0xa9059cbb)` / `transferFrom(0x23b872dd)`
   - receipt **包含 Transfer 事件**(`0xddf252ad…`)且无 Swap → 分发/游戏/claim 类合约调用(注意是"包含"而非"仅有",可能伴随 Approval/自定义事件)
9. 兜底 → `other`

## 4. AI 标签库(滚雪球)

规则解决不了的热门合约交给 AI,结果持久化,**越跑越准**:

- **触发**:启动 10 分钟后首跑,此后每 2 小时一轮;失败 15 分钟后重试一次
- **候选**:近 24h `other` 类调用量 top30 的合约(learned-other 会重新入选,带新特征重评)
- **喂给 AI 的特征**(每个候选):
  - `n` 调用次数、`swapLogs`/`transferLogs` 事件计数
  - `topSelectors` 高频方法选择器 + **openchain.xyz 反查的方法签名**(如 `checkIn()`、`updatePrices(uint256)`、`matchOrders(...)`)
  - `codeType`:**EIP-7702 delegated EOA**(code 前缀 `0xef0100`,自动化钱包强信号)/ EOA / 合约字节码大小
- **AI 判据优先级**:知名地址直接定名 → 方法签名语义(updatePrices/fulfill → bot;matchOrders/swap → defi;checkIn/claim/airdrop → token)→ swap 特征 → 无事件单一 selector 高频 → bot → vanity 地址偏 bot
- **约束**:不认识不编造名字(标 other 等下轮);输出严格 JSON;AI 标注在前端带 ✦ 标记
- 落库:`backend/data/contract-labels.json`,重启加载,与静态库合并使用

## 5. 已知误差与边界

- **长尾小合约**要靠多轮 AI 收编,`other` 占比随运行时间收窄(上线首日 59% → 规则+签名反查后 ~7%)
- 2026-07-08 之前的历史小时桶是"每分钟 1 块"采样口径,绝对笔数与全量时段不可直接对比(占比可比)
- `bot` 的"单块 ≥3 笔合约调用"是启发式;纯转账/标准 transfer 已排除,但高频调用应用合约的真人(如抢购)仍可能误伤
- 历史小时桶**不重算**:分类规则/标签更新只影响新采样;7 天图里旧时段保持当时口径
- 签到/空投类活动(如 `checkIn()` 大量独立地址调用)归类存在模糊性:大规模脚本刷活动判 bot,正常活动分发判 token,以 AI 按调用方分散度裁量
