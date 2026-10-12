import { describe, it, expect } from 'vitest'
import { daysToSample } from './sampling'

const days = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']
const all = () => 3

describe('daysToSample', () => {
  it('skips complete past days and re-samples only the last two', () => {
    const stored = new Map(days.map((d) => [d, 3]))
    expect(daysToSample(days, stored, all)).toEqual(['2026-10-11', '2026-10-12'])
  })

  it('samples a past day that is missing entirely', () => {
    const stored = new Map(days.map((d) => [d, 3]))
    stored.delete('2026-10-09')
    expect(daysToSample(days, stored, all)).toEqual(['2026-10-09', '2026-10-11', '2026-10-12'])
  })

  it('samples a past day stored for only some validators', () => {
    const stored = new Map(days.map((d) => [d, 3]))
    stored.set('2026-10-08', 2)
    expect(daysToSample(days, stored, all)).toEqual(['2026-10-08', '2026-10-11', '2026-10-12'])
  })

  it('counts only validators active on that day', () => {
    // One validator activated on 2026-10-10: two rows suffice before that.
    const active = (d: string) => (d < '2026-10-10' ? 2 : 3)
    const stored = new Map([['2026-10-08', 2], ['2026-10-09', 2], ['2026-10-10', 3], ['2026-10-11', 3], ['2026-10-12', 3]])
    expect(daysToSample(days, stored, active)).toEqual(['2026-10-11', '2026-10-12'])
  })

  it('samples everything on a fresh database', () => {
    expect(daysToSample(days, new Map(), all)).toEqual(days)
  })
})
