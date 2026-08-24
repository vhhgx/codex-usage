<script setup lang="ts">
import {
  IconActivityHeartbeat,
  IconCircleCheck,
  IconCloudUpload,
  IconCopy,
  IconEdit,
  IconExternalLink,
  IconFileCode,
  IconLogin2,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconServerCog,
  IconShieldCheck,
  IconTrash,
  IconX,
} from "@tabler/icons-vue";
import type {
  CpaProxyMode,
  ProxyPoolState,
  SubAccountManagementView,
  SubGroupView,
  SubProxyView,
  UpstreamConnectionView,
  UpstreamOperationView,
} from "#shared/types/upstream-management";
import { clientRandomUUID } from "#shared/utils/client-random";
import {
  upstreamOperationActionLabel,
  upstreamOperationConnectionLabel,
  upstreamOperationTargetLabel,
  upstreamOperationTargetTypeLabel,
} from "#shared/utils/upstream-operation-view";

definePageMeta({ layout: "admin", middleware: "admin" });
useSeoMeta({ title: "号池配置 | Zephyr Hub" });

type Tab = "accounts" | "groups" | "proxies" | "operations";
interface ImportAccountRow {
  key: string;
  name: string;
  email: string | null;
  platform: string;
  type: string;
  credentials: Record<string, unknown>;
  extra: Record<string, unknown>;
  concurrency: number;
  priority: number;
  rateMultiplier: number;
  groupIds: string[];
  proxyId: string | null;
}
const tab = ref<Tab>("groups");
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const { show: showToast } = useAppToast();
const authSession = useState<{ user?: { id?: string } } | null>('auth-session', () => null);
const search = ref("");
const operationConnection = ref("");
const operationStatus = ref("");
const loaded = reactive<Record<Tab, boolean>>({
  accounts: false,
  groups: false,
  proxies: false,
  operations: false,
});
const upstreams = ref<UpstreamConnectionView[]>([]);
const accounts = ref<SubAccountManagementView[]>([]);
const groups = ref<SubGroupView[]>([]);
const proxies = ref<SubProxyView[]>([]);
const defaultProxyId = ref<string | null>(null);
const pendingDefaultProxyId = ref<string | null>(null);
const cpaDefaultProxyId = ref<string | null>(null);
const pendingCpaDefaultProxyId = ref<string | null>(null);
const cpaProxyMode = ref<CpaProxyMode>("unavailable");
const operations = ref<UpstreamOperationView[]>([]);
const modal = ref<
  "account-oauth" | "account-import" | "account-edit" | "group" | "proxy" | null
>(null);
const apiFetch = $fetch as unknown as (
  url: string,
  options?: Record<string, unknown>,
) => Promise<unknown>;
const editingAccount = ref<SubAccountManagementView | null>(null);
const editingGroup = ref<SubGroupView | null>(null);
const editingProxy = ref<SubProxyView | null>(null);
const credentialFileName = ref("");
const showCredentialPaste = ref(false);
const importRows = ref<ImportAccountRow[]>([]);
const importProxyCount = ref(0);
const importProxyNote = ref("");
const accountForm = reactive({
  name: "",
  notes: "",
  platform: "openai",
  type: "oauth",
  credentials: "",
  concurrency: 1,
  priority: 0,
  rateMultiplier: 1,
  groupIds: [] as string[],
  proxyId: null as string | null,
  status: "active",
  schedulable: true,
  advancedRaw: false,
});
const oauthForm = reactive({
  name: "",
  concurrency: 10,
  priority: 0,
  groupIds: [] as string[],
  proxyId: null as string | null,
  schedulable: true,
  authorizationUrl: "",
  flowId: "",
  callbackUrl: "",
  expiresAt: null as number | null,
});
const proxyForm = reactive({
  name: "",
  protocol: "http",
  host: "",
  port: 8080,
  username: "",
  password: "",
  status: "active",
  expiresAt: "",
  fallbackMode: "direct",
  backupProxyId: null as string | null,
  expiryWarnDays: 7,
});
const groupForm = reactive({
  name: "",
  description: "",
  platform: "openai",
  status: "active",
  subscriptionType: "standard",
  rateMultiplier: 1,
  dailyLimit: null as number | null,
  weeklyLimit: null as number | null,
  monthlyLimit: null as number | null,
  rpmLimit: 0,
  isExclusive: false,
  allowImage: false,
  allowBatchImage: false,
  imageRateIndependent: false,
  imageRateMultiplier: 1,
  videoRateIndependent: false,
  videoRateMultiplier: 1,
  fallbackGroupId: null as string | null,
  invalidFallbackGroupId: null as string | null,
  claudeCodeOnly: false,
  allowMessagesDispatch: false,
  requireOAuthOnly: false,
  requirePrivacySet: false,
  maxReasoningEffort: "",
  allowLive: false,
  peakRateEnabled: false,
  peakStart: "08:00",
  peakEnd: "20:00",
  peakRateMultiplier: 1,
  batchImageDiscountMultiplier: 1,
  batchImageHoldMultiplier: 1,
  imagePrice1K: 0,
  imagePrice2K: 0,
  imagePrice4K: 0,
  videoPrice480P: 0,
  videoPrice720P: 0,
  videoPrice1080P: 0,
  webSearchPricePerCall: 0,
  defaultMappedModel: "",
  supportedModelScopes: "",
  reasoningEffortMappings: "[]",
});

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "groups", label: "Sub2API 分组" },
  { id: "proxies", label: "代理池" },
  { id: "operations", label: "操作记录" },
];
const filteredAccounts = computed(() =>
  filter(
    accounts.value,
    (item) => `${item.name} ${item.platform} ${item.groupNames.join(" ")}`,
  ),
);
const filteredGroups = computed(() =>
  filter(
    groups.value,
    (item) => `${item.name} ${item.platform} ${item.description || ""}`,
  ),
);
const filteredProxies = computed(() =>
  filter(
    proxies.value,
    (item) => `${item.name} ${item.protocol} ${item.host} ${item.port}`,
  ),
);
const filteredOperations = computed(() =>
  operations.value.filter(
    (item) =>
      (!operationConnection.value ||
        item.connectionId === operationConnection.value) &&
      (!operationStatus.value || item.status === operationStatus.value),
  ),
);

function filter<T>(items: T[], value: (item: T) => string) {
  const query = search.value.trim().toLowerCase();
  return query
    ? items.filter((item) => value(item).toLowerCase().includes(query))
    : items;
}
function failure(value: unknown, fallback: string) {
  const item = value as { data?: { message?: string }; message?: string };
  return item.data?.message || item.message || fallback;
}
function time(value: number | null) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(value)
    : "—";
}
function operationLabel(status: UpstreamOperationView["status"]) {
  return {
    pending: "处理中",
    succeeded: "成功",
    failed: "失败",
    reconciliation_required: "待对账",
  }[status];
}

async function load(target: Tab = tab.value, force = false) {
  if (loaded[target] && !force) return;
  loading.value = true;
  error.value = "";
  try {
    if (target === "accounts") {
      const [accountData, groupData, proxyData] = await Promise.all([
        $fetch<{ accounts: SubAccountManagementView[] }>(
          "/api/admin/upstreams/sub/accounts",
        ),
        $fetch<{ groups: SubGroupView[] }>("/api/admin/upstreams/sub/groups"),
        $fetch<ProxyPoolState>("/api/admin/upstreams/sub/proxies"),
      ]);
      accounts.value = accountData.accounts;
      groups.value = groupData.groups;
      proxies.value = proxyData.proxies;
      defaultProxyId.value = proxyData.defaultProxyId;
      pendingDefaultProxyId.value = proxyData.defaultProxyId;
      cpaDefaultProxyId.value = proxyData.cpaDefaultProxyId;
      pendingCpaDefaultProxyId.value = proxyData.cpaDefaultProxyId;
      cpaProxyMode.value = proxyData.cpaProxyMode;
      loaded.groups = true;
      loaded.proxies = true;
    }
    if (target === "groups")
      groups.value = (
        await $fetch<{ groups: SubGroupView[] }>(
          "/api/admin/upstreams/sub/groups",
        )
      ).groups;
    if (target === "proxies") {
      const proxyData = await $fetch<ProxyPoolState>("/api/admin/upstreams/sub/proxies");
      proxies.value = proxyData.proxies;
      defaultProxyId.value = proxyData.defaultProxyId;
      pendingDefaultProxyId.value = proxyData.defaultProxyId;
      cpaDefaultProxyId.value = proxyData.cpaDefaultProxyId;
      pendingCpaDefaultProxyId.value = proxyData.cpaDefaultProxyId;
      cpaProxyMode.value = proxyData.cpaProxyMode;
    }
    if (target === "operations")
      operations.value = (
        await $fetch<{ operations: UpstreamOperationView[] }>(
          "/api/admin/upstreams/operations",
        )
      ).operations;
    loaded[target] = true;
  } catch (value) {
    showToast(failure(value, "读取上游账号管理数据失败"), "error");
  } finally {
    loading.value = false;
  }
}
async function switchTab(value: Tab) {
  tab.value = value;
  search.value = "";
  await load(value);
}
async function refresh() {
  loaded[tab.value] = false;
  await load(tab.value, true);
}
async function mutate(
  action: () => Promise<unknown>,
  message: string,
  tabsToRefresh: Tab[],
) {
  saving.value = true;
  error.value = "";
  try {
    const result = await action();
    showToast(message, "success");
    modal.value = null;
    tabsToRefresh.forEach((item) => {
      loaded[item] = false;
    });
    await load(tab.value, true);
    return result;
  } catch (value) {
    showToast(failure(value, "操作失败"), "error");
    return null;
  } finally {
    saving.value = false;
  }
}

function resetAccount() {
  Object.assign(accountForm, {
    name: "",
    notes: "",
    platform: "openai",
    type: "oauth",
    credentials: "",
    concurrency: 1,
    priority: 0,
    rateMultiplier: 1,
    groupIds: [],
    proxyId: defaultProxyId.value,
    status: "active",
    schedulable: true,
    advancedRaw: false,
  });
}
function openAccountImport() {
  editingAccount.value = null;
  resetAccount();
  credentialFileName.value = "";
  showCredentialPaste.value = false;
  importRows.value = [];
  importProxyCount.value = 0;
  importProxyNote.value = "";
  error.value = "";
  modal.value = "account-import";
}
function openAccountOAuth() {
  Object.assign(oauthForm, {
    name: "",
    concurrency: 10,
    priority: 0,
    groupIds: defaultCodexGroups(),
    proxyId: defaultProxyId.value,
    schedulable: true,
    authorizationUrl: "",
    flowId: "",
    callbackUrl: "",
    expiresAt: null,
  });
  error.value = "";
  modal.value = "account-oauth";
}
async function startAccountOAuth() {
  saving.value = true;
  error.value = "";
  try {
    const result = await $fetch<{
      authorizationUrl: string;
      flowId: string;
      expiresAt: number;
    }>("/api/admin/upstreams/sub/accounts/oauth/start", {
      method: "POST",
      body: { proxyId: oauthForm.proxyId },
    });
    oauthForm.authorizationUrl = result.authorizationUrl;
    oauthForm.flowId = result.flowId;
    oauthForm.expiresAt = result.expiresAt;
  } catch (value) {
    error.value = failure(value, "生成 OpenAI 授权链接失败");
    showToast(error.value, "error");
  } finally {
    saving.value = false;
  }
}
async function copyOAuthUrl() {
  if (!oauthForm.authorizationUrl) return;
  try {
    await navigator.clipboard.writeText(oauthForm.authorizationUrl);
    showToast("授权链接已复制", "success");
  } catch {
    showToast("无法访问剪贴板，请手动选择授权链接", "error");
  }
}
function openOAuthUrl() {
  if (!oauthForm.authorizationUrl) return;
  window.open(oauthForm.authorizationUrl, "_blank", "noopener,noreferrer");
}
function restartAccountOAuth() {
  oauthForm.authorizationUrl = "";
  oauthForm.flowId = "";
  oauthForm.callbackUrl = "";
  oauthForm.expiresAt = null;
  error.value = "";
}
async function completeAccountOAuth() {
  if (!oauthForm.flowId || !oauthForm.callbackUrl.trim()) {
    error.value = "请粘贴 localhost 开头的完整回调 URL";
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    await $fetch("/api/admin/upstreams/sub/accounts/oauth/complete", {
      method: "POST",
      body: {
        flowId: oauthForm.flowId,
        callbackUrl: oauthForm.callbackUrl,
        name: oauthForm.name,
        concurrency: oauthForm.concurrency,
        priority: oauthForm.priority,
        groupIds: oauthForm.groupIds,
        schedulable: oauthForm.schedulable,
      },
    });
    showToast(
      oauthForm.schedulable
        ? "OpenAI 账号已授权并加入调度"
        : "OpenAI 账号已授权并保持不可调度",
      "success",
    );
    modal.value = null;
    loaded.accounts = false;
    loaded.groups = false;
    loaded.operations = false;
    await load("accounts", true);
  } catch (value) {
    error.value = failure(value, "完成 OpenAI 授权失败");
    showToast(error.value, "error");
  } finally {
    saving.value = false;
  }
}
function editAccount(item: SubAccountManagementView) {
  editingAccount.value = item;
  Object.assign(accountForm, {
    name: item.name,
    notes: item.notes || "",
    platform: item.platform,
    type: item.type,
    credentials: "",
    concurrency: item.concurrency,
    priority: item.priority,
    rateMultiplier: item.rateMultiplier,
    groupIds: [...item.groupIds],
    proxyId: item.proxyId,
    status: item.status,
    schedulable: item.schedulable,
  });
  error.value = "";
  modal.value = "account-edit";
}
async function credentialFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) {
    credentialFileName.value = file.name;
    parseImportText(await file.text());
    showCredentialPaste.value = false;
  }
}
function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function defaultCodexGroups() {
  const exact = groups.value.find(
    (item) =>
      item.status === "active" && item.name.trim().toLowerCase() === "codex",
  );
  const partial = groups.value.find(
    (item) =>
      item.status === "active" && item.name.toLowerCase().includes("codex"),
  );
  return exact || partial ? [(exact || partial)!.id] : [];
}
function jwtClaims(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  const payload = value.split(".")[1];
  if (!payload) return {};
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    return objectValue(JSON.parse(atob(normalized))) || {};
  } catch {
    return {};
  }
}
function credentialIdentity(credentials: Record<string, unknown>) {
  const idClaims = jwtClaims(credentials.id_token);
  const accessClaims = jwtClaims(credentials.access_token);
  const profile =
    objectValue(accessClaims["https://api.openai.com/profile"]) || {};
  return {
    email:
      String(
        credentials.email || idClaims.email || profile.email || "",
      ).trim() || null,
    name:
      String(credentials.name || idClaims.name || profile.name || "").trim() ||
      null,
  };
}
function parseImportText(text: string) {
  error.value = "";
  accountForm.credentials = text;
  let root: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    const record =
      objectValue(parsed) ||
      (Array.isArray(parsed) ? { accounts: parsed } : null);
    if (!record) throw new Error("top level is not an object");
    root = record;
  } catch {
    importRows.value = [];
    error.value = "文件不是有效的 JSON 对象";
    return;
  }
  const proxies = Array.isArray(root.proxies) ? root.proxies : [];
  importProxyCount.value = proxies.length;
  const sourceAccounts = Array.isArray(root.accounts)
    ? root.accounts
    : root.credentials && objectValue(root.credentials)
      ? [root]
      : [{ credentials: root }];
  const defaultGroups = defaultCodexGroups();
  let matchedProxyAccounts = 0;
  importRows.value = sourceAccounts.map((value, index) => {
    const account = objectValue(value) || {};
    const credentials =
      objectValue(account.credentials) ||
      (index === 0 && sourceAccounts.length === 1 ? root : {});
    const extra = objectValue(account.extra) || {};
    const identity = credentialIdentity(credentials);
    const email =
      String(account.email || extra.email || identity.email || "").trim() ||
      null;
    const name = String(
      account.name ||
        extra.name ||
        identity.name ||
        email ||
        `导入账号 ${index + 1}`,
    ).trim();
    const inferredType =
      credentials.refresh_token || credentials.access_token
        ? "oauth"
        : "apikey";
    const sourceProxy = proxies.map(objectValue).filter(Boolean).find(proxy =>
      String(proxy?.id ?? '') === String(account.proxy_id ?? account.proxyId ?? '')
    );
    const matchedProxy = sourceProxy
      ? proxiesForImport().find(proxy =>
          (String(proxy.protocol).toLowerCase() === String(sourceProxy.protocol || '').toLowerCase() &&
            proxy.host === String(sourceProxy.host || '') &&
            proxy.port === Number(sourceProxy.port)) ||
          (proxy.name === String(sourceProxy.name || '') && Boolean(sourceProxy.name))
        )
      : null;
    if (matchedProxy) matchedProxyAccounts++;
    return {
      key: `${index}:${name}`,
      name,
      email,
      platform: String(account.platform || "openai"),
      type: String(account.type || inferredType),
      credentials,
      extra,
      concurrency:
        Number(account.concurrency) > 0 ? Number(account.concurrency) : 10,
      priority: Number(account.priority) >= 0 ? Number(account.priority) : 0,
      rateMultiplier:
        Number(account.rate_multiplier) >= 0
          ? Number(account.rate_multiplier)
          : 1,
      groupIds: [...defaultGroups],
      proxyId: matchedProxy?.id || defaultProxyId.value,
    };
  });
  if (!importRows.value.length) error.value = "JSON 中没有可导入的账号";
  importProxyNote.value = importProxyCount.value
    ? `导出包包含 ${importProxyCount.value} 个代理定义，已将 ${matchedProxyAccounts} 个账号关联到现有代理；其余账号使用默认代理。`
    : "";
}
function proxiesForImport() { return proxies.value.filter(item => item.status === 'active' && (!item.expiresAt || item.expiresAt > Date.now())); }
function parsePastedCredentials() {
  credentialFileName.value = "粘贴的 JSON 内容";
  parseImportText(accountForm.credentials);
}
async function importAccount() {
  if (!importRows.value.length) parseImportText(accountForm.credentials);
  if (!importRows.value.length) return;
  const result = (await mutate(
    () =>
      apiFetch("/api/admin/upstreams/sub/accounts/import", {
        method: "POST",
        body: {
          accounts: importRows.value,
          schedulable: accountForm.schedulable,
          advancedRaw: accountForm.advancedRaw,
        },
      }),
    accountForm.schedulable
      ? "账号已导入并启用调度"
      : "账号已导入并保持不可调度",
    ["accounts", "groups", "operations"],
  )) as { mode?: string; created?: unknown[]; failed?: unknown[] } | null;
  if (result?.mode === "accounts") {
    showToast(`批量导入完成：成功 ${result.created?.length || 0}，失败 ${result.failed?.length || 0}`, result.failed?.length ? "info" : "success");
  }
}
async function saveAccount() {
  const item = editingAccount.value;
  if (!item) return;
  const body = {
    name: accountForm.name,
    notes: accountForm.notes,
    concurrency: accountForm.concurrency,
    priority: accountForm.priority,
    rateMultiplier: accountForm.rateMultiplier,
    groupIds: accountForm.groupIds,
    proxyId: accountForm.proxyId,
    status: accountForm.status,
    schedulable: accountForm.schedulable,
  };
  await mutate(
    () =>
      apiFetch(`/api/admin/upstreams/sub/accounts/${item.id}`, {
        method: "PATCH",
        body,
      }),
    "账号配置已更新",
    ["accounts", "groups", "operations"],
  );
}

function proxyDateInput(value: number | null) {
  if (!value) return "";
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}
function resetProxy() {
  Object.assign(proxyForm, { name: "", protocol: "http", host: "", port: 8080, username: "", password: "", status: "active", expiresAt: "", fallbackMode: "direct", backupProxyId: null, expiryWarnDays: 7 });
}
function openProxy(item: SubProxyView | null = null) {
  editingProxy.value = item;
  resetProxy();
  if (item) Object.assign(proxyForm, {
    name: item.name, protocol: item.protocol, host: item.host, port: item.port,
    username: item.username || "", status: item.status, expiresAt: proxyDateInput(item.expiresAt),
    fallbackMode: item.fallbackMode, backupProxyId: item.backupProxyId, expiryWarnDays: item.expiryWarnDays,
  });
  error.value = "";
  modal.value = "proxy";
}
async function saveProxy() {
  const item = editingProxy.value;
  const body = { ...proxyForm, expiresAt: proxyForm.expiresAt ? new Date(proxyForm.expiresAt).getTime() : null };
  if (item && !body.password) delete (body as Partial<typeof body>).password;
  await mutate(
    () => item
      ? apiFetch(`/api/admin/upstreams/sub/proxies/${item.id}`, { method: "PATCH", body })
      : apiFetch("/api/admin/upstreams/sub/proxies", { method: "POST", body }),
    item ? "代理配置已更新" : "代理已创建",
    ["proxies", "accounts", "operations"],
  );
}
async function saveDefaultProxy(target: "sub2api" | "cpa") {
  saving.value = true;
  try {
    if (target === "sub2api") {
      await apiFetch("/api/admin/upstreams/sub/proxies/default", { method: "PATCH", body: { proxyId: pendingDefaultProxyId.value } });
      defaultProxyId.value = pendingDefaultProxyId.value;
      showToast(defaultProxyId.value ? "Sub2API 新账号默认代理已更新" : "已取消 Sub2API 新账号默认代理", "success");
    } else {
      const result = await apiFetch("/api/admin/upstreams/cpa/proxy/default", {
        method: "PATCH", body: { proxyId: pendingCpaDefaultProxyId.value }
      }) as { cpaDefaultProxyId: string | null; cpaProxyMode: CpaProxyMode };
      cpaDefaultProxyId.value = result.cpaDefaultProxyId;
      pendingCpaDefaultProxyId.value = result.cpaDefaultProxyId;
      cpaProxyMode.value = result.cpaProxyMode;
      showToast(cpaDefaultProxyId.value ? "CPA 全局默认代理已更新" : "CPA 已恢复直连", "success");
    }
  } catch (value) { showToast(failure(value, "保存默认代理失败"), "error"); }
  finally { saving.value = false; }
}
async function checkProxy(item: SubProxyView, quality = false) {
  const result = await mutate(
    () => apiFetch(`/api/admin/upstreams/sub/proxies/${item.id}/${quality ? "quality-check" : "test"}`, { method: "POST" }),
    quality ? "代理质量检测完成" : "代理连通性检测完成",
    ["proxies", "operations"],
  ) as { message?: string } | null;
  if (result?.message) showToast(result.message, "info");
}
async function toggleProxy(item: SubProxyView) {
  await mutate(
    () => apiFetch(`/api/admin/upstreams/sub/proxies/${item.id}`, { method: "PATCH", body: { status: item.status === "active" ? "inactive" : "active" } }),
    item.status === "active" ? "代理已停用" : "代理已启用",
    ["proxies", "accounts", "operations"],
  );
}
async function deleteProxy(item: SubProxyView) {
  if (!confirm(`永久删除代理 ${item.name}？存在账号、备用策略、Sub2API 或 CPA 默认设置引用时系统会拒绝。`)) return;
  await mutate(
    () => apiFetch(`/api/admin/upstreams/sub/proxies/${item.id}`, { method: "DELETE", headers: { "idempotency-key": clientRandomUUID() } }),
    "代理已删除",
    ["proxies", "accounts", "operations"],
  );
}
async function verifyAccount(item: SubAccountManagementView, activate = false) {
  if (activate && !confirm(`验证 ${item.name} 并在通过后加入调度池？`)) return;
  const result = await mutate(
    () =>
      apiFetch(`/api/admin/upstreams/sub/accounts/${item.id}/verify`, {
        method: "POST",
        body: { activate },
      }),
    activate ? "账号验证通过并已启用调度" : "账号验证通过",
    ["accounts", "operations"],
  );
  if (!result) {
    loaded.accounts = false;
    await load("accounts", true);
  }
}
async function deleteAccount(item: SubAccountManagementView) {
  if (!confirm(`永久删除账号 ${item.name}？只有当前并发为 0 时才会执行。`))
    return;
  await mutate(
    () =>
      apiFetch(`/api/admin/upstreams/sub/accounts/${item.id}`, {
        method: "DELETE",
        headers: { "idempotency-key": clientRandomUUID() },
      }),
    "账号已永久删除",
    ["accounts", "groups", "operations"],
  );
}

function resetGroup() {
  Object.assign(groupForm, {
    name: "",
    description: "",
    platform: "openai",
    status: "active",
    subscriptionType: "standard",
    rateMultiplier: 1,
    dailyLimit: null,
    weeklyLimit: null,
    monthlyLimit: null,
    rpmLimit: 0,
    isExclusive: false,
    allowImage: false,
    allowBatchImage: false,
    imageRateIndependent: false,
    imageRateMultiplier: 1,
    videoRateIndependent: false,
    videoRateMultiplier: 1,
    fallbackGroupId: null,
    invalidFallbackGroupId: null,
    claudeCodeOnly: false,
    allowMessagesDispatch: false,
    requireOAuthOnly: false,
    requirePrivacySet: false,
    maxReasoningEffort: "",
    allowLive: false,
    peakRateEnabled: false,
    peakStart: "08:00",
    peakEnd: "20:00",
    peakRateMultiplier: 1,
    batchImageDiscountMultiplier: 1,
    batchImageHoldMultiplier: 1,
    imagePrice1K: 0,
    imagePrice2K: 0,
    imagePrice4K: 0,
    videoPrice480P: 0,
    videoPrice720P: 0,
    videoPrice1080P: 0,
    webSearchPricePerCall: 0,
    defaultMappedModel: "",
    supportedModelScopes: "",
    reasoningEffortMappings: "[]",
  });
}
function openGroup(item: SubGroupView | null = null) {
  editingGroup.value = item;
  resetGroup();
  if (item)
    Object.assign(groupForm, {
      name: item.name,
      description: item.description || "",
      platform: item.platform,
      status: item.status,
      subscriptionType: item.subscriptionType || "standard",
      rateMultiplier: item.rateMultiplier,
      dailyLimit: item.dailyLimit,
      weeklyLimit: item.weeklyLimit,
      monthlyLimit: item.monthlyLimit,
      rpmLimit: item.rpmLimit || 0,
      allowImage: item.allowImage,
      fallbackGroupId: item.fallbackGroupId,
      invalidFallbackGroupId: item.invalidFallbackGroupId,
      ...Object.fromEntries(
        Object.entries(item.policy).map(([key, value]) => [
          key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()),
          value,
        ]),
      ),
    });
  groupForm.supportedModelScopes = Array.isArray(
    item?.policy.supported_model_scopes,
  )
    ? item.policy.supported_model_scopes.join(", ")
    : "";
  groupForm.reasoningEffortMappings = JSON.stringify(
    item?.policy.reasoning_effort_mappings || [],
    null,
    2,
  );
  error.value = "";
  modal.value = "group";
}
async function saveGroup() {
  const item = editingGroup.value;
  let reasoningEffortMappings: unknown;
  try {
    reasoningEffortMappings = JSON.parse(
      groupForm.reasoningEffortMappings || "[]",
    );
  } catch {
    error.value = "推理强度映射不是有效 JSON";
    return;
  }
  const body = {
    ...groupForm,
    supportedModelScopes: groupForm.supportedModelScopes
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    reasoningEffortMappings,
  };
  await mutate(
    () =>
      item
        ? apiFetch(`/api/admin/upstreams/sub/groups/${item.id}`, {
            method: "PATCH",
            body,
          })
        : apiFetch("/api/admin/upstreams/sub/groups", { method: "POST", body }),
    item ? "分组策略已更新" : "分组已创建",
    ["groups", "accounts", "operations"],
  );
}
async function deleteGroup(item: SubGroupView) {
  if (!confirm(`删除分组 ${item.name}？存在账号或 fallback 引用时系统会拒绝。`))
    return;
  await mutate(
    () =>
      apiFetch(`/api/admin/upstreams/sub/groups/${item.id}`, {
        method: "DELETE",
        headers: { "idempotency-key": clientRandomUUID() },
      }),
    "分组已删除",
    ["groups", "accounts", "operations"],
  );
}

onMounted(async () => {
  try {
    upstreams.value = (
      await $fetch<{ upstreams: UpstreamConnectionView[] }>(
        "/api/admin/upstreams",
      )
    ).upstreams;
  } catch {}
  await load("groups");
});
</script>

<template>
  <div class="admin-page upstream-page">
    <header class="admin-page__header">
      <div>
        <span class="admin-kicker">ACCOUNT CONTROL</span>
        <h1 class="text-balance">号池配置</h1>
        <p class="text-pretty">维护 Sub2API 分组、共享代理池和操作记录；CPA 与 Sub2API 认证账号统一在账号管理中处理。</p>
      </div>
      <div class="upstream-connections">
        <span
          v-for="item in upstreams"
          :key="item.id"
          :data-ready="item.configured"
          ><i />{{ item.name }}</span
        >
      </div>
    </header>

    <div class="admin-page-tabs upstream-page-tabs" role="tablist" aria-label="号池配置类型">
      <button
        v-for="item in tabs"
        :key="item.id"
        type="button"
        role="tab"
        :aria-selected="tab === item.id"
        :class="{ active: tab === item.id }"
        @click="switchTab(item.id)"
      >
        {{ item.label }}
      </button>
    </div>

    <div class="upstream-toolbar">
      <label v-if="tab !== 'operations'" class="admin-search"
        ><IconSearch :size="15" /><input
          v-model="search"
          type="search"
          placeholder="搜索当前列表"
      /></label>
      <template v-else>
        <AppSelect v-model="operationConnection" aria-label="筛选上游">
          <option value="">全部上游</option>
          <option value="cpa">CPA</option>
          <option value="sub2api">Sub2API</option>
        </AppSelect>
        <AppSelect v-model="operationStatus" aria-label="筛选操作状态">
          <option value="">全部状态</option>
          <option value="succeeded">成功</option>
          <option value="failed">失败</option>
          <option value="reconciliation_required">待对账</option>
          <option value="pending">处理中</option>
        </AppSelect>
      </template>
      <button
        class="icon-button"
        title="刷新"
        aria-label="刷新当前配置"
        :disabled="loading"
        @click="refresh"
      >
        <IconRefresh :class="{ 'is-spinning': loading }" :size="17" />
      </button>
      <button
        v-if="tab === 'accounts'"
        class="button button--secondary button--small"
        @click="openAccountOAuth"
      >
        <IconLogin2 :size="16" />Auth 登录
      </button>
      <button
        v-if="tab === 'accounts'"
        class="button button--primary button--small"
        @click="openAccountImport"
      >
        <IconPlus :size="16" />导入账号
      </button>
      <button
        v-if="tab === 'groups'"
        class="button button--primary button--small"
        @click="openGroup()"
      >
        <IconPlus :size="16" />新建分组
      </button>
      <button
        v-if="tab === 'proxies'"
        class="button button--primary button--small"
        @click="openProxy()"
      >
        <IconPlus :size="16" />新建代理
      </button>
    </div>
    <section v-if="tab === 'proxies'" class="proxy-default-settings" aria-label="号池默认代理">
      <div class="proxy-default-row">
        <div><IconServerCog :size="18" /><span><strong>Sub2API 新账号默认代理</strong><small>导入或 Auth 新增账号时自动预选，单个账号仍可覆盖。</small></span></div>
        <div><AppSelect v-model="pendingDefaultProxyId" aria-label="Sub2API 新账号默认代理"><option :value="null">不使用默认代理</option><option v-for="item in proxiesForImport()" :key="item.id" :value="item.id">{{ item.name }} · {{ item.protocol }}://{{ item.host }}:{{ item.port }}</option></AppSelect><button class="button button--secondary button--small" :disabled="saving || pendingDefaultProxyId === defaultProxyId" @click="saveDefaultProxy('sub2api')">保存</button></div>
      </div>
      <div class="proxy-default-row">
        <div><IconServerCog :size="18" /><span><strong>CPA 全局默认代理</strong><small>CPA 中所有未单独指定代理的认证文件统一使用该代理。</small></span></div>
        <div><AppSelect v-model="pendingCpaDefaultProxyId" aria-label="CPA 全局默认代理" :disabled="cpaProxyMode === 'unavailable'"><option :value="null">CPA 直连</option><option v-for="item in proxiesForImport()" :key="item.id" :value="item.id">{{ item.name }} · {{ item.protocol }}://{{ item.host }}:{{ item.port }}</option></AppSelect><button class="button button--secondary button--small" :disabled="saving || cpaProxyMode === 'unavailable' || (pendingCpaDefaultProxyId === cpaDefaultProxyId && cpaProxyMode !== 'custom' && cpaProxyMode !== 'error')" @click="saveDefaultProxy('cpa')">保存</button></div>
        <small v-if="cpaProxyMode === 'custom'" class="proxy-default-warning">CPA 当前使用代理池之外的自定义代理，保存后将由所选代理覆盖。</small>
        <small v-else-if="cpaProxyMode === 'error'" class="proxy-default-warning">暂时无法读取 CPA 全局代理，请确认 CPA 管理连接。</small>
        <small v-else-if="cpaProxyMode === 'unavailable'" class="proxy-default-warning">CPA 管理连接尚未配置。</small>
      </div>
    </section>

    <div v-if="tab === 'accounts'" class="admin-table-wrap">
      <table class="admin-table upstream-table">
        <thead>
          <tr>
            <th>账号</th>
            <th>平台 / 类型</th>
            <th>分组</th>
            <th>号池归属</th>
            <th>代理</th>
            <th>调度</th>
            <th>并发 / 优先级</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in filteredAccounts" :key="item.id">
            <td>
              <strong>{{ item.name }}</strong
              ><code>{{ item.notes || item.errorMessage || "无备注" }}</code>
            </td>
            <td>
              {{ item.platform }}<code>{{ item.type }}</code>
            </td>
            <td>{{ item.groupNames.join("、") || "未分组" }}</td>
            <td><span v-if="item.isPersonalPool" class="status-dot" data-status="active"><i />{{ item.personalPoolOwnerUserId === authSession?.user?.id ? '我的号池' : '用户号池' }}<code>{{ item.personalPoolOwnerName || '未知用户' }}</code></span><code v-else>公共号池</code></td>
            <td><strong>{{ item.proxyName || "直连" }}</strong><code v-if="!item.proxyEditable">继承主账号</code><code v-else-if="item.proxyFallbackOriginId">已触发回退</code></td>
            <td>
              <span
                class="status-dot"
                :data-status="item.schedulable ? item.status : 'disabled'"
                ><i />{{ item.schedulable ? item.status : "不可调度" }}</span
              >
            </td>
            <td>
              <strong
                >{{ item.currentConcurrency }} / {{ item.concurrency }}</strong
              ><code>P{{ item.priority }} · {{ item.rateMultiplier }}×</code>
            </td>
            <td>
              <div class="table-actions">
                <button
                  class="icon-button"
                  title="仅验证"
                  aria-label="仅验证账号"
                  @click="verifyAccount(item)"
                >
                  <IconCircleCheck :size="16" /></button
                ><button
                  v-if="!item.schedulable"
                  class="icon-button"
                  title="验证并启用"
                  aria-label="验证并启用账号"
                  @click="verifyAccount(item, true)"
                >
                  <IconPlayerPlay :size="16" /></button
                ><button
                  class="icon-button"
                  title="编辑"
                  aria-label="编辑账号"
                  @click="editAccount(item)"
                >
                  <IconEdit :size="16" /></button
                ><button
                  class="icon-button danger"
                  title="永久删除"
                  aria-label="永久删除账号"
                  @click="deleteAccount(item)"
                >
                  <IconTrash :size="16" />
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="!filteredAccounts.length">
            <td colspan="8">
              <div class="admin-empty">
                {{ loading ? "正在读取账号…" : "没有账号" }}
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="tab === 'groups'" class="admin-table-wrap">
      <table class="admin-table upstream-table">
        <thead>
          <tr>
            <th>分组</th>
            <th>平台 / 类型</th>
            <th>倍率 / 限额</th>
            <th>能力</th>
            <th>引用</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in filteredGroups" :key="item.id">
            <td>
              <strong>{{ item.name }}</strong
              ><code>{{ item.description || "无描述" }}</code>
            </td>
            <td>
              {{ item.platform
              }}<code
                >{{ item.subscriptionType || "standard" }} ·
                {{ item.status }}</code
              >
            </td>
            <td>
              <strong>{{ item.rateMultiplier }}×</strong
              ><code
                >日 {{ item.dailyLimit ?? "∞" }} · 周
                {{ item.weeklyLimit ?? "∞" }} · 月
                {{ item.monthlyLimit ?? "∞" }}</code
              >
            </td>
            <td>
              {{
                [item.allowImage ? "图片" : "", item.allowVideo ? "视频" : ""]
                  .filter(Boolean)
                  .join(" / ") || "文本"
              }}<code>RPM {{ item.rpmLimit || "不限" }}</code>
            </td>
            <td>
              {{ item.accountCount }} 个账号<code>{{
                item.fallbackGroupName
                  ? `fallback → ${item.fallbackGroupName}`
                  : "无 fallback"
              }}</code>
            </td>
            <td>
              <div class="table-actions">
                <button
                  class="icon-button"
                  title="编辑策略"
                  aria-label="编辑分组策略"
                  @click="openGroup(item)"
                >
                  <IconEdit :size="16" /></button
                ><button
                  class="icon-button danger"
                  title="删除"
                  aria-label="删除分组"
                  @click="deleteGroup(item)"
                >
                  <IconTrash :size="16" />
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="!filteredGroups.length">
            <td colspan="6">
              <div class="admin-empty">
                {{ loading ? "正在读取分组…" : "没有分组" }}
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="tab === 'proxies'" class="admin-table-wrap">
      <table class="admin-table upstream-table proxy-table">
        <thead><tr><th>名称 / 地址</th><th>协议 / 状态</th><th>绑定账号</th><th>延迟 / 质量</th><th>到期 / 回退</th><th></th></tr></thead>
        <tbody>
          <tr v-for="item in filteredProxies" :key="item.id">
            <td><strong>{{ item.name }}</strong><code>{{ item.host }}:{{ item.port }}</code></td>
            <td><span class="status-dot" :data-status="item.status"><i />{{ item.status === 'active' ? '运行中' : '已停用' }}</span><code>{{ item.protocol.toUpperCase() }} · {{ item.username ? '含认证' : '无认证' }}</code></td>
            <td><strong>{{ item.accountCount }} 个 Sub2API 账号</strong><code>{{ [item.id === defaultProxyId ? 'Sub2API 默认' : '', item.id === cpaDefaultProxyId ? 'CPA 全局默认' : ''].filter(Boolean).join(' · ') || '普通代理' }}</code></td>
            <td><strong>{{ item.latencyMs === null ? '—' : `${item.latencyMs} ms` }}</strong><code>质量 {{ item.qualityScore ?? '待检测' }}</code></td>
            <td><strong>{{ item.expiresAt ? time(item.expiresAt) : '长期有效' }}</strong><code>{{ item.backupProxyName ? `回退至 ${item.backupProxyName}` : item.fallbackMode === 'direct' ? '失败后直连' : item.fallbackMode }}</code></td>
            <td><div class="table-actions"><button class="icon-button" title="连通性测试" aria-label="代理连通性测试" @click="checkProxy(item)"><IconActivityHeartbeat :size="16" /></button><button class="icon-button" title="质量检测" aria-label="代理质量检测" @click="checkProxy(item, true)"><IconShieldCheck :size="16" /></button><button class="icon-button" :title="item.status === 'active' ? '停用' : '启用'" :aria-label="item.status === 'active' ? '停用代理' : '启用代理'" @click="toggleProxy(item)"><component :is="item.status === 'active' ? IconPlayerPause : IconPlayerPlay" :size="16" /></button><button class="icon-button" title="编辑" aria-label="编辑代理" @click="openProxy(item)"><IconEdit :size="16" /></button><button class="icon-button danger" title="永久删除" aria-label="永久删除代理" @click="deleteProxy(item)"><IconTrash :size="16" /></button></div></td>
          </tr>
          <tr v-if="!filteredProxies.length"><td colspan="6"><div class="admin-empty">{{ loading ? '正在读取代理…' : '没有代理' }}</div></td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="tab === 'operations'" class="admin-table-wrap">
      <table class="admin-table upstream-table">
        <thead>
          <tr>
            <th>时间 / 请求 ID</th>
            <th>上游</th>
            <th>动作</th>
            <th>目标</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in filteredOperations" :key="item.id">
            <td>
              {{ time(item.startedAt) }}<code>{{ item.requestId }}</code>
            </td>
            <td :title="item.connectionId">{{ upstreamOperationConnectionLabel(item.connectionId) }}</td>
            <td>
              <strong :title="item.action">{{ upstreamOperationActionLabel(item.action) }}</strong>
            </td>
            <td>
              <strong :title="item.targetRef || ''">{{ upstreamOperationTargetLabel(item) }}</strong><code :title="item.targetType">{{ upstreamOperationTargetTypeLabel(item.targetType) }}</code>
            </td>
            <td>
              <span
                class="status-dot"
                :data-status="
                  item.status === 'succeeded'
                    ? 'success'
                    : item.status === 'reconciliation_required'
                      ? 'pending'
                      : item.status
                "
                ><i />{{ operationLabel(item.status) }}</span
              ><code v-if="item.upstreamStatus"
                >HTTP {{ item.upstreamStatus }}</code
              ><small v-if="item.errorMessage" class="operation-error text-pretty" :title="item.errorMessage">{{ item.errorMessage }}</small>
            </td>
          </tr>
          <tr v-if="!filteredOperations.length">
            <td colspan="5">
              <div class="admin-empty">
                {{ loading ? "正在读取操作记录…" : "没有操作记录" }}
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      v-if="modal === 'account-oauth'"
      class="admin-modal-backdrop"
      @click.self="modal = null"
    >
      <section
        class="admin-modal admin-modal--wide oauth-account-modal"
        role="dialog"
        aria-modal="true"
        aria-label="OpenAI Auth 登录"
      >
        <header>
          <div>
            <span>SUB2API OAUTH</span>
            <h2>OpenAI Auth 登录</h2>
          </div>
          <button
            type="button"
            class="icon-button"
            title="关闭"
            aria-label="关闭"
            @click="modal = null"
          >
            <IconX :size="18" />
          </button>
        </header>
        <form
          class="admin-form oauth-account-form"
          @submit.prevent="oauthForm.flowId ? completeAccountOAuth() : startAccountOAuth()"
        >
          <div class="oauth-stepper" aria-label="授权进度">
            <span data-active="true"><i>1</i>账号设置</span>
            <b />
            <span :data-active="Boolean(oauthForm.flowId)"><i>2</i>OpenAI 授权</span>
          </div>

          <template v-if="!oauthForm.flowId">
            <div class="form-grid">
              <label>
                <span>账号名称</span>
                <input
                  v-model="oauthForm.name"
                  maxlength="160"
                  placeholder="留空时使用 OpenAI 账号邮箱"
                >
              </label>
              <label>
                <span>账号代理</span>
                <AppSelect v-model="oauthForm.proxyId">
                  <option :value="null">不使用代理（直连）</option>
                  <option
                    v-for="item in proxiesForImport()"
                    :key="item.id"
                    :value="item.id"
                  >
                    {{ item.name }} · {{ item.protocol }}://{{ item.host }}:{{ item.port }}
                  </option>
                </AppSelect>
              </label>
            </div>
            <div class="form-grid">
              <label>
                <span>并发</span>
                <input
                  v-model.number="oauthForm.concurrency"
                  type="number"
                  min="1"
                  max="10000"
                  required
                >
              </label>
              <label>
                <span>优先级</span>
                <input
                  v-model.number="oauthForm.priority"
                  type="number"
                  min="0"
                  max="1000000"
                  required
                >
              </label>
            </div>
            <fieldset class="group-picker oauth-group-picker">
              <legend>所属分组</legend>
              <label v-for="item in groups" :key="item.id">
                <input
                  v-model="oauthForm.groupIds"
                  type="checkbox"
                  :value="item.id"
                >
                <span>{{ item.name }}<small>{{ item.platform }}</small></span>
              </label>
            </fieldset>
            <label class="switch">
              <input v-model="oauthForm.schedulable" type="checkbox">
              <span />授权后立即调度
            </label>
          </template>

          <template v-else>
            <div class="oauth-account-summary">
              <span><strong>{{ oauthForm.name || "使用 OpenAI 账号邮箱" }}</strong><small>账号</small></span>
              <span><strong>{{ oauthForm.groupIds.length }}</strong><small>分组</small></span>
              <span><strong>{{ oauthForm.concurrency }}</strong><small>并发</small></span>
              <span><strong>{{ oauthForm.schedulable ? "立即" : "关闭" }}</strong><small>调度</small></span>
            </div>
            <section class="oauth-link-section">
              <header>
                <div>
                  <h3>授权链接</h3>
                  <span>{{ oauthForm.expiresAt ? `有效至 ${time(oauthForm.expiresAt)}` : "30 分钟内有效" }}</span>
                </div>
                <div>
                  <button
                    type="button"
                    class="button button--quiet button--small"
                    @click="copyOAuthUrl"
                  >
                    <IconCopy :size="15" />复制
                  </button>
                  <button
                    type="button"
                    class="button button--secondary button--small"
                    @click="openOAuthUrl"
                  >
                    <IconExternalLink :size="15" />打开
                  </button>
                </div>
              </header>
              <input
                :value="oauthForm.authorizationUrl"
                readonly
                aria-label="OpenAI 授权链接"
                @focus="($event.target as HTMLInputElement).select()"
              >
            </section>
            <label class="oauth-callback-field">
              <span>localhost 回调 URL *</span>
              <textarea
                v-model="oauthForm.callbackUrl"
                rows="4"
                required
                spellcheck="false"
                autocomplete="off"
                placeholder="http://localhost:1455/auth/callback?code=...&state=..."
              />
            </label>
          </template>

          <p v-if="error" class="form-error">{{ error }}</p>
          <footer>
            <button
              type="button"
              class="button button--quiet"
              @click="modal = null"
            >
              取消
            </button>
            <button
              v-if="oauthForm.flowId"
              type="button"
              class="button button--secondary"
              :disabled="saving"
              @click="restartAccountOAuth"
            >
              重新生成
            </button>
            <button
              class="button button--primary"
              :disabled="saving || (Boolean(oauthForm.flowId) && !oauthForm.callbackUrl.trim())"
            >
              <IconLogin2 :size="16" />{{
                saving
                  ? oauthForm.flowId ? "正在完成授权" : "正在生成链接"
                  : oauthForm.flowId ? "完成授权" : "生成授权链接"
              }}
            </button>
          </footer>
        </form>
      </section>
    </div>

    <div
      v-if="modal === 'account-import' || modal === 'account-edit'"
      class="admin-modal-backdrop"
      @click.self="modal = null"
    >
      <section class="admin-modal admin-modal--wide">
        <header>
          <div>
            <span>SUB2API ACCOUNT</span>
            <h2>{{ modal === "account-import" ? "导入账号" : "编辑账号" }}</h2>
          </div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="modal = null">
            <IconX :size="18" />
          </button>
        </header>
        <form
          class="admin-form"
          @submit.prevent="
            modal === 'account-import' ? importAccount() : saveAccount()
          "
        >
          <div v-if="modal === 'account-edit'" class="form-grid">
            <label
              ><span>账号名称 *</span
              ><input v-model="accountForm.name" required /></label
            ><label
              ><span>备注</span><input v-model="accountForm.notes"
            /></label>
          </div>
          <div
            v-if="modal === 'account-edit'"
            class="form-grid form-grid--four"
          >
            <label
              ><span>平台</span
              ><AppSelect
                v-model="accountForm.platform"
                :disabled="modal === 'account-edit'"
              >
                <option
                  v-for="value in [
                    'openai',
                    'anthropic',
                    'gemini',
                    'antigravity',
                    'grok',
                    'bedrock',
                  ]"
                  :key="value"
                >
                  {{ value }}
                </option>
              </AppSelect></label
            ><label
              ><span>账号类型</span
              ><AppSelect
                v-model="accountForm.type"
                :disabled="modal === 'account-edit'"
              >
                <option
                  v-for="value in [
                    'oauth',
                    'setup-token',
                    'apikey',
                    'upstream',
                    'bedrock',
                    'service_account',
                  ]"
                  :key="value"
                >
                  {{ value }}
                </option>
              </AppSelect></label
            ><label
              ><span>并发</span
              ><input
                v-model.number="accountForm.concurrency"
                type="number"
                min="1" /></label
            ><label
              ><span>优先级</span
              ><input
                v-model.number="accountForm.priority"
                type="number"
                min="0"
            /></label>
          </div>
          <div v-if="modal === 'account-edit'" class="form-grid">
            <label
              ><span>倍率</span
              ><input
                v-model.number="accountForm.rateMultiplier"
                type="number"
                min="0"
                step="0.01" /></label
            ><label v-if="modal === 'account-edit'"
              ><span>状态</span
              ><AppSelect v-model="accountForm.status">
                <option value="active">active</option>
                <option value="inactive">inactive</option>
                <option value="error">error</option>
              </AppSelect></label
            >
          </div>
          <label v-if="modal === 'account-edit'">
            <span>账号代理</span>
            <AppSelect v-model="accountForm.proxyId" :disabled="!editingAccount?.proxyEditable">
              <option :value="null">不使用代理（直连）</option>
              <option v-for="item in proxiesForImport()" :key="item.id" :value="item.id">{{ item.name }} · {{ item.protocol }}://{{ item.host }}:{{ item.port }}</option>
            </AppSelect>
            <small v-if="!editingAccount?.proxyEditable">影子账号继承主账号代理，不能单独修改</small>
          </label>
          <fieldset v-if="modal === 'account-edit'" class="group-picker">
            <legend>所属分组</legend>
            <label v-for="item in groups" :key="item.id"
              ><input
                v-model="accountForm.groupIds"
                type="checkbox"
                :value="item.id"
              /><span
                >{{ item.name }}<small>{{ item.platform }}</small></span
              ></label
            >
          </fieldset>
          <section v-if="modal === 'account-import'" class="credential-editor">
            <header>
              <div>
                <h3>选择导入文件</h3>
                <span>支持 Sub2API 完整导出包或单账号凭据</span>
              </div>
              <label class="button button--quiet button--small"
                ><IconCloudUpload :size="15" />选择文件<input
                  type="file"
                  accept="application/json,.json"
                  @change="credentialFile"
              /></label>
            </header>
            <div
              class="credential-selection"
              :data-selected="Boolean(credentialFileName)"
            >
              <IconFileCode :size="20" />
              <div>
                <strong>{{ credentialFileName || "尚未选择文件" }}</strong
                ><small>{{
                  importRows.length
                    ? `已解析 ${importRows.length} 个账号`
                    : "原始内容只在本次请求中转发"
                }}</small>
              </div>
            </div>
            <button
              type="button"
              class="button button--quiet button--small credential-paste-toggle"
              @click="showCredentialPaste = !showCredentialPaste"
            >
              {{ showCredentialPaste ? "收起粘贴内容" : "粘贴 JSON 内容" }}
            </button>
            <textarea
              v-if="showCredentialPaste"
              v-model="accountForm.credentials"
              spellcheck="false"
              placeholder="{ }"
            />
            <button
              v-if="showCredentialPaste"
              type="button"
              class="button button--secondary button--small"
              @click="parsePastedCredentials"
            >
              解析粘贴内容
            </button>
            <div v-if="importRows.length" class="import-account-list">
              <p v-if="importProxyNote" class="import-proxy-note">{{ importProxyNote }}</p>
              <article
                v-for="(row, index) in importRows"
                :key="row.key"
                class="import-account-row"
              >
                <header>
                  <span>{{ index + 1 }}</span>
                  <div>
                    <strong>{{ row.name }}</strong
                    ><small
                      >{{ row.email || "未提供邮箱" }} · {{ row.platform }} /
                      {{ row.type }}</small
                    >
                  </div>
                  <code>{{ row.concurrency }} 并发 · P{{ row.priority }}</code>
                </header>
                <label class="import-proxy-select"><span>账号代理</span><AppSelect v-model="row.proxyId"><option :value="null">不使用代理（直连）</option><option v-for="item in proxiesForImport()" :key="item.id" :value="item.id">{{ item.name }} · {{ item.protocol }}://{{ item.host }}:{{ item.port }}</option></AppSelect></label>
                <fieldset class="group-picker import-group-picker">
                  <legend>分组（默认 Codex，可单独修改）</legend>
                  <label v-for="item in groups" :key="item.id"
                    ><input
                      v-model="row.groupIds"
                      type="checkbox"
                      :value="item.id"
                    /><span
                      >{{ item.name }}<small>{{ item.platform }}</small></span
                    ></label
                  >
                </fieldset>
              </article>
            </div>
            <label class="switch"
              ><input
                v-model="accountForm.advancedRaw"
                type="checkbox"
              /><span />高级原始 JSON（跳过平台字段适配）</label
            >
            <label class="switch"
              ><input
                v-model="accountForm.schedulable"
                type="checkbox"
              /><span />导入后立即调度</label
            >
          </section>
          <label v-if="modal === 'account-edit'" class="switch"
            ><input
              v-model="accountForm.schedulable"
              type="checkbox"
            /><span />允许调度</label
          >
          <p v-if="error" class="form-error">{{ error }}</p>
          <footer>
            <button
              type="button"
              class="button button--quiet"
              @click="modal = null"
            >
              取消</button
            ><button
              class="button button--primary"
              :disabled="
                saving ||
                (modal === 'account-import' && !importRows.length)
              "
            >
              {{
                saving
                  ? "保存中"
                  : modal === "account-import"
                    ? accountForm.schedulable
                      ? "导入并启用"
                      : "导入为不可调度"
                    : "保存配置"
              }}
            </button>
          </footer>
        </form>
      </section>
    </div>

    <div
      v-if="modal === 'proxy'"
      class="admin-modal-backdrop"
      @click.self="modal = null"
    >
      <section class="admin-modal admin-modal--wide">
        <header><div><span>SHARED PROXY POOL</span><h2>{{ editingProxy ? '编辑代理' : '新建代理' }}</h2></div><button class="icon-button" title="关闭" aria-label="关闭" @click="modal = null"><IconX :size="18" /></button></header>
        <form class="admin-form" @submit.prevent="saveProxy">
          <div class="form-grid"><label><span>代理名称 *</span><input v-model="proxyForm.name" required placeholder="例如：香港出口 01"></label><label><span>状态</span><AppSelect v-model="proxyForm.status"><option value="active">运行中</option><option value="inactive">已停用</option></AppSelect></label></div>
          <div class="proxy-address-grid"><label><span>协议 *</span><AppSelect v-model="proxyForm.protocol"><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks5">SOCKS5</option><option value="socks5h">SOCKS5H</option></AppSelect></label><label><span>主机 *</span><input v-model="proxyForm.host" required placeholder="proxy.example.com"></label><label><span>端口 *</span><input v-model.number="proxyForm.port" type="number" min="1" max="65535" required></label></div>
          <div class="form-grid"><label><span>用户名</span><input v-model="proxyForm.username" autocomplete="off"></label><label><span>密码{{ editingProxy ? '（留空保持不变）' : '' }}</span><input v-model="proxyForm.password" type="password" autocomplete="new-password"></label></div>
          <section class="form-section"><header><h3>有效期与故障回退</h3><span>到期代理不会再自动分配给新账号</span></header><div class="form-grid form-grid--four"><label><span>到期时间</span><input v-model="proxyForm.expiresAt" type="datetime-local"></label><label><span>预警天数</span><input v-model.number="proxyForm.expiryWarnDays" type="number" min="0" max="365"></label><label><span>失败后行为</span><AppSelect v-model="proxyForm.fallbackMode"><option value="direct">回退直连</option><option value="backup">切换备用代理</option></AppSelect></label><label><span>备用代理</span><AppSelect v-model="proxyForm.backupProxyId" :disabled="proxyForm.fallbackMode !== 'backup'"><option :value="null">无</option><option v-for="item in proxiesForImport().filter(value => value.id !== editingProxy?.id)" :key="item.id" :value="item.id">{{ item.name }}</option></AppSelect></label></div></section>
          <p v-if="error" class="form-error">{{ error }}</p>
          <footer><button type="button" class="button button--quiet" @click="modal = null">取消</button><button class="button button--primary" :disabled="saving">{{ saving ? '保存中' : editingProxy ? '保存代理' : '创建代理' }}</button></footer>
        </form>
      </section>
    </div>

    <div
      v-if="modal === 'group'"
      class="admin-modal-backdrop"
      @click.self="modal = null"
    >
      <section class="admin-modal admin-modal--wide">
        <header>
          <div>
            <span>SUB2API GROUP POLICY</span>
            <h2>{{ editingGroup ? "编辑分组策略" : "新建分组" }}</h2>
          </div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="modal = null">
            <IconX :size="18" />
          </button>
        </header>
        <form class="admin-form" @submit.prevent="saveGroup">
          <div class="form-grid">
            <label
              ><span>分组名称 *</span
              ><input v-model="groupForm.name" required /></label
            ><label
              ><span>描述</span><input v-model="groupForm.description"
            /></label>
          </div>
          <div class="form-grid form-grid--four">
            <label
              ><span>平台</span
              ><AppSelect v-model="groupForm.platform">
                <option
                  v-for="value in [
                    'openai',
                    'anthropic',
                    'gemini',
                    'antigravity',
                    'grok',
                    'composite',
                  ]"
                  :key="value"
                >
                  {{ value }}
                </option>
              </AppSelect></label
            ><label
              ><span>订阅类型</span
              ><AppSelect v-model="groupForm.subscriptionType">
                <option value="standard">standard</option>
                <option value="subscription">subscription</option>
              </AppSelect></label
            ><label
              ><span>状态</span
              ><AppSelect v-model="groupForm.status">
                <option value="active">active</option>
                <option value="inactive">inactive</option>
              </AppSelect></label
            ><label
              ><span>基础倍率</span
              ><input
                v-model.number="groupForm.rateMultiplier"
                type="number"
                min="0"
                step="0.01"
            /></label>
          </div>
          <section class="form-section">
            <header>
              <h3>限额与调度</h3>
              <span>留空表示不限</span>
            </header>
            <div class="form-grid form-grid--four">
              <label
                ><span>每日 USD</span
                ><input
                  v-model.number="groupForm.dailyLimit"
                  type="number"
                  min="0"
                  step="0.01" /></label
              ><label
                ><span>每周 USD</span
                ><input
                  v-model.number="groupForm.weeklyLimit"
                  type="number"
                  min="0"
                  step="0.01" /></label
              ><label
                ><span>每月 USD</span
                ><input
                  v-model.number="groupForm.monthlyLimit"
                  type="number"
                  min="0"
                  step="0.01" /></label
              ><label
                ><span>RPM</span
                ><input
                  v-model.number="groupForm.rpmLimit"
                  type="number"
                  min="0"
              /></label>
            </div>
            <div class="form-grid">
              <label
                ><span>额度 fallback</span
                ><AppSelect v-model="groupForm.fallbackGroupId">
                  <option :value="null">无</option>
                  <option
                    v-for="item in groups.filter(
                      (value) => value.id !== editingGroup?.id,
                    )"
                    :key="item.id"
                    :value="item.id"
                  >
                    {{ item.name }}
                  </option>
                </AppSelect></label
              ><label
                ><span>无效请求 fallback</span
                ><AppSelect v-model="groupForm.invalidFallbackGroupId">
                  <option :value="null">无</option>
                  <option
                    v-for="item in groups.filter(
                      (value) => value.id !== editingGroup?.id,
                    )"
                    :key="item.id"
                    :value="item.id"
                  >
                    {{ item.name }}
                  </option>
                </AppSelect></label
              >
            </div>
          </section>
          <section class="form-section">
            <header>
              <h3>媒体与平台策略</h3>
              <span>图片、视频和 OAuth 限制</span>
            </header>
            <div class="policy-switches">
              <label class="switch"
                ><input
                  v-model="groupForm.allowImage"
                  type="checkbox"
                /><span />图片生成</label
              ><label class="switch"
                ><input
                  v-model="groupForm.allowBatchImage"
                  type="checkbox"
                /><span />批量图片</label
              ><label class="switch"
                ><input
                  v-model="groupForm.imageRateIndependent"
                  type="checkbox"
                /><span />图片独立倍率</label
              ><label class="switch"
                ><input
                  v-model="groupForm.videoRateIndependent"
                  type="checkbox"
                /><span />视频独立倍率</label
              ><label class="switch"
                ><input
                  v-model="groupForm.claudeCodeOnly"
                  type="checkbox"
                /><span />仅 Claude Code</label
              ><label class="switch"
                ><input
                  v-model="groupForm.allowMessagesDispatch"
                  type="checkbox"
                /><span />Messages Dispatch</label
              ><label class="switch"
                ><input
                  v-model="groupForm.requireOAuthOnly"
                  type="checkbox"
                /><span />仅 OAuth</label
              ><label class="switch"
                ><input
                  v-model="groupForm.requirePrivacySet"
                  type="checkbox"
                /><span />要求隐私设置</label
              >
            </div>
            <div class="form-grid form-grid--four">
              <label
                ><span>图片倍率</span
                ><input
                  v-model.number="groupForm.imageRateMultiplier"
                  type="number"
                  min="0"
                  step="0.01" /></label
              ><label
                ><span>视频倍率</span
                ><input
                  v-model.number="groupForm.videoRateMultiplier"
                  type="number"
                  min="0"
                  step="0.01" /></label
              ><label
                ><span>最大推理强度</span
                ><AppSelect v-model="groupForm.maxReasoningEffort">
                  <option value="">不限</option>
                  <option
                    v-for="value in [
                      'minimal',
                      'low',
                      'medium',
                      'high',
                      'xhigh',
                    ]"
                    :key="value"
                  >
                    {{ value }}
                  </option>
                </AppSelect></label
              ><label class="switch"
                ><input
                  v-model="groupForm.isExclusive"
                  type="checkbox"
                /><span />独占分组</label
              >
            </div>
            <div class="form-grid form-grid--four">
              <label
                ><span>1K 图片价格</span
                ><input
                  v-model.number="groupForm.imagePrice1K"
                  type="number"
                  min="0"
                  step="0.0001"
              /></label>
              <label
                ><span>2K 图片价格</span
                ><input
                  v-model.number="groupForm.imagePrice2K"
                  type="number"
                  min="0"
                  step="0.0001"
              /></label>
              <label
                ><span>4K 图片价格</span
                ><input
                  v-model.number="groupForm.imagePrice4K"
                  type="number"
                  min="0"
                  step="0.0001"
              /></label>
              <label
                ><span>Web Search / 次</span
                ><input
                  v-model.number="groupForm.webSearchPricePerCall"
                  type="number"
                  min="0"
                  step="0.0001"
              /></label>
              <label
                ><span>480P 视频价格</span
                ><input
                  v-model.number="groupForm.videoPrice480P"
                  type="number"
                  min="0"
                  step="0.0001"
              /></label>
              <label
                ><span>720P 视频价格</span
                ><input
                  v-model.number="groupForm.videoPrice720P"
                  type="number"
                  min="0"
                  step="0.0001"
              /></label>
              <label
                ><span>1080P 视频价格</span
                ><input
                  v-model.number="groupForm.videoPrice1080P"
                  type="number"
                  min="0"
                  step="0.0001"
              /></label>
              <label
                ><span>批量图片折扣</span
                ><input
                  v-model.number="groupForm.batchImageDiscountMultiplier"
                  type="number"
                  min="0"
                  step="0.01"
              /></label>
            </div>
          </section>
          <section class="form-section">
            <header>
              <h3>峰值与模型策略</h3>
              <span>调度窗口、模型范围和推理映射</span>
            </header>
            <div class="policy-switches">
              <label class="switch"
                ><input
                  v-model="groupForm.peakRateEnabled"
                  type="checkbox"
                /><span />启用峰值倍率</label
              >
              <label class="switch"
                ><input
                  v-model="groupForm.allowLive"
                  type="checkbox"
                /><span />允许 Live</label
              >
            </div>
            <div class="form-grid form-grid--four">
              <label
                ><span>峰值开始</span
                ><input v-model="groupForm.peakStart" type="time"
              /></label>
              <label
                ><span>峰值结束</span
                ><input v-model="groupForm.peakEnd" type="time"
              /></label>
              <label
                ><span>峰值倍率</span
                ><input
                  v-model.number="groupForm.peakRateMultiplier"
                  type="number"
                  min="0"
                  step="0.01"
              /></label>
              <label
                ><span>默认映射模型</span
                ><input v-model="groupForm.defaultMappedModel"
              /></label>
            </div>
            <label
              ><span>支持模型范围（逗号分隔）</span
              ><input
                v-model="groupForm.supportedModelScopes"
                placeholder="gemini, claude"
            /></label>
            <label
              ><span>推理强度映射 JSON</span
              ><textarea
                v-model="groupForm.reasoningEffortMappings"
                class="policy-json"
                spellcheck="false"
              />
            </label>
          </section>
          <p v-if="error" class="form-error">{{ error }}</p>
          <footer>
            <button
              type="button"
              class="button button--quiet"
              @click="modal = null"
            >
              取消</button
            ><button class="button button--primary" :disabled="saving">
              {{ saving ? "保存中" : "保存分组" }}
            </button>
          </footer>
        </form>
      </section>
    </div>
  </div>
</template>
