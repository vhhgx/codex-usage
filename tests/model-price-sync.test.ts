import { describe, expect, it } from 'vitest'
import { normalizeSub2ApiModelPrice } from '../server/services/model-price-sync'

describe('Sub2API model price import', () => {
  it('converts per-token prices to the Hub per-million unit', () => {
    expect(normalizeSub2ApiModelPrice({
      found: true,
      input_price: 0.00000175,
      output_price: 0.000014,
      cache_read_price: 0.000000175,
      cache_write_price: 0,
      image_input_price: 0,
      image_output_price: 0
    }, {})).toMatchObject({
      inputPerMillion: '1.75',
      outputPerMillion: '14',
      cachedPerMillion: '0.175',
      reasoningPerMillion: '14'
    })
  })

  it('preserves fixed image prices and flags unsupported image-token pricing', () => {
    const imagePrices = { '1024x1024:high': 0.08 }
    expect(normalizeSub2ApiModelPrice({
      found: true,
      input_price: 0.000005,
      output_price: 0,
      cache_read_price: 0.00000125,
      image_input_price: 0.00001,
      image_output_price: 0.00004
    }, imagePrices)).toMatchObject({ imagePrices, hasUnmappedImageTokenPrice: true })
  })

  it('skips models absent from the upstream pricing catalog', () => {
    expect(normalizeSub2ApiModelPrice({ found: false }, {})).toBeNull()
  })
})
