import { timingSafeEqual } from 'node:crypto'
import { getDrainState, setDrainState } from '../../services/hub-traffic'

function authorized(event: Parameters<typeof getHeader>[0]) {
  const expected = Buffer.from(String(useRuntimeConfig(event).operationsToken || ''))
  const actual = Buffer.from((getHeader(event, 'authorization') || '').replace(/^Bearer\s+/i, ''))
  return expected.length >= 32 && expected.length === actual.length && timingSafeEqual(expected, actual)
}

export default defineEventHandler(async (event) => {
  if (!authorized(event)) throw createError({ statusCode: 401, message: 'Invalid operations token' })
  if (event.method === 'GET') return getDrainState(event)
  if (event.method !== 'POST') throw createError({ statusCode: 405, message: 'Method not allowed' })
  const body = await readBody<{ enabled?: boolean; ttlSeconds?: number; reason?: string }>(event) || {}
  return setDrainState(event, body.enabled === true, body)
})
