/**
 * BlockStreamer — real-time BSC block ingestion.
 *
 * Primary:  WebSocket eth_subscribe("newHeads") push (sub-second blocks, 0.45s @ Fermi).
 * Guard:    SeqGuard — dedup, gap backfill, reorg detection (parentHash linkage).
 * Fallback: 5s heartbeat — backfills any gap and force-reconnects a stale WS.
 *
 * All ingestion is serialized through a promise chain so heartbeat backfill and
 * live headers never race. blocktime is derived from milliTimestamp (sub-second precise).
 */

import { EventEmitter } from "events";
import { ethers } from "ethers";
import WebSocket from "ws";

// Known MEV builders (from getchainstatus.js)
const BUILDER_MAP = new Map([
  ["0x5532CdB3c0c4278f9848fc4560b495b70bA67455", "blockrazor dublin"],
  ["0xBA4233f6e478DB76698b0A5000972Af0196b7bE1", "blockrazor frankfurt"],
  ["0x539E24781f616F0d912B60813aB75B7b80b75C53", "blockrazor nyc"],
  ["0x49D91b1Ab0CC6A1591c2e5863E602d7159d36149", "blockrazor relay"],
  ["0x50061047B9c7150f0Dc105f79588D1B07D2be250", "blockrazor tokyo"],
  ["0x0557E8CB169F90F6eF421a54e29d7dd0629Ca597", "blockrazor virginia"],
  ["0x488e37fcB2024A5B2F4342c7dE636f0825dE6448", "blockrazor x"],
  ["0x48a5Ed9abC1a8FBe86ceC4900483f43a7f2dBB48", "puissant ap"],
  ["0x487e5Dfe70119C1b320B8219B190a6fa95a5BB48", "puissant eu"],
  ["0x48FeE1BB3823D72fdF80671ebaD5646Ae397BB48", "puissant us"],
  ["0x48B4bBEbF0655557A461e91B8905b85864B8BB48", "puissant x"],
  ["0x4827b423D03a349b7519Dda537e9A28d31ecBB48", "puissant y"],
  ["0x48B2665E5E9a343409199D70F7495c8aB660BB48", "puissant z"],
  // 0x48…BB48 vanity 与 puissant 同款,确认属 48club(上游 getchainstatus 中仍名 unknown-1..4)
  ["0x48265F91F542dCE47ABE5E6683bb086c0f36BB48", "48club u1"],
  ["0x48437A0d4AB091b81c6DeD43dEbf23cdfC85BB48", "48club u2"],
  ["0x4851f44038fE746173e9E3C4A6e7E904c619BB48", "48club u3"],
  ["0x4880cb180d3bb665748f7b66f75F1fEE68D8BB48", "48club u4"],
  ["0xD4376FdC9b49d90e6526dAa929f2766a33BFFD52", "blockroute dublin"],
  ["0x2873fc7aD9122933BECB384f5856f0E87918388d", "blockroute frankfurt"],
  ["0x432101856a330aafdeB049dD5fA03a756B3f1c66", "blockroute japan"],
  ["0x2B217a4158933AAdE6D6494e3791D454B4D13AE7", "blockroute nyc"],
  ["0x0da52E9673529b6E06F444FbBED2904A37f66415", "blockroute relay"],
  ["0xE1ec1AeCE7953ecB4539749B9AA2eEF63354860a", "blockroute singapore"],
  ["0x89434FC3a09e583F2cb4e47A8B8fe58De8BE6a15", "blockroute virginia"],
  ["0x10353562E662E333C0c2007400284e0e21cF74fF", "blockroute x"],
  ["0x36CB523286D57680efBbfb417C63653115bCEBB5", "jetbldr ap"],
  ["0x3aD6121407f6EDb65C8B2a518515D45863C206A8", "jetbldr eu"],
  ["0x345324dC15F1CDcF9022E3B7F349e911fb823b4C", "jetbldr us"],
  ["0xfd38358475078F81a45077f6e59dff8286e0dCA1", "jetbldr dublin"],
  ["0x7F5fbFd8e2eB3160dF4c96757DEEf29E26F969a3", "jetbldr tokyo"],
  ["0xA0Cde9891C6966fCe740817cc5576De2C669AB43", "jetbldr virginia"],
  ["0x3FC0c936c00908c07723ffbf2d536D6E0f62C3A4", "blockbus dublin"],
  ["0x17e9F0D7E45A500f0148B29C6C98EfD19d95F138", "blockbus tokyo"],
  ["0x1319Be8b8Ec4AA81f501924BdCF365fBcAa8d753", "blockbus virginia"],
  ["0x6Dddf681C908705472D09B1D7036B2241B50e5c7", "txboost ap"],
  ["0x76736159984AE865a9b9Cc0Df61484A49dA68191", "txboost eu"],
  ["0x5054b21D8baea3d602dca8761B235ee10bc0231E", "txboost us"],
  ["0xa6d6086222812eFD5292fF284b0F7ff2a2B86Af4", "darwin ap"],
  ["0x3265A3243ee84e667a73073504cA4CdeD1413D82", "darwin eu"],
  ["0xdf11CD23992Fd48Cf2d245aC144010673275f285", "darwin us"],
  ["0x9a3234b450518fadA098388B88e00deCAd96ad38", "inblock ap"],
  ["0xb49f86586a840AB9920D2f340a85586E50FD30a2", "inblock eu"],
  ["0x0F6D8b72F3687de6f2824903a83B3ba13c0e88A0", "inblock us"],
  ["0x79102dB16781ddDfF63F301C9Be557Fd1Dd48fA0", "nodereal ap-1"],
  ["0x5B526b45e833704d84b5C2EB0F41323dA9466c48", "nodereal ap-2"],
  ["0xd0d56b330a0dea077208b96910ce452fd77e1b6f", "nodereal eu-1"],
  ["0xa547F87B2BADE689a404544859314CBC01f2605e", "nodereal eu-2"],
  ["0x4f24ce4cd03a6503de97cf139af2c26347930b99", "nodereal us-1"],
  ["0xFD3F1Ad459D585C50Cf4630649817C6E0cec7335", "nodereal us-2"],
  ["0x812720cb4639550D7BDb1d8F2be463F4a9663762", "xzbuilder"],
  ["0x627fE6AFA2E84e461CB7AE7C2c46e8adf9a954a2", "txboost"],
  ["0xa5559F1761e6dCa79Ac0c7A301CCDcC71D378fee", "nodereal ap"],
  ["0x6C98EB21139F6E12db5b78a4AeD4d8eBA147FB7b", "nodereal eu"],
  ["0x4E8cbf5912717B212db5b450ae7737455A5cc0aF", "nodereal us"],
  ["0x0eAbBdE133fbF3c5eB2BEE6F7c8210deEAA0f7db", "blockrazor ap"],
  ["0x95c8436143c82Ea4d3529A3ed8DDa9998F6daC5F", "blockrazor eu"],
  ["0xb71Ba9e570ee20E983De1d5aE01baf5dCB4e4299", "blockrazor us"],
  ["0x7b3ee856c98b1bb3689ef7f90477df2927fcbdb6", "trustnet"],
  ["0xA8caEc0D68a90Ac971EA1aDEFA1747447e1f9871", "blockroute"],
]);

function getBuilderName(address) {
  if (!address) return null;
  try {
    const norm = ethers.getAddress(address);
    return BUILDER_MAP.get(norm) ?? BUILDER_MAP.get(norm.toLowerCase()) ?? null;
  } catch {
    return BUILDER_MAP.get(address) ?? null;
  }
}

// Version from extraData bytes 2-4 (major.minor.patch)
function parseVersion(extraData) {
  try {
    const major = ethers.toNumber(ethers.dataSlice(extraData, 2, 3));
    const minor = ethers.toNumber(ethers.dataSlice(extraData, 3, 4));
    const patch = ethers.toNumber(ethers.dataSlice(extraData, 4, 5));
    return `v${major}.${minor}.${patch}`;
  } catch {
    return "unknown";
  }
}

// Anomaly thresholds recalibrated for 0.45s blocks (Fermi).
// Expected ~450ms; >=900ms slow; >=2000ms = missed slot (backOffTime=2000 signature).
const MISSED_MS = 2000;

const SEED_BLOCKS   = 30;     // backfill recent blocks on start for non-empty window
const BACKFILL_CAP  = 500;    // don't backfill more than this after long downtime
const HEARTBEAT_MS  = 5000;
const RPC_TIMEOUT_MS = 8000;
// BSC blocks always carry validator system txs (~50-100k gas), so gasUsed is never 0.
// Below this ≈ system-txs-only → the validator packed no user transactions.
const EMPTY_GAS_MAX = 200_000;
// BSC fast-finality reorgs are ≤2-3 deep. Anything deeper is not a reorg — it's a
// load-balanced RPC endpoint serving a stale backend. Never rewind the tip for it.
const REORG_MAX_DEPTH = 64;
const WS_STALE_MS    = 10000; // WS open but silent this long while chain advances → reconnect
const MEV_CONCURRENCY = 6;    // parallel getBlock(full) for MEV enrichment (off the tip path)
const MEV_QUEUE_CAP   = 80;   // cap pending MEV enrichments; drop stale beyond this

export class BlockStreamer extends EventEmitter {
  constructor({ wsUrl, rpcUrl }) {
    super();
    this.wsUrl = wsUrl || null;
    // 8s request timeout — ethers' 300s default turns an outage into an hours-long
    // serialized-queue pileup (each queued call stalls the ingestion chain).
    const req = new ethers.FetchRequest(rpcUrl);
    req.timeout = RPC_TIMEOUT_MS;
    this.http = new ethers.JsonRpcProvider(req, undefined, { staticNetwork: true });

    this.lastNumber  = null;
    this.lastHash    = null;
    this.lastMilliTs = null;

    this.window = [];
    this.WINDOW_SIZE = 660;   // ~5 min @ 0.45s — used for 5-min health stats

    this.running = false;
    this.ws = null;
    this.reconnectDelay = 1000;
    this.lastHeaderAt = 0;      // wall-clock of last WS push
    this.connected = false;
    this._chain = Promise.resolve();
    this._reqId = 1;
    this._warnedNoWs = false;
    this._mevQueue = [];   // blocks awaiting async MEV enrichment
    this._mevActive = 0;
  }

  async start() {
    this.running = true;
    // Seed recent window so the dashboard isn't empty on first load.
    try {
      const head = await this.http.getBlockNumber();
      await this._backfill(Math.max(0, head - SEED_BLOCKS), head);
    } catch (err) {
      this.emit("error", err);
    }
    this._connect();
    this._heartbeat();
  }

  stop() {
    this.running = false;
    clearTimeout(this._hbTimer);
    if (this.ws) { try { this.ws.removeAllListeners(); this.ws.close(); } catch {} }
  }

  // ── serialized ingestion (prevents backfill vs live-header races) ──
  _enqueue(fn) {
    this._chain = this._chain.then(fn).catch((e) => this.emit("error", e));
    return this._chain;
  }

  // ── WebSocket newHeads ──
  _connect() {
    if (!this.running) return;
    if (!this.wsUrl) {
      if (!this._warnedNoWs) {
        this.emit("status", { wsDisabled: true, note: "no BSC_WS_URL; running on 5s heartbeat backfill" });
        this._warnedNoWs = true;
      }
      return; // heartbeat backfill carries the load
    }
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectDelay = 1000;
      this.connected = true;
      this.emit("status", { connected: true });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: this._reqId++, method: "eth_subscribe", params: ["newHeads"] }));
    });
    ws.on("message", (data) => this._onMessage(data));
    ws.on("close", () => {
      this.connected = false;
      this.emit("status", { connected: false });
      this._scheduleReconnect();
    });
    ws.on("error", (err) => {
      this.emit("error", err);
      try { ws.close(); } catch {}
    });
  }

  _scheduleReconnect() {
    if (!this.running) return;
    if (this.ws) { try { this.ws.removeAllListeners(); } catch {} this.ws = null; }
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    setTimeout(() => this._connect(), delay);
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.method === "eth_subscription" && msg.params?.result) {
      this.lastHeaderAt = Date.now();
      const header = msg.params.result;
      this._enqueue(() => this._handleHeader(header));
    }
    // subscription-id confirmation ({id, result:"0x.."}) needs no handling
  }

  // ── normalize a header (newHeads or eth_getHeaderByNumber) ──
  _norm(h) {
    const ts = Number(BigInt(h.timestamp));
    // BSC stores sub-second ms in mixHash (0-999); eth_getHeaderByNumber also returns milliTimestamp.
    const milliTs = h.milliTimestamp != null
      ? Number(BigInt(h.milliTimestamp))
      : ts * 1000 + (h.mixHash ? Number(BigInt(h.mixHash) % 1000n) : 0);
    const gasUsed  = Number(BigInt(h.gasUsed));
    const gasLimit = Number(BigInt(h.gasLimit));
    return {
      number: Number(BigInt(h.number)),
      hash: h.hash,
      parentHash: h.parentHash,
      miner: h.miner,
      milliTs,
      gasUsed,
      gasLimit,
      gasUtilPct: gasLimit ? Math.round((gasUsed / gasLimit) * 100) : 0,
      version: parseVersion(h.extraData),
    };
  }

  // ── SeqGuard: classify and route a header ──
  async _handleHeader(raw) {
    const n = this._norm(raw);

    // exact duplicate
    if (this.lastNumber !== null && n.number === this.lastNumber && n.hash === this.lastHash) return;

    if (this.lastNumber === null) {
      await this._ingest(n);
      return;
    }

    if (n.number <= this.lastNumber) {
      const depth = this.lastNumber - n.number + 1;
      if (depth > REORG_MAX_DEPTH) {
        // NOT a reorg — a load-balanced endpoint served a stale backend. Rewinding
        // the tip here is exactly what caused the perpetual reorg↔backfill loop and
        // the corrupted block times. Ignore the stale header; keep the tip.
        this.emit("status", { staleSourceIgnored: { got: n.number, tip: this.lastNumber, behind: depth } });
        return;
      }
      this.emit("reorg", { from: this.lastNumber, to: n.number, depth });
      await this._ingest(n, { isReorg: true });
      return;
    }

    if (n.number > this.lastNumber + 1) {
      const gap = n.number - this.lastNumber - 1;
      if (gap > BACKFILL_CAP) {
        // huge jump ahead (restart after downtime, or a far-ahead endpoint) →
        // fast-forward straight to the tip instead of backfilling thousands of blocks.
        this.emit("status", { skipAhead: { from: this.lastNumber, to: n.number, gap } });
        await this._ingest(n, { discontinuous: true });
        return;
      }
      await this._backfill(this.lastNumber + 1, n.number - 1);   // small gap → fill missing
    } else if (n.parentHash && this.lastHash && n.parentHash !== this.lastHash) {
      this.emit("reorg", { from: this.lastNumber, to: n.number, depth: 1, parentMismatch: true });
    }

    await this._ingest(n);
  }

  async _backfill(from, to) {
    if (to < from) return;
    if (to - from + 1 > BACKFILL_CAP) {
      // way behind (sleep/outage): crawling hundreds of sequential RPCs can never
      // catch a 0.45s chain — jump straight to the tip; charts keep a gap.
      this.emit("status", { skipAhead: { from, to, gap: to - from + 1 } });
      try {
        const raw = await this.http.send("eth_getHeaderByNumber", [ethers.toQuantity(to)]);
        if (raw) await this._ingest(this._norm(raw), { discontinuous: true });
      } catch (err) { this.emit("error", err); }
      return;
    }
    for (let i = from; i <= to; i++) {
      try {
        const raw = await this.http.send("eth_getHeaderByNumber", [ethers.toQuantity(i)]);
        if (raw) await this._ingest(this._norm(raw));
      } catch (err) {
        this.emit("error", err);
      }
    }
  }

  // Fast path: header-only ingest (keeps up with the 0.45s tip). MEV detection
  // (slow getBlock-full) is enriched asynchronously and never blocks the tip.
  _ingest(n, { isReorg = false, discontinuous = false } = {}) {
    const blockTimeMs = (!isReorg && !discontinuous && this.lastMilliTs !== null) ? n.milliTs - this.lastMilliTs : null;
    // interval-based "slow" is normal turn-boundary jitter — only missed slots count
    const anomaly = blockTimeMs !== null && blockTimeMs >= MISSED_MS ? "missed" : null;
    const empty = n.gasUsed < EMPTY_GAS_MAX;   // system-txs-only block: validator packed no user txs

    const block = {
      number:     n.number,
      hash:       n.hash,
      miner:      n.miner,
      timestampMs: n.milliTs,
      blockTimeMs,
      anomaly,
      empty,
      isReorg,
      gasUsed:    n.gasUsed,
      gasLimit:   n.gasLimit,
      gasUtilPct: n.gasUtilPct,
      version:    n.version,
      // MEV enriched asynchronously (see _scheduleMev); pending until then
      isMev:      false,
      builder:    null,
      mev:        { source: "pending" },
    };

    this.window.push(block);
    if (this.window.length > this.WINDOW_SIZE) this.window.shift();

    this.lastNumber  = n.number;
    this.lastHash    = n.hash;
    this.lastMilliTs = n.milliTs;

    this.emit("block", block);
    this._scheduleMev(block);
  }

  // ── async MEV enrichment (bounded concurrency, never blocks tip) ──
  _scheduleMev(block) {
    this._mevQueue.push(block);
    if (this._mevQueue.length > MEV_QUEUE_CAP) this._mevQueue.shift(); // drop stale (scrolled out of window)
    this._drainMev();
  }

  _drainMev() {
    while (this._mevActive < MEV_CONCURRENCY && this._mevQueue.length) {
      const block = this._mevQueue.shift();
      this._mevActive++;
      this._getMevInfo(block.number)
        .then((mev) => {
          block.mev = mev;
          block.isMev = mev.source !== "local" && mev.source !== "pending";
          block.builder = mev.builderName ?? mev.builder ?? null;
          this.emit("blockMev", block);
        })
        .catch(() => {})
        .finally(() => { this._mevActive--; this._drainMev(); });
    }
  }

  async _getMevInfo(blockNumber) {
    // 1) eth_getBlockMevInfo — not yet on mainnet, but future-proof / works on updated nodes.
    try {
      const info = await this.http.send("eth_getBlockMevInfo", [ethers.toQuantity(blockNumber)]);
      if (info?.builder) {
        const source = info.version === "v2" ? "bidblock" : "bid";
        return { source, builder: info.builder, builderName: getBuilderName(info.builder), version: info.version };
      }
      if (info) return { source: "local" };
    } catch {
      // method unavailable (mainnet) → fall through to heuristic
    }

    // 2) Heuristic (current mainnet): the builder payout is among the last txs of the
    //    block → its `to` matches a known builder address. Mirrors getchainstatus.js.
    try {
      const block = await this.http.getBlock(blockNumber, true); // prefetch full txs (1 call)
      const txs = block?.prefetchedTransactions;
      if (!txs?.length) return { source: "local" };
      for (const tx of txs.slice(-8)) {
        const name = tx?.to && getBuilderName(tx.to);
        if (name) return { source: "bid", builder: tx.to, builderName: name, fallback: true };
      }
      return { source: "local" };
    } catch {
      return { source: "local" };
    }
  }

  // ── heartbeat safety net: backfill gaps + recycle a stale WS ──
  _heartbeat() {
    if (!this.running) return;
    this._hbTimer = setTimeout(() => {
      // WS staleness check OUTSIDE the ingestion queue — a clogged queue must
      // never prevent recycling a zombie socket (the post-sleep failure mode).
      const silent = Date.now() - this.lastHeaderAt;
      if (this.connected && this.ws?.readyState === WebSocket.OPEN && silent > WS_STALE_MS) {
        this.emit("status", { wsStaleReconnect: true, silentMs: silent });
        try { this.ws.terminate ? this.ws.terminate() : this.ws.close(); } catch {}
      }
      // backfill probe: never stack — skip this tick if the previous one is still running
      if (!this._hbBusy) {
        this._hbBusy = true;
        this._enqueue(async () => {
          try {
            const head = await this.http.getBlockNumber();
            if (this.lastNumber !== null && head > this.lastNumber) {
              await this._backfill(this.lastNumber + 1, head);
            }
          } catch {
            /* heartbeat errors are non-fatal */
          } finally {
            this._hbBusy = false;
          }
        });
      }
      this._heartbeat();
    }, HEARTBEAT_MS);
  }

  // ── window stats (200-block; Phase 3 will switch to time-window) ──
  getWindowStats() {
    const w = this.window;
    if (w.length === 0) return null;
    const enriched  = w.filter((b) => b.mev.source !== "pending"); // exclude not-yet-enriched
    const mevBlocks = w.filter((b) => b.isMev);
    const v2Blocks  = w.filter((b) => b.mev.source === "bidblock");
    const empties = w.filter((b) => b.empty);
    const missed  = w.filter((b) => b.anomaly === "missed");
    const reorgs    = w.filter((b) => b.isReorg);
    const timed     = w.filter((b) => b.blockTimeMs != null && b.blockTimeMs > 0);
    const avgGasUtil = Math.round(w.reduce((s, b) => s + b.gasUtilPct, 0) / w.length);
    const avgBtMs    = timed.length ? Math.round(timed.reduce((s, b) => s + b.blockTimeMs, 0) / timed.length) : null;

    const builderCounts = {};
    for (const b of mevBlocks) {
      const name = b.mev.builderName ?? b.mev.builder ?? "unknown";
      builderCounts[name] = (builderCounts[name] ?? 0) + 1;
    }

    return {
      total:          w.length,
      mevCount:       mevBlocks.length,
      // floor to 1 decimal — rounding up to a false 100% contradicts a nonzero local count
      mevPct:         enriched.length ? Math.floor((mevBlocks.length / enriched.length) * 1000) / 10 : 0,
      v2Pct:          mevBlocks.length ? Math.floor((v2Blocks.length / mevBlocks.length) * 1000) / 10 : 0,
      anomalyCount:   empties.length,   // 空块(仅系统交易)— field name kept for API compat
      emptyCount:     empties.length,
      missedCount:    missed.length,
      reorgCount:     reorgs.length,
      windowSpanMs:   w.length > 1 && w[w.length-1].timestampMs && w[0].timestampMs ? w[w.length-1].timestampMs - w[0].timestampMs : null,
      avgGasUtilPct:  avgGasUtil,
      avgBlockTimeMs: avgBtMs,
      builderCounts,
      connected:      this.connected,
    };
  }
}
