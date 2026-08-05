import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.NUXT_DATABASE_URL || 'postgres://zephyr:zephyr@127.0.0.1:5432/zephyr_hub'
  },
  strict: true,
  verbose: true
})
