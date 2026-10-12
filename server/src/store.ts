import { db } from './db'
import type { Validator, BalanceDay, WithdrawalEvent, ExecutionReward } from './types'

// Persisted reward data. Collected rows are UPSERTed, so repeated collection
// runs accumulate full history even though beaconcha.in only serves a window.

function unixOfDate(date: string): number {
  return Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000)
}

export function upsertValidators(vals: Validator[]): void {
  const stmt = db.prepare('INSERT OR REPLACE INTO validators (idx, pubkey) VALUES (?, ?)')
  const tx = db.transaction((rows: Validator[]) => rows.forEach((v) => stmt.run(v.index, v.publickey)))
  tx(vals)
}

export function getValidators(): Validator[] {
  return (db.prepare('SELECT idx, pubkey FROM validators ORDER BY idx').all() as { idx: number; pubkey: string }[]).map(
    (r) => ({ index: r.idx, publickey: r.pubkey }),
  )
}

export function upsertBalances(rows: { validatorIdx: number; date: string; balanceGwei: number }[]): void {
  const stmt = db.prepare('INSERT OR REPLACE INTO balances (validator_idx, date, balance_gwei) VALUES (?, ?, ?)')
  const tx = db.transaction((rs: typeof rows) => rs.forEach((r) => stmt.run(r.validatorIdx, r.date, r.balanceGwei)))
  tx(rows)
}

/** Per date, how many of the given validators already have a stored balance. */
export function getStoredBalanceCounts(validatorIdxs: number[]): Map<string, number> {
  if (!validatorIdxs.length) return new Map()
  const rows = db
    .prepare(
      `SELECT date, COUNT(*) AS n FROM balances WHERE validator_idx IN (${validatorIdxs.map(() => '?').join(',')}) GROUP BY date`,
    )
    .all(...validatorIdxs) as { date: string; n: number }[]
  return new Map(rows.map((r) => [r.date, r.n]))
}

export function getBalances(validatorIdx: number): BalanceDay[] {
  const rows = db
    .prepare('SELECT date, balance_gwei FROM balances WHERE validator_idx = ? ORDER BY date')
    .all(validatorIdx) as { date: string; balance_gwei: number }[]
  return rows.map((r) => {
    const ts = unixOfDate(r.date)
    return { epoch: ts, timestamp: ts, date: r.date, balanceGwei: r.balance_gwei }
  })
}

export function addIncome(rows: { validatorIdx: number; date: string; incomeGwei: number }[]): void {
  // Accumulate (epochs within a day are summed across collection runs).
  const stmt = db.prepare(`
    INSERT INTO income (validator_idx, date, income_gwei) VALUES (?, ?, ?)
    ON CONFLICT(validator_idx, date) DO UPDATE SET income_gwei = income_gwei + excluded.income_gwei
  `)
  const tx = db.transaction((rs: typeof rows) => rs.forEach((r) => stmt.run(r.validatorIdx, r.date, r.incomeGwei)))
  tx(rows)
}

/** Daily consensus income (gwei) summed across all validators, date-sorted. */
export function getIncomeByDate(): { date: string; gwei: number }[] {
  return db
    .prepare('SELECT date, SUM(income_gwei) AS gwei FROM income GROUP BY date ORDER BY date')
    .all() as { date: string; gwei: number }[]
}

/** Daily total balance (gwei) across validators, for deriving withdrawals. */
export function getBalanceTotalsByDate(): { date: string; gwei: number }[] {
  return db
    .prepare('SELECT date, SUM(balance_gwei) AS gwei FROM balances GROUP BY date ORDER BY date')
    .all() as { date: string; gwei: number }[]
}

export function doneEpochs(): Set<number> {
  const rows = db.prepare('SELECT epoch FROM epochs_done').all() as { epoch: number }[]
  return new Set(rows.map((r) => r.epoch))
}

export function markEpochDone(epoch: number): void {
  db.prepare('INSERT OR IGNORE INTO epochs_done (epoch) VALUES (?)').run(epoch)
}

export function doneEpochCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM epochs_done').get() as { n: number }).n
}

export function upsertWithdrawals(events: WithdrawalEvent[]): void {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO withdrawals (validator_idx, slot, date, amount_gwei, address) VALUES (?, ?, ?, ?, ?)',
  )
  const tx = db.transaction((es: WithdrawalEvent[]) =>
    es.forEach((e) => stmt.run(e.validatorIndex, e.slot, e.date, e.amountGwei, e.address)),
  )
  tx(events)
}

export function getWithdrawals(): WithdrawalEvent[] {
  const rows = db.prepare('SELECT validator_idx, slot, date, amount_gwei, address FROM withdrawals ORDER BY slot').all() as {
    validator_idx: number
    slot: number
    date: string
    amount_gwei: number
    address: string
  }[]
  return rows.map((r) => ({
    validatorIndex: r.validator_idx,
    epoch: Math.floor(r.slot / 32),
    slot: r.slot,
    timestamp: unixOfDate(r.date),
    date: r.date,
    amountGwei: r.amount_gwei,
    address: r.address,
  }))
}

export function upsertExecutions(events: ExecutionReward[]): void {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO executions (validator_idx, block_number, date, reward_wei, fee_recipient, method) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const tx = db.transaction((es: ExecutionReward[]) =>
    es.forEach((e) =>
      stmt.run(e.validatorIndex, e.blockNumber, e.date, e.rewardWei.toString(), e.feeRecipient, e.method ?? null),
    ),
  )
  tx(events)
}

export function getExecutions(): ExecutionReward[] {
  const rows = db
    .prepare(
      'SELECT validator_idx, block_number, date, reward_wei, fee_recipient, method FROM executions ORDER BY block_number',
    )
    .all() as {
    validator_idx: number
    block_number: number
    date: string
    reward_wei: string
    fee_recipient: string
    method: string | null
  }[]
  return rows.map((r) => ({
    validatorIndex: r.validator_idx,
    blockNumber: r.block_number,
    timestamp: unixOfDate(r.date),
    date: r.date,
    rewardWei: BigInt(r.reward_wei),
    feeRecipient: r.fee_recipient,
    method: r.method === 'priority-fees' || r.method === 'balance-delta' ? r.method : undefined,
  }))
}

export function upsertPrices(currency: string, map: Record<string, number>): void {
  const stmt = db.prepare('INSERT OR REPLACE INTO prices (date, currency, price) VALUES (?, ?, ?)')
  const tx = db.transaction((entries: [string, number][]) =>
    entries.forEach(([date, price]) => stmt.run(date, currency, price)),
  )
  tx(Object.entries(map))
}

export function getPriceMap(currency: string): Record<string, number> {
  const rows = db.prepare('SELECT date, price FROM prices WHERE currency = ?').all(currency) as {
    date: string
    price: number
  }[]
  const map: Record<string, number> = {}
  for (const r of rows) map[r.date] = r.price
  return map
}

/** Earliest stored balance date per validator (for gap reporting). */
export function earliestBalanceDate(validatorIdx: number): string | null {
  const row = db.prepare('SELECT MIN(date) AS d FROM balances WHERE validator_idx = ?').get(validatorIdx) as {
    d: string | null
  }
  return row?.d ?? null
}
