import { coinbase } from './endpoints'
import { getJson } from './http'
import { cacheGet, cacheSet } from './db'

// Daily ETH/fiat close prices from Coinbase's keyless candles API. Full history
// (no 365-day cap). Coinbase returns at most 300 candles per request, so we
// page in ≤290-day windows. Candle row = [time, low, high, open, close, volume].

export type PriceMap = Record<string, number>

function isoFromUnix(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10)
}

const TTL = 24 * 60 * 60 * 1000
const DAY = 86400
const WINDOW = 290 * DAY
// Coinbase rejects requests without a User-Agent.
const HEADERS = { 'User-Agent': 'stakingtracker' }

/** Daily ETH price map (ISO date → close) covering [fromSec, toSec]. */
export async function ethPriceMap(currency: string, fromSec: number, toSec: number): Promise<PriceMap> {
  const product = `ETH-${currency.toUpperCase()}`
  const map: PriceMap = {}
  for (let start = fromSec; start < toSec; start += WINDOW) {
    Object.assign(map, await fetchWindow(product, start, Math.min(start + WINDOW, toSec)))
  }
  return map
}

async function fetchWindow(product: string, fromSec: number, toSec: number): Promise<PriceMap> {
  const key = `cb:${product}:${Math.floor(fromSec / DAY)}:${Math.floor(toSec / DAY)}`
  const hit = await cacheGet<PriceMap>(key, TTL)
  if (hit !== undefined) return hit

  const url = coinbase.candles(product, DAY, new Date(fromSec * 1000).toISOString(), new Date(toSec * 1000).toISOString())
  const rows = await getJson<number[][]>(url, { headers: HEADERS })
  const map: PriceMap = {}
  for (const r of rows) {
    const time = r[0]
    const close = r[4]
    if (close > 0) map[isoFromUnix(time)] = close
  }
  await cacheSet(key, map)
  return map
}

// ---- Spot price -----------------------------------------------------------
// The daily candles above only change when a collection runs (~12 h). For a
// live price (Prometheus/Grafana) the last trade is polled in the background,
// so a metrics scrape never waits on Coinbase. Deliberately not via getJson:
// its queue and long retry backoff suit history paging, not a 60 s poll.

export interface Spot {
  price: number
  currency: string
  /** Unix ms of the successful fetch. */
  at: number
}

let spot: Spot | null = null

export function latestSpot(): Spot | null {
  return spot
}

/** Price from a Coinbase ticker payload, or null if it is missing/invalid. */
export function parseTicker(body: unknown): number | null {
  const p = Number((body as { price?: unknown } | null)?.price)
  return Number.isFinite(p) && p > 0 ? p : null
}

/** Fetch the current ETH price once. A failure keeps the previous value. */
export async function refreshSpot(currency: string, now = Date.now()): Promise<Spot | null> {
  const res = await fetch(coinbase.ticker(`ETH-${currency.toUpperCase()}`), {
    headers: HEADERS,
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) return spot
  const price = parseTicker(await res.json())
  if (price != null) spot = { price, currency, at: now }
  return spot
}

/** Nearest available price for a date, searching back up to 4 days for gaps. */
export function priceFor(map: PriceMap, date: string): number | null {
  if (map[date] != null) return map[date]
  const d = new Date(date + 'T00:00:00Z')
  for (let i = 1; i <= 4; i++) {
    d.setUTCDate(d.getUTCDate() - 1)
    const key = d.toISOString().slice(0, 10)
    if (map[key] != null) return map[key]
  }
  return null
}
