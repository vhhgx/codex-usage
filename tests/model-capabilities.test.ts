import { describe, expect, it } from 'vitest'
import { supportsImagePricing } from '../shared/utils/model-capabilities'

describe('model image pricing capability', () => {
  it('uses explicit image endpoints regardless of the model name', () => {
    expect(supportsImagePricing('custom-renderer', [['/v1/images/generations']])).toBe(true)
    expect(supportsImagePricing('custom-editor', [['/v1/images/edits']])).toBe(true)
  })

  it('does not classify audio and realtime models as image models', () => {
    expect(supportsImagePricing('gpt-4o-audio-preview', [[]])).toBe(false)
    expect(supportsImagePricing('gpt-4o-realtime-preview', [[]])).toBe(false)
  })

  it('recognizes established image families for unrestricted legacy mappings', () => {
    expect(supportsImagePricing('gpt-image-1.5', [[]])).toBe(true)
    expect(supportsImagePricing('dall-e-3', [[]])).toBe(true)
    expect(supportsImagePricing('gemini-2.5-flash-image-preview', [[]])).toBe(true)
  })

  it('honors an explicit non-image endpoint restriction', () => {
    expect(supportsImagePricing('gpt-image-1', [['/v1/responses']])).toBe(false)
  })
})
