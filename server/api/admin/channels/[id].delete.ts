import { eq } from 'drizzle-orm'
import { auditedMutation, requireAdmin, writeAudit } from '../../../services/admin-auth'
import { useDatabase } from '../../../db'
import { channels } from '../../../db/schema'
import { beginChannelDeletion, finishChannelDeletion } from '../../../services/hub-limits'
import { deleteChannelPreservingRollups } from '../../../services/hub-deletion'
import { invalidateChannelAccess } from '../../../services/channel-access'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const [existing] = await useDatabase(event).select({ id: channels.id }).from(channels).where(eq(channels.id, id)).limit(1)
  if (!existing) throw createError({ statusCode: 404, message: '渠道不存在' })
  // 先确认没有在途请求，再进入删除流程。判定失败时不改动渠道的任何状态。
  if (!await beginChannelDeletion(event, id)) {
    throw createError({ statusCode: 409, message: '渠道仍有进行中的请求，请等待请求结束后再删除' })
  }
  try {
    await auditedMutation(event, async () => {
      await deleteChannelPreservingRollups(event, id)
      await invalidateChannelAccess(event, [id])
      await writeAudit(event, admin.userId, 'channel.delete', 'channel', id)
    })
    return { success: true }
  } finally {
    await finishChannelDeletion(event, id)
  }
})
