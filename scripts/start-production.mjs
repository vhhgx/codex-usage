import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Load the same deployment env used by Compose when this script is started
// directly. Explicit process variables still take precedence.
if (typeof process.loadEnvFile === 'function') {
  const rootDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
  const configured = process.env.HUB_ENV_FILE
  const candidate = configured
    ? resolve(rootDir, configured)
    : existsSync(resolve(rootDir, '.env'))
      ? resolve(rootDir, '.env')
      : resolve(rootDir, 'deploy/hong-kong/.env')
  if (existsSync(candidate)) process.loadEnvFile(candidate)
}

// Run database migrations before handing the process over to Nitro. This keeps
// bare Node and PM2 deployments aligned with the Docker entrypoint.
await import('./migrate.mjs')
await import('../.output/server/index.mjs')
