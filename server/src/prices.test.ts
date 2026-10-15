import { describe, it, expect } from 'vitest'
import { parseTicker } from './prices'

describe('parseTicker (Coinbase /products/ETH-EUR/ticker)', () => {
  it('reads the last trade price', () => {
    expect(parseTicker({ ask: '2095.34', bid: '2094.69', price: '2095.34', time: '2026-10-15T06:14:29Z' })).toBe(2095.34)
  })

  it('rejects missing, zero and non-numeric prices', () => {
    expect(parseTicker({})).toBeNull()
    expect(parseTicker(null)).toBeNull()
    expect(parseTicker({ price: '0' })).toBeNull()
    expect(parseTicker({ price: 'n/a' })).toBeNull()
    expect(parseTicker({ message: 'NotFound' })).toBeNull()
  })
})
