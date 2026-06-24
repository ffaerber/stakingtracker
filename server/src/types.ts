// Shared domain types.

/** A validator discovered for a withdrawal address. */
export interface Validator {
  index: number
  publickey: string
}

/** One daily balance snapshot for a validator (gwei). */
export interface BalanceDay {
  epoch: number
  /** Unix seconds at the end of that day's epoch range. */
  timestamp: number
  /** ISO date (YYYY-MM-DD, UTC). */
  date: string
  /** Total balance in gwei. */
  balanceGwei: number
}

/** A withdrawal event credited to the withdrawal address (gwei). */
export interface WithdrawalEvent {
  validatorIndex: number
  epoch: number
  slot: number
  timestamp: number
  date: string
  amountGwei: number
  address: string
}

/** An execution-layer block proposal reward (wei). */
export interface ExecutionReward {
  validatorIndex: number
  blockNumber: number
  timestamp: number
  date: string
  /** Priority fees + MEV credited to the fee recipient, in wei. */
  rewardWei: bigint
  feeRecipient: string
  /** How rewardWei was valued; 'priority-fees' undercounts MEV-boost blocks. */
  method?: 'balance-delta' | 'priority-fees'
}

/** A single income line item in a tax report, priced in fiat. */
export interface IncomeRow {
  date: string
  kind: 'accrual' | 'withdrawal' | 'execution'
  amountEth: number
  /** ETH/EUR price used for this date; null if unavailable. */
  priceEur: number | null
  /** amountEth * priceEur, or null if price missing. */
  valueEur: number | null
  note?: string
}

/** Warning surfaced when source data is incomplete for a period. */
export interface DataGap {
  message: string
  from?: string
  to?: string
}
