import { requireAdmin, writeAudit } from '../../../../../services/admin-auth'
import { accountImportPayload } from '../../../../../services/upstream-input'
import { createManagedSub2ApiAccount, importManagedSub2ApiData } from '../../../../../services/sub2api-admin'
import { runUpstreamOperation } from '../../../../../services/upstream-operations'
import { enforceRateLimit } from '../../../../../utils/rate-limit'
import { MAX_CREDENTIAL_BYTES, parseCredentialJson, safeCredentialPreview, validateSubCredentialAdapter } from '../../../../../utils/safe-json'
import { redactSensitiveText } from '../../../../../utils/upstream'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-sub-account-import', 10, 60_000)
  const body = await readBody<Record<string, unknown>>(event) || {}
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_CREDENTIAL_BYTES) {
    throw createError({ statusCode: 413, message: '账号导入 JSON 不能超过 2 MiB' })
  }
  if (Array.isArray(body.accounts)) {
    if (!body.accounts.length) throw createError({ statusCode: 400, message: '没有可导入的账号' })
    if (body.accounts.length > 100) throw createError({ statusCode: 400, message: '单次最多导入 100 个账号' })
    const activate = body.schedulable !== false
    const advanced = body.advancedRaw === true
    const validated = await Promise.all(body.accounts.map(async (value, index) => {
      const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
      const parsed = parseCredentialJson(Buffer.from(JSON.stringify(row.credentials ?? null)))
      validateSubCredentialAdapter(String(row.platform || ''), String(row.type || ''), parsed.value, advanced)
      const payload = await accountImportPayload(event, row, parsed.value)
      return { index, parsed, payload }
    }))
    const created = []
    const failed: Array<{ index: number; name: string; error: string }> = []
    for (const item of validated) {
      const preview = safeCredentialPreview(item.parsed.value)
      try {
        const account = await runUpstreamOperation(event, {
          adminId: admin.userId, connectionId: 'sub2api', action: 'sub.account.import',
          targetType: 'sub2api_account', targetRef: String(item.payload.name),
          fingerprint: { ...item.payload, credentials: item.parsed.sha256, activate },
          idempotencyFallback: `sub-import:${item.payload.platform}:${item.payload.name}:${item.parsed.sha256}`,
          safeSummary: { name: item.payload.name, platform: item.payload.platform, type: item.payload.type, sha256: item.parsed.sha256, account: preview.account, groupCount: item.payload.group_ids.length, activate }
        }, async () => ({ result: await createManagedSub2ApiAccount(event, item.payload, activate) }))
        created.push(account)
        await writeAudit(event, admin.userId, 'sub.account.import', 'sub2api_account', account.id, {
          name: account.name, platform: account.platform, sha256: item.parsed.sha256,
          groupCount: account.groupIds.length, schedulable: activate, result: 'succeeded', requestId: getResponseHeader(event, 'x-request-id')
        })
      } catch (error) {
        failed.push({ index: item.index, name: String(item.payload.name), error: redactSensitiveText(error instanceof Error ? error.message : '导入失败') })
      }
    }
    if (failed.length) setResponseStatus(event, 207)
    return { mode: 'accounts', created, failed }
  }
  const parsed = parseCredentialJson(Buffer.from(JSON.stringify(body.credentials ?? null)))
  const bundleType = String(parsed.value.type || '')
  const bundleAccounts = Array.isArray(parsed.value.accounts) ? parsed.value.accounts : null
  const activate = body.schedulable !== false
  if ((bundleType === 'sub2api-data' || bundleType === 'sub2api-bundle') && bundleAccounts) {
    const result = await runUpstreamOperation(event, {
      adminId: admin.userId, connectionId: 'sub2api', action: 'sub.account.import-data',
      targetType: 'sub2api_account_bundle', targetRef: parsed.sha256.slice(0, 16),
      fingerprint: { sha256: parsed.sha256, accountCount: bundleAccounts.length, activate },
      idempotencyFallback: `sub-import-data:${parsed.sha256}`,
      safeSummary: { sha256: parsed.sha256, accountCount: bundleAccounts.length, proxyCount: Array.isArray(parsed.value.proxies) ? parsed.value.proxies.length : 0, activate }
    }, async () => ({ result: await importManagedSub2ApiData(event, parsed.value, activate) }))
    await writeAudit(event, admin.userId, 'sub.account.import-data', 'sub2api_account_bundle', parsed.sha256.slice(0, 16), {
      sha256: parsed.sha256, accountCount: bundleAccounts.length, accountCreated: result.accountCreated,
      accountFailed: result.accountFailed, activate, result: 'succeeded', requestId: getResponseHeader(event, 'x-request-id')
    })
    return { mode: 'bundle', result }
  }
  validateSubCredentialAdapter(String(body.platform || ''), String(body.type || ''), parsed.value, body.advancedRaw === true)
  const payload = await accountImportPayload(event, body, parsed.value)
  const preview = safeCredentialPreview(parsed.value)
  const account = await runUpstreamOperation(event, {
    adminId: admin.userId, connectionId: 'sub2api', action: 'sub.account.import',
    targetType: 'sub2api_account', targetRef: String(payload.name),
    fingerprint: { ...payload, credentials: parsed.sha256 },
    idempotencyFallback: `sub-import:${payload.platform}:${payload.name}:${parsed.sha256}`,
    safeSummary: { name: payload.name, platform: payload.platform, type: payload.type, sha256: parsed.sha256, account: preview.account, groupCount: payload.group_ids.length, activate }
  }, async () => ({ result: await createManagedSub2ApiAccount(event, payload, activate) }))
  await writeAudit(event, admin.userId, 'sub.account.import', 'sub2api_account', account.id, {
    name: account.name, platform: account.platform, sha256: parsed.sha256, groupCount: account.groupIds.length,
    schedulable: activate, result: 'succeeded', requestId: getResponseHeader(event, 'x-request-id')
  })
  return { account }
})
