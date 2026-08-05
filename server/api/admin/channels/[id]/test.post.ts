import { eq } from 'drizzle-orm'
import { requireAdmin, writeAudit } from '../../../../services/admin-auth'
import { useDatabase } from '../../../../db'
import { channels } from '../../../../db/schema'
import { checkChannelHealth } from '../../../../services/channel-health'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const db = useDatabase(event)
  const [channel] = await db.select().from(channels).where(eq(channels.id, id)).limit(1)
  if (!channel) throw createError({ statusCode: 404, message: '渠道不存在' })
  const result = await checkChannelHealth(event, channel)
  await writeAudit(event, admin.userId, 'channel.test', 'channel', id, result)
  return result
})
