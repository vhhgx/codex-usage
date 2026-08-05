# Zephyr Hub 云服务器部署指南

本文以仓库中的 `deploy/hong-kong/docker-compose.yml` 为生产部署入口。目录名虽然是
`hong-kong`，但这套 Compose 可以部署在任意 Linux 云服务器。它会在同一个私有 Docker
网络中运行 Hub、PostgreSQL、Redis、MinIO 和 Nginx，只有 80/443 端口对公网开放。

## 1. 部署结构

```text
用户
  -> HTTPS / Nginx
  -> Zephyr Hub
  -> PostgreSQL（业务数据）
  -> Redis（会话、限流、额度和调度状态）
  -> MinIO（加密请求/响应正文）
  -> CPA / Sub2API（上游号池）
```

生产环境不要直接使用根目录的 `docker-compose.hub.yml`。该文件只为本地开发启动
PostgreSQL、Redis 和 MinIO，不包含 Hub 应用和 Nginx。生产环境使用：

```text
deploy/hong-kong/docker-compose.yml
```

## 2. 部署前准备

建议服务器配置：

- Ubuntu 22.04 或 24.04。
- 2 vCPU、4 GiB 内存起步。
- 至少 40 GiB SSD，并按日志量扩容。
- 一个已经解析到服务器公网 IP 的域名。
- 可从服务器访问 CPA、Sub2API 等上游地址。

防火墙只需要开放：

- `22/tcp`：建议只允许管理 IP。
- `80/tcp`：用于 HTTP 跳转和证书签发。
- `443/tcp`：Hub HTTPS 服务。

不要向公网开放 `3000`、`5432`、`6379`、`9000`、`9001`、CPA 管理端口或 Sub2API
管理端口。

安装 Git、Docker 和 Compose 插件：

```bash
sudo apt update
sudo apt install -y git ca-certificates curl openssl docker.io docker-compose-v2
sudo systemctl enable --now docker
docker --version
docker compose version
```

如果系统源没有 `docker-compose-v2`，请按照 Docker 官方文档安装
`docker-compose-plugin`。

## 3. 推送和获取代码

首次推送当前功能分支：

```bash
git push --set-upstream origin feature/hub-gateway
```

在云服务器创建部署目录并克隆：

```bash
sudo mkdir -p /opt/zephyr-hub
sudo chown "$USER:$USER" /opt/zephyr-hub
git clone --branch feature/hub-gateway --single-branch \
  https://github.com/vhhgx/codex-usage.git /opt/zephyr-hub
cd /opt/zephyr-hub/deploy/hong-kong
```

如果仓库是私有仓库，应使用只读 Deploy Key 或 GitHub Token，不要把凭据写入仓库。

## 4. 配置生产环境变量

生产环境变量文件必须与生产 Compose 放在同一个目录：

```text
/opt/zephyr-hub/deploy/hong-kong/.env
```

创建并限制权限：

```bash
cd /opt/zephyr-hub/deploy/hong-kong
cp .env.example .env
chmod 600 .env
nano .env
```

`.env` 不应提交到 Git。仓库已经通过 `.gitignore` 忽略该文件。

### 4.1 生成随机值

分别生成不同的随机值，不要在多个用途之间复用：

```bash
# URL 安全，适合 PostgreSQL 密码
openssl rand -hex 24

# 32 字节 Base64，适合加密密钥
openssl rand -base64 32 | tr -d '\n'

# 64 个十六进制字符，适合 Pepper、Token 和 ID Secret
openssl rand -hex 32
```

### 4.2 最小完整配置

以下内容写入 `deploy/hong-kong/.env`，所有示例值都必须替换：

```dotenv
# PostgreSQL：两处密码必须完全相同
POSTGRES_PASSWORD=replace-with-url-safe-random-password
NUXT_DATABASE_URL=postgres://zephyr:replace-with-url-safe-random-password@postgres:5432/zephyr_hub

# MinIO
MINIO_ROOT_USER=replace-with-random-access-key
MINIO_ROOT_PASSWORD=replace-with-random-secret-key
MINIO_KMS_SECRET_KEY=zephyr-hub:replace-with-base64-encoded-32-byte-key

# Hub 加密和身份密钥。必须分别生成，并永久保存
NUXT_ENCRYPTION_KEY=replace-with-base64-encoded-32-byte-key
NUXT_HUB_KEY_PEPPER=replace-with-at-least-32-random-characters
NUXT_HUB_KEY_ENCRYPTION_ACTIVE_VERSION=v1
NUXT_HUB_KEY_ENCRYPTION_KEYS={"v1":"replace-with-another-base64-encoded-32-byte-key"}
NUXT_ACCOUNT_ID_SECRET=replace-with-at-least-32-random-characters

# 空数据库第一次登录时创建的管理员
NUXT_ADMIN_USERNAME=admin
NUXT_ADMIN_PASSWORD=replace-with-a-long-random-password

# 对象存储和 Hub 行为
NUXT_S3_REGION=us-east-1
NUXT_HUB_REQUEST_TIMEOUT_MS=120000
NUXT_HUB_CIRCUIT_FAILURE_THRESHOLD=3
NUXT_HUB_CIRCUIT_COOLDOWN_MS=30000

# 运维接口和告警
NUXT_METRICS_TOKEN=replace-with-a-long-random-metrics-token
NUXT_OPERATIONS_TOKEN=replace-with-a-different-long-random-operations-token
NUXT_ALERT_WEBHOOK_URL=
NUXT_ALERT_WEBHOOK_SECRET=replace-with-a-webhook-signing-secret
NUXT_ALERT_FAILURE_RATE=0.2
NUXT_ALERT_MINIMUM_REQUESTS=20
NUXT_ALERT_STREAM_ABORT_RATE=0.1
NUXT_ALERT_FIRST_BYTE_MS=5000
NUXT_ALERT_PENDING_REQUESTS=100
NUXT_ALERT_MEMORY_RSS_BYTES=805306368
NUXT_ALERT_COOLDOWN_SECONDS=1800

# 上游管理连接。不使用的上游可以留空
NUXT_CPA_BASE_URL=
NUXT_CPA_MANAGEMENT_KEY=
NUXT_CPAMP_BASE_URL=
NUXT_CPAMP_ADMIN_KEY=
NUXT_SUB2API_BASE_URL=https://sub.example.com
NUXT_SUB2API_ADMIN_API_KEY=replace-with-sub2api-admin-api-key

# TLS 文件目录，目录内必须有 fullchain.pem 和 privkey.pem
TLS_CERT_DIR=./tls

# 可选备份和监控
BACKUP_RETENTION_DAYS=14
BACKUP_AGE_RECIPIENT=
METRICS_TOKEN_FILE=.metrics-token
```

生产 Compose 会在容器内部覆盖以下连接，无需在 `.env` 中配置：

```dotenv
NUXT_REDIS_URL=redis://redis:6379/0
NUXT_S3_ENDPOINT=http://minio:9000
NUXT_S3_BUCKET=zephyr-hub-logs
```

不要把本地环境中的数据库地址原样复制到生产环境：

```dotenv
# 错误：容器中的 127.0.0.1 指向应用容器自己
NUXT_DATABASE_URL=postgres://zephyr:password@127.0.0.1:5432/zephyr_hub

# 正确：使用 Compose 服务名 postgres
NUXT_DATABASE_URL=postgres://zephyr:password@postgres:5432/zephyr_hub
```

同样，运行在其他容器或其他服务器上的 CPA/Sub2API 也不能使用应用容器中的
`127.0.0.1`。应填写同一 Docker 网络中的服务名、可信内网 IP、WireGuard IP 或 HTTPS
域名。

### 4.3 密钥保管规则

以下值控制已保存凭据的加密或稳定标识，迁移、恢复和重新部署时必须保持不变：

```text
NUXT_ENCRYPTION_KEY
NUXT_HUB_KEY_PEPPER
NUXT_HUB_KEY_ENCRYPTION_KEYS
NUXT_ACCOUNT_ID_SECRET
MINIO_KMS_SECRET_KEY
```

修改 `NUXT_ENCRYPTION_KEY` 会导致已保存的渠道 Key、账号密码和其他凭据无法解密。
修改 Hub Key 密钥环会导致已创建的 Hub Key 无法查看或轮换。应把这些值存入独立的密码
管理器或云密钥管理服务，不要只保存在服务器磁盘。

`POSTGRES_PASSWORD` 可以在迁移时更换，但 `POSTGRES_PASSWORD` 与
`NUXT_DATABASE_URL` 中的密码始终必须一致。

## 5. 配置 HTTPS

先将域名的 A/AAAA 记录指向云服务器。确认 DNS 生效后安装 Certbot：

```bash
sudo apt install -y certbot
sudo certbot certonly --standalone -d hub.example.com
```

复制证书到生产目录：

```bash
cd /opt/zephyr-hub/deploy/hong-kong
mkdir -p tls
sudo cp /etc/letsencrypt/live/hub.example.com/fullchain.pem tls/fullchain.pem
sudo cp /etc/letsencrypt/live/hub.example.com/privkey.pem tls/privkey.pem
sudo chown "$USER:$USER" tls/fullchain.pem tls/privkey.pem
chmod 600 tls/privkey.pem
```

将 `hub.example.com` 替换为真实域名。建议同时把 `nginx.conf` 中两处
`server_name _;` 改成真实域名。

证书续期后，需要再次复制证书并重载 Nginx：

```bash
sudo certbot renew
sudo cp /etc/letsencrypt/live/hub.example.com/fullchain.pem \
  /opt/zephyr-hub/deploy/hong-kong/tls/fullchain.pem
sudo cp /etc/letsencrypt/live/hub.example.com/privkey.pem \
  /opt/zephyr-hub/deploy/hong-kong/tls/privkey.pem
cd /opt/zephyr-hub/deploy/hong-kong
docker compose restart nginx
```

生产环境应把该过程配置为 Certbot deploy hook。

## 6. 首次启动

先检查 Compose 展开结果。该命令会在变量缺失时直接报错：

```bash
cd /opt/zephyr-hub/deploy/hong-kong
docker compose config
```

构建并启动完整服务：

```bash
docker compose up -d --build
docker compose ps -a
```

会启动以下服务：

- `postgres`：持久化业务数据。
- `redis`：持久化 Redis AOF 数据。
- `minio`：持久化加密正文。
- `minio-init`：创建 Bucket 和 30 天生命周期，成功后退出是正常行为。
- `app`：运行数据库迁移后启动 Zephyr Hub。
- `nginx`：对外提供 HTTPS。

应用镜像启动时会自动执行：

```bash
node server/migrate.mjs
```

因此不需要手工运行 `npm run db:migrate`。

## 7. 启动验证

检查数据库、Redis 和容器状态：

```bash
docker compose exec postgres pg_isready -U zephyr -d zephyr_hub
docker compose exec redis redis-cli ping
docker compose ps -a
```

正常结果应包含：

```text
accepting connections
PONG
```

检查应用容器内部健康状态：

```bash
docker compose exec app node -e \
  "fetch('http://127.0.0.1:3000/api/health').then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) })"
```

检查公网 readiness 和登录页：

```bash
curl -fsS https://hub.example.com/api/ready
curl -I https://hub.example.com/login
```

Nginx 配置会故意对公网隐藏 `/api/health` 并返回 `404`，所以公网检查应使用
`/api/ready`，容器内部检查才使用 `/api/health`。

查看启动日志：

```bash
docker compose logs --tail=200 postgres
docker compose logs --tail=200 redis
docker compose logs --tail=200 minio
docker compose logs --tail=200 app
docker compose logs --tail=200 nginx
```

访问：

```text
https://hub.example.com/login
```

空数据库第一次登录时，系统使用 `NUXT_ADMIN_USERNAME` 和 `NUXT_ADMIN_PASSWORD`
创建管理员。数据库中已经存在管理员时，环境变量不会覆盖数据库中的管理员密码。

## 8. 全新部署与现有数据迁移

### 8.1 全新部署

直接执行完整 Compose 即可。PostgreSQL 初始为空，应用会自动执行全部 Drizzle 迁移并在
第一次管理员登录时初始化管理员。

### 8.2 迁移当前本地数据

`drizzle/` 只包含数据库结构迁移，不包含账号、渠道、用户和日志数据。迁移现有数据必须
额外备份 PostgreSQL；需要保留历史加密正文时还要迁移 MinIO Bucket。

在当前本地项目导出 PostgreSQL：

```bash
cd /home/vhhg/workspace/www/dashboard
mkdir -p backup
docker compose -f docker-compose.hub.yml exec -T postgres \
  pg_dump -U zephyr -d zephyr_hub -Fc > backup/zephyr_hub.dump
```

将 `backup/zephyr_hub.dump` 和原环境的加密密钥安全传输到云服务器。不要把备份文件提交
到 Git。

在云服务器先启动基础设施：

```bash
cd /opt/zephyr-hub/deploy/hong-kong
docker compose up -d postgres redis minio minio-init
```

恢复 PostgreSQL：

```bash
docker compose exec -T postgres pg_restore \
  --clean --if-exists --no-owner --no-privileges \
  -U zephyr -d zephyr_hub < /path/to/zephyr_hub.dump
```

恢复后启动应用，让应用执行缺少的迁移：

```bash
docker compose up -d --build app nginx
docker compose logs --tail=200 app
```

Redis 中的数据不需要跨服务器迁移。Hub 会根据 PostgreSQL 记录重新对账额度和状态。

MinIO 可使用 MinIO Client 的 `mc mirror` 在旧 Bucket 和新 Bucket 之间同步。若不迁移
MinIO，账号、渠道和请求元数据仍在，但旧请求的完整加密正文将不可查看。

## 9. 数据库迁移目录

根目录中的以下文件必须随代码上传：

```text
drizzle.config.ts
drizzle/
server/db/schema.ts
scripts/migrate.mjs
```

`drizzle/` 中的 SQL 文件是按顺序执行的数据库版本历史；`drizzle/meta/` 是 Drizzle Kit
生成后续迁移时使用的快照和日志。Dockerfile 会把迁移文件复制到运行镜像，应用启动前会
自动执行尚未运行的迁移。

规则：

- 不要删除、重命名或修改已经执行过的迁移文件。
- 数据库结构变化时新增迁移文件。
- `drizzle/` 必须提交到 Git。
- `.drizzle/` 是本地临时目录，已被 `.gitignore` 忽略。
- 实际业务数据在 PostgreSQL 数据卷中，不在 `drizzle/` 中。

## 10. 日常更新

更新前先在后台“系统设置”开启流量排空，并等待活动请求归零，然后执行备份：

```bash
cd /opt/zephyr-hub/deploy/hong-kong
docker compose --profile backup run --rm backup
```

拉取代码并滚动重建：

```bash
git pull --ff-only
docker compose up -d --build
docker compose ps -a
docker compose logs --tail=200 app
```

确认 `/api/ready` 正常后关闭流量排空。

`docker compose up -d --build` 会保留数据卷。不要执行：

```bash
docker compose down -v
```

`-v` 会删除 PostgreSQL、Redis、MinIO、备份和 Prometheus 数据卷。

## 11. 备份与恢复

生产 Compose 包含备份工具，备份 PostgreSQL 和 MinIO，并生成 SHA-256 清单：

```bash
docker compose --profile backup run --rm backup
```

备份默认保存在 Docker 的 `backup-data` 数据卷中。生产环境还应把备份复制到独立服务器
或对象存储；备份与生产数据位于同一块磁盘不算有效的灾难恢复方案。

验证备份：

```bash
docker compose --profile backup run --rm \
  --entrypoint verify-backup.sh backup /backups/<timestamp>
```

恢复操作会清理目标数据库，必须先排空流量、停止应用并确认目标：

```bash
docker compose stop app
docker compose --profile backup run --rm \
  -e RESTORE_CONFIRM=zephyr_hub \
  --entrypoint restore.sh backup /backups/<timestamp>
docker compose up -d app nginx
```

恢复后检查迁移、readiness、账号管理、渠道健康和 Hub Key 调用，再恢复正式流量。

## 12. 监控

Hub 提供：

- `/api/metrics`：Prometheus 指标，需要 `NUXT_METRICS_TOKEN`。
- `/api/ready`：PostgreSQL、Redis 和流量状态。
- 后台“系统设置”：流量排空、维护和告警状态。
- 签名 Webhook：失败率、SSE 中断、首字节、积压和内存告警。

启用仓库自带 Prometheus：

```bash
cd /opt/zephyr-hub/deploy/hong-kong
printf '%s' '<NUXT_METRICS_TOKEN 的实际值>' > .metrics-token
chmod 600 .metrics-token
docker compose --profile monitoring up -d
```

Prometheus 默认只加入私有 Docker 网络，不发布公网端口。

## 13. 常见故障排查

### PostgreSQL 连接失败

确认：

```dotenv
POSTGRES_PASSWORD=<same-password>
NUXT_DATABASE_URL=postgres://zephyr:<same-password>@postgres:5432/zephyr_hub
```

新建数据库卷只读取第一次启动时的 `POSTGRES_PASSWORD`。数据库已经初始化后，仅修改
`.env` 不会修改数据库内部密码；应恢复原密码或在 PostgreSQL 中执行密码变更。

### Redis 连接失败

```bash
docker compose exec redis redis-cli ping
docker compose logs --tail=200 redis
```

生产 Compose 已将应用的 Redis 地址设置为 `redis://redis:6379/0`，不要改为
`127.0.0.1`。

### App 不健康

```bash
docker compose logs --tail=300 app
docker compose exec app node -e \
  "fetch('http://127.0.0.1:3000/api/health').then(r => console.log(r.status)).catch(console.error)"
```

常见原因包括环境变量缺失、数据库密码不匹配、迁移失败或加密密钥格式不正确。

### Nginx 无法启动

确认以下文件存在且容器可读：

```text
deploy/hong-kong/tls/fullchain.pem
deploy/hong-kong/tls/privkey.pem
```

然后检查：

```bash
docker compose logs --tail=200 nginx
docker compose run --rm nginx nginx -t
```

### Sub2API/CPA 返回 502

从应用容器测试目标地址：

```bash
docker compose exec app node -e \
  "fetch('https://sub.example.com').then(r => console.log(r.status)).catch(console.error)"
```

检查上游 URL、管理密钥、DNS、云防火墙和上游服务器 IP 白名单。上游位于其他容器时，
应使用服务名或私有网络地址，不能使用应用容器的 `127.0.0.1`。

### 端口被占用

```bash
sudo ss -ltnp | grep -E ':80|:443'
```

停止冲突的宿主机 Nginx/Apache，或调整部署架构，不能让两个服务同时绑定相同端口。

## 14. 部署验收清单

- `docker compose config` 无缺失变量或警告。
- PostgreSQL 返回 `accepting connections`。
- Redis 返回 `PONG`。
- `minio-init` 退出码为 `0`。
- `app` 和 `nginx` 状态健康。
- `https://<domain>/api/ready` 返回成功。
- 管理员可以登录并立即修改初始密码。
- 账号管理、接码管理和号池配置可以读取数据。
- Sub2API/CPA 管理连接和渠道健康检查通过。
- Hub Key 可以访问 `/v1/models` 并完成一次非流式请求。
- SSE 请求可以持续输出且不被 Nginx 缓冲。
- 备份任务成功，并已经复制到独立存储。
- 已配置证书自动续期和外部存活监控。
