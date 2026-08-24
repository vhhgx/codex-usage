import { requireUser } from '../../../../services/admin-auth'
import { importUserPoolAccount, importUserPoolAccounts } from '../../../../services/user-pool'
import { MAX_CREDENTIAL_BYTES } from '../../../../utils/safe-json'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event) || {}
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_CREDENTIAL_BYTES) throw createError({ statusCode: 413, message: '账号导入 JSON 不能超过 2 MiB' })
  if (Array.isArray(body.accounts)) return importUserPoolAccounts(event, user.userId, body.accounts, user.userId)
  return { account: await importUserPoolAccount(event, user.userId, body, user.userId) }
})
