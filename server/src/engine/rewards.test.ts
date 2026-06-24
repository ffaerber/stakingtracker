import { describe, it, expect } from 'vitest'
import {
  lifetimeRewardsEth,
  validatorAccrual,
  aggregateByDate,
  receiptIncome,
  executionIncome,
  weiToEth,
  GWEI_PER_ETH,
} from './rewards'
import { buildTaxReport, reportToCsv } from './taxReport'
import type { BalanceDay, WithdrawalEvent, ExecutionReward } from '../types'

function bal(epoch: number, date: string, eth: number): BalanceDay {
  return { epoch, date, timestamp: 0, balanceGwei: eth * GWEI_PER_ETH }
}
function wd(date: string, eth: number, ts = 0): WithdrawalEvent {
  return {
    validatorIndex: 1,
    epoch: 0,
    slot: 0,
    timestamp: ts,
    date,
    amountGwei: eth * GWEI_PER_ETH,
    address: '0xabc',
  }
}

describe('lifetimeRewardsEth', () => {
  it('balance + withdrawn - 32 per validator', () => {
    // 33 ETH balance, 1.5 ETH withdrawn, 1 validator => 2.5 ETH rewards.
    expect(lifetimeRewardsEth(33 * GWEI_PER_ETH, 1.5 * GWEI_PER_ETH, 1)).toBeCloseTo(2.5, 9)
  })
  it('handles multiple validators', () => {
    expect(lifetimeRewardsEth(64 * GWEI_PER_ETH, 0, 2)).toBeCloseTo(0, 9)
  })
})

describe('validatorAccrual', () => {
  it('income = balance delta for a simple growing balance', () => {
    const balances = [bal(1, '2024-01-01', 32), bal(2, '2024-01-02', 32.01), bal(3, '2024-01-03', 32.03)]
    const out = validatorAccrual(balances, [])
    expect(out).toEqual([
      { date: '2024-01-02', eth: expect.closeTo(0.01, 9) },
      { date: '2024-01-03', eth: expect.closeTo(0.02, 9) },
    ])
  })

  it('adds back withdrawals that lowered the balance', () => {
    // Balance flat at 32 because 0.02 was withdrawn => real income 0.02.
    const balances = [bal(1, '2024-01-01', 32), bal(2, '2024-01-02', 32)]
    const out = validatorAccrual(balances, [wd('2024-01-02', 0.02)])
    expect(out).toEqual([{ date: '2024-01-02', eth: expect.closeTo(0.02, 9) }])
  })

  it('emits nothing with fewer than two snapshots', () => {
    expect(validatorAccrual([bal(1, '2024-01-01', 32)], [])).toEqual([])
  })
})

describe('aggregateByDate', () => {
  it('sums amounts on the same date and sorts', () => {
    const out = aggregateByDate([
      { date: '2024-01-02', eth: 0.01 },
      { date: '2024-01-01', eth: 0.02 },
      { date: '2024-01-02', eth: 0.03 },
    ])
    expect(out).toEqual([
      { date: '2024-01-01', eth: expect.closeTo(0.02, 9) },
      { date: '2024-01-02', eth: expect.closeTo(0.04, 9) },
    ])
  })
})

describe('receipt & execution income', () => {
  it('receiptIncome maps each withdrawal to ETH', () => {
    expect(receiptIncome([wd('2024-03-01', 0.5)])).toEqual([{ date: '2024-03-01', eth: 0.5 }])
  })
  it('executionIncome converts wei reward to ETH', () => {
    const e: ExecutionReward = {
      validatorIndex: 1,
      blockNumber: 100,
      timestamp: 0,
      date: '2024-04-01',
      rewardWei: 50_000_000_000_000_000n, // 0.05 ETH
      feeRecipient: '0xabc',
    }
    expect(executionIncome([e])).toEqual([{ date: '2024-04-01', eth: expect.closeTo(0.05, 9) }])
  })
  it('weiToEth keeps precision for large + fractional values', () => {
    expect(weiToEth(1_500_000_000_000_000_000n)).toBeCloseTo(1.5, 9)
  })
})

describe('buildTaxReport', () => {
  const prices = { '2024-01-02': 2000, '2024-01-03': 2500 }
  const income = [
    { date: '2023-12-31', eth: 1 }, // filtered out (other year)
    { date: '2024-01-02', eth: 0.01 },
    { date: '2024-01-03', eth: 0.02 },
  ]

  it('filters by year, prices rows, and totals', () => {
    const r = buildTaxReport({ year: 2024, method: 'accrual', currency: 'eur', income, execution: [], prices })
    expect(r.rows).toHaveLength(2)
    expect(r.totalIncomeEth).toBeCloseTo(0.03, 9)
    // 0.01*2000 + 0.02*2500 = 20 + 50 = 70
    expect(r.totalIncomeEur).toBeCloseTo(70, 6)
  })

  it('flags a gap when a price is missing', () => {
    const r = buildTaxReport({
      year: 2024,
      method: 'accrual',
      currency: 'eur',
      income: [{ date: '2024-06-01', eth: 0.01 }],
      execution: [],
      prices,
    })
    expect(r.rows[0].valueEur).toBeNull()
    expect(r.gaps.some((g) => /price/i.test(g.message))).toBe(true)
  })

  it('fills empty days with zero-income rows when days are given', () => {
    const r = buildTaxReport({
      year: 2024,
      method: 'receipt',
      currency: 'eur',
      income: [{ date: '2024-01-02', eth: 0.01 }],
      execution: [],
      prices,
      days: ['2024-01-01', '2024-01-02', '2024-01-03'],
    })
    expect(r.rows.map((x) => x.date)).toEqual(['2024-01-01', '2024-01-02', '2024-01-03'])
    expect(r.rows[0].amountEth).toBe(0)
    expect(r.rows[0].note).toBeUndefined() // empty day → no "On withdrawal" note
    expect(r.rows[1].amountEth).toBeCloseTo(0.01, 9)
    expect(r.rows[1].note).toBe('On withdrawal')
    expect(r.totalIncomeEth).toBeCloseTo(0.01, 9) // zero days don't change totals
  })

  it('reportToCsv emits a header and one row per event', () => {
    const r = buildTaxReport({ year: 2024, method: 'accrual', currency: 'eur', income, execution: [], prices })
    const csv = reportToCsv(r)
    const lines = csv.split('\n')
    expect(lines[0]).toContain('date,kind,amount_eth')
    expect(lines).toHaveLength(3) // header + 2 rows
  })
})
