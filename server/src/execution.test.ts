import { describe, it, expect } from 'vitest'
import { balanceDeltaReward } from './execution'

const ETH = 1_000_000_000_000_000_000n

describe('balanceDeltaReward', () => {
  it('uses the raw balance delta when the fee recipient spends nothing', () => {
    // Vanilla block: priority fees credited straight to the coinbase.
    expect(balanceDeltaReward(5n * ETH, 4n * ETH, 0n)).toBe(ETH)
  })

  it('keeps the MEV-boost payment (incoming transfer is not subtracted)', () => {
    // Builder pays the proposer 0.1 ETH via the final tx → shows up in the delta.
    expect(balanceDeltaReward(10n * ETH + ETH / 10n, 10n * ETH, 0n)).toBe(ETH / 10n)
  })

  it('adds back gas + value the fee recipient spent in its own block', () => {
    // Delta looks like -0.4 ETH because the recipient sent 0.5 ETH (0.4 value +
    // 0.1 gas) but also earned 0.1 ETH of reward in the same block.
    const post = 10n * ETH - 4n * (ETH / 10n)
    const pre = 10n * ETH
    const ownSpend = 4n * (ETH / 10n) + ETH / 10n // 0.4 value + 0.1 gas
    expect(balanceDeltaReward(post, pre, ownSpend)).toBe(ETH / 10n)
  })

  it('subtracts credited withdrawals so skims to the fee recipient are not counted', () => {
    // +1 ETH balance delta, but 0.9 ETH of it was an EIP-4895 withdrawal to the
    // fee recipient (counted as consensus income) → only 0.1 ETH is EL reward.
    expect(balanceDeltaReward(11n * ETH, 10n * ETH, 0n, 9n * (ETH / 10n))).toBe(ETH / 10n)
  })

  it('clamps negative results to zero', () => {
    expect(balanceDeltaReward(1n * ETH, 2n * ETH, 0n)).toBe(0n)
  })
})
