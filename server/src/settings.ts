// App config. Every setting comes from environment variables (with sensible
// defaults for the homelab Swarm deployment). There is no UI to change them, so
// the whole config is pinned declaratively in docker-compose.

export interface Settings {
  /** Standard Beacon Node API base URL (the user's archive node). */
  beaconUrl: string
  /** Execution JSON-RPC URL (optional; for the withdrawal-address balance). */
  executionUrl: string
  /** Validator indices to track. */
  validatorIds: number[]
  currency: string
}

const DEFAULTS: Settings = {
  // Internal Swarm address — the backend reaches the private node directly.
  beaconUrl: 'http://mainnet-lighthouse:5052',
  executionUrl: 'http://mainnet-geth:8545',
  validatorIds: [],
  currency: 'eur',
}

function envOverrides(): Partial<Settings> {
  const o: Partial<Settings> = {}
  if (process.env.STT_BEACON_URL) o.beaconUrl = process.env.STT_BEACON_URL.replace(/\/+$/, '')
  if (process.env.STT_EXECUTION_URL) o.executionUrl = process.env.STT_EXECUTION_URL.replace(/\/+$/, '')
  if (process.env.STT_CURRENCY) o.currency = process.env.STT_CURRENCY.toLowerCase()
  if (process.env.STT_VALIDATORS) {
    o.validatorIds = process.env.STT_VALIDATORS.split(/[\s,]+/)
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0)
  }
  return o
}

let cached: Settings | null = null

export async function loadSettings(): Promise<Settings> {
  if (cached) return cached
  cached = { ...DEFAULTS, ...envOverrides() }
  return cached
}
