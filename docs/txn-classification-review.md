# Txn 交易分类准确性代码审查

> 审查日期：2026-08-24
> 审查范围：`backend/src/txn/`、`backend/src/ai/analyze.js`、`backend/src/server.js`、`frontend/src/pages/TxnPage.jsx`
> 审查目标：判断 Txn 分析页面中 Bot、DeFi、代币转账、BNB 转账、稳定币、CEX、Bridge 等分类是否能够代表真实链上业务类型。

## 1. 总体结论

当前实现适合做**粗粒度链上流量观察和异常趋势提示**，但不适合作为“真实业务类型占比”或精确市场份额统计。

主要原因是现有分类体系混合了不同维度：

- 资产类型：Meme、稳定币；
- 业务类型：DeFi、Bridge、CEX、预测市场；
- 行为主体：Bot、Infra/Builder；
- 技术行为：BNB 转账、Token Transfer、系统交易。

一笔交易可能同时属于多个维度，例如“Bot 通过 DeFi Router 买入 Meme 币”，但当前分类器强制每笔交易只能进入一个类别，并依靠固定优先级决定结果。因此页面显示的是**规则命中的互斥标签占比**，不是完整的业务真值。

建议对外将统计口径描述为：

> 基于地址标签、事件特征和行为规则估算的交易类型占比。

不要直接将 `Bot 24.6%`、`Meme 3%`、`CEX 1.1%` 等数字解释为全网真实业务占比。

## 2. 分类可信度概览

| 分类 | 可信度 | 结论 |
|---|---|---|
| 系统交易 | 高精度、覆盖不完整 | 固定系统地址命中可靠，但地址表需要更新 |
| BNB 转账 | 中高 | `gasUsed == 21000` 较可靠，但没有检查实际转账金额 |
| 稳定币 | 高精度、低召回 | 仅覆盖少量静态稳定币地址，不能代表全部稳定币活动 |
| DeFi | 中 | 标准 Swap 事件可靠，但静态地址标签会扩大范围并吸收 Bot 流量 |
| 代币转账 | 中 | ERC20、NFT、mint、claim、游戏分发等行为混在一起 |
| 预测市场 | 范围内较高 | 主要代表已配置的 predict.fun 地址，不代表全部预测市场 |
| Bridge | 中 | 已知桥较可靠，未知桥依赖 AI 标签 |
| CEX 充提 | 低召回 | 无法正确识别多数 ERC20 充值，地址库覆盖也有限 |
| Meme | 低召回 | DEX 中的 Meme 交易通常被归入 DeFi |
| Bot | 低 | 行为规则存在实现错误，且难以仅凭目标地址判断交易主体 |
| Infra/Builder | 低召回 | 主要依赖极少数静态地址和 AI 标签 |
| 其他 | 不适用 | 所有规则未命中的残差，不是稳定业务类别 |

## 3. 当前分类优先级

核心逻辑位于 `backend/src/txn/classifier.js`。每笔交易按以下顺序分类，先命中先结束：

1. 合约部署 → `other`；
2. 已知系统合约 → `system`；
3. `from` 或顶层 `to` 为已知 CEX 地址 → `cex`；
4. 顶层 `to` 命中静态或 AI 地址标签 → 使用标签类别；
5. 短 selector 或同发送方块内高频 → `bot`；
6. receipt 包含 V2/V3 Swap 事件 → `defi`；
7. `gasUsed == 21000` 或低 Gas 空 input → `bnb`；
8. 标准 transfer selector 或 receipt 包含 Transfer 事件 → `token`；
9. 其余 → `other`。

该顺序本身决定了大量分类结果。例如，Bot 调用已知 PancakeSwap Router 时会在第 4 步被归为 DeFi，根本不会执行第 5 步的 Bot 判断。

## 4. 分类规则详细审查

### 4.1 Bot

**结论：不能作为真实 Bot 交易占比。**

#### 问题一：高频规则统计了发送方的全部交易

`classifyBlock()` 首先统计同一 `from` 在块内出现的总次数：

```js
for (const tx of txs) {
  const f = (tx.from || "").toLowerCase();
  fromCounts.set(f, (fromCounts.get(f) || 0) + 1);
}
```

随后只要某一笔交易不是普通 BNB 转账或标准 Token Transfer，就根据发送方总交易数判断 Bot：

```js
if ((fromCounts.get(from) || 0) >= 3 && !isPlainTransfer && !isTokenTransfer)
  return "bot";
```

这与文档所述“同一发送方在单块内至少 3 笔合约调用”不同。例如，同一地址在块内发送 2 笔普通 BNB 转账和 1 笔普通合约调用，最后一笔也会被错误判为 Bot。

#### 问题二：已知 Router 标签优先于 Bot 行为

地址标签在 Bot 行为规则之前返回。机器人即使在同一块内高频调用 PancakeSwap Router，也会因为 Router 已被标记为 DeFi 而全部进入 DeFi。

#### 问题三：AI 标注的是目标地址，不是交易发送者

AI 候选来自热门 `to` 地址，学习结果也是目标地址标签。一旦某个目标合约被标记为 Bot，普通用户对该合约的调用也会全部算作 Bot；而使用多个 EOA 调用公共 Router 的机器人会被漏掉。

#### 问题四：AI 缺少判断调用方集中度所需的数据

AI 提示词要求根据“调用方集中或分散”区分 Bot 和 DeFi，但候选特征只包含调用次数、selector、事件数、字节码、nonce、余额和 verified name，没有提供调用方数量或发送方集中度。因此模型实际上无法执行这条判断。

当前 Bot 类更准确的含义是：

> 已标记 Bot 目标地址的调用、特殊短 selector 交易，以及部分同发送方高频交易。

### 4.2 DeFi

**结论：Swap 子集较准，整体类别会混入非 DeFi 及 Bot 流量。**

标准 V2/V3 Swap topic 是较强证据，直接命中 Swap 事件的分类精度较高。但以下情况会扩大 DeFi 范围：

- 静态地址标签优先于事件和行为规则；
- WBNB 被整体标为 DeFi，因此 WBNB 普通 transfer 也会进入 DeFi；
- ERC-4337 EntryPoint 被整体标为 DeFi，但其 UserOperation 可能实际执行支付、游戏或普通转账；
- Bot 调用已知 DeFi Router 时被 DeFi 标签提前截获；
- 非标准 Swap 事件只有在地址库或 AI 识别后才能进入 DeFi。

因此 DeFi 占比更接近“调用已知 DeFi/基础设施地址或产生标准 Swap 事件的交易占比”。

### 4.3 代币转账

**结论：代表广义 Token Transfer 行为，不等于标准 ERC20 转账。**

分类条件包括：

- `transfer(address,uint256)`；
- `transferFrom(address,address,uint256)`；
- receipt 中包含 `Transfer(address,address,uint256)` topic。

ERC20 与 ERC721 使用相同的 Transfer topic，因此 NFT 转账也会进入该分类。此外，mint、burn、claim、airdrop、游戏道具分发以及应用调用中伴随的 Transfer 都会被统计。

建议前端将“代币转账”改为“Token Transfer 行为”，或进一步区分 ERC20、ERC721、mint/burn 和应用内分发。

### 4.4 BNB 转账

**结论：通常较准，但缺少 value 校验，并受 receipt 故障影响。**

当前主要依据是 `gasUsed == 21000`，但没有要求 `tx.value > 0`，因此零金额 EOA ping 和零金额垃圾交易也可能被统计为 BNB 转账。

receipt 缺失时，代码把所有空 input 交易近似为普通转账：

```js
const isPlainTransfer =
  (rc && Number(rc.gasUsed) === 21000) || (!rc && input === "0x");
```

此时即使目标是合约、实际执行消耗远高于 21000 gas，也可能被误判为 BNB 转账。

建议至少增加：

```js
BigInt(tx.value ?? 0) > 0n
```

并在 receipt 缺失时将该块标记为数据不完整，而不是继续进行完整分类。

### 4.5 稳定币

**结论：已知地址命中精度高，但覆盖严重不足。**

静态标签目前仅覆盖 USDT、USDC、BUSD、DAI、FRAX。其他稳定币会进入 Token、DeFi 或 Other。

此外，AI 分类提示词允许的分类列表中没有 `stable`，意味着新的稳定币合约不能稳定地通过 AI 学习补充到稳定币类别。

因此当前稳定币数据表示：

> 直接调用已配置稳定币合约的交易量。

不能解释为全部稳定币转账或全部稳定币相关活动。

### 4.6 CEX 充提

**结论：提现方向可部分识别，ERC20 充值方向存在结构性漏判。**

分类器只检查交易 envelope 的 `tx.from` 和顶层 `tx.to`。对于 ERC20 充值：

```text
tx.from = 用户地址
tx.to   = USDT/USDC 等 Token 合约
实际 CEX 收款地址 = transfer calldata 或 Transfer event 中的 to
```

当前实现没有解析 calldata 或 Transfer event 的收款地址，因此即使实际收款地址属于 CEX，交易仍会归为 Stable 或 Token。

此外，普通 BNB 转账地址不会进入热门合约 AI 候选，CEX 的 EOA 地址库也难以通过现有 AI 学习管线自动扩展。

因此“CEX 充提”实际更接近：

> 已知 CEX 热钱包直接作为顶层交易发送方或接收方的交易。

### 4.7 Meme

**结论：不能代表 Meme 币相关活动。**

静态规则主要识别 four.meme 等少量发射台地址。典型 Meme 行为会被分散到其他类别：

- Meme 合约部署：`other`；
- Meme Token 普通转账：`token`；
- 在 PancakeSwap 买卖 Meme：`defi`；
- 直接调用已知发射台或已学习 Meme 合约：`meme`。

因此 Meme 占比只能解释为“已识别 Meme 平台或目标合约的直接调用占比”。如果产品希望展示 Meme 资产热度，需要解析 Swap/Transfer 日志中的 Token 地址，并维护 Token 级资产标签，而不是只看顶层 `tx.to`。

### 4.8 预测市场

**结论：对已配置的 predict.fun 地址较准，但不代表全网预测市场。**

当前静态库重点覆盖 predict.fun 合约。只要地址准确，命中精度较高；但其他预测市场协议必须依赖 AI 学习，否则会进入 DeFi、Token 或 Other。

前端建议使用“predict.fun / 已识别预测市场”而不是泛化成所有预测市场。

### 4.9 Bridge

**结论：已知 Bridge 地址精度较高，整体覆盖依赖地址库和 AI。**

TokenHub 被明确归为 Bridge，未知 Bridge 合约则需要先进入 Other，再由 AI 学习。新桥、代理升级地址和跨链聚合器容易被漏计或归入 DeFi。

### 4.10 Infra/Builder

**结论：覆盖不足，不能代表全部 Builder/Relay 活动。**

静态库主要包含 BlockRazor Payment 地址。分类器只使用 `to` 的普通标签，除 CEX 外不会根据 `from` 标签返回分类。因此：

- 发往已知支付地址的交易可能进入 Infra；
- 已知 Builder 地址向外付款时通常会进入 BNB 或其他目标类别；
- 其他 Builder/Relay 地址依赖 AI 标签。

### 4.11 系统交易

**结论：固定地址命中可靠，但地址集合需要与当前协议版本同步。**

代码覆盖 `0x...1000-1008` 中的大部分地址和 `0x...2000-2005`，但没有覆盖当前官方文档中的 `0x...2006` Timelock 和 `0x...3000` Token Recover Portal。

该问题预计对总占比影响较小，但说明系统地址表需要版本化维护。

## 5. AI 标签体系的准确性问题

AI 标签由 `runContractLabeling()` 生成，并由 `LabelBook.addLearned()` 持久化。当前存在以下问题：

1. 没有验证返回地址是否属于本轮候选；
2. 只检查地址是否以 `0x` 开头，没有检查是否为完整合法地址；
3. 没有在写入时强制校验分类枚举；
4. 没有保存置信度、证据、模型版本和学习时间；
5. 非 `other` 标签一旦写入，后续不再自动复核；
6. 模型输出的 `name` 大量为空时，无法进行人工审计；
7. AI 提示词与允许类别存在不一致，例如判据提到 `bnb`，但允许分类列表没有 `bnb`，同时也缺少 `stable`。

AI 标签会直接影响后续所有新交易的分类，因此错误标签属于持续性数据污染，而不是单次展示问题。

## 6. 历史趋势口径问题

小时桶只保存已经分类后的聚合值，不保存原始交易或可重放的最小分类特征。标签或规则更新后，历史桶不会重算。

例如：

1. 某合约前几天被归为 Other；
2. 今天被 AI 学习为 Bot；
3. 今天之后的调用进入 Bot；
4. 7 天趋势表现为 Bot 上升、Other 下降。

这个变化可能只是分类规则变化，而不是链上业务变化。

因此当前 `环比 vs 7d` 同时受到真实流量和标签学习进度影响。若无法重算历史数据，至少应记录 `classifierVersion` 和 `labelVersion`，避免直接比较不同版本下的桶。

## 7. 采集质量对分类的影响

### 7.1 receipt 获取失败被静默接受

`eth_getBlockReceipts` 失败后会返回 `null` 并继续分类。其影响包括：

- Swap/Transfer 事件全部丢失；
- DeFi 和 Token 被错误归入 Bot、BNB 或 Other；
- 使用交易 gas limit 代替实际 `gasUsed`；
- Gas 占比被放大或扭曲；
- 失败没有进入 `failed` 计数。

### 7.2 抓块失败后不会补采

单个区块抓取失败只会增加 `failed`，但本轮结束后 `lastBlock` 仍被推进到 tip，失败块永久缺失。因此页面所称“全量覆盖”缺少严格保证。

建议 API 输出以下质量指标：

- 目标区块数；
- 成功区块数；
- receipt 完整区块数；
- 缺失区块高度；
- coverage percentage；
- 当前分类器和标签版本。

## 8. 修正优先级

### P0：先保证统计口径可解释

1. 将分类拆成多个正交字段，而不是一个互斥 `cat`：
   - `activity`：transfer / swap / bridge / deploy / system；
   - `protocol`：PancakeSwap / Venus / predict.fun 等；
   - `assetTags`：stable / meme / NFT；
   - `actor`：bot / cex / builder / user / unknown；
2. 页面按不同维度分别统计，避免让 Bot、Meme、DeFi 竞争同一个类别。

### P1：修正确定性分类错误

1. Bot 高频阈值只统计符合条件的合约调用；
2. BNB 转账增加 `value > 0`；
3. CEX 分类解析 transfer/transferFrom calldata 和 Transfer event 收款方；
4. receipt 缺失时重试或丢弃该块的分类结果；
5. 抓块失败时保留重试队列，不直接推进完整游标；
6. AI 输出执行 JSON Schema、候选地址集合和分类白名单校验。

### P2：提高类别召回率

1. 建立稳定币、Bridge、CEX、Builder 地址的可维护注册表；
2. Meme 改为 Token 级标签，解析 Swap 中实际交易的 Token；
3. 区分 ERC20、ERC721、mint、burn 和普通应用 Transfer；
4. 补充调用方集中度、独立发送方数量、nonce 连续性等 Bot 特征；
5. 为 AI 标签保存 evidence、confidence、modelVersion 和 reviewed 状态。

### P3：恢复趋势可比性

1. 保存足以重新分类的最小交易特征；
2. 标签更新后重算滚动窗口；
3. 每个桶保存 `classifierVersion` 和 `labelVersion`；
4. 不同版本的数据不直接计算环比，或在前端明确标记口径变化。

## 9. 产品展示建议

在完成多维分类前，建议修改页面文案：

| 当前文案 | 建议文案 |
|---|---|
| Bot | Bot 特征命中 |
| Meme | 已识别 Meme 平台调用 |
| DeFi | 已识别 DeFi / Swap 调用 |
| 代币转账 | Token Transfer 行为 |
| 稳定币合约 | 已配置稳定币合约调用 |
| CEX 充提 | 已知 CEX 钱包交互 |
| 预测市场 | 已识别预测市场调用 |
| 全量覆盖 | 已采集区块覆盖率达到 X% |

同时建议增加提示：

> 分类基于地址标签、事件特征和行为规则估算；同一交易仅显示一个主分类，结果不代表完整业务身份。

## 10. 最终判断

当前分类功能可以回答：

> 最近链上交易中，各类规则命中量和已识别协议调用结构如何变化？

当前分类功能不能准确回答：

> BSC 全网有多少交易由 Bot 发起？有多少交易与 Meme、稳定币或 CEX 真实相关？

如果用于内部运维、热点发现和异常趋势提示，当前方案有实用价值；如果用于对外数据产品、业务份额分析或安全归因，则需要先完成多维标签拆分、采集质量度量、AI 标签校验和历史重算能力。
