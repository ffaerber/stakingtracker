// Thin client for the backend API. The backend holds the beaconcha.in key and
// all reward logic; the frontend just renders what it returns.

export interface PublicSettings {
  beaconUrl: string
  executionUrl: string
  validatorIds: number[]
  currency: string
}

export interface ValidatorStatus {
  index: number
  /** Beacon consensus status, e.g. 'active_ongoing', 'exited_unslashed'. */
  status: string
  balanceEth: number
  /** true=attested last epoch, false=not online, null=active but unknown. */
  online: boolean | null
}

export interface Status {
  configured: boolean
  lastCollectedAt: number | null
  collector: { running: boolean; lastError: string | null; progress: string; pendingEpochs: number }
}

export interface Summary {
  validators: number
  lifetimeEth: number
  totalWithdrawnEth: number
  currentBalanceEth: number
  elBlocks: number
  years: number[]
  monthlyAccrual: { date: string; eth: number }[]
  lastCollectedAt: number | null
  scanFromBlock: number
  scanCursor: number
  scanHead: number
  pendingBlocks: number
  caughtUp: boolean
  coversFullHistory: boolean
  historyComplete: boolean
}

export interface IncomeRow {
  date: string
  kind: 'accrual' | 'withdrawal' | 'execution'
  amountEth: number
  priceEur: number | null
  valueEur: number | null
  note?: string
}

export interface TaxReport {
  year: number
  method: 'accrual' | 'receipt'
  currency: string
  rows: IncomeRow[]
  executionRows: IncomeRow[]
  totalIncomeEth: number
  totalIncomeEur: number
  totalExecutionEth: number
  totalExecutionEur: number
  gaps: { message: string }[]
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON content-type when we actually send a body — otherwise a
  // bodyless POST (e.g. /api/collect) trips Fastify's FST_ERR_CTP_EMPTY_JSON_BODY.
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body != null ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

export const api = {
  status: () => json<Status>('/api/status'),
  getSettings: () => json<PublicSettings>('/api/settings'),
  validators: () => json<ValidatorStatus[]>('/api/validators'),
  collect: () => json<{ started: boolean }>('/api/collect', { method: 'POST' }),
  summary: () => json<Summary>('/api/summary'),
  report: (year: number, method: 'accrual' | 'receipt') =>
    json<TaxReport>(`/api/report?year=${year}&method=${method}`),
  csvUrl: (year: number, method: 'accrual' | 'receipt') => `/api/report.csv?year=${year}&method=${method}`,
}
