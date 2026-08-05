<script setup lang="ts">
import JsonTreeNode from './JsonTreeNode.vue'

defineProps<{ value: unknown }>()
</script>

<template>
  <div class="json-tree"><JsonTreeNode :value="value" /></div>
</template>
