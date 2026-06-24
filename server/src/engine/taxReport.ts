import type { IncomeRow, DataGap } from '../types'
import type { DailyAmount } from './rewards'
import { priceFor, type PriceMap } from '../prices'

// Combines reward series with a fiat price map into a year-scoped tax report.

export type TaxMethod = 'accrual' | 'receipt'

export interface TaxReport {
  year: number
  method: TaxMethod
  currency: string
  rows: IncomeRow[]
  /** Execution-layer rewards are always listed separately. */
  executionRows: IncomeRow[]
  totalIncomeEth: number
  totalIncomeEur: number
  totalExecutionEth: number
  totalExecutionEur: number
  gaps: DataGap[]
}

function priceRows(
  series: DailyAmount[],
  kind: IncomeRow['kind'],
  prices: PriceMap,
  year: number,
  note?: string,
): IncomeRow[] {
  return series
    .filter((d) => Number(d.date.slice(0, 4)) === year)
    .map((d) => {
      const price = priceFor(prices, d.date)
      return {
        date: d.date,
        kind,
        amountEth: d.eth,
        priceEur: price,
        valueEur: price != null ? d.eth * price : null,
        // Zero-filled empty days carry no note (nothing happened that day).
        note: d.eth !== 0 ? note : undefined,
      }
    })
}

/** Expand a sparse daily series to one entry per day in `days` (0 if absent). */
function fillDays(series: DailyAmount[], days: string[]): DailyAmount[] {
  const byDate = new Map<string, number>()
  for (const d of series) byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.eth)
  return days.map((date) => ({ date, eth: byDate.get(date) ?? 0 }))
}

function sum(rows: IncomeRow[], pick: (r: IncomeRow) => number | null): number {
  return rows.reduce((acc, r) => acc + (pick(r) ?? 0), 0)
}

/**
 * Build a tax report for one year. `income` is the chosen-method daily series
 * (accrual or receipt); `execution` is always reported separately. When `days`
 * is given, the income table shows one row per day in that range (zero-filled),
 * so the report is continuous rather than only listing days with activity.
 */
export function buildTaxReport(args: {
  year: number
  method: TaxMethod
  currency: string
  income: DailyAmount[]
  execution: DailyAmount[]
  prices: PriceMap
  gaps?: DataGap[]
  days?: string[]
}): TaxReport {
  const { year, method, currency, income, execution, prices, days } = args
  const note = method === 'receipt' ? 'On withdrawal' : 'Daily accrual'
  const incomeSeries = days?.length ? fillDays(income, days) : income
  const rows = priceRows(incomeSeries, method === 'receipt' ? 'withdrawal' : 'accrual', prices, year, note)
  const executionRows = priceRows(execution, 'execution', prices, year, 'EL reward (fee recipient may differ)')

  const gaps = [...(args.gaps ?? [])]
  // Zero-filled empty days have no real value, so a missing price there is
  // harmless — only flag missing prices on days that actually had income.
  const missingPrice = [...rows, ...executionRows].some((r) => r.amountEth !== 0 && r.priceEur == null)
  if (missingPrice) {
    gaps.push({ message: 'Some dates had no ETH/EUR price available; those rows are unpriced.' })
  }

  return {
    year,
    method,
    currency,
    rows,
    executionRows,
    totalIncomeEth: sum(rows, (r) => r.amountEth),
    totalIncomeEur: sum(rows, (r) => r.valueEur),
    totalExecutionEth: sum(executionRows, (r) => r.amountEth),
    totalExecutionEur: sum(executionRows, (r) => r.valueEur),
    gaps,
  }
}

/** CSV with one row per income event. Amounts use '.' decimals. */
export function reportToCsv(report: TaxReport): string {
  const header = ['date', 'kind', 'amount_eth', `price_${report.currency}`, `value_${report.currency}`, 'note']
  const all = [...report.rows, ...report.executionRows].sort((a, b) => a.date.localeCompare(b.date))
  const lines = all.map((r) =>
    [
      r.date,
      r.kind,
      r.amountEth.toFixed(9),
      r.priceEur != null ? r.priceEur.toFixed(2) : '',
      r.valueEur != null ? r.valueEur.toFixed(2) : '',
      r.note ? `"${r.note.replace(/"/g, '""')}"` : '',
    ].join(','),
  )
  return [header.join(','), ...lines].join('\n')
}
