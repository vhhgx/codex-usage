# Zephyr Hub 紫色双主题 UI 改造方案

## 1. 文档目标

本文是 Zephyr Hub 整站 UI 改造的实施合同，供后续开发、验收和代码审查使用。

视觉参考：

- `/home/vhhg/workspace/www/taste/index-v2-kimi.html`
- `/home/vhhg/workspace/www/taste/index-v2-kimi-light.html`
- `/home/vhhg/workspace/www/taste/DESIGN.md`
- `/home/vhhg/workspace/www/taste/design-tokens.css`

原型只作为视觉和交互参考。生产实现必须使用当前项目的 Nuxt、Vue、TypeScript、现有组件和数据接口，不复制原型中的 CDN、`innerHTML`、字符串模板或全局事件代码。

## 2. 已确认方向

- 改造范围：整站分阶段改造。
- 品牌主色：采用原型的紫色体系。
- 主题：暗色和亮色双主题。
- 首次访问：跟随操作系统主题。
- 主题持久化：用户选择写入 `zephyr_theme` Cookie。
- 品牌标识：保留现有心电图标识，不改为菱形。
- 字体：保留 Manrope Variable 和 JetBrains Mono Variable。
- 图标：保留 `@tabler/icons-vue`。
- 样式方案：继续使用语义类和 CSS variables，不引入 Tailwind。
- 信息架构、路由、权限和业务流程保持不变。

设计参数：

- `DESIGN_VARIANCE: 4`
- `MOTION_INTENSITY: 2`
- `VISUAL_DENSITY: 8`

这是高频使用的 B2B 管理控制台。视觉应克制、紧凑、可扫描，不采用营销页的大留白和装饰性布局。

## 3. 光效说明

原型中存在两种不同的紫色光效，迁移时不得混淆。

### 3.1 静态环境光

原型的 `body::before` 使用固定径向渐变，为页面背景提供很弱的紫色环境光。它不跟随鼠标。

生产实现可以保留极弱的静态环境光，但不得形成明显的独立光球，也不能影响文本、表格和图表对比度。`prefers-reduced-transparency` 模式下必须关闭。

### 3.2 鼠标 Spotlight

原型的 `.glass-panel::before` 根据 `--spot-x` 和 `--spot-y` 显示跟随鼠标的局部 Spotlight。这是需要保留的交互效果。

适用范围：

- 运行总览指标卡。
- 请求趋势面板。
- 当前容量面板。
- 少量需要强调层级的总览面板。

禁用范围：

- 账号管理表格。
- 请求日志和审计日志列表。
- 表单和弹窗正文。
- 移动端和无精确指针设备。
- `prefers-reduced-motion`。
- `prefers-reduced-transparency`。

实现时使用组件局部 `pointermove`，在组件卸载时移除监听。只更新 CSS variables，不触发 Vue 响应式重渲染。

## 4. 规范文件需要修订的内容

### 4.1 `DESIGN.md`

- 明确本项目不引入 Tailwind，删除可选 Tailwind 迁移分支。
- 明确紫色双主题、心电图品牌标识和系统主题默认策略。
- 区分静态环境光与鼠标 Spotlight。
- 账号管理邮箱列加入业务例外：完整显示、不截断、不限制文本宽度。
- 普通图标按钮保持 `36px`，密集表格支持 `28px` 紧凑图标按钮。
- 删除原型中不存在实际功能的全局搜索、通知和工作区切换要求。
- 明确管理端移动导航统一使用抽屉，不使用多行底部导航。
- 明确玻璃材质只用于壳层、浮层和少量总览面板，高密度业务面板使用稳定表面。

### 4.2 `design-tokens.css`

保留现有 `--hub-*` 命名，补充以下 token：

- `--hub-weight-bold` 和 `--hub-weight-heavy`。
- `--hub-icon-button-size-compact: 1.75rem`。
- 响应式页面水平边距。
- 表头高度、表格行高和单元格 padding。
- badge 高度和水平 padding。
- primary、secondary、quiet、danger 按钮的背景、边框和前景角色。
- skeleton、selection、overlay、disabled 和 loading 表面角色。
- 图标默认线宽和紧凑图标线宽。
- Spotlight 颜色、半径和透明度。

静态环境光和 Spotlight 必须使用不同 token，不允许复用同一个变量造成语义混乱。

## 5. 主题与应用壳层

### 5.1 SSR 主题

主题偏好固定为：

```ts
type HubThemePreference = 'system' | 'dark' | 'light'
```

- 未设置 Cookie 时使用 `system`。
- `system` 模式由媒体查询在首屏直接选择颜色，避免客户端挂载后闪烁。
- 用户明确选择暗色或亮色时，服务端直接输出 `html.dark` 或 `html.light`。
- `<meta name="theme-color">` 与当前主题同步。
- 原生表单和滚动条使用正确的 `color-scheme`。

### 5.2 管理端与用户端壳层

- `admin.vue` 和 `console.vue` 共用视觉原语，但保留各自菜单和权限逻辑。
- 桌面侧边栏宽度为 `240px`。
- 内容最大宽度为 `1504px`。
- 顶栏只包含面包屑、主题切换和移动菜单按钮。
- 不添加没有真实行为的全局搜索、通知、工作区切换或重复用户按钮。
- 菜单可以按工作区、资源和运维分组，但路由、文字和顺序不变。

### 5.3 移动导航

- 小于 `960px` 使用左侧抽屉。
- 抽屉支持焦点管理、Escape 关闭、遮罩点击关闭和焦点返回。
- 固定元素考虑 `safe-area-inset-*`。
- 删除当前将全部管理菜单塞入两行底部导航的实现。

## 6. 基础组件改造

- `admin-page-tabs` 继续作为全站唯一 tabs 样式。
- 统一按钮、图标按钮、输入框、`AppSelect`、badge、状态、表格、工具栏、toast、modal 和 drawer。
- 主操作使用图标加文字；刷新、关闭、复制等熟悉操作允许纯图标按钮。
- 所有纯图标按钮必须有 `aria-label` 和 tooltip/title。
- 危险操作继续使用 `AppConfirmDialog`。
- modal 必须支持焦点管理、Escape 关闭和焦点返回。
- 错误显示在对应表单或局部数据区域，toast 只负责短暂反馈。
- 页面区块不嵌套装饰性卡片，高密度数据优先使用表格或紧凑列表。

交互动效限定在 `120-180ms`。不迁移原型中 `520ms` 的卡片逐个入场动画，不动画尺寸、padding、blur 或大面积 backdrop-filter。

## 7. 运行总览改造

页面结构固定为：

1. 页面标题、Hub Key、时间范围和筛选工具栏。
2. 请求量、Token、Hub 成本、平均延迟四项指标。
3. 宽请求趋势和窄当前容量。
4. 模型分布、渠道流量、用量排行三列。
5. Codex Radar、CPA 和 Sub2API 上游容量。

具体修改：

- 删除端点分布和状态分布面板。
- 用户、分组和 Hub Key 排行合并为一个 tabs 组件。
- 请求趋势改为平滑 SVG 曲线。
- 缺失或非法数据必须切断曲线，不能跨空值连线。
- 宽屏下首尾点始终位于绘图区内。
- 图表支持鼠标、键盘和触屏数据摘要。
- Radar 保留完整 `gpt-` 前缀。
- Radar 固定按 `ultra -> max -> xhigh -> high -> medium -> low` 排序，不按成本排序。
- CPA/Sub 账号使用紧凑票据，只突出剩余额度、恢复时间和错误状态。

## 8. 账号管理特殊要求

账号管理属于高风险业务页面，改造只调整布局和样式，不同时重构账号合并、导入、OAuth、接码、刷新或删除逻辑。

邮箱显示必须满足：

- 保持当前完整显示状态。
- 不使用 `max-width` 限制邮箱文本。
- 不使用 ellipsis、truncate 或 line-clamp。
- 标签、邮箱和相邻内容垂直居中。
- 邮箱内容过长时，由表格容器横向滚动，不压缩邮箱本身。

短信接码、状态 badge、容量、调度和操作按钮继续采用紧凑表格布局。表格内的小按钮使用紧凑尺寸，不修改全局普通按钮尺寸。

## 9. 分阶段实施

### 阶段一：基础设施

- 将 tokens 放入项目。
- 建立 SSR 主题和主题切换。
- 改造 admin/console 壳层与移动抽屉。
- 统一基础组件和全局 focus 状态。

### 阶段二：运行总览

- 改造指标、筛选、趋势、容量和排行。
- 修正 Radar 标签与排序。
- 改造 CPA/Sub 紧凑配额区域。
- 接入限定范围的鼠标 Spotlight。

### 阶段三：高密度管理页面

- 账号管理。
- 号池配置。
- 资源管理。
- Hub Keys。
- 请求日志与审计日志。

### 阶段四：剩余页面

- 其余管理端页面。
- 用户控制台。
- 登录页。
- 公开工具与用量页面。

每个阶段完成后必须保持项目可构建、可操作，并形成独立提交。

## 10. 接口与兼容性

- 不修改服务端业务 API。
- 不修改数据库结构。
- 不修改现有请求载荷和响应类型。
- 不修改权限判断和路由地址。
- 不修改 OAuth、接码、导入、调度、Key 管理和日志详情行为。
- 新增的公共客户端状态仅限主题偏好和移动抽屉状态。
- 旧 CSS variables 在全部页面迁移完成前保留，避免半迁移页面失去样式。

## 11. 验证标准

每个阶段运行：

```bash
npm test
npm run typecheck
npm run build
```

Playwright 覆盖：

- `375px`
- `720px`
- `960px`
- `1440px`
- `1920px`
- 暗色主题
- 亮色主题

必须验证：

- 首次加载、刷新和切换主题无闪烁、无 hydration warning。
- Spotlight 正确跟随指针，且在禁用场景不运行。
- 页面整体无横向溢出，复杂表格只在自身容器滚动。
- 账号邮箱完整显示且不被压缩或截断。
- 侧边栏、tabs、select、modal、drawer 和图标按钮可用键盘操作。
- focus ring 清晰，普通文本达到 WCAG AA。
- `prefers-reduced-motion` 和 `prefers-reduced-transparency` 生效。
- 账号授权、接码、导入、额度刷新、Key 管理和日志详情行为无回归。
