<script setup lang="ts">
import { IconEdit, IconPlus, IconTicket, IconTrash, IconX } from '@tabler/icons-vue'
import { formatTokenCount } from '#shared/utils/number-format'

interface Plan {
  id: string
  name: string
  description: string | null
  mode: 'unlimited' | 'token' | 'cost'
  cycle: 'none' | 'week' | 'month'
  tokenLimit: number | null
  costLimit: number | null
  price: number
  status: 'active' | 'disabled'
  subscriberCount: number
  currentVersion?: { billingMode?: string; supplyMode?: string; quotaUnit?: string; maxPoolAccounts?: number | null; privateUsageBilling?: string; privateUsageRateMultiplier?: number }
}

const { data, refresh } = await useFetch<{ plans: Plan[] }>('/api/admin/plans')
const { show: showToast } = useAppToast()
const showForm = ref(false)
const editing = ref<Plan | null>(null)
const saving = ref(false)
const error = ref('')
const deleting = ref<Plan | null>(null)
const form = reactive({
  name: '',
  description: '',
  mode: 'unlimited' as Plan['mode'],
  cycle: 'none' as Plan['cycle'],
  tokenLimit: null as number | null,
  costLimit: null as number | null,
  price: 0,
  status: 'active' as Plan['status'],
  billingMode: 'unlimited' as 'unlimited' | 'token_package' | 'token_metered',
  supplyMode: 'platform_only' as 'platform_only' | 'platform_then_private' | 'private_only',
  quotaUnit: 'raw_token' as 'raw_token' | 'weighted_token',
  maxPoolAccounts: null as number | null,
  privateUsageBilling: 'free' as 'free' | 'metered',
  privateUsageRateMultiplier: 1
})

function openCreate() {
  editing.value = null
  Object.assign(form, {
    name: '', description: '', mode: 'unlimited', cycle: 'none',
    tokenLimit: null, costLimit: null, price: 0, status: 'active', billingMode: 'unlimited', supplyMode: 'platform_only', quotaUnit: 'raw_token', maxPoolAccounts: null, privateUsageBilling: 'free', privateUsageRateMultiplier: 1
  })
  error.value = ''
  showForm.value = true
}

function openEdit(plan: Plan) {
  editing.value = plan
  Object.assign(form, {
    name: plan.name,
    description: plan.description || '',
    mode: plan.mode,
    cycle: plan.cycle,
    tokenLimit: plan.tokenLimit,
    costLimit: plan.costLimit,
    price: plan.price,
    status: plan.status,
    billingMode: plan.currentVersion?.billingMode || (plan.mode === 'token' ? 'token_package' : plan.mode === 'cost' ? 'token_metered' : 'unlimited'),
    supplyMode: plan.currentVersion?.supplyMode || 'platform_only',
    quotaUnit: plan.currentVersion?.quotaUnit || 'raw_token',
    maxPoolAccounts: plan.currentVersion?.maxPoolAccounts || null,
    privateUsageBilling: plan.currentVersion?.privateUsageBilling || 'free',
    privateUsageRateMultiplier: plan.currentVersion?.privateUsageRateMultiplier || 1
  })
  error.value = ''
  showForm.value = true
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    const path = editing.value ? `/api/admin/plans/${editing.value.id}` : '/api/admin/plans'
    await $fetch(path, { method: editing.value ? 'PATCH' : 'POST', body: form })
    await refresh()
    showForm.value = false
    showToast(editing.value ? '套餐已更新' : '套餐已创建', 'success')
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    error.value = failure.data?.message || failure.message || '保存套餐失败'
  } finally {
    saving.value = false
  }
}

async function remove() {
  if (!deleting.value) return
  saving.value = true
  try {
    await $fetch(`/api/admin/plans/${deleting.value.id}`, { method: 'DELETE' })
    deleting.value = null
    await refresh()
    showToast('套餐已删除', 'success')
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    showToast(failure.data?.message || failure.message || '删除套餐失败', 'error')
  } finally {
    saving.value = false
  }
}

const modeLabel = (plan: Plan) => plan.mode === 'unlimited'
  ? '不限量'
  : plan.mode === 'token'
    ? `${formatTokenCount(Number(plan.tokenLimit || 0))} Token`
    : `$${Number(plan.costLimit || 0).toLocaleString('zh-CN')}`
const cycleLabel = (cycle: Plan['cycle']) => cycle === 'week' ? '7 天' : cycle === 'month' ? '1 个月' : '长期'

defineExpose({ openCreate })
</script>

<template>
  <div class="hub-plans-panel">
    <section v-if="data?.plans.length" class="plan-grid">
      <article v-for="plan in data.plans" :key="plan.id" class="admin-panel plan-card">
        <header><div><span>{{ cycleLabel(plan.cycle) }}</span><h2 class="text-balance">{{ plan.name }}</h2></div><span class="status-label" :data-status="plan.status">{{ plan.status === 'active' ? '启用' : '停用' }}</span></header>
        <div class="plan-card__body"><strong>{{ modeLabel(plan) }}</strong><p class="text-pretty">{{ plan.description || '未填写套餐说明' }}</p><dl><div><dt>售价</dt><dd>${{ plan.price.toFixed(2) }}</dd></div><div><dt>用户</dt><dd>{{ plan.subscriberCount }}</dd></div></dl></div>
        <footer><button class="button button--quiet button--small" type="button" @click="openEdit(plan)"><IconEdit :size="15" />编辑</button><button class="icon-button danger" type="button" title="删除套餐" aria-label="删除套餐" :disabled="plan.id === '00000000-0000-4000-8000-000000000002' || plan.subscriberCount > 0" @click="deleting = plan"><IconTrash :size="16" /></button></footer>
      </article>
    </section>
    <div v-else class="admin-empty admin-empty--large"><IconTicket :size="24" /><span>还没有套餐</span><button class="button button--primary button--small" type="button" @click="openCreate"><IconPlus :size="16" />新建套餐</button></div>

    <div v-if="showForm" class="admin-modal-backdrop" @click.self="showForm = false">
      <section class="admin-modal" role="dialog" aria-modal="true" :aria-label="editing ? '编辑套餐' : '新建套餐'">
        <header><div><span>PLAN</span><h2 class="text-balance">{{ editing ? '编辑套餐' : '新建套餐' }}</h2></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showForm = false"><IconX :size="18" /></button></header>
        <form class="admin-form" @submit.prevent="save">
          <label><span>套餐名称</span><input v-model="form.name" required maxlength="120"></label>
          <label><span>套餐说明</span><textarea v-model="form.description" rows="3" maxlength="1000" /></label>
          <div class="form-grid"><label><span>计费方式</span><AppSelect v-model="form.billingMode"><option value="unlimited">不限量订阅</option><option value="token_package">Token 套餐包</option><option value="token_metered">按 Token 计费</option></AppSelect></label><label><span>资源供给</span><AppSelect v-model="form.supplyMode"><option value="platform_only">仅平台公共资源</option><option value="platform_then_private">额度后接续专属池</option><option value="private_only">始终使用专属池</option></AppSelect></label><label><span>有效周期</span><AppSelect v-model="form.cycle"><option value="none">长期</option><option value="week">7 天</option><option value="month">1 个月</option></AppSelect></label></div>
          <div v-if="form.billingMode === 'token_package'" class="form-grid"><label><span>Token 口径</span><AppSelect v-model="form.quotaUnit"><option value="raw_token">原始 Token</option><option value="weighted_token">加权 Token</option></AppSelect></label><label><span>Token 额度</span><input v-model.number="form.tokenLimit" type="number" min="1" step="1" required></label><label><span>专属池最大账号数</span><input v-model.number="form.maxPoolAccounts" type="number" min="1" step="1"></label></div>
          <div class="form-grid"><label v-if="form.billingMode === 'token_metered'"><span>金额额度（兼容旧模型）</span><input v-model.number="form.costLimit" type="number" min="0.00000001" step="0.00000001"></label><label><span>售价（USD）</span><input v-model.number="form.price" type="number" min="0" step="0.01"></label><label v-if="editing"><span>状态</span><AppSelect v-model="form.status"><option value="active">启用</option><option value="disabled">停用</option></AppSelect></label></div>
          <p v-if="error" class="form-error">{{ error }}</p>
          <footer><button class="button button--secondary" type="button" @click="showForm = false">取消</button><button class="button button--primary" :disabled="saving">{{ saving ? '保存中' : '保存套餐' }}</button></footer>
        </form>
      </section>
    </div>
    <AppConfirmDialog :open="Boolean(deleting)" title="删除套餐" :message="`删除后无法恢复。确定删除“${deleting?.name || ''}”？`" :busy="saving" @close="deleting = null" @confirm="remove" />
  </div>
</template>
