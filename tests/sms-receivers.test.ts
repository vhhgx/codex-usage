import { describe, expect, it } from 'vitest'
import {
  firstAvailableSmsSlot,
  leastLoadedSmsReceiver,
  normalizeSmsPhone,
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
})
