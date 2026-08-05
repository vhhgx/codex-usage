# Zephyr Hub

Zephyr Hub 是基于 Nuxt 4/Nitro 的 OpenAI 兼容聚合网关。它使用统一的 Hub Key 接收客户端请求，在多个 CPA 或 Sub2API 渠道之间调度，并记录逐次调用日志、用量和成本。

详细设计见 [HUB_ARCHITECTURE.md](./HUB_ARCHITECTURE.md)。
完整的云服务器部署、数据迁移、更新和恢复步骤见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 主要能力

- 多 CPA/Sub2API 渠道、模型别名和端点能力映射。
- 按模型池选择优先级或加权轮询，并支持故障转移和熔断。
- Hub Key 凭据版本、可重叠轮换、到期时间、模型/端点权限、RPM、并发以及总/日/周/月额度。
- 单请求 Token、费用、图片数量/规格/质量保护，以及非流式 POST 请求幂等重放。
- OpenAI 兼容的 Models、Chat Completions、Responses、Embeddings 和 Images API。
- Chat Completions 与 Responses SSE 实时透传。
- PostgreSQL 请求元数据、Redis 实时限额、MinIO/S3 加密请求响应正文。
- 今日、滚动 24 小时、周、月、年、全部和自定义时间统计。
- 单管理员控制台、渠道健康检查、价格表、完整请求日志、审计查询和用量导出。
- Prometheus 指标、签名 Webhook 告警、共享流量排空状态与 readiness。
- PostgreSQL/MinIO 快照、校验、可选 `age` 加密和恢复演练工具。
- 保留原有 CPA、CPA Manager Plus 和 Sub2API 上游账号余量面板。

## 系统要求

- Node.js 20 或更高版本
- PostgreSQL 16+
- Redis 7+
- MinIO 或兼容 S3 的对象存储

## 本地启动

1. 安装依赖并启动基础设施：

```bash
npm install
docker compose -f docker-compose.hub.yml up -d
```

2. 创建配置：

```bash
cp .env.example .env
openssl rand -base64 32
openssl rand -base64 48
```

将第一个随机值写入 `NUXT_ENCRYPTION_KEY`，第二个随机值可同时用于生成独立的 `NUXT_HUB_KEY_PEPPER` 和 `NUXT_ACCOUNT_ID_SECRET`。生产环境应为它们分别生成不同值。

默认 Compose 对应的关键配置如下，部署前必须替换所有密码：

```dotenv
NUXT_DATABASE_URL=postgres://zephyr:zephyr-change-me@127.0.0.1:5432/zephyr_hub
NUXT_REDIS_URL=redis://127.0.0.1:6379/0
NUXT_S3_ENDPOINT=http://127.0.0.1:9000
NUXT_S3_BUCKET=zephyr-hub-logs
NUXT_S3_ACCESS_KEY_ID=zephyr
NUXT_S3_SECRET_ACCESS_KEY=zephyr-minio-change-me
```

3. 执行数据库迁移并启动：

```bash
npm run db:migrate
npm run dev
```

服务默认监听所有网络接口，可从局域网地址或 `http://nas.vhhg.pub/login` 访问。管理员和普通用户使用同一个登录入口，系统按角色进入对应工作区。数据库没有管理员时，第一次登录会使用 `NUXT_ADMIN_USERNAME` 和 `NUXT_ADMIN_PASSWORD` 创建管理员；管理员创建后数据库中的 Argon2id 哈希是登录事实来源。

## 接入渠道

1. 在“渠道与路由”中添加 CPA 或 Sub2API Base URL 与客户端 API Key。
2. 为渠道添加 Hub 模型名到上游模型名的映射，并选择支持的 API 端点。
3. 使用健康检测确认 `/v1/models` 可以访问；业务请求还会形成分渠道、分端点的被动成功率、延迟和告警指标。
4. 在“模型与价格”中选择调度策略并设置 Token/图片结算价格。
5. 创建 Hub Key，完整 Key 只显示一次。

客户端将 OpenAI Base URL 指向 Zephyr Hub，并使用 Hub Key：

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer zh-your-hub-key"
```

对可能产生费用且不希望因客户端重试而重复执行的非流式 POST 请求，发送唯一的
`Idempotency-Key`。同一个 Hub Key、端点、幂等键和请求正文会重放首次响应；相同幂等键
配合不同正文会返回 `409`。流式请求不支持幂等键。

```bash
curl http://localhost:3000/v1/images/generations \
  -H "Authorization: Bearer zh-your-hub-key" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: job-20260730-001" \
  -d '{"model":"gpt-image-1","prompt":"a red chair","n":1}'
```

## OpenAI 兼容端点

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`
- `POST /v1/images/generations`
- `POST /v1/images/edits`

不在此清单中的 `/v1/**` 端点返回 OpenAI 格式的 `unsupported_endpoint` 错误。Images 编辑接口允许最大 50 MB 的 multipart 请求。

## 数据与安全

- 每个 Hub Key 的凭据版本使用服务端 Pepper 的 HMAC 保存在独立凭据表中，无法从数据库恢复；轮换时新 Key 仍只显示一次。
- 渠道 Key 和请求/响应正文使用 AES-256-GCM 加密；流式归档直接写入临时文件并以分块格式上传，不在内存中保留完整响应；归档对象同时请求 S3 SSE-AES256。
- 认证请求头、Cookie 和上游凭据不会写入请求正文日志。
- 转发前会移除客户端提供的 `Forwarded`、`X-Forwarded-*`、`X-Real-IP` 和 `Idempotency-Key`，避免把网关内部语义泄露给上游。
- JSON 归档副本会递归脱敏 Authorization、Cookie、API Key、访问令牌和客户端密钥字段；转发正文保持不变。
- 登录和原账号查询限流使用 Redis 原子计数，并且只有配置过的可信代理可以提供客户端转发地址。
- 完整正文默认保留 30 天；Compose 会为 MinIO Bucket 配置对应生命周期。
- 请求元数据默认保留 365 天；小时/日聚合长期保留。
- Redis 重启后，额度计数会从 PostgreSQL 请求日志恢复。
- 流式响应发出第一块后不会再切换渠道。

## 原有上游配额集成

以下配置为可选项，只影响原有账号余量与 CPA Manager Plus 用量页面，不影响 Hub 代理：

| 名称 | 用途 |
| --- | --- |
| `NUXT_CPA_BASE_URL` | CLIProxyAPI 地址 |
| `NUXT_CPA_MANAGEMENT_KEY` | CLIProxyAPI Management Key |
| `NUXT_CPAMP_BASE_URL` | CPA Manager Plus Manager Server 地址 |
| `NUXT_CPAMP_ADMIN_KEY` | CPA Manager Plus Admin Key |
| `NUXT_SUB2API_BASE_URL` | Sub2API 网关地址 |
| `NUXT_SUB2API_ADMIN_API_KEY` | Sub2API Admin API Key |
| `NUXT_ACCOUNT_ID_SECRET` | 生成不透明账号 ID 的随机密钥 |

## 验证与生产部署

```bash
npm run verify
npm run test:hub-e2e
npm run build
npm run db:migrate
node .output/server/index.mjs
```

`test:hub-e2e` 使用本地 Compose 的 PostgreSQL、Redis 与 MinIO，在独立的
`zephyr_hub_e2e` 数据库和 Redis DB 14 中运行故障转移、SSE、multipart、并发限额、
日志归档及凭据加密测试。它还覆盖审计事务回滚、真实首字节、历史日汇总、指标和签名
Webhook、Key 轮换/吊销、幂等重放/冲突、单请求成本保护、流量排空、审计查询及 CSV/JSON
导出，结束后自动清理测试数据。

真实 CPA/Sub2API 影子验证会复用后台中已配置的两个渠道，不需要把上游 Key 传给脚本：

```bash
HUB_SHADOW_ADMIN_USERNAME=admin \
HUB_SHADOW_ADMIN_PASSWORD='...' \
HUB_SHADOW_CPA_CHANNEL_ID='...' \
HUB_SHADOW_SUB2API_CHANNEL_ID='...' \
npm run test:hub-shadow
```

默认只执行渠道健康检测和 Hub Models 校验。确认允许产生少量真实上游调用后，增加
`HUB_SHADOW_RUN_REQUESTS=1`；图片请求还需要单独设置 `HUB_SHADOW_ALLOW_IMAGES=1`。
脚本创建的临时 Hub Key 会在结束时自动删除，输出不会包含管理员密码、上游 Key 或 Hub Key。

生产环境必须使用 HTTPS 反向代理，并确保 Nuxt、PostgreSQL、Redis、MinIO、CPA 和 Sub2API 之间走可信内网。应用实例应共享同一 PostgreSQL、Redis、对象存储和加密密钥。

## 运维与恢复

- `GET /api/health`：进程存活检查。
- `GET /api/ready`：PostgreSQL、Redis 与流量接收状态；排空期间返回 `503`。
- `GET /api/metrics`：使用 `Authorization: Bearer $NUXT_METRICS_TOKEN` 获取 Prometheus 指标。
- `GET|POST /api/operations/traffic`：使用独立的 `NUXT_OPERATIONS_TOKEN` 查询或启停共享流量排空；后台“系统设置”也提供相同控制。
- `/api/admin/alerts` 和 `/api/admin/alerts/test`：查看当前告警状态并测试签名 Webhook。
- `/api/admin/exports/usage`：按时间、Key、渠道、模型、端点和状态导出永久日汇总 CSV/JSON，最多 100,000 行。

告警阈值、Webhook 地址和签名密钥见 [`.env.example`](./.env.example)。Prometheus 私网部署见
[deploy/monitoring/README.md](./deploy/monitoring/README.md)；备份、校验、恢复和季度恢复演练见
[deploy/backup/README.md](./deploy/backup/README.md)。进入维护前先开启流量排空并等待
`activeRequests` 归零，恢复完成并执行迁移/额度对账后再恢复流量。

## 香港过渡线路

`deploy/edge/` 提供“香港 Nginx -> WireGuard -> 美国 Hub”的过渡部署配置。线路机关闭
SSE 和请求缓冲、允许 50 MB 上传，并使用 `$remote_addr` 覆盖客户端传入的转发头。
美国 Hub 必须设置 `NUXT_TRUSTED_PROXY_CIDRS=10.20.0.1/32`（按实际 WireGuard
地址调整）；未列入该配置的公网来源所提供的 `X-Forwarded-For` 会被忽略。

运行总览会按所选时间范围显示 P95 首字节和 SSE 中断率。`npm run test:edge` 可从
目标网络执行模型发现、Responses 非流式/SSE、并发及可选 Images Edits 上传探测，
输出适合定时任务或外部监控采集的 JSON。

真实部署和三网验收步骤见 [deploy/edge/README.md](./deploy/edge/README.md) 与
[KEY_ACTIVITY_AND_EDGE_DEPLOYMENT.md](./KEY_ACTIVITY_AND_EDGE_DEPLOYMENT.md)。

香港完整部署使用 [deploy/hong-kong/docker-compose.yml](./deploy/hong-kong/docker-compose.yml)，
包含应用镜像、自动数据库迁移、PostgreSQL、Redis、MinIO 和 Nginx 私有网络部署。
