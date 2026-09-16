<script setup lang="ts">
import { IconEye, IconEyeOff } from '@tabler/icons-vue'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  modelValue: string
  secretLabel?: string
  visibleType?: 'text' | 'url'
}>(), {
  secretLabel: '密钥',
  visibleType: 'text'
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const attrs = useAttrs()
const visible = ref(false)
const disabled = computed(() => attrs.disabled === '' || attrs.disabled === true)
const actionLabel = computed(() => `${visible.value ? '隐藏' : '显示'}${props.secretLabel}`)

function update(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <span class="app-secret-input">
    <input
      v-bind="$attrs"
      :value="modelValue"
      :type="visible ? visibleType : 'password'"
      @input="update"
    >
    <button
      type="button"
      class="icon-button app-secret-input__toggle"
      :title="actionLabel"
      :aria-label="actionLabel"
      :aria-pressed="visible"
      :disabled="disabled"
      @click="visible = !visible"
    >
      <IconEyeOff v-if="visible" :size="16" :stroke-width="1.8" />
      <IconEye v-else :size="16" :stroke-width="1.8" />
    </button>
  </span>
</template>

<style scoped>
.app-secret-input {
  position: relative;
  display: block;
  min-width: 0;
}

.app-secret-input input {
  width: 100%;
  padding-right: 2.75rem;
}

.app-secret-input__toggle {
  position: absolute;
  top: 50%;
  right: 0.3rem;
  width: 30px;
  height: 30px;
  border: 0;
  background: transparent;
  transform: translateY(-50%);
}
</style>
