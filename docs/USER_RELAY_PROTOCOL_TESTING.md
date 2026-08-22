# 用户中转、多协议转换与缓存测试手册

本文用于验证以下功能：

- 管理员共享渠道的全部用户、指定用户和指定分组授权。
- 普通用户私有中转的所有权与数据面隔离。
- 同一渠道同时支持 Anthropic Messages、OpenAI Responses 和 OpenAI Chat。
- Claude Code 原生 Messages、Claude Code 到 Chat 的协议转换、Codex 原生 Responses。
- 稳定前缀缓存亲和、故障转移、缓存用量采集和诊断指标。

## 1. 测试层级

| 层级 | 命令或入口 | 是否调用真实付费上游 | 主要目的 |
| --- | --- | --- | --- |
| 单元与构建 | `npm run verify` | 否 | 协议转换、SSRF、权限、计费、类型和生产构建 |
| 隔离 E2E | `node tests/hub-e2e.mjs` | 否 | 完整控制面、数据面、模拟上游和真实 CLI |
| 手工控制面 | `/admin/channels`、`/console/relays` | 检测时可能调用 | 验证真实站点、权限范围和页面交互 |
| 真实缓存 | 管理端渠道的缓存诊断 | 是 | 验证第三方供应商真实返回的缓存创建和读取 Token |

## 2. 自动化测试前提

安装项目依赖：

```bash
npm install
```

隔离 E2E 默认使用：

```text
PostgreSQL  postgres://zephyr:zephyr-change-me@127.0.0.1:5432/postgres
Redis       redis://127.0.0.1:6379/14
S3/MinIO    http://127.0.0.1:9000
Bucket      zephyr-hub-e2e
```

重要限制：

- E2E 会删除并重建名为 `zephyr_hub_e2e` 的数据库。
- E2E 会执行 `FLUSHDB` 清空所配置的 Redis 数据库。
- E2E 会清空并删除所配置的测试 S3 bucket。
- 不要把生产数据库、生产 Redis DB 或生产 bucket 配置给该脚本。
- E2E 上游全部是本地模拟服务，不会消耗第三方模型额度。

需要覆盖真实客户端时，机器上应安装：

```bash
claude --version
codex --version
```

脚本使用临时 `HOME`、`CLAUDE_CONFIG_DIR` 和 `CODEX_HOME`，不会修改用户现有的 Claude Code 或 Codex 配置。

## 3. 执行自动化测试

先运行仓库级验证：

```bash
npm run verify
```

通过标准：

- 所有 Vitest 测试通过。
- `nuxt typecheck` 退出码为 `0`。
- `nuxt build` 成功生成 `.output`。

再使用刚生成的生产产物运行隔离 E2E：

```bash
node tests/hub-e2e.mjs
```

通过结果必须包含：

```json
{
  "passed": true,
  "weightedAffinity": {
    "primary": 4,
    "fallback": 0
  },
  "realCli": {
    "claude": true,
    "codex": true
  },
  "edgeProbe": true,
  "deletedDimensionsPreserved": true
}
```

`weightedAffinity` 也可能全部落到另一个同优先级节点，合法结果是 `0/4` 或 `4/0`，不能是 `1/3`、`2/2` 或 `3/1`。这证明相同稳定前缀没有被加权路由打散。

`realCli` 为 `false` 表示对应 CLI 未安装或未参与测试，不能把这种结果当作真实客户端验收通过。

## 4. 自动化覆盖范围

隔离 E2E 会验证：

1. 数据库迁移、健康检查、管理员登录和审计事务回滚。
2. 管理员渠道创建、模型映射、分组覆盖和渠道授权。
3. 普通用户控制面权限、Hub Key 所有权、私有中转跨用户隔离。
4. 请求限额、并发、Token 和成本预留。
5. 非流式故障转移、熔断、超时和流开始后禁止切换渠道。
6. OpenAI Responses 流式首字节、长流和客户端断连。
7. Anthropic Messages 原生透传及缓存用量保留。
8. Anthropic Messages 到 OpenAI Chat 的文本转换。
9. 同一渠道同时绑定 Messages 和 Responses。
10. Claude Code CLI 通过 `/anthropic/v1/messages` 调用原生 Messages。
11. Codex CLI 通过 `/v1/responses` 调用原生 Responses。
12. 相同前缀的 weighted rendezvous 缓存亲和。
13. 删除 Hub Key 和渠道后永久聚合维度仍可查询。
14. 应用日志不包含 Hub Key、管理员密码或上游凭据。

## 5. 手工验证管理员共享渠道

1. 登录管理员后台并打开 `/admin/channels`。
2. 创建渠道，填写真实 HTTPS Base URL 和上游 Key。
3. 在“上游协议”中多选站点实际支持的协议。
4. 同时支持 Claude Code 与 Codex 的站点应勾选 `Anthropic Messages` 和 `OpenAI Responses`，不能拆成两个渠道。
5. 配置模型及对应协议绑定，执行协议检测。
6. 分别设置“全部用户”和“部分用户”，验证授权用户可见、未授权用户不可见。
7. 使用未授权用户的 Hub Key 请求相同模型，预期返回 `403` 或无可用渠道错误，且不能路由到该渠道。

协议检测会向真实上游发送最小请求，可能产生费用。`/v1/models` 成功不能证明 Messages、Responses 或工具调用可用，必须查看每个协议的检测结果。

## 6. 手工验证用户私有中转

1. 使用普通用户登录并打开 `/console/relays`。
2. 添加中转，填写真实 HTTPS Base URL、上游 Key 和实际协议能力。
3. 同时支持两种协议时同时勾选 Messages 和 Responses。
4. 同步或手工添加模型映射，执行协议检测。
5. 使用配置生成器创建 `private_only` 专用 Hub Key。
6. 使用另一个普通用户登录，确认控制面看不到该中转。
7. 使用另一个用户的 Hub Key 请求私有模型，确认数据面不能调度该中转。
8. 停用或删除私有中转，确认原专用 Hub Key 不会自动消耗平台渠道。

用户私有中转只接受 HTTPS 上游，并阻止 loopback、私网、link-local、元数据地址、DNS rebinding 和重定向到私网。

## 7. Claude Code 实际调用

在控制台生成配置，或设置：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://hub.example.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "YOUR_HUB_KEY",
    "ANTHROPIC_MODEL": "YOUR_HUB_MODEL"
  }
}
```

执行：

```bash
claude -p "只回复：Claude Hub 测试成功" \
  --model YOUR_HUB_MODEL \
  --no-session-persistence
```

预期：

- CLI 正常输出并退出。
- 日志的入站协议为 `anthropic_messages`。
- 有 Messages 原生绑定时转换模式为透传。
- 只有 Chat 绑定时转换模式为 `anthropic_to_openai`。
- 日志和客户端响应中不出现第三方上游 Key。

## 8. Codex 实际调用

`~/.codex/config.toml`：

```toml
model_provider = "Zephyr"
model = "YOUR_HUB_MODEL"

[model_providers.Zephyr]
name = "Zephyr Hub"
base_url = "https://hub.example.com/v1"
wire_api = "responses"
requires_openai_auth = false
env_key = "ZEPHYR_HUB_KEY"
```

执行：

```bash
export ZEPHYR_HUB_KEY="YOUR_HUB_KEY"
codex exec --ephemeral --model YOUR_HUB_MODEL "只回复：Codex Hub 测试成功"
```

预期日志的入站和出站协议均为 `openai_responses`，转换模式为透传。

## 9. 缓存命中验证

缓存测试使用同一个用户、Hub Key、协议、Hub 模型、system/developer 指令和工具定义连续调用 3 到 5 次。避免在稳定前缀中加入当前时间、请求 ID、随机数或动态统计数据。

管理员在渠道列表打开“缓存诊断”，检查：

- 首次请求可能出现缓存创建 Token。
- 后续请求出现缓存读取 Token。
- Token 命中率和请求命中率上升。
- 相同前缀的亲和保持率上升。
- 无故障时亲和故障转移为 `0`。
- Messages 和 Responses 分别统计，不共享缓存亲和。

Hub 不缓存通用生成结果。第三方上游不支持提示词缓存或不返回缓存用量时，缓存读取 Token 为 `0` 是正常结果；此时仍可通过亲和保持率确认路由没有打散。

## 10. 本次自动化执行记录

执行日期：`2026-08-22`

| 检查项 | 结果 |
| --- | --- |
| `npm run verify` | 通过 |
| Vitest | 25 个文件、150 项测试全部通过 |
| Nuxt 类型检查 | 通过 |
| Nuxt 生产构建 | 通过；有 sourcemap 警告，不影响产物 |
| 隔离 Hub E2E | `passed: true` |
| Claude Code CLI | `2.1.232`，原生 Messages 调用通过 |
| Codex CLI | `0.144.1`，原生 Responses 调用通过 |
| 缓存亲和 | 4 次稳定前缀请求全部落到 primary，`4/0` |
| 首个 SSE chunk | `37 ms` |
| 熔断与故障转移 | 通过；非流式故障转移 2 次，流开始后未切换渠道 |
| Edge probe | 通过 |
| 删除后聚合维度保留 | 通过 |
| `git diff --check` | 通过 |
