<script setup lang="ts">
import { IconPlus, IconEdit, IconTrash, IconCheck, IconX } from '@tabler/icons-vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: '探测模型配置 | Zephyr Hub' })

interface ProbeModel {
  id: string
  vendor: string
  vendorFamily?: string
  protocol: string
  endpoint: string
  model: string
  displayName: string
  enabled: boolean
  sortOrder: number
  isLatest?: boolean
  releaseDate?: string
  usagePriority?: number
  createdAt: number
  updatedAt: number
}

const { data, refresh, status } = useLazyFetch<ProbeModel[]>('/api/admin/probe-models')
const toast = useAppToast()

const protocols = [
  { value: 'anthropic_messages', label: 'Anthropic Messages' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
  { value: 'openai_chat', label: 'OpenAI Chat' },
]

const vendors = [
  { value: 'Anthropic', family: 'anthropic' },
  { value: 'OpenAI', family: 'openai' },
  { value: 'Zhipu', family: 'zhipu' },
  { value: 'DeepSeek', family: 'deepseek' },
  { value: 'Kimi', family: 'kimi' },
  { value: 'Doubao', family: 'doubao' },
  { value: 'MiniMax', family: 'minimax' },
  { value: 'Other', family: 'other' },
]

const isEditing = ref(false)
const editingModel = ref<Partial<ProbeModel>>({})
const saving = ref(false)

const groupedModels = computed(() => {
  const groups: Record<string, ProbeModel[]> = {}
  for (const protocol of protocols) {
    groups[protocol.value] = (data.value || [])
      .filter(m => m.protocol === protocol.value)
      .sort((a, b) => (a.usagePriority || a.sortOrder) - (b.usagePriority || b.sortOrder))
  }
  return groups
})

function openAddDialog() {
  editingModel.value = {
    protocol: 'anthropic_messages',
    vendor: 'Anthropic',
    vendorFamily: 'anthropic',
    enabled: true,
    sortOrder: 100,
    usagePriority: 100,
    isLatest: false,
  }
  isEditing.value = true
}

function openEditDialog(model: ProbeModel) {
  editingModel.value = { ...model }
  isEditing.value = true
}

async function saveModel() {
  if (!editingModel.value.vendor || !editingModel.value.model || !editingModel.value.displayName) {
    toast.show('请填写必填项', 'error')
    return
  }

  saving.value = true
  try {
    if (editingModel.value.id) {
      await $fetch(`/api/admin/probe-models/${editingModel.value.id}`, {
        method: 'PATCH',
        body: editingModel.value
      })
      toast.show('已更新', 'success')
    } else {
      await $fetch('/api/admin/probe-models', {
        method: 'POST',
        body: editingModel.value
      })
      toast.show('已添加', 'success')
    }
    await refresh()
    isEditing.value = false
  } catch (error: any) {
    toast.show(error?.data?.message || '保存失败', 'error')
  } finally {
    saving.value = false
  }
}

async function deleteModel(id: string) {
  if (!confirm('确定删除此探测模型？')) return

  try {
    await $fetch(`/api/admin/probe-models/${id}`, { method: 'DELETE' })
    toast.show('已删除', 'success')
    await refresh()
  } catch (error: any) {
    toast.show(error?.data?.message || '删除失败', 'error')
  }
}
</script>

<template>
  <div class="admin-page probe-models-page">
    <header class="admin-page__header">
      <div>
        <span class="admin-kicker">PROBE MODELS</span>
        <h1>探测模型配置</h1>
        <p class="text-pretty">
          管理协议探测时使用的模型列表。探测时会按优先级从新到旧依次尝试，直到找到可用模型。
        </p>
      </div>
      <button @click="openAddDialog" class="admin-page__header-action">
        <IconPlus :size="18" />
        添加模型
      </button>
    </header>

    <div v-if="status === 'pending' && !data" class="loading-state">
      加载中...
    </div>

    <div v-else class="protocol-sections">
      <section v-for="protocol in protocols" :key="protocol.value" class="protocol-section">
        <h2>{{ protocol.label }}</h2>

        <div v-if="!groupedModels[protocol.value]?.length" class="empty-state">
          暂无探测模型
        </div>

        <table v-else class="models-table">
          <thead>
            <tr>
              <th>优先级</th>
              <th>厂商</th>
              <th>模型 ID</th>
              <th>显示名称</th>
              <th>发布日期</th>
              <th>标记</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="model in groupedModels[protocol.value]" :key="model.id">
              <td class="priority-cell">{{ model.usagePriority || model.sortOrder }}</td>
              <td>{{ model.vendor }}</td>
              <td><code>{{ model.model }}</code></td>
              <td>{{ model.displayName }}</td>
              <td>{{ model.releaseDate || '—' }}</td>
              <td>
                <span v-if="model.isLatest" class="badge badge-success">最新</span>
                <span v-else>—</span>
              </td>
              <td>
                <span class="badge" :class="model.enabled ? 'badge-success' : 'badge-secondary'">
                  {{ model.enabled ? '启用' : '禁用' }}
                </span>
              </td>
              <td class="actions-cell">
                <button @click="openEditDialog(model)" class="btn-icon" title="编辑">
                  <IconEdit :size="16" />
                </button>
                <button @click="deleteModel(model.id)" class="btn-icon btn-danger" title="删除">
                  <IconTrash :size="16" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 编辑对话框 -->
    <div v-if="isEditing" class="modal-overlay" @click.self="isEditing = false">
      <div class="modal-content">
        <header class="modal-header">
          <h3>{{ editingModel.id ? '编辑' : '添加' }}探测模型</h3>
          <button @click="isEditing = false" class="btn-icon">
            <IconX :size="20" />
          </button>
        </header>

        <form @submit.prevent="saveModel" class="modal-body">
          <div class="form-grid">
            <div class="form-group">
              <label>协议 <span class="required">*</span></label>
              <select v-model="editingModel.protocol" required>
                <option v-for="p in protocols" :key="p.value" :value="p.value">
                  {{ p.label }}
                </option>
              </select>
            </div>

            <div class="form-group">
              <label>厂商 <span class="required">*</span></label>
              <select v-model="editingModel.vendor" required>
                <option v-for="v in vendors" :key="v.value" :value="v.value">
                  {{ v.value }}
                </option>
              </select>
            </div>

            <div class="form-group full-width">
              <label>模型 ID <span class="required">*</span></label>
              <input
                v-model="editingModel.model"
                required
                placeholder="例如：gpt-5.6-20250514"
              />
            </div>

            <div class="form-group full-width">
              <label>显示名称 <span class="required">*</span></label>
              <input
                v-model="editingModel.displayName"
                required
                placeholder="例如：GPT-5.6"
              />
            </div>

            <div class="form-group">
              <label>发布日期</label>
              <input v-model="editingModel.releaseDate" type="date" />
            </div>

            <div class="form-group">
              <label>
                探测优先级
                <span class="help-text">越小越优先</span>
              </label>
              <input
                v-model.number="editingModel.usagePriority"
                type="number"
                min="1"
                max="1000"
                placeholder="10=最新, 20=次新, 30=稳定"
              />
            </div>

            <div class="form-group checkbox-group">
              <label>
                <input v-model="editingModel.isLatest" type="checkbox" />
                标记为最新模型
              </label>
            </div>

            <div class="form-group checkbox-group">
              <label>
                <input v-model="editingModel.enabled" type="checkbox" />
                启用此模型
              </label>
            </div>
          </div>

          <footer class="modal-footer">
            <button type="button" @click="isEditing = false" class="btn-secondary">
              取消
            </button>
            <button type="submit" class="btn-primary" :disabled="saving">
              {{ saving ? '保存中...' : '保存' }}
            </button>
          </footer>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.probe-models-page {
  max-width: 1200px;
}

.protocol-sections {
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

.protocol-section h2 {
  margin-bottom: 1rem;
  font-size: 1.25rem;
  font-weight: 600;
}

.models-table {
  width: 100%;
  border-collapse: collapse;
  border: 1px solid var(--hub-line);
  border-radius: 8px;
  overflow: hidden;
  background: var(--hub-solid-surface);
}

.models-table th,
.models-table td {
  padding: 12px;
  text-align: left;
  border-bottom: 1px solid var(--hub-line-row);
}

.models-table th {
  background: var(--hub-solid-surface-hover);
  font-weight: 600;
  font-size: 0.85rem;
  color: var(--hub-text-muted);
}

.models-table tbody tr:hover {
  background: var(--hub-solid-surface-hover);
}

.models-table tbody tr:last-child td {
  border-bottom: none;
}

.models-table code {
  padding: 2px 6px;
  background: var(--hub-code-bg);
  border-radius: 3px;
  font-size: 0.85em;
}

.priority-cell {
  font-weight: 600;
  font-family: var(--font-mono);
}

.actions-cell {
  display: flex;
  gap: 8px;
}

.badge {
  display: inline-block;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 500;
}

.badge-success {
  background: rgba(34, 197, 94, 0.1);
  color: #22c55e;
}

.badge-secondary {
  background: var(--hub-solid-surface-hover);
  color: var(--hub-text-muted);
}

.empty-state,
.loading-state {
  padding: 3rem;
  text-align: center;
  color: var(--hub-text-muted);
  border: 1px solid var(--hub-line);
  border-radius: 8px;
  background: var(--hub-solid-surface);
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
}

.modal-content {
  background: var(--hub-solid-surface);
  border: 1px solid var(--hub-line);
  border-radius: 8px;
  width: 100%;
  max-width: 600px;
  max-height: 90vh;
  overflow: auto;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.5rem;
  border-bottom: 1px solid var(--hub-line-row);
}

.modal-header h3 {
  margin: 0;
  font-size: 1.25rem;
}

.modal-body {
  padding: 1.5rem;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.form-group.full-width {
  grid-column: 1 / -1;
}

.form-group label {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--hub-text);
}

.form-group .required {
  color: #ef4444;
}

.form-group .help-text {
  font-weight: 400;
  color: var(--hub-text-faint);
  font-size: 0.8em;
}

.form-group input,
.form-group select {
  padding: 8px 12px;
  border: 1px solid var(--hub-line);
  border-radius: 4px;
  background: var(--hub-input-bg);
  color: var(--hub-text);
  font-size: 0.9rem;
}

.form-group input:focus,
.form-group select:focus {
  outline: none;
  border-color: var(--hub-primary);
}

.checkbox-group label {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.checkbox-group input[type="checkbox"] {
  width: auto;
  margin: 0;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding-top: 1rem;
  border-top: 1px solid var(--hub-line-row);
}

.btn-icon {
  padding: 6px;
  border: none;
  background: transparent;
  color: var(--hub-text-muted);
  cursor: pointer;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.btn-icon:hover {
  background: var(--hub-solid-surface-hover);
  color: var(--hub-text);
}

.btn-icon.btn-danger:hover {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.btn-secondary {
  padding: 8px 16px;
  border: 1px solid var(--hub-line);
  border-radius: 4px;
  background: transparent;
  color: var(--hub-text);
  cursor: pointer;
  font-size: 0.9rem;
  transition: all 0.2s;
}

.btn-secondary:hover {
  background: var(--hub-solid-surface-hover);
}

.btn-primary {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  background: var(--hub-primary);
  color: white;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 500;
  transition: all 0.2s;
}

.btn-primary:hover:not(:disabled) {
  background: var(--hub-primary-hover);
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
