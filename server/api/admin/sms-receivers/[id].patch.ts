import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { updateSmsReceiver } from '../../../services/sms-receivers'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const item = await updateSmsReceiver(event, id, body, admin.userId)
    await writeAudit(event, admin.userId, 'sms_receiver.update', 'sms_receiver', id, {
      fields: Object.keys(body).filter(field => field !== 'fetchUrl'),
      fetchUrlChanged: typeof body.fetchUrl === 'string' && Boolean(body.fetchUrl.trim()),
      status: item.status
    })
    return { item }
  })
})
