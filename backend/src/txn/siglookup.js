/**
 * Selector → function-signature lookup via openchain.xyz (free, batched).
 * In-memory cache; failures degrade to empty map (labeling still works).
 */

const cache = new Map();   // sel → name | null

export async function lookupSelectors(sels) {
  const todo = [...new Set(sels)].filter((s) => /^0x[0-9a-f]{8}$/.test(s) && !cache.has(s)).slice(0, 80);
  if (todo.length) {
    try {
      const r = await fetch(
        `https://api.openchain.xyz/signature-database/v1/lookup?function=${todo.join(",")}&filter=true`,
        { signal: AbortSignal.timeout(10_000) }
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
