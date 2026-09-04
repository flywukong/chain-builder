/**
 * Selector → function-signature lookup via openchain.xyz (free, batched).
 * In-memory cache; failures degrade to empty map (labeling still works).
 */

const cache = new Map();   // sel → name | null
const eventCache = new Map();

export async function lookupSelectors(sels) {
  const todo = [...new Set(sels)].filter((s) => /^0x[0-9a-f]{8}$/.test(s) && !cache.has(s)).slice(0, 80);
  if (todo.length) {
    try {
      const r = await fetch(
        `https://api.openchain.xyz/signature-database/v1/lookup?function=${todo.join(",")}&filter=true`,
        { signal: AbortSignal.timeout(4_000) }
      ).then((x) => x.json());
      for (const s of todo) {
        const name = r?.result?.function?.[s]?.[0]?.name ?? null;
        cache.set(s, name);
      }
    } catch { /* leave uncached; retry next round */ }
  }
  const out = {};
  for (const s of sels) if (cache.get(s)) out[s] = cache.get(s);
  return out;
}

export async function lookupEventSignatures(topics) {
  const todo = [...new Set(topics)].filter((s) => /^0x[0-9a-f]{64}$/.test(s) && !eventCache.has(s)).slice(0, 80);
  if (todo.length) {
    try {
      const r = await fetch(
        `https://api.openchain.xyz/signature-database/v1/lookup?event=${todo.join(",")}&filter=true`,
        { signal: AbortSignal.timeout(4_000) }
      ).then((x) => x.json());
      for (const topic of todo) eventCache.set(topic, r?.result?.event?.[topic]?.[0]?.name ?? null);
    } catch { /* leave uncached; retry next round */ }
  }
  return Object.fromEntries(topics.filter((topic) => eventCache.get(topic)).map((topic) => [topic, eventCache.get(topic)]));
}
