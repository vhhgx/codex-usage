# Key 实时活跃与跨境访问部署方案

## 开发状态（2026-07-30）

- [x] `GET /api/admin/key-activity`、系统时区日界线、普通日 24 小时及夏令时切换日 23/25 小时补零和完整 Key 列表合并。
- [x] 成功/失败/流中断/进行中口径、默认排除 `/v1/models`、最近 5 分钟判定。
- [x] Hub Keys 活跃热力表、请求/Token/成本切换、四种筛选、当前小时、30 秒刷新和手动刷新。
- [x] 小屏横向滚动与固定信息列；点击小时格带 `keyId/from/to` 跳转请求日志。
- [x] 总览原“活跃 Hub Key”语义改为“已启用 Key”。
- [x] 活跃统计单元测试与 PostgreSQL E2E；已覆盖停用/过期 Key、日志下钻和 `/v1/models` 排除。
- [x] 可信代理 IP/CIDR 校验，公网伪造 `X-Forwarded-For` 不再影响审计记录或绕过 Redis 共享限流。
- [x] 香港 Nginx + WireGuard 过渡线路配置，包含 SSE、50 MB 上传、TLS 和脱敏访问日志设置。
- [x] 控制台提供 P95 首字节与 SSE 中断率，线路探测脚本覆盖模型、非流式、SSE、并发和可选图片上传。
- [x] 香港完整 Hub 生产镜像定义、运行时迁移器、私有全栈 Compose、内部 readiness 和 systemd/Webhook 探测模板。
- [x] Prometheus 指标、签名 Webhook 告警、共享流量排空、备份校验与隔离恢复演练工具。
- [ ] 在真实香港节点部署线路机，并完成电信/联通/移动、晚高峰和长时间 SSE 验收。
- [ ] 迁移 PostgreSQL、Redis、对象存储和 Hub 到香港，完成 DNS 切换与回退演练。
- [ ] 在真实香港节点将 Prometheus、签名 Webhook 和 `npm run test:edge` 接入生产告警通知。

线路机配置位于 `deploy/edge/`。未勾选项依赖真实服务器、域名、证书、网络和上游凭据，
当前仓库无法用本地测试替代其验收。

## 1. 文档目的

本文包含两项方案：

1. 在管理后台增加 Hub Key 今日活跃、最近活跃和分时段活跃能力。
2. 解决部分中国大陆用户无法稳定直连美国服务器的问题，并评估将 Hub 部署到香港作为接入线路的可行性。

结论如下：

- Key 活跃功能可以复用现有 `request_logs` 和 `usage_rollups`，第一版不需要修改数据库结构。
- Hub 可以部署在香港并继续访问美国的 Sub2API 上游，用户只需要连接香港 Hub，不再直接访问美国 Sub2API。
- 当前规模下优先推荐“香港完整部署 Hub + 美国 Sub2API 作为上游”。如果暂时不迁移数据服务，可先使用“香港反向代理 + 加密隧道 + 美国 Hub”作为过渡方案。
- 香港线路通常比大陆用户直连美国更容易访问，但跨境网络质量受运营商、时段和线路影响，不能保证所有地区始终稳定。

## 2. Key 活跃功能

### 2.1 当前能力与问题

项目已经具备以下数据：

- `request_logs` 记录每次请求的 `key_id`、`created_at`、状态、Token、成本、模型和端点。
- `request_logs` 已有 `(key_id, created_at)` 联合索引。
- `usage_rollups` 按小时和天保存 Key 维度汇总。
- `hub_keys.last_used_at` 保存最近一次完成使用时间。

改造前总览中的“活跃 Hub Key”实际表示 `status = active` 的可用 Key 数量，并不表示今天实际产生过请求的 Key。当前实现已将该字段改名为“已启用 Key”，并单独增加“今日活跃 Key”。

### 2.2 活跃口径

建议采用以下固定定义：

| 状态 | 定义 |
| --- | --- |
| 今日活跃 | 按系统时区，从今天 00:00 到当前时间至少产生过一次业务请求 |
| 最近活跃 | 最后一次请求距当前时间不超过 5 分钟 |
| 今日未活跃 | Key 存在，但今天没有业务请求 |
| 已启用 | Key 的管理状态为 `active`，不代表实际使用 |

统计建议：

- 活跃请求包含成功、失败、流中断和进行中的请求，因为它们都表示客户端正在使用该 Key。
- 默认排除 `/v1/models`。部分 SDK 会自动探测模型列表，把它计入会产生虚假活跃。
- 无法通过鉴权的请求没有可确认的 `key_id`，不归入任何 Key。
- 已鉴权但因模型权限、端点权限或额度被拒绝的请求仍可计入活跃，但应在失败数中体现。
- 页面应使用“最近活跃”，不使用“在线”。无状态 HTTP 请求无法证明客户端持续在线。
- 活跃矩阵返回所有当前存在的 Key，包括已停用和已过期 Key；已删除 Key 不再出现在矩阵，
  其历史请求仍保留在请求日志中并显示为“已删除 Key”。

### 2.3 页面设计

建议在“Hub Keys”页面增加独立的“今日 Key 活跃度”区域：

```text
Key             今日请求  成功率  最后请求   00 01 02 ... 10 11 12 ... 23
研发团队 A         126     98%    11:42     ·  ·  ·     ▓  █  ▒
自动任务 B          18    100%    08:17     ·  ·  ▒     ·  ·  ·
测试 Key             0      -     从未使用   ·  ·  ·     ·  ·  ·
```

交互要求：

- 每行一个 Key，每列一个小时，颜色深浅表示该小时的请求数、Token 或成本。
- 提供“请求数 / Token / 成本”指标切换。
- 提供“全部 / 今日活跃 / 最近 5 分钟 / 今日未活跃”筛选。
- 当前小时突出显示；普通日完整展示 24 个小时，夏令时开始/结束日按实际绝对时间展示 23/25 个桶，无数据小时补零，重复小时通过各自起止时间区分。
- 每 30 秒自动刷新，保留手动刷新按钮并显示最后更新时间。
- 点击某个小时格，跳转请求日志页面，并带上 Key、开始时间和结束时间筛选。
- 小屏幕使用横向滚动的固定列热力表，不把当天全部小时桶压缩到不可读。

### 2.4 API 设计

新增管理员接口：

```http
GET /api/admin/key-activity?date=2026-07-29
```

建议响应：

```ts
interface KeyActivityResponse {
  timezone: string
  from: number
  to: number
  generatedAt: number
  activeCount: number
  recentlyActiveCount: number
  keys: Array<{
    id: string
    name: string
    maskedKey: string
    status: 'active' | 'disabled' | 'expired'
    requests: number
    successes: number
    failures: number
    pending: number
    tokens: number
    cost: number
    lastSeenAt: number | null
    recentlyActive: boolean
    buckets: Array<{
      timestamp: number
      requests: number
      tokens: number
      cost: number
      failures: number
    }>
  }>
}
```

今日页面应直接查询 `request_logs`：先用绝对起止时间限制 `created_at`，再按配置时区、小时和 `key_id` 分组。随后与完整 Key 列表合并，以便返回零请求 Key。

不建议第一版只读取 `usage_rollups`，因为汇总在请求结束后写入，长时间流式请求不会立即显示。历史日期可以读取小时汇总；未来请求量非常大时，可以组合“已结束小时读取汇总、当前小时读取请求日志”。

### 2.5 测试范围

- [x] 系统时区下的今日 00:00 边界和跨午夜请求。
- [x] 普通日 24 小时、夏令时切换日 23/25 小时补零、精确起止时间及当前小时定位。
- [x] 成功、失败、流中断、进行中请求的统计口径。
- [x] `/v1/models` 默认排除。
- [x] 今日没有请求的 Key 仍然返回。
- [x] 已停用、已过期及已删除 Key 的显示规则。
- [x] 点击热力格跳转日志后的 `keyId/from/to` 过滤准确性。
- [x] 自动刷新销毁定时器，避免离开页面后继续请求。

## 3. 香港线路机与 Hub 部署

### 3.1 请求链路可以这样调整

当前问题可以通过把用户入口前移到香港解决：

```text
中国大陆用户
      |
      | HTTPS，用户只访问香港域名
      v
香港 Zephyr Hub
      |
      | HTTPS 或 WireGuard 内网
      v
美国 Sub2API
      |
      v
模型上游
```

Hub 的渠道配置本身支持任意合法的 HTTP/HTTPS Base URL，所以香港 Hub 可以直接把美国 Sub2API 地址配置为上游渠道。用户不需要知道或访问美国地址，也不需要在客户端配置代理。

这能改善的是用户到入口的可达性和连接稳定性。模型请求仍需要经过香港到美国，因此首字节延迟仍包含这段跨境耗时，不能把它理解为把整个上游加速到了香港。

### 3.2 方案 A：香港完整部署 Hub，推荐

在香港部署以下完整组件：

- Nuxt/Nitro Hub 应用。
- PostgreSQL。
- Redis。
- MinIO 或 S3 兼容对象存储。
- Nginx 或 Caddy TLS 入口。

美国服务器只保留 Sub2API，并通过受限的 HTTPS 地址或 WireGuard 私网提供给香港 Hub。

优点：

- 用户到 Hub 的鉴权、限流和请求接收都在香港完成。
- 管理后台、Key 活跃统计和日志查询不依赖香港到美国的数据库连接。
- PostgreSQL 与 Redis 和应用在同一区域，额度检查不会增加跨境延迟。
- 架构简单，故障范围清晰。

代价：

- 需要迁移 Hub 的数据库、Redis 状态和对象存储。
- 请求及响应日志会存储在香港，需要结合业务的数据合规要求决定保留内容和期限。
- 美国 Sub2API 仍是单点，上游断开时香港入口也无法完成请求。

这是当前最合适的正式方案。

### 3.3 方案 B：香港只作为反向代理线路机，过渡方案

```text
用户 -> 香港 Nginx -> WireGuard/mTLS -> 美国 Hub -> 美国 PostgreSQL/Redis/MinIO -> Sub2API
```

香港服务器不运行第二套 Hub，也不保存独立 Key 和额度数据，只负责 TLS 接入和流式转发。

优点：

- 不迁移数据库，部署快，容易回滚。
- 用户访问香港域名，不直接连接美国服务器。
- 美国 Hub 的 Key、日志和限额仍只有一份。

限制：

- 每个请求最终仍需要到美国 Hub，整体延迟改善有限。
- 香港到美国链路中断时服务不可用。
- 香港代理能够接触 Hub Key 和请求内容，必须按生产节点标准保护。
- SSE 必须关闭代理缓冲并增加读取超时，否则流式响应可能被延迟或中断。

线路机建议通过 WireGuard 访问美国源站。美国源站防火墙只允许 WireGuard 地址或香港出口 IP，不应继续向公网开放 Hub 端口。

参考 Nginx 关键配置：

```nginx
location / {
    proxy_pass http://10.20.0.2:8371;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;

    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    client_max_body_size 50m;
}
```

TLS、访问日志脱敏、可信代理范围、连接数和速率限制还需要在实际部署配置中补齐。应用不能无条件信任公网传入的 `X-Forwarded-For`，只应信任香港代理节点写入的地址。

### 3.4 不建议：两地各运行一套独立 Hub

不能在美国和香港分别运行 Hub，并让它们使用各自的 PostgreSQL 和 Redis 后直接轮询流量。这样会出现：

- 同一个 Key 在两地的日额度、RPM 和并发额度分别计算，限制可被绕过。
- Key 的启停、到期时间和权限不能立即同步。
- 请求日志与活跃统计分裂，无法得到准确总量。
- 加权轮询、熔断和渠道并发状态不一致。

多地域主动运行需要共享一致的数据面或专门设计全局额度服务，复杂度明显超过当前 10 个 Key 的需求。

### 3.5 大陆服务器与香港服务器的区别

中国大陆服务器也可以作为入口，但通常需要考虑域名备案、云厂商接入要求、业务合规以及大陆到美国上游的跨境质量。将服务器放到大陆并不会自动解决访问美国 Sub2API 的稳定性，反而可能把问题转移到服务器的出站链路。

香港节点通常不要求大陆 ICP 备案即可部署国际域名，但普通香港公网线路对不同大陆运营商的质量差异较大。选购时应实际测试目标用户所在地区，并优先考虑明确提供大陆优化回程的线路，例如面向电信、联通、移动优化的 CN2 GIA、CU Premium 或 CMI 类线路。线路名称只能作为筛选条件，最终仍应以晚高峰的丢包、抖动、首字节和 SSE 长连接测试为准。

普通国际 CDN 不一定适合直接代理长时间 AI API 请求。部分 CDN 对请求时长、上传大小、SSE、WebSocket、使用条款或中国大陆加速有额外限制；中国大陆 CDN 节点通常还涉及备案与服务准入，不建议把它作为第一阶段的核心依赖。

## 4. 推荐落地顺序

### 第一阶段：验证香港线路

1. [ ] 购买一台带大陆优化线路的香港服务器，绑定独立测试域名并启用 HTTPS。
2. [x] 准备 Nginx 线路机和 WireGuard 双端配置；真实节点部署仍待服务器到位。
3. [ ] 从中国电信、联通、移动网络分别测试非流式、SSE、50 MB 上传、并发和晚高峰稳定性。
4. [ ] 记录连接成功率、DNS 时间、TCP/TLS 时间、首字节、流中断率和整体延迟。

### 第二阶段：完整迁移 Hub 到香港

1. [x] 提供香港应用镜像、PostgreSQL/Redis/MinIO/Nginx 全栈 Compose、自动迁移和私有网络配置。
2. [ ] 备份并迁移真实 PostgreSQL、MinIO 对象和应用配置。
3. [ ] 在香港启动真实 Redis，并在停机窗口内从 PostgreSQL 对账恢复额度计数。
4. [ ] 保持真实环境 `NUXT_ENCRYPTION_KEY`、`NUXT_HUB_KEY_PEPPER` 等密钥与旧环境一致。
5. [ ] 将真实 Hub 渠道 Base URL 指向美国 Sub2API 的私网隧道地址或受限 HTTPS 地址。
6. [ ] 先用测试域名和测试 Key 验证，再降低 DNS TTL 并切换正式域名。
7. [ ] 切换期间只允许一个 Hub 数据面接收正式写流量，避免双写和额度分裂。

### 第三阶段：可靠性增强

- [x] 控制台展示 SSE 中断率和 P95 首字节，提供可定时运行的结构化线路探测脚本。
- [x] 提供一分钟 systemd Timer 与失败 Webhook 通知模板。
- [x] 提供认证 Prometheus 指标、签名 Webhook 告警、冷却提醒与恢复通知；香港 Compose 可选私网 Prometheus profile。
- [x] 提供带自动过期的共享流量排空，`/api/ready` 在排空期间返回 `503`，并可等待活动请求归零后维护。
- [x] 提供 PostgreSQL custom dump、MinIO 对象镜像、SHA-256 清单、可选 `age` 加密及显式确认恢复脚本；隔离恢复演练已通过。
- [ ] 在真实香港节点采集隧道与 Sub2API 健康，并将探测结果接入告警通知。
- 准备 DNS 回退方案，但切换目标必须使用同一份最新 Key 和额度状态。
- 如果美国 Sub2API 支持安全复制，可增加第二上游并利用 Hub 现有渠道故障转移，而不是复制 Hub 数据面。
- 请求正文不是统计必需数据，可根据合规和风险降低正文保留期，或关闭不必要的正文归档。

## 5. 验收标准

- [ ] 大陆目标用户无需代理即可访问真实香港 Hub 域名并完成模型请求。
- [ ] Chat Completions 和 Responses 经真实香港线路时 SSE 首块及时到达，持续输出不被缓存。
- [ ] 图片编辑等大请求经真实香港线路能够完整上传，不受代理默认大小限制。
- [ ] Hub Key、渠道凭据、数据库、Redis 和对象存储在生产网络中均不直接暴露公网。
- [ ] 美国源站防火墙只接受香港节点或 WireGuard 私网流量。
- [x] Key 的 RPM、并发和日/周/月额度由同一 PostgreSQL/Redis 数据面作为唯一权威状态源。
- [x] 今日 Key 活跃矩阵与请求日志抽样一致，并按配置时区正确跨日。
- [x] 本地 readiness、Prometheus、Webhook、排空和备份恢复路径已有自动化或实际演练证据。
- [ ] 真实香港生产环境已配置独立指标/运维令牌、告警接收端和定时备份，并完成一次恢复演练。
- [ ] 切换和回退过程中不会出现两套独立 Hub 同时接收正式写流量。
