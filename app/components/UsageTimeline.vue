<script setup lang="ts">
import type { UserUsageTimelinePoint } from '#shared/types/usage'

const props = defineProps<{ points: UserUsageTimelinePoint[] }>()

const maxTokens = computed(() => Math.max(1, ...props.points.map((point) => point.totalTokens)))

function height(value: number) {
  return `${Math.max(5, (value / maxTokens.value) * 100)}%`
}

function compact(value: number) {
  const absolute = Math.abs(value)
  const format = (divisor: number, suffix: string) => {
    const scaled = value / divisor
    const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2
    return `${scaled.toFixed(digits).replace(/\.0+$|(?<=\.[0-9])0+$/, '')}${suffix}`
  }
  if (absolute >= 1_000_000_000) return format(1_000_000_000, 'B')
  if (absolute >= 1_000_000) return format(1_000_000, 'M')
  if (absolute >= 1_000) return format(1_000, 'K')
  return String(value)
}
</script>

<template>
  <div v-if="points.length" class="timeline" aria-label="Token 用量趋势">
    <div class="timeline__plot">
      <div v-for="point in points" :key="`${point.timestamp}-${point.label}`" class="timeline__column">
        <span class="timeline__value">{{ compact(point.totalTokens) }}</span>
        <div class="timeline__bar-wrap">
          <span class="timeline__bar" :style="{ height: height(point.totalTokens) }" />
        </div>
        <span class="timeline__label">{{ point.label }}</span>
      </div>
    </div>
  </div>
  <div v-else class="chart-empty">当前时间范围没有可展示的趋势数据</div>
</template>
