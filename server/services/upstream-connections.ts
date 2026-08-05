import type { H3Event } from 'h3'
import type { UpstreamConnectionView } from '#shared/types/upstream-management'
import { normalizeBaseUrl } from '../utils/upstream'

export function listUpstreamConnections(event: H3Event): UpstreamConnectionView[] {
  const config = useRuntimeConfig(event)
  const cpaBase = normalizeBaseUrl(config.cpaBaseUrl)
  const subBase = normalizeBaseUrl(config.sub2apiBaseUrl)
  return [
    {
      id: 'cpa', name: 'CLIProxyAPI',
      configured: Boolean(cpaBase && String(config.cpaManagementKey || '').trim()),
      baseUrl: cpaBase || null,
      capabilities: ['auth-files.list', 'auth-files.upload', 'auth-files.status', 'auth-files.verify', 'auth-files.delete', 'proxy.global']
    },
    {
      id: 'sub2api', name: 'Sub2API',
      configured: Boolean(subBase && String(config.sub2apiAdminApiKey || '').trim()),
      baseUrl: subBase || null,
      capabilities: ['accounts.list', 'accounts.import', 'accounts.oauth', 'accounts.update', 'accounts.verify', 'accounts.delete', 'groups.crud', 'proxies.crud']
    }
  ]
}
