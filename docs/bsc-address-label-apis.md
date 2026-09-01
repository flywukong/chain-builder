# BSC 地址标签 API(bsc-trace-bk / SPACE ID / four.meme)

> 整理自内部共享文档(verified 2026-08-31,production)· chain 56
> 三个上游回答同一个问题:给一个地址,它叫什么;其中 Label backend 还支持反查(按标签/实体列地址)。

## 三个上游对比

| 上游 | 提供什么 | 鉴权 | 限流 |
|---|---|---|---|
| **Label backend**(bsc-trace-bk) | labels、tags、实体角色、风险、creator/部署信息、token 元数据;**双向可查** | 无 | 无,仅批量上限 20 地址/次 |
| **SPACE ID**(经 MegaNode) | `.bnb` 域名 | MegaNode API key(拼在路径里) | 账号 CU 配额 + CUPS 上限,单次消耗未公布 |
| **four.meme**(space.id 托管) | `.four` 域名 | 无 | 每 IP 5 req/s,整个 `/fourmeme` 面共享,超限裸 429 |

## 环境配置

```bash
# Label backend 生产环境(注意:同服务存在非生产部署,tag 少且地址数据为空,务必用这个 host)
export LABEL_CLOUD_API_URL="https://bsc-mainnet-bsc-trace-bk-admin.nodereal.link"
# MegaNode key(MegaNode 控制台,BSC app)
export MEGANODE_API_KEY="<meganode-api-key>"
```

## 1. 地址 → 标签(Label backend)

```bash
curl -s "$LABEL_CLOUD_API_URL/api/v1/label-cloud/address-relations?address=0x86bb…"
# 批量,最多 20;有一个地址格式错整批 400
curl -s "$LABEL_CLOUD_API_URL/api/v1/label-cloud/address-relations-batch?addresses=0xaaa…,0xbbb…"
```

响应要点:

- 当前 label 取 `data.address.data.labels[]` 里 **`update_time` 最大**的一条(后端保留标签历史,不能取 `labels[0]`);
- 同级字段:`data.address_tags[].tag.name`、`data.address_entity_roles[]`(实体 + 角色)、`data.address_risks[]`;
- `create_info`(creator + 部署时间)和 `token_meta`(name/symbol/decimals/token_type)**只有这两个正查端点返回**,反查列表端点不带;
- 批量结果用 `query_address` 包装;嵌套行的主键可能序列化成 `ID` 而不是 `id`;
- 查不到的地址返回全零占位(`address: 0x000…0, data: null`),不是 404。

## 2. 地址 → `.bnb` 域名(SPACE ID / MegaNode)

```bash
# 反解:地址 → 域名(返回不带 .bnb 后缀)
curl -s -X POST "https://open-platform.nodereal.io/$MEGANODE_API_KEY/spaceid/domain/names/byBinds" \
  -H 'Content-Type: application/json' -d '["0x8d73a36d78e2ae4a437053c9ce3be70d483ab74d"]'
# → {"0x8d73…":["win","ape","void"]}

# 正解:域名 → 地址(域名不带后缀)
curl -s -X POST "https://open-platform.nodereal.io/$MEGANODE_API_KEY/spaceid/domain/binds/byNames" \
  -H 'Content-Type: application/json' -d '["win"]'
# → {"win":{"bind":"0x8d73…","name":"win","expires":"…"}}
```

超 CUPS 上限:body 里错误码 `-32005`;超月度 CU 配额:HTTP 429 `"ran out of cu"`。

## 3. 地址 → `.four` 域名(four.meme)

```bash
curl -s -X POST "https://spaceapi.prd.space.id/fourmeme/domain/batch" \
  -H 'Content-Type: application/json' \
  -d '{"caAddresses":["0x86bb…","0x8894…"]}'
# → {"code":0,"data":["tst.four",""],"msg":"success"}  与输入同序,无名为 ""

# 正解:域名 → 地址
curl -s "https://spaceapi.prd.space.id/fourmeme/domain?domain=tst"
# → {"code":0,"data":{"caAddress":"0x86Bb…","isExist":true},"msg":"success"}
```

限流按**请求数**不按地址数——一次 POST 100 个地址没问题,所以永远批量。响应头 `x-ratelimit-limit: 5`、`x-ratelimit-reset` = 当前时间 +1s;429 不带 `Retry-After`。

## 4. 标签 → 地址(反查,Label backend)

先从目录拿 id,再列地址。三个列表端点都要求 `type`:`1`=EOA,`2`=合约,`3`=Token。

```bash
# 目录:tag / entity / entity_role 的 id 与名称
curl -s "$LABEL_CLOUD_API_URL/api/v1/label-cloud/tags"                  # [{id, name, type, …}]
curl -s "$LABEL_CLOUD_API_URL/api/v1/label-cloud/entities"              # [{entity, entity_roles[]}]
curl -s "$LABEL_CLOUD_API_URL/api/v1/label-cloud/tag-address-stats"     # 每 tag 地址数
curl -s "$LABEL_CLOUD_API_URL/api/v1/label-cloud/entity-address-stats"

# 按 tag(tag_id / tag_name 二选一;tag_name 精确匹配)
curl -s "$LABEL_CLOUD_API_URL/api/v1/label-cloud/addresses-by-tag?type=1&tag_id=6"
curl -s -G "$LABEL_CLOUD_API_URL/api/v1/label-cloud/addresses-by-tag" \
  --data-urlencode "type=1" --data-urlencode "tag_name=Pancakeswap"

# 按 entity / entity role
curl -s "$LABEL_CLOUD_API_URL/api/v1/label-cloud/addresses-by-entity?type=1&entity_id=1"
curl -s "$LABEL_CLOUD_API_URL/api/v1/label-cloud/addresses-by-entity-role?type=1&entity_id=1&entity_role_id=1"
```

反查要点:

- 响应 `{"data":[{address,type,data}],"total":N}`,`total` 就是 `len(data)`——**没有 COUNT、没有分页**,要自己翻页;
- 主结果集按 id 倒序 **cap 1000 行**,之后从镜像表追加同 tag/entity 的高价值地址——大 tag 永远是"1000 + 若干";
- 未知 id → 404 `{"error":"tag not found"}`;`type` 缺失/非法 → 400;`tag_id` 和 `tag_name` 同时给 → 400;
- 只给 `entity_id` 列该实体全部角色,加 `entity_role_id` 缩到单一角色。

## 集成注意事项

- 域名解析可以缓存一天(注册变化很少);label 响应与**不可变的** creator / token 元数据分开缓存(后者对已部署地址永不变化);
- **绝不把错误当"无标签"负缓存**:两个域名 API 的失败长得和空结果一样(`""` / `{}`),把 429 风暴当"该地址无名"缓存一整个 TTL 是最常见的坑。查询失败时保留旧值;调用配额按"每次 resolve"而不是"每个地址"控制——100 行的页面对每个上游只该花 1 次请求。

## 附:bsc-monitor 实测校准(2026-08-31)

- 知名协议合约命中好(PancakeRouter 返回完整 label/entity/tags,dune 同步源);
- 高频**无名**新合约命中率 ~5%(40 抽 2);Binance 主力热钱包、USDT、48club 支付地址正查全空;
- binance entity 反查仅 31 个 EOA,与 BscScan 热钱包体系错位(Hot 8 等主力全缺);
- 因此在 bsc-monitor 中定位为**补充证据源**:AI labeler 候选证据 + 热门合约榜补名(`backend/src/txn/labelCloud.js`),不参与统计维度;CEX 反查结果输出为人工审计清单(`docs/label-cloud-cex-candidates.md`,632 地址)。
