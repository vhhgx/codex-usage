<script setup lang="ts">
type TrendMode = 'requests' | 'tokens' | 'cost'
type TrendPoint = { timestamp: number; requests: number; tokens: number; cost: number }
type PlotPoint = TrendPoint & { value: number; x: number; y: number; valid: boolean }

const props = defineProps<{
  points: TrendPoint[]
  mode: TrendMode
  from: number
  to: number
}>()

const selectedIndex = ref<number | null>(null)
const viewBox = { width: 800, height: 280, left: 8, right: 792, top: 14, bottom: 270 }

function valueFor(point: TrendPoint) {
  if (props.mode === 'tokens') return point.tokens
  if (props.mode === 'cost') return point.cost
  return point.requests
}

const maximum = computed(() => Math.max(1, ...props.points.map(valueFor).filter(Number.isFinite)))
const chartMaximum = computed(() => maximum.value * 1.12)
const plotted = computed<PlotPoint[]>(() => {
  const step = props.points.length > 1 ? (viewBox.right - viewBox.left) / (props.points.length - 1) : 0
  return props.points.map((point, index) => {
    const value = valueFor(point)
    const valid = Number.isFinite(value)
    return {
      ...point,
      value,
      valid,
      x: props.points.length === 1 ? (viewBox.left + viewBox.right) / 2 : viewBox.left + step * index,
      y: valid
        ? viewBox.bottom - (Math.max(0, value) / chartMaximum.value) * (viewBox.bottom - viewBox.top)
        : viewBox.bottom
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

const gridLines = computed(() => Array.from({ length: 4 }, (_, index) => (
  viewBox.top + ((viewBox.bottom - viewBox.top) / 3) * index
)))

const yAxis = computed(() => [maximum.value, maximum.value * .66, maximum.value * .33, 0])
const labelIndexes = computed(() => {
  const count = plotted.value.length
  if (count <= 8) return plotted.value.map((_, index) => index)
  return Array.from(new Set(Array.from({ length: 8 }, (_, index) => Math.round(index * (count - 1) / 7))))
})

const selected = computed(() => selectedIndex.value === null ? null : plotted.value[selectedIndex.value] || null)
const selectedLeft = computed(() => selected.value ? `${Math.min(92, Math.max(8, selected.value.x / viewBox.width * 100))}%` : '50%')
const selectedTop = computed(() => selected.value ? `${Math.max(18, selected.value.y / viewBox.height * 100)}%` : '50%')
const peak = computed(() => plotted.value.filter(point => point.valid).reduce<PlotPoint | null>((current, point) => !current || point.value > current.value ? point : current, null))
const average = computed(() => {
  const values = plotted.value.filter(point => point.valid).map(point => point.value)
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
})
const intervalUnit = computed(() => props.to - props.from > 48 * 60 * 60 * 1000 ? 'D' : 'H')

function smoothPath(points: PlotPoint[]) {
  if (!points.length) return ''
  let path = `M ${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!
    const current = points[index]!
    const controlX = (previous.x + current.x) / 2
    path += ` C ${controlX.toFixed(2)} ${previous.y.toFixed(2)}, ${controlX.toFixed(2)} ${current.y.toFixed(2)}, ${current.x.toFixed(2)} ${current.y.toFixed(2)}`
  }
  return path
}

function areaPath(points: PlotPoint[]) {
  if (!points.length) return ''
  return `${smoothPath(points)} L ${points.at(-1)!.x.toFixed(2)} ${viewBox.bottom} L ${points[0]!.x.toFixed(2)} ${viewBox.bottom} Z`
}

function compact(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    notation: Math.abs(value) >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1
  }).format(value)
}

function axisValue(value: number) {
  if (props.mode === 'cost') return `$${compact(value)}`
  return compact(props.mode === 'requests' ? Math.round(value) : value)
}

function chartValue(value: number) {
  if (props.mode === 'cost') return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 4 : 2 }).format(value)
  if (props.mode === 'tokens') return `${compact(value)} Token`
  return `${compact(Math.round(value))} 次`
}

function dateTime(value: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(value)
}

function pointLabel(value: number) {
  const options: Intl.DateTimeFormatOptions = intervalUnit.value === 'D'
    ? { month: '2-digit', day: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', hour12: false }
  return new Intl.DateTimeFormat('zh-CN', options).format(value)
}

function labelAt(index: number) {
  const point = plotted.value[index]
  return point ? pointLabel(point.timestamp) : '--'
}

function selectNearest(event: PointerEvent) {
  if (!plotted.value.length) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  const index = Math.round(ratio * Math.max(0, plotted.value.length - 1))
  selectedIndex.value = plotted.value[index]?.valid ? index : null
}
</script>

<template>
  <div class="chart-panel__body">
    <p class="chart-period">{{ dateTime(from) }} - {{ dateTime(to) }}</p>
    <div class="chart-layout" role="img" aria-label="请求趋势平滑曲线图">
      <div class="chart-y-axis" aria-hidden="true"><span v-for="(tick, index) in yAxis" :key="index">{{ axisValue(tick) }}</span></div>
      <div class="chart-canvas" @pointermove="selectNearest" @pointerleave="selectedIndex = null">
        <div v-if="selected" class="chart-tooltip" role="status" aria-live="polite" :style="{ left: selectedLeft, top: selectedTop }"><span>{{ pointLabel(selected.timestamp) }}</span><strong>{{ chartValue(selected.value) }}</strong></div>
        <svg viewBox="0 0 800 280" preserveAspectRatio="none" aria-hidden="true">
          <defs><linearGradient id="hub-trend-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--hub-chart-area-start)" /><stop offset="100%" stop-color="var(--hub-chart-area-end)" /></linearGradient></defs>
          <g><line v-for="line in gridLines" :key="line" class="chart-grid-line" :x1="viewBox.left" :x2="viewBox.right" :y1="line" :y2="line" /></g>
          <path v-for="(segment, index) in segments" :key="`area-${index}`" class="chart-area" :d="areaPath(segment)" />
          <path v-for="(segment, index) in segments" :key="`line-${index}`" class="chart-line" :d="smoothPath(segment)" />
          <g>
            <circle v-for="(point, index) in plotted" v-show="point.valid" :key="point.timestamp" class="chart-point" :cx="point.x" :cy="point.y" :r="peak?.timestamp === point.timestamp ? 4.2 : 3" tabindex="0" :aria-label="`${pointLabel(point.timestamp)}，${chartValue(point.value)}`" @focus="selectedIndex = index" @blur="selectedIndex = null" />
          </g>
          <line v-if="selected" class="chart-guide" :x1="selected.x" :x2="selected.x" :y1="viewBox.top" :y2="viewBox.bottom" />
          <circle v-if="selected" class="chart-hover-point" :cx="selected.x" :cy="selected.y" r="5" />
        </svg>
      </div>
    </div>
    <div class="chart-labels" :style="{ '--chart-label-count': labelIndexes.length }" aria-hidden="true"><span v-for="index in labelIndexes" :key="index">{{ labelAt(index) }}</span></div>
    <div class="chart-meta"><span class="chart-peak"><i aria-hidden="true" />峰值 {{ peak ? pointLabel(peak.timestamp) : '--' }}，{{ peak ? chartValue(peak.value) : '--' }}</span><span>AVG {{ axisValue(average) }} / {{ intervalUnit }}</span></div>
  </div>
</template>

<style scoped>
.chart-panel__body { padding: var(--hub-space-3) var(--hub-panel-padding) var(--hub-panel-padding); }
.chart-period { margin-bottom: .65rem; color: var(--hub-text-faint); font-family: var(--hub-font-mono); font-size: .71875rem; }
.chart-layout { height: 16.5rem; display: grid; grid-template-columns: 2.4rem minmax(0, 1fr); gap: var(--hub-space-3); }
.chart-y-axis { padding: .45rem 0 .15rem; display: flex; flex-direction: column; justify-content: space-between; color: var(--hub-text-faint); font-family: var(--hub-font-mono); font-size: .72rem; text-align: right; }
.chart-canvas { position: relative; min-width: 0; min-height: 0; touch-action: pan-y; }
.chart-canvas svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; overflow: visible; }
.chart-grid-line { stroke: var(--hub-chart-grid); stroke-width: 1; vector-effect: non-scaling-stroke; }
.chart-area { fill: url(#hub-trend-area); }
.chart-line { fill: none; stroke: var(--hub-chart-line); stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; filter: drop-shadow(0 0 5px var(--hub-accent-soft)); }
.chart-point { fill: var(--hub-solid-surface); stroke: var(--hub-accent-bright); stroke-width: 2; vector-effect: non-scaling-stroke; }
.chart-guide { stroke: var(--hub-accent-line); stroke-width: 1; stroke-dasharray: 3 4; vector-effect: non-scaling-stroke; }
.chart-hover-point { fill: var(--hub-solid-surface-strong); stroke: var(--hub-accent-text); stroke-width: 2.4; vector-effect: non-scaling-stroke; }
.chart-tooltip { position: absolute; z-index: var(--hub-z-tooltip); min-width: 6.5rem; padding: .55rem .65rem; border: 1px solid var(--hub-line-strong); border-radius: var(--hub-radius-lg); display: grid; gap: var(--hub-space-1-5); color: var(--hub-text); background: var(--hub-tooltip-bg); box-shadow: var(--hub-panel-highlight), var(--hub-panel-shadow); pointer-events: none; transform: translate(-50%, calc(-100% - .95rem)); }
.chart-tooltip span { color: var(--hub-text-faint); font-size: .71875rem; }
.chart-tooltip strong { font-family: var(--hub-font-mono); font-size: .78125rem; font-weight: var(--hub-weight-medium); }
.chart-labels { margin-left: 3.15rem; display: grid; grid-template-columns: repeat(var(--chart-label-count), minmax(0, 1fr)); color: var(--hub-text-faint); font-family: var(--hub-font-mono); font-size: .72rem; text-align: center; }
.chart-meta { margin-top: var(--hub-space-4); padding-top: .9rem; border-top: 1px solid var(--hub-line); display: flex; align-items: center; justify-content: space-between; gap: var(--hub-space-4); color: var(--hub-text-faint); font-size: .74rem; }
.chart-meta > span:last-child { font-family: var(--hub-font-mono); }
.chart-peak { display: inline-flex; align-items: center; gap: var(--hub-space-2); }
.chart-peak i { width: .4rem; height: .4rem; border-radius: var(--hub-radius-round); background: var(--hub-success); box-shadow: 0 0 0 3px var(--hub-success-soft); }
@media (max-width: 720px) { .chart-layout { height: 14rem; } .chart-labels span:nth-child(even) { display: none; } .chart-meta { align-items: flex-start; flex-direction: column; gap: var(--hub-space-2); } }
</style>
