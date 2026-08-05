import { timingSafeEqual } from 'node:crypto'
import { renderPrometheusMetrics } from '../services/hub-observability'

function matches(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export default defineEventHandler(async (event) => {
  const configured = String(useRuntimeConfig(event).metricsToken || '')
  const supplied = (getHeader(event, 'authorization') || '').replace(/^Bearer\s+/i, '')
  if (!configured) throw createError({ statusCode: 503, message: 'Metrics endpoint is not configured' })
  if (!matches(configured, supplied)) throw createError({ statusCode: 401, message: 'Invalid metrics token' })
  setResponseHeader(event, 'content-type', 'text/plain; version=0.0.4; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'no-store')
  return renderPrometheusMetrics(event)
})
