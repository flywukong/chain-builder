const API = import.meta.env.VITE_API_BASE ?? "";

// 网关错误页(504 HTML 等)容错:给可读错误而不是 JSON SyntaxError
async function parseJson(r) {
  const txt = await r.text();
  try { return JSON.parse(txt); }
  catch { throw new Error(`网关响应异常(HTTP ${r.status}),分析可能仍在后台进行,稍后可重试`); }
}

// AI 请求统一走异步任务模式:POST 立即返回(queued / running / cached),
// 需要时轮询 GET 直到出新结果。彻底绕开反向代理对长连接的 60s 超时
// (MCP 链上取证分析可达 1-2 分钟)。
export async function aiRequest(path, body, { pollMs = 3500, timeoutMs = 360_000 } = {}) {
  const r = await fetch(API + path, {
    method: "POST",
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const first = await parseJson(r);
  if (!first.running && !first.queued) return first;          // 同步完成 / TTL 缓存命中 / 硬错误
  if (first.error) return first;                              // 429 之类:已有任务在跑
  const prevAt = first.at ?? 0;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((res) => setTimeout(res, pollMs));
    let s;
    try { s = await parseJson(await fetch(API + path)); } catch { continue; }   // 轮询期网关抖动忽略
    if (!s.running) {
      if (s.at && s.at !== prevAt) return s;                  // 新结果(成功)
      if (s.error) return s;                                  // 任务失败
    }
  }
  return { error: "分析超时(6 分钟未完成),请稍后重试" };
}
