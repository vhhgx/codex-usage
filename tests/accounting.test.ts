import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  missingActiveSub2ApiVaultIds,
  normalizeLedgerTransaction,
  parseAccountDeliveryText,
  summarizeLedger,
  yuanToCents
} from '../server/services/accounting'
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

  it('round-trips an empty context secret without treating its empty body as corrupt', () => {
    const encrypted = encryptContextSecret('', 'account-vault:a:password')
    expect(encrypted.endsWith('.')).toBe(true)
    expect(decryptContextSecret(encrypted, 'account-vault:a:password')).toBe('')
  })

  it('isolates imported token and email-link ciphertext by field context', () => {
    const accessToken = encryptContextSecret('access-token-value', 'account-vault:a:access-token')
    const emailCodeUrl = encryptContextSecret('https://mail.example/code', 'account-vault:a:email-code-url')
    expect(accessToken).not.toContain('access-token-value')
    expect(emailCodeUrl).not.toContain('mail.example')
    expect(decryptContextSecret(accessToken, 'account-vault:a:access-token')).toBe('access-token-value')
    expect(() => decryptContextSecret(accessToken, 'account-vault:a:refresh-token')).toThrow()
  })

  it('isolates TOTP secrets from every other account credential context', () => {
    const totpSecret = encryptContextSecret('MFLV3KISP5JROQOWHAQCLUVA4PO6YUM7', 'account-vault:a:totp-secret')
    expect(totpSecret).not.toContain('MFLV3KISP5JROQOWHAQCLUVA4PO6YUM7')
    expect(decryptContextSecret(totpSecret, 'account-vault:a:totp-secret')).toBe('MFLV3KISP5JROQOWHAQCLUVA4PO6YUM7')
    expect(() => decryptContextSecret(totpSecret, 'account-vault:a:password')).toThrow()
  })
})

describe('purchased account delivery parsing', () => {
  it('parses email-code links and password/AT/RT deliveries without echoing secrets in metadata', () => {
    const [emailLink] = parseAccountDeliveryText('first@icloud.com----https://mail.example/messages/first', ['email', 'emailCodeUrl'])
    const [tokens] = parseAccountDeliveryText('second@hotmail.com----account-password----access-token----refresh-token', ['email', 'password', 'accessToken', 'refreshToken'])
    expect(emailLink).toMatchObject({ email: 'first@icloud.com', kind: 'custom', message: null })
    expect(emailLink?.record).toMatchObject({ emailCodeUrl: 'https://mail.example/messages/first' })
    expect(tokens).toMatchObject({ email: 'second@hotmail.com', kind: 'custom', message: null })
    expect(tokens?.record).toMatchObject({ password: 'account-password', accessToken: 'access-token', refreshToken: 'refresh-token' })
    expect(JSON.stringify([emailLink, tokens].map(line => ({ email: line?.email, kind: line?.kind, message: line?.message, fingerprint: line?.fingerprint })))).not.toContain('account-password')
  })

  it('rejects malformed deliveries without including their credential value in errors', () => {
    const [line] = parseAccountDeliveryText('buyer@example.com----top-secret----extra-secret', ['email', 'password', 'accessToken', 'refreshToken'])
    expect(line).toMatchObject({ kind: 'invalid' })
    expect(line?.message).not.toContain('top-secret')
    expect(line?.message).not.toContain('extra-secret')
  })

  it('parses password and TOTP deliveries only when that format is selected', () => {
    const source = 'buyer@example.com----account-password----MFLV3KISP5JROQOWHAQCLUVA4PO6YUM7'
    const [line] = parseAccountDeliveryText(source, ['email', 'password', 'totpSecret'])
    expect(line).toMatchObject({ email: 'buyer@example.com', kind: 'custom', message: null })
    expect(line?.record).toMatchObject({ password: 'account-password', totpSecret: 'MFLV3KISP5JROQOWHAQCLUVA4PO6YUM7' })
    expect(parseAccountDeliveryText(source, ['email', 'password', 'accessToken', 'refreshToken'])[0]).toMatchObject({ kind: 'invalid' })
    expect(JSON.stringify({ email: line?.email, kind: line?.kind, message: line?.message })).not.toContain('MFLV3KISP5JROQOWHAQCLUVA4PO6YUM7')
  })

  it('supports a user-defined field order and mixed credential content', () => {
    const [line] = parseAccountDeliveryText(
      'access-token----buyer@example.com----MFLV3KISP5JROQOWHAQCLUVA4PO6YUM7----refresh-token----https://mail.example/code',
      ['accessToken', 'email', 'totpSecret', 'refreshToken', 'emailCodeUrl']
    )
    expect(line).toMatchObject({ email: 'buyer@example.com', kind: 'custom', message: null })
    expect(line?.record).toMatchObject({
      email: 'buyer@example.com',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      totpSecret: 'MFLV3KISP5JROQOWHAQCLUVA4PO6YUM7',
      emailCodeUrl: 'https://mail.example/code'
    })
  })

  it('requires account and paired AT/RT fields', () => {
    expect(() => parseAccountDeliveryText('buyer@example.com', [])).toThrow('请先配置发货字段')
    expect(() => parseAccountDeliveryText('secret', ['password'])).toThrow('必须包含账号')
    expect(() => parseAccountDeliveryText('buyer@example.com----access-token', ['email', 'accessToken'])).toThrow('AT 和 RT 必须同时选择')
  })
})

describe('account vault Sub2API lifecycle', () => {
  it('marks only previously active accounts missing from a complete Sub2API list as deleted', () => {
    const missing = missingActiveSub2ApiVaultIds([
      { id: 'present', sub2apiAccountId: 'sub-present', sub2apiPoolStatus: 'active' },
      { id: 'removed', sub2apiAccountId: 'sub-removed', sub2apiPoolStatus: 'active' },
      { id: 'never-added', sub2apiAccountId: null, sub2apiPoolStatus: 'not_added' },
      { id: 'already-deleted', sub2apiAccountId: null, sub2apiPoolStatus: 'deleted' }
    ], new Set(['sub-present']))

    expect(missing).toEqual(['removed'])
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
