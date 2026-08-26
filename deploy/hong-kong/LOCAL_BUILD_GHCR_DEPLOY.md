# 本地构建并通过 GHCR 部署到香港服务器

本文档用于将 Nuxt 应用镜像放在本地或 CI 构建，推送到 GitHub Container Registry
（GHCR），再由香港服务器拉取并部署。PostgreSQL、Redis 和 MinIO 仍由香港服务器上的
Docker Compose 管理，不会打包进应用镜像。

## 部署流程

```text
本地源码 -> Docker Buildx 构建 -> GHCR -> 香港服务器 docker compose pull -> 重启 app
```

该方式避免香港服务器执行耗时的 `npm run build`。Docker Registry 会按镜像层传输，
后续版本通常只需上传和下载发生变化的层。

## 一、准备 GHCR Token

在 GitHub 的 Personal access tokens 页面创建 Token。

本地构建机器所用 Token 至少需要：

- `write:packages`
- `read:packages`
- 私有仓库使用 classic Token 时通常还需要 `repo`

香港服务器所用 Token 只需要：

- `read:packages`
- 私有仓库使用 classic Token 时通常还需要 `repo`

不要把 Token 写入仓库、Dockerfile、Compose 或 `.env.example`。

本地登录 GHCR：

```bash
read -rsp 'GHCR Token: ' GHCR_TOKEN
echo
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u vhhgx --password-stdin
unset GHCR_TOKEN
```

香港服务器同样执行一次登录，使用只读 Token：

```bash
read -rsp 'GHCR read-only Token: ' GHCR_TOKEN
echo
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u vhhgx --password-stdin
unset GHCR_TOKEN
```

Docker 会把登录信息保存在当前用户的 Docker 配置中。后续部署应继续使用同一个系统用户。

## 二、确认服务器架构

在香港服务器执行：

```bash
uname -m
```

平台对应关系：

| `uname -m` 输出 | Buildx 平台 |
| --- | --- |
| `x86_64` | `linux/amd64` |
| `aarch64`、`arm64` | `linux/arm64` |

不能直接使用本地机器架构推断服务器架构。Apple Silicon 本地机器向 x86 香港服务器部署时，
必须显式构建 `linux/amd64`。

## 三、本地构建并推送镜像

在项目根目录执行。先确保当前提交和工作区符合预期：

```bash
git status --short
git log -1 --oneline
```

创建或启用 Buildx Builder：

```bash
docker buildx create --name zephyr-builder --use 2>/dev/null || docker buildx use zephyr-builder
docker buildx inspect --bootstrap
```

香港服务器为 `x86_64` 时执行：

```bash
IMAGE=ghcr.io/vhhgx/codex-usage
TAG=$(git rev-parse --short=12 HEAD)

docker buildx build \
  --platform linux/amd64 \
  --tag "$IMAGE:$TAG" \
  --tag "$IMAGE:hk-latest" \
  --push \
  .

printf 'Published %s\n' "$IMAGE:$TAG"
```

香港服务器为 ARM 时，将平台改成：

```bash
--platform linux/arm64
```

标签用途：

- Git 提交标签，例如 `653aba712345`：不可变版本，用于审计和回滚。
- `hk-latest`：指向最近一次香港部署候选版本，便于日常更新。

生产部署记录应保留具体提交标签，不能只记录 `hk-latest`。

## 四、将 Compose 改为拉取镜像

编辑香港服务器实际使用的 `docker-compose-hongkong.yml`。仓库内对应文件是
`deploy/hong-kong/docker-compose-hongkong.yml`。

将 `app` 服务中的本地构建配置：

```yaml
app:
  build:
    context: ../..
    dockerfile: Dockerfile
  image: zephyr-hub:local
```

替换为：

```yaml
app:
  image: ghcr.io/vhhgx/codex-usage:${APP_IMAGE_TAG:-hk-latest}
  pull_policy: always
```

必须删除 `app.build`，否则维护人员仍可能误触发服务器现场构建。其他 `depends_on`、
`env_file`、`environment`、`ports` 和 `networks` 配置保持不变。

在香港服务器 `.env` 中指定需要部署的版本。推荐生产环境使用具体提交标签：

```dotenv
APP_IMAGE_TAG=653aba712345
```

需要自动跟随最近构建时才使用：

```dotenv
APP_IMAGE_TAG=hk-latest
```

先检查最终 Compose 配置：

```bash
docker compose --env-file .env \
  -f docker-compose-hongkong.yml \
  config --images
```

输出应包含 `ghcr.io/vhhgx/codex-usage:<标签>`，不应再包含 `zephyr-hub:local`。

## 五、香港服务器部署

拉取指定镜像：

```bash
docker compose --env-file .env \
  -f docker-compose-hongkong.yml \
  pull app
```

只更新应用容器，不在服务器构建：

```bash
docker compose --env-file .env \
  -f docker-compose-hongkong.yml \
  up -d --no-build app
```

也可以合并执行：

```bash
docker compose --env-file .env \
  -f docker-compose-hongkong.yml \
  up -d --pull always --no-build app
```

当前应用镜像启动时会先运行 `node server/migrate.mjs`，再启动 Nitro，因此数据库迁移会随
新容器自动执行。迁移失败时应用不会启动，应先检查日志，不要反复强制重启。

如果 Compose 文件仍位于仓库的 `deploy/hong-kong` 目录，使用完整路径：

```bash
docker compose --env-file deploy/hong-kong/.env \
  -f deploy/hong-kong/docker-compose-hongkong.yml \
  up -d --pull always --no-build app
```

## 六、部署验证

检查容器状态和镜像：

```bash
docker compose --env-file .env \
  -f docker-compose-hongkong.yml \
  ps

docker compose --env-file .env \
  -f docker-compose-hongkong.yml \
  images app
```

检查启动和迁移日志：

```bash
docker compose --env-file .env \
  -f docker-compose-hongkong.yml \
  logs --tail=200 app
```

检查本机健康接口。端口按当前香港配置默认使用 `8371`：

```bash
curl -fsS http://127.0.0.1:8371/api/ready
curl -fsS http://127.0.0.1:8371/api/health
```

确认新容器稳定后再清理未使用镜像：

```bash
docker image prune -f
```

不要运行 `docker system prune --volumes`，否则可能误删未挂载的数据卷。

## 七、版本回滚

在 `.env` 中把 `APP_IMAGE_TAG` 改为上一个已验证的提交标签：

```dotenv
APP_IMAGE_TAG=上一个提交标签
```

然后执行：

```bash
docker compose --env-file .env \
  -f docker-compose-hongkong.yml \
  pull app

docker compose --env-file .env \
  -f docker-compose-hongkong.yml \
  up -d --no-build app
```

应用代码可以通过镜像回滚，但数据库迁移不一定可以自动逆向回滚。涉及破坏性数据库变更时，
必须先备份 PostgreSQL，并核对旧版应用是否兼容已经执行的新迁移。

## 八、常见问题

### GHCR 返回 `denied` 或 `unauthorized`

确认：

- 登录用户名是 `vhhgx`。
- 本地 Token 有 `write:packages`。
- 服务器 Token 有 `read:packages`。
- 私有仓库 Token 具备所需仓库访问权限。
- 执行 Docker 的系统用户与执行 `docker login` 的用户一致。

重新登录前可以执行：

```bash
docker logout ghcr.io
```

### 出现 `no matching manifest` 或 `exec format error`

镜像平台与服务器架构不一致。根据服务器 `uname -m`，重新使用 `linux/amd64` 或
`linux/arm64` 构建。

检查远端镜像平台：

```bash
docker buildx imagetools inspect ghcr.io/vhhgx/codex-usage:hk-latest
```

### 已推送新镜像但服务器仍运行旧版本

不要只执行 `restart`。`restart` 不会创建使用新镜像的容器，应执行：

```bash
docker compose --env-file .env \
  -f docker-compose-hongkong.yml \
  pull app

docker compose --env-file .env \
  -f docker-compose-hongkong.yml \
  up -d --no-build app
```

### 本地镜像包含 `.env` 吗

不包含。项目 `.dockerignore` 已排除 `.env` 和 `.env.*`（保留 `.env.example`）。运行时配置
由香港服务器上的 Compose 和 `.env` 注入。构建日志和 Dockerfile 中也不应输出或写入密钥。

## 九、日常发布清单

本地：

```bash
git status --short
npm test
npm run typecheck

IMAGE=ghcr.io/vhhgx/codex-usage
TAG=$(git rev-parse --short=12 HEAD)
docker buildx build --platform linux/amd64 \
  -t "$IMAGE:$TAG" \
  -t "$IMAGE:hk-latest" \
  --push .
```

香港服务器：

```bash
# 将 .env 中 APP_IMAGE_TAG 更新为本次 TAG，然后执行：
docker compose --env-file .env \
  -f docker-compose-hongkong.yml \
  up -d --pull always --no-build app

docker compose --env-file .env \
  -f docker-compose-hongkong.yml \
  logs --tail=100 app

curl -fsS http://127.0.0.1:8371/api/ready
```
