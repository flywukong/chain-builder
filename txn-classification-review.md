# TXN 分类准确性 Review

- 评审日期:2026-08-24 · 代码版本:`0975c91` · 范围:`backend/src/txn/`(classifier / labels / store / sampler / addrIntel / siglookup)+ `ai/analyze.js` 的 `runContractLabeling`
- 数据快照:线上 24h 全量 16,387,615 笔;AI 学得标签 14,906 条;历史累计 7.37 亿笔
- 结论先行:**分布图方向可用,细分数字可信度分层明显** —— system/predict/bnb/stable 高可信;defi/token/bot 三大头(合计 62%)互相渗透,只能当量级看;cex/meme/bridge 系统性低估;infra 5.3% 未经审计。

---

## 一、分类管线(现状)

```
sampler.js  全量抓块(60s tick ~133 块,2 RPC/块;receipts 失败静默降级,落后>300 块保新弃旧)
    ↓
classifier.js  规则分类(免费,每笔),优先级自上而下:
    1. 无 to(部署)            → other
    2. SYSTEM_ADDRS 14 地址     → system        classifier.js:67
    3. labelBook:from/to 是 cex → cex          classifier.js:71
       to 有非 other 标签       → 该标签 cat    classifier.js:72  ★静态表+AI 学得,先于一切启发式
    4. 短 selector 0x000000xx / 同块同 from ≥3 笔非转账 → bot   classifier.js:78-79
    5. Swap 事件(仅 UniV2/V3 topic)→ defi     classifier.js:82
    6. gasUsed==21000 / 空 calldata 无日志 ≤30000 gas → bnb     classifier.js:85-86
    7. transfer/transferFrom selector 或 Transfer 事件 → token  classifier.js:89-90
    8. 残差                     → other
    ↓
AI 补标(2h 一批):unknownHot = 24h 内 cat==other 的热合约 top30(≥5 才跑)
    证据:调用量/gas、Swap/Transfer 计数、top selectors + openchain 签名反查、
    地址情报(EOA/合约/7702、codeSize、nonce、BscScan verified 名)、MCP 链上核实 ≤15 次
    → contract-labels.json 持久化,下一笔起经 3 生效
    ↓
读取端:热门合约/大流量归因显示时用 labelBook 重解析;
       但 catPct/allTime 分布占比冻结在入库时的分类(见 S1)
```

24h 实测占比(笔数 / gas):

| bot | defi | token | bnb | stable | infra | other | predict | meme | system | cex | bridge |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 24.5 / 19.5 | 19.3 / 33.0 | 18.6 / 26.5 | 10.3 / 1.0 | 8.8 / 1.6 | 5.3 / 2.8 | 4.3 / 2.2 | 3.3 / 7.6 | 3.0 / 5.1 | 1.2 / 0.3 | 1.1 / 0.2 | 0.3 / 0.2 |

---

## 二、逐分类评审

### bot —— 可信度:低(24.5%,第一大类)
规则:selector 前 3 字节全零(`classifier.js:78`);或同块同 from ≥3 笔且非纯转账/非标准 token 转账(`:79`)。
- **误报**:自定义 multisend/批量分发/游戏结算合约,同块 ≥3 笔即中招(排除项只有 21000 转账和标准 transfer selector)。
- **漏报**:①bundle 型 MEV(backrun/夹子)常态是每块 1 笔,≥3 规则不触发;②selector 只认 `0x000000xx`,两字节零头(`0x0000xxxx`)及正常 selector 的 bot 全漏;③带 Swap 日志的单发套利 bot 落入 defi(规则 5 兜走)。
- **无记忆**:判定只看单块内计数,同一 bot 合约这块算 bot、下块算 defi/other;唯一稳定机制是 AI 学得 bot 标签(规则 3 优先),但 bot 合约只有先落 other 才会进 AI 队列——**落 defi 的 bot 永不复核**(见 S2)。
- 净效应方向不明:误报(批量分发→bot)与漏报(单发 MEV→defi)同时存在,24.5% 只能当量级看。

### defi —— 可信度:中(19.3% 笔数,33% gas)
- Swap 事件判定本身可靠(`classifier.js:13-14` UniV2 `0xd78a…`/UniV3 `0xc420…` topic)。
- **地址优先规则过宽**(`:72` 标签先于启发式):WBNB 静态 defi → 纯 wrap/unwrap 也算 defi;ERC-4337 EntryPoint 归 defi(实为 infra 性质);AI 学得 defi 的合约上 approve/claim 等非 swap 操作全算 defi。
- **事件覆盖窄**:StableSwap TokenExchange、DODO、订单簿等非 UniV2/V3 风格事件不识别。
- 吸收了单发 MEV bot 与几乎全部外盘 meme 交易(见 meme),**系统性高估**。

### token —— 可信度:中(18.6%)
`transfer`/`transferFrom` selector 或任何 Transfer 事件(`classifier.js:89-90`)。三类语义混在一起:
- ERC721 `transferFrom` 与 ERC20 同 selector(`0x23b872dd`,签名完全相同),NFT 转移计入 token;
- mint/claim/空投/游戏结算只要发 Transfer 事件就进 token;
- "是代币动账"方向没错,细分(FT/NFT/mint)不可用。区分是可做的:ERC721 Transfer 是 4 topics(3 indexed),ERC20 是 3 topics,`from=0x0` 即 mint —— 见 P2。

### bnb —— 可信度:中高(10.3%)
`gasUsed==21000` 精确(`classifier.js:76`);`≤30000` 无日志空 calldata 的合约钱包 receive 分支(`:86`)合理。
- 未检查 value:0 值 21000 自转(nonce 重置/spam)也算 BNB 转账;
- receipts 缺失时退化为 `input=="0x"`,带 value 的合约 receive 会误入。
- 整体高可信,是分布图里少数"数字可直接引用"的类。

### stable —— 高精度、低覆盖(8.8%)
固定 5 个:USDT/USDC/BUSD/DAI/FRAX(`labels.js:69-73`)。
- **缺 FDUSD(`0xc5f0f7b66764f6ec8c8dff7ba683102295e16409`)和 USD1(`0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d`)**——两地址均已 eth_call symbol() 链上核实,漏的量全落 token。量级校准:两者均不在 24h 合约 top15(单个 <13 万笔/天,即 <0.8%),补齐约挪动 0.5~1.5pp,值得补但不改变大盘。BUSD 已退役仍占位(无害)。
- 语义注意:stable = "调用稳定币合约"(transfer/approve 都算),不是"稳定币转账笔数"。

### cex —— 低覆盖(1.1%)
12 个热钱包,Binance 为主(`labels.js:76-87`)。**ERC20 充值方向结构性盲区**:用户→CEX 的 USDT 充值,`tx.to`=USDT 合约,CEX 地址只在 Transfer log 的参数里,而 classifier 只看 tx.from/tx.to(`classifier.js:71`)→ 记入 stable/token。实际能抓住的只有 CEX 出金(from=热钱包)与原生 BNB 充值(to=热钱包)。1.1% 显著低估,且入金/出金不对称。

### meme —— 低覆盖(3.0%)
静态只有 four.meme 3 个地址(`labels.js:64-66`)。meme 的主战场是 Pancake 池子直接 swap → Swap 事件 → **defi**。3.0% 实际语义是"launchpad 内盘交易量",外盘 meme 买卖全在 defi 里。根因:分类只看 to 地址 + topic 计数,不看 swap 涉及的 token 是谁(见 S6/P2)。

### predict —— 范围内较准(3.3% 笔数,7.6% gas)
30 个 predict.fun 全家桶地址(`labels.js:30-58`)。地址精确 → 范围内准确率高。二次校准:AI 雪球已把覆盖扩到静态表之外——24h top4 `0xdcffeb0c…`(CTF Exchange,40 万笔/天)是学得标签,「其他预测市场覆盖为零」不成立;学得部分的准确性归入 S4 审计。

### bridge —— 中(0.3%)
静态仅 TokenHub `0x…1004`;其余靠 AI 学。主流桥端点(Stargate/LayerZero/cBridge/deBridge 等)未播种,0.3% 大概率低估。

### infra —— 量级已验证合理(5.3%)
静态仅 BlockRazor Payment 1 个地址(`labels.js:61`),live 5.3% 主要来自 AI 学得标签。二次校准(见六):24h top15 里 `0x4848489f…4848`(48Club 支付,vanity EOA,AI 学得)44.2 万笔 + BlockRazor 21.1 万笔,仅两个支付地址即 ≈4%——**5.3% 量级合理,AI 在该类的标注方向正确**。
- **labeler prompt 自相矛盾**(`ai/analyze.js` runContractLabeling):分类定义行写 infra=「MEV builder/relay 支付结算地址,如 BlockRazor Payment」,而地址情报判据行写「EOA 且 nonce 极高 + BNB 收支 → 支付/结算地址(如 builder payment,**归 bnb,不是 bot**)」。实际影响有限:纯 21000 支付流入库即 bnb、不进 contracts 追踪表,到不了 AI 队列;真到了队列的 0x4848 也被正确标为 infra。属文字瑕疵,顺手统一为 infra 即可。

### system —— 高(1.2%)
14 个固定地址可靠(`classifier.js:18-26`);1.2% 与理论量级吻合(每块 1~2 笔 deposit/slash)。
- 地址表不完整:对照 `core/systemcontracts/const.go`,**缺 `0x…2006`(Timelock)、`0x…3000`(TokenRecoverPortal)**;`0x…1004` TokenHub 故意归 bridge(合理)。缺的两个交易量极小,补全属卫生性修复。

### other —— 残差项(4.3%)
定义即"所有规则未命中"。经 14,906 条 AI 标签滚雪球已明显收敛;本身无语义,监控上只需关注其突增(= 新热点合约出现)。

---

## 三、跨分类结构性问题

- **S1 分布占比不可追溯修正**:catPct/allTime 用入库时分类(`store.js addBlock`),后学的 AI 标签只影响热门合约的显示 cat(读取时重解析),不回写历史分布。allTime 的 7.37 亿笔实为"历代分类器版本的混合产物"。
- **S2 AI 队列只清洗 other**(`store.js:124` `c.cat !== "other" → skip`):规则误判(bot→defi、meme→defi、NFT→token)没有任何反馈回路,系统性偏差永不自愈。
- **S3 receipts 静默降级**(`sampler.js:50` `.catch(()=>null)`):失败时 Swap/Transfer 特征全丢(defi/token 判定失效),gas 用 gas limit 顶替(gas 份额虚高)。降级无计数指标,发生率不可见。
- **S4 学得标签库无审计**:14,906 条 AI 标签已是长尾分类的主导来源;无置信度、无过期、无复核(`labels.js:110-125`,唯一保护是 static 不被覆盖)。一条错标签(尤其高频合约)会永久污染其后所有分类。
- **S5 labeler prompt 矛盾**:builder payment EOA 在 prompt 内 infra/bnb 两说(见 infra 节)。
- **S6 ERC20 语义只到合约层**:只消费 tx.to + topic0 计数,不解析 Transfer/Swap 的参数(from/to/token/金额)。这是 cex 充值盲区、meme 归 defi、stable 转账/授权不分、大额转账不可见四个问题的共同根因。

---

## 四、改进建议

### P0(低成本,建议尽快)
1. 稳定币补 FDUSD、USD1(地址见上,已核实);并按 24h token 榜例行补齐新主流稳定币。
2. 修 labeler prompt 矛盾:builder payment EOA 统一归 infra,与静态表口径一致。
3. system 地址补 `0x…2006`、`0x…3000`(对照 `core/systemcontracts/const.go` 全集)。
4. sampler 增加 receipts 失败计数并暴露(日志或 /api/txn 元字段),失败率 >1% 可见。
5. CEX 充值识别:tx 落 stable/token 且 Transfer log 的 `topics[2]`(to 参数)命中 CEX 地址表 → cex。零额外 RPC,直接补上入金方向。

### P1(结构性,中等工作量)
6. AI 复核扩容:除 other 外,每周抽 top20 高频 defi/token 合约重验(纠正规则误判);学得标签加 `reviewedAt`,>90 天的高频标签到期重验。—— 针对 S2/S4。
7. 分布回写:小时桶里已存 `contracts[addr]{n,gas,cat}`,学得新标签时把该 addr 的 n/gas 从旧 cat 挪到新 cat(仅限被 top80 追踪的部分),让近期占比随标签修正。—— 针对 S1,数据结构已支持,成本低。**(二次校准后存疑,见六:监控面板回改历史 = 昨天的图今天变样,且只能修 top80 追踪到的部分,口径反而不一致;倾向不做)**
8. bot 判定增强:①跨块滚动计数(EOA 每分钟 ≥N 笔);②无 verified 名 + 单一非标 selector 极高频的合约 → bot;③把带 Swap 日志但调用方单一的合约纳入 AI 复核样本。
9. Swap 事件签名扩充:StableSwap TokenExchange、DODO 等主流非 UniV2/V3 事件。
10. bridge/infra 静态播种:一次性把主流桥端点与各家 builder 支付地址(48club/BlockRazor/BlockRoute 等)核实后播进 STATIC_LABELS,不再依赖 AI 自学。

### P2(方向性,按需)
11. token 细分:topics 长度区分 ERC721(4)与 ERC20(3);`from=0x0` 的 Transfer = mint;拆出 nft/mint 子类或作为 token 的标注维度。
12. meme 走 token 维度:解析 Swap 涉及的 token 地址,对照 meme token 表(four.meme 工厂创建的 token 可枚举),把 defi 里的外盘 meme 交易分出来。需要 per-log 参数解析 + token 表维护,是 meme 类唯一的根治路径。
13. 准确率量化:每周每类抽 50~100 笔,对照 BscScan 标签/人工判定出准确率报表,把本文的"低/中/高"变成可跟踪的数字。

---

## 五、快速对照表(结论汇总)

| 分类 | 判断 | 一句话根因 | 关键代码 |
|---|---|---|---|
| bot | 低 | 启发式误报(≥3 同块)与漏报(单发 MEV、非零头 selector)都明显 | classifier.js:78-79 |
| defi | 中 | Swap 事件可靠,但地址优先规则过宽 + 吸收 bot/meme | classifier.js:72,82 |
| token | 中 | ERC20/NFT/mint/claim 混在一起 | classifier.js:89-90 |
| bnb | 中高 | 21000 gas 可靠,未检查金额 | classifier.js:76,85 |
| stable | 高精度低覆盖 | 只认 5 个,缺 FDUSD/USD1 | labels.js:69-73 |
| cex | 低覆盖 | ERC20 充值方向看不见(只看 tx.to) | classifier.js:71 |
| meme | 低覆盖 | 外盘买卖全被算成 defi | labels.js:64-66 |
| predict | 范围内较准 | 本质是 predict.fun 地址统计 | labels.js:30-58 |
| bridge | 中 | 已知桥准,未知桥靠 AI | labels.js:90 |
| infra | 中(量级已验证) | 48Club+BlockRazor 两个支付地址即 ≈4%,AI 标注方向正确 | labels.js:61 |
| system | 高 | 固定地址可靠,缺 2006/3000 | classifier.js:18-26 |
| other | 无语义 | 残差项,只需盯突增 | — |

---

## 六、二次校准(2026-08-24,对本 review 自身的数据验证)

用线上 24h top15 合约 + eth_getCode 对 review 的结论做了一轮对抗验证,**以下按"是否真实问题"重新分层**;与上文冲突处以本节为准。

### A. 确凿且值得动手(代码+数据双证)
1. **学得标签库无审计(S4)+ 反馈回路只清洗 other(S2)** —— 本 review 唯一的结构级真问题。top15 里 8 条 ai=True 且多数 name=null(如 39 万笔/天的 `0x1de460f3…` 标 defi),对错无人复核;落 defi 的 bot 永不进队列(`store.js:124` 可证)。最高价值动作是 **top 学得标签抽审**,而非加规则。
2. **cex ERC20 充值盲区** —— 代码可证(`classifier.js:71` 只看 tx.from/to)。但修复有语义代价:同一笔 USDT 充值只能记 cex 或 stable 之一,先定口径再动手。
3. **meme 3.0% 的真实语义 = launchpad 内盘** —— 真问题;根治(P2 token 维度)贵,便宜且正确的第一步是面板口径注释,防止读成"全市场 meme 活跃度"。

### B. 真实但影响小(卫生性,顺手修)
4. 稳定币缺 FDUSD/USD1 —— 缺是真的,但**"大头"说重了**:均不在 top15(单个 <0.8%),补齐挪动 0.5~1.5pp。
5. system 缺 `0x…2006`/`0x…3000` —— 真缺(对照 const.go),交易量≈0。
6. receipts-only 失败无计数 —— 盲区真实,NodeReal 上应当罕见,加计数即可证实/证伪。
7. bnb 不看金额 —— 真,极小。

### C. 收回或降级(review 说过头的)
8. **「infra 5.3% 可信度低」——收回**。构成已验证:48Club 支付 `0x4848489f…4848`(EOA)44.2 万 + BlockRazor 21.1 万 ≈4%,量级合理,AI 标对了。
9. **prompt infra/bnb 矛盾——降级为文字瑕疵**。纯支付流到不了 AI 队列;到了队列的也没被带偏(0x4848 为证)。
10. **「predict 范围外覆盖为零」——说错**。`0xdcffeb0c…` CTF Exchange(40 万笔/天)是 AI 学来的,雪球已自行扩圈。
11. **bot ≥3 同块"误报批量分发"——说重了**。真正的批量分发是单笔 multisend,不触发该规则;450ms 内同 from ≥3 笔非转账合约调用基本就是自动化。bot 的真问题只在漏报侧(单发 MEV 落 defi)。
12. **Swap 事件覆盖窄——紧迫性降级**。主流替代 AMM 的 router 多已有静态标签,直调 pool 落 other 后由 AI 队列自愈。
13. **P1-7 分布回写——自我否决**(理由见上标注)。
14. WBNB wrap→defi、EntryPoint→defi、NFT selector 撞车 —— 技术上对,但属口径选择或 BSC 上量级可忽略,不列为待修。

### 收敛后的行动清单
- **立刻**:top50 学得标签抽审;labeler prompt 统一 infra 措辞;补 4 个地址(FDUSD/USD1/2006/3000);sampler receipts 失败计数。
- **定口径后**:cex 充值 `topics[2]` 识别;meme 面板口径注释。
- **不做/缓做**:分布回写、Swap 签名扩充、bot ≥3 规则改动。

---

## 七、最终核实结论(2026-08-30)

本节综合代码复核、BSC 主网只读检查、公开方法签名和本地持久化标签数据。**与前文冲突时以本节为准。**

### 7.1 最终结论

当前 TXN 分类适合做流量方向和热点观察,但仍不适合作为严格的业务真值。最终确认的核心问题不是某一个静态地址漏配,而是:

1. 单一互斥 `cat` 混合了行为、资产和主体三个维度;
2. AI 学得标签缺少审计、证据和复核机制;
3. AI 反馈队列只接收 `other`,非 other 的规则误判和 AI 错标无法自愈;
4. 历史桶冻结入库时分类,趋势混合不同分类器和标签版本;
5. receipts 降级和缺块没有完整的数据质量指标。

### 7.2 最终保留的问题

#### A. 学得标签无审计 + 只复核 other —— 最高优先级

该问题完全成立。`unknownHot()` 只接收桶内 `cat == other` 且当前标签为空或仍为 other 的地址;已被标为 defi/token/bot/infra 等类别后不会重新进入队列。

本地标签文件也证明审计能力不足:当前 260 条 learned labels 中 249 条 `name` 为空(95.8%),且没有 confidence、evidence、modelVersion、reviewedAt 或过期策略。

需要注意:`0x1de460f3…` 不是已经证明的错标。其主 selector `0x4d819a2a` 可反查为 `swap(...)`,小时桶中也有大量 Swap 日志,标为 defi 有较强行为证据。这个案例证明的是“证据没有随标签保存”,不是“标签一定错误”。

#### B. CEX ERC20 充值盲区 —— 成立

分类器只检查顶层 `tx.from/tx.to`;ERC20 充值的实际 CEX 收款地址位于 `Transfer` log 的 `topics[2]`,因此充值通常落 stable/token,提现则可能因 `tx.from` 命中热钱包而落 cex。

修复前必须先定口径:在单分类模型里,一笔 USDT 充值只能选 cex 或 stable。长期建议拆成正交字段:

```text
activity = token_transfer
actor    = cex
asset    = stable
```

#### C. Meme 3% 的口径 —— 成立

当前 meme 主要表示已识别 launchpad/目标合约的直接调用。通过 PancakeSwap 等外盘交易的 Meme 币通常进入 defi。因此前端应先改成“已识别 Meme Launchpad 调用”,不能展示成全市场 Meme 活跃度。

#### D. Bot 高频计数实现错误 —— 必须保留

前文用 multisend 作为误报例子不够准确,但不能因此撤回实现问题。`fromCounts` 统计同一发送方的全部交易,而不是文档定义的“合格合约调用数”。

主网最近 60 个块的抽样结果:

- 734 笔被判为 bot;
- 189 笔来自同发送方高频规则;
- 其中 29 笔没有达到“至少 3 笔合格合约调用”,只是发送方总交易数达到 3;
- 约占高频规则 bot 的 15.3%,占全部 bot 的 4.0%。

因此 bot 的主要风险虽然仍偏向漏报(单发 MEV、调用已知 Router 的 Bot),但误判侧并非不存在。应修正为“只统计合格调用数”,无需删除高频规则。

#### E. 历史分类版本混合 —— 仍是结构性问题

否决“按 top80 粗暴回写历史”是正确的,但不代表 S1 消失。标签更新只影响新入库交易,同一地址可能昨天算 other、今天算 defi,7 天趋势会混入标签学习造成的变化。

不建议改写旧桶。更安全的方案是每个桶记录 `classifierVersion` 和 `labelVersion`,版本变化时在趋势上标记断点或避免直接环比。

#### F. receipts 静默降级 —— 成立

`eth_getBlockReceipts` 失败后返回 null 并继续分类,会同时丢失 Swap/Transfer 特征,并用 gas limit 代替实际 gasUsed。增加失败计数只是第一步;最终应重试、隔离不完整块或在 API 输出 coverage/receiptCoverage。

### 7.3 经数据校准后降级的问题

#### Infra 5.3% 的量级本身合理

`0x4848489f…4848` 已由 48Club 官方文档确认是 Puissant Builder Control EOA;BlockRazor 地址也是 EOA。按线上快照:

- 48Club 44.2 万笔,约占 2.70%;
- BlockRazor 21.1 万笔,约占 1.29%;
- 两者合计约 3.98%。

因此 infra 总计 5.3% 在量级上合理,不应继续描述为“明显不可信”。但这不能证明整个 AI 标签库可靠:当前本地 learned labels 反而把同一个 48Club 地址标成 `bot`,说明不同学习轮次/环境可能得到不一致结果。

#### Predict 已超出静态地址表

线上 `0xdcffeb0c…` 的主方法 selector 反查为 `matchOrders(...)`,行为与订单簿/CTF Exchange 相符,说明 AI 雪球确实能扩展静态 predict.fun 地址表。此前“范围外覆盖为零”的表述应撤回。

但具体协议身份仍应随标签保存 verifiedName、合约源码或链上核实证据,不能只依赖模型输出名称。

#### FDUSD/USD1 是真实漏配,但影响较小

两个地址均已通过主网 `symbol()/name()` 核实。它们不在该线上 24h top15 中,由 top15 阈值只能得到两者合计影响的理论上限约 1.6pp,不能严格推出 0.5pp 下限。

此外漏量不会全部从 token 搬到 stable:部分交易当前属于 cex、defi、other 或 bot。最终表述应为“值得补齐,预计不改变整体大盘;实际影响需按地址从线上桶聚合”。

#### Swap 签名扩充紧迫性较低

主流 Router 多有静态标签,未知非标准协议落入 other 后有机会进入 AI 队列。扩签名仍能提高首轮召回和减少对 AI 的依赖,但优先级低于标签审计、CEX 盲区和采集质量。

### 7.4 Prompt 冲突的最终判断

Prompt 同时写有:

- builder payment → infra;
- builder payment → bnb;
- 允许分类列表中又没有 bnb。

这不是单纯文字瑕疵。虽然纯 21000 gas 支付通常先归 bnb、可能到不了 AI 队列,但带 calldata、自交易或先落 other 的 Builder EOA 仍可能进入学习流程。本地 48Club 地址被 AI 标为 bot,也说明结果并不稳定。

在现有单分类模型下应统一为 infra;长期则将其拆成 `actor=builder`、`activity=bnb_payment`。

### 7.5 最终行动清单

#### 立即执行(P0/P1)

1. 按 24h 交易量对 top50 learned labels 做人工/链上抽审;
2. 标签持久化增加 `evidence`、`confidence`、`modelVersion`、`reviewedAt`;
3. 扩大复核队列,允许高流量 learned defi/token/bot/infra 定期重验;
4. 修正 Bot 高频规则:阈值只统计合格合约调用;
5. 统一 labeler 中 builder payment 为 infra;
6. 补 FDUSD、USD1、Timelock `0x…2006`、TokenRecoverPortal `0x…3000`;
7. 增加 receipts 失败数、完整率和缺块覆盖率;
8. 小时桶记录 `classifierVersion` 和 `labelVersion`。

#### 定口径后执行

1. 用 Transfer `topics[2]` 识别已知 CEX 收款地址;
2. 明确 CEX 与 stable/token 的优先级,或直接拆成多维标签;
3. 前端把 Meme 改为“已识别 Meme Launchpad 调用”;
4. 前端说明所有占比是规则/标签估算,同一交易只展示一个主分类。

#### 不建议直接执行

1. 不按 top80 合约明细粗暴改写全部历史分布;
2. 不因为 top15 地址归因合理就默认全部 AI 标签可信;
3. 不取消 Bot 高频规则,只修正其计数对象;
4. 不把补两个稳定币地址描述成稳定币统计已经完整。

### 7.6 最终可信度分层

| 分类 | 最终判断 | 可解释口径 |
|---|---|---|
| system | 高精度、覆盖待补 | 已知系统地址调用 |
| bnb | 中高 | 21000 gas/低 gas 空 input 近似转账 |
| stable | 高精度、低覆盖 | 已配置稳定币合约调用 |
| predict | 中高、含 AI 扩展 | 已识别预测市场合约调用 |
| infra | 中、量级合理 | 已识别 Builder/支付地址交互 |
| defi | 中 | 已知 DeFi 地址或标准 Swap 事件 |
| token | 中 | 广义 Transfer 行为,含 NFT/mint/claim |
| bridge | 中低覆盖 | 已知 Bridge 地址调用 |
| cex | 低覆盖 | 已知 CEX 顶层地址交互,主要漏充值 |
| meme | 低覆盖 | 已识别 Launchpad/目标合约调用 |
| bot | 低至中 | Bot 特征命中,不等于真实 Bot 总量 |
| other | 无业务语义 | 所有规则未命中的残差 |

**最终产品结论:**当前页面可以回答“规则命中结构和已识别热点如何变化”,不能严格回答“BSC 全网真实 Bot/Meme/CEX/稳定币业务占比是多少”。
