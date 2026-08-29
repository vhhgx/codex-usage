# 香港 Hub 宿主机部署

香港服务器项目目录固定为 `/root/apps/zephry-hub`。本页使用
`docker-compose-hongkong.yml`：PostgreSQL、Redis、MinIO 和 Nuxt/Nitro 应用运行在
Docker 中，应用仅发布到宿主机 `127.0.0.1:8371`，公网 80/443 由 Ubuntu 宿主机 Nginx
处理。不要同时启动本目录的 `docker-compose.yml`，否则容器 Nginx 会与宿主机 Nginx
争用 80/443。

## 1. 环境与证书

```bash
cd /root/apps/zephry-hub
test -f deploy/hong-kong/.env || cp deploy/hong-kong/.env.example deploy/hong-kong/.env
chmod 600 deploy/hong-kong/.env
mkdir -p deploy/hong-kong/tls
chmod 700 deploy/hong-kong/tls
```

编辑 `/root/apps/zephry-hub/deploy/hong-kong/.env`，替换全部占位密钥。
`POSTGRES_PASSWORD` 必须与 `NUXT_DATABASE_URL` 中的密码一致，数据库地址使用 Compose
服务名 `postgres`。

将当前域名证书写入以下路径：

```text
/root/apps/zephry-hub/deploy/hong-kong/tls/fullchain.pem
/root/apps/zephry-hub/deploy/hong-kong/tls/privkey.pem
```

`nginx-host.conf` 默认读取这两个文件。如果证书由 Certbot 保存在其他位置，请先修改
配置中的 `ssl_certificate` 和 `ssl_certificate_key`，再安装站点配置。私钥复制完成后执行
`chmod 600 /root/apps/zephry-hub/deploy/hong-kong/tls/privkey.pem`。如果通过 Certbot
`standalone` 签发，Nginx 启动后会占用 80 端口；必须按根目录 `DEPLOYMENT.md` 的 HTTPS
章节安装 stop/copy/start 续期 hooks，否则自动续期会失败。

## 2. 构建并启动 Host Stack

先静默检查 Compose 配置有效性，再构建并启动：

```bash
cd /root/apps/zephry-hub
HUB_ENV_FILE=/root/apps/zephry-hub/deploy/hong-kong/.env docker compose --env-file /root/apps/zephry-hub/deploy/hong-kong/.env -f /root/apps/zephry-hub/deploy/hong-kong/docker-compose-hongkong.yml config --quiet
HUB_ENV_FILE=/root/apps/zephry-hub/deploy/hong-kong/.env docker compose --env-file /root/apps/zephry-hub/deploy/hong-kong/.env -f /root/apps/zephry-hub/deploy/hong-kong/docker-compose-hongkong.yml up -d --build
HUB_ENV_FILE=/root/apps/zephry-hub/deploy/hong-kong/.env docker compose --env-file /root/apps/zephry-hub/deploy/hong-kong/.env -f /root/apps/zephry-hub/deploy/hong-kong/docker-compose-hongkong.yml ps -a
```

应用镜像启动时会先执行 Drizzle 迁移，再启动 Nitro。不要另外手工执行迁移，也不要使用
`docker compose down -v`，后者会删除 PostgreSQL、Redis、MinIO 和备份数据卷。

## 3. 安装宿主机 Nginx

设置真实域名后安装站点。下面命令不会修改仓库中的模板；它会在复制时替换两处
`server_name _;`。随后禁用 Ubuntu 默认站点，并在重载前检查语法：

```bash
HUB_DOMAIN=api.vhhg.pub
sudo apt-get update
sudo apt-get install -y nginx
sudo sed "s/server_name _;/server_name ${HUB_DOMAIN};/g" /root/apps/zephry-hub/deploy/hong-kong/nginx-host.conf | sudo tee /etc/nginx/sites-available/zephyr-hub.conf >/dev/null
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sfn /etc/nginx/sites-available/zephyr-hub.conf /etc/nginx/sites-enabled/zephyr-hub.conf
sudo nginx -t
sudo systemctl enable nginx
sudo systemctl reload-or-restart nginx
```

`nginx-host.conf` 的上游固定为 `127.0.0.1:8371`，不能改成 Docker 服务名 `app:3000`；
宿主机 Nginx 无法解析 Compose 私有网络中的服务名。

## 4. 验证

```bash
curl -fsS http://127.0.0.1:8371/api/health
curl -fsS http://127.0.0.1:8371/api/ready
sudo nginx -t
sudo systemctl status nginx --no-pager
HUB_ENV_FILE=/root/apps/zephry-hub/deploy/hong-kong/.env docker compose --env-file /root/apps/zephry-hub/deploy/hong-kong/.env -f /root/apps/zephry-hub/deploy/hong-kong/docker-compose-hongkong.yml logs --tail=200 app
```

最后使用真实域名检查 `https://<domain>/api/ready` 和登录页。公网应只开放 80/443；8371、
5432、6379 和 9000 不应开放。配置 Hub 渠道时，其他服务器上的 Sub2API/CPA 不能使用
应用容器的 `127.0.0.1`，应使用 WireGuard 地址、可信内网地址或 HTTPS 域名。

## 5. 监控与备份

Prometheus 和备份命令必须继续使用相同的环境文件和 Host Stack Compose 文件：

```bash
printf '%s' '<NUXT_METRICS_TOKEN 的实际值>' > /root/apps/zephry-hub/deploy/hong-kong/.metrics-token
chmod 644 /root/apps/zephry-hub/deploy/hong-kong/.metrics-token
HUB_ENV_FILE=/root/apps/zephry-hub/deploy/hong-kong/.env docker compose --env-file /root/apps/zephry-hub/deploy/hong-kong/.env -f /root/apps/zephry-hub/deploy/hong-kong/docker-compose-hongkong.yml --profile monitoring up -d
HUB_ENV_FILE=/root/apps/zephry-hub/deploy/hong-kong/.env docker compose --env-file /root/apps/zephry-hub/deploy/hong-kong/.env -f /root/apps/zephry-hub/deploy/hong-kong/docker-compose-hongkong.yml --profile backup run --rm backup
```

迁移或更新前必须完整备份 PostgreSQL 和 MinIO，并保持 `NUXT_ENCRYPTION_KEY`、
`NUXT_HUB_KEY_PEPPER`、Hub Key 密钥环和 `MINIO_KMS_SECRET_KEY` 不变。systemd 定时备份模板
位于 `deploy/backup/zephyr-hub-backup.service`。

如需避免在香港服务器现场执行耗时的 Nuxt 构建，请使用
[本地构建并通过 GHCR 部署](./LOCAL_BUILD_GHCR_DEPLOY.md)操作手册。
