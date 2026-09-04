# 交易分类逻辑（当前口径）

Txn 页面已从旧版 `cat` 十二类迁移到面向开发者的 Traffic v2 主分类。当前架构、规则、指标、存储边界与 20 天回填方式见：

- [Txn 开发者流量分析 v2](./txn-developer-traffic-v2.md)
- [交易分类行业方法论](./txn-classification-industry-methodology.md)
- [地址 LabelBook 审计](./txn-labelbook-review.md)

旧版 Bot/DeFi/CEX 等互相覆盖的 `cat` 口径只为兼容尚未迁移的内部接口保留，不再显示在 Txn 主页面，也不得作为新功能的数据来源。Bot、MEV、三明治、CEX 身份/资金流不占主分类分母；BSC 系统合约交易从开发者流量结构中排除。

核心规则是：**地址身份只证明协议归属，具体业务动作必须有该合约已核实的 method/event 证据。**
