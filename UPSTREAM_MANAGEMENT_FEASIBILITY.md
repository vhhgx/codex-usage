# Zephyr Hub 上游管理能力可行性方案

## 1. 结论

将 Zephyr Hub 从“流量与额度控制面”扩展为 CPA/CLIProxyAPI 和 Sub2API 的统一管理控制面是可行的，
但应通过上游官方管理 API 完成，不能直接修改上游数据库或文件目录。

建议采用以下产品边界：

- Hub 负责管理员认证、输入校验、操作编排、审计、幂等和状态对账。
- CPA/Sub2API 继续拥有认证文件、账号、分组、调度和平台凭据的最终事实来源。
- Hub 不长期保存上传的原始认证 JSON，不在日志、审计详情或对象存储中归档认证内容。
- 第一版继续保持单管理员，不引入多租户、用户自助导入或细粒度 RBAC。

综合可行性：

| 能力 | 可行性 | 当前证据 | 主要前提 |
| --- | --- | --- | --- |
| CPA 认证文件列表与额度 | 高 | 当前代码已调用 Management API | 已配置 Management Key |
| CPA JSON 认证文件上传 | 高 | CPA 已有 `auth-files` 管理资源 | 需确认当前 CPA 版本的上传方法和 multipart 字段 |
| CPA 启用、停用和删除认证文件 | 高 | 列表已返回 `disabled`、状态和 `auth_index` | 需对写接口做影子契约测试 |
| Sub2API 账号列表与额度 | 高 | 当前代码与真实实例均已验证 | 已配置 Admin API Key |
| Sub2API 分组列表 | 高 | 真实实例 `GET /api/v1/admin/groups` 已验证 | Admin API Key 具备读取权限 |
| Sub2API 导入/创建账号 | 中高 | 账号对象已暴露 `credentials`、平台和分组字段 | 不同平台凭据结构和写接口需验证 |
| Sub2API 账号分组分配 | 中高 | 账号响应包含 `group_ids`、`groups`、`account_groups` | 更新方法、并发覆盖语义需验证 |
| Sub2API 分组增删改 | 中 | 分组读取和完整策略字段已确认 | 写接口、字段校验和删除约束需验证 |
| 跨系统原子事务 | 低 | 两个独立上游均不参与 Hub 数据库事务 | 必须使用操作日志、补偿和对账替代 |

## 2. 当前状态与证据

### 2.1 CPA/CLIProxyAPI

当前 [server/services/cpa.ts](./server/services/cpa.ts) 已实现：

- 使用服务端 `NUXT_CPA_MANAGEMENT_KEY` 调用 `/v0/management/**`。
- `GET /v0/management/auth-files` 获取 Codex 认证文件列表。
- 从认证记录读取 `auth_index`、账号、套餐、状态、禁用状态和刷新时间。
- 通过 `/v0/management/api-call` 使用指定认证文件查询真实 Codex 额度。
- 浏览器只接收 HMAC 生成的不透明账号 ID，不暴露 `auth_index`。

2026-07-31 对当前配置实例进行只读探测：

- `GET /v0/management/auth-files` 返回 `200` 和 `{ files: [...] }`。
- `OPTIONS /v0/management/auth-files` 返回 `204`，但未声明 `Allow`，无法仅凭 OPTIONS 证明写方法。

因此列表、额度和目标资源已证实；上传、停用、删除应在影子环境中以当前 CPA 版本做一次实际契约验证。

### 2.2 Sub2API

当前 [server/services/sub2api-admin.ts](./server/services/sub2api-admin.ts) 已实现：

- 使用服务端 `NUXT_SUB2API_ADMIN_API_KEY` 调用 `/api/v1/admin/**`。
- 分页读取 `/accounts`，解析平台、类型、状态、调度状态、并发、到期时间和错误。
- 读取 `/accounts/:id/usage`，支持缓存额度与主动刷新额度。
- 浏览器使用不透明账号 ID，不直接暴露上游数字 ID。

2026-07-31 对当前配置实例进行只读探测：

- `GET /api/v1/admin/accounts` 返回 `200`。
- `GET /api/v1/admin/groups` 返回 `200`。
- 当前实例未公开机器可读 OpenAPI；`/openapi.json` 和 `/docs` 均返回管理前端 HTML。
- `OPTIONS /api/v1/admin/accounts|groups` 返回 `403`，不能据此推断写方法。

账号对象已确认包含：

- `credentials`、`credentials_status`、`extra`。
- `platform`、`type`、`status`、`schedulable`。
- `priority`、`concurrency`、`rate_multiplier`。
- `group_ids`、`groups`、`account_groups`。
- 代理、限流、过载、临时不可调度和额度维度状态。

分组对象已确认包含：

- 名称、描述、平台、状态、订阅类型和倍率。
- 日/周/月金额上限、RPM 限制。
- 图片/批量图片/视频权限与独立倍率。
- 图片和视频规格价格、Web Search 价格。
- fallback 分组、无效请求 fallback。
- OAuth、隐私设置、Claude Code 和 Messages Dispatch 限制。
- 推理强度上限与映射。

这足以支持完整的分组管理界面，但创建、更新、删除接口仍需先确认请求方法、请求体和冲突语义。

## 3. 建议功能范围

### 3.1 CPA 管理

第一阶段建议提供：

1. 认证文件列表：名称、提供方、账号、套餐、状态、是否禁用、最后刷新时间。
2. 上传 JSON：单文件和批量文件，上传前本地解析与安全校验。
3. 启用/停用：使用不透明 ID 定位上游认证文件。
4. 删除：二次确认，先检查最近使用情况，删除后立即重新拉取列表确认结果。
5. 连通性验证：通过 CPA 的受控 `api-call` 做只读探测。
6. 额度刷新：复用当前已有能力。

暂不建议第一阶段提供“下载原始认证文件”。下载会把可直接使用的访问凭据重新暴露给浏览器，
其风险显著高于上传和状态管理。如确有需求，应增加再次验证管理员密码、短时下载令牌和独立审计事件。

### 3.2 Sub2API 账号管理

第一阶段建议提供：

1. 账号列表和详情：复用现有额度数据，增加平台、调度、并发、优先级、代理和分组信息。
2. JSON 导入：选择平台后上传平台认证 JSON，转换为 Sub2API 对应的 `credentials` 结构。
3. 基础编辑：名称、备注、状态、可调度、优先级、并发和倍率。
4. 分组分配：多选分组，将完整目标 `group_ids` 集合提交给上游。
5. 连通性与额度验证：导入后先验证，再允许进入调度池。
6. 删除/停用：默认优先停用；永久删除必须确认当前并发为零。

平台凭据格式可能不同，不应只提供一个无结构的 JSON 文本框。建议实现平台适配器：

```text
上传文件
  -> JSON 语法与大小校验
  -> 平台识别/用户确认
  -> 平台适配器校验必要字段
  -> 生成 Sub2API credentials 请求体
  -> 预览非敏感元数据
  -> 提交上游
  -> 主动验证
  -> 分配分组并启用调度
```

无法识别的平台可保留“高级原始 JSON”模式，但必须只对管理员开放，并明确显示不会在 Hub 中保存原文。

### 3.3 Sub2API 分组管理

建议分成两层：

- 第一阶段：读取分组、搜索、查看策略、给账号分配已有分组。
- 第二阶段：创建、复制、编辑和删除分组；提供价格、限额、图片/视频权限和 fallback 编辑器。

删除分组前必须：

1. 查询引用该分组的账号数量和 fallback 引用。
2. 禁止删除仍被引用的分组，或要求明确选择替代分组。
3. 上游成功后重新拉取分组与账号关系完成对账。

## 4. 建议架构

### 4.1 管理连接与流量渠道分离

当前 Hub 的 `channels` 保存的是数据面 API Key，而 CPA Management Key、Sub2API Admin Key 仍来自全局环境变量。
如果未来要管理多个 CPA/Sub2API 实例，应新增独立的管理连接实体，而不是复用渠道 API Key：

```text
upstream_management_connections
- id
- name
- type: cpa | sub2api
- base_url
- encrypted_admin_credential
- linked_channel_id (nullable)
- enabled
- capabilities
- last_probe_at / last_error
- created_at / updated_at
```

第一版只有一个 CPA 和一个 Sub2API 时可以继续使用环境变量，但 API 和页面内部应按“管理连接”抽象，
避免以后把全局单例逻辑散落到每个功能中。

### 4.2 操作日志而非跨系统事务

Hub 数据库事务不能回滚已经成功的上游写操作。建议新增操作表：

```text
upstream_control_operations
- id / request_id
- connection_id
- action
- target_type / target_ref
- idempotency_key_hash
- request_fingerprint
- status: pending | succeeded | failed | reconciliation_required
- upstream_status / upstream_request_id
- safe_summary
- started_at / completed_at
```

操作流程：

```text
校验请求 -> 写 pending 操作 -> 调用上游 -> 写结果 -> 重新读取上游确认 -> 写审计
```

如果上游请求超时且结果不明确，状态必须是 `reconciliation_required`，不能自动重试上传、创建或删除，
以避免重复账号和重复认证文件。

### 4.3 API 设计建议

建议新增以下 Hub 管理 API；路径不直接照搬上游，以便屏蔽版本差异：

```text
GET    /api/admin/upstreams
POST   /api/admin/upstreams/:id/probe

GET    /api/admin/upstreams/:id/cpa/auth-files
POST   /api/admin/upstreams/:id/cpa/auth-files
PATCH  /api/admin/upstreams/:id/cpa/auth-files/:opaqueId
DELETE /api/admin/upstreams/:id/cpa/auth-files/:opaqueId

GET    /api/admin/upstreams/:id/sub/accounts
POST   /api/admin/upstreams/:id/sub/accounts/import
PATCH  /api/admin/upstreams/:id/sub/accounts/:opaqueId
DELETE /api/admin/upstreams/:id/sub/accounts/:opaqueId
POST   /api/admin/upstreams/:id/sub/accounts/:opaqueId/verify

GET    /api/admin/upstreams/:id/sub/groups
POST   /api/admin/upstreams/:id/sub/groups
PATCH  /api/admin/upstreams/:id/sub/groups/:opaqueId
DELETE /api/admin/upstreams/:id/sub/groups/:opaqueId
```

所有写 API 必须使用现有管理员会话、CSRF 校验、共享限流、审计和请求 ID。

## 5. 安全要求

认证文件和平台凭据属于高危长期凭据，必须满足：

- 上传大小默认不超过 2 MiB；仅接受 JSON 或明确的 multipart JSON 文件。
- 在进入上游前完成 JSON 深度、字段数量和字符串长度限制，防止解析资源耗尽。
- 禁止把上传正文交给现有请求正文归档逻辑。
- 禁止在错误消息、应用日志、审计 `detail`、浏览器响应中返回原始认证内容。
- 审计只记录文件 SHA-256、平台、非敏感账号标识、目标分组和操作结果。
- 管理凭据继续使用 AES-256-GCM 加密，主密钥只来自服务端环境变量。
- 不允许用户提交任意上游 URL；目标必须来自已配置的管理连接，防止 SSRF。
- 上游返回内容继续按字段白名单映射，不能把完整 `credentials` 返回浏览器。
- 上传、删除、分组修改使用独立的低频限流。
- 删除和导出类操作要求再次确认；原始凭据导出默认不实现。

CPA/Sub2API 管理面应优先走 WireGuard 或私有网络；公开管理 API 必须限制来源 IP 并使用独立管理密钥。

## 6. 一致性与失败处理

| 场景 | 正确处理 |
| --- | --- |
| 上传前校验失败 | 不调用上游，返回字段级错误 |
| 上游明确返回 4xx | 标记失败，不自动重试 |
| 上游明确返回 5xx | 标记失败；创建/上传默认不自动重试 |
| 请求超时、结果不明确 | 标记待对账，按文件哈希或账号身份重新查询 |
| 创建成功但分组分配失败 | 保持账号停用，显示“待完成配置”，允许继续分配 |
| 删除成功但 Hub 未收到响应 | 重新读取上游列表确认，不重复删除 |
| 多管理员并发编辑（未来） | 使用 `updated_at`/版本进行乐观锁；当前单管理员仍保留版本检查接口 |

对于 Sub2API 导入，建议采用“创建为不可调度 -> 验证 -> 分组 -> 启用调度”的顺序，避免半配置账号进入生产流量。

## 7. 页面建议

管理后台新增一个“上游资源”一级菜单，下设：

- CPA 认证：紧凑表格、状态筛选、上传、停用、验证、删除。
- Sub2API 账号：账号、平台、状态、分组、并发、额度和最近错误。
- Sub2API 分组：策略列表、账号引用数、限额与倍率摘要、fallback 关系。
- 操作记录：待对账、失败和成功操作，支持按上游、动作、目标筛选。

上传流程使用分步弹窗：文件校验、非敏感预览、目标平台/分组、确认提交、验证结果。
页面不展示 access token、refresh token、cookie、私钥或完整认证 JSON。

## 8. 分阶段实施

### 阶段 0：接口契约确认

- 为当前 CPA/Sub2API 版本记录写接口方法、请求体、响应和错误码。
- 在影子实例完成一轮创建、更新、停用、分组、删除。
- 为每个写接口保存脱敏 fixture 和契约测试。

预计：2–4 个工程日。此阶段是后续写功能的必要门槛。

### 阶段 1：CPA 认证文件 MVP

- 列表、上传、启停、验证、删除。
- 上传安全校验、操作表、审计和对账。
- 不实现原始文件下载。

预计：4–7 个工程日。

### 阶段 2：Sub2API 账号导入与分组分配

- 账号详情、平台适配器、JSON 导入、验证、停用。
- 读取分组并分配已有分组。
- 失败时保持账号不可调度。

预计：7–12 个工程日，主要取决于需要支持的平台数量和凭据结构。

### 阶段 3：分组策略管理与加固

- 分组增删改、引用检查、fallback 编辑。
- 批量操作、操作对账、告警和备份恢复覆盖。
- E2E 覆盖超时、重复提交、上游 4xx/5xx 和部分成功。

预计：5–8 个工程日。

整体预计：18–31 个工程日，不包含上游缺失写接口时对 Sub2API/CPA 本体的改造成本。

## 9. 验收标准

- 上传认证 JSON 后，Hub 数据库、日志、审计和浏览器响应中不存在原始凭据。
- 同一文件重复提交不会创建重复资源；不明确结果能够自动进入对账状态。
- CPA 认证文件可列出、验证、启停和删除，操作后与上游状态一致。
- Sub2API 账号可导入、验证、分配分组、停用，并且半配置账号不会进入调度。
- 分组编辑能覆盖当前实例已确认的限额、倍率、图片权限和 fallback 字段。
- 删除被账号或 fallback 引用的分组会被阻止或要求显式迁移。
- 每个敏感操作都有管理员、时间、来源 IP 哈希、目标、结果和请求 ID 审计。
- 上游超时、重启和重复响应经过故障注入测试，不产生重复账号或不可恢复状态。

## 10. 最终建议

建议开发，但不要一次性把 CPA/Sub2API 全部管理接口做成透明代理。优先交付 CPA 认证文件管理和
Sub2API“账号导入 + 已有分组分配”，用统一的操作日志与安全上传管线打牢基础；分组策略 CRUD 在完成
当前 Sub2API 版本的写接口契约测试后进入下一阶段。

这种边界能够让 Zephyr Hub 成为真正的统一控制面，同时避免复制上游业务逻辑、泄露长期凭据，
或因跨系统写操作失败留下无法对账的数据。

## 11. 实施状态（2026-07-31）

本方案已在 Hub 中实现，管理入口为 `/admin/upstreams`：

- CPA：认证文件列表、单个/批量 JSON 上传、启停、能力验证和删除。
- Sub2API 账号：列表、平台适配导入、基础编辑、分组分配、主动验证、验证后启用和并发保护删除。
- Sub2API 分组：列表、完整限额/倍率/媒体价格/fallback 策略编辑、创建和引用保护删除。
- 操作记录：`pending / succeeded / failed / reconciliation_required` 状态、幂等指纹、请求 ID 和脱敏摘要。
- 安全管线：2 MiB 文件限制、JSON 深度/字段/字符串限制、敏感错误脱敏和不透明资源 ID。

数据库迁移为 `drizzle/0010_thankful_genesis.sql`。上游写契约通过模拟 CPA/Sub2API 测试验证；
开发与验收期间没有对当前配置的在线上游执行写操作。
