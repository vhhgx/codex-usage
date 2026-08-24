<script setup lang="ts">
import { IconCopy, IconEdit, IconKey, IconPlus, IconPower, IconTrash, IconX } from '@tabler/icons-vue'
import type { HubKeyView } from '#shared/types/hub'

definePageMeta({ layout: 'console', middleware: 'user' })
useSeoMeta({ title: 'Keys 与用量 | Zephyr Hub' })
const { data, refresh } = await useFetch<{ keys: HubKeyView[] }>('/api/console/keys')
const toast = useAppToast()
const selected = ref<HubKeyView | null>(null)
const deleting = ref<HubKeyView | null>(null)
const showCreate = ref(false)
const name = ref('')
const note = ref('')
const error = ref('')
const busy = ref(false)
const copied = ref(false)
const copyingId = ref<string | null>(null)
const createdSecret = ref('')
const createForm = reactive({ name: '', note: '', key: '' })

function masked(value: string) {
  if (value.length <= 10) return value
  return `${value.slice(0, 6)}********${value.slice(-4)}`
}
function openCreate() { Object.assign(createForm, { name: '', note: '', key: '' }); error.value = ''; showCreate.value = true }
function edit(item: HubKeyView) { selected.value = item; name.value = item.name; note.value = item.note || ''; error.value = '' }
async function createKey() {
  busy.value = true
  error.value = ''
  try {
    const result = await $fetch<{ key: string; item: HubKeyView }>('/api/console/keys', { method: 'POST', body: createForm })
    createdSecret.value = result.key
    showCreate.value = false
    await refresh()
    toast.show('Key 已创建，请妥善保存完整值', 'success', 7000)
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    error.value = failure.data?.message || failure.message || '创建 Key 失败'
  } finally { busy.value = false }
}
async function save() {
  if (!selected.value) return
  busy.value = true
  error.value = ''
  try {
    await $fetch(`/api/console/keys/${selected.value.id}`, { method: 'PATCH', body: { name: name.value, note: note.value } })
    await refresh()
    selected.value = null
    toast.show('Key 资料已更新', 'success')
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    error.value = failure.data?.message || failure.message || '保存失败'
  } finally { busy.value = false }
}
async function copy(value: string) { await navigator.clipboard.writeText(value); copied.value = true; toast.show('完整 Key 已复制', 'success'); window.setTimeout(() => { copied.value = false }, 1500) }
async function copyKey(item: HubKeyView) {
  copyingId.value = item.id
  try {
    const { key } = await $fetch<{ key: string }>(`/api/console/keys/${item.id}/reveal`, { method: 'POST' })
    await navigator.clipboard.writeText(key)
    toast.show(`${item.name} 已复制`, 'success')
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    toast.show(failure.data?.message || failure.message || '复制 Key 失败', 'error')
  } finally { copyingId.value = null }
}
async function toggle(item: HubKeyView) {
  try { await $fetch(`/api/console/keys/${item.id}`, { method: 'PATCH', body: { status: item.status === 'active' ? 'disabled' : 'active' } }); await refresh(); toast.show(item.status === 'active' ? 'Key 已停用' : 'Key 已启用', 'success') }
  catch (value) { const failure = value as { data?: { message?: string }; message?: string }; toast.show(failure.data?.message || failure.message || '状态更新失败', 'error') }
}
async function remove() {
  if (!deleting.value) return
  busy.value = true
  try { await $fetch(`/api/console/keys/${deleting.value.id}`, { method: 'DELETE' }); deleting.value = null; await refresh(); toast.show('Key 已删除，历史用量仍保留', 'success') }
  catch (value) { const failure = value as { data?: { message?: string }; message?: string }; toast.show(failure.data?.message || failure.message || '删除 Key 失败', 'error') }
  finally { busy.value = false }
}
</script>

<template>
  <div class="admin-page keys-page">
    <header class="admin-page__header"><div><span class="admin-kicker">KEYS & USAGE</span><h1 class="text-balance">Keys 与用量</h1><p class="text-pretty">管理 Hub 访问凭据；用量统计直接展示在 Key 列表上方。</p></div><button class="button button--primary" @click="openCreate"><IconPlus :size="17" />创建 Key</button></header>
    <section class="keys-content">
        <ConsoleUserUsagePanel />
        <section v-if="createdSecret" class="created-secret"><div><IconKey :size="19" /><div><strong>新 Key 已创建</strong><p>页面仅展示掩码值，点击复制即可使用完整值。</p></div></div><code>{{ masked(createdSecret) }}</code><div><button class="button button--secondary button--small" @click="copy(createdSecret)"><IconCopy :size="15" />复制</button><button class="icon-button" title="关闭" aria-label="关闭新 Key 提示" @click="createdSecret = ''"><IconX :size="16" /></button></div></section>
        <section class="admin-table-wrap console-table"><table class="admin-table"><thead><tr><th>Key</th><th>权限分组</th><th>状态</th><th>模型 / 端点</th><th>最近使用</th><th aria-label="操作" /></tr></thead><tbody><tr v-for="item in data?.keys || []" :key="item.id"><td><div class="table-primary"><span class="key-glyph"><IconKey :size="16" /></span><div><strong>{{ item.name }}</strong><code>{{ item.maskedKey }}</code><small>{{ item.note || '无备注' }}</small></div></div></td><td>{{ item.groupName || '默认分组' }}</td><td><span class="status-label" :data-status="item.status">{{ item.status === 'active' ? '已启用' : item.status === 'expired' ? '已到期' : '已停用' }}</span></td><td>{{ item.allowedModels.length || '全部' }} / {{ item.allowedEndpoints.length || '全部' }}</td><td>{{ item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleString('zh-CN') : '尚未使用' }}</td><td><div class="table-actions"><button class="icon-button" title="复制完整 Key" aria-label="复制完整 Key" :disabled="copyingId === item.id || !item.revealable" @click="copyKey(item)"><IconCopy :size="17" /></button><button class="icon-button" :title="item.status === 'active' ? '停用 Key' : '启用 Key'" :aria-label="item.status === 'active' ? '停用 Key' : '启用 Key'" :disabled="item.status === 'expired'" @click="toggle(item)"><IconPower :size="17" /></button><button class="icon-button" title="查看和编辑" aria-label="查看和编辑 Key" @click="edit(item)"><IconEdit :size="17" /></button><button class="icon-button danger" title="删除 Key" aria-label="删除 Key" @click="deleting = item"><IconTrash :size="17" /></button></div></td></tr><tr v-if="!data?.keys.length"><td colspan="6"><div class="admin-empty console-empty"><div><IconKey :size="24" /><p>还没有 Hub Key</p><button class="button button--primary button--small" @click="openCreate">创建第一个 Key</button></div></div></td></tr></tbody></table></section>

        <AppDrawer :open="showCreate" kicker="CREATE KEY" title="创建 Hub Key" @close="showCreate = false"><form class="admin-form" @submit.prevent="createKey"><label><span>名称</span><input v-model="createForm.name" required maxlength="120" placeholder="例如：Codex CLI"></label><label><span>备注</span><input v-model="createForm.note" maxlength="1000" placeholder="可选"></label><label><span>自定义 Key</span><input v-model="createForm.key" autocomplete="off" spellcheck="false" placeholder="留空则自动生成"><small>仅在需要迁移现有 Key 时填写。</small></label><p v-if="error" class="form-error">{{ error }}</p><footer><button type="button" class="button button--secondary" @click="showCreate = false">取消</button><button class="button button--primary" :disabled="busy">{{ busy ? '创建中' : '创建 Key' }}</button></footer></form></AppDrawer>

        <AppDrawer v-if="selected" :open="Boolean(selected)" kicker="MY KEY" :title="selected.name" @close="selected = null"><form class="admin-form" @submit.prevent="save"><label><span>名称</span><input v-model="name" required></label><label><span>备注</span><input v-model="note"></label><section class="form-section"><header><h3>Key 展示</h3><span>仅显示掩码值</span></header><div class="credential-mask"><code>{{ selected.maskedKey }}</code><button type="button" class="button button--secondary button--small" :disabled="busy || !selected.revealable" @click="copyKey(selected)"><IconCopy :size="15" />复制</button></div></section><p v-if="error" class="form-error">{{ error }}</p><footer><button type="button" class="button button--secondary" @click="selected = null">取消</button><button class="button button--primary" :disabled="busy">保存资料</button></footer></form></AppDrawer>
        <AppConfirmDialog :open="Boolean(deleting)" title="删除 Hub Key" :message="`删除“${deleting?.name || ''}”后，该凭据会立即失效；历史用量不会删除。`" :busy="busy" @close="deleting = null" @confirm="remove" />
    </section>
  </div>
</template>

<style scoped>
.keys-content { display:grid; gap:1.25rem; }
.credential-mask { display: flex; align-items: center; justify-content: space-between; gap: .8rem; padding: .65rem .75rem; border: 1px solid var(--line-subtle); background: var(--surface-soft); }
.credential-mask code { overflow: hidden; color: var(--text); font: .8rem/1.4 var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
</style>
