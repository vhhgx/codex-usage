const fs = require('node:fs')
const path = require('node:path')

const rootDir = __dirname
const defaultEnvFile = fs.existsSync(path.join(rootDir, '.env'))
  ? path.join(rootDir, '.env')
  : path.join(rootDir, 'deploy/hong-kong/.env')
const envFile = path.resolve(rootDir, process.env.HUB_ENV_FILE || defaultEnvFile)

module.exports = {
  apps: [
    {
      name: 'zephyr-console',
      cwd: rootDir,
      script: path.join(rootDir, 'scripts/start-production.mjs'),
      interpreter: 'node',
      node_args: `--env-file=${envFile}`,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: 8371,
        NITRO_HOST: '0.0.0.0',
        NITRO_PORT: 8371,
      },
    },
  ],
}
