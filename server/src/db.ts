import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// SQLite persistence. The key value of the backend: it PERSISTS daily balances
// (and withdrawals / EL rewards) as it collects them, so full history survives
// even though beaconcha.in only serves a short recent window.

const DB_PATH = process.env.STT_DB_PATH ?? './data/stakingtracker.db'
mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    stored_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS validators (
    idx INTEGER PRIMARY KEY,
    pubkey TEXT
  );
  CREATE TABLE IF NOT EXISTS balances (
    validator_idx INTEGER NOT NULL,
    date TEXT NOT NULL,
    balance_gwei INTEGER NOT NULL,
    PRIMARY KEY (validator_idx, date)
  );
  CREATE TABLE IF NOT EXISTS income (
    validator_idx INTEGER NOT NULL,
    date TEXT NOT NULL,
    income_gwei INTEGER NOT NULL,
    PRIMARY KEY (validator_idx, date)
  );
  CREATE TABLE IF NOT EXISTS withdrawals (
    validator_idx INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    date TEXT NOT NULL,
    amount_gwei INTEGER NOT NULL,
    address TEXT,
    PRIMARY KEY (validator_idx, slot)
  );
  CREATE TABLE IF NOT EXISTS executions (
    validator_idx INTEGER NOT NULL,
    block_number INTEGER NOT NULL,
    date TEXT NOT NULL,
    reward_wei TEXT NOT NULL,
    fee_recipient TEXT,
    method TEXT,
    PRIMARY KEY (validator_idx, block_number)
  );
  CREATE TABLE IF NOT EXISTS epochs_done (
    epoch INTEGER PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS prices (
    date TEXT NOT NULL,
    currency TEXT NOT NULL,
    price REAL NOT NULL,
    PRIMARY KEY (date, currency)
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

// Migrations for DBs created before a column existed (CREATE TABLE IF NOT EXISTS
// won't add columns). ADD COLUMN throws if it's already there, so guard on the
// current schema.
function addColumnIfMissing(table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`)
}
addColumnIfMissing('executions', 'method', 'method TEXT')

// --- generic KV cache (used by the throttled API clients) ---

export async function cacheGet<T>(key: string, maxAgeMs?: number): Promise<T | undefined> {
  const row = db.prepare('SELECT value, stored_at FROM kv WHERE key = ?').get(key) as
    | { value: string; stored_at: number }
    | undefined
  if (!row) return undefined
  if (maxAgeMs != null && Date.now() - row.stored_at > maxAgeMs) {
    db.prepare('DELETE FROM kv WHERE key = ?').run(key)
    return undefined
  }
  return JSON.parse(row.value) as T
}

export async function cacheSet<T>(key: string, value: T): Promise<void> {
  db.prepare('INSERT OR REPLACE INTO kv (key, value, stored_at) VALUES (?, ?, ?)').run(
    key,
    JSON.stringify(value),
    Date.now(),
  )
}

// --- meta helpers ---

export function getMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setMeta(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
}
