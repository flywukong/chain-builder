# Dune 链上数据模型与交易分析方法（中文解读）

> 整理日期：2026-08-31
> 适用项目：BSC Monitor / Txn 分析
> 说明：本文不是 Dune 官方文档的逐句翻译，而是面向当前项目的中文归纳，重点解释 Dune 的数据分层、DEX 建模和统计口径。

## 1. 核心结论

Dune 不会把所有交易强制归入一个唯一的业务类别，而是采用：

```text
Raw 原始事实
  -> Decoded 合约解码
  -> Curated 业务标准化
  -> 按动作、协议、资产、实体等维度查询
```

一笔交易可以同时出现在 DEX 交易、Token Transfer、Gas、地址标签和 MEV 等不同数据集中。这些数据集描述的是不同维度，不需要互斥。

这与当前 BSC Monitor 的核心区别是：当前项目从 transaction/receipt 直接产生唯一 `cat`，而 Dune 在原始数据和业务统计之间增加了完整的解码层与协议标准化层。

## 2. Dune 的三层数据结构

| 数据层 | 包含内容 | 主要用途 |
|---|---|---|
| Raw 原始层 | 区块、交易、日志、内部调用 trace | 保存完整链上事实，支持重算和自定义分析 |
| Decoded 解码层 | 使用已验证 ABI 解码函数调用和事件 | 理解合约调用、事件参数和协议交互 |
| Curated 标准化层 | DEX、借贷、Bridge、CEX Flow 等业务数据集 | 业务统计、跨协议比较和生产数据服务 |

官方文档：[Dune Data Catalog](https://docs.dune.com/data-catalog/overview)

### 2.1 Raw 原始层

Raw 层直接索引区块链节点提供的数据，例如：

```text
blocks
transactions
logs
traces
```

这一层只保存事实，不直接判断一笔交易是不是 DeFi、Bot、CEX 或 Meme。

示例：

```text
tx.from = 0xUser
tx.to   = 0xRouter
input   = 0x...
logs    = [...]
traces  = [...]
```

Raw 层的重要价值是可重放：当 ABI、地址库、协议 adapter 或分类规则升级后，可以基于历史事实重新计算，不必长期保留已经过时的分类结果。

### 2.2 Decoded 解码层

Dune 使用经过验证的合约 ABI，将 calldata、event log 和 trace 解码为可理解的函数和事件：

```text
swapExactTokensForTokens(...)
Swap(sender, amount0In, amount1Out, ...)
Transfer(from, to, value)
deposit(asset, amount, receiver)
borrow(asset, amount, ...)
```

Decoded 层回答：

- 调用了哪个函数；
- 产生了哪些事件；
- 函数和事件参数分别是什么；
- 哪个合约真正执行了动作；
- 是否经过 Router、Proxy 或聚合器；
- 内部调用了哪些 Pool 或业务合约。

它不会仅根据 `tx.to` 推断完整业务，也不会只判断 `topics[0]` 是否匹配某个事件签名。

### 2.3 Curated 标准化层

Dune 在解码结果之上建立标准化业务数据集，例如：

```text
dex.trades
dex_aggregator.trades
tokens.transfers
cex.flows
bridge.flows
lending
nft.trades
gas.fees
labels
stablecoins
```

这些是相互独立的业务视图，而不是一个互斥的 `transaction_category`。

同一笔交易可以同时出现在：

```text
dex.trades
tokens.transfers
gas.fees
labels
```

因此，“发生了 Swap”“产生了 Token Transfer”“参与者是 Bot”“资产是 Meme”可以同时成立。

## 3. Dune 如何识别 DEX 交易

Dune 不只是检查 receipt 中是否存在一个通用的 `Swap` topic，而是针对不同协议建立基础模型，例如：

```text
Uniswap V2 / V3
Curve
SushiSwap
PancakeSwap
Balancer
1inch
0x
ParaSwap
```

每个协议模型分别解析：

- Factory；
- Router；
- Pool；
- Swap 事件；
- 买卖资产和数量；
- maker/taker；
- 协议版本；
- 多跳交易路径。

解析完成后，各协议数据再统一映射到 `dex.trades` 标准 schema。

官方文档：[Dune DEX Data](https://docs.dune.com/data-catalog/curated/dex-trades/overview)

整体流程可以概括为：

```text
协议原始事件和调用
  -> 协议专属解析模型
  -> 统一业务字段
  -> dex.trades
```

而不是：

```text
发现 Swap topic
  -> 将整笔交易归类为 DeFi
```

协议专属模型的价值在于：不同 DEX 的事件签名、参数、池结构和聚合路径并不完全相同。只覆盖 Uniswap V2/V3 风格的 `Swap` topic，会漏掉其他交易模型，也无法解释交易参数和具体协议。

## 4. `dex.trades` 中一行代表什么

`dex.trades` 中的一行通常代表一次经过流动池的交易步骤，也就是一个 liquidity pool hop。

例如用户执行：

```text
USDT -> WBNB -> MEME
```

外层只有一笔交易：

```text
transaction_count = 1
```

但交易经过两个池：

```text
USDT/WBNB
WBNB/MEME
```

因此 `dex.trades` 可以产生两条 activity 记录：

```text
activity_count = 2
```

如果交易经过 1inch 等聚合器：

- `dex_aggregator.trades` 描述用户发起的聚合交易意图；
- `dex.trades` 描述底层实际经过的一个或多个流动池。

这种模型明确区分了“外层交易数量”和“业务动作数量”。

官方字段说明：[Dune `dex.trades`](https://docs.dune.com/data-catalog/curated/dex-trades/evm/dex-trades)

## 5. `dex.trades` 主要字段

| 字段 | 中文含义 |
|---|---|
| `blockchain` | 所属区块链 |
| `project` | DEX 协议名称 |
| `version` | 协议版本 |
| `block_time` | 交易时间 |
| `block_number` | 区块高度 |
| `token_bought_symbol` | 买入 Token |
| `token_sold_symbol` | 卖出 Token |
| `token_pair` | 交易对 |
| `token_bought_amount` | 买入数量 |
| `token_sold_amount` | 卖出数量 |
| `amount_usd` | 交易的美元估值 |
| `token_bought_address` | 买入 Token 合约地址 |
| `token_sold_address` | 卖出 Token 合约地址 |
| `taker` | 接受流动性的一方 |
| `maker` | 提供流动性的一方 |
| `project_contract_address` | 产生交易事件的 Pool、Router 等协议合约 |
| `tx_hash` | 外层交易哈希 |
| `tx_from` | 发起外层交易的地址 |
| `tx_to` | 外层交易最初调用的地址 |
| `evt_index` | 事件在交易中的顺序 |

这套字段同时保留：

```text
用户发起人
外层 Router 或聚合器
实际执行的 Pool
买卖 Token
协议名称和版本
事件顺序
```

因此不会因为 `tx.to` 是一个聚合器，就丢失底层实际使用的 PancakeSwap Pool。

## 6. Dune 是否把所有交易归成唯一类别

不是。Dune 更接近“事实表 + 多个业务视图”：

```text
同一笔交易
├── dex.trades：发生了 Swap
├── tokens.transfers：发生了 Token 转移
├── labels：参与地址属于某个实体
├── gas.fees：消耗了多少 Gas
└── dex.sandwiches：是否被识别为夹子相关交易
```

因此这些属性不互斥：

```text
Swap
Token Transfer
Meme
Bot
PancakeSwap
Stablecoin
```

例如一笔夹子机器人通过 PancakeSwap 使用 USDT 买入 Meme 币，可以表达为：

```text
activity       = swap
protocol       = pancakeswap
actor          = mev_bot
asset_in       = stablecoin
asset_out      = meme
token_transfer = true
```

如果产品必须展示一个合计为 100% 的饼图，可以额外定义唯一的 `primary_activity`，但不能因此丢弃其他维度标签。

## 7. 与当前 BSC Monitor 的对比

当前项目的主要流程是：

```text
Transaction + Receipt
  -> 检查地址、selector、topic、gas
  -> 直接产生唯一 cat
```

这相当于从 Raw 直接跳到业务分类，中间缺少完整的 Decoded 层和协议标准化层。

容易产生以下问题：

- Bot 调用 PancakeSwap 时，Bot 和 DeFi 只能保留一个；
- PancakeSwap 上的 Meme 交易被整体归入 DeFi；
- CEX ERC20 充值地址只在 Transfer event 参数中出现时无法识别；
- 多跳 Swap 只能识别为一笔笼统的 DeFi 交易；
- Router、Aggregator 和底层 Pool 角色混在一起；
- 新规则只影响未来统计，历史数据无法保持同一分类口径。

Dune 的方式是：

```text
Raw
  -> Decoded
  -> 协议标准化 Activity
  -> 地址和实体知识层
  -> 行为推断层
  -> 多维标签
  -> 按指定维度聚合
```

## 8. 当前项目可以借鉴的实现

### 8.1 增加统一解码层

建议在 sampler 和 classifier 之间加入：

```text
decodeTransaction(tx, receipt, traces)
  -> functionCalls[]
  -> decodedEvents[]
  -> tokenTransfers[]
  -> protocolActivities[]
```

这一层只负责提取事实，不负责判断 Bot、Meme 或 CEX 等行为和实体标签。

### 8.2 建立协议 adapter

为高流量协议建立独立 adapter，例如：

```text
PancakeSwap V2/V3
Venus
Lista
主要 Bridge
Prediction Market
账户抽象 EntryPoint
```

统一输出：

```json
{
  "activity": "swap",
  "protocol": "pancakeswap",
  "version": "v3",
  "contractRole": "pool",
  "tokenIn": "0x...",
  "tokenOut": "0x...",
  "amountIn": "...",
  "amountOut": "...",
  "evidence": ["decoded Swap event"]
}
```

### 8.3 从唯一 `cat` 迁移到多维结果

推荐分类输出：

```text
primaryActivity
activities[]
actorLabels[]
assetLabels[]
protocolLabels[]
flowLabels[]
```

其中：

- `primaryActivity` 用于需要合计为 100% 的交易动作分布；
- `activities[]` 保存所有真实业务动作；
- `actorLabels[]` 保存 Bot、CEX、Builder 等参与者属性；
- `assetLabels[]` 保存 Stablecoin、Meme、NFT 等资产属性；
- `protocolLabels[]` 保存协议名称、版本和合约角色；
- `flowLabels[]` 保存 CEX 充值、Bridge 流入流出等资金流语义。

### 8.4 分开统计交易数和动作数

至少同时提供：

```text
transaction_count = COUNT(DISTINCT tx_hash)
activity_count    = COUNT(activity rows)
```

否则多跳交易、聚合器和 multicall 会造成统计口径混乱。

### 8.5 保留证据和版本

每条标准化 activity 或标签建议保存：

```text
evidence
source
confidence
decoder_version
classifier_version
label_version
valid_from
valid_to
```

这样规则或地址库更新后，可以明确历史面板使用了哪个版本，并支持重新计算。

## 9. 对产品展示的启发

可以将当前单一“交易类型分布”拆为：

### 交易动作分布

使用唯一 `primary_activity`，合计为 100%：

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

允许一笔交易涉及多个资产：

```text
Stablecoin / Meme / Native / NFT / LST / RWA / Other
```

### 协议结构

按协议 adapter 的确定性结果统计：

```text
PancakeSwap / Venus / Lista / Prediction Markets / Bridges / Other
```

## 10. 最终总结

Dune 方法最值得当前项目借鉴的不是某一张表，而是以下设计原则：

1. 原始链上事实必须完整保存并可重算；
2. 先通过 ABI、event 和 trace 解码事实，再做业务分类；
3. 不同协议使用专属模型，最后映射到统一 schema；
4. 一笔外层交易可以包含多个业务 activity；
5. 交易动作、协议、资产、实体和行为标签相互独立；
6. 需要合计为 100% 时，额外定义 `primary_activity`；
7. 交易数、业务动作数和 Gas 统计必须明确口径。

可以将其概括为：

> 不直接问“这笔交易属于哪个唯一类别”，而是先完整解码“这笔交易实际发生了哪些动作”，再按协议、资产、实体和行为分别建立分析视图。

更完整的行业方法比较与项目改造建议，参见 [Txn 交易分类行业方法论与改造建议](./txn-classification-industry-methodology.md)。
