import { requireAdmin } from '../../services/admin-auth'
import { getHubSettings } from '../../services/hub-settings'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const settings = await getHubSettings(event)
  const config = useRuntimeConfig(event)
  const {
    sub2apiDefaultProxyUpstreamId: _internalSubProxyId,
    cpaDefaultProxyUpstreamId: _internalCpaProxyId,
    ...publicSettings
  } = settings
  return {
    settings: publicSettings,
    infrastructure: {
      postgres: Boolean(config.databaseUrl),
      redis: Boolean(config.redisUrl),
      objectStorage: Boolean(config.s3Bucket && config.s3AccessKeyId && config.s3SecretAccessKey),
      encryption: Boolean(config.encryptionKey && config.hubKeyPepper)
    }
  }
})
