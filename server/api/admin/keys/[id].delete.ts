import { eq } from 'drizzle-orm'
import { auditedMutation, requireAdmin, writeAudit } from '../../../services/admin-auth'
import { useDatabase } from '../../../db'
import { hubKeys } from '../../../db/schema'
import { beginHubKeyDeletion, cancelHubKeyDeletion, clearHubKeyState } from '../../../services/hub-limits'
import { deleteHubKeyPreservingRollups } from '../../../services/hub-deletion'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const [existing] = await useDatabase(event).update(hubKeys).set({ status: 'disabled', updatedAt: new Date() })
    .where(eq(hubKeys.id, id)).returning({ id: hubKeys.id })
  if (!existing) throw createError({ statusCode: 404, message: 'Hub Key 不存在' })
  if (!await beginHubKeyDeletion(event, id)) {
    throw createError({ statusCode: 409, message: 'Hub Key 仍有进行中的请求，请停用并等待请求结束后再删除' })
  }
  try {
    await auditedMutation(event, async () => {
      await deleteHubKeyPreservingRollups(event, id)
      await writeAudit(event, admin.userId, 'key.delete', 'hub_key', id)
    })
    await clearHubKeyState(event, id)
    return { success: true }
  } catch (error) {
    await cancelHubKeyDeletion(event, id)
    throw error
  }
})
