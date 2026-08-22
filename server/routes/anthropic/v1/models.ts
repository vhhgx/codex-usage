import { handleAnthropicModels } from '../../../services/anthropic-gateway'

export default defineEventHandler(async (event) => {
  const requestId = `req_${crypto.randomUUID().replace(/-/g, '')}`
  event.context.hubRequestId = requestId
  setResponseHeader(event, 'x-request-id', requestId)
  try {
    return await handleAnthropicModels(event)
  } catch (error) {
    const failure = error as { statusCode?: number; message?: string; data?: { error?: { type?: string; message?: string } } }
    const status = Number(failure.statusCode || 500)
    setResponseStatus(event, status)
    if (failure.data?.error) return { type: 'error', error: { type: failure.data.error.type || 'api_error', message: failure.data.error.message || failure.message || 'Zephyr Hub error' }, request_id: requestId }
    return { type: 'error', error: { type: status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error', message: failure.message || 'Zephyr Hub internal error' }, request_id: requestId }
  }
})
