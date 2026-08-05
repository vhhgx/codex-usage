import { sql } from 'drizzle-orm'
import { useDatabase } from '../db'
import { checkObjectStorage } from '../utils/object-storage'
import { useRedis } from '../utils/redis'

export default defineEventHandler(async (event) => {
  try {
    await Promise.all([
      useDatabase(event).execute(sql`select 1`),
      useRedis(event).ping(),
      checkObjectStorage(event)
    ])
    return { status: 'ok' }
  } catch {
    setResponseStatus(event, 503)
    return { status: 'unavailable' }
  }
})
