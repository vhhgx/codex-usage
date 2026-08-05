import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeLedgerTransaction, parseAccountDeliveryText, summarizeLedger, yuanToCents } from '../server/services/accounting'
import { decryptContextSecret, encryptContextSecret } from '../server/utils/hub-crypto'

beforeEach(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({ encryptionKey: Buffer.alloc(32, 11).toString('base64') }))
  vi.stubGlobal('createError', (input: { message: string }) => Object.assign(new Error(input.message), input))
})

describe('secure account record encryption', () => {
  it('decrypts only in the original record context', () => {
    const encrypted = encryptContextSecret('account-password-value', 'account-vault:a:password')
    expect(encrypted).not.toContain('account-password-value')
    expect(decryptContextSecret(encrypted, 'account-vault:a:password')).toBe('account-password-value')
    expect(() => decryptContextSecret(encrypted, 'account-vault:b:password')).toThrow()
  })

  it('isolates imported token and email-link ciphertext by field context', () => {
    const accessToken = encryptContextSecret('access-token-value', 'account-vault:a:access-token')
    const emailCodeUrl = encryptContextSecret('https://mail.example/code', 'account-vault:a:email-code-url')
    expect(accessToken).not.toContain('access-token-value')
    expect(emailCodeUrl).not.toContain('mail.example')
    expect(decryptContextSecret(accessToken, 'account-vault:a:access-token')).toBe('access-token-value')
    expect(() => decryptContextSecret(accessToken, 'account-vault:a:refresh-token')).toThrow()
  })
})

describe('purchased account delivery parsing', () => {
  it('parses email-code links and password/AT/RT deliveries without echoing secrets in metadata', () => {
    const lines = parseAccountDeliveryText([
      'first@icloud.com----https://mail.example/messages/first',
      'second@hotmail.com----account-password----access-token----refresh-token'
    ].join('\n'))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ email: 'first@icloud.com', kind: 'email_code_url', message: null })
    expect(lines[0]?.record).toMatchObject({ emailCodeUrl: 'https://mail.example/messages/first' })
    expect(lines[1]).toMatchObject({ email: 'second@hotmail.com', kind: 'tokens', message: null })
    expect(lines[1]?.record).toMatchObject({ password: 'account-password', accessToken: 'access-token', refreshToken: 'refresh-token' })
    expect(JSON.stringify(lines.map(line => ({ email: line.email, kind: line.kind, message: line.message, fingerprint: line.fingerprint })))).not.toContain('account-password')
  })

  it('rejects malformed deliveries without including their credential value in errors', () => {
    const [line] = parseAccountDeliveryText('buyer@example.com----top-secret----extra-secret')
    expect(line).toMatchObject({ kind: 'invalid' })
    expect(line?.message).not.toContain('top-secret')
    expect(line?.message).not.toContain('extra-secret')
  })
})

describe('ledger normalization and summary', () => {
  it('stores exact decimal yuan values as integer cents', () => {
    expect(yuanToCents('12.34')).toBe(1234)
    expect(normalizeLedgerTransaction({
      occurredOn: '2026-08-02',
      type: 'personal_expense',
      project: 'Test',
      unitPrice: '12.34',
      quantity: 3,
      note: ''
    })).toMatchObject({ unitPriceCents: 1234, amountCents: 3702 })
  })

  it('keeps Linglong expenses out of net cash flow', () => {
    expect(summarizeLedger([
      { type: 'personal_expense', amountCents: 1000 },
      { type: 'personal_income', amountCents: 5000 },
      { type: 'linglong_expense', amountCents: 500 },
      { type: 'nvtokens_topup', amountCents: 2000 },
      { type: 'nvtokens_consumption', amountCents: 700 }
    ])).toMatchObject({
      recordCount: 5,
      totalExpenseCents: 3500,
      nvtokensBalanceCents: 1300,
      netCents: 2000
    })
  })
})
