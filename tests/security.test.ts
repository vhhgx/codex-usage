import { describe, expect, it } from 'vitest'
import { hashApiKey, safeEqual } from '../server/utils/security'

describe('API key security helpers', () => {
  it('matches CPA Manager Plus SHA-256 normalization', () => {
    expect(hashApiKey('  test-key  ')).toBe(
      '62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef'
    )
  })

  it('compares secrets without leaking string length', () => {
    expect(safeEqual('same-secret', 'same-secret')).toBe(true)
    expect(safeEqual('same-secret', 'different')).toBe(false)
  })
})
