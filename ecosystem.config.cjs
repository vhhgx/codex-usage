const path = require('node:path')

const rootDir = __dirname

module.exports = {
  apps: [
    {
      name: 'zephyr-console',
      cwd: rootDir,
      script: path.join(rootDir, '.output/server/index.mjs'),
      interpreter: 'node',
      node_args: `--env-file=${path.join(rootDir, '.env')}`,
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
