# Zephyr Console

基于 Nuxt 4 的 CPA/CLIProxyAPI 配额与用量查询面板。

## 功能

- 公开查看所有启用的 Codex OAuth 账号配额，无需管理员登录。
- 单个刷新或以最多 5 个并发请求全部刷新。
- 刷新只查询 `https://chatgpt.com/backend-api/wham/usage`，不包含任何额度重置功能。
- 普通用户输入配置在 CPA `api-keys` 中的客户端 Key，查询自己的调用次数、Token、模型、成功率与估算费用。
- CPA Management Key 和 CPA Manager Plus Admin Key 只存在于 Nuxt 服务端。
- 用户查询接口包含 IP 限流，响应仅返回字段白名单。

## 前置条件

1. CLIProxyAPI 已启动并配置 Management Key。
2. CPA Manager Plus Manager Server 已启动并正常采集 usage queue。
3. CLIProxyAPI 开启用量发布：

```yaml
usage-statistics-enabled: true
redis-usage-queue-retention-seconds: 300
```

同一个 CLIProxyAPI usage queue 只能由一个 CPA Manager Plus Collector 消费。本项目只读取 CPA Manager Plus 的持久化统计，不会消费 usage queue。

## 安装

```bash
npm install
cp .env.example .env
npm run dev
```

打开 `http://localhost:3000`。

## 环境变量

| 名称 | 用途 |
| --- | --- |
| `NUXT_CPA_BASE_URL` | CLIProxyAPI 地址，例如 `http://127.0.0.1:8317` |
| `NUXT_CPA_MANAGEMENT_KEY` | CLIProxyAPI `remote-management.secret-key` |
| `NUXT_CPAMP_BASE_URL` | CPA Manager Plus Manager Server 地址 |
| `NUXT_CPAMP_ADMIN_KEY` | CPA Manager Plus Admin Key |
| `NUXT_ACCOUNT_ID_SECRET` | 生成不透明账号 ID 的随机密钥，至少 32 个字符 |

以上变量均属于 Nuxt 私有 `runtimeConfig`，不要添加到 `runtimeConfig.public`。

生成账号 ID 密钥：

```bash
openssl rand -base64 48
```

## API 路由

### 普通用户

- `POST /api/usage/query`
  - 请求：`{ "apiKey": "...", "range": "today|7d|30d" }`
  - 服务端先确认 Key 当前存在于 CPA `api-keys`，再按 SHA-256 Hash 查询 CPA Manager Plus。

### Codex 余量

- `GET /api/codex/accounts`
- `POST /api/codex/:id/refresh`
- `POST /api/codex/refresh-all`

Codex 余量接口无需登录。账号 ID 由服务端 HMAC 生成，不会向浏览器暴露 `auth_index`。

## 验证

```bash
npm run verify
```

该命令依次运行单元测试、Nuxt 类型检查和生产构建。

## 部署

```bash
npm run build
node .output/server/index.mjs
```

生产环境建议通过 HTTPS 反向代理访问，并让 Nuxt、CLIProxyAPI 与 CPA Manager Plus 走内网地址通信。
