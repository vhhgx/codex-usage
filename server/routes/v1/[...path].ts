import { handleHubRequest, recordRejectedHubRequest } from '../../services/hub-gateway'
import { handleAnthropicModels } from '../../services/anthropic-gateway'

export default defineEventHandler(async (event) => {
  const path = getRouterParam(event, 'path') || ''
  const requestId = `req_${crypto.randomUUID().replace(/-/g, '')}`
  const anthropicModels = path === 'models' && Boolean(getHeader(event, 'anthropic-version') || getHeader(event, 'x-api-key'))
  event.context.hubRequestId = requestId
  event.context.hubStartedAt = Date.now()
  setResponseHeader(event, 'x-request-id', requestId)
  try {
    // Claude Code uses the root /v1 base URL and expects Anthropic's model shape.
    if (anthropicModels) {
      return await handleAnthropicModels(event)
    }
    return await handleHubRequest(event, path)
  } catch (error) {
    try {
      await recordRejectedHubRequest(event, path, error)
    } catch (logError) {
      console.error('[hub-request-log]', logError instanceof Error ? logError.message : logError)
    }
    const failure = error as { statusCode?: number; message?: string; data?: { error?: unknown } }
    const status = Number(failure.statusCode || 500)
    setResponseStatus(event, status)
    setResponseHeader(event, 'content-type', 'application/json')
    if (anthropicModels) {
      const error = failure.data?.error && typeof failure.data.error === 'object' ? failure.data.error as { type?: string; message?: string } : null
      return { type: 'error', error: { type: error?.type || (status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status >= 500 ? 'api_error' : 'invalid_request_error'), message: error?.message || failure.message || 'Zephyr Hub error' }, request_id: requestId }
    }
    if (failure.data?.error) return { error: failure.data.error }
    return {
      error: {
        message: failure.message || 'Zephyr Hub internal error',
        type: status >= 500 ? 'server_error' : status === 401 ? 'authentication_error' : 'invalid_request_error',
        param: null,
        code: status >= 500 ? 'hub_internal_error' : null
      }
    }
  }
})
