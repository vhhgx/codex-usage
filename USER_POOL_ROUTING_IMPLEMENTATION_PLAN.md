# 用户套餐、专属号池与多上游路由实施方案

## 1. 文档定位

本文档是 Zephyr Hub 下一阶段功能开发的实施依据，整合并确认以下产品需求：

- 用户只操作 Hub，不直接访问 Sub2API 管理端。
- 平台公共号池继续由管理员统一管理。
- 每个需要专属号池的 Hub 用户，在 Sub2API 中拥有一个独立普通用户、一个独立专属分组和一个独立 API Key。
- 弹性套餐在套餐 Token 额度内使用平台资源，额度耗尽后自动使用该用户的专属号池。
- 支持不限量套餐、Token 套餐包和按 Token 实际用量计费。
- 套餐权益和价格使用不可变快照，修改模板不影响其他已订阅用户。
- Hub 支持接入其他 OpenAI 兼容中转站点，并由管理员控制优先级、权重和故障转移。
- 用户专属账号只能进入自己的 Sub2API 分组，其他用户不可见、不可修改、不可调度。

上一版 `USER_PRIVATE_POOL_AND_PLAN_DESIGN.md` 保留为讨论记录。本文档中的决策作为后续实现基准。

## 2. 最终架构决策

### 2.1 Key 和分组关系

系统同时存在三种 Key：

| Key | 用途 | 持有者 |
| --- | --- | --- |
| Hub Key | 用户调用 Zephyr Hub | Hub 用户 |
| Sub2API 推理 API Key | Hub 调用某个 Sub2API 分组 | 仅 Hub 服务端 |
| Sub2API Admin Key | Hub 创建和管理 Sub2API 用户、分组、订阅、Key 和账号 | 仅 Hub 服务端 |

平台公共号池保留一个或多个平台级 Sub2API API Key。每个启用专属号池的 Hub 用户另外拥有一个用户级 Sub2API API Key。

```text
平台公共流量
  -> 平台 Sub Key
  -> 平台 Sub 分组
  -> 平台公共账号

用户 A 专属流量
  -> 用户 A Sub Key
  -> 用户 A 专属 Sub 分组
  -> 用户 A 自有账号

用户 B 专属流量
  -> 用户 B Sub Key
  -> 用户 B 专属 Sub 分组
  -> 用户 B 自有账号
```

### 2.2 不动态修改 Sub Key 的分组

“根据套餐切换分组”由 Hub 选择本次请求使用的平台 Key 或用户 Key 来实现，不在请求期间修改 Sub2API API Key 的 `group_id`。

禁止使用以下实现：

```text
套餐未耗尽 -> 把用户 Sub Key 改绑平台分组
套餐耗尽   -> 再把同一 Sub Key 改绑专属分组
```

这种实现存在以下问题：

- 同一用户并发请求可能在 Key 改绑前后进入不同分组。
- Sub2API 的认证缓存和调度缓存可能短时间保留旧分组。
- 切换失败会产生无法确认的中间状态。
- 多实例 Hub 无法保证所有节点同时看到同一个绑定。

正确实现：

```text
Hub 先决定 supply_source
  -> platform: 使用平台渠道原有凭据
  -> private_pool: 使用用户专属 Sub Key
```

用户专属 Sub Key 创建后永久绑定该用户的专属分组。除管理员执行专门的修复或迁移外，不修改绑定关系。

### 2.3 Hub Key 不直接一对一绑定 Sub Key

Hub Key 继续通过 `owner_user_id` 归属用户。一个用户可以拥有多个 Hub Key，这些 Hub Key 默认共享该用户的套餐和专属号池。

```text
Hub Key 1 --\
Hub Key 2 ----> Hub user_id -> user_pool_group -> 用户 Sub Key
Hub Key 3 --/
```

第一版不需要在每个 Hub Key 上保存 Sub Key ID。以后支持一个用户拥有多个专属号池时，再给 Hub Key 增加可选 `pool_group_id`。

## 3. Sub2API 中的专属号池标识

Sub2API 当前的账号和分组没有 Hub `owner_user_id`。因此所有权以 Hub 数据库为唯一事实来源，Sub2API 只负责执行分组隔离和调度。

### 3.1 每个专属号池包含的 Sub2API 资源

Hub 为每个专属号池创建：

1. 一个 Sub2API 普通用户。
2. 一个 `subscription` 类型的 Sub2API 分组。
3. 一条该普通用户对专属分组的有效订阅。
4. 一个属于该普通用户且绑定专属分组的 Sub2API API Key。
5. 零个或多个只属于该分组的上游账号。

### 3.2 Sub2API 内部名称

Sub2API 分组名称使用不可变、无个人信息的内部标识：

```text
zh_pool_<pool_id 前 12 位>
```

示例：

```text
zh_pool_a81f7c920c4e
```

规则：

- 不使用用户名、邮箱或显示名称。
- Hub 用户修改号池名称时只修改本地 `display_name`。
- Sub 内部名称保持不变，用于人工排障和对账。
- Sub 分组说明写入 `Managed by Zephyr Hub; pool=<Hub pool UUID>`。
- Hub 本地保存真实 `upstream_group_id`，名称只作辅助识别，不能用名称作为授权依据。

### 3.3 分组安全配置

专属 Sub 分组建议使用：

```text
subscription_type = subscription
is_exclusive = true
platform = openai
status = active
rate_multiplier = 1
fallback_group_id = null
fallback_group_id_on_invalid_request = null
```

禁止给专属分组配置平台公共回退组，否则用户专属账号不可用时可能消耗平台资源。

### 3.4 账号分组约束

用户添加的账号必须满足：

```text
account.group_ids = [当前用户 upstream_group_id]
```

不能同时加入平台分组或其他用户分组。Hub 每次创建、更新、启用和对账时都要验证完整分组集合，而不仅验证“包含自己的分组”。

## 4. 套餐产品模型

计费方式和资源供给方式必须拆成两个维度，不能继续用一个 `mode` 同时表达额度和路由。

### 4.1 计费方式 billing_mode

| 值 | 用户含义 | 结算方式 |
| --- | --- | --- |
| `unlimited` | 不限量订阅 | 固定周期价格，不限制套餐 Token |
| `token_package` | Token 套餐包 | 固定价格包含固定数量 Token |
| `token_metered` | 按 Token 计费 | 根据实际使用 Token 和模型单价扣除余额 |

### 4.2 资源供给方式 supply_mode

| 值 | 行为 |
| --- | --- |
| `platform_only` | 只使用平台管理的公共渠道 |
| `platform_then_private` | 套餐额度内使用平台渠道，耗尽后使用专属号池 |
| `private_only` | 始终使用用户自己的专属号池 |

### 4.3 推荐产品组合

| 产品名称 | billing_mode | supply_mode | 说明 |
| --- | --- | --- | --- |
| 畅享版 | `unlimited` | `platform_only` | 平台持续供给，不限制套餐 Token |
| 弹性版轻量档 | `token_package` | `platform_then_private` | 包含少量 Token，耗尽后使用专属号池 |
| 弹性版标准档 | `token_package` | `platform_then_private` | 包含中等 Token，价格和账号上限更高 |
| 弹性版进阶档 | `token_package` | `platform_then_private` | 包含更多 Token、并发和模型 |
| 按量版 | `token_metered` | `platform_only` | 按实际 Token 和模型价格扣费 |
| 自备账号版 | `token_metered` 或独立服务费 | `private_only` | 全程使用用户专属账号 |

“按量版”与“弹性版”不是同一个概念：

- 弹性版解决套餐额度耗尽后由谁提供账号。
- 按量版解决用户按实际 Token 支付多少费用。

二者未来可以组合，但第一版应使用明确的允许组合白名单，避免产生无法解释的计费行为。

## 5. Token 额度与按量计费

### 5.1 Token 套餐包

套餐包需要配置：

```text
token_limit
quota_cycle = week | month
quota_unit = raw_token | weighted_token
allowed_models
price
```

`raw_token` 直接累计输入、输出、缓存和推理 Token 总量，容易理解，但不同模型成本差异较大。

`weighted_token` 按模型和 Token 类型折算：

```text
计费 Token = input_tokens * input_factor
           + output_tokens * output_factor
           + cached_tokens * cached_factor
           + reasoning_tokens * reasoning_factor
```

推荐生产套餐使用 `weighted_token`。若第一版使用 `raw_token`，必须限制套餐可用模型，并在套餐快照中固定模型范围。

### 5.2 按 Token 实际用量计费

按量计费复用现有模型价格表计算金额，但需要新增用户资金账户：

```text
user_wallets
wallet_transactions
```

请求结算流程：

```text
请求进入
  -> 根据 max_tokens、模型和安全系数预估最大费用
  -> 原子冻结用户余额
  -> 请求完成后按实际 Token 计算费用
  -> 扣除实际费用
  -> 释放剩余冻结金额
```

请求失败且未产生上游费用时释放全部冻结。流式请求中断时按已经获得的用量或保守策略结算。

`wallet_transactions` 至少支持：

```text
recharge
hold
settle
release
refund
manual_adjustment
```

资金台账不能直接复用当前面向内部收支的 `ledger_transactions`，否则用户余额与平台财务记录会混在一起。

### 5.3 专属号池用量是否收费

套餐增加：

```text
private_usage_billing = free | metered
private_usage_rate_multiplier
```

推荐弹性版默认：

```text
private_usage_billing = free
```

即套餐额度耗尽后，用户自己购买和维护账号，专属号池请求不继续消耗套餐 Token，只记录用量。若以后需要收取网关服务费，可以设为 `metered` 并配置较低倍率。

## 6. 套餐版本与权益快照

### 6.1 套餐模板和版本

建议把套餐身份和套餐内容拆开：

```text
service_plans
  id
  name
  status
  current_version_id

service_plan_versions
  id
  plan_id
  version
  billing_mode
  supply_mode
  cycle
  token_limit
  quota_unit
  price
  max_pool_accounts
  private_usage_billing
  private_usage_rate_multiplier
  allowed_models
  settings
  created_at
  created_by
```

`service_plan_versions` 创建后不可修改。管理员编辑套餐时创建新版本，并把 `service_plans.current_version_id` 指向新版本。

### 6.2 用户订阅快照

`user_subscriptions` 增加：

```text
plan_version_id
entitlement_snapshot jsonb
starts_at
expires_at
```

`entitlement_snapshot` 是用户当前周期的最终权益，包含套餐版本和管理员对该用户的个性化调整。

管理员修改套餐模板：

- 只影响以后新分配或续期的用户。
- 不自动修改已生效订阅。

管理员修改单个用户：

- 只为该用户生成新的订阅权益快照。
- 不修改套餐模板。
- 不影响其他用户。

续期时默认使用套餐当前版本，但管理端必须展示版本差异并允许继续沿用旧版本。

### 6.3 请求计费快照

每条请求保存：

```text
subscription_id
plan_version_id
supply_source
billing_mode
quota_unit
billable_tokens
billed_amount
pricing_snapshot jsonb
```

修改模型价格后，历史请求仍按当时 `pricing_snapshot` 展示和审计。

## 7. Hub 本地数据模型

### 7.1 user_pool_groups

```text
id                          uuid primary key
owner_user_id               uuid not null unique
connection_id               text not null default 'sub2api'
upstream_user_id            bigint not null
upstream_group_id           bigint not null
upstream_api_key_id         bigint not null
encrypted_upstream_api_key  text not null
encryption_key_version      text not null
internal_name               text not null
display_name                text not null
status                      provisioning | active | disabled | error
max_accounts                integer
last_reconciled_at          timestamptz
last_error                  text
created_by                  uuid
created_at                  timestamptz
updated_at                  timestamptz
```

唯一约束：

- `owner_user_id`
- `(connection_id, upstream_user_id)`
- `(connection_id, upstream_group_id)`
- `(connection_id, upstream_api_key_id)`

### 7.2 user_pool_accounts

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

对 `(pool_group_id, upstream_account_id)` 建唯一约束，对 `(owner_user_id, status)` 建索引。

### 7.3 user_wallets

```text
id
user_id unique
currency
available_balance
held_balance
version
created_at
updated_at
```

金额使用数据库 `numeric` 或整数最小货币单位，禁止使用浮点数。`version` 用于乐观锁，余额冻结和结算还需要数据库事务或原子 SQL。

### 7.4 wallet_transactions

```text
id
wallet_id
request_id
type
amount
balance_before
balance_after
idempotency_key
note
created_by
created_at
```

对 `(wallet_id, idempotency_key)` 建唯一约束。

### 7.5 request_logs 和 usage_rollups

增加：

```text
supply_source       platform | private_pool | user_relay
pool_group_id       uuid null
subscription_id     uuid null
plan_version_id     uuid null
billable_tokens     bigint
billed_amount       numeric
pricing_snapshot    jsonb
```

`usage_rollups` 按 `supply_source` 分开聚合，用户首页才能分别显示平台套餐用量和专属号池承接量。

## 8. 其他中转站点

### 8.1 平台管理的中转站

当前 Hub `channels` 已有 Base URL、加密 API Key、优先级、权重、并发和超时，但渠道类型只支持 CPA 和 Sub2API。

增加：

```text
channel_type = openai_compatible
```

每个站点配置：

- 名称和 Base URL。
- 加密 API Key。
- 模型发现策略。
- Hub 模型到上游模型的映射。
- 支持的 API 端点。
- 优先级、权重、最大并发和超时。
- 健康检查、熔断和错误透传规则。
- 可服务的套餐和 Hub 权限分组。

示例：

```text
优先级 10  中转站 A
优先级 20  平台 Sub2API
优先级 30  CPA
```

优先级数值越小越先尝试。相同优先级按权重轮询，失败后按候选顺序故障转移。

### 8.2 用户自有中转站

如果后续允许用户添加自己的其他中转站，必须作为私有上游资源管理，不能直接写入全局 `channels` 并对所有用户可见。

建议新增：

```text
user_upstream_sources
  id
  owner_user_id
  type = openai_compatible
  base_url
  encrypted_api_key
  priority
  weight
  status
  model_mappings
```

第一阶段建议只实现管理员添加的平台中转站。用户自有中转站作为第二阶段能力，复用专属资源的行级权限模型。

## 9. 路由域与优先级

所有候选上游必须先按供给来源分域，再在域内按优先级选择。

### 9.1 平台域

可包含：

- 平台 Sub2API。
- CPA。
- 管理员添加的其他 OpenAI 兼容中转站。

### 9.2 用户私有域

可包含：

- 用户专属 Sub2API Key。
- 后续支持的用户自有中转站。

### 9.3 禁止跨域隐式故障转移

平台渠道故障时默认不能自动消耗用户专属账号。用户专属账号故障时也不能自动使用其他用户资源。

如果以后提供“平台异常时允许专属号池接管”，必须作为用户可见的独立选项，并记录触发原因和供给来源。

## 10. 供给来源决策

新增 `selectSupplySource`，在获取候选渠道之前执行。

### 10.1 畅享版

```text
billing_mode = unlimited
supply_mode = platform_only
-> supply_source = platform
```

### 10.2 弹性版

```text
billing_mode = token_package
supply_mode = platform_then_private

套餐额度足够
  -> 原子预留套餐 Token
  -> supply_source = platform

套餐额度不足
  -> 检查专属号池是否活动且存在可调度账号
  -> supply_source = private_pool

专属号池不可用
  -> 返回 private_pool_unavailable
```

### 10.3 按量版

```text
billing_mode = token_metered
-> 原子冻结钱包余额
-> 按 supply_mode 选择平台或私有域
```

### 10.4 原子额度预留

并发请求不能先查询余额再分别扣减。套餐 Token 预留使用 Redis Lua 或数据库原子更新：

```text
remaining >= estimated_tokens
  -> reserved += estimated_tokens
  -> platform

remaining < estimated_tokens
  -> 不预留
  -> private_pool
```

请求结束后用实际 Token 结算并释放差额。若实际值高于预留值，允许当前请求有限越界，下一个请求再切换专属号池。

## 11. 用户专属账号添加流程

### 11.1 管理员给弹性用户添加账号

1. 管理员给用户分配弹性套餐档位。
2. Hub 检查该用户是否已有 `user_pool_groups`。
3. 没有则自动创建 Sub 普通用户、专属分组、订阅和专属 API Key。
4. 管理员在用户详情选择“添加专属账号”。
5. Hub 发起 OAuth、PAT 或凭据导入流程，并把 state 绑定到目标 Hub 用户和 `pool_group_id`。
6. Hub 创建 Sub2API 账号时强制覆盖 `group_ids`。
7. Hub 强制写入 Codex 安全默认值。
8. 创建成功后写入 `user_pool_accounts`。
9. Hub 执行账号验活，并根据结果决定是否开启调度。
10. 用户原有 Hub Key 自动具备额度耗尽后的接续能力，不需要重新生成 Key。

强制创建参数：

```json
{
  "group_ids": ["该用户唯一的 upstream_group_id"],
  "extra": {
    "codex_cli_only": true,
    "codex_fingerprint_mode": "session"
  }
}
```

### 11.2 用户自己添加账号

用户在 `/console/pool` 执行相同流程，但 Hub 从当前登录会话确定 `owner_user_id`。接口不接受前端指定用户或 Sub 分组。

用户可操作：

- 添加、重新授权和删除账号。
- 修改显示名称。
- 验活、启用和停用。
- 查看套餐类型、5 小时/7 天额度和脱敏错误。

用户不可操作：

- 上游分组 ID。
- Sub 用户和 Sub API Key。
- 账号倍率和高级 `extra`。
- 平台公共分组和其他用户分组。
- 其他用户账号或代理凭据。

## 12. 弹性版运行时示例

假设用户 A 购买“弹性版标准档”，每月包含 100M 计费 Token，并已添加两个自有账号。

### 12.1 套餐额度内

```text
客户端用 Hub Key 发请求
  -> Hub 识别 user A
  -> 订阅快照剩余 30M Token
  -> 预留本次 Token
  -> 进入 platform 路由域
  -> 按优先级选择中转 A / 平台 Sub / CPA
  -> 记录 supply_source=platform
```

### 12.2 套餐额度耗尽

```text
客户端继续使用同一个 Hub Key
  -> Hub 识别 user A
  -> 套餐 Token 不足
  -> 查找 user A 的 user_pool_groups
  -> 解密 user A 的 Sub API Key
  -> 请求 Sub2API
  -> Sub API Key 绑定 user A 专属分组
  -> Sub 只在 user A 的两个账号中调度
  -> 记录 supply_source=private_pool
```

### 12.3 新周期开始

```text
新套餐周期生效
  -> 创建新的订阅权益周期和额度计数
  -> 下一次请求重新进入 platform 路由域
  -> 用户专属账号继续保留，但暂不消耗
```

切换全过程不修改用户 Hub Key，不修改 Sub Key 的分组，也不要求客户端更改 Base URL。

## 13. 服务端 API

### 13.1 用户专属号池

```text
GET    /api/console/pool
PATCH  /api/console/pool

GET    /api/console/pool/accounts
POST   /api/console/pool/accounts/import
GET    /api/console/pool/accounts/:id
PATCH  /api/console/pool/accounts/:id
DELETE /api/console/pool/accounts/:id
POST   /api/console/pool/accounts/:id/verify

POST   /api/console/pool/oauth/start
POST   /api/console/pool/oauth/complete
```

### 13.2 管理员代管

```text
GET    /api/admin/users/:id/pool
POST   /api/admin/users/:id/pool/provision
POST   /api/admin/users/:id/pool/reconcile
POST   /api/admin/users/:id/pool/accounts/import
POST   /api/admin/users/:id/pool/oauth/start
POST   /api/admin/users/:id/pool/oauth/complete
```

### 13.3 套餐和钱包

```text
GET    /api/admin/plans
POST   /api/admin/plans
POST   /api/admin/plans/:id/versions
POST   /api/admin/plans/assign

GET    /api/console/plan
GET    /api/console/wallet
GET    /api/console/wallet/transactions
```

## 14. 行级权限要求

每一个普通用户服务方法必须：

1. 从服务端会话读取 `userId`。
2. 使用 `(localResourceId, ownerUserId)` 查询本地记录。
3. 通过本地记录取得真实上游 ID。
4. 调用 Sub2API Admin API。
5. 对返回结果脱敏。

禁止：

- 接受请求体中的 `ownerUserId`。
- 接受用户提交的 `upstreamGroupId`。
- 只按上游账号 ID 查询后再检查归属。
- 获取全部 Sub 账号并在浏览器过滤。
- 把 Sub API Key 返回给用户。

## 15. 前端页面

### 15.1 管理端套餐

`/admin/plans` 增加：

- 计费方式。
- 资源供给方式。
- 套餐周期和 Token 数量。
- Token 口径。
- 套餐价格。
- 专属号池最大账号数。
- 专属用量是否计费和倍率。
- 允许模型、RPM 和并发。
- 当前版本和历史版本。

### 15.2 管理端用户详情

增加：

- 当前套餐版本和用户权益快照。
- 平台额度使用量和剩余量。
- 专属号池配置状态。
- Sub 用户、分组和 API Key 的脱敏状态。
- 专属账号列表、健康状态和额度。
- 添加账号、强制对账、停用号池和单用户权益调整。

### 15.3 用户首页

显示：

- 当前套餐和档位。
- Token 总量、已用、剩余和重置时间。
- 当前资源来源。
- 专属账号总数、可用数、异常数。
- 套餐额度低于 20% 的准备提醒。
- 套餐耗尽且专属号池不可用时的阻断提示。

### 15.4 用户专属号池

新增 `/console/pool`：

- OAuth、PAT 和凭据导入。
- 账号名称、邮箱、套餐类型。
- 5 小时和 7 天额度。
- 调度状态和最后验证时间。
- 启用、停用、验活、重新授权和删除。

## 16. 网关改造点

### 16.1 hub-limits.ts

把当前“套餐耗尽立即拒绝”拆成：

- 通用 Hub Key、权限分组、RPM、并发和单请求保护。
- 套餐额度预留。
- 钱包余额冻结。
- `SupplyDecision` 返回值。

```ts
interface SupplyDecision {
  source: 'platform' | 'private_pool' | 'user_relay'
  subscriptionId: string
  planVersionId: string
  reservedTokens: number
  walletHoldId?: string
  poolGroupId?: string
}
```

### 16.2 hub-routing.ts

先接收 `SupplyDecision`，再从对应路由域生成候选：

```ts
interface RouteCandidate {
  channel: Channel
  upstreamModel: string
  supplySource: 'platform' | 'private_pool' | 'user_relay'
  credentialSource: 'channel' | 'user_pool' | 'user_relay'
  credentialRef?: string
}
```

用户专属 Sub 请求复用平台 Sub2API 渠道的 Base URL、模型映射、超时和健康配置，只覆盖认证凭据。

### 16.3 hub-gateway.ts

- 请求开始时锁定 `SupplyDecision`。
- 流式响应中途不能改变供给来源。
- 故障转移只能在当前路由域内进行。
- 使用候选指定的凭据，而不是始终读取 `channel.encryptedApiKey`。
- 完成后结算套餐 Token 或钱包金额。
- 请求日志和聚合写入供给来源与计费快照。

### 16.4 sub2api-admin.ts

补充以下管理适配：

- 创建、查询和停用 Sub 普通用户。
- 创建 Sub 分组。
- 创建和续期用户订阅。
- 创建、查询、轮换和停用 Sub API Key。
- 校验 API Key 当前绑定分组。
- 对账账号的完整分组集合。

## 17. 安全与一致性

- 用户专属 Sub Key 使用独立加密上下文和版本化加密密钥。
- OAuth state 绑定 Hub 用户、专属号池、发起会话和过期时间。
- 上游管理操作使用幂等键。
- 上游成功、本地失败时进入 `reconciliation_required`。
- 账号分组漂移时立即停止调度并告警。
- 专属分组不得配置公共回退分组。
- 所有凭据从日志、审计详情和错误信息中脱敏。
- 删除用户前必须明确处理专属账号、Sub API Key、订阅和分组。
- 钱包冻结、结算和退款必须幂等。

## 18. 实施阶段

### 第一阶段：套餐版本与基础数据

- 增加 `service_plan_versions`。
- 扩展 `user_subscriptions` 权益快照。
- 增加 `user_pool_groups` 和 `user_pool_accounts`。
- 给请求日志和聚合增加供给来源。
- 补充数据库迁移与单元测试。

### 第二阶段：专属号池生命周期

- 实现 Sub 普通用户、分组、订阅和 API Key 自动创建。
- 实现用户专属账号添加、验活、启停、删除和重新授权。
- 实现管理员代添加。
- 实现所有权对账和异常恢复。

### 第三阶段：Token 套餐与自动接续

- 实现套餐 Token 原子预留和结算。
- 实现 `SupplyDecision`。
- 实现平台凭据与用户专属凭据切换。
- 实现跨周期恢复平台资源。
- 实现供给来源用量拆分。

### 第四阶段：按 Token 计费

- 增加用户钱包和资金流水。
- 实现费用预估、冻结、实际结算、释放和退款。
- 增加价格快照和账单查询。

### 第五阶段：其他中转站

- 增加 `openai_compatible` 渠道。
- 实现模型发现、模型映射、端点能力和健康检查。
- 接入现有优先级、权重、熔断和故障转移。
- 第二阶段再考虑用户自有中转站。

### 第六阶段：控制台与灰度

- 完成管理端套餐版本、用户专属号池和对账界面。
- 完成用户首页和 `/console/pool`。
- 对现有用户生成初始订阅快照。
- 灰度启用弹性接续和按量计费。

## 19. 测试与验收

### 19.1 权限隔离

- 用户 A 无法列出、读取、修改、验活或删除用户 B 的账号。
- 伪造 Hub 本地 ID、Sub 上游 ID、分组 ID 和 OAuth state 均不能越权。
- 用户添加的账号最终完整分组集合只能包含自己的专属分组。

### 19.2 套餐切换

- 弹性套餐额度内只使用平台凭据。
- 额度耗尽后只使用当前用户的 Sub Key。
- 新周期开始后自动恢复平台凭据。
- 并发请求跨越额度边界时不会超量进入平台域或串入其他用户号池。
- 流式请求不会在响应过程中切换来源。

### 19.3 计费

- 套餐模板新版本不影响已有用户快照。
- 单用户权益调整不影响其他用户。
- 按量请求的冻结、结算、释放和退款金额一致。
- 重试和幂等重放不会重复扣费。
- 历史请求使用历史价格快照展示。

### 19.4 多上游

- 平台域按优先级和权重选择中转。
- 渠道故障只在同一域内故障转移。
- 平台渠道故障不会默认消耗用户专属账号。
- 用户专属账号故障不会使用其他用户资源。

### 19.5 专属账号默认值

新建 OpenAI OAuth 账号必须默认并强制：

```text
codex_cli_only = true
codex_fingerprint_mode = session
```

客户端即使提交相反字段，服务端仍按套餐和安全策略覆盖。

## 20. 当前主要代码入口

- `server/db/schema.ts`
- `server/services/customer-management.ts`
- `server/services/hub-limits.ts`
- `server/services/hub-routing.ts`
- `server/services/hub-gateway.ts`
- `server/services/sub2api-admin.ts`
- `server/services/upstream-connections.ts`
- `server/services/upstream-input.ts`
- `server/api/console/pool/**`
- `server/api/admin/users/:id/pool/**`
- `app/pages/admin/plans.vue`
- `app/pages/admin/users.vue`
- `app/pages/console/index.vue`
- `app/pages/console/pool.vue`
- `shared/types/accounting.ts`
- `shared/types/upstream-management.ts`

开发时继续保留现有 `/api/admin/upstreams/**` 作为管理员全局上游运维接口，不向普通用户开放。
