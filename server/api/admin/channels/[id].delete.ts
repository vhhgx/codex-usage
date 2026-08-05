import { eq } from 'drizzle-orm'
import { auditedMutation, requireAdmin, writeAudit } from '../../../services/admin-auth'
import { useDatabase } from '../../../db'
import { channels } from '../../../db/schema'
import { beginChannelDeletion, finishChannelDeletion } from '../../../services/hub-limits'
import { deleteChannelPreservingRollups } from '../../../services/hub-deletion'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const [existing] = await useDatabase(event).update(channels).set({ enabled: false, updatedAt: new Date() })
    .where(eq(channels.id, id)).returning({ id: channels.id })
  if (!existing) throw createError({ statusCode: 404, message: '渠道不存在' })
  if (!await beginChannelDeletion(event, id)) {
    throw createError({ statusCode: 409, message: '渠道仍有进行中的请求，请等待请求结束后再删除' })
  }
  try {
    await auditedMutation(event, async () => {
      await deleteChannelPreservingRollups(event, id)
      await writeAudit(event, admin.userId, 'channel.delete', 'channel', id)
    })
    return { success: true }
  } finally {
    await finishChannelDeletion(event, id)
  }
})
