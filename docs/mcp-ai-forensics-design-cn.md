# MCP 赋能设计:AI 自主取证如何服务 BSC 运营

> 2026-07-13 · BNB Chain Ops
> 方向:本系统作为 **MCP client**,让 AI 分析引擎(claude CLI)在推理过程中自主调用外部 MCP(首个:[bnb-chain/bnbchain-mcp](https://github.com/bnb-chain/bnbchain-mcp))查证链上事实。
> **不做**本系统的 MCP server 化;内部指标(keter/事件/统计)继续走后端预拼上下文。

---

## 1. 定位:从「预拼数据的解说员」到「会查证的分析师」

| | 现状(预拼喂数据) | MCP 后(自主取证) |
|---|---|---|
| AI 能看到的 | 后端提前拼好的 payload(keter 统计、事件、采样块) | 同左 + **按需查任意链上事实** |
| 归因深度 | 受预取数据限制,"未知合约 0x1234 占主导" | 追查到实体:"four.meme 新盘 XX 的抢购机器人集群" |
| 交互模式 | 一问一答,答不出就到此为止 | 多轮工具循环:发现线索 → 查证 → 修正结论 |
| 适用入口 | 所有面板解读(快,~30s) | 深度归因/问答入口(慢,1-2min,值得等) |

核心洞察:后端 AI 走 `claude -p`(headless CLI),CLI **原生支持** `--mcp-config` + `--allowedTools`,接入只需给 `spawnClaude` 加参数,无需自研 MCP client。

---

## 2. 运营场景 × MCP 能力(核心设计)

### 场景 1 · 大流量/拥堵值班处置(最高频)

**现状痛点**:检测到 pending>4000 后,AI 只能就预采样的 8 个块归因,遇到未知合约只能报地址。

**MCP 取证链**:
```
事件块区间(已有,5m 精化) 
→ get_block_by_number 加密采样可疑时段
→ 发现 top 合约 → read_contract(name/symbol/decimals/totalSupply) 识别实体
→ get_transaction 抽查 top sender 的交易形态(nonce 连续性、gas 出价)
→ get_native_balance 判断发送方是脚本集群(余额刚好够 gas)还是真实用户
```

**产出**:归因报告 + 处置建议 —— "four.meme 新盘抢购,~N 个机器人地址,预计随 mint 结束自行消退,无需干预" / "单地址高频自转刷量,建议观察 dataseed 负载"。

### 场景 2 · Reorg 事件排查

**现状痛点**:canonical 序列是等步长采样(60 点),gap 定位精度受步长限制;被重组方无法确认。

**MCP 取证链**:
```
5m 精化时刻 ± 区间(已有)
→ AI 对可疑 gap 逐块 get_block_by_number(全量而非采样)→ 边界精确到单块
→ 查赢家/前任 validator 相邻块的毫秒时间戳、gasUsed、txs 数
→ (用户报告交易丢失时)get_transaction_receipt 验证交易是否仍在链上
```

**产出**:reorg 边界块号 + 赢家 validator + 是否有用户交易受影响 + 严重度。

### 场景 3 · Validator 运营(空块/出块质量)

**MCP 取证链**:某 validator 空块聚集 → 查它同时段**全部**块(是连续空还是间歇)→ 对比同时段其他 validator → 区分「节点故障(连续空,需联系运营方)」vs「mempool 时序波动(偶发,正常)」。

**产出**:带块号证据列表的联系话术,运营方无法推诿。

### 场景 4 · MEV / Builder 生态运营

**MCP 取证链**:builder 份额突变(HHI 告警)→ 查突变时段块尾部结算 tx 的 to 地址 → `is_contract` + `read_contract` 识别新增/消失的 builder 结算合约 → 判断"新 builder 上线 / 某 builder 掉线 / 地址轮换"。

**产出**:builder 变动报告(附结算地址证据),v2 推进期可验证 bidblock 块特征。

### 场景 5 · 异常合约安全初筛

**MCP 取证链**:TXN 页未知合约爆量 → `read_contract` 基本信息 → `get_transaction` 追创建者资金来源 1-2 跳 → `get_erc20_token_info` 看代币形态 → 初判「新 DEX / 疑似貔貅 / 疑似攻击」。

**产出**:5 分钟初筛报告给安全团队(**边界:不做深度资金追踪**,那是专业工具的活)。

### 场景 6 · LEO 问答升级为「链上运营助手」⭐

现状 LEO 只能答监控快照。MCP 后运营者可以直接问:

- "块 109,183,886 里最大的交易是什么?"
- "0xabc… 是合约吗?最近活跃吗?"
- "帮我看 XX validator 最近 100 块的出块间隔有没有异常"
- "这个地址给哪些合约授权过?"

LEO 现场查、现场答,**不用打开 bscscan 手翻**。这是"信息整合平台"最直观的兑现。

### 场景 7 · 硬分叉/升级运营(Pasteur 等)

激活块 ±N 块自动验证:gasLimit 变化、新字段生效、块时间稳定性 → 结合已有版本覆盖率数据 → 输出"激活平稳"巡检报告。

---

## 3. 工具白名单矩阵

| bnbchain-mcp 工具 | 场景 | 白名单 |
|---|---|---|
| `get_block_by_number` / `get_block_by_hash` / `get_latest_block` | 1/2/3/4/7 | ✅ |
| `get_transaction` / `get_transaction_receipt` | 1/2/5/6 | ✅ |
| `read_contract` / `is_contract` | 1/4/5/6 | ✅ |
| `get_erc20_token_info` / `get_erc20_balance` | 1/5/6 | ✅ |
| `get_native_balance` | 1/5/6 | ✅ |
| `get_chain_info` / `get_supported_networks` | 6 | ✅ |
| `estimate_gas` | 6 | ✅(只读模拟) |
| `transfer_*` / `write_contract` / `approve_token_spending` | — | ⛔ 永不放行 |
| `get_address_from_private_key` / ERC-8004 注册类 | — | ⛔ 永不放行 |
| Greenfield 文件类 | 暂无场景 | ⛔ 暂不放行 |

**安全硬约束**(不可妥协):
1. `--allowedTools` 显式白名单,headless 模式未白名单工具默认拒绝 —— 双保险
2. 运行环境**绝不配置 PRIVATE_KEY**
3. MCP 进程与后端同机 stdio,不暴露网络端口

---

## 4. 架构

```
面板/问答请求
  → server.js 路由:预拼上下文(keter 统计 + 事件 + 块区间 + 标签库摘要)   ← 不变,快且省 token
  → spawnClaude(prompt, { mcp: true })                                    ← 新增可选项
       claude -p --mcp-config .mcp/bnbchain.json
                 --allowedTools "mcp__bnbchain__get_*,mcp__bnbchain__read_contract,..."
       AI:读上下文 → 按需多轮调工具 → 输出结论(要求引用块号/地址等可验证事实)
```

- **内部数据不 server 化**:keter 指标/事件统计继续预拼(MCP 只补链上事实查证)
- 已有的 5min TTL 结果缓存天然覆盖 MCP 模式(同参数不重跑)
- 标签库(labelBook)以摘要形式注入 prompt,AI 识别出新实体后可回写(P1 再做)

**已知风险与对策**:

| 风险 | 对策 |
|---|---|
| bnbchain-mcp 默认公共 RPC 有限流 | 验证能否以环境变量覆盖 RPC;不行则提 issue / fork 配我们的 nodereal endpoint |
| 工具循环拉长时延(30-40s → 1-2min) | 只在深度入口启用(事件归因/LEO 问答);常规面板解读维持预拼模式 |
| token 成本上升 | TTL 缓存已有;深度入口本就低频 |
| AI 编造 | prompt 延续现有风格:结论必须引用块号/地址/数值,查不到就说查不到 |

---

## 5. 分阶段落地

- **P0(一轮可完成)**:`.mcp/bnbchain.json` + `spawnClaude({mcp})` + 白名单;接入两个入口 —— **LEO 自由问答**(场景 6)+ **流量单事件归因**(场景 1)。跑 1-2 周对比归因质量。
- **P1**:reorg 单事件归因(场景 2)、空块 validator 取证(场景 3)、TXN 页未知合约「深挖」按钮(场景 5);AI 识别的新实体回写标签库。
- **P2**:builder 变动侦测(场景 4)、升级巡检(场景 7)、自动巡检(LEO 每小时巡检时对异常主动取证);接入 AskAi MCP(BEP/文档语义检索,答协议类问题)。
