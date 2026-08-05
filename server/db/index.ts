import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './schema'

let client: ReturnType<typeof postgres> | null = null
let database: ReturnType<typeof drizzle<typeof schema>> | null = null

export function useDatabase(event?: Parameters<typeof useRuntimeConfig>[0]) {
  const transaction = event && typeof event === 'object'
    ? (event as { context?: { hubDatabaseTransaction?: ReturnType<typeof drizzle<typeof schema>> } }).context?.hubDatabaseTransaction
    : undefined
  if (transaction) return transaction
  if (database) return database
  const config = useRuntimeConfig(event)
  const url = String(config.databaseUrl || '').trim()
  if (!url) {
    throw createError({ statusCode: 503, message: '未配置 NUXT_DATABASE_URL' })
  }
  client = postgres(url, { max: 10, idle_timeout: 20, connect_timeout: 10 })
  database = drizzle(client, { schema })
  return database
}

export async function withDatabaseTransaction<T>(event: Parameters<typeof useRuntimeConfig>[0], callback: () => Promise<T>) {
  const db = useDatabase(event)
  return db.transaction(async (transaction) => {
    const context = (event as { context: { hubDatabaseTransaction?: typeof transaction } }).context
    const previous = context.hubDatabaseTransaction
    context.hubDatabaseTransaction = transaction
    try {
      return await callback()
    } finally {
      context.hubDatabaseTransaction = previous
    }
  })
}

export async function closeDatabase() {
  await client?.end()
  client = null
  database = null
}
