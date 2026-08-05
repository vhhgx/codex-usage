<script setup lang="ts">
import type { UserUsageTimelinePoint } from '#shared/types/usage'
import { formatTokenCount } from '#shared/utils/number-format'

const props = defineProps<{ points: UserUsageTimelinePoint[] }>()

const maxTokens = computed(() => Math.max(1, ...props.points.map((point) => point.totalTokens)))

function height(value: number) {
  return `${Math.max(5, (value / maxTokens.value) * 100)}%`
}

</script>

<template>
  <div v-if="points.length" class="timeline" aria-label="Token 用量趋势">
    <div class="timeline__plot">
      <div v-for="point in points" :key="`${point.timestamp}-${point.label}`" class="timeline__column">
        <span class="timeline__value">{{ formatTokenCount(point.totalTokens) }}</span>
        <div class="timeline__bar-wrap">
          <span class="timeline__bar" :style="{ height: height(point.totalTokens) }" />
        </div>
        <span class="timeline__label">{{ point.label }}</span>
      </div>
    </div>
  </div>
  <div v-else class="chart-empty">当前时间范围没有可展示的趋势数据</div>
</template>
