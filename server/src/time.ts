// Ethereum mainnet beacon-chain time helpers, shared across clients.

export const MAINNET_GENESIS = 1606824023 // unix seconds
export const SECONDS_PER_SLOT = 12
export const SLOTS_PER_EPOCH = 32
// First post-merge slot (Sept 15 2022). Execution-layer block rewards don't
// exist before this, so proposal scans never need to go earlier.
export const MAINNET_MERGE_SLOT = 4_700_013
export const SLOTS_PER_DAY = (24 * 60 * 60) / SECONDS_PER_SLOT // 7200

export function slotToUnix(slot: number): number {
  return MAINNET_GENESIS + slot * SECONDS_PER_SLOT
}

export function epochToUnix(epoch: number): number {
  return MAINNET_GENESIS + epoch * SLOTS_PER_EPOCH * SECONDS_PER_SLOT
}

/** Slot active at a given unix time (floored). Negative before genesis. */
export function unixToSlot(unixSec: number): number {
  return Math.floor((unixSec - MAINNET_GENESIS) / SECONDS_PER_SLOT)
}

export function isoFromUnix(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10)
}

/** Unix seconds for the final second of a UTC day (YYYY-MM-DD). */
export function endOfUtcDay(isoDate: string): number {
  return Math.floor(new Date(isoDate + 'T23:59:59Z').getTime() / 1000)
}

/** Inclusive list of UTC ISO dates from `startIso` to `endIso`. */
export function dateRange(startIso: string, endIso: string): string[] {
  const out: string[] = []
  const d = new Date(startIso + 'T00:00:00Z')
  const end = new Date(endIso + 'T00:00:00Z')
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}
