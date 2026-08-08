import { describe, expect, it } from 'vitest'
import {
  firstAvailableSmsSlot,
  leastLoadedSmsReceiver,
  normalizeSmsPhone,
  parseSmsReceiverImportText,
  parseSmsProviderResponse
} from '../server/services/sms-receivers'

describe('SMS receiver normalization', () => {
  it('normalizes formatted phone numbers to a stable binding key', () => {
    expect(normalizeSmsPhone('+86 138-0013-8000')).toEqual({
      phone: '+86 138-0013-8000',
      phoneKey: '8613800138000',
      copyValue: '8613800138000'
    })
  })

  it('treats US numbers with or without country code as the same receiver', () => {
    expect(normalizeSmsPhone('4438656164')).toEqual({
      phone: '+1(443)8656164',
      phoneKey: '14438656164',
      copyValue: '4438656164'
    })
    expect(normalizeSmsPhone('1 (443) 865-6164')).toEqual({
      phone: '+1(443)8656164',
      phoneKey: '14438656164',
      copyValue: '4438656164'
    })
  })

  it('allocates no more than three binding slots', () => {
    expect(firstAvailableSmsSlot([])).toBe(1)
    expect(firstAvailableSmsSlot([1, 3])).toBe(2)
    expect(firstAvailableSmsSlot([1, 2, 3])).toBeUndefined()
  })

  it('assigns the least-loaded active receiver and excludes full receivers', () => {
    const receivers = [
      { id: 'old-full', createdAt: new Date('2026-08-01T00:00:00Z') },
      { id: 'older-open', createdAt: new Date('2026-08-02T00:00:00Z') },
      { id: 'newer-open', createdAt: new Date('2026-08-03T00:00:00Z') }
    ]
    expect(leastLoadedSmsReceiver(receivers, new Map([
      ['old-full', 3],
      ['older-open', 1],
      ['newer-open', 0]
    ]))).toBe('newer-open')
    expect(leastLoadedSmsReceiver(receivers, new Map(receivers.map(item => [item.id, 3])))).toBeUndefined()
  })

  it('parses one or many phone and URL delivery lines by the first separator', () => {
    const parsed = parseSmsReceiverImportText([
      '16232130689|https://eim388.top/api/sms/access?token=first|second',
      '',
      ' 14103012139 | https://eim388.top/api/sms/access?token=third '
    ].join('\r\n'))
    expect(parsed.failed).toEqual([])
    expect(parsed.candidates).toHaveLength(2)
    expect(parsed.candidates[0]).toMatchObject({ line: 1, phone: '+1(623)2130689', phoneKey: '16232130689' })
    expect(parsed.candidates[0]?.url.searchParams.get('token')).toBe('first|second')
    expect(parsed.candidates[1]).toMatchObject({ line: 3, phone: '+1(410)3012139', phoneKey: '14103012139' })
  })

  it('reports malformed delivery lines without exposing a different line as failed', () => {
    const parsed = parseSmsReceiverImportText([
      'missing-separator',
      '1623213068x|https://eim388.top/api/sms/access?token=redacted',
      '14103012139|ftp://eim388.top/code'
    ].join('\n'))
    expect(parsed.candidates).toEqual([])
    expect(parsed.failed.map(item => ({ line: item.line, phone: item.phone }))).toEqual([
      { line: 1, phone: null },
      { line: 2, phone: '1623213068x' },
      { line: 3, phone: '14103012139' }
    ])
  })
})

describe('SMS provider response parsing', () => {
  it('extracts verification codes from JSON and plaintext messages', () => {
    expect(parseSmsProviderResponse(
      JSON.stringify({ ok: true, data: { content: 'Your verification code is 839201.' } }),
      'application/json'
    ).code).toBe('839201')
    expect(parseSmsProviderResponse('【OpenAI】您的验证码为 472915，请勿泄露。').code).toBe('472915')
    expect(parseSmsProviderResponse('YES|您的 OpenAI 验证代码是：951371|2026-08-02 17:52:22')).toMatchObject({
      code: '951371',
      message: 'YES|您的 OpenAI 验证代码是：951371|2026-08-02 17:52:22'
    })
  })

  it('keeps no-message and expired responses free of false codes', () => {
    expect(parseSmsProviderResponse('{"ok":true,"status":"no","message":"暂无短信"}', 'application/json')).toMatchObject({
      code: null,
      message: '暂无短信'
    })
    expect(parseSmsProviderResponse('已过期')).toMatchObject({ code: null, message: '已过期' })
    expect(parseSmsProviderResponse('最后更新：2026-08-02 16:30')).toMatchObject({ code: null })
    expect(parseSmsProviderResponse('暂无短信|链接到期时间2026-08-30 11:59:59，续费请提前联系客服')).toMatchObject({
      code: null,
      message: '暂无短信|链接到期时间2026-08-30 11:59:59，续费请提前联系客服'
    })
  })

  it('supports the eim response format and accepts exactly six consecutive digits', () => {
    expect(parseSmsProviderResponse('no sms-2026-09-05 11:00').code).toBeNull()
    expect(parseSmsProviderResponse('839201-2026-09-05 11:00').code).toBe('839201')
    expect(parseSmsProviderResponse('83920-2026-09-05 11:00').code).toBeNull()
    expect(parseSmsProviderResponse('8392017-2026-09-05 11:00').code).toBeNull()
    expect(parseSmsProviderResponse(JSON.stringify({ code: 624910 }), 'application/json').code).toBe('624910')
  })

  it('does not mistake phone numbers, timestamps, URLs, or ambiguous values for a code', () => {
    expect(parseSmsProviderResponse('phone=16232130689').code).toBeNull()
    expect(parseSmsProviderResponse('+1(623)2130689').code).toBeNull()
    expect(parseSmsProviderResponse('fetched_at=1786152904').code).toBeNull()
    expect(parseSmsProviderResponse('token=123456').code).toBeNull()
    expect(parseSmsProviderResponse('https://eim388.top/api/sms/access?id=123456').code).toBeNull()
    expect(parseSmsProviderResponse('候选 123456，历史 654321').code).toBeNull()
    expect(parseSmsProviderResponse(JSON.stringify({ code: '123456', data: { otp: '654321' } }), 'application/json').code).toBeNull()
  })
})
