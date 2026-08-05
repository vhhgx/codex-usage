import { auditedMutation, requireAccountAdmin, reauthenticate, writeAudit } from '../../../../services/admin-auth'
import { replaceHubKeySecret } from '../../../../services/hub-admin'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<{ password?: unknown; key?: unknown; graceSeconds?: unknown }>(event) || {}
  if (typeof body.password !== 'string' || !body.password) throw createError({ statusCode: 400, message: '请输入当前管理员密码' })
  await reauthenticate(event, body.password)
  const key = typeof body.key === 'string' ? body.key : ''
  const graceSeconds = Number(body.graceSeconds ?? 0)
  setResponseHeaders(event, { 'cache-control': 'no-store, private', pragma: 'no-cache' })
  return auditedMutation(event, async () => {
    const result = await replaceHubKeySecret(event, id, key, graceSeconds, admin.userId)
    await writeAudit(event, admin.userId, 'key.secret_replace', 'hub_key', id, { credentialId: result.credential.id, graceSeconds: result.graceSeconds })
    return result
  })
})
