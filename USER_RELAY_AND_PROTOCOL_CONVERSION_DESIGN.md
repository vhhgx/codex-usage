# 管理员共享中转、用户私有中转与 Claude Code 协议转换方案

## 1. 文档定位

本文档定义 Zephyr Hub 中转资源与协议转换能力的目标架构，作为后续数据库迁移、服务端路由、管理端和用户端开发的实施依据。

需要解决的产品需求：

- 管理员可以添加平台管理的第三方中转。
- 管理员可以把中转开放给全部用户，也可以只开放给指定用户或指定权限分组。
- 普通用户可以添加自己的中转，但该中转只能被本人拥有的 Hub Key 使用。
- 用户保存在 Hub 的上游 API Key 只供 Hub 服务端使用，不能返回给浏览器或 Claude Code。
- Claude Code 只配置 Zephyr Hub 的 URL、Hub Key 和模型名，即可访问有权限的中转。
- Hub 同时支持 Anthropic 协议透传和 Anthropic/OpenAI 协议转换。
- 私有中转不能因为故障转移、模型重名、伪造资源 ID 或错误授权而被其他用户调用。

本文中的“中转”是面向用户的产品名称；服务端继续使用现有 `channels` 作为统一上游资源实体，避免重复实现模型发现、优先级、权重、健康检查、熔断、并发控制和请求日志。

## 2. 核心结论

### 2.1 资源类型、访问范围和协议能力必须分开

“谁能使用这个上游”和“上游支持哪些协议”是独立维度，不能继续只依赖 `channel.type` 表达，也不能让用户在“Claude Code / Codex”之间二选一。

Claude Code 和 Codex 是客户端。真正需要保存的是上游接口协议：

```text
anthropic_messages  Anthropic Messages / Claude Code 原生协议
openai_responses    OpenAI Responses / Codex 首选协议
openai_chat         OpenAI Chat Completions 兼容协议
```

一个站点可以同时勾选多种协议。例如同时支持 `/v1/messages` 和 `/v1/responses` 的站点只创建一个渠道，在该渠道下保存两个协议绑定。

每个渠道保存所有权和访问范围：

```text
owner_kind         platform | user
owner_user_id      uuid null
access_scope       all | restricted | private
```

协议、认证方式、版本和可选 Base URL 覆盖保存在一对多的 `channel_protocol_bindings`，而不是渠道上的单选字段。

约束：

| 所有者 | access_scope | 可用对象 |
| --- | --- | --- |
| 管理员/平台 | `all` | 所有满足套餐、分组和模型规则的用户 |
| 管理员/平台 | `restricted` | 指定用户与指定权限分组的并集 |
| 普通用户 | `private` | 仅 `owner_user_id` 对应用户 |

普通用户不能把自己的中转改成 `all` 或 `restricted`，也不能为私有中转创建共享授权。

### 2.2 Claude Code 使用 Hub Key，不使用上游 Key

正确链路：

```text
Claude Code
  -> Zephyr Hub URL + Hub Key + Hub 模型名
  -> Hub Key 确认 user_id 和权限分组
  -> Hub 选择该用户有权使用的渠道
  -> Hub 解密所选渠道的上游 API Key
  -> 必要时执行协议转换
  -> 调用第三方中转
```

禁止把用户保存的上游 API Key 重新展示在 Claude Code 配置中。否则 Hub 无法统一执行权限、限额、日志、吊销和密钥轮换。

### 2.3 协议转换使用统一内部表示

不能在网关主流程里堆叠 Anthropic 与 OpenAI 字段判断。请求先解析成统一内部表示，再由出站适配器生成目标协议；响应和 SSE 流反向转换。

这里需要区分两种情况：

- 用户添加的上游已经兼容 Anthropic Messages/Claude Code：执行受控透传，只改写认证、模型和安全请求头，不做有损语义转换。
- 用户添加的上游只兼容 OpenAI Chat Completions：把 Claude Code 的 Anthropic Messages 请求和响应转换为 OpenAI 协议。
- 用户使用 Codex 且上游支持 OpenAI Responses：优先直接使用 Responses，不转换到 Chat Completions。

直连协议的优先级始终高于转换协议。只有直连协议不存在或被明确停用，且转换能力已经验收通过时，才进入协议转换候选。

```text
Anthropic 请求
  -> Anthropic 入站适配器
  -> Canonical Request
  -> 路由与权限
  -> OpenAI 或 Anthropic 出站适配器
  -> 上游

上游响应/SSE
  -> 对应协议入站解析器
  -> Canonical Response/Event
  -> Anthropic 出站适配器
  -> Claude Code
```

### 2.4 路由域默认严格隔离

渠道分为两个供给域：

- `platform`：管理员管理且当前用户有权使用的渠道。
- `user_relay`：当前用户自己添加的中转。

默认禁止跨域隐式故障转移。使用用户私有中转的请求失败时，不能自动消耗平台资源；平台渠道失败时，也不能自动使用用户自费中转。

如以后允许跨域回退，必须由用户在 Hub Key 或路由策略上明确开启，并记录触发原因。

## 3. 当前实现与缺口

当前项目已经具备：

- `channels`、`channel_models` 和 `group_channel_rules`。
- `openai_compatible` 渠道类型。
- Hub Key 到 `owner_user_id` 和 `group_id` 的归属。
- OpenAI `/v1/**` 数据面。
- 模型发现、模型映射、优先级、权重、健康检查、熔断和故障转移。
- `request_logs.supply_source` 中预留的 `user_relay` 值。

当前缺口：

- `channels` 没有所有者和访问范围，所有渠道事实上都是全局资源。
- 没有用户私有中转 CRUD、模型同步、测试和密钥轮换接口。
- `group_channel_rules` 同时承担路由覆盖语义，不适合作为完整的资源授权表。
- 路由没有查询“当前用户可见渠道”的统一入口。
- 只支持 OpenAI 入站协议，不支持 `/v1/messages`。
- 没有 Anthropic 请求、响应、SSE、工具调用和错误格式适配器。
- 日志没有记录入站协议、出站协议和转换方式。

现有 `openai_compatible` 的前端自动模型发现条件也需要补齐，不能只对 `sub2api` 显示同步能力。

## 4. 总体架构

```text
                         +-----------------------+
管理员 ----------------> | 平台渠道 + 访问范围    |
                         +-----------+-----------+
                                     |
用户 ------------------> | 私有中转 owner_user_id |
                         +-----------+-----------+
                                     |
Claude Code / OpenAI SDK             |
            |                        |
            v                        v
   +------------------------------------------------+
   | Zephyr Hub 数据面                              |
   |                                                |
   |  Hub Key 鉴权 -> 端点权限 -> 套餐/限额         |
   |       -> 可见渠道过滤 -> 路由域选择             |
   |       -> 模型映射 -> 协议适配 -> 上游调用       |
   |       -> 响应适配 -> 结算 -> 日志与用量         |
   +----------------------+-------------------------+
                          |
           +--------------+---------------+
           |                              |
    OpenAI 兼容中转                 Anthropic 兼容中转
```

## 5. 数据模型

### 5.1 扩展 channels

为降低迁移风险，第一版不重命名 `channels`，只增加渠道级字段：

```text
owner_kind             platform | user, not null, default platform
owner_user_id          uuid null -> users.id
access_scope           all | restricted | private, not null, default all
created_by             uuid null -> users.id
credential_key_version text null
```

字段含义：

- `type` 保留供应商/实现类型，例如 `cpa`、`sub2api`、`openai_compatible`、`anthropic_compatible`。
- `type` 只表示供应商/实现分类，不能用来推断完整协议能力。
- 渠道上的 `base_url` 和 `encrypted_api_key` 作为各协议绑定的默认连接与默认凭据。

数据库和服务层同时执行以下约束：

```text
owner_kind = platform
  -> owner_user_id is null
  -> access_scope in (all, restricted)

owner_kind = user
  -> owner_user_id is not null
  -> access_scope = private
```

建议使用 PostgreSQL `CHECK` 约束防止应用缺陷写入越权状态。

现有数据迁移默认值：

| 现有 type | owner_kind | access_scope |
| --- | --- | --- |
| `cpa` | `platform` | `all` |
| `sub2api` | `platform` | `all` |
| `openai_compatible` | `platform` | `all` |

迁移完成后再把新字段设为 `NOT NULL`，避免已有渠道在部署期间短暂不可路由。

### 5.2 多协议绑定

新增：

```text
channel_protocol_bindings
  id
  channel_id          -> channels.id on delete cascade
  protocol            anthropic_messages | openai_responses | openai_chat
  enabled             boolean
  base_url_override   text null
  auth_scheme         bearer | x_api_key
  api_version         text null
  adapter_options     jsonb default {}
  verification_status unknown | verified | failed
  verified_at         timestamptz null
  last_error          text null
  created_at
  updated_at
  unique(channel_id, protocol)
```

规则：

- `base_url_override` 为空时使用渠道默认 `base_url`。
- 多个协议通常复用渠道默认凭据；如果同一站点的不同协议必须使用不同 Key，应增加独立凭据引用，不能把第二个 Key 放进 `adapter_options`。
- `auth_scheme` 只允许结构化选项，不允许普通用户输入任意请求头名称。
- `api_version` 主要用于 Anthropic 的 `anthropic-version`，由系统提供安全默认值。
- `adapter_options` 只能保存经过服务端 schema 校验的非敏感适配参数。

客户端兼容性由协议绑定和模型能力推导：

| 上游协议 | Claude Code | Codex |
| --- | --- | --- |
| `anthropic_messages` | 原生直连 | 后续可转换，不作为第一版承诺 |
| `openai_responses` | 适配器验收后可转换 | 原生直连 |
| `openai_chat` | 可转换，需流式工具测试通过 | 后续可转换，不作为第一版首选 |

因此页面可以显示“可用于 Claude Code / 可用于 Codex”，但这两个状态是计算结果，不是数据库中的互斥协议字段。

现有渠道迁移时，根据 `channel_models.endpoints` 创建对应 OpenAI 协议绑定。端点为空的旧数据需要先创建兼容绑定，再通过影子检测确认实际支持范围，不能仅凭 `/v1/models` 成功就断言 Responses 和 Chat 都可用。

### 5.3 平台渠道授权表

不要复用 `group_channel_rules` 作为可见性授权。新增独立授权表，使“是否可用”和“路由参数覆盖”保持独立。

```text
channel_user_grants
  id
  channel_id       -> channels.id on delete cascade
  user_id          -> users.id on delete cascade
  created_by       -> users.id
  created_at
  unique(channel_id, user_id)

channel_group_grants
  id
  channel_id       -> channels.id on delete cascade
  group_id         -> groups.id on delete cascade
  created_by       -> users.id
  created_at
  unique(channel_id, group_id)
```

当平台渠道为 `restricted` 时，满足任一条件即可进入可见集合：

```text
channel_user_grants.user_id = 当前 user_id
OR
channel_group_grants.group_id IN 当前用户有效权限分组
```

授权只决定候选资格。已有 `group_channel_rules` 继续决定某个权限分组中的启停、优先级覆盖和权重覆盖。

### 5.4 模型映射

继续使用 `channel_models` 保存 Hub 公共模型名。新增协议级模型绑定，允许同一站点在不同协议下使用不同上游模型名：

```text
channel_model_bindings
  id
  channel_model_id     -> channel_models.id on delete cascade
  protocol_binding_id  -> channel_protocol_bindings.id on delete cascade
  upstream_model       text
  capabilities         jsonb default {}
  enabled              boolean
  unique(channel_model_id, protocol_binding_id)
```

建议的能力结构：

```json
{
  "streaming": true,
  "tools": true,
  "vision": false,
  "thinking": false,
  "promptCaching": false,
  "inputProtocols": ["anthropic"],
  "outputProtocols": ["anthropic", "openai"]
}
```

现有 `channel_models.upstream_model` 在迁移期作为默认值，完成协议级绑定迁移后再决定是否移除。`endpoints` 增加：

```text
/v1/messages
/v1/messages/count_tokens
```

模型公开名称必须在当前用户的可见命名空间中可确定地解析。推荐默认生成带来源的名称：

```text
relay/<source-slug>/<model-alias>
```

例如：

```text
relay/my-claude/claude-sonnet
```

平台可以继续发布简短公共模型名。用户私有中转默认使用带来源名称，避免它与平台模型或另一个私有中转重名。

### 5.5 Hub Key 渠道约束

给 `hub_keys` 增加：

```text
route_mode platform_only | private_only | platform_then_private | private_then_platform
```

现有 Hub Key 全部迁移为 `platform_only`。用户从“我的中转”配置生成器创建或绑定私有中转时，默认使用 `private_only`。

新增关联表：

```text
key_channel_rules
  key_id       -> hub_keys.id on delete cascade
  channel_id   -> channels.id on delete cascade
  created_at
  unique(key_id, channel_id)
```

用途：

- 用户可创建一个专门供 Claude Code 使用的 Hub Key。
- 该 Key 可以绑定一个或多个本人可用渠道。
- 路由时先应用可见性，再应用 Key 渠道约束。
- 绑定关系不能扩大权限；管理员撤销渠道授权后，Key 绑定立即失效。

如果 Key 没有任何 `key_channel_rules`，按正常可见渠道集合路由。如果存在规则，只能在规则与可见集合的交集中路由。

### 5.6 请求日志

扩展 `request_logs` 和需要的聚合维度：

```text
inbound_protocol      openai | anthropic
outbound_protocol     openai | anthropic
conversion_mode       passthrough | anthropic_to_openai | openai_to_anthropic
protocol_binding_id   uuid null
source_owner_kind     platform | user
source_owner_user_id  uuid null
cache_read_tokens     bigint default 0
cache_creation_tokens bigint default 0
cache_affinity_reused boolean default false
```

现有字段继续使用：

```text
channel_id
supply_source = platform | private_pool | user_relay
requested_model
upstream_model
```

日志只保存转换摘要，不能保存上游 API Key、Hub Key、完整认证头或未脱敏的第三方错误正文。

## 6. 权限模型

### 6.1 管理端

管理员创建渠道时必须选择：

- 全部用户可用。
- 仅指定权限分组可用。
- 仅指定用户可用。
- 指定权限分组与用户的并集可用。

管理员可以查看所有渠道的状态和使用量，但默认不能在界面中查看已保存的完整上游 Key。管理员只能替换或轮换凭据。

### 6.2 用户端

普通用户只能：

- 列出 `owner_user_id = 当前用户` 的私有中转。
- 创建、编辑、测试、停用和删除自己的中转。
- 同步自己中转的模型。
- 为自己的 Hub Key 绑定本人可见渠道。
- 查看自己请求产生的日志和用量。

所有用户资源查询必须同时带所有权条件：

```sql
WHERE channel.id = :channel_id
  AND channel.owner_kind = 'user'
  AND channel.owner_user_id = :authenticated_user_id
```

不能先按 ID 查询后在内存里判断所有权，也不能接受请求正文中的 `owner_user_id`。

### 6.3 数据面

数据面只信任 Hub Key 解析出的：

```text
key_id
user_id
group_id
```

客户端可以提交模型名，但不能提交可信的 `owner_user_id`、`channel_id` 或 `supply_source`。即使未来允许显式选择来源，也只能把来源 ID 当筛选条件，随后重新执行可见性校验。

## 7. 渠道可见性与路由

### 7.1 可见渠道集合

为所有模型列表和请求路由提供同一个服务函数：

```ts
interface ChannelAccessContext {
  userId: string
  groupId: string
  keyId: string
}

async function listEligibleChannels(
  event: H3Event,
  context: ChannelAccessContext,
  model: string,
  endpoint: string
): Promise<RouteCandidate[]>
```

候选必须依次通过：

1. 渠道已启用且健康。
2. 当前用户满足 `access_scope`。
3. Hub Key 渠道规则允许。
4. 权限分组渠道规则允许。
5. 模型映射与端点能力匹配。
6. 存在已启用的协议级模型绑定。
7. 入站协议可以由该绑定直连或经过已启用的适配器转换。
8. 协议绑定和渠道均未熔断且没有达到最大并发。
9. 当前请求选择的供给域与渠道所有者一致。

`GET /v1/models` 和以后提供的 Anthropic 模型列表必须调用同一套资格判断，不能显示实际不可调用的模型。

### 7.2 路由域

```text
owner_kind = platform -> supply_source = platform
owner_kind = user     -> supply_source = user_relay
```

用户私有中转推荐使用专用 Hub Key，并把该 Key 的默认路由模式设为 `private_only`。

可选的 Key 级路由模式：

```text
platform_only
private_only
platform_then_private
private_then_platform
```

第一版只实现 `platform_only` 和 `private_only`。后两种跨域模式等计费和用户确认交互明确后再开放。

### 7.3 优先级与故障转移

候选先按协议质量排序，再在同一域内应用现有优先级规则：

```text
原生直连且命中缓存亲和
  -> 原生直连
  -> 协议转换且命中缓存亲和
  -> 协议转换
```

同一协议质量层级内：

- 优先级数值越小越先尝试。
- 相同优先级按权重选择。
- 连接失败、超时、`429` 和可重试 `5xx` 可以在响应开始前切换。
- SSE 第一个客户端事件发出后禁止切换来源。
- Anthropic 工具调用流同样不能把两个上游响应拼接到一次消息中。

如果一个站点同时支持 Anthropic Messages 和 OpenAI Responses，Claude Code 请求选择 Anthropic 绑定，Codex 请求选择 Responses 绑定。不能为了统一实现而强制两者都绕到 Chat Completions。

## 8. 数据面 URL 与 Claude Code 配置

### 8.1 端点规划

现有 OpenAI 数据面保持不变：

```text
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
...
```

新增独立 Anthropic 数据面，避免 `/v1/messages` 与现有 OpenAI 错误格式、鉴权头和监控维度混淆：

```text
POST /anthropic/v1/messages
POST /anthropic/v1/messages/count_tokens   第二阶段
GET  /anthropic/v1/models                  Hub 扩展，可选
```

因此 Claude Code 的 Base URL 为：

```text
https://hub.example.com/anthropic
```

Claude Code 会在 Base URL 后请求 `/v1/messages`。

### 8.2 认证兼容

Anthropic 数据面同时接受以下一种认证方式：

```http
Authorization: Bearer zh-hub-key
```

或：

```http
x-api-key: zh-hub-key
```

两者同时存在但值不一致时返回 `401`，避免认证歧义。解析后仍然使用现有 Hub Key 凭据表、状态、到期时间和所有权校验。

### 8.3 Claude Code 配置示例

建议由用户控制台根据所选 Hub Key 和模型自动生成配置。示例：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://hub.example.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "zh-your-hub-key",
    "ANTHROPIC_MODEL": "relay/my-claude/claude-sonnet"
  }
}
```

不同 Claude Code 版本对模型环境变量和认证变量的支持可能变化，发布前必须用目标版本执行真实 CLI 验收。Hub 服务端同时兼容 Bearer 与 `x-api-key`，以降低客户端版本差异的影响。

用户在这里填写的是 Hub Key。用户添加中转时填写的第三方 Key 只保存在 Hub 服务端。

### 8.4 Codex 配置示例

Codex 使用 Responses 原生绑定时，控制台生成 `~/.codex/config.toml` 片段：

```toml
model_provider = "Zephyr"
model = "relay/my-codex/gpt-5"

[model_providers.Zephyr]
name = "Zephyr Hub"
base_url = "https://hub.example.com/v1"
wire_api = "responses"
requires_openai_auth = false
env_key = "ZEPHYR_HUB_KEY"
```

Hub Key 通过独立环境变量提供，避免覆盖用户原有的 OpenAI 凭据：

```bash
export ZEPHYR_HUB_KEY="zh-your-hub-key"
```

这里的 `base_url`、环境变量值和 `model` 都是 Hub 地址、Hub Key 和 Hub 模型名；第三方中转地址、上游 Key 和上游模型名不下发到 Codex。该配置已经使用 Codex CLI `0.144.1` 对 Responses 流式请求完成隔离验收。

## 9. 协议适配器

### 9.1 目录建议

```text
server/services/protocols/
  canonical.ts
  anthropic-request.ts
  anthropic-response.ts
  anthropic-stream.ts
  openai-chat-request.ts
  openai-chat-response.ts
  openai-chat-stream.ts
  errors.ts
  capabilities.ts
```

网关主流程只处理：

- 鉴权和访问上下文。
- 请求大小与内容类型限制。
- Canonical Request。
- 路由和候选。
- 调用选定适配器。
- 额度、日志和归档。

### 9.2 统一请求结构

建议的核心结构：

```ts
type CanonicalContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data?: string; url?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: CanonicalContentBlock[]; isError: boolean }
  | { type: 'thinking'; text: string; signature?: string }

interface CanonicalMessage {
  role: 'system' | 'developer' | 'user' | 'assistant'
  content: CanonicalContentBlock[]
}

interface CanonicalRequest {
  inboundProtocol: 'openai' | 'anthropic'
  model: string
  messages: CanonicalMessage[]
  tools: Array<{ name: string; description?: string; inputSchema: unknown }>
  toolChoice?: 'auto' | 'none' | 'required' | { name: string }
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  stopSequences: string[]
  stream: boolean
  metadata: Record<string, unknown>
  extensions: Record<string, unknown>
}
```

`extensions` 只用于保留明确允许的协议扩展。未知字段不能无条件转发给不同协议上游。

### 9.3 Anthropic 到 Anthropic

如果上游本身支持 Anthropic 协议，优先做受控透传：

- 校验请求结构和模型权限。
- 把 Hub 模型名替换为上游模型名。
- 移除客户端 `x-api-key`、`Authorization`、`Host`、转发头和连接头。
- 注入渠道保存的上游 Key。
- 设置允许的 `anthropic-version`。
- `anthropic-beta` 只透传系统白名单中的值。
- 对响应头、错误和请求 ID 做统一处理。

即使是透传，也必须经过鉴权、路由、限额、日志和正文脱敏，不能直接建立无检查反向代理。

### 9.4 Anthropic 到 OpenAI Chat Completions

第一版协议转换的主要方向是：

```text
Claude Code Anthropic Messages
  -> OpenAI Chat Completions 兼容中转
```

主要映射：

| Anthropic | OpenAI Chat Completions |
| --- | --- |
| 顶层 `system` | `system` 或 `developer` message |
| `messages[].role` | 同名 role，必要时规范化 |
| `text` block | 文本 content part |
| `image` block | `image_url` content part，要求上游支持 vision |
| `tools[].input_schema` | `tools[].function.parameters` |
| `tool_choice.auto` | `auto` |
| `tool_choice.any` | `required` |
| 指定 tool name | 指定 function name |
| `tool_use` | assistant `tool_calls` |
| `tool_result` | `tool` message |
| `max_tokens` | `max_tokens` 或渠道能力指定字段 |
| `stop_sequences` | `stop` |
| `temperature`、`top_p` | 同名字段 |

不能可靠转换的字段必须按渠道能力处理：

- 上游不支持图片：返回 Anthropic `invalid_request_error`，不能静默删除图片。
- 上游不支持工具：带 tools 的请求直接拒绝。
- `top_k` 无对应字段时不转发，并在转换摘要中记录；如该字段被调用方标记为必需则拒绝。
- 扩展思考、签名 thinking block 和 prompt caching 只有适配器明确支持时才启用。
- 不能伪造 prompt cache 命中或 thinking 签名。

### 9.5 OpenAI 到 Anthropic

反向转换可以复用 Canonical Request，但建议放到后续阶段：

```text
OpenAI SDK / Codex
  -> Zephyr OpenAI 数据面
  -> Anthropic Messages 上游
```

原因：OpenAI Responses、Chat Completions 与 Anthropic Messages 在工具调用、推理内容、图片和流事件上并非完全对称。第一版先满足 Claude Code 入站，避免同时扩大两个方向的测试矩阵。

## 10. SSE 流式转换

Claude Code 对事件顺序敏感，不能只替换 SSE 的 `data` 字段名称。需要实现有状态转换器。

Anthropic 输出事件序列：

```text
message_start
content_block_start
content_block_delta (text_delta | input_json_delta | thinking_delta)
content_block_stop
message_delta
message_stop
```

OpenAI Chat 流转换要求：

1. 收到首个有效 chunk 后生成 `message_start`。
2. 首次文本 delta 前生成文本 `content_block_start`。
3. 文本增量转换为 `text_delta`。
4. 每个 `tool_call.index` 对应一个稳定的 Anthropic content block index。
5. 工具参数字符串增量转换为 `input_json_delta.partial_json`。
6. finish reason 到达时关闭所有活动 block。
7. 转换 stop reason 和 usage，发出 `message_delta`。
8. 最后发出唯一一次 `message_stop`。

停止原因建议映射：

| OpenAI finish_reason | Anthropic stop_reason |
| --- | --- |
| `stop` | `end_turn` |
| `length` | `max_tokens` |
| `tool_calls` | `tool_use` |
| `content_filter` | `refusal` 或规范化错误 |

流解析器必须支持：

- 一个 JSON 事件被拆到多个 TCP chunk。
- 一个 TCP chunk 中包含多个 SSE 事件。
- `\r\n` 与 `\n`。
- 注释行和空行。
- `[DONE]`。
- 工具参数 JSON 被任意切分。
- 客户端中断时立即取消上游请求并释放并发租约。

流开始后如果转换失败，返回 Anthropic `error` SSE 事件并结束连接，不能改发普通 JSON 响应，也不能切换到另一个渠道。

## 11. 缓存策略

### 11.1 缓存目标

这里的首要目标是提高第三方模型供应商的提示词/前缀缓存命中率，而不是让 Hub 缓存生成结果。

缓存分为三层：

| 层级 | 内容 | 策略 |
| --- | --- | --- |
| 上游提示词缓存 | system、工具定义和稳定消息前缀 | 主要优化目标 |
| Hub 缓存亲和 | 相同会话/前缀持续路由到同一上游 | Redis 短期绑定或一致性哈希 |
| Hub 元数据缓存 | 模型列表、授权版本、健康和能力 | 短 TTL + 主动失效 |

通用生成结果缓存默认关闭，原因包括：

- 生成结果可能具有随机性。
- Claude Code 和 Codex 请求包含工具调用及可能产生副作用的上下文。
- 不同用户提示词可能包含敏感数据。
- 流式响应、用量、请求 ID 和上游状态不能安全地简单复用。

现有非流式 `Idempotency-Key` 重放继续保留，但它用于同一请求的安全重试，不等同于跨请求响应缓存。

### 11.2 稳定提示前缀

供应商缓存通常依赖相同模型上的相同长前缀。为了最大化命中：

- system/developer 指令保持在最前面。
- 工具定义紧随稳定系统指令，顺序固定。
- 动态对话内容放在稳定前缀之后。
- 不在 system 或工具定义中注入当前时间、随机 ID、请求 ID、渠道名或可变统计值。
- 不随请求重排工具、JSON Schema 属性或 content block。
- 模型别名到上游模型的映射保持稳定。
- 同一适配器版本必须产生确定性的字段顺序和消息拆分结果。
- 协议直连时不做无意义的反序列化再序列化，尽量保持调用方提供的稳定内容顺序。

协议转换不可避免地改变 wire payload，但转换结果必须确定。相同 Canonical Request 和相同适配器版本应产生字节级稳定的上游 JSON。

### 11.3 缓存亲和路由

当前加权轮询会把连续请求分散到不同渠道或不同凭据，可能显著降低上游缓存命中率。对文本和工具请求增加缓存亲和键：

```text
affinity_key = HMAC(
  affinity_scope
  + inbound_protocol
  + public_model
  + stable_system_hash
  + tools_hash
  + optional_client_session_id
)
```

要求：

- 只保存 HMAC，不把 system、工具定义或原始提示词写入 Redis key。
- 哈希使用独立 Pepper，不能使用上游 API Key。
- 如果客户端提供会话 ID，只能作为亲和输入，不能作为授权依据。
- 没有可靠会话 ID 时，使用租户范围、模型、稳定 system 和工具集合形成亲和键。

`affinity_scope` 支持：

```text
tenant         包含 user_id/key_id，默认值
shared_static  平台渠道可选，只按平台静态前缀聚合
```

用户私有中转始终使用 `tenant`。平台管理员只有在确认 system 和 tools 是平台公共静态内容、且目标供应商的缓存隔离语义经过安全评估后，才能启用 `shared_static`。共享范围不能包含用户对话内容、文件内容或工具结果。

选择顺序：

1. 在当前用户有权使用、同一路由域和同一协议质量层级的候选中查找现有亲和绑定。
2. 绑定仍健康且未达并发上限时继续使用同一 `channel + protocol_binding + credential + upstream_model`。
3. 没有绑定时，使用 weighted rendezvous hashing 在同优先级候选中稳定选一个，同时保留渠道权重语义。
4. 把选择结果写入 Redis，TTL 建议覆盖典型编码会话时长，例如 30 到 120 分钟。
5. 渠道不健康、熔断或过载时选择下一个候选并更新绑定。

亲和维度必须包含：

```text
channel_id
protocol_binding_id
credential_ref
upstream_model
adapter_version
owner_user_id 或平台授权域
```

缓存通常与上游账号、模型和协议实现相关，只固定渠道而切换凭据仍可能导致缓存未命中。

### 11.4 亲和与负载均衡的取舍

缓存亲和不能绕过健康、并发和权限：

- 亲和只在相同优先级候选内优先，不应把请求固定到明显更低优先级的昂贵渠道。
- 达到并发上限时允许临时换节点，接受一次缓存未命中。
- 渠道恢复后不要在当前会话中立即来回切换，等亲和 TTL 到期或显式开启新会话。
- 管理员撤销授权或用户停用私有中转时，相关亲和键立即失效。
- 更新模型映射、协议绑定、凭据或适配器版本时，使对应缓存命名空间版本递增。

私有中转通常只有一个候选，天然具有最高亲和度。平台共享渠道存在多个后端时，缓存亲和带来的收益最大。

### 11.5 Anthropic 缓存语义

Anthropic 协议直连时：

- 保留经过能力校验的 `cache_control` content block 标记。
- 不移动带缓存边界的 system、tools 或 message blocks。
- 只透传允许的 `anthropic-beta` 能力。
- 分别解析并记录 cache creation 和 cache read Token。

Anthropic 转 OpenAI 时，`cache_control` 没有通用的一对一语义。转换器应保留对应内容的稳定顺序，但不能伪造缓存写入或命中；只有目标上游适配器明确支持并经过真实验收的缓存参数才能注入。

### 11.6 OpenAI/Responses 缓存语义

Codex 请求优先走 `openai_responses` 直连，避免转换破坏稳定前缀。对 OpenAI 兼容上游：

- 保持 instructions、tools 和早期 input 内容稳定。
- 使用上游真实返回的 `cached_tokens` 统计命中。
- 上游若支持显式缓存亲和参数，只能由经过版本验证的协议适配器设置稳定、无敏感内容的哈希值。
- 未通过上游规范和真实请求验证时，不发送供应商私有缓存字段。
- 不为了缓存而默认启用供应商侧响应存储或有状态 conversation；这属于独立的数据保留决策。

实现具体 OpenAI 缓存扩展字段前，必须通过当时的 OpenAI 官方文档和目标上游实测再次确认。本方案不把供应商私有或未经版本确认的扩展字段作为核心依赖。

### 11.7 Hub 元数据缓存

可以安全缓存：

- 上游模型发现结果。
- 渠道协议能力和健康摘要。
- 当前可用候选的短期计算结果。
- 模型映射的只读快照。

授权结果不能只依赖长 TTL：

- 渠道、用户、分组和 Key 授权分别维护递增版本号。
- 缓存 key 包含授权版本。
- 停用、删除或撤销授权时先递增版本并删除相关亲和映射。
- 数据面最终仍以数据库或可信版本快照为准。

建议 TTL：

| 数据 | TTL |
| --- | --- |
| 模型列表 | 30 到 120 秒，并支持主动失效 |
| 健康与熔断 | 使用当前 Redis 实时状态 |
| 能力检测 | 5 到 30 分钟，配置变更立即失效 |
| 路由候选快照 | 5 到 30 秒 |
| 缓存亲和 | 30 到 120 分钟 |

### 11.8 缓存指标

至少记录：

```text
cache_read_tokens
cache_creation_tokens
uncached_input_tokens
cache_hit_requests
cache_eligible_requests
affinity_reuse_count
affinity_failover_count
```

核心指标：

```text
Token 缓存命中率 = cache_read_tokens / total_input_tokens
请求缓存命中率 = cache_hit_requests / cache_eligible_requests
亲和保持率 = affinity_reuse_count / 可复用路由请求数
```

按 `channel_id + protocol_binding_id + upstream_model + adapter_version` 观察。只看全站平均值会掩盖某个转换器或某个渠道持续打散缓存的问题。

## 12. 用量与计费

### 12.1 Token 统一

Canonical usage 至少包含：

```ts
interface CanonicalUsage {
  uncachedInputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  reasoningTokens: number
}
```

归一化总输入：

```text
totalInputTokens = uncachedInputTokens
                 + cachedInputTokens
                 + cacheCreationInputTokens
```

不同供应商的 `input_tokens` 是否已经包含缓存 Token 可能不同，必须由协议适配器按该供应商的已验证口径归一化，避免重复相加。只记录上游真实返回或可靠解析出的用量；缺少某个维度时记录 `0` 并标记来源，不能根据响应文本随意伪造精确 Token。

### 12.2 平台渠道

管理员渠道继续执行当前套餐额度、价格倍率、钱包冻结和实际结算规则。

### 12.3 用户私有中转

用户已经自行承担第三方中转费用。建议第一版：

- `supply_source = user_relay`。
- 记录真实 Token 和请求次数。
- 不消耗平台套餐 Token。
- `billed_amount = 0`，除非套餐明确配置网关服务费。
- Hub Key RPM、并发、端点、模型和安全限制仍然生效。

若以后对私有中转收取服务费，必须在套餐版本快照中增加独立的 `user_relay_billing`，不能复用平台模型价格冒充上游成本。

## 13. API 设计

### 13.1 管理端

在现有渠道 API 上扩展：

```text
POST  /api/admin/channels
PATCH /api/admin/channels/:id
POST  /api/admin/channels/:id/test
POST  /api/admin/channels/:id/models/sync
PUT   /api/admin/channels/:id/access
```

`PUT access` 请求示例：

```json
{
  "accessScope": "restricted",
  "userIds": ["user-uuid"],
  "groupIds": ["group-uuid"]
}
```

更新访问范围和授权列表必须在一个数据库事务内完成，并写审计日志。

### 13.2 用户端

新增：

```text
GET    /api/console/relays
POST   /api/console/relays
GET    /api/console/relays/:id
PATCH  /api/console/relays/:id
DELETE /api/console/relays/:id
POST   /api/console/relays/:id/test
POST   /api/console/relays/:id/models/sync
PUT    /api/console/keys/:keyId/channels
```

用户创建接口只接受业务字段：

```json
{
  "name": "我的多协议中转",
  "baseUrl": "https://relay.example.com",
  "apiKey": "upstream-secret",
  "protocols": [
    {
      "protocol": "anthropic_messages",
      "authScheme": "x_api_key"
    },
    {
      "protocol": "openai_responses",
      "authScheme": "bearer"
    }
  ],
  "models": []
}
```

服务端强制写入：

```text
owner_kind = user
owner_user_id = session.user_id
access_scope = private
```

### 13.3 数据面错误格式

OpenAI 路由继续返回 OpenAI 错误格式。Anthropic 路由返回：

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "The selected model does not support tool use"
  },
  "request_id": "req_..."
}
```

建议映射：

| 场景 | HTTP | Anthropic error.type |
| --- | --- | --- |
| Hub Key 缺失或无效 | 401 | `authentication_error` |
| 无渠道/模型权限 | 403 | `permission_error` |
| 请求字段或能力不支持 | 400 | `invalid_request_error` |
| RPM/并发/额度限制 | 429 | `rate_limit_error` |
| 上游不可用 | 502/503 | `api_error` |
| 网关超时 | 504 | `overloaded_error` 或 `api_error` |

不要把第三方响应里的密钥、内部地址或完整 HTML 错误页直接返回客户端。

## 14. 页面设计

### 14.1 管理员资源管理

渠道表增加：

- 所有者：平台或用户名。
- 上游协议：Messages、Responses、Chat，可同时存在。
- 客户端兼容：Claude Code 直连/转换、Codex 直连/转换。
- 可用范围：全部、N 个分组、N 个用户、私有。
- 支持能力：流式、工具、视觉、thinking。
- 来源用量和最近错误。

创建/编辑时增加“可用范围”设置：

- 单选：全部用户 / 部分用户。
- 选择部分用户后显示用户和权限分组选择器。
- 保存前展示最终覆盖用户数量。

协议设置使用多选而不是单选：

```text
[x] Anthropic Messages    Claude Code 原生
[x] OpenAI Responses      Codex 原生
[ ] OpenAI Chat           通用兼容/转换
```

默认提供“自动检测”，但检测结果必须逐项显示为“已验证 / 未验证 / 失败”。`GET /v1/models` 只能证明连接和认证，不能证明 Messages、Responses、流式工具调用都可用。需要发送可能计费的最小能力请求时，界面必须先提示用户。

“Claude Code”和“Codex”可以作为快捷预设：选择 Claude Code 时建议勾选 Messages，选择 Codex 时建议勾选 Responses；它们不能覆盖用户已经选中的其他协议。

管理员查看用户私有中转时可以停用和诊断，但不能把它改成平台共享渠道。需要接管时应执行显式“复制为平台渠道”，生成新渠道和新凭据归属。

### 14.2 用户控制台“我的中转”

新增 `/console/relays`：

- 中转列表、状态、多协议绑定、客户端兼容性、模型数量和最近检测时间。
- 添加中转向导。
- 上游 Key 只在输入时出现，保存后显示掩码。
- 模型同步与手工别名。
- 流式、工具和图片能力检测结果。
- 绑定 Hub Key。
- Claude Code 配置生成器。
- Codex 配置生成器。

配置生成器流程：

1. 选择一个私有中转。
2. 选择或新建一个 Hub Key。
3. 选择已映射模型。
4. 自动把 Key 绑定到该渠道。
5. 生成 Base URL、Hub Key 和模型配置。

## 15. 安全要求

### 15.1 SSRF 防护

普通用户可以提交 Base URL，因此必须增加 SSRF 防护：

- 生产环境默认只允许 HTTPS。
- 禁止 loopback、link-local、组播、保留地址和云元数据地址。
- 私网地址默认禁止；确需私网中转时只允许管理员配置的 CIDR 白名单。
- DNS 解析后检查所有 A/AAAA 地址。
- 每次建立连接前重新校验，防止 DNS rebinding。
- 禁止自动跟随到不安全目标的重定向，建议 `redirect: 'manual'`。
- 限制端口或使用管理员端口白名单。
- Base URL 不能包含用户名、密码、查询串或片段。

### 15.2 凭据

- 每个用户中转使用独立加密上下文，例如 `user-relay:<channel_id>`。
- 保存加密密钥版本，支持轮换。
- API 永远不返回已保存的完整上游 Key。
- 健康检查、错误、审计和请求归档统一脱敏。
- 用户更新 Key 时只允许替换，不能读取旧值。
- 删除渠道时撤销 Key 绑定并清理 Redis 熔断、并发和路由状态。

### 15.3 请求头

入站认证头绝不透传。出站只由渠道配置生成：

```text
OpenAI bearer    -> Authorization: Bearer <upstream-key>
Anthropic key    -> x-api-key: <upstream-key>
Anthropic version -> anthropic-version: <configured-version>
```

普通用户第一版不能配置任意自定义请求头或 Header 模板。该能力会显著扩大凭据泄漏和请求走私风险。

### 15.4 配额滥用

- 套餐配置私有中转数量上限。
- 限制每个中转的模型数量。
- 模型发现最多保存固定数量的模型。
- 健康检查采用队列和全局并发限制。
- 不周期性发送会产生费用的推理请求。
- 无 `/v1/models` 的上游使用被动健康状态加用户手动测试。

## 16. 健康检查与能力检测

健康与能力分开：

- 健康检查回答“当前是否可以连接和认证”。
- 能力检测回答“是否支持流式、工具、图片、thinking 等特性”。
- 协议验证回答“Messages、Responses、Chat 中的哪一个端点真实可用”。

建议策略：

| 上游 | 主动检查 |
| --- | --- |
| OpenAI 兼容 | `GET /v1/models` |
| 提供模型接口的 Anthropic 兼容站 | 对应模型列表接口 |
| 不提供无费用检查接口的站点 | 被动健康 + 用户手动最小请求 |

健康状态按渠道记录，协议验证和能力状态按 `channel_protocol_bindings` 及模型绑定记录。一个站点的 Responses 失败不能把仍然正常的 Anthropic Messages 一并标记为不可用。

能力检测结果只能作为提示和路由过滤依据。管理员或用户可以手工修正错误检测，但每次变更要写审计记录。

## 17. 实施阶段

### 第一阶段：统一资源所有权和授权

- 扩展 `channels` 所有者、访问范围、协议和认证字段。
- 新增多协议绑定与协议级模型能力。
- 新增用户授权、分组授权和 Key 渠道规则表。
- 把现有渠道迁移为 `platform + all`。
- 实现统一 `listEligibleChannels`。
- 管理端增加全部/部分用户设置。
- 修复 `openai_compatible` 自动模型发现前后端条件。

完成标准：现有用户行为不变，管理员可以限制某个平台渠道只服务指定用户或分组。

### 第二阶段：用户私有中转

- 新增 `/api/console/relays/**`。
- 增加“我的中转”页面。
- 实现 SSRF 防护、独立加密上下文和所有权测试。
- 支持用户私有多协议中转和逐协议验证。
- 实现 `private_only` Hub Key 渠道路由。
- 用量按 `user_relay` 独立记录。

完成标准：用户 A 的任何请求、资源 ID 或模型名都不能访问用户 B 的中转。

### 第三阶段：Anthropic 协议透传

- 新增 `/anthropic/v1/messages`。
- Hub Key 支持 Bearer 与 `x-api-key` 入站认证。
- 实现 Anthropic 请求校验、模型映射、认证头替换和错误格式。
- 实现 Anthropic SSE 受控透传。
- 用户界面生成 Claude Code 配置。

完成标准：Claude Code 可以通过 Hub 调用用户添加的 Anthropic 兼容中转，包括流式文本和工具调用。

### 第四阶段：Anthropic 到 OpenAI 转换

- 实现 Canonical Request/Response/Event。
- 转换 system、messages、tools、tool choice 和 stop reason。
- 实现 OpenAI Chat SSE 到 Anthropic SSE 的状态机。
- 增加能力矩阵和不支持能力的明确错误。
- 实现缓存亲和键、rendezvous hashing 和亲和失效。

完成标准：Claude Code 可以通过 Anthropic 数据面调用用户有权使用的 OpenAI Chat 兼容中转，文本与工具调用均正确。

### 第五阶段：扩展能力

- `/v1/messages/count_tokens`。
- 图片、prompt caching 和 thinking 的能力协商。
- OpenAI 到 Anthropic 反向转换。
- 明确计费后的跨域回退策略。
- 根据目标上游官方规范启用经过验证的供应商缓存扩展参数。

## 18. 测试计划

### 18.1 权限矩阵

- 平台 `all` 渠道对所有有效用户可见。
- 平台 `restricted` 渠道只对授权用户或授权分组成员可见。
- 撤销授权后，已有 Hub Key 绑定立即失效。
- 用户 A 不能列出、读取、编辑、测试、同步或删除用户 B 的中转。
- 用户 A 不能通过伪造 channel ID、模型名或 Key 绑定访问用户 B 中转。
- 管理员渠道不会被错误记为 `user_relay`。
- 用户私有中转不会被平台请求隐式选中。

### 18.2 协议固定样例

为每种转换保存输入和期望输出 fixture：

- 普通文本。
- 多轮消息与 system。
- 多 content block。
- 单个与并行工具调用。
- tool result 和 tool error。
- stop sequence。
- 非流式 usage。
- 图片支持与不支持。
- thinking 支持与不支持。
- 各类上游错误。

### 18.3 SSE

- 每个可能字节位置的 chunk 切分测试。
- 多事件合并在一个 chunk。
- 文本和工具调用交错。
- 多个并行 tool call index。
- 工具 JSON 参数任意切分。
- 上游正常结束、异常结束和无 `[DONE]`。
- 客户端主动断开。
- 首事件后不故障转移。

### 18.4 缓存与亲和

- 相同稳定前缀生成相同亲和键。
- 动态消息变化但 system/tools 不变时保持同一亲和路由。
- 不同用户、模型、凭据、协议和适配器版本不会错误共享亲和键。
- 同一站点的 Messages 与 Responses 不会混用缓存亲和。
- 渠道过载时安全回退并统计亲和失效。
- 授权撤销、凭据轮换和模型映射更新立即失效。
- 直连协议优先于转换协议。
- `cache_read_tokens` 和 `cache_creation_tokens` 能从非流式及 SSE usage 正确解析。

### 18.5 安全

- IPv4/IPv6 loopback、私网、link-local 和云元数据地址均被拒绝。
- DNS rebinding 和重定向到私网被拒绝。
- 入站 Hub Key 不出现在上游请求、日志或归档。
- 上游 Key 不出现在客户端响应、日志或审计详情。
- 两种认证头冲突时拒绝请求。
- 非法 `anthropic-beta` 不透传。

### 18.6 E2E

至少启动三个模拟上游：

- Anthropic Messages 兼容上游。
- OpenAI Chat Completions 兼容上游。
- OpenAI Responses 兼容上游。

使用真实 Claude Code 版本验证：

1. 非流式文本。
2. 流式文本。
3. 文件读取等工具调用。
4. 多轮工具结果回传。
5. 模型无权限。
6. Hub Key 停用和轮换。
7. 私有中转与平台渠道隔离。
8. 使用 Codex 对 Responses 绑定执行流式工具请求。
9. 同一多协议渠道分别由 Claude Code 和 Codex 原生调用。

## 19. 验收标准

功能完成必须同时满足：

1. 管理员可以把渠道设为全部用户或指定用户/权限分组可用。
2. 用户可以创建私有中转，但其他普通用户在控制面和数据面都无法访问。
3. Claude Code 配置中只出现 Hub URL、Hub Key 和 Hub 模型名。
4. Anthropic 兼容中转可以受控透传 `/v1/messages`。
5. OpenAI Chat 兼容中转可以通过转换服务 Claude Code 的文本和工具调用。
6. 流式事件顺序、工具参数和 stop reason 正确。
7. 不支持的能力返回明确错误，不静默丢失输入。
8. 所有请求记录渠道所有者、供给来源、入站/出站协议和转换方式。
9. 私有中转用量不误扣平台套餐 Token。
10. SSRF、凭据隔离、授权撤销和跨用户攻击测试通过。
11. 同一渠道可以同时启用 Messages、Responses 和 Chat，且按客户端选择原生协议。
12. 缓存亲和不会绕过权限、健康、并发和路由域限制。
13. 管理端能够按渠道、协议和模型查看 Token 缓存命中率。

## 20. 不在第一版范围

- 用户把私有中转分享给其他用户。
- 用户配置任意出站请求头或脚本转换规则。
- 任意第三方自定义协议。
- 在请求已开始流式输出后切换渠道。
- 未经用户确认的跨平台/私有域故障转移。
- 声称完全支持所有 Anthropic beta、thinking 和 prompt caching 组合。

第一版应先把所有权、授权和 Claude Code 核心消息/工具链路做正确，再扩展更多协议特性。
