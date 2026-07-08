# BSC Monitor — 执行计划

> 有条理的分版本规划。本版（v1.0）目标：**把实时采集基座做对（0.45s / WebSocket），交付一个准确完整的监控大盘**。AI 类"全能助手"功能放到后续版本。

最后更新：2026-06-28

---

## 1. 版本策略

| 版本 | 主题 | 范围 |
|------|------|------|
| **v1.0（本版）** | 实时监控基座 + IA | WebSocket 采集层、**IA 重构（Home=Ring+Version → 子系统导航）**、Validator Ring、各子系统数据视图、规则告警、部署。AI 按钮先占位 |
| v1.1（下一版） | 深度分析 + AI（T1 云端） | **Fast Finality 监控**、`AIAnalysisService` + CloudProvider + **bnbchain-mcp 只读工具**、MEV/流量/异常/存储 的「⚡ 一键分析」 |
| v1.2 | Codex 深挖 + 研发辅助 | CodexProvider（T2 深挖，读源码）+ **AskAi MCP**、Issues/Bounty 子系统（每日拉取 + Codex 分析）、告警 AI 处理 |
| v2.0 | 企业化 | Google OAuth(@bnbchain.org)、Slack/微信推送、告警规则/静默/历史、值班日报 |

> 信息架构与 AI 分层见 `docs/architecture-v3.html`。AI 两层：**默认云端 API（T1，快速流式）+ Codex CLI（T2，读 bnb-chain/bsc 源码深挖）**，统一 `AIAnalysisService` + Provider 抽象，v1.1 先上 Cloud、v1.2 补 Codex 不返工。
> **MCP 工具箱**：AI 推理时通过 MCP 按需查事实 —— `bnbchain-mcp`（链上 read-only）+ AskAi MCP（docs/BEP）。⚠ **只读硬约束**：不配 PRIVATE_KEY + 工具白名单，禁止 AI transfer/write。MCP 仅服务 AI 层，**不替代 v1.0 的 WS newHeads 实时采集**。

**明确划到下一版的（本版不做）**：
- ❌ Fast Finality 采集（justified/finalized lag）→ v1.1
- ❌ "一键分析" AI 按钮（Claude API）→ v1.1
- ❌ GitHub Issues + AI、Bug Bounty → v1.2
- ❌ 智能告警处理（AI 值班指引）→ v1.2
- ❌ 鉴权 / 推送 → v2.0

---

## 2. v1.0 范围（2026-06-30 调整：分析重心收敛到「流量」）

**分析重心 = 流量分析**（纯链上数据可分析）。**slash/异常不做深度分析**（依赖 validator 日志，拿不到）—— slash/reorg/慢块只在 Monitor 大盘里**展示数量**（链上 SlashIndicator + 块流），不做独立"异常分析"子系统（已从导航移除）。

**做**：实时区块流、Validator Ring（turnLength 模型）、MEV/builder、**流量分析（Gas/大流量识别，重心）**、Block insert latency、slash/reorg 展示、Block River、版本分布、规则告警聚合、部署。

**不做**：任何 AI 分析、Fast Finality、异常深度分析(需日志)、鉴权、外部推送。

子系统（6）：Monitor 大盘 / 💎MEV / 🌊流量(重心) / 💾存储 / 🐛Issues / 🔔告警。

---

## 3. 分阶段执行

> 原则：**基础设施先行**（streamer.js 重写是一切的根基），跑通真实数据后，再按面板逐步补。每个阶段有明确交付物和验收点。
>
> **v1.0 到部署的路径（2026-06-30 定）**：Phase 2（Ring 出块模型）→ Phase 3（0.45s 校准 + 流量分析做实）→ **Phase 5 部署看效果**。Phase 4（Storage/TxPool 后端查询）推迟到部署之后再补。

### Phase 0 — 采集层重写（最优先）🔴 ✅ 已实现（离线验证通过，live 待你的环境）
streamer.js 是地基，必须先做对。
- [x] `streamer.js` 改为 WebSocket `eth_subscribe("newHeads")` 推送（`ws` 库）
- [x] **SeqGuard**：去重 + parentHash 链接性校验 → 跳号触发 backfill、回退标记 reorg（串行处理队列防竞争）
- [x] **Gap backfill**：`eth_getHeaderByNumber` 批量补缺口（封顶 500）
- [x] **Heartbeat 兜底**：5s `eth_blockNumber` 安全网（补任意缺口）+ WS 静默>10s 强制重连（指数退避）
- [x] blocktime 用 `milliTimestamp`（mixHash 解析）差值；异常阈值 450/900/2000ms（slow/missed）
- [x] config 增加 `BSC_WS_URL`（依赖：节点开 `--ws --ws.api eth,parlia`）
- [x] **验收（离线）**：`backend/test-seqguard.mjs` 全绿 —— 去重/补块/reorg(depth2)/450ms精度/slow标记/版本解析
- [ ] **验收（live，待你的环境）**：设 `BSC_WS_URL` 跑 `node test-phase0.mjs`，连续零漏块、blocktime ~450ms（本沙箱无外网，跑不了）

### Phase 1 — 数据贯通 🟠 ✅✅ 已完成 + LIVE 主网验证通过
后端各数据源接真实，替换前端 mock。**用真实 keter token + publicnode 跑通了全链路。**
- [x] **审计 ChainContracts**：地址/ABI 对照 getchainstatus.js 一致；修 `BigInt(10**18)`→`10n**18n`。live 验证：45 validators、1 个被 slash（Blockrazor count=12，阈值 333/1000）
- [x] **修正 keter API 端点**：推断的 `/api/ds/query` 错误 → 真实是 **`/api/grafana/datasources/query`**（basePath `/api` + swagger 发现）。auth/body 格式正确
- [x] **修正 3 个错误 metric 名**（草稿全是猜的）：gas `chain_block_insert_gasused`→**`chain_insert_gasused`**；latency 改为 **`chain_delay_block_insert`**（块插入延迟 ms，histogram 那个 metric 不存在）；diskAlerts 字段 `usagePct`→`usedPct`
- [x] **live keter 验证**：nodeStats 39 节点、latency 121 点(~90ms)、disk 110 行，全真实
- [x] **持续轮询（所有面板不断更新到最新高度）**：useMonitor 快档 2.5s（/api/blocks→ring/river、/api/window、/api/mev）+ 慢档 25s（slash/latency/nodes/gas/disk）；WS 仅作 best-effort 实时块追加。新增 `/api/blocks` endpoint。connected 状态由轮询成功反映。**原因：WS 在代理/部署环境常不通，只靠 WS 会停在初始数据不更新** —— 轮询是兜底主力。`ws.js` 同源 `/ws`。验证：块高 4 秒内推进 ✓
- [x] **全后端 live 验证**：`node src/server.js` 起，`/health` 块高实时、`/api/window` blockTime 450ms connected、`/api/latency` 90ms、`/api/slash` 45 validators —— 全真实主网数据
- [x] **Phase 0 WS live 验证**（顺带）：`test-phase0.mjs` 连 publicnode WSS，57 连续块零丢、每块 450ms、parlia_getTurnLength=8
- [x] **MEV 打通**（eth_getBlockMevInfo 主网未上线，用老启发式）：streamer `_getMevInfo` 加 fallback —— `getBlock(num,true)` 取尾部 tx 查 builderMap；BUILDER_MAP 从 getchainstatus 同步到 59 条。live 验证：每块检出 builder(blockrazor/puissant/blockroute…)，~100% MEV。streamer 即持续 MEV 采集器。⚠ 每块多 1 次 getBlock(full)，长跑建议稳定/自有节点
- 前端 mock 开关：`frontend/.env.development` 的 `VITE_MOCK`（1=demo数据，0=真实需后端在跑）

### Phase 2 — Validator Ring 真实化 🟠
- [ ] `parlia_getValidators` 取活跃集合（替换硬编码 ACTIVE_SET）
- [ ] `parlia_getTurnLength` 取 turnLength（当前 8，动态读，不要写死）
- [ ] **turnLength 模型**：proposer 停留一个 turn（现 8 块 ~3.6s），中心显示 `block N/8`，turn 结束才甩光束到下一节点
- [ ] proposer 由 `latestBlock.miner` 驱动，匹配 validators.js 查表
- **验收**：ring 出块节奏与链上一致，proposer 连续出块不每块跳

### Phase 2B — IA 重构（进场 → 子系统）🟠 ✅ 完成
- [x] Home = Validator Ring（hero，45 真实 validator）+ Version 节点版本分布 + 全局 KPI
- [x] 子系统入口卡片（Monitor / MEV / 流量 / 异常 / 存储 / Issues / 告警 共7个）+ 8 项 NavRail，点击进入各自视图
- [x] NavRail 改造为新导航（Home + 7 子系统）；Monitor 大盘变成子系统之一（Gas/Latency/Stability/BlockRiver）
- [x] MEV 抽出独立子系统（builder 分布按系列聚合 + MEV%/v2% 真实数据）；"稳定性"→"异常分析"（慢块/漏槽/reorg/slash 时间线 + 双栏）
- [x] 各子系统「⚡ AI 分析」+「🔬 Codex 深挖」按钮占位（灰，标 v1.1/v1.2）
- [x] **验收**：进场见 Ring + version + 7 入口；DOM 验证 8 导航项 + 7 卡 + 各页渲染无报错；导航切换正常
- 新文件：HomePage/MonitorPage/MevPage/TrafficPage/AnomalyPage/IssuesPage + VersionPanel/AiButton；TxPool 折入流量分析（深度查询 Phase 4）

### UI 大改（2026-06-30 用户反馈批）🟠 大部分完成
- [x] validator 分组 7→4：InfStones/Tranchess 并入 Independent（internal/48club/legend/independent）
- [x] 品牌 BSC Monitor → **BNB Chain Ops** + BNB 钻石 logo + topbar 黑金渐变/底边
- [x] 首页重做：4 状态条（链健康/异常块/Missed-Reorg/Slash）+ 版本风险面板（最新占比/落后数/最老版本/可展开节点）+ Slash 卡 + 一键大流量入口；**去掉与左侧 NavRail 重复的入口卡**，填满 Ring 旁空白
- [x] Gas 改为 2 个典型 IP（10.213.32.160/78）平均（GAS_SAMPLE_IPS 可配），不再画所有 validator
- [x] **Latency 改造**：聚合 p50/p95/p99 + 24h 基线对比。**24h 基线用 app 自采样缓存**（LatencyStore 每 30s 采一点，落盘 backend/data/latency-24h.json，重启不丢，不压 keter avg_over_time 查询）。LatencyPanel 重写显示 3 分位线 + 基线虚线 + 对比文字
- [x] Monitor 撤掉 Stability 面板（改 Gas|Latency+BlockRiver）；disk 高水位(≥85%)并入 Home 链健康，磁盘明细留「告警」页
- [x] 品牌按官方 bnbchain.org 调：`BNB CHAIN`(金/白) + `OPS` 徽章 + `● MAINNET` 绿点 pill
- [ ] 黑金科技感继续打磨

### Phase 3 — 面板按 0.45s 校准 + 流量分析做实 🟡 ← 部署前最后一步
- [ ] 统计窗口从"200 块"改为**时间窗口**（如 5 min ≈ 660 块）
- [ ] BlockRiver 做**时间桶聚合**（每柱代表 N 块/固定时间），避免 2.2 块/秒刷屏
- [ ] Gas/Latency/Stability 面板在新布局比例下重新校准（修 Gas 面板被压扁）
- [ ] **流量分析做实**（v1 重心）：Gas 趋势 + 流量分区(LOW/MED/HIGH/SAT) + 大流量时段标注 + 高 gas 块列表（纯链上）
- **验收**：面板稳定不抖动、BlockRiver 可读、流量页信息充实

### Phase 5 — 部署 🟢 ✅ 本地单进程部署已跑通（current state）
- [x] **本地单进程部署**（不用 docker）：后端用 `@fastify/static` 同时托管前端 dist + API + WS，同源同端口（:8080）。`start.sh` 一键：build 前端 + 起后端
- [x] 用 nodereal AP key（`bsc-mainnet-ap.nodereal.io` HTTP+WSS，有配额+WSS）。**WSS newHeads 连上 connected:true**（比 publicnode 稳）
- [x] **验收**：http://localhost:8080 打开 → 真实数据（BLOCK #107.26M、0.45s、MEV 100%、6 子系统、Ring 45 validator）
- [ ] 后续：Phase 2/3 完成后 rebuild；如需开给同事，内网服务器跑 start.sh + 局域网 IP（鉴权 v2.0）
- ~~docker-compose~~（用户选本地不用 docker）

### Phase 4 — 子工具后端（部署之后再补）🟡
- [ ] Storage 查询后端 endpoint（节点磁盘用量/目录大小）
- [ ] TxPool 查询后端 endpoint（`txpool_status`/`content`，指定地址 pending）
- [ ] Alerts 规则聚合完善（slash + 慢块 + 磁盘，去重分级，ACK）

---

## 4. 依赖与风险

| 依赖 | 说明 | 谁提供 |
|------|------|--------|
| BSC 节点 **WSS endpoint** | newHeads 订阅必需，节点需开 ws（`BSC_WS_URL`） | ops / 你 |
| `~/.keter.json` token | Prometheus 指标采集 | 你 |
| BSC RPC（含 parlia_*） | 链上数据 | 已有 public，最好用内网 |
| **本地 BSC 源码路径** | Codex 深挖读码（v1.2），`BSC_SOURCE_PATH`，可选 `BSC_SOURCE_AUTO_PULL` 定期 git pull 保持最新，不联网抓 | ops |
| **bnbchain-mcp**（v1.1） | AI 链上查询工具，后端起为 MCP server（stdio/SSE）。**只读：不设 PRIVATE_KEY** | 接入时配 |
| 云端 AI API key（v1.1） | CloudProvider 推理 | 你 |

**最大风险**：Phase 0 的 WS 稳定性（断线/假死/reorg 边界）。这是地基，先打磨到位再往上盖。

---

## 5. 当前进度快照（更新 2026-06-30）

| Phase | 内容 | 状态 |
|-------|------|------|
| Phase 0 | 采集层 WS 重写（newHeads + SeqGuard + 兜底） | ✅ 完成 + live 验证（publicnode，57块零丢/450ms） |
| Phase 1 | 数据贯通（keter/合约/MEV 接真实，去 mock） | ✅ 完成 + live 验证（keter端点+metric修正、45 validators、MEV打通） |
| Phase 2B | IA 重构（Home=Ring+Version → 7 子系统导航） | ✅ 完成 |
| + MEV | mev.log 接成 MEV 子系统数据源（MevLogReader） | ✅ 完成 + live |
| **Phase 2** | **Ring turnLength=8 出块模型 + 接 parlia 动态集合** | ⏳ **未做**（数据是45真实，但动画仍每块换proposer，没按8块/turn停留） |
| **Phase 3** | **面板按 0.45s 校准**（时间窗口、BlockRiver时间桶聚合、修Gas面板） | ⏳ 未做 |
| **Phase 4** | **子工具后端**（Storage/TxPool 查询 endpoint、告警聚合完善） | ⏳ 未做 |
| **Phase 5** | **部署**（docker-compose 一键起、内网开 URL） | ⏳ 配置已写，未实际部署 |

**v1.0 已完成大头**（采集/数据/IA/MEV/持续轮询 都通真实主网）。**到部署剩 3 步**：Phase 2（Ring 出块模型）→ Phase 3（0.45s 校准 + 流量做实）→ Phase 5（部署）。Phase 4（子工具后端）部署后补。**异常分析子系统已砍**（slash 需日志，只在大盘展示），子系统从 7 收敛到 6，分析重心 = 流量。

离线测试：`backend/test-seqguard.mjs`、`test-keter-shape.mjs`、`test-phase0.mjs`(live WS)、`test-connectivity.mjs`(keter)。
