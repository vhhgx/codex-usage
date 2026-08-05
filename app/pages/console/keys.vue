<script setup lang="ts">
import { IconCopy, IconEdit, IconEye, IconEyeOff, IconKey, IconPlus, IconPower, IconTrash, IconX } from '@tabler/icons-vue'
import type { HubKeyView } from '#shared/types/hub'

definePageMeta({ layout: 'console', middleware: 'user' })
useSeoMeta({ title: '我的 Keys | Zephyr Hub' })
const { data, refresh } = await useFetch<{ keys: HubKeyView[] }>('/api/console/keys')
const toast = useAppToast()
const selected = ref<HubKeyView | null>(null)
const deleting = ref<HubKeyView | null>(null)
const showCreate = ref(false)
const name = ref('')
const note = ref('')
const password = ref('')
const secret = ref('')
const error = ref('')
const busy = ref(false)
const copied = ref(false)
const createdSecret = ref('')
const createForm = reactive({ name: '', note: '', key: '' })

function openCreate() { Object.assign(createForm, { name: '', note: '', key: '' }); error.value = ''; showCreate.value = true }
function edit(item: HubKeyView) { selected.value = item; name.value = item.name; note.value = item.note || ''; password.value = ''; secret.value = ''; error.value = '' }
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
async function reveal() {
  if (!selected.value) return
  busy.value = true
  error.value = ''
  try { secret.value = (await $fetch<{ key: string }>(`/api/console/keys/${selected.value.id}/reveal`, { method: 'POST', body: { password: password.value } })).key }
  catch (value) { const failure = value as { data?: { message?: string }; message?: string }; error.value = failure.data?.message || failure.message || '查看失败' }
  finally { busy.value = false }
}
async function copy(value = secret.value) { await navigator.clipboard.writeText(value); copied.value = true; toast.show('完整 Key 已复制', 'success'); window.setTimeout(() => { copied.value = false }, 1500) }
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
  <div class="admin-page">
    <header class="admin-page__header"><div><span class="admin-kicker">MY CREDENTIALS</span><h1>我的 Keys</h1><p>创建并管理自己的 Hub 访问凭据。所有 Key 固定使用默认分组权限。</p></div><button class="button button--primary" @click="openCreate"><IconPlus :size="17" />创建 Key</button></header>
    <section v-if="createdSecret" class="created-secret"><div><IconKey :size="19" /><div><strong>新 Key 已创建</strong><p>完整值只在这里直接展示，请立即保存。</p></div></div><code>{{ createdSecret }}</code><div><button class="button button--secondary button--small" @click="copy(createdSecret)"><IconCopy :size="15" />复制</button><button class="icon-button" title="关闭" aria-label="关闭新 Key 提示" @click="createdSecret = ''"><IconX :size="16" /></button></div></section>
    <section class="admin-table-wrap console-table"><table class="admin-table"><thead><tr><th>Key</th><th>权限分组</th><th>状态</th><th>模型 / 端点</th><th>最近使用</th><th aria-label="操作" /></tr></thead><tbody><tr v-for="item in data?.keys || []" :key="item.id"><td><div class="table-primary"><span class="key-glyph"><IconKey :size="16" /></span><div><strong>{{ item.name }}</strong><code>{{ item.maskedKey }}</code><small>{{ item.note || '无备注' }}</small></div></div></td><td>{{ item.groupName || '默认分组' }}</td><td><span class="status-label" :data-status="item.status">{{ item.status === 'active' ? '已启用' : item.status === 'expired' ? '已到期' : '已停用' }}</span></td><td>{{ item.allowedModels.length || '全部' }} / {{ item.allowedEndpoints.length || '全部' }}</td><td>{{ item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleString('zh-CN') : '尚未使用' }}</td><td><div class="table-actions"><button class="icon-button" :title="item.status === 'active' ? '停用 Key' : '启用 Key'" :aria-label="item.status === 'active' ? '停用 Key' : '启用 Key'" :disabled="item.status === 'expired'" @click="toggle(item)"><IconPower :size="17" /></button><button class="icon-button" title="查看和编辑" aria-label="查看和编辑 Key" @click="edit(item)"><IconEdit :size="17" /></button><button class="icon-button danger" title="删除 Key" aria-label="删除 Key" @click="deleting = item"><IconTrash :size="17" /></button></div></td></tr><tr v-if="!data?.keys.length"><td colspan="6"><div class="admin-empty console-empty"><div><IconKey :size="24" /><p>还没有 Hub Key</p><button class="button button--primary button--small" @click="openCreate">创建第一个 Key</button></div></div></td></tr></tbody></table></section>

    <div v-if="showCreate" class="admin-modal-backdrop" @click.self="showCreate = false"><section class="admin-modal" role="dialog" aria-modal="true"><header><div><span>CREATE KEY</span><h2>创建 Hub Key</h2></div><button class="icon-button" title="关闭" aria-label="关闭" @click="showCreate = false"><IconX :size="18" /></button></header><form class="admin-form" @submit.prevent="createKey"><label><span>名称</span><input v-model="createForm.name" required maxlength="120" placeholder="例如：Codex CLI"></label><label><span>备注</span><input v-model="createForm.note" maxlength="1000" placeholder="可选"></label><label><span>自定义 Key</span><input v-model="createForm.key" autocomplete="off" spellcheck="false" placeholder="留空则自动生成"><small>仅在需要迁移现有 Key 时填写。</small></label><p v-if="error" class="form-error">{{ error }}</p><footer><button type="button" class="button button--secondary" @click="showCreate = false">取消</button><button class="button button--primary" :disabled="busy">{{ busy ? '创建中' : '创建 Key' }}</button></footer></form></section></div>

    <div v-if="selected" class="admin-modal-backdrop" @click.self="selected = null"><section class="admin-modal" role="dialog" aria-modal="true"><header><div><span>MY KEY</span><h2>{{ selected.name }}</h2></div><button class="icon-button" title="关闭" aria-label="关闭" @click="selected = null"><IconX :size="18" /></button></header><form class="admin-form" @submit.prevent="save"><label><span>名称</span><input v-model="name" required></label><label><span>备注</span><input v-model="note"></label><section class="form-section"><header><h3>完整 Key</h3><span>敏感凭据</span></header><label><span>当前密码</span><input v-model="password" type="password" autocomplete="current-password" placeholder="首次查看时需要验证"></label><button type="button" class="button button--secondary" :disabled="busy || !selected.revealable" @click="reveal"><component :is="secret ? IconEyeOff : IconEye" :size="16" />{{ secret ? '重新验证' : '查看完整值' }}</button><div v-if="secret" class="credential-secret console-secret"><code>{{ secret }}</code><button type="button" class="button button--quiet button--small" @click="copy()"><IconCopy :size="15" />{{ copied ? '已复制' : '复制' }}</button></div></section><p v-if="error" class="form-error">{{ error }}</p><footer><button type="button" class="button button--secondary" @click="selected = null">取消</button><button class="button button--primary" :disabled="busy">保存资料</button></footer></form></section></div>
    <AppConfirmDialog :open="Boolean(deleting)" title="删除 Hub Key" :message="`删除“${deleting?.name || ''}”后，该凭据会立即失效；历史用量不会删除。`" :busy="busy" @close="deleting = null" @confirm="remove" />
  </div>
</template>
