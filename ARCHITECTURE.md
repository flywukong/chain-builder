# BSC DevOps Assistant — 架构文档 v3

> 信息架构 + AI 分析层。进场以 Validator Ring 为主视觉，下沉式子系统导航；每个子系统内置「一键 AI 分析」。AI 两层：默认云端 API 快速分析，Codex CLI 作代码感知深挖；MCP 作为 AI 的链上/文档查询工具箱。
>
> 可视化版：`docs/architecture-v3.html`（浏览器打开）。执行计划：`PLAN.md`。实时采集层：`docs/design-v3-realtime.html`。

最后更新：2026-06-28

---

## 1. 定位

不只是监控大盘，而是「BSC 研发运营全能助手」。核心区别：大量**一键分析**按钮 —— 用户需要深入时点一下，AI 顺着链上事实/源码自动分析。

- **v1.0**：实时监控基座（WS 采集 + Ring + 面板 + 子系统数据视图），无 AI
- **v1.1+**：逐步加 AI 分析能力

---

## 2. 信息架构（进场 → 子系统）

进入即见 Validator Ring + 节点版本分布；下方一排子系统入口。点任一子系统进入详情视图，**AI 分析按钮在子系统内部、贴着对应数据**。

```
┌─────────────────────────────────────────────────────────────┐
│ HOME / 进场                                                    │
│ ┌──────────────────────────┐  ┌──────────────────────────┐  │
│ │  Validator Ring（轨道核心）│  │  VERSION 节点版本分布      │  │
│ │  实时出块轮询动效          │  │  v1.7.3 ████████ 32       │  │
│ │  proposer 连续出 8 块      │  │  v1.7.2 ███ 9             │  │
│ │  #块高 / 0.45s / MEV%      │  │  v1.6.4 █ 3 ⚠落后         │  │
│ └──────────────────────────┘  └──────────────────────────┘  │
│ ── 子系统入口 ──────────────────────────────────────────     │
│ [📊 Monitor] [💎 MEV分析] [🌊 流量分析] [🔍 异常分析]            │
│ [💾 存储] [🐛 Issues] [🔔 告警]                                 │
└─────────────────────────────────────────────────────────────┘
                          │ 点击子系统
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 子系统视图（例：🌊 流量分析）                                   │
│  Gas 趋势 · TxPool 深度 · tx 构成 · gas price · 大流量标注      │
│                          [⚡ AI 异常大流量分析]  [🔬 Codex 深挖] │
└─────────────────────────────────────────────────────────────┘
```

**Monitor 大盘 = 一眼看完的总览**（含稳定性概览 slash/reorg/latency + 基础 MEV%/gas + BlockRiver），无 AI 按钮。
**MEV / 流量 / 异常 / 存储 = 深度分析子系统**，各自带「⚡ AI 分析」按钮。

> 设计原则：稳定性、MEV 概览这类"一眼看"的信息留在 Monitor 大盘；需要展开钻取 + AI 分析的，独立成子系统。MEV 信息丰富（builder 格局、bid 竞争、v1/v2 趋势），单独成「MEV 分析」；原"稳定性"重定位为「异常分析」（聚焦慢块/漏槽/reorg/slash 的深度归因，而非概览展示）。

---

## 3. 子系统 × AI 能力矩阵

| 子系统 | 核心视图 | ⚡ 默认 AI（云端 T1） | 🔬 深挖（Codex T2） |
|--------|---------|---------------------|---------------------|
| 📊 Monitor 大盘 | Gas/Latency/BlockRiver + **稳定性概览(slash/reorg)** + 基础 MEV% 总览 | — 纯监控总览 | — |
| 💎 MEV 分析 | Builder 分布·MEV占比趋势·v1/v2(bidblock)·bid竞争·per-builder统计·local块占比 | MEV 格局变化/占比突变归因、某 builder 异常 | 结合 bid/miner 源码深挖 |
| 🌊 流量分析 | Gas趋势·TxPool·tx构成·gas price·大流量标注 | 异常大流量归因（MEV/合约事件/外部冲击） | 读热点合约源码深挖成因 |
| 🔍 异常分析 | Slash·Reorg·慢块·漏槽时序（深度钻取，非概览） | slash/reorg/漏槽 根因 + 处置建议 | 读 parlia 共识源码定位根因 |
| 💾 存储 | 节点磁盘·目录大小·增长趋势 | 增长异常分析 + 清理/扩容建议 | 结合 pruning/db 源码分析 |
| 🐛 Issues/Bounty | 每日拉 bnb-chain/bsc issues + Immunefi | 优先级评估 + 分类 + 摘要 | **读 bsc 源码 → triage/根因/修复思路** |
| 🔔 告警 | Keter urgent + 链上告警聚合 | 处理思路 + 值班指引 | 关联代码/历史告警深挖 |

> Monitor 大盘只放"一眼看"的稳定性/MEV 概览；深度钻取与 AI 归因在 MEV 分析 / 异常分析。Issues 子系统的 Codex 深挖是其最大价值点 —— Codex 作为编码 agent，能把 issue 对着源码分析。

---

## 4. AI 分析层（核心设计）

所有子系统共用 `AIAnalysisService`：按子系统装载「配方（recipe）」拉**种子上下文**，交给推理 provider 跑 **tool-use 循环** —— provider 推理中按需调 **MCP 工具**查更多链上事实/文档，最后流式产出。比"后端提前 gather 全部数据"更强：AI 能顺线索自查。

```
AIAnalysisService
├── 推理 Provider（tool-use 循环）
│   ├── CloudProvider   云端 AI API（Claude/OpenAI），默认，function-calling
│   └── CodexProvider   "codex exec" headless，cwd=本地 bsc 源码，深挖读码（原生 MCP）
└── MCP 工具箱（read-only，挂给 provider 按需调）
    ├── BNBChainMcpTools  官方 bnbchain-mcp：get_block / get_transaction / get_transaction_receipt
    │                     · read_contract / is_contract · get_native_balance / get_erc20_*
    │                     · get_chain_info
    └── AskAiMcpTools     BNB docs / BEP / blog 语义检索
```

### 4.1 两条流水线

**⚡ DEFAULT（秒级流式，tool-use 循环）**
```
① 子系统按钮 → POST /api/ai/analyze {subsystem, params}
② Recipe.gather → 拉种子上下文（起点数据，非全部）
③ Provider × 工具循环 → CloudProvider 推理 ⇄ 按需调 MCP 工具查链上事实/文档，反复直到结论
④ SSE → 前端 <AIAnalysisPanel> 流式渲染 markdown：现象 → 归因 → 建议（带链上事实/BEP 引用）
```

**🔬 DEEP DIVE（分钟级，代码感知，按需触发）**
```
① 深挖按钮 → POST /api/ai/deepdive {subsystem, context}
② Codex Adapter → spawn codex CLI（headless），cwd = 本地 bsc 源码（BSC_SOURCE_PATH）
③ Codex 读相关源码/issue，推理根因/修复，stdout 流（Codex 原生支持 MCP，可同时用工具箱）
④ 归一为 token 流 → SSE → 追加到分析面板
```

### 4.2 安全硬约束（⚠ 必须守住）

bnbchain-mcp 支持转账/合约写（需 `PRIVATE_KEY`）。**AI 层绝不配 `PRIVATE_KEY`** + 工具白名单只放只读工具，**禁止 AI 触发 transfer / write / approve**。AI 只读链上事实，不动资产。

### 4.3 接入要点

- **Provider 抽象**：CloudProvider / CodexProvider 同一 `run(prompt, seedCtx, tools)` 接口，配置切换，换模型/加 provider 不动业务。
- **MCP client**：后端作 MCP client 接 bnbchain-mcp（stdio 起子进程 或 SSE），把只读工具暴露给 provider 的 tool-use。
- **本地源码**：服务端配 `BSC_SOURCE_PATH` 指向本地 bsc checkout，Codex 读本地最新源码、不每次联网抓；可选 `BSC_SOURCE_AUTO_PULL` 定期 `git pull`。
- **流式 + 缓存**：两层都走 SSE，复用同一 `<AIAnalysisPanel>`；结果按 `(subsystem + context hash + 时间桶)` 缓存；Codex 深挖加任务队列 + 进度态。
- **边界**：MCP 只服务 AI 层（v1.1/v1.2）。它的 `get_latest_block` 是 RPC 轮询式，**不替代 v1.0 的 WS newHeads 实时采集**。

---

## 5. 系统架构（分层）

```
FRONTEND  React + Vite · WebSocket client · Canvas charts · 无重依赖
  ├─ Home / 进场         Validator Ring + Version 分布 + 全局 KPI
  ├─ Subsystem Router    6 子系统视图切换
  └─ AIAnalysisPanel     SSE 消费 + markdown 流式渲染（共享组件）
        │  WS push · REST · SSE(AI)
        ▼
BACKEND   Node.js + Fastify
  ├─ BlockStreamer       WS newHeads + SeqGuard 补块/reorg + 0.45s blocktime  ← v1.0 实时
  ├─ ChainContracts      ValidatorSet / Slash / StakeHub · parlia_*
  ├─ KeterClient         Prometheus: latency / nodes / disk / version
  ├─ GitHubFetcher       每日拉 bsc issues + Immunefi（增量缓存）              ← v1.2
  └─ ★ AIAnalysisService recipes + Provider(Cloud/Codex) + MCP client(bnbchain-mcp 只读 + AskAi)
                         + SSE + 缓存/队列                                     ← v1.1/v1.2
        │  RPC(WSS+HTTP) · Prometheus · GitHub · MCP · Codex/Cloud
        ▼
SOURCES
  数据源:  BSC RPC（WSS newHeads + parlia_* + getBlockMevInfo + txpool）· Keter/Prom · GitHub/Immunefi
  AI:     bnbchain-mcp（链上 read-only）· AskAi MCP（docs/BEP）· Codex CLI（本地源码）· Cloud AI API
```

---

## 6. 数据源 / RPC 参考

| 方法 / 数据 | 通道 | 频率 | 用途 |
|------------|------|------|------|
| `eth_subscribe("newHeads")` | WS PUSH | 逐块 | 主采集，出块心跳（v1.0） |
| `eth_getHeaderByNumber` | 补块 | 按需 | 缺口补齐、reorg 重取、milliTimestamp |
| `eth_getBlockMevInfo` | REST | 逐块 | builder 归属、MEV 类型 |
| `parlia_getValidators` | CONSENSUS | 每 epoch | Ring 活跃集合 |
| `parlia_getTurnLength` | CONSENSUS | 每 epoch | 连续出块数（当前 8，动态读） |
| `parlia_getJustifiedNumber` / `getFinalizedNumber` | CONSENSUS | 逐块 | Fast Finality lag（v1.1） |
| `SlashIndicator` 合约 | CHAIN | 30s | slash 计数/状态 |
| Keter / Prometheus | HTTP | 30s | node_stats / latency / disk |
| GitHub / Immunefi | HTTP | 每日 | Issues/Bounty（v1.2） |
| bnbchain-mcp | MCP | AI 按需 | AI 链上 read-only 查询（v1.1） |
| AskAi MCP | MCP | AI 按需 | docs/BEP/blog 语义检索（v1.2） |
| Cloud AI API / Codex | — | AI 触发 | 推理 / 深挖 |

> 当前出块 **0.45s**（Fermi, 2026-01-14），finality **1.125s**。详见 `docs/design-v3-realtime.html`。

---

## 7. 版本路线图

| 版本 | 主题 | 内容 |
|------|------|------|
| **v1.0** | 实时监控基座 + IA | WS 采集层、IA 重构（Home=Ring+Version → 子系统）、Ring、各子系统数据视图、规则告警、部署。AI 按钮占位 |
| v1.1 | 深度分析 + AI（T1） | AIAnalysisService + CloudProvider + **bnbchain-mcp 只读工具**、MEV/流量/异常/存储 一键分析、Fast Finality 监控 |
| v1.2 | Codex 深挖 + 研发辅助 | CodexProvider（读源码）+ **AskAi MCP**、Issues/Bounty 子系统、告警 AI 处理 |
| v2.0 | 企业化 | Google OAuth(@bnbchain.org)、Slack/微信推送、告警规则/静默/历史、值班日报 |

> provider + 工具抽象让 v1.1 先上云端+MCP、v1.2 再补 Codex/AskAi 不返工。

---

## 8. 关联文档

- `PLAN.md` — 分阶段执行计划（Phase 0–5）
- `docs/architecture-v3.html` — 本文档可视化版
- `docs/v1-scope.html` — v1.0 功能范围清单
- `docs/design-v3-realtime.html` — WS 实时采集层设计（0.45s / SeqGuard）
- `docs/orbital-core.html` — Validator Ring 视觉
- `frontend/src/data/validators.js` — validator 名单 + 集团分组（来自 BSC Node List.xlsx）
