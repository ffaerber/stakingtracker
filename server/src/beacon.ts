import { Readable } from 'node:stream'
import { parser } from 'stream-json'
import { pick } from 'stream-json/filters/Pick'
import { streamArray } from 'stream-json/streamers/StreamArray'
import { getDirect, postDirect, HttpError } from './http'
import type { Validator } from './types'

// Standard Beacon Node API client, talking to the user's own (archive) node.
// Requests are un-throttled (their infrastructure). Base URL has no trailing /.

function base(url: string): string {
  return url.replace(/\/+$/, '')
}

interface Envelope<T> {
  data: T
}

interface RawValidator {
  index: string
  balance: string
  status: string
  validator: { pubkey: string; withdrawal_credentials: string; activation_epoch: string }
}

export interface NodeValidator extends Validator {
  balanceGwei: number
  status: string
  activationEpoch: number
  withdrawalAddress: string | null
  /** 0x01 creds auto-skim to 32 ETH; 0x02 compound (no skim until exit). */
  skims: boolean
}

export function withdrawalAddressFromCreds(creds: string): { address: string | null; skims: boolean } {
  const c = creds.toLowerCase().replace(/^0x/, '')
  const prefix = c.slice(0, 2)
  if (prefix === '01' || prefix === '02') return { address: '0x' + c.slice(-40), skims: prefix === '01' }
  return { address: null, skims: false }
}

function idQuery(ids: Array<string | number>): string {
  return ids.map((id) => `id=${encodeURIComponent(String(id))}`).join('&')
}

/** Resolve validators by index or 0x-pubkey against the node's head state. */
export async function resolveValidators(beaconUrl: string, ids: Array<string | number>): Promise<NodeValidator[]> {
  if (!ids.length) return []
  const url = `${base(beaconUrl)}/eth/v1/beacon/states/head/validators?${idQuery(ids)}`
  const env = await getDirect<Envelope<RawValidator[]>>(url)
  return env.data.map((r) => {
    const { address, skims } = withdrawalAddressFromCreds(r.validator.withdrawal_credentials)
    return {
      index: Number(r.index),
      publickey: r.validator.pubkey,
      balanceGwei: Number(r.balance),
      status: r.status,
      activationEpoch: Number(r.validator.activation_epoch),
      withdrawalAddress: address,
      skims,
    }
  })
}

/**
 * Find all validators whose withdrawal credentials point at `address`, by
 * streaming the full head validator set from the node and filtering on the fly
 * (the set is large, so we never hold it all in memory). This is the
 * self-hosted equivalent of an indexer's address→validators lookup.
 */
export async function resolveByWithdrawalAddress(
  beaconUrl: string,
  address: string,
): Promise<NodeValidator[]> {
  const target = address.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(target)) throw new Error('Invalid withdrawal address.')

  const res = await fetch(`${base(beaconUrl)}/eth/v1/beacon/states/head/validators`)
  if (!res.ok || !res.body) throw new HttpError(res.status, `validators stream failed: ${res.status}`)

  const pipeline = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    .pipe(parser())
    .pipe(pick({ filter: 'data' }))
    .pipe(streamArray())

  const out: NodeValidator[] = []
  for await (const { value } of pipeline as AsyncIterable<{ value: RawValidator }>) {
    const creds = value.validator.withdrawal_credentials.toLowerCase().replace(/^0x/, '')
    const prefix = creds.slice(0, 2)
    if ((prefix === '01' || prefix === '02') && creds.endsWith(target)) {
      const { address: addr, skims } = withdrawalAddressFromCreds(value.validator.withdrawal_credentials)
      out.push({
        index: Number(value.index),
        publickey: value.validator.pubkey,
        balanceGwei: Number(value.balance),
        status: value.status,
        activationEpoch: Number(value.validator.activation_epoch),
        withdrawalAddress: addr,
        skims,
      })
    }
  }
  return out.sort((a, b) => a.index - b.index)
}

export async function headSlot(beaconUrl: string): Promise<number> {
  const env = await getDirect<Envelope<{ header: { message: { slot: string } } }>>(
    `${base(beaconUrl)}/eth/v1/beacon/headers/head`,
  )
  return Number(env.data.header.message.slot)
}

/** Validator balances (gwei) at one slot, or null if the node has no such state. */
export async function balancesAtSlot(
  beaconUrl: string,
  slot: number,
  indices: number[],
): Promise<Map<number, number> | null> {
  const url = `${base(beaconUrl)}/eth/v1/beacon/states/${slot}/validator_balances?${idQuery(indices)}`
  try {
    const env = await getDirect<Envelope<{ index: string; balance: string }[]>>(url)
    return new Map(env.data.map((r) => [Number(r.index), Number(r.balance)]))
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 400)) return null
    throw e
  }
}

/**
 * Proposer (validator index) for a slot, or null if the slot was missed/skipped
 * (no block). Headers are tiny, so scanning a slot range is cheap — we only
 * fetch the full block for slots our validators actually proposed.
 */
export async function proposerForSlot(beaconUrl: string, slot: number): Promise<number | null> {
  const url = `${base(beaconUrl)}/eth/v1/beacon/headers/${slot}`
  try {
    const env = await getDirect<Envelope<{ header: { message: { proposer_index: string } } }>>(url)
    return Number(env.data.header.message.proposer_index)
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 400)) return null
    throw e
  }
}

/** Execution block number for a slot's payload, or null pre-merge / no payload. */
export async function executionBlockNumber(beaconUrl: string, slot: number): Promise<number | null> {
  const url = `${base(beaconUrl)}/eth/v2/beacon/blocks/${slot}`
  try {
    const env = await getDirect<
      Envelope<{ message: { body: { execution_payload?: { block_number: string } } } }>
    >(url)
    const bn = env.data.message.body.execution_payload?.block_number
    return bn != null ? Number(bn) : null
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 400)) return null
    throw e
  }
}

/**
 * Per-validator liveness (did they attest) for an epoch — the "online" signal.
 * Use a completed epoch (e.g. head − 1); the current epoch is only partial.
 * Returns null if the node has no data for that epoch.
 */
export async function validatorLiveness(
  beaconUrl: string,
  epoch: number,
  indices: number[],
): Promise<Map<number, boolean> | null> {
  if (!indices.length) return new Map()
  const url = `${base(beaconUrl)}/eth/v1/validator/liveness/${epoch}`
  try {
    const env = await postDirect<Envelope<{ index: string; is_live: boolean }[]>>(url, indices.map(String))
    return new Map(env.data.map((r) => [Number(r.index), r.is_live]))
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 400)) return null
    throw e
  }
}

interface RawAttReward {
  validator_index: string
  head: string
  target: string
  source: string
  inclusion_delay?: string | null
  inactivity: string
}

/**
 * Exact attestation rewards (gwei, can be negative) per validator for an epoch.
 * Returns null if the node has no state for that epoch (pre-reconstruction).
 */
export async function attestationRewards(
  beaconUrl: string,
  epoch: number,
  indices: number[],
): Promise<Map<number, number> | null> {
  const url = `${base(beaconUrl)}/eth/v1/beacon/rewards/attestations/${epoch}`
  try {
    const env = await postDirect<Envelope<{ total_rewards: RawAttReward[] }>>(url, indices.map(String))
    const map = new Map<number, number>()
    for (const r of env.data.total_rewards) {
      const sum =
        Number(r.head) + Number(r.target) + Number(r.source) + Number(r.inactivity) + Number(r.inclusion_delay ?? 0)
      map.set(Number(r.validator_index), sum)
    }
    return map
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 400)) return null
    throw e
  }
}
