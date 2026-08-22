# 用户套餐与专属号池设计方案

## 1. 背景与目标

Zephyr Hub 当前由管理员统一管理 CPA/Sub2API 上游号池。普通用户只能使用管理员分配的套餐、Hub Key、模型和分组，不能管理上游账号。

本方案在不直接开放 Sub2API 管理端的前提下，由 Hub 为普通用户提供专属号池管理能力，并支持两类服务模式：

- 平台持续提供账号资源的不限量套餐。
- 平台先提供固定 Token 额度，额度耗尽后由用户专属号池接续服务的套餐。

所有用户操作仍通过 Hub 完成。Sub2API 只接受 Hub 服务端使用受信任凭据发起的管理请求，用户浏览器不能直接访问 Sub2API 管理接口，也不能获得 Sub2API 管理 Key、用户 API Key 或其他用户的上游资源标识。

## 2. 产品命名

不建议继续使用“全托管”和“半托管”。“半托管”容易让用户理解为服务不完整，也不能准确表达额度耗尽后的接续行为。

推荐使用以下名称：

| 用户名称 | 内部模式 | 服务规则 |
| --- | --- | --- |
| 畅享版 | `managed_unlimited` | 使用平台号池，不限制套餐 Token |
| 弹性版 | `managed_quota_with_private_pool` | 先使用套餐 Token，耗尽后自动切换用户专属号池 |

弹性版可以继续划分为以下档位：

- 轻量档
- 标准档
- 进阶档
- 定制档

每个档位独立配置价格、结算周期、Token 额度、模型范围、RPM、并发和最大账号数量。

用户界面统一使用“专属号池”表示用户自己的 Sub2API 分组及其中账号，不直接向用户暴露“Sub2API 分组”这一实现概念。

## 3. 领域边界

系统中存在三类不同用途的分组，必须在代码、接口和界面中明确区分：

### 3.1 Hub 权限分组

现有 `groups` 和 `group_memberships`，负责控制：

- Hub Key 所属关系。
- 可用模型和 API 端点。
- 可用 Hub 渠道。
- RPM、并发、请求、Token 和费用限制。

### 3.2 Sub2API 平台分组

由管理员管理，承载平台提供的共享号池。普通用户不可查看、编辑或绑定其中的具体账号。

### 3.3 用户专属号池

底层使用 Sub2API 分组，但所有权和权限由 Hub 本地数据库维护。用户只能通过 Hub 管理自己的专属号池和其中账号。

第一版建议每个用户只拥有一个专属号池。用户可以修改显示名称，但不能删除仍在使用的专属号池，也不能修改 Sub2API 分组的计费倍率、回退组、平台策略等高级配置。

多专属号池可以作为后续能力。届时每个号池需要独立的上游 API Key、路由策略和 Hub Key 绑定，不能只增加一个前端分组列表。

## 4. 套餐模型

现有 `service_plans` 已支持 `unlimited`、`token` 和 `cost`，建议保留额度模式，并增加供给方式与额度耗尽策略。

### 4.1 service_plans 扩展

```text
delivery_mode        managed | hybrid
overflow_policy      reject | private_pool
max_pool_accounts    integer | null
model_scope          jsonb
settings             jsonb
```

推荐组合：

| 套餐 | mode | delivery_mode | overflow_policy |
| --- | --- | --- | --- |
| 畅享版 | `unlimited` | `managed` | `reject` |
| 弹性版 | `token` | `hybrid` | `private_pool` |

### 4.2 订阅快照

当前 `user_subscriptions` 直接引用实时套餐。管理员修改套餐模板时，已经购买的用户权益也会随之变化。建议增加：

```text
entitlement_snapshot jsonb
```

快照至少包含：

```json
{
  "planName": "弹性版标准档",
  "deliveryMode": "hybrid",
  "overflowPolicy": "private_pool",
  "cycle": "month",
  "tokenLimit": 100000000,
  "price": 199,
  "maxPoolAccounts": 5,
  "allowedModels": ["gpt-5.3-codex"]
}
```

套餐续期或更换时生成新快照。历史请求按当时订阅快照结算。

### 4.3 Token 口径

不同模型的输入、输出、缓存和推理 Token 成本不同，不能把所有原始 Token 按 1:1 作为套餐额度，否则高成本模型会显著放大平台风险。

建议用户界面显示“Token 额度”，内部使用标准化 Token：

```text
标准 Token = 输入 Token * 输入系数
           + 输出 Token * 输出系数
           + 缓存 Token * 缓存系数
           + 推理 Token * 推理系数
```

系数根据模型价格表计算并写入请求结算快照。若第一版只开放成本接近的 Codex 模型，也必须固定模型范围，不能让套餐自动继承未来新增的高成本模型。

## 5. 数据模型

### 5.1 user_pool_groups

记录 Hub 用户与 Sub2API 专属分组、普通用户和 API Key 的对应关系。

```text
id                          uuid primary key
owner_user_id               uuid not null
connection_id               text not null default 'sub2api'
upstream_group_id           bigint not null
upstream_user_id            bigint not null
encrypted_upstream_api_key  text not null
encryption_key_version      text not null
display_name                text not null
status                      active | disabled | provisioning | error
last_reconciled_at          timestamptz
last_error                  text
created_by                  uuid
created_at                  timestamptz
updated_at                  timestamptz
```

约束：

- 第一版对 `owner_user_id` 建唯一索引。
- 对 `(connection_id, upstream_group_id)` 建唯一索引。
- 对 `(connection_id, upstream_user_id)` 建唯一索引。
- API Key 使用独立加密上下文，列表和审计中不能返回明文。

### 5.2 user_pool_accounts

记录用户专属号池中账号的本地所有权和上游映射。

```text
id                    uuid primary key
owner_user_id         uuid not null
pool_group_id         uuid not null
account_vault_id      uuid null
upstream_account_id   bigint not null
platform              text not null
account_type          text not null
display_name          text not null
email                 text
status                text not null
schedulable           boolean not null
source                oauth | pat | import | admin
last_verified_at      timestamptz
last_error             text
created_by             uuid
created_at             timestamptz
updated_at             timestamptz
removed_at             timestamptz
```

约束：

- 对 `(connection_id, upstream_account_id)` 或对应等价字段建唯一索引。
- 对 `(owner_user_id, pool_group_id)` 建索引。
- 活动账号必须属于活动的 `user_pool_groups`。
- 上游账号不得同时映射到两个 Hub 用户。

### 5.3 请求供给来源

给 `request_logs` 增加：

```text
supply_source     platform | private_pool
pool_group_id     uuid null
subscription_id   uuid null
```

`usage_rollups` 同样需要按 `supply_source` 聚合，或者增加独立的套餐用量台账。必须能够分别回答：

- 本周期套餐额度使用了多少。
- 用户专属号池承接了多少请求和 Token。
- 当前请求最终使用平台资源还是用户资源。

## 6. Sub2API 自动配置

弹性版用户首次启用专属号池时，Hub 使用 Sub2API Admin API 自动执行：

1. 创建或关联一个 Sub2API 普通用户。
2. 创建一个用户专属 Sub2API 分组。
3. 为该普通用户创建专属分组订阅。
4. 创建绑定该分组的 Sub2API API Key。
5. 将分组、用户和 API Key 映射加密写入 `user_pool_groups`。
6. 执行一次只读对账和连通性验证。

专属 API Key 只由 Hub 网关使用。用户调用的仍然是 Hub Key，用户不需要知道 Sub2API 的存在。

如果上游创建成功而本地事务失败，操作进入 `reconciliation_required`，禁止重新盲目创建。后台按上游用户、分组名称和操作幂等键执行对账。

## 7. 用户添加账号

普通用户可以通过以下方式添加账号：

- OpenAI OAuth 授权。
- Codex PAT 或受支持的凭据导入。
- 管理员代为添加并转交到用户专属号池。

Hub 服务端必须强制覆盖创建参数：

```json
{
  "group_ids": ["当前用户唯一的上游分组 ID"],
  "extra": {
    "codex_cli_only": true,
    "codex_fingerprint_mode": "session"
  }
}
```

不能信任浏览器传入的 `groupIds`、`group_ids`、用户 ID、倍率、回退组或任意 `extra`。

用户可操作字段：

- 账号显示名称。
- OAuth/PAT/凭据导入。
- 启用、停用、重新授权、验活和删除。
- 管理员允许范围内的并发数。
- 管理员提供的代理选项，或者完全由平台自动选择代理。

用户不可操作字段：

- 上游分组 ID 和账号所有者。
- 计费倍率、优先级上限、回退分组和分组策略。
- 全局代理凭据和其他用户代理。
- 任意未列入白名单的 Sub2API `extra` 字段。
- 其他用户账号的查看、编辑、验活或删除。

## 8. 行级权限

普通用户接口统一放在 `/api/console/pool/**`，不能复用并直接放开 `/api/admin/upstreams/**`。

建议接口：

```text
GET    /api/console/pool
PATCH  /api/console/pool

GET    /api/console/pool/accounts
POST   /api/console/pool/accounts
GET    /api/console/pool/accounts/:id
PATCH  /api/console/pool/accounts/:id
DELETE /api/console/pool/accounts/:id
POST   /api/console/pool/accounts/:id/verify

POST   /api/console/pool/oauth/start
POST   /api/console/pool/oauth/complete
```

每一个服务方法必须：

1. 从服务端会话读取当前 `userId`。
2. 以 `(localId, ownerUserId)` 查询本地资源。
3. 从本地记录解析允许访问的上游 ID。
4. 使用 Hub 保存的 Admin Key 调用 Sub2API。
5. 对结果脱敏后返回用户。

禁止接受请求体中的 `ownerUserId`。禁止只根据上游账号 ID 查询后再判断所有权。禁止先获取全部上游账号再由浏览器过滤。

## 9. 网关路由

### 9.1 畅享版

```text
Hub Key 请求
  -> 验证套餐与 Hub 限额
  -> 使用平台渠道和平台 Sub2API API Key
  -> supply_source = platform
```

畅享版不因用户存在专属号池而自动使用用户账号。

### 9.2 弹性版

```text
Hub Key 请求
  -> 验证套餐有效期、模型、RPM、并发和单请求保护
  -> 预留本次请求的标准 Token
  -> 套餐额度足够：使用平台渠道
  -> 套餐额度不足：使用用户专属 Sub2API API Key
  -> 记录 supply_source
```

现有 `hub-limits.ts` 在套餐额度不足时直接返回错误。改造后应把套餐额度判断拆成“供给来源决策”和“通用限额校验”：

- Hub Key、分组 RPM、并发和单请求限制始终执行。
- 平台套餐额度只在 `supply_source=platform` 时扣减。
- `supply_source=private_pool` 时不再扣减平台套餐额度，但仍记录完整请求用量。
- 套餐耗尽且专属号池没有可用账号时，返回明确错误码 `private_pool_unavailable`。

流式请求开始后不能切换供给来源。若单次请求实际 Token 超过预留值，允许该请求产生有限越界，并从下一次请求开始切换，不能在流中途截断或换号池。

平台号池故障时默认不自动消耗用户专属账号。后续可以增加独立的“平台异常时允许专属号池接管”开关，且必须由用户主动开启。

## 10. 动态上游凭据

当前 Hub `channels` 中的 API Key 是全局渠道凭据。专属号池需要按请求用户动态选择 Sub2API API Key。

不建议为每个用户复制完整的 `channels` 和 `channel_models`。推荐在路由候选中引入凭据覆盖：

```ts
interface RouteCandidate {
  channel: Channel
  upstreamModel: string
  credentialSource: 'channel' | 'user_pool'
  encryptedCredentialRef?: string
  supplySource: 'platform' | 'private_pool'
}
```

平台请求使用 `channels.encryptedApiKey`。专属号池请求使用 `user_pool_groups.encrypted_upstream_api_key`，但继续复用 Sub2API 渠道的 Base URL、模型映射、超时和健康配置。

这样不会随着用户数量增长产生大量重复渠道，也能继续复用现有模型同步和健康检查。

## 11. 用户控制台

### 11.1 导航

用户控制台增加“专属号池”：

```text
/console/pool
```

### 11.2 用户首页

首页增加套餐和号池汇总。

套餐区域显示：

- 当前版本与档位。
- 套餐周期、开始和到期时间。
- Token 总量、已使用量、剩余量和进度。
- 当前供给来源：平台额度或专属号池。
- 距离重置时间。
- 额度低于 20% 时的提醒。

专属号池区域显示：

- 账号总数、可用数、异常数和停用数。
- 是否已具备额度耗尽后的接续能力。
- 账号综合健康状态。
- 最近一次验证时间和最近错误。
- “添加账号”和“管理号池”操作。

当额度耗尽但没有可用专属账号时，首页显示阻断状态，并直接提供添加账号入口。

### 11.3 专属号池页面

账号列表建议显示：

- 账号名称和邮箱。
- OpenAI 套餐类型。
- 5 小时和 7 天额度。
- 可调度状态。
- 当前并发。
- 最后验证时间。
- 脱敏错误信息。

用户可执行：

- 添加账号。
- 重新授权。
- 验活。
- 启用或停用。
- 修改显示名称。
- 删除账号。

## 12. 管理端

管理端套餐页面增加：

- 服务模式：畅享版或弹性版。
- 弹性档位、Token 数量和周期。
- 专属号池最大账号数。
- 是否允许用户添加账号。
- 用户可选模型和最大并发。
- 额度耗尽策略。

用户详情增加：

- 当前订阅快照。
- 平台额度和专属号池用量拆分。
- 专属 Sub2API 用户、分组和 API Key 配置状态。
- 专属账号列表和健康状态。
- 强制对账、停用号池和管理员代添加操作。

## 13. 安全要求

- Sub2API Admin Key 只能存在于 Hub 服务端运行配置。
- 用户专属 Sub2API API Key 必须加密保存。
- OAuth Token、Refresh Token、PAT 和原始导入内容不能进入普通日志或审计详情。
- 列表接口不返回可复用凭据。
- 用户删除账号前必须验证本地所有权。
- 用户账号创建和删除需要幂等键。
- OAuth state 必须绑定 Hub 用户、专属号池和发起会话。
- 所有写操作记录 Hub 用户、专属号池、本地账号 ID、上游账号 ID、结果和请求 ID。
- 上游返回错误必须经过敏感信息脱敏。
- 对添加账号、验活、OAuth start/complete 和删除操作分别限流。
- 达到套餐账号数上限后，服务端拒绝继续创建。

## 14. 对账与异常恢复

需要定时执行专属号池对账：

- 本地活动账号是否仍存在于 Sub2API。
- 上游账号是否仍只属于该用户的专属分组。
- 专属 API Key 是否仍绑定正确分组。
- Sub2API 用户订阅是否有效。
- 是否出现未映射到本地所有者的上游账号。

发现跨组或所有权漂移时应立即停止相关账号调度并告警，不能自动把未知账号分配给某个用户。

上游存在、本地不存在的资源进入“待认领/待对账”；本地存在、上游不存在的资源标记为 `missing`，不直接删除历史记录。

## 15. 实施阶段

### 第一阶段：套餐与数据基础

- 扩展 `service_plans`。
- 增加订阅权益快照。
- 新增 `user_pool_groups` 和 `user_pool_accounts`。
- 给请求日志和用量聚合增加供给来源。
- 完成数据库迁移和服务层单元测试。

### 第二阶段：专属号池配置

- 实现 Sub2API 用户、分组、订阅和 API Key 自动配置。
- 实现账号创建、验活、启停、重新授权和删除。
- 实现幂等与异常对账。
- 强制账号默认开启 `codex_cli_only` 和 `codex_fingerprint_mode=session`。

### 第三阶段：用户控制台

- 增加 `/console/pool`。
- 增加首页套餐和号池汇总。
- 增加额度预警、无账号阻断和账号异常状态。
- 完成移动端和桌面端交互测试。

### 第四阶段：网关接续

- 拆分通用限额校验和套餐供给来源决策。
- 增加用户级动态上游凭据。
- 实现平台额度到专属号池的自动切换。
- 按供给来源记录日志、用量和成本。
- 验证流式请求、幂等请求和故障转移边界。

### 第五阶段：迁移与上线

- 为现有用户补充订阅快照。
- 畅享版用户保持当前平台号池行为。
- 弹性版用户按需配置专属号池，不自动创建无用上游资源。
- 灰度启用弹性接续。
- 监控平台/专属号池请求比例、失败率、额度边界和对账异常。

## 16. 验收标准

1. 畅享版用户继续使用平台号池，不受弹性版逻辑影响。
2. 弹性版用户在套餐额度内只使用平台号池。
3. 套餐额度耗尽后，新请求自动使用当前用户的专属号池。
4. 用户没有可用专属账号时返回明确错误，不消耗其他用户或平台资源。
5. 用户只能查看和操作自己的专属号池与账号。
6. 用户不能通过伪造上游 ID、分组 ID 或所有者 ID 越权。
7. 用户添加的账号只能属于自己的 Sub2API 分组。
8. 新建 OpenAI OAuth 账号默认启用“仅允许 Codex 官方客户端”和“设备+会话”指纹收敛。
9. 平台用量与专属号池用量可以独立查询和展示。
10. 流式请求不会在响应过程中切换供给来源。
11. 上游部分成功、本地失败的操作可以通过对账恢复，不产生重复账号。
12. 管理员可以查看、停用和对账任意用户专属号池，但普通用户不能访问管理员接口。

## 17. 当前代码改造入口

主要涉及：

- `server/db/schema.ts`：套餐、订阅、专属号池、账号映射和用量来源。
- `server/services/customer-management.ts`：套餐规则和订阅快照。
- `server/services/hub-limits.ts`：套餐额度判断与供给来源决策。
- `server/services/hub-routing.ts`：平台/专属号池候选和动态凭据。
- `server/services/hub-gateway.ts`：请求来源锁定、转发、用量和日志。
- `server/services/sub2api-admin.ts`：Sub2API 用户、订阅、API Key、分组和账号管理适配。
- `server/api/console/pool/**`：普通用户专属号池 API。
- `app/pages/console/index.vue`：套餐和号池首页汇总。
- `app/pages/console/pool.vue`：专属号池管理页面。
- `app/pages/admin/plans.vue`：服务模式和档位配置。
- `app/pages/admin/users.vue`：用户订阅、专属号池和对账状态。

实现时应继续保留现有 `/api/admin/upstreams/**` 作为管理员运维接口，不向普通用户开放。
