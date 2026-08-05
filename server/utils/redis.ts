import Redis from 'ioredis'

let redis: Redis | null = null

export function useRedis(event?: Parameters<typeof useRuntimeConfig>[0]) {
  if (redis) return redis
  const url = String(useRuntimeConfig(event).redisUrl || '').trim()
  if (!url) throw createError({ statusCode: 503, message: '未配置 NUXT_REDIS_URL' })
  redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true
  })
  redis.on('error', () => {})
  return redis
}

export async function closeRedis() {
  if (redis) await redis.quit().catch(() => redis?.disconnect())
  redis = null
}
