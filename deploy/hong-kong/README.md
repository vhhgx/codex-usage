# 香港完整 Hub 部署

该 Compose 在同一私有 Docker 网络中运行 Nuxt/Nitro、PostgreSQL、Redis 和 MinIO，
只有 Nginx 的 80/443 端口对外发布。应用启动前自动执行 Drizzle 迁移；MinIO Bucket
自动配置 30 天生命周期。Nginx 关闭请求/响应缓冲，以支持 SSE 和大文件上传。

1. 将 `.env.example` 复制为 `.env`，替换全部占位密钥。`POSTGRES_PASSWORD` 必须与
   `NUXT_DATABASE_URL` 中的密码一致并使用 URL 安全字符。
2. 将证书写入 `tls/fullchain.pem` 和 `tls/privkey.pem`。
3. 运行 `docker compose config` 检查配置，再执行 `docker compose up -d --build`。
4. 配置 Hub 渠道指向美国 Sub2API 的 WireGuard 地址，例如 `http://10.20.0.2:8080`。
5. 使用测试域名和 `npm run test:edge` 验证后再切换正式 DNS。

可观测性使用带 Bearer 鉴权的 `/api/metrics` 和签名 Webhook。启用可选 Prometheus
时，将 `NUXT_METRICS_TOKEN` 的值单独写入 `.metrics-token`，再执行
`docker compose --profile monitoring up -d`。Prometheus 只加入私有网络，默认不发布端口。

迁移前必须完整备份 PostgreSQL 和 MinIO，并保持 `NUXT_ENCRYPTION_KEY`、
`NUXT_HUB_KEY_PEPPER` 与旧环境一致。切换窗口中只允许一个 Hub 数据面接收正式写流量。
数据库、Redis、MinIO 和应用服务都没有 `ports` 映射；需要维护时应通过 SSH 和
`docker compose exec` 进入，不要临时暴露到公网。
