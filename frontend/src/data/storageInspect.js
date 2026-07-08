// geth db inspect 扫描结果(手动脚本生成,2026-06-23 · mainnet 全节点)。
// v1.1 起由「自动分析」按钮远程执行 inspect → 解析生成本结构 → 与上月对比。

export const INSPECT_META = {
  scannedAt: "2026-06-23",
  totalTiB: 6.80,
  totalItems: "31,171,789,594",
};

// sizeGiB 统一换算成 GiB;items 保留原始计数
export const INSPECT_GROUPS = [
  {
    db: "Key-Value store",
    rows: [
      { cat: "Path trie storage nodes",    sizeGiB: 912.48,  items: 9115145544 },
      { cat: "Storage snapshot",           sizeGiB: 475.29,  items: 6714468378 },
      { cat: "Transaction index",          sizeGiB: 459.52,  items: 13410124321 },
      { cat: "Path trie account nodes",    sizeGiB: 114.82,  items: 1001576582 },
      { cat: "Receipt lists",              sizeGiB: 37.20,   items: 600102 },
      { cat: "Account snapshot",           sizeGiB: 33.03,   items: 723985842 },
      { cat: "Contract codes",             sizeGiB: 32.70,   items: 4410323 },
      { cat: "Bodies",                     sizeGiB: 22.71,   items: 600102 },
      { cat: "BlobSidecars",               sizeGiB: 11.44,   items: 600093 },
      { cat: "Block hash→number",          sizeGiB: 4.04,    items: 105825607 },
      { cat: "Log index filter-map rows",  sizeGiB: 2.75,    items: 28475361 },
      { cat: "Path trie state lookups",    sizeGiB: 0.78,    items: 20489266 },
      { cat: "Parlia snapshots",           sizeGiB: 0.79,    items: 103629 },
      { cat: "Headers",                    sizeGiB: 0.52,    items: 600102 },
      { cat: "Difficulties (deprecated)",  sizeGiB: 0.026,   items: 600102 },
      { cat: "Block number→hash",          sizeGiB: 0.023,   items: 600086 },
      { cat: "Block access list",          sizeGiB: 0.015,   items: 327 },
      { cat: "Singleton metadata",         sizeGiB: 0.013,   items: 18 },
      { cat: "Log index block-lv",         sizeGiB: 0.011,   items: 604063 },
    ],
  },
  {
    db: "Ancient store (Chain)",
    rows: [
      { cat: "Bodies",   sizeGiB: 2549.8, items: 105225512 },
      { cat: "Receipts", sizeGiB: 2191.4, items: 105225512 },
      { cat: "Headers",  sizeGiB: 74.88,  items: 105225512 },
      { cat: "Blobs",    sizeGiB: 8.43,   items: 105225512 },
      { cat: "Hashes",   sizeGiB: 3.72,   items: 105225512 },
      { cat: "Diffs",    sizeGiB: 1.07,   items: 105225512 },
    ],
  },
  {
    db: "Ancient store (State)",
    rows: [
      { cat: "Storage.Index", sizeGiB: 6.19, items: 600000 },
      { cat: "Account.Data",  sizeGiB: 3.97, items: 600000 },
      { cat: "Account.Index", sizeGiB: 2.68, items: 600000 },
      { cat: "Storage.Data",  sizeGiB: 2.31, items: 600000 },
      { cat: "History.Meta",  sizeGiB: 0.15, items: 600000 },
    ],
  },
];

// state 数据增长历史(多次扫描,月增为区间折算)
export const STATE_HISTORY = {
  total: [   // State 合计(TiB)
    { d: "02-02", v: 1.33, delta: null },
    { d: "03-02", v: 1.38, delta: "+50 GiB/月" },
    { d: "04-07", v: 1.42, delta: "+39 GiB/月" },
    { d: "06-23", v: 1.55, delta: "+49 GiB/月" },
  ],
  snapshot: [  // 扁平 snapshot(GiB)· storage snapshot 占 ~93%
    { d: "02-02", v: 436, delta: null },
    { d: "03-02", v: 452, delta: "+17 GiB/月" },
    { d: "04-07", v: 468, delta: "+13 GiB/月" },
    { d: "06-23", v: 508, delta: "+16 GiB/月" },
  ],
  nonSnapshot: [  // 纯 trie 状态 + code + 状态历史(GiB)
    { d: "02-02", v: 927,  delta: null },
    { d: "03-02", v: 958,  delta: "+33 GiB/月" },
    { d: "04-07", v: 990,  delta: "+26 GiB/月" },
    { d: "06-23", v: 1076, delta: "+34 GiB/月" },
  ],
  growthGiBPerMonth: 49,   // 最近区间月增,用于未来投影
};
