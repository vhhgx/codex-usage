<script setup lang="ts">
import {
  IconArrowRight,
  IconCalendar,
  IconCash,
  IconDownload,
  IconEdit,
  IconPlus,
  IconReceipt2,
  IconSearch,
  IconTrash,
  IconWallet,
  IconX
} from '@tabler/icons-vue'
import { LEDGER_TRANSACTION_TYPES, type LedgerSummary, type LedgerTransactionType, type LedgerTransactionView } from '#shared/types/accounting'

definePageMeta({ layout: 'admin', middleware: ['admin', 'account-admin'] })
useSeoMeta({ title: '收支台账 | Zephyr Hub' })

const { show: showToast } = useAppToast()
const { data, refresh } = await useFetch<{ items: LedgerTransactionView[]; summary: LedgerSummary; overallSummary: LedgerSummary }>('/api/admin/ledger')
const search = ref('')
const typeFilter = ref('')
const fromDate = ref('')
const toDate = ref('')
const editing = ref<LedgerTransactionView | null>(null)
const showForm = ref(false)
const saving = ref(false)
const formError = ref('')
const form = reactive({
  occurredOn: new Date().toISOString().slice(0, 10),
  type: 'personal_expense' as LedgerTransactionType,
  project: '',
  unitPrice: '',
  quantity: 1,
  note: ''
})

const typeLabels: Record<LedgerTransactionType, string> = {
  personal_expense: '我的支出',
  personal_income: '我的收入',
  linglong_expense: '灵龙支出',
  nvtokens_topup: 'nvtokens 储值',
  nvtokens_consumption: '消费储值'
}

const filtered = computed(() => (data.value?.items || []).filter(item => {
  const needle = search.value.trim().toLowerCase()
  return (!typeFilter.value || item.type === typeFilter.value)
    && (!fromDate.value || item.occurredOn >= fromDate.value)
    && (!toDate.value || item.occurredOn <= toDate.value)
    && (!needle || `${item.project} ${item.note}`.toLowerCase().includes(needle))
}))

function summarize(items: LedgerTransactionView[]): LedgerSummary {
  const result: LedgerSummary = {
    recordCount: 0, totalExpenseCents: 0, personalExpenseCents: 0, personalIncomeCents: 0,
    linglongExpenseCents: 0, nvtokensTopupCents: 0, nvtokensConsumptionCents: 0,
    nvtokensBalanceCents: 0, netCents: 0
  }
  for (const item of items) {
    result.recordCount++
    if (item.type === 'personal_expense') result.personalExpenseCents += item.amountCents
    if (item.type === 'personal_income') result.personalIncomeCents += item.amountCents
    if (item.type === 'linglong_expense') result.linglongExpenseCents += item.amountCents
    if (item.type === 'nvtokens_topup') result.nvtokensTopupCents += item.amountCents
    if (item.type === 'nvtokens_consumption') result.nvtokensConsumptionCents += item.amountCents
  }
  result.totalExpenseCents = result.personalExpenseCents + result.linglongExpenseCents + result.nvtokensTopupCents
  result.nvtokensBalanceCents = result.nvtokensTopupCents - result.nvtokensConsumptionCents
  result.netCents = result.personalIncomeCents - result.personalExpenseCents - result.nvtokensTopupCents
  return result
}

const summary = computed(() => summarize(filtered.value))
const amountPreview = computed(() => {
  const price = Number(form.unitPrice || 0)
  return Number.isFinite(price) && Number.isFinite(form.quantity) ? Math.round(price * form.quantity * 100) : 0
})

function money(cents: number) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(cents / 100)
}

function failure(value: unknown, fallback: string) {
  const error = value as { data?: { message?: string; statusMessage?: string }; message?: string }
  return error.data?.message || error.data?.statusMessage || error.message || fallback
}

function resetForm() {
  Object.assign(form, {
    occurredOn: new Date().toISOString().slice(0, 10),
    type: 'personal_expense', project: '', unitPrice: '', quantity: 1, note: ''
  })
  formError.value = ''
}

function openCreate() {
  editing.value = null
  resetForm()
  showForm.value = true
}

function openEdit(item: LedgerTransactionView) {
  editing.value = item
  Object.assign(form, {
    occurredOn: item.occurredOn,
    type: item.type,
    project: item.project,
    unitPrice: (item.unitPriceCents / 100).toFixed(2),
    quantity: item.quantity,
    note: item.note
  })
  formError.value = ''
  showForm.value = true
}

async function save() {
  saving.value = true
  formError.value = ''
  try {
    if (editing.value) await $fetch(`/api/admin/ledger/${editing.value.id}`, { method: 'PATCH', body: form })
    else await $fetch('/api/admin/ledger', { method: 'POST', body: form })
    await refresh()
    showForm.value = false
    showToast(editing.value ? '流水已更新' : '流水已新增', 'success')
  } catch (value) {
    formError.value = failure(value, '保存流水失败')
  } finally {
    saving.value = false
  }
}

async function remove(item: LedgerTransactionView) {
  if (!confirm(`删除 ${item.occurredOn} 的“${typeLabels[item.type]}”记录？此操作不可恢复。`)) return
  try {
    await $fetch(`/api/admin/ledger/${item.id}`, { method: 'DELETE' })
    await refresh()
    showToast('流水已删除', 'success')
  } catch (value) {
    showToast(failure(value, '删除流水失败'), 'error')
  }
}

function clearFilters() {
  search.value = ''
  typeFilter.value = ''
  fromDate.value = ''
  toDate.value = ''
}

function exportCsv() {
  const query = new URLSearchParams()
  if (search.value.trim()) query.set('search', search.value.trim())
  if (typeFilter.value) query.set('type', typeFilter.value)
  if (fromDate.value) query.set('from', fromDate.value)
  if (toDate.value) query.set('to', toDate.value)
  window.location.assign(`/api/admin/ledger/export.csv${query.size ? `?${query}` : ''}`)
  showToast('CSV 导出已开始', 'info')
}
</script>

<template>
  <div class="admin-page ledger-page">
    <header class="admin-page__header">
      <div><span class="admin-kicker">CASH &amp; STORED VALUE</span><h1>收支台账</h1><p>记录个人收支、灵龙支出和 nvtokens 储值变化。</p></div>
      <div class="admin-header-actions"><button class="button button--secondary" type="button" @click="exportCsv"><IconDownload :size="17" />导出 CSV</button><button class="button button--primary" type="button" @click="openCreate"><IconPlus :size="17" />新增流水</button></div>
    </header>

    <section class="ledger-summary-strip" aria-label="流水汇总">
      <article><span><IconCash :size="16" />筛选总花费</span><strong class="negative">{{ money(summary.totalExpenseCents) }}</strong><small>个人、灵龙与储值</small></article>
      <article><span>我的支出</span><strong>{{ money(summary.personalExpenseCents) }}</strong><small>{{ filtered.filter(item => item.type === 'personal_expense').length }} 条记录</small></article>
      <article><span>我的收入</span><strong class="positive">{{ money(summary.personalIncomeCents) }}</strong><small>{{ filtered.filter(item => item.type === 'personal_income').length }} 条记录</small></article>
      <article><span>净收支</span><strong :class="summary.netCents >= 0 ? 'positive' : 'negative'">{{ money(summary.netCents) }}</strong><small>当前筛选范围</small></article>
      <article><span><IconWallet :size="16" />nvtokens 余额</span><strong class="wallet">{{ money(data?.overallSummary.nvtokensBalanceCents || 0) }}</strong><small>全部流水累计余额</small></article>
      <article><span>灵龙支出</span><strong>{{ money(summary.linglongExpenseCents) }}</strong><small>{{ filtered.filter(item => item.type === 'linglong_expense').length }} 条记录</small></article>
    </section>

    <section class="admin-toolbar ledger-toolbar">
      <label class="admin-search"><IconSearch :size="17" /><input v-model="search" type="search" placeholder="搜索项目或备注"></label>
      <AppSelect v-model="typeFilter"><option value="">全部类型</option><option v-for="type in LEDGER_TRANSACTION_TYPES" :key="type" :value="type">{{ typeLabels[type] }}</option></AppSelect>
      <div class="ledger-date-range" role="group" aria-label="日期范围">
        <IconCalendar :size="17" aria-hidden="true" />
        <label><span>开始日期</span><input v-model="fromDate" type="date" aria-label="开始日期"></label>
        <IconArrowRight class="ledger-date-range__arrow" :size="16" aria-hidden="true" />
        <label><span>结束日期</span><input v-model="toDate" type="date" aria-label="结束日期"></label>
      </div>
      <button class="button button--secondary" type="button" @click="clearFilters">清除</button>
      <span>{{ filtered.length }} 条流水</span>
    </section>
    <section class="admin-table-wrap">
      <table class="admin-table ledger-table">
        <thead><tr><th>日期</th><th>类型</th><th>项目</th><th class="number-cell">单价</th><th class="number-cell">数量</th><th class="number-cell">金额</th><th>备注</th><th aria-label="操作" /></tr></thead>
        <tbody>
          <tr v-for="item in filtered" :key="item.id">
            <td><strong>{{ item.occurredOn }}</strong></td>
            <td><span class="ledger-type" :data-type="item.type">{{ typeLabels[item.type] }}</span></td>
            <td><div class="table-primary"><span class="key-glyph"><IconReceipt2 :size="16" /></span><div><strong>{{ item.project || '未命名项目' }}</strong><code>{{ item.id.slice(0, 8) }}</code></div></div></td>
            <td class="number-cell">{{ money(item.unitPriceCents) }}</td>
            <td class="number-cell">{{ item.quantity }}</td>
            <td class="number-cell"><strong :class="item.type === 'personal_income' ? 'positive' : ''">{{ money(item.amountCents) }}</strong></td>
            <td><span class="ledger-note">{{ item.note || '—' }}</span></td>
            <td><div class="table-actions"><button class="icon-button" type="button" title="编辑流水" aria-label="编辑流水" @click="openEdit(item)"><IconEdit :size="16" /></button><button class="icon-button danger" type="button" title="删除流水" aria-label="删除流水" @click="remove(item)"><IconTrash :size="16" /></button></div></td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="8"><div class="admin-empty ledger-empty"><IconReceipt2 :size="25" /><span>没有匹配的流水记录</span><button v-if="!data?.items.length" class="button button--primary" type="button" @click="openCreate">新增第一条流水</button></div></td></tr>
        </tbody>
      </table>
    </section>

    <div v-if="showForm" class="admin-modal-backdrop" @click.self="showForm = false">
      <section class="admin-modal" role="dialog" aria-modal="true" :aria-label="editing ? '编辑流水' : '新增流水'">
        <header><div><span>LEDGER ENTRY</span><h2>{{ editing ? '编辑流水' : '新增流水' }}</h2></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showForm = false"><IconX :size="18" /></button></header>
        <form class="admin-form" @submit.prevent="save">
          <div class="form-grid"><label><span>日期 *</span><input v-model="form.occurredOn" type="date" required></label><label><span>流水类型</span><AppSelect v-model="form.type"><option v-for="type in LEDGER_TRANSACTION_TYPES" :key="type" :value="type">{{ typeLabels[type] }}</option></AppSelect></label></div>
          <label><span>项目</span><input v-model="form.project" maxlength="120"></label>
          <div class="form-grid"><label><span>单价（元）*</span><input v-model="form.unitPrice" type="number" min="0" step="0.01" inputmode="decimal" required></label><label><span>数量 *</span><input v-model.number="form.quantity" type="number" min="1" max="100000" step="1" required></label></div>
          <div class="ledger-amount-preview"><span>金额</span><strong>{{ money(amountPreview) }}</strong></div>
          <label><span>备注</span><textarea v-model="form.note" maxlength="500" rows="4"></textarea></label>
          <p v-if="formError" class="form-error">{{ formError }}</p>
          <footer><button class="button button--secondary" type="button" @click="showForm = false">取消</button><button class="button button--primary" :disabled="saving">{{ saving ? '保存中' : '保存流水' }}</button></footer>
        </form>
      </section>
    </div>
  </div>
</template>
