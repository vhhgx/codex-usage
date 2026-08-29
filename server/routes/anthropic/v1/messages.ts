import { handleAnthropicMessages } from '../../../services/anthropic-gateway'
import { recordRejectedHubRequest } from '../../../services/hub-gateway'
import { redactSensitiveText } from '../../../utils/upstream'

export default defineEventHandler(async (event) => {
  const requestId = `req_${crypto.randomUUID().replace(/-/g, '')}`
  event.context.hubRequestId = requestId
  event.context.hubStartedAt = Date.now()
  setResponseHeader(event, 'x-request-id', requestId)
  try {
    return await handleAnthropicMessages(event)
  } catch (error) {
    await recordRejectedHubRequest(event, 'messages', error).catch(logError => console.error('[hub-request-log]', logError instanceof Error ? logError.message : logError))
    const failure = error as { statusCode?: number; message?: string; data?: { type?: string; error?: { type?: string; message?: string } } }
    const status = Number(failure.statusCode || 500)
    setResponseStatus(event, status)
    setResponseHeader(event, 'content-type', 'application/json; charset=utf-8')
    if (failure.data?.error) return { type: 'error', error: { type: failure.data.error.type || 'api_error', message: redactSensitiveText(failure.data.error.message || failure.message || 'Zephyr Hub error', 2000) }, request_id: requestId }
    return { type: 'error', error: { type: status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error', message: redactSensitiveText(failure.message || 'Zephyr Hub internal error', 2000) }, request_id: requestId }
  }
})
