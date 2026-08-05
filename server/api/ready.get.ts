import { sql } from 'drizzle-orm'
import { useDatabase } from '../db'
import { useRedis } from '../utils/redis'
import { getDrainState } from '../services/hub-traffic'

export default defineEventHandler(async (event) => {
  try {
    const [drain] = await Promise.all([
      getDrainState(event),
      useDatabase(event).execute(sql`select 1`),
      useRedis(event).ping()
    ])
    if (drain.enabled) {
      setResponseStatus(event, 503)
      return { status: 'draining', activeRequests: drain.activeRequests, expiresAt: drain.expiresAt }
    }
    return { status: 'ready', activeRequests: drain.activeRequests }
  } catch {
    setResponseStatus(event, 503)
    return { status: 'unavailable' }
  }
})
