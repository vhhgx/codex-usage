import { checkAllChannels } from '../services/channel-health'
import { runHubMaintenance } from '../services/hub-maintenance'
import { evaluateHubAlerts } from '../services/hub-alerts'

export default defineNitroPlugin((nitroApp) => {
  const run = async () => {
    try {
      const config = useRuntimeConfig()
      if (!config.databaseUrl) return
      const result = await runHubMaintenance()
      if (result.bodyCleanupError) console.error('[hub-body-cleanup]', result.bodyCleanupError)
    } catch (error) {
      console.error('[hub-maintenance]', error instanceof Error ? error.message : error)
    }
  }
  const timer = setInterval(run, 15 * 60 * 1000)
  timer.unref()
  const health = async () => {
    if (!useRuntimeConfig().databaseUrl) return
    try {
      await checkAllChannels()
      await evaluateHubAlerts()
    } catch (error) {
      console.error('[hub-health]', error instanceof Error ? error.message : error)
    }
  }
  const healthTimer = setInterval(() => { void health() }, 60 * 1000)
  healthTimer.unref()
  void run()
  if (useRuntimeConfig().databaseUrl) {
    void health()
  }
  nitroApp.hooks.hook('close', () => { clearInterval(timer); clearInterval(healthTimer) })
})
