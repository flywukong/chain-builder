import path from "path";

export function loadConfig() {
  return {
    port:            parseInt(process.env.PORT ?? "3001"),
    // 无 key 的公共节点作兜底(限流,仅保证可启动);生产用 .env 里的带 key / 内网 fullnode 覆盖
    rpcUrl:          process.env.BSC_RPC_URL ?? "https://bsc-dataseed.bnbchain.org",
    // WebSocket endpoint for newHeads subscription (Phase 0 realtime layer). Node must run --ws --ws.api eth,parlia.
    wsUrl:           process.env.BSC_WS_URL ?? null,
    keterConfigPath: process.env.KETER_CONFIG_FILE ?? path.join(process.env.HOME, ".keter.json"),
    bscscanKey:      process.env.BSCSCAN_API_KEY ?? null,   // 可选:未知合约取 verified 名称/proxy(getsourcecode)
    corsOrigin:      process.env.CORS_ORIGIN ?? "http://localhost:3000",
    // MEV collector log (getchainstatus, continuously appended) — tailed for MEV subsystem data.
    mevLogPath:      process.env.MEV_LOG_FILE ?? path.join(process.env.HOME, "work/opbnb/bsc/cmd/jsutils/mev.log"),

    // Local bnb-chain/bsc source checkout for Codex deep-dive (T2). Read locally, no per-request web fetch.
    bscSource: {
      path:         process.env.BSC_SOURCE_PATH ?? null,           // required for Codex deep-dive; e.g. /opt/bsc
      repoUrl:      process.env.BSC_SOURCE_REPO ?? "https://github.com/bnb-chain/bsc.git",
      autoPull:     process.env.BSC_SOURCE_AUTO_PULL === "true",   // periodic git pull to keep latest
      pullInterval: parseInt(process.env.BSC_SOURCE_PULL_INTERVAL ?? "3600") * 1000, // seconds → ms
    },
  };
}
