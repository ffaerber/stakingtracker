import { mapLimit } from './http'
import { isoFromUnix } from './time'
import type { WithdrawalEvent } from './types'

export interface BlockReward {
  rewardWei: bigint
  feeRecipient: string
  timestamp: number
  /** How the reward was valued; 'priority-fees' undercounts MEV-boost blocks. */
  method: 'balance-delta' | 'priority-fees'
}

// Execution-node (Geth) client. Withdrawals (EIP-4895) live in block bodies,
// which a snap-synced node retains — so we can scan them without an archive
// node or any external indexer. This is how we get a 0x01 validator's income.

interface RpcResult<T> {
  id: number
  result?: T
  error?: { message: string }
}

/** Batched JSON-RPC POST returning the raw per-call results (errors included). */
async function rpcBatchResults<T>(
  execUrl: string,
  calls: { method: string; params: unknown[] }[],
): Promise<RpcResult<T>[]> {
  const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }))
  const res = await fetch(execUrl.replace(/\/+$/, ''), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`execution RPC ${res.status}`)
  const arr = (await res.json()) as RpcResult<T>[]
  return arr.sort((a, b) => a.id - b.id)
}

/** Batched JSON-RPC POST to the user's own node (un-throttled). */
async function rpcBatch<T>(execUrl: string, calls: { method: string; params: unknown[] }[]): Promise<T[]> {
  return (await rpcBatchResults<T>(execUrl, calls)).map((r) => r.result as T)
}

export async function getHeadBlock(execUrl: string): Promise<number> {
  const [hex] = await rpcBatch<string>(execUrl, [{ method: 'eth_blockNumber', params: [] }])
  return Number(BigInt(hex))
}

/** Current ETH balance (wei) of an address. */
export async function getBalanceWei(execUrl: string, address: string): Promise<bigint> {
  const [hex] = await rpcBatch<string>(execUrl, [{ method: 'eth_getBalance', params: [address, 'latest'] }])
  return BigInt(hex)
}

interface RawBlock {
  timestamp: string
  withdrawals?: { index: string; validatorIndex: string; address: string; amount: string }[]
}

/**
 * Scan [fromBlock, toBlock] for withdrawals credited to any of `indices`.
 * `amount` in EIP-4895 withdrawals is already in gwei. Returns matched events.
 */
export async function scanWithdrawals(
  execUrl: string,
  fromBlock: number,
  toBlock: number,
  indices: Set<number>,
  onProgress?: (scanned: number) => void,
): Promise<WithdrawalEvent[]> {
  const BATCH = 100
  const starts: number[] = []
  for (let b = fromBlock; b <= toBlock; b += BATCH) starts.push(b)

  const events: WithdrawalEvent[] = []
  let scanned = 0
  await mapLimit(starts, 8, async (start) => {
    const end = Math.min(start + BATCH - 1, toBlock)
    const calls = []
    for (let n = start; n <= end; n++) calls.push({ method: 'eth_getBlockByNumber', params: ['0x' + n.toString(16), false] })
    const blocks = await rpcBatch<RawBlock>(execUrl, calls)
    for (const blk of blocks) {
      if (!blk?.withdrawals?.length) continue
      const ts = Number(BigInt(blk.timestamp))
      const date = isoFromUnix(ts)
      for (const w of blk.withdrawals) {
        const vi = Number(BigInt(w.validatorIndex))
        if (indices.has(vi)) {
          events.push({
            validatorIndex: vi,
            epoch: 0,
            slot: Number(BigInt(w.index)), // global withdrawal index — unique key
            timestamp: ts,
            date,
            amountGwei: Number(BigInt(w.amount)),
            address: w.address,
          })
        }
      }
    }
    scanned += end - start + 1
    onProgress?.(scanned)
  })
  return events
}

/** Unix timestamp of a block (used to map a scan-start block into slot space). */
export async function blockTimestamp(execUrl: string, blockNumber: number): Promise<number> {
  const hex = '0x' + blockNumber.toString(16)
  const [blk] = await rpcBatch<{ timestamp: string }>(execUrl, [
    { method: 'eth_getBlockByNumber', params: [hex, false] },
  ])
  if (!blk) throw new Error(`block ${blockNumber} not found`)
  return Number(BigInt(blk.timestamp))
}

/**
 * Proposer reward from the fee recipient's balance change. Adds back what the
 * fee recipient itself spent in the block (gas + value sent), which isn't a
 * reduction in reward, and subtracts `credited` — incoming balance that isn't
 * EL reward, namely EIP-4895 withdrawals paid to the fee recipient in this same
 * block (those are already counted as consensus income, so leaving them in
 * would double-count). The MEV-boost payment tx is a transaction, not a
 * system credit, so it stays in the delta and is kept. Clamped at 0.
 */
export function balanceDeltaReward(post: bigint, pre: bigint, ownSpend: bigint, credited = 0n): bigint {
  const reward = post - pre + ownSpend - credited
  return reward < 0n ? 0n : reward
}

interface RawFullBlock {
  timestamp: string
  miner: string
  baseFeePerGas?: string
  transactions: { hash: string; from: string; value: string }[]
  /** EIP-4895 withdrawals; `amount` is in gwei. */
  withdrawals?: { address: string; amount: string }[]
}
interface RawReceipt {
  transactionHash: string
  gasUsed: string
  effectiveGasPrice: string
}

/**
 * Value the execution-layer reward of one proposed block.
 *
 * Primary method (needs archive state): the fee recipient's balance change
 * across the block, which captures both priority fees and the MEV-boost payment
 * tx. Transactions the fee recipient itself sent are added back (the gas + value
 * they spent isn't a reduction in reward). Incoming transfers aren't subtracted,
 * so the rare case of an unrelated transfer to the fee recipient in its own
 * proposal block can overcount — acceptable for a dedicated payout address.
 *
 * Fallback (non-archive node): priority fees from receipts only. Exact for
 * vanilla blocks, undercounts MEV-boost blocks.
 */
export async function proposerBlockReward(execUrl: string, blockNumber: number): Promise<BlockReward | null> {
  const hex = '0x' + blockNumber.toString(16)
  const [block] = await rpcBatch<RawFullBlock>(execUrl, [{ method: 'eth_getBlockByNumber', params: [hex, true] }])
  if (!block) return null
  const feeRecipient = block.miner.toLowerCase()
  const timestamp = Number(BigInt(block.timestamp))
  const baseFee = block.baseFeePerGas ? BigInt(block.baseFeePerGas) : 0n

  // Receipts give per-tx gas cost (for the fee-recipient add-back) and the
  // priority-fee fallback. A node without eth_getBlockReceipts yields [] here.
  const [receipts] = await rpcBatch<RawReceipt[]>(execUrl, [{ method: 'eth_getBlockReceipts', params: [hex] }])
  const gasCostByHash = new Map<string, bigint>()
  let priorityFees = 0n
  for (const r of receipts ?? []) {
    const gas = BigInt(r.gasUsed)
    const eff = BigInt(r.effectiveGasPrice)
    gasCostByHash.set(r.transactionHash.toLowerCase(), gas * eff)
    priorityFees += gas * (eff - baseFee)
  }

  // Balance delta — requires historical state (archive node).
  const prevHex = '0x' + (blockNumber - 1).toString(16)
  const [post, pre] = await rpcBatchResults<string>(execUrl, [
    { method: 'eth_getBalance', params: [feeRecipient, hex] },
    { method: 'eth_getBalance', params: [feeRecipient, prevHex] },
  ])
  if (post.error || pre.error || post.result == null || pre.result == null) {
    return { rewardWei: priorityFees, feeRecipient, timestamp, method: 'priority-fees' }
  }

  let ownSpend = 0n
  for (const tx of block.transactions) {
    if (tx.from.toLowerCase() === feeRecipient) {
      ownSpend += (gasCostByHash.get(tx.hash.toLowerCase()) ?? 0n) + BigInt(tx.value)
    }
  }
  // Withdrawals (skims) credited to the fee recipient here are consensus income
  // counted elsewhere, not EL reward — net them out to avoid double-counting.
  const GWEI = 1_000_000_000n
  let credited = 0n
  for (const w of block.withdrawals ?? []) {
    if (w.address.toLowerCase() === feeRecipient) credited += BigInt(w.amount) * GWEI
  }
  const reward = balanceDeltaReward(BigInt(post.result), BigInt(pre.result), ownSpend, credited)
  return { rewardWei: reward, feeRecipient, timestamp, method: 'balance-delta' }
}
