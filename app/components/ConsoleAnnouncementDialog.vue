<script setup lang="ts">
import {
  IconAlertTriangle,
  IconBell,
  IconChevronLeft,
  IconChevronRight,
  IconCircleCheck,
  IconX
} from '@tabler/icons-vue'

interface Announcement {
  id: string
  title: string
  content: string
  tone: 'info' | 'warning' | 'success'
  publishedAt: number | null
}

const props = defineProps<{
  open: boolean
  announcements: Announcement[]
}>()
const emit = defineEmits<{ close: []; dismissToday: [] }>()
const dialog = useTemplateRef<HTMLDialogElement>('dialog')
const index = ref(0)
const headingId = useId()
const contentId = useId()
const current = computed(() => props.announcements[index.value] || null)
const toneLabel = computed(() => current.value?.tone === 'warning' ? '重要提醒' : current.value?.tone === 'success' ? '完成通知' : '系统公告')
const toneIcon = computed(() => current.value?.tone === 'warning' ? IconAlertTriangle : current.value?.tone === 'success' ? IconCircleCheck : IconBell)

watch(() => props.open, (open) => {
  if (!import.meta.client) return
  nextTick(() => {
    if (open && dialog.value && !dialog.value.open) {
      index.value = 0
      dialog.value.showModal()
    }
    if (!open && dialog.value?.open) dialog.value.close()
  })
}, { immediate: true })

watch(() => props.announcements.length, (length) => {
  index.value = Math.min(index.value, Math.max(0, length - 1))
})
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="announcement-dialog"
      :aria-labelledby="headingId"
      :aria-describedby="contentId"
      @cancel.prevent="emit('close')"
    >
      <article v-if="current" class="announcement-dialog__panel" :data-tone="current.tone">
        <header>
          <span class="announcement-dialog__icon"><component :is="toneIcon" :size="22" /></span>
          <div>
            <small>{{ toneLabel }}</small>
            <h2 :id="headingId">{{ current.title }}</h2>
          </div>
          <button type="button" class="icon-button" title="关闭公告" aria-label="关闭公告" @click="emit('close')">
            <IconX :size="18" />
          </button>
        </header>

        <div :id="contentId" class="announcement-dialog__content">
          <p>{{ current.content }}</p>
        </div>

        <footer>
          <div v-if="announcements.length > 1" class="announcement-dialog__pager">
            <button type="button" class="button button--secondary button--small" :disabled="index === 0" @click="index--">
              <IconChevronLeft :size="16" />上一条
            </button>
            <span>{{ index + 1 }} / {{ announcements.length }}</span>
            <button type="button" class="button button--secondary button--small" :disabled="index === announcements.length - 1" @click="index++">
              下一条<IconChevronRight :size="16" />
            </button>
          </div>
          <div class="announcement-dialog__actions">
            <button type="button" class="button button--quiet button--small" @click="emit('dismissToday')">今日不再显示</button>
            <button type="button" class="button button--primary button--small" @click="emit('close')">关闭</button>
          </div>
        </footer>
      </article>
    </dialog>
  </Teleport>
</template>
