# 中转能力检测、协议转换与模型路由实现说明

## 1. 版本信息

- 实现提交：`1127882 feat: add capability-aware relay routing`
- 数据库迁移：`0037_relay_capability_routing.sql`、`0038_responses_chat_conversion.sql`
- 香港生产环境：已部署，应用容器和公网健康检查正常

## 2. 中转添加与保存

添加中转时不再要求用户理解或手工选择 Responses、Chat Completions、Anthropic Messages、Bearer、`x-api-key` 等协议细节。

自定义中转只需要选择以下模型品类，支持多选：

- GPT
- Claude
- 其他厂商

官方服务商预设会自动确定模型品类、基础地址、产品类型和已知原生协议。

保存中转不再依赖以下联网结果：

- 获取模型
- 协议检测
- 检测模型
- 模型映射
- 上游当前是否可连接

模型发现或协议检测失败不会阻止用户保存中转。保存时仍保留必填字段、HTTP(S) URL 格式、URL 中禁止携带凭据以及 HTTP 明文传输确认等结构和安全校验。

## 3. 模型发现

模型发现由用户通过“获取模型”按钮主动执行。Hub 请求上游 `/v1/models`，解析模型 ID，并在上游明确提供标准化每百万 Token 价格时记录价格。

发现后的模型会记录：

- 对外模型名
- 上游模型名
- 规范化模型名
- 厂商家族
- 模型版本
- 映射类型
- 可用协议绑定
- 可选输入、输出、缓存和推理价格

模型会按厂商分组，并通过版本号或日期版本选择该厂商的较新模型作为默认检测模型。

## 4. 自动协议检测

协议检测流程如下：

1. 请求 `/v1/models`，确认网络、认证和模型目录可用。
2. 按模型厂商和版本选择检测模型。
3. GPT 优先检测原生 Responses。
4. 原生 Responses 失败时降级检测 Chat Completions。
5. Claude 检测 Anthropic Messages。
6. 认证失败时自动补测 Bearer 和 `x-api-key`。
7. 保存检测成功的认证方式、协议、检测模型和能力模式。

能力模式包括：

- `native`：上游原生支持请求协议。
- `responses_via_chat`：上游只提供 Chat，通过 Hub 转换支持 Responses。
- `unsupported`：当前能力不可用。

中转列表不再分别展示容易混淆的协议块和健康块，而是使用一行能力摘要。检测详情保留端点、认证方式、耗时、状态码和错误信息。

## 5. Responses 到 Chat Completions 转换

当 Codex 客户端使用 `/v1/responses`，但选中的上游仅支持 `/v1/chat/completions` 时，Hub 可以执行协议转换。

转换层支持：

- instructions 和 system/developer 消息
- 用户与助手文本
- 函数工具定义
- 函数调用
- 工具结果
- reasoning effort
- 非流式 Chat 响应转 Responses 响应
- Chat SSE 转 Responses SSE
- 推理内容
- Token 用量
- 上游错误归一化

路由始终优先使用原生 Responses。只有能力检测确认 Chat 可用并标记为 `responses_via_chat` 后，Chat 转换候选才会参与路由。

无法可靠转换的请求会在发给上游前拒绝当前候选，并继续尝试后续故障转移候选，不会把渠道错误标记为上游故障。

## 6. 官方服务商预设

新增或细化了以下预设：

- 智谱 GLM 原生 Responses：`https://open.bigmodel.cn/api/v1`
- 智谱 GLM API Chat：`https://open.bigmodel.cn/api/paas/v4`
- 智谱 GLM Coding Plan Chat：`https://open.bigmodel.cn/api/coding/paas/v4`
- 豆包 Responses：`https://ark.cn-beijing.volces.com/api/v3`
- MiniMax Responses：`https://api.minimaxi.com/v1`

管理员探测模型目录同时增加了 GLM、豆包和 MiniMax 的默认模型，管理员仍可在后台维护、启用、禁用或替换探测模型。

## 7. 模型故障转移

默认故障转移只切换资源，不切换模型。例如客户端请求 `gpt-5.6-sol` 时，默认只寻找能够提供该模型的套餐、专属号池或中转站。

普通模型映射本身不等于跨模型授权。跨模型替代必须由用户针对请求模型显式开启，并提供有序替代列表，例如：

```text
gpt-5.6-sol
-> glm-5.3
-> MiniMax-M3
```

路由层级为：

1. 客户端请求模型车道
2. 用户显式授权的替代模型车道
3. 当前模型车道内的来源顺序
4. 当前来源内部的账号顺序

替代模型和各模型车道的来源均支持拖拽排序。

## 8. 价格与来源排序

每个请求模型和实际模型组合可以单独选择：

- 手工来源顺序
- 价格升序

价格升序规则：

1. 已知且可标准化的价格优先。
2. 未知价格排在已知价格之后。
3. 价格相同时使用用户保存的手工顺序作为稳定排序。

中转站内部多个账号原有的手工顺序、余额升序和余额降序继续有效。

当账号因为额度耗尽或凭据错误被移出调度队列后，不会自动反复请求。用户手工刷新余额后，账号状态和排序才会重新计算。

## 9. CodexRadar

客户侧增加全局 CodexRadar 配置：

- 开启或关闭自动推理强度
- 设置允许的最高推理档位
- 查看雷达更新时间和评分数量

支持的最高档位包括 Low、Medium、High、XHigh、Ultra 和 Max。

Radar 数据在服务端缓存 30 分钟。在用户允许的最高档位范围内，Hub 选择智力评分最高的推理强度，而不是机械选择最高 effort。

Radar 只调整推理强度，不会：

- 更换模型
- 更改来源顺序
- 自动授权跨模型替代

Radar 仅作用于原生模型或确认的模型别名。`GPT -> GLM` 等跨模型路由不会使用 GPT 的雷达评分。

## 10. 客户侧界面

“我的中转”页面增加或调整了：

- 三种模型品类选择
- 官方服务商预设
- 非阻塞保存
- 手动获取模型
- 一行能力摘要
- 自动协议检测结果抽屉
- 单模型测试按钮
- 模型厂商、版本、价格和映射信息
- 模型路由设置抽屉
- CodexRadar 全局设置
- 替代模型拖拽排序
- 每个模型车道的来源拖拽排序
- 每个模型独立的手工或价格排序方式

检测执行期间保留忙碌状态并阻止重复触发，检测结果不会因为确认弹窗关闭而丢失。

## 11. 数据库变更

主要新增内容包括：

- 渠道服务商预设、厂商、产品类型和模型品类
- 协议能力模式和检测时间
- 模型规范名称、厂商、版本和映射类型
- 渠道模型价格表
- 用户模型替代策略表
- 用户模型来源偏好表
- 用户 Radar 开关和最高 effort
- `responses_to_chat` 协议转换记录类型

应用镜像启动时会先执行 `node server/migrate.mjs`，迁移成功后才启动 Nitro 服务。

## 12. AgentRouter 身份兼容

AgentRouter 会校验请求是否来自允许的 Claude Code、Codex 或其他受支持客户端。Hub 对模型发现和协议检测现在采用条件式身份重试：先发送标准 Bearer 或 `x-api-key` 请求，只有响应正文命中 `unauthorized client`、`client detected` 等身份拒绝特征时，才使用对应协议的兼容客户端身份重试。

```text
HTTP 401 unauthorized client detected
```

如果兼容身份重试仍失败，界面会显示这类响应。它表示：

- 香港服务器已经成功解析域名并连接 AgentRouter。
- 请求已经到达 AgentRouter，不是 DNS 污染或连接超时。
- 错误不等同于 API Key 格式错误。
- 单纯切换 Bearer 和 `x-api-key` 通常不能解决。
- AgentRouter 在认证前后额外执行了客户端身份或反滥用校验。
- 模型发现和协议检测使用同一套条件式身份重试策略。
- 普通中转不会无条件收到伪造的 Claude/Codex 身份头。

协议检测的顺序是：先请求 `/v1/models`，成功后再按模型品类检测具体协议端点。若 `/v1/models` 被 AgentRouter 的客户端身份校验拦截，系统会先完成身份重试；只有模型目录获取成功，才会继续 Responses、Chat 或 Messages 的协议测试。因此基础连接 401 与模型获取 401 属于同一问题，现在由同一套逻辑处理。

## 13. 验证结果

实现提交完成时执行了：

- `npm test`：30 个测试文件、194 项测试通过
- `npm run typecheck`：通过
- `npm run build`：通过
- `git diff --check`：通过

香港生产环境部署后已验证：

- 数据库迁移完成
- 新增表、字段和枚举存在
- 应用容器健康
- 内部 `/api/health` 正常
- 公网 `https://api.vhhg.pub/api/health` 正常
- 新增模型路由和单模型测试 API 已注册并正常执行鉴权
