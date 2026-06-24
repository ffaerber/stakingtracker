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
const CONCURRENCY = 12

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

    // 1. Daily balances (one slot per UTC day; historical needs reconstruction,
    //    recent/today always works and is what accrual needs going forward).
    const beaconHead = await headSlot(s.beaconUrl)
    const startEpoch = Math.min(...vals.map((v) => v.activationEpoch))
    const days = dateRange(isoFromUnix(epochToUnix(startEpoch)), isoFromUnix(Math.floor(Date.now() / 1000)))
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
    const execHead = await getHeadBlock(s.executionUrl)
    const envStart = Number(process.env.STT_SCAN_FROM_BLOCK ?? 0)
    // Optional upper bound, e.g. to scan a single tax year. Defaults to head.
    const envTo = Number(process.env.STT_SCAN_TO_BLOCK ?? 0)
    const upper = envTo > 0 ? Math.min(envTo, execHead) : execHead
    const cursor = Number(getMeta('wd_cursor') ?? 0)
    const from = cursor > 0 ? cursor + 1 : envStart > 0 ? envStart : Math.max(0, execHead - DEFAULT_LOOKBACK_BLOCKS)
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

    // 3. Execution-layer block-proposal rewards. Per slot we read the proposer
    //    from a cheap beacon header; only our validators' slots get the full
    //    block + reward valuation. Resumable via a slot cursor.
    const propCursor = Number(getMeta('prop_cursor') ?? 0)
    let propFrom: number
    if (propCursor > 0) {
      propFrom = propCursor + 1
    } else {
      // Start from the same point as the withdrawal scan, mapped into slot space,
      // but never before the merge (no EL rewards exist earlier; a pre-merge
      // start would otherwise crawl millions of empty/negative slots).
      const startBlock = envStart > 0 ? envStart : Math.max(0, execHead - DEFAULT_LOOKBACK_BLOCKS)
      propFrom = Math.max(MAINNET_MERGE_SLOT, unixToSlot(await blockTimestamp(s.executionUrl, startBlock)))
    }
    const propTo = Math.min(propFrom + MAX_SLOTS_PER_RUN - 1, beaconHead)
    if (propTo >= propFrom) {
      note(`Scanning block proposals, slots ${propFrom}–${propTo} (head ${beaconHead})…`)
      const slots: number[] = []
      for (let sl = propFrom; sl <= propTo; sl++) slots.push(sl)
      const rewards: ExecutionReward[] = []
      let scanned = 0
      // A failing slot (e.g. a transient node error that outlasts retries) must
      // not abort the whole collection. Record failures and only advance the
      // cursor up to the last contiguously-successful slot, so failed slots are
      // retried next run instead of being silently skipped.
      let scanError: string | null = null
      let firstFailed = Infinity
      let failedCount = 0
      await mapLimit(slots, CONCURRENCY, async (slot) => {
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
          failedCount++
          if (slot < firstFailed) firstFailed = slot
          if (!scanError) scanError = e instanceof Error ? e.message : String(e)
        }
      })
      upsertExecutions(rewards)
      // Commit through the slot before the first failure (everything earlier is
      // complete); a clean run commits the whole window.
      const committedTo = Math.min(propTo, firstFailed - 1)
      if (committedTo >= propFrom) {
        setMeta('prop_cursor', String(committedTo))
        setMeta('prop_scan_from', String(propCursor > 0 ? getMeta('prop_scan_from') ?? propFrom : propFrom))
      }
      setMeta('prop_head', String(beaconHead))
      note(
        `Stored ${rewards.length} block-proposal reward(s) from slots ${propFrom}–${committedTo >= propFrom ? committedTo : propFrom - 1}.` +
          (failedCount ? ` ${failedCount} slot(s) errored (retrying next run): ${scanError}` : ''),
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
    const propLagging = Number(getMeta('prop_cursor') ?? 0) < beaconHead
    note(
      wdLagging || propLagging
        ? `Done (scans still catching up — withdrawals ${to}/${upper}, proposals ${getMeta('prop_cursor') ?? 0}/${beaconHead}; continues next run).`
        : 'Collection complete.',
    )
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    throw e
  } finally {
    running = false
  }
}
