<script setup lang="ts">
type TrendMode = 'requests' | 'tokens' | 'cost'
type TrendPoint = { timestamp: number; requests: number; tokens: number; cost: number }
type PlotPoint = TrendPoint & { value: number; x: number; y: number; valid: boolean }

const props = defineProps<{ points: TrendPoint[]; mode: TrendMode }>()

const chartElement = ref<HTMLElement | null>(null)
const selectedIndex = ref<number | null>(null)
const chartWidth = ref(1000)
const height = 280
const margin = { top: 18, right: 18, bottom: 42, left: 58 }
const plotWidth = computed(() => chartWidth.value - margin.left - margin.right)
const plotHeight = height - margin.top - margin.bottom
let resizeObserver: ResizeObserver | null = null

function valueFor(point: TrendPoint) {
  if (props.mode === 'tokens') return point.tokens
  if (props.mode === 'cost') return point.cost
  return point.requests
}

const plotted = computed<PlotPoint[]>(() => {
  const values = props.points.map(valueFor).filter(Number.isFinite)
  const maximum = Math.max(1, ...values)
  return props.points.map((point, index) => {
    const value = valueFor(point)
    const valid = Number.isFinite(value)
    return {
      ...point,
      value,
      valid,
      x: margin.left + (props.points.length <= 1 ? plotWidth.value / 2 : index / (props.points.length - 1) * plotWidth.value),
      y: valid ? margin.top + plotHeight - Math.max(0, value) / maximum * plotHeight : margin.top + plotHeight
    }
  })
})

const segments = computed(() => {
  const result: PlotPoint[][] = []
  let current: PlotPoint[] = []
  plotted.value.forEach((point) => {
    if (point.valid) current.push(point)
    else if (current.length) {
      result.push(current)
      current = []
    }
  })
  if (current.length) result.push(current)
  return result
})

const maximum = computed(() => Math.max(1, ...plotted.value.filter(point => point.valid).map(point => point.value)))
const ticks = computed(() => Array.from({ length: 4 }, (_, index) => {
  const ratio = index / 3
  return {
    value: maximum.value * (1 - ratio),
    y: margin.top + plotHeight * ratio
  }
}))

const labelIndexes = computed(() => {
  const count = plotted.value.length
  if (count <= 8) return plotted.value.map((_, index) => index)
  return Array.from(new Set(Array.from({ length: 8 }, (_, index) => Math.round(index * (count - 1) / 7))))
})

function linePath(points: PlotPoint[]) {
  if (!points.length) return ''
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`
  let path = `M ${points[0]!.x} ${points[0]!.y}`
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[Math.max(0, index - 1)]!
    const current = points[index]!
    const next = points[index + 1]!
    const after = points[Math.min(points.length - 1, index + 2)]!
    const cp1x = current.x + (next.x - previous.x) / 6
    const cp1y = current.y + (next.y - previous.y) / 6
    const cp2x = next.x - (after.x - current.x) / 6
    const cp2y = next.y - (after.y - current.y) / 6
    path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${next.x} ${next.y}`
  }
  return path
}

function areaPath(points: PlotPoint[]) {
  if (!points.length) return ''
  const baseline = margin.top + plotHeight
  return `${linePath(points)} L ${points.at(-1)!.x} ${baseline} L ${points[0]!.x} ${baseline} Z`
}

function formatValue(value: number) {
  if (props.mode === 'cost') return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 4 : 2 }).format(value)
  return new Intl.NumberFormat('zh-CN', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

function timeLabel(value: number) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).format(value)
}

function selectNearest(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  const index = Math.round(ratio * Math.max(0, plotted.value.length - 1))
  selectedIndex.value = plotted.value[index]?.valid ? index : null
}

const selected = computed(() => selectedIndex.value === null ? null : plotted.value[selectedIndex.value] || null)

onMounted(() => {
  resizeObserver = new ResizeObserver(([entry]) => {
    if (entry) chartWidth.value = Math.max(320, Math.round(entry.contentRect.width))
  })
  if (chartElement.value) resizeObserver.observe(chartElement.value)
})

onBeforeUnmount(() => resizeObserver?.disconnect())
</script>

<template>
  <div ref="chartElement" class="trend-chart" @pointermove="selectNearest" @pointerleave="selectedIndex = null">
    <svg :viewBox="`0 0 ${chartWidth} ${height}`" role="img" aria-label="请求趋势折线图">
      <defs>
        <linearGradient id="hub-trend-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--hub-chart-area-start)" />
          <stop offset="1" stop-color="var(--hub-chart-area-end)" />
        </linearGradient>
      </defs>
      <g class="trend-chart__grid">
        <g v-for="tick in ticks" :key="tick.y">
          <line :x1="margin.left" :x2="chartWidth - margin.right" :y1="tick.y" :y2="tick.y" />
          <text :x="margin.left - 12" :y="tick.y + 4">{{ formatValue(tick.value) }}</text>
        </g>
      </g>
      <path v-for="(segment, index) in segments" :key="`area-${index}`" class="trend-chart__area" :d="areaPath(segment)" />
      <path v-for="(segment, index) in segments" :key="`line-${index}`" class="trend-chart__line" :d="linePath(segment)" />
      <g class="trend-chart__labels">
        <text v-for="index in labelIndexes" :key="index" :x="plotted[index]!.x" :y="height - 13" text-anchor="middle">{{ timeLabel(plotted[index]!.timestamp) }}</text>
      </g>
      <g class="trend-chart__points">
        <circle
          v-for="(point, index) in plotted.filter(item => item.valid)"
          :key="point.timestamp"
          :cx="point.x"
          :cy="point.y"
          r="4"
          tabindex="0"
          :aria-label="`${timeLabel(point.timestamp)}，${formatValue(point.value)}`"
          @focus="selectedIndex = plotted.indexOf(point)"
          @blur="selectedIndex = null"
          @pointerenter="selectedIndex = plotted.indexOf(point)"
        />
      </g>
      <g v-if="selected" class="trend-chart__guide">
        <line :x1="selected.x" :x2="selected.x" :y1="margin.top" :y2="margin.top + plotHeight" />
        <circle :cx="selected.x" :cy="selected.y" r="5" />
      </g>
    </svg>
    <div v-if="selected" class="trend-chart__tooltip" :style="{ left: `${selected.x / chartWidth * 100}%`, top: `${selected.y / height * 100}%` }">
      <strong>{{ formatValue(selected.value) }}</strong>
      <span>{{ timeLabel(selected.timestamp) }}</span>
    </div>
  </div>
</template>

<style scoped>
.trend-chart { position: relative; min-width: 0; height: 280px; overflow: hidden; touch-action: pan-y; }
.trend-chart svg { width: 100%; height: 100%; display: block; overflow: visible; }
.trend-chart__grid line { stroke: var(--hub-chart-grid); stroke-width: 1; vector-effect: non-scaling-stroke; }
.trend-chart text { fill: var(--hub-text-faint); font-family: var(--hub-font-mono); font-size: 10px; }
.trend-chart__area { fill: url(#hub-trend-area); }
.trend-chart__line { fill: none; stroke: var(--hub-chart-line); stroke-linecap: round; stroke-linejoin: round; stroke-width: 2.25; vector-effect: non-scaling-stroke; }
.trend-chart__points circle { fill: var(--hub-solid-surface); stroke: var(--hub-chart-line); stroke-width: 1.75; vector-effect: non-scaling-stroke; cursor: crosshair; }
.trend-chart__points circle:not(:hover):not(:focus) { opacity: .78; }
.trend-chart__guide line { stroke: var(--hub-accent-line); stroke-dasharray: 3 4; stroke-width: 1; vector-effect: non-scaling-stroke; }
.trend-chart__guide circle { fill: var(--hub-chart-line); stroke: var(--hub-solid-surface); stroke-width: 2; vector-effect: non-scaling-stroke; }
.trend-chart__tooltip { position: absolute; z-index: var(--hub-z-tooltip); min-width: 96px; padding: 7px 9px; border: 1px solid var(--hub-line-strong); border-radius: var(--hub-radius-md); display: grid; gap: 2px; color: var(--hub-text); background: var(--hub-tooltip-bg); box-shadow: var(--hub-panel-shadow); pointer-events: none; transform: translate(-50%, calc(-100% - 10px)); }
.trend-chart__tooltip strong { font-family: var(--hub-font-mono); font-size: var(--hub-text-xs); }
.trend-chart__tooltip span { color: var(--hub-text-faint); font-size: var(--hub-text-micro); }
@media (max-width: 720px) { .trend-chart { height: 232px; } }
</style>
