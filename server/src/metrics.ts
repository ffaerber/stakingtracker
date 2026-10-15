// Prometheus exposition of the same numbers the dashboard and report show.
//
// Everything comes from persisted data (SQLite), never from the nodes, so a
// scrape costs no beacon/execution requests. The report math is not free, so
// the rendered text is cached briefly; collection only runs every ~12 h anyway.

import { GWEI_PER_ETH } from './engine/rewards'
import { buildReport, availableYears, summary } from './report'
import { getValidators, getBalances, getPriceMap } from './store'
import { loadSettings } from './settings'
import { collectorStatus } from './collector'
import type { TaxMethod } from './engine/taxReport'

export interface Sample {
  name: string
  help: string
  type: 'gauge' | 'counter'
  values: { labels?: Record<string, string | number>; value: number }[]
}

function esc(v: string | number): string {
  return String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

/** Render samples in the Prometheus text exposition format (0.0.4). */
export function render(samples: Sample[]): string {
  const out: string[] = []
  for (const s of samples) {
    if (!s.values.length) continue
    out.push(`# HELP ${s.name} ${s.help}`, `# TYPE ${s.name} ${s.type}`)
    for (const { labels, value } of s.values) {
      const l = labels && Object.keys(labels).length
        ? `{${Object.entries(labels).map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}`
        : ''
      out.push(`${s.name}${l} ${Number.isFinite(value) ? value : 'NaN'}`)
    }
  }
  return out.join('\n') + '\n'
}

async function collectSamples(): Promise<Sample[]> {
  const s = await loadSettings()
  const sum = await summary()
  const cur = s.currency
  const g = (name: string, help: string, values: Sample['values']): Sample => ({ name, help, type: 'gauge', values })

  const perValidator = getValidators().map((v) => {
    const b = getBalances(v.index)
    const last = b[b.length - 1]
    return { labels: { validator: v.index }, value: last ? last.balanceGwei / GWEI_PER_ETH : 0 }
  })

  const income: Sample['values'] = []
  const incomeFiat: Sample['values'] = []
  for (const year of availableYears()) {
    for (const method of ['accrual', 'receipt'] as TaxMethod[]) {
      const r = await buildReport(year, method)
      income.push(
        { labels: { year, method, kind: 'consensus' }, value: r.totalIncomeEth },
        { labels: { year, method, kind: 'execution' }, value: r.totalExecutionEth },
      )
      incomeFiat.push(
        { labels: { year, method, kind: 'consensus', currency: cur }, value: r.totalIncomeEur },
        { labels: { year, method, kind: 'execution', currency: cur }, value: r.totalExecutionEur },
      )
    }
  }

  const prices = getPriceMap(cur)
  const lastPriceDate = Object.keys(prices).sort().pop()
  const c = collectorStatus()

  return [
    g('stakingtracker_validators', 'Number of tracked validators.', [{ value: sum.validators }]),
    g('stakingtracker_balance_eth', 'Sum of the latest stored daily balances, in ETH.', [{ value: sum.currentBalanceEth }]),
    g('stakingtracker_validator_balance_eth', 'Latest stored daily balance per validator, in ETH.', perValidator),
    g('stakingtracker_withdrawn_eth', 'All withdrawals seen in the scanned range, in ETH (incl. exit principal).', [{ value: sum.totalWithdrawnEth }]),
    g('stakingtracker_lifetime_rewards_eth', 'Balance + withdrawals − 32 ETH per validator, in ETH.', [{ value: sum.lifetimeEth }]),
    g('stakingtracker_el_blocks', 'Proposed blocks with an execution-layer reward on record.', [{ value: sum.elBlocks }]),
    g('stakingtracker_income_eth', 'Income per tax year, in ETH (consensus = staking rewards, execution = tips + MEV).', income),
    g('stakingtracker_income_fiat', 'Income per tax year valued at the daily price, in the configured currency.', incomeFiat),
    g('stakingtracker_monthly_income_eth', 'Reward income per month (receipt basis), in ETH.', sum.monthlyAccrual.map((m) => ({ labels: { month: m.date }, value: m.eth }))),
    g('stakingtracker_eth_price', 'Latest stored ETH price in the configured currency.', lastPriceDate ? [{ labels: { currency: cur, date: lastPriceDate }, value: prices[lastPriceDate] }] : []),
    g('stakingtracker_last_collect_timestamp_seconds', 'Unix time of the last completed collection.', [{ value: sum.lastCollectedAt ? sum.lastCollectedAt / 1000 : 0 }]),
    g('stakingtracker_collector_running', '1 while a collection is running.', [{ value: c.running ? 1 : 0 }]),
    g('stakingtracker_collector_error', '1 if the last collection ended with an error.', [{ value: c.lastError ? 1 : 0 }]),
    g('stakingtracker_scan_pending_blocks', 'Execution blocks left to scan for withdrawals.', [{ value: sum.pendingBlocks }]),
  ]
}

const TTL_MS = 5 * 60 * 1000
let cache: { at: number; text: string } | null = null

export async function metricsText(now = Date.now()): Promise<string> {
  if (cache && now - cache.at < TTL_MS) return cache.text
  const text = render(await collectSamples())
  cache = { at: now, text }
  return text
}
