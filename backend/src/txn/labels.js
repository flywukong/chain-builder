/**
 * Contract label book — static seed of well-known BSC mainnet addresses,
 * merged with AI-learned labels persisted in data/contract-labels.json.
 * cat ∈ meme | defi | bot | stable | bnb | token | cex | bridge | other
 */

import fs from "fs";
import path from "path";

// All keys lowercase.
export const STATIC_LABELS = {
  // ── DEX / DeFi ──
  "0x10ed43c718714eb63d5aa57b78b54704e256024e": { name: "PancakeSwap V2 Router", cat: "defi" },
  "0x13f4ea83d0bd40e75c8222255bc855a974568dd4": { name: "PancakeSwap V3 SmartRouter", cat: "defi" },
  "0x1a0a18ac4becddbd6389559687d1a73d8927e416": { name: "PancakeSwap Universal Router", cat: "defi" },
  "0x46a15b0b27311cedf172ab29e4f4766fbe7f4364": { name: "PancakeSwap V3 PositionManager", cat: "defi" },
  "0xbb4cdb9cbd36b01bd1cbaef60af814a3f6f0ee75": { name: "WBNB", cat: "defi" },
  "0x05ff2b0db69458a0750badebc4f9e13add608c7f": { name: "PancakeSwap V1 Router", cat: "defi" },
  "0xd99d1c33f9fc3444f8101754abc46c52416550d1": { name: "PancakeSwap Testnet Router", cat: "defi" },
  "0x1b81d678ffb9c0263b24a97847620c99d213eb14": { name: "PancakeSwap V3 Pool Deployer", cat: "defi" },
  "0x556b9306565093c855aea9ae92a594704c2cd59e": { name: "PancakeSwap MasterChef V3", cat: "defi" },
  "0x45c54210128a065de780c4b0df3d16664f7f859e": { name: "PancakeSwap CAKE Pool", cat: "defi" },
  "0xfd36e2c2a6789db23113685031d7f16329158384": { name: "Venus Comptroller", cat: "defi" },
  "0x882c173bc7ff3b7786ca16dfed3dfffb9ee7847b": { name: "Venus vBNB", cat: "defi" },
  "0x0870793286aada55d39ce7f82fb2766e8004cf43": { name: "PancakeSwap StableSwap Router", cat: "defi" },
  "0x9a489505a00ce272eaa5e07dba6491314cae3796": { name: "Lista Staking", cat: "defi" },
  "0x1adb950d8bb3da4be104211d5ab038628e477fe6": { name: "Wombat Router", cat: "defi" },

  // ── prediction market: predict.fun(BNB mainnet, dev.predict.fun deployed-contracts)──
  "0x76f42e5520e62ad88f8fe583cbb4bff27eec2531": { name: "predict.fun OptimisticOracle", cat: "predict" },
  "0x09f683d8a144c4ac296d770f839098c3377410c5": { name: "predict.fun Vault", cat: "predict" },
  "0xf4aa30b537882eca7e69defb68d6f631cda77b00": { name: "predict.fun WithdrawalHelper", cat: "predict" },
  "0x14e3cb02f48818a8fef6bc257059767ca9d436ae": { name: "predict.fun RewardDistributor", cat: "predict" },
  "0x9400f8ad57e9e0f352345935d6d3175975eb1d9f": { name: "predict.fun YB ConditionalTokens", cat: "predict" },
  "0x947cc06d38d3cb0a2bb5adfb668b99b4ff53d7b4": { name: "predict.fun YB CtfAdapter", cat: "predict" },
  "0x6beb5a40c032afc305961162d8204cda16decfa5": { name: "predict.fun YB CTFExchange", cat: "predict" },
  "0xf64b0b318aaf83bd9071110af24d24445719a07f": { name: "predict.fun YB NegRisk CT", cat: "predict" },
  "0x41dce1a4b8fb5e6327701750af6231b7cd0b2a40": { name: "predict.fun YB NegRiskAdapter", cat: "predict" },
  "0xcfb9bef5f7b748ac72311f057f3a888bc73334d9": { name: "predict.fun YB WrappedCollateral", cat: "predict" },
  "0x8a289d458f5a134ba40015085a8f50ffb681b41d": { name: "predict.fun YB NegRiskCtfExchange", cat: "predict" },
  "0xbb7250101e0e3611d7e136ffe73bc24b98e3e175": { name: "predict.fun YB NegRiskOperator", cat: "predict" },
  "0x26b366ab634c43bda6d784fdce34f24a37df8172": { name: "predict.fun YB NegRisk CtfAdapter", cat: "predict" },
  "0xfbc2259abb3f01c019ece1d0200ee673bb7ba34f": { name: "predict.fun YB FeeModuleV2", cat: "predict" },
  "0xd172f3fbabe763ee8e52d8b32421574236da6057": { name: "predict.fun YB NegRiskFeeModuleV2", cat: "predict" },
  "0xb4d9f13738a50e88e0ade2eccc89254ef1645f6e": { name: "predict.fun YB CT FeesHandler", cat: "predict" },
  "0xa48c26abd9024a5cc5a869bbd97a6a3d6b9c2089": { name: "predict.fun YB RegisterTokenHelper", cat: "predict" },
  "0x22da1810b194ca018378464a58f6ac2b10c9d244": { name: "predict.fun ConditionalTokens", cat: "predict" },
  "0x242e1ba24f6fc524bfb410062ca5689a9622613d": { name: "predict.fun CtfAdapter", cat: "predict" },
  "0x8bc070bedab741406f4b1eb65a72bee27894b689": { name: "predict.fun CTFExchange", cat: "predict" },
  "0xc3cf7c252f65e0d8d88537df96569ae94a7f1a6e": { name: "predict.fun NegRiskAdapter", cat: "predict" },
  "0x66239b70133773a72a0d589e5564e88a50cd39e7": { name: "predict.fun WrappedCollateral", cat: "predict" },
  "0x365fb81bd4a24d6303cd2f19c349de6894d8d58a": { name: "predict.fun NegRiskCtfExchange", cat: "predict" },
  "0x56020f5024641d577cb54032af70a23a986ecffd": { name: "predict.fun NegRiskOperator", cat: "predict" },
  "0xf61198a64c2e4cad8ccaf218f3f2ecefb017902f": { name: "predict.fun NegRisk CtfAdapter", cat: "predict" },
  "0xf1f8f5c641f20c48526269ef7dff19172efa9783": { name: "predict.fun FeeModuleV2", cat: "predict" },
  "0xf2311c668aaa8dec48d5da577d3018eb94b3132f": { name: "predict.fun NegRiskFeeModuleV2", cat: "predict" },
  "0xd63206243192f1af3d6fc4442db4e3cf25e64030": { name: "predict.fun CT FeesHandler", cat: "predict" },
  "0x89f92c3c27f18080af1361024c6a892144fd8e5e": { name: "predict.fun RegisterTokenHelper", cat: "predict" },

  // ── MEV builder 支付/结算地址(EOA,收用户 BNB→发 validator,非 bot 合约)──
  "0x1266c6be60392a8ff346e8d5eccd3e69dd9c5f20": { name: "BlockRazor Payment", cat: "infra" },

  // ── meme launchpads ──
  "0x5c952063c7fc8610ffdb798152d69f0b9550762b": { name: "four.meme TokenManager", cat: "meme" },
  "0xec4549cadce5da21df6e6422d448034b5233bfbc": { name: "four.meme TokenManager v1", cat: "meme" },
  "0xf251f83e40a78868fcfa3fa4599dad6494e46034": { name: "four.meme Helper", cat: "meme" },

  // ── stablecoins ──
  "0x55d398326f99059ff775485246999027b3197955": { name: "USDT", cat: "stable" },
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": { name: "USDC", cat: "stable" },
  "0xe9e7cea3dedca5984780bafc599bd69add087d56": { name: "BUSD", cat: "stable" },
  "0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3": { name: "DAI", cat: "stable" },
  "0x90c97f71e18723b0cf0dfa30ee176ab653e89f40": { name: "FRAX", cat: "stable" },

  // ── CEX hot wallets ──
  "0xf977814e90da44bfa03b6295a0616a897441acec": { name: "Binance Hot 8", cat: "cex" },
  "0x8894e0a0c962cb723c1976a4421c95949be2d4e3": { name: "Binance Hot 14", cat: "cex" },
  "0xe2fc31f816a9b94326492132018c3aecc4a93ae1": { name: "Binance Hot 16", cat: "cex" },
  "0x3c783c21a0383057d128bae431894a5c19f9cf06": { name: "Binance Hot 20", cat: "cex" },
  "0xdccf3b77da55107280bd850ea519df3705d1a75a": { name: "Binance Hot 21", cat: "cex" },
  "0x28816c4c4792467390c90e5b426f198570e29307": { name: "Binance Hot 22", cat: "cex" },
  "0x5a52e96bacdabb82fd05763e25335261b270efcb": { name: "Binance Hot 28", cat: "cex" },
  "0xa180fe01b906a1be37be6c534a3300785b20d947": { name: "Binance Bridge Hot", cat: "cex" },
  "0x515b72ed8a97f42c568d6a143232775018f133c8": { name: "Binance Hot 24", cat: "cex" },
  "0xbd612a3f30dca67bf60a39fd0d35e39b7ab80774": { name: "OKX Hot", cat: "cex" },
  "0x2c34a2fb1d0b4f55de51e1d0bdefaddce6b7cdd6": { name: "Gate.io Hot", cat: "cex" },
  "0x0639556f03714a74a5feeaf5736a4a64ff70d206": { name: "OKX Hot 2", cat: "cex" },

  // ── bridge / system / infra ──
  "0x0000000000000000000000000000000000001004": { name: "BSC TokenHub", cat: "bridge" },
  "0x2170ed0880ac9a755fd29b2688956bd959f933f8": { name: "ETH (peg)", cat: "token" },
  "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c": { name: "BTCB", cat: "token" },
  "0x0000000071727de22e5e9d8baf0edac6f37da032": { name: "ERC-4337 EntryPoint v0.7", cat: "defi" },
  "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789": { name: "ERC-4337 EntryPoint v0.6", cat: "defi" },
};

// AI-learned labels persist here and override nothing static.
export class LabelBook {
  constructor(file) {
    this.file = file;
    this.learned = {};
    try {
      if (fs.existsSync(file)) this.learned = JSON.parse(fs.readFileSync(file, "utf8")) || {};
    } catch { this.learned = {}; }
  }
  get(addr) {
    const a = (addr || "").toLowerCase();
    return STATIC_LABELS[a] ?? this.learned[a] ?? null;
  }
  addLearned(entries) {   // [{addr, name, cat}]
    let n = 0;
    for (const e of entries ?? []) {
      const a = (e.addr || "").toLowerCase();
      if (!a.startsWith("0x") || STATIC_LABELS[a]) continue;
      this.learned[a] = { name: e.name || null, cat: e.cat || "other", ai: true };
      n++;
    }
    if (n) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.learned, null, 1));
      } catch { /* non-fatal */ }
    }
    return n;
  }
  learnedCount() { return Object.keys(this.learned).length; }
}
