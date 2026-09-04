# Txn 交易分类行业方法论与改造建议

> 调研日期：2026-08-30
> 适用项目：BSC Monitor / Txn 分析
> 目标：调研业界和学术界较为科学的链上交易分类方法，并给出适合当前项目的分类本体、证据体系、评估方法和实施路线。

## 1. 结论先行

业界较成熟的方案不会把每笔交易强制塞入一个混合语义的 `cat`，而是采用：

1. **链上事实分层**：保存交易、receipt、event log、trace 等原始事实，再进行 ABI 解码和业务解释；
2. **多维、多标签分类**：分别描述交易动作、协议、资产、参与者和资金流语义；
3. **确定性事实与概率推断分离**：事件解码和已核实地址属于事实层，Bot、MEV、实体归属等属于推断层；
4. **结果可审计、可版本化**：每个标签保存来源、证据、置信度、规则版本和有效期；
5. **通过标注集量化准确性**：使用 Precision、Recall、F1、覆盖率、混淆矩阵和时间外测试，而不是根据最终占比是否“看起来合理”判断准确性。

当前项目的主要结构性问题，是把不同维度混入一个互斥分类：

| 当前类别 | 实际维度 | 更合理的表达 |
|---|---|---|
| Bot | 参与者行为 | `actor_type=bot` |
| DeFi | 应用领域，粒度过宽 | 拆成 `swap`、`liquidity`、`lending`、`staking` 等动作 |
| 代币转账 | 链上动作 | `activity=token_transfer` |
| BNB 转账 | 动作和资产 | `activity=native_transfer`、`asset=BNB` |
| 稳定币合约 | 资产属性 | `asset_type=stablecoin` |
| Infra/Builder | 实体或服务类型 | `actor_type=builder` 或 `service_type=infra` |
| 预测市场 | 协议领域 | `protocol_category=prediction_market` |
| Meme | 资产属性 | `asset_type=meme` |
| 系统交易 | 合约或参与者角色 | `actor_type=system_contract` |
| CEX 充提 | 资金流语义 | `flow_type=cex_deposit/cex_withdrawal` |
| Bridge | 交易动作和协议 | `activity=bridge_deposit/bridge_withdrawal` |

一笔交易可以同时是：

```text
activity   = swap
protocol   = pancakeswap_v3
asset_type = meme
actor_type = mev_bot
flow_type  = dex_trade
```

这些标签描述不同维度，不应通过分类优先级相互覆盖。

## 2. 业界方案调研

### 2.1 Dune：Raw、Decoded、Curated 三层数据模型

Dune 将链上数据划分为三个主要层次：

| 层次 | 内容 | 主要用途 |
|---|---|---|
| Raw | block、transaction、log、trace | 保留完整链上事实，支持重算和自定义分析 |
| Decoded | 通过已验证 ABI 解码的函数调用和事件 | 识别协议调用、参数和业务动作 |
| Curated | DEX、借贷、Bridge、CEX Flow 等标准化模型 | 跨协议、跨链统计和产品查询 |

Dune 的 DEX 数据不是通过一个通用 `Swap` topic 将整笔交易归为 DeFi，而是由协议专属模型解码各协议事件，再统一映射到标准 schema。多跳交易中的每一个 liquidity hop 可以形成一条独立的 trade 记录。

这说明成熟的数据模型会同时保留：

- 外层交易 `tx_hash`；
- 发起人 `tx_from` 和第一层调用对象 `tx_to`；
- 实际产生事件的 pool/router；
- 买卖资产、数量、maker、taker；
- 协议名称和版本；
- 事件在交易中的顺序。

参考资料：

- [Dune Data Catalog](https://docs.dune.com/data-catalog/overview)
- [Dune Curated Data Overview](https://docs.dune.com/data-catalog/curated/overview)
- [Dune DEX Data Methodology](https://docs.dune.com/data-catalog/curated/dex-trades/overview)
- [Dune `dex.trades` Schema](https://docs.dune.com/data-catalog/curated/dex-trades/evm/dex-trades)

### 2.2 Nansen：地址标签、行为标签和实体分开

Nansen 的地址画像允许一个地址同时拥有多项标签，例如：

- 实体标签：Binance、基金、做市商、具体协议；
- 行为标签：MEV Bot、NFT Whale、Smart Trader；
- DeFi、CEX 等业务标签；
- 多个相关地址进一步聚合为一个 Entity。

这种方式没有要求“Binance”和“Bot”互斥，也没有把地址属性直接等同于某一笔交易的业务动作。

参考资料：

- [Nansen Core Concepts](https://docs.nansen.ai/getting-started/core-concepts)
- [Nansen Address Labels](https://docs.nansen.ai/api/profiler/address-labels)

### 2.3 Chainalysis：结构事实、实体归属和运营关系分离

Chainalysis 将常被笼统称作“地址聚类”的结论拆成不同分析操作：

1. **地址分组**：多个地址是否由同一个主体控制；
2. **实体归属**：这个地址或地址组是否对应某个现实实体；
3. **运营者判断**：谁控制密钥和钱包基础设施；
4. **受益者判断**：谁是某个充值地址或资金流的实际受益者。

这些判断需要不同证据。例如，用户的 CEX 充值地址可能由交易所运营，但资金受益者是用户。如果把“运营者”和“受益者”混为一谈，标签沿地址集扩散后会造成严重误归属。

Chainalysis 还强调：

- 结构性结论应尽量确定、可复现；
- 实体归属必须记录情报来源和置信度；
- 机器学习适合产生调查候选和行为概率，不应独立成为不可审计的结构事实；
- 在高风险归属场景下，宁可保持未知或少聚类，也不要把一个错误地址扩散到整个实体。

参考资料：

- [Defining the Cluster: A Formal Ontology](https://www.chainalysis.com/reports/defining-the-cluster/)
- [Chainalysis Address Clustering](https://www.chainalysis.com/glossary/address-clustering/)

### 2.4 学术界：弱监督和图行为分类

当类别依赖多条不完全可靠的规则时，学术界常使用弱监督方法。以 Snorkel 为例，每条启发式规则、外部地址库或模型输出都被视为一个 labeling function：

```text
LF_swap_event       -> activity.swap
LF_known_router     -> protocol.pancakeswap
LF_bot_frequency    -> actor.bot, weak signal
LF_mev_cycle        -> actor.mev_bot, strong signal
LF_stablecoin_token -> asset.stablecoin
LF_cex_beneficiary  -> flow.cex_deposit
```

不同 labeling function 可以覆盖不同样本，也可以冲突或主动放弃判断。系统根据它们的历史表现、相关性和标注集结果组合证据，而不是依赖一条固定的 `if/else` 优先级链。

参考资料：[Snorkel: Rapid Training Data Creation with Weak Supervision](https://dawn.cs.stanford.edu/publications/snorkel/snorkel-rapid-training-data-creation-weak-supervision)

Bot、MEV、CEX 归集和恶意账户属于地址或实体的长期行为，通常需要：

- 时间间隔和区块内位置；
- 交易频率、nonce 和失败率；
- selector、协议和对手方分布；
- 资金循环和归集路径；
- 地址交互图或局部子图；
- 跨时间窗口的稳定性。

Ethereum 地址识别研究也通常将问题建模为账户交互图上的节点或子图分类，而不是只判断一笔交易的 `tx.to` 或单块调用次数。

参考资料：[Ethident: Behavior-aware Account De-anonymization on Ethereum Interaction Graph](https://arxiv.org/abs/2203.09360)

## 3. 推荐的分类本体

### 3.1 交易动作 `activity`

动作描述“链上实际发生了什么”，主要来自 receipt、log、trace 和 ABI 解码。

建议一级分类：

```text
native_transfer
token_transfer
swap
liquidity_add
liquidity_remove
lending_supply
lending_withdraw
borrow
repay
liquidation
stake
unstake
bridge_deposit
bridge_withdrawal
prediction_trade
nft_transfer
nft_trade
mint
burn
contract_deploy
contract_admin
governance
account_abstraction
system_operation
unknown
```

一笔外层交易可能含有多个 activity。例如聚合器交易可能依次经过两个 pool，并伴随 fee transfer。系统应保留全部 activity，同时选出一个用于互斥面板的 `primary_activity`。

### 3.2 协议 `protocol`

协议维度描述“通过哪个协议完成”：

```text
protocol_name     = pancakeswap
protocol_version  = v3
protocol_category = dex
contract_role     = router | pool | vault | token | factory
```

协议识别应优先使用：

1. 已验证地址和官方部署信息；
2. factory 创建关系；
3. proxy implementation 和 admin 关系；
4. ABI、函数和事件组合；
5. 单独的协议 adapter；
6. AI 候选识别，仅用于待核验队列。

### 3.3 资产 `asset`

资产标签和交易动作分离：

```text
native
stablecoin
meme
fungible_token
nft
wrapped_native
liquid_staking_token
rwa
unknown
```

例如 PancakeSwap 上买卖 Meme 币，应统计为：

```text
activity=swap
protocol=pancakeswap
asset_type=meme
```

不能在 `defi` 和 `meme` 中二选一。

### 3.4 参与者和实体 `actor/entity`

参与者标签描述“谁在操作”或“地址承担什么角色”：

```text
human
bot
mev_bot
keeper
oracle
market_maker
cex
builder
system_contract
protocol_treasury
unknown
```

建议进一步保存：

```text
entity_name
entity_category
address_role
operator_entity
beneficiary_entity
label_source
confidence
valid_from
valid_to
```

### 3.5 资金流语义 `flow_type`

资金流语义描述某次 transfer 在上下文里的意义：

```text
cex_deposit
cex_withdrawal
bridge_inflow
bridge_outflow
protocol_deposit
protocol_withdrawal
fee_payment
builder_payment
reward_distribution
airdrop
unknown
```

例如用户向 Binance 充值 USDT：

```text
activity   = token_transfer
asset_type = stablecoin
entity     = Binance
flow_type  = cex_deposit
```

这比把整笔交易简单归为 `cex` 或 `stable` 更完整。

## 4. 推荐的数据模型

建议保留以下核心数据实体：

```text
transactions
  外层交易、状态、gas、区块、from/to、input

transaction_activities
  一笔交易解码出的一个或多个业务动作

activity_assets
  每个 activity 涉及的资产、数量和角色

address_labels
  地址标签、标签来源、置信度和有效期

entity_memberships
  地址与实体之间的关系及证据

classification_evidence
  每个分类结论对应的规则、日志、trace、模型和版本
```

推荐的交易分类输出示例：

```json
{
  "tx_hash": "0x...",
  "status": "success",
  "primary_activity": "swap",
  "activities": [
    {
      "type": "swap",
      "protocol": "pancakeswap",
      "version": "v3",
      "confidence": 1.0,
      "evidence": [
        "decoded PancakeSwap V3 Swap event",
        "pool created by verified factory"
      ]
    }
  ],
  "actor_labels": [
    {
      "type": "mev_bot",
      "confidence": 0.87,
      "evidence": ["behavior-model-v3"]
    }
  ],
  "asset_labels": ["meme"],
  "flow_labels": ["dex_trade"],
  "classifier_version": "2026-09-01",
  "label_version": "address-registry-42"
}
```

## 5. 分类证据体系

建议将证据划分为三个等级。

### A 级：确定性事实

包括：

- receipt 状态和 Gas；
- event log 及完整参数；
- trace/internal call；
- 经过 ABI 解码的函数和事件；
- 已核实的官方合约地址；
- factory 创建关系；
- proxy implementation/admin 关系；
- BSC 系统合约源码或链上常量。

A 级结论可以直接进入生产统计，但仍应保存解析器版本。

### B 级：强规则推断

包括：

- 多个独立信号共同支持的协议或实体判断；
- 充值地址到归集钱包的稳定路径；
- 已记录适用条件和失败模式的行为规则；
- 经过人工抽样验证、Precision 达到门槛的规则。

B 级结果应保存规则名称、证据集合、置信度和已知失败条件。

### C 级：模型或 AI 推断

包括：

- Bot/MEV 行为概率；
- 未知协议和实体候选；
- AI 根据 selector、源码名称和行为特征生成的建议标签；
- 图模型生成的关联地址候选。

C 级结果应该：

- 默认作为候选或 overlay；
- 带置信度和模型版本；
- 对高流量地址优先人工核验；
- 低置信度时保留 `unknown`；
- 不直接覆盖 A 级事实。

## 6. 统计口径设计

### 6.1 区分交易数和动作数

建议至少同时提供：

```text
transaction_count = COUNT(DISTINCT tx_hash)
activity_count    = COUNT(activity rows)
```

多跳 swap 在 `transaction_count` 中是一笔，在 `activity_count` 中可能包含多个 pool hop。

### 6.2 哪些指标可以归一到 100%

只有定义了唯一 `primary_activity` 的交易动作分布适合归一到 100%。

以下维度允许重叠，不应要求合计为 100%：

- Bot/CEX/Builder 等参与者覆盖率；
- Meme/Stablecoin/NFT 等资产覆盖率；
- 一笔交易涉及多个协议时的协议触达率；
- 风险、行为和资金流标签。

### 6.3 Gas 口径

复杂交易的总 Gas 天然属于外层交易。面板必须明确采用哪一种方法：

1. 将整笔交易 Gas 归给 `primary_activity`；
2. 使用 trace 估算各子调用消耗；
3. 只展示每类交易的平均/中位 Gas，不尝试多动作拆分。

不能在多个重叠标签中重复计入整笔 Gas 后，再将结果解释为互斥 Gas 结构。

### 6.4 失败交易

失败交易应区分：

```text
activity_intent    根据 input/目标协议识别的尝试动作
executed_activity  根据成功 receipt/log/trace 识别的实际动作
```

`receipt.status=0` 时可以统计失败意图，但不能当成已经完成的 swap、充值或 bridge transfer。

## 7. 科学评估体系

分类准确性必须建立在人工核验的 gold set 上。

### 7.1 Gold set 构建

建议抽样同时覆盖：

- 各主要类别；
- 高频合约和长尾合约；
- 不同协议和版本；
- 成功与失败交易；
- 普通交易和 multicall/聚合器交易；
- 最近数据和历史数据；
- 高置信与低置信样本。

关键类别建议由两名标注者独立判断，冲突样本由第三方裁决，并保留标注证据。

### 7.2 核心指标

每个类别单独报告：

```text
Precision = 被预测为该类的样本中有多少是真的
Recall    = 真实属于该类的样本中有多少被识别
F1        = Precision 和 Recall 的调和平均
Coverage  = 系统给出有效判断的样本比例
Abstain   = 系统主动保留 unknown 的比例
```

还应提供：

- 混淆矩阵；
- 宏平均指标，避免大类别掩盖小类别；
- 交易量加权指标，反映面板总体影响；
- Gas 加权指标，反映 Gas 结构误差；
- 高频合约与长尾合约分层指标；
- 模型置信度校准指标；
- 按 classifier/label 版本的回归结果。

### 7.3 防止评估泄漏

建议使用：

- 时间外测试：用后续时间窗口检验旧规则；
- 协议外测试：留出部分协议检验泛化能力；
- 地址外测试：避免同一个地址同时出现在训练集和测试集；
- shadow evaluation：新规则先旁路运行，不立即影响正式面板；
- 固定回归集：每次发布前检查已有类别是否退化。

在未知协议快速变化的链上环境中，一个可信的 `unknown` 通常比错误地归为 DeFi 更有价值。

## 8. 对当前项目的改造建议

### 阶段一：调整分类本体和统计口径

1. 保留旧 `cat` 兼容字段，同时新增：
   - `primaryActivity`；
   - `activities[]`；
   - `actorLabels[]`；
   - `assetLabels[]`；
   - `flowLabels[]`；
2. 解析完整 event 参数，不只判断 `topics[0]`；
3. 保存证据、置信度、classifier version 和 label version；
4. 明确失败交易的 intent/executed 口径；
5. 将面板拆为动作、参与者、资产和协议四个维度。

### 阶段二：加强确定性解析

1. 引入 trace/internal call；
2. 对 PancakeSwap、Venus、Lista、Prediction Market、Bridge 等建立协议 adapter；
3. 维护可审计的地址与实体注册表；
4. 解析 factory、proxy、implementation 和合约角色；
5. 建立固定 gold set 和自动回归评估。

### 阶段三：引入行为模型

1. Bot/MEV 使用跨区块时间窗口，不再只看单块 `from` 次数；
2. 增加 selector 分布、对手方、失败率、资金循环和交互图特征；
3. 将现有启发式改造成可独立评估的 labeling functions；
4. AI 主要负责未知地址发现、解释和主动学习候选；
5. 只有经过人工核验或达到规定阈值的标签，才能提升为正式统计标签。

## 9. 对产品展示的建议

建议把当前单一“交易类型分布”调整为以下四组指标：

### 交易动作分布

使用唯一 `primary_activity`，可以合计为 100%：

```text
Native Transfer / Token Transfer / Swap / Lending / Bridge /
Staking / Prediction / Contract / System / Unknown
```

### 参与者覆盖率

允许重叠：

```text
Bot / MEV / CEX / Builder / Keeper / System / Unknown
```

### 资产结构

允许一笔交易涉及多种资产：

```text
Stablecoin / Meme / Native / NFT / LST / RWA / Other
```

### 协议结构

按可核实协议统计：

```text
PancakeSwap / Venus / Lista / Prediction Markets / Bridges / Other
```

对于外部展示，建议使用以下口径说明：

> 交易动作由链上 receipt、事件和调用轨迹解码；参与者、实体和资产属性为可重叠标签。模型推断结果带置信度，未知或证据不足的交易保留为 Unknown。

## 10. 最终判断

当前项目不应该继续仅通过补地址、补 selector 的方式扩展现有 12 类互斥 `cat`。这样虽然可以短期降低 `other`，但会进一步放大以下语义冲突：

- Bot 与 DeFi；
- Meme 与 DeFi；
- CEX 与 Stablecoin/Token Transfer；
- Infra/Builder 与具体业务动作；
- 地址属性与单笔交易行为。

更合理的演进方向是：

```text
原始链上事实
  -> ABI/事件/trace 解码
  -> 协议级 activity
  -> 地址与实体知识层
  -> 行为模型和 AI 候选层
  -> 多维标签
  -> 按指定维度聚合展示
```

AI 不是越多越科学。对当前项目而言，优先级应当是：

1. 先建立正确的分类本体；
2. 再补齐 receipt/log/trace 等可复现事实；
3. 建立 gold set 和评估指标；
4. 最后才使用 AI 或图模型扩大覆盖率。

当前实现的具体代码问题和各类别可信度，可继续参考 [Txn 分类准确性 Review](../txn-classification-review.md)。
