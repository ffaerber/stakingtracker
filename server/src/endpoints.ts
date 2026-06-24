// External API endpoint builders. Reward data comes from the user's own beacon
// node (see beacon.ts); only price data is external. We use Coinbase's keyless
// candles API — full history (no 365-day cap), max 300 candles per request.

export const COINBASE_BASE = 'https://api.exchange.coinbase.com'

export const coinbase = {
  candles: (product: string, granularity: number, startIso: string, endIso: string) =>
    `${COINBASE_BASE}/products/${product}/candles?granularity=${granularity}&start=${startIso}&end=${endIso}`,
}
