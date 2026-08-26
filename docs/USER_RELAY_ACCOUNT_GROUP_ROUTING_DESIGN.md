# 私有中转多账号收敛与组内故障转移方案

状态：已按方案实现，待生产环境真实上游验收

日期：2026-08-26

适用范围：普通用户与管理员个人空间中的“我的中转”、故障转移顺序、OpenAI/Anthropic 网关

## 1. 背景与目标

当前系统把一条私有中转记录同时当作：

- 一个站点。
- 一个上游账号/API Key。
- 一个故障转移节点。
- 一套协议和模型能力。

因此，同一个中转站注册多个账号后，这些账号会在页面和故障转移顺序中散开，也无法表达“先在同站账号之间切换，全部不可用后再切换到下一个站点”的规则。

本方案增加“中转组（站点）”层级，同时保留账号作为真实请求执行单元，实现：

1. 同站多个账号在一个站点项中通过 Tab 收敛展示。
2. 故障转移顺序只展示站点组，不展示组内每个账号。
3. 每个站点组可设置账号手工顺序、余额升序或余额降序。
4. 账号额度耗尽后立即退出调度并显示在队尾，只有手工刷新余额成功且余额恢复后才重新参与排序。
5. 当前站点组对本次请求没有任何可用账号时，再进入下一个故障转移节点。
6. Claude、Codex、OpenAI Chat、Grok、Gemini 等能力按“账号 + 协议 + 模型”精确判断，不能用站点组的能力并集直接发请求。

## 2. 核心产品定义

### 2.1 中转组与中转账号

```text
故障转移顺序
  ├─ 当前套餐
  ├─ AgentRouter（中转组）
  │    ├─ 账号 A（实际 channel）
  │    ├─ 账号 B（实际 channel）
  │    └─ 账号 C（实际 channel）
  ├─ 另一个站点（中转组）
  │    └─ 账号 A（实际 channel）
  └─ 专属号池
```

- **中转组**：用户认知中的一个站点，也是故障转移顺序中的一个节点。
- **中转账号**：该站点下的一份独立 API Key、签到令牌、余额、协议、模型、健康状态和并发配置。
- 现有 `channels` 继续表示中转账号，避免破坏模型绑定、请求日志、熔断和加密凭据。
- 新增中转组表并把用户私有 `channel` 归入某个组。

### 2.2 不强制按域名自动合并

系统可以根据规范化后的 Origin 提示“该站点已存在，是否添加为新账号”，但不能只凭域名强制合并，原因包括：

- 同域名不同路径可能是不同租户或不同 API 产品。
- 同一品牌可能使用多个域名。
- 白标站点可能共用后端域名但权限完全不同。
- 不同账号可能支持不同协议和模型。

新建账号时应允许：

- 添加到已有中转组。
- 创建新的中转组。
- 后续手工合并或移出中转组。

## 3. 协议和模型能力处理

### 3.1 能力必须保留在账号级

一个账号是否能处理请求，由以下条件共同决定：

```text
账号已启用
AND 账号没有被余额状态冻结
AND 健康状态和熔断状态允许请求
AND 存在请求模型的 channel_model
AND 存在匹配的 channel_model_binding
AND 协议或已验证的转换路径匹配
AND 端点和工具等 capability 匹配
```

中转组在页面上可以展示所有账号能力的并集，但该并集只用于概览，不能作为路由依据。

例如，同一个组有三个账号：

| 账号 | 能力 | 余额 |
| --- | --- | ---: |
| A | Claude Messages、Codex Responses | 100 |
| B | Claude Messages | 80 |
| C | OpenAI Chat、Grok 模型 | 50 |

采用余额降序时：

- Claude 请求的候选顺序是 A、B；C 被正常跳过，不记录故障。
- Codex Responses 请求只有 A；B、C 被正常跳过。
- Grok 的 OpenAI Chat 请求只有 C。
- A 耗尽后，Claude 请求只使用 B，Codex 请求认为该组对本次请求不可用并进入下一个故障转移节点。

### 3.2 客户端与协议边界

当前 Hub 原生支持的协议是：

| 客户端/用途 | Hub 入站协议 | 可用上游 |
| --- | --- | --- |
| Claude Code | `anthropic_messages` | Anthropic Messages；或已经验证可转换的 OpenAI Chat |
| Codex | `openai_responses` | OpenAI Responses |
| OpenAI 兼容客户端 | `openai_chat` | OpenAI Chat |
| Grok 模型 | 通常是 `openai_chat` | 上游提供 OpenAI 兼容接口时可直接支持 |
| Gemini 模型 | 取决于上游 | 上游提供 OpenAI 兼容接口时可按 Chat 使用；Google 原生 `generateContent` 当前不支持 |

“Grok”和“Gemini”本身不能简单作为协议名称：

- Grok 常以 OpenAI 兼容 Chat 协议提供，应该记录为模型能力。
- Gemini 如果由中转站通过 OpenAI Chat 暴露，也按 Chat 路由。
- 如果需要兼容 Gemini CLI 的 Google 原生协议，必须另行增加 `google_generate_content` 协议、路由入口、流式转换和工具调用适配，不能在本功能里假装兼容。

### 3.3 模型列表必须按客户端能力过滤

- Claude Code 请求 `/v1/models` 时，只返回存在 Anthropic 原生或允许转换路径的模型。
- Codex 获取模型时，只返回存在 Responses 路径的模型。
- OpenAI Chat 客户端只看到 Chat 可路由模型。
- 一个组内只要有一个当前可参与调度的账号支持模型，该模型就可以出现在列表中。
- “余额耗尽但等待手工刷新”的账号不应让一个实际上不可调用的模型继续出现在可用模型列表中；如果后续组仍支持该模型，则仍可显示。

## 4. 账号排序与调度规则

### 4.1 组内排序模式

每个中转组支持以下模式：

| 模式 | 行为 |
| --- | --- |
| 手工顺序 | 按用户拖拽后的固定顺序尝试 |
| 余额降序 | 剩余余额高的账号优先；适合优先使用更充足的账号 |
| 余额升序 | 剩余余额低但大于零的账号优先；适合先清空小额账号 |

稳定排序规则：

1. 先过滤不兼容和不可调度账号。
2. 再按所选余额方向排序。
3. 余额相同时按手工顺序排序。
4. 手工顺序也相同时按账号创建时间和 ID 排序，保证结果稳定。

余额未知的账号排在“已知正余额账号”之后，但仍可请求；所有余额都未知时回退到手工顺序。耗尽账号始终显示在队尾且不进入候选列表。

### 4.2 单次请求的故障转移顺序

```text
识别入站协议、端点和 public model
  -> 按用户设置读取故障转移节点
  -> 进入第一个中转组
  -> 筛选支持本次请求的账号
  -> 按该组排序策略排列账号
  -> 依次尝试账号
       -> 成功：结束
       -> 明确额度耗尽：冻结该账号，继续组内下一个
       -> 可重试网络/5xx：记录熔断，继续组内下一个
       -> 不支持当前模型：记录账号模型绑定异常，继续组内下一个
       -> 流已经开始后失败：不得切换账号，结束并记录流中断
  -> 组内没有候选或全部尝试失败
  -> 进入下一个故障转移节点
```

必须保证一个组内的账号候选连续排列。例如：

```text
AgentRouter/A -> AgentRouter/B -> AgentRouter/C -> 站点二/A -> 专属号池
```

不能被当前的缓存亲和或全局候选排序打散成：

```text
AgentRouter/A -> 站点二/A -> AgentRouter/B
```

### 4.3 与缓存亲和的关系

当前系统会用缓存亲和重新排列同优先级候选。组内使用手工或余额顺序时，应以用户明确设置的队列为最高优先级：

- 缓存亲和不能把后面的账号移动到前面。
- 缓存亲和不能让耗尽账号重新进入候选。
- 成功账号仍可记录亲和统计，但不改变本次及后续的显式账号顺序。
- 将来如需“会话粘滞优先”模式，应作为单独的组内策略，由用户主动选择。

## 5. 余额与账号状态机

### 5.1 余额必须持久化

当前余额只保存在前端组件内，刷新页面就丢失，路由层也看不到余额。新功能必须把每个账号最近一次余额结果写入数据库，至少包括：

- 总额度、购买额度、赠送额度。
- 历史消耗和剩余额度。
- 币种。
- 获取时间、获取状态和安全化后的错误信息。
- 数据来源/适配器，例如 `newapi_self`。

不同币种不能在站点组层直接相加。组概览只有在币种一致时才显示合计，否则显示各币种摘要。

### 5.2 路由状态

账号路由状态与已有健康状态、熔断状态分开：

| 状态 | 是否参与路由 | 清除方式 |
| --- | --- | --- |
| `active` | 是 | 默认状态 |
| `depleted` | 否 | 仅手工单个/批量刷新余额确认大于零后恢复 |
| `credential_error` | 否 | 更新 Key 后检测成功，或明确手工恢复 |
| `manual_disabled` | 否 | 用户重新启用 |

其中 `depleted` 必须满足用户提出的强约束：

- 请求发现明确额度不足后，原子地标记为 `depleted`。
- 该账号在 UI 中移动到队尾并显示“额度耗尽，等待刷新”。
- 定时健康检查、协议检测、应用重启和普通成功探测均不能自动恢复。
- 只有用户点击该账号的“刷新余额”或“批量刷新余额”，且余额接口成功返回正余额，才能恢复为 `active` 并按当前规则重新排序。
- 点击刷新但查询失败、返回零余额或无法解析余额时，继续保持 `depleted`。

### 5.3 不能把所有 429 都当作额度耗尽

错误必须分类，否则短期限流会永久冻结账号：

| 错误 | 处理 |
| --- | --- |
| 明确 `insufficient_quota`、`quota_exhausted`、余额不足或计费硬限制 | 标记 `depleted`，继续组内下一个账号 |
| 普通 `429 rate_limit`、RPM/TPM 限制 | 临时失败，继续下一个账号；使用短期熔断，不标记耗尽 |
| `401`、明确无效 Key | 标记 `credential_error` |
| `403` 模型无权限 | 只影响对应模型/协议绑定，不能认定整个账号没额度 |
| `404` 模型不存在 | 记录对应模型绑定异常并继续，不冻结账号 |
| `500/502/503/504`、连接超时 | 走现有熔断并继续，不修改余额状态 |
| 客户端参数错误 | 原样返回，不应切换账号重复请求 |

额度错误识别应优先使用上游结构化 `code/type`。不同站点的文字信息只能由站点适配器补充识别，不能在网关中维护一个无限扩张的模糊字符串列表。

### 5.4 并发一致性

多个请求可能同时选中同一个账号。实现时需要：

- 请求前获取账号并发租约并再次确认路由状态。
- 标记 `depleted` 使用幂等更新，不能依赖前端状态。
- 状态变更后清除该账号的缓存亲和记录。
- 已经取得候选快照但尚未发出的请求，在真正发送前重新检查 `depleted`。
- 余额刷新按账号独立提交；批量刷新中一个账号失败不能回滚其他账号的成功结果。

## 6. 数据库设计

### 6.1 新增 `user_relay_groups`

```text
user_relay_groups
- id uuid primary key
- owner_user_id uuid not null references users
- name text not null
- homepage_url text nullable
- normalized_origin text nullable
- platform_type enum: generic | newapi | sub2api
- enabled boolean not null default true
- account_order_mode enum: manual | balance_asc | balance_desc
- max_concurrency integer nullable
- created_at / updated_at
```

同一用户下组名不要求全局唯一。`normalized_origin` 用于提示可能属于同站，不作为强制唯一键。

### 6.2 `channels` 增加组归属

```text
channels
+ user_relay_group_id uuid nullable references user_relay_groups
+ account_label text nullable
+ account_rank integer not null default 100
+ insecure_http_acknowledged_at timestamptz nullable
```

约束：

- `owner_kind = user` 的私有中转必须归属于同一 `owner_user_id` 的中转组。
- 平台公共渠道暂不要求加入用户中转组。
- `account_label` 用来显示“账号 A”“主账号”等，不显示 Key 明文。

### 6.3 新增 `user_relay_account_states`

```text
user_relay_account_states
- channel_id uuid primary key references channels on delete cascade
- routing_state enum: active | depleted | credential_error | manual_disabled
- state_reason_code text nullable
- state_reason_message text nullable
- state_changed_at timestamptz
- total_quota numeric nullable
- purchased_quota numeric nullable
- gift_quota numeric nullable
- used_quota numeric nullable
- remaining_balance numeric nullable
- currency text nullable
- balance_source text nullable
- balance_status enum: unknown | success | error
- balance_fetched_at timestamptz nullable
- balance_error text nullable
- version integer not null default 1
- updated_at timestamptz
```

余额字段使用足够精度的 `numeric`，禁止用浮点数决定排序和是否为零。

### 6.4 请求日志

保留现有 `channel_id` 记录真正被调用的账号，并新增：

```text
request_logs
+ user_relay_group_id uuid nullable
+ resource_type enum: subscription | user_relay | private_pool | unresolved
+ resource_id uuid nullable
+ resource_name_snapshot text nullable
+ execution_name_snapshot text nullable

request_attempts
+ user_relay_group_id uuid nullable
+ failure_class text nullable
+ resource_type text nullable
+ resource_id uuid nullable
+ resource_name_snapshot text nullable
+ execution_name_snapshot text nullable
```

`resource_name_snapshot` 记录用户认知中的来源，例如“无限量套餐”“AgentRouter”“我的专属号池”；`execution_name_snapshot` 记录真正执行请求的公共渠道或中转账号。使用快照而不是只在查询时关联当前名称，避免资源改名或删除后历史日志失去含义。这样既能按站点组统计，也能定位具体哪个账号耗尽或失败。

### 6.5 故障转移顺序迁移

当前值：

```text
relay:{channelId}
```

新值：

```text
relay_group:{groupId}
```

迁移规则：

1. 每个现有用户私有中转先创建一个独立组，保证无损迁移。
2. 把原 `relay:{channelId}` 替换为对应 `relay_group:{groupId}`。
3. 用户后续合并多个组时，合并组在外部顺序中采用所有成员原位置的最前位置。
4. 被合并账号的内部手工顺序沿用它们原来的外部相对顺序。
5. 迁移阶段兼容读取旧 ID，写入时统一转为新 ID。

不建议迁移时按域名自动合并，以免改变生产请求顺序。

## 7. 服务端改造

### 7.1 新增统一组内调度器

建议新增 `server/services/user-relay-scheduler.ts`，由 OpenAI 网关和 Anthropic 网关共同调用，负责：

- 读取站点组和账号状态。
- 按请求协议、模型、端点过滤账号。
- 按手工/余额规则稳定排序。
- 返回带 `relayGroupId`、`accountRank`、`routingState` 的候选。
- 分类请求错误并执行耗尽冻结。
- 在手工余额刷新后恢复账号并重排。

不能分别在 `hub-gateway.ts` 和 `anthropic-gateway.ts` 复制两套规则，否则 Claude 与 Codex 会出现不同的账号切换行为。

### 7.2 修改候选结构

`RouteCandidate` 增加：

```text
relayGroupId?: string
relayAccountId?: string
groupOrder: number
accountOrder: number
```

`orderedRouteSourceNodes()` 的用户中转节点从 `channelId` 改为 `relayGroupId`。`routeCandidates()` 接受组 ID，在组内生成多个账号候选，并保证候选不会跨组交错。

### 7.3 余额接口

建议接口：

```text
POST /api/console/relay-groups/:groupId/accounts/:channelId/balance
POST /api/console/relay-groups/:groupId/balances/refresh
POST /api/console/relay-groups/balances/refresh-all
```

返回最新余额、账号路由状态和重排后的账号 ID 顺序。批量接口需要限制并发，避免同时向同一站点发出大量余额请求。

### 7.4 组与账号管理接口

```text
GET    /api/console/relay-groups
POST   /api/console/relay-groups
PATCH  /api/console/relay-groups/:groupId
DELETE /api/console/relay-groups/:groupId
POST   /api/console/relay-groups/:groupId/accounts
PATCH  /api/console/relay-groups/:groupId/accounts/:channelId
PUT    /api/console/relay-groups/:groupId/account-order
POST   /api/console/relay-groups/merge
POST   /api/console/relay-groups/:groupId/accounts/:channelId/move
```

删除非空组时必须让用户选择删除全部账号或先移动账号，不能静默级联删除凭据。

## 8. 页面设计

### 8.1 “我的中转”列表

每个站点只占一个列表项，展示：

- 站点名和可点击官网 URL。
- `可用账号数 / 总账号数`。
- 站点能力摘要，例如 `Claude 2/3 · Codex 1/3 · Chat 3/3`。
- 模型并集数量和“查看模型”抽屉。
- 同币种时的账号余额合计；多币种时显示分项。
- 组级刷新余额、签到、添加账号和设置按钮。

展开站点后使用账号 Tab：

```text
[账号 A · ¥100] [账号 B · 已耗尽] [账号 C · ¥50] [+ 添加账号]
```

Tab 内容保留现有单账号能力：Key、签到令牌、协议、检测模型、模型同步、余额、健康检测、客户端配置、编辑和删除。

账号较多时 Tab 横向滚动，并提供账号下拉菜单；不能让账号名称挤压页面或多行堆满。

### 8.2 组内顺序设置

站点设置中提供排序模式选择：

- 手工顺序。
- 余额从高到低。
- 余额从低到高。

手工模式显示拖拽列表。余额模式显示实时计算后的只读顺序，并继续保存手工顺序作为余额相同时的稳定次序。

耗尽账号始终放在可视队尾，显示原因和“刷新余额”操作；它不参与真实请求。

### 8.3 故障转移顺序

故障转移页面只显示一个站点组节点：

```text
01 AgentRouter       2/3 个账号可用
02 当前套餐          可用
03 另一个中转站     Claude 可用 · Codex 不可用
04 专属号池          5 个账号可调度
```

这里的“可用”只是全局摘要。真正路由时仍按当前请求的模型和协议动态判断；组对 Claude 可用不代表对 Codex 也可用。

## 9. 错误处理与可观测性

日志和审计至少记录：

- 请求选中的站点组和账号。
- 组内候选数、跳过数及不泄露敏感信息的跳过原因。
- 每次尝试的协议、模型绑定、HTTP 状态和 `failure_class`。
- 账号何时因额度耗尽被冻结。
- 谁在何时执行单个或批量余额刷新。
- 刷新前后余额和路由状态变化，不记录 API Key 或签到令牌。

建议的指标：

- 站点组请求成功率与组内故障转移次数。
- 每个账号的成功率、耗尽次数和余额新鲜度。
- 因协议不匹配跳过的账号数。
- 从组内故障转移升级到下一个外部节点的次数。
- 余额刷新成功率和耗时。

## 10. 实施阶段

### 阶段一：数据结构与兼容迁移

- 增加中转组、账号状态和日志字段。
- 每个现有私有中转创建独立组。
- 兼容旧 `relay:{channelId}`，迁移为 `relay_group:{groupId}`。
- 余额查询结果改为持久化。

### 阶段二：统一路由调度

- 新增共享组内调度器。
- 修改 OpenAI 和 Anthropic 两套网关。
- 余额耗尽冻结、错误分类、并发重检和候选连续性生效。
- 禁止缓存亲和覆盖显式组内顺序。

### 阶段三：页面收敛

- 中转列表改为站点组。
- 增加账号 Tab、添加账号、合并/移动账号和组内排序。
- 故障转移顺序改为站点组节点。
- 增加组级及全局批量刷新余额。

### 阶段四：能力和回归测试

- 模型列表按客户端协议过滤。
- 补齐请求日志、指标和审计。
- 使用真实 Claude Code、Codex 和模拟多账号站点验收。

不建议只先做前端 Tab。仅做 UI 收敛会让故障转移仍以账号为节点，也无法可靠实现耗尽冻结。

## 11. 验收标准

1. 同一站点的三个账号只在“我的中转”和故障转移顺序中占一个外部节点。
2. 站点展开后可通过 Tab 管理三个账号，每个账号保留独立协议、模型、Key、签到和余额。
3. 手工、余额升序、余额降序三种模式的候选顺序稳定且可测试。
4. 第一个账号返回明确额度不足时，同一请求自动尝试第二个账号。
5. 耗尽账号后续不再收到请求，重启服务后也保持耗尽状态。
6. 单个或批量余额刷新确认正余额后，账号恢复并按当前规则重新排序。
7. 普通 429 限流不会把账号永久标记为耗尽。
8. Claude 请求不会发给仅支持 Responses 的账号；Codex 请求不会发给仅支持 Messages 的账号。
9. 一个账号不支持当前模型时只跳过该账号，不影响其处理其他模型。
10. 组内没有兼容账号时进入下一个故障转移节点，不返回误导性的全局站点故障。
11. OpenAI 与 Anthropic 网关的账号选择、冻结和恢复规则完全一致。
12. 流式响应开始后发生错误时不切换账号，避免重复或拼接输出。
13. 旧中转、Key、模型映射、请求日志和故障转移顺序迁移后保持可用。

## 12. 推荐决策

建议确认并按以下规则实施：

1. 用显式中转组收敛账号，域名只用于提示，不自动强制合并。
2. 故障转移节点使用组 ID，实际请求和日志仍使用账号对应的 channel ID。
3. 协议与模型能力保留在账号级，站点组只显示聚合摘要。
4. 余额耗尽是持久状态，仅成功的手工余额刷新可以解除。
5. 普通限流、网络错误、模型无权限与额度耗尽分别处理。
6. 第一版支持手工顺序、余额升序和余额降序，不把轮询或会话粘滞混入本次需求。
7. Gemini 原生协议单独立项；通过 OpenAI 兼容接口暴露的 Gemini/Grok 模型可直接纳入当前能力矩阵。

## 13. 统一检测流程

### 13.1 当前问题

现有系统存在三种互相覆盖的状态来源：

- 手工协议检测会对每个已开启协议发送最小推理请求，并写入协议状态。
- 后台健康检查请求 `/v1/models`，但只写整个中转的健康状态。
- 真实请求成功会把整个中转标记为健康，却不会更新对应协议的验证状态。

此外，当前路由只检查协议绑定是否启用，没有使用协议的 `verification_status` 过滤候选。这样会出现“Messages 检测失败、Responses 检测成功、整个中转显示可用，Messages 仍可能被路由”的状态冲突。

### 13.2 唯一的手工检测动作

页面只保留一个“执行检测”动作，并按以下顺序运行：

```text
步骤 1：GET /v1/models 基础连通性检测
  -> DNS、TCP/TLS、HTTP 状态
  -> 按平台策略尝试认证头
  -> 识别 OpenAI/Anthropic 模型列表格式
  -> 只报告模型数量，不写入模型目录

步骤 2：逐个检测已开启协议
  -> Anthropic Messages：POST /v1/messages
  -> OpenAI Responses：POST /v1/responses
  -> OpenAI Chat：POST /v1/chat/completions
  -> 每个协议使用用户指定的检测模型
  -> 每个协议独立选择并保存可用认证方式

步骤 3：生成账号汇总状态
  -> 全部协议可用
  -> 部分协议可用
  -> 等待真实客户端验证
  -> 不可用
```

执行规则：

- 如果 `/v1/models` 发生 DNS、连接或 TLS 失败，可以直接停止后续协议请求，因为相同地址无法到达。
- 如果 `/v1/models` 返回 `401`、`403`、`404` 或非标准正文，仍继续检测已开启协议。部分站点不开放模型接口，但推理接口可以正常使用。
- 一个协议失败不能覆盖其他协议的成功状态。
- 一个协议不支持当前检测模型时，只影响该协议和模型组合。
- 检测可能产生最小上游费用，弹窗继续明确提示。
- 检测抽屉不能自动关闭，用户手工关闭后才消失。

### 13.3 状态展示

账号列表不再并排显示含义不清的“协议圆点 + 待检测”。改为：

```text
基础连接：可达 / 认证失败 / 无模型接口 / 连接失败 / 未检测
Messages：可用 / 失败 / 等待真实客户端 / 未检测
Responses：可用 / 失败 / 等待真实客户端 / 未检测
Chat：可用 / 失败 / 等待真实客户端 / 未检测
账号汇总：全部可用 / 部分可用 / 不可用 / 未检测
```

汇总状态必须由基础连接和协议状态计算，不能作为另一份独立事实存储后被不同任务随意覆盖。

### 13.4 路由如何使用检测结果

- `verified`：允许路由。
- `pending_real_client`：允许对应真实客户端发起首次请求，成功后转为 `verified`。
- `unknown`：新建或配置变化后允许一次受控真实验证，也可以根据用户设置要求先手工检测。
- `failed`：不进入对应协议候选，但账号的其他成功协议仍然可用。
- 真实请求成功只更新实际使用的协议。
- 真实请求明确返回协议/模型不支持时，只更新对应绑定，不能把整个账号标记不可用。
- 基础连通性状态不能替代协议推理状态。

## 14. 模型获取改为完全手工

删除“保存和健康检查时自动读取模型”开关及其全部逻辑，包括：

- 前端 `modelDiscoveryEnabled` 字段和开关。
- 创建或保存中转时自动调用模型接口。
- 后台健康检查把读取到的模型自动写入 `channel_models`。
- `channels.model_discovery_enabled` 数据库列；迁移完成后删除。
- 围绕该开关对 `unknown` 健康状态和客户端身份模式的特殊判断。

模型只有以下方式可以改变：

1. 用户点击“获取模型”，请求 `/v1/models` 并把结果带回创建/编辑表单。
2. 已保存账号点击“同步模型”，明确确认后更新模型目录。
3. 用户手工维护模型映射。

“执行检测”的第一步虽然也会请求 `/v1/models`，但只验证连接并显示返回模型数量，不能导入、移除、恢复或覆盖任何模型。

配置变化后的状态处理：

- Base URL、平台类型、API Key、协议、认证方式或检测模型变化时，把受影响的检测状态重置为 `unknown`。
- 修改名称、账号标签、签到设置、余额设置和排序方式时，不重置协议状态。
- 保存动作本身不产生任何上游网络请求。

## 15. Bearer 与 x-api-key

### 15.1 区别

两者通常携带同一个上游 API Key，区别在于 HTTP 请求头：

```http
Authorization: Bearer YOUR_KEY
```

```http
x-api-key: YOUR_KEY
anthropic-version: 2023-06-01
```

- `Bearer` 是 OpenAI、NewAPI、Sub2API 和大量兼容站点常用方式。
- `x-api-key` 是 Anthropic Messages 原生接口的标准方式，通常还需要 `anthropic-version`。
- 一些中转同时接受两者，一些只接受其中一种。
- 它不是两种不同的 Key，也不代表 Key 权限不同，只是上游要求的传递方式不同。
- “控制台访问令牌”是查询余额和签到的管理凭据，不能拿来替代推理 API Key。

### 15.2 保存和检测策略

- 每个协议独立保存认证方式，不能给整个账号只保存一个全局认证方式。
- 平台类型提供默认尝试顺序，但不覆盖已经验证成功的选择。
- 检测时先尝试当前保存方式；认证失败时再尝试另一种。
- 只有另一种方式真正返回成功，才更新该协议的默认认证。
- 超时、5xx、模型不存在、额度不足等非认证错误不能触发认证方式切换。
- 结果抽屉显示最终采用方式和实际尝试过的方式。

## 16. 中转平台类型与检测适配器

### 16.1 添加中转时的平台单选

创建站点组时增加必选的平台类型：

```text
( ) 通用兼容站
( ) NewAPI
( ) Sub2API
```

默认选择“通用兼容站”。AgentRouter 这类无法确定管理端实现的站点使用通用兼容策略。平台类型属于站点组，同组账号默认继承；如后续确有混合部署需求，再增加账号级覆盖，不在第一版加入隐式复杂度。

### 16.2 平台适配器职责

建议新增统一接口：

```text
RelayPlatformAdapter
- connectivityProbe(account)
- discoverModels(account)
- protocolProbe(account, protocol, model)
- fetchBalance(account)
- checkin(account)
- classifyUpstreamError(response)
- visibleCredentialFields()
```

平台差异集中在适配器中，网关和页面不能散落 `if platform === ...` 判断。

### 16.3 第一版策略矩阵

| 平台 | `/v1/models` | 协议检测 | 余额 | 签到 | 默认认证 |
| --- | --- | --- | --- | --- | --- |
| 通用兼容站 | 解析 OpenAI 或 Anthropic 格式 | 检测用户开启的三个协议 | 不保证支持 | 不支持 | 按协议：Messages 优先 x-api-key，其他优先 Bearer |
| NewAPI | OpenAI 模型格式，兼容部分 Anthropic 认证 | 检测用户开启的三个协议 | `/api/user/self`，使用控制台令牌和可选用户 ID | `/api/user/checkin` | Bearer 优先，Messages 可补测 x-api-key |
| Sub2API | OpenAI 模型格式 | 检测用户开启的三个协议 | `/v1/usage`，使用推理 API Key | 第一版不提供 | Bearer 优先 |

平台选择同时控制表单字段：

- 通用兼容站：API Key、协议、模型、可选客户端身份设置。
- NewAPI：额外显示控制台访问令牌、用户 ID、签到和余额功能。
- Sub2API：显示 API Key 和 `/v1/usage` 余额；隐藏 NewAPI 控制台令牌、用户 ID 和签到字段。

不同 NewAPI/Sub2API 分支可能修改接口。第一版按标准接口实现；非标准站点使用通用兼容站，后续可以增加自定义适配器配置，不能根据返回文字偷偷切换平台。

## 17. HTTP 中转支持与安全边界

### 17.1 支持范围

Base URL 允许：

```text
https://relay.example.com
http://relay.example.com
```

HTTP 只改变传输协议，不放宽现有 SSRF 规则：

- 继续解析并固定使用经过校验的公网 IP。
- 继续拒绝 loopback、私网、link-local、云元数据地址和不允许的 Fake-IP。
- 禁止 URL 内嵌用户名、密码、查询参数和片段。
- 禁止自动重定向；特别禁止 HTTPS 降级到 HTTP。
- DNS 重绑定防护继续生效。

需要访问内网 HTTP 服务时，只能由服务器管理员配置明确的域名/IP/CIDR allowlist。普通用户不能通过页面绕过公网地址限制。

### 17.2 HTTP 明文风险确认

API Key、提示词和模型响应通过 HTTP 传输时可能被链路上的设备读取或修改。用户选择 HTTP 后必须：

- 在表单内显示明确警告。
- 勾选“我确认该站点使用明文 HTTP”后才能保存。
- 在数据库记录 `insecure_http_acknowledged_at` 和操作者审计。
- 列表持续显示“HTTP”警告标记，不能只在首次保存时提示。

复制 HTTP 中转时，新账号继承 URL，但仍保留原确认时间和复制审计；移动到其他所有者时必须重新确认。

## 18. 请求日志增加资源来源

### 18.1 两个不同维度

请求日志必须同时区分：

1. **计费/供给资源**：用户认为本次消耗了什么。
2. **执行节点**：最终真正向哪个渠道或账号发送了请求。

映射规则：

| `supply_source` | 资源显示 | 执行节点显示 |
| --- | --- | --- |
| `platform` | 套餐名称，例如“不限量”“Claude 月卡” | 实际公共渠道名，仅管理员详情需要展示 |
| `user_relay` | 中转组名称，例如“AgentRouter” | 具体账号标签，例如“账号 B” |
| `private_pool` | 专属号池名称，例如“我的号池” | Hub 实际调用的 Sub2API 渠道；只有上游可靠返回账号标识时才显示具体号池账号 |

主列表增加“资源”列，示例：

```text
不限量
平台套餐

AgentRouter
个人中转 · 账号 B

我的专属号池
专属号池
```

原“渠道”列可改名为“资源 / 执行节点”，或拆成两列。管理员详情同时展示两者；普通用户只能查看属于自己的资源信息，不泄露公共渠道内部名称和其他用户账号。

### 18.2 历史名称必须快照

仅关联当前 `channels.name` 不够，因为资源可能改名或删除。请求完成时写入：

- `resource_type`。
- `resource_id`。
- `resource_name_snapshot`。
- `execution_name_snapshot`。
- 中转请求的 `user_relay_group_id` 和真实 `channel_id`。

如果请求尚未选路或在权限检查阶段失败，显示“未选路”，不能错误显示故障转移顺序中的第一个节点。

主请求行显示最终成功或最终失败的资源。详情中的“调度轨迹”逐次显示每次尝试的资源组、具体账号、协议、状态和失败分类，因此从账号 A 切换到账号 B 或下一个中转组时可以完整追踪。

### 18.3 筛选与统计

请求记录增加筛选项：

- 资源类型：套餐、个人中转、专属号池、未选路。
- 资源实例：具体套餐、中转组或号池。
- 执行账号/渠道。

聚合统计同时提供资源维度和执行节点维度，避免把“用户使用不限量套餐”和“底层公共渠道流量”混成同一个指标。

## 19. 复制中转

### 19.1 入口和复制目标

每个账号操作区增加“复制中转”按钮。点击后弹出确认抽屉，可选择：

- **复制为当前站点组的新账号**：默认选项，适合同站注册多个账号。
- **复制为新的站点组**：适合以现有配置为模板接入另一个站点。

可在复制前修改账号标签、名称、Base URL、平台类型和凭据。

### 19.2 默认复制内容

复制：

- Base URL 和协议级 Base URL 覆盖。
- 平台类型。
- 上游 API Key。
- NewAPI 控制台令牌和用户 ID。
- 已开启协议、认证方式、API 版本和检测模型。
- 模型及协议绑定。
- 超时、并发、签到设置和客户端身份设置。
- HTTP 风险确认信息。

不复制：

- 协议检测结果和时间。
- 健康状态、熔断计数和缓存亲和。
- 余额和余额刷新时间。
- 签到结果和签到时间。
- 请求日志、用量和审计历史。
- `depleted`、`credential_error` 等运行状态。

新副本以 `unknown/active` 状态加入组内队尾，名称默认为“原账号名 - 副本”。

### 19.3 凭据复制方式

现有上游凭据密文使用 channel ID 作为加密上下文，不能直接复制数据库密文字段。服务端必须：

```text
校验账号所有权
  -> 解密原账号凭据
  -> 创建新的 channel ID
  -> 使用新 channel ID 和新 AAD 重新加密
  -> 同一事务写入账号、协议和模型
  -> 清理内存中的明文引用
```

建议接口：

```text
POST /api/console/relay-groups/:groupId/accounts/:channelId/duplicate
```

## 20. 编辑中转时回显凭据

### 20.1 页面行为

打开账号编辑抽屉时直接加载并填充：

- 上游 API Key。
- NewAPI 控制台访问令牌。
- 用户 ID。
- 后续平台适配器声明的其他账号级凭据。

不再显示“留空保持不变”。每个凭据输入框右侧增加独立小眼睛：

- 默认 `type="password"`，但字段中已经有真实值。
- 点击眼睛切换为 `type="text"`。
- 再次点击恢复 `password`。
- 关闭抽屉时立即清空所有前端明文状态。

用户 ID 本身通常不是秘密，但为了表单交互一致，可以与同一凭据区的其他字段使用相同显示切换；数据库仍可保持普通文本存储。

### 20.2 凭据读取接口

列表接口继续只返回 `checkinConfigured` 等布尔值，不能把所有中转凭据批量下发。编辑时单独请求：

```text
POST /api/console/relay-groups/:groupId/accounts/:channelId/credentials
```

接口要求：

- 校验当前登录用户和账号所有权；管理员个人空间也只能读取自己的私有账号。
- 不再要求重新输入密码，遵循当前 Key 查看策略。
- 返回 `Cache-Control: no-store, private` 和 `Pragma: no-cache`。
- 按用户和账号限流。
- 写入“查看中转凭据”审计，但审计内容不包含明文。
- 请求体、响应体和异常监控不得记录明文。
- 前端不得写入 URL、日志、分析事件、`localStorage` 或 `sessionStorage`。

保存时只提交实际修改过的凭据字段，避免用户只修改名称时无意义地重新加密所有秘密。

## 21. 新增验收标准

1. 点击一次“执行检测”依次展示 `/v1/models` 基础连接和所有已开启协议的独立结果。
2. 检测 `/v1/models` 不会修改模型目录；只有“获取模型”或“同步模型”会修改。
3. 删除自动模型发现开关后，保存中转不会发出任何上游请求。
4. 一个协议失败、另一个成功时显示“部分可用”，失败协议不会进入路由候选。
5. Bearer 与 x-api-key 只在认证失败时补测，非认证错误不会错误切换认证方式。
6. NewAPI、Sub2API 和通用站按各自适配器执行余额、签到、错误分类和字段展示。
7. 公网 HTTP 中转可以保存和请求，同时持续显示明文传输警告；私网和元数据地址仍被阻止。
8. 请求日志明确显示“不限量/套餐名”“中转组名 + 具体账号”或“专属号池名”。
9. 资源或账号改名、删除后，历史日志仍显示请求发生时的名称。
10. 调度轨迹能看出同一中转组内从账号 A 切换到账号 B，再切换到下一资源的全过程。
11. 复制中转会复制配置和凭据，但不会复制余额、检测结果、熔断和历史记录。
12. 编辑抽屉直接填充上游 Key、控制台令牌和用户 ID，小眼睛可以独立切换显示。
13. 凭据接口不会出现在缓存、服务日志、审计正文或前端持久化存储中。

## 22. 合并后的推荐实施顺序

为避免中途出现旧状态和新状态混用，建议按以下顺序实施：

### 第一批：数据库和兼容层

- 中转组、账号运行状态、平台类型、账号顺序和持久化余额。
- 请求资源快照和调度尝试快照。
- 现有私有中转一对一迁移为站点组，保持原路由顺序。
- 兼容读取旧 `relay:{channelId}`，新写入统一使用 `relay_group:{groupId}`。

### 第二批：检测和平台适配器

- 删除 `model_discovery_enabled` 及自动模型导入逻辑。
- 建立 `/v1/models` 基础连接 + 已启用协议推理的统一检测流程。
- 引入通用、NewAPI、Sub2API 三种平台适配器。
- 路由开始使用协议级验证状态，汇总状态改为派生结果。
- 增加公网 HTTP 支持并保留 SSRF、DNS 固定和明文风险确认。

### 第三批：多账号调度

- 统一 OpenAI 与 Anthropic 网关的组内调度器。
- 手工、余额升序和余额降序。
- 额度耗尽冻结、手工余额刷新恢复和并发状态重检。
- 保证组内账号连续尝试后才进入下一个外部故障转移节点。

### 第四批：控制台

- 站点组列表、账号 Tab、添加账号、移动/合并账号。
- 组级故障转移节点和组内顺序设置。
- 平台单选、平台相关字段、HTTP 警告。
- 复制中转、凭据回显和独立小眼睛。
- 检测抽屉展示基础连接与协议明细。

### 第五批：日志和验收

- 请求列表显示资源来源、站点组和具体中转账号。
- 调度轨迹显示每次组内及跨组切换。
- 资源和执行节点筛选、聚合指标与名称快照。
- 模拟多账号额度耗尽，并使用真实 Claude Code、Codex 验收。
