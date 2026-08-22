import { describe, expect, it } from 'vitest'
import { isPublicUpstreamAddress, normalizeUserUpstreamUrl } from '../server/utils/upstream-url'

describe('private relay SSRF protection', () => {
  it('accepts only clean HTTPS base URLs', () => {
    expect(normalizeUserUpstreamUrl('https://relay.example.com/v1/')).toBe('https://relay.example.com/v1')
    expect(() => normalizeUserUpstreamUrl('http://relay.example.com')).toThrow('只允许使用 HTTPS')
    expect(() => normalizeUserUpstreamUrl('https://user:pass@relay.example.com')).toThrow('不能包含凭据')
    expect(() => normalizeUserUpstreamUrl('https://relay.example.com?target=x')).toThrow('不能包含凭据')
  })

  it('blocks local, private, metadata and reserved IP ranges', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPublicUpstreamAddress(address), address).toBe(false)
    }
    expect(isPublicUpstreamAddress('1.1.1.1')).toBe(true)
    expect(isPublicUpstreamAddress('2606:4700:4700::1111')).toBe(true)
  })
})
