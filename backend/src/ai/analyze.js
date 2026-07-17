/**
 * AI analysis backend — 可切换的 4 种运行时,由 AI_BACKEND 选择:
 *   auto(默认)  → 有 ANTHROPIC_API_KEY 走 claude-api,否则 claude-cli
 *   claude-cli   → 本地已登录的 Claude Code CLI `claude -p`(开发机)
 *   claude-api   → 官方 @anthropic-ai/sdk(服务器,需 ANTHROPIC_API_KEY)
 *   codex-cli    → 本地已登录的 Codex CLI `codex exec`(对比用,免 key)
 *   codex-api    → OpenAI 兼容 API,Node raw fetch(需 OPENAI_API_KEY + OPENAI_MODEL)
 *   codex-py     → OpenAI Python SDK(responses.create),Node 调 Python 脚本
 *                  服务器 Node/glibc 有问题时用它,依赖只在 Python venv 里
 * Prompts carry explicit normal-range baselines so the model reports genuine
 * anomalies only — it must NOT manufacture "risks" out of in-range fluctuation.
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";
import os from "os";
import Anthropic from "@anthropic-ai/sdk";

const BACKEND    = (process.env.AI_BACKEND || "auto").toLowerCase();
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const API_KEY    = process.env.ANTHROPIC_API_KEY || null;
const MODEL      = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";  // 可用 haiku/sonnet 降本
const CODEX_BIN   = process.env.CODEX_BIN || "codex";
const CODEX_MODEL = process.env.CODEX_MODEL || null;                  // 不设则用 codex 默认模型
const OPENAI_KEY   = process.env.OPENAI_API_KEY || null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
const OPENAI_BASE  = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const PYTHON_BIN   = process.env.PYTHON_BIN || "python3";           // 服务器指到 venv:~/openai-venv/bin/python
const OPENAI_PY    = fileURLToPath(new URL("./openai_client.py", import.meta.url));
const TIMEOUT_MS = 180_000;

let _client = null;
const anthropic = () => (_client ??= new Anthropic());   // reads ANTHROPIC_API_KEY from env

function resolveBackend() {
  if (BACKEND !== "auto") return BACKEND;
  return API_KEY ? "claude-api" : "claude-cli";
}

// CLI 的默认模型:/model 保存默认时写入 ~/.claude/settings.json 的 model 字段
function cliSettingsModel() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8"));
    return j.model ? `${j.model}(读自 CLI settings.json)` : null;
  } catch { return null; }
}

// 启动日志用:当前 AI 后端 + 模型选择的一句话描述
export function aiInfo() {
  const backend = resolveBackend();
  switch (backend) {
    case "claude-api": return `claude-api · model=${MODEL}`;
    case "claude-cli": return `claude-cli · model=${process.env.CLAUDE_CLI_MODEL || cliSettingsModel() || "(CLI 账号默认,settings.json 未设 model)"} · 额度回退=${CLI_FALLBACK_MODEL}`;
    case "codex-cli":  return `codex-cli · model=${CODEX_MODEL || "(codex 默认)"}`;
    case "codex-api":  return `codex-api · model=${OPENAI_MODEL}`;
    case "codex-py":   return `codex-py · model=${OPENAI_MODEL}`;
    default:           return backend;
  }
}

function buildPrompt(data) {
  return [
    `你是 BNB Chain (BSC) 主网的资深运维分析师。根据下面最近 ${data.windowDays ?? 7} 天的监控数据(部分细粒度指标为 24h,见字段名),用中文输出一份简洁的网络健康分析(markdown,200 字以内)。`,
    "",
    "判断基线（处于范围内即为正常，不要当成风险或“需关注”项）：",
    "- 出块间隔 ~450ms 是协议常量。导入时延不在本巡检范围(个别节点差异由监控子系统分析),数据里没有时延字段就完全不要提时延;仅当出现 latencyAlert 字段(大面积链级异常)才报告",
    "- fast finality 下日均 0~3 次深度 1-2 块的 micro-reorg 属正常",
    "- MEV 占比 90%~100% 是主网常态（builder 市场成熟），不是风险",
    "- 大流量复合口径:dataseed pending >4000 或 区块 gas 利用率 ≥90%,任一触发;二者均低即流量正常",
    "- Slash:BSC 协议有内建惩罚机制(计数达阈值自动 jail、移出活跃集),无需人工干预。事件按 internal 字段区分:internal=false(外部 validator)只陈述事实(validator、笔数、时间模式),是其运营方自身问题,禁止输出「核实是否移出活跃集/确认 slash 类型/联系运营方/持续监控防扩散」这类操作建议;仅 internal=true(我方内部运营)被 slash 时才建议排查节点",
    "",
    "要求(前端有结构化指标区展示安全性/出块/负载各数值,你的输出只负责「结论」与「异常评述」,不要复述指标清单):",
    "1. 第一行输出结论播报,固定以 [播报] 开头、一行写完:第一句必须是明确结论(如「主网运行正常,当前无需处理」),之后至多再加 1 句最有信息量的水位或事件。禁止罗列指标、禁止报协议常量(出块间隔 450ms 等)。口吻平实,不用 markdown,60 字以内。无论正常与否这一行都必须有。",
    "2. 第二行起为正文。正文首行总体结论:正常 / 需关注 / 告警(三选一)。",
    "3. 正文只写异常/事件评述,每条带具体日期(如 7/8);一切正常时正文只写一句「各项指标均在正常范围内」即可,禁止逐项报平安、禁止为凑内容制造风险点。播报行已说过的事件,正文不得重述结论,只补充增量细节(精确时间/区块高度/涉及方/间隔),同一事实全文只出现一次。",
    "4. 表述纪律:①单位明确——交易写「N 万笔交易」,区块写「N 个块」,不得混用;②MEV 表述用「MEV Builder 出块中,v1 占比 X%」这类精确说法,不要写「全部由 v1 出块」再并列本地出块数造成矛盾;③对比性形容(优于/低于基线)必须附具体比较值(如「较 7 日基线快 12%」),否则不写;④用值班口语:流量事件说「短时冲高/流量高峰,已回落」,禁止「脉冲/突刺/毛刺」这类信号学词汇;⑤事件时间一律写具体时刻(如 7/15 23:41)并带区块高度(数据里有 t/block 字段就用),禁止「深夜/凌晨/傍晚」这类模糊时段词。",
    "5. 数值按数据原样精度引用(mevPct=99.9 就写 99.9%),禁止四舍五入成 100%/0% 这类绝对值——页面各处显示一位小数,凑整会与页面矛盾。",
    "6. 直接输出正文,不要开场白、结尾语或水平分隔线。",
    "",
    "监控数据（JSON）：",
    "```json",
    JSON.stringify(data, null, 2),
    "```",
  ].join("\n");
}

export async function runAnalysis(data) {
  return spawnClaude(buildPrompt(data));
}

// ── 大流量事件分析(归因到合约)──
export async function runTrafficAnalysis(data) {
  const prompt = [
    "你是 BSC 主网的资深运维分析师。分析下面这次大流量事件(复合口径:dataseed 平均 pending > 4000 或 区块 gas 利用率 ≥ 90% 任一触发;事件 trigger 字段标注触发原因),用中文输出 markdown,250 字以内,直接正文。",
    "若 lastEpisode 为 null,直接说明窗口内无大流量,给出 pending 基线与 gas 峰值作参考,不要硬造事件。",
    "",
    "已提供事件时间线(北京时间)、30 天基线,以及事件峰值时段链上采样(若有):sampledBlocks 为采样区块,topContracts 按交易 gasLimit 份额聚合。",
    "事件的 refined 字段(若有)是 5m 精化结果:startT/peakT/endT 为精确时间,startBlock~endBlock 为事件区块高度区间——结论里引用该区间,方便读者链上取证。",
    MCP_GUIDE,
    "本场景取证建议:topContracts 里未识别的高份额地址,用 read_contract(name/symbol)或 get_erc20_token_info 识别实体;可疑发送方用 get_native_balance / get_transaction 抽查 1-2 个,余额仅够 gas + nonce 密集 = 脚本集群。",
    "",
    "要求:",
    "1. 概述事件:时间、持续、峰值 pending 与基线的倍数、区块 gas 是否被打满。",
    "2. 归因:根据 topContracts 判断流量由什么合约/交易类型引起。你认识的知名 BSC 合约(如 PancakeSwap Router、四字节铭文类、known token)直接标注;不认识的地址优先用链上工具识别,识别不出再写「未知合约 0x…前8位」,禁止编造名字。",
    "3. 影响与结论:pending 消化情况、是否需要关注。",
    "4. 若无链上采样数据,基于时间线分析并说明归因需 tx 级数据。",
    "",
    "数据(JSON):",
    "```json", JSON.stringify(data, null, 2), "```",
  ].join("\n");
  return spawnClaude(prompt, { mcp: true });
}

// ── 流量窗口解读:pending / gas 单维度形态分析(窗口跟随前端选择)──
// gas focus 额外做「打满深挖」:高峰时段未打满块的交易特征与归因(bundle/builder 窗口性能)
export async function runTrafficTrendAnalysis(data) {
  const dim = data.focus === "gas" ? "区块 gas 利用率" : "TxPool pending";
  const gasDeep = data.focus === "gas" ? [
    MCP_GUIDE,
    `打满深挖(重点):若窗口内有高占用事件或 ≥${data.hotPct ?? 90}% 的小时,对峰值时段做链上抽查——①用 bscops 的 get_block_miners 拉事件区块区间(episodes 里有 startBlock/endBlock)的序列,看 gasUsedM 分布:有多少块接近打满(≥${Math.round((data.gasLimitM ?? 55) * 0.9)}M)、多少块明明高负载却只有 55~70% 利用率;②对 1-2 个未打满的高负载块,用 bnbchain 的 get_block_by_number 取 transactionHashes,抽查 2-3 笔 get_transaction 看特征:同一 to 合约 + 同一 methodId 占块内 gas 大头、from 分散但每个只发 1-2 笔、gasPrice 低(如 0.1 gwei)——这是 builder bundle 批处理特征;③归因口径:出现该特征时,未打满的原因是 builder 在 450ms 出块窗口内的打包性能(优先处理 bundle 后提前 finalize,后续更高 gasUsed 的 bid 来不及被接受),不是需求不足;无该特征则按真实需求解读。本场景工具调用可放宽至 ≤12 次,优先批量工具。`,
  ] : [];
  const prompt = [
    `你是 BSC 主网的资深运维分析师。解读近 ${data.windowLabel} 的 ${dim} 形态,中文 markdown,220 字以内,直接正文。`,
    "",
    data.focus === "gas"
      ? `数据口径:windowStats 是所选窗口的小时均值统计(单位 %,按当前链上上限 ${data.gasLimitM ?? 55}M 折算);hoursOver = 利用率≥${data.hotPct ?? 90}% 的小时数;episodes 是窗口内的高占用事件(含 5m 精化时间与区块区间)。`
      : `数据口径:windowStats 是所选窗口的小时均值统计(单位 笔);hoursOver = pending>${data.threshold ?? 4000} 的小时数;episodes 是窗口内的拥堵事件(含 5m 精化时间与区块区间);baseline30d 是 30 天基线。`,
    ...gasDeep,
    "输出结构:①首行结论(正常/需关注 + 窗口水位一句话);②事件/打满情况:逐事件一行(日期时间/峰值/块区间/已回落);gas focus 时给出打满结论(打满 vs 未打满的块占比与未打满归因);③建议一句。用值班口语,不用「脉冲/突刺」。",
    "",
    "数据(JSON):",
    "```json", JSON.stringify(data, null, 2), "```",
  ].join("\n");
  return spawnClaude(prompt, { mcp: data.focus === "gas" });
}

// ── TxPool 拥堵诊断 ──
export async function runTxpoolAnalysis(data) {
  const prompt = [
    "你是 BSC 主网的资深运维分析师。诊断当前 TxPool 是否异常拥堵,用中文输出 markdown,200 字以内,直接正文。",
    "",
    `判断基线:dataseed 平均 pending 中位数见 baseline;大流量复合口径 = pending>4000 或 gas 利用率≥90%,任一触发;单节点 max 恒高(~25k)是已知卡死节点,忽略。区块 gas 上限 ${data.gasLimitM ?? 55}M(链上实时值),利用率一律按 gasUsed/上限折算,不要沿用旧的 140M 口径。`,
    "拥堵类型判别:pending 高 + 区块 gas 打满 → 需求型(链在满负荷消化);pending 高 + 区块不满 → 传播/定价异常,更值得警惕。",
    "",
    "要求:首行给结论(正常 / 轻度积压 / 异常拥堵);对比当前值与 24h 形态、30d 基线;判断类型;正常就说「TxPool 状态正常」,不要制造风险。",
    "",
    "数据(JSON):",
    "```json", JSON.stringify(data, null, 2), "```",
  ].join("\n");
  return spawnClaude(prompt);
}

// ── MEV 格局分析:builder 集中度 / v1v2 路径 / local & unknown ──
export async function runMevAnalysis(data) {
  const prompt = [
    "你是 BSC 主网的 MEV 格局分析师。基于滚动窗口的实时出块数据分析 builder 格局,中文 markdown,250 字以内,直接正文。",
    "",
    "注意:窗口约 2000 块(≈15 分钟),只代表当前时段,不要外推为长期趋势。",
    "",
    "要求:",
    "1. 集中度:各 builder 家族份额、top2 合计占比,判断是否双寡头/单一依赖(单家 >70% 才算依赖风险)。",
    "2. v1/v2 路径:v2 bidblock(BEP-675)当前 0% 属预期(SendBidBlock 待 Pasteur 硬分叉后经 RPC 启用),不是异常。",
    "3. local(非 MEV)块 = validator 本地打包;unknown = 未识别 builder 地址,数量偏高时建议补 BUILDER_MAP。",
    "4. topBuilderInstances 是家族内实例粒度(如 blockrazor virginia/nyc),可指出主力实例。",
    "5. 格局正常就说稳定,不要制造风险点。",
    "",
    "数据(JSON):",
    "```json", JSON.stringify(data, null, 2), "```",
  ].join("\n");
  return spawnClaude(prompt);
}

// ── Block Gas 执行负载解读 ──
export async function runBlockGasAnalysis(data) {
  const prompt = [
    `你是 BSC 主网运维分析师。解读执行负载(近 ${data.windowLabel ?? "30 分钟"}),中文,160 字以内,直接正文。`,
    `数据口径:mgasPerSec/gasPerBlockM/txsPerBlock 是图表采样的 2 台典型 validator 均值(所选窗口 ${data.windowLabel ?? "30 分钟"});allNodes 是 keter 全部自营节点的 per-instance 统计(mgasps=MGas/s,gasusedM=每块 M gas,固定 30m/24h 快照),覆盖 dex-prod 与 vaas-prod。`,
    `基线:区块 gas 上限 ${data.gasLimitM ?? 55}M(链上实时值,勿用旧 140M 口径);块 gas 8~25M、MGas/s 200~600、执行耗时 <25% slot(450ms)均属常态,范围内不要当风险。`,
    "输出固定三段,每段一行、以段名开头(渲染在窄栏,务必简短):",
    "结论:一句话水位判断(如「Gas 使用平稳,距上限充足」)。",
    "关键点:2-3 个数字(均值/峰值/异常点/全节点一致性,显著低于同伴 30%+ 的节点点名 IP)。",
    "建议:一句(需要关注什么;无事写「无需动作」)。",
    "纪律:短时冲高给出时间与幅度,不用「脉冲/突刺」这类词;正常不凑内容。",
    "",
    "数据(JSON):",
    "```json", JSON.stringify(data, null, 2), "```",
  ].join("\n");
  return spawnClaude(prompt);
}

// ── 区块导入时延解读:节点差异 + 超阈段 ──
export async function runLatencyAnalysis(data) {
  const prompt = [
    `你是 BSC 主网运维分析师。解读自营 validator 节点的区块导入时延(近 ${data.windowLabel ?? "24h"}),中文,180 字以内,直接正文。`,
    "数据口径:chartNodes 是图表采样的 4 台典型(统计窗口 = 所选窗口,q0.5);stagesTypical 是导入的阶段分解(insert 总延迟 = validation 校验 + execution EVM 执行 + commit 状态写入 + 其他,单位 ms;execution 通常是大头 ~30ms,validation/commit 亚毫秒);perNodeStages 是全部 validator 各阶段均值,按 insert 降序 —— 横向找异常以它为准。",
    "基线:insert 均值 <200ms 正常;>450ms(一个出块间隔)为超阈。",
    data.focusEpisode
      ? "重点:focusEpisode 是用户点选的超阈段,优先归因这一段(时间/时长/峰值/前后水位),其余简述;孤立尖峰(<1min)多为磁盘/GC 抖动,持续段才需关注。"
      : [
          "输出固定三段,每段一行、以段名开头(渲染在窄栏,务必简短):",
          "结论:一句话水位判断。",
          "关键点:2-3 个数字(insert 均值/峰值 + 阶段构成;perNodeStages 里某节点某阶段显著高于群体的必须点名「IP + 阶段 + 数值」,如 commit 明显偏高多为磁盘,execution 偏高多为 CPU/负载)。",
          "建议:一句(异常节点查什么;无事写「无需动作」)。",
        ].join("\n"),
    "",
    "数据(JSON):",
    "```json", JSON.stringify(data, null, 2), "```",
  ].join("\n");
  return spawnClaude(prompt);
}

// ── Greedy merge 命中率解读:bid 中标后触发链上 greedy merge 的比例 ──
export async function runGreedyMergeAnalysis(data) {
  const prompt = [
    `你是 BSC 主网 MEV 运维分析师。解读自营 validator 节点的 greedy merge 命中率(近 ${data.hours}h),中文,160 字以内,直接正文。`,
    "指标含义:命中率 = bid_greedyMerge_onchain / worker_bidWin × 100,即中标 bid 中触发「贪婪合并(把本地 mempool 交易并入 builder bid 再出块)」并成功上链的比例。比例越高说明 validator 越多地在 builder bid 基础上追加本地交易增收。",
    "数据口径:chartNodes 是图表采样的典型节点(所选窗口均值/峰值/低值);allNodes 是全部自营 validator 的均值,按降序 —— 横向对比以它为准。",
    "要点:①整体水位:典型节点均值与全网 validator 的档位(命中率无绝对好坏,重点看一致性与异常);②节点差异:命中率显著低于群体的节点点名(IP),可能是本地打包策略或 mempool 差异,建议关注;明显高的也点出;③水位平稳就说稳。不猜没有数据支撑的根因(这是 validator 内部行为,链上只能看结果)。",
    "",
    "数据(JSON):",
    "```json", JSON.stringify(data, null, 2), "```",
  ].join("\n");
  return spawnClaude(prompt);
}

// ── Reorg 解读:无节点日志,不做根因;判涉及方(自营/外部)+ 严重度 + 总结 ──
export async function runReorgAnalysis(data) {
  const prompt = [
    `你是 BSC 主网的资深运维分析师。基于下面的 reorg 监控数据解读近 ${data.windowDays ?? 14} 天窗口,中文 markdown,180 字以内,直接正文。`,
    "",
    "数据口径:keterWindow.days/events 已按所选窗口截取,以它们为准;summary 是 14d 全窗口背景值,窗口小于 14 天时不要直接引用 summary 的次数。observed24h 是本机 24h 观测(单视角)。",
    "重要:手头没有节点日志,禁止推测底层根因(网络分区/时钟/代码 bug 等一律不猜)。只做三件事:",
    "1. 严重程度:对照基线(fast finality 下日均 0~3 次、深度 1-2 的 micro-reorg 属正常),按频率与深度给出 正常/需关注/告警。",
    "2. 涉及方:displacedValidators 是被重组掉的出块方(嫌疑方),canonicalWinner 是重组后的胜者。区分我方自营(internal=true)与外部 validator:自营节点若反复被重组,明确点名并建议排查该节点(出块时延/网络连通);外部节点只陈述事实,不给对方运营建议。displacedValidators 为空的事件是早期数据未记 miner,只按高度/深度评估。",
    "3. 末行一句话总结:是否需要行动。",
    "",
    "数据(JSON):",
    "```json", JSON.stringify(data, null, 2), "```",
  ].join("\n");
  return spawnClaude(prompt);
}

// ── 节点同步解读:head 增长分布 + 异常历史 ──
export async function runSyncAnalysis(data) {
  const prompt = [
    `你是 BSC 主网运维分析师。解读自营节点的同步状态(近 ${data.windowLabel ?? "24h"}),中文,150 字以内,直接正文。`,
    `数据口径:每节点 ${data.windowMin}min 链头增长(预期 ~${data.expected} 块,<${data.threshold} 判异常);behindNow 是当前落后节点;historyAnomalyNodes 是近 ${data.windowLabel ?? "24h"} 异常节点数的采样序列;diskAlerts 是磁盘告警(同步慢的常见诱因)。`,
    "要点:①当前:全部正常就一句话说正常;有落后节点则点名(IP)并看落后程度(接近 0 = 卡死,略低于阈值 = 追赶中);②孤立 vs 集群:单节点多为本机问题(磁盘/重启),多节点同时落后指向网络/上游;③历史:有异常时段给出时间;④磁盘告警与落后节点重合的明确指出。不猜没有数据支撑的根因。",
    "",
    "数据(JSON):",
    "```json", JSON.stringify(data, null, 2), "```",
  ].join("\n");
  return spawnClaude(prompt);
}

// ── 单次 reorg 事件归因:5m 定位 + canonical miner 序列取证 ──
export async function runReorgEventAnalysis(data) {
  const prompt = [
    "你是 BSC 主网的共识运维分析师。归因下面这一次链级 reorg 事件,中文 markdown,200 字以内,直接正文。",
    "",
    "数据口径:event 来自 keter 小时级聚合(count=该小时链级去重次数,orphans=孤块数,nodesSaw=观测到的节点数);refinedMoment 是 5m 粒度定位的发生时刻;canonicalMinerSequence 是事件区块区间内 canonical 链的出块序列采样(等步长,gapMs=与上一采样块的时间差,期望 ≈ sampleStepBlocks×450ms)。",
    "分析方法:被重组段在 canonical 链上不可见,但会留下痕迹——gapMs 显著大于期望值的位置就是重组回退重出的时刻,该位置之后的 miner 是重组赢家;赢家之前正常出块的 validator 里可能有被重组方,但无法从 canonical 链确认,不要断言。",
    "要求:①一句话概述(时间/规模/影响面:nodesSaw 大 = 全网可见,小 = 局部);②从 gapMs 找出异常时刻与赢家 validator(用名称,group=internal 是我方自营,明确标注);找不到明显 gap 就说明采样步长内无法分辨,不要硬凑;③严重度(孤块≥8 或单小时≥2次 值得关注)与是否需要行动。",
    "禁止编造:没有节点日志,不猜底层根因;区块区间 blockRange 在结论里报出,方便读者链上复查。",
    MCP_GUIDE,
    "本场景取证建议:采样序列里 gapMs 异常的位置,用 bscops 的 get_block_miners 一次拉该邻域的逐块序列(step=1,返回自带 validator 名与 gapMs),把 reorg 边界精确到单块,并确认 gap 后首块的赢家 validator。",
    "",
    "数据(JSON):",
    "```json", JSON.stringify(data, null, 2), "```",
  ].join("\n");
  return spawnClaude(prompt, { mcp: true });
}

// ── 空块简析:validator 分布 / 时间聚集性 ──
export async function runEmptyAnalysis(data) {
  const prompt = [
    "你是 BSC 主网运维分析师。分析 24h 内的空块记录(判据:gasUsed<200k,即仅系统交易、validator 未打包用户交易),中文,160 字以内,直接正文。",
    "",
    "输出两段:①**概况**:空块总数、集中在哪些 validator(次数)、时间上连续聚集(节点异常信号)还是分散偶发(mempool 时序波动,属正常),附代表块号与时间;②**排查建议**:点名空块 ≥2 次的 validator,列出其空块块号/时间点,建议运营方核对该时段节点侧日志——出块瞬间 txpool 是否为空、builder bid 是否到达、节点有无重启或性能抖动。",
    "重要口径:监控侧没有 validator 节点日志,无法给出具体根因,禁止断言原因;只给排查名单和方向。偶发 1-2 个孤立空块无需处理,写明即可。",
    "称呼 validator 一律用 validator 字段的名称(如 NodeReal、Fuji),禁止报 0x 地址;internal=true 是我方自营节点,优先点名排查。",
    MCP_GUIDE,
    "本场景取证建议:对空块聚集的 validator,用 bscops 的 get_block_miners 拉其空块附近的连续区间(step=1,gasUsedM<0.2 即空块),看该 validator 的 8 块轮次内是连续空还是夹着正常块(偶发);结论附块号证据。",
    "",
    "数据(JSON):",
    "```json", JSON.stringify(data, null, 2), "```",
  ].join("\n");
  return spawnClaude(prompt, { mcp: true });
}

// ── 未知合约批量归类(交易分析子系统,结果进标签库)──
export async function runContractLabeling(candidates) {
  const prompt = [
    "你是 BSC 主网链上数据分析师。下面是近 24h 交易采样中调用量最高的未识别合约,请逐个归类。",
    "",
    "分类 cat 只能取:meme(meme 币/发射台)| defi(DEX/借贷/质押/聚合器)| predict(预测市场,如 predict.fun/ConditionalTokens/CTF 类)| bot(套利/夹子/keeper/oracle 机器人)| infra(MEV builder/relay 支付结算地址,如 BlockRazor Payment)| bridge | cex | token(普通代币/批量分发)| other(无法判断)。",
    "每个候选带特征:n=调用次数, swapLogs=Swap 事件数, transferLogs=Transfer 事件数, topSelectors=高频方法选择器(可能带反查出的方法签名), addrType=地址形态, codeSize=字节码大小, nonce=发送计数, balanceBNB=余额, verifiedName=BscScan verified 合约名。",
    "地址情报判据(优先级高):verifiedName 存在直接据其定名归类;addrType='EOA' 且 nonce 极高 + 有 BNB 收支 → 支付/结算地址(如 builder payment,归 bnb,不是 bot);addrType='EIP-7702' 被高频调用 → bot(自动化钱包);addrType='contract' + codeSize 小 + 单一 selector 极高频 → bot(keeper/oracle/搬砖合约);codeSize 大 + 多方法 + 高 swapLogs → defi。",
    "判断依据优先级:1) 你认识的知名 BSC 合约地址直接定名;2) topSelectors 里的方法签名语义(updatePrices/fulfill/perform → bot(keeper/oracle);matchOrders/swap/trade/execute → defi;checkIn/claim/airdrop/mint → token(活动分发);deposit/withdraw/stake → defi);3) swapLogs 高 → defi 或 bot(调用方集中/selector 非标准偏 bot,分散偏 defi 聚合器);4) 无事件且单一 selector 极高频 → bot;5) transferLogs 高而无 swap → token;6) vanity 地址(0x0000…/连续重复)偏 bot。",
    "不认识且特征不明的填 other,禁止编造名字;认识的给出名字。",
    "",
    "链上核实(重要):你可以调用只读工具现场查身份 —— read_contract(name()/symbol(),network 一律 \"bsc\")、get_erc20_token_info、is_contract。对 verifiedName 为空且特征不明的候选,按 n 从大到小优先核实(每个地址最多 1 次,总工具调用 ≤15 次):查到 name/symbol 就填进 name 字段(可信度高于推测),并按名字语义修正分类(xxxRouter/Swap → defi,xxxToken/明显 meme 名 → meme/token);查不到或工具失败就按特征判断,不要编。",
    "",
    "只输出 JSON 数组,不要任何其他文字:",
    '[{"addr":"0x…","cat":"defi","name":"PancakeSwap xxx 或 null"}]',
    "",
    "候选合约(JSON):",
    "```json", JSON.stringify(candidates, null, 1), "```",
  ].join("\n");
  const text = await spawnClaude(prompt, { mcp: true, timeoutMs: 420_000 });   // 批量归类 + 链上核实,放宽超时
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("labeling: no JSON array in response");
  return JSON.parse(m[0]);
}

// ── 链上流量特征总结(7 天交易分类数据)──
export async function runTxnFeatureAnalysis(data) {
  const prompt = [
    "你是 BSC 主网链上流量分析师。基于全量区块覆盖(每分钟抓取过去一分钟全部区块)的 7 天交易分类数据,输出中文流量特征总结,markdown,300 字以内,直接正文。",
    "",
    "分类含义:meme=meme币/发射台交易, defi=DEX/借贷, predict=预测市场(predict.fun 等), bot=单块内同发送方≥3笔的高频合约调用+已识别机器人合约, stable=稳定币转账, bnb=纯BNB转账, token=普通代币转账, cex=交易所充提, system=系统交易, other=未识别合约调用。",
    "",
    "要求:",
    "1. 今日流量结构:各类笔数占比(catPct24),结合 catTrend(dYest=较昨日、dAvg7=较7天日均,单位 pp)点出明显变化(±3pp 以上才算);趋势数据为 null 说明历史不足,不要编造。",
    "2. gas 占比视角(catGasPct24):对比笔数占比与 gas 占比的差异 —— 指出哪些类'笔数多但 gas 轻'(如 BNB 转账/稳定币)、哪些'笔数少但吃满执行资源'(如 DeFi swap/复杂合约)。这是链上负载归因的关键。",
    "3. meme / defi / bot 三类重点解读:热度趋势、top 合约里它们是谁。",
    "3. topContracts 中 ai=true 是模型自动归类的,名字可信度一般,表述留有余地。",
    "4. 数据为全量区块统计(2026-07-08 之前的历史时段为每分钟 1 块采样,笔数口径不同,跨该日对比看占比不看绝对量)。",
    "5. 结构稳定就说稳定,不要制造异常。",
    MCP_GUIDE,
    "本场景取证建议(安全初筛):topContracts 里 other/未识别但份额靠前的地址,用 is_contract + read_contract(name/symbol)/ get_erc20_token_info 初筛实体;形似新盘/貔貅/攻击特征(无名合约高频吸量)时在报告里单独提示安全团队关注,并附地址与判断依据。",
    "",
    "数据(JSON):",
    "```json", JSON.stringify(data, null, 1), "```",
  ].join("\n");
  return spawnClaude(prompt, { mcp: true });
}

// ── 自由问答:基于监控快照回答主网运行状态问题 ──
export async function runAsk(question, context) {
  const prompt = [
    "你是「BNB Chain Ops」监控平台的 AI 助手,回答用户关于 BSC 主网运行状态的问题。",
    "下面的快照汇聚了本平台的实时数据:链上状态(WS newHeads)、keter 集群指标、流量/reorg 历史时间线、MEV 格局、TxPool。",
    "历史窗口见 historyWindowDays(若用户问了更长范围,系统已按需拉取对应天数,reorg.daily 为逐日明细)。",
    "",
    "要求:",
    "1. 基于快照回答,引用具体数字;中文,≤250 字,直接正文。",
    "2. 快照覆盖不到、但属于链上具体事实的问题(某块内容/某交易/某地址是否合约/余额/代币信息),用链上工具现场查证后回答;其余覆盖不到的坦率说明,指出可以看哪个子系统(Monitor / MEV / 流量 / 存储)。",
    "3. 不编造数据;正常的指标不要渲染成风险(出块 ~450ms、导入时延 p95≤800ms、MEV 90-100%、24h 0~3 次 micro-reorg 均为常态)。",
    MCP_GUIDE,
    "4. slash 事件由 BSC 协议自动惩罚(jail/移出活跃集),外部 validator(internal=false)被 slash 只陈述事实,不给「联系运营方/核实/持续监控」类建议;仅内部运营(internal=true)才建议排查。",
    "",
    `用户问题:${question}`,
    "",
    "监控快照(JSON):",
    "```json", JSON.stringify(context, null, 2), "```",
  ].join("\n");
  return spawnClaude(prompt, { mcp: true });
}

// ── 全局并发闸门 + 小时配额:多人同时点分析时排队而非无限 spawn ─────────────
// 覆盖所有 AI 入口(面板/问答/巡检/标签库);排队超时给明确错误
const AI_MAX_CONCURRENCY = Math.max(1, parseInt(process.env.AI_MAX_CONCURRENCY, 10) || 3);
const AI_HOURLY_LIMIT = Math.max(10, parseInt(process.env.AI_HOURLY_LIMIT, 10) || 120);
const AI_QUEUE_WAIT_MS = 90_000;
let aiActive = 0;
const aiWaiters = [];
let hourWindow = 0, hourCalls = 0;

function acquireAiSlot() {
  const hw = Math.floor(Date.now() / 3600_000);
  if (hw !== hourWindow) { hourWindow = hw; hourCalls = 0; }
  if (hourCalls >= AI_HOURLY_LIMIT) return Promise.reject(new Error(`AI 调用达到每小时上限(${AI_HOURLY_LIMIT}),请下一小时再试`));
  hourCalls++;
  if (aiActive < AI_MAX_CONCURRENCY) { aiActive++; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const w = { resolve, reject, timer: setTimeout(() => {
      const i = aiWaiters.indexOf(w);
      if (i >= 0) aiWaiters.splice(i, 1);
      reject(new Error("AI 分析排队超时(当前请求较多),请稍后重试"));
    }, AI_QUEUE_WAIT_MS) };
    aiWaiters.push(w);
  });
}
function releaseAiSlot() {
  const w = aiWaiters.shift();
  if (w) { clearTimeout(w.timer); w.resolve(); }   // 名额直接转交队首
  else aiActive = Math.max(0, aiActive - 1);
}
export const aiLoad = () => ({ active: aiActive, queued: aiWaiters.length, hourCalls, hourlyLimit: AI_HOURLY_LIMIT });

// 统一入口:按 AI_BACKEND 分发到 claude/codex × cli/api
// opts.mcp = 允许 AI 调链上只读工具自主取证(仅 claude-cli 后端支持,其余后端静默降级为纯 prompt)
async function spawnClaude(prompt, opts = {}) {
  const mcp = !!opts.mcp;
  const timeoutMs = opts.timeoutMs ?? (mcp ? MCP_TIMEOUT_MS : TIMEOUT_MS);
  await acquireAiSlot();
  try {
    switch (resolveBackend()) {
      case "claude-api": return await runViaApi(prompt, timeoutMs);
      case "codex-cli":  return await runViaCodexCli(prompt, timeoutMs);
      case "codex-api":  return await runViaOpenAI(prompt, timeoutMs);
      case "codex-py":   return await runViaOpenAIPy(prompt, timeoutMs);
      case "claude-cli":
      default:           return await runViaCli(prompt, timeoutMs, mcp);
    }
  } finally {
    releaseAiSlot();
  }
}

// Codex CLI:codex exec --json,解析 JSONL 事件取最终 agent 消息(read-only + tmpdir 保证只答不改仓库)
function runViaCodexCli(prompt, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    // --ignore-user-config:跳过 ~/.codex/config.toml(其 service_tier 等键可能被本版本拒),auth 仍从 CODEX_HOME 读
    const args = ["exec", "--ignore-user-config", "--skip-git-repo-check", "--ephemeral", "-s", "read-only",
      "--color", "never", "-C", os.tmpdir(), "--json"];
    if (CODEX_MODEL) args.push("-m", CODEX_MODEL);
    args.push("-");   // prompt 从 stdin 读
    const child = spawn(CODEX_BIN, args, { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, env: CODEX_ENV() });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => reject(new Error("codex spawn failed: " + e.message)));
    child.on("close", (code) => {
      const { text, error } = parseCodexJsonl(out);
      if (text) return resolve(text);
      const reason = error || err.trim() || `codex exited with code ${code}`;
      console.error("[ai] codex code=%s reason=%s\n-- rawtail --\n%s", code, error, out.slice(-600));
      reject(new Error(reason.slice(0, 800)));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// 容错解析 codex --json 的 JSONL:收集 agent 文本,捕获 error 事件
function parseCodexJsonl(raw) {
  let text = "", error = null;
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s || s[0] !== "{") continue;
    let ev; try { ev = JSON.parse(s); } catch { continue; }
    const t = ev.type || ev.msg?.type || "";
    if (/error/i.test(t) || ev.error) error = ev.message || ev.error?.message || ev.error || JSON.stringify(ev).slice(0, 200);
    // 最终 agent 消息可能出现在多种字段(不同版本 schema)
    const cand = ev.item?.text ?? ev.message?.text ?? ev.msg?.message ?? ev.text ??
      (ev.item?.type === "agent_message" ? ev.item?.text : null) ??
      (typeof ev.message === "string" ? ev.message : null);
    if (typeof cand === "string" && cand.trim()) text = cand.trim();
  }
  return { text, error };
}

// OpenAI 兼容 API(codex-api):raw fetch,无额外依赖
async function runViaOpenAI(prompt, timeoutMs = TIMEOUT_MS) {
  if (!OPENAI_KEY) throw new Error("codex-api 需要 OPENAI_API_KEY");
  if (!OPENAI_MODEL) throw new Error("codex-api 需要 OPENAI_MODEL(如 gpt-5.1 / gpt-5-codex)");
  const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI 返回空内容");
  return text;
}

// OpenAI Python SDK(codex-py):Node 调 Python 脚本走 responses.create,依赖只在 venv 里
function runViaOpenAIPy(prompt, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [OPENAI_PY], { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, env: CODEX_ENV() });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => reject(new Error("python spawn failed: " + e.message)));
    child.on("close", (code) => {
      const text = out.trim();
      if (text && code === 0) return resolve(text);
      console.error("[ai] openai-py code=%s\n%s", code, err.slice(-800));
      reject(new Error((err.trim() || `python exited with code ${code}`).slice(-800)));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function runViaApi(prompt, timeoutMs) {
  const resp = await anthropic().messages.create(
    { model: MODEL, max_tokens: 4096, messages: [{ role: "user", content: prompt }] },
    { timeout: timeoutMs }   // TS SDK timeout 单位是毫秒
  );
  const text = (resp.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) throw new Error("Anthropic API 返回空内容");
  return text;
}

// 主模型额度用尽(如 Fable 5 周额度)时的回退模型
const CLI_FALLBACK_MODEL = process.env.CLAUDE_CLI_FALLBACK_MODEL || "claude-opus-4-8";
const LIMIT_RE = /(usage|weekly|session|5-?hour|monthly)\s*limit|limit (reached|exceeded)|rate.?limit|quota/i;

// ── MCP 自主取证(bnbchain-mcp,仅 claude-cli 后端)──────────────────────────
// 白名单只放链上只读工具(以 tools/list 实测名单为准);transfer/write/approve/
// gnfd 写类永不放行,运行环境绝不配 PRIVATE_KEY。
const MCP_CONFIG_FILE = process.env.MCP_CONFIG_FILE || new URL("../../mcp/bnbchain.json", import.meta.url).pathname;
const MCP_RO_TOOLS = [
  ...[
    "get_block_by_number", "get_block_by_hash", "get_latest_block",
    "get_transaction", "read_contract", "is_contract",
    "get_erc20_token_info", "get_erc20_balance", "get_native_balance",
    "get_chain_info", "get_supported_networks", "estimate_gas",
  ].map((t) => `mcp__bnbchain__${t}`),
  // 自建补充:带 validator 名的出块人查询(bnbchain 的 get_block 不含 miner)
  "mcp__bscops__get_block_miner", "mcp__bscops__get_block_miners",
].join(",");
const MCP_TIMEOUT_MS = 300_000;   // 工具循环比单轮生成慢

// 注入到取证类 prompt 的通用工具指引
export const MCP_GUIDE = [
  "工具:你可以调用链上只读工具核实事实。bnbchain 系列(get_block_by_number / get_transaction / read_contract / is_contract / get_erc20_token_info / get_native_balance 等,network 参数一律 \"bsc\")查块/交易/合约/余额;查「某块是谁出的」用 bscops 系列 —— get_block_miner(单块)/ get_block_miners(区间批量,含 validator 名、gapMs、gasUsedM,一次最多 120 块,范围大用 step 抽样),bnbchain 的 get_block 不返回 miner。",
  "取证纪律:①先用给定上下文,关键疑点才查链,总工具调用 ≤8 次(get_block_miners 批量算 1 次,优先用它);②结论只引用可验证事实(块号/地址/数值);③工具失败或查不到就直说,不要编造。",
].join("\n");

// 子进程 env 白名单:CLI 与其拉起的第三方 MCP npm 包(@bnb-chain/mcp)会继承整份 env,
// 全量透传会把 keter 配置路径 / BSCSCAN / OPENAI 等无关凭据泄给供应链。只给各后端所需变量。
const BASE_ENV_KEYS = ["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM"];
function pickEnv(extra = []) {
  const out = {};
  for (const k of [...BASE_ENV_KEYS, ...extra]) if (process.env[k] != null) out[k] = process.env[k];
  return out;
}
const CLAUDE_ENV = () => pickEnv(["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "CLAUDE_CLI_MODEL", "CLAUDE_CLI_FALLBACK_MODEL", "BSC_RPC_URL"]);   // BSC_RPC_URL 供 bscops 取证
const CODEX_ENV  = () => pickEnv(["OPENAI_API_KEY", "OPENAI_MODEL", "CODEX_MODEL", "CODEX_HOME"]);

function cliOnce(prompt, timeoutMs, model = null, mcp = false) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "text"];   // headless one-shot; prompt via stdin
    if (model) args.push("--model", model);
    if (mcp) args.push("--mcp-config", MCP_CONFIG_FILE, "--allowedTools", MCP_RO_TOOLS);
    const child = spawn(
      CLAUDE_BIN,
      args,
      { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, env: CLAUDE_ENV() }
    );

    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => reject(new Error("claude spawn failed: " + e.message)));
    child.on("close", (code) => {
      const text = out.trim();
      // claude 会把认证/API/额度错误打到 stdout —— 不能当成分析正文
      const looksLikeError = text && text.length < 300 &&
        /(Failed to authenticate|API Error|Invalid API key|credit balance|rate limit|usage limit|limit reached|overloaded)/i.test(text.slice(0, 160));
      if (text && !looksLikeError && code === 0) return resolve(text);
      let reason = looksLikeError ? text : String(err || `claude exited with code ${code}`);
      if (/Failed to authenticate|Invalid API key|OAuth.*expired|401/i.test(reason))
        reason = "AI 引擎未认证:服务器 claude CLI 登录已过期或 .env 未配置 ANTHROPIC_API_KEY,请联系管理员";
      console.error("[ai] claude failed code=%s model=%s\n%s", code, model ?? "(default)", reason);
      reject(new Error(reason.slice(0, 800)));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function runViaCli(prompt, timeoutMs = TIMEOUT_MS, mcp = false) {
  // 主模型:CLAUDE_CLI_MODEL,不设则用 CLI 登录账号默认(如 Fable 5)
  const primary = process.env.CLAUDE_CLI_MODEL || null;
  try {
    return await cliOnce(prompt, timeoutMs, primary, mcp);
  } catch (e) {
    if (LIMIT_RE.test(e.message) && CLI_FALLBACK_MODEL && CLI_FALLBACK_MODEL !== primary) {
      console.warn("[ai] 主模型额度受限,回退 %s 重试", CLI_FALLBACK_MODEL);
      return cliOnce(prompt, timeoutMs, CLI_FALLBACK_MODEL, mcp);
    }
    throw e;
  }
}
