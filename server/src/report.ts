import {
  validatorAccrual,
  withdrawalRewardIncome,
  executionIncome,
  aggregateByDate,
  GWEI_PER_ETH,
  type DailyAmount,
} from './engine/rewards'
import { buildTaxReport, type TaxMethod, type TaxReport } from './engine/taxReport'
import {
  getValidators,
  getBalances,
  getWithdrawals,
  getBalanceTotalsByDate,
  getPriceMap,
  getExecutions,
} from './store'
import { loadSettings } from './settings'
import { getMeta } from './db'
import { dateRange, isoFromUnix, slotToUnix } from './time'
import type { DataGap } from './types'

// Reports from PERSISTED data (no network). For 0x01 skimming validators the
// receipt (withdrawals) basis is exact; accrual = balance delta + withdrawals,
// which fills in as daily balances accumulate.

function accrualSeries(): DailyAmount[] {
  const wds = getWithdrawals()
  const parts: DailyAmount[] = []
  for (const v of getValidators()) {
    parts.push(...validatorAccrual(getBalances(v.index), wds.filter((w) => w.validatorIndex === v.index)))
  }
  return aggregateByDate(parts)
}

function receiptSeries(): DailyAmount[] {
  // Reward income only — full exit withdrawals have their 32 ETH principal removed.
  return withdrawalRewardIncome(getWithdrawals())
}

function gaps(): DataGap[] {
  const out: DataGap[] = []
  const from = getMeta('wd_scan_from')
  const cur = Number(getMeta('wd_cursor') ?? 0)
  const head = Number(getMeta('wd_head') ?? 0)
  if (from) {
    const scanning = head > 0 && cur < head ? ` (scanned to block ${cur}/${head} — still in progress)` : ''
    out.push({
      message: `Withdrawals scanned from block ${from}${scanning}. Anything before that block isn't included — lower STT_SCAN_FROM_BLOCK to extend history.`,
    })
  }
  out.push({
    message:
      'Receipt income = withdrawal rewards only; full exit withdrawals (≥16 ETH) have their 32 ETH principal excluded as return of capital, not income.',
  })
  out.push({
    message:
      'Execution-layer rewards = the fee-recipient balance change per proposed block (priority fees + MEV-boost payment).',
  })

  // Proposal-scan coverage. The scan runs newest-first, so [prop_low, prop_high]
  // is the covered slot window; older history backfills toward prop_floor.
  const propLow = getMeta('prop_low')
  const propHigh = getMeta('prop_high')
  if (propLow && propHigh) {
    const lowDate = isoFromUnix(slotToUnix(Number(propLow)))
    const highDate = isoFromUnix(slotToUnix(Number(propHigh)))
    const floor = Number(getMeta('prop_floor') ?? 0)
    const backfilling = floor > 0 && Number(propLow) > floor
    out.push({
      message:
        `Execution-layer rewards collected for ${lowDate} → ${highDate}.` +
        (backfilling
          ? ` Still backfilling older history toward ${isoFromUnix(slotToUnix(floor))} — re-run Collect to continue.`
          : ''),
    })
  }
  if (getExecutions().some((e) => e.method === 'priority-fees')) {
    out.push({
      message:
        'Some proposed blocks were valued from priority fees only (the execution node could not serve historical balances). Those can undercount MEV-boost rewards — use an archive execution node, then re-scan, for exact figures.',
    })
  }
  return out
}

/**
 * Calendar days to show in the report for `year`: continuous from the first day
 * we have any collected data (so we don't invent zero-days before the validator
 * existed / before collection began) to the year end, capped at today.
 */
function reportDays(year: number): string[] {
  const all = [
    ...getBalanceTotalsByDate().map((d) => d.date),
    ...getWithdrawals().map((w) => w.date),
    ...getExecutions().map((e) => e.date),
  ].sort()
  if (!all.length) return []
  const today = isoFromUnix(Math.floor(Date.now() / 1000))
  const start = all[0] > `${year}-01-01` ? all[0] : `${year}-01-01`
  const end = `${year}-12-31` < today ? `${year}-12-31` : today
  return start <= end ? dateRange(start, end) : []
}

export async function buildReport(year: number, method: TaxMethod): Promise<TaxReport> {
  const s = await loadSettings()
  return buildTaxReport({
    year,
    method,
    currency: s.currency,
    income: method === 'accrual' ? accrualSeries() : receiptSeries(),
    execution: executionIncome(getExecutions()),
    prices: getPriceMap(s.currency),
    gaps: gaps(),
    days: reportDays(year),
  })
}

export function availableYears(): number[] {
  const years = new Set<number>()
  for (const w of getWithdrawals()) years.add(Number(w.date.slice(0, 4)))
  for (const r of getBalanceTotalsByDate()) years.add(Number(r.date.slice(0, 4)))
  for (const e of getExecutions()) years.add(Number(e.date.slice(0, 4)))
  return [...years].sort((a, b) => b - a)
}

export async function summary() {
  const validators = getValidators()
  const balTotals = getBalanceTotalsByDate()
  const currentBalanceGwei = balTotals.length ? balTotals[balTotals.length - 1].gwei : 0
  const totalWithdrawnGwei = getWithdrawals().reduce((sum, w) => sum + w.amountGwei, 0)
  const lifetimeEth = (currentBalanceGwei + totalWithdrawnGwei) / GWEI_PER_ETH - 32 * validators.length

  // Withdrawals only exist post-Shapella; covering full history means scanning
  // from at or before that block. "Caught up to head" alone isn't enough.
  const SHAPELLA_BLOCK = 17_034_870
  const scanFromBlock = Number(getMeta('wd_scan_from') ?? 0)
  const scanCursor = Number(getMeta('wd_cursor') ?? 0)
  const scanHead = Number(getMeta('wd_head') ?? 0)
  const caughtUp = scanHead > 0 && scanCursor >= scanHead
  const coversFullHistory = scanFromBlock > 0 && scanFromBlock <= SHAPELLA_BLOCK
  const historyComplete = caughtUp && coversFullHistory
  const pendingBlocks = Math.max(0, scanHead - scanCursor)

  return {
    validators: validators.length,
    lifetimeEth,
    totalWithdrawnEth: totalWithdrawnGwei / GWEI_PER_ETH,
    currentBalanceEth: currentBalanceGwei / GWEI_PER_ETH,
    elBlocks: getExecutions().length,
    years: availableYears(),
    monthlyAccrual: monthly(receiptSeries()),
    lastCollectedAt: Number(getMeta('last_collected_at') ?? 0) || null,
    scanFromBlock,
    scanCursor,
    scanHead,
    pendingBlocks,
    caughtUp,
    coversFullHistory,
    historyComplete,
  }
}

function monthly(series: DailyAmount[]): { date: string; eth: number }[] {
  const map = new Map<string, number>()
  for (const d of series) {
    const m = d.date.slice(0, 7)
    map.set(m, (map.get(m) ?? 0) + d.eth)
  }
  return [...map.entries()].map(([date, eth]) => ({ date, eth })).sort((a, b) => a.date.localeCompare(b.date))
}
