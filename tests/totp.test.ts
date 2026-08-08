import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateTotpCode, normalizeTotpSecret } from '../server/utils/totp'

beforeEach(() => {
  vi.stubGlobal('createError', (input: { message: string }) => Object.assign(new Error(input.message), input))
})

describe('TOTP credentials', () => {
  it('normalizes common Base32 presentation without changing the secret', () => {
    expect(normalizeTotpSecret('mflv3kis p5jroqow haqcluva 4po6yum7', true)).toBe('MFLV3KISP5JROQOWHAQCLUVA4PO6YUM7')
  })

  it('rejects ambiguous characters and non-canonical trailing bits', () => {
    expect(() => normalizeTotpSecret('MFLV3KISP5JROQOWHAQCLUVA4PO6YUM0', true)).toThrow('Base32')
    expect(() => normalizeTotpSecret('MFRGGZDFMZ', true)).toThrow('尾随位')
  })

  it('matches RFC 6238 SHA-1 vectors with six digits and preserves leading zeroes', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    expect(generateTotpCode(secret, 59_000)).toMatchObject({ code: '287082', generatedAt: 59_000, expiresAt: 60_000 })
    expect(generateTotpCode(secret, 1_111_111_109_000).code).toBe('081804')
    expect(generateTotpCode(secret, 1_111_111_111_000).code).toBe('050471')
    expect(generateTotpCode(secret, 1_234_567_890_000).code).toBe('005924')
  })
})
