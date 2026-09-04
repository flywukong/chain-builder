# Txn 开发者流量分析 v2

## 产品目标

该页面回答三个问题：BSC 的开发者需求集中在哪里，具体流量进入哪些协议/合约/Method，以及哪些调用在失败、变贵或刚刚出现。

页面采用四层数据模型，但只把最后一层投影为一张互斥主分类表：

1. **交易事实**：交易输入、receipt 状态、gasUsed、selector、事件签名和参与地址。
2. **可观察行为**：Swap/Transfer/Approval/NFT/ERC1155 等事实特征，可重叠。
3. **可信语境**：人工或官方来源核实的协议、合约角色和资产身份。
4. **主分类投影**：按固定优先级给业务交易选择一个主分类，作为 100% 分布的唯一分母。

地址命中只能证明协议归属。只有该合约的 selector/event 已人工核实，才能给出“下单、成交、赎回”等具体业务动作。OpenChain 的签名只作为技术入口名，不自动等同于业务语义。

## 主分类口径

BSC 系统合约交易不服务开发者需求，因此保留底层事实但从主分类、热门合约和 Method 的分母中排除。

| 优先级 | 主分类 | 判定依据 |
| --- | --- | --- |
| 1 | 合约部署 | `tx.to == null` |
| 2 | 预测市场 | 命中已核实预测市场协议合约；Method 仅用于下钻 |
| 3 | Bridge 协议交互 | 命中已核实 Bridge 合约；跨链动作需额外 method/event 证据 |
| 4 | Meme Launchpad | 命中 four.meme 等已核实管理器/工厂 |
| 5 | Builder 收款 | 正 value、空 calldata，且收款地址已核实 |
| 6 | DeFi 协议交互 | 命中已核实非 token DeFi 合约，或 receipt 出现明确 Swap 事件 |
| 7 | 基础设施交互 | 命中已核实 AA EntryPoint 等基础设施合约 |
| 8 | 稳定币转账 | 已核实稳定币合约的标准 Transfer 调用或事件 |
| 9 | Token/NFT 转移 | 标准 Transfer selector 或明确 Transfer 事件 |
| 10 | BNB 转账 | 正 value、空 calldata、`gasUsed == 21000` |
| 11 | 其他合约调用 | 以上均未命中 |

该表是“业务赛道 + 技术形态”的开发者流量投影，不替代底层事实。协议交互可能同时出现 Transfer/Swap 等事件；这些特征在第五个面板独立统计，不重复占主分类分母。

Bot、MEV、三明治和 CEX 身份/资金流都不是主分类。缺少高置信证据时不输出 Bot 或三明治结论。

## 五个页面功能

1. **BSC 流量结构**：主分类交易数/占比、Gas 总量/占比、成功率/失败率、P50/P95 gasUsed、活跃发送者估算和前一等长窗口变化。
2. **热门协议/合约/Method**：从赛道逐级下钻；协议来自核实地址，Method 签名是技术入口，已核实业务动作单独标注。
3. **失败与 Gas 分析**：失败最多和 Gas 消耗最高的 Method，并展示 Method 级失败率与 P50/P95。
4. **新流量与未知调用**：新增热门合约、未识别 selector、首次进入当前窗口的事件签名；只有前一等长窗口完整时才给“新增”结论。
5. **交易事实与特征分析**：Swap/Transfer/Approval/NFT/ERC1155 覆盖率、可信资产/CEX 地址触达和少量可审计交易样本。

活跃发送者使用每类每小时 1024-register HyperLogLog，仅保存约 1KB 草图，标准误差约 3.25%，不会保存地址集合。Gas 分位使用每小时有界蓄水池，并按小时交易量加权合并。聚合数据保留 31 天；每个 Method 最多保留 3 个交易哈希作为审计样本。

## 20 天回填

默认回填 20 天，并在完成后依靠在线采集自然累积到 30 天：

```bash
cd backend
TXN_BACKFILL_CONFIRM=YES \
BSC_RPC_URL=http://your-archive-node \
npm run backfill:txn
```

可选参数：

```bash
TXN_BACKFILL_DAYS=20
TXN_BACKFILL_CONCURRENCY=24
TXN_BACKFILL_BATCH=600
TXN_BACKFILL_RESET=YES
```

回填以固定目标块的链上时间向前精确取 20 天。区块和 receipt 使用有界并发与 JSON-RPC batching；连续失败时并发自动减半到最低 4，稳定 8 批后每次恢复 4。任务可断点续跑，结果写入带分类版本的临时快照；只有覆盖范围连续且临时文件持久化成功后，才原子合并到主聚合文件。离线回填不写逐笔事实 journal，也不运行旧 Bot 分类。

新口径版本与旧回填 checkpoint 不兼容。上线本版本时应停止旧回填，使用新的版本化 checkpoint 重跑 20 天；不需要等待旧的 30 天任务结束。

## 在线存储边界

长期保存的是小时聚合，不是完整交易。在线采集仍保留最近 24 小时的紧凑事实 journal，用于分类器或核实地址表更新后的安全重放；它不是完整 RPC 交易/receipt，过期按小时删除。20 天离线回填只产生聚合快照。
