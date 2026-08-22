import { requireAccountAdmin, reauthenticate, writeAudit } from '../../../services/admin-auth'
import { listAccountVaultEntries, revealAccountVaultCredentials } from '../../../services/accounting'
import { revealSmsReceiverFetchUrl } from '../../../services/sms-receivers'
import { enforceRateLimit } from '../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  await enforceRateLimit(event, `admin-account-export:${admin.userId}`, 3, 60_000)
  const body = await readBody<{ password?: unknown }>(event) || {}
  if (typeof body.password !== 'string' || !body.password) throw createError({ statusCode: 400, message: '导出完整账号前需要输入当前管理员密码' })
  await reauthenticate(event, body.password)
  const items = await listAccountVaultEntries(event)
  const records = await Promise.all(items.map(async item => {
    const smsUrl = item.smsReceiver ? await revealSmsReceiverFetchUrl(event, item.smsReceiver.id) : ''
    const credentials = await revealAccountVaultCredentials(event, item.id)
    return {
      id: item.id,
      email: item.email,
      name: item.displayName || '',
      source: item.source,
      status: item.status,
      password: credentials.password,
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      emailCodeUrl: credentials.emailCodeUrl,
      totpSecret: credentials.totpSecret,
      purchaseTime: item.purchaseDate || '',
      warrantyTime: item.warrantyDate || '',
      warrantyStatus: item.warrantyStatus,
      smsUrl,
      phone: item.smsReceiver?.phone || '',
      remark: item.remark || '',
      createdAt: new Date(item.createdAt).toISOString()
    }
  }))
  await writeAudit(event, admin.userId, 'account_vault.export', 'account_vault_entry', null, { count: records.length, securityEvent: true })
  setResponseHeaders(event, {
    'cache-control': 'no-store, private',
    pragma: 'no-cache',
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="account-vault-${new Date().toISOString().slice(0, 10)}.json"`
  })
  return JSON.stringify(records, null, 2)
})
