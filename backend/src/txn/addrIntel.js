/**
 * Address intel — cheap on-chain "what is this address" signal for unknown
 * contracts, feeding both the AI labeler and the UI hint.
 *
 * Layer 1 (RPC, free): code → contract / EOA / EIP-7702 delegated wallet;
 *   code size; BNB balance; nonce (txCount, high = automation/payment).
 * Layer 2 (BscScan, optional API key): verified ContractName + proxy impl.
 *   Public labels (e.g. "BlockRazor: Payment") are NOT in the free API —
 *   seed those into labels.js manually.
 *
 * Cached in-memory: address form is stable, so one fetch per address.
 */

import { ethers } from "ethers";

const cache = new Map();   // addr → intel

export function getCachedIntel(addr) {
  return cache.get((addr || "").toLowerCase()) ?? null;
}

export async function getAddrIntel(provider, addr, { bscscanKey = null } = {}) {
  const a = (addr || "").toLowerCase();
  if (cache.has(a)) return cache.get(a);
  const intel = { addr: a };
  try {
    const [code, bal, nonce] = await Promise.all([
      provider.getCode(a),
      provider.getBalance(a).catch(() => null),
      provider.getTransactionCount(a).catch(() => null),
    ]);
    if (!code || code === "0x") { intel.type = "EOA"; intel.codeSize = 0; }
    else if (code.startsWith("0xef0100")) { intel.type = "EIP-7702"; intel.codeSize = (code.length - 2) / 2; }
    else { intel.type = "contract"; intel.codeSize = (code.length - 2) / 2; }
    intel.balanceBNB = bal != null ? +(+ethers.formatEther(bal)).toFixed(3) : null;
    intel.nonce = nonce;
  } catch (e) { intel.error = e.message; }

  if (bscscanKey && intel.type === "contract") {
    try {
      const r = await fetch(
        `https://api.bscscan.com/api?module=contract&action=getsourcecode&address=${a}&apikey=${bscscanKey}`,
        { signal: AbortSignal.timeout(8000) }
      ).then((x) => x.json());
      const s = r?.result?.[0];
      if (s) {
        intel.verified = !!s.ABI && s.ABI !== "Contract source code not verified";
        if (s.ContractName) intel.verifiedName = s.ContractName;
        if (s.Proxy === "1" && s.Implementation && /^0x[0-9a-fA-F]{40}$/.test(s.Implementation)) intel.implementation = s.Implementation.toLowerCase();
      }
    } catch { /* non-fatal */ }
  }
  cache.set(a, intel);
  return intel;
}
