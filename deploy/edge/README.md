# 香港线路机部署

此目录用于 `香港 Nginx -> WireGuard -> 美国 Hub` 过渡线路。Nginx 仅监听公网
80/443，并将请求转发到 WireGuard 内的 `10.20.0.2:8371`。配置关闭响应和请求缓冲，
允许 50 MB 上传，并为 SSE 使用 600 秒读写超时。

1. 分别生成 WireGuard 密钥，将两个 `.example` 文件复制到对应服务器的
   `/etc/wireguard/wg0.conf` 并替换占位值。
2. 美国服务器只向 `10.20.0.1` 和本机开放 Hub 的 8371 端口；公网防火墙仅开放
   WireGuard UDP 51820。Hub 设置 `NUXT_TRUSTED_PROXY_CIDRS=10.20.0.1/32`。
3. 将域名证书放入香港服务器本目录的 `tls/fullchain.pem` 和 `tls/privkey.pem`，运行
   `docker compose up -d`。
4. 用 `nginx -t`、非流式请求、SSE、50 MB 上传和并发请求完成切换前验证。

仓库提供结构化线路探测命令：

```bash
EDGE_PROBE_URL=https://hk-hub.example.com \
EDGE_PROBE_HUB_KEY='zh-...' \
EDGE_PROBE_MODEL='gpt-5.4' \
EDGE_PROBE_CONCURRENCY=5 \
npm run test:edge
```

增加 `EDGE_PROBE_IMAGE=/path/to/test.png` 时会测试 Images Edits 上传；可通过
`EDGE_PROBE_IMAGE_MODEL` 单独指定图片模型。结果包含响应头耗时、SSE 首块时间、总耗时、
并发通过数和上传字节数，Hub Key 不会写入输出。可由 cron 或外部监控定时执行并采集 JSON。

设置 `EDGE_PROBE_WEBHOOK_URL` 后，失败结果会以 JSON POST 到通用 Webhook；设置
`EDGE_PROBE_NOTIFY_ALWAYS=true` 会发送每次结果。`zephyr-edge-probe.service` 和
`zephyr-edge-probe.timer` 是一分钟周期的 systemd 模板：将 service/timer 安装到
`/etc/systemd/system/`，将 `edge-probe.env.example` 填写后安装为
`/etc/zephyr-edge-probe.env`，再运行：

```bash
sudo useradd --system --home /opt/zephyr-hub --shell /usr/sbin/nologin zephyr
sudo chown -R zephyr:zephyr /opt/zephyr-hub
sudo chown root:zephyr /etc/zephyr-edge-probe.env
sudo chmod 0640 /etc/zephyr-edge-probe.env
sudo systemctl daemon-reload
sudo systemctl enable --now zephyr-edge-probe.timer
```

Nginx 使用 `$remote_addr` 覆盖 `X-Forwarded-For`，不会把客户端伪造的转发头传给
Hub。访问日志只记录请求行、状态和时间，不记录 Authorization、Cookie 或正文。
