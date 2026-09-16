<!-- 协议探测功能组件 -->
<script setup lang="ts">
import { IconRefresh, IconCheck, IconX, IconLoader } from '@tabler/icons-vue'

interface ProbeTask {
  taskId: string
  channelId: string
  channelName: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  startedAt: number
  completedAt?: number
  progress: {
    current: number
    total: number
    currentProtocol?: string
  }
  results: {
    protocol: string
    status: 'success' | 'failed' | 'pending'
    testedModel?: string
    error?: string
  }[]
}

const props = defineProps<{
  channelId: string
  channelName: string
}>()

const emit = defineEmits<{
  complete: []
}>()

const toast = useAppToast()
const probing = ref(false)
const task = ref<ProbeTask | null>(null)
let pollTimer: ReturnType<typeof setTimeout> | null = null
let pollAttempts = 0
const MAX_POLL_ATTEMPTS = 60 // 60秒

async function startProbe() {
  try {
    probing.value = true
    const result = await $fetch<{ taskId: string }>(`/api/console/channels/${props.channelId}/probe`, {
      method: 'POST'
    })

    task.value = {
      taskId: result.taskId,
      channelId: props.channelId,
      channelName: props.channelName,
      status: 'pending',
      startedAt: Date.now(),
      progress: { current: 0, total: 3 },
      results: [
        { protocol: 'anthropic_messages', status: 'pending' },
        { protocol: 'openai_responses', status: 'pending' },
        { protocol: 'openai_chat', status: 'pending' }
      ]
    }

    toast.show('协议探测已启动', 'info')
    pollAttempts = 0
    pollStatus()
  } catch (error: any) {
    toast.show(error?.data?.message || '启动探测失败', 'error')
    probing.value = false
  }
}

async function pollStatus() {
  if (!task.value) return

  try {
    const result = await $fetch<ProbeTask>(`/api/console/channels/probe-status/${task.value.taskId}`)
    task.value = result

    if (result.status === 'completed' || result.status === 'failed') {
      probing.value = false
      const successCount = result.results.filter(r => r.status === 'success').length

      if (successCount > 0) {
        toast.show(`探测完成！发现 ${successCount} 个可用协议`, 'success')
      } else {
        toast.show('探测完成，但所有协议都不可用', 'warning')
      }

      emit('complete')
      return
    }

    pollAttempts++
    if (pollAttempts < MAX_POLL_ATTEMPTS) {
      pollTimer = setTimeout(pollStatus, 1000)
    } else {
      toast.show('探测超时', 'error')
      probing.value = false
    }
  } catch (error) {
    console.error('轮询探测状态失败:', error)
    probing.value = false
  }
}

onUnmounted(() => {
  if (pollTimer) clearTimeout(pollTimer)
})

const protocolLabels: Record<string, string> = {
  'anthropic_messages': 'Messages',
  'openai_responses': 'Responses',
  'openai_chat': 'Chat'
}
</script>

<template>
  <div class="probe-widget">
    <button
      v-if="!probing"
      @click="startProbe"
      class="btn-probe"
      type="button"
    >
      <IconRefresh :size="16" />
      探测协议
    </button>

    <div v-else class="probe-status">
      <div class="probe-header">
        <IconLoader :size="16" class="spinning" />
        <span>探测中 {{ task?.progress.current }}/{{ task?.progress.total }}</span>
      </div>

      <div v-if="task" class="probe-results">
        <div
          v-for="result in task.results"
          :key="result.protocol"
          class="probe-result"
          :data-status="result.status"
        >
          <IconLoader v-if="result.status === 'pending'" :size="14" class="spinning" />
          <IconCheck v-else-if="result.status === 'success'" :size="14" />
          <IconX v-else :size="14" />

          <span class="protocol-name">{{ protocolLabels[result.protocol] }}</span>

          <span v-if="result.testedModel" class="tested-model">
            ({{ result.testedModel }})
          </span>

          <span v-if="result.error" class="error-message" :title="result.error">
            {{ result.error }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.probe-widget {
  display: inline-block;
}

.btn-probe {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--hub-line);
  border-radius: 4px;
  background: var(--hub-solid-surface);
  color: var(--hub-text);
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-probe:hover {
  background: var(--hub-solid-surface-hover);
  border-color: var(--hub-line-hover);
}

.probe-status {
  padding: 8px 12px;
  border: 1px solid var(--hub-line);
  border-radius: 4px;
  background: var(--hub-solid-surface);
}

.probe-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 0.85rem;
  color: var(--hub-text-muted);
}

.probe-results {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.probe-result {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-size: 0.8rem;
}

.probe-result[data-status="success"] {
  color: #22c55e;
}

.probe-result[data-status="failed"] {
  color: #ef4444;
}

.probe-result[data-status="pending"] {
  color: var(--hub-text-muted);
}

.protocol-name {
  font-weight: 500;
}

.tested-model {
  color: var(--hub-text-faint);
  font-size: 0.75rem;
}

.error-message {
  color: var(--hub-text-faint);
  font-size: 0.75rem;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
