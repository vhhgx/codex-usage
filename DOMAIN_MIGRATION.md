# Zephyr Hub 域名迁移方案

本文描述将 Zephyr Hub 部署到香港 VPS，并把现有 `api.vhhg.me`、`sub.vhhg.me`
平滑切换为 Hub 公网入口的方案。当前美国 VPS 上的 CPA 和 Sub2API 继续作为 Hub 上游。

完整服务器部署步骤见 [DEPLOYMENT.md](./DEPLOYMENT.md)。本文只处理域名、上游地址、
TLS 证书和切换顺序。

## 1. 目标架构

```text
客户端
  -> api.vhhg.me  ─┐
  -> sub.vhhg.me ──┴-> 香港 Zephyr Hub
                         ├-> cpa-origin.vhhg.me -> 美国 CPA
                         └-> sub-origin.vhhg.me -> 美国 Sub2API

测试客户端
  -> api.vhhg.pub -> 香港 Zephyr Hub
```

域名分成两类：

| 域名 | 角色 | 最终指向 |
| --- | --- | --- |
| `api.vhhg.me` | Hub 正式主入口 | 香港 VPS |
| `sub.vhhg.me` | Hub 兼容入口 | `api.vhhg.me` |
| `api.vhhg.pub` | Hub 测试入口 | 香港 VPS |
| `cpa-origin.vhhg.me` | CPA 源站 | 美国 VPS |
| `sub-origin.vhhg.me` | Sub2API 源站 | 美国 VPS |

公开入口域名和上游源站域名必须分开。正式切换后，Hub 不能继续把
`api.vhhg.me` 或 `sub.vhhg.me` 当作上游地址，否则请求会回到 Hub 自己并形成循环。

## 2. 第一阶段：准备美国源站域名

本阶段不修改现有 `api.vhhg.me` 和 `sub.vhhg.me`，不会影响现网。

在 GoDaddy 的 `vhhg.me` DNS 中新增：

| 类型 | 名称 | 值 | TTL |
| --- | --- | --- | --- |
| `A` | `cpa-origin` | 美国 VPS 公网 IP | `600` |
| `A` | `sub-origin` | 美国 VPS 公网 IP | `600` |

两个记录可以指向同一个美国 IP。美国 VPS 的 Nginx 根据 Host 分别代理到 CPA 和
Sub2API 的本地端口。

美国 VPS 需要同时接受以下域名：

```text
cpa-origin.vhhg.me
sub-origin.vhhg.me
```

为源站域名申请 TLS 证书，并保持旧域名的 Nginx 配置和证书暂时可用，以便回滚。

从香港 VPS 验证源站：

```bash
curl -I https://cpa-origin.vhhg.me
curl -I https://sub-origin.vhhg.me
```

进一步使用各自的客户端 Key 验证 `/v1/models`，并使用管理密钥验证管理 API。不要把
真实 Key 写入终端历史、文档或 Git。

## 3. 第二阶段：部署测试域名

在 GoDaddy 的 `vhhg.pub` DNS 中新增或修改：

| 类型 | 名称 | 值 | TTL |
| --- | --- | --- | --- |
| `A` | `api` | 香港 VPS 公网 IP | `600` |

确认解析：

```bash
dig +short api.vhhg.pub
```

返回香港 VPS IP 后，为测试域名申请证书：

```bash
sudo certbot certonly \
  --standalone \
  --agree-tos \
  --non-interactive \
  --email <管理员邮箱> \
  -d api.vhhg.pub
```

按照 [DEPLOYMENT.md](./DEPLOYMENT.md) 的 TLS 章节，将证书放入香港部署目录并启动
Compose。

测试入口为：

```text
https://api.vhhg.pub/login
```

## 4. 香港 Hub 的上游配置

### 4.1 环境变量中的管理连接

Sub2API 账号、OAuth、分组和代理管理必须使用源站域名：

```dotenv
NUXT_SUB2API_BASE_URL=https://sub-origin.vhhg.me
NUXT_SUB2API_ADMIN_API_KEY=<Sub2API 管理密钥>
```

当前不使用 CPA 管理和 CPA Manager Plus 时保持为空：

```dotenv
NUXT_CPA_BASE_URL=
NUXT_CPA_MANAGEMENT_KEY=
NUXT_CPAMP_BASE_URL=
NUXT_CPAMP_ADMIN_KEY=
```

以后需要 Hub 管理 CPA 认证文件时，使用 CPA 源站域名：

```dotenv
NUXT_CPA_BASE_URL=https://cpa-origin.vhhg.me
NUXT_CPA_MANAGEMENT_KEY=<CPA Management Key>
```

### 4.2 页面中的业务渠道

“资源管理 > 渠道”使用客户端 API Key，负责 Hub `/v1/*` 请求转发：

| 渠道 | Base URL | Key |
| --- | --- | --- |
| CPA | `https://cpa-origin.vhhg.me` | CPA 客户端 API Key |
| Sub2API | `https://sub-origin.vhhg.me` | Sub2API 客户端 API Key |

页面中的渠道和 `.env` 中的管理连接用途不同，即使 URL 相同，凭据也不能混用。

## 5. 测试阶段验收

在修改正式 DNS 前完成：

- `https://api.vhhg.pub/login` 可以登录。
- `/api/ready` 返回成功。
- 账号管理可以读取 Sub2API 账号、分组和代理。
- OAuth 授权可以完成账号添加。
- CPA/Sub2API 业务渠道健康检测通过。
- Hub Key 可以访问 `/v1/models`。
- Chat Completions、Responses 非流式和 SSE 请求通过。
- 请求日志、Token 和费用统计正常。
- 香港 Hub 到美国源站的延迟和稳定性可接受。
- 数据库和 MinIO 备份任务完成一次。

## 6. 正式切换前准备

至少提前一天将以下现有记录 TTL 调低到 `600` 秒：

```text
api.vhhg.me
sub.vhhg.me
```

确认香港 `.env` 和页面渠道已经全部改为 `*-origin.vhhg.me`。检查仓库和部署文档中没有
真实密码、管理密钥或证书私钥。

在维护窗口开启 Hub 流量排空，并保留美国 VPS 的旧站点配置，不要立即删除。

## 7. 正式 DNS 切换

在 GoDaddy 修改 `api.vhhg.me`：

| 类型 | 名称 | 值 | TTL |
| --- | --- | --- | --- |
| `A` | `api` | 香港 VPS 公网 IP | `600` |

将 `sub.vhhg.me` 改成兼容别名：

| 类型 | 名称 | 值 | TTL |
| --- | --- | --- | --- |
| `CNAME` | `sub` | `api.vhhg.me` | `600` |

同一个名称不能同时存在 `A` 和 `CNAME`。创建 `sub` 的 CNAME 前，先删除旧的
`sub.vhhg.me` A 记录。

也可以让 `sub.vhhg.me` 使用指向香港 IP 的 A 记录，但 CNAME 更便于以后只修改一个
主域名 IP。

DNS 只负责解析，不执行 HTTP 重定向。两个域名最终都直接访问同一个 Hub。不要用
`301`、`302` 或 `308` 把 OpenAI API POST 请求从 `sub.vhhg.me` 重定向到
`api.vhhg.me`，部分 SDK 不跟随跨域 POST，或会移除 Authorization Header。

## 8. 正式 TLS 证书

DNS 已解析到香港 VPS 后，停止 Docker Nginx 以释放 80 端口：

```bash
cd /opt/zephyr-hub/deploy/hong-kong
docker compose stop nginx
```

申请同时覆盖正式域名和测试域名的证书：

```bash
sudo certbot certonly \
  --standalone \
  --agree-tos \
  --non-interactive \
  --email <管理员邮箱> \
  -d api.vhhg.me \
  -d sub.vhhg.me \
  -d api.vhhg.pub
```

证书目录通常为：

```text
/etc/letsencrypt/live/api.vhhg.me/
```

使用当前 Compose 的 `./tls` 方案时：

```bash
sudo install -m 0644 \
  /etc/letsencrypt/live/api.vhhg.me/fullchain.pem \
  /opt/zephyr-hub/deploy/hong-kong/tls/fullchain.pem

sudo install -m 0600 \
  /etc/letsencrypt/live/api.vhhg.me/privkey.pem \
  /opt/zephyr-hub/deploy/hong-kong/tls/privkey.pem
```

将香港 Nginx 的两个 `server_name` 设置为：

```nginx
server_name api.vhhg.me sub.vhhg.me api.vhhg.pub;
```

文件位置：

```text
/opt/zephyr-hub/deploy/hong-kong/nginx.conf
```

启动并检查：

```bash
docker compose up -d nginx
docker compose logs --tail=100 nginx
```

Certbot 自动续期 deploy hook 中的证书目录应使用：

```sh
DOMAIN=api.vhhg.me
```

续期的 pre/deploy/post Hook 和 `certbot.timer` 配置见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 9. 避免请求循环

正式切换后，以下配置是错误的：

```dotenv
NUXT_SUB2API_BASE_URL=https://sub.vhhg.me
NUXT_CPA_BASE_URL=https://api.vhhg.me
```

此时两个域名都指向香港 Hub，调用链会变成：

```text
Hub -> api.vhhg.me/sub.vhhg.me -> Hub -> ...
```

正确配置始终使用源站域名：

```dotenv
NUXT_SUB2API_BASE_URL=https://sub-origin.vhhg.me
NUXT_CPA_BASE_URL=https://cpa-origin.vhhg.me
```

不使用 CPA 管理功能时，`NUXT_CPA_BASE_URL` 和 `NUXT_CPA_MANAGEMENT_KEY` 保持为空。

页面中的业务渠道同样只能使用 `cpa-origin.vhhg.me` 和 `sub-origin.vhhg.me`。

## 10. 切换后验证

检查 DNS：

```bash
dig +short api.vhhg.me
dig +short sub.vhhg.me
```

检查三个入口：

```bash
curl -I https://api.vhhg.me/login
curl -I https://sub.vhhg.me/login
curl -I https://api.vhhg.pub/login
```

使用测试 Hub Key 分别通过 `api.vhhg.me` 和 `sub.vhhg.me` 调用：

```text
GET /v1/models
POST /v1/responses
POST /v1/chat/completions（SSE）
```

同时检查请求日志，确认上游渠道显示为 CPA/Sub2API 源站，而不是 Hub 自己。

## 11. 回滚方案

切换后一段时间内保留美国 VPS 上原 `api.vhhg.me` 和 `sub.vhhg.me` 的 Nginx 配置、证书
和服务。

需要回滚时，在 GoDaddy 恢复：

| 域名 | 恢复记录 |
| --- | --- |
| `api.vhhg.me` | A -> 美国 VPS IP |
| `sub.vhhg.me` | A -> 美国 VPS IP |

TTL 为 600 秒时，多数客户端会在数分钟内恢复访问美国站点。回滚不会影响新增的
`cpa-origin.vhhg.me` 和 `sub-origin.vhhg.me`。

回滚后保留香港 Hub 和 `api.vhhg.pub`，用于定位问题并再次演练，不要直接销毁香港数据卷。

## 12. 推荐执行顺序

```text
1. 新增 cpa-origin.vhhg.me -> 美国 VPS
2. 新增 sub-origin.vhhg.me -> 美国 VPS
3. 给两个源站域名配置美国 Nginx 和 TLS
4. 新增 api.vhhg.pub -> 香港 VPS
5. 香港 Hub 的环境变量和页面渠道改用 origin 域名
6. 在 api.vhhg.pub 完整验收
7. 将 api.vhhg.me、sub.vhhg.me TTL 降到 600
8. 进入维护窗口并备份
9. api.vhhg.me 改到香港 VPS
10. sub.vhhg.me 改为 api.vhhg.me 的 CNAME
11. 申请覆盖三个公网入口的正式证书
12. 验证两个正式入口和回滚路径
```
