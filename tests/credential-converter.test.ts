import { describe, expect, it } from 'vitest'
import {
  convertCredentialSourceText,
  cpaCredentialFileName,
  parseCredentialSourceText
} from '../shared/utils/credential-converter'

function jwt(payload: Record<string, unknown>) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'sig'
  ].join('.')
}

const now = new Date('2026-08-05T08:00:00.000Z')

describe('credential converter', () => {
  it('converts a ChatGPT session to CPA and corrected Sub2API credentials', () => {
    const result = convertCredentialSourceText(JSON.stringify({
      user: { id: 'user-1', email: 'mark@example.com' },
      account: { id: 'account-1', planType: 'plus' },
      accessToken: jwt({ exp: 1780473960, 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' } }),
      sessionToken: 'session-secret'
    }), 'session.json', now)
    expect(result.accounts).toHaveLength(1)
    const account = result.accounts[0]!
    expect(account.email).toBe('mark@example.com')
    expect(account.accessTokenExpiresAt).toBe(1780473960)
    expect(account.syntheticIdToken).toBe(true)
    expect(String(account.cpaCredential.id_token).split('.')).toHaveLength(3)
    expect(account.sub2apiCredentials).toMatchObject({
      session_token: 'session-secret',
      chatgpt_account_id: 'account-1',
      id_token_synthetic: true
    })
    expect(account.warnings).toContain('仅短期 access token')
  })

  it('preserves real refresh and id tokens without applying access expiry', () => {
    const idToken = jwt({ email: 'refresh@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'account-refresh' } })
    const result = convertCredentialSourceText(JSON.stringify({
      email: 'refresh@example.com',
      access_token: jwt({ exp: 1780473960 }),
      refresh_token: 'refresh-secret',
      id_token: idToken
    }), 'auth.json', now)
    const account = result.accounts[0]!
    expect(account.accessTokenExpiresAt).toBeNull()
    expect(account.expiresAt).toBeNull()
    expect(account.syntheticIdToken).toBe(false)
    expect(account.cpaCredential.refresh_token).toBe('refresh-secret')
    expect(account.sub2apiCredentials).toMatchObject({ refresh_token: 'refresh-secret', id_token: idToken })
  })

  it('recognizes nested batches and skips duplicate access tokens', () => {
    const accessToken = jwt({ email: 'nested@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'nested-account' } })
    const result = convertCredentialSourceText(JSON.stringify({ accounts: [
      { name: 'Nested', credentials: { access_token: accessToken, email: 'nested@example.com' } },
      { name: 'Duplicate', credentials: { access_token: accessToken, email: 'nested@example.com' } }
    ] }), 'bundle.json', now)
    expect(result.accounts).toHaveLength(1)
    expect(result.skipped).toMatchObject([{ message: '重复凭据已跳过' }])
  })

  it('rejects malformed, oversized and unsafe JSON', () => {
    expect(() => parseCredentialSourceText('{')).toThrow('JSON 解析失败')
    expect(() => parseCredentialSourceText(JSON.stringify({ constructor: { access_token: 'secret' } }))).toThrow('不安全字段')
    expect(() => parseCredentialSourceText(JSON.stringify({ value: 'x'.repeat(2 * 1024 * 1024) }))).toThrow('不能超过 2 MiB')
  })

  it('creates stable safe CPA file names', () => {
    expect(cpaCredentialFileName({ email: 'Mark+One@example.com', accountId: null, name: 'Mark' })).toBe('codex-mark+one@example.json')
  })
})
