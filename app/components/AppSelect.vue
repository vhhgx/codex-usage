<script setup lang="ts">
import { IconChevronDown } from '@tabler/icons-vue'

defineOptions({ inheritAttrs: false })

const model = defineModel<any>()
const attrs = useAttrs()
const multiple = computed(() => attrs.multiple !== undefined && attrs.multiple !== false)
</script>

<template>
  <span class="app-select" :class="{ 'app-select--multiple': multiple, 'app-select--disabled': attrs.disabled }">
    <select v-model="model" v-bind="attrs">
      <slot />
    </select>
    <IconChevronDown v-if="!multiple" class="app-select__icon" :size="16" :stroke-width="1.8" aria-hidden="true" />
  </span>
</template>
