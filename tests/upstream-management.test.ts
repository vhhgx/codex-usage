import { describe, expect, it } from 'vitest'
import { classifyUpstreamFailure, operationFailureDetails, operationFingerprint, sanitizeOperationSummary } from '../server/services/upstream-operations'
import { MAX_CREDENTIAL_BYTES, parseCredentialJson, safeCredentialPreview, validateSubCredentialAdapter } from '../server/utils/safe-json'
import { redactSensitiveText } from '../server/utils/upstream'
import {
  upstreamOperationActionLabel,
  upstreamOperationConnectionLabel,
  upstreamOperationTargetLabel,
  upstreamOperationTargetTypeLabel
} from '../shared/utils/upstream-operation-view'

describe('upstream credential safety', () => {
  it('parses a bounded credential and returns only a hash plus explicit value', () => {
    const raw = Buffer.from(JSON.stringify({ type: 'codex', email: 'admin@example.com', access_token: 'secret' }))
    const parsed = parseCredentialJson(raw)
    expect(parsed.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(safeCredentialPreview(parsed.value)).toEqual({
      type: 'codex', account: 'admin@example.com', hasAccessToken: true, hasRefreshToken: false
    })
    expect(JSON.stringify(safeCredentialPreview(parsed.value))).not.toContain('secret')
  })

  it('rejects oversized, deeply nested and non-object credentials', () => {
    expect(() => parseCredentialJson(Buffer.alloc(MAX_CREDENTIAL_BYTES + 1, 32))).toThrow()
    let nested: Record<string, unknown> = {}
    for (let index = 0; index < 30; index++) nested = { child: nested }
    expect(() => parseCredentialJson(JSON.stringify(nested))).toThrow()
    expect(() => parseCredentialJson('[]')).toThrow()
  })

  it('creates stable fingerprints independent of object key order', () => {
    expect(operationFingerprint({ a: 1, b: [2, 3] })).toBe(operationFingerprint({ b: [2, 3], a: 1 }))
    expect(operationFingerprint({ a: 1 })).not.toBe(operationFingerprint({ a: 2 }))
  })

  it('redacts secrets from upstream error text', () => {
    const safe = redactSensitiveText('failed: {"access_token":"top-secret","api_key":"sk-value"} Bearer abc.def http://hub:proxy-secret@proxy.test:8080')
    expect(safe).not.toContain('top-secret')
    expect(safe).not.toContain('sk-value')
    expect(safe).not.toContain('proxy-secret')
    expect(safe).toContain('[REDACTED]')
  })

  it('drops credential-like fields from operation summaries', () => {
    expect(sanitizeOperationSummary({ name: 'account', accessToken: 'secret', credentialHash: 'secret' })).toEqual({ name: 'account' })
  })

  it('classifies wrapped network timeouts as reconciliation required but explicit 5xx as failed', () => {
    expect(classifyUpstreamFailure({ statusCode: 502, data: { reconciliationRequired: true } }).ambiguous).toBe(true)
    expect(classifyUpstreamFailure({ statusCode: 503, message: 'upstream unavailable' }).ambiguous).toBe(false)
  })

  it('stores a bounded, redacted upstream operation failure with its stage', () => {
    const details = operationFailureDetails({
      message: 'internal error Bearer sensitive-token-value',
      data: { operationStage: '创建账号' }
    })
    expect(details).toEqual({ errorMessage: 'internal error Bearer [REDACTED]', operationStage: '创建账号' })
    expect(JSON.stringify(details)).not.toContain('sensitive-token-value')
  })

  it('validates common Sub2API credential shapes unless advanced mode is explicit', () => {
    expect(() => validateSubCredentialAdapter('openai', 'oauth', { refresh_token: 'secret' })).not.toThrow()
    expect(() => validateSubCredentialAdapter('openai', 'oauth', {})).toThrow()
    expect(() => validateSubCredentialAdapter('custom', 'oauth', {}, true)).not.toThrow()
  })

  it('presents operation audit values in Chinese without changing stored machine codes', () => {
    expect(upstreamOperationActionLabel('sub.account.import')).toBe('导入 Sub2API 账号')
    expect(upstreamOperationTargetTypeLabel('sub2api_account')).toBe('Sub2API 账号')
    expect(upstreamOperationConnectionLabel('sub2api')).toBe('Sub2API')
    expect(upstreamOperationTargetLabel({ targetRef: 'account-id', safeSummary: { name: '测试账号' } })).toBe('测试账号')
    expect(upstreamOperationActionLabel('future.action')).toBe('其他号池操作')
    expect(upstreamOperationTargetTypeLabel('future_target')).toBe('其他目标')
  })
})
