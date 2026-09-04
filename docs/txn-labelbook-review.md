# Txn LabelBook 来源、准确性与治理审查

> 审查日期：2026-08-31
> 审查对象：`backend/src/txn/labels.js`、`backend/data/contract-labels.json` 及其生成链路
> 目标：说明 LabelBook 的信息来源、准确性边界、已确认错误和后续治理方案。

## 1. 结论先行

当前 LabelBook 由两部分组成：

```text
人工硬编码的 STATIC_LABELS
  +
AI 自动生成的 contract-labels.json
```

它目前不能被视为准确、可审计的地址知识库，更准确的描述是：

> 一组人工已知地址，加上一组未经系统审计的 AI 行为猜测。

主要结论：

- 静态表中部分知名协议和系统地址身份准确，但几乎没有逐条来源和审核记录；
- 静态表至少存在 WBNB 地址不一致、主网表混入 Testnet Router 等明确问题；
- AI 学习表共 260 条，其中 249 条没有名称，也没有证据、置信度、时间或模型版本；
- 已发现 48Club 被标成 Bot、BlockRazor 静态/学习标签相互矛盾等实际错例；
- 当前 LabelBook 的 `cat` 会在交易证据规则之前直接决定分类，错误标签会长期污染统计；
- 静态地址可以作为新版地址注册表的候选种子，但必须逐条补来源和作用域；
- AI 标签应降级为 `candidate`，不能未经核验直接进入正式交易分类。

## 2. LabelBook 的组成

### 2.1 静态地址表

静态地址直接硬编码在 `backend/src/txn/labels.js`，当前共有 70 条：

| 类别 | 数量 |
|---|---:|
| DeFi | 17 |
| Predict | 29 |
| CEX | 12 |
| Stable | 5 |
| Meme | 3 |
| Token | 2 |
| Infra | 1 |
| Bridge | 1 |

Git 历史显示，这批地址在项目初始提交 `a074032` 中一次性加入，此后没有逐条记录来源、审核人或有效期。

代码中只有 predict.fun 地址组明确备注来源为 `dev.predict.fun deployed-contracts`。该组地址可以与 predict.fun 官方 BNB Mainnet 部署表对应，例如 Oracle、Vault、CTFExchange 和 ConditionalTokens。

参考：[predict.fun Deployed Contracts](https://dev.predict.fun/-deployed-contracts-1860295m0)

其他静态地址可能来自协议部署资料、BscScan 公共标签、链上元数据或开发者经验，但当前 schema 没有保存每条地址的实际来源，无法系统复核或自动刷新。

### 2.2 AI 学习地址表

AI 学习结果保存在 `backend/data/contract-labels.json`。该文件是运行时数据，没有进入 Git 历史，也没有逐条变更记录。

当前共 260 条：

| AI 类别 | 数量 |
|---|---:|
| Token | 94 |
| Bot | 80 |
| DeFi | 43 |
| Other | 25 |
| Meme | 8 |
| Predict | 6 |
| Bridge | 4 |

名称完整度：

```text
有名称： 11 / 260
无名称：249 / 260（95.8%）
```

现有条目只有：

```json
{
  "name": null,
  "cat": "bot",
  "ai": true
}
```

没有 `source`、`evidence`、`confidence`、`reviewedAt`、`validFrom/To`、`modelVersion`、`network` 或 `addressRole`。

## 3. AI 标签的生成链路

AI LabelBook 的生成流程是：

```text
近 24h 已归为 other 的热门合约 Top30
  -> 聚合调用次数、Gas、Swap/Transfer 数量
  -> 提取 Top selectors
  -> OpenChain 查询 selector 对应函数签名
  -> RPC 查询 code、balance、nonce
  -> 可选 BscScan 查询 verifiedName 和 proxy implementation
  -> AI 最多进行 15 次额外链上核实
  -> 输出 [{addr, cat, name}]
  -> 自动写入 contract-labels.json
```

相关代码：

- 候选筛选：`backend/src/txn/store.js` 的 `unknownHot()`；
- Selector 查询：`backend/src/txn/siglookup.js`；
- 地址形态查询：`backend/src/txn/addrIntel.js`；
- AI Prompt：`backend/src/ai/analyze.js` 的 `runContractLabeling()`；
- 自动落库：`backend/src/txn/labels.js` 的 `addLearned()`；
- 周期调度：`backend/src/server.js` 的 `pollContractLabels()`。

AI 可使用的特征包括：

| 特征 | 含义 |
|---|---|
| `n` | 近 24h 调用次数 |
| `gas` | Gas 总量 |
| `swapLogs` | Swap 事件数量 |
| `transferLogs` | Transfer 事件数量 |
| `topSelectors` | 高频 selector 及 OpenChain 签名 |
| `addrType` | EOA、contract 或 EIP-7702 |
| `codeSize` | 合约字节码大小 |
| `nonce` | 地址交易计数 |
| `balanceBNB` | BNB 余额 |
| `verifiedName` | BscScan 已验证源码中的合约名 |
| `implementation` | Proxy implementation |

### 3.1 证据边界

这些信息可以帮助发现候选，但不能独立证明真实身份：

- `name()`、`symbol()` 可以由任意合约自行填写；
- OpenChain selector 只能解释四字节签名，不能证明协议身份；
- selector 可能碰撞，一个方法名也可能被多个协议使用；
- `verifiedName` 代表源码验证时填写的合约名，不等于现实实体归属；
- 高 nonce、单一 selector、vanity 地址只是行为信号；
- EOA 无法通过合约源码接口证明运营者；
- 每批最多进行 15 次额外核实，不是每个候选都经过链上验证；
- AI 可能基于地址外形或行为模式作出错误推断。

因此这些特征适合产生 `candidate`，不适合未经人工审核直接成为结构事实。

## 4. 当前生效机制及放大效应

LabelBook 读取顺序为：

```text
STATIC_LABELS 优先
  -> 找不到时读取 AI learned labels
```

所以 AI 不能覆盖同地址的静态标签，但学习文件里可以长期残留冲突数据。

分类器中的使用顺序为：

```text
系统地址
  -> CEX 地址
  -> tx.to 的 LabelBook cat
  -> Bot 行为规则
  -> Swap 事件
  -> Native Transfer
  -> Token Transfer
  -> Other
```

一条地址标签可以在分析当前交易的 Swap、Transfer 和 Bot 证据前直接结束分类。错误标签因此具有放大效应：

```text
地址错误标成 defi
  -> 该地址后续 approve、claim、admin 等调用全部进入 defi
  -> 不再进入 other
  -> 不再进入 AI 复核队列
  -> 错误长期保留
```

## 5. 已确认问题

### 5.1 静态 WBNB 地址不一致

静态表中的 WBNB 地址是：

```text
0xbb4cdb9cbd36b01bd1cbaef60af814a3f6f0ee75
```

PancakeSwap 官方资料记录的 canonical WBNB 地址是：

```text
0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
```

参考：[PancakeSwap WBNB Address](https://github.com/pancakeswap/pancake-info-api/blob/develop/v2-documentation.md)

正确的 canonical WBNB 地址反而存在于 AI 学习表中，并被命名为 `WBNB`。这说明静态表至少存在一处明确的地址录入或身份映射问题。

此外，即使地址正确，`WBNB -> cat=defi` 也混合了资产身份和交易动作。Wrap、unwrap、transfer 不应自动等同于 DeFi Activity。

### 5.2 主网表混入 Testnet Router

静态表包含：

```text
0xd99d1c33f9fc3444f8101754abc46c52416550d1
PancakeSwap Testnet Router
```

Txn 系统分析的是 BSC Mainnet。将明确标为 Testnet Router 的地址加入 Mainnet 静态表，说明地址注册过程没有严格校验 `network/chainId`。

### 5.3 48Club 被 AI 标成 Bot

AI 学习表中：

```text
0x4848489f0b2bedd788c696e2d79b6b69d7484848
name = null
cat  = bot
```

48Club 官方文档说明该地址是 Puissant Builder 的 Builder Control EOA，用于接收直接转给 Builder 的 BNB，不是 Bot 合约。

参考：[48Club Puissant Builder - Send Bundle](https://docs.48.club/puissant-builder/send-bundle)

这是一条目前仍会生效的 AI 错误标签。

### 5.4 BlockRazor 存在静态/学习冲突

同一地址：

```text
0x1266c6be60392a8ff346e8d5eccd3e69dd9c5f20
```

静态表记录为 `BlockRazor Payment / infra`，AI 学习表记录为 `name=null / bot`。

BscScan 公共标签说明该地址是 BlockRazor Payment，用于接收用户 BNB 并向 Validator 发送支付。

参考：[BlockRazor Payment Address](https://bscscan.com/address/0x1266c6be60392a8ff346e8d5eccd3e69dd9c5f20)

当前静态表优先，所以线上使用 `infra`；但这个冲突证明 AI 管线会生成与已知实体相反的标签，且学习文件没有冲突清理机制。

### 5.5 BSC 系统地址覆盖不完整

BNB Chain 官方系统合约列表还包含：

```text
0x0000000000000000000000000000000000002006  Timelock
0x0000000000000000000000000000000000003000  TokenRecoverPortal
```

当前系统分类地址表没有收录。

参考：[BNB Chain Built-in System Contracts](https://docs.bnbchain.org/bc-fusion/developers/system-contracts/)

### 5.6 AI 标签不会自动纠错

`unknownHot()` 只抽取当前属于 `other` 的热门合约：

```text
错误学成 defi/token/bot
  -> 不再属于 other
  -> 不再进入下一轮候选
```

只有 AI 学成 `other` 的地址会继续被重新评估。系统会缩小 `other`，但不会自动修复已经分错的非 `other` 标签。

## 6. 可信度分层

地址身份是否正确，与用该地址决定当前交易 Activity 是否正确，是两个不同问题。

| 标签来源 | 地址身份可信度 | 直接决定 Activity | 判断 |
|---|---|---|---|
| 官方部署文档 | 高 | 中，需要函数/事件判断 | 可作为协议和角色事实 |
| BNB Chain 系统合约表 | 高 | 高，但仍应区分动作 | 可作为确定性种子 |
| 已核实 Token 地址 | 较高 | 低 | 可描述资产，不能自动决定 Activity |
| Explorer 公共实体标签 | 中高 | 中低 | 需保存来源和时间 |
| BscScan `verifiedName` | 中 | 低 | 证明源码名称，不完全证明运营实体 |
| 链上 `name()/symbol()` | 中低 | 低 | 只能作为元数据 |
| OpenChain selector | 低 | 低到中 | 只能作为函数语义线索 |
| AI 有名称标签 | 中低 | 未评估 | 应进入候选队列 |
| AI 无名称标签 | 低 | 未评估且已有错例 | 不应进入正式地址库 |
| 地址外形/vanity 推断 | 很低 | 很低 | 仅适合行为线索 |

静态表可以作为新版 Registry 的待审种子，但不能原样迁移为 `verified`。AI 表适合发现未知热门地址，但只能作为候选结果。

## 7. 推荐的新地址注册表

建议用以下 schema 代替 `{name, cat, ai}`：

```json
{
  "network": "bsc",
  "chainId": 56,
  "address": "0x...",
  "name": "PancakeSwap V3 SmartRouter",
  "entity": "PancakeSwap",
  "protocol": "pancakeswap",
  "roles": ["router"],
  "actorTypes": [],
  "assetTypes": [],
  "source": {
    "type": "official_deployment",
    "url": "https://..."
  },
  "evidence": [
    {
      "type": "official_document",
      "value": "BNB Mainnet deployment"
    }
  ],
  "confidence": 1.0,
  "status": "verified",
  "reviewedAt": "2026-08-31T00:00:00Z",
  "reviewedBy": "...",
  "validFrom": null,
  "validTo": null,
  "modelVersion": null
}
```

地址状态至少支持：

```text
candidate   AI 或启发式发现，未核实
verified    已由官方资料、链上事实或人工确认
rejected    已确认错误
deprecated  曾经有效，当前不再作为活跃地址
```

来源优先级建议为：

1. 协议或实体官方部署文档；
2. BNB Chain 官方系统合约资料；
3. 官方 GitHub deployment/config；
4. 链上 factory/deployer/admin 关系；
5. 已验证源码和 Explorer 公共标签；
6. 第三方标签库；
7. 行为规则和图分析；
8. AI 推断。

低等级来源可以提出候选，但不能自动覆盖高等级来源。

## 8. LabelBook 与交易分类的边界

新版地址注册表只描述地址本身：

```text
它是谁
属于哪个实体或协议
承担什么合约角色
是否为某类资产
证据来自哪里
```

它不应直接回答“当前这笔交易是什么 Activity”。

交易 `primaryActivity` 应由当前交易的 input、selector、receipt 状态、decoded logs、Transfer 参数和经过核实的业务动作现场判断。

例如：

```text
地址标签：PancakeSwap Router
当前调用：approve()
```

不能因为地址属于 PancakeSwap，就把 `approve()` 自动归为 Swap。静态 predict/bridge 地址也只能与经过核实的 selector/event 组合后参与 Activity 判断。

## 9. 建议治理流程

### 9.1 冻结 AI 直接晋级

新 AI 输出只写入 `candidate`，不直接参与交易分类。

### 9.2 审计高影响标签

按近 24h 笔数和 Gas 优先审计：

- Top 50 AI 标签；
- Bot、Infra、CEX 标签；
- 没有名称但调用量高的标签；
- 与静态表冲突的标签；
- 热门合约榜中的 AI 标签。

### 9.3 静态表逐条补来源

至少检查：

- `chainId/network`；
- 地址是否有代码；
- official deployment；
- proxy implementation；
- 实体、协议、角色和资产是否混淆；
- 地址是否仍有效；
- 是否为测试网地址。

### 9.4 增加复核和过期机制

建议：

- 所有 AI 标签允许重新评估，不只重评 `other`；
- 新模型版本对旧 AI 标签运行 shadow review；
- CEX/Builder 地址设置定期复核时间；
- 发现冲突时记录 conflict，不静默覆盖；
- rejected 标签保留原因，避免再次学习回来。

### 9.5 与可重放事实日志结合

LabelBook 修正后，使用滚动 TxnFact Journal 重算最近窗口：

```text
TxnFact + LabelRegistryVn + ClassifierVn
  -> 重算 24h/7d 聚合
```

否则标签虽然修正，已冻结在小时桶里的历史分类仍不会改变。

## 10. 最终结论

当前 LabelBook 的根本问题不是完全没有有用信息，而是：

```text
正确地址、错误地址、实体事实、资产属性、行为猜测和 AI 推断
全部使用同一个 {name, cat} schema
并拥有近似相同的生产权限
```

因此目前无法给出可信的整体“LabelBook 准确率”。建议：

- 官方或人工核实的静态地址逐条验证后迁移为 `verified`；
- BscScan/链上名称只作为辅助证据；
- AI 学习标签统一降级为 `candidate`；
- 地址标签不再直接覆盖交易 Activity；
- 标签保存来源、证据、置信度、审核信息和有效期；
- 标签修正通过 TxnFact 重放反映到最近统计窗口。

在完成治理前，页面中的 AI LabelBook 应明确标注：

> 基于链上行为和模型推断的候选地址标签，未经完整人工审计。
