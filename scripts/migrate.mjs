import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const databaseUrl = String(process.env.NUXT_DATABASE_URL || '').trim()
if (!databaseUrl) throw new Error('NUXT_DATABASE_URL is required')

const client = postgres(databaseUrl, { max: 1 })
try {
  const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
  await migrate(drizzle(client), { migrationsFolder })
  console.log('Database migrations completed')
} finally {
  await client.end()
}
