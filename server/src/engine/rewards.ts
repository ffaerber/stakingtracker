import type { BalanceDay, WithdrawalEvent, ExecutionReward } from '../types'

// Pure reward-computation functions. No I/O — fully unit-testable.

export const GWEI_PER_ETH = 1_000_000_000
export const WEI_PER_ETH = 1_000_000_000_000_000_000

export interface DailyAmount {
  date: string
  eth: number
}

/**
 * Lifetime rewards (ETH) sanity check for a set of validators:
 *   (current balance + everything withdrawn) − (32 ETH × deposits).
 * Assumes the standard 32 ETH initial deposit per validator.
 */
export function lifetimeRewardsEth(
  currentBalanceGwei: number,
  totalWithdrawnGwei: number,
  depositCount: number,
): number {
  return (currentBalanceGwei + totalWithdrawnGwei) / GWEI_PER_ETH - 32 * depositCount
}

/**
 * Daily accrued consensus income (ETH) for ONE validator.
 *
 * Income on day D = balance(D) − balance(D−1) + withdrawals credited in
 * (date(D−1), date(D)]. Withdrawals lower the balance, so adding them back
 * recovers the reward actually earned that day.
 *
 * The first observed balance has no predecessor, so no income is emitted for
 * it — that pre-observation period is reported as a data gap elsewhere.
 */
export function validatorAccrual(
  balances: BalanceDay[],
  vWithdrawals: WithdrawalEvent[],
): DailyAmount[] {
  if (balances.length < 2) return []
  const sorted = [...balances].sort((a, b) => a.epoch - b.epoch)
  const wByDate = [...vWithdrawals].sort((a, b) => a.timestamp - b.timestamp)

  const out: DailyAmount[] = []
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    const deltaGwei = cur.balanceGwei - prev.balanceGwei
    let withdrawnGwei = 0
    for (const w of wByDate) {
      if (w.date > prev.date && w.date <= cur.date) withdrawnGwei += w.amountGwei
    }
    const incomeGwei = deltaGwei + withdrawnGwei
    out.push({ date: cur.date, eth: incomeGwei / GWEI_PER_ETH })
  }
  return out
}

/** Sum per-day amounts across validators into a single date-keyed series. */
export function aggregateByDate(series: DailyAmount[]): DailyAmount[] {
  const map = new Map<string, number>()
  for (const { date, eth } of series) {
    map.set(date, (map.get(date) ?? 0) + eth)
  }
  return [...map.entries()]
    .map(([date, eth]) => ({ date, eth }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** Receipt income: one entry per withdrawal event (ETH), gross of principal. */
export function receiptIncome(events: WithdrawalEvent[]): DailyAmount[] {
  return events
    .map((w) => ({ date: w.date, eth: w.amountGwei / GWEI_PER_ETH }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Taxable reward income from withdrawals, excluding returned principal.
 * Partial "skim" withdrawals are pure rewards. A full exit withdrawal also
 * returns the validator's deposit, so we subtract it: any withdrawal
 * ≥ `fullThresholdEth` is treated as an exit and contributes only
 * `max(0, amount − principalEth)`. (Tuned for 0x01 validators: skims are tiny,
 * exits ≈ 32 ETH.)
 */
export function withdrawalRewardIncome(
  events: WithdrawalEvent[],
  { fullThresholdEth = 16, principalEth = 32 }: { fullThresholdEth?: number; principalEth?: number } = {},
): DailyAmount[] {
  return events
    .map((w) => {
      const eth = w.amountGwei / GWEI_PER_ETH
      const income = eth >= fullThresholdEth ? Math.max(0, eth - principalEth) : eth
      return { date: w.date, eth: income }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** Execution-layer income: one entry per proposed block (ETH). */
export function executionIncome(events: ExecutionReward[]): DailyAmount[] {
  return events
    .map((e) => ({ date: e.date, eth: weiToEth(e.rewardWei) }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** Convert a wei bigint to an ETH number (precision sufficient for reporting). */
export function weiToEth(wei: bigint): number {
  // Split to keep precision: integer ETH + fractional gwei.
  const whole = wei / BigInt(WEI_PER_ETH)
  const frac = wei % BigInt(WEI_PER_ETH)
  return Number(whole) + Number(frac) / WEI_PER_ETH
}
