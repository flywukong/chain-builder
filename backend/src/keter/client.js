/**
 * Keter Grafana API client
 * Mirrors keter-api.sh grafana-query over HTTP.
 *
 * Auth: JWT from .keter.json  →  Authorization: Bearer <token>
 * Endpoint: POST https://keter-api.toolsapple.net/api/ds/query
 */

import fs from "fs";
import path from "path";
import http from "node:http";
import https from "node:https";

// keter 端点可用 env 覆盖(内网走 Host 路由时用):
//   KETER_API_BASE=http://nodereal-nonprod.vminsert.internal
//   KETER_HOST_HEADER=keter-api.monitor.internal
const KETER_API_BASE = process.env.KETER_API_BASE || "https://keter-api.toolsapple.net";
const KETER_HOST_HEADER = process.env.KETER_HOST_HEADER || null;

// Datasource registry (from references/datasource-info.md)
export const DATASOURCES = {
  "dex-prod":  "c3039761-b302-4f69-858c-567f01826002",
  "vaas-prod": "d6e2d176-d8ff-4d01-a2f0-87210c2cff1c",
};

// Job groups per datasource (for node_stats queries)
export const DS_JOBS = {
  "dex-prod":  "bsc-fusion-validator|bsc-mev-validator-nvme|dex-prod-bsc-validator|dex-prod-bsc-validator_nvme|gcp-bsc-validator",
  "vaas-prod": "lista_s1_validator",
};

function loadToken(configPath) {
  const file = configPath || process.env.KETER_CONFIG_FILE || path.join(process.env.HOME, ".keter.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const tenant = config.default_tenant || "nodereal";
  return config.tenants[tenant].token;
}

// HTTP(S) POST JSON,支持自定义 Host 头。用 node:http 而非 fetch —— undici 会丢弃
// Host 这个 forbidden 请求头,而内网 keter 正是靠 Host 路由。
function httpPostJson(urlStr, bodyObj, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === "https:" ? https : http;
    const body = JSON.stringify(bodyObj);
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, text: data }));
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("keter request timeout")));
    req.write(body);
    req.end();
  });
}

/**
 * grafanaQuery — mirrors keter-api.sh grafana-query
 *
 * @param {string} datasourceUid
 * @param {string} expr  PromQL expression
 * @param {object} opts  { from, to, instant, configPath }
 */
export async function grafanaQuery(datasourceUid, expr, opts = {}) {
  const {
    from = "now-5m",
    to = "now",
    instant = true,
    configPath,
    intervalMs = 15000,
    maxDataPoints = 1000,
  } = opts;

  const token = loadToken(configPath);

  const body = {
    queries: [
      {
        refId: "A",
        datasource: { uid: datasourceUid, type: "prometheus" },
        expr,
        instant,
        range: !instant,
        intervalMs,
        maxDataPoints,
      },
    ],
    from,
    to,
  };

  const headers = { "Authorization": `Bearer ${token}` };
  if (KETER_HOST_HEADER) headers["Host"] = KETER_HOST_HEADER;

  const { status, text } = await httpPostJson(`${KETER_API_BASE}/api/grafana/datasources/query`, body, headers);
  if (status < 200 || status >= 300) {
    throw new Error(`Keter API ${status}: ${text}`);
  }
  return JSON.parse(text);
}

/**
 * rangeQuery — for time-series charts (block insert latency, gas used)
 */
export async function rangeQuery(datasourceUid, expr, opts = {}) {
  return grafanaQuery(datasourceUid, expr, { ...opts, instant: false, range: true });
}

/**
 * Extract labels array from Grafana query response
 * Equivalent to: jq '[.results.A.frames[].schema.fields[1].labels]'
 */
export function extractLabels(grafanaResponse) {
  return grafanaResponse?.results?.A?.frames?.map(
    (f) => f.schema?.fields?.[1]?.labels ?? {}
  ) ?? [];
}

/**
 * Extract time-series data from Grafana response
 * Returns: [{ labels, times: [], values: [] }]
 */
export function extractSeries(grafanaResponse) {
  return grafanaResponse?.results?.A?.frames?.map((f) => ({
    labels: f.schema?.fields?.[1]?.labels ?? {},
    times:  f.data?.values?.[0] ?? [],
    values: f.data?.values?.[1] ?? [],
  })) ?? [];
}
