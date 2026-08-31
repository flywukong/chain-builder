// geth db inspect 扫描结果(手动脚本生成,2026-08-24 · mainnet 全节点)。
// v1.1 起由「自动分析」按钮远程执行 inspect → 解析生成本结构 → 与上月对比。

export const INSPECT_META = {
  scannedAt: "2026-08-24",
  totalTiB: 7.53,
  totalItems: "33,788,819,141",
};

// sizeGiB 统一换算成 GiB;items 保留原始计数
export const INSPECT_GROUPS = [
  {
    db: "Key-Value store",
    rows: [
      { cat: "Path trie storage nodes",    sizeGiB: 996.26,  items: 9962554747 },
      { cat: "Storage snapshot",           sizeGiB: 518.77,  items: 7339288028 },
      { cat: "Transaction index",          sizeGiB: 493.48,  items: 14395747318 },
      { cat: "Path trie account nodes",    sizeGiB: 122.41,  items: 1066734278 },
      { cat: "Receipt lists",              sizeGiB: 74.62,   items: 600021 },
      { cat: "Bodies",                     sizeGiB: 43.88,   items: 600021 },
      { cat: "Account snapshot",           sizeGiB: 35.60,   items: 773002663 },
      { cat: "Contract codes",             sizeGiB: 34.87,   items: 4717429 },
      { cat: "BlobSidecars",               sizeGiB: 11.43,   items: 600012 },
      { cat: "Log index filter-map rows",  sizeGiB: 4.98,    items: 49279483 },
      { cat: "Block hash→number",          sizeGiB: 4.50,    items: 117766870 },
      { cat: "Path trie state lookups",    sizeGiB: 1.24,    items: 32430540 },
      { cat: "Parlia snapshots",           sizeGiB: 0.896,   items: 115290 },
      { cat: "Headers",                    sizeGiB: 0.524,   items: 600021 },
      { cat: "Difficulties (deprecated)",  sizeGiB: 0.026,   items: 600021 },
      { cat: "Block number→hash",          sizeGiB: 0.023,   items: 600016 },
      { cat: "Singleton metadata",         sizeGiB: 0.013,   items: 18 },
      { cat: "Log index block-lv",         sizeGiB: 0.011,   items: 591768 },
      { cat: "Log index last-block-of-map", sizeGiB: 0.0012, items: 26184 },
    ],
  },
  {
    db: "Ancient store (Chain)",
    rows: [
      { cat: "Bodies",   sizeGiB: 2795.5, items: 117166856 },
      { cat: "Receipts", sizeGiB: 2437.1, items: 117166856 },
      { cat: "Headers",  sizeGiB: 84.22,  items: 117166856 },
      { cat: "Blobs",    sizeGiB: 8.09,   items: 117166856 },
      { cat: "Hashes",   sizeGiB: 4.15,   items: 117166856 },
      { cat: "Diffs",    sizeGiB: 1.19,   items: 117166856 },
    ],
  },
  {
    db: "Ancient store (State)",
    rows: [
      { cat: "Storage.Index", sizeGiB: 9.85, items: 600000 },
      { cat: "Account.Data",  sizeGiB: 6.07, items: 600000 },
      { cat: "Account.Index", sizeGiB: 4.04, items: 600000 },
      { cat: "Storage.Data",  sizeGiB: 3.81, items: 600000 },
      { cat: "History.Meta",  sizeGiB: 0.063, items: 600000 },
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
    { d: "08-24", v: 1.69, delta: "+72 GiB/月" },
  ],
  snapshot: [  // 扁平 snapshot(GiB)· storage snapshot 占 ~94%
    { d: "02-02", v: 436, delta: null },
    { d: "03-02", v: 452, delta: "+17 GiB/月" },
    { d: "04-07", v: 468, delta: "+13 GiB/月" },
    { d: "06-23", v: 508, delta: "+16 GiB/月" },
    { d: "08-24", v: 554, delta: "+22 GiB/月" },
  ],
  nonSnapshot: [  // 纯 trie 状态 + code + 状态历史(GiB)
    { d: "02-02", v: 927,  delta: null },
    { d: "03-02", v: 958,  delta: "+33 GiB/月" },
    { d: "04-07", v: 990,  delta: "+26 GiB/月" },
    { d: "06-23", v: 1076, delta: "+34 GiB/月" },
    { d: "08-24", v: 1179, delta: "+50 GiB/月" },
  ],
  growthGiBPerMonth: 72,   // 最近区间月增,用于未来投影
};
