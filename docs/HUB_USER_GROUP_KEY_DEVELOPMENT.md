# Zephyr Hub 用户、分组与可回显 Key 开发文档

状态：设计草案  
日期：2026-07-31  
适用范围：Zephyr Hub 管理端、用户控制台、网关鉴权、用量与审计

## 1. 目标

本阶段将 Zephyr Hub 从单管理员控制台扩展为多用户 Hub，提供：

- 管理员与普通用户账户体系。
- 管理员和用户各自独立的首页与导航。
- 用户与分组的多对多成员关系，并在两个管理页面中双向编辑同一份数据。
- Key 归属用户和分组，支持分组权限、配额和用量归集。
- Key 同时保存鉴权哈希和可解密密文。
- 管理员可查看、复制、设置任意成员的完整 Key。
- 用户可随时查看和复制自己的完整 Key，但不能修改 Key 明文。
- 列表默认只显示 Key 前缀和后缀。
- 用户登录后查看自己的 Key、用量、额度、可用模型、分组和日志。
- 请求日志优先展示用户文本和响应文本，再展示系统上下文与原始 JSON。

## 2. 已确认的产品决策

### 2.1 Key 存储

Key 采用双存储：

- `key_hash`：HMAC-SHA-256，用于请求鉴权和唯一性检查。
- `encrypted_key`：AES-256-GCM 密文，用于授权后的完整值回显。

列表和普通详情接口不得返回 `encrypted_key` 或完整 Key，只返回：

- `maskedKey`，例如 `zh-Ab12Cd...9xYz`。
- `keyPrefix`。
- `keyLastFour`。
- `revealable`，表示是否具备可解密密文。

完整 Key 只能通过单独的 reveal 接口获取。

### 2.2 Key 权限

管理员：

- 查看任意 Key 完整值。
- 复制任意 Key 完整值。
- 为任意 Key 设置新的完整值。
- 修改 Key 名称、备注、用户、分组、状态和策略。
- 轮换、吊销和删除 Key。

普通用户：

- 查看和复制属于自己的完整 Key。
- 修改自己 Key 的名称和备注。
- 停用或启用自己的 Key，是否允许删除由系统设置控制。
- 不能设置、替换或编辑 Key 明文。
- 不能修改 Key 所属用户、分组、模型权限、额度和价格倍率。

### 2.3 用户与分组

- 用户和分组是多对多关系。
- `group_memberships` 是唯一事实来源。
- 用户管理页修改成员分组和分组页修改成员用户，必须调用同一套成员关系服务。
- 一个 Key 只绑定一个用户和一个分组。
- Key 所属用户必须是 Key 所属分组的有效成员。
- 管理员转移 Key 时必须同时满足该约束。

一个 Key 不绑定多个分组。这样可以保证额度扣减、价格、路由和历史归属没有歧义。

### 2.4 权限合并

有效权限采用最严格原则：

```text
系统可用范围 ∩ 分组策略 ∩ Key 策略 = Key 最终权限
```

- 下级规则只能收紧上级规则。
- 空模型或端点列表表示继承上级全部范围，不表示绕过上级限制。
- 请求数、Token、成本和并发限制取所有非空限制中的最小值。
- 价格倍率按产品配置决定乘积或覆盖。本项目采用乘积：`groupMultiplier * keyMultiplier`。

## 3. 安全要求

可解密 Key 会扩大泄露影响范围，以下要求均为强制项。

### 3.1 独立加密密钥

不得直接复用日志正文的 `NUXT_ENCRYPTION_KEY`。新增独立 Key 密钥环：

```env
NUXT_HUB_KEY_ENCRYPTION_ACTIVE_VERSION=v1
NUXT_HUB_KEY_ENCRYPTION_KEYS={"v1":"<32-byte-base64-key>"}
```

- 每条 Key 使用独立随机 12 字节 IV。
- 使用 AES-256-GCM。
- 加密时加入 AAD：`zephyr-hub-key:{keyId}:{credentialId}:{version}`。
- 密文格式记录算法版本和密钥版本。
- 主密钥只从运行环境或外部密钥管理系统读取，不写入数据库。
- 生产环境备份数据库时，不得在同一备份中包含主密钥。

### 3.2 完整值查看

Reveal 接口必须：

- 使用 `POST`，不能使用可被缓存或预取的 `GET`。
- 校验当前会话、角色和 Key 所有权。
- 管理员查看其他用户 Key 时要求最近重新验证密码，后续可接 MFA。
- 用户查看自己的 Key 时要求有效登录会话，建议超过 10 分钟未重新验证时要求输入密码。
- 按用户、IP 和 Key ID 限流。
- 返回 `Cache-Control: no-store, private`、`Pragma: no-cache`。
- 不把完整 Key 写入应用日志、审计详情、错误跟踪或前端持久化状态。
- 页面关闭弹窗或离开路由时清空完整值。
- 不写入 `localStorage`、`sessionStorage` 或 URL。

审计日志只记录“谁在何时查看了哪个 Key”，不能记录 Key 明文。

### 3.3 管理员设置 Key 明文

管理员设置完整 Key 时：

- 接受 16 到 512 个可打印非空白 ASCII 字符。
- 不自动 trim 后再存储；校验通过后的值必须原样使用。
- 同一事务内计算 HMAC、加密密文、更新前后缀并检查唯一性。
- 从审计和错误内容中删除请求正文。
- 旧凭据不直接覆写，创建新的凭据版本并将旧版本吊销或设置宽限期。
- UI 可以称为“编辑 Key 值”，底层仍按凭据版本切换实现，以保留审计链。

### 3.4 前端显示

- Key 列表始终脱敏。
- 完整 Key 放在专用弹窗中，默认使用密码样式遮挡。
- 提供显示/隐藏和复制按钮。
- 复制后给出局部状态反馈，不在全局通知中包含 Key。
- 浏览器截图、分析事件和前端错误上报必须排除 Key 元素内容。

## 4. 数据模型

### 4.1 用户

新增统一用户表 `users`，逐步替代只支持管理员的 `admin_users`：

```text
users
- id uuid primary key
- username text unique not null
- display_name text
- email text unique nullable
- password_hash text not null
- role enum: super_admin | admin | operator | auditor | user
- status enum: active | disabled | locked
- must_change_password boolean
- last_login_at timestamptz
- password_changed_at timestamptz
- created_at / updated_at
```

第一阶段 UI 只暴露 `admin` 和 `user`，数据库保留细分角色能力。

### 4.2 分组

```text
groups
- id uuid primary key
- name text unique not null
- description text
- status enum: active | disabled
- allowed_endpoints jsonb
- rpm_limit integer nullable
- concurrency_limit integer nullable
- daily_request_limit bigint nullable
- daily_token_limit bigint nullable
- daily_cost_limit numeric nullable
- weekly_request_limit bigint nullable
- weekly_token_limit bigint nullable
- weekly_cost_limit numeric nullable
- monthly_request_limit bigint nullable
- monthly_token_limit bigint nullable
- monthly_cost_limit numeric nullable
- price_multiplier numeric default 1
- created_at / updated_at
```

分组模型和渠道使用关系表：

```text
group_model_rules(group_id, public_model)
group_channel_rules(group_id, channel_id, enabled, priority_override, weight_override)
```

没有 `group_model_rules` 表项表示继承系统全部可用模型。

### 4.3 分组成员

```text
group_memberships
- group_id uuid references groups
- user_id uuid references users
- membership_role enum: member | manager
- created_by uuid references users
- created_at
- primary key(group_id, user_id)
```

所有成员更新都通过 `GroupMembershipService`，禁止用户页和分组页各自维护独立字段。

### 4.4 Hub Key

修改 `hub_keys`：

```text
+ owner_user_id uuid references users
+ group_id uuid references groups
+ encrypted_key text nullable
+ encryption_key_version text nullable
+ secret_updated_at timestamptz nullable
+ secret_updated_by uuid references users nullable
```

修改 `hub_key_credentials`：

```text
+ encrypted_key text nullable
+ encryption_key_version text nullable
+ created_by uuid references users nullable
```

保留现有字段：

- `key_hash` 用于鉴权。
- `key_prefix`、`key_last_four` 用于脱敏显示。
- `hub_key_credentials` 用于轮换、宽限和吊销。

约束：

- `hub_keys(owner_user_id, group_id)` 建索引。
- `key_hash` 保持唯一。
- 服务层保证 owner 是 group 成员。
- 新数据要求 `encrypted_key` 非空；迁移期允许旧数据为空。

### 4.5 用量归属

在 `request_logs` 和 `usage_rollups` 中增加：

```text
+ user_id uuid nullable
+ group_id uuid nullable
```

请求准入时将 Key 当时的用户和分组写入日志快照。之后即使 Key 转组，历史数据也不会改变归属。

`usage_rollups` 唯一维度加入 `user_id` 和 `group_id`，支持管理员和用户面板高效查询。

## 5. 旧 Key 迁移

现有 Key 只有 HMAC 哈希，无法恢复明文。

迁移流程：

1. 新增可空的密文字段和 `revealable` 计算逻辑。
2. 为现有管理员创建对应的 `users` 记录。
3. 创建“默认分组”，将旧 Key 暂时归到管理员和默认分组。
4. 旧 Key 保持鉴权可用，但显示“当前 Key 尚未保存可回显密文”。
5. 管理员通过“设置 Key 值”录入新值，或生成新值。
6. 设置完成后创建新凭据版本，旧值按选择立即吊销或进入宽限期。
7. 所有存量 Key 完成迁移后，再考虑把新记录的密文字段改成数据库非空约束。

不得尝试从哈希反推旧 Key，也不得把旧客户端提交的 Bearer Key 在请求过程中静默回填为密文。

## 6. 认证与授权

### 6.1 会话

统一登录服务，Redis 保存会话：

```text
session = {
  userId,
  username,
  role,
  authenticatedAt,
  reauthenticatedAt
}
```

- 管理员和普通用户统一使用 `/login`，登录后按角色进入 `/admin` 或 `/console`。
- 用户端使用 `/login`，登录后进入 `/console`。
- 同一身份服务根据角色限制页面和 API。
- Cookie 为 `HttpOnly + SameSite=Strict`，生产环境启用 `Secure`。
- 密码继续使用 Argon2id。

### 6.2 权限矩阵

| 操作 | 管理员 | 用户本人 | 其他用户 |
| --- | --- | --- | --- |
| 查看 Key 脱敏值 | 是 | 是 | 否 |
| 查看/复制 Key 完整值 | 是 | 是 | 否 |
| 设置 Key 完整值 | 是 | 否 | 否 |
| 修改 Key 名称/备注 | 是 | 是 | 否 |
| 修改 Key 分组/策略/额度 | 是 | 否 | 否 |
| 查看 Key 用量 | 是 | 是 | 否 |
| 查看请求正文 | 是 | 本人且策略允许 | 否 |
| 管理用户 | 是 | 否 | 否 |
| 管理分组成员 | 是 | 否 | 否 |
| 查看上游账号身份与余量 | 是 | 否 | 否 |

所有服务端 API 必须重新校验权限，不能依赖前端隐藏按钮。

## 7. API 设计

### 7.1 管理员用户管理

```text
GET    /api/admin/users
POST   /api/admin/users
GET    /api/admin/users/:id
PATCH  /api/admin/users/:id
POST   /api/admin/users/:id/reset-password
POST   /api/admin/users/:id/unlock
DELETE /api/admin/users/:id
PUT    /api/admin/users/:id/groups
```

`PUT /groups` 接受完整 group ID 集合，以事务方式同步 `group_memberships`。

### 7.2 管理员分组管理

```text
GET    /api/admin/groups
POST   /api/admin/groups
GET    /api/admin/groups/:id
PATCH  /api/admin/groups/:id
DELETE /api/admin/groups/:id
PUT    /api/admin/groups/:id/users
PUT    /api/admin/groups/:id/models
PUT    /api/admin/groups/:id/channels
```

`PUT /users` 与用户管理页的 `PUT /groups` 调用同一个成员同步服务。

### 7.3 管理员 Key

保留现有 Key CRUD，并新增：

```text
POST /api/admin/keys/:id/reveal
PUT  /api/admin/keys/:id/secret
POST /api/admin/keys/:id/transfer
```

`PUT /secret`：

```json
{
  "password": "current-admin-password",
  "key": "complete-key-value",
  "graceSeconds": 0
}
```

响应只在成功时返回一次新设置的完整值。之后仍可通过 reveal 获取。

### 7.4 用户控制台

```text
POST  /api/auth/login
POST  /api/auth/logout
GET   /api/auth/session
POST  /api/auth/reauthenticate

GET   /api/console/overview
GET   /api/console/keys
GET   /api/console/keys/:id
PATCH /api/console/keys/:id
POST  /api/console/keys/:id/reveal
GET   /api/console/usage
GET   /api/console/groups
GET   /api/console/models
GET   /api/console/logs
GET   /api/console/logs/:id
```

用户 `PATCH key` 请求体只允许 `name`、`note` 和允许的状态字段。出现额外敏感字段时返回 400，而不是静默忽略。

## 8. 页面设计

### 8.1 管理员首页 `/admin`

显示：

- 请求、Token、成本、成功率、P95 首字节和总耗时。
- 活跃用户、活跃分组和活跃 Key。
- 渠道健康、可调度账号容量和告警。
- 用户与分组用量排行。
- 额度即将耗尽、Key 即将过期、异常错误率。

### 8.2 用户首页 `/console`

显示：

- 今日、本周、本月请求、Token 和成本。
- 个人与所属分组剩余额度。
- 自己的 Key 状态和最后使用时间。
- 可用模型、价格、端点和当前服务状态。
- 最近错误请求和到期提醒。

不显示 CPA/Sub2API 账号邮箱、认证文件、代理、单账号身份或原始上游管理数据。

### 8.3 用户管理 `/admin/users`

- 搜索、角色、状态和分组筛选。
- 创建、编辑、禁用、重置密码。
- 用户详情抽屉显示用量、Key、分组和最近活动。
- 分组区域使用复选列表，保存后同步 `group_memberships`。
- 管理员可进入该用户的 Key 管理视图。

### 8.4 分组设置 `/admin/groups`

- 分组列表显示成员数、Key 数、用量、额度和状态。
- 分组详情编辑成员、模型、端点、渠道池、额度和价格倍率。
- 成员区域勾选用户。
- 保存后用户管理页立即反映相同成员关系。
- 删除有成员或 Key 的分组前要求迁移目标，不允许产生无归属 Key。

### 8.5 Key 页面

管理员 Key 页面增加：

- 所属用户和分组列。
- 用户、分组筛选器。
- 铅笔图标用于策略编辑，避免当前 Key 图标语义不清。
- “查看完整 Key”操作。
- “设置 Key 值”操作，仅管理员可见。
- 转移用户和分组操作。

用户 Key 页面：

- 列表只显示脱敏值。
- 查看按钮打开完整值弹窗。
- 复制按钮在授权 reveal 后复制完整值。
- 编辑只允许名称和备注。
- 明确显示分组、权限、额度、到期时间和最近使用。

### 8.6 请求日志详情

建议固定顺序：

1. 用户消息。
2. 助手响应。
3. 工具调用和工具结果。
4. 折叠的系统/开发者上下文。
5. 原始请求 JSON 树。
6. 原始响应 JSON/SSE 事件树。
7. 图片预览。
8. 调度轨迹、渠道、耗时和错误元数据。

系统或开发者消息来自客户端的 `instructions`、`system`、`developer` 内容。Hub 当前不注入这些提示词。普通用户查看日志时，可按系统策略隐藏开发者上下文，避免业务应用的内部提示词泄露。

## 9. 用量、额度与账号余量

管理员：

- 查看全局、用户、分组、Key、模型、渠道和上游账号维度。
- 查看 CPA/Sub2API 的具体账号状态和余量。
- 导出 CSV。

用户：

- 查看自己的 Hub Key 用量。
- 查看自己和所属分组的已用/剩余额度。
- 查看可用模型和公开价格。
- 不查看具体上游账号身份和认证数据。
- 如需展示容量，只返回匿名聚合状态，例如“容量充足/紧张”，不返回账号明细。

额度扣减必须以网关准入时的用户、分组和 Key 快照为准，并避免并发超额。

## 10. 审计事件

至少记录：

```text
user.create / user.update / user.disable / user.password_reset
group.create / group.update / group.members_sync / group.delete
key.create / key.update / key.reveal / key.secret_replace
key.transfer / key.rotate / key.revoke / key.delete
session.login / session.logout / session.reauthenticate
```

审计详情允许记录字段名和变更摘要，但禁止记录：

- Key 明文或密文。
- 密码或密码哈希。
- 会话 Token。
- 上游认证信息。
- 请求正文中的敏感凭据。

## 11. 实施阶段

### 阶段 1：身份与基础权限

- 新增 `users`、统一会话和角色守卫。
- 迁移现有管理员。
- 创建用户登录页和管理员用户管理 API。
- 保持现有管理员路径兼容。

### 阶段 2：分组

- 新增 groups、memberships、模型和渠道关系表。
- 实现 GroupMembershipService。
- 完成用户管理与分组页面的数据互通。

### 阶段 3：可解密 Key

- 新增独立 Key 加密密钥环。
- 为 hub_keys 和 credentials 添加密文字段。
- 实现 reveal、管理员 secret replace 和用户所有权校验。
- 完成旧 Key 的不可回显兼容状态和迁移 UI。

### 阶段 4：Key 归属与策略

- Key 绑定用户和单一分组。
- 网关执行系统、分组、Key 的权限交集。
- 请求日志和 rollup 写入用户、分组快照。
- 管理员和用户 Key 页面完成。

### 阶段 5：双控制台

- 管理员首页扩展用户和分组指标。
- 用户首页、用量、分组、模型和日志页面。
- 替代当前依赖手动输入 API Key 的自助查询流程。

### 阶段 6：运营能力

- 额度告警、到期提醒、异常调用提醒。
- CSV 导出、Webhook、审批和 MFA。
- 密钥轮换运维工具和密钥版本迁移。

## 12. 验收标准

### Key

- 新建 Key 同时保存唯一哈希和 AES-GCM 密文。
- 管理员可以设置任意符合格式要求的 Key 完整值。
- 用户不能通过 UI 或 API 修改完整值。
- 管理员和 Key 所有人可通过独立接口查看并复制完整值。
- 非所有者 reveal 返回 404 或 403，且不会泄露 Key 是否存在。
- 列表、日志、审计和错误中没有完整 Key。
- 密文被篡改时解密失败且产生安全告警。
- Key 加密密钥版本可以轮换。

### 用户与分组

- 用户页勾选分组后，分组页立即显示该用户。
- 分组页移除用户后，用户页立即移除该分组。
- 非分组成员不能持有该分组的新 Key。
- 分组禁用后，其 Key 请求被拒绝。
- Key 权限不能超过分组权限。
- 历史用量不会因用户或 Key 转组而改变归属。

### 控制台

- 管理员和用户登录后进入不同首页。
- 用户只能看到自己的 Key、用量和日志。
- 用户不能看到原始上游账号身份和凭据。
- 管理员操作产生完整审计记录。
- 请求日志先显示用户文本和响应文本，再显示原始 JSON。

## 13. 测试范围

- 数据库迁移和旧 Key 兼容测试。
- AES-GCM 加解密、AAD、篡改和错误密钥版本测试。
- Key 哈希与密文一致性测试。
- reveal 权限、重新验证、限流和 no-store 响应头测试。
- 管理员 secret replace 的事务与唯一冲突测试。
- 用户越权和批量 ID 猜测测试。
- 用户与分组双向同步测试。
- 分组、Key 策略交集测试。
- 用户、分组、Key 用量归属与并发额度测试。
- 管理员和用户桌面/移动端页面测试。
- 日志脱敏和审计不包含明文 Key 的测试。

## 14. 后续功能建议

完成本阶段后，优先考虑：

- MFA、OIDC/LDAP 和管理员细粒度 RBAC。
- 用户自助申请分组或额度，管理员审批。
- 用户与分组预算告警。
- Key 异常 IP、异常模型和突增调用检测。
- 分组级路由容量和服务等级策略。
- Webhook、邮件通知和账单导出。
- 数据保留策略与用户日志正文访问开关。
