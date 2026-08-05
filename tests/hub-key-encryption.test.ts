import { describe, expect, it } from 'vitest'
import { decryptHubKeyValue, encryptHubKeyValue, parseHubKeyEncryptionKeys, validateHubKeySecret } from '../server/utils/hub-crypto'

const keys = parseHubKeyEncryptionKeys(JSON.stringify({ v1: Buffer.alloc(32, 7).toString('base64') }))

describe('decryptable Hub Key storage', () => {
  it('encrypts and decrypts with versioned AES-GCM context', () => {
    const secret = 'zh-example-key-value-1234567890'
    const encrypted = encryptHubKeyValue(secret, 'key-id:credential-id', 'v1', keys)
    expect(encrypted.encrypted).not.toContain(secret)
    expect(encrypted.version).toBe('v1')
    expect(decryptHubKeyValue(encrypted.encrypted, 'key-id:credential-id', keys)).toBe(secret)
  })

  it('rejects tampering and a different record context', () => {
    const encrypted = encryptHubKeyValue('zh-example-key-value-1234567890', 'key-a:credential-a', 'v1', keys)
    expect(() => decryptHubKeyValue(encrypted.encrypted, 'key-b:credential-a', keys)).toThrow()
    const replacement = encrypted.encrypted.endsWith('A') ? 'B' : 'A'
    expect(() => decryptHubKeyValue(`${encrypted.encrypted.slice(0, -1)}${replacement}`, 'key-a:credential-a', keys)).toThrow()
  })

  it('rejects whitespace, control characters, and short values', () => {
    expect(() => validateHubKeySecret('too-short')).toThrow()
    expect(() => validateHubKeySecret('valid-length but spaces')).toThrow()
    expect(() => validateHubKeySecret(`valid-key-value-${String.fromCharCode(10)}`)).toThrow()
  })
})
