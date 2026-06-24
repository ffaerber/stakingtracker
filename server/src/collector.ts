import { resolveValidators, headSlot, balancesAtSlot, proposerForSlot, executionBlockNumber } from './beacon'
import { getHeadBlock, scanWithdrawals, proposerBlockReward, blockTimestamp } from './execution'
import { ethPriceMap } from './prices'
import {
  upsertValidators,
  upsertBalances,
  upsertWithdrawals,
  upsertExecutions,
  upsertPrices,
  getBalanceTotalsByDate,
  getWithdrawals,
} from './store'
import { loadSettings } from './settings'
import { getMeta, setMeta } from './db'
import { mapLimit } from './http'
import { unixToSlot, endOfUtcDay, isoFromUnix, dateRange, epochToUnix, SLOTS_PER_EPOCH, MAINNET_MERGE_SLOT } from './time'
import type { ExecutionReward } from './types'

// ethstaker.tax-style collection from the user's own nodes:
//  - withdrawals from execution block bodies (Geth) — the income for 0x01
//    skimming validators; no archive/indexer needed,
//  - daily validator balances from the beacon node.
// Reward = balance delta + withdrawals (computed in report.ts).

let running = false
let lastError: string | null = null
let progress = ''

// Default scan window if no start is configured: ~7 days of blocks, enough to
// catch recent skims for a fast first result. Set STT_SCAN_FROM_BLOCK to go
// further back (e.g. the first block of the tax year).
const DEFAULT_LOOKBACK_BLOCKS = 50_000
const MAX_BLOCKS_PER_RUN = Number(process.env.STT_SCAN_MAX ?? 250_000)
// Block-proposal scan is per-slot (one header request each), so it's bounded
// separately and catches up across runs like the withdrawal scan.
const MAX_SLOTS_PER_RUN = Number(process.env.STT_PROP_SCAN_MAX ?? 100_000)
const CONCURRENCY = Number(process.env.STT_CONCURRENCY ?? 12)
// The proposal scan is latency-bound: one tiny beacon header request per slot,
// so it scales with far more in-flight requests than the heavier scans —
// especially against a remote node. Tune up if your node keeps up.
const PROP_CONCURRENCY = Number(process.env.STT_PROP_CONCURRENCY ?? 64)

export function collectorStatus() {
  return { running, lastError, progress }
}

export async function collect(log: (m: string) => void = () => {}): Promise<void> {
  if (running) return
  running = true
  lastError = null
  const note = (m: string) => {
    progress = m
    log(m)
  }
  try {
    const s = await loadSettings()
    if (!s.beaconUrl) throw new Error('No Beacon Node URL configured.')
    if (!s.executionUrl) throw new Error('No Execution RPC URL configured (needed for withdrawals).')
    if (!s.validatorIds.length) throw new Error('No validator indices configured.')

    note('Resolving validators…')
    const vals = await resolveValidators(s.beaconUrl, s.validatorIds)
    if (!vals.length) throw new Error('Beacon node returned no validators for those ids.')
    upsertValidators(vals.map((v) => ({ index: v.index, publickey: v.publickey })))
    const indexSet = new Set(vals.map((v) => v.index))

    // Shared scan window: STT_SCAN_FROM_BLOCK (or a default lookback) bounds how
    // far back balances, withdrawals, and proposals reach, so we don't sample
    // years of history the node can't serve.
    const beaconHead = await headSlot(s.beaconUrl)
    const execHead = await getHeadBlock(s.executionUrl)
    const envStart = Number(process.env.STT_SCAN_FROM_BLOCK ?? 0)
    const startBlock = envStart > 0 ? envStart : Math.max(0, execHead - DEFAULT_LOOKBACK_BLOCKS)
    const startUnix = await blockTimestamp(s.executionUrl, startBlock)
    const scanStartDate = isoFromUnix(startUnix)

    // 1. Daily balances (one slot per UTC day; historical needs an archive node,
    //    recent/today always works and is what accrual needs going forward).
    //    Bounded to the scan window, not the full validator lifetime.
    const startEpoch = Math.min(...vals.map((v) => v.activationEpoch))
    const activationDate = isoFromUnix(epochToUnix(startEpoch))
    const balStart = scanStartDate > activationDate ? scanStartDate : activationDate
    const days = dateRange(balStart, isoFromUnix(Math.floor(Date.now() / 1000)))
    note(`Sampling daily balances (${days.length} days)…`)
    await mapLimit(days, CONCURRENCY, async (date) => {
      const slot = Math.min(unixToSlot(endOfUtcDay(date)), beaconHead)
      const active = vals.filter((v) => v.activationEpoch * SLOTS_PER_EPOCH <= slot)
      if (!active.length) return
      const m = await balancesAtSlot(s.beaconUrl, slot, active.map((v) => v.index))
      if (!m) return
      upsertBalances(
        active.filter((v) => m.get(v.index) != null).map((v) => ({ validatorIdx: v.index, date, balanceGwei: m.get(v.index)! })),
      )
    })

    // 2. Withdrawals from execution blocks, resumable via a block cursor.
    // Optional upper bound, e.g. to scan a single tax year. Defaults to head.
    const envTo = Number(process.env.STT_SCAN_TO_BLOCK ?? 0)
    const upper = envTo > 0 ? Math.min(envTo, execHead) : execHead
    const cursor = Number(getMeta('wd_cursor') ?? 0)
    const from = cursor > 0 ? cursor + 1 : startBlock
    const to = Math.min(from + MAX_BLOCKS_PER_RUN - 1, upper)
    if (to >= from) {
      note(`Scanning withdrawals, blocks ${from}–${to} (head ${execHead})…`)
      const events = await scanWithdrawals(s.executionUrl, from, to, indexSet, (n) => {
        progress = `Scanning withdrawals… ${n}/${to - from + 1} blocks`
      })
      upsertWithdrawals(events)
      setMeta('wd_cursor', String(to))
      setMeta('wd_head', String(upper))
      setMeta('wd_scan_from', String(cursor > 0 ? getMeta('wd_scan_from') ?? from : from))
      note(`Stored ${events.length} withdrawal(s) from blocks ${from}–${to}.`)
    }

    // 3. Execution-layer block-proposal rewards, scanned NEWEST-FIRST. Each run
    //    scans the new tip (blocks since last run) and then backfills older
    //    history, so current income appears immediately while history fills in.
    //    Two frontiers in slot space: prop_high (top scanned) and prop_low
    //    (bottom scanned); floor = scan-window start, never before the merge.
    const floorSlot = Math.max(MAINNET_MERGE_SLOT, unixToSlot(startUnix))
    let propHigh = getMeta('prop_high') != null ? Number(getMeta('prop_high')) : beaconHead
    let propLow = getMeta('prop_low') != null ? Number(getMeta('prop_low')) : beaconHead + 1

    let budget = MAX_SLOTS_PER_RUN
    const windows: { from: number; to: number; kind: 'tip' | 'back' }[] = []
    if (beaconHead > propHigh) {
      // New blocks produced since the last run (the live tip).
      const tFrom = propHigh + 1
      const tTo = Math.min(beaconHead, tFrom + budget - 1)
      windows.push({ from: tFrom, to: tTo, kind: 'tip' })
      budget -= tTo - tFrom + 1
    }
    if (budget > 0 && propLow > floorSlot) {
      // Backfill older history downward toward the scan-window start.
      const bTo = propLow - 1
      const bFrom = Math.max(floorSlot, bTo - budget + 1)
      windows.push({ from: bFrom, to: bTo, kind: 'back' })
    }

    if (windows.length) {
      const slots: number[] = []
      for (const w of windows) for (let sl = w.from; sl <= w.to; sl++) slots.push(sl)
      note(`Scanning ${slots.length} slots for block proposals (${windows.map((w) => `${w.from}–${w.to}`).join(', ')})…`)
      const rewards: ExecutionReward[] = []
      const failed = new Set<number>()
      let scanned = 0
      let scanError: string | null = null
      await mapLimit(slots, PROP_CONCURRENCY, async (slot) => {
        try {
          const proposer = await proposerForSlot(s.beaconUrl, slot)
          if (++scanned % 500 === 0) progress = `Scanning proposals… ${scanned}/${slots.length} slots`
          if (proposer == null || !indexSet.has(proposer)) return
          const blockNumber = await executionBlockNumber(s.beaconUrl, slot)
          if (blockNumber == null) return
          const r = await proposerBlockReward(s.executionUrl, blockNumber)
          if (!r) return
          rewards.push({
            validatorIndex: proposer,
            blockNumber,
            timestamp: r.timestamp,
            date: isoFromUnix(r.timestamp),
            rewardWei: r.rewardWei,
            feeRecipient: r.feeRecipient,
            method: r.method,
          })
        } catch (e) {
          failed.add(slot)
          if (!scanError) scanError = e instanceof Error ? e.message : String(e)
        }
      })
      upsertExecutions(rewards)
      // Advance each frontier over its contiguous-successful slots, so a failed
      // slot is retried next run rather than silently skipped.
      for (const w of windows) {
        if (w.kind === 'tip') {
          let firstFail = Infinity
          for (const sl of failed) if (sl >= w.from && sl <= w.to && sl < firstFail) firstFail = sl
          const newHigh = firstFail === Infinity ? w.to : firstFail - 1
          if (newHigh >= w.from) propHigh = Math.max(propHigh, newHigh)
        } else {
          let lastFail = -Infinity
          for (const sl of failed) if (sl >= w.from && sl <= w.to && sl > lastFail) lastFail = sl
          const newLow = lastFail === -Infinity ? w.from : lastFail + 1
          if (newLow <= w.to) propLow = Math.min(propLow, newLow)
        }
      }
      setMeta('prop_high', String(propHigh))
      setMeta('prop_low', String(propLow))
      setMeta('prop_floor', String(floorSlot))
      note(
        `Stored ${rewards.length} block-proposal reward(s).` +
          (failed.size ? ` ${failed.size} slot(s) errored (retry next run): ${scanError}` : ''),
      )
    }

    // 4. Prices across the actual data span (best-effort — don't abort).
    note('Fetching ETH price history…')
    try {
      const dates = [...getBalanceTotalsByDate().map((d) => d.date), ...getWithdrawals().map((w) => w.date)].sort()
      if (dates.length) {
        const fromSec = Math.floor(new Date(dates[0] + 'T00:00:00Z').getTime() / 1000) - 86400
        const toSec = Math.floor(Date.now() / 1000)
        upsertPrices(s.currency, await ethPriceMap(s.currency, fromSec, toSec))
      }
    } catch (e) {
      log(`Price fetch failed (non-fatal): ${e instanceof Error ? e.message : e}`)
    }

    setMeta('last_collected_at', String(Date.now()))
    const wdLagging = to < upper
    const propLagging = propLow > floorSlot || propHigh < beaconHead
    note(
      wdLagging || propLagging
        ? `Done (still catching up — withdrawals ${to}/${upper}, EL proposals backfilled to slot ${propLow}/${floorSlot}, tip ${propHigh}/${beaconHead}; continues next run).`
        : 'Collection complete.',
    )
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    throw e
  } finally {
    running = false
  }
}
