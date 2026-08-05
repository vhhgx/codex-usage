import { describe, expect, it } from 'vitest'
import { clientRandomUUID } from '../shared/utils/client-random'

describe('browser-compatible request IDs', () => {
  it('uses native randomUUID when available', () => {
    expect(clientRandomUUID({ randomUUID: () => 'native-request-id' })).toBe('native-request-id')
  })

  it('creates an RFC 4122 UUID when randomUUID is unavailable', () => {
    const value = clientRandomUUID({
      getRandomValues(bytes) {
        bytes.fill(0)
        return bytes
      }
    })
    expect(value).toBe('00000000-0000-4000-8000-000000000000')
  })

  it('still returns a valid id when Web Crypto is unavailable', () => {
    expect(clientRandomUUID(null)).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  })
})
