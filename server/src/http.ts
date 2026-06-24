// Throttled JSON fetch for shared rate-limited APIs (beaconcha.in free tier
// ~1 req/s, CoinGecko keyless). Serial queue with ~1.1s spacing + retry/backoff.
// Runs server-side, so the key stays on the server.

interface QueueItem {
  run: () => Promise<unknown>
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

const queue: QueueItem[] = []
let lastStart = 0
let draining = false

const MIN_SPACING_MS = 1100
const MAX_RETRIES = 4

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function drain() {
  if (draining) return
  draining = true
  while (queue.length) {
    const item = queue.shift()!
    const wait = Math.max(0, lastStart + MIN_SPACING_MS - Date.now())
    if (wait > 0) await sleep(wait)
    lastStart = Date.now()
    try {
      item.resolve(await item.run())
    } catch (e) {
      item.reject(e)
    }
  }
  draining = false
}

function enqueue<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({ run, resolve: resolve as (v: unknown) => void, reject })
    void drain()
  })
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

async function doGet<T>(url: string, headers?: Record<string, string>): Promise<T> {
  let attempt = 0
  while (true) {
    const res = await fetch(url, { headers })
    if (res.ok) return (await res.json()) as T
    const retryable = res.status === 429 || res.status >= 500
    if (retryable && attempt < MAX_RETRIES) {
      attempt++
      await sleep(MIN_SPACING_MS * 2 ** attempt)
      continue
    }
    const body = await res.text().catch(() => '')
    throw new HttpError(res.status, `GET ${url} -> ${res.status} ${body.slice(0, 200)}`)
  }
}

/** Queued JSON GET. Always throttled (shared external APIs like CoinGecko). */
export function getJson<T>(url: string, opts: { headers?: Record<string, string> } = {}): Promise<T> {
  return enqueue(() => doGet<T>(url, opts.headers))
}

async function doRequest<T>(url: string, init: RequestInit): Promise<T> {
  let attempt = 0
  while (true) {
    const res = await fetch(url, init)
    if (res.ok) return (await res.json()) as T
    const retryable = res.status === 429 || res.status >= 500
    if (retryable && attempt < MAX_RETRIES) {
      attempt++
      await sleep(250 * 2 ** attempt)
      continue
    }
    const body = await res.text().catch(() => '')
    const method = (init.method as string) ?? 'GET'
    throw new HttpError(res.status, `${method} ${url} -> ${res.status} ${body.slice(0, 200)}`)
  }
}

/** Un-throttled JSON GET for your own node (no shared rate limit). */
export function getDirect<T>(url: string): Promise<T> {
  return doRequest<T>(url, {})
}

/** Un-throttled JSON POST for your own node (beacon rewards bulk endpoints). */
export function postDirect<T>(url: string, body: unknown): Promise<T> {
  return doRequest<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 0 }, worker))
  return results
}
