<script setup lang="ts">
import { IconAlertTriangle } from '@tabler/icons-vue'

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  busy?: boolean
}>(), { confirmLabel: '确认删除', busy: false })
const emit = defineEmits<{ close: []; confirm: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const headingId = useId()

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
    <dialog ref="dialog" class="confirm-dialog" role="alertdialog" :aria-labelledby="headingId" @cancel.prevent="emit('close')" @close="emit('close')">
      <form method="dialog" @submit.prevent>
        <span class="confirm-dialog__icon"><IconAlertTriangle :size="22" /></span>
        <div>
          <h2 :id="headingId">{{ title }}</h2>
          <p>{{ message }}</p>
        </div>
        <footer>
          <button type="button" class="button button--secondary" :disabled="busy" @click="emit('close')">取消</button>
          <button type="button" class="button button--danger" :disabled="busy" @click="emit('confirm')">{{ busy ? '处理中' : confirmLabel }}</button>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>
