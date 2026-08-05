# GPTSession 转换功能接入 Zephyr Hub 管理端可行性报告

状态：可行性评审稿

日期：2026-07-31

目标仓库：<https://github.com/gtxx3600/GPTSession2CPAandSub2API>

分析基线：`a097eb155bb7bdf6cbbc26f1e4e75e120ab3163c`（2026-06-10）

核验结果：目标仓库当前默认分支仍指向该提交，上游转换测试已在本地通过

## 1. 结论

将该仓库的 ChatGPT Session 转换能力接入 Zephyr Hub 管理端是可行的，推荐可行性为“高”。Hub 已经具备转换结果的两条正式落地通道：

- CPA：认证 JSON 上传、状态管理、验证、删除和上传后对账。
- Sub2API：账号创建、逐账号分组、默认启用调度、验证、编辑、删除和操作对账。

不建议直接嵌入原仓库的 `docs/index.html`，也不建议通过 iframe 或运行时访问 GitHub Pages。推荐把其中的纯转换规则移植为 Hub 自有的 TypeScript 模块，在浏览器内完成解析和非敏感预览，管理员确认后再调用 Hub 现有的 CPA/Sub2API 管理接口。

必须在移植时修正一个关键兼容问题：上游项目生成 Sub2API 账号时没有把输入中的 `refresh_token`、`id_token` 和 `session_token` 写入输出，只保留了 `access_token`。原样使用会把可自动刷新的账号退化为 access token 到期即失效的短期账号。

建议第一版只支持 Hub 当前实际管理的两个目标：`CPA`、`Sub2API`。Cockpit、9router、Codex、AxonHub 和 Codex-Manager 可以保留在转换核心的扩展设计中，但不应在没有对应管理连接的情况下出现在“直接导入”界面。

## 2. 分析证据

### 2.1 上游仓库形态

目标仓库是 MIT 许可的纯前端单页工具，不包含后端服务和第三方运行时依赖：

- 核心逻辑全部位于 `docs/index.html` 的内联 JavaScript。
- 输入只在浏览器内通过 `JSON.parse`、文件读取和 JWT payload 解码处理。
- 页面声明不上传 token，也不使用本地存储。
- 仓库测试使用 Node VM 提取页面脚本，覆盖 10 个转换场景。
- 在分析基线提交上执行 `node --test tests/convert-session.test.js`，测试通过。
- MIT 许可允许复制、修改和再发布，但移植代码时必须保留版权和许可声明。

该项目没有发布 npm 包，也没有稳定的模块 API。直接复制 HTML 会把 UI、DOM 操作、转换规则和下载逻辑耦合进 Hub，后续难以测试和升级。因此应移植算法，不应嵌入页面。

### 2.2 支持的输入

上游解析器会递归查找包含 access token 和账号身份信息的对象，已明确支持：

- ChatGPT Web session JSON。
- 9router Codex OAuth JSON。
- Codex 原生 `auth.json`。
- AxonHub Codex auth JSON。
- Codex-Manager 单个或批量 JSON。
- 常见的 camelCase、snake_case 和 `tokens`、`token`、`credentials` 嵌套形式。

其通用递归规则也能识别部分 CPA JSON 和 Sub2API 导出包，但这两类输入没有被上游测试完整覆盖，Hub 不能把“偶然可识别”当成稳定契约。移植后应把 CPA 单文件、Sub2API 单账号和 `sub2api-data` 批量包加入正式测试矩阵。

### 2.3 上游提取字段

转换器从输入对象、access token JWT payload 和 id token JWT payload 中尝试提取：

- `access_token`、`refresh_token`、`session_token`、`id_token`。
- 邮箱、显示名称、用户 ID、ChatGPT account ID、workspace ID。
- 计划类型、过期时间、刷新时间、启停状态。

JWT 处理只是 Base64URL 解码，不验证签名。该行为适合“格式识别和预览”，不能用于证明账号身份、权限或 token 真实性。

### 2.4 Hub 当前能力

Hub 已有以下可复用实现：

- [CPA 上传 API](../server/api/admin/upstreams/cpa/auth-files/index.post.ts)：支持 JSON/multipart、单批最多 20 个文件、输入校验、SHA-256 指纹、限流、操作记录、审计和 `207` 部分成功。
- [Sub2API 导入 API](../server/api/admin/upstreams/sub/accounts/import.post.ts)：支持单账号和最多 100 个账号的批量导入、平台凭据校验、逐账号分组、默认启用调度、部分成功和审计。
- [安全 JSON 工具](../server/utils/safe-json.ts)：限制 2 MiB、24 层嵌套、10,000 个字段和超长字符串。
- [上游操作编排](../server/services/upstream-operations.ts)：提供幂等指纹、操作状态、超时后的待对账状态和安全摘要。
- [上游资源页面](../app/pages/admin/upstreams.vue)：已有 CPA 认证、Sub2API 账号、Sub2API 分组、操作记录，以及“先解析、后逐账号选组”的导入交互。

因此本功能不需要创建另一套账号管理系统，主要工作是扩展输入适配和转换预览。

但现有能力不能直接等同于本次转换功能：

| 能力 | 当前 Hub | 接入后需要达到 |
| --- | --- | --- |
| 输入识别 | 识别 Sub2API 包、账号对象或裸凭据 | 递归识别 ChatGPT Session、Codex OAuth 及上游支持的多种嵌套格式 |
| 目标生成 | 只把已有目标格式送入对应上游 | 从统一凭据对象生成 CPA 与 Sub2API 两种目标格式 |
| CPA 校验 | 仅验证 JSON 大小、深度和基本结构 | 增加 CPA 字段级校验、身份冲突和 token 到期检查 |
| Sub2API 凭据 | 保留输入中已有的凭据字段 | 转换时明确保留 refresh/session/id token，避免只剩短期 access token |
| 批量交互 | Sub2API 已可逐账号预览和选组 | 增加逐账号目标选择、警告、去重和 CPA/Sub2API 分目标结果 |

现有 Sub2API 批量包直传接口也不适合承担转换后的逐账号配置：它把整个包交给上游 `/accounts/data`，不能为每一项应用独立分组和转换警告。本功能应优先使用当前逐账号批量分支。

## 3. 推荐产品方案

### 3.1 菜单位置

在管理员端“上游资源”页面增加“凭据转换”标签页，并在 CPA 认证和 Sub2API 账号页面的新增按钮旁提供快捷入口。

不建议新增一个孤立的一级菜单。转换是上游资源导入的前置步骤，与账号列表、分组选择、验证结果和操作记录放在同一工作区更连贯。

### 3.2 页面流程

页面采用两阶段流程，默认首先显示文件选择区，粘贴输入作为可展开的次要方式：

```text
选择或拖入 JSON / 展开后粘贴 JSON
                 |
          浏览器内解析和去重
                 |
     账号预览、警告、目标与分组配置
                 |
        管理员选择要导入的账号
                 |
      确认导入 CPA / Sub2API / 两者
                 |
      逐项结果、验证、重试与操作记录
```

解析成功后显示账号列表。每一项应支持：

- 勾选或取消导入。
- 显示解析出的名称、邮箱、账号 ID、套餐、token 到期时间和来源文件。
- 显示“可刷新”“仅短期 access token”“使用合成 id token”“已过期”“字段冲突”等状态。
- 独立选择目标：CPA、Sub2API 或两者。
- Sub2API 独立选择一个或多个上游分组，默认选中名称精确匹配 `Codex` 的活动分组，允许手动更改。
- 独立设置并发、优先级和倍率；默认值沿用当前 Hub 的 10、0、1。
- 默认“导入后立即调度”为开启。创建过程中仍先置为不可调度，分组配置成功后再启用，避免半配置账号接收请求。
- 对重复账号选择“跳过”或“更新”；第一版默认跳过，不提供无提示覆盖。

输入原文和完整转换结果默认不展示。粘贴内容解析完成后立即清空输入控件；高级检查区只能在管理员主动展开后显示脱敏 JSON 树，token 字段只显示前后少量字符。除正在输入的文件/粘贴控件外，不能把完整 token 放入渲染 DOM、通知、URL 或浏览器持久化存储。

### 3.3 批量结果

导入完成后按账号和目标分别显示结果：

| 账号 | CPA | Sub2API | 后续动作 |
| --- | --- | --- | --- |
| A | 成功并已验证 | 成功、已分组、已调度 | 无 |
| B | 已存在，跳过 | 创建失败 | 修正后仅重试 Sub2API |
| C | 待对账 | 未提交 | 先对账，禁止重复上传 |

跨 CPA 与 Sub2API 的导入无法形成数据库原子事务。一个目标成功、另一个失败时不能自动删除已成功的数据，应保留逐目标状态并允许定向重试。

## 4. 转换规则

### 4.1 规范化中间对象

建议先将所有输入转换为内部对象，再生成目标格式：

```ts
interface NormalizedCodexCredential {
  sourceName: string
  sourcePath: string
  email: string | null
  displayName: string | null
  accountId: string | null
  userId: string | null
  workspaceId: string | null
  planType: string | null
  accessToken: string
  refreshToken: string | null
  sessionToken: string | null
  idToken: string | null
  accessTokenExpiresAt: number | null
  sourceLastRefreshAt: string | null
  disabled: boolean
  warnings: ConversionWarning[]
}
```

目标生成器只能读取该对象，不能各自重新遍历任意输入 JSON。这样可以让 CPA 与 Sub2API 使用同一份身份识别、冲突检查和到期判断。

### 4.2 CPA 输出

CPA 输出沿用当前兼容字段：

- `type: "codex"`。
- `account_id`、`chatgpt_account_id`、邮箱、名称和计划类型。
- 原样保留 `access_token`、`refresh_token`、`session_token` 和真实 `id_token`。
- 保留来源的 `last_refresh`；没有来源时间时才使用转换时间。
- 没有真实 id token 且 CPA 确实需要时，可生成带明确 `id_token_synthetic: true` 标记的占位 JWT。

上游合成 id token 使用 `alg: none`，第三段只是固定文本 `synthetic`，没有可验证的密码学签名，只能满足部分 CPA 解析器的结构要求。它不能用于身份验证，默认应显示高风险警告；若当前 CPA 版本不要求 id token，则不应生成。

CPA 文件名建议使用 `codex-{email-safe}-{account-id-short}.json`。相同账号应得到稳定文件名，不能把每次转换时间放入文件名造成重复认证文件。

### 4.3 Sub2API 输出

Sub2API 每个账号应生成：

```text
name / platform=openai / type=oauth
concurrency / priority / rate_multiplier
credentials:
  access_token
  refresh_token（有则必须保留）
  session_token（有则必须保留）
  id_token（有则必须保留）
  chatgpt_account_id / chatgpt_user_id / email / plan_type
extra:
  email / name / source / last_refresh
```

到期规则：

- 存在真实 `refresh_token`：不使用 access token 的 `exp` 把整个账号标记为到期，也不设置自动暂停时间。
- 不存在 `refresh_token`：从 access token 的 `exp` 设置账号级 `expires_at`，并设置 `auto_pause_on_expired: true`。
- access token 已过期且没有 refresh token：默认禁止导入，管理员可以在高级确认后导入为不可调度账号。

这套规则兼容用户此前提供的 `sub2api-data` 格式，同时修复上游项目遗漏刷新和身份 token 的问题。

## 5. 技术架构

### 5.1 模块拆分

建议新增：

```text
shared/utils/credential-converter/
  types.ts
  parse.ts
  jwt.ts
  normalize.ts
  targets/cpa.ts
  targets/sub2api.ts
  redact.ts
  index.ts
```

模块必须是无 DOM、无网络、无 Node 专用 API的纯 TypeScript，以便浏览器预览和服务端测试共同使用。不要从 GitHub 在运行时加载脚本，也不要增加 iframe、远程模块或第三方 CDN。

转换模块只负责格式处理；真正写入上游继续走现有服务：

```text
转换器 -> CPA auth-files API -> uploadManagedCpaAuthFile
       -> Sub accounts import API -> createManagedSub2ApiAccount
```

第一版无需新增“预览 API”，因为预览在浏览器内完成可以减少原始凭据经过服务端的次数。提交时服务端仍必须把浏览器生成的目标对象视为不可信输入，执行现有大小、结构、平台字段和必要凭据校验。

### 5.2 建议 API 调整

现有 API 足以完成基础导入；`runUpstreamOperation` 已经读取 `Idempotency-Key`，也已有服务端回退幂等指纹。建议保留这些能力并做以下兼容扩展：

- CPA 批量 JSON 请求支持每项独立稳定文件名和客户端批次 ID，继续保留 20 项限制。
- Sub2API 批量请求增加可选 `conversionBatchId`，每项继续使用自己的 `groupIds`。
- 前端必须按“批次 ID + 账号指纹 + 目标”提交稳定的 `Idempotency-Key`，不能为重试重新生成随机值。
- 操作摘要增加安全的 `sourceFormat`、`conversionVersion` 和 `batchId`，不得记录任何 token。
- 结果返回每个输入项的客户端行 ID，避免批量部分失败时依靠数组下标关联。

不建议增加“输入任意 URL 后由服务器抓取 JSON”的功能，这会引入 SSRF 和远程凭据泄露风险。

### 5.3 版本管理

移植模块应记录：

- 来源仓库 URL 和基线提交。
- MIT 版权与许可文本。
- Hub 自有 `conversionVersion`，例如 `gptsession-v1`。
- 与上游仓库的差异清单，至少包含 Sub2API token 保留修复、去重、冲突校验和权限控制。

后续升级必须通过代码审查和测试同步，不能在生产环境自动跟随 GitHub 最新版本。

## 6. 安全与权限

### 6.1 角色边界

转换和直接导入属于高权限写操作。第一版只允许 `super_admin` 和 `admin` 使用；普通用户和 `auditor` 必须拒绝，`operator` 是否允许应留到细粒度权限配置后决定。

当前两个导入路由调用 `requireAdmin`，会接受 `operator` 和 `auditor`；全局写请求中间件会另行阻止 `auditor`，因此审计员目前不能实际导入，但 `operator` 可以。若第一版按上述策略只允许 `super_admin/admin`，路由应直接改用现有 `requireAccountAdmin`，不能只依赖页面隐藏或中间件的角色特判。

### 6.2 凭据生命周期

- 文件内容只保存在页面内存中，不写入 `localStorage`、`sessionStorage`、IndexedDB 或 URL。
- 关闭弹窗、切换路由、退出登录、导入完成或空闲超时后清空源 JSON、规范化对象和输出。
- 不把完整 token 放入 Vue Devtools 友好的全局 store；使用页面局部、短生命周期状态。
- 不输出原始凭据到控制台、Nitro 日志、错误跟踪、请求日志正文或审计详情。
- 审计只保存操作者、目标、账号的非敏感标识、凭据 SHA-256/HMAC 指纹、转换版本和结果。
- 上游错误必须经过现有敏感信息清理器，界面不得回显上游返回的 token。
- 页面响应使用 `Cache-Control: no-store`；管理端保持同源 CSRF 校验，并建议补充严格 CSP。

### 6.3 JWT 与字段冲突

- JWT payload 解码不等于签名验证，界面必须使用“从 token 声明读取”，不能写成“已验证身份”。
- access token 与 id token 中的 account ID 不一致时默认阻止导入。
- 输入显式邮箱与 JWT 邮箱不一致时给出警告并要求管理员确认。
- 任何合成 id token 都必须携带显式标记，不得据其提升权限、确定套餐或绕过上游限制。
- 拒绝 `__proto__`、`prototype`、`constructor` 等危险字段进入规范化输出。
- 限制递归深度、对象数量、总账号数和单字段长度；浏览器与服务端限制保持一致。

### 6.4 产品风险提示

ChatGPT Web session 通常没有 refresh token，转换不能绕过 OpenAI 的手机绑定、账号权限、套餐限制或认证策略。页面需要准确显示账号是否可刷新及 access token 到期时间，不能把“格式转换成功”描述成“账号一定可用”。

### 6.5 上线前凭据处置

任何曾被粘贴到聊天、工单、Issue、应用日志或其他非专用密钥通道的真实 access、refresh、session、id token，都必须视为已泄露并在上线前撤销或轮换。开发和验收只能使用专用测试账号或已失效的脱敏样本，不能复用已暴露的生产凭据。

## 7. 去重、幂等与失败处理

### 7.1 去重键

浏览器解析阶段以以下顺序识别重复项：

1. ChatGPT account ID。
2. account ID + 邮箱。
3. 浏览器通过 Web Crypto 计算的仅存于内存的 access token SHA-256 指纹。

服务端提交阶段再使用服务端密钥 HMAC 或现有凭据 SHA-256 生成操作指纹。页面不能显示完整指纹；相同 token 出现在多个嵌套路径或多个文件时只保留一项，并列出来源位置。

### 7.2 上游已存在

- CPA：按稳定文件名和现有认证文件列表检测；默认跳过，覆盖必须二次确认并先停用旧文件。
- Sub2API：按 ChatGPT account ID 和邮箱检测；默认跳过。当前上游没有经 Hub 验证的安全“替换凭据”语义时，不应把重复创建称为更新。
- 同一批次的重复提交使用相同幂等键；上游超时且结果未知时进入 `reconciliation_required`，禁止一键重试。

### 7.3 部分失败

- JSON 或凭据结构错误：该项不调用上游，其他有效项仍可提交。
- CPA 上传成功但验证失败：保留认证文件为禁用状态并提示检查。
- Sub2API 创建成功但分组失败：保持不可调度，允许仅重试分组步骤。
- Sub2API 分组成功但启用失败：账号保留，显示“已配置、未调度”。
- 同一账号的 CPA 成功、Sub2API 失败：不自动回滚 CPA，只允许重试失败目标。

## 8. 实施阶段与工作量

| 阶段 | 内容 | 预计工作量 |
| --- | --- | --- |
| 1 | 移植纯 TypeScript 解析器、规范化模型、CPA/Sub2API 生成器和来源许可 | 2-3 人日 |
| 2 | 凭据转换标签页、文件/粘贴、账号预览、逐项目标与分组配置 | 2-3 人日 |
| 3 | 对接现有导入 API、批次关联、稳定幂等、重复检测和逐项结果 | 2-3 人日 |
| 4 | 权限收紧、安全清理、自动化测试、真实上游影子验证和文档 | 2-3 人日 |

第一版合计约 8-12 人日，不包含新增 Cockpit、9router、AxonHub 等管理连接。最大不确定性不在转换算法，而在 CPA 同名文件覆盖语义和 Sub2API 重复账号更新语义，需要在影子环境验证。

## 9. 测试计划

### 9.1 转换单元测试

- 移植并保留上游现有 10 个测试场景。
- ChatGPT Web session 单账号和数组批量输入。
- 9router、Codex、AxonHub、Codex-Manager、CPA 和 Sub2API 导出包。
- 同时保留 access、refresh、session 和 id token。
- 可刷新账号不使用 access token `exp` 暂停账号。
- 不可刷新账号正确设置秒级 `expires_at`。
- 多账号各自使用自己的过期时间和分组。
- 畸形 JWT、无身份对象、过深 JSON、超大 JSON、危险键和重复嵌套对象。
- account ID 冲突、邮箱冲突、已过期 token 和合成 id token 警告。

### 9.2 UI 测试

- 默认显示文件选择，粘贴区默认收起。
- 单账号和多账号均先预览后导入。
- 每项默认选中 Codex 分组且可独立修改。
- 默认启用“导入后立即调度”。
- 取消、关闭、超时和完成后清除内存中的凭据。
- 解析完成后，页面预览、通知、DOM 快照和浏览器存储中不存在完整 token；粘贴输入控件已清空。
- 部分失败能准确关联账号和目标并仅重试失败步骤。

### 9.3 集成与安全测试

- `auditor`、`operator`（默认策略下）和普通用户无法调用转换导入写接口。
- CSRF、限流、2 MiB、20 个 CPA 文件和 100 个 Sub2API 账号限制生效。
- 审计、操作记录、应用日志和错误响应不包含 token。
- 相同批次重复提交不会创建重复账号。
- 超时进入待对账，不自动重试有副作用的操作。
- 在影子 CPA/Sub2API 中验证真实 id token、缺少 id token、可刷新和不可刷新四类账号。

## 10. 验收标准

功能达到以下条件后可进入生产：

1. 管理员可上传或粘贴单个、数组及嵌套批量 JSON，并看到解析出的账号列表。
2. 每个账号可独立选择 CPA、Sub2API 或两者；Sub2API 默认 Codex 分组且可更改。
3. 有 refresh/session/id token 时目标格式不会丢失这些字段。
4. 默认导入后可调度，但账号只在创建和分组全部成功后进入调度。
5. 已过期、不可刷新、身份冲突、合成 id token 和重复账号均有明确状态与阻断规则。
6. 批量导入支持部分成功、逐项目标状态、定向重试和待对账。
7. 完整 token 不进入日志、审计、浏览器存储、URL、全局状态或普通预览 DOM。
8. 只有明确授权的管理员角色可以执行转换导入。
9. CPA 与 Sub2API 影子环境验证通过，且导入后的账号可以由现有 Hub 管理页查看、验证、分组和停用。
10. 保留目标仓库 MIT 许可及来源提交，转换测试在 Hub CI 中独立运行。

## 11. 最终建议

建议实施，但按“移植并修正转换核心 + 复用 Hub 现有上游写通道”的方式完成。不要嵌入原静态页面，不要运行时依赖 GitHub，也不要把第三方输出当作可信数据直接转发。

第一阶段先完成 CPA/Sub2API 两个目标和完整的安全、预览、分组、幂等链路。其余输出格式只有在 Hub 后续新增对应管理连接时再开放，否则只会扩大凭据暴露面而不能形成可管理的闭环。
