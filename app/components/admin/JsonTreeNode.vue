<script setup lang="ts">
import { IconChevronDown, IconChevronRight } from '@tabler/icons-vue'
import { base64ByteLength, formatByteSize, isImageBase64Key } from '#shared/utils/admin-log-view'

defineOptions({ name: 'JsonTreeNode' })
const props = withDefaults(defineProps<{
  value: unknown
  nodeKey?: string | number
  depth?: number
}>(), { nodeKey: undefined, depth: 0 })

const expanded = ref(props.depth === 0)
const stringExpanded = ref(false)
const isArray = computed(() => Array.isArray(props.value))
const isContainer = computed(() => props.value !== null && typeof props.value === 'object')
const entries = computed(() => isContainer.value ? Object.entries(props.value as Record<string, unknown>) : [])
const opening = computed(() => isArray.value ? '[' : '{')
const closing = computed(() => isArray.value ? ']' : '}')
const typeClass = computed(() => props.value === null ? 'null' : typeof props.value)
const isImageBase64 = computed(() => typeof props.value === 'string' && (
  isImageBase64Key(props.nodeKey) || /^data:image\/[a-z0-9.+-]+;base64,/i.test(props.value)
))
const displayValue = computed(() => {
  if (typeof props.value === 'string') {
    if (isImageBase64.value) return `"Base64 图片 · ${formatByteSize(base64ByteLength(props.value))}"`
    if (!stringExpanded.value && props.value.length > 240) return `${JSON.stringify(props.value.slice(0, 240))}…`
  }
  return JSON.stringify(props.value)
})
</script>

<template>
  <div class="json-tree-node" :data-depth="depth">
    <div class="json-tree-line">
      <button v-if="isContainer" class="json-tree-toggle" type="button" :aria-label="expanded ? '收起' : '展开'" @click="expanded = !expanded">
        <IconChevronDown v-if="expanded" :size="13" />
        <IconChevronRight v-else :size="13" />
      </button>
      <span v-else class="json-tree-spacer" />
      <span v-if="nodeKey !== undefined" class="json-tree-key">{{ nodeKey }}:</span>
      <template v-if="isContainer">
        <span class="json-tree-bracket">{{ opening }}</span>
        <button v-if="!expanded" class="json-tree-summary" type="button" @click="expanded = true">{{ entries.length }} 项</button>
        <span v-if="!expanded" class="json-tree-bracket">{{ closing }}</span>
      </template>
      <template v-else>
        <button v-if="typeof value === 'string' && value.length > 240 && !isImageBase64" class="json-tree-value json-tree-value--expandable" :data-type="typeClass" type="button" @click="stringExpanded = !stringExpanded">{{ displayValue }}</button>
        <span v-else class="json-tree-value" :data-type="typeClass">{{ displayValue }}</span>
      </template>
    </div>
    <template v-if="isContainer && expanded">
      <div class="json-tree-children">
        <JsonTreeNode v-for="([key, child]) in entries" :key="key" :value="child" :node-key="isArray ? Number(key) : key" :depth="depth + 1" />
      </div>
      <div class="json-tree-line json-tree-closing"><span class="json-tree-spacer" /><span class="json-tree-bracket">{{ closing }}</span></div>
    </template>
  </div>
</template>
