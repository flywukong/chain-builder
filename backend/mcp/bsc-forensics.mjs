#!/usr/bin/env node
// bsc-forensics — 补充取证 MCP server(stdio)
// 背景:bnbchain-mcp 的 get_block 不返回 miner 字段,而 reorg 赢家/空块归因全靠出块人。
// 这里提供带 validator 名解析的单块/批量出块人查询;批量走 JSON-RPC batch,一次调用
// 拉一整段序列,绕开逐块调用的工具次数限制。仅只读,无任何写能力。
// 注意:以相对路径 mcp/bsc-forensics.mjs 被拉起,要求宿主(claude 进程)cwd = backend/。
import { VALIDATORS } from "../../frontend/src/data/validators.js";

const RPC = process.env.BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org";
const MAX_ITEMS = 120;

const vinfo = (addr) => {
  const v = VALIDATORS[(addr || "").toLowerCase()];
  return v ? { validator: v.name, group: v.group, internal: v.group === "internal" }
           : { validator: (addr || "").slice(0, 10), group: "unknown", internal: false };
};

async function rpcBatch(calls) {
  const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params }));
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`RPC ${r.status}`);
  const arr = await r.json();
  return (Array.isArray(arr) ? arr : [arr]).sort((a, b) => a.id - b.id).map((x) => x.result ?? null);
}

const normBlock = (h) => {
  if (!h) return null;
  const ts = Number(BigInt(h.timestamp));
  const ms = ts * 1000 + (h.mixHash ? Number(BigInt(h.mixHash) % 1000n) : 0);
  return {
    number: Number(BigInt(h.number)),
    miner: h.miner,
    ...vinfo(h.miner),
    timestampMs: ms,
    time: new Date(ms).toISOString(),
    gasUsedM: +(Number(BigInt(h.gasUsed)) / 1e6).toFixed(2),
    txCount: Array.isArray(h.transactions) ? h.transactions.length : null,
  };
};

async function getBlockMiners({ fromBlock, toBlock, step = 1 }) {
  const from = Math.trunc(Number(fromBlock)), to = Math.trunc(Number(toBlock)), st = Math.max(1, Math.trunc(Number(step) || 1));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new Error("invalid range");
  const count = Math.floor((to - from) / st) + 1;
  if (count > MAX_ITEMS) throw new Error(`range too large: ${count} blocks (max ${MAX_ITEMS}); increase step`);
  const nums = []; for (let n = from; n <= to; n += st) nums.push(n);
  const raw = await rpcBatch(nums.map((n) => ({ method: "eth_getBlockByNumber", params: ["0x" + n.toString(16), false] })));
  let prev = null;
  return raw.map((h) => {
    const b = normBlock(h);
    if (!b) return null;
    b.gapMs = prev != null ? b.timestampMs - prev : null;   // 与上一返回块的时间差(期望 ≈ step×450ms)
    prev = b.timestampMs;
    return b;
  }).filter(Boolean);
}

const TOOLS = [
  {
    name: "get_block_miner",
    description: "查询 BSC mainnet 单个区块的出块人(miner 地址 + validator 名称/分组/是否内部运营)、毫秒时间戳、gasUsed(M)、交易数。bnbchain 的 get_block 不含 miner,查出块人用这个。",
    inputSchema: { type: "object", properties: { block: { type: "number", description: "区块高度" } }, required: ["block"] },
    run: async ({ block }) => (await getBlockMiners({ fromBlock: block, toBlock: block }))[0],
  },
  {
    name: "get_block_miners",
    description: "批量查询 BSC mainnet 一段区块的出块序列(每块含 miner/validator 名/毫秒时间戳/gapMs/gasUsedM/交易数),单次最多 120 条,范围大时用 step 抽样。适合 reorg 边界定位(gapMs 异常处)、validator 空块连续性核查。",
    inputSchema: {
      type: "object",
      properties: {
        fromBlock: { type: "number" }, toBlock: { type: "number" },
        step: { type: "number", description: "抽样步长,默认 1(逐块)" },
      },
      required: ["fromBlock", "toBlock"],
    },
    run: getBlockMiners,
  },
];

// ── minimal stdio MCP protocol ──
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const replyErr = (id, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n");

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => { if (msg.id != null) replyErr(msg.id, String(e.message || e)); });
  }
});

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "bsc-forensics", version: "1.0.0" },
    });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS.map(({ run, ...t }) => t) });
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return replyErr(id, `unknown tool: ${params?.name}`);
    try {
      const out = await tool.run(params?.arguments ?? {});
      return reply(id, { content: [{ type: "text", text: JSON.stringify(out) }] });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: `工具执行失败: ${e.message}` }], isError: true });
    }
  }
  if (id != null) replyErr(id, `unknown method: ${method}`);
}
