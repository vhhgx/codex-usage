import { handleHubRequest, recordRejectedHubRequest } from '../../services/hub-gateway'

export default defineEventHandler(async (event) => {
  const path = getRouterParam(event, 'path') || ''
  const requestId = `req_${crypto.randomUUID().replace(/-/g, '')}`
  event.context.hubRequestId = requestId
  event.context.hubStartedAt = Date.now()
  setResponseHeader(event, 'x-request-id', requestId)
  try {
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
