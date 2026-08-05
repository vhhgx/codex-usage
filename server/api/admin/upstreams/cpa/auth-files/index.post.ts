import { requireAdmin, writeAudit } from '../../../../../services/admin-auth'
import { uploadManagedCpaAuthFile } from '../../../../../services/cpa'
import { runUpstreamOperation } from '../../../../../services/upstream-operations'
import { enforceRateLimit } from '../../../../../utils/rate-limit'
import { parseCredentialJson, safeCredentialPreview } from '../../../../../utils/safe-json'

function safeName(value: unknown) {
  const name = String(value || '').trim()
  if (!name || name.length > 180 || !/^[^/\\]+\.json$/i.test(name)) {
    throw createError({ statusCode: 400, message: '文件名必须是安全的 .json 文件名' })
  }
  return name
}

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-cpa-upload', 10, 60_000)
  const contentType = getHeader(event, 'content-type') || ''
  const candidates: Array<{ name: string; bytes: Buffer }> = []
  if (contentType.startsWith('multipart/form-data')) {
    const parts = await readMultipartFormData(event) || []
    const files = parts.filter(part => part.filename)
    if (!files.length) throw createError({ statusCode: 400, message: '请选择认证 JSON 文件' })
    if (files.length > 20) throw createError({ statusCode: 400, message: '单次最多上传 20 个认证文件' })
    files.forEach(file => candidates.push({ name: safeName(file.filename), bytes: file.data }))
  } else {
    const body = await readBody<{ name?: unknown; credential?: unknown }>(event) || {}
    candidates.push({ name: safeName(body.name), bytes: Buffer.from(JSON.stringify(body.credential ?? null)) })
  }
  if (new Set(candidates.map(item => item.name)).size !== candidates.length) {
    throw createError({ statusCode: 400, message: '同一批次不能包含重名文件' })
  }
  const validated = candidates.map(item => ({ ...item, parsed: parseCredentialJson(item.bytes) }))
  const files = []
  const failed: Array<{ name: string; error: string }> = []
  for (const item of validated) {
    const preview = safeCredentialPreview(item.parsed.value)
    try {
      const result = await runUpstreamOperation(event, {
        adminId: admin.userId, connectionId: 'cpa', action: 'cpa.auth-file.upload',
        targetType: 'cpa_auth_file', targetRef: item.name,
        fingerprint: { name: item.name, sha256: item.parsed.sha256 },
        idempotencyFallback: `cpa-upload:${item.name}:${item.parsed.sha256}`,
        safeSummary: { name: item.name, sha256: item.parsed.sha256, provider: preview.type, account: preview.account }
      }, async () => ({ result: await uploadManagedCpaAuthFile(event, item.name, item.parsed.bytes) }))
      files.push(result)
      await writeAudit(event, admin.userId, 'cpa.auth-file.upload', 'cpa_auth_file', result.id, {
        name: item.name, sha256: item.parsed.sha256, provider: preview.type,
        result: 'succeeded', requestId: getResponseHeader(event, 'x-request-id')
      })
    } catch (error) {
      failed.push({ name: item.name, error: error instanceof Error ? error.message.slice(0, 300) : '上传失败' })
    }
  }
  if (failed.length) setResponseStatus(event, 207)
  return { files, failed }
})
