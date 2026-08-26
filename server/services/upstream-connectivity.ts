import { pinnedUpstreamBaseFetch, upstreamNetworkError } from '../utils/upstream-url'

export type UpstreamConnectivityStatus = 'operational' | 'degraded' | 'failed'

export interface UpstreamConnectivityResult {
  status: UpstreamConnectivityStatus
  success: boolean
  message: string
  endpoint: string
  responseTimeMs: number
  httpStatus: number | null
  testedAt: number
  retryCount: number
  errorCode: string | null
}

const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_MAX_RETRIES = 1
const DEFAULT_DEGRADED_THRESHOLD_MS = 6_000

export function connectivityStatus(latencyMs: number, degradedThresholdMs = DEFAULT_DEGRADED_THRESHOLD_MS): UpstreamConnectivityStatus {
  return latencyMs <= degradedThresholdMs ? 'operational' : 'degraded'
}

export function connectivityFailureAllowsRetry(code: string, message: string) {
  return /timeout|timed out|abort/i.test(`${code} ${message}`)
}

export async function probeUpstreamConnectivity(
  baseUrl: string,
  options: { timeoutMs?: number; maxRetries?: number; degradedThresholdMs?: number } = {}
): Promise<UpstreamConnectivityResult> {
  const timeoutMs = Math.min(30_000, Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  const maxRetries = Math.min(3, Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES))
  const degradedThresholdMs = Math.max(1, options.degradedThresholdMs ?? DEFAULT_DEGRADED_THRESHOLD_MS)

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const started = Date.now()
    try {
      const result = await pinnedUpstreamBaseFetch(baseUrl, {
        method: 'GET',
        headers: { accept: '*/*', 'accept-encoding': 'identity' },
        signal: AbortSignal.timeout(timeoutMs)
      })
      const latencyMs = Date.now() - started
      const httpStatus = result.response.status
      await Promise.resolve(result.close()).catch(() => {})
      return {
        status: connectivityStatus(latencyMs, degradedThresholdMs),
        success: true,
        message: '中转地址可达',
        endpoint: result.target,
        responseTimeMs: latencyMs,
        httpStatus,
        testedAt: Date.now(),
        retryCount: attempt,
        errorCode: null
      }
    } catch (error) {
      const detail = upstreamNetworkError(error)
      const latencyMs = Date.now() - started
      if (attempt < maxRetries && connectivityFailureAllowsRetry(detail.code, detail.message)) continue
      return {
        status: 'failed',
        success: false,
        message: detail.message,
        endpoint: baseUrl,
        responseTimeMs: latencyMs,
        httpStatus: null,
        testedAt: Date.now(),
        retryCount: attempt,
        errorCode: detail.code
      }
    }
  }

  throw new Error('连通检测未产生结果')
}
