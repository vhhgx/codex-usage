<script setup lang="ts">
import { IconAlertTriangle } from '@tabler/icons-vue'

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  confirmTone?: 'primary' | 'danger'
  busyLabel?: string
  busy?: boolean
}>(), { confirmLabel: '确认删除', confirmTone: 'danger', busyLabel: '处理中', busy: false })
const emit = defineEmits<{ close: []; confirm: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const headingId = useId()

function onCancel(event: Event) {
  event.preventDefault()
  if (!props.busy) emit('close')
}

function onDialogClose() {
  // A native Escape/cancel event can still close a dialog while an async
  // operation is in flight. Keep the confirmation surface mounted until the
  // operation reports completion.
  if (props.open && props.busy) {
    nextTick(() => { if (dialog.value && !dialog.value.open) dialog.value.showModal() })
    return
  }
  emit('close')
}

watch(() => props.open, (open) => {
  if (!import.meta.client) return
  nextTick(() => {
    if (open && dialog.value && !dialog.value.open) dialog.value.showModal()
    if (!open && dialog.value?.open) dialog.value.close()
  })
}, { immediate: true })
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="confirm-dialog" role="alertdialog" :aria-labelledby="headingId" @cancel="onCancel" @close="onDialogClose">
      <form method="dialog" @submit.prevent>
        <span class="confirm-dialog__icon" :class="`confirm-dialog__icon--${confirmTone}`"><IconAlertTriangle :size="22" /></span>
        <div>
          <h2 :id="headingId">{{ title }}</h2>
          <p>{{ message }}</p>
        </div>
        <footer>
          <button type="button" class="button button--secondary" :disabled="busy" @click="emit('close')">取消</button>
          <button type="button" class="button" :class="confirmTone === 'primary' ? 'button--primary' : 'button--danger'" :disabled="busy" @click="emit('confirm')">{{ busy ? busyLabel : confirmLabel }}</button>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>
